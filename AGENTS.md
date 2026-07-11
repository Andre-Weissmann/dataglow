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
(Visualize, Story, Swift), Automate (Digital Twin, Watch Folder, Meeting).
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
(`validate`/`diff`), Generate (`twin`/`swift`), Tell (`visualize`/`story`) —
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

### Vendored page-load libraries (Plotly + SheetJS)

Everything the app needs on a normal page load is now self-hosted under `assets/`,
so a cold load fetches nothing from a third party. Alongside the pre-existing
DuckDB-WASM bundle, Plotly.js (`assets/plotly/`, MIT) and SheetJS/xlsx
(`assets/xlsx/`, Apache-2.0) are vendored and referenced by local path in
`index.html`; their upstream licenses ship next to them. The only remaining
third-party fetches are the three large opt-in runtimes — Pyodide, WebR and
WebLLM — which load from public CDNs on demand when their tabs are first opened
(`js/runtimes-viz/python-runtime.js` injects the Pyodide loader lazily; `js/runtimes-viz/r-runtime.js` and
`js/narrative/ondevice-llm.js` dynamically `import()` theirs). When you touch prose about
what loads from where, keep this vendored-vs-on-demand split accurate — the
AGENTS.md context-rot detector only checks that paths resolve, not that claims
are true, so the honesty here is on you.

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
