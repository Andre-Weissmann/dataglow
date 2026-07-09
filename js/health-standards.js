// ============================================================
// DATAGLOW — The Standards Bridge (OMOP CDM + FHIR schema recognition)
// ============================================================
// A schema-recognition + concept-mapping seam that lets DATAGLOW ingest data
// shaped like two common healthcare-data standards — the OMOP Common Data Model
// and HL7 FHIR bundles — and route it through the app's EXISTING validation
// engines. It adds NO new validation math or ML: every plausibility bound is
// borrowed from the Physiological Plausibility layer's VITALS table, and every
// "impossible combination" check restates the same ordering / lifespan logic the
// Cross-Column Consistency layer already embodies. What is new here is only the
// recognition of standard table/resource shapes and the mapping of their
// long-format concepts onto the tabular, one-column-per-measurement shape the
// existing layers expect.
//
// Scope is deliberately narrow (see the Gen 33 ticket): five OMOP tables
// (PERSON, CONDITION_OCCURRENCE, DRUG_EXPOSURE, MEASUREMENT, OBSERVATION_PERIOD)
// and four FHIR resources (Patient, Condition, Observation, Encounter). Field
// and table names used below are the standards' own public identifiers (e.g.
// PERSON, value_as_number, valueQuantity) — those are plain identifiers, not
// copyrightable content — but all recognition logic, wording, and the sample
// fixtures are original to DATAGLOW and copied from no upstream file or spec.
//
// LEGAL / CLINICAL POSTURE — mirrors the on-device LLM feature: DATAGLOW is a
// data-quality reasoning assistant, NOT a medical or clinical AI. Findings from
// this module describe data-quality concerns only and are never a clinical
// determination. Consumers MUST surface MEDICAL_DISCLAIMER wherever these
// findings are shown.
//
// Everything here is pure JS with no browser-only API, so — like the other
// Domain Packs — it inherits automatically across browser + desktop (+ future
// mobile). The pure functions are exported so they can be unit-tested in Node
// without a DOM or a DuckDB engine.

import { VITALS } from './physiological-plausibility.js';
import { nameTokens } from './cross-column-consistency.js';
import { MIN_MISSING_RATE } from './missingness-detective.js';

// The shared, non-clinical disclaimer surfaced wherever OMOP/FHIR pack findings
// appear. Wording deliberately echoes the on-device LLM assistant's framing.
export const MEDICAL_DISCLAIMER =
  'DATAGLOW is a data-quality reasoning assistant, not a medical or clinical AI. ' +
  'The OMOP/FHIR packs recognise standard healthcare-data shapes and route them ' +
  'through the same data-quality checks used for any other dataset — they never ' +
  'make a clinical, diagnostic, or regulatory determination. Every finding is a ' +
  'candidate data-quality issue to review, never a clinical conclusion.';

// ------------------------------------------------------------
// Small shared helpers
// ------------------------------------------------------------
const lc = (s) => String(s ?? '').trim().toLowerCase();

// Parse a value into a JS Date or null. Accepts ISO date / datetime strings and
// Date instances; anything unparseable returns null (so a check simply skips it
// rather than firing on a garbage value it can't reason about).
export function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Look up a VITALS entry (and thus its plausibility bounds) by vital type key,
// e.g. 'heart_rate' -> the heart-rate bounds. Temperature is intentionally
// excluded from concept mapping here: its bounds are unit-dependent (°C vs °F)
// and resolving that safely needs the column-median heuristic the physio layer
// already owns, which is out of scope for this narrow concept map.
function vitalByType(type) {
  return VITALS.find((v) => v.type === type && !v.temperature) || null;
}

// ============================================================
// OMOP CDM — schema recognition
// ============================================================
// Each recognised table is identified by a set of signature columns that must
// all be present (case-insensitively). The signatures are intentionally minimal
// — just enough to disambiguate the five in-scope tables — so a site's extra
// columns never prevent recognition.
export const OMOP_TABLES = {
  PERSON: ['person_id', 'gender_concept_id', 'year_of_birth'],
  OBSERVATION_PERIOD: ['observation_period_id', 'person_id', 'observation_period_start_date', 'observation_period_end_date'],
  CONDITION_OCCURRENCE: ['condition_occurrence_id', 'person_id', 'condition_concept_id', 'condition_start_date'],
  DRUG_EXPOSURE: ['drug_exposure_id', 'person_id', 'drug_concept_id', 'drug_exposure_start_date'],
  MEASUREMENT: ['measurement_id', 'person_id', 'measurement_concept_id', 'value_as_number'],
};

// Recognise which in-scope OMOP table a set of column names represents, or null.
// `cols` may be an array of strings or of { name } objects.
export function recognizeOmopTable(cols) {
  const names = new Set((cols || []).map((c) => lc(typeof c === 'string' ? c : c && c.name)));
  for (const [table, signature] of Object.entries(OMOP_TABLES)) {
    if (signature.every((s) => names.has(s))) return table;
  }
  return null;
}

// ------------------------------------------------------------
// OMOP MEASUREMENT concept -> vital mapping
// ------------------------------------------------------------
// OMOP MEASUREMENT is long-format: one row per measurement carrying a
// `measurement_concept_id` plus a `value_as_number`. To reuse the physio layer's
// per-vital plausibility bounds we need to know which vital a concept id denotes.
// The integer ids below are ILLUSTRATIVE placeholders chosen for DATAGLOW's own
// sample fixtures — they are NOT a reproduction of any vocabulary's concept ids.
// In real use a site maps its own standard concept ids to a vital type here (or
// relies on the source-value fallback), and the plausibility bound comes
// entirely from the existing VITALS table — no bound is redefined here.
export const OMOP_MEASUREMENT_CONCEPT_VITAL = {
  30001: 'heart_rate',
  30002: 'systolic',
  30003: 'diastolic',
  30004: 'respiratory_rate',
  30005: 'spo2',
};

// Resolve a MEASUREMENT row to a vital type: prefer the concept-id map, then fall
// back to matching a free-text `measurement_source_value` against the same vital
// name tokens the physio layer uses. Returns a vital-type string or null.
export function measurementVitalType(row) {
  if (!row) return null;
  const byConcept = OMOP_MEASUREMENT_CONCEPT_VITAL[row.measurement_concept_id];
  if (byConcept) return byConcept;
  const src = row.measurement_source_value;
  if (src) {
    const tokens = nameTokens(src);
    for (const v of VITALS) {
      if (v.temperature) continue;
      if (v.codes && tokens.some((t) => v.codes.includes(t))) return v.type;
      if (v.stems && tokens.some((t) => v.stems.some((s) => t.startsWith(s)))) return v.type;
    }
  }
  return null;
}

// ============================================================
// OMOP CDM — violation checks (route standard shapes through existing logic)
// ============================================================

// Cross-column: observation_period_end_date must fall on or after
// observation_period_start_date. Restates the Cross-Column layer's date-ordering
// rule for the OMOP observation-period pair. Returns [{ row, personId, start,
// end, text }].
export function checkObservationPeriodOrder(rows) {
  const out = [];
  (rows || []).forEach((r, i) => {
    const start = toDate(r.observation_period_start_date);
    const end = toDate(r.observation_period_end_date);
    if (!start || !end) return;
    if (end.getTime() < start.getTime()) {
      out.push({
        row: i,
        personId: r.person_id,
        start: r.observation_period_start_date,
        end: r.observation_period_end_date,
        text: `observation_period_end_date (${r.observation_period_end_date}) is before observation_period_start_date (${r.observation_period_start_date}) for person ${r.person_id}.`,
      });
    }
  });
  return out;
}

// Cross-column (cross-table): a condition_start_date must fall inside the
// patient's plausible lifespan — on or after their birth, and not absurdly far
// beyond it. Uses PERSON birth info (birth_datetime if present, else the
// year/month/day parts). `maxAgeYears` is a wide plausibility ceiling (not a
// clinical bound). Returns [{ row, personId, conditionStart, reason, text }].
export function checkConditionInLifespan(personRows, conditionRows, { maxAgeYears = 130 } = {}) {
  const births = new Map();
  for (const p of personRows || []) births.set(String(p.person_id), personBirthDate(p));
  const out = [];
  (conditionRows || []).forEach((r, i) => {
    const start = toDate(r.condition_start_date);
    if (!start) return;
    const birth = births.get(String(r.person_id));
    if (!birth) return;
    let reason = null;
    if (start.getTime() < birth.getTime()) reason = 'before the patient was born';
    else if (start.getTime() > birth.getTime() + maxAgeYears * 365.25 * 86400000) {
      reason = `more than ${maxAgeYears} years after birth`;
    }
    if (reason) {
      out.push({
        row: i,
        personId: r.person_id,
        conditionStart: r.condition_start_date,
        reason,
        text: `condition_start_date (${r.condition_start_date}) for person ${r.person_id} falls ${reason} — outside a plausible lifespan.`,
      });
    }
  });
  return out;
}

// Derive a birth Date from an OMOP PERSON row. birth_datetime wins; otherwise
// assemble from year/month/day of birth (month/day default to Jan 1).
export function personBirthDate(p) {
  if (!p) return null;
  if (p.birth_datetime) { const d = toDate(p.birth_datetime); if (d) return d; }
  if (p.year_of_birth) {
    const y = Number(p.year_of_birth);
    const m = Number(p.month_of_birth) || 1;
    const day = Number(p.day_of_birth) || 1;
    if (Number.isFinite(y)) return new Date(Date.UTC(y, m - 1, day));
  }
  return null;
}

// Physiological plausibility: a MEASUREMENT row's value_as_number must fall
// inside the plausibility bounds of the vital its concept maps to. Reuses the
// physio layer's VITALS bounds verbatim — no bound is defined here. Returns
// [{ row, personId, vital, value, low, high, text }].
export function checkMeasurementPlausibility(rows) {
  const out = [];
  (rows || []).forEach((r, i) => {
    const type = measurementVitalType(r);
    if (!type) return;
    const vital = vitalByType(type);
    if (!vital) return;
    const val = Number(r.value_as_number);
    if (!Number.isFinite(val)) return;
    if (val < vital.low || val > vital.high) {
      out.push({
        row: i,
        personId: r.person_id,
        vital: vital.type,
        value: val,
        low: vital.low,
        high: vital.high,
        text: `value_as_number ${val}${vital.unit ? ' ' + vital.unit : ''} for ${vital.label.toLowerCase()} (person ${r.person_id}) is outside the plausible range ${vital.low}–${vital.high} — a likely data-entry or unit error.`,
      });
    }
  });
  return out;
}

// ============================================================
// FHIR — bundle recognition + flattening
// ============================================================
export const FHIR_RESOURCES = ['Patient', 'Condition', 'Observation', 'Encounter'];

// True when `obj` looks like a FHIR Bundle with an entry array.
export function isFhirBundle(obj) {
  return !!obj && obj.resourceType === 'Bundle' && Array.isArray(obj.entry);
}

// A reference string like "Patient/p1" or "urn:uuid:..." reduced to its bare id
// ("p1"). Also accepts an object { reference }.
export function referenceId(ref) {
  const s = typeof ref === 'string' ? ref : (ref && ref.reference) || '';
  const m = /([^/:]+)$/.exec(String(s));
  return m ? m[1] : '';
}

// Pull a numeric age recorded on an Encounter. FHIR has no first-class
// Encounter.age, so this reads (in order) a top-level `age`, an `age.value`
// quantity, or an extension whose url mentions "age" carrying valueInteger/
// valueQuantity — the shape DATAGLOW's own sample uses. Returns a number or null.
export function encounterAge(resource) {
  if (!resource) return null;
  if (typeof resource.age === 'number') return resource.age;
  if (resource.age && Number.isFinite(Number(resource.age.value))) return Number(resource.age.value);
  for (const ext of Array.isArray(resource.extension) ? resource.extension : []) {
    if (/age/i.test(ext.url || '')) {
      if (Number.isFinite(Number(ext.valueInteger))) return Number(ext.valueInteger);
      if (ext.valueQuantity && Number.isFinite(Number(ext.valueQuantity.value))) return Number(ext.valueQuantity.value);
    }
  }
  return null;
}

// Best-effort human-readable code text for a resource's `code` (Condition,
// Observation). Prefers code.text, then the first coding's display/code.
function codeText(code) {
  if (!code) return '';
  if (code.text) return code.text;
  const coding = Array.isArray(code.coding) ? code.coding[0] : null;
  return (coding && (coding.display || coding.code)) || '';
}

// Flatten an in-scope FHIR Bundle into DATAGLOW's tabular internal shape: one
// array of flat row objects per resource type. Only Patient/Condition/
// Observation/Encounter are handled; other resource types are ignored. This is a
// mapping onto the existing tabular ingestion shape, not a new pipeline.
export function flattenFhirBundle(bundle) {
  const out = { Patient: [], Condition: [], Observation: [], Encounter: [] };
  if (!isFhirBundle(bundle)) return out;
  for (const entry of bundle.entry) {
    const r = entry && entry.resource;
    if (!r || !FHIR_RESOURCES.includes(r.resourceType)) continue;
    if (r.resourceType === 'Patient') {
      out.Patient.push({ id: r.id, gender: r.gender ?? null, birthDate: r.birthDate ?? null });
    } else if (r.resourceType === 'Condition') {
      out.Condition.push({
        id: r.id,
        patient: referenceId(r.subject),
        code: codeText(r.code),
        onsetDateTime: r.onsetDateTime ?? null,
      });
    } else if (r.resourceType === 'Observation') {
      const vq = r.valueQuantity || null;
      out.Observation.push({
        id: r.id,
        patient: referenceId(r.subject),
        code: codeText(r.code),
        value: vq && Number.isFinite(Number(vq.value)) ? Number(vq.value) : null,
        unit: vq ? (vq.unit ?? vq.code ?? null) : null,
        effectiveDateTime: r.effectiveDateTime ?? null,
      });
    } else if (r.resourceType === 'Encounter') {
      out.Encounter.push({
        id: r.id,
        patient: referenceId(r.subject),
        class: (r.class && (r.class.code || r.class.display)) || null,
        start: (r.period && r.period.start) || null,
        end: (r.period && r.period.end) || null,
        age: encounterAge(r),
      });
    }
  }
  return out;
}

// Map a flattened FHIR Observation's code text to a vital type, reusing the
// physio layer's vital name-token matching. Returns a vital-type string or null.
export function fhirObservationVitalType(obs) {
  const tokens = nameTokens(obs && obs.code);
  if (!tokens.length) return null;
  for (const v of VITALS) {
    if (v.temperature) continue;
    if (v.codes && tokens.some((t) => v.codes.includes(t))) return v.type;
    if (v.stems && tokens.some((t) => v.stems.some((s) => t.startsWith(s)))) return v.type;
  }
  return null;
}

// ============================================================
// FHIR — violation checks
// ============================================================

// Physiological plausibility: a flattened Observation whose code maps to a vital
// must carry a value inside that vital's plausibility bounds. Reuses VITALS.
// Returns [{ id, patient, vital, value, low, high, text }].
export function checkFhirObservationPlausibility(observations) {
  const out = [];
  for (const o of observations || []) {
    const type = fhirObservationVitalType(o);
    if (!type) continue;
    const vital = vitalByType(type);
    if (!vital) continue;
    if (o.value == null || !Number.isFinite(Number(o.value))) continue;
    const val = Number(o.value);
    if (val < vital.low || val > vital.high) {
      out.push({
        id: o.id,
        patient: o.patient,
        vital: vital.type,
        value: val,
        low: vital.low,
        high: vital.high,
        text: `Observation "${o.code}" value ${val}${o.unit ? ' ' + o.unit : ''} (patient ${o.patient}) is outside the plausible ${vital.label.toLowerCase()} range ${vital.low}–${vital.high} — a likely data error.`,
      });
    }
  }
  return out;
}

// Cross-column: a recorded Encounter.age must be consistent with the patient's
// birthDate at the time of the encounter. Flags a negative/pre-birth age or a
// recorded age that disagrees with the computed age by more than `toleranceYears`.
// Returns [{ encounter, patient, recordedAge, expectedAge, reason, text }].
export function checkFhirPatientEncounterAge(patients, encounters, { toleranceYears = 1 } = {}) {
  const birth = new Map();
  for (const p of patients || []) birth.set(String(p.id), toDate(p.birthDate));
  const out = [];
  for (const e of encounters || []) {
    const recorded = e.age;
    if (recorded == null || !Number.isFinite(Number(recorded))) continue;
    const b = birth.get(String(e.patient));
    const when = toDate(e.start);
    if (!b || !when) continue;
    const expected = Math.floor((when.getTime() - b.getTime()) / (365.25 * 86400000));
    let reason = null;
    if (when.getTime() < b.getTime()) reason = 'encounter dated before the patient was born';
    else if (Math.abs(Number(recorded) - expected) > toleranceYears) {
      reason = `recorded age ${recorded} disagrees with age ${expected} computed from birthDate`;
    }
    if (reason) {
      out.push({
        encounter: e.id,
        patient: e.patient,
        recordedAge: Number(recorded),
        expectedAge: expected,
        reason,
        text: `Encounter ${e.id} (patient ${e.patient}): ${reason}.`,
      });
    }
  }
  return out;
}

// Missingness-causality: summarise how often chosen fields are missing across a
// set of flattened rows (e.g. Observations across encounters). Reuses the
// Missingness Detective's MIN_MISSING_RATE threshold to decide what is worth
// flagging. Returns [{ field, missing, total, rate, flagged }] sorted by rate.
export function summarizeFhirMissingness(rows, fields) {
  const total = (rows || []).length;
  const report = (fields || []).map((field) => {
    const missing = (rows || []).reduce((n, r) => {
      const v = r ? r[field] : undefined;
      return n + (v == null || v === '' ? 1 : 0);
    }, 0);
    const rate = total ? missing / total : 0;
    return { field, missing, total, rate, flagged: total > 0 && rate >= MIN_MISSING_RATE };
  });
  return report.sort((a, b) => b.rate - a.rate);
}

// ============================================================
// Stage A — synthetic sample fixtures
// ============================================================
// Entirely fabricated, clearly-labelled sample data shaped like the standards
// (inspired by Synthea's public description of what it emits — NOT copied from
// any Synthea output file). A couple of data-quality issues are planted on
// purpose so the sample can demonstrate the Stage B/C findings above.

// Five in-scope OMOP tables as arrays of row objects. Planted issues:
//   • OBSERVATION_PERIOD person 3: end date before start date.
//   • CONDITION_OCCURRENCE person 2: condition_start_date before birth.
//   • MEASUREMENT person 4: heart rate 350 bpm (physiologically implausible).
export function buildOmopSample() {
  const person = [
    { person_id: 1, gender_concept_id: 8532, year_of_birth: 1980, month_of_birth: 5, day_of_birth: 12, birth_datetime: '1980-05-12', race_concept_id: 0 },
    { person_id: 2, gender_concept_id: 8507, year_of_birth: 1975, month_of_birth: 11, day_of_birth: 3, birth_datetime: '1975-11-03', race_concept_id: 0 },
    { person_id: 3, gender_concept_id: 8532, year_of_birth: 1990, month_of_birth: 1, day_of_birth: 20, birth_datetime: '1990-01-20', race_concept_id: 0 },
    { person_id: 4, gender_concept_id: 8507, year_of_birth: 2001, month_of_birth: 8, day_of_birth: 7, birth_datetime: '2001-08-07', race_concept_id: 0 },
  ];
  const observation_period = [
    { observation_period_id: 101, person_id: 1, observation_period_start_date: '2018-01-01', observation_period_end_date: '2021-12-31' },
    { observation_period_id: 102, person_id: 2, observation_period_start_date: '2019-03-15', observation_period_end_date: '2022-03-14' },
    // planted: end before start
    { observation_period_id: 103, person_id: 3, observation_period_start_date: '2020-06-01', observation_period_end_date: '2019-06-01' },
    { observation_period_id: 104, person_id: 4, observation_period_start_date: '2017-09-09', observation_period_end_date: '2023-09-09' },
  ];
  const condition_occurrence = [
    { condition_occurrence_id: 201, person_id: 1, condition_concept_id: 320128, condition_start_date: '2019-04-10', condition_source_value: 'Essential hypertension' },
    // planted: condition dated before person 2's birth (1975)
    { condition_occurrence_id: 202, person_id: 2, condition_concept_id: 201820, condition_start_date: '1970-02-02', condition_source_value: 'Diabetes' },
    { condition_occurrence_id: 203, person_id: 3, condition_concept_id: 317009, condition_start_date: '2021-07-22', condition_source_value: 'Asthma' },
    { condition_occurrence_id: 204, person_id: 4, condition_concept_id: 320128, condition_start_date: '2022-01-05', condition_source_value: 'Essential hypertension' },
  ];
  const drug_exposure = [
    { drug_exposure_id: 301, person_id: 1, drug_concept_id: 1308216, drug_exposure_start_date: '2019-04-11', drug_source_value: 'Lisinopril 10mg' },
    { drug_exposure_id: 302, person_id: 2, drug_concept_id: 1503297, drug_exposure_start_date: '2019-05-01', drug_source_value: 'Metformin 500mg' },
    { drug_exposure_id: 303, person_id: 3, drug_concept_id: 1154343, drug_exposure_start_date: '2021-07-23', drug_source_value: 'Albuterol inhaler' },
  ];
  const measurement = [
    { measurement_id: 401, person_id: 1, measurement_concept_id: 30001, value_as_number: 72, measurement_source_value: 'heart_rate', unit_source_value: 'bpm' },
    { measurement_id: 402, person_id: 1, measurement_concept_id: 30002, value_as_number: 128, measurement_source_value: 'systolic', unit_source_value: 'mmHg' },
    { measurement_id: 403, person_id: 2, measurement_concept_id: 30003, value_as_number: 82, measurement_source_value: 'diastolic', unit_source_value: 'mmHg' },
    { measurement_id: 404, person_id: 3, measurement_concept_id: 30005, value_as_number: 98, measurement_source_value: 'spo2', unit_source_value: '%' },
    // planted: implausible heart rate
    { measurement_id: 405, person_id: 4, measurement_concept_id: 30001, value_as_number: 350, measurement_source_value: 'heart_rate', unit_source_value: 'bpm' },
  ];
  return { person, observation_period, condition_occurrence, drug_exposure, measurement };
}

// A synthetic FHIR Bundle with Patient/Condition/Observation/Encounter entries.
// Planted issues:
//   • Observation obs-4: SpO₂ of 140% (physically impossible, >100%).
//   • Encounter enc-2: recorded age 5 for a patient born 1975 (inconsistent).
//   • Observation obs-5: missing valueQuantity (feeds the missingness summary).
export function buildFhirSample() {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: { resourceType: 'Patient', id: 'p1', gender: 'female', birthDate: '1980-05-12' } },
      { resource: { resourceType: 'Patient', id: 'p2', gender: 'male', birthDate: '1975-11-03' } },
      { resource: { resourceType: 'Condition', id: 'cond-1', subject: { reference: 'Patient/p1' }, code: { text: 'Essential hypertension' }, onsetDateTime: '2019-04-10' } },
      { resource: { resourceType: 'Condition', id: 'cond-2', subject: { reference: 'Patient/p2' }, code: { text: 'Type 2 diabetes' }, onsetDateTime: '2018-02-02' } },
      { resource: { resourceType: 'Observation', id: 'obs-1', subject: { reference: 'Patient/p1' }, code: { text: 'Heart rate' }, valueQuantity: { value: 74, unit: 'bpm' }, effectiveDateTime: '2019-04-10' } },
      { resource: { resourceType: 'Observation', id: 'obs-2', subject: { reference: 'Patient/p1' }, code: { text: 'Systolic blood pressure' }, valueQuantity: { value: 122, unit: 'mmHg' }, effectiveDateTime: '2019-04-10' } },
      { resource: { resourceType: 'Observation', id: 'obs-3', subject: { reference: 'Patient/p2' }, code: { text: 'Respiratory rate' }, valueQuantity: { value: 16, unit: 'breaths/min' }, effectiveDateTime: '2018-02-02' } },
      // planted: SpO2 above the physical 100% ceiling
      { resource: { resourceType: 'Observation', id: 'obs-4', subject: { reference: 'Patient/p2' }, code: { text: 'Oxygen saturation' }, valueQuantity: { value: 140, unit: '%' }, effectiveDateTime: '2018-02-02' } },
      // planted: missing value (contributes to the missingness summary)
      { resource: { resourceType: 'Observation', id: 'obs-5', subject: { reference: 'Patient/p1' }, code: { text: 'Heart rate' }, effectiveDateTime: '2020-01-01' } },
      { resource: { resourceType: 'Encounter', id: 'enc-1', subject: { reference: 'Patient/p1' }, class: { code: 'AMB' }, period: { start: '2019-04-10', end: '2019-04-10' }, extension: [{ url: 'http://dataglow.local/fhir/encounter-age', valueInteger: 38 }] } },
      // planted: age 5 is inconsistent with a 1975 birthDate at a 2018 encounter
      { resource: { resourceType: 'Encounter', id: 'enc-2', subject: { reference: 'Patient/p2' }, class: { code: 'AMB' }, period: { start: '2018-02-02', end: '2018-02-03' }, extension: [{ url: 'http://dataglow.local/fhir/encounter-age', valueInteger: 5 }] } },
    ],
  };
}
