// ============================================================
// DATAGLOW — Readmission flag logical consistency test suite
// ============================================================
// Tests Rule 5 added to cross-column-consistency.js:
//   readmit_flag_inconsistency — flags rows where readmit_30d = 1
//   but readmit_90d = 0, which is a logical impossibility (30-day
//   window is a strict subset of the 90-day window).
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/readmit-flag-consistency.test.mjs

import * as engine from './node-duckdb-engine.mjs';
import { runCrossColumnChecks } from '../js/validation/cross-column-consistency.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else       { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}
const findRule = (fs, rule) => fs.find(f => f.rule === rule);

// ----------------------------------------------------------------
// Helper: create a table from row objects
// ----------------------------------------------------------------
async function makeTable(rows, typeOverrides = {}) {
  const name = `readmit_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const first = rows[0];
  const coldefs = Object.keys(first).map(k => {
    const override = typeOverrides[k];
    if (override) return `"${k}" ${override}`;
    const v = first[k];
    if (typeof v === 'number') return `"${k}" INTEGER`;
    return `"${k}" VARCHAR`;
  }).join(', ');
  await engine.runQuery(`CREATE TABLE ${name} (${coldefs})`);
  for (const r of rows) {
    const vals = Object.values(r).map(v => v === null ? 'NULL' : `'${v}'`).join(', ');
    await engine.runQuery(`INSERT INTO ${name} VALUES (${vals})`);
  }
  const cols = Object.keys(first).map(k => ({
    name: k,
    type: typeOverrides[k] || (typeof first[k] === 'number' ? 'INTEGER' : 'VARCHAR'),
  }));
  return { name, cols };
}

async function main() {

  // ================================================================
  // Test 1 — Clean data: valid combinations only, no finding
  // readmit_30d=0,readmit_90d=0  — no readmit at all        — valid
  // readmit_30d=0,readmit_90d=1  — readmit on days 31-90    — valid
  // readmit_30d=1,readmit_90d=1  — readmit within 30 days   — valid
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { readmit_30d: 0, readmit_90d: 0 },
      { readmit_30d: 0, readmit_90d: 1 },
      { readmit_30d: 1, readmit_90d: 1 },
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    ok(!findRule(findings, 'readmit_flag_inconsistency'), 'Clean valid combinations: no finding raised');
  }

  // ================================================================
  // Test 2 — Impossible combination fires: readmit_30d=1, readmit_90d=0
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { readmit_30d: 1, readmit_90d: 1 }, // valid
      { readmit_30d: 1, readmit_90d: 0 }, // IMPOSSIBLE — fires
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    const f = findRule(findings, 'readmit_flag_inconsistency');
    ok(!!f, 'readmit_30d=1 / readmit_90d=0: finding raised');
    ok(f?.count === 1, `Exactly 1 row flagged (got ${f?.count})`);
    ok(f?.columns?.includes('readmit_30d'), 'Finding references readmit_30d column');
    ok(f?.columns?.includes('readmit_90d'), 'Finding references readmit_90d column');
    ok(f?.explanation?.includes('HRRP'), 'Explanation mentions HRRP quality metrics');
  }

  // ================================================================
  // Test 3 — Multiple impossible rows flagged with correct count
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { readmit_30d: 0, readmit_90d: 0 }, // valid
      { readmit_30d: 1, readmit_90d: 0 }, // IMPOSSIBLE
      { readmit_30d: 0, readmit_90d: 1 }, // valid (days 31-90)
      { readmit_30d: 1, readmit_90d: 0 }, // IMPOSSIBLE
      { readmit_30d: 1, readmit_90d: 1 }, // valid
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    const f = findRule(findings, 'readmit_flag_inconsistency');
    ok(!!f, 'Multiple impossible rows: finding raised');
    ok(f?.count === 2, `Exactly 2 rows flagged (got ${f?.count})`);
  }

  // ================================================================
  // Test 4 — String encodings: 'true'/'false', 'yes'/'no', 'y'/'n'
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { readmit_30d: 'true',  readmit_90d: 'false' }, // IMPOSSIBLE
      { readmit_30d: 'yes',   readmit_90d: 'no'    }, // IMPOSSIBLE
      { readmit_30d: 'y',     readmit_90d: 'n'     }, // IMPOSSIBLE
      { readmit_30d: '1',     readmit_90d: '0'     }, // IMPOSSIBLE
      { readmit_30d: 'false', readmit_90d: 'true'  }, // valid (days 31-90)
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    const f = findRule(findings, 'readmit_flag_inconsistency');
    ok(!!f, 'String encodings (true/false, yes/no, y/n, 1/0): finding raised');
    ok(f?.count === 4, `All 4 string-encoded impossible rows flagged (got ${f?.count})`);
  }

  // ================================================================
  // Test 5 — NULL rows silently skipped (IS NOT NULL guard)
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { readmit_30d: null, readmit_90d: 0    }, // NULL 30d — skip
      { readmit_30d: 1,    readmit_90d: null }, // NULL 90d — skip
      { readmit_30d: null, readmit_90d: null }, // both NULL — skip
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    ok(!findRule(findings, 'readmit_flag_inconsistency'), 'NULL rows: not flagged (IS NOT NULL guard)');
  }

  // ================================================================
  // Test 6 — No readmit columns: rule silently skipped, no error
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { patient_id: 'PT001', los_days: 5 },
    ]);
    let threw = false;
    try { await runCrossColumnChecks(name, cols, engine); }
    catch { threw = true; }
    ok(!threw, 'No readmit columns: runner does not throw');
  }

  // ================================================================
  // Test 7 — camelCase column names (readmit30d / readmit90d)
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { readmit30d: 1, readmit90d: 0 }, // IMPOSSIBLE — camelCase
      { readmit30d: 1, readmit90d: 1 }, // valid
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    const f = findRule(findings, 'readmit_flag_inconsistency');
    ok(!!f, 'camelCase columns (readmit30d / readmit90d): rule still fires');
    ok(f?.count === 1, `1 row flagged in camelCase scenario (got ${f?.count})`);
  }

  // ================================================================
  // Test 8 — Alternate naming (readmission_30day / readmission_90day)
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { readmission_30day: 1, readmission_90day: 0 }, // IMPOSSIBLE
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    const f = findRule(findings, 'readmit_flag_inconsistency');
    ok(!!f, 'Alternate naming (readmission_30day / readmission_90day): rule fires');
  }

  // ================================================================
  // Test 9 — readmit_90d=1 with readmit_30d=0 is VALID (days 31-90)
  //          This is the "debatable" combination Fable 5 flagged.
  //          DataGlow deliberately does NOT flag it.
  // ================================================================
  {
    const { name, cols } = await makeTable([
      { readmit_30d: 0, readmit_90d: 1 }, // valid — readmit on days 31-90
      { readmit_30d: 0, readmit_90d: 1 },
      { readmit_30d: 0, readmit_90d: 1 },
    ]);
    const findings = await runCrossColumnChecks(name, cols, engine);
    ok(!findRule(findings, 'readmit_flag_inconsistency'), 'readmit_90d=1 with readmit_30d=0 is valid: NOT flagged (days 31-90 readmit)');
  }

  // ================================================================
  // Results
  // ================================================================
  console.log(`\nReadmit flag consistency tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
