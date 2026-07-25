// ============================================================
// DATAGLOW - Capability registry as data (validator)
// ============================================================
// WHY this exists. capability-map.manifest.json is the machine-readable answer
// to "what does DataGlow actually do, and is that claim real?". The existing
// drift detector (.github/scripts/capability-drift.mjs) already proves the
// FILES behind a capability exist. This script proves the CLAIM around them is
// honest, by pinning two fields per capability that a human would otherwise be
// free to write by hand:
//
//   relatedFlags - the feature flags in flags.manifest.json that gate this
//                  capability. A flag whose name kebab-cases to a capability id
//                  (shieldPacks -> shield-packs) MUST be listed there, so a
//                  capability cannot quietly drop its flag link.
//   status       - DERIVED, never authored freely:
//                    "shipped"     every backing file exists and every related
//                                  flag is enabled (or there is no flag at all).
//                    "behind-flag" at least one related flag ships disabled, so
//                                  the capability is present in the tree but not
//                                  on for users.
//
// Because status is re-derived here and compared to what is committed, a
// capability cannot claim "shipped" while its flag ships off, and flipping a
// flag off without updating the map fails CI instead of leaving a stale claim
// in the docs. That is the whole point: no fake shipped claims.
//
// PLATFORM VOCABULARY. The manifest uses ["browser","desktop","mobile"], the
// closed set js/app-shell/capability-registry.js reads at runtime and the drift
// detector enforces. Product copy says web / desktop / PWA: "browser" is the web
// surface AND the installed PWA (same code, same origin, one manifest), and
// "mobile" is the forward-looking Tauri mobile target, unused today. This script
// keeps the runtime vocabulary rather than inventing a second one.
//
// USAGE:
//   npm run check:capability-map              # verify (this is what CI runs)
//   npm run check:capability-map -- --update  # re-derive status/relatedFlags
//                                             # after a deliberate change
//
// Pure and read-only in verify mode: no network, no browser, no mutation.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(scriptDir);

export const VALID_PLATFORMS = ['browser', 'desktop', 'mobile'];
export const VALID_STATUSES = ['shipped', 'behind-flag'];

/** camelCase flag name to the capability id it would gate. */
export function flagToCapabilityId(flagName) {
  return String(flagName == null ? '' : flagName)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * The flags that gate a capability: those already declared plus any flag whose
 * name maps onto this capability's id. Sorted and de-duplicated so the derived
 * value is stable.
 */
export function deriveRelatedFlags(cap, flags) {
  const declared = Array.isArray(cap.relatedFlags) ? cap.relatedFlags : [];
  const matched = Object.keys(flags).filter((f) => flagToCapabilityId(f) === cap.id);
  return Array.from(new Set(declared.concat(matched))).sort();
}

/**
 * Honest status for a capability. Any related flag that does not ship enabled
 * means the capability is behind a flag, whatever the manifest says.
 */
export function deriveStatus(cap, flags, relatedFlags) {
  const names = relatedFlags || deriveRelatedFlags(cap, flags);
  for (const name of names) {
    const flag = flags[name];
    if (!flag || flag.enabled !== true) return 'behind-flag';
  }
  return 'shipped';
}

/**
 * The normalized record: the five fields a consumer of the registry can rely on
 * regardless of which optional manifest fields a capability happens to carry.
 * `title` is the manifest's human-readable `name`.
 */
export function normalizeCapability(cap, flags) {
  const relatedFlags = deriveRelatedFlags(cap, flags || {});
  return {
    id: cap.id,
    title: cap.name || cap.id,
    status: deriveStatus(cap, flags || {}, relatedFlags),
    relatedFlags: relatedFlags,
    platforms: Array.isArray(cap.platforms) ? cap.platforms.slice() : [],
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Validate the capability map against the flag manifest and the tree.
 * @returns {{failures:string[], notes:string[], registry:object[]}}
 */
export function runCheck({ root = REPO_ROOT } = {}) {
  const failures = [];
  const notes = [];
  const manifestPath = join(root, 'capability-map.manifest.json');
  const flagsPath = join(root, 'flags.manifest.json');

  if (!existsSync(manifestPath)) {
    return { failures: ['capability-map.manifest.json not found'], notes, registry: [] };
  }
  if (!existsSync(flagsPath)) {
    return { failures: ['flags.manifest.json not found'], notes, registry: [] };
  }

  let manifest;
  let flagsDoc;
  try {
    manifest = readJson(manifestPath);
  } catch (e) {
    return { failures: [`capability-map.manifest.json is not valid JSON: ${e.message}`], notes, registry: [] };
  }
  try {
    flagsDoc = readJson(flagsPath);
  } catch (e) {
    return { failures: [`flags.manifest.json is not valid JSON: ${e.message}`], notes, registry: [] };
  }

  const flags = (flagsDoc && flagsDoc.flags) || {};
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (capabilities.length === 0) {
    failures.push('capability-map.manifest.json: "capabilities" is empty; the registry would describe nothing');
  }

  const seen = new Set();
  const registry = [];

  for (const cap of capabilities) {
    const label = cap.id || cap.name || '(unnamed capability)';

    if (typeof cap.id !== 'string' || cap.id.trim() === '') {
      failures.push(`${label}: every capability needs a non-empty string id`);
      continue;
    }
    if (seen.has(cap.id)) failures.push(`${cap.id}: duplicate capability id`);
    seen.add(cap.id);

    if (typeof cap.name !== 'string' || cap.name.trim() === '') {
      failures.push(`${cap.id}: needs a non-empty "name" (the registry title)`);
    }

    if (!Array.isArray(cap.platforms) || cap.platforms.length === 0) {
      failures.push(`${cap.id}: needs a non-empty "platforms" list`);
    } else {
      const bad = cap.platforms.filter((p) => !VALID_PLATFORMS.includes(p));
      if (bad.length) failures.push(`${cap.id}: invalid platform value(s) ${bad.join(', ')}`);
    }

    if (cap.relatedFlags != null && !Array.isArray(cap.relatedFlags)) {
      failures.push(`${cap.id}: "relatedFlags" must be an array of flag names`);
    }
    for (const name of Array.isArray(cap.relatedFlags) ? cap.relatedFlags : []) {
      if (!Object.prototype.hasOwnProperty.call(flags, name)) {
        failures.push(`${cap.id}: relatedFlags names "${name}", which is not in flags.manifest.json`);
      }
    }

    const relatedFlags = deriveRelatedFlags(cap, flags);
    const declared = Array.isArray(cap.relatedFlags) ? cap.relatedFlags.slice().sort() : [];
    if (JSON.stringify(declared) !== JSON.stringify(relatedFlags)) {
      failures.push(
        `${cap.id}: relatedFlags is out of date.\n` +
        `  recorded ${JSON.stringify(declared)}\n  derived  ${JSON.stringify(relatedFlags)}\n` +
        '  Fix: npm run check:capability-map -- --update',
      );
    }

    const status = deriveStatus(cap, flags, relatedFlags);
    if (!VALID_STATUSES.includes(cap.status)) {
      failures.push(`${cap.id}: status must be one of ${VALID_STATUSES.join(' | ')} (found ${JSON.stringify(cap.status)})`);
    } else if (cap.status !== status) {
      failures.push(
        `${cap.id}: status claims "${cap.status}" but the flags say "${status}".\n` +
        '  Fix: npm run check:capability-map -- --update',
      );
    }

    const files = Array.isArray(cap.files) ? cap.files : [];
    const missing = files.filter((f) => !existsSync(join(root, f)));
    if (missing.length && status === 'shipped') {
      failures.push(`${cap.id}: claims shipped but these files are missing: ${missing.join(', ')}`);
    }

    registry.push(normalizeCapability(cap, flags));
  }

  // A flag that maps onto a capability id must be linked from that capability.
  for (const name of Object.keys(flags)) {
    const id = flagToCapabilityId(name);
    if (!seen.has(id)) continue;
    const cap = capabilities.find((c) => c.id === id);
    const declared = Array.isArray(cap.relatedFlags) ? cap.relatedFlags : [];
    if (!declared.includes(name)) {
      failures.push(`${id}: flag "${name}" gates this capability but is not in its relatedFlags`);
    }
  }

  const byStatus = registry.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  notes.push(`registry: ${registry.length} capability(ies) normalized to { id, title, status, relatedFlags, platforms }`);
  notes.push(`status: ${VALID_STATUSES.map((s) => `${byStatus[s] || 0} ${s}`).join(', ')}`);
  notes.push(`flags: ${Object.keys(flags).length} declared, ${registry.filter((r) => r.relatedFlags.length).length} capability(ies) flag-linked`);

  return { failures, notes, registry };
}

/* The manifest is committed ASCII-escaped (\uXXXX), the convention every earlier
   editor used. Re-encoding 41 escaped characters as raw UTF-8 would bury the
   real diff, so the writer below keeps the file ASCII. */
function toAsciiJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u0080-\uffff]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/** Re-derive status + relatedFlags in place and write the manifest back. */
function update(root) {
  const manifestPath = join(root, 'capability-map.manifest.json');
  const manifest = readJson(manifestPath);
  const flags = readJson(join(root, 'flags.manifest.json')).flags || {};
  for (const cap of manifest.capabilities || []) {
    const relatedFlags = deriveRelatedFlags(cap, flags);
    cap.relatedFlags = relatedFlags;
    cap.status = deriveStatus(cap, flags, relatedFlags);
  }
  writeFileSync(manifestPath, toAsciiJson(manifest) + '\n', 'utf8');
  console.log(`check-capability-map: re-derived status + relatedFlags for ${manifest.capabilities.length} capability(ies)`);
}

function main() {
  if (process.argv.includes('--update')) {
    update(REPO_ROOT);
    return;
  }
  const { failures, notes } = runCheck({ root: REPO_ROOT });
  for (const n of notes) console.log(`  ok  ${n}`);
  if (failures.length > 0) {
    console.error(`\ncheck-capability-map: ${failures.length} problem(s)\n`);
    for (const f of failures) console.error(`  FAIL  ${f}\n`);
    process.exit(1);
  }
  console.log('\ncheck-capability-map: capability registry is honest against flags.manifest.json');
}

if (process.argv[1] && process.argv[1].endsWith('check-capability-map.mjs')) {
  main();
}
