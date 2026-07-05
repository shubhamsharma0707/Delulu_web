let currentUser = null;
let socket = null;

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Ensure we have user data on protected routes (Optimistic Session Cache)
async function requireAuth() {
  const cachedUserStr = window.localStorage.getItem('cached_user');
  
  if (cachedUserStr) {
    try {
      currentUser = JSON.parse(cachedUserStr);
      initGlobalSocket();
      updateHeaderAvatar();
      
      // Perform session verification in background
      apiCall('/api/session').then(data => {
        if (data.authenticated) {
          currentUser = data.user;
          window.localStorage.setItem('cached_user', JSON.stringify(data.user));
          updateHeaderAvatar();
        } else {
          // If server says session expired, clear cache and redirect
          window.localStorage.removeItem('cached_user');
          window.localStorage.removeItem('e2ee_private_key');
          window.location.href = '/';
        }
      }).catch(err => {
        console.error('Background session check failed:', err);
      });
      
      return; // Resolve instantly!
    } catch (e) {
      window.localStorage.removeItem('cached_user');
    }
  }

  // Fallback: blocking check if no cache exists
  try {
    const data = await apiCall('/api/session');
    if (data.authenticated) {
      currentUser = data.user;
      window.localStorage.setItem('cached_user', JSON.stringify(data.user));
      initGlobalSocket();
      updateHeaderAvatar();
    } else {
      window.location.href = '/';
    }
  } catch (err) {
    window.location.href = '/';
  }
}

function updateHeaderAvatar() {
  const avatarEl = document.getElementById('header-avatar');
  if (avatarEl && currentUser) {
    avatarEl.innerHTML = getAvatarHtml(currentUser.username, currentUser.avatar);
  }
}

function initGlobalSocket() {
  if (typeof io !== 'undefined') {
    socket = io();
  }
}

async function apiCall(url, method = 'GET', body = null) {
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API Error');
  return data;
}

function getAvatarHtml(username, avatar, options = {}) {
  const { className = 'w-full h-full object-cover', lazy = false } = options;
  const loadingAttr = lazy ? 'loading="lazy"' : '';
  const safeUsername = escapeHtml(username || '');
  if (avatar) {
    // Determine path based on if it's the new object or old string format
    let src = '';
    if (typeof avatar === 'object' && avatar.idle) {
      src = avatar.idle;
    } else {
      src = `/avatars/${avatar}.jpeg`;
    }
    return `<img src="${src}" alt="${safeUsername}" class="${className}" ${loadingAttr}>`;
  }
  const initial = safeUsername ? safeUsername.charAt(0).toUpperCase() : '?';
  return `<div class="w-full h-full bg-gradient-to-br from-primary-container to-secondary-container text-white flex items-center justify-center font-bold text-3xl">${initial}</div>`;
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

function setupLogout() {
  const btn = document.getElementById('logout-btn');
  if (btn) {
    btn.onclick = async () => {
      window.localStorage.removeItem('cached_user');
      window.localStorage.removeItem('e2ee_private_key');
      await apiCall('/api/users/logout', 'POST');
      if (socket) socket.disconnect();
      window.location.href = '/';
    };
  }
}

// Prefetch a page template in the background
function prefetchPage(url) {
  if (!url || url === '#' || url.startsWith('javascript:')) return;
  if (document.querySelector(`link[href="${url}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = url;
  document.head.appendChild(link);
}

function initHeartBackground() {
  const script = document.createElement('script');
  script.src = '/js/heart-bg.js';
  document.body.appendChild(script);
}

// Automatically bind setup on every page
document.addEventListener('DOMContentLoaded', () => {
  setupLogout();
  initHeartBackground();

  // Prefetch navigation tabs on hover
  document.querySelectorAll('a').forEach(link => {
    link.addEventListener('mouseenter', () => {
      prefetchPage(link.getAttribute('href'));
    });
  });
});
