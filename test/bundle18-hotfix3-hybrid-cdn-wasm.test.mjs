// ============================================================
// DATAGLOW - Bundle 18 hotfix 3 proof: hybrid self-host + CDN wasm
// ============================================================
// LIVE BUG (after #609 importmap + #610 absolute paths), proved on
// https://dataglow-platform.pplx.app with Playwright:
//
//   - mjs + arrow + worker: 200 same-origin, no doubled path
//   - /assets/duckdb/duckdb-eh.wasm (35MB) fails in the browser:
//       net::ERR_FAILED / TypeError: Failed to fetch
//   - curl from a server against the SAME path works: it follows a 302
//     redirect to S3 and gets a 35MB application/wasm response. A browser
//     fetch()/WASM streaming request under this host cannot follow that
//     redirect the same way.
//   - jsDelivr and unpkg wasm: 200, CORS, WebAssembly.compile OK from the
//     same page.
//   - crossOriginIsolated is false on live (unrelated, documented residual
//     from BUNDLE18_HOTFIX2_RESULT.md).
//   - SQL status: "Error: Cannot read properties of null (reading 'query')"
//     because instantiate() never completed.
//   - The candidate fallback was NOT recovering to a CDN candidate after
//     the self-host wasm fetch failed.
//
// FIX (hybrid self-host candidate, preferred for pplx.app reliability):
//   1. js/sql/duckdb-load-harden.js: SELF_HOST_CANDIDATE now carries a
//      wasmFallback = { mvp, eh } pointing at the jsDelivr 1.29.0 wasm pin.
//      New pure helpers: isWasmFetchFailure(err) classifies a fetch/compile
//      error as "the wasm binary was unfetchable", and
//      buildHybridWasmBundle(bundle, candidate) returns the SAME bundle
//      with only mainModule swapped to the CDN pin (mainWorker, and
//      therefore the whole worker/mjs stack, stays same-origin).
//   2. js/sql/sql-engine.js ensureInit(): db.instantiate() is wrapped; on a
//      wasm-fetch-shaped failure it retries the SAME worker/db with the
//      hybrid CDN wasm URL before giving up on the self-host candidate. If
//      the hybrid retry also fails, the error propagates and the existing
//      candidate loop advances to the next full candidate (jsDelivr).
//   3. js/app-shell/duckdb-engine.js (root index.html surface): same
//      instantiate-then-hybrid-retry pattern, importing the shared
//      SELF_HOST_CANDIDATE / isWasmFetchFailure / buildHybridWasmBundle
//      helpers instead of duplicating the pin.
//   4. canvas/index.html (authoritative for the canvas surface): the
//      tracked js/sql/duckdb-load-harden.js splice was re-injected
//      (resync_duckdb_load_harden.py); the canvas loader's own
//      _loadDuckFrom() now accepts the full candidate object and applies
//      the identical instantiate-then-hybrid-retry pattern; the hardcoded
//      fallback candidate list (used only if DataGlowDuckDBLoadHarden
//      itself failed to load) also carries a wasmFallback for self-host.
//
// Pin stays 1.29.0 everywhere. No doubled assets/duckdb/ path introduced.
// A null-db "Cannot read properties of null (reading 'query')" must not be
// the only outcome after a failed self-host instantiate: the engine either
// recovers via the hybrid CDN wasm retry, or the existing candidate loop
// advances to a full CDN candidate, or (if every candidate is exhausted) a
// clear "DuckDB-WASM engine not ready" error surfaces instead of a bare
// null property read.
//
// This is a static/pure-module test file (no browser launch).
//
// RUN WITH:  node --test test/bundle18-hotfix3-hybrid-cdn-wasm.test.mjs

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

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// ------------------------------------------------------------
// A. js/sql/duckdb-load-harden.js: hybrid wasm fallback + classifier +
//    bundle-builder helpers, shared by every surface.
// ------------------------------------------------------------

describe('bundle18 hotfix3 A: shared hybrid wasm fallback (js/sql/duckdb-load-harden.js)', () => {
  it('SELF_HOST_CANDIDATE carries a wasmFallback pinned to jsDelivr 1.29.0', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const wf = mod.SELF_HOST_CANDIDATE.wasmFallback;
    assert.ok(wf, 'wasmFallback missing from SELF_HOST_CANDIDATE');
    assert.equal(wf.eh, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-eh.wasm');
    assert.equal(wf.mvp, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-mvp.wasm');
  });

  it('buildCandidateList() carries wasmFallback through for self-host only', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const list = mod.buildCandidateList();
    const selfHost = list.find((c) => c.id === 'self-host');
    assert.ok(selfHost.wasmFallback, 'self-host candidate lost its wasmFallback through buildCandidateList()');
    assert.match(selfHost.wasmFallback.eh, /^https:\/\/cdn\.jsdelivr\.net/);
    for (const cdn of list.filter((c) => c.id !== 'self-host')) {
      assert.equal(cdn.wasmFallback, undefined, cdn.id + ' should not carry a wasmFallback (only self-host needs one)');
    }
  });

  it('isWasmFetchFailure classifies fetch/compile failures, not arbitrary errors', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    assert.equal(mod.isWasmFetchFailure(new TypeError('Failed to fetch')), true);
    assert.equal(mod.isWasmFetchFailure(new Error('net::ERR_FAILED')), true);
    assert.equal(mod.isWasmFetchFailure(new Error("Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok")), true);
    assert.equal(mod.isWasmFetchFailure(new Error('NetworkError when attempting to fetch resource')), true);
    assert.equal(mod.isWasmFetchFailure(new Error('SyntaxError: Unexpected token')), false);
    assert.equal(mod.isWasmFetchFailure(new Error('Table not found: foo')), false);
    assert.equal(mod.isWasmFetchFailure(null), false);
  });

  it('buildHybridWasmBundle swaps only mainModule to the CDN pin, keeps mainWorker same-origin', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const ehBundle = { mainModule: '/assets/duckdb/duckdb-eh.wasm', mainWorker: '/assets/duckdb/duckdb-browser-eh.worker.js', pthreadWorker: null };
    const hybrid = mod.buildHybridWasmBundle(ehBundle, mod.SELF_HOST_CANDIDATE);
    assert.ok(hybrid, 'expected a hybrid bundle for an eh self-host bundle');
    assert.equal(hybrid.mainModule, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-eh.wasm');
    assert.equal(hybrid.mainWorker, '/assets/duckdb/duckdb-browser-eh.worker.js');

    const mvpBundle = { mainModule: '/assets/duckdb/duckdb-mvp.wasm', mainWorker: '/assets/duckdb/duckdb-browser-mvp.worker.js' };
    const hybridMvp = mod.buildHybridWasmBundle(mvpBundle, mod.SELF_HOST_CANDIDATE);
    assert.equal(hybridMvp.mainModule, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-mvp.wasm');
  });

  it('buildHybridWasmBundle returns null when the candidate has no wasmFallback (a CDN candidate)', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const jsDelivrCand = mod.buildCandidateList().find((c) => c.id === 'jsdelivr');
    const bundle = { mainModule: jsDelivrCand.baseUrl + 'duckdb-eh.wasm', mainWorker: jsDelivrCand.baseUrl + 'duckdb-browser-eh.worker.js' };
    assert.equal(mod.buildHybridWasmBundle(bundle, jsDelivrCand), null);
  });

  it('hybrid bundle never doubles the assets/duckdb path and never regresses the CDN pin', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const ehBundle = { mainModule: '/assets/duckdb/duckdb-eh.wasm', mainWorker: '/assets/duckdb/duckdb-browser-eh.worker.js' };
    const hybrid = mod.buildHybridWasmBundle(ehBundle, mod.SELF_HOST_CANDIDATE);
    assert.doesNotMatch(hybrid.mainModule, DOUBLED_PATH_RE);
    assert.match(hybrid.mainModule, new RegExp('@' + PIN.replace(/\./g, '\\.') + '/'));
    assert.equal(mod.DUCKDB_WASM_PIN, PIN);
  });

  it('CDN fallback candidates (jsDelivr, unpkg, esm.sh) are unchanged: still after self-host, still absolute https', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const list = mod.buildCandidateList();
    assert.equal(list[0].id, 'self-host');
    assert.deepEqual(list.slice(1).map((c) => c.id), ['jsdelivr', 'unpkg', 'esm.sh']);
    for (const cand of list.slice(1)) {
      assert.match(cand.cdnUrl, /^https:\/\//);
      assert.match(cand.baseUrl, /^https:\/\//);
    }
  });
});

// ------------------------------------------------------------
// B. js/sql/sql-engine.js: hybrid retry wired into ensureInit(), and the
//    candidate loop still advances to the next full candidate afterward.
// ------------------------------------------------------------

describe('bundle18 hotfix3 B: js/sql/sql-engine.js hybrid retry + fallback advance', () => {
  const src = readRepoFile(join('js', 'sql', 'sql-engine.js'));

  it('wraps db.instantiate() (via the hotfix4 timeout-guarded helper) and retries with a hybrid bundle on a wasm fetch failure', () => {
    // Bundle 18 hotfix 4 renamed the raw `await db.instantiate(...)` call
    // site to `instantiateWithTimeout(...)`, which still calls
    // db.instantiate() internally but also guards against an uncaught
    // worker-thread error hanging the promise forever (see
    // BUNDLE18_HOTFIX4_RESULT.md). The hybrid-retry wiring itself is
    // unchanged: still triggered by the same isWasmFetchFailure/
    // buildHybridWasmBundle pair from js/sql/duckdb-load-harden.js.
    assert.match(src, /catch \(eInstantiate\)/);
    assert.match(src, /LOAD_HARDEN\.isWasmFetchFailure\(eInstantiate\)/);
    assert.match(src, /LOAD_HARDEN\.buildHybridWasmBundle\(/);
    assert.match(src, /await instantiateWithTimeout\(db, worker, hybridBundle\.mainModule, hybridBundle\.pthreadWorker, \d+\);/);
  });

  it('rethrows unchanged when there is no hybrid bundle available, so the outer candidate loop can advance', () => {
    assert.match(src, /if \(!hybridBundle \|\| hybridBundle\.mainModule === mainModuleHref\) throw eInstantiate;/);
  });

  it('a failed hybrid retry also rethrows, so self-host cannot get stuck half-instantiated', () => {
    assert.match(src, /catch \(eHybrid\)/);
  });

  it('never reaches a bare null db.query(): registerDataset and query() throw a clear message when every candidate failed', () => {
    assert.match(src, /DuckDB-WASM engine not ready: no candidate host finished loading/);
  });

  it('does not introduce an em dash in the edited region', () => {
    const idx = src.indexOf('Hybrid self-host candidate (Bundle 18 hotfix 3, extended by');
    assert.notEqual(idx, -1);
    const region = src.slice(idx - 200, idx + 1800);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// C. js/app-shell/duckdb-engine.js: root index.html surface gets the same
//    hybrid retry, sourced from the shared module (no duplicated pin).
// ------------------------------------------------------------

describe('bundle18 hotfix3 C: js/app-shell/duckdb-engine.js hybrid retry (root index.html surface)', () => {
  const src = readRepoFile(join('js', 'app-shell', 'duckdb-engine.js'));

  it('imports the shared hybrid helpers instead of duplicating the CDN pin', () => {
    assert.match(src, /import\s*\{\s*[\s\S]*SELF_HOST_CANDIDATE[\s\S]*\}\s*from\s*'\.\.\/sql\/duckdb-load-harden\.js';/);
    assert.match(src, /isWasmFetchFailure/);
    assert.match(src, /buildHybridWasmBundle/);
  });

  it('wraps db.instantiate() (via the hotfix4 timeout-guarded helper) with a try/catch that retries via buildHybridWasmBundle', () => {
    assert.match(src, /catch \(instantiateErr\)/);
    assert.match(src, /isWasmFetchFailure\(instantiateErr\)/);
    assert.match(src, /buildHybridWasmBundle\(bundle, SELF_HOST_CANDIDATE\)/);
    assert.match(src, /await instantiateWithTimeout\(db, worker, hybridBundle\.mainModule, hybridBundle\.pthreadWorker, \d+\);/);
  });

  it('rethrows the original error (not the hybrid attempt) when isWasmFetchFailure is false', () => {
    assert.match(src, /if \(!isWasmFetchFailure\(instantiateErr\)\) \{\s*\n\s*URL\.revokeObjectURL\(workerUrl\);\s*\n\s*throw instantiateErr;/);
  });

  it('the module actually imports without throwing under plain Node (syntax + import graph sanity)', async () => {
    await assert.doesNotReject(import(join(REPO_ROOT, 'js', 'app-shell', 'duckdb-engine.js')));
  });

  it('does not introduce an em dash in the edited region', () => {
    const idx = src.indexOf('Hybrid self-host candidate (Bundle 18 hotfix 3, extended by');
    assert.notEqual(idx, -1);
    const endIdx = src.indexOf('await instantiateWithTimeout(db, worker, hybridBundle.mainModule, hybridBundle.pthreadWorker,', idx);
    assert.notEqual(endIdx, -1);
    const region = src.slice(idx, endIdx + 80);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// D. canvas/index.html (authoritative): tracked splice re-injected, inline
//    loader carries the identical hybrid retry, no doubled paths.
// ------------------------------------------------------------

describe('bundle18 hotfix3 D: canvas/index.html hybrid retry (canvas authoritative)', () => {
  const canvas = readRepoFile(join('canvas', 'index.html'));

  it('the tracked duckdb-load-harden.js splice carries the wasmFallback, wasmCdnFirst, and helpers', () => {
    const startMarker = '/* ---- from js/sql/duckdb-load-harden.js ---- */';
    const endMarker = '/* ---- end js/sql/duckdb-load-harden.js ---- */';
    const s = canvas.indexOf(startMarker);
    const e = canvas.indexOf(endMarker);
    assert.notEqual(s, -1, 'from marker missing');
    assert.notEqual(e, -1, 'end marker missing');
    const span = canvas.slice(s, e);
    assert.match(span, /wasmFallback: WASM_CDN_FIRST,/);
    assert.match(span, /wasmCdnFirst: WASM_CDN_FIRST,/);
    assert.match(span, /function isWasmFetchFailure\(/);
    assert.match(span, /function buildHybridWasmBundle\(/);
    assert.match(span, /function buildSelfHostBundle\(/);
  });

  it('_loadDuckFrom applies the CDN-first wasm URL up front for self-host, and still retries via hybrid on fetch failure', () => {
    // Bundle 18 hotfix 4: preferred fix. mainModuleUrl is pointed at the
    // jsDelivr pin BEFORE the first instantiate() attempt for any candidate
    // carrying wasmCdnFirst (self-host), not only after a caught rejection.
    assert.match(canvas, /async function _loadDuckFrom\(cdnUrl, baseUrl, candidate\) \{/);
    assert.match(canvas, /candidate\.wasmCdnFirst && lhFront && typeof lhFront\.buildSelfHostBundle === 'function'/);
    assert.match(canvas, /lh\.isWasmFetchFailure\(eInstantiate\)/);
    assert.match(canvas, /lh\.buildHybridWasmBundle\(/);
    assert.match(canvas, /await _dgInstantiateWithTimeout\(adb, worker, hybridBundle\.mainModule, hybridBundle\.pthreadWorker, \d+\);/);
  });

  it('instantiate() is always raced against a worker error-event listener and a deadline, so it can never hang silently', () => {
    // Bundle 18 hotfix 4 root cause: an uncaught worker `error` event left
    // adb.instantiate() pending forever because AsyncDuckDB.onError() clears
    // pending requests without rejecting them. _dgInstantiateWithTimeout
    // guarantees a rejection either way.
    assert.match(canvas, /function _dgInstantiateWithTimeout\(adb, worker, mainModuleUrl, pthreadWorker, timeoutMs\)/);
    assert.match(canvas, /worker\.addEventListener\('error', onWorkerError\)/);
    assert.match(canvas, /setTimeout\(function \(\) \{[\s\S]{0,200}?instantiate timed out after/);
  });

  it('the candidate loop call site passes the full candidate object through', () => {
    assert.match(canvas, /loaded = await _loadDuckFrom\(_cand\.cdnUrl, _cand\.baseUrl, _cand\);/);
  });

  it('the hardcoded fallback candidate list also carries a wasmCdnFirst (and wasmFallback) for self-host', () => {
    const idx = canvas.indexOf('function _dgDuckCandidates()');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 1200);
    assert.match(region, /wasmCdnFirst: \{ mvp: DUCKDB_BASE_PRIMARY \+ 'duckdb-mvp\.wasm', eh: DUCKDB_BASE_PRIMARY \+ 'duckdb-eh\.wasm' \}/);
    assert.match(region, /wasmFallback: \{ mvp: DUCKDB_BASE_PRIMARY \+ 'duckdb-mvp\.wasm', eh: DUCKDB_BASE_PRIMARY \+ 'duckdb-eh\.wasm' \}/);
  });

  it('no doubled assets/duckdb/assets/duckdb path pattern exists anywhere in canvas/index.html', () => {
    assert.doesNotMatch(canvas, DOUBLED_PATH_RE);
  });

  it('the pin stays 1.29.0 in every hybrid wasm base URL in canvas', () => {
    const matches = canvas.match(/duckdb-wasm@[\d.]+\/dist\//g) || [];
    assert.ok(matches.length > 0, 'expected at least one pinned CDN base URL in canvas');
    for (const m of matches) {
      assert.match(m, new RegExp('@' + PIN.replace(/\./g, '\\.') + '/'));
    }
    // DUCKDB_BASE_PRIMARY is the jsDelivr base the hardcoded fallback
    // candidate list's wasmFallback is built from via string concatenation
    // (DUCKDB_BASE_PRIMARY + 'duckdb-eh.wasm'), so also confirm that base
    // constant itself carries the 1.29.0 pin.
    assert.match(canvas, new RegExp("DUCKDB_BASE_PRIMARY = 'https://cdn\\.jsdelivr\\.net/npm/@duckdb/duckdb-wasm@" + PIN.replace(/\./g, '\\.') + "/dist/';"));
  });

  it('does not introduce an em dash in the edited canvas regions', () => {
    const idx = canvas.indexOf('Hybrid self-host candidate (Bundle 18 hotfix 3, extended by');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx - 200, idx + 2200);
    assert.doesNotMatch(region, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// E. Manifest consistency: canvasBytes and the duckdb-load-harden.js
//    tracked hash match after resync_duckdb_load_harden.py + hand edits.
// ------------------------------------------------------------

describe('bundle18 hotfix3 E: canvas integrity manifest matches canvas/index.html', () => {
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
    const s = canvas_span_start();
    function canvas_span_start() {
      const c = readRepoFile(join('canvas', 'index.html'));
      const i = c.indexOf(startMarker);
      const j = c.indexOf(endMarker, i);
      return c.slice(i, j + endMarker.length);
    }
    const sha = createHash('sha256').update(s, 'utf8').digest('hex');
    assert.equal(entry.canvasSectionSha256, sha);
    assert.equal(entry.canvasSectionBytes, s.length);
  });
});

// ------------------------------------------------------------
// F. Root cause + fix documented (not silently dropped).
// ------------------------------------------------------------

describe('bundle18 hotfix3 F: BUNDLE18_HOTFIX3_RESULT.md documents root cause and fix', () => {
  it('the result doc exists and names the S3 redirect root cause and the hybrid fix', () => {
    const doc = readRepoFile('BUNDLE18_HOTFIX3_RESULT.md');
    assert.match(doc, /S3/);
    assert.match(doc, /redirect/i);
    assert.match(doc, /hybrid/i);
    assert.match(doc, /jsdelivr\.net/i);
    assert.doesNotMatch(doc, new RegExp(EM_DASH));
  });
});
