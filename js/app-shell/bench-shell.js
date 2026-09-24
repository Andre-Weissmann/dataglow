// ============================================================
// DATAGLOW — The Bench: shared-grid instrument shell (Batch 1 of 3)
// ============================================================
// WHAT THIS IS: the first step toward a single continuous working surface
// where the SQL, Python, and R tabs stop being three disconnected
// destinations and instead become "instruments" that all act on the SAME
// live data grid. Batch 1 ships ONLY the pure lineage-tracking algebra and
// a thin, additive rail renderer — it does not yet touch the real SQL,
// Python, or R panels (those are Batch 2/3). With the `theBench` flag off
// (its shipped default) nothing in this file is imported by any existing
// panel, so the app is byte-for-byte unchanged.
//
// WHY A SEPARATE LINEAGE MODULE: DataGlow already has scattered signals of
// "what happened to this dataset" (SQL query history, Python/R notebook run
// history, cleaning-crew fix logs) but nothing that composes them into one
// readable timeline. This module invents no new tracking — callers push a
// lineage STEP each time one of those existing actions completes, and this
// module holds/orders/serializes that list. It never reaches into DuckDB,
// Pyodide, or WebR itself.
//
// Identity split (same convention as js/runtimes-viz/glow-canvas.js and
// js/rooms/room-ui.js): the algebra (createLineage / addStep / clearLineage /
// serializeLineage / deserializeLineage) is PURE, Node-testable, and never
// mutates its input — every mutator returns a NEW lineage. The renderer
// (renderStoryStrip) turns a lineage into DOM and is thin enough to leave to
// the browser/e2e path.
//
// WHAT THIS BATCH DELIBERATELY STILL DOES NOT DO: no wiring of the SQL,
// Python, or R panels into a shared grid (Batch 2); no Validate & Trust
// slide-over (Batch 3); no change to any existing DuckDB/Pyodide/WebR
// behavior. This batch ships fully dark behind the `theBench` flag
// (enabled:false); with the flag off nothing here mounts.

const MAX_STEPS = 12; // a story strip with more than this is a log, not a story

export const LINEAGE_STEP_KINDS = ['upload', 'clean', 'sql', 'python', 'r', 'formula'];

/**
 * @returns {{steps: Array<{id:number, kind:string, label:string, ts:number}>, nextId:number}}
 */
export function createLineage() {
  return { steps: [], nextId: 1 };
}

/**
 * Pure append. Unknown kinds are accepted (labelled as-is) rather than
 * thrown on, since a future instrument should be able to log a step without
 * this module needing a matching release first.
 * @param {{steps:Array, nextId:number}} lineage
 * @param {{kind:string, label:string, ts?:number}} step
 */
export function addStep(lineage, step) {
  if (!step || typeof step.label !== 'string' || !step.label.trim()) {
    throw new Error('addStep requires a non-empty label');
  }
  const entry = {
    id: lineage.nextId,
    kind: typeof step.kind === 'string' && step.kind ? step.kind : 'other',
    label: step.label.trim(),
    ts: typeof step.ts === 'number' ? step.ts : Date.now(),
  };
  const steps = [...lineage.steps, entry].slice(-MAX_STEPS);
  return { steps, nextId: lineage.nextId + 1 };
}

export function clearLineage() {
  return createLineage();
}

export function serializeLineage(lineage) {
  return JSON.stringify(lineage);
}

/**
 * Never throws — malformed/missing input degrades to an empty lineage,
 * same defensive convention as glow-canvas.js's deserializeLayout.
 */
export function deserializeLineage(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.steps) || typeof parsed.nextId !== 'number') {
      return createLineage();
    }
    return { steps: parsed.steps.slice(-MAX_STEPS), nextId: parsed.nextId };
  } catch {
    return createLineage();
  }
}

const KIND_ICON = {
  upload: '\u2913',
  clean: '\u2713',
  sql: '\u21C6',
  python: '\u27E8\u27E9',
  r: '\u2223\u2223',
  formula: 'T',
  other: '\u2022',
};

/**
 * Thin DOM renderer — mounts a horizontally-scrollable strip of lineage
 * steps into `container`. Never mutates `lineage`. Left entirely to the
 * browser/e2e test path, same convention as glow-canvas.js's renderCanvas.
 * @param {HTMLElement} container
 * @param {{steps:Array}} lineage
 */
export function renderStoryStrip(container, lineage) {
  if (!container) return;
  container.innerHTML = '';
  container.classList.add('bench-story-strip');
  const label = document.createElement('span');
  label.className = 'bench-story-label';
  label.textContent = "THIS DATASET'S STORY";
  container.appendChild(label);

  if (!lineage || !lineage.steps || lineage.steps.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'bench-story-empty';
    empty.textContent = 'No steps yet — load a dataset to begin.';
    container.appendChild(empty);
    return;
  }

  lineage.steps.forEach((step, idx) => {
    if (idx > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'bench-story-arrow';
      arrow.textContent = '\u2192';
      container.appendChild(arrow);
    }
    const chip = document.createElement('span');
    chip.className = 'bench-story-step' + (idx === lineage.steps.length - 1 ? ' current' : '');
    chip.dataset.testid = `bench-story-step-${step.id}`;
    chip.textContent = `${KIND_ICON[step.kind] || KIND_ICON.other} ${step.label}`;
    container.appendChild(chip);
  });
}
