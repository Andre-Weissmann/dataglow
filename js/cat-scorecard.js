// ============================================================
// DATAGLOW — CAT Scorecard (Completeness / Accuracy / Timeliness)
// ============================================================

import * as engine from './duckdb-engine.js';

// Dimensions of data quality per the CDC Data Quality Framework
// (public U.S. government standard). We report Completeness, Accuracy,
// and Timeliness with A–F letter grades.

function grade(score) {
  if (score >= 0.9) return 'A';
  if (score >= 0.8) return 'B';
  if (score >= 0.7) return 'C';
  if (score >= 0.6) return 'D';
  return 'F';
}

function graded(score) {
  const s = Math.max(0, Math.min(1, score));
  return { score: Number(s.toFixed(3)), grade: grade(s) };
}

async function computeCompleteness(ds) {
  const rowCount = ds.rowCount || 0;
  if (rowCount === 0 || !ds.cols || ds.cols.length === 0) return 1;
  let nullCells = 0;
  const totalCells = rowCount * ds.cols.length;
  for (const c of ds.cols) {
    const { rows } = await engine.runQuery(
      `SELECT COUNT(*) AS n FROM ${ds.table} WHERE "${c.name}" IS NULL`
    );
    nullCells += rows[0].n;
  }
  return totalCells > 0 ? 1 - nullCells / totalCells : 1;
}

// Accuracy is derived from existing validation-layer results when present.
// We use the pass rate across the accuracy-relevant layers; if none are
// available we fall back to a neutral 0.8.
function computeAccuracy(validationResults) {
  if (!validationResults) return 0.8;
  const relevant = ['unit_tests', 'semantic_drift', 'outlier_detection'];
  const present = relevant
    .map(id => validationResults[id])
    .filter(r => r && typeof r.status === 'string' && r.status !== 'idle');
  if (present.length === 0) return 0.8;
  const passes = present.filter(r => r.status === 'pass').length;
  return passes / present.length;
}

// Timeliness decays with dataset age, mirroring the freshness-meter style:
// 1.0 when under 24h, decaying linearly to 0 by ~7 days.
function computeTimeliness(ds) {
  const ageHours = (Date.now() - (ds.loadedAt || Date.now())) / 3600000;
  if (ageHours <= 24) return 1;
  const decayHours = 24 * 7; // fully decayed after a week
  return Math.max(0, 1 - (ageHours - 24) / decayHours);
}

export async function computeCATScore(ds, validationResults) {
  const completeness = await computeCompleteness(ds);
  const accuracy = computeAccuracy(validationResults);
  const timeliness = computeTimeliness(ds);
  const overallScore = (completeness + accuracy + timeliness) / 3;
  return {
    completeness: graded(completeness),
    accuracy: graded(accuracy),
    timeliness: graded(timeliness),
    overall: graded(overallScore),
  };
}
