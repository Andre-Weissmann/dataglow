// ============================================================
// DATAGLOW — Guarded Copilot (Batch 1: deterministic core + read-only contract)
// ============================================================
// WHY THIS EXISTS
// Practitioner research this project has already collected (see
// research_data_community_wishlist_2026.md, research_ui_paradigms_2026.md) names
// a specific, repeated wish: a chat-style assistant that can explain WHY a
// dataset/query/metric looks the way it does — citing real lineage, real
// validation results, real provenance — without the community's other named
// fear, "AI running amok" on the data itself. Guarded Copilot is DATAGLOW's
// answer: a conversational layer that is architecturally, not just by
// convention, INCAPABLE of writing to data.
//
// WHAT MAKES THIS SAFE (composition, not new invention):
// This module invents no new write path, no new AI-writes-data mechanism, and
// no new trust primitive. It is a pure READ-AND-EXPLAIN composition over four
// modules DATAGLOW already ships and already trusts:
//   1. js/gate/readiness-gate.js  — the agent-consumability verdict (batch 1).
//   2. js/gate/agent-gate.js      — the hard refusal an agent gets when the
//                                   gate says no (batch 3, already enforced).
//   3. js/provenance/ai-touch-ledger.js — every touch this module makes gets
//                                   logged exactly like the Story engine's
//                                   on-device/external touches already are.
//   4. js/agents/agent-action-firewall.js — the two-phase propose/confirm
//                                   mutation gate. Guarded Copilot NEVER calls
//                                   confirmAndApply() and holds no reference to
//                                   any executor. It is not merely "unlikely"
//                                   to write data — it has no code path that
//                                   could, the same guarantee the firewall's
//                                   own red-team test suite already proves for
//                                   every other caller.
//
// TWO-TIER ANSWER MODEL (per no-paid-AI-API constraint + local-AI research
// ceiling, research_local_ai_2026.md):
//   Tier 1 (default, always available, zero cost, zero model): deterministic,
//   template-based answers built directly from the same structured data the
//   dashboard's activity feed and the Story engine's claims already use — no
//   LLM call of any kind. This tier is exercised in Node tests, has 100%
//   predictable output, and is what ships live if the flag is ever on with no
//   on-device model loaded.
//   Tier 2 (opt-in, same on-device model as Story's ondevice path,
//   js/narrative/ondevice-llm.js's Qwen2.5-1.5B-Instruct via WebLLM): reuses
//   that exact loader — no second model, no second license to track — to turn
//   Tier 1's structured facts into a more natural free-form answer. If WebGPU
//   is unavailable or the model isn't loaded, this module falls back to Tier 1
//   automatically; a caller never sees a hard failure for lack of a GPU.
//
// SCOPE (Batch 1 of 2, matches this repo's own dark-ship convention): this file
// is the read-only answer engine + firewall-shaped refusal ONLY. It is not
// imported by js/app-shell/main.js yet — no chat panel UI, no Proof Room step.
// Batch 2 (tracked in NORTH_STAR.md) wires a chat UI onto this, behind its own
// UI sub-flag, once this core has run dark for at least one cycle.
//
// PURITY: pure logic — no DOM required for Tier 1. Tier 2 dynamically imports
// ondevice-llm.js only when a caller explicitly requests it, so this file has
// zero cost / zero network access by default.

import { computeReadinessGate, explainGateReasons } from '../gate/readiness-gate.js';
import { createTouchLedger } from '../provenance/ai-touch-ledger.js';

export const GUARDED_COPILOT_KIND = 'dataglow-guarded-copilot';
export const GUARDED_COPILOT_VERSION = 1;

// The full set of questions Tier 1 can answer deterministically. Anything
// outside this set gets an honest "not something I can answer yet" response —
// never a guess, per the "never invent a data-quality verdict" house rule
// already established for js/gate/readiness-gate.js and js/narrative/story.js.
export const SUPPORTED_INTENTS = Object.freeze([
  'why_low_confidence',
  'is_ready_for_agent',
  'what_changed_since',
  'who_touched_this',
  'explain_grade',
]);

/**
 * Classify a free-text question into one of SUPPORTED_INTENTS, or null if none
 * match. Deliberately simple keyword matching — this is Tier 1's job:
 * predictable, auditable, no model. Case-insensitive, order-independent.
 * @param {string} question
 * @returns {string|null}
 */
export function classifyIntent(question) {
  if (typeof question !== 'string' || !question.trim()) return null;
  const q = question.toLowerCase();
  if (/(why|reason).*(low|bad|poor|fail)/.test(q) && /(confiden|grade|score)/.test(q)) return 'why_low_confidence';
  if (/(ready|safe|ok).*(agent|ai)|agent.*(ready|consum)/.test(q)) return 'is_ready_for_agent';
  if (/(what|anything).*(chang|differ)/.test(q)) return 'what_changed_since';
  if (/(who|which).*(touch|access|saw|used).*(this|data|dataset)/.test(q)) return 'who_touched_this';
  if (/(explain|why).*(grade|score)/.test(q)) return 'explain_grade';
  return null;
}

// Grade -> one-line, honest, non-alarmist explanation template. Mirrors the
// GRADE_COLOR convention in js/narrative/story.js so this reads consistently
// with existing confidence badges rather than inventing new grade language.
const GRADE_EXPLANATION = {
  A: 'passed the validation layers with high confidence and low missingness.',
  B: 'passed the validation layers, with some missingness or a soft warning worth knowing about.',
  C: 'has real, named issues from the validation layers that should be reviewed before relying on it.',
  D: 'failed one or more validation layers outright — treat any conclusion from it as unreliable until fixed.',
};

/**
 * Tier 1: deterministic answer engine. Takes a classified intent plus the
 * structured context the caller already has on hand (never re-fetched or
 * re-computed here — this module composes, it does not re-run validation).
 *
 * @param {string} intent - one of SUPPORTED_INTENTS
 * @param {object} context - {
 *   layerResults, metricContractStatus, options,   // for gate-shaped intents
 *   grade,                                          // for explain_grade
 *   journalEntries,                                 // for what_changed_since
 *   touchLedgerEntries,                              // for who_touched_this
 * }
 * @returns {{answered:boolean, text:string, citedFrom:string[]}}
 */
export function answerDeterministic(intent, context = {}) {
  const citedFrom = [];

  if (intent === 'is_ready_for_agent' || intent === 'why_low_confidence') {
    const gate = computeReadinessGate(
      context.layerResults,
      context.metricContractStatus,
      context.options || {},
    );
    citedFrom.push('js/gate/readiness-gate.js:computeReadinessGate');
    if (gate.agentConsumable) {
      return {
        answered: true,
        text: 'Yes — this data currently passes the AI Readiness Gate and is agent-consumable.',
        citedFrom,
      };
    }
    const reasons = explainGateReasons(gate);
    citedFrom.push('js/gate/readiness-gate.js:explainGateReasons');
    return {
      answered: true,
      text: `Not yet. The AI Readiness Gate is blocking this: ${reasons}`,
      citedFrom,
    };
  }

  if (intent === 'explain_grade') {
    const grade = context.grade;
    if (!grade || !GRADE_EXPLANATION[grade]) {
      return { answered: false, text: 'I don\u2019t have a grade to explain for this yet.', citedFrom };
    }
    citedFrom.push('js/narrative/story.js:GRADE_COLOR (grade vocabulary)');
    return { answered: true, text: `Grade ${grade}: this ${GRADE_EXPLANATION[grade]}`, citedFrom };
  }

  if (intent === 'what_changed_since') {
    const entries = Array.isArray(context.journalEntries) ? context.journalEntries : [];
    if (entries.length === 0) {
      return { answered: true, text: 'No logged changes found for this run.', citedFrom };
    }
    citedFrom.push('dev-log/journal.md entries (caller-supplied)');
    const lines = entries.slice(0, 5).map((e) => `- ${e.summary || e.title || String(e)}`);
    return { answered: true, text: `Recent changes:\n${lines.join('\n')}`, citedFrom };
  }

  if (intent === 'who_touched_this') {
    const touches = Array.isArray(context.touchLedgerEntries) ? context.touchLedgerEntries : [];
    if (touches.length === 0) {
      return { answered: true, text: 'No AI Touch Ledger entries recorded for this dataset yet.', citedFrom };
    }
    citedFrom.push('js/provenance/ai-touch-ledger.js');
    const lines = touches.slice(-5).map(
      (t) => `- ${t.model || 'unknown model'} (${t.location === 'ondevice' ? 'on-device, no network egress' : 'external, left the browser'})`,
    );
    return { answered: true, text: `Recent AI touches on this data:\n${lines.join('\n')}`, citedFrom };
  }

  return { answered: false, text: 'I don\u2019t have a reliable, evidence-backed answer for that yet.', citedFrom };
}

/**
 * The single public entry point. Classifies the question, answers via Tier 1,
 * and — critically — logs the query itself to the AI Touch Ledger, the same
 * way js/narrative/story.js logs every Story generation. This is what lets
 * "who touched this data" answers be truthful about Guarded Copilot's own
 * queries, not just other agents'.
 *
 * @param {string} question
 * @param {object} context - see answerDeterministic; may also include
 *   { datasetId, priorTouchChainTip } for ledger logging.
 * @returns {Promise<{answered:boolean, text:string, citedFrom:string[], intent:(string|null), ledgerEntry:(object|null)}>}
 */
export async function askGuardedCopilot(question, context = {}) {
  const intent = classifyIntent(question);
  const result = intent
    ? answerDeterministic(intent, context)
    : { answered: false, text: 'I can answer questions about readiness, grades, recent changes, and who/what touched this data — try rephrasing.', citedFrom: [] };

  // Log this query itself to a caller-supplied (or freshly created) Touch
  // Ledger, using the SAME createTouchLedger()/logTouch() closure API the
  // Story engine's wiring uses — never a bespoke logging shape. Passing an
  // existing ledger via context.touchLedger lets a real call site keep one
  // running chain per dataset across multiple Guarded Copilot questions;
  // omitting it just logs to a throwaway one-entry ledger for this call.
  let ledgerEntry = null;
  try {
    const ledger = context.touchLedger && typeof context.touchLedger.logTouch === 'function'
      ? context.touchLedger
      : createTouchLedger();
    ledgerEntry = await ledger.logTouch({
      model: 'guarded-copilot-tier1-deterministic',
      location: 'ondevice',
      fieldsTouched: [],
      triggeredBy: 'guarded-copilot-query',
      action: intent || 'unclassified-question',
    });
  } catch {
    // Ledger logging is best-effort observability, never a hard dependency —
    // a ledger write failure must never block or corrupt the answer itself.
    ledgerEntry = null;
  }

  return { ...result, intent, ledgerEntry };
}

/**
 * Tier 2 (opt-in): reuse the EXACT on-device model loader Story already uses.
 * Never calls any external provider. Falls back to the Tier 1 text untouched
 * if WebGPU/the model is unavailable, so callers never get a hard failure.
 * Dynamically imported so Tier 1 (and this file's tests) never pay the cost of
 * loading WebLLM.
 *
 * @param {string} question
 * @param {{answered:boolean,text:string,citedFrom:string[]}} tier1Result
 * @returns {Promise<{text:string, usedOnDeviceModel:boolean}>}
 */
export async function refineWithOnDeviceModel(question, tier1Result) {
  try {
    const { isWebGPUAvailable } = await import('../narrative/ondevice-llm.js');
    if (!isWebGPUAvailable()) {
      return { text: tier1Result.text, usedOnDeviceModel: false };
    }
    // Batch 1 stops here deliberately: actually invoking the loaded model to
    // rephrase tier1Result.text is Batch 2 scope (needs the model already
    // warmed via the Story engine's own opt-in flow to avoid double-loading a
    // ~1.1GB model just for a chat rephrase). Returning the Tier 1 text
    // unmodified keeps this function's public contract stable so Batch 2 can
    // fill in the model call without changing any call site.
    return { text: tier1Result.text, usedOnDeviceModel: false };
  } catch {
    return { text: tier1Result.text, usedOnDeviceModel: false };
  }
}

// Explicit, testable proof of the write-blocking guarantee: this module has no
// import of agent-action-firewall's confirmAndApply, no import of any DuckDB
// write/mutation helper, and exports nothing named propose/apply/write/mutate.
// A red-team test (test/guarded-copilot.test.mjs) asserts this list stays
// exactly this shape so a future edit can't silently add a write path.
export const PUBLIC_API_SURFACE = Object.freeze([
  'classifyIntent',
  'answerDeterministic',
  'askGuardedCopilot',
  'refineWithOnDeviceModel',
]);
