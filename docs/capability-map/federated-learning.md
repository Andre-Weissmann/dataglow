# Capability detail — Federated learning

Companion to the **Federated learning** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the privacy-preserving cross-site features; the index alone is enough for most
tasks.

## Two independent capabilities under `js/federated/`

They share a privacy philosophy (never move raw data; add DP noise; degrade to
purely-local behavior) but are otherwise separate:
1. **Federated Fingerprinting** (`federated-fingerprint.js`) — compare two
   datasets' *shape* across sites via exported JSON, no shared rows.
2. **Federated Fingerprint Learning** (`federated-learning.js` +
   `federated-transport.js`) — collaboratively improve a tiny shared model of
   which flag sources are trustworthy, sharing only masked/noised weight deltas.

## Flag / gating state — NEITHER is in `flags.manifest.json`

- Neither capability has a feature flag. (`flags.manifest.json` mentions
  "federated" only inside *other* flags' descriptions — Rooms and Data Diplomacy
  cite `federated-transport.js` as the dependency-injection/NULL-adapter *pattern*
  they reuse, not this feature.)
- **Federated Fingerprinting** is an "Experimental" UI section, gated only by the
  presence of its DOM (`initFederatedFingerprint` returns early if `#btn-fp-export`
  is absent). Always shows `FINGERPRINT_DISCLAIMER` prominently.
- **Federated Fingerprint Learning** is gated by a **Settings opt-in toggle**,
  `state.settings.federatedLearningEnabled`, **OFF by default** — not a flag. The
  coordinator is only constructed/enabled when the user turns it on.

## `js/federated/federated-fingerprint.js` — DP shape fingerprint + compare

Pure JS, no DOM/engine; Laplace sampler injectable. Imports `laplaceNoise` from
`../privacy/privacy-budget.js`.
- `computeColumnFingerprint(col, values, { epsilon, bins, rng })` — per-column
  distribution with **hard privacy floors**: `MIN_N = 50` non-null rows or the
  column is **suppressed**; numeric bounds coarsened to ~2 sig figs
  (`coarsenBound`, never exact min/max); cardinality reported as a bucket
  (`cardinalityBucket`, not an exact distinct count); categorical labels seen
  `< RARE_CATEGORY_FLOOR (5)` folded into `(rare)`. Every histogram count gets
  Laplace noise (`noiseCounts`, sensitivity 1, scale `1/ε`) before normalizing.
- `buildFingerprint({ datasetName, columns, rows, epsilon, bins, rng })` → a
  `dataglow-fingerprint` v1 object (`experimental: true`, carries the disclaimer).
- `compareFingerprints(fpA, fpB)` → per-column **Jensen–Shannon divergence**
  (`jensenShannonDivergence`, range `[0, ln2]`) over aligned distributions
  (`alignColumns`/`rebinDistribution` put numeric columns on a shared grid,
  categoricals on the label union); columns with `jsd > MEANINGFUL_JSD (0.1)` are
  flagged `meaningful`. `parseFingerprint` validates the `kind` on import.

Wiring: `initFederatedFingerprint` (main.js ~5662) — Export runs
`SELECT * … LIMIT 100000`, builds a fingerprint, downloads it as JSON; Compare
reads two fingerprint files and renders the per-column JSD table.

## `js/federated/federated-learning.js` — the pure FL core

The model, privacy math, cohort gating, gossip selection, and receipt chain — all
pure, DOM/network-free, injectable `rng`.
- `class LocalFingerprintModel` — a fixed-length weight vector, one per
  `FEATURE_SOURCES` (= `KNOWN_SOURCES` from `../learning/self-learning-rules.js`),
  each the estimated P(a flag from that source is a real issue). Neutral 0.5
  prior; `recordSignal(source, label)` folds an accept(1)/dismiss(0) into a
  smoothed running mean; `computeUpdate()` returns the delta from the synced base;
  `applyAggregate(globalWeights, blend)` adopts a new global; `toJSON`/`fromJSON`.
- **DP (Gaussian mechanism):** `clipL2` bounds sensitivity to `DEFAULT_CLIP_NORM`,
  `gaussianSigma(ε, δ, sensitivity)` (Dwork & Roth Thm 3.22), `privatizeUpdate`
  clips-then-noises. `DEFAULT_EPSILON = 1.0`, `DEFAULT_DELTA = 1e-5`.
- **Secure aggregation (pairwise masking, Bonawitz 2017):** `pairwiseMaskVector`,
  `pairSeed`, `maskSign` (lexicographically smaller id adds, larger subtracts, so
  masks cancel in the sum), `maskUpdate`, `sumMaskedUpdates`.
- **Cohort gating + FedAvg:** `aggregateRound`/`aggregateSecureSum` refuse to
  apply below `MIN_COHORT (3)` distinct contributors; sample-weighted averaging;
  weights clamped to `[0,1]`.
- **Gossip + transport decision:** `selectGossipPeers` (Fisher–Yates, excludes
  self/unreachable), `decideTransport` (gossip-first, else relay).
- **Coordination file ("phone book"):** `isExpired`/`pruneCoordinationEntries`/
  `upsertPresence`/`appendRelayUpdate`/`buildRelayPayload` — entries self-expire
  after `COORDINATION_TTL_MS (5 min)`; `buildRelayPayload` throws if asked to
  publish anything but a masked vector.
- **Receipts:** `buildContributionReceipt`/`hashUpdate` — SHA-256 hash chain
  (reuses `sha256Hex` from `../provenance/provenance.js`). `isWebRTCSupported`
  probes `RTCPeerConnection`.

## `js/federated/federated-transport.js` — orchestration + adapters

`class FederatedCoordinator` runs one round and **never throws** — any failure
degrades to purely-local behavior. `runRound()`: privatize the delta → discover
peers → `decideTransport` → `_gossipRound` (pairwise-mask, exchange over injected
`rtc`, secure-aggregate once cohort met) or `_relayRound` (publish masked delta to
the branch, pull pending, cohort-gated FedAvg, else defer). `NULL_SIGNALING`/
`NULL_RTC` make "unreachable" a first-class error-free state. Browser adapters
`createGithubSignaling` (reads a rotating public phone-book branch unauthenticated;
publishing is a best-effort no-op without a write token) and `createWebRTCMesh`
(a thin stub whose `exchange` returns null rather than shipping an untested
handshake).

Wiring: `initFederatedLearning` (main.js ~6760) wires the enable / persist /
epsilon-slider / clear controls; `recordFederatedSignal` (~6712) feeds each
accept/dismiss (only when enabled) into `federatedModel`; `ensureFederatedCoordinator`
(~6728) builds the coordinator with `createGithubSignaling`/`createWebRTCMesh`.

## Tests

- `test/federated-learning.test.mjs` — the FL core + transport (local model, DP
  clipping/sigma, mask cancellation, cohort gating, FedAvg, gossip selection,
  coordination-file TTL, receipts, and coordinator orchestration via in-memory
  fakes — no real network).
- `test/synthetic-twin-time-machine-suite.test.mjs` — covers the fingerprint
  module (JSD properties, `buildFingerprint`, `compareFingerprints`, min-n floor).

## Related but not in scope

- `js/privacy/privacy-budget.js` supplies `laplaceNoise`; `js/learning/self-learning-rules.js`
  defines `KNOWN_SOURCES` (the model dimension); `js/provenance/provenance.js`
  supplies `sha256Hex`. The DI/NULL-adapter pattern here is reused by
  [`dataglow-rooms.md`](dataglow-rooms.md) and Data Diplomacy.
