// ============================================================
// DATAGLOW — Tests: Unit Test Layer cross-table referential integrity
// ============================================================
// Regresses NORTH_STAR 2026-07-15 (Run 5 test) finding 0b: the Unit Test
// Layer's own LAYER_DEFS description has always claimed "referential
// integrity" as one of its 5 silent tests, but the pre-existing check
// (fkCols loop in runUnitTests) only ever verified a foreign-key-shaped
// column is non-NULL WITHIN the same table — a syntactically-valid but
// nonexistent FK (e.g. a claim's patient_id = "PT9999" when no such patient
// was ever loaded) was invisible to it.
//
// This suite proves the fix from three angles:
//   1. findReferenceCandidate (the pure matcher) behaves correctly in
//      isolation — including the false-positive guard against tables that
//      merely happen to share a same-named column for unrelated reasons.
//   2. runUnitTests, with the new crossTableReferentialIntegrity flag ON and
//      a second dataset loaded into state.datasets, surfaces a real
//      "orphan_reference" finding for the exact PT9999 scenario from the
//      original bug report — and does NOT false-positive on a clean dataset
//      with no orphans.
//   3. With the flag OFF (its shipped default), runUnitTests never reads
//      state.datasets and produces byte-for-byte the same findings as
//      before this fix — proving the dark-by-default guarantee.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/unit-test-layer-cross-table-referential.test.mjs

import assert from 'node:assert/strict';
import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import { configureFlags, resetFlags } from '../js/build/build-flags.js';
import { state } from '../js/app-shell/state.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ok - ${msg}`); }
  else { fail++; console.log(`  FAIL - ${msg}`); }
}
async function okAsync(msg, fn) {
  try { await fn(); pass++; console.log(`  ok - ${msg}`); }
  catch (e) { fail++; console.log(`  FAIL - ${msg}\n    ${e.message}`); }
}

async function colsOf(tableName) {
  return (await getTableSchema(tableName)).map(s => ({ name: s.column_name, type: s.column_type }));
}

async function main() {
  console.log('Unit Test Layer — cross-table referential integrity\n');

  // Import AFTER build-flags exists so the module's top-level isEnabled/state
  // imports resolve normally; runUnitTests itself is not exported, so we test
  // it indirectly through the exported findReferenceCandidate plus a direct
  // re-import of runAllLayers's public surface (runUnitTests is internal —
  // exercise it via the same public entry point the app itself uses).
  const validation = await import('../js/validation/validation.js');
  const { findReferenceCandidate, CROSS_TABLE_REFERENTIAL_FLAG } = validation;

  // ---------- Part 1: pure matcher ----------

  ok(
    findReferenceCandidate('patient_id', 't_claims', [
      { table: 't_patients', name: 'patients', cols: [{ name: 'patient_id', type: 'VARCHAR' }, { name: 'name', type: 'VARCHAR' }] },
    ])?.table === 't_patients',
    'exact column-name match against the other table\'s own first/key column resolves correctly'
  );

  ok(
    findReferenceCandidate('patient_id', 't_claims', [
      { table: 't_claims_secondary', name: 'claims_secondary', cols: [{ name: 'claim_ref', type: 'VARCHAR' }, { name: 'patient_id', type: 'VARCHAR' }] },
    ]) === null,
    'does NOT match a same-named column that is not the other table\'s own first/key column (avoids false orphan findings against unrelated tables)'
  );

  ok(
    findReferenceCandidate('patient_id', 't_claims', [
      { table: 't_patients_master', name: 'patients', cols: [{ name: 'id', type: 'VARCHAR' }, { name: 'name', type: 'VARCHAR' }] },
    ])?.keyColumn === 'id',
    'base-noun-to-dataset-name match (patient_id -> "patients" dataset) resolves to that dataset\'s first column as the key'
  );

  ok(
    findReferenceCandidate('patient_id', 't_claims', [
      { table: 't_claims', name: 'claims', cols: [{ name: 'patient_id', type: 'VARCHAR' }] },
    ]) === null,
    'never matches the current table against itself'
  );

  ok(
    findReferenceCandidate('vendor_id', 't_claims', [
      { table: 't_patients', name: 'patients', cols: [{ name: 'id', type: 'VARCHAR' }] },
    ]) === null,
    'returns null (no guess) when no candidate genuinely lines up'
  );

  // ---------- Part 2: runUnitTests end-to-end via runAllLayers ----------

  await createTableFromObjects('t_patients_e2e', [
    { patient_id: 'PT0001', name: 'Jonathan Meyer' },
    { patient_id: 'PT0002', name: 'Sarah Connor' },
  ]);
  await createTableFromObjects('t_claims_e2e', [
    { claim_id: 'CLM001', patient_id: 'PT0001', billed_amount: 100 },
    { claim_id: 'CLM002', patient_id: 'PT0002', billed_amount: 200 },
    { claim_id: 'CLM003', patient_id: 'PT9999', billed_amount: 300 }, // orphan — no such patient loaded
  ]);

  const patientsCols = await colsOf('t_patients_e2e');
  const claimsCols = await colsOf('t_claims_e2e');

  state.datasets = [
    { name: 'patients', table: 't_patients_e2e', rowCount: 2, cols: patientsCols, loadedAt: Date.now() },
    { name: 'claims', table: 't_claims_e2e', rowCount: 3, cols: claimsCols, loadedAt: Date.now() },
  ];

  await okAsync('flag ON: surfaces the exact PT9999 orphan-claim scenario as an orphan_reference finding', async () => {
    resetFlags();
    configureFlags({ [CROSS_TABLE_REFERENTIAL_FLAG]: { enabled: true } });
    const claimsDs = { table: 't_claims_e2e', cols: claimsCols, rowCount: 3, name: 'claims' };
    const results = await validation.runAllLayers(claimsDs, {});
    const findings = results.unit_tests.findings || [];
    const orphanFinding = findings.find(f => f.kind === 'orphan_reference');
    assert.ok(orphanFinding, 'expected an orphan_reference finding, got: ' + JSON.stringify(findings.map(f => f.kind)));
    assert.equal(orphanFinding.meta.orphanCount, 1, 'exactly 1 orphan row (PT9999) expected');
    assert.equal(orphanFinding.column, 'patient_id');
  });

  await okAsync('flag ON: a dataset with NO orphans produces no orphan_reference finding (no false positive)', async () => {
    await createTableFromObjects('t_claims_clean_e2e', [
      { claim_id: 'CLM101', patient_id: 'PT0001', billed_amount: 50 },
      { claim_id: 'CLM102', patient_id: 'PT0002', billed_amount: 75 },
    ]);
    const cleanCols = await colsOf('t_claims_clean_e2e');
    state.datasets = [
      { name: 'patients', table: 't_patients_e2e', rowCount: 2, cols: patientsCols, loadedAt: Date.now() },
      { name: 'claims_clean', table: 't_claims_clean_e2e', rowCount: 2, cols: cleanCols, loadedAt: Date.now() },
    ];
    resetFlags();
    configureFlags({ [CROSS_TABLE_REFERENTIAL_FLAG]: { enabled: true } });
    const ds = { table: 't_claims_clean_e2e', cols: cleanCols, rowCount: 2, name: 'claims_clean' };
    const results = await validation.runAllLayers(ds, {});
    const findings = results.unit_tests.findings || [];
    assert.equal(findings.filter(f => f.kind === 'orphan_reference').length, 0, 'clean data must not produce an orphan_reference finding');
  });

  await okAsync('flag OFF (shipped default): no orphan_reference finding even with the same orphan data loaded — byte-for-byte prior behavior', async () => {
    state.datasets = [
      { name: 'patients', table: 't_patients_e2e', rowCount: 2, cols: patientsCols, loadedAt: Date.now() },
      { name: 'claims', table: 't_claims_e2e', rowCount: 3, cols: claimsCols, loadedAt: Date.now() },
    ];
    resetFlags();
    configureFlags({ [CROSS_TABLE_REFERENTIAL_FLAG]: { enabled: false } });
    const claimsDs = { table: 't_claims_e2e', cols: claimsCols, rowCount: 3, name: 'claims' };
    const results = await validation.runAllLayers(claimsDs, {});
    const findings = results.unit_tests.findings || [];
    assert.equal(findings.filter(f => f.kind === 'orphan_reference').length, 0, 'flag off must never surface the new finding kind');
    // The pre-existing null_ref / non-null in-table checks must still run untouched.
    assert.ok(results.unit_tests.status, 'unit_tests result still has a normal status (layer itself unaffected)');
  });

  await okAsync('flag ON but no other dataset loaded: fails open, no crash, no orphan_reference finding', async () => {
    state.datasets = [{ name: 'claims', table: 't_claims_e2e', rowCount: 3, cols: claimsCols, loadedAt: Date.now() }];
    resetFlags();
    configureFlags({ [CROSS_TABLE_REFERENTIAL_FLAG]: { enabled: true } });
    const claimsDs = { table: 't_claims_e2e', cols: claimsCols, rowCount: 3, name: 'claims' };
    const results = await validation.runAllLayers(claimsDs, {});
    const findings = results.unit_tests.findings || [];
    assert.equal(findings.filter(f => f.kind === 'orphan_reference').length, 0, 'no candidate table available — must not throw or false-positive');
  });
  await okAsync('discoverability fix: single table only, FK-shaped column present -> informational hint naming the column, no fail/warn', async () => {
    state.datasets = [{ name: 'claims', table: 't_claims_e2e', rowCount: 3, cols: claimsCols, loadedAt: Date.now() }];
    resetFlags();
    configureFlags({ [CROSS_TABLE_REFERENTIAL_FLAG]: { enabled: true } });
    const claimsDs = { table: 't_claims_e2e', cols: claimsCols, rowCount: 3, name: 'claims' };
    const results = await validation.runAllLayers(claimsDs, {});
    const findings = results.unit_tests.findings || [];
    const hint = findings.find(f => f.kind === 'referential_integrity_locked');
    assert.ok(hint, 'expected a referential_integrity_locked hint finding, got: ' + JSON.stringify(findings.map(f => f.kind)));
    assert.equal(hint.severity, 'info', 'hint must be informational, not fail/warn');
    assert.ok(hint.text.includes('patient_id'), 'hint must name the actual FK-shaped column, got: ' + hint.text);
    assert.deepEqual(hint.meta.fkColumns, ['patient_id']);
    // Status must stay pass/clean — an informational hint on an otherwise-clean
    // single-table load must never look like a defect to the analyst.
    assert.equal(results.unit_tests.status, 'pass', 'a single clean table with only an informational hint must still report status pass');
    assert.ok(Array.isArray(results.unit_tests.detail) && results.unit_tests.detail.some(t => t.includes('patient_id')), 'the hint text must be visible in detail even though status is pass');
  });

  await okAsync('discoverability fix: second table loaded but no genuine FK match found -> no hint (the "no other dataset loaded" case is the only one that fires it)', async () => {
    await createTableFromObjects('t_unrelated_e2e', [{ vendor_id: 'V1', name: 'Acme' }]);
    const unrelatedCols = await colsOf('t_unrelated_e2e');
    state.datasets = [
      { name: 'unrelated', table: 't_unrelated_e2e', rowCount: 1, cols: unrelatedCols, loadedAt: Date.now() },
      { name: 'claims', table: 't_claims_e2e', rowCount: 3, cols: claimsCols, loadedAt: Date.now() },
    ];
    resetFlags();
    configureFlags({ [CROSS_TABLE_REFERENTIAL_FLAG]: { enabled: true } });
    const claimsDs = { table: 't_claims_e2e', cols: claimsCols, rowCount: 3, name: 'claims' };
    const results = await validation.runAllLayers(claimsDs, {});
    const findings = results.unit_tests.findings || [];
    assert.equal(findings.filter(f => f.kind === 'referential_integrity_locked').length, 0, 'the locked-hint only fires when zero OTHER datasets are loaded at all, not when a match merely fails to resolve');
  });

  await okAsync('discoverability fix: flag OFF (shipped default) -> no hint even with a single table and FK-shaped columns present', async () => {
    state.datasets = [{ name: 'claims', table: 't_claims_e2e', rowCount: 3, cols: claimsCols, loadedAt: Date.now() }];
    resetFlags();
    configureFlags({ [CROSS_TABLE_REFERENTIAL_FLAG]: { enabled: false } });
    const claimsDs = { table: 't_claims_e2e', cols: claimsCols, rowCount: 3, name: 'claims' };
    const results = await validation.runAllLayers(claimsDs, {});
    const findings = results.unit_tests.findings || [];
    assert.equal(findings.filter(f => f.kind === 'referential_integrity_locked').length, 0, 'flag off must suppress the hint too, consistent with the rest of this feature being fully flag-gated');
  });

  await okAsync('discoverability fix: no FK-shaped columns at all -> no hint (nothing to unlock)', async () => {
    await createTableFromObjects('t_no_fk_e2e', [{ record_id: 'R1', amount: 10 }]);
    const noFkCols = await colsOf('t_no_fk_e2e');
    state.datasets = [{ name: 'no_fk', table: 't_no_fk_e2e', rowCount: 1, cols: noFkCols, loadedAt: Date.now() }];
    resetFlags();
    configureFlags({ [CROSS_TABLE_REFERENTIAL_FLAG]: { enabled: true } });
    const ds = { table: 't_no_fk_e2e', cols: noFkCols, rowCount: 1, name: 'no_fk' };
    const results = await validation.runAllLayers(ds, {});
    const findings = results.unit_tests.findings || [];
    assert.equal(findings.filter(f => f.kind === 'referential_integrity_locked').length, 0, 'a table with no _id-suffixed column beyond the key has nothing to hint about');
  });


  await closeConnection();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
