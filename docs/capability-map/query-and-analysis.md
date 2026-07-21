# Capability detail — Query & analysis

Companion to the **Query & analysis** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

The core analytical engine: everything that turns a loaded dataset into an answer.
Backing modules: `js/nl/nl-engine.js` (natural-language query) and
`js/sql/sql-engine.js` (SQL execution via DuckDB-WASM).

## SQL engine (`sql-engine.js`)

- Wraps DuckDB-WASM with a consistent async `query(sql, opts)` interface.
- All SQL runs in-browser via WebAssembly — zero server round-trips, zero data egress.
- Supports multi-dialect input: Postgres, MySQL, BigQuery, Snowflake, and T-SQL
  syntax is translated to DuckDB syntax before execution (see Polyglot Workbench).
- Query results are typed arrays accessed by column index (`r[colIdx]`), not by
  name, to avoid column-rename collisions.
- Column types are normalised to `'INT'`, `'FLOAT'`, `'STR'`, `'DATE'`, `'BOOL'`.

## NL engine (`nl-engine.js`)

- Accepts a natural-language question and a schema context (column names + types,
  never row data) and produces a DuckDB-compatible SQL statement.
- Schema-only privacy: the LLM sees column structure, not values.
- Pattern engine (`nl-sql-pattern-engine.js`) handles common analytical intents
  (aggregation, filtering, ranking, time-series grouping) without an LLM call,
  keeping frequent queries fast and offline.
- API key is BYO, per-session, held in page memory only.

## Query Sentinel

Pre-flight safety layer that runs before any generated SQL executes. Detects:
- Fanout joins (Cartesian products that inflate row counts)
- Join-key type mismatches
- Additivity violations (summing non-additive metrics)
- Sensitive-column exposure (PHI/PII in SELECT output)

See also: `query-sentinel.js`, `query-sentinel-assist.js`, `query-sentinel-bridge.js`.

## Query Memory

Fingerprints every query so repeated queries show a "seen before" badge.
Helps analysts notice when they are re-running known work instead of exploring.
See `query-memory.js`, `query-memory-ui.js`.
