// ============================================================
// DATAGLOW - DuckDB-WASM load harden: one pin list, one candidate order
// ============================================================
//
// Both the SQL Editor's engine (js/sql/sql-engine.js) and the canvas-inlined
// loader built the same jsDelivr-then-unpkg fallback by hand, each with its
// own copy of the version string. Two copies of a version pin drift the first
// time one of them is bumped and the other is not, and a silent drift here
// means a demo works from one code path and hangs from the other. This
// module is the one place the version and the candidate host order live.
//
// WHY THIS NEVER FETCHES ANYTHING ITSELF.
// Pure data plus pure helpers. `buildCandidateList()` returns the ordered
// list of { host, cdnUrl, baseUrl } this session should try; the caller
// (the DuckDB adapter, in a browser) does the actual dynamic import and
// reports back success or failure per host. That keeps this file testable
// under plain Node with no network and no DOM.
//
// WHY THE ORDER IS A LIST, NOT A PRIMARY/FALLBACK PAIR.
// A two-name pair means adding a third CDN (esm.sh, a self-hosted mirror)
// is a structural change everywhere it is used. A list means adding one is
// an edit to CANDIDATE_HOSTS in this one file, and every caller that walks
// the list already handles it.
//
// WHY THERE IS A HARD CEILING ON RETRY.
// A candidate list with no ceiling can be walked forever by code that keeps
// re-appending it to itself, and a page that silently hangs while it does
// that is worse than one that tells you every CDN failed. `MAX_ATTEMPTS`
// bounds one load pass to the length of the candidate list; retrying means
// starting a new pass on purpose, not looping inside one.

export const DUCKDB_LOAD_HARDEN_KIND = 'dataglow-duckdb-load-harden';
export const DUCKDB_LOAD_HARDEN_VERSION = 1;

/** Single source of truth for the pinned DuckDB-WASM version. Bump here only. */
export const DUCKDB_WASM_PIN = '1.29.0';

// Self-host root-absolute path: assets/duckdb/ is the real, already-vendored
// DuckDB-WASM 1.29.0 runtime this repo ships (root index.html's own import
// map self-hosts apache-arrow/tslib/flatbuffers from the same directory --
// see index.html). Pointing here instead of a second canvas/vendor/ copy
// avoids duplicating ~74MB of wasm/worker files a second time just for the
// canvas surface.
//
// ROOT-ABSOLUTE, NOT RELATIVE. A relative "./assets/duckdb/" resolves
// against whatever base the CONSUMER of the path is running from, not
// against the document. The DuckDB-WASM worker script itself lives at
// /assets/duckdb/duckdb-browser-eh.worker.js, and that worker constructs
// its own mainModule wasm URL by resolving the baseUrl it was handed
// relative to ITS OWN location, not the page's. A relative baseUrl of
// "./assets/duckdb/" handed to a worker already inside /assets/duckdb/
// resolves to a nested, 404ing path with the assets/duckdb/ segment
// doubled (see BUNDLE18_HOTFIX2_RESULT.md). A root-absolute
// "/assets/duckdb/" resolves the same way no matter who is asking: the
// page, the worker, or a future nested worker. This repo is always served
// from a domain root (see DEPLOY.md / dataglow-live-publish), so a
// root-absolute path is safe here; resolveSelfHostBaseUrl() below covers
// callers that instead need an origin-qualified absolute URL.
export const SELF_HOST_BASE_URL = '/assets/duckdb/';

/**
 * Resolve the self-host base URL against a page/worker location so callers
 * that need an origin-qualified absolute URL (rather than the root-absolute
 * path above) can get one that a Worker and its parent page always agree
 * on. Falls back to a fixed placeholder origin under plain Node (no DOM, no
 * `location`), which keeps this pure and testable while still proving the
 * resolved path never doubles the assets/duckdb/ segment.
 *
 * @param {string} [href] - defaults to globalThis.location.href when present
 * @returns {string} an absolute, single-assets/duckdb/-segment URL string
 */
export function resolveSelfHostBaseUrl(href) {
  const base = href || (typeof globalThis !== 'undefined' && globalThis.location && globalThis.location.href) || 'http://localhost/';
  return new URL(SELF_HOST_BASE_URL, base).href;
}

/**
 * Self-host has no duckdb-esm.js (that filename is a jsDelivr-only rewrite of
 * duckdb-browser.mjs; the npm package itself never ships it). The self-host
 * candidate points cdnUrl at the real ESM entry the package ships,
 * duckdb-browser.mjs, and the adapter's bundle-selection falls back to
 * baseUrl + duckdb-eh.wasm / duckdb-browser-eh.worker.js when a module has no
 * getJsDelivrBundles export (see js/sql/sql-engine.js ensureInit).
 *
 * Bundle 18 hotfix 3: pplx.app live proof showed the same-origin
 * duckdb-browser.mjs, apache-arrow, and both worker scripts all load with a
 * clean 200 -- but /assets/duckdb/duckdb-eh.wasm (35MB) fails in the
 * browser with net::ERR_FAILED / TypeError: Failed to fetch. curl against
 * that same path from a server succeeds because it follows the platform's
 * 302 redirect to S3; a browser fetch()/WebAssembly streaming request under
 * this host cannot follow that redirect the same way (see
 * BUNDLE18_HOTFIX3_RESULT.md). jsDelivr and unpkg serve the identical
 * 1.29.0 wasm bytes directly with CORS, with no redirect in front of them.
 *
 * Bundle 18 hotfix 4: hotfix 3's wasmFallback only fired on a caught
 * instantiate() rejection. Live proof after #611 shipped showed the wasm
 * fetch failure happens INSIDE the DuckDB-WASM worker (Emscripten's own
 * instantiateAsync/getBinaryPromise), and when that failure surfaces as an
 * uncaught worker-thread error rather than a clean postMessage ERROR
 * response, AsyncDuckDB.onError() clears pending requests without ever
 * rejecting the instantiate() promise (see duckdb-browser.mjs onError:
 * "this._pendingRequests.clear()" with no promiseRejecter call). The
 * caller's instantiate() call hangs forever, the catch(eInstantiate) hybrid
 * retry never runs, and the CDN wasm request never fires -- exactly the
 * hybrid_seen=false symptom from the live bug report. See
 * BUNDLE18_HOTFIX4_RESULT.md for the full trace.
 *
 * The fix moves the CDN pin from a retry-only fallback to the PRIMARY
 * mainModule URL for self-host: wasmCdnFirst carries the jsDelivr 1.29.0
 * wasm URLs that buildSelfHostBundle() below applies up front, before any
 * instantiate() call is ever attempted. mainWorker (and mainModule's own
 * ESM entry, duckdb-browser.mjs) stay same-origin -- only the ~35 to 40MB
 * wasm binary itself, the one file this host cannot always serve, is
 * requested from jsDelivr from the very first attempt. This guarantees a
 * CDN wasm network request fires unconditionally, instead of depending on
 * an instantiate() rejection that a hung/uncaught worker error can prevent
 * from ever happening. wasmFallback is kept (aliased to the same URLs) as
 * a second layer: if a future regression reintroduces a same-origin-wasm
 * attempt somewhere, the existing retry-on-catch path still recovers.
 */
const WASM_CDN_FIRST = Object.freeze({
  mvp: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + DUCKDB_WASM_PIN + '/dist/duckdb-mvp.wasm',
  eh: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + DUCKDB_WASM_PIN + '/dist/duckdb-eh.wasm',
});

export const SELF_HOST_CANDIDATE = Object.freeze({
  id: 'self-host',
  label: 'self-host',
  cdnUrl: SELF_HOST_BASE_URL + 'duckdb-browser.mjs',
  baseUrl: SELF_HOST_BASE_URL,
  // Applied UP FRONT (see buildSelfHostBundle), not only on retry.
  wasmCdnFirst: WASM_CDN_FIRST,
  // Kept for the same-pass, same-candidate repair path (buildHybridWasmBundle)
  // in case anything still calls it directly against an already-self-host
  // mainModule bundle.
  wasmFallback: WASM_CDN_FIRST,
});

/**
 * Build the self-host candidate's actual load bundle: same-origin
 * duckdb-browser.mjs entry point and mainWorker, but mainModule (the wasm
 * binary) pinned to the CDN-first URL up front. This is what makes a CDN
 * wasm network request unconditional for self-host, rather than something
 * that only happens after an instantiate() rejection a hung worker can
 * prevent (Bundle 18 hotfix 4 -- see SELF_HOST_CANDIDATE doc above).
 *
 * @param {{mainWorker:string, pthreadWorker?:string|null}} workerBundle - the
 *   same-origin mainWorker (and optional pthreadWorker) already resolved by
 *   the caller from SELF_HOST_CANDIDATE.baseUrl.
 * @param {'mvp'|'eh'} [variant='eh'] - which wasm variant to pin.
 * @returns {{mainModule:string, mainWorker:string, pthreadWorker:string|null}}
 */
export function buildSelfHostBundle(workerBundle, variant) {
  const v = variant === 'mvp' ? 'mvp' : 'eh';
  return {
    mainModule: WASM_CDN_FIRST[v],
    mainWorker: (workerBundle && workerBundle.mainWorker) || null,
    pthreadWorker: (workerBundle && workerBundle.pthreadWorker) || null,
  };
}

/**
 * Whether an error thrown while fetching/instantiating a wasm module looks
 * like the unfetchable-redirect failure this hotfix targets, rather than a
 * genuine compile/logic error worth surfacing as-is. Matches both the raw
 * browser fetch failure (TypeError: Failed to fetch) and the
 * WebAssembly.compile error text Chromium/Firefox raise when the underlying
 * network request never completed.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isWasmFetchFailure(err) {
  const msg = (err && typeof err === 'object' && 'message' in err) ? String(err.message) : String(err || '');
  return /failed to fetch/i.test(msg) ||
    /err_failed/i.test(msg) ||
    /networkerror/i.test(msg) ||
    /http status code is not ok/i.test(msg) ||
    /failed to (fetch|load) (dynamically imported|wasm)/i.test(msg);
}

/**
 * Given a bundle (mainModule/mainWorker pair) built from a candidate that
 * carries a wasmFallback, return the same bundle with mainModule swapped to
 * the CDN pin. Keeps mainWorker (and therefore the whole worker/mjs stack)
 * same-origin -- only the wasm binary URL changes. Returns null when the
 * candidate has no wasmFallback or the bundle has no matching key, so a
 * caller can tell "no hybrid retry available" from "already the fallback".
 *
 * @param {{mainModule:string, mainWorker:string, pthreadWorker?:string|null}} bundle
 * @param {{wasmFallback?: {mvp?:string, eh?:string}}} candidate
 * @returns {null|{mainModule:string, mainWorker:string, pthreadWorker:string|null}}
 */
export function buildHybridWasmBundle(bundle, candidate) {
  const fallback = candidate && candidate.wasmFallback;
  if (!bundle || !fallback) return null;
  const isEh = /duckdb-eh\.wasm/i.test(String(bundle.mainModule || ''));
  const isMvp = /duckdb-mvp\.wasm/i.test(String(bundle.mainModule || ''));
  const cdnWasm = isEh ? fallback.eh : (isMvp ? fallback.mvp : null);
  if (!cdnWasm) return null;
  return {
    mainModule: cdnWasm,
    mainWorker: bundle.mainWorker,
    pthreadWorker: bundle.pthreadWorker || null,
  };
}

/**
 * Ordered hosts to try, primary first. Self-host is FIRST: a same-origin
 * vendored copy loads without a third-party network round trip and keeps
 * working if a CDN is blocked, rate-limited, or down; jsDelivr/unpkg/esm.sh
 * remain as fallbacks for a deploy that is missing assets/duckdb/ (or a
 * dev checkout where it was not fetched). Every caller walks this
 * same list.
 */
export const CANDIDATE_HOSTS = Object.freeze([
  SELF_HOST_CANDIDATE,
  Object.freeze({
    id: 'jsdelivr',
    label: 'jsDelivr',
    cdnUrl: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + DUCKDB_WASM_PIN + '/dist/duckdb-esm.js',
    baseUrl: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + DUCKDB_WASM_PIN + '/dist/',
  }),
  Object.freeze({
    id: 'unpkg',
    label: 'unpkg',
    cdnUrl: 'https://unpkg.com/@duckdb/duckdb-wasm@' + DUCKDB_WASM_PIN + '/dist/duckdb-esm.js',
    baseUrl: 'https://unpkg.com/@duckdb/duckdb-wasm@' + DUCKDB_WASM_PIN + '/dist/',
  }),
  Object.freeze({
    id: 'esm.sh',
    label: 'esm.sh',
    cdnUrl: 'https://esm.sh/@duckdb/duckdb-wasm@' + DUCKDB_WASM_PIN,
    baseUrl: 'https://esm.sh/@duckdb/duckdb-wasm@' + DUCKDB_WASM_PIN + '/dist/',
  }),
]);

export const MAX_ATTEMPTS = CANDIDATE_HOSTS.length;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The ordered candidate list a load pass should walk. A copy every time, so a
 * caller mutating the array it received cannot corrupt the shared pin list.
 * wasmFallback (self-host only, Bundle 18 hotfix 3) and wasmCdnFirst
 * (self-host only, Bundle 18 hotfix 4 -- same URLs, applied up front instead
 * of only on retry) are both carried through so a caller gets the hybrid
 * data for free without losing the rest of the candidate shape.
 */
export function buildCandidateList() {
  return CANDIDATE_HOSTS.map((h) => ({
    id: h.id,
    label: h.label,
    cdnUrl: h.cdnUrl,
    baseUrl: h.baseUrl,
    ...(h.wasmFallback ? { wasmFallback: { mvp: h.wasmFallback.mvp, eh: h.wasmFallback.eh } } : {}),
    ...(h.wasmCdnFirst ? { wasmCdnFirst: { mvp: h.wasmCdnFirst.mvp, eh: h.wasmCdnFirst.eh } } : {}),
  }));
}

/** Rewrite a jsDelivr-shaped bundle URL onto a different candidate's base. */
export function rewriteBundleUrl(url, fromBaseUrl, toBaseUrl) {
  const u = typeof url === 'string' ? url : '';
  if (!u || !fromBaseUrl || !toBaseUrl) return u;
  if (u.indexOf(fromBaseUrl) !== 0) return u;
  return toBaseUrl + u.slice(fromBaseUrl.length);
}

/**
 * Given a list of attempt results (in order tried), decide what the banner
 * should say. Never silent: every state names which host, if any, is live.
 *
 * @param {{host:string, ok:boolean, error?:string}[]} attempts
 * @returns {{state:'loading'|'ok'|'error', succeededHost:string|null,
 *   failedHosts:string[], message:string}}
 */
export function summarizeAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const failedHosts = list.filter((a) => isPlainObject(a) && a.ok !== true).map((a) => a.host);
  const succeeded = list.filter((a) => isPlainObject(a) && a.ok === true)[0];

  if (succeeded) {
    const viaFallback = failedHosts.length > 0;
    return {
      state: 'ok',
      succeededHost: succeeded.host,
      failedHosts,
      message: viaFallback
        ? 'SQL engine loaded from ' + succeeded.host + ' after ' + failedHosts.join(', ') + ' failed.'
        : 'SQL engine loaded from ' + succeeded.host + '.',
    };
  }

  if (list.length === 0) {
    return { state: 'loading', succeededHost: null, failedHosts: [], message: 'SQL engine initializing.' };
  }

  return {
    state: 'error',
    succeededHost: null,
    failedHosts,
    message: 'SQL engine failed to load from all CDNs tried: ' + failedHosts.join(', ') + '.',
  };
}

/**
 * Whether a fresh load pass should be attempted: true unless every candidate
 * in the list has already been tried and failed in this pass.
 */
export function shouldTryNextCandidate(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (list.some((a) => isPlainObject(a) && a.ok === true)) return false;
  return list.length < MAX_ATTEMPTS;
}

/** The next untried candidate for this pass, or null when the list is exhausted. */
export function nextCandidate(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const tried = new Set(list.map((a) => (isPlainObject(a) ? a.host : null)));
  const all = buildCandidateList();
  for (let i = 0; i < all.length; i++) {
    if (!tried.has(all[i].id)) return all[i];
  }
  return null;
}

export const DataGlowDuckDBLoadHarden = {
  DUCKDB_LOAD_HARDEN_KIND,
  DUCKDB_LOAD_HARDEN_VERSION,
  DUCKDB_WASM_PIN,
  SELF_HOST_BASE_URL,
  resolveSelfHostBaseUrl,
  SELF_HOST_CANDIDATE,
  CANDIDATE_HOSTS,
  MAX_ATTEMPTS,
  buildCandidateList,
  rewriteBundleUrl,
  summarizeAttempts,
  shouldTryNextCandidate,
  nextCandidate,
  isWasmFetchFailure,
  buildHybridWasmBundle,
  buildSelfHostBundle,
};

try {
  if (typeof window !== 'undefined') window.DataGlowDuckDBLoadHarden = DataGlowDuckDBLoadHarden;
} catch (_e) {}
