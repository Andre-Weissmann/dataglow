// ============================================================
// Glow Canvas Tab (Batch 1 — ships dark behind the glowCanvas flag)
// ============================================================
// The multi-chart dashboard surface. This module owns the live layout state
// and its persistence (the IndexedDB canvasLayouts store); js/runtimes-viz/
// glow-canvas.js only holds the PURE layout algebra and the thin renderer,
// which delegates every actual chart draw to the existing viz.renderChart. The
// glowCanvas flag is checked HERE (the caller), never inside that module.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-25) — byte-for-byte identical
// behavior, only the file location changed.

import { state } from '../state.js';
import { isEnabled } from '../../build/build-flags.js';
import * as glowCanvas from '../../runtimes-viz/glow-canvas.js';
import * as memoryStore from '../../learning/memory-store.js';

const GLOW_CANVAS_LAYOUT_NAME = 'default';
let glowCanvasLayout = glowCanvas.createCanvasLayout();
let glowCanvasLoaded = false;

async function persistGlowCanvasLayout() {
  try {
    await memoryStore.saveCanvasLayout(GLOW_CANVAS_LAYOUT_NAME, glowCanvas.serializeLayout(glowCanvasLayout));
  } catch (_e) { /* persistence is best-effort — a save failure must never break the canvas */ }
}

function drawGlowCanvas() {
  glowCanvas.renderCanvas('glow-canvas-body', glowCanvasLayout, {
    datasets: state.datasets || [],
    onChange: (next) => {
      glowCanvasLayout = next;
      persistGlowCanvasLayout();
      drawGlowCanvas();
    },
  });
}

export async function renderGlowCanvasTab() {
  const host = document.getElementById('glow-canvas-body');
  if (!host) return;
  if (!isEnabled('glowCanvas')) { host.innerHTML = ''; glowCanvasLoaded = false; return; }
  // Load the saved layout once per session, then draw. Subsequent activations
  // just redraw the in-memory layout (kept in sync by onChange above).
  if (!glowCanvasLoaded) {
    glowCanvasLoaded = true;
    try {
      const saved = await memoryStore.getCanvasLayout(GLOW_CANVAS_LAYOUT_NAME);
      if (saved && saved.layoutJson) glowCanvasLayout = glowCanvas.deserializeLayout(saved.layoutJson);
    } catch (_e) { /* no saved layout / store unavailable — start from the empty layout */ }
  }
  drawGlowCanvas();
}
