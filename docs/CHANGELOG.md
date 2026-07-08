# DATAGLOW — Changelog

A running, one-line-per-change log of what shipped and when. Adding an entry here
is part of finishing a change, not a separate step — see the paper-trail section
in [`AGENTS.md`](../AGENTS.md).

Newest first. Each entry is a single line; link out to the PR where useful. This
log was started on 2026-07-08 and seeded from recent merged pull requests — it is
not a complete reconstruction of DATAGLOW's full history, only a forward-looking
record from roughly that point on.

## Unreleased

<!-- NEW-ENTRIES-BELOW: append new changelog lines directly under this line, do not edit existing entries below -->

- Restructure the three files that kept colliding on parallel PRs into append-only zones, and split CI into per-job reusable workflows. `docs/CHANGELOG.md` (this `## Unreleased` section), `AGENTS.md` (the new *Foundations & capabilities* section), and `.github/workflows/test.yml` (the job list) now each carry an explicit append-only marker, so a new entry is a single-line insert at one fixed point and two PRs adding different entries no longer textually conflict. `.github/workflows/test.yml` is now a thin orchestrator that `uses:` one reusable workflow per job under `.github/workflows/jobs/` (each triggered via `on: workflow_call`), so adding/changing a CI job touches its own small file instead of the shared 8-job YAML; also added `merge_group` as a trigger for future merge-queue compatibility. Check-run names change from a single segment (e.g. `SQL logic (native DuckDB)`) to two segments (e.g. `sql-logic / SQL logic (native DuckDB)`); no required status checks are currently configured on `main`, so nothing silently stops enforcing. Why: nearly every new CI/infra foundation had to edit all three files, making merge conflicts the norm whenever two foundations landed in parallel.
- Add Supply-Chain Install Hardening: a root `.npmrc` with `ignore-scripts=true` (disables dependency preinstall/install/postinstall lifecycle scripts, the most common supply-chain attack vector), a new `supply-chain-hardening` CI job, and `.github/scripts/check-lifecycle-scripts.mjs` (`npm run test:lifecycle-scripts`) that fails the build if any dependency declares a lifecycle script not on its explicit allowlist. The job also publishes a CycloneDX SBOM (`docs/sbom.json`) as a build artifact. Verified the DuckDB dependencies need no install scripts (so nothing rebuilds); only the dev-only `playwright-chromium` carries one, and it is allowlisted. Known limitation: `min-release-age=7` was intentionally omitted because it requires npm ≥ 11.10.0 and CI runs npm 10.8.2 — re-add once the toolchain upgrades. Why: a long-lived, dependency-light project should make install-time code execution a reviewed, versioned decision rather than something that can creep in silently.
- Add an AGENTS.md Context-Rot Detector (`.github/scripts/agents-md-drift.mjs`, `npm run test:agentsdrift`, new `agents-md-drift` CI job) that fails the build when `AGENTS.md` references a file path no longer in the tree or an npm script absent from `package.json`. Pure static analysis (regex extraction of backtick-quoted file-path- and npm-script-like tokens + filesystem/`package.json` lookups — no LLM, no network); wildcard globs like `test:*` are treated as descriptive and never failed on. Why: every stateless coding subagent reads and trusts `AGENTS.md` before working, so a stale reference silently misleads each later generation — this keeps the shared instructions honest. Ran green against the current `AGENTS.md` (9 file references, 0 stale), so no existing references needed fixing.
- Add a Capability-Map Drift Detector (`capability-map.manifest.json`, `.github/scripts/capability-drift.mjs`, `npm run test:capdrift`, new `capability-map-drift` CI job) that fails the build when the capability-map docs and the shipped `js/` code fall out of sync — an overclaim (a documented capability's backing file/symbol is gone), a dangling doc reference, or an underclaim (a shipped top-level `js/` module with no capability-map entry). Why: the capability map is only useful if it stays honest, and nothing enforced that until now. Also fixes one real underclaim found while authoring the manifest — the shipped Devil's Advocate mode (`js/devils-advocate.js`) was missing from the map and is now documented.
- Add a Dependency Freshness Ledger (`.github/scripts/dependency-freshness.mjs`, `npm run test:deps-freshness`, new `dependency-freshness` CI job) that reads `package.json`/`package-lock.json`, queries the npm registry (`npm outdated`/`npm audit`), and regenerates `docs/dependency-freshness-ledger.md`; it FAILS CI when a dependency is more than 2 majors behind or a high/critical advisory is found, and only warns on minor/patch drift. Why: a long-running side project silently accumulates stale, potentially vulnerable dependencies — this makes that drift a visible, versioned artifact and gates the worst cases.
- Add a proof-of-concept Databricks Direct-Connect: optional BYO-token, browser-direct, read-only pull from a user's own Databricks SQL warehouse into local DuckDB, reusing the file-import ingest path. Why: validate whether users can bring warehouse data into DATAGLOW's local engine without a server or persisted credentials (`js/databricks-connect.js`, `docs/databricks-connect.md`).
- Wire the `test:databricks` suite into CI as its own `databricks-connect` job so it runs on every push/PR. Follow-up fix: the Databricks Direct-Connect PR added the script and test but never ran them in GitHub Actions (`.github/workflows/test.yml`).
- Add a Golden Regression Suite (`test/golden/`, `npm run test:golden`, new CI job) that snapshot-tests the core deterministic operations — SQL cleaners, the validation-layer orchestrator, cross-column/bounds checkers, and the calibrated-grade roll-up — against versioned fixtures; why: give the fast-moving, agent-authored feature stream a safety net so adding a feature can't silently change existing output.
- Add a progressive-disclosure capability map (`docs/capability-map.md` + `docs/capability-map/`) that maps every `js/` module to a feature area (#34).
- Document the plan-before-code and changelog-on-completion conventions in a new root `AGENTS.md`, and start this changelog (#34).

## 2026-07-08

- Add tech-debt tracker plus a weekly read-only entropy-reduction scan (#33).
- Add the Unified Signal Layer, a shared in-memory coordination store for the on-device analysis modules (#32).

## 2026-07-07

- Add Expected Value Ranges: informational numeric-column trend bands alongside the drift layer (#31).
- Add Federated Fingerprint Learning (Phase 1): opt-in, off by default, privacy-preserving (#30).
- Add Forecast-Based Drift Alerting using Holt's exponential smoothing to extend the distributional-drift layer (#29).
- Add an in-browser small-model (WebLLM / Qwen2.5-1.5B) mode to the Story tab (#28).
- Add Adaptive Layer Prioritization: on-device learned ordering of the Validate layers (#27).
- Add Predictive Anomaly Scoring: a holistic kNN/Gower row-level outlier detector (#26).
- Add Self-Learning Validation Rules: on-device logistic regression over the user's own corrections (#25).
- Fix inconsistent validation-layer counts across docs and UI (verified: 20 layers) (#24).
- Rename the "ZK-proof" feature to "selective-disclosure provenance proof" to correct a cryptographic overclaim (#23).
- Correct unverified dataset-scale and synthetic-fidelity claims in the docs (#22).
