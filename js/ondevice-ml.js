// ============================================================
// DATAGLOW — On-Device Multivariate Anomaly Scoring
// Pure-JS, zero new dependencies, runs entirely in-browser.
// ============================================================

// Simplified multivariate outlier detection, conceptually related to
// Mahalanobis distance (Mahalanobis 1936, public statistics) and
// Isolation Forest (Liu, Ting, Zhou 2008). We approximate the Mahalanobis
// distance using a diagonal covariance (per-column variance) rather than a
// full covariance matrix, which keeps this dependency-free and fast.
//
// NOTE: A true on-device ML model (TensorFlow.js or ONNX Runtime Web) could
// replace this later for heavier anomaly detection, but this pure-JS version
// avoids pulling in a large new dependency for now.

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

export async function scoreMultivariateAnomalies(table, numericCols, engine) {
  const names = numericCols
    .map(c => (typeof c === 'string' ? c : c.name))
    .filter(Boolean);
  if (names.length === 0) return { rows: [], columns: [] };

  const selectList = names.map(n => `"${n}"`).join(', ');
  const { rows } = await engine.runQuery(`SELECT ${selectList} FROM ${table}`);
  if (rows.length === 0) return { rows: [], columns: names };

  // Compute mean and variance per column (diagonal covariance approximation).
  const mean = {};
  const variance = {};
  for (const n of names) {
    let sum = 0, cnt = 0;
    for (const r of rows) {
      const v = Number(r[n]);
      if (Number.isFinite(v)) { sum += v; cnt++; }
    }
    mean[n] = cnt ? sum / cnt : 0;
  }
  for (const n of names) {
    let sq = 0, cnt = 0;
    for (const r of rows) {
      const v = Number(r[n]);
      if (Number.isFinite(v)) { sq += (v - mean[n]) ** 2; cnt++; }
    }
    variance[n] = cnt ? sq / cnt : 0;
  }

  // Distance from centroid, standardized by per-column stddev.
  const scored = rows.map((r, idx) => {
    let dsq = 0;
    for (const n of names) {
      const v = Number(r[n]);
      if (!Number.isFinite(v)) continue;
      const varN = variance[n];
      if (varN > 0) dsq += ((v - mean[n]) ** 2) / varN;
    }
    const distance = Math.sqrt(dsq);
    return {
      rowIndex: idx,
      anomalyScore: Number(distance.toFixed(4)),
      // Flag if the standardized distance exceeds ~3 std devs of a single dim.
      isAnomaly: distance > 3,
      values: Object.fromEntries(names.map(n => [n, r[n]])),
    };
  });

  scored.sort((a, b) => b.anomalyScore - a.anomalyScore);
  return { rows: scored, columns: names };
}
