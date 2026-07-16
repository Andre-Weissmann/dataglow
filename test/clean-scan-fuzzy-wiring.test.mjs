// ============================================================
// DATAGLOW — Tests: Clean tab "Scan for Issues" fuzzy-dedup wiring (P1 fix)
// ============================================================
// Regresses a real, confirmed P1 bug (found 2026-07-15, Run 5
// "Portfolio-readiness" test, reconfirmed independently this run): the Clean
// tab's "Scan for Issues" button (js/cleaning/clean.js scanForIssues) never
// called findFuzzyDuplicates at all — that detection only ran through the
// separate, standalone Fuzzy Duplicate Radar panel. A user who loaded
// patients.csv and only ran "Scan for Issues" saw "No issues found" despite
// 12 seeded near-duplicate patient names being present and (confirmed this
// run via fuzzy-dedup-patients.test.mjs) 100% detectable by the underlying
// module. This was a wiring/coverage gap, not an algorithm failure.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/clean-scan-fuzzy-wiring.test.mjs

import assert from 'node:assert/strict';
import { createTableFromObjects, getTableSchema } from './node-duckdb-engine.mjs';
import { scanForIssues } from '../js/cleaning/clean.js';

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

async function main() {
  console.log('Clean tab "Scan for Issues" — fuzzy-dedup wiring (P1 fix)\n');

  await createTableFromObjects('t_scan_fuzzy', [
    { patient_id: 'P0001', patient_name: 'Jonathan Meyer', city: 'Springfield' },
    { patient_id: 'P0002', patient_name: 'Jonathan Meyar', city: 'Springfield' }, // real near-dup
    { patient_id: 'P0003', patient_name: 'Sarah Connor', city: 'Springfield' },
    { patient_id: 'P0004', patient_name: 'Sarha Connor', city: 'Springfield' }, // real near-dup
    { patient_id: 'P0005', patient_name: 'Elizabeth Warren', city: 'Springfield' },
    { patient_id: 'P0006', patient_name: 'Michael Chen', city: 'Springfield' },
    { patient_id: 'P0007', patient_name: 'Priya Patel', city: 'Springfield' },
    { patient_id: 'P0008', patient_name: 'David Kim', city: 'Springfield' },
  ]);
  const cols = (await getTableSchema('t_scan_fuzzy')).map(s => ({ name: s.column_name, type: s.column_type }));

  await testAsync('scanForIssues: reproduces the exact reported bug BEFORE this fix would not have surfaced anything for a clean-looking patients table', async () => {
    // This table has no nulls, no exact-duplicate rows, no whitespace issues,
    // and no negative-amount columns — every pre-existing check in
    // scanForIssues legitimately finds nothing. Before the fix, issues.length
    // would be exactly 0 here ("No issues found"), even though 2 real
    // near-duplicate name pairs are present.
    const issues = await scanForIssues('t_scan_fuzzy', cols);
    const fuzzyIssue = issues.find(i => i.type === 'fuzzy_duplicates');
    assert.ok(fuzzyIssue, 'scanForIssues must now surface a fuzzy_duplicates issue for this dataset (P1 fix)');
    assert.equal(fuzzyIssue.column, 'patient_name', 'the fuzzy issue targets patient_name, the real near-duplicate column');
    assert.ok(fuzzyIssue.count >= 2, `expected at least 2 near-duplicate pairs, got ${fuzzyIssue.count}`);
    assert.deepEqual(fuzzyIssue.fixes, [], 'the summary issue has no one-click fix — resolving it means visiting the Fuzzy Duplicate Radar panel');
  });

  await createTableFromObjects('t_scan_clean', [
    { patient_id: 'P0001', patient_name: 'Amara Okonkwo', city: 'Springfield' },
    { patient_id: 'P0002', patient_name: 'David Goldberg', city: 'Springfield' },
    { patient_id: 'P0003', patient_name: 'Fatima Al-Sayed', city: 'Springfield' },
  ]);
  const cleanCols = (await getTableSchema('t_scan_clean')).map(s => ({ name: s.column_name, type: s.column_type }));

  await testAsync('scanForIssues: a genuinely clean dataset with no near-duplicates still reports zero issues (no false positive from the new check)', async () => {
    const issues = await scanForIssues('t_scan_clean', cleanCols);
    assert.deepEqual(issues, [], 'no fuzzy_duplicates issue (or any other) should appear for distinct, clean names');
  });

  await createTableFromObjects('t_scan_ids_only', [
    { claim_id: 'CLM100001', amount: 250 },
    { claim_id: 'CLM100010', amount: 300 }, // near-identical to CLM100001 by pure string similarity
    { claim_id: 'CLM101000', amount: 175 },
  ]);
  const idCols = (await getTableSchema('t_scan_ids_only')).map(s => ({ name: s.column_name, type: s.column_type }));

  await testAsync('scanForIssues: an identifier-only table never surfaces a fuzzy_duplicates issue (P0 guard still applies through this new call site)', async () => {
    const issues = await scanForIssues('t_scan_ids_only', idCols);
    const fuzzyIssue = issues.find(i => i.type === 'fuzzy_duplicates');
    assert.equal(fuzzyIssue, undefined, 'claim_id must never produce a fuzzy_duplicates issue via Scan for Issues either (P0 guard is shared, not bypassed by this new call site)');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
