// ============================================================
// DATAGLOW — AI Readiness Gate test suite (batch 1: pure scoring)
// ============================================================
// Proves computeReadinessGate() is an honest PURE aggregator over the OUTPUT of
// runAllLayers() (never re-running validation) plus an optional metric-contract
// status, and that explainGateReasons() renders that verdict for humans:
//   - all layers passing  -> agentConsumable true, score 100
//   - a single 'fail'     -> failingLayers lists it, gate blocked
//   - multiple failures   -> all listed
//   - empty input         -> well-formed, not consumable, no throw
//   - undefined contract  -> ignored (does not block)
//   - broken contract alone (all layers pass) -> still blocked
//   - explainGateReasons output format
// Also covers the layer-status vocabulary reuse (pass/warn/fail/idle), the
// keyed-object vs array input shapes, and threshold configurability.
//
// RUN WITH: node test/readiness-gate.test.mjs (pure logic, no DuckDB needed)

import {
  computeReadinessGate,
  explainGateReasons,
  DEFAULT_THRESHOLD,
} from '../js/gate/readiness-gate.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Mirror the shape runAllLayers() emits: a keyed object of { status, summary }.
function res(status, summary = '') { return { status, summary, detail: null, ts: 1 }; }

function main() {
  // --- default threshold is a sane, documented value ---
  ok(DEFAULT_THRESHOLD === 70, `default threshold is 70 (got ${DEFAULT_THRESHOLD})`);

  // --- all layers passing -> consumable, score 100 ---
  {
    const layers = {
      sanity_anchor: res('pass', 'both paths agree'),
      unit_tests: res('pass', 'no defects'),
      confidence: res('pass', 'high confidence'),
    };
    const g = computeReadinessGate(layers);
    ok(g.agentConsumable === true, 'all-pass: agentConsumable true');
    ok(g.score === 100, `all-pass: score is 100 (got ${g.score})`);
    ok(g.failingLayers.length === 0, 'all-pass: no failing layers');
    ok(g.threshold === 70, 'all-pass: threshold echoed as default 70');
    ok(g.blockedByContract === false, 'all-pass: not blocked by contract');
    ok(/Ready for agent use/.test(g.passingSummary), 'all-pass: summary says ready');
  }

  // --- a single critical (fail) layer -> blocked, listed ---
  {
    const layers = {
      sanity_anchor: res('pass', 'ok'),
      unit_tests: res('fail', '3 negative value(s) in "claim_amount"'),
      confidence: res('pass', 'ok'),
    };
    const g = computeReadinessGate(layers);
    ok(g.agentConsumable === false, 'single-fail: not consumable');
    ok(g.failingLayers.length === 1, 'single-fail: exactly one failing layer');
    ok(g.failingLayers[0].layer === 'unit_tests', 'single-fail: names the failing layer');
    ok(g.failingLayers[0].severity === 'fail', 'single-fail: severity reuses existing "fail" vocab');
    ok(/claim_amount/.test(g.failingLayers[0].reason), 'single-fail: reason carries the layer summary');
    ok(g.score < 100, `single-fail: score dropped below 100 (got ${g.score})`);
  }

  // --- multiple failures -> all listed ---
  {
    const layers = {
      sanity_anchor: res('fail', 'groups disagree'),
      unit_tests: res('fail', 'negatives found'),
      cross_column_logic: res('fail', 'discharge before admit'),
      confidence: res('warn', 'medium'),
      freshness: res('pass', 'fresh'),
    };
    const g = computeReadinessGate(layers);
    ok(g.failingLayers.length === 3, `multi-fail: lists all three (got ${g.failingLayers.length})`);
    ok(g.agentConsumable === false, 'multi-fail: not consumable');
    const names = g.failingLayers.map((f) => f.layer).sort();
    ok(JSON.stringify(names) === JSON.stringify(['cross_column_logic', 'sanity_anchor', 'unit_tests']),
      'multi-fail: exactly the failing layer ids are reported');
  }

  // --- empty input -> well-formed, not consumable, no throw ---
  {
    let threw = false; let g;
    try { g = computeReadinessGate([]); } catch (_) { threw = true; }
    ok(!threw, 'empty: does not throw');
    ok(g.agentConsumable === false, 'empty: not consumable (no evidence)');
    ok(g.score === 0, `empty: score 0 (got ${g.score})`);
    ok(Array.isArray(g.failingLayers) && g.failingLayers.length === 0, 'empty: failingLayers is an empty array');
    ok(g.evaluatedLayerCount === 0, 'empty: zero evaluated layers');
    ok(typeof g.passingSummary === 'string' && g.passingSummary.length > 0, 'empty: has a passingSummary string');
    // undefined / null layerResults are equally safe
    ok(computeReadinessGate(undefined).agentConsumable === false, 'undefined layerResults: safe, not consumable');
    ok(computeReadinessGate(null).score === 0, 'null layerResults: safe, score 0');
  }

  // --- undefined metric contract status -> ignored, does not block ---
  {
    const layers = { a: res('pass'), b: res('pass') };
    const g = computeReadinessGate(layers, undefined);
    ok(g.agentConsumable === true, 'undefined contract: does not block a clean run');
    ok(g.blockedByContract === false, 'undefined contract: blockedByContract false');
  }

  // --- broken contract ALONE fails the gate, even with all layers passing ---
  {
    const layers = { a: res('pass'), b: res('pass'), c: res('pass') };
    const gOk = computeReadinessGate(layers, { ok: true });
    ok(gOk.agentConsumable === true, 'valid contract + all pass: consumable');

    // recognizes each honest "broken" shape
    for (const [label, status] of [
      ['{ok:false}', { ok: false }],
      ['{valid:false}', { valid: false }],
      ['{broken:true}', { broken: true }],
      ['{status:"invalid"}', { status: 'invalid' }],
      ['{state:"broken"}', { state: 'broken' }],
    ]) {
      const g = computeReadinessGate(layers, status);
      ok(g.agentConsumable === false, `broken contract ${label}: blocks even when all layers pass`);
      ok(g.blockedByContract === true, `broken contract ${label}: blockedByContract true`);
    }
  }

  // --- 'idle' layers are excluded from scoring (carry no evidence) ---
  {
    const layers = {
      narrative_consistency: res('idle', 'write a story first'),
      a: res('pass'),
      b: res('pass'),
    };
    const g = computeReadinessGate(layers);
    ok(g.evaluatedLayerCount === 2, `idle excluded: 2 evaluated (got ${g.evaluatedLayerCount})`);
    ok(g.score === 100, 'idle excluded: score computed only over pass/warn/fail');
  }

  // --- warnings pull the score down without hard-failing ---
  {
    const layers = { a: res('pass'), b: res('warn'), c: res('warn'), d: res('warn') };
    const g = computeReadinessGate(layers); // (1 + 0.5*3)/4 = 0.625 -> 63
    ok(g.score === 63, `warns: half-weighted score is 63 (got ${g.score})`);
    ok(g.failingLayers.length === 0, 'warns: no hard failures');
    ok(g.agentConsumable === false, 'warns: below default threshold -> blocked');
  }

  // --- threshold is configurable via options ---
  {
    const layers = { a: res('pass'), b: res('warn') }; // score 75
    ok(computeReadinessGate(layers, undefined, { threshold: 70 }).agentConsumable === true,
      'threshold 70: score 75 passes');
    ok(computeReadinessGate(layers, undefined, { threshold: 80 }).agentConsumable === false,
      'threshold 80: score 75 blocked');
    ok(computeReadinessGate(layers, undefined, { threshold: 80 }).threshold === 80,
      'threshold: custom value echoed back');
  }

  // --- accepts the flat ARRAY input shape too ---
  {
    const arr = [
      { layer: 'sanity_anchor', status: 'pass', summary: 'ok' },
      { layer: 'unit_tests', status: 'fail', summary: 'negatives' },
    ];
    const g = computeReadinessGate(arr);
    ok(g.failingLayers.length === 1 && g.failingLayers[0].layer === 'unit_tests',
      'array input: normalized and scored like the keyed object');
  }

  // --- non-layer aggregate keys (no string status) are skipped, not mis-scored ---
  {
    const layers = {
      a: res('pass'),
      domainPack: { packName: 'healthcare', annotations: [] },
      calibratedGrades: { overall: { grade: 'B' } },
    };
    const g = computeReadinessGate(layers);
    ok(g.evaluatedLayerCount === 1, `aggregate keys skipped: only 1 real layer (got ${g.evaluatedLayerCount})`);
    ok(g.score === 100, 'aggregate keys skipped: score unaffected');
  }

  // --- explainGateReasons output format ---
  {
    const failing = computeReadinessGate({
      sanity_anchor: res('fail', 'groups disagree'),
      unit_tests: res('fail', 'negatives found'),
    }, { ok: false });
    const text = explainGateReasons(failing);
    ok(text.startsWith('BLOCKED'), 'explain: blocked verdict starts with BLOCKED');
    ok(/Metric contract: invalid\/broken/.test(text), 'explain: names the contract block');
    ok(/sanity_anchor \[fail\]: groups disagree/.test(text), 'explain: lists a failing layer with reason');
    ok(/unit_tests \[fail\]: negatives found/.test(text), 'explain: lists the second failing layer');

    const clean = computeReadinessGate({ a: res('pass'), b: res('pass') });
    const cleanText = explainGateReasons(clean);
    ok(cleanText.startsWith('PASS'), 'explain: clean verdict starts with PASS');
    ok(/No failing layers/.test(cleanText), 'explain: clean verdict states no failing layers');

    ok(explainGateReasons(undefined) === 'No gate result to explain.', 'explain: undefined input handled');

    const warnOnly = computeReadinessGate({ a: res('warn'), b: res('warn') });
    ok(/below threshold/.test(explainGateReasons(warnOnly)),
      'explain: warn-only below-threshold explains the score gap when nothing hard-failed');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
