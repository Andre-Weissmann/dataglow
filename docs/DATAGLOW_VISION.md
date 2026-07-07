# 🌟 DATAGLOW — Complete Vision & Build Document
### Created: July 5, 2026 | Author: Andre Weissmann | Version: Gen 7

> *"Your data, glowing."*
> Built on the philosophy of Steve Jobs: liberal arts + technology, enriching people's lives.

---

## 🏷️ PROJECT IDENTITY

| Field | Detail |
|---|---|
| **Name** | DATAGLOW |
| **Former Name** | Facet (Gen 1–6) |
| **Tagline** | "Your data, glowing." |
| **Author** | Andre Weissmann — Healthcare Data Analyst |
| **GitHub** | https://github.com/Andre-Weissmann/dataglow |
| **Portfolio** | https://mavenshowcase.com/profile/88519300-6041-70e8-e082-36627c4c2bdc |
| **Status** | Gen 7 — In Development |
| **Started** | July 4–5, 2026 |

---

## 🎨 BRAND IDENTITY

### Logo
- **Design**: "data" in charcoal Poppins SemiBold + "glow" in warm electric coral/red
- **Spark**: Small starburst accent above the letter G in "glow"
- **Style**: Charcoal + coral — warm, approachable, modern
- **Background**: White (transparent PNG for GitHub/app use)
- **Feel**: Like Canva's cousin — friendly, startup-energy, globally recognizable

### Color Palette
| Color | Hex | Use |
|---|---|---|
| Charcoal | #2D2D2D | Primary text, "data" wordmark |
| Coral Glow | #FF6B6B | "glow" wordmark, accents, CTAs |
| White | #FFFFFF | Background |
| Teal | #0A7E8C | Grade A confidence, success |
| Blue | #4A90D9 | Grade B confidence |
| Amber | #F5A623 | Grade C confidence, warnings |
| Red | #E74C3C | Grade D confidence, errors |
| Navy | #0D1B2A | Dark mode background |

### Typography
- **Primary**: Poppins SemiBold (Google Fonts — free)
- **Secondary**: Montserrat Bold
- **Body**: Inter Regular

### Name History (rejected names)
Veris, CERNO, AEVON, PARIO, Nova, Atlas, Spark, Flint, Slate, Ripple, Jolt, Trovio, Datello, Clariva, Vivelo, Lumevo, Bravio, Klarivo, Datasol, Flowra, Veravio, Datify, Nexivo, Velora, Solara, Pulsara, Datrix, Clayon, Lumero, Brightive, Veraday, Truvelo, Solvara, Lumyra, Trendlo, Clarvio, Datavly, Vydera, Trovara, Claruna, Datasyn, Lumvio, Zephdata, Clarivo, Datova, Lumari, Solvari, Veranta, Solvelo, Verano, Clarifi, Truvari, Lumana, Datelo, Solvana, Verivio, Brightara, Trovana, Veluma, Solvivo, Datatrue, Lumoven, Verado, Clarivex, Velari, Lumvia, Datavi, Claravi, Truvenow, Verilink, Dataglow ✅ CHOSEN

---

## 🎯 WHAT DATAGLOW IS

A **universal, all-in-one, browser-based data analytics platform** built to replace the entire modern data stack for a single analyst — with a clear path to team distribution.

### What It Replaces

| Old Tool | DATAGLOW Replacement |
|---|---|
| SQL editors (DBeaver, DataGrip) | In-browser DuckDB SQL engine |
| Excel / Google Sheets | In-browser data cleaning tab |
| Python notebooks (Jupyter) | Pyodide Python 3.12 in browser |
| R (RStudio) | WebR 4.4 in browser |
| Power BI / Tableau | Built-in Plotly visualization |
| Manual QA processes | 13 automated validation layers |
| Data storytelling decks | AI-powered Story tab |
| Xcode (iOS dev) | SwiftWasm browser tab |

### Distribution Roadmap
- **Phase 1 (Now)**: Personal tool — one analyst, one browser, no accounts needed
- **Phase 2**: Shareable workspaces — teammates open same URL, see same dashboards
- **Phase 3**: Role-based access — analyst, viewer, admin (like Hex or Deepnote)
- **Phase 4**: Org-wide deployment — hospitals, clinics, small businesses get their own DATAGLOW instance

---

## ⚙️ CORE TECHNICAL ENGINE

### Primary Database Engine
- **DuckDB-WASM v1.5.4** — runs entirely in the browser
- Zero server required, zero uploads, zero latency
- Handles large files — tested against MIMIC-IV scale (300M+ rows with chunking)
- Zero installation — open a browser, it works

### Language Engines
| Engine | Version | Status |
|---|---|---|
| DuckDB-WASM | v1.5.4 | ✅ Live (Gen 6) |
| Pyodide (Python) | 3.12 | 🔨 Gen 7 |
| WebR | 4.4 | 🔨 Gen 7 |
| SwiftWasm | Swift 6.3.3 | 🔨 Gen 7 |

### Python Libraries to Bundle (Pyodide)
| Library | Purpose | Priority |
|---|---|---|
| Pandas 3.0 | Core dataframe engine | Essential |
| Polars | Fast large-dataset alternative | Essential |
| PyArrow | File format bridge | Essential |
| NumPy | Numerical computing | Essential |
| Scikit-learn | ML models | High |
| Plotly | Visualization | High |
| Pandera | Statistical data validation | High |
| SciPy | Statistical tests | High |
| Statsmodels | Regression, time series | Medium |
| NLTK / spaCy | Text/NLP for data stories | Medium |
| Faker | Synthetic test data generation | Medium |

---

## 📂 COMPLETE FILE FORMAT SUPPORT

### Tier 1 — DuckDB-WASM Native (Build Now)
- CSV / TSV
- JSON / NDJSON
- Parquet (columnar — handles MIMIC-IV scale)
- Apache Arrow / Feather / IPC
- Excel (.xlsx, .xls)
- SQLite

### Tier 2 — PyArrow/Pyodide (Gen 7)
- ORC (Hadoop/Hive ecosystems — read-only)
- Avro / FastAvro (Kafka/healthcare streaming)
- HDF5 / H5 (scientific data)
- Delta Lake (open table format)
- Apache Iceberg (data lakehouse)
- MessagePack (compact binary)

### Tier 3 — Healthcare-Specific (Gen 7)
- HL7 FHIR (JSON/XML — healthcare APIs)
- DICOM metadata (medical imaging headers)
- Fixed-width flat files (legacy hospital mainframe systems)
- EDI 837/835 (insurance claims — feeds Denial Radar)
- CCD/CDA (clinical document architecture)

### Tier 4 — Power Features (Gen 8+)
- PDF tables (via pdf-parse or Camelot)
- Google Sheets (live API connection)
- GeoParquet / Spatial Parquet (geographic health data)
- Zarr (genomics/scientific arrays)
- MATLAB .mat files
- SAS .sas7bdat (pharma/clinical trials)
- SPSS .sav (academic health research)
- Stata .dta (epidemiology)
- R .rds / .rdata files

---

## 🖥️ TABS — COMPLETE LAYOUT

All tabs are **draggable and reorderable** by the user.

| # | Tab | Description |
|---|---|---|
| 1 | **Preflight** ✅ | Pre-analysis data quality checklist — runs before any query |
| 2 | **SQL** ✅ | DuckDB query engine with autocomplete and syntax highlighting |
| 3 | **Python** 🔨 | Pyodide Python 3.12 — full notebook experience in browser |
| 4 | **R** 🔨 | WebR 4.4 — tidyverse, ggplot2, dplyr in browser |
| 5 | **Clean** ✅ | Automated data cleaning with full audit trail |
| 6 | **Validate** ✅ | All 18 validation layers (see below) |
| 7 | **Visualize** ✅ | Plotly charts, drag-and-drop builder |
| 8 | **Story** ✅ | AI narrative generation from query results |
| 9 | **Swift** 🔨 | SwiftWasm — write Swift, preview iOS app layouts in browser |

---

## 🛡️ THE 18 VALIDATION LAYERS — DATAGLOW'S HEARTBEAT

*"The features nobody else has."*

### Live (Gen 6)
1. **Sanity Anchor** — Runs the same GROUP BY query two independent ways and auto-compares. Catches calculation errors before they reach a presentation.
2. **Historical Drift Detector** — Remembers query results and flags when numbers change between runs.
3. **Unit Test Layer** — Silently runs 5 tests on every result: negative amounts, future dates, blank keys, duplicates, referential integrity.
4. **Confidence Layer** — 0–100 score with color-coded grade ring (A=teal, B=blue, C=amber, D=red). Five signals: sample coverage, null rate, statistical variance, subsample stability, sample size. Verdict: "Ready to present" or "Dig deeper first."
5. **Denial Radar** — Healthcare-specific. Flags claim denial patterns. Requires EDI 835/837 support.

### New in Gen 7
6. **Schema Fingerprint** — Cryptographic hash of dataset schema on every load. If a column is renamed, removed, or retyped — flagged immediately before any query runs.
7. **Semantic Drift Detector** — Checks if column names match their values. Column called "age" with values over 130 = flagged. Column called "gender" with 47 unique values = flagged.
8. **Correlation Watchdog** — Tracks key metric correlations over time. If readmission_rate and length_of_stay suddenly decorrelate — raises a flag. Real relationships don't break randomly.
9. **Narrative Consistency Checker** — After you write a data story, DATAGLOW reads your text and cross-checks every number against actual query results. "You wrote 42% but the query says 38%."
10. **Freshness Meter** — Timestamps every dataset load. Visible staleness badge if data is older than a configurable threshold. Simple. Obvious. Nobody does this.
11. **Blind Spot Scanner** — After every analysis, prompts: "What data do you NOT have that would change this conclusion?" Forces the analyst to think about missing populations, excluded ranges, unrepresented groups.
12. **Reproducibility Badge** — Runs same query 10 times. If results are identical every time on static data — green badge. If they vary — red flag.
13. **Outlier Detection (MAD + IQR)** — Flags high AND low outliers via the modified z-score (Iglewicz & Hoaglin 1993) and Tukey's IQR fences (Tukey 1977). Catches large positives, not just negatives.
14. **Benford's Law Check** — Compares leading-digit distribution to the Newcomb-Benford expectation (Newcomb 1881; Benford 1938). A **Statistical Test Eligibility Gate** runs first: Benford is only applied to naturally-scaled magnitudes that span multiple orders of magnitude (revenue, transaction amounts, population). Bounded columns (Age, ratings 1–5, credit scores) are **skipped with a one-line explanation** — e.g. "Age skipped — bounded range, not a naturally-scaled magnitude Benford's Law applies to" — rather than silently omitted.

### New in this release
15. **Categorical Consistency Engine** — For each text column, clusters near-identical spellings using published string-similarity algorithms (Levenshtein 1965 edit distance and Jaro-Winkler 1990) plus a small ISO-3166 country/state abbreviation lookup. Recognises that "France" / "FRA" / "French" are one category, proposes the most frequent variant as the canonical form, and offers a one-click merge that reuses the Clean tab's dedup mechanism.
16. **Cross-Column Logical Consistency Checker** — Detects impossible combinations across column pairs/groups via DuckDB SQL: end-before-start date ranges, discharge-before-admit, inverted numeric min/max ranges, and adult-only status on minors (age < 18 with a retirement/pension flag set true). Column pairing is heuristic keyword matching on names — never hardcoded to one dataset.
17. **Distributional Fingerprint Drift** — Sibling to the Schema Fingerprint layer. On each load it records a per-column distribution fingerprint (mean/std/skewness for numeric, top-5 value frequencies for categorical) keyed by the schema hash. On a later load of the *same* schema it flags significant drift (mean shift > 2σ, or a change in the categorical top-5 composition) — catching data that moved even though the shape did not.
18. **Red Team Mode** — Loads a built-in intentionally broken dataset. All 17 preceding layers must catch their respective issues. If any miss — the feature is broken. NASA-style self-attack testing.

### The Assumption Ledger
Cutting across every layer above (and the Clean tab), the **Assumption Ledger** is a running, exportable, plain-language log of every judgment call DATAGLOW makes: "Proposed merging 'FRA' → 'France'", "Skipped Benford's Law on Age (bounded column)", "Flagged 2 rows where discharge_date precedes admit_date", "Detected drift on same-schema reload". Each of the automated features above emits a ledger entry whenever it takes an action or makes a skip/gating decision. The ledger is a first-class panel in the Validate tab and exports as text, Markdown, or JSON — so nothing is ever assumed silently on the analyst's behalf.

---

## 🧪 GEN 8 — TRUST & ADVERSARIAL SUITE (This Release)

Six features that turn DATAGLOW from a validator into an *adversary of its own conclusions* — every headline is stress-tested, every transformation is cryptographically logged, and every claim carries its own confidence.

### 1. Devil's Advocate Mode ("Attack My Analysis")
A one-click adversarial second pass over the current SQL result (`js/devils-advocate.js`). It runs three published robustness checks against the headline metric and returns a plain-English "robust" / "sensitive to X" verdict, logged to the Assumption Ledger:
- **Bootstrap resampling** (Efron 1979) — 500 resamples of the metric column; robust if the 95% percentile confidence interval is tight (relative width ≤ 30%).
- **Trimmed-mean robustness** (Tukey 1962) — recompute after dropping the top/bottom 5%; robust if the mean moves ≤ 10%.
- **Subgroup leave-one-out** — if a grouping column exists, drop the largest subgroup and check the finding isn't driven by it alone.

### 2. Data Provenance Trail (Chain of Custody)
A tamper-evident, SHA-256 hash-chained (Merkle-style, Web Crypto `SubtleCrypto`, no external library) log of every transformation from raw file load onward (`js/provenance.js`). The raw bytes are hashed on load; each subsequent clean/filter/merge step hashes `parent hash + step description + timestamp + content` into a new link. Any later edit or reordering breaks `verify()`. Viewable and exportable as JSON in the Validate tab for HIPAA audit — distinct from the Assumption Ledger (human-readable judgment calls) but complementary (cryptographic record).

### 3. Confidence-Aware Auto-Narration with Inline Citations
The Story tab now scores **each quantitative claim individually** with the existing Confidence Layer logic (`scoreClaimConfidence` reuses the same sample-coverage / null-rate / sample-size signals and A/B/C/D thresholds), rather than one global score. Every claim gets an inline badge — e.g. "the most common country is 'United States' at 32% (Confidence: A · n=2,509 · 0% missing)" — and grade C/D claims trigger a visible caveat.

### 4. On-Device Anomaly Explainer
When a row is flagged by the multivariate scorers, an "Explain" button produces a plain-language reason on-device (`explainAnomaly` in `js/ondevice-ml.js`). It uses a simplified additive-Shapley attribution (Lundberg & Lee 2017): because the anomaly score is a sum of per-feature standardized squared deviations, each feature's Shapley contribution reduces to its own share of the total. Contributions are measured relative to the row's **peer group** (a low-cardinality categorical column) — "Row flagged because claim_amount is 2.3 std devs above its country='France' peer group mean (contributing 71% of the anomaly)."

### 5. Synthetic Adversarial Test Generator ("Red Team Mode v2")
Given the currently-loaded dataset's schema (column names + inferred types), synthesizes a *fresh* adversarial dataset matching that schema (`js/synthetic-adversarial.js`, seeded mulberry32 PRNG for reproducibility). It plants the issue categories layers 15–18 and the original checks are meant to catch: near-duplicate categorical spellings, cross-column logic violations, exact duplicates, nulls, magnitude outliers/negatives, future dates, and schema-mismatched semantic values. Runs all layers on the synthetic table and reports which seeded categories were caught.

### 6. Explainable Benford Gate (Teaching UI)
UI polish on the Gen 7 Statistical Test Eligibility Gate: when Benford's Law is skipped for a column, the Validate tab now shows an expandable, plain-language "why" note (the gate teaches, rather than silently passing) — reusing the gate's existing skip reasons and a one-paragraph explanation of when Benford applies.

## 🤝 GEN 8 (BATCH 3) — TRUST & COLLABORATION SUITE (This Release)

Three features that take DATAGLOW's trust story out of the single browser session: an analysis becomes a *shareable artifact*, a *reviewable packet*, and a *comparable-over-time* object. All three are file-based — no backend, no accounts, no real-time multiplayer — and use DATAGLOW's own visual/interaction design, not any competitor's report or review UI.

### 7. Shareable Validation Receipts
A single "Export Validation Receipt" action in the Validate tab packages the whole analysis into one self-contained HTML file (`js/validation-receipt.js`) that a non-technical stakeholder can open in any browser without running DATAGLOW. The receipt bundles: the overall **Confidence grade** (with the six-signal verdict), a **pass/fail summary of all 18 validation layers**, the **key Assumption Ledger entries**, and the **generated Story narrative**. `buildValidationReceipt()` is a pure model-builder; `renderReceiptHTML()` emits a script-free, inline-styled document (its own "certificate" layout — a confidence-ring badge over a plain-language layer table) so it is safe to email or archive.

### 8. Async Peer Review Mode
A lightweight, file-based second-reviewer workflow (`js/peer-review.js`). DATAGLOW exports a structured **review packet** (JSON or a human-readable markdown companion) containing the query, the key findings (failing/warning layers surfaced first), the full 18-layer roll-up, and the Assumption Ledger. A second person opens it offline, sets a per-section **approve / flag** decision plus free-text notes, and returns the JSON. DATAGLOW re-imports it (`importReview()` validates it is a genuine DATAGLOW packet), tallies the decisions into an "Approved" / "Changes requested" verdict (`summarizeReview()`), and renders the review beside the analysis. This is DATAGLOW's OWN flat-checklist model — a list of analysis sections each with a three-state decision chip — deliberately not modeled on any pull-request or document-commenting product.

### 9. Time-Travel Diff Mode
A dedicated **Diff** tab where the analyst loads a second dataset version alongside the active one (`js/time-travel-diff.js`) and DATAGLOW auto-diffs at three levels:
- **Row-level** — auto-detects a likely primary key (id/key/code-like unique column, or the first fully-unique column) or lets the user pick one, then reports which rows were **added / removed / changed**, and for changed rows the exact fields with before→after values.
- **Distributional** — reuses Layer 18's **Distributional Fingerprint Drift** logic (the now-exported `computeDistributionFingerprint` / `compareDistributions`) to flag which columns' distributions shifted (numeric mean-shift > 2σ, categorical top-5 composition change).
- **Validation-layer flips** — runs all 18 layers on both versions and reports which layers flip **PASS↔FAIL** between them, so a regression in data quality is impossible to miss.

Row-level and layer-flip diffing are pure and Node-testable; the distributional diff is engine-backed against the shared DuckDB connection.

---

## ✅ HOW TO KNOW FEATURES ARE REALLY WORKING (Not Fake)

### Golden Dataset Test
Built-in test CSV with exactly:
- 100 rows total
- 10 exact duplicates
- 5 null values
- 3 negative values in a non-negative column
- 2 future dates in a historical date column
- 1 schema mismatch (column named "age" with value 999)
- Near-duplicate category spellings ("United States" / "United State" / "USA" / "US"; "France" / "FRA") for the Categorical Consistency Engine
- A discharge_date earlier than its admit_date, and a minor (age < 18) flagged has_retirement_account = true, for the Cross-Column Logical Consistency Checker

All 18 validation layers must catch their specific issues on this dataset before any deployment is considered successful. (The Distributional Fingerprint Drift layer establishes its baseline on first load and flags drift on a later same-schema load.)

### MIMIC-IV Ground Truth Test
MIMIC-IV has published summary statistics in peer-reviewed papers. Run DATAGLOW against MIMIC-IV and compare output numbers to published statistics. If they match — the engine is real.

### Two-Path Sanity Check
Run the same calculation:
1. Manually in Excel
2. In DATAGLOW SQL tab
3. In DATAGLOW Python tab
All three must match.

### Red Flag Signs of Fake/Broken Features
- Confidence Layer always gives 95+ regardless of data quality
- Validation layers never find anything wrong on obviously dirty data
- Results change between identical runs on static data
- Narrative Consistency Checker never finds a mismatch

### Pioneer Validation Ideas (Ranked)
1. **Red Team Dataset** — intentionally broken, self-attack testing
2. **Adversarial Query Test** — divide by zero, nonexistent columns, empty date ranges
3. **Reproducibility Badge** — 10 identical runs, identical results
4. **External Ground Truth** — compare against CMS published hospital quality data
5. **Peer Review Mode** — second analyst reviews queries before presentation
6. **Time Machine Validator** — replay analysis on last month's data, check if conclusions hold

---

## 🌌 SCI-FI PIONEER FEATURES — RANKED

In the spirit of Steve Jobs: *enrich people's lives through liberal arts and technology.*

1. **🥇 The Story Engine** — Reads query results, writes the data narrative in plain English automatically. Not a summary — a story with insight and implication.
2. **🥈 The What-If Machine** — Change one variable, DATAGLOW reruns entire analysis instantly. Scenario modeling without formulas.
3. **🥉 The Invisible Analyst** — Watches how you work, suggests your next step before you ask. Autocomplete for analysis.
4. **The Oral Presentation Mode** — Generates a spoken script from your analysis. Narrates findings like a TED Talk.
5. **The Equity Lens** — Every healthcare analysis automatically checks for demographic disparities. Flags incomplete analysis if race, age, insurance type are missing.
6. **The Live Hospital Feed** — Connects to CMS public data APIs. Your hospital vs. national benchmarks, updated daily.
7. **The Institutional Memory** — Remembers every analysis ever run. Ask "what did we find about readmissions last spring?" — it pulls the exact query, result, and story.
8. **The Blind Spot Scanner** — Already in validation layers. "What data do you NOT have?"
9. **The Peer Review Mode** — GitHub-style pull requests for data analysis before it goes to leadership.
10. **The Time Machine** — Replay any past analysis on current data automatically.

---

## 🍎 DESIGN PHILOSOPHY — STEVE JOBS PRINCIPLES

- **Zero onboarding** — open browser, it works, no instructions, no manual
- **One beautiful thing per screen** — no clutter, no toolbars of toolbars
- **Invisible technology** — AI works in the background, never asks you to talk to it
- **Liberal arts + technology** — data that tells human stories, not just rows and columns
- **Enrich people's lives** — every feature must make the analyst's day better, not harder
- **Light mode default** — clean, bright, professional; dark mode toggle available
- **Mobile-responsive** — works on any screen
- **Every result has a human verdict** — not just a number, but what it means
- *"Good artists copy, great artists steal"* — DATAGLOW takes the best of every tool and makes it better

---

## 📓 JUPYTER ALTERNATIVES — RANKED (Why DATAGLOW Wins)

| Rank | Tool | DATAGLOW Advantage |
|---|---|---|
| 🥇 | Observable | DATAGLOW adds validation + healthcare + storytelling |
| 🥈 | Hex | DATAGLOW is fully browser-native, no server |
| 🥉 | Deepnote | DATAGLOW adds 18 validation layers |
| 4 | Marimo | DATAGLOW adds multi-language + healthcare |
| 5 | Google Colab | DATAGLOW needs no Google account |
| 6 | Quadratic | DATAGLOW adds SQL + R + Swift + validation |
| ❌ | Jupyter | Outdated — what DATAGLOW replaces |

**The honest gap**: Nobody has combined in-browser DuckDB + 13 novel validation layers + healthcare compliance + data storytelling + cleaning + Python/SQL/R/Swift in one tool. That combination is DATAGLOW's alone.

---

## 🐦 SWIFT IN DATAGLOW

SwiftWasm is production-ready as of 2026. Swift 6.3.3 officially supports WebAssembly. Demonstrated at FOSDEM 2026 running at near-native speed in browser via ElementaryUI. Same codebase ships to web, iOS, and macOS simultaneously.

DATAGLOW Swift Tab:
- Write SwiftUI-style code in browser
- Preview iPhone app layouts live
- No Xcode required, no Mac required
- Uses SwiftWasm + JavaScriptKit bridge
- Templates for common iOS data app patterns

---

## 🏥 DOMAIN FOCUS

### Primary: Healthcare Data Analytics
- HIPAA-aware architecture throughout
- Tested on MIMIC-IV (300M+ rows, one of world's hardest clinical datasets)
- Target users: quality improvement departments, small critical access hospitals
- Features: Denial Radar, FHIR support, EDI 837/835, DICOM metadata
- Equity Lens: automatic demographic disparity checking

### Secondary: Universal
- Works for any industry, any domain, any dataset
- Finance, retail, marketing, education, research, government
- Any analyst, anywhere, in any browser

---

## 👥 INSPIRATIONS & COMMUNITY

| Person | Influence on DATAGLOW |
|---|---|
| **Steve Jobs** | Design philosophy — zero friction, enrich lives, liberal arts + tech |
| **Zach Wilson** | Data engineering standards and technical depth |
| **Alex Freberg (Alex the Analyst)** | Approachability, storytelling, SQL-first mindset |
| **Maven Analytics instructors** | Business-facing analyst perspective, portfolio thinking |

---

## 📊 GEN HISTORY

| Gen | Key Features | Status |
|---|---|---|
| Gen 1 | Core DuckDB engine, basic SQL, CSV upload | ✅ Complete |
| Gen 2 | Excel support, JSON, basic cleaning | ✅ Complete |
| Gen 3 | Validate tab, first 3 validation layers | ✅ Complete |
| Gen 4 | Selective-Disclosure Verifiable Reports (Merkle-tree SHA-256 commitment), Synthetic Data (PSyGenTAB v2 — 95% fidelity/97% privacy), Federated Scan with Laplace DP, AutoScan agentic pipeline, Multimodal Consistency | ✅ Complete |
| Gen 5 | Confidence Layer, UX overhaul, light/dark mode | ✅ Complete |
| Gen 6 | All 7 validation layers live, Story tab, Preflight tab | ✅ Complete (expired session) |
| **Gen 7** | Full rebuild as DATAGLOW: Python 3.12, R 4.4, SwiftWasm, 18 validation layers, complete file format support, Steve Jobs UI philosophy | 🔨 In Progress |

---

## 🔥 COMPLETE GEN 7 BUILD PROMPT (Computer Session)

```
Build and deploy DATAGLOW — a universal, browser-based, all-in-one data analytics platform. This is a complete rebuild from the Facet codebase (Gen 1-6), now rebranded as DATAGLOW.

CORE ENGINE:
- DuckDB-WASM v1.5.4 for all SQL analytics — runs entirely in browser, no server
- Pyodide (Python 3.12 in browser) with: pandas 3.0, polars, pyarrow, numpy, scikit-learn, plotly, pandera, scipy, statsmodels, faker
- WebR (R 4.4 in browser) with tidyverse, ggplot2, dplyr
- SwiftWasm (Swift 6.3.3) tab for iOS app preview

FILE FORMAT SUPPORT (all in-browser):
CSV, TSV, JSON, NDJSON, Parquet, Arrow/Feather, Excel (.xlsx/.xls), SQLite, ORC, Avro, HDF5, Delta Lake, SAS (.sas7bdat), SPSS (.sav), Stata (.dta), R (.rds), PDF tables, Fixed-width flat files, HL7 FHIR, DICOM metadata, Google Sheets API, EDI 835/837

TABS (draggable, reorderable):
1. Preflight — data quality checklist before analysis begins
2. SQL — DuckDB query engine with autocomplete
3. Python — Pyodide Python 3.12 notebook
4. R — WebR 4.4 notebook
5. Clean — automated data cleaning with audit trail
6. Validate — all 18 validation layers
7. Visualize — Plotly charts, drag-and-drop
8. Story — AI narrative generation from query results
9. Swift — SwiftWasm iOS app preview tab

13 VALIDATION LAYERS:
1. Sanity Anchor — same query, two independent paths, auto-compared
2. Historical Drift Detector — flags changes between runs
3. Unit Test Layer — 5 silent tests: nulls, duplicates, negatives, future dates, referential integrity
4. Confidence Layer — 0-100 score, color-coded grade ring (A=teal B=blue C=amber D=red), "Ready to present" / "Dig deeper first"
5. Denial Radar — healthcare claim denial pattern detection (EDI 835/837)
6. Schema Fingerprint — cryptographic schema hash, flags column changes between loads
7. Semantic Drift Detector — checks if column names match their values
8. Correlation Watchdog — tracks metric relationships over time, flags decorrelation
9. Narrative Consistency Checker — cross-checks numbers in written story against actual query results
10. Freshness Meter — timestamps every dataset, visible staleness warning
11. Blind Spot Scanner — prompts about missing data that would change conclusions
12. Reproducibility Badge — runs same query 10x, confirms identical results, green/red badge
13. Red Team Mode — loads intentionally broken golden dataset to self-test all validation layers

GOLDEN DATASET (built-in, for self-testing):
100 rows, 10 duplicates, 5 nulls, 3 negatives, 2 future dates, 1 age=999 semantic error
All 18 layers must catch their issues on this dataset before deployment is valid.

UI PHILOSOPHY (Steve Jobs):
- Zero onboarding — open browser, works instantly, no manual
- One beautiful thing per screen — no clutter
- Light mode default, dark mode toggle
- Draggable tabs
- Every result has a human-readable verdict
- Mobile-responsive

BRANDING:
- Name: DATAGLOW
- Logo: "data" in charcoal Poppins SemiBold + "glow" in coral #FF6B6B with spark above G
- Tagline: "Your data, glowing."
- Colors: charcoal #2D2D2D + coral #FF6B6B + white #FFFFFF

HEALTHCARE FOCUS:
- HIPAA-aware architecture
- MIMIC-IV tested (300M+ row chunking strategy)
- Equity Lens: automatic demographic disparity checking
- Target: quality improvement departments, small critical access hospitals

PIONEER FEATURES (Story Engine, What-If Machine, Invisible Analyst, Oral Presentation Mode):
- Story Engine: reads query results, writes narrative automatically
- What-If Machine: change one variable, reruns entire analysis
- Invisible Analyst: suggests next step before asked
- Oral Presentation Mode: generates spoken script from analysis

Deploy publicly. Output the live URL.
```

---

## 📌 STATUS DASHBOARD

| Item | Status |
|---|---|
| Name chosen | ✅ DATAGLOW |
| Logo finalized | ✅ Charcoal + coral spark |
| GitHub repo live | ✅ github.com/Andre-Weissmann/dataglow |
| README published | ✅ Professional and complete |
| Vision document | ✅ This file |
| Gen 7 build prompt | ✅ Ready to paste |
| Live app | ⚠️ Needs new Computer session |
| Python tab | 🔨 Gen 7 |
| R tab | 🔨 Gen 7 |
| Swift tab | 🔨 Gen 7 |
| All 18 validation layers | 🔨 Gen 7 |

---

*DATAGLOW — because your data deserves to shine.* ✨

*Built by Andre Weissmann. July 5, 2026.*
