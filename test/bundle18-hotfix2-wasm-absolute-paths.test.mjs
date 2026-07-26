// ============================================================
// DATAGLOW - Bundle 18 hotfix 2 proof: DuckDB-WASM absolute self-host paths
// ============================================================
// LIVE BUG (after import-map hotfix #609): Playwright proved self-host
// mjs + arrow + worker all load 200, but the wasm URL came back DOUBLED:
//
//   /assets/duckdb/assets/duckdb/duckdb-eh.wasm  ->  404
//
// SQL then failed with "Cannot read properties of null (reading 'query')"
// (instantiate() never completed) and the page saw a pageerror:
//   Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok
//
// ROOT CAUSE: SELF_HOST_BASE_URL was './assets/duckdb/' -- relative. The
// DuckDB-WASM worker script itself lives at
// /assets/duckdb/duckdb-browser-eh.worker.js. A relative mainModule wasm
// path resolves against the RESOLVER's own location, not the page's; when
// the worker (already inside /assets/duckdb/) resolved
// './assets/duckdb/duckdb-eh.wasm', it landed on
// /assets/duckdb/assets/duckdb/duckdb-eh.wasm -- the doubled, 404ing path.
//
// FIX:
//   1. js/sql/duckdb-load-harden.js: SELF_HOST_BASE_URL is now root-absolute
//      ('/assets/duckdb/'), plus a new resolveSelfHostBaseUrl(href) helper
//      that resolves the same path via `new URL(path, href)` for any caller
//      that needs an origin-qualified URL instead.
//   2. js/sql/sql-engine.js ensureInit(): the Worker is now constructed from
//      an absolute URL (`new URL(bundle.mainWorker, location.href).href` if
//      not already absolute), and mainModule is resolved the same way
//      before being handed to db.instantiate().
//   3. canvas/index.html (tracked splice of js/sql/duckdb-load-harden.js,
//      plus its own manual DUCKDB_SELF_HOST_BASE fallback and Worker/
//      instantiate call sites): same root-absolute base, same
//      resolve-before-use pattern via a local _dgAbsUrl() helper.
//   4. CDN fallbacks (jsDelivr, unpkg, esm.sh) are untouched -- still
//      absolute https:// URLs, still tried in the same order after
//      self-host.
//
// This is a static/pure-module test file (no browser launch): it checks the
// shipped artifacts directly for the doubling pattern, root-absoluteness of
// the self-host base, and worker/wasm same-origin agreement.
//
// RUN WITH:  node test/bundle18-hotfix2-wasm-absolute-paths.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';
const DOUBLED_PATH_RE = /assets\/duckdb\/assets\/duckdb/;

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// ------------------------------------------------------------
// A. js/sql/duckdb-load-harden.js: the one shared pin list is now
//    root-absolute, and resolveSelfHostBaseUrl() proves the doubling
//    cannot happen for page OR worker callers.
// ------------------------------------------------------------

describe('bundle18 hotfix2 A: root-absolute self-host base (js/sql/duckdb-load-harden.js)', () => {
  it('SELF_HOST_BASE_URL is root-absolute, not relative', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    assert.equal(mod.SELF_HOST_BASE_URL, '/assets/duckdb/');
    assert.doesNotMatch(mod.SELF_HOST_BASE_URL, /^\.\//);
  });

  it('SELF_HOST_CANDIDATE cdnUrl and baseUrl are both root-absolute with a single assets/duckdb/ segment', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const c = mod.SELF_HOST_CANDIDATE;
    assert.match(c.baseUrl, /^\/assets\/duckdb\/$/);
    assert.equal(c.cdnUrl, '/assets/duckdb/duckdb-browser.mjs');
    assert.doesNotMatch(c.baseUrl, DOUBLED_PATH_RE);
    assert.doesNotMatch(c.cdnUrl, DOUBLED_PATH_RE);
  });

  it('manually building mvp/eh bundles from the self-host base never doubles the path', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const base = mod.SELF_HOST_CANDIDATE.baseUrl;
    const manualBundles = {
      mvp: { mainModule: base + 'duckdb-mvp.wasm', mainWorker: base + 'duckdb-browser-mvp.worker.js' },
      eh: { mainModule: base + 'duckdb-eh.wasm', mainWorker: base + 'duckdb-browser-eh.worker.js' },
    };
    for (const bundle of Object.values(manualBundles)) {
      assert.equal(bundle.mainModule.match(/assets\/duckdb\//g).length, 1, `${bundle.mainModule} has more than one assets/duckdb/ segment`);
      assert.equal(bundle.mainWorker.match(/assets\/duckdb\//g).length, 1, `${bundle.mainWorker} has more than one assets/duckdb/ segment`);
      assert.doesNotMatch(bundle.mainModule, DOUBLED_PATH_RE);
      assert.doesNotMatch(bundle.mainWorker, DOUBLED_PATH_RE);
    }
    assert.equal(manualBundles.eh.mainModule, '/assets/duckdb/duckdb-eh.wasm');
    assert.equal(manualBundles.mvp.mainModule, '/assets/duckdb/duckdb-mvp.wasm');
  });

  it('resolveSelfHostBaseUrl() agrees for a page-origin href AND a worker-origin href already inside assets/duckdb/', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    assert.equal(typeof mod.resolveSelfHostBaseUrl, 'function');

    const pageHref = 'https://example.com/index.html';
    const workerHref = 'https://example.com/assets/duckdb/duckdb-browser-eh.worker.js';
    const fromPage = mod.resolveSelfHostBaseUrl(pageHref);
    const fromWorker = mod.resolveSelfHostBaseUrl(workerHref);

    // The entire point of root-absolute + this resolver: page and worker
    // MUST agree on the exact same base, regardless of which one asks.
    assert.equal(fromPage, 'https://example.com/assets/duckdb/');
    assert.equal(fromWorker, 'https://example.com/assets/duckdb/');
    assert.equal(fromPage, fromWorker);
    assert.doesNotMatch(fromWorker, DOUBLED_PATH_RE);
  });

  it('resolveSelfHostBaseUrl() never throws under plain Node (no window.location)', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const resolved = mod.resolveSelfHostBaseUrl();
    assert.match(resolved, /^https?:\/\/[^/]+\/assets\/duckdb\/$/);
  });

  it('CDN fallbacks (jsDelivr, unpkg, esm.sh) are untouched: still absolute https URLs, still after self-host', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const list = mod.buildCandidateList();
    assert.equal(list[0].id, 'self-host');
    const cdnIds = list.slice(1).map((c) => c.id);
    assert.deepEqual(cdnIds, ['jsdelivr', 'unpkg', 'esm.sh']);
    for (const cand of list.slice(1)) {
      assert.match(cand.cdnUrl, /^https:\/\//);
      assert.match(cand.baseUrl, /^https:\/\//);
    }
  });
});

// ------------------------------------------------------------
// B. js/sql/sql-engine.js: Worker + mainModule are resolved to absolute
//    URLs against the page before use.
// ------------------------------------------------------------

describe('bundle18 hotfix2 B: js/sql/sql-engine.js resolves worker + wasm to absolute URLs', () => {
  const src = readRepoFile(join('js', 'sql', 'sql-engine.js'));

  it('constructs the Worker from an absolute URL (resolved against location.href if not already absolute)', () => {
    assert.match(src, /new URL\(bundle\.mainWorker,\s*location\.href\)\.href/);
    assert.match(src, /new Worker\(workerHref\)/);
  });

  it('resolves mainModule (the wasm path) to an absolute URL before instantiate()', () => {
    assert.match(src, /new URL\(bundle\.mainModule,\s*location\.href\)\.href/);
    // Bundle 18 hotfix 4 wrapped the raw db.instantiate() call site in
    // instantiateWithTimeout(), which still passes mainModuleHref through
    // as the wasm URL argument (see BUNDLE18_HOTFIX4_RESULT.md).
    assert.match(src, /instantiateWithTimeout\(db, worker, mainModuleHref,\s*bundle\.pthreadWorker,\s*\d+\)/);
  });

  it('does not introduce an em dash in the edited region', () => {
    assert.doesNotMatch(src, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// C. canvas/index.html: the tracked duckdb-load-harden splice, the manual
//    fallback candidate list, and the Worker/instantiate call site all use
//    root-absolute or resolved-absolute paths -- never the doubling shape.
// ------------------------------------------------------------

describe('bundle18 hotfix2 C: canvas/index.html absolute wasm paths (canvas authoritative)', () => {
  const canvas = readRepoFile(join('canvas', 'index.html'));

  it('the tracked duckdb-load-harden.js splice carries the root-absolute SELF_HOST_BASE_URL', () => {
    const startMarker = '/* ---- from js/sql/duckdb-load-harden.js ---- */';
    const endMarker = '/* ---- end js/sql/duckdb-load-harden.js ---- */';
    const s = canvas.indexOf(startMarker);
    const e = canvas.indexOf(endMarker);
    assert.notEqual(s, -1, 'from marker missing');
    assert.notEqual(e, -1, 'end marker missing');
    const span = canvas.slice(s, e);
    assert.match(span, /const SELF_HOST_BASE_URL = '\/assets\/duckdb\/';/);
    assert.match(span, /function resolveSelfHostBaseUrl\(/);
    assert.doesNotMatch(span, /SELF_HOST_BASE_URL = '\.\/assets\/duckdb\/'/);
  });

  it('the manual fallback candidate list (DUCKDB_SELF_HOST_BASE) is root-absolute, not relative', () => {
    assert.match(canvas, /var DUCKDB_SELF_HOST_BASE = '\/assets\/duckdb\/';/);
    assert.doesNotMatch(canvas, /var DUCKDB_SELF_HOST_BASE = '\.\/assets\/duckdb\/';/);
  });

  it('the canvas loader resolves worker + mainModule to absolute URLs before Worker()/instantiate()', () => {
    assert.match(canvas, /function _dgAbsUrl\(u\)/);
    assert.match(canvas, /var workerUrl = _dgAbsUrl\(bundle\.mainWorker\);/);
    assert.match(canvas, /var mainModuleUrl = _dgAbsUrl\(bundle\.mainModule\);/);
    // Bundle 18 hotfix 4 wrapped the raw adb.instantiate() call site in
    // _dgInstantiateWithTimeout(), which still passes mainModuleUrl through
    // as the wasm URL argument.
    assert.match(canvas, /_dgInstantiateWithTimeout\(adb, worker, mainModuleUrl, bundle\.pthreadWorker,\s*\d+\);/);
  });

  it('no doubled assets/duckdb/assets/duckdb path pattern exists anywhere in canvas/index.html', () => {
    assert.doesNotMatch(canvas, DOUBLED_PATH_RE);
  });

  it('CDN fallback candidates in the canvas manual list are unchanged absolute https URLs', () => {
    assert.match(canvas, /DUCKDB_CDN_PRIMARY = 'https:\/\/cdn\.jsdelivr\.net/);
    assert.match(canvas, /DUCKDB_CDN_FALLBACK = 'https:\/\/unpkg\.com/);
  });

  it('no em dash was introduced in the edited canvas regions', () => {
    const dgAbsIdx = canvas.indexOf('function _dgAbsUrl(u)');
    const selfHostIdx = canvas.indexOf('DUCKDB_SELF_HOST_BASE');
    assert.notEqual(dgAbsIdx, -1);
    assert.notEqual(selfHostIdx, -1);
    const nearDgAbs = canvas.slice(dgAbsIdx - 200, dgAbsIdx + 1200);
    const nearSelfHost = canvas.slice(selfHostIdx - 700, selfHostIdx + 200);
    assert.doesNotMatch(nearDgAbs, new RegExp(EM_DASH));
    assert.doesNotMatch(nearSelfHost, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// D. Manifest consistency: canvasBytes matches the actual file size after
//    the re-injection + manual edits in this hotfix.
// ------------------------------------------------------------

describe('bundle18 hotfix2 D: canvas integrity manifest matches canvas/index.html', () => {
  it('canvasBytes in the manifest matches the actual file size', async () => {
    const { statSync } = await import('node:fs');
    const manifest = JSON.parse(readRepoFile(join('canvas', 'integrity.manifest.json')));
    const bytes = statSync(join(REPO_ROOT, 'canvas', 'index.html')).size;
    assert.equal(manifest.canvasBytes, bytes);
  });

  it('the js/sql/duckdb-load-harden.js manifest entry hash matches the current source file', async () => {
    const { createHash } = await import('node:crypto');
    const manifest = JSON.parse(readRepoFile(join('canvas', 'integrity.manifest.json')));
    const entry = manifest.tracked.find((t) => t.source === 'js/sql/duckdb-load-harden.js');
    assert.ok(entry, 'manifest entry for js/sql/duckdb-load-harden.js missing');
    const src = readRepoFile(join('js', 'sql', 'duckdb-load-harden.js'));
    const sha = createHash('sha256').update(src, 'utf8').digest('hex');
    assert.equal(entry.sourceSha256, sha);
  });
});

// ------------------------------------------------------------
// E. Residual COEP/S3 note: documented, not silently dropped.
// ------------------------------------------------------------

describe('bundle18 hotfix2 E: residual cross-origin isolation note is documented', () => {
  it('BUNDLE18_HOTFIX2_RESULT.md exists and documents the COOP/COEP residual', () => {
    const doc = readRepoFile('BUNDLE18_HOTFIX2_RESULT.md');
    assert.match(doc, /COOP|COEP/);
    assert.doesNotMatch(doc, new RegExp(EM_DASH));
  });
});
