# A49 Question Scout — Result

Branch: `feature/a49-question-scout` (PR open, **not merged**, per SPEC).

## What was built

Implements `A49_QUESTION_SCOUT_SPEC.md` end to end: a local Question Scout
panel that proposes candidate analysis questions from the currently loaded
table profile, scores/filters them toward "keepers" with a rule-based filter
that runs even if the model is unavailable, lets the human Keep/Edit/Reject,
maintains a max-5 keepers tray, and hands accepted keepers to the existing
Proof Harness as a claim/statement prefill — never proving anything itself.

### New files

- **`js/question-scout/question-scout.js`** — pure engine, zero DOM/GPU/model
  dependency, fully unit-testable from plain Node:
  - `buildProfileStrip(tables)` — deterministic profile summary (table/column
    names, row counts, null%, top categorical values, numeric min/max,
    id-like columns). Never touches an LLM; safe on zero tables.
  - `scoreCandidate(candidate, profileStrip)` / `rankCandidates(...)` — the
    SPEC's exact four-hit deterministic keeper filter: +1 for business
    actor/ops language, +1 for referencing a real column/table, +1 for a
    checkable `metricType` (`count|rate|share|delta|sum|avg`), +1 for
    SELECT-only draft SQL; penalties for viz vanity without a metric and for
    referencing columns absent from the profile. Rescaled to a 0–100 keeper
    score per the SPEC's panel copy.
  - `templateCandidatesFromProfile(profileStrip)` — the five model-free
    fallback templates the SPEC names verbatim: `COUNT(*)` grain check, null
    rate per high-null column, top-N frequency on the top categorical column,
    min/max/avg on the first numeric column, distinct count on an id-like
    column. Every one is labeled `source: 'template', modelUsed: false`.
  - `buildScoutPrompt(profileStrip)` / `parseModelCandidates(rawText)` — pure
    prompt construction and tolerant JSON parsing for the local-model path
    (never throws; a malformed/truncated generation degrades to `[]`, so the
    deterministic templates still cover the user).
  - `buildProvePrefill(keeper)` — maps a kept candidate 1:1 to the Proof
    Harness's `claimText`/`statement` fields. Does not run SQL, does not open
    a panel, does not mark anything proven.
  - `buildBrowseGrounding(profileStrip)` / `annotateUnverifiedNumbers(text)` —
    profile-only grounding for Browse mode (no raw rows, ever) plus a
    conservative heuristic that appends `"unverified — run Prove"` to any
    answer asserting a number that isn't already flagged.
  - `addKeeper(keepers, candidate)` / `removeKeeper(keepers, id)` — enforce
    the max-5 keepers tray, de-dupe by id.
  - Published as `window.DataGlowQuestionScout` (mirrors the
    `js/ai/local-ai-status.js` window-namespace convention).

- **`js/question-scout/data-glow-question-scout-canvas.js`** — canvas UI
  module (IIFE, same structural pattern as
  `js/proof-harness/data-glow-proof-harness-canvas.js`): slide-in panel with
  the locked cheating-boundary banner, the profile strip, a **Propose**
  button, a ranked candidate list with **Keep / Edit / Reject**, the keepers
  tray, a **Send to Prove** action per keeper, and a profile-grounded
  **Browse mode** chat. Gated behind the `questionScout` flag; injects its
  entry button next to the Proof Harness button (falls back to other known
  toolbar anchors); also surfaces "Propose keepers from this data" as an ask
  bar hint when tables are loaded.

### Wiring changes

- **`flags.manifest.json`** — new `questionScout` flag entry
  (`enabled: true`, `addedInPR: "feature/a49-question-scout"`), documenting
  both what the flag mounts and its flag-off behavior (panel never mounts;
  pure engine may still be evaluated/tested since it makes no DOM change).
- **`inject_a49_question_scout.py`** — idempotent injection script (modeled
  on `inject_bundle18.py`'s "new tracked engine" pattern) that splices both
  new files into `canvas/index.html`, wrapped in
  `/* ---- from <path> ---- */` / `/* ---- end <path> ---- */` markers,
  placed immediately after the Proof Harness canvas module's end marker.
  Re-running it re-syncs both blocks in place rather than duplicating them.
- **`canvas/integrity.manifest.json`** — two new tracked entries
  (`js/question-scout/question-scout.js`,
  `js/question-scout/data-glow-question-scout-canvas.js`), hashes recorded
  via `npm run check:canvas-integrity -- --update`. Total tracked modules:
  70 (was 68). `canvasBytes` re-recorded after injection.
- **`test/a49-question-scout.test.mjs`** — new pure Node test (89
  assertions, no browser/GPU/model download).
- **`package.json`** — new script `test:a49questionscout`.
- **`.github/workflows/job-ci-batch-03.yml`** — new job `a49-question-scout`
  (checkout → setup-node@v4 → `npm ci` → `npm run test:a49questionscout` →
  `npm run check:canvas-integrity`), matching the `jobs-polish-a48` /
  `typography-readability` job shape exactly.

### Bug caught and fixed during implementation

The canvas UI module's first draft assumed a bridge global of
`window.DataGlowOnDeviceLLM` with a `chatOnce()` method. Neither exists.
Grepping the actual inlined bridge in `canvas/index.html` (from
`js/narrative/ondevice-llm.js`) showed the real global is
**`window.OnDeviceLLM`**, and it exposes `loadModel()` (resolving to a raw
MLC engine handle), not a `chatOnce()` convenience method. The module was
corrected to call
`window.OnDeviceLLM.loadModel().then(engine => engine.chat.completions.create({...}))`
for both Propose and Browse mode, reusing the exact same call shape
`ondevice-llm.js` itself uses internally. This was verified by asserting, in
the test suite, that the canvas UI source contains `window.OnDeviceLLM`,
`loadModel`, and `chat.completions.create`, and does **not** contain the
stale `DataGlowOnDeviceLLM` or `bridge.chatOnce` strings.

A second, unrelated issue was caught by the pre-existing A48 typography
test: two new CSS rules in the panel used `font-size: 10.5px`, which A48's
typography contract forbids (floor is `0.75rem`/12px for badges/meta). Fixed
by switching both to `var(--dg-text-xs, 0.75rem)`.

## How the local model is used (per SPEC's "Local model guidance")

- **No new model, no forced download.** Question Scout does not load or
  bundle a model of its own. It calls into the **already-shipped** local AI
  bridge (`js/narrative/ondevice-llm.js`, published as `window.OnDeviceLLM`),
  whose current model is `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` ("Qwen2.5 1.5B
  Instruct (4-bit, ~1.1 GB)"). This matches the SPEC's own recommendation
  ("Default chat/scout (ship/keep): Qwen2.5-1.5B or 3B Instruct q4").
- **Reuses the bridge's cache.** `proposeViaModel()` and the Browse-mode
  helper both call `window.OnDeviceLLM.loadModel()`, which resolves to the
  bridge's own cached engine promise — if narrative synthesis elsewhere in
  the app already warmed the model, Scout reuses that exact warm instance
  and triggers no second download.
- **Cold/absent model → deterministic fallback, always.** Before calling the
  model, the UI checks `window.OnDeviceLLM.isModelLoaded()`
  (`modelIsWarm()` in the canvas module). If the bridge is missing, WebGPU is
  unavailable, or the model simply isn't warm yet, Propose calls
  `templateCandidatesFromProfile()` immediately — the five deterministic
  templates — and every one is labeled "template (no model)" in the UI,
  honoring the SPEC's honesty rule. Question Scout never blocks on, or
  forces, a model download.
- **Model ladder (documented, not implemented in this PR):** the SPEC
  explicitly does not require swapping the default model. For reference,
  `js/ai/local-ai-status.js` already lists the fuller ladder DataGlow tracks:
  Qwen2.5-1.5B-Instruct (shipped default), with Qwen2.5-Coder-3B,
  Llama-3.2-1B, and Phi-3.5-mini as `candidate`/`desktop_only` fits, and
  `whisper-base-q4` as `not_yet`. No change to this ladder was needed or made.

## Acceptance criteria (SPEC §Acceptance) — status

1. **Scout opens and shows candidates with a mock/profile.** ✅ Verified via
   `test/a49-question-scout.test.mjs`: a mock `claims` table profile produces
   profile-strip data, ranked candidates, and 5 templates.
2. **Deterministic filter ranks checkable questions above vanity.** ✅ Test
   asserts a checkable business question scores strictly higher than a pure
   viz-vanity candidate and a DML statement; templates all score ≥50.
3. **Keep → Keepers tray (≤5).** ✅ `addKeeper`/`removeKeeper` enforce the
   cap; test adds 7 candidates and asserts the tray never exceeds 5, with no
   duplicates.
4. **Send to Prove prefills SQL/claim, or falls back to a visible field /
   event.** ✅ `buildProvePrefill()` maps to `#dg-ph-claim`/`#dg-ph-statement`
   shape; the canvas module's `sendToProve()` tries a
   `window.dgOpenProofHarnessWithPrefill` hook first, then falls back to
   direct DOM field assignment plus a `dataglow:proof-harness-prefill`
   CustomEvent dispatch so the action never silently no-ops.
5. **Banner states the professional vs. cheating boundary.** ✅
   `CHEATING_BOUNDARY_BANNER` matches the SPEC's locked copy verbatim; test
   asserts exact string equality and that the canvas UI surfaces it.
6. **Works with model offline via templates.** ✅ `modelIsWarm()` gates the
   model path; templates are the default candidate source whenever the
   bridge is cold, missing, or WebGPU is unavailable.
7. **Tests cover filter scoring + panel markers, no GPU/model download in
   CI.** ✅ 89 assertions in `test/a49-question-scout.test.mjs`, pure Node,
   `node --check`-safe; CI job runs the test then `check:canvas-integrity`,
   neither of which touches a browser or downloads a model.
8. **PR open, not merged.** ✅ See PR link below.

## Test results

```
$ npm run test:a49questionscout
89 passed, 0 failed

$ npm run check:canvas-integrity
  ok  syntax: 3 inline <script> block(s) parsed
  ok  markers: 338 inlined module path(s) in canvas/index.html, 309 closing marker(s); tracked modules correctly paired
  ok  tracked: 70 module(s) verified against canvas/integrity.manifest.json
  ok  ship path: desktop stage script still stages index.html + js/
  ok  ship path: build.sh still guards canvas/index.html against a stale src/ rebuild
  ok  publish: canvas/index.html is the recorded 6429616 bytes
check-canvas-integrity: canvas bundle integrity OK

$ npm run test:typographyreadability
41 passed, 0 failed   (was 40 passed / 1 failed until the two 10.5px rules above were fixed)

$ npm run test:jobspolisha48
46 passed, 0 failed   (was 45 passed / 1 failed until the same fix landed)
```

No other engine, flag, or test suite was modified. Proof Harness, the local
AI bridge (`window.OnDeviceLLM`), and every previously-tracked canvas module
verify byte-for-byte unchanged.

## Non-goals honored

Per SPEC, this PR does not: auto-prove without a human, auto-post to
LinkedIn, default to a cloud LLM proxy, add general agent autonomy, or touch
Career Lane C / Maven-clone scope. Question Scout only proposes; the human
still chooses keepers, and the Proof Harness still proves every number.
