// ============================================================
// DATAGLOW — Live API / Webhook Feed ingestion
// ============================================================
// Pure-logic layer for the Canvas Live Feed panel.
// Handles URL validation, header parsing, response normalization,
// and polling schedule building — all without touching fetch() or DOM.
//
// The actual fetch() call happens in the Canvas UI layer (browser-only),
// which passes already-parsed JSON/text to these functions.
//
// Zero-upload guarantee: the API endpoint is called directly from the
// user's browser — no DataGlow server ever proxies or stores the response.
// ============================================================

export const FEED_METHODS = ['GET', 'POST'];
export const POLL_INTERVALS_MS = [0, 5000, 15000, 30000, 60000, 300000]; // 0 = one-shot
export const POLL_LABELS = ['One-time fetch', 'Every 5s', 'Every 15s', 'Every 30s', 'Every 1 min', 'Every 5 min'];

/**
 * Validate a URL for use as an API feed endpoint.
 * Returns { valid: boolean, error: string|null, normalized: string|null }.
 */
export function validateFeedUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return { valid: false, error: 'URL is required', normalized: null };
  }
  const trimmed = url.trim();
  let parsed;
  // "localhost:8080/x" and "api.example.com:8443/x" parse as a URL whose
  // scheme is the hostname; treat a bare host:port as a host, not a scheme.
  const bareHostPort = !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && /^[A-Za-z0-9.-]+:\d{1,5}(\/|$|\?|#)/.test(trimmed);
  try { parsed = new URL(bareHostPort ? 'https://' + trimmed : trimmed); } catch (_) {
    // Try adding https://
    try { parsed = new URL('https://' + trimmed); }
    catch (_2) { return { valid: false, error: 'Invalid URL format', normalized: null }; }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: 'Only HTTP and HTTPS endpoints are supported', normalized: null };
  }
  return { valid: true, error: null, normalized: parsed.href };
}

/**
 * Parse a raw headers string (one "Key: Value" per line) into a plain object.
 * Invalid lines are silently skipped.
 */
export function parseHeadersString(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  const out = {};
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

/**
 * Normalize an already-parsed API response (any shape) into DataGlow rows.
 * Delegates to the json-flattener contract (same shape).
 * Returns { rows, path, confidence, warning }.
 */
export function normalizeApiResponse(parsed, opts = {}) {
  // Flat array of objects — ideal
  if (Array.isArray(parsed) && parsed.length > 0 && isPlainObj(parsed[0])) {
    const rows = parsed.slice(0, opts.maxRows || 200_000).map(r => flattenObjShallow(r, 4));
    return { rows, path: '(root array)', confidence: 'high', warning: null };
  }
  // Single object — find first array
  if (isPlainObj(parsed)) {
    const found = findFirstArray(parsed, 4);
    if (found) {
      const rows = found.value.slice(0, opts.maxRows || 200_000).map(r => flattenObjShallow(r, 4));
      return { rows, path: found.path, confidence: 'medium', warning: `Rows extracted from "${found.path}".` };
    }
    return { rows: [flattenObjShallow(parsed, 4)], path: '(root object)', confidence: 'low', warning: 'Single object — treated as one row.' };
  }
  // Scalar or unknown
  return { rows: [], path: '', confidence: 'low', warning: 'Could not extract rows from API response.' };
}

function isPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function flattenObjShallow(obj, maxDepth, prefix = '', depth = 0) {
  if (!isPlainObj(obj)) return { value: obj };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObj(v) && depth < maxDepth) Object.assign(out, flattenObjShallow(v, maxDepth, key, depth + 1));
    else if (Array.isArray(v) || isPlainObj(v)) out[key] = JSON.stringify(v);
    else out[key] = v ?? null;
  }
  return out;
}

function findFirstArray(obj, maxDepth, prefix = '', depth = 0) {
  if (depth > maxDepth) return null;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v) && v.length > 0 && isPlainObj(v[0])) return { path, value: v };
    if (isPlainObj(v)) { const f = findFirstArray(v, maxDepth, path, depth + 1); if (f) return f; }
  }
  return null;
}

/**
 * Build a polling schedule descriptor from user config.
 */
export function buildPollSchedule(intervalMs, method, url, headers) {
  const labelIdx = POLL_INTERVALS_MS.indexOf(intervalMs);
  return {
    intervalMs,
    label: labelIdx >= 0 ? POLL_LABELS[labelIdx] : `Every ${intervalMs / 1000}s`,
    method: FEED_METHODS.includes(method) ? method : 'GET',
    url,
    headers: headers || {},
    isOneShot: intervalMs === 0,
  };
}

/**
 * Build a DataGlow-compatible dataset meta block for a live feed result.
 */
export function buildFeedDataset(rows, url, pollSchedule, fetchedAt) {
  return {
    // Union of keys across ALL rows (first-seen order). Using only rows[0]
    // silently dropped any field that first appears in a later record, which is
    // normal for sparse API data.
    columns: unionColumns(rows),
    rows,
    meta: {
      source: url,
      format: 'api',
      fetchedAt: fetchedAt || new Date().toISOString(),
      pollSchedule: pollSchedule.label,
      note: `Live API feed from ${url}. ${pollSchedule.isOneShot ? 'One-time fetch.' : 'Auto-refreshes ' + pollSchedule.label + '.'}`
    }
  };
}

function unionColumns(rows) {
  const seen = new Set();
  const cols = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isPlainObj(r)) continue;
    for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  }
  return cols;
}
