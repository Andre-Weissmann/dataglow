# R1 Project Run: result

Implements `R1_PROJECT_RUN_SPEC.md` on branch `feature/r1-project-run`, opened as
a **DO NOT MERGE** pull request per the task instructions. `canvas/index.html`
is authoritative; this feature is inlined into it the same way every other
canvas feature is, via `inject_r1_project_run.py`.

## What shipped

**In-app guided spine**: Ingest, Purpose, Validate, Scout, Prove, Narrate,
Export. Not external chat orchestration, exactly as the SPEC requires.

### Pure engine, `js/spine/project-run.js` (`window.DataGlowProjectRun`)

- `PROJECT_RUN_STEPS`: the seven fixed steps in order, each with `id`,
  `ordinal`, `title`, `oneLine`, `doneWhen`, and an `opens` intent id the
  canvas UI resolves against whatever is actually mounted in this build.
- `buildProjectRun({ stored, observed })`: derives each step's status
  (`todo` / `doing` / `done` / `blocked`) from caller-observed facts (a table
  loaded, the purpose contract signed, a validation surface viewed, at least
  one Scout keeper kept, at least one GREEN Proof Harness verdict, a
  narrative draft, an export confirmed). Auto-advances the first not-done,
  not-blocked step to `doing`; there is always at most one active step.
  `blocked` is never inferred from signals, only set by an explicit manual
  override, since nothing in this app fires an event that honestly means
  "the user is stuck."
- `hashDatasetKey()` / `storageKeyForDataset()`: a deterministic
  (FNV-1a, 32-bit, hex-encoded, explicitly **not** cryptographic)
  per-dataset-name hash, so the checklist for `claims_2026.csv` persists
  independently from `roster.xlsx` in the same browser.
- `normalizeStoredStatuses()` / `toStoredStatuses()` / `setManualStatus()`:
  never-throw persistence helpers that round-trip a `{ [stepId]: status }`
  map, defaulting a corrupted or missing value to `todo` rather than
  crashing the panel.
- `nextStep()` / `projectRunChipLabel()`: convenience read helpers for the
  canvas UI's "what's next" and collapsed-chip label.

No DOM, no timers, no network, no direct `localStorage` calls in this file ,
the canvas surface owns all browser-only I/O, the same split every other
spine/engine pair in this repo uses.

### Canvas UI, `js/spine/data-glow-project-run-canvas.js` (`window.DataGlowProjectRunUI`)

- A right-side slide-in drawer (distinct from the RECEIPT spine's bottom
  rail, since that rail already owns the bottom of the page) listing all
  seven steps with a status badge, a one-line "what this step means," and
  two actions per step: **Take me there** (resolves to a real mounted
  surface, Purpose Contract, Question Scout, Proof Harness, Story/Narrate,
  export, or renders plain text when that surface is not present in this
  build, the same "a button that opens nothing is worse than a sentence"
  discipline the RECEIPT spine already established) and **Mark
  blocked / Unblock**.
- A floating reopen chip once the drawer has been dismissed.
- Persists the checklist to `localStorage` under
  `dataglow.projectRun.<hash>`, re-observing the page on a 4-second interval
  while the drawer is open so status tracks reality rather than a stale
  snapshot from when it was opened.
- **Entry point**: claims the bottom mobile nav's Projects tab
  (`#dg-tab-projects`, `onclick="openProjects()"`). Before this change,
  `openProjects` was a genuinely dead global, never defined anywhere in
  `canvas/index.html`, confirmed by a full-file search before writing a
  single line of this feature. The module defines
  `window.openProjects` **only if nothing else already has**
  (`if (typeof window.openProjects !== 'function') { ... }`), so a future
  feature that legitimately wants that name is never silently clobbered by
  this one, and turning the `projectRun` flag off leaves `window.openProjects`
  exactly as undefined as it was before this PR.
- **Post-load spotlight**: exposes `recordSignal(name)` on the public API so
  a future spotlight hook can manually record a signal
  (`purposeSigned` / `validationViewed` / `keepersCount` / `proveGreenCount` /
  `narrativeDraft` / `exportDone`); it also listens for the real
  `dataglow:dataset-loaded`, `dataglow:contract-signed`,
  `dataglow:export-triggered`, and `dataglow:proof-harness-prefill` events
  already fired elsewhere in the app, so most signals are observed for free
  without any other module needing to change.
- Explicitly does **not** touch the separate, pre-existing "Projects"
  dataset-workspace panel (`#projects-panel`, `window.ProjectEngine`, opened
  by `#projects-trigger-btn`), a different feature (per-project dataset
  grouping, OPFS-backed) that this module does not rename, hide, or replace.

### Flag

`projectRun` registered in `flags.manifest.json`, default **on**. With the
flag off: the drawer, its reopen chip, and the `window.openProjects`
assignment never happen; the bottom-nav Projects tap stays exactly the
no-op it already was; no `dataglow.projectRun.` localStorage key is ever
read or written. The pure engine can still be imported and unit-tested
since it makes no DOM change of its own.

### canvas/index.html (AUTHORITATIVE)

Both files are inlined via `inject_r1_project_run.py`, following the
repo's `/* ---- from <path> ---- */` … `/* ---- end <path> ---- */`
marker convention, each appearing exactly once. Verified with
`node scripts/check-canvas-integrity.mjs` (syntax, marker pairing, tracked
source/canvas hash match, ship-path guard, and whole-file byte count all
pass). Both new files are registered in `canvas/integrity.manifest.json`'s
`tracked` list.

### Docs

- `capability-map.manifest.json`: new `project-run` capability
  (`files`, `symbols`, `relatedFlags: ["projectRun"]`, `status: "shipped"`),
  verified against `flags.manifest.json` via `npm run check:capability-map`.
- `docs/capability-map.md`: new "Project Run (R1)" section describing the
  pure engine, canvas UI, flag-off behavior, and test coverage.
- `docs/CHANGELOG.md`: one-line entry appended under the `Unreleased`
  section's `NEW-ENTRIES-BELOW` marker.
- `node .github/scripts/capability-drift.mjs` reports **zero** drift
  findings against this feature's two files (an unrelated, pre-existing
  finding about a different in-flight feature's own missing docs section is
  not part of this change and not touched by it).

### Tests, `test/r1-project-run.test.mjs`

`node --test test/r1-project-run.test.mjs`, **45 passed, 0 failed**.
Covers:

- The seven fixed steps' shape, order, and frozen-ness.
- `hashDatasetKey()` determinism and never-throw behavior on non-string
  input; `storageKeyForDataset()`'s prefix, stability, "untitled" fallback,
  and per-dataset independence.
- `normalizeStoredStatuses()`'s never-throw defaulting on `null`,
  `undefined`, and malformed input.
- `buildProjectRun()`'s auto-advance ordering (exactly one `doing` step at a
  time), the `scout`/`prove` threshold signals (`keepersCount >= 1`,
  `proveGreenCount >= 1`), a fully-observed run reaching `complete: true`,
  a manually blocked step staying blocked and being skipped when picking
  the next `doing` step, and that `blocked` is never inferred automatically.
- `toStoredStatuses()` / `setManualStatus()`'s persistence round trip,
  including no-mutation-of-input and rejection of unknown step ids/statuses.
- `nextStep()` / `projectRunChipLabel()`'s read helpers and never-throw
  behavior.
- The `DataGlowProjectRun` namespace object matching every named export.
- `canvas/index.html` inlining exactly once per file, in the correct order,
  with paired markers.
- The `window.openProjects` no-clobber guard, and that the bottom nav still
  calls `openProjects()`.
- The `projectRun` flag's required shape in `flags.manifest.json`.
- An em-dash sweep over both new source files, the flag's
  description/flagOffBehavior text, and the inlined canvas sections.
- Engine-module purity (no direct `localStorage`/`document`/`fetch` calls)
  and a check that the `'export':` object key inside `doneSignal` stays
  quoted so it can never again be mistaken for a stray ESM export statement
  by the injector's own guard.

## No em dash in visible UI

Verified by the test suite's em-dash sweep (`\u2014`) over
`js/spine/project-run.js`, `js/spine/data-glow-project-run-canvas.js`, the
`projectRun` flag text, and the inlined canvas sections for both files. Also
verified manually with `grep` before injection.

## Notes for reviewers

This branch was built directly against a live, shared workspace where a
second, unrelated in-flight change (`R3_R4_CAPTURE_SHIP_SPEC.md`, flag
`captureShipPack`) was being developed concurrently in the same working
tree. `flags.manifest.json`, `canvas/index.html`, and
`canvas/integrity.manifest.json` were each overwritten by that concurrent
process multiple times while this feature was being assembled; every time
that happened, this feature's edits were detected as missing and
re-applied on top of the current state before finishing, rather than
reverting or discarding the other change. The two features do not share
any file content beyond these three shared manifests/bundle, do not import
each other, and do not touch the same DOM ids or storage keys. Given that
instability, it is worth a reviewer double-checking
`node scripts/check-canvas-integrity.mjs`, `node --test
test/r1-project-run.test.mjs`, and `node .github/scripts/capability-drift.mjs`
still pass clean on the final pushed commit before treating this PR as
representative of a stable tree.

## Out of scope (per SPEC)

R2 mission picker, auto-LinkedIn, cloud sync, none of these were touched.

## Ship checklist

- [x] Branch `feature/r1-project-run` from `main`.
- [x] `js/spine/project-run.js`, `js/spine/data-glow-project-run-canvas.js`.
- [x] Inlined into `canvas/index.html` (AUTHORITATIVE) via
      `inject_r1_project_run.py`.
- [x] `projectRun` flag registered in `flags.manifest.json`.
- [x] `canvas/integrity.manifest.json` updated and verified.
- [x] `capability-map.manifest.json` + `docs/capability-map.md` updated,
      drift-clean.
- [x] `docs/CHANGELOG.md` entry appended.
- [x] `test/r1-project-run.test.mjs`, 45/45 passing.
- [x] No em dash in visible UI (swept by test).
- [x] PR opened, marked **DO NOT MERGE**, not merged.
