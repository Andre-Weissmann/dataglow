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
- **Controller & wiring** — `js/main.js` (top-level app controller; wires tabs, events, and every feature module together).
- **State & helpers** — `js/state.js` (central mutable app state), `js/utils.js` (shared DOM, formatting, and hashing helpers).
- **Query engine** — `js/duckdb-engine.js` (DuckDB-WASM engine; all SQL runs here, in-browser, zero upload).
- **File loading** — `js/loaders.js` (CSV/TSV, JSON/NDJSON, Parquet, Excel, SQLite ingestion into DuckDB; also `loadRowsAsDataset` for in-memory result sets).
- **Warehouse import** — `js/databricks-connect.js` (proof-of-concept BYO-token, browser-direct read-only pull from a user's own Databricks SQL warehouse into DuckDB; see [`databricks-connect.md`](./databricks-connect.md)).
- **Capability registry** — `js/capability-registry.js` (platform-aware module loader; reads each capability's `platforms` field from [`capability-map.manifest.json`](../capability-map.manifest.json), detects browser vs. Tauri desktop at runtime, and dynamically `import()`s only the modules meant for that runtime so `js/main.js` no longer statically imports every feature).

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
- **Orchestrator** — `js/validation.js` (runs all layers + Red Team self-test; the entry point most features call).
- **Standalone layer modules** — `js/categorical-consistency.js`, `js/cross-column-consistency.js`, `js/physiological-plausibility.js`, `js/upper-bound-sanity.js`, `js/missingness-detective.js`, `js/missingness.js`.
- **Reinterpretation & context** — `js/domain-physics.js` (swappable domain packs that annotate raw layer output), `js/expected-range.js` (informational numeric trend bands).

## Anomaly & outlier detection
On-device, dependency-free detectors for values and rows that don't fit — from single
columns up to whole-row multivariate anomalies.
- **Detectors** — `js/isolation-forest.js`, `js/ondevice-ml.js` (diagonal-covariance / Mahalanobis-style scoring), `js/predictive-anomaly.js` (kNN/Gower row outliers).
- **Baselining & process control** — `js/entity-baseline.js` (per-entity UEBA baselines), `js/spc-control.js` (Shewhart control charts + Cpk).
- **Triage** — `js/active-learning.js` (uncertainty sampling; surfaces least-confident cells first).

## Analysis robustness
Adversarial re-analysis that stress-tests whether a query result's headline finding
actually holds up — this scrutinizes the *conclusion drawn from* the data, not the data
itself (which is the validation layers' job).
- **Devil's Advocate** — `js/devils-advocate.js` (bootstrap resampling, trimmed re-estimate, and subgroup leave-one-out robustness checks run over the current SQL result).

## Drift, trend & fingerprinting
Detects when a new upload has moved away from what history would predict. The base
distributional-fingerprint drift is layer 18 inside `js/validation.js`; these extend it.
- **Forecasting** — `js/drift-forecast.js` (Holt's exponential smoothing; escalates layer 18 when an upload is outside the predicted band).
- **Trend narration** — `js/expected-range.js` (also listed under Validation layers; informational, raises no alert).

## Cleaning & fixes
Everything that proposes a change to the data. All of it is preview-only: DATAGLOW
generates the SQL/plan and shows confidence, the human approves.
- **Core cleaning** — `js/clean.js` (issue scan + preview-only fixes), `js/fix-confidence.js` (safety score per proposed fix), `js/materiality.js` (hide sub-threshold issues).
- **Targeted transforms** — `js/imputation.js` (grouped-mean fills), `js/format-fingerprint.js` (currency/date/fake-null standardizer), `js/fuzzy-dedup.js` (near-duplicate radar + shared string-similarity metrics).

## Grades & health scores
Composite roll-ups that turn raw layer output into a few honest, high-level numbers.
- **Grades** — `js/calibrated-grades.js` (two-axis Integrity vs Domain-Confidence grades), `js/cat-scorecard.js` (Completeness/Accuracy/Timeliness), `js/golden-signals.js` (four top-line health numbers).

## On-device learning & personalization
Transparent, browser-only learners that personalize ordering and suggestions from the
user's own accept/dismiss history — plus the stores they read and write.
- **Learners** — `js/self-learning-rules.js` (logistic-regression flag ranking), `js/adaptive-priority.js` (Beta-Binomial layer reordering), `js/rule-suggestions.js` (correction-history rule induction).
- **Shared state** — `js/signal-store.js` (unified in-memory signal layer coordinating the learners), `js/memory-store.js` (IndexedDB persistence, versioned + LRU-evicted).

## Federated learning
Opt-in, off-by-default collaborative learning where only privacy-protected summaries or
weight deltas ever leave the browser — never raw data.
- **Core & transport** — `js/federated-fingerprint.js` (DP-noised dataset-shape fingerprint), `js/federated-learning.js` (local training + weight averaging), `js/federated-transport.js` (gossip/relay orchestration).

## Provenance, audit & trust
The tamper-evident and human-readable record of what DATAGLOW did, plus artifacts built
for auditors and regulators.
- **Chain of custody** — `js/provenance.js` (hash-chained transformation trail), `js/assumption-ledger.js` (plain-language log of every judgment call).
- **Shareable artifacts** — `js/validation-receipt.js` (self-contained HTML receipt), `js/selective-disclosure-proof.js` (Merkle-commitment selective disclosure), `js/irb-mode.js` (IRB/HIPAA document formatting), `js/peer-review.js` (file-based async review packets).

## Privacy & synthetic data
Formal differential-privacy mechanisms for anonymized export and synthetic-dataset
generation.
- **DP export & synthesis** — `js/privacy-budget.js` (Laplace-mechanism anonymized aggregates), `js/synthetic-twin.js` (DP synthetic dataset), `js/synthetic-adversarial.js` (schema-matched adversarial test fixtures).

## Simulation & time travel
Sandboxes and historical comparisons that never touch the live data.
- **What-if & history** — `js/digital-twin.js` (in-memory what-if simulator), `js/time-travel-diff.js` (diff two dataset versions), `js/time-machine.js` (persistent snapshot ledger in IndexedDB).

## Narrative & language models
Turns structured validation output into plain-English narrative, with a fully on-device
model option.
- **Story & LLM** — `js/story.js` (data-narrative engine, model-agnostic), `js/ondevice-llm.js` (opt-in in-browser WebGPU/WebLLM synthesis).

## Ambient & real-time
Runs validation without a manual upload click, off the main thread.
- **Live validation** — `js/ambient-validation.worker.js` (cheap syntactic checks as the user types SQL), `js/watch-folder.js` (File System Access polling that auto-validates dropped files).

## Language runtimes & visualization
In-browser second-language tabs and charting.
- **Runtimes & charts** — `js/python-runtime.js` (Pyodide), `js/r-runtime.js` (WebR), `js/swift-preview.js` (SwiftUI-style live preview), `js/visualize.js` (Plotly chart builder).

## Protocol & interoperability
Bridges internal runtime objects to DATAGLOW's versioned, external-facing data contract
under [`protocol/`](../protocol/).
- **Conformance** — `js/protocol-conformance.js` (adapters to the wire shapes + dev-mode runtime schema check).

## Problem framing
A pre-analysis wizard that turns a vague business question into a specific, measurable
analytical one before any querying begins. Fully offline and deterministic (a fixed
SMART-style prompt set, no model call).
- **Problem Framer** — `js/problem-framer.js` (fixed reframing question set, deterministic question restatement, keyword/substring column matching against loaded column names, and one-page Markdown recap export; UI lives in the Problem Framer tab in `js/main.js`).
