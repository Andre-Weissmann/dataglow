# Dark-flag visibility audit — 2026-07-12

## Purpose

Seven feature flags in `flags.manifest.json` ship default-`false` ("dark"). The
concern this audit answers: are any of them *built-but-unreachable* — real,
tested logic that a human can never actually see or trigger because the
flag-gated code path (a `mount()` / `render()` / gate call) was never added to
`main.js` / `index.html`? If so, flipping the flag later would silently do
nothing, and closing that gap is a cheap, low-risk win.

Method: for each flag, read its `flags.manifest.json` description, read the
backing module(s), then grep the **actual call sites** in `js/app-shell/main.js`
and `index.html` to confirm whether an `isEnabled('<flag>')` gate exists AND is
reached by the running app (the gated render/mount function is itself invoked in
the app lifecycle, not merely defined).

## Headline finding

**6 of the 7 flags are already fully wired.** Their `isEnabled()` gate exists in
a live code path, so flipping the flag to `true` would immediately make the
feature visible/active — nothing to wire. These are "built AND wired, just
defaulted off per the flag-if-visible-behavior-change convention," not
"built-but-unreachable."

**1 of the 7 — `queryMemory` — is genuinely dark** (no import, no `isEnabled`
call anywhere; flipping it today does nothing). But closing its gap is **LARGER**
(it needs run-path recording + a "seen before" badge UI + IndexedDB-store
hookup), not a same-day mount-call fix — explicitly deferred by its own Batch-1
description. It is therefore out of the Phase-2 "wire the trivial gaps" scope.

**Net: there are zero TRIVIAL/SMALL visibility gaps to close for this flag set.**
No production code is wired in this PR; the value delivered is this recorded
audit, which corrects the premise that these flags each need a mount call.

## Per-flag findings

### 1. `queryMemory` — **genuinely dark · tier: LARGER · deferred**
- **Backing:** `js/provenance/query-memory.js` (pure: `computeQueryFingerprint`,
  `createQueryMemoryLog{record,lookup,history}`, `summarizeQueryMemory`) +
  `js/learning/memory-store.js` (`queryMemoryLog` object store, DB v5, append-only
  capped). Both fully built and unit-tested.
- **Wiring state:** NONE. `grep` finds no `import` of `query-memory.js` and no
  `isEnabled('queryMemory')` anywhere in `js/`. The module's own header says
  "Batch 1 is module + tests ONLY, behind the OFF-by-default `queryMemory` flag …
  NO UI and NO wiring into the run paths yet."
- **What's missing:** (a) call `record()` from each SQL/Python/R/Metric-Studio
  run path; (b) call `lookup()` + `summarizeQueryMemory()` and render a "seen
  before" badge (new UI that does not exist); (c) construct the log against the
  real IndexedDB store adapter. This is new integration + new UI, i.e. real
  remaining engineering — not a visibility mount.
- **Additive?** Yes, once built it is opt-in/additive (a badge + a hidden log),
  but that is future work, not this task.

### 2. `conversationalPackBuilderVoice` — **already wired · tier: n/a (visibility done; usefulness = LARGER)**
- **Backing:** `js/agents/conversational-pack-ui.js` mic control.
- **Wiring state:** WIRED. `main.js:2028` passes
  `voiceEnabled: isEnabled('conversationalPackBuilderVoice')` into the live
  `mountConversationalPackBuilder({...})` call (`main.js:2023`);
  `conversational-pack-ui.js:118` renders the mic only when `voiceEnabled`.
- **What's missing (for real usefulness, not visibility):** an
  Apache/MIT on-device WASM/WebGPU STT model is not vendored yet (a documented
  TODO in the flag description). Flipping the flag *does* reveal the mic button —
  visibility is complete — but the transcription backend is deferred. Vendoring a
  model is LARGER and out of scope. Nothing to wire.
- **Additive?** Yes — the typed path is unchanged; the mic is a strictly extra
  affordance beside it.

### 3. `aiReadinessGateEnforcement` — **already wired · tier: n/a**
- **Backing:** `js/gate/agent-gate.js` + `js/agents/question-generator-agent.js` /
  `uncertainty-resolver-agent.js`.
- **Wiring state:** WIRED. `main.js:1997` builds the readiness context
  (`isEnabled('aiReadinessGateEnforcement') ? { layerResults: results } : undefined`),
  threads it into the pack builder, and `main.js:2010` logs the block. Flipping on
  activates the agent hard-block.
- **Additive?** Yes and importantly scoped: it blocks ONLY `js/agents/*`
  automated output; human SQL/Python/R/Metric-Studio workflows are unaffected in
  both flag states.

### 4. `meetingScribeLiveCapture` — **already wired · tier: n/a**
- **Backing:** `js/agents/live-transcript-capture.js` (pure) +
  `js/agents/meeting-scribe-ui.js`.
- **Wiring state:** WIRED. `main.js:2259` calls
  `mountMeetingScribe({ host, onToast, liveCapture: isEnabled('meetingScribeLiveCapture') })`;
  `meeting-scribe-ui.js:141` renders the Start/Stop live-capture controls only when
  `liveCapture` is true. Flipping on reveals the extra button pair.
- **Additive?** Yes — captured segments stream into the SAME `taggedSegments`
  state and re-render through the same path as a pasted transcript; the paste flow
  is byte-for-byte unchanged when off.

### 5. `semanticDriftWatchdog` — **already wired · tier: n/a**
- **Backing:** `js/ambient/drift-watchdog.js` (pure presentation + de-dup over
  the existing `distribution_drift` validation layer).
- **Wiring state:** WIRED. `main.js:5820`, inside the Watch Folder ingest path
  `watchIngestAndValidate()`, gates `driftWatchdog.observe(...)` on
  `isEnabled('semanticDriftWatchdog')` and surfaces `driftAlert` from its decision.
- **Additive?** Yes — computes no new statistics; only de-duplicates alerts the
  `distribution_drift` layer already produces. Wrapped in try/catch so it can never
  block ingest.

### 6. `dataglowSidebarNav` — **already wired · tier: n/a**
- **Backing:** `js/app-shell/command-deck-nav.js` + `#command-deck-sidebar` in
  `index.html`.
- **Wiring state:** WIRED. `renderCommandDeckSidebar()` (`main.js:302`) gates on
  `isEnabled('dataglowSidebarNav')` at line 305 (hides + empties the host when off)
  and is invoked in the live lifecycle — at init (`main.js:282`, `:6052`) and on
  tab change (`:321`). Flipping on shows the alternate sidebar.
- **Additive?** Yes — pure reorganization of the existing 13 tabs into 5 stages;
  the flat top tab bar remains the default when off.

### 7. `validationExtendedCoverage` — **already wired · tier: n/a**
- **Backing:** `js/validation/cross-column-consistency.js` (Rule 1c magnitude
  ordering) + `js/validation/validation.js` (business-key duplicate check);
  helpers `detectMagnitudePairs` / `detectBusinessKeyColumns`.
- **Wiring state:** WIRED. `validation.js:161` gates the business-key branch on
  `isEnabled(EXTENDED_COVERAGE_FLAG)` and `validation.js:802` passes
  `{ magnitude: isEnabled(EXTENDED_COVERAGE_FLAG) }` into `runCrossColumnChecks`.
  Both run inside `runAllLayers`, which every Validate invokes. Flipping on
  activates both checks.
- **Additive?** Yes — adds NEW findings only; with the flag off Rule 1c never
  fires and the business-key branch is skipped, restoring byte-for-byte prior
  Validate output. The pure helpers are always exported and unit-tested regardless
  of flag state.

## Summary table

| Flag | Wired today? | Flip lights it up? | Tier of remaining work | Wired in this PR? |
|---|---|---|---|---|
| `queryMemory` | No | No | LARGER (run-path + badge UI) | No — deferred |
| `conversationalPackBuilderVoice` | Yes (mic UI) | Yes (shows mic) | LARGER (vendor STT model) | n/a — already wired |
| `aiReadinessGateEnforcement` | Yes | Yes | none | n/a — already wired |
| `meetingScribeLiveCapture` | Yes | Yes | none | n/a — already wired |
| `semanticDriftWatchdog` | Yes | Yes | none | n/a — already wired |
| `dataglowSidebarNav` | Yes | Yes | none | n/a — already wired |
| `validationExtendedCoverage` | Yes | Yes | none | n/a — already wired |

## Recommendation

- **No visibility wiring is warranted for this flag set right now.** Six flags
  are already reachable behind their gate; the seventh (`queryMemory`) needs a
  dedicated, properly-tested batch (record-in-run-paths + badge UI), tracked as
  its own future PR rather than bolted on here.
- Each of the six wired flags is genuinely additive/opt-in-shaped: flipping any
  one to `true` adds a surface or a set of findings and leaves existing default
  behavior unchanged when off. That confirms they are safe to promote
  individually when the product decides to, via the separate, explicitly-confirmed
  flag-flip action (not done in this PR).
