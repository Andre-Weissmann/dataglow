// ============================================================
// DATAGLOW — Digital Twin What-If Simulator test suite
// ============================================================
// Exercises js/digital-twin.js (the pure perturbation engine the UI uses) plus
// its end-to-end effect on the REAL validation pipeline:
//   1. Slider inference off a live schema (MIMIC-like columns).
//   2. Perturbing an in-memory COPY (20% missing injection) and re-running the
//      exact same runAllLayers + Confidence-Calibrated Grades path the UI runs.
//   3. Asserting the simulated grade/flags actually worsen in the expected
//      direction relative to the unperturbed baseline.
//   4. HARD isolation guarantee — the caller's rows are byte-for-byte identical
//      after perturbation (deep-equality against a pre-perturbation snapshot).
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/digital-twin.test.mjs
//
// The production modules import '../js/duckdb-engine.js'; the loader hook
// transparently redirects that to the native node-duckdb-engine.mjs.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';

import { runAllLayers } from '../js/validation/validation.js';
import {
  inferPerturbations, perturbRows, hasActivePerturbation, gradeDelta,
  isNumericType, isCategoricalCol,
} from '../js/simulation/digital-twin.js';
import { clearLedger } from '../js/provenance/assumption-ledger.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return {
    table,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    rowCount: rows.length,
    loadedAt: Date.now(),
  };
}

// Load an arbitrary rows array into a fresh table and return a ds descriptor —
// this mirrors exactly what the UI does: perturb → load copy → runAllLayers.
async function dsFromRows(table, rows) {
  return makeDataset(table, rows);
}

const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F'];
const gradeIdx = g => GRADE_ORDER.indexOf(g);

async function main() {
  clearLedger();

  // A clean, MIMIC-like dataset: an id key, a numeric vital, a numeric amount,
  // and a categorical admission type. All non-null, no duplicates, past dates.
  const baseRows = [];
  for (let i = 1; i <= 120; i++) {
    baseRows.push({
      patient_id: i,
      heart_rate: 60 + (i % 40),
      claim_amount: Math.round((100 + i * 13.5) * 100) / 100,
      admission_type: ['EW EMER.', 'ELECTIVE', 'URGENT', 'DIRECT EMER.'][i % 4],
      admit_date: `20${10 + (i % 10)}-06-${String((i % 27) + 1).padStart(2, '0')}`,
    });
  }
  const columns = [
    { name: 'patient_id', type: 'BIGINT' },
    { name: 'heart_rate', type: 'BIGINT' },
    { name: 'claim_amount', type: 'DOUBLE' },
    { name: 'admission_type', type: 'VARCHAR' },
    { name: 'admit_date', type: 'DATE' },
  ];

  // ============================================================
  // 1 — Slider inference reflects the actual schema.
  // ============================================================
  const sliders = inferPerturbations(columns);
  ok(sliders.some(s => s.kind === 'duplicate'),
    'infer: a global duplicate-rows slider is always offered');
  ok(sliders.some(s => s.key === 'missing:patient_id'),
    'infer: a missing-value slider is offered for a column');
  ok(sliders.some(s => s.key === 'outlier:claim_amount'),
    'infer: an outlier slider is offered for a numeric column');
  ok(sliders.some(s => s.key === 'drift:admission_type'),
    'infer: a category-drift slider is offered for a categorical column');
  ok(!sliders.some(s => s.key === 'outlier:admission_type'),
    'infer: no outlier slider on a text column');
  ok(isNumericType('DOUBLE') && !isNumericType('VARCHAR'),
    'infer: numeric-type detection is correct');
  ok(isCategoricalCol({ name: 'admission_type', type: 'VARCHAR' }) &&
     !isCategoricalCol({ name: 'admit_date', type: 'DATE' }),
    'infer: categorical detection excludes date-like columns');

  ok(!hasActivePerturbation({}) && hasActivePerturbation({ 'missing:patient_id': 20 }),
    'infer: hasActivePerturbation distinguishes baseline from an active knob');

  // ============================================================
  // 2 — HARD isolation guarantee: perturbRows never mutates its input.
  // ============================================================
  const snapshot = JSON.parse(JSON.stringify(baseRows));
  const knobs = { 'missing:patient_id': 20 }; // inject 20% missing into the key
  const { rows: perturbed } = perturbRows(baseRows, columns, knobs);
  ok(JSON.stringify(baseRows) === JSON.stringify(snapshot),
    'isolation: the caller\'s rows are byte-for-byte identical after perturbRows');
  ok(perturbed !== baseRows && perturbed[0] !== baseRows[0],
    'isolation: the returned rows are a distinct deep copy (new array + new row objects)');
  const missingCount = perturbed.filter(r => r.patient_id == null).length;
  ok(missingCount === Math.round(baseRows.length * 0.20),
    `isolation: ~20% of the COPY's key values were nulled (${missingCount}/${baseRows.length})`);

  // ============================================================
  // 3 — End-to-end: the same perturbation worsens grades vs. baseline.
  // ============================================================
  // Baseline: zero perturbation on the identical sample (apples-to-apples).
  const baselineDs = await dsFromRows('twin_baseline', perturbRows(baseRows, columns, {}).rows);
  const baseResults = await runAllLayers(baselineDs, { pack: 'healthcare' });
  const baseIntegrity = baseResults.calibratedGrades.integrity.grade;

  // Simulated: 30% missing keys + 30% outliers into a numeric column — this
  // should trip the unit-test (blank keys) + outlier layers.
  const simKnobs = { 'missing:patient_id': 30, 'outlier:claim_amount': 30 };
  const { rows: simRows } = perturbRows(baseRows, columns, simKnobs);
  const simDs = await dsFromRows('twin_sim', simRows);
  const simResults = await runAllLayers(simDs, { pack: 'healthcare' });
  const simIntegrity = simResults.calibratedGrades.integrity.grade;

  ok(gradeIdx(simIntegrity) >= gradeIdx(baseIntegrity),
    `e2e: simulated integrity grade is no better than baseline (baseline=${baseIntegrity}, sim=${simIntegrity})`);
  ok(gradeIdx(simIntegrity) > gradeIdx(baseIntegrity),
    `e2e: injecting missing keys + outliers strictly worsened the integrity grade (${baseIntegrity} → ${simIntegrity})`);
  ok(simResults.unit_tests.status === 'fail' || simResults.unit_tests.status === 'warn',
    `e2e: the Unit Test layer now flags the injected defects (status=${simResults.unit_tests.status})`);

  // gradeDelta sign convention: worse simulated grade → negative delta.
  ok(gradeDelta(baseIntegrity, simIntegrity) < 0,
    'e2e: gradeDelta reports a negative (worse) delta for the degraded twin');

  // ============================================================
  // 4 — Duplicate perturbation adds synthetic rows to the COPY only.
  // ============================================================
  const { rows: dupRows, manifest } = perturbRows(baseRows, columns, { duplicate: 50 });
  ok(dupRows.length > baseRows.length && baseRows.length === snapshot.length,
    'dup: duplicate knob grows the COPY while the original length is unchanged');
  ok(manifest.syntheticRows > 0 && manifest.applied.some(a => a.kind === 'duplicate'),
    'dup: the manifest records the synthetic duplicate rows');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
