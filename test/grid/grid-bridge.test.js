// ============================================================
// DATAGLOW — Grid Bridge test suite
// ============================================================
// Covers the full data-contract surface of js/grid/grid-bridge.js:
//   • formatRowsForGrid    — rows/columns/findings -> GridDataset shape
//   • buildColumnHealthScore — severity-weighted per-column scoring
//   • mapSeverityToStyle   — style descriptors for all four severities
//   • buildAgentDiff       — diffType detection (replace/clear/fill)
//   • applyAgentDiffs      — accepted-only application, no mutation
//
// This module never imports Univer or touches the DOM, so this suite runs
// in plain Node with no browser runtime and no DuckDB connection required.
//
// RUN WITH:  node test/grid/grid-bridge.test.js

import {
  formatRowsForGrid,
  buildColumnHealthScore,
  mapSeverityToStyle,
  buildAgentDiff,
  applyAgentDiffs,
  serializeGridDataset,
  deserializeGridDataset,
} from '../../js/grid/grid-bridge.js';

// ---------- tiny test harness (matches repo convention, e.g. expected-range.test.mjs) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function approx(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

// ============================================================
// formatRowsForGrid
// ============================================================
(function testFormatRowsForGrid() {
  const columns = [
    { name: 'id', type: 'INTEGER' },
    { name: 'amount', type: 'DOUBLE' },
  ];
  const rows = [
    { id: 1, amount: 10.5 },
    { id: 2, amount: -5 },
    { id: 3, amount: 42 },
  ];
  const findings = [
    { rowIndex: 1, columnName: 'amount', severity: 'warning', message: 'negative amount' },
  ];

  const dataset = formatRowsForGrid(rows, columns, findings);

  ok(dataset.headers.length === 2, 'formatRowsForGrid: produces one header per column');
  ok(dataset.rows.length === 3, 'formatRowsForGrid: produces one row entry per input row');

  ok(dataset.rows[0].rowSeverity === 'clean', 'formatRowsForGrid: unaffected row is clean');
  ok(dataset.rows[1].rowSeverity === 'warning', 'formatRowsForGrid: affected row picks up warning severity');
  ok(dataset.rows[2].rowSeverity === 'clean', 'formatRowsForGrid: row after the affected one stays clean');

  const amountHeader = dataset.headers.find(h => h.name === 'amount');
  ok(approx(amountHeader.healthScore, 0.9), 'formatRowsForGrid: affected column health score reduced by 0.1 for one warning row');
  ok(amountHeader.healthLabel === 'clean', 'formatRowsForGrid: 0.9 health score still labeled clean (>= 0.8 threshold)');

  const idHeader = dataset.headers.find(h => h.name === 'id');
  ok(approx(idHeader.healthScore, 1.0), 'formatRowsForGrid: unaffected column keeps health score 1.0');

  ok(dataset.stats.totalRows === 3, 'formatRowsForGrid: stats.totalRows correct');
  ok(dataset.stats.totalColumns === 2, 'formatRowsForGrid: stats.totalColumns correct');
  ok(dataset.stats.warningRows === 1, 'formatRowsForGrid: stats.warningRows === 1');
  ok(dataset.stats.errorRows === 0, 'formatRowsForGrid: stats.errorRows === 0');
  ok(dataset.stats.criticalRows === 0, 'formatRowsForGrid: stats.criticalRows === 0');

  ok(dataset.rows[0].cells.id.value === 1, 'formatRowsForGrid: cell value preserved');
  ok(dataset.rows[0].cells.id.displayValue === '1', 'formatRowsForGrid: cell displayValue stringified');

  ok(dataset.headers.find(h => h.name === 'id').typeChip === 'number', 'formatRowsForGrid: INTEGER maps to number chip');
  ok(dataset.headers.find(h => h.name === 'amount').typeChip === 'number', 'formatRowsForGrid: DOUBLE maps to number chip');

  // empty-input edge case
  const empty = formatRowsForGrid([], [], []);
  ok(empty.stats.totalRows === 0 && empty.stats.totalColumns === 0, 'formatRowsForGrid: handles empty rows/columns without throwing');
  ok(approx(empty.stats.overallHealthScore, 1.0), 'formatRowsForGrid: overallHealthScore defaults to 1.0 with no columns');
})();

// ============================================================
// buildColumnHealthScore
// ============================================================
(function testBuildColumnHealthScore() {
  const noFindings = buildColumnHealthScore('col_a', [], 10);
  ok(approx(noFindings.score, 1.0), 'buildColumnHealthScore: 0 findings -> score 1.0');
  ok(noFindings.label === 'clean', 'buildColumnHealthScore: 0 findings -> label clean');
  ok(noFindings.warningCount === 0 && noFindings.errorCount === 0 && noFindings.criticalCount === 0, 'buildColumnHealthScore: 0 findings -> zero counts');

  // 5 error findings (distinct rows) out of 50 rows: 1.0 - 5*0.2 = 0.0, floored, label 'error'
  const errorFindings = Array.from({ length: 5 }, (_, i) => ({
    rowIndex: i,
    columnName: 'col_b',
    severity: 'error',
  }));
  const errorResult = buildColumnHealthScore('col_b', errorFindings, 50);
  ok(errorResult.score < 1.0, 'buildColumnHealthScore: 5 error findings -> score < 1.0');
  ok(errorResult.label === 'error', 'buildColumnHealthScore: 5 error findings out of 50 rows -> label error');
  ok(errorResult.errorCount === 5, 'buildColumnHealthScore: errorCount matches distinct affected rows');

  // Mixed severities, and findings for other columns must be ignored.
  const mixed = [
    { rowIndex: 0, columnName: 'col_c', severity: 'warning' },
    { rowIndex: 1, columnName: 'col_c', severity: 'critical' },
    { rowIndex: 2, columnName: 'other_col', severity: 'critical' }, // must be ignored
  ];
  const mixedResult = buildColumnHealthScore('col_c', mixed, 10);
  ok(approx(mixedResult.score, 0.6), 'buildColumnHealthScore: 1 warning + 1 critical -> 1.0 - 0.1 - 0.3 = 0.6');
  ok(mixedResult.label === 'warning', 'buildColumnHealthScore: score 0.6 labeled warning (0.5 <= score < 0.8)');
  ok(mixedResult.warningCount === 1 && mixedResult.criticalCount === 1, 'buildColumnHealthScore: only same-column findings counted');

  // Duplicate findings on the same row/column should count once, not twice.
  const dupe = [
    { rowIndex: 4, columnName: 'col_d', severity: 'warning' },
    { rowIndex: 4, columnName: 'col_d', severity: 'warning' },
  ];
  const dupeResult = buildColumnHealthScore('col_d', dupe, 10);
  ok(dupeResult.warningCount === 1, 'buildColumnHealthScore: duplicate finding on same row counted once');

  // Score floor at 0.0
  const manyCritical = Array.from({ length: 10 }, (_, i) => ({ rowIndex: i, columnName: 'col_e', severity: 'critical' }));
  const floored = buildColumnHealthScore('col_e', manyCritical, 10);
  ok(floored.score === 0, 'buildColumnHealthScore: score floors at 0.0, never negative');
  ok(floored.label === 'error', 'buildColumnHealthScore: floored score labeled error');
})();

// ============================================================
// mapSeverityToStyle
// ============================================================
(function testMapSeverityToStyle() {
  const warning = mapSeverityToStyle('warning');
  ok(warning.backgroundColor === '#FFF3E0', 'mapSeverityToStyle: warning backgroundColor');
  ok(warning.borderLeft === '3px solid #964219', 'mapSeverityToStyle: warning borderLeft');

  const error = mapSeverityToStyle('error');
  ok(error.backgroundColor === '#FCE4EC', 'mapSeverityToStyle: error backgroundColor');
  ok(error.borderLeft === '3px solid #A12C7B', 'mapSeverityToStyle: error borderLeft');

  const critical = mapSeverityToStyle('critical');
  ok(critical.backgroundColor === '#FFEBEE', 'mapSeverityToStyle: critical backgroundColor');
  ok(critical.borderLeft === '3px solid #C62828', 'mapSeverityToStyle: critical borderLeft');
  ok(critical.pulse === true, 'mapSeverityToStyle: critical sets pulse true');

  const clean = mapSeverityToStyle('clean');
  ok(clean.backgroundColor === null, 'mapSeverityToStyle: clean backgroundColor null');
  ok(clean.borderLeft === null, 'mapSeverityToStyle: clean borderLeft null');

  const unknown = mapSeverityToStyle('not-a-real-severity');
  ok(unknown.backgroundColor === null && unknown.borderLeft === null, 'mapSeverityToStyle: unknown severity falls back to clean descriptor');
})();

// ============================================================
// buildAgentDiff
// ============================================================
(function testBuildAgentDiff() {
  const replaceDiff = buildAgentDiff('amount', 2, 100, 150, 'value looked like a typo vs neighboring rows');
  ok(replaceDiff.diffType === 'replace', 'buildAgentDiff: both values present -> replace');
  ok(replaceDiff.displayOriginal === '100' && replaceDiff.displayProposed === '150', 'buildAgentDiff: replace display strings correct');
  ok(replaceDiff.accepted === false && replaceDiff.dismissed === false, 'buildAgentDiff: defaults accepted/dismissed to false');

  const clearDiff = buildAgentDiff('notes', 3, 'stale comment', null, 'value no longer applies');
  ok(clearDiff.diffType === 'clear', 'buildAgentDiff: proposed null -> clear');
  ok(clearDiff.displayProposed === '', 'buildAgentDiff: clear diff has empty displayProposed');

  const clearDiffUndefined = buildAgentDiff('notes', 3, 'stale comment', undefined, 'value no longer applies');
  ok(clearDiffUndefined.diffType === 'clear', 'buildAgentDiff: proposed undefined -> clear');

  const fillDiff = buildAgentDiff('zip', 4, null, '94107', 'inferred from city+state');
  ok(fillDiff.diffType === 'fill', 'buildAgentDiff: original null -> fill');
  ok(fillDiff.displayOriginal === '', 'buildAgentDiff: fill diff has empty displayOriginal');

  const fillDiffUndefined = buildAgentDiff('zip', 4, undefined, '94107', 'inferred from city+state');
  ok(fillDiffUndefined.diffType === 'fill', 'buildAgentDiff: original undefined -> fill');

  ok(replaceDiff.reason === 'value looked like a typo vs neighboring rows', 'buildAgentDiff: reason passed through unchanged');
})();

// ============================================================
// applyAgentDiffs
// ============================================================
(function testApplyAgentDiffs() {
  const columns = [{ name: 'amount', type: 'DOUBLE' }];
  const rows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
  const original = formatRowsForGrid(rows, columns, []);

  const acceptedDiff = { ...buildAgentDiff('amount', 0, 100, 150, 'fix'), accepted: true };
  const dismissedDiff = { ...buildAgentDiff('amount', 1, 200, 999, 'bad suggestion'), dismissed: true };
  const pendingDiff = buildAgentDiff('amount', 2, 300, 350, 'not yet reviewed'); // accepted stays false

  const applied = applyAgentDiffs(original, [acceptedDiff, dismissedDiff, pendingDiff]);

  ok(applied.rows[0].cells.amount.value === 150, 'applyAgentDiffs: accepted diff applied to cell value');
  ok(applied.rows[0].cells.amount.displayValue === '150', 'applyAgentDiffs: accepted diff updates displayValue too');
  ok(applied.rows[1].cells.amount.value === 200, 'applyAgentDiffs: dismissed diff ignored');
  ok(applied.rows[2].cells.amount.value === 300, 'applyAgentDiffs: pending (not accepted) diff ignored');

  // original must be untouched
  ok(original.rows[0].cells.amount.value === 100, 'applyAgentDiffs: original GridDataset not mutated (row 0)');
  ok(original.rows[1].cells.amount.value === 200, 'applyAgentDiffs: original GridDataset not mutated (row 1)');
  ok(original.rows[2].cells.amount.value === 300, 'applyAgentDiffs: original GridDataset not mutated (row 2)');

  // deep-independence: mutating the returned dataset must not affect the original
  applied.rows[0].cells.amount.value = 'mutated';
  ok(original.rows[0].cells.amount.value === 100, 'applyAgentDiffs: returned dataset does not share cell references with original');

  // no diffs at all -> identical values, still a distinct object
  const untouched = applyAgentDiffs(original, []);
  ok(untouched !== original, 'applyAgentDiffs: always returns a new object even with no diffs');
  ok(untouched.rows[0].cells.amount.value === 100, 'applyAgentDiffs: values unchanged when no diffs supplied');
})();

// ============================================================
// serializeGridDataset / deserializeGridDataset
// ============================================================
(function testSerializeRoundTrip() {
  const columns = [{ name: 'id', type: 'INTEGER' }];
  const rows = [{ id: 1 }];
  const dataset = formatRowsForGrid(rows, columns, []);

  const json = serializeGridDataset(dataset);
  const parsed = JSON.parse(json);
  ok(parsed._v === 1, 'serializeGridDataset: stamps version field _v === 1');
  ok(parsed.rows.length === 1, 'serializeGridDataset: preserves rows through JSON.stringify');

  const roundTripped = deserializeGridDataset(json);
  ok(roundTripped.rows[0].cells.id.value === 1, 'deserializeGridDataset: round-trips cell values correctly');
  ok(roundTripped._v === 1, 'deserializeGridDataset: round-trips version field');
})();

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
