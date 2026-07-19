// ============================================================
// DATAGLOW — Teach-As-You-Clean Micro-Lesson Layer
// ============================================================
// An optional one-line "why this matters" micro-explanation for every kind of
// validation finding the app can surface. It teaches while you clean: each
// validation layer (and each domain-pack reinterpretation, and the finer
// sub-findings inside the Unit Test and Benford layers) carries a short,
// original explanation of what the check is really telling you.
//
// Two independent controls shape what a user sees, both held in in-memory app
// state only (no localStorage / sessionStorage / cookies — those are blocked in
// the sandboxed iframe and would break the zero-persistence contract):
//
//   1. "Learn while you clean" toggle — ON shows the explanations, OFF hides
//      every one of them and the results read exactly as they did before.
//   2. A three-level verbosity slider — Beginner / Practitioner / Expert —
//      that changes ONLY the wording register. It never changes which findings
//      appear, their severity, or any validation logic; it swaps one sentence
//      of copy for another written at a different level of assumed fluency.
//
// This module is pure logic (no DOM, no browser globals) so it runs identically
// in headless Node tests. main.js owns the toggle/slider wiring and rendering.
//
// All explanation copy here is original wording authored for DATAGLOW.

// The verbosity registers, ordered least → most technical. The slider maps its
// three positions onto these keys; each catalog entry supplies one sentence per
// register.
export const VERBOSITY_LEVELS = ['beginner', 'practitioner', 'expert'];

// The register used when none is chosen (and the fallback if an entry is ever
// missing a level). Practitioner is the neutral middle register.
export const DEFAULT_VERBOSITY = 'practitioner';

// The catalog: finding-type id → { beginner, practitioner, expert }.
//
// Keys come from three enumerable sources so the coverage test can assert every
// finding the app renders has a lesson:
//   - every validation layer id in validation.js LAYER_DEFS,
//   - every domain-pack rule id in domain-physics.js DOMAIN_PACKS,
//   - the finer sub-finding kinds the Unit Test and Benford layers render
//     individually (unit-test kinds and Benford skip causes).
export const MICRO_LESSONS = {
  // ---- Validation layers -------------------------------------------------
  sanity_anchor: {
    beginner: 'We total the same numbers two different ways; if the totals disagree, the query itself is probably wrong.',
    practitioner: 'Cross-checks one aggregate computed by two independent paths, so a silent query bug shows up as a mismatch.',
    expert: 'Dual-path aggregate reconciliation surfaces logically inconsistent or non-deterministic GROUP BY results.',
  },
  historical_drift: {
    beginner: 'If the same question quietly starts giving a different answer, we flag it so the change does not slip past you.',
    practitioner: 'Compares this run against the previous result for the same query to catch unexpected between-run changes.',
    expert: 'Detects run-over-run result deltas on a stable query, isolating upstream data churn or engine nondeterminism.',
  },
  unit_tests: {
    beginner: 'Quick automatic checks for the obvious mistakes — negative counts, blank IDs, future dates, and duplicate rows.',
    practitioner: 'Runs baseline integrity assertions (negatives, future dates, blank keys, duplicates, broken references) most clean data passes.',
    expert: 'Asserts row-level invariants — sign, temporal, key-nullity, uniqueness, referential integrity — before any downstream inference.',
  },
  confidence: {
    beginner: 'A single easy score that sums up, at a glance, how trustworthy the data looks overall.',
    practitioner: 'Aggregates several validation signals into one 0–100 confidence score and letter grade for triage.',
    expert: 'Composite heuristic scalar over weighted layer signals; a triage summary, not a correctness guarantee.',
  },
  denial_radar: {
    beginner: 'For medical billing data, it spots the patterns that often lead to a claim being denied.',
    practitioner: 'Scans EDI 835/837 claim fields for denial-prone patterns before the claim is submitted.',
    expert: 'Heuristic denial-risk pass over 835/837 remittance and claim fields; inert without the relevant EDI columns.',
  },
  schema_fingerprint: {
    beginner: 'Remembers your columns and warns you if any get renamed, dropped, or change type between loads.',
    practitioner: 'Hashes the schema so renamed, removed, or retyped columns are flagged on the next load of the same data.',
    expert: 'Content hash over the column name/type set detects schema mutation across loads.',
  },
  semantic_drift: {
    beginner: 'Checks that a column actually contains what its name promises it should.',
    practitioner: 'Flags columns whose values no longer match what the column name implies they hold.',
    expert: 'Name-versus-distribution mismatch detection catches mislabeled or silently repurposed columns.',
  },
  correlation_watchdog: {
    beginner: 'Watches two numbers that usually rise and fall together, and warns if they suddenly stop.',
    practitioner: 'Tracks key metric correlations across runs and flags a sudden decorrelation.',
    expert: 'Monitors pairwise correlation stability; a break signals a pipeline change or a shifted metric definition.',
  },
  narrative_consistency: {
    beginner: 'Makes sure the numbers written in your summary match the numbers the query actually returned.',
    practitioner: 'Cross-checks figures quoted in the written narrative against the underlying query output.',
    expert: 'Reconciles prose-embedded statistics with source results to catch stale, copied, or hand-edited numbers.',
  },
  freshness: {
    beginner: 'Shows how old your data is, so you do not draw conclusions from something stale.',
    practitioner: 'Stamps each load and warns when the dataset is older than your freshness threshold.',
    expert: 'Load-time recency badge evaluated against a configurable staleness bound.',
  },
  blind_spot: {
    beginner: 'Reminds you about data you might be missing that could change the conclusion entirely.',
    practitioner: 'Prompts about absent segments or dimensions whose omission could flip the headline finding.',
    expert: 'Surfaces coverage gaps whose absence could bias or invert the stated conclusion.',
  },
  reproducibility: {
    beginner: 'Runs your query several times over to confirm you get the exact same answer each time.',
    practitioner: 'Re-executes the query repeatedly to confirm deterministic, byte-identical results.',
    expert: 'Repeated-execution determinism check flags order-dependent or race-dependent results.',
  },
  outlier_detection: {
    beginner: 'Points out values that sit surprisingly far above or below the rest of the column.',
    practitioner: 'Flags both high and low numeric outliers using a modified z-score (MAD) and IQR fences.',
    expert: 'Robust dual-criterion outlier flags (MAD z-score plus Tukey fences) resist masking by the extremes themselves.',
  },
  benford: {
    beginner: 'For natural money-like numbers, it checks the leading digits follow a known pattern that manipulation tends to break.',
    practitioner: 'Compares leading-digit frequencies to the Benford expectation on the columns where the law actually applies.',
    expert: 'Newcomb-Benford first-digit conformance test, gated to multi-order-of-magnitude quantities.',
  },
  drg_icd_validation: {
    beginner: 'Checks that the billing codes on each claim actually match the diagnosis codes — mismatches are a common source of claim denials and audits.',
    practitioner: 'Validates DRG-to-ICD-10 code alignment per claim row: flags cases where the listed diagnosis codes are inconsistent with the assigned DRG, which triggers payer audits and payment reductions.',
    expert: 'Layer 15 DRG/ICD-10 coding-pair validator: cross-checks each claim row against a curated DRG → allowed ICD-10 chapter/code mapping, surfacing mismatches that indicate potential upcoding, downcoding, or data-entry errors with direct reimbursement risk.',
  },
  categorical_consistency: {
    beginner: 'Finds values that are really the same thing spelled differently and offers to merge them into one.',
    practitioner: 'Clusters near-identical category values and proposes a single canonical spelling to merge them into.',
    expert: 'Edit-distance / Jaro-Winkler clustering with abbreviation folding canonicalizes label variants.',
  },
  cross_column_logic: {
    beginner: 'Catches combinations that cannot both be true, like an end date that comes before its start date.',
    practitioner: 'Detects logically impossible cross-column combinations (end-before-start, discharge-before-admit, adult status on a minor).',
    expert: 'Inter-column constraint checks flag violations of temporal and domain-logical invariants.',
  },
  distribution_drift: {
    beginner: 'Remembers the shape of your numbers and tells you if a later upload of the same data looks different.',
    practitioner: "Stores each column's distribution shape and flags drift on a later load of the same schema.",
    expert: 'Per-column distributional fingerprint comparison detects covariate shift across loads.',
  },
  physiological_plausibility: {
    beginner: 'For health data, it flags vital-sign values that fall outside what is physically possible for a person.',
    practitioner: 'Flags vital-sign values outside general human physiological ranges — a data-plausibility check, not medical advice.',
    expert: 'Bounds vitals against population physiological limits; a plausibility heuristic, never a clinical determination.',
  },
  ncci_ptp_validation: {
    beginner: 'For medical billing data, it flags when two procedure codes billed for the same visit are ones Medicare says should not normally be billed together.',
    practitioner: "Flags same-patient/same-date CPT/HCPCS pairs that CMS's National Correct Coding Initiative (NCCI) names as a Procedure-to-Procedure conflict — a curated subset of documented edit pairs, not the full quarterly CMS edit file.",
    expert: 'NCCI PTP modifier-indicator-0 pair detection over same date-of-service claim lines; skips automatically when CPT/HCPCS or date-of-service columns are absent.',
  },
  upper_bound_sanity: {
    beginner: 'Catches values that break their own definition, like a percentage above 100 or a probability over 1.',
    practitioner: "Flags values outside a column's definitional bounds — percentages beyond 0–100, probabilities outside 0–1.",
    expert: 'Definitional range check anchored on mathematical limits, not dataset statistics; skips ambiguous unbounded rates.',
  },
  missingness_detective: {
    beginner: 'Looks at what is missing and tries to explain why, instead of just counting the blanks.',
    practitioner: "Classifies each column's missingness (MCAR / MAR / MNAR) and names a driver column when one explains the gaps.",
    expert: 'Rubin-taxonomy missingness classification with observed-driver search and a conservative MNAR hypothesis for core fields.',
  },
  red_team: {
    beginner: 'Runs every check against a deliberately broken sample to prove the checks actually catch problems.',
    practitioner: 'Runs all layers against an intentionally corrupted golden dataset to confirm each check still fires.',
    expert: 'Adversarial self-test over a known-bad fixture verifies each layer detects its target defect.',
  },

  // ---- Unit Test sub-findings -------------------------------------------
  negative: {
    beginner: 'A count or amount is below zero in a place where a negative number makes no sense.',
    practitioner: 'A value is negative in a column where negatives are not meaningful.',
    expert: 'Sign violation on a measure with a non-negative domain.',
  },
  future_date: {
    beginner: 'A date is set in the future when it really should not be.',
    practitioner: 'A date falls after the current time in a column where a future date is implausible.',
    expert: 'Temporal-bound violation — timestamp exceeds the run time.',
  },
  blank_key: {
    beginner: "A row is missing its ID, so there is no reliable way to tell it apart or link it.",
    practitioner: 'A key or identifier column contains blank or empty values.',
    expert: 'Null/empty in a presumed key column breaks join and uniqueness guarantees.',
  },
  duplicate: {
    beginner: 'The same row shows up more than once, which quietly inflates every total.',
    practitioner: 'Duplicate rows or repeated keys inflate counts and skew aggregates.',
    expert: 'Non-unique tuples or keys violate the expected multiplicity.',
  },
  null_ref: {
    beginner: 'A row points at something that does not exist in the table it should link to.',
    practitioner: 'A foreign key references a value with no matching parent record.',
    expert: 'Referential-integrity break — a dangling foreign key.',
  },

  // ---- Benford skip causes ----------------------------------------------
  bounded_name: {
    beginner: 'This column looks capped — like a percentage or a rating — so the leading-digit pattern does not apply.',
    practitioner: "The column name implies a bounded quantity, which Benford's Law does not govern.",
    expert: "Name-inferred bounded domain fails Benford's scale-invariance premise.",
  },
  small_sample: {
    beginner: 'There simply are not enough numbers here for the leading-digit check to mean anything.',
    practitioner: 'Too few values for a reliable leading-digit test.',
    expert: 'Sample size below the minimum for stable first-digit frequency estimates.',
  },
  narrow_range: {
    beginner: 'The numbers do not span enough different sizes for the pattern to be expected.',
    practitioner: "The value range is too narrow to satisfy Benford's multi-order-of-magnitude requirement.",
    expert: 'Insufficient order-of-magnitude spread invalidates Benford applicability.',
  },
  binary_flag: {
    beginner: 'This is a 0/1 flag, and the leading-digit pattern cannot describe a two-value column.',
    practitioner: "Binary 0/1 flag column, inherently exempt from Benford's Law.",
    expert: 'Two-point support column is Benford-ineligible by construction.',
  },

  // ---- Domain-pack reinterpretations (healthcare) -----------------------
  'deid-date-shift': {
    beginner: 'Health datasets often push dates far into the future to hide identities, so we read that as expected, not an error.',
    practitioner: 'Systematic far-future dates across most of a column are reinterpreted as de-identification date-shifting, not defects.',
    expert: 'Downgrades wholesale far-future date findings to a de-id shift (common in MIMIC / PhysioNet) while keeping sporadic future dates as failures.',
  },
  'protected-category-no-merge': {
    beginner: 'For sensitive categories like race or insurance, we never auto-combine similar-looking values — they may truly differ.',
    practitioner: 'Disables auto-merge on protected-category columns where textually similar values can be legally or clinically distinct.',
    expert: 'Suppresses categorical canonicalization on protected attributes to avoid conflating legally or clinically distinct classes.',
  },
  'binary-benford-exempt': {
    beginner: 'A column that only holds 0 or 1 cannot follow the leading-digit pattern, so we skip that check for it.',
    practitioner: 'Marks binary 0/1 flag columns as a deliberate, explained Benford exemption rather than a generic skip.',
    expert: 'Exempts binary indicators from Benford eligibility — single-magnitude support makes the law inapplicable.',
  },

  // ---- Domain-pack reinterpretations (retail) ---------------------------
  'retail-sku-no-merge': {
    beginner: 'Product codes that look alike (SKU-1001 vs SKU-1002) are different products, so we never merge them.',
    practitioner: 'Disables auto-merge on SKU / product-code columns where near-identical codes are distinct catalogue entries.',
    expert: 'Blocks canonicalization of SKU / UPC / ASIN identifiers to prevent collapsing distinct catalogue entries.',
  },
  'retail-return-flag-benford-exempt': {
    beginner: 'A yes/no return flag only holds 0 or 1, so the leading-digit check does not apply to it.',
    practitioner: 'Exempts binary return/refund flag columns from Benford eligibility.',
    expert: 'Binary return/chargeback indicators fail Benford support conditions and are flagged as an explained exemption.',
  },
  'retail-seasonal-outlier': {
    beginner: 'Big swings in price or sales are normal around promotions and holidays, so we explain them instead of alarming.',
    practitioner: 'Reinterprets price / sales / quantity outliers as expected promotional or seasonal swings.',
    expert: 'Recontextualizes extreme values in retail measures as promotion/seasonality artifacts, downgrading rather than dropping them.',
  },

  // ---- Domain-pack reinterpretations (finance) --------------------------
  'finance-ledger-account-no-merge': {
    beginner: 'Account numbers that look similar are separate accounts — combining them would corrupt the books.',
    practitioner: 'Disables auto-merge on ledger / GL-account columns where similar codes are distinct accounts.',
    expert: 'Prevents canonicalization of GL / cost-center codes to preserve chart-of-accounts integrity.',
  },
  'finance-recon-flag-benford-exempt': {
    beginner: 'A reconciled yes/no flag only holds 0 or 1, so the leading-digit check is skipped.',
    practitioner: 'Exempts binary reconciliation / posting-status flags from Benford eligibility.',
    expert: 'Binary settlement/reconciliation indicators are Benford-ineligible and recorded as an explained exemption.',
  },
  'finance-debit-credit-outlier': {
    beginner: 'In accounting, every large debit has a matching large credit, so those extremes are expected structure.',
    practitioner: 'Reinterprets debit / credit / journal-amount outliers as expected offsetting double-entry values.',
    expert: 'Recontextualizes symmetric extremes in double-entry amounts as bookkeeping structure, not anomalies.',
  },
};

// Normalize an arbitrary verbosity input to a known level (falling back to the
// default), so a stray value from the UI can never blank out a lesson.
export function normalizeLevel(level) {
  return VERBOSITY_LEVELS.includes(level) ? level : DEFAULT_VERBOSITY;
}

// Is there a micro-lesson for this finding type?
export function hasMicroLesson(findingType) {
  return Object.prototype.hasOwnProperty.call(MICRO_LESSONS, findingType);
}

// Retrieve the one-line explanation for a finding type at a verbosity level.
// Returns null for an unknown finding type; falls back to the default register
// if an entry somehow lacks the requested one. Pure, no side effects.
export function getMicroLesson(findingType, level = DEFAULT_VERBOSITY) {
  const entry = MICRO_LESSONS[findingType];
  if (!entry) return null;
  const lvl = normalizeLevel(level);
  return entry[lvl] || entry[DEFAULT_VERBOSITY] || null;
}

// Every finding-type id the catalog covers — used by tests to check coverage.
export function listFindingTypes() {
  return Object.keys(MICRO_LESSONS);
}

// Report which of a set of required finding types are missing a lesson. Lets a
// test assert full coverage against the live LAYER_DEFS + DOMAIN_PACKS ids
// without hard-coding the list here (so a new layer/rule can't silently ship
// without an explanation). Returns { covered, missing }.
export function coverageFor(requiredTypes = []) {
  const missing = [];
  for (const t of requiredTypes) {
    if (!hasMicroLesson(t)) missing.push(t);
  }
  return { covered: requiredTypes.length - missing.length, missing };
}
