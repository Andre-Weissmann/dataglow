// ============================================================
// DATAGLOW — Federated Fingerprint Learning test suite
// ============================================================
// Covers the entire client-side surface of the opt-in federated feature, with
// ALL network/WebRTC/GitHub calls replaced by in-memory fakes (no real network):
//   - local model: incremental per-source means, delta computation, apply/blend,
//     toJSON/fromJSON round-trip + garbage tolerance
//   - DP: L2 clipping bounds sensitivity; Gaussian sigma formula; privatized
//     update stays finite and is clipped-then-noised; epsilon guards
//   - secure aggregation: pairwise masks are equal-and-opposite and CANCEL in the
//     sum (== sum of raw updates) while a single masked update hides the raw one
//   - cohort gating: aggregateRound / aggregateSecureSum refuse below MIN_COHORT
//   - FedAvg: sample-weighted averaging of deltas, weights kept in [0,1]
//   - gossip peer selection: excludes self/unreachable, respects fanout, random
//   - transport decision: gossip-first, relay fallback when no peers
//   - coordination file: entries self-expire (TTL), prune keeps freshest per id
//   - relay payload: only masked/noised vectors, never raw
//   - receipts: SHA-256 hash chain links round-to-round
//   - coordinator orchestration: gossip aggregation, relay deferral + fallback,
//     graceful degradation (disabled / unreachable signaling / no WebRTC)
//   - opt-in/opt-out: nothing leaves the device until enabled
//
// RUN WITH:  node test/federated-learning.test.mjs
// Engine-free (no DuckDB) and network-free (all adapters are fakes).

import {
  MODEL_DIM, MIN_COHORT, FEATURE_SOURCES, COORDINATION_TTL_MS,
  LocalFingerprintModel, l2Norm, clipL2, gaussianSigma, gaussianNoise, privatizeUpdate,
  pairwiseMaskVector, pairSeed, maskSign, maskUpdate, sumMaskedUpdates,
  aggregateRound, aggregateSecureSum, selectGossipPeers, decideTransport,
  isExpired, pruneCoordinationEntries, upsertPresence, appendRelayUpdate, buildRelayPayload,
  buildContributionReceipt, hashUpdate, isWebRTCSupported, mulberry32, seedFromString,
} from '../js/federated/federated-learning.js';
import { FederatedCoordinator } from '../js/federated/federated-transport.js';

// ---------- tiny test harness ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
// Deterministic RNG for reproducible noise/selection in tests.
function seededRng(seed) { return mulberry32(seed >>> 0); }
function zeros() { return new Array(MODEL_DIM).fill(0); }
function vec(...xs) { const v = zeros(); xs.forEach((x, i) => { v[i] = x; }); return v; }

async function main() {
  // ================= local model =================
  ok(MODEL_DIM === FEATURE_SOURCES.length && MODEL_DIM > 0,
    `model dimension matches the shared source list (${MODEL_DIM})`);

  const m = new LocalFingerprintModel();
  ok(m.weights.every(w => w === 0.5), 'model: fresh weights start at the neutral 0.5 prior');
  ok(m.computeUpdate().every(x => x === 0), 'model: with no learning the outgoing delta is all-zero');

  const src = FEATURE_SOURCES[0];
  m.recordSignal(src, 1); m.recordSignal(src, 1); m.recordSignal(src, 1);
  const i0 = FEATURE_SOURCES.indexOf(src);
  ok(Math.abs(m.weights[i0] - 0.875) < 1e-9,
    'model: incremental mean folds accepts toward 1 (0.5→0.75→0.833→0.875)');
  ok(m.totalSignals === 3, 'model: totalSignals counts every recorded signal');
  ok(m.recordSignal(src, 'hover') === null && m.totalSignals === 3,
    'model: an ambiguous signal is ignored (carries no label)');
  ok(m.computeUpdate()[i0] > 0, 'model: computeUpdate reports the positive delta learned since base');

  // unknown source folds into "other"
  const before = m.weights.slice();
  m.recordSignal('totally-unknown-source', 0);
  const otherIdx = FEATURE_SOURCES.indexOf('other');
  ok(m.weights[otherIdx] !== before[otherIdx], 'model: an unknown source folds into the "other" bucket');

  // apply aggregate + blend + round bump
  const m2 = new LocalFingerprintModel();
  const g = zeros().map(() => 0.9);
  const roundBefore = m2.round;
  ok(m2.applyAggregate(g, 1) === true, 'model: applyAggregate accepts a correctly-sized global vector');
  ok(m2.weights.every(w => Math.abs(w - 0.9) < 1e-9), 'model: blend=1 fully adopts the global weights');
  ok(m2.round === roundBefore + 1, 'model: applying an aggregate advances the round counter');
  ok(m2.computeUpdate().every(x => x === 0), 'model: base is re-synced after apply (delta back to zero)');
  ok(m2.applyAggregate([1, 2, 3]) === false, 'model: applyAggregate rejects a wrong-length vector');

  const m3 = new LocalFingerprintModel();
  m3.applyAggregate(zeros().map(() => 1), 0.5);
  ok(m3.weights.every(w => Math.abs(w - 0.75) < 1e-9), 'model: blend=0.5 moves halfway toward the global');

  // serialization
  const json = m.toJSON();
  const restored = LocalFingerprintModel.fromJSON(json);
  ok(restored.weights.every((w, i) => Math.abs(w - m.weights[i]) < 1e-12) && restored.totalSignals === m.totalSignals,
    'serialize: toJSON/fromJSON round-trips weights and counts');
  const blank = LocalFingerprintModel.fromJSON(null);
  ok(blank.weights.length === MODEL_DIM && blank.weights.every(w => w === 0.5),
    'serialize: fromJSON(null) yields a fresh neutral model');
  const garbage = LocalFingerprintModel.fromJSON({ weights: [1, 2], counts: 'nope' });
  ok(garbage.weights.length === MODEL_DIM && garbage.counts.every(c => c === 0),
    'serialize: fromJSON tolerates garbage (wrong length / wrong type) without corruption');

  // ================= differential privacy =================
  ok(Math.abs(l2Norm([3, 4]) - 5) < 1e-12, 'dp: l2Norm is the Euclidean norm');
  const bigUpdate = vec(10, 0, 0);
  const clipped = clipL2(bigUpdate, 1.0);
  ok(Math.abs(l2Norm(clipped) - 1.0) < 1e-9, 'dp: clipL2 scales an over-budget vector to exactly the clip norm');
  const small = vec(0.1, 0.1);
  ok(clipL2(small, 1.0).every((x, i) => x === small[i]), 'dp: clipL2 leaves an under-budget vector unchanged');

  const sig1 = gaussianSigma(1.0, 1e-5, 1.0);
  const sig2 = gaussianSigma(0.5, 1e-5, 1.0);
  ok(sig1 > 0 && sig2 > sig1, 'dp: smaller epsilon => larger noise sigma (more privacy)');
  let threw = false; try { gaussianSigma(0); } catch { threw = true; }
  ok(threw, 'dp: gaussianSigma rejects epsilon <= 0');
  threw = false; try { gaussianSigma(1, 0); } catch { threw = true; }
  ok(threw, 'dp: gaussianSigma rejects delta outside (0,1)');

  // Gaussian sampler is ~zero-mean with the requested spread (statistical).
  const rngN = seededRng(12345);
  let s = 0, n = 20000;
  for (let k = 0; k < n; k++) s += gaussianNoise(2.0, rngN);
  ok(Math.abs(s / n) < 0.1, 'dp: Box-Muller Gaussian noise is approximately zero-mean');

  const priv = privatizeUpdate(bigUpdate, { epsilon: 1.0, delta: 1e-5, clipNorm: 1.0, rng: seededRng(7) });
  ok(priv.length === bigUpdate.length && priv.every(Number.isFinite),
    'dp: privatizeUpdate returns a finite, same-length vector (clip -> noise)');
  const noNoise = privatizeUpdate(bigUpdate, { epsilon: 1e9, delta: 1e-5, clipNorm: 1.0, rng: () => 0.5 });
  ok(Math.abs(l2Norm(noNoise) - 1.0) < 0.05, 'dp: with huge epsilon (~no noise) the update is essentially just clipped');

  // ================= secure aggregation (pairwise masking) =================
  ok(maskSign('a', 'b') === 1 && maskSign('b', 'a') === -1,
    'mask: the two members of a pair apply opposite signs');
  ok(pairSeed('a', 'b', 'salt') === pairSeed('b', 'a', 'salt'),
    'mask: the pair seed is identical regardless of argument order');
  const mv = pairwiseMaskVector(pairSeed('a', 'b', 'salt'));
  const mv2 = pairwiseMaskVector(pairSeed('b', 'a', 'salt'));
  ok(mv.every((x, i) => x === mv2[i]), 'mask: both peers derive the identical mask vector from the shared seed');

  const salt = 'round-1';
  const ids = ['alice', 'bob', 'carol'];
  const raws = {
    alice: vec(0.3, -0.1, 0.2),
    bob: vec(-0.2, 0.4, 0.1),
    carol: vec(0.1, 0.0, -0.3),
  };
  const masked = ids.map(id => maskUpdate(raws[id], id, ids.filter(x => x !== id), { sessionSalt: salt }));
  const maskedSum = sumMaskedUpdates(masked);
  const rawSum = ids.reduce((acc, id) => acc.map((x, i) => x + raws[id][i]), zeros());
  const maxErr = Math.max(...maskedSum.map((x, i) => Math.abs(x - rawSum[i])));
  ok(maxErr < 1e-9, 'secure-agg: the sum of masked updates equals the sum of raw updates (masks cancel)');
  ok(masked[0].some((x, i) => Math.abs(x - raws.alice[i]) > 1e-6),
    'secure-agg: a single masked update does NOT reveal the raw update');

  // ================= cohort gating + FedAvg =================
  const base = zeros().map(() => 0.5);
  const under = aggregateRound([{ update: vec(0.2), sampleCount: 1 }, { update: vec(0.2), sampleCount: 1 }], base, { minCohort: 3 });
  ok(under.applied === false && under.cohortSize === 2 && /Cohort too small/.test(under.reason),
    'cohort: aggregateRound refuses to apply below MIN_COHORT');

  const contribs = [
    { update: vec(0.4), sampleCount: 30 }, // heavily weighted
    { update: vec(0.0), sampleCount: 1 },
    { update: vec(0.0), sampleCount: 1 },
  ];
  const agg = aggregateRound(contribs, base, { minCohort: 3 });
  ok(agg.applied === true && agg.cohortSize === 3, 'cohort: aggregateRound applies once cohort >= minimum');
  ok(agg.weights[0] > 0.5 && agg.weights[0] < 0.9,
    'FedAvg: the sample-weighted mean pulls toward the higher-sample contributor');
  ok(agg.weights.every(w => w >= 0 && w <= 1), 'FedAvg: aggregated weights are clamped into [0,1]');

  const sec = aggregateSecureSum(maskedSum, ids.length, base, { minCohort: 3 });
  ok(sec.applied === true, 'cohort: aggregateSecureSum applies when cohort >= minimum');
  ok(Math.abs((sec.weights[0] - base[0]) - rawSum[0] / ids.length) < 1e-9,
    'secure-agg: recovered average delta matches (sum of raw)/cohort');
  ok(aggregateSecureSum(maskedSum, 2, base, { minCohort: 3 }).applied === false,
    'cohort: aggregateSecureSum refuses below MIN_COHORT');

  // ================= gossip selection + transport decision =================
  const peers = [
    { id: 'p1', reachable: true }, { id: 'p2', reachable: true },
    { id: 'p3', reachable: true }, { id: 'self', reachable: true },
    { id: 'p4', reachable: false },
  ];
  const sel = selectGossipPeers(peers, { selfId: 'self', fanout: 2, rng: seededRng(99) });
  ok(sel.length === 2, 'gossip: selection honors the fanout limit');
  ok(!sel.some(p => p.id === 'self'), 'gossip: selection never includes self');
  ok(!sel.some(p => p.id === 'p4'), 'gossip: selection excludes unreachable peers');
  ok(selectGossipPeers([{ id: 'self' }], { selfId: 'self', fanout: 3 }).length === 0,
    'gossip: with only self reachable, nothing is selected');

  ok(decideTransport(3, { minPeersForGossip: 1 }) === 'gossip', 'transport: peers reachable => gossip');
  ok(decideTransport(0, { minPeersForGossip: 1 }) === 'relay', 'transport: no peers reachable => relay fallback');

  // ================= coordination file rotation =================
  const now = 1_000_000;
  const fresh = { id: 'a', ts: now - 1000 };
  const stale = { id: 'b', ts: now - COORDINATION_TTL_MS - 1 };
  ok(!isExpired(fresh, now) && isExpired(stale, now), 'coord: TTL marks old entries expired');
  const pruned = pruneCoordinationEntries([fresh, stale, { id: 'a', ts: now - 500 }], now);
  ok(pruned.length === 1 && pruned[0].id === 'a' && pruned[0].ts === now - 500,
    'coord: prune drops expired and keeps only the freshest entry per id');

  const file0 = { peers: [{ id: 'old', ts: now - COORDINATION_TTL_MS - 1 }], relay: [] };
  const file1 = upsertPresence(file0, { id: 'self', offer: 'OFFER' }, now);
  ok(file1.peers.some(p => p.id === 'self') && !file1.peers.some(p => p.id === 'old'),
    'coord: upsertPresence adds self and rotates out expired peers');
  ok(file1.kind === 'dataglow-federated-coordination', 'coord: rotated file carries the expected kind tag');

  const relayFile = appendRelayUpdate(file1, buildRelayPayload({
    id: 'self', round: 0, maskedUpdate: vec(0.1), sampleCount: 5, epsilon: 1, delta: 1e-5,
  }), now);
  ok(relayFile.relay.length === 1 && Array.isArray(relayFile.relay[0].maskedUpdate),
    'coord: appendRelayUpdate stores a masked update payload');
  let payloadThrew = false;
  try { buildRelayPayload({ id: 'x', round: 0, maskedUpdate: 'not-a-vector' }); } catch { payloadThrew = true; }
  ok(payloadThrew, 'coord: buildRelayPayload refuses a non-vector (guards against leaking raw data)');

  // ================= receipts (hash chain) =================
  const uh = await hashUpdate(vec(0.1, 0.2));
  ok(typeof uh === 'string' && uh.length === 64, 'receipt: hashUpdate returns a 64-hex SHA-256 digest');
  const r1 = await buildContributionReceipt(null, { round: 1, cohortSize: 3, epsilon: 1, delta: 1e-5, transport: 'gossip', updateHash: uh });
  const r2 = await buildContributionReceipt(r1.hash, { round: 2, cohortSize: 4, epsilon: 1, delta: 1e-5, transport: 'relay', updateHash: uh });
  ok(r1.prevHash === null && r2.prevHash === r1.hash, 'receipt: each receipt links to the previous hash (chain)');
  ok(r1.hash !== r2.hash && r1.hash.length === 64, 'receipt: distinct rounds produce distinct chained hashes');

  // ================= graceful degradation probe =================
  ok(isWebRTCSupported({}) === false, 'degrade: isWebRTCSupported is false when RTCPeerConnection is absent');
  ok(isWebRTCSupported({ RTCPeerConnection: function () {} }) === true, 'degrade: isWebRTCSupported true when present');
  ok(seedFromString('a') !== seedFromString('b'), 'prng: seedFromString distinguishes different strings');

  await coordinatorTests();
}

// ================= coordinator orchestration (all adapters faked) =================
async function coordinatorTests() {
  const noisyRng = () => 0.5; // deterministic, ~no-op Box-Muller when paired

  // ---- disabled by default: nothing runs, nothing leaves the device ----
  {
    let published = 0;
    const signaling = {
      async fetchPeers() { return []; },
      async publishPresence() { published++; return true; },
      async fetchRelayUpdates() { return []; },
      async publishRelayUpdate() { published++; return true; },
    };
    const coord = new FederatedCoordinator({ model: new LocalFingerprintModel(), selfId: 'me', signaling, rng: noisyRng });
    const res = await coord.runRound();
    ok(res.status === 'disabled' && res.applied === false, 'coordinator: a disabled coordinator does nothing');
    const ann = await coord.announce('offer');
    ok(ann.ok === false && published === 0, 'opt-out: nothing is published while disabled');
  }

  // ---- gossip round reaches quorum and applies a secure aggregate ----
  {
    const model = new LocalFingerprintModel();
    model.recordSignal(FEATURE_SOURCES[0], 1); model.recordSignal(FEATURE_SOURCES[0], 1);
    const salt = 'g1';
    const selfId = 'me';
    const peerIds = ['p1', 'p2'];
    const signaling = {
      async fetchPeers() { return peerIds.map(id => ({ id, reachable: true })); },
      async publishPresence() { return true; },
      async fetchRelayUpdates() { return []; },
      async publishRelayUpdate() { return true; },
    };
    // The RTC fake returns each peer's OWN masked update, masked against the same
    // cohort — exactly what the secure-aggregation sum expects, so masks cancel.
    const cohortIds = [selfId, ...peerIds];
    const peerRaw = { p1: (() => { const v = new Array(MODEL_DIM).fill(0); v[0] = 0.2; return v; })(),
                      p2: (() => { const v = new Array(MODEL_DIM).fill(0); v[0] = -0.1; return v; })() };
    const rtc = {
      supported: true,
      async exchange(peer) {
        return maskUpdate(peerRaw[peer.id], peer.id, cohortIds.filter(id => id !== peer.id), { sessionSalt: salt });
      },
    };
    let receipt = null;
    const coord = new FederatedCoordinator({
      model, selfId, signaling, rtc, minCohort: 3, sessionSalt: salt, rng: noisyRng,
      epsilon: 1e9, // ~no DP noise so the aggregate is checkable
      onReceipt: r => { receipt = r; },
    });
    coord.enable();
    const res = await coord.runRound();
    ok(res.status === 'aggregated' && res.transport === 'gossip' && res.applied === true,
      'coordinator: a quorate gossip round aggregates and applies');
    ok(res.cohortSize === 3, 'coordinator: cohort size counts self + contributing peers');
    ok(receipt && receipt.transport === 'gossip' && receipt.hash.length === 64,
      'coordinator: a contribution receipt is emitted for an applied gossip round');
    ok(model.round === 1, 'coordinator: applying the aggregate advances the model round');
  }

  // ---- gossip cohort too small -> falls back to relay deferral ----
  {
    const model = new LocalFingerprintModel();
    const signaling = {
      async fetchPeers() { return [{ id: 'p1', reachable: true }]; }, // only 1 peer
      async publishPresence() { return true; },
      async fetchRelayUpdates() { return []; },
      async publishRelayUpdate() { return true; },
    };
    const rtc = { supported: true, async exchange() { return null; } }; // peer doesn't complete
    const coord = new FederatedCoordinator({ model, selfId: 'me', signaling, rtc, minCohort: 3, rng: () => 0.5, epsilon: 1e9 });
    coord.enable();
    const res = await coord.runRound();
    ok(res.transport === 'relay' && res.applied === false && res.status === 'deferred',
      'coordinator: below-quorum gossip falls back to relay and defers (no apply)');
    ok(/left on the coordination branch/.test(res.reason),
      'coordinator: deferral message tells the user their masked update was relayed for later');
  }

  // ---- relay round reaches quorum from accumulated peer updates ----
  {
    const model = new LocalFingerprintModel();
    let publishedRelay = null;
    const others = [
      { id: 'p1', maskedUpdate: (() => { const v = new Array(MODEL_DIM).fill(0); v[0] = 0.3; return v; })(), sampleCount: 5 },
      { id: 'p2', maskedUpdate: (() => { const v = new Array(MODEL_DIM).fill(0); v[0] = 0.3; return v; })(), sampleCount: 5 },
    ];
    const signaling = {
      async fetchPeers() { return []; }, // no live peers -> relay
      async publishPresence() { return true; },
      async fetchRelayUpdates() { return others; },
      async publishRelayUpdate(p) { publishedRelay = p; return true; },
    };
    const coord = new FederatedCoordinator({ model, selfId: 'me', signaling, minCohort: 3, rng: () => 0.5, epsilon: 1e9 });
    coord.enable();
    const res = await coord.runRound();
    ok(res.transport === 'relay' && res.applied === true && res.cohortSize === 3,
      'coordinator: relay aggregates once enough updates have accumulated (self + 2 relayed)');
    ok(publishedRelay && Array.isArray(publishedRelay.maskedUpdate) && publishedRelay.maskedUpdate.length === MODEL_DIM,
      'coordinator: relay round publishes our own masked+noised update for others');
    ok(!('raw' in publishedRelay) && publishedRelay.note.includes('no raw data'),
      'privacy: the relayed payload carries only masked/noised data, never raw');
  }

  // ---- graceful degradation: signaling throws -> stays local, no throw ----
  {
    const model = new LocalFingerprintModel();
    const signaling = {
      async fetchPeers() { throw new Error('network down'); },
      async publishPresence() { throw new Error('network down'); },
      async fetchRelayUpdates() { throw new Error('network down'); },
      async publishRelayUpdate() { throw new Error('network down'); },
    };
    const coord = new FederatedCoordinator({ model, selfId: 'me', signaling, minCohort: 3, rng: () => 0.5, epsilon: 1e9 });
    coord.enable();
    let crashed = false; let res;
    try { res = await coord.runRound(); } catch { crashed = true; }
    ok(!crashed, 'degrade: an unreachable coordination branch never throws');
    ok(res.applied === false && res.transport === 'relay',
      'degrade: with everything unreachable it stays purely local (relay/deferred, model untouched)');
    ok(model.round === 0, 'degrade: the local model is unchanged when nothing could be aggregated');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
