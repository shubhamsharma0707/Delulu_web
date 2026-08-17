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

process.on('unhandledRejection', (reason, promise) => {
  pino.error({ reason, promise }, 'Unhandled Promise Rejection');
});
process.on('uncaughtException', (err) => {
  pino.fatal({ err }, 'Uncaught Exception');
});

const { EventEmitter } = require('events');
const connectionEmitter = new EventEmitter();
const userEmitter = new EventEmitter(); // Per-user SSE stream (messages list page)
userEmitter.setMaxListeners(200); // Allow many concurrent user SSE connections

const notificationDispatcher = require('./services/notificationDispatcher');

const session = require('express-session');
const compression = require('compression');
const PgSession = require('connect-pg-simple')(session);
const { RedisStore: RedisSessionStore } = require('connect-redis');
const redisClient = require('./services/redisClient');
const { createFailoverRateLimitStore, FailoverSessionStore } = require('./services/failoverStores');

// Optional shared Redis backend (rate limits + sessions). No-op unless
// REDIS_URL is set; rate limits/sessions fall back to local stores while Redis
// is unavailable (see services/failoverStores.js).
redisClient.initRedis();
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { initializeApp: firebaseInitializeApp, cert } = require('firebase-admin/app');
const { getAuth: getFirebaseAuth } = require('firebase-admin/auth');
const { getDB, seedDemoUsers, userOps, connectionOps, messageOps, otpOps, authTokenOps, invalidateUserCache, reportOps, blockOps, pushOps, createMeetingRoom, normalizeMeetBaseUrl } = require('./database');
const fs = require('fs');
const CircuitBreaker = require('./utils/circuitBreaker');
const EmailQueue = require('./utils/emailQueue');
const { hasForbiddenText, FORBIDDEN_MESSAGE_ERROR } = require('./utils/profanity');

// Circuit breakers for external service isolation
const brevoBreaker = new CircuitBreaker('BrevoEmailAPI', {
  timeoutMs: 10000,      // Abort requests hanging over 10s
  failureThreshold: 10,   // Trip circuit after 10 consecutive failures
  resetTimeoutMs: 10000, // Fast-fail for 10s before probing recovery
  maxConcurrent: 50      // Cap simultaneous outbound email calls
});

// Smooth sudden college signup bursts. Requests wait for a worker instead of
// failing when simultaneous sends exhaust the provider's available capacity.
const verificationEmailQueue = new EmailQueue({
  name: 'VerificationEmail',
  concurrency: Math.min(50, Math.max(1, Number(process.env.BREVO_EMAIL_QUEUE_CONCURRENCY) || 5)),
  maxPending: Number(process.env.BREVO_EMAIL_QUEUE_MAX_PENDING) || 500,
  maxAttempts: 5,
  baseRetryMs: 1000
});

const pushBreaker = new CircuitBreaker('PushNotificationsAPI', {
  timeoutMs: 4000,       // Abort hanging push calls over 4s
  failureThreshold: 5,   // Trip after 5 failures
  resetTimeoutMs: 15000, // Fast-fail push calls for 15s when degraded
  maxConcurrent: 10      // Cap simultaneous push calls
});

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

const PORT = process.env.PORT || 3000;

// Allowed student college email domains for signup & password reset
const ALLOWED_EMAIL_DOMAINS = [
  'rishihood.edu.in', 
  'vitbhopal.ac.in', 
  'nst.rishihood.edu.in', 
  'psy.rishihood.edu.in',
  'som.rishihood.edu.in', 
  'sod.rishihood.edu.in', 
  'soh.rishihood.edu.in'
];

const USERNAME_COOLDOWN_MS = 15 * 24 * 60 * 60 * 1000; // 15 days between username changes

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
} else if (process.env.NODE_ENV === 'production') {
  // The app cannot function without Firestore (users, connections, OTPs), so a
  // production boot without Firebase config is a hard failure unless the
  // operator explicitly opts into the degraded mode.
  if (process.env.REQUIRE_FIREBASE !== 'false') {
    throw new Error('FATAL: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set in production.');
  }
  console.warn('WARNING: Firebase not configured in production (REQUIRE_FIREBASE=false) — core features will fail.');
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

// Enable Gzip/Brotli response compression for JSON, HTML, CSS, JS and text API responses
app.use(compression({
  threshold: 512, // Compress responses above 512 bytes
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Skip compressing Server-Sent Event (SSE) streams to prevent buffering realtime events
    if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
      return false;
    }
    // Avoid double-compressing already-compressed media types (png, jpeg, webp, mp3, mp4, zip, gz, pdf)
    const contentType = res.getHeader('Content-Type') || '';
    if (typeof contentType === 'string' && /image\/(png|jpeg|jpg|webp|gif)|video\/|audio\/|application\/(zip|gzip|x-gzip|pdf)/i.test(contentType)) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// HTTP → HTTPS redirect in production (must run before helmet or any route)
// Skip redirect when testing with supertest (no x-forwarded-proto header expected)
if (process.env.NODE_ENV === 'production' && !process.env.VITEST) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
  });
}

// ── Origin classification for CORS / CSRF ────────────────────────────────────
// Web origins carry the session cookie, so they may use credentials.
// Native origins (Capacitor APK / file:// / null) authenticate with bearer
// tokens only — we deliberately do NOT reflect Access-Control-Allow-Credentials
// for them, which removes the "origin: null + cookie" CSRF vector while keeping
// the Android app fully working (it never sends cookies).
function isNativeAppOrigin(origin) {
  if (!origin) return false;
  return origin.startsWith('capacitor://') ||
    origin.startsWith('ionic://') ||
    origin.startsWith('file://') ||
    origin === 'null';
}

function isWebAppOrigin(origin) {
  if (!origin) return false;
  // Production: explicit APP_URL + Railway / Render hosting domains.
  if (process.env.NODE_ENV === 'production') {
    if (process.env.APP_URL && origin === process.env.APP_URL) return true;
    if (/^https:\/\/.+\.up\.railway\.app$/.test(origin)) return true;
    if (/^https:\/\/.+\.railway\.app$/.test(origin)) return true;
    if (/^https:\/\/.+\.onrender\.com$/.test(origin)) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    return false;
  }
  // Dev/test: localhost variants, Capacitor's http://localhost webview, APP_URL, Railway & Render.
  if (process.env.APP_URL && origin === process.env.APP_URL) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    origin.endsWith('.up.railway.app') ||
    origin.endsWith('.railway.app') ||
    origin.endsWith('.onrender.com') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('https://localhost');
}

function isAllowedOrigin(origin) {
  return isWebAppOrigin(origin) || isNativeAppOrigin(origin);
}

// Custom CORS Middleware to handle credentials and Capacitor/Localhost origins
// Critical for Android APK: Capacitor WebView loads from file:// which sends Origin: null
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Only cookie-carrying web origins may use credentials; native origins use
    // bearer tokens and never receive the credentials allowance.
    if (isWebAppOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Vary', 'Origin');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Security headers via Helmet with Content Security Policy allowlist.
// Runtime dependencies are now bundled locally (compiled Tailwind CSS, vendored
// Dexie and Three.js), so the script-src CDN hosts were removed — the app loads
// no third-party scripts at runtime. Google Fonts stylesheets are the only
// remaining external resource. 'unsafe-inline' remains for the inline
// theme-bootstrapping scripts in every HTML page; the Tailwind Play CDN and its
// 'unsafe-eval' requirement are gone. `http:` is blocked everywhere so the site
// never loads subresources over plaintext.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "blob:", "https:"],
      scriptSrcAttr: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:"],
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
  store: createFailoverRateLimitStore('auth'),
});

// OTP send endpoints (emailing is expensive): 3 sends per hour per email + 10 per
// hour per IP. This keeps an attacker from blasting one target address with reset
// emails or exhausting the email provider quota.
function otpEmailKey(req) {
  if (req.body && typeof req.body.email === 'string' && req.body.email.includes('@')) {
    return `email:${req.body.email.toLowerCase().trim()}`;
  }
  return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`;
}

const otpSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: otpEmailKey,
  message: { error: 'Too many verification emails sent. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('otp-send'),
});

const otpSendIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`,
  message: { error: 'Too many verification emails from this device. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('otp-send-ip'),
});

// OTP verification endpoints: 5 attempts per 10 minutes per email + 10 per IP,
// so a guessed code cannot be brute-forced even if the send limit is bypassed.
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: otpEmailKey,
  message: { error: 'Too many verification attempts. Please try again in 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('otp-verify'),
});

const otpVerifyIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`,
  message: { error: 'Too many verification attempts from this device. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('otp-verify-ip'),
});

// API limits are keyed by authenticated user, not just IP. A college Wi-Fi
// network can put hundreds of students behind one public IP; an IP-only
// limiter would block well-behaved users from one another during an event.
function rateLimitIdentity(req) {
  const userId = Number(req.session?.userId);
  if (Number.isSafeInteger(userId) && userId > 0) return `user:${userId}`;
  return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`;
}

// General API rate limit. Higher unauthenticated limit ensures college campus Wi-Fi
// sharing (single public IP for hundreds of students) does not lock users out.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => Number(req.session?.userId) > 0 ? 300 : 300,
  keyGenerator: rateLimitIdentity,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('api'),
});

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: rateLimitIdentity,
  message: { error: 'You are sending messages too quickly. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('message'),
});

const typingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: rateLimitIdentity,
  message: { error: 'Too many typing updates. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('typing'),
});

const gameLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: rateLimitIdentity,
  message: { error: 'Too many game actions. Please try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('game'),
});

const readReceiptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 24,
  keyGenerator: rateLimitIdentity,
  message: { error: 'Too many read-receipt updates. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('read-receipt'),
});

// Looser limit for discovery routes (swiping/dismissing profiles)
const discoverLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('discover'),
});

// Relationship-state mutations (respond/end/block/report/revoke) — cheap to call
// but each can fan out into batch writes, so cap them.
const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: rateLimitIdentity,
  message: { error: 'Too many actions. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('action'),
});

// Firebase custom-token minting (each call creates a signed token) — keep tight.
const tokenMintLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: rateLimitIdentity,
  message: { error: 'Too many token requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('token-mint'),
});

// ===== In-Memory Session Cache (reduces Firestore reads for frequent session checks) =====
const sessionCache = new Map();
const CACHE_TTL = 30 * 1000; // 30 seconds

// A viewer's Discover order is expensive to build (connections, blocks and
// compatibility ranking). Keep that ordered snapshot briefly, then page it
// with a signed cursor so pressing "View more" never re-runs the Firebase work.
const discoverFeedCache = new Map();
const DISCOVER_FEED_CACHE_TTL = 10 * 60 * 1000;
const DISCOVER_FEED_CACHE_MAX = 500;

function getDiscoverFeedCacheKey(userId, genderFilter) {
  return `${Number(userId)}:${genderFilter || 'all'}`;
}

function getCachedDiscoverFeed(userId, genderFilter) {
  const key = getDiscoverFeedCacheKey(userId, genderFilter);
  const entry = discoverFeedCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp >= DISCOVER_FEED_CACHE_TTL) {
    discoverFeedCache.delete(key);
    return null;
  }
  return entry;
}

function setCachedDiscoverFeed(userId, genderFilter, feed) {
  const key = getDiscoverFeedCacheKey(userId, genderFilter);
  discoverFeedCache.set(key, { ...feed, timestamp: Date.now() });
  if (discoverFeedCache.size > DISCOVER_FEED_CACHE_MAX) {
    const oldestKey = discoverFeedCache.keys().next().value;
    if (oldestKey) discoverFeedCache.delete(oldestKey);
  }
}

function invalidateDiscoverFeed(userId = null) {
  if (userId === null || userId === undefined) {
    discoverFeedCache.clear();
    return;
  }
  const idPrefix = `${Number(userId)}:`;
  for (const key of discoverFeedCache.keys()) {
    if (key.startsWith(idPrefix)) discoverFeedCache.delete(key);
  }
}

function createDiscoverCursor(userId, genderFilter, start) {
  const payload = JSON.stringify({ u: Number(userId), g: genderFilter || 'all', s: start });
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

function readDiscoverCursor(cursor, userId, genderFilter) {
  if (!cursor || typeof cursor !== 'string' || cursor.length > 1024) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('.');
    if (separator < 1) return null;
    const payload = decoded.slice(0, separator);
    const signature = decoded.slice(separator + 1);
    const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

    const data = JSON.parse(payload);
    if (data.u !== Number(userId) || data.g !== (genderFilter || 'all') || !Number.isSafeInteger(data.s) || data.s < 0) return null;
    return data.s;
  } catch (err) {
    return null;
  }
}

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

// ===== Connection Auth Cache (reduces Firestore reads on hot message paths) =====
// Every message send/read/reaction calls connectionOps.getConnection() to verify
// the user belongs to the connection. This cache remembers recent verifications
// so repeated calls within 30 seconds skip the Firestore read entirely.
// Cache is invalidated immediately when connection status changes (end, reveal, etc.)
const connectionAuthCache = new Map();
const CONNECTION_AUTH_TTL = 30 * 1000; // 30 seconds

function getCachedConnectionAuth(connectionId, userId) {
  const key = `${connectionId}:${userId}`;
  const cached = connectionAuthCache.get(key);
  if (cached && Date.now() - cached.timestamp < CONNECTION_AUTH_TTL) {
    return cached.data; // Returns the connection object
  }
  return null;
}

function setCachedConnectionAuth(connectionId, userId, connData) {
  const key = `${connectionId}:${userId}`;
  connectionAuthCache.set(key, { data: connData, timestamp: Date.now() });
  // Hard cap at 2000 entries
  if (connectionAuthCache.size > 2000) {
    const oldest = connectionAuthCache.keys().next().value;
    if (oldest) connectionAuthCache.delete(oldest);
  }
}

function evictConnectionAuth(connectionId) {
  // Evict all cache entries for a given connection (both users)
  for (const [key] of connectionAuthCache) {
    if (key.startsWith(`${connectionId}:`)) {
      connectionAuthCache.delete(key);
    }
  }
}

// Helper to get connection with auth cache — replaces raw getConnection calls
// on hot message paths (send, read, react, delete). Falls back to the full
// getConnection() on cache miss.
async function getCachedConnection(connectionId, userId) {
  const cached = getCachedConnectionAuth(connectionId, userId);
  if (cached) return cached;
  
  const conn = await connectionOps.getConnection(connectionId, userId);
  if (conn && !conn._dataIntegrityError) {
    setCachedConnectionAuth(connectionId, userId, conn);
  }
  return conn;
}

// Session middleware — using memorystore (pure JS, no native compilation)
// ===== Session Store =====
// Precedence:
//   1. REDIS_URL          → Redis (shared across instances) with an in-memory
//                           fallback while Redis is unreachable.
//   2. SUPABASE_DB_URL    → connect-pg-simple with Supabase's Postgres
//                           connection string (persistent across restarts).
//                           Format: postgresql://postgres.<ref>:<password>@...:5432/postgres
//                           Find it at: Supabase Console -> Settings -> Database ->
//                           Connection String -> URI (Session mode port 5432)
//   3. Otherwise          → in-memory store (sessions lost on restart).
let sessionStore;
if (process.env.REDIS_URL) {
  const MemoryStore = require('memorystore')(session);
  const redisSessionStore = new RedisSessionStore({
    client: redisClient.getRedis(),
    prefix: 'sess:'
  });
  sessionStore = new FailoverSessionStore(
    redisSessionStore,
    new MemoryStore({ checkPeriod: 15 * 60 * 1000 })
  );
  console.log('Session store: Redis (shared across instances, with in-memory fallback)');
} else if (process.env.SUPABASE_DB_URL) {
  sessionStore = new PgSession({
    conString: process.env.SUPABASE_DB_URL,
    tableName: 'session',
    createTableIfMissing: true,
    ttl: 30 * 24 * 60 * 60 // 30 days in seconds
  });
  console.log('Session store: Supabase Postgres (persistent across restarts)');

  // Auto-enforce Row Level Security (RLS) & revoke public PostgREST permissions on public.session table
  const { Client } = require('pg');
  const pgClient = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  pgClient.connect().then(async () => {
    try {
      await pgClient.query('ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;');
      await pgClient.query('REVOKE ALL ON TABLE public.session FROM anon, authenticated;');
    } catch (e) {
      // Table may not exist yet on first boot or RLS already active
    }
    try {
      await pgClient.query("ALTER FUNCTION public.set_updated_at() SET search_path = '';");
      await pgClient.query("REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;");
    } catch (e) {
      // Function may not exist or permissions already revoked
    } finally {
      await pgClient.end().catch(() => {});
    }
  }).catch(() => {});
} else {
  // Fallback: in-memory (sessions lost on server restart — users will need to
  // re-login after deploys). In production this silently breaks "stay logged
  // in" and multi-instance scaling, so hard-fail unless explicitly opted out.
  if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_PERSISTENT_SESSIONS !== 'false') {
    throw new Error('FATAL: no persistent session store configured — production requires REDIS_URL or SUPABASE_DB_URL. Set one of them, or REQUIRE_PERSISTENT_SESSIONS=false to run with in-memory sessions.');
  }
  const MemoryStore = require('memorystore')(session);
  sessionStore = new MemoryStore({
    checkPeriod: 15 * 60 * 1000
  });
  console.warn('Session store: MemoryStore (set REDIS_URL or SUPABASE_DB_URL for persistent sessions)');
}

const sessionMiddleware = session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  rolling: true,              // Extend session expiry on every request (keeps active users logged in)
  saveUninitialized: false,   // Don't create sessions for unauthenticated visitors
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — users stay logged in for a month
    httpOnly: true,            // Prevent JS access to cookie (XSS-safe)
    sameSite: 'lax',           // First-party web cookie; Capacitor Android uses bearer tokens, not cookies
    secure: process.env.NODE_ENV === 'production' // HTTPS-only in prod
  }
});

app.use(sessionMiddleware);

// ===== Token-Based Session Fallback (for mobile WebViews & cross-site apps) =====
// Bearer tokens are HMAC-signed over `userId:timestamp:tokenVersion`. token_version
// lives on the user doc and is bumped on logout / password change, so an old token
// stops working immediately (revocation) instead of staying valid for the 30-day TTL.
const TOKEN_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const _tokenVersionCache = new Map(); // userId -> { version, at }
const TOKEN_VERSION_CACHE_TTL = 30 * 1000;

function generateAuthToken(userId, version = 0) {
  const numUserId = Number(userId);
  if (!numUserId) return null;
  const timestamp = Date.now();
  const data = `${numUserId}:${timestamp}:${Number(version) || 0}`;
  const hmac = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(data).digest('hex');
  return `${numUserId}:${timestamp}:${hmac}`;
}

// Token wire format is unchanged (3 colon-separated parts) for backward compatibility
// — token_version is folded into the HMAC, not the payload.
function verifyAuthToken(tokenStr, version = 0) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const parts = tokenStr.split(':');
  if (parts.length !== 3) return null;
  const [userIdStr, timestampStr, signature] = parts;
  const userId = Number(userIdStr);
  const timestamp = Number(timestampStr);
  if (!userId || !timestamp || isNaN(userId) || isNaN(timestamp)) return null;

  if (Date.now() - timestamp > TOKEN_MAX_AGE) return null;

  const v = Number(version) || 0;
  const safeEqual = (sig, expected) => {
    try {
      // Strict comparison: reject non-hex or length-mismatched signatures instead of
      // letting Buffer.from(hex) silently ignore trailing/invalid characters.
      if (typeof sig !== 'string' || typeof expected !== 'string') return false;
      if (sig.length !== expected.length) return false;
      if (!/^[0-9a-f]+$/i.test(sig)) return false;
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch (e) {
      return false;
    }
  };

  // Tokens issued under the account's current token_version
  const currentHmac = crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(`${userIdStr}:${timestampStr}:${v}`).digest('hex');
  if (safeEqual(signature, currentHmac)) return userId;

  // Legacy tokens (issued before token_version existed) were signed without the
  // version suffix. Only accept them while the account is still at version 0 —
  // after a logout or password change the user must re-authenticate.
  if (v === 0) {
    const legacyHmac = crypto.createHmac('sha256', process.env.SESSION_SECRET)
      .update(`${userIdStr}:${timestampStr}`).digest('hex');
    if (safeEqual(signature, legacyHmac)) return userId;
  }
  return null;
}

// ── Short-lived SSE access tokens ───────────────────────────────────────────
// EventSource cannot attach an Authorization header (and Capacitor Android has
// no session cookie), so the client mints a signed, single-purpose token via the
// authenticated API and passes it as a query parameter. The token is bound to
// the user id, expires in 60 seconds, and is signed with SESSION_SECRET — even
// if it appears in logs, it can only open a temporary stream as that user and
// can never be used to read or write account data. The long-lived HMAC bearer
// token is deliberately never placed in an SSE URL.
const SSE_TOKEN_TTL_MS = 60 * 1000;

function generateSSEToken(userId) {
  const numUserId = Number(userId);
  if (!numUserId) return null;
  const expires = Date.now() + SSE_TOKEN_TTL_MS;
  const data = `${numUserId}:${expires}`;
  const hmac = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(data).digest('hex');
  return `${numUserId}:${expires}:${hmac}`;
}

function verifySSEToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const parts = tokenStr.split(':');
  if (parts.length !== 3) return null;
  const [userIdStr, expiresStr, signature] = parts;
  const userId = Number(userIdStr);
  const expires = Number(expiresStr);
  if (!userId || !expires || isNaN(userId) || isNaN(expires)) return null;
  if (Date.now() > expires) return null;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(`${userIdStr}:${expiresStr}`).digest('hex');
  if (typeof signature !== 'string' || signature.length !== expected.length || !/^[0-9a-f]+$/i.test(signature)) return null;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) ? userId : null;
  } catch (e) {
    return null;
  }
}

// Current token_version for a user (short-TTL cache; invalidated on bump).
async function getTokenVersion(userId) {
  const numUserId = Number(userId);
  if (!numUserId) return 0;
  const cached = _tokenVersionCache.get(numUserId);
  if (cached && Date.now() - cached.at < TOKEN_VERSION_CACHE_TTL) return cached.version;
  const user = await userOps.getById(numUserId);
  const version = (user && user.token_version) || 0;
  _tokenVersionCache.set(numUserId, { version, at: Date.now() });
  return version;
}

function bumpTokenVersionCache(userId) {
  _tokenVersionCache.delete(Number(userId));
}

// Token & Session Auth Bridge Middleware (populates req.session.userId from Authorization header if cookie missing)
app.use(async (req, res, next) => {
  try {
    if (!req.session?.userId) {
      const authHeader = req.headers.authorization || req.headers['x-session-token'];
      if (authHeader) {
        const tokenStr = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
        const userIdFromToken = Number(tokenStr.split(':')[0]);
        if (userIdFromToken) {
          const version = await getTokenVersion(userIdFromToken);
          const userId = verifyAuthToken(tokenStr, version);
          if (userId) {
            if (!req.session) req.session = {};
            req.session.userId = userId;
          }
        }
      }
    }
  } catch (e) {
    // Token auth must never break the request pipeline — treat as unauthenticated
  }
  next();
});

// SSE streams are opened by EventSource, which cannot attach an Authorization
// header and (on Capacitor Android) has no session cookie. Accept the short-lived
// signed sse_token query parameter when the session is absent. The token only
// grants a temporary stream; all other API routes keep requiring full auth.
function requireSSEAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  const tokenStr = (typeof req.query.sse_token === 'string' && req.query.sse_token.length <= 256)
    ? req.query.sse_token
    : null;
  const userId = verifySSEToken(tokenStr);
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!req.session) req.session = {};
  req.session.userId = userId;
  next();
}

// Body parsing with explicit size limits so oversized JSON/form payloads are
// rejected by the parser (HTTP 413) before application validation runs. 32kb
// comfortably fits every current endpoint (profile fields, E2EE keys, reports);
// nothing in the app needs more.
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));

// Apply general API rate limiter to all /api/ routes
app.use('/api/', apiLimiter);

// CSRF Sec-Fetch-Site / Origin check — defense-in-depth on top of sameSite: 'lax'
// Android Capacitor APK sends Origin: null for file:// loads — must allow it
// (native origins authenticate with bearer tokens, so no cookie is at risk).
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const requestOrigin = req.get('origin') || req.get('referer') || '';
    if (requestOrigin && (isNativeAppOrigin(requestOrigin) || isWebAppOrigin(requestOrigin))) {
      return next();
    }

    const secFetchSite = req.get('sec-fetch-site');
    // Block cross-site state-changing requests outright if sent by browser
    if (secFetchSite === 'cross-site') {
      return res.status(403).json({ error: 'Cross-origin request blocked' });
    }

    if (requestOrigin) {
      try {
        const originHostname = new URL(requestOrigin).hostname;
        const hostHeader = (req.headers.host || '').split(':')[0];
        if (originHostname !== req.hostname && originHostname !== hostHeader) {
          return res.status(403).json({ error: 'Cross-origin request blocked' });
        }
      } catch (e) {
        // Relative path referer (e.g. '/login.html') is inherently same-origin
        if (requestOrigin.startsWith('/')) {
          return next();
        }
        return res.status(403).json({ error: 'Invalid origin header' });
      }
    }
  }
  next();
});

// Rate-limit the APK download: it is a ~17MB static file with no auth, so an
// attacker could otherwise make the server burn bandwidth and disk I/O on
// repeated downloads.
const apkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
  message: { error: 'Too many APK downloads. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createFailoverRateLimitStore('apk'),
});

// Serve release APK download outside public directory to keep asset bundle lightweight (16MB)
app.get(['/delulu.apk', '/api/download-apk'], apkLimiter, (req, res) => {
  const apkPath = path.join(__dirname, 'builds', 'delulu.apk');
  if (fs.existsSync(apkPath)) {
    res.download(apkPath, 'delulu.apk');
  } else {
    res.status(404).send('APK build not available yet.');
  }
});

// Protect user-uploaded files with authentication
app.use('/uploads', requireAuth);

// Static asset names are not fingerprinted, so a one-year immutable cache would
// keep users on stale client code after a deploy. Keep a short browser cache.
app.use(express.static(path.join(__dirname, 'public'), {
  // index.html is the Capacitor WebView entry (redirects to login.html) — it must
  // NOT be served as the default document at '/'. The '/' route below serves the
  // real landing page (login.html) so the root URL is indexable, not a redirect stub.
  index: false,
  maxAge: '0',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      // HTML is never cached — code updates must be picked up instantly across deploys.
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // JS/CSS: keep correctness (pick up new deploys instantly) but let browsers
      // revalidate cheaply with ETag/Last-Modified (304s) instead of re-downloading
      // 127KB of chat.js on every visit. express.static attaches strong ETags.
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    }
  }
}));

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

// ===== Password policy =====
// Minimum length + common/breached-password rejection so "123456"-style
// credentials can never be set. The HaveIBeenPwned check uses k-anonymity
// (only the first 5 chars of the SHA-1 hash leave the server) and FAILS OPEN
// on network errors, so signup/reset can never be blocked by an outage.
const MIN_PASSWORD_LENGTH = 12;
const COMMON_WEAK_PASSWORDS = new Set([
  '123456','password','12345678','qwerty','123456789','12345','1234567','password1',
  '1234567890','123123','abc123','iloveyou','letmein','admin','welcome','monkey',
  'dragon','master','111111','000000','1234','qwerty123','sunshine','princess',
  'football','baseball','superman','trustno1','delulu','delulu123','college123',
  'password123456','qwerty123456','123456789012'
]);

function isCommonPassword(password) {
  return typeof password === 'string' && COMMON_WEAK_PASSWORDS.has(password.toLowerCase().trim());
}

async function checkPwnedPassword(password, fetcher = null) {
  try {
    const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const doFetch = fetcher || ((url) => fetch(url, { signal: AbortSignal.timeout(2000) }));
    const res = await doFetch(`https://api.pwnedpasswords.com/range/${prefix}`);
    if (!res || !res.ok) return false;
    const body = typeof res.text === 'function' ? await res.text() : String(res.body || '');
    return body.split('\n').some(line => line.trim().split(':')[0].toUpperCase() === suffix);
  } catch (e) {
    return false; // fail-open: never block signup because HIBP is unreachable
  }
}

async function validatePasswordStrength(password, fetcher = null) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (isCommonPassword(password)) {
    return { valid: false, error: 'This password is too common. Please choose a stronger password.' };
  }
  const breached = await checkPwnedPassword(password, fetcher);
  if (breached) {
    return { valid: false, error: 'This password has appeared in known data breaches. Please choose a different one.' };
  }
  return { valid: true, error: null };
}

function sanitizeUser(user) {
  if (!user) return null;
  // Never leak the TOTP secret or the (hashed) backup codes to the client —
  // totp_enabled is fine to expose so the UI can reflect 2FA status.
  const { passcode_hash, totp_secret, totp_backup_codes, ...safeUser } = user;
  if (typeof safeUser.hobbies === 'string') {
    try { safeUser.hobbies = JSON.parse(safeUser.hobbies); } 
    catch(e) { safeUser.hobbies = []; }
  }
  if (safeUser.avatar && typeof safeUser.avatar === 'string') {
    const match = safeUser.avatar.match(/^(male|female)_(\d+)$/);
    if (match) {
      const num = parseInt(match[2], 10);
      if (num < 10 && !match[2].startsWith('0')) {
        safeUser.avatar = `${match[1]}_0${num}`;
      }
    }
  }
  return safeUser;
}

function sanitizeConnection(c, userId) {
  if (!c) return null;
  const isFrom = c.from_user_id === Number(userId);
  
  const copy = { ...c };
  
  // Backward compatibility: map the old reveal_available_at field to the Day-10 face reveal
  const faceRevealAvailable = c.face_reveal_available_at || c.reveal_available_at || null;
  
  // The meeting code (video room) must only ever reach the client after BOTH
  // users complete the Day-10 face reveal — never from legacy documents that
  // still carry an old meeting code.
  const bothFaceRevealed = (c.from_face_reveal || 0) === 1 && (c.to_face_reveal || 0) === 1;
  if (!bothFaceRevealed) {
    delete copy.meeting_code;
  }

  return {
    ...copy,
    face_reveal_available_at: faceRevealAvailable,
    my_face_reveal: isFrom ? c.from_face_reveal || 0 : c.to_face_reveal || 0,
    other_face_reveal: isFrom ? c.to_face_reveal || 0 : c.from_face_reveal || 0,
    both_face_revealed: bothFaceRevealed,
    face_reveal_declined_by_other: isFrom 
      ? c.face_reveal_declined_by === c.to_user_id 
      : c.face_reveal_declined_by === c.from_user_id
  };
}

function requireActiveConnection(conn, res) {
  if (!connectionOps.isActive(conn)) {
    res.status(409).json({ error: 'This chat is no longer active.' });
    return false;
  }
  return true;
}

// Check if user is logged in (with cache)
app.get('/api/session', async (req, res) => {
  try {
    if (req.session && req.session.userId) {
      const cached = getCachedUser(req.session.userId);
      if (cached) {
        req.session.user = cached;
        const token = generateAuthToken(req.session.userId, cached.token_version || 0);
        return res.json({ authenticated: true, user: cached, token });
      }
      
      const user = await userOps.getById(req.session.userId);
      if (user) {
        const safeUser = sanitizeUser(user);
        req.session.user = safeUser;
        setCachedUser(req.session.userId, safeUser);
        const token = generateAuthToken(req.session.userId, user.token_version || 0);
        return res.json({ authenticated: true, user: safeUser, token });
      }
    }
    res.json({ authenticated: false });
  } catch (err) {
    console.error('GET /api/session error:', err);
    res.status(500).json({ error: 'Failed to verify session', details: err.message });
  }
});

// Mint a short-lived SSE access token for EventSource streams. The Android app
// cannot send an Authorization header from EventSource, so it exchanges its
// regular HMAC bearer token for this temporary, single-purpose stream token.
// The long-lived HMAC token is never exposed in a stream URL.
app.get('/api/sse-token', requireAuth, async (req, res) => {
  try {
    const token = generateSSEToken(req.session.userId);
    if (!token) return res.status(500).json({ error: 'Failed to issue stream token' });
    res.json({ token, expires_in_ms: SSE_TOKEN_TTL_MS });
  } catch (err) {
    console.error('GET /api/sse-token error:', err);
    res.status(500).json({ error: 'Failed to issue stream token' });
  }
});

// Helper to send transactional emails via Brevo HTTP API (protected by CircuitBreaker)
async function sendBrevoEmail(email, subject, htmlContent) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured on the server. Please set it in your environment settings (e.g. Railway Variables).');
  }

  return brevoBreaker.execute(async (signal) => {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal, // Enforce 5s AbortSignal timeout
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Delulu', email: process.env.BREVO_SENDER_EMAIL || 'deluluxcollegedating@gmail.com' },
        to: [{ email }],
        subject,
        htmlContent
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const error = new Error(errData.message || `Brevo API error: ${response.status}`);
      error.status = response.status;
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        error.retryAfterMs = retryAfterSeconds * 1000;
      }
      throw error;
    }
    return response.json();
  });
}

// ===== AUTH ROUTES =====

// Send verification email with 6-digit OTP and secure link token
app.post('/api/auth/send-verification-email', otpSendLimiter, otpSendIpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email address is required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const domain = cleanEmail.split('@')[1];

  if (!domain || !ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    return res.status(400).json({ 
      error: `Only official college emails are allowed (${ALLOWED_EMAIL_DOMAINS.join(', ')})` 
    });
  }

  try {
    const otp = await otpOps.generate(cleanEmail);
    
    // Generate a 1-hour verification token for direct link login. The token is
    // also persisted (hashed) so it can only be redeemed once — see authTokenOps.
    const tokenPayload = `${cleanEmail}:${Date.now() + 3600000}`;
    const token = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(tokenPayload).digest('hex');
    const fullToken = Buffer.from(`${tokenPayload}:${token}`).toString('base64url');
    await authTokenOps.create(cleanEmail, fullToken).catch(err => {
      console.error('Failed to persist verify token (link will be replayable this cycle):', err.message);
    });

    const appUrl = process.env.APP_URL || 
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 
      (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : 'https://delulu-app-main-production.up.railway.app'));
    const verifyLink = `${appUrl}/login.html?token=${encodeURIComponent(fullToken)}`;

    const htmlContent = `
      <div style="font-family: 'Plus Jakarta Sans', sans-serif, system-ui; max-width: 500px; margin: 0 auto; padding: 24px; background: #fbf9f8; border-radius: 20px; border: 1px solid #dec0ba;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #a53b29; margin: 0; font-size: 28px;">Delulu</h1>
          <p style="color: #57423e; font-size: 14px; margin-top: 4px;">Verify your college email</p>
        </div>
        
        <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e4e2e1; text-align: center;">
          <p style="font-size: 14px; color: #1b1c1c; margin-top: 0;">Your 6-digit verification code is:</p>
          <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #a53b29; margin: 16px 0; font-family: monospace;">${otp}</div>
          <p style="font-size: 12px; color: #8b716d;">Code expires in 10 minutes.</p>
          
          <hr style="border: none; border-top: 1px solid #e4e2e1; margin: 20px 0;" />
          
          <p style="font-size: 14px; color: #1b1c1c;">Or click the button below to verify instantly:</p>
          <a href="${verifyLink}" style="display: inline-block; background: #a53b29; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 12px; font-weight: 700; font-size: 14px; margin-top: 8px;">Verify & Continue</a>
        </div>
      </div>
    `;

    await verificationEmailQueue.enqueue(() =>
      sendBrevoEmail(cleanEmail, `${otp} is your Delulu verification code`, htmlContent)
    );
    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    console.error('Brevo Email Error:', err);
    res.status(500).json({ error: err.message || 'Failed to send verification email. Please try again.' });
  }
});

// Verify 6-digit OTP code
app.post('/api/auth/verify-otp', otpVerifyLimiter, otpVerifyIpLimiter, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const valid = await otpOps.verify(cleanEmail, String(otp).trim());
  if (!valid) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  // Save in session
  req.session.pendingEmail = cleanEmail;
  let token = null;

  // Check if user already exists
  const user = await userOps.getByEmail(cleanEmail);
  if (user) {
    req.session.userId = user.id;
    req.session.user = sanitizeUser(user);
    setCachedUser(user.id, req.session.user);
    token = generateAuthToken(user.id, user.token_version || 0);
  }
  await new Promise((resolve) => req.session.save(resolve));

  res.json({
    success: true,
    isNewUser: !user,
    user: req.session.user || null,
    token,
    email: cleanEmail
  });
});

// Verify direct email link token
app.post('/api/auth/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [cleanEmail, expiresStr] = decoded.split(':');
    const expires = Number(expiresStr);

    if (!cleanEmail || !Number.isFinite(expires)) {
      return res.status(400).json({ error: 'Invalid verification link' });
    }
    if (Date.now() > expires) {
      return res.status(400).json({ error: 'Verification link has expired' });
    }

    // Single-use redemption: the link is consumed atomically on first use, so a
    // replayed or shared link can never log in a second time.
    const redeemed = await authTokenOps.consume(cleanEmail, token);
    if (!redeemed) {
      return res.status(400).json({ error: 'Verification link is invalid or has already been used' });
    }

    // Save in session
    req.session.pendingEmail = cleanEmail;
    let authToken = null;

    // Check if user already exists
    const user = await userOps.getByEmail(cleanEmail);
    if (user) {
      req.session.userId = user.id;
      req.session.user = sanitizeUser(user);
      setCachedUser(user.id, req.session.user);
      authToken = generateAuthToken(user.id, user.token_version || 0);
    }
    await new Promise((resolve) => req.session.save(resolve));

    res.json({
      success: true,
      isNewUser: !user,
      user: req.session.user || null,
      token: authToken,
      email: cleanEmail
    });
  } catch (err) {
    console.error('Verify token error:', err);
    res.status(500).json({ error: 'Failed to verify token' });
  }
});

// Send password reset email (OTP + secure reset link) to a registered student email
app.post('/api/auth/send-password-reset', otpSendLimiter, otpSendIpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email address is required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const domain = cleanEmail.split('@')[1];
  if (!domain || !ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    return res.status(400).json({ error: `Only official college emails are allowed (${ALLOWED_EMAIL_DOMAINS.join(', ')})` });
  }

  try {
    const user = await userOps.getByEmail(cleanEmail);
    if (!user) {
      // Anti-enumeration: return the same success payload as a real send; no
      // email is actually dispatched for unknown addresses.
      return res.json({ success: true, message: 'If an account exists for this email, a password reset email has been sent.' });
    }

    const otp = await otpOps.generate(cleanEmail);

    // Generate a 1-hour reset token for the direct link flow. Persisted (hashed)
    // so the link can only be redeemed once — see authTokenOps.
    const tokenPayload = `${cleanEmail}:${Date.now() + 3600000}`;
    const token = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(tokenPayload).digest('hex');
    const fullToken = Buffer.from(`${tokenPayload}:${token}`).toString('base64url');
    await authTokenOps.create(cleanEmail, fullToken).catch(err => {
      console.error('Failed to persist reset token (link will be replayable this cycle):', err.message);
    });

    const appUrl = process.env.APP_URL || 
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 
      (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : 'https://delulu-app-main-production.up.railway.app'));
    const resetLink = `${appUrl}/login.html?reset=1&token=${encodeURIComponent(fullToken)}&email=${encodeURIComponent(cleanEmail)}`;

    const htmlContent = `
      <div style="font-family: 'Plus Jakarta Sans', sans-serif, system-ui; max-width: 500px; margin: 0 auto; padding: 24px; background: #fbf9f8; border-radius: 20px; border: 1px solid #dec0ba;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #a53b29; margin: 0; font-size: 28px;">Delulu</h1>
          <p style="color: #57423e; font-size: 14px; margin-top: 4px;">Reset your password</p>
        </div>
        
        <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e4e2e1; text-align: center;">
          <p style="font-size: 14px; color: #1b1c1c; margin-top: 0;">Your 6-digit reset code is:</p>
          <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #a53b29; margin: 16px 0; font-family: monospace;">${otp}</div>
          <p style="font-size: 12px; color: #8b716d;">Code expires in 10 minutes.</p>
          
          <hr style="border: none; border-top: 1px solid #e4e2e1; margin: 20px 0;" />
          
          <p style="font-size: 14px; color: #1b1c1c;">Or click the button below to set a new password instantly:</p>
          <a href="${resetLink}" style="display: inline-block; background: #a53b29; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 12px; font-weight: 700; font-size: 14px; margin-top: 8px;">Reset Password</a>
        </div>
      </div>
    `;

    await sendBrevoEmail(cleanEmail, `${otp} is your Delulu password reset code`, htmlContent);
    res.json({ success: true, message: 'Password reset email sent' });
  } catch (err) {
    console.error('Brevo password reset error:', err);
    res.status(500).json({ error: err.message || 'Failed to send password reset email. Please try again.' });
  }
});

// Reset password after verifying ownership via OTP or the signed reset link token
app.post('/api/auth/reset-password', otpVerifyLimiter, otpVerifyIpLimiter, async (req, res) => {
  const { email, otp, token, newPassword, encrypted_private_key } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email address is required' });
  }
  const pwStrength = await validatePasswordStrength(newPassword);
  if (!pwStrength.valid) {
    return res.status(400).json({ error: pwStrength.error });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    // Authorize the request with either a valid OTP or a single-use reset link token
    let verified = false;
    if (token && typeof token === 'string') {
      try {
        const decoded = Buffer.from(token, 'base64url').toString('utf8');
        const [tokenEmail] = decoded.split(':');
        if (tokenEmail === cleanEmail) {
          verified = await authTokenOps.consume(cleanEmail, token);
        }
      } catch (e) {
        verified = false;
      }
    } else if (otp && typeof otp === 'string') {
      verified = await otpOps.verify(cleanEmail, otp.trim());
    }

    if (!verified) {
      return res.status(401).json({ error: 'Invalid or expired verification code / link' });
    }

    const user = await userOps.getByEmail(cleanEmail);
    if (!user) {
      // Generic message — never confirm whether an email has an account.
      return res.status(401).json({ error: 'Invalid or expired verification code / link' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await userOps.update(user.id, {
      passcode_hash: passwordHash,
      encrypted_private_key: encrypted_private_key || undefined
    });

    // Clear session/DB caches so subsequent requests see the fresh password
    invalidateCache(user.id);
    invalidateUserCache(user.id);

    // Password changed → every previously issued token is now invalid
    await userOps.bumpTokenVersion(user.id);
    bumpTokenVersionCache(user.id);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
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
    
    if (user && user.passcode_hash) {
      match = await bcrypt.compare(password, user.passcode_hash);
    } else {
      // Execute dummy compare to match processor runtime cycles
      await bcrypt.compare(password, DUMMY_HASH);
    }

    if (!user || !match || !user.id) {
      return res.status(401).json({ error: 'Incorrect username/email or password' });
    }

    req.session.userId = user.id;
    const safeUser = sanitizeUser(user);
    req.session.user = safeUser;
    setCachedUser(user.id, safeUser);
    const token = generateAuthToken(user.id, user.token_version || 0);
    await new Promise((resolve) => req.session.save(resolve));

    // Legacy accounts may predate the 12-char password policy. They can still
    // sign in, but we surface a gentle nudge so the weak credential gets
    // upgraded instead of living forever.
    const passwordUpgradeRequired = typeof password === 'string' && password.length < MIN_PASSWORD_LENGTH;
    res.json({ success: true, user: safeUser, token, password_upgrade_required: passwordUpgradeRequired || undefined });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
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
    const pwStrength = await validatePasswordStrength(password);
    if (!pwStrength.valid) {
      return res.status(400).json({ error: pwStrength.error });
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
    let userId;
    try {
      userId = await userOps.createWithEmail(
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
    } catch (createErr) {
      // Atomic username reservation (see userOps.createWithEmail) may reject a
      // race between two users grabbing the same name.
      if (createErr && createErr.code === 'username_taken') {
        return res.status(400).json({ error: 'Username already taken' });
      }
      throw createErr;
    }
    
    req.session.userId = Number(userId);
    delete req.session.pendingEmail;

    const user = await userOps.getById(userId);
    const safeUser = sanitizeUser(user);
    req.session.user = safeUser;
    setCachedUser(Number(userId), safeUser);
    const token = generateAuthToken(userId, user.token_version || 0);
    await new Promise((resolve) => req.session.save(resolve));
    res.json({ success: true, user: safeUser, token });
  } catch (err) {
    console.error('Complete profile error:', err);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// Logout
app.post('/api/users/logout', async (req, res) => {
  const userId = req.session?.userId;
  if (userId) {
    invalidateCache(userId);
    invalidateUserCache && invalidateUserCache(userId);
    // Revoke outstanding bearer tokens so a stolen token dies with the session
    // instead of remaining valid for the rest of its 30-day TTL.
    await userOps.bumpTokenVersion(userId).catch(() => {});
    bumpTokenVersionCache(userId);
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
  // Avatar is only ever a preset key like "female_01"; reject anything that is
  // not a preset (no arbitrary URLs / file paths can be stored as an avatar).
  if (avatar !== undefined && avatar !== null && typeof avatar !== 'string') {
    return res.status(400).json({ error: 'Invalid avatar' });
  }
  if (typeof avatar === 'string' && avatar.trim() !== '' && !/^(male|female)_\d{1,2}$/.test(avatar.trim())) {
    return res.status(400).json({ error: 'Invalid avatar' });
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
  // A changed bio/avatar/hobby can affect profile details and compatibility
  // ordering in any viewer's cached Discover feed.
  invalidateDiscoverFeed();
  res.json({ success: true, user: safeUser });
});

// ===== SETTINGS & FORGOT PASSWORD ROUTES =====

// 1. Get user settings status (15-day cooldown calculation, username, email)
app.get('/api/settings/user-info', requireAuth, async (req, res) => {
  try {
    const user = await userOps.getById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const COOLDOWN_DAYS = 15;
    const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    let canChangeUsername = true;
    let daysRemaining = 0;
    let nextAllowedAt = null;

    if (user.username_changed_at) {
      const lastChanged = new Date(user.username_changed_at).getTime();
      const elapsed = Date.now() - lastChanged;
      if (elapsed < COOLDOWN_MS) {
        canChangeUsername = false;
        daysRemaining = Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
        nextAllowedAt = new Date(lastChanged + COOLDOWN_MS).toISOString();
      }
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email || null,
      username_changed_at: user.username_changed_at || null,
      can_change_username: canChangeUsername,
      days_remaining: daysRemaining,
      next_allowed_at: nextAllowedAt
    });
  } catch (err) {
    console.error('Get user settings error:', err);
    res.status(500).json({ error: 'Failed to load user settings' });
  }
});

// 2. Check username availability
app.post('/api/settings/check-username', requireAuth, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const usernameStr = String(username).trim();
  if (usernameStr.length < 3 || usernameStr.length > 20) {
    return res.json({ available: false, message: 'Must be between 3 and 20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(usernameStr)) {
    return res.json({ available: false, message: 'Letters, numbers, and underscores only' });
  }

  const taken = await userOps.isUsernameTaken(usernameStr, req.session.userId);
  if (taken) {
    return res.json({ available: false, message: 'Username is already taken' });
  }
  res.json({ available: true, message: 'Username is available!' });
});

// 3. Update username (Enforces 15-day restriction & uniqueness)
app.post('/api/settings/update-username', requireAuth, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const usernameStr = String(username).trim();
  if (usernameStr.length < 3 || usernameStr.length > 20) {
    return res.status(400).json({ error: 'Username must be between 3 and 20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(usernameStr)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  }

  try {
    const user = await userOps.getById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.username === usernameStr) {
      return res.status(400).json({ error: 'New username is the same as current username' });
    }

    // Enforce 15-day cooldown
    const COOLDOWN_DAYS = 15;
    const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    if (user.username_changed_at) {
      const lastChanged = new Date(user.username_changed_at).getTime();
      const elapsed = Date.now() - lastChanged;
      if (elapsed < COOLDOWN_MS) {
        const daysRemaining = Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
        const unlockDate = new Date(lastChanged + COOLDOWN_MS).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return res.status(400).json({ 
          error: `Username can only be changed once every 15 days. You can change it again on ${unlockDate} (${daysRemaining} day${daysRemaining > 1 ? 's' : ''} remaining).` 
        });
      }
    }

    // The pre-check above gives instant UX feedback; changeUsernameAtomic is the
    // race-proof backstop (transactional reservation swap).
    try {
      await userOps.changeUsernameAtomic(user.id, usernameStr);
    } catch (changeErr) {
      if (changeErr && changeErr.code === 'username_taken') {
        return res.status(400).json({ error: 'Username is already taken by another user' });
      }
      throw changeErr;
    }

    const changedAt = new Date().toISOString();

    // Invalidate caches & update session
    invalidateCache(user.id);
    invalidateUserCache && invalidateUserCache(user.id);
    // A changed username appears in other viewers' cached Discover feeds
    invalidateDiscoverFeed();
    if (req.session.user) {
      req.session.user.username = usernameStr;
    }

    res.json({
      success: true,
      message: 'Username updated successfully!',
      username: usernameStr,
      username_changed_at: changedAt
    });
  } catch (err) {
    console.error('Update username error:', err);
    res.status(500).json({ error: 'Failed to update username. Please try again.' });
  }
});

// 4. Send Password Reset OTP for logged-in user in Settings
app.post('/api/settings/password-reset/send-code', requireAuth, otpSendLimiter, otpSendIpLimiter, async (req, res) => {
  try {
    const user = await userOps.getById(req.session.userId);
    if (!user || !user.email) {
      return res.status(400).json({ error: 'No verified email associated with your account' });
    }

    const cleanEmail = user.email.trim().toLowerCase();
    const otp = await otpOps.generate(cleanEmail);

    const htmlContent = `
      <div style="font-family: 'Plus Jakarta Sans', sans-serif, system-ui; max-width: 500px; margin: 0 auto; padding: 24px; background: #fbf9f8; border-radius: 20px; border: 1px solid #dec0ba;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #a53b29; margin: 0; font-size: 28px;">Delulu</h1>
          <p style="color: #57423e; font-size: 14px; margin-top: 4px;">Password Reset Request</p>
        </div>
        
        <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e4e2e1; text-align: center;">
          <p style="font-size: 14px; color: #1b1c1c; margin-top: 0;">Your 6-digit password reset code is:</p>
          <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #a53b29; margin: 16px 0; font-family: monospace;">${otp}</div>
          <p style="font-size: 12px; color: #8b716d;">Code expires in 10 minutes. Do not share this code with anyone.</p>
        </div>
      </div>
    `;

    await sendBrevoEmail(cleanEmail, `${otp} is your Delulu password reset code`, htmlContent);
    res.json({ success: true, message: `Verification code sent to ${cleanEmail}` });
  } catch (err) {
    console.error('Send reset OTP error:', err);
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

// 5. Verify OTP & Update Password in Settings
app.post('/api/settings/password-reset/verify-and-update', requireAuth, otpVerifyLimiter, otpVerifyIpLimiter, async (req, res) => {
  const { otp, newPassword, encrypted_private_key, public_key } = req.body;
  if (!otp || !newPassword) {
    return res.status(400).json({ error: 'Verification code and new password are required' });
  }
  const pwStrength = await validatePasswordStrength(newPassword);
  if (!pwStrength.valid) {
    return res.status(400).json({ error: pwStrength.error });
  }

  try {
    const user = await userOps.getById(req.session.userId);
    if (!user || !user.email) {
      return res.status(400).json({ error: 'No verified email found for this user' });
    }

    const cleanEmail = user.email.trim().toLowerCase();
    const valid = await otpOps.verify(cleanEmail, String(otp).trim());
    if (!valid) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    // Re-encrypt the E2EE private key with the new password when the client supplies
    // it — otherwise the DB copy stays locked to the old password forever.
    await userOps.update(user.id, {
      passcode_hash: passwordHash,
      ...(encrypted_private_key ? { encrypted_private_key } : {}),
      ...(public_key ? { public_key } : {})
    });

    invalidateCache(user.id);
    invalidateUserCache && invalidateUserCache(user.id);

    // Password changed → revoke tokens issued under the old password
    await userOps.bumpTokenVersion(user.id);
    bumpTokenVersionCache(user.id);

    res.json({ success: true, message: 'Password updated successfully!' });
  } catch (err) {
    console.error('Settings password update error:', err);
    res.status(500).json({ error: 'Failed to update password. Please try again.' });
  }
});

// 6. Public Forgot Password: Send Code (Login Page)
app.post('/api/auth/forgot-password/send-code', otpSendLimiter, otpSendIpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  try {
    const user = await userOps.getByEmail(cleanEmail);
    if (!user) {
      // Anti-enumeration: pretend success; no email is dispatched for unknown addresses.
      return res.json({ success: true, message: 'If an account exists for this email, a verification code has been sent.' });
    }

    const otp = await otpOps.generate(cleanEmail);
    const htmlContent = `
      <div style="font-family: 'Plus Jakarta Sans', sans-serif, system-ui; max-width: 500px; margin: 0 auto; padding: 24px; background: #fbf9f8; border-radius: 20px; border: 1px solid #dec0ba;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #a53b29; margin: 0; font-size: 28px;">Delulu</h1>
          <p style="color: #57423e; font-size: 14px; margin-top: 4px;">Password Reset Request</p>
        </div>
        
        <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e4e2e1; text-align: center;">
          <p style="font-size: 14px; color: #1b1c1c; margin-top: 0;">Your 6-digit password reset code is:</p>
          <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #a53b29; margin: 16px 0; font-family: monospace;">${otp}</div>
          <p style="font-size: 12px; color: #8b716d;">Code expires in 10 minutes. Do not share this code with anyone.</p>
        </div>
      </div>
    `;

    await sendBrevoEmail(cleanEmail, `${otp} is your Delulu password reset code`, htmlContent);
    res.json({ success: true, message: `Verification code sent to ${cleanEmail}` });
  } catch (err) {
    console.error('Forgot password send-code error:', err);
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

// 7. Public Forgot Password: Verify Code & Reset Password & Log In (Login Page)
app.post('/api/auth/forgot-password/reset', otpVerifyLimiter, otpVerifyIpLimiter, async (req, res) => {
  const { email, otp, newPassword, encrypted_private_key, public_key } = req.body;
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Email, verification code, and new password are required' });
  }
  const pwStrength = await validatePasswordStrength(newPassword);
  if (!pwStrength.valid) {
    return res.status(400).json({ error: pwStrength.error });
  }

  const cleanEmail = email.trim().toLowerCase();
  try {
    const user = await userOps.getByEmail(cleanEmail);
    const valid = user ? await otpOps.verify(cleanEmail, String(otp).trim()) : false;
    if (!valid) {
      // Generic message — never confirm whether an email has an account.
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    // Re-encrypt the E2EE private key with the new password when the client supplies
    // it — otherwise the DB copy stays locked to the old password forever.
    await userOps.update(user.id, {
      passcode_hash: passwordHash,
      ...(encrypted_private_key ? { encrypted_private_key } : {}),
      ...(public_key ? { public_key } : {})
    });

    // BUG FIX: Clear stale session cache BEFORE writing new one, then also
    // invalidate the Firestore user cache so login reads the fresh password hash
    invalidateCache(user.id);
    invalidateUserCache && invalidateUserCache(user.id);

    // Password changed → revoke tokens issued under the old password, then issue
    // a fresh one for the auto-login below.
    await userOps.bumpTokenVersion(user.id);
    bumpTokenVersionCache(user.id);

    // Auto log-in user after successful reset
    req.session.userId = user.id;
    const freshUser = await userOps.getById(user.id);
    const safeUser = sanitizeUser(freshUser || user);
    req.session.user = safeUser;
    setCachedUser(user.id, safeUser);
    const token = generateAuthToken(user.id, (freshUser || user).token_version || 0);
    await new Promise((resolve) => req.session.save(resolve));

    res.json({ success: true, message: 'Password updated successfully! Logging you in...', token, user: safeUser });
  } catch (err) {
    console.error('Forgot password reset error:', err);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

// Discover profiles (cursor-paginated — 15 per page by default)
app.get('/api/discover', requireAuth, async (req, res) => {
  try {
    // Cursor is bound to the signed-in user and selected filter, preventing
    // tampering while allowing a feed cache to be safely rebuilt after expiry.
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const rawGender = req.query.gender;
    const genderFilter = (rawGender === 'male' || rawGender === 'female') ? rawGender : null;
    const hasCursor = typeof req.query.cursor === 'string' && req.query.cursor.length > 0;
    const start = hasCursor ? readDiscoverCursor(req.query.cursor, req.session.userId, genderFilter) : 0;
    if (hasCursor && start === null) {
      return res.status(400).json({ error: 'Invalid discover continuation. Please refresh the feed.' });
    }

    let feed = getCachedDiscoverFeed(req.session.userId, genderFilter);
    if (!feed) {
      const user = await userOps.getById(req.session.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      // This Firebase-backed work runs once per viewer/filter cache window,
      // rather than once for every continuation page.
      const excludeIds = await connectionOps.getConnectedUserIds(req.session.userId);
      const result = await userOps.getDiscoverable(req.session.userId, genderFilter, excludeIds);
      const profiles = (result && result.profiles) || [];
      let userHobbies = [];
      try {
        userHobbies = Array.isArray(user.hobbies) ? user.hobbies : JSON.parse(user.hobbies || '[]');
      } catch (e) {
        userHobbies = [];
      }
      const userHobbiesLower = userHobbies.map(h => String(h).toLowerCase());

      const mappedProfiles = profiles.map(p => {
        let profileHobbies = [];
        try {
          profileHobbies = Array.isArray(p.hobbies) ? p.hobbies : JSON.parse(p.hobbies || '[]');
        } catch (e) {
          profileHobbies = [];
        }
        const profileHobbiesLower = profileHobbies.map(h => String(h).toLowerCase());
        const matchingHobbiesLower = userHobbiesLower.filter(h => profileHobbiesLower.includes(h));
        const matchingHobbies = matchingHobbiesLower.map(lh => userHobbies[userHobbiesLower.indexOf(lh)] || lh);
        const matchCount = matchingHobbies.length;

        const avatarStr = (p.avatar && typeof p.avatar === 'string') ? p.avatar : null;
        const genderStr = p.gender || 'other';

        return {
          id: p.id,
          username: p.username || 'Student',
          bio: p.bio || '',
          hobbies: profileHobbies,
          matching_hobbies: matchingHobbies,
          match_count: matchCount,
          avatar: {
            idle: avatarStr ? (() => {
              const match = avatarStr.match(/^(male|female)_(\d+)$/);
              if (match) {
                const num = parseInt(match[2], 10);
                if (num < 10 && !match[2].startsWith('0')) {
                  return `/avatars/${genderStr}/${match[1]}_0${num}/idle.png`;
                }
              }
              return `/avatars/${genderStr}/${avatarStr}/idle.png`;
            })() : null,
            wave: avatarStr ? (() => {
              const match = avatarStr.match(/^(male|female)_(\d+)$/);
              if (match) {
                const num = parseInt(match[2], 10);
                if (num < 10 && !match[2].startsWith('0')) {
                  return `/avatars/${genderStr}/${match[1]}_0${num}/wave.png`;
                }
              }
              return `/avatars/${genderStr}/${avatarStr}/wave.png`;
            })() : null
          },
          gender: genderStr
        };
      });

      mappedProfiles.sort((a, b) => {
        if (b.match_count !== a.match_count) return b.match_count - a.match_count;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
      feed = { profiles: mappedProfiles };
      setCachedDiscoverFeed(req.session.userId, genderFilter, feed);
    }

    const paginatedProfiles = feed.profiles.slice(start, start + limit);
    const totalCount = feed.profiles.length;
    const hasMore = start + limit < totalCount;
    const nextCursor = hasMore ? createDiscoverCursor(req.session.userId, genderFilter, start + limit) : null;

    res.json({
      profiles: paginatedProfiles,
      page: Math.floor(start / limit) + 1,
      limit,
      hasMore,
      nextCursor,
      totalCount
    });
  } catch (err) {
    console.error('GET /api/discover error:', err);
    res.status(500).json({ error: 'Failed to load discover feed', details: err.message });
  }
});

// Send connection request
app.post('/api/connections/request', requireAuth, discoverLimiter, async (req, res) => {
  const { to_user_id } = req.body;
  if (!Number.isSafeInteger(Number(to_user_id)) || Number(to_user_id) < 1) return res.status(400).json({ error: 'Invalid target user' });
  if (Number(to_user_id) === req.session.userId) return res.status(400).json({ error: 'Cannot request yourself' });

  const user = await userOps.getById(req.session.userId);
  const target = await userOps.getById(to_user_id);
  if (!user || !target) return res.status(404).json({ error: 'User not found' });

  // Gender restriction removed — any user can connect with any user.
  // The discover page filter is purely a UI preference, not enforced server-side.

  const result = await connectionOps.sendRequest(req.session.userId, to_user_id);
  if (result.error) return res.status(400).json(result);
  invalidateDiscoverFeed(req.session.userId);
  invalidateDiscoverFeed(to_user_id);
  
  // Notify the target user about the connection request
  sendPushNotification(to_user_id, 'New Connection Request', `${user.username} wants to connect with you!`, '/requests.html', 'connection_request', null);
  
  res.json(result);
});

// Dismiss/skip profile
app.post('/api/connections/dismiss', requireAuth, discoverLimiter, async (req, res) => {
  const { to_user_id } = req.body;
  if (!to_user_id) return res.status(400).json({ error: 'Missing target user' });
  
  const result = await connectionOps.dismiss(req.session.userId, to_user_id);
  invalidateDiscoverFeed(req.session.userId);
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
app.post('/api/connections/respond', requireAuth, actionLimiter, async (req, res) => {
  const { connection_id, action } = req.body;
  if (!connection_id || !['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const result = await connectionOps.respond(connection_id, req.session.userId, action);
  if (result.error) return res.status(400).json(result);
  invalidateDiscoverFeed(req.session.userId);
  
  // Emit match-celebration event to the requester when their request is accepted
  if (action === 'accept') {
    const conn = await connectionOps.getConnectionById(connection_id);
    if (conn) {
      invalidateDiscoverFeed(conn.from_user_id);
      const accepter = await userOps.getById(req.session.userId);
      const requester = await userOps.getById(conn.from_user_id);
      if (accepter && requester) {
        userEmitter.emit(`user:${conn.from_user_id}`, {
          type: 'match_celebration',
          connectionId: Number(connection_id),
          username: accepter.username,
          avatar: accepter.avatar
        });
        
        // Notify requester via push
        sendPushNotification(conn.from_user_id, 'Connection Accepted!', `${accepter.username} accepted your request!`, '/chat.html?id=' + connection_id, 'connection_accepted', connection_id);
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
  invalidateDiscoverFeed(req.session.userId);
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

// ===== In-Memory Presence & Typing Tracking (0% DB cost) =====
const activeRoomUsers = new Map(); // connectionId -> Set<userId>

// ── SSE connection caps ─────────────────────────────────────────────────────
// Each open SSE stream holds a socket, an EventEmitter listener and a heartbeat
// interval, so a malicious or careless client can exhaust server resources by
// opening many of them. Cap per user and per IP; excess connections get 429.
//
// The per-user cap is the real protection against tab explosion / one-account
// floods and stays tight. The per-IP cap must stay HIGH: campus WiFi NATs every
// student behind one public IP, so a low hardcoded value (e.g. 20) would refuse
// the 21st concurrent student with a 429. Both caps are env-tunable so ops can
// raise MAX_SSE_PER_IP further if a single NAT carries more concurrent students
// (the distributed load test is the check that finds this).
function resolveSseCap(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
const MAX_SSE_PER_USER = resolveSseCap(process.env.MAX_SSE_PER_USER, 5);
const MAX_SSE_PER_IP = resolveSseCap(process.env.MAX_SSE_PER_IP, 500);
const _sseCounts = new Map(); // key -> count

function trackSSEConnection(key, max) {
  const count = _sseCounts.get(key) || 0;
  if (count >= max) return false;
  _sseCounts.set(key, count + 1);
  return true;
}

function releaseSSEConnection(key) {
  const count = _sseCounts.get(key) || 0;
  if (count <= 1) _sseCounts.delete(key);
  else _sseCounts.set(key, count - 1);
}

function addRoomPresence(connectionId, userId) {
  const roomKey = String(connectionId);
  const set = activeRoomUsers.get(roomKey) || new Set();
  set.add(Number(userId));
  activeRoomUsers.set(roomKey, set);

  // Broadcast presence event to connection stream
  connectionEmitter.emit(`update:${connectionId}`, {
    type: 'presence',
    userId: Number(userId),
    status: 'online',
    onlineUserIds: Array.from(set)
  });
}

function removeRoomPresence(connectionId, userId) {
  const roomKey = String(connectionId);
  const set = activeRoomUsers.get(roomKey);
  if (!set) return;
  set.delete(Number(userId));
  if (set.size === 0) {
    activeRoomUsers.delete(roomKey);
  }

  connectionEmitter.emit(`update:${connectionId}`, {
    type: 'presence',
    userId: Number(userId),
    status: 'offline',
    onlineUserIds: Array.from(set || [])
  });
}

// SSE Endpoint for real-time game/status/typing/presence updates
app.get('/api/connections/:id/stream', requireSSEAuth, async (req, res) => {
  const connectionId = req.params.id;
  const userId = req.session.userId;

  // Enforce per-user/per-IP connection caps before any DB work.
  const userKey = `u:${userId}`;
  const ipKey = `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`;
  if (!trackSSEConnection(userKey, MAX_SSE_PER_USER)) {
    return res.status(429).json({ error: 'Too many open connections. Please close other chat tabs.' });
  }
  if (!trackSSEConnection(ipKey, MAX_SSE_PER_IP)) {
    releaseSSEConnection(userKey);
    return res.status(429).json({ error: 'Too many open connections from this device.' });
  }
  const releaseSSE = () => { releaseSSEConnection(userKey); releaseSSEConnection(ipKey); };

  // Verify that the connection exists and the user belongs to it
  const conn = await connectionOps.getConnection(connectionId, userId);
  if (!conn || conn._dataIntegrityError) {
    releaseSSE();
    return res.status(404).end();
  }

  // Set SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
  }
  
  // Send initial connection verification comment
  res.write(': ok\n\n');

  // Register in-memory room presence (0 DB cost)
  addRoomPresence(connectionId, userId);

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

  // Clean up subscription, room presence, and interval when connection closes
  req.on('close', () => {
    releaseSSE();
    removeRoomPresence(connectionId, userId);
    connectionEmitter.off(eventName, onUpdate);
    clearInterval(heartbeatInterval);
    res.end();
  });
});

// Typing indicator endpoint (100% in-memory, 0 DB calls)
app.post('/api/connections/:id/typing', requireAuth, typingLimiter, async (req, res) => {
  const connectionId = req.params.id;
  const userId = Number(req.session.userId);
  const { isTyping } = req.body;
  const conn = await connectionOps.getConnection(connectionId, userId);
  if (!conn || conn._dataIntegrityError) return res.status(404).json({ error: 'Connection not found' });
  if (!requireActiveConnection(conn, res)) return;

  connectionEmitter.emit(`update:${connectionId}`, {
    type: 'typing',
    userId,
    isTyping: !!isTyping
  });

  res.json({ success: true });
});

// ── Per-User SSE Stream (powers messages list real-time updates) ─────────────
// Each user connects here once from the messages list page.
// Events: { type: 'message', connectionId, lastMessage, lastMessageTime, senderId }
app.get('/api/user/stream', requireSSEAuth, (req, res) => {
  const userId = req.session.userId;

  // Enforce per-user/per-IP connection caps before opening the stream.
  const userKey = `u:${userId}`;
  const ipKey = `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`;
  if (!trackSSEConnection(userKey, MAX_SSE_PER_USER)) {
    return res.status(429).json({ error: 'Too many open connections. Please close other tabs.' });
  }
  if (!trackSSEConnection(ipKey, MAX_SSE_PER_IP)) {
    releaseSSEConnection(userKey);
    return res.status(429).json({ error: 'Too many open connections from this device.' });
  }
  const releaseSSE = () => { releaseSSEConnection(userKey); releaseSSEConnection(ipKey); };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
  }
  res.write(': ok\n\n');

  const onEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const eventName = `user:${userId}`;
  userEmitter.on(eventName, onEvent);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    releaseSSE();
    userEmitter.off(eventName, onEvent);
    clearInterval(heartbeat);
    res.end();
  });
});

// End connection ("Not Vibing")
app.post('/api/connections/end', requireAuth, actionLimiter, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  evictConnectionAuth(connection_id); // Invalidate auth cache immediately
  const result = await connectionOps.endConnection(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  invalidateDiscoverFeed(req.session.userId);
  if (result.otherId) invalidateDiscoverFeed(result.otherId);

  // Archive all messages for this connection (tombstone) instead of hard-deleting.
  // They vanish from both users' views immediately, but rows are retained so
  // harassment evidence survives if a report was (or gets) filed. The 30-minute
  // retention sweep hard-deletes them after 7 days (30 days if the chat was reported).
  await messageOps.softDeleteAllForConnection(connection_id, req.session.userId);

  const endedMsg = 'Oops! Bad Luck... The other person was not vibing or ended the chat. This chat has ended and messages have been cleared.';

  // Notify BOTH users' chat SSE streams instantly (connection page redirect)
  connectionEmitter.emit(`update:${connection_id}`, {
    type: 'ended',
    reason: 'not_vibing',
    message: endedMsg
  });

  // Also notify BOTH users' messages-list SSE streams so the conversation row
  // disappears / refreshes in real-time on messages.html without needing a manual reload.
  const enderId = Number(req.session.userId);
  const otherId = result.otherId ? Number(result.otherId) : null;

  const chatEndedEvent = {
    type: 'chat_ended',
    connectionId: Number(connection_id)
  };
  userEmitter.emit(`user:${enderId}`, chatEndedEvent);
  if (otherId) {
    userEmitter.emit(`user:${otherId}`, chatEndedEvent);
  }

  res.json(result);
});

// Submit face reveal (Day 10)
  app.post('/api/connections/face-reveal', requireAuth, async (req, res) => {
    const { connection_id } = req.body;
    if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
    evictConnectionAuth(connection_id); // Invalidate auth cache — status changing
    const result = await connectionOps.submitFaceReveal(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  
  if (result.bothRevealed) {
    connectionEmitter.emit(`update:${connection_id}`, { 
      type: 'revealed', 
      meeting_code: result.meeting_code 
    });
  } else {
    connectionEmitter.emit(`update:${connection_id}`, { type: 'game' });
  }

  res.json(result);
});  // Decline face reveal
  app.post('/api/connections/decline-face-reveal', requireAuth, async (req, res) => {
    const { connection_id } = req.body;
    if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
    evictConnectionAuth(connection_id); // Invalidate auth cache
    const result = await connectionOps.declineFaceReveal(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);
  
  // A decline is a decision, not an implicit chat deletion. The other person is
  // notified and can explicitly choose to end the chat.
  connectionEmitter.emit(`update:${connection_id}`, {
    type: 'face-declined',
    declinedBy: Number(req.session.userId)
  });

  res.json(result);
});

// End connection after face reveal decline
app.post('/api/connections/end-after-decline', requireAuth, actionLimiter, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection id' });
  const result = await connectionOps.endAfterDecline(connection_id, req.session.userId);
  if (result.error) return res.status(400).json(result);

  // Same evidence-preserving archive as /api/connections/end
  await messageOps.softDeleteAllForConnection(connection_id, req.session.userId);
  
  connectionEmitter.emit(`update:${connection_id}`, {
    type: 'ended',
    reason: 'declined',
    message: 'This chat ended after the face reveal was declined.'
  });
  res.json(result);
});

// Start icebreaker game
app.post('/api/connections/:id/start-game', requireAuth, gameLimiter, async (req, res) => {
  const { game_type, question, options } = req.body;
  // Accept either a plain string question or an object with { q, a, b } shape sent by older clients
  let questionStr, questionOptions;
  if (question && typeof question === 'object' && typeof question.q === 'string') {
    // Legacy: client sent the whole { q, a, b } object as question
    questionStr = question.q.trim();
    questionOptions = { a: String(question.a || 'A'), b: String(question.b || 'B') };
  } else if (typeof question === 'string') {
    questionStr = question.trim();
    questionOptions = options && typeof options === 'object'
      ? { a: String(options.a || 'A'), b: String(options.b || 'B') }
      : null;
  } else {
    return res.status(400).json({ error: 'Missing game_type or question' });
  }
  if (!game_type || !questionStr) return res.status(400).json({ error: 'Missing game_type or question' });
  if (questionStr.length > 200) return res.status(400).json({ error: 'Question is too long (max 200 characters)' });
  try {
    const conn = await connectionOps.getConnection(req.params.id, req.session.userId);
    if (!conn || conn._dataIntegrityError) return res.status(404).json({ error: 'Connection not found' });
    if (!requireActiveConnection(conn, res)) return;
    
    // Save to Firestore so clients receive it via real-time connection doc snapshot listener
    const payload = await connectionOps.startGame(req.params.id, game_type, questionStr, questionOptions);
    
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
app.post('/api/connections/:id/answer-game', requireAuth, gameLimiter, async (req, res) => {
  const { answer } = req.body;
  if (typeof answer !== 'string' || !answer.trim()) return res.status(400).json({ error: 'Missing answer' });
  if (answer.length > 500) return res.status(400).json({ error: 'Answer is too long (max 500 characters)' });
  try {
    const conn = await connectionOps.getConnection(req.params.id, req.session.userId);
    if (!conn || conn._dataIntegrityError) return res.status(404).json({ error: 'Connection not found' });
    if (!requireActiveConnection(conn, res)) return;
    
    // Save answer to Firestore connection doc
    const result = await connectionOps.submitGameAnswer(req.params.id, req.session.userId, answer);
    if (result.error) return res.status(400).json(result);
    
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
app.post('/api/connections/:id/clear-game', requireAuth, gameLimiter, async (req, res) => {
  const { game_created_at } = req.body;
  try {
    const conn = await connectionOps.getConnection(req.params.id, req.session.userId);
    if (!conn || conn._dataIntegrityError) return res.status(404).json({ error: 'Connection not found' });
    if (!requireActiveConnection(conn, res)) return;
    
    // Clear game in Firestore connection doc. Returns { cleared: true } if
    // the game was actually removed, { cleared: false } if the transaction was
    // skipped because the active_game's created_at didn't match (meaning a new
    // game replaced the old one). We only broadcast game_update(null) when
    // something actually changed, preventing a stale timeout from removing a
    // newly created game.
    const { cleared } = await connectionOps.clearGame(req.params.id, game_created_at);
    
    // Notify both clients only if the game was actually removed.
    if (cleared) {
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
  if (!requireActiveConnection(conn, res)) return;
  
  const { since, before } = req.query;
  const limit = parseInt(req.query.limit, 10) || 30;

  // Delta-sync `since` values that are unparseable or more than 24h old are
  // treated as a full page load — a client that far behind shouldn't be able to
  // pull an arbitrarily large delta on every poll. (The payload is also capped
  // server-side via DELTA_FETCH_LIMIT regardless.)
  let safeSince = null;
  if (since && typeof since === 'string') {
    const sinceTime = Date.parse(since);
    if (Number.isFinite(sinceTime) && Date.now() - sinceTime <= 24 * 60 * 60 * 1000) {
      safeSince = since;
    }
  }

  const messages = await messageOps.getRecentForConnection(
    req.params.connectionId,
    Math.min(limit, 100), // Cap at 100 to prevent abuse
    safeSince,
    before || null
  );

  const hasMore = messages._hasMore || false;
  res.json({ messages, has_more: hasMore, connection: sanitizeConnection(conn, req.session.userId) });
});

// Read receipts are delivered through the connection SSE stream.
app.post('/api/messages/:connectionId/read', requireAuth, readReceiptLimiter, async (req, res) => {
  const conn = await connectionOps.getConnection(req.params.connectionId, req.session.userId);
  if (conn && conn._dataIntegrityError) {
    return res.status(410).json({ error: 'This chat is no longer available — one of the accounts involved no longer exists.' });
  }
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  if (!requireActiveConnection(conn, res)) return;

  const readAt = new Date().toISOString();

  // Instantly notify the OTHER user's SSE stream (<5ms) so seen ticks turn blue immediately
  connectionEmitter.emit(`update:${req.params.connectionId}`, {
    type: 'read',
    readAt,
    connectionId: Number(req.params.connectionId)
  });
  // Return HTTP response IMMEDIATELY without waiting for DB writes
  res.json({ success: true, readAt });

  // DB updates handled in background
  messageOps.markAsRead(req.params.connectionId, req.session.userId, conn).catch(err => {
    console.error('Background markAsRead error:', err.message);
  });
});

// Send normal text message
const MAX_PLAIN_MESSAGE_LENGTH = 4000;
const MAX_ENCRYPTED_MESSAGE_LENGTH = 6000; // base64 overhead over ~4.4k plaintext

app.post('/api/messages/send', requireAuth, messageLimiter, async (req, res) => {
  const { connection_id, content, is_encrypted, iv, client_uuid } = req.body;
  if (!connection_id || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Missing connection_id or content' });
  }
  if (Number(is_encrypted) === 1) {
    if (content.length > MAX_ENCRYPTED_MESSAGE_LENGTH) {
      return res.status(400).json({ error: 'Message is too long' });
    }
  } else if (content.length > MAX_PLAIN_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'Message is too long' });
  }

  // Reject abusive / forbidden content. E2EE ciphertext cannot be scanned, so
  // encrypted messages are skipped here (the client blocks them pre-encryption).
  if (!Number(is_encrypted) && hasForbiddenText(sanitizeText(content))) {
    return res.status(400).json({ error: FORBIDDEN_MESSAGE_ERROR });
  }

  const conn = await getCachedConnection(connection_id, req.session.userId);
  if (conn && conn._dataIntegrityError) {
    return res.status(410).json({ error: 'This chat is no longer available — one of the accounts involved no longer exists.' });
  }
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  if (!requireActiveConnection(conn, res)) return;

  const msg = await messageOps.send(
    connection_id, 
    req.session.userId, 
    sanitizeText(content.trim()), 
    0, 
    0, 
    is_encrypted || 0, 
    iv || null,
    client_uuid || null
  );
  if (!msg) {
    return res.status(503).json({ error: 'Message service is temporarily unavailable. Please retry.' });
  }

  const senderId = Number(req.session.userId);
  const displayContent = Number(is_encrypted) === 1 ? 'Encrypted message' : sanitizeText(content.trim());

  // Embed full message in SSE event so the receiver gets it with ZERO extra round-trips
  connectionEmitter.emit(`update:${connection_id}`, {
    type: 'message',
    senderId,
    msg: { ...msg, sender_id: senderId }
  });

  // Notify the OTHER user's per-user stream (messages list page) for instant updates
  const otherUserId = Number(conn.from_user_id) === senderId ? conn.to_user_id : conn.from_user_id;
  // Get sender's display name from session cache or DB (userOps.getById is cached)
  let senderUser = getCachedUser(senderId);
  if (!senderUser || !senderUser.username) {
    senderUser = await userOps.getById(senderId).catch(() => null);
    if (senderUser) {
      setCachedUser(senderId, {
        id: senderUser.id,
        username: senderUser.username,
        avatar: senderUser.avatar,
        bio: senderUser.bio,
        hobbies: senderUser.hobbies,
        gender: senderUser.gender
      });
    }
  }
  const senderUsername = (senderUser && senderUser.username) ? senderUser.username : 'User';

  userEmitter.emit(`user:${otherUserId}`, {
    type: 'message',
    connectionId: Number(connection_id),
    lastMessage: displayContent,
    lastMessageTime: msg.created_at,
    senderId,
    senderName: senderUsername
  });

  // Dispatch push notification to the receiver across platform channels (FCM for Android app, Web Push for browser)
  notificationDispatcher.dispatchNotification(
    otherUserId,
    connection_id,
    {
      title: senderUsername,
      body: displayContent,
      senderId,
      senderName: senderUsername,
      messageId: msg.id,
      type: 'chat_message',
      createdAt: msg.created_at,
      url: `/chat.html?id=${connection_id}`
    },
    (recId, connId) => activeRoomUsers.get(String(connId))?.has(Number(recId))
  ).catch(err => console.warn('Push notification dispatch error:', err.message));

  // Message order and previews come directly from Supabase. Do not write
  // last_message_at to Firestore for every message: it burns the Firestore
  // free-tier write quota and creates a hot document for an active chat.

  res.json({ success: true, message: msg });
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

  // Only ever persist the known fields, each length-capped, so an unauthenticated
  // caller cannot bloat Firestore docs with arbitrary keys or huge values.
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const logData = {
    timestamp: new Date().toISOString(),
    ip: str(ipKey, 64),
    userAgent: str(req.headers['user-agent'], 300),
    message: str(body.message, 2000),
    source: str(body.source, 500),
    lineno: Number.isFinite(Number(body.lineno)) ? Number(body.lineno) : null,
    colno: Number.isFinite(Number(body.colno)) ? Number(body.colno) : null,
    stack: str(body.stack, 5000),
    path: str(body.path, 500)
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

let vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (!vapidPublicKey || !vapidPrivateKey) {
  try {
    const generated = webPush.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    // IMPORTANT: Temporary keys are generated on every restart — all push subscriptions
    // will be invalidated when the server restarts. To persist notifications across restarts,
    // add these to your .env file:
    console.log('⚠️  VAPID keys not set — auto-generating temporary keys (push subscriptions will break on restart)');
    console.log(`   Add to .env: VAPID_PUBLIC_KEY=${vapidPublicKey}`);
    console.log(`   Add to .env: VAPID_PRIVATE_KEY=${vapidPrivateKey}`);
  } catch (e) {}
}

if (vapidPublicKey && vapidPrivateKey) {
  try {
    webPush.setVapidDetails(
      `mailto:${process.env.GMAIL_USER || 'deluluxcollegedating@gmail.com'}`,
      vapidPublicKey,
      vapidPrivateKey
    );
  } catch (e) {}
  // Keep the notification dispatcher on the SAME keypair clients subscribed
  // with (it may be auto-generated above when env vars are unset), so chat
  // message pushes sent via dispatchNotification() actually reach browsers.
  try {
    notificationDispatcher.configureWebPush(vapidPublicKey, vapidPrivateKey);
  } catch (e) {}
}

const { getMessaging } = require('firebase-admin/messaging');

async function sendPushNotification(userId, title, body, url = '/messages.html', type = 'notification', connectionId = null) {
  return pushBreaker.execute(async () => {
    const numUserId = Number(userId);

    // Guarantee a non-blank title/body so the OS never shows an empty notification
    const safeTitle = String(title && title.trim() ? title : 'New Notification');
    const safeBody = String(body && body.trim() ? body : 'You have a new notification');
    const safeUrl = String(url || (connectionId ? `/chat.html?id=${connectionId}` : '/messages.html'));
    const safeType = String(type || 'notification');
    const safeConnId = String(connectionId || '');

    // 1. Web Push Notification (PWA / Web Browsers)
    if (vapidPublicKey && vapidPrivateKey) {
      try {
        const subs = await pushOps.getSubscriptions(numUserId);
        for (const sub of subs) {
          const pushSub = {
            endpoint: sub.endpoint,
            keys: sub.keys
          };
          const payload = JSON.stringify({ title: safeTitle, body: safeBody, url: safeUrl, type: safeType, connectionId: safeConnId, icon: '/favicon.ico' });
          webPush.sendNotification(pushSub, payload).catch(err => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              pushOps.removeSubscription(sub.endpoint, numUserId);
            }
          });
        }
        // Devices subcollection web subscriptions (modern registration path)
        const devices = await notificationDispatcher.getActiveDevices(numUserId).catch(() => []);
        for (const dev of devices) {
          const sub = dev.web_push_subscription;
          if (dev.platform !== 'web_push' || !sub || !sub.endpoint) continue;
          const payload = JSON.stringify({ title: safeTitle, body: safeBody, url: safeUrl, type: safeType, connectionId: safeConnId, icon: '/favicon.ico' });
          webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload).catch(err => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              notificationDispatcher.unregisterDevice(numUserId, dev.deviceId).catch(() => {});
            }
          });
        }
      } catch (err) {
        console.error('WebPush notification error:', err.message);
      }
    }

    // 2. Firebase Admin FCM Native Push Notification (Android App Closed / Background)
    try {
      const apps = require('firebase-admin/app').getApps();
      if (apps.length > 0) {
        const legacyTokens = await pushOps.getFCMTokens(numUserId).catch(() => []);
        const devices = await notificationDispatcher.getActiveDevices(numUserId).catch(() => []);
        const deviceTokens = devices
          .filter(d => d.platform === 'android_fcm' && d.fcm_token)
          .map(d => d.fcm_token);
        const allTokens = [...new Set([...(legacyTokens || []), ...deviceTokens])];
        if (allTokens.length > 0) {
          const messaging = getMessaging(apps[0]);
          for (const token of allTokens) {
            const message = {
              token,
              notification: { title: safeTitle, body: safeBody },
              data: {
                title: safeTitle,
                body: safeBody,
                url: safeUrl,
                type: safeType,
                connectionId: safeConnId
              },
              android: {
                priority: 'high',
                notification: {
                  title: safeTitle,
                  body: safeBody,
                  icon: 'ic_stat_delulu',
                  color: '#a53b29',
                  sound: 'default',
                  priority: 'high',
                  channelId: 'delulu_messages',
                  visibility: 'public'
                }
              }
            };
            messaging.send(message).catch(fcmErr => {
              if (fcmErr.code === 'messaging/registration-token-not-registered' || fcmErr.code === 'messaging/invalid-registration-token') {
                pushOps.removeFCMToken(numUserId, token);
              }
            });
          }
        }
      }
    } catch (fcmErr) {}
  }, () => {
    // Fallback: If push notification dependency is degraded/open, fail gracefully without blocking chat
    return false;
  });
}

// ===== Multi-Transport Device Token Management (FCM & Web Push) =====

// Register or upsert a device token for the logged-in user
app.post('/api/devices/register', requireAuth, async (req, res) => {
  const { deviceId, platform, token, fcm_token, web_push_subscription, app_version, device_model } = req.body;
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 128) {
    return res.status(400).json({ error: 'Missing or invalid deviceId' });
  }
  if (platform && !['android_fcm', 'android', 'web_push'].includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  const deviceToken = token || fcm_token;
  if (deviceToken !== undefined && deviceToken !== null && (typeof deviceToken !== 'string' || deviceToken.length > 512)) {
    return res.status(400).json({ error: 'Invalid device token' });
  }
  if (web_push_subscription !== undefined && web_push_subscription !== null) {
    const sub = web_push_subscription;
    if (typeof sub !== 'object' || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid web push subscription' });
    }
    if (sub.keys && (typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string' ||
        sub.keys.p256dh.length > 1024 || sub.keys.auth.length > 1024)) {
      return res.status(400).json({ error: 'Invalid web push subscription keys' });
    }
  }
  if (app_version !== undefined && app_version !== null && (typeof app_version !== 'string' || app_version.length > 32)) {
    return res.status(400).json({ error: 'Invalid app_version' });
  }
  if (device_model !== undefined && device_model !== null && (typeof device_model !== 'string' || device_model.length > 64)) {
    return res.status(400).json({ error: 'Invalid device_model' });
  }

  const result = await notificationDispatcher.registerDevice(req.session.userId, {
    deviceId,
    platform: platform || 'android_fcm',
    token: token || fcm_token,
    web_push_subscription,
    app_version,
    device_model
  });

  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
});

// Delete/unregister a device token on logout
app.delete('/api/devices/:deviceId', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });

  const result = await notificationDispatcher.unregisterDevice(req.session.userId, deviceId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

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
  if (!requireActiveConnection(conn, res)) return;

  const result = await messageOps.toggleReaction(req.params.id, req.session.userId, connection_id, emoji);
  if (result.error) return res.status(400).json(result);

  connectionEmitter.emit(`update:${connection_id}`, { type: 'messages' });
  res.json(result);
});

// ===== Report & Block =====

// Report a user
app.post('/api/users/report', requireAuth, actionLimiter, async (req, res) => {
  const { reported_user_id, reason, connection_id, evidence } = req.body;
  if (!reported_user_id) return res.status(400).json({ error: 'Missing reported user' });
  if (Number(reported_user_id) === req.session.userId) return res.status(400).json({ error: 'Cannot report yourself' });
  
  // Validate reason length — prevent Firestore document size bloat (1MB max per doc)
  const safeReason = (reason || 'No reason').slice(0, 1000);
  // Reporter-supplied evidence (e.g. decrypted E2EE message content) that the
  // server cannot read itself. Kept with the report for safety review.
  const safeEvidence = (typeof evidence === 'string' ? evidence : '').slice(0, 5000) || null;
  
  // If a connection is cited as evidence, it must actually be the chat between
  // the reporter and the reported user — otherwise a report could be attached
  // to an arbitrary connection_id for moderation tampering.
  if (connection_id) {
    const conn = await connectionOps.getConnectionById(connection_id).catch(() => null);
    if (!conn) return res.status(400).json({ error: 'Invalid connection for this report' });
    const reporterId = Number(req.session.userId);
    const reportedId = Number(reported_user_id);
    const isParticipant = Number(conn.from_user_id) === reporterId || Number(conn.to_user_id) === reporterId;
    const coversPair = (Number(conn.from_user_id) === reporterId && Number(conn.to_user_id) === reportedId) ||
      (Number(conn.from_user_id) === reportedId && Number(conn.to_user_id) === reporterId);
    if (!isParticipant || !coversPair) {
      return res.status(400).json({ error: 'This connection does not belong to the reported conversation' });
    }
  }
  
  try {
    const reportId = await reportOps.create(req.session.userId, reported_user_id, safeReason, connection_id || null, safeEvidence);
    invalidateDiscoverFeed(req.session.userId);
    res.json({ success: true, reportId });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// Block a user
app.post('/api/users/block', requireAuth, actionLimiter, async (req, res) => {
  const { blocked_user_id } = req.body;
  if (!blocked_user_id) return res.status(400).json({ error: 'Missing blocked user' });
  if (Number(blocked_user_id) === req.session.userId) return res.status(400).json({ error: 'Cannot block yourself' });
  
  try {
    const blockerId = Number(req.session.userId);
    const blockedId = Number(blocked_user_id);
    const result = await blockOps.block(blockerId, blockedId);

    // Invalidate discover feed cache for both users
    invalidateDiscoverFeed(blockerId);
    invalidateDiscoverFeed(blockedId);

    // If any active connections were ended by this block, cleanup auth & messages, and notify SSE streams
    if (result.endedConnectionIds && result.endedConnectionIds.length > 0) {
      for (const connId of result.endedConnectionIds) {
        evictConnectionAuth(connId);
        await messageOps.softDeleteAllForConnection(connId, blockerId);
        
        // Notify chat page SSE
        connectionEmitter.emit(`update:${connId}`, {
          type: 'ended',
          reason: 'blocked',
          message: 'This chat has ended.'
        });

        // Notify messages list SSE for both users
        const chatEndedEvent = {
          type: 'chat_ended',
          connectionId: Number(connId)
        };
        userEmitter.emit(`user:${blockerId}`, chatEndedEvent);
        userEmitter.emit(`user:${blockedId}`, chatEndedEvent);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Block error:', err);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// Unblock a user
app.post('/api/users/unblock', requireAuth, actionLimiter, async (req, res) => {
  const { blocked_user_id } = req.body;
  if (!blocked_user_id) return res.status(400).json({ error: 'Missing user' });
  
  try {
    const blockerId = Number(req.session.userId);
    const blockedId = Number(blocked_user_id);
    await blockOps.unblock(blockerId, blockedId);
    invalidateDiscoverFeed(blockerId);
    invalidateDiscoverFeed(blockedId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblock' });
  }
});

// ===== Push Notifications =====

// Subscribe to push notifications
const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 5;

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || typeof subscription.endpoint !== 'string') {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  let endpointUrl;
  try {
    endpointUrl = new URL(subscription.endpoint);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid subscription endpoint' });
  }
  if (endpointUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Invalid subscription endpoint' });
  }
  const keys = subscription.keys || {};
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' ||
      keys.p256dh.length > 1024 || keys.auth.length > 1024) {
    return res.status(400).json({ error: 'Invalid subscription keys' });
  }
  try {
    await pushOps.subscribe(req.session.userId, { endpoint: subscription.endpoint, keys }, MAX_PUSH_SUBSCRIPTIONS_PER_USER);
    res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint || typeof endpoint !== 'string') return res.status(400).json({ error: 'Missing endpoint' });
  try {
    // Scoped by user id so a user can only remove their own subscriptions.
    await pushOps.removeSubscription(endpoint, req.session.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Register FCM device token for native Android background push notifications
app.post('/api/push/fcm-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length > 512) return res.status(400).json({ error: 'Missing or invalid token' });
  try {
    await pushOps.saveFCMToken(req.session.userId, token.trim());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save FCM token' });
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
app.get('/api/firebase/token', requireAuth, tokenMintLimiter, async (req, res) => {
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
  const connection_id = req.query.connection_id || req.body?.connection_id;
  if (!connection_id) return res.status(400).json({ error: 'Missing connection_id' });
  const conn = await connectionOps.getConnection(connection_id, req.session.userId);
  if (conn && conn._dataIntegrityError) return res.status(410).json({ error: 'This chat is no longer available.' });
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  if (!requireActiveConnection(conn, res)) return;
  const result = await messageOps.deleteMessage(req.params.id, req.session.userId, connection_id);
  if (result.error) return res.status(403).json(result);

  if (connection_id) {
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

// ── Distributed sweep lock ───────────────────────────────────────────────────
// The sweep runs inside every web process; on a multi-instance deploy each
// instance would redo the same work. A Firestore lock (with TTL) lets only one
// instance sweep at a time; a crashed instance's lock expires on its own.
const SWEEP_LOCK_TTL_MS = 40 * 60 * 1000;

async function acquireSweepLock() {
  const firestore = getDB();
  const lockRef = firestore.collection('locks').doc('sweep');
  const now = Date.now();
  try {
    await firestore.runTransaction(async (tx) => {
      const doc = await tx.get(lockRef);
      if (doc.exists && Number(doc.data().expires_at) > now) {
        throw new Error('SWEEP_LOCKED');
      }
      tx.set(lockRef, {
        owner: `instance:${process.pid}`,
        acquired_at: new Date().toISOString(),
        expires_at: now + SWEEP_LOCK_TTL_MS
      });
    });
    return true;
  } catch (err) {
    return false;
  }
}

async function releaseSweepLock() {
  try {
    await getDB().collection('locks').doc('sweep').delete();
  } catch (err) {
    // Best-effort — the TTL handles a stuck lock.
  }
}

// Scheduled Sweep for Expired Connections & Requests (every 30 minutes to conserve Firebase free-tier quota)
setInterval(async () => {
  let lockHeld = false;
  try {
    lockHeld = await acquireSweepLock();
    if (!lockHeld) return; // another instance (or a recent run) is sweeping

    const sweepResult = await connectionOps.sweepExpired();
    const reqSweep = await connectionOps.sweepExpiredRequests();
    // Hard-delete archived chat messages past their retention window
    const purgedMessages = await messageOps.purgeExpiredSoftDeleted().catch(err => {
      console.error('[Sweep] Message retention purge failed:', err);
      return 0;
    });
    if (sweepResult.faceRevealsExpired > 0 || reqSweep.expiredCount > 0 || purgedMessages > 0) {
      console.log(`[Sweep] Expired ${sweepResult.faceRevealsExpired} face reveals, ${reqSweep.expiredCount} pending requests, purged ${purgedMessages} archived messages.`);
    }
    // Housekeeping: sweep expired/used OTPs and single-use auth tokens.
    await otpOps.cleanExpired().catch(() => {});
    await authTokenOps.cleanExpired().catch(() => {});
    // Emit SSE events for each expired connection so users' UIs update in real-time
    if (sweepResult.expiredConnections && sweepResult.expiredConnections.length > 0) {
      const endedMsg = 'The chat window has closed because neither user completed the face reveal in time.';
      for (const entry of sweepResult.expiredConnections) {
        connectionEmitter.emit(`update:${entry.id}`, {
          type: 'ended',
          reason: 'expired',
          message: endedMsg
        });
        const chatEndedEvent = { type: 'chat_ended', connectionId: Number(entry.id) };
        userEmitter.emit(`user:${entry.from_user_id}`, chatEndedEvent);
        userEmitter.emit(`user:${entry.to_user_id}`, chatEndedEvent);
      }
    }
  } catch (err) {
    console.error('[Sweep Error]', err);
  } finally {
    if (lockHeld) await releaseSweepLock().catch(() => {});
  }
}, 30 * 60 * 1000);






if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
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
}

module.exports = {
  app,
  server,
  // Kept private-by-convention; used by the focused cursor contract tests.
  __discoverTestUtils: { createDiscoverCursor, readDiscoverCursor },
  // Kept private-by-convention; used by the auth/revocation contract tests.
  __authTestUtils: {
    generateAuthToken,
    verifyAuthToken,
    generateSSEToken,
    verifySSEToken,
    validatePasswordStrength,
    isCommonPassword,
    checkPwnedPassword,
    MIN_PASSWORD_LENGTH,
    resolveSseCap
  },
  // Kept private-by-convention; used by the connection/meeting-flow contract tests.
  __connectionTestUtils: {
    sanitizeConnection,
    createMeetingRoom,
    normalizeMeetBaseUrl
  },
  // Kept private-by-convention; used by the icebreaker endpoint contract tests.
  // Exposes only the session store so tests can mint authenticated sessions
  // without ever touching the database.
  __sessionTestUtils: {
    sessionStore
  }
};
