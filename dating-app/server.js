const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { initializeApp: firebaseInitializeApp, cert } = require('firebase-admin/app');
const { getAuth: getFirebaseAuth } = require('firebase-admin/auth');
const { getDB, seedDemoUsers, backfillDemoAvatars, userOps, connectionOps, messageOps, otpOps } = require('./database');
const multer = require('multer');
const fs = require('fs');

// Load environment variables
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ensure uploads folder exists
fs.mkdirSync('public/uploads/voice', { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/voice/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'voice-' + uniqueSuffix + '.webm');
  }
});
const upload = multer({ storage: storage });

const PORT = process.env.PORT || 3000;

// Allowed email domains
const ALLOWED_SUFFIXES = ['rishihood.edu.in', 'vitbhopal.ac.in', 'nst.rishihood.edu.in'];

// ===== Firebase Admin SDK Initialization =====
let firebaseInitialized = false;
let firebaseAuth = null;
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  try {
    const firebaseApp = firebaseInitializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/^"|"$/g, '').replace(/\\n/g, '\n')
      })
    });
    firebaseAuth = getFirebaseAuth(firebaseApp);
    firebaseInitialized = true;
    console.log('Firebase Admin SDK initialized');
  } catch (err) {
    console.error('Firebase init error:', err.message);
  }
} else {
  console.log('Firebase not configured — OTP endpoint will use local verification only');
}

// Nodemailer and manual OTP generation replaced by Firebase Email Link Authentication
// Hard-fail if SESSION_SECRET is not set — a dating app must never run with a guessable session secret
if (!process.env.SESSION_SECRET) {
  throw new Error('FATAL: SESSION_SECRET environment variable is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
}

// Trust proxy for when running behind nginx/render/heroku
app.set('trust proxy', 1);

// Security headers via Helmet
// CSP is disabled to allow our CDN-loaded libraries (Tailwind, Three.js, Socket.io, Google Fonts)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// ===== Rate Limiting =====
// Auth endpoints: 5 attempts per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// OTP endpoints: 3 per 15 minutes (stricter to prevent email bombing)
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: 'Too many OTP requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limit: 60 requests per minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Persistent SQLite session store — survives server restarts, no memory leaks
const sessionsDb = new Database(path.join(__dirname, 'data', 'sessions.db'));

// Session middleware
const sessionMiddleware = session({
  store: new SqliteStore({
    client: sessionsDb,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 } // auto-clear expired sessions every 15 min
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false, // Don't create sessions for unauthenticated visitors
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true, // Prevent JS access to cookie
    sameSite: 'lax', // CSRF protection
    secure: process.env.NODE_ENV === 'production' // HTTPS only in production
  }
});

app.use(sessionMiddleware);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply general API rate limiter to all /api/ routes
app.use('/api/', apiLimiter);

// CSRF Origin/Referer check — defense-in-depth on top of sameSite: 'lax'
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.get('origin') || req.get('referer') || '';
    // Allow requests with no origin (same-origin form submissions, server-to-server)
    if (origin) {
      try {
        const originHostname = new URL(origin).hostname;
        if (originHostname !== req.hostname) {
          return res.status(403).json({ error: 'Cross-origin request blocked' });
        }
      } catch (e) {
        return res.status(403).json({ error: 'Invalid origin header' });
      }
    }
  }
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Share session with Socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Socket.io connections for chat
io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) return;

  console.log(`User ${userId} connected via socket`);

  // Join user to their personal room
  socket.join(`user:${userId}`);

  socket.on('join-chat', async (connectionId) => {
    if (!connectionId) return;
    const conn = await connectionOps.getConnection(connectionId, userId);
    if (!conn) return;
    socket.join(`chat:${connectionId}`);
  });

  socket.on('leave-chat', (connectionId) => {
    socket.leave(`chat:${connectionId}`);
  });

  socket.on('send-message', async (data) => {
    const { connectionId, content } = data;
    if (!connectionId || !content?.trim()) return;

    // Verify user is part of this connection
    const conn = await connectionOps.getConnection(connectionId, userId);
    if (!conn) return;

    const msg = await messageOps.send(connectionId, userId, content.trim());
    // Emit to both users in the chat
    io.to(`chat:${connectionId}`).emit('new-message', {
      ...msg,
      sender_id: userId
    });
  });

  socket.on('typing', (data) => {
    const { connectionId, isTyping } = data;
    if (!connectionId) return;
    socket.to(`chat:${connectionId}`).emit('typing', { userId, isTyping });
  });

  socket.on('disconnect', () => {
    console.log(`User ${userId} disconnected`);
  });
});

// ===== API ROUTES =====

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passcode_hash, ...safeUser } = user;
  if (typeof safeUser.hobbies === 'string') {
    try { safeUser.hobbies = JSON.parse(safeUser.hobbies); } 
    catch(e) { safeUser.hobbies = []; }
  }
  return safeUser;
}

// Check if user is logged in
app.get('/api/session', async (req, res) => {
  if (req.session.userId) {
    const user = await userOps.getById(req.session.userId);
    if (user) {
      const safeUser = sanitizeUser(user);
      return res.json({ authenticated: true, user: safeUser });
    }
  }
  res.json({ authenticated: false });
});

// Helper to send transactional emails via Brevo HTTP API
async function sendBrevoEmail(email, subject, htmlContent) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured on the server. Please set it in your Render settings.');
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: 'Delulu Dating',
        email: 'delulu.college.dating@gmail.com'
      },
      to: [{ email }],
      subject: subject,
      htmlContent: htmlContent
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Brevo send failed: ${response.status} - ${errText}`);
  }
}

// Generate secure verification token and send email via Brevo
app.post('/api/auth/send-verification-email', otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const domain = cleanEmail.split('@')[1];
  const allowedDomains = [
    'rishihood.edu.in', 
    'vitbhopal.ac.in', 
    'nst.rishihood.edu.in', 
    'psy.rishihood.edu.in',
    'csds.rishihood.edu.in',
    'makers.rishihood.edu.in'
  ];
  
  if (!domain || !allowedDomains.includes(domain)) {
    return res.status(400).json({ error: 'Only authorized university emails are allowed' });
  }

  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins
    
    await otpOps.create(cleanEmail, token, expiresAt);

    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host;
    const verifyLink = `${protocol}://${host}/login.html?token=${token}&email=${encodeURIComponent(cleanEmail)}`;

    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; text-align: center; border: 1px solid #dec0ba; border-radius: 16px;">
        <h2 style="color: #a53b29; font-size: 24px; margin-bottom: 8px;">Verify your college email</h2>
        <p style="color: #57423e; font-size: 15px; margin-bottom: 24px;">Thank you for registering at Delulu! Click the button below to verify your email and set up your password.</p>
        <a href="${verifyLink}" style="display: inline-block; padding: 14px 28px; background-color: #a53b29; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">Verify Email Address</a>
        <p style="color: #8b716d; font-size: 12px; margin-top: 24px;">This link will expire in 15 minutes. If you did not request this, you can safely ignore this email.</p>
      </div>
    `;

    await sendBrevoEmail(cleanEmail, 'Verify your email for Delulu', htmlContent);
    res.json({ success: true });
  } catch (err) {
    console.error('Send verification email error:', err);
    res.status(500).json({ error: err.message || 'Failed to send verification email' });
  }
});

// Verify sign-up/login link token
app.post('/api/auth/verify-token', authLimiter, async (req, res) => {
  const { token, email } = req.body;
  if (!token || !email) {
    return res.status(400).json({ error: 'Token and email are required' });
  }

  const cleanEmail = email.toLowerCase().trim();
  try {
    const validOtp = await otpOps.getValidOTP(cleanEmail, token);
    if (!validOtp) {
      return res.status(400).json({ error: 'Invalid, expired, or already used verification token' });
    }

    // Mark as used
    await otpOps.markUsed(validOtp.id);

    // Save in session
    req.session.pendingEmail = cleanEmail;

    // Check if user already exists
    const user = await userOps.getByEmail(cleanEmail);
    res.json({
      success: true,
      isNewUser: !user,
      email: cleanEmail
    });
  } catch (err) {
    console.error('Verify token error:', err);
    res.status(500).json({ error: 'Failed to verify token' });
  }
});

// Username/Email + Password Login
app.post('/api/users/login', authLimiter, async (req, res) => {
  const { usernameOrEmail, password } = req.body;
  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Username/Email and password are required' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    let user = null;
    const identifier = usernameOrEmail.trim().toLowerCase();
    
    if (identifier.includes('@')) {
      user = await userOps.getByEmail(identifier);
    } else {
      user = await userOps.getByUsername(identifier);
    }

    if (!user) {
      return res.status(401).json({ error: 'Incorrect username/email or password' });
    }

    const match = await bcrypt.compare(password, user.passcode_hash);
    if (!match) {
      return res.status(401).json({ error: 'Incorrect username/email or password' });
    }

    req.session.userId = user.id;
    const safeUser = sanitizeUser(user);
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete profile for new users (signs up user with password in Firestore)
app.post('/api/auth/complete-profile', async (req, res) => {
  try {
    const { email, username, password, gender, bio, hobbies, avatar, public_key, encrypted_private_key } = req.body;

    if (!email || !username || !password || !gender) {
      return res.status(400).json({ error: 'Email, username, password, and gender are required' });
    }
    if (!['male', 'female', 'other'].includes(gender)) {
      return res.status(400).json({ error: 'Invalid gender' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    const usernameStr = String(username).trim();
    if (usernameStr.length < 3 || usernameStr.length > 20) {
      return res.status(400).json({ error: 'Username must be between 3 and 20 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(usernameStr)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    }
    if (bio && bio.length > 300) {
      return res.status(400).json({ error: 'Bio must be less than 300 characters' });
    }
    if (hobbies && Array.isArray(hobbies) && hobbies.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 hobbies allowed' });
    }

    // Verify this email was recently verified (stored in session)
    if (req.session.pendingEmail !== email.toLowerCase().trim()) {
      return res.status(401).json({ error: 'Please verify your email address first' });
    }

    // Check availability
    const existing = await userOps.getByUsername(usernameStr);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const existingEmail = await userOps.getByEmail(email.toLowerCase().trim());
    if (existingEmail) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = await userOps.createWithEmail(
      usernameStr, 
      gender, 
      email.toLowerCase().trim(), 
      passwordHash, 
      bio, 
      hobbies, 
      avatar,
      public_key || null,
      encrypted_private_key || null
    );
    
    req.session.userId = Number(userId);
    delete req.session.pendingEmail;

    const user = await userOps.getById(userId);
    const safeUser = sanitizeUser(user);
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error('Complete profile error:', err);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// Logout
app.post('/api/users/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get current user
app.get('/api/users/me', requireAuth, async (req, res) => {
  const user = await userOps.getById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const safeUser = sanitizeUser(user);
  res.json(safeUser);
});

// Update profile
app.put('/api/users/me', requireAuth, async (req, res) => {
  const { bio, hobbies, avatar } = req.body;
  // Input validation
  if (bio !== undefined && bio !== null && bio.length > 300) {
    return res.status(400).json({ error: 'Bio must be less than 300 characters' });
  }
  if (hobbies && Array.isArray(hobbies)) {
    if (hobbies.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 hobbies allowed' });
    }
    for (const h of hobbies) {
      if (typeof h !== 'string' || h.length > 30) {
        return res.status(400).json({ error: 'Each hobby must be a string under 30 characters' });
      }
    }
  }
  await userOps.update(req.session.userId, { bio, hobbies, avatar });
  const user = await userOps.getById(req.session.userId);
  const safeUser = sanitizeUser(user);
  res.json({ success: true, user: safeUser });
});

// Discover profiles
// Discover profiles
app.get('/api/discover', requireAuth, async (req, res) => {
  const user = await userOps.getById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Get IDs of users already connected with
  const excludeIds = await connectionOps.getConnectedUserIds(req.session.userId);
  const profiles = await userOps.getDiscoverable(req.session.userId, user.gender, excludeIds);
  
  // Map profiles and calculate hobby matches
  const userHobbies = Array.isArray(user.hobbies) ? user.hobbies : JSON.parse(user.hobbies || '[]');
  const mappedProfiles = profiles.map(p => {
    const profileHobbies = Array.isArray(p.hobbies) ? p.hobbies : JSON.parse(p.hobbies || '[]');
    const matchingHobbies = userHobbies.filter(h => profileHobbies.includes(h));
    const matchCount = matchingHobbies.length;
    return {
      id: p.id,
      username: p.username,
      bio: p.bio,
      hobbies: profileHobbies,
      matching_hobbies: matchingHobbies,
      match_count: matchCount,
      avatar: {
        idle: p.avatar ? `/avatars/${p.gender}/${p.avatar}/idle.jpeg` : null,
        wave: p.avatar ? `/avatars/${p.gender}/${p.avatar}/wave.jpeg` : null
      },
      gender: p.gender,
      total_count: p.total_count
    };
  });

  // Sort by match count descending (most matching hobbies first)
  mappedProfiles.sort((a, b) => b.match_count - a.match_count);

  res.json({ profiles: mappedProfiles });
});

// Send connection request
app.post('/api/connections/request', requireAuth, async (req, res) => {
  const { to_user_id } = req.body;
  if (!to_user_id) return res.status(400).json({ error: 'Missing target user' });
  if (Number(to_user_id) === req.session.userId) return res.status(400).json({ error: 'Cannot request yourself' });

  const user = await userOps.getById(req.session.userId);
  const target = await userOps.getById(to_user_id);
  if (!user || !target) return res.status(404).json({ error: 'User not found' });

  if (user.gender === 'male' && target.gender !== 'female') {
    return res.status(400).json({ error: 'Gender preference mismatch: Male accounts can only connect with Female accounts.' });
  }
  if (user.gender === 'female' && target.gender !== 'male') {
    return res.status(400).json({ error: 'Gender preference mismatch: Female accounts can only connect with Male accounts.' });
  }

  const result = await connectionOps.sendRequest(req.session.userId, to_user_id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Dismiss/skip profile
app.post('/api/connections/dismiss', requireAuth, async (req, res) => {
  const { to_user_id } = req.body;
  if (!to_user_id) return res.status(400).json({ error: 'Missing target user' });
  
  const result = await connectionOps.dismiss(req.session.userId, to_user_id);
  res.json(result);
});

// Get pending requests (incoming)
app.get('/api/connections/incoming', requireAuth, async (req, res) => {
  const requests = await connectionOps.getPendingForUser(req.session.userId);
  res.json({ requests });
});

// Get sent requests
app.get('/api/connections/sent', requireAuth, async (req, res) => {
  const requests = await connectionOps.getSentRequests(req.session.userId);
  res.json({ requests });
});

// Respond to request
app.post('/api/connections/respond', requireAuth, async (req, res) => {
  const { connection_id, action } = req.body;
  if (!connection_id || !['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const result = await connectionOps.respond(connection_id, req.session.userId, action);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Revoke/cancel connection request
app.delete('/api/connections/:id', requireAuth, async (req, res) => {
  const connectionId = Number(req.params.id);
  if (!connectionId) return res.status(400).json({ error: 'Missing connection ID' });
  
  const result = await connectionOps.revoke(connectionId, req.session.userId);
  if (result.error) {
    if (result.error.includes('not found')) return res.status(404).json(result);
    if (result.error.includes('authorized')) return res.status(403).json(result);
    return res.status(400).json(result);
  }
  res.json(result);
});

// Get active connections (accepted chats)
app.get('/api/connections/active', requireAuth, async (req, res) => {
  const connections = await connectionOps.getActiveConnections(req.session.userId);
  
  const now = new Date();
  const enriched = connections.map(c => ({
    ...c,
    is_vibe_available: c.vibe_available_at ? new Date(c.vibe_available_at) <= now : false,
    my_vote: c.from_user_id === req.session.userId ? c.from_vibe : c.to_vibe,
    other_vote: c.from_user_id === req.session.userId ? c.to_vibe : c.from_vibe,
    my_reveal: c.from_user_id === req.session.userId ? c.reveal_from : c.reveal_to,
    other_reveal: c.from_user_id === req.session.userId ? c.reveal_to : c.reveal_from
  }));

  res.json({ connections: enriched });
});

// Get single connection details
app.get('/api/connections/:id', requireAuth, async (req, res) => {
  const conn = await connectionOps.getConnection(req.params.id, req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  
  const now = new Date();
  res.json({
    connection: {
      ...conn,
      is_vibe_available: conn.vibe_available_at ? new Date(conn.vibe_available_at) <= now : false
    }
  });
});

// Submit vibe/not vibe
app.post('/api/connections/vibe', requireAuth, async (req, res) => {
  const { connection_id, vibe } = req.body;
  if (!connection_id || ![1, 2].includes(vibe)) {
    return res.status(400).json({ error: 'Invalid vibe value' });
  }
  const result = await connectionOps.submitVibe(connection_id, req.session.userId, vibe);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Submit reveal
app.post('/api/connections/reveal', requireAuth, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  const result = await connectionOps.submitReveal(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Block a user
app.post('/api/connections/block', requireAuth, async (req, res) => {
  const { target_user_id, reason } = req.body;
  if (!target_user_id) return res.status(400).json({ error: 'Missing target user id' });
  const result = await connectionOps.blockUser(req.session.userId, target_user_id, reason || 'User reported');
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Get messages for a connection
app.get('/api/messages/:connectionId', requireAuth, async (req, res) => {
  const conn = await connectionOps.getConnection(req.params.connectionId, req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  
  const messages = await messageOps.getRecentForConnection(req.params.connectionId);
  res.json({ messages, connection: conn });
});

// Send normal text message
app.post('/api/messages/send', requireAuth, async (req, res) => {
  const { connection_id, content, is_encrypted, iv } = req.body;
  if (!connection_id || !content?.trim()) {
    return res.status(400).json({ error: 'Missing connection_id or content' });
  }

  const conn = await connectionOps.getConnection(connection_id, req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const msg = await messageOps.send(
    connection_id, 
    req.session.userId, 
    content.trim(), 
    0, 
    0, 
    is_encrypted || 0, 
    iv || null
  );

  // Emit socket event for real-time receipt
  io.to(`chat:${connection_id}`).emit('new-message', {
    ...msg,
    sender_id: req.session.userId
  });

  res.json({ success: true, message: msg });
});

// Send voice message
app.post('/api/messages/upload-voice', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    const { connection_id, duration, is_encrypted, iv } = req.body;
    if (!req.file || !connection_id) {
      return res.status(400).json({ error: 'Missing audio file or connection_id' });
    }

    const conn = await connectionOps.getConnection(connection_id, req.session.userId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    // Store the file path relative to public/
    const content = `/uploads/voice/${req.file.filename}`;
    const msg = await messageOps.send(
      connection_id, 
      req.session.userId, 
      content, 
      1, 
      Math.round(duration || 0),
      is_encrypted || 0,
      iv || null
    );

    // Emit socket event for real-time receipt
    io.to(`chat:${connection_id}`).emit('new-message', {
      ...msg,
      sender_id: req.session.userId
    });

    res.json({ success: true, message: msg });
  } catch (err) {
    console.error('Voice upload error:', err);
    res.status(500).json({ error: 'Failed to upload voice message' });
  }
});

// ===== PAGE ROUTES =====

// Serve static HTML files for MPA
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/discover', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'discover.html'));
});

app.get('/requests', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'requests.html'));
});

app.get('/messages', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// Initialize database and start server (Async)
(async () => {
  try {
    getDB();
    await seedDemoUsers();
  } catch (err) {
    console.error('Error seeding demo users in Firestore:', err);
  }
})();

// Scheduled Sweep for Expired Connections (every 1 minute)
setInterval(async () => {
  try {
    const sweepResult = await connectionOps.sweepExpired();
    if (sweepResult.vibeExpired > 0 || sweepResult.revealsExpired > 0) {
      console.log(`[Sweep] Expired ${sweepResult.vibeExpired} vibes and ${sweepResult.revealsExpired} reveals.`);
    }
  } catch (err) {
    console.error('[Sweep Error]', err);
  }
}, 60 * 1000);




// HTTP → HTTPS redirect in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Delulu Dating App running at http://localhost:${PORT}`);
  console.log(`Open your browser to http://localhost:${PORT}`);
  console.log('');
  console.log('Demo users (passcode for all is 123456):');
  console.log('  Female: wanderlust_amy, art_vibes, trailblazer, bookish_bee, melody_maker, spice_queen');
  console.log('  Male:   stellar_jay, coffee_leo, pixel_wanderer, green_mind, ocean_soul, zen_master');
});
