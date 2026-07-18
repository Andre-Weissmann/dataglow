// ============================================================
// DATAGLOW — AI Readiness Gate: agent hard-block (batch 3 of 4)
// ============================================================
// WHY THIS EXISTS (the North Star concept, batch 3):
// Batch 1 (js/gate/readiness-gate.js) produced the pure agent-consumability
// verdict; batch 2 (js/gate/readiness-gate-ui.js) surfaced it as an INFORMATIONAL
// badge for humans. This module is the batch-3 HARD BLOCK: it turns that verdict
// into an actual refusal for DATAGLOW's own data-consuming agent modules
// (js/agents/*), so an agent never produces output from a dataset/query result
// the gate marks agentConsumable:false.
//
// EMPOWERMENT / SCOPE CONSTRAINT (non-negotiable): this blocks ONLY automated
// js/agents/* output — NEVER a human. Human-facing SQL/Python/R/Metric Studio
// workflows do not call this. It is opt-in per call site: an agent only consults
// the gate when the caller threads a `readiness` context in; with no readiness
// context supplied (the default for every existing caller/test) the agent is
// ALLOWED, so wiring this in never breaks a pre-existing call path. main.js only
// threads the readiness context when the `aiReadinessGateEnforcement` flag is on.
//
// PURE: composes batch-1's computeReadinessGate() + explainGateReasons(). No DOM,
// no network, no engine — Node-testable like the rest of js/gate/*.

import { computeReadinessGate, explainGateReasons } from './readiness-gate.js';

// The readiness context an agent caller may thread through. Every field optional;
// `layerResults` is the OUTPUT of runAllLayers() the call site already has (never
// re-run here). `rigorResult` is the OUTPUT of classifyConfidence() or
// summarizeGroupedConfidence() from js/rigor/statistical-rigor.js — when supplied
// and verdict is 'insufficient', the agent is hard-blocked with a
// `statisticalConfidence` reason code. Absent/undefined context => the agent is
// not being gated.
//   { layerResults, metricContractStatus, options, rigorResult }

// ---- statistical confidence reason code ------------------------------------

// Rigor verdicts that constitute a hard block for agent output. 'low' is a
// WARNING (human sees a badge) but not a hard block for agents — the data is
// still usable, just acknowledged as below n=30. 'insufficient' (n<10) is the
// threshold where no statistically defensible claim can be made at all.
const STAT_BLOCK_VERDICTS = new Set(['insufficient']);

/**
 * Evaluate the statistical-confidence section of a readiness context.
 * Returns null when no rigorResult is supplied (backward-compatible).
 * Returns an object with { blocked, verdict, reason } otherwise.
 *
 * @param {object} [rigorResult] - classifyConfidence() or
 *   summarizeGroupedConfidence() output: { verdict, reason, n?, worstN? }
 * @returns {{ blocked: boolean, verdict: string, reason: string } | null}
 */
export function evaluateStatisticalConfidence(rigorResult) {
  if (!rigorResult || typeof rigorResult !== 'object') return null;
  const verdict = String(rigorResult.verdict || '').toLowerCase();
  const n = rigorResult.worstN ?? rigorResult.n ?? null;
  const reason = rigorResult.reason
    ? String(rigorResult.reason)
    : (n !== null
      ? 'Statistical confidence insufficient (n=' + n + '). An agent must not produce a claim from this result.'
      : 'Statistical confidence is insufficient. An agent must not produce a claim from this result.');
  return { blocked: STAT_BLOCK_VERDICTS.has(verdict), verdict, reason };
}

/**
 * Build a uniform refusal object for a statistical-confidence block. Shape
 * mirrors buildAgentRefusal so callers handle both the same way.
 *
 * @param {string} agent
 * @param {{ verdict: string, reason: string }} statEval
 * @returns {{ blocked: true, agent: string, reasons: string, reasonCode: string, message: string }}
 */
export function buildStatConfidenceRefusal(agent, statEval) {
  const reasons = 'statisticalConfidence: ' + (statEval.reason || 'insufficient sample size for a defensible agent claim.');
  return {
    blocked: true,
    agent: String(agent || 'agent'),
    reasonCode: 'statisticalConfidence',
    verdict: statEval.verdict,
    reasons,
    message: 'Statistical confidence gate blocked ' + String(agent || 'this agent') + ': ' + reasons,
  };
}

/**
 * Evaluate whether an agent may proceed, given an optional readiness context.
 * Backward-compatible: when no context is supplied the agent is ALLOWED
 * (blocked:false), so existing callers/tests are unaffected.
 *
 * @param {object} [readiness] - { layerResults, metricContractStatus, options }
 * @returns {{blocked:boolean, gate:(object|null), message:(string|undefined)}}
 */
export function evaluateAgentReadiness(readiness) {
  if (!readiness || typeof readiness !== 'object') {
    return { blocked: false, gate: null };
  }

  // Statistical confidence check runs FIRST: if the result itself has too few
  // observations to support any agent claim, block immediately with a dedicated
  // reason code rather than letting the data-quality gate absorb the signal.
  const statEval = evaluateStatisticalConfidence(readiness.rigorResult);
  if (statEval && statEval.blocked) {
    return {
      blocked: true,
      gate: null,
      reasonCode: 'statisticalConfidence',
      message: 'statisticalConfidence: ' + statEval.reason,
    };
  }

  const gate = computeReadinessGate(
    readiness.layerResults,
    readiness.metricContractStatus,
    readiness.options || {},
  );
  if (gate.agentConsumable) {
    // Surface any low-confidence advisory (non-blocking) so callers can
    // include it in agent output without refusing outright.
    const advisory = statEval && statEval.verdict === 'low'
      ? { statisticalConfidenceAdvisory: statEval.reason }
      : {};
    return { blocked: false, gate, ...advisory };
  }
  return { blocked: true, gate, message: explainGateReasons(gate) };
}

/**
 * Build a uniform, graceful refusal object an agent returns instead of output
 * when the gate blocks it. Discriminable by `blocked:true`. The `reasons` string
 * comes from explainGateReasons() so the refusal cites the exact failing layer(s)
 * — honest diagnostics, not "bad data ruined my AI" hand-waving.
 *
 * @param {string} agent - the agent module name, for a clear message.
 * @param {{gate:object, message:string}} evaluation - result of evaluateAgentReadiness
 * @returns {{blocked:true, agent:string, reasons:string, gate:object, message:string}}
 */
export function buildAgentRefusal(agent, evaluation) {
  const gate = (evaluation && evaluation.gate) || null;
  const reasons = (evaluation && evaluation.message) || explainGateReasons(gate);
  return {
    blocked: true,
    agent: String(agent || 'agent'),
    reasons,
    gate,
    message: `AI Readiness Gate blocked ${String(agent || 'this agent')}: the data is not agent-consumable yet. ${reasons}`,
  };
}
