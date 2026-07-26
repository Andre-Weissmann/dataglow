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

/** Ordered CDN hosts to try, primary first. Every caller walks this same list. */
export const CANDIDATE_HOSTS = Object.freeze([
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
 */
export function buildCandidateList() {
  return CANDIDATE_HOSTS.map((h) => ({ id: h.id, label: h.label, cdnUrl: h.cdnUrl, baseUrl: h.baseUrl }));
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
  CANDIDATE_HOSTS,
  MAX_ATTEMPTS,
  buildCandidateList,
  rewriteBundleUrl,
  summarizeAttempts,
  shouldTryNextCandidate,
  nextCandidate,
};

try {
  if (typeof window !== 'undefined') window.DataGlowDuckDBLoadHarden = DataGlowDuckDBLoadHarden;
} catch (_e) {}
