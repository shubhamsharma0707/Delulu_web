let currentConnId = null;
let currentChatOther = '';
let currentPlayingAudio = null;
let currentPlayingBtn = null;

document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  
  const urlParams = new URLSearchParams(window.location.search);
  const connId = urlParams.get('id');
  if (!connId) {
    window.location.href = '/messages';
    return;
  }
  
  currentConnId = connId;
  setupChatOptions();
  loadChatInfo();
  
  // Connect socket explicitly since shared.js initializes io
  if (socket) {
    socket.emit('join-chat', currentConnId);
    
    socket.on('new-message', (msg) => {
      if (msg.connection_id == currentConnId && msg.sender_id !== currentUser.id) {
        appendMessage(msg, true);
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
    
    try {
      await apiCall('/api/messages/send', 'POST', { connection_id: currentConnId, content });
      chatInput.value = '';
      chatSendBtn.classList.add('hidden');
      chatMicBtn.classList.remove('hidden');
      appendMessage({ sender_id: currentUser.id, content, created_at: new Date().toISOString() }, true);
      
      if (socket) {
        socket.emit('typing', { connectionId: currentConnId, isTyping: false });
      }
    } catch(err) { alert(err.message); }
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
        formData.append('audio', audioBlob);
        formData.append('connection_id', currentConnId);
        formData.append('duration', duration);

        try {
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
    
    document.getElementById('chat-name').textContent = c.other_username;
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
    data.messages.reverse().forEach(m => {
      appendMessage(m, false);
    });
  } catch (err) {
    cont.innerHTML = `<p class="text-error">${escapeHtml(err.message)}</p>`;
  }
}

function appendMessage(m, scrollToBottom = true) {
  const cont = document.getElementById('chat-messages');
  const isMe = m.sender_id === currentUser.id;
  const time = formatTime(m.created_at);
  
  const div = document.createElement('div');
  div.className = `flex ${isMe ? 'justify-end' : 'justify-start'} w-full fade-in`;
  
  const inner = document.createElement('div');
  inner.className = `max-w-[75%] rounded-2xl p-3 ${isMe ? 'bg-primary text-white rounded-tr-sm shadow-sm' : 'bg-surface-container-low text-on-surface rounded-tl-sm shadow-sm border border-outline-variant/10'}`;
  
  if (m.is_voice || (m.content && m.content.startsWith('/uploads/voice/'))) {
    // Custom audio player
    const voiceContainer = document.createElement('div');
    voiceContainer.className = `flex items-center gap-3 p-0.5 ${isMe ? 'text-white' : 'text-on-surface'}`;
    
    const playBtn = document.createElement('button');
    playBtn.className = `w-9 h-9 rounded-full flex items-center justify-center shadow-sm shrink-0 transition-transform hover:scale-105 active:scale-95 ${isMe ? 'bg-white text-primary' : 'bg-primary text-white'}`;
    playBtn.innerHTML = `<span class="material-symbols-outlined text-lg">play_arrow</span>`;
    playBtn.onclick = () => {
      window.playVoiceNote(playBtn, m.content);
    };

    const details = document.createElement('div');
    details.className = 'flex flex-col';
    
    const label = document.createElement('span');
    label.className = 'text-xs font-bold';
    label.textContent = 'Voice Note';
    
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
    p.className = 'text-[15px] leading-relaxed break-words';
    p.textContent = m.content || '';
    inner.appendChild(p);
  }
  
  const timeEl = document.createElement('div');
  timeEl.className = `text-[10px] mt-1 text-right ${isMe ? 'text-white/70' : 'text-on-surface-variant/70'}`;
  timeEl.textContent = time;
  inner.appendChild(timeEl);
  
  div.appendChild(inner);
  cont.prepend(div);
  
  if (scrollToBottom) {
    cont.scrollTop = 0;
  }
}

window.playVoiceNote = (btn, url) => {
  const icon = btn.querySelector('span');
  
  if (currentPlayingAudio) {
    currentPlayingAudio.pause();
    if (currentPlayingBtn) {
      currentPlayingBtn.querySelector('span').textContent = 'play_arrow';
    }
    
    if (currentPlayingAudio.src.endsWith(url)) {
      currentPlayingAudio = null;
      currentPlayingBtn = null;
      return;
    }
  }

  const audio = new Audio(url);
  currentPlayingAudio = audio;
  currentPlayingBtn = btn;
  icon.textContent = 'pause';
  
  audio.play().catch(err => {
    console.error('Audio play failed:', err);
    icon.textContent = 'play_arrow';
  });
  
  audio.onended = () => {
    icon.textContent = 'play_arrow';
    currentPlayingAudio = null;
    currentPlayingBtn = null;
  };
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

function setupChatOptions() {
  const btn = document.getElementById('btn-chat-options');
  const menu = document.getElementById('chat-options-menu');
  const blockBtn = document.getElementById('btn-block');
  
  btn.onclick = () => {
    menu.classList.toggle('hidden');
  };
  
  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });
  
  blockBtn.onclick = async () => {
    if (confirm(`Are you sure you want to block this user? They will disappear forever.`)) {
      try {
        const connData = await apiCall(`/api/connections/${currentConnId}`);
        const targetUserId = connData.connection.other_user_id;
        await apiCall('/api/connections/block', 'POST', { target_user_id: targetUserId });
        window.location.href = '/messages';
      } catch(err) { alert(err.message); }
    }
  };
}
