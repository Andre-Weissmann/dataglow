# Capability detail — Simulation & time travel

Companion to the **Simulation & time travel** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the What-If digital twin, Time-Travel Diff, or the Data Time Machine snapshot
ledger; the index alone is enough for most tasks.

## Shape of the area

Three modules under `js/simulation/` that let an analyst explore *alternate* and
*historical* states of a dataset without ever touching the real one. All keep pure,
Node-testable logic separate from the DOM/engine/IndexedDB shell:
1. **Digital Twin / What-If Simulator** (`digital-twin.js`) — perturb an in-memory
   copy with sliders and re-run the validation suite against the copy.
2. **Time-Travel Diff** (`time-travel-diff.js`) — load a second dataset and diff it
   against the current one at row, layer, and distribution level.
3. **Data Time Machine** (`time-machine.js`) — an explicit, persistent snapshot
   ledger built on the diff logic.

## Distinction from Open Floor's Sandbox Twin

`js/simulation/sandbox-twin.js` is a **different** file — the agent-facing,
firewall-gated forkable twin — documented under
[`open-floor.md`](open-floor.md) behind the `openFloorSandboxTwin` flag
(`enabled: false`). It *reuses* `perturbRows` (from `digital-twin.js`) and
`diffRows`/`detectKeyColumn` (from `time-travel-diff.js`) but owns no diffing/twin
math of its own; do not re-document it here.

## Flag / gating state — no feature flags; core, DOM-gated

None of these three has a `flags.manifest.json` flag (the only "twin" match is
`openFloorSandboxTwin`, for the different file above). All three are registry-loaded
(`registry.get('time-travel-diff'|'time-machine'|'digital-twin')`, main.js
~9409-9413) and **init'd unconditionally** (`initTimeTravelDiff` 9316,
`initTimeMachine` 9318, `initDigitalTwin` 9322) — each returns early if its DOM
anchor is absent (e.g. `#btn-twin-reset`, `#diff-file-input`), so they're core tabs
gated only by markup presence, not a flag. The Time Machine's persistence layer
additionally no-ops gracefully when IndexedDB is unavailable.

## `js/simulation/digital-twin.js` — the What-If simulator

Pure (no DOM/DuckDB). The UI feeds it live rows, applies the returned perturbed
rows to a throwaway `__twin_sim` table, and re-runs `runAllLayers()` against that
copy — reusing the entire existing validation pipeline.
- **Hard isolation guarantee:** `perturbRows(rows, columns, knobs, { seed })`
  **never mutates its inputs** — it spreads every row before touching a cell (a
  unit test asserts inputs are byte-for-byte identical afterward). Uses a seeded
  `mulberry32` PRNG so a given seed + knob set is reproducible; `pickIndices` is a
  partial Fisher-Yates for a well-spread selection.
- **Perturbation families:** missing-value injection (any column, sets `null`),
  outlier injection (numeric only — a spike `scale*1000 + 1e6` far outside any
  fence), category drift/mislabelling (categorical only — appends a `_drift`
  suffix the Categorical Consistency Engine will cluster), and global row
  duplication. Returns `{ rows, columns, manifest }` where `manifest.applied[]`
  records each change.
- `inferPerturbations(cols, { maxPerKind = 4 })` — derives dataset-specific sliders
  from column *type* (never hardcoded names), capped per family. `isNumericType`,
  `isCategoricalCol` classify; `hasActivePerturbation(knobs)` gates the
  "baseline" display.
- `gradeDelta(baselineGrade, simulatedGrade)` — signed A-F distance
  (`GRADE_ORDER`) for the before/after arrow (raw grades always shown too).

## `js/simulation/time-travel-diff.js` — two-version diff

Row/layer diffing is pure; the distributional diff is engine-backed but reuses
layer 18's exported logic (imports `computeDistributionFingerprint`,
`compareDistributions` from `../validation/validation.js`) so "drift" has one
source of truth.
- `detectKeyColumn(columns, rows)` — prefers an id-like fully-unique column, else
  the first fully-unique column, else null.
- `diffRows(rowsA, rowsB, keyCol)` → `{ keyColumn, added, removed, changed[],
  unchanged, countA, countB }`; `changed` carries per-field `{ column, from, to }`.
  Values compared as strings via `valuesEqual` (null-safe).
- `diffLayerStatuses(resultsA, resultsB)` → which validation layers flip status
  between the two runs, flagging true PASS↔FAIL flips (`passFailFlip`).
- `diffDistributions(tableA, tableB, cols)` → async; fingerprints both tables and
  returns the layer-18 comparator's drift strings + both fingerprints.

## `js/simulation/time-machine.js` — persistent snapshot ledger

Extends Time-Travel Diff: explicit "Save Snapshot" (never automatic per query).
Pure logic + a thin IndexedDB wrapper; reuses `detectKeyColumn`/`diffRows` from
`time-travel-diff.js` for its diff summaries.
- **Pure:** `canonicalize(columns, rows)` (deterministic serialization);
  `contentHash` (FNV-1a 64-bit via two 32-bit halves, hex — a content fingerprint,
  not security); `summarizeDiffFromPrevious(...)` (column-set + row-count deltas +
  key-based row diff); `buildSnapshot({ datasetName, columns, rows, previous,
  label, now, embedRows })` → a `dataglow-snapshot` record (embeds rows only when
  budget permits); `buildArchive`/`exportArchive`/`parseArchive` for prune-to-file.
- **Browser-only IndexedDB** (`dataglow_timemachine` v1, store `snapshots`, indices
  `byDataset`/`byTimestamp`): `initTimeMachine`, `saveSnapshot`, `listSnapshots`,
  `getSnapshot`, `deleteSnapshot`, `latestSnapshot`. `checkStorageQuota()` warns at
  `ratio ≥ 0.85` *before* a quota write fails.

## UI wiring (main.js)

`timeMachine` (129), `digitalTwin` (133), `timeTravel` registry handles. Time-Travel
Diff: `initTimeTravelDiff` (5321), `diffRows` (5367). Time Machine: `initTimeMachine`
(5572), `listSnapshots`/`checkStorageQuota`/`latestSnapshot`/`buildSnapshot`/
`saveSnapshot`/`exportArchive` (5582-5649). Digital Twin: `renderTwinComparison`
(8863), `renderTwinControls` (8906), `perturbRows` (8840), `gradeDelta` (8868),
`inferPerturbations` (8910), `initDigitalTwin` (8970).

## Tests

- `test/digital-twin.test.mjs` — perturbation families, seeded reproducibility, and
  the input-immutability guarantee.
- `test/synthetic-twin-time-machine-suite.test.mjs` — snapshot hashing/diff/archive
  and time-machine behavior (shared with synthetic/fingerprint coverage).
- `test/sandbox-twin.test.mjs` — belongs to the *Open Floor* sandbox twin, not this
  area.

## Related but not in scope

- `js/validation/validation.js` (Distributional Fingerprint Drift, `runAllLayers`)
  — the pipeline the twin re-runs and the diff reuses; see
  [`validation-layers.md`](validation-layers.md).
- `js/simulation/sandbox-twin.js` + the Agent Action Firewall — see
  [`open-floor.md`](open-floor.md).
- The Confidence-Calibrated Grades the twin compares before/after —
  [`grades-and-health-scores.md`](grades-and-health-scores.md).
