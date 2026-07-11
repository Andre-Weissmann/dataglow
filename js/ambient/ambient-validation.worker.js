// ============================================================
// DATAGLOW — Ambient Validation Web Worker
// ============================================================
// Runs a lightweight, static subset of the validation suite against the SQL
// query a user is *currently typing*, off the main thread so the editor never
// blocks. This is deliberately NOT the full 20-layer suite (far too expensive
// to run on every keystroke against real data) — it is a cheap, purely
// syntactic read of the query text plus the known column schema, catching the
// small set of mistakes that are both common and detectable before the query
// ever runs:
//
//   1. Categorical Consistency (sensitive-category merge risk) — grouping by,
//      or transforming, a protected column (race / ethnicity / insurance / …)
//      can silently merge values that are legally/clinically distinct.
//   2. Cross-Column Logical Consistency — a predicate that selects logically
//      impossible rows (an end/max compared below its own start/min).
//   3. Sanity Anchor — aggregating across a JOIN without DISTINCT can inflate
//      SUM/COUNT by fan-out; suggest cross-checking with an independent path.
//      When a schema with row-count/distinct-count stats is supplied (see
//      options.schema), this check uses real join-key uniqueness instead of
//      a blunt "any join + any aggregate" heuristic — see checkSanityAnchor.
//
// The check functions are pure and exported so they can be unit-tested in Node
// directly, without spinning up an actual Worker. The `self.onmessage` wiring
// at the bottom only activates inside a real Worker context.

import { isSensitiveCategory } from '../validation/categorical-consistency.js';

// Column-name keyword families for the cross-column logic check. Kept in sync
// (conceptually) with the full Cross-Column Logical Consistency layer.
const START_KW = ['start', 'begin', 'admit', 'admission', 'open', 'from', 'onset', 'entry', 'hire', 'issue', 'effective'];
const END_KW = ['end', 'finish', 'discharge', 'close', 'stop', 'exit', 'termination', 'terminate', 'expiry', 'expire', 'resolved', 'completion', 'complete', 'return'];
const MIN_KW = ['min', 'minimum', 'low', 'lower', 'floor'];
const MAX_KW = ['max', 'maximum', 'high', 'higher', 'ceiling', 'cap'];

function nameTokens(name) {
  return String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function hasKeyword(name, keywords) {
  const tokens = nameTokens(name);
  return keywords.some(kw => tokens.some(t => t.startsWith(kw)));
}

// Strip single-quoted string literals and line/block comments so the crude
// clause parsing below never trips over keywords that appear inside them.
// Double-quoted identifiers are SQL column names, so they are preserved (and
// unwrapped later by stripQuotes) rather than blanked out.
function stripLiteralsAndComments(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

// A bare column reference is a word or a "quoted identifier". We return the
// unquoted name so it can be matched against the schema / sensitivity rules.
function stripQuotes(token) {
  const t = String(token).trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1);
  return t;
}

// Extract the raw column references named in the GROUP BY clause. Handles both
// quoted ("race") and bare (race) identifiers, and stops at the next clause
// keyword. Positional references (GROUP BY 1) are ignored — we can't judge
// sensitivity without resolving the position to a SELECT expression.
export function extractGroupByColumns(sql) {
  const clean = stripLiteralsAndComments(sql);
  const m = /\bgroup\s+by\b([\s\S]*?)(\border\s+by\b|\bhaving\b|\blimit\b|\bwindow\b|;|$)/i.exec(clean);
  if (!m) return [];
  const clause = m[1];
  return clause
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    // Take the last dotted segment so "t.race" -> "race"; drop pure positions.
    .map(part => {
      const first = part.split(/\s+/)[0];
      const seg = first.split('.').pop();
      return stripQuotes(seg);
    })
    .filter(name => name && !/^\d+$/.test(name));
}

// Does the query wrap a sensitive column in a value-collapsing function inside
// SELECT or GROUP BY (e.g. SUBSTR(race,1,1), UPPER(ethnicity), CASE WHEN
// insurance ...)? Such transforms can merge legally-distinct categories just
// as surely as a plain GROUP BY does.
const COLLAPSING_FN = /\b(substr|substring|left|right|upper|lower|trim|regexp_replace|replace|split_part|coalesce|case)\b/i;

function sensitiveColumnsInSchema(columns) {
  return (columns || []).map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean);
}

// ---------- Check 1: sensitive-category merge risk ----------
export function checkSensitiveGrouping(sql, options = {}) {
  const warnings = [];
  const schemaCols = sensitiveColumnsInSchema(options.columns);
  const knownSet = new Set(schemaCols.map(c => c.toLowerCase()));
  const hasSchema = knownSet.size > 0;

  const grouped = extractGroupByColumns(sql);
  const seen = new Set();
  for (const col of grouped) {
    // If we know the schema, only flag columns that actually exist — avoids
    // false positives on aliases/expressions. Without a schema, fall back to
    // name-based matching so the check still works before a dataset loads.
    if (hasSchema && !knownSet.has(col.toLowerCase())) continue;
    if (isSensitiveCategory(col) && !seen.has(col.toLowerCase())) {
      seen.add(col.toLowerCase());
      warnings.push({
        id: 'sensitive_grouping',
        severity: 'warning',
        column: col,
        message: `This query groups together values in a protected column ("${col}") that DATAGLOW flags as distinct — near-identical spellings in demographic/payer columns are often legally or clinically separate categories (e.g. Medicaid vs Medicare). Review before using this result.`,
      });
    }
  }

  // Transform-based merge on a sensitive column referenced in the query.
  const clean = stripLiteralsAndComments(sql);
  if (COLLAPSING_FN.test(clean)) {
    const candidates = hasSchema
      ? schemaCols.filter(isSensitiveCategory)
      : []; // without a schema we can't safely name the wrapped column
    for (const col of candidates) {
      const wrapped = new RegExp(`\\b(?:substr|substring|left|right|upper|lower|trim|regexp_replace|replace|split_part|coalesce|case)\\b[\\s\\S]{0,40}\\b${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (wrapped.test(clean) && !seen.has(col.toLowerCase())) {
        seen.add(col.toLowerCase());
        warnings.push({
          id: 'sensitive_transform',
          severity: 'warning',
          column: col,
          message: `This query transforms a protected column ("${col}") with a value-collapsing function — this can merge legally/clinically distinct categories. Confirm the grouping is intentional.`,
        });
      }
    }
  }
  return warnings;
}

// ---------- Check 2: cross-column logical consistency ----------
// Detect a WHERE/HAVING predicate of the form  endLike <  startLike  or
// maxLike < minLike — i.e. the query is filtering to rows that are logically
// impossible (an end before its start, a max below its min).
export function checkCrossColumnLogic(sql) {
  const warnings = [];
  const clean = stripLiteralsAndComments(sql);
  // Match binary comparisons between two bare/quoted/dotted column references.
  const cmp = /([A-Za-z_][\w.]*)\s*(<=?|>=?)\s*([A-Za-z_][\w.]*)/g;
  let m;
  const flagged = new Set();
  while ((m = cmp.exec(clean)) !== null) {
    const lhs = stripQuotes(m[1].split('.').pop());
    const op = m[2];
    const rhs = stripQuotes(m[3].split('.').pop());
    if (!lhs || !rhs || lhs.toLowerCase() === rhs.toLowerCase()) continue;
    const key = `${lhs}|${op}|${rhs}`;
    if (flagged.has(key)) continue;

    // end < start   (or start > end)  → impossible date/range order
    const endBeforeStart =
      (op.startsWith('<') && hasKeyword(lhs, END_KW) && hasKeyword(rhs, START_KW)) ||
      (op.startsWith('>') && hasKeyword(lhs, START_KW) && hasKeyword(rhs, END_KW));
    // max < min   (or min > max)
    const maxBelowMin =
      (op.startsWith('<') && hasKeyword(lhs, MAX_KW) && hasKeyword(rhs, MIN_KW)) ||
      (op.startsWith('>') && hasKeyword(lhs, MIN_KW) && hasKeyword(rhs, MAX_KW));

    if (endBeforeStart) {
      flagged.add(key);
      warnings.push({
        id: 'cross_column_logic',
        severity: 'warning',
        message: `This filter compares "${lhs}" ${op} "${rhs}" — an end/return value against a start/begin value in an order that selects logically impossible rows (end before start). Double-check the comparison direction.`,
      });
    } else if (maxBelowMin) {
      flagged.add(key);
      warnings.push({
        id: 'cross_column_logic',
        severity: 'warning',
        message: `This filter compares "${lhs}" ${op} "${rhs}" — a maximum against a minimum in an order that selects impossible rows (max below min). Double-check the comparison direction.`,
      });
    }
  }
  return warnings;
}

// ---------- Check 3: Sanity Anchor (aggregation × join fan-out) ----------
// Summing/counting across a JOIN without DISTINCT can silently double-count via
// row fan-out. Cheap to detect statically; the fix is to verify the total with
// an independent path (exactly what the full Sanity Anchor layer does).
//
// Precision upgrade: when the caller passes `options.schema` (the same
// { tables: { [name]: { columns, rowCount, approxDistinct } } } shape the
// Local Analysis Contract's buildSchemaIndex consumes — see
// js/validation/analysis-contract.js), this check goes beyond "any join +
// any aggregate" and looks at the ACTUAL uniqueness of the join key on each
// side. That lets it: (a) name the real culprit column/table and its
// uniqueness percentage instead of a generic warning, and (b) stay silent
// when the query's own GROUP BY is already at the many-side table's grain,
// where repeating the joined value per row is correct, not a fan-out bug.
// Without a schema (or without distinct-count stats in it), this falls all
// the way back to the original blunt "join + aggregate, no DISTINCT" flag,
// so ambient typing checks that arrive before a dataset has loaded still work.
const JOIN_ON_RE = /\bjoin\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*)?\s*on\s+(.+?)(?=\bjoin\b|\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\blimit\b|$)/gis;

function extractJoinOnClauses(clean) {
  const joins = [];
  let m;
  const re = new RegExp(JOIN_ON_RE);
  while ((m = re.exec(clean)) !== null) {
    joins.push({ table: m[1], onClause: m[3].trim() });
  }
  return joins;
}

function extractGroupByBareColumns(clean) {
  const m = /\bgroup\s+by\b([\s\S]*?)(\border\s+by\b|\bhaving\b|\blimit\b|;|$)/i.exec(clean);
  if (!m) return new Set();
  const cols = new Set();
  for (const part of m[1].split(',')) {
    const seg = part.trim().split(/\s+/)[0];
    if (!seg) continue;
    const last = stripQuotes(seg.split('.').pop());
    if (last) cols.add(last.toLowerCase());
  }
  return cols;
}

// Builds a lowercase-column-name -> [{table, name}] index from the schema
// shape shared with the Local Analysis Contract, without importing that
// module (keeps this worker dependency-light and independently testable).
function indexSchemaColumns(schema) {
  const index = new Map();
  for (const [tableName, t] of Object.entries((schema && schema.tables) || {})) {
    for (const col of t.columns || []) {
      const key = (typeof col === 'string' ? col : col.name).toLowerCase();
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(tableName);
    }
  }
  return index;
}

function statsAwareSanityAnchor(clean, aggMatch, schema) {
  const columnIndex = indexSchemaColumns(schema);
  const groupByCols = extractGroupByBareColumns(clean);
  const joins = extractJoinOnClauses(clean);
  const warnings = [];
  let sawAnyStats = false;

  for (const join of joins) {
    const onIdents = (join.onClause.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])
      .map(stripQuotes)
      .filter(t => t && !/^(and|or|is|null)$/i.test(t));
    const relevantCol = onIdents.find(c => columnIndex.has(c.toLowerCase()));
    if (!relevantCol) continue;

    const candidateTables = columnIndex.get(relevantCol.toLowerCase()) || [];
    let riskiest = null;
    for (const tableName of candidateTables) {
      const t = schema.tables[tableName];
      if (!t || !t.rowCount || !t.approxDistinct || t.approxDistinct[relevantCol] == null) continue;
      sawAnyStats = true;
      const uniqueness = t.approxDistinct[relevantCol] / t.rowCount;
      if (uniqueness >= 0.9) continue; // essentially unique on this side — not the risky side

      // If GROUP BY already lands on a column that is itself ~unique for this
      // same table, the query's output grain already matches the many side —
      // repeating the joined value per row here is intended, not a bug.
      const groupedAtThisGrain = Array.from(groupByCols).some(gb => {
        const gbTables = columnIndex.get(gb) || [];
        return gbTables.includes(tableName) && t.approxDistinct[gb] != null && (t.approxDistinct[gb] / t.rowCount) >= 0.9;
      });
      if (groupedAtThisGrain) continue;

      if (!riskiest || uniqueness < riskiest.uniqueness) {
        riskiest = { table: tableName, column: relevantCol, uniqueness, rowCount: t.rowCount, distinct: t.approxDistinct[relevantCol] };
      }
    }

    if (riskiest) {
      warnings.push({
        id: 'sanity_anchor',
        severity: riskiest.uniqueness < 0.5 ? 'warning' : 'info',
        column: riskiest.column,
        message: `Joining on "${riskiest.column}" in "${riskiest.table}" is only ~${Math.round(riskiest.uniqueness * 100)}% unique (${riskiest.distinct.toLocaleString()} distinct of ${riskiest.rowCount.toLocaleString()} rows). ${aggMatch[1].toUpperCase()} across this JOIN can be inflated by fan-out — confirm that's intended, or cross-check with an independent calculation path (Sanity Anchor).`,
      });
    }
  }

  return sawAnyStats ? warnings : null; // null signals "no usable stats, fall back"
}

export function checkSanityAnchor(sql, options = {}) {
  const warnings = [];
  const clean = stripLiteralsAndComments(sql);
  const hasJoin = /\bjoin\b/i.test(clean);
  const aggMatch = /\b(sum|count|avg|total)\s*\(/i.exec(clean);
  const hasDistinct = /\b(count|sum|avg)\s*\(\s*distinct\b/i.test(clean);
  if (!hasJoin || !aggMatch || hasDistinct) return warnings;

  if (options.schema && options.schema.tables) {
    const statsAware = statsAwareSanityAnchor(clean, aggMatch, options.schema);
    if (statsAware !== null) return statsAware; // schema had usable stats — use the precise result (may be empty)
  }

  // Fallback: no schema, or schema had no usable distinct-count stats for any
  // join key in this query — same blunt behaviour as before the upgrade.
  warnings.push({
    id: 'sanity_anchor',
    severity: 'info',
    message: `This query aggregates (${aggMatch[1].toUpperCase()}) across a JOIN without DISTINCT — a one-to-many join can inflate the total by fan-out. Cross-check the figure with an independent calculation path (Sanity Anchor).`,
  });
  return warnings;
}

// Run every ambient check and return a de-duplicated, ordered warning list.
export function runAmbientChecks(sql, options = {}) {
  const text = String(sql || '').trim();
  if (!text) return [];
  const all = [
    ...checkSensitiveGrouping(text, options),
    ...checkCrossColumnLogic(text),
    ...checkSanityAnchor(text, options),
  ];
  // De-dupe by (id + column + message) so repeated clauses don't stack.
  const seen = new Set();
  const out = [];
  for (const w of all) {
    const key = `${w.id}|${w.column || ''}|${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

// ---------- Worker wiring (only inside a real Worker) ----------
// In Node (unit tests) `WorkerGlobalScope` is undefined, so this is skipped and
// only the pure functions above are exercised.
if (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (e) => {
    const { requestId, sql, columns, schema } = e.data || {};
    let warnings = [];
    try {
      warnings = runAmbientChecks(sql, { columns, schema });
    } catch (err) {
      // A parsing edge case must never take the worker (or the editor) down.
      warnings = [];
    }
    self.postMessage({ requestId, sql, warnings });
  };
}
