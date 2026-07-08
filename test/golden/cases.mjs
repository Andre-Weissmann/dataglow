// ============================================================
// DATAGLOW — Golden Regression Suite: case definitions
// ============================================================
// Each case is a { name, run } pair. `run()` returns a JSON-serialisable value
// that is the DETERMINISTIC output of one core, high-risk DATAGLOW operation.
// The runner (index.test.mjs) canonicalises that value and diffs it against a
// versioned fixture in ./fixtures/<name>.json. If the output changes, the diff
// fails the suite — a silent behaviour change becomes a loud, reviewable one.
//
// The cases below are chosen from the highest-risk deterministic surfaces in
// docs/capability-map.md — the SQL-generating cleaners, the validation-layer
// orchestrator, the cross-column / bounds checkers, and the calibrated grade
// roll-up. They are the behaviours a future feature (often added quickly by an
// AI agent) is most likely to break without noticing.
//
// Production modules are imported by their real relative paths and run
// byte-for-byte unmodified. Any module that reaches for the browser DuckDB
// engine (import '../js/duckdb-engine.js') is transparently redirected to the
// native node engine by test/duckdb-loader-hook.mjs — the SAME mechanism the
// existing SQL logic suite uses. That is why this file must be run with:
//   node --import ./test/duckdb-loader-hook.mjs test/golden/index.test.mjs

// ---- setup helpers (test-only; bypass the loader hook) ----
import { createTableFromObjects, getTableSchema } from '../node-duckdb-engine.mjs';
import * as engine from '../node-duckdb-engine.mjs';

// ---- production modules under test (resolved through the loader hook) ----
import { buildGroupedImputationSQL, previewGroupedImputation } from '../../js/imputation.js';
import { scanFormatIssues } from '../../js/format-fingerprint.js';
import { runAllLayers } from '../../js/validation.js';
import { computeCalibratedGrades } from '../../js/calibrated-grades.js';
import {
  runCrossColumnChecks,
  detectDatePairs, detectRangePairs, detectStatusPairs,
  detectSexColumn, detectPregnancyColumns, detectAgeColumn, detectMaritalColumn,
  detectAdultOnlyFlags, isMaleValue, isAffirmative, maritalImpliesAdult, isAbnormalStatus,
} from '../../js/cross-column-consistency.js';
import {
  runUpperBoundChecks, matchBoundedType, decideBound,
} from '../../js/upper-bound-sanity.js';

// ------------------------------------------------------------
// Fixed sample datasets. These are the "golden inputs" — never change them
// casually, because every fixture is captured against exactly these rows.
// ------------------------------------------------------------

// A deliberately messy clinical-style dataset that lights up many layers at
// once: negative claim amounts, a future admit date, out-of-order admit/
// discharge dates, a minor with an adult-only flag, near-duplicate country
// spellings, a duplicate row, a null key, and an impossible success_rate.
const CLINICAL_ROWS = [
  { patient_id: 'P001', sex: 'M', age: 54, admit_date: '2024-01-10', discharge_date: '2024-01-14', has_retirement_account: 'true', claim_amount: '1200.50', success_rate: '92', country: 'France' },
  { patient_id: 'P002', sex: 'F', age: 41, admit_date: '2024-01-11', discharge_date: '2024-01-09', has_retirement_account: 'false', claim_amount: '3400.00', success_rate: '88', country: 'FRA' },
  { patient_id: 'P003', sex: 'F', age: 12, admit_date: '2024-01-12', discharge_date: '2024-01-15', has_retirement_account: 'true', claim_amount: '250.00', success_rate: '75', country: 'French' },
  { patient_id: 'P004', sex: 'M', age: 67, admit_date: '2024-01-13', discharge_date: '2024-01-13', has_retirement_account: 'true', claim_amount: '-50.00', success_rate: '81', country: 'Germany' },
  { patient_id: 'P005', sex: 'F', age: 33, admit_date: '2099-01-01', discharge_date: '2099-01-05', has_retirement_account: 'false', claim_amount: '900.00', success_rate: '150', country: 'Germany' },
  { patient_id: 'P006', sex: 'M', age: 29, admit_date: '2024-01-15', discharge_date: '2024-01-14', has_retirement_account: 'false', claim_amount: '-10.00', success_rate: '64', country: 'Deutschland' },
  { patient_id: 'P007', sex: 'F', age: 45, admit_date: '2024-01-16', discharge_date: '2024-01-20', has_retirement_account: 'true', claim_amount: '5600.00', success_rate: '99', country: 'Germany' },
  { patient_id: 'P008', sex: 'M', age: 8, admit_date: '2024-01-17', discharge_date: '2024-01-18', has_retirement_account: 'true', claim_amount: '75.00', success_rate: '55', country: 'France' },
  { patient_id: 'P008', sex: 'M', age: 8, admit_date: '2024-01-17', discharge_date: '2024-01-18', has_retirement_account: 'true', claim_amount: '75.00', success_rate: '55', country: 'France' },
  { patient_id: null, sex: 'F', age: 51, admit_date: '2024-01-19', discharge_date: '2024-01-22', has_retirement_account: 'false', claim_amount: '4100.00', success_rate: '70', country: 'France' },
];

// A grouped-imputation dataset with a clear group structure and nulls to fill.
const IMPUTE_ROWS = [
  { region: 'north', score: '10' },
  { region: 'north', score: '20' },
  { region: 'north', score: null },
  { region: 'south', score: '100' },
  { region: 'south', score: '200' },
  { region: 'south', score: '300' },
  { region: 'south', score: null },
  { region: 'east', score: null },
];

// A format-contaminated dataset: currency text, mixed date formats, fake nulls.
const FORMAT_ROWS = [
  { amount: '$1,200.50', dt: '2024-01-15', note: 'N/A' },
  { amount: '$3,400.00', dt: '01/15/2024', note: 'ok' },
  { amount: '$25.99', dt: '2024-02-20', note: 'n/a' },
  { amount: '$1,000.00', dt: '03/22/2024', note: 'NULL' },
  { amount: '$99.00', dt: '2024-04-01', note: 'fine' },
];

// A bounded-quantity dataset: a percentage column that breaks 0–100 and a
// proportion column that breaks 0–1.
const BOUNDS_ROWS = [
  { completion_pct: '92', win_probability: '0.4' },
  { completion_pct: '150', win_probability: '0.8' },
  { completion_pct: '-5', win_probability: '1.3' },
  { completion_pct: '78', win_probability: '0.6' },
  { completion_pct: '64', win_probability: '0.9' },
];

// Build a { table, cols, rowCount } dataset the same way validation expects.
async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return {
    table,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    rowCount: rows.length,
  };
}

// A synthetic layer-results object for the pure calibrated-grades case, so the
// grade roll-up is exercised without depending on the full layer run.
function syntheticResults(overrides = {}) {
  const base = {
    unit_tests: { status: 'pass' },
    cross_column_logic: { status: 'warn' },
    categorical_consistency: { status: 'pass' },
    schema_fingerprint: { status: 'pass' },
    sanity_anchor: { status: 'pass' },
    reproducibility: { status: 'pass' },
    physiological_plausibility: { status: 'fail' },
    distribution_drift: { status: 'idle' },
    semantic_drift: { status: 'warn' },
    outlier_detection: { status: 'warn' },
    benford: { status: 'pass' },
    correlation_watchdog: { status: 'pass' },
  };
  return { ...base, ...overrides };
}

// Snapshot only the STATUS of each layer (plus the deterministic grade roll-up
// and confidence grade). Statuses are the stable, high-signal regression
// target: any layer flipping pass/warn/fail/idle is exactly what we want to
// catch, without coupling the fixture to volatile timestamps or prose.
function layerStatuses(results) {
  const statuses = {};
  for (const [layer, r] of Object.entries(results)) {
    if (r && typeof r === 'object' && typeof r.status === 'string') {
      statuses[layer] = r.status;
    }
  }
  return statuses;
}

export function buildCases() {
  return [
    // ---- Pure: calibrated two-axis grade roll-up ----
    {
      name: 'calibrated-grades',
      async run() {
        const clean = computeCalibratedGrades({
          results: syntheticResults({ physiological_plausibility: { status: 'pass' }, cross_column_logic: { status: 'pass' }, semantic_drift: { status: 'pass' }, outlier_detection: { status: 'pass' } }),
          packName: 'healthcare', packLabel: 'Healthcare',
        });
        const degraded = computeCalibratedGrades({
          results: syntheticResults(),
          packName: 'healthcare', packLabel: 'Healthcare',
        });
        // Same degraded data, but the domain pack reinterpreted the physiology
        // flag — Domain Confidence should recover some credit.
        const reinterpreted = computeCalibratedGrades({
          results: syntheticResults(),
          packName: 'healthcare', packLabel: 'Healthcare',
          annotations: [{ layer: 'physiological_plausibility' }],
        });
        return { clean, degraded, reinterpreted };
      },
    },

    // ---- Pure: cross-column detector + value classifiers ----
    {
      name: 'cross-column-detectors',
      async run() {
        const cols = [
          { name: 'admit_date', type: 'VARCHAR' },
          { name: 'discharge_date', type: 'VARCHAR' },
          { name: 'temp_min', type: 'DOUBLE' },
          { name: 'temp_max', type: 'DOUBLE' },
          { name: 'sex', type: 'VARCHAR' },
          { name: 'pregnant', type: 'VARCHAR' },
          { name: 'age', type: 'BIGINT' },
          { name: 'marital_status', type: 'VARCHAR' },
          { name: 'has_retirement_account', type: 'VARCHAR' },
          { name: 'glucose', type: 'DOUBLE' },
          { name: 'glucose_flag', type: 'VARCHAR' },
        ];
        return {
          datePairs: detectDatePairs(cols),
          rangePairs: detectRangePairs(cols),
          statusPairs: detectStatusPairs(cols),
          sexColumn: detectSexColumn(cols)?.name ?? null,
          pregnancyColumns: detectPregnancyColumns(cols).map(c => c.name),
          ageColumn: detectAgeColumn(cols)?.name ?? null,
          maritalColumn: detectMaritalColumn(cols)?.name ?? null,
          adultOnlyFlags: detectAdultOnlyFlags(cols).map(c => c.name),
          classifiers: {
            isMaleValue: ['M', 'male', 'F', 'x', '1'].map(v => [v, isMaleValue(v)]),
            isAffirmative: ['yes', 'true', '1', 'no', 'positive', ''].map(v => [v, isAffirmative(v)]),
            maritalImpliesAdult: ['married', 'single', 'divorced', 'widowed', 'never married'].map(v => [v, maritalImpliesAdult(v)]),
            isAbnormalStatus: ['abnormal', 'critical', 'normal', 'high', 'ok'].map(v => [v, isAbnormalStatus(v)]),
          },
        };
      },
    },

    // ---- Pure: bounded-type name classification + bound decision ----
    {
      name: 'upper-bound-classify',
      async run() {
        const names = [
          'completion_pct', 'success_rate', 'win_probability', 'flow_rate',
          'pe_ratio', 'growth_pct', 'heart_rate', 'discount_percentage', 'roi_percent',
        ];
        const classifications = names.map(n => [n, matchBoundedType(n)]);
        // decideBound over representative distributions.
        const distProportion = { n: 100, in01: 95, in0100: 100, min: 0, max: 1 };
        const distPercent = { n: 100, in01: 10, in0100: 98, min: 0, max: 100 };
        const distUnbounded = { n: 100, in01: 2, in0100: 40, min: 0, max: 5000 };
        const decisions = {
          percentage_over_percent: decideBound({ category: 'percentage', word: 'percentage' }, distPercent),
          proportion_over_prop: decideBound({ category: 'proportion', word: 'probability' }, distProportion),
          ambiguous_unbounded_skips: decideBound({ category: 'ambiguous', word: 'ratio' }, distUnbounded),
          ambiguous_proportion: decideBound({ category: 'ambiguous', word: 'ratio' }, distProportion),
        };
        return { classifications, decisions };
      },
    },

    // ---- Pure: generated grouped-imputation SQL ----
    {
      name: 'imputation-sql',
      async run() {
        return {
          single_group: buildGroupedImputationSQL('patients', 'score', ['region']),
          multi_group: buildGroupedImputationSQL('patients', 'bmi', ['region', 'sex']),
        };
      },
    },

    // ---- SQL: grouped-imputation preview against a real engine ----
    {
      name: 'sql-imputation-preview',
      async run() {
        await makeDataset('golden_impute', IMPUTE_ROWS);
        const p = await previewGroupedImputation('golden_impute', 'score', ['region']);
        // `sql` is snapshotted separately in imputation-sql; drop it here to keep
        // the fixture focused on the computed preview numbers + filled sample.
        const { sql, ...rest } = p;
        return rest;
      },
    },

    // ---- SQL: format-issue scan against a real engine ----
    {
      name: 'sql-format-issues',
      async run() {
        const ds = await makeDataset('golden_format', FORMAT_ROWS);
        const issues = await scanFormatIssues(ds.table, ds.cols);
        return { issues };
      },
    },

    // ---- SQL: cross-column consistency runner against a real engine ----
    {
      name: 'sql-cross-column-run',
      async run() {
        const ds = await makeDataset('golden_clinical_cc', CLINICAL_ROWS);
        const findings = await runCrossColumnChecks(ds.table, ds.cols, engine);
        return { findings };
      },
    },

    // ---- SQL: upper-bound sanity runner against a real engine ----
    {
      name: 'sql-upper-bound-run',
      async run() {
        const ds = await makeDataset('golden_bounds', BOUNDS_ROWS);
        const out = await runUpperBoundChecks(ds.table, ds.cols, engine);
        return out;
      },
    },

    // ---- SQL: the full validation-layer orchestrator (headline feature) ----
    // Captures each layer's status + the confidence grade + the two-axis grade
    // roll-up. This is the single most valuable regression signal: it asserts
    // that the whole 20-layer pipeline still reaches the same verdicts on a
    // fixed, deliberately-messy dataset.
    {
      name: 'sql-validation-layers',
      async run() {
        const ds = await makeDataset('golden_clinical_layers', CLINICAL_ROWS);
        const results = await runAllLayers(ds, { pack: 'healthcare' });
        return {
          statuses: layerStatuses(results),
          confidenceGrade: results.confidence?.grade ?? null,
          calibratedGrades: results.calibratedGrades ?? null,
        };
      },
    },
  ];
}
