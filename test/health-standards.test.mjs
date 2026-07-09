// ============================================================
// DATAGLOW — The Standards Bridge (OMOP + FHIR) test suite
// ============================================================
// Pure, browser-free unit tests for the Gen 33 schema-recognition + concept-
// mapping module. Covers:
//   Stage B (OMOP): table recognition, concept→vital mapping, and the three
//     specified violations (observation-period ordering, condition outside
//     lifespan, implausible value_as_number).
//   Stage C (FHIR): bundle recognition + flattening, observation→vital mapping,
//     and the specified violations (out-of-bounds valueQuantity, birthDate vs
//     Encounter.age inconsistency, missingness across encounters).
//   Stage A: the synthetic fixtures carry exactly the planted issues the checks
//     are meant to catch.
//
// The checks REUSE the physio layer's VITALS bounds and the missingness
// threshold — this suite also proves that reuse (no new bounds invented here).
//
// RUN WITH:  node test/health-standards.test.mjs

import {
  MEDICAL_DISCLAIMER,
  recognizeOmopTable,
  measurementVitalType,
  checkObservationPeriodOrder,
  checkConditionInLifespan,
  checkMeasurementPlausibility,
  personBirthDate,
  isFhirBundle,
  flattenFhirBundle,
  referenceId,
  encounterAge,
  fhirObservationVitalType,
  checkFhirObservationPlausibility,
  checkFhirPatientEncounterAge,
  summarizeFhirMissingness,
  buildOmopSample,
  buildFhirSample,
} from '../js/health-standards.js';
import { VITALS } from '../js/physiological-plausibility.js';
import { MIN_MISSING_RATE } from '../js/missingness-detective.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ============================================================
// Stage B — OMOP recognition
// ============================================================
ok(recognizeOmopTable(['person_id', 'gender_concept_id', 'year_of_birth']) === 'PERSON',
  'OMOP: recognise PERSON by signature columns');
ok(recognizeOmopTable(['observation_period_id', 'person_id', 'observation_period_start_date', 'observation_period_end_date']) === 'OBSERVATION_PERIOD',
  'OMOP: recognise OBSERVATION_PERIOD');
ok(recognizeOmopTable(['condition_occurrence_id', 'person_id', 'condition_concept_id', 'condition_start_date']) === 'CONDITION_OCCURRENCE',
  'OMOP: recognise CONDITION_OCCURRENCE');
ok(recognizeOmopTable(['drug_exposure_id', 'person_id', 'drug_concept_id', 'drug_exposure_start_date']) === 'DRUG_EXPOSURE',
  'OMOP: recognise DRUG_EXPOSURE');
ok(recognizeOmopTable(['measurement_id', 'person_id', 'measurement_concept_id', 'value_as_number']) === 'MEASUREMENT',
  'OMOP: recognise MEASUREMENT');
ok(recognizeOmopTable([{ name: 'MEASUREMENT_ID' }, { name: 'Person_Id' }, { name: 'measurement_concept_id' }, { name: 'value_as_number' }]) === 'MEASUREMENT',
  'OMOP: recognition is case-insensitive and accepts {name} objects');
ok(recognizeOmopTable(['id', 'foo', 'bar']) === null,
  'OMOP: a non-OMOP table is not recognised');
ok(recognizeOmopTable(['person_id', 'gender_concept_id', 'year_of_birth', 'extra_site_column']) === 'PERSON',
  'OMOP: extra site columns do not prevent recognition');

// ------------------------------------------------------------
// OMOP concept → vital mapping
// ------------------------------------------------------------
ok(measurementVitalType({ measurement_concept_id: 30001 }) === 'heart_rate', 'OMOP: concept id 30001 → heart_rate');
ok(measurementVitalType({ measurement_concept_id: 30005 }) === 'spo2', 'OMOP: concept id 30005 → spo2');
ok(measurementVitalType({ measurement_source_value: 'Heart Rate' }) === 'heart_rate', 'OMOP: source-value fallback maps "Heart Rate" → heart_rate');
ok(measurementVitalType({ measurement_concept_id: 999999 }) === null, 'OMOP: unknown concept + no source value → null');

// ------------------------------------------------------------
// OMOP: observation_period end before start (cross-column)
// ------------------------------------------------------------
{
  const rows = [
    { person_id: 1, observation_period_start_date: '2018-01-01', observation_period_end_date: '2021-12-31' },
    { person_id: 2, observation_period_start_date: '2020-06-01', observation_period_end_date: '2019-06-01' },
    { person_id: 3, observation_period_start_date: null, observation_period_end_date: '2019-06-01' },
  ];
  const v = checkObservationPeriodOrder(rows);
  ok(v.length === 1, 'OMOP: exactly one observation-period ordering violation');
  ok(v[0].personId === 2, 'OMOP: the ordering violation is person 2');
  ok(checkObservationPeriodOrder([]).length === 0, 'OMOP: no rows → no ordering violation');
}

// ------------------------------------------------------------
// OMOP: condition outside plausible lifespan (cross-table)
// ------------------------------------------------------------
{
  const person = [
    { person_id: 1, year_of_birth: 1980, birth_datetime: '1980-05-12' },
    { person_id: 2, year_of_birth: 1975, birth_datetime: '1975-11-03' },
  ];
  const conditions = [
    { person_id: 1, condition_start_date: '2019-04-10' },       // fine
    { person_id: 2, condition_start_date: '1970-02-02' },       // before birth
  ];
  const v = checkConditionInLifespan(person, conditions);
  ok(v.length === 1 && v[0].personId === 2 && /before/.test(v[0].reason),
    'OMOP: condition dated before birth is flagged as outside lifespan');
  const v2 = checkConditionInLifespan(person, [{ person_id: 1, condition_start_date: '2200-01-01' }]);
  ok(v2.length === 1 && /years after birth/.test(v2[0].reason),
    'OMOP: condition absurdly far after birth is flagged');
  ok(personBirthDate({ year_of_birth: 1990, month_of_birth: 1, day_of_birth: 20 }) instanceof Date,
    'OMOP: personBirthDate assembles a Date from y/m/d parts');
}

// ------------------------------------------------------------
// OMOP: implausible value_as_number (physiological plausibility, reused bounds)
// ------------------------------------------------------------
{
  const hr = VITALS.find(v => v.type === 'heart_rate');
  const rows = [
    { person_id: 1, measurement_concept_id: 30001, value_as_number: 72 },     // normal
    { person_id: 4, measurement_concept_id: 30001, value_as_number: 350 },    // implausible
  ];
  const v = checkMeasurementPlausibility(rows);
  ok(v.length === 1 && v[0].personId === 4 && v[0].value === 350,
    'OMOP: heart rate 350 bpm flagged as implausible');
  ok(v[0].high === hr.high,
    'OMOP: the plausibility bound comes from the physio layer VITALS table (not redefined)');
  ok(checkMeasurementPlausibility([{ person_id: 1, measurement_concept_id: 30001, value_as_number: hr.high }]).length === 0,
    'OMOP: a value exactly at the upper bound is NOT flagged');
}

// ============================================================
// Stage C — FHIR recognition + flattening
// ============================================================
ok(isFhirBundle({ resourceType: 'Bundle', entry: [] }) === true, 'FHIR: recognise a Bundle with entry array');
ok(isFhirBundle({ resourceType: 'Patient' }) === false, 'FHIR: a bare resource is not a Bundle');
ok(isFhirBundle(null) === false, 'FHIR: null is not a Bundle');
ok(referenceId('Patient/p1') === 'p1', 'FHIR: referenceId extracts bare id from a reference');
ok(referenceId({ reference: 'urn:uuid:abc-123' }) === 'abc-123', 'FHIR: referenceId handles urn + object form');

{
  const flat = flattenFhirBundle(buildFhirSample());
  ok(flat.Patient.length === 2, 'FHIR: flattens 2 Patient rows');
  ok(flat.Observation.length === 5, 'FHIR: flattens 5 Observation rows');
  ok(flat.Encounter.length === 2, 'FHIR: flattens 2 Encounter rows');
  ok(flat.Condition.length === 2, 'FHIR: flattens 2 Condition rows');
  ok(flat.Patient[0].birthDate === '1980-05-12', 'FHIR: Patient birthDate preserved on flatten');
  ok(flat.Observation.every(o => 'value' in o && 'code' in o && 'patient' in o),
    'FHIR: flattened Observations expose value/code/patient');
  ok(encounterAge({ extension: [{ url: 'x/encounter-age', valueInteger: 38 }] }) === 38,
    'FHIR: encounterAge reads a numeric age from an age extension');
}

// FHIR observation → vital mapping
ok(fhirObservationVitalType({ code: 'Heart rate' }) === 'heart_rate', 'FHIR: "Heart rate" → heart_rate');
ok(fhirObservationVitalType({ code: 'Oxygen saturation' }) === 'spo2', 'FHIR: "Oxygen saturation" → spo2');
ok(fhirObservationVitalType({ code: 'Serum sodium' }) === null, 'FHIR: an unmapped observation code → null');

// ------------------------------------------------------------
// FHIR: Observation.valueQuantity outside physiological bounds
// ------------------------------------------------------------
{
  const flat = flattenFhirBundle(buildFhirSample());
  const v = checkFhirObservationPlausibility(flat.Observation);
  ok(v.length === 1 && v[0].id === 'obs-4' && v[0].value === 140,
    'FHIR: SpO2 of 140% flagged as physiologically implausible');
  const spo2 = VITALS.find(x => x.type === 'spo2');
  ok(v[0].high === spo2.high, 'FHIR: the bound is the reused physio SpO2 bound');
}

// ------------------------------------------------------------
// FHIR: Patient.birthDate inconsistent with Encounter.age (cross-column)
// ------------------------------------------------------------
{
  const flat = flattenFhirBundle(buildFhirSample());
  const v = checkFhirPatientEncounterAge(flat.Patient, flat.Encounter);
  ok(v.length === 1 && v[0].encounter === 'enc-2',
    'FHIR: encounter with age inconsistent with birthDate is flagged');
  ok(v[0].expectedAge >= 42 && v[0].recordedAge === 5,
    'FHIR: the finding reports both recorded and computed age');
  // A consistent age must NOT fire.
  const consistent = checkFhirPatientEncounterAge(
    [{ id: 'x', birthDate: '2000-01-01' }],
    [{ id: 'e', patient: 'x', start: '2020-06-01', age: 20 }],
  );
  ok(consistent.length === 0, 'FHIR: a consistent age is not flagged');
}

// ------------------------------------------------------------
// FHIR: missingness across encounters (reuses MIN_MISSING_RATE)
// ------------------------------------------------------------
{
  const flat = flattenFhirBundle(buildFhirSample());
  const report = summarizeFhirMissingness(flat.Observation, ['value', 'code']);
  const valueRow = report.find(r => r.field === 'value');
  ok(valueRow && valueRow.missing === 1, 'FHIR: missingness summary counts the one missing Observation value');
  ok(valueRow.flagged === (valueRow.rate >= MIN_MISSING_RATE),
    'FHIR: the flag decision uses the Missingness Detective threshold');
  ok(report.find(r => r.field === 'code').missing === 0, 'FHIR: code is present on every Observation');
}

// ============================================================
// Stage A — the synthetic fixtures carry the planted issues
// ============================================================
{
  const omop = buildOmopSample();
  ok(Object.keys(omop).length === 5, 'Stage A: OMOP sample has all 5 in-scope tables');
  ok(checkObservationPeriodOrder(omop.observation_period).length === 1,
    'Stage A: OMOP sample has exactly one planted observation-period ordering issue');
  ok(checkConditionInLifespan(omop.person, omop.condition_occurrence).length === 1,
    'Stage A: OMOP sample has exactly one planted lifespan issue');
  ok(checkMeasurementPlausibility(omop.measurement).length === 1,
    'Stage A: OMOP sample has exactly one planted implausible measurement');

  const flat = flattenFhirBundle(buildFhirSample());
  ok(checkFhirObservationPlausibility(flat.Observation).length === 1,
    'Stage A: FHIR sample has exactly one planted implausible observation');
  ok(checkFhirPatientEncounterAge(flat.Patient, flat.Encounter).length === 1,
    'Stage A: FHIR sample has exactly one planted age inconsistency');
}

// ============================================================
// Disclaimer
// ============================================================
ok(/not a medical or clinical AI/i.test(MEDICAL_DISCLAIMER) && /data-quality reasoning assistant/i.test(MEDICAL_DISCLAIMER),
  'Disclaimer: echoes the non-clinical data-quality-assistant framing');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
