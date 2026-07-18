# Capability detail — Ambient & real-time

Companion to the **Ambient & real-time** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on live-as-you-type checks, the Watch Folder path, or the drift watchdog; the
index alone is enough for most tasks.

## Shape of the area

Three modules under `js/ambient/`, all sharing one **empowerment constraint**:
they observe and advise, but never modify, block, or "fix" anything, and never
touch the network. Each splits pure, Node-testable logic from its runtime shell
(a Web Worker, a poll loop, an in-memory dedup map) so the checks can be unit-
tested without a browser.

## Flag / registry state

- The `ambient` capability (id `ambient`, name **"Live validation"** in
  `capability-map.manifest.json`) covers `ambient-validation.worker.js` +
  `watch-folder.js` and has **no feature flag** — it is gated by the
  **platform-aware capability registry** (`platforms: ["browser","desktop"]`,
  with a `platformsByFile` override pinning `watch-folder.js` to `browser` only,
  since the File System Access API is Chromium-browser-only).
- `ambient-validation.worker.js` is a `.worker.js` file: the registry's
  `isWorkerEntry` skips it (importing it on the main thread would evaluate
  worker-only globals), so it is listed but never imported — `main.js` spins it up
  directly via `new Worker(new URL('../ambient/ambient-validation.worker.js', …))`.
- `drift-watchdog.js` is gated by the **`semanticDriftWatchdog`** flag,
  `enabled: true` (**promoted** — `promotedInPR: feat/enable-remaining-ready-flags-v2`).
  Turning it off restores the prior re-nag-on-every-poll behavior exactly.

## `js/ambient/ambient-validation.worker.js` — as-you-type SQL checks

A cheap, purely **syntactic** subset of the validation suite (NOT the full
20-layer run — far too expensive per keystroke), reading query text + known
column schema off the main thread. All check functions are pure and exported for
Node tests; the `self.onmessage` wiring at the bottom only activates in a real
Worker (`self instanceof WorkerGlobalScope`).
- `runAmbientChecks(sql, options)` — the orchestrator: runs all three checks and
  de-dupes by `id|column|message`. Empty/blank SQL → `[]`.
- `checkSensitiveGrouping` — flags a `GROUP BY` on, or a value-collapsing
  transform (`SUBSTR`/`UPPER`/`CASE`/… via `COLLAPSING_FN`) of, a protected
  column (`isSensitiveCategory` from `../validation/categorical-consistency.js`).
  With a schema it only flags columns that actually exist; without one it falls
  back to name matching so it still works before a dataset loads.
  `extractGroupByColumns` handles quoted/dotted idents and ignores positional
  `GROUP BY 1`.
- `checkCrossColumnLogic` — flags a `WHERE`/`HAVING` comparison that selects
  logically impossible rows (`end < start`, `max < min`) via the
  `START_KW`/`END_KW`/`MIN_KW`/`MAX_KW` keyword families.
- `checkSanityAnchor` — `SUM`/`COUNT`/`AVG` across a `JOIN` without `DISTINCT`
  can inflate totals by fan-out. When `options.schema` (the
  `{ tables: { name: { columns, rowCount, approxDistinct } } }` shape the Local
  Analysis Contract's `buildSchemaIndex` consumes) carries distinct-count stats,
  `statsAwareSanityAnchor` names the real culprit column + its uniqueness % and
  stays silent when `GROUP BY` is already at the many-side grain; without usable
  stats it falls back to the blunt "join + aggregate, no DISTINCT" flag.
- `stripLiteralsAndComments`/`stripQuotes` keep the crude clause parsing from
  tripping over string literals, comments, or quoted identifiers.

Wiring: `ensureAmbientWorker()` (main.js ~2524) lazily constructs the worker;
`scheduleAmbientCheck` is an 800 ms debounce that posts `{ requestId, sql,
columns }` on each keystroke and drops stale results by `requestId`. Leaving the
SQL tab terminates the worker (`teardownAmbientWorker`). Any worker error is
swallowed so typing never breaks.

## `js/ambient/watch-folder.js` — Watch Folder mode

Point DataGlow at a local folder (File System Access API) and dropped/changed
files auto-run through the **existing** validation pipeline — zero network, only
local reads + in-browser DuckDB-WASM.
- Pure helpers: `SUPPORTED_EXTENSIONS` (mirrors the upload accept list),
  `fileExtension`/`isSupportedFile`, `fileSignature(meta)` (`size:mtime`),
  `hasFileChanged`, and `diffEntries(prevMap, entries)` → `{ changed, next }`
  (new/modified supported files only). `directoryPickerSupported(scope)` feature-
  detects; `UNSUPPORTED_MESSAGE`/`PRIVACY_NOTICE` are shared UI copy.
- `class WatchFolderController({ ingestAndValidate, intervalMs = 4000,
  scheduler })` owns the poll loop and contains **no** validation logic of its
  own — production injects `ingestAndValidate` wired to the real
  `loaders.loadFile` + `validation.runAllLayers`; tests inject a spy. There is no
  native "changed" event for a directory handle, so it polls and diffs each
  enumeration. `start`/`stop`/`poll` with an overlap guard; permission loss or a
  moved folder → graceful `stop()` + `onError` (never an unhandled throw per
  tick). `scheduler` is injectable for deterministic tests.

Wiring: `initWatchFolder()` (main.js ~9066) degrades gracefully when the module
isn't loaded (desktop shell) or the picker is unsupported; `watchIngestAndValidate`
(~9041) is the injected callback that loads + validates and (when the flag is on)
runs the drift watchdog. `window.__dataglowStartWatch` is a headless test hook.

## `js/ambient/drift-watchdog.js` — Semantic Drift Watchdog

Pure, dependency-free presentation + de-duplication over the **existing**
`distribution_drift` validation result — computes **no** new statistics.
- `summarizeDriftEvent(drift)` → `{ severity: 'pass'|'warn'|'fail', headline,
  lines[] }`, pulling `drift.drifts` and `drift.forecast.flags[].message`; a
  missing/malformed drift object degrades to a silent pass.
- `alertFingerprint(summary)` — a stable content hash (`severity::sorted-lines`)
  so the same drift re-surfacing on the next poll is recognized as "already told
  them" rather than re-nagging.
- `class DriftWatchdog` — `observe(fileName, drift)` → `{ summary, isNew,
  shouldNotify }`; `shouldNotify` is true only when severity is warn/fail with a
  line AND the fingerprint differs from this file's last. `clear(fileName)`
  re-arms one file; `clearAll()` resets. In-memory, session-scoped, no persistence.
- `formatWatchdogAlert(fileName, decision)` → a one-line toast/log string.

Wired into `watchIngestAndValidate` (main.js ~9050) behind `semanticDriftWatchdog`;
`driftWatchdog.clearAll()` runs on each fresh folder connect. The watchdog is
informational only — wrapped in try/catch so it never blocks ingest.

## Scope note — native (Tauri) file-event trigger is out of scope

The watchdog is deliberately **trigger-agnostic**: today only the browser Watch
Folder poll loop calls it. A native OS-level filesystem-event trigger for the
desktop shell is a tracked follow-up (see `docs/tech-debt-tracker.md`), not part
of this area — whatever calls it just hands it the same `distribution_drift`
result shape `validation.js` already produces.

## Related but not in scope

- `js/validation/validation.js`'s `distribution_drift` layer and
  `js/drift/drift-forecast.js` produce the results the watchdog *presents* — see
  [`validation-layers.md`](validation-layers.md). The *temporal* drift slice is
  in [`data-quality-and-drift.md`](data-quality-and-drift.md).
- `js/validation/categorical-consistency.js` supplies `isSensitiveCategory`;
  `js/validation/analysis-contract.js` owns the non-ambient schema-hallucination
  checks and shares the schema shape `checkSanityAnchor` consumes.

## Tests

- `test/ambient-validation.test.mjs` — the three pure check functions.
- `test/watch-folder.test.mjs` — diff logic + controller delegation via injected
  spy/scheduler; `test/watch-folder-e2e.test.mjs` — the end-to-end poll path.
- `test/drift-watchdog.test.mjs` — summarize/fingerprint/dedup.
- `test/e2e-ambient-slm.test.mjs` — an ambient end-to-end suite.
