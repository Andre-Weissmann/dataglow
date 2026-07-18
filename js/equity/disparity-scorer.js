// ============================================================
// DATAGLOW — Disparity Scorer (Phase 3)
// ============================================================
// Pure statistical disparity detection. Takes pre-computed group-level
// rates/means and returns disparity findings -- flagging when any group
// deviates meaningfully from the reference (population mean or largest group).
//
// WHY THIS EXISTS:
// CMS defines health equity disparity as a meaningful difference in outcomes
// between population subgroups. "Meaningful" has specific definitions:
//   - Rate ratio >= 1.5x (one group's rate is 50% higher than reference)
//   - Absolute difference >= 5 percentage points for binary outcomes
//   - Standardized mean difference >= 0.2 for continuous outcomes
// These are not arbitrary -- they match CMS Disparities Impact Statement
// methodology and HEDIS disparity measurement guidance.
//
// DESIGN:
// Pure and synchronous. Takes an array of {group, n, rate, mean} objects
// and returns scored findings. No DuckDB, no DOM, no network.
// The stratifier (js/equity/equity-stratifier.js) handles the SQL; this
// module handles only the statistics.

// ---- Disparity thresholds --------------------------------------------------
// Aligned with CMS Disparities Impact Statement and HEDIS methodology.

export const RATE_RATIO_WARN   = 1.25; // 25% higher than reference -> warn
export const RATE_RATIO_FAIL   = 1.50; // 50% higher -> fail (CMS threshold)
export const ABS_DIFF_WARN     = 0.03; // 3 pp absolute difference -> warn
export const ABS_DIFF_FAIL     = 0.05; // 5 pp -> fail (CMS threshold)
export const SMD_WARN          = 0.10; // standardized mean difference -> warn
export const SMD_FAIL          = 0.20; // SMD >= 0.2 -> fail (Cohen's d small)
export const MIN_CELL_SIZE     = 5;    // suppress cells below this count (NCHS standard)

/**
 * Score disparities across a set of group-level statistics.
 *
 * @param {object} opts
 * @param {Array<{group:string, n:number, rate?:number, mean?:number, sum?:number}>} opts.groups
 *   Pre-computed group statistics. Use `rate` for binary outcomes (0/1 flags),
 *   `mean` for continuous outcomes (LOS, cost).
 * @param {'binary'|'continuous'} opts.metricType
 *   'binary'  = rate-based (readmit, denial, mortality flags)
 *   'continuous' = mean-based (LOS, cost, quality score)
 * @param {string} [opts.metricName] - human-readable metric name
 * @param {string} [opts.stratifierName] - human-readable stratifier name
 * @param {'population_mean'|'largest_group'} [opts.referenceMethod='population_mean']
 *   How to choose the reference value.
 * @returns {object} disparity scoring result
 */
export function scoreDisparities({
  groups = [],
  metricType = 'binary',
  metricName = 'metric',
  stratifierName = 'stratifier',
  referenceMethod = 'population_mean',
} = {}) {
  // Filter to groups with sufficient cell size (small-cell suppression).
  const eligible = groups.filter(g => g && typeof g.n === 'number' && g.n >= MIN_CELL_SIZE);
  const suppressed = groups.filter(g => g && typeof g.n === 'number' && g.n < MIN_CELL_SIZE);

  if (eligible.length < 2) {
    return makeResult({
      metricName, stratifierName, metricType,
      groups, eligible, suppressed,
      reference: null, findings: [],
      status: 'idle', level: 'none',
      rationale: eligible.length === 0
        ? 'All groups below minimum cell size (' + MIN_CELL_SIZE + ') -- disparity analysis suppressed.'
        : 'Only one group with sufficient cell size -- need at least 2 groups for disparity analysis.',
    });
  }

  // Compute the reference value.
  const getValue = (g) => metricType === 'binary'
    ? (typeof g.rate === 'number' ? g.rate : null)
    : (typeof g.mean === 'number' ? g.mean : null);

  const eligibleWithValue = eligible.filter(g => getValue(g) !== null);
  if (eligibleWithValue.length < 2) {
    return makeResult({
      metricName, stratifierName, metricType,
      groups, eligible, suppressed,
      reference: null, findings: [],
      status: 'idle', level: 'none',
      rationale: 'Insufficient numeric values across groups for disparity scoring.',
    });
  }

  let referenceValue;
  let referenceLabel;
  if (referenceMethod === 'largest_group') {
    const largest = [...eligibleWithValue].sort((a, b) => b.n - a.n)[0];
    referenceValue = getValue(largest);
    referenceLabel = largest.group + ' (largest group, n=' + largest.n + ')';
  } else {
    // Population mean: weighted average across eligible groups.
    const totalN = eligibleWithValue.reduce((s, g) => s + g.n, 0);
    referenceValue = eligibleWithValue.reduce((s, g) => s + getValue(g) * g.n, 0) / totalN;
    referenceLabel = 'population mean (' + fmtRate(referenceValue, metricType) + ', n=' + totalN + ')';
  }

  // Score each group against the reference.
  const findings = [];
  for (const g of eligibleWithValue) {
    const val = getValue(g);
    if (val === null) continue;

    const finding = scoreGroup({
      group: g.group, n: g.n, value: val, referenceValue, referenceLabel,
      metricType, metricName, stratifierName,
    });
    findings.push(finding);
  }

  // Sort by severity (worst first).
  findings.sort((a, b) => {
    const sev = { high: 3, medium: 2, low: 1, none: 0 };
    return (sev[b.level] || 0) - (sev[a.level] || 0);
  });

  const flagged = findings.filter(f => f.flagged);
  const worstLevel = findings.some(f => f.level === 'high') ? 'high'
    : findings.some(f => f.level === 'medium') ? 'medium'
    : findings.some(f => f.level === 'low') ? 'low' : 'none';
  const status = flagged.some(f => f.status === 'fail') ? 'fail'
    : flagged.some(f => f.status === 'warn') ? 'warn'
    : 'pass';

  const rationale = buildRationale({
    flagged, findings, metricName, stratifierName, referenceLabel, suppressed, status,
  });

  return makeResult({
    metricName, stratifierName, metricType,
    referenceValue, referenceLabel, referenceMethod,
    groups, eligible, suppressed,
    findings, flagged,
    status, level: worstLevel, rationale,
  });
}

// ---- per-group scorer -------------------------------------------------------

function scoreGroup({ group, n, value, referenceValue, referenceLabel,
  metricType, metricName, stratifierName }) {
  let rateRatio = null, absDiff = null, smd = null;
  let flagged = false, status = 'pass', level = 'none';
  const signals = [];

  if (metricType === 'binary') {
    // Rate ratio (avoid div/0 -- if reference is 0, any non-zero is extreme)
    if (referenceValue > 0) {
      rateRatio = value / referenceValue;
    } else if (value > 0) {
      rateRatio = Infinity;
    } else {
      rateRatio = 1;
    }

    // Absolute difference (signed)
    absDiff = value - referenceValue;

    // Score by rate ratio (use absolute ratio for suppressed groups)
    const absRatio = rateRatio === Infinity ? 99 : Math.max(rateRatio, rateRatio > 0 ? 1 / rateRatio : 1);
    if (absRatio >= RATE_RATIO_FAIL || Math.abs(absDiff) >= ABS_DIFF_FAIL) {
      flagged = true; level = absRatio >= 2.0 || Math.abs(absDiff) >= 0.10 ? 'high' : 'medium';
      status = 'fail';
      if (absRatio >= RATE_RATIO_FAIL) signals.push('rate ratio ' + fmt2(rateRatio) + 'x (threshold ' + RATE_RATIO_FAIL + 'x)');
      if (Math.abs(absDiff) >= ABS_DIFF_FAIL) signals.push('absolute difference ' + fmtPct(Math.abs(absDiff)) + ' pp (threshold ' + fmtPct(ABS_DIFF_FAIL) + ' pp)');
    } else if (absRatio >= RATE_RATIO_WARN || Math.abs(absDiff) >= ABS_DIFF_WARN) {
      flagged = true; level = 'low';
      status = 'warn';
      if (absRatio >= RATE_RATIO_WARN) signals.push('rate ratio ' + fmt2(rateRatio) + 'x (threshold ' + RATE_RATIO_WARN + 'x)');
      if (Math.abs(absDiff) >= ABS_DIFF_WARN) signals.push('absolute difference ' + fmtPct(Math.abs(absDiff)) + ' pp (threshold ' + fmtPct(ABS_DIFF_WARN) + ' pp)');
    }

  } else {
    // Continuous metric -- use standardized mean difference (Cohen's d approximation)
    // SMD = (group_mean - reference_mean) / reference_mean (relative effect)
    // For a proper SMD we'd need pooled SD; we use relative deviation as a proxy
    // and label it clearly as an estimate.
    if (referenceValue !== 0) {
      smd = Math.abs(value - referenceValue) / Math.abs(referenceValue);
      absDiff = value - referenceValue;
    }

    if (smd !== null && smd >= SMD_FAIL) {
      flagged = true; level = smd >= 0.40 ? 'high' : 'medium';
      status = 'fail';
      signals.push('relative deviation ' + fmtPct(smd) + ' (threshold ' + fmtPct(SMD_FAIL) + ')');
    } else if (smd !== null && smd >= SMD_WARN) {
      flagged = true; level = 'low';
      status = 'warn';
      signals.push('relative deviation ' + fmtPct(smd) + ' (threshold ' + fmtPct(SMD_WARN) + ')');
    }
  }

  const direction = absDiff !== null
    ? (absDiff > 0 ? 'above' : absDiff < 0 ? 'below' : 'at')
    : 'at';

  return {
    group,
    n,
    value,
    rateRatio,
    absDiff,
    smd,
    flagged,
    status,
    level,
    direction,
    signals,
    rationale: flagged
      ? 'Group "' + group + '" (n=' + n + '): ' + fmtRate(value, metricType) + ' vs reference ' + referenceLabel + ' -- ' + signals.join('; ') + '.'
      : 'Group "' + group + '" (n=' + n + '): ' + fmtRate(value, metricType) + ' -- within acceptable range of ' + referenceLabel + '.',
  };
}

// ---- helpers ---------------------------------------------------------------

function fmtRate(v, metricType) {
  if (v === null || v === undefined) return 'N/A';
  if (metricType === 'binary') return (v * 100).toFixed(1) + '%';
  return v.toFixed(2);
}

function fmtPct(v) { return (v * 100).toFixed(1); }
function fmt2(v) { return v === Infinity ? '∞' : v.toFixed(2); }

function buildRationale({ flagged, findings, metricName, stratifierName, referenceLabel, suppressed, status }) {
  if (findings.length === 0) return 'No disparity findings.';
  if (flagged.length === 0) {
    return 'No significant disparities detected in ' + metricName + ' by ' + stratifierName + ' (reference: ' + referenceLabel + '). ' + findings.length + ' group(s) analyzed.';
  }
  const parts = [
    flagged.length + ' disparity finding(s) in ' + metricName + ' by ' + stratifierName + ':',
  ];
  for (const f of flagged.slice(0, 5)) {
    parts.push('  ' + f.group + ': ' + f.rationale);
  }
  if (suppressed.length > 0) {
    parts.push(suppressed.length + ' group(s) suppressed (n < ' + MIN_CELL_SIZE + '): ' + suppressed.map(g => g.group).join(', ') + '.');
  }
  return parts.join('\n');
}

function makeResult(obj) {
  return {
    layer: 'equity_disparity',
    ...obj,
  };
}
