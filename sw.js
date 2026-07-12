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
//     and any optional cloud-LLM calls) are deliberately NOT
//     intercepted: they fall through to the network and degrade gracefully
//     offline instead of breaking the page.
//
// The cache name is versioned; bump CACHE_VERSION on deploy so stale JS is not
// served forever — old caches are deleted on activate.
//
// Cross-origin isolation: this worker also injects the COOP/COEP headers that
// make `window.crossOriginIsolated` true (and thus SharedArrayBuffer — needed by
// DuckDB-WASM's threaded/eh build — available), for hosts that don't set these
// as real HTTP headers themselves. See the `_headers` file for the host-level
// equivalent and index.html for the one-time reload that lets a first visit pick
// up isolation once this worker is in control. COEP is `credentialless` so the
// opt-in cross-origin CDN runtimes (Pyodide/WebR/WebLLM) still load without
// needing per-asset CORP/CORS headers.

const CACHE_VERSION = 'v2';
const CACHE_NAME = `dataglow-shell-${CACHE_VERSION}`;

const COOP = 'same-origin';
const COEP = 'credentialless';

// Return a copy of `response` with the cross-origin isolation headers set.
// Opaque / error (status 0) responses cannot be reconstructed with a body and
// are passed through unchanged — only same-origin responses flow through here.
function withCrossOriginIsolation(response) {
  if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', COOP);
  headers.set('Cross-Origin-Embedder-Policy', COEP);
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; never cache POST/PUT (e.g. LLM API calls).
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin requests. Cross-origin (CDNs, cloud LLMs)
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
        // The document response carries the COOP/COEP that grant isolation.
        .then(withCrossOriginIsolation)
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
        // Subresources (the vendored DuckDB-WASM bundle, workers, JS modules)
        // also get the isolation headers so nothing downgrades the document.
        return Promise.resolve(cached || network).then(withCrossOriginIsolation);
      })
    )
  );
});
