// ============================================================
// The Crucible (Batch 2 of 3) — Crucible tab wiring
// ============================================================
// Mounts the read-only Crucible surface (js/validation/crucible-ui.js) which
// presents Batch 1's already-merged typed handoff contract + adversarial-pack
// output. Gated by ONE flag, crucibleValidatorUI (off by default): with it off
// the tab is never in the bar (see renderTabBar in main.js) and this function
// clears/resets the panel. It adds NO data-mutation path — no live proposal is
// fed through it yet (that + apply/revert are future batches), so it renders
// an honest empty state. Batch 1's separate crucibleValidator logic flag is
// never touched here.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-25) — byte-for-byte identical
// behavior, only the file location changed.

import { state } from '../state.js';
import { $, toast } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import { shouldOfferCrucible, mountCrucible } from '../../validation/crucible-ui.js';

let crucibleMounted = false;
let crucibleHandle = null;

export function renderCrucibleTab() {
  const host = $('#crucible-body');
  if (!host) return;
  if (!isEnabled('crucibleValidatorUI') || !shouldOfferCrucible({ enabled: true })) {
    host.innerHTML = '';
    if (crucibleHandle) { crucibleHandle.destroy(); }
    crucibleMounted = false;
    crucibleHandle = null;
    return;
  }
  // ADDITIVE-ONLY: when the crucibleOrchestration flag is on AND a fix has been
  // run through the standing suite this session, feed that live result into the
  // panel; re-mount so the newest run is shown. In every other case (flag off,
  // or no run yet) fall back to the original one-time empty-state mount, so the
  // tab renders exactly as before when the flag is dark.
  const run = isEnabled('crucibleOrchestration') ? state.latestCrucibleRun : null;
  if (run) {
    if (crucibleHandle) { crucibleHandle.destroy(); }
    crucibleHandle = mountCrucible({
      host, onToast: toast,
      cleaningResult: run.cleaningResult,
      validationVerdict: run.validationVerdict,
      suiteResult: run.suiteResult,
    });
    crucibleMounted = true;
    return;
  }
  if (!crucibleMounted) {
    crucibleHandle = mountCrucible({ host, onToast: toast });
    crucibleMounted = true;
  }
}
