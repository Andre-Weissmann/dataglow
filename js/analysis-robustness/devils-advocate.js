// ============================================================
// DATAGLOW — Devil's Advocate Mode ("Attack My Analysis")
// ============================================================
// Runs a second, adversarial pass over a query result to stress-test whether
// its headline finding actually holds up. Three published robustness checks,
// all computed on the returned result set (dataset-agnostic, no assumptions
// about which dataset is loaded):
//
//   (a) Bootstrap resampling — Efron 1979 ("Bootstrap Methods"). Resample the
//       rows with replacement many times and rebuild the headline metric each
//       time; a wide spread means the finding is an artifact of the particular
//       sample.
//   (b) Trimmed re-estimate — Tukey 1962 (robust statistics). Drop the top and
//       bottom 5% of the metric column and recompute; if the conclusion moves a
//       lot, it was being driven by extreme values.
//   (c) Subgroup leave-one-out — checks whether a grouped finding survives
//       removing its largest subgroup, i.e. whether one group is carrying it.
//
// Pure JS, no DOM and no SQL engine: it consumes the { columns, rows } result
// object the SQL tab already produces, so it is fully unit-testable in Node.

import { logAssumption } from '../provenance/assumption-ledger.js';

const NUMERIC_RELERR = 0.10; // >10% movement in the metric = "materially changed"
const BOOTSTRAP_ITERS = 500;
const TRIM_FRACTION = 0.05;

function isNumeric(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}

// Pick the metric column: caller override, else the first column whose values
// are (mostly) numeric. Returns null if the result has no numeric column.
function pickMetricColumn(columns, rows, override) {
  if (override && columns.includes(override)) return override;
  for (const c of columns) {
    const vals = rows.map(r => r[c]);
    const numeric = vals.filter(isNumeric).length;
    if (numeric >= Math.max(2, rows.length * 0.6)) return c;
  }
  return null;
}

// Pick a grouping column: caller override, else the first non-metric column
// with 2+ distinct values and reasonably low cardinality (a real grouping,
// not a row identifier).
function pickGroupColumn(columns, rows, metricCol, override) {
  if (override && columns.includes(override)) return override;
  for (const c of columns) {
    if (c === metricCol) continue;
    const distinct = new Set(rows.map(r => r[c])).size;
    if (distinct >= 2 && distinct <= Math.max(2, rows.length / 2)) return c;
  }
  return null;
}

function mean(nums) {
  if (!nums.length) return NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function relChange(base, alt) {
  const denom = Math.abs(base) > 1e-9 ? Math.abs(base) : 1;
  return Math.abs(alt - base) / denom;
}

// Mulberry32 — a tiny seeded PRNG so bootstrap verdicts are reproducible in
// tests. Public-domain algorithm.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedNums, p) {
  if (!sortedNums.length) return NaN;
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.round(p * (sortedNums.length - 1))));
  return sortedNums[idx];
}

export function attackAnalysis(queryResult, options = {}) {
  const { columns = [], rows = [] } = queryResult || {};
  const checks = [];

  if (!rows.length) {
    return { verdict: 'inconclusive', robust: false, headline: null, checks: [{ name: 'No data', robust: false, detail: 'The query returned no rows, so there is nothing to stress-test.' }] };
  }

  const metricCol = pickMetricColumn(columns, rows, options.metricColumn);
  if (!metricCol) {
    return { verdict: 'inconclusive', robust: false, headline: null, checks: [{ name: 'No numeric metric', robust: false, detail: 'No numeric column was found in the result, so no aggregate could be stress-tested.' }] };
  }

  const values = rows.map(r => Number(r[metricCol])).filter(Number.isFinite);
  const headlineValue = mean(values);
  const headline = { column: metricCol, statistic: 'mean', value: headlineValue, n: values.length };

  // ---- (a) Bootstrap resampling ----
  const rand = mulberry32(options.seed ?? 0xC0FFEE);
  const boots = [];
  for (let b = 0; b < BOOTSTRAP_ITERS; b++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rand() * values.length)];
    }
    boots.push(sum / values.length);
  }
  boots.sort((a, b) => a - b);
  const ciLow = percentile(boots, 0.025);
  const ciHigh = percentile(boots, 0.975);
  const ciWidth = ciHigh - ciLow;
  const relWidth = Math.abs(headlineValue) > 1e-9 ? ciWidth / Math.abs(headlineValue) : Infinity;
  // A 95% bootstrap CI narrower than ±~15% of the estimate is "robust".
  const bootstrapRobust = relWidth <= 0.30;
  checks.push({
    name: 'Bootstrap resampling',
    robust: bootstrapRobust,
    detail: bootstrapRobust
      ? `Across ${BOOTSTRAP_ITERS} resamples the mean of "${metricCol}" stayed within [${ciLow.toFixed(2)}, ${ciHigh.toFixed(2)}] (95% CI, ±${(relWidth * 50).toFixed(1)}% of the estimate) — the headline number is stable under resampling.`
      : `Across ${BOOTSTRAP_ITERS} resamples the mean of "${metricCol}" swung across [${ciLow.toFixed(2)}, ${ciHigh.toFixed(2)}] (95% CI, ±${(relWidth * 50).toFixed(1)}% of the estimate) — the finding is sensitive to which rows happened to be sampled.`,
    stats: { ciLow, ciHigh, relWidth },
  });

  // ---- (b) Trimmed re-estimate (drop top/bottom 5% outliers) ----
  const sortedVals = [...values].sort((a, b) => a - b);
  const cut = Math.floor(values.length * TRIM_FRACTION);
  const trimmed = cut > 0 ? sortedVals.slice(cut, sortedVals.length - cut) : sortedVals;
  const trimmedMean = mean(trimmed);
  const trimChange = relChange(headlineValue, trimmedMean);
  const trimRobust = trimChange <= NUMERIC_RELERR;
  checks.push({
    name: 'Outlier exclusion (trim 5%)',
    robust: trimRobust,
    detail: trimRobust
      ? `Excluding the top and bottom ${(TRIM_FRACTION * 100).toFixed(0)}% of "${metricCol}", the mean moves only ${(trimChange * 100).toFixed(1)}% (to ${trimmedMean.toFixed(2)}) — the conclusion does not hinge on extreme values.`
      : `Excluding the top and bottom ${(TRIM_FRACTION * 100).toFixed(0)}% of "${metricCol}", the mean shifts ${(trimChange * 100).toFixed(1)}% (to ${trimmedMean.toFixed(2)}) — the finding is being driven by a few extreme values.`,
    stats: { trimmedMean, trimChange },
  });

  // ---- (c) Subgroup leave-one-out (is one group carrying the finding?) ----
  const groupCol = pickGroupColumn(columns, rows, metricCol, options.groupColumn);
  if (groupCol) {
    const groups = new Map();
    for (const r of rows) {
      const v = Number(r[metricCol]);
      if (!Number.isFinite(v)) continue;
      const key = r[groupCol];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    // Largest subgroup by row count.
    let largestKey = null, largestN = -1;
    for (const [k, vs] of groups) { if (vs.length > largestN) { largestN = vs.length; largestKey = k; } }
    const withoutLargest = values.filter((_, i) => rows[i][groupCol] !== largestKey);
    const withoutMean = mean(withoutLargest);
    const subgroupChange = relChange(headlineValue, withoutMean);
    const subgroupRobust = withoutLargest.length > 0 && subgroupChange <= NUMERIC_RELERR;
    checks.push({
      name: 'Subgroup robustness',
      robust: subgroupRobust,
      detail: subgroupRobust
        ? `Removing the largest subgroup ("${groupCol}" = "${largestKey}", ${largestN} rows) changes the mean by only ${(subgroupChange * 100).toFixed(1)}% — the finding holds across subgroups, not just one.`
        : `Removing the largest subgroup ("${groupCol}" = "${largestKey}", ${largestN} rows) changes the mean by ${(subgroupChange * 100).toFixed(1)}% (to ${withoutMean.toFixed(2)}) — the headline is largely driven by this one group.`,
      stats: { groupColumn: groupCol, largestGroup: largestKey, subgroupChange },
    });
  }

  const robust = checks.every(c => c.robust);
  const sensitiveTo = checks.filter(c => !c.robust).map(c => c.name);
  const verdict = robust
    ? 'Your finding is robust.'
    : `Your finding is sensitive to: ${sensitiveTo.join(', ')}.`;

  if (options.log !== false) {
    logAssumption(
      "Devil's Advocate Mode",
      `Attacked the mean of "${metricCol}" (${headlineValue.toFixed(2)}, n=${headline.n}): ${robust ? 'survived all robustness checks' : `sensitive to ${sensitiveTo.join(', ')}`}.`,
      { headline, checks: checks.map(c => ({ name: c.name, robust: c.robust })) }
    );
  }

  return { verdict, robust, headline, checks };
}
