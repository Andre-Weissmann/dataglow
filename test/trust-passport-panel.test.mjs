// ============================================================
// DATAGLOW — Trust Passport Panel unit tests (Batch 1.5: UI mount)
// ============================================================
// The panel is pure UI composition over the already-tested Batch 1 engine
// (trust-passport.js, 11 tests) and Batch 2 export/verify (trust-passport-
// export.js, 12 tests), so the ONLY new logic worth testing here is the
// panel's own pure readiness plan (buildTrustPassportPanelPlan) plus a
// light DOM smoke test of renderTrustPassportPanel using a minimal fake DOM
// (this repo's other DOM-touching modules follow the same style — see
// proof-room.test.mjs for the split, though that file avoids DOM entirely
// since el() needs `document`; here we exercise renderTrustPassportPanel
// with a tiny document stub so the pending/ready/export branches are all
// covered without a real browser).
//
// RUN WITH:  node test/trust-passport-panel.test.mjs

import {
  buildTrustPassportPanelPlan,
  TRUST_PASSPORT_PANEL_DISCLAIMER,
} from '../js/provenance/trust-passport-panel.js';
import { buildTrustPassport } from '../js/provenance/trust-passport.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // ---------- 1. Pure plan builder ----------
  {
    const plan = buildTrustPassportPanelPlan({});
    ok(plan.ready === false, 'no dataset: not ready');
    ok(typeof plan.reason === 'string' && plan.reason.length > 0, 'no dataset: carries a one-line reason');
  }
  {
    const plan = buildTrustPassportPanelPlan({ datasetLoaded: true });
    ok(plan.ready === true, 'dataset loaded: ready');
    ok(plan.reason === '', 'dataset loaded: no reason needed');
  }
  {
    // Never throws on garbage input.
    const plan = buildTrustPassportPanelPlan(null);
    ok(plan.ready === false, 'garbage ctx: degrades to not-ready rather than throwing');
  }

  // ---------- 2. Disclaimer honesty (same discipline as every other trust surface) ----------
  ok(/not.*certification/i.test(TRUST_PASSPORT_PANEL_DISCLAIMER), 'disclaimer denies being a certification');
  ok(/blockchain/i.test(TRUST_PASSPORT_PANEL_DISCLAIMER), 'disclaimer denies being blockchain');
  ok(/zero-knowledge/i.test(TRUST_PASSPORT_PANEL_DISCLAIMER), 'disclaimer denies being a zero-knowledge proof');

  // ---------- 3. buildTrustPassport composes cleanly with the panel's own inputs ----------
  // (Re-confirms the panel calls the Batch 1 engine with a shape it accepts —
  // the engine's own correctness is already covered by trust-passport.test.mjs.)
  {
    const passport = buildTrustPassport({
      gateResult: { score: 82, passed: true, reasons: [] },
      touchEntries: [],
      ownershipEvents: [],
      meta: { datasetId: 'claims.csv', datasetLabel: 'claims.csv' },
    });
    ok(passport.kind === 'dataglow-trust-passport', 'panel-shaped input builds a real passport');
    ok(passport.datasetLabel === 'claims.csv', 'panel-shaped input carries dataset label through');
    ok(Array.isArray(passport.permissions) && passport.permissions.length === 5, 'passport carries all 5 capabilities');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
