# R3 Capture + R4 Ship Pack — Result

Branch: `feature/r3-r4-capture-ship` (PR open, **DO NOT MERGE**, per SPEC).
Implements `R3_R4_CAPTURE_SHIP_SPEC.md`. R2 (mission picker) is explicitly
out of scope and was not touched.

## What was built

### R3 — Screenshot/proof capture (`js/capture/*`)

`js/capture/capture.js` is the pure engine (`window.DataGlowCapture`, no
DOM, no network call anywhere in the file):

- `CAPTURE_VERSION = 1`.
- `CAPTURE_STEPS` — the SPEC's seven fixed steps, in order: `home`,
  `loaded`, `validate`, `scout`, `prove`, `narrative`, `export`.
- `CUSTOM_STEP = 'custom'` for anything outside the fixed list.
- `CAPTURE_DB_NAME = 'dataglow-capture-v1'`, `CAPTURE_STORE_NAME =
  'captures'`, `CAPTURE_DB_VERSION = 1` — the IndexedDB naming contract the
  canvas UI persists to.
- `timestampStamp(date)` / `normalizeStep(rawStep)` /
  `buildCaptureFilename(rawStep, date)` — a sanitized `step_YYYYMMDD-HHMMSS`
  filename derived from local time; an unrecognized step falls back to a
  sanitized custom label instead of throwing.
- `buildCaptureRecord(input)` / `addCapture(list, record)` /
  `removeCapture(list, id)` — an in-memory per-session capture list; a
  malformed record (missing step or filename) is rejected rather than
  silently accepted.
- `captureStepCoverage(list)` — which of the seven steps already have at
  least one capture this session.
- `buildScreenshotManifest(list)` — the row shape the Ship Pack's
  `screenshots/` folder consumes.

`js/capture/data-glow-capture-canvas.js` is the canvas UI (self-contained
IIFE): a **"Capture step"** button and slide-in panel offering the seven
fixed steps plus a per-session coverage checkmark. `runCapture()` tries, in
order: `html2canvas` (if already present on the page), an already-active
native `ImageCapture` stream via `window._dgActiveCaptureStream` (this
module never itself prompts for screen-share permission), then an
always-succeeding canvas-drawn fallback card, so the button never dead-ends
regardless of what capture APIs happen to be available. Captures persist to
IndexedDB best-effort (the in-memory list is the session's source of truth
either way), and each capture gets a plain-anchor **Download** button. No
capture is ever uploaded anywhere. Exposes
`window.DataGlowCaptureCanvas = { isOpen, openPanel, closePanel, capture,
getCapturesForShipPack }`.

### R4 — Ship pack (`js/ship-pack/*`)

`js/ship-pack/ship-pack.js` is the pure engine
(`window.DataGlowShipPackEngine`, no DOM, no network):

- `SHIP_PACK_VERSION = 1`.
- `buildKeepersFile(keepersExport)` — passes through Question Scout's
  `buildKeepersExport()` output when present, or returns an **honest empty**
  `keepers.json` ("No Scout keepers were proposed or kept this session")
  when Scout was never used. Never fabricates a keeper.
- `claimFromReceiptEntry(entry)` / `buildClaimsFile(receiptEntries)` —
  reduces Proof Harness receipt-ledger entries to claim text, SQL, engine
  ids, and verdict, counted by verdict state (`GREEN`/`AMBER`/`RED`/other).
- `buildValidationSummaryFile(validationLayers)` — per-layer pass/warn/fail
  counts, or an honest "not available" when validation never ran.
- `buildHonestClaimsMarkdown(args)` — the SPEC's **"no pure-local
  overclaim"** requirement: a `## PROVEN` section built *only* from
  GREEN-verdict claims, a separate `## UNVERIFIED` section for Scout keepers
  with no matching receipt, an explicit *"Nothing in this pack is proven
  yet. Run Prove on a claim to add one."* line when there are zero GREEN
  receipts, a `## Validation status` section, and a footer stating the data
  never left the device.
- `buildShipPack(args)` / `serializeShipPackFiles(shipPack)` — assembles
  `keepers.json`, `claims.json`, `validation_summary.json`,
  `honest_claims.md`, and a `screenshots/manifest.json` (only when at least
  one capture exists) into one flat, MIME-typed file list. `buildShipPack({})`
  with zero inputs still produces the four core files, all honestly empty.

`js/ship-pack/data-glow-ship-pack-canvas.js` is the canvas UI: an
**"Export ship pack"** button/panel that discovers live state best-effort —
`window.DataGlowQuestionScoutCanvas.getKeepers()`,
`window.DataGlowProofHarness.getReceipts()`, a validation-summary lookup
with several fallback shapes, `window.DataGlowCaptureCanvas.getCapturesForShipPack()`
— each wrapped in its own try/catch so a missing surface degrades to the
engine's honest-empty shape rather than throwing. It builds the pack via the
pure engine and downloads it as a single `.zip` when `window.JSZip` happens
to be present, or as a sequence of individual file downloads otherwise.
Publishes **`window.DataGlowShipPack = { export: runExport, buildPreview,
getLastPack }`** — exactly the SPEC's requested public API,
`window.DataGlowShipPack.export()`.

Neither canvas UI file makes a network request of any kind (no `fetch`,
`XMLHttpRequest`, `WebSocket`, or `navigator.sendBeacon`), and no visible UI
string in either module uses an em dash.

## Canvas (authoritative)

`canvas/index.html` remains the single source of truth for the web surface.
All four modules above are inlined verbatim via `inject_r3_r4_capture_ship.py`
(modeled on the existing `inject_a49_question_scout.py` pattern), chained
after the Question Scout canvas module's closing marker. The script:

- Refuses to inject content containing a literal `</script>`, a control
  character, or an em dash (U+2014).
- Distinguishes real ES `export` statements from prose/object-literal text
  that merely contains the word "export", to avoid false-positive rewrites.
- Is idempotent — re-running it re-syncs the four blocks rather than
  duplicating them.

`canvas/integrity.manifest.json` tracks all four new modules with recorded
source/canvas-section hashes and byte counts, kept in sync via
`npm run check:canvas-integrity -- --update`.

```
$ npm run check:canvas-integrity
  ok  syntax: 3 inline <script> block(s) parsed
  ok  markers: 342 inlined module path(s) in canvas/index.html, 313 closing marker(s); tracked modules correctly paired
  ok  tracked: 74 module(s) verified against canvas/integrity.manifest.json
  ok  ship path: desktop stage script still stages index.html + js/
  ok  ship path: build.sh still guards canvas/index.html against a stale src/ rebuild
  ok  publish: canvas/index.html is the recorded 6535026 bytes
check-canvas-integrity: canvas bundle integrity OK
```

## Flags and capability map

- `flags.manifest.json` gained one new flag, **`captureShipPack`**
  (`enabled: true`, `addedInPR: "feature/r3-r4-capture-ship"`), gating both
  R3 and R4's canvas UI mounting. With the flag off, neither button/panel
  mounts in `canvas/index.html`; both pure engines remain independently
  evaluable and unit-tested since neither makes a DOM change itself. No
  other flag, engine, or panel is touched.
- `capability-map.manifest.json` gained one new capability, **`capture-ship-pack`**
  (kebab-case of the flag name, per the repo's `flagToCapabilityId()`
  convention), listing all four source files plus the test file, every
  exported symbol, `relatedFlags: ["captureShipPack"]`, and a derived
  `status: "shipped"`.

```
$ npm run check:capability-map
  ok  registry: 271 capability(ies) normalized to { id, title, status, relatedFlags, platforms }
  ok  status: 271 shipped, 0 behind-flag
  ok  flags: 178 declared, 111 capability(ies) flag-linked
check-capability-map: capability registry is honest against flags.manifest.json
```

## Tests

`test/r3-r4-capture-ship-pack.test.mjs` — **85 assertions, 0 failures**, no
framework (matches repo convention), covering:

1. `CAPTURE_STEPS` fixed order/count, `timestampStamp` (fixed date
   `2026-07-27 05:38:09` local → `20260727-053809`), `normalizeStep`
   case-insensitivity and null/undefined handling, `buildCaptureFilename`
   sanitization.
2. `buildCaptureRecord` shape, `addCapture`/`removeCapture`, malformed
   record rejection, `captureStepCoverage`, `buildScreenshotManifest`.
3. `buildKeepersFile` passthrough + honest empty state.
4. `claimFromReceiptEntry`/`buildClaimsFile` from mock receipt-ledger
   entries, including mixed GREEN/RED verdict counting and a corroborating
   engine id.
5. `buildValidationSummaryFile` empty and populated (PASS/WARN/FAIL) cases.
6. `buildHonestClaimsMarkdown` — PROVEN section includes only GREEN claims,
   UNVERIFIED section includes un-proven keepers, the critical "nothing
   proven yet" case with zero GREEN receipts, and no em dash.
7. `buildShipPack`/`serializeShipPackFiles` full assembly (including the
   zero-input case) and MIME-type/JSON-validity checks on every file.
8. Canvas-authoritative checks: all four modules are inlined with correct
   markers; `window.DataGlowCapture`, `window.DataGlowShipPackEngine`, and
   `window.DataGlowShipPack` are published; a regex check confirms
   `window.DataGlowShipPack` wires `export: runExport`.
9. Flag gating: `captureShipPack` is declared `enabled: true`; the canvas UI
   checks `DataGlowFlags.isEnabled('captureShipPack')`.
10. No-network-upload: neither canvas UI file references `fetch(`,
    `XMLHttpRequest`, `WebSocket`, or `navigator.sendBeacon(`.
11. No em dash (U+2014) anywhere in either canvas UI source file.

Run with `npm run test:r3r4captureship` or
`node test/r3-r4-capture-ship-pack.test.mjs`.

Also verified green on this branch: `npm run check:canvas-integrity` and
`npm run check:capability-map` (both shown above).

## Files changed

- `js/capture/capture.js` (new)
- `js/capture/data-glow-capture-canvas.js` (new)
- `js/ship-pack/ship-pack.js` (new)
- `js/ship-pack/data-glow-ship-pack-canvas.js` (new)
- `inject_r3_r4_capture_ship.py` (new)
- `test/r3-r4-capture-ship-pack.test.mjs` (new)
- `canvas/index.html` (modified — four new modules inlined)
- `canvas/integrity.manifest.json` (modified — four new tracked entries)
- `flags.manifest.json` (modified — new `captureShipPack` flag)
- `capability-map.manifest.json` (modified — new `capture-ship-pack` capability)
- `package.json` (modified — new `test:r3r4captureship` script)

## Scope notes

- R2 (mission picker) was explicitly skipped per the SPEC/ship instructions.
- This PR is marked **DO NOT MERGE** and must not be merged; it is opened
  for review only.
