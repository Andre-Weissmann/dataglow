// ============================================================
// DATAGLOW — Semantic / Metrics Layer
// ============================================================
// A local, in-memory metric-definition registry plus a pattern-based comparator
// that the Local Analysis Contract (js/validation/analysis-contract.js) can call
// to flag a FOURTH failure class beyond the three it already checks:
//
//   • Metric definition mismatch — a query computes something it CLAIMS is a
//     registered metric (via a column alias that matches the metric's name, or
//     a comment naming it) but the actual expression differs from that metric's
//     registered canonical definition. The canonical example the industry keeps
//     hitting: a dataset registers `net_revenue` as
//     `SUM(amount) - SUM(refund_amount)`, but a query writes
//     `SUM(amount) AS net_revenue` — silently dropping the refund term. The
//     number looks right and is wrong.
//
// WHY THIS EXISTS: text-to-SQL and hand-written SQL both go wrong far more often
// on what a business metric MEANS ("net revenue" meaning five different things
// across one company) than on SQL syntax. A place to write down the canonical
// definition, and a cheap local check that a query matches it, closes that gap
// without a server, a model, or a network call.
//
// HONEST NAMING: this is NOT "AI-powered". It is a plain in-memory dictionary of
// human-authored metric definitions plus a string/pattern comparator. It does
// not parse SQL into a full AST — it reuses the same lightweight tokenizing /
// SELECT-item splitting approach as analysis-contract.js, so it stays testable
// in plain Node with no DuckDB and no browser. A heavily-rewritten but equivalent
// query can therefore slip past it (a documented false-negative — see
// docs/tech-debt-tracker.md), and a flagged query is a prompt to look, never a
// proof of error.
//
// EMPOWERMENT CONSTRAINT: every function here either stores exactly what a human
// typed (registerMetric) or returns a list of flags (checkQueryAgainstMetrics).
// Nothing rewrites, blocks, auto-corrects, or auto-authors a metric — a human
// defines the metric and a human decides what to do with a flag.
//
// PERSISTENCE: the registry is in-memory only and resets on reload — the same
// "no localStorage / no cookies / no network" philosophy the feature-flag reader
// (js/build/build-flags.js) and the runtime domain-pack registry
// (domain-physics.registerRuntimePack) already follow for user-authored content.
// Making these definitions portable (export/import as a file, like the community
// pack) is deliberately out of scope for this batch; later Trust Passport batches
// build on the { getRegisteredMetrics, checkQueryAgainstMetrics } shape below.

// ------------------------------------------------------------
// Registry (in-memory, module-scoped). Keyed by lowercased metric name so
// `Net_Revenue` and `net_revenue` are the same metric.
// ------------------------------------------------------------

const registry = new Map();

// Reserved words / function names that must never be treated as a column
// reference when deriving a metric's required columns from its expression.
// Kept in step with analysis-contract.js's tokenizer vocabulary.
const EXPR_KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'as', 'and',
  'or', 'not', 'in', 'is', 'null', 'case', 'when', 'then', 'else', 'end',
  'distinct', 'count', 'sum', 'avg', 'min', 'max', 'cast', 'coalesce', 'nullif',
  'over', 'partition', 'interval', 'true', 'false',
]);

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Pull the column-like identifiers out of a SQL expression, dropping keywords,
 * aggregate/function names, and pure numbers. Table qualifiers are stripped
 * (`o.refund_amount` → `refund_amount`) so a definition and a query that use
 * different table aliases still line up.
 * @param {string} expression
 * @returns {string[]} lowercased column names, de-duplicated, in first-seen order
 */
export function deriveColumnsFromExpression(expression) {
  const out = [];
  const seen = new Set();
  // Strip table-qualifier prefixes first so `o.amount` contributes `amount`.
  const cleaned = String(expression || '').replace(/\b[A-Za-z_][A-Za-z0-9_]*\.(?=[A-Za-z_])/g, '');
  for (const raw of cleaned.match(IDENT_RE) || []) {
    const lower = raw.toLowerCase();
    if (EXPR_KEYWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * Register (or overwrite) a human-authored metric definition. This stores
 * EXACTLY what it is given — it never infers or invents a definition. `name`
 * and `expression` are required; everything else is optional provenance.
 *
 * @param {object} def
 * @param {string} def.name          e.g. "net_revenue"
 * @param {string} def.expression    canonical SQL expression, e.g. "SUM(amount) - SUM(refund_amount)"
 * @param {string} [def.description] human-readable meaning
 * @param {string[]} [def.requiredColumns] columns the expression references;
 *   derived from `expression` when omitted
 * @param {string} [def.owner]       who defined it (provenance)
 * @param {number|string} [def.createdAt] when it was defined; defaults to now
 * @returns {object} the normalized, stored definition (a copy)
 */
export function registerMetric(def) {
  if (!def || typeof def !== 'object') throw new Error('registerMetric: a definition object is required');
  const name = String(def.name || '').trim();
  const expression = String(def.expression || '').trim();
  if (!name) throw new Error('registerMetric: `name` is required');
  if (!expression) throw new Error('registerMetric: `expression` is required');

  const requiredColumns = Array.isArray(def.requiredColumns) && def.requiredColumns.length
    ? def.requiredColumns.map(c => String(c).toLowerCase())
    : deriveColumnsFromExpression(expression);

  const stored = {
    name,
    expression,
    description: def.description ? String(def.description) : '',
    requiredColumns,
    owner: def.owner ? String(def.owner) : '',
    createdAt: def.createdAt != null ? def.createdAt : Date.now(),
  };
  registry.set(name.toLowerCase(), stored);
  return { ...stored };
}

/** All registered metric definitions (copies), in insertion order. */
export function getRegisteredMetrics() {
  return [...registry.values()].map(m => ({ ...m }));
}

/** A single registered metric by name (case-insensitive), or null. */
export function getMetric(name) {
  const m = registry.get(String(name || '').toLowerCase());
  return m ? { ...m } : null;
}

/** Remove a metric by name (case-insensitive). Returns true if one was removed. */
export function unregisterMetric(name) {
  return registry.delete(String(name || '').toLowerCase());
}

/** Clear the whole registry (used by tests / a fresh session). */
export function clearMetrics() {
  registry.clear();
}

// ------------------------------------------------------------
// Comparator.
// ------------------------------------------------------------

// Collapse an expression to a comparable canonical form: lowercase, no
// whitespace, no quoting, no table-qualifier prefixes. This is intentionally
// coarse — it treats `SUM(o.amount)-SUM(o.refund_amount)` and
// `sum(amount) - sum(refund_amount)` as equal, but does NOT understand that
// `a - b` equals `-b + a`. That algebraic blind spot is the documented
// false-negative this pattern-based (not AST) approach accepts on purpose.
function normalizeExpr(expr) {
  return String(expr || '')
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\.(?=[A-Za-z_])/g, '') // drop table qualifiers
    .replace(/["'`]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// Split a SELECT list into top-level items, respecting parentheses so a comma
// inside COUNT(a, b) or a function call doesn't split an item.
function splitSelectItems(selectList) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const ch of selectList) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current);
  return items;
}

// Extract the SELECT list text (between the first SELECT and its FROM). Returns
// '' when it can't be found — the caller then simply produces no alias claims.
function extractSelectList(sql) {
  const m = /select\s+([\s\S]+?)\s+from\s/i.exec(sql);
  return m ? m[1] : '';
}

// Alias claims: `<expr> AS <alias>` select items whose alias names a metric.
// AS is required (a bare trailing alias is too easily confused with the
// expression itself, so we stay conservative to avoid false positives).
function collectAliasClaims(sql) {
  const claims = [];
  for (const item of splitSelectItems(extractSelectList(sql))) {
    const m = /^([\s\S]*?)\s+as\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*$/i.exec(item.trim());
    if (!m) continue;
    const expr = m[1].trim();
    if (!expr) continue;
    claims.push({ name: m[2], expr, source: 'alias' });
  }
  return claims;
}

// Comment claims: a metric name mentioned in a -- line comment or a /* */ block
// comment. Expression is unknown from a comment alone.
function collectCommentText(sql) {
  const parts = [];
  for (const m of sql.matchAll(/--([^\n]*)/g)) parts.push(m[1]);
  for (const m of sql.matchAll(/\/\*([\s\S]*?)\*\//g)) parts.push(m[1]);
  return parts.join(' ').toLowerCase();
}

/**
 * Check a raw SQL string against a set of registered metric definitions and
 * return metric-definition-mismatch flags. Pure and side-effect free.
 *
 * @param {string} sql
 * @param {Array<object>} [metrics] the registry to check against; defaults to
 *   the module's in-memory registry (getRegisteredMetrics()). Passing an
 *   explicit array keeps this fully unit-testable without module state.
 * @returns {Array<object>} flags, each shaped like an analysis-contract finding:
 *   { kind:'metric_definition_mismatch', severity, metric, expected, found,
 *     missingColumns, message }
 */
export function checkQueryAgainstMetrics(sql, metrics) {
  const flags = [];
  if (typeof sql !== 'string' || !sql.trim()) return flags;
  const defs = Array.isArray(metrics) ? metrics : getRegisteredMetrics();
  if (!defs.length) return flags;

  const byName = new Map();
  for (const d of defs) {
    if (d && d.name) byName.set(String(d.name).toLowerCase(), d);
  }

  const normalizedSql = normalizeExpr(sql);
  const commentText = collectCommentText(sql);
  const seen = new Set(); // one flag per metric name at most

  // --- Alias claims: the strong signal, `<expr> AS <metric_name>`. ---
  for (const claim of collectAliasClaims(sql)) {
    const def = byName.get(claim.name.toLowerCase());
    if (!def) continue;
    if (seen.has(def.name.toLowerCase())) continue;

    if (normalizeExpr(claim.expr) === normalizeExpr(def.expression)) continue; // matches the definition — fine

    seen.add(def.name.toLowerCase());
    const queryCols = deriveColumnsFromExpression(claim.expr);
    const missingColumns = (def.requiredColumns || []).filter(c => !queryCols.includes(c));
    const missingHint = missingColumns.length
      ? ` This query never references ${missingColumns.map(c => `"${c}"`).join(', ')} — you may be missing a term.`
      : '';
    flags.push({
      kind: 'metric_definition_mismatch',
      severity: 'warn',
      metric: def.name,
      expected: def.expression,
      found: claim.expr,
      missingColumns,
      message: `This query computes "${claim.expr}" AS ${def.name}, but the registered definition of "${def.name}" is "${def.expression}".${missingHint} Confirm you mean the same metric before trusting this result.`,
    });
  }

  // --- Comment claims: a weaker signal. Only flag when the canonical
  // expression is NOT present anywhere in the query AND a required column is
  // missing, so we don't nag about a comment that merely names a metric the
  // query does compute correctly. ---
  for (const def of defs) {
    const key = def.name.toLowerCase();
    if (seen.has(key)) continue;
    if (!commentText.includes(key)) continue;
    if (normalizedSql.includes(normalizeExpr(def.expression))) continue; // canonical expression is present — fine

    const missingColumns = (def.requiredColumns || []).filter(c => !normalizedSql.includes(c));
    if (!missingColumns.length) continue; // all required columns present — don't cry wolf

    seen.add(key);
    flags.push({
      kind: 'metric_definition_mismatch',
      severity: 'info',
      metric: def.name,
      expected: def.expression,
      found: null,
      missingColumns,
      message: `A comment names "${def.name}", whose registered definition is "${def.expression}", but this query never references ${missingColumns.map(c => `"${c}"`).join(', ')}. Confirm the query matches the metric's definition.`,
    });
  }

  return flags;
}
