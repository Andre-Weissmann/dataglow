// ============================================================
// DATAGLOW — Missingness Detective test suite
// ============================================================
// Three halves:
//   1. Pure statistical helpers — classifyCategoricalDriver / classifyNumericDriver /
//      looksCoreField / mnarCaution / prioritiseDrivers / buildColumnReport,
//      driven by synthetic inputs (no DB), proving the MAR effect-size logic and
//      the conservative, clearly-labelled MNAR heuristic in isolation.
//   2. The async runner against a REAL (native) DuckDB table:
//        · a clear categorical MAR pattern (missingness of A depends on B's group),
//        · a clear numeric MAR pattern (missingness depends on another column's mean),
//        · a default-to-MCAR case (no observed column explains the missingness),
//        · a conservative, clearly-labelled MNAR caution on a heavily-missing core field.
//   3. Guardrails: trivial missingness is ignored; MNAR is NOT raised for
//      optional/low-missingness fields.
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/missingness-detective.test.mjs

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import * as engine from './node-duckdb-engine.mjs';

import {
  classifyCategoricalDriver, classifyNumericDriver, looksCoreField, mnarCaution,
  prioritiseDrivers, buildColumnReport, runMissingnessDetective, MISSINGNESS_NOTE,
} from '../js/validation/missingness-detective.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return schema.map(s => ({ name: s.column_name, type: s.column_type }));
}
const findByColumn = (fs, col) => fs.find(f => f.column === col);

async function main() {
  // ============================================================
  // 1. Pure helpers
  // ============================================================

  // --- classifyCategoricalDriver: clear spread across adequately-sized groups.
  {
    const d = classifyCategoricalDriver([
      { group: 'ER', n: 30, missingRate: 0.60 },
      { group: 'Scheduled', n: 40, missingRate: 0.05 },
    ]);
    ok(d && d.kind === 'categorical', 'cat-driver: fires on a clear per-group spread');
    ok(d && d.high.group === 'ER' && d.low.group === 'Scheduled', 'cat-driver: names the high/low groups');
    ok(d && Math.abs(d.diff - 0.55) < 1e-9, 'cat-driver: reports the percentage-point spread as effect size');
  }
  // --- No spread → no driver.
  {
    const d = classifyCategoricalDriver([
      { group: 'A', n: 50, missingRate: 0.12 },
      { group: 'B', n: 50, missingRate: 0.13 },
      { group: 'C', n: 50, missingRate: 0.11 },
    ]);
    ok(d === null, 'cat-driver: flat missing-rate across groups → no driver (MCAR-consistent)');
  }
  // --- A huge spread confined to a TINY group must NOT fire (spurious).
  {
    const d = classifyCategoricalDriver([
      { group: 'big', n: 500, missingRate: 0.10 },
      { group: 'tiny', n: 3, missingRate: 0.90 }, // below MIN_GROUP_N → ignored
    ]);
    ok(d === null, 'cat-driver: spread driven only by a tiny (n<20) group is ignored — no spurious MAR');
  }
  // --- Ratio path: low base but big multiplicative jump on large groups.
  {
    const d = classifyCategoricalDriver([
      { group: 'X', n: 100, missingRate: 0.04 },
      { group: 'Y', n: 100, missingRate: 0.12 }, // 3x, diff only 8pp
    ]);
    ok(d && d.kind === 'categorical', 'cat-driver: fires on a large ratio even when the absolute spread is under 15pp');
  }

  // --- classifyNumericDriver: clear mean separation → fires.
  {
    const d = classifyNumericDriver({
      missingN: 40, presentN: 60,
      missingMean: 70, presentMean: 30,
      missingStd: 8, presentStd: 8,
    });
    ok(d && d.kind === 'numeric' && d.higherWhenMissing === true, 'num-driver: fires + notes value is higher when target is missing');
    ok(d && d.separation > 0.5, 'num-driver: reports a standardised separation (Cohen\'s d) above the medium threshold');
  }
  // --- No separation → no driver.
  {
    const d = classifyNumericDriver({
      missingN: 40, presentN: 60,
      missingMean: 30.2, presentMean: 30.0,
      missingStd: 10, presentStd: 10,
    });
    ok(d === null, 'num-driver: near-identical means → no numeric driver');
  }
  // --- Too few missing rows → no driver (avoid tiny-sample separation).
  {
    const d = classifyNumericDriver({
      missingN: 4, presentN: 200,
      missingMean: 90, presentMean: 30,
      missingStd: 5, presentStd: 5,
    });
    ok(d === null, 'num-driver: too few missing rows (n<20) → skipped, no spurious separation');
  }

  // --- looksCoreField / mnarCaution: conservative, name + rate gated.
  ok(looksCoreField('income') === true, 'core-field: "income" reads as a core/expected field');
  ok(looksCoreField('patient_age') === true, 'core-field: compound "patient_age" reads as core (robust tokenisation)');
  ok(looksCoreField('optional_comment') === false, 'core-field: "optional_comment" is not a core field');
  ok(mnarCaution('income', 0.45) === true, 'mnar: core field missing 45% → conservative MNAR caution raised');
  ok(mnarCaution('income', 0.10) === false, 'mnar: core field missing only 10% → no caution (rate gate)');
  ok(mnarCaution('optional_note', 0.80) === false, 'mnar: non-core field, even at 80% missing → no caution (name gate)');

  // --- prioritiseDrivers: low-cardinality categoricals first, target excluded, capped.
  {
    const cols = [
      { name: 'target', type: 'VARCHAR' },
      { name: 'hi_card', type: 'VARCHAR' },
      { name: 'lo_card', type: 'VARCHAR' },
      { name: 'num1', type: 'DOUBLE' },
    ];
    const ordered = prioritiseDrivers('target', cols, { hi_card: 500, lo_card: 3 });
    ok(!ordered.some(c => c.name === 'target'), 'prioritise: target column is excluded from its own drivers');
    ok(ordered[0].name === 'lo_card', 'prioritise: lowest-cardinality categorical ranked first');
    ok(ordered[ordered.length - 1].name === 'num1', 'prioritise: numeric candidates ranked after categoricals');
    const capped = prioritiseDrivers('target', cols, { hi_card: 500, lo_card: 3 }, 2);
    ok(capped.length === 2, 'prioritise: respects the candidate cap');
  }

  // --- buildColumnReport: wording carries classification, driver, effect, why + MNAR framing.
  {
    const rep = buildColumnReport({
      column: 'insurance_type', type: 'VARCHAR', isNumeric: false,
      missingRate: 0.30, missingCount: 21,
      driver: { kind: 'categorical', column: 'visit_type', diff: 0.55, ratio: 12,
        high: { group: 'ER', rate: 0.60, n: 30 }, low: { group: 'Scheduled', rate: 0.05, n: 40 } },
      mnar: false,
    });
    ok(rep.classification === 'MAR' && rep.driverColumn === 'visit_type', 'report: MAR classification names the driver column');
    ok(/visit_type/.test(rep.narrative) && /MAR/.test(rep.narrative), 'report: narrative names the driver and the MAR term');
    ok(/bias/i.test(rep.why), 'report: "why it matters" warns about bias from dropping rows');
    ok(rep.mnarCaution === false && !rep.mnarNote, 'report: no MNAR note when caution is off');
  }
  {
    const rep = buildColumnReport({
      column: 'field_x', type: 'DOUBLE', isNumeric: true,
      missingRate: 0.20, missingCount: 12, driver: null, mnar: false,
    });
    ok(rep.classification === 'MCAR' && /does NOT prove/i.test(rep.narrative),
      'report: MCAR default is explicitly not claimed as proof of randomness');
  }
  {
    const rep = buildColumnReport({
      column: 'income', type: 'DOUBLE', isNumeric: true,
      missingRate: 0.40, missingCount: 20, driver: null, mnar: true,
    });
    ok(rep.mnarCaution === true && /HYPOTHESIS/.test(rep.mnarNote) && /cannot be proven/i.test(rep.mnarNote),
      'report: MNAR note is present and clearly framed as an unprovable hypothesis');
  }
  ok(typeof MISSINGNESS_NOTE === 'string' && /MCAR/.test(MISSINGNESS_NOTE) && /cannot be verified/i.test(MISSINGNESS_NOTE),
    'note: taxonomy note present and explains MNAR cannot be verified from data alone');

  // ============================================================
  // 2. Runner against a real DuckDB table
  // ============================================================

  // --- (a) Clear categorical MAR: insurance_type missingness depends on visit_type.
  {
    const rows = [];
    // 30 ER rows, 18 missing insurance (60%).
    for (let i = 0; i < 30; i++) rows.push({ visit_type: 'ER', insurance_type: i < 18 ? null : 'PPO' });
    // 40 Scheduled rows, 2 missing insurance (5%).
    for (let i = 0; i < 40; i++) rows.push({ visit_type: 'Scheduled', insurance_type: i < 2 ? null : 'HMO' });
    const cols = await makeDataset('md_mar_cat', rows);
    const { findings, analyzed } = await runMissingnessDetective('md_mar_cat', cols, engine);
    const f = findByColumn(findings, 'insurance_type');
    ok(analyzed.some(a => a.column === 'insurance_type'), 'run(MAR-cat): insurance_type analysed (above threshold)');
    ok(f && f.classification === 'MAR', 'run(MAR-cat): classified as likely MAR');
    ok(f && f.driverColumn === 'visit_type', 'run(MAR-cat): correctly identifies visit_type as the driver');
    ok(f && f.driver && f.driver.high.group === 'ER', 'run(MAR-cat): flags ER as the high-missingness group');
    // visit_type itself is fully populated → must not be flagged.
    ok(!findByColumn(findings, 'visit_type'), 'run(MAR-cat): the fully-populated driver column is not itself flagged');
  }

  // --- (b) Clear numeric MAR: field_b missingness depends on age.
  {
    const rows = [];
    // 20 rows missing field_b, all with HIGH age (60–79).
    for (let i = 0; i < 20; i++) rows.push({ age: 60 + i, field_b: null });
    // 50 rows present, all with LOW age (20–39, cycled).
    for (let i = 0; i < 50; i++) rows.push({ age: 20 + (i % 20), field_b: i * 1.0 });
    const cols = await makeDataset('md_mar_num', rows);
    const { findings } = await runMissingnessDetective('md_mar_num', cols, engine);
    const f = findByColumn(findings, 'field_b');
    ok(f && f.classification === 'MAR' && f.driverColumn === 'age', 'run(MAR-num): field_b classified MAR, driven by age');
    ok(f && f.driver && f.driver.kind === 'numeric' && f.driver.higherWhenMissing === true,
      'run(MAR-num): notes field_b is missing more when age is higher');
  }

  // --- (c) Default MCAR: field_c missingness unrelated to region or amount.
  {
    const rows = [];
    for (let i = 0; i < 60; i++) {
      const region = ['A', 'B', 'C'][i % 3];
      const missing = i % 7 === 0;            // ~15%, evenly spread across regions
      rows.push({ region, amount: i % 50, field_c: missing ? null : i * 1.0 });
    }
    const cols = await makeDataset('md_mcar', rows);
    const { findings } = await runMissingnessDetective('md_mcar', cols, engine);
    const f = findByColumn(findings, 'field_c');
    ok(f && f.classification === 'MCAR', 'run(MCAR): no observed driver found → defaults to MCAR');
    ok(f && f.driverColumn === null && /does NOT prove/i.test(f.narrative),
      'run(MCAR): reports no driver and does not overclaim true randomness');
    ok(f && f.mnarCaution === false, 'run(MCAR): non-core, moderate-missingness field raises no MNAR caution');
  }

  // --- (d) MNAR caution: a core field ("income") missing heavily, no driver.
  {
    const rows = [];
    for (let i = 0; i < 50; i++) {
      const region = ['A', 'B', 'C', 'D', 'E'][i % 5];
      // 40% missing, spread evenly across regions so there is NO MAR driver…
      const missing = i % 5 < 2;
      rows.push({ region, income: missing ? null : 1000 + i });
    }
    const cols = await makeDataset('md_mnar', rows);
    const { findings } = await runMissingnessDetective('md_mnar', cols, engine);
    const f = findByColumn(findings, 'income');
    ok(f && f.mnarCaution === true, 'run(MNAR): heavily-missing core field "income" raises the MNAR caution');
    ok(f && /HYPOTHESIS/.test(f.mnarNote || ''), 'run(MNAR): the caution is clearly labelled as a hypothesis, not a finding');
    ok(f && f.classification === 'MCAR', 'run(MNAR): with no observed driver the primary class stays MCAR; MNAR is an added caution');
  }

  // ============================================================
  // 3. Guardrails
  // ============================================================

  // --- Trivial missingness (below threshold) is ignored entirely.
  {
    const rows = [];
    for (let i = 0; i < 200; i++) rows.push({ region: i % 2 ? 'A' : 'B', measure: i === 0 ? null : i }); // 0.5% missing
    const cols = await makeDataset('md_trivial', rows);
    const { findings, analyzed } = await runMissingnessDetective('md_trivial', cols, engine);
    ok(!analyzed.some(a => a.column === 'measure') && !findByColumn(findings, 'measure'),
      'run(trivial): 0.5%-missing column is below threshold → not analysed');
  }

  // --- No column with meaningful missingness → empty result.
  {
    const rows = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3, b: 'z' }];
    const cols = await makeDataset('md_clean', rows);
    const { findings, analyzed } = await runMissingnessDetective('md_clean', cols, engine);
    ok(analyzed.length === 0 && findings.length === 0, 'run(clean): fully-populated table → nothing analysed or flagged');
  }

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
