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

// Seed demo users if none exist in Cloud Firestore
async function seedDemoUsers() {
  const firestore = getDB();
  const usersColl = firestore.collection('users');
  const snapshot = await usersColl.limit(1).get();
  
  if (!snapshot.empty) {
    console.log('Database already seeded or users exist.');
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
  console.log(`Seeded ${demos.length} demo users in Firestore`);
}

// Kept for compatibility
function backfillDemoAvatars() {}

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
    const doc = await getDB().collection('users').doc(String(id)).get();
    return doc.exists ? doc.data() : null;
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
      reveal_to: 0
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
        reveal_to: 0
      });
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
      const now = new Date().toISOString();
      const vibeDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await connDocRef.update({
        status: 'accepted',
        chat_started_at: now,
        vibe_available_at: vibeDate
      });
      return { success: true, chat_started_at: now, vibe_available_at: vibeDate };
    } else {
      await connDocRef.update({ status: 'rejected' });
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
          active.push({
            ...conn,
            other_username: otherUser.username,
            other_bio: otherUser.bio,
            other_hobbies: otherUser.hobbies,
            other_avatar: otherUser.avatar,
            other_user_id: otherUser.id
          });
        }
      }
    };

    for (const doc of snap1.docs) await pushActive(doc.data());
    for (const doc of snap2.docs) await pushActive(doc.data());
    
    return active.sort((a, b) => b.chat_started_at.localeCompare(a.chat_started_at));
  },

  async getConnection(connectionId, userId) {
    const firestore = getDB();
    const doc = await firestore.collection('connections').doc(String(connectionId)).get();
    if (!doc.exists) return null;
    const conn = doc.data();
    
    if (conn.from_user_id !== Number(userId) && conn.to_user_id !== Number(userId)) {
      return null;
    }
    
    const otherId = conn.from_user_id === Number(userId) ? conn.to_user_id : conn.from_user_id;
    const myId = conn.from_user_id === Number(userId) ? conn.from_user_id : conn.to_user_id;
    
    const otherUser = await userOps.getById(otherId);
    const myUser = await userOps.getById(myId);
    
    if (!otherUser || !myUser) return null;
    
    return {
      ...conn,
      other_username: otherUser.username,
      other_gender: otherUser.gender,
      other_bio: otherUser.bio,
      other_hobbies: otherUser.hobbies,
      other_avatar: otherUser.avatar,
      other_user_id: otherUser.id,
      other_public_key: otherUser.public_key || null,
      my_user_id: myUser.id
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
      await connDocRef.update({ status: 'rejected' });
      return { success: true, match: false, bothVibe: false };
    }

    if (isFrom && conn.from_vibe !== 0) return { error: 'Already voted' };
    if (!isFrom && conn.to_vibe !== 0) return { error: 'Already voted' };

    const field = isFrom ? 'from_vibe' : 'to_vibe';
    await connDocRef.update({ [field]: vibe });

    const updatedDoc = await connDocRef.get();
    const updated = updatedDoc.data();
    const bothVoted = updated.from_vibe > 0 && updated.to_vibe > 0;

    if (bothVoted) {
      const bothVibe = updated.from_vibe === 1 && updated.to_vibe === 1;
      if (bothVibe) {
        const revealDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
        await connDocRef.update({
          reveal_from: 0,
          reveal_to: 0,
          reveal_available_at: revealDate
        });
        return { success: true, match: true, bothVibe: true, reveal_available_at: revealDate };
      } else {
        await connDocRef.update({ status: 'expired' });
        return { success: true, match: false, bothVibe: false };
      }
    }
    return { success: true, bothVote: false };
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

    const updatedDoc = await connDocRef.get();
    const updated = updatedDoc.data();
    const bothRevealed = updated.reveal_from === 1 && updated.reveal_to === 1;

    if (bothRevealed) {
      const otherId = isFrom ? conn.to_user_id : conn.from_user_id;
      const otherUser = await userOps.getById(otherId);
      await connDocRef.update({ status: 'revealed' });
      return { 
        success: true, 
        bothRevealed: true, 
        otherUser: { id: otherUser.id, username: otherUser.username, avatar: otherUser.avatar } 
      };
    }
    return { success: true, bothRevealed: false };
  },
  
  async blockUser(fromId, toId, reason = '') {
    const firestore = getDB();
    try {
      const blockId = `${fromId}_${toId}`;
      await firestore.collection('blocked_users').doc(blockId).set({
        from_user_id: Number(fromId),
        to_user_id: Number(toId),
        reason: reason || '',
        created_at: new Date().toISOString()
      });
      
      // Update any active connections to rejected
      const snap1 = await firestore.collection('connections')
        .where('from_user_id', '==', Number(fromId))
        .where('to_user_id', '==', Number(toId))
        .get();
      const snap2 = await firestore.collection('connections')
        .where('from_user_id', '==', Number(toId))
        .where('to_user_id', '==', Number(fromId))
        .get();
        
      const batch = firestore.batch();
      snap1.forEach(doc => batch.update(doc.ref, { status: 'rejected' }));
      snap2.forEach(doc => batch.update(doc.ref, { status: 'rejected' }));
      await batch.commit();
      
      return { success: true };
    } catch(err) {
      return { error: 'Already blocked or error occurred' };
    }
  },
  
  async sweepExpired() {
    const firestore = getDB();
    const now = new Date().toISOString();
    const snapshot = await firestore.collection('connections')
      .where('status', '==', 'accepted')
      .get();
      
    let vibeExpired = 0;
    let revealsExpired = 0;
    const batch = firestore.batch();
    
    snapshot.forEach(doc => {
      const conn = doc.data();
      if (conn.vibe_available_at && conn.vibe_available_at < now && (conn.from_vibe === 0 || conn.to_vibe === 0)) {
        batch.update(doc.ref, { status: 'rejected' });
        vibeExpired++;
      } else if (conn.reveal_available_at && conn.reveal_available_at < now && (conn.reveal_from === 0 || conn.reveal_to === 0)) {
        batch.update(doc.ref, { status: 'expired' });
        revealsExpired++;
      }
    });
    
    await batch.commit();
    return { vibeExpired, revealsExpired };
  },

  async getConnectionById(connectionId) {
    const doc = await getDB().collection('connections').doc(String(connectionId)).get();
    return doc.exists ? doc.data() : null;
  }
};

// Message operations
const messageOps = {
  async send(connectionId, senderId, content, isVoice = 0, voiceDuration = 0, isEncrypted = 0, iv = null) {
    const firestore = getDB();
    const msgId = await getNextId('messages');
    const msgDocRef = firestore.collection('messages').doc(String(msgId));
    const payload = {
      id: msgId,
      connection_id: Number(connectionId),
      sender_id: Number(senderId),
      content,
      is_voice: Number(isVoice),
      voice_duration: Number(voiceDuration),
      is_encrypted: Number(isEncrypted),
      iv: iv || null,
      created_at: new Date().toISOString()
    };
    await msgDocRef.set(payload);
    return payload;
  },

  async getForConnection(connectionId) {
    const snapshot = await getDB().collection('messages')
      .where('connection_id', '==', Number(connectionId))
      .get();
      
    const messages = [];
    snapshot.forEach(doc => messages.push(doc.data()));
    return messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  async getRecentForConnection(connectionId, limit = 50) {
    const snapshot = await getDB().collection('messages')
      .where('connection_id', '==', Number(connectionId))
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();
      
    const messages = [];
    snapshot.forEach(doc => messages.push(doc.data()));
    return messages.reverse();
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

module.exports = {
  getDB,
  seedDemoUsers,
  backfillDemoAvatars,
  userOps,
  connectionOps,
  messageOps,
  otpOps
};
