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
// DuckDB temporal type names. Columns of these types are per-event and, after
// de-identification date-shifting, effectively per-row-unique — never a real
// "peer group".
const DATETIME_TYPE = /\b(TIMESTAMP|DATE|TIME)\b/i;

// Pick a low-cardinality, genuinely categorical column to serve as the peer
// group for the Anomaly Explainer. Returns null when no suitable grouping
// exists. Rejects:
//   - numeric and temporal (timestamp/date/time) typed columns,
//   - columns whose distinct-value count is near-unique relative to the number
//     of non-null values (e.g. a `deathtime` timestamp that loaded as VARCHAR),
//     since each such "peer group" would contain ~1 member and produce
//     nonsensical explanations.
// Kept engine-injectable (and free of DOM/browser globals) so it is unit-testable.
export async function pickPeerGroupColumn(table, cols, engine, options = {}) {
  const maxUniqueRatio = options.maxUniqueRatio ?? 0.5;
  const cats = cols.filter(c => !NUMERIC_TYPES.includes(c.type) && !DATETIME_TYPE.test(c.type));
  let rowCount = options.rowCount;
  if (rowCount == null) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
    rowCount = Number(rows[0]?.n ?? 0);
  }
  const upperBound = Math.max(20, rowCount / 5);
  for (const c of cats) {
    try {
      const { rows } = await engine.runQuery(
        `SELECT COUNT(DISTINCT "${c.name}") AS d, COUNT("${c.name}") AS nn FROM ${table}`
      );
      const d = Number(rows[0]?.d ?? 0);
      const nn = Number(rows[0]?.nn ?? 0);
      if (d < 2 || d > upperBound) continue;
      if (nn > 0 && d / nn > maxUniqueRatio) continue; // near-unique → not a peer group
      return c.name;
    } catch { /* skip unqueryable column */ }
  }
  return null;
}

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

// ============================================================
// On-Device Anomaly Explainer (SHAP-style feature attribution)
// ============================================================
// Explains WHY a specific row was flagged as an outlier, in plain language,
// entirely on-device. Method: a simplified, additive Shapley-value
// attribution — Lundberg & Lee, "A Unified Approach to Interpreting Model
// Predictions" (NeurIPS 2017). The anomaly score used here is additive across
// features (a sum of per-feature standardized squared deviations), and for an
// additive model the Shapley value of each feature reduces to its own term.
// So each feature's contribution to the anomaly is simply its share of the
// total standardized squared distance — no sampling or model retraining
// needed, which is what makes this cheap enough for the browser.
//
// Contributions are measured relative to a PEER GROUP: if a categorical
// grouping column is supplied (e.g. Geography), each feature is standardized
// against the mean/std of the row's own peer group rather than the whole
// table, so the reason reads "CreditScore is 2.3 std devs from its
// Geography='France' peer group" instead of a bare global score.
export async function explainAnomaly(table, numericCols, rowIndex, engine, options = {}) {
  const names = numericCols
    .map(c => (typeof c === 'string' ? c : c.name))
    .filter(Boolean);
  if (names.length === 0) throw new Error('explainAnomaly needs at least one numeric column.');

  const groupCol = options.groupColumn || null;
  const selectCols = groupCol ? [...names, groupCol] : names;
  const selectList = selectCols.map(n => `"${n}"`).join(', ');
  const { rows } = await engine.runQuery(`SELECT ${selectList} FROM ${table}`);
  if (rowIndex < 0 || rowIndex >= rows.length) throw new Error(`Row ${rowIndex} is out of range (table has ${rows.length} rows).`);

  const target = rows[rowIndex];
  const groupValue = groupCol ? target[groupCol] : null;
  // Peer set: rows sharing the target's group value (fall back to all rows if
  // the group is too small to estimate a spread from).
  let peers = rows;
  if (groupCol) {
    const sameGroup = rows.filter(r => r[groupCol] === groupValue);
    if (sameGroup.length >= 3) peers = sameGroup;
  }

  const stats = {};
  for (const n of names) {
    let sum = 0, cnt = 0;
    for (const r of peers) { const v = Number(r[n]); if (Number.isFinite(v)) { sum += v; cnt++; } }
    const mean = cnt ? sum / cnt : 0;
    let sq = 0;
    for (const r of peers) { const v = Number(r[n]); if (Number.isFinite(v)) sq += (v - mean) ** 2; }
    stats[n] = { mean, std: cnt ? Math.sqrt(sq / cnt) : 0 };
  }

  let totalSq = 0;
  const raw = names.map(n => {
    const v = Number(target[n]);
    const { mean, std } = stats[n];
    const z = std > 0 && Number.isFinite(v) ? (v - mean) / std : 0;
    totalSq += z * z;
    return { feature: n, value: Number.isFinite(v) ? v : null, mean, std, z, sq: z * z };
  });

  const contributions = raw
    .map(r => ({
      feature: r.feature,
      value: r.value,
      z: Number(r.z.toFixed(2)),
      direction: r.z >= 0 ? 'above' : 'below',
      contribution: totalSq > 0 ? Number((r.sq / totalSq).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.contribution - a.contribution);

  const peerLabel = groupCol
    ? `its ${groupCol}${groupValue != null ? `="${groupValue}"` : ''} peer group`
    : 'the overall dataset';

  const top = contributions[0];
  const reason = top && Math.abs(top.z) >= 0.01
    ? `Row flagged because ${top.feature} is ${Math.abs(top.z).toFixed(1)} std dev${Math.abs(top.z) >= 2 ? 's' : ''} ${top.direction} ${peerLabel} mean (contributing ${(top.contribution * 100).toFixed(0)}% of the anomaly).`
    : `No single feature stands out for row ${rowIndex} relative to ${peerLabel}.`;

  return { rowIndex, group: groupCol ? { column: groupCol, value: groupValue } : null, peerCount: peers.length, contributions, reason };
}
