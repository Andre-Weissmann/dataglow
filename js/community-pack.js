// ============================================================
// DATAGLOW — Community Pack Sharing (Stage D)
// ============================================================
// File-based sharing of domain packs: export a built-in pack to portable JSON
// and import a portable-JSON pack back into a runtime pack the Domain Physics
// engine can apply. There is NO server, marketplace, or backend — a pack is
// just a JSON file the user downloads and hands to someone else.
//
// SAFETY MODEL (why this is only schema validation, no separate sandbox):
// An imported pack is never trusted code. It is pure DATA that is validated
// here against a strict schema and then compiled through the SAME
// `compilePackRule` path the built-in Retail/Finance packs use. That path can
// only ever produce one of three annotate-only factory rules
// (no-merge / benford-exempt / outlier-context), and each rule's target layer
// is DERIVED from its `kind` via PACK_RULE_LAYERS — never read from the input.
// So an imported pack physically cannot:
//   - hard-fail the user's data (the factories only annotate / downgrade),
//   - auto-merge protected/core categories (no-merge only DISABLES merging),
//   - target a core layer such as unit_tests (the layer is derived, not given).
// The strict schema below IS the safety rail. It rejects unknown keys, bad
// shapes, disallowed regex flags, and oversized inputs before anything compiles.
//
// This module is pure logic (no DOM, no browser globals) so it runs identically
// in headless Node tests. main.js owns the file download/upload wiring.

import {
  PACK_RULE_LAYERS,
  compilePackRule,
  packFromDescriptor,
  DOMAIN_PACKS,
} from './domain-physics.js';

// The envelope tag written into every exported file and required on import, so
// an arbitrary JSON file can't be mistaken for a DATAGLOW pack.
export const PACK_KIND = 'dataglow-domain-pack';

// Bumped only on a breaking change to the portable schema. Import accepts an
// exact match; a different version is rejected with a clear message rather than
// silently mis-parsed.
export const PACK_SCHEMA_VERSION = 1;

// The declarative rule kinds a portable pack may declare. Kept in lockstep with
// the compiler's PACK_RULE_LAYERS keys so a kind is valid here iff the engine
// knows how to compile it.
export const ALLOWED_RULE_KINDS = Object.keys(PACK_RULE_LAYERS);

// Defensive bounds. A shared pack is small hand-authored config; these caps stop
// a hostile file from being pathologically large or from smuggling a
// catastrophic-backtracking regex in through a giant pattern string.
const LIMITS = {
  maxRules: 32,
  maxPatternLength: 512,
  maxStringLength: 2000,
  maxNameLength: 64,
};

// The allowed keys on the envelope, on a pack descriptor, and on a single rule
// descriptor. Anything outside these sets is rejected (strict, closed schema).
const ENVELOPE_KEYS = new Set(['kind', 'schemaVersion', 'pack']);
const PACK_KEYS = new Set(['name', 'label', 'description', 'rules']);
const RULE_KEYS_COMMON = new Set(['kind', 'id', 'description', 'match']);
const RULE_KEYS_BY_KIND = {
  'no-merge': new Set([...RULE_KEYS_COMMON, 'note']),
  'benford-exempt': new Set([...RULE_KEYS_COMMON, 'packLabel', 'note']),
  'outlier-context': new Set([...RULE_KEYS_COMMON, 'packLabel', 'reason']),
};
const MATCH_KEYS = new Set(['pattern', 'flags', 'binaryOnly', 'numericOnly']);
const ALLOWED_MATCH_FLAGS = 'ims';

// Is this a plain data object (not an array, not null)?
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Reject any key on `obj` that isn't in `allowed`, pushing a labelled error.
function rejectUnknownKeys(obj, allowed, label, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`${label}: unknown key "${k}"`);
  }
}

// A required, bounded, non-empty string field.
function checkString(obj, key, label, errors, { max = LIMITS.maxStringLength, required = true } = {}) {
  const v = obj[key];
  if (v == null) {
    if (required) errors.push(`${label}: missing required string "${key}"`);
    return;
  }
  if (typeof v !== 'string') { errors.push(`${label}: "${key}" must be a string`); return; }
  if (required && v.trim() === '') { errors.push(`${label}: "${key}" must not be empty`); return; }
  if (v.length > max) errors.push(`${label}: "${key}" exceeds ${max} characters`);
}

// Validate one rule's `match` spec against the same rules the compiler enforces,
// but reported field-by-field so an import error names the offending field.
function validateMatch(match, label, errors) {
  if (!isPlainObject(match)) { errors.push(`${label}: "match" must be an object`); return; }
  rejectUnknownKeys(match, MATCH_KEYS, `${label}.match`, errors);
  checkString(match, 'pattern', `${label}.match`, errors, { max: LIMITS.maxPatternLength });
  if (match.flags != null) {
    if (typeof match.flags !== 'string') errors.push(`${label}.match: "flags" must be a string`);
    else for (const f of match.flags) {
      if (!ALLOWED_MATCH_FLAGS.includes(f)) errors.push(`${label}.match: disallowed regex flag "${f}"`);
    }
  }
  for (const b of ['binaryOnly', 'numericOnly']) {
    if (match[b] != null && typeof match[b] !== 'boolean') errors.push(`${label}.match: "${b}" must be a boolean`);
  }
  // Compile-once to reject a malformed / uncompilable regex up front.
  if (typeof match.pattern === 'string' && match.pattern.length <= LIMITS.maxPatternLength) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(match.pattern, typeof match.flags === 'string' ? match.flags.replace(/[^ims]/g, '') : '');
    } catch (e) {
      errors.push(`${label}.match: invalid regular expression (${e.message})`);
    }
  }
}

// Validate a single rule descriptor.
function validateRule(rule, idx, errors, seenIds) {
  const label = `pack.rules[${idx}]`;
  if (!isPlainObject(rule)) { errors.push(`${label}: must be an object`); return; }
  const kind = rule.kind;
  if (typeof kind !== 'string' || !ALLOWED_RULE_KINDS.includes(kind)) {
    errors.push(`${label}: "kind" must be one of ${ALLOWED_RULE_KINDS.join(', ')}`);
    return; // can't check kind-specific keys without a valid kind
  }
  rejectUnknownKeys(rule, RULE_KEYS_BY_KIND[kind], label, errors);
  checkString(rule, 'id', label, errors, { max: LIMITS.maxNameLength });
  checkString(rule, 'description', label, errors);
  if (typeof rule.id === 'string') {
    if (seenIds.has(rule.id)) errors.push(`${label}: duplicate rule id "${rule.id}"`);
    else seenIds.add(rule.id);
  }
  validateMatch(rule.match, label, errors);
  // kind-specific required copy fields (mirrors the factory signatures).
  if (kind === 'benford-exempt') {
    checkString(rule, 'packLabel', label, errors, { max: LIMITS.maxNameLength });
    checkString(rule, 'note', label, errors);
  } else if (kind === 'no-merge') {
    checkString(rule, 'note', label, errors);
  } else if (kind === 'outlier-context') {
    checkString(rule, 'packLabel', label, errors, { max: LIMITS.maxNameLength });
    checkString(rule, 'reason', label, errors);
  }
}

/**
 * Strictly validate an imported pack envelope. Pure & read-only.
 * @returns {{valid:boolean, errors:string[], descriptor:object|null}}
 *   descriptor is the inner pack (ready for compilePackRule) only when valid.
 */
export function validateImportedPack(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { valid: false, errors: ['top level: expected a JSON object'], descriptor: null };
  }
  rejectUnknownKeys(obj, ENVELOPE_KEYS, 'envelope', errors);
  if (obj.kind !== PACK_KIND) errors.push(`envelope: "kind" must be "${PACK_KIND}"`);
  if (obj.schemaVersion !== PACK_SCHEMA_VERSION) {
    errors.push(`envelope: "schemaVersion" must be ${PACK_SCHEMA_VERSION}`);
  }

  const pack = obj.pack;
  if (!isPlainObject(pack)) {
    errors.push('envelope: "pack" must be an object');
    return { valid: false, errors, descriptor: null };
  }
  rejectUnknownKeys(pack, PACK_KEYS, 'pack', errors);
  checkString(pack, 'name', 'pack', errors, { max: LIMITS.maxNameLength });
  checkString(pack, 'label', 'pack', errors, { max: LIMITS.maxNameLength });
  checkString(pack, 'description', 'pack', errors);
  // Reserved names that must not be shadowed by an imported pack.
  if (typeof pack.name === 'string' && (pack.name === 'none' || pack.name === 'healthcare')) {
    errors.push(`pack: "name" "${pack.name}" is reserved for a built-in pack`);
  }

  if (!Array.isArray(pack.rules)) {
    errors.push('pack: "rules" must be an array');
  } else if (pack.rules.length === 0) {
    errors.push('pack: "rules" must contain at least one rule');
  } else if (pack.rules.length > LIMITS.maxRules) {
    errors.push(`pack: "rules" exceeds the maximum of ${LIMITS.maxRules}`);
  } else {
    const seenIds = new Set();
    pack.rules.forEach((r, i) => validateRule(r, i, errors, seenIds));
  }

  if (errors.length) return { valid: false, errors, descriptor: null };
  // The validated inner object is exactly a domain-physics descriptor.
  return { valid: true, errors: [], descriptor: { name: pack.name, label: pack.label, description: pack.description, rules: pack.rules } };
}

/**
 * Validate then compile an imported pack into a runtime pack object usable by
 * applyDomainPack. Never throws on bad input — returns {ok, errors, pack}.
 * A compile-time throw (e.g. a regex the validator's lenient flag-strip let
 * through) is caught and surfaced as an error, so import can never crash the app.
 */
export function importPack(obj) {
  const { valid, errors, descriptor } = validateImportedPack(obj);
  if (!valid) return { ok: false, errors, pack: null };
  try {
    const pack = packFromDescriptor(descriptor);
    return { ok: true, errors: [], pack };
  } catch (e) {
    return { ok: false, errors: [`compile failed: ${e.message}`], pack: null };
  }
}

/**
 * Build the portable JSON envelope for a pack. Only packs backed by a
 * declarative descriptor (Retail, Finance, or any imported pack) can be
 * exported; the hand-written healthcare pack and the empty `none` pack have no
 * descriptor and are not portable. Returns {ok, envelope, reason}.
 */
export function exportPack(pack) {
  if (!pack || !pack.descriptor) {
    return {
      ok: false,
      envelope: null,
      reason: 'This pack is not portable — only descriptor-based packs (Retail, Finance, or an imported pack) can be exported.',
    };
  }
  const d = pack.descriptor;
  const envelope = {
    kind: PACK_KIND,
    schemaVersion: PACK_SCHEMA_VERSION,
    pack: {
      name: d.name,
      label: d.label,
      description: d.description,
      rules: d.rules.map(cloneRule),
    },
  };
  return { ok: true, envelope, reason: null };
}

// Copy only the schema-allowed keys of a rule descriptor, so an export can never
// leak an internal field a future descriptor might carry.
function cloneRule(rule) {
  const allowed = RULE_KEYS_BY_KIND[rule.kind] || RULE_KEYS_COMMON;
  const out = {};
  for (const k of allowed) {
    if (rule[k] === undefined) continue;
    out[k] = k === 'match' ? { ...rule.match } : rule[k];
  }
  return out;
}

/** Serialize an export envelope to a pretty JSON string (the file body). */
export function serializePack(pack) {
  const { ok, envelope, reason } = exportPack(pack);
  if (!ok) return { ok: false, json: null, reason };
  return { ok: true, json: JSON.stringify(envelope, null, 2), reason: null };
}

/** The names of the built-in packs that are exportable (have a descriptor). */
export function exportablePackNames() {
  return Object.values(DOMAIN_PACKS).filter(p => p && p.descriptor).map(p => p.name);
}
