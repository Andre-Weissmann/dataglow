// ============================================================
// Source Convergence (Truth Network, Batch 3 of 3) — Convergence tab wiring
// ============================================================
// Mounts the Convergence surface (js/validation/source-convergence-ui.js) which
// wires the already-merged Batch 1 engine + Batch 2 adapters into a real tab.
// Gated by ONE flag, sourceConvergenceUI (off by default): with it off the tab
// is never in the bar (see renderTabBar in main.js) and this function
// clears/resets the panel — the engine/adapter flags it builds on are never
// touched here. Mounts once per session; the module owns its own load
// controls and empty state.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-25) — byte-for-byte identical
// behavior, only the file location changed.

import { $, toast } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import { shouldOfferConvergence, mountConvergence } from '../../validation/source-convergence-ui.js';

let convergenceMounted = false;
let convergenceHandle = null;

export function renderConvergenceTab() {
  const host = $('#convergence-body');
  if (!host) return;
  if (!isEnabled('sourceConvergenceUI') || !shouldOfferConvergence({ enabled: true })) {
    host.innerHTML = '';
    if (convergenceHandle) { convergenceHandle.destroy(); }
    convergenceMounted = false;
    convergenceHandle = null;
    return;
  }
  if (!convergenceMounted) {
    convergenceHandle = mountConvergence({ host, onToast: toast });
    convergenceMounted = true;
  }
}
