# DATAGLOW — Tech-Debt Tracker

A living, agent-readable-and-writable audit log of known drift, deprecated
patterns, small inconsistencies, and doc/code mismatches in DATAGLOW's codebase
(currently ~60 flat JS modules in `js/` plus the `test/` suites).

Its whole purpose is memory across sessions. DATAGLOW is built and maintained in
short, mostly-autonomous coding-agent sessions. Without a shared record, each new
session re-discovers — and re-raises — the same small issues, or "fixes" one that
was already consciously accepted as a wontfix. This file is that shared record:
before proposing cleanup, a session should read it; after finding something worth
remembering, a session (or the weekly read-only scan — see
[`entropy-reduction-scan.md`](./entropy-reduction-scan.md)) should add it here.

This tracker is **not** an issue tracker for user-facing bugs and it does **not**
gate any release. It is deliberately low-ceremony: a plain markdown log anyone —
human or agent — can append to in one edit.

> **On provenance:** the practice of keeping a written, agent-maintained debt log
> and running a scheduled low-priority scan for accumulated drift is a general,
> publicly-documented engineering pattern (variously called tech-debt logs,
> entropy-reduction, or scheduled upkeep scans by multiple independent authors).
> Everything here is DATAGLOW's own wording and findings about DATAGLOW's own code.

## How to use this file

Each entry is one `###` block under **Entries** with these fields:

- **Date** — `YYYY-MM-DD` the entry was added.
- **Description** — one or two sentences: what the drift/inconsistency is.
- **Severity** — `low` / `medium` / `high`.
  - `low` — cosmetic or organizational; no behavioral impact.
  - `medium` — real inconsistency that *could* cause divergent behavior or confusion.
  - `high` — active correctness/security risk. (There should rarely be any of these
    sitting `open`; a `high` open item is a call to action.)
- **Area** — the affected file(s) or subsystem.
- **Status** — `open` / `fixed` / `wontfix`.
  - When resolving, change the status in place (don't delete the entry) and add a
    short `Resolution:` line, so future sessions see it was considered.
  - `wontfix` means a deliberate decision to accept it — record *why*, so it isn't
    re-raised.

Keep entries short. Link related modules with backtick paths (e.g. `js/app-shell/utils.js`).

> **Also read by:** the [`debug-log-tree`](../.claude/skills/debug-log-tree/SKILL.md)
> dev-tooling skill searches this file first whenever a session hits a bug,
> error, or design decision, before re-diagnosing it from scratch — and logs new
> entries here afterward, using this same format. This file stays the single
> shared log; that skill is just the workflow that makes sure it gets checked
> and updated consistently.

Newest entries go at the bottom of **Entries**.

## Entries

### 2026-07-11 — Synthetic Data Passport: provisional schemaVersion, seals the OUTPUT (not the source), and adversarial is caller-supplied

- **Description:** The Governed Synthetic Data Passport
  (`js/privacy/synthetic-data-passport.js`, Trust Passport Batch 4) is honest
  about what it records, but three limits are worth naming so a future session
  doesn't mistake the passport for more than it is. (1) **Provisional schema.**
  `SYNTHETIC_PASSPORT_SCHEMA_VERSION` is `1` and there is no migration/validation
  path yet; the embedded Batch-2 label and Batch-3 seal carry their own versions,
  so a reader must check all three if the shapes ever diverge. (2) **The seal
  binds the synthetic OUTPUT, not the source.** `sealSyntheticPassport`
  fingerprints the synthetic rows/CSV the caller is shipping (inheriting Batch 3's
  fingerprint-scope caveat above), which is the right thing to make tamper-evident
  for a recipient — but it means the seal proves nothing about the SOURCE data the
  twin was trained on; that lineage lives only in the (unsealed-by-default) label
  custody chain. (3) **`adversarial` is deliberately not auto-derived.**
  `js/privacy/synthetic-adversarial.js` produces adversarial TEST FIXTURES
  (planted-issue datasets), not robustness SCORES of a synthetic output, so the
  passport's `synthetic.adversarial` field stays `null` unless a caller passes a
  real robustness summary. Auto-filling it from the fixtures generator would be an
  honest-naming violation (claiming a robustness result that was never computed).
- **Severity:** low
- **Area:** `js/privacy/synthetic-data-passport.js`
- **Status:** open — accepted as scoped for Batch 4. A future "seal the whole
  synthetic dataset + its source lineage" design would supersede limits (1) and (2)
  together; (3) is a wontfix by design (never invent a robustness score).

### 2026-07-11 — Verifiable Check Seal binds to the query result, and fingerprints are unbounded

- **Description:** The Verifiable Check Seal (`js/provenance/verifiable-check-seal.js`,
  Trust Passport Batch 3) is honest about *what* it fingerprints, but two limits
  are worth naming so a future session doesn't mistake the seal for more than it
  is. (1) **Scope of the data fingerprint.** The SQL-tab affordance
  (`renderCheckSealAffordance` in `js/app-shell/main.js`) fingerprints the query
  RESULT rows — the concrete data in hand — so the seal binds to *that query's
  output*, not the whole source table. Sealing "the dataset" would need a stable,
  agreed fingerprint of the loaded DuckDB table(s) (row order, type coercion, and
  NULL rendering all affect the hash), which is a bigger design question deferred
  to Batch 4. The seal's own `disclaimer` and the `dataSource` field state what
  was fingerprinted, so the artifact never over-claims — but the UI copy only says
  "data matching a fingerprint", not which slice. (2) **Unbounded fingerprint
  input.** `fingerprintData` canonicalizes and hashes the entire value it is
  given; a very large result set is serialized in full in memory. Fine for the
  typical analyst query; a caller sealing millions of rows should pass a
  precomputed `dataFingerprint` (e.g. a streamed/DuckDB-side hash) instead. No
  size guard exists today. (3) **Row-order sensitivity.** The fingerprint is
  order-sensitive by design (documented + tested); callers wanting
  order-independence must sort first. Cleaner options if next touched: a
  DuckDB-side content hash for whole-table sealing, and a documented size ceiling
  or streaming path in `fingerprintData`.
- **Date:** 2026-07-11
- **Severity:** low
- **Area:** `js/provenance/verifiable-check-seal.js`, `js/app-shell/main.js` (SQL tab seal affordance)
- **Status:** open

### 2026-07-08 — Tauri desktop shell stages web assets via a hand-maintained allowlist

- **Description:** Tauri v1 refuses a `distDir` that contains `node_modules` or
  `src-tauri`, so the shell cannot point `distDir` at the repo root where the
  static site lives. Instead `scripts/stage-desktop-frontend.mjs` copies an
  explicit allowlist of runtime entries (`index.html`, `manifest.webmanifest`,
  `sw.js`, `assets/`, `css/`, `js/`, `protocol/`) into `src-tauri/dist/` before
  each build. The allowlist is maintained by hand: if the site adds a new
  top-level runtime asset (a new directory, or a new root file the app loads) and
  nobody updates the script, the desktop window will 404 on it while the browser
  build works. There is no automated check tying the two together. Cleaner
  options if next touched: derive the list from what `index.html`/the module
  graph actually reference, or add a smoke assertion that every root asset the
  site loads is present under the staged dir.
- **Date:** 2026-07-08
- **Severity:** low
- **Area:** `scripts/stage-desktop-frontend.mjs`, `src-tauri/tauri.conf.json`
- **Status:** open

### 2026-07-08 — Divergent `NUMERIC_TYPES` constant duplicated across 12 modules

- **Date:** 2026-07-08
- **Description:** The numeric-type allow-list `NUMERIC_TYPES` is re-declared as a
  local `const` in 12 separate `js/` modules, in **three divergent variants**:
  the short set `['DOUBLE','BIGINT','INTEGER','HUGEINT','FLOAT']` (7 files), a
  medium set adding `'DECIMAL','REAL'` (4 files), and one extended set in
  `js/privacy/synthetic-twin.js` also adding `SMALLINT/TINYINT/UINTEGER/UBIGINT`. Because
  the variants disagree, the same DuckDB column type (e.g. `DECIMAL`, `SMALLINT`)
  is treated as numeric by some validation layers and non-numeric by others. A
  single shared constant (e.g. exported from `js/app-shell/utils.js`) would remove the drift.
- **Severity:** medium
- **Area:** `js/anomaly/active-learning.js`, `js/validation/missingness.js`, `js/anomaly/predictive-anomaly.js`,
  `js/simulation/digital-twin.js`, `js/privacy/synthetic-adversarial.js`, `js/anomaly/isolation-forest.js`,
  `js/anomaly/spc-control.js`, `js/grades/golden-signals.js`, `js/federated/federated-fingerprint.js`,
  `js/anomaly/ondevice-ml.js`, `js/privacy/synthetic-twin.js`, `js/learning/self-learning-rules.js`
- **Status:** open

### 2026-07-08 — Two overlapping missingness modules classify MCAR/MAR/MNAR

- **Description:** Both `js/validation/missingness.js` (`analyzeMissingness`, wired into the
  summary/Golden-Signals path in `js/app-shell/main.js`) and `js/validation/missingness-detective.js`
  (the standalone validation layer) independently implement Rubin's
  MCAR/MAR/MNAR missingness taxonomy with their own thresholds and group-variation
  heuristics. The concepts and cut-offs are maintained twice; they can drift apart
  and give a user two different characterizations of the same column's missingness.
  Not urgent — they serve different surfaces today — but worth consolidating the
  shared heuristic if either is next touched.
- **Date:** 2026-07-08
- **Severity:** low
- **Area:** `js/validation/missingness.js`, `js/validation/missingness-detective.js`
- **Status:** open

### 2026-07-11 — Native (Tauri/Rust) file-watch trigger for the Semantic Drift Watchdog is deferred, not built

- **Description:** `js/ambient/drift-watchdog.js` (the de-duplication/notification-
  worthiness layer added in this PR) is deliberately trigger-agnostic — it only
  consumes an already-computed `distribution_drift` result and a file name, and
  has zero knowledge of *how* a file change was detected. Today the only trigger
  wired up is the existing browser-only `js/ambient/watch-folder.js` poll loop
  (File System Access API), because that is the only file-watching mechanism
  this codebase has. A native, OS-level file-watch trigger for the Tauri desktop
  shell (e.g. via the Rust `notify` crate, exposed as a Tauri command) was
  explicitly scoped OUT of this PR: `src-tauri/` is a bare/vanilla shell with
  zero custom Rust commands today, and the sandbox this PR was built in has no
  Rust toolchain at all (`cargo`/`rustc` not found), so any native code written
  here could not be compiled or verified before shipping — violating this
  project's "no unverified code" bar. Desktop builds currently have **no file-
  watching of any kind** (confirmed: `initWatchFolder()` in `main.js` explicitly
  disables the Watch Folder UI on desktop with "available in the browser build
  only"), so this is a pre-existing gap, not a regression introduced here.
- **Recommendation:** A follow-up PR, built and verified in an environment with
  a working Rust toolchain (ideally locally by a maintainer, or once sandbox
  Rust support exists), should add a minimal Tauri command wrapping the
  `notify` crate, emit a JS-side event on file change, and feed it into the
  SAME `DriftWatchdog.observe()` / `distribution_drift` pipeline this PR wires
  up for the browser path — no changes to `drift-watchdog.js` should be needed,
  since it was designed to be agnostic to what triggers `.observe()`. That PR
  should also lift the desktop Watch Folder restriction accordingly.
- **Date:** 2026-07-11
- **Severity:** low
- **Area:** `src-tauri/` (desktop shell), `js/ambient/drift-watchdog.js`, `js/ambient/watch-folder.js`
- **Status:** open

### 2026-07-08 — Flat `js/` directory has grown to ~60 top-level modules

- **Description:** All application modules live directly under `js/` with no
  sub-grouping (validation layers, engine/runtime, federated, on-device ML, UI all
  intermixed). This is intentional for the zero-build static-site setup (flat ES
  module imports, no bundler), but at ~60 files it makes ownership and relatedness
  hard to see at a glance. Tracked here as the baseline so the weekly scan can flag
  *further* growth and prompt a grouping decision — not an urgent change.
- **Date:** 2026-07-08
- **Severity:** low
- **Area:** `js/` (directory structure)
- **Status:** open

### 2026-07-11 — Local Analysis Contract's SQL tokenizer is regex-based, not a real parser

- **Description:** `js/validation/analysis-contract.js` (and the schema-aware
  upgrade to `checkSanityAnchor` in `js/ambient/ambient-validation.worker.js`)
  extract table/column/JOIN/GROUP BY references with regex-based tokenization,
  not a real SQL parser — this is already documented in the module's own header
  comment. It handles the common single-statement, non-nested query shapes the
  SQL tab is built around, but can miscount or miss references inside deeply
  nested subqueries, CTEs with shadowed column names, or unusual quoting. Every
  check degrades silently (no flag, not a crash) rather than guessing when the
  tokenizer is unsure, so the failure mode is "misses a real issue," never "flags
  a false one" — an intentional, accepted trade-off, not a correctness bug.
  Revisit only if a real analyst query shape is found that the tokenizer
  mishandles in practice; not worth a real parser dependency pre-emptively.
- **Date:** 2026-07-11
- **Severity:** low
- **Area:** `js/validation/analysis-contract.js`, `js/ambient/ambient-validation.worker.js`
- **Status:** open

### 2026-07-11 — Data Nutrition Label schema versioning is provisional and manifest is a separate download

- **Description:** `js/provenance/data-nutrition-label.js` stamps each manifest
  with an integer `schemaVersion` (currently `1`), chosen to match the sibling
  provenance modules' `version: 1` convention rather than the semver used under
  `protocol/`. There is no schema registry, migration path, or validator for the
  label shape yet — Batches 3 (selective-disclosure proofs) and 4 (synthetic-data
  metadata) will extend the same shape, and when they do the versioning story
  should be made deliberate (a documented bump rule, and ideally a `protocol/`
  schema so the drift/conformance tooling can check it). Separately, the opt-in
  label is delivered to the user as its own `.json` Blob download alongside the
  workbook/PDF, not embedded inside the exported artifact; a single self-contained
  export (e.g. the manifest carried inside the workbook, or a bundled archive)
  would be tidier but was out of scope for Batch 2. Neither is a correctness
  issue — the manifest is honest and self-describing today — just two decisions to
  revisit when the later batches touch this surface.
- **Date:** 2026-07-11
- **Severity:** low
- **Area:** `js/provenance/data-nutrition-label.js`, `js/export/export-report.js`
- **Status:** open

### 2026-07-11 — Semantic / Metrics Layer matches expressions by normalized string, not AST

- **Description:** `js/validation/semantic-layer.js` decides whether a query's
  aliased `SELECT` item matches a registered metric by *normalizing* both
  expression strings (strip table qualifiers/quotes/whitespace, lowercase) and
  comparing plus checking that every derived required column is present — it is
  not a semantic/AST equivalence check. So a query that computes the canonical
  metric a different-but-equivalent way (`SUM(amount - refund_amount)` vs the
  registered `SUM(amount) - SUM(refund_amount)`, reordered terms, an intermediate
  CTE, a column aliased upstream) will not match and therefore will *not* be
  flagged. Like the rest of the Contract this is deliberately biased toward "miss
  a real mismatch" over "cry wolf": a false negative is silent, a false positive
  would erode trust in a flags-only advisory. Comment-based detection is softer
  still (`info`). Revisit only if analysts define metrics whose canonical form is
  routinely written multiple equivalent ways in practice; not worth a SQL-AST
  dependency pre-emptively. Also in scope for a later batch: the registry is
  in-memory only (resets on reload), so there is no portable/exportable metric
  catalog yet.
- **Date:** 2026-07-11
- **Severity:** low
- **Area:** `js/validation/semantic-layer.js`
- **Status:** open

### 2026-07-12 — Golden-dataset double-load race threw "Table already exists"

- **Description:** A fast double-click (or any concurrent trigger) on the "Load
  Golden Test Dataset" button fired two concurrent `DATASET_ACTIONS.golden()`
  calls that both raced through `ensureDuckDB()` -> `loaders.loadGoldenDataset()`
  -> `engine.createTableFromRows()` (`js/app-shell/duckdb-engine.js`), whose
  `DROP TABLE IF EXISTS` + `CREATE TABLE` pair could interleave between the two
  in-flight calls, producing a "Catalog Error: Table ... already exists" and a
  failed load. Affected every sample-dataset path routed through
  `runDatasetLoad()` (golden/omop/fhir + file drops), not just the golden button.
- **Date:** 2026-07-12
- **Severity:** medium
- **Area:** `js/app-shell/main.js` (`runDatasetLoad`), `js/app-shell/duckdb-engine.js` (`createTableFromRows`)
- **Status:** fixed
- **Resolution:** Added a minimal module-level in-flight guard
  (`datasetLoadInFlight`) in `runDatasetLoad()`: a second call while a load is
  already running is a safe no-op, and a `finally` resets the flag so the Retry
  button (a fresh call after the first settles) still works. Regression test:
  `test/golden-dataset-load-race.test.mjs` (`npm run test:goldenloadrace`) —
  source-asserts the guard can't be silently deleted and proves the concurrency
  semantics. Fixed in PR `feature/proof-room-batch2-flags-and-bugfix`.

