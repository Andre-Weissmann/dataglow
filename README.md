# DATAGLOW

> **Your data, glowing.** A universal, browser-based, all-in-one data analytics platform — no install, no server, no upload.

---

## What is DATAGLOW?

DATAGLOW is a personal data cleaning, validation, and analysis workbench that runs entirely in your browser. Upload a file and move through preflight checks, SQL querying, automated cleaning, a 20-layer data validation suite, drag-and-drop visualization, AI-assisted narrative summaries, and even live Python / R / structural-Swift notebooks — all client-side.

Everything runs on WebAssembly and vanilla JS. Your data never leaves your machine.

## Features

- **Preflight** — instant data quality checklist the moment a file loads
- **SQL** — query any loaded table with a DuckDB-WASM engine and autocomplete
- **Clean** — automated cleaning (duplicates, nulls, formatting) with a full audit trail of every change made
- **Validate** — 20 independent validation layers (schema, nulls, duplicates, outliers, Benford's Law, semantic drift, cross-column logic, distributional drift, physiological plausibility, missingness classification, confidence scoring with anomaly-concentration detection, unit tests, and more)
- **Visualize** — drag-and-drop chart builder powered by Plotly
- **Story** — AI-generated plain-language narrative summaries of your dataset, with three interchangeable engines you pick in Settings: (1) **In-browser AI** (default, recommended) runs a small open-weight language model — **Qwen2.5-1.5B-Instruct**, 4-bit quantized (~1.1 GB), Apache-2.0 licensed — **100% on your device via WebGPU/WebLLM**, so no API key is needed and your data never leaves the browser; the weights download once and are cached for offline reuse. (2) **Bring your own API key** (Perplexity, Claude, Gemini, OpenAI). (3) An honest **rule-based** offline summary with no AI. The in-browser option needs a WebGPU-capable browser (recent Chrome, Edge, or Chrome on Android; Safari 18+) and gracefully falls back to the rule-based summary where WebGPU is unavailable
- **Python** — in-browser notebook via Pyodide
- **R** — in-browser notebook via WebR
- **Swift** — structural SwiftUI-syntax preview (renders Text/VStack/HStack/Button/Divider live); full SwiftWasm compilation is planned for a future generation
- **Red Team Mode** — a built-in self-test that runs a golden dataset with known injected defects (nulls, negatives, an outlier, duplicate rows) through every validation layer and checks that DATAGLOW actually catches them
- **Predictive Anomaly Scoring** — an on-device, unsupervised outlier detector that learns the "normal shape" of the *currently-loaded* dataset and flags whole rows whose *combination* of values is unusual — the holistic, multi-column anomalies that single-column rules and the numeric-only Multivariate Outliers panel can miss (e.g. a 15-year-old with a retirement account, where neither value is individually out of range). The technique is a **k-nearest-neighbours distance outlier score** (Ramaswamy et al. 2000) over **Gower distance** (Gower 1971), which lets it mix *numeric and categorical* columns on one scale. Every flag is explainable: because Gower distance is an average of per-feature terms, each row's score decomposes additively across features, so the panel shows which features drove the flag in plain language. It is fit to *this* dataset's own distribution per-session (RAM only) — not a general AI, not a cross-session learned model, and **not one of the 20 validation layers** but a separate, complementary capability. Unusual is not the same as wrong: a flag may be a legitimate rare case. For performance the O(n²) neighbour search is capped (default 2,000 rows) with uniform random sampling above the cap, clearly disclosed in the UI.
- **Self-Learning Validation Rules** — learns from *your own* corrections (applying/rejecting a suggested merge, dismissing a validation flag) and re-ranks flags so the ones you're most likely to care about surface first, with a plain-language "why". It is a simple, transparent, on-device **logistic-regression** model — not a neural network or general-purpose AI — that starts knowing nothing until you've made at least 10 corrections. Only labeled examples of your corrections (which check fired, the column type, accept/dismiss) are recorded — **never your raw cell values** — and nothing ever leaves your browser. Per-session learning is on by default (RAM only, wiped on reload); remembering it across sessions in IndexedDB is a separate opt-in, and a one-click **"Clear my learned corrections"** wipes it. It only ranks and highlights — it never auto-edits your data.
- **Federated Fingerprint Learning** *(opt-in, OFF by default)* — collaboratively improves the shared column-fingerprint/pattern model across users **without any of your data ever leaving your browser**. Each opted-in browser trains a tiny local model on its own validation-session signals and shares **only privacy-protected weight *updates*** — never raw rows, never cell values. Three privacy layers stack: (1) **secure aggregation via pairwise masking** (Bonawitz et al. 2017), where equal-and-opposite masks cancel in the sum so no single peer's update is ever seen in the clear; (2) a **differential-privacy Gaussian mechanism** (Dwork & Roth 2014; DP-SGD clip-then-noise, Abadi et al. 2016) with a tunable ε you control in Settings; and (3) a **minimum-cohort threshold** so an update is never aggregated or applied from fewer than the minimum number of peers per round. Peers find each other through a scheduled GitHub Action that publishes a short-lived, auto-expiring "phone book" of WebRTC signaling offers on a dedicated coordination branch — **GitHub only bootstraps signaling and never sees any weights or data**. The real weight exchange happens **peer-to-peer over WebRTC**, gossiped (Boyd et al. 2006; Lian et al. 2017 D-PSGD) to a few random reachable peers, with a masked-commit relay fallback so it still works with only one or two users. Federated averaging (**FedAvg**, McMahan et al. 2017) combines the updates, and every contribution produces a hash-chained receipt reusing the app's selective-disclosure provenance pattern. If WebRTC is unsupported, no peers are reachable, GitHub is unreachable, or you're offline, it **degrades silently to purely local behavior with zero errors**. One click clears all local federated state.

### Supported file formats (Tier 1)

CSV, TSV, JSON, NDJSON, Parquet, Excel (.xlsx/.xls)

Additional formats (ORC, Avro, HDF5, Delta Lake, FHIR, DICOM, EDI, PDF tables, Google Sheets, SAS/SPSS/Stata, SQLite) are on the roadmap.

## Built With

- Vanilla HTML / CSS / JavaScript (no bundler, no build step)
- [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) for in-browser SQL
- [Pyodide](https://pyodide.org/) for in-browser Python
- [WebR](https://webr.r-wasm.org/) for in-browser R
- [WebLLM](https://github.com/mlc-ai/web-llm) (Apache-2.0) for the in-browser Story model — running [Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) (Apache-2.0), lazy-loaded from WebLLM's prebuilt model registry and cached in-browser
- [Plotly.js](https://plotly.com/javascript/) for visualization
- [SheetJS (xlsx)](https://sheetjs.com/) for Excel parsing

## Project Structure

```
dataglow/
├── index.html
├── css/
│   ├── base.css
│   └── app.css
├── js/
│   ├── main.js            # app shell, tab routing, UI wiring
│   ├── state.js            # shared app state
│   ├── duckdb-engine.js     # DuckDB-WASM setup + query helpers
│   ├── loaders.js           # file format loaders
│   ├── clean.js             # automated cleaning + audit trail
│   ├── validation.js        # 20-layer validation suite + Red Team self-test
│   ├── self-learning-rules.js # on-device logistic-regression learner (personalizes flag ranking)
│   ├── predictive-anomaly.js  # holistic kNN/Gower unsupervised row-level anomaly score
│   ├── visualize.js         # chart builder
│   ├── story.js             # AI narrative generation (pluggable providers)
│   ├── python-runtime.js    # Pyodide notebook
│   ├── r-runtime.js         # WebR notebook
│   ├── swift-preview.js     # structural Swift preview
│   └── utils.js
├── assets/
│   ├── logo.svg
│   ├── favicon.svg
│   └── legacy/              # original concept art from early planning
└── docs/
    └── DATAGLOW_VISION.md   # original Gen 7 vision document
```

## Known Simplifications

- Swift tab is a structural-syntax preview only, not full SwiftWasm compilation
- Denial Radar-style column matching is heuristic, not real EDI 835/837 parsing
- Story tab needs a user-supplied API key (Perplexity, Claude, Gemini, or OpenAI) for real AI-generated narratives; otherwise it transparently falls back to a rule-based summary and labels itself as such

## Author

**Andre Weissmann** — Data Analyst

[![GitHub](https://img.shields.io/badge/GitHub-Andre--Weissmann-181717?style=flat&logo=github)](https://github.com/Andre-Weissmann)

## License

MIT License — see [LICENSE](LICENSE). Provided AS-IS, without warranty of any kind. Third-party library licenses and academic citations for all statistical/ML techniques are listed in the LICENSE file and in the app's Settings → About & Attributions panel.

## Status

🟢 Actively building — Gen 7.

*DATAGLOW — because your data deserves to shine.*
