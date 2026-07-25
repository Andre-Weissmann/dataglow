// ============================================================
// DATAGLOW - New module scaffold (unit tests)
// ============================================================
// A scaffold that emits code which does not parse is worse than no scaffold:
// the first thing it produces is a red CI run. So the important tests here run
// the emitted text through `node --check`, the same parse gate that
// scripts/check-canvas-integrity.mjs applies to every inline canvas <script>.
// The rest cover the guard rails: the scaffold must refuse paths outside js/,
// must never write during --dry-run, and must emit the marker pair that the
// integrity gate looks for.
//
// RUN WITH:  node --test test/new-module.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELP, namespaceFor, titleFor, renderModule, parseArgs, validatePath } from '../scripts/new-module.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'new-module.mjs');
const EM_DASH = '—';

function parses(source, ext) {
  const dir = mkdtempSync(join(tmpdir(), 'dg-scaffold-'));
  try {
    const file = join(dir, `scaffold.${ext}`);
    writeFileSync(file, source, 'utf8');
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return { ok: res.status === 0, err: res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('namespaceFor derives the window global from the file name', () => {
  assert.equal(namespaceFor('js/privacy/air-gap-mode.js'), 'DataGlowAirGapMode');
  assert.equal(namespaceFor('js/x/thing.mjs'), 'DataGlowThing');
});

test('titleFor derives a readable header title', () => {
  assert.equal(titleFor('js/privacy/air-gap-mode.js'), 'Air Gap Mode');
});

test('the IIFE scaffold parses under node --check', () => {
  const out = parses(renderModule({ path: 'js/demo/thing.js' }), 'js');
  assert.ok(out.ok, out.err);
});

test('the ESM scaffold parses under node --check', () => {
  const out = parses(renderModule({ path: 'js/demo/thing.js', esm: true }), 'mjs');
  assert.ok(out.ok, out.err);
});

test('a scaffold with an explicit namespace still parses', () => {
  const source = renderModule({ path: 'js/demo/thing.js', namespace: 'DataGlowCustomName' });
  assert.match(source, /window\.DataGlowCustomName = \{/);
  assert.ok(parses(source, 'js').ok);
});

test('the IIFE scaffold carries the canvas marker pair', () => {
  const source = renderModule({ path: 'js/demo/thing.js' });
  assert.ok(source.startsWith('/* ---- from js/demo/thing.js ---- */\n'));
  assert.ok(source.trimEnd().endsWith('/* ---- end js/demo/thing.js ---- */'));
});

test('--no-markers drops the marker pair', () => {
  const source = renderModule({ path: 'js/demo/thing.js', markers: false });
  assert.ok(!source.includes('---- from'));
  assert.ok(parses(source, 'js').ok);
});

test('the IIFE scaffold keeps everything inside the outer function', () => {
  const source = renderModule({ path: 'js/demo/thing.js' });
  assert.match(source, /^;\(function \(\) \{$/m);
  assert.match(source, /^  'use strict';$/m);
  assert.ok(!/^(var|function|const|let) /m.test(source.replace(/^\/\/.*$/gm, '')), 'no top-level declarations');
});

test('no scaffolded or help text contains an em dash', () => {
  assert.ok(!renderModule({ path: 'js/demo/thing.js' }).includes(EM_DASH));
  assert.ok(!renderModule({ path: 'js/demo/thing.js', esm: true }).includes(EM_DASH));
  assert.ok(!HELP.includes(EM_DASH));
});

test('parseArgs reads the path and the options', () => {
  const o = parseArgs(['js/a/b.js', '--esm', '--namespace', 'DataGlowB', '--dry-run']);
  assert.equal(o.path, 'js/a/b.js');
  assert.equal(o.esm, true);
  assert.equal(o.namespace, 'DataGlowB');
  assert.equal(o.dryRun, true);
  assert.equal(o.markers, true);
});

test('parseArgs rejects an unknown option', () => {
  assert.throws(() => parseArgs(['js/a/b.js', '--wat']), /unknown option/);
});

test('validatePath refuses anything outside js/', () => {
  assert.equal(validatePath('js/a/b.js'), '');
  assert.match(validatePath(''), /required/);
  assert.match(validatePath('/tmp/evil.js'), /repo-relative/);
  assert.match(validatePath('scripts/a.js'), /under js\//);
  assert.match(validatePath('js/../../evil.js'), /climb out/);
  assert.match(validatePath('js/a/b.txt'), /\.js/);
});

test('--dry-run prints the module and writes nothing', () => {
  const rel = 'js/__scaffold_dry_run_probe__.js';
  const res = spawnSync(process.execPath, [SCRIPT, rel, '--dry-run'], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('---- from ' + rel));
  assert.equal(existsSync(join(REPO_ROOT, rel)), false, 'dry run must not touch the tree');
});

test('the CLI refuses a path outside js/ with a non-zero exit', () => {
  const res = spawnSync(process.execPath, [SCRIPT, 'scripts/nope.js'], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /under js\//);
});

test('--help documents the promote and inline path', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /inject_/);
  assert.match(res.stdout, /check:canvas-integrity/);
  assert.match(res.stdout, /capability-map\.manifest\.json/);
});

test('a written scaffold parses, then is removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dg-scaffold-cli-'));
  try {
    const res = spawnSync(process.execPath, [SCRIPT, 'js/demo/written-probe.js'], { encoding: 'utf8', cwd: dir });
    // The script always resolves against the repo root, so run it there and
    // clean up rather than trusting the cwd.
    assert.equal(res.status, 0, res.stderr);
    const written = join(REPO_ROOT, 'js/demo/written-probe.js');
    assert.ok(existsSync(written), 'the scaffold should have been written');
    assert.ok(parses(readFileSync(written, 'utf8'), 'js').ok);
    rmSync(written);
    rmSync(join(REPO_ROOT, 'js/demo'), { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
