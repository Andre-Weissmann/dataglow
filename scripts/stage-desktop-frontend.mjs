// Stage the static site's runtime assets into src-tauri/dist/ for the Tauri
// desktop shell.
//
// WHY this exists: Tauri v1 refuses a `distDir` that contains `node_modules` or
// `src-tauri` ("isolate your web assets on a separate folder"), so the shell
// cannot point `distDir` straight at the repository root where the site lives.
// This is a plain file COPY — no bundling, transpiling, or minification — so the
// bytes served in the desktop window are identical to what a browser loads. It
// runs automatically via `beforeDevCommand`/`beforeBuildCommand` in
// tauri.conf.json; the destination (src-tauri/dist/) is gitignored.
//
// The allowlist below is the site's runtime surface: index.html plus every
// directory/file it (or its ES-module graph) loads at run time. If the site
// grows a new top-level runtime asset, add it here.

import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const distDir = join(repoRoot, 'src-tauri', 'dist');

// Runtime web assets, relative to the repo root. Kept explicit (not a
// blanket copy-everything-except) so build/test/tooling files never leak into
// the shipped bundle.
const ASSETS = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'assets',
  'css',
  'js',
  'protocol',
];

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const missing = [];
for (const entry of ASSETS) {
  const from = join(repoRoot, entry);
  if (!existsSync(from)) {
    missing.push(entry);
    continue;
  }
  cpSync(from, join(distDir, entry), { recursive: true });
}

if (missing.length > 0) {
  console.error(
    `stage-desktop-frontend: expected runtime asset(s) not found: ${missing.join(', ')}`,
  );
  process.exit(1);
}

console.log(`stage-desktop-frontend: staged ${ASSETS.length} entries into src-tauri/dist/`);
