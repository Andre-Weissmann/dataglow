# Capability detail — Analysis robustness

Companion to the **Analysis robustness** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on Devil's Advocate mode, the plain-language robustness verdict, or the
statistical-rigor confidence layer; the index alone is enough for most tasks.

## Shape of the area

Three pure, engine/DOM/network-free modules that stress-test a *result* rather
than the pipeline. All consume the `{ columns, rows }` object the SQL tab already
produces (or pre-aggregated rows) and return plain data, so they're fully
Node-testable:
1. **Devil's Advocate** (`js/analysis-robustness/devils-advocate.js`) — attacks a
   result's headline mean with three published robustness checks.
2. **Robustness verdict + sensitivity map** (`robustness-verdict.js`) — extends
   Devil's Advocate with a between-group sensitivity map and a fixed-vocabulary
   plain-English verdict.
3. **Statistical Rigor** (`js/rigor/statistical-rigor.js`) — confidence intervals,
   effect size, Simpson's-paradox and multiple-comparison checks, and honest
   per-group confidence verdicts.

## Flag / gating state

- **Devil's Advocate** has **no feature flag** — it's registry-loaded
  (`registry.get('devils-advocate')`, main.js ~9404) and gated only by the
  presence of its `#btn-attack-analysis` button (`initDevilsAdvocate` returns
  early if absent, main.js 5129).
- **`robustnessVerdict`** flag — **`enabled: true`** (as currently found; the
  description still reads "ships dark", but the manifest value is on). Added in
  `feature/analysis-robustness-sensitivity-verdict`. When on, the existing Devil's
  Advocate card appends the plain verdict line + driving-segment summary; when off,
  `initDevilsAdvocate` renders exactly as before and the new functions never run.
- **`rigorEngineBadges`** flag — **`enabled: true`** (promoted in
  `enable/rigor-engine-badges`, restored in `fix/restore-rigor-engine-badges-enabled`).
  Gates the SQL/Visualize per-group confidence badges + "Send to Visualize"
  affordance built on `statistical-rigor.js`. The rigor *functions* themselves are
  pure and called unconditionally by the badge renderers.
- Batch 4's Trust Certificate (`rigor-engine-batch4-trust-certificate`,
  `enabled: true`) composes rigor output but lives in `js/trust/` — out of scope
  here.

## `js/analysis-robustness/devils-advocate.js` — "Attack My Analysis"

`attackAnalysis(queryResult, options)` runs three checks on the result's numeric
metric column (auto-picked via `pickMetricColumn`: first column ≥60% numeric, or
`options.metricColumn`), headline statistic = the **mean**:
- **(a) Bootstrap resampling** (Efron 1979) — `BOOTSTRAP_ITERS = 500` resamples
  with replacement via a seeded `mulberry32` PRNG (reproducible; `options.seed`
  default `0xC0FFEE`); 95% CI from the 2.5/97.5 percentiles; robust when the CI
  relative width `≤ 0.30`.
- **(b) Trimmed re-estimate** (Tukey 1962) — drops top/bottom `TRIM_FRACTION =
  0.05`; robust when the mean moves `≤ NUMERIC_RELERR (0.10)`.
- **(c) Subgroup leave-one-out** — removes the largest subgroup (grouping column
  auto-picked by `pickGroupColumn`: 2+ distinct, low cardinality); robust when the
  mean moves `≤ NUMERIC_RELERR`.

Returns `{ verdict, robust, headline, checks[] }`; `robust` is true only if every
check is. Unless `options.log === false`, it records the attack via `logAssumption`
(imported from `../provenance/assumption-ledger.js`) — its one non-pure touch.
Empty rows / no numeric column → an `inconclusive` verdict, never a throw.

## `js/analysis-robustness/robustness-verdict.js` — sensitivity + verdict

Two pure functions that **extend** (never replace) `attackAnalysis`:
- `mapAssumptionSensitivity(queryResult, options)` — for an A-vs-B between-group
  finding, greedily removes the single row that pulls `|effect|` closest to zero
  until the gap **breaks** (shrinks past `DISAPPEAR_FRAC = 0.25` or sign-reverses),
  then reports the smallest breaking set. Thresholds: `FRAGILE_FRACTION = 0.10`,
  `MODERATE_FRACTION = 0.30`, `ZERO_EFFECT_REL = 0.02` (below → `no-effect`),
  `SEGMENT_COVERAGE = 0.6` (breaking rows "concentrate in a segment" when ≥60%
  share one value of another column). A = higher-mean group so a sign flip is
  unambiguously a reversal. Returns a plain-language-ready object
  (`severity: robust|fragile|moderate|no-effect|inconclusive`, `breakMode:
  stable|disappears|reverses`, `segment`, `minRowsToBreak`, `fractionToBreak`, …).
- `robustnessVerdict(attackReport, sensitivityReport)` → one fixed-vocabulary
  `{ verdict: 'robust'|'fragile'|'inconclusive', reason, drivingFactor }` with a
  number-grounded one-sentence reason. Fragile if *either* the mean failed a
  stress test *or* a small row set breaks the gap; prefers the sensitivity story
  (names the driving segment) when available; falls back to the attack report
  alone when no grouping column exists.

## `js/rigor/statistical-rigor.js` — the Rigor Engine

Textbook stats (Wasserman; Cohen 1988), pure and dependency-free:
- `mean`, `sampleStdDev` (n−1), `confidenceIntervalForMean(values, level)` via the
  normal approximation with a `Z_SCORES` lookup (`0.80/0.90/0.95/0.99`).
- `classifySampleSize(n)` → `sufficient` (≥30) / `low` (≥10) / `insufficient`;
  `classifyConfidence(values, level)` folds size + CI into one verdict
  (conservative: `insufficient` wins).
- `cohensD(groupA, groupB)` → pooled-SD effect size + magnitude bucket
  (negligible/small/medium/large).
- `bonferroniAdjustedAlpha(numComparisons, familyWiseAlpha)` — conservative
  multiple-comparison correction.
- `detectSimpsonsParadox(segmentedRows, groupA, groupB)` — takes pre-aggregated
  `{ segment, group, value, n }` rows and flags an n-weighted overall direction
  that reverses within segments.
- `classifyGroupedConfidence(rows, groupCol, valueCol, level, countCol)` — per-group
  verdicts; **critical distinction** (bug fixed 2026-07-18): pass `countCol` for
  pre-aggregated GROUP BY results (each row = many observations) or it falls back
  to row-counting (correct only for row-level data). Nulls bucket under `(null)`.
- `summarizeGroupedConfidence(groupVerdicts)` — worst-group-wins single verdict.

## UI wiring (main.js)

`initDevilsAdvocate` (5129) wires `#btn-attack-analysis` → `attackAnalysis` (5139)
and, behind `isEnabled('robustnessVerdict')` (5159), appends
`mapAssumptionSensitivity` + `robustnessVerdict` output (`data-testid=
"robustness-verdict"`, 5166); the module is `registry.get('robustness-verdict')`
(9405). Rigor: imports `classifyGroupedConfidence`, `summarizeGroupedConfidence`,
`cohensD` (26); SQL-tab badge `classifyGroupedConfidence(..., cols.countCol)`
(1811); Visualize-tab badge (7806). All badge surfaces gated by `rigorEngineBadges`.

## Tests

- `test/statistical-rigor.test.mjs` — the rigor math + the two Batch-2 grouped
  functions (incl. a source-scan proving no DOM/network/DuckDB primitive).
- `test/robustness-verdict.test.mjs` — sensitivity map + verdict folding.
- `test/e2e-rigor-engine-badges.test.mjs` — the badge render path end-to-end.
- `test/agent-gate-stat-confidence.test.mjs` — rigor feeding the agent gate.

## Related but not in scope

- `js/provenance/assumption-ledger.js` supplies `logAssumption` (Devil's
  Advocate's only side-effect). The Trust Certificate (`js/trust/`) and the
  AI Readiness Gate consume rigor output downstream.
