// ===== IndexedDB Local Chat Cache (via Dexie) =====
// Provides instant render on chat open + offline outbox + delta sync

const CHAT_CACHE_DB = new Dexie('DeluluChatCache');
CHAT_CACHE_DB.version(1).stores({
  messages: '&id, connection_id, created_at, sender_id',
  pending: '&client_uuid, connection_id, created_at',
  meta: '&key'
});

// Meta keys
const META_LAST_SYNC = (connId) => `last_sync_${connId}`;

// ===== Message Cache =====
const messageCache = {
  async cacheMessages(connectionId, messages) {
    if (!messages || messages.length === 0) return;
    const tx = CHAT_CACHE_DB.transaction('rw', CHAT_CACHE_DB.messages, CHAT_CACHE_DB.meta, async () => {
      // Upsert each message
      for (const m of messages) {
        await CHAT_CACHE_DB.messages.put({
          ...m,
          id: Number(m.id) || m.id,
          connection_id: String(connectionId),
          created_at: m.created_at || new Date().toISOString()
        });
      }
      // Update last sync timestamp
      const times = messages.map(m => m.created_at).filter(Boolean).sort();
      if (times.length > 0) {
        await CHAT_CACHE_DB.meta.put({ key: META_LAST_SYNC(connectionId), value: times[times.length - 1] });
      }
    });
    return tx;
  },

  async cacheSingleMessage(connectionId, msg) {
    if (!msg || !msg.id) return;
    try {
      await CHAT_CACHE_DB.messages.put({
        ...msg,
        id: Number(msg.id),
        connection_id: String(connectionId),
        created_at: msg.created_at || new Date().toISOString()
      });
    } catch (e) {
      // Silently fail cache writes
    }
  },

  async getCachedMessages(connectionId) {
    try {
      // sortBy returns ascending = oldest first (chronological).
      // We then reverse to get newest-first, which is what we need when
      // prepending into the flex-col-reverse chat container (prepend newest
      // first so oldest ends up at visual top and newest at visual bottom).
      const msgs = await CHAT_CACHE_DB.messages
        .where('connection_id')
        .equals(String(connectionId))
        .sortBy('created_at');
      return msgs.reverse();
    } catch (e) {
      return [];
    }
  },

  async getLastMessageTime(connectionId) {
    try {
      const entry = await CHAT_CACHE_DB.meta.get(META_LAST_SYNC(connectionId));
      return entry ? entry.value : null;
    } catch (e) {
      return null;
    }
  }
};

// ===== Offline Outbox Queue =====
const outboxQueue = {
  async enqueue(message) {
    try {
      await CHAT_CACHE_DB.pending.put({
        ...message,
        client_uuid: message.client_uuid || ('out-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
        created_at: message.created_at || new Date().toISOString(),
        retry_count: 0
      });
    } catch (e) {
      console.warn('Outbox enqueue failed:', e);
    }
  },

  async dequeue(clientUuid) {
    try {
      await CHAT_CACHE_DB.pending.delete(clientUuid);
    } catch (e) {}
  },

  async getAllPending(connectionId) {
    try {
      if (connectionId) {
        return await CHAT_CACHE_DB.pending
          .where('connection_id')
          .equals(String(connectionId))
          .toArray();
      }
      return await CHAT_CACHE_DB.pending.toArray();
    } catch (e) {
      return [];
    }
  },

  async flushPending() {
    try {
      const all = await CHAT_CACHE_DB.pending.toArray();
      for (const item of all) {
        // Skip items that have exceeded max retries (5 attempts = permanently failed)
        if ((item.retry_count || 0) >= 5) {
          // Remove permanently failed messages so they don't block the queue
          await outboxQueue.dequeue(item.client_uuid);
          console.warn('Outbox: dropped message after 5 failed retries', item.client_uuid);
          continue;
        }
        
        try {
          const payload = { connection_id: item.connection_id, content: item.content };
          if (item.is_encrypted) {
            payload.is_encrypted = 1;
            payload.iv = item.iv;
          }
          const res = await fetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (res.ok && data.success) {
            await outboxQueue.dequeue(item.client_uuid);
          } else {
            // Increment retry count for non-API errors (server returned error)
            try {
              await CHAT_CACHE_DB.pending.update(item.client_uuid, { retry_count: (item.retry_count || 0) + 1 });
            } catch (e) {}
          }
        } catch (e) {
          // Network failure — increment retry count
          try {
            await CHAT_CACHE_DB.pending.update(item.client_uuid, { retry_count: (item.retry_count || 0) + 1 });
          } catch (innerErr) {}
          console.warn('Outbox flush item failed (will retry):', e);
        }
      }
    } catch (e) {
      console.warn('Outbox flush failed:', e);
    }
  }
};

// ===== Multi-Tab Sync via BroadcastChannel =====
let broadcastChannel = null;

function initBroadcastChannel(connectionId, onEvent) {
  try {
    if (broadcastChannel) broadcastChannel.close();
    broadcastChannel = new BroadcastChannel(`delulu-chat-${connectionId}`);
    broadcastChannel.onmessage = (event) => {
      if (onEvent) onEvent(event.data);
    };
  } catch (e) {
    // BroadcastChannel not supported
  }
}

function broadcastToTabs(data) {
  try {
    if (broadcastChannel) {
      broadcastChannel.postMessage(data);
    }
  } catch (e) {}
}

function closeBroadcastChannel() {
  try {
    if (broadcastChannel) {
      broadcastChannel.close();
      broadcastChannel = null;
    }
  } catch (e) {}
}

// ===== Periodic Outbox Flush =====
// Runs on an interval so pending messages get sent even when no socket is active.
// The interval automatically short-ciruits when the outbox is empty (quick IndexedDB read).
let _outboxFlushInterval = null;

function startOutboxFlush(intervalMs = 15000) {
  stopOutboxFlush();
  _outboxFlushInterval = setInterval(() => {
    outboxQueue.flushPending().catch(() => {});
  }, intervalMs);
}

function stopOutboxFlush() {
  if (_outboxFlushInterval) {
    clearInterval(_outboxFlushInterval);
    _outboxFlushInterval = null;
  }
}
