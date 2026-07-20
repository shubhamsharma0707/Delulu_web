let currentConnId = null;
let currentChatOther = '';
let currentPlayingAudio = null;
let currentPlayingBtn = null;
let myPrivateKey = null;
let otherPublicKey = null;
let sharedSecretKey = null;
let isE2EEActive = false;
let closeModalTimeout = null;
let otherUserId = null;
let otherLastReadAt = null;
let myLastReadAt = null;
let hasReadMessagesInView = false;
let hasUnreadMessagesInView = false;
let lastMessageTimestamp = null;
let hasLoadedInitialMessages = false;
let pollingTimeout = null;
let pollInterval = 8000;
const maxInterval = 30000;

// SSE realtime stream for connection state and message nudges.
// It keeps chat updates instant while avoiding repeated full HTTP polling.
let eventSource = null;
let streamReady = false;
let isReconnecting = false;
let statusPollingTimeout = null;

// Guard to prevent redundant loadChatInfo() calls from SSE reconnection,
// socket connect, and visibilitychange from all firing at once.
let _chatInfoLoading = false;
let _chatInfoQueued = false;

// User Activity Monitoring to prevent wasteful reads when the user is idle
let lastActivityTime = Date.now();
let isIdle = false;

function resetIdleTimer() {
  lastActivityTime = Date.now();
  if (isIdle) {
    isIdle = false;
    console.log('User active — resuming polling fallback');
    pollInterval = 8000;
    scheduleNextPoll();
  }
}

// Activity listeners to track if the user is interacting with the page
['keydown', 'mousemove', 'mousedown', 'touchstart', 'scroll'].forEach(evt => {
  window.addEventListener(evt, resetIdleTimer, { passive: true });
});

function checkUserIdle() {
  // Idle after 60 seconds of no keyboard/mouse/touch activity
  if (Date.now() - lastActivityTime > 60000) {
    isIdle = true;
    return true;
  }
  return false;
}

async function pollDelta() {
  if (!currentConnId) return false;
  try {
    const since = getDeltaSinceParam(lastMessageTimestamp);
    const data = await apiCall(`/api/messages/${currentConnId}${since ? '?since=' + encodeURIComponent(since) : ''}`);
    
    if (data.messages && data.messages.length > 0) {
      const latestMsg = data.messages[data.messages.length - 1];
      if (latestMsg.created_at) {
        lastMessageTimestamp = latestMsg.created_at;
      }
      const cont = document.getElementById('chat-messages');
      const existingIds = new Set();
      cont.querySelectorAll('[data-msg-id]').forEach(el => {
        existingIds.add(el.getAttribute('data-msg-id'));
      });
      
      const newMsgs = data.messages.filter(m => !existingIds.has(String(m.id)));
      if (newMsgs.length > 0) {
        const otherNewMsgs = newMsgs.filter(m => Number(m.sender_id) !== Number(currentUser.id));
        if (otherNewMsgs.length > 0) {
          hasReadMessagesInView = false;
          if (otherNewMsgs.some(isUnreadFromOther)) {
            hasUnreadMessagesInView = true;
          }
        }
        for (const m of newMsgs) {
          await appendMessage(m, false);
        }
        scrollToBottom();
        
        if (typeof messageCache !== 'undefined') {
          await messageCache.cacheMessages(currentConnId, data.messages);
        }
        setTimeout(() => markMessagesAsRead(), 300);
        return true;
      }
    }
  } catch (err) {
    console.error('pollDelta error:', err);
  }
  return false;
}

let _pollInFlight = false;
let _deltaQueued = false;
let _deltaSyncSoonTimeout = null;

function getDeltaSinceParam(timestamp) {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return timestamp;
  return new Date(parsed - 15000).toISOString();
}

async function runDeltaSyncNow() {
  if (_pollInFlight) {
    _deltaQueued = true;
    return false;
  }
  _pollInFlight = true;
  try {
    return await pollDelta();
  } finally {
    _pollInFlight = false;
    if (_deltaQueued) {
      _deltaQueued = false;
      setTimeout(() => runDeltaSyncNow().catch(() => {}), 100);
    }
  }
}

function scheduleDeltaSyncSoon() {
  if (_deltaSyncSoonTimeout) return;
  _deltaSyncSoonTimeout = setTimeout(() => {
    _deltaSyncSoonTimeout = null;
    runDeltaSyncNow().then((hasNew) => {
      if (hasNew) pollInterval = 8000;
    }).catch(() => {});
  }, 75);
}

function scheduleNextPoll() {
  if (pollingTimeout) clearTimeout(pollingTimeout);
  if (socket && socket.connected) return; // Don't poll if socket is alive
  if (streamReady) return; // SSE delivers message events while healthy
  if (document.hidden || checkUserIdle()) return; // Pause entirely if backgrounded or idle
  if (_pollInFlight) {
    // Reschedule for after current poll completes to prevent stacking
    pollingTimeout = setTimeout(scheduleNextPoll, pollInterval);
    return;
  }
  
  pollingTimeout = setTimeout(async () => {
    if (_pollInFlight) return;
    const hasNewMessages = await runDeltaSyncNow();
    // Polling backoff: reset to 8s on activity, double up to 30s on idle
    pollInterval = hasNewMessages
      ? 8000
      : Math.min(pollInterval * 2, maxInterval);
    scheduleNextPoll();
  }, pollInterval);
}

function startPollingFallback() {
  if (socket && socket.connected) return;
  pollInterval = 8000;
  scheduleNextPoll();
}

function stopPollingFallback() {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
}

// ── Firestore Connection Listener ───────────────────────────────────────────
// Replaces HTTP polling for connection state (status, game, reveal fields).
// Subscribes to a single document via onSnapshot — cheap, instant, no race conditions.
// Falls back to polling if Firebase client config is not set.
let _fsSanitizedCache = null;

function clientSanitizeConnection(c, userId) {
  if (!c) return null;
  const isFrom = Number(c.from_user_id) === Number(userId);
  
  const fromIdentityReveal = c.from_identity_reveal !== undefined ? c.from_identity_reveal : (c.reveal_from || 0);
  const toIdentityReveal = c.to_identity_reveal !== undefined ? c.to_identity_reveal : (c.reveal_to || 0);
  const identityRevealAvailable = c.identity_reveal_available_at || c.reveal_available_at || null;
  const faceRevealAvailable = c.face_reveal_available_at || c.reveal_available_at || null;
  
  return {
    ...c,
    identity_reveal_available_at: identityRevealAvailable,
    face_reveal_available_at: faceRevealAvailable,
    my_identity_reveal: isFrom ? fromIdentityReveal : toIdentityReveal,
    other_identity_reveal: isFrom ? toIdentityReveal : fromIdentityReveal,
    both_identity_revealed: fromIdentityReveal === 1 && toIdentityReveal === 1,
    my_face_reveal: isFrom ? (c.from_face_reveal || 0) : (c.to_face_reveal || 0),
    other_face_reveal: isFrom ? (c.to_face_reveal || 0) : (c.from_face_reveal || 0),
    both_face_revealed: (c.from_face_reveal || 0) === 1 && (c.to_face_reveal || 0) === 1,
    face_reveal_declined_by_other: isFrom 
      ? c.face_reveal_declined_by === c.to_user_id 
      : c.face_reveal_declined_by === c.from_user_id
  };
}

function initRealtimeStream() {
  if (!currentConnId || eventSource) return;

  console.log('[SSE] Connecting to real-time event stream...');
  eventSource = new EventSource(resolveUrl(`/api/connections/${currentConnId}/stream`));

  eventSource.onopen = () => {
    console.log('[SSE] Connection established successfully.');
    streamReady = true;
    stopPollingFallback();
    stopStatusPollingFallback();

    // Resync connection state once when reconnecting to capture missed game actions
    if (isReconnecting) {
      console.log('[SSE] Reconnected. Fetching latest chat info to resync state.');
      // Queue via helper to coalesce with any visibilitychange or socket connect call that's also triggering
      scheduleChatInfoRefresh();
      isReconnecting = false;
    }
  };

  eventSource.onmessage = (event) => {
    let streamEvent = { type: event.data };
    try {
      if (event.data && event.data.startsWith('{')) {
        streamEvent = JSON.parse(event.data);
      }
    } catch (e) {
      streamEvent = { type: event.data };
    }

    if (streamEvent.type === 'game') {
      console.log('[SSE] Received game update event. Refreshing chat state...');
      if (Object.prototype.hasOwnProperty.call(streamEvent, 'active_game')) {
        syncActiveGame({
          from_user_id: streamEvent.from_user_id,
          to_user_id: streamEvent.to_user_id,
          active_game: streamEvent.active_game
        });
      } else {
        scheduleChatInfoRefresh();
      }
    } else if (streamEvent.type === 'message') {
      if (Number(streamEvent.senderId) !== Number(currentUser.id)) {
        scheduleDeltaSyncSoon();
      }
    } else if (streamEvent.type === 'messages') {
      console.log('[SSE] Received message update event. Refreshing messages...');
      loadMessages(false, true).catch(() => {});
    } else if (streamEvent.type === 'ended') {
      sessionStorage.setItem('connection_ended_message', 'This chat has ended.');
      window.location.href = 'discover.html';
    }
  };

  eventSource.onerror = () => {
    console.warn('[SSE] EventSource disconnected. Falling back to HTTP status polling.');
    
    streamReady = false;
    isReconnecting = true;
    
    // Start HTTP polling fallback so states update in the interim
    startPollingFallback();
    startStatusPollingFallback();
  };
}

function stopRealtimeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  streamReady = false;
}

// Dedicated connection status polling fallback when SSE stream is not available
function startStatusPollingFallback() {
  if (statusPollingTimeout) clearTimeout(statusPollingTimeout);
  if (streamReady) return;
  if (document.hidden || checkUserIdle()) {
    statusPollingTimeout = setTimeout(startStatusPollingFallback, 6000);
    return;
  }
  
  statusPollingTimeout = setTimeout(async () => {
    if (!streamReady) {
      try {
        await loadChatInfo();
      } catch (e) {}
    }
    startStatusPollingFallback();
  }, 6000); // Poll status every 6 seconds to ensure games and reveals sync dynamically
}

function stopStatusPollingFallback() {
  if (statusPollingTimeout) {
    clearTimeout(statusPollingTimeout);
    statusPollingTimeout = null;
  }
}

// Helper: format relative time for status
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const d = new Date(dateStr);
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

// Helper: create date divider element
function createDateDivider(dateStr) {
  const now = new Date();
  const msgDate = new Date(dateStr);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate());
  const diffDays = Math.floor((today - msgDay) / (1000 * 60 * 60 * 24));
  
  let label;
  if (diffDays === 0) label = 'Today';
  else if (diffDays === 1) label = 'Yesterday';
  else if (diffDays < 7) {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    label = days[msgDate.getDay()];
  } else {
    label = msgDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  
  const div = document.createElement('div');
  div.className = 'flex justify-center my-3 fade-in';
  div.innerHTML = `<span class="px-4 py-1 rounded-full bg-surface-variant/60 text-on-surface-variant text-[11px] font-semibold backdrop-blur-sm">${label}</span>`;
  return div;
}

// Check if message should show read status
function isMessageRead(msg) {
  if (Number(msg.sender_id) !== Number(currentUser.id)) return false; // Only show for own messages
  // If the message is deleted, don't show read status (the field is deleted_at, not deleted)
  if (msg.deleted_at) return false;
  if (otherLastReadAt && msg.created_at) {
    return new Date(msg.created_at) <= new Date(otherLastReadAt);
  }
  return false;
}

function isUnreadFromOther(msg) {
  if (!msg || Number(msg.sender_id) === Number(currentUser.id) || msg.deleted_at) return false;
  if (!myLastReadAt) return true;
  if (!msg.created_at) return false;
  return new Date(msg.created_at) > new Date(myLastReadAt);
}

async function initializeChat() {
  try {
    await requireAuth();
  } catch (err) {
    console.error('initializeChat requireAuth failed:', err);
    return;
  }
  
  const urlParams = new URLSearchParams(window.location.search);
  const connId = urlParams.get('id');
  if (!connId) {
    window.location.href = 'messages.html';
    return;
  }
  
  currentConnId = connId;
  lastMessageTimestamp = null;
  hasLoadedInitialMessages = false;
  loadChatInfo();
  
  // ── Socket setup ──────────────────────────────────────────────────────────
  // We need to guard against duplicate listener registration (e.g. hot module
  // reload or double-call). Socket.io listeners accumulate if not cleaned up.
  function setupChatSocketListeners() {
    if (!socket) return;

    // Remove any previously registered chat-specific listeners to prevent doubles
    socket.off('new-message');
    socket.off('message-reacted');
    socket.off('message-deleted');
    socket.off('messages-read');
    socket.off('user-online');
    socket.off('user-offline');
    socket.off('presence-bulk');
    socket.off('typing');
    socket.off('status_change');
    socket.off('connection-ended');
    socket.off('game_update');

    socket.off('identity-revealed');
    socket.off('face-revealed');
    socket.off('face-reveal-declined');

    socket.on('new-message', (msg) => {
      // Use Number() coercion for safe comparison regardless of int/string type
      if (Number(msg.connection_id) === Number(currentConnId)) {
        if (Number(msg.sender_id) !== Number(currentUser.id)) {
          hasReadMessagesInView = false;
          appendMessage(msg, true);
          markMessagesAsRead();
          
          // Cache incoming message
          if (typeof messageCache !== 'undefined') {
            messageCache.cacheSingleMessage(currentConnId, msg).catch(() => {});
          }
        } else {
          // Update our own sent message: replace temp if needed
          const tempEl = document.querySelector(`[data-temp-id="${msg.tempId || ''}"]`);
          if (tempEl) {
            tempEl.removeAttribute('data-temp-id');
            tempEl.setAttribute('data-msg-id', msg.id);
            
            // Cache our own sent message
            if (typeof messageCache !== 'undefined') {
              messageCache.cacheSingleMessage(currentConnId, msg).catch(() => {});
            }
          }
        }
      }
    });

    socket.on('message-reacted', ({ messageId, reactions }) => {
      const el = document.querySelector(`[data-msg-id="${messageId}"]`);
      if (el) {
        const inner = el.querySelector('.rounded-2xl');
        renderReactions({ id: messageId, reactions }, inner);
      }
    });

    socket.on('message-deleted', ({ messageId }) => {
      const el = document.querySelector(`[data-msg-id="${messageId}"]`);
      if (el) {
        const inner = el.querySelector('.rounded-2xl');
        inner.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'text-[15px] italic opacity-70 break-words';
        p.textContent = 'This message was deleted';
        inner.appendChild(p);
        const timeEl = document.createElement('div');
        timeEl.className = 'text-[10px] mt-1 text-right text-on-surface-variant/70';
        timeEl.textContent = 'deleted';
        inner.appendChild(timeEl);
        const btn = el.querySelector('.more-actions-btn');
        if (btn) btn.remove();
      }
    });

    socket.on('messages-read', (data) => {
      if (data.connectionId == currentConnId) {
        // Use the read timestamp from the server if provided, otherwise fall back to client time
        otherLastReadAt = data.readAt || new Date().toISOString();
        document.querySelectorAll('[data-msg-id]').forEach(el => {
          const statusIcon = el.querySelector('.msg-status-icon');
          if (statusIcon) {
            statusIcon.innerHTML = '<span class="text-[11px] text-blue-500 material-symbols-outlined text-[14px] align-middle" style="font-variation-settings: \'FILL\' 1">done_all</span>';
          }
        });
        if (typeof broadcastToTabs !== 'undefined') {
          broadcastToTabs({ type: 'messages-read', connectionId: currentConnId, at: otherLastReadAt });
        }
      }
    });

    socket.on('user-online', (data) => {
      if (data.userId === otherUserId) {
        const statusEl = document.getElementById('chat-status');
        if (statusEl && !statusEl.querySelector('.animate-pulse')) {
          statusEl.innerHTML = `<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span> Online</span>`;
        }
      }
    });

    socket.on('user-offline', (data) => {
      if (data.userId === otherUserId) {
        const statusEl = document.getElementById('chat-status');
        if (statusEl) statusEl.innerHTML = `Last seen ${formatRelativeTime(data.lastSeen)}`;
      }
    });

    socket.on('presence-bulk', (statuses) => {
      if (otherUserId && statuses[otherUserId] !== undefined) {
        updatePresenceDisplay(statuses[otherUserId]);
      }
    });

    let originalStatus = '';
    socket.on('typing', (data) => {
      if (data.userId !== currentUser.id) {
        const statusEl = document.getElementById('chat-status');
        if (data.isTyping) {
          if (!originalStatus) originalStatus = statusEl.innerHTML;
          statusEl.innerHTML = `<span class="italic animate-pulse">typing...</span>`;
        } else {
          if (originalStatus) { statusEl.innerHTML = originalStatus; originalStatus = ''; }
        }
      }
    });

    socket.on('connection-ended', ({ connectionId, message }) => {
      if (connectionId == currentConnId) {
        // Set sessionStorage guard to prevent Firestore listener from double-alerting
        sessionStorage.setItem('fs_redirected_' + connectionId, '1');
        // Store message for display on the discover page after redirect
        sessionStorage.setItem('connection_ended_message', message);
        window.location.href = 'discover.html';
      }
    });
    
    socket.on('status_change', (data) => {
      if (Number(data.connection_id) === Number(currentConnId)) {
        if (!streamReady) {
          console.log('[Socket] status_change received — updating chat info');
          loadChatInfo();
        }
      }
    });
    

    socket.on('game_update', (data) => {
      const connId = data.connection_id || data.connectionId;
      if (Number(connId) === Number(currentConnId)) {
        console.log('[Socket] game_update received:', data);
        syncActiveGame({
          from_user_id: data.from_user_id,
          to_user_id: data.to_user_id,
          active_game: data.active_game
        });
      }
    });

    socket.on('identity-revealed', (data) => {
      if (data.connection_id == currentConnId) {
        // This event only fires when BOTH have revealed (server condition).
        // Meeting code is always present — show modal and update status directly.
        if (data.meeting_code) showMeetingModal(data.meeting_code);
        
        // Update status bar directly — no API fetch needed
        const statusEl = document.getElementById('chat-status');
        if (statusEl && data.meeting_code) {
          statusEl.innerHTML = `<span class="flex items-center gap-1 text-green-600"><span class="material-symbols-outlined text-[14px]">videocam</span> Meeting ready! <a href="#" onclick="showMeetingModal('${data.meeting_code}'); return false;" class="underline font-semibold">Join</a></span>`;
        }
        // Hide the reveal button since both agreed
        const idBtn = document.getElementById('btn-identity-reveal');
        if (idBtn) idBtn.classList.add('hidden');
      }
    });
    
    socket.on('face-revealed', (data) => {
      if (data.connection_id == currentConnId) {
        // This event only fires when BOTH have revealed (server condition).
        // Meeting code is always present — show modal and update status directly.
        if (data.meeting_code) showMeetingModal(data.meeting_code);
        
        // Update status bar directly — no API fetch needed
        const statusEl = document.getElementById('chat-status');
        if (statusEl && data.meeting_code) {
          statusEl.innerHTML = `<span class="flex items-center gap-1 text-green-600"><span class="material-symbols-outlined text-[14px]">videocam</span> Ready to meet! <a href="#" onclick="showMeetingModal('${data.meeting_code}'); return false;" class="underline font-semibold">Join</a></span>`;
        }
        // Hide the face reveal button since both agreed
        const faceBtn = document.getElementById('btn-face-reveal');
        if (faceBtn) faceBtn.classList.add('hidden');
      }
    });
    
    socket.on('face-reveal-declined', (data) => {
      if (data.connectionId == currentConnId) {
        // Update status directly — no API fetch needed
        const statusEl = document.getElementById('chat-status');
        if (statusEl) statusEl.textContent = 'Face reveal was declined.';
        // Hide the face reveal button
        const faceBtn = document.getElementById('btn-face-reveal');
        if (faceBtn) faceBtn.classList.add('hidden');
        // Show the declined modal
        openModal('modal-face-declined');
      }
    });
  }

  function joinChatRoom() {
    if (!socket || !currentConnId) return;
    socket.emit('join-chat', currentConnId);
    if (typeof outboxQueue !== 'undefined') {
      // flushPending uses fetch internally — socket param is ignored but harmless
      outboxQueue.flushPending().catch(() => {});
    }
    if (typeof initBroadcastChannel !== 'undefined') {
      initBroadcastChannel(currentConnId, (data) => {
        if (data.type === 'messages-read' && data.connectionId == currentConnId) {
          otherLastReadAt = data.at || new Date().toISOString();
          document.querySelectorAll('[data-msg-id]').forEach(el => {
            const statusIcon = el.querySelector('.msg-status-icon');
            if (statusIcon) {
              statusIcon.innerHTML = '<span class="text-[11px] text-blue-500 material-symbols-outlined text-[14px] align-middle" style="font-variation-settings: \'FILL\' 1">done_all</span>';
            }
          });
        }
      });
    }
  }

  if (socket) {
    // Register all message/presence listeners once
    setupChatSocketListeners();

    // Remove previously registered connection-lifecycle listeners (by reference)
    // to prevent duplicate handlers while not affecting other modules' handlers.
    if (window.__chatSocketHandlers) {
      const { onDisconnect, onConnect, onReconnectError, onRoomJoined } = window.__chatSocketHandlers;
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
      socket.off('reconnect_error', onReconnectError);
      socket.off('room-joined', onRoomJoined);
    }

    const onDisconnect = () => {
      const bar = document.getElementById('chat-connection-bar');
      if (bar) {
        bar.classList.remove('hidden');
        const barText = document.getElementById('connection-bar-text');
        if (barText) barText.textContent = 'Reconnecting...';
      }
      startPollingFallback();
    };
    const onConnect = () => {
      const bar = document.getElementById('chat-connection-bar');
      if (bar) bar.classList.add('hidden');
      joinChatRoom();
      stopPollingFallback();
      loadMessages().catch(() => {});
      scheduleChatInfoRefresh();
    };
    const onReconnectError = () => {
      const text = document.getElementById('connection-bar-text');
      if (text) text.textContent = 'Connection lost. Retrying...';
    };
    const onRoomJoined = () => {};

    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    socket.on('reconnect_error', onReconnectError);
    // Store references for cleanup on next initializeChat call
    window.__chatSocketHandlers = { onDisconnect, onConnect, onReconnectError, onRoomJoined };

    // Start polling initially only if socket is not already connected
    if (socket.connected) {
      joinChatRoom();
      stopPollingFallback();
    } else {
      startPollingFallback();
    }

    // Listen for tab/visibility state changes to pause/resume fallback polling.
    if (!window.__chatDomListeners) window.__chatDomListeners = {};
    if (window.__chatDomListeners.visibility) {
      document.removeEventListener('visibilitychange', window.__chatDomListeners.visibility);
    }
    const visibilityHandler = function() {
      if (document.hidden) {
        stopPollingFallback();
      } else {
        resetIdleTimer();
        if (!socket || !socket.connected) {
          startPollingFallback();
        }
        // Restart SSE if it was disconnected while hidden
        initRealtimeStream();
        scheduleChatInfoRefresh();
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
    window.__chatDomListeners.visibility = visibilityHandler;
  } else {
    // No socket at all — run polling fallback
    startPollingFallback();
  }

  // Scroll to bottom button — with duplicate listener cleanup
  const messagesContainer = document.getElementById('chat-messages');
  const scrollBottomBtn = document.getElementById('btn-scroll-bottom');
  
  if (messagesContainer && scrollBottomBtn) {
    // Remove previously registered scroll handler to prevent duplicates
    if (window.__chatDomListeners) {
      const oldScroll = window.__chatDomListeners.scroll;
      if (oldScroll) messagesContainer.removeEventListener('scroll', oldScroll);
    }
    
    const scrollHandler = function() {
      const isNearBottom = messagesContainer.scrollTop > -200;
      if (isNearBottom) {
        scrollBottomBtn.classList.add('opacity-0', 'pointer-events-none');
        scrollBottomBtn.classList.remove('opacity-100', 'pointer-events-auto');
      } else {
        scrollBottomBtn.classList.remove('opacity-0', 'pointer-events-none');
        scrollBottomBtn.classList.add('opacity-100', 'pointer-events-auto');
      }
    };
    messagesContainer.addEventListener('scroll', scrollHandler);
    if (!window.__chatDomListeners) window.__chatDomListeners = {};
    window.__chatDomListeners.scroll = scrollHandler;
    
    scrollBottomBtn.onclick = function() {
      scrollToBottom();
    };
  }
  
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('btn-chat-send');
  const chatMicBtn = document.getElementById('btn-record-voice');
  let typingTimeout = null;

  if (!chatForm || !chatInput || !chatSendBtn || !chatMicBtn) {
    console.error('Chat composer elements are missing; message composer cannot initialize.');
    return;
  }

  // Text input changed (show/hide mic or send buttons)
  chatInput.oninput = () => {
    if (chatInput.value.trim().length > 0) {
      chatSendBtn.classList.remove('hidden');
      chatMicBtn.classList.add('hidden');
    } else {
      chatSendBtn.classList.add('hidden');
      chatMicBtn.classList.remove('hidden');
    }

    // Handle socket typing state
    if (socket) {
      socket.emit('typing', { connectionId: currentConnId, isTyping: true });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        socket.emit('typing', { connectionId: currentConnId, isTyping: false });
      }, 1500);
    }
  };

  chatInput.onblur = () => {
    if (socket) {
      socket.emit('typing', { connectionId: currentConnId, isTyping: false });
    }
  };

  chatForm.onsubmit = async (e) => {
    e.preventDefault();
    const content = chatInput.value.trim();
    if (!content) return;
    
    const tempId = 'temp-' + Date.now();

    // Clear input & buttons instantly
    chatInput.value = '';
    chatSendBtn.classList.add('hidden');
    chatMicBtn.classList.remove('hidden');

    // Append message to UI instantly (Optimistic UI)
    appendMessage({
      tempId,
      is_sending: true,
      sender_id: currentUser.id,
      content,
      is_encrypted: 0,
      created_at: new Date().toISOString()
    }, true);

    if (socket) {
      socket.emit('typing', { connectionId: currentConnId, isTyping: false });
    }

    // Process encryption & API request in the background
    (async () => {
      let payload = { connection_id: currentConnId, content };
      try {
        if (isE2EEActive && sharedSecretKey) {
          const encrypted = await E2EECrypto.encryptMessage(content, sharedSecretKey);
          payload.content = encrypted.ciphertext;
          payload.is_encrypted = 1;
          payload.iv = encrypted.iv;
        }

        // Attempt to send. If API fails, queue for later (no unreliable navigator.onLine check).
        // The try-catch below handles both network errors and API errors gracefully.
        const result = await apiCall('/api/messages/send', 'POST', payload);
        
        // Remove sending state on success and set actual message ID on the element
        const msgEl = document.getElementById(tempId);
        if (msgEl) {
          msgEl.classList.remove('opacity-60');
          if (result && result.message && result.message.id) {
            msgEl.setAttribute('data-msg-id', result.message.id);
            if (result.message.created_at) {
              lastMessageTimestamp = result.message.created_at;
            }
            if (typeof messageCache !== 'undefined') {
              messageCache.cacheSingleMessage(currentConnId, result.message).catch(() => {});
            }
            
            // Update status icon to single checkmark
            const statusIcon = msgEl.querySelector('.msg-status-icon');
            if (statusIcon) {
              statusIcon.innerHTML = '<span class="text-[11px] opacity-70 material-symbols-outlined text-[14px] align-middle">check</span>';
            }
          }
          msgEl.removeAttribute('id');
        }
      } catch (err) {
        console.error('Failed to send message:', err);
        // If it's a network error (fetch failed), try queuing instead
        if (typeof outboxQueue !== 'undefined') {
          try {
            await outboxQueue.enqueue({
              connection_id: currentConnId,
              content: payload.content,
              is_encrypted: payload.is_encrypted || 0,
              iv: payload.iv || null
            });
            const msgEl = document.getElementById(tempId);
            if (msgEl) {
              msgEl.classList.remove('opacity-60');
              msgEl.removeAttribute('id');
              const timeEl = msgEl.querySelector('.text-\\[10px\\]');
              if (timeEl) {
                timeEl.textContent = 'Queued — will send when connected';
                timeEl.className = 'text-[10px] mt-1 text-right text-on-surface-variant/70';
              }
            }
            return;
          } catch (e) {}
        }
        
        const msgEl = document.getElementById(tempId);
        if (msgEl) {
          msgEl.classList.remove('opacity-60');
          const innerEl = msgEl.querySelector('div');
          if (innerEl) {
            innerEl.classList.remove('bg-primary');
            innerEl.classList.add('bg-error/10', 'border', 'border-error/30', 'text-error');
          }
          const timeEl = msgEl.querySelector('.text-\\[10px\\]');
          if (timeEl) {
            timeEl.className = 'text-[10px] mt-1 text-right text-error font-bold flex items-center justify-end gap-0.5';
            timeEl.innerHTML = '<span class="material-symbols-outlined text-[12px]">error</span> Failed';
          }
        }
      }
    })();
  };
  
  // Voice Recording Implementation
  let mediaRecorder = null;
  let audioChunks = [];
  let recordStartTime = 0;
  let recordTimerInterval = null;
  let voiceStream = null; // Hoisted so both mic and cancel handlers can access it
  let _startingRecording = false; // Guard against spam-tapping the mic button

  chatMicBtn.onclick = async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    // Don't start a new recording while the previous one is still cleaning up
    if (_startingRecording) return;
    _startingRecording = true;

    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(voiceStream);
      
      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        _startingRecording = false;
        const duration = Math.round((Date.now() - recordStartTime) / 1000);
        clearInterval(recordTimerInterval);
        document.getElementById('recording-overlay').classList.add('hidden');

        if (voiceStream) {
          voiceStream.getTracks().forEach(track => track.stop());
          voiceStream = null;
        }

        if (audioChunks.length === 0 || duration < 1) {
          return;
        }

        const recordedMimeType = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
        const audioBlob = new Blob(audioChunks, { type: recordedMimeType });
        
        let ext = 'webm';
        if (recordedMimeType.includes('mp4') || recordedMimeType.includes('m4a')) {
          ext = 'm4a';
        } else if (recordedMimeType.includes('wav')) {
          ext = 'wav';
        } else if (recordedMimeType.includes('aac')) {
          ext = 'aac';
        } else if (recordedMimeType.includes('ogg')) {
          ext = 'ogg';
        }

        const formData = new FormData();
        formData.append('connection_id', currentConnId);
        formData.append('duration', duration);

        try {
          if (isE2EEActive && sharedSecretKey) {
            const encrypted = await E2EECrypto.encryptBlob(audioBlob, sharedSecretKey);
            formData.append('audio', encrypted.encryptedBlob, `voice.${ext}`);
            formData.append('is_encrypted', 1);
            formData.append('iv', encrypted.iv);
          } else {
            formData.append('audio', audioBlob, `voice.${ext}`);
          }

          const res = await fetch(resolveUrl('/api/messages/upload-voice'), {
            method: 'POST',
            credentials: 'include',
            body: formData
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to send voice note');
          
          appendMessage(data.message, true);
          if (data.message && data.message.created_at) {
            lastMessageTimestamp = data.message.created_at;
          }
          if (data.message && typeof messageCache !== 'undefined') {
            messageCache.cacheSingleMessage(currentConnId, data.message).catch(() => {});
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      };

      recordStartTime = Date.now();
      mediaRecorder.start();
      
      document.getElementById('recording-overlay').classList.remove('hidden');
      const timerEl = document.getElementById('record-timer');
      timerEl.textContent = '0:00';
      recordTimerInterval = setInterval(() => {
        const elapsed = Math.round((Date.now() - recordStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        timerEl.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }, 1000);

    } catch (err) {
      if (voiceStream) {
        voiceStream.getTracks().forEach(track => track.stop());
      }
      voiceStream = null;
      _startingRecording = false;
      showToast('Could not access microphone: ' + err.message, 'error');
    }
  };

  const recordStopBtn = document.getElementById('btn-record-stop');
  if (recordStopBtn) {
    recordStopBtn.onclick = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    };
  }

  const recordCancelBtn = document.getElementById('btn-record-cancel');
  if (recordCancelBtn) {
    recordCancelBtn.onclick = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.onstop = () => {
          _startingRecording = false;
          clearInterval(recordTimerInterval);
          document.getElementById('recording-overlay').classList.add('hidden');
          // Release the microphone tracks immediately on cancel
          if (voiceStream) {
            voiceStream.getTracks().forEach(track => track.stop());
            voiceStream = null;
          }
        };
        mediaRecorder.stop();
      }
    };
  }
  
  const btnIcebreaker = document.getElementById('btn-icebreaker');
  if (btnIcebreaker) btnIcebreaker.onclick = () => openIcebreakerModal();
  
  const btnChatMore = document.getElementById('btn-chat-more');
  if (btnChatMore) btnChatMore.onclick = () => openModal('modal-chat-more');
  
  const chatThemeToggle = document.getElementById('btn-theme-toggle-chat');
  if (chatThemeToggle) {
    chatThemeToggle.onclick = () => {
      const isDark = document.body.classList.toggle('dark');
      localStorage.setItem('delulu_theme', isDark ? 'dark' : 'light');
      const icon = chatThemeToggle.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = isDark ? 'light_mode' : 'dark_mode';
      const globalToggle = document.getElementById('theme-toggle');
      if (globalToggle) {
        const gi = globalToggle.querySelector('.material-symbols-outlined');
        if (gi) gi.textContent = isDark ? 'light_mode' : 'dark_mode';
      }
    };
    const isDark = document.body.classList.contains('dark');
    const icon = chatThemeToggle.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = isDark ? 'light_mode' : 'dark_mode';
    // Also update the chat-more modal's theme toggle icon to match
    document.querySelectorAll('.theme-toggle-icon').forEach(el => {
      el.textContent = isDark ? 'light_mode' : 'dark_mode';
    });
  }
  
  const btnNotVibing = document.getElementById('btn-not-vibing');
  if (btnNotVibing) btnNotVibing.onclick = () => submitNotVibing();

  const btnIdentityReveal = document.getElementById('btn-identity-reveal');
  if (btnIdentityReveal) btnIdentityReveal.onclick = () => openModal('modal-identity-reveal');
  
  const btnFaceReveal = document.getElementById('btn-face-reveal');
  if (btnFaceReveal) btnFaceReveal.onclick = () => openModal('modal-face-reveal');
  
  const identityRevealYes = document.getElementById('identity-reveal-yes');
  if (identityRevealYes) identityRevealYes.onclick = () => submitIdentityRevealAction();

  const identityRevealNo = document.getElementById('identity-reveal-no');
  if (identityRevealNo) identityRevealNo.onclick = () => { closeModal(); };

  const faceRevealYes = document.getElementById('face-reveal-yes');
  if (faceRevealYes) faceRevealYes.onclick = () => submitFaceRevealAction();

  const faceRevealNo = document.getElementById('face-reveal-no');
  if (faceRevealNo) faceRevealNo.onclick = () => submitDeclineFaceReveal();
  
  const faceDeclinedDisconnect = document.getElementById('face-declined-disconnect');
  if (faceDeclinedDisconnect) faceDeclinedDisconnect.onclick = () => disconnectAfterDecline();

  // Profile Peek trigger
  const chatName = document.getElementById('chat-name');
  if (chatName) {
    chatName.onclick = async () => {
      try {
        const data = await apiCall(`/api/connections/${currentConnId}`);
        const c = data.connection;
        const peekName = document.getElementById('peek-name');
        const peekBio = document.getElementById('peek-bio');
        const peekAvatar = document.getElementById('peek-avatar');
        if (peekName) peekName.textContent = c.other_username;
        if (peekBio) peekBio.textContent = c.other_bio || "No bio set.";
        if (peekAvatar) peekAvatar.innerHTML = getAvatarHtml(c.other_username, c.other_avatar);
        openModal('modal-profile-peek');
      } catch(err) { showToast(err.message, 'error'); }
    };
  }
  // Remove the vibing/not-vibing buttons from profile peek (replaced by header Not Vibing button)
  const peekVibing = document.getElementById('peek-vibing');
  if (peekVibing) peekVibing.remove();

  const peekNotVibing = document.getElementById('peek-not-vibing');
  if (peekNotVibing) peekNotVibing.remove();
  
  // Start periodic outbox flush — works with or without socket.
  // Checks every 15s for pending offline messages and sends them.
  if (typeof startOutboxFlush !== 'undefined') {
    startOutboxFlush(15000);
  }

  // Kick off real-time event stream (SSE) for icebreaker games and status changes
  initRealtimeStream();
}

// Clean up SSE stream and audio blob URLs when navigating away.
// We only use beforeunload (not visibilitychange) to avoid conflicting with
// the polling/SSE visibility handler in initializeChat(). The SSE stream is
// lightweight and can stay open when the tab is hidden — it doesn't cost
// Firestore reads. Polling is paused via the other handler.
function cleanupChatResources() {
  stopRealtimeStream();
  stopStatusPollingFallback();
  // Revoke any pending audio blob URL to prevent memory leaks
  if (currentPlayingAudio) {
    currentPlayingAudio.pause();
    if (currentPlayingAudio._blobUrl) {
      URL.revokeObjectURL(currentPlayingAudio._blobUrl);
    }
    currentPlayingAudio = null;
    currentPlayingBtn = null;
  }
}

window.addEventListener('beforeunload', cleanupChatResources);

// ===== Mark Messages as Read =====
function markMessagesAsRead() {
  if (hasReadMessagesInView || !currentConnId || !hasUnreadMessagesInView) return;
  hasReadMessagesInView = true;
  hasUnreadMessagesInView = false;
  if (socket && !socket.isMock && socket.connected) {
    socket.emit('mark-read', { connectionId: currentConnId });
    return;
  }

  apiCall(`/api/messages/${currentConnId}/read`, 'POST')
    .then((data) => {
      myLastReadAt = data.readAt || new Date().toISOString();
    })
    .catch(() => {
      hasReadMessagesInView = false;
      hasUnreadMessagesInView = true;
    });
}

// ===== Scroll to bottom =====
function scrollToBottom(smooth = false) {
  const cont = document.getElementById('chat-messages');
  if (cont) {
    // With flex-col-reverse, scrollTop=0 shows the visual top (oldest messages).
    // We want the visual bottom (newest messages) — scrollHeight achieves that.
    cont.scrollTo({ top: cont.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
}

// ===== Presence Display =====
function updatePresenceDisplay(isOnline) {
  const statusEl = document.getElementById('chat-status');
  if (!statusEl) return;
  if (isOnline) {
    statusEl.innerHTML = `<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span> Online</span>`;
  }
}

// ===== Modal Event Delegation (setup outside initializeChat so it works even if init fails) =====
function setupModalEventDelegation() {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  
  overlay.addEventListener('click', async (e) => {
    // Click on overlay background (not on a modal) closes modals
    if (e.target === overlay) {
      closeModal();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.preventDefault();
    switch (btn.getAttribute('data-action')) {
      case 'close':
        closeModal();
        break;
      case 'icebreaker-from-chat':
        closeModal();
        setTimeout(() => openIcebreakerModal(), 250);
        break;
      case 'report-from-chat':
        closeModal();
        setTimeout(() => openModal('modal-report'), 250);
        break;
      case 'block-from-chat':
        await blockUser();
        closeModal();
        break;
      case 'submit-report':
        submitReport();
        break;
      case 'toggle-theme':
        document.body.classList.toggle('dark');
        const isDark = document.body.classList.contains('dark');
        localStorage.setItem('delulu_theme', isDark ? 'dark' : 'light');
        document.querySelectorAll('.theme-toggle-icon, #theme-toggle .material-symbols-outlined, #btn-theme-toggle-chat .material-symbols-outlined').forEach(el => {
          el.textContent = isDark ? 'light_mode' : 'dark_mode';
        });
        closeModal();
        break;
    }
  });
}

// Setup modal event delegation with DOM-ready safety
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupModalEventDelegation);
} else {
  setupModalEventDelegation();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeChat);
} else {
  initializeChat();
}

// Coalesce multiple calls to loadChatInfo() — only one in-flight at a time.
// Handles the edge case where SSE reconnection, socket connect, and visibilitychange
// all try to refresh chat info simultaneously (saves Supabase reads on the free tier).
function scheduleChatInfoRefresh() {
  if (_chatInfoLoading) {
    // Already loading — queue one retry for after it completes
    _chatInfoQueued = true;
    return;
  }
  _chatInfoQueued = false;
  _chatInfoLoading = true;
  loadChatInfo().finally(() => {
    _chatInfoLoading = false;
    if (_chatInfoQueued) {
      // Another call came in while we were loading — fire one more refresh
      _chatInfoQueued = false;
      _chatInfoLoading = true;
      loadChatInfo().finally(() => { _chatInfoLoading = false; });
    }
  });
}

async function loadChatInfo() {
  try {
    const data = await apiCall(`/api/connections/${currentConnId}`);
    const c = data.connection;
    currentChatOther = c.other_username;
    otherUserId = c.other_user_id;
    otherLastReadAt = c.other_last_read_at || null;
    myLastReadAt = c.my_last_read_at || null;
    
    // E2EE Key Agreement setup
    const privateKeyJwkStr = window.localStorage.getItem('e2ee_private_key');
    if (privateKeyJwkStr && c.other_public_key) {
      try {
        const privateKeyJwk = JSON.parse(privateKeyJwkStr);
        myPrivateKey = await E2EECrypto.importPrivateKeyFromJwk(privateKeyJwk);
        otherPublicKey = await E2EECrypto.importPublicKeyFromJwk(c.other_public_key);
        sharedSecretKey = await E2EECrypto.deriveSharedSecret(myPrivateKey, otherPublicKey);
        isE2EEActive = true;
        console.log('E2EE is active for this chat!');
      } catch (cryptoErr) {
        console.error('Failed to establish E2EE key agreement:', cryptoErr);
      }
    } else {
      console.log('E2EE fallback: Missing keys. Chatting in plain text.');
    }
    
    // Display lock icon next to name if encrypted
    const chatNameEl = document.getElementById('chat-name');
    if (chatNameEl) {
      chatNameEl.innerHTML = `${escapeHtml(c.other_username)} ${isE2EEActive ? '<span class="material-symbols-outlined text-[15px] text-green-600 align-middle ml-1" title="End-to-End Encrypted" style="font-variation-settings: \'FILL\' 1">lock</span>' : ''}`;
    }
    const chatAvatarEl = document.getElementById('chat-avatar');
    if (chatAvatarEl) {
      chatAvatarEl.innerHTML = getAvatarHtml(c.other_username, c.other_avatar);
    }
    
    updateChatStatus(c);
    const isFirstMessageLoad = !hasLoadedInitialMessages;
    await loadMessages(isFirstMessageLoad);
    hasLoadedInitialMessages = true;
    syncActiveGame(c);
    
    // Scroll to ensure game cards and latest messages are visible
    scrollToBottom();
    
    // Mark messages as read shortly after loading
    setTimeout(() => markMessagesAsRead(), 500);
  } catch (err) {
    console.error('loadChatInfo caught error:', err);
    fetch(resolveUrl('/api/log-error'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ message: err.message, stack: err.stack, path: window.location.href, context: 'loadChatInfo catch' })
    }).catch(() => {});
    
    const chatNameEl = document.getElementById('chat-name');
    if (chatNameEl) chatNameEl.textContent = 'Chat unavailable';
    const statusEl = document.getElementById('chat-status');
    if (statusEl) statusEl.textContent = err.message || 'Something went wrong loading this chat.';
    const cont = document.getElementById('chat-messages');
    if (cont) {
      cont.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full text-center p-6 gap-3">
          <p class="text-on-surface-variant text-sm">${escapeHtml(err.message || 'This chat could not be loaded.')}</p>
          <a href="messages.html" class="text-primary font-semibold text-sm hover:underline">← Back to Messages</a>
        </div>`;
    }
    const chatForm = document.getElementById('chat-form');
    if (chatForm) {
      chatForm.querySelectorAll('input, button').forEach(el => el.disabled = true);
    }
  }
}

function updateChatStatus(c) {
  const statusEl = document.getElementById('chat-status');
  const notVibingBtn = document.getElementById('btn-not-vibing');
  const identityRevealBtn = document.getElementById('btn-identity-reveal');
  const faceRevealBtn = document.getElementById('btn-face-reveal');
  
  if (notVibingBtn) notVibingBtn.classList.add('hidden');
  if (identityRevealBtn) identityRevealBtn.classList.add('hidden');
  if (faceRevealBtn) faceRevealBtn.classList.add('hidden');
  
  if (c.status === 'accepted') {
    const now = Date.now();
    const chatStarted = new Date(c.chat_started_at).getTime();
    const daysSinceChatStarted = Math.floor((now - chatStarted) / (24 * 60 * 60 * 1000));
    
    const isIdentityRevealDue = c.identity_reveal_available_at ? now >= new Date(c.identity_reveal_available_at) : false;
    const isFaceRevealDue = c.face_reveal_available_at ? now >= new Date(c.face_reveal_available_at) : false;
    
    // Show Not Vibing button always (for accepted connections)
    if (notVibingBtn) notVibingBtn.classList.remove('hidden');
    
    if (isFaceRevealDue) {
      // Day 14+: Face Reveal phase
      if (c.both_face_revealed) {
        // Both agreed - show the Google Meet modal
        if (c.meeting_code && !document.getElementById('modal-google-meet').classList.contains('scale-100')) {
          showMeetingModal(c.meeting_code);
        }
        if (statusEl) {
          statusEl.innerHTML = `<span class="flex items-center gap-1 text-green-600"><span class="material-symbols-outlined text-[14px]">videocam</span> Ready to meet! <a href="#" onclick="showMeetingModal('${c.meeting_code}'); return false;" class="underline font-semibold">Join</a></span>`;
        }
      } else if (c.face_reveal_declined_by_other) {
        // Other person declined face reveal - show popup
        if (statusEl) {
          statusEl.textContent = 'Face reveal was declined.';
        }
        if (!document.getElementById('modal-face-declined').classList.contains('scale-100')) {
          openModal('modal-face-declined');
        }
      } else {
        // Show face reveal button
        if (faceRevealBtn) {
          faceRevealBtn.classList.remove('hidden');
          faceRevealBtn.textContent = c.my_face_reveal === 0 ? "Let's Meet" : 'Waiting for them...';
          faceRevealBtn.disabled = c.my_face_reveal === 1;
        }
        if (c.my_face_reveal === 0) {
          // Auto-show the face reveal modal
          const faceModal = document.getElementById('modal-face-reveal');
          if (faceModal && !faceModal.classList.contains('scale-100')) {
            openModal('modal-face-reveal');
          }
        }
        if (statusEl) {
          statusEl.textContent = c.my_face_reveal === 1 
            ? 'Waiting for them to agree to face reveal...' 
            : `Day ${daysSinceChatStarted} - Face reveal available!`;
        }
      }
    } else if (isIdentityRevealDue) {
      // Day 7-13: Identity Reveal phase
      if (c.both_identity_revealed) {
        // Both have revealed - show meeting
        if (c.meeting_code && !document.getElementById('modal-google-meet').classList.contains('scale-100')) {
          showMeetingModal(c.meeting_code);
        }
        if (statusEl) {
          statusEl.innerHTML = `<span class="flex items-center gap-1 text-green-600"><span class="material-symbols-outlined text-[14px]">videocam</span> Meeting ready! <a href="#" onclick="showMeetingModal('${c.meeting_code}'); return false;" class="underline font-semibold">Join</a></span>`;
        }
      } else {
        // Show identity reveal button
        if (identityRevealBtn) {
          identityRevealBtn.classList.remove('hidden');
          identityRevealBtn.textContent = c.my_identity_reveal === 0 ? 'Reveal' : 'Waiting...';
          identityRevealBtn.disabled = c.my_identity_reveal === 1;
        }
        if (c.my_identity_reveal === 0) {
          // Auto-show the identity reveal modal
          const idModal = document.getElementById('modal-identity-reveal');
          if (idModal && !idModal.classList.contains('scale-100')) {
            openModal('modal-identity-reveal');
          }
        }
        if (statusEl) {
          statusEl.textContent = c.my_identity_reveal === 1 
            ? 'Waiting for them to reveal too...' 
            : `Day ${daysSinceChatStarted} - Identity reveal available!`;
        }
      }
    } else {
      // Before Day 7: Just chatting
      const daysUntilIdentity = Math.ceil((new Date(c.identity_reveal_available_at) - now) / (24 * 60 * 60 * 1000));
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-on-surface-variant">Identity reveal in ${daysUntilIdentity}d</span>`;
      }
    }
  } else if (c.status === 'revealed') {
    if (statusEl) statusEl.innerHTML = `<span class="flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">lock_open</span> Identities Revealed</span>`;
  } else {
    if (statusEl) statusEl.textContent = c.status;
  }
}

function showChatSkeleton() {
  const cont = document.getElementById('chat-messages');
  if (!cont) return;
  
  // Generate 6 alternating skeleton chat bubbles (3 from each side)
  cont.innerHTML = '';
  const patterns = [
    { side: 'left', lines: [70, 40] },
    { side: 'right', lines: [55, 85] },
    { side: 'left', lines: [85, 70, 40] },
    { side: 'right', lines: [70] },
    { side: 'left', lines: [55, 85, 55] },
    { side: 'right', lines: [85, 55] },
  ];
  
  patterns.forEach(({ side, lines }) => {
    const wrapper = document.createElement('div');
    wrapper.className = `chat-skeleton-wrapper ${side === 'right' ? 'justify-end' : ''}`;
    
    // Avatar (only shown on left-side messages)
    const avatar = document.createElement('div');
    avatar.className = `chat-skeleton-avatar ${side}`;
    wrapper.appendChild(avatar);
    
    // Bubble
    const bubble = document.createElement('div');
    bubble.className = `chat-skeleton-bubble ${side}`;
    // Apply background color matching message bubble colors
    if (side === 'right') {
      bubble.style.background = 'var(--surface-container-low, #f0eded)';
    } else {
      bubble.style.background = 'var(--surface-container-high, #e4e2e1)';
    }
    
    lines.forEach(width => {
      const line = document.createElement('div');
      line.className = `chat-skeleton-line w-${width}`;
      bubble.appendChild(line);
    });
    
    wrapper.appendChild(bubble);
    cont.appendChild(wrapper);
  });
}

async function loadMessages(isInitial = false, forceFull = false) {
  const cont = document.getElementById('chat-messages');
  if (!cont) return;
  let hasCachedMessages = false;
  try {
    // 1. Render from IndexedDB cache instantly on initial load (no network wait)
    if (isInitial && typeof messageCache !== 'undefined') {
      const cached = await messageCache.getCachedMessages(currentConnId);
      if (cached.length > 0) {
        hasCachedMessages = true;
        // Restore lastMessageTimestamp from cache so the network fetch uses delta sync
        const cacheLastTimestamp = await messageCache.getLastMessageTime(currentConnId);
        if (cacheLastTimestamp && (!lastMessageTimestamp || cacheLastTimestamp > lastMessageTimestamp)) {
          lastMessageTimestamp = cacheLastTimestamp;
        }
        // Preserve game elements (icebreaker cards) when clearing
        // Use a specific data attribute selector to avoid matching non-game elements by accident
        const existingGames = cont.querySelectorAll('[id^="game-"]');
        cont.innerHTML = '';
        lastMessageDate = null;
        for (const m of cached) {
          if (isUnreadFromOther(m)) {
            hasUnreadMessagesInView = true;
            hasReadMessagesInView = false;
          }
          await appendMessage(m, false);
        }
        // Re-prepend game elements so they appear at the bottom (flex-col-reverse)
        existingGames.forEach(el => cont.prepend(el));
        scrollToBottom();
      }
    }
    
    // Only show skeleton on initial load if no cache is present
    if (isInitial && !hasCachedMessages) {
      showChatSkeleton();
    }
    
    // 2. Fetch from server. Initial opens refresh the latest window fully so
    // cached reactions/deletes cannot stay stale; active polling remains delta-based.
    const since = (isInitial || forceFull) ? null : getDeltaSinceParam(lastMessageTimestamp);
    const data = await apiCall(`/api/messages/${currentConnId}${since ? '?since=' + encodeURIComponent(since) : ''}`);
    
    // Clear skeletons if we loaded the initial set from network
    if (isInitial && !hasCachedMessages) {
      cont.innerHTML = '';
    }
    
    if (data.messages && data.messages.length > 0) {
      const existingIds = new Set();
      cont.querySelectorAll('[data-msg-id]').forEach(el => {
        existingIds.add(el.getAttribute('data-msg-id'));
      });

      data.messages.forEach(m => {
        if (existingIds.has(String(m.id))) {
          refreshExistingMessage(m);
        }
      });
      
      const newMsgs = data.messages.filter(m => !existingIds.has(String(m.id)));
      if (newMsgs.length > 0) {
        for (const m of newMsgs) {
          if (isUnreadFromOther(m)) {
            hasUnreadMessagesInView = true;
            hasReadMessagesInView = false;
          }
          await appendMessage(m, false);
        }
        scrollToBottom();
      }
      
      // Cache all messages for next instant render
      if (typeof messageCache !== 'undefined') {
        messageCache.cacheMessages(currentConnId, data.messages).catch(() => {});
      }
    }
    
    // Mark as read after loading
    setTimeout(() => markMessagesAsRead(), 300);
  } catch (err) {
    console.error('loadMessages caught error:', err);
    if (!hasCachedMessages) {
      await fetch(resolveUrl('/api/log-error'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: err.message, stack: err.stack, path: window.location.href, context: 'loadMessages catch' })
      }).catch(() => {});
      cont.innerHTML = `<p class="text-error">${escapeHtml(err.message)}</p>`;
    }
  }
}

function renderReactions(m, parentContainer) {
  if (!parentContainer) return;
  // Remove existing reactions container if any
  const existing = parentContainer.querySelector('.reactions-container');
  if (existing) existing.remove();

  const reactions = m.reactions || {};
  const emojis = Object.keys(reactions);
  if (emojis.length === 0) return;

  const container = document.createElement('div');
  container.className = 'reactions-container flex flex-wrap gap-1 mt-1.5';
  emojis.forEach(emoji => {
    const userIds = reactions[emoji] || [];
    if (userIds.length === 0) return;
    const hasReacted = userIds.some(id => Number(id) === Number(currentUser.id));
    
    const pill = document.createElement('div');
    pill.className = `inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
      hasReacted 
        ? 'bg-primary-container/20 text-primary border-primary/30' 
        : 'bg-surface-container-low text-on-surface-variant border-outline-variant/30 hover:bg-surface-container-high'
    }`;
    pill.innerHTML = `<span>${escapeHtml(emoji)}</span><span class="text-[10px] opacity-80">${userIds.length}</span>`;
    
    pill.onclick = async (e) => {
      e.stopPropagation();
      try {
        await apiCall(`/api/messages/${m.id}/react`, 'POST', { connection_id: currentConnId, emoji });
      } catch (err) { showToast(err.message, 'error'); }
    };
    container.appendChild(pill);
  });
  parentContainer.appendChild(container);
}

function refreshExistingMessage(m) {
  if (!m || !m.id) return false;
  const el = document.querySelector(`[data-msg-id="${m.id}"]`);
  if (!el) return false;
  const inner = el.querySelector('.rounded-2xl');
  if (!inner) return true;

  if (m.deleted_at) {
    inner.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'text-[15px] italic opacity-70 break-words';
    p.textContent = 'This message was deleted';
    inner.appendChild(p);

    const timeEl = document.createElement('div');
    const isMe = Number(m.sender_id) === Number(currentUser.id);
    timeEl.className = `text-[10px] mt-1 text-right ${isMe ? 'text-white/70' : 'text-on-surface-variant/70'}`;
    timeEl.textContent = formatTime(m.created_at);
    inner.appendChild(timeEl);

    const btn = el.querySelector('.more-actions-btn');
    if (btn) btn.remove();
    return true;
  }

  renderReactions(m, inner);
  return true;
}

function showMessageMenu(e, msg, bubbleEl) {
  const btn = e.currentTarget;
  const existing = document.getElementById('message-action-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'message-action-menu';
  menu.className = 'fixed bg-surface shadow-lg rounded-2xl p-2 border border-outline-variant/30 z-50 flex flex-col gap-2 scale-95 opacity-0 transition-all duration-150 ease-out';
  
  const rect = btn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 5}px`;
  if (Number(msg.sender_id) === Number(currentUser.id)) {
    menu.style.right = `${window.innerWidth - rect.right}px`;
  } else {
    menu.style.left = `${rect.left}px`;
  }

  const emojiRow = document.createElement('div');
  emojiRow.className = 'flex gap-1 border-b border-outline-variant/20 pb-2 px-1';
  const emojis = ['😂', '😢', '❤️', '👍', '😮'];
  emojis.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'text-lg hover:scale-125 transition-transform p-1 cursor-pointer';
    btn.textContent = emoji;
    btn.onclick = async () => {        try {
          const result = await apiCall(`/api/messages/${msg.id}/react`, 'POST', { connection_id: currentConnId, emoji });
          if (result && result.reactions) {
            renderReactions({ id: msg.id, reactions: result.reactions }, bubbleEl);
          }
          menu.remove();
        } catch (err) { showToast(err.message, 'error'); }
      };
      emojiRow.appendChild(btn);
    });
    menu.appendChild(emojiRow);

    if (Number(msg.sender_id) === Number(currentUser.id)) {
      const delBtn = document.createElement('button');
    delBtn.className = 'w-full text-left px-3 py-1.5 text-error text-xs font-bold hover:bg-error/10 rounded-lg transition-colors flex items-center gap-2 cursor-pointer';
    delBtn.innerHTML = '<span class="material-symbols-outlined text-sm">delete</span> Delete Message';
    delBtn.onclick = async () => {
      if (confirm('Are you sure you want to delete this message? This cannot be undone.')) {
        try {
          await apiCall(`/api/messages/${msg.id}`, 'DELETE', { connection_id: currentConnId });
          bubbleEl.innerHTML = '';
          const p = document.createElement('p');
          p.className = 'text-[15px] italic opacity-70 break-words';
          p.textContent = 'This message was deleted';
          bubbleEl.appendChild(p);
          const timeEl = document.createElement('div');
          timeEl.className = 'text-[10px] mt-1 text-right text-white/70';
          timeEl.textContent = 'deleted';
          bubbleEl.appendChild(timeEl);
          const wrapper = bubbleEl.closest('[data-msg-id]');
          const moreBtn = wrapper ? wrapper.querySelector('.more-actions-btn') : null;
          if (moreBtn) moreBtn.remove();
          menu.remove();
        } catch (err) { showToast(err.message, 'error'); }
      }
    };
    menu.appendChild(delBtn);
  }

  document.body.appendChild(menu);
  
  setTimeout(() => {
    menu.classList.remove('scale-95', 'opacity-0');
    menu.classList.add('scale-100', 'opacity-100');
  }, 10);

  const closeHandler = (event) => {
    if (!menu.contains(event.target) && !btn.contains(event.target)) {
      menu.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closeHandler);
  }, 50);
}

let lastMessageDate = null;

async function appendMessage(m, scrollToBottom = true) {
  const cont = document.getElementById('chat-messages');
  if (!cont || !m) return;
  if (m.id) {
    const existing = document.querySelector(`[data-msg-id="${m.id}"]`);
    if (existing) {
      refreshExistingMessage(m);
      return;
    }
  }
  const isMe = Number(m.sender_id) === Number(currentUser.id);
  const time = formatTime(m.created_at);
  
  // Add date divider if date changed
  if (m.created_at) {
    if (m.id && !m.is_sending && (!lastMessageTimestamp || new Date(m.created_at) > new Date(lastMessageTimestamp))) {
      lastMessageTimestamp = m.created_at;
    }
    const msgDate = new Date(m.created_at).toDateString();
    if (msgDate !== lastMessageDate) {
      lastMessageDate = msgDate;
      const divider = createDateDivider(m.created_at);
      cont.prepend(divider);
    }
  }
  
  const div = document.createElement('div');
  div.className = `flex group items-end gap-2 ${isMe ? 'justify-end' : 'justify-start'} w-full fade-in mb-1`;
  if (m.id) div.setAttribute('data-msg-id', m.id);
  if (m.tempId) div.id = m.tempId;
  if (m.is_sending) div.classList.add('opacity-60');
  
  const inner = document.createElement('div');
  inner.className = `max-w-[75%] rounded-2xl p-3 relative ${isMe ? 'bg-primary text-white rounded-tr-sm shadow-sm' : 'bg-surface-container-low text-on-surface rounded-tl-sm shadow-sm border border-outline-variant/10'}`;
  
  if (m.deleted_at !== null && m.deleted_at !== undefined) {
    const p = document.createElement('p');
    p.className = 'text-[15px] italic opacity-70 break-words';
    p.textContent = 'This message was deleted';
    inner.appendChild(p);
    
    const timeEl = document.createElement('div');
    timeEl.className = `text-[10px] mt-1 text-right ${isMe ? 'text-white/70' : 'text-on-surface-variant/70'}`;
    timeEl.textContent = time;
    inner.appendChild(timeEl);
    
    div.appendChild(inner);
    cont.prepend(div);
    if (scrollToBottom) cont.scrollTop = cont.scrollHeight;
    return;
  }

  // Decrypt content if it is E2EE encrypted
  const isEncrypted = Number(m.is_encrypted) === 1;
  let displayContent = m.content || '';
  
  if (isEncrypted && displayContent && !displayContent.startsWith('/uploads/')) {
    if (isE2EEActive && sharedSecretKey && m.iv) {
      try {
        displayContent = await E2EECrypto.decryptMessage(displayContent, m.iv, sharedSecretKey);
      } catch (decErr) {
        console.error('Decryption failed:', decErr);
        displayContent = '[Unable to decrypt message on this device]';
      }
    } else {
      displayContent = '[Encrypted message]';
    }
  }

  // Handle voice messages
  if (Number(m.is_voice) === 1 || (displayContent && displayContent.startsWith('/uploads/voice/'))) {
    // Custom audio player
    const voiceContainer = document.createElement('div');
    voiceContainer.className = `flex items-center gap-3 p-0.5 ${isMe ? 'text-white' : 'text-on-surface'}`;
    
    const playBtn = document.createElement('button');
    playBtn.className = `w-9 h-9 rounded-full flex items-center justify-center shadow-sm shrink-0 transition-transform hover:scale-105 active:scale-95 ${isMe ? 'bg-white text-primary' : 'bg-primary text-white'}`;
    playBtn.innerHTML = `<span class="material-symbols-outlined text-lg">play_arrow</span>`;
    playBtn.onclick = () => {
      window.playVoiceNote(playBtn, displayContent, m.is_encrypted, m.iv);
    };

    const details = document.createElement('div');
    details.className = 'flex flex-col';
    
    const label = document.createElement('span');
    label.className = 'text-xs font-bold flex items-center gap-0.5';
    label.innerHTML = `Voice Note ${isEncrypted ? '<span class="material-symbols-outlined text-[10px] text-green-600 align-middle">lock</span>' : ''}`;
    
    const dur = document.createElement('span');
    dur.className = 'text-[9px] opacity-70';
    dur.textContent = `${m.voice_duration || 0}s`;
    
    details.appendChild(label);
    details.appendChild(dur);
    
    voiceContainer.appendChild(playBtn);
    voiceContainer.appendChild(details);
    inner.appendChild(voiceContainer);
  } else {
    const p = document.createElement('p');
    p.className = 'text-[15px] leading-relaxed break-words flex items-end gap-1.5';
    p.textContent = displayContent;
    if (isEncrypted) {
      p.innerHTML += ` <span class="material-symbols-outlined text-[12px] text-green-600 self-center" title="End-to-End Encrypted">lock</span>`;
    }
    inner.appendChild(p);
  }
  
  // Time + Status row
  const metaRow = document.createElement('div');
  metaRow.className = `text-[10px] mt-1 text-right flex items-center justify-end gap-0.5 ${isMe ? 'text-white/70' : 'text-on-surface-variant/70'}`;
  
  const timeSpan = document.createElement('span');
  timeSpan.textContent = time;
  metaRow.appendChild(timeSpan);
  
  // Message status icon (for own messages)
  // Use deleted_at instead of the old field name 'deleted' which no longer exists
  if (isMe && !m.is_sending && !m.deleted_at) {
    const statusSpan = document.createElement('span');
    statusSpan.className = 'msg-status-icon inline-flex items-center';
    const read = isMessageRead(m);
    statusSpan.innerHTML = read 
      ? '<span class="text-[11px] text-blue-500 material-symbols-outlined text-[14px] align-middle" style="font-variation-settings: \'FILL\' 1">done_all</span>'
      : '<span class="text-[11px] opacity-70 material-symbols-outlined text-[14px] align-middle">check</span>';
    metaRow.appendChild(statusSpan);
  } else if (m.is_sending) {
    const statusSpan = document.createElement('span');
    statusSpan.className = 'msg-status-icon inline-flex items-center';
    statusSpan.innerHTML = '<span class="text-[11px] opacity-50 material-symbols-outlined text-[14px]">schedule</span>';
    metaRow.appendChild(statusSpan);
  }
  
  inner.appendChild(metaRow);
  
  renderReactions(m, inner);
  
  const actionsBtn = document.createElement('button');
  actionsBtn.className = 'more-actions-btn p-1 hover:bg-surface-container rounded-full text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer flex items-center justify-center shrink-0 self-end mb-1';
  actionsBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">more_vert</span>';
  actionsBtn.onclick = (e) => {
    e.stopPropagation();
    const currentId = div.getAttribute('data-msg-id');
    if (!currentId) {
      showToast('Please wait for the message to finish sending.');
      return;
    }
    const currentMsg = { ...m, id: Number(currentId) };
    showMessageMenu(e, currentMsg, inner);
  };

  if (isMe) {
    div.appendChild(actionsBtn);
    div.appendChild(inner);
  } else {
    div.appendChild(inner);
    div.appendChild(actionsBtn);
  }
  
  cont.prepend(div);
  
  if (scrollToBottom) {
    cont.scrollTo({ top: cont.scrollHeight, behavior: 'auto' });
  }
  
  // Write to IndexedDB cache after rendering
  if (m.id && typeof messageCache !== 'undefined') {
    messageCache.cacheSingleMessage(currentConnId, m).catch(() => {});
  }
}

window.playVoiceNote = async (btn, url, isEncrypted = 0, iv = null) => {
  const icon = btn.querySelector('span');
  
  if (currentPlayingAudio) {
    currentPlayingAudio.pause();
    if (currentPlayingBtn) {
      currentPlayingBtn.querySelector('span').textContent = 'play_arrow';
    }
    
    if (currentPlayingAudio._originalUrl === url) {
      currentPlayingAudio = null;
      currentPlayingBtn = null;
      return;
    }
  }

  icon.textContent = 'hourglass_bottom';
  
  try {
    let playUrl = resolveUrl(url);
    
    // Decrypt the voice note blob dynamically in memory if encrypted
    if (Number(isEncrypted) === 1 && iv && isE2EEActive && sharedSecretKey) {
      const res = await fetch(resolveUrl(url), {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to fetch encrypted voice note file');
      const encryptedBuffer = await res.arrayBuffer();
      
      // Determine original recording MIME type from the file URL's extension
      let mimeType = 'audio/webm';
      if (url.endsWith('.m4a') || url.endsWith('.mp4')) {
        mimeType = 'audio/mp4';
      } else if (url.endsWith('.wav')) {
        mimeType = 'audio/wav';
      } else if (url.endsWith('.aac')) {
        mimeType = 'audio/aac';
      } else if (url.endsWith('.ogg')) {
        mimeType = 'audio/ogg';
      }

      const decryptedBlob = await E2EECrypto.decryptBlob(encryptedBuffer, iv, sharedSecretKey, mimeType);
      playUrl = URL.createObjectURL(decryptedBlob);
    }

    const audio = new Audio(playUrl);
    audio._originalUrl = url;
    if (playUrl.startsWith('blob:')) {
      audio._blobUrl = playUrl; // Store for cleanup on navigation
    }
    currentPlayingAudio = audio;
    currentPlayingBtn = btn;
    
    audio.onplay = () => { icon.textContent = 'pause'; };
    audio.onpause = () => { icon.textContent = 'play_arrow'; };
    audio.onended = () => {
      icon.textContent = 'play_arrow';
      currentPlayingAudio = null;
      currentPlayingBtn = null;
      if (playUrl.startsWith('blob:')) {
        URL.revokeObjectURL(playUrl); // Clean up memory
      }
    };
    
    await audio.play();
  } catch (err) {
    console.error('Audio play failed:', err);
    icon.textContent = 'play_arrow';
    showToast('Failed to play voice note: ' + err.message, 'error');
  }
};

window.openModal = function(id) {
  // Cancel any pending close animation to prevent race condition
  if (closeModalTimeout) {
    clearTimeout(closeModalTimeout);
    closeModalTimeout = null;
  }
  const overlay = document.getElementById('modal-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
  }
  const m = document.getElementById(id);
  if (m) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.remove('scale-95');
      m.classList.add('scale-100');
    }, 10);
  }
};

function setAllModalsHidden(hidden) {
  ['modal-identity-reveal', 'modal-face-reveal', 'modal-face-declined', 'modal-google-meet', 'modal-profile-peek', 'modal-icebreaker', 'modal-report', 'modal-chat-more'].forEach(id => {
    const m = document.getElementById(id);
    if (m) {
      if (hidden) {
        m.classList.add('hidden');
      } else {
        m.classList.remove('hidden');
      }
    }
  });
}

window.closeModal = function() {
  // Cancel any pending close animation
  if (closeModalTimeout) {
    clearTimeout(closeModalTimeout);
    closeModalTimeout = null;
  }
  const overlay = document.getElementById('modal-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
  }
  ['modal-identity-reveal', 'modal-face-reveal', 'modal-face-declined', 'modal-google-meet', 'modal-profile-peek', 'modal-icebreaker', 'modal-report', 'modal-chat-more'].forEach(id => {
    const m = document.getElementById(id);
    if (m) {
      m.classList.remove('scale-100');
      m.classList.add('scale-95');
    }
  });
  // Hide modals after short animation completes
  closeModalTimeout = setTimeout(() => {
    setAllModalsHidden(true);
    closeModalTimeout = null;
  }, 200);
};

async function submitNotVibing() {
  if (!confirm('Are you sure you want to end this chat? This cannot be undone.')) return;
  try {
    await apiCall('/api/connections/end', 'POST', { connection_id: currentConnId });
    window.location.href = 'discover.html';
  } catch(err) { showToast(err.message, 'error'); }
}

async function submitIdentityRevealAction() {
  try {
    const data = await apiCall('/api/connections/identity-reveal', 'POST', { connection_id: currentConnId });
    closeModal();
    if (data.bothRevealed && data.meeting_code) {
      showMeetingModal(data.meeting_code);
    }
    loadChatInfo();
  } catch(err) { showToast(err.message, 'error'); }
}

async function submitFaceRevealAction() {
  try {
    const data = await apiCall('/api/connections/face-reveal', 'POST', { connection_id: currentConnId });
    closeModal();
    if (data.bothRevealed && data.meeting_code) {
      showMeetingModal(data.meeting_code);
    }
    loadChatInfo();
  } catch(err) { showToast(err.message, 'error'); }
}

async function submitDeclineFaceReveal() {
  try {
    closeModal();
    await apiCall('/api/connections/decline-face-reveal', 'POST', { connection_id: currentConnId });
    loadChatInfo();
  } catch(err) { showToast(err.message, 'error'); }
}

async function disconnectAfterDecline() {
  try {
    closeModal();
    await apiCall('/api/connections/end-after-decline', 'POST', { connection_id: currentConnId });
    window.location.href = 'discover.html';
  } catch(err) { showToast(err.message, 'error'); }
}

function showMeetingModal(meetingCode) {
  const linkBtn = document.getElementById('meet-link-btn');
  if (linkBtn) {
    linkBtn.href = `https://meet.google.com/${meetingCode}`;
  }
  openModal('modal-google-meet');
}

// ===== Icebreaker Games =====
const GAME_QUESTIONS = {
  'would-you-rather': [
    { q: 'Travel to the past or the future?', a: 'Past', b: 'Future' },
    { q: 'Live in the mountains or by the beach?', a: 'Mountains', b: 'Beach' },
    { q: 'Be an early bird or a night owl?', a: 'Early bird', b: 'Night owl' },
    { q: 'Read the book or watch the movie?', a: 'Book', b: 'Movie' },
    { q: 'Cook a feast or order takeout?', a: 'Cook', b: 'Takeout' },
    { q: 'Have super strength or super speed?', a: 'Strength', b: 'Speed' },
    { q: 'Be famous or be happy?', a: 'Famous', b: 'Happy' },
    { q: 'Explore space or the deep ocean?', a: 'Space', b: 'Ocean' },
    { q: 'Always be 10 min late or 20 min early?', a: 'Late', b: 'Early' },
    { q: 'Have a pet dinosaur or a pet dragon?', a: 'Dinosaur', b: 'Dragon' },
    { q: 'Win $1,000,000 or find true love?', a: 'Money', b: 'Love' },
    { q: 'Go without phone for a week or without coffee/tea?', a: 'No Phone', b: 'No Caffeine' },
    { q: 'Only eat sweet foods or only spicy foods?', a: 'Sweet', b: 'Spicy' },
    { q: 'Have a private chef or a personal driver?', a: 'Chef', b: 'Driver' },
    { q: 'Never have to sleep or never have to work?', a: 'No Sleep', b: 'No Work' },
    { q: 'Have the ability to fly or be invisible?', a: 'Fly', b: 'Invisible' },
    { q: 'Sing karaoke or do stand-up comedy?', a: 'Karaoke', b: 'Comedy' },
    { q: 'Live in a tiny house in nature or a giant penthouse?', a: 'Tiny House', b: 'Penthouse' },
    { q: 'Have a time machine or a teleportation device?', a: 'Time Machine', b: 'Teleporter' },
    { q: 'Be a wizard or a superhero?', a: 'Wizard', b: 'Superhero' },
    { q: 'Be able to read minds or speak all languages?', a: 'Read Minds', b: 'All Languages' },
    { q: 'Go on a fancy dinner date or a cozy picnic?', a: 'Dinner Date', b: 'Cozy Picnic' },
    { q: 'Only watch horror movies or only watch rom-coms?', a: 'Horror', b: 'Rom-Com' },
    { q: 'Travel to a new country monthly or stay in your dream home?', a: 'Travel', b: 'Dream Home' },
    { q: 'Work dream job with low pay or boring job with huge pay?', a: 'Dream/Low Pay', b: 'Boring/Huge Pay' },
    { q: 'Always speak your mind or never speak again?', a: 'Always Speak', b: 'Never Speak' },
    { q: 'Wear sweatpants everywhere or formal clothes everywhere?', a: 'Sweatpants', b: 'Formal' },
    { q: 'Travel alone or travel with a group?', a: 'Alone', b: 'Group' },
    { q: 'Have a talking pet or a flying car?', a: 'Talking Pet', b: 'Flying Car' },
    { q: 'Be incredibly smart or incredibly lucky?', a: 'Smart', b: 'Lucky' },
    { q: 'Go skydiving or deep sea diving?', a: 'Skydiving', b: 'Sea Diving' },
    { q: 'Live without internet or live without music?', a: 'No Internet', b: 'No Music' },
    { q: 'Only communicate in emojis or only in whispers?', a: 'Emojis', b: 'Whispers' },
    { q: 'Be a famous musician or a famous actor?', a: 'Musician', b: 'Actor' },
    { q: 'Win an Olympic gold medal or a Nobel Prize?', a: 'Gold Medal', b: 'Nobel Prize' },
    { q: 'Travel to Mars or live under the sea?', a: 'Mars', b: 'Undersea' },
    { q: 'Always have to tell the truth or always have to lie?', a: 'Truth', b: 'Lie' },
    { q: 'Be the funniest person or the smartest?', a: 'Funniest', b: 'Smartest' },
    { q: 'Clean house/messy room or messy house/clean room?', a: 'Clean House', b: 'Clean Room' },
    { q: 'Have a rewind button or a pause button for life?', a: 'Rewind', b: 'Pause' },
    { q: 'Read minds or see the future?', a: 'Read Minds', b: 'See Future' },
    { q: 'Play video games all day or hike in the woods?', a: 'Video Games', b: 'Hike' },
    { q: 'Walk on hot coals or swim with sharks?', a: 'Hot Coals', b: 'Sharks' },
    { q: 'Love job/annoying peers or hate job/best friend peers?', a: 'Love Job', b: 'Best Friends' },
    { q: 'Lose the ability to taste or the ability to smell?', a: 'No Taste', b: 'No Smell' },
    { q: 'Wake up with new hair color daily or new eye color?', a: 'Hair Color', b: 'Eye Color' },
    { q: 'Dance every time you hear music or sing along?', a: 'Dance', b: 'Sing Along' },
    { q: 'Be expert at every instrument or every sport?', a: 'Instruments', b: 'Sports' },
    { q: 'Have a house with a huge pool or a huge home theater?', a: 'Pool', b: 'Home Theater' },
    { q: 'Never use social media again or never watch TV?', a: 'No Socials', b: 'No TV' },
    { q: 'Go on an adventurous road trip or a luxury cruise?', a: 'Road Trip', b: 'Luxury Cruise' },
    { q: 'Be able to freeze time or speed up time?', a: 'Freeze Time', b: 'Speed Time' },
    { q: 'Wake up early for sunrise or stay up late for stars?', a: 'Sunrise', b: 'Stars' },
    { q: 'Only eat pizza for a year or only eat burgers?', a: 'Pizza Only', b: 'Burgers Only' },
    { q: 'Be a master chef or a master detective?', a: 'Master Chef', b: 'Detective' },
    { q: 'Have conversation with future self or past self?', a: 'Future Self', b: 'Past Self' },
    { q: 'Have unlimited energy or unlimited sleep?', a: 'Energy', b: 'Sleep' },
    { q: 'Be able to change height or change voice?', a: 'Height', b: 'Voice' },
    { q: 'Go to wild music festival or quiet cabin retreat?', a: 'Festival', b: 'Cabin' }
  ],
  'this-or-that': [
    { q: 'Coffee or Tea?', a: 'Coffee', b: 'Tea' },
    { q: 'Pizza or Burger?', a: 'Pizza', b: 'Burger' },
    { q: 'Sweet or Spicy?', a: 'Sweet', b: 'Spicy' },
    { q: 'Netflix or YouTube?', a: 'Netflix', b: 'YouTube' },
    { q: 'Cats or Dogs?', a: 'Cats', b: 'Dogs' },
    { q: 'Summer or Winter?', a: 'Summer', b: 'Winter' },
    { q: 'City or Nature?', a: 'City', b: 'Nature' },
    { q: 'Beach or Pool?', a: 'Beach', b: 'Pool' },
    { q: 'Text or Call?', a: 'Text', b: 'Call' },
    { q: 'Instagram or TikTok?', a: 'Instagram', b: 'TikTok' },
    { q: 'iOS or Android?', a: 'iOS', b: 'Android' },
    { q: 'Morning or Night?', a: 'Morning', b: 'Night' },
    { q: 'Dine-in or Takeout?', a: 'Dine-in', b: 'Takeout' },
    { q: 'Dark chocolate or Milk chocolate?', a: 'Dark Chocolate', b: 'Milk Chocolate' },
    { q: 'Plan everything or Wing it?', a: 'Plan Everything', b: 'Wing It' },
    { q: 'Pop or Rock music?', a: 'Pop', b: 'Rock' },
    { q: 'Books or Podcasts?', a: 'Books', b: 'Podcasts' },
    { q: 'Comedy or Drama?', a: 'Comedy', b: 'Drama' },
    { q: 'Beer or Wine?', a: 'Beer', b: 'Wine' },
    { q: 'Casual wear or Dressed up?', a: 'Casual Wear', b: 'Dressed Up' },
    { q: 'Concert or Movie theater?', a: 'Concert', b: 'Movie Theater' },
    { q: 'Board games or Video games?', a: 'Board Games', b: 'Video Games' },
    { q: 'Road trip or Flight?', a: 'Road Trip', b: 'Flight' },
    { q: 'Rainy days or Sunny days?', a: 'Rainy Days', b: 'Sunny Days' },
    { q: 'Hot tub or Cold plunge?', a: 'Hot Tub', b: 'Cold Plunge' },
    { q: 'Sneakers or Boots?', a: 'Sneakers', b: 'Boots' },
    { q: 'Pancakes or Waffles?', a: 'Pancakes', b: 'Waffles' },
    { q: 'Tattoos or Piercings?', a: 'Tattoos', b: 'Piercings' },
    { q: 'Physical books or E-books?', a: 'Physical Books', b: 'E-Books' },
    { q: 'Staying in or Going out?', a: 'Staying In', b: 'Going Out' },
    { q: 'Talking or Listening?', a: 'Talking', b: 'Listening' },
    { q: 'Rollercoasters or Water slides?', a: 'Rollercoasters', b: 'Water Slides' },
    { q: 'Theme park or Museum?', a: 'Theme Park', b: 'Museum' },
    { q: 'Pasta or Sushi?', a: 'Pasta', b: 'Sushi' },
    { q: 'Left brain or Right brain?', a: 'Left Brain', b: 'Right Brain' },
    { q: 'Sunrise or Sunset?', a: 'Sunrise', b: 'Sunset' },
    { q: 'Marvel or DC?', a: 'Marvel', b: 'DC' },
    { q: 'Chocolate or Vanilla?', a: 'Chocolate', b: 'Vanilla' },
    { q: 'Pepsi or Coke?', a: 'Pepsi', b: 'Coke' },
    { q: 'Star Wars or Star Trek?', a: 'Star Wars', b: 'Star Trek' },
    { q: 'Live music or Studio recordings?', a: 'Live Music', b: 'Studio' },
    { q: 'Mountains or Oceans?', a: 'Mountains', b: 'Oceans' },
    { q: 'Big party or Small gathering?', a: 'Big Party', b: 'Small Gathering' },
    { q: 'Silver or Gold jewelry?', a: 'Silver', b: 'Gold' },
    { q: 'Reality TV or Documentaries?', a: 'Reality TV', b: 'Documentary' },
    { q: 'Modern decor or Vintage/Retro?', a: 'Modern Decor', b: 'Vintage/Retro' },
    { q: 'Hot coffee or Iced coffee?', a: 'Hot Coffee', b: 'Iced Coffee' },
    { q: 'Tacos or Nachos?', a: 'Tacos', b: 'Nachos' },
    { q: 'Cooking or Baking?', a: 'Cooking', b: 'Baking' },
    { q: 'Fruit or Veggies?', a: 'Fruit', b: 'Veggies' },
    { q: 'Long hair or Short hair?', a: 'Long Hair', b: 'Short Hair' },
    { q: 'Traveling abroad or Staycation?', a: 'Traveling Abroad', b: 'Staycation' },
    { q: 'Amusement park or Zoo?', a: 'Amusement Park', b: 'Zoo' },
    { q: 'Bubble bath or Hot shower?', a: 'Bubble Bath', b: 'Hot Shower' },
    { q: 'Ice cream cone or Ice cream tub?', a: 'Ice Cream Cone', b: 'Ice Cream Tub' },
    { q: 'Smart casual or Athleisure?', a: 'Smart Casual', b: 'Athleisure' }
  ],
  'truths-lie': []
};

let currentGame = null;
let gameTimeout = null;
// Minimum lifetime for game cards (in ms). Prevents transient Firestore snapshot
// races from removing a game card that was just created.
const GAME_CARD_MIN_LIFETIME = 3000;
let _gameCardCreatedAt = 0;

function openIcebreakerModal() {
  openModal('modal-icebreaker');
  const gamesList = document.getElementById('icebreaker-games-list');
  if (!gamesList) return;
  gamesList.innerHTML = `
    <button data-game="would-you-rather" class="w-full text-left p-3 rounded-xl bg-surface-container-low hover:bg-surface-container-high transition-colors">
      <span class="font-bold">Would You Rather</span>
      <p class="text-xs text-on-surface-variant mt-1">Classic icebreaker — pick your poison!</p>
    </button>
    <button data-game="this-or-that" class="w-full text-left p-3 rounded-xl bg-surface-container-low hover:bg-surface-container-high transition-colors">
      <span class="font-bold">⚡ This or That</span>
      <p class="text-xs text-on-surface-variant mt-1">Quick preferences — compare your tastes!</p>
    </button>
    <button data-game="question" class="w-full text-left p-3 rounded-xl bg-surface-container-low hover:bg-surface-container-high transition-colors">
      <span class="font-bold">❓ Random Question</span>
      <p class="text-xs text-on-surface-variant mt-1">Send an anonymous question to break the ice!</p>
    </button>
  `;
  
  gamesList.querySelectorAll('[data-game]').forEach(btn => {
    btn.onclick = () => {
      const game = btn.getAttribute('data-game');
      startGame(game);
    };
  });
}

async function startGame(gameType) {
  const questions = GAME_QUESTIONS[gameType] || GAME_QUESTIONS['would-you-rather'];
  const q = questions[Math.floor(Math.random() * questions.length)];
  
  if (gameType === 'question') {
    // Send a random question to the other user
    const randomQs = [
      "What's your most irrational fear?",
      "What's the best food you've ever had?",
      "If you could live anywhere, where would it be?",
      "What's a skill you'd love to learn?",
      "What's your favorite way to spend a weekend?",
      "What movie can you watch over and over?",
      "What's the most spontaneous thing you've done?",
      "What's your hidden talent?",
      "What's your absolute dream job if money didn't matter?",
      "What's your go-to karaoke song?",
      "If you could have dinner with any historical figure, who would it be?",
      "What's the best concert you've ever attended?",
      "What's a purchase under $100 that changed your life?",
      "What's your favorite childhood memory?",
      "If you won the lottery today, what's the first thing you'd buy?",
      "What's the weirdest food combination you actually enjoy?",
      "What's your favorite book of all time?",
      "What's the best advice you've ever received?",
      "What's a major red flag in a person for you?",
      "What's your favorite holiday and why?",
      "If your life was a movie, what would the title be?",
      "What's the most adventurous thing on your bucket list?",
      "What's your favorite season and why?",
      "If you could only eat one food for the rest of your life, what is it?",
      "What's your biggest pet peeve?",
      "What's the last song you listened to on repeat?",
      "Who is your biggest role model?",
      "What's your favorite city you've ever visited?",
      "What's something you're passionate about right now?",
      "If you could have any superpower, what would it be?",
      "What's your favorite board game or card game?",
      "What's a hobby you've always wanted to try?",
      "What's the most unusual place you've ever slept?",
      "What's your favorite way to de-stress after a long day?",
      "If you could speak any foreign language fluently, what would it be?",
      "What's the worst movie you've ever watched?",
      "What's your signature dish to cook?",
      "What's something that always makes you laugh?",
      "If you could travel to any planet, where would you go?",
      "What's your favorite dessert of all time?",
      "What's the most interesting fact you know?",
      "If you could be any animal for a day, what would you be?",
      "What's your favorite video game of all time?",
      "What's the longest road trip you've ever taken?",
      "What's your favorite quote or saying?",
      "If you could master any musical instrument, which one would it be?",
      "What's the most beautiful natural place you've ever seen?",
      "What's a fashion trend you wish would die or come back?",
      "What's something you've recently accomplished that you're proud of?",
      "If you could open any theme restaurant, what would the theme be?",
      "What's your favorite kind of exercise or sport?",
      "What's the most useless object you own?",
      "If you were a color, what color would you be?",
      "What's your favorite app on your phone?",
      "What's the best gift you've ever received?",
      "What's your favorite family tradition?",
      "If you could solve one global mystery, which one would it be?",
      "What's your favorite thing about your best friend?",
      "What is one goal you want to achieve before the year ends?"
    ];
    const randomQ = randomQs[Math.floor(Math.random() * randomQs.length)];
    const msg = `🎲 Icebreaker Question: ${randomQ}`;
    
    // Save random question permanently in the database so it never disappears on refresh
    // Also append optimistically so the user sees instant feedback (no dead tap)
    const tempId = 'temp-' + Date.now();
    appendMessage({
      tempId,
      is_sending: true,
      sender_id: currentUser.id,
      content: msg,
      is_encrypted: 0,
      created_at: new Date().toISOString()
    }, true);
    (async () => {
      if (!currentConnId) return; // Guard: connection must be active
      let payload = { connection_id: currentConnId, content: msg };
      if (isE2EEActive && sharedSecretKey) {
        try {
          const encrypted = await E2EECrypto.encryptMessage(msg, sharedSecretKey);
          payload.content = encrypted.ciphertext;
          payload.is_encrypted = 1;
          payload.iv = encrypted.iv;
        } catch (encErr) {
          console.error('Failed to encrypt random question:', encErr);
        }
      }
      const result = await apiCall('/api/messages/send', 'POST', payload);
      // Mark as sent when confirmed by server
      const msgEl = document.getElementById(tempId);
      if (msgEl) {
        msgEl.classList.remove('opacity-60');
        if (result && result.message && result.message.id) {
          msgEl.setAttribute('data-msg-id', result.message.id);
          if (result.message.created_at) {
            lastMessageTimestamp = result.message.created_at;
          }
          if (typeof messageCache !== 'undefined') {
            messageCache.cacheSingleMessage(currentConnId, result.message).catch(() => {});
          }
        }
        msgEl.removeAttribute('id');
      }
    })().catch(err => {
      console.error('Failed to send random question message:', err);
      // Mark as failed on error
      const msgEl = document.getElementById(tempId);
      if (msgEl) {
        msgEl.classList.remove('opacity-60');
        const innerEl = msgEl.querySelector('div');
        if (innerEl) {
          innerEl.classList.remove('bg-primary');
          innerEl.classList.add('bg-error/10', 'border', 'border-error/30', 'text-error');
        }
        const timeEl = msgEl.querySelector('.text-\\[10px\\]');
        if (timeEl) {
          timeEl.className = 'text-[10px] mt-1 text-right text-error font-bold';
          timeEl.textContent = 'Failed to send';
        }
      }
    });
  } else {
    // STEP 1: Save game to Firestore FIRST
    let activeGame;
    try {
      const result = await apiCall(`/api/connections/${currentConnId}/start-game`, 'POST', { game_type: gameType, question: q });
      activeGame = result.active_game; // includes created_at from Firestore
    } catch (err) {
      console.error('Failed to start persistent game:', err);
      showToast(err.message || 'Could not start the icebreaker. Please try again.', 'error');
      return;
    }
    
    // Render locally from the API response so the starter sees the card instantly.
    if (otherUserId) {
      const fakeConn = {
        from_user_id: currentUser.id,
        to_user_id: otherUserId,
        active_game: activeGame
      };
      syncActiveGame(fakeConn);
    }
  }
  closeModal();
}

function syncActiveGame(c) {
  console.log("[syncActiveGame] c.active_game:", JSON.stringify(c.active_game || null));
  console.log("[syncActiveGame] currentUser:", JSON.stringify(currentUser));
  console.log("[syncActiveGame] connection info:", `from=${c.from_user_id}, to=${c.to_user_id}`);
  const existingGame = document.querySelector('[id^="game-"]');
  if (!c.active_game) {
    // Minimum lifetime guard: don't remove game cards that were created within
    // the last GAME_CARD_MIN_LIFETIME ms. This prevents transient Firestore
    // snapshot races or connection-refetch issues from removing a card that
    // was just created and hasn't propagated yet.
    if (existingGame && Date.now() - _gameCardCreatedAt < GAME_CARD_MIN_LIFETIME) {
      return;
    }
    // Defense-in-depth: only remove if the tracked game matches.
    // Prevents a stale status_change from clear-game removing a newly created game.
    if (existingGame && currentGame && existingGame.id === currentGame.domId) {
      existingGame.remove();
      currentGame = null;
    } else if (existingGame && !currentGame) {
      // No tracked game — safe to remove (no new game could be using it)
      existingGame.remove();
    }
    return;
  }
  
  const game = c.active_game;
  
  // Helper: convert created_at (ISO string OR Firestore Timestamp object)
  // to numeric milliseconds for safe comparison.
  function _gameTime(ts) {
    if (!ts) return 0;
    if (typeof ts === 'object' && ts.toDate) return ts.toDate().getTime();
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  
  // Generate a stable game ID. If we already have a tracked game with the same
  // created_at (same game), reuse its domId. Otherwise, the random suffix would
  // change on every syncActiveGame call, causing the card to be removed/recreated
  // on every Firestore snapshot or socket event.
  // NOTE: created_at can be either an ISO string (from API JSON) or a
  // Firestore Timestamp object (from onSnapshot). Using numeric comparison
  // handles both formats.
  let gameId;
  if (currentGame && _gameTime(currentGame.created_at) === _gameTime(game.created_at)) {
    gameId = currentGame.domId;
  } else {
    gameId = 'game-' + _gameTime(game.created_at) + '-' + Math.random().toString(36).slice(2, 6);
  }
  
  const answers = game.answers || {};
  const question = game.question || {};
  const myAnswer = answers[String(currentUser.id)] || null;
  const otherId = otherUserId || (Number(c.from_user_id) === Number(currentUser.id) ? Number(c.to_user_id) : Number(c.from_user_id));
  const otherAnswer = answers[String(otherId)] || null;
  if (currentGame && _gameTime(currentGame.created_at) === _gameTime(game.created_at)) {
    currentGame.myAnswer = myAnswer;
    currentGame.otherAnswer = otherAnswer;
  }
  
  if (!existingGame || existingGame.id !== gameId) {
    if (existingGame) existingGame.remove();
    
    // Normalize created_at to a clean ISO string so the server's clearGame transaction
    // can reliably compare it with activeGame.created_at via ===. Without this, the
    // value could be a Firestore Timestamp object (from onSnapshot) which would fail
    // string comparison against the ISO string stored in Firestore.
    const createdMs = _gameTime(game.created_at);
    currentGame = { domId: gameId, gameType: game.game_type, question: game.question, myAnswer, otherAnswer, created_at: new Date(createdMs).toISOString() };
    // Record creation time for minimum lifetime guard
    _gameCardCreatedAt = Date.now();
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'w-full flex justify-center my-3 fade-in';
    msgDiv.id = gameId;
    msgDiv.dataset.gameCreatedAt = currentGame.created_at;
    
    msgDiv.innerHTML = `
      <div class="bg-surface-container-low rounded-2xl p-4 max-w-sm w-full border border-outline-variant/20 shadow-sm text-center">
        <div class="text-xs font-bold text-primary mb-2 uppercase tracking-wider">${game.game_type === 'would-you-rather' ? 'Would You Rather' : 'This or That'}</div>
        <p class="font-bold text-on-surface mb-3">${escapeHtml(question.q || 'Pick one')}</p>
        <div class="flex gap-3">
          <button data-game-answer="A" class="flex-1 py-2 px-3 rounded-xl bg-surface-container-high text-on-surface hover:bg-primary hover:text-white font-semibold text-sm transition-all">${escapeHtml(question.a || 'A')}</button>
          <button data-game-answer="B" class="flex-1 py-2 px-3 rounded-xl bg-surface-container-high text-on-surface hover:bg-primary hover:text-white font-semibold text-sm transition-all">${escapeHtml(question.b || 'B')}</button>
        </div>
        <p class="text-[10px] text-on-surface-variant mt-2" id="game-status-text">Make your pick to see if you match!</p>
      </div>
    `;
    
    const cont = document.getElementById('chat-messages');
    cont.prepend(msgDiv);
    
    // Scroll to show the game card (prepended at bottom of flex-col-reverse)
    scrollToBottom();
    
    msgDiv.querySelectorAll('[data-game-answer]').forEach(btn => {
      btn.onclick = async () => {
        const answer = btn.getAttribute('data-game-answer');
        btn.parentElement.querySelectorAll('[data-game-answer]').forEach(b => {
          b.style.opacity = '0.5';
          b.disabled = true;
        });
        btn.style.opacity = '1';
        btn.style.background = 'var(--primary, #a53b29)';
        btn.style.color = 'white';
        
        currentGame.myAnswer = answer;
        
        try {
          const res = await apiCall(`/api/connections/${currentConnId}/answer-game`, 'POST', { answer });
          if (res.gameData) {
            syncActiveGame({
              from_user_id: currentUser.id,
              to_user_id: otherId,
              active_game: res.gameData
            });
          }
          
          const latestAnswers = (res.gameData && res.gameData.answers) || {};
          const latestOtherAnswer = latestAnswers[String(otherId)] || null;
          if (res.bothAnswered && latestOtherAnswer) {
            handleBothAnswered(document.getElementById(gameId) || msgDiv, answer, latestOtherAnswer);
          }
        } catch (err) {
          showToast(err.message, 'error');
          // Re-enable buttons on API failure so the user can retry their answer.
          // Without this, the buttons stay disabled and the game is stuck.
          btn.parentElement.querySelectorAll('[data-game-answer]').forEach(b => {
            b.style.opacity = '';
            b.style.background = '';
            b.style.color = '';
            b.disabled = false;
          });
          currentGame.myAnswer = null;
        }
      };
    });
  }
  
  const gameEl = document.getElementById(gameId);
  if (gameEl) {
    const statusTextEl = gameEl.querySelector('#game-status-text');
    const buttons = gameEl.querySelectorAll('[data-game-answer]');
    
    if (myAnswer) {
      buttons.forEach(btn => {
        btn.disabled = true;
        const ans = btn.getAttribute('data-game-answer');
        if (ans === myAnswer) {
          btn.style.opacity = '1';
          btn.style.background = 'var(--primary, #a53b29)';
          btn.style.color = 'white';
        } else {
          btn.style.opacity = '0.5';
        }
      });
    }
    
    if (myAnswer && otherAnswer) {
      handleBothAnswered(gameEl, myAnswer, otherAnswer);
    } else if (myAnswer) {
      if (statusTextEl) {
        statusTextEl.textContent = 'Wait for the other person to answer too...';
        statusTextEl.className = 'text-[10px] text-on-surface-variant mt-2';
      }
    } else if (otherAnswer) {
      if (statusTextEl) {
        statusTextEl.textContent = 'The other person has answered! Make your pick to see if you match.';
        statusTextEl.className = 'text-[10px] text-primary font-semibold mt-2 animate-pulse';
      }
    } else {
      if (statusTextEl) {
        statusTextEl.textContent = 'Make your pick to see if you match!';
        statusTextEl.className = 'text-[10px] text-on-surface-variant mt-2';
      }
    }
  }
}

function handleBothAnswered(gameEl, myAns, otherAns) {
  const isMatch = myAns === otherAns;
  const resultText = isMatch 
    ? 'You matched! Great minds think alike!'
    : 'Different picks — opposites attract!';
  
  const statusTextEl = gameEl.querySelector('#game-status-text');
  if (statusTextEl) {
    statusTextEl.textContent = resultText;
    statusTextEl.className = 'text-xs font-bold mt-2 ' + (isMatch ? 'text-green-600 dark:text-green-400' : 'text-primary');
  }
  
  gameEl.querySelectorAll('[data-game-answer]').forEach(b => {
    b.style.opacity = '0.5';
    b.disabled = true;
  });

  if (gameEl.dataset.clearScheduled === '1') return;
  gameEl.dataset.clearScheduled = '1';
  const createdAtForClear = gameEl.dataset.gameCreatedAt || null;
  
  setTimeout(async () => {
    // Guard: if the card was already removed by syncActiveGame (via a
    // clear-game socket event arriving before this timeout), skip the
    // fade-out and avoid a wasted clear-game API call.
    if (!gameEl.isConnected) return;
    
    gameEl.classList.add('transition-opacity', 'duration-500', 'opacity-0');
    setTimeout(() => {
      if (gameEl.isConnected) gameEl.remove();
    }, 500);
    
    try {
      await apiCall(`/api/connections/${currentConnId}/clear-game`, 'POST', { game_created_at: createdAtForClear });
    } catch (e) {}
  }, 2000);
}

// ===== Report & Block =====
async function submitReport() {
  const reasonEl = document.getElementById('report-reason');
  let reason = reasonEl ? reasonEl.value.trim() : '';
  const detailsEl = document.getElementById('report-details');
  const details = detailsEl ? detailsEl.value.trim() : '';
  if (details) {
    reason += ': ' + details;
  }
  if (!reason) {
    showToast('Please select or enter a reason');
    return;
  }
  if (reason.length > 1000) {
    showToast('Report reason is too long. Please keep it under 1000 characters.');
    return;
  }
  
  const btn = document.getElementById('btn-report-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }
  
  try {
    const data = await apiCall('/api/connections/' + currentConnId);
    const otherId = data.connection.other_user_id;
    await apiCall('/api/users/report', 'POST', {
      reported_user_id: otherId,
      reason,
      connection_id: currentConnId
    });
    closeModal();
    showToast('Report submitted. Our team will review it.');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Report'; }
  }
}

async function blockUser() {
  if (!confirm('Block this user? You won\'t be able to chat anymore. This can\'t be undone.')) return;
  
  try {
    const data = await apiCall('/api/connections/' + currentConnId);
    const otherId = data.connection.other_user_id;
    await apiCall('/api/users/block', 'POST', { blocked_user_id: otherId });
    showToast('User blocked.');
    window.location.href = 'messages.html';
  } catch (err) {
    showToast(err.message, 'error');
  }
}


// Removed: handleVibeScoreUpdated - no longer needed with the new reveal system
