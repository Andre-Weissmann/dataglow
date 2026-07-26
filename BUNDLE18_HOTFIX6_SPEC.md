# Bundle 18 Hotfix 6 — Archetype drill SQL goldens match starter result shapes

## Live proof (2026-07-26, after #613)

| Drill | Picker | Run | Check | Notes |
|---|---|---|---|---|
| scd-as-of (Price As Of Sale Date) | visible | 314 rows | **PASS** | OK |
| streak-islands (Longest Activity Streak) | visible | **1 row** | **FAIL** `expected 474, got 1` | golden wrong for SQL starter |
| basket-pairs (Most Common SKU Pair) | visible | not finished (script crash) | TBD | expect rowCount 1 |

## Root cause

`streak-islands` SQL starter ends with `LIMIT 1` and returns the winner
`(user_id, max_streak)` — **1 row**.

`goldenAnswers.sql.rowCount` was set to **474** (= `activityDays.length`, the
underlying table size). That matches Python/R starters which print
`matched rows: ${len(activity)}`, but **not** the SQL result shape that
`scoreDrillAnswer` reads via `extractRowCount` / `rows.length`.

So Check answer is dark for the shipped SQL starter even though the engine and
wiring are correct.

## Fix (minimal, honest)

1. **`js/drill-floor/drill-floor.js`**
   - `streak-islands.goldenAnswers.sql.rowCount` → **1**
   - Keep `maxStreak: 9`, `userId: 1`, `islandCount: 106` on sql extras
   - Keep `python.rowCount` and `r.rowCount` at **474** (stdout matched-rows line)
   - Add a one-line comment near the golden: SQL rowCount is the starter result
     shape (LIMIT 1 winner); Python/R rowCount is the activity table size printed
     by their starters.

2. **`canvas/index.html`** (AUTHORITATIVE)
   - Same golden change in the inlined drill-floor block (keep short-form markers
     / integrity in sync)
   - integrity.manifest.json canvasBytes if required

3. **Tests**
   - Update `referenceStreakGolden` in
     `test/bundle18-archetype-drills-r-airgap.test.mjs` to return:
     - `rowCount: activityDays.length` for py/r comparison
     - `sqlRowCount: 1` for SQL comparison
   - Assert `drill.goldenAnswers.sql.rowCount === 1`
   - Assert `drill.goldenAnswers.python.rowCount === activityDays.length`
   - Add/adjust a test that `scoreDrillAnswer('streak-islands','sql',{result:{rowCount:1}})` PASSes
     and `{rowCount:474}` FAILs for sql
   - New file optional: `test/bundle18-hotfix6-streak-sql-rowcount.test.mjs` if cleaner

4. **Do not** change the SQL starter (LIMIT 1 winner is the correct answer shape).

5. **Optional polish (include if cheap):** when Check answer runs for SQL and
   `scoreDrillExtras` exists, if the last SQL result has columns that map to
   extra goldens (e.g. `max_streak`/`user_id`), surface extras in the status.
   Not required for green Check; rowCount fix is the blocker.

## Out of scope

- A48, Proof Harness v0, Python/R runtime live prove
- Changing activity generator sizes

## Definition of done

1. PR opened, CI green
2. Squash-merged (parent confirms)
3. Live republish
4. Honest Playwright for all three:
   - scd-as-of Check PASS (314)
   - streak-islands Check PASS (1)
   - basket-pairs Check PASS (1)

## Branch

`feat/bundle18-hotfix6-streak-sql-golden`

Worktree: existing `/home/user/workspace/dataglow-f2133f3e-e20d9956` only.
No managed clone. No em dash in user-visible text.
Result: `BUNDLE18_HOTFIX6_RESULT.md`
