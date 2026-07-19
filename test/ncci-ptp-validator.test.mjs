// ============================================================
// DATAGLOW — NCCI Same-Day Procedure Conflict Check test suite
// ============================================================
// Tests js/validation/ncci-ptp-validator.js:
//   * Column detection (detectProcedureColumn, detectPatientColumn, detectServiceDateColumn)
//   * NCCI_PTP_PAIRS coverage (no duplicate/contradictory pairs)
//   * runNcciPtpValidation: fires on known same-day conflicts, stays quiet on clean/unrelated data
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/ncci-ptp-validator.test.mjs

import * as engine from './node-duckdb-engine.mjs';
import {
  detectProcedureColumn,
  detectPatientColumn,
  detectServiceDateColumn,
  NCCI_PTP_PAIRS,
  runNcciPtpValidation,
} from '../js/validation/ncci-ptp-validator.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else       { failed++; console.log(`✗ FAILED: ${msg}`); }
}
const col = (name, type = 'VARCHAR') => ({ name, type });
const findRule = (fs, rule) => fs.filter(f => f.rule === rule);

// ----------------------------------------------------------------
// Helper: create a table from rows and return { name, cols }
// ----------------------------------------------------------------
async function makeTable(rows) {
  const name = `ncci_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const first = rows[0];
  const coldefs = Object.keys(first).map(k => `"${k}" VARCHAR`).join(', ');
  await engine.runQuery(`CREATE TABLE ${name} (${coldefs})`);
  for (const r of rows) {
    const vals = Object.values(r).map(v => v === null ? 'NULL' : `'${v}'`).join(', ');
    await engine.runQuery(`INSERT INTO ${name} VALUES (${vals})`);
  }
  const cols = Object.keys(first).map(k => ({ name: k, type: 'VARCHAR' }));
  return { name, cols };
}

async function main() {
  // ================================================================
  // 1. Column detection — procedure code
  // ================================================================
  ok(!!detectProcedureColumn([col('procedure_code'), col('patient_id')]), 'detectProcedureColumn: "procedure_code" detected');
  ok(!!detectProcedureColumn([col('cpt_code'), col('mrn')]), 'detectProcedureColumn: "cpt_code" detected');
  ok(!!detectProcedureColumn([col('hcpcsCode'), col('claimId')]), 'detectProcedureColumn: camelCase "hcpcsCode" detected');
  ok(!detectProcedureColumn([col('diagnosis_code'), col('icd10')]), 'detectProcedureColumn: no procedure column → null');

  // ================================================================
  // 2. Column detection — patient
  // ================================================================
  ok(!!detectPatientColumn([col('patient_id'), col('cpt_code')]), 'detectPatientColumn: "patient_id" detected');
  ok(!!detectPatientColumn([col('member_number'), col('cpt_code')]), 'detectPatientColumn: "member_number" detected');
  ok(!!detectPatientColumn([col('beneficiary_id'), col('cpt_code')]), 'detectPatientColumn: "beneficiary_id" detected');
  ok(!detectPatientColumn([col('facility_id'), col('cpt_code')]), 'detectPatientColumn: no patient column → null');

  // ================================================================
  // 3. Column detection — service date
  // ================================================================
  ok(!!detectServiceDateColumn([col('service_date'), col('cpt_code')]), 'detectServiceDateColumn: "service_date" detected');
  ok(!!detectServiceDateColumn([col('date_of_service'), col('cpt_code')]), 'detectServiceDateColumn: "date_of_service" detected');
  ok(!!detectServiceDateColumn([col('dos'), col('cpt_code')]), 'detectServiceDateColumn: abbreviation "dos" detected');
  {
    // Compound "service"+"date" must be preferred over an unrelated bare "date" column
    // (e.g. paid_date) when both are present.
    const detected = detectServiceDateColumn([col('paid_date'), col('service_date'), col('cpt_code')]);
    ok(detected?.name === 'service_date', 'detectServiceDateColumn: prefers compound "service_date" over bare "paid_date"');
  }
  ok(!detectServiceDateColumn([col('facility_id'), col('cpt_code')]), 'detectServiceDateColumn: no date column → null');

  // ================================================================
  // 4. NCCI_PTP_PAIRS integrity — no duplicate pair entries
  // ================================================================
  {
    const seen = new Set();
    let dupes = 0;
    for (const pair of NCCI_PTP_PAIRS) {
      const key = [pair.codeA, pair.codeB].sort().join('|');
      if (seen.has(key)) dupes++;
      seen.add(key);
    }
    ok(dupes === 0, `NCCI_PTP_PAIRS: no duplicate pairs (checked ${seen.size} pairs)`);
    ok(NCCI_PTP_PAIRS.every(p => !!p.rationale && p.rationale.length > 20), 'NCCI_PTP_PAIRS: every pair has a substantive documented rationale');
  }

  // ================================================================
  // 5. Clean data: no shared patient+date conflicts — no finding
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT001', service_date: '2026-01-05', procedure_code: '99213' },
      { patient_id: 'PT002', service_date: '2026-01-05', procedure_code: '99214' },
      { patient_id: 'PT001', service_date: '2026-01-12', procedure_code: '99215' },
    ]);
    const findings = await runNcciPtpValidation(name, cols, engine);
    ok(findings.length === 0, 'Clean data with no same-day pairs: no findings raised');
  }

  // ================================================================
  // 6. Classic benchmark conflict: 58260 + 58720, same patient/date — must fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT100', service_date: '2026-02-01', procedure_code: '58260' },
      { patient_id: 'PT100', service_date: '2026-02-01', procedure_code: '58720' },
    ]);
    const findings = await runNcciPtpValidation(name, cols, engine);
    const conflicts = findRule(findings, 'ncci_ptp_same_day_conflict');
    ok(conflicts.length >= 1, 'Vaginal hysterectomy (58260) + salpingo-oophorectomy (58720), same day: conflict finding raised');
    ok(conflicts[0]?.count === 1, `Exactly 1 conflicting claim flagged (got ${conflicts[0]?.count})`);
    ok(conflicts[0]?.ruleLabel?.includes('58260') && conflicts[0]?.ruleLabel?.includes('58720'), 'Finding label names both conflicting codes');
  }

  // ================================================================
  // 7. Same conflicting pair, but DIFFERENT dates: must NOT fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT101', service_date: '2026-02-01', procedure_code: '58260' },
      { patient_id: 'PT101', service_date: '2026-03-15', procedure_code: '58720' }, // different date — legitimate
    ]);
    const findings = await runNcciPtpValidation(name, cols, engine);
    ok(findings.length === 0, 'Same conflicting codes but different dates of service: correctly not flagged');
  }

  // ================================================================
  // 8. Same conflicting pair, but DIFFERENT patients: must NOT fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT200', service_date: '2026-02-01', procedure_code: '58260' },
      { patient_id: 'PT201', service_date: '2026-02-01', procedure_code: '58720' }, // different patient — unrelated claims
    ]);
    const findings = await runNcciPtpValidation(name, cols, engine);
    ok(findings.length === 0, 'Same conflicting codes, same date, but different patients: correctly not flagged');
  }

  // ================================================================
  // 9. Bilateral mammography unbundling: 77066 + 77065 — must fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT300', service_date: '2026-04-10', procedure_code: '77066' },
      { patient_id: 'PT300', service_date: '2026-04-10', procedure_code: '77065' },
    ]);
    const findings = await runNcciPtpValidation(name, cols, engine);
    const conflicts = findRule(findings, 'ncci_ptp_same_day_conflict');
    ok(conflicts.length >= 1, 'Bilateral (77066) + unilateral (77065) mammography, same day: conflict finding raised');
  }

  // ================================================================
  // 10. Unknown/unrelated code pair: silently skipped, no finding
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT400', service_date: '2026-05-01', procedure_code: '99213' },
      { patient_id: 'PT400', service_date: '2026-05-01', procedure_code: '90471' }, // office visit + vaccine admin — not a known conflict
    ]);
    const findings = await runNcciPtpValidation(name, cols, engine);
    ok(findings.length === 0, 'Unrelated code pair not in curated table: silently skipped (no false positive)');
  }

  // ================================================================
  // 11. Missing required columns: silently returns empty findings (no crash)
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { facility_id: 'FAC001', procedure_code: '58260' }, // no patient/date columns
    ]);
    let threw = false;
    let findings = [];
    try { findings = await runNcciPtpValidation(name, cols, engine); }
    catch { threw = true; }
    ok(!threw, 'Missing patient/date columns: runner does not throw');
    ok(findings.length === 0, 'Missing patient/date columns: returns empty findings');
  }

  // ================================================================
  // 12. NULL procedure code on an otherwise-matching row: must not crash/fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT500', service_date: '2026-06-01', procedure_code: '58260' },
      { patient_id: 'PT500', service_date: '2026-06-01', procedure_code: null },
    ]);
    const findings = await runNcciPtpValidation(name, cols, engine);
    ok(findings.length === 0, 'NULL procedure code row: not flagged, no crash (IS NOT NULL guard)');
  }

  // ================================================================
  // 13. camelCase column names: procedureCode / patientId / serviceDate
  // ================================================================
  {
    const { name } = await makeTable([
      { procedureCode: '58260', patientId: 'PT600', serviceDate: '2026-07-01' },
      { procedureCode: '58720', patientId: 'PT600', serviceDate: '2026-07-01' },
    ]);
    const cols = [col('procedureCode'), col('patientId'), col('serviceDate')];
    const findings = await runNcciPtpValidation(name, cols, engine);
    const conflicts = findRule(findings, 'ncci_ptp_same_day_conflict');
    ok(conflicts.length >= 1, 'camelCase columns (procedureCode/patientId/serviceDate): conflict still detected');
  }

  // ================================================================
  // 14. Three-way claim: patient has 3 procedures same day, one conflicting pair among them
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT700', service_date: '2026-08-01', procedure_code: '99213' },
      { patient_id: 'PT700', service_date: '2026-08-01', procedure_code: '58260' },
      { patient_id: 'PT700', service_date: '2026-08-01', procedure_code: '58720' },
    ]);
    const findings = await runNcciPtpValidation(name, cols, engine);
    const conflicts = findRule(findings, 'ncci_ptp_same_day_conflict');
    ok(conflicts.length === 1, `Three-code claim with exactly one conflicting pair: exactly 1 finding raised (got ${conflicts.length})`);
  }

  // ================================================================
  // Results
  // ================================================================
  console.log(`\nNCCI PTP validation tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
