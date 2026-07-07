/* Delulu Dating App - Service Worker for instant page loads */
const CACHE_NAME = 'delulu-pages-v1';
const STATIC_CACHE = 'delulu-static-v1';

// Pages to cache on install for instant offline-capable navigation
const PRECACHE_PAGES = [
  '/',
  '/login.html',
  '/discover',
  '/messages',
  '/requests',
  '/profile'
];
// Note: /chat is NOT pre-cached because it requires a dynamic ?id= query parameter

// Install: pre-cache core pages
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_PAGES).catch(() => {
        // Silently fail on pre-cache - not critical
      });
    })
  );
  // Activate immediately without waiting for page reload
  self.skipWaiting();
});

// Activate: clean old caches and take control
// Listen for messages from the main thread (e.g., SKIP_WAITING)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => {
        return Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== STATIC_CACHE)
            .map((k) => caches.delete(k))
        );
      }),
      clients.claim()
    ])
  );
});

// ===== Push Notifications =====
self.addEventListener('push', (event) => {
  if (!event.data) return;
  
  try {
    const data = event.data.json();
    const title = data.title || 'Delulu';
    const options = {
      body: data.body || '',
      icon: data.icon || '/favicon.ico',
      badge: '/favicon.ico',
      data: {
        url: data.url || '/'
      },
      vibrate: [100, 50, 100],
      tag: 'delulu-notification'
    };
    
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  } catch (err) {
    console.error('Push notification error:', err);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      // If a window is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

// Network-first for HTML pages with fast cache fallback
// This means fresh content when online, instant from cache when offline
async function networkFirstWithCache(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const clone = response.clone();
      cache.put(request, clone).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Offline fallback
    const fallback = await cache.match('/');
    return fallback || new Response('Offline', { status: 503 });
  }
}

// Cache-first for static assets (JS, CSS, images) - they're immutable
async function cacheFirstWithRefresh(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // Refresh cache in background for next time
    fetch(request).then((response) => {
      if (response && response.ok) cache.put(request, response);
    }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

// Stale-while-revalidate for API calls - show cached quickly, update in background
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  
  const fetchPromise = fetch(request).then((response) => {
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => cached);

  return cached || fetchPromise;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Skip non-GET methods
  if (request.method !== 'GET') return;

  // Skip socket.io and API calls that shouldn't be cached
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // HTML pages: network-first with fast cache fallback
  if (url.pathname.endsWith('.html') || 
      url.pathname === '/' || 
      ['/discover', '/messages', '/requests', '/profile', '/chat'].includes(url.pathname)) {
    event.respondWith(networkFirstWithCache(request));
    return;
  }

  // Static assets (JS, CSS, images): cache-first
  if (/\.(js|css|jpeg|jpg|png|gif|webp|svg|woff2?|ico)$/i.test(url.pathname)) {
    event.respondWith(cacheFirstWithRefresh(request));
    return;
  }

  // Default: network-first
  event.respondWith(networkFirstWithCache(request));
});
