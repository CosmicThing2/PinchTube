/*
 * sw.js — the service worker, which lets PinchTube be installed as an app.
 *
 * A service worker is a small script the browser runs alongside the site.
 * This one keeps a copy of the app's own files so the app opens quickly
 * (and shows its shell even when offline). It never stores API replies,
 * videos or artwork. Registered by web/src/main.tsx, which browsers only
 * allow over HTTPS. Raise the CACHE number when the caching rules change, so
 * the old copy is thrown away.
 */

// Minimal app-shell cache. Only registers on a secure origin, so it stays dormant
// until the site is served over HTTPS (e.g. once Caddy is in front of it).
const CACHE = 'pinchtube-shell-v4';

// On install: cache the start page and manifest, and take over straight away.
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest'])));
});

// On activate: delete caches left by older versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// Every request the page makes passes through here.
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
