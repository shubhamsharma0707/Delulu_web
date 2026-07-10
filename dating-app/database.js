const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const bcrypt = require('bcrypt');

let db;
function getDB() {
  if (!db) {
    let app;
    if (getApps().length === 0) {
      app = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/^"|"$/g, '').replace(/\\n/g, '\n')
        })
      });
    } else {
      app = getApps()[0];
    }
    db = getFirestore(app);
  }
  return db;
}

// Thread-safe auto-incrementing ID generator using transactions
async function getNextId(collectionName) {
  const firestore = getDB();
  const counterRef = firestore.collection('counters').doc(collectionName);
  let nextId;
  await firestore.runTransaction(async (transaction) => {
    const doc = await transaction.get(counterRef);
    if (!doc.exists) {
      nextId = 1;
      transaction.set(counterRef, { current: 1 });
    } else {
      nextId = doc.data().current + 1;
      transaction.update(counterRef, { current: nextId });
    }
  });
  return nextId;
}

// Ecosystem mapping based on email domain
function getEcosystem(email) {
  if (!email) return 'rishihood'; // Default fallback
  const domain = email.toLowerCase().trim().split('@')[1];
  if (domain === 'vitbhopal.ac.in') {
    return 'vitbhopal';
  }
  return 'rishihood';
}

// Seed demo users — uses a local sentinel file (.seed-done) to avoid
// touching Firestore on every server restart (each check = 1 wasted read).
const fs_sync = require('fs');
const SEED_SENTINEL = '.seed-done';

async function seedDemoUsers() {
  // Skip entirely if sentinel exists — no Firestore read at all
  if (fs_sync.existsSync(SEED_SENTINEL)) return;

  if (process.env.NODE_ENV === 'production') {
    console.log('Skipping demo user seeding in production.');
    fs_sync.writeFileSync(SEED_SENTINEL, new Date().toISOString());
    return;
  }

  const firestore = getDB();
  const usersColl = firestore.collection('users');
  const snapshot = await usersColl.limit(1).get();

  if (!snapshot.empty) {
    console.log('Database already seeded or users exist.');
    // Write sentinel so we never check again
    fs_sync.writeFileSync(SEED_SENTINEL, new Date().toISOString());
    return;
  }

  const defaultHash = bcrypt.hashSync('123456', 10);
  const demos = [
    // Rishihood Ecosystem
    { id: 1, username: 'wanderlust_amy', gender: 'female', bio: 'Dog mom, amateur pasta maker, and weekend hiker. Love finding obscure coffee shops.', hobbies: ['hiking', 'photography', 'coffee', 'cooking', 'travel'], avatar: 'female_01', ecosystem: 'rishihood', email: 'wanderlust_amy@nst.rishihood.edu.in' },
    { id: 2, username: 'art_vibes', gender: 'female', bio: 'Art enthusiast and gallery hopper. Always on the lookout for the next great exhibition.', hobbies: ['art', 'photography', 'reading', 'music'], avatar: 'female_02', ecosystem: 'rishihood', email: 'art_vibes@nst.rishihood.edu.in' },
    { id: 3, username: 'stellar_jay', gender: 'male', bio: 'Astronomy nerd and weekend astronomer. Love stargazing and deep conversations.', hobbies: ['photography', 'hiking', 'reading', 'movies', 'camping'], avatar: 'male_01', ecosystem: 'rishihood', email: 'stellar_jay@nst.rishihood.edu.in' },
    { id: 4, username: 'coffee_leo', gender: 'male', bio: 'Barista by day, musician by night. Looking for someone to share a latte and a laugh.', hobbies: ['coffee', 'music', 'cooking', 'baking', 'writing'], avatar: 'male_02', ecosystem: 'rishihood', email: 'coffee_leo@nst.rishihood.edu.in' },
    { id: 5, username: 'trailblazer', gender: 'female', bio: "Trail runner and outdoor enthusiast. Summited 12 peaks last year! Let's explore together.", hobbies: ['hiking', 'running', 'yoga', 'travel', 'camping'], avatar: 'female_03', ecosystem: 'rishihood', email: 'trailblazer@nst.rishihood.edu.in' },
    { id: 6, username: 'pixel_wanderer', gender: 'male', bio: 'Digital nomad and travel photographer. Capturing moments one frame at a time.', hobbies: ['photography', 'travel', 'hiking', 'coffee', 'writing'], avatar: 'male_03', ecosystem: 'rishihood', email: 'pixel_wanderer@nst.rishihood.edu.in' },
    { id: 7, username: 'bookish_bee', gender: 'female', bio: 'Bookworm with an indie soul. Bibliophile, poet, and curator of cozy corners.', hobbies: ['reading', 'writing', 'coffee', 'music', 'gardening'], avatar: 'female_04', ecosystem: 'rishihood', email: 'bookish_bee@nst.rishihood.edu.in' },
    { id: 8, username: 'green_mind', gender: 'male', bio: 'Plant dad and sustainability advocate. Growing my own food and building a better world.', hobbies: ['gardening', 'cooking', 'yoga', 'reading', 'cycling'], avatar: 'male_04', ecosystem: 'rishihood', email: 'green_mind@nst.rishihood.edu.in' },
    { id: 9, username: 'melody_maker', gender: 'female', bio: 'Indie musician and vinyl collector. Music is my love language.', hobbies: ['music', 'writing', 'art', 'coffee', 'dancing'], avatar: 'female_05', ecosystem: 'rishihood', email: 'melody_maker@nst.rishihood.edu.in' },
    { id: 10, username: 'ocean_soul', gender: 'male', bio: 'Surfer, sailor, and beach bum. The ocean is my happy place.', hobbies: ['swimming', 'travel', 'photography', 'yoga', 'running'], avatar: 'male_05', ecosystem: 'rishihood', email: 'ocean_soul@nst.rishihood.edu.in' },
    { id: 11, username: 'spice_queen', gender: 'female', bio: 'Home chef and spice collector. Cooking my way around the world from my tiny kitchen.', hobbies: ['cooking', 'travel', 'baking', 'gardening', 'dancing'], avatar: 'female_06', ecosystem: 'rishihood', email: 'spice_queen@nst.rishihood.edu.in' },
    { id: 12, username: 'zen_master', gender: 'male', bio: 'Yoga instructor and mindfulness coach. Finding balance in a chaotic world.', hobbies: ['yoga', 'meditation', 'hiking', 'reading', 'gardening'], avatar: 'male_06', ecosystem: 'rishihood', email: 'zen_master@nst.rishihood.edu.in' },
    
    // VIT Bhopal Ecosystem
    { id: 13, username: 'vit_lily', gender: 'female', bio: 'Tech enthusiast, coder, and late-night gamer. Always up for a hackathon or a movie night.', hobbies: ['gaming', 'music', 'travel', 'coffee'], avatar: 'female_01', ecosystem: 'vitbhopal', email: 'vit_lily@vitbhopal.ac.in' },
    { id: 14, username: 'vit_alex', gender: 'male', bio: 'Photography enthusiast, nature lover, and street food hunter. Capturing the moments that matter.', hobbies: ['photography', 'hiking', 'travel', 'cooking'], avatar: 'male_01', ecosystem: 'vitbhopal', email: 'vit_alex@vitbhopal.ac.in' },
    { id: 15, username: 'vit_sara', gender: 'female', bio: 'Book lover, poet, and classical dancer. Seeking interesting conversations over tea.', hobbies: ['reading', 'writing', 'dancing', 'art'], avatar: 'female_02', ecosystem: 'vitbhopal', email: 'vit_sara@vitbhopal.ac.in' },
    { id: 16, username: 'vit_ryan', gender: 'male', bio: 'Fitness junkie, runner, and amateur guitarist. Striving to stay active and creative every day.', hobbies: ['running', 'music', 'yoga', 'cycling'], avatar: 'male_02', ecosystem: 'vitbhopal', email: 'vit_ryan@vitbhopal.ac.in' }
  ];

  const batch = firestore.batch();
  for (const u of demos) {
    const docRef = usersColl.doc(String(u.id));
    batch.set(docRef, {
      ...u,
      passcode_hash: defaultHash,
      is_onboarded: 1,
      created_at: new Date().toISOString()
    });
  }

  // Set counter document
  const counterRef = firestore.collection('counters').doc('users');
  batch.set(counterRef, { current: 16 });

  await batch.commit();
  fs_sync.writeFileSync(SEED_SENTINEL, new Date().toISOString());
  console.log(`Seeded ${demos.length} demo users in Firestore`);
}

// Kept for compatibility
function backfillDemoAvatars() {}

// In-memory cache for user lookups to reduce Firestore reads
const userByIdCache = new Map();
const USER_CACHE_TTL = 15 * 1000; // 15 seconds

function getCachedUserById(id) {
  const cached = userByIdCache.get(id);
  if (cached && Date.now() - cached.timestamp < USER_CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedUserById(id, userData) {
  userByIdCache.set(id, { data: userData, timestamp: Date.now() });
  if (userByIdCache.size > 500) {
    const oldest = userByIdCache.keys().next().value;
    if (oldest) userByIdCache.delete(oldest);
  }
}

function invalidateUserCache(id) {
  userByIdCache.delete(id);
}

// User operations
const userOps = {
  async create(username, gender, passcodeHash, bio, hobbies, avatar) {
    const userId = await getNextId('users');
    const userDocRef = getDB().collection('users').doc(String(userId));
    await userDocRef.set({
      id: userId,
      username,
      gender,
      passcode_hash: passcodeHash,
      bio: bio || '',
      hobbies: hobbies || [],
      avatar: avatar || '',
      is_onboarded: 0,
      email: null,
      ecosystem: 'rishihood', // Default fallback
      created_at: new Date().toISOString()
    });
    return userId;
  },

  async createWithEmail(username, gender, email, passwordHash, bio, hobbies, avatar, publicKey = null, encryptedPrivateKey = null) {
    const userId = await getNextId('users');
    const userDocRef = getDB().collection('users').doc(String(userId));
    const ecosystem = getEcosystem(email);
    await userDocRef.set({
      id: userId,
      username,
      gender,
      email,
      passcode_hash: passwordHash,
      bio: bio || '',
      hobbies: hobbies || [],
      avatar: avatar || '',
      is_onboarded: 1,
      ecosystem,
      public_key: publicKey || null,
      encrypted_private_key: encryptedPrivateKey || null,
      created_at: new Date().toISOString()
    });
    return userId;
  },

  async getById(id) {
    if (!id) return null;
    // Check in-memory cache first
    const cached = getCachedUserById(id);
    if (cached) return cached;
    
    const doc = await getDB().collection('users').doc(String(id)).get();
    const userData = doc.exists ? doc.data() : null;
    if (userData) {
      setCachedUserById(id, userData);
    }
    return userData;
  },
  
  async getByUsername(username) {
    if (!username) return null;
    const snapshot = await getDB().collection('users').where('username', '==', username).limit(1).get();
    return snapshot.empty ? null : snapshot.docs[0].data();
  },

  async getByEmail(email) {
    if (!email) return null;
    const snapshot = await getDB().collection('users').where('email', '==', email).limit(1).get();
    return snapshot.empty ? null : snapshot.docs[0].data();
  },

  async linkEmailToUser(userId, email) {
    await getDB().collection('users').doc(String(userId)).update({
      email: email,
      is_onboarded: 1
    });
  },

  async update(id, fields) {
    const allowed = ['bio', 'hobbies', 'avatar'];
    const updatePayload = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        updatePayload[key] = fields[key];
      }
    }
    if (Object.keys(updatePayload).length === 0) return;
    await getDB().collection('users').doc(String(id)).update(updatePayload);
    // Invalidate cache on update
    invalidateUserCache(id);
  },

  // Get discoverable profiles (filtered by ecosystem)
  async getDiscoverable(userId, gender, excludeIds = []) {
    const firestore = getDB();
    const userDoc = await this.getById(userId);
    const userEcosystem = userDoc?.ecosystem || 'rishihood';
    
    // Fetch blocked users involving this user
    const blockedSnapshotFrom = await firestore.collection('blocked_users').where('from_user_id', '==', Number(userId)).get();
    const blockedSnapshotTo = await firestore.collection('blocked_users').where('to_user_id', '==', Number(userId)).get();
    
    const blockedIds = [];
    blockedSnapshotFrom.forEach(doc => blockedIds.push(doc.data().to_user_id));
    blockedSnapshotTo.forEach(doc => blockedIds.push(doc.data().from_user_id));
    
    const allExclude = [...new Set([...excludeIds, ...blockedIds, Number(userId)])];
    
    let genderFilter = null;
    if (gender === 'male') {
      genderFilter = 'female';
    } else if (gender === 'female') {
      genderFilter = 'male';
    }

    let query = firestore.collection('users').where('ecosystem', '==', userEcosystem);
    if (genderFilter) {
      query = query.where('gender', '==', genderFilter);
    }
    
    const snapshot = await query.get();
    const discoverable = [];
    snapshot.forEach(doc => {
      const u = doc.data();
      if (!allExclude.includes(u.id)) {
        discoverable.push({
          id: u.id,
          username: u.username,
          bio: u.bio,
          hobbies: u.hobbies,
          avatar: u.avatar,
          gender: u.gender
        });
      }
    });

    // Random shuffle
    return discoverable.sort(() => Math.random() - 0.5);
  }
};

// ─── Connection read-reduction cache ──────────────────────────────────────────
// This is a SHORT-LIVED in-memory cache (TTL 2 minutes) placed in front of
// connectionOps.getConnection(). Its sole purpose is to reduce Firestore reads
// on hot chat routes where the same connection doc is fetched for every message
// API call (auth check, send, react, upload-voice, etc.).
//
// IMPORTANT — this is NOT an authorization decision cache:
//   • Any mutation that changes a connection's status (block, reject, end, sweep)
//     calls evictConnection() immediately, so a revoked connection cannot be
//     served from stale cache.
//   • At worst, a connection's non-status metadata (e.g. last_read_at timestamps)
//     may be up to 2 minutes stale — this is acceptable because the client drives
//     read-receipt updates via delta-sync, not via getConnection().
// ───────────────────────────────────────────────────────────────────────────────
const CONNECTION_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const CONNECTION_CACHE_MAX    = 10_000;          // hard cap — evict oldest when exceeded

/** @type {Map<string, { data: object, ts: number }>} */
const _connCache = new Map();

/**
 * Evict all cache entries for a given connectionId.
 * Call this immediately after any write that changes connection status.
 * The cache is keyed by "connId:userId", so we do a prefix scan.
 */
function evictConnection(connectionId) {
  const prefix = `${connectionId}:`;
  for (const key of _connCache.keys()) {
    if (key.startsWith(prefix)) _connCache.delete(key);
  }
}

// Connection operations
const connectionOps = {
  async sendRequest(fromId, toId) {
    const firestore = getDB();
    
    // Check if connection already exists
    const snap1 = await firestore.collection('connections')
      .where('from_user_id', '==', Number(fromId))
      .where('to_user_id', '==', Number(toId))
      .limit(1).get();
      
    const snap2 = await firestore.collection('connections')
      .where('from_user_id', '==', Number(toId))
      .where('to_user_id', '==', Number(fromId))
      .limit(1).get();
      
    const doc = !snap1.empty ? snap1.docs[0].data() : (!snap2.empty ? snap2.docs[0].data() : null);
    if (doc) {
      return { error: 'Connection already exists', status: doc.status };
    }
    
    const connId = await getNextId('connections');
    await firestore.collection('connections').doc(String(connId)).set({
      id: connId,
      from_user_id: Number(fromId),
      to_user_id: Number(toId),
      status: 'pending',
      created_at: new Date().toISOString(),
      chat_started_at: null,
      vibe_available_at: null,
      reveal_available_at: null,
      from_vibe: 0,
      to_vibe: 0,
      reveal_from: 0,
      reveal_to: 0,
      vibe_score: 0,
      from_last_read_at: null,
      to_last_read_at: null
    });
    
    return { success: true };
  },

  async dismiss(fromId, toId) {
    const firestore = getDB();
    const snap1 = await firestore.collection('connections')
      .where('from_user_id', '==', Number(fromId))
      .where('to_user_id', '==', Number(toId))
      .limit(1).get();
    const snap2 = await firestore.collection('connections')
      .where('from_user_id', '==', Number(toId))
      .where('to_user_id', '==', Number(fromId))
      .limit(1).get();
    const doc = !snap1.empty ? snap1.docs[0] : (!snap2.empty ? snap2.docs[0] : null);
    if (doc) {
      await doc.ref.update({ status: 'rejected' });
      evictConnection(doc.data().id); // cache invalidation — status changed
    } else {
      const connId = await getNextId('connections');
      await firestore.collection('connections').doc(String(connId)).set({
        id: connId,
        from_user_id: Number(fromId),
        to_user_id: Number(toId),
        status: 'rejected',
        created_at: new Date().toISOString(),
        chat_started_at: null,
        vibe_available_at: null,
        reveal_available_at: null,
        from_vibe: 0,
        to_vibe: 0,
        reveal_from: 0,
        reveal_to: 0,
        vibe_score: 0,
        from_last_read_at: null,
        to_last_read_at: null
      });
      // New doc — nothing to evict
    }
    return { success: true };
  },

  async revoke(connectionId, userId) {
    const firestore = getDB();
    const docRef = firestore.collection('connections').doc(String(connectionId));
    const doc = await docRef.get();
    if (!doc.exists) return { error: 'Connection not found' };
    const conn = doc.data();
    if (conn.from_user_id !== Number(userId)) {
      return { error: 'Not authorized to revoke this request' };
    }
    if (conn.status !== 'pending') {
      return { error: 'Cannot revoke a request that is not pending' };
    }
    await docRef.delete();
    evictConnection(connectionId); // cache invalidation — document deleted
    return { success: true };
  },

  async getConnectedUserIds(userId) {
    const firestore = getDB();
    const snap1 = await firestore.collection('connections').where('from_user_id', '==', Number(userId)).get();
    const snap2 = await firestore.collection('connections').where('to_user_id', '==', Number(userId)).get();
    
    const ids = [];
    snap1.forEach(doc => ids.push(doc.data().to_user_id));
    snap2.forEach(doc => ids.push(doc.data().from_user_id));
    return [...new Set(ids)];
  },

  async getPendingForUser(userId) {
    const snapshot = await getDB().collection('connections')
      .where('to_user_id', '==', Number(userId))
      .where('status', '==', 'pending')
      .get();
      
    const connections = [];
    for (const doc of snapshot.docs) {
      const conn = doc.data();
      const sender = await userOps.getById(conn.from_user_id);
      if (sender) {
        connections.push({
          ...conn,
          username: sender.username,
          bio: sender.bio,
          hobbies: sender.hobbies,
          avatar: sender.avatar,
          gender: sender.gender
        });
      }
    }
    return connections.sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async getSentRequests(userId) {
    const snapshot = await getDB().collection('connections')
      .where('from_user_id', '==', Number(userId))
      .where('status', '==', 'pending')
      .get();
      
    const connections = [];
    for (const doc of snapshot.docs) {
      const conn = doc.data();
      const receiver = await userOps.getById(conn.to_user_id);
      if (receiver) {
        connections.push({
          ...conn,
          username: receiver.username,
          bio: receiver.bio,
          hobbies: receiver.hobbies,
          avatar: receiver.avatar,
          gender: receiver.gender
        });
      }
    }
    return connections.sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async respond(connectionId, userId, action) {
    const firestore = getDB();
    const connDocRef = firestore.collection('connections').doc(String(connectionId));
    const doc = await connDocRef.get();
    
    if (!doc.exists) return { error: 'Connection not found' };
    const conn = doc.data();
    if (conn.to_user_id !== Number(userId)) return { error: 'Not authorized' };
    if (conn.status !== 'pending') return { error: 'Already responded' };

    if (action === 'accept') {
      const now = new Date();
      const nextVibeCheck = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const revealAvailable = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
      await connDocRef.update({
        status: 'accepted',
        chat_started_at: now.toISOString(),
        next_vibe_check_at: nextVibeCheck,
        reveal_available_at: revealAvailable,
        from_vibe: 0,
        to_vibe: 0,
        reveal_from: 0,
        reveal_to: 0
      });
      evictConnection(connectionId); // cache invalidation — status changed to 'accepted'
      return { 
        success: true, 
        chat_started_at: now.toISOString(), 
        next_vibe_check_at: nextVibeCheck,
        reveal_available_at: revealAvailable
      };
    } else {
      await connDocRef.update({ status: 'rejected' });
      evictConnection(connectionId); // cache invalidation — status changed to 'rejected'
      return { success: true, status: 'rejected' };
    }
  },

  async getActiveConnections(userId) {
    const firestore = getDB();
    const snap1 = await firestore.collection('connections')
      .where('from_user_id', '==', Number(userId))
      .get();
    const snap2 = await firestore.collection('connections')
      .where('to_user_id', '==', Number(userId))
      .get();
      
    const active = [];
    const pushActive = async (conn) => {
      if (['accepted', 'revealed'].includes(conn.status)) {
        const otherId = conn.from_user_id === Number(userId) ? conn.to_user_id : conn.from_user_id;
        const otherUser = await userOps.getById(otherId);
        if (otherUser) {
          // Fetch the last message for this connection
          let lastMsg = null;
          try {
            const msgSnapshot = await firestore.collection('messages')
              .where('connection_id', '==', Number(conn.id))
              .orderBy('created_at', 'desc')
              .limit(1)
              .get();
            if (!msgSnapshot.empty) {
              lastMsg = msgSnapshot.docs[0].data();
            }
          } catch (e) {
            // Index may not exist yet, skip silently
          }
          
          const isFrom = conn.from_user_id === Number(userId);
          const myLastReadAt = isFrom ? conn.from_last_read_at : conn.to_last_read_at;
          
          active.push({
            ...conn,
            other_username: otherUser.username,
            other_bio: otherUser.bio,
            other_hobbies: otherUser.hobbies,
            other_avatar: otherUser.avatar,
            other_user_id: otherUser.id,
            last_message: lastMsg ? (Number(lastMsg.is_encrypted) === 1 ? '🔒 Encrypted message' : (lastMsg.is_voice === 1 ? '🎤 Voice note' : lastMsg.is_voice === 2 ? '📷 Photo' : lastMsg.content)) : null,
            last_message_time: lastMsg ? lastMsg.created_at : null,
            last_sender_id: lastMsg ? lastMsg.sender_id : null,
            last_read: lastMsg ? (lastMsg.sender_id === Number(userId) ? true : (myLastReadAt && lastMsg.created_at <= myLastReadAt)) : true
          });
        }
      }
    };

    for (const doc of snap1.docs) await pushActive(doc.data());
    for (const doc of snap2.docs) await pushActive(doc.data());
    
    return active.sort((a, b) => {
      const aTime = a.last_message_time || a.chat_started_at;
      const bTime = b.last_message_time || b.chat_started_at;
      return bTime.localeCompare(aTime);
    });
  },

  async getConnection(connectionId, userId) {
    // ── Cache check ──────────────────────────────────────────────────────────
    // NOTE: The cache stores only the raw Firestore connection fields plus the
    // two derived last_read_at fields. Embedded partner profile data (username,
    // avatar, bio, etc.) is intentionally NOT cached here — it is fetched fresh
    // from userOps.getById() on every call. userOps has its own short-lived TTL
    // cache so this costs at most one extra cache lookup, not a Firestore read.
    // This means profile edits are reflected immediately without needing a
    // separate cache-invalidation path wired to profile update routes.
    const cacheKey = `${connectionId}:${userId}`;
    const cached = _connCache.get(cacheKey);
    const isHit = cached && (Date.now() - cached.ts) < CONNECTION_CACHE_TTL_MS;

    let conn;
    if (isHit) {
      // Cache hit — skip Firestore, use stored raw conn fields
      conn = cached.data;
    } else {
      // Cache miss or expired — read from Firestore
      const firestore = getDB();
      const doc = await firestore.collection('connections').doc(String(connectionId)).get();
      if (!doc.exists) return null;
      conn = doc.data();

      if (conn.from_user_id !== Number(userId) && conn.to_user_id !== Number(userId)) {
        return null;
      }

      // ── Write-back: delete first to reset insertion order for LRU eviction ──
      // Calling .set() without .delete() updates the value in-place but keeps
      // the entry's original insertion position — so the cap would evict the
      // wrong (no-longer-oldest) entry. Always delete-then-set.
      if (_connCache.size >= CONNECTION_CACHE_MAX && !_connCache.has(cacheKey)) {
        // Evict the oldest entry only when adding a brand-new key
        _connCache.delete(_connCache.keys().next().value);
      }
      _connCache.delete(cacheKey);           // remove old position (no-op on first insert)
      _connCache.set(cacheKey, { data: conn, ts: Date.now() }); // re-insert at tail
    }

    // ── Always fetch user profiles fresh (userOps has its own TTL cache) ──────
    const otherId = conn.from_user_id === Number(userId) ? conn.to_user_id : conn.from_user_id;
    const myId    = conn.from_user_id === Number(userId) ? conn.from_user_id : conn.to_user_id;

    const otherUser = await userOps.getById(otherId);
    const myUser    = await userOps.getById(myId);

    if (!otherUser || !myUser) {
      console.error(`getConnection: connection ${connectionId} exists but user lookup failed — otherId=${otherId} found=${!!otherUser}, myId=${myId} found=${!!myUser}`);
      // Do NOT cache _dataIntegrityError — it may be transient
      return { _dataIntegrityError: true, connectionId };
    }

    const isFrom = conn.from_user_id === Number(userId);

    return {
      ...conn,
      other_username:    otherUser.username,
      other_gender:      otherUser.gender,
      other_bio:         otherUser.bio,
      other_hobbies:     otherUser.hobbies,
      other_avatar:      otherUser.avatar,
      other_user_id:     otherUser.id,
      other_public_key:  otherUser.public_key || null,
      my_user_id:        myUser.id,
      my_last_read_at:   isFrom ? conn.from_last_read_at : conn.to_last_read_at,
      other_last_read_at: isFrom ? conn.to_last_read_at : conn.from_last_read_at
    };
  },

  async submitVibe(connectionId, userId, vibe) {
    const firestore = getDB();
    const connDocRef = firestore.collection('connections').doc(String(connectionId));
    const doc = await connDocRef.get();
    if (!doc.exists) return { error: 'Connection not found' };
    const conn = doc.data();
    if (conn.status !== 'accepted') return { error: 'Connection not active' };

    const isFrom = conn.from_user_id === Number(userId);

    if (vibe === 2) {
      // Not vibing — end the connection immediately, regardless of the other user's vote
      await connDocRef.update({ status: 'rejected', ended_reason: 'not_vibing' });
      evictConnection(connectionId); // cache invalidation — status: rejected
      const otherId = isFrom ? conn.to_user_id : conn.from_user_id;
      return { success: true, ended: true, otherId };
    }

    const field = isFrom ? 'from_vibe' : 'to_vibe';
    await connDocRef.update({ [field]: 1 });
    evictConnection(connectionId); // cache invalidation — from_vibe/to_vibe field changed

    const updated = (await connDocRef.get()).data();
    if (updated.from_vibe === 1 && updated.to_vibe === 1) {
      // Both vibing this round — reset votes and push the next check 7 days out
      const nextCheck = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await connDocRef.update({ from_vibe: 0, to_vibe: 0, next_vibe_check_at: nextCheck });
      evictConnection(connectionId); // cache invalidation — from_vibe/to_vibe reset + next_vibe_check_at changed
      return { success: true, ended: false, bothVibing: true, next_vibe_check_at: nextCheck };
    }
    return { success: true, ended: false, bothVibing: false };
  },

  async submitReveal(connectionId, userId) {
    const firestore = getDB();
    const connDocRef = firestore.collection('connections').doc(String(connectionId));
    const doc = await connDocRef.get();
    
    if (!doc.exists) return { error: 'Connection not found' };
    const conn = doc.data();
    
    const isFrom = conn.from_user_id === Number(userId);
    const field = isFrom ? 'reveal_from' : 'reveal_to';
    await connDocRef.update({ [field]: 1 });
    evictConnection(connectionId); // cache invalidation — reveal_from/reveal_to field changed

    const updatedDoc = await connDocRef.get();
    const updated = updatedDoc.data();
    const bothRevealed = updated.reveal_from === 1 && updated.reveal_to === 1;

    if (bothRevealed) {
      const otherId = isFrom ? conn.to_user_id : conn.from_user_id;
      const otherUser = await userOps.getById(otherId);
      await connDocRef.update({ status: 'revealed' });
      evictConnection(connectionId); // cache invalidation — status changed to 'revealed'
      return { 
        success: true, 
        bothRevealed: true, 
        otherUser: { id: otherUser.id, username: otherUser.username, avatar: otherUser.avatar } 
      };
    }
    return { success: true, bothRevealed: false };
  },

  async startGame(connectionId, gameType, question) {
    const firestore = getDB();
    const connDocRef = firestore.collection('connections').doc(String(connectionId));
    const payload = {
      game_type: gameType,
      question,
      answers: {},
      created_at: new Date().toISOString()
    };
    await connDocRef.update({ active_game: payload });
    evictConnection(connectionId); // cache invalidation — active_game field set
    return payload;
  },

  async submitGameAnswer(connectionId, userId, answer) {
    const firestore = getDB();
    const connDocRef = firestore.collection('connections').doc(String(connectionId));
    
    let bothAnswered = false;
    let gameData = null;
    await firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(connDocRef);
      if (!doc.exists) throw new Error('Connection not found');
      const conn = doc.data();
      const activeGame = conn.active_game || null;
      if (!activeGame) throw new Error('No active game found');
      
      const answers = activeGame.answers || {};
      answers[String(userId)] = answer;
      activeGame.answers = answers;
      
      transaction.update(connDocRef, { active_game: activeGame });
      
      const otherId = conn.from_user_id === Number(userId) ? conn.to_user_id : conn.from_user_id;
      bothAnswered = (answers[String(userId)] !== undefined) && (answers[String(otherId)] !== undefined);
      gameData = activeGame;
    });
    evictConnection(connectionId); // cache invalidation — active_game.answers updated (transaction committed)
    
    return { success: true, bothAnswered, gameData };
  },

  async clearGame(connectionId) {
    const firestore = getDB();
    const connDocRef = firestore.collection('connections').doc(String(connectionId));
    await connDocRef.update({ active_game: null });
    evictConnection(connectionId); // cache invalidation — active_game cleared
    return { success: true };
  },

  
  async sweepExpired() {
    const firestore = getDB();
    const now = new Date().toISOString();
    const snapshot = await firestore.collection('connections')
      .where('status', '==', 'accepted')
      .limit(100)
      .get();
      
    let vibeExpired = 0;
    let revealsExpired = 0;
    const batch = firestore.batch();
    
    // ponytail: iterates all 'accepted' connections in JS — add compound index + Firestore query filter when >1000 connections.
    const expiredIds = [];
    snapshot.forEach(doc => {
      const conn = doc.data();
      
      // Sweep 1: Reveal period expired without both users revealing
      if (conn.reveal_available_at && conn.reveal_available_at < now && (conn.reveal_from === 0 || conn.reveal_to === 0)) {
        batch.update(doc.ref, { status: 'expired', ended_reason: 'reveal_timeout' });
        expiredIds.push(conn.id);
        revealsExpired++;
        return;
      }
      
      // Sweep 2: Vibe check due and neither user has voted — auto-close
      if (conn.next_vibe_check_at && conn.next_vibe_check_at < now) {
        if (conn.from_vibe === 0 && conn.to_vibe === 0) {
          batch.update(doc.ref, { status: 'rejected', ended_reason: 'vibe_timeout' });
          expiredIds.push(conn.id);
          vibeExpired++;
        }
      }
    });
    
    await batch.commit();
    // cache invalidation — evict all connections whose status just changed
    for (const id of expiredIds) evictConnection(id);
    return { vibeExpired, revealsExpired };
  },

  async getConnectionById(connectionId) {
    const doc = await getDB().collection('connections').doc(String(connectionId)).get();
    return doc.exists ? doc.data() : null;
  }
};

// Message operations — backed by Supabase Postgres (NOT Firestore)
// The Firestore connection doc (ownership/permission check) is still used
// by connectionOps.getConnection() in every route handler BEFORE these run.
const { getSupabase } = require('./db/supabase');

const messageOps = {
  // ── INSERT ──────────────────────────────────────────────────────────────────
  // Supabase table schema: id, connection_id, sender_id, content, reactions,
  //   created_at, deleted_at, deleted_by, is_voice (int), voice_duration (int),
  //   is_encrypted (int), iv (text), read_at (timestamptz)
  // All fields are now persisted directly in the INSERT — no merge-patching.
  async send(connectionId, senderId, content, isVoice = 0, voiceDuration = 0, isEncrypted = 0, iv = null) {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('messages')
        .insert({
          connection_id:  Number(connectionId),
          sender_id:      Number(senderId),
          content,
          reactions:      {},
          is_voice:       Number(isVoice),
          voice_duration: Number(voiceDuration),
          is_encrypted:   Number(isEncrypted),
          iv:             iv || null
        })
        .select()
        .single();

      if (error) throw error;

      // Return the actual inserted row — all fields come directly from Supabase.
      return data;
    } catch (err) {
      console.error('messageOps.send error:', err.message);
      throw new Error('Failed to send message');
    }
  },

  // ── TOGGLE REACTION ──────────────────────────────────────────────────────────
  // Single read + single write against Supabase 'messages' reactions jsonb column.
  // Moved from Firestore msgRef.get() → msgRef.update({ reactions }).
  async toggleReaction(messageId, userId, connectionId, emoji) {
    try {
      const supabase = getSupabase();

      // Read current reactions from Supabase
      const { data: msg, error: fetchErr } = await supabase
        .from('messages')
        .select('id, connection_id, reactions, deleted_at')
        .eq('id', messageId)
        .is('deleted_at', null)
        .single();

      if (fetchErr || !msg) return { error: 'Message not found' };
      if (msg.connection_id !== Number(connectionId)) return { error: 'Mismatched connection' };

      // Toggle userId in/out of the emoji's array (application-level, no extra table)
      const reactions = msg.reactions || {};
      const users = reactions[emoji] || [];
      const idx = users.indexOf(Number(userId));
      if (idx === -1) users.push(Number(userId)); else users.splice(idx, 1);
      if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;

      // Write updated reactions object back
      const { error: updateErr } = await supabase
        .from('messages')
        .update({ reactions })
        .eq('id', messageId);

      if (updateErr) throw updateErr;
      return { success: true, reactions };
    } catch (err) {
      console.error('messageOps.toggleReaction error:', err.message);
      return { error: 'Failed to toggle reaction' };
    }
  },

  // ── SOFT DELETE (tombstone) ──────────────────────────────────────────────────
  // Moved from Firestore update({ deleted: 1 }) → Supabase update({ deleted_at, deleted_by }).
  // Hard-deletes are never performed; the row is tombstoned so delta-sync can still
  // return the deletion event to the other user.
  async deleteMessage(messageId, userId) {
    try {
      const supabase = getSupabase();

      // Verify ownership before tombstoning
      const { data: msg, error: fetchErr } = await supabase
        .from('messages')
        .select('id, sender_id, deleted_at')
        .eq('id', messageId)
        .single();

      if (fetchErr || !msg) return { error: 'Message not found' };
      if (msg.sender_id !== Number(userId)) return { error: 'Not authorized to delete this message' };
      if (msg.deleted_at) return { error: 'Message already deleted' };

      const { error: updateErr } = await supabase
        .from('messages')
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by: Number(userId),
          content:    '',         // clear content as well
          reactions:  {}          // clear reactions on deletion
        })
        .eq('id', messageId);

      if (updateErr) throw updateErr;
      return { success: true };
    } catch (err) {
      console.error('messageOps.deleteMessage error:', err.message);
      return { error: 'Failed to delete message' };
    }
  },

  // ── FETCH ALL (internal use, e.g. read-receipt count) ────────────────────────
  // Moved from Firestore unordered collection scan → Supabase ordered query.
  async getForConnection(connectionId) {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('connection_id', Number(connectionId))
        .is('deleted_at', null)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (err) {
      console.error('messageOps.getForConnection error:', err.message);
      return [];
    }
  },

  // ── MARK AS READ ─────────────────────────────────────────────────────────────
  // Ownership data (from_user_id, to_user_id) still lives on the Firestore
  // connection doc, so we keep reading from there.  The last-read timestamp
  // is written back to Firestore (no changes to that Firestore field).
  // The unread message COUNT is now queried from Supabase instead of Firestore.
  async markAsRead(connectionId, userId) {
    try {
      const firestore = getDB();
      const supabase = getSupabase();
      const now = new Date().toISOString();

      const connRef = firestore.collection('connections').doc(String(connectionId));
      const doc = await connRef.get();
      if (!doc.exists) return { count: 0 };

      const conn = doc.data();
      const prevLastReadAt = conn.from_user_id === Number(userId)
        ? conn.from_last_read_at
        : conn.to_last_read_at;
      const field = conn.from_user_id === Number(userId)
        ? 'from_last_read_at'
        : 'to_last_read_at';

      // Update last-read timestamp on the Firestore connection doc (unchanged)
      await connRef.update({ [field]: now });

      // Count unread messages from the other user since the previous read marker
      const otherId = conn.from_user_id === Number(userId)
        ? conn.to_user_id
        : conn.from_user_id;

      let countQuery = supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('connection_id', Number(connectionId))
        .eq('sender_id', Number(otherId))
        .is('deleted_at', null);

      if (prevLastReadAt) {
        countQuery = countQuery.gt('created_at', prevLastReadAt);
      }

      const { count, error: countErr } = await countQuery;
      if (countErr) throw countErr;

      return { count: count || 0 };
    } catch (err) {
      console.error('messageOps.markAsRead error:', err.message);
      return { count: 0 };
    }
  },

  // ── DELTA-SYNC FETCH (primary read path for REST fallback polling) ────────────
  // Moved from Firestore collection query → Supabase table query.
  // When `since` (ISO string) is provided, only messages newer than that timestamp
  // are fetched — this is the core delta-sync optimization.
  // Tombstoned messages (deleted_at IS NOT NULL) are excluded.
  // Returns oldest-first (ascending) to match the existing client contract.
  async getRecentForConnection(connectionId, limit = 50, since = null) {
    try {
      const supabase = getSupabase();

      let query = supabase
        .from('messages')
        .select('*')
        .eq('connection_id', Number(connectionId))
        .is('deleted_at', null);

      // Delta sync: only fetch messages newer than the client's last-seen timestamp
      if (since) {
        query = query.gt('created_at', since);
      }

      // Fetch newest-first so .limit() trims the right end, then reverse in JS
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      // Reverse to oldest-first — same return contract as the old Firestore version
      return (data || []).reverse();
    } catch (err) {
      console.error('messageOps.getRecentForConnection error:', err.message);
      return [];
    }
  }
};

// OTP operations (Mapped for signup tokens)
const otpOps = {
  async create(email, otp, expiresAt) {
    const firestore = getDB();
    const otpId = await getNextId('otps');
    await firestore.collection('otps').doc(String(otpId)).set({
      id: otpId,
      email,
      otp,
      used: 0,
      expires_at: new Date(expiresAt).toISOString(),
      created_at: new Date().toISOString(),
      attempts: 0
    });
    return otpId;
  },

  async getValidOTP(email, otp) {
    const now = new Date().toISOString();
    const snapshot = await getDB().collection('otps')
      .where('email', '==', email)
      .where('otp', '==', otp)
      .where('used', '==', 0)
      .get();
      
    let valid = null;
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.expires_at > now) {
        valid = data;
      }
    });
    return valid;
  },

  async getActiveOTP(email) {
    const now = new Date().toISOString();
    const snapshot = await getDB().collection('otps')
      .where('email', '==', email)
      .where('used', '==', 0)
      .get();
      
    let active = null;
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.expires_at > now) {
        active = data;
      }
    });
    return active;
  },

  async incrementAttempts(email) {
    const firestore = getDB();
    const active = await this.getActiveOTP(email);
    if (active) {
      await firestore.collection('otps').doc(String(active.id)).update({
        attempts: FieldValue.increment(1)
      });
    }
  },

  async markUsed(id) {
    await getDB().collection('otps').doc(String(id)).update({ used: 1 });
  },

  async cleanExpired() {
    const firestore = getDB();
    const now = new Date().toISOString();
    const snapshot = await firestore.collection('otps').get();
    const batch = firestore.batch();
    let count = 0;
    
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.expires_at < now || data.used === 1) {
        batch.delete(doc.ref);
        count++;
      }
    });
    await batch.commit();
    return { deletedCount: count };
  },

  async deleteByEmail(email) {
    const firestore = getDB();
    const snapshot = await firestore.collection('otps').where('email', '==', email).get();
    const batch = firestore.batch();
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }
};

// ===== Report & Block Operations =====
const reportOps = {
  async create(reporterId, reportedUserId, reason, connectionId = null) {
    const firestore = getDB();
    const reportId = await getNextId('reports');
    await firestore.collection('reports').doc(String(reportId)).set({
      id: reportId,
      reporter_id: Number(reporterId),
      reported_user_id: Number(reportedUserId),
      reason: reason || 'No reason provided',
      connection_id: connectionId,
      status: 'pending',
      created_at: new Date().toISOString()
    });
    return reportId;
  }
};

const blockOps = {
  async block(blockerId, blockedUserId) {
    const firestore = getDB();
    
    // Check if already blocked
    const snapshot = await firestore.collection('blocked_users')
      .where('from_user_id', '==', Number(blockerId))
      .where('to_user_id', '==', Number(blockedUserId))
      .limit(1).get();
      
    if (!snapshot.empty) return { success: true, alreadyBlocked: true };
    
    const blockId = await getNextId('blocked_users');
    await firestore.collection('blocked_users').doc(String(blockId)).set({
      id: blockId,
      from_user_id: Number(blockerId),
      to_user_id: Number(blockedUserId),
      created_at: new Date().toISOString()
    });
    
    // Also reject any active connections between them
    const connections = await connectionOps.getAllBetween(blockerId, blockedUserId);
    for (const conn of connections) {
      if (['pending', 'accepted'].includes(conn.status)) {
        await firestore.collection('connections').doc(String(conn.id)).update({ status: 'rejected', ended_reason: 'blocked' });
        evictConnection(conn.id); // cache invalidation — status changed due to block
      }
    }
    
    return { success: true };
  },

  async unblock(blockerId, blockedUserId) {
    const firestore = getDB();
    const snapshot = await firestore.collection('blocked_users')
      .where('from_user_id', '==', Number(blockerId))
      .where('to_user_id', '==', Number(blockedUserId))
      .limit(1).get();
    if (!snapshot.empty) {
      await snapshot.docs[0].ref.delete();
    }
    return { success: true };
  },

  async isBlocked(userId1, userId2) {
    const firestore = getDB();
    const snap1 = await firestore.collection('blocked_users')
      .where('from_user_id', '==', Number(userId1))
      .where('to_user_id', '==', Number(userId2))
      .limit(1).get();
    const snap2 = await firestore.collection('blocked_users')
      .where('from_user_id', '==', Number(userId2))
      .where('to_user_id', '==', Number(userId1))
      .limit(1).get();
    return !snap1.empty || !snap2.empty;
  }
};

// ===== Push Subscription Operations =====
const pushOps = {
  async subscribe(userId, subscription) {
    const firestore = getDB();
    const subId = await getNextId('push_subs');
    await firestore.collection('push_subs').doc(String(subId)).set({
      id: subId,
      user_id: Number(userId),
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      created_at: new Date().toISOString()
    });
    return subId;
  },

  async getSubscriptions(userId) {
    const firestore = getDB();
    const snapshot = await firestore.collection('push_subs')
      .where('user_id', '==', Number(userId))
      .get();
    const subs = [];
    snapshot.forEach(doc => subs.push(doc.data()));
    return subs;
  },

  async removeSubscription(endpoint) {
    const firestore = getDB();
    const snapshot = await firestore.collection('push_subs')
      .where('endpoint', '==', endpoint)
      .limit(1).get();
    if (!snapshot.empty) {
      await snapshot.docs[0].ref.delete();
    }
  }
};

// ===== Connection Sweep for Ghost Prevention =====
connectionOps.sweepExpiredRequests = async function() {
  const firestore = getDB();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const snapshot = await firestore.collection('connections')
    .where('status', '==', 'pending')
    .limit(100)
    .get();
  
  let expiredCount = 0;
  const batch = firestore.batch();
  const expiredIds = [];
  
  snapshot.forEach(doc => {
    const conn = doc.data();
    if (conn.created_at < cutoff) {
      batch.update(doc.ref, { status: 'expired', ended_reason: 'timeout' });
      expiredIds.push(conn.id);
      expiredCount++;
    }
  });
  
  await batch.commit();
  // cache invalidation — evict all connections whose status just changed
  for (const id of expiredIds) evictConnection(id);
  return { expiredCount };
};

connectionOps.getAllBetween = async function(userId1, userId2) {
  const firestore = getDB();
  const snap1 = await firestore.collection('connections')
    .where('from_user_id', '==', Number(userId1))
    .where('to_user_id', '==', Number(userId2))
    .get();
  const snap2 = await firestore.collection('connections')
    .where('from_user_id', '==', Number(userId2))
    .where('to_user_id', '==', Number(userId1))
    .get();
  const results = [];
  snap1.forEach(doc => results.push(doc.data()));
  snap2.forEach(doc => results.push(doc.data()));
  return results;
};

module.exports = {
  getDB,
  seedDemoUsers,
  backfillDemoAvatars,
  userOps,
  connectionOps,
  messageOps,
  otpOps,
  invalidateUserCache,
  reportOps,
  blockOps,
  pushOps
};
