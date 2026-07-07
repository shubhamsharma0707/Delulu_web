let currentUser = null;
let socket = null;

// Global client error logger to diagnose browser-specific issues
window.onerror = function (message, source, lineno, colno, error) {
  fetch('/api/log-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, source, lineno, colno, stack: error ? error.stack : '', path: window.location.href })
  }).catch(() => {});
};
window.addEventListener('unhandledrejection', function (event) {
  fetch('/api/log-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: event.reason ? event.reason.message : 'Unhandled Rejection', stack: event.reason ? event.reason.stack : '', path: window.location.href })
  }).catch(() => {});
});

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
      
      // Perform session verification in background (non-blocking — page renders immediately with cached data)
      const safeTimeout = (ms) => new Promise(resolve => setTimeout(() => resolve(null), ms));
      Promise.race([apiCall('/api/session'), safeTimeout(3000)]).then(result => {
        if (!result) return; // timeout, keep cached data
        if (result.authenticated) {
          currentUser = result.user;
          window.localStorage.setItem('cached_user', JSON.stringify(result.user));
          updateHeaderAvatar();
          // Init push notifications after auth confirmed
          setTimeout(initPushNotifications, 3000);
        } else {
          window.localStorage.removeItem('cached_user');
          window.localStorage.removeItem('e2ee_private_key');
          window.location.href = '/';
        }
      }).catch(() => {}); // suppress any unhandled rejections
      
      return; // Resolve instantly!
    } catch (e) {
      window.localStorage.removeItem('cached_user');
    }
  }

  // Fallback: blocking check if no cache exists - with timeout to avoid hanging
  try {
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
    const data = await Promise.race([apiCall('/api/session'), timeoutPromise]);
    
    if (data && data.authenticated) {
      currentUser = data.user;
      window.localStorage.setItem('cached_user', JSON.stringify(data.user));
      initGlobalSocket();
      updateHeaderAvatar();
      // Init push notifications after auth confirmed
      setTimeout(initPushNotifications, 3000);
    } else if (!data) {
      // Timeout occurred - wait for cached data or redirect
      if (!window.localStorage.getItem('cached_user')) {
        window.location.href = '/';
      }
      // else: silently keep cached data
    } else {
      window.location.href = '/';
    }
  } catch (err) {
    // Only redirect if we don't have cached user data
    if (!window.localStorage.getItem('cached_user')) {
      window.location.href = '/';
    } else {
      // Use cached data as fallback
      console.warn('Session check failed, using cached user');
    }
  }
}

function updateHeaderAvatar() {
  const avatarEl = document.getElementById('header-avatar');
  if (avatarEl && currentUser) {
    avatarEl.innerHTML = getAvatarHtml(currentUser.username, currentUser.avatar);
  }
}

function initGlobalSocket() {
  if (typeof io !== 'undefined' && !socket) {
    // Connect with minimal transport options for speed
    socket = io({
      transports: ['websocket', 'polling'], // prefer WebSocket for lower latency
      upgrade: false,
      forceNew: false
    });
  }
}

async function apiCall(url, method = 'GET', body = null) {
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401) {
      window.localStorage.removeItem('cached_user');
      window.localStorage.removeItem('e2ee_private_key');
      window.location.href = '/';
      return new Promise(() => {}); // Return pending promise to halt further execution while redirecting
    }
    throw new Error(data.error || 'API Error');
  }
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

// Register Service Worker for instant page loads
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Check if there's a waiting service worker (new version)
      if (reg.waiting) {
        // New version available - reload to activate
        reg.waiting.postMessage('SKIP_WAITING');
      }
      
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available, optionally notify user
            console.log('New version available!');
          }
        });
      });
    }).catch(() => {
      // Service worker registration failed silently
    });
  });
  
  // Reload when new SW takes over
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

// ===== Dark Mode =====
function initDarkMode() {
  const saved = localStorage.getItem('delulu_theme');
  if (saved === 'dark') {
    document.body.classList.add('dark');
  }
  
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.onclick = () => {
      document.body.classList.toggle('dark');
      localStorage.setItem('delulu_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
      const icon = toggle.querySelector('.material-symbols-outlined');
      if (icon) {
        icon.textContent = document.body.classList.contains('dark') ? 'light_mode' : 'dark_mode';
      }
    };
    const icon = toggle.querySelector('.material-symbols-outlined');
    if (icon) {
      icon.textContent = saved === 'dark' ? 'light_mode' : 'dark_mode';
    }
  }
}

// ===== Haptic Feedback =====
function hapticLight() {
  try { navigator.vibrate(10); } catch(e) {}
}
function hapticMedium() {
  try { navigator.vibrate(20); } catch(e) {}
}
function hapticHeavy() {
  try { navigator.vibrate([30, 50, 20]); } catch(e) {}
}

// ===== Undo Dismiss Toast =====
let toastContainer = null;
function showUndoToast(message, onUndo, duration = 4000) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <span class="toast-undo">Undo</span>
  `;
  
  toast.querySelector('.toast-undo').onclick = () => {
    onUndo();
    toast.remove();
  };
  
  toastContainer.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
      setTimeout(() => toast.remove(), 300);
    }
  }, duration);
}

// ===== Loading Skeletons =====
function showSkeleton(containerId, count = 3, type = 'line') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    if (type === 'circle') {
      el.className = 'skeleton skeleton-circle';
    } else if (type === 'card') {
      el.className = 'skeleton';
      el.style.height = '100px';
      el.style.marginBottom = '12px';
    } else {
      el.className = 'skeleton skeleton-line' + (i % 2 === 0 ? ' short' : '');
    }
    container.appendChild(el);
  }
}

// ===== Push Notification Subscription =====
async function initPushNotifications() {
  if (!('Notification' in window) || !('PushManager' in window)) return;
  
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    
    const reg = await navigator.serviceWorker.ready;
    
    // Get VAPID key from server
    const keyRes = await fetch('/api/push/vapid-key');
    const keyData = await keyRes.json();
    if (!keyData.publicKey) return;
    
    const existingSub = await reg.pushManager.getSubscription();
    if (existingSub) {
      // Already subscribed, just verify on server
      return;
    }
    
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyData.publicKey
    });
    
    await apiCall('/api/push/subscribe', 'POST', { subscription: sub.toJSON() });
    console.log('Push notifications enabled');
  } catch (err) {
    console.log('Push notification setup deferred:', err.message);
  }
}

// ===== Connection Timeline Helper =====
function getConnectionProgress(status, chatStartedAt, nextVibeCheckAt, revealAvailableAt) {
  const now = Date.now();
  const stages = [
    { label: 'Matched', done: true },
    { label: 'Chatting', done: !!chatStartedAt }
  ];
  
  if (status === 'revealed') {
    stages.push({ label: 'Revealed', done: true });
  } else if (revealAvailableAt && now >= new Date(revealAvailableAt)) {
    stages.push({ label: 'Reveal Ready', done: false, active: true });
  } else if (nextVibeCheckAt) {
    const done = now >= new Date(nextVibeCheckAt);
    stages.push({ label: 'Vibe Check', done, active: !done });
  } else {
    stages.push({ label: 'Vibe Check', done: false });
  }
  
  return stages;
}

// Automatically bind setup on every page
document.addEventListener('DOMContentLoaded', () => {
  setupLogout();
  initDarkMode();
  
  // Defer heart background to after page is fully interactive
  if (document.querySelector('#heart-bg') || !document.querySelector('[data-no-hearts]')) {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => initHeartBackground(), { timeout: 2000 });
    } else {
      setTimeout(initHeartBackground, 500);
    }
  }

  // Prefetch navigation tabs on hover
  document.querySelectorAll('a').forEach(link => {
    link.addEventListener('mouseenter', () => {
      prefetchPage(link.getAttribute('href'));
    });
  });
  
});

// Export initPushNotifications so pages can call it after auth
window.initPushNotifications = initPushNotifications;

