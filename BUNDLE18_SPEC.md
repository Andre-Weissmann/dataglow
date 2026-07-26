# Bundle 18 SPEC — Archetype drills + R Air-Gap prebundle + interactive path proof

**Date:** 2026-07-26  
**Base:** main @ 20fe3ea (B17)  
**Workspace ONLY:** `/home/user/workspace/dataglow-f2133f3e-e20d9956`  
**Do NOT managed-clone. Do NOT pass repo_url.**  
**Authoritative UI:** `canvas/index.html`  
**Branch:** `feat/bundle18-archetype-drills-r-airgap`  
**Merge:** `gh pr merge --squash --delete-branch` only after CI green  

## Title
B18 — Archetype drills (SCD / streaks / baskets) + R Air-Gap prebundle + cross-platform sanity

## Goal
Expand original Drill Floor battery with three high-value analyst archetypes (SCD/as-of, gaps-and-islands streaks, basket pairs), score them for SQL/Python/R with DuckDB-verified goldens, improve R Air-Gap package availability with an honest prebundle path, keep web + Tauri + PWA/mobile shared, and leave interactive SQL/Drill Floor proof for parent post-publish.

## Flags (add + enable ON)
- `archetypeDrillsExpand` — new SCD / streaks / baskets drills + scorers + synthetic data  
- `rAirGapPrebundle` — R Air-Gap prebundle path + honest blocked UI  

Keep all existing B15–B17 flags ON (do not flip any off). Expected total flags: 173 ON / 0 OFF after this bundle if starting from 171.

## Non-goals (HARD)
- No A48 Steve Jobs full redesign  
- No Microsoft Power Query / mashup M engine  
- No Maven UI/contests/leaderboards/branding/datasets/names  
- No HIPAA certification claims  
- No auto-post LinkedIn / auto-push resume  
- No em dashes (U+2014) in ANY visible product text (only inside `/* */` JS/CSS comments)  
- No recreating `canvas/vendor/duckdb-wasm/` (self-host is `assets/duckdb/` only)  
- No desktop-only APIs that break Tauri/PWA  

---

## A. Original archetype drills + goldens

### A1. Add three drills (original synthetic data only)

Follow existing Drill Floor patterns in:
- `js/drill-floor/drill-floor.js` (DRILLS registry, starters, run*)
- `js/drill-floor/drill-floor-data.js` (deterministic PRNG tables)
- `test/drill-floor.test.mjs`, `test/bundle16-ledger-wiring-drill-battery.test.mjs`
- Canvas Drill Floor UI + `scoreDrillAnswer` path from B16 receipt drill battery

#### Drill 1: `scd-as-of` — SCD / as-of lookup
- **Story (original):** Product price history with effective date ranges; for each sale, find the price that was active on the sale date (as-of / SCD Type 2 style join).  
- **Tables:** e.g. `drill_price_history` (product_id, price, valid_from, valid_to), `drill_sales` (sale_id, product_id, sale_date, units).  
- **Task:** Join each sale to the price row where `sale_date` is within `[valid_from, valid_to]` (define inclusive bounds clearly in description). Compute total revenue = sum(units * price) for matched sales.  
- **Starter SQL/Python/R** that are correct and runnable.  
- **Golden (DuckDB-derived, deterministic seed):** at minimum  
  - `rowCount` (matched sale rows)  
  - `totalRevenue` (number, fixed precision)  
  - optional `productCount`  
- **scoreDrillAnswer:** sql / python / r  

#### Drill 2: `streak-islands` — gaps-and-islands streaks
- **Story (original):** Daily activity log; find the longest consecutive-day streak per user (or global max streak).  
- **Tables:** e.g. `drill_activity_days` (user_id, activity_date).  
- **Task:** gaps-and-islands / island grouping; report the maximum streak length (days) across users, and which user_id holds it (tie-break: lowest user_id).  
- **Golden:** `maxStreak`, `userId`, optional `islandCount`  
- **scoreDrillAnswer:** sql / python / r  

#### Drill 3: `basket-pairs` — market-basket co-occurrence
- **Story (original):** Order line items; count how many distinct orders contain both item A and item B for the top pair by co-occurrence (or a fixed pair defined in the prompt). Prefer: find the unordered pair of distinct SKUs that co-occur in the most orders; report pair labels (lexicographically ordered) and order count.  
- **Tables:** e.g. `drill_basket_lines` (order_id, sku).  
- **Golden:** `pairLeft`, `pairRight`, `orderCount` (and optional `pairKey`)  
- **scoreDrillAnswer:** sql / python / r  

### A2. Scoring + CI
- Extend `scoreDrillAnswer` (or equivalent B16 battery scorer) for the three new drill ids.  
- Numeric tolerance: use existing drill battery float compare pattern (e.g. absolute/relative epsilon already in repo).  
- Strings: exact case-sensitive match after trim.  
- Unit tests MUST compute expected goldens via pure JS or by embedding DuckDB-node if already used; prefer deterministic pure computation matching the SQL logic so CI does not need network.  
- Add `test/bundle18-archetype-drills-r-airgap.test.mjs` covering:  
  - flags present + enabled  
  - three drills registered with starters for sql/python/r  
  - golden answers match pure reference  
  - scoreDrillAnswer PASS on correct payloads, FAIL on wrong  
  - no Maven brand strings in product paths  
  - no U+2014 em dash in new user-visible strings  
  - rAirGap prebundle symbols/strings present  
  - canvas integrity / inject patterns consistent with B17  

### A3. UI
- Drill Floor list/nav must surface the new drills (same panel as existing Spot the Sale / battery drills).  
- Touch-friendly targets remain usable (min ~44px where buttons already follow that).  
- Keep Drill Floor trigger independent of OSCE (B17).  
- Canvas is authoritative: update `canvas/index.html` inlined sections the same way prior inject_bundle*.py scripts do. Prefer extending `inject_bundle18.py` following `inject_bundle17.py` patterns, then run it, then refresh integrity manifest.

---

## B. R Air-Gap prebundle

### B1. Intent
When Air-Gap mode is on (or R offline path), common analysis packages should be available without `install.packages` hitting the network. Honest ceiling when still blocked.

### B2. Implementation guidance
Inspect existing:
- webR / R runtime modules  
- `airGapMode` flag behavior  
- any prior package lists / CDN loads for R  

Ship a **fixed package set** as product allows (prefer what webR can actually load from a local/static path or already-bundled mechanism):
- Core target list (best-effort, document honestly if a package cannot be prebundled):  
  `dplyr`, `tidyr`, `ggplot2`, `jsonlite`, `readr`, `broom`  
- If full binary prebundle of all is too large or impossible in-browser, implement:
  1. A declared `R_AIRGAP_PREBUNDLE` manifest (names + versions + availability state)  
  2. Loader that prefers local/static assets over network  
  3. UI copy: "Available offline" vs "Needs network / not prebundled" — never claim packages work if they do not  
  4. Flag `rAirGapPrebundle` gates the new path; when OFF, prior behavior  

Do not download huge package trees into git if > repo limits. Prefer:
- small manifest + loader hooks + tests that assert the contract  
- optional scripts that *document* how an operator vendors packages into `assets/webr-packages/` (gitignored large blobs OK if scripted)  
- If packages cannot be vendored in this PR, still ship the contract + honest UI + a minimal smoke that `jsonlite` (or whichever is already available in default webR) is marked available offline  

### B3. Cross-platform
Same JS module path for browser, Tauri webview, and mobile PWA. No Node-only or Tauri-only APIs for the prebundle check.

---

## C. Interactive proof (PARENT owns after publish — implementers document only)
- After merge + publish, parent will: Claims Demo path → SQL RUN success → Drill Floor Check answer PASS on a golden drill.  
- Implementer: ensure Drill Floor Check answer UI works for new drills the same as existing battery.  
- Document in `BUNDLE18_RESULT.md` any residual for human/browser QA.

---

## D. Cross-platform sanity
- No new APIs that break Tauri/PWA.  
- Shared modules under `js/`.  
- Note mobile memory limits for WASM honestly in any new ceiling/help text (short).  
- Do not regress `assets/duckdb/` self-host path from B17.

---

## E. Files expected (minimum)
- `js/drill-floor/*` updates (data + drills + scoring)  
- R air-gap module or extension under existing R runtime path  
- `flags.manifest.json` (+ build-flags if needed)  
- `canvas/index.html` via inject  
- `inject_bundle18.py`  
- `test/bundle18-archetype-drills-r-airgap.test.mjs`  
- `canvas/integrity.manifest.json` refreshed  
- `BUNDLE18_RESULT.md`  
- capability-map / NORTH_STAR / DATAGLOW_BUILD_BOARD touch if those files exist and prior bundles updated them  
- Optional: `research_dataglow_real_jobs_july_2026.md` is PARENT research deliverable — do NOT block ship on it  

---

## Implementation steps (agent)
1. `cd /home/user/workspace/dataglow-f2133f3e-e20d9956 && git checkout main && git pull --rebase origin main && git checkout -b feat/bundle18-archetype-drills-r-airgap`  
2. Read B17 inject + drill-floor + scoreDrillAnswer + airGap/R runtime patterns.  
3. Implement A + B + tests.  
4. Run focused tests: `node --test test/bundle18-*.mjs` and related drill tests. Fix until green.  
5. Run canvas integrity update the same way B17 did.  
6. Commit with a clear message.  
7. Push branch and open PR to main with summary of drills, goldens, flags, air-gap honesty.  
8. Write `BUNDLE18_RESULT.md` with: files changed, golden table, flags, test commands + results, residuals, cross-platform notes.  
9. Do NOT merge (parent babysits CI + merge). Do NOT publish.  

## PR title
`Bundle 18: archetype drills (SCD/streaks/baskets) + R Air-Gap prebundle`

## Acceptance checklist
- [ ] Three original drills with SQL/Python/R starters  
- [ ] DuckDB/pure goldens + scoreDrillAnswer  
- [ ] Flags `archetypeDrillsExpand`, `rAirGapPrebundle` ON  
- [ ] Tests green  
- [ ] No em dashes in product UI strings  
- [ ] No Maven branding/data  
- [ ] canvas/index.html updated  
- [ ] PR opened, CI running  
- [ ] BUNDLE18_RESULT.md written  

## Publish notes (parent only after merge)
- Stage `canvas/` → `dataglow-live-publish/`  
- ALSO stage `assets/duckdb/` → `dataglow-live-publish/assets/duckdb/`  
- `deploy_website` should_validate: false  
- `publish_website` site_id: `347e0cfd-aa9d-4a7e-a71e-bf44f5830fac`  
- Live: https://dataglow-platform.pplx.app  
