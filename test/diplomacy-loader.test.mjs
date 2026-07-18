// test/diplomacy-loader.test.mjs
// Tests for js/diplomacy/diplomacy-loader.js (Batch 3)
// Node-only: no DOM, no DuckDB. Tests the pure buildDiplomacyFormModel() only.

import { ok, strictEqual, deepEqual } from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 FAILED: ' + name + '\n    ' + e.message); failed++; }
}

// ---- import ----------------------------------------------------------------
let buildDiplomacyFormModel;
try {
  const mod = await import('../js/diplomacy/diplomacy-loader.js');
  buildDiplomacyFormModel = mod.buildDiplomacyFormModel;
} catch (e) {
  console.error('Import failed:', e.message);
  process.exit(1);
}

const DS1 = { name: 'patients', table: 'patients_t', cols: ['patient_id', 'admit_date', 'discharge_date'] };
const DS2 = { name: 'claims', table: 'claims_t', cols: ['claim_id', 'patient_id', 'amount'] };

// ---- no datasets -----------------------------------------------------------
test('no datasets: hasDatasets is false', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [], currentValues: null });
  strictEqual(m.hasDatasets, false);
});

test('no datasets: datasetOptions is empty', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [], currentValues: null });
  deepEqual(m.datasetOptions, []);
});

test('no datasets: isComplete is false', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [], currentValues: null });
  strictEqual(m.isComplete, false);
});

test('null datasets handled gracefully', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: null, currentValues: null });
  strictEqual(m.hasDatasets, false);
  deepEqual(m.datasetOptions, []);
});

// ---- dataset options -------------------------------------------------------
test('datasets: hasDatasets true when at least one dataset', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: null });
  strictEqual(m.hasDatasets, true);
});

test('datasets: datasetOptions maps name -> table', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1, DS2], currentValues: null });
  deepEqual(m.datasetOptions, [
    { label: 'patients', value: 'patients_t' },
    { label: 'claims', value: 'claims_t' },
  ]);
});

// ---- column options --------------------------------------------------------
test('columnOptions empty when no table selected', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: {} });
  deepEqual(m.columnOptions, []);
});

test('columnOptions populated when table selected', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: { table: 'patients_t' } });
  deepEqual(m.columnOptions, [
    { label: 'patient_id', value: 'patient_id' },
    { label: 'admit_date', value: 'admit_date' },
    { label: 'discharge_date', value: 'discharge_date' },
  ]);
});

test('columnOptions empty when table not in datasets', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: { table: 'other_t' } });
  deepEqual(m.columnOptions, []);
});

test('columnOptions handles object-shaped cols', function() {
  const dsObj = { name: 'x', table: 'x_t', cols: [{ name: 'col_a' }, { name: 'col_b' }] };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [dsObj], currentValues: { table: 'x_t' } });
  deepEqual(m.columnOptions, [
    { label: 'col_a', value: 'col_a' },
    { label: 'col_b', value: 'col_b' },
  ]);
});

// ---- isComplete -----------------------------------------------------------
test('isComplete false when all fields blank', function() {
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: {} });
  strictEqual(m.isComplete, false);
});

test('isComplete false when entityIdValue is blank string', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: '   ',
    valueCol: 'admit_date', source: 'ehr', confidence: 0.9, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, false);
});

test('isComplete false when confidence is NaN', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 'P001',
    valueCol: 'admit_date', source: 'ehr', confidence: NaN, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, false);
});

test('isComplete false when confidence out of range', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 'P001',
    valueCol: 'admit_date', source: 'ehr', confidence: 1.5, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, false);
});

test('isComplete false when source is blank', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 'P001',
    valueCol: 'admit_date', source: '   ', confidence: 0.9, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, false);
});

test('isComplete true when all required fields valid', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 'P001',
    valueCol: 'admit_date', source: 'ehr-export', confidence: 0.92, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, true);
});

test('isComplete true when confidence is exactly 0', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 'P001',
    valueCol: 'admit_date', source: 'ehr', confidence: 0, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, true);
});

test('isComplete true when confidence is exactly 1', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 'P001',
    valueCol: 'admit_date', source: 'ehr', confidence: 1, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, true);
});

test('isComplete false when sealedBy is blank', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 'P001',
    valueCol: 'admit_date', source: 'ehr', confidence: 0.9, sealedBy: '',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, false);
});

// ---- partyId echoed correctly ---------------------------------------------
test('partyId is echoed back in model', function() {
  const m = buildDiplomacyFormModel({ partyId: 'reviewer', datasets: [], currentValues: null });
  strictEqual(m.partyId, 'reviewer');
});

// ---- current values echo --------------------------------------------------
test('current values are echoed back as model.current', function() {
  const cur = { table: 'patients_t', source: 'ehr' };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.current.table, 'patients_t');
  strictEqual(m.current.source, 'ehr');
});

// ---- multiple datasets: column options from correct table -----------------
test('column options come from the selected table only', function() {
  const m = buildDiplomacyFormModel({
    partyId: 'analyst', datasets: [DS1, DS2],
    currentValues: { table: 'claims_t' },
  });
  deepEqual(m.columnOptions, [
    { label: 'claim_id', value: 'claim_id' },
    { label: 'patient_id', value: 'patient_id' },
    { label: 'amount', value: 'amount' },
  ]);
});

// ---- missing entityIdCol/valueCol still fails isComplete ------------------
test('isComplete false when entityIdCol is missing', function() {
  const cur = {
    table: 'patients_t', entityIdValue: 'P001',
    valueCol: 'admit_date', source: 'ehr', confidence: 0.9, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, false);
});

test('isComplete false when valueCol is missing', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 'P001',
    source: 'ehr', confidence: 0.9, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, false);
});

// ---- entityIdValue as number is valid -------------------------------------
test('isComplete true when entityIdValue is a number', function() {
  const cur = {
    table: 'patients_t', entityIdCol: 'patient_id', entityIdValue: 42,
    valueCol: 'admit_date', source: 'ehr', confidence: 0.8, sealedBy: 'analyst',
  };
  const m = buildDiplomacyFormModel({ partyId: 'analyst', datasets: [DS1], currentValues: cur });
  strictEqual(m.isComplete, true);
});

// ---- summary ---------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
