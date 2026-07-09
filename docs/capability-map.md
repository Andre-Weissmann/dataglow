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
- **Query engine** — `js/app-shell/duckdb-engine.js` (DuckDB-WASM engine; all SQL runs here, in-browser, zero upload).
- **File loading** — `js/app-shell/loaders.js` (CSV/TSV, JSON/NDJSON, Parquet, Excel, SQLite ingestion into DuckDB; also `loadRowsAsDataset` for in-memory result sets).
- **Warehouse import** — `js/app-shell/databricks-connect.js` (proof-of-concept BYO-token, browser-direct read-only pull from a user's own Databricks SQL warehouse into DuckDB; see [`databricks-connect.md`](./databricks-connect.md)).
- **Capability registry** — `js/app-shell/capability-registry.js` (platform-aware module loader; reads each capability's `platforms` field from [`capability-map.manifest.json`](../capability-map.manifest.json), detects browser vs. Tauri desktop at runtime, and dynamically `import()`s only the modules meant for that runtime so `js/app-shell/main.js` no longer statically imports every feature).

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

## Federated learning
Opt-in, off-by-default collaborative learning where only privacy-protected summaries or
weight deltas ever leave the browser — never raw data.
- **Core & transport** — `js/federated/federated-fingerprint.js` (DP-noised dataset-shape fingerprint), `js/federated/federated-learning.js` (local training + weight averaging), `js/federated/federated-transport.js` (gossip/relay orchestration).

## Provenance, audit & trust
The tamper-evident and human-readable record of what DATAGLOW did, plus artifacts built
for auditors and regulators.
- **Chain of custody** — `js/provenance/provenance.js` (hash-chained transformation trail), `js/provenance/assumption-ledger.js` (plain-language log of every judgment call).
- **Shareable artifacts** — `js/provenance/validation-receipt.js` (self-contained HTML receipt), `js/provenance/selective-disclosure-proof.js` (Merkle-commitment selective disclosure), `js/provenance/irb-mode.js` (IRB/HIPAA document formatting), `js/provenance/peer-review.js` (file-based async review packets).

## Privacy & synthetic data
Formal differential-privacy mechanisms for anonymized export and synthetic-dataset
generation.
- **DP export & synthesis** — `js/privacy/privacy-budget.js` (Laplace-mechanism anonymized aggregates), `js/privacy/synthetic-twin.js` (DP synthetic dataset), `js/privacy/synthetic-adversarial.js` (schema-matched adversarial test fixtures).

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

## Language runtimes & visualization
In-browser second-language tabs and charting.
- **Runtimes & charts** — `js/runtimes-viz/python-runtime.js` (Pyodide), `js/runtimes-viz/r-runtime.js` (WebR), `js/runtimes-viz/swift-preview.js` (SwiftUI-style live preview), `js/runtimes-viz/visualize.js` (Plotly chart builder).

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
