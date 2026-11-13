/* Service worker of somov.org: only browser notifications about answers in the site chat.
   Registered when a visitor turns notifications on in the chat (assets/chat.js); it caches nothing.
   The push comes from the chat service (_src/chat/server.py). */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // The visitor is looking at the site right now: the page shows the answer and chimes by itself
    if (windows.some(w => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'somov', {
      body: data.body || '',
      icon: '/images/apple-touch-icon.png',
      tag: 'somov-chat',
      renotify: true,
      data: { url: '/#chat' },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ chat: 'open' });
    } else {
      await self.clients.openWindow('/#chat');
    }
  })());
});
