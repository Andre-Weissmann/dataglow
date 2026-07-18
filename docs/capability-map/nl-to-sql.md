# Capability detail — NL-to-SQL

Companion to the **NL-to-SQL** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the natural-language question → DuckDB SQL path; the index alone is enough for
most tasks.

## Shape of the area

Six modules under `js/nl-sql/`. The headline design decision: a **zero-cost
pattern engine runs FIRST and answers most questions offline with no API key**;
an LLM provider is a strictly secondary fallback for freeform questions the
pattern engine cannot answer confidently. Privacy is structural — every module
only ever touches column **names and types**, never a single row value.

Flag: **`nlSql`**, currently `enabled: true` in `flags.manifest.json`
(`addedInPR: feature/phase9-nl-sql`). The in-code comment on `renderNLSQLTab`
still reads "ships dark behind the nlSql flag" from Phase 9, but the flag has
since been promoted ON — the "AI" tab is live. `switchTab`/`renderTabBar` filter
the `nlsql` tab out only when `isEnabled('nlSql')` is false.

## `nl-sql-engine.js` — orchestrator

`nlToSQL(opts)` is the entry point. Flow: `datasetsToSchemaContext` →
`matchContracts` → `buildSystemPrompt` → **pattern engine first**
(`buildPatternSQL`; accepted only at `high`/`medium` confidence) → else LLM
fallback (`callLLM` injection or `callLLMProvider` with a resolved key) →
`extractSQL` → `validateSQL` → `explainSQL`. Returns a rich object
(`{ sql, explanation, contractsUsed, warnings, raw, systemPrompt, steps,
confidence, source }`) where `source` is one of `contract|pattern|llm|none`.
- `buildSystemPrompt(schemaCtx, matchedContracts)` — 8 hard rules (SELECT-only,
  double-quote identifiers, use contract expressions verbatim, default
  `LIMIT 1000`, healthcare-analyst interpretation for ambiguity).
- `extractSQL(raw)` strips markdown fences (built via `String.fromCharCode(96…)`
  to avoid literal backticks in source).
- `validateSQL(sql)` — lightweight, no full parse: must start with SELECT; blocks
  INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/GRANT/REVOKE; rejects
  semicolon-chained statements; warns on a missing FROM.
- `NL_SQL_PROVIDERS` — OpenAI, Anthropic, Google, Perplexity configs (BYO key,
  `temperature:0`, `max_tokens:512`); `callLLMProvider` routes to
  `callAnthropic` / `callGoogle` / `callOpenAICompat`. Re-exports the pattern
  helpers so the UI imports everything from one module.

## `nl-sql-pattern-engine.js` — the primary path (pure, no key, no network)

Written under iOS WKWebView constraints (no backticks, no apostrophes in
single-quoted strings; `+` concatenation only).
- `detectColumns(question, allCols)` → `{ exact, fuzzy }` via normalized
  (lowercased, underscore/space/hyphen-stripped) matching, with a `STOP_WORDS`
  set and 3+ char word tokens.
- `detectIntent(question)` → one of
  `count|trend|rank|compare|aggregate|group|filter|list|general` (order matters;
  `count` uses whole-word matching so "encounters" doesn't trigger it).
- `buildPatternSQL(question, schemaCtx, matchedContracts)` →
  `{ sql, explanation, steps, confidence }` (sql `null` when not confident, so
  it falls through to the LLM). Dedicated builders per intent: metric-contract
  path (highest confidence, substitutes `{{table}}`/`{{col}}`, builds a CTE when
  `isComplex`), COUNT, AGGREGATE (AVG/SUM on a detected numeric col), TREND
  (`DATE_TRUNC` with month/week/year/day grain), RANK (top/bottom 10), GROUP,
  LIST, FILTER (honest preview since row values are unknown).
- `autoFixSQL(badSQL, errorMessage, schemaCtx)` → `{ sql, fix }` — repairs a
  failed query by fuzzy-substituting an unknown column/table with the closest
  schema name, qualifying an ambiguous column with the primary table, or
  stripping a malformed trailing `LIMIT`/`ORDER BY`.
- `explainSQL(sql, schemaCtx)` → one/two plain-English sentences (no jargon).

## `schema-context.js` — privacy-enforced schema extractor

Turns DataGlow's `state.datasets` into an LLM-ready schema string with **no row
data**. `typeGroup(rawType)` normalizes DuckDB types to
`number|text|date|boolean|other`; `inferRelationships(tables)` guesses join edges
from ID-suffix column naming (`certain` vs `inferred`); `buildSchemaContext`,
`serializeSchemaForPrompt` (compact labelled text, enum samples capped at 8),
`datasetToTableSchema`, and `datasetsToSchemaContext` (also imported directly by
`main.js` for other prompt surfaces).

## `nl-sql-key-store.js` — in-memory API keys

Holds provider keys (`openai`/`anthropic`/`google`/`perplexity`) in **module RAM
only** — not localStorage/sessionStorage (both blocked in the iframe sandbox);
gone on reload. `setProviderKey(s)`, `getProviderKey`, `getAllProviderKeys`,
`hasAnyKey`, `clearProviderKeys`. Imported by both Settings (save) and the engine
(read at query time); `main.js` wires the `#nlsql-key-*` inputs +
`#btn-nlsql-keys-save`.

## `nl-sql-ui.js` — the tab

Single export `mountNLSQLUI({ host, datasets, onRunSQL, onToast })`. `main.js`
calls it from `renderNLSQLTab()` (tab id `nlsql`, labelled "AI"), and stores a
`host.__nlsql` handle so a DuckDB run error can be routed back via
`reportRunError(...)` (feeding `autoFixSQL`).

## Tests

- `test/phase9-nl-sql.test.mjs` — the original NL→SQL suite.
- `test/phase12-nlsql-upgrade.test.mjs` — the later pattern-engine/upgrade suite.

## Honest note on `js/nl-sql/metric-contracts.js` vs `js/metrics/metric-contracts.js`

They share a name but are **NOT a re-export or duplicate** — they are two
different concepts:
- `js/nl-sql/metric-contracts.js` (this area) is a registry of **business-metric
  SQL expression templates** used to make NL→SQL deterministic (dbt semantic-
  layer pattern). Exports `registerContract`, `unregisterContract`,
  `getAllContracts`, `getContract`, `matchContracts`, `bestMatch`,
  `contractToPromptFragment`. Ten built-in contracts (readmission rate, denial
  rate, avg length of stay, etc.); in-memory registry, keyword matching filtered
  by `requiredCols`.
- `js/metrics/metric-contracts.js` is the **Metric Contracts Batch 1 versioned
  data model** for Metric Studio — an append-only version history
  (`snapshotDefinition`, `recordVersion`, `diffVersions`) gated behind the
  separate `metricContracts` flag. See
  [`trust-and-metrics-onecanvas.md`](trust-and-metrics-onecanvas.md) for that
  side (and `test/metric-contracts*.test.mjs`, which cover the metrics version,
  not this one). The name collision is a naming coincidence, not shared code.
