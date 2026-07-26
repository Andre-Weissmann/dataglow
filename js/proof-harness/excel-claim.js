// ============================================================
// DATAGLOW - Proof Harness v2.0: Excel claim path (PH-16 slice)
// ============================================================
// WHY THIS EXISTS
// PROOF_HARNESS_V2_SPEC.md pillar B: someone reasoning about a number often
// has it as an Excel-style formula in their head or clipboard -- `=SUM(
// amount)`, `COUNT(claim_id)`, `AVERAGE(claim_amount)` -- not as SQL. This
// module recognizes exactly that one shape (a single aggregate function over
// a single column, with an optional `on`/`from` table clause) and maps it to
// a DuckDB SELECT statement so the SAME prove cycle (engines + adversary)
// can run it, never inventing a bespoke Excel-only verdict path.
//
// This is deliberately narrow (PROOF_HARNESS_V2_SPEC.md pillar B3 "Non-goals
// this ship"): no VBA, no multi-sheet 3D references, no full 40-sheet
// formula transpile, no writing back to .xlsx. Free-form Excel that is not
// a known aggregate is REJECTED with a reason, never guessed at -- a false
// GREEN is a release blocker (doctrine #7), so an unparseable claim must
// surface as "we could not read this", not silently fall through to some
// other statement.
//
// PURITY: no DOM, no network, no engine call. Pure string parsing/formatting
// only, exactly like js/polyglot/sql-deepen.js's summarizeSql()/nullRateSql()
// -- this module returns the TEXT of a statement, it never runs one.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Quote an identifier the DuckDB way, doubling any embedded quote. Restated
 * from js/polyglot/sql-deepen.js's quoteIdent (not imported, so this module
 * stays independently inlinable into canvas/index.html the same way every
 * other proof-harness pure module does) -- see that module's header for why
 * a column/table name arriving from a spreadsheet needs this at all (a
 * space, hyphen, or embedded quote otherwise turns an unquoted statement
 * into either a parse error or a statement that parses as something else).
 * @param {string} name
 */
function quoteIdent(name) {
  return '"' + String(name == null ? '' : name).replace(/"/g, '""') + '"';
}

const SUPPORTED_FUNCTIONS = Object.freeze({
  SUM: 'SUM',
  COUNT: 'COUNT',
  AVERAGE: 'AVG',
  AVG: 'AVG',
});

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_ ]*$/;

/**
 * Parse a single Excel-style aggregate claim: `SUM(amount)`, `=SUM(amount)`,
 * `COUNT(claim_id)`, `AVERAGE(claim_amount)` / `AVG(claim_amount)`, with an
 * optional trailing `on <table>` / `from <table>` clause (case-insensitive).
 * Rejects (returns `{rejected:true, reason}`) anything that is not exactly
 * this shape: multiple functions, nested functions, ranges (`A1:A10`),
 * multi-sheet 3D refs (`Sheet1!A1`), or any text that is not recognizable as
 * one of the supported aggregate names at all.
 *
 * Never throws.
 * @param {string} text
 * @returns {{fn:string, column:string, table:string|null, rejected?:false} |
 *   {rejected:true, reason:string}}
 */
export function parseExcelAggregateClaim(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { rejected: true, reason: 'No Excel-style claim text was provided.' };
  }

  let stmt = text.trim();
  // Strip a single leading '=' the way a cell formula bar shows it.
  if (stmt.startsWith('=')) stmt = stmt.slice(1).trim();

  // Reject obvious out-of-scope shapes up front with a specific reason
  // rather than falling through to a generic "could not parse".
  if (/!/.test(stmt)) {
    return { rejected: true, reason: 'Multi-sheet 3D references (e.g. Sheet1!A1) are not supported in this version.' };
  }
  if (/:/.test(stmt)) {
    return { rejected: true, reason: 'Cell ranges (e.g. A1:A10) are not supported; use a column-name aggregate like SUM(amount) instead.' };
  }
  if (/\bvba\b|^sub\s|^function\s/i.test(stmt)) {
    return { rejected: true, reason: 'VBA/macro content is not supported.' };
  }

  // Match: FN(column) [on|from table]
  const m = /^([a-zA-Z]+)\s*\(\s*([^()]+?)\s*\)\s*(?:(?:on|from)\s+([a-zA-Z_][a-zA-Z0-9_]*))?\s*$/i.exec(stmt);
  if (!m) {
    return { rejected: true, reason: 'That is not a recognized aggregate claim. Supported forms: SUM(column), COUNT(column), AVERAGE(column) or AVG(column), optionally followed by "on <table>".' };
  }

  const [, fnRaw, columnRaw, tableRaw] = m;
  const fnKey = fnRaw.trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_FUNCTIONS, fnKey)) {
    return { rejected: true, reason: `"${fnRaw.trim()}" is not a supported aggregate. Supported: SUM, COUNT, AVERAGE, AVG.` };
  }

  const column = columnRaw.trim();
  if (!column) {
    return { rejected: true, reason: 'No column was named inside the aggregate.' };
  }
  if (/[()]/.test(column)) {
    return { rejected: true, reason: 'Nested functions inside an aggregate are not supported in this version.' };
  }
  // COUNT(*) is a legitimate special case (row count, not a named column).
  const isCountStar = fnKey === 'COUNT' && column === '*';
  if (!isCountStar && !IDENT_RE.test(column)) {
    return { rejected: true, reason: `"${column}" is not a plain column name this parser can map to SQL.` };
  }

  return {
    fn: SUPPORTED_FUNCTIONS[fnKey],
    column,
    table: tableRaw ? tableRaw.trim() : null,
    rejected: false,
  };
}

/**
 * Map a parsed Excel aggregate claim to a DuckDB SELECT statement. Quotes
 * the table/column identifiers using the same discipline every other
 * proof-harness/SQL-authoring module in this codebase uses (quoteIdent),
 * never string-interpolates a raw unquoted name into the generated SQL.
 * Refuses (returns `{rejected:true, reason}`) when `parsed` is itself a
 * rejection or is missing a table (neither an explicit `on`/`from` clause
 * nor a `defaultTable` was supplied) -- a claim with nowhere to run is not
 * yet a statement.
 * @param {{fn:string, column:string, table?:string|null, rejected?:boolean}} parsed
 * @param {string} [defaultTable]
 * @returns {{rejected:true, reason:string} | {rejected:false, statement:string}}
 */
export function excelClaimToSql(parsed, defaultTable) {
  if (!isPlainObject(parsed) || parsed.rejected) {
    return { rejected: true, reason: (parsed && parsed.reason) || 'The Excel claim was not parsed successfully.' };
  }
  const table = parsed.table || defaultTable;
  if (typeof table !== 'string' || !table.trim()) {
    return { rejected: true, reason: 'No table was named. Add "on <table>" to the claim or supply a default table.' };
  }

  const alias = parsed.fn === 'COUNT' ? 'n' : parsed.fn.toLowerCase();
  const columnExpr = parsed.column === '*' ? '*' : quoteIdent(parsed.column);
  const statement = `SELECT ${parsed.fn}(${columnExpr}) AS ${alias} FROM ${quoteIdent(table.trim())}`;
  return { rejected: false, statement };
}

/**
 * Convenience one-shot: parse text and map it straight to SQL, surfacing
 * whichever step's rejection reason applies. Never throws.
 * @param {string} text
 * @param {string} [defaultTable]
 */
export function excelClaimTextToSql(text, defaultTable) {
  const parsed = parseExcelAggregateClaim(text);
  if (parsed.rejected) return parsed;
  return excelClaimToSql(parsed, defaultTable);
}

export const EXCEL_CLAIM_SUPPORTED_FUNCTIONS = Object.freeze(Object.keys(SUPPORTED_FUNCTIONS));
