// Minimal service worker of service-worker.html: takes control at once, answers one virtual URL, echoes messages.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (new URL(e.request.url).pathname === '/sw-virtual.txt') e.respondWith(new Response('from-sw', { headers: { 'content-type': 'text/plain' } }));
});
self.addEventListener('message', function (e) { e.source.postMessage('pong:' + e.data); });
