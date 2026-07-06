// ============================================================
// DATAGLOW — Synthetic Adversarial Twin (Differentially Private)
// ============================================================
// Given a real dataset, generate a synthetic version that preserves each
// column's statistical *shape* (distribution, and basic marginals) while
// containing NO real row-level values. Privacy is provided by a formal
// differential-privacy mechanism, not by obfuscation:
//
//   • Numeric columns   — bin values into a histogram, add calibrated Laplace
//                         noise to each bin COUNT (query sensitivity = 1, since
//                         adding/removing one row changes exactly one bin by 1),
//                         then resample synthetic values from the noised,
//                         non-negative histogram.
//   • Categorical cols  — add Laplace noise to each category's frequency COUNT
//                         (sensitivity = 1) then resample from the noised
//                         frequencies.
//
// This is the standard "DP histogram → resample" synthetic-data recipe. See
// Dwork & Roth, "The Algorithmic Foundations of Differential Privacy" (2014),
// §3.3 (the Laplace mechanism) and §3.5 (histogram queries). Noise scale is
// sensitivity / epsilon; lower epsilon = stronger privacy, less utility.
//
// Pure JS — no DOM, no engine. The Laplace sampler is injectable (`rng`) so the
// output is reproducible under test. The mandatory Research-Preview disclaimer
// is exported and MUST be surfaced in the UI.
// ============================================================

import { laplaceNoise } from './privacy-budget.js';

export const DEFAULT_EPSILON = 5;
export const DEFAULT_BINS = 20;

// Mandatory disclaimer — surfaced prominently in the UI regardless of quality.
export const SYNTHETIC_TWIN_DISCLAIMER =
  'This feature adds statistical noise for privacy but has not been independently ' +
  'audited for re-identification risk. Do not rely on this as a HIPAA Safe Harbor ' +
  'or Expert Determination method. Consult a qualified statistician before sharing ' +
  'outputs externally.';

// Plain-English explanation of the epsilon knob, for the in-UI helper text.
export function epsilonExplanation(epsilon) {
  return `Epsilon (ε = ${epsilon}) is the privacy budget. It bounds how much any ` +
    `single real row can influence the synthetic output: smaller ε means more ` +
    `noise and stronger privacy, larger ε means the synthetic data tracks the ` +
    `real distribution more closely but hides individuals less. ε≈1 is strongly ` +
    `private; ε≈5 (the default) trades some privacy for better statistical utility.`;
}

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT', 'DECIMAL', 'REAL'];

function isNumericType(type) {
  return NUMERIC_TYPES.includes(String(type || '').toUpperCase());
}

// Decide whether a column should be modeled as numeric: declared numeric type,
// or (when type is unknown) every non-null value parses as a finite number.
function looksNumeric(col, values) {
  if (isNumericType(col.type)) return true;
  if (col.type) return false;
  const nonNull = values.filter(v => v != null && v !== '');
  if (!nonNull.length) return false;
  return nonNull.every(v => Number.isFinite(Number(v)));
}

// ---------- numeric path ----------

export function buildNumericHistogram(values, bins = DEFAULT_BINS) {
  const nums = values.map(Number).filter(v => Number.isFinite(v));
  if (!nums.length) return { min: 0, max: 0, bins, counts: [], n: 0 };
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) max = min + 1; // avoid zero-width range
  const counts = new Array(bins).fill(0);
  const width = (max - min) / bins;
  for (const v of nums) {
    let idx = Math.floor((v - min) / width);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    counts[idx]++;
  }
  return { min, max, bins, counts, n: nums.length };
}

// Add Laplace(sensitivity/epsilon) noise to each bin count, clamp to >=0.
// Sensitivity of a histogram bin-count query is 1 (Dwork & Roth §3.5).
export function noiseHistogramCounts(counts, epsilon, rng = Math.random) {
  if (epsilon <= 0) throw new Error('epsilon (ε) must be greater than 0.');
  const scale = 1 / epsilon;
  return counts.map(c => Math.max(0, c + laplaceNoise(scale, rng)));
}

// Weighted pick of an index proportional to `weights`. Falls back to uniform
// when every weight is zero (all noise cancelled the signal).
function weightedIndex(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

export function resampleNumeric(hist, noisedCounts, n, rng = Math.random) {
  const { min, max, bins } = hist;
  const width = (max - min) / bins;
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = weightedIndex(noisedCounts, rng);
    const lo = min + b * width;
    const v = lo + rng() * width; // uniform within the chosen bin
    out.push(Number(v.toFixed(4)));
  }
  return out;
}

// ---------- categorical path ----------

export function categoryCounts(values) {
  const counts = new Map();
  for (const v of values) {
    const k = v == null ? '(null)' : String(v);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

export function noiseCategoryCounts(counts, epsilon, rng = Math.random) {
  if (epsilon <= 0) throw new Error('epsilon (ε) must be greater than 0.');
  const scale = 1 / epsilon;
  const noised = new Map();
  for (const [cat, c] of counts) noised.set(cat, Math.max(0, c + laplaceNoise(scale, rng)));
  return noised;
}

export function resampleCategorical(noisedCounts, n, rng = Math.random) {
  const cats = [...noisedCounts.keys()];
  const weights = [...noisedCounts.values()];
  const out = [];
  for (let i = 0; i < n; i++) out.push(cats[weightedIndex(weights, rng)]);
  return out;
}

// ---------- column statistics (real vs synthetic comparison) ----------

export function numericStats(values) {
  const nums = values.map(Number).filter(v => Number.isFinite(v));
  if (!nums.length) return { count: 0, mean: null, std: null, min: null, max: null };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return {
    count: nums.length,
    mean: Number(mean.toFixed(4)),
    std: Number(Math.sqrt(variance).toFixed(4)),
    min: Number(Math.min(...nums).toFixed(4)),
    max: Number(Math.max(...nums).toFixed(4)),
  };
}

export function categoricalStats(values) {
  const counts = categoryCounts(values);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = values.length || 1;
  return {
    count: values.length,
    distinct: counts.size,
    top: sorted.slice(0, 5).map(([cat, c]) => ({ value: cat, share: Number((c / total).toFixed(4)) })),
  };
}

// ---------- top-level generator ----------

// columns: [{name, type}]; rows: [{col: value}]
// options: { epsilon, bins, rng, count }
// Returns { rows, columns, epsilon, comparison, disclaimer }
export function generateSyntheticTwin({ columns, rows, epsilon = DEFAULT_EPSILON, bins = DEFAULT_BINS, rng = Math.random, count = null } = {}) {
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error('generateSyntheticTwin needs a non-empty column list.');
  }
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('generateSyntheticTwin needs at least one row to model.');
  }
  if (epsilon <= 0) throw new Error('epsilon (ε) must be greater than 0.');

  const n = count && count > 0 ? count : rows.length;
  const colNames = columns.map(c => c.name);
  const synthColumns = {};
  const comparison = [];

  for (const col of columns) {
    const realValues = rows.map(r => r[col.name]);
    if (looksNumeric(col, realValues)) {
      const hist = buildNumericHistogram(realValues, bins);
      const noised = noiseHistogramCounts(hist.counts, epsilon, rng);
      const synth = hist.n ? resampleNumeric(hist, noised, n, rng) : new Array(n).fill(null);
      synthColumns[col.name] = synth;
      comparison.push({
        column: col.name, type: 'numeric',
        real: numericStats(realValues), synthetic: numericStats(synth),
      });
    } else {
      const counts = categoryCounts(realValues);
      const noised = noiseCategoryCounts(counts, epsilon, rng);
      const synth = resampleCategorical(noised, n, rng);
      synthColumns[col.name] = synth;
      comparison.push({
        column: col.name, type: 'categorical',
        real: categoricalStats(realValues), synthetic: categoricalStats(synth),
      });
    }
  }

  const outRows = [];
  for (let i = 0; i < n; i++) {
    const row = {};
    for (const name of colNames) row[name] = synthColumns[name][i];
    outRows.push(row);
  }

  return {
    kind: 'dataglow-synthetic-twin',
    rows: outRows,
    columns: colNames,
    epsilon,
    mechanism: 'Laplace (DP histogram → resample; Dwork & Roth 2014)',
    comparison,
    disclaimer: SYNTHETIC_TWIN_DISCLAIMER,
  };
}

// CSV serialization of the synthetic rows (RFC-4180-ish quoting).
export function toCSV(columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const r of rows) lines.push(columns.map(c => esc(r[c])).join(','));
  return lines.join('\n');
}
