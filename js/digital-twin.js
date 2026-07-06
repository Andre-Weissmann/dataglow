// ============================================================
// DATAGLOW — Digital Twin of the Dataset (What-If Simulator)
// ============================================================
// Turns DATAGLOW from a passive validator into an interactive sandbox: the
// analyst perturbs an in-memory *copy* of the loaded dataset with sliders and
// watches the causal, downstream effect on the existing validation layers and
// Confidence-Calibrated Grades — without ever touching the real data.
//
// This module is PURE JS (no DOM, no DuckDB engine) so it is fully unit-testable
// in Node, exactly like js/synthetic-adversarial.js. The UI layer (main.js)
// feeds it the rows it already read from the live table, applies the returned
// perturbed rows to a throwaway "__twin" table, and re-runs runAllLayers()
// against that copy — reusing the entire existing validation pipeline.
//
// HARD ISOLATION GUARANTEE: perturbRows() never mutates its inputs. It deep-
// copies every row object before touching a single cell, and the caller loads
// the result into a separate table, so the analyst's real dataset (and any real
// analysis, provenance chain, or export built from it) is provably untouched.
// A unit test asserts the input rows are byte-for-byte identical afterward.
// ============================================================

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT', 'DECIMAL', 'REAL'];

export function isNumericType(type) {
  return NUMERIC_TYPES.includes(String(type || '').toUpperCase());
}

function isDateType(col) {
  return /DATE|TIMESTAMP/i.test(String(col.type || '')) || /date|_at$|_on$|time/i.test(String(col.name || ''));
}

// Categorical = a text column that isn't obviously a date. These are the columns
// where a "category drift / mislabelling" perturbation is meaningful.
export function isCategoricalCol(col) {
  return !isNumericType(col.type) && !isDateType(col);
}

// Deterministic PRNG (mulberry32, public domain) so a given seed + knob set
// always yields the same perturbation — makes the live loop reproducible and
// the unit tests stable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick floor(n * rate) distinct row indices in [0, n) using the seeded PRNG.
// A partial Fisher-Yates so the chosen set is well-spread rather than clustered.
function pickIndices(n, rate, rand) {
  const k = Math.min(n, Math.max(0, Math.round(n * rate)));
  if (k <= 0) return [];
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i));
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  return idx.slice(0, k).sort((a, b) => a - b);
}

// A slider descriptor. `value` is a percentage 0–100 the UI binds a range input
// to; `key` is the stable id perturbRows() reads out of the knob map.
function slider(key, kind, label, column) {
  return { key, kind, column: column || null, label, min: 0, max: 100, step: 1, unit: '%', value: 0 };
}

// Infer a meaningful, dataset-specific set of what-if sliders from the actual
// schema. Domain-agnostic: it keys off column *type*, never hardcoded field
// names, so it generalises to any loaded dataset (healthcare or otherwise).
// `maxPerKind` caps each family of slider so a 300-column table doesn't produce
// a wall of controls.
export function inferPerturbations(cols, { maxPerKind = 4 } = {}) {
  const sliders = [];
  if (!Array.isArray(cols) || cols.length === 0) return sliders;

  // Global structural perturbation — duplicate a share of rows.
  sliders.push(slider('duplicate', 'duplicate', 'Duplicate rows (% of dataset re-appended)'));

  // Missing-value injection — applies to any column. Prefer the key column and
  // a spread of the first few columns so the effect on unit tests is visible.
  const missingTargets = cols.slice(0, maxPerKind);
  for (const c of missingTargets) {
    sliders.push(slider(`missing:${c.name}`, 'missing', `Missing values in "${c.name}"`, c.name));
  }

  // Outlier injection — numeric columns only.
  const numericCols = cols.filter(c => isNumericType(c.type)).slice(0, maxPerKind);
  for (const c of numericCols) {
    sliders.push(slider(`outlier:${c.name}`, 'outlier', `Outlier injection into "${c.name}"`, c.name));
  }

  // Category drift / mislabelling — categorical (text, non-date) columns only.
  const catCols = cols.filter(isCategoricalCol).slice(0, maxPerKind);
  for (const c of catCols) {
    sliders.push(slider(`drift:${c.name}`, 'drift', `Category drift / mislabelling in "${c.name}"`, c.name));
  }

  return sliders;
}

// Read a knob value (0–100 percentage) as a 0–1 fraction, clamped.
function frac(knobs, key) {
  const v = Number(knobs && knobs[key]);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(1, v / 100);
}

// Apply the perturbations described by `knobs` to a COPY of `rows`, returning
// the perturbed rows + a machine-readable manifest of what was changed. The
// input `rows` array and its row objects are never mutated.
//
//   columns : [{ name, type }]   (the live dataset's schema)
//   knobs   : { [sliderKey]: percentage 0–100 }
//   options : { seed }
export function perturbRows(rows, columns, knobs = {}, { seed = 0x7C1F } = {}) {
  if (!Array.isArray(rows)) throw new Error('perturbRows needs a rows array.');
  if (!Array.isArray(columns) || columns.length === 0) throw new Error('perturbRows needs a non-empty column schema.');

  const rand = mulberry32(seed);
  // Deep-enough copy: rows are flat {col: primitive} records, so a per-row
  // spread fully isolates the twin from the caller's data.
  const out = rows.map(r => ({ ...r }));
  const colNames = columns.map(c => c.name);
  const manifest = { applied: [], syntheticRows: 0 };

  // ---- missing-value injection (per column) ----
  for (const c of columns) {
    const rate = frac(knobs, `missing:${c.name}`);
    if (rate <= 0) continue;
    const idxs = pickIndices(out.length, rate, rand);
    for (const i of idxs) out[i][c.name] = null;
    if (idxs.length) manifest.applied.push({ kind: 'missing', column: c.name, rate, count: idxs.length });
  }

  // ---- outlier injection (numeric columns) ----
  for (const c of columns.filter(col => isNumericType(col.type))) {
    const rate = frac(knobs, `outlier:${c.name}`);
    if (rate <= 0) continue;
    const finite = out.map(r => Number(r[c.name])).filter(Number.isFinite);
    const scale = finite.length ? Math.max(...finite.map(Math.abs)) : 1;
    const spike = (scale || 1) * 1000 + 1e6; // far outside any plausible fence
    const idxs = pickIndices(out.length, rate, rand);
    for (const i of idxs) out[i][c.name] = spike;
    if (idxs.length) manifest.applied.push({ kind: 'outlier', column: c.name, rate, count: idxs.length, value: spike });
  }

  // ---- category drift / mislabelling (categorical columns) ----
  for (const c of columns.filter(isCategoricalCol)) {
    const rate = frac(knobs, `drift:${c.name}`);
    if (rate <= 0) continue;
    const idxs = pickIndices(out.length, rate, rand);
    let touched = 0;
    for (const i of idxs) {
      const v = out[i][c.name];
      if (v == null || v === '') continue;
      // Append a near-identical variant suffix — a realistic mislabelling that
      // the Categorical Consistency Engine will cluster against the canonical.
      out[i][c.name] = `${v}_drift`;
      touched++;
    }
    if (touched) manifest.applied.push({ kind: 'drift', column: c.name, rate, count: touched });
  }

  // ---- duplicate rows (global, structural) ----
  const dupRate = frac(knobs, 'duplicate');
  if (dupRate > 0 && out.length) {
    const nDup = Math.max(1, Math.round(out.length * dupRate));
    const base = out.length;
    for (let k = 0; k < nDup; k++) out.push({ ...out[k % base] });
    manifest.applied.push({ kind: 'duplicate', rate: dupRate, count: nDup });
    manifest.syntheticRows += nDup;
  }

  return { rows: out, columns: colNames, manifest };
}

// True when any knob is set above zero — lets the UI show "baseline" until the
// analyst actually drags something.
export function hasActivePerturbation(knobs = {}) {
  return Object.values(knobs).some(v => Number(v) > 0);
}

// Compact letter-grade delta helper for the before/after display. Returns a
// signed integer: negative = the simulated grade got WORSE than baseline (A→C
// is -2), positive = better, 0 = unchanged. Used only for the arrow/colour in
// the UI; the raw grades are always shown side by side too.
const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F'];
export function gradeDelta(baselineGrade, simulatedGrade) {
  const a = GRADE_ORDER.indexOf(baselineGrade);
  const b = GRADE_ORDER.indexOf(simulatedGrade);
  if (a < 0 || b < 0) return 0;
  return a - b; // baseline index minus simulated index → worse simulated = negative
}
