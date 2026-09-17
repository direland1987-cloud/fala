// Keeps the app shell available offline so the notebook cached on this
// device can be read without a connection. Network first, cache fallback.
const VERSION = 'fala-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/voice.js',
  '/config.js',
  '/style.css',
  '/voice.css',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/lib/domain.js',
  '/lib/github.js',
  '/lib/vault.js',
  '/lib/local.js',
  '/lib/costs.js',
  '/lib/notes.js',
  '/lib/realtime.js',
  '/lib/lesson.js',
  '/lib/sync.js',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches
            .open(VERSION)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(
        async () =>
          (await caches.match(event.request)) ||
          (await caches.match('/index.html')) ||
          Response.error(),
      ),
  );
});
