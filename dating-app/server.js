const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('crypto');
const { getDB, seedDemoUsers, userOps, connectionOps, messageOps } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Session middleware
const sessionMiddleware = session({
  secret: 'delulu-secret-key-change-in-production',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Check if user is logged in
app.get('/api/session', (req, res) => {
  if (req.session.userId) {
    const user = userOps.getById(req.session.userId);
    if (user) {
      return res.json({ authenticated: true, user });
    }
  }
  res.json({ authenticated: false });
});

// Create profile (signup)
app.post('/api/users/create', (req, res) => {
  try {
    const { username, gender, bio, hobbies, profile_pic } = req.body;
    
    if (!username || !gender) {
      return res.status(400).json({ error: 'Username and gender are required' });
    }
    if (!['male', 'female', 'other'].includes(gender)) {
      return res.status(400).json({ error: 'Invalid gender' });
    }

    // Check username availability
    const existing = getDB().prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const userId = userOps.create(username, gender, bio, hobbies, profile_pic);
    req.session.userId = Number(userId);
    const user = userOps.getById(userId);
    res.json({ success: true, user });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// Login (by username — anonymous)
app.post('/api/users/login', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  
  const user = getDB().prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  req.session.userId = user.id;
  res.json({ success: true, user });
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
  res.json(user);
});

// Update profile
app.put('/api/users/me', requireAuth, (req, res) => {
  const { bio, hobbies, profile_pic } = req.body;
  userOps.update(req.session.userId, { bio, hobbies, profile_pic });
  const user = userOps.getById(req.session.userId);
  res.json({ success: true, user });
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
      AND status IN ('pending', 'accepted', 'rejected', 'expired')
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
      profile_pic: p.profile_pic,
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

  const result = connectionOps.sendRequest(req.session.userId, to_user_id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
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
    ...conn,
    is_vibe_available: conn.vibe_available_at ? new Date(conn.vibe_available_at) <= now : false
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

// Get messages for a connection
app.get('/api/messages/:connectionId', requireAuth, (req, res) => {
  const conn = connectionOps.getConnection(req.params.connectionId, req.session.userId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  
  const messages = messageOps.getRecentForConnection(req.params.connectionId);
  res.json({ messages, connection: conn });
});

// ===== PAGE ROUTES =====

// Serve main app - handle routing on client side
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fallback for SPA routes (not API)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

// Initialize database and start server
getDB();
seedDemoUsers();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Delulu Dating App running at http://localhost:${PORT}`);
  console.log(`Open your browser to http://localhost:${PORT}`);
  console.log('');
  console.log('Demo users with female profiles:');
  console.log('  wanderlust_amy, art_vibes, trailblazer, bookish_bee, melody_maker, spice_queen');
  console.log('Demo users with male profiles:');
  console.log('  stellar_jay, coffee_leo, pixel_wanderer, green_mind, ocean_soul, zen_master');
});
