# Capability detail — Drift, trend & fingerprinting

Companion to the **Drift, trend & fingerprinting** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on trend-aware (forecast-based) drift alerting or the informational expected-value
ranges; the index alone is enough for most tasks.

## Scope of THIS area (and how it differs from neighbours)

This page covers only two modules that **extend** the Distributional Fingerprint
Drift validation layer with *trajectory*-awareness:
1. **Forecast-Based Drift Alerting** (`js/drift/drift-forecast.js`) — asks the
   harder question: given the recent trend of this schema's uploads, is today's
   upload outside the range we'd have *expected* the next one to fall in?
2. **Expected Value Ranges** (`js/validation/expected-range.js`) — a purely
   informational narration of the same numeric-mean trend, changing no status.

Read these companions first to avoid conflating areas:
- The base **Distributional Fingerprint Drift** layer itself lives in
  `js/validation/` and is documented in
  [`validation-layers.md`](validation-layers.md). This area does **not**
  re-implement it — both modules here reuse the fingerprint numbers it produces.
- The **temporal** drift slice (`js/drift/dataset-differ.js`,
  `freshness-decay.js`) is a *different* area with its own page,
  [`data-quality-and-drift.md`](data-quality-and-drift.md) — do not duplicate it.
- The ambient **Semantic Drift Watchdog** (`js/ambient/drift-watchdog.js`,
  `semanticDriftWatchdog` flag) *presents* drift results but computes nothing —
  see [`ambient-and-real-time.md`](ambient-and-real-time.md).

## Flag / gating state — no dedicated flag; Settings opt-in

- Neither module has a feature flag in `flags.manifest.json` (grep for
  `driftForecast`/`forecast`/`expectedRange` matches only *other* flags'
  descriptions, e.g. `semanticDriftWatchdog` citing "forecast-based drift
  alerting" as an upstream it presents).
- Both are gated by the **`state.settings.persistFingerprints`** opt-in
  (cross-session drift-history store). When it's off, `renderForecastDrift` shows a
  "enable drift history tracking" locked message and `renderExpectedRanges` renders
  nothing. Both also require **≥ `MIN_FORECAST_HISTORY (4)`** prior uploads of the
  same schema before a forecast goes `active`; below that, callers fall back to the
  static base drift layer (a "warm-up" message).

## `js/drift/drift-forecast.js` — trend-aware drift alerting

Pure, dependency-free (no DuckDB/IndexedDB/DOM); persistence is the caller's job
via the injected fingerprint store. Reuses the base fingerprint's existing summary
numbers rather than recomputing from rows.
- **Method:** Holt's linear (double) exponential smoothing (Holt 1957) —
  `holtForecast(series, opts)` runs level+trend recursions with fixed, explainable
  constants `HOLT_ALPHA = 0.5`, `HOLT_BETA = 0.3` (deliberately not fitted, for
  reproducibility). Returns next-step forecast, final level/trend, and the
  in-sample one-step **residual std** used to size the band. Skips the t=1 residual
  (zero by construction) so the band isn't biased tight. `< 2` points → null.
- **Tracked stats:** `extractTrackedStats(fingerprint)` pulls three forecastable
  scalar series per column — missingness rate (`nullRate`, all columns), mean
  (numeric), and top-category share (`topProp`, categorical). Nothing computed from
  raw rows.
- **Band:** `FORECAST_Z = 2` (≈95% under approx-normal one-step error) ×
  residualStd; a stat whose actual value falls outside `[forecast ± band]` is
  flagged. `FORECAST_HISTORY_CAP = 24` bounds retained history.
- `forecastDriftReport(historyFingerprints, currentFingerprint, opts)` → `{ active,
  historyLen, minHistory }` when too little history, else `{ active: true, method,
  z, flags[], projections[] }`. `projections` holds every evaluated series (for
  transparency); `flags` is the out-of-band subset with plain-language messages
  (`describeForecastFlag`, direction `above`/`below`, rates clamped ≥0 for display).
- **Unified Signal Layer enrichment:** `enrichForecastWithSignals(report, lookup)`
  — if the user recently disabled/changed a validation rule on the same column
  (via the injected `lookup.recentRuleChange(column)` contract), appends that
  context to the flag message (`relatedRuleChange` field + `describeRelatedRuleChange`
  clause). Purely additive; no lookup/no match → report unchanged.
- Formatting helpers (`formatStatValue`, `statNoun`) live here, not the UI, so the
  text is unit-testable and identical everywhere.

## `js/validation/expected-range.js` — informational expected value ranges

Pure, dependency-free; **imports `formatStatValue` + `MIN_FORECAST_HISTORY` from
`../drift/drift-forecast.js`** so the Holt math and history threshold stay in one
place — it re-fits **nothing**, consuming the `projections` array the forecast
report already produced. Scope is numeric-column **means** only (`kind === 'mean'`);
missingness/category-share are left to the alerting layer.
- `expectedRangeReport(forecast)` → `{ active, historyLen, bands[] }`; returns
  `active: false` for a missing/inactive forecast or no numeric means (graceful
  fallback for too-little-history / legacy stores).
- `trendPerUploadPct(expected, trend)` — trend as a % of the prior level
  (`expected − trend`); null when the base is zero/non-finite (caller falls back to
  absolute phrasing). `FLAT_PCT_EPSILON = 0.5` below which a series is "holding
  roughly steady".
- `describeTrend` / `describeExpectedRange` — the plain-language sentence, always
  ending with the explicit "Informational context only — not a prediction."
  disclaimer, so it can never be mistaken for an alert.

## UI wiring (main.js)

Imports `driftForecast` (53) and `expectedRange` (55). Both render *inside* the
Distributional Fingerprint Drift card: `renderForecastDrift(forecast)` (7055) calls
`enrichForecastWithSignals(forecast, signalStore)` (7069) and shows the
`TREND-AWARE FORECAST` badge / flag list (`data-testid=forecast-drift`, and
`forecast-drift-locked` / `forecast-drift-warmup` states). `renderExpectedRanges`
(7113) calls `expectedRangeReport(forecast)` and renders the `EXPECTED VALUE RANGES`
block (`data-testid=expected-range`, `expected-range-badge`, `expected-range-bands`,
`expected-range-disclaimer`). Both return early when
`state.settings.persistFingerprints` is off.

## Tests

- `test/drift-forecast.test.mjs` — Holt smoothing, band sizing, tracked-stat
  extraction, report activation threshold, signal enrichment.
- `test/expected-range.test.mjs` — trend %, flat epsilon, band narration, the
  numeric-mean-only filter, and the inactive/legacy fallbacks.

Neighbouring drift test files that belong to *other* areas:
`test/distribution-fingerprint-drift.test.mjs` (base layer),
`test/drift-watchdog.test.mjs` (ambient), `test/temporal-drift-rulepacks-phase4.test.mjs`
(temporal).

## Related but not in scope

- The base Distributional Fingerprint Drift layer + `computeDistributionFingerprint`
  in `js/validation/` — see [`validation-layers.md`](validation-layers.md).
- The Unified Signal Layer store (`signalStore`) supplying `recentRuleChange`.
- The temporal drift + freshness area
  ([`data-quality-and-drift.md`](data-quality-and-drift.md)) and the ambient
  watchdog ([`ambient-and-real-time.md`](ambient-and-real-time.md)).
