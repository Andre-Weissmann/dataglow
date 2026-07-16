// ============================================================
// DATAGLOW — Tests: Fuzzy Duplicate Radar P0 identifier guard
// ============================================================
// Regresses a real, confirmed P0 bug (found 2026-07-15, Run 5
// "Portfolio-readiness" test): the Fuzzy Duplicate Radar
// (js/cleaning/fuzzy-dedup.js) judged values by pure string similarity with
// no awareness that a column might be a unique identifier (patient_id,
// claim_id, ...). Live observation: digit-permutation identifiers like
// "CLM100001" vs "CLM100010" produced 98%-confidence "Merge →" suggestions.
//
// A near-identical guard was fixed in the sibling module
// js/validation/categorical-consistency.js on 2026-07-12 (PR #198) but was
// never ported here — this is the second, previously-unpatched code path
// the same bug class lived in. Both modules now import the shared guard
// from js/shared/identifier-columns.js.
//
// This suite proves the fix from three angles:
//   1. findFuzzyDuplicates never returns pairs for an identifier-like column
//      passed explicitly via options.column — even though the raw values
//      ARE textually close enough that the pure similarity() function alone
//      would have matched them.
//   2. pickBestTextColumn (the auto-select path) never defaults onto an
//      identifier-like column, even if it happens to also look name-like.
//   3. A genuine non-identifier free-text column (patient names) is
//      completely unaffected by the guard — this radar's own pre-existing
//      catch-rate benchmark (fuzzy-dedup-patients.test.mjs) already proves
//      100% recall there; this suite only re-confirms the guard doesn't
//      regress that path.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/fuzzy-dedup-identifier-guard.test.mjs

import assert from 'node:assert/strict';
import { createTableFromObjects, getTableSchema } from './node-duckdb-engine.mjs';
import { findFuzzyDuplicates, similarity } from '../js/cleaning/fuzzy-dedup.js';
import { isLikelyIdentifierColumn } from '../js/shared/identifier-columns.js';

let pass = 0, fail = 0;
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
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

async function main() {
  console.log('Fuzzy Duplicate Radar — P0 identifier guard\n');

  test('similarity() alone (no column-awareness) DOES rate close unique IDs as near-duplicates — proves the guard is load-bearing', () => {
    const score = similarity('CLM100001', 'CLM100010');
    assert.ok(score > 0.85, `pure similarity scores these two distinct claim IDs at ${score}, above the radar's own 0.85 default threshold`);
  });

  // 12 rows, only 8 distinct patient_name values (Elizabeth Warren, Michael
  // Chen, and Priya Patel each repeated) — keeps patient_name's own
  // distinct/non-null ratio safely below the 0.9 near-unique threshold, so
  // this table exercises the SAME guard on two columns with genuinely
  // different cardinality profiles: claim_id (every value unique, tripped by
  // both the name-pattern AND the cardinality guard) vs. patient_name (real
  // spelling-variant column, tripped by neither).
  await createTableFromObjects('t_claims_guard', [
    { claim_id: 'CLM100001', patient_name: 'Jonathan Meyer' },
    { claim_id: 'CLM100010', patient_name: 'Jonathan Meyar' }, // real near-dup name, one digit off claim_id
    { claim_id: 'CLM101000', patient_name: 'Sarah Connor' },
    { claim_id: 'CLM100002', patient_name: 'Sarha Connor' },
    { claim_id: 'CLM100020', patient_name: 'Elizabeth Warren' },
    { claim_id: 'CLM100021', patient_name: 'Elizabeth Warren' },
    { claim_id: 'CLM100022', patient_name: 'Michael Chen' },
    { claim_id: 'CLM100023', patient_name: 'Michael Chen' },
    { claim_id: 'CLM100024', patient_name: 'Michael Chen' },
    { claim_id: 'CLM100025', patient_name: 'Priya Patel' },
    { claim_id: 'CLM100026', patient_name: 'Priya Patel' },
    { claim_id: 'CLM100027', patient_name: 'David Kim' },
  ]);
  const cols = (await getTableSchema('t_claims_guard')).map(s => ({ name: s.column_name, type: s.column_type }));

  await testAsync('findFuzzyDuplicates: never returns pairs for claim_id, even though the raw values are textually near-identical (the exact reported bug)', async () => {
    const result = await findFuzzyDuplicates('t_claims_guard', cols, { column: 'claim_id' });
    assert.deepEqual(result.pairs, [], 'claim_id must never produce a fuzzy-match pair (P0 fix)');
    assert.ok(result.warning && /unique-identifier/.test(result.warning), 'a clear warning explains why the column was skipped');
  });

  await testAsync('findFuzzyDuplicates: a genuine non-identifier free-text column (patient_name) is completely unaffected by the guard', async () => {
    const result = await findFuzzyDuplicates('t_claims_guard', cols, { column: 'patient_name' });
    assert.ok(result.pairs.length >= 2, 'patient_name should still surface its real near-duplicate name pairs');
  });

  await testAsync('findFuzzyDuplicates: pickBestTextColumn auto-select never defaults onto an identifier-like column', async () => {
    await createTableFromObjects('t_id_named_like_name', [
      { customer_id: 'CUST-9001', notes: 'first purchase' },
      { customer_id: 'CUST-9002', notes: 'first purchase' },
    ]);
    const idCols = (await getTableSchema('t_id_named_like_name')).map(s => ({ name: s.column_name, type: s.column_type }));
    // customer_id matches the radar's own "name-like" preference regex
    // (contains "customer") AND is identifier-like — the guard must win.
    const result = await findFuzzyDuplicates('t_id_named_like_name', idCols); // no options.column — exercises auto-select
    assert.notEqual(result.column, 'customer_id', 'auto-select must skip the identifier-like column even though it matches the name-like preference');
  });

  await testAsync('findFuzzyDuplicates: options.skipIdentifierGuard escape hatch still allows the old (unguarded) behavior for explicit opt-in callers', async () => {
    const unguarded = await findFuzzyDuplicates('t_claims_guard', cols, { column: 'claim_id', skipIdentifierGuard: true });
    assert.ok(unguarded.pairs.length >= 1, 'the escape hatch preserves the previous behavior when a caller explicitly opts out of the guard');
  });

  test('sanity check: claim_id and customer_id both match the shared name-pattern guard directly', () => {
    assert.equal(isLikelyIdentifierColumn('claim_id'), true);
    assert.equal(isLikelyIdentifierColumn('customer_id'), true);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
