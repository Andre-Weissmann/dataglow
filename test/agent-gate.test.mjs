// ============================================================
// DATAGLOW — AI Readiness Gate: agent hard-block test suite (batch 3 of 4)
// ============================================================
// Proves the batch-3 hard block for js/agents/*:
//   - the pure helper (evaluateAgentReadiness/buildAgentRefusal) allows when no
//     readiness context is threaded (backward compatible), and blocks with an
//     honest reasons string when the gate marks data not agent-consumable,
//   - the question generator refuses (returns { blocked:true }) instead of
//     producing questions when gated + not consumable, works normally when gated
//     + consumable, and is UNCHANGED when no readiness context is passed,
//   - the uncertainty resolver refuses under the same conditions, resolves
//     normally otherwise, and is unchanged when unwired,
//   - the block only ever touches the agent path — the gate is opt-in per call.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/agent-gate.test.mjs

import { evaluateAgentReadiness, buildAgentRefusal } from '../js/gate/agent-gate.js';
import { generateQuestions } from '../js/agents/question-generator-agent.js';
import { resolve } from '../js/agents/uncertainty-resolver-agent.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A validation-results shape runAllLayers() would emit. Layers all pass → the
// gate scores 100 and marks the data agent-consumable.
function passingLayerResults() {
  return {
    schema: { status: 'pass', summary: 'schema ok' },
    ranges: { status: 'pass', summary: 'ranges ok' },
    missing: { status: 'pass', summary: 'no missing' },
  };
}

// A hard failure in any layer → the gate blocks (agentConsumable:false).
function blockingLayerResults() {
  return {
    schema: { status: 'pass', summary: 'schema ok' },
    ranges: { status: 'fail', summary: 'discount_pct exceeds 100%' },
    missing: { status: 'warn', summary: 'some gaps' },
  };
}

// A grounded candidate/context the agents can act on when NOT blocked.
function ctx() {
  return {
    columnStats: [{ column: 'discount_pct', max: 150, min: 0, mean: 20, std: 15 }],
  };
}
function candidate() {
  return {
    column: 'discount_pct', category: 'impossible', value: 150,
    observation: 'values up to 150%', ruleGuess: '"discount_pct" never go above 100%',
    severity: 0.5,
  };
}

async function main() {
  // ---------- 1. Pure helper: backward-compatible allow ----------
  ok(evaluateAgentReadiness(undefined).blocked === false,
    'helper: no readiness context → allowed (backward compatible)');
  ok(evaluateAgentReadiness(null).blocked === false,
    'helper: null readiness → allowed');

  // ---------- 2. Pure helper: allow when consumable ----------
  const okEval = evaluateAgentReadiness({ layerResults: passingLayerResults() });
  ok(okEval.blocked === false, 'helper: consumable data → allowed');
  ok(okEval.gate && okEval.gate.agentConsumable === true, 'helper: exposes the passing gate verdict');

  // ---------- 3. Pure helper: block when not consumable ----------
  const badEval = evaluateAgentReadiness({ layerResults: blockingLayerResults() });
  ok(badEval.blocked === true, 'helper: hard-failed data → blocked');
  ok(typeof badEval.message === 'string' && /BLOCKED/.test(badEval.message),
    'helper: block carries the explainGateReasons() text');
  ok(/discount_pct exceeds 100%/.test(badEval.message),
    'helper: the reasons cite the exact failing layer summary (honest diagnostics)');

  // ---------- 4. buildAgentRefusal shape ----------
  const refusal = buildAgentRefusal('question-generator-agent', badEval);
  ok(refusal.blocked === true, 'refusal: discriminable by blocked:true');
  ok(refusal.agent === 'question-generator-agent', 'refusal: names the agent');
  ok(typeof refusal.reasons === 'string' && refusal.reasons.length > 0, 'refusal: carries reasons');
  ok(/not agent-consumable/.test(refusal.message), 'refusal: human-readable message explains the block');

  // ---------- 5. Question generator: unwired (no readiness) is UNCHANGED ----------
  const unwired = generateQuestions(ctx(), { max: 5 });
  ok(Array.isArray(unwired) && unwired.length > 0,
    'questiongen: no readiness context → produces questions exactly as before');

  // ---------- 6. Question generator: gated + consumable → still produces ----------
  const allowed = generateQuestions(ctx(), { max: 5, readiness: { layerResults: passingLayerResults() } });
  ok(Array.isArray(allowed) && allowed.length > 0,
    'questiongen: gated + consumable → produces questions');
  ok(!('blocked' in allowed), 'questiongen: a produced result is a plain array, not a refusal');

  // ---------- 7. Question generator: gated + NOT consumable → refuses ----------
  const blocked = generateQuestions(ctx(), { max: 5, readiness: { layerResults: blockingLayerResults() } });
  ok(blocked && blocked.blocked === true,
    'questiongen: gated + not consumable → returns a refusal instead of questions');
  ok(!Array.isArray(blocked), 'questiongen: a refusal is NOT an array of questions');
  ok(/discount_pct exceeds 100%/.test(blocked.reasons),
    'questiongen: refusal reasons cite the failing layer');

  // ---------- 8. Question generator: a broken metric contract alone blocks ----------
  const contractBlocked = generateQuestions(ctx(), {
    max: 5, readiness: { layerResults: passingLayerResults(), metricContractStatus: { ok: false } },
  });
  ok(contractBlocked && contractBlocked.blocked === true,
    'questiongen: a broken metric contract blocks even when layers pass');

  // ---------- 9. Uncertainty resolver: unwired is UNCHANGED ----------
  const resUnwired = await resolve(candidate(), {});
  ok(resUnwired && resUnwired.blocked !== true && typeof resUnwired.suggestion === 'string',
    'resolver: no readiness context → resolves normally as before');

  // ---------- 10. Uncertainty resolver: gated + consumable → resolves ----------
  const resAllowed = await resolve(candidate(), { readiness: { layerResults: passingLayerResults() } });
  ok(resAllowed && resAllowed.blocked !== true && typeof resAllowed.suggestion === 'string',
    'resolver: gated + consumable → resolves normally');

  // ---------- 11. Uncertainty resolver: gated + NOT consumable → refuses ----------
  const resBlocked = await resolve(candidate(), { readiness: { layerResults: blockingLayerResults() } });
  ok(resBlocked && resBlocked.blocked === true,
    'resolver: gated + not consumable → refuses instead of resolving');
  ok(resBlocked.agent === 'uncertainty-resolver-agent', 'resolver: refusal names the resolver agent');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
