# Capability detail — Relational integrity

Companion to the **Relational integrity** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the cross-row / cross-table relational checkers; the index alone is enough for
most tasks.

## How the area is shaped

Four standalone, DOM/network-free checker modules live under `js/relational/`, each
exporting pure async functions that take a DuckDB-engine adapter (`{ runQuery(sql)
-> {rows} }`) and emit a `{ status, level, summary, rationale, ... }` result. They
are orchestrated by `runRelationalLayer` in `js/validation/validation.js` (see "UI
wiring"). Two operate **within a single row** (temporal order, flag consistency);
two operate **across two tables** (foreign key / orphan, join coverage). All share
the helpers `q` (identifier quoting) and `safeNum` (bigint-safe counts) and the same
vocabulary: status `pass` / `warn` / `fail` / `idle`, level `none` / `low` /
`medium` / `high`.

## Foreign key / orphan checker — `js/relational/foreign-key-checker.js`

`checkForeignKey({ childTable, childCol, parentTable, parentCol, engine, label? })`
counts non-null child FK values, counts NULLs separately (NULLs are reported but
NOT treated as orphans), then counts child rows whose FK value is `NOT IN (SELECT
DISTINCT parentCol FROM parentTable WHERE parentCol IS NOT NULL)`. Up to 5 distinct
orphan keys are sampled for the rationale. Returns `{ layer:'foreign_key',
relationship, totalRows, orphanCount, orphanRate, nullCount, orphanSample, status,
level, summary, rationale }`. Thresholds via `rateLevel`: rate 0 or `< FK_WARN_RATE`
(0.001) → `pass`; `< FK_FAIL_RATE` (0.01) → `warn`/low; `< 0.05` → `fail`/medium;
else `fail`/high. Empty child table → `pass` with check skipped; a thrown query →
`idle`.

`checkAllForeignKeys(pairs, engine)` runs a list of pair option objects sequentially
and rolls up to the worst status/level, summing `totalOrphans`. Empty/invalid input
→ `idle`.

## Join coverage checker — `js/relational/join-coverage-checker.js`

`checkJoinCoverage({ childTable, childCol, parentTable, parentCol, engine, label? })`
is the complement of the FK check: it measures how well the tables join rather than
which child rows are broken. It computes `childCoverageRate` (child rows whose key
matches a parent key ÷ non-null child rows) and `parentCoverageRate` (`COUNT(DISTINCT
childCol)` that matches ÷ total parent rows). Status is driven by the **child side**
via `coverageLevel`: `null` rate → `idle`; `>= JOIN_WARN_RATE` (0.95) → `pass`; `>=
JOIN_FAIL_RATE` (0.90) → `warn`/low; `>= 0.75` → `fail`/medium; else `fail`/high.
(Note the exported constants name the 0.95/0.90 cutoffs; the sub-0.75 tier is inline.)
Both tables empty → `idle`. Returns `{ layer:'join_coverage', relationship,
childTotal, childMatched, parentTotal, parentMatched, childCoverageRate,
parentCoverageRate, status, level, summary, rationale }`.

`checkAllJoinCoverage(pairs, engine)` runs many pairs and rolls up to the worst
status/level, listing failing relationships with their coverage percentages.

## Temporal order checker — `js/relational/temporal-order-checker.js`

`checkTemporalOrder({ table, cols, engine, explicitRules? })` detects "time travel"
within a row: a later-event date that precedes an earlier-event date. Rules come
from `TEMPORAL_RULES` (five built-ins: `admit_before_discharge`,
`order_before_result`, `claim_before_payment`, `birth_before_death` — all `hard` —
and `service_before_auth` — `soft`). Each rule carries `earlierPattern` /
`laterPattern` regexes; `detectApplicableRules` auto-binds a rule to concrete
columns when both patterns match distinct column names, unless `explicitRules` is
passed. Per rule, it counts rows where both dates are populated, then rows where
`TRY_CAST(laterCol AS DATE) < TRY_CAST(earlierCol AS DATE)`. `temporalLevel`: hard
rules `fail` at any rate (low/medium/high by rate against `TEMPORAL_FAIL_RATE` 0.01
and 0.05); soft rules `pass` below `TEMPORAL_WARN_RATE` (0.001), then `warn`/`fail`.
No matching column pairs, empty table, or thrown query → `idle`. Returns `{ rules:
results[], summary, status, level, rationale }`; each rule result carries
`layer:'temporal_order', ruleId, earlierCol, laterCol, severity, violationCount,
violationRate, ... }`.

## Flag consistency checker — `js/relational/flag-consistency-checker.js`

`checkFlagConsistency({ table, cols, engine, extraRules? })` detects logically
impossible binary-flag combinations within a row. `FLAG_RULES` holds six built-ins
(`readmit_30d_implies_90d`, `readmit_7d_implies_30d`, `readmit_7d_implies_90d`,
`inpatient_outpatient_exclusive`, `emergency_elective_exclusive` — all `hard` — and
`deceased_live_discharge` — `soft`). Each rule declares `requiredCols` and a
`condition(table)` that builds the SQL WHERE identifying violating rows; only rules
whose `requiredCols` all exist in `cols` are run, merged with any `extraRules`. Per
rule it counts total rows then violating rows. `flagLevel`: hard rules `fail` at any
rate (low/medium/high against `FLAG_FAIL_RATE` 0.01 and 0.05); soft rules `pass`
below `FLAG_WARN_RATE` (0.001), then `warn`/`fail`. No applicable rules or empty
table → `idle`. Returns `{ rules: results[], summary, status, level, rationale }`;
each rule result carries `layer:'flag_consistency', ruleId, requiredCols, severity,
violationCount, violationRate, ... }`.

## UI wiring

The four checkers are **not** referenced directly in `js/app-shell/main.js`. They
are imported and orchestrated by `runRelationalLayer(ds, cols, options)` in
`js/validation/validation.js` (lines ~1483–1545), called from `runAllLayers` and
stored as `results.relational` (rolled up as `.temporal`, `.flagConsistency`,
`.fkCheck`, `.joinCoverage`). Cross-table FK/join pairs come from
`options.relationalPairs` or `autoDetectPairs`, which matches FK-shaped column names
(`*_id`, `<table>_*`) against other loaded datasets — so FK and join coverage only
fire when a second table is loaded. The layer fails open: any sub-check error yields
`idle`. `main.js` surfaces the result only generically via `state.validationResults`
/ `runAllLayers`; there is no dedicated relational UI panel in `main.js`.

## Gating flags (from `flags.manifest.json`)

Each sub-check is gated by its own flag, all added in
`feature/relational-integrity-phase2` and currently **live** (not dark):

- `temporalOrderChecks` — `enabled: true`
- `flagConsistencyChecks` — `enabled: true`
- `joinCoverageChecks` — `enabled: true`
- `crossTableReferentialIntegrity` — `enabled: true` (gates `checkAllForeignKeys`)

When a flag is off, its sub-result stays `idle` with a "not enabled" summary; the
modules themselves are unconditionally imported, so the gating is at the orchestrator
call site, not at import time.

## Tests

- `test/relational-integrity-phase2.test.mjs` — the direct suite; imports all four
  modules from `js/relational/` and exercises `checkForeignKey`,
  `checkTemporalOrder`, `checkFlagConsistency`, `checkJoinCoverage` (and the
  `checkAll*` batch variants) against the Node DuckDB engine. Run per its header with
  `node --import ./test/duckdb-loader-hook.mjs`.

Note: `test/readmit-flag-consistency.test.mjs` looks related by name but tests the
readmission rule in `js/validation/cross-column-consistency.js`, NOT the relational
flag-consistency checker.

## Related files not in scope

- `js/validation/validation.js` — the orchestrator (`runRelationalLayer`,
  `autoDetectPairs`, `runAllLayers`) that wires these modules into the validation run.
- `js/validation/cross-column-consistency.js` — the older single-table cross-column
  rule engine (including its own readmission rule); overlaps conceptually with the
  flag consistency checker but is a distinct module.
- `js/equity/equity-stratifier.js` — reuses the same DuckDB engine adapter shape as
  the Phase 2 relational checkers.
