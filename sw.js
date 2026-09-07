// ─────────────────────────────────────────────────────────────────────────────
// Service Worker — todo-app
//
// Strategy: Cache-First for all app shell assets.
// On install  → cache every file listed in ASSETS.
// On activate → delete any old caches (old versions of the app).
// On fetch    → serve from cache; fall back to network only if not cached.
//
// This means the app works 100% offline after the first load. Even if the
// hosting URL disappears, the cached files serve the app indefinitely (until
// the user clears Safari's website data).
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'todo-app-v8';

// All files that make up the app shell. Must be kept in sync with what's
// actually in the project. If you add a new file (e.g. an icon PNG), add it
// here so it gets cached on install.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './sw.js',
  './icon.svg',
];

// ── Install ───────────────────────────────────────────────────────────────────
// Pre-cache all assets. If any file fails to cache, the install fails and the
// old service worker (if any) keeps running. This prevents a broken offline
// experience from shipping.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()) // activate immediately, don't wait for tabs to close
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
// Clean up caches from old versions. Any cache whose name isn't CACHE_NAME is
// considered stale and deleted. This runs when the SW takes control.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim()) // take control of open tabs immediately
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
// Cache-first: try the cache, fall back to network, then cache the network
// response for next time.
//
// We only intercept same-origin GET requests (the app shell). Cross-origin
// requests (unlikely for this app) pass through untouched.
self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Only handle same-origin requests
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;

        // Not in cache — fetch from network and cache for next time
        return fetch(event.request)
          .then(response => {
            // Only cache valid 200 responses
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clone the response: one copy goes to the cache, one to the browser
            const toCache = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
            return response;
          });
      })
  );
});
