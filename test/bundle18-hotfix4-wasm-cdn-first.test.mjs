// ============================================================
// DATAGLOW - Bundle 18 hotfix 4 proof: CDN wasm first, no silent hang
// ============================================================
// LIVE BUG after #611 (hotfix 3, hybrid self-host + CDN wasm) merged and
// published, proved on https://dataglow-platform.pplx.app with Playwright:
//
//   - fingerprint hybrid:true present in the HTML (the hotfix 3 code shipped)
//   - network: ONLY duckdb-browser.mjs and duckdb-browser-eh.worker.js get a
//     200; jsdelivr/unpkg wasm URLs are NEVER requested (hybrid_seen=false)
//   - SQL status: "Error: Cannot read properties of null (reading 'query')"
//   - pageerror: "Failed to fetch"
//
// So the hybrid CDN wasm retry hotfix 3 shipped was never executing on the
// live canvas SQL path at all.
//
// ROOT CAUSE (see BUNDLE18_HOTFIX4_RESULT.md for the full trace):
//   1. Hotfix 3's hybrid CDN retry only ran inside a `catch (eInstantiate)`
//      around `await db.instantiate(...)`. Live, the self-host wasm fetch
//      failure surfaces as an UNCAUGHT ERROR EVENT on the DuckDB-WASM
//      Worker thread (Emscripten's own instantiateAsync/getBinaryPromise),
//      not a rejected promise. AsyncDuckDB's own onError() handler answers
//      a worker `error` event by clearing pending requests WITHOUT ever
//      calling the promise rejecter tied to instantiate() (see
//      assets/duckdb/duckdb-browser.mjs). `await db.instantiate(...)` hangs
//      forever, the catch block (and the CDN retry inside it) never runs,
//      and no jsDelivr/unpkg network request ever fires -- exactly the
//      hybrid_seen=false symptom.
//   2. Independently, `query(sql, datasets)` for a table-free query (no
//      dataset registered, e.g. a bare `SELECT 1`) skipped the
//      registerDataset loop entirely -- the only place a null-db guard
//      existed -- and called `conn.query(sql)` directly. If ensureInit()
//      ever returned with db/conn still null (including as a knock-on
//      effect of bug 1), this produced the exact "Cannot read properties of
//      null (reading 'query')" from the live report.
//
// FIX (preferred, CDN wasm first):
//   1. js/sql/duckdb-load-harden.js: SELF_HOST_CANDIDATE now also carries
//      wasmCdnFirst (same jsDelivr 1.29.0 URLs as wasmFallback). New pure
//      helper buildSelfHostBundle(workerBundle, variant) builds the
//      self-host load bundle with mainModule ALREADY pointed at the CDN pin
//      -- applied up front, before the first instantiate() attempt, not
//      only on a caught retry. mainWorker (and therefore the whole
//      worker/mjs stack) stays same-origin. wasmFallback / isWasmFetchFailure
//      / buildHybridWasmBundle are all kept unchanged as a second-layer
//      safety net.
//   2. js/sql/sql-engine.js, js/app-shell/duckdb-engine.js, and
//      canvas/index.html (authoritative) all: apply buildSelfHostBundle()
//      up front for the self-host candidate; wrap every db.instantiate()
//      call in a new instantiateWithTimeout()/_dgInstantiateWithTimeout()
//      helper that races the real instantiate() against a manual Worker
//      `error`-event listener and a 45000ms deadline, so an uncaught
//      worker error or a hang always surfaces as a normal rejection instead
//      of starving the caller forever; share one initPromise across
//      concurrent callers so a race can never observe a half-initialized
//      db/conn; and add an unconditional null-conn guard directly in
//      query() (not only in registerDataset()) so a table-free query can
//      never reach a bare `conn.query(sql)` on a null connection.
//
// Pin stays 1.29.0 everywhere. No doubled assets/duckdb/ path introduced.
// The existing candidate-list walk (self-host -> jsDelivr -> unpkg ->
// esm.sh) and hotfix 3's hybrid retry-on-catch are both preserved as
// fallback layers underneath the new CDN-first behavior.
//
// This is a static/pure-module test file (no browser launch).
//
// RUN WITH:  node --test test/bundle18-hotfix4-wasm-cdn-first.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';
const DOUBLED_PATH_RE = /assets\/duckdb\/assets\/duckdb/;
const PIN = '1.29.0';
const TIMEOUT_MS = '45000';

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// ------------------------------------------------------------
// A. js/sql/duckdb-load-harden.js: WASM_CDN_FIRST pin, wasmCdnFirst field,
//    and buildSelfHostBundle() shared by every surface.
// ------------------------------------------------------------

describe('bundle18 hotfix4 A: shared CDN-first wasm helpers (js/sql/duckdb-load-harden.js)', () => {
  it('SELF_HOST_CANDIDATE carries a wasmCdnFirst pinned to jsDelivr 1.29.0, alongside the existing wasmFallback', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const cf = mod.SELF_HOST_CANDIDATE.wasmCdnFirst;
    assert.ok(cf, 'wasmCdnFirst missing from SELF_HOST_CANDIDATE');
    assert.equal(cf.eh, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-eh.wasm');
    assert.equal(cf.mvp, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-mvp.wasm');
    assert.ok(mod.SELF_HOST_CANDIDATE.wasmFallback, 'wasmFallback must still be present (second-layer safety net)');
    assert.equal(mod.SELF_HOST_CANDIDATE.wasmFallback.eh, cf.eh);
    assert.equal(mod.SELF_HOST_CANDIDATE.wasmFallback.mvp, cf.mvp);
  });

  it('buildCandidateList() carries wasmCdnFirst through for self-host only, alongside wasmFallback', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const list = mod.buildCandidateList();
    const selfHost = list.find((c) => c.id === 'self-host');
    assert.ok(selfHost.wasmCdnFirst, 'self-host candidate lost its wasmCdnFirst through buildCandidateList()');
    assert.ok(selfHost.wasmFallback, 'self-host candidate lost its wasmFallback through buildCandidateList()');
    assert.match(selfHost.wasmCdnFirst.eh, /^https:\/\/cdn\.jsdelivr\.net/);
    for (const cdn of list.filter((c) => c.id !== 'self-host')) {
      assert.equal(cdn.wasmCdnFirst, undefined, cdn.id + ' should not carry a wasmCdnFirst (only self-host needs one)');
    }
  });

  it('buildSelfHostBundle() returns mainModule already pinned to the CDN URL, mainWorker unchanged and same-origin', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    assert.equal(typeof mod.buildSelfHostBundle, 'function');
    const ehResult = mod.buildSelfHostBundle({ mainWorker: '/assets/duckdb/duckdb-browser-eh.worker.js', pthreadWorker: null }, 'eh');
    assert.equal(ehResult.mainModule, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-eh.wasm');
    assert.equal(ehResult.mainWorker, '/assets/duckdb/duckdb-browser-eh.worker.js');
    assert.equal(ehResult.pthreadWorker, null);

    const mvpResult = mod.buildSelfHostBundle({ mainWorker: '/assets/duckdb/duckdb-browser-mvp.worker.js' }, 'mvp');
    assert.equal(mvpResult.mainModule, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-mvp.wasm');
    assert.equal(mvpResult.mainWorker, '/assets/duckdb/duckdb-browser-mvp.worker.js');

    // Defaults to the 'eh' variant when variant is neither 'mvp' nor 'eh'.
    const defaulted = mod.buildSelfHostBundle({ mainWorker: '/assets/duckdb/duckdb-browser-eh.worker.js' }, undefined);
    assert.equal(defaulted.mainModule, ehResult.mainModule);
  });

  it('buildSelfHostBundle() never doubles the assets/duckdb path and never regresses the CDN pin', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const result = mod.buildSelfHostBundle({ mainWorker: '/assets/duckdb/duckdb-browser-eh.worker.js' }, 'eh');
    assert.doesNotMatch(result.mainModule, DOUBLED_PATH_RE);
    assert.doesNotMatch(result.mainWorker, DOUBLED_PATH_RE);
    assert.match(result.mainModule, new RegExp('@' + PIN.replace(/\./g, '\\.') + '/'));
    assert.equal(mod.DUCKDB_WASM_PIN, PIN);
  });

  it('the pre-existing hybrid retry-on-catch helpers (isWasmFetchFailure, buildHybridWasmBundle) are untouched and still exported', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    assert.equal(typeof mod.isWasmFetchFailure, 'function');
    assert.equal(typeof mod.buildHybridWasmBundle, 'function');
    assert.equal(mod.isWasmFetchFailure(new TypeError('Failed to fetch')), true);
    assert.equal(mod.isWasmFetchFailure(new Error('Table not found: foo')), false);
  });

  it('CDN fallback candidates (jsDelivr, unpkg, esm.sh) are unchanged: still after self-host, still absolute https', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const list = mod.buildCandidateList();
    assert.equal(list[0].id, 'self-host');
    assert.deepEqual(list.slice(1).map((c) => c.id), ['jsdelivr', 'unpkg', 'esm.sh']);
  });

  it('does not introduce an em dash in the edited region', () => {
    const src = readRepoFile(join('js', 'sql', 'duckdb-load-harden.js'));
    const idx = src.indexOf('Bundle 18 hotfix 4: hotfix 3');
    assert.notEqual(idx, -1);
    const region = src.slice(idx - 50, idx + 2200);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// B. js/sql/sql-engine.js: CDN-first applied up front, instantiate() always
//    timeout/error-guarded, shared initPromise, unconditional query() guard.
// ------------------------------------------------------------

describe('bundle18 hotfix4 B: js/sql/sql-engine.js CDN-first + no-silent-hang', () => {
  const src = readRepoFile(join('js', 'sql', 'sql-engine.js'));

  it('applies buildSelfHostBundle() to point mainModuleHref at the CDN pin BEFORE the first instantiate() attempt', () => {
    assert.match(src, /cand\.wasmCdnFirst && LOAD_HARDEN && typeof LOAD_HARDEN\.buildSelfHostBundle === 'function'/);
    assert.match(src, /LOAD_HARDEN\.buildSelfHostBundle\(\{ mainWorker: workerHref, pthreadWorker: bundle\.pthreadWorker \}, variant\)/);
    assert.match(src, /mainModuleHref = cdnFirstBundle\.mainModule;/);
  });

  it('every db.instantiate() call site (outside of comments) is wrapped in instantiateWithTimeout(), never called bare', () => {
    // Strip // line comments before scanning for bare call sites, since the
    // hotfix 4 root-cause comment intentionally quotes the OLD bare shape
    // (`await db.instantiate(...)`) as prose, not as live code.
    const codeOnly = src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    const bareCallSites = (codeOnly.match(/[^.]\bawait db\.instantiate\(/g) || []).length;
    assert.equal(bareCallSites, 0, 'found a bare `await db.instantiate(...)` call site that bypasses the timeout/error guard');
    assert.match(src, new RegExp('await instantiateWithTimeout\\(db, worker, mainModuleHref, bundle\\.pthreadWorker, ' + TIMEOUT_MS + '\\);'));
    assert.match(src, new RegExp('await instantiateWithTimeout\\(db, worker, hybridBundle\\.mainModule, hybridBundle\\.pthreadWorker, ' + TIMEOUT_MS + '\\);'));
  });

  it('instantiateWithTimeout races real instantiate() against a worker error-event listener and a deadline', () => {
    assert.match(src, /function instantiateWithTimeout\(dbInstance, worker, mainModuleHref, pthreadWorker, timeoutMs\)/);
    assert.match(src, /worker\.addEventListener\('error', onWorkerError\)/);
    assert.match(src, /setTimeout\(function \(\) \{/);
    assert.match(src, /instantiate timed out after/);
    assert.match(src, /dbInstance\.instantiate\(mainModuleHref, pthreadWorker\)\.then\(settleOk, settleErr\);/);
  });

  it('ensureInit() shares one initPromise across concurrent callers instead of a boolean flag', () => {
    assert.match(src, /var db = null, conn = null, initPromise = null, registeredTables = \{\};/);
    assert.doesNotMatch(src, /var initialised = false;/);
    assert.match(src, /if \(initPromise\) return initPromise;/);
    assert.match(src, /initPromise = doInit\(\);/);
  });

  it('query() has its own unconditional null-conn guard, independent of registerDataset(), for table-free queries', () => {
    const idx = src.indexOf('async function query(sql, datasets)');
    assert.notEqual(idx, -1);
    const region = src.slice(idx, idx + 1400);
    assert.match(region, /if \(!db \|\| !conn\) \{\s*\n\s*initPromise = null;\s*\n\s*await ensureInit\(\);\s*\n\s*\}/);
    assert.match(region, /throw new Error\('DuckDB-WASM engine not ready: no candidate host finished loading\. Retry to try the next host\.'\);/);
    // The guard must appear BEFORE conn.query(sql) is actually called.
    const guardIdx = region.indexOf('DuckDB-WASM engine not ready: no candidate host finished loading');
    const queryCallIdx = region.indexOf('await conn.query(sql)');
    assert.ok(guardIdx !== -1 && queryCallIdx !== -1 && guardIdx < queryCallIdx, 'null-conn guard must run before conn.query(sql)');
  });

  it('the module actually imports without throwing under plain Node (syntax + import graph sanity)', async () => {
    await assert.doesNotReject(import(join(REPO_ROOT, 'js', 'sql', 'sql-engine.js')));
  });

  it('does not introduce an em dash in the edited region', () => {
    const idx = src.indexOf('Bundle 18 hotfix 4: an uncaught error inside the DuckDB-WASM worker');
    assert.notEqual(idx, -1);
    const region = src.slice(idx - 50, idx + 3600);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// C. js/app-shell/duckdb-engine.js: root index.html surface gets the same
//    CDN-first application and timeout/error-guarded instantiate().
// ------------------------------------------------------------

describe('bundle18 hotfix4 C: js/app-shell/duckdb-engine.js CDN-first + no-silent-hang (root index.html surface)', () => {
  const src = readRepoFile(join('js', 'app-shell', 'duckdb-engine.js'));

  it('imports buildSelfHostBundle from the shared harden module', () => {
    assert.match(src, /import\s*\{\s*[\s\S]*buildSelfHostBundle[\s\S]*\}\s*from\s*'\.\.\/sql\/duckdb-load-harden\.js';/);
  });

  it('applies buildSelfHostBundle() to point bundle.mainModule at the CDN pin BEFORE the first instantiate() attempt', () => {
    assert.match(src, /if \(SELF_HOST_CANDIDATE\.wasmCdnFirst\) \{/);
    assert.match(src, /bundle = buildSelfHostBundle\(\{ mainWorker: bundle\.mainWorker, pthreadWorker: bundle\.pthreadWorker \}, variant\);/);
  });

  it('both instantiate() call sites (primary and hybrid retry) are wrapped in instantiateWithTimeout()', () => {
    const codeOnly = src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    const bareCallSites = (codeOnly.match(/[^.]\bawait db\.instantiate\(/g) || []).length;
    assert.equal(bareCallSites, 0, 'found a bare `await db.instantiate(...)` call site that bypasses the timeout/error guard');
    assert.match(src, new RegExp('await instantiateWithTimeout\\(db, worker, bundle\\.mainModule, bundle\\.pthreadWorker, ' + TIMEOUT_MS + '\\);'));
    assert.match(src, new RegExp('await instantiateWithTimeout\\(db, worker, hybridBundle\\.mainModule, hybridBundle\\.pthreadWorker, ' + TIMEOUT_MS + '\\);'));
  });

  it('instantiateWithTimeout races real instantiate() against a worker error-event listener and a deadline', () => {
    assert.match(src, /function instantiateWithTimeout\(db, worker, mainModule, pthreadWorker, timeoutMs\)/);
    assert.match(src, /worker\.addEventListener\('error', onWorkerError\)/);
    assert.match(src, /instantiate timed out after/);
  });

  it('runQuery() guards against a null conn even when state.duckdb.ready is stale, and re-initializes once before failing clearly', () => {
    const idx = src.indexOf('export async function runQuery(sql)');
    assert.notEqual(idx, -1);
    const region = src.slice(idx, idx + 1400);
    assert.match(region, /let conn = state\.duckdb\.conn;/);
    assert.match(region, /if \(!conn\) \{\s*\n\s*await initDuckDB\(\);\s*\n\s*conn = state\.duckdb\.conn;\s*\n\s*\}/);
    assert.match(region, /throw new Error\('DuckDB-WASM engine not ready: no candidate host finished loading\. Retry to try the next host\.'\);/);
  });

  it('the module actually imports without throwing under plain Node (syntax + import graph sanity)', async () => {
    await assert.doesNotReject(import(join(REPO_ROOT, 'js', 'app-shell', 'duckdb-engine.js')));
  });

  it('does not introduce an em dash in the edited region', () => {
    const idx = src.indexOf('Bundle 18 hotfix 4: an uncaught error inside the DuckDB-WASM worker thread');
    assert.notEqual(idx, -1);
    const region = src.slice(idx - 50, idx + 4200);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// D. canvas/index.html (authoritative): tracked splice re-injected, the
//    inline loader applies CDN-first up front, timeout/error-guarded
//    instantiate, shared initPromise, unconditional query() null guard.
// ------------------------------------------------------------

describe('bundle18 hotfix4 D: canvas/index.html CDN-first + no-silent-hang (canvas authoritative)', () => {
  const canvas = readRepoFile(join('canvas', 'index.html'));

  it('the tracked duckdb-load-harden.js splice carries wasmCdnFirst and buildSelfHostBundle', () => {
    const startMarker = '/* ---- from js/sql/duckdb-load-harden.js ---- */';
    const endMarker = '/* ---- end js/sql/duckdb-load-harden.js ---- */';
    const s = canvas.indexOf(startMarker);
    const e = canvas.indexOf(endMarker);
    assert.notEqual(s, -1, 'from marker missing');
    assert.notEqual(e, -1, 'end marker missing');
    const span = canvas.slice(s, e);
    assert.match(span, /wasmCdnFirst: WASM_CDN_FIRST,/);
    assert.match(span, /function buildSelfHostBundle\(/);
  });

  it('the hardcoded fallback candidate list also carries a wasmCdnFirst for self-host, applied up front', () => {
    const idx = canvas.indexOf('function _dgDuckCandidates()');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 1200);
    assert.match(region, /wasmCdnFirst: \{ mvp: DUCKDB_BASE_PRIMARY \+ 'duckdb-mvp\.wasm', eh: DUCKDB_BASE_PRIMARY \+ 'duckdb-eh\.wasm' \}/);
  });

  it('_loadDuckFrom applies buildSelfHostBundle() to override mainModuleUrl BEFORE the worker/instantiate call, when the candidate carries wasmCdnFirst', () => {
    const idx = canvas.indexOf('async function _loadDuckFrom(cdnUrl, baseUrl, candidate) {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 4600);
    assert.match(region, /candidate\.wasmCdnFirst && lhFront && typeof lhFront\.buildSelfHostBundle === 'function'/);
    assert.match(region, /lhFront\.buildSelfHostBundle\(\{ mainWorker: workerUrl, pthreadWorker: bundle\.pthreadWorker \}, _variant\)/);
    // The CDN-first override must run BEFORE `new Worker(` is constructed
    // and BEFORE the first instantiate() attempt for this candidate.
    const overrideIdx = region.indexOf('buildSelfHostBundle');
    const workerCtorIdx = region.indexOf('new Worker(');
    assert.ok(overrideIdx !== -1 && workerCtorIdx !== -1 && overrideIdx < workerCtorIdx, 'CDN-first override must run before new Worker() / instantiate()');
  });

  it('every adb.instantiate() call site in the canvas loader is wrapped in _dgInstantiateWithTimeout()', () => {
    const codeOnly = canvas.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    const bareCallSites = (codeOnly.match(/[^.]\bawait adb\.instantiate\(/g) || []).length;
    assert.equal(bareCallSites, 0, 'found a bare `await adb.instantiate(...)` call site in canvas that bypasses the timeout/error guard');
    assert.match(canvas, new RegExp('await _dgInstantiateWithTimeout\\(adb, worker, mainModuleUrl, bundle\\.pthreadWorker, ' + TIMEOUT_MS + '\\);'));
    assert.match(canvas, new RegExp('await _dgInstantiateWithTimeout\\(adb, worker, hybridBundle\\.mainModule, hybridBundle\\.pthreadWorker, ' + TIMEOUT_MS + '\\);'));
  });

  it('_dgInstantiateWithTimeout races real instantiate() against a worker error-event listener and a deadline', () => {
    assert.match(canvas, /function _dgInstantiateWithTimeout\(adb, worker, mainModuleUrl, pthreadWorker, timeoutMs\)/);
    assert.match(canvas, /worker\.addEventListener\('error', onWorkerError\)/);
    assert.match(canvas, /instantiate timed out after/);
    assert.match(canvas, /adb\.instantiate\(mainModuleUrl, pthreadWorker\)\.then\(settleOk, settleErr\);/);
  });

  it('ensureInit() in canvas shares one initPromise via _dgDoInit(), not a boolean flag', () => {
    assert.match(canvas, /var db = null, conn = null, initPromise = null, registeredTables = \{\};/);
    assert.match(canvas, /if \(initPromise\) return initPromise;/);
    assert.match(canvas, /initPromise = _dgDoInit\(\);/);
  });

  it('query() in canvas has its own unconditional null-conn guard, independent of registerDataset(), for table-free queries', () => {
    const idx = canvas.indexOf('async function query(sql, datasets) {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 1400);
    assert.match(region, /if \(!db \|\| !conn\) \{\s*\n\s*initPromise = null;\s*\n\s*await ensureInit\(\)\.catch\(function \(\) \{\}\);\s*\n\s*\}/);
    assert.match(region, /_dgShowSqlEngineBanner\('error', 'DuckDB-WASM engine not ready: no candidate host finished loading\. Retry to try the next host\.'\);/);
    const guardIdx = region.indexOf('DuckDB-WASM engine not ready: no candidate host finished loading');
    const queryCallIdx = region.indexOf('await conn.query(sql)');
    assert.ok(guardIdx !== -1 && queryCallIdx !== -1 && guardIdx < queryCallIdx, 'null-conn guard must run before conn.query(sql)');
  });

  it('no doubled assets/duckdb/assets/duckdb path pattern exists anywhere in canvas/index.html', () => {
    assert.doesNotMatch(canvas, DOUBLED_PATH_RE);
  });

  it('the pin stays 1.29.0 in every wasmCdnFirst/wasmFallback base URL in canvas', () => {
    const matches = canvas.match(/duckdb-wasm@[\d.]+\/dist\//g) || [];
    assert.ok(matches.length > 0, 'expected at least one pinned CDN base URL in canvas');
    for (const m of matches) {
      assert.match(m, new RegExp('@' + PIN.replace(/\./g, '\\.') + '/'));
    }
  });

  it('does not introduce an em dash in the edited canvas regions', () => {
    const idx = canvas.indexOf('Bundle 18 hotfix 4: applied UP FRONT by _loadDuckFrom');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx - 50, idx + 2600);
    assert.doesNotMatch(region, new RegExp(EM_DASH));

    const idx2 = canvas.indexOf('Bundle 18 hotfix 4: an uncaught error inside the DuckDB-WASM worker');
    assert.notEqual(idx2, -1);
    const region2 = canvas.slice(idx2 - 50, idx2 + 2600);
    assert.doesNotMatch(region2, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// E. Manifest consistency: canvasBytes and the duckdb-load-harden.js
//    tracked hash match after resync_duckdb_load_harden.py + hand edits.
// ------------------------------------------------------------

describe('bundle18 hotfix4 E: canvas integrity manifest matches canvas/index.html', () => {
  it('canvasBytes in the manifest matches the actual file size', () => {
    const manifest = JSON.parse(readRepoFile(join('canvas', 'integrity.manifest.json')));
    const bytes = statSync(join(REPO_ROOT, 'canvas', 'index.html')).size;
    assert.equal(manifest.canvasBytes, bytes);
  });

  it('the js/sql/duckdb-load-harden.js manifest entry hash matches the current source file', () => {
    const manifest = JSON.parse(readRepoFile(join('canvas', 'integrity.manifest.json')));
    const entry = manifest.tracked.find((t) => t.source === 'js/sql/duckdb-load-harden.js');
    assert.ok(entry, 'manifest entry for js/sql/duckdb-load-harden.js missing');
    const src = readRepoFile(join('js', 'sql', 'duckdb-load-harden.js'));
    const sha = createHash('sha256').update(src, 'utf8').digest('hex');
    assert.equal(entry.sourceSha256, sha);
  });

  it('the js/sql/duckdb-load-harden.js manifest entry canvasSectionSha256 matches the current inlined span', () => {
    const manifest = JSON.parse(readRepoFile(join('canvas', 'integrity.manifest.json')));
    const entry = manifest.tracked.find((t) => t.source === 'js/sql/duckdb-load-harden.js');
    const startMarker = '/* ---- from js/sql/duckdb-load-harden.js ---- */';
    const endMarker = '/* ---- end js/sql/duckdb-load-harden.js ---- */';
    const c = readRepoFile(join('canvas', 'index.html'));
    const i = c.indexOf(startMarker);
    const j = c.indexOf(endMarker, i);
    const span = c.slice(i, j + endMarker.length);
    const sha = createHash('sha256').update(span, 'utf8').digest('hex');
    assert.equal(entry.canvasSectionSha256, sha);
    assert.equal(entry.canvasSectionBytes, span.length);
  });
});

// ------------------------------------------------------------
// F. Root cause + fix documented (not silently dropped).
// ------------------------------------------------------------

describe('bundle18 hotfix4 F: BUNDLE18_HOTFIX4_RESULT.md documents root cause and fix', () => {
  it('the result doc exists and names the worker error-event root cause and the CDN-first fix', () => {
    const doc = readRepoFile('BUNDLE18_HOTFIX4_RESULT.md');
    assert.match(doc, /worker/i);
    assert.match(doc, /error/i);
    assert.match(doc, /jsdelivr\.net/i);
    assert.match(doc, /wasmCdnFirst|buildSelfHostBundle|CDN.first/i);
    assert.doesNotMatch(doc, new RegExp(EM_DASH));
  });
});
