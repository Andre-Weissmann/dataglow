// ============================================================
// DATAGLOW — Tauri desktop staging regression guard
// ============================================================
// Runs scripts/stage-desktop-frontend.mjs and proves the staged bundle
// (src-tauri/dist/) carries every root-level runtime JSON/manifest asset the app
// fetches via `new URL('../../<file>', import.meta.url)`. Root cause this guards:
// flags.manifest.json was fetched by js/app-shell/main.js but missing from the
// hand-maintained ASSETS allowlist, so in the packaged desktop window the fetch
// 404'd, configureFlags() never ran, and every flag silently read as OFF.
//
// RUN WITH:  node test/stage-desktop-frontend.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'src-tauri', 'dist');
const stageScript = join(repoRoot, 'scripts', 'stage-desktop-frontend.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra ? `\n      ${extra}` : ''}`); }
}

execFileSync(process.execPath, [stageScript], { cwd: repoRoot, stdio: 'pipe' });

// --- 1. staged files exist and byte-match the repo root ---
for (const rel of ['flags.manifest.json', 'capability-map.manifest.json', 'index.html', 'sw.js', 'manifest.webmanifest']) {
  const staged = join(distDir, rel);
  const exists = existsSync(staged);
  ok(`staged ${rel} exists`, exists);
  if (exists) {
    ok(`staged ${rel} is byte-identical to repo root`,
      readFileSync(staged).equals(readFileSync(join(repoRoot, rel))));
  }
}

// --- 2. every root-relative JSON/manifest fetch in the app is in ASSETS ---
const stageSrc = readFileSync(stageScript, 'utf8');
const assetsBlock = /const ASSETS = \[([\s\S]*?)\];/.exec(stageSrc);
ok('ASSETS array is parseable from the stage script', !!assetsBlock);
const assets = new Set([...(assetsBlock?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]));

// new URL('../../flags.manifest.json', import.meta.url) style references. main.js
// lives at js/app-shell/main.js so '../../' is the repo root; index.html lives at
// the root so './' (or none) is the root.
const scanTargets = [
  { file: 'js/app-shell/main.js', depth: 2 },
  { file: 'index.html', depth: 0 },
];
const found = new Set();
for (const { file, depth } of scanTargets) {
  const src = readFileSync(join(repoRoot, file), 'utf8');
  const re = /new URL\(\s*['"]((?:\.\.\/|\.\/)*)([A-Za-z0-9_.\-/]+\.(?:json|webmanifest))['"]\s*,\s*import\.meta\.url\s*\)/g;
  for (const m of src.matchAll(re)) {
    const ups = (m[1].match(/\.\.\//g) || []).length;
    if (ups === depth) found.add(m[2]); // resolves to the repo root
  }
}
ok('scan found the flags.manifest.json root fetch in main.js', found.has('flags.manifest.json'),
  `found: ${[...found].join(', ')}`);
for (const rel of found) {
  ok(`root-relative runtime asset "${rel}" is in ASSETS`, assets.has(rel));
  ok(`root-relative runtime asset "${rel}" is staged`, existsSync(join(distDir, rel)));
}
// index.html itself fetches/links root manifests too; they must be staged.
const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8');
for (const m of indexHtml.matchAll(/<link[^>]+rel=["']manifest["'][^>]*href=["']\.?\/?([^"']+)["']/g)) {
  ok(`index.html <link rel=manifest> target "${m[1]}" is in ASSETS`, assets.has(m[1]));
}

// --- 3. staged flags actually configure the flag store ---
const { configureFlags, isEnabled, resetFlags } =
  await import(pathToFileURL(join(repoRoot, 'js', 'build', 'build-flags.js')).href);
const stagedManifest = JSON.parse(readFileSync(join(distDir, 'flags.manifest.json'), 'utf8'));
const loaded = configureFlags(stagedManifest);
ok('configureFlags() loaded a non-trivial number of flags from the staged manifest', loaded > 100, `loaded=${loaded}`);
ok('glowCanvas is enabled via staged manifest', isEnabled('glowCanvas') === true);
ok('audioTranscription is enabled via staged manifest', isEnabled('audioTranscription') === true);
ok('videoTranscription is still disabled via staged manifest', isEnabled('videoTranscription') === false);
resetFlags();

console.log(`\n${failed === 0 ? '\u2713 PASSED' : '\u2717 FAILED'} \u2014 ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
