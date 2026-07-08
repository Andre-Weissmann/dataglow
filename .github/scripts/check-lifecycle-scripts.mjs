#!/usr/bin/env node
// ============================================================
// DATAGLOW — Supply-Chain Install Hardening: lifecycle-script gate
// ============================================================
// Fails the build when a dependency declares an install-time lifecycle
// script (preinstall / install / postinstall) that is not on the explicit
// allowlist below. Such scripts run arbitrary code on `npm install` and are
// the most common software-supply-chain attack vector; DATAGLOW disables
// them by default via `ignore-scripts=true` in .npmrc, and this check makes
// the set of packages that carry one a reviewed, versioned decision rather
// than something that can creep in silently with a new dependency.
//
// Detection is driven off package-lock.json, which is deterministic and needs
// no network and no installed node_modules: npm records `hasInstallScript:
// true` on every package entry that ships a preinstall/install/postinstall
// hook. As a second, best-effort pass we also read each package's own
// package.json under node_modules (when present) so a lock without the flag
// still can't hide a lifecycle script.
//
// To allow a NEW dependency that legitimately needs an install script:
//   1. add its bare package name to ALLOWLIST below (with a one-line reason),
//   2. add an explicit `npm rebuild <pkg>` step to the CI job that needs it,
//   3. mention both in the PR description.
//
// Exit codes: 0 = clean, 1 = a non-allowlisted lifecycle script was found,
// 2 = the check could not run (e.g. missing lockfile).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK_PATH = join(repoRoot, 'package-lock.json');

// Packages permitted to carry an install-time lifecycle script. Keep this
// as small as possible and pair every entry with a rebuild step in CI.
const ALLOWLIST = [
  // Dev-only. Its install script downloads a browser binary. DATAGLOW's CI
  // does not rely on that download — the e2e job installs a real system
  // Chrome and points Playwright at it — but the package still declares the
  // script, so it is allowlisted rather than treated as a violation.
  'playwright-chromium',
];

// "node_modules/a/node_modules/b" -> "b"; "node_modules/@scope/x" -> "@scope/x"
function pkgNameFromLockKey(key) {
  const idx = key.lastIndexOf('node_modules/');
  return idx === -1 ? key : key.slice(idx + 'node_modules/'.length);
}

const LIFECYCLE = ['preinstall', 'install', 'postinstall'];

function fail(msg, code = 1) {
  console.error(`\n✗ lifecycle-script gate: ${msg}\n`);
  process.exit(code);
}

if (!existsSync(LOCK_PATH)) {
  fail('package-lock.json not found — cannot audit lifecycle scripts.', 2);
}

let lock;
try {
  lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
} catch (err) {
  fail(`could not parse package-lock.json: ${err.message}`, 2);
}

const offenders = new Map(); // name -> Set of reasons

function flag(name, reason) {
  if (ALLOWLIST.includes(name)) return;
  if (!offenders.has(name)) offenders.set(name, new Set());
  offenders.get(name).add(reason);
}

// Pass 1: the lockfile's own hasInstallScript flag (npm lockfile v2/v3).
const packages = lock.packages ?? {};
for (const [key, meta] of Object.entries(packages)) {
  if (key === '') continue; // the root project itself
  if (meta && meta.hasInstallScript === true) {
    flag(pkgNameFromLockKey(key), 'package-lock.json: hasInstallScript=true');
  }
}

// Pass 2 (best effort): read installed package.json scripts, if node_modules
// is present. Catches anything the lockfile flag might miss.
for (const key of Object.keys(packages)) {
  if (key === '' || !key.includes('node_modules/')) continue;
  const pkgJsonPath = join(repoRoot, key, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;
  let pj;
  try {
    pj = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    continue;
  }
  const scripts = pj.scripts ?? {};
  const found = LIFECYCLE.filter((s) => typeof scripts[s] === 'string' && scripts[s].trim() !== '');
  if (found.length > 0) {
    flag(pkgNameFromLockKey(key), `node_modules package.json declares: ${found.join(', ')}`);
  }
}

if (offenders.size === 0) {
  const allowNote = ALLOWLIST.length ? ` (allowlisted: ${ALLOWLIST.join(', ')})` : '';
  console.log(`✓ lifecycle-script gate: no non-allowlisted install scripts found${allowNote}.`);
  process.exit(0);
}

const lines = [...offenders.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, reasons]) => `  - ${name}\n      ${[...reasons].join('\n      ')}`);

fail(
  `${offenders.size} dependency(ies) declare an install-time lifecycle script ` +
    `but are NOT on the allowlist:\n\n${lines.join('\n')}\n\n` +
    `Install scripts run arbitrary code on \`npm install\`. If one of these is ` +
    `expected and trusted, add its name to ALLOWLIST in ` +
    `.github/scripts/check-lifecycle-scripts.mjs (and a matching \`npm rebuild\` ` +
    `step in CI). Otherwise, this is a potential supply-chain issue — investigate ` +
    `before merging.`,
);
