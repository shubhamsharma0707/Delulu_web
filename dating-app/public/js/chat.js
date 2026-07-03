let currentConnId = null;
let currentChatOther = '';

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
    socket.emit('join', currentUser.id);
    socket.on('message', (msg) => {
      if (msg.connection_id == currentConnId) {
        appendMessage(msg, false);
      }
    });
    socket.on('status_change', (data) => {
      if (data.connection_id == currentConnId) {
        loadChatInfo(); // refresh status and UI
      }
    });
  }

  document.getElementById('chat-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const content = input.value.trim();
    if (!content) return;
    
    try {
      await apiCall('/api/messages/send', 'POST', { connection_id: currentConnId, content });
      input.value = '';
      appendMessage({ sender_id: currentUser.id, content, created_at: new Date().toISOString() }, true);
    } catch(err) { alert(err.message); }
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
    const isRevealed = c.status === 'revealed';
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
      appendMessage(m, false); // prepend to top (flex-col-reverse makes it bottom)
    });
  } catch (err) {
    cont.innerHTML = `<p class="text-error">${err.message}</p>`;
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
  
  const p = document.createElement('p');
  p.className = 'text-[15px] leading-relaxed break-words';
  p.textContent = m.content || ''; // SAFE: textContent escapes HTML
  
  const timeEl = document.createElement('div');
  timeEl.className = `text-[10px] mt-1 text-right ${isMe ? 'text-white/70' : 'text-on-surface-variant/70'}`;
  timeEl.textContent = time;
  
  inner.appendChild(p);
  inner.appendChild(timeEl);
  div.appendChild(inner);
  
  // Because it's flex-col-reverse, prepend adds to bottom visually
  cont.prepend(div);
  if (scrollToBottom) {
    cont.scrollTop = 0;
  }
}

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
        // Fetch connection details to get the other user's ID
        const connData = await apiCall(`/api/connections/${currentConnId}`);
        const targetUserId = connData.connection.other_user_id;
        await apiCall('/api/connections/block', 'POST', { target_user_id: targetUserId });
        window.location.href = '/messages';
      } catch(err) { alert(err.message); }
    }
  };
}
