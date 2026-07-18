// ============================================================
// DataGlow — DuckDB-WASM Hardening Configuration
// Research ref: /workspace/research_duckdb_alternatives_2026.md
// ============================================================
// This module centralises all DuckDB-WASM configuration decisions
// based on the 2026 architecture research findings. It is imported
// by duckdb-engine.js and loaders.js. No DuckDB API calls here —
// only constants and pure helper functions that can be tested in Node.
//
// HARDENING ITEMS IMPLEMENTED:
//
// #1  Extension trim: document which extensions NOT to load at init.
//     DataGlow only needs parquet, json, httpfs, excel.
//     Drop: tpch, tpcds, substrait, inet, spatial, fts, vss, sqlite_scanner.
//     (These are already absent from our vendored mvp/eh bundles — this
//      module guards against accidentally adding them via LOAD statements.)
//
// #2  File System Access API: threshold and helper for deciding when to
//     use FSAA streaming vs full arrayBuffer load.
//
// #3  OPFS temp_directory: SQL pragma to configure DuckDB spill-to-disk.
//
// #4  COOP/COEP headers: documented here; enforced at the server/CDN layer.
//
// #5  Safari version pin + XLSX fallback flag.
//
// #6  Memory64 guard: explicit block against any future Memory64 usage.
//
// #7  QueryBatch: Mosaic-inspired query coordinator (de-duplicate concurrent
//     identical queries and batch overlapping requests from multiple charts).
//
// #8  Server offload: flag-gated, opt-in only. Never the default path.
// ============================================================

// ============================================================
// #1 — Permitted extensions (allowlist)
// ============================================================
// DataGlow only needs these. Any LOAD statement for an extension
// not in this set should be blocked or warned by duckdb-engine.js.
export const PERMITTED_EXTENSIONS = new Set([
  'parquet',
  'json',
  'httpfs',
  'excel',
  'autocomplete',
  'icu',
]);

// Extensions explicitly blocked (from the full duckdb-wasm default set).
// Included here as documentation so reviewers know the decision was deliberate.
export const BLOCKED_EXTENSIONS = new Set([
  'tpch',
  'tpcds',
  'substrait',
  'inet',
  'spatial',
  'fts',
  'vss',
  'sqlite_scanner',
]);

/**
 * Returns true if the extension name is permitted.
 * Use before any dynamic LOAD statement.
 * @param {string} name
 * @returns {boolean}
 */
export function isExtensionPermitted(name) {
  return PERMITTED_EXTENSIONS.has((name || '').toLowerCase().trim());
}

// ============================================================
// #2 — File System Access API threshold
// ============================================================
// Files above this size should use the File System Access API
// (read bytes on-demand from disk) rather than loading the
// entire file into WASM linear memory. This avoids hitting the
// wasm32 4GB memory ceiling on large datasets.
//
// Threshold set to 100MB based on research findings: dbxlite uses
// this pattern to handle 50GB+ local files in-browser.
// See: reddit.com/r/DuckDB/comments/1pkxmbm/...

export const FSAA_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Should this file use the File System Access API streaming path
 * instead of a full in-memory arrayBuffer load?
 *
 * @param {number} sizeBytes
 * @returns {boolean}
 */
export function shouldUseFSAA(sizeBytes) {
  return typeof sizeBytes === 'number' && sizeBytes > FSAA_THRESHOLD_BYTES;
}

/**
 * Returns true if the browser supports the File System Access API
 * (window.showOpenFilePicker is the primary capability signal).
 * @returns {boolean}
 */
export function isFSAASupported() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

// ============================================================
// #3 — OPFS temp_directory configuration
// ============================================================
// DuckDB-WASM can spill join/sort intermediates to OPFS rather
// than holding them all in WASM linear memory. This SQL pragma
// must be executed after db.connect() and before large queries.
//
// Research warning: OPFS spill has had open bugs in duckdb-wasm.
// We configure it but catch errors and fall back to in-memory mode.
// See: github.com/duckdb/duckdb-wasm/discussions/1322

export const OPFS_TEMP_DIR = 'tmp';

/**
 * Returns the SET pragma SQL to configure OPFS spilling.
 * @param {string} [dir]
 * @returns {string}
 */
export function opfsTempDirSQL(dir) {
  return "SET temp_directory = '" + (dir || OPFS_TEMP_DIR) + "'";
}

/**
 * Returns true if OPFS is available in this browser.
 * Requires a secure context (HTTPS or localhost).
 * @returns {boolean}
 */
export function isOPFSAvailable() {
  return typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function';
}

// ============================================================
// #4 — COOP/COEP headers (documentation + runtime check)
// ============================================================
// Multi-threaded DuckDB-WASM requires SharedArrayBuffer, which
// is restricted behind COOP/COEP headers post-Spectre.
//
// Required headers on your server / CDN / Cloudflare Pages config:
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// Without these, DuckDB falls back to single-threaded (mvp) mode.
// On GitHub Pages, add a _headers file. On Vercel, use vercel.json.
// On Cloudflare Pages, add a _headers file at the repo root.
//
// Example _headers file:
//   /*
//     Cross-Origin-Opener-Policy: same-origin
//     Cross-Origin-Embedder-Policy: require-corp
//
// See: github.com/duckdb/duckdb-wasm/discussions/1922

/**
 * Returns true if Cross-Origin Isolation is active (SharedArrayBuffer available).
 * When false, DuckDB runs single-threaded (still works, just slower).
 * @returns {boolean}
 */
export function isCrossOriginIsolated() {
  if (typeof globalThis === 'undefined') return false;
  return globalThis.crossOriginIsolated === true;
}

/**
 * Returns a diagnostic string about the current threading situation.
 * Shown in the DataGlow status bar or dev console.
 * @returns {string}
 */
export function coiDiagnostic() {
  if (isCrossOriginIsolated()) {
    return 'Cross-origin isolation active: DuckDB-WASM running multi-threaded.';
  }
  return 'Cross-origin isolation NOT active: DuckDB-WASM running single-threaded. ' +
    'Add COOP/COEP headers to your hosting config to enable threading.';
}

// ============================================================
// #5 — Safari version pin + XLSX fallback
// ============================================================
// DuckDB-WASM v1.29.0 is the pinned version (see assets/duckdb/duckdb-wasm.package.json).
// This version has been QA-confirmed on Safari. DO NOT upgrade without:
//   1. Confirming the new version passes the Safari crash regression (Issue #1058).
//   2. Testing XLSX ingestion (Issue #1956: read_xlsx() wasm-specific crash).
//
// XLSX fallback: if DuckDB's read_xlsx() throws in WASM, loaders.js falls back
// to the SheetJS (XLSX.js) parser already bundled in DataGlow.
// The fallback is enabled by default and gated by XLSX_USE_DUCKDB_NATIVE below.

export const PINNED_DUCKDB_WASM_VERSION = '1.29.0';

// Set to false to always use SheetJS for XLSX (bypasses DuckDB native reader).
// Set to true to try DuckDB native first, fall back to SheetJS on error.
// Recommendation: keep true — DuckDB native is faster for large XLSX files,
// and SheetJS silently succeeds where DuckDB WASM has edge-case crashes.
export const XLSX_TRY_DUCKDB_NATIVE = true;

/**
 * Returns true if the current browser is Safari (any version).
 * Uses the same heuristic as duckdb-browser.mjs isSafari().
 * @returns {boolean}
 */
export function isSafari() {
  if (typeof navigator === 'undefined') return false;
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

// ============================================================
// #6 — Memory64 guard
// ============================================================
// WebAssembly Memory64 (64-bit linear memory, removes 4GB wasm32 ceiling)
// was standardized in WASM 3.0 (September 2025) but is NOT deployable
// across all browsers in 2026:
//   - Chrome: behind origin trial
//   - Firefox: behind a flag
//   - Safari: NO support at all
//
// DO NOT build any DataGlow feature that relies on Memory64 until
// all three major browser engines ship it in stable releases.
// Current estimate: Q4 2026 at the earliest (and only if Safari ships it).
//
// Source: byteiota.com/webassembly-3-wasmgc-memory64-production-checklist/
//         platform.uno/blog/the-state-of-webassembly-2025-2026/
//
// This constant acts as a searchable token: grep for MEMORY64_BLOCKED
// to find any future code that incorrectly tries to use Memory64.
export const MEMORY64_BLOCKED = true;

/**
 * Throws if anything tries to use Memory64 features.
 * Call this from any code path that would require Memory64.
 */
export function assertMemory64Blocked() {
  throw new Error(
    'Memory64 is blocked in DataGlow until Safari ships support. ' +
    'See js/app-shell/duckdb-config.js #6.'
  );
}

// ============================================================
// #7 — QueryBatch: Mosaic-inspired query coordinator
// ============================================================
// Problem: multiple visualization panels can issue the same (or
// overlapping) SQL queries to DuckDB-WASM simultaneously, causing
// redundant work and possible interference.
//
// Solution (Mosaic-inspired, no Mosaic dependency):
//   - QueryBatch deduplicates identical concurrent SQL queries.
//   - If two callers request identical SQL within the same tick,
//     only one query is sent to DuckDB; both callers get the result.
//   - The coordinator is a thin wrapper around runQuery in duckdb-engine.js.
//
// This captures Mosaic's core insight (push aggregation to DuckDB,
// batch overlapping queries) without adding Mosaic's npm dependencies.

export class QueryBatch {
  constructor() {
    // Map of sql -> { promise, resolve, reject, callers }
    this._pending = new Map();
  }

  /**
   * Run a SQL query, deduplicating identical in-flight requests.
   * @param {string} sql
   * @param {Function} runFn - async (sql) => result (injected for testability)
   * @returns {Promise<any>}
   */
  run(sql, runFn) {
    const key = sql.trim();
    if (this._pending.has(key)) {
      // Piggyback on the existing in-flight query
      return this._pending.get(key).promise;
    }
    let resolver, rejecter;
    const promise = new Promise(function(res, rej) { resolver = res; rejecter = rej; });
    this._pending.set(key, { promise: promise, resolve: resolver, reject: rejecter });

    const self = this;
    runFn(key).then(function(result) {
      const entry = self._pending.get(key);
      self._pending.delete(key);
      if (entry) entry.resolve(result);
    }).catch(function(err) {
      const entry = self._pending.get(key);
      self._pending.delete(key);
      if (entry) entry.reject(err);
    });

    return promise;
  }

  /**
   * Number of currently in-flight queries.
   * @returns {number}
   */
  pendingCount() {
    return this._pending.size;
  }

  /**
   * Clear all pending queries (e.g., on tab change or dataset reset).
   * Rejects all waiting callers with a cancellation error.
   */
  clear() {
    const err = new Error('QueryBatch cleared');
    for (const entry of this._pending.values()) {
      entry.reject(err);
    }
    this._pending.clear();
  }
}

// Singleton query coordinator for DataGlow's visualization layer.
// Import and use this instead of calling runQuery() directly from chart code.
export const queryBatch = new QueryBatch();

// ============================================================
// #8 — Server offload: opt-in flag only
// ============================================================
// DataGlow's local-first value proposition (privacy, zero latency,
// no server cost) is sacrificed the moment a query round-trips to a server.
// Server offload is intentionally an EXPLICIT, OPT-IN escape hatch —
// never the default path, never automatic.
//
// The flag is off by default. If a user connects to an external source
// (MotherDuck, S3, a Postgres proxy), that is their explicit decision.
//
// Research context: a pure edge-Worker hybrid (Ducklings-style) requires
// a paid Cloudflare plan and Asyncify overhead. Not worth it for DataGlow's
// 500MB ceiling when File System Access API + OPFS spilling already handle
// that locally. Keep this as a future escape hatch, not an architecture pivot.
//
// Flag key in flags.manifest.json: 'serverOffload' (disabled by default).

export const SERVER_OFFLOAD_DEFAULT = false;

/**
 * Returns true only when the user has explicitly enabled server offload
 * in flags AND provided a valid endpoint URL.
 * @param {boolean} flagEnabled - from isEnabled('serverOffload')
 * @param {string|null} endpointUrl
 * @returns {boolean}
 */
export function isServerOffloadActive(flagEnabled, endpointUrl) {
  return flagEnabled === true && typeof endpointUrl === 'string' && endpointUrl.length > 0;
}
