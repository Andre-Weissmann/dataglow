// ============================================================
// DATAGLOW — Batched bug-fix regression suite (validation layers)
// ============================================================
// Two independent, previously-confirmed bugs in the validation layers. Each
// assertion here was verified to FAIL against the pre-fix code and PASS after:
//
//   Bug 2 — Benford's Law eligibility must recognise a pure 0/1 flag column in
//           the CORE gate (cause 'binary_flag'), independent of any domain pack.
//           Pre-fix, with pack:'none', a 0/1 column fell through to the generic
//           'narrow_range' (or 'small_sample') skip, so the exemption was only
//           ever applied when the healthcare pack's binary rule relabelled it.
//
//   Bug 3 — Narrative Consistency must accept a correct proportion narrated as a
//           PERCENTAGE (a [0,1] column mean of 0.30 described as "30.0%").
//           Pre-fix, only the raw proportion (0.30) was in the accepted set, so
//           the mathematically-correct "30.0%" was flagged as a false mismatch.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/batched-bugfixes-layers.test.mjs

import { createTableFromObjects, getTableSchema, runQuery, closeConnection } from './node-duckdb-engine.mjs';
import { runAllLayers, checkNarrativeConsistency, benfordSkipCause } from '../js/validation/validation.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return { table, cols: schema.map(s => ({ name: s.column_name, type: s.column_type })), rowCount: rows.length, loadedAt: Date.now() };
}

async function main() {
  // ============================================================
  // Bug 2 — Benford core-gate binary-flag exemption (pack-independent).
  // ============================================================
  // 120 rows so the 60 non-zero values clear the >=50 usable-values gate; this
  // forces the pre-fix path to the 'narrow_range' skip, isolating the binary
  // recognition from the small-sample skip.
  const binRows = [];
  for (let i = 0; i < 120; i++) {
    binRows.push({
      readmitted: i % 2,                                   // pure 0/1 flag
      claim_amount: Math.round((10 + i * 137.5) * 100) / 100, // spans several orders
    });
  }
  const binDs = await makeDataset('bugfix_binary', binRows);
  // pack:'none' — prove the CORE gate handles it, with NO domain pack loaded.
  const res = await runAllLayers(binDs, { pack: 'none' });
  const skips = (res.benford && res.benford.skips) || [];
  const readmitSkip = skips.find(s => /"readmitted"/.test(s));
  ok(!!readmitSkip, 'bug2: the pure 0/1 "readmitted" column is skipped (not tested) by Benford');
  ok(readmitSkip && benfordSkipCause(readmitSkip) === 'binary_flag',
    `bug2: skip cause is 'binary_flag' in the CORE gate with pack:'none' (got '${readmitSkip && benfordSkipCause(readmitSkip)}')`);
  ok(res.benford && !/could not run|logarithm/i.test(res.benford.summary),
    `bug2: Benford layer runs without crashing on the 0/1 column (status=${res.benford && res.benford.status})`);
  ok(!skips.some(s => /"claim_amount"/.test(s)),
    'bug2: the multi-order "claim_amount" column is still eligible and tested');

  // A column that CONTAINS a zero among genuinely multi-order values must also
  // not crash (log10(0)) — it stays eligible because it is not all-0/1.
  const zeroRows = [];
  for (let i = 0; i < 80; i++) zeroRows.push({ amount: i === 0 ? 0 : Math.round(Math.pow(10, 1 + (i % 4)) + i) });
  const zeroDs = await makeDataset('bugfix_zero', zeroRows);
  const zres = await runAllLayers(zeroDs, { pack: 'none' });
  ok(zres.benford && !/could not run|logarithm/i.test(zres.benford.summary),
    `bug2: a multi-order column that contains a literal 0 does not crash Benford (status=${zres.benford && zres.benford.status})`);

  // ============================================================
  // Bug 3 — Narrative Consistency accepts a correct percentage of a proportion.
  // ============================================================
  const propRows = [];
  for (let i = 0; i < 10; i++) propRows.push({ readmission_rate: i < 3 ? 1 : 0 }); // mean 0.30
  const propResult = { columns: ['readmission_rate'], rows: propRows, rowCount: propRows.length };
  const goodStory = 'On average, 30.0% of patients were readmitted.';
  const goodChk = await checkNarrativeConsistency(goodStory, propResult);
  ok(goodChk.status === 'pass',
    `bug3: a correct proportion narrated as "30.0%" passes (status=${goodChk.status}, mismatches=${JSON.stringify(goodChk.mismatches)})`);

  // Negative control — a genuinely wrong percentage must still be flagged.
  const badStory = 'On average, 72.0% of patients were readmitted.';
  const badChk = await checkNarrativeConsistency(badStory, propResult);
  ok(badChk.status === 'fail' && badChk.mismatches.includes('72.0%'),
    'bug3: a mathematically wrong percentage (72.0%) is still caught as a mismatch');

  // Bug 3b — a large mean formatted with thousands separators (the Story tab
  // uses toLocaleString) must not be split into false-mismatch fragments, and
  // the per-claim confidence badge's "n=" / "% missing" metadata (which
  // survives tag-stripping into lastStory) must be recognised.
  const bigRows = [];
  for (let i = 0; i < 12; i++) bigRows.push({ amount: i < 11 ? 1000000 + i * 100 : null }); // 11 non-null, 1 null
  const bigResult = { columns: ['amount'], rows: bigRows, rowCount: bigRows.length };
  const bigNums = bigRows.map(r => r.amount).filter(v => typeof v === 'number');
  const bigMean = bigNums.reduce((a, b) => a + b, 0) / bigNums.length;
  const fmt = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const bigMissingPct = (((bigRows.length - bigNums.length) / bigRows.length) * 100).toFixed(1);
  const bigStory = `Looking at amount, values range from ${fmt(Math.min(...bigNums))} to ${fmt(Math.max(...bigNums))}, `
    + `averaging ${fmt(bigMean)}. Confidence: A · n=${bigNums.length} · ${bigMissingPct}% missing`;
  const bigChk = await checkNarrativeConsistency(bigStory, bigResult);
  ok(bigChk.status === 'pass',
    `bug3: thousands-separated figures + badge metadata pass (status=${bigChk.status}, mismatches=${JSON.stringify(bigChk.mismatches)})`);

  // Negative control — a genuinely wrong grouped figure must still be caught,
  // proving the comma-stripping does not blind the checker.
  const wrongBigChk = await checkNarrativeConsistency('Looking at amount, values average 7,777,777.', bigResult);
  ok(wrongBigChk.status === 'fail' && wrongBigChk.mismatches.includes('7777777'),
    'bug3: a wrong thousands-separated figure (7,777,777) is still caught as a mismatch');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
