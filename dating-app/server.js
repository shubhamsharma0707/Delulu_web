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
const { getDB, seedDemoUsers, backfillDemoAvatars, userOps, connectionOps, messageOps } = require('./database');
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

  socket.on('join-chat', (connectionId) => {
    socket.join(`chat:${connectionId}`);
  });

  socket.on('leave-chat', (connectionId) => {
    socket.leave(`chat:${connectionId}`);
  });

  socket.on('send-message', async (data) => {
    const { connectionId, content } = data;
    if (!connectionId || !content?.trim()) return;

    // Verify user is part of this connection
    const conn = connectionOps.getConnection(connectionId, userId);
    if (!conn) return;

    const msg = messageOps.send(connectionId, userId, content.trim());
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
app.get('/api/session', (req, res) => {
  if (req.session.userId) {
    const user = userOps.getById(req.session.userId);
    if (user) {
      const safeUser = sanitizeUser(user);
      return res.json({ authenticated: true, user: safeUser });
    }
  }
  res.json({ authenticated: false });
});

// Create profile (signup — legacy passcode flow)
app.post('/api/users/create', async (req, res) => {
  try {
    const { username, gender, passcode, bio, hobbies, avatar } = req.body;
    
    if (!username || !gender || !passcode) {
      return res.status(400).json({ error: 'Username, gender, and passcode are required' });
    }
    if (!['male', 'female', 'other'].includes(gender)) {
      return res.status(400).json({ error: 'Invalid gender' });
    }
    if (passcode.length < 6) {
      return res.status(400).json({ error: 'Passcode must be at least 6 characters' });
    }
    // Input validation
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
    // Validate hobbies
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

    // Check username availability
    const existing = userOps.getByUsername(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const passcodeHash = await bcrypt.hash(passcode, 10);
    const userId = userOps.create(username, gender, passcodeHash, bio, hobbies, avatar);
    req.session.userId = Number(userId);
    
    const user = userOps.getById(userId);
    const safeUser = sanitizeUser(user);
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// Login
app.post('/api/users/login', async (req, res) => {    const { username, passcode } = req.body;
  if (!username || !passcode) {
    return res.status(400).json({ error: 'Username and passcode required' });
  }
  if (typeof passcode !== 'string' || passcode.length < 6) {
    return res.status(400).json({ error: 'Invalid passcode' });
  }
  
  const user = userOps.getByUsername(username);
  if (!user) return res.status(401).json({ error: 'Incorrect username or passcode' });
  
  const match = await bcrypt.compare(passcode, user.passcode_hash);
  if (!match) return res.status(401).json({ error: 'Incorrect username or passcode' });

  req.session.userId = user.id;
  const safeUser = sanitizeUser(user);
  res.json({ success: true, user: safeUser });
});

// ===== EMAIL OTP AUTH ROUTES =====

// Send OTP to email (rate limited separately)
// Verify Firebase ID Token and login/register
app.post('/api/auth/verify-firebase-token', authLimiter, async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: 'ID Token is required' });
    }

    if (!firebaseInitialized || !firebaseAuth) {
      return res.status(500).json({ error: 'Firebase Auth is not configured on the server' });
    }

    // Verify token
    const decodedToken = await firebaseAuth.verifyIdToken(idToken);
    const cleanEmail = decodedToken.email.toLowerCase();

    // Check if user already exists in local DB by email
    let user = userOps.getByEmail(cleanEmail);
    const isNewUser = !user;

    if (user) {
      // Existing user — log them in
      req.session.userId = user.id;
    } else {
      // New user — store email in session for profile completion
      req.session.pendingEmail = cleanEmail;
    }

    if (req.body.rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    }

    const safeUser = sanitizeUser(user) || {};
    res.json({ 
      success: true, 
      isNewUser,
      email: cleanEmail,
      user: safeUser || null 
    });
  } catch (err) {
    console.error('Verify Firebase Token error:', err);
    res.status(401).json({ error: 'Invalid or expired Firebase token' });
  }
});

// Complete profile for new users (after OTP verification)
app.post('/api/auth/complete-profile', async (req, res) => {
  try {
    const { email, username, gender, bio, hobbies, avatar } = req.body;

    if (!email || !username || !gender) {
      return res.status(400).json({ error: 'Email, username, and gender are required' });
    }
    if (!['male', 'female', 'other'].includes(gender)) {
      return res.status(400).json({ error: 'Invalid gender' });
    }
    // Input validation
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
    for (const h of (hobbies || [])) {
      if (typeof h !== 'string' || h.length > 30) {
        return res.status(400).json({ error: 'Each hobby must be a string under 30 characters' });
      }
    }

    // Verify this email was recently OTP-verified (stored in session)
    if (req.session.pendingEmail !== email) {
      return res.status(401).json({ error: 'Please verify your email with OTP first' });
    }

    // Check username availability
    const existing = userOps.getByUsername(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // Check if email already taken
    const existingEmail = userOps.getByEmail(email);
    if (existingEmail) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const userId = userOps.createWithEmail(username, gender, email, bio, hobbies, avatar);
    
    req.session.userId = Number(userId);
    delete req.session.pendingEmail;

    const user = userOps.getById(userId);
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
app.get('/api/users/me', requireAuth, (req, res) => {
  const user = userOps.getById(req.session.userId);
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
  userOps.update(req.session.userId, { bio, hobbies, avatar });
  const user = userOps.getById(req.session.userId);
  const safeUser = sanitizeUser(user);
  res.json({ success: true, user: safeUser });
});

// Discover profiles
app.get('/api/discover', requireAuth, (req, res) => {
  const user = userOps.getById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Get IDs of users already connected with
  const connected = getDB().prepare(`
    SELECT DISTINCT 
      CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END as connected_user_id
    FROM connections 
    WHERE (from_user_id = ? OR to_user_id = ?)
      AND status IN ('pending', 'accepted', 'rejected', 'expired', 'revealed')
  `).all(req.session.userId, req.session.userId, req.session.userId);
  
  const excludeIds = connected.map(c => c.connected_user_id);
  
  const profiles = userOps.getDiscoverable(req.session.userId, user.gender, excludeIds);
  
  // Map profiles and calculate hobby matches
  const userHobbies = JSON.parse(user.hobbies || '[]');
  const mappedProfiles = profiles.map(p => {
    const profileHobbies = JSON.parse(p.hobbies || '[]');
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
app.post('/api/connections/request', requireAuth, (req, res) => {
  const { to_user_id } = req.body;
  if (!to_user_id) return res.status(400).json({ error: 'Missing target user' });
  if (to_user_id === req.session.userId) return res.status(400).json({ error: 'Cannot request yourself' });

  const user = userOps.getById(req.session.userId);
  const target = userOps.getById(to_user_id);
  if (!user || !target) return res.status(404).json({ error: 'User not found' });

  if (user.gender === 'male' && target.gender !== 'female') {
    return res.status(400).json({ error: 'Gender preference mismatch: Male accounts can only connect with Female accounts.' });
  }
  if (user.gender === 'female' && target.gender !== 'male') {
    return res.status(400).json({ error: 'Gender preference mismatch: Female accounts can only connect with Male accounts.' });
  }

  const result = connectionOps.sendRequest(req.session.userId, to_user_id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Dismiss/skip profile
app.post('/api/connections/dismiss', requireAuth, (req, res) => {
  const { to_user_id } = req.body;
  if (!to_user_id) return res.status(400).json({ error: 'Missing target user' });
  
  // Check if connection already exists
  const existing = getDB().prepare(
    'SELECT id, status FROM connections WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)'
  ).get(req.session.userId, to_user_id, to_user_id, req.session.userId);
  
  if (existing) {
    getDB().prepare('UPDATE connections SET status = ? WHERE id = ?').run('rejected', existing.id);
  } else {
    getDB().prepare('INSERT INTO connections (from_user_id, to_user_id, status) VALUES (?, ?, ?)').run(req.session.userId, to_user_id, 'rejected');
  }
  
  res.json({ success: true });
});

// Get pending requests (incoming)
app.get('/api/connections/pending', requireAuth, (req, res) => {
  const requests = connectionOps.getPendingForUser(req.session.userId);
  res.json({ requests });
});

// Get sent requests
app.get('/api/connections/sent', requireAuth, (req, res) => {
  const requests = connectionOps.getSentRequests(req.session.userId);
  res.json({ requests });
});

// Respond to request
app.post('/api/connections/respond', requireAuth, (req, res) => {
  const { connection_id, action } = req.body;
  if (!connection_id || !['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const result = connectionOps.respond(connection_id, req.session.userId, action);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Revoke/cancel connection request
app.delete('/api/connections/:id', requireAuth, (req, res) => {
  const connectionId = Number(req.params.id);
  if (!connectionId) return res.status(400).json({ error: 'Missing connection ID' });
  
  const conn = getDB().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  
  if (conn.from_user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Not authorized to revoke this request' });
  }
  
  if (conn.status !== 'pending') {
    return res.status(400).json({ error: 'Cannot revoke a request that is not pending' });
  }
  
  getDB().prepare('DELETE FROM connections WHERE id = ?').run(connectionId);
  res.json({ success: true });
});

// Get active connections (accepted chats)
app.get('/api/connections/active', requireAuth, (req, res) => {
  const connections = connectionOps.getActiveConnections(req.session.userId);
  
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
app.get('/api/connections/:id', requireAuth, (req, res) => {
  const conn = connectionOps.getConnection(req.params.id, req.session.userId);
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
app.post('/api/connections/vibe', requireAuth, (req, res) => {
  const { connection_id, vibe } = req.body;
  if (!connection_id || ![1, 2].includes(vibe)) {
    return res.status(400).json({ error: 'Invalid vibe value' });
  }
  const result = connectionOps.submitVibe(connection_id, req.session.userId, vibe);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Submit reveal
app.post('/api/connections/reveal', requireAuth, (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  const result = connectionOps.submitReveal(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Block a user
app.post('/api/connections/block', requireAuth, (req, res) => {
  const { target_user_id, reason } = req.body;
  if (!target_user_id) return res.status(400).json({ error: 'Missing target user id' });
  const result = connectionOps.blockUser(req.session.userId, target_user_id, reason || 'User reported');
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Get messages for a connection
app.get('/api/messages/:connectionId', requireAuth, (req, res) => {
  const conn = connectionOps.getConnection(req.params.connectionId, req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  
  const messages = messageOps.getRecentForConnection(req.params.connectionId);
  res.json({ messages, connection: conn });
});

// Send normal text message
app.post('/api/messages/send', requireAuth, (req, res) => {
  const { connection_id, content } = req.body;
  if (!connection_id || !content?.trim()) {
    return res.status(400).json({ error: 'Missing connection_id or content' });
  }

  const conn = connectionOps.getConnection(connection_id, req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const msg = messageOps.send(connection_id, req.session.userId, content.trim(), 0, 0);

  // Emit socket event for real-time receipt
  io.to(`chat:${connection_id}`).emit('new-message', {
    ...msg,
    sender_id: req.session.userId
  });

  res.json({ success: true, message: msg });
});

// Send voice message
app.post('/api/messages/upload-voice', requireAuth, upload.single('audio'), (req, res) => {
  try {
    const { connection_id, duration } = req.body;
    if (!req.file || !connection_id) {
      return res.status(400).json({ error: 'Missing audio file or connection_id' });
    }

    const conn = connectionOps.getConnection(connection_id, req.session.userId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    // Store the file path relative to public/
    const content = `/uploads/voice/${req.file.filename}`;
    const msg = messageOps.send(connection_id, req.session.userId, content, 1, Math.round(duration || 0));

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

// Initialize database and start server
getDB();
seedDemoUsers();
backfillDemoAvatars();

// Scheduled Sweep for Expired Connections (every 1 minute)
setInterval(() => {
  try {
    const sweepResult = connectionOps.sweepExpired();
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
