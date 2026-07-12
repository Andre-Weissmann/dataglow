// ============================================================
// DATAGLOW — Glow Path test suite (Batch A: adaptive next-action rail)
// ============================================================
// Proves the PURE pieces of the Glow Path rail are honest and never throw:
//   - computeGlowPathState(ctx): the 6-priority decision function
//       * empty/malformed ctx → the conservative "load a dataset" default
//       * each of the 6 priority branches in isolation
//       * higher priority wins when multiple conditions are simultaneously true
//       * the save-query nudge is gated on density (low stays quiet; mid/high fires)
//       * the agent-block sub-message uses REAL failing-layer names, never invents one
//       * malformed sub-fields (garbage summary, non-object gate) never throw
//   - buildGlowPathBadgeModel(state): pure view-model (visible flag, tone, detail)
//   - createGlowPathDismissalStore(): per-key in-memory dismissal tracking + reset
//
// RUN WITH: node test/glow-path.test.mjs (pure logic — no DOM/DuckDB/Pyodide/WebR)

import {
  computeGlowPathState,
  CTA_ACTIONS,
  DENSITY_LEVELS,
} from '../js/app-shell/glow-path.js';
import {
  buildGlowPathBadgeModel,
  createGlowPathDismissalStore,
} from '../js/app-shell/glow-path-ui.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A base context that reaches the "everything clean" tail (branch 6) so each test
// can flip exactly one field and isolate the branch it means to exercise.
function cleanCtx(extra = {}) {
  return {
    datasetLoaded: true,
    datasetLoadedAt: 1000,
    hasValidated: true,
    validationSummary: { pass: 20, warn: 0, fail: 0 },
    readinessGateResult: { agentConsumable: true, failingLayers: [] },
    ...extra,
  };
}

function main() {
  // --- exported vocab ---
  ok(JSON.stringify(DENSITY_LEVELS) === JSON.stringify(['low', 'mid', 'high']),
    'DENSITY_LEVELS is exactly low/mid/high');
  ok(CTA_ACTIONS.RUN_VALIDATE === 'run-validate' && CTA_ACTIONS.NONE === 'none',
    'CTA_ACTIONS carries the documented symbolic ids');

  // --- empty / malformed ctx → conservative no-dataset default ---
  {
    const s = computeGlowPathState({});
    ok(s.ctaAction === CTA_ACTIONS.LOAD_DATA, 'empty ctx → load-data (most conservative)');
    ok(typeof s.message === 'string' && s.message.length > 0, 'empty ctx still yields a message');
    ok(s.dismissed === false, 'pure function never reports dismissed:true');
    ok(s.densityLevel === 'low', 'missing densityLevel defaults to low');
  }
  ok(computeGlowPathState(undefined).ctaAction === CTA_ACTIONS.LOAD_DATA, 'undefined ctx → load-data, no throw');
  ok(computeGlowPathState(null).ctaAction === CTA_ACTIONS.LOAD_DATA, 'null ctx → load-data, no throw');
  ok(computeGlowPathState(42).ctaAction === CTA_ACTIONS.LOAD_DATA, 'non-object ctx → load-data, no throw');

  // --- (1) no dataset loaded ---
  {
    const s = computeGlowPathState({ datasetLoaded: false, hasValidated: true, validationSummary: { warn: 5 } });
    ok(s.ctaAction === CTA_ACTIONS.LOAD_DATA, 'branch 1: no dataset beats everything else');
    ok(s.ctaLabel === 'Load data', 'branch 1: CTA label is Load data');
  }

  // --- (2) loaded but never validated ---
  {
    const s = computeGlowPathState({ datasetLoaded: true, hasValidated: false });
    ok(s.ctaAction === CTA_ACTIONS.RUN_VALIDATE, 'branch 2: loaded but unvalidated → run-validate');
    ok(/Validate/.test(s.message), 'branch 2: message mentions Validate');
  }

  // --- (3) real gate result says not agent-consumable ---
  {
    const s = computeGlowPathState(cleanCtx({
      readinessGateResult: {
        agentConsumable: false,
        failingLayers: [
          { layer: 'Physiological Plausibility', severity: 'fail', reason: 'x' },
          { layer: 'Missingness Detective', severity: 'fail', reason: 'y' },
        ],
      },
    }));
    ok(s.ctaAction === CTA_ACTIONS.SEE_FAILING_LAYERS, 'branch 3: not-consumable gate → see-failing-layers');
    ok(s.subMessage.includes('Physiological Plausibility') && s.subMessage.includes('Missingness Detective'),
      'branch 3: sub-message names the REAL failing layers (never fabricated)');
    ok(/only the AI-agent path is paused/i.test(s.subMessage),
      'branch 3: honors humans-still-see-everything framing');
  }
  {
    // >2 failing layers → truncates with a "+N more", still no fabrication
    const s = computeGlowPathState(cleanCtx({
      readinessGateResult: {
        agentConsumable: false,
        failingLayers: [
          { layer: 'A' }, { layer: 'B' }, { layer: 'C' }, { layer: 'D' },
        ],
      },
    }));
    ok(s.subMessage.includes('A and B') && s.subMessage.includes('+2 more'),
      'branch 3: many failing layers summarized as "A and B (+2 more)"');
  }
  {
    // blocked purely by contract, no named layers → generic honest reason
    const s = computeGlowPathState(cleanCtx({
      readinessGateResult: { agentConsumable: false, blockedByContract: true, failingLayers: [] },
    }));
    ok(s.ctaAction === CTA_ACTIONS.SEE_FAILING_LAYERS, 'branch 3: contract-block still → see-failing-layers');
    ok(/metric contract/i.test(s.subMessage), 'branch 3: contract block explained without inventing a layer');
  }
  {
    // not consumable, no named layers, no contract → below-threshold generic reason
    const s = computeGlowPathState(cleanCtx({
      readinessGateResult: { agentConsumable: false, failingLayers: [] },
    }));
    ok(/threshold/i.test(s.subMessage), 'branch 3: score-below-threshold explained generically, no invented layer');
  }

  // --- (4) validation warnings ---
  {
    const s = computeGlowPathState(cleanCtx({ validationSummary: { pass: 18, warn: 2, fail: 0 } }));
    ok(s.ctaAction === CTA_ACTIONS.REVIEW_WARNINGS, 'branch 4: warn>0 → review-warnings');
    ok(/2 warnings/.test(s.message), 'branch 4: message pluralizes count (2 warnings)');
  }
  {
    const s = computeGlowPathState(cleanCtx({ validationSummary: { pass: 19, warn: 1, fail: 0 } }));
    ok(/1 warning\b/.test(s.message), 'branch 4: single warning is singular (1 warning)');
  }

  // --- (5) clean + repeated query, gated on density ---
  {
    const low = computeGlowPathState(cleanCtx({ lastQueryRepeatCount: 5, densityLevel: 'low' }));
    ok(low.ctaAction === CTA_ACTIONS.NONE && low.message === null,
      'branch 5: at LOW density a repeated query stays quiet (no nudge)');
    const mid = computeGlowPathState(cleanCtx({ lastQueryRepeatCount: 5, densityLevel: 'mid' }));
    ok(mid.ctaAction === CTA_ACTIONS.SAVE_QUERY, 'branch 5: at MID density → save-query');
    const high = computeGlowPathState(cleanCtx({ lastQueryRepeatCount: 3, densityLevel: 'high' }));
    ok(high.ctaAction === CTA_ACTIONS.SAVE_QUERY, 'branch 5: at HIGH density with exactly 3 repeats → save-query');
    const two = computeGlowPathState(cleanCtx({ lastQueryRepeatCount: 2, densityLevel: 'high' }));
    ok(two.ctaAction === CTA_ACTIONS.NONE, 'branch 5: fewer than 3 repeats does not trigger the nudge');
  }

  // --- (6) nothing actionable → neutral empty ---
  {
    const s = computeGlowPathState(cleanCtx());
    ok(s.message === null && s.ctaAction === CTA_ACTIONS.NONE, 'branch 6: everything clean → neutral empty state');
    ok(s.subMessage === null && s.ctaLabel === null, 'branch 6: neutral state carries no sub/label');
  }

  // --- priority: higher branch wins when several conditions hold at once ---
  {
    // unvalidated AND warnings present AND gate not consumable → branch 2 wins
    const s = computeGlowPathState({
      datasetLoaded: true,
      hasValidated: false,
      validationSummary: { warn: 3 },
      readinessGateResult: { agentConsumable: false, failingLayers: [{ layer: 'X' }] },
    });
    ok(s.ctaAction === CTA_ACTIONS.RUN_VALIDATE, 'priority: unvalidated (2) beats warnings (4) and gate-block (3)');
  }
  {
    // no dataset AND unvalidated → branch 1 wins over branch 2
    const s = computeGlowPathState({ datasetLoaded: false, hasValidated: false });
    ok(s.ctaAction === CTA_ACTIONS.LOAD_DATA, 'priority: no-dataset (1) beats unvalidated (2)');
  }
  {
    // gate-block AND warnings → branch 3 (gate) wins over branch 4 (warnings)
    const s = computeGlowPathState(cleanCtx({
      validationSummary: { pass: 10, warn: 4, fail: 2 },
      readinessGateResult: { agentConsumable: false, failingLayers: [{ layer: 'Y' }] },
    }));
    ok(s.ctaAction === CTA_ACTIONS.SEE_FAILING_LAYERS, 'priority: gate-block (3) beats warnings (4)');
  }
  {
    // warnings AND repeated-query at high density → branch 4 (warnings) wins over 5
    const s = computeGlowPathState(cleanCtx({
      validationSummary: { pass: 10, warn: 1, fail: 0 },
      lastQueryRepeatCount: 9,
      densityLevel: 'high',
    }));
    ok(s.ctaAction === CTA_ACTIONS.REVIEW_WARNINGS, 'priority: warnings (4) beats save-query (5)');
  }

  // --- gate present but consumable=true is NOT a block (falls through) ---
  {
    const s = computeGlowPathState(cleanCtx({ readinessGateResult: { agentConsumable: true, failingLayers: [] } }));
    ok(s.ctaAction === CTA_ACTIONS.NONE, 'a consumable gate result does not trigger branch 3');
  }

  // --- malformed fields never throw ---
  {
    ok(computeGlowPathState(cleanCtx({ validationSummary: 'garbage' })).ctaAction === CTA_ACTIONS.NONE,
      'garbage validationSummary is treated as zero counts, no throw');
    ok(computeGlowPathState(cleanCtx({ validationSummary: { warn: 'NaN' } })).ctaAction === CTA_ACTIONS.NONE,
      'non-numeric warn count is ignored (0), no throw');
    ok(computeGlowPathState(cleanCtx({ validationSummary: { warn: -3 } })).ctaAction === CTA_ACTIONS.NONE,
      'negative warn count is clamped to 0, no throw');
    ok(computeGlowPathState(cleanCtx({ readinessGateResult: 'nope' })).ctaAction === CTA_ACTIONS.NONE,
      'non-object gate result is ignored, no throw');
    ok(computeGlowPathState(cleanCtx({ readinessGateResult: { agentConsumable: false, failingLayers: 'bad' } })).ctaAction === CTA_ACTIONS.SEE_FAILING_LAYERS,
      'gate not-consumable with malformed failingLayers still blocks and does not throw');
    ok(computeGlowPathState(cleanCtx({ densityLevel: 'ultra' })).densityLevel === 'low',
      'unknown densityLevel falls back to low');
  }

  // --- buildGlowPathBadgeModel: pure view-model ---
  {
    const m = buildGlowPathBadgeModel(computeGlowPathState({}));
    ok(m.visible === true, 'view-model: a message-bearing state is visible');
    ok(m.tone === 'primary', 'view-model: load-data uses the primary tone');
    ok(m.showDetail === false, 'view-model: low density hides the detail row');
  }
  {
    const m = buildGlowPathBadgeModel(computeGlowPathState(cleanCtx()));
    ok(m.visible === false, 'view-model: a null-message (neutral) state is NOT visible');
  }
  {
    const blocked = buildGlowPathBadgeModel(computeGlowPathState(cleanCtx({
      readinessGateResult: { agentConsumable: false, failingLayers: [{ layer: 'Z' }] },
    })));
    ok(blocked.tone === 'blocked', 'view-model: a failing-layers state uses the blocked tone');
  }
  {
    const dense = buildGlowPathBadgeModel({ message: 'x', ctaAction: 'run-validate', densityLevel: 'high' });
    ok(dense.showDetail === true, 'view-model: high density shows the detail row');
  }
  ok(buildGlowPathBadgeModel(null).visible === false, 'view-model: null input → not visible, no throw');
  ok(buildGlowPathBadgeModel({}).visible === false, 'view-model: empty input → not visible, no throw');

  // --- createGlowPathDismissalStore: per-key in-memory tracking ---
  {
    const store = createGlowPathDismissalStore();
    ok(store.isDismissed('sales') === false, 'dismissal: unknown key starts not-dismissed');
    store.markDismissed('sales');
    ok(store.isDismissed('sales') === true, 'dismissal: markDismissed records the key');
    ok(store.isDismissed('orders') === false, 'dismissal: keys are independent (orders untouched)');
    store.markDismissed('');
    ok(store.isDismissed('') === false, 'dismissal: empty key is ignored (never dismissed)');
    store.reset('sales');
    ok(store.isDismissed('sales') === false, 'dismissal: reset(key) clears just that key');
    store.markDismissed('a'); store.markDismissed('b');
    store.reset();
    ok(store.isDismissed('a') === false && store.isDismissed('b') === false, 'dismissal: reset() with no arg clears everything');
    ok(store.isDismissed(null) === false && store.isDismissed(undefined) === false, 'dismissal: null/undefined key → false, no throw');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
