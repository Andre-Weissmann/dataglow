# DataGlow North Star

Read this file first, every session, before running a full brainstorm/research ritual again.
If nothing material has changed in the data industry since the last research pass (see date below),
skip straight to "Current concept" and continue building. Only re-trigger deep research if the user
explicitly asks, or on a scheduled cadence.

Last deep research pass: 2026-07-11 (`data_industry_research_2026.md`, 68 inline citations, 12 signals).

---

## Current concept: AI Readiness Gate

**One sentence:** A dataset, metric, or query result cannot be handed to an AI agent (or exported to a
dashboard/API) until it automatically earns a pass from DataGlow's existing validation — instantly,
invisibly, with zero new approval friction for humans, and a hard stop only for agents.

**Why this concept won round 2 (over Query Memory, the round 1 pick):**
- Directly answers the single most-repeated, highest-magnitude finding in the research: 60-84% of AI
  initiatives fail because ungoverned/unready data is handed to AI before it's fixed, and agents pointed
  at ungoverned data got answers wrong 65%+ of the time (Miro/DataHub case).
- Adds zero governance friction for humans — directly answers the top Reddit complaint ("ten layers of
  approval") by only gating *agents*, never people.
- Reuses 100% of existing infrastructure (20-layer validation suite in `js/validation/validation.js`,
  Metric Contracts in `js/metrics/metric-contracts.js`) — no new validation logic invented, pure
  composition/aggregation on top.
- Prevents the failure before it ships, rather than just documenting it after (Query Memory's weakness).

**How it works:**
1. Pure aggregator over `runAllLayers()` output + Metric Contracts status → single boolean
   `agentConsumable: true/false` + a reasons list citing which layer(s) failed.
2. Humans always see full results and can override; DataGlow's own agent modules (`js/agents/*`) and any
   future MCP-exposed interface are hard-blocked below threshold.
3. When blocked, shows the exact failing layer(s) with a one-click fix path (honest diagnostics, not
   "bad data ruined my AI" hand-waving — a direct wish-list item from the research).

**Build batches (in order, each its own PR):**
1. **Pure scoring/gate module + tests only.** No UI, no agent wiring. (DONE — `js/gate/readiness-gate.js`)
2. **UI badge (pass/fail + reasons) surfaced near query/metric results.** (DONE — `js/gate/readiness-gate-ui.js`,
   wired into the SQL tab; `aiReadinessGateBadge` flag PROMOTED to ON — purely informational, never blocks a human.
   Python/R/Metric Studio wiring + a real per-query metric-contract status remain a follow-up.)
3. **Wire the gate into `js/agents/*` modules as a hard block.** (DONE — `js/gate/agent-gate.js` +
   `generateQuestions`/`resolve` gated behind an optional `readiness` context; `main.js` threads it only when
   the `aiReadinessGateEnforcement` flag is on. Ships DARK: flag default OFF. Blocks ONLY js/agents/* output —
   human-facing SQL/Python/R/Metric Studio workflows are entirely unaffected in both flag states.)
4. (Stretch) Expose the gate via any future MCP interface so external agents respect it too. (NEXT)

---

## Concept in progress: Guarded Copilot

**One sentence:** a read-only, lineage-citing chat assistant that answers "why is this data/grade/
agent-readiness the way it is" — architecturally, not just conventionally, incapable of writing to
data, because it has no import of and no call path to the Agent Action Firewall's apply methods.

**Why it fits DataGlow:** composes four modules DataGlow already ships and trusts rather than
inventing anything new: the AI Readiness Gate (`js/gate/readiness-gate.js`) for readiness/why-blocked
answers, the AI Touch Ledger (`js/provenance/ai-touch-ledger.js`) both to answer "who touched this"
and to log Guarded Copilot's own queries into the same hash chain, the Story engine's grade vocabulary
for grade explanations, and — critically — deliberately holds NO reference to the Agent Action
Firewall's `proposeAction`/`confirmAndApply` functions, so it cannot initiate or complete a mutation
by construction, not by promise. Two-tier answer model: Tier 1 is deterministic template answers
(zero cost, zero model, always available); Tier 2 optionally reuses the EXACT on-device Qwen2.5-1.5B
model already loaded for Story (`js/narrative/ondevice-llm.js`) to rephrase Tier 1's facts more
naturally — never a second model, never an external API call (matches the standing no-paid-AI-API
constraint), and falls back to Tier 1's text untouched if WebGPU/the model isn't available.

**Build batches (in order, each its own PR):**
1. **Batch 1 — deterministic core + read-only contract.** (this batch — new pure, Node-testable
   module `js/agents/guarded-copilot.js`: `classifyIntent()` keyword-based question routing across
   5 supported intents (readiness, why-low-confidence, what-changed, who-touched-this, explain-grade),
   `answerDeterministic()` composing the real readiness gate / grade vocabulary / caller-supplied
   journal and ledger entries, `askGuardedCopilot()` as the single public entry point which also logs
   its own query to a real `createTouchLedger()` chain, and `refineWithOnDeviceModel()` as the Tier 2
   opt-in stub that gracefully falls back with no WebGPU. Verified in `test/guarded-copilot.test.mjs`,
   34/0 passing, including a structural red-team suite proving no import of/call to
   `confirmAndApply`/`proposeAction` and no write/insert/delete/update/mutate call anywhere in the
   file. Ships DARK behind `guardedCopilot` (default OFF): not imported by `js/app-shell/main.js` yet,
   no chat UI, zero effect on any existing path.)
2. **Batch 2 — chat panel UI + Tier 2 model wiring.** MERGED DARK. Wired a read-only 'Copilot' chat
   panel into the app shell (`renderGuardedCopilotTab()` in `js/app-shell/main.js` mounting
   `#panel-copilot` in `index.html`): message list, text input + Ask button, a persistent "Read-only —
   never modifies your data" note, a "Sources:" line citing the real modules each answer came from, and
   an off-by-default "Refine with the on-device model" toggle that lazy-loads the model (progress +
   cancel, mirroring the Story tab). No second UI sub-flag was needed — the existing `guardedCopilot`
   flag gates the whole panel/tab, so this stays behind ONE flag as intended. Also completed the real
   `refineWithOnDeviceModel()` model call: it now rephrases the Tier 1 answer via the already-warmed
   on-device engine (`loadModel()` + `engine.chat.completions.create`, no new pathway, no second model),
   under a narrow rephrase-only prompt, still falling back to Tier 1's exact text with no WebGPU/model.
   Still ships DARK behind `guardedCopilot` (default OFF): with the flag off the tab is never in the bar
   and the panel stays empty — zero effect on any existing path.

## Concept in progress: DataGlow Live Rooms

**One sentence:** the Meeting Scribe stops being a paste-a-transcript-after-the-fact tool
and becomes a live meeting companion — capturing audio and transcribing it on-device in
real time, then (in later batches) mirroring the grounded action-item view to other people
in the room and synthesising it, all without a single byte of audio or transcript ever
leaving the device.

**Why it fits DataGlow:** zero-upload / local-first / no-build. The speech-to-text engine
is lazily CDN-loaded as CODE (transformers.js, exactly how WebLLM is loaded for the
on-device LLM) and runs entirely in-browser on WebGPU — no audio is ever sent anywhere,
holding the same privacy/offline guarantee as every other capability. Batch 1 reuses the
existing `parseTranscriptText` segment shape and the unchanged `tagSegmentsWithContext`
grounding logic, so the live path and the paste path converge on one code path rather than
forking the agent.

**Build batches (in order, each its own PR):**
1. **Batch 1 — live audio capture + on-device STT input path.** (DONE — see
   [#155](https://github.com/Andre-Weissmann/dataglow/pull/155) — new pure,
   Node-testable module `js/agents/live-transcript-capture.js`: `isSpeechCaptureAvailable()`
   graceful capability check plus `assembleSegments()`/`createTranscriptAssembler()` turning
   raw STT chunks into the SAME `{text, ts}` shape `parseTranscriptText` produces, feeding
   the EXISTING, unchanged `tagSegmentsWithContext`; the browser-only `startLiveCapture()`
   lazily CDN-loads a Whisper-family STT engine as code, never uploading audio. Wired into
   `js/agents/meeting-scribe-ui.js` as additive Start/Stop controls streaming into the same
   state. Verified in `test/live-transcript-capture.test.mjs` (`npm run test:livecapture`),
   28/0 passing, new `job-live-transcript-capture.yml` CI job. Ships DARK behind
   `meetingScribeLiveCapture` (default OFF, intentionally dark per this batching plan — this
   is expected, not an oversight): when off, no live-capture UI renders and every existing
   path is byte-for-byte unchanged.)
2. **Batch 2 — cross-device pairing + WebRTC read-only mirrored action-item view.** NOT
   STARTED. Let others in the room watch the grounded action-item list update live on their
   own device, peer-to-peer, with no server relay.
3. **Batch 3 — real chart-context timeline wiring.** NOT STARTED. Feed
   `tagSegmentsWithContext` a live timeline of which chart/query the analyst was viewing
   when each line was spoken, so segments get real context tags instead of today's `null`.
4. **Batch 4 — on-device LLM synthesis panel.** NOT STARTED. Summarise the captured,
   grounded meeting (pushback moments, data requests, action items) with the existing
   on-device LLM — no cloud call.

---

## Concept in progress: DataGlow Rooms

**One sentence:** turn any DataGlow session into a shared room — an analyst, a data scientist,
and a data engineer open the same dataset from their own browsers, each working in their own
preferred mode (drag-and-drop, SQL, Python, R), and see each other's queries, charts, and
validation findings update live on their own screen, peer-to-peer, with zero server and zero
upload — the same privacy guarantee as every other DataGlow feature, extended for the first
time to more than one person at once.

**Where this came from:** brainstorm round 5 (2026-07-12), run against the full
revolutionary/flip-the-script/tear-down-walls lens with the user's explicit ask for "any data
role, any experience level... team members using it... video conferencing... note taking." A
dedicated research pass that same day (`research_agentic_collaboration_2026-07-12.md`) found
this is the single loudest unmet need in the market: dbt Labs' 2026 State of Analytics
Engineering report shows a 48-point gap between AI-coding adoption (72%) and AI-validation
investment (24%), and no named 2026 competitor (Snowflake CoCo, Databricks Genie, Tableau
Agent, Deepnote) lets mixed skill levels work one live dataset together without cloud sync —
every one of them assumes cloud-resident data by construction. DataGlow already had three of
the four load-bearing primitives sitting half-wired: Object Space (cross-language shared
object registry, currently passive-only), the Polyglot Workbench's multi-language views, and —
crucially — real, tested, peer-to-peer WebRTC transport in `js/federated/federated-transport.js`
(built for Federated Learning, never yet used for anything else). Rooms is the connective
tissue wiring those three together, and it also completes two backlog items that were already
queued but stalled: Live Rooms' own Batch 2 (WebRTC mirrored view) and Polyglot Workbench's
Batch C (cross-language query-time resolution).

**Why this fits DataGlow:** it is the first capability where more than one person's live
session touches the same in-browser DuckDB state, but it inherits every existing privacy
discipline rather than inventing new ones — no recording, no persistence beyond the session,
no server relay, and a `NULL_ROOM_SIGNALING` no-op adapter (identical philosophy to
Federated Learning's `NULL_SIGNALING`) that makes an unreachable coordination channel a
first-class, never-thrown state instead of a broken feature.

**Build batches (in order, each its own PR, each its own default-OFF flag — per the
standing rule that enabling any flag is always a separate, explicitly confirmed action from
building/merging it):**
1. **Batch 1 — room signaling + peer discovery.** (DONE — see
   [PR #188](https://github.com/Andre-Weissmann/dataglow/pull/188) — new pure, Node-testable module `js/rooms/room-signaling.js`:
   `generateRoomCode()`/`normalizeRoomCode()`/`isValidRoomCode()` for short, human-shareable,
   collision-tolerant room codes (visually-ambiguous characters excluded); `isRoomsSupported()`
   reusing `isWebRTCSupported()` from `federated-learning.js`; `RoomSignalingCoordinator`
   (`join()`/`listPeers()`/`leave()`) built with the exact dependency-injection pattern
   `FederatedCoordinator` already proved. NO UI, NO Object Space broadcasting yet. Verified in
   `test/room-signaling.test.mjs` (`npm run test:roomsignaling`), 29/0 passing, new
   `job-room-signaling.yml` CI job. Ships DARK behind `roomsSignaling` (default OFF,
   intentionally dark per this batching plan): when off, nothing in the app imports or calls
   into this module and every existing path is byte-for-byte unchanged.)
2. **Batch 2 — Object Space broadcast wiring.** (DONE — new pure, Node-testable module
   `js/rooms/room-broadcast.js`: `buildEntryMessage()`/`buildViewingMessage()` (wire builders
   that carry only an entry's already-public shape metadata — name/originLanguage/kind/schema/
   rowCount/provenance pointer — never raw rows) and `RoomBroadcastCoordinator`
   (`broadcastEntry()`/`broadcastViewing()`/`receive()` plus the read-only `viewersOf()`/
   `objectsViewedBy()`/`viewingSnapshot()` "who's viewing" map), which COMPOSES Batch 1's
   `RoomSignalingCoordinator` with a data-channel transport adapter that reuses
   `federated-transport.js`'s WebRTC mesh `exchange` primitive — one shared peer-to-peer path,
   the exact dependency-injection pattern Batch 1 proved (a `NULL_ROOM_TRANSPORT` no-op adapter
   makes an unreachable channel a first-class, never-thrown state; every broadcast is best-effort
   and never throws, and remote entries apply newest-write-wins into the shared Object Space).
   Verified in `test/room-broadcast.test.mjs` (`npm run test:roomsbroadcast`), 33/0 passing, new
   `job-room-broadcast.yml` CI job. Ships DARK behind `roomsBroadcast` (default OFF): this is the
   DATA LAYER only — explicitly NO DOM, NO Room pill/avatars/live-update toasts (Batch 3), and NO
   wiring into the SQL/Python/R tabs — so with the flag off nothing constructs a coordinator,
   broadcasting only ever happens once a Room is joined, and every existing single-user Object
   Space code path is byte-for-byte unchanged.)
3. **Batch 3 — UI: Room pill, avatar presence, live-update toasts.** (DONE — the first
   VISIBLE Rooms surface: `js/rooms/room-ui.js`, a thin, DOM-mounting presentation layer that
   surfaces exactly what Batches 1 & 2 already return, inventing no new Room concept, signaling,
   or broadcast payload and moving no byte of anyone's data. PURE, Node-testable view-model
   builders — `buildRoomPillModel()` (a compact topbar "Room pill": the room code when a Room is
   open, a "Start a Room" affordance when not, an honest "Rooms unavailable" state when WebRTC is
   unsupported), `buildPresenceModel()` (avatar/initials badges for the OTHER peers, composing
   Batch 1's `listPeers()` with Batch 2's `viewingSnapshot()` who's-viewing map; `peerInitials()`/
   `avatarColor()` give each peer stable initials + a palette color), and `buildRemoteEntryToast()`/
   `notifyRemoteEntry()` (a live-update toast when a peer's Object Space entry arrives via Batch 2's
   `receive()`→`onRemoteEntry`, reusing the existing `toast()` primitive) — plus the thin DOM
   renderer `renderRoomUi()` left to the browser/e2e path, the exact identity split `glow-orb-ui.js`
   uses. Wired into the topbar (`#room-ui-host`) by `js/app-shell/main.js`'s `renderRoomUiWidget()`
   (`startRoom()`/`leaveRoom()`/`copyRoomCode()`/`refreshRoomPeers()`), which owns the Room
   lifecycle and the flag check. Verified in `test/room-ui.test.mjs` (`npm run test:roomsui`),
   26/0 passing, new `job-room-ui.yml` CI job. Ships DARK behind `roomsUi` (default OFF,
   intentionally dark per this batching plan): no real signaling/data-channel adapter is injected
   yet, so with the flag ON a started Room is local-only and no remote peers/entries arrive until a
   real adapter is wired — an honest, never-thrown dark state; with the flag OFF
   `renderRoomUiWidget()` hides `#room-ui-host`, tears down any coordinator, and the topbar and
   whole app shell are byte-for-byte unchanged. The visual layer follows the 2026-07-12 live
   desktop + mobile preview mockup (`dataglow-rooms-preview` app asset).)
4. **Batch 4 (stretch, optional) — cross-language live resolution.** NOT STARTED. Let a
   Python/R view actually re-render from a peer's live SQL result, not just display it — this
   is also Polyglot Workbench's own already-planned "Batch C," so building it here retires that
   backlog item too.

---

## Concept in progress: Polyglot Workbench

**One sentence:** SQL, Python, and R stop being three separate sandboxes that only talk
through disposable JSON round-trips — they become three views into one shared, typed,
provenance-tracked object space, dialect walls dissolve (write Postgres/MySQL/BigQuery/
Snowflake/T-SQL, DuckDB executes it), and every object either language creates is visible
to the others by name.

**Why it fits DataGlow:** zero-upload / local-first / no-build — every batch so far is a
pure, dependency-free, in-browser module (no parser service, no network, no new backend),
mirroring the existing hand-rolled `sql-highlight.js` tokenizer discipline of never
corrupting quoted string literals and the existing provenance chain-of-custody conventions.
It lowers the on-ramp for analysts who already know a warehouse dialect and removes the
friction of three languages that today can't see each other's work, without compromising
the privacy/offline guarantees.

**Build batches (in order, each its own PR):**
1. **Batch A — pure dialect adapter + tests, wired into the SQL tab behind a flag.**
   (SHIPPED, merged in [#142](https://github.com/Andre-Weissmann/dataglow/pull/142) —
   `js/app-shell/sql-dialect-adapter.js`: `translateDialectSql(sql, dialect)` +
   `SUPPORTED_DIALECTS`; real per-dialect syntax translation verified against a live DuckDB
   engine in `test/sql-dialect-adapter.test.mjs`, 43/0 passing. PROMOTED to ON in
   [#165](https://github.com/Andre-Weissmann/dataglow/pull/165):
   the dialect-picker chip row now renders by default and transpiles the user's SQL before
   `runQuery`; the default 'duckdb' selection is a no-op passthrough, and turning
   `multiDialectSql` back off restores the byte-for-byte prior SQL tab.)
2. **Batch B — Object Space registry.** (SHIPPED, merged in
   [#141](https://github.com/Andre-Weissmann/dataglow/pull/141) —
   `js/app-shell/object-space.js`: a passive, in-memory single source of truth for named
   cross-language objects (name, originLanguage, kind, schema, rowCount, provenance
   pointer), verified in `test/object-space.test.mjs`, 32/0 passing. Sits ALONGSIDE the
   existing per-language JSON bridges — does NOT replace transfer mechanics. Read-only
   "Object Space" strip in the data sidebar. PROMOTED to ON in
   [#165](https://github.com/Andre-Weissmann/dataglow/pull/165):
   the passive registry now populates and the Object Space strip renders by default;
   turning `objectSpaceRegistry` back off restores zero behavior change. Batch C (query-time
   resolution) remains the next batch that makes the registry load-bearing.)
3. **Batch C — cross-language query-time resolution (`FROM py.name` / `dataglow.get_df('sql_result')`
   actually reading the SAME registered object).** NOT STARTED. This is what makes the
   registry load-bearing instead of just a display strip — the real "three views into one
   object space" mechanic. Natural next batch.
4. **Batch D — schema-aware autocomplete in all three editors, sourced from the live
   Object Space registry.** NOT STARTED. Depends on Batch C landing so the registry
   actually reflects resolvable objects, not just passive registrations.
5. **Batch E — cross-language error messages with a concrete "Suggested fix" (extends
   `formatSqlError`'s pattern to Python tracebacks / R conditions, cross-referencing the
   registry).** NOT STARTED.

---

## Concept in progress: Glow Path

**One sentence:** a single, persistent, honest rail — not a new nav system, not a new tab —
that sits beside DataGlow's existing tabs/sidebar and always answers one question in plain
English, "here's the next right thing to do," while its own density (how much detail/jargon
it shows) silently steps up as it observes real usage — never gated behind a role picker,
never asked as a setup question.

**Why it fits DataGlow:** channels the "it just works" / Steve-Jobs-empower-the-user lens
(brainstormed 2026-07-11) — any data role (analyst, scientist, engineer, or a role that
doesn't exist yet) should be able to sit down and immediately know what to do next, with zero
onboarding. Reuses only real existing signals (AI Readiness Gate verdict, validation results,
query history) and never fabricates a suggestion — mirrors the Readiness Gate's/Trust Strip's
"never fabricate a value" discipline. Does not touch tab organization (Command Deck / Tab
Groups / Validate Focus Mode already own that question) — Glow Path answers a different one.

**Build batches (in order, each its own PR):**
1. **Batch B — session-scoped proficiency signal.** (SHIPPED, merged in
   [#144](https://github.com/Andre-Weissmann/dataglow/pull/144) —
   `js/learning/proficiency-signal.js`: pure, in-memory, dependency-free per-tab action tally
   classified into `'low'/'mid'/'high'` via `classifyDensity()`/`createProficiencyTracker()`.
   No IndexedDB, no persistence, no UI, no wiring yet — 38/0 passing in
   `test/proficiency-signal.test.mjs`. Cross-session persistence explicitly deferred to a
   future batch.)
2. **Batch A — the rail itself.** (SHIPPED, merged in
   [#145](https://github.com/Andre-Weissmann/dataglow/pull/145) —
   `js/app-shell/glow-path.js` (pure `computeGlowPathState(ctx)`, 6-priority first-match-wins
   decision list, never throws) + `js/app-shell/glow-path-ui.js` (pure badge-model builder +
   thin DOM presenter + in-memory per-dataset dismissal store), wired into `main.js` after
   query runs, after validation, and on tab switch. Ships DARK behind `glowPathRail` (default
   OFF); with the flag off the app is byte-for-byte unchanged. `densityLevel` defaults to
   `'low'` and has zero import-time dependency on Batch B — the two batches were built and
   merged independently, in either order. 55/0 passing in `test/glow-path.test.mjs`.)
3. **Batch C — wire `densityLevel` from the real proficiency signal.** (SHIPPED, merged in
   [#150](https://github.com/Andre-Weissmann/dataglow/pull/150) — thin glue in `main.js`: one
   shared session-scoped `createProficiencyTracker()` fed `recordAction()` from the real run
   events of four tabs (`sql`, `python`, `r`, `validate`) at their central success paths, and
   `renderGlowPathRail()` now passes `tracker.getDensityLevel()` as `ctx.densityLevel` instead
   of the implicit `'low'`. In-memory only, no persistence. `glow-path.js`, `glow-path-ui.js`,
   `proficiency-signal.js` and the `glowPathRail` flag default (OFF) are all unchanged; full
   `test:*` suite 94/0.)
4. **Batch D — promote `glowPathRail` to ON.** (SHIPPED, merged in
   [#152](https://github.com/Andre-Weissmann/dataglow/pull/152) — flag flipped from `false` to
   `true` in `flags.manifest.json`; the rail is now LIVE for every user by default. Verified
   with the flag on before merging: `test:glowpath` 55/0, `test:proficiencysignal` 38/0,
   `test:capdrift` 24/0, `test:living-manifest` 29/0, and a real-Chrome `test:e2e` full smoke
   run (golden dataset load → validate → grade → export → time-machine → synthetic-twin) —
   all passed with the flag live, zero regressions. Rollback is a one-line flip back to
   `false` if ever needed; the rail's own code guarantees byte-for-byte-unchanged output when
   off, verified across Batches A–C. Glow Path is now fully shipped end-to-end: Batches A, B,
   C, D all merged, nothing left dark.)

---

## Concept in progress: The Glow

**One sentence:** every trust/quality signal DataGlow already computes (the AI Readiness
Gate verdict, Trust Strip field states, Golden Signals rates, CAT Scorecard grades)
collapses into a single glowing orb docked in the topbar — one glance tells you if your
data is trustworthy, one click opens a compact panel with the honest breakdown and the
real next action, and a future hold-to-unfold gesture would fan the app's core surfaces
out from the same point. Pure composition, zero new validation math — the whole point is
compressing existing real value into one small, inevitable object rather than adding a new
surface to explain.

**Why it fits DataGlow:** brainstormed 2026-07-11 through an explicit Steve Jobs / Jony Ive
lens (customer-first, work backwards from the tech; liberal-arts-meets-technology;
relentless simplification — "made the MacBook Air fit into an envelope"). Two other
directions were ranked and rejected in the same round (a new detector/validator, and a
redesigned onboarding wizard) because both add power/explanation rather than removing the
need to hunt across signals scattered across the SQL tab, the Validate tab, and computed-
only values with no persistent chrome. The Glow is the opposite instinct: it removes the
need to go anywhere. Checked against the capability map for duplication — no existing
module renders a persistent single summary object in the topbar; the unbuilt OneCanvas
shell backlog item is a different, additional-page-style unifying concept, not a duplicate.
Mirrors `readiness-gate.js`'s founding discipline of composing existing layer output rather
than inventing new logic.

**Build batches (in order, each its own PR):**
1. **Batch 1 — pure aggregator + tests, no UI.** (SHIPPED, merged in
   [#154](https://github.com/Andre-Weissmann/dataglow/pull/154) — `js/glow/glow-signal.js`:
   `computeGlowSignal(input)` composes the readiness gate, Trust Strip, Golden Signals, and
   CAT Scorecard outputs into one `{ status, score, signals[], nextAction, summary }`
   verdict (gate score/`agentConsumable` authoritative when present, no competing score
   invented, every signal traces to a real field, `nextAction` built only from the gate's
   own failing layers, never throws — empty input → idle). Plus `explainGlowSignal()` for
   future UI. 50/0 passing in `test/glow-signal.test.mjs`. Ships DARK behind the new
   `glowOrb` flag, default OFF; zero UI/DOM/`main.js` wiring in this batch.)
2. **Batch 2 — orb UI wired into the topbar, same flag.** (SHIPPED, merged in
   [#157](https://github.com/Andre-Weissmann/dataglow/pull/157) — `js/glow/glow-orb-ui.js`:
   `buildGlowOrbModel()` (pure, DOM-free, reuses the Trust Strip's `ok/warn/bad/idle` dot
   colors verbatim, shows `—` rather than a fabricated score when none exists) +
   `renderGlowOrb()` (a ~30px orb button, click-to-expand panel with signal rows, an honest
   next-action callout, and a "Show the math" toggle revealing `explainGlowSignal()`'s raw
   text — same interaction pattern as the Readiness Gate badge; no hold-to-unfold gesture
   built here). Wired into `main.js` as `renderGlowOrbWidget()` — mirrors
   `renderReadinessGateBadge`'s `if (!isEnabled('glowOrb')) { host.innerHTML=''; return; }`
   dark-ship guard exactly, composes the SAME already-computed gate + Trust Strip state
   (re-runs no validation), called at the Glow Path rail's lifecycle points. Host
   `#glow-orb-host` sits leftmost in `.topbar-right`. 33/0 passing in
   `test/glow-orb-ui.test.mjs`. Golden Signals/CAT Scorecard are async and not persisted to
   `state`, so they're left undefined in the topbar composition rather than re-run
   synchronously — documented follow-up, not a fabricated stand-in. `glowOrb` stays OFF —
   ships dark for a dogfood period before promotion, same discipline as the Readiness Gate
   badge and Trust Strip.)
3. **Batch 3 — promote `glowOrb` to ON.** (SHIPPED, merged in
   [#159](https://github.com/Andre-Weissmann/dataglow/pull/159) — flag flipped from `false`
   to `true` in `flags.manifest.json`; the orb is now LIVE for every user by default.)
4. **Batch 4 (stretch) — hold-to-unfold gesture.** NOT STARTED. Holding the orb down would
   fan DataGlow's core surfaces (Validate, Clean, Export) out as cards from the same point.
   Pure animation/interaction layer, no new data — safe to defer indefinitely without
   blocking Batches 1-3.

---

## Concept in progress: Data Diplomacy

**One sentence:** Data Diplomacy is DataGlow's first capability built around disagreement
BETWEEN two parties about the same entity — reconciling conflicting claims from two sources
about one real-world thing — rather than validation WITHIN one dataset or by one user.

**Why it fits DataGlow:** it reuses ~90% of existing infrastructure instead of inventing new
machinery — the federated transport pattern from `js/federated/`, the sealing discipline of
`js/provenance/selective-disclosure-proof.js`, the sequential-debate reasoning style of
`js/agents/uncertainty-resolver-agent.js`, and the propose/approve/reject two-key UX of
`js/metrics/metric-contract-confirm-gate.js`. It is healthcare-native by construction (e.g.
two hospitals disagreeing on a single patient's admission date, each holding a differently
sourced record), which is DataGlow's anchor domain. It extends backlog item #5 (cross-org
clean-room-style privacy-preserving joins) from merely *joining* data into *reconciling
disagreement* about data — the harder, more valuable half of cross-org collaboration. The
concept was born from a dedicated "brainstorm time" session and passed the capability-map
duplication check: nothing else in the 24-area map does cross-party claim reconciliation, so
it is genuinely new surface, not a rename of an existing module.

**Build batches (in order, each its own PR):**
1. **Batch 1 — pure Reconciliation Engine + claim-sealing, no UI.** (SHIPPED, merged in
   [#146](https://github.com/Andre-Weissmann/dataglow/pull/146) — `js/diplomacy/diplomacy-claim.js`
   (a sealed, tamper-evident claim from one party about one entity), `reconciliation-engine.js`
   (pure comparison of two claims → agreement/disagreement verdict with per-field reasons), and
   `diplomacy-approval-gate.js` (the two-key propose/approve/reject state machine). 31/31 tests
   passing. Ships DARK behind the `dataDiplomacy` flag (default OFF).)
2. **Batch 2 — thin two-key approval UI wired to the engine.** (SHIPPED, merged in
   [#148](https://github.com/Andre-Weissmann/dataglow/pull/148) — `js/diplomacy/diplomacy-ui.js`:
   a gated "Diplomacy" tab driving Batch 1's engine through a hardcoded demo scenario (the two
   hospitals / one admission-date example), reusing the metric-contract confirm-gate UX. 44/44
   tests passing (full suite after rebase onto #146). Ships DARK behind the SAME `dataDiplomacy`
   flag — which is STILL OFF, so the Diplomacy tab is not visible to any real user yet even though
   the code is merged into main. Landed dark ≠ shipped/visible: both Batch 1 and Batch 2 are MERGED
   but the feature is NOT yet visible to end users. This is not "done".)
3. **Batch 3 — generalize beyond the hardcoded demo.** NOT STARTED. Replace the two-claim example
   scenario with a real data-loading UI so users can construct claims from their own loaded
   datasets, not just the built-in demo pair.
4. **Batch 4 — real peer-to-peer / cross-org transport.** NOT STARTED. Batch 1 currently borrows
   the federated-transport pattern only as a reference shape, not as real wiring; this batch would
   make two actual parties in two actual browsers exchange sealed claims, closing the loop on the
   cross-org promise.

---

## Concept in progress: Source Convergence

**One sentence:** Source Convergence is DataGlow's first capability that reasons ACROSS N
loaded sources at once — working out which sources describe the same real-world entity, how
they overlap, and where they disagree on a shared fact — then resolving each conflict to the
highest-trust source's value only when the trust margin is decisive, and honestly escalating
the rest for a human.

**Why it fits DataGlow:** every validation layer shipped so far reasons WITHIN one table (even
Cross-Column Logical Consistency is single-row, single-source), so a claim dated after a
patient's death date recorded in a different file, or a claims total that disagrees between two
datasets, goes undetected. Test findings run 4 (2026-07-12) logged this as a P1: "No cross-table
temporal/relational plausibility checking exists at all." An earlier two-table attempt (the
Cross-Table Relational Rules engine, [#197](https://github.com/Andre-Weissmann/dataglow/pull/197))
was reverted ([#200](https://github.com/Andre-Weissmann/dataglow/pull/200)) because two tables is
the wrong unit — real reconciliation spans a roster, a CMS eligibility extract, an adjudication
feed, and more, all at once. Source Convergence replaces it with a graph-based N-way model that
also follows TRANSITIVE joins (A joins B, B joins C ⇒ A and C converge through B even with no
shared key). It reuses the trust-margin / honest-refusal discipline already proven in
`js/diplomacy/reconciliation-engine.js` rather than inventing new resolution machinery, and it is
the analytic engine that Data Diplomacy's two-key approval UX could later sit on top of.

**Live preview (step 8b):** desktop + mobile mockup deployed 2026-07-12
(`/home/user/workspace/source_convergence_preview/`), rendered inside DataGlow's real CSS/font/theme
shell. Shows 6 mixed-format sources (2 CSVs, 2 Excel tabs, 1 API pull, 1 site export) each with its own
trust weight, a 7-column coverage matrix across all 6, and a verdict panel matching the summary format
above. Verified clean at both viewports (desktop source-rail grid fixed from an original overflow at 6
cards; a swipe hint was added for the wide coverage table on mobile).

**Status: all 3 batches shipped, all dark.** As of 2026-07-12, the full concept is built and merged to
main, but every flag below still defaults to `false` — nothing is visible or active for real users until
an explicit, separately-confirmed flag flip.

**Build batches (in order, each its own PR):**
1. **Batch 1 — pure convergence engine, no UI, no ingestion wiring.**
   ([#203](https://github.com/Andre-Weissmann/dataglow/pull/203), merged —
   `js/validation/source-convergence.js`: `buildConvergenceGraph(sources)` builds the join graph +
   connected components including transitive reachability; `computeConvergenceClusters(graph, sources)`
   groups rows into same-entity clusters with a coverage pattern and per-column agree/conflict
   analysis; `resolveClusterWithTrust(cluster, sourceTrust, { marginThreshold = 0.15 })` resolves a
   conflict to the highest-trust source only when the top-two trust margin ≥ threshold, else escalates
   — e.g. the mockup's Roster·Adj 0.75 vs CMS Elig. 0.65 → margin 0.10 → escalate; and
   `summarizeConvergence(clusters)` renders "41 of 2,987 joined clusters need a human decision — 2,946
   auto-resolved by trust weight." Pure, DOM/DuckDB/network-free, never throws. 18 tests. Ships DARK
   behind the `sourceConvergence` flag, default `false`.)
2. **Batch 2 — ingestion adapters.** ([#204](https://github.com/Andre-Weissmann/dataglow/pull/204),
   merged — `js/validation/source-convergence-ingestion.js`: `adaptExcelWorkbook` (one source per
   tab), `adaptApiSource`/`adaptSiteExport` (shared defensive JSON unwrapping + provenance),
   `inferJoinKeys`, `assignDefaultTrust`, `toEngineSources`. 24 tests including end-to-end integration
   proving adapter output feeds straight into Batch 1's engine. Ships DARK behind
   `sourceConvergenceIngestion`, default `false`.)
3. **Batch 3 — UI wiring.** ([#205](https://github.com/Andre-Weissmann/dataglow/pull/205), merged —
   new Convergence tab, absent from the DOM (not just CSS-hidden) when its flag is off. Source rail,
   coverage matrix with Resolved/Escalate pills, verdict/summary banner, and click-to-expand
   escalation detail showing the conflicting values, sources, and trust margin. Honest empty state
   when no sources are loaded — no fabricated demo numbers. Assigned to the Trust stage in the Command
   Deck sidebar alongside Validate/Diff/Meeting/Diplomacy/Proofroom. 20 tests. Ships DARK behind
   `sourceConvergenceUI`, default `false`.)

**To go live:** each of the 3 flags (`sourceConvergence`, `sourceConvergenceIngestion`,
`sourceConvergenceUI`) needs its own separate, explicitly confirmed flip to `true` in
`flags.manifest.json` — per this repo's standing rule, enabling is never bundled with the build/merge
step that shipped it dark.

---

## Concept in progress: Trust Beam

**One sentence:** turn an existing sealed check result into a self-contained, shareable
link that a recipient with ZERO DataGlow install can open in any browser and have the
seal re-verified live, client-side, with no server and nothing uploaded anywhere.

**Why it fits DataGlow:** it is the natural "last mile" of the Trust Passport line —
the Verifiable Check Seal (Batch 3) already produces a portable, offline-re-verifiable
artifact, but sharing it today means handing someone a `.json` file and asking them to
trust a verifier. Trust Beam keeps the exact same seal/Merkle logic UNCHANGED and only
adds a transport wrapper: the whole seal rides inside a URL fragment (which the browser
never sends to a server), so the privacy/offline guarantee is preserved end-to-end and
the recipient needs no install, no login, and no upload. It composes existing code
(no new crypto), mirrors the suite's honest-naming discipline (still not a
zero-knowledge proof, not a certification, not "blockchain"), and lowers the on-ramp
for the auditor/partner-org/regulator persona the whole Trust Passport was built for.

**Build batches (in order, each its own PR):**
1. **Batch 1 — pure serializer + standalone verifier page + UI affordance, behind a
   flag.** (DONE — [#151](https://github.com/Andre-Weissmann/dataglow/pull/151) —
   `js/provenance/trust-beam.js`: `encodeBeam`/`decodeBeam` (lossless base64url round-trip
   of the seal inside a versioned envelope), `buildBeamUrl` (payload in the URL fragment,
   never sent to a server), `readBeamPayloadFromFragment`; a standalone `verify-beam.html`
   at the repo root that reads the fragment, calls `decodeBeam` then the EXISTING
   `verifySeal()`, and renders a plain-language Verified/Tampered verdict client-side with
   zero install/server/upload; and a "Beam it" button next to the existing "Seal this
   result" button in `js/app-shell/main.js`. Real tamper detection verified in
   `test/trust-beam.test.mjs` (40/0 passing). Ships DARK behind `trustBeam` (default OFF);
   with the flag off the app is byte-for-byte unchanged.)
2. **Batch 2 — optional data-match hint in the verifier.** NOT STARTED. Let a recipient who
   HAPPENS to hold the data drop a file into `verify-beam.html` to run the seal's optional
   layer-2 data-fingerprint match locally (still zero-upload); today the standalone page does
   the commitment/integrity layer only, which is all a recipient-without-data can check.
3. **Batch 3 — promote `trustBeam` to ON.** (SHIPPED, [#164](https://github.com/Andre-Weissmann/dataglow/pull/164) —
   promoted alongside the rest of the Trust Passport chain (`verifiableCheckSeal`,
   `dataNutritionLabel`, `syntheticDataPassport`) after the verifier was dogfooded, following
   the same visibility-flag discipline as the Readiness Gate badge promotion (see Lessons
   learned — landing dark is not the same as shipped/visible). The "Beam it" button now
   renders next to "Seal this result" in the SQL tab; the standalone `verify-beam.html` and
   the seal/Merkle logic are unchanged. Turning `trustBeam` back off fully restores the
   byte-for-byte prior behavior — and because the button is only reachable through the seal
   card, it is inert unless `verifiableCheckSeal` is also on.)

**Explicitly out of scope:** QR code rendering. Considered during Batch 1 and intentionally
rejected, not deferred — the copyable link is sufficient and no QR encoder should be vendored
for this feature.

---

## Concept in progress: The Crucible

**One sentence:** every AI agent's proposed data change now has to survive an adversarial
"crucible" test from a second agent before it's applied — and every change that does get
applied, human or agent, lands in a reversible ledger where a user can click any cell and
instantly see who changed it, why, and undo it with one click.

**Why this concept won this brainstorm round (2026-07-13, whole-product/revolutionary scope):**
- Confirmed via research (`research_competitive_scale_2026-07-13.md`) that a data-quality-specific
  adversarial/red-team validator — one agent deliberately constructing nasty edge cases to stress-test
  a cleaning agent's output — is NOT a shipped named product anywhere surveyed (Salesforce Agentforce,
  Palantir Foundry, Databricks, Snowflake, Microsoft, Alteryx). Genuine whitespace, not an incremental
  feature.
- Targets a gap even Palantir's own developer community calls out as unsolved: reverse/bidirectional
  provenance (edit → the agent run that caused it), not just forward blame. DataGlow's local,
  single-tenant architecture makes this cheap to build well where multi-tenant platforms can't.
- Uses Salesforce Agentforce's most portable pattern (`@utils.transition` one-way vs `@topic`
  round-trip) as the typed-handoff-contract model between the Cleaning Agent and the Crucible Validator.
- Has a concrete, already-diagnosed proof case ready to test against on day one: the two AHIMA-pattern
  gaps (name-order swap, SSN transposition) documented as uncaught by `js/cleaning/fuzzy-dedup.js` in
  the 2026-07-12 test findings below.
- Confirmed non-duplicative against existing repo code: `js/provenance/data-blame.js` has forward
  blame/replay but no revert/undo action; `js/agents/agent-action-firewall.js` is pre-action gating,
  not adversarial testing; `js/gate/` (AI Readiness Gate) is a separate, already-shipped concept.

**Live desktop + mobile preview (mockup only, not the real app):** built and deployed from a standalone
copy of DataGlow's real UI shell (not the production repo) — desktop + mobile screenshots QA'd, one
concept-pill overflow bug found and fixed, two internal content-consistency issues in the mock
Provenance Ledger example caught by the deploy tool's own validator and fixed. Shared with the user as
a live link; never touched `main`.

**Safety assessment (stated before the build gate, 2026-07-13):** the full concept touches a
meaningful surface — new adversarial agent module, a typed handoff schema layered onto the existing
provenance trail, a new UI tab, and a real revert action that mutates applied data. Split into 3
batches/PRs rather than one shot, specifically because the revert action carries real blast-radius risk
(silently un-reverting the wrong change) that the other two pieces don't.

**Build batches (in order, each its own PR, each its own flag):**
1. **Batch 1 — typed handoff contract + adversarial test-pack library. Pure logic, no UI, no data
   mutation.** (DONE — [#227](https://github.com/Andre-Weissmann/dataglow/pull/227), merged into `main`
   2026-07-13 — `js/validation/crucible-contract.js`: `buildCleaningResult()` / `buildValidationVerdict()`,
   never-throw discipline, one-way-in/one-way-out handoff framing in comments. `js/validation/
   crucible-adversarial-packs.js`: `nameOrderSwapPack`, `ssnTranspositionPack`, `boundaryDatePack`,
   `impossibleValuePack`, `runAdversarialSuite()`. Deterministic fixed fixtures, no `Math.random`.
   Integration tests run `nameOrderSwapPack` + `ssnTranspositionPack` against the REAL
   `findFuzzyDuplicates()` and confirm both packs correctly FAIL against it — 6/6 name-order-swap and
   6/6 SSN-transposition pairs go uncaught, empirically reconfirming the AHIMA gaps documented
   2026-07-12 (a real gap, not a regression introduced by this PR). 43+20 new tests passing, 5/5
   existing fuzzy-dedup regression tests still passing, 53/53 CI checks green. Ships DARK behind
   `crucibleValidator` (default OFF, confirmed `false` on `main` post-merge); with the flag off nothing
   in the app imports these modules, so every existing path is byte-for-byte unchanged.)
2. **Batch 2 — Crucible UI tab (read-only surface for Batch 1's output).** (DONE —
   [#230](https://github.com/Andre-Weissmann/dataglow/pull/230), merged into `main` 2026-07-13 —
   `js/validation/crucible-ui.js`: the pure, Node-testable view-model builders `shouldOfferCrucible` /
   `buildPipelineModel` (Clean Agent → Crucible Validator → Provenance Ledger, each step idle/running/done
   + its contract fields) / `buildAdversarialPackListModel` / `buildRunLogModel` (pack pass/fail + an
   escalation callout), split from the browser-only renderer `mountCrucible` following the
   `sourceConvergenceUI`/`room-ui.js` pattern. New flag-gated read-only "Crucible" tab; no new
   data-mutation code path — a pure view over Batch 1's already-computed results, rendering an honest
   empty state (never fabricated demo numbers). Ships DARK behind `crucibleValidatorUI` (a SEPARATE flag
   from Batch 1's `crucibleValidator`, default OFF); with the flag off the tab is never in the bar and the
   whole app shell is byte-for-byte unchanged.)
3. **Batch 3 — revert PROPOSALS on the provenance blame trail (proposal-only, DELIBERATELY narrowed).**
   (DONE — [#231](https://github.com/Andre-Weissmann/dataglow/pull/231), branch
   `feat/crucible-batch3-revert-proposals` — `js/provenance/revert-eligibility.js`: pure, never-throwing
   `classifyRevertEligibility` / `buildRevertProposal` / `summarizeRevertProposals`, reusing
   `normalizeBlameEntry` from `js/provenance/data-blame.js` as the single blame-entry shape. After
   inspecting the real cleaning code (`js/cleaning/clean.js` `applyFix`), the scope was narrowed to
   PROPOSALS ONLY: the module classifies whether a recorded fix is revert-eligible in principle and, for
   eligible ones, emits an INERT, inspectable data description of the revert (`{ table, column, predicate,
   restoreValue, sourceStepHash, humanDescription }`) — it emits NO executable SQL and NEVER mutates data.
   DELETE-style fixes (`drop_rows`, `dedupe`) and aggregate-derived fills (`fill_mean`, `fill_mode`) are
   PERMANENTLY and correctly NOT revert-eligible (rows are gone / value computed from the data at fix time
   → naive undo would silently diverge); UPDATE-style fixes (`fill_zero`, `abs_value`, `null_out`, `trim`)
   are eligible only when the trail actually captured usable before/after values, and anything ambiguous
   is conservatively treated as not eligible, never fabricated. Ships DARK behind its own flag
   `crucibleRevertProposals` (default OFF); with the flag off nothing imports the module, so every existing
   path is byte-for-byte unchanged.)

**Explicitly out of scope — live revert execution was deliberately NEVER built, not deferred to a numbered
batch:** the original 3-batch sketch imagined Batch 3 as a real "one-click revert" that *mutates
already-applied data*. After inspecting the real cleaning code, that was deliberately abandoned as too
high-risk to ship blind: Batch 3 as delivered stops at inert, inspectable revert PROPOSALS. Actually
EXECUTING a revert against live DuckDB would be brand-new, separate future work needing its own safety
review — it is NOT an already-planned or already-numbered next batch, and nothing above should be read as
committing to it. Separately, the full Clean → Validate → Model → Narrate orchestration pipeline
(auto-applying only Crucible-accepted changes) also remains real future work that no batch above scoped —
Batch 1 ships the contract types only, and no orchestration layer consumes them yet.

---

## Concept in progress: The Rigor Engine

**One sentence:** every number DataGlow shows (a query result, an aggregate, a chart, a Story claim)
carries its own statistical confidence, and any AI agent must state that confidence or refuse.

**Why this concept won this brainstorm round (2026-07-17, revolutionary/flagship scope, grounded in the
2026-07-17 run 3 founder's-readiness-audit test findings above):** the audit's central finding was that
DataGlow can be right on the raw defect-detection layer while still letting a human or an AI agent draw an
overconfident conclusion from a *result* (small sample, unadjusted multiple comparisons, an aggregate that
reverses at the segment level) with nothing in the UI or the agent gate saying so. This concept closes that
gap directly, and does it in a way distinctive to DataGlow's existing architecture: it slots underneath
both the already-shipped AI Readiness Gate (a new refusal reason code) and Analysis Robustness (Devil's
Advocate / robustness-verdict), rather than duplicating either. Directly serves the five demands this
brainstorm was scoped against: portfolio/resume dataset trust (a claim with a stated confidence is a
defensible claim), best-in-class analytics/science tooling (CI/effect-size/multiple-comparison rigor is
standard practice in real data science and near-absent from BI-style tools), all-in-one-platform demand (no
new external stats package needed), privacy/math-rigor/infrastructure (100% on-device, zero new
dependency), and ingest-any-data-deliver-insights (confidence travels with every insight regardless of
source format).

**Build batches (each its own PR, dark by default, per standing convention):**
1. **SHIPPED (PR #294, merged 2026-07-17, `99af7ba`).** Pure stats module
   `js/rigor/statistical-rigor.js` — `confidenceIntervalForMean`, `classifySampleSize`/
   `classifyConfidence` (n<10 insufficient, n<30 low, n>=30 sufficient — never overstates a small
   sample), `cohensD`, `bonferroniAdjustedAlpha`, `detectSimpsonsParadox`. 42 tests, zero DOM/network/
   DuckDB dependency (verified by a source-scan test). Tests only — no UI or agent wiring yet, so no
   flag decision was needed for this batch.
2. **Not yet started.** Wire CI/effect-size badges onto SQL result tables and Visualize; this batch is
   also the fix point for the SQL→Visualize charting gap noted in the run 3 test findings. New flag,
   ships `enabled: false`.
3. **Not yet started.** Extend the AI Readiness Gate (`js/gate/agent-gate.js`) with a new
   `statisticalConfidence` reason code so an agent handed a low-confidence result must say so or refuse.
   New flag, ships `enabled: false`.
4. **Not yet started.** "Verified by DataGlow" exportable certificate for portfolio/resume use — the most
   direct answer to the portfolio/resume-trust demand that started this brainstorm. New flag.

Each batch gets its own merge confirm and, since Batches 2-4 all change agent- or user-facing behavior,
its own separate, explicitly confirmed flag-enable decision — never bundled with the merge confirm, per
standing rule.

---

## Shipped: The Proof Room

**One sentence:** one assembled "show your work" screen that composes DataGlow's five
existing, independently-shipped trust surfaces — Metric Studio, Trust Strip, Data Nutrition
Label, Verifiable Check Seal, and Trust Beam — top to bottom in a fixed order, so an analyst
can hand a single link/screen to a skeptical stakeholder instead of hunting across five tabs.

**Why it fits DataGlow:** pure composition, zero new trust surface. Every one of the five
modules it assembles already exists, is already tested, and already carries its own honest
naming discipline (not a certification, not blockchain, not a zero-knowledge proof) — the
Proof Room adds no new crypto, validation, backend, or AI model, only a presenter that calls
each module's existing render/build function verbatim, in order. It directly answers the
research's repeated "trust is scattered across tools" complaint by giving the assembled-proof
view its own front door instead of asking a stakeholder to piece it together tab by tab.

**Preview:** a live desktop + mobile mockup was built, deployed, and approved before any real
repo changes — [https://www.perplexity.ai/computer/a/dataglow-proof-room-concept-Y4RLRbasQN.x_xGunJmdSA](https://www.perplexity.ai/computer/a/dataglow-proof-room-concept-Y4RLRbasQN.x_xGunJmdSA)
(sandbox-only artifact, never touched `main`).

**Build batches (in order, each its own PR):**
1. **Batch 1 — new tab, dark behind a new umbrella flag.** (DONE —
   [#168](https://github.com/Andre-Weissmann/dataglow/pull/168) — new
   `js/provenance/proof-room.js` holds a pure, never-throwing step-order/readiness aggregator
   (`buildProofRoomPlan`) plus a thin DOM presenter (`renderProofRoom`); wired into
   `js/app-shell/main.js` as `renderProofRoomTab`, gated behind a single new umbrella flag
   `proofRoom` (ships dark, `enabled:false`) that gates ONLY this composed tab's visibility —
   the five underlying modules' own flags are untouched, and each module's render function is
   called directly since none of them gate on their own flag internally. Added the `proofroom`
   tab to `TAB_META`, the trust stage in Command Deck nav, tab-groups, and `state.tabOrder`,
   mirroring the exact `meeting`/`meetingScribe` and `diplomacy`/`dataDiplomacy` conditional-
   filter pattern. `test/proof-room.test.mjs` — 30/0 passing. While this PR was in flight, ten
   unrelated PRs landed on `main` promoting `dataNutritionLabel`, `verifiableCheckSeal`,
   `trustBeam`, `syntheticDataPassport`, `groupedNavigation`, `validateFocusMode`,
   `dataDiplomacy`, and the Meeting/SQL-analysis flags to ON — the branch was rebased onto the
   new `main`, all conflicts resolved preserving both sides, full suite re-verified green
   (94/0), and merged squash.)
2. **Batch 2 — promote the two remaining underlying flags + fix an unrelated race bug found
   during the audit.** (DONE — [#170](https://github.com/Andre-Weissmann/dataglow/pull/170) —
   originally scoped to promote all five underlying flags, narrowed to just `metricStudio` and
   `trustStripProofDrawer` since the other three were already promoted by the parallel PRs
   above. Both flags flipped to `enabled:true` with `promotedInPR` recorded; no open
   tech-debt-tracker item referenced either module, so nothing blocked promotion. Also fixed
   the golden-test-dataset race bug identified during Phase 1 audit: `runDatasetLoad()` in
   `js/app-shell/main.js` had no reentrancy guard, so two overlapping calls (e.g. a fast
   double-click on "Load Golden Test Dataset", or the Red Team Mode button firing the same
   path) could race through `createTableFromRows()`'s `DROP TABLE IF EXISTS`/`CREATE TABLE`
   pair in `js/app-shell/duckdb-engine.js` and throw "Catalog Error: Table ... already exists."
   Added a module-level `datasetLoadInFlight` guard — a call while a load is already in flight
   is now a safe no-op instead of racing, with a `finally` reset so Retry and later sequential
   loads still work. New `test/golden-dataset-load-race.test.mjs` (4/4) source-asserts the guard
   and proves the concurrency semantics via a lockstep runner, since `main.js` isn't headless-
   importable in this repo's test setup. Full suite: 95/0 passing after the fix, up from 94/0
   before. With both flags now ON, Metric Studio and the Trust Strip/proof drawer render live
   in the Validate tab by default — the Proof Room's first two composed steps are no longer
   placeholders for anyone with the tab flag on.)

3. **Batch 3 — promote `proofRoom` to ON.** (DONE —
   [#173](https://github.com/Andre-Weissmann/dataglow/pull/173) — with all five composed
   modules confirmed ON, flipping the umbrella flag was a pure visibility promotion: no code
   change needed beyond the flag flip itself (`renderTabBar()`'s sole gate is
   `isEnabled('proofRoom')`; `renderProofRoomTab()` already assembles all five steps once a
   dataset is loaded). Full suite: 95/95, identical before and after. The Proof Room tab is now
   live in the tab bar by default for every user with a dataset loaded. Turning `proofRoom`
   back off fully restores prior behavior (tab disappears from `state.tabOrder`,
   `#panel-proofroom` stays empty) as a safe kill-switch.)

**Shipped, live by default.** All three batches are done and the `proofRoom` flag is
`enabled:true` — this concept is no longer "in progress."

---

## Shipped (dark, flag off): AI Touch Ledger

**One sentence:** a tamper-evident, hash-chained log of every time an AI model actually
touches a dataset during Story generation — which model, whether the call stayed on-device
or left the browser, which fields/columns it was shown, and what human action triggered it
— so "was my data ever sent to an external AI provider, and when" has a real, exportable
answer instead of a policy promise.

**Why it fits DataGlow:** the Story Engine is the one place in the app where a query result's
real column values can leave the browser (external providers: OpenAI/Anthropic/Gemini/
Perplexity), and until this concept nothing recorded that fact anywhere the user could see or
export. It reuses the EXACT `sha256Hex` primitive from `js/provenance/provenance.js` — no new
crypto — and mirrors the Assumption Ledger's summarize/export contract, so it slots into the
existing Provenance/Trust surface rather than inventing a new one.

**Build batches (in order, each its own PR):**
1. **Batch 1 — pure primitive, no wiring.** (DONE —
   [#201](https://github.com/Andre-Weissmann/dataglow/pull/201) — `js/provenance/
   ai-touch-ledger.js`: `createTouchLedger()` factory exposing `logTouch(touch)` (async, never
   throws — malformed input becomes a `rejected:true` entry), `getEntries()`, `clear()`;
   `verifyTouchLedger()` re-derives every entry's hash and detects tamper/delete/reorder;
   `summarizeTouchLedger()`/`exportTouchLedger()` (json/markdown/text). 31/31 tests. Behind the
   new `aiTouchLedger` flag, default OFF. Module only — nothing in the app imported it yet.)
2. **Batch 2 — wire into the Story Engine + Proof Room.** (DONE —
   [#206](https://github.com/Andre-Weissmann/dataglow/pull/206) — `js/narrative/story.js`
   gained a private `logStoryTouch()` helper called from inside `generateStory()`, injected via
   `opts.touchLedger` (DI, same pattern as `opts.ondeviceGenerate`, so `story.js` still never
   imports the ledger module directly). Logs an on-device touch only on real on-device success;
   logs an external touch on BOTH external success and external failure-AFTER-send (the request
   body, containing the real query-result columns, already left the browser before a non-OK
   response triggered the local fallback — not logging that would misrepresent what actually
   happened); never logs for rule-based/no-key paths that never attempt a network call.
   `js/app-shell/main.js` holds one lazily-created singleton, only populated when the flag is on,
   plus a new panel (`renderAiTouchLedgerPanel`/`initAiTouchLedgerPanel`, modeled on the
   Assumption Ledger panel) in a new `#ai-touch-ledger-wrap` block in `index.html`'s Story tab.
   `js/provenance/proof-room.js` gained a sixth composed step, ready purely based on the flag
   (independent of dataset/validation state). New `test/ai-touch-ledger-story-wiring.test.mjs`
   (25/25) plus `test/proof-room.test.mjs` updated for the 6th step (38/38, was 33). Capability-
   map updated, 0 drift. All 35 CI jobs green including `tauri-smoke`. Flag-off path verified
   byte-for-byte unchanged: `touchLedger` is `undefined` in `opts` when the flag is off, so
   `logStoryTouch()` early-returns before doing anything.)

**Shipped, dark behind `aiTouchLedger` (default `false`).** Both batches are done — the full
feature (primitive + real wiring + UI + Proof Room step) exists in `main` today, but stays
inert for every user until the flag is separately, explicitly enabled. Enabling it was
intentionally deferred as its own later confirmed action, per this repo's standing
build/merge-vs-enable convention.

**Open question for a future session:** confirm with the user whether "Source Convergence"
(built in parallel this same window — [#203](https://github.com/Andre-Weissmann/dataglow/pull/203)/
[#204](https://github.com/Andre-Weissmann/dataglow/pull/204), `js/validation/source-convergence.js`,
flag `sourceConvergence`) is the "convergence layer" they asked about earlier. These are NOT the
same concept: AI Touch Ledger is AI-activity provenance/audit (did an AI model see this data, and
did it leave the browser); Source Convergence is cross-table/N-way data consistency (do multiple
loaded sources agree on a shared fact about the same real-world entity).

---

## Test findings (2026-07-12 run — "Test DataGlow Platform" program)

A full research + rubric + hands-on live test + architecture brainstorm pass was run against DataGlow
using a synthetic messy healthcare claims dataset with a known answer key, graded against a
senior-analyst/engineer/scientist rubric. Full write-up: workspace `dataglow_test_data/dataglow_roadmap_2026-07-12.md`
(also: `dataglow_test_rubric.md`, `dataglow_test_data/dataglow_test_results_2026-07-12.md`,
`dataglow_architecture_brainstorm.md`). Top items to pull next, ranked:

1. **P0 — Fix coverage/consistency gaps between panels that claim to catch something and don't.**
   Verified this run: Cross-Column Logical Consistency reported PASS despite 6 real allowed>billed
   violations; the Unit Test Layer's own "referential integrity" check didn't surface a confirmed
   orphan claim; Missingness Detective narrated one column's missingness but not another's; Preflight's
   duplicate check only catches byte-identical rows and missed 16 real business-key duplicates that
   Validate's own layers are built to catch. None of this needs new capability — it's a coverage/wiring
   fix, cheaper than a new feature and higher-trust-impact than one.
2. **P1 — Protect, don't regress, two verified differentiators:** Story's honest low-confidence
   caveats (n=6, Confidence D, explicit "treat this cautiously" language) and the empirically-verified
   zero-upload architecture (9 outbound calls across the full core flow, all Google Fonts, zero dataset
   content). Small fix: self-host Google Fonts or soften the README's "fetches nothing from a third
   party" claim, since Fonts is in fact a live third-party call every load.
3. **P2 — Two scoped, buildable gaps:** NCCI procedure-to-procedure edits/MUE ceilings (natural fit as
   a Healthcare Billing domain-pack extension) and an AHIMA fuzzy-patient-matching catch-rate benchmark
   test (cheap — the 12 seeded near-duplicate patients already exist in the test dataset, just need to
   actually run Clean/fuzzy-dedup against `patients.csv` rather than `claims.csv`).
4. **Cross-platform/scale architecture — six options, no single mandate yet** (see
   `dataglow_architecture_brainstorm.md` for full detail): OPFS persistence and chunked/streaming
   ingestion are pure client-side, low/medium cost, zero identity risk, and should come first regardless
   of later choices. Native DuckDB in Tauri (desktop-only, no WASM ceiling) is the biggest pure-client
   ceiling jump. A DIY sharded-worker approach is unproven/high-risk. An optional local/LAN DuckDB
   "Quack" companion server (DuckDB's own new protocol, shipped May 2026) is the only path that could
   raise the ceiling for the browser build itself, not just desktop, while staying user-owned/opt-in.
   Bring-your-own-warehouse (`databricks-connect.js` already exists experimentally) has the largest
   ceiling but comes closest to blurring the zero-upload identity for opted-in users. **Note:** WASM
   Memory64 looked like an obvious fix for the 4GB ceiling but has zero Safari support as of mid-2026 —
   not recommended as a near-term lever.
5. **Untested follow-ups for the next test pass:** OMOP gender-discordant concept check, chart
   sniff-tests (needs an actual generated chart), Metric Studio's own definition-locking feature
   specifically, Tauri-build offline verification, and re-running Clean/fuzzy-dedup against the patient
   file specifically.

## Test findings (2026-07-12 run 2 — cross-industry / retail domain-pack audit)

A second pass of the "Test DataGlow Platform" program, this time targeting cross-industry versatility:
a new synthetic retail/e-commerce dataset (411 products, 1,535 orders, known answer key) built
specifically to exercise all three rules of the existing, already-shipped `RETAIL_PACK_DESCRIPTOR`
(`js/validation/domain-physics.js`) with both true-positive and adjacent trap cases. Full write-up:
workspace `dataglow_test_data_retail/dataglow_roadmap_2026-07-12_run2.md` (also:
`dataglow_test_data_retail/dataglow_test_results_2026-07-12_run2.md`, `answer_key.md`). Platform tested:
web only (desktop/mobile and the remaining healthcare rubric items are still open from Run 1). Top
items to pull next, ranked:

1. **P0 — `retail-sku-no-merge` is architecturally unreachable for its stated purpose.** The rule
   itself is correctly implemented (marks matched columns `sensitive: true` in the Categorical
   Consistency Engine), but neither feature that could act on a merge suggestion ever gives it a
   chance to fire for a realistic SKU column: `detectColumnClusters()` hard-skips any column with
   >200 distinct values (a real SKU column is near-unique by definition — 408 distinct in our
   411-row test), and the Clean tab's separate Fuzzy Duplicate Radar (`js/cleaning/fuzzy-dedup.js`)
   only ever scans one auto-picked column per table via a name regex that doesn't match `sku` at all
   and has zero domain-pack awareness anywhere in the file. A user trusting the pack's own
   description gets no actual protection on the column it's named for, with no visible error or
   "skipped" signal. Two independent fixes proposed: (a) exempt pack-matched `no-merge` columns from
   the 200-distinct cap, and/or (b) give `fuzzy-dedup.js` domain-pack awareness directly, since that's
   the module analysts are more likely to actually act on.
2. **P1 — SQL tool: `CAST(col AS DOUBLE)` throws a hard error on empty-string values instead of
   treating `''` as NULL.** Blocked 2 of 12 ground-truth checks this run (`Conversion Error: Could not
   convert string '' to DOUBLE`). Real, reproducible friction for a common real-world data shape (blank
   strings, not true NULLs). Suggested fix: pre-clean blanks to NULL before numeric CASTs, or catch
   this error class and surface an actionable message instead of a raw DuckDB error string.
3. **P2 — Confirm `retail-seasonal-outlier`'s R7-vs-R8 distinction at the Validate-UI level, not just
   SQL.** The rule is genuinely wired into `applyDomainPack()` and did reinterpret `unit_price`
   outliers as "expected retail variation" — confirmed working, unlike item 1. Not yet confirmed: does
   the underlying MAD/IQR detail list still individually flag the 5 true-error rows after the
   column-level reinterpretation note is applied, or does the leniency note mask them from the human
   view too? SQL-level data is intact (5/5 match) but the Validate UI's row-level behavior wasn't
   independently checked this run.
4. **P3 — Test the Finance pack next.** `finance-ledger-account-no-merge` almost certainly has the
   identical structural gap as item 1, since GL/ledger codes are the same "near-unique identifier
   column" shape. Cheap to check: a small targeted fixture, not a full new dataset.
5. **What worked and should be protected (corroborated across two independent domains now):**
   zero-upload architecture (confirmed again via full network capture on the retail dataset — no
   dataset content left the browser); Story's honest low-confidence self-flagging (correctly caveated
   a 4-row query result as "Confidence: D" and noted it reflects only the current query); and the
   generic (non-pack) validation layers' correctness generalized cleanly to an entirely new domain —
   every SQL ground-truth check that didn't hit the CAST bug matched the seeded defect exactly.
6. **Untested follow-ups still open:** Tauri desktop and mobile/PWA testing (never run across either
   pass), remaining ~26 of 37 healthcare rubric items from Run 1, Finance pack audit (item 3 above),
   R9's exact-count discrepancy in this run (31 observed vs. 15 seeded — flagged as an inconclusive
   test-tolerance issue pending hand-reconciliation, not attributed to DataGlow).

## Test findings (2026-07-12 run 3 — Finance pack + Desktop + Mobile)

A third pass of the "Test DataGlow Platform" program, closing out everything deferred across Run 1 and
Run 2: the Finance domain pack's architecture-unreachability hypothesis, Desktop (Tauri) testing, and
Mobile (PWA) testing. Full write-up: workspace `dataglow_test_data_finance/dataglow_roadmap_2026-07-12_run3.md`
(also: `dataglow_test_data_finance/dataglow_test_results_2026-07-12_run3_finance.md`, `answer_key.md`).
Top items to pull next, ranked:

1. **P0 (NEW, highest priority across all 3 runs) — Clean tab's "Scan for Issues" early return can hide
   Fuzzy Dedup/Missingness/Format panels for ANY dataset, not just a specific domain pack.**
   `scanClean()` in `js/app-shell/main.js` calls `clean.scanForIssues()`, which checks only 4 narrow
   things (nulls, exact-duplicate rows, whitespace, negative "amount"-named columns). If none of those 4
   are present, the function renders "No issues found" and returns early — before `renderFuzzyDedup`,
   `renderMissingness`, and `renderFormatIssues` ever run. Confirmed on a finance ledger-accounts table
   with zero qualifying issues by those 4 measures: direct module testing found 1,273 real near-duplicate
   pairs (including all 6 seeded near-dup account-name pairs at 0.983-0.993 similarity) that the UI never
   surfaced. This is dataset-shape-dependent, not pack-dependent — it can hide real defects in any CSV
   (healthcare, retail, finance, or otherwise) that happens to be clean by those 4 narrow measures.
   Suggested fix: decouple the three deeper panel-rendering calls from the early return so they always
   run, independent of whether `scanForIssues`'s narrower checklist found anything.
2. **P1 — `finance-ledger-account-no-merge` reproduces the identical architecture-unreachability bug as
   `retail-sku-no-merge` (Run 2), confirming this is a structural pattern, not a one-off.** 272 distinct
   `gl_account_code` values / 278 rows never appeared anywhere in the Categorical Consistency Engine's
   output (200-distinct cap in `categorical-consistency.js:164`), exactly like retail SKU. Two domain
   packs in a row hit the identical wall on their own signature no-merge rule. Fixes proposed in Run 2
   still apply; note fixing P0 above does not automatically fix this too, since `fuzzy-dedup.js`'s column
   auto-pick regex still wouldn't match `gl_account_code`-shaped names — both fixes are needed together.
3. **P2 (NEW, mobile) — the mobile tab bar has no visible scroll affordance.** `nav.tabbar.tabbar-grouped`
   is 1,370px of tabs (13 tabs, 5 groups) packed into a ~412px mobile viewport and is genuinely
   scrollable (`overflow-x: auto`), but has no scrollbar, arrow, or edge-fade hint, and doesn't
   auto-scroll the active tab into view. Confirmed identically on Pixel 7 and iPhone 14 emulation
   profiles — everything past the first 4-5 tabs (Clean, Validate, Diff, Diplomacy, Proof Room, SQL,
   Python, R, Visualize, Story, Digital Twin, Watch Folder, Meeting) is effectively undiscoverable on a
   phone without already knowing to swipe the header. All underlying features work correctly once
   reached — this is a discoverability gap, not a logic bug.
4. **P3 — Desktop (Tauri) functional automation still blocked by environment, not by DataGlow.** This
   round's sandbox (Ubuntu 26.04) can't compile the Tauri v1 shell locally — only ships
   `libwebkit2gtk-4.1-dev`, not the `4.0` series Tauri v1 needs, the same version ceiling the project's
   own CI comments already document (`ubuntu-22.04` pinned for this exact reason). The compile-gate
   signal itself is solid (`tauri-smoke` has passed twice now, PR #178 and PR #180). Functional
   automation via `tauri-driver`/WebdriverIO still needs either a real Ubuntu 22.04 box or a dedicated
   CI job — proposed as a new opt-in (non-blocking) workflow, since it would be the only test surface
   that can catch native-webview-specific bugs (CSP/allowlist, IPC timing) that the byte-identical-assets
   browser tests structurally cannot.
5. **What worked and should be protected (corroborated a third time):** zero-upload architecture now
   confirmed on mobile viewport too (service worker reaches `active`, full offline reload renders the
   complete UI shell with zero errors); the proactive anomaly-to-rule-teaching UX pattern (Validate
   surfacing a negative `debit_amount` minimum with actionable "teach DataGlow a rule" buttons) is a
   genuine, repeatable strength.
6. **Untested follow-ups still open:** Tauri functional automation (item 4), real-device (not emulated)
   WebGPU check, remaining ~26 of 37 healthcare rubric items from Run 1, Run 2's R9 count discrepancy and
   P2 (retail-seasonal-outlier row-level UI confirmation), and whether the P0 Clean-tab bug reproduces
   identically at mobile viewport (logically expected, same code path, not independently re-verified).

**Practical readiness verdict (asked directly this run):** DataGlow's core data-quality logic (Preflight,
the 20-layer Validate report, SQL cross-checks) has now matched hand-built ground truth almost exactly
across three different domains (healthcare, retail, finance) with pre-known answer keys, and the
zero-upload claim has held up under direct network monitoring three times running. Safe to use for real
work today, with two informed caveats: don't treat a Clean-tab "No issues found" as conclusive (P0 above
means it may not have actually checked for near-duplicates/missingness/formatting), and don't rely on
high-cardinality domain-pack no-merge protection until P1 ships. Neither gap produces a silently wrong
answer — both are "didn't show you something it could have," not "showed you something incorrect."

## Test findings (2026-07-12 run 4 — remaining healthcare rubric items)

A fourth pass of the "Test DataGlow Platform" program, closing out the hardest remaining items from the
original 37-item healthcare rubric: cross-table temporal plausibility (death-date washout), OMOP
clinical concept-domain checks, AHIMA's two toughest patient-matching failure patterns (name-order swap,
SSN transposition), NCCI/timely-filing claims rules, and UX/positioning checks (Metric Studio, sniff
test, Context Card reordering). Fresh seed=77 fixture set, independent from Run 1's seed=42 data. Full
write-up: workspace `dataglow_test_data/dataglow_test_results_2026-07-12_run4.md`. Web-only this round
(desktop/mobile parity not re-verified). Top items, ranked:

1. **P0 (NEW, highest priority — elevated from a single-dataset observation to a confirmed cross-cutting
   bug) — Categorical Consistency Engine proposes destructive merges on high-cardinality unique-ID
   columns.** Independently reproduced on two unrelated datasets this run: `patient_id` in a vitals
   fixture (~150 distinct single-occurrence IDs proposed for merge into one canonical value) and
   `claim_id` in Run 1's original claims data (~40+ pairwise 98%-confidence merge suggestions based on
   pure digit-permutation string similarity, e.g. `"CLM100001" ≈ "CLM100010"`). If a user clicks "Apply
   Merge" on either, it silently destroys record-level identity across the dataset. Proposed fix:
   exclude columns that are >95% unique-valued (or explicitly flagged as primary/foreign keys) from
   automated merge-proposal eligibility; allow them to still surface as a lower-severity informational
   note if desired, but never as an auto-actionable "Apply Merge" button.
2. **P1 — No cross-table temporal/relational plausibility checking exists at all, even when multiple
   related tables are loaded in the same session.** Verified via SQL ground truth (cross-checked against
   an independent Python calculation) that 11 claims fall beyond a 60-day post-death washout window —
   zero validation layers reference death dates anywhere in the Validate output; Cross-Column Logical
   Consistency is confirmed scoped only to single-table checks. Same root cause likely explains why NCCI
   same-day conflicting-procedure pairs (3.3) and CMS timely-filing violations (3.5) are also both fully
   unimplemented — none of these are single-table statistical checks, they all require joining or
   cross-referencing two columns/tables with domain-specific logic. Suggested roadmap direction: a new
   "Cross-Table Relational Rules" layer (or an extension of Cross-Column Logical Consistency) that
   accepts a second table + join key + comparison rule, starting with the death-date washout case since
   it's the most clinically consequential.
3. **P1 — AHIMA's two dominant patient-matching failure patterns (name-order swap, SSN transposition) are
   both completely uncaught by the current fuzzy-dedup.** Built clean, unambiguous test fixtures (6 pairs
   each) for both patterns; Clean's "Scan for Issues" reported "No issues found" on every one. Root
   cause: the matcher appears to compare name-field strings directly (Levenshtein/Jaro-Winkler), and a
   full first/last swap produces two tokens with near-zero string similarity to each other despite being
   an obvious match once DOB+SSN are considered. This is a materially different, and per AHIMA's own
   research non-interchangeable, failure mode from the nickname/typo/suffix patterns that already pass
   (per Run 1). Suggested fix: add a DOB+SSN(-last4) exact-match pre-filter that, on a hit, checks
   name fields for a *token-set* match (order-independent) in addition to the existing character-level
   similarity — this would catch swaps without needing a fundamentally new matching algorithm.
4. **P2 — OMOP domain pack is shape-aware but not clinically-aware; FHIR domain pack is more mature by
   comparison.** Loading the built-in OMOP CDM Sample and injecting a gender-discordant clinical concept
   produced no flag anywhere (`gender_concept_id` is tracked statistically — correlation baselines,
   Benford eligibility — but never cross-checked against condition/measurement concept domains). This
   contrasts with Run 1's finding that the FHIR pack does implement real structural/binding/reference
   checks matching its disclosed scope. Suggested roadmap direction: bring OMOP pack depth up to FHIR
   pack parity, starting with `plausibleGenderUseDescendants`-style concept-domain checks since OHDSI's
   own DQD already publishes the reference check-type definitions to implement against.
5. **P3 — Visualize's sniff-test hygiene has three straightforward, low-effort fixes available.** Source
   inspection of `js/runtimes-viz/visualize.js` confirms: no forced y-axis zero-start (Plotly default
   auto-scale, a real exaggeration risk), no visible source/dataset attribution baked into exported PNG
   images (only in the filename), and no chart title set at all (axis labels only). All three are small,
   mechanical additions (a `layout.title` default of `"${yCol} by ${xCol} — ${table}"`, an optional
   forced-zero-start toggle, and a text annotation or corner watermark on export) rather than new
   capabilities — good near-term wins for the sniff-test rubric category.
6. **P3 — "Metric Studio" / metric-contract scaffolding exists but is feature-flagged off by default.**
   The UI, tooltip copy ("Define what a metric means so queries computing it differently get flagged"),
   and exploratory/reviewed/certified status vocabulary all directly match the metric-definition-drift
   rubric scenario's intent — but `#btn-define-metric` ships with `display:none` in the current build.
   Worth flipping on and finishing once a maintainer confirms it's ready, since the design groundwork is
   already sound.
7. **What worked and should be protected (corroborated a fourth time):** Context Card's reordering claim
   is real and empirically verified (supplying "for billing accuracy" measurably changed which findings
   surfaced first, while all 20 layers still ran in both cases, matching the UI's own disclosed scope);
   zero unqualified "AI-powered" marketing claims and zero signup/paywall friction found anywhere in the
   product, continuing a clean streak across all four runs; every ML-adjacent feature continues to cite
   its actual method and source paper in-UI rather than making vague AI claims; Watch Folder/Digital
   Twin/Metric Studio all have real shipped code + dedicated test files, not just roadmap copy.
8. **Untested follow-ups still open:** live functional testing of Watch Folder/Digital Twin (source +
   test-file existence confirmed, live interaction not yet exercised this run), Metric Studio's actual
   click-through behavior once un-flagged, Desktop/Tauri and Mobile/PWA re-verification of all Run 4
   findings (Run 4 was web-only), and confirming whether fixing the P0 ID-column merge bug introduces any
   regression on the legitimate near-duplicate cases that already pass today.

**Practical readiness verdict (asked directly this run):** Run 4 deliberately targeted the hardest,
most cross-table and clinically-specific remaining items in the healthcare rubric — this was a stress
test of DataGlow's most demanding domain claims, not a representative sample, and the section scores
reflect that (Section 3 in particular scored 0 Pass this run). Read alongside Runs 1-3, the pattern is
consistent: DataGlow's single-table, generic-statistical validation layers are mature and reliable, but
its cross-table and clinically-specific reasoning (death-date washout, NCCI, OMOP concept-domain checks,
two of three AHIMA name-matching patterns) is largely unimplemented today. None of these gaps produce a
silently wrong answer — they are "didn't check for this at all," not "checked and got it wrong" — but
they are real gaps between the healthcare-domain-pack marketing framing and current behavior, and P0-P2
above are now the highest-value next healthcare-domain build targets.

## Test findings (2026-07-15 run 5 — Portfolio-readiness targeted rerun)

A targeted, narrower rerun of the "Test DataGlow Platform" program (new named "Portfolio-readiness"
rerun mode, added to the skill this same run), scoped specifically to the question "would I trust this
on real data I'm publishing": Section 1 (Data Quality Dimension Checklist) in full, Section 3
(healthcare-specific rules) in full, and Section 5.1/5.5 (zero-upload/local-first privacy + offline
verification) only — Section 2 and remaining Section 5 items explicitly out of scope this round, per the
new rerun mode's own definition. Reused Run 1's seed=42 fixture set (already verified matching the
answer key). Web-only this round (desktop/mobile parity not re-verified). Full write-up: workspace
`dataglow_test_results_2026-07-15.md`. Top items, ranked:

1. **P0 (regression re-confirmation, not new) — the Clean tab's Fuzzy Duplicate Radar still proposes
   destructive merges on the `claim_id` unique-identifier column.** Observed live: 98%-confidence
   "Merge →" suggestions purely from digit-permutation string similarity (e.g. `"CLM100001" ≈
   "CLM100010"`, `"CLM100001" ≈ "CLM101000"`). This is the exact bug class Run 4's P0 finding described
   and that PR #198 (`18d9f48`, merged 2026-07-12) was written to fix — but source inspection this run
   shows that fix only patched `js/validation/categorical-consistency.js` (which has its own dedicated
   test, `test/categorical-consistency-identifier-guard.test.mjs`). The Clean tab's radar panel is
   powered by a separate sibling module, `js/cleaning/fuzzy-dedup.js`, which has **no identifier/
   cardinality guard of any kind** (confirmed via direct grep) and no corresponding test file. The same
   destructive-merge risk PR #198 was meant to close remains live through this second, unpatched code
   path. Suggested fix: port the same two guards from `categorical-consistency.js` into `fuzzy-dedup.js`
   (or better, factor them into one shared identifier-detection helper both modules call), and add a
   `fuzzy-dedup`-specific identifier-guard test mirroring the existing categorical-consistency one so this
   class of bug can't silently reappear in a third module later.
2. **P1 (corroborates Run 4, independent reconfirmation) — near-duplicate patient detection (AHIMA
   nickname/typo/suffix patterns) is still uncaught.** Loaded `patients.csv` alone, ran Clean → Scan for
   Issues: result was "No issues found." The 12 seeded near-duplicate patients were not flagged.
   Independently confirmed via SQL (`GROUP BY dob, ssn_last4 HAVING COUNT(*) > 1` → exactly 12 rows) that
   the underlying signal is present and trivially queryable, so this is a real detection-path gap, not a
   data problem. Reconfirms Run 4's finding on an independent seed/fixture set — the gap has not been
   addressed since 2026-07-12.
3. **P2 (new this run) — the Unit Test Layer's self-described scope overstates its actual output.** Its
   description claims 5 silent tests (negatives, future dates, blank keys, duplicates, referential
   integrity), but this run's live output surfaced only the future-date finding — the seeded orphan claim
   (`patient_id="PT9999"`, confirmed real via direct SQL anti-join) and seeded duplicate claims (confirmed
   real via the separate Denial Root-Cause Profiler, which flagged 29 rows by name) were both silently
   absent from this layer's own reported findings. The underlying detection capability exists elsewhere in
   the product (SQL tab, Denial Profiler) — this is a coverage-consistency gap in one layer's output, not
   a missing capability. Suggested fix: either genuinely wire referential-integrity and duplicate checks
   into the Unit Test Layer's output, or narrow its self-description to what it actually currently checks.
4. **What worked and should be protected (confirmed again this run):** the zero-upload/local-first claim
   held up under direct empirical network-capture testing across four separate feature surfaces (Validate,
   SQL, HIPAA Safe Harbor de-identification, Denial Root-Cause Profiler) with zero genuine external calls
   observed; the HIPAA de-identification verifier and Denial Root-Cause Profiler both produced correct,
   well-caveated, in-browser-only results; offline functionality (network killed post-load) held up.
5. **Untested follow-ups still open from this run:** NCCI-style same-day conflicting-procedure pairs (8
   seeded), disambiguating the suspect-duplicate (10) vs. exact-duplicate (15) claim buckets specifically
   (only a combined query was run), and desktop/Tauri + mobile/PWA parity for all Run 5 findings.

**Practical readiness verdict for the portfolio use case (asked directly this run):** the strongest,
most defensible claim — zero-upload/local-first architecture — held up under adversarial-ish testing and
is safe to lean on when presenting DataGlow publicly. The two P0/P1 findings above are real and should be
fixed before treating DataGlow's automated Clean/Validate output as a complete, unsupervised audit of any
real claims- or patient-shaped dataset; a manual SQL cross-check (which DataGlow's own SQL tab makes easy)
remains the safer path for duplicate/referential-integrity findings until the Unit Test Layer's coverage
is reconciled and the Fuzzy Duplicate Radar receives the same identifier guard categorical-consistency.js
already has.

## Test findings (2026-07-16 run 6 — Cross-platform verification + multimodal ingestion brainstorm)

A targeted rerun combining (a) cross-platform verification of the recently-shipped
`crossTableReferentialIntegrity` check (web/desktop/mobile/tablet) and (b) a "handle any data format"
architecture brainstorm for future video/audio/PDF/image ingestion — prompted directly by the user citing
Zach Wilson's Volume/Velocity/**Variety** framing for AI-resistant data-engineering skill ("rows and
columns are the past... PDFs, images, audio, transcripts — that's the work that matters now,"
[Joe Reis substack, 2026-05-09](https://joereis.substack.com/p/data-engineering-in-2026-w-zach-wilson)).
Full write-up: workspace `dataglow_test_results_2026-07-16.md` and
`dataglow_multimodal_ingestion_architecture_brainstorm.md`. Top items, ranked:

1. **P1 (new this run) — the Command Deck sidebar (`.command-deck-sidebar`,
   `js/app-shell/command-deck-nav.js`) has zero mobile-responsive handling.** Confirmed via direct DOM
   measurement (`getBoundingClientRect()`, not visual impression): the fixed 200px-wide `<aside>`
   consumes 41.2% of an iPhone 14's viewport width and 48.5% of a Pixel 7's, squeezing the main content
   column so badly that validation status text and finding details wrap/truncate mid-word ("Metrics: 0
   certified · 0 re...", "...don't exis..."). `grep -rn "command-deck" css/*.css` confirms zero `@media`
   query exists for this element anywhere in the codebase. Notably, the **exact right fix pattern already
   exists** in the same file for a different, older sidebar: `.data-sidebar` correctly goes
   `position: fixed; left: -260px` (off-canvas) at `@media (max-width: 860px)` — the newer Command Deck
   sidebar was simply never given the same treatment when it shipped. iPad Pro 11 is unaffected (200px is
   a proportionate 24.0% there). Suggested fix: mirror `.data-sidebar`'s existing off-canvas pattern for
   `.command-deck-sidebar` — low-risk, reuses a proven convention, no new design work required.
2. **Pass (functional correctness re-confirmed) — `crossTableReferentialIntegrity` fires correctly on
   every platform tested this run.** iPhone 14, Pixel 7, and iPad Pro 11 (Playwright device emulation,
   `waitForFunction`-based polling, not fixed-timeout) all confirmed the real finding text renders
   correctly ("1 value(s) in 'patient_id' don't exist... (orphan reference)"). Desktop (Tauri) verified
   architectural-parity-only this run (byte-identical asset diff between `js/` and
   `src-tauri/dist/js/`) — no Rust/cargo toolchain was available in this sandbox for a live WebDriver
   functional run, a standing limitation carried forward from the prior run. No data-quality regression
   found on any platform.
3. **Methodology note for future Playwright mobile testing:** an earlier attempt this run using a fuzzy
   substring match (checking for "referential" anywhere in page text) produced a **false positive** — the
   substring matched unrelated UI copy, not the actual finding. Always assert on the specific finding text
   (e.g. "orphan reference") and prefer `page.waitForFunction()` polling over fixed `waitForTimeout` calls,
   since this app's async DuckDB-WASM loading makes fixed timeouts unreliable.
4. **Multimodal ingestion architecture brainstorm (Phase 7, in scope this run) — full report is
   evidence-backed and phaseable.** Headline verdict: native-PDF text extraction (pdf.js) and image OCR
   (Tesseract.js/Scribe.js) are genuinely solved client-side today with zero WebGPU dependency, so they
   work identically on web, Tauri desktop, and mobile/PWA — this is the recommended next buildable feature
   ("Option A" in the scored menu). Audio/video transcription via Whisper is real but WebGPU-dependent for
   a good experience, and WebGPU on mobile is newly-landed and fragmented (iOS needs 26+, Android is
   GPU-family-gated per [WebKit's own blog](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)
   and [caniuse](https://caniuse.com/webgpu)) — recommended as an opt-in, desktop-first Phase 3, not a
   default-on feature. Full structured extraction from messy real-world documents (turning a scanned
   invoice into clean rows) remains only partially solved even for funded cloud vendors per
   [Turbolens's 2026 analysis](https://www.turbolens.io/blog/2026-05-04-pdf-table-extraction-for-developers-from-raw-documents-to-clean-json) —
   DataGlow should frame any such output as "assistive, verify before trusting," matching the honest
   ceiling every competitor in this space describes for itself. Recommended sequence: Phase 1 (PDF+OCR) →
   Phase 2 (structured-extraction heuristics) → Phase 3 (Whisper, opt-in) → Phase 4 (full document
   intelligence, deferred pending ecosystem maturity — no confirmed browser-portable layout-aware model
   exists yet).
5. **Untested follow-ups still open from this run:** real on-device WebGPU/Whisper performance
   benchmarking (no source found gives current mobile-specific numbers; the research explicitly flags
   this as a gap requiring direct measurement before committing a default model size), and a genuine live
   Tauri WebDriver functional test (blocked on missing Rust toolchain in this sandbox).

**Practical verdict:** no data-quality regression exists in the tested feature on any platform — the
Command Deck sidebar finding is a real but low-risk, cheaply-fixable mobile layout bug, and the
multimodal roadmap is grounded in primary-sourced, phaseable evidence rather than speculation.

## Test findings (2026-07-16 run 7 — Command Deck mobile sidebar fix, shipped)

The P1 mobile sidebar finding from run 6 (directly above) is now fixed and shipped: PR #273,
squash-merged to `main` at commit `5b8bfe3`. `.command-deck-sidebar` now mirrors `.data-sidebar`'s
existing off-canvas pattern — hidden off-screen by default at `≤860px`, opened via a new hamburger
toggle in the topbar, closes on backdrop tap or on nav-tab selection. Desktop (`>860px`) is unchanged:
the toggle is CSS-hidden and the sidebar renders inline at full width, exactly as before.

While testing the fix on real mobile viewports, two more pre-existing, unrelated bugs surfaced in the
same topbar region and were bundled into the same PR (user approved bundling both times, via
`ask_user_question`):

1. **The DATAGLOW logo was invisible on every sub-480px viewport.** Root cause: `.brand svg { width:
   auto }` (specificity 0,2,0) always overrode `.brand-logo { width: 84px }` (specificity 0,1,0)
   regardless of media-query source order, so the logo's computed width silently resolved to 0 in the
   collapsing flex context. Fixed by qualifying the selector as `.brand .brand-logo` to match
   specificity, plus sizing down to 60px so it fits alongside the Room-pill fix below.
2. **The live "Start a Room" Room pill (`roomsUi` flag, `enabled:true`, already promoted for all users)
   had zero mobile treatment and alone consumed the entire topbar on a 390px phone.** Root cause:
   `buildRoomPillModel()` (`js/rooms/room-ui.js`) renders duplicated text in idle state — both a label
   span and an action button that both read "Start a Room" — measured at 379px natural width on a 390px
   viewport, and with `.topbar-right { flex-shrink: 0 }` this squeezed the logo/toggle to zero width.
   CSS-only fix: hide the redundant idle-state label (the action button already conveys the
   affordance) and tighten the pill's padding/gaps on mobile. No JS/behavior change; the pill's joined-
   state (`room-pill-code`) was correctly left untouched.

**Testing:** a reusable Playwright functional test (`test_sidebar_fix2.mjs`) covering drawer open/close,
tab-click auto-close, and a full data-load → validate flow (the `crossTableReferentialIntegrity` orphan-
reference finding from run 6 still surfaces correctly) passed cleanly on iPhone 14 (390px) and Pixel 7
(412px) — zero horizontal scroll on either. Desktop (1280px) independently re-verified with zero
regression. All 54 CI checks passed, including `tauri-smoke`.

**Practical verdict:** the P1 finding from run 6 is now closed. No new flags were introduced — both
touched flags (`dataglowSidebarNav`, `roomsUi`) were already live; this PR changed their mobile
presentation only. Full detail: `dev-log/journal.md`'s 2026-07-16 13:45 CT entry.

## Test findings (2026-07-17 run — real CMS healthcare data, web + desktop)

First run against genuinely real, current, external data instead of a synthetic seeded-defect fixture.
Dataset: CMS's own public Medicare Physician & Other Practitioners by Provider and Service file (2024
reference year, released 2026-05), pulled live via CMS's public Data API and filtered to 3,036
Illinois-provider rows, 28 columns — de-identified, no DUA required. Full write-up:
`dataglow_real_data_test_2026-07-17.md`.

**Why this run matters more than a synthetic pass:** there was no pre-written answer key. Every
DataGlow finding below was independently re-derived from the raw CSV with direct DuckDB queries run
outside the app, so a match is real evidence the underlying engine is correct on real-world data, not
just internally consistent with its own seeded test fixture.

**Confirmed correct, independently re-verified:**
- Preflight's null-column count (4/28) and duplicate-row count (0) — exact match.
- Outlier detection (MAD z-score + Tukey IQR) on `Tot_Benes` — DataGlow's "378 high (MAD z>3.5), 298
  above IQR fence (>153)" reproduced exactly from raw values (median 33, MAD 19, Q1=18, Q3=72).
- Missingness Detective correctly identified MAR/MNAR patterns tied to provider rurality — a genuine
  senior-analyst-level catch on real data, not a scripted response.
- Fuzzy Duplicate Radar surfaced real near-duplicate provider names ("Franklin"≈"Frank",
  "Martinez"≈"Martinez Mateo").
- Blind Spot Scanner correctly flagged this specific CMS file's real absence of
  race/ethnicity/payer/age/gender fields.
- Zero-upload/local-first claim held under an actual network-blocking test (all external requests
  aborted via Playwright route interception) — app still loaded the CSV and ran Preflight/Validate
  correctly, zero blocked-attempt events even fired.

**New bug found (reproducible, not yet fixed):** the SQL panel's hallucinated-reference check false-
positives on `ROUND(...)` when used as an aliased column inside a `GROUP BY ... ORDER BY <alias>`
query — a very common analyst query shape. The query still executes and returns correct results; only
the warning banner is wrong. Isolated to the GROUP BY + aliased-ORDER-BY combination specifically
(bare `ROUND()` calls and ungrouped queries do not trigger it). Likely root cause: the hallucination
detector's identifier scan doesn't exclude known SQL function names when resolving an `ORDER BY` alias
reference. Recommend as a P1 backlog item — low blast radius (warning-only, no data corruption) but
high reproducibility on exactly the query pattern a healthcare/billing analyst writes daily.

**Platform coverage caveat:** web was tested live end-to-end. Desktop (Tauri) was verified
architecturally (byte-identical static asset copy, confirmed via `scripts/stage-desktop-frontend.mjs`
source) plus CI's `tauri-smoke` job passing on this exact `main` commit — no local native Tauri window
was actually driven this run (no Rust/cargo toolchain in the test sandbox). Mobile/PWA not tested this
round. A future run should close the desktop gap with a real `tauri-driver`/WebdriverIO pass per
`references/platform_architecture_notes.md`.

**Overall verdict:** DataGlow's core data-quality engine is trustworthy on real healthcare billing
data today — every checked number matched independent verification, and the one real bug found is a
UX/trust false-alarm, not a data-integrity defect.

## Test findings (2026-07-17 run 2 — Story tab on-device model retest, real Chrome, headless sandbox)

Direct follow-up on the previous entry's one open caveat: the 2026-07-17 real-CMS-data test did not
verify the Story tab's on-device LLM narrative actually completing (its first-model-download attempt
timed out that session before finishing). This run retested that one specific gap in isolation, using a
real headless-Chrome browser (not a mock) with WebGPU explicitly enabled and a persistent browser profile
(the first attempt used an ephemeral in-memory profile and hit a spurious `QuotaExceededError` from
Chromium's storage-quota accounting under that specific profile type — re-run with a persistent profile
directory to rule that artifact out, which it did).

**What was confirmed working, end to end:** the full non-AI portion of the "dataset in → clean → analyze"
loop, using the built-in Golden Test Dataset loader (100 rows, 10 columns) — load, run a live SQL query,
navigate to Story, click Generate. The on-device download pipeline itself worked correctly: WebLLM's
~829MB `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` weight cache downloaded cleanly over real network requests to
Hugging Face + the MLC binary-libs mirror, reaching 100% in ~197 seconds in this sandbox, with the model's
own live progress text ("Fetching param cache[N/30]: XMB fetched, Y% completed...") rendering correctly
throughout — this is real, working, user-visible progress reporting, not a stub.

**Where it actually stopped, precisely:** after the download finished and model loading proceeded to GPU
shader-module compilation ("Loading GPU shader modules[7/75]..."), WebGPU shader creation failed with
`Error while parsing WGSL: extension 'f16' is not allowed in the current environment` — this quantized
model build (`q4f16_1`) requires the WGSL `f16` (half-precision float) extension, which this sandbox's
headless-Chrome software GPU renderer (SwiftShader, the `--use-gl=swiftshader` CPU-emulated path used to
get WebGPU running at all in a container with no real GPU) does not support. **This is a software-
renderer ceiling specific to this test sandbox, not a confirmed DataGlow product bug** — real Chrome on
real hardware (the README's own stated target, including "Chrome on Android") uses a native GPU driver,
and `f16` support is a normal, common feature on modern GPU hardware. On shader failure, `ondevice-llm.js`
caught the error and DataGlow correctly fell back to the rule-based offline story engine (`MODEL BADGE:
"Rule-based (fallback)"`), which produced a correct, confidence-annotated narrative from the same query
result — this is exactly the intended "co-pilot not autopilot" graceful-degradation behavior working as
designed, not a crash or a silent failure.

**Honest scope of what this run does and does not prove:**
- Proves: the download pipeline, progress UI, model-cache flow, and — critically — the fallback safety
  net all work correctly under real network conditions in a real browser engine.
- Does NOT prove: the on-device model completing inference and producing an AI-written narrative on real
  end-user hardware. This sandbox's software GPU renderer is a materially different environment from a
  real user's Chrome (desktop with a real GPU, or Chrome on Android per the README's specific claim), and
  the one failure found here is plausibly an artifact of that renderer rather than of DataGlow's own code.
- This remains an open, not-yet-closed verification gap — a real-device or real-GPU-enabled-headless run
  (e.g. a CI runner or local machine with actual GPU passthrough, not software rendering) is the correct
  next step to close it definitively, one way or the other.

**Recommendation for the founder:** for a real portfolio-project deadline today, treat the loop as: data
in → clean → analyze → SQL/Story-with-rule-based-narrative → present, fully proven end to end right now.
The on-device AI narrative specifically is an enhancement layer on top of that already-solid loop, not a
load-bearing step in it — the rule-based fallback alone produces a legitimate, confidence-labeled written
summary suitable for a proof-project write-up. Don't block a real deadline on the AI narrative completing
until it's verified on real GPU hardware; if it works there (likely, given how far this run got), treat it
as a bonus polish item, not a prerequisite.

## Test findings (2026-07-17 run 3 — founder's 7-question readiness audit: healthcare accuracy, toolchain combos, dashboards, BI interop, cross-platform)

A custom-scoped run answering the founder's own 7 specific questions directly, rather than a generic
rubric sweep: (1) is DataGlow accurate end-to-end on a real healthcare dataset, (2) can a project be done
in SQL-only / Excel-only / any combination, (3) are dashboards ready, (4) what happens if a stakeholder
wants Power BI/Tableau, (5) other relevant factors, (6) is browser/desktop/mobile ready for real work, (7)
would a DataGlow-built product be accurate enough to share on LinkedIn without a data professional pushing
back. Full evidence (screenshots, Playwright scripts, raw SQL cross-checks) at
`/home/user/workspace/dataglow_test_run_20260717/` in the test sandbox; full write-up in
`dataglow_roadmap_2026-07-17.md` in that same directory.

**Methodology — independent verification, not UI self-report:** built a fresh synthetic 1101-row claims
dataset (seed=42) with 6 seeded-defect categories and a documented answer key, ran DataGlow's Validate tab
("Run All 20 Layers," Healthcare domain pack) against it, then cross-checked every finding directly against
the raw data using independent SQL queries run in DataGlow's own DuckDB-WASM engine — never trusting the
UI's self-reported count alone.

**Accuracy results — exact matches on 4 of 6 seeded defect categories:** allowed_amount > billed_amount
(6/6 exact), missing procedure_code (5/5 exact), future-dated service_date (1/1 exact), orphan
patient_id-not-in-patients.csv (1/1 exact, **but only when both related files are loaded together** — see
usability finding below). Duplicate-claim counts were directionally correct but not exactly reconciled
against the answer key's literal "15" this run (found 16 groups/32 rows under the answer key's own match
definition) — flagged as an open follow-up, more likely a dataset-regeneration artifact than a detection
bug. **NCCI-style same-day conflicting-procedure-pair detection is a confirmed gap** — verified via direct
source inspection that no NCCI/CCI-edit module exists anywhere in `js/` (this repeats and now doubly
confirms an item flagged open since the 2026-07-12 run 4 entry).

**New unprompted strengths surfaced this run** (not seeded, found emerging naturally from the checks):
Benford's Law digit-distribution check correctly flagged `billed_amount`/`allowed_amount` deviation;
sensitive-column governance auto-disabled fuzzy-merge suggestions on the `payer` column (protected-category
lockout, working exactly as intended); the Physiological Plausibility layer correctly skipped rather than
false-flagged when no vital-sign columns were present in claims data — genuine "don't fabricate a finding"
judgment; Denial Radar computed a real, specific denial rate (34.8%, 383/1101) directly from the data.

**Confirmed usability gap — referential integrity is silently single-file-scoped:** loading `claims.csv`
alone (the natural first move) never surfaces the orphan-reference check at all; it only activates once a
related table (`patients.csv`) is also loaded, and there is currently no visible prompt telling a
single-file user that a second file would unlock this check.

**Confirmed workflow-breaking gap — Visualize cannot chart a SQL/derived query result:** ran a real GROUP
BY aggregation in the SQL tab, then opened Visualize — the Y-axis dropdown only ever offered columns from
the originally-uploaded table, never the query's own derived columns (e.g. `total_billed`, `claim_count`).
Excel-only chart-building (charting the raw uploaded table directly, no SQL involved) worked cleanly by
contrast, confirming this is specific to SQL-derived results, not a general Visualize bug. This is the
single highest-priority fix from this run — it's what currently breaks the promise that SQL-only, Excel-
only, and any combination of the two can each reach a finished chart.

**Dashboard status, precisely:** the single-chart Visualize tab is live and produces genuinely
presentation-quality output (verified by opening the actual exported PNG file). The actual named
dashboard capability, Glow Canvas, remains `enabled: false` in `flags.manifest.json` — confirmed live in
the running app that `tab-glowcanvas` is entirely absent from the rendered tabbar when the flag is off
(not greyed out, just missing), so there is currently no visible signal to a user that a dashboard-builder
exists at all.

**BI-tool interop, verified by opening actual exported files (not just reading the export code):** Excel
export is clean and BI-import-friendly, with two confirmed small bugs — dates are written as text, not
native Excel date cells (forces a manual re-type on Power BI/Tableau import), and export filenames carry a
double extension (e.g. `dataglow-claims.csv.xlsx`) because the internal table name retains the original
file's extension. PDF export is real but thin (metadata/summary only, no embedded tables or charts) and
has a confirmed, intentional-but-visible bug: `asciiSafe()` in `js/export/export-report.js` replaces all
non-ASCII characters — including em-dashes — with a literal `?`, by design, for byte-offset parity in the
hand-rolled PDF generator with no external PDF library; this produces visibly broken text like
"DATAGLOW export ? claims.csv" in real exported files. **No native `.pbix`/`.twbx` export exists** —
confirmed via direct code inspection, not a bug, simply unbuilt. The realistic path today is Excel export
as a manual hand-off to whatever BI tool a stakeholder uses; product positioning should say this plainly
rather than imply direct BI-tool integration.

**Cross-platform, this run's honest coverage:** web (desktop browser) got the deepest hands-on pass and is
the basis for everything above. Desktop (Tauri): confirmed the `tauri-smoke` CI job — the repo's own
compile gate, documented as "nothing more" — passed on the latest `main` commit (`13c9952`) via direct
`gh run view` inspection; could not run a live functional WebDriver/`tauri-driver` pass this run (no
Rust/Cargo toolchain in this test sandbox), so "compiles" and "functionally identical to web" remain
distinct, and only the first is verified this run. Mobile (installable PWA — confirmed again this run,
no native Android/iOS project exists in the repo): `manifest.webmanifest` valid and fetches correctly with
proper icon sets, service worker registers, content reflows cleanly with no overflow at a real iPhone 14
viewport/touch emulation, file upload works via tap. Two new, minor, confirmed mobile findings: the tabbar
and dialect-selector rows scroll correctly but have **no visible scroll affordance** (no arrow/fade/dots),
and tab touch targets measured ~38.5px tall, slightly under the commonly-cited 44px (iOS)/48px (Material)
minimum. Not verified this run: real-device WebGPU/on-device-AI behavior on actual Android hardware, and a
real post-load network-cutoff offline test.

**Story tab fallback behavior — consistent with the 2026-07-17 run 2 finding above:** in this sandbox
(`navigator.gpu` present but no functional adapter), generating a story correctly fell back to the
rule-based narrative engine rather than silently failing or fabricating output, and that fallback itself
produced real computed statistics with an explicit small-sample confidence caveat ("Confidence: D · n=6...
treat this average cautiously"). This corroborates run 2's finding that the fallback safety net works
correctly, from a second, independent test session.

**LinkedIn-shareability verdict (the founder's core underlying question):** conditionally yes, with a
precise scope statement rather than a blanket claim. Share with confidence: any Validate/Clean/SQL-based
data-quality finding (every independently-checkable seeded defect held up under direct SQL
cross-verification), a single exported Visualize chart, and the governance features (AI-readiness gate,
sensitive-column merge lockout, ZK proof options) as genuine differentiators. Do not yet claim, without
caveat: "dashboard" (say "chart/visualization" until Glow Canvas ships), "direct BI-tool export" (say
"exports to Excel for BI hand-off"), or "verified cross-platform parity" (say "ships to web, desktop, and
mobile from one codebase," which is true and verifiable, not "tested identically across all three," which
isn't yet true). The core data-quality engine's rigor (Benford's Law, kNN multivariate outliers, honest
skip-when-inapplicable behavior, exact-count accuracy under independent cross-checking) is not something a
senior data professional would dismiss as "needs more work" — the confirmed gaps are specific and fixable,
not signs of a fundamentally unreliable engine.

**Ranked fix list from this run (cheapest/highest-trust-impact first):** (1) Visualize-from-SQL-result —
the single most workflow-breaking gap, closes the "any toolchain combination" promise; (2)
referential-integrity discoverability — surface a prompt when a second file would unlock a check; (3)
export filename double-extension bug and Excel date-as-text export — both small, both visible to a BI
stakeholder; (4) PDF em-dash-to-`?` encoding bug — cosmetic, but visible in every export; (5) Glow Canvas —
already built per the capability map, needs whatever gate is holding the flag dark cleared, then
cross-filtering QA before flip; (6) NCCI same-day conflicting-procedure detection — a genuinely new build,
real value for healthcare-claims positioning specifically; (7) mobile touch-target sizing and scroll
affordance — low cost, meaningful given the founder's own iPhone-primary usage pattern.

**Explicitly not covered this run:** live functional Tauri WebDriver pass, real physical Android/iOS
device testing, full duplicate-count discrepancy reconciliation, Python/R tab correctness, and a formal
Section 1-5 rubric Pass/Partial/Fail scoring matrix (this run answered the founder's 7 questions directly
per their explicit ask; a full rubric-matrix run remains available as a future targeted rerun).

## Architecture research: is DuckDB-WASM still the right foundation for any-format ingestion? (2026-07-16, docs-only)

Deep research directly answering the founder's "any data format" ambition from run 6 (PDF/image/audio/
video ingestion, tied to Zach Wilson's Volume/Velocity/**Variety** framing). Full report:
`dataglow_architecture_report.md` (235 lines, every claim URL-sourced).

**Verdict: COMPLEMENT DuckDB-WASM, do not replace it.** No embedded engine — DuckDB-WASM or any
alternative — natively parses pixels/audio/PDF layout via SQL over raw bytes; neither do the cloud
giants marketing "query any format with SQL." Snowflake Cortex, BigQuery ObjectRef, Databricks
`ai_parse_document`, and MotherDuck all use the same **reference → extract → structure → join** pattern:
reference the blob, run an extraction/AI function to turn it into structured columns/text/embeddings,
land the output in a queryable relational layer. This is exactly what Zach Wilson teaches ("convert
everything to Markdown first"; video → audio+frames → transcript+captions → vector DB → RAG) — his
method never asks a SQL engine to parse pixels either.

**Ranked scoring (5 dimensions: maturity, multimodal capability, integration cost, cross-platform
feasibility, complement-vs-replace fit):**

1. On-device extraction stack (PDF.js + Tesseract.js + transformers.js/Whisper) — 4.6
2. Apache Arrow + parquet-wasm (interchange fabric) — 4.6
3. DuckDB-WASM (keep as core) — 4.4
4. Browser vector store (sqlite-vec / usearch) — 4.4
5. SQLite-WASM + OPFS (durable app state, not analytics) — 4.2
6. Polars via Pyodide (optional DataFrame complement) — 4.0
7. Multi-engine Web Worker pattern (Comlink) — enabling pattern, not an engine — 3.8
8. WASI/Component Model 2026 — not the browser answer; no browser GPU/inference path — 3.0

**Recommended phased path:** Phase 1 — PDF.js + Tesseract.js (documents: extract text from PDFs/scans
→ land as rows in DuckDB-WASM for cleaning/validation/query; raw bytes stored in OPFS, referenced not
inlined). Phase 2 — on-device embeddings (transformers.js) + sqlite-vec/usearch for semantic search/
dedup. Phase 3 — Whisper-based audio/video transcription (WebGPU with WASM fallback; mobile WebGPU
support is newly-landed and fragmented, so this stays opt-in/desktop-first). Phase 4 — hardening: move
each engine to its own Web Worker, enforce reference-not-inline for large blobs, add explicit memory
budgeting before the ~1–4 GB browser tab ceiling (no graceful degradation exists today).

**Constraint fit confirmed:** every recommended piece (PDF.js, Tesseract.js, transformers.js, sqlite-vec/
usearch) runs fully client-side with zero cloud API calls, satisfying DataGlow's no-paid-AI-key rule, and
none require native-only OS APIs — all work identically in a plain browser, the Tauri webview, and a
mobile PWA off the single shared codebase.

**Not yet built — this is research only, no code shipped.** Phase 1 (PDF.js + Tesseract.js) is the
recommended next buildable feature when the founder is ready to start.

## CI infrastructure: reusable-workflow cap is now exactly full

**Discovered 2026-07-15, PR #243 (Guarded Copilot).** GitHub Actions caps a single top-level
workflow file at 50 unique reusable workflows called (raised from 20 in Nov 2025 — see
[GitHub's reusable-workflow docs](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#limitations-of-reusable-workflows)).
`test.yml` was already at exactly 50 `job-*.yml` calls before this PR — adding a 51st (a new
`job-guarded-copilot.yml`) made the whole `tests` workflow fail to parse (an immediate 0-job,
0-second "workflow file issue" failure, not a test failure). Worked around for this PR by adding
Guarded Copilot's suite as a second job inside the already-counted `job-agent-action-firewall.yml`
rather than a new top-level file — both are `js/agents/` red-team suites, a reasonable pairing, but
this is a stopgap, not a scalable pattern. **The next PR that wants a genuinely new standalone CI
job will hit this same wall immediately.** Real fix (not attempted here, to keep this PR's diff
scoped to Guarded Copilot itself): introduce one more level of nesting — a small number of "batch"
reusable workflows (e.g. `job-batch-agents.yml`, `job-batch-provenance.yml`), each itself calling
several leaf `job-*.yml` files. Up to 10 levels of nesting are allowed, so this only needs to happen
once to buy back a lot of headroom, but it touches `test.yml`'s structure directly and should be its
own small, dedicated PR (docs/CI-only, no source changes) rather than bundled into a feature PR.

**Hit again, 2026-07-17, PR #294 (The Rigor Engine, Batch 1).** Same failure mode exactly: adding
`job-statistical-rigor.yml` as a 51st `uses:` call broke the entire `tests` workflow (0 jobs, "workflow
file issue"). Worked around the same way as before — defined the job inline (`steps:` directly in
`test.yml`, matching the `glow-canvas`/`drill-floor`/`cleaning-crew` inline-job pattern) instead of a new
top-level file, and deleted the orphaned job file. **This is now the second time this exact wall has
stopped a PR mid-flight**, and the inline-job workaround itself is finite — `test.yml` will eventually
get unwieldy as more jobs get inlined instead of living in their own files. The real fix described above
(a batch-of-batches nesting refactor) should be prioritized as its own small, dedicated, docs/CI-only PR
before the next few feature batches (Rigor Engine Batches 2-4 will each likely want their own CI job too).

## Shipped (live, all three flags on): Query Sentinel

**Concept:** a three-batch SQL-tab trust layer, built and merged dark in one continuous autonomous run
(2026-07-15) after a `dataglow-brainstorm` round on DataGlow's coding capabilities landed on this as the
one combined flagship concept, then enabled live one flag at a time (2026-07-16), each with its own
separate go-live confirm. Full detail in `dev-log/journal.md`'s 2026-07-15 23:53 CT (dark ship) and
2026-07-16 06:00 CT (go-live) entries.

1. **`queryVerificationSentinel`** (PR #256) — per-query deterministic static analyzer: FANOUT (non-unique
   joined-side key before an aggregate), JOIN_KEY (type mismatch across a JOIN ON), ADDITIVITY (GROUP BY
   on a non-unique joined column), SENSITIVE_COLUMN (delegates to the existing `phi-prompt-guard.js`).
   22/22 tests.
2. **`querySentinelAssist`** (PR #257) — opt-in "Explain & suggest a fix" layered on Batch 1's flags,
   mirroring Guarded Copilot's Tier 1 (template) / Tier 2 (on-device WebLLM) pattern, no second model
   loaded. 30/30 tests.
3. **`querySentinelBridge`** (PR #258) — resolves `FROM py.<name>` / `FROM r.<name>` against the Object
   Space registry; exact-match-only, never fuzzy; honestly scoped to already-loaded datasets only (not
   arbitrary in-runtime variables — that remains a named future gap, not implied to exist). 31/31 tests.

**Cross-platform:** pure JS logic + one shared `main.js` hook — ships to web, desktop (Tauri), and the
PWA/mobile surface simultaneously off the single shared codebase the moment each flag flips.
`tauri-smoke` passed independently on all three PRs.

**Status:** all three flags are now `true` and live for every user, as of 2026-07-16 (PRs #260, #261,
#262 — each flag flip was its own separate, explicitly confirmed action, never bundled together or with
any other flag). The SQL tab's Query Sentinel card, its Assist button, and its cross-runtime bridge
resolution are all active.

**`zkThresholdProof`** (unrelated to Query Sentinel — the first genuine zero-knowledge proof primitive
in DataGlow) is now also `true` and live, as of 2026-07-16 (PR #264, its own separate, explicitly
confirmed action). `proveZeroCriticalIssues()` — an opt-in 'Prove zero critical issues' button in the
SQL tab's Local Analysis Contract flow — proves a result has zero critical (fail-severity) flags without
revealing the count or the data, using a non-interactive Schnorr Sigma protocol over a 512-bit
safe-prime group (native BigInt only, no crypto library/WASM/new dependency/trusted-setup ceremony).
Live-verified before merge: the success path (clean data → proof generated and independently
re-verified), the honest-refusal path (a real critical flag present → `ok:false`, no fabricated proof),
and the artifact's actual JSON payload (no secret blinding factor value present, only the Schnorr
transcript). 31/31 tests. No other pending flag-enable requests remain.

## Backlog (ranked, queued — not abandoned)

**From 2026-07-15 Run 5 (Portfolio-readiness), highest-priority — bug fixes, not new features, ranked
above the feature backlog below since they're cheaper and higher-trust-impact:**

0a. **RESOLVED (PR #251, merged 2026-07-16).** Ported the identifier/cardinality merge-guard from
    `js/validation/categorical-consistency.js` into `js/cleaning/fuzzy-dedup.js` (`js/shared/identifier-
    columns.js` + guard wired into `fuzzy-dedup.js`). Matching test added.
0b. **RESOLVED (PR #267, merged 2026-07-16).** The Unit Test Layer's claimed 5-check scope (negatives,
    future dates, blank keys, duplicates, referential integrity) now matches its actual output for the
    in-table checks (negatives/future-dates/blank-keys/duplicates were already correct; the layer's own
    description was corrected to stop overclaiming cross-table referential integrity as part of that
    base set). A genuinely new, separate cross-table referential-integrity check was built —
    `findReferenceCandidate()` + an anti-join query in `runUnitTests` — gated behind a **new, dedicated
    flag `crossTableReferentialIntegrity` (shipped `enabled: false`, dark)**, since this surfaces a new
    finding kind (`orphan_reference`) to users and needs its own explicit enable decision per standing
    convention. 9 new tests (`test/unit-test-layer-cross-table-referential.test.mjs`) plus 500+ existing
    tests across every file importing `validation.js`/`state.js`/`build-flags.js` re-verified clean. Flag
    enable is a separate, not-yet-taken decision — see dev-log/journal.md 2026-07-16 entry.
0c. **RESOLVED (PR #251, merged 2026-07-16) — same PR as 0a.** `js/cleaning/clean.js`'s `scanForIssues`
    now wires into `findFuzzyDuplicates` for the patients table, so name/DOB-style near-duplicate
    patterns (nickname, typo, suffix variants) ARE surfaced by "Scan for Issues," closing the gap
    confirmed uncaught in the 2026-07-12 Run 4 and 2026-07-15 Run 5 test passes. Verified independently
    this run via a standalone script exercising `scanForIssues('patients', cols)` against a fresh
    dataset with 2 seeded near-dup name pairs — correctly surfaced as a `fuzzy_duplicates_patient_name`
    finding. Existing benchmark (`test/fuzzy-dedup-patients.test.mjs`) already proves 100% catch-rate on
    12 seeded pairs.

All three items from this ranked batch are now resolved as of 2026-07-16. Pull the next backlog item
below when Readiness Gate ships.

1. **Query Memory** (round 1 pick) — fingerprint every SQL/Python/R/Metric Studio run, log author +
   timestamp, surface a "seen before" badge grounding trust in validated usage history instead of static
   docs (DataHub's finding). Complementary to the Gate — could become the audit trail *behind* the
   Gate's decisions in a later phase.
2. Machine-readable Metric Contracts extended with agent-access rules (who/what is authorized to query
   a given metric) — partially exists, could be deepened.
3. Git-for-data version control (branch/commit/diff/rollback for datasets) — not present in DataGlow.
4. Agent audit-trail standard (IETF draft) — structured, SOC2/EU-AI-Act-ready logging of agent actions.
5. Cross-org clean-room-style privacy-preserving joins, generalized beyond the federated-learning module
   already in `js/federated/`.
6. Healthcare interoperability (FHIR/OMOP/TEFCA) used explicitly as a cross-org trust *protocol*
   template, not just a domain pack.
7. Governance-as-living-layer: one queryable interface for humans and agents (Gartner's "context as
   infrastructure" framing) — partially achieved once the Gate ships.
8. ~~**Minor, found 2026-07-17 (Story tab retest):** clicking "Generate Story" with no active dataset
   populated throws an unhandled `Cannot read properties of null (reading 'table')` from
   `getActiveDataset()` in the click handler.~~ **RESOLVED 2026-07-17 (PR #289, merged `ba070a1`, no
   flag):** added an explicit pre-check — `getActiveDataset()` result is now checked before use, showing
   "Load a dataset first (upload a file or load the Golden Test Dataset)" instead of crashing. Covered by
   a new e2e regression case in `test/e2e-analysis-contract.test.mjs`. See `dev-log/journal.md` entry
   [2026-07-17 09:42 CT] for full detail.
9. **NOT YET SCOPED — brainstorm candidate, added 2026-07-17.** Audio/video ingestion ("Cleaning Crew —
   Media station"): DataGlow currently cannot ingest audio or video files at all — `js/app-shell/
   loaders.js`'s `loadFile()` dispatch only branches on `pdf`/`csv`/`tsv`/`json`/`ndjson`/`parquet`/
   `xlsx`/`xls`/`sqlite`/`db`/`arrow`/`feather`. This item is explicitly triggered by comparing DataGlow
   against the unstructured-data pipeline Zach Wilson (DataExpert.io) describes publicly — deconstruct
   video into an audio track + periodic still frames, transcribe the audio, caption the frames, link both
   by timestamp, then push into a vector DB for RAG. The overlap with DataGlow is narrow: DataGlow has no
   vector store today (DuckDB-WASM tables only) and no RAG surface, so the realistic DataGlow-shaped
   version of this idea is narrower than Zach's pipeline — on-device transcription (Whisper-family, same
   WebGPU pattern already proven in `js/agents/live-transcript-capture.js` and Story's model loader) and
   frame-level captioning turned into ordinary queryable rows via the SAME `loadRowsAsDataset()` path
   Cleaning Crew's PDF Profiler already uses — NOT a new vector/embeddings layer (that would be a
   separate, larger architectural decision, not a Cleaning Crew batch). The PDF Profiler's own capability-
   map entry (`docs/capability-map.md`, "Cleaning Crew — Profiler station") already explicitly names
   "audio (Whisper)" as future/not-yet-built, so this is a documented extension of an existing roadmap
   line, not a new direction. Per explicit user instruction: **scope this as its own flag and its own
   batches, kept fully separate from the still-pending `cleaningCrew` (PDF) enable decision** — enabling
   one must never imply or require enabling the other. Candidate batch shape (unscoped, for a future
   Mission Center brainstorm round to size properly): (1) audio file upload → on-device Whisper transcript
   → queryable dataset, mirroring the PDF Profiler's shape exactly; (2) video file upload → frame
   extraction (e.g. every 3-4s, matching Zach's cadence) → on-device captioning (if a suitable on-device
   vision model exists — needs research, no paid API keys per standing constraint) → queryable dataset;
   (3) timestamp-linked join between a video's audio-transcript rows and its frame-caption rows. Platform
   impact: web + desktop certain (same WebGPU-gated pattern as existing on-device features); PWA/mobile
   likely degrades gracefully to no-transcription/no-captioning on devices without WebGPU, same ceiling as
   Story and Live Transcript Capture today.

## Lessons learned

- **Flip (or explicitly flag as still-dark) the visibility flag before reporting a batch done.** Batch 2
  shipped the readiness badge behind `aiReadinessGateBadge` default-OFF and was reported "done" while the
  feature was actually invisible to every user. "Landed dark" is not the same as "shipped/visible" — when a
  batch is meant to be seen, promote its flag (and update the flag-state guard test) in the SAME or the very
  next PR, and when it is meant to stay dark, say so explicitly in the done report. (Fixed for the badge in
  `sync-northstar-badge-and-batch3`: badge flag promoted to ON; batch-3 enforcement intentionally stays OFF
  and is reported as such.)

## Efficiency note for future sessions

The user has explicitly said repeating the full ritual "round after round" without shipping/testing
anything is unproductive. Default behavior going forward:
- Read this file first.
- If the user says "brainstorm" / "what's next" without new context, propose the next backlog item
  or a genuine improvement to it — do not restart from zero research.
- Only run a full new deep-research pass if the user explicitly asks, or it's been a long time
  (e.g. 1+ months) since the last pass.

## Standing brainstorm process (permanent — do not ask the user to re-paste the ritual)

As of 2026-07-11, the user confirmed this 10-step process is the permanent default for ANY
"brainstorm ideas for X in DataGlow" request, whether X is a whole infrastructure area or a single
small widget. The user should never need to re-type the long "think creatively / revolutionary /
sci-fi / tear down walls" ritual again — that mindset is now permanently baked into steps 3-5 below,
applied automatically every time, at whatever scale the request calls for:

1. Read this file (`NORTH_STAR.md`) — what's shipped, mid-flight, and already ranked in the backlog.
2. Read the actual relevant code for the area in question — ground ideas in what's real, not assumed.
3. Research only if genuinely new ground (not a repeat of a prior pass). When researching, or even
   when just reasoning from existing knowledge, permanently apply this lens: think revolutionary,
   flip the script, think privacy/safety/governance, tear down walls between roles/tools/orgs,
   think sci-fi-but-buildable, think like no one else in the industry is thinking, think ROI and
   real business value, think about what people wish already existed.
4. Brainstorm candidate ideas through that same lens — bold, inventive, solving a real problem.
5. Rank them honestly by real value, buildability, and fit with DataGlow's existing philosophy.
6. Combine the strongest ideas into ONE concept — never present a menu.
7. Check the concept against existing capabilities/modules for duplication.
8. Present the one concept with reasoning.
8b. **Live desktop + mobile preview (mandatory, added 2026-07-11):** build a visual mockup of the
    concept rendered inside DataGlow's actual UI shell (reuse real CSS/theme/layout, not a generic
    wireframe), deploy it to a live link at BOTH a desktop viewport and a mobile viewport, and share
    both links so the user can see how it actually looks before deciding anything. Never substitute
    a written description for this step. This is a look-and-feel mockup only, built as a standalone
    deployed copy — never touch the production repo/main branch just to produce a preview.
9. After the live preview is shown, end with ONE concrete build-order fork (2 options max) — not an
   open-ended question.
10. Build it as a small, tested, isolated batch — real PR, real CI, ship dark behind a flag if it
    changes visible/human-facing behavior.
11. Report the real, concrete result once merged/tested — update this file's backlog and "current
    concept" section so nothing is lost and the next round starts from here, not from zero.

Do not ask the user whether to apply "the creative lens" — always apply it. Do not ask the user to
confirm this process again in future sessions unless they explicitly want to change it. Do not skip
the live desktop + mobile preview step (8b) — it was explicitly requested by the user on 2026-07-11
so they can actually see, not just read about, how a brainstormed idea would look in DataGlow.

## Archive: original "DataGlow Development" ideation Q&A (2026-07-14, verbatim)

Preserved permanently here because chat history can be compacted/truncated and this record should
not depend on that. These are the user's own words, answering the scoping question tree that led to
the `dataglow-development` skill. Recovered from the user's own screenshots after the live session's
stored turn record truncated the original message.

**Q1 — What's the primary pain point to solve?**
> Everything! Pain point is everything! You saw my prompt. I feel that everything can be streamlined,
> focused and more! Like one continuous build a new feature and while it's doing that pr's and merging
> stuff and other stuff is being figured out on the backend so that all I need to do is build, review
> and confirm. That's it. Once I hit confirm, all the merges, pr's and more is all figured out because
> everything is in my GitHub already and the being built new feature can access the GitHub repo to
> configure all the debugging and more. Also, when I hit confirm, the new feature will be built and
> switched to on and feature flag will be on because again my GitHub repo code and everything is
> available for viewing.

**Q2 — Standing agent roles, or on-demand subagents?**
> Create and use applicable ai agents each time. Like this entire process will be called, dataglow
> development. When I type dataglow development, you have context already because you have access to
> my GitHub. When I say run dataglow development, you already know my pain points because i typed it
> into question 1. Also I can say edit dataglow development to edit it because it is a quedtion tree
> format prompt when it is ran. When I say, run dataglow development, a question tree will appear
> asking me questions like what to build as well as the question form adapts each time I use it because
> it also access's my GitHub repo so it already knows what is built and gives me feedback of what areas
> to tackle next to make it a great data product / tool for not only that data community but also every
> single person interested in all things data as well as marking it a powerful and capable tool /
> product to have access to get any data work tasks done because it is a ever learning cross platform
> that I'm trying to make it future proof and more!

**Q3 — How much should this change your existing standing rules?**
> A lot this I touched on in questions 1 and 2, so look at those answers. Though, I will add more. I'm
> honestly open to change. I will say a little stuff relating to Steve job. His philosophy. His privacy
> stance. I love everything about both. All this existing standing rules, no direct push to main,
> confirm before merge. The technology should be working for the human. True, things need to be
> reviewed like ai code and etc. empower the human. Simply the entire process. Use Steve Jobs philosophy
> and more. Also another Steve Jobs saying I think he touched on. Great features and great privacy. The
> entire gui, ux ui and more needs to have Steve Jon's philosophy, empower the user and more. Like make
> dataglow so simple yet also customizable and powerful like iPhone software that any data person like
> data analyst, data engineer, data scientist and other data roles can just dataglow and get real work
> done as well as learn as their work because of built in machine learning and on device artificial
> intelligence.

**Q4 — Does "one confirm at the end" match what you want, or literally zero confirms?**
> I still want to confirm. Also, I can add steps to this dataglow development. The additional add is
> this: search for anything going on in the GitHub repo that has open PR's, stuff left untouched for
> days. Etc. basically, when I type run dataglow development, the question tree is smart, intelligent
> and more because it knows my GitHub repo code and more so it can find stuff that I didn't even know
> about and bring it to my attention. No more wondering about bugs. No more wondering about prs and
> other things that haven't been turned on or other things to that nature that I'm not even mentioning.
> Is anyone else in the world thinking of this development cycle stuff? Also, have dataglow development
> give me feedback on how things are looking for the dataglow tool / product and how to make it better
> and better because that more I use the dataglow development process and question tree, the more
> information is presented to me to empower me so that I can empower the dataglow platform and more!
> Also, the more I use dataglow development process, have it learn and improve and get efficient and
> safer and build quicker without anything braking down as well as other in other areas that I'm not
> mentioning, basically the dataglow development question tree and background process and more are
> capable of learning, adapting and more each time I use it. If possible, tell me how it what ways is
> the dataglow development process and background process are learning and adapting and also since
> dataglow development trigger / process has access to my entire GitHub, give me recommendations and
> more to make the not only the dataglow development better but say and do things that make the
> dataglow cross platform idea / tool / product better. Also, since dataglow development trigger /
> question tree is smart and intelligent, any questions can be asked because each time I use the
> dataglow development trigger, it has full access to my GitHub as well the growing base it has about
> itself because database development trigger / idea has a ever growing knowledge base so it can learn
> and adapt and so much other things that I'm not mentioning. Basically, the more that I use the
> dataglow development trigger, the more it grows and adapts and so much more than what I'm mentioning
> because it has full access to my full GitHub as well as context and knowledge base and so much than
> what I'm saying or mentioning.

**Q5 — Should this fully replace list-time/dataglow-brainstorm/test-dataglow-platform?**
> Yes. I also touched upon this in question 1. Though i will answer fully. Yes. Dataglow development is
> going to be the new command center so that it can get things done in a super streamlined way. Also,
> dataglow development can learn from me as well as give me recommendations based on the status of
> dataglow as well as find even more lingering bugs, errors and more through dataglow cross platform
> mock ups as well as the live version of dataglow even if I just looking at a feature or the entire
> data project. Dataglow development can also do and use deep research, create and use ai customized ai
> agents and so many other things that I'm not mentioning. Dataglow development can even recommend
> actions that I have never seen before because it learns from me, learns from my GitHub and learns in
> some many numerous ways that I'm not even mentioning. So, since database development learns and so
> much more, it can tell me that it wants to edit steps in the database development steps because every
> time there I use database development it learns more and more in ways that I'm not even mentioning.
> Also, let's says that I got a built feature in dataglow that was created like a few days ago, I tell
> dataglow development to find it and when it does, dataglow development can inspect the fester and
> then brings up a question tree of what I can do as well as things that dataglow recommends for the
> feature to be better and so much more than what I'm saying.

### Gap flagged from this archive (not yet built — candidate for a future round)

Q4/Q5 both describe the skill proactively suggesting edits to **its own process steps** as it learns
("it can tell me that it wants to edit steps in the development steps... every time I use it, it learns
more and more"). The current `dataglow-development` skill (Step 6) logs learnings to `dev-log/journal.md`
and lets the user manually trigger "edit dataglow development," but it does not yet have the skill
proactively proposing edits to its own SKILL.md based on what it's learned. Worth considering in a future
`dataglow-development` or `dataglow-brainstorm` round — not built as part of this documentation-only commit.
