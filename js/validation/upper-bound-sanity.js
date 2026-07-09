// ============================================================
// DATAGLOW — Upper-Bound Sanity Anchor (definitional-bounds validation)
// ============================================================
// A sibling of the Physiological Plausibility layer (js/physiological-plausibility.js).
// Where that layer anchors on hard BIOLOGICAL limits (a heart rate can't exceed
// ~300 bpm), this one anchors on hard LOGICAL / MATHEMATICAL limits: quantities
// that are bounded BY DEFINITION regardless of what the rest of the column looks
// like. A percentage of 500 is impossible not because it's a statistical outlier
// (other large numbers may exist in the column) but because a percentage cannot,
// by definition, exceed 100 — it's almost certainly a decimal-point slip (5.00%),
// a unit mix-up, or a data-entry typo. Pure statistics miss this when many rows
// share the same error or when the column legitimately contains large numbers.
//
// SCOPE — deliberately NARROW and well-defined. Two families of bounded-by-
// definition quantities, detected via robust column-name word-splitting:
//   1. Percentages       → 0–100   (name: percent / pct / percentage, or a
//                                    clearly percentage-framed "…_rate")
//   2. Proportions /
//      probabilities     → 0–1     (name: proportion / probability / prob,
//                                    or a "…_ratio" whose values are clearly 0–1)
// Negative values are flagged for BOTH families (all of these quantities are
// non-negative by definition).
//
// NON-GOALS / conservative false-positive avoidance (see decideBound):
//   * Vital-sign columns (heart_rate, resp_rate, spo2, …) are OWNED by the
//     Physiological Plausibility layer and are explicitly excluded here via its
//     matchVital() — this layer never re-implements or duplicates those checks.
//   * "rate" and "ratio" are ambiguous. "flow_rate" is a per-unit rate that is
//     legitimately unbounded; a "pe_ratio" (price/earnings) is legitimately
//     unbounded. For these we DO NOT apply a bound from the name alone — we fall
//     back to the observed value distribution and only apply a bound when the
//     values are actually consistent with a bounded quantity, otherwise we SKIP
//     the column rather than risk a false flag.
//   * Percentages that can legitimately exceed 100 (growth %, change %, ROI,
//     margin, return, …) are excluded outright — see UNBOUNDED_QUALIFIERS.
//
// Column detection reuses the robust word-splitting tokenizer from the
// Cross-Column layer so compound names ("success_rate", "completionPct",
// "prob-win") all match — naive regex `\b` boundaries fail on snake_case.
//
// "Percentages are 0–100, proportions are 0–1" is basic mathematics, implemented
// here from first principles. Everything runs client-side against the already-
// loaded DuckDB-WASM table (no new backend calls).
// ============================================================

import { nameTokens } from './cross-column-consistency.js';
import { matchVital } from './physiological-plausibility.js';

const NUMERIC_T = ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'];

// User-facing note surfaced wherever these results appear — explains what the
// layer does and, importantly, that it deliberately skips ambiguous/unbounded
// columns rather than guess.
export const UPPER_BOUND_NOTE =
  'This check flags values that break a column\'s LOGICAL bounds — a percentage ' +
  'above 100 or below 0, or a proportion/probability outside 0–1. These are ' +
  'impossible by definition (unlike a mere statistical outlier) and usually ' +
  'indicate a decimal-point slip, unit mix-up, or data-entry typo. To avoid ' +
  'false positives it is conservative: vital-sign columns are left to the ' +
  'Physiological Plausibility layer, and ambiguous "rate"/"ratio" columns whose ' +
  'values look genuinely unbounded (e.g. a flow rate or a price/earnings ratio) ' +
  'are skipped rather than flagged.';

// Distribution-share thresholds used to decide whether an ambiguous column is
// actually a bounded quantity, and which framing (0–1 vs 0–100) it uses.
// PROPORTION_SHARE_MIN — at least this fraction of non-null values in [0,1] to
//   read the column as a 0–1 proportion.
// MID_SHARE_MAX — but no more than this fraction in (1,100]; a genuine 0–100
//   percentage with many small values would still have a real presence between
//   1 and 100, which distinguishes it from a true 0–1 proportion.
// WITHIN_100_SHARE_MIN — fraction of values in [0,100] required to read an
//   ambiguous/candidate column as a 0–100 percentage.
const PROPORTION_SHARE_MIN = 0.8;
const MID_SHARE_MAX = 0.1;
const WITHIN_100_SHARE_MIN = 0.9;

// Explicit name signals.
const PCT_CODES = ['pct'];               // exact token
const PCT_STEMS = ['percent'];           // percent / percentage
const PROP_STEMS = ['proportion', 'probab']; // proportion / probability / probabilities
const PROP_CODES = ['prob'];             // exact token (prob_win)

// "rate" alone is ambiguous; combined with one of these it reads as a
// percentage-framed success/hit/… rate. Kept conservative — even then the value
// distribution must confirm a bounded framing before a bound is applied.
const PERCENT_RATE_QUALIFIERS = new Set([
  'success', 'completion', 'complete', 'pass', 'fail', 'failure', 'conversion',
  'response', 'retention', 'adoption', 'utilization', 'utilisation', 'occupancy',
  'win', 'click', 'clickthrough', 'ctr', 'attendance', 'approval', 'denial',
  'accuracy', 'participation', 'turnout', 'engagement', 'bounce', 'completion',
]);

// Names where a "percentage"/"rate"/"ratio" can legitimately exceed 100 (or be
// negative) — treating these as bounded would produce false positives, so they
// are excluded outright.
const UNBOUNDED_QUALIFIERS = new Set([
  'growth', 'change', 'increase', 'decrease', 'delta', 'return', 'returns', 'roi',
  'yoy', 'mom', 'wow', 'qoq', 'markup', 'margin', 'gain', 'yield', 'variance',
  'deviation', 'profit', 'multiplier', 'leverage', 'gross', 'net',
]);

// ------------------------------------------------------------
// Pure name-based classification. Returns a descriptor describing the CANDIDATE
// bounded family, or null if the name gives no bounded signal. The final
// decision (which bound, or skip) is made by decideBound() using the observed
// value distribution — this function only reads the name.
//
//   category: 'percentage' — explicit percent/pct name (definitionally 0–100)
//   category: 'proportion' — explicit proportion/probability name (0–1)
//   category: 'rate_like'  — "…_rate" with a percentage-framing qualifier
//   category: 'ambiguous'  — bare "rate"/"ratio": bounded ONLY if values agree
// ------------------------------------------------------------
export function matchBoundedType(name) {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return null;

  // Physiological Plausibility owns vital-sign columns — never double-check them.
  if (matchVital(name)) return null;

  // Legitimately-unbounded quantities (growth %, ROI, margin, …) are excluded.
  if (tokens.some(t => UNBOUNDED_QUALIFIERS.has(t))) return null;

  const has = (codes, stems) =>
    tokens.some(t => codes.includes(t)) ||
    (stems && tokens.some(t => stems.some(s => t.startsWith(s))));

  const hasPct = has(PCT_CODES, PCT_STEMS);
  const hasProp = has(PROP_CODES, PROP_STEMS);
  const hasRate = tokens.includes('rate');
  const hasRatio = tokens.includes('ratio');
  const hasPctQualifier = tokens.some(t => PERCENT_RATE_QUALIFIERS.has(t));

  if (hasPct) return { category: 'percentage', word: 'percentage' };
  if (hasProp) {
    const word = tokens.some(t => t.startsWith('probab') || t === 'prob') ? 'probability' : 'proportion';
    return { category: 'proportion', word };
  }
  if (hasRate && hasPctQualifier) return { category: 'rate_like', word: 'percentage' };
  if (hasRate || hasRatio) return { category: 'ambiguous', word: hasRatio ? 'ratio' : 'rate' };
  return null;
}

// Distribution summary shape (all counts over NON-NULL values):
//   { n, in01, in0100, min, max }
// in01   = count of values with 0 <= v <= 1
// in0100 = count of values with 0 <= v <= 100
function proportionFramed(dist) {
  if (!dist.n) return false;
  const share01 = dist.in01 / dist.n;
  const midShare = (dist.in0100 - dist.in01) / dist.n; // values in (1,100]
  return share01 >= PROPORTION_SHARE_MIN && midShare <= MID_SHARE_MAX;
}

function percentFramed(dist) {
  if (!dist.n) return false;
  return dist.in0100 / dist.n >= WITHIN_100_SHARE_MIN;
}

// ------------------------------------------------------------
// Decide the logical bound for a classified column given its value distribution,
// or return null to conservatively SKIP the column. Pure (no I/O) so the
// conservative-skip logic is unit-testable without a database.
//
// Returns { low, high, label, unit } — low is always 0 (all these quantities are
// non-negative by definition); unit is '%' for percentages, '' for proportions.
// ------------------------------------------------------------
export function decideBound(descriptor, dist) {
  if (!descriptor || !dist || !dist.n) return null;
  const PCT = { low: 0, high: 100, label: 'percentage', unit: '%' };
  const propBound = (label) => ({ low: 0, high: 1, label, unit: '' });

  switch (descriptor.category) {
    case 'percentage':
      // Explicit percent/pct name — definitionally bounded. Pick the framing
      // (fraction 0–1 vs 0–100) from the values; default to 0–100.
      return proportionFramed(dist) ? propBound('proportion') : PCT;

    case 'proportion':
      // Explicit proportion/probability — conventionally 0–1, but tolerate a
      // column that happens to be stored as a 0–100 percentage. If the values
      // fit neither framing, skip rather than guess.
      if (proportionFramed(dist)) return propBound(descriptor.word || 'proportion');
      if (percentFramed(dist)) return PCT;
      return null;

    case 'rate_like':
      // "…_rate" with a percentage qualifier — apply a bound only if the values
      // actually look bounded (guards against per-1000 / per-capita rates).
      if (proportionFramed(dist)) return propBound('proportion');
      if (percentFramed(dist)) return PCT;
      return null;

    case 'ambiguous':
      // Bare "rate"/"ratio" — apply ONLY the 0–1 bound, and ONLY when the values
      // are clearly proportion-framed. A genuinely unbounded ratio (P/E ratio,
      // flow rate, …) fails this test and is skipped, never flagged.
      return proportionFramed(dist) ? propBound('ratio') : null;

    default:
      return null;
  }
}

const fmt = (v) => {
  if (v == null || Number.isNaN(v)) return String(v);
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
};
const withUnit = (v, unit) => (unit === '%' ? `${fmt(v)}%` : unit ? `${fmt(v)} ${unit}` : fmt(v));

function boundFinding({ column, bound, below, above, maxOver, minUnder }) {
  const count = below + above;
  const range = `${withUnit(bound.low, bound.unit)}–${withUnit(bound.high, bound.unit)}`;
  const parts = [];
  const ex = [];
  if (above > 0) {
    parts.push(`${above} above the logical maximum of ${withUnit(bound.high, bound.unit)}`);
    ex.push(`a value of ${withUnit(maxOver, bound.unit)} exceeds the logical maximum of ${withUnit(bound.high, bound.unit)} for a ${bound.label} column`);
  }
  if (below > 0) {
    parts.push(`${below} below the logical minimum of ${withUnit(bound.low, bound.unit)}`);
    ex.push(`a value of ${withUnit(minUnder, bound.unit)} is below the logical minimum of ${withUnit(bound.low, bound.unit)} (a ${bound.label} cannot be negative)`);
  }
  return {
    column,
    category: bound.label,
    low: bound.low, high: bound.high, unit: bound.unit || null,
    below, above, count,
    text: `${count} value(s) in "${column}" fall outside the logical ${bound.label} range of ${range}.`,
    explanation: `A ${bound.label} is bounded by definition to ${range} (${parts.join(', ')}). For example, ${ex.join('; and ')} — impossible by definition and most likely a decimal-point slip, unit mix-up, or data-entry typo rather than a real value.`,
  };
}

// ------------------------------------------------------------
// Runner — executes the bounds checks against the loaded table and returns
// { findings, matched }. Pure of side effects (no ledger writes): the caller
// decides how to log, mirroring the Physiological Plausibility and Cross-Column
// layers.
//
// Each finding: { column, category, low, high, below, above, count, text, explanation }
//   text        — concise one-liner (used for the layer's `detail` list)
//   explanation — plain-language "why this is impossible by definition"
// ------------------------------------------------------------
export async function runUpperBoundChecks(table, cols, engine) {
  const findings = [];
  const matched = [];
  const numeric = cols.filter(c => NUMERIC_T.includes(c.type));

  const one = async (sql) => {
    const { rows } = await engine.runQuery(sql);
    return rows[0] || {};
  };

  for (const c of numeric) {
    const desc = matchBoundedType(c.name);
    if (!desc) continue;
    const col = `"${c.name}"`;

    // First pass: distribution summary used to pick a framing (or skip).
    const d = await one(`
      SELECT COUNT(${col}) AS n,
             COUNT(*) FILTER (WHERE ${col} >= 0 AND ${col} <= 1)   AS in01,
             COUNT(*) FILTER (WHERE ${col} >= 0 AND ${col} <= 100) AS in0100,
             MIN(${col}) AS mn, MAX(${col}) AS mx
      FROM ${table} WHERE ${col} IS NOT NULL`);
    const dist = {
      n: Number(d.n) || 0,
      in01: Number(d.in01) || 0,
      in0100: Number(d.in0100) || 0,
      min: d.mn != null ? Number(d.mn) : null,
      max: d.mx != null ? Number(d.mx) : null,
    };

    const bound = decideBound(desc, dist);
    if (!bound) continue; // conservative skip — ambiguous/unbounded column

    matched.push({ column: c.name, category: bound.label, low: bound.low, high: bound.high });

    // Second pass: count and sample the out-of-bound values.
    const r = await one(`
      SELECT COUNT(*) FILTER (WHERE ${col} < ${bound.low}) AS below,
             COUNT(*) FILTER (WHERE ${col} > ${bound.high}) AS above,
             MAX(${col}) FILTER (WHERE ${col} > ${bound.high}) AS maxover,
             MIN(${col}) FILTER (WHERE ${col} < ${bound.low}) AS minunder
      FROM ${table} WHERE ${col} IS NOT NULL`);
    const below = Number(r.below) || 0;
    const above = Number(r.above) || 0;
    if (below + above === 0) continue;

    findings.push(boundFinding({
      column: c.name, bound, below, above,
      maxOver: r.maxover != null ? Number(r.maxover) : null,
      minUnder: r.minunder != null ? Number(r.minunder) : null,
    }));
  }

  return { findings, matched };
}
