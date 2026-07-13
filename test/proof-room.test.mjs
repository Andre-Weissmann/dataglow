// ============================================================
// DATAGLOW — Proof Room composer unit tests (Trust Passport, composition batch 1)
// ============================================================
// The Proof Room is pure UI composition of six already-tested surfaces, so the
// ONLY new logic worth testing is js/provenance/proof-room.js's pure plan
// builder + its fixed step order/metadata. No DOM, no DuckDB, no network.
//
//   - the six steps are emitted in the fixed product order,
//   - readiness is decided honestly from session state (no dataset → most steps
//     not ready; validation not yet run → no seal; no seal → no beam; the
//     AI Touch Ledger step depends only on the aiTouchLedgerEnabled flag),
//   - a not-ready step carries a one-line reason, a ready step carries none,
//   - the beam step follows the seal step's readiness unless overridden,
//   - the aggregator never throws on empty/garbage input,
//   - honest-naming + zero-upload source guards on the module itself.
//
// RUN WITH:  node test/proof-room.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProofRoomPlan,
  PROOF_ROOM_STEPS,
  PROOF_ROOM_STEP_KEYS,
  PROOF_ROOM_DISCLAIMER,
} from '../js/provenance/proof-room.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const step = (plan, key) => plan.steps.find((s) => s.key === key);

function main() {
  // ---------- 1. Fixed step order + metadata ----------
  ok(PROOF_ROOM_STEP_KEYS.length === 6, 'meta: exactly six steps');
  ok(JSON.stringify(PROOF_ROOM_STEP_KEYS) === JSON.stringify([
    'metricStudio', 'trustStrip', 'dataNutritionLabel', 'verifiableCheckSeal', 'trustBeam', 'aiTouchLedger',
  ]), 'meta: step keys are in the fixed product order');
  ok(PROOF_ROOM_STEPS.map((s) => s.key).join(',') === PROOF_ROOM_STEP_KEYS.join(','),
    'meta: PROOF_ROOM_STEPS order matches PROOF_ROOM_STEP_KEYS');
  ok(PROOF_ROOM_STEPS.every((s) => typeof s.title === 'string' && s.title
    && typeof s.description === 'string' && s.description),
    'meta: every step has a non-empty title + description');

  // ---------- 2. Nothing loaded ----------
  {
    const plan = buildProofRoomPlan({});
    ok(plan.steps.length === 6, 'empty: six steps emitted');
    ok(plan.steps.map((s, i) => s.step === i + 1).every(Boolean), 'empty: steps numbered 1..6 in order');
    ok(step(plan, 'metricStudio').available === false, 'empty: Metric Studio not ready with no dataset');
    ok(step(plan, 'trustStrip').available === true, 'empty: Trust Strip always renders (honest empty state)');
    ok(step(plan, 'dataNutritionLabel').available === false, 'empty: Nutrition Label not ready with no dataset');
    ok(step(plan, 'verifiableCheckSeal').available === false, 'empty: Seal not ready with no dataset/validation');
    ok(step(plan, 'trustBeam').available === false, 'empty: Beam not ready without a seal');
    ok(step(plan, 'aiTouchLedger').available === false, 'empty: AI Touch Ledger not ready when the flag is off (default)');
    ok(plan.readyCount === 1 && plan.totalCount === 6, 'empty: only the Trust Strip is ready');
    ok(step(plan, 'metricStudio').detail.length > 0 && step(plan, 'trustStrip').detail === '',
      'empty: a not-ready step has a reason, a ready step has none');
  }

  // ---------- 3. Dataset loaded, no validation yet ----------
  {
    const plan = buildProofRoomPlan({ datasetLoaded: true, hasValidationResults: false });
    ok(step(plan, 'metricStudio').available === true, 'loaded: Metric Studio ready');
    ok(step(plan, 'dataNutritionLabel').available === true, 'loaded: Nutrition Label ready');
    ok(step(plan, 'verifiableCheckSeal').available === false, 'loaded: Seal still needs a validation run');
    ok(step(plan, 'trustBeam').available === false, 'loaded: Beam still needs a seal');
    ok(step(plan, 'verifiableCheckSeal').detail.length > 0, 'loaded: Seal step explains what is missing');
  }

  // ---------- 4. Dataset loaded + validation run → seal + beam become ready ----------
  {
    const plan = buildProofRoomPlan({ datasetLoaded: true, hasValidationResults: true });
    ok(step(plan, 'verifiableCheckSeal').available === true, 'validated: Seal ready');
    ok(step(plan, 'trustBeam').available === true, 'validated: Beam follows the seal step by default');
    ok(plan.readyCount === 5, 'validated: five of six steps ready (AI Touch Ledger flag still off)');
    ok(step(plan, 'aiTouchLedger').available === false, 'validated: AI Touch Ledger still not ready — independent of dataset/validation state');
    ok(plan.steps.filter((s) => s.key !== 'aiTouchLedger').every((s) => s.detail === ''),
      'validated: no step other than the flagged-off AI Touch Ledger carries a pending reason');
  }

  // ---------- 4b. AI Touch Ledger step depends only on the flag ----------
  {
    const flagOff = buildProofRoomPlan({ datasetLoaded: true, hasValidationResults: true, aiTouchLedgerEnabled: false });
    ok(step(flagOff, 'aiTouchLedger').available === false, 'flag: AI Touch Ledger not ready when aiTouchLedgerEnabled is false');
    ok(step(flagOff, 'aiTouchLedger').detail.length > 0, 'flag: AI Touch Ledger explains it is an opt-in feature when off');

    const flagOn = buildProofRoomPlan({ aiTouchLedgerEnabled: true });
    ok(step(flagOn, 'aiTouchLedger').available === true, 'flag: AI Touch Ledger ready when aiTouchLedgerEnabled is true, even with nothing else loaded');
    ok(step(flagOn, 'aiTouchLedger').detail === '', 'flag: AI Touch Ledger has no pending reason once enabled');
    ok(step(flagOn, 'metricStudio').available === false, 'flag: enabling AI Touch Ledger does not make unrelated steps ready');

    const allSix = buildProofRoomPlan({ datasetLoaded: true, hasValidationResults: true, aiTouchLedgerEnabled: true });
    ok(allSix.readyCount === 6, 'flag: all six steps ready when dataset+validation+flag are all satisfied');
  }

  // ---------- 5. Explicit sealReady override decouples beam from seal step ----------
  {
    const notYet = buildProofRoomPlan({ datasetLoaded: true, hasValidationResults: true, sealReady: false });
    ok(step(notYet, 'verifiableCheckSeal').available === true && step(notYet, 'trustBeam').available === false,
      'override: seal step ready but beam held until a seal actually exists');
    const beamed = buildProofRoomPlan({ datasetLoaded: true, hasValidationResults: false, sealReady: true });
    ok(step(beamed, 'trustBeam').available === true,
      'override: an already-produced seal makes the beam ready even before this render');
  }

  // ---------- 6. Never throws on garbage ----------
  {
    let threw = false;
    try {
      buildProofRoomPlan(null);
      buildProofRoomPlan(undefined);
      buildProofRoomPlan({ datasetLoaded: 'yes', hasValidationResults: 0, sealReady: 'x' });
    } catch (e) { threw = true; }
    ok(!threw, 'robust: buildProofRoomPlan never throws on null/undefined/garbage input');
  }

  // ---------- 7. Honest naming: disclaimer disclaims the three overclaims ----------
  {
    const d = PROOF_ROOM_DISCLAIMER.toLowerCase();
    ok(/not a certification/.test(d), 'honest: disclaimer says NOT a certification');
    ok(/not "blockchain"|not blockchain/.test(d), 'honest: disclaimer says NOT blockchain');
    ok(/not a zero-knowledge proof/.test(d), 'honest: disclaimer says NOT a zero-knowledge proof');
  }

  // ---------- 8. Source guards on the module ----------
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'js', 'provenance', 'proof-room.js'), 'utf8');

    // Zero-upload: the composer must not reach for any network primitive.
    const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/;
    ok(!netRe.test(src), 'zero-upload: js/provenance/proof-room.js contains no network primitive');

    // Honest naming: the forbidden overclaim terms may appear ONLY on a line
    // that negates them (a disclaimer). Same guard style as the sibling seal/beam tests.
    const forbidden = ['zero-knowledge', 'zkp', 'blockchain', 'certified'];
    const lines = src.split('\n');
    let violation = null;
    for (const line of lines) {
      const lower = line.toLowerCase();
      for (const term of forbidden) {
        if (lower.includes(term) && !/\bnot\b/.test(lower)) { violation = `${term} :: ${line.trim()}`; break; }
      }
      if (violation) break;
    }
    ok(violation === null, `honest: no overclaim term used un-negated (${violation || 'clean'})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
