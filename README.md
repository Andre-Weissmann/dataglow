# DATAGLOW

> **Your data, glowing.** A universal, browser-based, all-in-one data analytics platform — no install, no server, no upload.

[![zero-upload egress-deny](https://github.com/Andre-Weissmann/dataglow/actions/workflows/zero-upload-proof.yml/badge.svg)](https://github.com/Andre-Weissmann/dataglow/actions/workflows/zero-upload-proof.yml)
[![20-layer Validate suite](https://github.com/Andre-Weissmann/dataglow/actions/workflows/validate-suite.yml/badge.svg)](https://github.com/Andre-Weissmann/dataglow/actions/workflows/validate-suite.yml)

📋 **New here?** See [TRUST.md](TRUST.md) for a first-party, verifiable look at this repo's health, how it's built to work with AI coding agents, and a curated "Start Here" list of good first contributions.

---

## Three ways to run it

- **Browser** — 🟢 live: a zero-upload web app that runs entirely client-side; nothing you load is ever uploaded.
- **Desktop** — 🟢 shipped: a native [Tauri](https://tauri.app/) shell for Windows, macOS, and Linux — grab a build from the [releases page](https://github.com/Andre-Weissmann/dataglow/releases).
- **PWA (iOS/Android):** Live -- open https://dataglow-platform.pplx.app in mobile browser and add to home screen. **Tauri desktop (Windows/Mac/Linux):** Live. **Native iOS (SwiftUI):** Planned.

### What the two badges above actually prove

- **zero-upload egress-deny** — the core engine + 20-layer validation test suite is re-run inside a network namespace with **no route to the internet except loopback** (a positive control first confirms the block is live). Green means those code paths handled the test data with zero possibility of network egress. It does **not** cover the opt-in Python/R/Story tabs, which fetch their own runtime from a CDN on demand — see [`.github/workflows/zero-upload-proof.yml`](.github/workflows/zero-upload-proof.yml) for the full honest scope.
- **20-layer Validate suite** — runs the automated coverage for all 20 validation layers against a real native DuckDB engine (the same production modules the browser uses). See [`.github/workflows/validate-suite.yml`](.github/workflows/validate-suite.yml).

### Verify it yourself

Don't take the badges on faith — run the exact same checks locally:

```bash
git clone https://github.com/Andre-Weissmann/dataglow.git
cd dataglow
npm ci

# Badge #2 — the 20-layer Validate suite (native DuckDB):
npm run test:layers

# Badge #1 — the core engine + validation suite with ALL network egress blocked.
# (Linux; needs sudo for the network namespace.) A positive control proves the
# block is live, then the suite runs with no route to the internet but loopback:
sudo unshare --net -- bash -euo pipefail -c '
  ip link set lo up
  curl --max-time 8 https://registry.npmjs.org >/dev/null 2>&1 \
    && { echo "network reachable — egress block FAILED"; exit 1; } \
    || echo "confirmed: no outbound network"
  npm run test:sql && npm run test:layers && npm run test:golden
'
```

The `npm ci` step needs the network (it installs the test toolchain); everything the egress-blocked step runs is offline. This is the same sequence the two CI workflows above execute.

## What is DATAGLOW?

DATAGLOW is a personal data cleaning, validation, and analysis workbench that runs entirely in your browser. Upload a file and move through preflight checks, SQL querying, automated cleaning, a 20-layer data validation suite, drag-and-drop visualization, AI-assisted narrative summaries, and even live Python / R notebooks — all client-side.

Everything runs on WebAssembly and vanilla JS. Your data never leaves your machine.

## Features

- **Preflight** — instant data quality checklist the moment a file loads
- **SQL** — query any loaded table with a DuckDB-WASM engine and autocomplete
- **Clean** — automated cleaning (duplicates, nulls, formatting) with a full audit trail of every change made
- **Validate** — 20 independent validation layers (schema, nulls, duplicates, outliers, Benford's Law, semantic drift, cross-column logic, distributional drift, physiological plausibility, missingness classification, confidence scoring with anomaly-concentration detection, unit tests, and more)
- **Domain Pack Marketplace** — the validation layers stay industry-agnostic, but a swappable *domain pack* sits above them and reinterprets their raw output in context (softening or annotating findings, never deleting them or introducing new failures). Packs are now generalized across industries: **Healthcare** (de-identification date-shifting, protected-category merge guards, binary-flag Benford exemptions), **Retail / E-commerce** (SKU merge guards, return/refund flag Benford exemptions, seasonal/promotional outlier reinterpretation), and **Finance / Accounting** (ledger/GL-account merge guards, reconciliation-flag Benford exemptions, offsetting debit/credit outlier reinterpretation) — or **None** for the raw, domain-agnostic result. Two healthcare-standards packs, **Healthcare — OMOP CDM** and **Healthcare — FHIR Bundle**, additionally recognise data shaped like the OMOP Common Data Model or HL7 FHIR bundles and route it through the *same* validation layers (cross-column, physiological plausibility, missingness) — schema recognition and concept-mapping only, no new validation math — and surface a plain non-clinical disclaimer. Two built-in synthetic samples ("Load OMOP CDM Sample" / "Load FHIR Bundle Sample", fabricated data with intentionally planted issues, never real PHI) let you see them in action. An optional **Context Card** ("What is this data for?") lets you say in a few words what the dataset is about; DATAGLOW then surfaces the most relevant validation layers first (e.g. a "billing accuracy" context floats the numeric/financial layers ahead of formatting checks). Both work identically in the browser and the Tauri desktop shell, and nothing is stored or uploaded — skipping the Context Card leaves the default order untouched
- **Visualize** — drag-and-drop chart builder powered by Plotly
- **Story** — AI-generated plain-language narrative summaries of your dataset, with three interchangeable engines you pick in Settings: (1) **In-browser AI** (default, recommended) runs a small open-weight language model — **Qwen2.5-1.5B-Instruct**, 4-bit quantized (~1.1 GB), Apache-2.0 licensed — **100% on your device via WebGPU/WebLLM**, so no API key is needed and your data never leaves the browser; the weights download once and are cached for offline reuse. (2) **Bring your own API key** (Perplexity, Claude, Gemini, OpenAI). (3) An honest **rule-based** offline summary with no AI. The in-browser option needs a WebGPU-capable browser (recent Chrome, Edge, or Chrome on Android; Safari 18+) and gracefully falls back to the rule-based summary where WebGPU is unavailable
- **Python** — in-browser notebook via Pyodide
- **R** — in-browser notebook via WebR
- **Red Team Mode** — a built-in self-test that runs a golden dataset with known injected defects (nulls, negatives, an outlier, duplicate rows) through every validation layer and checks that DATAGLOW actually catches them
- **Predictive Anomaly Scoring** — an on-device, unsupervised outlier detector that learns the "normal shape" of the *currently-loaded* dataset and flags whole rows whose *combination* of values is unusual — the holistic, multi-column anomalies that single-column rules and the numeric-only Multivariate Outliers panel can miss (e.g. a 15-year-old with a retirement account, where neither value is individually out of range). The technique is a **k-nearest-neighbours distance outlier score** (Ramaswamy et al. 2000) over **Gower distance** (Gower 1971), which lets it mix *numeric and categorical* columns on one scale. Every flag is explainable: because Gower distance is an average of per-feature terms, each row's score decomposes additively across features, so the panel shows which features drove the flag in plain language. It is fit to *this* dataset's own distribution per-session (RAM only) — not a general AI, not a cross-session learned model, and **not one of the 20 validation layers** but a separate, complementary capability. Unusual is not the same as wrong: a flag may be a legitimate rare case. For performance the O(n²) neighbour search is capped (default 2,000 rows) with uniform random sampling above the cap, clearly disclosed in the UI.
- **Self-Learning Validation Rules** — learns from *your own* corrections (applying/rejecting a suggested merge, dismissing a validation flag) and re-ranks flags so the ones you're most likely to care about surface first, with a plain-language "why". It is a simple, transparent, on-device **logistic-regression** model — not a neural network or general-purpose AI — that starts knowing nothing until you've made at least 10 corrections. Only labeled examples of your corrections (which check fired, the column type, accept/dismiss) are recorded — **never your raw cell values** — and nothing ever leaves your browser. Per-session learning is on by default (RAM only, wiped on reload); remembering it across sessions in IndexedDB is a separate opt-in, and a one-click **"Clear my learned corrections"** wipes it. It only ranks and highlights — it never auto-edits your data.
- **Federated Fingerprint Learning** *(opt-in, OFF by default)* — collaboratively improves the shared column-fingerprint/pattern model across users **without any of your data ever leaving your browser**. Each opted-in browser trains a tiny local model on its own validation-session signals and shares **only privacy-protected weight *updates*** — never raw rows, never cell values. Three privacy layers stack: (1) **secure aggregation via pairwise masking** (Bonawitz et al. 2017), where equal-and-opposite masks cancel in the sum so no single peer's update is ever seen in the clear; (2) a **differential-privacy Gaussian mechanism** (Dwork & Roth 2014; DP-SGD clip-then-noise, Abadi et al. 2016) with a tunable ε you control in Settings; and (3) a **minimum-cohort threshold** so an update is never aggregated or applied from fewer than the minimum number of peers per round. Peers find each other through a scheduled GitHub Action that publishes a short-lived, auto-expiring "phone book" of WebRTC signaling offers on a dedicated coordination branch — **GitHub only bootstraps signaling and never sees any weights or data**. The real weight exchange happens **peer-to-peer over WebRTC**, gossiped (Boyd et al. 2006; Lian et al. 2017 D-PSGD) to a few random reachable peers, with a masked-commit relay fallback so it still works with only one or two users. Federated averaging (**FedAvg**, McMahan et al. 2017) combines the updates, and every contribution produces a hash-chained receipt reusing the app's selective-disclosure provenance pattern. If WebRTC is unsupported, no peers are reachable, GitHub is unreachable, or you're offline, it **degrades silently to purely local behavior with zero errors**. One click clears all local federated state.
- **Unified Signal Layer** — a lightweight, in-memory coordination layer that lets the on-device modules above read each other's conclusions *before* anything is drawn on screen, so they enrich rather than contradict one another. The Self-Learning ranker publishes its learned per-column verdicts into a shared signal store; the Predictive Anomaly scorer then **suppresses** (de-ranks, with a plain-language "why") a row whose dominant column you've repeatedly dismissed as a false positive, instead of showing a duplicate warning; and the Forecast-Based Drift alerter **surfaces the connection** when a drift flag lands on a column whose validation rule you recently disabled. It is purely additive plumbing — it runs no new model and changes no module's statistics, so each module behaves exactly as before whenever there is no cross-module signal to share.
- **Teach As You Clean** — an optional one-line "why this matters" explanation attached to every validation finding, so the app teaches while it validates. A **"Learn while you clean"** toggle (on by default) shows or hides all of them, and a **Beginner / Practitioner / Expert** verbosity slider changes only the *wording register* — never which findings appear or any validation result. Every explanation is original one-sentence copy covering all 20 layers (plus the Red Team self-test), each domain-pack reinterpretation, and the finer Unit Test and Benford sub-findings. The state is session-only, read straight from the page each render — nothing is stored or uploaded (`js/teaching/micro-lessons.js`).
- **Community Pack Sharing** — export a domain pack as a portable JSON file and import a shared one back, so a data team can pass its Retail/Finance reinterpretations around **without any server, marketplace, or backend** — file-based only, reusing the same browser download/upload the rest of the app uses. Every imported pack is validated against a **strict, closed schema** before it loads (unknown keys, bad shapes, disallowed regex flags, and oversized inputs are rejected), and it then runs inside the **exact same annotate-only sandbox** the built-in packs obey: each rule's target layer is derived from its declared `kind`, so an imported pack can only annotate/reinterpret findings — it can never hard-fail your data, auto-merge protected categories, or touch a core validation layer. Only descriptor-based packs (Retail, Finance, or a pack you imported) are portable; the hand-written Healthcare pack is not (`js/teaching/community-pack.js`).

### Supported file formats (Tier 1)

CSV, TSV, JSON, NDJSON, Parquet, Excel (.xlsx/.xls)

Additional formats (ORC, Avro, HDF5, Delta Lake, FHIR, DICOM, EDI, PDF tables, Google Sheets, SAS/SPSS/Stata, SQLite) are on the roadmap.

## Built With

- Vanilla HTML / CSS / JavaScript (no bundler, no build step)

**Self-hosted (vendored under `assets/`, so a normal page load fetches nothing from a third party):**

- [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) for in-browser SQL
- [Plotly.js](https://plotly.com/javascript/) (MIT) for visualization
- [SheetJS (xlsx)](https://sheetjs.com/) (Apache-2.0) for Excel parsing
- Fonts — [Inter](https://github.com/rsms/inter), [Poppins](https://fonts.google.com/specimen/Poppins) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) (all SIL OFL 1.1), latin-subset WOFF2 vendored under `assets/fonts/` and declared via `@font-face` in `css/base.css` (no fonts.googleapis.com / fonts.gstatic.com fetch)

**Loaded from public CDNs on demand, only when you first open these optional tabs** (their multi-hundred-megabyte runtimes aren't practical to vendor into every page load):

- [Pyodide](https://pyodide.org/) for in-browser Python
- [WebR](https://webr.r-wasm.org/) for in-browser R
- [WebLLM](https://github.com/mlc-ai/web-llm) (Apache-2.0) for the in-browser Story model — running [Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) (Apache-2.0), lazy-loaded from WebLLM's prebuilt model registry and cached in-browser

In every case the library *code* is what's fetched — never your data, which stays in your browser.

## Supply-chain

![supply-chain: SBOM + provenance ledger](https://img.shields.io/badge/supply--chain-SBOM%20%2B%20provenance%20ledger-informational?style=flat)

DATAGLOW keeps an honest, self-contained record of how its own CI builds things — no hosted attestation service, no third-party trust-score integration:

- **SBOM every CI run.** Each run generates a CycloneDX Software Bill of Materials (`npm run sbom`) listing the full dependency set.
- **Zero unreviewed install scripts.** The root `.npmrc` sets `ignore-scripts=true`, and the `supply-chain-hardening` CI job fails the build if any dependency introduces an unreviewed `preinstall`/`install`/`postinstall` script (enforced by [`.github/workflows/job-supply-chain-hardening.yml`](.github/workflows/job-supply-chain-hardening.yml)).
- **CI provenance ledger.** Every CI run that lands on `main` appends one hash-linked entry — commit, timestamp, test conclusion, and the SHA-256 of that run's SBOM — to an append-only [`docs/ci-provenance-ledger.jsonl`](docs/ci-provenance-ledger.jsonl). Each entry chains to the previous one's hash, so the record is tamper-evident.
- **Independently verifiable, fully offline.** Clone the repo and run `npm run verify:ci-provenance` ([`.github/scripts/verify-ci-provenance.mjs`](.github/scripts/verify-ci-provenance.mjs)) to recompute the whole chain — zero network, zero GitHub API calls. It reports "chain intact" or names the exact entry that broke.

Roughly SLSA L1 equivalent (basic build provenance, no hosted attestation service) — and only that. We do **not** claim a higher SLSA level, and add no cryptographic signing or attestation service; the hash chain is self-contained and zero-dependency by design.

## Project Structure

```
dataglow/
├── index.html              # single entry point (no bundler, no build step)
├── css/                    # base.css (design tokens) + app.css
├── js/                     # ES modules, organized into feature domains (see below)
├── assets/                 # self-hosted vendored libs (DuckDB-WASM, Plotly, SheetJS) + icons/art
├── test/                   # node-run test suites (npm run test:*)
├── docs/                   # CHANGELOG, design decisions, vision, generated dashboards
└── flags.manifest.json     # client-side feature-flag manifest (Build Nervous System)
```

The `js/` directory is no longer a flat list — it is split into per-capability
subdirectories (`js/app-shell/`, `js/validation/`, `js/cleaning/`,
`js/narrative/`, `js/runtimes-viz/`, …). Rather than duplicate that layout here
by hand (where it would silently rot), see the **Capability dashboard** below:
it is generated from `capability-map.manifest.json`, validated against the
shipped code by the capability-map drift gate (`npm run test:capdrift`), and
maps every capability area to its exact current module paths.

## Capability dashboard

Every capability area below is generated from `capability-map.manifest.json` — the
same file the capability-map drift gate (`npm run test:capdrift`) validates against
the shipped `js/` code — so this table and the code can never silently disagree. It
is regenerated automatically on every merge to `main`; do not edit it by hand.

<!-- CAPABILITY_TABLE_START -->
| Capability area | Name | Files |
| --- | --- | --- |
| App shell & data engine | Controller & wiring | `js/app-shell/main.js` |
|  | State & helpers | `js/app-shell/state.js`, `js/app-shell/utils.js` |
|  | Query engine | `js/app-shell/duckdb-engine.js` |
|  | File loading | `js/app-shell/loaders.js` |
|  | SQL editor highlighting | `js/app-shell/sql-highlight.js` |
|  | Multi-dialect SQL translation | `js/app-shell/sql-dialect-adapter.js` |
|  | Warehouse import | `js/app-shell/databricks-connect.js` |
|  | Object Space registry (Polyglot Workbench, Batch B) | `js/app-shell/object-space.js` |
|  | Glow Path adaptive next-action rail (Batch A) | `js/app-shell/glow-path.js`, `js/app-shell/glow-path-ui.js` |
|  | The Glow signal aggregator (Batch 1) | `js/glow/glow-signal.js` |
|  | The Glow topbar orb UI (Batch 2) | `js/glow/glow-orb-ui.js` |
| Validation layers | Orchestrator | `js/validation/validation.js` |
|  | Standalone layer modules | `js/validation/categorical-consistency.js`, `js/validation/cross-column-consistency.js`, `js/validation/physiological-plausibility.js`, `js/validation/upper-bound-sanity.js`, `js/validation/missingness-detective.js`, `js/validation/missingness.js`, `js/validation/ncci-ptp-validator.js` |
|  | Source Convergence (Truth Network, Batch 1) | `js/validation/source-convergence.js` |
|  | Source Convergence ingestion adapters (Truth Network, Batch 2) | `js/validation/source-convergence-ingestion.js` |
|  | Source Convergence UI (Truth Network, Batch 3) | `js/validation/source-convergence-ui.js` |
|  | The Crucible: adversarial validator (Batch 1) | `js/validation/crucible-contract.js`, `js/validation/crucible-adversarial-packs.js` |
|  | The Crucible: read-only UI (Batch 2) | `js/validation/crucible-ui.js` |
| Provenance, audit & trust | The Crucible: revert proposals (Batch 3, proposal-only) | `js/provenance/revert-eligibility.js` |
| Validation layers | The Crucible: orchestration glue (additive-only) | `js/validation/crucible-orchestrator.js` |
|  | Reinterpretation & context | `js/validation/domain-physics.js`, `js/validation/expected-range.js` |
|  | Healthcare standards bridge | `js/validation/health-standards.js` |
|  | Domain-pack plugin architecture | `js/packs/extension-points.js`, `js/packs/pack-network-guard.js`, `js/packs/pack-registry.js`, `js/packs/builtin/none.pack.js`, `js/packs/builtin/healthcare.pack.js`, `js/packs/builtin/retail.pack.js`, `js/packs/builtin/finance.pack.js`, `js/packs/builtin/omop.pack.js`, `js/packs/builtin/fhir.pack.js` |
| Anomaly & outlier detection | Detectors | `js/anomaly/isolation-forest.js`, `js/anomaly/ondevice-ml.js`, `js/anomaly/predictive-anomaly.js` |
|  | Baselining & process control | `js/anomaly/entity-baseline.js`, `js/anomaly/spc-control.js` |
|  | Triage | `js/anomaly/active-learning.js` |
| Analysis robustness | Devil's Advocate | `js/analysis-robustness/devils-advocate.js` |
|  | Assumption sensitivity + plain-language robustness verdict | `js/analysis-robustness/robustness-verdict.js` |
| Drift, trend & fingerprinting | Forecasting | `js/drift/drift-forecast.js` |
|  | Trend narration | `js/validation/expected-range.js` |
| Cleaning & fixes | Core cleaning | `js/cleaning/clean.js`, `js/cleaning/fix-confidence.js`, `js/cleaning/materiality.js` |
|  | Targeted transforms | `js/cleaning/imputation.js`, `js/cleaning/format-fingerprint.js`, `js/cleaning/fuzzy-dedup.js`, `js/shared/identifier-columns.js` |
| Grades & health scores | Grades | `js/grades/calibrated-grades.js`, `js/grades/cat-scorecard.js`, `js/grades/golden-signals.js` |
| On-device learning & personalization | Learners | `js/learning/self-learning-rules.js`, `js/learning/adaptive-priority.js`, `js/learning/rule-suggestions.js` |
|  | Shared state | `js/learning/signal-store.js`, `js/learning/memory-store.js` |
|  | Session proficiency signal (Glow Path, Batch B) | `js/learning/proficiency-signal.js` |
| Federated learning | Core & transport | `js/federated/federated-fingerprint.js`, `js/federated/federated-learning.js`, `js/federated/federated-transport.js` |
| DataGlow Rooms | Room signaling / peer discovery (Batch 1 of 4) | `js/rooms/room-signaling.js` |
|  | Object Space broadcast wiring (Batch 2 of 4) | `js/rooms/room-broadcast.js` |
|  | Topbar UI layer (Batch 3 of 4) | `js/rooms/room-ui.js` |
|  | Real signaling + data-channel adapters (Batch 4 of 4) | `js/rooms/room-transport-adapter.js` |
| Data Diplomacy | Claim + seal | `js/diplomacy/diplomacy-claim.js` |
|  | Reconciliation engine | `js/diplomacy/reconciliation-engine.js` |
|  | Two-key approval gate | `js/diplomacy/diplomacy-approval-gate.js` |
| Provenance, audit & trust | Chain of custody | `js/provenance/provenance.js`, `js/provenance/assumption-ledger.js` |
|  | AI Touch Ledger (Batch 1 + Batch 2 — wired into Story Engine + Proof Room, feature-flagged: aiTouchLedger) | `js/provenance/ai-touch-ledger.js`, `js/narrative/story.js`, `js/app-shell/main.js`, `js/provenance/proof-room.js` |
|  | Query Memory (Batch 2 — SQL/Python/R wiring + "seen before" badge) | `js/provenance/query-memory.js`, `js/provenance/query-memory-ui.js` |
|  | Shareable artifacts | `js/provenance/validation-receipt.js`, `js/provenance/selective-disclosure-proof.js`, `js/provenance/irb-mode.js`, `js/provenance/peer-review.js`, `js/provenance/data-bom.js` |
|  | Portable Receipts — per-artifact lineage stamp | `js/provenance/portable-receipt.js` |
|  | Provenance Packet — data blame + de-identification verifier | `js/provenance/data-blame.js`, `js/provenance/deidentification-verifier.js` |
|  | Data Nutrition Label (Trust Passport, Batch 2) | `js/provenance/data-nutrition-label.js` |
|  | Verifiable Check Seal (Trust Passport, Batch 3) | `js/provenance/verifiable-check-seal.js` |
|  | Trust Beam (shareable seal link) | `js/provenance/trust-beam.js` |
|  | Zero-Knowledge Threshold Proof (Batch 1, feature-flagged: zkThresholdProof) — first genuine zero-knowledge proof in DataGlow | `js/provenance/zk-threshold-proof.js` |
|  | Proof Room (Trust Passport, composition batch 1 + AI Touch Ledger step, feature-flagged: aiTouchLedger) | `js/provenance/proof-room.js` |
|  | Provenance Packet (Batch 2) — denial root-cause profiler + cost-of-bad-data quantifier | `js/provenance/denial-root-cause.js`, `js/provenance/cost-of-bad-data.js` |
|  | Analysis fingerprint & nutrition label | `js/provenance/analysis-fingerprint.js`, `js/provenance/nutrition-badges.js` |
|  | Blameless incident postmortem | `js/provenance/incident-postmortem.js` |
|  | Ownership Ledger (DataGlow Passport, Batch D) | `js/provenance/ownership-ledger.js` |
|  | Provenance Packet (Batch 3) — portable signed .dataglow packet format (export/import) | `js/provenance/provenance-packet.js` |
|  | Institutional Memory Layer — decision log, timeline, provenance hash | `js/memory/institutional-memory.js` |
| DataGlow Rooms | Async collaboration via signed findings JSON (Feature 11) | `js/rooms/rooms-builder.js` |
| Provenance, audit & trust | Proof Export — .proof bundle, four-hash integrity chain (Feature 12) | `js/proof/proof-builder.js` |
| Privacy & synthetic data | DP export & synthesis | `js/privacy/privacy-budget.js`, `js/privacy/synthetic-twin.js`, `js/privacy/synthetic-adversarial.js` |
|  | Governed Synthetic Data Passport (Trust Passport, Batch 4) | `js/privacy/synthetic-data-passport.js` |
| Simulation & time travel | What-if & history | `js/simulation/digital-twin.js`, `js/simulation/time-travel-diff.js`, `js/simulation/time-machine.js` |
| Narrative & language models | Story & LLM | `js/narrative/story.js`, `js/narrative/ondevice-llm.js` |
|  | Story View | `js/story/story-builder.js` |
| Ambient & real-time | Live validation | `js/ambient/ambient-validation.worker.js`, `js/ambient/watch-folder.js` |
| App shell & data engine | Grouped tab navigation | `js/app-shell/tab-groups.js` |
|  | Validate tab focus mode | `js/app-shell/validate-focus.js` |
| Ambient & real-time | Semantic drift watchdog | `js/ambient/drift-watchdog.js` |
| Language runtimes & visualization | Runtimes & charts | `js/runtimes-viz/python-runtime.js`, `js/runtimes-viz/r-runtime.js`, `js/runtimes-viz/visualize.js` |
|  | Glow Canvas (multi-chart dashboard, Batch 2: cross-filtering) | `js/runtimes-viz/glow-canvas.js` |
|  | Pivot Table (Batch 1: tap-to-add Rows/Columns/Values wells over real DuckDB PIVOT/GROUP BY SQL) | `js/pivot/pivot-builder.js`, `js/runtimes-viz/pivot-ui.js` |
|  | Drill Floor (SQL/Python/R practice drills; Batch 1: Spot the Sale, Batch 2: cross-language result diff) | `js/drill-floor/drill-floor.js`, `js/drill-floor/drill-floor-data.js`, `js/drill-floor/drill-diff.js` |
|  | Cleaning Crew — Profiler station (PDF text extraction, Batch 1) | `js/cleaning-crew/pdf-profiler.js` |
| Protocol & interoperability | Conformance | `js/protocol/protocol-conformance.js` |
| Problem framing | Problem Framer & Context Card | `js/problem-framing/problem-framer.js` |
| App shell & data engine | Capability registry | `js/app-shell/capability-registry.js` |
|  | Shared metrics registry | `js/app-shell/metrics-registry.js` |
| Export & reporting | Universal export (Excel + PDF) | `js/export/export-report.js`, `js/export/export-delivery.js` |
| Build tooling & feature flags | Build feature flags | `js/build/build-flags.js` |
| Teaching & context | Teach-As-You-Clean micro-lessons | `js/teaching/micro-lessons.js` |
|  | Community domain-pack sharing | `js/teaching/community-pack.js` |
| Conversational pack builder | Data-grounded question generator | `js/agents/question-generator-agent.js` |
|  | "I don't know" resolution engine | `js/agents/uncertainty-resolver-agent.js` |
|  | Local peer-sourced pack index | `js/packs/local-pack-index.js` |
|  | Guided pack builder | `js/agents/pack-builder-agent.js` |
|  | Guided pack builder — Validate-tab UI wiring | `js/agents/conversational-pack-ui.js` |
| Validation layers | Local Analysis Contract | `js/validation/analysis-contract.js` |
|  | Semantic / Metrics Layer | `js/validation/semantic-layer.js`, `js/validation/semantic-layer-ui.js` |
| Meeting scribe | Meeting note grounding agent | `js/agents/meeting-scribe-agent.js` |
|  | Meeting scribe — Meeting-tab UI wiring | `js/agents/meeting-scribe-ui.js` |
|  | Live transcript capture (on-device speech-to-text input) | `js/agents/live-transcript-capture.js` |
|  | Chart-anchored meeting decision ledger (pure logic) | `js/agents/meeting-decision-ledger.js` |
|  | Meeting decision ledger — Meeting-tab browse/save UI wiring | `js/agents/meeting-decision-ledger-ui.js` |
| Trust & metrics (OneCanvas Phase 1) | Metric Studio | `js/metrics/metric-studio.js` |
|  | Trust Strip | `js/trust/trust-strip.js` |
|  | Proof Drawer | `js/trust/proof-drawer.js` |
|  | Metric Contracts (Batch 1: versioned data model) | `js/metrics/metric-contracts.js` |
|  | Metric Contracts (Batch 2: diff view, read-only) | `js/metrics/metric-contract-diff-view.js` |
|  | Metric Contracts (Batch 3: confirm gate) | `js/metrics/metric-contract-confirm-gate.js` |
|  | Metric Contracts (Batch 4: agent-access rules, read gate) | `js/metrics/metric-access-rules.js` |
|  | AI Readiness Gate (pure scoring + UI badge + agent hard-block, batches 1-3 of 4) | `js/gate/readiness-gate.js`, `js/gate/readiness-gate-ui.js`, `js/gate/agent-gate.js` |
| App shell / navigation | Command Deck sidebar nav (Part 1) | `js/app-shell/command-deck-nav.js` |
| Data Diplomacy | Data Diplomacy — two-key panel UI (Batch 2) | `js/diplomacy/diplomacy-ui.js` |
| Provenance, audit & trust | Agent Action Firewall — human-confirmation gate for data mutations | `js/agents/agent-action-firewall.js` |
|  | Guarded Copilot (Batch 2) — read-only, lineage-citing chat core + chat panel UI | `js/agents/guarded-copilot.js` |
| Conversational pack builder | Debate transparency diagnostics | `js/agents/debate-diagnostics.js` |
| App shell / navigation | Command Deck command palette (Part 2) | `js/app-shell/command-palette.js` |
| Open Floor | Open Floor read-only room kernel + PHI prompt guard | `js/agents/open-floor-room.js`, `js/agents/phi-prompt-guard.js` |
|  | Open Floor Sandbox Twin — forkable disposable dataset copy; every mutation & promote firewall-gated | `js/simulation/sandbox-twin.js` |
| Validation layers | Query Sentinel (Batch 1) — deterministic per-query SQL correctness verifier | `js/validation/query-sentinel.js` |
|  | Query Sentinel Assist (Batch 2) — bounded on-device explain & fix-suggest | `js/validation/query-sentinel-assist.js` |
|  | Query Sentinel Bridge (Batch 3, final) — FROM py./r. cross-runtime table resolver | `js/validation/query-sentinel-bridge.js` |
| Analysis robustness | Statistical Rigor Layer (Batch 1) — confidence intervals, effect size, Simpson's-paradox + multiple-comparison checks | `js/rigor/statistical-rigor.js` |
|  | Narrative Overconfidence Guard — verifies generated Story text obeys its own per-claim confidence grades (closes the Stanford HAI sycophancy/overconfidence gap) | `js/rigor/narrative-overconfidence-guard.js` |
| App shell & data engine | DuckDB WASM configuration | `js/app-shell/duckdb-config.js` |
|  | DataGlow Grid bridge (Univer data contract, Tier 1 of DataGlow Canvas) | `js/grid/grid-bridge.js` |
|  | DataGlow Grid pivot engine (Univer pivot tables, builds on the grid bridge) | `js/grid/pivot-engine.js` |
|  | DataGlow Grid formula bridge (Excel formula ↔ DuckDB SQL, documentation/audit layer) | `js/grid/formula-bridge.js` |
|  | DataGlow Grid validation coloring (cell/row-level styling, agent diff overlay) | `js/grid/validation-coloring.js` |
| Enterprise & governance | Enterprise policy engine | `js/build/enterprise-policy.js` |
| AI Council | Multi-model deliberation engine | `js/council/council-engine.js` |
|  | Council tab UI | `js/council/council-ui.js` |
| Data quality & drift | Dataset differ | `js/drift/dataset-differ.js` |
|  | Freshness decay calculator | `js/drift/freshness-decay.js` |
| Data Version Control | Snapshot diff engine | `js/dvc/dvc-diff.js` |
|  | Snapshot store | `js/dvc/dvc-store.js` |
|  | Versions tab UI | `js/dvc/dvc-ui.js` |
| Equity & fairness | Disparity scorer | `js/equity/disparity-scorer.js` |
|  | Equity attestation builder | `js/equity/equity-attestation.js` |
|  | Protected-column detector | `js/equity/equity-detector.js` |
|  | Outcome stratifier | `js/equity/equity-stratifier.js` |
| Join Builder | Visual join canvas | `js/join-builder/join-canvas.js` |
|  | Join model | `js/join-builder/join-model.js` |
|  | Join SQL generator | `js/join-builder/join-sql.js` |
| NL-to-SQL | Metric contract definitions | `js/nl-sql/metric-contracts.js` |
|  | NL-to-SQL engine | `js/nl-sql/nl-sql-engine.js` |
|  | API key store (in-memory) | `js/nl-sql/nl-sql-key-store.js` |
|  | Zero-cost pattern engine | `js/nl-sql/nl-sql-pattern-engine.js` |
|  | AI tab UI | `js/nl-sql/nl-sql-ui.js` |
|  | Schema context serializer | `js/nl-sql/schema-context.js` |
| Relational integrity | Flag consistency checker | `js/relational/flag-consistency-checker.js` |
|  | Foreign key checker | `js/relational/foreign-key-checker.js` |
|  | Join coverage checker | `js/relational/join-coverage-checker.js` |
|  | Temporal order checker | `js/relational/temporal-order-checker.js` |
| Rule packs | General rulepack | `js/rulepacks/packs/general.js` |
|  | Healthcare rulepack | `js/rulepacks/packs/healthcare.js` |
|  | Rulepack registry | `js/rulepacks/rulepack-registry.js` |
| Trust & provenance | Trust certificate builder | `js/trust/trust-certificate.js` |
| Validation layers | DRG/ICD coding validator | `js/validation/drg-icd-validator.js` |
| Warehouse connectors | BigQuery connector | `js/warehouse/bigquery-connector.js` |
|  | S3 connector | `js/warehouse/s3-connector.js` |
| MCP (Model Context Protocol) interface | MCP server | `js/mcp/dataglow-mcp-server.mjs` |
|  | Gate state exporter | `js/mcp/gate-state-exporter.js` |
|  | Agent Passport Bridge (get_agent_passport tool) | `js/mcp/dataglow-mcp-server.mjs`, `js/mcp/gate-state-exporter.js` |
| Polyglot Workbench | Cross-language schema-aware autocomplete (engine + Analyze SQL canvas wire) | `js/polyglot/polyglot-autocomplete.js`, `js/intelligence/data-glow-sql-autocomplete-canvas.js` |
|  | Cross-language error advisor with suggested fix | `js/polyglot/polyglot-error-advisor.js` |
| Data Diplomacy | Real dataset claim builder (Batch 3) | `js/diplomacy/diplomacy-loader.js` |
|  | Sealed claim P2P exchange adapter (Batch 4) | `js/diplomacy/diplomacy-p2p-transport.js` |
| Meeting Scribe | Live Rooms action-item broadcast (Batch 2) | `js/agents/live-rooms-broadcast.js` |
|  | Chart-context timeline (Batch 3) | `js/agents/chart-context-timeline.js` |
|  | Meeting synthesis (Batch 4) | `js/agents/meeting-synthesis.js` |
| Ambient & real-time | Streaming validator (micro-batch drift core) | `js/streaming/streaming-validator.js` |
|  | Validation Webhook Mode | `js/webhook/webhook-handler.js`, `js/webhook/service-worker-relay.js` |
| Universal ingestion & RAG (wave 2) | Universal Drop Zone router | `js/drop-zone/drop-zone-router.js` |
|  | RAG core (chunker, cosine similarity, retrieval) | `js/rag/rag-core.js` |
|  | RAG validation bridge (citation injection) | `js/rag/rag-validation-bridge.js` |
|  | User Knowledge Store (in-memory RAG index) | `js/rag/user-knowledge-store.js` |
|  | Audio ingestion structurer (Whisper → structured transcript dataset) | `js/audio/audio-structurer.js`, `js/audio/whisper-worker.scaffold.js` |
|  | Video ingestion bridge (audio-only, Batch 1) | `js/video/video-ingestion-bridge.js`, `js/video/webcodecs-audio-extractor.scaffold.js` |
|  | PDF ingestion bridge (PDF.js → RAG pipeline) | `js/pdf/pdf-ingestion-bridge.js`, `js/pdf/pdfjs-extractor.scaffold.js` |
|  | Text / Log line parser — .txt and .log to queryable rows | `js/ingestion/text-line-parser.js` |
|  | Semi-structured JSON flattener — nested JSON, FHIR bundles, API envelopes | `js/ingestion/json-flattener.js` |
|  | Live API / Webhook feed — REST endpoint fetch with polling, auto-normalization | `js/ingestion/api-feed.js` |
| Ambient & real-time | NATS WebSocket Bridge | `js/nats/nats-message-parser.js`, `js/nats/nats-bridge.js` |
|  | Tauri Live Connector Layer | `js/connectors/tauri-connector.js`, `js/connectors/connector-manager.js` |
| Narrative & storytelling | Portfolio Narrative assembler (stitches Problem Framer + Story + Clean summary + recommendation into one exportable write-up) | `js/portfolio/narrative-assembler.js`, `js/portfolio/portfolio-ui.js` |
|  | Question Prompter (Feature 13 — "Where to start" intelligence) | `js/questions/question-prompter.js` |
| Universal ingestion & RAG (wave 2) | Image OCR — Tesseract.js client-side text extraction from PNG/JPG/WEBP/BMP/GIF | `js/ingestion/image-ocr.js` |
| Insight & discovery | Instant Insight (PR AF — surfaces the single most interesting statistical finding on file load, zero LLM, pure heuristics) | `js/insight/insight-engine.js` |
| Sharing & collaboration | Publish Button (PR AG — one-click shareable snapshot URL, client-side gzip + base64url encoding, zero server upload) | `js/publish/publish-engine.js` |
| Visualization | Chart Layer (PR AI — auto bar/histogram/donut/line charts from any dataset, Canvas 2D, zero dependencies) | `js/chart/chart-engine.js` |
| Sharing & collaboration | Export Everything (PR AJ — CSV, chart PNG, PDF report, all client-side, zero server, zero uploads) | `js/export/export-engine.js` |
| Data grid & editing | Smart Column Editor (PR AK — inline rename, type cycle, add column with formula, clean-name suggestions) | `js/columns/column-editor.js` |
|  | Multi-file Join Builder (PR AL — auto key suggestion, INNER/LEFT/RIGHT/FULL joins, live preview) | `js/join/join-builder.js` |
| Validation & data quality | Anomaly Timeline (PR AM — spike/drop/gap/duplicate/shift detection in the validation rail) | `js/anomaly/anomaly-timeline.js` |
| Visualization | Dashboard View (PR AN — readiness-gated KPI cards + bar/line charts, RAG-colored, research-grounded layout rules) | `js/dashboard/dashboard-engine.js` |
| Data grid & editing | High-Performance Canvas Grid (PR AO — pure Canvas renderer, virtual scrolling, 1M+ rows at 60fps, zero DOM nodes per cell) | `js/grid/canvas-grid.js` |
| Validation & data quality | Findings Rail (PR AU — ranked, plain-English insight cards above the dashboard KPI row) | `js/dashboard/findings-rail.js` |
| Query & analysis | Natural Language to Everything (PR AH — plain-English questions answered via deterministic keyword-pattern query logic, zero LLM) | `js/nl/nl-engine.js` |
|  | Real SQL Engine (PR AO — SQL Mode overlay powered by real DuckDB-WASM execution, autocomplete, query history, schema sidebar) | `js/sql/sql-engine.js` |
| Universal ingestion & RAG (wave 2) | X12 EDI Parser -- 835 ERA / 837 Claims ingestion | `js/ingestion/x12-parser.js` |
| Enterprise & deployment | Enterprise No-Egress Mode | `js/build/enterprise-policy.js` |
| Data grid & editing | Column profiler on hover (local stats tip on grid headers + DataLens deep link) | `js/intelligence/column-profiler-local.js`, `js/intelligence/data-glow-column-profiler-hover-canvas.js`, `js/grid/canvas-grid.js` |
| Privacy & trust | PHI Shield | `js/agents/phi-prompt-guard.js`, `js/provenance/deidentification-verifier.js`, `js/intelligence/data-glow-phi-shield-canvas.js`, `test/phi-shield-scan.test.mjs` |
| Data preparation | Excel Hell Repair | `js/intelligence/excel-hell-repair.js`, `js/intelligence/data-glow-excel-hell-canvas.js`, `test/excel-hell-repair.test.mjs` |
| Multi-runtime | Python Notebooks-lite | `js/intelligence/python-notebook-lite.js`, `js/intelligence/data-glow-python-notebook-canvas.js`, `test/python-notebook-lite.test.mjs` |
| Data preparation | Guided Unpivot | `js/intelligence/guided-unpivot.js`, `js/intelligence/data-glow-guided-unpivot-canvas.js`, `test/guided-unpivot.test.mjs` |
|  | Repair Recipe Library | `js/intelligence/repair-recipe-library.js`, `js/intelligence/repair-recipe-store.js`, `js/intelligence/data-glow-repair-recipe-library-canvas.js`, `test/repair-recipe-library.test.mjs` |

_202 capabilities across 53 areas, generated from `capability-map.manifest.json` — the same file the capability-map drift gate validates. Do not edit by hand; run `npm run docs:dashboard`._
<!-- CAPABILITY_TABLE_END -->

## Known Simplifications

- Denial Radar-style column matching is heuristic, not real EDI 835/837 parsing
- Story tab needs a user-supplied API key (Perplexity, Claude, Gemini, or OpenAI) for real AI-generated narratives; otherwise it transparently falls back to a rule-based summary and labels itself as such

## Author

**Andre Weissmann** — Data Analyst

[![GitHub](https://img.shields.io/badge/GitHub-Andre--Weissmann-181717?style=flat&logo=github)](https://github.com/Andre-Weissmann)

## License

MIT License — see [LICENSE](LICENSE). Provided AS-IS, without warranty of any kind. Third-party library licenses and academic citations for all statistical/ML techniques are listed in the LICENSE file and in the app's Settings → About & Attributions panel.

## Status

🟢 Actively building. See [docs/CHANGELOG.md](docs/CHANGELOG.md) for the latest shipped changes.

*DATAGLOW — because your data deserves to shine.*
