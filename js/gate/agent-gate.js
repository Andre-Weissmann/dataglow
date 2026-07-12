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
// re-run here). Absent/undefined context => the agent is not being gated.
//   { layerResults, metricContractStatus, options }

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
  const gate = computeReadinessGate(
    readiness.layerResults,
    readiness.metricContractStatus,
    readiness.options || {},
  );
  if (gate.agentConsumable) {
    return { blocked: false, gate };
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
