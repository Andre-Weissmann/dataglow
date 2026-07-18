# Capability detail — Enterprise & governance

Companion to the **Enterprise & governance** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on org-level deployment controls; the index alone is enough for most tasks.

## What this area is

A single Phase 1 module, `js/build/enterprise-policy.js` — an **enterprise policy
loader**. An IT administrator drops a `dataglow-policy.json` file alongside
`index.html` to enforce an organization-wide configuration with zero source
changes. It is designed to run **once at app init, before feature flags are
evaluated**, so a policy can veto features regardless of their flag state.

**Flag:** none — this module is not gated by `flags.manifest.json`. It is
deployment infrastructure, not a flagged feature, and is **default-open**: with no
policy file present the app behaves exactly as before. Enterprise hardening is
opt-in by the admin.

**Tests:** exercised by `test/trust-certificate-phase1.test.mjs` (a dedicated
"enterprise-policy: parse + apply" section imports `applyEnterprisePolicy`,
`isPolicyDisabled`, `getPolicySnapshot`, `_resetPolicyForTesting`, etc., with a
mocked `fetch`). No standalone `enterprise-policy.test.mjs`.

**Wiring status:** **not currently invoked from `js/app-shell/main.js`** (no
import or call). A committed template, `dataglow-policy.example.json`, ships at the
repo root documenting the file format, and the Trust Certificate test references
`getPolicySnapshot` as the intended embedding point — but the runtime `main.js`
init sequence does not yet call `applyEnterprisePolicy()`. The module is live and
tested but effectively dark until wired into init.

## Module behavior

### Loading (async, once)

`applyEnterprisePolicy()` is idempotent — only the first call has effect (guarded
by `_loaded`). It `fetch()`es `dataglow-policy.json` with `cache: 'reload'`;
a 404 or network error returns `null` (the normal non-enterprise case, not an
error). `parsePolicy` requires valid JSON, an object, and `version === 1`
(`POLICY_VERSION`); a parse/version failure logs a `console.warn` and returns
`null` (fails open). On success it populates in-memory state, computes a **SHA-256
fingerprint** of the raw policy text via `crypto.subtle.digest`, and logs an
`[DATAGLOW policy]` INFO audit line (plus a session-start `[DATAGLOW audit]` line
when `auditLog` is required).

### Policy file shape

- `disable[]` — feature keys to turn off. Known keys: `byokStory`, `webrtcRooms`,
  `cdnFetches`, `federatedLearning`.
- `require[]` — mandates. Known keys: `auditLog`, `enterpriseBuild`.
- `allowedExportFormats[]` — optional export-format allowlist (null = no
  restriction).
- `organization`, `adminContact` — metadata.

Note the policy operates on **feature keys** (e.g. `byokStory`), not on
`flags.manifest.json` flag names directly — a caller is expected to consult
`isPolicyDisabled(key)` at the relevant feature's gate.

### Query API (synchronous after init)

`hasPolicyLoaded()`, `isPolicyDisabled(key)`, `isPolicyRequired(key)`,
`getPolicyOrganization()`, `getPolicyAdminContact()`, `getPolicyHash()`,
`getAllowedExportFormats()`, and `getPolicySnapshot()` — the last returns a
compact audit-ready object (`applied`, `organization`, `policyHash`, `disabled`,
`required`, `allowedExportFormats`, `adminContact`) intended for embedding in
Trust Certificates and audit-log entries so the policy in effect at validation
time is permanently recorded. `_resetPolicyForTesting()` clears all state for
unit tests.

## Related but not in scope

- `dataglow-policy.example.json` (repo root) — the admin-facing template with
  per-key rationale for each disable/require key.
- `js/trust/trust-certificate.js` — the intended consumer of `getPolicySnapshot()`
  for embedding the policy fingerprint in signed artifacts.
- The feature keys named in `disable[]` map to other areas (BYOK Story, Rooms /
  WebRTC, federated learning, CDN loads) whose gates would need to honor
  `isPolicyDisabled` once the loader is wired into init.
