# Capability detail — Validation layers

Companion to the **Validation layers** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the validation suite; the index alone is enough for most tasks.

## How the suite is shaped

`js/validation.js` is the orchestrator. It holds a single `LAYER_DEFS` array with
**21 entries: the 20 data-quality layers plus the Red Team self-test** (the Red
Team run executes the 20 layers against an intentionally broken golden dataset,
so the user-facing headline is "20 layers" while the array length is 21). Any
test or UI assertion that checks these counts should treat 21 (array length) and
20 (headline) as both correct — they measure different things.

Most layers are implemented inline in `js/validation.js`. A handful are large or
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
15. **Categorical Consistency Engine** — standalone module `js/categorical-consistency.js`; clusters near-identical spellings and proposes a canonical merge.
16. **Cross-Column Logical Consistency** — standalone module `js/cross-column-consistency.js`; detects impossible combinations across columns in one row.
17. **Distributional Fingerprint Drift** — stores each column's distribution shape and flags drift on a later load of the same schema. Extended by `js/drift-forecast.js` and `js/expected-range.js`.
18. **Physiological Plausibility** — standalone module `js/physiological-plausibility.js`; flags vital-sign values outside general human limits. A data-plausibility check, not medical advice.
19. **Upper-Bound Sanity Anchor** — standalone module `js/upper-bound-sanity.js`; flags values outside a column's definitional bounds (percentages above 100, proportions outside 0–1).
20. **Missingness Detective** — standalone module `js/missingness-detective.js`; classifies missingness with Rubin's MCAR/MAR/MNAR taxonomy.
21. **Red Team Mode** — runs all 20 layers against an intentionally broken golden dataset (the self-test, not a data layer).

## Related but not layers

- `js/domain-physics.js` — swappable domain packs that reinterpret/annotate raw
  layer output after the fact; turning a pack off restores the raw result. It
  never re-runs or changes what the layers check.
- `js/missingness.js` — the older, lighter MCAR/MAR heuristic; distinct from the
  fuller Missingness Detective layer above.
- `js/expected-range.js` — informational numeric trend bands that sit alongside
  the drift layer but change no status and raise no alert.
