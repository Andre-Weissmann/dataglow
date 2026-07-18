# Capability detail — App shell / navigation

Companion to the **App shell / navigation** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the Command Deck nav or palette; the index alone is enough for most tasks.

## What this area is

The **Command Deck** navigation redesign, shipped in independent parts. Both
modules here are pure logic (no DOM, no globals, no keyboard listeners) — `main.js`
owns the DOM presentation and event wiring, the same pure-core / thin-renderer
split used elsewhere. Both are drift-proofed: their tab lists are built from (or
validated against) the real `TAB_META`/`state.tabOrder` in `main.js` at
call/test time, so they can never silently diverge from the app's actual tools.

## `js/app-shell/command-deck-nav.js` — Part 1 (5-stage sidebar)

Regroups the existing tabs into 5 **Trust-Tier Lifecycle Stages** via the exported
`COMMAND_DECK_STAGES`: **Frame** (framer, preflight, watch), **Work** (sql,
python, r, clean, drillfloor, cleaningcrew, joinbuilder, nlsql), **Trust**
(validate, diff, meeting, diplomacy, proofroom, convergence, crucible, copilot,
dvc), **Generate** (twin), **Tell** (visualize, glowcanvas, story). It is pure
metadata — zero new tabs. Exports:

- **`buildSidebarContent({ tabMeta, activeTab })`** → `{ stages, unassignedTabs }`.
  Each stage resolves its tab ids against the caller's real `tabMeta` (only lists
  tabs that actually exist), marks the `active` tab, and flags `containsActive` so
  the caller can auto-expand the right stage. **`unassignedTabs`** honestly
  surfaces any real tab not covered by a stage rather than silently dropping it.
- **`validateStageCoverage(realTabIds)`** → `{ ok, missing, stale }` — the
  drift guard used by tests (and safe at runtime): `missing` = real tab in no
  stage, `stale` = stage lists a removed tab.
- **`stageForTab(tabId)`** → the stage id or `null`.

The module's header records the design decision (Command Deck over the deferred
Conversational Front Door / Lifecycle Canvas) and two post-merge addenda where the
coverage test caught newly-landed tabs (`meeting`; then `joinbuilder`/`nlsql`/`dvc`)
as unassigned — the drift guard doing its job.

**Flag:** `dataglowSidebarNav` — **`enabled: true`** (added in
`gen44-command-deck-part1-sidebar-nav`, later **promoted** via
`feat/enable-remaining-ready-flags-v2`; the flag description's "ships dark by
default" text predates that promotion).

**Wiring:** imported in `main.js` (line 9); `buildSidebarContent` is called
(~line 470) inside a block gated on `isEnabled('dataglowSidebarNav')`, rendering
`#command-deck-sidebar` alongside the existing top tab bar (the fallback nav).

**Tests:** `test/command-deck-nav.test.mjs` (asserts stage coverage against the
real `TAB_META`).

## `js/app-shell/command-palette.js` — Part 2 (Ctrl/Cmd+K palette)

Pure fuzzy-match + ranking for a global command palette. Answers "which commands
match" and "what happens when one is chosen" — but never calls app functions
itself (each command carries a stable `run`/`tabId` id the caller resolves).
Exports:

- **`COMMAND_ACTIONS`** — a small static registry of in-tool actions
  (`runSqlQuery`, `runValidation`, `scanClean`, `runPreflight`, `runDiagnostics`,
  `exportXlsx`), each with an optional `whenTab` restricting when it is offered.
- **`buildCommandList({ tabMeta, tabOrder, activeTab })`** → one `type:'tab'`
  command per real tab (in `tabOrder`) plus every `type:'action'` command whose
  `whenTab` matches `activeTab` (or has none).
- **`scoreCommand(command, query)`** → relevance score with a clear priority
  ladder: empty query = 1 (show all), exact label = 100, prefix = 80, substring =
  60, keyword substring = 40, subsequence fuzzy match = 10, else 0. The
  subsequence rule (`isSubsequence`) is what lets loose typing like "gt sql" find
  "Go to SQL".
- **`filterCommands(commands, query, limit)`** → filtered, score-sorted list with
  stable tie-breaking by original index; optional `limit` slice. Non-mutating.

**Flag:** `dataglowCommandPalette` — **`enabled: true`** (added in
`gen44-command-deck-part2-command-palette`). Independent of `dataglowSidebarNav` —
either can be on/off without affecting the other.

**Wiring:** imported in `main.js` (line 10, `buildCommandList` + `filterCommands`);
the modal, keyboard listener, and `run`-id → real-function switch live in `main.js`
(~line 513 onward).

**Tests:** `test/command-palette.test.mjs`.

## Related but not in scope

- `main.js` `TAB_META` / `state.tabOrder` — the single source of truth both
  modules validate against.
- Part 3 (adaptive next-step rail) is a named follow-on batch, not present in
  either of these modules.
