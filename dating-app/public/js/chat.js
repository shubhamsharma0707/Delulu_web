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
let hasReadMessagesInView = false;
let lastMessageTimestamp = null;
let pollingTimeout = null;
let statusPollTimeout = null;
let pollInterval = 4000;
const maxInterval = 30000;

let statusPollInterval = 60000;
const maxStatusInterval = 300000; // 5 minutes
let lastConnectionState = null;

// User Activity Monitoring to prevent wasteful reads when the user is idle
let lastActivityTime = Date.now();
let isIdle = false;

function resetIdleTimer() {
  lastActivityTime = Date.now();
  if (isIdle) {
    isIdle = false;
    console.log('User active — resuming polling fallback');
    pollInterval = 4000;
    statusPollInterval = 60000;
    scheduleNextPoll();
    scheduleStatusPoll();
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
    const since = lastMessageTimestamp;
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
        for (const m of newMsgs) {
          await appendMessage(m, false);
        }
        scrollToBottom();
        
        if (typeof messageCache !== 'undefined') {
          await messageCache.cacheMessages(currentConnId, data.messages);
        }
        return true;
      }
    }
  } catch (err) {
    console.error('pollDelta error:', err);
  }
  return false;
}

function scheduleNextPoll() {
  if (pollingTimeout) clearTimeout(pollingTimeout);
  if (socket && socket.connected) return; // Don't poll if socket is alive
  if (document.hidden || checkUserIdle()) return; // Pause entirely if backgrounded or idle
  
  pollingTimeout = setTimeout(async () => {
    const hasNewMessages = await pollDelta();
    // Double interval up to 30000ms if no new messages, reset to 4000ms immediately on new messages
    pollInterval = hasNewMessages 
      ? 4000 
      : Math.min(pollInterval * 2, maxInterval);
    scheduleNextPoll();
  }, pollInterval);
}

async function pollStatus() {
  if (!currentConnId) return false;
  try {
    const data = await apiCall(`/api/connections/${currentConnId}`);
    const c = data.connection;
    
    let changed = false;
    if (!lastConnectionState || 
        lastConnectionState.status !== c.status ||
        lastConnectionState.vibe_score !== c.vibe_score ||
        lastConnectionState.my_reveal !== c.my_reveal ||
        lastConnectionState.both_revealed !== c.both_revealed) {
      changed = true;
    }
    
    lastConnectionState = c;
    updateChatStatus(c);
    syncActiveGame(c);
    return changed;
  } catch (e) {
    console.error('Failed to poll status:', e);
  }
  return false;
}

function scheduleStatusPoll() {
  if (statusPollTimeout) clearTimeout(statusPollTimeout);
  if (socket && socket.connected) return; // Don't poll if socket is alive
  if (document.hidden || checkUserIdle()) return; // Pause entirely if backgrounded or idle
  
  statusPollTimeout = setTimeout(async () => {
    const changed = await pollStatus();
    // Double interval up to 5 minutes if status is unchanged, reset to 60000ms immediately on change
    statusPollInterval = changed 
      ? 60000 
      : Math.min(statusPollInterval * 2, maxStatusInterval);
    scheduleStatusPoll();
  }, statusPollInterval);
}

function startPollingFallback() {
  if (socket && !socket.connected) {
    pollInterval = 4000;
    statusPollInterval = 60000;
    scheduleNextPoll();
    scheduleStatusPoll();
  }
}

function stopPollingFallback() {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
  if (statusPollTimeout) {
    clearTimeout(statusPollTimeout);
    statusPollTimeout = null;
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
  if (msg.deleted) return false;
  if (otherLastReadAt && msg.created_at) {
    return new Date(msg.created_at) <= new Date(otherLastReadAt);
  }
  return false;
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
    window.location.href = '/messages';
    return;
  }
  
  currentConnId = connId;
  lastMessageTimestamp = null;
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
    socket.off('game-question');
    socket.off('game-answer');
    socket.off('vibe-score-updated');

    socket.on('new-message', (msg) => {
      // Use Number() coercion for safe comparison regardless of int/string type
      if (Number(msg.connection_id) === Number(currentConnId)) {
        if (Number(msg.sender_id) !== Number(currentUser.id)) {
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
        otherLastReadAt = new Date().toISOString();
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

    socket.on('status_change', (data) => {
      if (data.connection_id == currentConnId) loadChatInfo();
    });

    socket.on('connection-ended', ({ connectionId, message }) => {
      if (connectionId == currentConnId) {
        alert(message);
        window.location.href = '/discover';
      }
    });
    
    socket.on('game-question', (data) => {
      if (data.connection_id == currentConnId) {
        loadChatInfo();
      }
    });
    
    socket.on('game-answer', (data) => {
      if (data.connection_id == currentConnId) {
        // Directly update the game card without going through loadChatInfo.
        // This avoids the race condition where loadMessages(true) clears the
        // messages container while handleBothAnswered's 2s timer is pending.
        onGameAnswer(data);
      }
    });

    socket.on('vibe-score-updated', (data) => {
      if (data.connectionId == currentConnId) {
        handleVibeScoreUpdated(data);
      }
    });
  }

  function joinChatRoom() {
    if (!socket || !currentConnId) return;
    socket.emit('join-chat', currentConnId);
    if (typeof outboxQueue !== 'undefined') {
      outboxQueue.flushPending(socket).catch(() => {});
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

    // Clean up any stale connection-lifecycle listeners before re-adding
    socket.off('disconnect');
    socket.off('connect');
    socket.off('reconnect_error');
    socket.off('room-joined');

    socket.on('disconnect', () => {
      const bar = document.getElementById('chat-connection-bar');
      if (bar) {
        bar.classList.remove('hidden');
        const barText = document.getElementById('connection-bar-text');
        if (barText) barText.textContent = 'Reconnecting...';
      }
      startPollingFallback();
    });

    socket.on('connect', () => {
      const bar = document.getElementById('chat-connection-bar');
      if (bar) bar.classList.add('hidden');
      joinChatRoom();
      stopPollingFallback();
      loadMessages().catch(() => {});
      loadChatInfo().catch(() => {});
    });

    socket.on('reconnect_error', () => {
      const text = document.getElementById('connection-bar-text');
      if (text) text.textContent = 'Connection lost. Retrying...';
    });

    // Start polling initially only if socket is not already connected
    if (socket.connected) {
      joinChatRoom();
      stopPollingFallback();
    } else {
      startPollingFallback();
    }

    // Listen for tab/visibility state changes to pause/resume polling
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPollingFallback();
      } else {
        // Reset the idle activity timer when refocused so polling resumes instantly
        resetIdleTimer();
        if (!socket || !socket.connected) {
          startPollingFallback();
        }
        loadMessages().catch(() => {});
        loadChatInfo().catch(() => {});
      }
    });
  } else {
    // No socket at all — run polling fallback
    startPollingFallback();
  }

  // Scroll to bottom button
  const messagesContainer = document.getElementById('chat-messages');
  const scrollBottomBtn = document.getElementById('btn-scroll-bottom');
  
  if (messagesContainer && scrollBottomBtn) {
    messagesContainer.addEventListener('scroll', () => {
      const isNearBottom = messagesContainer.scrollTop > -200;
      if (isNearBottom) {
        scrollBottomBtn.classList.add('opacity-0', 'pointer-events-none');
        scrollBottomBtn.classList.remove('opacity-100', 'pointer-events-auto');
      } else {
        scrollBottomBtn.classList.remove('opacity-0', 'pointer-events-none');
        scrollBottomBtn.classList.add('opacity-100', 'pointer-events-auto');
      }
    });
    
    scrollBottomBtn.onclick = () => {
      scrollToBottom();
    };
  }
  
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('btn-chat-send');
  const chatMicBtn = document.getElementById('btn-record-voice');
  let typingTimeout = null;

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

        // Check if socket is connected — if not, queue for later
        if (socket && !socket.connected && typeof outboxQueue !== 'undefined') {
          await outboxQueue.enqueue({
            connection_id: currentConnId,
            content: payload.content,
            is_encrypted: payload.is_encrypted || 0,
            iv: payload.iv || null
          });
          const msgEl = document.getElementById(tempId);
          if (msgEl) {
            msgEl.classList.remove('opacity-60');
            const statusIcon = msgEl.querySelector('.msg-status-icon');
            if (statusIcon) {
              statusIcon.innerHTML = '<span class="text-[11px] opacity-50 material-symbols-outlined text-[14px] align-middle">schedule</span>';
            }
            const timeEl = msgEl.querySelector('.text-\\[10px\\]');
            if (timeEl) {
              timeEl.textContent = 'Queued';
            }
            msgEl.removeAttribute('id');
          }
          return;
        }

        const result = await apiCall('/api/messages/send', 'POST', payload);
        
        // Remove sending state on success and set actual message ID on the element
        const msgEl = document.getElementById(tempId);
        if (msgEl) {
          msgEl.classList.remove('opacity-60');
          if (result && result.message && result.message.id) {
            msgEl.setAttribute('data-msg-id', result.message.id);
            
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

  chatMicBtn.onclick = async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      
      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const duration = Math.round((Date.now() - recordStartTime) / 1000);
        clearInterval(recordTimerInterval);
        document.getElementById('recording-overlay').classList.add('hidden');

        stream.getTracks().forEach(track => track.stop());

        if (audioChunks.length === 0 || duration < 1) {
          return;
        }

        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('connection_id', currentConnId);
        formData.append('duration', duration);

        try {
          if (isE2EEActive && sharedSecretKey) {
            const encrypted = await E2EECrypto.encryptBlob(audioBlob, sharedSecretKey);
            formData.append('audio', encrypted.encryptedBlob);
            formData.append('is_encrypted', 1);
            formData.append('iv', encrypted.iv);
          } else {
            formData.append('audio', audioBlob);
          }

          const res = await fetch('/api/messages/upload-voice', {
            method: 'POST',
            body: formData
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to send voice note');
          
          appendMessage(data.message, true);
        } catch (err) {
          alert(err.message);
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
      alert('Could not access microphone: ' + err.message);
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
          clearInterval(recordTimerInterval);
          document.getElementById('recording-overlay').classList.add('hidden');
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
  
  const btnVibeCheck = document.getElementById('btn-vibe-check');
  if (btnVibeCheck) btnVibeCheck.onclick = () => openModal('modal-vibe');

  const btnReveal = document.getElementById('btn-reveal');
  if (btnReveal) btnReveal.onclick = () => openModal('modal-reveal');
  
  const vibeYes = document.getElementById('vibe-yes');
  if (vibeYes) vibeYes.onclick = () => submitVibeAction(1);

  const vibeNo = document.getElementById('vibe-no');
  if (vibeNo) vibeNo.onclick = () => submitVibeAction(2);

  const revealYes = document.getElementById('reveal-yes');
  if (revealYes) revealYes.onclick = () => submitRevealAction();

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
      } catch(err) { alert(err.message); }
    };
  }

  const peekVibing = document.getElementById('peek-vibing');
  if (peekVibing) peekVibing.onclick = () => submitVibeAction(1);

  const peekNotVibing = document.getElementById('peek-not-vibing');
  if (peekNotVibing) peekNotVibing.onclick = () => submitVibeAction(2);

}

// ===== Mark Messages as Read =====
function markMessagesAsRead() {
  if (!socket || hasReadMessagesInView || !currentConnId) return;
  hasReadMessagesInView = true;
  socket.emit('mark-read', { connectionId: currentConnId });
}

// ===== Scroll to bottom =====
function scrollToBottom() {
  const cont = document.getElementById('chat-messages');
  if (cont) {
    cont.scrollTop = 0;
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

// Try to setup event delegation immediately (DOM should be ready since chat.js loads at end of body)
setupModalEventDelegation();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeChat);
} else {
  initializeChat();
}

async function loadChatInfo() {
  try {
    const data = await apiCall(`/api/connections/${currentConnId}`);
    const c = data.connection;
    currentChatOther = c.other_username;
    otherUserId = c.other_user_id;
    otherLastReadAt = c.other_last_read_at || null;
    
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
    syncActiveGame(c);
    loadMessages(true);
    
    // Mark messages as read shortly after loading
    setTimeout(() => markMessagesAsRead(), 500);
  } catch (err) {
    console.error('loadChatInfo caught error:', err);
    fetch('/api/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
          <a href="/messages" class="text-primary font-semibold text-sm hover:underline">← Back to Messages</a>
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
  const vibeBtn = document.getElementById('btn-vibe-check');
  const revealBtn = document.getElementById('btn-reveal');
  
  if (vibeBtn) vibeBtn.classList.add('hidden');
  if (revealBtn) revealBtn.classList.add('hidden');
  
  if (c.status === 'accepted') {
    const isFrom = c.from_user_id === currentUser.id;
    const myVibe = isFrom ? c.from_vibe : c.to_vibe;
    const myReveal = c.my_reveal;
    
    const now = Date.now();
    const isVibeDue = c.next_vibe_check_at ? now >= new Date(c.next_vibe_check_at) : false;
    const isRevealDue = c.reveal_available_at ? now >= new Date(c.reveal_available_at) : false;
    
    if (isRevealDue) {
      if (myReveal === 0) {
        if (revealBtn) revealBtn.classList.remove('hidden');
      }
      if (statusEl) statusEl.textContent = c.both_revealed
        ? ''
        : "Face reveal hasn't been unlocked yet because both users haven't agreed.";
    } else if (isVibeDue) {
      if (myVibe === 0) {
        if (vibeBtn) vibeBtn.classList.remove('hidden');
        // Automatically show soft-gate popup if they haven't voted yet and it's not already shown
        const vibeModal = document.getElementById('modal-vibe');
        const alreadyShown = vibeModal && vibeModal.classList.contains('scale-100');
        if (!alreadyShown) {
          openModal('modal-vibe');
        }
      } else {
        if (statusEl) statusEl.innerHTML = `<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span> Online</span>`;
      }
    } else {
      const scoreStr = `<span class="material-symbols-outlined text-[12px] text-primary select-none" style="font-variation-settings: 'FILL' 1">favorite</span> Vibe Score: ${c.vibe_score || 0} ✨`;
      if (c.next_vibe_check_at) {
        const nextCheckDiff = new Date(c.next_vibe_check_at) - now;
        const daysLeft = Math.ceil(nextCheckDiff / (24 * 60 * 60 * 1000));
        if (statusEl) statusEl.innerHTML = `${scoreStr} &nbsp;|&nbsp; Next Vibe Check in ${daysLeft}d`;
      } else {
        if (statusEl) statusEl.innerHTML = scoreStr;
      }
    }
  } else if (c.status === 'revealed') {
    if (statusEl) statusEl.innerHTML = `<span class="material-symbols-outlined text-[12px]">lock_open</span> Identities Revealed`;
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

async function loadMessages(isInitial = false) {
  const cont = document.getElementById('chat-messages');
  let hasCachedMessages = false;
  try {
    // 1. Render from IndexedDB cache instantly on initial load (no network wait)
    if (isInitial && typeof messageCache !== 'undefined') {
      const cached = await messageCache.getCachedMessages(currentConnId);
      if (cached.length > 0) {
        hasCachedMessages = true;
        // Preserve game elements (icebreaker cards, game messages) when clearing
        const existingGames = cont.querySelectorAll('[id^="game-"], .w-full.flex.justify-center.my-2.fade-in');
        cont.innerHTML = '';
        lastMessageDate = null;
        for (const m of cached) {
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
    
    // 2. Fetch delta sync from server (passing since timestamp parameter if available)
    const since = lastMessageTimestamp;
    const data = await apiCall(`/api/messages/${currentConnId}${since ? '?since=' + encodeURIComponent(since) : ''}`);
    
    if (data.messages && data.messages.length > 0) {
      const existingIds = new Set();
      cont.querySelectorAll('[data-msg-id]').forEach(el => {
        existingIds.add(el.getAttribute('data-msg-id'));
      });
      
      const newMsgs = data.messages.filter(m => !existingIds.has(String(m.id)));
      if (newMsgs.length > 0) {
        for (const m of newMsgs) {
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
      await fetch('/api/log-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: err.message, stack: err.stack, path: window.location.href, context: 'loadMessages catch' })
      }).catch(() => {});
      cont.innerHTML = `<p class="text-error">${escapeHtml(err.message)}</p>`;
    }
  }
}

function renderReactions(m, parentContainer) {
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
    const hasReacted = userIds.includes(currentUser.id);
    
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
      } catch (err) { alert(err.message); }
    };
    container.appendChild(pill);
  });
  parentContainer.appendChild(container);
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
    btn.onclick = async () => {
      try {
        await apiCall(`/api/messages/${msg.id}/react`, 'POST', { connection_id: currentConnId, emoji });
        menu.remove();
      } catch (err) { alert(err.message); }
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
          menu.remove();
        } catch (err) { alert(err.message); }
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
  const isMe = Number(m.sender_id) === Number(currentUser.id);
  const time = formatTime(m.created_at);
  
  // Add date divider if date changed
  if (m.created_at) {
    if (!lastMessageTimestamp || m.created_at > lastMessageTimestamp) {
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
  
  if (m.deleted === 1) {
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
    if (scrollToBottom) cont.scrollTop = 0;
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
  if (isMe && !m.is_sending && !m.deleted) {
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
      alert('Please wait for the message to finish sending.');
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
    cont.scrollTop = 0;
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
    let playUrl = url;
    
    // Decrypt the voice note blob dynamically in memory if encrypted
    if (Number(isEncrypted) === 1 && iv && isE2EEActive && sharedSecretKey) {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch encrypted voice note file');
      const encryptedBuffer = await res.arrayBuffer();
      const decryptedBlob = await E2EECrypto.decryptBlob(encryptedBuffer, iv, sharedSecretKey);
      playUrl = URL.createObjectURL(decryptedBlob);
    }

    const audio = new Audio(playUrl);
    audio._originalUrl = url;
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
    alert('Failed to play voice note: ' + err.message);
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
  ['modal-vibe', 'modal-reveal', 'modal-profile-peek', 'modal-icebreaker', 'modal-report', 'modal-chat-more'].forEach(id => {
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
  ['modal-vibe', 'modal-reveal', 'modal-profile-peek', 'modal-icebreaker', 'modal-report', 'modal-chat-more'].forEach(id => {
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

async function submitVibeAction(vibe) {
  try {
    const data = await apiCall('/api/connections/vibe', 'POST', { connection_id: currentConnId, vibe });
    closeModal();
    if (data.ended) {
      alert('This chat connection has ended.');
      window.location.href = '/discover';
    } else {
      loadChatInfo();
    }
  } catch(err) { alert(err.message); }
}

async function submitRevealAction() {
  try {
    await apiCall('/api/connections/reveal', 'POST', { connection_id: currentConnId });
    closeModal();
    loadChatInfo();
  } catch(err) { alert(err.message); }
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

function startGame(gameType) {
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
    apiCall('/api/messages/send', 'POST', { connection_id: currentConnId, content: msg })
      .catch(err => console.error('Failed to send random question message:', err));
  } else {
    // Save interactive game in Firestore database to make it persistent
    apiCall(`/api/connections/${currentConnId}/start-game`, 'POST', { game_type: gameType, question: q })
      .catch(err => console.error('Failed to start persistent game:', err));
  }
  closeModal();
}

function syncActiveGame(c) {
  const existingGame = document.querySelector('[id^="game-"]');
  if (!c.active_game) {
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
  const gameId = 'game-' + new Date(game.created_at).getTime();
  
  const myAnswer = game.answers[String(currentUser.id)] || null;
  const otherId = c.from_user_id === currentUser.id ? c.to_user_id : c.from_user_id;
  const otherAnswer = game.answers[String(otherId)] || null;
  
  if (!existingGame || existingGame.id !== gameId) {
    if (existingGame) existingGame.remove();
    
    currentGame = { domId: gameId, gameType: game.game_type, question: game.question, myAnswer, otherAnswer };
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'w-full flex justify-center my-3 fade-in';
    msgDiv.id = gameId;
    
    msgDiv.innerHTML = `
      <div class="bg-surface-container-low rounded-2xl p-4 max-w-sm w-full border border-outline-variant/20 shadow-sm text-center">
        <div class="text-xs font-bold text-primary mb-2 uppercase tracking-wider">${game.game_type === 'would-you-rather' ? 'Would You Rather' : 'This or That'}</div>
        <p class="font-bold text-on-surface mb-3">${escapeHtml(game.question.q)}</p>
        <div class="flex gap-3">
          <button data-game-answer="A" class="flex-1 py-2 px-3 rounded-xl bg-surface-container-high text-on-surface hover:bg-primary hover:text-white font-semibold text-sm transition-all">${escapeHtml(game.question.a)}</button>
          <button data-game-answer="B" class="flex-1 py-2 px-3 rounded-xl bg-surface-container-high text-on-surface hover:bg-primary hover:text-white font-semibold text-sm transition-all">${escapeHtml(game.question.b)}</button>
        </div>
        <p class="text-[10px] text-on-surface-variant mt-2" id="game-status-text">Wait for the other person to answer too...</p>
      </div>
    `;
    
    const cont = document.getElementById('chat-messages');
    cont.prepend(msgDiv);
    
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
          
          // Emit socket event to make it instant for currently connected users
          socket.emit('icebreaker-answer', {
            connection_id: currentConnId,
            game_type: game.game_type,
            question: game.question,
            answer: answer
          });
          
          if (res.bothAnswered) {
            handleBothAnswered(msgDiv, answer, res.gameData.answers[String(otherId)]);
          }
        } catch (err) {
          alert(err.message);
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
  
  setTimeout(async () => {
    gameEl.classList.add('transition-opacity', 'duration-500', 'opacity-0');
    setTimeout(() => gameEl.remove(), 500);
    
    try {
      await apiCall(`/api/connections/${currentConnId}/clear-game`, 'POST');
    } catch (e) {}
  }, 2000);
}

function appendGameMessage(text, isImportant = false) {
  const cont = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'w-full flex justify-center my-2 fade-in';
  
  if (isImportant) {
    div.innerHTML = `
      <div class="bg-gradient-to-r from-primary/10 to-secondary-container/20 rounded-2xl px-5 py-3 border border-primary/10 shadow-sm max-w-sm w-full">
        <p class="text-sm text-center font-medium text-on-surface">${escapeHtml(text)}</p>
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="bg-surface-container-low rounded-2xl px-4 py-2 border border-outline-variant/20 text-sm text-center max-w-sm">
        ${escapeHtml(text)}
      </div>
    `;
  }
  cont.prepend(div);
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
    alert('Please select or enter a reason');
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
    alert('Report submitted. Our team will review it.');
  } catch (err) {
    alert(err.message);
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
    alert('User blocked.');
    window.location.href = '/messages';
  } catch (err) {
    alert(err.message);
  }
}

function onGameAnswer(data) {
  // Directly find the game card and update it with the other person's answer
  const gameEl = document.querySelector('[id^="game-"]');
  if (!gameEl) return;
  
  const statusTextEl = gameEl.querySelector('#game-status-text');
  if (!statusTextEl) return;
  
  const theirAnswer = data.answer; // 'A' or 'B'
  
  if (currentGame && currentGame.myAnswer) {
    // Both have answered — show result immediately
    handleBothAnswered(gameEl, currentGame.myAnswer, theirAnswer);
  } else {
    // The other person answered first — nudge user to pick
    statusTextEl.textContent = 'The other person has answered! Make your pick to see if you match.';
    statusTextEl.className = 'text-[10px] text-primary font-semibold mt-2 animate-pulse';
  }
}

function handleVibeScoreUpdated(data) {
  // Refresh connection data and UI to show new score
  loadChatInfo();
  
  // Show match celebration pill inside the chat feed
  appendGameMessage(`✨ Match! Your Vibe Score increased to ${data.vibe_score}! ✨`, true);
}
