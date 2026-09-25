# Federated Learning real-world stress test — aggregateRound sampleCount (2026-09-24)

Structural Readiness Phase item 1 (prove breadth), fourth and final module. Unlike Meeting
Scribe / Arrow bridge / AI Council (all messy-input stress tests), Federated Learning needed a
different test shape per this skill's own guidance: multi-peer coordination, not just messy
data. `test/federated-learning.test.mjs` already has strong existing coverage (70 assertions):
pairwise mask cancellation, cohort gating, DP clip/noise, gossip/relay transport fallback,
graceful degradation, and privacy checks on relay payloads (masked/noised only, never raw).

This pass targeted the one multi-peer-adversarial angle the existing suite didn't cover: what
happens when a peer's SELF-REPORTED data is implausible or adversarial, since a federated
system's contributors are, by design, other people's devices you don't control.

## Ground truth (read before running anything)

`aggregateRound`'s FedAvg implementation weights each contributor's update by
`Math.max(1, c.sampleCount || 1)`. `sampleCount` is self-reported by each peer (in
`federated-transport.js`, it's `this.model.totalSignals` on the sending side, and on the
receiving/relay side it's read straight from `u.sampleCount` in a peer-supplied relay payload
with zero validation). `Math.max(1, ...)` only enforces a FLOOR (never less than 1) -- there is
no ceiling anywhere in the pipeline before this value is used as a weighting factor.

**Prediction:** a single peer (malicious, buggy, or just a misconfigured client) claiming a
fabricated, enormous `sampleCount` should be able to completely dominate the weighted average,
overwhelming an honest cohort's real signal -- a textbook FedAvg data-poisoning vector, no
different in principle from a Sybil attack's data-weight variant.

## Verified result (real function, not assumed)

Three honest peers with sample counts 8/10/12, all reporting the same small positive update
(+0.05), aggregate to `weight = 0.55` (a modest positive nudge) when aggregated alone. Adding a
fourth peer reporting `sampleCount = 999999999` and a large NEGATIVE update (-0.9) flips the
aggregate to `weight = 0` -- full domination by the fabricated outlier, the entire honest
cohort's signal erased. Confirmed exactly as predicted before any fix was applied.

## Fix applied, and why the first version of it was also wrong

Capped each contributor's effective `sampleCount` at `MAX_PEER_WEIGHT_SHARE_MULTIPLE` (3x) the
cohort's **median** `sampleCount`, applied before computing FedAvg weights.

The FIRST attempt at this fix used the cohort's **mean**, not median, as the cap's basis --
verified wrong before landing: since the outlier value (999999999) is itself part of the set
the mean is computed over, the mean gets dragged up to ~250,000,007, and a "3x mean" cap of
~750,000,021 barely constrains a value of 999,999,999 at all -- the capped result was still
`weight = 0`, i.e. no real fix. Switched to the median, which stays anchored to the honest
majority regardless of how extreme a single outlier is (a standard robust-statistics choice for
exactly this reason). Re-verified: the malicious-outlier case now yields `weight = 0.075` (the
attacker retains bounded influence, capped at 3x the honest median, but no longer full
domination) instead of `weight = 0`.

**Confirmed the cap doesn't punish a genuinely more-active honest peer:** a fourth peer with a
plausible 5x-larger sample count (50 vs the others' 8-12) still gets substantial extra weight
(`weight = 0.576`, roughly half the total weighted influence) -- the cap bounds implausible
self-reported extremes without flattening real, honest variation in how much local data
different users happen to have.

**Confirmed no regression on the existing test's own FedAvg case** (`sampleCount: 30, 1, 1` in
`test/federated-learning.test.mjs`): pre-fix weight was 0.875, post-fix (median=1, cap=3) is
0.74 -- both fall within that test's existing assertion range `(0.5, 0.9)`, and the same
qualitative claim the test makes ("the sample-weighted mean pulls toward the higher-sample
contributor") still holds, just bounded rather than unbounded.

## What this does NOT fix (documented, not silently ignored)

This is a bounded mitigation, not a full Byzantine-robust aggregation scheme. A coordinated
group of colluding peers (not just one outlier) could still shift the median itself and partly
evade the cap -- true Byzantine-robust aggregation (e.g. Krum, coordinate-wise median of
updates rather than weights) is a substantially larger design change, out of scope for this
pass. The secure-aggregation/gossip path (`aggregateSecureSum`) was not modified in this pass:
it aggregates an already-summed masked vector where individual peer sample counts are not
separately visible in the sum itself, so the same fix does not directly apply there -- worth a
dedicated look in a future pass, noted as a follow-up rather than assumed already covered.
