# Capability detail — Anomaly & outlier detection

Companion to the **Anomaly & outlier detection** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the anomaly modules; the index alone is enough for most tasks.

## How the area is shaped

Six independent, pure-JS, dependency-free scorers under `js/anomaly/`. Each takes an
injected DuckDB `engine` (or the shared `js/app-shell/duckdb-engine.js`), runs one or two
SELECTs, and does everything else in memory. They are deliberately NOT part of the 20
validation layers (see [`validation-layers.md`](validation-layers.md)); they are complementary
scorers wired into the Validate tab, each call site wrapped in `.catch(() => …)`.

## The modules

### `js/anomaly/isolation-forest.js` — multivariate outliers (tree-isolation)
Isolation Forest (Liu, Ting & Zhou 2008). Anomaly score `s(x,n) = 2^(-E(h(x))/c(n))`
where `c(n)` is the average path length of an unsuccessful BST search (`cFactor`, using
Euler–Mascheroni 0.5772156649). Exports `scoreIsolationForest(table, numericCols, engine, options)`.
Constants: `N_TREES = 64`, `SUBSAMPLE = 256`, `SCORE_THRESHOLD = 0.6` (overridable via
`options.threshold`). `maxDepth = ceil(log2(subN))`. Keeps only fully-numeric rows; returns
`{ rows: [], columns }` if fewer than 4 usable points. Each result row: `{ rowIndex,
anomalyScore, isAnomaly, values }`, sorted by score descending.

### `js/anomaly/ondevice-ml.js` — diagonal-Mahalanobis + Anomaly Explainer
Approximates Mahalanobis distance (Mahalanobis 1936) with a DIAGONAL covariance (per-column
variance), keeping it dependency-free. Exports:
- `scoreMultivariateAnomalies(table, numericCols, engine)` — standardized centroid distance
  `sqrt(Σ (v-mean)²/var)`; `isAnomaly` when distance `> 3`. Rows `{ rowIndex, anomalyScore,
  isAnomaly, values }`, sorted descending.
- `pickPeerGroupColumn(table, cols, engine, options)` — picks a low-cardinality categorical
  peer-group column; rejects numeric/temporal (`DATETIME_TYPE = /\b(TIMESTAMP|DATE|TIME)\b/i`)
  and near-unique columns (`maxUniqueRatio` default 0.5); distinct count must be in
  `[2, max(20, rowCount/5)]`.
- `explainAnomaly(table, numericCols, rowIndex, engine, options)` — SHAP-style additive
  attribution (Lundberg & Lee 2017); each feature's contribution is its share of the total
  standardized squared distance, measured against the row's peer group (`options.groupColumn`,
  used when the peer set has ≥3 members, else the whole table). Returns `{ rowIndex, group,
  peerCount, contributions, reason }`.

### `js/anomaly/predictive-anomaly.js` — holistic mixed-type outliers (kNN + Gower)
Whole-row outliers whose COMBINATION of values is unusual (e.g. a 15-year-old with a
retirement account). kNN outlier factor (Ramaswamy et al. 2000; Angiulli & Pizzuti 2002)
over Gower distance (Gower 1971) so numeric and categorical features share a `[0,1]` scale.
Exports `scorePredictiveAnomalies(table, cols, engine, options)`, `selectFeatures(...)`,
`suppressAnomaliesWithVerdicts(result, lookup)`, `describeAnomaly(scored)`,
`describeSuppression(...)`, and const `MAX_ROWS = 2000`. Caps: `MAX_NUMERIC_FEATURES = 12`,
`MAX_CATEGORICAL_FEATURES = 6`, `CAT_UNIQUE_RATIO = 0.5`, `CAT_MAX_DISTINCT = 50`. Tables
over `MAX_ROWS` are uniformly down-sampled via a seeded Mulberry32 PRNG (`seed` default 1337)
and the sampling is disclosed. `k = max(3, min(options.k ?? 10, n-1))`; needs ≥2 features and
≥5 working rows. Threshold is dataset-relative: `mean + sigma·std` (`sigma` default 3) of the
kNN-distance distribution; also emits a 0..1 display `score`. `suppressAnomaliesWithVerdicts`
reads the injected SignalStore's `dismissalVerdict(column)` and only ever DOWNGRADES a flag
(sets `suppressed:true`, `isAnomaly:false`) for a row whose dominant contributor the user has
repeatedly dismissed — never creates a flag.

### `js/anomaly/entity-baseline.js` — per-entity (UEBA-style) baselining
Flags values abnormal for THAT entity, not the global column (catches a $12k invoice from a
$200–800 vendor). Exports `computeEntityBaselines(table, entityCol, valueCol, engine)` —
`AVG`/`STDDEV_POP`/`COUNT` grouped by entity — and `flagEntityDeviations(table, entityCol,
valueCol, baselines, engine)`, which flags when `|z| > 3` against the entity's own mean/stddev
(skips entities with null/zero stddev). Flags: `{ entity, value, entityMean, entityStddev,
zScore, reason }`, sorted by `|zScore|` descending.

### `js/anomaly/spc-control.js` — SPC control charts + Cpk
Shewhart control charts (Shewhart 1931): in control within mean ± 3σ. Imports the shared
`../app-shell/duckdb-engine.js` as default engine. `MAX_POINTS = 500`. Exports:
- `computeControlLimits(values)` → `{ mean, sigma, ucl = mean+3σ, lcl = mean-3σ, n }`
  (population variance).
- `computeCpk(values, usl, lsl)` → Six-Sigma `Cpk = min((USL-mean)/3σ, (mean-LSL)/3σ)`;
  when USL/LSL absent it infers them from observed min/max and sets `inferredSpec: true`;
  `cpk` is `null` when `sigma === 0`.
- `analyzeColumnSPC(table, col, engine)` → `{ column, values, limits, cpk, outOfControl }`
  (out-of-control = points outside UCL/LCL); `null` if fewer than 2 values.
- `analyzeAllNumericSPC(table, cols, engine)` — runs the above over all numeric columns.

Note: this module computes 3σ UCL/LCL and an out-of-control count only; it does NOT
implement the full Western Electric run rules (zone/streak tests).

### `js/anomaly/active-learning.js` — uncertainty sampling for imputation review
Uncertainty sampling (Settles 2009; ED2 framing, Neutatz et al. 2019). Surfaces the
imputation targets DataGlow is least sure about, first. Exports
`rankUncertainCells(table, cols, engine)` — considers only columns with null cells; for
numeric columns scores via coefficient of variation (`min(1, cv/2)`, so cv≥2 ⇒ max
uncertainty), for categoricals via mode-fill ambiguity (`1 − (top−second)/(top+second)` of the
two most frequent values). Returns `{ column, rowIdentifier, uncertaintyScore, reason }`,
sorted by score descending.

## Flag state

None of these six modules is registered in `flags.manifest.json` (grepped for `anomaly`,
`isolation`, `outlier`, `spc`, `shewhart`, `baselin`, `uncertaint`, `predictive`, `ondevice`,
`multivariate` — no matching flag key). They are **live, not flag-gated**: they render
unconditionally in the Validate-tab pipeline, so there is no ships-dark state to promote. (The
manifest mentions "anomaly" only inside the unrelated `oneCanvas` Trust Strip description.)

## UI wiring (`js/app-shell/main.js`)

All wired into the Validate flow, gated only on data shape, not on any flag. Imports at ~41–50
(`activeLearning`, `ondeviceML`, `scoreIsolationForest`, `scorePredictiveAnomalies`/
`suppressAnomaliesWithVerdicts`, `spc`, `entityBaseline`):
- `renderActiveLearning(ds)` (~2947, called ~2941) — "Review First — Most Uncertain Fills" list.
- `renderMultivariate(ds)` (~6039, called ~3211) — "Multivariate Outliers" panel combining the
  diagonal-Mahalanobis and Isolation Forest sections, with a per-row "Explain" button
  (`explainAnomaly`, ~6078) scoped to `pickPeerGroupColumn`.
- `renderPredictiveAnomaly(ds)` (~6099, called ~3212) — holistic-anomaly panel; runs
  `suppressAnomaliesWithVerdicts(res, signalStore)` (~6123) and shows sampling/suppression
  disclosures (`data-testid` `predictive-anomaly-*`).
- `renderSPC(ds)` (~6165, called ~3213) — control-chart cards per numeric column
  (`data-testid` `spc-<column>`).
- `renderEntityBaselines(ds)` (~6016, called ~5861) — deviation list; auto-selects an
  entity-like VARCHAR column + an amount-like numeric column, hides itself when none match.

## Tests

- `test/predictive-anomaly.test.mjs` — covers `scorePredictiveAnomalies`, `selectFeatures`,
  `describeAnomaly`, `MAX_ROWS` (run via the DuckDB loader hook against `node-duckdb-engine.mjs`).
- `test/uncertainty-resolver.test.mjs` — the agent-side "I don't know" resolver
  (`js/agents/uncertainty-resolver-agent.js`); related to uncertainty but NOT a test of this
  area's `active-learning.js`.

No dedicated test files exist for `isolation-forest.js`, `ondevice-ml.js`, `entity-baseline.js`,
`spc-control.js`, or `active-learning.js`.

## Related but out of scope

- **Outlier Detection (MAD + IQR)** (layer 13) and **Distributional Fingerprint Drift**
  (layer 17) in [`validation-layers.md`](validation-layers.md) are single-column checks; the
  modules here are the multivariate/holistic complement. Cross-session drift stays with layer
  17; supervised learning from user feedback stays with the self-learning ranker (consumed here
  only through `suppressAnomaliesWithVerdicts`).
