# Capability detail — Validation layers

Companion to the **Validation layers** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the validation suite; the index alone is enough for most tasks.

## How the suite is shaped

`js/validation/validation.js` is the orchestrator. It holds a single `LAYER_DEFS` array with
**21 entries: the 20 data-quality layers plus the Red Team self-test** (the Red
Team run executes the 20 layers against an intentionally broken golden dataset,
so the user-facing headline is "20 layers" while the array length is 21). Any
test or UI assertion that checks these counts should treat 21 (array length) and
20 (headline) as both correct — they measure different things.

Most layers are implemented inline in `js/validation/validation.js`. A handful are large or
reusable enough to live in their own module and are imported by the orchestrator;
those are the ones the index calls out as "standalone layer modules."

## The layers, in array order

1. **Sanity Anchor** — runs the same GROUP BY two independent ways and compares.
2. **Historical Drift Detector** — flags when results change between runs on the same query.
3. **Unit Test Layer** — five silent tests: negatives, future dates, blank keys, duplicates, referential integrity.
4. **Confidence Layer** — 0–100 score across five signals with a color-coded grade.
5. **Denial Radar** — healthcare claim-denial pattern detection (needs EDI 835/837 columns).
6. **Schema Fingerprint** — hash of the schema; flags renamed/removed/retyped columns.
7. **Semantic Drift Detector** — checks whether column names still match their values.
8. **Correlation Watchdog** — tracks key-metric correlations over time, flags decorrelation.
9. **Narrative Consistency Checker** — cross-checks numbers in a written story against query results.
10. **Freshness Meter** — timestamps every load; visible staleness badge.
11. **Blind Spot Scanner** — prompts about missing data that would change the conclusion.
12. **Reproducibility Badge** — runs the same query ten times, confirms identical results.
13. **Outlier Detection (MAD + IQR)** — flags high and low outliers via modified z-score and IQR fences.
14. **Benford's Law Check** — leading-digit distribution vs the Newcomb-Benford expectation, gated to columns where the law applies.
15. **Categorical Consistency Engine** — standalone module `js/validation/categorical-consistency.js`; clusters near-identical spellings and proposes a canonical merge.
16. **Cross-Column Logical Consistency** — standalone module `js/validation/cross-column-consistency.js`; detects impossible combinations across columns in one row.
17. **Distributional Fingerprint Drift** — stores each column's distribution shape and flags drift on a later load of the same schema. Extended by `js/drift/drift-forecast.js` and `js/validation/expected-range.js`.
18. **Physiological Plausibility** — standalone module `js/validation/physiological-plausibility.js`; flags vital-sign values outside general human limits. A data-plausibility check, not medical advice.
19. **Upper-Bound Sanity Anchor** — standalone module `js/validation/upper-bound-sanity.js`; flags values outside a column's definitional bounds (percentages above 100, proportions outside 0–1).
20. **Missingness Detective** — standalone module `js/validation/missingness-detective.js`; classifies missingness with Rubin's MCAR/MAR/MNAR taxonomy.
21. **Red Team Mode** — runs all 20 layers against an intentionally broken golden dataset (the self-test, not a data layer).

## Related but not layers

- `js/validation/domain-physics.js` — swappable domain packs (Healthcare, Retail/E-commerce,
  Finance/Accounting, plus "None") that reinterpret/annotate raw layer output
  after the fact; turning a pack off restores the raw result. It never re-runs or
  changes what the layers check.
- `js/validation/missingness.js` — the older, lighter MCAR/MAR heuristic; distinct from the
  fuller Missingness Detective layer above.
- `js/validation/expected-range.js` — informational numeric trend bands that sit alongside
  the drift layer but change no status and raise no alert.
- `js/validation/source-convergence.js` — **Source Convergence (Truth Network, Batch 1)**: the
  first layer that reasons ACROSS N loaded sources at once instead of one table. Given each
  source's rows and its possible join keys, `buildConvergenceGraph` works out which sources
  join (including TRANSITIVE joins — A↔B, B↔C ⇒ A and C converge through B),
  `computeConvergenceClusters` groups rows into same-entity clusters with per-column
  agree/conflict analysis, `resolveClusterWithTrust` resolves a conflict to the highest-trust
  source only when the trust margin is decisive (default 0.15) and honestly escalates the rest,
  and `summarizeConvergence` renders the plain-language headline. Pure, DOM/DuckDB/network-free,
  never throws. Ships dark behind the `sourceConvergence` flag (Batch 1 = logic only; ingestion
  wiring and UI are Batches 2 and 3). It is not one of the 20 single-table data-quality layers.
- `js/validation/source-convergence-ingestion.js` — **Source Convergence ingestion adapters
  (Truth Network, Batch 2)**: the seam that turns the mixed-format data an analyst actually loads
  into the `{ id, rows, possibleKeys, trust, meta }` source objects the Batch 1 engine expects,
  without touching that engine's public contract. `adaptExcelWorkbook` fans a parsed workbook out
  to ONE source per sheet/tab (same file, different tabs = different sources); `adaptApiSource` and
  `adaptSiteExport` defensively unwrap a parsed JSON pull (bare array or an object wrapping rows
  under `data`/`rows`/`results`/`items`/`records`) and carry `url`/`fetchedAt` provenance;
  `inferJoinKeys` is the shared heuristic key-inference helper (single-column `*_id`/`_key`/`_code`/
  bare-`id` plus known composites like `patient_id`+`date_of_service`, returning `[]` and flagging
  `needsManualKeySelection` when nothing matches); `assignDefaultTrust` gives a per-origin default
  (upload/Excel > API > site) that an explicit caller trust overrides; and `toEngineSources`
  flattens adapter results into the engine's source list + `sourceTrust` map. Pure and
  Node-testable — it consumes ALREADY-PARSED data, so the real File reading (the app's existing
  SheetJS `XLSX.read` in `js/app-shell/loaders.js`) and the user-initiated client-side `fetch()`
  live in the UI batch. Never throws; ships dark behind the `sourceConvergenceIngestion` flag
  (Batch 2 = adapters only; UI wiring is Batch 3).
- `js/validation/source-convergence-ui.js` — **Source Convergence UI (Truth Network, Batch 3,
  final)**: the first VISIBLE surface — a flag-gated "Convergence" tab that wires the Batch 1
  engine and Batch 2 adapters into a real UI, inventing no convergence logic of its own. The pure,
  Node-testable model builders — `buildConvergenceView` runs the whole pipeline (`toEngineSources`
  → `buildConvergenceGraph` → `computeConvergenceClusters` → `resolveClusterWithTrust` per cluster
  → `summarizeConvergence`) and returns a DOM-free model (source rail, coverage matrix, verdict,
  escalate list); `buildSourceCardModel`, `sourceKindBadge`, `formatTrust`, `buildEscalationModel`,
  and the pure `toggleExpanded` click-through state transition — are split from the browser-only
  renderer `mountConvergence`, exactly like `js/rooms/room-ui.js`. The renderer owns the two
  browser affordances Batch 2 deferred: reading a file via the app's global `XLSX`, and a
  user-initiated client-side `fetch()`. Wired into `js/app-shell/main.js` (`renderConvergenceTab`
  from `switchTab`, filtered out of `renderTabBar` when the flag is off). Renders an honest empty
  state until real sources load; never fabricates demo numbers. Zero-upload/local-first and never
  throws; ships dark behind the `sourceConvergenceUI` flag (Batch 3 = UI only; promoting the trio
  to ON is separate future work).
