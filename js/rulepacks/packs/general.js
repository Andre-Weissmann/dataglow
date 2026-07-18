// ============================================================
// DATAGLOW — General Rulepack v1.0 (Phase 4)
// ============================================================
// Domain-agnostic rulepack for non-healthcare datasets.
// Works for finance, retail, Lego, Star Wars, real estate — anything
// that isn't governed by healthcare-specific regulations.
//
// Thresholds are statistically reasonable defaults, not regulatory
// mandates. The methodology note in the attestation reflects this:
// it says "statistical disparity analysis" rather than "CMS DIS."
//
// WHY THIS EXISTS:
// Phase 3 detected disparities correctly on any domain but labeled the
// methodology as "CMS Disparities Impact Statement" — which is wrong for
// a Lego price dataset. This rulepack gives non-healthcare data honest
// labels and slightly looser thresholds (since the stakes are different).

export default {
  // ---- Identity ----
  id: 'general',
  version: '1.0.0',
  label: 'General (Domain-Agnostic)',
  description: 'Domain-agnostic rulepack for non-healthcare datasets. ' +
    'Thresholds are statistically reasonable defaults. No regulatory attribution.',
  domain: 'general',
  publishedAt: '2026-07-18',

  // ---- Freshness Decay ----
  // More lenient than healthcare — non-clinical data doesn't expire as fast.
  freshness: {
    staleAfterDays: 180,
    expiredAfterDays: 730,   // 2 years
    decayFloor: 0.60,
    decayShape: 'linear',
    rationale: 'Non-healthcare data older than 180 days may no longer reflect current ' +
      'patterns. Data older than 730 days is considered stale for analytical purposes.',
  },

  // ---- Equity / Group Disparity Thresholds ----
  // More lenient than CMS — no regulatory mandate, just statistical reasonableness.
  equity: {
    binary: {
      rateRatioWarn: 1.50,   // 50% above reference -> warn (looser than CMS)
      rateRatioFail: 2.00,   // 2x above reference -> fail
      absDiffWarn:   0.05,   // 5 pp -> warn
      absDiffFail:   0.10,   // 10 pp -> fail
    },
    continuous: {
      smdWarn: 0.15,   // 15% relative deviation -> warn
      smdFail: 0.30,   // 30% relative deviation -> fail
    },
    minCellSize: 5,
    maxGroups: 50,
    rowSampleLimit: 50000,
    methodologyAttribution: 'Statistical disparity analysis (domain-agnostic defaults). No regulatory standard applies.',
  },

  // ---- FK / Orphan Thresholds ----
  foreignKey: {
    warnRate: 0.005,   // 0.5% -> warn (looser)
    failRate: 0.02,    // 2.0% -> fail
  },

  // ---- Temporal Order Rules ----
  temporalOrder: {
    hardRules: [
      'birth_before_death',
    ],
    softRules: [
      'admit_before_discharge',
      'order_before_result',
      'claim_before_payment',
      'service_before_auth',
    ],
    warnRate: 0.005,
    failRate: 0.02,
  },

  // ---- Join Coverage Thresholds ----
  joinCoverage: {
    passRate: 0.97,
    warnRate: 0.90,
    failRate: 0.70,
  },

  // ---- k-Anonymity ----
  kAnonymity: {
    kFloor: 5,
  },

  // ---- Domain Physics Overrides ----
  domainPhysics: {
    // No domain-specific physics bounds for general datasets.
    // The Domain Physics Engine will operate in domain-agnostic mode.
  },

  // ---- Rulepack Metadata ----
  changelog: [
    { version: '1.0.0', date: '2026-07-18', notes: 'Initial general rulepack — Phase 4 baseline.' },
  ],
};
