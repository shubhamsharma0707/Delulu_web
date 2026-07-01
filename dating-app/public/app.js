let currentUser = null;
let socket = null;
let currentDiscoverIndex = 0;
let discoverProfiles = [];
let activeChatConn = null;
let chatMessages = [];
let countdownInterval = null;

const STATE = {
  vibeModalTarget: null,
  revealModalTarget: null
};

// --- DOM Elements ---
const views = document.querySelectorAll('.view');
const navLinks = document.querySelectorAll('.nav-link');
const header = document.getElementById('global-header');
const mobileNav = document.getElementById('mobile-nav');

// Init
window.addEventListener('DOMContentLoaded', async () => {
  await checkSession();
  setupEventListeners();
  setupRouting();
});

// --- API Helpers ---
async function apiCall(url, method = 'GET', body = null) {
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API Error');
  return data;
}

function getAvatarHtml(username, profilePic, isRevealed = false) {
  if (isRevealed && profilePic) {
    return `<img src="${profilePic}" alt="${username}" class="w-full h-full object-cover">`;
  }
  // Neutral Avatar
  const initial = username ? username.charAt(0).toUpperCase() : '?';
  return `<div class="w-full h-full bg-primary-container text-on-primary-container flex items-center justify-center font-bold text-2xl">${initial}</div>`;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getCountdown(targetDate) {
  const now = new Date();
  const target = new Date(targetDate);
  const diff = target - now;
  if (diff <= 0) return 'Available now';
  
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const mins = Math.floor((diff / 1000 / 60) % 60);
  
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m left`;
}

// --- Navigation & Routing ---
function showView(viewId) {
  views.forEach(v => v.classList.remove('active', 'active-block'));
  const target = document.getElementById(viewId);
  if (target) {
    target.classList.add(viewId === 'view-requests' || viewId === 'view-profile' ? 'active-block' : 'active');
  }
  
  if (viewId === 'view-auth') {
    header.classList.add('hidden');
    mobileNav.classList.add('hidden');
  } else {
    header.classList.remove('hidden');
    mobileNav.classList.remove('hidden');
  }
}

function setupRouting() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

function handleRoute() {
  if (!currentUser) return showView('view-auth');
  
  let hash = window.location.hash.replace('#', '') || 'discover';
  if (hash === 'discover') {
    showView('view-discovery');
    loadDiscovery();
  } else if (hash === 'requests') {
    showView('view-requests');
    loadRequests();
  } else if (hash === 'messages') {
    showView('view-messages');
    loadMessagesList();
  } else if (hash.startsWith('chat/')) {
    const id = hash.split('/')[1];
    showView('view-chat');
    loadChat(id);
  } else if (hash === 'profile') {
    showView('view-profile');
    loadProfile();
  }
}

// --- Session & Socket ---
async function checkSession() {
  try {
    const data = await apiCall('/api/session');
    if (data.authenticated) {
      currentUser = data.user;
      initSocket();
      updateHeaderAvatar();
    }
  } catch (err) {
    console.error(err);
  }
}

function updateHeaderAvatar() {
  document.getElementById('header-avatar').innerHTML = currentUser.username.charAt(0).toUpperCase();
}

function initSocket() {
  if (socket) return;
  socket = io();
  socket.on('new-message', (msg) => {
    if (activeChatConn && msg.connection_id == activeChatConn.id) {
      chatMessages.unshift(msg);
      renderChatMessages();
    }
  });
}

function setupEventListeners() {
  // Auth
  document.getElementById('tab-login').onclick = () => toggleAuthMode('login');
  document.getElementById('tab-signup').onclick = () => toggleAuthMode('signup');
  document.getElementById('auth-form').onsubmit = handleAuthSubmit;
  document.getElementById('logout-btn').onclick = async () => {
    await apiCall('/api/users/logout', 'POST');
    currentUser = null;
    if (socket) { socket.disconnect(); socket = null; }
    window.location.hash = '';
    handleRoute();
  };

  // Discovery Actions
  document.getElementById('btn-like').onclick = async () => {
    const p = discoverProfiles[currentDiscoverIndex];
    if (!p) return;
    try {
      await apiCall('/api/connections/request', 'POST', { to_user_id: p.id });
      nextProfile();
    } catch(err) { alert(err.message); }
  };
  document.getElementById('btn-pass').onclick = nextProfile;
  
  // Requests Tabs
  document.getElementById('tab-req-incoming').onclick = () => {
    document.getElementById('tab-req-incoming').classList.replace('text-on-surface-variant', 'text-primary');
    document.getElementById('tab-req-incoming').classList.add('border-b-2', 'border-primary');
    document.getElementById('tab-req-sent').classList.replace('text-primary', 'text-on-surface-variant');
    document.getElementById('tab-req-sent').classList.remove('border-b-2', 'border-primary');
    loadRequests('incoming');
  };
  document.getElementById('tab-req-sent').onclick = () => {
    document.getElementById('tab-req-sent').classList.replace('text-on-surface-variant', 'text-primary');
    document.getElementById('tab-req-sent').classList.add('border-b-2', 'border-primary');
    document.getElementById('tab-req-incoming').classList.replace('text-primary', 'text-on-surface-variant');
    document.getElementById('tab-req-incoming').classList.remove('border-b-2', 'border-primary');
    loadRequests('sent');
  };

  // Chat
  document.getElementById('chat-back').onclick = () => { window.location.hash = 'messages'; };
  document.getElementById('chat-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const txt = input.value;
    if (!txt || !activeChatConn) return;
    socket.emit('send-message', { connectionId: activeChatConn.id, content: txt });
    input.value = '';
  };
  
  // Modals
  document.getElementById('btn-vibe-check').onclick = () => {
    STATE.vibeModalTarget = activeChatConn;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('modal-vibe').classList.remove('hidden');
  };
  
  document.getElementById('vibe-yes').onclick = () => submitVibe(1);
  document.getElementById('vibe-no').onclick = () => submitVibe(2);
  
  document.getElementById('btn-reveal').onclick = () => {
    STATE.revealModalTarget = activeChatConn;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('modal-reveal').classList.remove('hidden');
  };
  
  document.getElementById('reveal-yes').onclick = submitReveal;

  document.getElementById('profile-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const bio = document.getElementById('profile-bio').value;
      const hobbies = document.getElementById('profile-hobbies').value.split(',').map(s=>s.trim()).filter(Boolean);
      const profile_pic = document.getElementById('profile-photo').value;
      const res = await apiCall('/api/users/me', 'PUT', { bio, hobbies, profile_pic });
      currentUser = res.user;
      alert('Profile saved!');
    } catch(err) {
      alert(err.message);
    }
  };
  
  // Block
  document.getElementById('btn-chat-options').onclick = () => {
    document.getElementById('chat-options-menu').classList.toggle('hidden');
  };
  document.getElementById('btn-block').onclick = async () => {
    if (!activeChatConn) return;
    if(confirm('Are you sure you want to block this user?')) {
      try {
        await apiCall('/api/connections/block', 'POST', { target_user_id: activeChatConn.other_user_id, reason: 'User blocked' });
        alert('User blocked.');
        window.location.hash = 'messages';
      } catch(err) { alert(err.message); }
    }
  };
}

// --- Auth Flow ---
let authMode = 'login';
function toggleAuthMode(mode) {
  authMode = mode;
  document.getElementById('auth-error').classList.add('hidden');
  const loginTab = document.getElementById('tab-login');
  const signupTab = document.getElementById('tab-signup');
  const signupFields = document.getElementById('signup-fields');
  
  if (mode === 'login') {
    loginTab.classList.add('text-primary', 'border-b-2', 'border-primary');
    loginTab.classList.remove('text-on-surface-variant');
    signupTab.classList.add('text-on-surface-variant');
    signupTab.classList.remove('text-primary', 'border-b-2', 'border-primary');
    signupFields.classList.add('hidden');
    signupFields.classList.remove('flex');
    document.getElementById('auth-gender').removeAttribute('required');
  } else {
    signupTab.classList.add('text-primary', 'border-b-2', 'border-primary');
    signupTab.classList.remove('text-on-surface-variant');
    loginTab.classList.add('text-on-surface-variant');
    loginTab.classList.remove('text-primary', 'border-b-2', 'border-primary');
    signupFields.classList.remove('hidden');
    signupFields.classList.add('flex');
    document.getElementById('auth-gender').setAttribute('required', 'true');
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const username = document.getElementById('auth-username').value.trim();
  const passcode = document.getElementById('auth-passcode').value.trim();
  const errEl = document.getElementById('auth-error');
  
  try {
    if (authMode === 'login') {
      const data = await apiCall('/api/users/login', 'POST', { username, passcode });
      currentUser = data.user;
    } else {
      const gender = document.getElementById('auth-gender').value;
      const bio = document.getElementById('auth-bio').value;
      const hobbies = document.getElementById('auth-hobbies').value.split(',').map(s=>s.trim()).filter(Boolean);
      const profile_pic = document.getElementById('auth-photo').value;
      const data = await apiCall('/api/users/create', 'POST', { username, passcode, gender, bio, hobbies, profile_pic });
      currentUser = data.user;
    }
    initSocket();
    updateHeaderAvatar();
    window.location.hash = 'discover';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// --- Discovery Flow ---
async function loadDiscovery() {
  try {
    const data = await apiCall('/api/discover');
    discoverProfiles = data.profiles;
    currentDiscoverIndex = 0;
    renderDiscovery();
  } catch (err) { console.error(err); }
}

function renderDiscovery() {
  const stack = document.getElementById('discovery-stack');
  const empty = document.getElementById('discovery-empty');
  const actions = document.getElementById('discovery-actions');
  
  const p = discoverProfiles[currentDiscoverIndex];
  if (!p) {
    stack.innerHTML = '';
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    actions.classList.add('hidden');
    return;
  }
  
  empty.classList.add('hidden');
  empty.classList.remove('flex');
  actions.classList.remove('hidden');
  actions.classList.add('flex');
  
  let matchHtml = '';
  if (p.matching_hobbies && p.matching_hobbies.length > 0) {
    matchHtml = p.matching_hobbies.map(h => `<span class="px-3 py-1 bg-white/20 backdrop-blur-md rounded-full font-label-sm text-sm border border-white/40">${h}</span>`).join('');
  } else {
    matchHtml = `<span class="px-3 py-1 bg-white/20 backdrop-blur-md rounded-full font-label-sm text-sm border border-white/40">No shared hobbies yet</span>`;
  }
  
  stack.innerHTML = `
    <div class="absolute inset-0 bg-surface rounded-xl shadow-[0_8px_32px_rgba(165,59,41,0.1)] overflow-hidden flex flex-col z-10 slide-up">
      <div class="w-full h-full absolute inset-0">
        ${getAvatarHtml(p.username, p.profile_pic, false)} 
      </div>
      <div class="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/80 via-black/30 to-transparent"></div>
      <div class="absolute bottom-0 left-0 w-full p-6 text-white flex flex-col justify-end z-20">
        <h1 class="font-bold text-3xl mb-1 capitalize">${p.username}</h1>
        <p class="text-sm opacity-90 mb-3">${p.bio || 'Mystery person...'}</p>
        <div class="flex flex-wrap gap-2 mb-2">
          ${matchHtml}
        </div>
      </div>
    </div>
  `;
}

function nextProfile() {
  currentDiscoverIndex++;
  renderDiscovery();
}

// --- Requests Flow ---
async function loadRequests(type = 'incoming') {
  const list = document.getElementById('requests-list');
  list.innerHTML = '<div class="p-4 text-center">Loading...</div>';
  try {
    const data = await apiCall(`/api/connections/${type}`);
    const reqs = data.requests;
    
    if (!reqs || reqs.length === 0) {
      list.innerHTML = `<div class="p-8 text-center text-on-surface-variant flex flex-col items-center"><span class="material-symbols-outlined text-4xl mb-2">inbox</span> No ${type} requests.</div>`;
      return;
    }
    
    list.innerHTML = reqs.map(r => `
      <div class="flex items-center gap-4 p-4 rounded-2xl bg-surface-container-low shadow-sm mb-2 fade-in">
        <div class="w-14 h-14 rounded-full overflow-hidden shrink-0 border border-outline-variant/30">
          ${getAvatarHtml(r.username, r.profile_pic, false)}
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-bold text-on-surface capitalize truncate">${r.username}</h3>
          <p class="text-sm text-on-surface-variant truncate">${r.bio || 'Wants to connect'}</p>
        </div>
        ${type === 'incoming' ? `
          <div class="flex gap-2 shrink-0">
            <button onclick="respondReq(${r.id}, 'accept')" class="w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center hover:scale-110 transition-transform"><span class="material-symbols-outlined material-fill text-sm">check</span></button>
            <button onclick="respondReq(${r.id}, 'reject')" class="w-10 h-10 rounded-full bg-surface-variant text-on-surface-variant flex items-center justify-center hover:scale-110 transition-transform"><span class="material-symbols-outlined text-sm">close</span></button>
          </div>
        ` : `<span class="text-xs text-outline bg-surface px-2 py-1 rounded-md">Pending</span>`}
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="p-4 text-error">${err.message}</div>`;
  }
}

window.respondReq = async (id, action) => {
  try {
    await apiCall('/api/connections/respond', 'POST', { connection_id: id, action });
    loadRequests('incoming');
  } catch(err) { alert(err.message); }
};

// --- Messages Flow ---
async function loadMessagesList() {
  const list = document.getElementById('messages-list');
  list.innerHTML = '<div class="p-4 text-center">Loading...</div>';
  try {
    const data = await apiCall('/api/connections/active');
    const conns = data.connections;
    
    if (!conns || conns.length === 0) {
      list.innerHTML = `<div class="p-8 text-center text-on-surface-variant flex flex-col items-center"><span class="material-symbols-outlined text-4xl mb-2">forum</span> No active chats yet.</div>`;
      return;
    }
    
    list.innerHTML = conns.map(c => {
      const isRevealed = c.status === 'revealed';
      return `
      <a href="#chat/${c.id}" class="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-surface-container-low mb-2 transition-colors fade-in">
        <div class="w-14 h-14 rounded-full overflow-hidden shrink-0 border border-outline-variant/30 relative">
          ${getAvatarHtml(c.other_username, c.other_profile_pic, isRevealed)}
          ${isRevealed ? '' : `<span class="absolute bottom-0 right-0 w-4 h-4 bg-primary text-white text-[10px] flex items-center justify-center rounded-full material-symbols-outlined" style="font-size: 10px;">lock</span>`}
        </div>
        <div class="flex-1 min-w-0 text-left">
          <div class="flex justify-between items-baseline mb-1">
            <h3 class="font-bold text-on-surface capitalize truncate">${c.other_username}</h3>
          </div>
          <p class="text-sm text-primary font-medium truncate">${isRevealed ? 'Identities Revealed!' : 'Tap to chat'}</p>
        </div>
      </a>
    `}).join('');
  } catch (err) {
    list.innerHTML = `<div class="p-4 text-error">${err.message}</div>`;
  }
}

async function loadChat(id) {
  try {
    const data = await apiCall(`/api/messages/${id}`);
    activeChatConn = data.connection;
    chatMessages = data.messages;
    
    const isRevealed = activeChatConn.status === 'revealed';
    
    document.getElementById('chat-name').textContent = activeChatConn.other_username;
    document.getElementById('chat-avatar').innerHTML = getAvatarHtml(activeChatConn.other_username, activeChatConn.other_profile_pic, isRevealed);
    
    if (socket) {
      socket.emit('join-chat', activeChatConn.id);
    }
    
    updateChatHeaderState();
    renderChatMessages();
    startCountdownTimer();
  } catch(err) {
    console.error(err);
    window.location.hash = 'messages';
  }
}

function updateChatHeaderState() {
  if (!activeChatConn) return;
  const statusEl = document.getElementById('chat-status');
  const btnVibe = document.getElementById('btn-vibe-check');
  const btnReveal = document.getElementById('btn-reveal');
  
  btnVibe.classList.add('hidden');
  btnReveal.classList.add('hidden');
  
  if (activeChatConn.status === 'revealed') {
    statusEl.innerHTML = `<span class="w-2 h-2 rounded-full bg-green-400"></span> Revealed`;
    return;
  }
  
  // Vibe phase
  const isVibeAvailable = activeChatConn.is_vibe_available;
  const myVote = activeChatConn.my_user_id === activeChatConn.from_user_id ? activeChatConn.from_vibe : activeChatConn.to_vibe;
  const otherVote = activeChatConn.my_user_id === activeChatConn.from_user_id ? activeChatConn.to_vibe : activeChatConn.from_vibe;
  
  if (myVote === 1 && otherVote === 1) {
    // Reveal phase
    const myReveal = activeChatConn.my_user_id === activeChatConn.from_user_id ? activeChatConn.reveal_from : activeChatConn.reveal_to;
    if (myReveal === 1) {
      statusEl.innerHTML = `Waiting for ${activeChatConn.other_username} to reveal...`;
    } else {
      statusEl.innerHTML = `<span class="material-symbols-outlined text-xs">timer</span> Reveal Deadline: ${getCountdown(activeChatConn.reveal_available_at)}`;
      btnReveal.classList.remove('hidden');
    }
  } else if (myVote === 1) {
    statusEl.innerHTML = `Waiting for ${activeChatConn.other_username}'s vibe check...`;
  } else {
    statusEl.innerHTML = `<span class="material-symbols-outlined text-xs">timer</span> Vibe Deadline: ${getCountdown(activeChatConn.vibe_available_at)}`;
    btnVibe.classList.remove('hidden');
  }
}

function startCountdownTimer() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (activeChatConn && window.location.hash.startsWith('#chat/')) {
      updateChatHeaderState();
    } else {
      clearInterval(countdownInterval);
    }
  }, 10000);
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages');
  container.innerHTML = '';
  
  const isRevealed = activeChatConn.status === 'revealed';
  const otherAvatar = getAvatarHtml(activeChatConn.other_username, activeChatConn.other_profile_pic, isRevealed);
  
  chatMessages.forEach(msg => {
    const isMe = msg.sender_id === currentUser.id;
    const timeStr = formatTime(msg.created_at);
    
    if (isMe) {
      container.innerHTML += `
        <div class="flex items-end justify-end gap-1 mb-2">
          <div class="flex flex-col items-end max-w-[75%]">
            <div class="bg-primary text-white rounded-2xl rounded-br-sm px-4 py-2 shadow-sm">
              <p class="text-sm break-words">${msg.content}</p>
            </div>
            <span class="text-[10px] text-outline mt-1 mr-1">${timeStr}</span>
          </div>
        </div>
      `;
    } else {
      container.innerHTML += `
        <div class="flex items-end gap-2 mb-2">
          <div class="w-8 h-8 rounded-full overflow-hidden shrink-0 mb-4 bg-surface-container-high border border-outline-variant/30">
            ${otherAvatar}
          </div>
          <div class="flex flex-col items-start max-w-[75%]">
            <div class="bg-surface-container rounded-2xl rounded-bl-sm px-4 py-2 shadow-sm">
              <p class="text-sm text-on-surface break-words">${msg.content}</p>
            </div>
            <span class="text-[10px] text-outline mt-1 ml-1">${timeStr}</span>
          </div>
        </div>
      `;
    }
  });
}

// Modals
window.closeModal = () => {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-vibe').classList.add('hidden');
  document.getElementById('modal-reveal').classList.add('hidden');
  STATE.vibeModalTarget = null;
  STATE.revealModalTarget = null;
};

async function submitVibe(vibeVal) {
  if (!STATE.vibeModalTarget) return;
  try {
    const res = await apiCall('/api/connections/vibe', 'POST', { connection_id: STATE.vibeModalTarget.id, vibe: vibeVal });
    closeModal();
    if (res.match === false) {
      alert('Connection ended.');
      window.location.hash = 'messages';
    } else {
      loadChat(STATE.vibeModalTarget.id);
    }
  } catch(err) { alert(err.message); }
}

async function submitReveal() {
  if (!STATE.revealModalTarget) return;
  try {
    const res = await apiCall('/api/connections/reveal', 'POST', { connection_id: STATE.revealModalTarget.id });
    closeModal();
    loadChat(STATE.revealModalTarget.id);
    if (res.bothRevealed) {
      alert("It's a Match! Identities revealed!");
    }
  } catch(err) { alert(err.message); }
}

// Profile
function loadProfile() {
  document.getElementById('profile-photo').value = currentUser.profile_pic || '';
  document.getElementById('profile-bio').value = currentUser.bio || '';
  
  let hobbiesStr = '';
  try { hobbiesStr = JSON.parse(currentUser.hobbies || '[]').join(', '); } catch(e){}
  document.getElementById('profile-hobbies').value = hobbiesStr;
  
  document.getElementById('profile-avatar-preview').innerHTML = getAvatarHtml(currentUser.username, currentUser.profile_pic, true);
}
