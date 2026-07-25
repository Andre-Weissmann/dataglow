// ============================================================
// DATAGLOW - Bundle integrity gate for canvas/index.html
// ============================================================
// WHY this exists. DataGlow has two frontend surfaces that mirror the same
// pure-logic modules under `js/`:
//
//   * `index.html` (repo root) loads those modules as real ES modules. This is
//     what `scripts/stage-desktop-frontend.mjs` copies into `src-tauri/dist/`
//     for the Tauri desktop shell.
//   * `canvas/index.html` is the single-file web surface. It does not load
//     `js/` at run time: each module is INLINED into its one big <script>,
//     wrapped in `/* ---- from <path> ---- */` ... `/* ---- end <path> ---- */`
//     markers by an `inject_*.py` script.
//
// That means a module under `js/` can be edited while its inlined copy in
// `canvas/index.html` goes stale. Desktop then behaves one way and web another,
// silently, with nothing failing. This script is the gate against that.
//
// CANVAS IS AUTHORITATIVE for the canvas surface. `build.sh` still describes
// `src/` (`src/js/bundle.js` + `src/index.html` + `src/css/main.css`) as the
// build input that PRODUCES `canvas/index.html`, but that path has been bypassed
// for a long time: features land by injecting straight into `canvas/index.html`,
// so `src/js/bundle.js` is a stale legacy snapshot. Rebuilding from `src/` would
// silently DROP every injected feature. Byte-equality with `src/js/bundle.js` is
// therefore deliberately NOT required here. Instead this script asserts that
// `build.sh` carries an explicit opt-in guard so a stale rebuild cannot clobber
// the authoritative canvas by accident.
//
// CHECKS (all fast, all offline, no browser):
//   1. Every inline <script> in canvas/index.html parses (`node --check`).
//   2. Each TRACKED module is inlined exactly once with a from/end marker pair.
//   3. Tracked modules have not drifted: for each entry in
//      canvas/integrity.manifest.json, the `js/` source file's SHA-256 and the
//      SHA-256 of its inlined canvas section both match what is committed. A
//      change to either without re-injecting fails here.
//   4. The desktop stage script still ships `js/` (the source of truth the
//      canvas mirrors) and build.sh still carries the clobber guard.
//   5. The whole canvas file is the exact size that was last recorded. Checks
//      1 to 3 only look at tracked spans, so a canvas truncated by a failed
//      write, a bad merge or a partial upload could still pass them all while
//      being the wrong artifact to publish. `canvasBytes` was already being
//      written on --update but never verified, which made it a dead guard.
//
// USAGE:
//   npm run check:canvas-integrity            # verify (this is what CI runs)
//   npm run check:canvas-integrity -- --update  # re-record hashes after a
//                                               # deliberate re-injection
//
// Adding a module to `tracked` opts it into strict drift detection. Removing one
// is a visible diff, so the gate cannot be weakened quietly.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const CANVAS = join(repoRoot, 'canvas', 'index.html');
const MANIFEST = join(repoRoot, 'canvas', 'integrity.manifest.json');
const STAGE_SCRIPT = join(repoRoot, 'scripts', 'stage-desktop-frontend.mjs');
const BUILD_SH = join(repoRoot, 'build.sh');

// build.sh must carry this token so a rebuild from the stale `src/` tree cannot
// overwrite the authoritative canvas without an explicit opt-in.
const CLOBBER_GUARD_TOKEN = 'ALLOW_CANVAS_REBUILD';

const UPDATE = process.argv.includes('--update');

const failures = [];
const notes = [];

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function read(path) {
  return readFileSync(path, 'utf8');
}

// ------------------------------------------------------------
// Check 1: every inline <script> in the canvas parses.
// ------------------------------------------------------------
function inlineScripts(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    const typeMatch = /\btype\s*=\s*["']([^"']+)["']/.exec(attrs);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';
    // Skip data blocks (importmap, application/json, text/template, ...).
    if (type && type !== 'module' && !/javascript/.test(type)) continue;
    out.push({ module: type === 'module', code: m[2], start: m.index });
  }
  return out;
}

function checkSyntax(html) {
  const scripts = inlineScripts(html);
  if (scripts.length === 0) {
    failures.push('canvas/index.html: found no inline <script> blocks to check');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'dg-canvas-integrity-'));
  try {
    scripts.forEach((s, i) => {
      const file = join(dir, `inline-${i}${s.module ? '.mjs' : '.js'}`);
      writeFileSync(file, s.code, 'utf8');
      const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (res.status !== 0) {
        failures.push(
          `canvas/index.html: inline <script> #${i} (offset ${s.start}) failed node --check:\n` +
          String(res.stderr || res.stdout || '').trim(),
        );
      }
    });
    notes.push(`syntax: ${scripts.length} inline <script> block(s) parsed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------
// Check 2 + 3: inline module markers and tracked-module drift.
// ------------------------------------------------------------
function markerPairs(html) {
  const from = new Map();
  const end = new Map();
  const reFrom = /\/\* ---- from ([^\s*]+) ---- \*\//g;
  const reEnd = /\/\* ---- end ([^\s*]+) ---- \*\//g;
  let m;
  while ((m = reFrom.exec(html)) !== null) from.set(m[1], (from.get(m[1]) || 0) + 1);
  while ((m = reEnd.exec(html)) !== null) end.set(m[1], (end.get(m[1]) || 0) + 1);
  return { from, end };
}

// Marker hygiene is only enforced for TRACKED modules. Historical injections are
// inconsistent (many emit no closing marker, and some close with a bare basename
// rather than the full path), so a repo-wide pairing rule would be all noise. A
// tracked module must be inlined exactly once with a matching from/end pair,
// because the drift hashes below are computed from exactly that span.
function checkMarkers(html, manifest) {
  const { from, end } = markerPairs(html);
  for (const entry of Array.isArray(manifest.tracked) ? manifest.tracked : []) {
    const opens = from.get(entry.source) || 0;
    const closes = end.get(entry.source) || 0;
    if (opens !== 1 || closes !== 1) {
      failures.push(
        `canvas/index.html: tracked module ${entry.source} must be inlined exactly once ` +
        `with a from/end pair (found ${opens} "from", ${closes} "end").`,
      );
    }
  }
  notes.push(
    `markers: ${from.size} inlined module path(s) in canvas/index.html, ` +
    `${end.size} closing marker(s); tracked modules correctly paired`,
  );
}

/** The canvas text between a module's from/end markers, inclusive. */
function canvasSection(html, path) {
  const open = `/* ---- from ${path} ---- */`;
  const close = `/* ---- end ${path} ---- */`;
  const a = html.indexOf(open);
  if (a === -1) return null;
  const b = html.indexOf(close, a);
  if (b === -1) return null;
  return html.slice(a, b + close.length);
}

function checkTracked(html, manifest) {
  const tracked = Array.isArray(manifest.tracked) ? manifest.tracked : [];
  if (tracked.length === 0) {
    failures.push('canvas/integrity.manifest.json: "tracked" is empty; the gate would check nothing');
    return;
  }
  for (const entry of tracked) {
    const path = entry.source;
    const abs = join(repoRoot, path);
    if (!existsSync(abs)) {
      failures.push(`${path}: tracked source file is missing (delete the manifest entry or restore the file)`);
      continue;
    }
    const sourceSha = sha256(read(abs));
    const section = canvasSection(html, path);
    if (section === null) {
      failures.push(`${path}: tracked module is not inlined in canvas/index.html (missing from/end markers)`);
      continue;
    }
    const canvasSha = sha256(section);

    if (UPDATE) {
      entry.sourceSha256 = sourceSha;
      entry.canvasSectionSha256 = canvasSha;
      entry.canvasSectionBytes = Buffer.byteLength(section, 'utf8');
      continue;
    }
    if (entry.sourceSha256 !== sourceSha) {
      failures.push(
        `${path}: source file changed but the canvas was not re-injected.\n` +
        `  recorded ${entry.sourceSha256}\n  actual   ${sourceSha}\n` +
        `  Fix: re-run the module's inject_*.py against canvas/index.html, then\n` +
        '       npm run check:canvas-integrity -- --update',
      );
    }
    if (entry.canvasSectionSha256 !== canvasSha) {
      failures.push(
        `${path}: the inlined copy in canvas/index.html changed outside an injection.\n` +
        `  recorded ${entry.canvasSectionSha256}\n  actual   ${canvasSha}\n` +
        '  Fix: port the edit back to the js/ source, re-inject, then\n' +
        '       npm run check:canvas-integrity -- --update',
      );
    }
  }
  if (!UPDATE) notes.push(`tracked: ${tracked.length} module(s) verified against canvas/integrity.manifest.json`);
}

// ------------------------------------------------------------
// Check 4: the ship path stays canvas-safe.
// ------------------------------------------------------------
function checkShipPath() {
  if (!existsSync(STAGE_SCRIPT)) {
    failures.push('scripts/stage-desktop-frontend.mjs: missing; the desktop ship path cannot be verified');
  } else {
    const stage = read(STAGE_SCRIPT);
    // The desktop shell loads root index.html, which imports the js/ modules the
    // canvas mirrors. If js/ stopped being staged, desktop would ship a
    // different frontend from the canvas with nothing else catching it.
    for (const required of ["'index.html'", "'js'"]) {
      if (!stage.includes(required)) {
        failures.push(
          `scripts/stage-desktop-frontend.mjs: ${required} is no longer in the staged ASSETS list; ` +
          'the desktop bundle would not ship the modules canvas/index.html mirrors',
        );
      }
    }
    notes.push('ship path: desktop stage script still stages index.html + js/');
  }

  if (!existsSync(BUILD_SH)) {
    failures.push('build.sh: missing; the canvas clobber guard cannot be verified');
  } else if (!read(BUILD_SH).includes(CLOBBER_GUARD_TOKEN)) {
    failures.push(
      `build.sh: the ${CLOBBER_GUARD_TOKEN} opt-in guard is gone. build.sh rebuilds ` +
      'canvas/index.html from the stale src/ tree, which would drop every injected ' +
      'feature. Restore the guard before removing this check.',
    );
  } else {
    notes.push('ship path: build.sh still guards canvas/index.html against a stale src/ rebuild');
  }
}

// ------------------------------------------------------------
// Check 5: the published artifact is whole.
// ------------------------------------------------------------
// Checks 1 to 3 verify tracked spans. Nothing above notices if the rest of the
// file lost 2 MB: the tracked sections would still hash correctly and every
// remaining <script> would still parse. Pinning the total size is the cheapest
// honest answer to "is this the canvas we meant to publish".
function checkCanvasBytes(html, manifest) {
  const actual = Buffer.byteLength(html, 'utf8');
  const recorded = manifest.canvasBytes;
  if (typeof recorded !== 'number' || !Number.isFinite(recorded)) {
    failures.push(
      'canvas/integrity.manifest.json: "canvasBytes" is missing or not a number, so the ' +
      'published canvas size is unpinned.\n' +
      '  Fix: npm run check:canvas-integrity -- --update',
    );
    return;
  }
  if (recorded !== actual) {
    const delta = actual - recorded;
    failures.push(
      `canvas/index.html: the file is ${actual} bytes but ${recorded} was recorded ` +
      `(${delta > 0 ? '+' : ''}${delta}).\n` +
      '  If you just injected or edited the canvas on purpose, re-record it:\n' +
      '       npm run check:canvas-integrity -- --update\n' +
      '  If you did NOT, treat this as a truncated or wrong canvas and do not publish it.',
    );
    return;
  }
  notes.push(`publish: canvas/index.html is the recorded ${actual} bytes`);
}

// ------------------------------------------------------------
function main() {
  if (!existsSync(CANVAS)) {
    console.error('check-canvas-integrity: canvas/index.html not found');
    process.exit(1);
  }
  if (!existsSync(MANIFEST)) {
    console.error('check-canvas-integrity: canvas/integrity.manifest.json not found');
    process.exit(1);
  }

  const html = read(CANVAS);
  const manifest = JSON.parse(read(MANIFEST));

  checkSyntax(html);
  checkMarkers(html, manifest);
  checkTracked(html, manifest);
  checkShipPath();
  if (!UPDATE) checkCanvasBytes(html, manifest);

  if (UPDATE) {
    manifest.canvasBytes = Buffer.byteLength(html, 'utf8');
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('check-canvas-integrity: manifest hashes updated');
  }

  for (const n of notes) console.log(`  ok  ${n}`);
  if (failures.length > 0) {
    console.error(`\ncheck-canvas-integrity: ${failures.length} problem(s)\n`);
    for (const f of failures) console.error(`  FAIL  ${f}\n`);
    process.exit(1);
  }
  console.log('\ncheck-canvas-integrity: canvas bundle integrity OK');
}

main();
