# CODEMAP

A first-read orientation for anyone (human or coding agent) landing in this repo.
It explains how the source is laid out and where each kind of work lives. For the
machine-readable version of the same territory — every capability paired with its
backing file(s), exported symbols, and target platforms — read
[`capability-map.manifest.json`](capability-map.manifest.json), which CI validates
against the tree on every PR. This file is the prose companion; the manifest is the
contract.

## The shape of the app

DATAGLOW is a zero-build, browser-native data-analysis tool written in plain ES
modules. There is no bundler and no transpile step: `index.html` loads
`js/app-shell/main.js` as `<script type="module">`, and everything else is reached
through relative `import` statements from there. All computation runs client-side
(DuckDB-WASM in the browser, optional language runtimes fetched on demand); user
data never leaves the machine. Keep that constraint in mind before adding anything
that opens a network connection.

The `js/` tree is organized into one subfolder per capability *area*. The folder a
file lives in tells you which area owns it, and the area names below match the
`area` field in the manifest exactly — they are the single source of truth for how
the code is grouped. When you add a module, put it in the folder for its area and
add it to the manifest in the same PR (CI's capability-map drift gate will fail
otherwise).

## Where things live (`js/<folder>/`)

- **`app-shell/`** — *App shell & data engine.* The bootstrap and shared spine:
  `main.js` (entry point + UI wiring), `state.js` (shared app state), `utils.js`,
  `loaders.js` (file ingestion), `duckdb-engine.js` (the in-browser SQL engine),
  `capability-registry.js` (platform-aware dynamic module loader driven by the
  manifest), and `databricks-connect.js`. Start here to understand control flow.

- **`validation/`** — *Validation layers.* The core data-quality checks:
  `validation.js` plus the individual layer modules (`domain-physics.js`,
  `physiological-plausibility.js`, `health-standards.js`, `expected-range.js`,
  `cross-column-consistency.js`, `categorical-consistency.js`,
  `upper-bound-sanity.js`, `missingness.js`, `missingness-detective.js`).

- **`anomaly/`** — *Anomaly & outlier detection.* `isolation-forest.js`,
  `spc-control.js`, `entity-baseline.js`, `predictive-anomaly.js`,
  `active-learning.js`, `ondevice-ml.js`.

- **`drift/`** — *Drift, trend & fingerprinting.* `drift-forecast.js`. (Note:
  `expected-range.js` is claimed by both this area and Validation layers; it lives
  physically under `validation/`.)

- **`cleaning/`** — *Cleaning & fixes.* `clean.js`, `imputation.js`,
  `fuzzy-dedup.js`, `format-fingerprint.js`, `fix-confidence.js`, `materiality.js`.

- **`grades/`** — *Grades & health scores.* `calibrated-grades.js`,
  `cat-scorecard.js`, `golden-signals.js`.

- **`analysis-robustness/`** — *Analysis robustness.* `devils-advocate.js`.

- **`learning/`** — *On-device learning & personalization.* `memory-store.js`,
  `self-learning-rules.js`, `rule-suggestions.js`, `adaptive-priority.js`,
  `signal-store.js` (the shared in-memory signal bus).

- **`federated/`** — *Federated learning.* `federated-learning.js`,
  `federated-fingerprint.js`, `federated-transport.js`.

- **`provenance/`** — *Provenance, audit & trust.* `provenance.js`,
  `validation-receipt.js`, `assumption-ledger.js`, `peer-review.js`, `irb-mode.js`,
  `selective-disclosure-proof.js`.

- **`privacy/`** — *Privacy & synthetic data.* `privacy-budget.js`,
  `synthetic-twin.js`, `synthetic-adversarial.js`.

- **`simulation/`** — *Simulation & time travel.* `digital-twin.js`,
  `time-machine.js`, `time-travel-diff.js`.

- **`narrative/`** — *Narrative & language models.* `story.js`, `ondevice-llm.js`.

- **`runtimes-viz/`** — *Language runtimes & visualization.* `python-runtime.js`,
  `r-runtime.js`, `swift-preview.js`, `visualize.js`.

- **`protocol/`** — *Protocol & interoperability.* `protocol-conformance.js`.
  (Distinct from the top-level `protocol/` directory, which holds the interchange
  schemas and validator.)

- **`problem-framing/`** — *Problem framing.* `problem-framer.js`.

- **`export/`** — *Export & reporting.* `export-report.js`, `export-delivery.js`.

- **`teaching/`** — *Teaching & context.* `micro-lessons.js`, `community-pack.js`.

- **`agents/`** — *Conversational pack builder (Gen 42).* The guided, data-grounded
  flow for teaching validation rules without code: `question-generator-agent.js`
  (turns pipeline findings into grounded plain-English questions),
  `uncertainty-resolver-agent.js` (on-device A→E "I don't know" resolution), and
  `pack-builder-agent.js` (assembles CONFIRMED answers into a portable pack via
  `teaching/community-pack.js`). Its read-only peer index lives in
  `packs/local-pack-index.js`. All pure, browser-free, and network-clean. The
  thin Validate-tab presenter `conversational-pack-ui.js`
  (`shouldOfferPackBuilder` gate + `mountConversationalPackBuilder`) drives those
  agents as an in-page card, mounted by `app-shell/main.js` only when the
  `conversationalPackBuilder` flag is on — off by default, so the feature ships
  dark and renders nothing.

- **`metrics/`** — *Metric Studio (OneCanvas Phase 1).* `metric-studio.js`: define
  a named metric in plain English tied to real dataset columns, validate it against
  the live DuckDB schema, actually compute its value, and store it in a local-only
  `MetricRegistry` with duplicate detection. Pure logic + a DOM `renderMetricStudio`;
  ships dark behind the `metricStudio` flag.

- **`trust/`** — *Trust Strip & Proof Drawer (OneCanvas Phase 1).* `trust-strip.js`
  (`collectTrustSignals` builds a real-data trust bar — freshness, metric
  certification, validation tally, anomaly, lineage) and `proof-drawer.js`
  (`buildProofContent` renders the underlying proof for a metric, a Trust Strip
  field, or provenance — reusing `provenance/provenance.js`'s attestation renderer).
  Pure logic + DOM renderers; ship dark behind the `trustStripProofDrawer` flag.

- **`ambient/`** — *Ambient & real-time.* `watch-folder.js` and
  `ambient-validation.worker.js` (a Web Worker — loaded via `new Worker(...)`, never
  imported on the main thread).

- **`build/`** — *Build tooling & feature flags.* `build-flags.js`.

## Outside `js/`

- **`index.html`** — the single page; declares the import map and loads the shell.
- **`sw.js`** — service worker; precaches the app shell for offline use.
- **`assets/`** — self-hosted third-party assets (DuckDB-WASM, Plotly, SheetJS).
- **`protocol/`** — cross-tool interchange schemas (`schema/*.json`) and validator.
- **`docs/`** — long-form design docs, including `docs/capability-map.md` (the
  human-facing capability map) and `docs/tech-debt-tracker.md`.
- **`test/`** — Node-based unit/integration tests; each `test:*` npm script targets
  one suite. The DuckDB-dependent suites run against a native engine via the loader
  hook in `test/duckdb-loader-hook.mjs`.
- **`.github/scripts/`** — CI guardrails, notably `capability-drift.mjs` (a merge
  gate that keeps the manifest, the docs, and the shipped modules in agreement) and
  the read-only `entropy-scan.mjs`.

## Conventions worth knowing before you edit

- The manifest, `docs/capability-map.md`, and the `js/` tree must stay in sync — the
  drift gate enforces it. Add or move a module and update all three in one PR.
- Every capability declares a `platforms` list (`browser` / `desktop` / `mobile`);
  the registry loads only the modules meant for the detected runtime.
- Prefer editing an existing area over inventing a new one. New areas mean new
  folders and manifest groups, and should be a deliberate decision.
- See `AGENTS.md` for contributor/agent workflow rules and `README.md` for the
  product overview.
