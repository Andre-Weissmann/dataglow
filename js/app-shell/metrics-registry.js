// ============================================================
// DATAGLOW — Shared Metrics Registry ("define once" per session)
// ============================================================
// A single in-session source of truth for named metric definitions (e.g.
// "revenue", "active_customer"). A metric is just a NAME bound to a read-only
// SQL expression evaluated over the active dataset's DuckDB table — this module
// never runs SQL and never mutates data; it only stores and compiles the
// expression text so every consuming surface (SQL / Python / R / Visualize /
// Story tab) can reference the same business term the same way within one
// session. This is deliberately NOT a multi-user/org semantic layer: the scope
// is one browser session / one dataset (see js/app-shell/state.js, which keys a
// fresh registry per dataset table name, mirroring the per-table provenance
// chains in js/provenance/provenance.js).
//
// Pure and dependency-free by design (mirrors js/learning/signal-store.js): the
// core is synchronous and needs no engine, so it is Node-testable without
// DuckDB. The optional content fingerprint reuses the existing SHA-256 helper
// (`sha256Hex`) from js/provenance/provenance.js via a LAZY dynamic import, so
// importing this module never eagerly pulls the crypto/provenance chain into
// every consumer — the hash is only loaded if a caller asks for a fingerprint.

// A metric name must be a plain SQL-identifier-shaped token so it is both safe
// to embed and usable as an `@name` reference inside a query (see
// expandMetricReferences below).
const METRIC_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Distinct error type so callers (and tests) can tell a validation rejection
// apart from an unexpected programming error.
export class MetricError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetricError';
  }
}

// Lightweight, engine-free validation of a metric's SQL expression. We do NOT
// build a second SQL parser (DuckDB is the only compute engine — see AGENTS.md);
// we only reject the obvious ways a "metric expression" is not a single
// read-only scalar/aggregate expression, so a bad definition fails loudly at
// define-time instead of producing a confusing DuckDB error later:
//   - empty / non-string
//   - contains a statement terminator (`;`) — a metric is ONE expression, not
//     multiple statements (also the cheapest guard against statement injection)
//   - leads with a SQL statement keyword (SELECT/INSERT/UPDATE/DELETE/…): a
//     metric is an expression like `SUM(amount)`, never a full statement
//   - unbalanced parentheses or an unterminated single-quoted string literal
export function validateSqlExpression(sqlExpression) {
  if (typeof sqlExpression !== 'string') {
    throw new MetricError('Metric SQL expression must be a string.');
  }
  const expr = sqlExpression.trim();
  if (!expr) {
    throw new MetricError('Metric SQL expression cannot be empty.');
  }
  if (expr.includes(';')) {
    throw new MetricError('Metric SQL expression must be a single expression and cannot contain ";".');
  }
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|COPY|PRAGMA|WITH|CALL|EXPORT|INSTALL|LOAD)\b/i.test(expr)) {
    throw new MetricError('Metric SQL expression must be a value expression (e.g. SUM(amount)), not a full SQL statement.');
  }
  // Balanced parentheses and no dangling single-quote string literal. Walk the
  // string tracking whether we are inside a '...' literal (doubled '' escapes).
  let depth = 0;
  let inString = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      if (ch === "'") {
        if (expr[i + 1] === "'") { i++; continue; } // escaped quote
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) throw new MetricError('Metric SQL expression has unbalanced parentheses.');
    }
  }
  if (inString) throw new MetricError('Metric SQL expression has an unterminated string literal.');
  if (depth !== 0) throw new MetricError('Metric SQL expression has unbalanced parentheses.');
  return expr;
}

export function validateMetricName(name) {
  if (typeof name !== 'string' || !METRIC_NAME_RE.test(name.trim())) {
    throw new MetricError('Metric name must start with a letter or underscore and contain only letters, digits, or underscores.');
  }
  return name.trim();
}

// Canonical serialization of the identity-defining fields of a metric — the
// exact string a content fingerprint commits to. Kept stable and explicit so a
// fingerprint is reproducible (matches the provenance module's stepPayload idea).
function canonicalMetricString(metric) {
  return JSON.stringify({
    name: metric.name,
    sqlExpression: metric.sqlExpression,
    unit: metric.unit ?? null,
    description: metric.description ?? null,
  });
}

// Create a fresh, isolated metrics registry. One per dataset session.
export function createMetricsRegistry() {
  const metrics = new Map(); // name -> metric record

  // Define (or, with { overwrite: true }, redefine) a named metric. Returns the
  // stored record. Defining a metric is a SAFE, read-only operation — it only
  // names a SQL expression; it never touches user data. (Any UI that then
  // *propagates* a metric into a query must still be an explicit user action.)
  function defineMetric({ name, sqlExpression, unit = null, description = null } = {}, { overwrite = false } = {}) {
    const cleanName = validateMetricName(name);
    const cleanExpr = validateSqlExpression(sqlExpression);
    const existing = metrics.get(cleanName);
    if (existing && !overwrite) {
      throw new MetricError(`A metric named "${cleanName}" already exists. Pass { overwrite: true } to redefine it.`);
    }
    const record = {
      name: cleanName,
      sqlExpression: cleanExpr,
      unit: unit == null ? null : String(unit),
      description: description == null ? null : String(description),
      // Monotonic per-name version: 1 on first define, bumped on each overwrite,
      // so a consumer can tell whether the definition it cached is still current.
      version: existing ? existing.version + 1 : 1,
      definedAt: Date.now(),
    };
    metrics.set(cleanName, record);
    return { ...record };
  }

  function getMetric(name) {
    const m = metrics.get(typeof name === 'string' ? name.trim() : name);
    return m ? { ...m } : null;
  }

  function hasMetric(name) {
    return metrics.has(typeof name === 'string' ? name.trim() : name);
  }

  function listMetrics() {
    // Stable alphabetical order so UIs render deterministically.
    return [...metrics.values()]
      .map(m => ({ ...m }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function removeMetric(name) {
    return metrics.delete(typeof name === 'string' ? name.trim() : name);
  }

  // Compile a defined metric into a SQL fragment DuckDB can run. The expression
  // is parenthesized so it composes safely wherever it is spliced in; with
  // { alias: true } it is additionally aliased to the metric name for use in a
  // SELECT list. Throws MetricError for an unknown metric.
  function resolveMetricSql(name, { alias = false } = {}) {
    const m = metrics.get(typeof name === 'string' ? name.trim() : name);
    if (!m) throw new MetricError(`No metric named "${name}" is defined in this session.`);
    const frag = `(${m.sqlExpression})`;
    return alias ? `${frag} AS "${m.name}"` : frag;
  }

  // Optional lightweight identity/versioning: SHA-256 over the canonical metric
  // content, reusing the existing provenance helper rather than a second hash.
  async function fingerprint(name) {
    const m = metrics.get(typeof name === 'string' ? name.trim() : name);
    if (!m) throw new MetricError(`No metric named "${name}" is defined in this session.`);
    const { sha256Hex } = await import('../provenance/provenance.js');
    return sha256Hex(canonicalMetricString(m));
  }

  return {
    defineMetric,
    getMetric,
    hasMetric,
    listMetrics,
    removeMetric,
    resolveMetricSql,
    fingerprint,
    get size() { return metrics.size; },
  };
}

// A metric reference inside a query: `@name`. `@` is not otherwise valid DuckDB
// SQL, so treating an `@identifier` token as a metric reference is unambiguous.
const METRIC_REF_RE = /@([A-Za-z_][A-Za-z0-9_]*)/g;

// Expand any `@metric` references in a SQL string into the compiled SQL of the
// named metrics, reading ONLY from the supplied registry — this is the concrete
// "a consuming surface reads from the shared registry" path the SQL tab uses. A
// reference to an undefined metric throws a clear MetricError (rather than
// silently leaving invalid SQL). Returns { sql, used } where `used` lists the
// distinct metric names that were expanded. A query with no `@` references is
// returned unchanged (and needs no registry).
export function expandMetricReferences(sql, registry) {
  if (typeof sql !== 'string') throw new MetricError('SQL to expand must be a string.');
  const used = new Set();
  const out = sql.replace(METRIC_REF_RE, (_match, name) => {
    if (!registry || typeof registry.hasMetric !== 'function' || !registry.hasMetric(name)) {
      throw new MetricError(`Query references metric "@${name}", which is not defined for this dataset.`);
    }
    used.add(name);
    return registry.resolveMetricSql(name);
  });
  return { sql: out, used: [...used] };
}
