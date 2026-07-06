# DATAGLOW

> **Your data, glowing.** A universal, browser-based, all-in-one data analytics platform — no install, no server, no upload.

---

## What is DATAGLOW?

DATAGLOW is a personal data cleaning, validation, and analysis workbench that runs entirely in your browser. Upload a file and move through preflight checks, SQL querying, automated cleaning, a 15-layer data validation suite, drag-and-drop visualization, AI-assisted narrative summaries, and even live Python / R / structural-Swift notebooks — all client-side.

Everything runs on WebAssembly and vanilla JS. Your data never leaves your machine.

## Features

- **Preflight** — instant data quality checklist the moment a file loads
- **SQL** — query any loaded table with a DuckDB-WASM engine and autocomplete
- **Clean** — automated cleaning (duplicates, nulls, formatting) with a full audit trail of every change made
- **Validate** — 15 independent validation layers (schema, nulls, duplicates, outliers, Benford's Law, semantic drift, confidence scoring with anomaly-concentration detection, unit tests, and more)
- **Visualize** — drag-and-drop chart builder powered by Plotly
- **Story** — AI-generated plain-language narrative summaries of your dataset. Uses Perplexity by default; Claude, Gemini, and other providers can be attached in Settings. Falls back to an honest rule-based summary when no API key is configured
- **Python** — in-browser notebook via Pyodide
- **R** — in-browser notebook via WebR
- **Swift** — structural SwiftUI-syntax preview (renders Text/VStack/HStack/Button/Divider live); full SwiftWasm compilation is planned for a future generation
- **Red Team Mode** — a built-in self-test that runs a golden dataset with known injected defects (nulls, negatives, an outlier, duplicate rows) through every validation layer and checks that DATAGLOW actually catches them

### Supported file formats (Tier 1)

CSV, TSV, JSON, NDJSON, Parquet, Excel (.xlsx/.xls)

Additional formats (ORC, Avro, HDF5, Delta Lake, FHIR, DICOM, EDI, PDF tables, Google Sheets, SAS/SPSS/Stata, SQLite) are on the roadmap.

## Built With

- Vanilla HTML / CSS / JavaScript (no bundler, no build step)
- [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) for in-browser SQL
- [Pyodide](https://pyodide.org/) for in-browser Python
- [WebR](https://webr.r-wasm.org/) for in-browser R
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
│   ├── validation.js        # 15-layer validation suite + Red Team self-test
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
