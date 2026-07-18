// ============================================================
// DATAGLOW — Rigor Engine Batch 3: statisticalConfidence reason code tests
// ============================================================
// Proves that evaluateStatisticalConfidence, buildStatConfidenceRefusal, and
// the updated evaluateAgentReadiness all behave correctly:
//   - 'insufficient' verdict hard-blocks the agent
//   - 'low' verdict is advisory only (non-blocking)
//   - 'sufficient' verdict is transparent (non-blocking, no advisory)
//   - existing evaluateAgentReadiness behavior is unchanged when no rigorResult
//   - the statistical check runs BEFORE the layer-results gate
//   - buildStatConfidenceRefusal produces the correct shape
//
// Pure JS — no DuckDB, DOM, or network.
// RUN WITH:  node test/agent-gate-stat-confidence.test.mjs

import {
  evaluateAgentReadiness,
  buildAgentRefusal,
  evaluateStatisticalConfidence,
  buildStatConfidenceRefusal,
} from '../js/gate/agent-gate.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 FAILED: ' + msg); }
}
function eq(a, b, msg) {
  ok(a === b, (msg || '') + ' (expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')');
}

function passingLayers() {
  return {
    schema: { status: 'pass', summary: 'ok' },
    ranges: { status: 'pass', summary: 'ok' },
    missing: { status: 'pass', summary: 'ok' },
  };
}
function blockingLayers() {
  return {
    schema: { status: 'pass', summary: 'ok' },
    ranges: { status: 'fail', summary: 'discount_pct > 100%' },
  };
}

// ============================================================
// evaluateStatisticalConfidence
// ============================================================

console.log('\nevaluateStatisticalConfidence');

ok(evaluateStatisticalConfidence(null) === null, 'null => null (backward compat)');
ok(evaluateStatisticalConfidence(undefined) === null, 'undefined => null (backward compat)');
ok(evaluateStatisticalConfidence('string') === null, 'non-object => null');
ok(evaluateStatisticalConfidence(42) === null, 'number => null');

const insufficientRigor = { verdict: 'insufficient', n: 5, reason: 'Only 5 observations.' };
const lowRigor = { verdict: 'low', n: 18, reason: 'n=18 is below n=30 threshold.' };
const sufficientRigor = { verdict: 'sufficient', n: 45, reason: 'n=45 meets threshold.' };

const evalInsufficient = evaluateStatisticalConfidence(insufficientRigor);
ok(evalInsufficient !== null, 'insufficient: returns object');
ok(evalInsufficient.blocked === true, 'insufficient: blocked=true');
eq(evalInsufficient.verdict, 'insufficient', 'insufficient: verdict passthrough');
ok(typeof evalInsufficient.reason === 'string' && evalInsufficient.reason.length > 0, 'insufficient: reason non-empty');

const evalLow = evaluateStatisticalConfidence(lowRigor);
ok(evalLow !== null, 'low: returns object');
ok(evalLow.blocked === false, 'low: blocked=false (advisory, not a hard block)');
eq(evalLow.verdict, 'low', 'low: verdict passthrough');
ok(typeof evalLow.reason === 'string' && evalLow.reason.length > 0, 'low: reason non-empty');

const evalSufficient = evaluateStatisticalConfidence(sufficientRigor);
ok(evalSufficient !== null, 'sufficient: returns object');
ok(evalSufficient.blocked === false, 'sufficient: blocked=false');
eq(evalSufficient.verdict, 'sufficient', 'sufficient: verdict passthrough');

// summarizeGroupedConfidence shape (worstN instead of n)
const groupedInsufficient = { verdict: 'insufficient', worstN: 3, groupCount: 4, reason: 'Weakest of 4 groups: Only 3 observations.' };
const evalGrouped = evaluateStatisticalConfidence(groupedInsufficient);
ok(evalGrouped.blocked === true, 'grouped insufficient: blocked=true');
ok(evalGrouped.reason.length > 0, 'grouped insufficient: reason forwarded');

// unknown/empty verdict treated as non-blocking
const evalUnknown = evaluateStatisticalConfidence({ verdict: 'unknown' });
ok(evalUnknown.blocked === false, 'unknown verdict: non-blocking (safe default)');

// ============================================================
// buildStatConfidenceRefusal
// ============================================================

console.log('\nbuildStatConfidenceRefusal');

const refusal = buildStatConfidenceRefusal('question-generator', evalInsufficient);
ok(refusal.blocked === true, 'refusal.blocked=true');
eq(refusal.reasonCode, 'statisticalConfidence', 'refusal.reasonCode=statisticalConfidence');
ok(typeof refusal.reasons === 'string' && refusal.reasons.includes('statisticalConfidence'), 'reasons includes reasonCode');
ok(typeof refusal.message === 'string' && refusal.message.includes('question-generator'), 'message cites agent name');
eq(refusal.agent, 'question-generator', 'refusal.agent correct');
eq(refusal.verdict, 'insufficient', 'refusal.verdict passthrough');

const refusalDefaultAgent = buildStatConfidenceRefusal(null, evalInsufficient);
ok(typeof refusalDefaultAgent.agent === 'string' && refusalDefaultAgent.agent.length > 0, 'null agent: falls back to default string');

// ============================================================
// evaluateAgentReadiness — backward compat (no rigorResult)
// ============================================================

console.log('\nevaluateAgentReadiness — backward compat');

const noCtx = evaluateAgentReadiness(null);
ok(noCtx.blocked === false, 'null context: not blocked');
ok(noCtx.gate === null, 'null context: gate=null');

const noCtxUndef = evaluateAgentReadiness(undefined);
ok(noCtxUndef.blocked === false, 'undefined context: not blocked');

const passingNoRigor = evaluateAgentReadiness({ layerResults: passingLayers() });
ok(passingNoRigor.blocked === false, 'passing layers, no rigorResult: not blocked');
ok(!passingNoRigor.statisticalConfidenceAdvisory, 'no rigorResult: no advisory field');

const blockingNoRigor = evaluateAgentReadiness({ layerResults: blockingLayers() });
ok(blockingNoRigor.blocked === true, 'blocking layers, no rigorResult: blocked');
ok(blockingNoRigor.reasonCode !== 'statisticalConfidence', 'blocking layers: reasonCode is NOT statisticalConfidence');

// ============================================================
// evaluateAgentReadiness — with rigorResult: 'insufficient'
// ============================================================

console.log('\nevaluateAgentReadiness — insufficient rigorResult');

// Insufficient with passing layers: stat confidence gate fires FIRST
const insuffWithPass = evaluateAgentReadiness({ layerResults: passingLayers(), rigorResult: insufficientRigor });
ok(insuffWithPass.blocked === true, 'insufficient rigor + passing layers: blocked');
eq(insuffWithPass.reasonCode, 'statisticalConfidence', 'insufficient rigor: reasonCode=statisticalConfidence');
ok(insuffWithPass.gate === null, 'insufficient rigor: gate=null (layer gate never runs)');
ok(typeof insuffWithPass.message === 'string' && insuffWithPass.message.includes('statisticalConfidence'), 'message cites reasonCode');

// Insufficient with ALSO blocking layers: stat confidence still fires first
const insuffWithBlock = evaluateAgentReadiness({ layerResults: blockingLayers(), rigorResult: insufficientRigor });
ok(insuffWithBlock.blocked === true, 'insufficient rigor + blocking layers: blocked');
eq(insuffWithBlock.reasonCode, 'statisticalConfidence', 'stat gate runs first even with blocking layers');

// Grouped insufficient
const groupedCtx = evaluateAgentReadiness({ layerResults: passingLayers(), rigorResult: groupedInsufficient });
ok(groupedCtx.blocked === true, 'grouped insufficient: blocked');
eq(groupedCtx.reasonCode, 'statisticalConfidence', 'grouped: reasonCode=statisticalConfidence');

// ============================================================
// evaluateAgentReadiness — with rigorResult: 'low' (advisory)
// ============================================================

console.log('\nevaluateAgentReadiness — low rigorResult (advisory)');

const lowWithPass = evaluateAgentReadiness({ layerResults: passingLayers(), rigorResult: lowRigor });
ok(lowWithPass.blocked === false, 'low rigor + passing layers: NOT blocked');
ok(typeof lowWithPass.statisticalConfidenceAdvisory === 'string', 'low rigor: advisory field present');
ok(lowWithPass.statisticalConfidenceAdvisory.length > 0, 'advisory non-empty');

// Low with blocking layers: layer gate still fires
const lowWithBlock = evaluateAgentReadiness({ layerResults: blockingLayers(), rigorResult: lowRigor });
ok(lowWithBlock.blocked === true, 'low rigor + blocking layers: blocked by layer gate');
ok(lowWithBlock.reasonCode !== 'statisticalConfidence', 'low rigor + blocking: NOT a stat confidence block');

// ============================================================
// evaluateAgentReadiness — with rigorResult: 'sufficient'
// ============================================================

console.log('\nevaluateAgentReadiness — sufficient rigorResult');

const suffWithPass = evaluateAgentReadiness({ layerResults: passingLayers(), rigorResult: sufficientRigor });
ok(suffWithPass.blocked === false, 'sufficient rigor + passing layers: not blocked');
ok(!suffWithPass.statisticalConfidenceAdvisory, 'sufficient: no advisory field');

const suffWithBlock = evaluateAgentReadiness({ layerResults: blockingLayers(), rigorResult: sufficientRigor });
ok(suffWithBlock.blocked === true, 'sufficient rigor + blocking layers: still blocked by layer gate');

// ============================================================
// Summary
// ============================================================

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
