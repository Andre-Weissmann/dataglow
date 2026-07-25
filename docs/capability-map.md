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
| Proof Board (numbers with the query under each) | `js/proofboard/proof-board.js`<br>`js/proofboard/session-tiles.js`<br>`js/proofboard/data-glow-proof-board-canvas.js`<br>`test/proof-board.test.mjs` | LIVE | HIGH | Several numbers on one surface, each carrying the query that produced it in the same tile, behind a Proof button next to the Trust Ledger. Tiles are arithmetic over the rows in memory with the equivalent SQL printed beside them, and the tests pin the two against each other. Nothing is seeded: with no dataset the grid shows its empty state and one call to action, because a demo number on a board whose promise is that every number shows its work is a fabricated proof. There is no default value and no zero fallback anywhere. A malformed tile is kept and marked incomplete rather than dropped. Verify board checks only what the board holds and names what it cannot check; it never re-runs a query. Flag `proofBoard`. |
| Not-checked as a first-class badge | `js/proofboard/proof-board.js`<br>`js/proofboard/data-glow-proof-board-canvas.js`<br>`test/proof-board.test.mjs` | LIVE | HIGH | Four badge values, not two. A green tick or nothing turns "no check has run" into "this passed", so `unknown` has its own wording and says it is an absence of evidence. The badge is read off a real gate result when one is supplied, and a tile labelled `clear` while carrying a blocked verdict shows the verdict with the disagreement recorded on it. The tile badge is never forged into a Publish-Safe gate for GlassBox, so a tile with no gate result shows the absence instead of a chip no gate produced. Flag `proofBoard`. |
| Glowbook portable export | `js/proofboard/glowbook.js`<br>`js/proofboard/data-glow-proof-board-canvas.js`<br>`test/proof-board.test.mjs` | LIVE | HIGH | The board as one self-contained HTML file on the person's own disk: no script, no stylesheet link, no iframe, nothing that loads or sends. Written only after a human confirms, never automatically. Every tile is finding first then proof, the same order as the panel. The disclaimer is emitted from a constant a caller cannot edit away and states that this is not a certification, not an audit, not a compliance claim and not legal or clinical advice, plus a separate line saying the proof is readable code and not a cryptographic proof. Flag `proofBoard`. |
| Proof Board coach strip | `js/proofboard/coach-moments.js`<br>`js/proofboard/data-glow-proof-board-canvas.js`<br>`test/proof-board.test.mjs` | LIVE | MED | Five short steps as data, pointing at real controls in the panel. Nothing is dimmed, nothing is blocked, no video and no CDN. A step whose target is missing is skipped rather than pointed at empty space. Dismissed once, gone for good. Flag `proofBoardCoach`. |
| Tile receipt claim (composes, does not re-invent) | `js/proofboard/proof-board.js`<br>`js/proofboard/data-glow-proof-board-canvas.js`<br>`test/proof-board.test.mjs` | LIVE | HIGH | Assembles the claim only: label, value, statement, query chain, validation state at compute, dataset fingerprint. No hash and no commitment, because the Trust Ledger already owns the chain and a second one would be a competing record of the same session. Stamping asks the person first. Portable receipts and the Proof Room are feature-detected, so a build without them shows no button rather than a dead one. Flag `proofBoard`. |
| Prove gate (no unproven numbers) | `js/ai/prove-gate.js`<br>`test/proof-to-post.test.mjs` | LIVE | MOAT | Every number in a generated or assembled claim must bind to a Proof Board tile or an engine result, and the ones that do not are named rather than softened. Tolerance is an exact match or a correct rounding to the precision the author wrote, and nothing else. A `blocked` tile refuses outright; an `unknown` tile binds with a caution, because no check having run is not a pass. ISO dates, clock times and version strings are masked before extraction so the gate does not refuse its own method line. No override. Flag `aiProveGate`. |
| Proof to Post loop | `js/proofpost/proof-to-post.js`<br>`js/proofpost/data-glow-proof-to-post-canvas.js`<br>`test/proof-to-post.test.mjs` | LIVE | MOAT | The draft is assembled from Proof Board tiles and nothing else, then run back through the prove gate anyway. `NEVER_AUTO_POST` is a constant, not a setting: no connected account, no posting API, no outbound request. The transparency line is computed from the badges actually present, so the post cannot claim its numbers were engine-checked when some were not. Copy draft needs a passing gate and a ticked review box. Flag `proofToPost`. |
| BI hand-off pack (Power BI / Tableau) | `js/export/bi-handoff.js`<br>`js/proofpost/data-glow-proof-to-post-canvas.js`<br>`test/proof-to-post.test.mjs` | LIVE | HIGH | Five plain files: `data.csv`, `dictionary.md`, `queries.sql`, `validation-summary.md`, `README-handoff.md`. No zip, because a compression dependency turns five readable files into one opaque archive for no gain the recipient feels. The CSV neutralises leading formula characters. The validation summary reports a null rate over zero rows as not known rather than zero. Not a certified deliverable and it says so first. Download asks first. Flag `biHandoff`. |
| De-id screening receipt | `js/privacy/deid-receipt.js`<br>`js/provenance/deidentification-verifier.js`<br>`test/proof-to-post.test.mjs` | LIVE | HIGH | A readable record of what the existing Safe Harbor verifier looked at and found, in markdown or one self-contained HTML file. Computes no verdict of its own. The engine's `pass` is printed as "Nothing was flagged by this screen" and never as a bare pass, because a receipt gets forwarded as evidence. The non-certification disclaimer comes from a constant a caller cannot remove. Not a HIPAA certification and not safe-to-release. Download asks first. Flag `deidReceipt`. |
| NL to SQL: Add to Proof Board | `js/nl-sql/nl-sql-ui.js`<br>`js/proofboard/data-glow-proof-board-canvas.js` | LIVE | HIGH | The SQL was already shown before running; this keeps the number read off the result as a tile carrying that query. The value is typed by the person who read it and never guessed: a blank box adds nothing rather than a zero, and the confirm says the tile will carry the not-checked badge until a check runs. Added tiles survive a board rebuild. Flag `nlSql`. |
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
| Built-in AI status | `js/ai/local-ai-status.js` + `js/ai/data-glow-local-ai-canvas.js` | LIVE | MOAT | Persistent chip deriving one of six honest on-device states from WebGPU, model loadedness, Air-Gap Mode and cache. |
| Local model registry | `js/ai/local-ai-status.js` | LIVE | HIGH | Five considered models with size, licence and per-platform notes. Exactly one is marked shipped. |
| AI claim guard | `js/ai/ai-claim-guard.js` | LIVE | MOAT | Discards a Tier 2 rephrase that introduces a number the deterministic answer did not produce. |
| Ambient proof strip | `js/ambient/ambient-proof-strip.js` | LIVE | MOAT | Continuous proof reporting that answers no question about the data. |
| Capability ceiling | `js/ai/capability-ceiling.js` | LIVE | HIGH | What this machine can do, with a does-not line for every does line. |
| Polars secondary path | `js/polyglot/polars-path.js` | LIVE | MED | Status only: available, not installed, or not applicable. DuckDB is never replaced. |
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
| Compare to prior period | `js/transforms/prior-period.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Month over month, week over week or day over day, per entity if the table has one, with the prior value, the delta and the percent change beside each period. Prior means the previous CALENDAR period, not the previous row, so a gap yields a blank prior and a plain note instead of comparing March against January. Percent change is blank rather than infinite when the prior is zero. Glass-box SQL is a self `LEFT JOIN` on the stepped-back period key. Preview-first; Apply needs two clicks and is reversible via Undo. |
| Join on date range | `js/transforms/date-range-join.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Match each event to the reference rows whose span contains its date, with an optional key. Counts matched, unmatched and the worst fanout BEFORE anything is applied, because one day of overlap between two ranges silently doubles the events on that day and every total taken afterwards. A blank end date means still in force and bounds are inclusive by default, both configurable and both visible in the generated non-equi SQL. Preview-first; Apply is click-only. |
| First or last event | `js/transforms/first-last-event.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | One row per group chosen by an order column, or all rows kept with a rank. Ties are broken by every remaining column in table order, identically in the engine and in the generated DuckDB `QUALIFY` / `ROW_NUMBER` SQL, so the same table always returns the same row. When ties occurred the notes say how many and that the choice was arbitrary. Rows with no readable order value are excluded and counted. |
| As-of lookup | `js/transforms/as-of-lookup.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | For each fact row, the reference row in force on that date: the latest effective date at or before it, with an optional key. Prevents today's price on an old sale. A fact older than every reference row gets a blank, never the oldest value on record. Duplicated effective dates are resolved and reported. Glass-box SQL is DuckDB's `ASOF LEFT JOIN` with a `ROW_NUMBER` equivalent underneath. Looked-up columns carry an `_asof` suffix. |
| Expand a hierarchy into node, parent, depth and path | `js/transforms/expand-hierarchy.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Turns a parent/child column pair or a single path column into one row per node carrying its depth, its parent, the root it sits under, its full path and whether it is a leaf. The decisions that matter are about broken trees, because real org charts and account hierarchies are broken. A node whose parent id is not in the table is a root for the purposes of the walk and is reported as one rather than silently dropped. A node that is its own ancestor is not followed forever: the walk carries its visited list, stops at 256 levels, and emits the nodes it could never reach with a null depth and an in_cycle marker, so a self-referencing row produces a finding instead of a hung tab. The glass-box SQL is a WITH RECURSIVE CTE seeded on the rows with no findable parent and carrying the same visited list, so the cycle guard a person reads is the guard the rows came from. Pure ES module, Node-testable, no DuckDB and no network, so it runs with Air-Gap Mode on. |
| Nested lists into rows, with the row count shown first | `js/transforms/nested-to-rows.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Turns a column of JSON arrays or separated text into one row per element, repeating the other columns. Two things separate it from a split. The row count comes first: previewNestedToRows() counts the output WITHOUT building it, so the panel states "1,204 rows would become 38,911" and raises its warnings above the run button, while it is still free to change the settings. And an empty list is kept rather than dropped: a plain UNNEST removes those rows silently, and a row disappearing from a count is far harder to notice than a blank cell, so by default the row survives with a blank element and the count is reported. Dropping them is available and stated. A cell that looks like JSON and does not parse is reported as unreadable rather than split on a comma and passed off as a list. Complementary to the semi-structured JSON flattener in js/ingestion/json-flattener.js, which widens an object into columns; this lengthens a list into rows. Glass-box SQL is the DuckDB UNNEST form, written with the LEFT JOIN that keeps the empty rows. Pure ES module, Node-testable, no DuckDB and no network. |
| Fill blanks and always flag the cells that were filled | `js/transforms/fill-missing.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Forward fill from the last value above, or a constant chosen by the person. Every filled column gets a companion _was_filled boolean column, and that is deliberately not configurable: an invented value that reads like a measured one is the entire risk here, and a fill with no flag is indistinguishable downstream from data that was always there. Only two modes ship. A group mean or median needs its own account of what it assumes, and js/cleaning/imputation.js already offers the statistical modes, so rather than duplicating them the runtime notes name that wizard and say plainly that it does not add a flag column, which is the difference a person choosing between the two needs to know. Forward fill requires an order column, and rows whose order value cannot be read sort last and are never filled, because carrying a value into a row whose position is unknown is guessing twice. The glass-box SQL is last_value(...) IGNORE NULLS over an unbounded preceding window, with the IGNORE NULLS called out as the load-bearing part. Pure ES module, Node-testable, no DuckDB and no network. |
| A start and end date into one row per calendar day | `js/transforms/expand-date-range.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Turns a start and end date per row into one row per calendar day, which is the occupancy, bed-days and licence-coverage shape. This is the largest multiplier in the transforms set, so the count comes before the rows: previewExpandDateRange() counts the days without building any, warns at 100,000 output rows and at 20,000 on a narrow screen, and refuses outright above 2,000,000 BEFORE anything is built, so a refusal never leaves the caller holding a half-expanded table. There is deliberately no option to run an open range up to today. An open-ended range is skipped unless the person states an as-at date, and that date is written into both the notes and the generated SQL as a literal, because a table built against current_date gives a different answer every time it is built and nobody can reproduce last month's number from it. An end date that is present but unreadable is not treated as open, since reading a mistyped date as "still going" would stretch a closed range to the as-at date. The end day counts by default and the notes state which convention was used, because both are in real use and which is right depends on whether the end date is the last day or the day it ended. Glass-box SQL is a CROSS JOIN LATERAL generate_series. Pure ES module, Node-testable, no DuckDB and no network. |
| Group a number column into bands, with the histogram from the same counts | `js/transforms/bin-editor.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Equal-width bands by default, or edges typed by hand. The histogram is drawn from the same binCounts() the apply uses rather than from a separate pass over the rows, so the bars a person read and the bands they applied cannot come to disagree; that also makes the picture testable in Node without a canvas. Equal-width binning is quietly wrong on skewed columns, where one very large value stretches the range and everything else lands in the first band, so the engine warns when a single band holds 90 percent or more of the rows in range and points at custom edges. Bands are half-open, said in the labels, in the notes and in the generated CASE ladder, with only the top band including its own upper edge, so the largest value has somewhere to go. A value outside the edges gets a blank band rather than being pushed into the nearest one, because the values that fell outside are exactly the ones worth looking at, and the CASE ladder therefore ends in ELSE NULL rather than a catch-all band. A column with no spread is reported as such instead of being split into ten bands that would imply a range that is not there. Separate from the chart histogram in js/chart/chart-engine.js, which draws a picture; this adds a column. Pure ES module, Node-testable, no DuckDB and no network. |
| Keep the most recent record per group, and name what was discarded | `js/transforms/keep-most-recent.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Entity keys plus an order column leave one row per group. Unlike the first/last event transform, which answers a question about events that were never wanted, this DELETES rows that were in the table a moment ago, and the whole risk is that they were not duplicates at all. So the number it leads with is not "rows removed" but "rows removed that disagreed": dropping an exact copy of a row loses nothing, while dropping a row that shared the key and held a different address, amount or diagnosis is throwing away a fact, and those two cases have the same row count. The result counts the conflicting groups separately and names the columns where the discarded rows disagreed with the row kept, which is what tells a person whether this was a de-duplication or a choice about the data. Ties on the order column are broken by every remaining column in table order, identically in the engine and in the generated ROW_NUMBER SQL, and the notes admit that repeatable is not the same as correct. A row whose order value cannot be read is kept by default and never wins a group that has a dated row, because deleting a row on the strength of a mistyped date is a loss nobody asked for. It shares sortableOrderValue, compareSortable and compareValues with the first/last event engine through js/transforms/transform-core.js rather than copying them, so the two cannot come to disagree about what latest means. Rows come out in the order their groups were first seen, so a diff against the original stays readable. Pure ES module, Node-testable, no DuckDB and no network. |
| Consecutive runs of active days | `js/transforms/consecutive-run.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Gaps and islands per entity: the streaks of consecutive active days, their start, their end, their length, and the longest one. The decision that matters is what breaks a streak. Two rows on the same date are one active day, not two, so a duplicated export row cannot lengthen a streak, and the notes say how many dates were repeated. A calendar gap breaks the run and a weekend does not unless the person says working days only, because a five day week read as a broken streak turns every employee into a stream of two day runs. Rows whose date cannot be read are excluded and counted rather than sorted to one end where they would join or split a run at random. Glass-box SQL is the standard date minus row number grouping key, written out so the trick is visible rather than assumed. |
| Moving average and crossovers | `js/transforms/moving-average.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | A trailing average over a window of rows, optionally per series, with an optional second window and the points where one crosses the other. The warm-up rows are blank rather than an average of whatever happened to be there: a three row average taken over one row is that row, and a chart that starts with a fake value implies a trend that the data does not contain. The count of blanked rows is reported. A crossing is only reported when both averages exist on both sides of it, so the first row of data is never a crossover. Centred windows are available and stated as unusable for anything live, because a centred average at today's row needs rows that have not happened yet. Glass-box SQL is an AVG over a ROWS BETWEEN preceding window with the same warm-up NULL guard the engine applies. |
| Counts for a multi-value column | `js/transforms/multi-value-counts.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | A cell holding "email, phone, sms" is three memberships, and counting the cell as one string gives a table of combinations nobody asked for. This splits on a separator and counts each value, and the whole point is that it refuses to let the result be read as exclusive. Rows belong to several buckets at once, so the bucket counts add up to more than the row count, and the result carries the row count, the membership count and a stated warning beside the percentages, which are of rows and not of memberships. A blank cell is counted as no memberships rather than as an empty category. The separator is guessed across comma, semicolon and pipe, and the guess is shown and editable. Glass-box SQL is UNNEST(string_split(...)) with a COUNT(DISTINCT row) so the denominator in the query is the denominator in the panel. |
| Frequent combinations | `js/transforms/frequent-combinations.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Which values appear together in the same basket, order or visit, counted as pairs with support, confidence and lift. Counting co-occurrence alone promotes whatever is simply common: the two best selling items appear together constantly and mean nothing by it. Lift is therefore reported beside the raw count and the notes state plainly that lift near one is co-occurrence without association, and that none of these three numbers is evidence of cause. Pairs seen fewer times than the support floor are dropped rather than shown with a confidence computed from two rows. The basket count is the denominator and is shown. Glass-box SQL is a self join on the basket key with a value ordering to keep each pair once. |
| Within-window recurrence | `js/transforms/window-recurrence.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | How often an entity comes back within N days: the qualifying pairs and the rate. The number that is usually wrong here is the denominator. An entity whose only event falls inside the last N days of the data had no chance to return within the window, so counting it as a non-returner drags the rate down by exactly as much as the table is short. The result reports the rate over eligible entities and the rate over all entities as two separate figures, names how many were censored by the end of the data, and never presents one of them alone. Same day repeats are pairs at zero days and are counted as such, with the count stated, because a duplicate export row and a genuine same day return look identical in the rows. Glass-box SQL is a self join bounded by an interval with the eligibility filter written out. |
| Value standardizer with human confirm | `js/transforms/value-standardizer.js`<br>`js/transforms/transform-core.js`<br>`js/transforms/data-glow-transforms-canvas.js` | LIVE | HIGH | Merges spelling variants of a category into one value: "NY", "N.Y.", "new york". The engine proposes and a person disposes. The proposal comes from deterministic passes first (case, whitespace, punctuation) and only then from a clusterer, and every group carries the reason it was grouped and the row count it moves. The transform refuses outright to run unless the config carries an explicit confirmation, so nothing can merge categories on a script's say-so, and the panel offers each group as a switch so the map that runs is the map the person left switched on rather than the one that was proposed. Sensitive categories (race, ethnicity, gender, disability and similar) are flagged through `window.CategoricalConsistency`, because merging those is a decision about people and not about spelling. Glass-box SQL is an explicit CASE ladder listing every from and to value, so the rename is readable before it happens and auditable afterwards. |
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

### Proof Board

A dashboard shows numbers and gives you nowhere to look for how they were computed, so the argument in the meeting stops being about the number and becomes about whether the person who made it is trustworthy. The Proof Board puts the query directly underneath each number, in the same tile. Pure engine `js/proofboard/proof-board.js` (`window.DataGlowProofBoard`) owns the tile model, the board, the verify pass and the receipt claim; `js/proofboard/session-tiles.js` (`window.DataGlowProofBoardTiles`) computes the tiles; `test/proof-board.test.mjs` covers all of it in Node with 286 assertions and no DOM.

Every tile is arithmetic over the rows actually in memory, done in JavaScript because DataGlow does not require a query engine to be present, with the equivalent SQL printed beside it so a person can take it to their own warehouse and check. That is the Guided Unpivot house pattern: ship the proof and the transform, and let the tests assert the two agree. Nothing on the board is seeded. `tilesFromDataset` returns an empty list when there are no rows, and the panel shows its empty state with one call to action, because a demo number on a surface whose entire promise is that every number shows its work is a number with a fabricated proof under it. There is no default value, no zero fallback and no placeholder anywhere: `hasValue` rejects NaN, Infinity and blank strings, and `formatTileValue` returns empty rather than a plausible-looking zero, since showing 0 for a number nobody computed is inventing a KPI. A malformed tile is kept and marked incomplete with its reasons listed rather than dropped, because a board that looks complete and is quietly missing a number is much harder to notice than a tile that says what is wrong with it.

The badge has four values and not two. A green tick or nothing quietly turns "no check has run" into "this passed", which is the most expensive lie this surface could tell, so `unknown` is a badge with its own wording and its own sentence saying it is an absence of evidence. It is read off a real gate result when one is supplied, and a caller that labels a tile `clear` while handing over a blocked verdict gets the verdict shown with the disagreement recorded as a problem. Nothing is forged in the other direction either: the tile's badge is deliberately not passed to GlassBox as a Publish-Safe gate, because that would render a chip reading "Publish-Safe: clear" that no gate ever produced, so a tile with no gate result shows GlassBox reporting the absence. `verifyBoard` checks the five things the board can actually check (every tile carries its code, every value was computed, ids are unique, a gate reported, all tiles describe one dataset) and names the two it cannot: whether each query still returns the number shown, which would need the dataset and the engine and would report a fresh number as if it were the recorded one, and whether these are the right numbers to be looking at, which no check can answer.

**Glowbook** (`js/proofboard/glowbook.js`, `window.DataGlowGlowbook`). A link to a result is a promise that a server will still be there showing the same thing, and DataGlow has no server, so a shared link would have to be a hosted copy of the data. A Glowbook is one self-contained file on the person's own disk instead: no script, no stylesheet link, no iframe, no fetch. It is a document and not an application, because an exported page that runs code can differ from what the sender previewed and is also the thing a mail gateway quarantines. Every tile is written finding first and then the proof, matching the panel on screen so a reader who has seen one does not have to relearn the other. The file gets forwarded to people who did not run the analysis and a page of green ticks reads as an audit, so the disclaimer is emitted from a constant a caller cannot edit away: a record of how numbers were computed on one device, a tile marked not checked has not passed anything, and this is not a certification, not an audit, not a compliance claim and not legal or clinical advice. A separate line says the proof is readable code and not a cryptographic proof, so nobody reads it as zero-knowledge. The engine returns a string and never writes it; the canvas surface asks the person first, because only a surface can ask.

**Coach strip** (`js/proofboard/coach-moments.js`, `window.DataGlowProofBoardCoach`, flag `proofBoardCoach`). A tour is usually a framework built to hold attention, which is the wrong goal for someone who opened a panel because they had a job to do. These are five objects with a target element id. The strip points at the thing and says one sentence: nothing is dimmed, nothing is blocked, and the panel stays fully usable with it open. There is no video, because a video means an asset, an asset means a CDN and a CDN means the page reaches the network. A step whose target is missing is skipped rather than pointed at empty space, and an id lookup that throws drops the step rather than the strip. Once dismissed it stays dismissed, and unreadable storage is treated as never seen so a refused localStorage costs a tip and not the panel. Kept separate from `analyst-journey.js`, whose four moments are hard-coded to the landing, the drop, the pulse read and the finish and which publishes no way to register more; it is shaped the same way rather than widened to carry a second concern.

Canvas UI `js/proofboard/data-glow-proof-board-canvas.js` (`window.DataGlowProofBoardUI`) mounts a Proof button beside the Trust Ledger and a panel holding the grid: two columns on a desktop panel, one at 900px and below, because a tile whose query wrapped to six lines beside a one-line tile is still readable and three columns is not. Show the work expands the shared GlassBox model, so proof reads the same here as under a SQL result. Two actions ask a human before they do anything: Export Glowbook before it writes a file, and Stamp receipt before it appends a Trust Ledger row. `tileReceiptClaim` assembles the claim only and computes no hash, because the chain already exists on the ledger and a second one written here would be a competing record of the same session. Portable receipts and the Proof Room are not in this build, so those controls are feature-detected and simply absent: a link to a surface that does not exist is a dead end wearing a working button. Ships ON via `proofBoard`; with the flag off neither the button nor the panel is created and the engines stay published for programmatic use.

### Proof to Post, the prove gate, the BI hand-off and the de-id receipt

The loop DataGlow is built around is analyze locally, prove, publish, then post. The last step is where analysts normally lose the proof: a number that survived a query engine, a validation gate and a receipt chain gets retyped by hand into a post, and at that moment it becomes a number with nothing behind it.

**Prove gate** (`js/ai/prove-gate.js`, `window.DataGlowProveGate`, flag `aiProveGate`). A language model writing prose about a dataset will produce a number that reads correctly and was never computed, and the reader cannot tell by looking. This gate does not ask the model to be careful. It extracts every number from the finished text and requires each one to bind to a Proof Board tile or an engine result, and it names the ones that do not instead of quietly softening the sentence around them. The tolerance is narrow on purpose: an exact match, or a correct rounding to the precision the author actually wrote, and nothing else, so a claim cannot round a number and call the difference a summary. A tile carrying the `blocked` badge refuses outright, because a number a check has already objected to is the worst possible thing to quote in public. A tile carrying `unknown` binds but raises a caution, because no check having run is not the same as a check having passed. ISO dates, clock times and dotted version strings are masked out before extraction, so the gate does not refuse the method line that ships alongside its own output. There is no override: the caller gets the refusal and the list, and can delete the number or go compute it. `test/proof-to-post.test.mjs` covers all of this in Node with no DOM.

**Proof to Post** (`js/proofpost/proof-to-post.js`, `window.DataGlowProofToPost`, flag `proofToPost`). The draft is not written by a person and then checked. It is assembled from tiles, which means every number in it came out of an engine by construction, and then it is checked anyway through the prove gate, because assembly can still go wrong and a post is not something you can recall. There is no post button and there will not be one: `NEVER_AUTO_POST` is a constant rather than a setting, DataGlow has no server and no outbound network so an OAuth integration would need both, and beyond the architecture a tool that can post on your behalf is a tool that can post something you did not read. The output is text on a clipboard. The transparency line is computed from the badges actually present rather than written as a fixed string, because "numbers engine-checked" is a claim about the work and it is false in exactly the case where the reader most needs to know. A tile with no value is not a weaker bullet, it is not a bullet at all; a blocked tile is excluded with its reason shown, so a person can see why a number visible on the board is missing from the draft. The canvas surface `js/proofpost/data-glow-proof-to-post-canvas.js` (`window.DataGlowProofToPostUI`) mounts a Post button beside the Proof Board and a panel holding a three-step checklist where each step reports what is actually missing, the draft, the gate result, and a Copy draft button that stays disabled until both the gate passes and the review box is ticked. The four-step coach strip reuses the Bundle 9 strip model rather than shipping a second tour framework.

**BI hand-off** (`js/export/bi-handoff.js`, `window.DataGlowBIHandoff`, flag `biHandoff`). Handing a CSV to a BI team loses everything that made the analysis defensible. This produces `data.csv`, `dictionary.md`, `queries.sql`, `validation-summary.md` and `README-handoff.md` instead. There is no zip: adding a compression dependency to turn five readable files into one opaque archive makes the output harder to inspect for no gain the recipient can feel. The CSV neutralises a leading equals, plus, minus or at sign, which is the one way a pure text export can still hurt someone. The validation summary refuses to grade what it did not see: a null rate over zero rows is reported as not known rather than as zero percent, and a number with no recorded query is said to have none rather than being handed a plausible-looking one. The README states in its first paragraph that this is not a certified deliverable, does not reproduce a dashboard, and is not endorsed by or certified with either tool, because the file most likely to be forwarded is the one most likely to be read as a claim.

**De-id screening receipt** (`js/privacy/deid-receipt.js`, `window.DataGlowDeidReceipt`, flag `deidReceipt`). `js/provenance/deidentification-verifier.js` already existed and already decides; this adds only the record of what it looked at and what it found, so there is exactly one thing in the codebase that can say whether a column looks identifying. The renaming on the way out is the point: the engine verdict is printed as "Nothing was flagged by this screen" and never as a bare pass, because a receipt is precisely the artefact someone forwards to a stakeholder as evidence, and a document with a pass at the top reads as a clearance no matter what the paragraph below says. The disclaimer is emitted from a constant a caller cannot remove, and the receipt states what the screen cannot see: it reads column names and sampled values, so a name buried in free text, or a combination of columns that identifies someone only together, is outside what it can find. It is an automated screening aid, not a HIPAA certification and not a safe-to-release judgement. The exported HTML has no script, no stylesheet link, no iframe and no network reference.

**Add to Proof Board from NL to SQL** (`js/nl-sql/nl-sql-ui.js`). The generated SQL was already shown before anything ran, which is the glass-box half of the promise. This is the other half: the number a person reads off the result can be kept on the board with the query attached. The value is typed by the person who read it and is never guessed, an empty box adds nothing rather than adding a zero, and the confirm says outright that no check has run so the tile will carry the not-checked badge until one does. Tiles added this way survive a board rebuild in `js/proofboard/data-glow-proof-board-canvas.js`, because the board is rebuilt every time the panel opens and losing them silently would be worse than not offering the button.

### Built-in AI status, the claim guard, ambient proof and the honest ceiling

DataGlow had been running a language model on the user's own machine for months and there was nowhere on the page that said so. The most distinctive property of the product was invisible unless you opened a panel and got lucky. These four surfaces make it visible and then, in the same breath, say where it stops.

**Built-in AI status** (`js/ai/local-ai-status.js`, `window.DataGlowLocalAiStatus`, flag `localAiStatus`). "Built-in AI: ready" is a claim about this machine at this moment, and it is wrong the instant WebGPU is missing, Air-Gap Mode is on with nothing cached, or the model has simply not been downloaded. A stored boolean drifts from the truth silently, so the state is a function of four observed facts and nothing else, re-derived on every render. The precedence is the interesting part. Air-Gap outranks capability, because a session whose whole posture is that nothing goes out must not be told it could fetch a model. Capability outranks loadedness, because a loaded flag on a machine with no WebGPU is a stale flag and trusting it would put a ready chip on a page that cannot generate a word. A model that is already loaded does outrank Air-Gap, because running it sends nothing and Air-Gap only ever objects to the download. `rule_only` is a first-class state and not a failure: most of what DataGlow calls AI is rules, and telling a person without WebGPU that the product does not work for them would be a lie in the unhelpful direction. The registry in the same module lists five models with size, licence, runtime and per-platform notes, marks exactly one `shipped`, and names what is in the way of each of the others, including a community licence that is not OSI approved. The shipped identifier is not retyped on trust: `test/local-ai-ambient.test.mjs` reads `MODEL_ID` and `MODEL_LABEL` out of `js/narrative/ondevice-llm.js` and fails if the two ever disagree.

**AI claim guard** (`js/ai/ai-claim-guard.js`, `window.DataGlowAiClaimGuard`). The Guarded Copilot Tier 2 prompt already asked the model not to invent numbers. That is the correct thing to put in a prompt and it is not a control. A model that transposes 1204 into 1240, or rounds 47.3 percent to "nearly half" and then writes 50 percent, has done exactly what language models do, and the result is a wrong number in a confident sentence with no mark on it. This module makes the request a control. The Tier 1 deterministic text is ground truth, its numbers become the permitted set, and `js/ai/prove-gate.js` does the comparing including its rounding policy: a number rendered to fewer places still binds, a different number does not. A failing rephrase falls back to the deterministic text verbatim rather than having its numbers stripped, because a sentence with the numbers taken out is worse than the plain one it was meant to improve and nobody can tell by looking that it was edited. When no guard is reachable at all, `js/agents/guarded-copilot.js` also falls back, because an unchecked rephrase is not a passing one. The guard lives outside the copilot so that module keeps its frozen four-function read-only surface and its red-team test unchanged.

**Ambient proof strip** (`js/ambient/ambient-proof-strip.js`, `window.DataGlowAmbientProof`, flag `ambientProofStrip`). The ambient assistants shipping in operating systems this year are always watching and always willing to answer, and that combination is the failure mode: the thing is never allowed to say it does not know, so it says something. DataGlow's answer is not a competing assistant, it is the other half. The strip is continuous but it reports rather than generates: last prove-gate result, Air-Gap state, open caveat count, and drift severity when `js/ambient/drift-watchdog.js` has reported one. Two refusals are load-bearing. `answerAmbientQuestion` exists and always declines, with a reason and a redirect to a surface where the answer comes from a query you can read, which makes adding an answer path later a deliberate act rather than a convenience. And a prove result that ran against an earlier version of the data is reported as stale rather than as a pass, because a green tick for yesterday's data is worse than no strip at all. Nothing checked yet is an absence and never a pass; Air-Gap being off is not spun as a positive; zero recorded caveats is not sold as proof there is nothing to say.

**Capability ceiling** (`js/ai/capability-ceiling.js`, `window.DataGlowCapabilityCeiling`, flag `capabilityCeiling`). Every tool that runs SQL says it runs SQL and every one of them means a different SQL, and the gap between what a person hears and what the software does is where trust goes quietly. Seven areas are written down with a `does` line and a separate `notThis` line that cannot be skimmed past: SQL is real DuckDB in a tab and is not every warehouse dialect; Python is real CPython through Pyodide and truncates the bridge at a stated row limit; R is WebR and is not CRAN; Excel Hell Repair repairs the data in a workbook and does not read VBA, macros or formulas; size is comfortable through the low millions of rows and is explicitly not "any size"; a messy file is solved here while a messy data estate is not, and conflating the two is the fastest way for this product to overpromise; and local execution is a strong privacy property and a weak compliance one, so the Safe Harbor screen is a screening aid and not a HIPAA certification. The row limit is a parameter with a documented default rather than a second copy of the number, because a copy would go stale the first time someone tuned the real one and this module would then be confidently telling users a limit the product no longer has. A test reads `PY_BRIDGE_ROW_LIMIT` out of `js/runtimes-viz/python-runtime.js` and pins the default to it. The ceiling can be copied out as markdown behind the same human confirm as every other outbound path.

**Polars secondary path** (`js/polyglot/polars-path.js`, `window.DataGlowPolarsPath`, flag `polarsSecondaryPath`). Polars keeps being the right answer to a question DataGlow does not have. It is genuinely fast, people ask for it by name, and a chip saying "Polars ready" would be the cheapest way to look more serious than the product is. So this ships as a status and contains no engine. Three states only: `available` when the Pyodide session can actually import it, `not_installed` when it cannot, `not_on_platform` when no Python session is running. There is no fourth state meaning coming soon, because a state nobody can currently be in is a promise wearing the costume of a status. No input and garbage input both refuse to yield `available`, so the chip cannot fake ready. DuckDB remains the analytical engine and every availability object restates that, because the risk with a second dataframe path is not that it is slow, it is that someone assumes their query silently went somewhere they did not pick.

**The surface** (`js/ai/data-glow-local-ai-canvas.js`, `window.DataGlowLocalAiUI`). One persistent chip and a three-tab panel behind it. The chip re-observes the machine on an interval because WebGPU, Air-Gap Mode and model loadedness all change without telling anyone. The ceiling sits in the same panel as the AI status rather than behind a separate Help link, because they answer the same question: somebody reading "Built-in AI: ready" is forming a belief about what this thing can do, and the honest completion of that sentence is the list of what it cannot. The one outbound action on the panel, copying the ceiling as markdown, asks a human first exactly like every other outbound path in the product.

### Time and joins (A18, A19, A20, A24)

Four transforms that exist to stop four specific wrong numbers, each a pure ES module under `js/transforms/` over a shared core (`transform-core.js`), each Node-testable with no DuckDB, no DOM and no network, so they run identically with Air-Gap Mode on. They follow the Guided Unpivot pattern exactly: the SQL builder renders the proof and the JS transform does the work, and `test/time-join-transforms.test.mjs` asserts the two agree.

**Compare to prior period** (`prior-period.js`, `window.DataGlowPriorPeriod`, flag `priorPeriodCompare`). The load-bearing decision is what prior means. `LAG(value) OVER (ORDER BY period)` returns the previous row, so with February missing it compares March against January and labels it month over month: a wrong number that looks completely reasonable on a chart. Prior here is the previous calendar period, looked up by a stepped-back period key, and an absent one yields a blank prior, a blank delta and a note saying how many periods had no predecessor.

**Join on date range** (`date-range-join.js`, `window.DataGlowDateRangeJoin`, flag `dateRangeJoin`). A key join carries the intuition that a duplicate key duplicates rows; a range join carries none, so two reference ranges overlapping by a single day silently double every event on that day and every total afterwards, while each individual row still looks right. `previewDateRangeJoin()` counts matched, unmatched, the worst fanout and the multi-match rows without building any, and the panel shows that before the confirm. Preview and apply share one matching function, because a preview computed by different rules would be worse than none.

**First or last event** (`first-last-event.js`, `window.DataGlowFirstLastEvent`, flag `firstLastEvent`). About ties, not ordering. A plain `ROW_NUMBER` partition may return either of two rows sharing a timestamp, and a different one next run: a report that changes when nothing changed is among the hardest bugs to be believed about. The tie-break is total and stated, and appears in the SQL `ORDER BY` rather than only in a comment. Determinism is not meaning, so when ties occurred the notes admit the choice was repeatable but arbitrary.

**As-of lookup** (`as-of-lookup.js`, `window.DataGlowAsOfLookup`, flag `asOfLookup`). Joining a sale to a price table on product id alone returns today's price, and today's price times last year's units is revenue that never happened. This takes the reference row with the greatest effective date at or before the fact date. A fact older than every reference row gets a blank, never the oldest value on record, because the oldest value is not the value that was true then. Brought columns carry an `_asof` suffix so a point-in-time value cannot be mistaken for a current one two steps later.

These four share the canvas panel described under Shape and clean below, in its Time and joins group.

### Shape and clean (A16, A17, A25, A26, A27, A29, plus the value standardizer)

Seven more pure ES modules under `js/transforms/`, over the same `transform-core.js`, tested by `test/shape-clean-transforms.test.mjs` and `test/advanced-transforms.test.mjs` with no DuckDB, no DOM and no network. Each one either invents rows, invents values, renames values or deletes rows, so each one says which before it is allowed to run.

**Expand a hierarchy** (`expand-hierarchy.js`, `window.DataGlowExpandHierarchy`, flag `expandHierarchy`). Depth and path are only computable once, on a walk from the roots, so the module walks rather than self-joining a guessed number of times. The two conditions a real org chart or category tree actually breaks on are named rather than hidden: a cycle, where a node is its own ancestor, and an orphan, whose stated parent is not in the table. Both are reported with their nodes instead of producing a silently short tree.

**Nested lists into rows** (`nested-to-rows.js`, `window.DataGlowNestedToRows`, flag `nestedToRows`). One cell holding "a, b, c" becomes three rows, and every measure on the table is now three times counted. `previewNestedToRows()` returns the row count before a single row is built, and the panel shows it above the run button, because the moment to learn that 4,000 rows become 90,000 is while the settings are still free to change.

**Fill blanks and flag them** (`fill-missing.js`, `window.DataGlowFillMissing`, flag `fillMissingFlagged`). A filled blank is a value the data did not contain, so every fill adds a boolean column naming the cells it invented. There is no silent-fill option. Forward fill, backward fill, a constant and the column mean or median are available; the mean is stated as the choice that shrinks variance, so a filled column read as measured will understate its own spread.

**A date range into daily rows** (`expand-date-range.js`, `window.DataGlowExpandDateRange`, flag `expandDailyRows`). The transform most able to destroy a session: one row with a ten-year span is 3,653 rows, and a table of them is millions. `previewExpandDateRange()` totals the days first, warns on a narrow screen at a much lower threshold than on a desktop, and refuses outright past a cap rather than starting work it cannot finish. Open-ended rows are only expanded when an as-at date is given, and rows with no readable dates are counted and left behind rather than dropped quietly.

**Visual bin editor** (`bin-editor.js`, `window.DataGlowBinEditor`, flag `visualBinEditor`). Equal-width, quantile and hand-typed edges, with a histogram drawn from `binCounts()`, the same function the apply uses, so the bars and the applied bands cannot disagree. It warns when one band holds nearly everything, which is the usual outcome of equal-width bins over a skewed column and the usual reason a chart made from them says nothing.

**Keep the most recent per group** (`keep-most-recent.js`, `window.DataGlowKeepMostRecent`, flag `keepMostRecent`). This deletes, so the number it leads with is not rows removed but rows removed that disagreed with the row kept, and it names the columns where they disagreed: dropping an exact copy loses nothing, dropping a row with a different address loses a fact, and the two have the same row count. It shares `sortableOrderValue` and `compareValues` with First or last event through `transform-core.js` deliberately, so one definition of latest serves both, and its SQL `ORDER BY` carries the whole tie-break so the query a person reads returns those exact rows.

**Value standardizer** (`value-standardizer.js`, `window.DataGlowValueStandardizer`, flag `valueStandardizer`). "NY", "N.Y." and "new york" are one category written three ways, and every count of that column is wrong until they are one value. What separates this from a find and replace is that the engine will not run at all unless its config carries an explicit confirmation, so no script and no other engine can merge categories on its own. It proposes: deterministic passes first, case then whitespace then punctuation, and only then a clusterer for what is left, with every group carrying the reason it was grouped and the rows it moves. The panel renders each group as a switch, so the map that runs is the one a person left switched on rather than the one that was offered, and the summary of exactly which values become which is shown immediately above the confirm button rather than a screen away. Groups touching a sensitive category are marked through `window.CategoricalConsistency`, because merging race, gender or disability values is a decision about people and not about spelling. The SQL is a CASE ladder naming every from and to pair.

### Advanced (A21, A22, A23, A28, A30)

Five more pure ES modules over the same core, tested by `test/advanced-transforms.test.mjs`. They are grouped apart from the others because they share a failure mode the reshaping transforms do not have: each answers a question that has a plausible wrong answer people reach for by default, and the wrong answer looks entirely reasonable on a chart.

**Consecutive runs** (`consecutive-run.js`, `window.DataGlowConsecutiveRun`, flag `consecutiveRun`). Gaps and islands per entity. Two rows on the same date are one active day, so a duplicated export row cannot lengthen a streak, and the count of repeated dates is reported rather than absorbed. A weekend breaks a run only when the person has not said working days only, since a five day week read literally turns every employee into a stream of two day runs. Rows with an unreadable date are excluded and counted, never sorted to one end where they would join or split a run by accident.

**Moving average and crossovers** (`moving-average.js`, `window.DataGlowMovingAverage`, flag `movingAverageCross`). The warm-up rows are blank, not an average of the one or two rows that exist yet. A three row average of a single row is that row, and a chart whose first points are fake implies a trend the data does not contain; the number of blanked rows is stated. With a second window, a crossing is only reported where both averages exist on both sides of it, so the start of the data is never a signal. Centred windows are offered and labelled as unusable for anything live, because a centred average at today's row needs rows that have not happened.

**Multi-value counts** (`multi-value-counts.js`, `window.DataGlowMultiValueCounts`, flag `multiValueMembership`). A cell holding "email, phone, sms" is three memberships. The counts therefore sum to more than the row count, and rather than leaving a reader to notice that, the result carries the row count, the membership count and a stated warning beside percentages that are of rows and not of memberships. The separator is guessed across comma, semicolon and pipe rather than assumed to be a comma, since guessing wrong reads as "this column has nothing in it".

**Frequent combinations** (`frequent-combinations.js`, `window.DataGlowFrequentCombinations`, flag `frequentCombinations`). Pairs of values in the same basket with support, confidence and lift. Raw co-occurrence promotes whatever is merely common: the two best sellers appear together constantly and mean nothing by it, which is why lift sits beside the count and why the notes say that lift near one is co-occurrence without association and that none of the three is evidence of cause. Pairs below the support floor are dropped rather than shown with a confidence derived from two rows.

**Within-window recurrence** (`window-recurrence.js`, `window.DataGlowWindowRecurrence`, flag `windowRecurrence`). How often an entity returns within N days. The denominator is the thing that goes wrong: an entity whose only event lands in the final N days of the data never had the chance to return, and counting it as a non-returner drags the rate down in proportion to how short the table is. Two rates are reported side by side, over eligible entities and over all entities, with the censored count named, and neither is ever shown alone. Same day repeats are pairs at zero days and are counted with their number stated, because a duplicate export row and a genuine same day return are indistinguishable in the rows.

The canvas surface for all sixteen is one panel, `js/transforms/data-glow-transforms-canvas.js` (`window.DataGlowTransformsUI`, panel `#transforms-view`), reachable from a Transforms button, with the tabs split into three groups, Time and joins, Shape and clean, and Advanced. Sixteen flat tabs wrap to four lines of near-identical labels at 360px, which is a worse answer than one extra click. It computes nothing: every number and every sentence comes from an engine. Finding first, notes naming what could not be done, a preview, then the SQL underneath. Apply takes two clicks and the second one names the consequence in rows, because most of these change the row count and three can multiply it. Undo restores the pre-image. The recurrence tab lifts its two rates out of the wide pairs table into stacked figures above it, so at tablet width the answer is not the thing that scrolled off the right edge. Each tab is behind its own flag and an off tab is not rendered, so a disabled capability leaves no dead control; a group with every flag off shows no group, and with all sixteen off neither the panel nor the button mounts. Web, desktop, PWA.

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
