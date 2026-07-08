# DATAGLOW — Changelog

A running, one-line-per-change log of what shipped and when. Adding an entry here
is part of finishing a change, not a separate step — see the paper-trail section
in [`AGENTS.md`](../AGENTS.md).

Newest first. Each entry is a single line; link out to the PR where useful. This
log was started on 2026-07-08 and seeded from recent merged pull requests — it is
not a complete reconstruction of DATAGLOW's full history, only a forward-looking
record from roughly that point on.

## Unreleased

- Add a Capability-Map Drift Detector (`capability-map.manifest.json`, `.github/scripts/capability-drift.mjs`, `npm run test:capdrift`, new `capability-map-drift` CI job) that fails the build when the capability-map docs and the shipped `js/` code fall out of sync — an overclaim (a documented capability's backing file/symbol is gone), a dangling doc reference, or an underclaim (a shipped top-level `js/` module with no capability-map entry). Why: the capability map is only useful if it stays honest, and nothing enforced that until now. Also fixes one real underclaim found while authoring the manifest — the shipped Devil's Advocate mode (`js/devils-advocate.js`) was missing from the map and is now documented.
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
