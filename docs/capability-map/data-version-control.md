# Capability detail — Data Version Control

Companion to the **Data Version Control** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
inside the DVC snapshot/diff feature (Phase 10); the index alone is enough for most tasks.

## How the feature is shaped

Three modules under `js/dvc/`, split store → diff → UI:

- `js/dvc/dvc-store.js` — the snapshot registry (data + math).
- `js/dvc/dvc-diff.js` — the pure diff engine over two snapshots.
- `js/dvc/dvc-ui.js` — the "Versions" tab that mounts store + diff into the DOM.

**Privacy invariant, stated in all three files:** snapshots store *schema + per-column
statistics only, never row data*. This keeps the store lightweight and safe to
export/share without exposing PHI.

## The store — `dvc-store.js`

`DVCStore` is an in-memory registry backed by a `Map<string, Snapshot>`. A module
singleton `dvcStore` is exported and used app-wide; the class is also exported so
imports can build isolated stores.

A `Snapshot` (JSDoc typedef) is `{ id, datasetName, label, createdAt, rowCount,
fingerprint, cols, meta }`, where `cols` is a `ColStats[]`. `ColStats` is
`{ name, type, rawType, nullCount, distinctCount, min, max, mean, stddev }` — `type`
is a normalized group (`number|text|date|boolean|other`) and `rawType` is the original
DuckDB type string. Numeric aggregates (`min/max/mean/stddev`) are `null` for
non-numeric columns.

Stat extraction:
- `typeGroup(rawType)` normalizes a DuckDB type string to a group (mirrors
  `schema-context.js` for consistency).
- `extractColStats(colName, rawType, rows)` walks the rows once, counting nulls
  (treating `null`/`undefined`/`''` as null), collecting distinct values in a `Set`,
  and computing `min/max/mean/stddev` for numeric columns. Mean/stddev are rounded to
  4 decimals to keep fingerprints stable.
- `statsFromDataset(dataset)` normalizes multiple dataset shapes (`{columns, rows}`,
  `{columns, data}` row-major arrays, or a bare rows array) into `{ rowCount, cols }`.

Fingerprinting: `fingerprintSnapshot` (internal) builds a signature string from
`rowCount` plus each column's `name:type:nullCount:distinctCount:min:max:mean`, then
hashes it with a non-crypto FNV-1a-style `simpleHash` into an 8-char hex string. IDs
come from `genId()` (`snap_<base36 ts>_<rand>`).

Store API: `snapshot(dataset, opts)` (returns id), `get(id)`, `list(datasetName?)`
(newest-first by `createdAt`), `remove(id)`, `relabel(id, label)`, `count(datasetName?)`,
`findDuplicates(id)` (same-fingerprint siblings), and `rollbackMeta(id)` — which returns
the schema/stats only. **Rollback is advisory**: the store holds no row data, so it tells
you *what* the data looked like, not the raw rows. Export/import: `exportJSON()` (portable
blob, no row data), static `DVCStore.fromJSON(json)`, and `merge(other)` (union by id).
Convenience: `snapshotIfChanged(dataset, opts)` (skips if fingerprint matches the latest
snapshot, returns `null`) and `timeline(datasetName)` (oldest-first). `DVC_VERSION` is
`'1.0.0'` and is stamped into exports as `_dvcVersion`.

## The diff engine — `dvc-diff.js`

Pure functions over two `Snapshot` objects; **no row data is ever accessed**. Two enums:
`RISK` (`ok`/`warn`/`breaking`) and `SCHEMA_CHANGE` (`added`/`removed`/`type_changed`/`unchanged`).

- `diffSchema(before, after)` → `{ added, removed, typeChanged, unchanged, risk }` by
  comparing column name maps. Risk: removed **or** type-changed ⇒ `BREAKING`; only added
  ⇒ `WARN`; otherwise `OK`.
- `diffCol(before, after, rowsBefore, rowsAfter)` → a `ColDiff` with null-count/rate deltas,
  distinct delta, and (numeric only) mean/min/max deltas, plus a `risk` and human-readable
  `flags[]`. Thresholds: null-rate up >5% ⇒ WARN, >20% ⇒ BREAKING; null-rate down >5% ⇒
  WARN; `distinctCount` collapsing to 1 (was >1) or 0 ⇒ BREAKING; relative mean shift >20%
  ⇒ WARN, >50% ⇒ BREAKING.
- `diffSnapshots(before, after)` (throws if either is missing) is the top-level entry. It
  runs `diffSchema`, diffs only columns present in **both** snapshots via `diffCol`, computes
  row-count delta/percent, rolls up an `overallRisk` (BREAKING short-circuits), and builds a
  human `summary[]`. Return shape: `{ beforeId, afterId, beforeLabel, afterLabel, datasetName,
  rowCountBefore, rowCountAfter, rowCountDelta, rowCountPct, schema, colDiffs, overallRisk,
  summary }`.

Formatters: `summarizeDiff(diff)` → compact multi-line text (for toasts/notifications) and
`diffToHTML(diff)` → an HTML fragment (risk badge, row delta, schema changes, flagged-column
stats) consumed by the UI. Internal helpers `pct`, `fmt`, `esc` stay module-private.

## The UI — `dvc-ui.js`

Single export `mountDVCUI({ host, datasets, getActiveDataset, onSnapshot, onRollback, onToast })`,
which injects a one-time `<style>` block (`#dvc-styles`) and renders the "Versions" tab into
`host`. Unlike the convergence/room UIs, the pure model-building here lives in `dvc-store.js`
and `dvc-diff.js`; this file is essentially the **renderer** — small pure HTML builders
(`renderSnapCard`, `renderDiffPanel`, `renderInfoPanel`, plus format helpers `riskBadge`,
`deltaClass`, `deltaStr`, `fmtTime`, `fmtNum`, `esc`) driven by a single `render()` and
delegated `attachHandlers()`.

It renders: a toolbar (dataset selector, **+ Snapshot now**, **Export**, **Import** with a
hidden file input); a newest-first timeline of snapshot cards (fingerprint, editable label,
time, row/col/dataset meta, and per-card actions **Diff A / Diff B / Info / Rename / Rollback /
Delete**); a diff panel that appears when both `diffSnapA` and `diffSnapB` are selected
(renders `diffToHTML(diff)` plus a per-column delta table); and an info panel showing a
snapshot's full `ColStats` table. All interactive elements carry `data-testid` attributes.
Snapshot creation calls `dvcStore.snapshot(getActiveDataset())`; export uses `dvcStore.exportJSON()`
via a Blob download; import reads a file and `dvcStore.merge(DVCStore.fromJSON(...))`; rollback
calls `dvcStore.rollbackMeta(id)` and hands the meta to the `onRollback` callback. Returns a
`{ refresh }` handle so the host can re-render when datasets change.

## Wiring in `main.js`

`js/app-shell/main.js` imports `mountDVCUI` (line ~153) and registers the tab as
`dvc: { label: 'Versions', icon: 'git-branch' }`. `renderDVCTab()` (line ~8087) mounts into
`#dvc-body`, passing `state.datasets`, a `getActiveDataset` closure resolving `state.activeDataset`,
and `onSnapshot`/`onRollback`/`onToast` handlers (rollback is advisory — its toast tells the user
to reload the original file to restore). `switchTab` calls `renderDVCTab()` for `tabId === 'dvc'`.
Both `renderDVCTab` and the tab-bar filter guard on `isEnabled('dataVersionControl')`.

## Gating flag

`dataVersionControl` in `flags.manifest.json` — `"enabled": true`. Despite the code comment
labeling the tab "ships dark behind the dataVersionControl flag," the manifest currently has the
flag **ON**, so the Versions tab is **live**. (`addedInPR: feature/phase10-dvc`.)

## Tests

- `test/phase10-dvc.test.mjs` — Node-runnable (no DOM/DuckDB), covers `dvc-store.js` and
  `dvc-diff.js` (`DVCStore`, `typeGroup`, `extractColStats`, `statsFromDataset`, `diffSchema`,
  `diffCol`, `diffSnapshots`, `summarizeDiff`, `diffToHTML`, `RISK`, `SCHEMA_CHANGE`). No test
  exercises `dvc-ui.js` directly (it is DOM-bound).

## Related but out of scope

- `js/nl-sql/schema-context.js` — `typeGroup` here intentionally mirrors that module's type
  normalization; keep them consistent.
- `js/app-shell/main.js` — tab registration, flag gating, and callback wiring (above).
- `flags.manifest.json` — the `dataVersionControl` flag entry.
