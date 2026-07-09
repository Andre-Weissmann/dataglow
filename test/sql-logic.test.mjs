// ============================================================
// DATAGLOW — Node-side SQL logic test suite
// ============================================================
// Exercises the SQL-generating production modules (imputation.js,
// format-fingerprint.js, validation.js) against a REAL DuckDB engine —
// but the native @duckdb/node-api one instead of the browser Worker/WASM
// engine. The production files are imported byte-for-byte unmodified; the
// loader hook (duckdb-loader-hook.mjs) transparently redirects their
// `import '../js/duckdb-engine.js'` to node-duckdb-engine.mjs.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/sql-logic.test.mjs
//
// The test setup helpers (createTableFromObjects/closeConnection) are imported
// from node-duckdb-engine.mjs directly — they are NOT part of the production
// interface, so they bypass the hook.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';

// Production modules under test — resolved through the loader hook.
import { buildGroupedImputationSQL, previewGroupedImputation } from '../js/cleaning/imputation.js';
import { scanFormatIssues } from '../js/cleaning/format-fingerprint.js';
import { runAllLayers } from '../js/validation/validation.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else {
    failed++;
    console.log(`✗ FAILED: ${msg}`);
  }
}

// Build a ds = { table, cols, rowCount } from an array of row objects, the
// same shape validation.runAllLayers expects (cols = [{name, type}]).
async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return {
    table,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    rowCount: rows.length,
  };
}

// ============================================================
async function testImputation() {
  // Numeric column `score` with nulls; categorical group-by `grp`.
  // Group A non-null values: 10, 20  -> mean 15
  // Group B non-null values: 100, 200, 300 -> mean 200
  const rows = [
    { grp: 'A', score: 10 },
    { grp: 'A', score: 20 },
    { grp: 'A', score: null },   // should be filled with 15
    { grp: 'B', score: 100 },
    { grp: 'B', score: 200 },
    { grp: 'B', score: 300 },
    { grp: 'B', score: null },   // should be filled with 200
  ];
  await makeDataset('imp_t', rows);

  const sql = buildGroupedImputationSQL('imp_t', 'score', ['grp']);
  ok(/WITH group_means AS/.test(sql) && /COALESCE/.test(sql), 'imputation: generated SQL has the expected CTE + COALESCE structure');

  const preview = await previewGroupedImputation('imp_t', 'score', ['grp']);
  ok(preview.nullCount === 2, `imputation: detected 2 null(s) to fill (got ${preview.nullCount})`);
  ok(preview.wouldFill === 2, `imputation: would fill 2 null(s) (got ${preview.wouldFill})`);
  ok(preview.remainingNulls === 0, `imputation: 0 nulls remain after fill (got ${preview.remainingNulls})`);

  const bySample = new Map(preview.sample.map(r => [r.grp, r.after_value]));
  ok(Math.abs(bySample.get('A') - 15) < 1e-9, `imputation: group A null filled with group mean 15 (got ${bySample.get('A')})`);
  ok(Math.abs(bySample.get('B') - 200) < 1e-9, `imputation: group B null filled with group mean 200 (got ${bySample.get('B')})`);
}

// ============================================================
async function testFormatFingerprint() {
  // Column `amount` is currency-contaminated numeric text; column `dt` has
  // mixed date formats (ISO and US MM/DD/YYYY).
  const rows = [
    { amount: '$1,200.50', dt: '2024-01-15' },
    { amount: '$3,400.00', dt: '01/15/2024' },
    { amount: '$25.99', dt: '2024-02-20' },
    { amount: '$1,000.00', dt: '03/22/2024' },
    { amount: '$99.00', dt: '2024-04-01' },
  ];
  const ds = await makeDataset('fmt_t', rows);

  const issues = await scanFormatIssues(ds.table, ds.cols);
  const types = new Set(issues.map(i => i.issueType));
  ok(types.has('currency_contaminated'), `format: detected currency contamination in "amount" (types: ${[...types].join(', ')})`);
  ok(types.has('mixed_date_format'), `format: detected mixed date formats in "dt" (types: ${[...types].join(', ')})`);

  const currencyIssue = issues.find(i => i.issueType === 'currency_contaminated');
  ok(currencyIssue && /TRY_CAST/.test(currencyIssue.suggestedFixSQL), 'format: currency issue includes a suggested TRY_CAST fix SQL');
}

// ============================================================
async function testOutlierDetection() {
  // ~40 tightly clustered normal values around 50, plus 2 blatant outliers.
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ id: i + 1, measure: 50 + (i % 5) });
  rows.push({ id: 100, measure: 5000 });   // extreme high outlier
  rows.push({ id: 101, measure: -3000 });  // extreme low outlier
  const ds = await makeDataset('out_t', rows);

  const results = await runAllLayers(ds);
  const outlier = results.outlier_detection;
  ok(outlier && outlier.status === 'warn', `outlier: flagged outliers (status=${outlier && outlier.status})`);
  const detailStr = JSON.stringify(outlier && outlier.detail || '');
  ok(/measure/.test(detailStr), `outlier: "measure" column reported in findings`);
}

// ============================================================
async function testBenford() {
  // Conforming: construct a dataset whose leading-digit frequencies match the
  // Newcomb-Benford expectation exactly (deterministic, χ² ≈ 0). Values are
  // spread across several orders of magnitude (×1, ×10, ×100, ×1000) so the
  // leading digit is preserved while the layer's magnitude-spread guard is met.
  const BENFORD = [0, 0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];
  const conforming = [];
  for (let d = 1; d <= 9; d++) {
    const count = Math.round(300 * BENFORD[d]);
    for (let j = 0; j < count; j++) {
      const scale = Math.pow(10, j % 4); // 1,10,100,1000 — magnitude spread, leading digit unchanged
      conforming.push({ val: d * scale + (j % 9) / 10 });
    }
  }
  const dsConform = await makeDataset('benford_ok', conforming);
  const resConform = await runAllLayers(dsConform);

  // Non-conforming: values whose leading digit is (near-)uniformly distributed,
  // which strongly violates Benford. Use magnitudes spread across orders of
  // magnitude but with leading digits forced roughly uniform 1..9.
  const violating = [];
  for (let i = 0; i < 300; i++) {
    const lead = (i % 9) + 1;                 // cycles 1..9 uniformly
    const scale = Math.pow(10, (i % 4) + 1);  // 10 .. 10000, gives magnitude spread
    violating.push({ val: lead * scale + (i % 7) });
  }
  const dsViolate = await makeDataset('benford_bad', violating);
  const resViolate = await runAllLayers(dsViolate);

  ok(resConform.benford.status === 'pass',
    `benford: log-uniform dataset is consistent with Benford (status=${resConform.benford.status})`);
  ok(resViolate.benford.status === 'warn',
    `benford: uniform-leading-digit dataset deviates from Benford (status=${resViolate.benford.status})`);
  ok(resConform.benford.status !== resViolate.benford.status,
    'benford: status differs appropriately between conforming and violating datasets');
}

// ============================================================
async function main() {
  await testImputation();
  await testFormatFingerprint();
  await testOutlierDetection();
  await testBenford();

  await closeConnection();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
