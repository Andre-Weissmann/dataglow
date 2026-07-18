// ============================================================
// DATAGLOW — DRG / ICD-10 Coding Validation test suite
// ============================================================
// Tests js/validation/drg-icd-validator.js:
//   * Column detection (detectDrgColumn, detectPrimaryIcdColumn)
//   * DRG_FAMILIES coverage
//   * runDrgIcdValidation: fires on known mismatches, stays quiet on valid pairs
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/drg-icd-validator.test.mjs

import * as engine from './node-duckdb-engine.mjs';
import {
  detectDrgColumn,
  detectPrimaryIcdColumn,
  DRG_FAMILIES,
  runDrgIcdValidation,
} from '../js/validation/drg-icd-validator.js';

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
  const name = `drg_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
  // 1. Column detection — DRG
  // ================================================================
  ok(!!detectDrgColumn([col('drg_code'), col('patient_id')]), 'detectDrgColumn: "drg_code" detected');
  ok(!!detectDrgColumn([col('drgCode'), col('los_days')]), 'detectDrgColumn: camelCase "drgCode" detected');
  ok(!detectDrgColumn([col('diagnosis_code'), col('icd10')]), 'detectDrgColumn: no DRG column → null');

  // ================================================================
  // 2. Column detection — primary ICD
  // ================================================================
  ok(!!detectPrimaryIcdColumn([col('primary_icd10'), col('drg_code')]), 'detectPrimaryIcdColumn: "primary_icd10" detected');
  ok(!!detectPrimaryIcdColumn([col('icd_primary'), col('drg_code')]), 'detectPrimaryIcdColumn: "icd_primary" detected');
  ok(!!detectPrimaryIcdColumn([col('diagnosis'), col('drg')]), 'detectPrimaryIcdColumn: bare "diagnosis" falls back');
  ok(!detectPrimaryIcdColumn([col('facility_id'), col('los_days')]), 'detectPrimaryIcdColumn: no ICD column → null');

  // ================================================================
  // 3. DRG_FAMILIES integrity — no DRG code appears in two families
  // ================================================================
  {
    const seen = new Map();
    let dupes = 0;
    for (const fam of DRG_FAMILIES) {
      for (const drg of fam.drg) {
        if (seen.has(drg)) {
          console.log(`  duplicate DRG ${drg}: ${seen.get(drg)} and ${fam.family}`);
          dupes++;
        }
        seen.set(drg, fam.family);
      }
    }
    ok(dupes === 0, `DRG_FAMILIES: no duplicate DRG codes across families (checked ${seen.size} codes)`);
  }

  // ================================================================
  // 4. Clean data: valid DRG/ICD pairs — no finding
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { drg_code: '291', primary_icd10: 'I50.9'  }, // Heart Failure DRG + HF dx — valid
      { drg_code: '282', primary_icd10: 'I21.9'  }, // AMI DRG + AMI dx — valid
      { drg_code: '195', primary_icd10: 'J18.9'  }, // Pneumonia DRG + Pneumonia dx — valid
      { drg_code: '870', primary_icd10: 'A41.9'  }, // Sepsis DRG + Sepsis dx — valid
      { drg_code: '470', primary_icd10: 'M16.9'  }, // Joint replacement + OA dx — valid
    ]);
    const findings = await runDrgIcdValidation(name, cols, engine);
    const mismatches = findRule(findings, 'drg_icd_mismatch');
    ok(mismatches.length === 0, 'Clean valid DRG/ICD pairs: no findings raised');
  }

  // ================================================================
  // 5. Classic benchmark mismatch: DRG 291 (CHF) + I21.9 (AMI) — must fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { drg_code: '291', primary_icd10: 'I50.9'  }, // valid
      { drg_code: '291', primary_icd10: 'I21.9'  }, // MISMATCH — AMI is not a HF principal dx
      { drg_code: '291', primary_icd10: 'I21.19' }, // MISMATCH — also AMI
    ]);
    const findings = await runDrgIcdValidation(name, cols, engine);
    const mismatches = findRule(findings, 'drg_icd_mismatch');
    ok(mismatches.length >= 1, 'DRG 291 + I21.9 (AMI): mismatch finding raised');
    const f = mismatches.find(f => f.columns?.includes('drg_code'));
    ok(f?.count === 2, `Exactly 2 mismatched rows flagged (got ${f?.count})`);
    ok(f?.ruleLabel?.includes('Heart Failure'), 'Finding label mentions Heart Failure family');
  }

  // ================================================================
  // 6. DRG 282 (AMI) + I63.9 (Stroke) — must fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { drg_code: '282', primary_icd10: 'I21.9'  }, // valid
      { drg_code: '282', primary_icd10: 'I63.9'  }, // MISMATCH — stroke in AMI DRG
    ]);
    const findings = await runDrgIcdValidation(name, cols, engine);
    const mismatches = findRule(findings, 'drg_icd_mismatch');
    ok(mismatches.length >= 1, 'DRG 282 + I63.9 (Stroke): mismatch finding raised');
  }

  // ================================================================
  // 7. DRG from unknown family: silently skipped, no finding
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { drg_code: '999', primary_icd10: 'Z99.99' }, // unknown DRG — not in any family
    ]);
    const findings = await runDrgIcdValidation(name, cols, engine);
    ok(findings.length === 0, 'Unknown DRG family: silently skipped (no false positive)');
  }

  // ================================================================
  // 8. No DRG column: silently returns empty findings (no crash)
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT001', primary_icd10: 'I50.9' },
    ]);
    let threw = false;
    let findings = [];
    try { findings = await runDrgIcdValidation(name, cols, engine); }
    catch { threw = true; }
    ok(!threw, 'No DRG column: runner does not throw');
    ok(findings.length === 0, 'No DRG column: returns empty findings');
  }

  // ================================================================
  // 9. No ICD column: silently returns empty findings (no crash)
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { drg_code: '291', facility_id: 'FAC001' },
    ]);
    let threw = false;
    let findings = [];
    try { findings = await runDrgIcdValidation(name, cols, engine); }
    catch { threw = true; }
    ok(!threw, 'No ICD column: runner does not throw');
    ok(findings.length === 0, 'No ICD column: returns empty findings');
  }

  // ================================================================
  // 10. camelCase column names: drg_code as "drgCode", icd as "primaryIcd"
  // ================================================================
  {
    const { name } = await makeTable([
      { drgCode: '291', primaryIcd: 'I21.9' }, // MISMATCH — camelCase columns
    ]);
    const cols = [col('drgCode'), col('primaryIcd')];
    const findings = await runDrgIcdValidation(name, cols, engine);
    const mismatches = findRule(findings, 'drg_icd_mismatch');
    ok(mismatches.length >= 1, 'camelCase columns (drgCode / primaryIcd): mismatch still detected');
  }

  // ================================================================
  // 11. NULL ICD on a known DRG row: must not fire (IS NOT NULL guard)
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { drg_code: '291', primary_icd10: null }, // NULL ICD — should be skipped
    ]);
    const findings = await runDrgIcdValidation(name, cols, engine);
    ok(findings.length === 0, 'NULL ICD row: not flagged as a mismatch');
  }

  // ================================================================
  // 12. Sepsis DRG (870) + J44.1 (COPD): must fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { drg_code: '870', primary_icd10: 'A41.9' }, // valid
      { drg_code: '870', primary_icd10: 'J44.1' }, // MISMATCH — COPD not a sepsis dx
    ]);
    const findings = await runDrgIcdValidation(name, cols, engine);
    const mismatches = findRule(findings, 'drg_icd_mismatch');
    ok(mismatches.length >= 1, 'DRG 870 + J44.1 (COPD): sepsis/COPD mismatch detected');
  }

  // ================================================================
  // Results
  // ================================================================
  console.log(`\nDRG/ICD validation tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
