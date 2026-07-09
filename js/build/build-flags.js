// ============================================================
// DATAGLOW — build-time feature flags (Build Nervous System, Stage 4)
// ============================================================
// A tiny, framework-agnostic feature-flag reader. It holds an in-memory map of
// flag -> record and answers isEnabled(name). It is deliberately trivial and
// carries ZERO platform coupling:
//
//   * no localStorage, no cookies, no sessionStorage;
//   * no fetch / network of its own;
//   * no Node fs / no DOM.
//
// So the exact same module runs identically in the browser bundle, inside the
// Tauri desktop webview, and in any future Tauri mobile build. It never decides
// HOW the bundled flags.manifest.json is read — the caller loads that JSON
// however its platform already loads bundled JSON (the app fetches same-origin
// bundled manifests today; a test can import the object directly) and hands the
// parsed object to configureFlags() once at startup. Keeping the I/O out of here
// is what keeps the module portable.
//
// This ships as a pattern for future PRs to copy; per the ticket it is NOT wired
// into any existing module's behavior. See docs/build-nervous-system.md (Stage 4)
// and the promote-or-delete flag-hygiene rule documented there.

// The single source of truth at runtime: flag name -> record. Populated once by
// configureFlags(); empty until then, so isEnabled() safely returns false for a
// flag before the manifest has been loaded.
const flagStore = new Map();

// Accept either the full manifest shape ({ flags: { ... } }, matching
// flags.manifest.json) or a bare { name: record } map, so callers can pass the
// parsed manifest directly without unwrapping it first.
function extractFlagMap(manifest) {
  if (!manifest || typeof manifest !== 'object') return {};
  if (manifest.flags && typeof manifest.flags === 'object') return manifest.flags;
  return manifest;
}

/**
 * Populate the in-memory flag store from a parsed manifest object. Call once at
 * startup. Replaces any previously configured flags. Non-object records and the
 * leading "_about" documentation key are ignored.
 * @param {object} manifest parsed flags.manifest.json (or a bare flag map)
 * @returns {number} how many flags were loaded
 */
export function configureFlags(manifest) {
  flagStore.clear();
  const map = extractFlagMap(manifest);
  for (const [name, record] of Object.entries(map)) {
    if (name === '_about') continue;
    if (record && typeof record === 'object') {
      flagStore.set(name, record);
    }
  }
  return flagStore.size;
}

/**
 * Whether a flag is enabled. Unknown flags — and any flag consulted before
 * configureFlags() has run — are treated as disabled (false), so a missing flag
 * fails safe rather than throwing.
 * @param {string} flagName
 * @returns {boolean}
 */
export function isEnabled(flagName) {
  const record = flagStore.get(flagName);
  return record ? record.enabled === true : false;
}

/**
 * The full record for a flag ({ enabled, addedInPR, description }), or null if
 * the flag is not present. Useful for the promote-or-delete hygiene check.
 * @param {string} flagName
 * @returns {object|null}
 */
export function getFlag(flagName) {
  return flagStore.get(flagName) || null;
}

/** All currently configured flag names. */
export function listFlags() {
  return [...flagStore.keys()];
}

/** Clear the store (mainly for tests / re-initialization). */
export function resetFlags() {
  flagStore.clear();
}
