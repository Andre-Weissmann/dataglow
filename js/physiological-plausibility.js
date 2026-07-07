// ============================================================
// DATAGLOW — Physiological Plausibility Layer (healthcare-aware validation)
// ============================================================
// A healthcare-aware validation layer that sits ABOVE the generic statistical
// validators. Unlike outlier detection — which flags values that are unusual
// *relative to the dataset's own distribution* — this layer encodes hard limits
// grounded in human biology. A heart rate of 300 bpm is not merely a statistical
// outlier; it is physiologically impossible for a living human regardless of
// what the rest of the column looks like. That makes this check able to catch
// data errors (unit-conversion mistakes, decimal-point slips, sensor glitches,
// data-entry typos) that pure statistics miss when many rows share the same
// error.
//
// IMPORTANT — scope & intent:
//   * These are IMPLAUSIBILITY bounds (values impossible / vanishingly unlikely
//     for a living human), deliberately far WIDER than clinical "normal" or
//     "abnormal" ranges. This is a DATA-QUALITY check, NOT a medical diagnostic
//     tool and NOT clinical decision support.
//   * Every bound below is sourced ONLY from general, public, textbook-level
//     human-physiology knowledge (the kind found in any introductory
//     physiology / first-aid reference). No commercial clinical decision-support
//     system's proprietary rule engine or alert thresholds are referenced or
//     replicated.
//   * v1 is intentionally NARROW: five well-established vital signs only. It uses
//     a single, generously wide adult+pediatric plausibility range per vital
//     rather than age-adjusted pediatric bounds (see PR notes).
//
// Column detection reuses the robust word-splitting tokenizer from the
// Cross-Column layer (snake_case / camelCase / kebab-case / space-separated) so
// compound names like "heart_rate", "heartRate", "bp-sys" all match — naive
// regex `\b` boundaries fail on snake_case, a bug already fixed elsewhere in
// this app.
// ============================================================

import { nameTokens } from './cross-column-consistency.js';

const NUMERIC_T = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

// Visible, user-facing disclaimer shown wherever these results appear.
export const PHYSIO_DISCLAIMER =
  'This is a general data-plausibility check, NOT medical advice and NOT a ' +
  'clinical decision-support tool. It flags values that fall outside broad, ' +
  'textbook-level human physiological limits (e.g. a heart rate above 300 bpm) ' +
  'to catch likely data-entry, unit-conversion, or sensor errors. The bounds ' +
  'used are deliberately wide general physiological plausibility limits — they ' +
  'are NOT diagnostic thresholds and NOT "normal/healthy" ranges. A flagged ' +
  'value is a candidate data error to review, never a clinical finding.';

// ------------------------------------------------------------
// Vital-sign definitions. Bounds are general physiological plausibility limits
// (see per-vital sourcing notes) — a value below `low` or above `high` is
// treated as physiologically implausible for any living human.
// ------------------------------------------------------------
// `codes` are short identifiers matched EXACTLY against a name token (so "hr",
// "bp_sys", "spo2" match without the substring false-positives that "hr" would
// hit inside "threshold"). `stems` are descriptive words matched by token
// prefix (length chosen to avoid collisions, e.g. "temperatur" not "temp" so
// "template" is never mistaken for temperature).
export const VITALS = [
  {
    // Systolic BP. Highest transient systolic ever recorded (~370 mmHg during
    // maximal weightlifting) is the upper plausibility anchor; below ~40 mmHg is
    // incompatible with a perfusing measurement. Wider than any clinical range.
    type: 'systolic', label: 'Systolic blood pressure', unit: 'mmHg',
    codes: ['sys', 'sbp', 'bpsys'], stems: ['systol'],
    low: 40, high: 370,
  },
  {
    // Diastolic BP. Plausibility floor ~15 mmHg; ceiling ~250 mmHg (a diastolic
    // above this is not physiologically sustainable). Relationship check
    // (diastolic must be below systolic) is handled separately in the runner.
    type: 'diastolic', label: 'Diastolic blood pressure', unit: 'mmHg',
    codes: ['dia', 'dbp', 'bpdia'], stems: ['diastol'],
    low: 15, high: 250,
  },
  {
    // Heart rate. General physiological limits: sustained rates below ~20 bpm or
    // above ~300 bpm are not compatible with a living human (extreme athlete
    // bradycardia and infant/SVT tachycardia both fall inside 20–300).
    type: 'heart_rate', label: 'Heart rate', unit: 'bpm',
    codes: ['hr', 'bpm', 'pulse'], stems: ['heart', 'pulse'],
    low: 20, high: 300,
  },
  {
    // Respiratory rate. Below ~3 breaths/min is effectively apnea; above ~80 is
    // beyond any sustainable human respiratory rate (newborn tachypnea ~60).
    type: 'respiratory_rate', label: 'Respiratory rate', unit: 'breaths/min',
    codes: ['rr', 'resp'], stems: ['respir', 'breath'],
    low: 3, high: 80,
  },
  {
    // Oxygen saturation (SpO2). Physically bounded 0–100%; a value ABOVE 100% is
    // a definite data error, and below ~50% is implausible for a valid reading
    // of a living patient.
    type: 'spo2', label: 'Oxygen saturation (SpO₂)', unit: '%',
    codes: ['spo2', 'sao2', 'o2sat', 'o2'], stems: ['oxygen', 'saturation'],
    low: 50, high: 100,
  },
  {
    // Body temperature. Unit (°C vs °F) is auto-detected (see detectTempUnit).
    // Survivable-extreme anchors: ~13.7 °C (lowest survived) / ~46.5 °C (highest
    // survived); rounded outward to a wide plausibility window per unit.
    type: 'temperature', label: 'Body temperature',
    codes: ['temp', 'tmp'], stems: ['temperatur', 'fahrenheit', 'celsius'],
    temperature: true,
  },
];

// Wide per-unit temperature plausibility windows (12–45 °C ≈ 53.6–113 °F).
export const TEMP_BOUNDS = {
  C: { low: 12, high: 45 },
  F: { low: 53, high: 113 },
};

// Match a column name to a vital-sign definition (or null). Checks definitions
// in order, so the specific systolic/diastolic BP columns are resolved before
// the generic heart-rate keywords. Returns the matching VITALS entry.
export function matchVital(name) {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return null;
  for (const v of VITALS) {
    if (v.codes && tokens.some(t => v.codes.includes(t))) return v;
    if (v.stems && tokens.some(t => v.stems.some(s => t.startsWith(s)))) return v;
  }
  return null;
}

// Decide whether a temperature column is Celsius or Fahrenheit. Name hints win
// (temp_f / *fahrenheit → F, temp_c / *celsius → C); otherwise fall back to the
// column's median: human body temperatures cluster ~37 °C vs ~98.6 °F, so a
// median at/above 50 reads as Fahrenheit. Defaults to Celsius when unknown.
export function detectTempUnit(name, median) {
  const tokens = nameTokens(name);
  if (tokens.includes('f') || tokens.some(t => t.startsWith('fahren'))) return 'F';
  if (tokens.includes('c') || tokens.some(t => t.startsWith('celsi'))) return 'C';
  if (median == null || Number.isNaN(median)) return 'C';
  return median >= 50 ? 'F' : 'C';
}

function boundsFinding({ vital, label, column, unit, low, high, lowCount, highCount, unitNote }) {
  const count = lowCount + highCount;
  const u = unit ? ` ${unit}` : '';
  const parts = [];
  if (lowCount > 0) parts.push(`${lowCount} below ${low}${u}`);
  if (highCount > 0) parts.push(`${highCount} above ${high}${u}`);
  return {
    vital,
    label,
    column,
    unit: unit || null,
    low, high, lowCount, highCount, count,
    text: `${count} implausible value(s) in "${column}" — outside the plausible ${label.toLowerCase()} range of ${low}–${high}${u}.`,
    explanation: `${(unitNote ? unitNote + ' ' : '')}${parts.join(' and ')}. These fall outside broad, textbook-level human physiological limits and are far more likely data-entry, unit-conversion, or sensor errors than real measurements.`,
  };
}

// ------------------------------------------------------------
// Runner — executes the plausibility checks against the loaded table and returns
// { findings, matched }. Pure of side effects (no ledger writes): the caller
// decides how to log, mirroring the Cross-Column and Categorical layers.
//
// Each finding: { vital, label, column|columns, count, text, explanation, ... }
//   text        — concise one-liner (used for the layer's `detail` list)
//   explanation — plain-language "why this is implausible"
// ------------------------------------------------------------
export async function runPhysiologicalChecks(table, cols, engine) {
  const findings = [];
  const matched = [];
  const numeric = cols.filter(c => NUMERIC_T.includes(c.type));

  const one = async (sql) => {
    const { rows } = await engine.runQuery(sql);
    return rows[0] || {};
  };

  const systolicCols = [];
  const diastolicCols = [];

  for (const c of numeric) {
    const v = matchVital(c.name);
    if (!v) continue;
    const col = `"${c.name}"`;

    if (v.temperature) {
      const medRow = await one(`SELECT quantile_cont(${col}, 0.5) AS med FROM ${table} WHERE ${col} IS NOT NULL`);
      const med = medRow.med != null ? Number(medRow.med) : null;
      const unit = detectTempUnit(c.name, med);
      const b = TEMP_BOUNDS[unit];
      const disp = `°${unit}`;
      const r = await one(`
        SELECT COUNT(*) FILTER (WHERE ${col} < ${b.low}) AS lo,
               COUNT(*) FILTER (WHERE ${col} > ${b.high}) AS hi
        FROM ${table} WHERE ${col} IS NOT NULL`);
      const lo = Number(r.lo) || 0;
      const hi = Number(r.hi) || 0;
      matched.push({ column: c.name, vital: v.type, unit: disp });
      if (lo + hi > 0) {
        findings.push(boundsFinding({
          vital: v.type, label: v.label, column: c.name, unit: disp,
          low: b.low, high: b.high, lowCount: lo, highCount: hi,
          unitNote: `Detected unit: ${disp} (${unit === 'F' ? 'Fahrenheit' : 'Celsius'}).`,
        }));
      }
      continue;
    }

    const r = await one(`
      SELECT COUNT(*) FILTER (WHERE ${col} < ${v.low}) AS lo,
             COUNT(*) FILTER (WHERE ${col} > ${v.high}) AS hi
      FROM ${table} WHERE ${col} IS NOT NULL`);
    const lo = Number(r.lo) || 0;
    const hi = Number(r.hi) || 0;
    matched.push({ column: c.name, vital: v.type, unit: v.unit || null });
    if (lo + hi > 0) {
      findings.push(boundsFinding({
        vital: v.type, label: v.label, column: c.name, unit: v.unit,
        low: v.low, high: v.high, lowCount: lo, highCount: hi,
      }));
    }
    if (v.type === 'systolic') systolicCols.push(c.name);
    if (v.type === 'diastolic') diastolicCols.push(c.name);
  }

  // Cross-check: diastolic cannot exceed systolic in a valid reading. Pair the
  // first detected systolic column with the first diastolic (conservative — a
  // dataset almost never carries more than one of each).
  if (systolicCols.length && diastolicCols.length) {
    const s = systolicCols[0];
    const d = diastolicCols[0];
    const r = await one(`
      SELECT COUNT(*) AS n FROM ${table}
      WHERE "${s}" IS NOT NULL AND "${d}" IS NOT NULL AND "${d}" > "${s}"`);
    const n = Number(r.n) || 0;
    if (n > 0) {
      findings.push({
        vital: 'bp_relationship',
        label: 'Blood pressure relationship',
        columns: [s, d],
        count: n,
        text: `${n} row(s) where diastolic "${d}" exceeds systolic "${s}" — diastolic cannot be higher than systolic.`,
        explanation: `In any valid reading diastolic blood pressure is lower than systolic; ${n} row(s) invert this, indicating swapped or mis-entered values.`,
      });
    }
  }

  return { findings, matched };
}
