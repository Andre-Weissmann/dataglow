# DATAGLOW — Changelog

A running, one-line-per-change log of what shipped and when. Adding an entry here
is part of finishing a change, not a separate step — see the paper-trail section
in [`AGENTS.md`](../AGENTS.md).

Newest first. Each entry is a single line; link out to the PR where useful. This
log was started on 2026-07-08 and seeded from recent merged pull requests — it is
not a complete reconstruction of DATAGLOW's full history, only a forward-looking
record from roughly that point on.

## Unreleased

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
