// ============================================================
// DATAGLOW — Semi-Structured JSON Flattener
// ============================================================
// Normalises nested JSON into a flat array of row objects that
// DuckDB can ingest. Handles:
//   - Flat array of objects (passthrough — already valid)
//   - Single object wrapping an array (GitHub /repos, Stripe charges.data)
//   - Deeply nested objects (FHIR bundles, API envelopes)
//   - NDJSON (one JSON object per line)
//   - Arrays of scalars (each value becomes { index, value })
//
// Pure logic — no browser APIs, no async, no side effects.
// Zero-upload: caller already parsed the JSON.
// ============================================================

/**
 * @typedef {{ rows: object[], path: string, confidence: 'high'|'medium'|'low', warning: string|null }} FlattenResult
 */

/**
 * Flatten a parsed JSON value into a row array for DuckDB ingestion.
 * @param {unknown} parsed - already-parsed JSON (not a string)
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=4] - max nesting depth before values are JSON-stringified
 * @param {number} [opts.maxRows=200000]
 * @returns {FlattenResult}
 */
export function flattenJson(parsed, opts = {}) {
  const { maxDepth = 4, maxRows = 200_000 } = opts;

  // 1. Already a flat array of objects — ideal case
  if (Array.isArray(parsed) && parsed.length > 0 && isPlainObj(parsed[0])) {
    const rows = parsed.slice(0, maxRows).map(r => flattenObj(r, maxDepth));
    return { rows, path: '(root array)', confidence: 'high', warning: null };
  }

  // 2. Array of scalars
  if (Array.isArray(parsed) && parsed.length > 0 && !isPlainObj(parsed[0])) {
    const rows = parsed.slice(0, maxRows).map((v, i) => ({ index: i, value: v == null ? null : String(v) }));
    return { rows, path: '(root array of scalars)', confidence: 'medium', warning: 'Array of scalar values — each entry becomes a row with index + value columns.' };
  }

  // 3. Single object — find the first array-of-objects value (BFS)
  if (isPlainObj(parsed)) {
    const found = findFirstArrayPath(parsed, maxDepth);
    if (found) {
      const rows = found.value.slice(0, maxRows).map(r => flattenObj(r, maxDepth));
      return { rows, path: found.path, confidence: 'medium', warning: `Extracted rows from "${found.path}". Other keys in the envelope were discarded.` };
    }
    // Single object, no array inside — treat as one row
    return { rows: [flattenObj(parsed, maxDepth)], path: '(root object)', confidence: 'low', warning: 'Single JSON object — treated as one row. Consider if this is an API envelope.' };
  }

  return { rows: [], path: '', confidence: 'low', warning: 'Could not extract rows from this JSON structure.' };
}

/** Recursively flatten a plain object up to maxDepth. Nested objects are dot-key expanded; arrays are JSON-stringified. */
function flattenObj(obj, maxDepth, prefix = '', depth = 0) {
  if (!isPlainObj(obj)) return { value: obj };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObj(v) && depth < maxDepth) {
      Object.assign(out, flattenObj(v, maxDepth, key, depth + 1));
    } else if (Array.isArray(v)) {
      out[key] = JSON.stringify(v); // arrays in leaf position → string
    } else {
      out[key] = v ?? null;
    }
  }
  return out;
}

/** BFS: find the first key whose value is a non-empty array of plain objects. */
function findFirstArrayPath(obj, maxDepth, prefix = '', depth = 0) {
  if (depth > maxDepth) return null;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v) && v.length > 0 && isPlainObj(v[0])) return { path, value: v };
    if (isPlainObj(v)) {
      const found = findFirstArrayPath(v, maxDepth, path, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse a raw text string that may be JSON or NDJSON.
 * Returns { parsed, isNdjson, error }.
 */
export function parseJsonOrNdjson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { parsed: null, isNdjson: false, error: 'Empty input' };
  }
  // Try standard JSON first
  try {
    return { parsed: JSON.parse(text), isNdjson: false, error: null };
  } catch (_) {}
  // Try NDJSON (newline-delimited JSON objects)
  try {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const rows = lines.map(l => JSON.parse(l));
    if (rows.length > 0 && rows.every(isPlainObj)) {
      return { parsed: rows, isNdjson: true, error: null };
    }
  } catch (_) {}
  return { parsed: null, isNdjson: false, error: 'Could not parse as JSON or NDJSON' };
}

/**
 * Whether a JSON file needs pre-processing through the JSON flattener before
 * DuckDB ingestion. Currently always true — the flattener is a passthrough for
 * already-flat arrays and adds normalization for all other shapes.
 */
export function jsonNeedsFlattening(format) {
  return format === 'json' || format === 'ndjson';
}
