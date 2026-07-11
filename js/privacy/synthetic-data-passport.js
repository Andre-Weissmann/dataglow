// ============================================================
// DATAGLOW — Governed Synthetic Data Passport
// (Trust Passport, Batch 4 — the finale: apply the passport to synthetic data)
// ============================================================
// When a dataset leaves DATAGLOW as SYNTHETIC — via the Synthetic Twin
// (js/privacy/synthetic-twin.js) or the DP aggregate export path
// (js/privacy/privacy-budget.js) — this module lets it carry a full governance
// record instead of leaving "naked" numbers. It COMPOSES the three prior Trust
// Passport batches, adding nothing to their crypto or their shapes:
//
//   • Batch 2 (Data Nutrition Label, js/provenance/data-nutrition-label.js) is
//     the container: buildDataNutritionLabel() is called with isSynthetic:true
//     and the source-data checks/custody/assumptions the caller already holds.
//   • Batch 1 (Semantic/Metrics Layer) feeds in through those same `checks` —
//     what was validated on the SOURCE data before synthesis travels with the
//     passport; this module does not re-check anything.
//   • Batch 3 (Verifiable Check Seal, js/provenance/verifiable-check-seal.js) is
//     the optional tamper-evidence: sealSyntheticPassport() seals the exact
//     generation parameters + a fingerprint of the synthetic OUTPUT and attaches
//     the seal additively to the label's custodyChain.
//
// This module ADDS ONE new thing on top of the label: a `synthetic` block that
// honestly describes HOW the synthetic data was produced and WHAT privacy
// guarantee (if any) actually applies.
//
// HONEST NAMING (the hard constraint, most acute in this batch):
//   • A formal differential-privacy claim (mechanism + a specific ε) is asserted
//     ONLY when the generation context actually establishes one. The Synthetic
//     Twin and the DP aggregate export both implement the Laplace mechanism with
//     a caller-chosen ε, so for those inputs the passport says so — but it also
//     carries the generator's OWN disclaimer verbatim. It never upgrades a DP
//     mechanism: never "anonymized", never a "HIPAA Safe Harbor", never an
//     Expert Determination, never any legal/clinical determination. DP bounds
//     each row's influence; it is not an audited re-identification guarantee.
//   • When the generation method is heuristic / declares no DP (or the caller
//     passes formalDifferentialPrivacy:false), the passport says PLAINLY that no
//     formal privacy guarantee is claimed and the output may be re-identifiable.
//   • The confidence level of any claim is never raised above what the source
//     module established. When in doubt, this module reports "no guarantee",
//     never invents one.
//
// PURITY: pure data assembly — no DOM, no network, no crypto of its own (it only
// calls batch 3's Merkle/SHA-256 seal). Plain objects in, JSON-serializable
// objects out. Identical in the browser, the Tauri desktop webview, and Node.

import { buildDataNutritionLabel } from '../provenance/data-nutrition-label.js';
import { sealCheckResult, attachSealToLabel } from '../provenance/verifiable-check-seal.js';

export const SYNTHETIC_PASSPORT_KIND = 'dataglow-synthetic-data-passport';
export const SYNTHETIC_PASSPORT_SCHEMA_VERSION = 1;

export const SYNTHETIC_PASSPORT_DISCLAIMER =
  'This is a Governed Synthetic Data Passport: a Data Nutrition Label '
  + '(isSynthetic = true) plus a description of exactly how this synthetic data '
  + 'was generated and what privacy guarantee, if any, applies. It is a summary '
  + 'and provenance record only — NOT a certification, NOT an audited '
  + 'anonymization, and NOT a legal, clinical, or regulatory determination. A '
  + 'stated differential-privacy budget (ε) bounds how much any single source '
  + 'row can influence the output; it is NOT a HIPAA Safe Harbor / Expert '
  + 'Determination and does NOT by itself prove the data cannot be '
  + 're-identified. Where no formal privacy mechanism is recorded, treat the '
  + 'synthetic output as potentially re-identifiable.';

// Kinds this module recognizes as carrying a real Laplace differential-privacy
// mechanism (verified by reading the generator source). A `kind` NOT in this
// set is treated as establishing no formal guarantee unless the caller passes
// an explicit `formalDifferentialPrivacy: true` AND a positive ε — we never
// upgrade on our own.
const DP_TWIN_KIND = 'dataglow-synthetic-twin';

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// Normalize whatever the caller hands us about the generation run into ONE
// honest privacy descriptor. Accepts:
//   • a Synthetic Twin output ({ kind:'dataglow-synthetic-twin', epsilon,
//     mechanism, comparison, disclaimer })
//   • a DP aggregate export ({ epsilon, mechanism:'Laplace', disclaimer })
//   • a plain descriptor ({ method, epsilon, mechanism, bins,
//     formalDifferentialPrivacy, disclaimer, ... })
// The rule that matters: formalDifferentialPrivacy is TRUE only when the input
// genuinely establishes a DP mechanism with a positive ε. Otherwise it is FALSE
// and the statement says so plainly.
export function describeSyntheticGeneration(gen = {}) {
  const kind = typeof gen.kind === 'string' ? gen.kind : null;
  const epsilon = isPositiveNumber(gen.epsilon) ? gen.epsilon : null;
  const mechanism = typeof gen.mechanism === 'string' && gen.mechanism ? gen.mechanism : null;

  // Human-readable method name. Prefer an explicit method, then a recognized
  // kind, then the mechanism, then a plain fallback — never guess a fancy one.
  const method = gen.method
    || (kind === DP_TWIN_KIND ? 'Synthetic Adversarial Twin (DP histogram → resample)' : null)
    || (kind ? kind : null)
    || (mechanism ? `Generator using ${mechanism}` : 'Unspecified synthetic-data generator');

  // Decide, conservatively, whether a formal DP guarantee is actually backed.
  //  - a recognized DP twin kind with a positive ε: yes
  //  - a Laplace/DP mechanism string with a positive ε: yes
  //  - the caller explicitly asserts formalDifferentialPrivacy:true AND gives a
  //    positive ε: yes (trust the caller only when they also supply the budget)
  //  - anything else: NO. Never upgrade.
  const mechanismLooksDp = mechanism != null && /laplace|differential[- ]privacy|\bdp\b/i.test(mechanism);
  let formalDifferentialPrivacy = false;
  if (epsilon != null) {
    if (kind === DP_TWIN_KIND) formalDifferentialPrivacy = true;
    else if (mechanismLooksDp) formalDifferentialPrivacy = true;
    else if (gen.formalDifferentialPrivacy === true) formalDifferentialPrivacy = true;
  }
  // An explicit false from the caller always wins — we never override a caller
  // who tells us their method is not DP.
  if (gen.formalDifferentialPrivacy === false) formalDifferentialPrivacy = false;

  const privacyModel = formalDifferentialPrivacy ? 'differential-privacy' : 'none-declared';

  const privacyGuaranteeStatement = formalDifferentialPrivacy
    ? `A formal differential-privacy mechanism${mechanism ? ` (${mechanism})` : ''} was applied `
      + `with privacy budget ε=${epsilon}. This bounds how much any single source row can `
      + `influence the synthetic output (smaller ε = stronger privacy). It is NOT an audited `
      + `anonymization, NOT a HIPAA Safe Harbor or Expert Determination, and does NOT by itself `
      + `prove the output cannot be re-identified.`
    : `No formal privacy guarantee is claimed for this synthetic data. The generation method `
      + `(${method}) does not record a differential-privacy mechanism or budget, so treat the `
      + `output as potentially re-identifiable and do NOT describe it as anonymized.`;

  // Parameters actually recorded by the generator, carried through verbatim.
  const parameters = {};
  if (epsilon != null) parameters.epsilon = epsilon;
  if (isPositiveNumber(gen.bins)) parameters.bins = gen.bins;
  if (isPositiveNumber(gen.count)) parameters.count = gen.count;
  if (Number.isFinite(gen.sensitivity)) parameters.sensitivity = gen.sensitivity;

  return {
    method,
    mechanism,
    epsilon,
    formalDifferentialPrivacy,
    privacyModel,
    privacyGuaranteeStatement,
    // The generator's own words travel with the passport, unmodified, so a
    // recipient sees the mechanism author's caveats rather than only ours.
    generatorDisclaimer: typeof gen.disclaimer === 'string' && gen.disclaimer ? gen.disclaimer : null,
    parameters,
  };
}

// Summarize a real-vs-synthetic column comparison (as produced by the Synthetic
// Twin) into a compact, JSON-safe utility note. This is UTILITY information, not
// a privacy claim — it says how closely the synthetic distribution tracks the
// real one, nothing about re-identification. Returns null when absent.
function summarizeUtility(comparison) {
  if (!Array.isArray(comparison) || !comparison.length) return null;
  return {
    columnsCompared: comparison.length,
    columns: comparison.map((c) => ({
      column: c.column,
      type: c.type || null,
    })),
    note: 'Distribution-shape comparison only (real vs. synthetic). Utility signal, not a privacy guarantee.',
  };
}

/**
 * Build a Governed Synthetic Data Passport.
 *
 * @param {object} ctx
 * @param {object} ctx.generation  The synthetic-generation output/metadata: a
 *   Synthetic Twin result, a DP aggregate export, or a plain descriptor
 *   (see describeSyntheticGeneration). REQUIRED — a passport with no generation
 *   record would defeat the purpose.
 * @param {object} [ctx.dataset]   Dataset identity for the label (name, table,
 *   rowCount, columnNames/columns, ...). For a synthetic export this should
 *   describe the SYNTHETIC dataset being shipped.
 * @param {Array|object} [ctx.custody]      Chain-of-custody trail / chain object (batch 2).
 * @param {Array} [ctx.assumptions]         Assumption Ledger entries (batch 2).
 * @param {Array} [ctx.checks]              Per-layer results validated on the SOURCE data
 *   before synthesis (this is the batch-1 Semantic/Metrics Layer connection).
 * @param {object} [ctx.adversarial]        Optional adversarial-robustness summary IF the
 *   caller computed one. NOTE: DATAGLOW's js/privacy/synthetic-adversarial.js produces
 *   adversarial TEST FIXTURES (planted-issue datasets), NOT robustness scores of a
 *   synthetic OUTPUT, so this is null unless a caller supplies something meaningful.
 * @param {number|Date} [ctx.generatedAt]   Override timestamp (tests).
 * @returns {object} A JSON-serializable passport: { kind, schemaVersion,
 *   generatedAt, label, synthetic, disclaimer }.
 */
export function buildSyntheticDataPassport(ctx = {}) {
  const generation = ctx.generation;
  if (!generation || typeof generation !== 'object') {
    throw new Error(
      'buildSyntheticDataPassport: ctx.generation (the synthetic-generation output/metadata) '
      + 'is required — refusing to build a synthetic passport with no generation record.');
  }

  const generatedAt = (ctx.generatedAt instanceof Date
    ? ctx.generatedAt
    : (ctx.generatedAt != null ? new Date(ctx.generatedAt) : new Date())).toISOString();

  // The container: a real Data Nutrition Label with isSynthetic forced TRUE.
  // We call batch 2 unmodified; the label's own custodyChain/checks/etc. are its
  // authoritative fields.
  const label = buildDataNutritionLabel({
    dataset: ctx.dataset,
    custody: ctx.custody,
    assumptions: ctx.assumptions,
    checks: ctx.checks,
    isSynthetic: true,
    generatedAt,
  });

  const gen = describeSyntheticGeneration(generation);

  const synthetic = {
    ...gen,
    utility: summarizeUtility(generation.comparison),
    // Only carried when the caller actually supplies a robustness summary. See
    // the JSDoc note: this is deliberately NOT auto-derived from
    // synthetic-adversarial.js, which produces test fixtures, not scores.
    adversarial: (ctx.adversarial && typeof ctx.adversarial === 'object') ? ctx.adversarial : null,
    // Restate, at the synthetic block, that source-data checks (which include
    // the batch-1 Semantic/Metrics Layer results when the caller passes them)
    // describe the SOURCE, not the synthetic output.
    sourceChecksNote: 'The label.checksRun entries describe validation of the SOURCE data before '
      + 'synthesis, not the synthetic output itself.',
  };

  return {
    kind: SYNTHETIC_PASSPORT_KIND,
    schemaVersion: SYNTHETIC_PASSPORT_SCHEMA_VERSION,
    generatedAt,
    label,
    synthetic,
    disclaimer: SYNTHETIC_PASSPORT_DISCLAIMER,
  };
}

/**
 * OPT-IN: seal a passport into a tamper-evident record via batch 3.
 * ALWAYS an explicit caller action — nothing here seals on its own.
 *
 * Seals the exact generation parameters (as the check "result") bound to a
 * SHA-256 fingerprint of the synthetic OUTPUT the caller is shipping, anchors
 * the seal to the passport's label custodyChain.finalHash, and attaches the
 * seal additively to that label (new custodyChain.seals array — no batch-2 field
 * is changed). Returns a NEW passport; the input is not mutated.
 *
 * A data fingerprint is REQUIRED (batch 3 refuses to mint an empty seal): pass
 * context.data (the synthetic rows/CSV to fingerprint here) or
 * context.dataFingerprint (precomputed, for large exports).
 *
 * @param {object} passport  A buildSyntheticDataPassport output.
 * @param {object} context
 * @param {*}      [context.data]             Synthetic output to fingerprint (rows array, CSV string, ...).
 * @param {string} [context.dataFingerprint]  Precomputed fingerprint of the synthetic output.
 * @param {object} [context.dataglow]         { version, build } provenance of the tool.
 * @param {number|Date} [context.generatedAt] Override seal timestamp (tests).
 * @returns {Promise<object>} A new passport with `label` re-anchored+sealed and a
 *   top-level `seal` for convenience.
 */
export async function sealSyntheticPassport(passport, context = {}) {
  if (!passport || passport.kind !== SYNTHETIC_PASSPORT_KIND) {
    throw new Error('sealSyntheticPassport: first argument must be a synthetic data passport.');
  }
  const label = passport.label || {};
  const syn = passport.synthetic || {};

  // The "result" of the generation check: the honest privacy/parameter record.
  // Fingerprinting this (batch 3 does it internally) binds the exact parameters.
  const result = {
    status: syn.formalDifferentialPrivacy ? 'generated-with-dp' : 'generated-no-formal-guarantee',
    flagCount: null,
    method: syn.method ?? null,
    mechanism: syn.mechanism ?? null,
    epsilon: syn.epsilon ?? null,
    formalDifferentialPrivacy: syn.formalDifferentialPrivacy === true,
    parameters: syn.parameters ?? {},
  };

  const dataset = label.dataset || {};
  const seal = await sealCheckResult(result, {
    check: { name: 'Synthetic Data Generation', kind: 'synthetic-data-passport' },
    params: {
      method: syn.method ?? null,
      mechanism: syn.mechanism ?? null,
      epsilon: syn.epsilon ?? null,
      parameters: syn.parameters ?? {},
    },
    dataset: {
      name: dataset.name || 'synthetic dataset',
      rowCount: Number.isFinite(dataset.rowCount) ? dataset.rowCount : null,
      columnNames: Array.isArray(dataset.columnNames) ? dataset.columnNames : [],
    },
    data: context.data,
    dataFingerprint: context.dataFingerprint,
    labelAnchor: label.custodyChain ? label.custodyChain.finalHash : null,
    dataglow: context.dataglow,
    generatedAt: context.generatedAt,
  });

  const sealedLabel = attachSealToLabel(label, seal);

  return {
    ...passport,
    label: sealedLabel,
    seal,
  };
}

/**
 * Render a passport as plain-text lines (sibling to renderLabelSummaryLines /
 * renderSealSummaryLines). Leads with the honest privacy line so it can never be
 * separated from the numbers.
 * @param {object} passport
 * @returns {string[]}
 */
export function renderPassportSummaryLines(passport) {
  if (!passport || passport.kind !== SYNTHETIC_PASSPORT_KIND) {
    return ['Governed Synthetic Data Passport: (not available).'];
  }
  const syn = passport.synthetic || {};
  const label = passport.label || {};
  const ds = label.dataset || {};
  const lines = [];
  lines.push('Governed Synthetic Data Passport');
  lines.push('  (Data Nutrition Label with isSynthetic=true + generation record — not a certification.)');
  lines.push(`  Generated: ${passport.generatedAt}`);
  lines.push(`  Synthetic dataset: ${ds.name || 'dataset'}${ds.table ? `  (table: ${ds.table})` : ''}`);
  lines.push(`  Generation method: ${syn.method || 'unspecified'}`);
  lines.push(`  Privacy model: ${syn.privacyModel === 'differential-privacy'
    ? `differential privacy (ε=${syn.epsilon})`
    : 'none declared'}`);
  lines.push(`  Privacy guarantee: ${syn.privacyGuaranteeStatement || 'unstated'}`);
  if (syn.generatorDisclaimer) lines.push(`  Generator note: ${syn.generatorDisclaimer}`);
  if (syn.utility) lines.push(`  Utility comparison: ${syn.utility.columnsCompared} column(s) (distribution shape only).`);
  const chain = label.custodyChain || { length: 0, seals: [] };
  const sealCount = Array.isArray(chain.seals) ? chain.seals.length : 0;
  lines.push(`  Chain of custody: ${chain.length || 0} step(s)`
    + (sealCount ? `, ${sealCount} attached seal(s).` : ' (unsealed).'));
  return lines;
}

/**
 * Render a passport as a single plain-text block (joined lines).
 * @param {object} passport
 * @returns {string}
 */
export function renderPassportSummary(passport) {
  return renderPassportSummaryLines(passport).join('\n');
}

/**
 * Serialize a passport to pretty-printed JSON — the portable artifact a
 * recipient inspects or re-verifies. Round-trips losslessly via JSON.parse.
 * @param {object} passport
 * @returns {string}
 */
export function exportPassportAsJSON(passport) {
  return JSON.stringify(passport, null, 2);
}
