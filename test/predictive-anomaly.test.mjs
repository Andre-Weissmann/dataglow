// ============================================================
// DATAGLOW — Predictive Anomaly Scoring test suite
// ============================================================
// Verifies the holistic kNN/Gower outlier detector end-to-end against a REAL
// (native) DuckDB engine, covering:
//   1. Scoring math — an injected multi-column / mixed-type outlier is flagged
//      as the top anomaly, while ordinary rows are not.
//   2. Feature attribution / explainability — the offending features dominate
//      the flagged row's contribution breakdown, with a plain-language reason.
//   3. Feature selection — identifier-like (near-unique) columns are excluded;
//      numeric + low-cardinality categorical columns are kept.
//   4. Size guard / sampling — a table above the cap is uniformly down-sampled
//      to the cap and the sampling is disclosed (and deterministic per seed).
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/predictive-anomaly.test.mjs
//
// The production module imports '../js/duckdb-engine.js'; the loader hook
// transparently redirects that to the native node-duckdb-engine.mjs.

import { createTableFromObjects, getTableSchema, runQuery, closeConnection } from './node-duckdb-engine.mjs';
import { scorePredictiveAnomalies, selectFeatures, describeAnomaly, MAX_ROWS } from '../js/predictive-anomaly.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return { table, cols: schema.map(s => ({ name: s.column_name, type: s.column_type })), rowCount: rows.length };
}

async function main() {
  const engine = { runQuery };

  // ============================================================
  // 1 + 2 — Holistic outlier detection + explainability
  // ============================================================
  // A "normal shape": young adults, short stays, region A/B, small amounts. The
  // injected row (index 40) has an amount and a region that, in COMBINATION with
  // its neighbours, are unlike anything else in the table.
  const rows = [];
  for (let i = 0; i < 80; i++) {
    rows.push({
      user_id: 1000 + i,                             // numeric feature
      age: 25 + (i % 20),                            // 25..44
      amount: 100 + (i % 25),                        // ~100..124
      region: (i % 2 === 0) ? 'A' : 'B',             // low-cardinality categorical
      note_ref: `REF-${i}-${(i * 7919) % 100000}`,   // near-unique identifier text → excluded
    });
  }
  // Injected holistic anomaly: a very high amount + a rare region 'Z'.
  rows[40] = { user_id: 9999, age: 30, amount: 5000, region: 'Z', note_ref: 'REF-40-outlier' };

  const ds = await makeDataset('pred_anom', rows);

  const feats = await selectFeatures(ds.table, ds.cols, engine, { rowCount: ds.rowCount });
  ok(feats.numeric.includes('age') && feats.numeric.includes('amount'), 'feature-select: keeps numeric feature columns (age, amount)');
  ok(feats.categorical.includes('region'), 'feature-select: keeps low-cardinality categorical (region)');
  ok(!feats.categorical.includes('note_ref'), 'feature-select: excludes the near-unique identifier-like text column (note_ref)');

  const res = await scorePredictiveAnomalies(ds.table, ds.cols, engine, { rowCount: ds.rowCount });
  ok(res.rows.length === rows.length, `scoring: every row scored (${res.rows.length}/${rows.length})`);
  ok(res.rows[0].rowIndex === 40, `scoring: the injected holistic outlier (row 40) is the top-ranked anomaly (got #${res.rows[0].rowIndex})`);
  ok(res.rows[0].isAnomaly === true, 'scoring: the injected outlier is flagged (exceeds mean+3σ threshold)');

  const flaggedCount = res.rows.filter(r => r.isAnomaly).length;
  ok(flaggedCount >= 1 && flaggedCount <= 5, `scoring: only a small number of rows flagged (${flaggedCount}), not the whole table`);

  // Attribution: amount and/or region should dominate the flagged row.
  const top = res.rows[0];
  const topFeatures = top.contributions.slice(0, 2).map(c => c.feature);
  ok(topFeatures.includes('amount') || topFeatures.includes('region'),
    `attribution: offending features dominate the flag (top: ${topFeatures.join(', ')})`);
  const contribSum = top.contributions.reduce((s, c) => s + c.contribution, 0);
  ok(contribSum > 0.99 && contribSum < 1.01, `attribution: contributions form a normalized share (sum ≈ 1, got ${contribSum.toFixed(3)})`);
  ok(typeof top.reason === 'string' && top.reason.includes(`#${top.rowIndex}`),
    `attribution: plain-language reason references the row ("${top.reason}")`);

  const standalone = describeAnomaly(top);
  ok(standalone === top.reason, 'attribution: describeAnomaly() is a pure function matching the stored reason');

  const normal = res.rows.find(r => r.rowIndex !== 40);
  ok(normal.rawScore < top.rawScore, 'scoring: an ordinary row scores lower than the injected outlier');

  // ============================================================
  // 3 — Guard: too few features returns a graceful note
  // ============================================================
  const flatRows = Array.from({ length: 20 }, (_, i) => ({ only: i }));
  const flatDs = await makeDataset('pred_flat', flatRows);
  const flatRes = await scorePredictiveAnomalies(flatDs.table, flatDs.cols, engine, { rowCount: flatRows.length });
  ok(flatRes.rows.length === 0 && typeof flatRes.note === 'string', 'guard: a single-feature table returns no scores with an explanatory note');

  // ============================================================
  // 4 — Size guard / sampling
  // ============================================================
  const bigN = MAX_ROWS + 500;
  const big = [];
  for (let i = 0; i < bigN; i++) {
    big.push({ a: (i % 50), b: 100 + (i % 30), grp: (i % 3 === 0) ? 'X' : 'Y' });
  }
  const bigDs = await makeDataset('pred_big', big);
  const cap = 300; // small explicit cap to keep the O(n²) test fast
  const bigRes = await scorePredictiveAnomalies(bigDs.table, bigDs.cols, engine, { rowCount: bigN, maxRows: cap, seed: 42 });
  ok(bigRes.sampling && bigRes.sampling.sampled === true, 'size-guard: a table above the cap is sampled');
  ok(bigRes.sampling.totalRows === bigN, `size-guard: total row count is reported (${bigRes.sampling.totalRows})`);
  ok(bigRes.sampling.usedRows === cap, `size-guard: working set is capped at maxRows (${bigRes.sampling.usedRows}/${cap})`);
  ok(bigRes.rows.length === cap, 'size-guard: only the sampled rows are scored');

  ok(res.sampling && res.sampling.sampled === false, `size-guard: a small table is not sampled (used ${res.sampling.usedRows} of ${res.sampling.totalRows})`);

  const bigRes2 = await scorePredictiveAnomalies(bigDs.table, bigDs.cols, engine, { rowCount: bigN, maxRows: cap, seed: 42 });
  const idx1 = bigRes.rows.map(r => r.rowIndex).sort((a, b) => a - b).join(',');
  const idx2 = bigRes2.rows.map(r => r.rowIndex).sort((a, b) => a - b).join(',');
  ok(idx1 === idx2, 'size-guard: sampling is deterministic for a fixed seed');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
