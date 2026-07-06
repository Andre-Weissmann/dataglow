// ============================================================
// DATAGLOW — Service Worker (offline app shell)
// ============================================================
// Makes DATAGLOW installable and usable offline after the first visit, while
// preserving the project's hard constraint of being a pure static site.
//
// Strategy:
//   - Precache a small, stable core shell on install (HTML, CSS, entry JS,
//     manifest, icons) so the app can cold-start offline.
//   - Runtime cache-first with background refresh (stale-while-revalidate) for
//     every OTHER same-origin GET — this transparently picks up the JS ES
//     modules and the large vendored DuckDB-WASM / Apache Arrow assets under
//     assets/ as they are first requested, without a brittle exhaustive list.
//   - Cross-origin requests (CDN libs: Plotly, Pyodide, webR, Google Fonts, and
//     any optional cloud-LLM calls) are deliberately NOT intercepted: they fall
//     through to the network and degrade gracefully offline instead of breaking
//     the page.
//
// The cache name is versioned; bump CACHE_VERSION on deploy so stale JS is not
// served forever — old caches are deleted on activate.

const CACHE_VERSION = 'v1';
const CACHE_NAME = `dataglow-shell-${CACHE_VERSION}`;

// Core shell: small, always-needed, stable. Kept intentionally short — the rest
// is filled in at runtime by the stale-while-revalidate handler below.
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/base.css',
  './css/app.css',
  './js/main.js',
  './manifest.webmanifest',
  './assets/favicon.svg',
  './assets/logo.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Best-effort precache: a single missing/renamed asset must not abort the
      // whole install, so add individually and ignore per-item failures.
      .then((cache) => Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => { /* skip */ }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('dataglow-shell-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; never cache POST/PUT (e.g. LLM API calls).
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin requests. Cross-origin (CDNs, fonts, cloud LLMs)
  // are left to the network so offline degrades gracefully rather than breaking.
  if (url.origin !== self.location.origin) return;

  // Navigation requests: try network first (so a fresh deploy is picked up when
  // online), fall back to the cached app shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // Everything else same-origin: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            // Only cache complete, basic (same-origin) responses.
            if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
