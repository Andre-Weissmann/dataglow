# Working on DATAGLOW

Guidance for any coding agent (or human) making changes here. It is short on
purpose. Read it once at the start of a task, then get to work.

## What DATAGLOW is (and the one hard constraint)

DATAGLOW is a zero-server, zero-upload static site. Everything runs in the
browser: `index.html` loads vanilla ES modules from `js/`, there is no backend,
and **your data never leaves your machine** — nothing you load is ever uploaded.

The app's own code and the libraries needed on every page load are self-hosted
under `assets/`: DuckDB-WASM (SQL engine), Plotly.js (charts), and SheetJS/xlsx
(Excel parsing) are all vendored, so a normal page load fetches nothing from a
third party. The three *large* runtimes behind optional tabs — Pyodide (Python),
WebR (R), and WebLLM (the on-device Story model) — are the exception: they are
fetched from public CDNs on demand, the first time you open those tabs, because
vendoring multi-hundred-megabyte runtimes into every page load isn't practical.

**The hard constraint:** never add a runtime network dependency for the *core*
app or a build step, and never route user data off the machine. `index.html` and
the deployed site must cold-start and do their core work (load, SQL, clean,
validate, visualize) offline with no server; only the opt-in Python/R/Story tabs
may reach a CDN, and only to pull their own runtime. Tooling, tests, and docs may
use dev dependencies freely.

## Orient yourself before writing code

Before editing for a new feature or a fix, spend a moment getting the lay of the
land — it consistently saves more time than it costs:

0. **Check for overlap first.** Before anything else, run the
   [`preflight-overlap-check`](./.claude/skills/preflight-overlap-check/SKILL.md)
   skill — it searches open PRs, the capability map, and the codebase together
   for existing or in-flight work on the same thing, and routes you to extend
   an existing PR instead of silently duplicating it. This repo has already
   shipped two independent implementations of the same capability once (PR
   #108 and #114, both an "Agent Action Firewall"); this step exists so that
   doesn't happen again. Skip only for genuinely trivial one-line fixes.
1. **Find the right files.** Start from [`docs/capability-map.md`](./docs/capability-map.md).
   It maps every `js/` module to a feature area, so you can jump straight to the
   two or three files that matter instead of scanning all ~60. Open the area's
   detail file under `docs/capability-map/` only if you need it.
2. **Read them.** Read the modules you're about to touch, plus their direct
   collaborators, before changing anything.
3. **State a short plan first.** In your own words, write down what you intend to
   do *before* you edit: what will change, what will deliberately stay the same,
   and which files you expect to touch. A few lines is enough. This is a
   checkpoint against scope creep and accidental behavior changes — if the plan
   and the diff diverge, one of them is wrong.
4. **If you hit a bug, error, or a real fork-in-the-road decision, check the
   [`debug-log-tree`](./.claude/skills/debug-log-tree/SKILL.md) skill before
   re-diagnosing from scratch.** It searches `docs/tech-debt-tracker.md`, git/PR
   history, and past Perplexity Computer sessions for whether this exact problem
   (or something adjacent) was already hit, fixed, or deliberately rejected —
   then has you log the outcome so the next session doesn't repeat the work.
   This is separate from step 1's overlap check: that one is about *duplicate
   features* before you start; this one is about *repeated debugging* once
   something breaks mid-session.

Keep the plan proportionate: a one-line typo fix does not need a paragraph.

## Finish the paper trail in the same PR

A change isn't done when the code works — it's done when the record matches the
code. As part of the *same* PR (not a follow-up):

- **Add a changelog entry.** One line in [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)
  describing the user-visible or structural change. Do this as you wrap up, not
  later.
- **Record a new foundation.** If you shipped a new CI/infra foundation or a
  reusable capability (the kind of one-paragraph blurb that belongs next to the
  supply-chain and context-rot entries), add it to the *Foundations &
  capabilities* section below.
- **Keep the capability map current.** If you added, removed, or repurposed a
  `js/` module, update its area in `docs/capability-map.md` so the map never
  points at something that isn't there (and vice versa).
- **Note drift you're not fixing.** If you spot debt you're deliberately leaving
  alone, record it in [`docs/tech-debt-tracker.md`](./docs/tech-debt-tracker.md)
  so the next session doesn't re-discover it.

**Append-only zones — do not edit around them.** Three files used to collide on
every parallel PR because each new foundation had to edit surrounding prose in
all of them. They now carry explicit append-only markers; adding an entry is a
single-line insert at one fixed point, so two PRs adding different entries land
on different lines and never textually conflict. When you add an entry, insert it
*directly below* the marker and leave the existing entries above it untouched:

- `docs/CHANGELOG.md` — one-line changelog bullets go under the
  `NEW-ENTRIES-BELOW` marker in the `## Unreleased` section.
- `AGENTS.md` — foundation/capability blurbs go under the
  `NEW-FOUNDATION-ENTRIES-BELOW` marker in *Foundations & capabilities* below.
- `.github/workflows/test.yml` — new CI jobs go under the `NEW-JOB-ENTRIES-BELOW`
  marker as a new `uses:` block (see *CI is a thin orchestrator* below).

The weekly read-only [entropy-reduction scan](./docs/entropy-reduction-scan.md)
flags dangling doc references and untracked TODOs; keeping the paper trail current
in-PR is what keeps that scan quiet.

## Tests

Tests live in `test/` and run through npm scripts named `test:*` (see
`package.json`). Run the scripts relevant to what you changed before opening a
PR; CI runs the suite too. Documentation-only changes don't need new unit tests,
but do confirm every file path and link you write actually resolves.

## CI is a thin orchestrator

CI lives in `.github/workflows/test.yml`, but that file is now only a thin
orchestrator: it triggers on `push`, `pull_request`, and `merge_group`, and each
job is a one-line `uses:` call into a standalone reusable workflow named
`.github/workflows/job-<name>.yml`. Each foundation owns its own job file (one
job per file, triggered via `on: workflow_call`), so adding or changing a job
touches that job's file rather than a shared 8-job YAML. The job files sit at the
top level of `.github/workflows/` — not a subdirectory — because GitHub only
resolves reusable workflows referenced from the top level of that directory; the
`job-` prefix keeps them grouped. To add a new CI job: create
`.github/workflows/job-<name>.yml` as a `workflow_call` reusable workflow, then
append a `uses:` block for it under the `NEW-JOB-ENTRIES-BELOW` marker in
`.github/workflows/test.yml`.

## Foundations & capabilities

Self-contained, one-per-foundation notes for the CI/infra foundations and
reusable capabilities that shape how work is done here. Newest first.

<!-- NEW-FOUNDATION-ENTRIES-BELOW: append new entries directly under this line, do not edit existing entries above -->

### Source Convergence (Truth Network, Batch 3 of 3, final) — the Convergence tab UI

The first VISIBLE surface for the Truth Network: a flag-gated "Convergence" tab
that wires Batch 1's pure engine (`js/validation/source-convergence.js`) and
Batch 2's ingestion adapters (`js/validation/source-convergence-ingestion.js`)
into a real UI, inventing NO convergence logic of its own. New module
`js/validation/source-convergence-ui.js` follows the project's pure-builder /
thin-renderer split (like `js/rooms/room-ui.js` and `js/diplomacy/diplomacy-ui.js`):
the pure, DOM-free, never-throwing `buildConvergenceView(adapterResults, opts)`
runs the whole pipeline (`toEngineSources` → `buildConvergenceGraph` →
`computeConvergenceClusters` → `resolveClusterWithTrust` per conflicting cluster →
`summarizeConvergence`) and returns a DOM-free model (source rail, coverage matrix,
verdict, escalate list) with an honest `isEmpty:true` when no usable sources load —
never a fabricated demo. `buildSourceCardModel`, `sourceKindBadge`, `formatTrust`,
`buildEscalationModel`, `shouldOfferConvergence`, and the pure `toggleExpanded`
click-through transition are all Node-testable; they are split from the browser-only
renderer `mountConvergence`, which owns the two affordances Batch 2 deferred —
reading a file via the app's global `XLSX` and a user-initiated client-side
`fetch()` — each producing only a LOCAL summary (zero-upload/local-first holds).

Wired into `js/app-shell/main.js` (`renderConvergenceTab` from `switchTab`,
filtered out of `renderTabBar` when the flag is off, so the tab is ABSENT from the
DOM rather than CSS-hidden); `convergence` added to `state.tabOrder` and the
grouped-nav 'validate' mode. Ships DARK behind the new OFF-by-default
`sourceConvergenceUI` flag — with it off the app is byte-for-byte unchanged, and
Batch 1/2 public APIs are untouched. Promoting the
`sourceConvergence`/`sourceConvergenceIngestion`/`sourceConvergenceUI` trio to ON
is separate future work. Tested by `test/source-convergence-ui.test.mjs`
(`npm run test:sourceconvergenceui`, pure Node per the `room-ui` precedent).

### Query Memory (Batch 1) — per-run fingerprint + author/timestamp log

Fingerprints every SQL/Python/R/Metric Studio run and logs who/when, so a later
phase can surface a "seen before" badge grounding trust in real, validated usage
history. Explicitly complementary to the AI Readiness Gate: the Gate decides
agent-readiness now; Query Memory can become the audit trail behind those
decisions over time. New pure, browser-free, Node-testable module
`js/provenance/query-memory.js` follows the same pure-module-first, injected-store
convention `js/agents/meeting-decision-ledger.js` established: `computeQueryFingerprint`
SHA-256-hashes a canonical payload of the run's normalized text + the tables/columns
it touched, REUSING the existing `sha256Hex` primitive from
`js/provenance/provenance.js` (no new crypto); `createQueryMemoryLog({store, now})`
exposes `record`/`lookup`/`history` and talks to persistence ONLY through an
injected `store` adapter, so it is fully testable against a tiny in-memory fake and
never assumes IndexedDB exists. Batch-1 matching is EXACT and documented on purpose
(whitespace/semicolon-normalized, context-grounded, case-significant; fuzzy/near-match
deferred), and an entry NEVER persists raw query text — only the fingerprint, kind,
author, timestamp, and an optional human label.

The real persistence is a new append-only, capped (`QUERY_MEMORY_CAP` 10000)
IndexedDB store in `js/learning/memory-store.js` (`DB_VERSION` bumped 4→5, new
`queryMemoryLog` object store with a NON-unique `fingerprint` index so a re-run
appends rather than overwrites; `appendQueryMemory`/`getQueryMemory`/
`getQueryMemoryByFingerprint`/`countQueryMemory`/`clearQueryMemory`) — additive only.
Ships behind the `queryMemory` flag (OFF by default): Batch 1 is module + tests
only, NO UI and NO wiring into the run paths, so with the flag off (and even on)
nothing in the app reads or writes the log. Tests: `npm run test:querymemory`
(`test/query-memory.test.mjs`, 48 assertions), run by the new
`.github/workflows/job-query-memory.yml` CI job. Registered as the
`provenance-query-memory` capability. Later batches: wire the "seen before" badge
into the SQL/Python/R/Metric Studio run paths; consider fuzzy/near-match.

### DataGlow Live Rooms (Batch 1) — live transcript capture for the Meeting Scribe

Gives the Meeting Scribe a LIVE audio-capture + on-device speech-to-text input
path alongside the existing paste-a-transcript flow. The new module
`js/agents/live-transcript-capture.js` follows the exact pure-vs-browser split
`js/narrative/ondevice-llm.js` established: the pure half
(`isSpeechCaptureAvailable`, `assembleSegments`, `createTranscriptAssembler`) is
deterministic, DOM-free, and Node-testable, while the browser-only half
(`startLiveCapture`) lazily CDN-loads an on-device Whisper-family STT engine as
CODE (transformers.js, the same way WebLLM is loaded) — never a path that sends
user audio anywhere. `assembleSegments` turns raw STT chunks (interim vs. final
+ timestamps) into the SAME `{text, ts}` shape `parseTranscriptText` produces so
the output feeds the EXISTING, unchanged `tagSegmentsWithContext`.

Wired into `js/agents/meeting-scribe-ui.js` as additive Start/Stop live-capture
controls streaming into the same tagged-segment state and re-render path. Ships
behind the `meetingScribeLiveCapture` flag (OFF by default, intentionally dark
per the batching plan): with it off, no live-capture UI renders and every
existing path is byte-for-byte unchanged. Tests: `npm run test:livecapture`
(`test/live-transcript-capture.test.mjs`), run by the
`.github/workflows/job-live-transcript-capture.yml` CI job. Batches 2–4 (device
pairing + WebRTC read-only mirror, chart-context timeline wiring, on-device-LLM
synthesis panel) are separate future PRs.

### UX navigation & Validate declutter — grouped tab bar and focus-mode disclosure

Two presentation-only, disabled-by-default flags applying a "decide for the
user, hide complexity until earned" pass to the two biggest first-impression
friction points found by walking the running app screen-by-screen: a flat
13(+1)-tab bar with no hierarchy, and a Validate tab that dumps every control
(context input, domain pack, level, 5 export/run buttons, then the AI
Synthesis and Peer Review Mode cards) onto the screen at once.

`groupedNavigation` (`js/app-shell/tab-groups.js`): a pure reducer,
`buildTabGroups(tabOrder)` clusters the SAME tab ids `renderTabBar()` already
renders into 5 named modes — Explore (Problem Framer, Preflight), Validate &
Trust (Validate, Clean, Diff), Analyze (SQL, Python, R), Visualize & Share
(Visualize, Story), Automate (Digital Twin, Watch Folder, Meeting).
`groupForTab(tabId)` is the inverse lookup, used to highlight the active
tab's mode header. Neither function touches the DOM, `state.tabOrder`,
`switchTab()`, drag-reorder handlers, or any other tab's individual flag
gate — with the flag off, `renderTabBar()` renders the exact original flat
single-row bar. With it on, the same `.tab` elements (identical markup,
click handlers, `data-testid`s, drag/drop wiring) are grouped under
`.tab-group` headers instead.

`validateFocusMode` (`js/app-shell/validate-focus.js`): pure disclosure-state
logic, `shouldExpandAdvanced({hasRunOnce, wasManuallyExpanded})`, wraps the
Validate tab's secondary controls (now in a `<details id="validate-advanced-options">`)
and the AI Synthesis / Peer Review Mode cards (each in their own `<details>`)
under an "Advanced options" disclosure that starts collapsed until the
analyst runs validation once on the active dataset (`runValidation()` calls
`validateFocusStore.markRunOnce(ds.name)`) or manually opens any one of the
three disclosures (all three track together — one conceptual surface split
across the DOM only because the underlying cards are far apart). Per-dataset,
not global: switching datasets starts each one collapsed again via
`createValidateFocusStore()`'s in-memory `Set`s (never persisted, never
networked). `applyValidateFocusMode()` in `js/app-shell/main.js` is the only
DOM wiring; with the flag off it forces every `<details>` `open = true` on
every render, so nothing inside is removed, relabeled, or gated any
differently than before this PR — only the default open/closed state
changes, and only once the flag is on. No other existing flag
(`metricStudio`, `trustStripProofDrawer`, `conversationalPackBuilder`, etc.)
is touched; their panels render exactly as before once the disclosure they
live inside is open. Tests: `npm run test:tabgroups`
(`test/tab-groups.test.mjs`) and `npm run test:validatefocus`
(`test/validate-focus.test.mjs`).

### Governed Synthetic Data Passport (Trust Passport, Batch 4) — compose the prior batches, never upgrade a privacy claim

`js/privacy/synthetic-data-passport.js` is the finale of the four-batch Trust
Passport concept: it lets a SYNTHETIC export carry a governance record instead
of naked numbers. It COMPOSES the earlier batches and adds nothing to their
crypto or shapes — Batch 2 (`buildDataNutritionLabel`, called with
`isSynthetic:true`) is the container; the Batch 1 source-data Semantic/Metrics
Layer checks/custody/assumptions ride through that label unchanged; Batch 3
(`sealCheckResult`/`attachSealToLabel`) is optional tamper-evidence. The ONE new
thing it adds is a `synthetic` block describing HOW the data was generated and
WHAT privacy guarantee (if any) applies.

The hard rule for anyone extending it is HONEST NAMING, most acute in this batch:
assert a formal differential-privacy guarantee (a mechanism plus a specific ε)
ONLY when the generation context genuinely establishes one — a recognized
`dataglow-synthetic-twin` kind, or a Laplace/DP mechanism string, each with a
positive ε, or an explicit caller `formalDifferentialPrivacy:true` accompanied by
a positive ε. A bare ε, a heuristic generator, or an explicit
`formalDifferentialPrivacy:false` MUST yield "no formal guarantee — treat as
potentially re-identifiable". NEVER upgrade a DP budget to "anonymized", a HIPAA
Safe Harbor, an Expert Determination, or any legal/clinical determination; carry
the generator's own disclaimer verbatim; and never raise a claim's confidence
above what the source module established. Both `buildSyntheticDataPassport` and
`sealSyntheticPassport` are explicit opt-in caller actions (nothing generates or
seals on its own — the empowerment constraint), the module is pure/browser-free/
network-free, and it is additive only: it does NOT modify the Batch 1–3 modules.
Surfaced OFF-by-default behind the `syntheticDataPassport` flag. See
`test/synthetic-data-passport.test.mjs`, whose source guard enforces both the
zero-upload rule (no network primitive) and honest naming (any line mentioning
`anonymized`/`HIPAA`/`certification`/`certified` must also negate it).


### Verifiable Check Seal (Trust Passport, Batch 3) — apply the existing proof primitive, do not invent crypto

`js/provenance/verifiable-check-seal.js` seals a validation check result (e.g. a
Local Analysis Contract run) into a portable artifact that proves "a check with
these parameters ran against data matching this SHA-256 fingerprint and produced
this result" WITHOUT revealing the data. The hard rule for anyone extending it:
it does NOT contain its own cryptography — it APPLIES the Merkle-tree (SHA-256)
commitment already in `js/provenance/selective-disclosure-proof.js`, importing
`hashLeaf`/`buildMerkleTree`/`merkleProof`/`rootFromProof` over the shared
`sha256Hex` from `js/provenance/provenance.js`. If you need a new commitment
behaviour, extend the primitive, don't fork a second hashing scheme here.
`sealCheckResult(result, context)` commits check name/kind, a params fingerprint,
the data fingerprint (the ONLY thing about the raw data that ever enters the
artifact), dataset identity/columns, and the result — and REFUSES to mint a seal
with no data binding (pass `context.data` to fingerprint here, or
`context.dataFingerprint` precomputed for a large table). `verifySeal(seal, data)`
is genuinely two-layer: it re-folds every disclosed claim to the committed
Merkle root (any altered value fails), and — only when data is supplied —
re-fingerprints it so modified data fails to match (`dataMatch:false`); with no
data it reports `dataMatch:null`, never a silent pass. `attachSealToLabel(label,
seal)` is ADDITIVE: it returns a NEW batch-2 Data Nutrition Label with the seal in
a new `custodyChain.seals` array (anchored to `custodyChain.finalHash`) and every
existing custodyChain field preserved — never reshape batch 2's manifest.

HONEST NAMING is the load-bearing constraint here and it matches the register
`js/provenance/selective-disclosure-proof.js` set: this is NOT a zero-knowledge proof (params,
result, and fingerprints are cleartext; only the raw data stays private), NOT a
certification, NOT "blockchain", and never "certified". A source-guard test
enforces that any line mentioning a forbidden term also carries a negation, so
the file can only ever disclaim those words, never self-describe with them. The
seal is always minted by an explicit human action (a "Seal this result" button in
the SQL tab's Analysis Contract flow) — nothing seals automatically. Ships behind
`verifiableCheckSeal` in `flags.manifest.json` (OFF by default; the SQL-tab
affordance additionally requires `localAnalysisContract`), so with the flag off
nothing renders. Test: `npm run test:checkseal`
(`test/verifiable-check-seal.test.mjs`, pure Node — no DOM, DuckDB, or network),
in the `verifiable-check-seal` CI job
(`.github/workflows/job-verifiable-check-seal.yml`). Registered as the
`provenance-check-seal` capability.


### Data Nutrition Label (Trust Passport, Batch 2)

`js/provenance/data-nutrition-label.js` is a pure, browser-free, network-free
aggregator that ASSEMBLES a portable JSON provenance manifest from the data the
app already tracks — the tamper-evident chain of custody (`js/provenance/`), the
Assumption Ledger, and validation results — without duplicating any of it.
`buildDataNutritionLabel(ctx)` returns a self-describing manifest carrying
`kind`, an integer `schemaVersion` (currently `1`), `generatedAt`, dataset
shape, `checksRun`, `findingsSummary`, a derived `transformations` projection,
`assumptions`, `isSynthetic`, a `custodyChain` OBJECT (whose top-level
`finalHash` is the anchor point later batches build on), and a `disclaimer`;
`renderLabelSummary`/`renderLabelSummaryLines` and `exportLabelAsJSON` render it
for humans and for export. It is the shared shape Batch 3 (selective-disclosure
proofs) and Batch 4 (synthetic-data metadata) extend, so keep it simple,
versioned, and honest. HONEST NAMING is a hard rule for this surface: it is a
manifest/summary, NOT a certification — never describe it as "blockchain",
"certified", or "verified", and claim no cryptographic guarantee beyond the
SHA-256 chain the app already computes. It ships behind the OFF-by-default
`dataNutritionLabel` flag and is strictly OPT-IN in the export flow (a person
ticks `#export-include-label`; it is never auto-attached), and the export
module (`js/export/export-report.js`) stays decoupled — `js/app-shell/main.js`
renders the label lines and passes them in, so with the flag off or the box
unticked export output is byte-for-byte unchanged. Tests:
`npm run test:nutritionlabel`.

### Semantic / Metrics Layer (Trust Passport, batch 1)

`js/validation/semantic-layer.js` is a pure, browser-free, network-free module: an
in-memory registry of canonical metric definitions (name + SQL expression +
description; `requiredColumns` are *derived* from the expression, never invented,
plus owner/createdAt provenance) and a comparator `checkQueryAgainstMetrics(sql,
registry)` that pattern-matches a query's aliased `SELECT` items and its `--` /
`/* */` comments against the registry. When a query aliases a registered metric's
name over a non-canonical expression it raises a fourth Local Analysis Contract
finding class, `metric_definition_mismatch` (`warn`, naming the missing term); a
comment-only claim is `info`. It is **flags-only** — like the rest of the Contract it
never rewrites, blocks, or auto-corrects (empowerment constraint). The name is
honest: this is a pattern-matched registry + string comparator, not an AST or an
"AI" — see the tech-debt note on its false-negative envelope. The registry lives in
memory only (no localStorage / cookies / network), consistent with the flag-manifest
runtime; a portable export is a later batch. Stable exported API relied on by later
batches: `registerMetric(def)`, `getRegisteredMetrics()`, `getMetric(name)`,
`checkQueryAgainstMetrics(sql, registry)` (plus `unregisterMetric`, `clearMetrics`,
`deriveColumnsFromExpression`).

Wiring stays pure: `runAnalysisContract(sql, schema, options)` gained an opt-in
`options.metrics` registry and reads **no flags itself**, so with the registry absent
the Contract is byte-for-byte the original three finding classes (the existing suite
is unregressed). Only `js/app-shell/main.js` consults the flag — it supplies the
registry, and mounts the human-authored "Define a metric" affordance
(`js/validation/semantic-layer-ui.js`, gate `shouldOfferMetricDefiner({enabled})` +
`mountMetricDefiner({host, onRegister, onToast})`), when and only when
`isEnabled('semanticMetricsLayer')`. That flag is new and ships **OFF**; it is
deliberately distinct from `localAnalysisContract`. Tests: `test/semantic-layer.test.mjs`
(`npm run test:semanticlayer`, the `semantic-layer` CI job).

### Semantic drift watchdog — de-duplicated drift alerts for Watch Folder

`js/ambient/drift-watchdog.js` is a pure, dependency-free, Node-testable
presentation/de-duplication layer over the distribution-drift validation
result `js/validation/validation.js`'s `runAllLayers` already computes (`results.distribution_drift`,
including its Holt-forecast alerting from `js/drift/drift-forecast.js`). It
adds ZERO new statistical detection — its only job is deciding whether an
already-computed drift finding is worth surfacing again, so the Watch Folder
poll loop (which automatically re-validates a changed file with no manual
click) doesn't re-show the SAME finding on every unchanged re-check and train
users to ignore the alert. `summarizeDriftEvent(drift)` normalizes the layer
result into `{severity, headline, lines}`, degrading to a silent pass on
missing/malformed input rather than throwing — this module must never be the
reason an automatic background re-check fails. `alertFingerprint(summary)` is
a stable, line-order-independent content hash. The `DriftWatchdog` class
tracks one fingerprint per file name (`.observe(fileName, drift)` →
`{summary, isNew, shouldNotify}`; `shouldNotify` is true only when the
severity isn't `pass` AND the fingerprint changed since that file's last
observation), with `.clear`/`.clearAll` to explicitly re-arm. Wired into
`js/app-shell/main.js`'s `watchIngestAndValidate` behind a new, disabled-by-default
`semanticDriftWatchdog` flag (land dark, same pattern as `conversationalPackBuilder`);
when on, a new drift finding renders as a `validation-status` line beneath the
file's row in the Watch Folder status list, reusing the existing `pass`/`warn`/`fail`
tones (`css/app.css` has no other tone — do not invent one). Empowerment
constraint compliance: this module only decides what to SURFACE for the user
to read; it never modifies, cleans, or discards data itself. A native,
OS-level (Tauri/Rust `notify` crate) file-watch trigger for the desktop shell
was deliberately scoped OUT of this PR — this sandbox has no Rust toolchain to
compile/verify one, and Watch Folder itself is browser-only today (see
`docs/tech-debt-tracker.md`, 2026-07-11 entry) — `js/ambient/drift-watchdog.js` was
designed trigger-agnostic specifically so that follow-up can reuse it
unchanged once it exists. Test: `npm run test:driftwatchdog`
(`test/drift-watchdog.test.mjs`, 32 tests: summarization incl. malformed-input
safety, fingerprint stability/order-independence, per-file de-duplication incl.
pass→fail and fail→different-fail transitions, `.clear`/`.clearAll` re-arming).

### Metric Contracts, Batch 3 — confirm gate (the safety-critical batch)

`js/metrics/metric-contract-confirm-gate.js` is the ONLY path in this codebase
by which an AI-agent-proposed change to a metric contract can ever reach
`MetricContractHistory.recordVersion()`. `proposeContractChange({metricId,
currentMetric, candidate, proposedBy, reason})` builds a plain, inert proposal
object — pure data construction, zero side effects, nothing written anywhere;
this is the only thing an agent caller may produce. `buildProposalDiffContent()`
reuses Batch 2's `buildDiffViewContent` completely unmodified, so a pending
proposal renders pixel-for-pixel identically to how a past human edit renders
— an agent's proposed change is never given different visual treatment.
`approve({proposal, contractRegistry, metricRegistry})` is the one and only
function that calls `recordVersion()` with `source: 'agent-proposed'`; it also
updates the metric's live definition in the same call so the contract history
and the live metric never drift apart. It runs ONLY from the one Approve
button `renderConfirmGate()`'s DOM presenter renders — there is no auto-approve
timer, config flag, trusted-agent bypass, or any other path in. It is
idempotent (approving an already-applied proposal twice never double-appends
history) and refuses cleanly — without touching anything — when given no
contract registry, no metric registry, or an already-rejected proposal.
`reject({proposal, note})` writes nothing anywhere, ever, is likewise
idempotent, and cannot retroactively undo an already-applied proposal.
`renderConfirmGate()` shows the Batch 2 diff view plus two EQUAL-weight
Approve/Reject buttons (this project's established never-nudge-toward-accept
pattern, from the conversational pack builder) and re-renders to a static
applied/rejected state immediately after a decision so a stale second click
can't matter. This batch directly reaffirms and tests DATAGLOW's hard
autonomy-safety rule — an agent may propose, a human must approve every
mutating action individually — the concrete cautionary precedent being the
April 2026 incident where a Cursor AI agent deleted a company's entire
production database and its backups in 9 seconds with no confirmation prompt.
Nothing in `js/app-shell/main.js` calls `renderConfirmGate()` yet: no AI agent
in the running app can generate a real proposal through this gate today —
this batch only builds and tests the gate itself. Tests:
`npm run test:metriccontractconfirmgate` (16 cases, pure Node): propose/
approve/reject correctness, idempotency, all four refusal paths, and an
explicit end-to-end scenario proving repeated reads/renders of a pending
proposal never mutate the live metric or the contract history.

### Metric Contracts, Batch 2 — read-only diff view

`js/metrics/metric-contract-diff-view.js` turns two of Batch 1's version
entries into something a person can read: `buildDiffViewContent({metricName,
before, after})` returns a normalised block model (field-by-field before/after,
who changed it, when, why, and human-vs-`agent-proposed`) sourced ONLY from the
real recorded version metadata — never invented, and honestly omitted (no kv
blocks at all) when a bare snapshot with no wrapper metadata is passed.
`buildHistoryListContent({metricName, versions})` renders the full oldest-first
timeline. `renderDiffView()` is the DOM presenter, following
`js/trust/proof-drawer.js`'s exact pure-content/DOM split and reusing its
`kv`/`text`/`list` block-kind renderers (copied locally rather than imported,
since proof-drawer doesn't export its renderer) plus one new `field-diff` kind
(side-by-side red/green before/after) this file renders itself — so a human's
past edit and an AI's future proposed edit will look visually IDENTICAL. This
batch is READ-ONLY: no apply/accept button, no write path, and nothing in
`js/app-shell/main.js` calls `renderDiffView()` yet. Batch 3 wires a confirm-gate around
this exact same builder/renderer for AI-proposed changes — one explicit human
click required before anything applies, nothing auto-applies, ever. Tests:
`npm run test:metriccontractdiffview` (20 cases, pure Node), added to the
existing `.github/workflows/job-metric-contracts.yml` CI job.

### Metric Contracts, Batch 1 — versioned metric-definition data model

`js/metrics/metric-contracts.js` adds an append-only version history
(`MetricContractHistory`/`MetricContractRegistry`) that sits ALONGSIDE Metric
Studio's `MetricRegistry`, not inside it — that registry needed zero code
changes for this to exist. `recordVersion()` snapshots only the
contract-relevant fields (`name`/`plainEnglish`/`expression`/`owner`/`tag`) via
`snapshotDefinition`, deliberately excluding runtime fields
(`computedValue`/`status`) since recomputing or recertifying a metric is not a
definition change. Entries are immutable and append-only: there is no
update()/remove() on `MetricContractHistory` on purpose — the array itself is
the audit trail. `diffVersions(before, after)` is the one pure function that
computes what changed between any two snapshots; `summarizeDiff` renders a
one-line label. This is Batch 1 of a multi-batch build: pure logic only, no DOM
presenter, and nothing calls `recordVersion` from anywhere in the app yet — so
the new `metricContracts` flag (default OFF, added this PR) currently gates
nothing observable. WHY this exists: the practitioner-confirmed #1 cause of
dashboard distrust is conflicting metric definitions that silently drift, not
dirty data — this is the record of who changed what, when, and why. Batch 2
adds a diff-view UI reading this same `diffVersions` output; Batch 3 adds a
confirm-gate so that any AI-agent-proposed change to a metric renders as this
exact diff and requires one explicit human click before it applies — nothing
auto-applies, ever, per this repo's hard autonomy-safety rule. Tests:
`npm run test:metriccontracts` (21 cases, pure Node, no DuckDB), CI job
`.github/workflows/job-metric-contracts.yml`.

### Command Deck sidebar nav (Part 1) — decision record and safety posture

`js/app-shell/command-deck-nav.js` regroups the app's 13 real tabs (read from
`js/app-shell/state.js`'s `tabOrder`) into 5 Trust-Tier Lifecycle Stages —
Frame (`framer`/`preflight`/`watch`), Work (`sql`/`python`/`r`/`clean`), Trust
(`validate`/`diff`), Generate (`twin`), Tell (`visualize`/`story`) —
as an ALTERNATE left-sidebar nav, not a replacement. `COMMAND_DECK_STAGES` is
the static mapping; `buildSidebarContent({tabMeta, activeTab})` is the pure
content-model builder (resolves each tab's real label/icon from the caller's
`tabMeta`, marks the active tab, and reports `unassignedTabs` honestly rather
than silently dropping any tab that isn't mapped to a stage);
`validateStageCoverage(realTabIds)` and `stageForTab(tabId)` are pure helpers.
Wired into `js/app-shell/main.js` as `renderCommandDeckSidebar()`, called from
`init()` and at the end of `switchTab()`. Renders into `#command-deck-sidebar`
in `index.html`, a new element that sits alongside — never inside — the
existing `<nav class="tabbar">`; it does not reuse `#data-sidebar`, which is
unrelated dataset-loading UI. Ships fully dark behind the `dataglowSidebarNav`
flag (off by default): with the flag off, `renderCommandDeckSidebar()` hides
the host and renders nothing, so the top tab bar remains the app's one and
only nav, byte-for-byte unchanged. `npm run test:commanddecknav`
(`test/command-deck-nav.test.mjs`, 14 tests) regex-extracts the real
`TAB_META` block straight out of `js/app-shell/main.js` at test time via
`readFileSync`, so this mapping can never silently drift out of sync with the
app's actual tool list — the same drift-proofing pattern as the
capability-map/AGENTS.md gates below, applied to a UI content model instead
of a doc.

**Decision record (read before starting Command Deck Part 2 or Part 3):** the
UI/UX brainstorm report offered three candidate navigation directions —
Command Deck (Trust-Tier stages + palette + next-step rail), Conversational
Front Door, and Lifecycle Canvas. Command Deck was chosen because it is the
most evidence-based (it directly answers the report's measured "13 flat tabs"
usability problem, cross-checked against real products the report studied —
Databricks, ThoughtSpot) and lowest-risk; the report itself flagged the bolder
ideas as better attempted only after this foundational piece is live and
reviewed. Within Command Deck, only Part 1 (this sidebar regroup) is built
here — Part 2 (command palette, future `dataglowCommandPalette` flag) and
Part 3 (adaptive next-step rail, future `dataglowNextStepRail` flag) are
deliberately deferred to their own future batches, honoring the standing
"build piece by piece" convention even under a "build all" instruction that
was answered at the level of the three TOP-LEVEL candidate directions, not as
license to skip the internal staged risk ordering within one of them. Naming
was kept exactly as proposed by the report: "Command Deck," stages named
Frame/Work/Trust/Generate/Tell.
### Personal Data Bill of Materials — composed export, not a new trust claim

`js/provenance/data-bom.js` builds a one-click, fully offline "ingredient
label" for a dataset: **source** (name/table + caller-supplied description),
**schema** (`schemaSignature`/`schemaVersionHash` — a deterministic sorted
`[name,type]` fingerprint; intentionally re-implemented rather than imported
from `js/validation/validation.js`'s own `schemaSignature`, keeping this
module pure and DB-free on its own), **distribution** (the EXISTING
`computeDistributionFingerprint` column-stats snapshot, wrapped in try/catch
and set to `null` on failure — a stats miss degrades that one field, never
the whole BOM build), **localModel** (id/label/`used` flag of the on-device
LLM via `buildLocalModelRecord`, gated on `ondeviceLLM.isModelLoaded()` at
build time — never assumed true), and the dataset's full EXISTING provenance
**attestation**, reusing `js/provenance/provenance.js`'s `buildAttestation`/
`computeAttestationDigest` verbatim rather than deriving a second hash chain.
The whole BOM carries its own outer SHA-256 digest (`verifyPersonalDataBom`
recomputes and compares) and the SAME honest-labelling notarization
convention as the existing attestation — `{status:
'digest-ready-for-notarization', notarized: false}` — never a claim of
third-party signing. `npm run test:databom` (`test/data-bom.test.mjs`, 44
tests) covers shape, digest verification, tamper detection across three
separate fields, graceful degradation (missing distribution/localModel/empty
provenance chain), honest-labelling, determinism, and HTML-escape safety on
the companion `renderPersonalDataBomHTML` certificate renderer. New
`protocol/schema/personal-data-bom.schema.json` (`$ref`-linked to the
existing `protocol/schema/provenance-attestation.schema.json`) registered in
`js/protocol/protocol-conformance.js`'s `SCHEMA_FILES` map — core schema
count is now 6, not 5; a hardcoded schema-count assertion in
`test/protocol-schema.test.mjs` was bumped accordingly, so if you add a 7th
core schema, bump that count again rather than being surprised the test
fails.

Wired into the Provenance panel behind a new `personalDataBom` flag (off by
default, land-dark pattern): two buttons in `index.html`
(`#btn-databom-export` / `#btn-databom-html`, `display:none` by default) are
un-hidden only when `isEnabled('personalDataBom')` is true, wired in
`js/app-shell/main.js` via `buildBomForActiveDataset()`. EMPOWERMENT
CONSTRAINT compliant: this is a read-only export of state the app already
computed for the active dataset — it never mutates the dataset, never runs a
new inference beyond the existing distribution-fingerprint call, and never
shares or applies anything without the explicit button click that triggers
it. If you extend the BOM with a new field, keep the same discipline: only
compose from an EXISTING computed value (or accept the field being `null` on
failure) rather than introducing a new inference inside this module.
### Analysis robustness — assumption sensitivity + plain-language verdict

`js/analysis-robustness/robustness-verdict.js` thickens the previously
single-module "Analysis robustness" area with two pure, browser-free,
network-free functions that EXTEND (never replace) Devil's Advocate
(`attackAnalysis`). `mapAssumptionSensitivity({columns, rows})` answers "which
rows is this A-vs-B finding actually resting on": it greedily removes the row
that most shrinks the |A−B| gap (O(n) per step via running group sums, never
emptying a group) until the gap reverses or disappears (≤25% of original),
returning the minimal breaking set, whether those rows concentrate in one named
segment, and a scale-free severity (`fragile`/`moderate`/`robust`/`no-effect`).
`robustnessVerdict(attackReport, sensitivityReport)` folds that map together with
the bootstrap/trimmed/leave-one-out result into ONE fixed-vocabulary object
`{verdict:'robust'|'fragile'|'inconclusive', reason, drivingFactor}` whose reason
is one plain-English sentence GROUNDED in the real numbers — never a generic
template, and a robust finding is told so plainly rather than only flagging
fragile ones. Contract for anyone extending this: keep the output data-shaped
(plain objects/strings, no DOM), because a future stakeholder-facing "Reverse
Data Story" surface (explicitly out of scope here) will render it. It ships dark
behind the `robustnessVerdict` flag; when on, `initDevilsAdvocate` in
`js/app-shell/main.js` appends the verdict beneath the existing Devil's Advocate
checks, when off the card is unchanged. Test: `npm run test:robustnessverdict`
(`test/robustness-verdict.test.mjs`, pure Node), in the `analysis-robustness` CI
job. Registered as `analysis-robustness-sensitivity-verdict` in
`capability-map.manifest.json`.

### OneCanvas Phase 1 — Metric Studio, Trust Strip, Proof Drawer (Parts 3–5)

Three new capabilities under `js/metrics/` and `js/trust/`, all shipping dark
behind `metricStudio` and `trustStripProofDrawer` in `flags.manifest.json`
(both default OFF). Each follows the repo's pure-logic-vs-DOM split so the value
logic is Node-testable without a DOM: `js/metrics/metric-studio.js` exports the
pure `validateMetricDefinition`/`computeMetricValue`/`findDuplicates`/
`suggestExpression`/`textSimilarity`/`referencedIdentifiers` plus the local-only
`MetricRegistry` (in-memory + JSON export/import, mirroring
`js/packs/pack-registry.js`) and the DOM `renderMetricStudio`;
`js/trust/trust-strip.js` exports the pure `collectTrustSignals` + DOM
`renderTrustStrip`; `js/trust/proof-drawer.js` exports the pure
`buildProofContent` + DOM `openProofDrawer`. HONESTY CONTRACT for anyone
touching these: every number/status shown MUST trace to real computed data —
`computeMetricValue` runs the formula against the loaded DuckDB table and stores
the true value or the error (never a placeholder); `collectTrustSignals` reports
"not yet validated"/"not checked"/0-0-0 rather than faking a signal when the
backing data is absent; and the Proof Drawer's provenance view REUSES
`renderAttestationHTML()` from `js/provenance/provenance.js` — do not duplicate
the attestation renderer. Tests: `npm run test:metricstudio` (native DuckDB) and
`npm run test:truststrip` (pure). Wired in `js/app-shell/main.js` behind the two
flags; with both off nothing renders (regression-guarded in the truststrip test).
### Re-check a challenged number through the EXISTING resolver — read-only, honest candidate

When a surface captures a human "are you sure?" moment (a meeting pushback line, a
review comment, an audit-trail dispute), the way to let it actually re-check the
number is to build a candidate for the EXISTING on-device resolver
(`js/agents/uncertainty-resolver-agent.js` `resolve()`), never to argue in prose or
invent a finding. The reference is `buildPushbackCandidate` in
`js/agents/meeting-scribe-agent.js`, wired into `js/agents/meeting-scribe-ui.js`.
Two rules make it safe and honest: (1) the candidate must be HONEST — `observation`
quotes literally what was said, it fabricates no statistic and sets no
`stat`/`severity` (so `resolve()` cannot take Step A's hard-constraint fast path),
and `ruleGuess` is a generic placeholder, not an invented specific rule; use a NEW
category (here `'meeting-pushback'`) that is not `'impossible'`/`'outlier'` so the
resolver routes A(skip)→B(skip)→C, the three-persona debate, which then has genuine
detail to reveal via `buildDebateDiagnostics`. (2) the re-check is READ-ONLY
DISPLAY — it renders the Step-D suggestion + the opt-in collapsed-by-default
disclosure and NOTHING else; it writes to no pack, rule, dataset, metrics registry,
or ledger, auto-applies nothing, degrades gracefully if `resolve()` throws, and
names no network or apply/mutation primitive (assert both with a source scan in the
tests, as `test/meeting-scribe.test.mjs` does). Applying anything is a separate,
explicit, human-confirmed step that does not belong in the re-check path.

### Propose a correction from the audit trail — draft, never auto-apply

A recurring, surface-agnostic pattern for turning DATAGLOW's own recorded audit
data into a corrective proposal WITHOUT ever crossing the no-auto-apply line.
`js/provenance/incident-postmortem.js` is the reference: `draftPostmortem({incident,
provenanceTrail, assumptionLedger?, fingerprint?, badges?, debateResolution?,
metricInvolved?})` reconstructs a timeline **1:1 from the supplied provenance
trail** (`js/provenance/provenance.js` `getTrail()`) — it invents no step and adds
no logging system; the sole non-provenance marker is the incident-discovery
moment, taken straight from `incident.discoveredAt` and tagged `source:'incident'`
— then writes a deterministic, template-based root-cause narrative (no LLM call,
in the spirit of `js/agents/question-generator-agent.js`) and a PROPOSED
correction carrying a `{score,label}` safety score in the exact vocabulary and
thresholds of `js/cleaning/fix-confidence.js`.

The load-bearing rule: **the module applies nothing.** It has no imports, mutates
none of its inputs, names no apply/mutation/network primitive, and labels every
draft `isProposal:true`/`applied:false`. Applying a proposal is a SEPARATE,
explicit, human-confirmed action wired in `js/app-shell/main.js` — the "Report
incident" action on a Validate-tab finding renders the draft with Accept/Dismiss,
and Accept routes an annotate-only correction through the SAME confirm-gated
domain-pack path a hand-authored rule uses (`communityPack.importPack` →
`domainPhysics.registerRuntimePack`, behind an explicit `confirm()`), while
Dismiss discards with zero side effects. This is the confirm-gated discipline
(pure module PROPOSES; only a main.js click handler APPLIES) generalised from
cleaning fixes to audit-trail-driven rule/metric corrections: any future feature
that "suggests a fix from what we recorded" should draft a labelled proposal and
hand the apply to an existing confirm-gated path, never invent a new one. The
optional cross-batch inputs (fingerprint/badges/debate/metric) are referenced
when supplied but never required — a postmortem works from `incident` alone.

### Analysis fingerprint + nutrition label — make a result checkable at a glance AND cryptographically

Two coupled, pure modules give a computed result two independent trust checks a
non-expert can act on. `js/provenance/analysis-fingerprint.js` is the crypto
half: `computeAnalysisFingerprint({resultData, sqlOrPipelineDescription,
parameters, metricsRegistryVersion, datasetProvenanceHash}, {label})` returns a
self-describing record whose `digest` is a SHA-256 over a canonical JSON payload
of the result plus the inputs that produced it, and `verifyAnalysisFingerprint(record,
recomputedInputs)` is a pure recompute-and-compare that needs only the record +
an independent recomputation (no app state). It REUSES `sha256Hex` from
`js/provenance/provenance.js` via `crypto.subtle` — do NOT add a second hash, an
external crypto library, or any zero-knowledge machinery. HONEST LABELLING is a
hard rule here, matching the attestation module's discipline: this is a
"tamper-evident content fingerprint" that proves integrity, NOT authorship or
existence-at-a-time — there is no signing key or timestamp authority, so never
describe it as signed, notarized, or certified, and never fake a signature claim.
`js/provenance/nutrition-badges.js` is the visual half: a frozen `BADGE_CATALOG`
(text/unicode glyphs only — no image assets, no icon library) plus pure
`computeBadges(context)`. The binding rule is **no decorative badges** — every
catalog entry carries a `check(context)` that returns backing detail only when a
REAL signal is present (calibrated grades, missingness findings, row count below
`SMALL_SAMPLE_THRESHOLD`, outlier-layer status, a fingerprint record, a Step-C
`resolvedBy==='C'` debate resolution), so a badge can never be emitted without its
evidence; a candidate badge that can't be honestly computed (e.g. "Truncated
Axis", which has no signal in `js/runtimes-viz/visualize.js`) is recorded in
`docs/tech-debt-tracker.md`, not faked. Both are wired end-to-end on ONE surface
so far — `renderDataHealth` in `js/app-shell/main.js` (the Validate-tab Data
Health dashboard) — deliberately lazy-imported and idempotent; other surfaces are
tracked as tech debt. Registered as the `provenance-analysis-fingerprint`
capability (`platforms: ["browser","desktop"]`). Tests: `npm run test:fingerprint`
(`test/analysis-fingerprint.test.mjs`) and `npm run test:badges`
(`test/nutrition-badges.test.mjs`), the `analysis-fingerprint` CI job — both pure
Node, no browser/DuckDB/network.

### Shared metrics registry — one "define once" source of truth per session

`js/app-shell/metrics-registry.js` is the in-session shared registry of named
metric definitions (e.g. `revenue` → `SUM(amount)`), so the SQL / Python / R /
Visualize / Story surfaces never silently compute the same business term two
different ways within one session. It is deliberately scoped to ONE browser
session / dataset — NOT a multi-user/org semantic layer. A metric only NAMES a
read-only SQL expression evaluated over the active dataset's DuckDB table: the
module never runs SQL and never mutates data, so **DuckDB stays the sole compute
engine — do not build a second one here**. `createMetricsRegistry()` is pure and
dependency-free (mirrors `js/learning/signal-store.js`): `defineMetric` /
`getMetric` / `hasMetric` / `listMetrics` / `removeMetric` /
`resolveMetricSql(name, {alias})` / async `fingerprint(name)` (which reuses
`sha256Hex` from `js/provenance/provenance.js` via a LAZY dynamic import — don't
add a second hash), plus the standalone `expandMetricReferences(sql, registry)`
that rewrites `@name` tokens into compiled fragments. Registries are keyed per
dataset table name in `js/app-shell/state.js` (`getMetricsRegistry` /
`getActiveMetricsRegistry`), exactly like the per-table provenance chains, so
switching datasets yields a fresh isolated registry. Two rules bind anyone
extending this: (1) **defining is safe, adopting is a click** — defining a
metric only names a read-only expression, but any UI that propagates a metric
into a query/surface must stay an EXPLICIT user action, never silent
propagation (the SQL tab's "Saved Metrics" Insert button and `@metric`
expansion in `runSqlQuery` are the reference wiring). (2) Validation is
engine-free and fails loud at define-time (bad name, empty/non-string
expression, `;`, full statement, unbalanced parens, unterminated string) — it is
NOT a second SQL parser, so don't grow it into one. Only the SQL tab is wired so
far; the other four surfaces are tracked in `docs/tech-debt-tracker.md`. Test:
`npm run test:metricsregistry` (`test/metrics-registry.test.mjs`, the
`metrics-registry` CI job) — engine-free.

### Meeting decision ledger (Gen 43, Part 3) — chart-anchored, append-only, opt-in

The first piece of the "Meeting-to-Metric Provenance" concept: a permanent,
on-device record of a meeting's pushback moments, data requests, and action
items, so nothing noteworthy is lost the moment someone leaves the Meeting tab
or clicks Clear. Pure logic lives in `js/agents/meeting-decision-ledger.js` —
`buildLedgerEntriesFromMeeting` takes Part 1's already-tagged segments and
action items and keeps only the noteworthy ones (never every line, unless a
caller opts into `includeAllLines`); every entry keeps whatever chart
`context` Part 1 attached, or `null` if none was available — nothing here
ever invents a chart reference. `saveLedgerEntries`/`loadLedgerEntries` talk
only to an injected `store` adapter (mirroring `js/learning/memory-store.js`'s
`appendLedgerEntries`/`getLedgerEntries` contract, the same injection pattern
`js/learning/self-learning-rules.js` already uses), so the pure module has no
hardcoded storage import and is fully testable with an in-memory fake — see
`test/meeting-decision-ledger.test.mjs` (`npm run test:decisionledger`), 32
assertions covering entry construction, meeting-to-entries conversion,
persistence via the fake store, filtering/summarizing, export formatting, and
a source-scan proving the file names no network primitive in actual code.

Append-only by design: resolving an action item later writes a NEW ledger
entry rather than editing the old one in place, so the history of "was this
ever open" can never be silently rewritten. Persistence itself is a new
`meetingDecisionLedger` object store added to the existing shared
`dataglow_memory` IndexedDB in `js/learning/memory-store.js` (bumped to
`DB_VERSION = 4`; capped at 5,000 entries, oldest evicted first;
`clearLedgerEntries` wipes only this store, same pattern as `clearBaselines`).

The UI half, `js/agents/meeting-decision-ledger-ui.js`, is a SEPARATE section
mounted into a SEPARATE host (`#meeting-decision-ledger-body` in
`index.html`) underneath the existing Meeting Scribe screen, gated by its OWN
flag `meetingDecisionLedger` (not `meetingScribe`) so it ships dark
independently of that flag's state. `shouldOfferDecisionLedger({enabled})` is
the pure gate; `mountDecisionLedger({host, store, getCurrentMeeting, onToast})`
renders a `[Save this meeting to ledger]` button that reads the sibling
screen's current state ONLY on click — nothing here auto-saves anything, the
same EMPOWERMENT CONSTRAINT documented in `js/agents/meeting-scribe-agent.js` —
plus a browse list filterable by chart/type, an `[Export ledger (.json)]`
button (a client-side Blob/anchor-click download, no network call), and a
`[Clear ledger]` button that confirms first. To make this possible without
breaking Part 2's encapsulation, `mountMeetingScribe`'s return value in
`js/agents/meeting-scribe-ui.js` gained one new key, `getState()` — a
read-only snapshot of `{meetingId, taggedSegments, actionItems}` — alongside
the existing `destroy`; this is additive only and changes no existing
behavior for callers (including Part 2's own tests) that only use `destroy`.
`js/app-shell/main.js`'s `renderMeetingScribeTab()` now also calls a new
`renderDecisionLedgerSection()`, which independently checks
`isEnabled('meetingDecisionLedger')` before mounting into
`#meeting-decision-ledger-body`, wiring `memoryStore` in as the store adapter.
New real-browser Playwright test `test/meeting-decision-ledger-ui.test.mjs`
(`npm run test:e2e-decisionledger-ui`), 14 assertions covering the gate,
analyze→save→browse flow, empty-save no-op, chart filtering, and clear — all
against an in-memory fake store, no real IndexedDB dependency in CI. No flag
flipped; both `meetingScribe` and `meetingDecisionLedger` ship OFF.
### Agent Action Firewall (DataGlow Passport, Batch 1) — the human-confirmation gate for data mutations

`js/agents/agent-action-firewall.js` is the single, central checkpoint every
data-MUTATING code path must pass through. It is pure, dependency-free, and
browser-free (imports nothing; names no network primitive), following the shape
of `js/packs/pack-network-guard.js` and `js/validation/analysis-contract.js`. Its
one job is to make a hard, non-negotiable rule structurally true: no autonomous
agent, suggestion engine, or AI-generated proposal may modify/clean/delete/mutate
loaded data without an explicit, per-action human confirmation — and there is NO
trusted-mode / force / auto / bypass parameter anywhere that skips the gate (a
red-team suite proves those flags are inert). It is the coded lesson of the April
2026 incident where an AI agent with unrestricted permissions deleted a
production database and all backups in nine seconds with no confirmation step.

The gate is a two-phase handshake and FAILS CLOSED. `proposeAction()` classifies
risk/reversibility via `classifyAction` (destructive `delete-rows`/`drop-table` →
CRITICAL+irreversible; in-place `impute`/`update-values` → MODERATE; additive
`annotate` → LOW; any *unrecognized* kind → CRITICAL+irreversible, so unknowns
fail safe not open) and mints a single-use per-proposal nonce, executing nothing.
`confirmAndApply()` runs the caller's executor ONLY after verifying the
confirmation is `confirmed === true` (strict — truthy `"true"`/`1` is rejected),
echoes the proposal's exact nonce (a confirmation for one action can't be
replayed onto another, and a nonce is single-use), carries an authenticated
identity, and supplies an executor; any missing/invalid piece throws
`AgentActionBlocked` and the executor is never called. THE IDENTITY RIDER: the
confirmation must carry a minimal LOCAL human identity (`normalizeIdentity` — a
locally-set display name and/or per-session/device id; never a network account,
never uploaded), captured at the moment of confirmation and folded into the
assumption ledger + the hash-chained provenance step so the trail names *who*
authorized each mutation. Provenance/ledger writing is done through an INJECTED
`recordAudit` recorder (best-effort — called before the executor, never blocks a
confirmed mutation) so the module stays browser-free.

Wired ADDITIVELY and DARK behind the `agentActionFirewall` flag (off by default).
With the flag off, `js/app-shell/main.js`'s Clean-tab fix handler calls
`clean.applyFix` exactly as before (zero runtime change); with it on, the same
fix-button click (which IS the per-action human confirmation) routes through
`firewall.guardMutation`. The pre-existing gate lived only in that UI click
handler while `clean.applyFix` itself was ungated — the firewall centralizes and
hardens the gate so a direct call path can no longer bypass it. Test:
`npm run test:firewall` (`test/agent-action-firewall.test.mjs`, 61 red-team
cases), CI job `.github/workflows/job-agent-action-firewall.yml`. Registered as
capability `agent-action-firewall` in `capability-map.manifest.json`. Out of
scope here (later Passport batches): Sandbox Twin, Open Floor, and routing the
self-learning / pack-builder / meeting-scribe write paths through the gate.

### Meeting scribe — Meeting-tab UI wiring (Gen 43, Part 2)

The screen Part 1 deliberately left for a follow-up now lives in
`js/agents/meeting-scribe-ui.js`, a thin presenter mirroring
`js/agents/conversational-pack-ui.js`'s shape: a pure gate `shouldOfferMeetingScribe({enabled})`
(the single predicate the caller checks) and `mountMeetingScribe({host, onToast})`,
which renders a paste/type-transcript textarea, an `[Analyze transcript]` button, and
groups the Part 1 agent's output into Pushback moments / Data requests / a full
tagged-line list, plus a small action-item tracker whose rows show "Open" until
owner + due date + outcome are all filled in and saved (per Part 1's
minimum-viable-action-item rule), then flip to "Resolved". `parseTranscriptText`
turns pasted/typed lines into `{text, ts}` segments — a leading integer is read as an
explicit second-based timestamp, a bare line is auto-numbered one second after the
previous, so typing plain text works with zero setup. There is still NO audio
capture or speech-to-text here — a person supplies the transcript text themselves;
that capture path stays a separate, harder follow-up.

`js/app-shell/main.js` adds a new `meeting` tab, but only to the RENDERED tab list —
`renderTabBar()` filters `state.tabOrder` down with
`tabId !== 'meeting' || isEnabled('meetingScribe')` before drawing the bar, so with the
flag off (its shipped default) the tab is not just hidden but never added at all —
there is no dead click target and no stale DOM. `switchTab('meeting')` lazily calls
`renderMeetingScribeTab()`, which re-checks the flag and the gate before mounting into
`#meeting-scribe-body`, and only mounts once per session so a person's typed-in
progress is never wiped by revisiting the tab. New real-browser Playwright test
`test/meeting-scribe-ui.test.mjs` (`npm run test:e2e-meetingscribe-ui`): asserts the
gate, transcript parsing (explicit vs. auto-numbered timestamps), the full
analyze flow (pushback + data-request detection, full tagged list, blank-input
no-op), and the action-item open→partially-filled-stays-open→resolved flow. No flag
flipped.

### Provenance Packet (Batch 1) — cell-level blame + de-identification verifier

Two browser-free, network-free capabilities that build on the existing hash-chain
provenance ledger (`js/provenance/provenance.js`). `js/provenance/data-blame.js` is
a pure READER over that chain — it does NOT introduce a parallel log. Transform
call sites in `js/app-shell/main.js` now standardize each `recordStep` `detail`
via `buildBlameDetail(...)`; the reader's `normalizeBlameEntry` still reads the
legacy `{fixType, column}` shape, so old trails keep working. `buildBlameIndex`,
`blameForColumn`, and `blameForCell` answer "what changed this cell and why" from
the chain alone. `js/provenance/deidentification-verifier.js` runs the 18 HIPAA
Safe Harbor categories (`HIPAA_SAFE_HARBOR`) against loaded columns/samples,
scores re-identification risk from quasi-identifiers (the {date-or-age, sex, zip}
trio drives the score up), and produces a SHA-256-signed attestation via the same
`sha256Hex` primitive the CI ledger uses — no new crypto. Everything runs against
in-browser DuckDB-WASM; nothing is uploaded. Tests: `npm run test:datablame`
(`test/data-blame.test.mjs`) and `npm run test:deidverify`
(`test/deidentification-verifier.test.mjs`), both in the `provenance-packet` CI
job (`.github/workflows/job-provenance-packet.yml`).

### Local Analysis Contract — SQL-vs-schema checker, and a consolidation call

`js/validation/analysis-contract.js` checks a SQL query against the REAL schema
of the dataset(s) already loaded in DuckDB, entirely offline, and flags three
failure classes: **schema hallucination** (a referenced column/table doesn't
exist — Levenshtein near-miss suggestion when one is close), **aggregation
mismatches** (`COUNT` across a JOIN without `DISTINCT` when duplication is
plausible; `SUM()` of a column that already looks like a rate/ratio/average),
and **missing guard clauses** (an aggregate query never references a column
that looks like it excludes test/demo/deleted/refunded/cancelled rows). Pure,
DB-free, browser-free, network-free — `npm run test:analysiscontract`
(`test/analysis-contract.test.mjs`, 29 tests). Wired into the SQL tab behind
the `localAnalysisContract` flag (off by default): `runSqlQuery()` in
`js/app-shell/main.js` runs the check AFTER the result table is already
rendered — it never gates, delays, or blocks query execution — using a live
schema built from every loaded dataset plus lazily-fetched
`approx_count_distinct` stats for columns actually named in that query's
JOIN/GROUP BY clauses, and renders a dismissible card listing every flag.
EMPOWERMENT CONSTRAINT compliant: flags only, never rewrites, blocks, or
auto-fixes a query. Graceful-degradation guarantee: every check and the schema
builder are wrapped so an unreadable/malformed schema, an uncountable column,
or a tokenizer surprise degrades that one check silently rather than throwing
— the SQL tab keeps working even if the contract check can't run.

**Consolidation call (read before adding a fourth join-fanout checker):** this
module's join-fan-out logic was written, tested, and then deliberately
REMOVED once it became clear it duplicated the ambient `checkSanityAnchor`
(`js/ambient/ambient-validation.worker.js`), which already flagged "join +
aggregate without DISTINCT" during live typing. Rather than ship two
competing join-fanout checkers with two different notions of "risky," this
PR upgraded `checkSanityAnchor` itself to optionally accept a schema with
row-count/distinct-count stats (`options.schema`) and, when present, name the
actual low-uniqueness join column and its real uniqueness percentage instead
of a generic flag — while staying silent when the query's own `GROUP BY`
already matches the many-side table's grain (a legitimate 1:many join, not a
fan-out bug) — falling all the way back to the original blunt check when no
schema/stats are supplied, so ambient checks before a dataset loads (or during
keystroke-level live typing, which does not yet pass a schema — a documented,
deliberate scope cut, not an oversight) are unaffected. `npm run test:ambient`
(`test/ambient-validation.test.mjs`, 26 tests: all pre-existing cases pass
unmodified plus 4 new stats-aware cases). Join-fan-out risk therefore has
exactly ONE owner (`checkSanityAnchor`); `js/validation/analysis-contract.js`'s own header
comment says so explicitly — if you're tempted to re-add fan-out detection to
`js/validation/analysis-contract.js`, feed it a schema through `checkSanityAnchor` instead.

### Meeting scribe agent (Gen 43, Part 1) — pure grounding logic only, no capture yet

`js/agents/meeting-scribe-agent.js` is the first, deliberately narrow piece of a
larger "analyst team goes to the meeting" idea. It does NOT capture audio and does
NOT run speech-to-text — both are separate, browser-API-heavy follow-ups
(`getDisplayMedia` + an on-device WebGPU transcription model) left out on purpose so
this piece could ship small and fully unit-tested without a browser or a GPU. Given
transcript segments (`{text, ts}`) and a context timeline the app already knows
(`{ts, chart, queryLabel}`, emitted whenever the analyst switches views),
`tagSegmentsWithContext` tags each segment with whichever context event was active at
its timestamp (segments before the first event are tagged `null`, never guessed).
`detectPushback`/`detectDataRequest` flag stakeholder phrasing — pushback ("why did
this drop", "are you sure") is flagged so a caller can trigger the EXISTING
uncertainty-resolver's re-run rather than a prose reply, honouring the same rule Gen 42
established: a critique-style check must re-run its own query, never argue in text.
`buildActionItem`/`isActionItemResolved`/`resolveActionItem` enforce the
minimum-viable-action-item rule — an item resolves ONLY once it carries an owner, a due
date, AND an outcome; a bare "will follow up" note stays open. `buildMeetingNote`
assembles a plain, JSON-safe ledger entry; signing/appending it to a portable export
file is the export layer's job, not this module's. EMPOWERMENT CONSTRAINT (same as
Gen 42): nothing here writes to a pack, rule, or chart — it only produces a note object
for the analyst to review. Ships behind the `meetingScribe` flag, but the flag is
currently decorative: there is no UI, capture path, or call site anywhere in the app
yet, so this PR changes zero runtime behaviour. Test: `npm run test:meetingscribe`
(`test/meeting-scribe.test.mjs`), pure JS — no DuckDB, DOM, or network.

### Propose a correction from the audit trail — draft, never auto-apply

A recurring, surface-agnostic pattern for turning DATAGLOW's own recorded audit
data into a corrective proposal WITHOUT ever crossing the no-auto-apply line.
`js/provenance/incident-postmortem.js` is the reference: `draftPostmortem({incident,
provenanceTrail, assumptionLedger?, fingerprint?, badges?, debateResolution?,
metricInvolved?})` reconstructs a timeline **1:1 from the supplied provenance
trail** (`js/provenance/provenance.js` `getTrail()`) — it invents no step and adds
no logging system; the sole non-provenance marker is the incident-discovery
moment, taken straight from `incident.discoveredAt` and tagged `source:'incident'`
— then writes a deterministic, template-based root-cause narrative (no LLM call,
in the spirit of `js/agents/question-generator-agent.js`) and a PROPOSED
correction carrying a `{score,label}` safety score in the exact vocabulary and
thresholds of `js/cleaning/fix-confidence.js`.

The load-bearing rule: **the module applies nothing.** It has no imports, mutates
none of its inputs, names no apply/mutation/network primitive, and labels every
draft `isProposal:true`/`applied:false`. Applying a proposal is a SEPARATE,
explicit, human-confirmed action wired in `js/app-shell/main.js` — the "Report
incident" action on a Validate-tab finding renders the draft with Accept/Dismiss,
and Accept routes an annotate-only correction through the SAME confirm-gated
domain-pack path a hand-authored rule uses (`communityPack.importPack` →
`domainPhysics.registerRuntimePack`, behind an explicit `confirm()`), while
Dismiss discards with zero side effects. This is the confirm-gated discipline
(pure module PROPOSES; only a main.js click handler APPLIES) generalised from
cleaning fixes to audit-trail-driven rule/metric corrections: any future feature
that "suggests a fix from what we recorded" should draft a labelled proposal and
hand the apply to an existing confirm-gated path, never invent a new one. The
optional cross-batch inputs (fingerprint/badges/debate/metric) are referenced
when supplied but never required — a postmortem works from `incident` alone.

### Analysis fingerprint + nutrition label — make a result checkable at a glance AND cryptographically

Two coupled, pure modules give a computed result two independent trust checks a
non-expert can act on. `js/provenance/analysis-fingerprint.js` is the crypto
half: `computeAnalysisFingerprint({resultData, sqlOrPipelineDescription,
parameters, metricsRegistryVersion, datasetProvenanceHash}, {label})` returns a
self-describing record whose `digest` is a SHA-256 over a canonical JSON payload
of the result plus the inputs that produced it, and `verifyAnalysisFingerprint(record,
recomputedInputs)` is a pure recompute-and-compare that needs only the record +
an independent recomputation (no app state). It REUSES `sha256Hex` from
`js/provenance/provenance.js` via `crypto.subtle` — do NOT add a second hash, an
external crypto library, or any zero-knowledge machinery. HONEST LABELLING is a
hard rule here, matching the attestation module's discipline: this is a
"tamper-evident content fingerprint" that proves integrity, NOT authorship or
existence-at-a-time — there is no signing key or timestamp authority, so never
describe it as signed, notarized, or certified, and never fake a signature claim.
`js/provenance/nutrition-badges.js` is the visual half: a frozen `BADGE_CATALOG`
(text/unicode glyphs only — no image assets, no icon library) plus pure
`computeBadges(context)`. The binding rule is **no decorative badges** — every
catalog entry carries a `check(context)` that returns backing detail only when a
REAL signal is present (calibrated grades, missingness findings, row count below
`SMALL_SAMPLE_THRESHOLD`, outlier-layer status, a fingerprint record, a Step-C
`resolvedBy==='C'` debate resolution), so a badge can never be emitted without its
evidence; a candidate badge that can't be honestly computed (e.g. "Truncated
Axis", which has no signal in `js/runtimes-viz/visualize.js`) is recorded in
`docs/tech-debt-tracker.md`, not faked. Both are wired end-to-end on ONE surface
so far — `renderDataHealth` in `js/app-shell/main.js` (the Validate-tab Data
Health dashboard) — deliberately lazy-imported and idempotent; other surfaces are
tracked as tech debt. Registered as the `provenance-analysis-fingerprint`
capability (`platforms: ["browser","desktop"]`). Tests: `npm run test:fingerprint`
(`test/analysis-fingerprint.test.mjs`) and `npm run test:badges`
(`test/nutrition-badges.test.mjs`), the `analysis-fingerprint` CI job — both pure
Node, no browser/DuckDB/network.

### Shared metrics registry — one "define once" source of truth per session

`js/app-shell/metrics-registry.js` is the in-session shared registry of named
metric definitions (e.g. `revenue` → `SUM(amount)`), so the SQL / Python / R /
Visualize / Story surfaces never silently compute the same business term two
different ways within one session. It is deliberately scoped to ONE browser
session / dataset — NOT a multi-user/org semantic layer. A metric only NAMES a
read-only SQL expression evaluated over the active dataset's DuckDB table: the
module never runs SQL and never mutates data, so **DuckDB stays the sole compute
engine — do not build a second one here**. `createMetricsRegistry()` is pure and
dependency-free (mirrors `js/learning/signal-store.js`): `defineMetric` /
`getMetric` / `hasMetric` / `listMetrics` / `removeMetric` /
`resolveMetricSql(name, {alias})` / async `fingerprint(name)` (which reuses
`sha256Hex` from `js/provenance/provenance.js` via a LAZY dynamic import — don't
add a second hash), plus the standalone `expandMetricReferences(sql, registry)`
that rewrites `@name` tokens into compiled fragments. Registries are keyed per
dataset table name in `js/app-shell/state.js` (`getMetricsRegistry` /
`getActiveMetricsRegistry`), exactly like the per-table provenance chains, so
switching datasets yields a fresh isolated registry. Two rules bind anyone
extending this: (1) **defining is safe, adopting is a click** — defining a
metric only names a read-only expression, but any UI that propagates a metric
into a query/surface must stay an EXPLICIT user action, never silent
propagation (the SQL tab's "Saved Metrics" Insert button and `@metric`
expansion in `runSqlQuery` are the reference wiring). (2) Validation is
engine-free and fails loud at define-time (bad name, empty/non-string
expression, `;`, full statement, unbalanced parens, unterminated string) — it is
NOT a second SQL parser, so don't grow it into one. Only the SQL tab is wired so
far; the other four surfaces are tracked in `docs/tech-debt-tracker.md`. Test:
`npm run test:metricsregistry` (`test/metrics-registry.test.mjs`, the
`metrics-registry` CI job) — engine-free.

### Provenance Packet (Batch 2) — denial root-cause profiler + cost-of-bad-data quantifier

Two client-side capabilities under `js/provenance/`, one module per feature,
following the same layout + signed-attestation pattern as the Batch 1 packet.
`js/provenance/denial-root-cause.js` is a SCHEMA-TOLERANT healthcare-claims
denial-risk profiler: `detectClaimColumns` maps whatever columns are loaded to
claim roles by NAME (never a fixed schema), then `buildDenialReport` grades five
canonical buckets — eligibility/registration, coding, duplicate/near-duplicate,
provider/NPI, coordination-of-benefits — and reports count/% flagged per bucket
with example rows. The binding rule: grade only what is present; any bucket whose
required column is absent is returned `applicable: false` with a plain reason and
listed under `notCheckable`, so a missing column can NEVER read as a clean pass.
It is heuristic triage, not payer adjudication — clinical CPT↔diagnosis
appropriateness is deliberately NOT checked (no bundled crosswalk) and is
reported as unchecked; modifier completeness is informational, not a flag.
`runDenialProfile(table, cols, engine)` runs one bounded `SELECT *` against the
in-browser DuckDB-WASM data (no upload, no ML) and buckets in pure JS;
`buildDenialAttestation`/`verifyDenialAttestation` sign and re-verify the report
with the SAME `sha256Hex` primitive from `js/provenance/provenance.js` — no new
crypto. `js/provenance/cost-of-bad-data.js` (`estimateCostOfBadData`) is a
transparent flagged-rows × per-error-cost multiplication with default
`DEFAULT_PER_ERROR_COST` = $118 — a placeholder from published claims-rework
research, clearly labelled as a USER-ADJUSTABLE ASSUMPTION, not a DATAGLOW
guarantee; all wording is "estimated risk", never a bare "cost", and there is no
network or model call. Both are surfaced in the Provenance/Trust tab in
`js/app-shell/main.js`. Tests: `npm run test:denialprofile`
(`test/denial-root-cause.test.mjs`) and `npm run test:costofbaddata`
(`test/cost-of-bad-data.test.mjs`), in the `provenance-packet-batch-2` CI job.

### Conversational pack builder — Validate-tab UI wiring (Gen 42 follow-up)

The DOM wiring the Gen 42 agent PR deferred now lives in `js/agents/conversational-pack-ui.js`,
a THIN presenter: it owns only presentation + flow state and delegates every
rule/interpretation/resolution decision to the four agent modules above. It
exports a pure gate `shouldOfferPackBuilder({enabled, questions})` (the single
predicate the caller checks) and `mountConversationalPackBuilder(...)`, which
renders a one-question-at-a-time card into `#pack-builder-wrap` in the Validate
tab HEADER AREA — never a modal — using existing CSS classes. `js/app-shell/main.js`'s
`renderConversationalPackBuilder(ds, results)` (called at the end of `runValidation`)
mounts it ONLY when `isEnabled('conversationalPackBuilder')`; with the flag off
(shipped default) it empties the host and hides it, so the feature ships DARK.
Contract for anyone touching this: the two response buttons stay EQUAL-weight
(both `btn btn-primary`) so the UI never nudges toward "accept"; the free-text
field is the lower-emphasis fallback; the mic renders only when
`conversationalPackBuilderVoice` is on. This module names NO network primitive —
finalize runs inside the pack builder's `runWithNetworkDenied`, and save/export
reuse the existing community-pack register + browser-download paths. Test:
`npm run test:e2e-packbuilder-ui` (`test/pack-builder-ui.test.mjs`, in the
`e2e-smoke` CI job) — engine-independent, asserts the gate, the flag-off
mount-nothing regression guard, and the full flag-on flow.

### Guided conversational pack builder (Gen 42) — confirm before writing

Authoring a domain pack used to mean a blank text box. Gen 42 replaces it with a
guided, data-grounded conversation implemented as four pure, browser-free,
LLM-injected agent modules: `js/agents/question-generator-agent.js` turns real
pipeline findings into plain-English questions that ALWAYS quote a real observed
value (a generic question is refused, not degraded); `js/agents/uncertainty-resolver-agent.js`
resolves "I don't know" on-device in a fixed A→E order (statistical check → peer
borrow → sequential three-agent debate under a 2-second budget → one unified
suggestion → park-and-revisit); `js/packs/local-pack-index.js` is the read-only,
content-addressed peer index the resolver's Step B consults (fetched via an
INJECTED fetcher so it names no network primitive); and `js/agents/pack-builder-agent.js`
assembles the confirmed answers into a portable pack validated through the
EXISTING `js/teaching/community-pack.js` schema and the pack no-network guard.

Two rules bind anyone touching this area. First, the EMPOWERMENT CONSTRAINT: a
rule enters a pack ONLY after the user explicitly confirms it — every module
produces a suggestion, never a written rule, and `js/agents/pack-builder-agent.js`
is handed answers the user already accepted. Never add a path that infers-and-writes.
Second, reuse don't reinvent: the portable pack vocabulary is annotate-only
(`no-merge` / `benford-exempt` / `outlier-context`); a learned numeric bound maps
to `outlier-context` (its reason records the bound) rather than a new hard-fail
rule kind — emitting a real bound-check kind means extending
`js/validation/domain-physics.js` and the portable schema, which is out of scope
here. The flow ships behind the
`conversationalPackBuilder` flag (agents land dark; Validate-tab DOM wiring is a
follow-up); voice is behind `conversationalPackBuilderVoice` (typed path works
today, mic pending a vendored permissively-licensed on-device STT model). Tests:
`npm run test:questiongen`, `npm run test:uncertainty`, `npm run test:packindex`,
`npm run test:packbuilder` (the `conversational-pack-builder` CI job).

### Cross-origin isolation (COOP/COEP) + loud engine failures

The whole app is dead without DuckDB-WASM, and DuckDB-WASM's threaded/eh build
wants `SharedArrayBuffer`, which the browser only exposes when the page is
**cross-origin isolated**. Isolation needs BOTH `Cross-Origin-Opener-Policy:
same-origin` and a `Cross-Origin-Embedder-Policy` header on the top-level
document, sent as REAL HTTP headers — `<meta http-equiv>` does NOT work for
COOP/COEP. Because DATAGLOW is a static site with no server, isolation is
delivered two ways and both must stay in sync: (1) host-level `_headers`
(Netlify/Cloudflare Pages format) and (2) a host-agnostic fallback in `sw.js`
that injects the same headers on every same-origin response via the
`withCrossOriginIsolation` wrapper, with a loop-guarded one-time reload in
`index.html` (a `controllerchange` handler + `dataglow-coi-reloaded` sessionStorage
sentinel) so a first visit becomes isolated once the worker takes control. COEP
is **`credentialless`, not `require-corp`**: under `require-corp` every opt-in
cross-origin CDN runtime (Pyodide/WebR/WebLLM) and Google Fonts would need its
own CORP/CORS header or be blocked; `credentialless` keeps isolation on while
letting those no-credentials cross-origin fetches through. If you change the COEP
value, change it in BOTH `_headers` and `sw.js` (the `COEP` constant) — the
`coi-headers` CI job (`npm run test:coi`, `test/coi-headers.test.mjs`) fails if
they drift or a header goes missing. Second, load failures must be LOUD: the
engine warm-up and every dataset-load entry point in `js/app-shell/main.js` route
through `runDatasetLoad`/`showEngineError`, which render a visible, retryable
banner with the real reason instead of silently reverting to "No dataset loaded"
(the original production symptom). Never reintroduce a bare
`await engine.initDuckDB()` in a click handler without surfacing its failure.
Third, mind the pre-isolation **load race**: on hosts that fall back to the `sw.js`
path, there is a brief window where the app shell is interactive but the one-time
reload has not fired — a load started then would be torn down mid-flight and
vanish silently. `index.html` publishes `window.__dataglowIsolation`
(`isolated`/`pending`/`failed`/`unsupported`); the sample-dataset buttons go
through `requestDatasetLoad(id)`, which — while `pending` — persists the request
(`dataglow-pending-load`) and shows a non-error "starting" state instead of
starting a doomed load, then `replayPendingDatasetLoad()` replays it after the
reload lands on the isolated page (file uploads, which can't cross a reload, just
show the "starting" state). This timing race is invisible to the static
`test:coi` suite; the real-browser `test/coi-race.e2e.test.mjs`
(`npm run test:e2e-coi-race`, in the e2e-smoke CI job) delays the `sw.js` fetch to
recreate the window and asserts a fast click is queued + replayed, never dropped.

### Domain-pack plugin architecture (Gen 40)

Domain packs are self-contained plugins under `js/packs/`, not code pasted into
`js/validation/domain-physics.js`. To add or change a pack, add/edit ONE file
under `js/packs/builtin/<id>.pack.js` (it exports `{ manifest, pack }`) and
register it in `js/packs/pack-registry.js` — never edit another pack's file or the
core engine. A manifest declares `id` (must equal `pack.name`), semver `version`,
`industry`, and a `capabilities` map whose keys MUST be a subset of the extension
points in `js/packs/extension-points.js`; packs must NOT declare inter-pack
dependencies. Two hard rules the loader/tests enforce: (1) **no network** — pack
code may never reference `fetch`/`XMLHttpRequest`/`WebSocket`/etc.; the guard in
`js/packs/pack-network-guard.js` statically scans every shipped pack file and a
runtime trap backs it up, so a pack that names a network primitive fails
`npm run test:packs`. (2) **behaviour-preserving** — the plugin path installs the
SAME runtime pack objects via `setPackSource`, so legacy-vs-plugin output must stay
identical (the test proves it per extension point). The migration is gated by the
`pluginPacks` flag in `flags.manifest.json`; the loaded-pack provenance is surfaced
in the Validate tab and in `TRUST.md`. Registered as the `domain-pack-plugins`
capability in `capability-map.manifest.json`; CI job `pack-architecture`.

### Teach-As-You-Clean micro-lessons + Community Pack sharing (Gen 34 C/D)

`js/teaching/micro-lessons.js` is a pure catalog: a finding-type id → `{beginner, practitioner, expert}`
one-liner map, plus `getMicroLesson(id, level)` and `coverageFor(requiredTypes)`. If you add
a new validation layer (a `LAYER_DEFS` entry) or a new domain-pack rule, you MUST add a
matching micro-lesson entry — `npm run test:microlessons` fails otherwise (it checks coverage
against the live `LAYER_DEFS` and `DOMAIN_PACKS` ids, not a hard-coded list). All copy must be
original one-sentence wording. The verbosity slider swaps register only; never make it change
which findings appear or any validation result.

`js/teaching/community-pack.js` exports/imports domain packs as portable JSON with NO backend. The
strict schema in `validateImportedPack` IS the safety sandbox — do not add a second sandboxing
mechanism. Imported packs compile ONLY through `compilePackRule`/`compileColumnMatch` in
`js/validation/domain-physics.js`, so a rule's target layer is derived from its `kind` (`PACK_RULE_LAYERS`)
and can never be supplied by the input. Only descriptor-based packs (retail, finance, imported)
are portable; the hand-written healthcare pack is not. Keep retail/finance expressed as the
`RETAIL_PACK_DESCRIPTOR`/`FINANCE_PACK_DESCRIPTOR` declarative descriptors so export round-trips
without drift; changing a built-in pack's rules means editing its descriptor, not a rule literal.

### The Standards Bridge — recognise healthcare-data standards, reuse the existing engines

`js/validation/health-standards.js` is a schema-recognition + concept-mapping seam, not a new
validation engine. It recognises the shape of two common healthcare-data standards —
the OMOP Common Data Model (five in-scope tables: PERSON, CONDITION_OCCURRENCE,
DRUG_EXPOSURE, MEASUREMENT, OBSERVATION_PERIOD) and HL7 FHIR bundles (Patient,
Condition, Observation, Encounter) — and maps their long-format concepts onto the
tabular, one-column-per-measurement shape the existing layers expect. Every plausibility
bound it uses is imported from the Physiological Plausibility layer's `VITALS` table and
every missingness cutoff from the Missingness Detective's `MIN_MISSING_RATE`; it defines
no bounds of its own and adds no ML. The two Domain Packs it feeds (`omop`, `fhir`) are
plain entries in `js/validation/domain-physics.js` built the same way as the Retail/Finance packs and
carry a shared non-clinical medical disclaimer (`MEDICAL_DISCLAIMER`) surfaced wherever
their findings show. When you extend it, keep the guardrail: recognise and route, never
re-implement a bound or a check the layers already own, and never let a finding read as a
clinical determination. Scope is deliberately narrow — the five OMOP tables and four FHIR
resources above only; full-CDM / full-FHIR support and any pack marketplace are out of
scope by design. Field/table names are the standards' public identifiers; all logic,
wording, and the synthetic sample fixtures are original to DATAGLOW.

### CI Provenance Ledger — self-contained, offline-verifiable build provenance

Every CI run that lands on `main` appends one hash-linked entry to the append-only
`docs/ci-provenance-ledger.jsonl` (JSON Lines — one entry per line, never rewritten).
Each entry records `commit`, `timestamp` (ISO 8601 UTC), `test_conclusion`, `sbom_hash`
(SHA-256 of that run's SBOM, from the existing `npm run sbom` — reused, not duplicated),
`prev_hash` (previous entry's `entry_hash`, or 64 zero chars for the genesis entry), and
`entry_hash` (SHA-256 of the entry's own contents). This is the lightweight alternative
to SLSA hosted attestation that was deliberately chosen for a solo-maintained repo:
provenance you can re-check offline, no attestation/signing service, zero dependencies.
The appender `.github/scripts/append-ci-ledger.mjs` and the verifier
`.github/scripts/verify-ci-provenance.mjs` share one canonical hashing helper
`.github/scripts/ci-ledger-hash.mjs`, so the writer and checker can never disagree.
Anyone can run `npm run verify:ci-provenance` to recompute and re-link the whole chain
with zero network and zero GitHub API calls; it prints "N entries verified, chain intact"
or names the exact entry that broke. The recording side is a standalone workflow
`.github/workflows/ci-provenance-ledger.yml` (NOT a reusable job in
`.github/workflows/test.yml`): it fires
on completion of the `tests` workflow filtered to `main`, so it records only what actually
lands on `main` and never PR branches, and commits the appended line back through the same
carrier-branch self-PR + `[skip ci]` loop-guard pattern as
`.github/workflows/living-manifest.yml`. It is
recording only — human-on-the-loop, it never auto-fixes CI or edits app code. When you
change the ledger's field set or serialization, change it in the shared hashing helper so
both scripts stay in lockstep; the chain is append-only, so never rewrite existing lines.

### Build Nervous System — build-safety spine (isolate / author / gate / land dark)

A single four-stage build-safety pipeline, documented in full at
`docs/build-nervous-system.md`. The stages: (1) **Isolate** — every coding-agent
session runs in its own git worktree; `scripts/new-agent-worktree.sh <branch>`
creates one (`git worktree add ../dataglow-worktrees/<branch> -b <branch>`).
(2) **Author** — every PR carries a three-layer record, `intent` (what was asked,
one line) / `gen` (what the agent generated, one factual line) / `integrate`
(what a human/agent adjusted before merge, one line, or "none"); the PR template
`.github/PULL_REQUEST_TEMPLATE.md` has these as required sections, so use them on
every PR. (3) **Gate** — `.github/workflows/merge-tree-preflight.yml` runs on each
PR and fails if merging the branch into current `main` would textually conflict
(a pure `git merge-tree` simulation — it never merges or pushes), and the existing
golden regression suite (`npm run test:golden`) is the moved-output net; it runs
every case in `test/golden/cases.mjs`, so adding coverage means adding a case +
fixture, not editing the workflow. (4) **Land dark** — a client-side feature-flag
manifest `flags.manifest.json` (flag -> `{enabled, addedInPR, description}`) read
by `js/build/build-flags.js` (`isEnabled(name)`; in-memory only, no localStorage /
cookies / network, so it behaves identically in browser, Tauri desktop, and future
Tauri mobile). Flag hygiene follows a **promote-or-delete rule**: a flag left in
the manifest for more than 3 merged PRs without being promoted (removed, code kept)
or reverted (removed, code deleted) is flagged in the 4th PR that touches the
manifest. The merge-tree check is intentionally a **non-required** check for now
(promoting it in branch protection is a later human decision).

### Export / reporting — Universal Export Contract + delivery adapters

The Visualize tab can export the loaded, validated dataset as an Excel workbook
or a PDF report, 100% client-side. `js/export/export-report.js` is a Universal Export
Contract: it builds raw bytes per format (a `{data, filename, mimeType}` blob
descriptor) independent of how they reach disk. The `.xlsx` builder reuses the
already-vendored SheetJS (global `XLSX` from `assets/xlsx/`, no new dependency);
the PDF builder is a small first-party, dependency-free PDF 1.4 writer (no PDF
library) so nothing heavy is pulled in. Delivery lives in `js/export/export-delivery.js`
as platform adapters selected by `selectAdapter(platform)`: browser (Blob +
object URL + synthetic `<a download>`, the repo's existing pattern), desktop
(feature-detects Tauri `dialog.save` + `fs.writeBinaryFile` for a native Save-As,
falls back to the browser download when those APIs are absent — the shell's
current deny-by-default posture), and a mobile share-sheet stub that throws
(future work). The module is registry-native: capability `export-reporting` in
`capability-map.manifest.json` with `platforms: ["browser", "desktop"]`, reached
from `js/app-shell/main.js` via `registry.get('export-report')`. No network primitive
appears in either file — a source guard in `npm run test:export` (the
`export-reporting` CI job) enforces the zero-upload promise.

### Capability registry — platform-aware module loading

`js/app-shell/main.js` no longer statically imports every feature module. Each capability
in `capability-map.manifest.json` declares a `platforms` list from a closed set
(`browser`, `desktop`, and reserved `mobile`); most are `["browser", "desktop"]`
because they behave identically in a plain browser and inside the Tauri desktop
shell, while runtime-specific ones are narrowed — the Watch Folder is browser-only
via a per-file `platformsByFile` override (a capability's `platforms` stays the
honest union; the override marks the one file). The loader `js/app-shell/capability-registry.js`
reads that manifest at runtime (same-origin `fetch`, precached by `sw.js` and
staged into the desktop bundle by `scripts/stage-desktop-frontend.mjs` — no new
network or upload path), detects browser vs. Tauri desktop, and dynamically
imports only the modules meant for the detected runtime, exposing
`registry.get(name)`/`has`/`available`/`list`. Requesting a wrong-platform or
unknown capability returns `undefined` with a `console.warn` rather than crashing.
When you add or reclassify a capability, set its `platforms` (and, if a single
backing file differs, `platformsByFile`): the drift gate `npm run test:capdrift`
fails the build on a missing/invalid list, and `npm run test:capregistry`
unit-tests the loader (both run in the `capability-map-drift` CI job,
`.github/workflows/job-capability-map-drift.yml`). Migrating a module onto the
registry means dropping its static import in `js/app-shell/main.js` and fetching it via the
registry during bootstrap; unmigrated modules keep their static imports and still
work — migration is incremental, not all-or-nothing.

### Living Manifest — public-presence automation

The capability-map drift gate keeps the *internal* docs honest against the code;
the **Living Manifest** workflow (`.github/workflows/living-manifest.yml`, on push
to `main` + `workflow_dispatch`) extends that same discipline *outward* to the
repo's public face, regenerating three artifacts from the same
`capability-map.manifest.json` (and git history) so they can't silently drift:
(1) the capability dashboard table injected into `README.md` between the
`CAPABILITY_TABLE_START`/`END` markers (`.github/scripts/render-capability-dashboard.mjs`,
`npm run docs:dashboard`); (2) `docs/PROVENANCE_TIMELINE.md`, a git-history
timeline (`.github/scripts/render-provenance-timeline.mjs`, `npm run docs:provenance`)
— a markdown table, not the browser-only `js/runtimes-viz/visualize.js`, which needs the
DOM/Plotly; (3) a wiki-gap detector (`.github/scripts/wiki-gap-detector.mjs`,
`npm run docs:wiki-gap`) that opens a "Wiki page needed: <area>" issue for any
capability area missing from `docs/wiki-coverage.json`. Pure logic is unit-tested
(`npm run test:living-manifest`, `living-manifest` CI job). It is docs/metadata
automation only — it must never touch `js/`, `index.html`, `css/`, `sw.js`, or
`manifest.webmanifest`. Two rules keep it safe: the auto-commit message carries
`[skip ci]` (GitHub Actions skips the resulting push, so the bot's commit never
re-triggers the workflow), and every generator is a no-op when its output is
unchanged. When you add a capability area, its README row and a wiki-gap issue
appear automatically; when you write an area's wiki page, add that area to
`docs/wiki-coverage.json` so the detector stops filing it.

### Optional Tauri v1 desktop shell

An optional native desktop wrapper lives under `src-tauri/`. It is the stock
Tauri "vanilla" template (`src-tauri/src/main.rs` registers no commands) that
loads the existing static site unchanged. Tauri v1 refuses a `distDir` that
contains `node_modules` or `src-tauri`, so `distDir` cannot be the repo root;
instead a tiny copy step (`scripts/stage-desktop-frontend.mjs`, wired via
`beforeBuildCommand`/`beforeDevCommand`) stages the site's runtime assets into a
gitignored dist folder under `src-tauri/` that `distDir` points at. It is a plain
file copy — no bundler, transpiler, or minifier — so the bytes served in the
window are identical to the browser; if the site gains a new top-level runtime
asset, add it to that script's allowlist. The v1 allowlist is deny-by-default
(`tauri.allowlist.all = false`), so the window has only what a browser tab has;
the site's opt-in CDN/Databricks fetches are ordinary webview requests and are
untouched by it. Build via `npm run tauri:dev` / `npm run tauri:build` (Tauri CLI
invoked through `npx`, so nothing is added to `package-lock.json`); a debug build
is smoke-tested in CI by `.github/workflows/job-tauri-smoke.yml` on `ubuntu-22.04`
(Tauri v1 needs webkit2gtk-4.0, absent from 24.04). The produced installers are
**not** signed or notarized — see `docs/desktop-shell.md` for the signing/legal
notes (macOS notarization needs the ~US$99/yr Apple Developer Program; unsigned
Windows binaries trip SmartScreen). Do not describe the artifacts as signed.

### Vendored page-load libraries (Plotly + SheetJS + fonts)

Everything the app needs on a normal page load is now self-hosted under `assets/`,
so a cold load fetches nothing from a third party. Alongside the pre-existing
DuckDB-WASM bundle, Plotly.js (`assets/plotly/`, MIT) and SheetJS/xlsx
(`assets/xlsx/`, Apache-2.0) are vendored and referenced by local path in
`index.html`; their upstream licenses ship next to them. The web fonts are
vendored the same way: latin-subset WOFF2 files for Inter, Poppins and JetBrains
Mono (all SIL OFL 1.1) live under `assets/fonts/` and are declared via
`@font-face` in `css/base.css`, so the cold load no longer touches
fonts.googleapis.com / fonts.gstatic.com. `assets/fonts/FONTS-LICENSE` ships the
OFL text next to them.

The cold load therefore makes **zero** third-party fetches. Every remaining
off-machine network call is explicitly opt-in and only fires after the user takes
an action — never on page load:

- **Large optional runtimes (no credentials, on-demand).** Pyodide, WebR and
  WebLLM load from public CDNs when their tabs are first opened
  (`js/runtimes-viz/python-runtime.js` injects the Pyodide loader lazily;
  `js/runtimes-viz/r-runtime.js` and `js/narrative/ondevice-llm.js` dynamically
  `import()` theirs).
- **Bring-your-own-key Story narrative providers (user-keyed).** In
  `js/narrative/story.js` the Story tab defaults to the in-browser/rule-based
  providers (no key, no network); the cloud providers Perplexity, OpenAI,
  Anthropic and Google are all `requiresKey: true` and only `fetch()` their
  endpoints once the user pastes their own API key (`produceStory()` short-circuits
  to the local path when no `apiKey` is supplied). The key lives in memory and no
  DATAGLOW server sits in the middle — it is a direct browser → provider call.
- **Experimental Databricks connector (user-keyed).** In
  `js/app-shell/databricks-connect.js` (wired via `initDatabricksConnect()` in
  `js/app-shell/main.js`) a read-only SQL result is pulled directly browser →
  the user's OWN Databricks workspace host over `fetch()`, authenticated with a
  personal access token the user supplies. The token is used only for that query
  and never stored; nothing routes through a DATAGLOW server.

When you touch prose about what loads from where, keep this cold-load-vs-opt-in
split accurate — the AGENTS.md context-rot detector only checks that paths
resolve, not that claims are true, so the honesty here is on you.

### Append-only zones + per-job reusable CI workflows

Three files (`docs/CHANGELOG.md`, `AGENTS.md`, `.github/workflows/test.yml`) used
to collide on every parallel PR, because nearly every new foundation had to edit
surrounding prose in all three. Each now carries an explicit append-only marker
(`NEW-ENTRIES-BELOW`, `NEW-FOUNDATION-ENTRIES-BELOW`, `NEW-JOB-ENTRIES-BELOW`), so
a new entry is a one-line insert at a fixed point rather than an edit to shared
text — see *Append-only zones* under *Finish the paper trail in the same PR*. CI
was also split: `.github/workflows/test.yml` is now a thin orchestrator that
`uses:` one reusable workflow per job, each a top-level
`.github/workflows/job-<name>.yml` file (each with `on: workflow_call`), so a job
change touches its own file instead of the shared YAML — see *CI is a thin
orchestrator*.

### Supply-chain install hardening

Dependency installs are locked down against the most common supply-chain
attack — malicious install-time scripts. The root `.npmrc` sets
`ignore-scripts=true`, so no package's preinstall/install/postinstall runs on
an npm install / npm ci. The `supply-chain-hardening` CI job then enforces this:
`.github/scripts/check-lifecycle-scripts.mjs` scans `package-lock.json` (and the
installed tree) and fails the build if any dependency declares a lifecycle
script that is not on the allowlist defined at the top of that script. It also
emits a CycloneDX SBOM as a build artifact. To add a dependency that genuinely
needs an install script, add its bare package name to that `ALLOWLIST` array
(with a one-line reason) and add a matching `npm rebuild <pkg>` step to the CI
job so the build still runs; note both in your PR.

### AGENTS.md context-rot detector

Because you (and every agent before and after you) read and trust this file
without sanity-checking it, a stale reference here quietly misleads the whole
chain of sessions. The **AGENTS.md context-rot detector**
(`.github/scripts/agents-md-drift.mjs`, run via `npm run test:agentsdrift`, gated
in CI) guards against that: it extracts the backtick-quoted file paths and npm
script names mentioned in this file and fails the build if any of them no longer
exists on disk or in `package.json`. It is pure static analysis — no network, no
model calls. If it fails, the fix is one of two things: either the code moved and
this file is now wrong (correct the reference here), or this file is right and the
code regressed (restore or rename the code). Do whichever is actually true, in the
same PR — never silence the check by deleting a reference that should still
resolve.

## PRs

Open PRs as drafts with a clear summary and test plan. Don't merge your own PR.
