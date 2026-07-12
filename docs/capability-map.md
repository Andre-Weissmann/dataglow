# DATAGLOW — Capability Map

A short, living index of what lives where in DATAGLOW's `js/` directory. Today
that directory is ~60 flat ES modules with no sub-folders, so "where does this
belong / where does that already live?" is a real question every coding session
hits. This file answers it without anyone having to load the whole codebase into
context.

**How to use it.** Read this index in full first — it is deliberately kept short
enough to do that cheaply. Each area lists what it owns and the exact file(s)
that back it. Once you've found the area your task touches, open only those
files. When an area needs more than a few lines to explain, the index links to a
companion detail file under [`capability-map/`](./capability-map/); load that
only when you're actually working in that area. That link-out-when-needed shape
is the whole point: the index stays skimmable, the depth stays out of the way
until you want it.

**Keep it honest.** When you add, remove, or repurpose a `js/` module, update the
relevant area below — and its entry in [`capability-map.manifest.json`](../capability-map.manifest.json) —
in the same PR (the same rule the [changelog](./CHANGELOG.md) and
[tech-debt tracker](./tech-debt-tracker.md) follow). A file that exists but isn't
mapped here — or a mapped file that no longer exists — is exactly the kind of
drift the CI **capability-map drift detector** (`npm run test:capdrift`,
`.github/scripts/capability-drift.mjs`) fails the build on, and that the weekly
[entropy-reduction scan](./entropy-reduction-scan.md) also surfaces.

> On provenance: keeping a short top-level index that points to deeper detail
> only when needed is a general, widely-used documentation practice. Everything
> here is DATAGLOW's own wording about DATAGLOW's own files.

---

## App shell & data engine
The core runtime every other module hangs off: tab wiring, shared state, DOM/format
helpers, the in-browser query engine, and file ingestion.
- **Controller & wiring** — `js/app-shell/main.js` (top-level app controller; wires tabs, events, and every feature module together).
- **State & helpers** — `js/app-shell/state.js` (central mutable app state), `js/app-shell/utils.js` (shared DOM, formatting, and hashing helpers).
- **Grouped tab navigation** — `js/app-shell/tab-groups.js` (flag: `groupedNavigation`, disabled by default): a pure reducer (`buildTabGroups`, `groupForTab`) that clusters the flat tab-id list into 5 named modes (Explore, Validate & Trust, Analyze, Visualize & Share, Automate) for `renderTabBar()` to render as grouped headers instead of one flat row. No DOM, no dependency on `main.js`; when the flag is off, `renderTabBar()` renders the original flat single-row bar unchanged.
- **Validate tab focus mode** — `js/app-shell/validate-focus.js` (flag: `validateFocusMode`, disabled by default): pure disclosure-state logic (`shouldExpandAdvanced`, `createValidateFocusStore`) deciding whether the Validate tab's "Advanced options" block (context/domain-pack/level/export controls, AI Synthesis, Peer Review Mode) starts open or closed per dataset — closed until the analyst runs validation once or opens it manually. When the flag is off, the block always renders forced open, identical to pre-flag behavior.
- **Query engine** — `js/app-shell/duckdb-engine.js` (DuckDB-WASM engine; all SQL runs here, in-browser, zero upload).
- **File loading** — `js/app-shell/loaders.js` (CSV/TSV, JSON/NDJSON, Parquet, Excel, SQLite ingestion into DuckDB; also `loadRowsAsDataset` for in-memory result sets).
- **SQL editor highlighting** — `js/app-shell/sql-highlight.js` (dependency-free, zero-network SQL tokenizer/highlighter powering the SQL tab's overlay, plus structured DuckDB error formatting; pure, Node-testable functions).
- **Multi-dialect SQL translation** — `js/app-shell/sql-dialect-adapter.js` (Polyglot Workbench, Batch A; flag: `multiDialectSql`, disabled by default): a pure, dependency-free `translateDialectSql(sql, dialect)` that transpiles SQL written in PostgreSQL, MySQL, BigQuery, Snowflake, or T-SQL into the DuckDB SQL the engine runs, using a small set of composable regex/string rules that first mask string literals + comments so they can never be corrupted (same string-handling discipline as `sql-highlight.js`). `SUPPORTED_DIALECTS` drives the SQL-tab dialect-picker chip row. No DOM, no DuckDB import — Node-testable (`test/sql-dialect-adapter.test.mjs`, which also round-trips each dialect's translated output through a real DuckDB engine). When the flag is on, `main.js`'s `runSqlQuery()` runs `translateDialectSql(userSql, selectedDialect)` before `runQuery`; the default 'duckdb' selection is a no-op passthrough. When off (default) no picker renders and the SQL tab is byte-for-byte unchanged. Batch B (an Object Space registry) is a separate follow-up.
- **Warehouse import** — `js/app-shell/databricks-connect.js` (proof-of-concept BYO-token, browser-direct read-only pull from a user's own Databricks SQL warehouse into DuckDB; see [`databricks-connect.md`](./databricks-connect.md)).
- **Capability registry** — `js/app-shell/capability-registry.js` (platform-aware module loader; reads each capability's `platforms` field from [`capability-map.manifest.json`](../capability-map.manifest.json), detects browser vs. Tauri desktop at runtime, and dynamically `import()`s only the modules meant for that runtime so `js/app-shell/main.js` no longer statically imports every feature).
- **Command Deck sidebar nav (Part 1)** — `js/app-shell/command-deck-nav.js` (pure content-model builder for an alternate left-sidebar nav that regroups the 13 real tabs into 5 Trust-Tier Lifecycle Stages — Frame/Work/Trust/Generate/Tell — instead of the flat top tab bar; `COMMAND_DECK_STAGES` is the static stage-to-tab mapping, `buildSidebarContent({tabMeta, activeTab})` resolves each mapped tab's real label/icon and marks the active one while honestly reporting any `unassignedTabs` rather than silently dropping them, `validateStageCoverage(realTabIds)` flags any missing or stale tab mappings, `stageForTab(tabId)` is a pure lookup). Wired into `js/app-shell/main.js` as `renderCommandDeckSidebar()`, called from `init()` and at the end of `switchTab()` so the alternate sidebar's active-tab highlight and collapsed/expanded stage state stay in sync with every tab switch, rendering into the new `#command-deck-sidebar` host in `index.html` (sits alongside the existing `<nav class="tabbar">`, not inside `#data-sidebar` which is unrelated dataset-loading UI). Ships dark behind the `dataglowSidebarNav` flag (default OFF) — with the flag off, `renderCommandDeckSidebar()` hides the host and renders nothing, and the existing top tab bar remains the app's one and only nav, byte-for-byte unchanged. Direction, scope (Part 1 only — command palette and adaptive next-step rail are separate future parts), and naming were decided against the UI/UX brainstorm report per the user's "build all, safely and smartly" instruction; the full rationale is recorded as code comments at the top of `command-deck-nav.js`. A dedicated test (`test/command-deck-nav.test.mjs`) regex-extracts the real `TAB_META` block straight out of `main.js` at test time, so the stage mapping can never silently drift out of sync with the app's actual tool list.

> **Platforms.** Every capability in [`capability-map.manifest.json`](../capability-map.manifest.json)
> declares a `platforms` list drawn from `browser`, `desktop`, and (reserved) `mobile`.
> Most capabilities work identically in a plain browser and inside the Tauri desktop
> shell and so are `["browser", "desktop"]`; the Watch Folder is browser-only (its File
> System Access polling has no counterpart in the desktop shell) via a per-file
> `platformsByFile` override. The capability-map drift gate (`npm run test:capdrift`)
> fails the build if any capability is missing a valid, non-empty `platforms` list.

## Validation layers
DATAGLOW's headline: the 20 validation layers plus the Red Team self-test, and the
domain/bounds checkers that reinterpret or extend them. This area is large — see
[`capability-map/validation-layers.md`](./capability-map/validation-layers.md) for the
per-layer breakdown and how the pieces compose.
- **Orchestrator** — `js/validation/validation.js` (runs all layers + Red Team self-test; the entry point most features call).
- **Standalone layer modules** — `js/validation/categorical-consistency.js`, `js/validation/cross-column-consistency.js`, `js/validation/physiological-plausibility.js`, `js/validation/upper-bound-sanity.js`, `js/validation/missingness-detective.js`, `js/validation/missingness.js`.
- **Reinterpretation & context** — `js/validation/domain-physics.js` (swappable domain packs — Healthcare, Retail/E-commerce, Finance/Accounting, plus the OMOP CDM and FHIR healthcare-standards packs — that annotate raw layer output), `js/validation/expected-range.js` (informational numeric trend bands).
- **Healthcare standards bridge** — `js/validation/health-standards.js` (Gen 33 — The Standards Bridge: recognises OMOP CDM tables and FHIR Bundles, maps their long-format concepts onto the tabular shape the existing layers expect, and routes them through the cross-column, physiological-plausibility, and missingness layers reusing those layers' bounds — no new validation math. Ships synthetic OMOP/FHIR sample fixtures and the shared non-clinical medical disclaimer).
- **Domain-pack plugin architecture** — `js/packs/extension-points.js` (the closed vocabulary of stable extension points a pack may fill), `js/packs/pack-network-guard.js` (the enforced no-network guard — static source scan `scanSourceForNetwork` plus a runtime trap), `js/packs/pack-registry.js` (`loadBuiltInPacks` — validates each manifest and assembles the pack map the engine installs behind the `pluginPacks` flag), and the self-contained built-in plugins `js/packs/builtin/none.pack.js`, `js/packs/builtin/healthcare.pack.js`, `js/packs/builtin/retail.pack.js`, `js/packs/builtin/finance.pack.js`, `js/packs/builtin/omop.pack.js`, `js/packs/builtin/fhir.pack.js`. Gen 40 — each pack is one file declaring which extension points it fills, so two packs never edit the same file; behaviour is identical to the legacy inline map (same runtime pack objects).
- **Local Analysis Contract** — `js/validation/analysis-contract.js` (pure, DB-free SQL-vs-schema checker: `runAnalysisContract`/`summarizeAnalysisContract` flag schema hallucination — a referenced column/table that doesn't exist, with a Levenshtein near-miss suggestion — plus aggregation mismatches, such as `COUNT` across a JOIN without `DISTINCT`, or `SUM()` of an already-averaged-looking column, and missing guard clauses on aggregate queries. Join-fan-out precision is deliberately NOT duplicated here — it is owned by the ambient `checkSanityAnchor` below, which this module's schema feeds when available. Ships wired into the SQL tab behind the `localAnalysisContract` flag, flags-only, never blocking or rewriting a query).
- **Semantic / Metrics Layer** — `js/validation/semantic-layer.js` (Trust Passport Batch 1: a local, in-memory dictionary of human-authored metric definitions — `registerMetric`/`getRegisteredMetrics` capture a `name`, canonical SQL `expression`, `description`, derived `requiredColumns`, and `owner`/`createdAt` provenance — plus `checkQueryAgainstMetrics`, a pattern-based comparator that adds a FOURTH Local Analysis Contract finding class, `metric_definition_mismatch`, when a query aliases/comments a result as a registered metric but its expression differs from the registered definition, naming the likely missing term. Not AI-powered — a plain registry + string comparator, no SQL AST, no model, no network. `js/validation/semantic-layer-ui.js` is the minimal "Define a metric" SQL-tab presenter (`shouldOfferMetricDefiner`/`mountMetricDefiner`) where a human types a definition. Gated behind the `semanticMetricsLayer` flag, OFF by default — the fourth check runs only when `runAnalysisContract` is passed a metric registry; when off, the Contract is unchanged at three finding classes).

## Anomaly & outlier detection
On-device, dependency-free detectors for values and rows that don't fit — from single
columns up to whole-row multivariate anomalies.
- **Detectors** — `js/anomaly/isolation-forest.js`, `js/anomaly/ondevice-ml.js` (diagonal-covariance / Mahalanobis-style scoring), `js/anomaly/predictive-anomaly.js` (kNN/Gower row outliers).
- **Baselining & process control** — `js/anomaly/entity-baseline.js` (per-entity UEBA baselines), `js/anomaly/spc-control.js` (Shewhart control charts + Cpk).
- **Triage** — `js/anomaly/active-learning.js` (uncertainty sampling; surfaces least-confident cells first).

## Analysis robustness
Adversarial re-analysis that stress-tests whether a query result's headline finding
actually holds up — this scrutinizes the *conclusion drawn from* the data, not the data
itself (which is the validation layers' job).
- **Devil's Advocate** — `js/analysis-robustness/devils-advocate.js` (bootstrap resampling, trimmed re-estimate, and subgroup leave-one-out robustness checks run over the current SQL result).

## Drift, trend & fingerprinting
Detects when a new upload has moved away from what history would predict. The base
distributional-fingerprint drift is layer 18 inside `js/validation/validation.js`; these extend it.
- **Forecasting** — `js/drift/drift-forecast.js` (Holt's exponential smoothing; escalates layer 18 when an upload is outside the predicted band).
- **Trend narration** — `js/validation/expected-range.js` (also listed under Validation layers; informational, raises no alert).

## Cleaning & fixes
Everything that proposes a change to the data. All of it is preview-only: DATAGLOW
generates the SQL/plan and shows confidence, the human approves.
- **Core cleaning** — `js/cleaning/clean.js` (issue scan + preview-only fixes), `js/cleaning/fix-confidence.js` (safety score per proposed fix), `js/cleaning/materiality.js` (hide sub-threshold issues).
- **Targeted transforms** — `js/cleaning/imputation.js` (grouped-mean fills), `js/cleaning/format-fingerprint.js` (currency/date/fake-null standardizer), `js/cleaning/fuzzy-dedup.js` (near-duplicate radar + shared string-similarity metrics).

## Grades & health scores
Composite roll-ups that turn raw layer output into a few honest, high-level numbers.
- **Grades** — `js/grades/calibrated-grades.js` (two-axis Integrity vs Domain-Confidence grades), `js/grades/cat-scorecard.js` (Completeness/Accuracy/Timeliness), `js/grades/golden-signals.js` (four top-line health numbers).

## On-device learning & personalization
Transparent, browser-only learners that personalize ordering and suggestions from the
user's own accept/dismiss history — plus the stores they read and write.
- **Learners** — `js/learning/self-learning-rules.js` (logistic-regression flag ranking), `js/learning/adaptive-priority.js` (Beta-Binomial layer reordering), `js/learning/rule-suggestions.js` (correction-history rule induction).
- **Shared state** — `js/learning/signal-store.js` (unified in-memory signal layer coordinating the learners), `js/learning/memory-store.js` (IndexedDB persistence, versioned + LRU-evicted).
- **Session proficiency signal (Glow Path, Batch B)** — `js/learning/proficiency-signal.js` (a pure, in-memory, session-scoped tally of per-tab actions — SQL/Python/R/Validate runs, whatever the caller tracks — that `classifyDensity()` turns into an honest, conservative density level: `'low'`/`'mid'`/`'high'` on total-action thresholds exported as named constants. Same discipline as `signal-store.js`: synchronous, dependency-free, no IndexedDB/DOM/async — it persists NOTHING and resets on reload; cross-session persistence is a deliberate future follow-up. Pure logic only, with no wiring into `main.js` or any UI yet — reserved as the first consumer for Glow Path, a separate parallel batch).

## Federated learning
Opt-in, off-by-default collaborative learning where only privacy-protected summaries or
weight deltas ever leave the browser — never raw data.
- **Core & transport** — `js/federated/federated-fingerprint.js` (DP-noised dataset-shape fingerprint), `js/federated/federated-learning.js` (local training + weight averaging), `js/federated/federated-transport.js` (gossip/relay orchestration).

## Data Diplomacy
The first capability built around DISAGREEMENT between two parties rather than one dataset:
two sources each hold a claim about the same entity+field, and DataGlow reconciles them
honestly — preferring higher confidence, refusing to guess when it cannot tell, and applying
a two-key rule so a resolution is only sealed once both parties independently approve.
Batch 1 is pure logic + tests (no UI, no DOM, no network); Batch 2 adds a thin two-key
approval UI and a Diplomacy tab. Both ship behind the off-by-default `dataDiplomacy` flag.
- **Claim + seal** — `js/diplomacy/diplomacy-claim.js` (`sealClaim`/`verifyClaimSeal`: build an inert, SHA-256-fingerprinted claim and later detect any tampering, reusing the existing `js/provenance/` hashing primitives — no new crypto).
- **Reconciliation engine** — `js/diplomacy/reconciliation-engine.js` (`reconcileClaims`/`explainReconciliation`: a pure, never-throwing referee that prefers the higher-confidence claim, tie-breaks on a caller-supplied source-trust ranking, and honestly returns `resolved:false` — "needs human debate" — rather than guessing).
- **Two-key approval gate** — `js/diplomacy/diplomacy-approval-gate.js` (`createApprovalRequest`/`approve`/`reject`/`verifyApprovalRecord`: a two-party state machine that only flips a request to `applied` — and seals a tamper-evident record — once BOTH parties independently approve).
- **Two-key panel UI (Batch 2)** — `js/diplomacy/diplomacy-ui.js` (`buildClaimCardModel`/`buildReconciliationPanelModel` are PURE, DOM-free view-model builders — the panel model honestly preserves the engine's `resolved:false` case and exposes `showApproval:false` for it; `renderDiplomacyPanel` paints two claim cards side by side, the verdict with its real rationale, and — ONLY when the engine resolved — a two-key approval row where each party's Approve button (`data-testid="diplomacy-approve-${partyId}"`) turns only that party's key, re-rendering after each decision so a decided party's buttons are gone). Wired into `js/app-shell/main.js` as `renderDiplomacyTab()`, gated behind the `dataDiplomacy` flag exactly like the Meeting tab: with the flag off the "Diplomacy" tab is never added to the rendered tab bar and `#panel-diplomacy` stays empty. The tab mounts a hardcoded DEMO scenario built with the real engine, NOT a data-loading feature — wiring it to the loaded dataset's columns and to a real cross-device transport (two keys held by two different people) is deliberate future work.

## Provenance, audit & trust
The tamper-evident and human-readable record of what DATAGLOW did, plus artifacts built
for auditors and regulators.
- **Chain of custody** — `js/provenance/provenance.js` (hash-chained transformation trail), `js/provenance/assumption-ledger.js` (plain-language log of every judgment call).
- **Shareable artifacts** — `js/provenance/validation-receipt.js` (self-contained HTML receipt), `js/provenance/selective-disclosure-proof.js` (Merkle-commitment selective disclosure), `js/provenance/irb-mode.js` (IRB/HIPAA document formatting), `js/provenance/peer-review.js` (file-based async review packets), `js/provenance/data-bom.js` (Personal Data Bill of Materials — a one-click, offline "ingredient label" composing the existing attestation with a schema signature, column-distribution snapshot, and local-AI-model identity, if used).
- **Provenance Packet (Batch 1)** — `js/provenance/data-blame.js` (cell-level "data blame": a pure reader over the existing chain-of-custody trail that re-projects it into a per-column / per-cell, ordered, replayable transform history — `buildBlameDetail` standardizes what a transform step records, `buildBlameIndex`/`blameForColumn`/`blameForCell`/`replayLog`/`summarizeColumnBlame` answer "who/what changed this cell and why"; no parallel log), `js/provenance/deidentification-verifier.js` (one-click HIPAA Safe Harbor de-identification checker — `HIPAA_SAFE_HARBOR` runs the 18 identifier categories against column names + sampled values, `scoreReidentificationRisk` scores indirect-identifier combinations, and `buildDeidAttestation`/`verifyDeidAttestation` produce and re-verify a SHA-256-signed attestation using the same `sha256Hex` primitive as the chain of custody; `runDeidentificationCheck` is the DuckDB-WASM wrapper, 100% client-side). UI lives in the Provenance/Trust tab in `js/app-shell/main.js`.
- **Data Nutrition Label (Trust Passport, Batch 2)** — `js/provenance/data-nutrition-label.js` (a pure, portable provenance *manifest* — not a certification — that reads the existing chain-of-custody trail from `js/provenance/provenance.js`, the Assumption Ledger from `js/provenance/assumption-ledger.js`, and per-layer validation results, and knits them into ONE self-describing summary: `buildDataNutritionLabel(ctx)` assembles `{ kind, schemaVersion, generatedAt, dataset, checksRun, findingsSummary, transformations, assumptions, isSynthetic, custodyChain, disclaimer }`; `renderLabelSummary`/`renderLabelSummaryLines` produce a human-readable block; `exportLabelAsJSON` serializes the machine-readable artifact. Opt-in only, behind the `dataNutritionLabel` flag: the Export card on the Visualize tab in `js/app-shell/main.js` shows an "Include a Data Nutrition Label" checkbox, and only when a human ticks it does the export append the summary to the PDF/Excel and download the `.json` manifest — when off, the export is byte-for-byte unchanged. `isSynthetic` defaults false and `custodyChain.finalHash` is surfaced so later Trust Passport batches can attach a disclosure proof / synthetic-data metadata without changing the shape).
- **Verifiable Check Seal (Trust Passport, Batch 3)** — `js/provenance/verifiable-check-seal.js` (a pure "Proof-of-Clean" sealer that APPLIES the Merkle-tree (SHA-256) commitment from `js/provenance/selective-disclosure-proof.js` — no new crypto — to seal a validation check result into a portable, offline-re-verifiable artifact: `sealCheckResult(result, context)` commits the check's name/kind, a params fingerprint, a SHA-256 `data` fingerprint (the only thing about the raw data that enters the artifact), dataset identity/columns, and the result, and refuses to mint a seal with no data binding; `verifySeal(seal, data)` re-folds every disclosed claim to the committed Merkle root AND, when data is supplied, re-fingerprints it so modified data fails to match — genuine tamper detection, not a "verified" label; `attachSealToLabel(label, seal)` appends the seal additively to a batch-2 Data Nutrition Label's new `custodyChain.seals` array without changing any existing field. Honest naming: NOT a zero-knowledge proof, NOT a certification, NOT "blockchain" — the parameters and result are cleartext and it attests only that the check ran against the fingerprinted data, not that the data is accurate. Opt-in only, behind the `verifiableCheckSeal` flag: a "Seal this result" button in the SQL tab's Local Analysis Contract flow in `js/app-shell/main.js` — a human must click it — offers the `.json` seal as a client-side download; when off, no seal UI renders).
- **Trust Beam (shareable seal link)** — `js/provenance/trust-beam.js` (a pure, dependency-free serializer that makes an existing Verifiable Check Seal portable as a self-contained link: `encodeBeam(seal)` base64url-encodes the seal verbatim inside a versioned envelope, `decodeBeam(payload)` reverses it losslessly, `buildBeamUrl(seal, baseUrl)` composes the full URL with the whole payload in the URL FRAGMENT — which the browser never sends to a server — and `readBeamPayloadFromFragment(fragment)` parses it back out. It composes the existing seal/Merkle logic UNCHANGED and adds NO new crypto: it is a transport wrapper only, so every guarantee AND every honest limit of the underlying seal carries through (still a hash commitment with a re-checkable data fingerprint — NOT a zero-knowledge proof, NOT a certification, NOT "blockchain"; it attests only that the check ran against the fingerprinted data and produced this result, not that the data is accurate). The standalone static page `verify-beam.html` (at the repo root alongside `index.html`, reusing `css/base.css`/`css/app.css` design tokens) is opened by a recipient with ZERO DataGlow install: it reads the fragment, calls `decodeBeam` then the EXISTING `verifySeal()` (verification logic is not reimplemented), and renders a plain-language "Verified"/"Tampered or invalid" verdict fully client-side — no server, no app shell, no login, nothing uploaded. Ships dark behind the `trustBeam` flag (default OFF): when on, a "Beam it" button appears next to the existing "Seal this result" button in the SQL tab's Analysis Contract flow in `js/app-shell/main.js` and produces a copyable link (QR-image generation is a documented follow-up — no QR library is vendored yet); when off, no Beam UI renders and behaviour is byte-for-byte unchanged).

## Privacy & synthetic data
Formal differential-privacy mechanisms for anonymized export and synthetic-dataset
generation.
- **DP export & synthesis** — `js/privacy/privacy-budget.js` (Laplace-mechanism anonymized aggregates), `js/privacy/synthetic-twin.js` (DP synthetic dataset), `js/privacy/synthetic-adversarial.js` (schema-matched adversarial test fixtures).
- **Governed Synthetic Data Passport (Trust Passport, Batch 4)** — `js/privacy/synthetic-data-passport.js` (composes batches 1-3 so a synthetic export never leaves "naked": `buildSyntheticDataPassport(ctx)` wraps batch 2's `buildDataNutritionLabel` with `isSynthetic:true` plus a `synthetic` block that HONESTLY describes how the data was generated and what privacy guarantee applies — a formal differential-privacy claim with a specific ε is asserted only when the generation context actually establishes one (the Synthetic Twin and DP aggregate export both do, via the Laplace mechanism), the generator's own disclaimer is carried verbatim, and a heuristic/non-DP method is stated plainly as carrying no formal guarantee, never upgraded to "anonymized"/HIPAA; `describeSyntheticGeneration` is the pure normalizer; `sealSyntheticPassport(passport, ctx)` OPT-IN seals the exact generation parameters bound to a fingerprint of the synthetic OUTPUT via batch 3's `sealCheckResult`/`attachSealToLabel`; `renderPassportSummaryLines`/`exportPassportAsJSON` render/serialize it. The source-data checks it carries (including the batch-1 Semantic/Metrics Layer results) describe the SOURCE, not the synthetic output. Opt-in only, behind the `syntheticDataPassport` flag: the Synthetic Twin card in `js/app-shell/main.js` shows an "Include Governance Passport" checkbox and Download/Seal buttons; when off, the synthetic-export flow is byte-for-byte unchanged).

## Simulation & time travel
Sandboxes and historical comparisons that never touch the live data.
- **What-if & history** — `js/simulation/digital-twin.js` (in-memory what-if simulator), `js/simulation/time-travel-diff.js` (diff two dataset versions), `js/simulation/time-machine.js` (persistent snapshot ledger in IndexedDB).

## Narrative & language models
Turns structured validation output into plain-English narrative, with a fully on-device
model option.
- **Story & LLM** — `js/narrative/story.js` (data-narrative engine, model-agnostic), `js/narrative/ondevice-llm.js` (opt-in in-browser WebGPU/WebLLM synthesis).

## Ambient & real-time
Runs validation without a manual upload click, off the main thread.
- **Live validation** — `js/ambient/ambient-validation.worker.js` (cheap syntactic checks as the user types SQL), `js/ambient/watch-folder.js` (File System Access polling that auto-validates dropped files).
- **Semantic drift watchdog** — `js/ambient/drift-watchdog.js` (flag: `semanticDriftWatchdog`, disabled by default): de-duplicates the existing distribution-drift validation result so Watch Folder's automatic re-checks surface a new drift finding once instead of re-nagging on every unchanged poll. Adds no new statistics of its own; trigger-agnostic by design so a future native (Tauri/Rust) file-watch trigger can reuse it unchanged.

## Language runtimes & visualization
In-browser second-language tabs and charting.
- **Runtimes & charts** — `js/runtimes-viz/python-runtime.js` (Pyodide), `js/runtimes-viz/r-runtime.js` (WebR), `js/runtimes-viz/visualize.js` (Plotly chart builder).
- **Object Space registry (Polyglot Workbench, Batch B)** — `js/app-shell/object-space.js` (a pure, in-memory read model of the named objects live across the SQL/Python/R runtimes, so a single source of truth can answer "what named objects exist right now, where did each come from, and what shape is it?" `createObjectSpace()` returns a registry with `register`/`get`/`getSchema`/`list`/`unregister`/`clear`; each entry records `name`, `originLanguage` ('sql'|'python'|'r'), `kind` ('dataframe'|'model'|'scalar' — non-tabular objects like an R `lm` are recorded by kind only), `schema` [{name,type}], `rowCount`, `createdAt`, and a `provenance` pointer into the existing chain-of-custody registry in `js/provenance/provenance.js` (the id only — no duplication of that module's hashing/chain logic). Names are a single shared namespace: re-registering a name UPDATES in place (never duplicates) and preserves the first-seen `createdAt`. `registerObject`/`listObjectSpace` expose an app-level singleton the wiring + UI share. ADDITIVE and passive — it sits ALONGSIDE the existing per-language JSON round-trip bridges (`dataglow.get_df` in `python-runtime.js`, `dataglow_get_df` in `r-runtime.js`, `FROM <table>` in `duckdb-engine.js`) and does NOT replace their transfer mechanics, nor resolve cross-language references at query time (no working `FROM py.name` yet — a deliberate future batch). Wired in `js/app-shell/main.js` behind the `objectSpaceRegistry` flag (ships OFF): after a SQL query it registers the loaded DuckDB tables as SQL-origin objects, and after each Python/R run it registers the datasets bridged into that runtime under an origin-qualified handle (`py:`/`r:`) so a table's per-runtime availability shows without one origin overwriting another; a small read-only "Object Space" strip renders in the data sidebar (`#object-space-section` in `index.html`). When the flag is off, no `registerObject` call fires and the strip stays hidden — zero behavior change anywhere.
- **Glow Path adaptive next-action rail (Batch A)** — `js/app-shell/glow-path.js` + `js/app-shell/glow-path-ui.js` (flag: `glowPathRail`, disabled by default): a single honest "what should I do next?" suggestion rail rendered between the tab bar and the main area (`#glow-path-host` in `index.html`). ADDITIVE alongside — not replacing — the flat tab bar, the Command Deck sidebar (`command-deck-nav.js`), and the tab groups (`tab-groups.js`); all of those keep working exactly as before. The pure decision function `computeGlowPathState(ctx)` mirrors `readiness-gate.js`'s discipline (no DOM, never throws, invents nothing): it COMPOSES fields the caller assembles from real `state` — dataset loaded/loaded-at, whether validation has run, a `validationSummary` pass/warn/fail tally, an OPTIONAL real `computeReadinessGate()` result, and a repeat-query count — into one next action by a documented first-match-wins priority: (1) load a file, (2) run Validate, (3) an agent-readiness block explained from the gate's OWN `failingLayers` (never a fabricated layer name; humans always still see everything, only the agent path is paused), (4) review warnings, (5) save a repeated query (mid/high density only), (6) nothing actionable → renders nothing (never an empty box). The thin presenter splits `buildGlowPathBadgeModel(state)` (pure, Node-testable view-model) from `renderGlowPath({host, glowPathState, onCtaClick, onDismiss})` (DOM), plus an in-memory per-dataset `createGlowPathDismissalStore()` (same Set-per-key pattern as `validate-focus.js`). Wired in `main.js` behind the flag as `renderGlowPathRail()`, called after a SQL query, after validation, and on tab switch — it REUSES the already-computed validation results (a pure `computeReadinessGate()` aggregation, never re-running validation) and never blocks a human. `densityLevel` defaults to `'low'`; the proficiency signal that would raise it to `'mid'`/`'high'` is a separate parallel batch (Batch B) this module has no dependency on — mergeable in either order. Node-testable (`test/glow-path.test.mjs`). When the flag is off (default), `renderGlowPathRail()` returns immediately, `#glow-path-host` stays empty, and the app is byte-for-byte unchanged.
- **The Glow signal aggregator (Batch 1 of 2)** — `js/glow/glow-signal.js` (flag: `glowOrb`, disabled by default): a single at-a-glance verdict that COMPOSES DATAGLOW's four existing real trust/health outputs into one object, so an analyst doesn't have to hunt across four surfaces. `computeGlowSignal(input)` mirrors `readiness-gate.js`'s and `glow-path.js`'s discipline (pure, no DOM, never throws, invents nothing): it folds the AI Readiness Gate verdict (`computeReadinessGate()` — `js/gate/readiness-gate.js`), the Trust Strip field states (`collectTrustSignals()` — `js/trust/trust-strip.js`), the Golden Signals data-quality rates (`computeGoldenSignals()` — `js/grades/golden-signals.js`), and the CAT Scorecard letter grades (`computeCATScore()` — `js/grades/cat-scorecard.js`) into `{ status: 'ok'|'warn'|'bad'|'idle', score: 0-100, signals: [{source,label,value,state,detail}], nextAction: {label,detail}|null, summary }`. Compose-don't-recompute: when a real gate result is present its `score`/`agentConsumable` is AUTHORITATIVE (no competing score is invented); with no gate result the status is folded from the trust-strip field states by a worst-wins rule and `score` stays 0 rather than fabricating a number. Every `signals[]` entry traces to a real field, and `nextAction` (only when the gate reports `agentConsumable:false`) is built from the gate's OWN `failingLayers`/`blockedByContract` — never a fabricated layer name (same honesty rule as `describeGateBlock()` in `glow-path.js`). `explainGlowSignal(glowResult)` renders the verdict as a multi-line string for future UI use (mirrors `explainGateReasons()`). Node-testable (`test/glow-signal.test.mjs`, `npm run test:glowsignal`). Batch 1 is pure logic + tests ONLY — nothing is wired into `main.js` and no DOM is built; Batch 2 adds the single glowing topbar orb (color/pulse from `status`, tooltip/panel from `signals`/`summary`/`nextAction`) behind the same `glowOrb` flag.
- **The Glow topbar orb UI (Batch 2 of 2)** — `js/glow/glow-orb-ui.js` (flag: `glowOrb`, disabled by default — ships dark): the thin UI presenter for the Batch-1 aggregator, following the exact identity split of `js/gate/readiness-gate-ui.js`. `buildGlowOrbModel(glowResult)` is a PURE, DOM-free view-model builder (never throws; missing input → honest idle model) that reuses the Trust Strip's `ok/warn/bad/idle` dot colors verbatim (`#2e7d32/#b8860b/#c62828/#9e9e9e`) and returns `{ status, tone, dotColor, scoreText, label, summary, nextActionLabel, signals[] }` — showing a `—` placeholder rather than a fabricated `0/100` when no authoritative gate score exists. `renderGlowOrb({host, glowResult})` draws a ~30px circular orb button (`data-testid="glow-orb"`, colored dot/ring, `aria-expanded`) that on click toggles an inline panel (`data-testid="glow-orb-panel"`, initially `display:none`) listing the status label + score, each composed signal as a label/value row, an honest next-action callout when present, and a "Show the math" toggle revealing `explainGlowSignal()`'s raw text — the same click-to-expand interaction the Readiness Gate badge uses (a future hold-to-unfold gesture is NOT built). It is wired into the topbar (`#glow-orb-host`, leftmost in `.topbar-right`) by `main.js`'s `renderGlowOrbWidget()`, which composes the SAME already-computed state the Readiness Gate badge (`computeReadinessGate(state.validationResults)`) and Trust Strip (`collectTrustSignals(...)`) use — it re-runs NO validation. Golden Signals / CAT Scorecard are computed async inside `renderDataHealth` and not persisted to `state`, so they are left undefined in the topbar composition rather than re-run synchronously (documented Batch-2 follow-up). Node-testable with a tiny self-contained DOM shim (`test/glow-orb-ui.test.mjs`, `npm run test:gloworbui`). Ships dark: with the flag off (default) `renderGlowOrbWidget()` empties the host and returns, so the topbar and whole app are byte-for-byte unchanged.

## Protocol & interoperability
Bridges internal runtime objects to DATAGLOW's versioned, external-facing data contract
under [`protocol/`](../protocol/).
- **Conformance** — `js/protocol/protocol-conformance.js` (adapters to the wire shapes + dev-mode runtime schema check).

## Problem framing
A pre-analysis wizard that turns a vague business question into a specific, measurable
analytical one before any querying begins. Fully offline and deterministic (a fixed
SMART-style prompt set, no model call).
- **Problem Framer & Context Card** — `js/problem-framing/problem-framer.js` (fixed reframing question set, deterministic question restatement, keyword/substring column matching against loaded column names, one-page Markdown recap export, and the optional Context Card re-weighting — `orderLayersByContext` reorders the validation grid so the layers most relevant to what the data is *for* surface first, unchanged when skipped; UI lives in the Problem Framer tab and the Validate tab's Context Card in `js/app-shell/main.js`).

## Teaching & context
Optional learning aids layered over the existing validation output, and file-based
sharing of the domain packs that reinterpret it. Both are pure, offline, and add
zero external dependencies.
- **Teach-As-You-Clean micro-lessons** — `js/teaching/micro-lessons.js` (an original one-line "why this matters" explanation for every validation layer, every domain-pack rule, and the finer Unit Test / Benford sub-findings; `getMicroLesson` resolves a finding-type id at one of three wording registers and `coverageFor` lets the test suite assert full coverage). A "Learn while you clean" toggle (default on) and a Beginner/Practitioner/Expert verbosity slider live in the Validate tab header in `js/app-shell/main.js`; the slider changes only the wording register, never which findings appear or any validation logic. State is session-only, read from the DOM each render — nothing is persisted or uploaded.
- **Community domain-pack sharing** — `js/teaching/community-pack.js` (export a descriptor-based domain pack to portable JSON and import a shared one back; `validateImportedPack` enforces a strict, closed schema and `importPack` compiles the validated descriptor through the same annotate-only rule path the built-in packs use). File-based only — no server, marketplace, or backend. An imported pack runs inside the exact same sandbox built-in packs obey: its target layer is derived from each rule's `kind`, so it can only ever annotate/reinterpret findings and can never hard-fail data or target a core layer. UI (Export Pack / Import Pack) lives in the Validate tab header in `js/app-shell/main.js`.

## Conversational pack builder
Replaces the blank-text-box for authoring a domain pack with a guided, data-grounded
conversation a non-technical domain expert can complete with one tap — turning the
existing validation findings into plain-English questions, resolving "I don't know"
entirely on-device, and assembling a portable pack only from rules the user explicitly
confirms. Every suggestion is only ever a suggestion; nothing is written into a pack
without an explicit confirmation. All four modules are pure, browser-free, and name no
network primitive.
- **Data-grounded question generator** — `js/agents/question-generator-agent.js` (scans pipeline findings for the most "askable" anomalies in the spec's priority order — mathematically impossible values, extreme outliers, missingness clusters, format drift — and fills a fixed plain-English template that always references a REAL observed value; `generateQuestions` extracts + ranks grounded candidates, `scanForAskableAnomalies` drops any generic candidate, and `buildQuestionView` returns the two primary buttons plus the low-emphasis free-text/voice fallback). Deterministic template fill needs no LLM; `buildQuestionPrompt` optionally polishes wording on-device without inventing a value.
- **"I don't know" resolution engine** — `js/agents/uncertainty-resolver-agent.js` (when a domain expert is unsure, resolves on-device in a fixed order — Step A statistical-confidence check, Step B local peer-index borrow, Step C a three-agent debate panel run SEQUENTIALLY against one WebGPU context with confidence-weighted reconciliation under a 2-second budget, Step D one unified suggestion; `resolve` orchestrates the steps, `runDebate` runs the sequential panel with a deterministic no-LLM fallback, and `ResolverSession` implements Step E park-and-revisit). The debate/steps are never shown; only the single suggestion is.
- **Local peer-sourced pack index** — `js/packs/local-pack-index.js` (a flat, content-addressed, read-only index of community packs fetched once via an INJECTED fetcher and thereafter served from the service-worker cache; `LocalPackIndex` validates + content-address-checks every entry and answers pure synchronous lookups for the resolver's Step B, and `loadIndex` degrades to an empty index on any fetch failure). Never auto-applies a peer rule — Step B only offers to borrow one.
- **Guided pack builder** — `js/agents/pack-builder-agent.js` (consumes CONFIRMED answers however they arrived — button, typed, on-device voice transcription, or a resolver acceptance — and incrementally assembles a valid portable pack; `interpretAnswer` turns one confirmed answer into a learned rule and `PackBuilderSession` accumulates them, shows the running summary, and `finalize` builds the envelope, validates it through `community-pack.js`, and proves it carries no network code via the pack no-network guard). Reuses the existing portable-pack schema + no-network guard rather than inventing a second pack format.
- **Validate-tab UI wiring** — `js/agents/conversational-pack-ui.js` (the DOM presenter that drives the four agents above as an in-page, one-question-at-a-time card in the Validate tab header — never a modal; `shouldOfferPackBuilder` is the single pure gate the caller checks and `mountConversationalPackBuilder` runs the question → "✅ Got it" confirmation → running summary → finalize → [Save locally]/[Export to share] flow, routing "I don't know" through the resolver's single Step-D suggestion). Gated behind the `conversationalPackBuilder` flag (ships OFF), so with the flag off the host in `index.html` is left empty and hidden and nothing renders; `js/app-shell/main.js` builds the question context from the fingerprint + Missingness Detective findings and mounts it after a validation run. Save/Export reuse the existing community-pack register/download path. Voice/mic stays behind the separate `conversationalPackBuilderVoice` flag (off).

## Trust & metrics (OneCanvas Phase 1)
Parts 3–5 of the OneCanvas product spec: a place to define trustworthy metrics and a
compact, always-honest surface for whether the loaded data can be trusted. Every value
shown traces to real computed data — the loaded dataset's load time, the real 20-layer
validation results, the provenance chain, and the local Metric Studio registry — never a
hardcoded placeholder. Both surfaces ship dark behind their own feature flags. (The wider
OneCanvas shell, Dashboard Central, and Story Mode are later phases and are NOT built
here.)
- **Metric Studio** — `js/metrics/metric-studio.js` (a local-only registry, following the
  `js/packs/pack-registry.js` named-thing pattern, for user-defined metrics: a name + a
  plain-English definition + a DuckDB formula whose referenced columns are validated
  against the loaded dataset's REAL schema — undefined columns are rejected with a clear
  error — and whose value is actually computed against the in-browser engine via the
  injected `computeMetricValue`, storing the computed number + timestamp, never a
  placeholder. `MetricRegistry` holds metrics in-memory with `toJSON`/`fromJSON` export
  and import, `validateMetricDefinition` + `referencedIdentifiers` guard the schema,
  `suggestExpression` offers an editable formula from plain English, and `findDuplicates`
  flags same-formula or >90%-similar-text metrics so the UI can prompt merge/keep-both.
  Each metric carries a status (exploratory/reviewed/certified) plus owner/tag. Gated
  behind the `metricStudio` flag (ships OFF); `js/app-shell/main.js` mounts the create
  form + saved list + duplicate prompt into the Validate tab only when it is on.
- **Trust Strip** — `js/trust/trust-strip.js` (a compact, persistent bar of trust signals
  whose pure `collectTrustSignals` collector reads real sources — dataset `loadedAt` for
  freshness/last-update, the Metric Studio certification counts, the real validation
  pass/warn/fail tally, an anomaly indicator, and provenance-chain availability — and
  renders sensibly with zero data loaded via `renderTrustStrip`. Clicking any field opens
  the Proof Drawer scoped to that field's underlying data). Gated behind the
  `trustStripProofDrawer` flag (ships OFF); mounted at the top of the Validate tab by
  `js/app-shell/main.js` only when on.
- **Proof Drawer** — `js/trust/proof-drawer.js` (a slide-out panel opened from a Metric
  Studio metric, a Trust Strip field, or a provenance view; its pure `buildProofContent`
  assembles the real explanation for each trigger — a metric's definition, computed value,
  source columns, and opt-in "Show the math" raw expression/query; a Trust Strip field's
  underlying data such as the per-layer validation list — and for provenance/lineage it
  REUSES the existing `renderAttestationHTML()`/`renderReceiptHTML()` from
  `js/provenance/provenance.js` and `js/provenance/validation-receipt.js` rather than
  duplicating that rendering. `openProofDrawer` paints it). Same `trustStripProofDrawer`
  flag; no SQL knowledge is required to read the default view.
## Meeting scribe
Grounds a stakeholder meeting's transcript to whichever chart/query was on screen at
each moment, without capturing audio or running speech-to-text itself (that capture
path is a separate, browser-API-heavy follow-up). Deterministic string/array logic
only — no LLM, no DOM, no network primitive — so it needs a browser to be USED but not
to be CORRECT.
- **Meeting note grounding agent** — `js/agents/meeting-scribe-agent.js` (`tagSegmentsWithContext` tags each transcript segment with whichever chart/query-change event from a caller-supplied timeline was active at its timestamp, leaving pre-first-event segments untagged rather than guessing; `detectPushback`/`detectDataRequest` flag stakeholder pushback phrases — e.g. "why did this drop", "are you sure" — that should trigger the EXISTING uncertainty resolver's re-run rather than a prose reply, and new-data-request phrases into a lightweight queue; `buildActionItem`/`isActionItemResolved`/`resolveActionItem` enforce that an action item only counts resolved once it carries an owner, a due date, AND an outcome — a bare "will follow up" stays open; `buildMeetingNote` assembles the plain, JSON-safe ledger entry). Ships no capture path yet — this is the pure grounding/tagging logic only; wiring it to a live transcript is a follow-up.
- **Meeting scribe — Meeting-tab UI wiring** — `js/agents/meeting-scribe-ui.js` (`shouldOfferMeetingScribe` is the pure flag gate main.js checks before adding the "Meeting" tab to the tab bar at all — with `meetingScribe` off, the tab is not just hidden but never added to `state.tabOrder`'s rendered list, so there is no dead click target; `mountMeetingScribe` renders a paste/type-transcript textarea, an [Analyze transcript] button that runs the text through the Part 1 agent above and groups the results into Pushback moments / Data requests / a full tagged-line list, and a small action-item tracker whose rows show "Open" until owner + due date + outcome are all filled in and saved, then flip to "Resolved"; `parseTranscriptText` turns pasted/typed lines into `{text, ts}` segments, reading a leading integer as an explicit second-based timestamp or auto-numbering a bare line one second after the previous). Still no audio capture or speech-to-text — a person supplies the transcript text themselves; nothing here reads a microphone or the network. `mountMeetingScribe`'s return value now also exposes `getState()` (added for Part 3 below) — a read-only snapshot of the in-progress meeting's tagged segments and action items, for the sibling decision-ledger module to read only when the analyst explicitly clicks Save.
- **Chart-anchored meeting decision ledger (pure logic)** — `js/agents/meeting-decision-ledger.js` (`buildLedgerEntry`/`buildLedgerEntriesFromMeeting` turn Part 1's already-tagged segments and action items into small, permanent, JSON-safe entries — only the noteworthy ones (pushback, data request, action item), never every transcript line, unless a caller opts into `includeAllLines`; each entry keeps whatever chart `context` Part 1 attached, or `null` if none was available, never inventing one; `saveLedgerEntries`/`loadLedgerEntries` talk only to an injected `store` adapter — mirroring `js/learning/memory-store.js`'s `appendLedgerEntries`/`getLedgerEntries` contract — so this module has no hardcoded storage import and is fully testable with an in-memory fake; `filterLedgerEntries`/`chartsReferencedIn` support browsing by chart/kind; `exportLedgerEntries` only formats a JSON string, no network primitive anywhere in the file). Append-only by design: resolving an action item later writes a NEW entry rather than editing the old one, so the history of "was this ever open" is never erased. Persisted via a new `meetingDecisionLedger` object store added to the existing shared `dataglow_memory` IndexedDB in `js/learning/memory-store.js` (capped at 5,000 entries, oldest evicted first).
- **Meeting decision ledger — Meeting-tab browse/save UI wiring** — `js/agents/meeting-decision-ledger-ui.js` (`shouldOfferDecisionLedger` is the pure flag gate for this section, separate from `meetingScribe`'s own flag, so it ships dark independently; `mountDecisionLedger` renders a [Save this meeting to ledger] button that reads the sibling Meeting Scribe screen's current state ONLY on click — nothing auto-saves — plus a filterable browse list (by chart, by type), an [Export ledger (.json)] button that triggers a client-side Blob/anchor-click download, and a [Clear ledger] button that asks to confirm first). Gated behind the `meetingDecisionLedger` flag (ships OFF); with it off, `#meeting-decision-ledger-body` stays empty and unmounted.

- **Metric Contracts (Batch 1: versioned data model)** — `js/metrics/metric-contracts.js`
  (a SEPARATE append-only version history sitting alongside — not inside — the Metric
  Studio `MetricRegistry` above, so that registry needed zero code changes. `snapshotDefinition`
  captures only the contract-relevant fields — `name`/`plainEnglish`/`expression`/`owner`/`tag` —
  deliberately excluding runtime fields like `computedValue`/`status` (recomputing or
  recertifying a metric is not a definition change). `MetricContractHistory.recordVersion`
  appends an immutable, timestamped snapshot; nothing already recorded is ever edited or
  removed. `MetricContractRegistry` keys one history per metric id. `diffVersions` compares
  any two snapshots field-by-field and `summarizeDiff` gives a one-line label. This batch is
  pure logic only — no DOM presenter, no caller wired into `main.js` yet, and no AI-agent
  write path exists through this module.
- **Metric Contracts (Batch 2: diff view, read-only)** — `js/metrics/metric-contract-diff-view.js`
  (turns two of Batch 1's version entries into a normalised block model via pure
  `buildDiffViewContent` — field-by-field before/after, who/when/why/human-vs-agent-proposed,
  all sourced only from the real recorded version metadata, never invented; `buildHistoryListContent`
  renders a metric's full oldest-first version timeline. `renderDiffView` is the DOM presenter,
  following `js/trust/proof-drawer.js`'s exact pure-content/DOM split and reusing its `kv`/`text`/`list`
  block kinds plus one new `field-diff` kind (side-by-side before/after) so both panels look and behave
  consistently. READ-ONLY: no apply/accept button, no write path; nothing in `main.js` calls
  `renderDiffView` yet.)
- **Metric Contracts (Batch 3: confirm gate)** — `js/metrics/metric-contract-confirm-gate.js`
  (the safety-critical piece. `proposeContractChange` builds a plain, inert PROPOSAL object — pure
  data, zero side effects — the only thing an AI-agent caller can produce with respect to a metric
  contract. `buildProposalDiffContent` reuses Batch 2's `buildDiffViewContent` unmodified so a pending
  proposal renders identically to a past human edit. `approve(proposal, contractRegistry,
  metricRegistry)` is the ONLY function in the codebase that can call `recordVersion()` with
  `source: 'agent-proposed'` — it also applies the same change to the metric's live definition, and
  only ever runs from the one Approve button `renderConfirmGate`'s DOM presenter renders; no
  auto-approve path exists. Idempotent on double-approve; refuses cleanly without either registry or
  on an already-decided proposal. `reject` writes nothing anywhere, ever. Reaffirms and tests
  DATAGLOW's hard autonomy-safety rule: an agent may propose, a human must approve every mutating
  action individually. Two EQUAL-weight Approve/Reject buttons — never nudges toward "accept."
  Nothing in `main.js` calls `renderConfirmGate` yet — no agent in the running app can generate a
  real proposal through this gate today.)

All three batches gated behind the `metricContracts` flag (ships OFF, still currently gates nothing
observable since none of the three is wired into `main.js` yet).

- **AI Readiness Gate (pure scoring + UI badge + agent hard-block, batches 1-3 of 4)** — `js/gate/readiness-gate.js` (a PURE
  aggregator that composes the OUTPUT of validation's `runAllLayers()` — never re-running it — plus an
  optional metric-contract status into a single agent-consumability verdict. `computeReadinessGate(layerResults,
  metricContractStatus, options)` returns a well-formed `{ agentConsumable, score, threshold,
  failingLayers, passingSummary, blockedByContract, evaluatedLayerCount }` object: it reuses validation's
  existing `pass`/`warn`/`fail`/`idle` status vocabulary verbatim (inventing no new severity levels),
  excludes `idle` layers from scoring, half-weights `warn`, and treats a broken/invalid metric contract
  as a stand-alone hard block regardless of layer results. Never throws — empty/undefined/null input
  yields a safe not-consumable verdict. `explainGateReasons(gateResult)` renders that verdict as a
  human-readable multi-line string.) **Batch 2 (UI badge)** — `js/gate/readiness-gate-ui.js`
  (`buildReadinessBadgeModel(gateResult)` is a PURE, DOM-free builder turning that verdict into a badge
  view model — a green `Agent-ready` / amber-or-red `Not agent-ready` pill reusing the existing
  `css/base.css` `.badge` + grade-color classes, the 0-100 score, and the `explainGateReasons()` text;
  a run with no validation evidence yet is shown as a neutral honest "Readiness not evaluated", never a
  red failure. `renderReadinessBadge({host, gateResult})` is the thin DOM presenter — a click-to-expand
  reasons panel mirroring the Proof Drawer's "Show the math" toggle. Wired into `js/app-shell/main.js`'s
  SQL tab only: after a query runs, `renderReadinessGateBadge()` composes the last real validation run
  (`state.validationResults`) and renders the badge below the result in `#sql-result-wrap`. It is purely
  INFORMATIONAL — it never re-runs validation and never blocks or delays a human's query.) Answers the
  project's North Star finding (see [`../NORTH_STAR.md`](../NORTH_STAR.md)) that ungoverned data handed
  to AI agents drives the 60-84% AI-initiative failure rate. The batch-2 informational badge is now
  PROMOTED — the `aiReadinessGateBadge` flag ships ON (it never blocks a human). **Batch 3 (agent
  hard-block)** — `js/gate/agent-gate.js` (`evaluateAgentReadiness(readiness)` composes batch-1's
  `computeReadinessGate()` into an allow/block decision — backward-compatible, so with no readiness
  context threaded the agent is ALLOWED and every existing caller is unaffected; `buildAgentRefusal(agent,
  evaluation)` produces the uniform graceful refusal object, discriminable by `blocked:true`, whose
  reasons come from `explainGateReasons()`). The two data-consuming agents — `js/agents/question-generator-agent.js`
  (`generateQuestions`) and `js/agents/uncertainty-resolver-agent.js` (`resolve`) — consult the gate ONLY
  when their caller threads an optional `readiness` context; `js/app-shell/main.js` threads it in the
  conversational pack builder ONLY when the `aiReadinessGateEnforcement` flag is on, passing the
  already-computed validation results as `layerResults` (never re-running validation). This blocks ONLY
  the automated agent path — humans' SQL/Python/R/Metric Studio workflows are entirely unaffected in both
  flag states. Batch 3 ships dark behind `aiReadinessGateEnforcement` (default OFF). Deferred: MCP
  exposure (batch 4); Python/R/Metric Studio badge wiring and a real per-query metric-contract status are
  a batch-2 follow-up.

## Export & reporting
Turns the active dataset/analysis into a downloadable Excel workbook or a summary PDF.
Built on a Universal Export Contract: one byte-builder per format, decoupled from a
per-platform delivery adapter (browser download vs. Tauri native Save-As vs. a planned
mobile share sheet). 100% local — no upload path.
- **Universal export (Excel + PDF)** — `js/export/export-report.js` (format-agnostic view model + the `.xlsx` builder that reuses the vendored SheetJS global and a dependency-free first-party PDF summary writer; `exportDataset` is the single call the UI makes), `js/export/export-delivery.js` (the delivery adapters — `deliverViaBrowser`, `deliverViaDesktop` using Tauri `dialog.save` + `fs.writeBinaryFile` when the shell enables them and a transparent browser-download fallback otherwise, a `deliverViaMobile` future-work stub, and `selectAdapter`). UI lives in the Export card on the Visualize tab in `js/app-shell/main.js`.

## Build tooling & feature flags
Build-time safety machinery, not runtime app behavior. Part of the Build Nervous
System (see [`build-nervous-system.md`](./build-nervous-system.md)).
- **Build feature flags** — `js/build/build-flags.js` (framework-agnostic reader for the root `flags.manifest.json`; `configureFlags` populates an in-memory map once at startup and `isEnabled(name)` reads it — no localStorage/cookies/network, so it behaves identically in the browser, the Tauri desktop webview, and future Tauri mobile). Ships as a copyable pattern; not wired into any existing module.
