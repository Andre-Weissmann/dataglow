# Capability detail — Language runtimes & visualization

Companion to the **Language runtimes & visualization** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the polyglot runtimes, the charting surfaces, the Drill Floor practice
module, or the Cleaning Crew PDF profiler; the index alone is enough for most tasks.

## Runtimes

Two in-browser language bridges, both LIVE with no flag gating. `js/app-shell/main.js`
registers them in `TAB_META` (`python:` line 167, `r:` line 168) and lazily boots
each runtime on its first tab activation (`switchTab` hooks at lines 377–378 call
`ensurePythonRuntime()` / `ensureRRuntime()`). Both bridges pull DuckDB tables through
`js/app-shell/duckdb-engine.js` `runQuery` and read/write `js/app-shell/state.js`.

### `js/runtimes-viz/python-runtime.js` — Pyodide 3.12 bridge

- `PY_BRIDGE_ROW_LIMIT = 200000` — every Python run re-serializes each loaded DuckDB
  table to JSON and rebuilds it as a pandas DataFrame (O(rows)); large tables are
  capped at this many rows for the Python bridge specifically.
- `computeBridgeTruncation(datasets, limit = PY_BRIDGE_ROW_LIMIT)` — PURE; returns a
  descriptor `{ table, name, rowCount, limit }` for each dataset whose `rowCount`
  exceeds the limit, so the UI can warn Python sees a truncated view.
- `extractImageDataUrls(images)` — PURE; keeps only strings starting with
  `data:image/` (matches the R side's identical export).
- `initPyodideRuntime(onStatus)` — memoized (single `loadPromise`); injects the
  Pyodide loader from `https://cdn.jsdelivr.net/pyodide/v0.26.2/full/`, loads
  `pandas`/`numpy`, then best-effort loads `matplotlib` (headless `AGG` backend). If
  matplotlib fails, Python degrades cleanly to text-only (`matplotlibReady = false`).
  Registers the bridge object `dataglow` (a `_DataglowBridge` with
  `_register(name, json_str)` and `get_df(name)` returning a `.copy()` of the pandas
  DataFrame; missing names raise `ValueError`). Stores the instance on `state.pyodide`.
- `runPython(code, activeTableName)` — pushes every dataset in `state.datasets` into
  the bridge via `SELECT * FROM <table> LIMIT PY_BRIDGE_ROW_LIMIT` +
  `dataglow._register`, captures stdout/stderr (stderr prefixed `ERR: `), runs the
  code, captures matplotlib figures (base64 PNG data URLs, closed after capture even
  on error), and returns
  `{ stdout, result, error, truncated, images }`.

Object-space registration: the raw pandas frames the bridge holds are registered as
live objects by the caller — `main.js` calls `registerRuntimeObjects('python')`
after each run (line 2694), flag-gated / no-op when off. See `js/objects/*`.

UI wiring (`main.js`): `initPythonTab()` (line 2685) wires `#btn-py-run`, renders the
truncation warning (`py-truncation-warning`), console output, and each captured
image as `<img class="runtime-chart">`. Errors optionally routed through the Polyglot
Error Advisor when `polyglotErrorAdvisor` is enabled (line 2729).

### `js/runtimes-viz/r-runtime.js` — WebR 4.4 bridge

- `extractImageDataUrls(images)` — PURE; same contract as the Python side.
- `buildRBridgeNotices({ graphicsAvailable, hasJsonlite })` — PURE; returns honest
  one-line notices when `jsonlite` failed to install ("Using a simplified data
  bridge…") or `ggplot2` failed ("ggplot2 could not be installed — base R plotting
  still works…").
- `initWebRRuntime(onStatus)` — memoized; dynamically imports
  `https://webr.r-wasm.org/latest/webr.mjs`, `new WebR()`, `init()`, then best-effort
  `installPackages(['jsonlite'])` and `installPackages(['ggplot2'])` (tracked in
  module-level `jsonlitePromise` / `ggplot2Promise` booleans). Stores `state.webR`.
- `runR(code)` — binds each dataset's JSON as `.dataglow_json_<table>` in the R global
  env (via `webR.objs.globalEnv.bind`, `LIMIT 200000` — hardcoded here, not the shared
  Python constant). Installs `dataglow_get_df(name)`: when jsonlite is present it uses
  `jsonlite::fromJSON`; otherwise a hand-rolled base-R regex parser
  (`.dataglow_parse_json_rows`) handles the flat row shape DataGlow emits. Runs the
  code in a `Shelter` via `captureR` (`withAutoprint`, `captureStreams`,
  `captureConditions`, `captureGraphics`), rasterizes captured `ImageBitmap`s to PNG
  data URLs (`bitmapsToDataUrls`), and returns
  `{ stdout, error, images, graphicsAvailable, hasJsonlite }`.

Object-space registration: `main.js` calls `registerRuntimeObjects('r')` after each
run (line 2771).

UI wiring (`main.js`): `initRTab()` (line 2762) wires `#btn-r-run`, renders bridge
notices via `buildRBridgeNotices`, console output, and captured images.

The bridge contract in both languages: `dataglow.get_df('<table>')` (Python) and
`dataglow_get_df('<table>')` (R) return a DataFrame / data.frame of a loaded table by
name; unknown names raise/`stop`.

## Visualization

### `js/runtimes-viz/visualize.js` — Plotly chart builder (LIVE, no flag)

- `combineWhere(existingCondition, whereClause)` — PURE; ANDs a chart's own condition
  with an optional extra raw-SQL boolean clause, returning a full ` WHERE …` fragment
  (leading space) or `''`. With `whereClause` empty it returns exactly the original
  condition, so existing 5-arg `renderChart` callers produce byte-identical SQL.
- `renderChart(containerId, table, chartType, xCol, yCol, whereClause, opts)` — builds
  a Plotly `data`/`layout` per chart type and calls `Plotly.newPlot`. Theme-aware
  colors from `state.theme`. Chart-type SQL:
  - `pie`: `GROUP BY 1 ORDER BY 2 DESC LIMIT 12`
  - `histogram` / `box`: `WHERE "<x>" IS NOT NULL` on a single column
  - `scatter`: both cols non-null, `LIMIT 5000`, `scattergl` markers
  - `line`: `AVG("<y>") … GROUP BY 1 ORDER BY 1 LIMIT 500`
  - `bar` (default): `AVG("<y>")` or `COUNT(*)`, `GROUP BY 1 ORDER BY 2 DESC LIMIT 25`

  Optional `opts.onPointClick(table, column, value)`: when supplied, wires a
  `plotly_click` handler that cross-filters on the clicked category (pie by `label`,
  bar/line/histogram by `x`). `scatter` and `box` are deliberately EXCLUDED (continuous
  axes have no meaningful equality cross-filter). The single-chart Visualize tab
  passes nothing and is unaffected.
- `exportChartPNG(containerId, filename)` — `Plotly.downloadImage` PNG (1200×700).

UI wiring (`main.js`): `initVisualizeTab()` (line 7813) wires `#btn-viz-generate` →
`viz.renderChart('viz-chart', …)` (line 7825) and `#btn-viz-export` →
`viz.exportChartPNG('viz-chart', …)` (line 7848); `populateVisualizeBuilder()` fills
the x/y selectors. The Rigor Engine badge (`renderVisualizeRigorBadge`) is layered on
when `rigorEngineBadges` is enabled.

### `js/runtimes-viz/glow-canvas.js` — multi-chart dashboard

Layout algebra is PURE, Node-testable, never mutates its input (every mutator returns
a NEW layout). The thin `renderCanvas` renderer delegates every chart draw to the
imported/injected `viz.renderChart` — it invents no chart engine.

- Constants: `GRID_COLUMNS = 2`, `DEFAULT_CARD_W = 1`, `DEFAULT_CARD_H = 1`;
  `CANVAS_CHART_TYPES = ['bar','line','scatter','pie','histogram','box']` (exactly the
  Visualize set).
- `createCanvasLayout()` → `{ cards: [], nextId: 1, activeFilter: null }`.
- `addCard(layout, cardSpec)` — appends a card `{ id, table, chartType, xCol, yCol,
  title, gridPos }`, auto-assigning a monotonic `id` and a `nextAvailableSlot` gridPos
  (row-by-row, column-by-column packer) unless a gridPos is supplied. Returns a new
  layout with `nextId: id + 1`.
- `removeCard(layout, cardId)` / `updateCardPosition(layout, cardId, gridPos)` — remove
  by id / replace one card's gridPos; `nextId` preserved so removed ids are never
  reused; unknown ids leave the layout unchanged (fresh copy).
- Cross-filter (a single canvas-wide `activeFilter` `{table, column, value}` on the
  layout, not per-card): `setActiveFilter`, `clearActiveFilter`, `toggleFilter`
  (clicking the same point again clears it). `filterWhereClause(layout, card)` returns
  the raw-SQL `"<col>" = '<value>'` clause only when the card's `table` matches the
  filter's table (different-table cards render unfiltered — no join-key model yet);
  the column identifier is double-quote-escaped and the value single-quote escaped via
  `sqlStringLiteral`.
- Serialize/deserialize contract: `serializeLayout(layout)` normalizes then
  `JSON.stringify`; `deserializeLayout(json)` returns a safe empty layout and NEVER
  throws on malformed JSON or non-layout JSON. `normalizeLayout` recomputes `nextId =
  max(declared, maxId + 1)` so ids never collide.
- `renderCanvas(containerId, layout, opts)` — browser-only DOM renderer; draws a
  toolbar ("Add chart", chart count, filter indicator/clear), an inline add form, an
  empty state, and a CSS grid of cards. Each card delegates to
  `opts.renderChart` (defaults to `viz.renderChart`), passing the cross-filter
  `whereClause` and a generic `onPointClick` that toggles the filter. Filtered cards
  get a badge + outline. A per-card render failure shows "Chart error." and never
  aborts the others.

Gating: **flag `glowCanvas`, `enabled: true`** in `flags.manifest.json` (promoted live
in `feat/phase6-end-to-end-unblock`). Despite the module's in-file "ships dark"
comments, it is currently ON. The flag is checked by the CALLER in `main.js`, never
inside the module.

UI wiring (`main.js`): `renderGlowCanvasTab()` (line 7908) early-returns when
`isEnabled('glowCanvas')` is false; otherwise loads the saved layout once per session
via `memoryStore.getCanvasLayout` and calls `drawGlowCanvas()` →
`glowCanvas.renderCanvas('glow-canvas-body', …)` (line 7898). `onChange` persists via
`persistGlowCanvasLayout()` → `memoryStore.saveCanvasLayout` (the IndexedDB
`canvasLayouts` store in `js/learning/memory-store.js`) and redraws. Tab visibility is
also gated in the tab bar/sidebar (`main.js` line 261, `glowcanvas`).

## Drill Floor

A practice-problem module ("Data Drill" format): the SAME problem solved side-by-side
in SQL, Python, and R against bundled tables. Gating: **flag `drillFloor`,
`enabled: true`** (promoted live 2026-07-18, `feat/drill-floor-batch1-spot-the-sale`).
Again ON despite the in-file "ships dark" comments; the flag is checked by the caller
in `main.js` (line 266 for the tab, line 8176 for the panel).

### `js/drill-floor/drill-floor.js` — registry + run orchestration

- `DRILLS` — Batch 1 has ONE entry, `spot-the-sale` (`title`, `difficulty:
  'Beginner'`, `description`, `ordersTable`/`promosTable`, `expectedApproach`, and
  pre-filled `starterSql` / `starterPython` / `starterR`). The starters print
  `matched rows: N` (Python `print(f"matched rows: {len(result)}")`, R `cat('matched
  rows:', nrow(result), '\n')`) — the exact line the diff engine parses.
- `getDrill(id)` — PURE; drill object or null.
- `extractRowCount(queryResult)` — PURE; prefers `rowCount`, falls back to
  `rows.length`, else null.
- `runDrillSql(sql, { runQuery })` → `{ result, rowCount }` or `{ error }`.
- `runDrillPython(code, { runPython })` → the bridge's `{ stdout, result, error }` (or
  `{ error }`).
- `runDrillR(code, { runR })` → the bridge's `{ stdout, error }` (or `{ error }`).

  All three run* delegators follow never-throw-out discipline: a runtime rejection
  becomes a returned `{ error }` string, never a thrown exception. They reuse the
  existing runtime bridges — no reimplementation.

### `js/drill-floor/drill-floor-data.js` — deterministic sample data

- Dedicated table names `DRILL_ORDERS_TABLE = 'drill_orders'`, `DRILL_PROMOS_TABLE =
  'drill_promos'` (namespaced so they never clash with user tables).
- `generateOrders(count = 300, seed = 1337)` — PURE; seeded `mulberry32` PRNG; rows
  `{ order_id, order_date (ISO), customer_id, channel, amount }`.
- `generatePromos(count = 14, seed = 4242)` — PURE; overlapping/boundary-adjacent date
  ranges (3–14 day promos, `discount_pct` 5..30 step 5); rows `{ promo_id, promo_name,
  start_date, end_date, discount_pct }`.
- `sqlLiteral(value)` — PURE; SQL literal with doubled single quotes; numbers pass
  through; null/undefined → `NULL`.
- `buildCreateTableSql(tableName, columnDefs, rows)` — PURE; emits `CREATE OR REPLACE
  TABLE` + `INSERT … VALUES` text. Column defs: `ORDERS_COLUMNS` / `PROMOS_COLUMNS`
  (typed for DuckDB).
- `loadDrillTables({ runQuery }, data)` — the ONLY side-effecting function; runs the
  CREATE/INSERT SQL for both tables and returns descriptors `{ name, table, rowCount,
  cols }`.

### `js/drill-floor/drill-diff.js` — cross-language result diff (Batch 2)

PURE by construction — takes already-computed run* results (or raw stdout), never
touches a runtime/DB/DOM.

- `LANG_LABELS = { sql: 'SQL', python: 'Python', r: 'R' }`.
- `parseMatchedRows(stdout)` — PURE; regex `/matched rows:\s*(\d+)/gi`, LAST match
  wins; returns the integer or null (never guesses).
- `compareDrillResults({ sql, python, r })` — PURE. Normalizes each language into
  `{ state, count, error? }` (state: `ok` / `error` / `unknown` / `not-run`; SQL count
  from `rowCount`, Python/R count from `parseMatchedRows(stdout)`). Returns
  `{ status: 'match'|'mismatch'|'incomplete', message, languages, deltas? }`. Match
  message uses "both"/"all"; mismatch builds a grounded sentence (odd-one-out phrasing
  when 3 ran with 2 distinct counts; pairwise for 2) and computes pairwise `deltas`.
  Rule: NEVER invents numbers — every count is read from the inputs.
- `suggestLikelyCause(diffSummary)` — PURE; only for `status: 'mismatch'`. When exactly
  one language sits below a matched majority by a SMALL margin (`diff <= max(1,
  ceil(max*0.1))`), returns a `{ caveat: true, text }` hint pointing at an exclusive
  boundary comparison (`>`/`<` vs `>=`/`<=`) dropping rows on a promo's start/end date.
  Returns null otherwise — it NEVER asserts a cause.

UI wiring (`main.js`): `renderDrillFloorTab()` (line 8173) renders three editors
pre-filled with the starters plus a Comparison panel. `loadDrillTables({ runQuery:
engine.runQuery })` runs once per session and pushes the descriptors into
`state.datasets` WITHOUT changing the active dataset (so the Python/R bridges expose
`drill_orders`/`drill_promos` via `get_df`). Run buttons call
`drillFloor.runDrillSql` (8277), `runDrillPython` (8297, lazily booting Pyodide via
`ensurePythonRuntime`/`initPyodideRuntime`), and `runDrillR` (8317, lazily booting
WebR). After every run, `updateComparison()` re-runs `drillDiff.compareDrillResults` +
`suggestLikelyCause` over `drillResults = { sql, python, r }`. A noted pre-flight fix:
`renderDrillOutput` only renders `result` when it is genuinely a string (SQL's raw
DuckDB object previously printed "[object Object]").

## PDF profiling

### `js/cleaning-crew/pdf-profiler.js` — Cleaning Crew Profiler station (Batch 1)

First station of a planned multi-agent ingestion pipeline (Profiler → Extractor →
Cleaner → Validator → Documenter); Batch 1 ships only the Profiler, PDF-only. Zero
cloud calls — PDF.js parses client-side. Gating: **flag `cleaningCrew`,
`enabled: true`** (`feat/cleaning-crew-batch1-profiler-pdf`); ON despite the in-file
"ships OFF" comment. Checked by the caller in `main.js` (line 8341).

PURE core (takes already-extracted per-page text):

- `summarizePdfProfile(pages)` — a page "has text" when its extracted text is non-empty
  after trimming. Returns `{ pageCount, pagesWithText, pagesWithoutText, extractedText,
  hasExtractableText, warnings }`. Warnings: none-found (0 pages), all-scanned (all
  pages without text → "OCR support is not yet available"), or partial.
- `pdfProfileToRows(profile)` — PURE; one row per page `{ page_number, text }` (scanned
  pages get an empty string, so row count always equals page count).
  `PDF_DATASET_COLUMNS = ['page_number', 'text']`.
- `buildPdfGateLayers(profile)` — PURE; maps the profile to `{layer, status, summary}`
  entries: all-text → single `pass`; partial → `pass` + `warn`; zero text → hard
  `fail`.
- `evaluatePdfReadiness(profile, options)` — PURE; delegates to
  `js/gate/readiness-gate.js` `computeReadinessGate` + `explainGateReasons`, returning
  `{ gate, explanation, layers }`. Zero text → `gate.agentConsumable: false`; partial →
  true with a surfaced warning.

BROWSER-ONLY:

- `ensurePdfjs()` — lazy CDN loader for PDF.js v3 UMD build
  (`3.11.174`, jsDelivr), mirroring `python-runtime.js`'s `loadPyodideScript`; injects
  `pdf.min.js`, expects the `pdfjsLib` global, and points the worker at
  `pdf.worker.min.js` (`ensurePdfWorker`).
- `profilePdf(file)` — loads PDF.js, reads the File as `Uint8Array`, iterates every
  page's `getTextContent()`, joins `item.str` values, and returns
  `summarizePdfProfile(pages)`.

UI wiring (`main.js`): `renderCleaningCrewTab()` (line 8338) renders the Profiler
station and a PDF upload that reuses `loaders.loadPdfAsDataset(file)` (the SAME code
path a PDF dropped on the main upload zone takes → `profilePdf` → `loadRowsAsDataset`),
so a PDF becomes an ordinary queryable dataset. `renderCleaningCrewProfile(profile)`
(line 8382) calls `pdfProfiler.evaluatePdfReadiness` and shows page counts, warnings,
and the gate verdict.

## Related files (not in this area)

- `js/app-shell/duckdb-engine.js` — the `runQuery` bridge every module above pulls
  table data through.
- `js/app-shell/state.js` — holds `state.datasets`, `state.pyodide`, `state.webR`,
  `state.theme`.
- `js/gate/readiness-gate.js` — `computeReadinessGate` / `explainGateReasons` reused by
  the PDF profiler.
- `js/learning/memory-store.js` — the IndexedDB `canvasLayouts` store Glow Canvas
  persists to.
- `js/app-shell/loaders.js` — `loadPdfAsDataset` / `loadRowsAsDataset` ingestion path.
- `js/objects/*` — object-space registry the Python/R runs feed via
  `registerRuntimeObjects`.

## Tests (`dataglow/test/`)

- `python-bridge-truncation.test.mjs` — Python bridge truncation logic.
- `runtime-charts.test.mjs` — runtime chart image handling.
- `glow-canvas.test.mjs` — Glow Canvas layout algebra / serialize contract.
- `drill-floor.test.mjs` — Drill Floor registry + data layer.
- `drill-diff.test.mjs` — cross-language diff engine.
- `cleaning-crew-profiler.test.mjs` — PDF profiler pure core.

(The browser-only paths — Pyodide/WebR init, `renderChart`/`renderCanvas` DOM,
`profilePdf` PDF.js parsing — are not unit-tested in Node, matching the modules'
own notes.)
