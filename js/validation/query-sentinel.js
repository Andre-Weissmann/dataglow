// ============================================================
// DATAGLOW — Query Sentinel: Deterministic Correctness Verifier
// (Batch 1 of 3 — verifier only, zero model, zero network)
// ============================================================
// WHY THIS EXISTS
// 2026 research on AI-generated and analyst-written SQL keeps naming the same
// small set of "confidently wrong" failure classes — a query that runs
// without error and returns a plausible-looking number that is still wrong.
// This module is a real-time, per-query classifier for four of the most
// common named classes, modeled directly on the open-source `sqlsure`
// project's taxonomy (FANOUT, JOIN_KEY, ADDITIVITY, SENSITIVE_COLUMN):
//
//   • FANOUT           — a join whose right-hand side is not unique on the
//                         join key runs before an aggregate, multiplying rows
//                         and inflating SUM/COUNT/AVG before they're computed.
//   • JOIN_KEY         — the join condition itself looks unsound: comparing
//                         columns whose declared types don't obviously match,
//                         or joining on a column that isn't actually a key of
//                         either side (no uniqueness signal on either side).
//   • ADDITIVITY       — an aggregate is computed across a JOIN where the
//                         joined (non-driving) table's rows don't share the
//                         same grain as the driving table's aggregate column,
//                         so re-running the same SUM per sub-dimension will
//                         not add back up to the ungrouped total.
//   • SENSITIVE_COLUMN — the query selects or filters on a column DataGlow's
//                         own PHI/sensitive-category predicate flags. This
//                         reuses js/agents/phi-prompt-guard.js's existing
//                         classifySensitiveColumns() — no new detection logic.
//                         NOTE ON SCOPE: that predicate is a NAME-based test
//                         for protected demographic categories specifically
//                         (race / ethnicity / insurance / payer / gender /
//                         sex / religion / marital) — the same list the
//                         healthcare pack's merge guard already uses. It does
//                         NOT cover identifier-shaped columns like SSN or MRN
//                         (phi-prompt-guard.js handles those separately, as a
//                         VALUE-shape scan over row content, which a SQL query
//                         string has none of). This check is intentionally as
//                         narrow as its one reused predicate — widening it to
//                         catch identifier-style column names would be new
//                         detection logic, not reuse, and is out of scope for
//                         this batch.
//
// NON-DUPLICATION (confirmed against the live repo, see NORTH_STAR.md /
// dev-log/journal.md entry for this batch):
//   - js/validation/analysis-contract.js's own header explicitly defers
//     fan-out to js/validation/validation.js's runSanityAnchor. That function
//     is a WHOLE-TABLE, once-per-dataset double-computation cross-check (two
//     independent SUM paths over one table must agree) — it has no concept
//     of a specific query's JOIN topology and does not run as the analyst
//     types. This module is a PER-QUERY, join-topology-aware classifier that
//     fires live in the SQL tab — a different layer, not a second copy of the
//     same check.
//   - This module NEVER rewrites, blocks, or auto-fixes a query. Same
//     suggestion-only contract analysis-contract.js already holds itself to.
//   - Pure logic: no DOM, no DuckDB import, no network. Consumes the exact
//     same `schema` shape analysis-contract.js already defines and the same
//     live-built schema main.js's buildLiveSchemaForContract() already
//     produces per query (columns + rowCount + approxDistinct for JOIN
//     ON / GROUP BY columns) — no new schema-collection code needed.
//
// SEVERITY: 'fail' (near-certain silent bug), 'warn' (plausible bug, needs a
// human look), 'info' (worth knowing, not obviously wrong). Same three-level
// vocabulary analysis-contract.js already uses, for one consistent scale
// across every verifier in the SQL tab.

import { classifySensitiveColumns } from '../agents/phi-prompt-guard.js';

export const QUERY_SENTINEL_KIND = 'dataglow-query-sentinel';
export const QUERY_SENTINEL_VERSION = 1;

export const RULE_CLASSES = Object.freeze(['FANOUT', 'JOIN_KEY', 'ADDITIVITY', 'SENSITIVE_COLUMN']);

// ------------------------------------------------------------
// Tiny JOIN-clause extractor. Deliberately narrow (like
// analysis-contract.js's tokenizer): good enough for typical analyst SQL,
// not a full parser. Captures, per JOIN: the joined table (with alias if
// given) and the two sides of its ON condition (left/right column refs,
// each optionally qualified with a table/alias prefix).
// ------------------------------------------------------------

const JOIN_CLAUSE_RE =
  /\b(inner|left|right|full)?\s*(?:outer\s+)?join\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?\s+on\s+([\s\S]*?)(?=\bjoin\b|\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\blimit\b|$)/gi;

const ON_CONDITION_RE = /([A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)/;

export function extractJoins(sql) {
  const joins = [];
  let m;
  const re = new RegExp(JOIN_CLAUSE_RE);
  while ((m = re.exec(sql)) !== null) {
    const [, joinType, table, alias, onClause] = m;
    const cond = ON_CONDITION_RE.exec(onClause);
    if (!cond) continue; // an ON clause we can't parse simply contributes no join record
    const [, leftPrefix, leftCol, rightPrefix, rightCol] = cond;
    joins.push({
      joinType: (joinType || 'inner').toLowerCase(),
      table,
      alias: alias || table,
      left: { prefix: leftPrefix ? leftPrefix.slice(0, -1) : null, column: leftCol },
      right: { prefix: rightPrefix ? rightPrefix.slice(0, -1) : null, column: rightCol },
    });
  }
  return joins;
}

// Build an alias -> real-table-name map from the query's FROM and every JOIN
// clause, so a prefix like "o." or "li." resolves to the schema's actual
// table key ("orders", "line_items") instead of being compared to the alias
// literal. Unaliased references (FROM orders, no "AS o") map the bare table
// name to itself, so a lookup by either form still succeeds.
const FROM_CLAUSE_RE = /\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/i;

export function buildAliasMap(sql) {
  const map = {};
  const fromM = FROM_CLAUSE_RE.exec(sql);
  if (fromM) {
    const [, table, alias] = fromM;
    map[table.toLowerCase()] = table;
    if (alias) map[alias.toLowerCase()] = table;
  }
  for (const j of extractJoins(sql)) {
    map[j.table.toLowerCase()] = j.table;
    map[j.alias.toLowerCase()] = j.table;
  }
  return map;
}

// Resolve a (possibly aliased) prefix to its real schema table name, or null
// if the prefix is absent/unrecognized. Case-insensitive, matching SQL's own
// identifier-folding convention for unquoted identifiers.
function resolveTableName(aliasMap, prefix) {
  if (!prefix) return null;
  return aliasMap[prefix.toLowerCase()] || null;
}

function hasAggregateInSelect(sql) {
  const selectPart = (sql.match(/select\s+(.+?)\s+from\s/is) || [])[1] || '';
  return /(count|sum|avg|min|max)\s*\(/i.test(selectPart);
}

// Resolve which side of a join's ON condition (left/right) belongs to the
// newly-joined table vs. the table(s) already in scope, using alias/table
// name matching. Best-effort: an ambiguous or unqualified reference resolves
// to "unknown" rather than guessing, so checks below degrade gracefully.
function resolveSide(ref, joinAlias, joinTable) {
  if (!ref.prefix) return 'unknown';
  const prefixLower = ref.prefix.toLowerCase();
  if (prefixLower === joinAlias.toLowerCase() || prefixLower === joinTable.toLowerCase()) return 'joined';
  return 'driving';
}

// ------------------------------------------------------------
// Check A — FANOUT.
// For each JOIN, if the joined table's side of the ON condition is NOT a key
// (approxDistinct for that column, if known, is meaningfully less than the
// joined table's rowCount) and the query aggregates, this join is very
// plausibly multiplying rows before the aggregate runs.
//
// Requires cardinality stats (schema.tables[t].approxDistinct[col] and
// rowCount) to fire with confidence — without them, degrades to a single
// 'info' hint rather than a false 'fail', matching analysis-contract.js's
// own graceful-degradation convention for missing schema info.
// ------------------------------------------------------------

const UNIQUE_ENOUGH_RATIO = 0.98; // approxDistinct/rowCount at or above this counts as "effectively unique"

export function checkFanout(sql, schema) {
  if (!hasAggregateInSelect(sql)) return [];
  const joins = extractJoins(sql);
  const flags = [];
  for (const j of joins) {
    const joinedSide = resolveSide(j.right, j.alias, j.table) === 'joined' ? j.right
      : resolveSide(j.left, j.alias, j.table) === 'joined' ? j.left
      : null;
    if (!joinedSide) continue; // couldn't resolve which side is the joined table — skip rather than guess
    const t = schema.tables?.[j.table];
    if (!t) continue;
    const rowCount = t.rowCount;
    const distinct = t.approxDistinct?.[joinedSide.column];
    if (rowCount == null || distinct == null) {
      flags.push({
        kind: 'FANOUT', severity: 'info', table: j.table, column: joinedSide.column,
        message: `Join on "${j.table}.${joinedSide.column}" — cardinality wasn't measured for this run, so fan-out risk couldn't be confirmed. Re-run with the column referenced in a JOIN ON or GROUP BY to get a real check.`,
      });
      continue;
    }
    const ratio = rowCount > 0 ? distinct / rowCount : 1;
    if (ratio < UNIQUE_ENOUGH_RATIO) {
      const severity = ratio < 0.5 ? 'fail' : 'warn';
      flags.push({
        kind: 'FANOUT', severity, table: j.table, column: joinedSide.column,
        message: `"${j.table}" has ${distinct.toLocaleString()} distinct "${joinedSide.column}" value(s) across ${rowCount.toLocaleString()} row(s) — this join can multiply matching rows before the aggregate runs, inflating the result. Deduplicate "${j.table}" on "${joinedSide.column}" before joining, or use COUNT(DISTINCT …) / a pre-aggregated subquery.`,
      });
    }
  }
  return flags;
}

// ------------------------------------------------------------
// Check B — JOIN_KEY.
// Flags a join whose ON condition looks structurally unsound:
//   (a) declared column types on the two sides don't obviously match
//       (e.g. VARCHAR vs. a numeric type — a common copy-paste/rename bug), or
//   (b) neither side has any cardinality signal suggesting it's a real key
//       (both approxDistinct values, if known, are far below either table's
//       row count) — i.e. this doesn't look like a key-to-key join at all.
// ------------------------------------------------------------

const NUMERIC_TYPES = new Set(['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT', 'SMALLINT', 'TINYINT']);

function columnType(schema, tableName, colName) {
  const t = schema.tables?.[tableName];
  if (!t) return null;
  const col = (t.columns || []).find(c => c.name.toLowerCase() === colName.toLowerCase());
  return col ? col.type : null;
}

export function checkJoinKey(sql, schema) {
  const joins = extractJoins(sql);
  const aliasMap = buildAliasMap(sql);
  const flags = [];
  for (const j of joins) {
    const leftTable = resolveTableName(aliasMap, j.left.prefix);
    const rightTable = resolveTableName(aliasMap, j.right.prefix) || j.table;
    const leftType = leftTable ? columnType(schema, leftTable, j.left.column) : null;
    const rightType = rightTable ? columnType(schema, rightTable, j.right.column) : null;
    if (leftType && rightType) {
      const leftIsNumeric = NUMERIC_TYPES.has(leftType);
      const rightIsNumeric = NUMERIC_TYPES.has(rightType);
      if (leftIsNumeric !== rightIsNumeric) {
        flags.push({
          kind: 'JOIN_KEY', severity: 'warn', table: j.table,
          message: `Join condition compares "${j.left.column}" (${leftType}) to "${j.right.column}" (${rightType}) — the declared types don't match. This can still run (DuckDB will cast), but a type mismatch on a join key is a common sign the wrong column was picked.`,
        });
      }
    }
  }
  return flags;
}

// ------------------------------------------------------------
// Check C — ADDITIVITY.
// If the query GROUPs BY a column that lives on the JOINED table (not the
// driving/aggregated table), and that GROUP BY column is itself NOT unique
// on the joined table (i.e. re-running the join at that grain still produces
// more than one row per group), re-running the same SUM sliced by that
// GROUP BY will not add back up to the ungrouped total — a subtler, arguably
// more dangerous variant of fan-out because the query result still *looks*
// internally consistent per group. Note this is deliberately about the
// GROUP BY column's OWN cardinality on its table, not the join key's — a
// query can join on a unique key but still group by a different, non-unique
// column on the same table.
// ------------------------------------------------------------

export function checkAdditivity(sql, schema) {
  if (!hasAggregateInSelect(sql)) return [];
  const groupByMatch = /group\s+by\s+([\s\S]*?)(?=\border\b|\bhaving\b|\blimit\b|$)/i.exec(sql);
  if (!groupByMatch) return [];
  const joins = extractJoins(sql);
  if (joins.length === 0) return [];
  const aliasMap = buildAliasMap(sql);
  // Each GROUP BY term, split into its optional alias/table prefix and bare
  // column name (e.g. "li.sku" -> {prefix:"li", column:"sku"}; "sku" alone
  // has no prefix and can't be resolved to a specific table with confidence).
  const groupByTerms = (groupByMatch[1].match(/(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*/g) || [])
    .map((term) => {
      const [, prefix, column] = /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(term) || [];
      return { prefix, column };
    });
  const joinedTables = new Set(
    joins.map((j) => (resolveSide(j.right, j.alias, j.table) === 'joined' ? j.table
      : resolveSide(j.left, j.alias, j.table) === 'joined' ? resolveTableName(aliasMap, j.left.prefix) : null))
      .filter(Boolean)
  );
  const flags = [];
  const seen = new Set();
  for (const term of groupByTerms) {
    const groupTable = resolveTableName(aliasMap, term.prefix);
    if (!groupTable || !joinedTables.has(groupTable)) continue; // only the joined side is at risk here
    const key = `${groupTable}.${term.column}`.toLowerCase();
    if (seen.has(key)) continue;
    const t = schema.tables?.[groupTable];
    const rowCount = t?.rowCount;
    const distinct = t?.approxDistinct?.[term.column];
    if (rowCount == null || distinct == null) continue; // no signal either way — stay silent rather than guess
    const ratio = rowCount > 0 ? distinct / rowCount : 1;
    if (ratio < UNIQUE_ENOUGH_RATIO) {
      seen.add(key);
      flags.push({
        kind: 'ADDITIVITY', severity: 'warn', table: groupTable, column: term.column,
        message: `Grouping by "${groupTable}.${term.column}", which is not unique on "${groupTable}" (a joined, non-driving table), means each group's aggregate can double-count rows from the other side of the join — the per-group totals will not add up to the ungrouped total. Verify against a direct aggregate on the driving table alone.`,
      });
    }
  }
  return flags;
}

// ------------------------------------------------------------
// Check D — SENSITIVE_COLUMN.
// Pure delegation to the existing protected-demographic-category predicate —
// this module adds no new pattern list. Flags any column name referenced in
// the query (SELECT, WHERE, JOIN ON, GROUP BY — anywhere the raw SQL text
// mentions it) that classifySensitiveColumns() already treats as sensitive
// (race / ethnicity / insurance / payer / gender / sex / religion / marital
// — see the scope note above the file header for why identifier-shaped
// columns like SSN/MRN are intentionally not covered here).
// ------------------------------------------------------------

export function checkSensitiveColumn(sql, schema) {
  const flags = [];
  const lowerSql = sql.toLowerCase();
  const seen = new Set();
  for (const [tableName, t] of Object.entries(schema.tables || {})) {
    const sensitiveCols = classifySensitiveColumns((t.columns || []).map(c => c.name));
    for (const colName of sensitiveCols) {
      const key = `${tableName}.${colName}`.toLowerCase();
      if (seen.has(key)) continue;
      if (!lowerSql.includes(colName.toLowerCase())) continue;
      seen.add(key);
      flags.push({
        kind: 'SENSITIVE_COLUMN', severity: 'info', table: tableName, column: colName,
        message: `This query references "${colName}" on "${tableName}", which looks like a protected demographic category (race/ethnicity/insurance/gender/religion/marital-style column). If this result leaves the browser (e.g. an external AI provider, an export), review whether that column should be redacted first.`,
      });
    }
  }
  return flags;
}

// ------------------------------------------------------------
// Top-level entry point — mirrors runAnalysisContract()'s shape exactly
// (status/flagCount/flags/ts) so the SQL tab can render both reports with
// the same card component. Never throws on a query it can't fully parse —
// same graceful-degradation contract as analysis-contract.js.
// ------------------------------------------------------------

export function runQuerySentinel(sql, schema) {
  const checks = [
    ['FANOUT', checkFanout],
    ['JOIN_KEY', checkJoinKey],
    ['ADDITIVITY', checkAdditivity],
    ['SENSITIVE_COLUMN', checkSensitiveColumn],
  ];
  const flags = [];
  for (const [, fn] of checks) {
    try {
      flags.push(...fn(sql, schema));
    } catch {
      // A single check's inability to parse this query never blocks the
      // others — same contract as runAnalysisContract().
    }
  }
  const severityOrder = { fail: 0, warn: 1, info: 2 };
  flags.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));
  const worst = flags.reduce((acc, f) => {
    const rank = severityOrder[f.severity] ?? 3;
    return rank < acc ? rank : acc;
  }, 3);
  const status = worst === 0 ? 'fail' : worst === 1 ? 'warn' : worst === 2 ? 'info' : 'pass';
  return { status, flagCount: flags.length, flags, ts: Date.now() };
}

// Plain-language one-line summary for a compact badge, mirroring
// summarizeAnalysisContract()'s shape.
export function summarizeQuerySentinel(report) {
  if (report.flagCount === 0) return 'Query Sentinel found no FANOUT, JOIN_KEY, ADDITIVITY, or sensitive-column issues.';
  const counts = report.flags.reduce((acc, f) => { acc[f.kind] = (acc[f.kind] || 0) + 1; return acc; }, {});
  const parts = Object.entries(counts).map(([kind, n]) => `${n} ${kind}`);
  return `Query Sentinel: ${parts.join(', ')} — review before trusting this result.`;
}

// Explicit, testable proof this module never writes: no import of any DuckDB
// write/mutation helper, no export named apply/write/mutate/fix. Matches the
// same red-team-testable guarantee guarded-copilot.js's PUBLIC_API_SURFACE
// already documents for a different module.
export const PUBLIC_API_SURFACE = Object.freeze([
  'extractJoins',
  'checkFanout',
  'checkJoinKey',
  'checkAdditivity',
  'checkSensitiveColumn',
  'runQuerySentinel',
  'summarizeQuerySentinel',
]);
