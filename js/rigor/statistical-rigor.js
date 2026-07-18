// ============================================================
// DATAGLOW — Statistical Rigor Layer
// Pure-JS, zero new dependencies, runs entirely in-browser.
// ============================================================
//
// Batch 1 of "The Rigor Engine" concept (see NORTH_STAR.md). This module is
// intentionally standalone: pure functions only, no DOM/network/DuckDB
// imports, no wiring into the SQL tab, Visualize, Story, or the AI Readiness
// Gate. Those are later batches, each its own PR. This batch exists so the
// underlying math can be tested and trusted in isolation first.
//
// Every everyday BI tool (Power BI, Tableau, Excel) ships point estimates
// with no attached uncertainty — this module is DataGlow's answer: give any
// aggregate (mean, rate, group comparison) a confidence interval, an effect
// size, and a few senior-analyst sanity checks (Simpson's paradox, multiple
// comparisons) for free, computed 100% on-device.
//
// Formulas follow standard, textbook statistics (Wasserman, "All of
// Statistics"; Cohen, 1988 for effect size conventions) — nothing proprietary,
// nothing that requires a network call or a paid API.

/**
 * Sample mean of a numeric array. Returns null for an empty array.
 * @param {number[]} values
 * @returns {number|null}
 */
export function mean(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((sum, v) => sum + v, 0) / clean.length;
}

/**
 * Sample standard deviation (n-1 denominator, i.e. the unbiased sample
 * estimator). Returns null when fewer than 2 finite values are present.
 * @param {number[]} values
 * @returns {number|null}
 */
export function sampleStdDev(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length < 2) return null;
  const m = mean(clean);
  const variance = clean.reduce((sum, v) => sum + (v - m) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

// Two-tailed critical z-values for common confidence levels. A t-distribution
// would be more exact for small n, but for n >= ~30 the difference from z is
// negligible, and for very small n this module's job is to flag the sample as
// too small to trust (see classifyConfidence) rather than pretend precision
// with a fancier formula. Kept as a lookup, not a full inverse-t-CDF
// implementation, to stay dependency-free and auditable at a glance.
const Z_SCORES = { 0.80: 1.282, 0.90: 1.645, 0.95: 1.96, 0.99: 2.576 };

/**
 * 95%-style confidence interval for a sample mean, using the normal
 * approximation (standard error = sd / sqrt(n)). Returns null when the
 * input can't support an interval (fewer than 2 finite values).
 * @param {number[]} values
 * @param {number} [confidenceLevel=0.95] One of 0.80, 0.90, 0.95, 0.99.
 * @returns {{mean:number, marginOfError:number, lower:number, upper:number, n:number, confidenceLevel:number}|null}
 */
export function confidenceIntervalForMean(values, confidenceLevel = 0.95) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length < 2) return null;
  const z = Z_SCORES[confidenceLevel] ?? Z_SCORES[0.95];
  const m = mean(clean);
  const sd = sampleStdDev(clean);
  const standardError = sd / Math.sqrt(clean.length);
  const marginOfError = z * standardError;
  return {
    mean: m,
    marginOfError,
    lower: m - marginOfError,
    upper: m + marginOfError,
    n: clean.length,
    confidenceLevel,
  };
}

/**
 * Classifies whether a sample size is large enough for its confidence
 * interval to be considered defensible in a senior-analyst sense, rather
 * than silently presenting a wide-but-real interval as if it were as trustworthy
 * as a narrow one. This is a threshold judgment call, not a universal law —
 * n=30 is the conventional rule-of-thumb minimum for the normal approximation
 * to behave reasonably; below that, non-normality and outlier sensitivity can
 * make the interval understate real uncertainty.
 * @param {number} n
 * @returns {'sufficient'|'low'|'insufficient'}
 */
export function classifySampleSize(n) {
  if (n >= 30) return 'sufficient';
  if (n >= 10) return 'low';
  return 'insufficient';
}

/**
 * Cohen's d effect size for the difference between two independent samples'
 * means, using the pooled standard deviation. Returns null when either group
 * has fewer than 2 finite values, or when the pooled standard deviation is 0
 * (no variance to normalize by).
 * @param {number[]} groupA
 * @param {number[]} groupB
 * @returns {{d:number, magnitude:'negligible'|'small'|'medium'|'large'}|null}
 */
export function cohensD(groupA, groupB) {
  const a = groupA.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const b = groupB.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (a.length < 2 || b.length < 2) return null;
  const meanA = mean(a);
  const meanB = mean(b);
  const sdA = sampleStdDev(a);
  const sdB = sampleStdDev(b);
  const pooledSd = Math.sqrt(
    ((a.length - 1) * sdA ** 2 + (b.length - 1) * sdB ** 2) / (a.length + b.length - 2)
  );
  if (!pooledSd || pooledSd === 0) return null;
  const d = (meanA - meanB) / pooledSd;
  const absD = Math.abs(d);
  let magnitude;
  if (absD < 0.2) magnitude = 'negligible';
  else if (absD < 0.5) magnitude = 'small';
  else if (absD < 0.8) magnitude = 'medium';
  else magnitude = 'large';
  return { d, magnitude };
}

/**
 * Bonferroni-adjusted significance threshold for running multiple
 * independent comparisons (e.g. ranking N groups pairwise, or testing N
 * segments against a baseline). Conservative by design — the standard,
 * textbook correction, not a novel method — chosen over more powerful but
 * more complex alternatives (Benjamini-Hochberg) so the first version of this
 * module is simple enough to audit at a glance.
 * @param {number} numComparisons Must be >= 1.
 * @param {number} [familyWiseAlpha=0.05]
 * @returns {number} The per-comparison alpha threshold to use instead of familyWiseAlpha.
 */
export function bonferroniAdjustedAlpha(numComparisons, familyWiseAlpha = 0.05) {
  const n = Math.max(1, Math.floor(numComparisons));
  return familyWiseAlpha / n;
}

/**
 * Detects a Simpson's-paradox-style reversal: does the ranking/direction of
 * an aggregate metric across two groups flip when the same data is segmented
 * by a third variable? Takes pre-aggregated rows shaped as
 * { segment, group, value, n } (one row per segment x group combination) so
 * this module stays engine-agnostic — callers run the actual GROUP BY query
 * with DuckDB and pass in the results.
 *
 * @param {{segment:string, group:string, value:number, n:number}[]} segmentedRows
 * @param {string} groupA
 * @param {string} groupB
 * @returns {{reversalDetected:boolean, overallDirection:'A'|'B'|'tie', segmentDirections:Record<string,'A'|'B'|'tie'>}}
 */
export function detectSimpsonsParadox(segmentedRows, groupA, groupB) {
  const bySegment = new Map();
  for (const row of segmentedRows) {
    if (!bySegment.has(row.segment)) bySegment.set(row.segment, {});
    bySegment.get(row.segment)[row.group] = row;
  }

  const direction = (rowA, rowB) => {
    if (!rowA || !rowB) return null;
    if (rowA.value === rowB.value) return 'tie';
    return rowA.value > rowB.value ? 'A' : 'B';
  };

  // Overall direction: weighted by n across all segments combined.
  let totalA = 0;
  let totalWeightA = 0;
  let totalB = 0;
  let totalWeightB = 0;
  for (const segRows of bySegment.values()) {
    const rowA = segRows[groupA];
    const rowB = segRows[groupB];
    if (rowA) {
      totalA += rowA.value * rowA.n;
      totalWeightA += rowA.n;
    }
    if (rowB) {
      totalB += rowB.value * rowB.n;
      totalWeightB += rowB.n;
    }
  }
  const overallMeanA = totalWeightA > 0 ? totalA / totalWeightA : null;
  const overallMeanB = totalWeightB > 0 ? totalB / totalWeightB : null;
  let overallDirection = 'tie';
  if (overallMeanA != null && overallMeanB != null && overallMeanA !== overallMeanB) {
    overallDirection = overallMeanA > overallMeanB ? 'A' : 'B';
  }

  const segmentDirections = {};
  let reversalDetected = false;
  for (const [segment, segRows] of bySegment.entries()) {
    const dir = direction(segRows[groupA], segRows[groupB]);
    if (dir == null) continue;
    segmentDirections[segment] = dir;
    if (dir !== 'tie' && overallDirection !== 'tie' && dir !== overallDirection) {
      reversalDetected = true;
    }
  }

  return { reversalDetected, overallDirection, segmentDirections };
}

/**
 * Folds sample-size classification and confidence-interval width into one
 * plain-language confidence verdict for a single group's aggregate. This is
 * the function the later Agent Honesty Layer batch (Batch 3) will call to
 * decide whether an agent may state a finding as fact or must caveat/refuse.
 * Deliberately conservative: 'insufficient' wins over any other signal.
 * @param {number[]} values
 * @param {number} [confidenceLevel=0.95]
 * @returns {{verdict:'sufficient'|'low'|'insufficient', n:number, ci:object|null, reason:string}}
 */
export function classifyConfidence(values, confidenceLevel = 0.95) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const n = clean.length;
  const sampleClass = classifySampleSize(n);
  const ci = confidenceIntervalForMean(clean, confidenceLevel);

  if (sampleClass === 'insufficient') {
    return {
      verdict: 'insufficient',
      n,
      ci,
      reason: `Only ${n} observation(s) — too few to support a statistically defensible claim (rule-of-thumb minimum: 10).`,
    };
  }
  if (sampleClass === 'low') {
    return {
      verdict: 'low',
      n,
      ci,
      reason: `n=${n} is below the conventional n=30 threshold for the normal approximation — treat any interval here as wider than shown.`,
    };
  }
  return {
    verdict: 'sufficient',
    n,
    ci,
    reason: `n=${n} meets the conventional n>=30 threshold for a defensible confidence interval.`,
  };
}

/**
 * Batch 2 of "The Rigor Engine": groups already-fetched rows by a category
 * column and runs classifyConfidence() over each group's numeric column, so
 * a caller (the SQL result table, or a Visualize aggregate chart) can badge
 * EVERY group with its own honest confidence verdict in one pass, rather
 * than a single verdict for the whole result set. Pure, engine-agnostic —
 * the caller runs the actual SQL/DuckDB query and passes plain rows in;
 * this module never touches DuckDB, the DOM, or the network.
 *
 * Rows with a null/undefined group value are grouped under the literal
 * string '(null)' rather than silently dropped, so a caller can see there
 * WAS a null-group slice rather than an undercount with no explanation.
 *
 * Two distinct input shapes are supported, and this function must never
 * confuse them (this is the fix for a real bug found 2026-07-18 during a
 * live-preview check before this flag went live — see dev-log/journal.md):
 *
 *   1. Row-level (un-aggregated) data — each row is one real observation.
 *      e.g. `SELECT gender, length_of_stay FROM patients`. Here, counting
 *      how many rows land in each group IS the correct sample size, so no
 *      `countCol` is needed.
 *   2. Pre-aggregated GROUP BY results — each row already represents many
 *      collapsed observations. e.g. `SELECT gender, AVG(los), COUNT(*) AS n
 *      FROM patients GROUP BY gender` returns exactly ONE row per group, so
 *      counting rows-per-group always yields n=1 regardless of the real
 *      underlying sample size — confidently wrong, not just imprecise. When
 *      the query already computed a count, that real count MUST be used
 *      instead of the row-counting fallback.
 *
 * Callers that know they have a pre-aggregated result should pass the name
 * of the column holding each row's true observation count as `countCol`
 * (see `detectGroupedConfidenceColumns` for the auto-detection heuristic
 * used by the SQL-tab/Visualize-tab callers). When `countCol` is omitted or
 * not present/numeric on a row, this function falls back to counting rows
 * per group — correct for shape 1, and an honest (clearly labelled by the
 * caller, never silently overstated) best-effort for shape 2 when no count
 * column exists in the query result.
 *
 * @param {Array<Record<string, *>>} rows
 * @param {string} groupCol
 * @param {string} valueCol
 * @param {number} [confidenceLevel=0.95]
 * @param {string|null} [countCol=null] column holding each row's true
 *   observation count, for pre-aggregated GROUP BY results. Omit for
 *   row-level data where each row is one real observation.
 * @returns {Array<{group:string, verdict:'sufficient'|'low'|'insufficient', n:number, ci:object|null, reason:string, nSource:'counted-rows'|'count-column'}>}
 *   One entry per distinct group value, in first-seen order.
 */
export function classifyGroupedConfidence(rows, groupCol, valueCol, confidenceLevel = 0.95, countCol = null) {
  if (!Array.isArray(rows)) return [];
  const order = [];
  const buckets = new Map();
  const explicitCounts = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rawGroup = row[groupCol];
    const group = rawGroup === null || rawGroup === undefined ? '(null)' : String(rawGroup);
    if (!buckets.has(group)) { buckets.set(group, []); order.push(group); }
    const v = row[valueCol];
    if (typeof v === 'number' && Number.isFinite(v)) buckets.get(group).push(v);
    if (countCol) {
      const c = row[countCol];
      if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
        // A pre-aggregated result has exactly one row per group, so the last
        // (only) count seen for a group is the count — no summing needed.
        explicitCounts.set(group, c);
      }
    }
  }
  return order.map((group) => {
    const values = buckets.get(group) || [];
    const explicitN = explicitCounts.get(group);
    if (typeof explicitN === 'number') {
      // Re-run the same threshold logic classifyConfidence uses, but against
      // the REAL observation count rather than values.length, since values
      // here holds only the one pre-aggregated number per group (e.g. the
      // AVG), not the underlying observations — there is no raw sample to
      // compute a real confidence interval from, so ci is honestly null.
      const sampleClass = classifySampleSize(explicitN);
      let verdict, reason;
      if (sampleClass === 'insufficient') {
        verdict = 'insufficient';
        reason = `Only ${explicitN} observation(s) — too few to support a statistically defensible claim (rule-of-thumb minimum: 10).`;
      } else if (sampleClass === 'low') {
        verdict = 'low';
        reason = `n=${explicitN} is below the conventional n=30 threshold for the normal approximation — treat any interval here as wider than shown.`;
      } else {
        verdict = 'sufficient';
        reason = `n=${explicitN} meets the conventional n>=30 threshold for a defensible confidence interval.`;
      }
      return { group, verdict, n: explicitN, ci: null, reason, nSource: 'count-column' };
    }
    return { group, ...classifyConfidence(values, confidenceLevel), nSource: 'counted-rows' };
  });
}

/**
 * Folds a full grouped-confidence pass (classifyGroupedConfidence output)
 * into ONE overall verdict for a badge that has room for a single summary,
 * not a per-group breakdown (e.g. a compact SQL-result-table header badge).
 * Deliberately conservative, same rule as classifyConfidence itself: the
 * WORST verdict among groups wins, never an average or a majority vote —
 * one thin/insufficient slice is enough to caveat the whole result. Returns
 * a safe 'insufficient'/n=0 shape for an empty input rather than throwing.
 * @param {Array<{verdict:string, n:number}>} groupVerdicts
 * @returns {{verdict:'sufficient'|'low'|'insufficient', worstN:number, groupCount:number, reason:string}}
 */
export function summarizeGroupedConfidence(groupVerdicts) {
  const RANK = { insufficient: 0, low: 1, sufficient: 2 };
  if (!Array.isArray(groupVerdicts) || groupVerdicts.length === 0) {
    return { verdict: 'insufficient', worstN: 0, groupCount: 0, reason: 'No groups to evaluate.' };
  }
  let worst = groupVerdicts[0];
  for (const g of groupVerdicts) {
    if (RANK[g.verdict] < RANK[worst.verdict]) worst = g;
  }
  const groupCount = groupVerdicts.length;
  const reason = groupCount === 1
    ? worst.reason
    : `Weakest of ${groupCount} groups: ${worst.reason}`;
  return { verdict: worst.verdict, worstN: worst.n, groupCount, reason };
}
