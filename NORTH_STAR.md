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
   engine in `test/sql-dialect-adapter.test.mjs`, 43/0 passing. Ships DARK behind
   `multiDialectSql` (default OFF): when on, the SQL tab shows a dialect-picker chip row
   and transpiles the user's SQL before `runQuery`; when off, the SQL tab is byte-for-byte
   unchanged and the default 'duckdb' selection is a no-op passthrough.)
2. **Batch B — Object Space registry.** (SHIPPED, merged in
   [#141](https://github.com/Andre-Weissmann/dataglow/pull/141) —
   `js/app-shell/object-space.js`: a passive, in-memory single source of truth for named
   cross-language objects (name, originLanguage, kind, schema, rowCount, provenance
   pointer), verified in `test/object-space.test.mjs`, 32/0 passing. Sits ALONGSIDE the
   existing per-language JSON bridges — does NOT replace transfer mechanics. Read-only
   "Object Space" strip in the data sidebar. Ships DARK behind `objectSpaceRegistry`
   (default OFF); zero behavior change when off.)
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
3. **Batch C — wire `densityLevel` from the real proficiency signal.** NOT STARTED. Today
   Batch A always defaults to `'low'` since it doesn't import Batch B yet. This batch is the
   thin glue: instantiate `createProficiencyTracker()` in `main.js`, call `recordAction(tabId)`
   on real query/run events, and pass `getDensityLevel()` into `computeGlowPathState(ctx)`.
   Small and low-risk since both sides are already tested in isolation.
4. **Batch D — promote `glowPathRail` to ON** once Batch C lands and the rail has been
   dogfooded, following the same visibility-flag discipline as the Readiness Gate badge
   promotion (see Lessons learned below — landing dark is not the same as shipped/visible).

---

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
