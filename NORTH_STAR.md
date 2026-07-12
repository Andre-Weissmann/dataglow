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

## Backlog (ranked, queued — not abandoned)

These lost the "combine into one" round but remain valid; pull the next one when Readiness Gate ships.

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
