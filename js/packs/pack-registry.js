// ============================================================
// DATAGLOW — Domain-pack registry & loader (Gen 40)
// ============================================================
// The runtime seam that turns self-contained pack modules into the pack map the
// Domain Physics engine consumes. Each built-in pack lives in its own file under
// js/packs/builtin/ and exports { manifest, pack }; this loader imports them,
// validates each manifest against the stable extension points, enforces the
// no-network guard on any pack that ships source, and exposes:
//
//   * register(entry)          — validate + record one pack plugin
//   * get(id) / has(id) / list — read the registry
//   * toPackMap()              — the { id -> runtime-pack } map domain-physics.js
//                                installs via setPackSource() behind the
//                                `pluginPacks` feature flag
//   * describeLoadedPacks()    — id / version / industry / provenance for the
//                                public trust & audit surface
//
// The whole point of the architecture: adding, removing, or updating a pack is a
// new file + one `register` line here — it never edits another pack's code or
// the core engine. Two packs can never collide on a shared file again.

import { isExtensionPoint, EXTENSION_POINT_IDS } from './extension-points.js';
import { assertNoNetwork } from './pack-network-guard.js';

// Built-in pack plugins, each a self-contained module. Listed in the canonical
// display order the legacy DOMAIN_PACKS map used, so listPacks() ordering is
// unchanged when the plugin path is active.
import nonePlugin from './builtin/none.pack.js';
import healthcarePlugin from './builtin/healthcare.pack.js';
import retailPlugin from './builtin/retail.pack.js';
import financePlugin from './builtin/finance.pack.js';
import omopPlugin from './builtin/omop.pack.js';
import fhirPlugin from './builtin/fhir.pack.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// Validate a pack manifest + runtime pack. Throws with a specific message on the
// first problem so a malformed plugin is rejected loudly at load time rather
// than silently mis-behaving during a validation run.
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('pack registry: entry must be an object');
  const { manifest, pack } = entry;
  if (!manifest || typeof manifest !== 'object') throw new Error('pack registry: entry.manifest is required');
  if (!pack || typeof pack !== 'object') throw new Error('pack registry: entry.pack is required');

  const { id, version, industry, capabilities, dependencies } = manifest;
  if (typeof id !== 'string' || id.trim() === '') throw new Error('pack manifest: "id" must be a non-empty string');
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) throw new Error(`pack manifest "${id}": "version" must be semver (got ${JSON.stringify(version)})`);
  if (typeof industry !== 'string' || industry.trim() === '') throw new Error(`pack manifest "${id}": "industry" must be a non-empty string`);
  if (pack.name !== id) throw new Error(`pack manifest "${id}": manifest.id must match pack.name ("${pack.name}")`);
  if (!Array.isArray(pack.rules)) throw new Error(`pack manifest "${id}": pack.rules must be an array`);

  if (capabilities == null || typeof capabilities !== 'object') {
    throw new Error(`pack manifest "${id}": "capabilities" must be an object mapping extension points`);
  }
  for (const point of Object.keys(capabilities)) {
    if (!isExtensionPoint(point)) {
      throw new Error(`pack manifest "${id}": unknown extension point "${point}" (allowed: ${EXTENSION_POINT_IDS.join(', ')})`);
    }
  }
  // Dependencies are rare/none for domain packs. Enforce isolation: a pack may
  // not depend on ANOTHER pack, so removing/updating one pack can never break
  // another. An empty object (or omitted) is the norm.
  if (dependencies != null) {
    if (typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error(`pack manifest "${id}": "dependencies" must be an object`);
    }
    if (Object.keys(dependencies).length > 0) {
      throw new Error(`pack manifest "${id}": domain packs must not declare inter-pack dependencies (found ${Object.keys(dependencies).join(', ')})`);
    }
  }

  // No-network guard: if the plugin ships its own source text, scan it now so a
  // pack that references a network primitive is rejected at registration.
  if (typeof entry.source === 'string' && entry.source !== '') {
    assertNoNetwork(entry.source, id);
  }
}

export class PackRegistry {
  constructor() {
    this._entries = new Map(); // id -> { manifest, pack }
  }

  /** Validate and record one pack plugin. Returns the registry (chainable). */
  register(entry) {
    validateEntry(entry);
    const { manifest, pack } = entry;
    if (this._entries.has(manifest.id)) {
      throw new Error(`pack registry: duplicate pack id "${manifest.id}"`);
    }
    this._entries.set(manifest.id, { manifest, pack });
    return this;
  }

  has(id) { return this._entries.has(id); }
  get(id) { const e = this._entries.get(id); return e ? e.pack : undefined; }
  getManifest(id) { const e = this._entries.get(id); return e ? e.manifest : undefined; }

  /** Pack summaries for a UI selector, in registration order. */
  list() {
    return [...this._entries.values()].map(({ pack }) => ({ name: pack.name, label: pack.label, description: pack.description }));
  }

  /**
   * The { id -> runtime-pack } map the Domain Physics engine consumes. This is
   * the exact shape of the legacy DOMAIN_PACKS object, so installing it via
   * domain-physics.setPackSource() is behaviour-preserving.
   */
  toPackMap() {
    const map = {};
    for (const [id, { pack }] of this._entries) map[id] = pack;
    return map;
  }

  /**
   * Loaded-pack provenance for the public trust / audit surface: which packs are
   * active, their versions, the extension points they fill, and the
   * license/provenance of any sample data they ship.
   */
  describeLoadedPacks() {
    return [...this._entries.values()].map(({ manifest }) => ({
      id: manifest.id,
      version: manifest.version,
      industry: manifest.industry,
      extensionPoints: Object.keys(manifest.capabilities || {}),
      provenance: manifest.provenance || null,
    }));
  }
}

// The ordered built-in plugin set. Order matches the legacy DOMAIN_PACKS map.
export const BUILT_IN_PACK_PLUGINS = [
  nonePlugin,
  healthcarePlugin,
  retailPlugin,
  financePlugin,
  omopPlugin,
  fhirPlugin,
];

/**
 * Build a fresh registry populated with the built-in packs. Called once at
 * startup when the `pluginPacks` flag is enabled.
 * @returns {PackRegistry}
 */
export function loadBuiltInPacks() {
  const registry = new PackRegistry();
  for (const plugin of BUILT_IN_PACK_PLUGINS) registry.register(plugin);
  return registry;
}
