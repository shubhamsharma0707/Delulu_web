const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const DB_PATH = path.join(__dirname, 'data', 'delulu.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initDB();
  }
  return db;
}

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT DEFAULT NULL,
      gender TEXT NOT NULL CHECK(gender IN ('male', 'female', 'other')),
      passcode_hash TEXT NOT NULL DEFAULT '',
      bio TEXT DEFAULT '',
      hobbies TEXT DEFAULT '[]',
      profile_pic TEXT DEFAULT '',
      is_onboarded INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'expired', 'revealed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      chat_started_at DATETIME,
      vibe_available_at DATETIME,
      reveal_available_at DATETIME,
      from_vibe INTEGER DEFAULT 0 CHECK(from_vibe IN (0, 1, 2)),
      to_vibe INTEGER DEFAULT 0 CHECK(to_vibe IN (0, 1, 2)),
      reveal_from INTEGER DEFAULT 0 CHECK(reveal_from IN (0, 1)),
      reveal_to INTEGER DEFAULT 0 CHECK(reveal_to IN (0, 1)),
      UNIQUE(from_user_id, to_user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS blocked_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_user_id, to_user_id)
    );

    CREATE TABLE IF NOT EXISTS otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      otp TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_connections_from ON connections(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_connections_to ON connections(to_user_id);
    CREATE INDEX IF NOT EXISTS idx_connections_status ON connections(status);
    CREATE INDEX IF NOT EXISTS idx_messages_connection ON messages(connection_id);
    CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);
  `);

  try { db.exec("ALTER TABLE users ADD COLUMN passcode_hash TEXT NOT NULL DEFAULT '';"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL;"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN is_onboarded INTEGER DEFAULT 0;"); } catch (e) {}
  try { db.exec("ALTER TABLE connections ADD COLUMN reveal_available_at DATETIME;"); } catch (e) {}
}

// Seed some demo users if none exist
function seedDemoUsers() {
  const count = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (count.count > 0) return;

  const defaultHash = bcrypt.hashSync('123456', 10);

  const demos = [
    { username: 'wanderlust_amy', gender: 'female', bio: 'Dog mom, amateur pasta maker, and weekend hiker. Love finding obscure coffee shops.', hobbies: JSON.stringify(['hiking', 'photography', 'coffee', 'cooking', 'travel']), profile_pic: '' },
    { username: 'art_vibes', gender: 'female', bio: 'Art enthusiast and gallery hopper. Always on the lookout for the next great exhibition.', hobbies: JSON.stringify(['art', 'photography', 'reading', 'music']), profile_pic: '' },
    { username: 'stellar_jay', gender: 'male', bio: 'Astronomy nerd and weekend astronomer. Love stargazing and deep conversations.', hobbies: JSON.stringify(['photography', 'hiking', 'reading', 'movies', 'camping']), profile_pic: '' },
    { username: 'coffee_leo', gender: 'male', bio: 'Barista by day, musician by night. Looking for someone to share a latte and a laugh.', hobbies: JSON.stringify(['coffee', 'music', 'cooking', 'baking', 'writing']), profile_pic: '' },
    { username: 'trailblazer', gender: 'female', bio: "Trail runner and outdoor enthusiast. Summited 12 peaks last year! Let's explore together.", hobbies: JSON.stringify(['hiking', 'running', 'yoga', 'travel', 'camping']), profile_pic: '' },
    { username: 'pixel_wanderer', gender: 'male', bio: 'Digital nomad and travel photographer. Capturing moments one frame at a time.', hobbies: JSON.stringify(['photography', 'travel', 'hiking', 'coffee', 'writing']), profile_pic: '' },
    { username: 'bookish_bee', gender: 'female', bio: 'Bookworm with an indie soul. Bibliophile, poet, and curator of cozy corners.', hobbies: JSON.stringify(['reading', 'writing', 'coffee', 'music', 'gardening']), profile_pic: '' },
    { username: 'green_mind', gender: 'male', bio: 'Plant dad and sustainability advocate. Growing my own food and building a better world.', hobbies: JSON.stringify(['gardening', 'cooking', 'yoga', 'reading', 'cycling']), profile_pic: '' },
    { username: 'melody_maker', gender: 'female', bio: 'Indie musician and vinyl collector. Music is my love language.', hobbies: JSON.stringify(['music', 'writing', 'art', 'coffee', 'dancing']), profile_pic: '' },
    { username: 'ocean_soul', gender: 'male', bio: 'Surfer, sailor, and beach bum. The ocean is my happy place.', hobbies: JSON.stringify(['swimming', 'travel', 'photography', 'yoga', 'running']), profile_pic: '' },
    { username: 'spice_queen', gender: 'female', bio: 'Home chef and spice collector. Cooking my way around the world from my tiny kitchen.', hobbies: JSON.stringify(['cooking', 'travel', 'baking', 'gardening', 'dancing']), profile_pic: '' },
    { username: 'zen_master', gender: 'male', bio: 'Yoga instructor and mindfulness coach. Finding balance in a chaotic world.', hobbies: JSON.stringify(['yoga', 'meditation', 'hiking', 'reading', 'gardening']), profile_pic: '' },
  ];

  const insert = db.prepare(`INSERT INTO users (username, gender, passcode_hash, bio, hobbies, profile_pic) VALUES (@username, @gender, @passcode_hash, @bio, @hobbies, @profile_pic)`);
  const insertMany = db.transaction((users) => {
    for (const u of users) {
      u.passcode_hash = defaultHash;
      insert.run(u);
    }
  });
  insertMany(demos);
  console.log(`Seeded ${demos.length} demo users`);
}

// User operations
const userOps = {
  create(username, gender, passcodeHash, bio, hobbies, profilePic) {
    const stmt = getDB().prepare(`INSERT INTO users (username, gender, passcode_hash, bio, hobbies, profile_pic) VALUES (?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(username, gender, passcodeHash, bio || '', JSON.stringify(hobbies || []), profilePic || '');
    return result.lastInsertRowid;
  },

  createWithEmail(username, gender, email, bio, hobbies, profilePic) {
    const stmt = getDB().prepare(`INSERT INTO users (username, gender, email, bio, hobbies, profile_pic, is_onboarded) VALUES (?, ?, ?, ?, ?, ?, 1)`);
    const result = stmt.run(username, gender, email, bio || '', JSON.stringify(hobbies || []), profilePic || '');
    return result.lastInsertRowid;
  },

  getById(id) {
    return getDB().prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  
  getByUsername(username) {
    return getDB().prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  getByEmail(email) {
    return getDB().prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  linkEmailToUser(userId, email) {
    getDB().prepare('UPDATE users SET email = ?, is_onboarded = 1 WHERE id = ?').run(email, userId);
  },

  update(id, fields) {
    const allowed = ['bio', 'hobbies', 'profile_pic'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(key === 'hobbies' ? JSON.stringify(fields[key]) : fields[key]);
      }
    }
    if (updates.length === 0) return;
    values.push(id);
    getDB().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  },

  // Get discoverable profiles: opposite gender (or all for 'other'), not already connected
  getDiscoverable(userId, gender, excludeIds = []) {
    // We need to fetch blocked_users as well
    const blocked = getDB().prepare('SELECT to_user_id as blocked_id FROM blocked_users WHERE from_user_id = ? UNION SELECT from_user_id as blocked_id FROM blocked_users WHERE to_user_id = ?').all(userId, userId);
    const blockedIds = blocked.map(b => b.blocked_id);
    const allExclude = [...new Set([...excludeIds, ...blockedIds])];
    
    let genderFilter;
    if (gender === 'male') {
      genderFilter = 'female';
    } else if (gender === 'female') {
      genderFilter = 'male';
    } else {
      // 'other' can see both genders, excluding their own
      genderFilter = null;
    }
    const placeholders = allExclude.length > 0 ? allExclude.map(() => '?').join(',') : '0';
    let sql;
    let params;
    if (genderFilter) {
      sql = `
        SELECT u.id, u.username, u.bio, u.hobbies, u.profile_pic, u.gender
        FROM users u
        WHERE u.gender = ? AND u.id != ?
          AND u.id NOT IN (${placeholders})
        ORDER BY RANDOM()
      `;
      params = [genderFilter, userId, ...allExclude];
    } else {
      sql = `
        SELECT u.id, u.username, u.bio, u.hobbies, u.profile_pic, u.gender
        FROM users u
        WHERE u.id != ?
          AND u.id NOT IN (${placeholders})
        ORDER BY RANDOM()
      `;
      params = [userId, ...allExclude];
    }
    return getDB().prepare(sql).all(...params);
  }
};

// Connection operations
const connectionOps = {
  sendRequest(fromId, toId) {
    // Check if connection already exists
    const existing = getDB().prepare(
      'SELECT id, status FROM connections WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)'
    ).get(fromId, toId, toId, fromId);
    if (existing) return { error: 'Connection already exists', status: existing.status };
    
    getDB().prepare('INSERT INTO connections (from_user_id, to_user_id) VALUES (?, ?)').run(fromId, toId);
    return { success: true };
  },

  getPendingForUser(userId) {
    return getDB().prepare(`
      SELECT c.*, u.username, u.bio, u.hobbies, u.profile_pic, u.gender
      FROM connections c
      JOIN users u ON c.from_user_id = u.id
      WHERE c.to_user_id = ? AND c.status = 'pending'
      ORDER BY c.created_at DESC
    `).all(userId);
  },

  getSentRequests(userId) {
    return getDB().prepare(`
      SELECT c.*, u.username, u.bio, u.hobbies, u.profile_pic, u.gender
      FROM connections c
      JOIN users u ON c.to_user_id = u.id
      WHERE c.from_user_id = ? AND c.status = 'pending'
      ORDER BY c.created_at DESC
    `).all(userId);
  },

  respond(connectionId, userId, action) {
    const conn = getDB().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId);
    if (!conn || conn.to_user_id !== userId) return { error: 'Not authorized' };
    if (conn.status !== 'pending') return { error: 'Already responded' };

    if (action === 'accept') {
      const now = new Date().toISOString();
      const vibeDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      getDB().prepare(
        'UPDATE connections SET status = ?, chat_started_at = ?, vibe_available_at = ? WHERE id = ?'
      ).run('accepted', now, vibeDate, connectionId);
      return { success: true, chat_started_at: now, vibe_available_at: vibeDate };
    } else {
      getDB().prepare('UPDATE connections SET status = ? WHERE id = ?').run('rejected', connectionId);
      return { success: true, status: 'rejected' };
    }
  },

  getActiveConnections(userId) {
    return getDB().prepare(`
      SELECT c.*, 
        CASE WHEN c.from_user_id = ? THEN u2.username ELSE u1.username END as other_username,
        CASE WHEN c.from_user_id = ? THEN u2.bio ELSE u1.bio END as other_bio,
        CASE WHEN c.from_user_id = ? THEN u2.hobbies ELSE u1.hobbies END as other_hobbies,
        CASE WHEN c.from_user_id = ? THEN u2.profile_pic ELSE u1.profile_pic END as other_profile_pic,
        CASE WHEN c.from_user_id = ? THEN u2.id ELSE u1.id END as other_user_id
      FROM connections c
      JOIN users u1 ON c.from_user_id = u1.id
      JOIN users u2 ON c.to_user_id = u2.id
      WHERE (c.from_user_id = ? OR c.to_user_id = ?) AND c.status IN ('accepted', 'revealed')
      ORDER BY c.chat_started_at DESC
    `).all(userId, userId, userId, userId, userId, userId, userId);
  },

  getConnection(connectionId, userId) {
    return getDB().prepare(`
      SELECT c.*, 
        CASE WHEN c.from_user_id = ? THEN u2.username ELSE u1.username END as other_username,
        CASE WHEN c.from_user_id = ? THEN u2.gender ELSE u1.gender END as other_gender,
        CASE WHEN c.from_user_id = ? THEN u2.bio ELSE u1.bio END as other_bio,
        CASE WHEN c.from_user_id = ? THEN u2.hobbies ELSE u1.hobbies END as other_hobbies,
        CASE WHEN c.from_user_id = ? THEN u2.profile_pic ELSE u1.profile_pic END as other_profile_pic,
        CASE WHEN c.from_user_id = ? THEN u2.id ELSE u1.id END as other_user_id,
        CASE WHEN c.from_user_id = ? THEN u1.id ELSE u2.id END as my_user_id
      FROM connections c
      JOIN users u1 ON c.from_user_id = u1.id
      JOIN users u2 ON c.to_user_id = u2.id
      WHERE c.id = ? AND (c.from_user_id = ? OR c.to_user_id = ?)
    `).get(userId, userId, userId, userId, userId, userId, userId, connectionId, userId, userId);
  },

  submitVibe(connectionId, userId, vibe) {
    const conn = getDB().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId);
    if (!conn) return { error: 'Connection not found' };
    if (conn.status !== 'accepted') return { error: 'Connection not active' };

    const isFrom = conn.from_user_id === userId;
    
    // If either person selects Not Vibe at any point -> chat ends immediately
    if (vibe === 2) {
      getDB().prepare('UPDATE connections SET status = ? WHERE id = ?').run('rejected', connectionId);
      return { success: true, match: false, bothVibe: false };
    }

    if (isFrom && conn.from_vibe !== 0) return { error: 'Already voted' };
    if (!isFrom && conn.to_vibe !== 0) return { error: 'Already voted' };

    const field = isFrom ? 'from_vibe' : 'to_vibe';
    getDB().prepare(`UPDATE connections SET ${field} = ? WHERE id = ?`).run(vibe, connectionId);

    // Check if both have voted
    const updated = getDB().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId);
    const bothVoted = updated.from_vibe > 0 && updated.to_vibe > 0;

    if (bothVoted) {
      const bothVibe = updated.from_vibe === 1 && updated.to_vibe === 1;
      if (bothVibe) {
        const revealDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
        getDB().prepare('UPDATE connections SET reveal_from = 0, reveal_to = 0, reveal_available_at = ? WHERE id = ?').run(revealDate, connectionId);
        return { success: true, match: true, bothVibe: true, reveal_available_at: revealDate };
      } else {
        // Technically this branch shouldn't hit if we reject instantly on vibe=2, but keeping for safety
        getDB().prepare('UPDATE connections SET status = ? WHERE id = ?').run('expired', connectionId);
        return { success: true, match: false, bothVibe: false };
      }
    }
    return { success: true, bothVote: false };
  },

  submitReveal(connectionId, userId) {
    const conn = getDB().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId);
    if (!conn) return { error: 'Connection not found' };

    const isFrom = conn.from_user_id === userId;
    const field = isFrom ? 'reveal_from' : 'reveal_to';
    getDB().prepare(`UPDATE connections SET ${field} = 1 WHERE id = ?`).run(connectionId);

    const updated = getDB().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId);
    const bothRevealed = updated.reveal_from === 1 && updated.reveal_to === 1;

    if (bothRevealed) {
      // Identity revealed — get other user's real info
      const otherUser = isFrom 
        ? getDB().prepare('SELECT id, username, profile_pic FROM users WHERE id = ?').get(conn.to_user_id)
        : getDB().prepare('SELECT id, username, profile_pic FROM users WHERE id = ?').get(conn.from_user_id);
      getDB().prepare('UPDATE connections SET status = ? WHERE id = ?').run('revealed', connectionId);
      return { success: true, bothRevealed: true, otherUser };
    }
    return { success: true, bothRevealed: false };
  },
  
  blockUser(fromId, toId, reason = '') {
    try {
      getDB().prepare('INSERT INTO blocked_users (from_user_id, to_user_id, reason) VALUES (?, ?, ?)').run(fromId, toId, reason);
      // Immediately reject any active connection
      getDB().prepare('UPDATE connections SET status = "rejected" WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)').run(fromId, toId, toId, fromId);
      return { success: true };
    } catch(err) {
      return { error: 'Already blocked or error occurred' };
    }
  },
  
  sweepExpired() {
    const now = new Date().toISOString();
    
    // Expire pending vibe checks where vibe_available_at has passed and someone hasn't voted
    // We treat missing vote as auto Not Vibe (rejected)
    const expiredVibes = getDB().prepare(`
      UPDATE connections 
      SET status = 'rejected' 
      WHERE status = 'accepted' 
        AND vibe_available_at < ? 
        AND (from_vibe = 0 OR to_vibe = 0)
    `).run(now);

    // Expire reveals where reveal_available_at has passed and someone hasn't revealed
    const expiredReveals = getDB().prepare(`
      UPDATE connections 
      SET status = 'expired' 
      WHERE status = 'accepted' 
        AND reveal_available_at < ? 
        AND (reveal_from = 0 OR reveal_to = 0)
    `).run(now);

    return { vibeExpired: expiredVibes.changes, revealsExpired: expiredReveals.changes };
  },

  getConnectionById(connectionId) {
    return getDB().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId);
  }
};

// Message operations
const messageOps = {
  send(connectionId, senderId, content) {
    const stmt = getDB().prepare('INSERT INTO messages (connection_id, sender_id, content) VALUES (?, ?, ?)');
    const result = stmt.run(connectionId, senderId, content);
    return getDB().prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
  },

  getForConnection(connectionId) {
    return getDB().prepare('SELECT * FROM messages WHERE connection_id = ? ORDER BY created_at ASC').all(connectionId);
  },

  getRecentForConnection(connectionId, limit = 50) {
    return getDB().prepare('SELECT * FROM messages WHERE connection_id = ? ORDER BY created_at DESC LIMIT ?').all(connectionId, limit).reverse();
  }
};

// OTP operations
const otpOps = {
  create(email, otp, expiresAt) {
    const stmt = getDB().prepare(`INSERT INTO otps (email, otp, expires_at) VALUES (?, ?, ?)`);
    const result = stmt.run(email, otp, expiresAt);
    return result.lastInsertRowid;
  },

  getValidOTP(email, otp) {
    return getDB().prepare(
      `SELECT * FROM otps WHERE email = ? AND otp = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`
    ).get(email, otp);
  },

  markUsed(id) {
    getDB().prepare('UPDATE otps SET used = 1 WHERE id = ?').run(id);
  },

  cleanExpired() {
    getDB().prepare("DELETE FROM otps WHERE expires_at < datetime('now') OR used = 1").run();
  },

  deleteByEmail(email) {
    getDB().prepare('DELETE FROM otps WHERE email = ?').run(email);
  }
};

module.exports = { getDB, initDB, seedDemoUsers, userOps, connectionOps, messageOps, otpOps };
