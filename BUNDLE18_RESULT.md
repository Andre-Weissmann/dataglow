# Bundle 18 Result: Archetype Drills (SCD / Streaks / Baskets) + R Air-Gap Prebundle

Status: **shipped to an open PR, not merged, not published.**

- PR: https://github.com/Andre-Weissmann/dataglow/pull/608
- Branch: `feat/bundle18-archetype-drills-r-airgap`
- Base: `main`
- PR state at time of writing: `OPEN`, `mergeable: MERGEABLE`, CI checks running (`pending`)

## What shipped

### 1. Three new original Drill Floor drills (flag: `archetypeDrillsExpand`)

| Drill id | Pattern | SQL golden `rowCount` | Other SQL-only goldens |
|---|---|---|---|
| `scd-as-of` | point-in-time price join against a slowly-changing-dimension price-history table (validity ranges) | 314 | `totalRevenue=101018`, `productCount=6` |
| `streak-islands` | longest run of consecutive-day activity per user (gaps-and-islands) | 474 | `maxStreak=9`, `userId=1`, `islandCount=106` |
| `basket-pairs` | most frequent two-item co-purchase pair across orders | 1 | `pairLeft='SKU-C'`, `pairRight='SKU-F'`, `orderCount=63` |

Underlying synthetic data volumes (deterministic, seeded generators in `js/drill-floor/drill-floor-data.js`): `priceHistory`=25 rows across 6 products, `sales`=400 rows, `activity_days`=474 rows across 6 users, `basket_lines`=883 rows across 250 orders.

Each drill carries `starterSql` / `starterPython` / `starterR`, an honest `excelNote` ("Not full Excel..."), a `description`, an `expectedApproach`, and a `goldenAnswers` block for all three engines (`sql`, `python`, `r`), each with at least `rowCount`.

`DRILLS` (in `js/drill-floor/drill-floor.js`) now has 7 entries in order:
`spot-the-sale`, `top-order-per-channel`, `channels-over-threshold`, `running-total-by-day` (pre-existing), then `scd-as-of`, `streak-islands`, `basket-pairs` (new).

`loadDrillTables()` now additively loads 6 tables (was 2): `drill_orders`, `drill_promos`, `drill_price_history`, `drill_sales`, `drill_activity_days`, `drill_basket_lines`.

Two new pure scoring helpers were added to `js/drill-floor/drill-floor.js`:
- `scalarMatches(expected, observed)`: numeric compare with `NUMERIC_EPSILON = 1e-6`, exact-trimmed string compare, strict equality otherwise. Never throws.
- `scoreDrillExtras(drillId, observed)`: checks every extra SQL-only golden field (everything in `goldenAnswers.sql` besides `rowCount`) against a caller-supplied observed map. Returns `{ pass, drillId, fields }`. Never throws; returns `pass:true` with empty `fields` for a drill/engine with no extra goldens.

`scoreDrillAnswer()` itself is **unchanged** (still rowCount-only) and remains backward compatible with all prior bundles' callers.

### 2. R Air-Gap prebundle contract + honest UI (flag: `rAirGapPrebundle`)

New file `js/polyglot/r-air-gap-prebundle.js` (233 lines). Exports:
- `R_AIRGAP_PREBUNDLE_KIND = 'dataglow-r-airgap-prebundle'`, `R_AIRGAP_PREBUNDLE_VERSION = 1`
- `R_AIRGAP_PREBUNDLE`: a frozen array of 6 tracked R packages (`jsonlite`, `ggplot2`, `dplyr`, `tidyr`, `readr`, `broom`), each with `availability` of `'bundled'`, `'network-only'`, or `'unavailable'`, and an `assetPath` that is `null` unless a real local asset exists on disk. **As of this bundle, all 6 are `network-only` or `unavailable`; 0 are `bundled`.** This is a deliberately honest starting state, not a placeholder claiming false offline availability.
- `prebundleStatusCopy(entry)`: renders UI copy for a package's status. Never returns the label `"Available offline"` unless `availability === 'bundled'` and a real `assetPath` is present.
- `resolvePackageLoad(packageName, networkDecision)`: only reports a `'local'` source if the manifest actually marks the package `bundled`; otherwise defers to the caller-supplied Air-Gap/network decision (`'network'` or blocked, per that decision).
- `listPrebundleManifest()`, `summarizePrebundleAvailability()` (returns `{ total, bundledCount, networkOnlyCount, unavailableCount, bundledNames }`; currently `{6, 0, 4, 2, []}`), plus a `DataGlowRAirGapPrebundle` namespace and `window.DataGlowRAirGapPrebundle` global for the canvas.

Cross-platform-safe: the module has no DOM dependency, no Node-only API (`require('fs')`), no Tauri-only API (`@tauri-apps/*`), and no `process.env` read — checked directly in the test suite.

### 3. Shipping mechanics

- `inject_bundle18.py` (new, ~608 lines) follows the Bundle 16/17 short-form-marker convention: re-syncs `js/drill-floor/drill-floor-data.js` and `js/drill-floor/drill-floor.js` into `canvas/index.html`, and inserts a new engine block for `js/polyglot/r-air-gap-prebundle.js` directly before the existing `js/polyglot/r-power-pack.js` block. Verified **idempotent**: running it twice produces a byte-identical canvas (same sha256).
- `canvas/index.html` is the authoritative artifact and was updated only through the injector, never edited by hand. Final size: 6,082,846 bytes.
- `canvas/integrity.manifest.json` gained a new tracked entry for `js/polyglot/r-air-gap-prebundle.js` (66 tracked modules total, was 65).
- Self-host DuckDB was **not touched**: still lives at `assets/duckdb/` only; no `canvas/vendor/duckdb-wasm/` tree was created (checked in the test suite).

## Flags

Added to `flags.manifest.json`:
- `archetypeDrillsExpand`: `enabled: true`
- `rAirGapPrebundle`: `enabled: true`

Both carry `addedInPR`, `description`, and `flagOffBehavior` fields matching the existing Bundle 17 schema.

**All 173 flags in the manifest are enabled; 0 are OFF.** (Was 171/171/0 before this bundle.)

## Golden scalars table

| Drill | Engine | rowCount | Other scalars |
|---|---|---|---|
| scd-as-of | sql | 314 | totalRevenue=101018, productCount=6 |
| scd-as-of | python | 314 | (rowCount only) |
| scd-as-of | r | 314 | (rowCount only) |
| streak-islands | sql | 474 | maxStreak=9, userId=1, islandCount=106 |
| streak-islands | python | 474 | (rowCount only) |
| streak-islands | r | 474 | (rowCount only) |
| basket-pairs | sql | 1 | pairLeft='SKU-C', pairRight='SKU-F', orderCount=63 |
| basket-pairs | python | 1 | (rowCount only) |
| basket-pairs | r | 1 | (rowCount only) |

Every value above was independently re-derived in `test/bundle18-archetype-drills-r-airgap.test.mjs` from the same generator functions (never trusted from the module's own math) and matched exactly.

## Tests

### New: `test/bundle18-archetype-drills-r-airgap.test.mjs`

```
node --test test/bundle18-archetype-drills-r-airgap.test.mjs
# tests 31
# suites 5
# pass 31
# fail 0
```

Five suites:
- **A** (7 tests): `DRILLS` shape and order, starter/golden completeness per new drill, independent re-derivation of all three drills' golden scalars from the raw generators, generator determinism, `loadDrillTables()` table-count/shape check.
- **B** (5 tests): `scoreDrillAnswer` pass/fail across all three new drills and engines, never-throws on garbage/null/error input, `scoreDrillExtras` field-level pass/fail (including an order-sensitivity check that swapping `pairLeft`/`pairRight` correctly fails), `scalarMatches` epsilon/string/never-throws behavior.
- **C** (6 tests): R Air-Gap manifest honesty (no false "bundled" claim), `prebundleStatusCopy` never claims offline for a non-bundled entry, `summarizePrebundleAvailability` totals, `resolvePackageLoad` local-vs-network decision correctness, cross-platform source-level checks (no DOM/Node-only/Tauri-only API), a `jsonlite` smoke test.
- **D** (4 tests): new flags present and enabled, dependency flags (`drillFloor`, `receiptDrillBattery`, `duckdbSelfHost`) remain enabled, 0 OFF flags anywhere in the manifest, no em dash in `flags.manifest.json`.
- **E** (9 tests): no em dash in new source outside comments, no Maven mentions beyond the pre-existing honesty note (checked at ≤2 mentions), canvas marker pairing for the new/re-synced modules, canvas inlines the new drill ids and the R Air-Gap kind string, canvas legacy flags object carries both new flags, integrity manifest tracks the new engine, no `canvas/vendor/duckdb-wasm/` tree exists.

### Regressions found and fixed

Extending `loadDrillTables()` (2 to 6 tables) and `DRILLS` (4 to 7 entries) broke two **pre-existing** pinned-count assertions from earlier bundles that had never been updated for growth:

1. `test/drill-floor.test.mjs`: asserted `loadDrillTables` issues "exactly two runQuery calls" and returns "two dataset descriptors." Updated to expect 6 (with a comment explaining the additive Bundle 18 change); the original two calls'/descriptors' exact SQL and shape assertions are unchanged.
2. `test/bundle16-ledger-wiring-drill-battery.test.mjs`: asserted `DRILLS.length === 4` with a 4-id list. Updated to `7` with the full 7-id list (with a comment pointing at this bundle's own test file for the three new drills' coverage).

Both fixes were caught by running the project's real test suite (`node --test test/`), not assumed. Confirmed via a git-stash comparison that the fixed branch's failure list is a strict subset of `main`'s failure list, i.e. **zero new regressions**.

### Full suite

```
node --test test/
# tests 943
# suites 76
# pass 883
# fail 60
```

All 60 failures are pre-existing and unrelated to this bundle (confirmed identical on `main` before these changes, mostly headless-browser/screenshot/e2e tests that don't run in this sandbox). The only difference between the `main`-baseline failure list and this branch's failure list is that `main` additionally fails the (not-yet-existing) `bundle18-*` test suites, which is expected since those source files don't exist on `main`.

### Project checks

```
npm run check:canvas-integrity
#   ok  syntax: 3 inline <script> block(s) parsed
#   ok  markers: 334 inlined module path(s), 305 closing marker(s); tracked modules correctly paired
#   ok  tracked: 66 module(s) verified against canvas/integrity.manifest.json
#   ok  ship path: desktop stage script still stages index.html + js/
#   ok  ship path: build.sh still guards canvas/index.html against a stale src/ rebuild
#   ok  publish: canvas/index.html is the recorded 6082846 bytes
check-canvas-integrity: canvas bundle integrity OK

npm run check:capability-map
#   ok  registry: 265 capability(ies) normalized to { id, title, status, relatedFlags, platforms }
#   ok  status: 265 shipped, 0 behind-flag
#   ok  flags: 173 declared, 105 capability(ies) flag-linked
check-capability-map: capability registry is honest against flags.manifest.json
```

No capability-map entry was added for the two new flags: the check only fails on a `relatedFlags` reference to a flag that does not exist, and it already passes clean with the new flags declared. This was a deliberate no-op, not an oversight.

## Hard rules honored

- `canvas/index.html` is authoritative; the only edits to it went through `inject_bundle18.py`.
- No em dash (U+2014) in any new visible product text; the test suite checks the new source files for em dashes outside `/* */` comments (and outside `//` line comments).
- No Maven UI/data/branding beyond the pre-existing honesty-note mentions (checked at ≤2 occurrences, matching Bundle 16/17's existing disclaimer; no new drill or the R Air-Gap module mentions Maven at all).
- No Power Query M engine, no A48 redesign — untouched by this bundle.
- Self-host DuckDB stays at `assets/duckdb/` only; `canvas/vendor/duckdb-wasm/` was never created (checked).
- Flags `archetypeDrillsExpand` and `rAirGapPrebundle` are ON; all other flags remain ON (173/173 enabled, 0 OFF).
- PR opened against `main`, **not merged**; live site **not published**.

## Files changed

```
 BUNDLE18_SPEC.md                                     (new, spec copy)
 inject_bundle18.py                                   (new)
 js/polyglot/r-air-gap-prebundle.js                    (new)
 test/bundle18-archetype-drills-r-airgap.test.mjs      (new)
 canvas/index.html                                     (modified, via injector)
 canvas/integrity.manifest.json                        (modified, new tracked entry)
 flags.manifest.json                                   (modified, 2 new flags)
 js/drill-floor/drill-floor-data.js                    (modified, 4 new generators + tables)
 js/drill-floor/drill-floor.js                         (modified, 3 new drills + 2 new scoring helpers)
 test/bundle16-ledger-wiring-drill-battery.test.mjs    (modified, fixed pinned DRILLS.length)
 test/drill-floor.test.mjs                             (modified, fixed pinned table-load count)
```

11 files changed, 2,930 insertions(+), 19 deletions(-) in the shipped commit.

## Residuals / notes for follow-up

- The R Air-Gap prebundle is a **manifest and decision contract only** in this bundle: it does not yet ship any actual local R package asset. `bundledCount` is honestly `0`. A future bundle that wants a real offline `jsonlite` (etc.) would flip that specific entry's `availability` to `'bundled'` only once a real `assetPath` exists on disk, per the invariant the test suite locks in.
- `scoreDrillExtras` / `scalarMatches` are new pure functions with no UI wiring yet in this bundle; they exist so a future detail view (or a test) can check the archetype drills' richer SQL-only goldens without a fragile column-name-guessing extractor. `scoreDrillAnswer` and its existing callers are untouched.
- One untracked, out-of-scope file exists in the working tree from an earlier unrelated research task (`research_dataglow_real_jobs_july_2026.md`) and was deliberately **not** included in this commit or PR; it remains in the workspace per the never-delete-workspace-files rule but has no bearing on Bundle 18.
- CI on the PR was still in the `pending` state at the time of this writeup (checks just started after push); no CI failures had been observed yet. The PR is `OPEN` and `MERGEABLE`.

## Source

PR: [github.com/Andre-Weissmann/dataglow/pull/608](https://github.com/Andre-Weissmann/dataglow/pull/608)
