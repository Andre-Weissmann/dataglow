// ============================================================
// DATAGLOW — Confidence-Calibrated Grades (two-axis)
// ============================================================
// Replaces the single letter grade with two honest, HEURISTIC axes derived
// entirely from data the 18 layers + Domain Physics Engine already produced.
// No new statistical layer is introduced here.
//
//   Data Integrity (A–F)
//     Are values internally consistent? Pass-rate across the objective,
//     domain-agnostic correctness layers — uniqueness / duplicates,
//     cross-column & referential consistency, and format/label validity.
//
//   Domain Plausibility Confidence (A–F)
//     How confident is DATAGLOW that its own flags are REAL problems rather
//     than domain quirks it doesn't fully understand? A flag the Domain
//     Physics Engine reinterpreted/downgraded raises this (the tool
//     "understood" the context); an unreviewed flag lowers it.
//
// Both are explicitly heuristics, not legal or clinical determinations.

// A–F banding, matching the CDC-framework banding used by the CAT scorecard.
function band(score) {
  if (score >= 0.9) return 'A';
  if (score >= 0.8) return 'B';
  if (score >= 0.7) return 'C';
  if (score >= 0.6) return 'D';
  return 'F';
}

function statusScore(status) {
  if (status === 'pass') return 1;
  if (status === 'warn') return 0.5;
  if (status === 'fail') return 0;
  return null; // idle / not-run — excluded
}

// Objective, domain-agnostic correctness layers.
const INTEGRITY_LAYERS = ['unit_tests', 'cross_column_logic', 'semantic_drift', 'sanity_anchor'];

// Layers that raise interpretable data-quality concerns (a warn/fail here is a
// "flag" the Domain Physics Engine may or may not have reinterpreted).
const CONCERN_LAYERS = [
  'unit_tests', 'semantic_drift', 'cross_column_logic', 'outlier_detection',
  'categorical_consistency', 'benford', 'distribution_drift', 'correlation_watchdog',
];

export function computeCalibratedGrades({ results = {}, packName = 'none', packLabel = null, annotations = [] } = {}) {
  // ---- Data Integrity axis ----
  let sum = 0, n = 0;
  const integrityDetail = [];
  for (const id of INTEGRITY_LAYERS) {
    const r = results[id];
    const sc = r ? statusScore(r.status) : null;
    if (sc == null) continue;
    sum += sc; n++;
    integrityDetail.push({ layer: id, status: r.status });
  }
  const integrityScore = n ? sum / n : 1;

  // ---- Domain Plausibility Confidence axis ----
  let concerns = 0;
  for (const id of CONCERN_LAYERS) {
    const r = results[id];
    if (r && (r.status === 'warn' || r.status === 'fail')) concerns++;
  }
  const interpreted = Math.min(concerns, annotations.length);
  // No concerns → nothing ambiguous to be unsure about (full confidence).
  // Otherwise a C floor rising to A as more flags are contextualised.
  const plausibilityScore = concerns === 0 ? 1 : 0.7 + 0.3 * (interpreted / concerns);

  const packName_ = packName || 'none';
  const packText = packLabel || packName_;

  return {
    packName: packName_,
    integrity: {
      score: Number(integrityScore.toFixed(3)),
      grade: band(integrityScore),
      passed: n ? Math.round(sum) : 0,
      considered: n,
      explanation: `Heuristic: ${n ? `${integrityDetail.filter(d => d.status === 'pass').length} of ${n}` : 'no'} internal-consistency checks passed (duplicates, impossible cross-column combinations, format/label validity). Not a legal or clinical determination.`,
    },
    plausibility: {
      score: Number(plausibilityScore.toFixed(3)),
      grade: band(plausibilityScore),
      interpreted,
      concerns,
      explanation: concerns === 0
        ? 'Heuristic: no flags were raised, so there is nothing ambiguous to interpret — high confidence the clean result is real.'
        : `Heuristic: the "${packText}" domain pack reinterpreted ${interpreted} of ${concerns} raised flag(s) in context; higher means more flags were understood as domain behaviour rather than left as raw anomalies.`,
    },
  };
}
