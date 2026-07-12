// ============================================================
// DATAGLOW — AI Readiness Gate UI badge test suite (batch 2 of 4)
// ============================================================
// Proves the PURE badge model builder (buildReadinessBadgeModel) turns a batch-1
// gate verdict into the right label / tone / score / reasons — without any DOM.
// The DOM presenter (renderReadinessBadge) is intentionally thin and left to the
// browser/e2e path; every label-selection and formatting decision that matters
// lives in the pure builder tested here.
//
//   - all layers passing        -> green "Agent-ready", score echoed
//   - a hard-failing layer       -> red "Not agent-ready" (blocked-hard)
//   - broken contract alone       -> red "Not agent-ready" (blocked-hard)
//   - warnings-only below thresh  -> amber "Not agent-ready" (blocked-soft)
//   - no validation evidence yet  -> neutral "Readiness not evaluated" (idle),
//                                    NOT a red failure
//   - null/undefined verdict      -> safe idle model, no throw
//   - reasons text comes from explainGateReasons()
//   - flag-off regression guard: aiReadinessGateBadge ships OFF
//
// Pure JS — no DuckDB, no DOM. RUN WITH:
//   node test/readiness-gate-ui.test.mjs

import { computeReadinessGate, explainGateReasons } from '../js/gate/readiness-gate.js';
import { buildReadinessBadgeModel } from '../js/gate/readiness-gate-ui.js';
import { configureFlags, isEnabled } from '../js/build/build-flags.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Mirror the shape runAllLayers() emits: a keyed object of { status, summary }.
function res(status, summary = '') { return { status, summary, detail: null, ts: 1 }; }

function main() {
  // --- all layers passing -> green "Agent-ready" ---
  {
    const gate = computeReadinessGate({ a: res('pass'), b: res('pass'), c: res('pass') });
    const m = buildReadinessBadgeModel(gate);
    ok(m.status === 'ready', 'all-pass: status ready');
    ok(m.tone === 'ready', 'all-pass: tone ready (green)');
    ok(m.badgeClass === 'badge badge-a', 'all-pass: reuses the green badge-a pill class');
    ok(m.label === 'Agent-ready', 'all-pass: label "Agent-ready"');
    ok(m.score === 100 && m.scoreText === '100/100', 'all-pass: score echoed as 100/100');
    ok(m.consumable === true, 'all-pass: consumable true');
  }

  // --- a hard-failing layer -> red "Not agent-ready" ---
  {
    const gate = computeReadinessGate({ a: res('pass'), b: res('fail', 'negatives found') });
    const m = buildReadinessBadgeModel(gate);
    ok(m.status === 'blocked', 'hard-fail: status blocked');
    ok(m.tone === 'blocked-hard', 'hard-fail: tone blocked-hard (red)');
    ok(m.badgeClass === 'badge badge-d', 'hard-fail: reuses the red badge-d pill class');
    ok(m.label === 'Not agent-ready', 'hard-fail: label "Not agent-ready"');
    ok(/negatives found/.test(m.reasons), 'hard-fail: reasons carry the failing layer summary');
  }

  // --- broken metric contract ALONE (all layers pass) -> red blocked-hard ---
  {
    const gate = computeReadinessGate({ a: res('pass'), b: res('pass') }, { ok: false });
    const m = buildReadinessBadgeModel(gate);
    ok(m.status === 'blocked' && m.tone === 'blocked-hard', 'broken-contract: red blocked-hard even with all layers passing');
    ok(/contract/i.test(m.reasons), 'broken-contract: reasons name the contract block');
  }

  // --- warnings-only, below threshold -> amber blocked-soft (no hard fail) ---
  {
    const gate = computeReadinessGate({ a: res('pass'), b: res('warn'), c: res('warn'), d: res('warn') }); // score 63
    const m = buildReadinessBadgeModel(gate);
    ok(m.status === 'blocked', 'warn-only: status blocked (below threshold)');
    ok(m.tone === 'blocked-soft', 'warn-only: tone blocked-soft (amber), not red');
    ok(m.badgeClass === 'badge badge-c', 'warn-only: reuses the amber badge-c pill class');
    ok(m.label === 'Not agent-ready', 'warn-only: label "Not agent-ready"');
    ok(m.score === 63, 'warn-only: score reflects the half-weighted warns');
  }

  // --- no validation evidence yet -> honest neutral "not evaluated", NOT red ---
  {
    const gate = computeReadinessGate([]); // nothing scored
    const m = buildReadinessBadgeModel(gate);
    ok(m.status === 'idle', 'no-evidence: status idle');
    ok(m.tone === 'idle', 'no-evidence: tone idle (neutral), never a red failure');
    ok(m.badgeClass === 'badge', 'no-evidence: neutral plain badge (no grade color)');
    ok(m.label === 'Readiness not evaluated', 'no-evidence: honest "not evaluated" label');
    ok(m.score === null && m.scoreText === '—', 'no-evidence: no score shown (— placeholder)');
    ok(m.consumable === false, 'no-evidence: not consumable');
  }

  // --- null / undefined verdict -> safe idle model, no throw ---
  {
    let threw = false; let m;
    try { m = buildReadinessBadgeModel(undefined); } catch (_) { threw = true; }
    ok(!threw, 'undefined verdict: does not throw');
    ok(m.status === 'idle' && m.label === 'Readiness not evaluated', 'undefined verdict: safe idle model');
    ok(buildReadinessBadgeModel(null).tone === 'idle', 'null verdict: safe idle model');
  }

  // --- reasons text is exactly what explainGateReasons() produces ---
  {
    const gate = computeReadinessGate({ a: res('fail', 'groups disagree') });
    const m = buildReadinessBadgeModel(gate);
    ok(m.reasons === explainGateReasons(gate), 'reasons: delegates verbatim to explainGateReasons()');
    ok(m.title === gate.passingSummary, 'title: uses the gate passingSummary one-liner');
  }

  // --- flag-off regression guard (ships dark) ---
  {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'flags.manifest.json'), 'utf8'));
    configureFlags(manifest);
    ok(isEnabled('aiReadinessGateBadge') === false, 'flags: aiReadinessGateBadge ships OFF (no badge renders by default)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
