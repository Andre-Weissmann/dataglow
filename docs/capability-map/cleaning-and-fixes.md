# Capability detail — Cleaning & fixes

Companion to the **Cleaning & fixes** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the Clean tab, its fix-suggestion engine, or the fuzzy-duplicate radar; the
index alone is enough for most tasks.

## Shape of the area

Seven modules under `js/cleaning/` (plus one shared guard in `js/shared/`) that
scan a loaded table for data-quality issues and **propose** fixes. The whole area
follows one hard rule: **it never mutates data without explicit human approval.**
`clean.js` runs the SQL mutation only when the user clicks a specific fix;
`imputation.js` and `format-fingerprint.js` generate preview SQL and never apply
it themselves. Scans read via the shared DuckDB-WASM engine; the scoring,
materiality, fuzzy-match, and identifier-guard logic is pure and Node-testable.

## Flag / gating state — no dedicated flag; core/always-live

- No `flags.manifest.json` flag gates the Clean tab or any of these modules.
  Grepping for `clean`/`imputation`/`formatFingerprint`/`fuzzyDedup`/
  `materiality`/`fixConfidence` matches only *other* flags' descriptions (Query
  Memory, Crucible, Command Deck) that mention cleaning in passing. The Clean tab
  is a core, always-live surface wired directly in `main.js` with no `isEnabled()`
  guard around it.

## `js/cleaning/clean.js` — the scan + apply engine

Async, engine-backed (`engine.runQuery`). The one place in the area that actually
mutates data, and only on an explicit per-issue user click.
- `scanForIssues(table, cols)` → an array of issue objects. Detects: **nulls**
  per column (fixes offered depend on type — numeric → `drop_rows`/`fill_zero`/
  `fill_mean`/`fill_mode`; text → `drop_rows`/`fill_mode`); **exact duplicate
  rows** (`dedupe`); **whitespace** in VARCHAR columns (`trim`); **negatives** in
  amount/count/qty/price/cost/rate/los/stay-named numeric columns
  (`drop_rows`/`abs_value`/`null_out`).
- **Fuzzy duplicates** appear as a single *summary* issue with an empty `fixes`
  array (a P1 wiring-gap fix, 2026-07-15) that points the user to the Fuzzy
  Duplicate Radar rather than offering an inline mutation.
- `applyFix(table, issue, fixType, auditLog)` — builds and runs the mutation SQL
  for the chosen fix and appends to the audit log.
- `FIX_LABELS` — exported human-readable labels per fix type. Imports the engine
  and `findFuzzyDuplicates`.

## `js/cleaning/fix-confidence.js` — how sure is this fix?

Pure. `scoreFixConfidence(issue, fixType, columnStats = {})` → `{ score, label }`.
Heuristic scores per fix type: `trim` 96, `dedupe` 90, `abs_value` 55,
`null_out` 65, `fill_zero` 70 for count/qty else 45, `fill_mean` by coefficient of
variation (`cv < 0.25` → 80, `< 0.75` → 60, else 45), `fill_mode` by mode share
(`≥ 0.8` → 88, `≥ 0.5` → 65, else 42), `drop_rows` 70 when dropped pct `< 1` else
50. `label()` buckets: `≥ 75` High, `≥ 50` Medium, else Low.

## `js/cleaning/materiality.js` — filter out immaterial issues

Pure, PCAOB **AS 2305** framing. `DEFAULT_MATERIALITY_THRESHOLD = 1.0` (percent).
`filterByMateriality(issues, thresholdPct, rowCount)` drops issues whose affected
fraction is below the threshold; derives the pct from `count/rowCount` when an
issue lacks an explicit pct. **Fail-open**: keeps an issue if its pct can't be
determined, so a filter can never silently hide something it couldn't measure.

## `js/cleaning/imputation.js` — grouped-mean imputation (preview only)

- `buildGroupedImputationSQL(table, targetCol, groupByCols)` — builds a
  `WITH group_means / global_mean` CTE query; `COALESCE`s a row's group mean, then
  the global mean as fallback; joins with `IS NOT DISTINCT FROM` so NULL group
  keys match.
- `previewGroupedImputation(...)` → `{ sql, targetCol, groupByCols, totalRows,
  nullCount, wouldFill, remainingNulls, sample }`. **Preview-only** — returns the
  SQL and projected effect; never applies it.

## `js/cleaning/format-fingerprint.js` — format-consistency scan (preview only)

VARCHAR columns only; samples `SAMPLE_SIZE = 100` values per column.
`scanFormatIssues(table, cols)` detects:
- **currency_contaminated** — `CURRENCY_RE`, when `> 70%` of sampled values carry
  a `$`/`,`/symbol.
- **mixed_date_format** — `≥ 2` of `DATE_PATTERNS` (`MM/DD/YYYY`, `YYYY-MM-DD`,
  `DD-MM-YYYY`, `DD.MM.YYYY`) present in one column.
- **fake_null** — `FAKE_NULLS` sentinel strings (`null`/`n/a`/`na`/`none`/`-`/
  `unknown`/`''`).

Each issue carries a `suggestedFixSQL` string; the module **never auto-applies**,
mirroring `clean.js`'s human-approval discipline.

## `js/cleaning/fuzzy-dedup.js` — Fuzzy Duplicate Radar

String-similarity duplicate finder. `levenshtein`, `levenshteinSimilarity`,
`jaroWinkler`, and `similarity` (the max of the two similarity metrics).
- `findFuzzyDuplicates(table, cols, options)` — threshold default `0.85`,
  `MAX_ROWS = 2000`, O(n²) pairwise comparison; returns `{ column, threshold,
  comparedRows, pairs, warning }`.
- **P0 identifier guard:** `isGuardedIdentifierColumn` → `isLikelyIdentifierColumn`
  runs **before** any comparison — even for an explicitly-passed column — unless
  `options.skipIdentifierGuard` is set, so unique-ID columns are never fuzzy-
  merged. `pickBestTextColumn` excludes identifier columns when auto-choosing.
- The guard is deliberately **name-only**, not cardinality-based: a cardinality
  guard would break the radar's legitimate use on near-unique free-text *name*
  columns.

## `js/shared/identifier-columns.js` — the shared identifier guard

Zero-import shared module so it can sit below both `fuzzy-dedup.js` and
`categorical-consistency.js` without a circular import (the latter imports
`similarity` from `fuzzy-dedup.js`).
- `IDENTIFIER_COLUMN_NAME = /^(id|key|code)$|(_id|_key|_code|_no|_num|_number)$/i`
  (mirrors `validation.js`'s `BUSINESS_KEY_RE`); `isLikelyIdentifierColumn(name)`.
- `IDENTIFIER_UNIQUE_RATIO = 0.9`; `isNearUniqueColumn(distinctCount,
  nonNullCount, ratio)` for callers that *do* want a cardinality check.

## UI wiring (main.js)

Imports: `clean` (34), `formatFingerprint` (35), `imputation` (37), `fuzzyDedup`
(38), `fixConfidence` (40), `materiality` (48). Clean tab: `clean.scanForIssues`
~2847, `fixConfidence.scoreFixConfidence` ~2865, `imputation.previewGroupedImputation`
~2993; Fuzzy Duplicate Radar `#fuzzy-dedup-wrap`/`#fuzzy-dedup-list` ~3027-3028
with `fuzzyDedup.findFuzzyDuplicates` ~3029; `formatFingerprint.scanFormatIssues`
~3115. The Data Health Dashboard's materiality slider (~5791-5855) re-scans via
`clean.scanForIssues` (~5848) and filters with `materiality.filterByMateriality`
(~5853, PCAOB AS 2305 note inline).

## Tests

- `test/clean-scan-fuzzy-wiring.test.mjs` — the summary-issue wiring between
  `scanForIssues` and the radar.
- `test/fuzzy-dedup-identifier-guard.test.mjs` and
  `test/categorical-consistency-identifier-guard.test.mjs` — the P0 identifier
  guard from both entry points.
- `test/fuzzy-dedup-patients.test.mjs` — fuzzy matching on a realistic name set.
- `test/cleaning-crew-profiler.test.mjs` — cleaning-scan profiling.

## Related but not in scope

- `js/validation/categorical-consistency.js` reuses `similarity` from
  `fuzzy-dedup.js` and `isSensitiveCategory` elsewhere — see
  [`validation-layers.md`](validation-layers.md).
- The engine (`engine.runQuery`) is the shared DuckDB-WASM layer the scans issue
  SQL against.
