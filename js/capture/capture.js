// ============================================================
// DATAGLOW - R3 Screenshot / proof capture (pure engine)
// ============================================================
// WHY THIS EXISTS
// R3_R4_CAPTURE_SHIP_SPEC.md, "R3 Screenshot / proof capture": a local-only
// "Capture step" action that records a PNG of the current canvas state,
// named with the step and a timestamp, for a fixed set of project-run steps
// (home, loaded, validate, scout, prove, narrative, export). No network
// upload, ever: this module never constructs a URL, never calls fetch, and
// never touches anything outside window.indexedDB / a same-page download.
//
// PURITY BOUNDARY
// This file holds the parts that can be tested with plain Node: the fixed
// step list, filename building, the capture record shape, and the in-memory
// list a canvas UI renders from. It does NOT touch html2canvas, the DOM
// canvas element, or IndexedDB directly -- those calls are asynchronous
// browser APIs the canvas UI module (data-glow-capture-canvas.js) drives,
// passing this module's pure helpers the plumbing (blob, size, mimeType)
// once a capture actually happens. That split mirrors every other engine in
// this codebase (question-scout.js / proof-harness/*.js): pure logic here,
// DOM/IO in the *-canvas.js sibling.
//
// NEVER: no fetch(), no XMLHttpRequest, no WebSocket, no navigator.sendBeacon
// anywhere in this file. "No network upload" is a hard SPEC requirement.

export const CAPTURE_VERSION = 1;

/**
 * The fixed set of project-run steps a capture can be labeled with, in the
 * SPEC's order. A canvas UI offers exactly these as a picker; capture() also
 * accepts a free-form label so an ad hoc capture is still recorded honestly
 * (tagged as "custom") rather than forced into a wrong bucket.
 */
export const CAPTURE_STEPS = Object.freeze([
  'home',
  'loaded',
  'validate',
  'scout',
  'prove',
  'narrative',
  'export',
]);

export const CUSTOM_STEP = 'custom';

/** IndexedDB database/store names, versioned so a future shape change can migrate cleanly. */
export const CAPTURE_DB_NAME = 'dataglow-capture-v1';
export const CAPTURE_STORE_NAME = 'captures';
export const CAPTURE_DB_VERSION = 1;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Two-digit zero pad, used only for the local-time filename stamp below. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * A filesystem-safe, sortable timestamp for filenames: YYYYMMDD-HHMMSS in
 * local time (matches how a person reading a folder listing expects capture
 * order to read top-to-bottom). Pure function of the Date passed in, so it
 * is fully deterministic under test.
 * @param {Date} [date]
 */
export function timestampStamp(date) {
  const d = date instanceof Date && !isNaN(d_getTimeSafe(date)) ? date : new Date();
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '-' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}
function d_getTimeSafe(d) {
  try { return d.getTime(); } catch (_e) { return NaN; }
}

/**
 * Normalize a requested step label to one of CAPTURE_STEPS, or CUSTOM_STEP
 * for anything else. Never throws on bad input (missing/blank/wrong type all
 * fall through to 'custom' with the raw text preserved as customLabel).
 * @param {string} rawStep
 */
export function normalizeStep(rawStep) {
  const s = typeof rawStep === 'string' ? rawStep.trim().toLowerCase() : '';
  if (CAPTURE_STEPS.includes(s)) return { step: s, customLabel: null };
  return { step: CUSTOM_STEP, customLabel: typeof rawStep === 'string' && rawStep.trim() ? rawStep.trim() : null };
}

/**
 * Build the download/IndexedDB filename for a capture: "<step>_<stamp>.png",
 * or "custom-<label>_<stamp>.png" when the step is not one of the fixed
 * seven. Sanitizes the custom label to a safe filename fragment (letters,
 * digits, dash, underscore only) so a pasted label can never break the file
 * system or inject a path segment.
 * @param {string} rawStep
 * @param {Date} [date]
 */
export function buildCaptureFilename(rawStep, date) {
  const { step, customLabel } = normalizeStep(rawStep);
  const stamp = timestampStamp(date);
  if (step === CUSTOM_STEP) {
    const safe = (customLabel || 'step').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'step';
    return `dataglow-capture_custom-${safe}_${stamp}.png`;
  }
  return `dataglow-capture_${step}_${stamp}.png`;
}

/**
 * Build one capture record (the pure metadata half; blob/size/mimeType are
 * supplied by the canvas UI once it actually has PNG bytes from html2canvas,
 * a native capture API, or the canvas-draw fallback). Never touches the
 * network: only fields present are text/number metadata and a Blob-like
 * value the caller already produced locally.
 * @param {{step:string, blob?:any, width?:number, height?:number, method?:string, date?:Date}} input
 */
export function buildCaptureRecord(input) {
  const inp = isPlainObject(input) ? input : {};
  const { step, customLabel } = normalizeStep(inp.step);
  const date = inp.date instanceof Date ? inp.date : new Date();
  const method = ['html2canvas', 'native', 'canvas-fallback'].includes(inp.method) ? inp.method : 'canvas-fallback';
  return {
    kind: 'dataglow-capture-record',
    version: CAPTURE_VERSION,
    id: `cap-${date.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    step,
    customLabel,
    label: step === CUSTOM_STEP ? (customLabel || 'custom') : step,
    filename: buildCaptureFilename(step === CUSTOM_STEP ? (customLabel || 'custom') : step, date),
    capturedAt: date.toISOString(),
    method,
    width: typeof inp.width === 'number' ? inp.width : null,
    height: typeof inp.height === 'number' ? inp.height : null,
    mimeType: 'image/png',
    byteSize: typeof inp.byteSize === 'number' ? inp.byteSize : null,
    // The blob itself is intentionally NOT copied into this plain record by
    // default (keeps this function safely serializable for tests); callers
    // that need the actual Blob carry it alongside the record by id.
  };
}

/**
 * In-memory list model for a session's captures: append-only from the UI's
 * point of view (removeCapture is the only way to shrink it, mirroring
 * Question Scout's keepers tray rather than the receipt ledger's hard
 * never-remove rule, since a mis-clicked screenshot is not a proof artifact).
 * @param {Array<object>} list
 * @param {object} record
 */
export function addCapture(list, record) {
  const base = Array.isArray(list) ? list.slice() : [];
  if (!isPlainObject(record) || record.kind !== 'dataglow-capture-record') return base;
  base.push(record);
  return base;
}

/**
 * Remove a capture by id. Returns a new array; never throws on an id that is
 * not present.
 * @param {Array<object>} list
 * @param {string} id
 */
export function removeCapture(list, id) {
  const base = Array.isArray(list) ? list : [];
  return base.filter((c) => c && c.id !== id);
}

/**
 * Which of the seven fixed steps have at least one capture recorded, in
 * SPEC order, plus which are still missing. Pure summary the canvas UI (or
 * the ship pack) can render as a checklist without re-deriving the logic.
 * @param {Array<object>} list
 */
export function captureStepCoverage(list) {
  const base = Array.isArray(list) ? list : [];
  const have = new Set(base.filter((c) => c && CAPTURE_STEPS.includes(c.step)).map((c) => c.step));
  return {
    kind: 'dataglow-capture-step-coverage',
    steps: CAPTURE_STEPS.map((s) => ({ step: s, captured: have.has(s) })),
    coveredCount: have.size,
    totalSteps: CAPTURE_STEPS.length,
    customCount: base.filter((c) => c && c.step === CUSTOM_STEP).length,
  };
}

/**
 * Build the manifest entry list the Ship Pack's screenshots/ folder uses:
 * one row per capture, filename + step + capturedAt only (no blob), so
 * ship-pack.js can build a manifest.json alongside the actual PNG files
 * without importing this module's DOM-adjacent concerns.
 * @param {Array<object>} list
 */
export function buildScreenshotManifest(list) {
  const base = Array.isArray(list) ? list : [];
  return base
    .filter((c) => isPlainObject(c) && c.kind === 'dataglow-capture-record')
    .map((c) => ({
      filename: c.filename,
      step: c.step,
      customLabel: c.customLabel || null,
      capturedAt: c.capturedAt,
      method: c.method,
      width: c.width,
      height: c.height,
      byteSize: c.byteSize,
    }));
}

// ------------------------------------------------------------
// Public namespace export (mirrors js/question-scout/question-scout.js's
// window.DataGlowQuestionScout pattern)
// ------------------------------------------------------------
export const DataGlowCapture = {
  CAPTURE_VERSION,
  CAPTURE_STEPS,
  CUSTOM_STEP,
  CAPTURE_DB_NAME,
  CAPTURE_STORE_NAME,
  CAPTURE_DB_VERSION,
  timestampStamp,
  normalizeStep,
  buildCaptureFilename,
  buildCaptureRecord,
  addCapture,
  removeCapture,
  captureStepCoverage,
  buildScreenshotManifest,
};

export default DataGlowCapture;
