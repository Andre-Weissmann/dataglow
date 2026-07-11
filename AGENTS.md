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
