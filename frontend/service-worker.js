/**
 * service-worker.js
 * ------------------------------------------------------------------
 * Session 1 lane. Caches the static app shell for offline use.
 * Deliberately does NOT cache anything under /api/ -- file trees,
 * session rosters, and activity logs must always reflect the current
 * server state, especially with multiple AI agents writing
 * concurrently. Serving a stale cached API response here would be
 * actively misleading, not just unhelpful.
 *
 * server.js already sets Cache-Control: no-cache specifically on this
 * file's own response, so browsers re-check for a new service worker
 * on every load instead of running a stale one indefinitely -- this
 * file doesn't need to do anything special to cooperate with that,
 * it's handled entirely on the server side.
 * ------------------------------------------------------------------
 */

const CACHE_NAME = 'aihub-shell-v1';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/base.css',
  '/css/projects.css',
  '/css/workspace.css',
  '/js/theme.js',
  '/js/router.js',
  '/js/projects.js',
  '/js/pages/workspace.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll fails entirely if even one asset 404s -- use allSettled
      // semantics manually so a single missing/renamed file (easy to
      // happen mid-development with 5 concurrent sessions editing the
      // frontend) doesn't block the whole shell from being cached.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[service-worker] Skipped caching ${url}:`, err.message);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls -- always hit the network directly.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Only handle same-origin GET requests; let everything else
  // (POST/PUT/DELETE, cross-origin) pass through untouched.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to cache if the network fails

      // Cache-first for instant loads, but always refresh in the
      // background so the next load picks up any change.
      return cached || networkFetch;
    })
  );
});
