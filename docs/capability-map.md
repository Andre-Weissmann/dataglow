# DATAGLOW — Capability Map
### Ground-truth revision: July 21, 2026

This file is the single authoritative answer to "does DataGlow already do X?" and "which file owns it?"

**How to read the Status column:**

| Symbol | Meaning |
|--------|---------|
| LIVE | Module is in the bundle, flag is ON, users can access it |
| LIVE (unlisted) | Module was in the bundle but missing from this map until now -- added here |
| PARTIAL | Core logic is built; one sub-batch of UI wiring or a companion file is still queued |
| UNBUILT | Not in the bundle at all. Planned, not started |
| DELETE | Entry was in old map but is wrong, dead-end, or superseded -- removed |

**How to read the Priority column:**

| Symbol | Meaning |
|--------|---------|
| MOAT | Irreplaceable competitive advantage. Build or protect at all costs |
| CORE | Without this, DataGlow does not work. Non-negotiable |
| HIGH | Real user pain solved. Worth doing before anything else |
| MED | Valuable but not blocking anything |
| LOW | Nice to have, quality of life, or future-proofing |
| INFRA | Internal scaffolding -- users never touch it directly |
| KILL | No longer needed or intentionally removed |

---

## CORE RUNTIME

> The engine every other module runs on. Nothing works without these.

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| App controller & tab wiring | `js/app-shell/main.js` (IS the bundle) | LIVE | CORE | Top-level orchestrator. Every tab, every flag, every event. |
| Shared state | merged into bundle | LIVE | CORE | Single source of truth for dataset, findings, flags. |
| DuckDB-WASM query engine | `js/sql/sql-engine.js` | LIVE | CORE | In-browser SQL. Every query runs here. |
| Universal file drop + ingestion router | `js/drop-zone/drop-zone-router.js` | LIVE | CORE | Accepts CSV, JSON, NDJSON, Parquet, X12, image, audio. |
| OPFS storage engine | | LIVE | CORE | Persistent local storage. Survives iOS eviction. Safari-safe via `storage.persist`. |
| OPFS auto-save on file drop | wired into `dataglow:dataset-loaded` event | LIVE | CORE | Every loaded dataset is silently saved to OPFS. Zero UI. Just works. |
| Project workspace | | LIVE (unlisted) | CORE | Per-project dataset grouping, OPFS-backed. |
| Workspace profile | | LIVE (unlisted) | CORE | Saves domain expertise, role, analyst profile to OPFS. |
| Infrastructure bootstrap | | LIVE (unlisted) | CORE | App-level startup, error boundaries, platform detection. |
| Bottom navigation | | LIVE (unlisted) | CORE | Mobile + desktop tab nav layer. |
| Feature flags (FEATURE_FLAGS) | merged into bundle header | LIVE | CORE | 92 flags, all ON. Zero dark features. |
| Canvas grid (data table) | `js/grid/canvas-grid.js` | LIVE | CORE | High-performance scrollable data grid. |
| Column editor | `js/columns/column-editor.js` | LIVE | CORE | Rename, retype, drop columns inline. |
| SQL highlight | `js/app-shell/sql-highlight.js` | LIVE | MED | Syntax coloring in the SQL editor. |
| Format fingerprint | `js/cleaning/format-fingerprint.js` | LIVE | MED | Detects date formats, currency, phone, postal codes automatically. |

---

## VALIDATION ENGINE

> DataGlow's 20-layer validation suite. The reason the proof chain is trustworthy.

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Validation orchestrator | merged across validation modules | LIVE | CORE | `runAllLayers` runs all 20 layers on every dataset load. |
| Missingness detective | `js/validation/missingness-detective.js` | LIVE | CORE | Null patterns, expected-vs-actual rates, column-level missingness. |
| Categorical consistency | `js/validation/categorical-consistency.js` | LIVE | CORE | Detects label drift, mixed case, encoding chaos in string columns. |
| Domain physics | `js/validation/domain-physics.js` | LIVE | HIGH | "Does this value make physical/domain sense?" -- age, weight, dosage, etc. |
| Cross-column consistency | `js/validation/cross-column-consistency.js` | LIVE | HIGH | Catches contradictions between related columns. |
| Upper-bound sanity | `js/validation/upper-bound-sanity.js` | LIVE | HIGH | Statistical ceiling checks. |
| Health standards validator | `js/validation/health-standards.js` | LIVE | HIGH | Healthcare-specific rules (HIPAA field formats, HL7 constraints). |
| DRG/ICD validator | `js/validation/drg-icd-validator.js` | LIVE | HIGH | Healthcare claims validation -- DRG codes vs ICD-10 logic. |
| NCCI/PTP validator | `js/validation/ncci-ptp-validator.js` | LIVE | HIGH | NCCI procedure-to-procedure edit checks for medical billing. |
| Physiological plausibility | `js/validation/physiological-plausibility.js` | LIVE | HIGH | Vital sign ranges, lab value plausibility. |
| Analysis contract | `js/validation/analysis-contract.js` | LIVE | HIGH | Analyst declares assumptions; system verifies them. |
| Semantic layer | `js/validation/semantic-layer.js` + `semantic-layer-ui.js` | LIVE | HIGH | Column meaning registry. "Revenue" always means the same thing. |
| Source convergence (all 3 batches) | `js/validation/source-convergence.js` + `source-convergence-ingestion.js` + `source-convergence-ui.js` | LIVE | HIGH | Multi-source truth reconciliation. Three batches all shipped. |
| The Crucible (all 3 batches) | `js/validation/crucible-contract.js` + `crucible-orchestrator.js` + `crucible-ui.js` + `crucible-adversarial-packs.js` | LIVE | HIGH | Adversarial validation -- tries to break your dataset. UI + revert proposals all live. |
| Query Sentinel (all 3 batches) | `js/validation/query-sentinel.js` + `query-sentinel-assist.js` + `query-sentinel-bridge.js` | LIVE | HIGH | Intercepts SQL/Python/R queries and warns before bad data reaches AI. |
| Rule packs | `js/rulepacks/rulepack-registry.js` + `packs/general.js` + `packs/healthcare.js` | LIVE | HIGH | Domain-specific validation rule packs. Healthcare + general shipped. |
| Extension points | `js/packs/extension-points.js` | LIVE | MED | Third-party rule pack plugin API. |
| Narrative overconfidence guard | `js/rigor/narrative-overconfidence-guard.js` | LIVE | HIGH | Catches AI narratives that overclaim certainty on weak data. |
| Statistical rigor layer | `js/rigor/statistical-rigor.js` | LIVE | HIGH | Sample size sufficiency, confidence interval validity, p-value hygiene. |
| IRB mode | `js/provenance/irb-mode.js` | LIVE | MED | Research ethics compliance mode -- flags IRB-relevant operations. |

---

## AI READINESS GATE

> The gate that stops unvalidated data from reaching AI agents. DataGlow's moat.

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Readiness gate (scoring core) | `js/gate/readiness-gate.js` | LIVE | MOAT | Pure scorer over all 20 validation layers. Emits `agentConsumable: true/false`. |
| Agent gate (hard block) | `js/gate/agent-gate.js` | LIVE | MOAT | Every `js/agents/* (relocated/removed)` module is hard-blocked when gate fails. Humans always pass. |
| Gate state exporter | `js/mcp/gate-state-exporter.js` -- ABSENT | UNBUILT | HIGH | Writes `dataglow-gate-state.json` for external MCP clients. Settings tab button. |
| AI Readiness Gate badge UI | merged into readiness-gate.js | LIVE | HIGH | Pass/fail badge surfaced in SQL tab and query results. |

---

## PROVENANCE & PROOF CHAIN

> Every analysis DataGlow touches gets a signed, verifiable receipt. This is the trust layer.

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Provenance engine | | LIVE (unlisted) | MOAT | Central proof chain coordinator. |
| AI Touch Ledger | `js/provenance/ai-touch-ledger.js` | LIVE | MOAT | Hash-chained record of every AI interaction with a dataset. Tamper-evident. |
| Trust Ledger (this session, in order) | `js/provenance/trust-ledger.js`<br>`js/provenance/data-glow-trust-ledger-canvas.js` | LIVE | HIGH | One calm append-only list of this session's trust events, oldest first, behind a Trust button next to Air-Gap and Shield Packs: a validation score, a metric definition version, an export that was written, a gate verdict. Every row is a plain sentence plus a hash prefix, chained with SHA-256 using the same genesis anchor and canonical-JSON discipline as the AI Touch Ledger, so it composes the existing provenance instead of adding a second crypto stack. Verify re-walks the chain and names an edit, reorder or deletion. Session-scoped and in memory: no storage, no network, and the text/Markdown/JSON buttons are the only way a row leaves. Flag `trustLedger`. A record of this session, not an audit certification. |
| Proof room | `js/provenance/proof-room.js` | LIVE | MOAT | Composites readiness gate + ledger + seal into one proof. |
| Proof chain rail (UI) | | LIVE (unlisted) | HIGH | Right-rail timeline of proof events. |
| Proof builder | `js/proof/proof-builder.js` | LIVE | HIGH | Constructs individual proof entries. |
| Provenance packet | `js/provenance/provenance-packet.js` | LIVE | HIGH | Portable SHA-256-signed `.dataglow-proof` artifact. |
| Verifiable check seal | `js/provenance/verifiable-check-seal.js` | LIVE | HIGH | Cryptographic pass/fail seal attached to each validation run. |
| ZK threshold proof | `js/provenance/zk-threshold-proof.js` | LIVE | MOAT | First genuine zero-knowledge proof in a browser data tool. Proves score threshold without revealing data. |
| Trust beam | `js/provenance/trust-beam.js` | LIVE | HIGH | Shareable, offline-verifiable seal link. |
| Data nutrition label | `js/provenance/data-nutrition-label.js` | LIVE | HIGH | Human-readable summary of dataset health, bias flags, validation score. |
| Portable receipt | `js/provenance/portable-receipt.js` | LIVE | HIGH | Per-artifact lineage export. Attaches to any export or downstream system. |
| Receipt engine | | LIVE (unlisted) | HIGH | Generates cryptographic receipts for every analysis operation. |
| Notary engine | | LIVE (unlisted) | HIGH | Signs and timestamps proof artifacts. |
| Proof-that-travels wiring | | LIVE (unlisted) | HIGH | Wires proof chain into every export and downstream path. |
| Trust certificate | `js/trust/trust-certificate.js` | LIVE | HIGH | Formal cert artifact summarizing dataset trustworthiness. |
| Trust strip | `js/trust/trust-strip.js` | LIVE | HIGH | Inline UI strip showing trust status on every result. |
| Proof drawer | `js/trust/proof-drawer.js` | LIVE | MED | Slide-out panel showing full proof chain for any result. |
| Ownership ledger | `js/provenance/ownership-ledger.js` | LIVE | MED | Tracks dataset stewardship and handoff history. |
| Data BOM (Bill of Materials) | `js/provenance/data-bom.js` | LIVE | MED | Component-level breakdown of what went into a dataset. |
| Data blame | `js/provenance/data-blame.js` | LIVE | MED | Git-blame-style attribution for data quality issues. |
| Analysis fingerprint | `js/provenance/analysis-fingerprint.js` | LIVE | MED | Unique hash per analysis run for reproducibility. |
| Validation receipt | `js/provenance/validation-receipt.js` | LIVE | MED | Specific receipt for validation layer results. |
| Assumption ledger | `js/provenance/assumption-ledger.js` | LIVE | MED | Tracks analyst assumptions declared during analysis. |
| Deidentification verifier | `js/provenance/deidentification-verifier.js` | LIVE | HIGH | Cryptographically verifies PII was stripped before export. |
| Denial root cause | `js/provenance/denial-root-cause.js` | LIVE | HIGH | When a claim is denied, explains exactly which layer caused it. |
| Incident postmortem | `js/provenance/incident-postmortem.js` | LIVE | MED | Auto-generates postmortem report for data quality incidents. |
| Peer review | `js/provenance/peer-review.js` | LIVE | MED | Structured analyst-to-analyst review workflow with sign-off. |
| Selective disclosure proof | `js/provenance/selective-disclosure-proof.js` | LIVE | HIGH | Prove specific facts about a dataset without revealing the dataset. |
| Selective disclosure proof | `js/provenance/selective-disclosure-proof.js` | LIVE | HIGH | Reveal only what the auditor needs, nothing more. |
| **Model Training Passport** | NOT YET BUILT | UNBUILT | MOAT | Sign a portable artifact proving a dataset passed validation before AI training. EU AI Act Article 10 compliance. $492M market. No competitor has this. |

---

## ON-DEVICE AI

> All AI runs locally. No API key. No cloud. No data leaves the device.

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Browser LLM engine (WebLLM) | + `browser-llm-wiring.js` | LIVE (unlisted) | MOAT | Qwen2.5-Coder-3B-Instruct running via WebGPU. The engine behind every AI feature. |
| On-device LLM (narrative tier) | `js/narrative/ondevice-llm.js` | LIVE | MOAT | Wires the LLM into Story tab and Guarded Copilot. |
| AI Council | `js/council/council-engine.js` + `council-ui.js` | LIVE | HIGH | Multi-provider AI panel (GPT, Claude, Gemini, local). BYO-key for cloud; Qwen for local. |
| RAG knowledge engine | | LIVE (unlisted) | HIGH | 32-entry local knowledge base (15 healthcare, 12 finance, 5 retail). Wired into every council prompt. |
| MCP Server | | LIVE (unlisted) | HIGH | 8 governed MCP tools exposing DataGlow's proof chain to external AI agents (Claude Code, Cursor). Zero raw data leaves. |
| Guarded Copilot | `js/agents/guarded-copilot.js` | LIVE | HIGH | Read-only chat assistant. Cites proof chain. Cannot modify data by construction. |
| PHI prompt guard | `js/agents/phi-prompt-guard.js` | LIVE | HIGH | Blocks PHI/PII from entering any LLM prompt. |
| Uncertainty resolver | `js/agents/uncertainty-resolver-agent.js` | LIVE | HIGH | Flags when an AI answer has insufficient data confidence. |
| Intent layer | (Shadow Analyst) | LIVE (unlisted) | HIGH | Ambient floating pill. Scores 6 analyst intents in real time. Spring physics. |
| Mirror (Shadow Analyst) | | LIVE (unlisted) | HIGH | Parallel analyst that watches your work and surfaces blind spots. |
| **Gemma3-1B reflex tier** | NOT YET BUILT | UNBUILT | HIGH | Fast narrow-task model for UI interactions. Model ID: `gemma3-1b-it-q4f16_1-MLC`. Keeps Qwen2.5-Coder-3B for SQL. Two-tier LLM. |
| **Whisper on-device voice ("Talk to Your Data")** | NOT YET BUILT | UNBUILT | MOAT | 4-bit Whisper via WebGPU + Transformers.js (~75MB). Ask a column what's wrong, out loud. Zero cloud STT. No Web Speech API. |
| **Chronos-2 time-series forecasting** | NOT YET BUILT | UNBUILT | HIGH | `kashif/chronos-2-onnx` via Transformers.js. 124.7MB INT8. Probabilistic forecasts (21 quantiles). Fills the predictive quadrant DataGlow currently has zero of. |
| **all-MiniLM semantic duplicate detection** | NOT YET BUILT | UNBUILT | MED | `Xenova/all-MiniLM-L6-v2` (23MB). Semantic near-duplicate detection layered on top of fuzzy-dedup. |

---

## PRIVACY & SYNTHETIC DATA

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Differential privacy (epsilon budget) | `js/privacy/privacy-budget.js` | LIVE | MOAT | Formal epsilon-delta privacy accounting. Every analysis tracked. |
| Synthetic twin | `js/privacy/synthetic-twin.js` | LIVE | MOAT | Generates a statistically-equivalent synthetic dataset. No real records in output. |
| Synthetic adversarial | `js/privacy/synthetic-adversarial.js` | LIVE | HIGH | Attacks the synthetic twin to verify it doesn't leak real records. |
| Synthetic data passport | `js/privacy/synthetic-data-passport.js` | LIVE | HIGH | Cryptographically signed artifact proving synthetic data provenance. |
| **Data Expiry + Purpose Contracts** | NOT YET BUILT | UNBUILT | MOAT | Sticky signed policy at ingestion: `expires`, `purpose`, `no-training`. Enforced locally by every runtime. Auto-generates the tamper-evident deletion log 20 US state privacy laws now require by statute. |

---

## ANOMALY & DRIFT DETECTION

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Isolation Forest | `js/anomaly/isolation-forest.js` | LIVE | HIGH | Statistical anomaly detection. Works on any numeric column. |
| SPC control charts | `js/anomaly/spc-control.js` | LIVE | HIGH | Statistical process control. Catches process drift over time. |
| Anomaly timeline | `js/anomaly/anomaly-timeline.js` | LIVE | HIGH | Visual timeline of anomaly events across a dataset's history. |
| Active learning (anomaly feedback) | `js/anomaly/active-learning.js` | LIVE | MED | Analyst marks false positives; model adapts. |
| Entity baseline | `js/anomaly/entity-baseline.js` | LIVE | MED | Per-entity (patient, account, device) baseline for anomaly comparison. |
| Predictive anomaly | `js/anomaly/predictive-anomaly.js` | LIVE | MED | Forward-looking anomaly risk score. |
| Semantic drift watchdog | `js/ambient/drift-watchdog.js` | LIVE | HIGH | Monitors for meaning drift in categorical columns over time. |
| Dataset differ | `js/drift/dataset-differ.js` | LIVE | HIGH | Row-level diff between dataset versions. |
| Drift forecast | `js/drift/drift-forecast.js` | LIVE | MED | Projects where current drift trends will land. |
| Freshness decay | `js/drift/freshness-decay.js` | LIVE | MED | Scores how stale a dataset is based on known refresh cadence. |
| Streaming validator | `js/streaming/streaming-validator.js` | LIVE | HIGH | 4-pillar live validator: schema drift, value drift, arrival anomaly, null spike. Right-rail dashboard. |
| **Data Mirror (bias pre-flight)** | NOT YET BUILT | UNBUILT | MOAT | Visual "what an AI sees" report before any export or model use. Composes existing equity stratification + anomaly detection. AWS Clarify closes to new customers July 30, 2026 -- gap is open now. |

---

## EQUITY & FAIRNESS

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Equity stratifier | `js/equity/equity-stratifier.js` | LIVE | MOAT | Breaks results down by protected attributes. Surfaces disparities. |
| Disparity scorer | `js/equity/disparity-scorer.js` | LIVE | MOAT | Quantifies the magnitude of disparity across groups. |
| Equity detector | `js/equity/equity-detector.js` | LIVE | HIGH | Flags potential equity issues before analysis is complete. |
| Equity attestation | `js/equity/equity-attestation.js` | LIVE | HIGH | Signs a statement that equity review was performed. Attaches to proof chain. |

---

## NL-to-SQL & METRIC STUDIO

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| NL-SQL engine | `js/nl-sql/nl-sql-engine.js` | LIVE | HIGH | Natural language to DuckDB SQL. Works offline. |
| NL-SQL pattern engine | `js/nl-sql/nl-sql-pattern-engine.js` | LIVE | HIGH | Rule-based pattern matching for common query intents. |
| NL-SQL UI | `js/nl-sql/nl-sql-ui.js` | LIVE | HIGH | Chat-style query interface. |
| Schema context | `js/nl-sql/schema-context.js` | LIVE | HIGH | Feeds live column names/types into NL-SQL prompts. |
| NL-SQL key store | `js/nl-sql/nl-sql-key-store.js` | LIVE | MED | Stores BYO API keys for cloud NL-SQL providers. |
| Metric Contracts (Batch 1 -- versioned model) | `js/nl-sql/metric-contracts.js` | LIVE | HIGH | "Revenue always means this." Versioned, diffable metric definitions. |
| Metric Contract Status (the answer the readiness gate wanted) | `js/metrics/metric-contract-status.js` | LIVE | HIGH | `computeReadinessGate()` always took a contract-status argument and always received null, because nothing produced one: five readers of `state.metricContractStatus` had zero writers. This is the producer, now assigned on every definition save. Broken means the live definition no longer matches the latest version in that metric's own recorded history. Covered by `test/metric-contract-status.test.mjs`. |
| Metric Studio | `js/metrics/metric-studio.js` | LIVE | HIGH | Visual metric definition editor. |
| Metric Contracts Batch 2 (diff view) | `js/metrics/metric-contract-diff-view.js` | LIVE | MED | Side-by-side diff when a metric definition changes. Covered by `test/metric-contract-diff-view.test.mjs`. |
| Metric Contracts Batch 3 (confirm gate) | `js/metrics/metric-contract-confirm-gate.js` | LIVE | MED | Requires a human Approve or Reject before a proposed metric definition change is applied. AI proposes, the human confirms. Covered by `test/metric-contract-confirm-gate.test.mjs`. |
| Metric Contracts Batch 4 (agent-access rules) | `js/metrics/metric-access-rules.js` | LIVE | MED | Controls which agents can read which metrics. Covered by `test/metric-access-rules.test.mjs`. |
| Shared metrics registry | `js/app-shell/metrics-registry.js` | LIVE | MED | "Define once" in-session metric source of truth. Covered by `test/metrics-registry.test.mjs`. |
| NL engine (general) | `js/nl/nl-engine.js` | LIVE | MED | General natural language parsing layer used across tabs. |

---

## MULTI-RUNTIME (SQL / PYTHON / R / EXCEL)

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Python runtime (Pyodide) | loaded via CDN, wired in `js/runtimes-viz/visualize.js` | LIVE | CORE | Full CPython in the browser. pandas, numpy, scikit-learn. |
| Python Notebooks-lite | `js/intelligence/python-notebook-lite.js`<br>`js/intelligence/data-glow-python-notebook-canvas.js` | LIVE | HIGH | Multi-cell on-device Pyodide notebook over the Python tab: code + markdown cells, one shared kernel top-to-bottom, run cell/run all, local `.dgnb` save/load. Zero-upload; SecurityAdvisor scans each cell. Flag `pythonNotebooksLite`. Not full Jupyter. |
| R runtime (WebR) | loaded via CDN, wired in `js/runtimes-viz/visualize.js` and `js/runtimes-viz/r-runtime.js` | LIVE | CORE | Full R in the browser. tidyverse, ggplot2. On the canvas the R tab is the notebooks-lite surface below. |
| R Notebooks-lite (any industry) | `js/intelligence/r-notebook-lite.js`<br>`js/intelligence/data-glow-r-notebook-canvas.js` | LIVE | HIGH | Multi-cell on-device WebR notebook over the R tab: code + markdown cells, one shared R session top-to-bottom, run cell/run all, local `.dgrnb` save/load, base R and ggplot2 plot capture (best-effort, honest note when a package cannot install), table bridge `dataglow_get_df()` capped at 200000 rows per table. Starter packs for general, stats, finance, healthcare and ops, not pharma-only. Zero-upload; SecurityAdvisor scans each cell. Flag `rNotebooksLite`. Not full RStudio. |
| Notebook to App | `js/intelligence/notebook-app-export.js`<br>`js/intelligence/data-glow-notebook-app-canvas.js` | LIVE | HIGH | "Save as app" on both notebook toolbars. Turns a notebook that already ran on this device into ONE self-contained HTML file: the cells, the captured text output and the captured plots, in a calm read-only surface that opens by double click with no server, no install and no internet (filter, hide code, print). Nothing is written until the human presses Save in a confirm sheet that lists in plain language exactly what goes in the file; PHI Shield scans the notebook text first and a hit preselects leaving the results out. Air-Gap Mode does not refuse it, since the file is built here and calls nothing, and the builder refuses to emit a file that references anything off the device. No dataset rows, no keys, no cookies, no tracking. Flag `notebookToApp`. A snapshot of a run, not a live notebook: there is no Python or R engine inside the file. |
| Publish-Safe (one gate before a file is written) | `js/gate/publish-safe.js` | LIVE | HIGH | One verdict before an export happens, composed from checks DataGlow already had but no path asked together: PHI Shield on the exact text that would travel, the readiness gate, Metric Contracts, and Air-Gap Mode. Clear, caution or blocked, in plain language, plus a suggested safer default. Sensitive values leaving the device is the one hard refusal; sensitive values staying on it is a caution with results preselected out, because the human owns the disk. A check that could not run is never a pass. Wired into the "Save as app" sheet. Flag `publishSafe`. A gate over the checks it was given, not a guarantee about what it was not shown. |
| Explain (plain language over real evidence) | `js/explain/explain-engine.js`<br>`js/explain/data-glow-explain-canvas.js` | LIVE | HIGH | An Explain button beside Trust and Air-Gap that answers the question people actually ask of a result: not what the numbers are, but whether they hold. Composes, never computes: each sentence traces to one of seven sources that already ran (Query Sentinel, the readiness gate, result shape, PHI Shield, Air-Gap Mode, Publish-Safe, the Trust Ledger). Carries its own confidence, derived from how many of those answered, so a summary built on two checks cannot present itself as well-evidenced. A source that could not run is named as an unknown, never dropped and never counted as a pass. Fully on-device, so it reads the same with Air-Gap Mode on. Copyable as plain text. Flag `explain`. An account of what the checks saw, not a verdict on what they were not shown. |
| GlassBox (show the math under a finding) | `js/glassbox/glass-box.js`<br>`js/glassbox/data-glow-glass-box-canvas.js` | LIVE | HIGH | Finding on top, proof underneath, identical in shape on the three surfaces that have a result: the SQL view result, the SQL tab result and the Python result. The proof is the literal code that ran plus the engine that ran it, read from the paired editor at open time rather than reconstructed, because a reconstructed query looks checkable and can be wrong. Badge chips come only from gates that genuinely reported; an absent gate produces no chip and the panel says that an absence of evidence is not a clean result. Long source truncates with the real line count kept. Flag `glassBox`. It shows the work, it does not re-run it or grade it. |
| Visualization engine | `js/runtimes-viz/visualize.js` | LIVE | CORE | Chart rendering layer across all runtimes. |
| Glow Canvas (multi-chart dashboard) | `js/runtimes-viz/glow-canvas.js` | LIVE | HIGH | Drag-and-arrange multi-chart dashboard. |
| Chart engine | `js/chart/chart-engine.js` | LIVE | HIGH | Underlying chart primitives. |
| SQL dialect adapter | `js/app-shell/sql-dialect-adapter.js` | LIVE | HIGH | Translates PostgreSQL, MySQL, BigQuery, Snowflake, T-SQL into DuckDB SQL. |
| Polyglot autocomplete | `js/polyglot/polyglot-autocomplete.js` | LIVE | MED | Column/table name completion across all runtimes. |
| Polyglot error advisor | `js/polyglot/polyglot-error-advisor.js` | LIVE | MED | Plain-English error explanations for SQL/Python/R errors. |
| Object Space registry | `js/app-shell/object-space.js` | LIVE | MED | In-session shared variable registry across runtimes. |
| Livewire engine | | LIVE (unlisted) | HIGH | Live streaming data connection layer. |
| Pivot table | `js/pivot/pivot-builder.js` + `js/runtimes-viz/pivot-ui.js` -- ABSENT | UNBUILT | MED | Visual drag-and-drop pivot table. Missing despite being planned since early builds. |

---

## JOIN BUILDER

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Join builder (core logic) | `js/join/join-builder.js` | LIVE | HIGH | Programmatic join logic. Keys, types, coverage. |
| Cardinality detector | | LIVE (unlisted) | HIGH | Detects 1:1, 1:many, many:many join relationships before the join runs. |
| Foreign key checker | `js/relational/foreign-key-checker.js` | LIVE | HIGH | Validates FK integrity between tables. |
| Join coverage checker | `js/relational/join-coverage-checker.js` | LIVE | HIGH | Measures what percentage of rows will survive a join. |
| Temporal order checker | `js/relational/temporal-order-checker.js` | LIVE | HIGH | Validates time-based joins are in the right order. |
| Flag consistency checker | `js/relational/flag-consistency-checker.js` | LIVE | MED | Checks that boolean/flag columns are logically consistent across a join. |
| Visual join canvas | `js/join-builder/join-canvas.js` -- ABSENT | UNBUILT | MED | Visual drag-and-drop join UI. Logic is live, UI layer missing. |

---

## DATA VERSION CONTROL

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| DVC store | `js/dvc/dvc-store.js` | LIVE | HIGH | Git-style dataset versioning. Branch, commit, diff. |
| DVC diff | `js/dvc/dvc-diff.js` | LIVE | HIGH | Row-level diff between dataset versions. |
| DVC UI | `js/dvc/dvc-ui.js` | LIVE | HIGH | Commit history panel, branch switcher. |

---

## ANALYSIS ROBUSTNESS

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Devil's Advocate | `js/analysis-robustness/devils-advocate.js` | LIVE | HIGH | Generates counter-arguments to every AI-produced finding. |
| Robustness verdict | `js/analysis-robustness/robustness-verdict.js` | LIVE | HIGH | Summarizes sensitivity analysis into a single robustness score. |
| Statistical rigor layer | `js/rigor/statistical-rigor.js` | LIVE | HIGH | Sample size, confidence intervals, multiple comparison correction. |
| Peer review | `js/provenance/peer-review.js` | LIVE | MED | Structured sign-off workflow between analysts. |

---

## NARRATIVE & STORY

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Story builder | `js/story/story-builder.js` | LIVE | HIGH | Assembles validated findings into a structured narrative. |
| Narrative story (on-device LLM narration) | `js/narrative/story.js` | LIVE | HIGH | LLM-powered narrative layer. Cites proof chain. |
| Narrative overconfidence guard | `js/rigor/narrative-overconfidence-guard.js` | LIVE | HIGH | Blocks the LLM from overclaiming certainty on weak findings. |
| Portfolio export | | LIVE (unlisted) | MED | Exports analysis as a shareable portfolio artifact. |

---

## CLEANING & PRESCRIPTIONS

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Cleaning prescription (dashboard) | | LIVE (unlisted) | HIGH | Generates a ranked list of recommended cleaning actions. |
| Data health score | | LIVE (unlisted) | HIGH | Single 0-100 score summarizing overall dataset health. |
| Findings rail | `js/dashboard/findings-rail.js` | LIVE | HIGH | Right-rail streaming findings panel during analysis. |
| Fuzzy dedup | `js/cleaning/fuzzy-dedup.js` | LIVE | HIGH | Near-duplicate record detection and merging. |
| Imputation | `js/cleaning/imputation.js` | LIVE | MED | Missing value filling (mean, median, mode, forward-fill). |
| Fix confidence | `js/cleaning/fix-confidence.js` | LIVE | MED | Scores how confident DataGlow is in each suggested fix. |
| Materiality scorer | `js/cleaning/materiality.js` | LIVE | MED | Ranks issues by how much they matter to the analysis goal. |
| Insight engine | `js/insight/insight-engine.js` | LIVE | HIGH | Surfaces non-obvious patterns and correlations automatically. |
| Problem framer | `js/problem-framing/problem-framer.js` | LIVE | HIGH | Structures the analytical question before the analysis runs. |
| Cost of bad data | `js/provenance/cost-of-bad-data.js` | LIVE | HIGH | Quantifies the dollar/risk impact of each data quality issue. |
| Golden signals | `js/grades/golden-signals.js` | LIVE | HIGH | The top-N signals that most reliably predict data quality problems. |
| Calibrated grades | `js/grades/calibrated-grades.js` | LIVE | HIGH | Letter-grade system calibrated to real-world data quality norms. |
| Cat scorecard | `js/grades/cat-scorecard.js` | LIVE | MED | Category-level scorecard across validation dimensions. |
| Excel Hell Repair | `js/intelligence/excel-hell-repair.js`<br>`js/intelligence/data-glow-excel-hell-canvas.js` | LIVE | HIGH | On-device detect of the real header, junk title/blank/footer rows, multi-row header collapse, and type coercion into a reversible, refreshable recipe. Preview-first; Apply needs an explicit click; undo restores the pre-image. |
| Guided Unpivot | `js/intelligence/guided-unpivot.js`<br>`js/intelligence/data-glow-guided-unpivot-canvas.js` | LIVE | HIGH | On-device wide-to-long reshape: pick keep (id) columns + wide columns to unpivot, name the new name/value columns, preview a sample with a row-count estimate, then Apply on an explicit click (reversible via Undo). Glass-box shows the equivalent DuckDB `UNPIVOT` SQL. Inverse of the Pivot builder; web, desktop, PWA. |
| Repair Recipe Library | `js/intelligence/repair-recipe-library.js`<br>`js/intelligence/repair-recipe-store.js`<br>`js/intelligence/data-glow-repair-recipe-library-canvas.js` | LIVE | HIGH | Save an Excel Hell (or Guided Unpivot) repair recipe with a human name, list saved recipes on-device (standalone IndexedDB), and reapply one to a new file of the same shape family. Match score compares the recipe's columns to the active dataset and warns honestly when columns changed. Preview-first; Apply is click-only. Metadata only (steps + column names), never raw rows; web, desktop, PWA. |

---

## LEARNING & ADAPTATION

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Self-learning rules | `js/learning/self-learning-rules.js` | LIVE | HIGH | Learns from analyst corrections and generalizes new rules. |
| Adaptive priority | `js/learning/adaptive-priority.js` | LIVE | MED | Reorders findings by what this analyst cares about most. |
| Memory store | `js/learning/memory-store.js` | LIVE | HIGH | Persists learned preferences and rules across sessions. |
| Proficiency signal | `js/learning/proficiency-signal.js` | LIVE | MED | Tracks analyst skill level to calibrate explanations. |
| Rule suggestions | `js/learning/rule-suggestions.js` | LIVE | MED | Proactively suggests new validation rules based on patterns seen. |
| Signal store | `js/learning/signal-store.js` | LIVE | MED | Stores behavioral signals for adaptive personalization. |
| Institutional memory | `js/memory/institutional-memory.js` | LIVE | HIGH | Cross-session memory of decisions made about a specific dataset. |
| Micro-lessons | `js/teaching/micro-lessons.js` | LIVE | MED | In-context teaching moments triggered by analyst actions. |
| Community pack sharing | `js/teaching/community-pack.js` | LIVE | LOW | Peer-sourced validation rule packs. |
| Drill Floor | `js/drill-floor/drill-floor.js` + `drill-floor-data.js` + `drill-diff.js` | LIVE | MED | SQL/Python/R practice drills with real feedback. |
| Nutrition badges | `js/provenance/nutrition-badges.js` | LIVE | MED | Visual data quality badges shown on every column header. |

---

## SIMULATION & TIME TRAVEL

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Digital twin | `js/simulation/digital-twin.js` | LIVE | HIGH | Parallel simulation of dataset under different assumptions. |
| Sandbox twin | `js/simulation/sandbox-twin.js` | LIVE | HIGH | Safe sandbox for destructive experiments without touching the real dataset. |
| Time machine | `js/simulation/time-machine.js` | LIVE | HIGH | Replay dataset at any historical point. |
| Time travel diff | `js/simulation/time-travel-diff.js` | LIVE | MED | What changed between two time points. |

---

## MEETING SCRIBE & ROOMS

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Meeting scribe UI | `js/agents/meeting-scribe-ui.js` | LIVE | HIGH | Paste or live-capture a meeting transcript. Extracts data decisions and action items. |
| Meeting scribe agent | `js/agents/meeting-scribe-agent.js` | LIVE | HIGH | Tags transcript segments with dataset context. |
| Meeting decision ledger | `js/agents/meeting-decision-ledger.js` + `meeting-decision-ledger-ui.js` | LIVE | HIGH | Stores decisions in a browsable, searchable ledger. Signed. |
| Meeting synthesis | `js/agents/meeting-synthesis.js` | LIVE | HIGH | Synthesizes transcript into a structured summary with action items. |
| Live transcript capture | `js/agents/live-transcript-capture.js` | LIVE | HIGH | On-device real-time transcription. No audio leaves device. |
| Rooms builder | `js/rooms/rooms-builder.js` | LIVE | MED | Collaborative analysis room infrastructure. |
| Object Space broadcast | `js/app-shell/object-space.js` (partial -- broadcast wiring absent) | PARTIAL | MED | Shares Object Space state across a room. Transport layer not yet wired. |
| Rooms P2P transport | `js/rooms/room-signaling.js` + `room-transport-adapter.js` -- ABSENT | UNBUILT | MED | Real WebRTC signaling and data channel. The actual "two browsers talking" layer. |
| **Serverless cross-device sync** | NOT YET BUILT | UNBUILT | HIGH | mDNS + WebRTC (same room), QR-code handoff (zero network), Bluetooth LE (ambient). Start on desktop, continue on iPad. No server, no login. |

---

## DATA DIPLOMACY

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Diplomacy claim builder | `js/diplomacy/diplomacy-claim.js` | LIVE | HIGH | Each party seals a claim about their dataset. |
| Reconciliation engine | `js/diplomacy/reconciliation-engine.js` | LIVE | HIGH | Finds the common ground between two conflicting datasets without exposing raw data. |
| Diplomacy loader | `js/diplomacy/diplomacy-loader.js` | LIVE | HIGH | Ingests both datasets for comparison. |
| Diplomacy UI | `js/diplomacy/diplomacy-ui.js` | LIVE | HIGH | Two-key panel UI. Both parties see results simultaneously. |
| Diplomacy approval gate | `js/diplomacy/diplomacy-approval-gate.js` | LIVE | HIGH | Neither party can proceed until both approve the reconciliation. |
| Diplomacy P2P transport | `js/diplomacy/diplomacy-p2p-transport.js` | LIVE | MED | Sealed claim exchange over P2P channel. |
| **Dataset Handshake (PSI -- Private Set Intersection)** | NOT YET BUILT | UNBUILT | MOAT | Two DataGlow instances find dataset overlap via OpenMined `@openmined/psi.js` WASM. 156ms for 100K rows. Zero raw data exchanged. Unlock for M&A due diligence, healthcare cohort matching, fraud detection. Highest-moat feature DataGlow does not yet have. |

---

## INGESTION & RAG

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Drop zone router | `js/drop-zone/drop-zone-router.js` | LIVE | CORE | Routes any file type to the right parser. |
| JSON flattener | `js/ingestion/json-flattener.js` | LIVE | HIGH | Flattens deeply nested JSON into a flat table. |
| X12 parser | `js/ingestion/x12-parser.js` | LIVE | HIGH | Healthcare EDI X12 transaction parsing (835, 837, 270, 271). |
| Image OCR | `js/ingestion/image-ocr.js` | LIVE | MED | Extracts tabular data from images via on-device OCR. |
| Text line parser | `js/ingestion/text-line-parser.js` | LIVE | MED | Ingests fixed-width, pipe-delimited, and non-standard text formats. |
| API feed | `js/ingestion/api-feed.js` | LIVE | MED | Pulls data from a user-supplied API endpoint into DuckDB. |
| RAG engine | | LIVE (unlisted) | HIGH | 32-entry local knowledge base. Healthcare, finance, retail. Wired into every council prompt. |
| Audio ingestion (Whisper structured output) | `js/audio/audio-structurer.js` -- ABSENT | UNBUILT | MED | Whisper transcription piped into structured dataset (different from voice query). |
| PDF ingestion (PDF.js) | `js/pdf/pdf-ingestion-bridge.js` -- ABSENT | UNBUILT | MED | Extracts tables from PDFs directly into DuckDB. |
| Video ingestion (audio track) | `js/video/video-ingestion-bridge.js` -- ABSENT | UNBUILT | LOW | Extracts audio track from video, feeds into Whisper. |
| Connector manager | `js/connectors/connector-manager.js` | LIVE | MED | Manages all external connector plugins. |

---

## EXPORT & SHARING

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Export engine | `js/export/export-engine.js` | LIVE | HIGH | Unified export orchestrator. |
| Export delivery | `js/export/export-delivery.js` | LIVE | HIGH | Browser download, Tauri native save-as, future: cloud push. |
| Export report | `js/export/export-report.js` | LIVE | HIGH | Formatted PDF/Excel report export with proof chain attached. |
| Publish engine | `js/publish/publish-engine.js` | LIVE | MED | Publishes a DataGlow analysis as a shareable artifact. |

---

## FEDERATED & CROSS-DEVICE

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| Federated learning (partial) | logic present, transport absent | PARTIAL | MED | Federated model training across isolated datasets. Core logic exists; transport layer absent. |
| **Federated Quality Score** | NOT YET BUILT | UNBUILT | HIGH | Two DataGlow instances compute joint data quality metric via secure aggregation (FHE). Zero raw rows exchanged. Depends on PSI landing first. |

---

## ENTERPRISE & GOVERNANCE (FUTURE)

| Capability | File(s) | Status | Priority | Purpose |
|---|---|---|---|---|
| BigQuery connector | `js/warehouse/bigquery-connector.js` -- ABSENT | UNBUILT | MED | Read-only pull from user's BigQuery warehouse into DuckDB. BYO credentials. |
| S3 connector | `js/warehouse/s3-connector.js` -- ABSENT | UNBUILT | MED | Read-only pull from S3 bucket into DuckDB. BYO credentials. |
| Webhook handler | `js/webhook/webhook-handler.js` -- ABSENT | UNBUILT | LOW | Receives incoming data pushes from external systems. |
| NATS bridge | `js/nats/nats-bridge.js` -- ABSENT | UNBUILT | LOW | Real-time NATS message stream ingestion. |
| Capability registry | `js/app-shell/capability-registry.js` -- ABSENT | UNBUILT | INFRA | Platform-aware module loader. Loads only what the current runtime supports. |
| **Air-gap certification docs** | NOT YET BUILT | UNBUILT | HIGH | CMMC 2.0 Level 2 control-mapping against DataGlow's architecture. CMMC Phase 2 starts November 10, 2026. DataGlow's zero-connectivity architecture already satisfies most of the 110 NIST SP 800-171 controls. |

---

## KILLED / REMOVED

> These were in the old capability map. They are gone. Do not re-add them.

| Capability | Why Removed |
|---|---|
| Command Deck command palette | Intentionally killed. User directive: "Forget command palette." No Cmd+K, no FAB, no `window.DataGlowPalette`. |
| Gemma3-270M reflex model | Does not exist as a web-llm prebuilt. No `gemma3-270m*-MLC` entry in web-llm 0.2.84 config. |
| Qwen3.5 upgrade path | No web-llm build exists as of July 2026. Dead end. Revisit Q1 2027. |
| Prophet WASM time-series | No WASM port exists. No working implementation. Use Chronos-2-ONNX instead. |
| AutoML auto-model selection | Rejected by design. DataGlow does not auto-select models. Analyst picks, DataGlow executes. Guided selection only. |
| STL decomposition WASM | Not found as a standalone WASM package. Use Pyodide + statsmodels (already available) for this. |

---

## UNLISTED MODULES (New Additions to This Map)

> These 20 modules were in the bundle but missing from every previous version of this file.

| Module | What it does |
|---|---|
| | Ranked list of recommended cleaning actions |
| | Single 0-100 dataset health score |
| | Right-rail proof chain timeline UI |
| | WebLLM / MLC-AI engine (Qwen2.5-Coder-3B) |
| | Wires LLM into tabs and event system |
| | Shadow Analyst / Intent Layer |
| | Portfolio artifact export |
| | App startup, error boundaries, platform detection |
| | 1:1 / 1:many / many:many detection before joins |
| | Live streaming data connection layer |
| | 8-tool MCP server for external AI agents |
| | Mobile + desktop navigation layer |
| | Signs and timestamps proof artifacts |
| | Central proof chain coordinator |
| | Local RAG knowledge base (32 entries) |
| | Cryptographic receipt generator |
| | OPFS persistent local storage engine |
| | OPFS-backed project workspace |
| | OPFS-backed analyst profile |
| | Routes proof chain into every export |

---

*Last updated: July 21, 2026. Audit method: cross-referenced 195 bundle module markers against all `js/` references in the old capability map. Ground truth is the bundle -- not the old map.*


## Manifest file index (auto-synced PR #559)

The following paths are declared in `capability-map.manifest.json` and are listed here so the capability-map drift gate stays honest.

- `canvas/snapshot.html` — Publish Button (PR AG — one-click shareable snapshot URL, client-side gzip + base64url encoding, zero server upload) (missing-on-disk)
- `js/agents/agent-action-firewall.js` — Agent Action Firewall — human-confirmation gate for data mutations (present)
- `js/agents/chart-context-timeline.js` — Chart-context timeline (Batch 3) (present)
- `js/agents/conversational-pack-ui.js` — Guided pack builder — Validate-tab UI wiring (present)
- `js/agents/debate-diagnostics.js` — Debate transparency diagnostics (present)
- `js/agents/live-rooms-broadcast.js` — Live Rooms action-item broadcast (Batch 2) (present)
- `js/agents/meeting-decision-ledger-ui.js` — Meeting decision ledger — Meeting-tab browse/save UI wiring (present)
- `js/agents/open-floor-room.js` — Open Floor read-only room kernel + PHI prompt guard (present)
- `js/agents/pack-builder-agent.js` — Guided pack builder (present)
- `js/agents/question-generator-agent.js` — Data-grounded question generator (present)
- `js/ambient/ambient-validation.worker.js` — Live validation (present)
- `js/ambient/watch-folder.js` — Live validation (present)
- `js/anomaly/ondevice-ml.js` — Detectors (present)
- `js/app-shell/command-deck-nav.js` — Command Deck sidebar nav (Part 1) (present)
- `js/app-shell/command-palette.js` — Command Deck command palette (Part 2) (present)
- `js/app-shell/databricks-connect.js` — Warehouse import (present)
- `js/app-shell/duckdb-config.js` — DuckDB WASM configuration (present)
- `js/app-shell/duckdb-engine.js` — Query engine (present)
- `js/app-shell/glow-path-ui.js` — Glow Path adaptive next-action rail (Batch A) (present)
- `js/app-shell/glow-path.js` — Glow Path adaptive next-action rail (Batch A) (present)
- `js/app-shell/loaders.js` — File loading (present)
- `js/app-shell/state.js` — State & helpers (present)
- `js/app-shell/tab-groups.js` — Grouped tab navigation (present)
- `js/app-shell/utils.js` — State & helpers (present)
- `js/app-shell/validate-focus.js` — Validate tab focus mode (present)
- `js/audio/whisper-worker.scaffold.js` — Audio ingestion structurer (Whisper → structured transcript dataset) (present)
- `js/build/build-flags.js` — Build feature flags (present)
- `js/build/enterprise-policy.js` — Enterprise policy engine (present)
- `js/cleaning-crew/pdf-profiler.js` — Cleaning Crew — Profiler station (PDF text extraction, Batch 1) (present)
- `js/cleaning/clean.js` — Core cleaning (present)
- `js/connectors/tauri-connector.js` — Tauri Live Connector Layer (present)
- `js/council/council-ui.js` — Council tab UI (present)
- `js/dashboard/dashboard-engine.js` — Dashboard View (PR AN — readiness-gated KPI cards + bar/line charts, RAG-colored, research-grounded layout rules) (present)
- `js/drill-floor/drill-diff.js` — Drill Floor (SQL/Python/R practice drills; Batch 1: Spot the Sale, Batch 2: cross-language result diff) (present)
- `js/drill-floor/drill-floor-data.js` — Drill Floor (SQL/Python/R practice drills; Batch 1: Spot the Sale, Batch 2: cross-language result diff) (present)
- `js/federated/federated-fingerprint.js` — Core & transport (present)
- `js/federated/federated-learning.js` — Core & transport (present)
- `js/federated/federated-transport.js` — Core & transport (present)
- `js/gate/readiness-gate-ui.js` — AI Readiness Gate (pure scoring + UI badge + agent hard-block, batches 1-3 of 4) (present)
- `js/glow/glow-orb-ui.js` — The Glow topbar orb UI (Batch 2) (present)
- `js/glow/glow-signal.js` — The Glow signal aggregator (Batch 1) (present)
- `js/grid/formula-bridge.js` — DataGlow Grid formula bridge (Excel formula ↔ DuckDB SQL, documentation/audit layer) (present)
- `js/grid/grid-bridge.js` — DataGlow Grid bridge (Univer data contract, Tier 1 of DataGlow Canvas) (present)
- `js/grid/pivot-engine.js` — DataGlow Grid pivot engine (Univer pivot tables, builds on the grid bridge) (present)
- `js/grid/validation-coloring.js` — DataGlow Grid validation coloring (cell/row-level styling, agent diff overlay) (present)
- `js/join-builder/join-model.js` — Join model (present)
- `js/join-builder/join-sql.js` — Join SQL generator (present)
- `js/mcp/dataglow-mcp-server.mjs` — MCP server (present)
- `js/metrics/metric-contracts.js` — Metric Contracts (Batch 1: versioned data model) (present)
- `js/nats/nats-message-parser.js` — NATS WebSocket Bridge (present)
- `js/packs/builtin/fhir.pack.js` — Domain-pack plugin architecture (present)
- `js/packs/builtin/finance.pack.js` — Domain-pack plugin architecture (present)
- `js/packs/builtin/healthcare.pack.js` — Domain-pack plugin architecture (present)
- `js/packs/builtin/none.pack.js` — Domain-pack plugin architecture (present)
- `js/packs/builtin/omop.pack.js` — Domain-pack plugin architecture (present)
- `js/packs/builtin/retail.pack.js` — Domain-pack plugin architecture (present)
- `js/packs/local-pack-index.js` — Local peer-sourced pack index (present)
- `js/packs/pack-network-guard.js` — Domain-pack plugin architecture (present)
- `js/packs/pack-registry.js` — Domain-pack plugin architecture (present)
- `js/pdf/pdfjs-extractor.scaffold.js` — PDF ingestion bridge (PDF.js → RAG pipeline) (present)
- `js/portfolio/narrative-assembler.js` — Portfolio Narrative assembler (stitches Problem Framer + Story + Clean summary + recommendation into one exportable write-up) (present)
- `js/portfolio/portfolio-ui.js` — Portfolio Narrative assembler (stitches Problem Framer + Story + Clean summary + recommendation into one exportable write-up) (present)
- `js/protocol/protocol-conformance.js` — Conformance (present)
- `js/provenance/provenance.js` — Chain of custody (present)
- `js/provenance/query-memory-ui.js` — Query Memory (Batch 2 — SQL/Python/R wiring + "seen before" badge) (present)
- `js/provenance/query-memory.js` — Query Memory (Batch 2 — SQL/Python/R wiring + "seen before" badge) (present)
- `js/provenance/revert-eligibility.js` — The Crucible: revert proposals (Batch 3, proposal-only) (present)
- `js/questions/question-prompter.js` — Question Prompter (Feature 13 — "Where to start" intelligence) (present)
- `js/rag/rag-core.js` — RAG core (chunker, cosine similarity, retrieval) (present)
- `js/rag/rag-validation-bridge.js` — RAG validation bridge (citation injection) (present)
- `js/rag/user-knowledge-store.js` — User Knowledge Store (in-memory RAG index) (present)
- `js/rooms/room-broadcast.js` — Object Space broadcast wiring (Batch 2 of 4) (present)
- `js/rooms/room-transport-adapter.js` — Real signaling + data-channel adapters (Batch 4 of 4) (present)
- `js/rooms/room-ui.js` — Topbar UI layer (Batch 3 of 4) (present)
- `js/rulepacks/packs/general.js` — General rulepack (present)
- `js/rulepacks/packs/healthcare.js` — Healthcare rulepack (present)
- `js/runtimes-viz/python-runtime.js` — Runtimes & charts (present)
- `js/runtimes-viz/r-runtime.js` — Runtimes & charts (present)
- `js/shared/identifier-columns.js` — Targeted transforms (present)
- `js/validation/crucible-adversarial-packs.js` — The Crucible: adversarial validator (Batch 1) (present)
- `js/validation/crucible-orchestrator.js` — The Crucible: orchestration glue (additive-only) (present)
- `js/validation/crucible-ui.js` — The Crucible: read-only UI (Batch 2) (present)
- `js/validation/expected-range.js` — Reinterpretation & context (present)
- `js/validation/missingness.js` — Standalone layer modules (present)
- `js/validation/query-sentinel-assist.js` — Query Sentinel Assist (Batch 2) — bounded on-device explain & fix-suggest (present)
- `js/validation/query-sentinel-bridge.js` — Query Sentinel Bridge (Batch 3, final) — FROM py./r. cross-runtime table resolver (present)
- `js/validation/semantic-layer-ui.js` — Semantic / Metrics Layer (present)
- `js/validation/source-convergence-ingestion.js` — Source Convergence ingestion adapters (Truth Network, Batch 2) (present)
- `js/validation/source-convergence-ui.js` — Source Convergence UI (Truth Network, Batch 3) (present)
- `js/validation/validation.js` — Orchestrator (present)
- `js/video/webcodecs-audio-extractor.scaffold.js` — Video ingestion bridge (audio-only, Batch 1) (present)
- `js/webhook/service-worker-relay.js` — Validation Webhook Mode (present)

### PHI Shield
On-device Safe Harbor sample screen + PhiPromptGuard patterns. Web, desktop, PWA. Not a HIPAA certification.

### Shield Packs
One calm on-device surface listing domain privacy packs, so a regulated user picks a posture instead of walking a settings maze. Pure registry + detectors `js/intelligence/shield-packs.js` (`window.DataGlowShieldPacks`: listPacks/getPack/detectPatterns/scanColumnSamples/posture/postureCopy) has no DOM, no storage, and no network, and is covered by `test/shield-packs.test.mjs` plus the `shield-packs-registry-posture` and `shield-packs-detectors` golden cases. Pack 0 is the existing PHI Shield, reused rather than reimplemented: its record carries no detectors of its own and the panel links straight into `window.DataGlowPhiShield`, so the independent `phiShield` flag keeps working on its own. Three further packs ship real rules and a real posture: Finance PII (SSN, EIN, routing, card, IBAN and account shapes, detect and flag only), Privilege labels (attorney-client, work-product and legal-hold wording, raising an export caution and optional column tagging, a screening aid and not legal advice), and Justice sensitive (a CJIS-style shell that fails closed, blocking the AI and export paths and raising a high-sensitivity banner while active). `detectPatterns` and `scanColumnSamples` return match counts only, never the matched values, so a finding can be logged without leaking data. Canvas UI `js/intelligence/data-glow-shield-packs-canvas.js` (`window.DataGlowShieldPacksUI`, button `#dg-shield-packs-btn`, panel `#dg-shield-packs-panel`, banner `#dg-shield-packs-banner`) exposes `allowAi()` / `allowExport()` as the fail-closed guards callers check, activates packs for the session only with nothing written to storage, and keeps 44px touch targets with no em dash in any copy. Behind the `shieldPacks` flag; web, desktop, PWA. Screening aid only, not a compliance certification.

### Air-Gap Mode
One switch for a room where data must not leave. Pure posture engine `js/privacy/air-gap-mode.js` (`window.DataGlowAirGap`: isAirGapActive/activate/deactivate/shouldBlockNetwork/classifyFeature/classifyRequestUrl/listLocalFeatures/listEgressFeatures/getPosture/postureCopy/resetAirGapSession) holds no DOM, no network and no storage, and is covered by `test/air-gap-mode.test.mjs` plus the `air-gap-posture` golden case. The posture is session-scoped and in-memory only: reload and the switch is off again, because a privacy promise that silently survives into a session the user did not ask for is worse than no promise. It fails closed. `shouldBlockNetwork` allows a fixed on-device allowlist (DuckDB, SQL, Python, R, charts, pivot, local file, local export, validation) and blocks everything else, so a feature added next quarter is blocked by default rather than accidentally permitted. AI, MCP and server offload are named explicitly, alongside CDN runtime downloads, telemetry, Rooms and federated learning.

Canvas UI `js/privacy/data-glow-air-gap-canvas.js` (`window.DataGlowAirGapUI`, button `#dg-air-gap-btn` next to the Shield Packs button, panel `#dg-air-gap-panel`, banner `#dg-air-gap-banner`) publishes `allowNetwork(feature)` / `allowAi()` / `allowMcp()` / `allowServerOffload()` as the guards a call site checks before it acts, and gives the toggle teeth by swapping `window.fetch` and `XMLHttpRequest.prototype.open` for wrappers that refuse cross-origin requests with an `AirGapBlockedError` while the mode is on. Same-origin requests stay open so the self-hosted DuckDB-WASM, Plotly and SheetJS assets keep loading and local engines keep working; turning the mode off restores both primitives. Posture changes raise `dataglow:air-gap-posture` and a block raises `dataglow:air-gap-blocked` rather than writing to ProvenanceFabric, whose ProofChain mirror can recurse on append. 44px touch targets, dark tokens, no em dash in any copy. `test/air-gap-canvas-ui.test.mjs` proves the whole path in real headless Chrome: the explicit opt-out and a flags provider reporting the flag disabled both stay off, a default load mounts the surface, then it opens, toggles, blocks a cross-origin request while a same-origin one still succeeds, and restores. The `airGapMode` flag ships ON, so the toggle is present on every load; engaging the block is still the user's own session choice, and `window.DATAGLOW_AIR_GAP = false` keeps the surface off entirely. Web, desktop, PWA. Not a firewall: it governs what DataGlow itself does, not what the operating system or another tab does.

### Trust Ledger
Every trust signal DataGlow produced already existed somewhere, but a person had no single calm place to read what this session actually did. The Trust Ledger is that place. Pure engine `js/provenance/trust-ledger.js` (`window.DataGlowTrustLedgerEngine`: createTrustLedger/verifyTrustLedger/exportTrustLedger/describeTrustEntry/summarizeTrustLedger/countTrustKinds/formatTrustTime plus the fromReadinessGate, fromContractVersion and fromPublishSafe composers) holds no DOM, no storage and no network, and is covered by `test/trust-ledger.test.mjs`. It composes the existing provenance rather than inventing a parallel crypto stack: the same SHA-256 over `crypto.subtle`, the same 64-zero genesis anchor and the same canonical-JSON discipline as `js/provenance/provenance.js` and the AI Touch Ledger. A test pins the digest against `provenance.js` input for input, so the two cannot silently drift apart.

Four event kinds only, a closed vocabulary: a validation run, a metric contract version, an export attempt, a gate verdict. Malformed input is appended as a visibly refused row rather than dropped, because a ledger that quietly skips what it could not parse is worse than one that admits the gap, and a refused row is still hashed into the chain so it cannot be edited away either. `verifyTrustLedger` re-walks the chain and returns `{valid, reason}` without ever throwing, catching an edited summary, an edited detail value, a deletion and a reorder. The composers exist so a caller hands over what it already produced instead of inventing ledger vocabulary at the call site.

Canvas UI `js/provenance/data-glow-trust-ledger-canvas.js` (`window.DataGlowTrustLedger`, button `#dg-trust-ledger-btn` next to Air-Gap, panel `#dg-trust-ledger-panel`) shows each row as a time, a house label, an outcome chip and the first 16 characters of its hash, with a Verify the chain button and Save as text, Markdown or JSON. It listens only to events the app genuinely fires today (`dataglow:pulse-scored`, `dataglow:export-triggered`); nothing is invented so the ledger looks busy, and the Save-as-app sheet calls `record()` itself because it is the only surface holding the Publish-Safe verdict, which is also why this module does not listen for `dataglow:notebook-app-saved` and double-count the same save. It never persists and it never edits a row: the panel is a reader over an append-only chain, so closing the tab ends it and the export buttons are the only way a row leaves. The API is published even when the flag is off, so an explicit caller does not have to know whether a panel exists. `test/trust-ledger-canvas-ui.test.mjs` proves the path in real headless Chrome, including that a tampered row fails verification and that one save appends exactly one row. Ships ON via the `trustLedger` flag; web, desktop, PWA. A record of what this session did, not an audit certification.

### Publish-Safe
DataGlow already knew, separately, most of what it needed to know before a file left: PHI Shield knew whether the text held anything sensitive, the readiness gate knew whether the dataset held up, Metric Contracts knew whether a definition was still the agreed one, and Air-Gap Mode knew whether the human had asked for nothing to cross the network. Every export path had to remember to ask all four in the right order, and none of them asked all four. Pure engine `js/gate/publish-safe.js` (`window.DataGlowPublishSafeEngine`: evaluatePublishSafe/describePublishSafe/publishSafeBadge/normalizeDestination) is the single place that combines them into one verdict a person can read before they press the button, and is covered by `test/publish-safe.test.mjs`.

The rules, and why each sits where it does. Sensitive values plus a destination off this device is the one hard refusal, because it is the only case where being wrong is unrecoverable: a file that has left cannot be unshared. Sensitive values staying on this device is a caution with the safer default preselected, not a refusal, because the human owns the disk and refusing would be theatre. Air-Gap Mode plus a destination off this device is refused, since that is exactly the crossing the mode exists to prevent, while a local write is explicitly allowed and says why. Failing readiness or a drifted metric definition is a caution and never a block: both are quality signals about the numbers rather than privacy ones, and a human is allowed to export a draft they know is a draft. Missing evidence is never a clear, so no PHI scan or no readiness result produces a caution naming the check that could not run; a gate that reports "fine" when it did not look is worse than no gate. A caller whose artifact genuinely has no dataset behind it must say so out loud by passing `readiness: 'not-applicable'`, and cannot get that by staying quiet.

It gathers no evidence of its own, on purpose: every input is passed in by the surface that already had it, so the file has no idea what a window is. It mutates nothing, writes nothing, and decides nothing on the human's behalf, returning a verdict plus a suggested safer default that the caller still has to show and wait on. It is wired into the "Save as app" confirm sheet, where the verdict appears above the choice in its own styling (deliberately not the PHI warn styling, which means something more specific in that sheet), drives the results preselect, and is recorded into the Trust Ledger when a file is actually written. Note honestly that there is no off-device export path anywhere in the tree today, so the refusal branch guards the Air-Gap egress case and any destination added later rather than a path that ships now. Behind the `publishSafe` flag; web, desktop, PWA. A gate over the checks it was given, not a guarantee about what it was never shown.

### Metric Contract Status
`js/gate/readiness-gate.js` has always taken a `metricContractStatus` as its second argument and always refused to call a dataset agent-consumable when that status said a contract was broken. Nothing in the running app produced the object, so the check was wired and permanently fed null: `state.metricContractStatus` had five readers (the readiness badge, the trust certificate, the agent gate, the guarded copilot and the MCP gate exporter) and zero writers, and a metric whose live definition had drifted away from its own recorded latest version passed readiness silently. Pure engine `js/metrics/metric-contract-status.js` (`window.DataGlowMetricContractStatus`: computeMetricContractStatus/summarizeMetricContractStatus/describeMetricContractStatus) is the producer, covered by `test/metric-contract-status.test.mjs`, and `js/app-shell/main.js` now assigns it whenever a definition is saved.

Broken is defined the only way the data model can honestly support: the definition the app is using right now no longer matches the latest version recorded in that metric's own history. A metric with no recorded history at all is untracked and not violated, because contracts are opt-in and counting every existing metric as broken the day the feature shipped would teach people to ignore the signal. A metric whose history has several versions is not broken either, since change is the point; only the gap between the live definition and the newest recorded one matters. Scoped honestly: every human save path in Metric Studio already calls the version recorder in the same breath, so drift is not reachable through the UI today, and the immediate value is turning "contracts were not checked" into "every contracted definition still matches", which is a different and more useful sentence. It becomes a real alarm the moment any writer reaches `MetricRegistry.update()` without recording a version, whether that is an approved agent proposal, an import, or a new surface that forgets the hook, and the tests pin that case rather than assuming it stays hypothetical. It reads only and records nothing, because recording a version is a human-confirmed mutation that stays on the save path. Gated by the existing `metricContracts` flag; web and desktop.

### Mobile PHI chip + first-run calm
A calm chrome pass over PHI Shield (not a redesign, no new detection). Pure helper `js/intelligence/mobile-phi-firstrun-calm.js` (`window.DataGlowMobilePhiFirstRunCalm`: isFirstRun/markFirstRunSeen/chipLabel/shouldShowCalmStrip/calmCopy) has no DOM or network: `chipLabel(status)` returns short, never-blank privacy labels safe at ~375px (`On device`, `PHI clear`, `PHI risk`, `PHI review`, `PHI · n`), the first-run marker uses localStorage (storage is injectable for Node tests and fails open to first-run when unreachable), and `calmCopy()` carries the on-device promise with no em dash. Canvas UI `js/intelligence/data-glow-mobile-phi-firstrun-canvas.js` (`window.DataGlowMobilePhiFirstRunUI`) progressively enhances the existing `#dg-phi-shield-btn` with a 44px, safe-area-aware `dg-phi-chip-mobile` class and mounts a quiet first-run strip `#dg-firstrun-calm-strip` (on-device line + one "Drop a file or browse" CTA + dismiss X, no auto-dismiss timer), shown only when the flag is on, no dataset is loaded, and first-run is not yet dismissed; dismiss or a loaded dataset marks it seen. Behind the `mobilePhiFirstRunCalm` flag; web, desktop, PWA.

### Explain
DataGlow had accumulated a lot of checks and no single place that said, in a sentence a person could read, what they collectively meant. Query Sentinel knew whether the query was sound, the readiness gate knew whether the dataset held up, PHI Shield knew whether anything sensitive was in the text, Air-Gap Mode knew whether the network was closed, Publish-Safe knew whether a file could leave and the Trust Ledger knew what had happened. Reading all six meant opening six panels and knowing which six to open. Pure engine `js/explain/explain-engine.js` (`window.DataGlowExplainEngine`: explainResult/describeExplanation/explainBadge plus one composer per source) turns whatever those sources reported into one calm explanation, and is covered by `test/explain-engine.test.mjs`.

It composes and never computes. The engine gathers no evidence and runs no check: a caller hands it what already ran, and every sentence in the output traces to a named source. That constraint is the whole design. An explainer that could go and look would eventually be tempted to estimate, and an estimate written in the same calm voice as a measurement is indistinguishable from one.

Confidence is derived, not asserted. `well-evidenced` requires every source to have answered; `partly-evidenced` covers the ordinary case where some did not; `unevidenced` is returned when the sources that answered are a clear minority of those asked, so a panel resting on two checks out of seven cannot present itself as authoritative merely because those two were green. A source that could not run is listed by name as an unknown. It is never omitted, because a missing check that vanishes from the output reads to a human as a check that passed, and that single silent failure would make every other sentence on the panel worthless.

Canvas UI `js/explain/data-glow-explain-canvas.js` (`window.DataGlowExplain`, button `#dg-explain-btn` beside Trust and Air-Gap, panel `#dg-explain-panel`) reads posture off the namespaces those gates already publish, offers the explanation as copyable plain text, and closes on Escape like the other drawers. It deliberately reads the same gates GlassBox reads, through the same call, which is what makes it structurally impossible for the plain-language summary and the show-the-math block to tell a person two different things. Nothing touches the network, so the panel behaves identically with Air-Gap Mode on. The API is published even when the flag is off, so a caller need not know whether a panel exists. Ships ON via the `explain` flag; web, desktop, PWA. An account of what the checks saw, not a verdict on what they were never shown.

### GlassBox
A result with no way to see the work behind it asks to be trusted on nothing. Several surfaces showed a table and kept the query that produced it somewhere else on the page, or nowhere. Pure engine `js/glassbox/glass-box.js` (`window.DataGlowGlassBoxEngine`: buildGlassBox/renderGlassBoxText/glassBoxToggleLabel/truncateSource/glassBoxBadges) owns the shape: finding on top, proof underneath, the same way every time, covered by `test/glass-box.test.mjs`.

The proof is the code that actually ran, read from the paired editor at the moment the block is opened. Nothing is reconstructed and nothing is cached. A reconstructed query would look exactly as checkable as a real one and could be wrong, which is worse than the block saying plainly that it has nothing to show. Source longer than 60 lines truncates with the true line count kept beside it, so the panel is never quietly partial.

Badges are read, never graded. Each chip comes from a gate that already ran, and a gate that is absent produces no chip at all rather than a passing one; the model then states out loud that an absence of evidence is not a clean result. Two gates publish a readable posture today (Air-Gap Mode and PHI Shield) and are read directly. Query Sentinel and the readiness gate publish their functions but not their results, so they are left to an explicit `provide()` hand-over from a surface that holds one. Re-deriving them from whatever the DOM happens to show would be a guess wearing a badge.

Canvas UI `js/glassbox/data-glow-glass-box-canvas.js` (`window.DataGlowGlassBox`, blocks `#dg-gb-sql-view`, `#dg-gb-sql-tab`, `#dg-gb-py-view`) mounts under the three real result surfaces and learns that a result arrived from a `MutationObserver` on each result body, because the renderers are private closures that fire no event and watching the DOM is the only way to react without rewriting them. Guided Unpivot is deliberately left alone: it already has its own glass-box toggle, and two answers to one question is worse than one. `test/explain-glassbox-canvas-ui.test.mjs` proves in real headless Chrome that the code shown is byte-identical to the editor above it, that the finding sits above the proof in document order, and that no gate yields no chip. Ships ON via the `glassBox` flag; web, desktop, PWA. It shows the work; it does not re-run it and it does not grade it.

### Excel Hell Repair
Drop any messy spreadsheet and DataGlow detects the real header, strips junk title/blank/footer rows, collapses multi-row headers, and coerces column types into a reversible, refreshable recipe. Pure engine `js/intelligence/excel-hell-repair.js` (`window.DataGlowExcelHellRepair`: detect/preview/apply/undo/refresh) with the canvas panel in `js/intelligence/data-glow-excel-hell-canvas.js` (`window.DataGlowExcelHell`). Preview-first; Apply requires an explicit click; undo restores the pre-image. Web, desktop, PWA. Screening aid for messy files - review before clinical use.

### Repair Recipe Library
A repair recipe used to die with the session. The Repair Recipe Library saves an Excel Hell (or Guided Unpivot) recipe under a human name so it can be reapplied to the next file of the same shape family. Pure engine `js/intelligence/repair-recipe-library.js` (`window.DataGlowRepairRecipeLibrary`: createRecipeRecord/validateRecord/serializeLibrary/parseLibrary/scoreRecipeMatch/getApplyPayload/sortRecipes/filterRecipes) holds the CRUD + match-scoring logic with no DOM and no network. Persistence lives in `js/intelligence/repair-recipe-store.js` (`window.DataGlowRepairRecipeStore`), a standalone IndexedDB database (`dataglow-repair-recipes`) with a memory-store fallback for Node and IDB-less runtimes, chosen so shipping this never bumps the shared memory-store DB version. The canvas panel `js/intelligence/data-glow-repair-recipe-library-canvas.js` (`window.DataGlowRepairRecipeLibraryUI`, panel `#dg-recipe-library-panel`) adds Save recipe / Open library buttons to the Excel Hell panel, lists saved recipes with a match score against the active dataset, and reapplies with a preview first and a click-only Apply. Records are metadata only (steps + column names) and never contain raw rows; the engine strips row-bearing fields on save and rejects them on validate. Behind the `repairRecipeLibrary` flag; web, desktop, PWA.

## Registry and scaffold tooling

### Capability registry as data
`capability-map.manifest.json` is the machine-readable answer to "what does DataGlow actually do, and is that claim real?". Alongside the existing drift detector (`.github/scripts/capability-drift.mjs`), which proves the files behind a capability exist, `scripts/check-capability-map.mjs` proves the claim around them is honest. Every capability normalizes to five fields a consumer can rely on: `id`, `title` (the manifest `name`), `status`, `relatedFlags` and `platforms`.

Two of those are derived rather than authored. `relatedFlags` is the declared list unioned with every flag in `flags.manifest.json` whose camelCase name kebab-cases onto the capability id (`airGapMode` to `air-gap-mode`), so a capability cannot quietly drop its flag link. `status` is then computed: `shipped` when every backing file exists and every related flag ships enabled or there is no flag at all, `behind-flag` when any related flag ships disabled or does not exist. Because the derived values are re-computed on every run and compared against what is committed, a capability cannot claim `shipped` while its flag ships off, and flipping a flag off without updating the map fails CI instead of leaving a stale claim in the docs. That is the point: no fake shipped claims. Run `npm run check:capability-map` to verify and `npm run check:capability-map -- --update` after a deliberate change; `npm run test:capmap` (`test/capability-map.test.mjs`) covers the derivation helpers and the committed manifest. The manifest keeps the runtime platform vocabulary `browser` / `desktop` / `mobile` that `js/app-shell/capability-registry.js` reads and the drift gate enforces, where `browser` is the web surface and the installed PWA (same code, same origin, one manifest) and `mobile` is the forward-looking Tauri mobile target.

### New module scaffold
Every module under `js/` has to clear the same four gates, and all four are easy to miss when starting a file from scratch: it must parse under `node --check`, it must use the outer-IIFE convention so the inlined canvas copy cannot leak names, its canvas copy must be delimited by `/* ---- from <path> ---- */` markers for `scripts/check-canvas-integrity.mjs` to pin, and it must be claimed by a capability or the drift detector fails with `UNDOCUMENTED_MODULE`. `npm run new-module -- js/<area>/<name>.js` writes a stub that already satisfies the first three and prints the remaining steps for the fourth. `--esm` emits a pure ES module instead (the shape a logic engine wants, since `inject_*.py` strips the export keywords when inlining), `--no-markers` drops the marker pair, and `--dry-run` prints without writing.

The scaffold never touches `canvas/index.html`. Inlining stays a deliberate act performed by an `inject_*.py` script, so a scaffolded file cannot change the shipped bundle by accident and `npm run check:canvas-integrity` is unaffected until the module is inlined on purpose. `node scripts/new-module.mjs --help` documents that promote path end to end: write `inject_<feature>.py` modelled on `inject_shield_packs.py` or `inject_air_gap_mode.py`, insert before `window.addEventListener('appinstalled'`, run it once (the scripts refuse to run twice so a block cannot be duplicated), add the module to `canvas/integrity.manifest.json` under `tracked`, then `npm run check:canvas-integrity -- --update` to record the source and inlined hashes. `npm run test:newmodule` (`test/new-module.test.mjs`) runs the emitted text through `node --check` for both shapes, so the scaffold can never start a feature with a red parse.
