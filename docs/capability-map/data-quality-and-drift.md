# Capability detail — Data quality & drift

Companion to the **Data quality & drift** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the Phase 4 Temporal Drift path; the index alone is enough for most tasks.

## Scope of THIS area (and how it differs from neighbours)

This page covers only the two Phase 4 modules `js/drift/dataset-differ.js` and
`js/drift/freshness-decay.js`. It is **deliberately distinct** from two nearby
things — read this first so you don't duplicate or conflate them:

- **Distributional Fingerprint Drift** (validation layer 17) is a *single-load*
  check that stores each column's distribution shape and flags drift on a later
  load of the same schema. It is documented in
  [`validation-layers.md`](validation-layers.md) and lives in
  `js/validation/`, extended by `js/drift/drift-forecast.js` and
  `js/validation/expected-range.js`. This area does **not** re-implement it.
- The broader **"Drift, trend & fingerprinting"** area in the index groups the
  fingerprint/forecast/trend modules. The two modules here are the *temporal*
  (age + snapshot-to-snapshot) slice specifically, surfaced as the validation
  suite's `temporal_drift` result.

Both modules ship behind the **`temporalDrift`** flag, currently
`enabled: true` (`addedInPR: feature/temporal-drift-rulepacks-phase4`). Neither
is imported directly in `js/app-shell/main.js`; they are consumed by the
validation orchestrator, which writes their output to
`validationResults.temporal_drift`. Both **fail open** (any error → benign/idle
result, never a throw).

## `js/drift/dataset-differ.js` — snapshot capture + diff

Compares two point-in-time snapshots of the *same* dataset ("last month's
export" vs "this month's") to catch changes that look invisible but invalidate
cached analysis or signal an upstream ETL problem.

- `captureSnapshot({ table, cols, engine, label, capturedAt })` → async. The only
  impure function: runs DuckDB queries via the injected `engine.runQuery` for row
  count and, per column, null rate, distinct count, and (numeric columns only)
  min/max/mean. Returns a `dataglow_snapshot` v1.0 object — a few KB, cheap to
  store. `q()` quote-escapes identifiers; `safeNum`/`safeFloat` coerce BigInt.
- `diffSnapshots(snapA, snapB, opts)` → pure. Rolls up four finding families into
  a single `{ layer:'dataset_diff', status, level, findings, flaggedCount,
  schemaDiff, statsDiff, rationale }`. Default thresholds:
  - row count: warn ≥ 5% change, fail ≥ 20% (level `high` ≥ 50%);
  - null rate: warn ≥ 5 pp shift, fail ≥ 15 pp (level `high` ≥ 30 pp);
  - mean: warn ≥ 20% relative, fail ≥ 50% (level `high` ≥ 100%).
  - `buildSchemaDiff` classifies columns as added (`warn`/low), removed
    (`fail`/medium), or type-changed (`warn`/medium); `buildStatsDiff` handles the
    null-rate and mean shifts. Status rolls up worst-of; `rationale` is a
    plain-language summary listing the first three findings.
- If either snapshot is null → `status:'idle'` with an explanatory rationale.

## `js/drift/freshness-decay.js` — age-based trust discount

Pure and synchronous. Discounts a dataset's trust score by how old the data is,
so a certificate honestly reflects temporal degradation.

- `computeFreshnessDecay({ dataDate, asOf, packId, freshnessConfig })` → result
  with `status` (`fresh|stale|expired|unknown`), a `multiplier` in
  `[decayFloor, 1.0]`, `ageDays`, and a rationale. Pulls `staleAfterDays`,
  `expiredAfterDays`, `decayFloor`, `decayShape`, `rationale` from the active
  rulepack via `getRulepack(packId || 'general').freshness` (or an override
  `freshnessConfig`). Fresh window → 1.0; past expiry → capped at `decayFloor`;
  between → `linear` (even) or `exponential` (`decayFloor + (1-decayFloor)·e^(-3·progress)`)
  decay. Missing/invalid `dataDate` → `status:'unknown'`, multiplier 1.0.
- `applyFreshnessDecay(score, decayResult)` → `{ originalScore, adjustedScore,
  multiplier }`.
- `freshnessLabel(decayResult)` → short badge string for the Trust Certificate.

This module depends on `../rulepacks/rulepack-registry.js` (the versioned
rulepack system, `rulepacks` flag) for its thresholds — that is a related area,
not part of this one.

## Tests

- `test/temporal-drift-rulepacks-phase4.test.mjs` — the Phase 4 suite covering
  snapshot capture/diff thresholds, freshness decay shapes, and rulepack pinning.

Related test files that belong to the neighbouring drift/fingerprint areas, not
this one: `test/distribution-fingerprint-drift.test.mjs`,
`test/drift-forecast.test.mjs`, `test/drift-watchdog.test.mjs`.

## Related but not in scope

- `js/validation/` Distributional Fingerprint Drift layer — see
  [`validation-layers.md`](validation-layers.md).
- `js/rulepacks/rulepack-registry.js` — supplies the freshness thresholds.
- `js/ambient/drift-watchdog.js` — the ambient/real-time drift watcher (separate
  area).
