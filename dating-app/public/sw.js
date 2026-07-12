/**
 * Minimal Service Worker for Delulu Push Notifications
 * 
 * This file enables Web Push notifications (free, browser-native API).
 * No Firebase/Supabase reads or writes involved.
 * 
 * Install: triggers immediately so the SW is active.
 * Activate: claims all clients so push events work.
 * push: displays a notification with the payload from the server.
 * notificationclick: opens/focuses the target URL.
 */
self.addEventListener('install', () => {
  // Skip waiting — activate immediately so push events are received
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const title = data.title || 'Delulu';
    const options = {
      body: data.body || '',
      icon: data.icon || '/favicon.ico',
      badge: '/favicon.ico',
      data: { url: data.url || '/' },
      vibrate: [100, 50, 100]
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    // Ignore malformed payloads
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing tab if one exists
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      // Otherwise open a new tab
      return clients.openWindow(url);
    })
  );
});
