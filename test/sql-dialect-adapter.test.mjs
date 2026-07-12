// ============================================================
// DATAGLOW — Multi-Dialect SQL Translation Layer test suite
// ============================================================
// (Polyglot Workbench, Batch A.) Proves translateDialectSql(sql, dialect) is an
// HONEST, pure string->string rewriter of the high-value, concretely-incompatible
// bits of five warehouse dialects into DuckDB SQL:
//   - 'duckdb' is an exact no-op passthrough
//   - each dialect's documented rules produce the expected before/after SQL
//   - string literals / comments containing dialect-looking tokens are NEVER
//     corrupted (the masking guarantee)
//   - and — because the whole point is "runnable on DuckDB, not faked" — a
//     sample of each dialect's TRANSLATED output is executed against a real
//     DuckDB engine (@duckdb/node-api) and must return the expected value.
//
// RUN WITH: node test/sql-dialect-adapter.test.mjs (pure logic + a real DuckDB
// round-trip; no browser Worker/WASM and no loader hook needed since the adapter
// itself imports neither the DOM nor the DuckDB engine).

import { DuckDBInstance } from '@duckdb/node-api';
import { translateDialectSql, SUPPORTED_DIALECTS } from '../js/app-shell/sql-dialect-adapter.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
}

async function main() {
  const conn = await (await DuckDBInstance.create(':memory:')).connect();
  // A tiny fixture table every execution check can query.
  await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
    ('john', 10, 2), ('JANE', 20, 0), ('bob', 30, 5)) AS v(name, x, b)`);

  // Run translated SQL and return the first cell of the first row (as a JS value).
  async function firstCell(sql) {
    const reader = await conn.runAndReadAll(sql);
    const rows = reader.getRows();
    return rows.length ? rows[0][0] : undefined;
  }
  async function runsOk(sql) {
    try { await conn.run(sql); return true; } catch { return false; }
  }

  // ---------- SUPPORTED_DIALECTS shape ----------
  ok(Array.isArray(SUPPORTED_DIALECTS) && SUPPORTED_DIALECTS.length === 6,
    `SUPPORTED_DIALECTS lists all 6 dialects (got ${SUPPORTED_DIALECTS.length})`);
  {
    const ids = SUPPORTED_DIALECTS.map((d) => d.id).sort().join(',');
    eq(ids, 'bigquery,duckdb,mysql,postgres,snowflake,tsql', 'SUPPORTED_DIALECTS: exactly the expected ids');
    ok(SUPPORTED_DIALECTS.every((d) => typeof d.label === 'string' && typeof d.description === 'string'),
      'SUPPORTED_DIALECTS: every entry has a label + description for the picker');
  }

  // ---------- duckdb: exact no-op passthrough ----------
  {
    const src = "SELECT `not touched`, TOP, IFF FROM t WHERE x = 'LIMIT 1,2' -- keep me\n";
    eq(translateDialectSql(src, 'duckdb'), src, 'duckdb: passthrough is byte-for-byte identical');
    eq(translateDialectSql('SELECT 1', 'duckdb'), 'SELECT 1', 'duckdb: simple query unchanged');
    // Unknown / empty dialects also fail safe to passthrough (never corrupt).
    eq(translateDialectSql('SELECT `x`', 'nonsense'), 'SELECT `x`', 'unknown dialect: safe passthrough');
    eq(translateDialectSql('SELECT 1', ''), 'SELECT 1', 'empty dialect: safe passthrough');
    eq(translateDialectSql(null, 'mysql'), '', 'null sql: coerced to empty string, no throw');
  }

  // ---------- MySQL ----------
  {
    eq(translateDialectSql('SELECT `first name`, `x` FROM t', 'mysql'),
      'SELECT "first name", "x" FROM t', 'mysql: backtick identifiers -> double-quoted');
    eq(translateDialectSql('SELECT * FROM t LIMIT 5,10', 'mysql'),
      'SELECT * FROM t LIMIT 10 OFFSET 5', 'mysql: LIMIT off,cnt -> LIMIT cnt OFFSET off');
    eq(translateDialectSql('SELECT IFNULL(x, 0) FROM t', 'mysql'),
      'SELECT COALESCE(x, 0) FROM t', 'mysql: IFNULL -> COALESCE');
    eq(translateDialectSql('SELECT NOW()', 'mysql'),
      'SELECT now()', 'mysql: NOW() normalized to now()');
    // Executes on DuckDB and skips the first 2 ordered rows (10, 20) -> 30.
    const off = await firstCell(translateDialectSql('SELECT x FROM t ORDER BY x LIMIT 2,10', 'mysql'));
    ok(Number(off) === 30, `mysql: translated LIMIT 2,10 offsets correctly on DuckDB (got ${off})`);
    ok(await runsOk(translateDialectSql('SELECT `name`, IFNULL(`x`, 0) FROM t', 'mysql')),
      'mysql: translated backtick+IFNULL query executes on DuckDB');
  }

  // ---------- PostgreSQL ----------
  {
    // Already-compatible constructs must be left EXACTLY as-is.
    for (const s of [
      "SELECT x::INTEGER FROM t",
      "SELECT * FROM t WHERE name ILIKE 'jo%'",
      "SELECT * FROM t WHERE name ~ 'jo'",
      "SELECT 'a' || 'b'",
    ]) {
      eq(translateDialectSql(s, 'postgres'), s, `postgres: already-compatible left unchanged — ${s}`);
    }
    // The one real incompatibility: ~* case-insensitive regex.
    eq(translateDialectSql("SELECT * FROM t WHERE name ~* 'JOHN'", 'postgres'),
      "SELECT * FROM t WHERE regexp_matches(name, 'JOHN', 'i')", 'postgres: ~* -> regexp_matches(.., "i")');
    const hit = await firstCell(translateDialectSql("SELECT COUNT(*) FROM t WHERE name ~* 'JANE'", 'postgres'));
    ok(Number(hit) === 1, `postgres: translated ~* matches case-insensitively on DuckDB (got ${hit})`);
    ok(await runsOk(translateDialectSql("SELECT x::INTEGER FROM t WHERE name ILIKE 'j%'", 'postgres')),
      'postgres: compatible cast+ILIKE query executes on DuckDB unchanged');
  }

  // ---------- BigQuery ----------
  {
    eq(translateDialectSql('SELECT * FROM `my-project.analytics.t`', 'bigquery'),
      'SELECT * FROM t', 'bigquery: `project.dataset.table` -> bare table name');
    eq(translateDialectSql('SELECT SAFE_CAST(x AS INTEGER) FROM t', 'bigquery'),
      'SELECT TRY_CAST(x AS INTEGER) FROM t', 'bigquery: SAFE_CAST -> TRY_CAST');
    eq(translateDialectSql('SELECT CURRENT_TIMESTAMP()', 'bigquery'),
      'SELECT now()', 'bigquery: CURRENT_TIMESTAMP() -> now()');
    ok(await runsOk(translateDialectSql('SELECT SAFE_CAST(x AS INTEGER) AS n FROM `p.d.t`', 'bigquery')),
      'bigquery: translated FQ-table + SAFE_CAST query executes on DuckDB');
    const safe = await firstCell(translateDialectSql("SELECT SAFE_CAST('nope' AS INTEGER)", 'bigquery'));
    ok(safe === null || safe === undefined, `bigquery: translated SAFE_CAST of bad value -> TRY_CAST NULL (got ${safe})`);
  }

  // ---------- Snowflake ----------
  {
    eq(translateDialectSql("SELECT IFF(x > 15, 'big', 'small') FROM t", 'snowflake'),
      "SELECT CASE WHEN x > 15 THEN 'big' ELSE 'small' END FROM t", 'snowflake: IFF -> CASE WHEN');
    eq(translateDialectSql('SELECT DIV0(x, b) FROM t', 'snowflake'),
      'SELECT CASE WHEN (b) = 0 THEN 0 ELSE (x) / (b) END FROM t', 'snowflake: DIV0 -> safe-division CASE');
    // double-quoted identifiers already compatible -> unchanged
    eq(translateDialectSql('SELECT "x" FROM t', 'snowflake'),
      'SELECT "x" FROM t', 'snowflake: double-quoted identifiers left unchanged');
    // Nested-call arg is preserved by the balanced-paren rewrite.
    eq(translateDialectSql('SELECT IFF(x > ABS(b), 1, 0) FROM t', 'snowflake'),
      'SELECT CASE WHEN x > ABS(b) THEN 1 ELSE 0 END FROM t', 'snowflake: IFF preserves nested function-call args');
    // DIV0 by zero returns 0 (not an error) after translation, on real DuckDB.
    const d = await firstCell(translateDialectSql('SELECT DIV0(x, b) FROM t WHERE b = 0', 'snowflake'));
    ok(Number(d) === 0, `snowflake: translated DIV0 by zero returns 0 on DuckDB (got ${d})`);
  }

  // ---------- T-SQL ----------
  {
    eq(translateDialectSql('SELECT TOP 2 x FROM t ORDER BY x', 'tsql'),
      'SELECT x FROM t ORDER BY x LIMIT 2', 'tsql: TOP n -> LIMIT n moved to end');
    eq(translateDialectSql('SELECT TOP 2 x FROM t ORDER BY x;', 'tsql'),
      'SELECT x FROM t ORDER BY x LIMIT 2;', 'tsql: TOP n with trailing semicolon keeps the semicolon last');
    eq(translateDialectSql('SELECT [first name], [x] FROM t', 'tsql'),
      'SELECT "first name", "x" FROM t', 'tsql: [bracket] identifiers -> double-quoted');
    eq(translateDialectSql('SELECT GETDATE()', 'tsql'),
      'SELECT now()', 'tsql: GETDATE() -> now()');
    eq(translateDialectSql('SELECT ISNULL(x, 0) FROM t', 'tsql'),
      'SELECT COALESCE(x, 0) FROM t', 'tsql: ISNULL -> COALESCE');
    const n = await firstCell(translateDialectSql('SELECT TOP 2 x FROM t ORDER BY x', 'tsql'));
    ok(Number(n) === 10, `tsql: translated TOP 2 runs and honors ORDER BY on DuckDB (got ${n})`);
    ok(await runsOk(translateDialectSql('SELECT TOP 1 [name], ISNULL([x], 0) FROM t ORDER BY [x]', 'tsql')),
      'tsql: translated TOP + brackets + ISNULL query executes on DuckDB');
  }

  // ---------- string-literal / comment protection (the masking guarantee) ----------
  {
    // A literal that CONTAINS dialect-looking tokens must be left verbatim.
    eq(translateDialectSql("SELECT 'use LIMIT 5,10 and `backticks` here' AS note FROM t", 'mysql'),
      "SELECT 'use LIMIT 5,10 and `backticks` here' AS note FROM t",
      'mysql: dialect tokens INSIDE a string literal are not translated');
    eq(translateDialectSql("SELECT '[not an ident] TOP GETDATE()' AS s", 'tsql'),
      "SELECT '[not an ident] TOP GETDATE()' AS s",
      'tsql: bracket/TOP/GETDATE inside a string literal are not translated');
    eq(translateDialectSql("SELECT x /* IFF(a,b,c) DIV0(a,b) */ FROM t", 'snowflake'),
      "SELECT x /* IFF(a,b,c) DIV0(a,b) */ FROM t",
      'snowflake: dialect tokens inside a block comment are not translated');
    // A real token OUTSIDE the literal still translates while the literal is safe.
    eq(translateDialectSql("SELECT `col`, 'a `b` c' FROM t", 'mysql'),
      "SELECT \"col\", 'a `b` c' FROM t",
      'mysql: backtick identifier translated while backtick inside literal preserved');
    // And the result still executes on DuckDB.
    ok(await runsOk(translateDialectSql("SELECT 'LIMIT 1,2' AS lit, `x` FROM t", 'mysql')),
      'mysql: literal-preserving translation still executes on DuckDB');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
