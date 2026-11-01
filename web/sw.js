// Offline shell cache.
//
// Important: this used a cache-first strategy with a fixed cache name, so after
// a re-deploy the browser kept serving the previously cached app.js — the page
// looked updated but ran stale logic. Now:
//   * the cache name carries a build version, so a new build invalidates it;
//   * HTML and JS are network-first, so a deploy takes effect immediately;
//   * only CSS/icons/images fall back to cache when offline.
const VERSION = '2';
const CACHE = `politicsqa-shell-${VERSION}`;
const SHELL = [
  './',
  './styles.css',
  './config.js',
  './js/runtime.js',
  './js/app.js',
  './js/api.js',
  './js/markdown.js',
  './js/prompts.js',
  './js/boot.js',
  './manifest.webmanifest',
  './assets/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => { /* a single 404 must not block activation */ })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API calls, the content manifest, or user content folders.
  // Prompts and content.json must always be fresh so content edits show up.
  if (url.pathname.startsWith('/local-api/')
    || url.pathname.startsWith('/prompts/')
    || url.pathname === '/content.json') {
    return;
  }

  const isShell = request.mode === 'navigate'
    || url.pathname === '/'
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('.js')
    || url.pathname.endsWith('.json');

  if (isShell) {
    // Network-first: a new deployment wins over whatever is cached.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./'))),
    );
    return;
  }

  // Styles, images, fonts: cache-first is fine and saves data.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    })),
  );
});
