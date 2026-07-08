let currentConnId = null;
let currentChatOther = '';
let currentPlayingAudio = null;
let currentPlayingBtn = null;
let myPrivateKey = null;
let otherPublicKey = null;
let sharedSecretKey = null;
let isE2EEActive = false;
let closeModalTimeout = null;

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
  loadChatInfo();
  
  // Connect socket explicitly since shared.js initializes io
  if (socket) {
    socket.emit('join-chat', currentConnId);
    
    socket.on('new-message', (msg) => {
      if (msg.connection_id == currentConnId && msg.sender_id !== currentUser.id) {
        appendMessage(msg, true);
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

    let originalStatus = '';
    socket.on('typing', (data) => {
      if (data.userId !== currentUser.id) {
        const statusEl = document.getElementById('chat-status');
        if (data.isTyping) {
          if (!originalStatus) originalStatus = statusEl.innerHTML;
          statusEl.innerHTML = `<span class="italic animate-pulse">typing...</span>`;
        } else {
          if (originalStatus) {
            statusEl.innerHTML = originalStatus;
            originalStatus = '';
          }
        }
      }
    });

    socket.on('status_change', (data) => {
      if (data.connection_id == currentConnId) {
        loadChatInfo(); // refresh status and UI
      }
    });
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
      try {
        const payload = { connection_id: currentConnId, content };
        if (isE2EEActive && sharedSecretKey) {
          const encrypted = await E2EECrypto.encryptMessage(content, sharedSecretKey);
          payload.content = encrypted.ciphertext;
          payload.is_encrypted = 1;
          payload.iv = encrypted.iv;
        }

        await apiCall('/api/messages/send', 'POST', payload);
        
        // Remove sending state on success
        const msgEl = document.getElementById(tempId);
        if (msgEl) {
          msgEl.classList.remove('opacity-60');
          msgEl.removeAttribute('id');
        }
      } catch (err) {
        console.error('Failed to send message:', err);
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

  // Poll status every 60 seconds
  setInterval(async () => {
    if (currentConnId) {
      try {
        const data = await apiCall(`/api/connections/${currentConnId}`);
        updateChatStatus(data.connection);
      } catch (e) {
        console.error('Failed to poll status:', e);
      }
    }
  }, 60000);

  // Register socket listeners for connection-ended and icebreaker games
  if (socket) {
    socket.on('connection-ended', ({ connectionId, message }) => {
      if (connectionId == currentConnId) {
        alert(message);
        window.location.href = '/discover';
      }
    });
    
    socket.on('game-question', (data) => {
      if (data.connection_id == currentConnId) {
        receiveGameQuestion(data);
      }
    });
    
    socket.on('game-answer', (data) => {
      if (data.connection_id == currentConnId) {
        receiveGameAnswer(data);
      }
    });

    socket.on('vibe-score-updated', (data) => {
      if (data.connectionId == currentConnId) {
        handleVibeScoreUpdated(data);
      }
    });
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
    loadMessages();
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
        if (statusEl) statusEl.textContent = "Vibe submitted, waiting...";
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

async function loadMessages() {
  const cont = document.getElementById('chat-messages');
  try {
    // Show skeleton while loading
    showChatSkeleton();
    
    const data = await apiCall(`/api/messages/${currentConnId}`);
    cont.innerHTML = '';
    // Use for...of to process message prepending in sequential async steps
    for (const m of data.messages) {
      await appendMessage(m, false);
    }
  } catch (err) {
    console.error('loadMessages caught error:', err);
    await fetch('/api/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: err.message, stack: err.stack, path: window.location.href, context: 'loadMessages catch' })
    }).catch(() => {});
    cont.innerHTML = `<p class="text-error">${escapeHtml(err.message)}</p>`;
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
  if (msg.sender_id === currentUser.id) {
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

  if (msg.sender_id === currentUser.id) {
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

async function appendMessage(m, scrollToBottom = true) {
  const cont = document.getElementById('chat-messages');
  const isMe = m.sender_id === currentUser.id;
  const time = formatTime(m.created_at);
  
  const div = document.createElement('div');
  div.className = `flex group items-center gap-2 ${isMe ? 'justify-end' : 'justify-start'} w-full fade-in`;
  div.setAttribute('data-msg-id', m.id);
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
    if (scrollToBottom) {
      cont.scrollTop = 0;
    }
    return;
  }

  // Decrypt content if it is E2EE encrypted
  const isEncrypted = Number(m.is_encrypted) === 1;
  let displayContent = m.content || '';
  
  if (isEncrypted && displayContent) {
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

  if (m.is_voice || (displayContent && displayContent.startsWith('/uploads/voice/'))) {
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
  
  const timeEl = document.createElement('div');
  timeEl.className = `text-[10px] mt-1 text-right ${isMe ? 'text-white/70' : 'text-on-surface-variant/70'}`;
  timeEl.textContent = time;
  inner.appendChild(timeEl);
  
  renderReactions(m, inner);
  
  const actionsBtn = document.createElement('button');
  actionsBtn.className = 'more-actions-btn p-1 hover:bg-surface-container rounded-full text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer flex items-center justify-center shrink-0';
  actionsBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">more_vert</span>';
  actionsBtn.onclick = (e) => {
    e.stopPropagation();
    showMessageMenu(e, m, inner);
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
      'What\'s your most irrational fear?',
      'What\'s the best food you\'ve ever had?',
      'If you could live anywhere, where would it be?',
      'What\'s a skill you\'d love to learn?',
      'What\'s your favorite way to spend a weekend?',
      'What movie can you watch over and over?',
      'What\'s the most spontaneous thing you\'ve done?',
      'What\'s your hidden talent?'
    ];
    const randomQ = randomQs[Math.floor(Math.random() * randomQs.length)];
    
    const msg = `*Icebreaker Question*: ${randomQ}`;
    appendGameMessage(msg);
    
    socket.emit('icebreaker-question', {
      connection_id: currentConnId,
      question: randomQ
    });
  } else {
    // Show game UI
    showGameUI(gameType, q);
    
    socket.emit('icebreaker-game', {
      connection_id: currentConnId,
      game_type: gameType,
      question: q
    });
  }
  
  closeModal();
}

function showGameUI(gameType, question) {
  currentGame = { gameType, question, myAnswer: null, otherAnswer: null };
  
  const msgDiv = document.createElement('div');
  msgDiv.className = 'w-full flex justify-center my-3 fade-in';
  msgDiv.id = 'game-' + Date.now();
  
  msgDiv.innerHTML = `
    <div class="bg-surface-container-low rounded-2xl p-4 max-w-sm w-full border border-outline-variant/20 shadow-sm text-center">
      <div class="text-xs font-bold text-primary mb-2 uppercase tracking-wider">${gameType === 'would-you-rather' ? 'Would You Rather' : 'This or That'}</div>
      <p class="font-bold text-on-surface mb-3">${escapeHtml(question.q)}</p>
      <div class="flex gap-3">
        <button data-game-answer="A" class="flex-1 py-2 px-3 rounded-xl bg-surface-container-high hover:bg-primary hover:text-white font-semibold text-sm transition-all">${escapeHtml(question.a)}</button>
        <button data-game-answer="B" class="flex-1 py-2 px-3 rounded-xl bg-surface-container-high hover:bg-primary hover:text-white font-semibold text-sm transition-all">${escapeHtml(question.b)}</button>
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
      
      socket.emit('icebreaker-answer', {
        connection_id: currentConnId,
        game_type: gameType,
        question: question,
        answer: answer
      });

      // Check if other user has already answered
      if (currentGame.otherAnswer) {
        const isMatch = currentGame.myAnswer === currentGame.otherAnswer;
        const resultText = isMatch 
          ? 'You matched! Great minds think alike!'
          : 'Different picks — opposites attract!';
        
        const statusTextEl = msgDiv.querySelector('#game-status-text');
        if (statusTextEl) {
          statusTextEl.textContent = resultText;
          statusTextEl.className = 'text-xs font-bold text-primary mt-2' + (isMatch ? ' text-green-600' : '');
        }

        if (isMatch) {
          // Increment score via API
          apiCall('/api/connections/increment-vibe-score', 'POST', { connectionId: currentConnId })
            .catch(err => console.error('Failed to increment vibe score:', err));
        }
      }
    };
  });
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

function receiveGameQuestion(data) {
  if (!data.question) return;
  
  if (data.game_type && data.game_type !== 'question') {
    // Show game UI with interactive options for the recipient as well
    showGameUI(data.game_type, data.question);
  } else {
    // Plain text question fallback
    appendGameMessage(`*Icebreaker Question*: ${data.question}`, true);
  }
}

function receiveGameAnswer(data) {
  if (!data.answer) return;
  
  if (currentGame) {
    currentGame.otherAnswer = data.answer;
  }
  
  const gameEl = document.querySelector('[id^="game-"]');
  if (gameEl) {
    gameEl.dataset.otherAnswer = data.answer;
    
    // Check if the current user has already selected their answer
    if (currentGame && currentGame.myAnswer) {
      const isMatch = currentGame.myAnswer === data.answer;
      const resultText = isMatch 
        ? 'You matched! Great minds think alike!'
        : 'Different picks — opposites attract!';
      
      const statusTextEl = gameEl.querySelector('#game-status-text');
      if (statusTextEl) {
        statusTextEl.textContent = resultText;
        statusTextEl.className = 'text-xs font-bold text-primary mt-2' + (isMatch ? ' text-green-600' : '');
      }
      
      // Disable answer buttons on screen
      gameEl.querySelectorAll('[data-game-answer]').forEach(b => {
        b.style.opacity = '0.5';
        b.disabled = true;
      });
    } else {
      // The current user hasn't answered yet — update text helper to NUDGE them without revealing the choice
      const statusTextEl = gameEl.querySelector('#game-status-text');
      if (statusTextEl) {
        statusTextEl.textContent = 'The other person has answered! Make your pick to see if you match.';
        statusTextEl.className = 'text-[10px] text-primary font-semibold mt-2 animate-pulse';
      }
    }
  }
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

function handleVibeScoreUpdated(data) {
  // Refresh connection data and UI to show new score
  loadChatInfo();
  
  // Show match celebration pill inside the chat feed
  appendGameMessage(`✨ Match! Your Vibe Score increased to ${data.vibe_score}! ✨`, true);
}
