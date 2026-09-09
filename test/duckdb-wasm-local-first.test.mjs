// test/duckdb-wasm-local-first.test.mjs
//
// FIX: DuckDB wasm must load LOCAL FIRST (fix/duckdb-wasm-local-first).
//
// WHY THIS EXISTS
// Bundle 18 hotfix 3 added a jsDelivr wasm fallback reached from a catch;
// hotfix 4 then promoted that CDN URL to the PRIMARY mainModule for the
// self-host candidate (`wasmCdnFirst`), because a hung worker meant the
// catch-path retry never fired on dataglow-platform.pplx.app. The side
// effect was that DataGlow, a local-first product that already ships
// duckdb-eh.wasm (35.6 MB) and duckdb-mvp.wasm (40.6 MB) inside
// assets/duckdb/, could not run SQL at all without internet access.
//
// This change inverts the ordering back to local first while keeping every
// fallback layer hotfix 3 and hotfix 4 added:
//
//   1. PRIMARY: same-origin /assets/duckdb/duckdb-{eh,mvp}.wasm, applied up
//      front by buildSelfHostBundle() on every surface.
//   2. RETRY (unchanged): on a wasm-fetch-shaped failure only,
//      buildHybridWasmBundle() swaps mainModule to the pinned jsDelivr
//      1.29.0 wasm and keeps the same-origin worker/mjs stack. This covers
//      the hosted case where a 35 MB same-origin asset 302-redirects to S3
//      and the browser wasm fetch refuses to follow it.
//   3. THEN (unchanged): the candidate-list walk advances self-host ->
//      jsDelivr -> unpkg -> esm.sh.
//
// What makes local-first safe now is hotfix 4's OTHER change, which this
// fix deliberately leaves alone: instantiateWithTimeout /
// _dgInstantiateWithTimeout race db.instantiate() against a worker `error`
// listener and a deadline, so layer 2 can always be reached instead of
// starving behind a promise that never settles.
//
// SCOPE OF THIS FILE
//   A. js/sql/duckdb-load-harden.js: the shared source of truth.
//   B. assets/duckdb/: the wasm binaries really are on disk and really are
//      wasm (so "prefer local" is not preferring a 404).
//   C. all three consuming surfaces are wired to the local-first field.
//   D. the fallback layers are still present on every surface.
//   E. no em dash in the edited regions (product-text guardrail).
//
// This is a static/pure-module test file (no browser launch). The browser
// proof (wasm served 200 from the local origin, plus an offline probe) is
// recorded separately under proof-wasm/.
//
// RUN WITH:  node --test test/duckdb-wasm-local-first.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';
const DOUBLED_PATH_RE = /assets\/duckdb\/assets\/duckdb/;
const PIN = '1.29.0';
const LOCAL_BASE = '/assets/duckdb/';
const JSDELIVR_RE = /cdn\.jsdelivr\.net/;

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

function loadHarden() {
  return import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
}

// ------------------------------------------------------------
// A. js/sql/duckdb-load-harden.js: the single place that decides which wasm
//    URL every surface tries first.
// ------------------------------------------------------------

describe('wasm local first A: shared harden module (js/sql/duckdb-load-harden.js)', () => {
  it('SELF_HOST_CANDIDATE.wasmLocalFirst points at the same-origin /assets/duckdb/ wasm', async () => {
    const mod = await loadHarden();
    const lf = mod.SELF_HOST_CANDIDATE.wasmLocalFirst;
    assert.ok(lf, 'wasmLocalFirst missing from SELF_HOST_CANDIDATE');
    assert.equal(lf.eh, LOCAL_BASE + 'duckdb-eh.wasm');
    assert.equal(lf.mvp, LOCAL_BASE + 'duckdb-mvp.wasm');
    assert.doesNotMatch(lf.eh, JSDELIVR_RE);
    assert.doesNotMatch(lf.mvp, JSDELIVR_RE);
  });

  it('the superseded wasmCdnFirst field is gone, so nothing can silently keep pinning the CDN up front', async () => {
    const mod = await loadHarden();
    assert.equal(mod.SELF_HOST_CANDIDATE.wasmCdnFirst, undefined);
    assert.equal(mod.WASM_CDN_FIRST, undefined);
    const src = readRepoFile(join('js', 'sql', 'duckdb-load-harden.js'));
    assert.doesNotMatch(src, /wasmCdnFirst|WASM_CDN_FIRST/);
  });

  it('buildSelfHostBundle() returns a same-origin root-absolute mainModule for eh, mvp, and the default variant', async () => {
    const mod = await loadHarden();
    assert.equal(typeof mod.buildSelfHostBundle, 'function');

    const eh = mod.buildSelfHostBundle({ mainWorker: LOCAL_BASE + 'duckdb-browser-eh.worker.js', pthreadWorker: null }, 'eh');
    assert.equal(eh.mainModule, LOCAL_BASE + 'duckdb-eh.wasm');
    assert.equal(eh.mainWorker, LOCAL_BASE + 'duckdb-browser-eh.worker.js');
    assert.equal(eh.pthreadWorker, null);

    const mvp = mod.buildSelfHostBundle({ mainWorker: LOCAL_BASE + 'duckdb-browser-mvp.worker.js' }, 'mvp');
    assert.equal(mvp.mainModule, LOCAL_BASE + 'duckdb-mvp.wasm');

    // Unknown variant falls back to eh, exactly as before.
    const defaulted = mod.buildSelfHostBundle({ mainWorker: LOCAL_BASE + 'duckdb-browser-eh.worker.js' }, undefined);
    assert.equal(defaulted.mainModule, eh.mainModule);

    for (const b of [eh, mvp, defaulted]) {
      assert.doesNotMatch(b.mainModule, JSDELIVR_RE, 'the primary wasm URL must never be a CDN URL');
      assert.doesNotMatch(b.mainModule, /^https?:\/\//, 'the primary wasm URL must be same-origin, not absolute cross-origin');
      assert.match(b.mainModule, /^\/assets\/duckdb\//, 'the primary wasm URL must be root-absolute so the worker resolves it against the page origin');
      assert.doesNotMatch(b.mainModule, DOUBLED_PATH_RE);
    }
  });

  it('SELF_HOST_BASE_URL stays root-absolute (a relative base would resolve against the worker script, not the page)', async () => {
    const mod = await loadHarden();
    assert.equal(mod.SELF_HOST_BASE_URL, LOCAL_BASE);
  });

  it('buildCandidateList() carries wasmLocalFirst through for self-host only, and self-host is still tried first', async () => {
    const mod = await loadHarden();
    const list = mod.buildCandidateList();
    assert.equal(list[0].id, 'self-host');
    assert.deepEqual(list.slice(1).map((c) => c.id), ['jsdelivr', 'unpkg', 'esm.sh']);

    const selfHost = list[0];
    assert.ok(selfHost.wasmLocalFirst, 'self-host candidate lost its wasmLocalFirst through buildCandidateList()');
    assert.equal(selfHost.wasmLocalFirst.eh, LOCAL_BASE + 'duckdb-eh.wasm');
    assert.equal(selfHost.wasmLocalFirst.mvp, LOCAL_BASE + 'duckdb-mvp.wasm');
    for (const cdn of list.slice(1)) {
      assert.equal(cdn.wasmLocalFirst, undefined, cdn.id + ' should not carry a wasmLocalFirst (only self-host needs one)');
    }
  });
});

// ------------------------------------------------------------
// B. The wasm binaries are actually on disk. "Prefer local" is only correct
//    if local exists, so this is the other half of the regression guard: if
//    someone drops the vendored binaries, this fails loudly here rather
//    than as a mystery SQL outage offline.
// ------------------------------------------------------------

describe('wasm local first B: the vendored binaries exist under assets/duckdb/', () => {
  const EXPECTED = [
    { file: 'duckdb-eh.wasm', minBytes: 30 * 1024 * 1024 },
    { file: 'duckdb-mvp.wasm', minBytes: 30 * 1024 * 1024 },
  ];

  for (const { file, minBytes } of EXPECTED) {
    it('assets/duckdb/' + file + ' exists, is a plausible size, and starts with the wasm magic bytes', () => {
      const abs = join(REPO_ROOT, 'assets', 'duckdb', file);
      const st = statSync(abs);
      assert.ok(st.isFile(), abs + ' is not a file');
      assert.ok(st.size > minBytes, file + ' is only ' + st.size + ' bytes, expected > ' + minBytes);

      // \0asm followed by version 1: this is a real WebAssembly module, not
      // an LFS pointer, an HTML error page, or a truncated download.
      const fd = openSync(abs, 'r');
      const head = Buffer.alloc(8);
      try {
        readSync(fd, head, 0, 8, 0);
      } finally {
        closeSync(fd);
      }
      assert.deepEqual([...head.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], file + ' does not start with the wasm magic bytes');
      assert.deepEqual([...head.subarray(4, 8)], [0x01, 0x00, 0x00, 0x00], file + ' does not declare wasm version 1');
    });
  }

  it('the same-origin worker and module scripts the local bundle depends on are also vendored', () => {
    for (const file of ['duckdb-browser.mjs', 'duckdb-browser-eh.worker.js', 'duckdb-browser-mvp.worker.js']) {
      const st = statSync(join(REPO_ROOT, 'assets', 'duckdb', file));
      assert.ok(st.isFile() && st.size > 0, 'assets/duckdb/' + file + ' missing or empty');
    }
  });

  it('_headers serves /assets/duckdb/*.wasm as application/wasm (WebAssembly streaming compile requires it)', () => {
    const headers = readRepoFile('_headers');
    const idx = headers.indexOf('/assets/duckdb/*.wasm');
    assert.notEqual(idx, -1, '_headers has no /assets/duckdb/*.wasm rule');
    assert.match(headers.slice(idx, idx + 200), /Content-Type:\s*application\/wasm/);
  });
});

// ------------------------------------------------------------
// C. Every consuming surface is wired to the local-first field. There are
//    three real surfaces and they must not drift apart.
// ------------------------------------------------------------

describe('wasm local first C: js/sql/sql-engine.js (module SQL surface)', () => {
  const src = readRepoFile(join('js', 'sql', 'sql-engine.js'));

  it('gates the up-front override on cand.wasmLocalFirst, not on a CDN-first flag', () => {
    assert.match(src, /cand\.wasmLocalFirst && LOAD_HARDEN && typeof LOAD_HARDEN\.buildSelfHostBundle === 'function'/);
    assert.doesNotMatch(src, /wasmCdnFirst/);
  });

  it('re-resolves the local root-absolute wasm path to an absolute URL before handing it to the worker', () => {
    // The worker resolves a relative/root-absolute URL against its own
    // location; every other URL in this loader is already absolute, so the
    // local mainModule gets the same treatment.
    assert.match(src, /mainModuleHref = isAbsoluteUrl\(localFirstBundle\.mainModule\)\s*\?\s*localFirstBundle\.mainModule\s*:\s*new URL\(localFirstBundle\.mainModule, location\.href\)\.href;/);
  });
});

describe('wasm local first C: js/app-shell/duckdb-engine.js (root index.html surface)', () => {
  const src = readRepoFile(join('js', 'app-shell', 'duckdb-engine.js'));

  it('has no CDN-first override left, and no longer imports or calls buildSelfHostBundle for one', () => {
    assert.doesNotMatch(src, /wasmCdnFirst/);
    assert.doesNotMatch(src, /buildSelfHostBundle\(/, 'buildSelfHostBundle must no longer be called on this surface');
    const importIdx = src.indexOf("from '../sql/duckdb-load-harden.js'");
    assert.notEqual(importIdx, -1);
    const importStmt = src.slice(src.lastIndexOf('import', importIdx), importIdx);
    assert.doesNotMatch(importStmt, /buildSelfHostBundle/, 'buildSelfHostBundle must no longer be imported here');
  });

  it('keeps its own local asset() bundle as the primary, which already works under a subdirectory deploy', () => {
    assert.match(src, /mainModule: asset\('duckdb-eh\.wasm'\)/);
    assert.match(src, /mainModule: asset\('duckdb-mvp\.wasm'\)/);
    assert.match(src, /const bundle = await duckdb\.selectBundle\(bundles\);/);
  });

  it('the module still imports cleanly under plain Node (syntax + import graph sanity)', async () => {
    await assert.doesNotReject(import(join(REPO_ROOT, 'js', 'app-shell', 'duckdb-engine.js')));
  });
});

describe('wasm local first C: canvas/index.html (authoritative single-file surface)', () => {
  const canvas = readRepoFile(join('canvas', 'index.html'));

  it('the inlined harden splice is re-synced to the local-first policy', () => {
    const s = canvas.indexOf('/* ---- from js/sql/duckdb-load-harden.js ---- */');
    const e = canvas.indexOf('/* ---- end js/sql/duckdb-load-harden.js ---- */');
    assert.notEqual(s, -1, 'from marker missing');
    assert.notEqual(e, -1, 'end marker missing');
    const span = canvas.slice(s, e);
    assert.match(span, /WASM_LOCAL_FIRST = Object\.freeze\(\{/);
    assert.match(span, /SELF_HOST_BASE_URL \+ 'duckdb-eh\.wasm'/);
    assert.match(span, /wasmLocalFirst: WASM_LOCAL_FIRST,/);
    assert.match(span, /wasmFallback: WASM_CDN_FALLBACK,/);
    assert.doesNotMatch(span, /wasmCdnFirst|WASM_CDN_FIRST/);
  });

  it('the hardcoded fallback candidate list carries local wasm URLs up front and the CDN pin only as wasmFallback', () => {
    const idx = canvas.indexOf('function _dgDuckCandidates()');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 1400);
    assert.match(region, /wasmLocalFirst: \{ mvp: DUCKDB_SELF_HOST_BASE \+ 'duckdb-mvp\.wasm', eh: DUCKDB_SELF_HOST_BASE \+ 'duckdb-eh\.wasm' \}/);
    assert.match(region, /wasmFallback: \{ mvp: DUCKDB_BASE_PRIMARY \+ 'duckdb-mvp\.wasm', eh: DUCKDB_BASE_PRIMARY \+ 'duckdb-eh\.wasm' \}/);
  });

  it('DUCKDB_SELF_HOST_BASE is the root-absolute local base', () => {
    assert.match(canvas, /var DUCKDB_SELF_HOST_BASE = '\/assets\/duckdb\/';/);
  });

  it('_loadDuckFrom applies the local-first bundle before constructing the worker', () => {
    const idx = canvas.indexOf('async function _loadDuckFrom(cdnUrl, baseUrl, candidate) {');
    assert.notEqual(idx, -1);
    const region = canvas.slice(idx, idx + 4600);
    assert.match(region, /candidate\.wasmLocalFirst && lhFront && typeof lhFront\.buildSelfHostBundle === 'function'/);
    assert.match(region, /mainModuleUrl = _dgAbsUrl\(_localFirstBundle\.mainModule\);/);
    const overrideIdx = region.indexOf('buildSelfHostBundle');
    const workerCtorIdx = region.indexOf('new Worker(');
    assert.ok(overrideIdx !== -1 && workerCtorIdx !== -1 && overrideIdx < workerCtorIdx, 'the local-first override must run before new Worker() / instantiate()');
  });

  it('no wasmCdnFirst reference survives anywhere in the canvas bundle', () => {
    assert.doesNotMatch(canvas, /wasmCdnFirst|WASM_CDN_FIRST/);
  });

  it('no doubled assets/duckdb/assets/duckdb path was introduced', () => {
    assert.doesNotMatch(canvas, DOUBLED_PATH_RE);
  });
});

// ------------------------------------------------------------
// D. The fallback layers this fix must NOT break.
// ------------------------------------------------------------

describe('wasm local first D: the CDN fallback and no-hang guards still exist on every surface', () => {
  it('the shared module still exports the hybrid-retry pair, pinned to 1.29.0', async () => {
    const mod = await loadHarden();
    assert.equal(typeof mod.isWasmFetchFailure, 'function');
    assert.equal(typeof mod.buildHybridWasmBundle, 'function');
    assert.equal(mod.DUCKDB_WASM_PIN, PIN);

    const wf = mod.SELF_HOST_CANDIDATE.wasmFallback;
    assert.equal(wf.eh, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-eh.wasm');
    assert.equal(wf.mvp, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-mvp.wasm');
  });

  it('a local primary bundle can still be swapped to the CDN pin on a wasm fetch failure, worker left same-origin', async () => {
    const mod = await loadHarden();
    const primary = mod.buildSelfHostBundle({ mainWorker: LOCAL_BASE + 'duckdb-browser-eh.worker.js', pthreadWorker: null }, 'eh');
    assert.equal(primary.mainModule, LOCAL_BASE + 'duckdb-eh.wasm');

    const hybrid = mod.buildHybridWasmBundle(primary, mod.SELF_HOST_CANDIDATE);
    assert.ok(hybrid, 'expected a hybrid bundle from a local self-host bundle');
    assert.equal(hybrid.mainModule, 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + PIN + '/dist/duckdb-eh.wasm');
    assert.equal(hybrid.mainWorker, LOCAL_BASE + 'duckdb-browser-eh.worker.js');
    assert.notEqual(hybrid.mainModule, primary.mainModule, 'the retry must actually change the wasm URL, or the loop would rethrow');

    // Still classifies only fetch/compile-shaped failures.
    assert.equal(mod.isWasmFetchFailure(new TypeError('Failed to fetch')), true);
    assert.equal(mod.isWasmFetchFailure(new Error('Table not found: foo')), false);
  });

  it('all three surfaces keep the timeout-guarded instantiate that makes the fallback reachable', () => {
    const sqlEngine = readRepoFile(join('js', 'sql', 'sql-engine.js'));
    const appShell = readRepoFile(join('js', 'app-shell', 'duckdb-engine.js'));
    const canvas = readRepoFile(join('canvas', 'index.html'));

    for (const [name, src] of [['sql-engine.js', sqlEngine], ['duckdb-engine.js', appShell]]) {
      assert.match(src, /instantiateWithTimeout\(/, name + ' lost its timeout-guarded instantiate');
      assert.match(src, /buildHybridWasmBundle\(/, name + ' lost the hybrid retry');
    }
    assert.match(canvas, /function _dgInstantiateWithTimeout\(adb, worker, mainModuleUrl, pthreadWorker, timeoutMs\)/);
    assert.match(canvas, /lh\.buildHybridWasmBundle\(/);
  });
});

// ------------------------------------------------------------
// E. Product-text guardrail.
// ------------------------------------------------------------

describe('wasm local first E: no em dash in the edited regions', () => {
  it('js/sql/duckdb-load-harden.js local-first block is em-dash free', () => {
    const src = readRepoFile(join('js', 'sql', 'duckdb-load-harden.js'));
    const idx = src.indexOf('WASM_LOCAL_FIRST');
    assert.notEqual(idx, -1);
    assert.doesNotMatch(src.slice(Math.max(0, idx - 2500), idx + 2500), new RegExp(EM_DASH));
  });

  it('js/sql/sql-engine.js local-first block is em-dash free', () => {
    const src = readRepoFile(join('js', 'sql', 'sql-engine.js'));
    const idx = src.indexOf('cand.wasmLocalFirst');
    assert.notEqual(idx, -1);
    assert.doesNotMatch(src.slice(Math.max(0, idx - 1500), idx + 1500), new RegExp(EM_DASH));
  });

  it('canvas/index.html local-first blocks are em-dash free', () => {
    const canvas = readRepoFile(join('canvas', 'index.html'));
    const first = canvas.indexOf('wasmLocalFirst: { mvp: DUCKDB_SELF_HOST_BASE');
    assert.notEqual(first, -1);
    assert.doesNotMatch(canvas.slice(Math.max(0, first - 1200), first + 1200), new RegExp(EM_DASH));

    const second = canvas.indexOf('candidate.wasmLocalFirst && lhFront');
    assert.notEqual(second, -1);
    assert.doesNotMatch(canvas.slice(Math.max(0, second - 1500), second + 1500), new RegExp(EM_DASH));
  });
});
