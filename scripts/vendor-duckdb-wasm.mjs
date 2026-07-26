#!/usr/bin/env node
// ============================================================
// DATAGLOW - vendor-duckdb-wasm.mjs
// ============================================================
//
// Copies the pinned @duckdb/duckdb-wasm runtime essentials from
// node_modules into a same-origin path this app can self-host from. The
// SINGLE on-disk copy this repo ships lives at assets/duckdb/ (root
// index.html's own import map already self-hosts apache-arrow/tslib/
// flatbuffers from that same directory) -- js/sql/duckdb-load-harden.js's
// self-host candidate and canvas/index.html's inlined loader both point at
// assets/duckdb/ so there is exactly one vendored tree, not a second
// canvas/vendor/duckdb-wasm/ copy duplicating ~74MB for no benefit. CDN
// candidates (jsDelivr/unpkg/esm.sh) remain as the fallback list in
// js/sql/duckdb-load-harden.js -- this script only (re)produces the files
// the self-host candidate needs on disk, for the rare case assets/duckdb/
// needs to be regenerated from a fresh node_modules install.
//
// WHY THIS COPIES RATHER THAN SYMLINKS.
// node_modules is gitignored and not guaranteed to exist at deploy/publish
// time (a fresh clone with --omit=dev, a CDN edge without npm ci run). A
// real copy under assets/duckdb/ is a committable (or rsync-able) artifact;
// a symlink into node_modules is not.
//
// WHY ONLY THESE FILES, NOT THE WHOLE dist/ (~140MB).
// The product only ever loads ONE bundle at a time (EH -- multi-threaded,
// requires cross-origin isolation -- or MVP, the single-threaded fallback
// browsers without COOP/COEP fall back to) plus the browser ESM entry that
// picks between them and the worker script that runs the picked one. Source
// maps, the Node build, the blocking build and the COI (pthread) build are
// never imported by this browser-only product and are left out so the
// vendored set stays well inside a single Git object's size limits.
//
// USAGE:
//   node scripts/vendor-duckdb-wasm.mjs
//   node scripts/vendor-duckdb-wasm.mjs --dest assets/duckdb
//
// Exits non-zero (and prints exactly what is missing) if node_modules does
// not have the package installed, rather than silently producing a half
// vendored directory a page would fail to load from later.

import { existsSync, mkdirSync, copyFileSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_DIR = join(REPO_ROOT, 'node_modules', '@duckdb', 'duckdb-wasm');
const DIST_DIR = join(PKG_DIR, 'dist');

/**
 * The minimum runtime set: the ESM entry (selectBundle/getJsDelivrBundles
 * live here), both worker scripts, and both wasm bundles (EH first-choice,
 * MVP the no-cross-origin-isolation fallback DuckDB itself picks between).
 * Ordered smallest-first so a partial copy under a size ceiling still lands
 * the small, load-bearing files before the big wasm blobs.
 */
export const VENDOR_FILES = Object.freeze([
  'duckdb-browser.mjs',
  'duckdb-browser-eh.worker.js',
  'duckdb-browser-mvp.worker.js',
  'duckdb-eh.wasm',
  'duckdb-mvp.wasm',
]);

/** Files that make the EH (multi-threaded) bundle usable at all -- the floor. */
export const VENDOR_FILES_MINIMUM = Object.freeze([
  'duckdb-browser.mjs',
  'duckdb-browser-eh.worker.js',
  'duckdb-eh.wasm',
]);

function parseArgs(argv) {
  const out = { dest: join(REPO_ROOT, 'assets', 'duckdb'), minimumOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dest' && argv[i + 1]) { out.dest = join(REPO_ROOT, argv[i + 1]); i++; }
    else if (argv[i] === '--minimum-only') out.minimumOnly = true;
  }
  return out;
}

export function vendorDuckdbWasm(opts) {
  const o = opts || {};
  const destDir = o.dest || join(REPO_ROOT, 'assets', 'duckdb');
  const fileList = o.minimumOnly ? VENDOR_FILES_MINIMUM : VENDOR_FILES;

  if (!existsSync(DIST_DIR)) {
    throw new Error(
      'node_modules/@duckdb/duckdb-wasm/dist not found. Run `npm ci` first -- ' +
      'this script vendors from the installed package, it does not fetch anything itself.'
    );
  }

  const pkgJson = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));

  mkdirSync(destDir, { recursive: true });

  const copied = [];
  const missing = [];
  for (const name of fileList) {
    const src = join(DIST_DIR, name);
    if (!existsSync(src)) { missing.push(name); continue; }
    const dst = join(destDir, name);
    copyFileSync(src, dst);
    copied.push({ name, bytes: statSync(dst).size });
  }

  if (missing.length) {
    throw new Error('Missing expected duckdb-wasm dist files: ' + missing.join(', '));
  }

  // A small manifest pin so tests and the deploy checklist can assert the
  // vendored version without re-deriving it from file sizes.
  const manifest = {
    name: '@duckdb/duckdb-wasm',
    version: pkgJson.version,
    vendoredFrom: 'node_modules/@duckdb/duckdb-wasm/dist',
    files: copied,
    totalBytes: copied.reduce((sum, f) => sum + f.bytes, 0),
    generatedBy: 'scripts/vendor-duckdb-wasm.mjs',
  };
  writeFileSync(join(destDir, 'VENDOR_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

  return manifest;
}

// Also mirror the tiny package.json pin used by js/app-shell/duckdb-config.js
// (PINNED_DUCKDB_WASM_VERSION) so there is one committed file that answers
// "what version is vendored" without reaching into node_modules or vendor/.
export function writeAssetsPin() {
  const pkgJson = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  const assetsDir = join(REPO_ROOT, 'assets', 'duckdb');
  mkdirSync(assetsDir, { recursive: true });
  const pin = { name: '@duckdb/duckdb-wasm', version: pkgJson.version };
  writeFileSync(join(assetsDir, 'duckdb-wasm.package.json'), JSON.stringify(pin, null, 2) + '\n');
  return pin;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const pin = writeAssetsPin();
    console.log('Wrote version pin: assets/duckdb/duckdb-wasm.package.json (' + pin.version + ')');
    const manifest = vendorDuckdbWasm(args);
    console.log('Vendored @duckdb/duckdb-wasm@' + manifest.version + ' -> ' + args.dest);
    for (const f of manifest.files) {
      console.log('  ' + f.name + '  (' + (f.bytes / (1024 * 1024)).toFixed(2) + ' MB)');
    }
    console.log('Total: ' + (manifest.totalBytes / (1024 * 1024)).toFixed(2) + ' MB');
  } catch (e) {
    console.error('vendor-duckdb-wasm failed: ' + e.message);
    process.exit(1);
  }
}
