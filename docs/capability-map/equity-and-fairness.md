# Capability detail — Equity & fairness

Companion to the **Equity & fairness** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the Phase 3 equity layer; the index alone is enough for most tasks.

## What this area is

The Phase 3 **Equity Stratification Layer**: four cooperating modules that
auto-detect equity-relevant columns, stratify outcome metrics by group, score
disparities against CMS thresholds, and emit a signed attestation for the Trust
Certificate. All fail open (any error → `idle` status). The pipeline order is
**detector → stratifier → scorer → attestation**.

**Flag:** `equityStratification` — **`enabled: true`** in `flags.manifest.json`
(added in `feature/equity-stratification-phase3`).

**Tests:** `test/equity-phase3.test.mjs` (covers all four modules).

**Wiring status:** no direct `main.js` reference. The layer is invoked from
`js/validation/validation.js` (results land in `validationResults.equity`), and
the attestation is embedded by `js/trust/trust-certificate.js`. The UI surface is
the existing validation suite / Trust Certificate, not a dedicated equity tab.

## `js/equity/equity-detector.js` — column classification (pure, sync)

`detectEquityColumns(cols)` takes `[{name, type}]` and returns `{ stratifiers,
metrics, hasEquityData, summary }` using broad **column-name regex heuristics**
(exported for tests). Stratifier roles: `race_ethnicity`, `sex_gender`,
`geography`, `payer`, `age_group`, `disability` (matched most-specific-first).
Metric kinds: `readmission`, `denial`, `mortality`, `los`, `cost` (numeric-gated),
`ed_utilization`, `quality` (numeric-gated). Domain-agnostic by design — a Lego
dataset's `country`/`price` gets the same treatment as `race_cd`/`readmit_30d`.
`hasEquityData` is true only when at least one stratifier AND one metric exist.

## `js/equity/equity-stratifier.js` — DuckDB GROUP BY bridge (async)

`stratifyEquity({ table, stratifiers, metrics, engine, rowLimit })` runs one
analysis per (metric × stratifier) pair via `engine.runQuery(sql)`. Exports
`STRATIFY_ROW_LIMIT = 50000` and `MAX_GROUPS = 50`. For each pair it:
counts distinct stratifier values (skips when 0, or when `> MAX_GROUPS` with a
"consider binning" rationale); samples via `USING SAMPLE 50000 ROWS` when the
table exceeds the limit (always labelled); runs an `AVG(CAST(... AS DOUBLE))`
GROUP BY (rate for binary, mean+sum for continuous — `los`/`cost`/`quality` are
continuous, the rest binary); then feeds the normalized groups to
`scoreDisparities`. All identifiers are quoted via `q()` (doubles embedded `"`),
and BigInt results are coerced through `safeNum`/`safeFloat`. Returns
`{ analyses, summary, status, level, rationale, totalRows, useSample }` with a
worst-status/worst-level rollup. Try/catch per analysis yields an `idle` result
with the error rather than throwing.

## `js/equity/disparity-scorer.js` — the statistics (pure, sync)

`scoreDisparities({ groups, metricType, metricName, stratifierName,
referenceMethod, thresholds })`. Exports the Phase 3 CMS-aligned constants:
`RATE_RATIO_WARN 1.25`, `RATE_RATIO_FAIL 1.50`, `ABS_DIFF_WARN 0.03`,
`ABS_DIFF_FAIL 0.05`, `SMD_WARN 0.10`, `SMD_FAIL 0.20`, `MIN_CELL_SIZE 5`.
Small cells (`n < minCellSize`) are suppressed; needs ≥ 2 eligible groups with
values or returns `idle`. Reference is the **population (n-weighted) mean** by
default, or the largest group. Binary groups score on rate ratio (with div-by-0
→ `Infinity`/`1` handling) and signed absolute difference; continuous groups on
standardized-relative-deviation (Cohen's d approximation). Per-group `level`
(high/medium/low/none) and roll-up `status` (fail/warn/pass) drive a
plain-language `rationale`. **Phase 4 hook:** the optional `thresholds` param plus
internal `resolveThresholds` lets a rulepack's `equity.binary`/`equity.continuous`
override the exported constants (see [`rule-packs.md`](rule-packs.md)); omitting it
preserves Phase 3 behavior.

## `js/equity/equity-attestation.js` — signed attestation block (async)

`buildEquityAttestation({ tableName, runId, detectionResult,
stratificationResult, analysedAt })` assembles a plain object embedded in the
Trust Certificate: verdict, `stratifiersDetected`/`metricsDetected`,
`statusBreakdown`, `topFindings` (worst 10, fail-before-warn), `suppressedGroups`,
a `methodology` note, and `ATTESTATION_VERSION = '1.0'`. It appends a SHA-256
`signature` over the canonical (sorted-key) JSON of the content — via
`crypto.subtle.digest` in the browser, Node's `crypto.createHash` in tests, with a
non-cryptographic checksum last resort. Anyone can re-hash the content to verify
integrity, mirroring `provenance-packet.js`.

## Related but not in scope

- `js/validation/validation.js` — the orchestrator that invokes this layer.
- `js/trust/trust-certificate.js` — embeds the attestation block.
- **Rule packs** — supply the Phase 4 threshold overrides consumed by the scorer.
