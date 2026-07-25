// ============================================================
// DATAGLOW - Air-Gap Mode (pure posture + egress classifier)
// ============================================================
// One switch for the room where nothing may leave the machine. When Air-Gap
// Mode is ON, every feature that would put bytes on the wire is refused before
// it can start: the AI/Story providers, MCP paths that hand data to another
// process, server offload, CDN runtime downloads, telemetry, Rooms/WebRTC and
// federated learning. Local work is untouched: DuckDB, SQL, Python, R, charts,
// pivots and local file loads keep running exactly as before.
//
// Two design rules make this trustworthy rather than decorative:
//
//   1. FAIL CLOSED. The allowlist is the local surface, and anything not on it
//      is blocked while the mode is active. A feature added next year that
//      nobody remembered to classify is therefore blocked by default, not
//      quietly allowed.
//   2. SESSION SCOPED. Activation lives in memory for this tab only. No
//      localStorage, no cookies, no IndexedDB, so the posture can never be
//      resurrected (or silently pre-set) by something the user cannot see.
//
// This module is PURE and Node-testable: no DOM, no storage, no network. The
// canvas UI layer (DataGlowAirGapUI) is what wraps fetch/XHR and paints the
// banner; everything it decides, it decides by asking the functions here.
//
// Public API (never throws from a public fn - returns a safe value instead):
//   isAirGapActive()                  -> boolean
//   activate(reason?)                 -> posture after the change
//   deactivate()                      -> posture after the change
//   shouldBlockNetwork(feature)       -> { blocked, feature, reason, message }
//   classifyFeature(feature)          -> 'local' | 'egress' | 'unknown'
//   classifyRequestUrl(url, origin)   -> { blocked, kind, reason }
//   getPosture()                      -> { active, ... } snapshot for the UI
//   postureCopy(posture)              -> user-visible strings (no em dash)
//
// Honest scope: this blocks DataGlow's own outbound paths. It is not a firewall
// and it cannot speak for the browser, an extension, or the operating system.
// The copy below says exactly that and never claims certification.

export const AIR_GAP_VERSION = 1;

// Features that run entirely on this device. This list IS the allowlist: while
// Air-Gap Mode is active, anything absent from it is blocked.
const LOCAL_FEATURES = [
  'duckdb',
  'sql',
  'python',
  'r',
  'charts',
  'pivot',
  'local-file',
  'local-export',
  'validation',
];

// Egress paths, named so a block can explain itself in one plain sentence.
const EGRESS_FEATURES = {
  ai: 'AI and Story providers send prompt text off this device.',
  mcp: 'MCP hands data to another process outside this page.',
  serverOffload: 'Server offload runs the query somewhere else.',
  cdn: 'CDN downloads fetch a runtime from a third party.',
  telemetry: 'Telemetry reports usage to a remote endpoint.',
  rooms: 'Rooms open a peer connection to another machine.',
  federated: 'Federated learning exchanges updates with peers.',
  outbound: 'This is an outbound network request.',
};

// Session state. In memory, this tab only, never written anywhere.
let _active = false;
let _reason = '';
let _activatedCount = 0;
let _blockedCount = 0;

function normalizeFeature(feature) {
  return String(feature == null ? '' : feature).trim();
}

/** True while Air-Gap Mode is active in this session. */
export function isAirGapActive() {
  return _active === true;
}

/**
 * Where a feature sits relative to the device boundary. Unknown ids are
 * reported as 'unknown' rather than guessed, and unknown means blocked while
 * the mode is active.
 */
export function classifyFeature(feature) {
  const id = normalizeFeature(feature);
  if (!id) return 'unknown';
  if (LOCAL_FEATURES.indexOf(id) !== -1) return 'local';
  if (Object.prototype.hasOwnProperty.call(EGRESS_FEATURES, id)) return 'egress';
  return 'unknown';
}

/** Every local feature id, in a stable order. Copy, so callers cannot mutate it. */
export function listLocalFeatures() {
  return LOCAL_FEATURES.slice();
}

/** Every named egress feature id, in a stable order. */
export function listEgressFeatures() {
  return Object.keys(EGRESS_FEATURES);
}

/**
 * The one gate every caller uses. Returns a decision object rather than a bare
 * boolean so a UI can show the reason without reinventing the copy.
 */
export function shouldBlockNetwork(feature) {
  const id = normalizeFeature(feature);
  const kind = classifyFeature(id);
  if (!_active) {
    return { blocked: false, feature: id, kind: kind, reason: 'inactive', message: '' };
  }
  if (kind === 'local') {
    return { blocked: false, feature: id, kind: kind, reason: 'local', message: '' };
  }
  const why = kind === 'egress'
    ? EGRESS_FEATURES[id]
    : 'This path is not on the on-device allowlist, so Air-Gap Mode blocks it by default.';
  _blockedCount += 1;
  return {
    blocked: true,
    feature: id,
    kind: kind,
    reason: kind === 'egress' ? 'egress' : 'unknown-fail-closed',
    message: 'Air-Gap Mode is on. ' + why,
  };
}

/**
 * Classify one request URL against the page origin. Same-origin requests are
 * the app's own self-hosted assets (DuckDB-WASM, Plotly, SheetJS) and stay
 * allowed so local engines keep working; blob:, data: and about: URLs never
 * touch the network. Everything else is off device and is blocked.
 * A URL that cannot be parsed is blocked: fail closed, never guess.
 */
export function classifyRequestUrl(url, origin) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return { blocked: true, kind: 'unparseable', reason: 'Empty request URL.' };
  const lower = raw.toLowerCase();
  for (const scheme of ['blob:', 'data:', 'about:']) {
    if (lower.indexOf(scheme) === 0) {
      return { blocked: false, kind: 'inline', reason: 'Inline resource, no network.' };
    }
  }
  // Relative URLs (no scheme, no protocol-relative prefix) are same origin.
  if (!/^[a-z][a-z0-9+.-]*:/.test(lower) && lower.indexOf('//') !== 0) {
    return { blocked: false, kind: 'same-origin', reason: 'Same-origin asset.' };
  }
  let base = String(origin == null ? '' : origin);
  let parsedUrl;
  let parsedBase;
  try {
    parsedUrl = new URL(raw, base || undefined);
  } catch (_e) {
    return { blocked: true, kind: 'unparseable', reason: 'Request URL could not be read, so it is blocked.' };
  }
  try {
    parsedBase = base ? new URL(base) : null;
  } catch (_e2) {
    parsedBase = null;
  }
  if (parsedBase && parsedUrl.origin === parsedBase.origin) {
    return { blocked: false, kind: 'same-origin', reason: 'Same-origin asset.' };
  }
  return {
    blocked: true,
    kind: 'cross-origin',
    reason: 'Request to ' + parsedUrl.origin + ' would leave this device.',
  };
}

function snapshot() {
  return {
    active: _active,
    version: AIR_GAP_VERSION,
    reason: _reason,
    activatedCount: _activatedCount,
    blockedCount: _blockedCount,
    localFeatures: LOCAL_FEATURES.slice(),
    blockedFeatures: _active ? Object.keys(EGRESS_FEATURES) : [],
    banner: _active,
    failClosed: true,
    sessionScoped: true,
    persisted: false,
  };
}

/** Turn the mode on for this session. Idempotent. Returns the new posture. */
export function activate(reason) {
  if (!_active) {
    _active = true;
    _activatedCount += 1;
  }
  const text = normalizeFeature(reason);
  if (text) _reason = text;
  return snapshot();
}

/** Turn the mode off for this session. Idempotent. Returns the new posture. */
export function deactivate() {
  _active = false;
  _reason = '';
  return snapshot();
}

/** Current posture, safe to call at any time. */
export function getPosture() {
  return snapshot();
}

/** Drop all session state. Test and teardown helper; never called by the UI. */
export function resetAirGapSession() {
  _active = false;
  _reason = '';
  _activatedCount = 0;
  _blockedCount = 0;
  return snapshot();
}

/** User-visible strings for a posture. No em dash (U+2014) anywhere. */
export function postureCopy(p) {
  const state = p && typeof p === 'object' ? p : snapshot();
  const on = state.active === true;
  return {
    title: on ? 'Air-Gap Mode is on' : 'Air-Gap Mode is off',
    body: on
      ? 'Nothing leaves this device. DuckDB, SQL, Python, R and charts keep running locally.'
      : 'Outbound paths are available. Turn this on for a room where data must not leave.',
    blocked: on
      ? 'Blocked while on: AI providers, MCP, server offload, CDN runtime downloads, telemetry, Rooms and federated learning.'
      : 'Nothing is blocked right now.',
    local: 'Local engines stay available either way. Your rows are never uploaded.',
    disclaimer: 'DataGlow blocks its own outbound paths. It is not a firewall and does not speak for your browser or operating system.',
  };
}

export const DataGlowAirGap = {
  version: AIR_GAP_VERSION,
  isAirGapActive: isAirGapActive,
  activate: activate,
  deactivate: deactivate,
  shouldBlockNetwork: shouldBlockNetwork,
  classifyFeature: classifyFeature,
  classifyRequestUrl: classifyRequestUrl,
  listLocalFeatures: listLocalFeatures,
  listEgressFeatures: listEgressFeatures,
  getPosture: getPosture,
  postureCopy: postureCopy,
  resetAirGapSession: resetAirGapSession,
};

if (typeof window !== 'undefined') {
  window.DataGlowAirGap = DataGlowAirGap;
}
