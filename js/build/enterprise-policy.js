// ============================================================
// DATAGLOW — Enterprise Policy Loader (Phase 1)
// ============================================================
// Reads an optional `dataglow-policy.json` file from the app root and applies
// its settings at init time, BEFORE any feature flag is evaluated. An IT
// administrator drops the file alongside index.html to enforce an
// organization-wide configuration without modifying any source code.
//
// WHY THIS EXISTS:
// The CSP and BigInt fixes (Phase 0) close the browser-level security gaps.
// But enterprise deployments need a higher-level control plane: disable BYOK
// Story (which sends data to external LLMs), disable WebRTC (which opens
// peer connections on hospital networks), disable CDN fetches (for air-gapped
// or network-namespaced environments), and enable a session audit log. All of
// these were identified as blocking issues for hospital security reviews.
//
// DESIGN PRINCIPLES:
// 1. Default OPEN -- with no policy file present the app behaves exactly as
//    before. Enterprise hardening is opt-in by the admin, not opt-out by the user.
// 2. Pure and synchronous after load -- once applyEnterprisePolicy() has run,
//    every policy check (isPolicyEnabled, isPolicyDisabled) is a simple Map
//    lookup, no I/O.
// 3. Auditable -- every policy override is logged to the browser console at
//    INFO level so a developer or auditor can see what was applied.
// 4. Tamper-visible -- the loaded policy file's raw text is hashed (SHA-256)
//    and stored so the audit log can record the policy fingerprint alongside
//    each session.
//
// POLICY FILE FORMAT (dataglow-policy.json):
//   {
//     "version": 1,
//     "organization": "Acme Health System",
//     "disable": [
//       "byokStory",         -- disables BYOK/external LLM Story tab
//       "webrtcRooms",       -- disables the Rooms peer-to-peer feature
//       "cdnFetches",        -- disables lazy CDN loads (DuckDB bundle must be vendored)
//       "federatedLearning"  -- disables the federated learning coordinator
//     ],
//     "require": [
//       "auditLog",          -- enables session-level audit logging to console
//       "enterpriseBuild"    -- marks this as an enterprise-hardened session
//     ],
//     "allowedExportFormats": ["pdf", "xlsx"],  -- optional: restrict export formats
//     "adminContact": "dataops@acmehealth.org"
//   }
//
// KNOWN DISABLE KEYS (extend as new features ship):
//   byokStory, webrtcRooms, cdnFetches, federatedLearning
//
// KNOWN REQUIRE KEYS:
//   auditLog, enterpriseBuild

const POLICY_FILE = 'dataglow-policy.json';
const POLICY_VERSION = 1;

// In-memory policy state. Populated by applyEnterprisePolicy(), read-only after.
let _loaded = false;
let _policy = null;
let _disabled = new Set();
let _required = new Set();
let _policyHash = null;
let _organization = null;
let _adminContact = null;
let _allowedExportFormats = null;

// ---- loading ---------------------------------------------------------------

/**
 * Attempt to load dataglow-policy.json from the app root. Returns null if the
 * file does not exist or is not valid JSON -- absence of a policy file is the
 * normal non-enterprise case and is not an error.
 *
 * This uses a plain fetch() with cache:reload so the browser never serves a
 * stale policy from HTTP cache. It is called ONCE at app init before DuckDB
 * initialization. In Tauri the fetch is intercepted by the asset loader and
 * reads from the app bundle; in the browser it reads from the same origin.
 *
 * @returns {Promise<string|null>} raw JSON text, or null if absent/invalid
 */
async function fetchPolicyFile() {
  try {
    const res = await fetch(POLICY_FILE, { cache: 'reload' });
    if (!res.ok) return null; // 404 = no policy file, normal case
    return await res.text();
  } catch {
    return null; // network error or Tauri asset not found
  }
}

/**
 * Parse and validate a policy file's raw text. Returns { ok, policy, error }.
 */
function parsePolicy(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    return { ok: false, error: 'Policy file is not valid JSON: ' + e.message, policy: null };
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'Policy file must be a JSON object.', policy: null };
  }
  if (obj.version !== POLICY_VERSION) {
    return { ok: false, error: 'Unsupported policy version ' + obj.version + '; this build understands version ' + POLICY_VERSION + '.', policy: null };
  }
  return { ok: true, policy: obj, error: null };
}

// ---- application -----------------------------------------------------------

/**
 * Load and apply the enterprise policy. Safe to call multiple times -- only
 * the first call has any effect. Returns the applied policy object or null.
 *
 * Call this at app init BEFORE feature flags are evaluated:
 *   await applyEnterprisePolicy();
 *   buildFlags.init(flagsManifest);
 *
 * @returns {Promise<object|null>}
 */
export async function applyEnterprisePolicy() {
  if (_loaded) return _policy;
  _loaded = true;

  const text = await fetchPolicyFile();
  if (text === null) {
    // No policy file -- default open, nothing to apply.
    return null;
  }

  const { ok, policy, error } = parsePolicy(text);
  if (!ok) {
    console.warn('[DATAGLOW policy] Policy file found but could not be parsed:', error);
    return null;
  }

  _policy = policy;
  _organization = typeof policy.organization === 'string' ? policy.organization : null;
  _adminContact = typeof policy.adminContact === 'string' ? policy.adminContact : null;
  _allowedExportFormats = Array.isArray(policy.allowedExportFormats) ? policy.allowedExportFormats : null;

  if (Array.isArray(policy.disable)) {
    for (const key of policy.disable) {
      if (typeof key === 'string') _disabled.add(key);
    }
  }
  if (Array.isArray(policy.require)) {
    for (const key of policy.require) {
      if (typeof key === 'string') _required.add(key);
    }
  }

  // Compute a fingerprint of the policy file for audit log embedding.
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    _policyHash = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { _policyHash = null; }

  // Console audit trail -- always visible to developers and browser-based audit tools.
  console.info('[DATAGLOW policy] Enterprise policy applied.', {
    organization: _organization,
    adminContact: _adminContact,
    disabled: [..._disabled],
    required: [..._required],
    allowedExportFormats: _allowedExportFormats,
    policyHash: _policyHash,
  });

  if (_required.has('auditLog')) {
    console.info('[DATAGLOW audit] Session started under enterprise policy.', {
      ts: new Date().toISOString(),
      policyHash: _policyHash,
      organization: _organization,
    });
  }

  return _policy;
}

// ---- query API (synchronous after init) ------------------------------------

/** True if a policy was loaded and applied. */
export function hasPolicyLoaded() { return _loaded && _policy !== null; }

/** True if the given feature key has been disabled by policy. */
export function isPolicyDisabled(key) { return _disabled.has(key); }

/** True if the given requirement key is mandated by policy. */
export function isPolicyRequired(key) { return _required.has(key); }

/** The loaded organization name, or null. */
export function getPolicyOrganization() { return _organization; }

/** The admin contact string, or null. */
export function getPolicyAdminContact() { return _adminContact; }

/** The SHA-256 fingerprint of the policy file, or null. */
export function getPolicyHash() { return _policyHash; }

/**
 * The allowed export formats from policy, or null (meaning no restriction).
 * When non-null, any format not in the list should be blocked.
 */
export function getAllowedExportFormats() { return _allowedExportFormats; }

/**
 * A compact audit-ready snapshot of the current policy state. Embed in
 * Trust Certificates and audit log entries so the policy in effect at the
 * time of a validation run is permanently recorded.
 */
export function getPolicySnapshot() {
  if (!_loaded || !_policy) return null;
  return {
    applied: true,
    organization: _organization,
    policyHash: _policyHash,
    disabled: [..._disabled],
    required: [..._required],
    allowedExportFormats: _allowedExportFormats,
    adminContact: _adminContact,
  };
}

/**
 * Reset for testing. Not exported in production -- tests import this directly.
 * @internal
 */
export function _resetPolicyForTesting() {
  _loaded = false;
  _policy = null;
  _disabled = new Set();
  _required = new Set();
  _policyHash = null;
  _organization = null;
  _adminContact = null;
  _allowedExportFormats = null;
}
