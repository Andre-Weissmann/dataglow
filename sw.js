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
//     Plotly and SheetJS are vendored under assets/ too, so they are same-origin
//     and cached the same way.
//   - Cross-origin requests (the on-demand CDN runtimes Pyodide, webR and WebLLM,
//     Google Fonts, and any optional cloud-LLM calls) are deliberately NOT
//     intercepted: they fall through to the network and degrade gracefully
//     offline instead of breaking the page.
//
// The cache name is versioned; bump CACHE_VERSION on deploy so stale JS is not
// served forever — old caches are deleted on activate.
//
// Cross-origin isolation: the SQL engine (DuckDB-WASM) spins up a Worker that
// uses SharedArrayBuffer internally, which the browser only permits when
// `window.crossOriginIsolated === true`. That requires the top-level document to
// carry BOTH `Cross-Origin-Opener-Policy: same-origin` and
// `Cross-Origin-Embedder-Policy: require-corp`. The static host sets COOP but not
// COEP, so we stamp both onto every navigation response here — the host-agnostic
// way to opt a static site into isolation. Enabling COEP means cross-origin
// subresources must be CORS/CORP-clean: the Google Fonts stylesheet and the
// lazy Pyodide loader now request `crossorigin`, and the on-demand ESM runtimes
// (WebR, WebLLM) already load via CORS `import()`, so nothing else breaks.

const CACHE_VERSION = 'v2';
const CACHE_NAME = `dataglow-shell-${CACHE_VERSION}`;

// Core shell: small, always-needed, stable. Kept intentionally short — the rest
// is filled in at runtime by the stale-while-revalidate handler below.
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/base.css',
  './css/app.css',
  './js/app-shell/main.js',
  './capability-map.manifest.json',
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

// Re-wrap a navigation response with the COOP + COEP headers that make
// `crossOriginIsolated` true (see the cross-origin isolation note up top). A
// static host we don't control can't add COEP, so the service worker does it.
function withIsolationHeaders(res) {
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; never cache POST/PUT (e.g. LLM API calls).
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin requests. Cross-origin (CDNs, fonts, cloud LLMs)
  // are left to the network so offline degrades gracefully rather than breaking.
  if (url.origin !== self.location.origin) return;

  // Navigation requests: try network first (so a fresh deploy is picked up when
  // online), fall back to the cached app shell when offline. Either way the
  // response is stamped with the cross-origin isolation headers so DuckDB-WASM's
  // SharedArrayBuffer worker can start.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const isolated = withIsolationHeaders(res);
          caches.open(CACHE_NAME).then((cache) => cache.put(request, isolated.clone())).catch(() => {});
          return isolated;
        })
        .catch(() => caches.match(request)
          .then((c) => c || caches.match('./index.html'))
          .then((c) => (c ? withIsolationHeaders(c) : c)))
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
