// ============================================================
// DATAGLOW — Local Analysis Contract
// ============================================================
// Before an analyst trusts a SQL query — their own, or one an AI assistant
// wrote for them — this module checks it against the REAL schema of the
// dataset already loaded in DuckDB, entirely offline, and reports the exact
// failure classes that 2026 research on AI-generated SQL found dominate
// real-world mistakes:
//
//   • Schema hallucination  — a referenced column/table doesn't exist, or is
//     a near-miss of one that does (case difference, singular/plural, common
//     synonym). Cited research: schema-level errors (wrong column selection,
//     semantic misinterpretation) account for the large majority of real
//     incorrect-SQL failures, far more than syntax errors.
//   • Aggregation mismatches — COUNT(*) where COUNT(DISTINCT ...) was almost
//     certainly meant (duplicate-inflated counts), or SUM over a column whose
//     name suggests it's already an average/rate/percentage.
//   • Missing guard clauses — an aggregate query with no WHERE at all touching
//     a column whose name suggests it distinguishes real rows from noise
//     (test/demo/deleted/refunded/cancelled flags) — the "forgot to exclude
//     test accounts" class of business-logic gap.
//
// (Join fan-out risk is deliberately NOT covered here — it is owned by
// js/ambient/ambient-validation.js's checkSanityAnchor, which now also uses
// real uniqueness stats when a schema is available, so there is exactly one
// place in the codebase that owns that concern instead of two competing
// checkers.)
//
// THIS MODULE NEVER REWRITES, BLOCKS, OR AUTO-FIXES A QUERY. It only produces
// a list of flags for a human to read before running (or after running, next
// to the result) — the same "suggestion only, never an autonomous edit"
// contract every other agent-shaped module in this repo (question-generator,
// uncertainty-resolver, rule-suggestions) already holds itself to. Calling
// code decides whether/how to surface the flags; this module makes no DOM
// call and touches no network primitive, so it is unit-testable in plain
// Node with a hand-built schema — no DuckDB, no browser required.
//
// A flagged query is not proven wrong, and an unflagged query is not proven
// right — this is a fast, local, pattern-based pre-flight, not a full SQL
// semantic analyzer. It is deliberately conservative about false positives
// (see the guard-clause heuristic's column-name allowlist) because a tool
// that cries wolf gets ignored.
//
// A fourth, OPT-IN check — metric definition mismatch — lives in
// js/validation/semantic-layer.js and runs only when the caller passes a
// non-empty metric registry via runAnalysisContract(sql, schema, { metrics }).
// It is gated at the call site behind its own `semanticMetricsLayer` flag
// (OFF by default), so with no metrics supplied this module behaves exactly as
// it did before that feature existed: the same three finding classes, unchanged.

import { checkQueryAgainstMetrics } from './semantic-layer.js';

// ------------------------------------------------------------
// Tiny, dependency-free SQL tokenizer.
// Good enough to find identifiers, clauses, and function calls in typical
// analyst SQL; it is NOT a full parser and makes no claim to handle every
// valid SQL construct (nested CTEs with exotic syntax, dialect-specific
// extensions, etc.) — see README/CHANGELOG caveat.
// ------------------------------------------------------------

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

// Reserved words that must never be treated as a table/column reference even
// though they appear as bare identifiers in a query.
const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'join', 'inner',
  'left', 'right', 'full', 'outer', 'on', 'as', 'and', 'or', 'not', 'in', 'is',
  'null', 'like', 'between', 'limit', 'offset', 'distinct', 'count', 'sum',
  'avg', 'min', 'max', 'case', 'when', 'then', 'else', 'end', 'union', 'all',
  'with', 'insert', 'update', 'delete', 'create', 'table', 'into', 'values',
  'set', 'exists', 'asc', 'desc', 'true', 'false', 'over', 'partition', 'cast',
  'coalesce', 'nullif', 'extract', 'interval', 'date', 'timestamp', 'using',
]);

// Common DuckDB/SQL scalar, aggregate, and window function names. Bug fix
// 2026-07-17: the schema-hallucination check was flagging ANY function call
// not in this list as a "hallucinated reference" (e.g. `ROUND(...)`,
// `UPPER(...)`, `ROW_NUMBER()`), because a bare identifier immediately
// followed by `(` was never being distinguished from a column/table
// reference. This list backs up the structural function-call check below
// (`isFunctionCallIdentifier`) — kept as a second, independent layer so a
// function name is still recognized even in the rare case the regex-based
// call-site detection misses a slightly unusual formatting.
const SQL_FUNCTION_NAMES = new Set([
  // math
  'round', 'abs', 'ceil', 'ceiling', 'floor', 'power', 'pow', 'sqrt', 'mod',
  'exp', 'ln', 'log', 'log10', 'log2', 'sign', 'trunc', 'random', 'greatest',
  'least',
  // string
  'upper', 'lower', 'trim', 'ltrim', 'rtrim', 'concat', 'concat_ws',
  'substring', 'substr', 'length', 'len', 'replace', 'lpad', 'rpad',
  'split_part', 'regexp_matches', 'regexp_replace', 'regexp_extract',
  'string_split', 'strip_accents', 'printf', 'format', 'left', 'right',
  'reverse', 'repeat', 'position', 'instr', 'ascii', 'chr', 'starts_with',
  'contains',
  // date/time
  'now', 'current_date', 'current_time', 'current_timestamp', 'strftime',
  'strptime', 'date_trunc', 'date_part', 'datediff', 'date_add', 'date_sub',
  'age', 'to_timestamp', 'epoch', 'epoch_ms', 'make_date', 'make_timestamp',
  'year', 'month', 'day', 'hour', 'minute', 'second',
  // aggregate / statistical
  'median', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop',
  'var_samp', 'percentile_cont', 'percentile_disc', 'mode', 'corr',
  'covar_pop', 'covar_samp', 'any_value', 'list', 'array_agg', 'string_agg',
  'group_concat', 'first', 'last', 'arbitrary', 'bool_and', 'bool_or',
  // window
  'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead', 'percent_rank',
  'cume_dist', 'first_value', 'last_value', 'nth_value',
  // type / null handling
  'cast', 'try_cast', 'isnan', 'isinf', 'typeof', 'ifnull', 'nvl',
  // json / struct / list (DuckDB-specific, common in analyst queries)
  'json_extract', 'json_extract_string', 'unnest', 'struct_pack', 'list_value',
]);

// True when the identifier at index `idx` (its match position in `sql`) is
// immediately followed by optional whitespace then `(` — i.e. it's being
// called as a function, not referenced as a column/table. This is a
// structural check (works for ANY function name, not just ones in a
// hardcoded list) and is the primary fix for the false-positive bug above;
// `SQL_FUNCTION_NAMES` is kept as a secondary belt-and-suspenders layer.
function isFunctionCallIdentifier(sql, matchIndex, identifier) {
  const after = sql.slice(matchIndex + identifier.length);
  return /^\s*\(/.test(after);
}

const AGGREGATE_FNS = ['count', 'sum', 'avg', 'min', 'max'];

// Column-name fragments that usually signal "this distinguishes real rows
// from noise" — used ONLY as a heuristic hint for the missing-guard-clause
// check, never as a hard rule. Kept short and specific on purpose: broad
// terms like "status" or "flag" alone would false-positive constantly.
const GUARD_HINT_FRAGMENTS = [
  'is_test', 'test_account', 'is_deleted', 'deleted_at', 'is_refunded',
  'refunded', 'is_cancelled', 'is_canceled', 'cancelled_at', 'canceled_at',
  'is_bot', 'is_demo', 'is_sample', 'is_internal', 'is_fraud',
];

function tokenizeIdentifiers(sql) {
  return (sql.match(IDENT_RE) || []).map(t => t);
}

// Same tokens as tokenizeIdentifiers, but keeps each match's index in `sql`
// so callers can inspect what immediately follows a given occurrence (e.g.
// to detect a function call via `isFunctionCallIdentifier`). Kept as a
// separate function rather than changing tokenizeIdentifiers's return shape,
// so existing callers of the plain-strings version are unaffected.
function tokenizeIdentifiersWithIndex(sql) {
  const out = [];
  let m;
  const re = new RegExp(IDENT_RE.source, 'g');
  while ((m = re.exec(sql)) !== null) {
    out.push({ text: m[0], index: m.index });
  }
  return out;
}

// Case-insensitive Levenshtein distance, capped small — this only needs to
// catch near-misses like "cusotmer_id" vs "customer_id" or "Revenue" vs
// "revenue_usd", not do general fuzzy search.
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = cur;
  }
  return prev[n];
}

// ------------------------------------------------------------
// Schema shape this module consumes. Callers build this from whatever the
// real engine returns (e.g. DuckDB's DESCRIBE) — this module never queries
// DuckDB itself, so it stays testable without one.
//   schema = {
//     tables: {
//       [tableName]: {
//         columns: [{ name, type }],
//         rowCount: number | null,       // optional, improves fan-out check
//         approxDistinct: { [col]: n },  // optional, improves fan-out check
//       }
//     }
//   }
// ------------------------------------------------------------

export function buildSchemaIndex(schema) {
  const allColumns = new Map(); // lowercase column name -> [{table, name, type}]
  const tableNames = new Set(Object.keys(schema.tables || {}));
  for (const [tableName, t] of Object.entries(schema.tables || {})) {
    for (const col of t.columns || []) {
      const key = col.name.toLowerCase();
      if (!allColumns.has(key)) allColumns.set(key, []);
      allColumns.get(key).push({ table: tableName, name: col.name, type: col.type });
    }
  }
  return { tableNames, allColumns, tables: schema.tables || {} };
}

// ------------------------------------------------------------
// Check 1 — Schema hallucination.
// Any bare identifier in the query that (a) isn't a SQL keyword, (b) isn't a
// known table name, and (c) doesn't match any known column across any loaded
// table gets flagged. If a close spelling match exists (edit distance <= 2,
// or same after stripping common suffixes), the flag names it as the likely
// intended column so the fix is obvious at a glance.
// ------------------------------------------------------------

// AS-aliases (`SELECT sum(x) AS total`, `FROM orders AS o`) name a NEW label
// that only exists in this query's output/scope — they are never a reference
// into the loaded schema, so checking them against real columns would be a
// guaranteed false positive on every query that names its output columns.
function extractAliasNames(sql) {
  const aliases = new Set();
  const asRe = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = asRe.exec(sql)) !== null) aliases.add(m[1].toLowerCase());
  return aliases;
}

export function checkSchemaHallucination(sql, schemaIndex) {
  const flags = [];
  const seen = new Set();
  const idents = tokenizeIdentifiersWithIndex(sql);
  const knownColumnNames = Array.from(schemaIndex.allColumns.keys());
  const aliasNames = extractAliasNames(sql);

  // Safety net: with no known columns at all there is nothing to compare
  // against, so every identifier would otherwise be reported as a hard-fail
  // "hallucinated reference". That happens only when the schema is genuinely
  // unavailable (e.g. the live-catalog lookup in the caller failed and no file
  // was loaded), never because the query is wrong — so degrade to a single
  // low-severity note instead of a wall of false failures.
  if (knownColumnNames.length === 0) {
    return [{
      kind: 'schema_hallucination',
      severity: 'info',
      identifier: null,
      suggestion: null,
      message: 'No schema was available, so the column/table existence check was skipped for this query.',
    }];
  }

  for (const { text: raw, index } of idents) {
    const ident = raw;
    const lower = ident.toLowerCase();
    if (SQL_KEYWORDS.has(lower)) continue;
    // Function call, e.g. `ROUND(...)`, `ROW_NUMBER()` — a call site is never
    // a column/table reference regardless of whether the function name is a
    // reserved word. Structural check first (works for any function name),
    // `SQL_FUNCTION_NAMES` as a secondary guard for unusual formatting.
    if (isFunctionCallIdentifier(sql, index, ident)) continue;
    if (SQL_FUNCTION_NAMES.has(lower)) continue;
    if (schemaIndex.tableNames.has(ident) || Array.from(schemaIndex.tableNames).some(t => t.toLowerCase() === lower)) continue;
    if (schemaIndex.allColumns.has(lower)) continue; // real column, fine
    if (aliasNames.has(lower)) continue; // a query-defined output label, not a schema reference
    if (/^\d+$/.test(ident)) continue; // pure number, not an identifier we care about
    if (seen.has(lower)) continue;

    // Only flag identifiers that look like they were meant as a column/table
    // reference — skip very short tokens (aliases like `t`, `a`) which are
    // too ambiguous to judge and would just produce noise.
    if (ident.length < 3) continue;

    seen.add(lower);

    let bestMatch = null;
    let bestDist = Infinity;
    for (const known of knownColumnNames) {
      const d = levenshtein(lower, known);
      if (d < bestDist) { bestDist = d; bestMatch = known; }
    }
    const closeEnough = bestMatch && bestDist <= Math.min(2, Math.ceil(bestMatch.length * 0.3));

    flags.push({
      kind: 'schema_hallucination',
      severity: closeEnough ? 'warn' : 'fail',
      identifier: ident,
      suggestion: closeEnough ? bestMatch : null,
      message: closeEnough
        ? `"${ident}" doesn't match any column in the loaded data. Did you mean "${bestMatch}"?`
        : `"${ident}" doesn't match any table or column in the loaded data — this looks like a hallucinated reference.`,
    });
  }
  return flags;
}

function hasAggregateInSelect(sql) {
  const selectPart = (sql.match(/select\s+(.+?)\s+from\s/is) || [])[1] || '';
  const lower = selectPart.toLowerCase();
  return AGGREGATE_FNS.some(fn => lower.includes(fn + '('));
}

// ------------------------------------------------------------
// Check 2 — Aggregation mismatches.
// NOTE: join fan-out detection deliberately lives in
// js/ambient/ambient-validation.js (checkSanityAnchor), not here — this
// module used to duplicate that check with a more precise, stats-aware
// version. Instead of shipping two competing join-fanout checkers, the extra
// precision (real uniqueness percentages, GROUP BY grain awareness) was
// folded into checkSanityAnchor directly, so there is exactly one place that
// owns this concern. See ambient-validation.js's module header for the
// upgraded behaviour.
// (a) COUNT(*) or COUNT(col) where a duplicate-prone join or GROUP BY is in
//     play, and DISTINCT was very plausibly intended.
// (b) SUM(col) where the column's own name suggests it is already a
//     ratio/rate/average/percentage (summing an average is a classic silent
//     bug — the result is meaningless but looks like a normal number).
// ------------------------------------------------------------

const RATE_LIKE_FRAGMENTS = ['rate', 'ratio', 'avg', 'average', 'percent', 'pct', 'proportion'];

export function checkAggregationMismatch(sql) {
  const flags = [];
  const selectPart = (sql.match(/select\s+(.+?)\s+from\s/is) || [])[1] || '';

  const countCalls = [...selectPart.matchAll(/count\s*\(\s*(distinct\s+)?([^)]*)\)/gi)];
  const joinCount = (sql.match(/\bjoin\b/gi) || []).length;
  for (const m of countCalls) {
    const isDistinct = !!m[1];
    const arg = (m[2] || '').trim();
    if (!isDistinct && joinCount > 0 && arg !== '' ) {
      flags.push({
        kind: 'aggregation_mismatch',
        severity: 'info',
        aggregate: 'COUNT',
        message: `COUNT(${arg}) runs across ${joinCount} JOIN${joinCount > 1 ? 's' : ''} without DISTINCT. If the join can produce more than one matching row per entity, this counts duplicates — consider COUNT(DISTINCT ${arg}) if you mean "how many unique ${arg.replace(/^[a-z_]+\./i, '')}".`,
      });
    }
  }

  const sumCalls = [...selectPart.matchAll(/sum\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/gi)];
  for (const m of sumCalls) {
    const arg = m[1];
    const bare = arg.split('.').pop().toLowerCase();
    if (RATE_LIKE_FRAGMENTS.some(frag => bare.includes(frag))) {
      flags.push({
        kind: 'aggregation_mismatch',
        severity: 'warn',
        aggregate: 'SUM',
        column: arg,
        message: `SUM(${arg}) — the column name suggests "${arg}" is already a rate, ratio, or average. Summing a rate across rows is usually not the intended calculation; consider AVG(${arg}) or a weighted average instead.`,
      });
    }
  }
  return flags;
}

// ------------------------------------------------------------
// Check 3 — Missing guard clauses.
// If the loaded table has a column whose name matches a known "excludes
// noise rows" pattern (test accounts, deleted/refunded/cancelled/bot/demo
// rows) and the query aggregates over that table WITHOUT referencing that
// column anywhere in the query text, flag it. This is deliberately narrow —
// it only fires on a short, specific allowlist of fragments, precisely so it
// doesn't nag about every WHERE-less query.
// ------------------------------------------------------------

export function checkMissingGuardClauses(sql, schemaIndex) {
  const flags = [];
  if (!hasAggregateInSelect(sql)) return flags;

  const lowerSql = sql.toLowerCase();
  const mentionedTables = new Set();
  const fromJoinRe = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = fromJoinRe.exec(sql)) !== null) mentionedTables.add(m[1]);

  for (const tableName of mentionedTables) {
    const t = schemaIndex.tables[tableName];
    if (!t) continue;
    for (const col of t.columns || []) {
      const colLower = col.name.toLowerCase();
      const hint = GUARD_HINT_FRAGMENTS.find(frag => colLower.includes(frag));
      if (!hint) continue;
      // "referenced anywhere" is intentionally loose (not just WHERE) so a
      // guard applied via a CTE, a JOIN condition, or a CASE expression still
      // counts and this doesn't nag about queries that already handle it.
      if (lowerSql.includes(colLower)) continue;
      flags.push({
        kind: 'missing_guard_clause',
        severity: 'info',
        table: tableName,
        column: col.name,
        message: `"${tableName}" has a column named "${col.name}" but this query never references it. If some rows are test/demo/deleted/refunded/cancelled data, this aggregate may include rows you meant to exclude.`,
      });
    }
  }
  return flags;
}

// ------------------------------------------------------------
// Top-level entry point — runs the three schema/aggregation/guard checks and,
// when a metric registry is supplied, the opt-in metric-definition check, then
// returns one report. Never throws on a query it can't fully parse; a check
// that can't extract what it needs simply contributes no flags for that check,
// rather than failing the whole contract (graceful degradation, matching the
// rest of this codebase's convention for optional/best-effort analysis).
//
// `options.metrics` is the ONLY way the fourth (metric-definition-mismatch)
// check runs. When it is absent or empty, this function's output is identical
// to before the semantic layer existed — three finding classes, byte-for-byte.
// ------------------------------------------------------------

export function runAnalysisContract(sql, schema, options = {}) {
  const schemaIndex = buildSchemaIndex(schema);
  const checks = [
    ['schema_hallucination', checkSchemaHallucination],
    ['aggregation_mismatch', checkAggregationMismatch],
    ['missing_guard_clause', checkMissingGuardClauses],
  ];

  const flags = [];
  for (const [name, fn] of checks) {
    try {
      const result = fn.length === 2 ? fn(sql, schemaIndex) : fn(sql);
      flags.push(...result);
    } catch {
      // A single check's inability to parse this query never blocks the
      // others or the caller — see module header on graceful degradation.
    }
  }

  // Fourth check — opt-in, gated by the caller supplying a metric registry.
  const metrics = options && Array.isArray(options.metrics) ? options.metrics : null;
  if (metrics && metrics.length) {
    try {
      flags.push(...checkQueryAgainstMetrics(sql, metrics));
    } catch {
      // Same graceful-degradation contract as the other checks.
    }
  }

  const severityOrder = { fail: 0, warn: 1, info: 2 };
  flags.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  const worst = flags.reduce((acc, f) => {
    const rank = severityOrder[f.severity] ?? 3;
    return rank < acc ? rank : acc;
  }, 3);
  const status = worst === 0 ? 'fail' : worst === 1 ? 'warn' : worst === 2 ? 'info' : 'pass';

  return {
    status,
    flagCount: flags.length,
    flags,
    ts: Date.now(),
  };
}

// Plain-language, single-line summary for a compact UI badge — never the
// full flag list, which the caller renders separately.
export function summarizeAnalysisContract(report) {
  if (report.flagCount === 0) return 'No schema, aggregation, or guard-clause issues found in this query.';
  const counts = report.flags.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  const parts = [];
  if (counts.fail) parts.push(`${counts.fail} likely error${counts.fail > 1 ? 's' : ''}`);
  if (counts.warn) parts.push(`${counts.warn} warning${counts.warn > 1 ? 's' : ''}`);
  if (counts.info) parts.push(`${counts.info} note${counts.info > 1 ? 's' : ''}`);
  return `${parts.join(', ')} — review before trusting this result.`;
}
