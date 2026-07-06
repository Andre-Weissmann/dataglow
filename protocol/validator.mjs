// ============================================================
// DATAGLOW Protocol — dependency-free JSON Schema validator
// ============================================================
// A small, self-contained validator for the subset of JSON Schema
// (draft 2020-12) used by the DATAGLOW protocol schemas. It exists so that
// BOTH the browser app and external clients can validate payloads with ZERO
// third-party dependencies and no build step — the same constraint the rest of
// DATAGLOW ships under.
//
// This is intentionally NOT a full JSON Schema implementation. It supports only
// the keywords the DATAGLOW schemas actually use:
//   type, enum, const, required, properties, additionalProperties,
//   items, minItems, minLength, maxLength, pattern, minimum, maximum,
//   $ref (local "#/$defs/..." and cross-file by $id via a registry),
//   oneOf, anyOf, allOf, format (date-time).
//
// For anything more elaborate, an external client is free to use a full
// validator (ajv, jsonschema, etc.) — the schemas are standard JSON Schema.
// See protocol/README.md.

const TYPE_CHECKS = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  integer: v => typeof v === 'number' && Number.isInteger(v),
  boolean: v => typeof v === 'boolean',
  object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: v => Array.isArray(v),
  null: v => v === null,
};

function applyPointer(node, fragment, ref) {
  if (!fragment || fragment === '') return node;
  const parts = fragment.replace(/^\//, '').split('/');
  for (const p of parts) {
    // JSON Pointer unescaping (~1 -> /, ~0 -> ~)
    const key = p.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node && node[key];
    if (node === undefined) throw new Error(`$ref not found: ${ref}`);
  }
  return node;
}

// Resolve a $ref. Local "#/..." refs resolve against `root`. Cross-file refs
// (an absolute $id, optionally with a #fragment) resolve against `registry`,
// a map of $id -> schema. Returns { schema, root } so nested refs inside the
// resolved schema resolve against the correct document.
function resolveRef(ref, root, registry) {
  const [base, fragment = ''] = ref.split('#');
  if (base === '') {
    return { schema: applyPointer(root, fragment, ref), root };
  }
  const target = registry && registry[base];
  if (!target) throw new Error(`$ref to unknown schema "${base}" — provide it in the registry`);
  return { schema: applyPointer(target, fragment, ref), root: target };
}

function typeMatches(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some(t => TYPE_CHECKS[t] ? TYPE_CHECKS[t](value) : false);
}

// A minimal, non-anchored RFC 3339 date-time check (good enough to catch
// obviously-malformed timestamps without pulling in a date library).
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validateNode(value, schema, root, path, errors, registry) {
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push(`${path}: schema is "false" — no value is valid`); return; }

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root, registry);
    validateNode(value, resolved.schema, resolved.root, path, errors, registry);
    return;
  }

  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      errors.push(`${path}: must equal const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    }
  }

  if (schema.enum !== undefined) {
    const ok = schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value));
    if (!ok) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
    return; // further keyword checks assume the type matched
  }

  // ---- string ----
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`);
    if (schema.format === 'date-time' && !DATE_TIME_RE.test(value)) errors.push(`${path}: not a valid RFC 3339 date-time`);
  }

  // ---- number ----
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }

  // ---- array ----
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.items !== undefined) {
      value.forEach((item, i) => validateNode(item, schema.items, root, `${path}[${i}]`, errors, registry));
    }
  }

  // ---- object ----
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateNode(value[key], sub, root, `${path}.${key}`, errors, registry);
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (props[key] !== undefined) continue;
        if (schema.additionalProperties === false) {
          errors.push(`${path}: additional property "${key}" is not allowed`);
        } else if (typeof schema.additionalProperties === 'object') {
          validateNode(value[key], schema.additionalProperties, root, `${path}.${key}`, errors, registry);
        }
      }
    }
  }

  // ---- combinators ----
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateNode(value, sub, root, path, errors, registry);
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some(sub => { const e = []; validateNode(value, sub, root, path, e, registry); return e.length === 0; });
    if (!ok) errors.push(`${path}: does not match any schema in anyOf`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(sub => { const e = []; validateNode(value, sub, root, path, e, registry); return e.length === 0; });
    if (matches.length !== 1) errors.push(`${path}: matched ${matches.length} schemas in oneOf (exactly 1 required)`);
  }
}

// Validate `data` against `schema`. Returns { valid, errors: string[] }.
// `schema` is used as its own $ref resolution root (for "#/$defs/..." refs).
// `registry` (optional) maps $id -> schema for cross-file $ref resolution.
export function validate(data, schema, registry = {}) {
  const errors = [];
  const reg = { ...registry };
  if (schema.$id && !reg[schema.$id]) reg[schema.$id] = schema;
  validateNode(data, schema, schema, '$', errors, reg);
  return { valid: errors.length === 0, errors };
}

// Convenience for call sites that only care about pass/fail.
export function isValid(data, schema, registry = {}) {
  return validate(data, schema, registry).valid;
}

// Build a registry ($id -> schema) from an array of schema objects.
export function buildRegistry(schemas) {
  const reg = {};
  for (const s of schemas) if (s && s.$id) reg[s.$id] = s;
  return reg;
}
