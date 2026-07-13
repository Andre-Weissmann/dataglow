// ============================================================
// DATAGLOW — Open Floor: Read-Only Room Kernel (Batch A)
// ============================================================
// The first primitive of the "DataGlow Open Floor" — a stakeholder-facing,
// server-less exploration surface. A "room" is a thin wrapper around an
// ALREADY-LOADED dataset plus its governed validation / metric state whose
// entire point is that it is read-only BY CONSTRUCTION, not by convention:
//
//   The object this module hands back exposes ONLY read methods. There is no
//   .update(), .delete(), .insert(), .applyFix(), .mutate(), .drop() — those
//   methods do not exist on the surface at all, and the object is frozen so a
//   caller cannot bolt one on. A room therefore cannot mutate the dataset even
//   if a caller (or an autonomous agent handed the room) tries: the capability
//   is simply absent from the type.
//
// It does NOT duplicate the query engine. Read access is a thin delegation to an
// INJECTED reader (in the browser, that is duckdb-engine.js runQuery; in tests,
// a fake) — the same injected-dependency pattern the pack builder's fetcher and
// the firewall's audit recorder use. The room adds exactly one thing on top of
// that reader: it refuses to pass through any statement that is not read-only, so
// the read path cannot be smuggled into a mutation path either. That guard FAILS
// CLOSED — anything it cannot positively classify as a single read-only statement
// is rejected.
//
// This module is PURE: no DOM, no network, no storage, no engine import. It is
// fully unit-testable in Node with a fake reader.

// ------------------------------------------------------------
// Read-only SQL classification (fail closed)
// ------------------------------------------------------------
// A room may only run statements that read. The allowlist is the set of leading
// keywords DuckDB treats as read/introspection statements; everything else — and
// anything ambiguous — is rejected. This is deliberately conservative: a false
// rejection is a caller inconvenience, a false acceptance is a data mutation, so
// the asymmetry is intentional.

const READ_ONLY_LEADERS = Object.freeze([
  'select', 'with', 'from', 'values', 'table',
  'describe', 'show', 'explain', 'summarize', 'pragma_table_info',
]);

// Keywords that mutate schema or data (or reach outside the sandbox). If any of
// these appears as a statement keyword the text is rejected outright, even when
// the statement happens to lead with SELECT (e.g. a chained
// "SELECT 1; DROP TABLE t").
const MUTATING_KEYWORDS = Object.freeze([
  'insert', 'update', 'delete', 'drop', 'create', 'alter', 'truncate',
  'replace', 'merge', 'upsert', 'attach', 'detach', 'copy', 'export',
  'import', 'install', 'load', 'set', 'reset', 'call', 'vacuum', 'analyze',
  'grant', 'revoke', 'begin', 'commit', 'rollback', 'checkpoint',
]);

// Strip SQL comments and string/identifier literals so the keyword scan can't be
// fooled by a keyword that only appears inside a comment or a quoted string.
function stripSqlNoise(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')          // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/'(?:[^']|'')*'/g, "''")    // single-quoted strings
    .replace(/"(?:[^"]|"")*"/g, '""')    // double-quoted identifiers
    .replace(/\$\$[\s\S]*?\$\$/g, ' ');  // dollar-quoted strings
}

/**
 * Decide whether a SQL string is a single, read-only statement the room may run.
 * Pure and total (never throws). Returns a reason on rejection so callers/tests
 * can see WHY. Fails closed: empty/blank/multi-statement/mutating → not read-only.
 * @param {string} sql
 * @returns {{ok:boolean, reason?:string}}
 */
export function classifyReadOnlySql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { ok: false, reason: 'empty or non-string statement' };
  }
  const cleaned = stripSqlNoise(sql).trim();
  if (cleaned === '') return { ok: false, reason: 'statement is only comments/literals' };

  // Reject statement chaining: at most one statement, and only a single trailing
  // semicolon is tolerated. A second statement after a `;` is a classic way to
  // ride a read into a write.
  const withoutTrailing = cleaned.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return { ok: false, reason: 'multiple statements are not allowed in a read-only room' };
  }

  const lowered = ` ${withoutTrailing.toLowerCase()} `;
  for (const kw of MUTATING_KEYWORDS) {
    // Word-boundary match so "created_at" doesn't trip the "create" keyword.
    if (new RegExp(`(^|[^a-z0-9_])${kw}([^a-z0-9_]|$)`).test(lowered)) {
      return { ok: false, reason: `statement contains a non-read keyword: "${kw}"` };
    }
  }

  const firstWord = withoutTrailing.toLowerCase().match(/^[a-z_]+/);
  const leader = firstWord ? firstWord[0] : '';
  if (!READ_ONLY_LEADERS.includes(leader)) {
    return { ok: false, reason: `statement does not lead with a read-only keyword (got "${leader || '?'}")` };
  }
  return { ok: true };
}

/** Thrown when a caller asks a room to run something that is not read-only. */
export class ReadOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyViolation';
    this.readOnlyRoom = true;
  }
}

// Deep-freeze a plain JSON-ish value so a room's snapshots can't be mutated by a
// caller holding the reference. Arrays and plain objects only; primitives pass
// through. Cyclic structures are not expected here (validation/metric state is
// serialized-shape), so a simple recursive freeze is sufficient.
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    return Object.freeze(value);
  }
  return value;
}

// Structured-clone-ish snapshot (JSON round-trip) so the room hands out a COPY of
// governed state, never a live reference the caller could mutate. Falls back to
// the original frozen value if it isn't JSON-serializable.
function snapshot(value) {
  if (value == null) return value;
  try {
    return deepFreeze(JSON.parse(JSON.stringify(value)));
  } catch {
    return deepFreeze(value);
  }
}

/**
 * Create a read-only room around an already-loaded dataset.
 *
 * @param {object} args
 * @param {object} args.dataset   the loaded dataset descriptor
 *                                 ({ name, table, rowCount, cols, ... } — the
 *                                 shape state.js already holds). Copied, frozen.
 * @param {(sql:string)=>Promise<any>} args.read  injected reader (browser:
 *                                 duckdb-engine runQuery; tests: a fake). The
 *                                 room NEVER constructs its own engine.
 * @param {object} [args.validation]  the governed validation state (layerId ->
 *                                 result). Snapshotted + frozen; optional.
 * @param {object} [args.metrics]  governed metric state. Snapshotted + frozen.
 * @returns {Readonly<object>} a frozen room whose surface is read-only ONLY.
 */
export function createReadOnlyRoom({ dataset, read, validation = null, metrics = null } = {}) {
  if (!dataset || typeof dataset !== 'object') {
    throw new Error('createReadOnlyRoom: a loaded dataset descriptor is required.');
  }
  if (typeof read !== 'function') {
    throw new Error('createReadOnlyRoom: a read(sql) reader function must be injected (the room does not own an engine).');
  }

  const table = typeof dataset.table === 'string' ? dataset.table : String(dataset.table ?? '');
  const name = typeof dataset.name === 'string' ? dataset.name : table;
  const columns = Array.isArray(dataset.cols)
    ? dataset.cols.map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean)
    : [];
  const rowCount = Number.isFinite(dataset.rowCount) ? dataset.rowCount : null;

  const frozenSchema = deepFreeze({ name, table, columns: columns.slice(), rowCount });
  const frozenValidation = validation == null ? null : snapshot(validation);
  const frozenMetrics = metrics == null ? null : snapshot(metrics);

  // The ONLY execution path a room exposes. Guards the statement, then delegates
  // to the injected reader. No overload, option, or flag relaxes the guard.
  async function query(sql) {
    const verdict = classifyReadOnlySql(sql);
    if (!verdict.ok) {
      throw new ReadOnlyViolation(
        `Open Floor room "${name}" is read-only: refusing this statement — ${verdict.reason}.`
      );
    }
    return read(sql);
  }

  const room = {
    // Marker + identity (read-only data, frozen).
    isReadOnlyRoom: true,
    name,
    table,

    // Governed-state readers — all hand back frozen copies, never live refs.
    describe() { return frozenSchema; },
    getColumns() { return frozenSchema.columns; },
    getRowCount() { return frozenSchema.rowCount; },
    getValidationState() { return frozenValidation; },
    getMetrics() { return frozenMetrics; },

    // The single, guarded read execution path.
    query,
  };

  // Read-only BY CONSTRUCTION: freeze the surface so a caller cannot attach a
  // .update/.delete/etc. method after the fact. There is deliberately no setter,
  // no writable field, and no mutating method anywhere above.
  return Object.freeze(room);
}
