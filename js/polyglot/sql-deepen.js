// ============================================================
// DATAGLOW - SQL deepen: profiling that becomes proof, and the templates
//            people rewrite from memory every time
// ============================================================
//
// Two things sit in this file, and they are here together because they are the
// same complaint from two directions.
//
// The first is SUMMARIZE. DuckDB will profile an entire table in one statement
// and hand back a row per column with the null rate, the distinct count, the
// min, the max and the quartiles already computed. Almost nobody uses it,
// because it returns a wide result that reads like a debug dump and there is
// nothing to do with it afterwards. So this turns the interesting parts of that
// result into Proof Board tiles: a null rate that is high enough to change an
// answer, a column that is entirely one value, a key that is not unique. Each
// tile carries the SQL that produced it, so "show the work" is a real link and
// not a label.
//
// WHY THE TILES ARE FILTERED RATHER THAN ONE PER COLUMN.
// A forty-column table produces forty rows from SUMMARIZE, and a Proof Board
// with forty tiles on it is a Proof Board nobody reads. The findings worth a
// tile are the ones that would change what someone concludes: a column that is
// mostly empty, a column with exactly one distinct value, a candidate key with
// duplicates. Everything else stays in the profile table where it can be read
// on demand.
//
// WHY EVERY TILE IS `gateBadge: 'unknown'`.
// A profile finding is an observation, not an adjudication. The gates on the
// Proof Board are a separate engine and this module does not get to speak for
// them. Claiming `clear` here would be putting a stamp on something nothing
// checked.
//
// The second thing is the template set. The existing pack has ten snippets
// chosen for the first hour. These are the next tier: the shapes people know
// exist, cannot remember the syntax for, and reconstruct badly from memory. An
// ASOF join written by hand as a correlated subquery is correct and thirty
// times slower; a PIVOT written by hand is a CASE expression per value that
// silently omits any value nobody thought of.
//
// Pure data plus pure functions. No DOM, no engine, no network. Nothing here
// runs a query; `summarizeSql()` returns the text of one.

export const SQL_DEEPEN_KIND = 'dataglow-sql-deepen';
export const SQL_DEEPEN_VERSION = 1;

/**
 * A null rate below this is normal in real data and a tile about it is noise.
 * Above it, an average or a count computed over the column is describing a
 * different population than the one the person thinks they are looking at.
 */
export const NULL_RATE_TILE_THRESHOLD = 20;

export const SUMMARIZE_HONESTY =
  'SUMMARIZE profiles the table DuckDB currently holds. If rows were dropped on load, or a filter is applied upstream, this describes what is in the table and not what was in the file.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[%,]/g, ''));
    if (isFinite(n)) return n;
  }
  return null;
}

/**
 * Quote an identifier the DuckDB way, doubling any embedded quote.
 *
 * A table name arriving from a spreadsheet tab can contain a space, a hyphen or
 * a quote, and every one of those turns an unquoted statement into either a
 * parse error or, worse, a statement that parses as something else.
 */
export function quoteIdent(name) {
  return '"' + String(name == null ? '' : name).replace(/"/g, '""') + '"';
}

/** The profiling statement for one table. */
export function summarizeSql(tableName) {
  return 'SUMMARIZE ' + quoteIdent(tableName) + ';';
}

/** The statement behind a single null-rate tile, so the tile can show its work. */
export function nullRateSql(tableName, column) {
  const t = quoteIdent(tableName);
  const c = quoteIdent(column);
  return 'SELECT count(*) AS rows,\n'
    + '       count(*) FILTER (WHERE ' + c + ' IS NULL) AS missing,\n'
    + '       round(100.0 * count(*) FILTER (WHERE ' + c + ' IS NULL) / nullif(count(*), 0), 2) AS pct_missing\n'
    + 'FROM ' + t + ';';
}

/** The statement behind a distinctness tile. */
export function distinctnessSql(tableName, column) {
  const t = quoteIdent(tableName);
  const c = quoteIdent(column);
  return 'SELECT count(*) AS rows,\n'
    + '       count(DISTINCT ' + c + ') AS distinct_values\n'
    + 'FROM ' + t + ';';
}

/**
 * Read one SUMMARIZE row into the fields this module needs.
 *
 * DuckDB has changed the shape of this result between versions and the numeric
 * columns come back as strings in some builds and as BigInt in others, so every
 * field is looked up under several names and coerced rather than trusted.
 */
export function readSummarizeRow(row) {
  if (!isPlainObject(row)) return null;
  const pick = (...keys) => {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(row, k) && row[k] != null) return row[k];
    }
    return null;
  };
  const column = str(pick('column_name', 'column', 'name'));
  if (!column) return null;
  return {
    column,
    type: str(pick('column_type', 'type')) || 'unknown',
    nullPercentage: num(pick('null_percentage', 'null_pct', 'nulls')),
    approxUnique: num(pick('approx_unique', 'approx_unique_count', 'distinct')),
    count: num(pick('count', 'row_count')),
    min: pick('min'),
    max: pick('max'),
  };
}

/**
 * Turn a SUMMARIZE result into Proof Board tiles.
 *
 * Returns tiles in the shape `normalizeTile()` on the Proof Board expects, so
 * the caller passes them straight to `addTile` without reshaping anything.
 *
 * @param {{table?:string, rows?:Array, columns?:Array, rowCount?:number}} [input]
 */
export function summarizeToTiles(input) {
  const inp = isPlainObject(input) ? input : {};
  const table = str(inp.table) || 'table';
  const rows = Array.isArray(inp.rows) ? inp.rows : [];
  const profile = rows.map(readSummarizeRow).filter(Boolean);

  const tiles = [];
  const findings = [];

  if (!profile.length) {
    return {
      kind: SQL_DEEPEN_KIND,
      table,
      profiled: 0,
      tiles: [],
      findings: [],
      honesty: SUMMARIZE_HONESTY,
      headline: rows.length
        ? 'SUMMARIZE returned rows this build could not read, so no tile was built from them.'
        : 'Nothing to profile. SUMMARIZE returned no rows, which means the table has no columns or does not exist yet.',
    };
  }

  const totalRows = num(inp.rowCount) != null ? num(inp.rowCount) : (profile[0].count != null ? profile[0].count : null);

  for (const p of profile) {
    if (p.nullPercentage != null && p.nullPercentage >= NULL_RATE_TILE_THRESHOLD) {
      findings.push({ kind: 'null_rate', column: p.column, value: p.nullPercentage });
      tiles.push({
        id: 'summarize-null-' + p.column,
        title: 'Missing values in ' + p.column,
        value: Math.round(p.nullPercentage * 100) / 100,
        unit: '%',
        sqlOrCode: nullRateSql(table, p.column),
        language: 'sql',
        engine: 'duckdb-summarize',
        gateBadge: 'unknown',
        checksSummary: 'Read from SUMMARIZE ' + table + '. An average over this column describes the '
          + (Math.round((100 - p.nullPercentage) * 10) / 10) + ' percent that is present, not the whole table.',
        sourceCols: [p.column],
      });
    }

    if (p.approxUnique === 1 && totalRows != null && totalRows > 1) {
      findings.push({ kind: 'constant', column: p.column, value: 1 });
      tiles.push({
        id: 'summarize-constant-' + p.column,
        title: p.column + ' is the same value in every row',
        value: 1,
        unit: 'distinct value',
        sqlOrCode: distinctnessSql(table, p.column),
        language: 'sql',
        engine: 'duckdb-summarize',
        gateBadge: 'unknown',
        checksSummary: 'A column with one distinct value cannot explain variation in anything, and grouping by it produces one group.',
        sourceCols: [p.column],
      });
    }

    if (p.approxUnique != null && totalRows != null && totalRows > 0
        && p.approxUnique >= totalRows && p.nullPercentage === 0) {
      findings.push({ kind: 'candidate_key', column: p.column, value: p.approxUnique });
      tiles.push({
        id: 'summarize-key-' + p.column,
        title: p.column + ' looks like a key',
        value: p.approxUnique,
        unit: 'distinct values',
        sqlOrCode: distinctnessSql(table, p.column),
        language: 'sql',
        engine: 'duckdb-summarize',
        gateBadge: 'unknown',
        checksSummary: 'Distinct count matches the row count and nothing is missing, so a join on this column will not fan out. SUMMARIZE reports an approximate distinct count, so confirm before relying on it.',
        sourceCols: [p.column],
      });
    }
  }

  return {
    kind: SQL_DEEPEN_KIND,
    table,
    profiled: profile.length,
    profile,
    tiles,
    findings,
    honesty: SUMMARIZE_HONESTY,
    headline: tiles.length
      ? 'Profiled ' + profile.length + ' column' + (profile.length === 1 ? '' : 's') + ' and found '
        + tiles.length + ' thing' + (tiles.length === 1 ? '' : 's') + ' worth a tile.'
      : 'Profiled ' + profile.length + ' column' + (profile.length === 1 ? '' : 's')
        + '. Nothing crossed the threshold for a tile, which is the good outcome.',
  };
}

/**
 * The next tier of templates.
 *
 * Same shape as SQL_SNIPPETS in the base pack, so the same renderer takes both
 * and neither has to know about the other.
 */
export const SQL_DEEPEN_SNIPPETS = Object.freeze([
  Object.freeze({
    id: 'qualify-top-n',
    topic: 'Windows',
    title: 'Top N per group, with the N in one place',
    why: 'The rank goes in QUALIFY rather than a subquery, so changing three to ten is one edit and the row order is not accidentally load-bearing.',
    substitute: ['your_table', 'region', 'amount'],
    sql: 'SELECT *\nFROM your_table\nQUALIFY dense_rank() OVER (PARTITION BY region ORDER BY amount DESC) <= 3\nORDER BY region, amount DESC;',
  }),
  Object.freeze({
    id: 'asof-join',
    topic: 'Joins',
    title: 'ASOF join: the most recent match at or before each row',
    why: 'Price at the time of trade, exchange rate on the day, status as of the event. Written by hand this is a correlated subquery that is correct and far slower.',
    substitute: ['events', 'rates', 'ts', 'rate'],
    // Both sides need a time key, and the inequality goes on that key. Without
    // one there is nothing for ASOF to be "as of" and DuckDB rejects the join.
    sql: '-- Both tables need a time column, and the ASOF condition is the inequality on it.\n'
      + '-- The right side should be sorted by that column for this to be cheap.\n'
      + 'SELECT e.*, r.rate\nFROM events e\nASOF LEFT JOIN rates r\n  ON e.ts >= r.ts;',
  }),
  Object.freeze({
    id: 'pivot-wide',
    topic: 'Reshaping',
    title: 'PIVOT: one column of values becomes many columns',
    why: 'The shape a stakeholder asks for. DuckDB discovers the column list from the data, so a value nobody anticipated still gets a column.',
    substitute: ['your_table', 'month', 'amount', 'region'],
    sql: 'PIVOT your_table\n  ON month\n  USING sum(amount)\n  GROUP BY region;',
  }),
  Object.freeze({
    id: 'unpivot-wide',
    topic: 'Reshaping',
    title: 'UNPIVOT: many columns become one column of values',
    why: 'The inverse, and the one that comes up more often, because the file already arrived wide.',
    substitute: ['your_table', 'region'],
    sql: 'UNPIVOT your_table\n  ON COLUMNS(* EXCLUDE (region))\n  INTO NAME period VALUE amount;',
  }),
  Object.freeze({
    id: 'group-by-all',
    topic: 'Grouping',
    title: 'GROUP BY ALL, so the group list cannot drift from the select list',
    why: 'The bug this removes is adding a column to SELECT and forgetting to add it to GROUP BY, which in DuckDB is an error and in some engines is a silently wrong answer.',
    substitute: ['your_table', 'region', 'dept', 'amount'],
    sql: 'SELECT region,\n       dept,\n       count(*) AS rows,\n       sum(amount) AS total\nFROM your_table\nGROUP BY ALL\nORDER BY ALL;',
  }),
  Object.freeze({
    id: 'select-exclude',
    topic: 'Column selection',
    title: 'Everything except a few columns',
    why: 'Reading a wide table without the three columns that make it unreadable, and without typing the other forty by name.',
    substitute: ['your_table', 'ssn', 'notes'],
    sql: 'SELECT * EXCLUDE (ssn, notes)\nFROM your_table\nLIMIT 50;',
  }),
  Object.freeze({
    id: 'select-replace',
    topic: 'Column selection',
    title: 'Rewrite one column and keep the rest of the star',
    why: 'Trimming or upper-casing one field without turning a star into an explicit column list that then rots.',
    substitute: ['your_table', 'name'],
    sql: 'SELECT * REPLACE (trim(name) AS name)\nFROM your_table\nLIMIT 50;',
  }),
  Object.freeze({
    id: 'moving-average',
    topic: 'Windows',
    title: 'Moving average over a fixed number of rows',
    why: 'The rolling number people plot. The frame is stated explicitly, because the default frame is not what most people assume it is.',
    substitute: ['your_table', 'month', 'amount'],
    sql: 'SELECT month,\n       amount,\n       avg(amount) OVER (\n         ORDER BY month\n         ROWS BETWEEN 2 PRECEDING AND CURRENT ROW\n       ) AS moving_avg_3\nFROM your_table\nORDER BY month;',
  }),
  Object.freeze({
    id: 'moving-window-range',
    topic: 'Windows',
    title: 'Trailing 30 days, by time rather than by row count',
    why: 'ROWS counts rows and RANGE counts time. With gaps in the data these give different answers, and the time one is almost always what was meant.',
    substitute: ['your_table', 'ts', 'amount'],
    sql: 'SELECT ts,\n       sum(amount) OVER (\n         ORDER BY ts\n         RANGE BETWEEN INTERVAL 30 DAYS PRECEDING AND CURRENT ROW\n       ) AS trailing_30d\nFROM your_table\nORDER BY ts;',
  }),
  Object.freeze({
    id: 'share-of-total',
    topic: 'Windows',
    title: 'Each row as a share of its group',
    why: 'Percentages that add to a hundred within a group, without a second pass over the table.',
    substitute: ['your_table', 'region', 'amount'],
    sql: 'SELECT region,\n       amount,\n       round(100.0 * amount / sum(amount) OVER (PARTITION BY region), 2) AS pct_of_region\nFROM your_table\nORDER BY region, pct_of_region DESC;',
  }),
  Object.freeze({
    id: 'summarize-profile',
    topic: 'Data quality',
    title: 'Profile every column, then keep the interesting rows',
    why: 'The statement behind the profile tiles. Run it directly when you want the whole picture rather than the findings.',
    substitute: ['your_table'],
    sql: 'SELECT column_name, column_type, null_percentage, approx_unique, min, max\n'
      + 'FROM (SUMMARIZE your_table)\n'
      + 'ORDER BY null_percentage DESC;',
  }),
]);

/** Distinct topics across the deepened set, in first-seen order. */
export function deepenTopics() {
  const out = [];
  for (const s of SQL_DEEPEN_SNIPPETS) {
    if (out.indexOf(s.topic) < 0) out.push(s.topic);
  }
  return out;
}

export function listDeepenSnippets(topic) {
  const t = str(topic);
  if (!t) return SQL_DEEPEN_SNIPPETS.slice();
  return SQL_DEEPEN_SNIPPETS.filter(s => s.topic === t);
}

export function buildSqlDeepen() {
  return {
    kind: SQL_DEEPEN_KIND,
    version: SQL_DEEPEN_VERSION,
    snippets: SQL_DEEPEN_SNIPPETS,
    topics: deepenTopics(),
    summarizeHonesty: SUMMARIZE_HONESTY,
    nullRateThreshold: NULL_RATE_TILE_THRESHOLD,
    // Copy, then confirm, then run. The base pack never runs anything and this
    // does not change that: profiling is the one action here and it is a button
    // the person presses, not something a recipe triggers on insert.
    interactionNote:
      'Snippets are copied, never run for you. Profiling is the one thing this pack executes, and only when you press the button.',
  };
}

export const DataGlowSqlDeepen = {
  SQL_DEEPEN_KIND,
  SQL_DEEPEN_VERSION,
  NULL_RATE_TILE_THRESHOLD,
  SUMMARIZE_HONESTY,
  SQL_DEEPEN_SNIPPETS,
  quoteIdent,
  summarizeSql,
  nullRateSql,
  distinctnessSql,
  readSummarizeRow,
  summarizeToTiles,
  deepenTopics,
  listDeepenSnippets,
  buildSqlDeepen,
};

try {
  if (typeof window !== 'undefined') window.DataGlowSqlDeepen = DataGlowSqlDeepen;
} catch (_e) {}
