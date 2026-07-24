// ============================================================
// DATAGLOW - Mobile-safe PHI chip + first-run calm (pure helper)
// ============================================================
// Calm chrome pass (NOT a redesign) for the existing PHI Shield. Two jobs:
//   1. Short, never-truncated privacy labels for the topbar PHI chip so it stays
//      readable at ~375px.
//   2. First-run "calm strip" state: whether to show one quiet on-device line
//      before any file is loaded, and the (em-dash-free) copy for it.
//
// This module is PURE and Node-testable: no DOM is required. The only ambient
// dependency is an optional Web Storage object for the first-run flag, which the
// caller may inject (tests pass a fake) so the functions never depend on a real
// browser. The canvas UI layer (DataGlowMobilePhiFirstRunUI) consumes these.
//
// Public API (never throws from a public fn - returns a safe value instead):
//   isFirstRun(storageKey, storage?)        -> boolean
//   markFirstRunSeen(storageKey, storage?)  -> boolean (true if persisted)
//   chipLabel(status)                       -> short string safe for narrow screens
//   shouldShowCalmStrip({ hasDataset, firstRun, flagOn }) -> boolean
//   calmCopy()                              -> { title, body, primary, dismiss }

export const MOBILE_PHI_FIRSTRUN_CALM_VERSION = 1;

// Default localStorage key for the first-run marker. Namespaced so it never
// collides with other DataGlow keys.
export const FIRST_RUN_STORAGE_KEY = 'dg.phiFirstRunCalm.seen';

// Short labels, all safe at ~375px. No em dash (U+2014) anywhere.
const LABELS = {
  onDevice: 'On device',
  clear: 'PHI clear',
  risk: 'PHI risk',
  review: 'PHI review',
};

function isFiniteNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

// Resolve a Web Storage object: prefer an injected one (tests), else the ambient
// localStorage if a browser exposes it. Returns null when none is reachable.
function getStorage(storage) {
  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    return storage;
  }
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (_e) { /* access can throw in sandboxed frames */ }
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch (_e2) { /* ditto */ }
  return null;
}

function keyOf(storageKey) {
  return typeof storageKey === 'string' && storageKey.trim() !== ''
    ? storageKey
    : FIRST_RUN_STORAGE_KEY;
}

// True when the marker has NOT been set yet. With no storage reachable we treat
// the visit as a first run (fail-open to the calming message rather than hiding
// it), which is the safe, on-brand default.
export function isFirstRun(storageKey, storage) {
  var s = getStorage(storage);
  if (!s) return true;
  try {
    return s.getItem(keyOf(storageKey)) == null;
  } catch (_e) {
    return true;
  }
}

// Persist the "seen" marker. Returns true only when it was actually written, so
// a caller can tell whether the choice will survive a reload.
export function markFirstRunSeen(storageKey, storage) {
  var s = getStorage(storage);
  if (!s) return false;
  try {
    s.setItem(keyOf(storageKey), String(Date.now()));
    return true;
  } catch (_e) {
    return false;
  }
}

// Map a PHI status into a short chip label. Accepts:
//   - a number n            -> 'PHI · n' when n > 0, else 'On device'
//   - { count }             -> same numeric rule
//   - { status, count }     -> numeric rule wins when count > 0, else status
//   - a string status       -> 'pass'|'clear' -> PHI clear, 'fail'|'risk' -> PHI
//                              risk, 'review' -> PHI review, everything else
//                              (idle/null/on-device) -> On device
// Always returns a non-empty string, so the chip is never blanked out.
export function chipLabel(status) {
  var count = null;
  var st = status;

  if (isFiniteNumber(status)) {
    count = status;
    st = null;
  } else if (status && typeof status === 'object') {
    if (isFiniteNumber(status.count)) count = status.count;
    st = status.status;
  }

  if (isFiniteNumber(count) && count > 0) {
    return 'PHI · ' + Math.floor(count);
  }

  switch (st) {
    case 'pass':
    case 'clear':
      return LABELS.clear;
    case 'fail':
    case 'risk':
      return LABELS.risk;
    case 'review':
    case 'warn':
      return LABELS.review;
    default:
      return LABELS.onDevice;
  }
}

// The calm strip shows only when the flag is on, no dataset is loaded yet, and
// the user has not dismissed it (still a first run). All three must be true.
export function shouldShowCalmStrip(state) {
  var s = state || {};
  return !!s.flagOn && !s.hasDataset && !!s.firstRun;
}

// User-visible copy for the strip. No em dash. The body is the exact on-device
// promise from the brief; the primary CTA drives file load.
export function calmCopy() {
  return {
    title: 'Your data stays on this device',
    body: 'Files stay on this device. PHI Shield watches locally.',
    primary: 'Drop a file or browse',
    dismiss: 'Dismiss',
  };
}

export const DataGlowMobilePhiFirstRunCalm = {
  version: MOBILE_PHI_FIRSTRUN_CALM_VERSION,
  FIRST_RUN_STORAGE_KEY: FIRST_RUN_STORAGE_KEY,
  isFirstRun: isFirstRun,
  markFirstRunSeen: markFirstRunSeen,
  chipLabel: chipLabel,
  shouldShowCalmStrip: shouldShowCalmStrip,
  calmCopy: calmCopy,
};

if (typeof window !== 'undefined') {
  window.DataGlowMobilePhiFirstRunCalm = DataGlowMobilePhiFirstRunCalm;
}
