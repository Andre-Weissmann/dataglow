// ============================================================
// DATAGLOW — Cross-Column Logical Consistency Checker test suite
// ============================================================
// Two halves:
//   1. Pure detection / rule-firing helpers — dependency-free, exercised with
//      snake_case, camelCase and PascalCase column-name variations to prove the
//      robust word-splitting (not naive `\b` boundaries) matches compound names.
//   2. The async runner against a REAL (native) DuckDB table, confirming every
//      rule category fires on seeded contradictions and stays quiet on clean
//      data (false-positive guard).
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/cross-column-consistency.test.mjs
//
// The runner imports '../js/duckdb-engine.js' transitively via the module under
// test only when we pass it an engine; here we pass the native engine directly.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import * as engine from './node-duckdb-engine.mjs';

import {
  nameTokens, matchesKeyword, hasAnyKeyword, isDateLike, isNumeric,
  detectDatePairs, detectRangePairs, detectSexColumn, detectPregnancyColumns,
  detectAgeColumn, detectMaritalColumn, detectAdultOnlyFlags, detectStatusPairs,
  isMaleValue, isAffirmative, maritalImpliesAdult, isAbnormalStatus,
  runCrossColumnChecks,
} from '../js/cross-column-consistency.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
const col = (name, type = 'VARCHAR') => ({ name, type });
const findRule = (fs, rule) => fs.find(f => f.rule === rule);

async function main() {
  // ============================================================
  // 1. Pure word-splitting / keyword matching
  // ============================================================
  ok(JSON.stringify(nameTokens('admit_date')) === JSON.stringify(['admit', 'date']), 'tokens: snake_case admit_date -> [admit,date]');
  ok(JSON.stringify(nameTokens('admitDate')) === JSON.stringify(['admit', 'date']), 'tokens: camelCase admitDate -> [admit,date]');
  ok(JSON.stringify(nameTokens('AdmitDate')) === JSON.stringify(['admit', 'date']), 'tokens: PascalCase AdmitDate -> [admit,date]');
  ok(JSON.stringify(nameTokens('check-in-time')) === JSON.stringify(['check', 'in', 'time']), 'tokens: kebab check-in-time -> [check,in,time]');
  ok(JSON.stringify(nameTokens('EDDDate')).includes('edd'), 'tokens: acronym-ish EDDDate splits sanely');

  // matchesKeyword must catch compound forms both snake and camel, and multi-token stems.
  ok(matchesKeyword('discharge_date', 'discharge') && matchesKeyword('dischargeDate', 'discharge'), 'keyword: discharge matches snake & camel');
  ok(matchesKeyword('check_in', 'checkin') && matchesKeyword('checkIn', 'checkin'), 'keyword: multi-token check_in/checkIn match stem "checkin"');
  ok(matchesKeyword('admission_date', 'admission') === true, 'keyword: "admission_date" matches "admission" stem');
  ok(hasAnyKeyword('gestational_age_flag', ['pregnant', 'gestation']), 'keyword: hasAnyKeyword finds gestation in gestational_age_flag');
  ok(!matchesKeyword('country', 'admit'), 'keyword: unrelated column does not match (no false positive)');

  ok(isDateLike(col('admit_date', 'VARCHAR')) && isDateLike(col('ts', 'TIMESTAMP')), 'isDateLike: by name and by type');
  ok(isNumeric(col('age', 'BIGINT')) && !isNumeric(col('age', 'VARCHAR')), 'isNumeric: type-based');

  // ============================================================
  // 2. Date-pair detection — grouped, conservative
  // ============================================================
  {
    const cols = [col('admitDate'), col('dischargeDate'), col('created_at', 'TIMESTAMP'), col('updated_at', 'TIMESTAMP'), col('check_in'), col('check_out'), col('country')];
    const pairs = detectDatePairs(cols);
    ok(pairs.some(p => p.earlier === 'admitDate' && p.later === 'dischargeDate'), 'date-pairs: admit→discharge (camelCase) detected');
    ok(pairs.some(p => p.earlier === 'created_at' && p.later === 'updated_at'), 'date-pairs: created→updated detected');
    ok(pairs.some(p => p.earlier === 'check_in' && p.later === 'check_out'), 'date-pairs: check_in→check_out detected');
    // Conservative: unrelated cross-group pairing (admit × updated) must NOT appear.
    ok(!pairs.some(p => p.earlier === 'admitDate' && p.later === 'updated_at'), 'date-pairs: no nonsense cross-group pair admit×updated');
  }

  // ============================================================
  // 3. Range-pair detection — shared stem only
  // ============================================================
  {
    const cols = [col('temp_min', 'DOUBLE'), col('temp_max', 'DOUBLE'), col('pressure_low', 'DOUBLE'), col('unrelated_high', 'DOUBLE')];
    const pairs = detectRangePairs(cols);
    ok(pairs.some(p => p.min === 'temp_min' && p.max === 'temp_max'), 'range-pairs: temp_min/temp_max paired via shared stem');
    ok(!pairs.some(p => p.min === 'pressure_low' && p.max === 'unrelated_high'), 'range-pairs: low/high with different stems NOT paired');
  }

  // ============================================================
  // 4. Demographic detectors + value classifiers
  // ============================================================
  ok(detectSexColumn([col('patient_sex'), col('name')]).name === 'patient_sex', 'detect: sex column by token');
  ok(detectSexColumn([col('genderCode')]).name === 'genderCode', 'detect: gender column camelCase');
  ok(detectPregnancyColumns([col('is_pregnant'), col('gestation_wk'), col('age')]).length === 2, 'detect: pregnancy columns (is_pregnant + gestation)');
  ok(detectAgeColumn([col('age', 'INTEGER'), col('page_views', 'INTEGER')]).name === 'age', 'detect: age column exact-token (not "page")');
  ok(detectMaritalColumn([col('marital_status'), col('x')]).name === 'marital_status', 'detect: marital_status column');
  ok(detectAdultOnlyFlags([col('has_retirement_account'), col('medicareEligible'), col('name')]).length === 2, 'detect: adult-only flags');
  ok(detectStatusPairs([col('glucose', 'DOUBLE'), col('glucose_flag'), col('note')]).some(p => p.measurement === 'glucose' && p.status === 'glucose_flag'), 'detect: measurement+status pair by shared stem');

  ok(isMaleValue('M') && isMaleValue('male') && !isMaleValue('F') && !isMaleValue('1'), 'value: isMaleValue narrow (no numeric coding)');
  ok(isAffirmative('true') && isAffirmative('Yes') && isAffirmative('1') && !isAffirmative('no'), 'value: isAffirmative');
  ok(maritalImpliesAdult('Married') && maritalImpliesAdult('divorced') && !maritalImpliesAdult('Single') && !maritalImpliesAdult(''), 'value: maritalImpliesAdult (single/blank do not fire)');
  ok(isAbnormalStatus('Critical') && isAbnormalStatus('ABNORMAL') && !isAbnormalStatus('normal'), 'value: isAbnormalStatus');

  // ============================================================
  // 5. Async runner against a real DuckDB table — every rule fires
  // ============================================================
  const rows = [
    // clean baseline rows
    ...Array.from({ length: 6 }, (_, i) => ({
      id: i + 1, age: 30 + i, sex: i % 2 ? 'M' : 'F',
      admit_date: '2025-01-01', discharge_date: '2025-01-05',
      temp_min: 10, temp_max: 20, is_pregnant: 'false',
      marital_status: 'single', glucose: 90 + i, glucose_flag: 'Normal',
      medicare_eligible: 'false',
    })),
    // discharge before admit (date_order)
    { id: 101, age: 40, sex: 'F', admit_date: '2025-03-10', discharge_date: '2025-03-01', temp_min: 10, temp_max: 20, is_pregnant: 'false', marital_status: 'single', glucose: 100, glucose_flag: 'Normal', medicare_eligible: 'false' },
    // max < min (numeric_range)
    { id: 102, age: 50, sex: 'M', admit_date: '2025-01-01', discharge_date: '2025-01-05', temp_min: 30, temp_max: 5, is_pregnant: 'false', marital_status: 'single', glucose: 100, glucose_flag: 'Normal', medicare_eligible: 'false' },
    // male + pregnant (sex_pregnancy)
    { id: 103, age: 45, sex: 'M', admit_date: '2025-01-01', discharge_date: '2025-01-05', temp_min: 10, temp_max: 20, is_pregnant: 'true', marital_status: 'single', glucose: 100, glucose_flag: 'Normal', medicare_eligible: 'false' },
    // infant + married (infant_marital)
    { id: 104, age: 0, sex: 'F', admit_date: '2025-01-01', discharge_date: '2025-01-05', temp_min: 10, temp_max: 20, is_pregnant: 'false', marital_status: 'Married', glucose: 100, glucose_flag: 'Normal', medicare_eligible: 'false' },
    // minor + adult-only status (minor_adult_status)
    { id: 105, age: 12, sex: 'M', admit_date: '2025-01-01', discharge_date: '2025-01-05', temp_min: 10, temp_max: 20, is_pregnant: 'false', marital_status: 'single', glucose: 100, glucose_flag: 'Normal', medicare_eligible: 'true' },
    // abnormal flag but no measurement (status_without_measure)
    { id: 106, age: 60, sex: 'F', admit_date: '2025-01-01', discharge_date: '2025-01-05', temp_min: 10, temp_max: 20, is_pregnant: 'false', marital_status: 'single', glucose: null, glucose_flag: 'Critical', medicare_eligible: 'false' },
  ];
  await createTableFromObjects('xcol_test', rows);
  const cols = (await getTableSchema('xcol_test')).map(s => ({ name: s.column_name, type: s.column_type }));
  const findings = await runCrossColumnChecks('xcol_test', cols, engine);

  ok(findRule(findings, 'date_order')?.count === 1, 'runner: date_order fires once (discharge<admit)');
  ok(findRule(findings, 'numeric_range')?.count === 1, 'runner: numeric_range fires once (max<min)');
  ok(findRule(findings, 'sex_pregnancy')?.count === 1, 'runner: sex_pregnancy fires once (male+pregnant)');
  ok(findRule(findings, 'infant_marital')?.count === 1, 'runner: infant_marital fires once (age<1 married)');
  ok(findRule(findings, 'minor_adult_status')?.count === 1, 'runner: minor_adult_status fires once (minor+medicare)');
  ok(findRule(findings, 'status_without_measure')?.count === 1, 'runner: status_without_measure fires once (Critical flag, null glucose)');
  // Every finding carries its columns + a plain-language explanation.
  ok(findings.every(f => Array.isArray(f.columns) && f.columns.length >= 2 && typeof f.explanation === 'string' && f.explanation.length > 0), 'runner: findings carry columns + explanation ("show your work")');

  // False-positive guard: a fully clean table produces no findings.
  const cleanRows = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, age: 30 + i, sex: i % 2 ? 'M' : 'F',
    admit_date: '2025-01-01', discharge_date: '2025-01-10',
    temp_min: 5, temp_max: 25, is_pregnant: i % 2 ? 'false' : 'false',
    marital_status: 'single', glucose: 90 + i, glucose_flag: 'Normal',
    medicare_eligible: 'false',
  }));
  await createTableFromObjects('xcol_clean', cleanRows);
  const cleanCols = (await getTableSchema('xcol_clean')).map(s => ({ name: s.column_name, type: s.column_type }));
  const cleanFindings = await runCrossColumnChecks('xcol_clean', cleanCols, engine);
  ok(cleanFindings.length === 0, `runner: no findings on clean data (got ${cleanFindings.length})`);

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
