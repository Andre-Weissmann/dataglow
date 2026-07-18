// ============================================================
// DATAGLOW — Healthcare Rulepack v1.0 (Phase 4)
// ============================================================
// The authoritative rulepack for healthcare datasets: claims, EHR,
// EMS, quality reporting, and administrative data.
//
// All thresholds are traceable to published regulatory or clinical
// standards. The source reference is included on every threshold.
//
// RULEPACK CONTRACT:
// Every rulepack must export a default object conforming to the
// RulepackSchema (see rulepack-registry.js). Fields that are
// optional in the schema but present here are healthcare-specific
// enrichments. The registry validates the shape on load.

export default {
  // ---- Identity ----
  id: 'healthcare',
  version: '1.0.0',
  label: 'Healthcare (CMS / NCHS)',
  description: 'Rulepack for healthcare datasets: claims, EHR, EMS, quality reporting. ' +
    'Thresholds aligned with CMS Disparities Impact Statement, HEDIS, NCHS small-cell ' +
    'suppression, and AHRQ quality measure standards.',
  domain: 'healthcare',
  publishedAt: '2026-07-18',

  // ---- Freshness Decay ----
  // How quickly a dataset's trust score degrades over time.
  // Reference: CMS timely-data requirements; HIPAA minimum necessary standard.
  freshness: {
    // Days after which the dataset is considered "stale" (score starts decaying).
    staleAfterDays: 90,
    // Days after which the dataset is considered "expired" (score floor reached).
    expiredAfterDays: 365,
    // The multiplier applied to the overall trust score at expiry.
    // 0.5 = the score is halved at expiry.
    decayFloor: 0.50,
    // Decay shape: 'linear' | 'exponential'
    decayShape: 'linear',
    // Human-readable rationale shown in the Trust Certificate.
    rationale: 'Healthcare data older than 90 days may no longer reflect current patient ' +
      'population or coding practices. Data older than 365 days is considered expired for ' +
      'quality reporting purposes (CMS timely data standards).',
  },

  // ---- Equity Disparity Thresholds ----
  // Reference: CMS Disparities Impact Statement (2023); HEDIS disparity measurement.
  equity: {
    // Binary outcome thresholds (readmit, denial, mortality flags).
    binary: {
      rateRatioWarn: 1.25,   // 25% above reference -> warn
      rateRatioFail: 1.50,   // 50% above reference -> fail (CMS DIS threshold)
      absDiffWarn:   0.03,   // 3 percentage points -> warn
      absDiffFail:   0.05,   // 5 percentage points -> fail (CMS DIS threshold)
    },
    // Continuous outcome thresholds (LOS, cost, quality score).
    continuous: {
      smdWarn: 0.10,   // 10% relative deviation -> warn
      smdFail: 0.20,   // 20% relative deviation -> fail
    },
    // Small-cell suppression minimum.
    minCellSize: 5,    // NCHS/CMS standard
    // Max distinct groups before stratification is skipped.
    maxGroups: 50,
    // Row sample limit for large tables.
    rowSampleLimit: 50000,
    // Methodology attribution shown in attestation.
    methodologyAttribution: 'CMS Disparities Impact Statement (2023); HEDIS disparity measurement guidance; NCHS small-cell suppression standard.',
  },

  // ---- FK / Orphan Thresholds ----
  // Reference: DataGlow standard (Phase 2 defaults, healthcare-appropriate).
  foreignKey: {
    warnRate: 0.001,   // 0.1% orphan rate -> warn
    failRate: 0.01,    // 1.0% orphan rate -> fail
  },

  // ---- Temporal Order Rules ----
  // Reference: clinical logic standards.
  temporalOrder: {
    // Hard rules: any violation is a fail.
    hardRules: [
      'admit_before_discharge',
      'order_before_result',
      'claim_before_payment',
      'birth_before_death',
    ],
    // Soft rules: use warnRate/failRate thresholds.
    softRules: [
      'service_before_auth',
    ],
    warnRate: 0.001,
    failRate: 0.01,
  },

  // ---- Join Coverage Thresholds ----
  joinCoverage: {
    passRate:   0.99,   // >= 99% -> pass
    warnRate:   0.95,   // 95-99% -> warn
    failRate:   0.75,   // < 75%  -> high fail (< 95% is medium fail)
  },

  // ---- k-Anonymity ----
  // Reference: NCHS/CMS standard for small-cell suppression.
  kAnonymity: {
    kFloor: 5,   // groups with n < 5 are suppressed
  },

  // ---- Domain Physics Overrides ----
  // Column-level semantic rules specific to healthcare.
  // These extend (not replace) the base Domain Physics Engine rules.
  domainPhysics: {
    // Age bounds for healthcare: 0–130 (older than 130 is implausible).
    ageBounds: { min: 0, max: 130 },
    // LOS bounds: 0–730 days (longer is implausible for inpatient).
    losBounds: { min: 0, max: 730 },
    // Claim amounts: negative values are always wrong.
    claimAmountMin: 0,
  },

  // ---- Rulepack Metadata ----
  // Changelog for version diffing (Phase 4 dataset-differ uses this).
  changelog: [
    { version: '1.0.0', date: '2026-07-18', notes: 'Initial healthcare rulepack — Phase 4 baseline.' },
  ],
};
