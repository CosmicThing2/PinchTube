// Minimal app-shell cache. Only registers on a secure origin, so it stays dormant
// until the site is served over HTTPS (e.g. once Caddy is in front of it).
const CACHE = 'pinchtube-shell-v4';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest'])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Never cache API responses, media or artwork — they are user-specific and large.
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    return;
  }

  if (url.origin !== self.location.origin) return;

  const remember = (response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  };

  // Built files carry a content hash in their name, so a cached copy is never
  // stale. Anything else (icons, the manifest) may change under the same name:
  // ask the server first and only fall back to the cache when offline.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request).then(remember)));
  } else {
    event.respondWith(fetch(event.request).then(remember).catch(() => caches.match(event.request)));
  }
});
