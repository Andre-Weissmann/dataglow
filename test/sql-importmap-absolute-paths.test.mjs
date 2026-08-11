// ============================================================
// DATAGLOW - Fix 1 regression guard: SQL import map paths must be
// root-absolute in canvas/index.html
// ============================================================
// THE BUG THIS LOCKS OUT.
// canvas/index.html declared its DuckDB-WASM import map with RELATIVE
// specifier targets:
//
//   "apache-arrow": "./assets/duckdb/vendor/apache-arrow/Arrow.dom.mjs"
//
// The document is served from /canvas/index.html, so an import-map target
// is resolved against the document URL. "./assets/..." therefore resolved
// to /canvas/assets/duckdb/vendor/... , a directory that has never existed
// in this repo. Every self-host module import 404'd, the loader swallowed
// the failure and fell through to jsDelivr, unpkg and finally esm.sh, whose
// cross-origin worker construction produced the user-visible
// "SQL engine failed to load: Failed to fetch: uncaught worker error while
// instantiating DuckDB-WASM" banner. The SQL tab had never worked in a
// browser.
//
// Twenty lines below the import map, the same library base was already
// written correctly as a root-absolute path:
//
//   var DUCKDB_SELF_HOST_BASE = '/assets/duckdb/';
//
// so the two halves of the loader disagreed with each other.
//
// WHY A DEDICATED TEST FILE.
// The old assertions in bundle18-hotfix-duckdb-worker-selfhost.test.mjs
// pinned the exact relative strings, so the whole suite stayed green while
// the browser path was dead. This file asserts the property that actually
// matters (resolves to a file that exists, from the URL the document is
// really served at) rather than a literal string, and it fails on the old
// relative path.
//
// RUN WITH:  node test/sql-importmap-absolute-paths.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

const BARE_SPECIFIERS = ['apache-arrow', 'tslib', 'flatbuffers'];

function parseImportMap(html) {
  const i = html.indexOf('<script type="importmap">');
  assert.ok(i !== -1, 'no <script type="importmap"> block found');
  const j = html.indexOf('</script>', i);
  const block = html.slice(i, j);
  return JSON.parse(block.slice(block.indexOf('{')));
}

// Resolve an import-map target the way a browser does: against the URL the
// document is actually served from.
function resolveAgainstDocument(target, documentUrl) {
  return new URL(target, documentUrl);
}

function repoPathForUrl(url) {
  return join(REPO_ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
}

describe('Fix 1: canvas/index.html import map resolves to real self-hosted files', () => {
  const canvas = read(join('canvas', 'index.html'));
  const imports = parseImportMap(canvas).imports;
  // The canvas surface is published at /canvas/index.html. This is the whole
  // point of the bug: the resolution base is /canvas/, not /.
  const CANVAS_DOC_URL = 'https://example.test/canvas/index.html';

  it('declares every bare specifier DuckDB-WASM self-host needs', () => {
    for (const spec of BARE_SPECIFIERS) {
      assert.ok(imports[spec], `import map is missing "${spec}"`);
    }
  });

  for (const spec of BARE_SPECIFIERS) {
    it(`"${spec}" target is root-absolute, never relative`, () => {
      const target = imports[spec];
      assert.ok(
        target.startsWith('/') && !target.startsWith('//'),
        `"${spec}" must be root-absolute ("/assets/..."), got "${target}". ` +
        'A relative target resolves against /canvas/ and 404s.',
      );
      assert.ok(
        !target.startsWith('./') && !target.startsWith('../'),
        `"${spec}" must not be a relative path, got "${target}"`,
      );
    });

    it(`"${spec}" resolves to a file that exists on disk when served from /canvas/index.html`, () => {
      const url = resolveAgainstDocument(imports[spec], CANVAS_DOC_URL);
      // The old relative path produced /canvas/assets/duckdb/... here.
      assert.ok(
        !url.pathname.startsWith('/canvas/'),
        `"${spec}" resolved to ${url.pathname}, which is under /canvas/ and does not exist`,
      );
      assert.ok(
        existsSync(repoPathForUrl(url)),
        `"${spec}" resolved to ${url.pathname}, which is not a file in this repo`,
      );
    });

    it(`"${spec}" resolves identically from a mobile deep link or any other page URL`, () => {
      // Root-absolute targets are position independent. This is what makes the
      // canvas surface safe to serve from any path.
      const a = resolveAgainstDocument(imports[spec], 'https://example.test/canvas/index.html').pathname;
      const b = resolveAgainstDocument(imports[spec], 'https://example.test/canvas/').pathname;
      const c = resolveAgainstDocument(imports[spec], 'https://example.test/index.html').pathname;
      assert.equal(a, b);
      assert.equal(a, c);
    });
  }

  it('import map agrees with DUCKDB_SELF_HOST_BASE, which is already root-absolute', () => {
    const m = canvas.match(/var DUCKDB_SELF_HOST_BASE\s*=\s*'([^']+)'/);
    assert.ok(m, 'DUCKDB_SELF_HOST_BASE not found in canvas/index.html');
    assert.equal(m[1], '/assets/duckdb/');
    for (const spec of BARE_SPECIFIERS) {
      assert.ok(
        imports[spec].startsWith(m[1]),
        `"${spec}" (${imports[spec]}) does not sit under DUCKDB_SELF_HOST_BASE (${m[1]}). ` +
        'The import map and the loader base must resolve the same way.',
      );
    }
  });

  it('no import map target points at a CDN, so the offline promise holds', () => {
    for (const [spec, target] of Object.entries(imports)) {
      assert.doesNotMatch(
        target,
        /^https?:|esm\.sh|jsdelivr|unpkg|cdnjs/i,
        `"${spec}" must be self-hosted, got "${target}"`,
      );
    }
  });

  it('canvas/assets/ does not exist, which is why a relative target could never work', () => {
    assert.ok(
      !existsSync(join(REPO_ROOT, 'canvas', 'assets')),
      'canvas/assets/ now exists. If self-hosted copies were deliberately added there, ' +
      'revisit this guard; otherwise a relative import map target is still dead.',
    );
  });
});

describe('Fix 1: root index.html import map is correct as written', () => {
  const root = read('index.html');
  const imports = parseImportMap(root).imports;
  // index.html is served from the site root, so "./assets/..." already
  // resolves to /assets/... . It was verified, not assumed, and left alone.
  const ROOT_DOC_URL = 'https://example.test/index.html';

  for (const spec of BARE_SPECIFIERS) {
    it(`"${spec}" resolves to a real file from the site root`, () => {
      const url = resolveAgainstDocument(imports[spec], ROOT_DOC_URL);
      assert.equal(url.pathname.startsWith('/assets/duckdb/'), true, `got ${url.pathname}`);
      assert.ok(existsSync(repoPathForUrl(url)), `${url.pathname} is not a file in this repo`);
    });
  }
});
