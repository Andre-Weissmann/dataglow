// ============================================================
// DATAGLOW — Confidence-Calibrated Grades (two-axis)
// ============================================================
// Splits the old blended "data quality" signal into two honest, HEURISTIC axes
// derived ENTIRELY from data the existing validation layers + Domain Physics
// Engine already produced. No new statistical layer is introduced here — this
// module only aggregates and weights existing layer *statuses* into two
// composite grades. Both axes are explicitly heuristics, not legal/clinical
// determinations.
//
//   Data Integrity (A–F) — "is this data internally well-formed?"
//     Purely mechanical / statistical cleanliness, domain-agnostic. Are there
//     duplicates, blank keys, format/label inconsistencies, impossible
//     cross-column combinations, or internal calculation disagreements? This
//     can be HIGH on a dataset that is nonsense in the real world, as long as
//     it is mechanically consistent.
//
//   Domain Confidence (A–F) — "does this data make real-world sense?"
//     Context-aware plausibility that goes beyond mechanical validity. Draws on
//     the domain / subject-matter layers: Physiological Plausibility (Domain
//     Physics, layer 19), Distributional Fingerprint Drift (does this look like
//     previously-seen "normal" data for this domain), semantic drift, and the
//     naturalness / outlier checks. This axis can be LOW even when Integrity is
//     HIGH — e.g. a dataset with zero mechanical errors but where vital signs
//     are physiologically impossible, or the distribution no longer resembles
//     known-good data.
//
// Domain-pack reinterpretation credit: when the Domain Physics Engine
// reinterprets a raised flag in context (e.g. "future dates are de-identifica-
// tion date-shifting"), that flag is understood rather than unexplained, so it
// counts LESS against Domain Confidence. This preserves the original insight
// that a contextualised flag is less alarming than a raw one.

// ------------------------------------------------------------
// Layer → axis mapping (auditable & adjustable — see PR description).
//
// Each axis is a WEIGHTED pass-rate over the layers assigned to it. Weights are
// relative and re-normalised over only the layers that actually ran (idle /
// not-run layers are excluded, never counted as failures). A layer may appear
// in both maps if it legitimately speaks to both axes.
// ------------------------------------------------------------

// INTEGRITY — mechanical / statistical well-formedness (domain-agnostic).
//   unit_tests            negatives, future dates, blank keys, DUPLICATES, referential integrity
//   cross_column_logic    impossible combinations across columns (end-before-start, etc.)
//   categorical_consistency near-duplicate spellings / label validity
//   schema_fingerprint    format / schema stability (renamed / retyped columns)
//   sanity_anchor         two independent calculation paths agree
//   reproducibility       identical results across repeated runs (determinism)
const INTEGRITY_WEIGHTS = {
  unit_tests: 0.30,
  cross_column_logic: 0.25,
  categorical_consistency: 0.15,
  schema_fingerprint: 0.12,
  sanity_anchor: 0.10,
  reproducibility: 0.08,
};

// DOMAIN CONFIDENCE — real-world plausibility (subject-matter aware).
//   physiological_plausibility  headline domain check (layer 19): vital-sign physics
//   distribution_drift          does this look like previously-seen "normal" data
//   semantic_drift              do values actually match what the column claims to be
//   outlier_detection           are magnitudes realistic, not just non-negative
//   benford                     naturalness of numeric distributions
//   correlation_watchdog        do expected relationships still hold
const DOMAIN_WEIGHTS = {
  physiological_plausibility: 0.30,
  distribution_drift: 0.25,
  semantic_drift: 0.15,
  outlier_detection: 0.12,
  benford: 0.10,
  correlation_watchdog: 0.08,
};

// A warn/fail domain layer whose flag the Domain Physics Engine reinterpreted is
// treated as mostly-understood: its contribution is lifted to this credit floor
// rather than counting as a full domain-confidence hit.
const REINTERPRETED_CREDIT = 0.9;

// A–F banding, matching the CDC-framework banding used across DATAGLOW.
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
  return null; // idle / not-run — excluded from the average
}

// Weighted pass-rate over the runnable layers in `weights`. `perLayer` may
// override an individual layer's [0,1] score (used for reinterpretation credit).
// Returns { score, contributions[] } where score is 1 when nothing ran.
function weightedAxis(results, weights, perLayer = null) {
  let weighted = 0;
  let weightSum = 0;
  const contributions = [];
  for (const [id, weight] of Object.entries(weights)) {
    const r = results[id];
    const base = r ? statusScore(r.status) : null;
    if (base == null) continue; // idle / missing — excluded, not a failure
    const score = perLayer && perLayer[id] != null ? perLayer[id] : base;
    weighted += score * weight;
    weightSum += weight;
    contributions.push({
      layer: id,
      status: r.status,
      weight,
      score: Number(score.toFixed(3)),
      credited: Boolean(perLayer && perLayer[id] != null && perLayer[id] > base),
    });
  }
  return {
    score: weightSum ? weighted / weightSum : 1,
    contributions,
    considered: contributions.length,
  };
}

export function computeCalibratedGrades({ results = {}, packName = 'none', packLabel = null, annotations = [] } = {}) {
  const packName_ = packName || 'none';
  const packText = packLabel || packName_;

  // ---- Data Integrity axis ----
  const integrity = weightedAxis(results, INTEGRITY_WEIGHTS);
  const integrityPassed = integrity.contributions.filter(c => c.status === 'pass').length;

  // ---- Domain Confidence axis ----
  // Reinterpretation credit: a domain layer flagged warn/fail whose flag the
  // domain pack annotated is lifted toward REINTERPRETED_CREDIT (the tool
  // "understood" the context), so it counts less against Domain Confidence.
  const annotatedLayers = new Set((annotations || []).map(a => a && a.layer).filter(Boolean));
  const perLayerCredit = {};
  let concerns = 0;
  let interpreted = 0;
  for (const id of Object.keys(DOMAIN_WEIGHTS)) {
    const r = results[id];
    if (!r || (r.status !== 'warn' && r.status !== 'fail')) continue;
    concerns++;
    if (annotatedLayers.has(id)) {
      interpreted++;
      const base = statusScore(r.status);
      perLayerCredit[id] = Math.max(base, REINTERPRETED_CREDIT);
    }
  }
  const domain = weightedAxis(results, DOMAIN_WEIGHTS, perLayerCredit);

  // ---- Combined overall (single-glance signal, derived from both axes) ----
  const overallScore = (integrity.score + domain.score) / 2;

  const domainConcernText = concerns === 0
    ? 'Heuristic: the subject-matter layers (physiological plausibility, distributional drift, semantic drift, outliers, Benford, correlation) raised no concerns — the data looks plausible for its domain.'
    : `Heuristic: ${concerns} domain concern(s) raised by the subject-matter layers; the "${packText}" pack contextualised ${interpreted} of them (understood flags count less). Lower means the data looks less like plausible real-world data for its domain. Not a legal or clinical determination.`;

  return {
    packName: packName_,
    integrity: {
      score: Number(integrity.score.toFixed(3)),
      grade: band(integrity.score),
      passed: integrityPassed,
      considered: integrity.considered,
      layers: integrity.contributions,
      explanation: `Heuristic: how internally consistent and well-formed this data is — ${integrity.considered ? `${integrityPassed} of ${integrity.considered}` : 'no'} mechanical checks passed (duplicates, blank keys, impossible cross-column combinations, format/label validity, internal calculation agreement). Independent of whether the data makes real-world sense. Not a legal or clinical determination.`,
    },
    plausibility: {
      score: Number(domain.score.toFixed(3)),
      grade: band(domain.score),
      interpreted,
      concerns,
      considered: domain.considered,
      layers: domain.contributions,
      explanation: domainConcernText,
    },
    overall: {
      score: Number(overallScore.toFixed(3)),
      grade: band(overallScore),
      explanation: 'Heuristic: combined single-glance signal — the mean of Data Integrity and Domain Confidence. See the two component axes for the honest breakdown.',
    },
  };
}
