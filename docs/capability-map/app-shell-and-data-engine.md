# Capability detail — App shell & data engine

Companion to the **App shell & data engine** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the app's core shell, the DuckDB engine, or the file loaders; the index
alone is enough for most tasks. This is the largest, most central area — 18 files
that everything else mounts into. Each *feature* area (validation, cleaning,
provenance, rooms, …) has its own companion page; this page documents the shell
that hosts them and cross-references those pages rather than duplicating feature
detail.

## How the shell is shaped

`js/app-shell/main.js` is the orchestrator (~9,400 lines). It is deliberately NOT
documented feature-by-feature here — the features it imports live in other area
pages. What it uniquely owns is: the tab model, the central-state wiring, the two
registries (capability + metrics), the async bootstrap/init sequence, and the
DuckDB warm-up. The other 17 files are small, mostly pure, and documented below by
their real exported API.

**Flag state at a glance.** Most core shell files have **no flag — they are always
live**: `main.js`, `state.js`, `utils.js`, `duckdb-engine.js`, `duckdb-config.js`,
`loaders.js`, `sql-highlight.js`, `databricks-connect.js`, `capability-registry.js`,
`metrics-registry.js`, `validate-focus.js`. Flag-gated shell files (all currently
`enabled: true` after promotion):

- `sql-dialect-adapter.js` → `multiDialectSql` (**enabled: true**)
- `object-space.js` → `objectSpaceRegistry` (**enabled: true**)
- `glow-path.js` / `glow-path-ui.js` → `glowPathRail` (**enabled: true**)
- `glow/glow-signal.js` / `glow/glow-orb-ui.js` → `glowOrb` (**enabled: true**)
- `tab-groups.js` → `groupedNavigation` (**enabled: true**)

`serverOffload` (**enabled: false**) gates the opt-in remote-query escape hatch
documented in `duckdb-config.js` #8; it is off by default. Databricks Direct-Connect
has **no flag** — it is an always-present connector panel.

## Orchestrator (main.js)

**Tab registry.** `TAB_META` is an object literal mapping every tab id to
`{ label, icon }` (e.g. `sql: { label: 'SQL', icon: 'database' }`, `nlsql:
{ label: 'AI', … }`, `dvc: { label: 'Versions', … }`). Icons resolve through the
`ICONS` map + `iconSvg(name, size)`. The canonical order and the full id list live
in `state.tabOrder` (see state.js), not in `TAB_META`.

**Rendering the bar.** `renderTabBar()` clears `#tabbar`, toggles the
`tabbar-grouped` class from `isEnabled('groupedNavigation')`, computes the visible
ids via `getVisibleTabIds()` (which filters out dark-by-default tabs — `meeting`,
`diplomacy`, `proofroom`, `convergence`, `crucible`, `copilot`, `glowcanvas` — when
their flag is off), and builds each tab with a shared `buildTabEl(tabId, idx)` that
wires the click handler (`switchTab`) and HTML5 drag-and-drop reorder (mutating
`state.tabOrder` then re-rendering). When `groupedNavigation` is on it instead lays
tabs out under mode headers via `buildTabGroups()` / `groupForTab()` from
`tab-groups.js`; the `idx` handed to each tab is still its index in the FULL
`visibleTabOrder`, so drag math is unaffected by grouping.

**Switching.** `switchTab(tabId)` toggles the `active` class on `.tab`/`.panel`
nodes, re-renders the bar only when the active mode group changed, tears down the
ambient-validation worker when leaving `sql`, and lazily initializes/renders the
target tab (`ensurePythonRuntime`, `ensureRRuntime`, `renderProofRoomTab`,
`renderConvergenceTab`, `renderGlowCanvasTab`, `renderJoinBuilderTab`, …). It also
refreshes the Glow surfaces (`renderGlowPathRail()`, `renderGlowOrbWidget()`).

**Registry consumption.** The capability registry is loaded once in
`bootstrapCapabilities()` (below) and its modules are pulled with
`registry.get('<key>')` into `let` bindings (e.g. `domainPhysics`,
`devilsAdvocate`, `peerReview`, `digitalTwin`, `watchFolder`, …). The metrics
registry is consumed via `getActiveMetricsRegistry()` (from state.js) plus
`expandMetricReferences(...)` (from metrics-registry.js) inside the SQL run path
(`runSqlQuery` region), so a `@metric` reference is expanded against the active
dataset's registry before the SQL is handed to the engine.

**Init sequence.** `document.addEventListener('DOMContentLoaded', …)` runs
`await bootstrapCapabilities()` then `init()`.
- `bootstrapCapabilities()` calls `loadRegistry()`, stashes it on
  `window.__dataglowRegistry`, fetches `flags.manifest.json` and calls
  `configureFlags(...)`, optionally installs plugin domain packs
  (`loadBuiltInPacks()` behind `pluginPacks`), and assigns each migrated module
  binding via `registry.get(...)`. A registry failure is logged but never blocks
  the shell.
- `init()` does the synchronous DOM wiring: `renderTabBar()`,
  `renderCommandDeckSidebar()`, `renderRoomUiWidget()`, `switchTab('preflight')`,
  then a long list of `init*()` panel setups (`initFileLoading`,
  `initDatabricksConnect`, `initSqlTab`, `initPythonTab`, `initSettings`,
  `initWatchFolder`, `initCommandPalette`, …). It sets `window.__dataglowInit =
  true`, then pre-warms the engine with `engine.initDuckDB()`, setting
  `window.__dataglowReady = true` on success (the Playwright "app is live"
  signal) and surfacing a retryable engine error on failure.

## State & utilities

`state.js` exports the central mutable `state` object:
`{ theme, datasets:[{name,table,rowCount,cols,loadedAt,…}], activeDataset,
duckdb:{db,conn,ready,crossOriginIsolated}, pyodide, webR, lastQuery,
lastQueryResult:{columns,rows}, queryHistory:[], validationResults:{}, latestCrucibleRun,
settings:{…}, tabOrder:[…] }`. Default `settings` include `modelProvider:'ondevice'`,
`apiKeys:{}`, `freshnessThresholdHours:24`, `persistFingerprints:false`,
`selfLearningEnabled:true`, `persistLearnedCorrections:false`,
`adaptivePriorityEnabled:true`, `persistLayerPriority:false`,
`federatedLearningEnabled:false`, `persistFederatedModel:false`,
`federatedEpsilon:1.0`. `tabOrder` is the full ordered id list (core 6 first:
`preflight, sql, clean, validate, nlsql, dvc`, then power-user tabs). Accessors:
`setActiveDataset(name)`, `getActiveDataset()`, `addDataset(ds)` (dedupes by name,
sets active). Per-dataset metrics registries are held in a module-private `Map`
keyed by table name, exposed via `getMetricsRegistry(tableName)` (lazily creating
one via `createMetricsRegistry()`) and `getActiveMetricsRegistry()`.

`utils.js` is the shared DOM/formatting toolkit: `$`/`$$` selectors, `el(tag,
attrs, children)` DOM builder (special-cases `class`, `html`, `on*` listeners),
`toast(message, type)`, `formatNumber(n)`, `escapeHtml(s)`, `debounce(fn, ms)`,
`timeAgo(ts)`, `sha256(str)` (via `crypto.subtle`, used by the Schema Fingerprint
layer), and `sanitizeTableName(name)` (strips extension + non-identifier chars,
prefixes `t_` if leading digit). All always live.

## Data engine (DuckDB) & loaders

`duckdb-engine.js` runs DuckDB-WASM entirely in-browser (zero server, zero
uploads). Assets are self-hosted under `assets/duckdb/`, resolved relative to the
module via `asset(f) = new URL('../../assets/duckdb/' + f, import.meta.url)`.
`initDuckDB()` is memoized (single `initPromise`): it dynamically imports
`duckdb-browser.mjs`, `selectBundle`s between `mvp`/`eh` bundles, spins up a Worker
from a blob `importScripts` shim, instantiates `AsyncDuckDB` with a `WARNING`-level
`ConsoleLogger`, connects, and stores `db`/`conn`/`ready` on `state.duckdb`. It
best-effort sets an OPFS `temp_directory` (via `opfsTempDirSQL()` when
`isOPFSAvailable()`) and logs `coiDiagnostic()`.
- `runQuery(sql)` — the core API. Guards `LOAD` statements against the extension
  allowlist (`isExtensionPermitted`), runs the query, and normalizes results to
  `{ columns, rows, elapsedMs, rowCount, dateColumns }`. BigInts outside safe
  integer range are kept as strings (preserves 64-bit IDs); Arrow DATE/TIMESTAMP
  columns are ISO-date-stringified.
- `runQueryBatched(sql)` — wraps `runQuery` through the `queryBatch` dedup
  coordinator (see below).
- Ingest helpers: `registerFileBuffer(fileName, arrayBuffer)` (hands DuckDB an
  independent `duckdbBytes()` copy so the worker's buffer-detach can't invalidate
  the caller's bytes), `createTableFromCSV` (with `IGNORE_ERRORS` + `STORE_REJECTS`
  so dropped rows are counted, not silently swallowed — SQL built by pure
  `buildCsvLoadSQL`/`buildCsvRejectCountSQL`), `createTableFromJSON`,
  `createTableFromParquet`, `createTableFromRows` (atomic `CREATE OR REPLACE`,
  prepared-statement inserts, then per-column `TRY_CAST` type coercion when every
  non-null value casts cleanly). Introspection: `listTables`, `getTableSchema`,
  `getRowCount`.

`duckdb-config.js` centralizes hardening decisions as pure constants/helpers (no
DuckDB calls, Node-testable). `PERMITTED_EXTENSIONS` (parquet, json, httpfs, excel,
autocomplete, icu) / `BLOCKED_EXTENSIONS` / `isExtensionPermitted`;
`FSAA_THRESHOLD_BYTES` (100 MB) + `shouldUseFSAA` / `isFSAASupported` for the File
System Access streaming path; `OPFS_TEMP_DIR` / `opfsTempDirSQL` / `isOPFSAvailable`;
`isCrossOriginIsolated` / `coiDiagnostic` (COOP/COEP threading);
`PINNED_DUCKDB_WASM_VERSION = '1.29.0'` + `XLSX_TRY_DUCKDB_NATIVE` + `isSafari`;
`MEMORY64_BLOCKED` / `assertMemory64Blocked`; the `QueryBatch` class + `queryBatch`
singleton (dedupes identical in-flight SQL, `run`/`pendingCount`/`clear`); and the
server-offload flags `SERVER_OFFLOAD_DEFAULT = false` / `isServerOffloadActive`
(gated by the `serverOffload` flag, **enabled: false**).

`loaders.js` owns file ingestion. `loadFile(file)` dispatches by extension:
CSV/TSV, JSON/NDJSON, Parquet, XLSX/XLS, Arrow/Feather (all through
`registerFileBuffer` + a `createTableFrom*`), PDF (delegated to the Cleaning Crew
profiler — see the cleaning area page), with SQLite explicitly rejected as
roadmap-only. It disambiguates same-stem filenames via `uniqueTableName`, hashes
raw bytes for the provenance chain BEFORE registering (`hashBytes` from
`provenance.js`), builds the dataset record, calls `addDataset`, and anchors a
`startProvenance` chain (surfacing dropped-row counts loudly). Excel uses DuckDB's
native `read_xlsx()` first and falls back to the bundled SheetJS `XLSX.read` /
`XLSX.utils.sheet_to_json` (per `XLSX_TRY_DUCKDB_NATIVE`).
`loadRowsAsDataset({name,columns,rows,source,meta})` ingests already-parsed rows
through the same path (used by Databricks + the OMOP/FHIR sample loaders).
Large-file helpers `loadLargeFileViaFSAA` / `pickLargeFileViaFSAA`. Golden-dataset
builders `buildGoldenDataset()` / `loadGoldenDataset()` fabricate the 100-row
self-test fixture with seeded issues (see the validation area page for how the
layers consume it).

## SQL editing

`sql-highlight.js` — zero-dependency, always-live SQL highlighter powering the
overlay behind `#sql-input`. `tokenizeSql(sql)` is a pure tokenizer whose
concatenated token values exactly reconstruct the input (keeps the overlay
glyph-aligned); `highlightSql(sql)` maps tokens to escaped `<span class="tok-*">`.
Keyword/function sets are `SQL_KEYWORDS` / `SQL_FUNCTIONS`. It also owns error
display: `formatSqlError(err)` → `{ kind, detail, hint, raw }` (splits the
"<Kind> Error:" prefix and adds targeted hints), and `renderSqlErrorHtml(err)`
builds the escaped error-card HTML.

`sql-dialect-adapter.js` — the **Polyglot Workbench (Batch A)** dialect translator
(flag `multiDialectSql`, **enabled: true**). Pure `translateDialectSql(sql,
dialect)` rewrites the concrete incompatibilities of five warehouse dialects into
DuckDB SQL; `duckdb` and any unknown dialect are no-op passthroughs.
`SUPPORTED_DIALECTS` (`duckdb, postgres, mysql, bigquery, snowflake, tsql`) drives
the picker. Critically, it MASKS single-quoted literals and comments
(`maskLiteralsAndComments` / `unmask`) before running its regex/`rewriteCall` rules
so a literal that merely looks like a dialect token is never corrupted. Per-dialect
transforms: Postgres `~*` → `regexp_matches(…,'i')`; MySQL backticks/`LIMIT
off,cnt`/`IFNULL`/`NOW()`; BigQuery FQ backtick tables/`SAFE_CAST`→`TRY_CAST`/
`CURRENT_TIMESTAMP()`→`now()`; Snowflake `IFF`→`CASE`/`DIV0`→safe-division `CASE`;
T-SQL `TOP n`→trailing `LIMIT`/`[bracket]` ids/`GETDATE()`/`ISNULL`.

## External connectors

`databricks-connect.js` — Databricks Direct-Connect (proof of concept, **no
flag**). Lets a user pull a read-only result from THEIR OWN workspace using THEIR
OWN personal access token, browser→Databricks directly (no DataGlow server; the
token lives in memory only for the call — the exact stance is fixed in the exported
`TRUST_NOTICE` string). DOM-free and engine-free: `fetch`, `loadRows`, and `sleep`
are all injected into the `DatabricksConnector` class for Node testability.
Exports the Statement Execution API surface: `STATES` / `isTerminalState`,
`ERRORS`, `normalizeHost`, `statementsUrl` / `statementUrl`, `buildExecuteRequest`
(inline JSON, `wait_timeout` + `on_wait_timeout: CONTINUE`), `buildPollRequest`,
`describeHttpError`, `stateFailureMessage`, `parseResultSet(payload)` →
`{columns, rows, truncated}`. `DatabricksConnector.run(...)` orchestrates
submit→poll→parse→ingest (via the injected `loadRows`, wired in main.js to
`loadRowsAsDataset`). `DEFAULT_QUERY` seeds the panel. Wired by
`initDatabricksConnect()` in main.js.

## Object Space

`object-space.js` — the **Polyglot Workbench (Batch B)** Object Space registry
(flag `objectSpaceRegistry`, **enabled: true**). A pure, in-memory read model of
the named objects living across the SQL/Python/R runtimes, so a single source of
truth answers "what named objects exist, where from, what shape?". It is the data
model behind the sidebar Object Space strip and is also consumed by Rooms and the
Query Sentinel Bridge — see those area pages; this page only documents the model,
not its consumers. `createObjectSpace()` returns
`{ register, get, getSchema, list, unregister, clear, size }`; entries are
`{ name, originLanguage('sql'|'python'|'r'), kind('dataframe'|'model'|'scalar'),
schema:[{name,type}], rowCount, provenance, createdAt }` (re-registering a name
updates in place, preserving the original `createdAt`). Closed sets
`ORIGIN_LANGUAGES` / `OBJECT_KINDS`. App-level singleton helpers:
`registerObject(descriptor)`, `listObjectSpace()`, `getAppObjectSpace()`. It is
passive — it does NOT replace the per-language JSON bridges or resolve
`FROM py.name` at query time (that is a separate batch).

## Glow guidance system

Four files, split model/renderer, that surface adaptive guidance. All ship
`enabled: true` today.

- `glow-path.js` (flag `glowPathRail`) — pure `computeGlowPathState(ctx)`: given
  caller-assembled fields (`datasetLoaded`, `hasValidated`, `validationSummary`,
  an OPTIONAL real `readinessGateResult`, `lastQueryRepeatCount`, `densityLevel`),
  returns the single most useful next action by documented first-match-wins
  priority: (1) load data, (2) run Validate, (3) agent-readiness block explained
  from the gate's OWN failing layers, (4) review warnings, (5) save a repeated
  query (mid/high density only), (6) nothing. Exports `DENSITY_LEVELS`,
  `CTA_ACTIONS`. Never re-runs validation; composes, never recomputes.
- `glow-path-ui.js` — presenter. `buildGlowPathBadgeModel(state)` (pure view-model)
  + `renderGlowPath({host, glowPathState, onCtaClick, onDismiss})` (dismissible
  rail into `#glow-path-host`; renders NOTHING when there is no message) +
  `createGlowPathDismissalStore()` (per-key in-memory dismissal).
- `glow/glow-signal.js` (flag `glowOrb`) — pure `computeGlowSignal(input)` composes
  the four existing real outputs (Readiness Gate verdict, Trust Strip fields,
  Golden Signals, CAT Scorecard) into one `{ status, score, signals[], nextAction,
  summary }` using the shared `ok/warn/bad/idle` vocabulary; the gate score is
  authoritative when present. `explainGlowSignal(result)` renders a multi-line
  string; also exports `GLOW_STATUS`.
- `glow/glow-orb-ui.js` — the topbar orb. `buildGlowOrbModel(glowResult)` (pure,
  reuses Trust Strip dot colors verbatim) + `renderGlowOrb({host, glowResult})`
  (a ~30px orb into `#glow-orb-host` with a click-to-expand panel + "Show the
  math" toggle). Wired by main.js's `renderGlowOrbWidget()`, which empties the host
  and returns if the flag flips off (safe kill-switch).

## Registries

`capability-registry.js` — the platform-aware module loader (**always live**). It
reads `capability-map.manifest.json` (the same source of truth the drift gate
validates), where each capability declares a `platforms` list, and dynamically
`import()`s only the modules whose platform list includes the detected runtime.
Pure helpers (Node-testable): `detectPlatform(win)` returns `'browser'` or
`'desktop'` (Tauri globals `__TAURI__` / `__TAURI_IPC__` / `__TAURI_INTERNALS__`);
`moduleKey(relFile)` is the basename minus dir/extension (the key passed to
`registry.get`); `isWorkerEntry(relFile)` matches `*.worker.js` files (listed but
never imported on the main thread); `buildRouting(manifest)` builds the
`file → {file,key,platforms:Set,capabilities}` table (a file's platform set is the
UNION across capabilities; `platformsByFile` overrides per file). `loadRegistry(
{manifest, manifestUrl, platform, importer})` (all injectable for tests) imports
the platform-appropriate `js/` modules — skipping worker entries, non-`js/` files,
and platform-mismatched modules — never letting a failed import break bootstrap.
The returned registry exposes `get(name)` (loaded namespace or `undefined` with a
clear warning distinguishing unknown / platform-restricted / failed-to-load),
`has(name)`, `available(name)`, `list()`, and `loadedCount`. Platform tokens:
`PLATFORM_BROWSER` / `PLATFORM_DESKTOP` / `PLATFORM_MOBILE` / `VALID_PLATFORMS`.

`metrics-registry.js` — the shared "define once" metrics registry (**always
live**; instances are keyed per dataset by state.js). A metric is a NAME bound to a
read-only SQL expression; the module never runs SQL. `createMetricsRegistry()`
returns `{ defineMetric, getMetric, hasMetric, listMetrics, removeMetric,
resolveMetricSql, fingerprint, size }`. Records are
`{ name, sqlExpression, unit, description, version, definedAt }` (monotonic
per-name `version`, bumped on `{overwrite:true}`). Validation is engine-free:
`validateMetricName` (SQL-identifier shape) and `validateSqlExpression` (rejects
empty/non-string, `;`, leading statement keywords, unbalanced parens, unterminated
string literals — a distinct `MetricError` is thrown). `resolveMetricSql(name,
{alias})` parenthesizes the expression (optionally `AS "name"`); `fingerprint`
lazily imports `sha256Hex` from `provenance.js`. Module-level
`expandMetricReferences(sql, registry)` expands `@metric` tokens against a registry
and returns `{ sql, used }` — this is the SQL-tab hook main.js calls.

## Navigation & focus

`tab-groups.js` (flag `groupedNavigation`, **enabled: true**) — pure, DOM-free
grouping for the tab bar. `buildTabGroups(tabOrder)` buckets ids into named modes
(`TAB_GROUP_ORDER = ['core','more']`, `TAB_GROUP_META` labels), preserving each
tab's relative order and never dropping/renaming an id — any unknown id falls into
`'more'`. `groupForTab(tabId)` returns a tab's group. Core 6: `preflight, sql,
clean, validate, nlsql, dvc`; everything else lands in `'more'`.

`validate-focus.js` (**always live**) — pure disclosure-state logic deciding
whether the Validate tab's "Advanced options" block starts open.
`shouldExpandAdvanced({hasRunOnce, wasManuallyExpanded})` returns a boolean;
`createValidateFocusStore()` is a per-dataset in-memory store
(`markRunOnce` / `markManuallyExpanded` / `markCollapsed` / `isExpanded`) so each
dataset starts collapsed independently. It never touches or gates the controls
inside the block.

## Tests

Matching files in `test/` (names only; do not run here):
`capability-registry.test.mjs`, `metrics-registry.test.mjs`, `object-space.test.mjs`,
`tab-groups.test.mjs`, `sql-dialect-adapter.test.mjs`, `databricks-connect.test.mjs`,
`glow-path.test.mjs`, `glow-signal.test.mjs`, `glow-orb-ui.test.mjs`,
`validate-focus.test.mjs`, `chore-duckdb-hardening.test.mjs`,
`csv-ignore-errors.test.mjs`, `command-deck-nav.test.mjs`,
`command-palette.test.mjs`, `capability-drift.test.mjs`, plus the Node
engine/loader harnesses `node-duckdb-engine.mjs` and `duckdb-loader-hook.mjs`.
(No dedicated `state`/`utils`/`sql-highlight`/`glow-path-ui` test file exists;
those are exercised indirectly through the harnesses and higher-level suites.)
