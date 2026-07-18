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
 *
 * CORRECTED (Session 4, found via a live bug report -- a FAB rendered
 * in a stale, wrong position, "randomly," across page loads): the
 * fetch handler used to be cache-FIRST ("return cached ||
 * networkFetch") with a static CACHE_NAME that nothing bumps on
 * deploy. That combination means once any shell asset is cached, a
 * browser keeps serving that exact version indefinitely -- a
 * background fetch updates the cache for NEXT time, but the CURRENT
 * load still gets whatever was cached, however old. With several
 * deploys landing in quick succession (this session's own #16 fix,
 * the migration-blob bug fixes, this file's own fix), different
 * shell files could end up cached from DIFFERENT deploys depending on
 * exactly when each one's background refresh last completed --
 * which looks exactly like "random" inconsistent behavior from the
 * outside, because it effectively is.
 *
 * This file's own header already says what it's FOR: offline use,
 * i.e. a fallback -- not a freshness-sacrificing performance cache.
 * Network-first actually matches that stated intent better than
 * cache-first did: online (the common case), you always get the
 * current deploy; offline, you fall back to whatever's cached, same
 * as before. No version-bump discipline required going forward --
 * cache staleness stops being possible for anyone with connectivity,
 * rather than depending on someone remembering to bump CACHE_NAME
 * every time the shell changes (which is exactly what didn't happen
 * across today's several deploys).
 *
 * CACHE_NAME bumped v4 -> v5 alongside the strategy change specifically
 * to force an immediate clean purge+refetch for anyone already stuck
 * on a stale v4 cache from today, rather than waiting for their first
 * successful network-first fetch to organically overwrite each file.
 * ------------------------------------------------------------------
 */

const CACHE_NAME = 'aisapp-shell-v5';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/base.css',
  '/css/projects.css',
  '/css/workspace.css',
  '/css/instructions-roster.css',
  '/js/icons.js',
  '/js/theme.js',
  '/js/router.js',
  '/js/projects.js',
  '/js/activity.js',
  '/js/roster.js',
  '/js/instructions.js',
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

  // NETWORK-FIRST, falling back to cache only on failure (offline, or
  // any fetch error) -- see header comment for why this replaced the
  // old cache-first strategy. Always refreshes the cache in the
  // background on a successful network response, same as before, so
  // the offline fallback stays reasonably current too.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
