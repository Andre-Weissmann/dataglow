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
