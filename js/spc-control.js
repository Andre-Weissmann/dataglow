// ============================================================
// DATAGLOW — SPC / Control-Chart Drift + Process Capability (Cpk)
// ============================================================
// Shewhart control charts (Walter A. Shewhart, "Economic Control of
// Quality of Manufactured Product", 1931, public method): a process is
// "in control" when points stay within mean ± 3σ (the UCL/LCL).
// Process capability index Cpk is the standard Six Sigma formula
// Cpk = min((USL - mean) / 3σ, (mean - LSL) / 3σ) (public statistics).

import * as engine from './duckdb-engine.js';

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];
const MAX_POINTS = 500; // cap the plotted series for performance

function toNumbers(rows, key) {
  const out = [];
  for (const r of rows) {
    const v = Number(r[key]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

// Shewhart 3-sigma control limits from a numeric series.
export function computeControlLimits(values) {
  const n = values.length;
  if (n === 0) return { mean: 0, sigma: 0, ucl: 0, lcl: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sigma = Math.sqrt(variance);
  return {
    mean,
    sigma,
    ucl: mean + 3 * sigma,
    lcl: mean - 3 * sigma,
    n,
  };
}

// Process capability index. When USL/LSL are not supplied we infer them
// from the observed data spread (min/max) — a rough proxy so a Cpk can
// still be shown; flagged via `inferredSpec: true`.
export function computeCpk(values, usl = null, lsl = null) {
  const { mean, sigma } = computeControlLimits(values);
  let inferredSpec = false;
  if (usl == null || lsl == null) {
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (usl == null) usl = max;
    if (lsl == null) lsl = min;
    inferredSpec = true;
  }
  if (sigma === 0) return { cpk: null, usl, lsl, mean, sigma, inferredSpec };
  const cpu = (usl - mean) / (3 * sigma);
  const cpl = (mean - lsl) / (3 * sigma);
  const cpk = Math.min(cpu, cpl);
  return { cpk: Number(cpk.toFixed(3)), cpu, cpl, usl, lsl, mean, sigma, inferredSpec };
}

// Pull a column's values and return control limits, Cpk, the (capped) series,
// and a count of out-of-control points for a Validate-tab summary + chart.
export async function analyzeColumnSPC(table, col, engine_ = engine) {
  const { rows } = await engine_.runQuery(
    `SELECT "${col}" AS v FROM ${table} WHERE "${col}" IS NOT NULL LIMIT ${MAX_POINTS}`
  );
  const values = toNumbers(rows, 'v');
  if (values.length < 2) return null;
  const limits = computeControlLimits(values);
  const cpk = computeCpk(values);
  const outOfControl = values.filter(v => v > limits.ucl || v < limits.lcl).length;
  return { column: col, values, limits, cpk, outOfControl };
}

export async function analyzeAllNumericSPC(table, cols, engine_ = engine) {
  const numeric = cols.filter(c => NUMERIC_TYPES.includes(c.type));
  const out = [];
  for (const c of numeric) {
    const res = await analyzeColumnSPC(table, c.name, engine_).catch(() => null);
    if (res) out.push(res);
  }
  return out;
}
