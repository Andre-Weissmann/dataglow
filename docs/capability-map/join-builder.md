# Capability detail — Join Builder

Companion to the **Join Builder** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the visual join builder; the index alone is enough for most tasks.

## How the area is shaped

Phase 8's multi-table visual join builder splits cleanly into a **pure core**
(`join-model.js` + `join-sql.js`, both Node-testable, no DOM) and a
**browser-only renderer** (`join-canvas.js`). State ownership lives in
`main.js` — the canvas renders a `JoinGraph` and calls back via
`onGraphChange(newGraph)`; it never mutates the graph directly. This mirrors the
pure-core discipline used in `glow-canvas.js` and `room-ui.js`.

## `join-model.js` — pure graph state

Vocabulary: a `Card` is a schema card for one table
(`{ id, table, cols:[{name,type}], pos:{x,y} }`); an `Edge` is a join link
(`{ id, from:{cardId,col}, to:{cardId,col}, type }`); a `JoinGraph` is
`{ cards:[], edges:[] }`. `JOIN_TYPES = ['INNER','LEFT','RIGHT','FULL']`.

Every mutator returns a **new** graph and never mutates its input:
- `createJoinGraph()`, `addCard(graph,{table,cols,pos})` (auto-positions via
  `autoCardPos` — tiles 4 per row; throws on duplicate table), `removeCard`
  (also drops edges referencing the card), `moveCard`, `getCard`,
  `getCardByTable`.
- `addEdge(graph,{from,to,type='INNER'})` validates both cards and both columns
  exist, rejects self-joins, rejects duplicate edges (either direction), and
  rejects unknown join types. `removeEdge`, `setEdgeType`, `edgesForCard`.
- `validateGraph(graph)` returns human-readable problems (empty = ready): flags
  an empty canvas, unconnected multi-table graphs, and any card not reachable
  from the first card via a BFS/union walk over edges. A single table with no
  edges is valid.
- `serializeGraph` / `deserializeGraph` (returns an empty graph on bad input).
- `_resetIdCounter()` exists for deterministic test IDs.

## `join-sql.js` — SQL generator

- `generateJoinSQL(graph, opts)` → `{ sql, warnings }`. Validates first
  (returns `{sql:'', warnings:problems}` on failure); single-table shortcut
  emits `SELECT * FROM "table"`. Otherwise it BFS-orders cards from the root
  (first card), assigns aliases `t1, t2, …`, and emits one `<type> JOIN … ON
  t_a.col = t_b.col` per line. Column projection is `*` unless a name collision
  exists across tables, in which case every column is prefixed
  (`t1."col" AS "table_col"`) and a collision warning is pushed. Supports
  `selectCols`, verbatim `where`, and `limit`. Identifiers are quoted via `q()`
  (doubles embedded `"`).
- `generatePreviewSQL(graph)` = `generateJoinSQL(graph, { limit: 500 })`.
- `suggestJoinColumns(fromCard, toCard)` → `{fromCol,toCol}|null`, never throws.
  Heuristics in priority order: (1) exact case-insensitive name match, (2)
  `_id`/`_key`/`id`/`key`-suffixed name matching the other side, (3)
  cross-table FK shape (`patient` ↔ `patient_id`).

## `join-canvas.js` — SVG renderer (browser-only)

`renderJoinCanvas({host, graph, onGraphChange, onSQLChange, onRunSQL})` draws
schema cards and bezier edges into an SVG viewport. Edges are colour-coded by
join type (`INNER` teal, `LEFT` rust, `RIGHT` purple, `FULL` gold, dashed).
Interactions: drag card headers to reposition (live edge redraw, commit on
pointerup via `moveCard`); click-to-connect columns (click a column port, then
another card's column → `addEdge`, errors surfaced as a transient SVG label);
click an edge for an INNER/LEFT/RIGHT/FULL type picker + "Remove edge"; `×`
removes a card; ESC/canvas-click cancels a pending connection. It emits SQL
immediately via `onSQLChange`. `buildJoinToolbar({...})` builds the add-table
selector, "Clear canvas", and "Run query" button (pushes generated SQL out via
`onRunSQL`).

## UI surface & flag

Wired into `js/app-shell/main.js`: imports `createJoinGraph` (`main.js:149`)
and `renderJoinCanvas`/`buildJoinToolbar` (`main.js:150`). The **"Join Builder"
tab** is filtered in `renderTabBar` only when `isEnabled('joinBuilder')`
(`main.js:262`); the tab renderer lives around `main.js:7925`, holds
`joinGraph`/`joinBuilderLoaded` module state, and the Run query button routes the
generated SQL into the SQL tab.

Flag `joinBuilder` in `flags.manifest.json` is **`enabled: true`** — the feature
is **live**, described as additive with no risk to existing tabs (added in
`feature/phase8-join-builder`).

## Tests

`test/phase8-join-builder.test.mjs` covers this area. (Not executed here.)

## Caveat — stale "ships dark" comment

The manifest is authoritative and says `joinBuilder` is `enabled: true` (live).
However, the tab-renderer comment in `main.js` (around line 7925/7928) still
reads "ships dark behind the joinBuilder flag ... off by default." That comment
is **out of date** relative to the manifest; treat the flag state
(`enabled: true`) as current, not the comment.
