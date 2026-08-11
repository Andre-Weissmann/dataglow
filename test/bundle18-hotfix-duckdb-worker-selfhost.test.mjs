// ============================================================
// DATAGLOW - Bundle 18 hotfix proof: DuckDB-WASM worker self-host
// ============================================================
// Live bug after Bundle 18 publish: the SQL Editor's DuckDB-WASM init fell
// through the self-host candidate to jsDelivr/unpkg/esm.sh and died with
//   "error in duckdb worker: Uncaught NetworkError: Failed to execute
//    'importScripts' on 'WorkerGlobalScope' ..."
//
// ROOT CAUSE: canvas/index.html is a standalone single-file document with
// no <script type="importmap">. assets/duckdb/duckdb-browser.mjs (the file
// the self-host candidate dynamically imports) has a bare-specifier
// `import * as u from "apache-arrow"`, which Arrow.dom.mjs's own bare
// imports of "tslib" and "flatbuffers" depend on in turn. Root index.html
// resolves those three bare specifiers via its own import map; canvas had
// no equivalent, so the self-host candidate's `import(cand.cdnUrl)` threw a
// module-resolution TypeError (never a network failure, so it never showed
// up as a failed request -- consistent with the "200 duckdb-browser.mjs"
// observed in the live network log), the load loop's try/catch swallowed
// that and fell through to jsDelivr, then unpkg, then esm.sh, whose
// cross-origin classic-mode Worker construction is what raised the reported
// importScripts NetworkError.
//
// FIX: add the same three-entry import map (apache-arrow, tslib,
// flatbuffers -> assets/duckdb/vendor/...) to canvas/index.html, placed
// before every other inline <script> so it is registered before the first
// dynamic import() of duckdb-browser.mjs can run. Also relaxed the
// "No dataset loaded" hard gate in both canvas SQL runners (svRunQuery and
// runSQL) so a table-free query like SELECT 1 is not blocked before it ever
// reaches the engine.
//
// This is a static/pure-module test file (no browser launch): it checks the
// shipped artifacts directly -- the import map text and placement in
// canvas/index.html, the shared candidate list module, and the relaxed SQL
// gates.
//
// RUN WITH:  node test/bundle18-hotfix-duckdb-worker-selfhost.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// ------------------------------------------------------------
// A. Shared candidate list module: self-host candidate is complete and
//    correctly ordered, and no candidate is silently forced onto esm.sh.
// ------------------------------------------------------------

describe('bundle18 hotfix A: shared candidate list (js/sql/duckdb-load-harden.js)', () => {
  it('self-host candidate is listed FIRST', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const list = mod.buildCandidateList();
    assert.ok(Array.isArray(list) && list.length > 0);
    assert.equal(list[0].id, 'self-host');
  });

  it('self-host candidate base URL is a same-origin, root-absolute path under assets/duckdb/ (not relative)', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const self_host = mod.SELF_HOST_CANDIDATE;
    // Bundle 18 hotfix 2: root-absolute ("/assets/duckdb/"), not relative
    // ("./assets/duckdb/"). A relative base resolves against whatever is
    // asking (page vs. worker), which is exactly what doubled the path into
    // /assets/duckdb/assets/duckdb/duckdb-eh.wasm in the live bug.
    assert.match(self_host.baseUrl, /^\/assets\/duckdb\/$/);
    assert.doesNotMatch(self_host.baseUrl, /^\.\//);
    assert.doesNotMatch(self_host.baseUrl, /^https?:\/\//);
    assert.doesNotMatch(self_host.baseUrl, /esm\.sh|jsdelivr|unpkg/);
  });

  it('resolveSelfHostBaseUrl() resolves to a single, non-doubled assets/duckdb/ segment against any origin', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    assert.equal(typeof mod.resolveSelfHostBaseUrl, 'function');
    const fromPageRoot = mod.resolveSelfHostBaseUrl('http://localhost/index.html');
    const fromWorkerInsideAssets = mod.resolveSelfHostBaseUrl('http://localhost/assets/duckdb/duckdb-browser-eh.worker.js');
    // A root-absolute path resolved against ANY same-origin href (the page's
    // or the worker's own script location) must land on the exact same
    // single-segment URL -- this is the guarantee that fixes the doubling.
    assert.equal(fromPageRoot, 'http://localhost/assets/duckdb/');
    assert.equal(fromWorkerInsideAssets, 'http://localhost/assets/duckdb/');
    assert.doesNotMatch(fromWorkerInsideAssets, /assets\/duckdb\/assets\/duckdb/);
  });

  it('self-host candidate cdnUrl (the main ESM module) resolves under the same self-host base', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const self_host = mod.SELF_HOST_CANDIDATE;
    assert.equal(self_host.cdnUrl, self_host.baseUrl + 'duckdb-browser.mjs');
    assert.doesNotMatch(self_host.cdnUrl, /^https?:\/\//);
  });

  it('every candidate host has BOTH a cdnUrl (main module) and a baseUrl the worker/wasm resolve against', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const list = mod.buildCandidateList();
    for (const cand of list) {
      assert.ok(cand.cdnUrl, `candidate ${cand.id} missing cdnUrl`);
      assert.ok(cand.baseUrl, `candidate ${cand.id} missing baseUrl`);
      // The worker and wasm paths a caller derives from baseUrl must live on
      // the SAME host as cdnUrl -- i.e. baseUrl is always a prefix relationship
      // consistent with cdnUrl, never pointing worker/wasm fetches at a
      // different host than the main module was loaded from.
      // A root-absolute or dot-relative candidate path (self-host) has no
      // parseable `new URL()` host of its own -- treat any non-http(s)
      // candidate as same-origin ('self') for this comparison instead of
      // throwing on `new URL()`.
      const isAbsolute = (u) => /^https?:\/\//.test(u);
      const cdnHost = isAbsolute(cand.cdnUrl) ? new URL(cand.cdnUrl).host : 'self';
      const baseHost = isAbsolute(cand.baseUrl) ? new URL(cand.baseUrl).host : 'self';
      assert.equal(cdnHost, baseHost, `candidate ${cand.id} has mismatched cdnUrl/baseUrl hosts`);
    }
  });

  it('the self-host candidate is never rewritten to esm.sh (or any CDN) when it is the SELECTED candidate', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const self_host = mod.SELF_HOST_CANDIDATE;
    // Simulate the manual bundle construction every caller (duckdb-engine.js,
    // sql-engine.js, canvas loader) does from a selected candidate's baseUrl.
    const manualBundles = {
      mvp: { mainModule: self_host.baseUrl + 'duckdb-mvp.wasm', mainWorker: self_host.baseUrl + 'duckdb-browser-mvp.worker.js' },
      eh: { mainModule: self_host.baseUrl + 'duckdb-eh.wasm', mainWorker: self_host.baseUrl + 'duckdb-browser-eh.worker.js' },
    };
    for (const bundle of Object.values(manualBundles)) {
      assert.doesNotMatch(bundle.mainModule, /esm\.sh|jsdelivr\.net|unpkg\.com/);
      assert.doesNotMatch(bundle.mainWorker, /esm\.sh|jsdelivr\.net|unpkg\.com/);
      // Root-absolute, single assets/duckdb/ segment -- never doubled and
      // never a bare relative "./assets/duckdb/" that would double against a
      // worker's own location.
      assert.match(bundle.mainModule, /^\/assets\/duckdb\//);
      assert.match(bundle.mainWorker, /^\/assets\/duckdb\//);
      assert.doesNotMatch(bundle.mainModule, /assets\/duckdb\/assets\/duckdb/);
      assert.doesNotMatch(bundle.mainWorker, /assets\/duckdb\/assets\/duckdb/);
    }
  });

  it('rewriteBundleUrl never rewrites a self-host URL onto a CDN base', async () => {
    const mod = await import(join(REPO_ROOT, 'js', 'sql', 'duckdb-load-harden.js'));
    const self_host = mod.SELF_HOST_CANDIDATE;
    const esmsh = mod.CANDIDATE_HOSTS.find((h) => h.id === 'esm.sh');
    const url = self_host.baseUrl + 'duckdb-eh.wasm';
    // rewriteBundleUrl only rewrites URLs that start with `fromBaseUrl`; a
    // self-host URL never starts with esm.sh's base, so this must be a no-op.
    const rewritten = mod.rewriteBundleUrl(url, esmsh.baseUrl, self_host.baseUrl);
    assert.equal(rewritten, url);
  });
});

// ------------------------------------------------------------
// B. Vendored assets on disk: worker + wasm same-origin files actually exist,
//    and the vendored ESM entry's bare imports (apache-arrow/tslib/
//    flatbuffers) resolve to real vendored files under assets/duckdb/vendor/.
// ------------------------------------------------------------

describe('bundle18 hotfix B: vendored self-host artifacts on disk', () => {
  const vendorDir = join(REPO_ROOT, 'assets', 'duckdb');

  it('worker + wasm files for both mvp and eh bundles exist under assets/duckdb/', () => {
    const required = [
      'duckdb-browser.mjs',
      'duckdb-browser-eh.worker.js',
      'duckdb-browser-mvp.worker.js',
      'duckdb-eh.wasm',
      'duckdb-mvp.wasm',
    ];
    for (const f of required) {
      assert.ok(existsSync(join(vendorDir, f)), `${f} missing under assets/duckdb/`);
    }
  });

  it('vendored bare-import dependencies (apache-arrow, tslib, flatbuffers) exist under assets/duckdb/vendor/', () => {
    const required = [
      join('vendor', 'apache-arrow', 'Arrow.dom.mjs'),
      join('vendor', 'tslib', 'tslib.es6.mjs'),
      join('vendor', 'flatbuffers', 'mjs', 'flatbuffers.js'),
    ];
    for (const rel of required) {
      assert.ok(existsSync(join(vendorDir, rel)), `${rel} missing under assets/duckdb/`);
    }
  });

  it('duckdb-browser.mjs bare-imports "apache-arrow" (the specifier the import map must resolve)', () => {
    const src = readFileSync(join(vendorDir, 'duckdb-browser.mjs'), 'utf-8');
    assert.match(src, /from"apache-arrow"|from\s+["']apache-arrow["']/);
  });

  it('no worker file bakes in a hardcoded esm.sh/jsDelivr/unpkg URL', () => {
    for (const f of ['duckdb-browser-eh.worker.js', 'duckdb-browser-mvp.worker.js']) {
      const src = readFileSync(join(vendorDir, f), 'utf-8');
      assert.doesNotMatch(src, /esm\.sh|cdn\.jsdelivr\.net|unpkg\.com/);
    }
  });
});

// ------------------------------------------------------------
// C. canvas/index.html: the fix itself -- an import map registered before
//    any inline <script>, resolving the three bare specifiers self-host
//    needs, plus the relaxed SQL "no dataset" gates.
// ------------------------------------------------------------

describe('bundle18 hotfix C: canvas/index.html import map + SQL gating fix', () => {
  const canvas = readRepoFile(join('canvas', 'index.html'));

  it('declares exactly one <script type="importmap"> block', () => {
    const matches = canvas.match(/<script\s+type=["']importmap["']>/g) || [];
    assert.equal(matches.length, 1, 'expected exactly one importmap script tag');
  });

  // Fix 1: these targets were pinned as relative ('./assets/duckdb/...') here,
  // which is exactly why this suite stayed green while the browser path was
  // dead. canvas/index.html is served from /canvas/index.html, so a relative
  // target resolved to /canvas/assets/duckdb/... and 404'd on every entry.
  // They are now root-absolute, matching DUCKDB_SELF_HOST_BASE ('/assets/duckdb/').
  // test/sql-importmap-absolute-paths.test.mjs is the property-based guard.
  it('the import map resolves apache-arrow, tslib, and flatbuffers to root-absolute vendored /assets/duckdb/ paths', () => {
    const i = canvas.indexOf('<script type="importmap">');
    assert.ok(i !== -1, 'importmap script tag not found');
    const j = canvas.indexOf('</script>', i);
    const block = canvas.slice(i, j);
    const jsonStart = block.indexOf('{');
    const data = JSON.parse(block.slice(jsonStart));
    assert.equal(data.imports['apache-arrow'], '/assets/duckdb/vendor/apache-arrow/Arrow.dom.mjs');
    assert.equal(data.imports['tslib'], '/assets/duckdb/vendor/tslib/tslib.es6.mjs');
    assert.equal(data.imports['flatbuffers'], '/assets/duckdb/vendor/flatbuffers/mjs/flatbuffers.js');
  });

  it('the import map is registered before the first classic <script> block (so it is live before any dynamic import())', () => {
    const importmapIdx = canvas.indexOf('<script type="importmap">');
    // Find the first <script> tag of any kind that is NOT the importmap itself.
    const scriptTagRe = /<script([^>]*)>/g;
    let m;
    let firstOtherScriptIdx = -1;
    while ((m = scriptTagRe.exec(canvas)) !== null) {
      const attrs = m[1] || '';
      if (/type\s*=\s*["']importmap["']/.test(attrs)) continue;
      firstOtherScriptIdx = m.index;
      break;
    }
    assert.ok(importmapIdx !== -1, 'importmap not found');
    assert.ok(firstOtherScriptIdx !== -1, 'no other script tag found');
    assert.ok(importmapIdx < firstOtherScriptIdx, 'importmap must be registered before every other inline script');
  });

  it('the self-host candidate manual bundle builder in the canvas loader never points worker/wasm at esm.sh', () => {
    assert.match(canvas, /manualBundles\s*=\s*\{/, 'manual bundle builder missing from canvas loader');
    // The whole point of manualBundles is to build worker/wasm URLs from
    // THIS candidate's own baseUrl, not a hardcoded CDN string.
    const i = canvas.indexOf('var manualBundles = {');
    assert.ok(i !== -1);
    const j = canvas.indexOf('};', i);
    const block = canvas.slice(i, j);
    assert.doesNotMatch(block, /esm\.sh|cdn\.jsdelivr\.net(?!["'\s]*\/npm\/@duckdb)/);
    assert.match(block, /baseUrl \+ 'duckdb-mvp\.wasm'/);
    assert.match(block, /baseUrl \+ 'duckdb-browser-eh\.worker\.js'/);
  });

  it('svRunQuery no longer hard-blocks a table-free query (e.g. SELECT 1) when no dataset is loaded', () => {
    const i = canvas.indexOf('async function svRunQuery()');
    assert.ok(i !== -1, 'svRunQuery not found');
    const j = canvas.indexOf('\n    }', i);
    const block = canvas.slice(i, j + 8);
    // The gate must now be conditioned on the query actually containing FROM,
    // not on dataset count alone.
    assert.match(block, /state\.datasets\.length\s*&&\s*\/\\bFROM\\b\/i\.test\(sql\)/);
  });

  it('runSQL (main SQL overlay) no longer hard-blocks a table-free query when no dataset is loaded', () => {
    const i = canvas.indexOf('async function runSQL()');
    assert.ok(i !== -1, 'runSQL not found');
    const j = canvas.indexOf('\n  }', i + 20);
    const block = canvas.slice(i, j + 4);
    assert.match(block, /state\.datasets\.length\s*&&\s*\/\\bFROM\\b\/i\.test\(sql\)/);
  });

  it('both SQL runners still guide the user when a real table-needing query has no dataset loaded', () => {
    const occurrences = canvas.match(/No dataset loaded\. Drop a file first\./g) || [];
    assert.ok(occurrences.length >= 2, 'the helpful message should still exist for queries that truly need a table');
  });

  it('no em dash was introduced by this hotfix in the edited regions', () => {
    // Check only the text this hotfix actually inserted: the import map
    // comment + block, and each small gate comment directly above the two
    // SQL runners. Do NOT span the thousands of pre-existing lines between
    // them, which contain unrelated legitimate em dashes elsewhere.
    const importMapCommentStart = canvas.indexOf('<!-- Bundle 18 hotfix: DuckDB-WASM self-host import map');
    assert.ok(importMapCommentStart !== -1, 'hotfix import map comment not found');
    const importMapBlockEnd = canvas.indexOf('</script>', importMapCommentStart);
    const importMapRegion = canvas.slice(importMapCommentStart, importMapBlockEnd);
    assert.doesNotMatch(importMapRegion, new RegExp(EM_DASH));

    for (const fnName of ['async function svRunQuery()', 'async function runSQL()']) {
      const fnStart = canvas.indexOf(fnName);
      assert.ok(fnStart !== -1, `${fnName} not found`);
      const gateCommentStart = canvas.indexOf('// Bundle 18 hotfix:', fnStart);
      assert.ok(gateCommentStart !== -1 && gateCommentStart < fnStart + 800, `gate comment for ${fnName} not found nearby`);
      const gateEnd = canvas.indexOf("'No dataset loaded. Drop a file first.'", gateCommentStart);
      const gateRegion = canvas.slice(gateCommentStart, gateEnd);
      assert.doesNotMatch(gateRegion, new RegExp(EM_DASH));
    }
  });
});

// ------------------------------------------------------------
// D. canvas integrity manifest stays consistent with the edited file.
// ------------------------------------------------------------

describe('bundle18 hotfix D: canvas integrity manifest matches canvas/index.html', () => {
  it('canvasBytes in the manifest matches the actual file size', () => {
    const manifest = JSON.parse(readRepoFile(join('canvas', 'integrity.manifest.json')));
    const actual = statSync(join(REPO_ROOT, 'canvas', 'index.html')).size;
    assert.equal(manifest.canvasBytes, actual);
  });
});
