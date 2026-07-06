let currentConnId = null;
let currentChatOther = '';
let currentPlayingAudio = null;
let currentPlayingBtn = null;
let myPrivateKey = null;
let otherPublicKey = null;
let sharedSecretKey = null;
let isE2EEActive = false;

document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  
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

  document.getElementById('btn-record-stop').onclick = () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  };

  document.getElementById('btn-record-cancel').onclick = () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.onstop = () => {
        clearInterval(recordTimerInterval);
        document.getElementById('recording-overlay').classList.add('hidden');
      };
      mediaRecorder.stop();
    }
  };
  
  document.getElementById('btn-vibe-check').onclick = () => openModal('modal-vibe');
  document.getElementById('btn-reveal').onclick = () => openModal('modal-reveal');
  
  document.getElementById('vibe-yes').onclick = () => submitOptIn('vibe', true);
  document.getElementById('vibe-no').onclick = () => submitOptIn('vibe', false);
  document.getElementById('reveal-yes').onclick = () => submitOptIn('reveal', true);
});

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
    document.getElementById('chat-name').innerHTML = `${escapeHtml(c.other_username)} ${isE2EEActive ? '<span class="material-symbols-outlined text-[15px] text-green-600 align-middle ml-1" title="End-to-End Encrypted" style="font-variation-settings: \'FILL\' 1">lock</span>' : ''}`;
    document.getElementById('chat-avatar').innerHTML = getAvatarHtml(c.other_username, c.other_avatar);
    
    updateChatStatus(c);
    loadMessages();
  } catch (err) {
    alert(err.message);
    window.location.href = '/messages';
  }
}

function updateChatStatus(c) {
  const statusEl = document.getElementById('chat-status');
  const vibeBtn = document.getElementById('btn-vibe-check');
  const revealBtn = document.getElementById('btn-reveal');
  
  vibeBtn.classList.add('hidden');
  revealBtn.classList.add('hidden');
  
  if (c.status === 'vibe_check') {
    statusEl.innerHTML = `<span class="material-symbols-outlined text-[12px]">timer</span> ${getCountdown(c.deadline)} (Vibe Phase)`;
    if (c.user_vibe === null) vibeBtn.classList.remove('hidden');
    else statusEl.innerHTML = `Vibe submitted, waiting...`;
  } else if (c.status === 'reveal_phase') {
    statusEl.innerHTML = `<span class="material-symbols-outlined text-[12px]">timer</span> ${getCountdown(c.deadline)} (Reveal Phase)`;
    if (c.user_reveal === null) revealBtn.classList.remove('hidden');
    else statusEl.innerHTML = `Reveal submitted, waiting...`;
  } else if (c.status === 'revealed') {
    statusEl.innerHTML = `<span class="material-symbols-outlined text-[12px]">lock_open</span> Identities Revealed`;
  } else {
    statusEl.textContent = c.status;
  }
}

async function loadMessages() {
  const cont = document.getElementById('chat-messages');
  try {
    const data = await apiCall(`/api/messages/${currentConnId}`);
    cont.innerHTML = '';
    // Use for...of to process message prepending in sequential async steps
    for (const m of data.messages) {
      await appendMessage(m, false);
    }
  } catch (err) {
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
    pill.innerHTML = `<span>${emoji}</span><span class="text-[10px] opacity-80">${userIds.length}</span>`;
    
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
  const existing = document.getElementById('message-action-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'message-action-menu';
  menu.className = 'fixed bg-surface shadow-lg rounded-2xl p-2 border border-outline-variant/30 z-50 flex flex-col gap-2 scale-95 opacity-0 transition-all duration-150 ease-out';
  
  const rect = e.currentTarget.getBoundingClientRect();
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
    if (!menu.contains(event.target) && !e.currentTarget.contains(event.target)) {
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
        displayContent = '🔒 [Unable to decrypt message on this device]';
      }
    } else {
      displayContent = '🔒 [Encrypted message]';
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
  document.getElementById('modal-overlay').classList.remove('hidden');
  const m = document.getElementById(id);
  m.classList.remove('hidden');
  setTimeout(() => {
    m.classList.remove('scale-95');
    m.classList.add('scale-100');
  }, 10);
};

window.closeModal = function() {
  document.getElementById('modal-overlay').classList.add('hidden');
  ['modal-vibe', 'modal-reveal'].forEach(id => {
    const m = document.getElementById(id);
    m.classList.remove('scale-100');
    m.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 200);
  });
};

async function submitOptIn(phase, choice) {
  try {
    await apiCall('/api/connections/opt-in', 'POST', { connection_id: currentConnId, phase, choice });
    closeModal();
    loadChatInfo();
  } catch(err) { alert(err.message); }
}


