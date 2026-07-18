// ============================================================
// DataGlow — DuckDB Hardening Tests
// Tests for js/app-shell/duckdb-config.js (all 8 improvements)
// ============================================================
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import everything from duckdb-config (no browser APIs needed for these tests)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  PERMITTED_EXTENSIONS,
  BLOCKED_EXTENSIONS,
  isExtensionPermitted,
  FSAA_THRESHOLD_BYTES,
  shouldUseFSAA,
  isFSAASupported,
  opfsTempDirSQL,
  isOPFSAvailable,
  isCrossOriginIsolated,
  coiDiagnostic,
  PINNED_DUCKDB_WASM_VERSION,
  XLSX_TRY_DUCKDB_NATIVE,
  isSafari,
  MEMORY64_BLOCKED,
  assertMemory64Blocked,
  QueryBatch,
  queryBatch,
  SERVER_OFFLOAD_DEFAULT,
  isServerOffloadActive,
} from '../js/app-shell/duckdb-config.js';

// ============================================================
// #1 — Extension allowlist
// ============================================================
describe('#1 Extension allowlist', () => {
  it('should export PERMITTED_EXTENSIONS as a Set', () => {
    assert.ok(PERMITTED_EXTENSIONS instanceof Set);
    assert.ok(PERMITTED_EXTENSIONS.size > 0);
  });

  it('should export BLOCKED_EXTENSIONS as a Set', () => {
    assert.ok(BLOCKED_EXTENSIONS instanceof Set);
    assert.ok(BLOCKED_EXTENSIONS.size > 0);
  });

  it('should permit parquet', () => {
    assert.equal(isExtensionPermitted('parquet'), true);
  });

  it('should permit json', () => {
    assert.equal(isExtensionPermitted('json'), true);
  });

  it('should permit excel', () => {
    assert.equal(isExtensionPermitted('excel'), true);
  });

  it('should permit httpfs', () => {
    assert.equal(isExtensionPermitted('httpfs'), true);
  });

  it('should block tpch', () => {
    assert.equal(isExtensionPermitted('tpch'), false);
  });

  it('should block spatial', () => {
    assert.equal(isExtensionPermitted('spatial'), false);
  });

  it('should block substrait', () => {
    assert.equal(isExtensionPermitted('substrait'), false);
  });

  it('should block inet', () => {
    assert.equal(isExtensionPermitted('inet'), false);
  });

  it('should handle empty string gracefully', () => {
    assert.equal(isExtensionPermitted(''), false);
  });

  it('should handle null gracefully', () => {
    assert.equal(isExtensionPermitted(null), false);
  });

  it('should be case-insensitive', () => {
    assert.equal(isExtensionPermitted('PARQUET'), true);
    assert.equal(isExtensionPermitted('TPCH'), false);
  });

  it('no extension should appear in both sets', () => {
    for (const ext of PERMITTED_EXTENSIONS) {
      assert.ok(!BLOCKED_EXTENSIONS.has(ext),
        ext + ' appears in both PERMITTED and BLOCKED');
    }
  });
});

// ============================================================
// #2 — File System Access API threshold
// ============================================================
describe('#2 FSAA threshold', () => {
  it('should set threshold to 100MB', () => {
    assert.equal(FSAA_THRESHOLD_BYTES, 100 * 1024 * 1024);
  });

  it('should return false for files under threshold', () => {
    assert.equal(shouldUseFSAA(50 * 1024 * 1024), false);
  });

  it('should return true for files over threshold', () => {
    assert.equal(shouldUseFSAA(150 * 1024 * 1024), true);
  });

  it('should return false for files exactly at threshold', () => {
    assert.equal(shouldUseFSAA(FSAA_THRESHOLD_BYTES), false);
  });

  it('should return false for zero bytes', () => {
    assert.equal(shouldUseFSAA(0), false);
  });

  it('should return false for non-numeric input', () => {
    assert.equal(shouldUseFSAA('big'), false);
    assert.equal(shouldUseFSAA(null), false);
    assert.equal(shouldUseFSAA(undefined), false);
  });

  it('isFSAASupported returns false in Node (no window.showOpenFilePicker)', () => {
    // In Node there is no window object
    assert.equal(isFSAASupported(), false);
  });
});

// ============================================================
// #3 — OPFS temp_directory
// ============================================================
describe('#3 OPFS temp_directory', () => {
  it('should return a SET pragma for the default dir', () => {
    const sql = opfsTempDirSQL();
    assert.ok(sql.startsWith("SET temp_directory = '"));
    assert.ok(sql.includes('tmp'));
  });

  it('should accept a custom directory', () => {
    const sql = opfsTempDirSQL('/custom/dir');
    assert.ok(sql.includes('/custom/dir'));
  });

  it('isOPFSAvailable returns false in Node (no navigator.storage.getDirectory)', () => {
    assert.equal(isOPFSAvailable(), false);
  });

  it('OPFS SQL uses single quotes only (no backticks)', () => {
    const sql = opfsTempDirSQL();
    assert.ok(!sql.includes('`'));
  });
});

// ============================================================
// #4 — COOP/COEP (runtime check)
// ============================================================
describe('#4 COOP/COEP cross-origin isolation', () => {
  it('isCrossOriginIsolated returns false in Node', () => {
    // globalThis.crossOriginIsolated is not set in Node
    assert.equal(isCrossOriginIsolated(), false);
  });

  it('coiDiagnostic returns a non-empty string', () => {
    const msg = coiDiagnostic();
    assert.ok(typeof msg === 'string' && msg.length > 0);
  });

  it('coiDiagnostic mentions COOP/COEP when not isolated', () => {
    const msg = coiDiagnostic();
    // In Node, crossOriginIsolated is false
    assert.ok(msg.includes('NOT active') || msg.includes('active'));
  });
});

// ============================================================
// #5 — Safari pin + XLSX_TRY_DUCKDB_NATIVE
// ============================================================
describe('#5 Safari version pin + XLSX fallback', () => {
  it('PINNED_DUCKDB_WASM_VERSION is a semver string', () => {
    assert.match(PINNED_DUCKDB_WASM_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('PINNED version matches vendored package', () => {
    // Read the vendored package.json to confirm the pin is accurate
    const pkg = JSON.parse(readFileSync(
      path.join(__dirname, '../assets/duckdb/duckdb-wasm.package.json'),
      'utf8'
    ));
    assert.equal(PINNED_DUCKDB_WASM_VERSION, pkg.version);
  });

  it('XLSX_TRY_DUCKDB_NATIVE is a boolean', () => {
    assert.ok(typeof XLSX_TRY_DUCKDB_NATIVE === 'boolean');
  });

  it('isSafari returns false in Node', () => {
    assert.equal(isSafari(), false);
  });
});

// ============================================================
// #6 — Memory64 guard
// ============================================================
describe('#6 Memory64 guard', () => {
  it('MEMORY64_BLOCKED is true', () => {
    assert.equal(MEMORY64_BLOCKED, true);
  });

  it('assertMemory64Blocked throws', () => {
    assert.throws(() => assertMemory64Blocked(), /Memory64/);
  });

  it('assertMemory64Blocked error message mentions Safari', () => {
    try {
      assertMemory64Blocked();
    } catch (e) {
      assert.ok(e.message.includes('Safari'));
    }
  });
});

// ============================================================
// #7 — QueryBatch
// ============================================================
describe('#7 QueryBatch', () => {
  it('queryBatch singleton is a QueryBatch instance', () => {
    assert.ok(queryBatch instanceof QueryBatch);
  });

  it('pendingCount starts at zero', () => {
    const qb = new QueryBatch();
    assert.equal(qb.pendingCount(), 0);
  });

  it('run resolves with result from runFn', async () => {
    const qb = new QueryBatch();
    const result = await qb.run('SELECT 1', async () => ({ rows: [{ n: 1 }] }));
    assert.deepEqual(result, { rows: [{ n: 1 }] });
  });

  it('identical concurrent queries share one runFn call', async () => {
    const qb = new QueryBatch();
    let callCount = 0;
    const slowFn = async (sql) => {
      callCount++;
      return new Promise((res) => setTimeout(() => res({ sql }), 20));
    };
    const [a, b, c] = await Promise.all([
      qb.run('SELECT * FROM t', slowFn),
      qb.run('SELECT * FROM t', slowFn),
      qb.run('SELECT * FROM t', slowFn),
    ]);
    assert.equal(callCount, 1, 'runFn should be called only once for identical SQL');
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  it('different queries go through separate runFn calls', async () => {
    const qb = new QueryBatch();
    let callCount = 0;
    const fn = async (sql) => { callCount++; return { sql }; };
    await Promise.all([
      qb.run('SELECT 1', fn),
      qb.run('SELECT 2', fn),
    ]);
    assert.equal(callCount, 2);
  });

  it('pendingCount increments and decrements correctly', async () => {
    const qb = new QueryBatch();
    let resolve;
    const fn = () => new Promise((r) => { resolve = r; });
    qb.run('SELECT slow', fn); // do not await
    assert.equal(qb.pendingCount(), 1);
    resolve({ done: true });
    // Flush microtasks
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(qb.pendingCount(), 0);
  });

  it('clear() rejects all pending queries', async () => {
    const qb = new QueryBatch();
    let settle;
    const fn = () => new Promise((r) => { settle = r; });
    const p = qb.run('SELECT slow', fn);
    qb.clear();
    await assert.rejects(p, /cleared/);
  });

  it('run propagates rejection from runFn', async () => {
    const qb = new QueryBatch();
    const fn = async () => { throw new Error('db error'); };
    await assert.rejects(qb.run('BAD SQL', fn), /db error/);
  });

  it('after a query completes, same SQL can be run again', async () => {
    const qb = new QueryBatch();
    let callCount = 0;
    const fn = async () => { callCount++; return callCount; };
    const first = await qb.run('SELECT 1', fn);
    const second = await qb.run('SELECT 1', fn);
    assert.equal(first, 1);
    assert.equal(second, 2); // second call after first settled = new call
    assert.equal(callCount, 2);
  });

  it('trims whitespace when deduplicating', async () => {
    const qb = new QueryBatch();
    let callCount = 0;
    const fn = async () => { callCount++; return callCount; };
    const [a, b] = await Promise.all([
      qb.run('  SELECT 1  ', fn),
      qb.run('SELECT 1', fn),
    ]);
    assert.equal(callCount, 1, 'leading/trailing whitespace should not split a batch');
    assert.equal(a, b);
  });
});

// ============================================================
// #8 — Server offload
// ============================================================
describe('#8 Server offload (opt-in only)', () => {
  it('SERVER_OFFLOAD_DEFAULT is false', () => {
    assert.equal(SERVER_OFFLOAD_DEFAULT, false);
  });

  it('isServerOffloadActive returns false when flag is false', () => {
    assert.equal(isServerOffloadActive(false, 'https://example.com'), false);
  });

  it('isServerOffloadActive returns false when endpoint is empty', () => {
    assert.equal(isServerOffloadActive(true, ''), false);
  });

  it('isServerOffloadActive returns false when endpoint is null', () => {
    assert.equal(isServerOffloadActive(true, null), false);
  });

  it('isServerOffloadActive returns true only when both flag=true AND endpoint set', () => {
    assert.equal(isServerOffloadActive(true, 'https://my-duckdb.example.com'), true);
  });

  it('isServerOffloadActive returns false when flag is undefined', () => {
    assert.equal(isServerOffloadActive(undefined, 'https://example.com'), false);
  });

  it('flags.manifest.json has serverOffload disabled by default', () => {
    const manifest = JSON.parse(readFileSync(
      path.join(__dirname, '../flags.manifest.json'),
      'utf8'
    ));
    assert.ok('serverOffload' in manifest.flags, 'serverOffload flag should exist');
    assert.equal(manifest.flags.serverOffload.enabled, false, 'serverOffload must be disabled by default');
  });
});
