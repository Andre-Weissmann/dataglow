// ============================================================
// DATAGLOW — LOS field vs date arithmetic mismatch test suite
// ============================================================
// Tests Rule 4 added to cross-column-consistency.js:
//   los_date_mismatch — flags rows where the stored los_days field
//   differs from (discharge_date - admit_date) by 2+ days.
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/los-date-mismatch.test.mjs

import { createTableFromObjects } from './node-duckdb-engine.mjs';
import * as engine from './node-duckdb-engine.mjs';
import { runCrossColumnChecks } from '../js/validation/cross-column-consistency.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else       { failed++; console.log(`✗ FAILED: ${msg}`); }
}
const findRule = (fs, rule) => fs.find(f => f.rule === rule);

async function main() {
  // ----------------------------------------------------------------
  // Helper: create a schema from an array of row objects
  // ----------------------------------------------------------------
  async function makeTable(rows) {
    const name = `los_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    // Infer schema from first row
    const first = rows[0];
    const coldefs = Object.keys(first).map(k => {
      const v = first[k];
      if (k.includes('date'))   return `"${k}" DATE`;
      if (typeof v === 'number') return `"${k}" DOUBLE`;
      return `"${k}" VARCHAR`;
    }).join(', ');
    await engine.runQuery(`CREATE TABLE ${name} (${coldefs})`);
    for (const r of rows) {
      const vals = Object.values(r).map(v => v === null ? 'NULL' : `'${v}'`).join(', ');
      await engine.runQuery(`INSERT INTO ${name} VALUES (${vals})`);
    }
    const cols = Object.keys(first).map(k => ({
      name: k,
      type: k.includes('date') ? 'DATE' : typeof first[k] === 'number' ? 'DOUBLE' : 'VARCHAR',
    }));
    return { name, cols };
  }

  // ================================================================
  // Test 1 — Clean data: no mismatch (los_days matches dates exactly)
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { admit_date: '2024-01-01', discharge_date: '2024-01-08', los_days: 7 },
      { admit_date: '2024-03-15', discharge_date: '2024-03-20', los_days: 5 },
      { admit_date: '2024-06-01', discharge_date: '2024-06-10', los_days: 9 },
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    ok(!findRule(findings, 'los_date_mismatch'), 'Clean data: no los_date_mismatch finding');
  }

  // ================================================================
  // Test 2 — Off-by-1 tolerance: 1-day difference should NOT fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { admit_date: '2024-01-01', discharge_date: '2024-01-08', los_days: 8 }, // 1 day off — OK
      { admit_date: '2024-03-15', discharge_date: '2024-03-20', los_days: 4 }, // 1 day off — OK
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    ok(!findRule(findings, 'los_date_mismatch'), 'Off-by-1 not flagged (within rounding tolerance)');
  }

  // ================================================================
  // Test 3 — Clear mismatch: 3-day discrepancy should fire
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { admit_date: '2024-07-04', discharge_date: '2024-07-05', los_days: 1 }, // correct: 1 day — OK
      { admit_date: '2024-07-15', discharge_date: '2024-08-03', los_days: 5 }, // wrong: actual=19, stored=5 → fires
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    const f = findRule(findings, 'los_date_mismatch');
    ok(!!f, 'Clear mismatch (19 days actual vs 5 stored): finding raised');
    ok(f?.count === 1, `Exactly 1 row flagged (got ${f?.count})`);
    ok(f?.columns?.includes('los_days'), 'Finding includes los_days column');
    ok(f?.columns?.includes('admit_date'), 'Finding includes admit_date column');
    ok(f?.columns?.includes('discharge_date'), 'Finding includes discharge_date column');
  }

  // ================================================================
  // Test 4 — Multiple mismatched rows
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { admit_date: '2024-01-01', discharge_date: '2024-01-10', los_days: 9 }, // OK (1-day diff)
      { admit_date: '2024-02-01', discharge_date: '2024-02-15', los_days: 3  }, // wrong: actual=14 stored=3
      { admit_date: '2024-03-01', discharge_date: '2024-03-20', los_days: 25 }, // wrong: actual=19 stored=25
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    const f = findRule(findings, 'los_date_mismatch');
    ok(!!f, 'Multiple mismatches: finding raised');
    ok(f?.count === 2, `Exactly 2 rows flagged (got ${f?.count})`);
  }

  // ================================================================
  // Test 5 — No LOS column: rule silently skipped, no error
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { admit_date: '2024-01-01', discharge_date: '2024-01-08', some_other_field: 99 },
    ]);
    let threw = false;
    try {
      await runCrossColumnChecks(name, cols, engine);
    } catch { threw = true; }
    ok(!threw, 'No LOS column: runner does not throw');
  }

  // ================================================================
  // Test 6 — Column named length_of_stay also detected
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { admit_date: '2024-05-01', discharge_date: '2024-05-10', length_of_stay: 2 }, // wrong: actual=9 stored=2
    ]);
    // Override col type so the tokenizer picks it up as numeric
    const adjustedCols = cols.map(c => c.name === 'length_of_stay' ? { ...c, type: 'DOUBLE' } : c);
    const findings = await runCrossColumnChecks(name, adjustedCols, engine);
    const f = findRule(findings, 'los_date_mismatch');
    ok(!!f, 'Column named "length_of_stay" also triggers the rule');
  }

  // ================================================================
  // Results
  // ================================================================
  console.log(`\nLOS date mismatch tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
