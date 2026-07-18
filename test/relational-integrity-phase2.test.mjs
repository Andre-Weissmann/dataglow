// ============================================================
// DATAGLOW — Phase 2 Relational Integrity test suite
// ============================================================
// Covers:
//   1. Foreign key / orphan checker  (foreign-key-checker.js)
//   2. Temporal order checker         (temporal-order-checker.js)
//   3. Flag consistency checker       (flag-consistency-checker.js)
//   4. Join coverage checker          (join-coverage-checker.js)
//
// All tests use in-process DuckDB via @duckdb/node-api (same as Phase 1 tests).
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/relational-integrity-phase2.test.mjs

import * as nodeEngine from './node-duckdb-engine.mjs';
import { createTableFromObjects, closeConnection } from './node-duckdb-engine.mjs';

import {
  checkForeignKey, checkAllForeignKeys,
  FK_WARN_RATE, FK_FAIL_RATE,
} from '../js/relational/foreign-key-checker.js';

import {
  checkTemporalOrder,
  TEMPORAL_RULES,
} from '../js/relational/temporal-order-checker.js';

import {
  checkFlagConsistency,
  FLAG_RULES,
} from '../js/relational/flag-consistency-checker.js';

import {
  checkJoinCoverage, checkAllJoinCoverage,
  JOIN_WARN_RATE, JOIN_FAIL_RATE,
} from '../js/relational/join-coverage-checker.js';

// ---------- harness ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok ' + msg); }
  else       { failed++; console.error('FAIL ' + msg); }
}
function section(title) { console.log('\n-- ' + title + ' --'); }

// ---------- DuckDB engine adapter ----------
// Reuse the shared node-duckdb-engine helper used by all other Phase tests.
const engine = { runQuery: nodeEngine.runQuery };

// Convenience: createTableFromObjects handles numeric/null inference.
async function createTable(name, rows) {
  if (rows.length === 0) {
    await nodeEngine.runQuery('DROP TABLE IF EXISTS "' + name + '"');
    await nodeEngine.runQuery('CREATE TABLE "' + name + '" (dummy INTEGER)');
    return;
  }
  await createTableFromObjects(name, rows);
}

// ============================================================
// 1. Foreign key / orphan checker
// ============================================================
section('checkForeignKey — basic');

{
  // Clean: all child FK values exist in parent PK
  await createTable('patients_a', [
    { patient_id: 'P001' }, { patient_id: 'P002' }, { patient_id: 'P003' },
  ]);
  await createTable('encounters_a', [
    { encounter_id: 'E1', patient_id: 'P001' },
    { encounter_id: 'E2', patient_id: 'P002' },
    { encounter_id: 'E3', patient_id: 'P003' },
  ]);
  const r = await checkForeignKey({
    childTable: 'encounters_a', childCol: 'patient_id',
    parentTable: 'patients_a', parentCol: 'patient_id',
    engine,
  });
  ok(r.status === 'pass', 'fk clean: status pass');
  ok(r.orphanCount === 0, 'fk clean: 0 orphans');
  ok(r.orphanRate === 0, 'fk clean: rate = 0');
  ok(r.level === 'none', 'fk clean: level none');
}

{
  // One orphan out of 5 rows (20%) -> high-level fail
  await createTable('patients_b', [
    { patient_id: 'P001' }, { patient_id: 'P002' },
  ]);
  await createTable('encounters_b', [
    { patient_id: 'P001' },
    { patient_id: 'P002' },
    { patient_id: 'GHOST1' },
    { patient_id: 'GHOST2' },
    { patient_id: 'GHOST3' },
  ]);
  const r = await checkForeignKey({
    childTable: 'encounters_b', childCol: 'patient_id',
    parentTable: 'patients_b', parentCol: 'patient_id',
    engine,
  });
  ok(r.status === 'fail', 'fk orphan 60%: status fail');
  ok(r.orphanCount === 3, 'fk orphan 60%: orphanCount = 3');
  ok(r.level === 'high', 'fk orphan 60%: level high');
  ok(r.orphanSample.length > 0, 'fk orphan 60%: sample present');
}

{
  // NULL FK values not counted as orphans
  await createTable('patients_c', [{ patient_id: 'P001' }]);
  await createTable('encounters_c', [
    { patient_id: 'P001' },
    { patient_id: null },
    { patient_id: null },
  ]);
  const r = await checkForeignKey({
    childTable: 'encounters_c', childCol: 'patient_id',
    parentTable: 'patients_c', parentCol: 'patient_id',
    engine,
  });
  ok(r.status === 'pass', 'fk null not orphan: status pass');
  ok(r.orphanCount === 0, 'fk null not orphan: orphanCount 0');
  ok(r.nullCount === 2, 'fk null not orphan: nullCount 2');
}

{
  // Empty child table -> idle
  await createTable('patients_d', [{ patient_id: 'P001' }]);
  await nodeEngine.runQuery('DROP TABLE IF EXISTS encounters_d');
  await nodeEngine.runQuery('CREATE TABLE encounters_d (patient_id VARCHAR)');
  const r = await checkForeignKey({
    childTable: 'encounters_d', childCol: 'patient_id',
    parentTable: 'patients_d', parentCol: 'patient_id',
    engine,
  });
  // Empty child table: no non-null FK values -> pass (no bad rows possible)
  ok(r.status === 'pass' || r.status === 'idle', 'fk empty child: pass or idle (no violations)');
  ok(r.orphanCount === 0, 'fk empty child: 0 orphans');
}

{
  // checkAllForeignKeys aggregation
  await createTable('ref_table', [{ id: 'A' }, { id: 'B' }]);
  await createTable('child_multi', [
    { fk: 'A' }, { fk: 'B' }, { fk: 'MISSING' },
  ]);
  const results = await checkAllForeignKeys([
    { childTable: 'child_multi', childCol: 'fk', parentTable: 'ref_table', parentCol: 'id' },
  ], engine);
  ok(results.status === 'fail', 'checkAllForeignKeys: rolls up to fail');
  ok(results.summary.totalOrphans > 0, 'checkAllForeignKeys: totalOrphans > 0');
  ok(results.pairs.length === 1, 'checkAllForeignKeys: 1 pair result');
}

{
  // Rationale text is always a non-empty string
  await createTable('p_rat', [{ id: 'X' }]);
  await createTable('c_rat', [{ fk: 'X' }]);
  const r = await checkForeignKey({
    childTable: 'c_rat', childCol: 'fk', parentTable: 'p_rat', parentCol: 'id', engine,
  });
  ok(typeof r.rationale === 'string' && r.rationale.length > 0, 'fk: rationale non-empty');
}

// ============================================================
// 2. Temporal order checker
// ============================================================
section('checkTemporalOrder — date inversion detection');

{
  // All dates correct -> pass
  await createTable('enc_dates_ok', [
    { admit_date: '2026-01-01', discharge_date: '2026-01-05' },
    { admit_date: '2026-02-10', discharge_date: '2026-02-15' },
    { admit_date: '2026-03-01', discharge_date: '2026-03-01' }, // same day = ok
  ]);
  const cols = [{ name: 'admit_date', type: 'VARCHAR' }, { name: 'discharge_date', type: 'VARCHAR' }];
  const r = await checkTemporalOrder({ table: 'enc_dates_ok', cols, engine });
  ok(r.status === 'pass' || r.status === 'idle', 'temporal clean: pass or idle (no violations)');
  ok(r.rules.every(rule => rule.violationCount === 0), 'temporal clean: all rules 0 violations');
}

{
  // Discharge before admit -> hard fail
  await createTable('enc_dates_bad', [
    { admit_date: '2026-01-10', discharge_date: '2026-01-05' }, // inverted!
    { admit_date: '2026-01-10', discharge_date: '2026-01-05' }, // inverted!
    { admit_date: '2026-02-01', discharge_date: '2026-02-10' }, // ok
    { admit_date: '2026-02-01', discharge_date: '2026-02-10' }, // ok
    { admit_date: '2026-02-01', discharge_date: '2026-02-10' }, // ok
  ]);
  const cols = [{ name: 'admit_date', type: 'VARCHAR' }, { name: 'discharge_date', type: 'VARCHAR' }];
  const r = await checkTemporalOrder({ table: 'enc_dates_bad', cols, engine });
  ok(r.status === 'fail', 'temporal inverted: status fail');
  ok(r.rules.some(rule => rule.ruleId === 'admit_before_discharge' && rule.violationCount === 2),
    'temporal inverted: admit_before_discharge finds 2 violations');
  ok(r.level !== 'none', 'temporal inverted: level not none');
}

{
  // Order before result violation
  await createTable('labs_bad', [
    { order_date: '2026-03-10', result_date: '2026-03-05' }, // result before order!
    { order_date: '2026-03-10', result_date: '2026-03-15' }, // ok
    { order_date: '2026-03-10', result_date: '2026-03-15' }, // ok
  ]);
  const cols = [{ name: 'order_date', type: 'VARCHAR' }, { name: 'result_date', type: 'VARCHAR' }];
  const r = await checkTemporalOrder({ table: 'labs_bad', cols, engine });
  ok(r.status === 'fail', 'temporal lab order: status fail');
  ok(r.rules.some(rule => rule.ruleId === 'order_before_result' && rule.violationCount >= 1),
    'temporal lab order: order_before_result finds violation');
}

{
  // No matching date columns -> idle
  await createTable('no_dates', [
    { name: 'Alice', age: 30 }, { name: 'Bob', age: 25 },
  ]);
  const cols = [{ name: 'name', type: 'VARCHAR' }, { name: 'age', type: 'INTEGER' }];
  const r = await checkTemporalOrder({ table: 'no_dates', cols, engine });
  ok(r.status === 'idle', 'temporal no date cols: idle');
  ok(r.rules.length === 0, 'temporal no date cols: 0 rules');
}

{
  // NULL dates in both columns -> rows skipped (not false violations)
  await createTable('enc_nulls', [
    { admit_date: null, discharge_date: null },
    { admit_date: '2026-01-01', discharge_date: null },
    { admit_date: null, discharge_date: '2026-01-05' },
    { admit_date: '2026-02-01', discharge_date: '2026-02-10' }, // ok
  ]);
  const cols = [{ name: 'admit_date', type: 'VARCHAR' }, { name: 'discharge_date', type: 'VARCHAR' }];
  const r = await checkTemporalOrder({ table: 'enc_nulls', cols, engine });
  ok(r.status === 'pass' || r.status === 'idle', 'temporal nulls: pass or idle (no false positives)');
  ok(r.rules.every(rule => rule.violationCount === 0 || rule.status === 'idle'),
    'temporal nulls: 0 violations (nulls skipped)');
}

{
  // Death before birth
  await createTable('patients_dob', [
    { dob: '1990-05-01', dod: '1985-01-01' }, // impossible!
    { dob: '1960-03-15', dod: '2020-07-04' }, // ok
  ]);
  const cols = [{ name: 'dob', type: 'VARCHAR' }, { name: 'dod', type: 'VARCHAR' }];
  const r = await checkTemporalOrder({ table: 'patients_dob', cols, engine });
  ok(r.rules.some(rule => rule.ruleId === 'birth_before_death' && rule.violationCount === 1),
    'temporal birth_before_death: finds 1 violation');
}

{
  // Rationale is always present and non-empty
  await createTable('t_rat', [{ admit_date: '2026-01-01', discharge_date: '2026-01-05' }]);
  const cols = [{ name: 'admit_date', type: 'VARCHAR' }, { name: 'discharge_date', type: 'VARCHAR' }];
  const r = await checkTemporalOrder({ table: 't_rat', cols, engine });
  ok(typeof r.rationale === 'string' && r.rationale.length > 0, 'temporal: rationale non-empty');
}

// ============================================================
// 3. Flag consistency checker
// ============================================================
section('checkFlagConsistency — readmit window + mutual exclusion rules');

{
  // Clean: all flags consistent
  await createTable('enc_flags_ok', [
    { readmit_30d: 1, readmit_90d: 1 },
    { readmit_30d: 0, readmit_90d: 0 },
    { readmit_30d: 0, readmit_90d: 1 },
    { readmit_30d: 1, readmit_90d: 1 },
  ]);
  const cols = [{ name: 'readmit_30d' }, { name: 'readmit_90d' }];
  const r = await checkFlagConsistency({ table: 'enc_flags_ok', cols, engine });
  ok(r.status === 'pass', 'flag clean: status pass');
  ok(r.summary.totalViolations === 0, 'flag clean: 0 violations');
}

{
  // readmit_30d=1 but readmit_90d=0 is impossible
  await createTable('enc_flags_bad', [
    { readmit_30d: 1, readmit_90d: 0 }, // violation!
    { readmit_30d: 1, readmit_90d: 0 }, // violation!
    { readmit_30d: 1, readmit_90d: 1 }, // ok
    { readmit_30d: 0, readmit_90d: 0 }, // ok
  ]);
  const cols = [{ name: 'readmit_30d' }, { name: 'readmit_90d' }];
  const r = await checkFlagConsistency({ table: 'enc_flags_bad', cols, engine });
  ok(r.status === 'fail', 'readmit flag contradiction: status fail');
  const rule = r.rules.find(rx => rx.ruleId === 'readmit_30d_implies_90d');
  ok(rule !== undefined, 'readmit flag contradiction: rule found');
  ok(rule.violationCount === 2, 'readmit flag contradiction: 2 violations');
  ok(rule.level !== 'none', 'readmit flag contradiction: level not none');
}

{
  // readmit_7d=1 but readmit_30d=0 is impossible
  await createTable('enc_7d_bad', [
    { readmit_7d: 1, readmit_30d: 0 }, // violation!
    { readmit_7d: 1, readmit_30d: 1 }, // ok
    { readmit_7d: 0, readmit_30d: 0 }, // ok
  ]);
  const cols = [{ name: 'readmit_7d' }, { name: 'readmit_30d' }];
  const r = await checkFlagConsistency({ table: 'enc_7d_bad', cols, engine });
  ok(r.status === 'fail', 'readmit_7d contradiction: status fail');
  ok(r.rules.some(rx => rx.ruleId === 'readmit_7d_implies_30d' && rx.violationCount === 1),
    'readmit_7d contradiction: correct rule fires');
}

{
  // inpatient=1 and outpatient=1 simultaneously
  await createTable('enc_mutual', [
    { inpatient: 1, outpatient: 1 }, // contradiction!
    { inpatient: 1, outpatient: 0 }, // ok
    { inpatient: 0, outpatient: 1 }, // ok
  ]);
  const cols = [{ name: 'inpatient' }, { name: 'outpatient' }];
  const r = await checkFlagConsistency({ table: 'enc_mutual', cols, engine });
  ok(r.status === 'fail', 'inpatient+outpatient: status fail');
  ok(r.rules.some(rx => rx.ruleId === 'inpatient_outpatient_exclusive' && rx.violationCount === 1),
    'inpatient+outpatient: correct rule fires');
}

{
  // No matching columns -> idle (rule skipped)
  await createTable('no_flags', [{ name: 'Alice' }, { name: 'Bob' }]);
  const cols = [{ name: 'name' }];
  const r = await checkFlagConsistency({ table: 'no_flags', cols, engine });
  ok(r.status === 'idle', 'no flag cols: idle');
  ok(r.rules.length === 0, 'no flag cols: 0 rules');
}

{
  // Extra custom rules
  await createTable('custom_flags', [
    { approved: 1, pending: 1 }, // contradiction by custom rule
    { approved: 1, pending: 0 }, // ok
  ]);
  const cols = [{ name: 'approved' }, { name: 'pending' }];
  const customRule = {
    id: 'approved_not_pending',
    label: 'approved=1 and pending=1',
    requiredCols: ['approved', 'pending'],
    condition: (t) => '"' + t + '".approved = 1 AND "' + t + '".pending = 1',
    severity: 'hard',
    rationale: 'A record cannot be both approved and pending simultaneously.',
  };
  const r = await checkFlagConsistency({ table: 'custom_flags', cols, engine, extraRules: [customRule] });
  ok(r.rules.some(rx => rx.ruleId === 'approved_not_pending' && rx.violationCount === 1),
    'custom rule: fires correctly');
}

{
  // Rationale always present
  await createTable('f_rat', [{ readmit_30d: 0, readmit_90d: 0 }]);
  const cols = [{ name: 'readmit_30d' }, { name: 'readmit_90d' }];
  const r = await checkFlagConsistency({ table: 'f_rat', cols, engine });
  ok(typeof r.rationale === 'string' && r.rationale.length > 0, 'flag: rationale non-empty');
}

// ============================================================
// 4. Join coverage checker
// ============================================================
section('checkJoinCoverage — referential completeness rates');

{
  // 100% coverage -> pass
  await createTable('pat_full', [{ patient_id: 'P1' }, { patient_id: 'P2' }, { patient_id: 'P3' }]);
  await createTable('enc_full', [
    { patient_id: 'P1' }, { patient_id: 'P2' }, { patient_id: 'P3' },
  ]);
  const r = await checkJoinCoverage({
    childTable: 'enc_full', childCol: 'patient_id',
    parentTable: 'pat_full', parentCol: 'patient_id',
    engine,
  });
  ok(r.status === 'pass', 'cov 100%: status pass');
  ok(r.childCoverageRate === 1, 'cov 100%: childCoverageRate = 1');
  ok(r.childMatched === 3, 'cov 100%: childMatched = 3');
}

{
  // 50% child coverage (half orphans) -> fail
  await createTable('pat_half', [{ patient_id: 'P1' }, { patient_id: 'P2' }]);
  await createTable('enc_half', [
    { patient_id: 'P1' },
    { patient_id: 'GHOST1' },
    { patient_id: 'GHOST2' },
    { patient_id: 'GHOST3' },
  ]);
  const r = await checkJoinCoverage({
    childTable: 'enc_half', childCol: 'patient_id',
    parentTable: 'pat_half', parentCol: 'patient_id',
    engine,
  });
  ok(r.status === 'fail', 'cov 25%: status fail');
  ok(r.childCoverageRate < JOIN_FAIL_RATE, 'cov 25%: childCoverageRate below fail threshold');
  ok(r.level === 'high', 'cov 25%: level high');
}

{
  // Both tables empty -> idle
  await nodeEngine.runQuery('DROP TABLE IF EXISTS empty_child');
  await nodeEngine.runQuery('DROP TABLE IF EXISTS empty_parent');
  await nodeEngine.runQuery('CREATE TABLE empty_child (patient_id VARCHAR)');
  await nodeEngine.runQuery('CREATE TABLE empty_parent (patient_id VARCHAR)');
  const r = await checkJoinCoverage({
    childTable: 'empty_child', childCol: 'patient_id',
    parentTable: 'empty_parent', parentCol: 'patient_id',
    engine,
  });
  ok(r.status === 'idle', 'cov empty tables: idle');
}

{
  // Parent has unmatched rows (valid -- not every patient has an encounter yet)
  await createTable('pat_unmatched', [
    { patient_id: 'P1' }, { patient_id: 'P2' }, { patient_id: 'P3' }, { patient_id: 'P4' },
  ]);
  await createTable('enc_subset', [
    { patient_id: 'P1' }, { patient_id: 'P1' }, { patient_id: 'P2' },
  ]);
  const r = await checkJoinCoverage({
    childTable: 'enc_subset', childCol: 'patient_id',
    parentTable: 'pat_unmatched', parentCol: 'patient_id',
    engine,
  });
  ok(r.status === 'pass', 'cov parent unmatched: child side still pass (100% child coverage)');
  ok(r.parentCoverageRate < 1, 'cov parent unmatched: parentCoverageRate < 1 (P3, P4 have no encounters)');
  ok(r.parentCoverageRate === 0.5, 'cov parent unmatched: parentCoverageRate = 0.5 (2/4 parents matched)');
}

{
  // checkAllJoinCoverage aggregation
  await createTable('ref_cov', [{ id: 'X' }, { id: 'Y' }]);
  await createTable('child_cov', [{ fk: 'X' }, { fk: 'Y' }, { fk: 'Y' }]);
  const results = await checkAllJoinCoverage([
    { childTable: 'child_cov', childCol: 'fk', parentTable: 'ref_cov', parentCol: 'id' },
  ], engine);
  ok(results.status === 'pass', 'checkAllJoinCoverage: pass when 100% coverage');
  ok(results.pairs.length === 1, 'checkAllJoinCoverage: 1 pair result');
}

{
  // Rationale always present
  await createTable('r_rat', [{ id: 'A' }]);
  await createTable('c_rat2', [{ fk: 'A' }]);
  const r = await checkJoinCoverage({
    childTable: 'c_rat2', childCol: 'fk',
    parentTable: 'r_rat', parentCol: 'id',
    engine,
  });
  ok(typeof r.rationale === 'string' && r.rationale.length > 0, 'cov: rationale non-empty');
}

// ============================================================
// Cross-checker: FK orphan and join coverage agree on same data
// ============================================================
section('FK + join coverage consistency on shared data');

{
  // Load a consistent dataset and verify both checkers agree.
  await createTable('cross_parent', [{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
  // Child has 2 clean + 1 orphan row.
  await createTable('cross_child', [{ fk: 'A' }, { fk: 'B' }, { fk: 'ORPHAN' }]);

  const fk = await checkForeignKey({
    childTable: 'cross_child', childCol: 'fk',
    parentTable: 'cross_parent', parentCol: 'id',
    engine,
  });
  const cov = await checkJoinCoverage({
    childTable: 'cross_child', childCol: 'fk',
    parentTable: 'cross_parent', parentCol: 'id',
    engine,
  });

  // FK: 1 orphan out of 3 = 33% orphan rate -> fail
  ok(fk.orphanCount === 1, 'cross: FK finds 1 orphan');
  ok(fk.status === 'fail', 'cross: FK fails');

  // Join coverage: 2/3 child rows match -> 66.7% -> fail
  ok(Math.abs(cov.childCoverageRate - 2/3) < 0.01, 'cross: cov childCoverageRate ~= 0.667');
  ok(cov.status === 'fail', 'cross: cov fails');

  // They agree: both flag the same data quality problem.
  ok(fk.status === cov.status, 'cross: FK and cov agree on status');
}

// ============================================================
// End
// ============================================================
if (typeof closeConnection === 'function') await closeConnection();

console.log('\n==========================================');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('==========================================');
if (failed > 0) process.exit(1);
