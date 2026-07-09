// ============================================================
// DATAGLOW — Predictive Anomaly Scoring (holistic, mixed-type outliers)
// ============================================================
// An on-device, unsupervised outlier detector that learns the "normal shape"
// of the CURRENT dataset and flags whole ROWS whose *combination* of values is
// unusual — the multi-column, holistic anomalies that single-column rule/layer
// checks and the numeric-only Multivariate Outliers panel structurally cannot
// see (e.g. a 15-year-old with a retirement account, where neither the age nor
// the account value is individually out of range, but the pair is bizarre).
//
// TECHNIQUE — k-Nearest-Neighbours distance outlier score over Gower distance.
//   • kNN outlier factor (Ramaswamy, Rastogi & Shim, 2000; Angiulli & Pizzuti,
//     2002 — public academic algorithms): a row's outlier score is its mean
//     distance to its k nearest neighbours. Points sitting far from ALL other
//     rows (in no dense neighbourhood) score high. Implemented from first
//     principles, pure JS, zero new dependencies.
//   • Gower distance (Gower, 1971; public statistics) makes the score work on
//     MIXED numeric + categorical features — which is the whole point, since the
//     existing Mahalanobis / Isolation Forest panel is numeric-only. Per feature:
//        · numeric    → |xi − xj| / range(feature)     (range-normalised, [0,1])
//        · categorical→ 0 if equal, 1 if different       ({0,1})
//     The row-to-row distance is the mean of the per-feature dissimilarities, so
//     numeric and categorical features contribute on the same [0,1] scale.
//
// EXPLAINABILITY — because Gower distance is an average of per-feature terms, a
// row's distance to its neighbours decomposes ADDITIVELY across features. We
// aggregate each feature's mean dissimilarity to the row's k nearest neighbours
// and report the top contributors in plain language ("Age sits far from its
// nearest neighbours; Country='FRA' rarely co-occurs with these values"). No
// black box — every flag carries a first-principles "why", consistent with the
// Assumption Ledger's plain-language ethos.
//
// PERSONALISED, NOT GENERAL AI — the model is fit to THIS dataset's own
// distribution, per-session, in memory. It is not a cross-session learned model
// (that is Distributional Fingerprint Drift's job) and it is not a supervised
// model of user feedback (that is Self-Learning Validation Rules' job). It is a
// distinct, complementary capability and is deliberately NOT one of the 20
// validation layers.
//
// PERFORMANCE — the pairwise kNN search is O(n²·d). We therefore cap the working
// set at MAX_ROWS and, for larger tables, take a uniform random sample down to
// the cap. Sampling is disclosed to the caller (and, via the UI, to the user):
// unsampled rows are not scored. Feature count is likewise capped, and
// near-unique / identifier-like categorical columns are excluded so the score
// reflects real structure rather than row-unique keys.
// ============================================================

const NUMERIC_TYPES = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];
// DuckDB temporal type names — per-event, effectively row-unique after any
// de-identification date-shifting, so never a useful categorical feature here.
const DATETIME_TYPE = /\b(TIMESTAMP|DATE|TIME)\b/i;

// Working-set cap for the O(n²) pairwise search. Tables larger than this are
// uniformly down-sampled to this many rows (disclosed to the user).
export const MAX_ROWS = 2000;
// Cap the number of features so distance stays cheap and interpretable.
const MAX_NUMERIC_FEATURES = 12;
const MAX_CATEGORICAL_FEATURES = 6;
// A categorical column with more distinct values than this fraction of the rows
// is treated as identifier-like and excluded (it would make every row unique).
const CAT_UNIQUE_RATIO = 0.5;
const CAT_MAX_DISTINCT = 50;

// Mulberry32 — a tiny deterministic PRNG so sampling is reproducible in tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform random sample of k indices from [0, n) without replacement.
function sampleIndices(n, k, rand) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k).sort((a, b) => a - b);
}

// Choose the numeric + categorical feature columns to profile. Exclusions keep
// the distance meaningful: identifier-like categoricals (near-unique) and
// temporal columns are dropped. Kept engine-injectable and DOM-free so it is
// unit-testable.
export async function selectFeatures(table, cols, engine, options = {}) {
  const numeric = cols
    .filter(c => NUMERIC_TYPES.includes(c.type))
    .map(c => c.name)
    .slice(0, options.maxNumeric ?? MAX_NUMERIC_FEATURES);

  const catCandidates = cols.filter(
    c => !NUMERIC_TYPES.includes(c.type) && !DATETIME_TYPE.test(c.type)
  );
  let rowCount = options.rowCount;
  if (rowCount == null) {
    const { rows } = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
    rowCount = Number(rows[0]?.n ?? 0);
  }
  const maxRatio = options.catUniqueRatio ?? CAT_UNIQUE_RATIO;
  const categorical = [];
  for (const c of catCandidates) {
    if (categorical.length >= (options.maxCategorical ?? MAX_CATEGORICAL_FEATURES)) break;
    try {
      const { rows } = await engine.runQuery(
        `SELECT COUNT(DISTINCT "${c.name}") AS d, COUNT("${c.name}") AS nn FROM ${table}`
      );
      const d = Number(rows[0]?.d ?? 0);
      const nn = Number(rows[0]?.nn ?? 0);
      if (d < 2 || d > CAT_MAX_DISTINCT) continue;        // constant or too granular
      if (nn > 0 && d / nn > maxRatio) continue;          // near-unique → identifier-like
      categorical.push(c.name);
    } catch { /* skip unqueryable column */ }
  }
  return { numeric, categorical };
}

// Core scorer. Pulls the feature columns for the (optionally sampled) working
// set, builds Gower ranges, computes each row's mean distance to its k nearest
// neighbours, and attributes the score across features. Everything after the
// single SELECT is in-memory.
export async function scorePredictiveAnomalies(table, cols, engine, options = {}) {
  const cap = options.maxRows ?? MAX_ROWS;
  const rand = mulberry32(options.seed ?? 1337);

  const features = options.features || await selectFeatures(table, cols, engine, options);
  const { numeric, categorical } = features;
  const featureNames = [...numeric, ...categorical];
  if (featureNames.length < 2) {
    return { rows: [], features, sampling: null, k: 0, threshold: 0,
      note: 'Need at least 2 usable features (numeric or low-cardinality categorical) to score holistic anomalies.' };
  }

  const totalRes = await engine.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
  const totalRows = Number(totalRes.rows[0]?.n ?? 0);

  const selectList = featureNames.map(n => `"${n}"`).join(', ');
  // Stable row identity: attach a positional index so flagged rows map back to
  // their real position even after sampling.
  const { rows: allRows } = await engine.runQuery(`SELECT ${selectList} FROM ${table}`);
  const indexed = allRows.map((r, i) => ({ __idx: i, r }));

  let working = indexed;
  let sampled = false;
  if (indexed.length > cap) {
    const pick = sampleIndices(indexed.length, cap, rand);
    working = pick.map(i => indexed[i]);
    sampled = true;
  }
  const sampling = { sampled, usedRows: working.length, totalRows, cap };

  const n = working.length;
  if (n < 5) {
    return { rows: [], features, sampling, k: 0, threshold: 0,
      note: 'Too few rows to establish a neighbourhood (need at least 5).' };
  }

  // Per-numeric-feature range for Gower normalisation (ignore non-finite).
  const range = {};
  for (const f of numeric) {
    let min = Infinity, max = -Infinity;
    for (const { r } of working) {
      const v = Number(r[f]);
      if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    range[f] = (max > min) ? (max - min) : 0;
  }

  // Pre-extract typed feature vectors for speed.
  const numVals = working.map(({ r }) => numeric.map(f => {
    const v = Number(r[f]); return Number.isFinite(v) ? v : null;
  }));
  const catVals = working.map(({ r }) => categorical.map(f => {
    const v = r[f]; return (v === null || v === undefined) ? null : String(v);
  }));

  const numF = numeric.length, catF = categorical.length, totalF = numF + catF;

  // Per-feature dissimilarity between rows a and b, written into `out` (length
  // totalF). Missing values contribute maximal dissimilarity (1) — an absent
  // value is itself unusual relative to a present one.
  function perFeatureDissim(a, b, out) {
    for (let j = 0; j < numF; j++) {
      const va = numVals[a][j], vb = numVals[b][j];
      if (va === null || vb === null) { out[j] = 1; continue; }
      const rg = range[numeric[j]];
      out[j] = rg > 0 ? Math.abs(va - vb) / rg : 0;
    }
    for (let j = 0; j < catF; j++) {
      const va = catVals[a][j], vb = catVals[b][j];
      out[numF + j] = (va === null || vb === null) ? 1 : (va === vb ? 0 : 1);
    }
  }

  // k neighbours: a small fraction of n, at least 3, capped so it stays local.
  const k = Math.max(3, Math.min(options.k ?? 10, n - 1));

  const tmp = new Array(totalF);
  const scored = new Array(n);
  for (let a = 0; a < n; a++) {
    // Track the k smallest distances and accumulate their per-feature terms.
    const nnDist = [];   // {dist, terms}
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      perFeatureDissim(a, b, tmp);
      let sum = 0;
      for (let j = 0; j < totalF; j++) sum += tmp[j];
      const dist = sum / totalF;
      if (nnDist.length < k) {
        nnDist.push({ dist, terms: tmp.slice() });
        if (nnDist.length === k) nnDist.sort((x, y) => y.dist - x.dist); // worst first
      } else if (dist < nnDist[0].dist) {
        nnDist[0] = { dist, terms: tmp.slice() };
        // keep worst-first ordering with a single bubble (k is small)
        let i = 0;
        while (i + 1 < k && nnDist[i].dist < nnDist[i + 1].dist) {
          [nnDist[i], nnDist[i + 1]] = [nnDist[i + 1], nnDist[i]]; i++;
        }
      }
    }
    let distSum = 0;
    const featTerms = new Array(totalF).fill(0);
    for (const nb of nnDist) {
      distSum += nb.dist;
      for (let j = 0; j < totalF; j++) featTerms[j] += nb.terms[j];
    }
    const rawScore = distSum / nnDist.length; // mean distance to k NN
    const termTotal = featTerms.reduce((s, v) => s + v, 0);
    const contributions = featureNames.map((f, j) => ({
      feature: f,
      kind: j < numF ? 'numeric' : 'categorical',
      contribution: termTotal > 0 ? Number((featTerms[j] / termTotal).toFixed(4)) : 0,
    })).sort((x, y) => y.contribution - x.contribution);

    scored[a] = {
      rowIndex: working[a].__idx,
      rawScore: Number(rawScore.toFixed(4)),
      contributions,
      values: Object.fromEntries(featureNames.map(f => [f, working[a].r[f]])),
    };
  }

  // Dataset-relative threshold: flag rows whose raw kNN distance exceeds
  // mean + 3·stddev of the score distribution (a robust "far from the pack"
  // rule fit to THIS dataset). Also expose a normalised 0..1 score for display.
  const raws = scored.map(s => s.rawScore);
  const mean = raws.reduce((a, b) => a + b, 0) / raws.length;
  const variance = raws.reduce((a, b) => a + (b - mean) ** 2, 0) / raws.length;
  const std = Math.sqrt(variance);
  const sigma = options.sigma ?? 3;
  const threshold = mean + sigma * std;
  const maxRaw = Math.max(...raws, 1e-9);

  for (const s of scored) {
    s.score = Number((s.rawScore / maxRaw).toFixed(4)); // 0..1 display score
    s.isAnomaly = std > 0 && s.rawScore > threshold;
    s.reason = describeAnomaly(s);
  }
  scored.sort((a, b) => b.rawScore - a.rawScore);

  return { rows: scored, features, sampling, k, threshold: Number(threshold.toFixed(4)), meanScore: Number(mean.toFixed(4)), stdScore: Number(std.toFixed(4)) };
}

// ---------------------------------------------------------------
// Unified Signal Layer integration (purely additive suppression).
//
// The kNN/Gower score above is computed in complete isolation, exactly as
// before. This step lets the scorer READ what other modules already concluded
// before its flags reach the UI: if the self-learning ranker has learned that
// the user repeatedly dismisses flags on a row's DOMINANT column as false
// positives, showing yet another warning on that row is noise, not signal. So we
// suppress (de-flag + de-rank) it and record WHY.
//
// `lookup` is a tiny injected contract — `dismissalVerdict(column) -> verdict |
// null` — so this stays pure and Node-testable (the browser passes the shared
// SignalStore; tests pass a plain object). With no lookup, or no matching
// verdict, the result is returned untouched: no cross-module signal → identical
// behaviour to before. Mutates and returns the same result object for
// convenience; suppressed rows keep their score but get `suppressed: true`,
// `isAnomaly: false`, a `suppression` record, and an explanatory `reason`.
// ---------------------------------------------------------------
export function suppressAnomaliesWithVerdicts(result, lookup) {
  if (!result || !Array.isArray(result.rows) || !lookup || typeof lookup.dismissalVerdict !== 'function') {
    return result;
  }
  let suppressedCount = 0;
  for (const row of result.rows) {
    if (!row.isAnomaly) continue; // only ever downgrades a flag; never creates one
    // The dominant column is the top contributor to this row's outlier score.
    const top = (row.contributions || []).find(c => c.contribution > 0);
    if (!top) continue;
    const verdict = lookup.dismissalVerdict(top.feature);
    if (!verdict || verdict.verdict !== 'dismiss') continue;
    const times = verdict.meta && Number.isFinite(verdict.meta.dismiss) ? verdict.meta.dismiss : null;
    row.suppressed = true;
    row.isAnomaly = false;
    row.suppression = {
      by: verdict.module || 'self_learning',
      column: top.feature,
      dismiss: times,
      confidence: verdict.confidence ?? null,
    };
    row.reason = describeSuppression(row.rowIndex, top.feature, times) + ' ' + row.reason;
    suppressedCount++;
  }
  result.suppressedCount = suppressedCount;
  return result;
}

// Plain-language "why" for a suppressed row — mirrors the Assumption Ledger's
// readable, first-person style so the user can see the cross-module reasoning.
export function describeSuppression(rowIndex, column, times) {
  const learned = times != null
    ? `you've dismissed flags on "${column}" as false positives ${times} time${times === 1 ? '' : 's'}`
    : `you've repeatedly dismissed flags on "${column}" as false positives`;
  return `Suppressed by the self-learning ranker: ${learned}, so this holistic-anomaly flag is de-ranked as a likely duplicate.`;
}

// Plain-language "why" for a single scored row, from its top feature
// contributions. Consistent with the Assumption Ledger's readable style.
export function describeAnomaly(scored) {
  const top = (scored.contributions || []).filter(c => c.contribution > 0).slice(0, 3);
  if (top.length === 0) {
    return `Row #${scored.rowIndex} sits close to the rest of the dataset — nothing stands out.`;
  }
  const phrase = (c) => {
    const pct = Math.round(c.contribution * 100);
    const val = scored.values[c.feature];
    if (c.kind === 'categorical') {
      return `${c.feature}=${JSON.stringify(val)} rarely co-occurs with these values (${pct}%)`;
    }
    return `${c.feature} (${val}) sits far from similar rows (${pct}%)`;
  };
  const parts = top.map(phrase);
  const joined = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  return `Row #${scored.rowIndex}'s combination of values is unusual: ${joined}.`;
}
