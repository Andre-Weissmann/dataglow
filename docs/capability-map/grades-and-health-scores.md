# Capability detail — Grades & health scores

Companion to the **Grades & health scores** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the two-axis calibrated grades, the CAT Scorecard, or the Golden Signals health
numbers; the index alone is enough for most tasks.

## Shape of the area

Three modules under `js/grades/` that turn already-computed validation output (and
a few cheap engine queries) into at-a-glance quality scores. All are **heuristics**,
explicitly not legal/clinical determinations, and all reuse existing signals rather
than introducing a new statistical layer:
1. **Confidence-Calibrated Grades** (`calibrated-grades.js`) — pure; two honest
   axes (Data Integrity, Domain Confidence) folded from layer *statuses*.
2. **CAT Scorecard** (`cat-scorecard.js`) — Completeness / Accuracy / Timeliness
   per the CDC Data Quality Framework.
3. **Golden Signals** (`golden-signals.js`) — four top-line data-quality rates,
   SRE "golden signals" mapped onto data quality.

All three share the A–F banding (≥0.9 A, ≥0.8 B, ≥0.7 C, ≥0.6 D, else F).

## Flag / gating state — no dedicated flags; core

- None of the three has its own `flags.manifest.json` flag.
- `computeCalibratedGrades` runs **inside the validation orchestrator**
  (`js/validation/validation.js` imports it at 17, sets `results.calibratedGrades`
  at 1656, dev-asserts `grade-result` conformance at 1681) — so grades are produced
  on every validation run, unconditionally.
- `computeCATScore` and `computeGoldenSignals` are computed **async inside
  `renderDataHealth`** (main.js 5804 / 5833), each `.catch(() => null)` so a failed
  engine query degrades to a hidden card rather than an error. Not flag-gated.
- The only *related* flag is **`glow`** (`enabled: true`) — the topbar Glow orb
  (`js/glow/`) *composes* `computeGoldenSignals` + `computeCATScore` output (plus
  the Readiness Gate and Trust Strip) into one verdict; because those two are async
  and not persisted to `state`, the orb leaves them undefined rather than re-running
  them (a documented Batch-2 follow-up). The Glow orb is a *different* area.

## `js/grades/calibrated-grades.js` — two-axis calibrated grades

Pure (no DOM/engine); only aggregates and weights existing layer statuses.
- **Two axes**, each a weighted pass-rate over the layers assigned to it, with
  weights re-normalised over only the layers that actually ran (idle/not-run
  excluded, never counted as failures):
  - **Data Integrity** (`INTEGRITY_WEIGHTS`) — mechanical/statistical
    well-formedness, domain-agnostic: `unit_tests` 0.30, `cross_column_logic` 0.25,
    `categorical_consistency` 0.15, `schema_fingerprint` 0.12, `sanity_anchor` 0.10,
    `reproducibility` 0.08.
  - **Domain Confidence** (`DOMAIN_WEIGHTS`, surfaced as `plausibility`) — real-world
    plausibility: `physiological_plausibility` 0.30, `distribution_drift` 0.25,
    `semantic_drift` 0.15, `outlier_detection` 0.12, `benford` 0.10,
    `correlation_watchdog` 0.08.
- `statusScore`: pass 1, warn 0.5, fail 0, idle → null (excluded). `weightedAxis`
  returns `{ score, contributions[], considered }` (score 1 when nothing ran).
- **Domain-pack reinterpretation credit:** a warn/fail domain layer whose flag the
  Domain Physics Engine annotated is lifted to `REINTERPRETED_CREDIT = 0.9` (an
  "understood" flag counts less against Domain Confidence). Driven by the
  `annotations[]` argument.
- `computeCalibratedGrades({ results, packName, packLabel, annotations })` →
  `{ packName, integrity, plausibility, overall }`, each with `score`, `grade`
  (`band`), and a plain-language `explanation`; `overall` is the mean of the two
  axes. Integrity can be high on real-world-nonsense data; plausibility can be low
  even when integrity is high.

## `js/grades/cat-scorecard.js` — Completeness / Accuracy / Timeliness

Engine-backed (imports `duckdb-engine`). CDC Data Quality Framework.
- **Completeness** — `1 − nullCells/totalCells` via a per-column
  `COUNT(*) … IS NULL` scan.
- **Accuracy** — pass rate across `unit_tests`, `semantic_drift`,
  `outlier_detection` from the validation results; neutral **0.8** fallback when
  none are present.
- **Timeliness** — `1.0` under 24h, decaying linearly to 0 by ~7 days
  (`ds.loadedAt`).
- `computeCATScore(ds, validationResults)` → `{ completeness, accuracy, timeliness,
  overall }`, each `graded()` (clamped [0,1] + A–F); `overall` is the mean.

## `js/grades/golden-signals.js` — four health numbers

Engine-backed. Adapts the Google SRE "golden signals" (latency/traffic/errors/
saturation) onto data quality.
- `computeGoldenSignals(ds, validationResults)` → `{ missingnessRate,
  outOfRangeRate, duplicateRate, freshnessHours }`:
  - **missingnessRate** — null cells / total cells.
  - **outOfRangeRate** — negatives in amount/count/qty/price/cost/rate/age/salary/
    revenue-named numeric columns, over row count.
  - **duplicateRate** — extra rows beyond distinct, via a `GROUP BY all-cols HAVING
    COUNT(*) > 1` sum.
  - **freshnessHours** — hours since `ds.loadedAt`.
  All rounded; rates are raw fractions (not letter-graded here — the Data Health
  Dashboard renders them directly).

## UI wiring (main.js)

Imports `catScorecard` (47), `goldenSignals` (49). Data Health Dashboard
(`renderDataHealth`): `computeCATScore` → `#cat-scorecard` (5804-5805),
`renderCalibratedGrades(results.calibratedGrades)` (5824, box `#calibrated-grades`
5924/5960), `computeGoldenSignals` → `#golden-signals` (5833-5834). Calibrated
grades also feed: the export report (`results.calibratedGrades` 4584), the Digital
Twin before/after axis rows (8884-8885), and the active-grade helper (9000-9001).

## Tests

There is no dedicated `calibrated-grades`/`cat-scorecard`/`golden-signals`
`.test.mjs`; coverage is via:
- `test/golden/cases.mjs` + fixture `test/golden/fixtures/calibrated-grades.json`
  — golden-master snapshot of the grade output.
- `test/domain-physics.test.mjs` — exercises reinterpretation-credit grading.
- `test/glow-signal.test.mjs` — composes `computeGoldenSignals`/`computeCATScore`.
- `test/e2e-smoke.test.mjs` — end-to-end render of the health dashboard.
- `test/_screenshot-grades.mjs` — a screenshot helper (not a unit test).

## Related but not in scope

- `js/validation/validation.js` produces the layer statuses all three consume — see
  [`validation-layers.md`](validation-layers.md).
- The Domain Physics Engine supplies the `annotations` that earn reinterpretation
  credit.
- The Glow orb (`js/glow/`) composes CAT + Golden Signals into a single topbar
  verdict (`glow` flag).
