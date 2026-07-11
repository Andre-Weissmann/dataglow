// ============================================================
// DATAGLOW — Cell-level Data Blame test suite
// ============================================================
// Covers the pure, offline logic behind the cell-level "data blame" /
// transform-history view (js/provenance/data-blame.js). Data Blame is a READER
// over the EXISTING provenance chain of custody (js/provenance/provenance.js) —
// it does not maintain a second parallel log. Every unit here is pure JS built
// on a hand-made provenance trail, so it needs no DuckDB and no browser,
// mirroring the problem-framer / signal-store suites.
//
// RUN WITH:  node test/data-blame.test.mjs

import {
  buildBlameDetail,
  normalizeBlameEntry,
  buildBlameIndex,
  blameForColumn,
  blameForCell,
  replayLog,
  summarizeColumnBlame,
} from '../js/provenance/data-blame.js';
import { createProvenanceChain } from '../js/provenance/provenance.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function buildSampleTrail() {
  const chain = createProvenanceChain();
  await chain.append('load', 'Loaded raw CSV', null, 'a'.repeat(64));
  // New-shape cleaning steps recorded via buildBlameDetail:
  await chain.append('clean', 'Fill with mean — 12 null(s) in "los".',
    buildBlameDetail({ rule: 'fill_mean', columns: ['los'], affectedCount: 12, predicate: '"los" IS NULL' }));
  await chain.append('clean', 'Trim whitespace in "name".',
    buildBlameDetail({ rule: 'trim', columns: ['name'], affectedCount: 4, predicate: '"name" != TRIM("name")' }));
  await chain.append('merge', 'Merged "N.Y." → "NY" in "state".',
    buildBlameDetail({ rule: 'merge', columns: ['state'], affectedCount: 7, before: 'N.Y.', after: 'NY' }));
  // A second transform on an already-touched column ("los"):
  await chain.append('clean', 'Convert to absolute value in "los".',
    buildBlameDetail({ rule: 'abs_value', columns: ['los'], affectedCount: 3, predicate: '"los" < 0' }));
  return chain.getTrail();
}

async function main() {
  // ============================================================
  // 1) buildBlameDetail — normalized detail shape
  // ============================================================
  const detail = buildBlameDetail({ rule: 'fill_mean', columns: ['los'], affectedCount: 12, predicate: '"los" IS NULL' });
  ok(Array.isArray(detail.columns) && detail.columns[0] === 'los', 'buildBlameDetail: keeps columns as an array');
  ok(detail.rule === 'fill_mean', 'buildBlameDetail: records the transform rule');
  ok(detail.affected && detail.affected.count === 12 && detail.affected.predicate === '"los" IS NULL',
    'buildBlameDetail: records affected count + predicate');
  const single = buildBlameDetail({ rule: 'trim', column: 'name', affectedCount: 1 });
  ok(single.columns.length === 1 && single.columns[0] === 'name',
    'buildBlameDetail: accepts a single `column` and normalizes to `columns`');

  // ============================================================
  // 2) normalizeBlameEntry — new shape + legacy {fixType, column}
  // ============================================================
  const trail = await buildSampleTrail();
  const meanStep = trail.find(s => s.detail && s.detail.rule === 'fill_mean');
  const n = normalizeBlameEntry(meanStep);
  ok(n.columns[0] === 'los' && n.rule === 'fill_mean' && n.affectedCount === 12,
    'normalizeBlameEntry: reads a new-shape blame step');
  ok(typeof n.ts === 'number' && typeof n.hash === 'string' && n.index === meanStep.index,
    'normalizeBlameEntry: carries provenance identity (index/ts/hash) through');

  // Legacy detail shape still used by older recordStep call sites:
  const legacy = normalizeBlameEntry({ index: 9, op: 'clean', description: 'legacy', ts: 1, hash: 'h',
    detail: { fixType: 'fill_zero', column: 'age' } });
  ok(legacy.columns[0] === 'age' && legacy.rule === 'fill_zero',
    'normalizeBlameEntry: back-compatible with legacy {fixType, column} detail');

  // Steps with no blame detail (e.g. a bare load) normalize to empty columns.
  const loadStep = trail.find(s => s.op === 'load');
  const ln = normalizeBlameEntry(loadStep);
  ok(Array.isArray(ln.columns) && ln.columns.length === 0, 'normalizeBlameEntry: no-detail step has no columns');

  // ============================================================
  // 3) buildBlameIndex — per-column grouping, ordered
  // ============================================================
  const idx = buildBlameIndex(trail);
  ok(idx.byColumn.los && idx.byColumn.los.length === 2, 'buildBlameIndex: groups two "los" transforms together');
  ok(idx.byColumn.los[0].rule === 'fill_mean' && idx.byColumn.los[1].rule === 'abs_value',
    'buildBlameIndex: preserves chronological order within a column');
  ok(idx.byColumn.name && idx.byColumn.name.length === 1, 'buildBlameIndex: groups single-touch columns');
  ok(Object.keys(idx.byColumn).sort().join(',') === 'los,name,state',
    'buildBlameIndex: only columns that were actually changed appear');

  // ============================================================
  // 4) blameForColumn
  // ============================================================
  const losHist = blameForColumn(trail, 'los');
  ok(losHist.length === 2 && losHist.every(e => e.columns.includes('los')),
    'blameForColumn: returns every transform that touched the column');
  ok(blameForColumn(trail, 'nonexistent').length === 0, 'blameForColumn: unknown column yields empty history');

  // ============================================================
  // 5) blameForCell — column history, optionally narrowed by a row matcher
  // ============================================================
  const allLos = blameForCell(trail, 'los');
  ok(allLos.length === 2, 'blameForCell: without a matcher returns the full column history (honest superset)');
  const negOnly = blameForCell(trail, 'los', e => e.rule === 'abs_value');
  ok(negOnly.length === 1 && negOnly[0].rule === 'abs_value',
    'blameForCell: a row matcher narrows to the transforms that plausibly touched the cell');

  // ============================================================
  // 6) replayLog — the full ordered, replayable transform history
  // ============================================================
  const log = replayLog(trail);
  ok(log.length === trail.length, 'replayLog: one entry per provenance step (append-only, nothing dropped)');
  ok(log.map(e => e.index).join(',') === trail.map(s => s.index).join(','),
    'replayLog: entries stay in recorded order');
  ok(log[0].op === 'load' && log[1].rule === 'fill_mean',
    'replayLog: keeps the raw op for non-transform steps and the rule for transforms');

  // ============================================================
  // 7) summarizeColumnBlame — human-readable one-liner
  // ============================================================
  const summary = summarizeColumnBlame(trail, 'los');
  ok(/los/.test(summary) && /2/.test(summary), 'summarizeColumnBlame: names the column and its change count');
  ok(/no recorded changes/i.test(summarizeColumnBlame(trail, 'ghost')),
    'summarizeColumnBlame: unchanged column is stated plainly');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
