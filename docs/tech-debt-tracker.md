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

### 2026-07-12 — Unit Test Layer: duplicate check is byte-identical-only; referential-integrity check only tests FK non-nullness

- **Description:** Two scope gaps in `runUnitTests()`
  (`js/validation/validation.js`), now made VISIBLE and ASSERTED by tests but not
  yet fixed (fix is a separate PR). (1) **Duplicate detection is byte-identical
  only.** The check is `GROUP BY <every column>`, so it catches only fully
  identical rows; two rows sharing the same real-world business key but differing
  in one incidental column (e.g. an event timestamp) are a logical duplicate it
  misses. (2) **Referential integrity only checks FK non-nullness.** For each
  non-key `*_id` column it counts NULLs and emits a `null_ref` finding, but it
  never verifies the referenced value actually exists in a parent table — so a
  non-null-but-nonexistent (orphan) FK is never caught.
- **Date:** 2026-07-12
- **Severity:** medium
- **Area:** `js/validation/validation.js` (`runUnitTests` duplicate + referential-integrity blocks), `test/validation-layers.test.mjs`
- **Status:** open — coverage added this PR, detection logic intentionally
  unchanged. `test/validation-layers.test.mjs` now asserts the CURRENT (missing)
  behavior for a true orphan FK and a business-key-only duplicate, each with a
  positive-control fixture (null FK trips `null_ref`; byte-identical rows trip
  `duplicate`). When the detection logic is later hardened, those two
  "KNOWN GAP" assertions must be flipped intentionally so the change is reviewed,
  not silent.


### 2026-07-12 — Rebase gotcha: a conflict side can carry an in-place edit to an EXISTING entry bundled with its append, not just a stale fragment

- **Description:** Backlog PR triage (PR #115, Command Deck Part 2) hit a
  `flags.manifest.json` conflict that looked at first glance like the familiar
  "ours has the full flag chain, theirs has a stale fragment + one new flag"
  pattern already solved for PRs #123/#118/#117. It was NOT that pattern: this
  PR's own commit both (a) corrected the EXISTING `dataglowSidebarNav` flag's
  description in place (dropped a stale "13 tabs" reference, added a note about
  the 14th "meeting" tab) AND (b) appended the new `dataglowCommandPalette` flag
  — two changes bundled in one diff hunk. A resolution that only kept "ours"
  and appended "theirs'" new flag (the usual pattern) would have silently
  dropped the in-place correction to `dataglowSidebarNav`, since main's copy of
  that flag still had the old "13 tabs" wording.
- **Date:** 2026-07-12
- **Severity:** medium
- **Area:** rebase conflict resolution process (`flags.manifest.json`, `capability-map.manifest.json`, any append-only JSON manifest)
- **Status:** resolved this PR — before assuming a flags/capability-map conflict
  is the standard "complete chain vs. stale fragment + new entry" shape, run
  `git show <commit-sha> -- <path>` on the branch's own commit FIRST and read
  its actual diff hunks. If the commit's diff touches an existing key's value
  (not just adds a new key), the correct resolution applies that in-place edit
  on top of the current main-side value, THEN appends the new entry — simply
  picking one full side and bolting on the other side's new block is not
  sufficient when a hunk modifies shared content instead of only adding to it.
### 2026-07-12 — Merge-conflict markers can silently swallow adjacent tokens; naive duplicate-id regex false-positives on `data-testid`

- **Description:** Two merge-mechanics gotchas surfaced while rebasing PR #107
  (`feature/verified-debate`, 4 commits) onto `main`, neither a DATAGLOW product
  bug but both worth recording so future conflict resolution catches them
  immediately instead of by luck. (1) **A conflict marker line — especially a
  bare `=======` — can land exactly at a hunk boundary and eat an adjacent
  closing brace/token belonging to the "ours" side of a JS file.** In
  `js/app-shell/main.js` this silently swallowed the closing `}` of
  `renderObjectSpacePanel()`; removing just the 3 marker lines was not
  sufficient — `node --check` was required to catch it (`Unexpected end of
  input`), then `git show HEAD:<path>` was needed to find and restore the
  elided token. Grepping for leftover `<<<<<<<`/`=======`/`>>>>>>>` markers is
  necessary but NOT sufficient proof a JS merge resolution is correct. (2)
  **Duplicate-DOM-id checks via a naive regex (`id="\K[^"]+"` without a
  word-boundary anchor) produce false positives by also matching inside
  `data-testid="..."` attributes** (since `id="` appears as a substring of
  `data-testid="`), making a real duplicate-id scan report ~45 phantom
  "duplicates" and risking the real signal (one genuine duplicate `id` was
  found this same session, unrelated to the false positives) getting lost in
  the noise. A properly anchored pattern (e.g. a leading-space `' id="'` literal
  grep, or `(?:^|[^-\w])id="\K[^"]+`) is required.
- **Date:** 2026-07-12
- **Severity:** low (process/tooling gotcha, not a shipped-code defect)
- **Area:** merge-conflict-resolution process (not a specific `js/` module); surfaced during PR #107 rebase
- **Status:** open as a documented gotcha — no code change needed. Recommended
  standing practice for any future manual conflict resolution: after resolving
  any `.js` file, run `node --check <file>` even when no markers remain, and
  diff suspicious hunk boundaries against `git show HEAD:<path>`; after
  resolving any `.html` file, scan for duplicate `id=` attributes with a
  properly anchored pattern, never a bare `id="\K[^"]+"`.
### 2026-07-12 — Rebase gotcha: in-place doc-bullet edits can land as stale-duplicate-plus-new across multi-commit rebases

- **Description:** When rebasing a multi-commit branch through append-only docs
  (`docs/CHANGELOG.md`, `AGENTS.md`, `flags.manifest.json`), a conflict that looks
  like a pure append can actually hide a case where one commit's real intended
  diff was an in-place *edit* of an existing bullet/field (not a fresh addition).
  If each commit's conflict is resolved independently without checking the
  commit's own diff (`git show <sha> -- <path>`), the naive "keep both sides"
  append resolution can leave the pre-edit (stale) version of that bullet sitting
  alongside the post-edit version — a silent duplicate that reads as two
  plausible entries instead of one corrected one.
- **Date:** 2026-07-12
- **Severity:** low (process gotcha, not a shipped defect — caught during backlog
  PR rebase triage before merge)
- **Area:** rebase/merge-conflict workflow for append-only doc files during
  multi-commit branch rebases
- **Status:** mitigated by process — established rule: after resolving any
  append-only-looking conflict, verify with `grep -c` for duplicate
  section/entry headers, and when in doubt, check `git show <commit-sha> -- <path>`
  to confirm which side is the commit's real intended diff before finalizing.
  No code/doc content fix needed; this entry exists so future sessions apply the
  check proactively instead of rediscovering it.

### 2026-07-12 — Rebase gotcha: reusing a stale local branch name across PRs silently rebases the wrong branch

- **Description:** While triaging PR #123 (`feature/analysis-robustness-sensitivity-verdict`)
  immediately after finishing PR #124 (`feature/meeting-provenance-bridge`), an
  earlier `git checkout` of the PR #123 branch failed silently (local changes
  would have been overwritten) and was not re-verified before running
  `git rebase origin/main`. The rebase and its conflict resolutions were
  therefore applied to the still-checked-out `feature/meeting-provenance-bridge`
  branch instead — a branch already pushed and merged-pending for a different
  PR. Caught before any push because `git branch --show-current` was checked
  immediately after the rebase completed and didn't match the PR being worked
  on; the local branch was reset with
  `git reset --hard origin/<branch>` and the correct branch was freshly fetched
  and checked out (`git checkout -B <branch> origin/<branch>`) before redoing
  the rebase. No remote state was ever affected.
- **Date:** 2026-07-12
- **Severity:** medium (could have force-pushed unrelated commits onto a
  different PR's branch if not caught pre-push)
- **Area:** rebase/merge-conflict workflow, branch-checkout discipline during
  sequential backlog PR triage
- **Status:** mitigated by process — established rule: always run
  `git branch --show-current` immediately after `git checkout` succeeds (not
  just after failures) and again right after a rebase completes, confirming it
  matches the PR's `head.ref` from `gh api repos/.../pulls/<n>`, before doing any
  conflict resolution work or push.
### 2026-07-11 — Shared metrics registry wired only into the SQL tab

- **Description:** The in-session shared metrics registry
  (`js/app-shell/metrics-registry.js`, keyed per-dataset in `js/app-shell/state.js`)
  is designed so all five consuming surfaces — SQL, Python, R, Visualize, and
  Story/narrative tabs — read metric definitions from one source of truth. This
  batch wired only the SQL tab end-to-end (the "Saved Metrics" card plus `@metric`
  expansion in `runSqlQuery`) as the proof path. The Python (`js/runtimes-viz/python-runtime.js`),
  R (`js/runtimes-viz/r-runtime.js`), Visualize (`js/runtimes-viz/visualize.js`),
  and Story (`js/narrative/story.js`) tabs do NOT yet reference the registry, so a
  metric defined once is currently honored only in SQL. Deferred deliberately to
  keep this batch to one real, tested path rather than five shallow ones; the
  registry API (`resolveMetricSql`, `expandMetricReferences`, `getActiveMetricsRegistry`)
  is already surface-agnostic, so wiring each remaining tab is additive.
- **Date:** 2026-07-11
- **Severity:** low
- **Area:** `js/app-shell/metrics-registry.js`, `js/runtimes-viz/python-runtime.js`, `js/runtimes-viz/r-runtime.js`, `js/runtimes-viz/visualize.js`, `js/narrative/story.js`
- **Status:** open

### 2026-07-11 — "Truncated Axis" nutrition badge not shippable; nutrition label wired to one surface

- **Description:** The Dataset Nutrition Label
  (`js/provenance/nutrition-badges.js`) ships six badges, each backed by a real
  computed signal. A seventh candidate — "Truncated Axis" (warn when a chart's
  y-axis does not start at zero / is visually truncated) — was deliberately NOT
  shipped: `js/runtimes-viz/visualize.js` only carries axis *title* configuration
  and exposes no truncated / zero-baseline signal to compute the badge honestly,
  and the "no decorative badges" rule forbids faking it. Shipping it needs
  `visualize.js` to surface a real per-chart axis-range/zero-baseline fact for
  `computeBadges` to read. Separately, the label + Analysis Fingerprint
  (`js/provenance/analysis-fingerprint.js`) are wired end-to-end on ONE surface
  only — `renderDataHealth` (the Validate-tab Data Health dashboard) in
  `js/app-shell/main.js`; the SQL result grid and Visualize/chart exports are not
  yet badged or fingerprinted. Deferred to keep this batch to one real, tested
  rendering path; both modules are pure and surface-agnostic, so extending them is
  additive.
- **Date:** 2026-07-11
- **Severity:** low
- **Area:** `js/provenance/nutrition-badges.js`, `js/runtimes-viz/visualize.js`, `js/provenance/analysis-fingerprint.js`, `js/app-shell/main.js`
- **Status:** open

### 2026-07-11 — Incident postmortem: only annotate-only corrections apply; wired to one finding type

- **Description:** The blameless incident postmortem
  (`js/provenance/incident-postmortem.js`) proposes four correction kinds
  (`add-outlier-context`, `tighten-validation-rule`, `revise-metric`,
  `review-finding`), but only `add-outlier-context` maps onto an existing portable
  domain-pack rule kind (`outlier-context`), so it is the only one the Accept
  handler in `js/app-shell/main.js` can route through the existing confirm-gated
  `communityPack.importPack` → `domainPhysics.registerRuntimePack` path. The other
  three (tightening a rule, revising a metric) are — correctly — NOT auto-applied:
  Accept records them to the assumption ledger for manual follow-up. A real
  "tighten a validation rule" or "revise a metrics-registry definition" apply path
  would need a hard-fail-capable rule kind in `js/validation/domain-physics.js` +
  the portable schema (deliberately out of scope; the annotate-only sandbox is a
  safety rail) or a confirm-gated metrics-registry edit surface. Separately, the
  "Report incident" trigger is wired to ONE finding type — Upper-Bound Sanity
  findings (the canonical false-positive case) in `renderValidationResults`; other
  layers' findings are not yet reportable. Deferred to keep this batch to one real,
  tested apply path; the pure module is surface- and finding-agnostic, so extending
  the trigger to more layers is additive.
- **Date:** 2026-07-11
- **Severity:** low
- **Area:** `js/provenance/incident-postmortem.js`, `js/app-shell/main.js`, `js/validation/domain-physics.js`
- **Status:** open
