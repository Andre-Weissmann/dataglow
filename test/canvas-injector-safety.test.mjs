// ============================================================
// DATAGLOW - canvas injector safety (NORTH_STAR 0z4)
// ============================================================
// inject_bundle16.py used to regenerate the Drill Floor spans of
// canvas/index.html from a stale template, shrinking drill-floor.js by ~10KB
// and drill-floor-data.js by ~800 bytes without any per-file gate noticing.
// It is now split in two:
//   - inject_bundle16.py            : only the 5 Part A modules; NEVER touches Drill Floor
//   - inject_drill_floor_resync.py  : syncs the engine body of the two Drill Floor files,
//                                     preserves the live UI tail byte for byte
// This test runs both against a TEMP COPY of the repo inputs (the real
// canvas/index.html is never written) and proves:
//   1. on an in-sync canvas both are byte-for-byte no-ops (SHA-256 identical)
//   2. inject_bundle16.py leaves both Drill Floor spans identical even when the
//      Drill Floor js/ sources change
//   3. inject_drill_floor_resync.py propagates an engine-body change but keeps
//      the live tail verbatim and the span never shrinks
//   4. inject_drill_floor_resync.py refuses (writes nothing) when a tail anchor
//      is missing
//
// RUN WITH: node test/canvas-injector-safety.test.mjs

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg); }
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dg-injector-safety-'));
  mkdirSync(join(dir, 'canvas'));
  cpSync(join(repoRoot, 'canvas', 'index.html'), join(dir, 'canvas', 'index.html'));
  cpSync(join(repoRoot, 'js'), join(dir, 'js'), { recursive: true });
  for (const f of ['inject_bundle16.py', 'inject_drill_floor_resync.py']) {
    cpSync(join(repoRoot, f), join(dir, f));
  }
  return dir;
}

function py(dir, script, args = []) {
  return spawnSync('python3', [script, ...args], { cwd: dir, encoding: 'utf8' });
}

function span(html, path, endName) {
  const start = `/* ---- from ${path} ---- */`;
  const end = `/* ---- end ${endName} ---- */`;
  const i = html.indexOf(start);
  const j = html.indexOf(end, i);
  if (i === -1 || j === -1) return null;
  return html.slice(i, j + end.length);
}
const FLOOR = ['js/drill-floor/drill-floor.js', 'drill-floor.js'];
const DATA = ['js/drill-floor/drill-floor-data.js', 'drill-floor-data.js'];

const dirs = [];
try {
  // ---- 1. in-sync canvas: both injectors are byte-for-byte no-ops ----
  console.log('in-sync canvas');
  {
    const dir = makeSandbox(); dirs.push(dir);
    const canvas = join(dir, 'canvas', 'index.html');
    const before = sha(canvas);
    const html0 = readFileSync(canvas, 'utf8');
    const floorLen0 = span(html0, ...FLOOR).length;
    const dataLen0 = span(html0, ...DATA).length;
    ok(floorLen0 > 50000, `drill-floor.js live span is the full live size (${floorLen0} chars)`);

    const r1 = py(dir, 'inject_bundle16.py');
    ok(r1.status === 0, 'inject_bundle16.py exits 0');
    ok(sha(canvas) === before, 'inject_bundle16.py leaves canvas/index.html byte-for-byte identical');
    ok(!/drill-floor/.test(r1.stdout), 'inject_bundle16.py no longer reports Drill Floor files');

    const r2 = py(dir, 'inject_drill_floor_resync.py');
    ok(r2.status === 0, 'inject_drill_floor_resync.py exits 0');
    ok(sha(canvas) === before, 'inject_drill_floor_resync.py leaves canvas/index.html byte-for-byte identical');

    const chk = py(dir, 'inject_drill_floor_resync.py', ['--check']);
    ok(chk.status === 0, 'inject_drill_floor_resync.py --check reports in sync');

    const html1 = readFileSync(canvas, 'utf8');
    ok(span(html1, ...FLOOR).length >= floorLen0, 'drill-floor.js span did not shrink');
    ok(span(html1, ...DATA).length >= dataLen0, 'drill-floor-data.js span did not shrink');
  }

  // ---- 2 + 3. source change: bundle16 ignores it, resync propagates the engine body only ----
  console.log('drill-floor.js source changed');
  {
    const dir = makeSandbox(); dirs.push(dir);
    const canvas = join(dir, 'canvas', 'index.html');
    const html0 = readFileSync(canvas, 'utf8');
    const floor0 = span(html0, ...FLOOR);
    const tailAnchor = '// Bundle 18 hotfix 5: shared live-engine resolver';
    const tail0 = floor0.slice(floor0.indexOf(tailAnchor));

    const srcPath = join(dir, 'js/drill-floor/drill-floor.js');
    const marker = '// injector-safety-test-sentinel';
    writeFileSync(srcPath, readFileSync(srcPath, 'utf8') + '\n' + marker + '\n');

    ok(py(dir, 'inject_bundle16.py').status === 0, 'inject_bundle16.py exits 0 with changed Drill Floor source');
    ok(sha(canvas) === sha(join(repoRoot, 'canvas', 'index.html')),
      'inject_bundle16.py ignores Drill Floor source changes entirely');

    const r = py(dir, 'inject_drill_floor_resync.py');
    ok(r.status === 0, 'inject_drill_floor_resync.py exits 0 with changed source');
    const html1 = readFileSync(canvas, 'utf8');
    const floor1 = span(html1, ...FLOOR);
    ok(floor1.includes(marker), 'engine-body change reached the canvas span');
    ok(floor1.length >= floor0.length, 'drill-floor.js span did not shrink');
    ok(floor1.endsWith(tail0), 'live tail (resolver, mountDrillFloor, window.DrillFloor) preserved verbatim');
    ok(span(html1, ...DATA) === span(html0, ...DATA), 'drill-floor-data.js span untouched when only drill-floor.js changed');
    ok(html1.replace(marker, '').length <= html0.length + 1 + marker.length, 'nothing else in the canvas moved');

    const r2 = py(dir, 'inject_drill_floor_resync.py');
    ok(r2.status === 0 && readFileSync(canvas, 'utf8') === html1, 'second run is idempotent');
  }

  // ---- 4. missing anchor: refuse, write nothing ----
  console.log('missing tail anchor');
  {
    const dir = makeSandbox(); dirs.push(dir);
    const canvas = join(dir, 'canvas', 'index.html');
    const html = readFileSync(canvas, 'utf8').replace('// Bundle 18 hotfix 5: shared live-engine resolver', '// renamed');
    writeFileSync(canvas, html);
    const before = sha(canvas);
    const r = py(dir, 'inject_drill_floor_resync.py');
    ok(r.status !== 0, 'inject_drill_floor_resync.py exits non-zero when the live tail anchor is gone');
    ok(sha(canvas) === before, 'canvas left untouched on refusal');
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
