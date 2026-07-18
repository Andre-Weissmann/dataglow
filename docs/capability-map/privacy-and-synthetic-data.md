# Capability detail — Privacy & synthetic data

Companion to the **Privacy & synthetic data** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the privacy / synthetic-data suite; the index alone is enough for most tasks.

## How the suite is shaped

Four `js/privacy/` modules, layered from primitive to composition. All are pure JS
(no DOM, no engine, no network) with an injectable `rng` so output is reproducible
under test. The bottom layer is a single differential-privacy primitive; the two
generators build on it; the passport composes the generators' output with the Trust
Passport provenance batches. Every generator carries a mandatory verbatim disclaimer
that the UI is required to surface — the honest-naming constraint (a DP budget is
never upgraded into "anonymized" / HIPAA Safe Harbor) runs through all four files.

## The modules

### `js/privacy/privacy-budget.js` — Laplace DP primitive

The foundation everything else imports. Implements the Laplace mechanism (Dwork,
McSherry, Nissim, Smith 2006); noise scale = sensitivity / epsilon, lower ε =
stronger privacy.

- `laplaceNoise(scale, rng = Math.random)` — inverse-CDF sample from Laplace(0, scale): `u = rng() - 0.5`, returns `-scale * sign(u) * ln(1 - 2|u|)`.
- `addPrivacyBudgetNoise(trueValue, sensitivity, epsilon, rng)` — adds `laplaceNoise(sensitivity/epsilon)`; throws if `epsilon <= 0`.
- `anonymizeAggregateExport(aggregateStats, epsilon = 1.0)` — noises every finite numeric value in a `{label: value}` map at sensitivity 1 (suitable for counts), passing non-numeric values through untouched. Returns `{ values, epsilon, mechanism: 'Laplace', disclaimer }`.

### `js/privacy/synthetic-twin.js` — DP synthetic dataset ("Synthetic Adversarial Twin")

Generates a synthetic dataset that preserves each column's statistical *shape* while
containing NO real row-level values, via the standard "DP histogram → resample"
recipe (Dwork & Roth 2014, §3.3 / §3.5). Imports `laplaceNoise` from privacy-budget.

- Constants: `DEFAULT_EPSILON = 5`, `DEFAULT_BINS = 20`, `SYNTHETIC_TWIN_DISCLAIMER` (the mandatory not-audited / not-HIPAA-Safe-Harbor caveat), and `epsilonExplanation(epsilon)` for in-UI helper text.
- Column typing: `looksNumeric(col, values)` treats a column as numeric if its declared `type` is in `NUMERIC_TYPES` (`DOUBLE, BIGINT, INTEGER, HUGEINT, FLOAT, DECIMAL, REAL`) or, when type is unknown, every non-null value parses finite.
- Numeric path: `buildNumericHistogram(values, bins)` → `noiseHistogramCounts(counts, epsilon, rng)` (Laplace scale `1/epsilon` per bin — bin-count sensitivity is 1 — clamped to ≥0) → `resampleNumeric(hist, noisedCounts, n, rng)` (weighted bin pick then uniform within the bin, rounded to 4dp).
- Categorical path: `categoryCounts` → `noiseCategoryCounts(counts, epsilon, rng)` (same `1/epsilon` scale, `(null)` bucket for nulls) → `resampleCategorical(noisedCounts, n, rng)`.
- Comparison helpers `numericStats` / `categoricalStats` (top-5 shares) feed a real-vs-synthetic `comparison` array.
- Top-level `generateSyntheticTwin({ columns, rows, epsilon, bins, rng, count })` throws on empty columns/rows or `epsilon <= 0`, defaults `n` to `rows.length`, and returns `{ kind: 'dataglow-synthetic-twin', rows, columns, epsilon, mechanism: 'Laplace (DP histogram → resample; Dwork & Roth 2014)', comparison, disclaimer }`. `toCSV(columns, rows)` serializes rows (RFC-4180-ish quoting).

### `js/privacy/synthetic-adversarial.js` — schema-matched adversarial fixtures ("Red Team Mode v2")

Given a schema, synthesizes a fresh test file seeded with the same issue categories
the 20 validation layers catch (the golden dataset generalized to arbitrary schemas).
Deterministic via a `mulberry32` seeded PRNG, so a schema always yields the same file.
It reuses `buildGoldenDataset()`'s taxonomy from `loaders.js` rather than inventing one.

- `generateAdversarialDataset(cols, options = { seed, rows })` — throws on empty schema; builds ≥30 (default 60) clean base rows, then plants seven issue categories, returning `{ rows, columns, seeded }`.
- Column classification uses keyword regexes (`DATE_KW`, `AGE_KW`, `ADULT_ONLY_KW`, `AMOUNT_KW`, `COUNTRY_KW`, plus `START_KW`/`END_KW` token lists) and `NUMERIC_TYPES`.
- `seeded` is a machine-readable manifest keyed by issue category — `categorical_variants` (near-dup spellings), `cross_column_dates`/`cross_column_age`/`cross_column_numeric` (logical violations), `duplicates` (two appended exact dupes), `nulls`, `semantic_outlier` (e.g. age=999 or 1e9), `future_date`, `negative_magnitude` — so a caller can assert each layer caught its planted issue. NOTE: this produces adversarial TEST FIXTURES, not robustness scores of a synthetic output.

### `js/privacy/synthetic-data-passport.js` — Governed Synthetic Data Passport (Trust Passport Batch 4)

Composes the three prior Trust Passport batches so a synthetic export never leaves
"naked". Adds nothing to their crypto. Imports `buildDataNutritionLabel` (batch 2) and
`sealCheckResult` / `attachSealToLabel` (batch 3).

- Constants: `SYNTHETIC_PASSPORT_KIND = 'dataglow-synthetic-data-passport'`, `SYNTHETIC_PASSPORT_SCHEMA_VERSION = 1`, `SYNTHETIC_PASSPORT_DISCLAIMER`; internal `DP_TWIN_KIND = 'dataglow-synthetic-twin'`.
- `describeSyntheticGeneration(gen)` — the honest-naming core. Sets `formalDifferentialPrivacy = true` ONLY when a positive ε is present AND (kind is the DP twin, OR the mechanism string matches `/laplace|differential[- ]privacy|\bdp\b/i`, OR the caller explicitly asserts it with a budget); an explicit `formalDifferentialPrivacy: false` always wins. Returns method, mechanism, epsilon, `privacyModel` (`differential-privacy` | `none-declared`), a `privacyGuaranteeStatement`, the generator's verbatim `generatorDisclaimer`, and recorded `parameters`.
- `buildSyntheticDataPassport(ctx)` — requires `ctx.generation`; builds a Data Nutrition Label with `isSynthetic: true`, attaches a `synthetic` block (the descriptor + `summarizeUtility(comparison)` distribution-shape note + optional caller-supplied `adversarial` summary, never auto-derived). Returns `{ kind, schemaVersion, generatedAt, label, synthetic, disclaimer }`.
- `sealSyntheticPassport(passport, context)` (async, OPT-IN) — seals the generation parameters bound to a SHA-256 fingerprint of the synthetic OUTPUT via batch 3, anchors to `label.custodyChain.finalHash`, and attaches additively; requires `context.data` or `context.dataFingerprint`. Returns a NEW passport (input not mutated).
- Renderers `renderPassportSummaryLines` / `renderPassportSummary` (lead with the honest privacy line) and `exportPassportAsJSON` (pretty-printed, round-trips losslessly).

## Flag state

Grepping `flags.manifest.json`, only ONE of these modules has a dedicated flag:

- **`syntheticDataPassport` — `enabled: true` (LIVE).** Gates the opt-in governance passport UI on the Synthetic Twin card ("Include Governance Passport" checkbox + "Download Passport (.json)" / "Seal + download"). With it on the passport controls render; off, the synthetic-export flow is byte-for-byte unchanged.
- **`privacy-budget.js`, `synthetic-twin.js`, `synthetic-adversarial.js` have NO dedicated flag** — the Synthetic Twin card, the DP anonymized-export path, and Red Team Mode v2 ship LIVE (unconditional), not dark. Only the *passport augmentation* of the twin card is flag-gated. There is no `syntheticTwin`, `privacyBudget`, or `syntheticAdversarial` key in the manifest.

## UI wiring (`js/app-shell/main.js`)

- Imports: `import * as privacyBudget from '../privacy/privacy-budget.js';` (line 51); `{ buildSyntheticDataPassport, sealSyntheticPassport, renderPassportSummaryLines, exportPassportAsJSON }` from the passport (line 66). `syntheticAdversarial` and `syntheticTwin` are late-bound from the module registry (`registry.get('synthetic-adversarial')` / `registry.get('synthetic-twin')`, ~lines 9406 / 9410).
- **Synthetic Twin card** — `initSyntheticTwin()` (~line 5454, called from ~line 9317): ε slider drives `epsilonExplanation`, generate calls `generateSyntheticTwin`, download uses `toCSV`. The passport controls (`buildTwinPassport` ~5436, download/seal buttons ~5480–5514) are shown only when `isEnabled('syntheticDataPassport')`.
- **Anonymized export** — `privacyBudget.addPrivacyBudgetNoise(v, 1, epsilon)` is applied per numeric cell during CSV export (~line 6868), gated by an `addNoise` toggle (not a feature flag).
- **Red Team Mode v2** — the `#btn-redteam-v2` handler (~line 7638) calls `syntheticAdversarial.generateAdversarialDataset(ds.cols)`, loads the synthetic table, runs all layers, and reports which seeded categories were caught.

## Tests (present; not run here)

- `test/synthetic-data-passport.test.mjs` — passport module (also imports `generateSyntheticTwin` and `anonymizeAggregateExport` as fixtures, plus `verifySeal` for the seal path).
- `test/synthetic-twin-time-machine-suite.test.mjs` — imports `laplaceNoise` / `addPrivacyBudgetNoise` and the twin.
- `test/trust-adversarial-suite.test.mjs` — adversarial-suite coverage.

## Related but out of scope

- `js/provenance/data-nutrition-label.js` (batch 2), `js/provenance/verifiable-check-seal.js` (batch 3), `js/provenance/trust-beam.js`, `js/provenance/proof-room.js` — the passport composes these; see the Trust Passport / provenance area.
- `js/app-shell/loaders.js` `buildGoldenDataset()` — the fixed golden dataset whose issue taxonomy `synthetic-adversarial.js` generalizes; and the validation suite ([`validation-layers.md`](validation-layers.md)) whose 20 layers those fixtures target.
- `js/provenance/irb-mode.js` — IRB document builder exercised alongside the twin in the time-machine test suite.
