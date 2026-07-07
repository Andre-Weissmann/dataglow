// ============================================================
// DATAGLOW — Physiological Plausibility Layer test suite
// ============================================================
// Two halves:
//   1. Pure detection helpers — column→vital matching across snake_case,
//      camelCase, PascalCase, kebab-case and compound names (proving robust
//      word-splitting, not naive `\b` boundaries), plus temperature C/F unit
//      detection by name and by value.
//   2. The async runner against a REAL (native) DuckDB table, confirming each
//      vital's implausible values are flagged, that normal-but-unusual values
//      (e.g. an athlete's resting HR of 45) are NOT flagged, and the diastolic
//      > systolic relationship check fires.
//
// RUN WITH:
//   node --import ./test/duckdb-loader-hook.mjs test/physiological-plausibility.test.mjs

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import * as engine from './node-duckdb-engine.mjs';

import {
  matchVital, detectTempUnit, runPhysiologicalChecks, PHYSIO_DISCLAIMER, VITALS,
} from '../js/physiological-plausibility.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const vtype = (name) => { const v = matchVital(name); return v ? v.type : null; };

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return schema.map(s => ({ name: s.column_name, type: s.column_type }));
}
const findByColumn = (fs, col) => fs.find(f => f.column === col);

async function main() {
  // ============================================================
  // 1. Column → vital detection (robust word-splitting)
  // ============================================================
  ok(vtype('heart_rate') === 'heart_rate', 'detect: snake_case heart_rate → heart_rate');
  ok(vtype('heartRate') === 'heart_rate', 'detect: camelCase heartRate → heart_rate');
  ok(vtype('HeartRate') === 'heart_rate', 'detect: PascalCase HeartRate → heart_rate');
  ok(vtype('hr') === 'heart_rate', 'detect: code "hr" → heart_rate');
  ok(vtype('pulse') === 'heart_rate', 'detect: "pulse" → heart_rate');
  ok(vtype('resting_heart_rate_bpm') === 'heart_rate', 'detect: compound resting_heart_rate_bpm → heart_rate');

  ok(vtype('temp') === 'temperature', 'detect: "temp" → temperature');
  ok(vtype('body_temperature') === 'temperature', 'detect: body_temperature → temperature');
  ok(vtype('temp_f') === 'temperature', 'detect: temp_f → temperature');
  ok(vtype('tempCelsius') === 'temperature', 'detect: camelCase tempCelsius → temperature');

  ok(vtype('systolic') === 'systolic', 'detect: systolic → systolic');
  ok(vtype('bp_sys') === 'systolic', 'detect: bp_sys → systolic');
  ok(vtype('sbp') === 'systolic', 'detect: sbp → systolic');
  ok(vtype('systolic_bp') === 'systolic', 'detect: systolic_bp → systolic');
  ok(vtype('diastolic') === 'diastolic', 'detect: diastolic → diastolic');
  ok(vtype('bp_dia') === 'diastolic', 'detect: bp_dia → diastolic');
  ok(vtype('dbp') === 'diastolic', 'detect: dbp → diastolic');

  ok(vtype('resp_rate') === 'respiratory_rate', 'detect: resp_rate → respiratory_rate');
  ok(vtype('respiratory_rate') === 'respiratory_rate', 'detect: respiratory_rate → respiratory_rate');
  ok(vtype('rr') === 'respiratory_rate', 'detect: code "rr" → respiratory_rate');

  ok(vtype('spo2') === 'spo2', 'detect: spo2 → spo2');
  ok(vtype('SpO2') === 'spo2', 'detect: SpO2 → spo2');
  ok(vtype('oxygen_saturation') === 'spo2', 'detect: oxygen_saturation → spo2');
  ok(vtype('o2_sat') === 'spo2', 'detect: o2_sat → spo2');

  // No false positives on unrelated / look-alike names.
  ok(vtype('country') === null, 'detect: "country" matches no vital');
  ok(vtype('hour') === null, 'detect: "hour" is not heart rate (no "hr" false positive)');
  ok(vtype('threshold') === null, 'detect: "threshold" is not heart rate (no "hr" substring false positive)');
  ok(vtype('response_time') === null, 'detect: "response_time" is not respiratory rate');
  ok(vtype('template_id') === null, 'detect: "template_id" is not temperature');
  ok(vtype('system_id') === null, 'detect: "system_id" is not systolic BP');
  ok(vtype('bp') === null, 'detect: bare "bp" is ambiguous → not matched');

  // ============================================================
  // 2. Temperature unit detection (name hint + value fallback)
  // ============================================================
  ok(detectTempUnit('temp_f', null) === 'F', 'unit: name hint temp_f → F');
  ok(detectTempUnit('temp_c', null) === 'C', 'unit: name hint temp_c → C');
  ok(detectTempUnit('temp_fahrenheit', null) === 'F', 'unit: *fahrenheit → F');
  ok(detectTempUnit('body_temp_celsius', null) === 'C', 'unit: *celsius → C');
  ok(detectTempUnit('temperature', 98.6) === 'F', 'unit: value ~98.6 (no hint) → F');
  ok(detectTempUnit('temperature', 37.0) === 'C', 'unit: value ~37 (no hint) → C');
  ok(detectTempUnit('temperature', null) === 'C', 'unit: unknown → defaults to C');

  ok(typeof PHYSIO_DISCLAIMER === 'string' && /not medical advice/i.test(PHYSIO_DISCLAIMER) && /clinical decision-support/i.test(PHYSIO_DISCLAIMER),
    'disclaimer: present and states not-medical-advice / not-clinical-decision-support');
  ok(VITALS.length === 6, 'config: v1 defines exactly the 5 vital signs (+ BP split into systolic/diastolic)');

  // ============================================================
  // 3. Runner against a real DuckDB table
  // ============================================================

  // --- Heart rate: flag impossible high/low, NOT an athlete's resting 45. ---
  {
    const rows = [
      { patient_id: 1, heart_rate: 72 },
      { patient_id: 2, heart_rate: 45 },   // athlete resting — plausible, must NOT flag
      { patient_id: 3, heart_rate: 320 },  // impossible high
      { patient_id: 4, heart_rate: 10 },   // impossible low
      { patient_id: 5, heart_rate: 88 },
    ];
    const cols = await makeDataset('phys_hr', rows);
    const { findings, matched } = await runPhysiologicalChecks('phys_hr', cols, engine);
    const f = findByColumn(findings, 'heart_rate');
    ok(matched.some(m => m.vital === 'heart_rate'), 'run(hr): heart_rate column detected');
    ok(f && f.count === 2, 'run(hr): exactly 2 implausible HR values flagged (320, 10)');
    ok(f && f.highCount === 1 && f.lowCount === 1, 'run(hr): one high (320) + one low (10) — athlete 45 / 72 / 88 not flagged');
  }

  // --- Temperature in Celsius: unit detected as C, impossible values flagged. ---
  {
    const rows = [
      { id: 1, body_temp: 37.0 },
      { id: 2, body_temp: 41.0 },  // high fever — still plausible (<45), must NOT flag
      { id: 3, body_temp: 5.0 },   // impossible low
      { id: 4, body_temp: 60.0 },  // impossible high
    ];
    const cols = await makeDataset('phys_temp_c', rows);
    const { findings, matched } = await runPhysiologicalChecks('phys_temp_c', cols, engine);
    const m = matched.find(x => x.vital === 'temperature');
    const f = findByColumn(findings, 'body_temp');
    ok(m && m.unit === '°C', 'run(tempC): unit auto-detected as °C from values ~37');
    ok(f && f.count === 2, 'run(tempC): 2 implausible temps flagged (5, 60); fever 41 not flagged');
  }

  // --- Temperature in Fahrenheit: unit detected as F. ---
  {
    const rows = [
      { id: 1, temperature_f: 98.6 },
      { id: 2, temperature_f: 104.0 }, // high fever — plausible (<113), must NOT flag
      { id: 3, temperature_f: 30.0 },  // impossible low (<53)
      { id: 4, temperature_f: 130.0 }, // impossible high (>113)
    ];
    const cols = await makeDataset('phys_temp_f', rows);
    const { findings, matched } = await runPhysiologicalChecks('phys_temp_f', cols, engine);
    const m = matched.find(x => x.vital === 'temperature');
    const f = findByColumn(findings, 'temperature_f');
    ok(m && m.unit === '°F', 'run(tempF): unit auto-detected as °F (name hint + values)');
    ok(f && f.count === 2, 'run(tempF): 2 implausible temps flagged (30, 130); fever 104 not flagged');
  }

  // --- SpO2: flag >100 (data error) and <50; do not flag valid 90–100. ---
  {
    const rows = [
      { id: 1, spo2: 98 },
      { id: 2, spo2: 100 },  // valid ceiling — must NOT flag
      { id: 3, spo2: 105 },  // impossible >100
      { id: 4, spo2: 20 },   // implausible for a living patient
      { id: 5, spo2: 94 },
    ];
    const cols = await makeDataset('phys_spo2', rows);
    const { findings } = await runPhysiologicalChecks('phys_spo2', cols, engine);
    const f = findByColumn(findings, 'spo2');
    ok(f && f.count === 2, 'run(spo2): 2 flagged (105 over 100, 20 implausible low); 100 not flagged');
    ok(f && f.highCount === 1 && f.lowCount === 1, 'run(spo2): split into one high + one low');
  }

  // --- Respiratory rate: flag impossible values only. ---
  {
    const rows = [
      { id: 1, resp_rate: 16 },
      { id: 2, resp_rate: 22 },
      { id: 3, resp_rate: 1 },    // effectively apnea — implausible
      { id: 4, resp_rate: 100 },  // impossible high
    ];
    const cols = await makeDataset('phys_rr', rows);
    const { findings } = await runPhysiologicalChecks('phys_rr', cols, engine);
    const f = findByColumn(findings, 'resp_rate');
    ok(f && f.count === 2, 'run(rr): 2 implausible respiratory rates flagged (1, 100)');
  }

  // --- Blood pressure: systolic bound + diastolic > systolic relationship. ---
  {
    const rows = [
      { id: 1, systolic: 120, diastolic: 80 },   // normal
      { id: 2, systolic: 130, diastolic: 140 },  // diastolic > systolic — impossible
      { id: 3, systolic: 400, diastolic: 90 },   // systolic impossibly high (>370)
    ];
    const cols = await makeDataset('phys_bp', rows);
    const { findings, matched } = await runPhysiologicalChecks('phys_bp', cols, engine);
    ok(matched.some(m => m.vital === 'systolic') && matched.some(m => m.vital === 'diastolic'),
      'run(bp): both systolic and diastolic columns detected');
    const sysF = findByColumn(findings, 'systolic');
    ok(sysF && sysF.highCount === 1, 'run(bp): systolic 400 flagged as implausibly high');
    const rel = findings.find(f => f.vital === 'bp_relationship');
    ok(rel && rel.count === 1, 'run(bp): 1 row where diastolic exceeds systolic flagged');
  }

  // --- False-positive guard: a fully-plausible vitals table produces 0 flags. ---
  {
    const rows = [
      { id: 1, heart_rate: 60, spo2: 99, resp_rate: 14, body_temp_c: 36.8 },
      { id: 2, heart_rate: 45, spo2: 97, resp_rate: 12, body_temp_c: 37.2 },  // athlete HR 45
      { id: 3, heart_rate: 180, spo2: 95, resp_rate: 30, body_temp_c: 39.5 }, // high but plausible
    ];
    const cols = await makeDataset('phys_clean', rows);
    const { findings, matched } = await runPhysiologicalChecks('phys_clean', cols, engine);
    ok(matched.length === 4, 'run(clean): all four vital columns detected');
    ok(findings.length === 0, 'run(clean): no false positives on a fully-plausible vitals table');
  }

  // --- No vital columns: runner returns empty matched set. ---
  {
    const rows = [{ id: 1, country: 'US', amount: 12.5 }, { id: 2, country: 'FR', amount: 8.0 }];
    const cols = await makeDataset('phys_none', rows);
    const { findings, matched } = await runPhysiologicalChecks('phys_none', cols, engine);
    ok(matched.length === 0 && findings.length === 0, 'run(none): no vital columns → nothing matched or flagged');
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
