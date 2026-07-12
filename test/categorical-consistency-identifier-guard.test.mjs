// ============================================================
// DATAGLOW — Tests: Categorical Consistency Engine P0 identifier guard
// ============================================================
// Regresses a real, confirmed P0 bug: the Categorical Consistency Engine's
// fuzzy clustering (js/validation/categorical-consistency.js) judged column
// values by pure string similarity with no awareness that a column might be
// a unique identifier (patient_id, claim_id, ...). On such columns, two
// unrelated IDs that happen to be textually close could be clustered and,
// via the UI's "Apply Merge" action, silently rewritten to the same value —
// a real data-corruption risk, not a cosmetic false positive.
//
// This suite proves the fix from both angles:
//   1. The two pure guard functions (isLikelyIdentifierColumn / isNearUniqueColumn)
//      behave correctly in isolation, including on the exact column names
//      named in the bug report (patient_id, claim_id).
//   2. detectColumnClusters (the real, DuckDB-backed entry point the app
//      calls) never returns a cluster for a unique-ID column — even when the
//      values ARE textually close enough that clusterValues() alone would
//      have grouped them — while a genuine categorical spelling-variant
//      column (admission_type-style) is completely unaffected.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/categorical-consistency-identifier-guard.test.mjs
//
// Mirrors mimic-bugfixes.test.mjs's exact harness convention: import the
// real DuckDB backend directly from node-duckdb-engine.mjs (not through the
// browser-only js/app-shell/duckdb-engine.js) and pass a minimal
// `{ runQuery }` object as the `engine` argument detectColumnClusters expects.

import assert from 'node:assert/strict';
import { createTableFromObjects, runQuery } from './node-duckdb-engine.mjs';
import {
  isLikelyIdentifierColumn,
  isNearUniqueColumn,
  clusterValues,
  detectColumnClusters,
} from '../js/validation/categorical-consistency.js';

const engineLike = { runQuery };

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    const r = fn();
    pass++;
    console.log(`  ok - ${name}`);
    return r;
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

async function main() {
  console.log('Categorical Consistency Engine — P0 identifier guard\n');

  // ---------- Part 1: pure guard functions ----------

  test('isLikelyIdentifierColumn: matches the exact bug-report columns (patient_id, claim_id)', () => {
    assert.equal(isLikelyIdentifierColumn('patient_id'), true);
    assert.equal(isLikelyIdentifierColumn('claim_id'), true);
  });

  test('isLikelyIdentifierColumn: matches the wider business-key convention (bare id/key/code, _key/_code/_no/_num/_number suffixes)', () => {
    assert.equal(isLikelyIdentifierColumn('id'), true);
    assert.equal(isLikelyIdentifierColumn('key'), true);
    assert.equal(isLikelyIdentifierColumn('code'), true);
    assert.equal(isLikelyIdentifierColumn('member_key'), true);
    assert.equal(isLikelyIdentifierColumn('payer_code'), true);
    assert.equal(isLikelyIdentifierColumn('invoice_no'), true);
    assert.equal(isLikelyIdentifierColumn('claim_num'), true);
    assert.equal(isLikelyIdentifierColumn('account_number'), true);
  });

  test('isLikelyIdentifierColumn: does NOT match real categorical/free-text columns', () => {
    assert.equal(isLikelyIdentifierColumn('admission_type'), false);
    assert.equal(isLikelyIdentifierColumn('race'), false);
    assert.equal(isLikelyIdentifierColumn('diagnosis_description'), false);
    assert.equal(isLikelyIdentifierColumn('notes'), false);
  });

  test('isNearUniqueColumn: flags a column whose distinct count is ~ its row count (unique-key signature)', () => {
    assert.equal(isNearUniqueColumn(19, 20), true);
    assert.equal(isNearUniqueColumn(20, 20), true);
  });

  test('isNearUniqueColumn: does NOT flag a genuine bounded-vocabulary categorical', () => {
    assert.equal(isNearUniqueColumn(2, 20), false);
    assert.equal(isNearUniqueColumn(5, 500), false);
  });

  test('isNearUniqueColumn: zero/empty input never divides by zero or false-positives', () => {
    assert.equal(isNearUniqueColumn(0, 0), false);
    assert.equal(isNearUniqueColumn(5, 0), false);
  });

  // ---------- Part 2: clusterValues alone WOULD group close unique IDs ----------
  // This proves the guard is necessary — without it, similarity-only
  // clustering really would merge two unrelated identifiers.

  test('clusterValues alone (no column-awareness) DOES cluster textually-close unique IDs — proves the guard is load-bearing', () => {
    const idLikeValues = [
      { value: 'PT-100234', n: 1 },
      { value: 'PT-100235', n: 1 }, // one digit off a real, different ID
    ];
    const clusters = clusterValues(idLikeValues, 0.9);
    assert.ok(clusters.length >= 1, 'similarity-only clustering groups these two distinct IDs together');
  });

  // ---------- Part 3: detectColumnClusters (the real, wired entry point) ----------

  await testAsync('detectColumnClusters: never clusters a patient_id column, even when values are textually near-identical', async () => {
    await createTableFromObjects('t_patient_ids', [
      { patient_id: 'PT-100234', claim_id: 'CLM-9001', admission_type: 'ELECTIVE' },
      { patient_id: 'PT-100235', claim_id: 'CLM-9002', admission_type: 'ELECTIVE' }, // one digit off PT-100234
      { patient_id: 'PT-100236', claim_id: 'CLM-9003', admission_type: 'ELECTIVEE' }, // typo, real cluster target
      { patient_id: 'PT-100237', claim_id: 'CLM-9004', admission_type: 'ELECTIVE' },
    ]);
    const patientClusters = await detectColumnClusters('t_patient_ids', 'patient_id', engineLike);
    assert.deepEqual(patientClusters, [], 'patient_id must never produce a cluster (P0 fix)');
  });

  await testAsync('detectColumnClusters: never clusters a claim_id column, even when values are textually near-identical', async () => {
    const claimClusters = await detectColumnClusters('t_patient_ids', 'claim_id', engineLike);
    assert.deepEqual(claimClusters, [], 'claim_id must never produce a cluster (P0 fix)');
  });

  await testAsync('detectColumnClusters: a genuine non-identifier categorical column is completely unaffected by the guard', async () => {
    const admitClusters = await detectColumnClusters('t_patient_ids', 'admission_type', engineLike);
    assert.ok(admitClusters.length >= 1, 'admission_type should still surface its real ELECTIVE/ELECTIVEE spelling-variant cluster');
    assert.equal(admitClusters[0].canonical, 'ELECTIVE');
  });

  await testAsync('detectColumnClusters: a near-unique column that does NOT match the name pattern is still caught by the cardinality guard', async () => {
    await createTableFromObjects('t_unnamed_unique', [
      { record_ref: 'AX9910234' },
      { record_ref: 'AX9910235' }, // one char off, but every row is still effectively unique
      { record_ref: 'AX9910236' },
      { record_ref: 'AX9910237' },
    ]);
    // "record_ref" does not match the IDENTIFIER_COLUMN_NAME pattern, so this
    // exercises the cardinality-ratio guard specifically, not the name guard.
    assert.equal(isLikelyIdentifierColumn('record_ref'), false, 'sanity check: name guard genuinely does not fire here');
    const clusters = await detectColumnClusters('t_unnamed_unique', 'record_ref', engineLike);
    assert.deepEqual(clusters, [], 'a column that is near-unique by measured cardinality is guarded even without a matching name');
  });

  await testAsync('detectColumnClusters: options.skipIdentifierGuard escape hatch still allows the old (unguarded) behavior for explicit opt-in callers', async () => {
    const unguarded = await detectColumnClusters('t_patient_ids', 'patient_id', engineLike, { skipIdentifierGuard: true, threshold: 0.85 });
    assert.ok(unguarded.length >= 1, 'the escape hatch preserves the previous behavior when a caller explicitly opts out of the guard');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
