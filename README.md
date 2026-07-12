# DATAGLOW

> **Your data, glowing.** A universal, browser-based, all-in-one data analytics platform — no install, no server, no upload.

📋 **New here?** See [TRUST.md](TRUST.md) for a first-party, verifiable look at this repo's health, how it's built to work with AI coding agents, and a curated "Start Here" list of good first contributions.

---

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
|  | Warehouse import | `js/app-shell/databricks-connect.js` |
| Validation layers | Orchestrator | `js/validation/validation.js` |
|  | Standalone layer modules | `js/validation/categorical-consistency.js`, `js/validation/cross-column-consistency.js`, `js/validation/physiological-plausibility.js`, `js/validation/upper-bound-sanity.js`, `js/validation/missingness-detective.js`, `js/validation/missingness.js` |
|  | Reinterpretation & context | `js/validation/domain-physics.js`, `js/validation/expected-range.js` |
| Anomaly & outlier detection | Detectors | `js/anomaly/isolation-forest.js`, `js/anomaly/ondevice-ml.js`, `js/anomaly/predictive-anomaly.js` |
|  | Baselining & process control | `js/anomaly/entity-baseline.js`, `js/anomaly/spc-control.js` |
|  | Triage | `js/anomaly/active-learning.js` |
| Analysis robustness | Devil's Advocate | `js/analysis-robustness/devils-advocate.js` |
| Drift, trend & fingerprinting | Forecasting | `js/drift/drift-forecast.js` |
|  | Trend narration | `js/validation/expected-range.js` |
| Cleaning & fixes | Core cleaning | `js/cleaning/clean.js`, `js/cleaning/fix-confidence.js`, `js/cleaning/materiality.js` |
|  | Targeted transforms | `js/cleaning/imputation.js`, `js/cleaning/format-fingerprint.js`, `js/cleaning/fuzzy-dedup.js` |
| Grades & health scores | Grades | `js/grades/calibrated-grades.js`, `js/grades/cat-scorecard.js`, `js/grades/golden-signals.js` |
| On-device learning & personalization | Learners | `js/learning/self-learning-rules.js`, `js/learning/adaptive-priority.js`, `js/learning/rule-suggestions.js` |
|  | Shared state | `js/learning/signal-store.js`, `js/learning/memory-store.js` |
| Federated learning | Core & transport | `js/federated/federated-fingerprint.js`, `js/federated/federated-learning.js`, `js/federated/federated-transport.js` |
| Provenance, audit & trust | Chain of custody | `js/provenance/provenance.js`, `js/provenance/assumption-ledger.js` |
|  | Shareable artifacts | `js/provenance/validation-receipt.js`, `js/provenance/selective-disclosure-proof.js`, `js/provenance/irb-mode.js`, `js/provenance/peer-review.js` |
| Privacy & synthetic data | DP export & synthesis | `js/privacy/privacy-budget.js`, `js/privacy/synthetic-twin.js`, `js/privacy/synthetic-adversarial.js` |
| Simulation & time travel | What-if & history | `js/simulation/digital-twin.js`, `js/simulation/time-travel-diff.js`, `js/simulation/time-machine.js` |
| Narrative & language models | Story & LLM | `js/narrative/story.js`, `js/narrative/ondevice-llm.js` |
| Ambient & real-time | Live validation | `js/ambient/ambient-validation.worker.js`, `js/ambient/watch-folder.js` |
| Language runtimes & visualization | Runtimes & charts | `js/runtimes-viz/python-runtime.js`, `js/runtimes-viz/r-runtime.js`, `js/runtimes-viz/visualize.js` |
| Protocol & interoperability | Conformance | `js/protocol/protocol-conformance.js` |
| Problem framing | Problem Framer & Context Card | `js/problem-framing/problem-framer.js` |
| App shell & data engine | Capability registry | `js/app-shell/capability-registry.js` |
| Export & reporting | Universal export (Excel + PDF) | `js/export/export-report.js`, `js/export/export-delivery.js` |
| Build tooling & feature flags | Build feature flags | `js/build/build-flags.js` |
| Teaching & context | Teach-As-You-Clean micro-lessons | `js/teaching/micro-lessons.js` |
|  | Community domain-pack sharing | `js/teaching/community-pack.js` |

_34 capabilities across 20 areas, generated from `capability-map.manifest.json` — the same file the capability-map drift gate validates. Do not edit by hand; run `npm run docs:dashboard`._
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
