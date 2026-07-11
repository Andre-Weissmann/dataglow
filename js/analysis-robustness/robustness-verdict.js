// ============================================================
// DATAGLOW — Analysis Robustness: Assumption Sensitivity + Plain-Language Verdict
// ============================================================
// Two small, pure capabilities that EXTEND (never replace) the Devil's Advocate
// mode (js/analysis-robustness/devils-advocate.js, `attackAnalysis`). Where
// attackAnalysis stress-tests the headline *mean* of a result, these two answer
// the questions a person actually asks before acting on a between-group finding
// ("metric X differs by Y% between groups A and B"):
//
//   1. mapAssumptionSensitivity — WHICH specific rows/subgroup is the whole
//      conclusion resting on? It greedily finds the smallest set of rows whose
//      removal makes the A-vs-B gap disappear or reverse, then checks whether
//      those rows concentrate in one named segment (a shared value of some other
//      column). Output is a plain-language-READY object (which rows, which
//      segment, how far the effect moves, a severity label) — not just a number,
//      because a future non-technical surface will render it.
//
//   2. robustnessVerdict — folds the existing attackAnalysis output together with
//      the sensitivity map into ONE fixed-vocabulary verdict
//      ({verdict:'robust'|'fragile'|'inconclusive', reason, drivingFactor}), with
//      a one-sentence, plain-English reason GROUNDED in the real numbers (never a
//      generic template with nothing plugged in). A robust finding is told so
//      plainly; this is honest and non-alarmist, not a flag-only surface.
//
// Pure JS: no DOM, no SQL engine, no network, no logging side-effects — it
// consumes the { columns, rows } result object the SQL tab already produces (the
// same shape attackAnalysis takes) and the plain object attackAnalysis returns,
// so it is fully unit-testable in Node. Intentionally data-shaped output so a
// later UI layer (technical or stakeholder-facing) can render it either way.

// A between-group gap counts as "broken" once it shrinks to a quarter of its
// original size (or smaller) — i.e. 75%+ of the effect is gone.
const DISAPPEAR_FRAC = 0.25;
// If a gap can be broken by dropping <=10% of rows it is fragile; <=30% is
// moderate; anything sturdier (or unbreakable while both groups keep >=1 row) is
// robust. Fractions, not counts, so the labels are scale-free.
const FRAGILE_FRACTION = 0.10;
const MODERATE_FRACTION = 0.30;
// A between-group gap smaller than 2% of the pooled mean magnitude is treated as
// "no real effect to begin with" rather than a finding worth stress-testing.
const ZERO_EFFECT_REL = 0.02;
// The removed rows "concentrate in a segment" only if >=60% of them share one
// value of one column (and at least two of them do).
const SEGMENT_COVERAGE = 0.6;

function isNumeric(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}

function mean(nums) {
  if (!nums.length) return NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Pick the metric column: caller override, else the first column whose values
// are (mostly) numeric. Mirrors attackAnalysis's own heuristic so the two agree
// on which column is the metric without importing private helpers.
function pickMetricColumn(columns, rows, override) {
  if (override && columns.includes(override)) return override;
  for (const c of columns) {
    const vals = rows.map((r) => r[c]);
    const numeric = vals.filter(isNumeric).length;
    if (numeric >= Math.max(2, rows.length * 0.6)) return c;
  }
  return null;
}

// Pick the grouping column (the A/B split): caller override, else the first
// non-metric column with 2+ distinct values and reasonably low cardinality (a
// real grouping, not a row identifier).
function pickGroupColumn(columns, rows, metricCol, override) {
  if (override && columns.includes(override)) return override;
  for (const c of columns) {
    if (c === metricCol) continue;
    const distinct = new Set(rows.map((r) => r[c])).size;
    if (distinct >= 2 && distinct <= Math.max(2, rows.length / 2)) return c;
  }
  return null;
}

function inapplicable(reason, extra = {}) {
  return {
    applicable: false,
    severity: 'inconclusive',
    reason,
    metricColumn: null,
    groupColumn: null,
    groupA: null,
    groupB: null,
    baseEffect: null,
    minRowsToBreak: null,
    fractionToBreak: null,
    breakMode: 'stable',
    segment: null,
    totalRows: 0,
    summary: reason,
    ...extra,
  };
}

/**
 * Map how sensitive an A-vs-B between-group finding is to a handful of rows.
 *
 * @param {{columns?:string[], rows?:object[]}} queryResult The SQL result.
 * @param {object} [options]
 * @param {string} [options.metricColumn] Force the numeric metric column.
 * @param {string} [options.groupColumn]  Force the grouping (A/B) column.
 * @param {*} [options.groupA] Force one group value to compare.
 * @param {*} [options.groupB] Force the other group value to compare.
 * @returns {object} A plain-language-ready sensitivity summary (see header).
 */
export function mapAssumptionSensitivity(queryResult, options = {}) {
  const { columns = [], rows = [] } = queryResult || {};

  if (!rows.length) return inapplicable('The query returned no rows, so there is nothing to stress-test.');
  if (rows.length < 2) return inapplicable('A single row cannot support a between-group comparison.');

  const metricCol = pickMetricColumn(columns, rows, options.metricColumn);
  if (!metricCol) return inapplicable('No numeric metric column was found, so no group difference could be measured.');

  const groupCol = pickGroupColumn(columns, rows, metricCol, options.groupColumn);
  if (!groupCol) return inapplicable('No grouping column with two or more groups was found, so there is no A-vs-B gap to test.');

  // Collect (value, row) pairs per group, keeping only numeric metric values.
  const byGroup = new Map();
  const pts = []; // { v, group, row }
  for (const r of rows) {
    const v = Number(r[metricCol]);
    if (!Number.isFinite(v)) continue;
    const key = r[groupCol];
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(v);
    pts.push({ v, group: key, row: r });
  }
  if (byGroup.size < 2) return inapplicable('Only one group has numeric values, so there is no A-vs-B gap to test.');

  // Choose the two groups to compare. Caller override wins; otherwise the two
  // largest by row count (the pair a headline is most likely to be about).
  let gKeys;
  if (options.groupA != null && options.groupB != null && byGroup.has(options.groupA) && byGroup.has(options.groupB)) {
    gKeys = [options.groupA, options.groupB];
  } else {
    gKeys = [...byGroup.keys()].sort((a, b) => byGroup.get(b).length - byGroup.get(a).length).slice(0, 2);
  }
  // Assign A = higher-mean group, B = lower-mean group, so a positive baseEffect
  // always means "A is above B" and a sign flip is unambiguously a reversal.
  const [k0, k1] = gKeys;
  const [hi, lo] = mean(byGroup.get(k0)) >= mean(byGroup.get(k1)) ? [k0, k1] : [k1, k0];
  const groupA = hi;
  const groupB = lo;

  // Running sums so each candidate removal is O(1) and each greedy step O(n).
  const active = pts.filter((p) => p.group === groupA || p.group === groupB);
  const removed = [];
  const state = active.map((p) => ({ ...p, gone: false }));
  let sumA = 0, cntA = 0, sumB = 0, cntB = 0;
  for (const p of state) {
    if (p.group === groupA) { sumA += p.v; cntA++; } else { sumB += p.v; cntB++; }
  }
  const totalRows = cntA + cntB;
  const meanBFixed = () => sumB / cntB;
  const effect = () => sumA / cntA - sumB / cntB;
  const e0 = effect();
  const pooledMag = (Math.abs(sumA / cntA) + Math.abs(sumB / cntB)) / 2;
  const baseRelPct = pooledMag > 1e-12 ? (Math.abs(e0) / pooledMag) * 100 : 0;

  const baseEffect = {
    absolute: e0,
    relativePct: baseRelPct,
    meanA: sumA / cntA,
    meanB: sumB / cntB,
    direction: e0 > 0 ? 'A>B' : e0 < 0 ? 'B>A' : 'none',
  };

  // No meaningful gap to test.
  if (pooledMag <= 1e-12 || baseRelPct < ZERO_EFFECT_REL * 100) {
    return {
      applicable: true,
      severity: 'no-effect',
      reason: `The gap between "${groupA}" and "${groupB}" is effectively zero (${baseRelPct.toFixed(1)}% of the typical value), so there is no finding to overturn.`,
      metricColumn: metricCol,
      groupColumn: groupCol,
      groupA, groupB,
      baseEffect,
      minRowsToBreak: null,
      fractionToBreak: null,
      breakMode: 'stable',
      segment: null,
      totalRows,
      summary: `No real difference between "${groupA}" and "${groupB}" to stress-test (${baseRelPct.toFixed(1)}% gap).`,
    };
  }

  const isBroken = (e) => (Math.sign(e) !== Math.sign(e0)) || (Math.abs(e) <= DISAPPEAR_FRAC * Math.abs(e0));
  let broke = false;
  let breakMode = 'stable';

  // Greedy leave-most-out: at each step remove the single still-present row that
  // pulls |effect| closest to zero, without emptying either group. Stop as soon
  // as the gap breaks, or when neither group can shed another row.
  while (cntA > 1 || cntB > 1) {
    let best = null;
    let bestAbs = Infinity;
    for (const p of state) {
      if (p.gone) continue;
      let eCand;
      if (p.group === groupA) {
        if (cntA <= 1) continue;
        eCand = (sumA - p.v) / (cntA - 1) - meanBFixed();
      } else {
        if (cntB <= 1) continue;
        eCand = sumA / cntA - (sumB - p.v) / (cntB - 1);
      }
      const a = Math.abs(eCand);
      if (a < bestAbs) { bestAbs = a; best = p; }
    }
    if (!best) break;
    best.gone = true;
    removed.push(best);
    if (best.group === groupA) { sumA -= best.v; cntA--; } else { sumB -= best.v; cntB--; }
    const e = effect();
    if (isBroken(e)) {
      broke = true;
      breakMode = Math.sign(e) !== Math.sign(e0) && e !== 0 ? 'reverses' : 'disappears';
      break;
    }
  }

  const minRowsToBreak = broke ? removed.length : null;
  const fractionToBreak = broke ? removed.length / totalRows : null;

  // Do the breaking rows concentrate in one named segment? Look across every
  // column that is NOT the metric or the group column for a single value shared
  // by a strong majority of removed rows.
  let segment = null;
  if (broke && removed.length) {
    const otherCols = columns.filter((c) => c !== metricCol && c !== groupCol);
    let bestSeg = null;
    for (const c of otherCols) {
      const counts = new Map();
      for (const p of removed) {
        const val = p.row[c];
        counts.set(val, (counts.get(val) || 0) + 1);
      }
      for (const [val, n] of counts) {
        if (n >= Math.max(2, Math.ceil(removed.length * SEGMENT_COVERAGE))) {
          if (!bestSeg || n > bestSeg.count) bestSeg = { column: c, value: val, count: n };
        }
      }
    }
    if (bestSeg) {
      segment = { column: bestSeg.column, value: bestSeg.value, coverage: bestSeg.count / removed.length };
    }
  }

  let severity;
  if (!broke) severity = 'robust';
  else if (fractionToBreak <= FRAGILE_FRACTION) severity = 'fragile';
  else if (fractionToBreak <= MODERATE_FRACTION) severity = 'moderate';
  else severity = 'robust';

  const gapVerb = breakMode === 'reverses' ? 'reverses' : 'erases';
  const segClause = segment ? `, ${(segment.coverage * 100).toFixed(0)}% of them in ${segment.column} = "${segment.value}",` : '';
  let summary;
  if (!broke) {
    summary = `The ${baseRelPct.toFixed(1)}% gap between "${groupA}" and "${groupB}" survives dropping rows one at a time — no small set of rows overturns it.`;
  } else {
    summary = `Dropping ${minRowsToBreak} of ${totalRows} rows (${(fractionToBreak * 100).toFixed(1)}%)${segClause} ${gapVerb} the ${baseRelPct.toFixed(1)}% gap between "${groupA}" and "${groupB}".`;
  }

  return {
    applicable: true,
    severity,
    reason: summary,
    metricColumn: metricCol,
    groupColumn: groupCol,
    groupA, groupB,
    baseEffect,
    minRowsToBreak,
    fractionToBreak,
    breakMode,
    segment,
    totalRows,
    summary,
  };
}

// Locate a named check in an attackAnalysis report (case-insensitive substring).
function findCheck(attackReport, needle) {
  const checks = Array.isArray(attackReport?.checks) ? attackReport.checks : [];
  return checks.find((c) => String(c.name || '').toLowerCase().includes(needle)) || null;
}

/**
 * Fold the Devil's Advocate stress-test and the assumption-sensitivity map into
 * ONE fixed-vocabulary verdict with a plain-English, number-grounded reason.
 *
 * @param {object} attackReport      Output of attackAnalysis (may be null).
 * @param {object} sensitivityReport Output of mapAssumptionSensitivity (may be null).
 * @returns {{verdict:'robust'|'fragile'|'inconclusive', reason:string, drivingFactor:(string|null)}}
 */
export function robustnessVerdict(attackReport, sensitivityReport) {
  const attack = attackReport || null;
  const sens = sensitivityReport || null;

  // The overall mean had nothing to test (no rows / no numeric column).
  const attackInconclusive = attack && attack.robust === false && Array.isArray(attack.checks)
    && attack.checks.length === 1
    && /no data|no numeric/i.test(attack.checks[0]?.name || attack.checks[0]?.detail || '');
  if (attackInconclusive || (attack && attack.verdict === 'inconclusive')) {
    const why = attack.checks && attack.checks[0] ? attack.checks[0].detail : 'there was nothing to stress-test.';
    return { verdict: 'inconclusive', reason: why, drivingFactor: null };
  }

  // The between-group gap is effectively zero — honest "nothing to overturn".
  if (sens && sens.severity === 'no-effect') {
    return {
      verdict: 'inconclusive',
      reason: sens.reason,
      drivingFactor: null,
    };
  }

  const attackRobust = attack ? attack.robust === true : null;
  const failing = attack && Array.isArray(attack.checks) ? attack.checks.filter((c) => !c.robust) : [];
  const failingNames = failing.map((c) => c.name);

  // When the sensitivity map couldn't run (e.g. no grouping column), fall back
  // to the attack report alone — still grounded in its real numbers.
  if (!sens || sens.applicable === false) {
    if (attackRobust === true) {
      const boot = findCheck(attack, 'bootstrap');
      const ci = boot && boot.stats ? ` (bootstrap 95% CI ±${(boot.stats.relWidth * 50).toFixed(1)}% of the estimate)` : '';
      const val = attack.headline ? attack.headline.value.toFixed(2) : 'the estimate';
      return {
        verdict: 'robust',
        reason: `The headline (${attack.headline ? `mean of "${attack.headline.column}" = ${val}` : val}) held up under resampling, outlier trimming and subgroup removal${ci} — no single stress-test moved it materially.`,
        drivingFactor: null,
      };
    }
    if (attackRobust === false) {
      const first = failing[0];
      return {
        verdict: 'fragile',
        reason: first ? first.detail : `The finding failed ${failingNames.join(', ')}.`,
        drivingFactor: first ? first.name : (failingNames[0] || null),
      };
    }
    return { verdict: 'inconclusive', reason: 'No stress-test results were available to judge robustness.', drivingFactor: null };
  }

  // Both signals available. Fragile if EITHER the overall mean failed a stress
  // test OR a small set of rows can break the between-group gap.
  const sensFragile = sens.severity === 'fragile';
  const isFragile = attackRobust === false || sensFragile;

  if (isFragile) {
    // Prefer the sensitivity story when it names a concrete segment/row set —
    // it is the more actionable, plainer explanation.
    if (sens.applicable && sens.breakMode !== 'stable' && (sensFragile || attackRobust === false)) {
      const seg = sens.segment;
      const driving = seg ? `${seg.column} = "${seg.value}"` : (failingNames[0] || null);
      return {
        verdict: 'fragile',
        reason: sens.summary,
        drivingFactor: driving,
      };
    }
    const first = failing[0];
    return {
      verdict: 'fragile',
      reason: first ? first.detail : `The finding failed ${failingNames.join(', ')}.`,
      drivingFactor: first ? first.name : (sens.segment ? `${sens.segment.column} = "${sens.segment.value}"` : null),
    };
  }

  // Robust: the mean survived every stress-test AND no small set of rows breaks
  // the gap. Say so plainly, with the real numbers behind the confidence.
  const boot = findCheck(attack, 'bootstrap');
  const ci = boot && boot.stats ? `resampling held the mean within ±${(boot.stats.relWidth * 50).toFixed(1)}% of the estimate` : 'resampling held the mean steady';
  const need = sens.minRowsToBreak != null
    ? `it took removing ${(sens.fractionToBreak * 100).toFixed(0)}% of rows to overturn`
    : 'no small set of rows overturns it';
  return {
    verdict: 'robust',
    reason: `The ${sens.baseEffect.relativePct.toFixed(1)}% gap between "${sens.groupA}" and "${sens.groupB}" holds up: ${ci}, and ${need}.`,
    drivingFactor: null,
  };
}
