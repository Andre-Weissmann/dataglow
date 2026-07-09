# DATAGLOW — Decisions Index

A navigable, one-page index of DATAGLOW's design-decision history, kept for future
readers — human or AI — who need the shape of how the project got here without
reading every commit. Each row summarizes a generation or theme and its headline
decision, with a `Status` that says whether the decision is confirmed shipped in
*this* repository ("Built") or is recorded only in materials outside it. Most of
the early brainstorm generations live in the author's local workspace and were
never committed here, so an "external record only" status is expected and honest —
it means "not verifiable from this repo," not "did not happen." For the full
running log of what shipped and when, see [`CHANGELOG.md`](./CHANGELOG.md); for
where code lives, see [`capability-map.md`](./capability-map.md).

| Generation | Theme | Key Decision | Status |
|---|---|---|---|
| Gen 1–6 (Facet) | Pre-rename prototype lineage | Per [`DATAGLOW_VISION.md`](./DATAGLOW_VISION.md), the project iterated under the former name "Facet" and settled on DuckDB-WASM as its core engine before the DATAGLOW rename; no code from this era is committed here. | n.a. — external record only |
| Gen 7 | Foundation build | First committed DATAGLOW build — a static, zero-upload, zero-build app shell with a tabbed UI and the initial validation-layer set. | Built |
| Gen 8 | Trust, adversarial & collaboration tooling | Added adversarial/trust features (Devil's Advocate mode, hash-chained provenance trail, confidence-aware narration, on-device anomaly explainer, synthetic adversarial generator) and a collaboration suite (validation receipts, peer review, time-travel diff). | Built |
| Gen 9 | Healthcare depth, on-device intelligence & privacy | Added the domain physics engine, confidence-calibrated grades, verifiable provenance attestation, an on-device SLM interpreter with ambient validation, and the synthetic twin / data time machine / experimental federated fingerprinting / IRB-mode batch. | Built |
| Gen 10 | Platform reach & verifiable sharing | Added PWA install support with a protocol-first JSON-Schema API, a digital-twin what-if simulator with ambient watch-folder mode, and a selective-disclosure provenance proof (renamed from the earlier "ZK-proof" overclaim). | Built |
| Post-Gen 10 features | Validation-layer & analysis expansion | Continued additive layers and analyses — upper-bound sanity anchor, missingness detective, predictive anomaly scoring, expected-value ranges, forecast-based drift, self-learning rules, adaptive layer prioritization, and the unified signal layer. | Built |
| Post-Gen 10 foundations | Repo hygiene, CI & packaging | Established durable foundations — the golden regression suite, capability map with drift gates, dependency-freshness ledger, supply-chain install hardening, append-only zones with per-job CI workflows, the Living Manifest automation, an optional Tauri v1 desktop shell, and the Build Nervous System build-safety spine. | Built |
| Gen 11+ (later brainstorm) | Ongoing design generations | Later generation/brainstorm sessions (the project's generation count has continued well past Gen 10); their decision documents live in the author's local workspace rather than this repo. | n.a. — external record only |
