const express = require('express');
const pino = require('pino')({
  level: process.env.LOG_LEVEL || 'info'
});
const pinoHttp = require('pino-http')({ 
  logger: pino,
  autoLogging: {
    ignore: (req) => req.url.startsWith('/uploads/') || req.url.startsWith('/avatars/')
  }
});

// Override console methods to direct output to structured pino
console.log = (...args) => {
  if (args.length === 1 && typeof args[0] === 'string') {
    pino.info(args[0]);
  } else {
    pino.info({ args });
  }
};
console.error = (...args) => {
  if (args.length === 1 && args[0] instanceof Error) {
    pino.error(args[0]);
  } else if (args.length === 1 && typeof args[0] === 'string') {
    pino.error(args[0]);
  } else {
    pino.error({ args });
  }
};
console.warn = (...args) => {
  if (args.length === 1 && typeof args[0] === 'string') {
    pino.warn(args[0]);
  } else {
    pino.warn({ args });
  }
};

const { EventEmitter } = require('events');
const connectionEmitter = new EventEmitter();

const session = require('express-session');
const compression = require('compression');
const MemoryStore = require('memorystore')(session);
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initializeApp: firebaseInitializeApp, cert } = require('firebase-admin/app');
const { getAuth: getFirebaseAuth } = require('firebase-admin/auth');
const { getDB, seedDemoUsers, userOps, connectionOps, messageOps, otpOps, invalidateUserCache, reportOps, blockOps, pushOps } = require('./database');
const multer = require('multer');
const fs = require('fs');

// Load environment variables
require('dotenv').config();

// Check Node.js version — Node 18+ required for global fetch used in sendBrevoEmail
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`FATAL: Node.js 18+ required (current: ${process.version}). Upgrade Node to use this app.`);
  process.exit(1);
}

// Validate critical environment variables at startup — fail early, not at runtime
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env or environment.');
  console.error('Without them, message sending/reading will silently fail. Set both and restart.');
  process.exit(1);
}

const app = express();
app.use(pinoHttp);

const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 30000,
  pingInterval: 10000,
  transports: ['websocket', 'polling']
});

// Active in-memory games store (prevents Firestore write overload)
const activeGames = new Map(); // connectionId -> active_game payload

// Ensure upload folders exist
fs.mkdirSync('public/uploads/voice', { recursive: true });
const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/voice/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    // Force .webm extension for all voice uploads to prevent Stored XSS via HTML/JS files
    cb(null, 'voice-' + uniqueSuffix + '.webm');
  }
});
const voiceUpload = multer({
  storage: voiceStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('audio/') && file.mimetype !== 'application/octet-stream') {
      return cb(new Error('Only audio files are allowed'), false);
    }
    cb(null, true);
  }
});

const PORT = process.env.PORT || 3000;

// Note: email domain validation is defined inline in the send-verification-email handler
// (keeping it next to the code that uses it for clarity)

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

// Firebase client config for Firestore realtime listener (onSnapshot for connection document)
// Set FIREBASE_API_KEY to your Firebase Web SDK's API key (from Console > Project Settings > Web API Key).
// The listener replaces wasteful HTTP polling for connection state (active_game, reveal status, etc.).
const FIREBASE_CLIENT_CONFIG = process.env.FIREBASE_API_KEY ? {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
} : null;

// Hard-fail if SESSION_SECRET is not set — a dating app must never run with a guessable session secret
if (!process.env.SESSION_SECRET) {
  throw new Error('FATAL: SESSION_SECRET environment variable is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
}

// Trust proxy for when running behind nginx/render/heroku
app.set('trust proxy', 1);

// Enable Gzip/Brotli response compression
app.use(compression());

// HTTP → HTTPS redirect in production (must run before helmet or any route)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
  });
}

// Security headers via Helmet with Content Security Policy allowlist
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "www.gstatic.com", "apis.google.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdn.tailwindcss.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "wss:", "ws:", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com", "https://firestore.googleapis.com", "https://cdnjs.cloudflare.com", "https://www.gstatic.com"],
      frameSrc: ["'self'", "https://apis.google.com"].concat(
        process.env.FIREBASE_PROJECT_ID ? [`https://${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`] : []
      ),
    },
  },
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

// Looser limit for discovery routes (swiping/dismissing profiles)
const discoverLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===== In-Memory Session Cache (reduces Firestore reads for frequent session checks) =====
const sessionCache = new Map();
const CACHE_TTL = 30 * 1000; // 30 seconds

function getCachedUser(userId) {
  const cached = sessionCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedUser(userId, userData) {
  sessionCache.set(userId, { data: userData, timestamp: Date.now() });
  // Limit cache size to 500 entries
  if (sessionCache.size > 500) {
    const oldest = sessionCache.keys().next().value;
    if (oldest) sessionCache.delete(oldest);
  }
}

function invalidateCache(userId) {
  sessionCache.delete(userId);
}

// Session middleware — using memorystore (pure JS, no native compilation)
// NOTE: In-memory sessions are lost on server restart (all users logged out).
// For production across multiple instances, use a database-backed store
// (connect-redis, connect-session-knex, @supabase/supabase-js, etc.)
const sessionMiddleware = session({
  store: new MemoryStore({
    checkPeriod: 15 * 60 * 1000 // auto-clear expired sessions every 15 min
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

// CSRF Sec-Fetch-Site / Origin check — defense-in-depth on top of sameSite: 'lax'
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const secFetchSite = req.get('sec-fetch-site');
    // Block cross-site state-changing requests outright if sent by browser
    if (secFetchSite === 'cross-site') {
      return res.status(403).json({ error: 'Cross-origin request blocked' });
    }

    const origin = req.get('origin') || req.get('referer') || '';
    if (origin) {
      try {
        const originHostname = new URL(origin).hostname;
        // Compare against both req.hostname and the Host header to handle
        // mismatches like localhost vs 127.0.0.1 in development
        const hostHeader = (req.headers.host || '').split(':')[0];
        if (originHostname !== req.hostname && originHostname !== hostHeader) {
          return res.status(403).json({ error: 'Cross-origin request blocked' });
        }
      } catch (e) {
        return res.status(403).json({ error: 'Invalid origin header' });
      }
    }
  }
  next();
});

// Protect user-uploaded files (voice notes, etc.) with authentication
app.use('/uploads', requireAuth);

// Static files with aggressive Cache-Control headers
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '365d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      // Never cache HTML files to ensure code updates are picked up instantly
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      // Cache-bustable static assets (JS, CSS, images, fonts) are cached aggressively for 1 year
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Share session with Socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// ===== Presence Tracking =====
const onlineUsers = new Map(); // userId -> { socketId, lastSeen }

async function getConnectedUserIdsForPresence(userId) {
  try {
    const conns = await connectionOps.getActiveConnections(userId);
    const ids = [];
    conns.forEach(c => {
      if (c.from_user_id === Number(userId)) ids.push(c.to_user_id);
      else if (c.to_user_id === Number(userId)) ids.push(c.from_user_id);
    });
    return [...new Set(ids)];
  } catch (e) {
    return [];
  }
}

// Socket.io connections for chat
io.on('connection', async (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) {
    console.log(`Socket connection rejected: No session userId for socket ${socket.id}`);
    socket.disconnect(true);
    return;
  }

  console.log(`User ${userId} connected via socket`);

  // Presence: mark user as online
  onlineUsers.set(Number(userId), { socketId: socket.id, lastSeen: Date.now() });
  socket.broadcast.emit('user-online', { userId: Number(userId) });

  // Join user to their personal room
  socket.join(`user:${userId}`);

  // Send current online status of their connections
  try {
    const connectedIds = await getConnectedUserIdsForPresence(userId);
    const onlineStatuses = {};
    connectedIds.forEach(id => {
      onlineStatuses[id] = onlineUsers.has(id);
    });
    socket.emit('presence-bulk', onlineStatuses);
  } catch (e) {}

  socket.on('join-chat', async (connectionId) => {
    if (!connectionId) return;
    try {
      const conn = await connectionOps.getConnection(connectionId, userId);
      if (!conn || conn._dataIntegrityError) {
        console.log(`join-chat denied: user ${userId} not part of connection ${connectionId}`);
        return;
      }
      socket.join(`chat:${connectionId}`);
      console.log(`User ${userId} joined chat room chat:${connectionId}`);
      // Confirm room join to client so it knows socket is live
      socket.emit('room-joined', { connectionId });
    } catch (err) {
      console.error(`join-chat error for user ${userId} connection ${connectionId}:`, err.message);
    }
  });

  socket.on('leave-chat', (connectionId) => {
    socket.leave(`chat:${connectionId}`);
  });

  socket.on('send-message', async (data) => {
    const { connectionId, content, is_encrypted, iv } = data;
    if (!connectionId || !content?.trim()) return;

    // Verify user is part of this connection
    const conn = await connectionOps.getConnection(connectionId, userId);
    if (!conn || conn._dataIntegrityError) return;

    const msg = await messageOps.send(connectionId, userId, sanitizeText(content.trim()), 0, 0, Number(is_encrypted || 0), iv || null);
    // Emit to both users in the chat
    io.to(`chat:${connectionId}`).emit('new-message', {
      ...msg,
      sender_id: userId
    });
    // Also emit a chat-list update for the messages list
    io.to(`chat:${connectionId}`).emit('chat-update', {
      connectionId,
      lastMessage: Number(is_encrypted) === 1 ? '🔒 Encrypted message' : sanitizeText(content.trim()),
      lastMessageTime: msg.created_at,
      senderId: Number(userId)
    });
  });

  socket.on('typing', (data) => {
    const { connectionId, isTyping } = data;
    if (!connectionId) return;
    socket.to(`chat:${connectionId}`).emit('typing', { userId, isTyping });
  });

  // Mark messages as read
  socket.on('mark-read', async (data) => {
    const { connectionId } = data;
    if (!connectionId) return;
    try {
      const conn = await connectionOps.getConnection(connectionId, userId);
      if (!conn || conn._dataIntegrityError) return;
      
      const result = await messageOps.markAsRead(connectionId, Number(userId), conn);
      if (result.count > 0) {
        // Notify the sender that their messages were read — send server timestamp
        io.to(`chat:${connectionId}`).emit('messages-read', {
          connectionId,
          readBy: Number(userId),
          readAt: result.readAt || new Date().toISOString(),
          count: result.count
        });
      }
    } catch (e) {
      console.error('mark-read error:', e);
    }
  });

  // Handle presence requests from client
  socket.on('request-presence', (data) => {
    const targetUserId = data.userId;
    if (targetUserId) {
      const isOnline = onlineUsers.has(Number(targetUserId));
      socket.emit('presence-bulk', { [targetUserId]: isOnline });
    }
  });

  // Clear typing indicator on disconnect — fires while socket.rooms is still populated,
  // so we can broadcast typing=false to each chat room the user was in.
  // This prevents the other user from seeing "typing..." stuck indefinitely after a crash
  // or abrupt tab close (socket timeout could be up to 10 seconds).
  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (room.startsWith('chat:')) {
        socket.to(room).emit('typing', { userId, isTyping: false });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`User ${userId} disconnected`);
    onlineUsers.delete(Number(userId));
    socket.broadcast.emit('user-offline', { userId: Number(userId), lastSeen: new Date().toISOString() });
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

// Strip HTML tags from user-supplied text (defense-in-depth against stored XSS)
// Only strips valid HTML tags (starting with letter, /, or ! — excludes "<3" and similar)
function sanitizeText(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[a-zA-Z\/!?][^>]*>/g, '');
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

function sanitizeConnection(c, userId) {
  if (!c) return null;
  const isFrom = c.from_user_id === Number(userId);
  
  const copy = { ...c };
  
  // Backward compatibility: map old fields (reveal_available_at, reveal_from/reveal_to) to new ones
  const fromIdentityReveal = c.from_identity_reveal !== undefined ? c.from_identity_reveal : c.reveal_from || 0;
  const toIdentityReveal = c.to_identity_reveal !== undefined ? c.to_identity_reveal : c.reveal_to || 0;
  const identityRevealAvailable = c.identity_reveal_available_at || c.reveal_available_at || null;
  const faceRevealAvailable = c.face_reveal_available_at || c.reveal_available_at || null;
  
  return {
    ...copy,
    identity_reveal_available_at: identityRevealAvailable,
    face_reveal_available_at: faceRevealAvailable,
    my_identity_reveal: isFrom ? fromIdentityReveal : toIdentityReveal,
    other_identity_reveal: isFrom ? toIdentityReveal : fromIdentityReveal,
    both_identity_revealed: fromIdentityReveal === 1 && toIdentityReveal === 1,
    my_face_reveal: isFrom ? c.from_face_reveal || 0 : c.to_face_reveal || 0,
    other_face_reveal: isFrom ? c.to_face_reveal || 0 : c.from_face_reveal || 0,
    both_face_revealed: (c.from_face_reveal || 0) === 1 && (c.to_face_reveal || 0) === 1,
    face_reveal_declined_by_other: isFrom 
      ? c.face_reveal_declined_by === c.to_user_id 
      : c.face_reveal_declined_by === c.from_user_id
  };
}

// Check if user is logged in (with cache)
app.get('/api/session', async (req, res) => {
  if (req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  if (req.session.userId) {
    // Check in-memory cache first
    const cached = getCachedUser(req.session.userId);
    if (cached) {
      req.session.user = cached;
      return res.json({ authenticated: true, user: cached });
    }
    
    const user = await userOps.getById(req.session.userId);
    if (user) {
      const safeUser = sanitizeUser(user);
      req.session.user = safeUser;
      setCachedUser(req.session.userId, safeUser);
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
        name: 'Delulu',
        email: process.env.GMAIL_USER || 'delulu.college.dating@gmail.com'
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
    'makers.rishihood.edu.in',
    'design.rishihood.edu.in'
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
    if (user) {
      req.session.userId = user.id;
      req.session.user = sanitizeUser(user);
    }

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

    // Dummy hash comparison to prevent timing side-channel attacks for username enumeration
    const DUMMY_HASH = '$2b$10$tM2a690L85N6x/2j68g2ae1f68ae1f68ae1f68ae1f68ae1f68ae';
    let match = false;
    
    if (user) {
      match = await bcrypt.compare(password, user.passcode_hash);
    } else {
      // Execute dummy compare to match processor runtime cycles
      await bcrypt.compare(password, DUMMY_HASH);
    }

    if (!user || !match) {
      return res.status(401).json({ error: 'Incorrect username/email or password' });
    }

    req.session.userId = user.id;
    const safeUser = sanitizeUser(user);
    req.session.user = safeUser;
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
      sanitizeText(bio), 
      hobbies ? hobbies.map(h => sanitizeText(h)) : hobbies, 
      avatar,
      public_key || null,
      encrypted_private_key || null
    );
    
    req.session.userId = Number(userId);
    delete req.session.pendingEmail;

    const user = await userOps.getById(userId);
    const safeUser = sanitizeUser(user);
    req.session.user = safeUser;
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error('Complete profile error:', err);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// Logout
app.post('/api/users/logout', (req, res) => {
  const userId = req.session?.userId;
  if (userId) {
    invalidateCache(userId);
    invalidateUserCache && invalidateUserCache(userId);
  }
  req.session.destroy();
  res.json({ success: true });
});

// Get current user
app.get('/api/users/me', requireAuth, async (req, res) => {
  if (req.session.user) {
    return res.json(req.session.user);
  }
  const user = await userOps.getById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const safeUser = sanitizeUser(user);
  req.session.user = safeUser;
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
  try {
    await userOps.update(req.session.userId, { 
      bio: bio !== undefined ? sanitizeText(bio) : undefined, 
      hobbies: hobbies ? hobbies.map(h => sanitizeText(h)) : undefined, 
      avatar 
    });
  } catch (updateErr) {
    console.error('Profile update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update profile. Please try again.' });
  }
  const user = await userOps.getById(req.session.userId);
  const safeUser = sanitizeUser(user);
  req.session.user = safeUser;
  // Update in-memory session cache and req.session.user immediately
  setCachedUser(req.session.userId, safeUser);
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
  
  // Map profiles and calculate hobby matches (case-insensitive)
  const userHobbies = Array.isArray(user.hobbies) ? user.hobbies : JSON.parse(user.hobbies || '[]');
  const userHobbiesLower = userHobbies.map(h => String(h).toLowerCase());
  const mappedProfiles = profiles.map(p => {
    const profileHobbies = Array.isArray(p.hobbies) ? p.hobbies : JSON.parse(p.hobbies || '[]');
    const profileHobbiesLower = profileHobbies.map(h => String(h).toLowerCase());
    const matchingHobbiesLower = userHobbiesLower.filter(h => profileHobbiesLower.includes(h));
    // Map back to original user display strings for matching_hobbies
    const matchingHobbies = matchingHobbiesLower.map(lh => userHobbies[userHobbiesLower.indexOf(lh)] || lh);
    const matchCount = matchingHobbies.length;
    return {
      id: p.id,
      username: p.username,
      bio: p.bio,
      hobbies: profileHobbies,
      matching_hobbies: matchingHobbies,
      match_count: matchCount,
      avatar: {
        idle: p.avatar ? `/avatars/${p.gender}/${p.avatar}/idle.png` : null,
        wave: p.avatar ? `/avatars/${p.gender}/${p.avatar}/wave.png` : null
      },
      gender: p.gender
    };
  });

  // Sort by match count descending (most matching hobbies first)
  mappedProfiles.sort((a, b) => b.match_count - a.match_count);

  res.json({ profiles: mappedProfiles });
});

// Send connection request
app.post('/api/connections/request', requireAuth, discoverLimiter, async (req, res) => {
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
  
  // Notify the target user about the connection request
  const reqUser = await userOps.getById(req.session.userId);
  if (reqUser) {
    sendPushNotification(to_user_id, 'New Connection Request', `${reqUser.username} wants to connect with you!`, '/requests');
  }
  
  res.json(result);
});

// Dismiss/skip profile
app.post('/api/connections/dismiss', requireAuth, discoverLimiter, async (req, res) => {
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
  
  // Emit match-celebration event to the requester when their request is accepted
  if (action === 'accept') {
    const conn = await connectionOps.getConnectionById(connection_id);
    if (conn) {
      const accepter = await userOps.getById(req.session.userId);
      const requester = await userOps.getById(conn.from_user_id);
      if (accepter && requester) {
        io.to(`user:${conn.from_user_id}`).emit('match-celebration', {
          connectionId: connection_id,
          username: accepter.username,
          avatar: accepter.avatar
        });
        
        // Notify requester via push
        sendPushNotification(conn.from_user_id, 'Connection Accepted!', `${accepter.username} accepted your request!`, '/chat?id=' + connection_id);
      }
    }
  }
  
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
  
  const enriched = connections.map(c => {
    const sanitized = sanitizeConnection(c, req.session.userId);
    return {
      ...sanitized
    };
  });

  res.json({ connections: enriched });
});

// Get single connection details
app.get('/api/connections/:id', requireAuth, async (req, res) => {
  const conn = await connectionOps.getConnection(req.params.id, req.session.userId);
  if (conn && conn._dataIntegrityError) {
    return res.status(410).json({ error: 'This chat is no longer available — one of the accounts involved no longer exists.' });
  }
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  
  // Use active game from connection object (which now comes directly from Firestore)
  if (!conn.active_game) {
    conn.active_game = null;
  }
  
  res.json({
    connection: sanitizeConnection(conn, req.session.userId)
  });
});

// SSE Endpoint for real-time game/status updates
app.get('/api/connections/:id/stream', requireAuth, async (req, res) => {
  const connectionId = req.params.id;
  const userId = req.session.userId;
  
  // Verify that the connection exists and the user belongs to it
  const conn = await connectionOps.getConnection(connectionId, userId);
  if (!conn || conn._dataIntegrityError) {
    return res.status(404).end();
  }

  // Set SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  
  // Send initial connection verification comment
  res.write(': ok\n\n');

  // Define listener callback
  const onUpdate = (event) => {
    const payload = event && Object.keys(event).length > 1
      ? JSON.stringify(event)
      : event.type;
    res.write(`data: ${payload}\n\n`);
  };

  // Subscribe to updates for this connection
  const eventName = `update:${connectionId}`;
  connectionEmitter.on(eventName, onUpdate);

  // Set heartbeat ping every 25 seconds to keep connection alive on Render/proxies
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  // Clean up subscription and interval when connection closes
  req.on('close', () => {
    connectionEmitter.off(eventName, onUpdate);
    clearInterval(heartbeatInterval);
    res.end();
  });
});

// End connection ("Not Vibing")
app.post('/api/connections/end', requireAuth, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  const result = await connectionOps.endConnection(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);

  if (result.ended && result.otherId) {
    io.to(`user:${result.otherId}`).emit('connection-ended', {
      connectionId: connection_id,
      message: "😔 Your chat partner wasn't feeling the vibe. This chat has ended. You'll be redirected to the discover page."
    });
    io.to(`chat:${connection_id}`).emit('status_change', { connection_id });
  }

  connectionEmitter.emit(`update:${connection_id}`, { type: 'ended' });
  res.json(result);
});

// Submit identity reveal (Day 7)
app.post('/api/connections/identity-reveal', requireAuth, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  const result = await connectionOps.submitIdentityReveal(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  
  if (result.bothRevealed) {
    io.to(`chat:${connection_id}`).emit('identity-revealed', { 
      connection_id, 
      meeting_code: result.meeting_code 
    });
  }
  
  connectionEmitter.emit(`update:${connection_id}`, { type: 'game' });
  res.json(result);
});

// Submit face reveal (Day 14)
app.post('/api/connections/face-reveal', requireAuth, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  const result = await connectionOps.submitFaceReveal(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  
  if (result.bothRevealed) {
    io.to(`chat:${connection_id}`).emit('face-revealed', { 
      connection_id, 
      meeting_code: result.meeting_code 
    });
  }

  connectionEmitter.emit(`update:${connection_id}`, { type: 'game' });
  res.json(result);
});

// Decline face reveal
app.post('/api/connections/decline-face-reveal', requireAuth, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  const result = await connectionOps.declineFaceReveal(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  
  if (result.declined && result.otherId) {
    io.to(`user:${result.otherId}`).emit('face-reveal-declined', {
      connectionId: connection_id
    });
  }

  connectionEmitter.emit(`update:${connection_id}`, { type: 'game' });
  res.json(result);
});

// End connection after face reveal decline
app.post('/api/connections/end-after-decline', requireAuth, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  const result = await connectionOps.endAfterDecline(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  
  io.to(`chat:${connection_id}`).emit('connection-ended', {
    connectionId: connection_id,
    message: "The other person decided to disconnect after the face reveal decline."
  });

  connectionEmitter.emit(`update:${connection_id}`, { type: 'ended' });
  res.json(result);
});

// Start icebreaker game
app.post('/api/connections/:id/start-game', requireAuth, async (req, res) => {
  const { game_type, question } = req.body;
  if (!game_type || !question) return res.status(400).json({ error: 'Missing game_type or question' });
  try {
    const conn = await connectionOps.getConnection(req.params.id, req.session.userId);
    if (!conn || conn._dataIntegrityError) return res.status(404).json({ error: 'Connection not found' });
    
    // Save to Firestore so clients receive it via real-time connection doc snapshot listener
    const payload = await connectionOps.startGame(req.params.id, game_type, question);
    
    // Broadcast status change so both users reload connection state instantly (for socket fallback compatibility)
    io.to(`chat:${req.params.id}`).emit('status_change', { connection_id: req.params.id });
    
    // Broadcast the exact game update to both clients
    io.to(`chat:${req.params.id}`).emit('game_update', {
      connection_id: req.params.id,
      from_user_id: conn.from_user_id,
      to_user_id: conn.to_user_id,
      active_game: payload
    });
    
    connectionEmitter.emit(`update:${req.params.id}`, {
      type: 'game',
      from_user_id: conn.from_user_id,
      to_user_id: conn.to_user_id,
      active_game: payload
    });
    res.json({ success: true, active_game: payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Answer icebreaker game
app.post('/api/connections/:id/answer-game', requireAuth, async (req, res) => {
  const { answer } = req.body;
  if (!answer) return res.status(400).json({ error: 'Missing answer' });
  try {
    const conn = await connectionOps.getConnection(req.params.id, req.session.userId);
    if (!conn || conn._dataIntegrityError) return res.status(404).json({ error: 'Connection not found' });
    
    // Save answer to Firestore connection doc
    const result = await connectionOps.submitGameAnswer(req.params.id, req.session.userId, answer);
    if (result.error) return res.status(400).json(result);
    
    // Broadcast status change so both users reload connection state instantly
    io.to(`chat:${req.params.id}`).emit('status_change', { connection_id: req.params.id });
    
    // Broadcast exact game update to both clients
    io.to(`chat:${req.params.id}`).emit('game_update', {
      connection_id: req.params.id,
      from_user_id: conn.from_user_id,
      to_user_id: conn.to_user_id,
      active_game: result.gameData
    });
    
    connectionEmitter.emit(`update:${req.params.id}`, {
      type: 'game',
      from_user_id: conn.from_user_id,
      to_user_id: conn.to_user_id,
      active_game: result.gameData
    });
    res.json({ success: true, bothAnswered: result.bothAnswered, gameData: result.gameData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear icebreaker game
// IMPORTANT: Do NOT emit status_change here — both users already saw the game card dissolve
// via handleBothAnswered's setTimeout. Emitting status_change creates a race condition where
// a stale clear-game event can arrive AFTER start-game has created a new game, causing
// syncActiveGame to see active_game=null and remove the NEW game card.
app.post('/api/connections/:id/clear-game', requireAuth, async (req, res) => {
  const { game_created_at } = req.body;
  try {
    const conn = await connectionOps.getConnection(req.params.id, req.session.userId);
    if (!conn || conn._dataIntegrityError) return res.status(404).json({ error: 'Connection not found' });
    
    // Clear game in Firestore connection doc. Returns { cleared: true } if
    // the game was actually removed, { cleared: false } if the transaction was
    // skipped because the active_game's created_at didn't match (meaning a new
    // game replaced the old one). We only broadcast game_update(null) when
    // something actually changed, preventing a stale timeout from removing a
    // newly created game.
    const { cleared } = await connectionOps.clearGame(req.params.id, game_created_at);
    
    // Broadcast the clear state to both clients only if the game was actually removed
    if (cleared) {
      io.to(`chat:${req.params.id}`).emit('game_update', {
        connection_id: req.params.id,
        from_user_id: conn.from_user_id,
        to_user_id: conn.to_user_id,
        active_game: null
      });
      
      connectionEmitter.emit(`update:${req.params.id}`, {
        type: 'game',
        from_user_id: conn.from_user_id,
        to_user_id: conn.to_user_id,
        active_game: null
      });
    }
    
    res.json({ success: true, cleared });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Get messages for a connection
app.get('/api/messages/:connectionId', requireAuth, async (req, res) => {
  const conn = await connectionOps.getConnection(req.params.connectionId, req.session.userId);
  if (conn && conn._dataIntegrityError) {
    return res.status(410).json({ error: 'This chat is no longer available — one of the accounts involved no longer exists.' });
  }
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  
  const { since } = req.query;
  const messages = await messageOps.getRecentForConnection(req.params.connectionId, 50, since || null);
  res.json({ messages, connection: sanitizeConnection(conn, req.session.userId) });
});

// REST fallback for read receipts when Socket.io is disabled or unavailable.
app.post('/api/messages/:connectionId/read', requireAuth, async (req, res) => {
  const conn = await connectionOps.getConnection(req.params.connectionId, req.session.userId);
  if (conn && conn._dataIntegrityError) {
    return res.status(410).json({ error: 'This chat is no longer available — one of the accounts involved no longer exists.' });
  }
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const result = await messageOps.markAsRead(req.params.connectionId, req.session.userId, conn);
  res.json({ success: true, readAt: result.readAt || new Date().toISOString(), count: result.count || 0 });
});

// Send normal text message
app.post('/api/messages/send', requireAuth, async (req, res) => {
  const { connection_id, content, is_encrypted, iv } = req.body;
  if (!connection_id || !content?.trim()) {
    return res.status(400).json({ error: 'Missing connection_id or content' });
  }

  const conn = await connectionOps.getConnection(connection_id, req.session.userId);
  if (conn && conn._dataIntegrityError) {
    return res.status(410).json({ error: 'This chat is no longer available — one of the accounts involved no longer exists.' });
  }
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const msg = await messageOps.send(
    connection_id, 
    req.session.userId, 
    sanitizeText(content.trim()), 
    0, 
    0, 
    is_encrypted || 0, 
    iv || null
  );

  // Emit socket event for real-time receipt — sender_id MUST be Number for client === checks
  io.to(`chat:${connection_id}`).emit('new-message', {
    ...msg,
    sender_id: Number(req.session.userId)
  });
  io.to(`chat:${connection_id}`).emit('chat-update', {
    connectionId: connection_id,
    lastMessage: Number(is_encrypted) === 1 ? '🔒 Encrypted message' : sanitizeText(content.trim()),
    lastMessageTime: msg.created_at,
    senderId: Number(req.session.userId)
  });
  connectionEmitter.emit(`update:${connection_id}`, {
    type: 'message',
    senderId: Number(req.session.userId),
    messageId: msg.id
  });

  // Update last_message_at on the connection doc (fire-and-forget is fine — non-critical metadata)
  const firestore = getDB();
  firestore.collection('connections').doc(String(connection_id)).update({
    last_message_at: new Date().toISOString()
  }).catch(err => console.error('Failed to update last_message_at in Firestore:', err));

  res.json({ success: true, message: msg });
});

// Send voice message
app.post('/api/messages/upload-voice', requireAuth, (req, res, next) => {
  voiceUpload.single('audio')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { connection_id, duration, is_encrypted, iv } = req.body;
    if (!req.file || !connection_id) {
      return res.status(400).json({ error: 'Missing audio file or connection_id' });
    }

    const conn = await connectionOps.getConnection(connection_id, req.session.userId);
    if (conn && conn._dataIntegrityError) {
      return res.status(410).json({ error: 'This chat is no longer available — one of the accounts involved no longer exists.' });
    }
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

    // Emit socket event for real-time receipt — sender_id MUST be Number for client === checks
    io.to(`chat:${connection_id}`).emit('new-message', {
      ...msg,
      sender_id: Number(req.session.userId)
    });
    io.to(`chat:${connection_id}`).emit('chat-update', {
      connectionId: connection_id,
      lastMessage: '🎤 Voice note',
      lastMessageTime: msg.created_at,
      senderId: Number(req.session.userId)
    });
    connectionEmitter.emit(`update:${connection_id}`, {
      type: 'message',
      senderId: Number(req.session.userId),
      messageId: msg.id
    });

    const firestore = getDB();
    firestore.collection('connections').doc(String(connection_id)).update({
      last_message_at: new Date().toISOString()
    }).catch(err => console.error('Failed to update last_message_at in Firestore:', err));

    res.json({ success: true, message: msg });
  } catch (err) {
    console.error('Voice upload error:', err);
    res.status(500).json({ error: 'Failed to upload voice message' });
  }
});

// Rate-limited client-side error logger (max 10 writes per minute to protect free tier)
const _clientLogCache = new Map();
setInterval(() => { _clientLogCache.clear(); }, 60 * 1000);

app.post('/api/log-error', async (req, res) => {
  // Throttle: at most 10 logs per IP per minute
  const ipKey = req.ip || 'unknown';
  const count = (_clientLogCache.get(ipKey) || 0) + 1;
  _clientLogCache.set(ipKey, count);
  if (count > 10) {
    return res.sendStatus(200); // Silently drop excess logs
  }

  const logData = {
    timestamp: new Date().toISOString(),
    ip: ipKey,
    userAgent: req.headers['user-agent'],
    ...req.body
  };
  console.error('Client-side error received:', JSON.stringify(logData, null, 2));
  try {
    const firestore = getDB();
    await firestore.collection('client_logs').add(logData);
  } catch (dbErr) {
    console.error('Failed to write client log to Firestore:', dbErr);
  }
  res.sendStatus(200);
});

// ===== Web Push Notifications =====
const webPush = require('web-push');

// Generate VAPID keys if not set
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
if (vapidPublicKey && vapidPrivateKey) {
  webPush.setVapidDetails(
    `mailto:${process.env.GMAIL_USER || 'delulu.college.dating@gmail.com'}`,
    vapidPublicKey,
    vapidPrivateKey
  );
  console.log('Web Push notifications configured');
} else {
  console.log('VAPID keys not set — push notifications disabled. Run: npx web-push generate-vapid-keys');
}

async function sendPushNotification(userId, title, body, url = '/messages') {
  if (!vapidPublicKey || !vapidPrivateKey) return;
  try {
    const subs = await pushOps.getSubscriptions(userId);
    for (const sub of subs) {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: sub.keys
      };
      const payload = JSON.stringify({ title, body, url, icon: '/favicon.ico' });
      webPush.sendNotification(pushSub, payload).catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          pushOps.removeSubscription(sub.endpoint);
        }
      });
    }
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

const ALLOWED_REACTIONS = ['😂', '😢', '❤️', '👍', '😮'];

// React to a message
app.post('/api/messages/:id/react', requireAuth, async (req, res) => {
  const { connection_id, emoji } = req.body;
  if (!connection_id || !emoji) return res.status(400).json({ error: 'Missing connection_id or emoji' });
  if (!ALLOWED_REACTIONS.includes(emoji)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }
  const conn = await connectionOps.getConnection(connection_id, req.session.userId);
  if (conn && conn._dataIntegrityError) {
    return res.status(410).json({ error: 'This chat is no longer available — one of the accounts involved no longer exists.' });
  }
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const result = await messageOps.toggleReaction(req.params.id, req.session.userId, connection_id, emoji);
  if (result.error) return res.status(400).json(result);

  io.to(`chat:${connection_id}`).emit('message-reacted', { messageId: req.params.id, reactions: result.reactions });
  connectionEmitter.emit(`update:${connection_id}`, { type: 'messages' });
  res.json(result);
});

// ===== Report & Block =====

// Report a user
app.post('/api/users/report', requireAuth, async (req, res) => {
  const { reported_user_id, reason, connection_id } = req.body;
  if (!reported_user_id) return res.status(400).json({ error: 'Missing reported user' });
  if (Number(reported_user_id) === req.session.userId) return res.status(400).json({ error: 'Cannot report yourself' });
  
  // Validate reason length — prevent Firestore document size bloat (1MB max per doc)
  const safeReason = (reason || 'No reason').slice(0, 1000);
  
  try {
    const reportId = await reportOps.create(req.session.userId, reported_user_id, safeReason, connection_id || null);
    res.json({ success: true, reportId });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// Block a user
app.post('/api/users/block', requireAuth, async (req, res) => {
  const { blocked_user_id } = req.body;
  if (!blocked_user_id) return res.status(400).json({ error: 'Missing blocked user' });
  if (Number(blocked_user_id) === req.session.userId) return res.status(400).json({ error: 'Cannot block yourself' });
  
  try {
    const result = await blockOps.block(req.session.userId, blocked_user_id);
    res.json(result);
  } catch (err) {
    console.error('Block error:', err);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// Unblock a user
app.post('/api/users/unblock', requireAuth, async (req, res) => {
  const { blocked_user_id } = req.body;
  if (!blocked_user_id) return res.status(400).json({ error: 'Missing user' });
  
  try {
    await blockOps.unblock(req.session.userId, blocked_user_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblock' });
  }
});

// ===== Push Notifications =====

// Subscribe to push notifications
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  try {
    await pushOps.subscribe(req.session.userId, subscription);
    res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  try {
    await pushOps.removeSubscription(endpoint);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Firebase client config for Firestore realtime listener
app.get('/api/firebase/config', (req, res) => {
  if (FIREBASE_CLIENT_CONFIG) {
    res.json({ enabled: true, ...FIREBASE_CLIENT_CONFIG });
  } else {
    res.json({ enabled: false });
  }
});

// Firebase custom auth token for client-side Firestore onSnapshot
app.get('/api/firebase/token', requireAuth, async (req, res) => {
  if (!firebaseAuth) {
    return res.status(503).json({ error: 'Firebase Auth not configured' });
  }
  try {
    const token = await firebaseAuth.createCustomToken(String(req.session.userId));
    res.json({ token });
  } catch (err) {
    console.error('Firebase custom token error:', err.message);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Get VAPID public key for client
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: vapidPublicKey || null });
});

// Delete a message
app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  const { connection_id } = req.body;
  const result = await messageOps.deleteMessage(req.params.id, req.session.userId, connection_id);
  if (result.error) return res.status(403).json(result);

  if (connection_id) {
    io.to(`chat:${connection_id}`).emit('message-deleted', { messageId: req.params.id });
    connectionEmitter.emit(`update:${connection_id}`, { type: 'messages' });
  }
  res.json(result);
});

// ===== PAGE ROUTES =====

// Serve static HTML files for MPA
const sendHtmlOptions = {
  headers: {
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  }
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'), sendHtmlOptions);
});

app.get('/discover', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'discover.html'), sendHtmlOptions);
});

app.get('/requests', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'requests.html'), sendHtmlOptions);
});

app.get('/messages', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'messages.html'), sendHtmlOptions);
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'), sendHtmlOptions);
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'), sendHtmlOptions);
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

// Scheduled Sweep for Expired Connections & Requests (every 30 minutes to conserve Firebase free-tier quota)
setInterval(async () => {
  try {
    const sweepResult = await connectionOps.sweepExpired();
    const reqSweep = await connectionOps.sweepExpiredRequests();
    if (sweepResult.identityRevealsExpired > 0 || sweepResult.faceRevealsExpired > 0 || reqSweep.expiredCount > 0) {
      console.log(`[Sweep] Expired ${sweepResult.identityRevealsExpired} identity reveals, ${sweepResult.faceRevealsExpired} face reveals, ${reqSweep.expiredCount} pending requests.`);
    }
  } catch (err) {
    console.error('[Sweep Error]', err);
  }
}, 30 * 60 * 1000);






server.listen(PORT, '0.0.0.0', () => {
  const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  console.log(`Delulu Dating App running at ${scheme}://localhost:${PORT}`);
  console.log(`Open your browser to ${scheme}://localhost:${PORT}`);
  console.log('');
  if (!vapidPublicKey) {
    console.log('📢 To enable push notifications, run: npx web-push generate-vapid-keys');
    console.log('   Then set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in your .env');
  }
  console.log('');
  console.log('Demo users (passcode for all is 123456):');
  console.log('  Female: wanderlust_amy, art_vibes, trailblazer, bookish_bee, melody_maker, spice_queen');
  console.log('  Male:   stellar_jay, coffee_leo, pixel_wanderer, green_mind, ocean_soul, zen_master');
});
