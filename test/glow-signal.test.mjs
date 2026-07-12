// ============================================================
// DATAGLOW — The Glow signal aggregator test suite (batch 1: pure compose)
// ============================================================
// Proves computeGlowSignal() is an honest PURE aggregator over the OUTPUT of the
// four existing modules — the AI Readiness Gate (computeReadinessGate), the Trust
// Strip (collectTrustSignals), Golden Signals (computeGoldenSignals), and the CAT
// Scorecard (computeCATScore) — never re-running any of them, inventing no new
// score, and fabricating no signal, and that explainGlowSignal() renders that
// verdict for humans:
//   - no input            -> idle, score 0, no signals, no throw
//   - gate consumable      -> status ok, score == gate score
//   - gate not consumable  -> status bad, nextAction names the REAL failing layer
//   - trust 'bad' field, no gate -> status bad
//   - trust 'warn' only, no gate -> status warn
//   - CAT + Golden folded into signals[] when present
//   - explainGlowSignal output format (passing + blocked)
//
// RUN WITH: node test/glow-signal.test.mjs (pure logic, no DuckDB needed)

import {
  computeGlowSignal,
  explainGlowSignal,
  GLOW_STATUS,
} from '../js/glow/glow-signal.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Mirror the real shapes the four source modules emit.
function gate(overrides = {}) {
  return {
    agentConsumable: true,
    score: 100,
    threshold: 70,
    failingLayers: [],
    passingSummary: 'Ready for agent use — score 100/100 (≥ 70).',
    blockedByContract: false,
    evaluatedLayerCount: 3,
    ...overrides,
  };
}
function trustField(key, state, value = 'v', label = key) {
  return { key, label, value, state, detail: `${label} detail` };
}

function main() {
  // --- the exported status vocabulary is the shared trust-strip set ---
  ok(GLOW_STATUS.OK === 'ok' && GLOW_STATUS.BAD === 'bad' && GLOW_STATUS.IDLE === 'idle',
    'status vocabulary reuses ok/warn/bad/idle');

  // --- no input -> idle, well-formed, no throw ---
  {
    let threw = false; let g;
    try { g = computeGlowSignal(); } catch (_) { threw = true; }
    ok(!threw, 'no input: does not throw');
    ok(g.status === 'idle', `no input: status idle (got ${g && g.status})`);
    ok(g.score === 0, `no input: score 0 (got ${g && g.score})`);
    ok(Array.isArray(g.signals) && g.signals.length === 0, 'no input: signals is an empty array');
    ok(g.nextAction === null, 'no input: nextAction null');
    ok(typeof g.summary === 'string' && g.summary.length > 0, 'no input: has a summary string');
    // undefined / null / junk are equally safe
    ok(computeGlowSignal(null).status === 'idle', 'null input: safe, idle');
    ok(computeGlowSignal(42).status === 'idle', 'non-object input: safe, idle');
  }

  // --- gate present + agentConsumable true -> status ok, score matches gate ---
  {
    const g = computeGlowSignal({ readinessGateResult: gate({ score: 88 }) });
    ok(g.status === 'ok', `gate ok: status ok (got ${g.status})`);
    ok(g.score === 88, `gate ok: score matches gate score 88 (got ${g.score})`);
    ok(g.nextAction === null, 'gate ok: no nextAction when consumable');
    ok(/agent-ready/.test(g.summary), 'gate ok: summary says agent-ready');
  }

  // --- gate present + not consumable with failingLayers -> bad, real nextAction ---
  {
    const g = computeGlowSignal({
      readinessGateResult: gate({
        agentConsumable: false,
        score: 40,
        failingLayers: [
          { layer: 'unit_tests', severity: 'fail', reason: '3 negatives in "claim_amount"' },
        ],
        evaluatedLayerCount: 3,
        passingSummary: 'Blocked from agent use — 1 layer(s) hard-failed.',
      }),
    });
    ok(g.status === 'bad', `gate blocked: status bad (got ${g.status})`);
    ok(g.score === 40, `gate blocked: score matches gate score 40 (got ${g.score})`);
    ok(g.nextAction && typeof g.nextAction === 'object', 'gate blocked: nextAction built');
    ok(/unit_tests/.test(g.nextAction.detail), 'gate blocked: nextAction names the REAL failing layer');
    ok(g.nextAction.label === 'See failing layers', 'gate blocked: honest CTA label');
  }

  // --- gate not consumable, blocked by contract, NO named layers -> no fabricated layer ---
  {
    const g = computeGlowSignal({
      readinessGateResult: gate({
        agentConsumable: false, score: 100, failingLayers: [], blockedByContract: true,
      }),
    });
    ok(g.status === 'bad', 'contract block: status bad');
    ok(g.nextAction && /contract/.test(g.nextAction.detail), 'contract block: nextAction cites the contract, not a fake layer');
    // never fabricate a layer name that was not provided
    ok(!/unit_tests|sanity_anchor|undefined/.test(g.nextAction.detail),
      'contract block: no fabricated layer name in nextAction');
  }

  // --- gate not consumable purely on score (no fails, no contract) -> warn ---
  {
    const g = computeGlowSignal({
      readinessGateResult: gate({
        agentConsumable: false, score: 63, failingLayers: [], blockedByContract: false,
        evaluatedLayerCount: 4, passingSummary: 'Blocked from agent use — score 63/100 is below the 70 threshold.',
      }),
    });
    ok(g.status === 'warn', `score-only block: softer warn status (got ${g.status})`);
    ok(g.nextAction && g.nextAction.label === 'Raise the readiness score', 'score-only block: honest raise-score CTA');
  }

  // --- gate that evaluated nothing -> idle ---
  {
    const g = computeGlowSignal({
      readinessGateResult: gate({ agentConsumable: false, score: 0, evaluatedLayerCount: 0 }),
    });
    ok(g.status === 'idle', `empty gate: status idle (got ${g.status})`);
  }

  // --- trustSignals with a 'bad' field and NO gate -> status bad ---
  {
    const g = computeGlowSignal({
      trustSignals: {
        loaded: true,
        fields: [
          trustField('freshness', 'ok', '2m ago'),
          trustField('validation', 'bad', '1 pass · 0 warn · 2 fail'),
          trustField('anomaly', 'warn', '2 flagged'),
        ],
      },
    });
    ok(g.status === 'bad', `trust bad: worst-wins to bad (got ${g.status})`);
    ok(g.score === 0, 'trust bad: no gate -> no invented score (0)');
    ok(g.signals.length === 3, `trust bad: all 3 fields folded into signals (got ${g.signals.length})`);
    ok(g.signals.every((s) => s.source === 'trustStrip'), 'trust bad: signals tagged source trustStrip');
    ok(g.nextAction === null, 'trust bad: no nextAction without a gate result');
  }

  // --- trustSignals with only 'warn' fields, no gate -> status warn ---
  {
    const g = computeGlowSignal({
      trustSignals: {
        loaded: true,
        fields: [trustField('anomaly', 'warn', '1 flagged'), trustField('certification', 'warn', '0 certified')],
      },
    });
    ok(g.status === 'warn', `trust warn: warn wins over ok/idle (got ${g.status})`);
  }

  // --- trustSignals all ok -> ok; all idle -> idle ---
  {
    const allOk = computeGlowSignal({ trustSignals: { loaded: true, fields: [trustField('freshness', 'ok'), trustField('lineage', 'ok')] } });
    ok(allOk.status === 'ok', 'trust ok: all-ok folds to ok');
    const allIdle = computeGlowSignal({ trustSignals: { loaded: false, fields: [trustField('freshness', 'idle'), trustField('validation', 'idle')] } });
    ok(allIdle.status === 'idle', 'trust idle: all-idle folds to idle');
  }

  // --- CAT scorecard + Golden signals get folded into signals[] when present ---
  {
    const g = computeGlowSignal({
      trustSignals: { loaded: true, fields: [trustField('freshness', 'ok', 'now')] },
      catScorecard: {
        completeness: { score: 0.95, grade: 'A' },
        accuracy: { score: 0.8, grade: 'B' },
        timeliness: { score: 1, grade: 'A' },
        overall: { score: 0.917, grade: 'A' },
      },
      goldenSignals: { missingnessRate: 0.02, outOfRangeRate: 0, duplicateRate: 0.01, freshnessHours: 3.5 },
    });
    const cat = g.signals.find((s) => s.source === 'catScorecard');
    const golden = g.signals.find((s) => s.source === 'goldenSignals');
    ok(!!cat, 'fold: catScorecard produces a signal entry');
    ok(/A/.test(cat.value) && cat.state === 'ok', 'fold: CAT overall grade A -> ok, value carries the grade');
    ok(!!golden, 'fold: goldenSignals produces a signal entry');
    ok(/missing 0\.02/.test(golden.value), 'fold: golden signal value carries the REAL missingness rate');
    ok(g.signals.length === 3, `fold: trust(1) + cat(1) + golden(1) = 3 signals (got ${g.signals.length})`);
  }

  // --- CAT grade F folds to a bad-state signal; C/D to warn ---
  {
    const gF = computeGlowSignal({ catScorecard: { overall: { score: 0.4, grade: 'F' } } });
    ok(gF.signals[0].state === 'bad', 'CAT grade F -> bad state signal');
    const gC = computeGlowSignal({ catScorecard: { overall: { score: 0.72, grade: 'C' } } });
    ok(gC.signals[0].state === 'warn', 'CAT grade C -> warn state signal');
  }

  // --- gate is authoritative even when trust signals disagree ---
  {
    const g = computeGlowSignal({
      readinessGateResult: gate({ agentConsumable: true, score: 91 }),
      trustSignals: { loaded: true, fields: [trustField('validation', 'bad', 'fails')] },
    });
    ok(g.status === 'ok' && g.score === 91,
      'compose-not-recompute: gate score/consumability dominates over trust-strip states');
    ok(g.signals.some((s) => s.state === 'bad'),
      'compose-not-recompute: the bad trust field is still surfaced honestly in signals[]');
  }

  // --- explainGlowSignal output format (blocked + passing) ---
  {
    const blocked = computeGlowSignal({
      readinessGateResult: gate({
        agentConsumable: false, score: 30,
        failingLayers: [{ layer: 'cross_column_logic', severity: 'fail', reason: 'discharge before admit' }],
      }),
      trustSignals: { loaded: true, fields: [trustField('validation', 'bad', '0 pass · 0 warn · 2 fail')] },
    });
    const bt = explainGlowSignal(blocked);
    ok(bt.startsWith('ALERT'), 'explain: bad verdict starts with ALERT');
    ok(/status bad \(score 30\/100\)/.test(bt), 'explain: names status and score');
    ok(/\[trustStrip\] validation \[bad\]/.test(bt), 'explain: lists a trust-strip signal with state');
    ok(/Next action: See failing layers/.test(bt), 'explain: renders the nextAction line');
    ok(/cross_column_logic/.test(bt), 'explain: nextAction names the real failing layer');

    const passing = computeGlowSignal({ readinessGateResult: gate({ score: 100 }) });
    const pt = explainGlowSignal(passing);
    ok(pt.startsWith('GLOWING'), 'explain: ok verdict starts with GLOWING');
    ok(!/Next action:/.test(pt), 'explain: no nextAction line when agent-ready');

    ok(explainGlowSignal(undefined) === 'No glow result to explain.', 'explain: undefined input handled');

    const idle = computeGlowSignal();
    ok(/IDLE/.test(explainGlowSignal(idle)) && /No signals composed/.test(explainGlowSignal(idle)),
      'explain: idle verdict states no signals composed');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
