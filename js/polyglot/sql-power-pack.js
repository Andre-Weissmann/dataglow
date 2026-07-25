// ============================================================
// DATAGLOW - SQL power pack: DuckDB's dialect, written down
// ============================================================
//
// The SQL box in this product is DuckDB, not "SQL". Most of the time that
// distinction costs nothing, and then someone pastes a query that works in
// Postgres, gets a parser error on a line that looks fine, and concludes the
// product is broken. The cheapest fix for that is not a smarter parser. It is a
// short list of the places the two actually differ, next to the box.
//
// WHY THE DIVERGENCE LIST IS SHORT ON PURPOSE.
// A complete dialect reference is a book, and a book next to a text box does not
// get read. What gets read is a dozen entries covering the differences a person
// hits in their first hour. Everything here is something that changes what you
// type, not a note about internals.
//
// WHY EACH SNIPPET IS A WHOLE QUERY.
// A fragment has to be assembled before it can be run, and assembling it is
// exactly the part someone reaching for a snippet cannot do yet. Each of these
// runs as written against a table whose name you substitute, which means it can
// be pasted, run, and then read backwards from a result that already exists.
//
// WHAT THIS DOES NOT CLAIM.
// It does not claim DuckDB runs any SQL, it does not claim these snippets are
// the fastest form, and it does not translate a Postgres query for you. The
// honest offer is a dialect note and a working example.
//
// Pure data plus pure selectors. No DOM, no engine, no network. Nothing here
// executes a query.

export const SQL_PACK_KIND = 'dataglow-sql-power-pack';
export const SQL_PACK_VERSION = 1;

export const SQL_ENGINE_LABEL = 'DuckDB, compiled to WebAssembly, running in this page';

export const SQL_HONESTY_NOTE =
  'This is DuckDB SQL. It is close to Postgres and it is not Postgres, and it is not the dialect your warehouse speaks either. A query that runs here may need changing before it runs there, and the differences below are the ones people hit first.';

export const SQL_NOT_SUPPORTED = Object.freeze([
  'Stored procedures and user-defined functions written in PL/pgSQL.',
  'Triggers, and anything that runs on write rather than on read.',
  'Full-text search without loading an extension, which this build does not do.',
  'Anything that reaches another database. There is no foreign data wrapper and no network here.',
]);

/**
 * Where DuckDB and Postgres differ in ways that change what you type.
 *
 * `direction` says who has the feature, so the entry is useful whichever way a
 * person is translating.
 */
export const DUCKDB_DIVERGENCES = Object.freeze([
  Object.freeze({
    id: 'group-by-all',
    topic: 'Grouping',
    duckdb: 'SELECT region, dept, sum(amount) FROM t GROUP BY ALL',
    postgres: 'SELECT region, dept, sum(amount) FROM t GROUP BY region, dept',
    direction: 'duckdb_only',
    note: 'GROUP BY ALL groups by every selected column that is not an aggregate. ORDER BY ALL works the same way.',
  }),
  Object.freeze({
    id: 'select-exclude',
    topic: 'Column selection',
    duckdb: 'SELECT * EXCLUDE (ssn, notes) FROM t',
    postgres: 'SELECT every column you want, by name',
    direction: 'duckdb_only',
    note: 'EXCLUDE drops columns from a star. REPLACE rewrites one in place: SELECT * REPLACE (upper(name) AS name) FROM t.',
  }),
  Object.freeze({
    id: 'qualify',
    topic: 'Window filtering',
    duckdb: 'SELECT * FROM t QUALIFY row_number() OVER (PARTITION BY id ORDER BY ts DESC) = 1',
    postgres: 'Wrap it in a subquery and filter the window result outside',
    direction: 'duckdb_only',
    note: 'QUALIFY is to window functions what HAVING is to aggregates. It is the shortest correct way to take the latest row per key.',
  }),
  Object.freeze({
    id: 'read-file',
    topic: 'Reading files',
    duckdb: "SELECT * FROM read_csv_auto('sales.csv')",
    postgres: 'COPY into a table first, from the server file system',
    direction: 'duckdb_only',
    note: 'DuckDB queries a file directly. Parquet and JSON work the same way with read_parquet and read_json_auto.',
  }),
  Object.freeze({
    id: 'pivot',
    topic: 'Reshaping',
    duckdb: 'PIVOT t ON month USING sum(amount) GROUP BY region',
    postgres: 'crosstab() from the tablefunc extension, with the column list declared up front',
    direction: 'duckdb_only',
    note: 'UNPIVOT exists too and is the one people actually need more often, for turning twelve month columns back into rows.',
  }),
  Object.freeze({
    id: 'trailing-comma',
    topic: 'Syntax',
    duckdb: 'SELECT a, b, c, FROM t',
    postgres: 'A trailing comma is a syntax error',
    direction: 'duckdb_only',
    note: 'Small, but it removes the most common edit error when commenting a column out of a long select list.',
  }),
  Object.freeze({
    id: 'string-slice',
    topic: 'Strings',
    duckdb: "SELECT name[1:3] FROM t",
    postgres: "SELECT substring(name from 1 for 3) FROM t",
    direction: 'both_differ',
    note: 'DuckDB slicing is one-based and inclusive at both ends, which is the opposite of what a Python habit expects.',
  }),
  Object.freeze({
    id: 'date-format',
    topic: 'Dates',
    duckdb: "SELECT strftime(ts, '%Y-%m') FROM t",
    postgres: "SELECT to_char(ts, 'YYYY-MM') FROM t",
    direction: 'both_differ',
    note: 'strptime parses the other way. date_trunc behaves the same in both, so prefer it when you only need a month bucket.',
  }),
  Object.freeze({
    id: 'identifier-case',
    topic: 'Names',
    duckdb: 'Unquoted identifiers match case-insensitively and keep the case you wrote',
    postgres: 'Unquoted identifiers are folded to lower case',
    direction: 'both_differ',
    note: 'A column arriving from a spreadsheet as "Total Sales" can be written totalsales in DuckDB but needs the quotes in Postgres.',
  }),
  Object.freeze({
    id: 'list-types',
    topic: 'Nested data',
    duckdb: "SELECT unnest(tags) FROM t",
    postgres: "SELECT unnest(tags) FROM t, for arrays only",
    direction: 'both_differ',
    note: 'DuckDB lists and structs are first class, and a JSON column can be addressed with dot and bracket notation directly.',
  }),
  Object.freeze({
    id: 'sample',
    topic: 'Sampling',
    duckdb: 'SELECT * FROM t USING SAMPLE 5%',
    postgres: 'SELECT * FROM t TABLESAMPLE BERNOULLI(5)',
    direction: 'both_differ',
    note: 'Useful for looking at a wide table quickly. A sample is not an answer; do not put one on the Proof Board.',
  }),
  Object.freeze({
    id: 'integer-division',
    topic: 'Arithmetic',
    duckdb: 'SELECT 7 // 2  returns 3',
    postgres: 'SELECT 7 / 2  returns 3 for integers',
    direction: 'both_differ',
    note: 'In DuckDB the single slash on two integers gives a floating result, so the double slash is how you ask for floor division deliberately.',
  }),
]);

/**
 * Snippets. Each one runs as written once the table name is substituted.
 *
 * `substitute` names the placeholders so a surface can highlight them rather
 * than letting someone run a query against a table called `your_table`.
 */
export const SQL_SNIPPETS = Object.freeze([
  Object.freeze({
    id: 'latest-per-key',
    topic: 'Windows',
    title: 'Latest row per key',
    why: 'The single most common shape in analytics, and the one most often written wrong with a GROUP BY that silently mixes columns from different rows.',
    substitute: ['your_table', 'id', 'ts'],
    sql: 'SELECT *\nFROM your_table\nQUALIFY row_number() OVER (PARTITION BY id ORDER BY ts DESC) = 1;',
  }),
  Object.freeze({
    id: 'duplicate-keys',
    topic: 'Data quality',
    title: 'Find duplicate keys',
    why: 'Before trusting a join, find out whether the key you are joining on is actually unique.',
    substitute: ['your_table', 'id'],
    sql: 'SELECT id, count(*) AS n\nFROM your_table\nGROUP BY id\nHAVING count(*) > 1\nORDER BY n DESC;',
  }),
  Object.freeze({
    id: 'null-audit',
    topic: 'Data quality',
    title: 'Null rate for every column',
    why: 'Answers the question a stakeholder asks after they see the number: how much of this was missing?',
    substitute: ['your_table'],
    sql: 'SELECT column_name, null_percentage\nFROM (SUMMARIZE your_table)\nORDER BY null_percentage DESC;',
  }),
  Object.freeze({
    id: 'anti-join',
    topic: 'Joins',
    title: 'Rows on the left with no match on the right',
    why: 'The honest way to size a join problem before you run the join and lose rows without noticing.',
    substitute: ['left_table', 'right_table', 'id'],
    sql: 'SELECT l.*\nFROM left_table l\nANTI JOIN right_table r ON l.id = r.id;',
  }),
  Object.freeze({
    id: 'join-fanout',
    topic: 'Joins',
    title: 'Check a join for fan-out before running it',
    why: 'A join that multiplies rows inflates every sum downstream, and it looks like growth.',
    substitute: ['left_table', 'right_table', 'id'],
    sql: 'SELECT (SELECT count(*) FROM left_table) AS left_rows,\n       (SELECT count(*) FROM right_table) AS right_rows,\n       (SELECT count(*) FROM left_table l JOIN right_table r ON l.id = r.id) AS joined_rows;',
  }),
  Object.freeze({
    id: 'month-spine',
    topic: 'Time',
    title: 'Every month in a range, including the empty ones',
    why: 'A GROUP BY over months only returns months that had rows, so a chart built from it hides the gaps entirely.',
    substitute: ['your_table', 'ts', 'amount'],
    sql: "WITH months AS (\n  SELECT unnest(generate_series(date_trunc('month', (SELECT min(ts) FROM your_table)),\n                               date_trunc('month', (SELECT max(ts) FROM your_table)),\n                               INTERVAL 1 MONTH)) AS month\n)\nSELECT m.month, coalesce(sum(t.amount), 0) AS total\nFROM months m\nLEFT JOIN your_table t ON date_trunc('month', t.ts) = m.month\nGROUP BY m.month\nORDER BY m.month;",
  }),
  Object.freeze({
    id: 'running-total',
    topic: 'Windows',
    title: 'Running total and month-over-month change',
    why: 'Two of the three numbers anyone asks for after seeing a monthly total.',
    substitute: ['your_table', 'month', 'amount'],
    sql: 'SELECT month,\n       amount,\n       sum(amount) OVER (ORDER BY month) AS running_total,\n       amount - lag(amount) OVER (ORDER BY month) AS change_vs_prior\nFROM your_table\nORDER BY month;',
  }),
  Object.freeze({
    id: 'unpivot-months',
    topic: 'Reshaping',
    title: 'Turn month columns back into rows',
    why: 'The classic spreadsheet shape: twelve columns that should have been one column and a date.',
    substitute: ['your_table', 'region'],
    sql: 'UNPIVOT your_table\nON COLUMNS(* EXCLUDE (region))\nINTO NAME month VALUE amount;',
  }),
  Object.freeze({
    id: 'top-n-per-group',
    topic: 'Windows',
    title: 'Top three per group',
    why: 'Reads far better than the self-join people write instead.',
    substitute: ['your_table', 'region', 'amount'],
    sql: 'SELECT *\nFROM your_table\nQUALIFY rank() OVER (PARTITION BY region ORDER BY amount DESC) <= 3;',
  }),
  Object.freeze({
    id: 'profile-table',
    topic: 'Data quality',
    title: 'Summarise every column at once',
    why: 'DuckDB will profile the whole table for you, which is faster than writing eleven aggregates.',
    substitute: ['your_table'],
    sql: 'SUMMARIZE your_table;',
  }),
]);

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Distinct snippet topics, in first-seen order. */
export function snippetTopics() {
  const out = [];
  for (const s of SQL_SNIPPETS) {
    if (out.indexOf(s.topic) < 0) out.push(s.topic);
  }
  return out;
}

/** Snippets for one topic, or all of them when no topic is given. */
export function listSnippets(topic) {
  const t = str(topic);
  if (!t) return SQL_SNIPPETS.slice();
  return SQL_SNIPPETS.filter(s => s.topic === t);
}

/** Divergences for one topic, or all of them. */
export function listDivergences(topic) {
  const t = str(topic);
  if (!t) return DUCKDB_DIVERGENCES.slice();
  return DUCKDB_DIVERGENCES.filter(d => d.topic === t);
}

export function buildSqlPowerPack() {
  return {
    kind: SQL_PACK_KIND,
    version: SQL_PACK_VERSION,
    engine: SQL_ENGINE_LABEL,
    honesty: SQL_HONESTY_NOTE,
    notSupported: SQL_NOT_SUPPORTED,
    divergences: DUCKDB_DIVERGENCES,
    snippets: SQL_SNIPPETS,
    topics: snippetTopics(),
  };
}

export const DataGlowSqlPowerPack = {
  SQL_PACK_KIND,
  SQL_PACK_VERSION,
  SQL_ENGINE_LABEL,
  SQL_HONESTY_NOTE,
  SQL_NOT_SUPPORTED,
  DUCKDB_DIVERGENCES,
  SQL_SNIPPETS,
  snippetTopics,
  listSnippets,
  listDivergences,
  buildSqlPowerPack,
};

try {
  if (typeof window !== 'undefined') window.DataGlowSqlPowerPack = DataGlowSqlPowerPack;
} catch (_e) {}
