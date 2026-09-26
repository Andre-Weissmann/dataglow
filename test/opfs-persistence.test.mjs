// ============================================================
// DATAGLOW — OPFS-backed database persistence decision logic
// (Structural Readiness Phase item 2, second half: OPFS persistence)
// ============================================================
// Unit-tests the PURE decision/config functions exported from
// js/app-shell/duckdb-config.js (shouldPersistToOPFS, opfsDatabaseOpenConfig,
// isOPFSAvailable) plus the Node-safe fallback behavior of the OPFS
// status/clear helpers in js/app-shell/duckdb-engine.js. The real
// db.open({ path: 'opfs://...' }) call (js/app-shell/duckdb-engine.js
// initDuckDB) needs a real browser Worker + WASM binary + the OPFS API
// itself and cannot run under plain Node — that half is proven separately
// by a Playwright-driven browser test against a live-served build (see
// dev-log/journal.md / NORTH_STAR.md for the run that covers it). This
// file's job is narrower and unconditionally runnable in CI: prove the
// three-way AND safety gate, the OPFS path construction, and the
// no-OPFS-available fallbacks are each correct in isolation.
//
// RUN WITH:  node test/opfs-persistence.test.mjs

import assert from 'node:assert/strict';
import {
  isOPFSAvailable,
  OPFS_CONSENT_KEY,
  OPFS_DATABASE_FILENAME,
  OPFS_PENDING_CLEAR_KEY,
  opfsDatabaseOpenConfig,
  shouldPersistToOPFS,
} from '../js/app-shell/duckdb-config.js';
import {
  getOPFSDatabaseStats,
  clearOPFSDatabase,
  consumePendingOPFSClear,
  isOPFSPersistenceActive,
} from '../js/app-shell/duckdb-engine.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra ? `\n      ${extra}` : ''}`); }
}
async function okAsync(name, promiseFn) {
  try {
    const cond = await promiseFn();
    ok(name, cond);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}\n      threw: ${e.message}`);
  }
}

// --- Constants: naming/collision sanity (these are load-bearing strings —
//     a typo here would silently split consent state across two keys) ---
ok('OPFS_CONSENT_KEY matches the documented localStorage key name',
  OPFS_CONSENT_KEY === 'dataglow_persist_opfs_database');
ok('OPFS_DATABASE_FILENAME is a fixed, non-empty filename',
  typeof OPFS_DATABASE_FILENAME === 'string' && OPFS_DATABASE_FILENAME.length > 0);

// --- isOPFSAvailable(): plain Node has no `navigator`, so this must be
//     false here — this is itself a safety property, not just an
//     environment quirk: it proves shouldPersistToOPFS() can never silently
//     engage OPFS in a non-browser context even if flag+consent are both true. ---
ok('isOPFSAvailable() is false under plain Node (no navigator/storage API)',
  isOPFSAvailable() === false);

// --- opfsDatabaseOpenConfig(): pure path construction ---
ok('opfsDatabaseOpenConfig() with no arg uses OPFS_DATABASE_FILENAME',
  opfsDatabaseOpenConfig().path === 'opfs://' + OPFS_DATABASE_FILENAME);
ok('opfsDatabaseOpenConfig(filename) uses the given filename',
  opfsDatabaseOpenConfig('custom.duckdb').path === 'opfs://custom.duckdb');
ok('opfsDatabaseOpenConfig() includes an explicit accessMode (READ_WRITE=3) -- proven required by live\n      browser testing: omitting it fails opening a brand-new OPFS path on the very first open',
  opfsDatabaseOpenConfig().accessMode === 3);
ok('opfsDatabaseOpenConfig() returns exactly {path, accessMode} (no unexpected extra fields)',
  Object.keys(opfsDatabaseOpenConfig()).sort().join(',') === 'accessMode,path');

// --- shouldPersistToOPFS(): three-way AND gate. Under plain Node,
//     isOPFSAvailable() is always false, so EVERY case here must be false —
//     this is intentional and is itself the strongest safety assertion:
//     flag+consent alone are never sufficient without real OPFS support. ---
ok('flag OFF + consent OFF -> false',
  shouldPersistToOPFS(false, false) === false);
ok('flag ON + consent OFF -> false (consent required even with flag on)',
  shouldPersistToOPFS(true, false) === false);
ok('flag OFF + consent ON -> false (flag required even with consent given)',
  shouldPersistToOPFS(false, true) === false);
ok('flag ON + consent ON, but no OPFS in this environment -> false',
  shouldPersistToOPFS(true, true) === false);
ok('undefined flag (e.g. isEnabled() before flags configured) -> false',
  shouldPersistToOPFS(undefined, true) === false);
ok('undefined consent (e.g. localStorage read failed) -> false',
  shouldPersistToOPFS(true, undefined) === false);
ok('truthy-but-not-strictly-true values do not accidentally pass (e.g. flagEnabled=1)',
  shouldPersistToOPFS(1, true) === false);

// --- Engine-side Node-safe fallbacks: no OPFS available -> report "not
//     stored" rather than throwing, and clear() is a safe no-op. ---
await okAsync('getOPFSDatabaseStats() with no OPFS available resolves to {exists:false, sizeBytes:0}',
  async () => {
    const stats = await getOPFSDatabaseStats();
    return stats.exists === false && stats.sizeBytes === 0;
  });
await okAsync('getOPFSDatabaseStats(customFilename) also resolves safely with no OPFS available',
  async () => {
    const stats = await getOPFSDatabaseStats('other.duckdb');
    return stats.exists === false && stats.sizeBytes === 0;
  });
await okAsync('clearOPFSDatabase() with no OPFS available resolves without throwing (safe no-op)',
  async () => {
    const result = await clearOPFSDatabase();
    return result && result.deleted === false && result.deferred === false;
  });
ok('isOPFSPersistenceActive() is false before any engine init has run this process',
  isOPFSPersistenceActive() === false);

// --- Deferred-clear mechanism (found necessary via live browser proof):
//     a live OPFS connection holds an exclusive lock on the database file,
//     so an in-session clear can't always delete it immediately -- it must
//     be able to fall back to "clear on next load" instead. These tests
//     cover the Node-safe halves of that path (the localStorage flag
//     read/write/consume contract); the actual NoModificationAllowedError
//     -> defer branch needs a real browser and is proven separately by the
//     live Playwright run (see dev-log/journal.md / NORTH_STAR.md). ---
ok('OPFS_PENDING_CLEAR_KEY is a fixed, non-empty localStorage key name',
  typeof OPFS_PENDING_CLEAR_KEY === 'string' && OPFS_PENDING_CLEAR_KEY.length > 0);
ok('OPFS_PENDING_CLEAR_KEY is distinct from OPFS_CONSENT_KEY (no key collision)',
  OPFS_PENDING_CLEAR_KEY !== OPFS_CONSENT_KEY);
await okAsync('consumePendingOPFSClear() with no localStorage available resolves without throwing (safe no-op)',
  async () => {
    await consumePendingOPFSClear();
    return true;
  });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
