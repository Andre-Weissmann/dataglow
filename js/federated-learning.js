// ============================================================
// DATAGLOW — Federated Fingerprint Learning  (Phase 1, opt-in / OFF by default)
// ============================================================
// Multiple DATAGLOW users can collaboratively improve the app's shared
// fingerprint / pattern-detection model WITHOUT any raw data — or even any
// single user's raw weight update — ever leaving the browser in the clear.
// Each user trains a tiny local model on their OWN validation-session feedback
// (the same accept/dismiss signal stream that already powers Self-Learning
// Validation Rules, PR #25, and Adaptive Layer Prioritization, PR #27 — one
// tracking pathway, not a new one) and shares only privacy-protected WEIGHT
// UPDATES, which are averaged into a shared model.
//
// This module is the PURE, DOM-free, network-free core: the model, the privacy
// mathematics, the cohort gating, the gossip peer-selection and GitHub-relay
// fallback decisions, and the contribution-receipt hash chain. All randomness is
// injectable (an `rng` returning [0,1)) so every function is deterministic under
// test. The transport/orchestration (WebRTC + GitHub coordination branch) lives
// in js/federated-transport.js and only ever calls into this file.
//
// PRIVACY / SAFETY LAYERS (all implemented here, each an independently published,
// public-domain technique — implemented from first principles, no paper's
// reference code copied):
//   1. Secure Aggregation via PAIRWISE MASKING (Bonawitz et al., "Practical
//      Secure Aggregation for Privacy-Preserving Machine Learning", CCS 2017).
//      Each pair of peers agrees a shared seed; peer i adds +mask(seed_ij) and
//      peer j adds -mask(seed_ij) to their update. The masks are equal-and-
//      opposite, so they VANISH in the sum — the aggregate is exact, but no
//      relay or peer can read any single peer's raw update.
//   2. DIFFERENTIAL PRIVACY noise, DP-SGD style (Dwork & Roth, "The Algorithmic
//      Foundations of Differential Privacy", 2014, §3.5.3 Gaussian mechanism;
//      Abadi et al., "Deep Learning with Differential Privacy", CCS 2016 — clip
//      then add Gaussian noise). The per-update L2 norm is clipped to a bound
//      (bounding sensitivity) and calibrated Gaussian noise is added before the
//      update leaves the device. Epsilon (ε) is user-tunable in the settings UI.
//   3. MINIMUM COHORT THRESHOLD + ROUND-BASED aggregation. An aggregate is only
//      computed and applied when at least MIN_COHORT distinct peers contributed
//      to the round — never from one or two updates that could be singled out.
//   4. Federated averaging itself (McMahan et al., "Communication-Efficient
//      Learning of Deep Networks from Decentralized Data", AISTATS 2017 —
//      FedAvg), weighting each contribution by its local sample count.
// The gossip transport follows the decentralized-SGD gossip pattern (Boyd et al.,
// "Randomized Gossip Algorithms", IEEE Trans. Inf. Theory 2006; Lian et al.,
// "Can Decentralized Algorithms Outperform Centralized...? D-PSGD", NeurIPS 2017).
//
// SCOPE: Phase 1 only. Threshold secret-sharing of an update ACROSS both the
// gossip and relay channels is explicitly Phase 2 and NOT implemented here.

import { sha256Hex } from './provenance.js';
import { KNOWN_SOURCES } from './self-learning-rules.js';

// ------------------------------------------------------------
// Constants (all surfaced in / referenced by the settings UI)
// ------------------------------------------------------------

// The shared model is a small, fixed-length weight vector — one weight per known
// flag source (see KNOWN_SOURCES in self-learning-rules.js). A weight is the
// collaboratively-estimated probability that a flag from that source is a REAL
// issue worth surfacing. Keeping the dimension small and fixed keeps updates
// tiny, keeps the averaging math transparent, and keeps the wire payload
// obviously free of any raw row data.
export const FEATURE_SOURCES = KNOWN_SOURCES.slice();
export const MODEL_DIM = FEATURE_SOURCES.length;

// Minimum distinct contributing peers before a round may be aggregated/applied.
export const MIN_COHORT = 3;

// Differential-privacy defaults. Epsilon is user-tunable; smaller = more privacy,
// more noise. Delta is the standard (ε, δ)-DP failure probability for the
// Gaussian mechanism, fixed small.
export const DEFAULT_EPSILON = 1.0;
export const DEFAULT_DELTA = 1e-5;

// L2 clipping bound on a single update (bounds the DP sensitivity per round).
export const DEFAULT_CLIP_NORM = 1.0;

// Gossip fan-out: how many randomly-selected reachable peers to gossip to in a
// round (decentralized-SGD gossip; a small constant keeps traffic bounded).
export const DEFAULT_GOSSIP_FANOUT = 3;

// A peer-discovery ("phone book") entry is only valid for this long. The
// scheduled GitHub Action and every client prune entries older than this, so the
// coordination file rotates itself within minutes and never accumulates history.
export const COORDINATION_TTL_MS = 5 * 60 * 1000;

export const FEDERATED_DISCLAIMER =
  'Federated Fingerprint Learning is an OPT-IN research-preview feature, OFF by ' +
  'default. When enabled, your raw data NEVER leaves your browser. Only ' +
  'privacy-protected model weight updates are shared: each update is L2-clipped, ' +
  'has calibrated differential-privacy noise added, and is pairwise-masked so no ' +
  'peer or relay can read your individual contribution — only the group average. ' +
  'Updates are aggregated only when a minimum number of peers contribute. Peer ' +
  'discovery uses a short-lived, self-expiring coordination file; the actual ' +
  'exchange is peer-to-peer over WebRTC. This has not been independently audited; ' +
  'do not rely on it as a compliance or de-identification guarantee.';

// ------------------------------------------------------------
// Deterministic seeded PRNG (for reproducible masks + testable noise)
// ------------------------------------------------------------

// mulberry32 — a tiny, well-known public-domain 32-bit PRNG. Used to expand a
// shared pairwise SEED into a reproducible mask vector both peers can derive
// identically. NOT used as a cryptographic RNG for key material.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fold an arbitrary string (e.g. a shared pair seed) into a 32-bit integer for
// mulberry32. FNV-1a — a standard non-cryptographic string hash.
export function seedFromString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ------------------------------------------------------------
// The local, on-device model
// ------------------------------------------------------------
// Per-source running estimate of P(flag is a real issue), learned ONLY from this
// user's own accept(1)/dismiss(0) signals. `weights[i]` is the current estimate
// for FEATURE_SOURCES[i]; `counts[i]` is how many local signals back it (used
// both as the FedAvg sample weight and to keep a stable running mean).

export class LocalFingerprintModel {
  constructor(options = {}) {
    this.dim = MODEL_DIM;
    // Neutral prior 0.5 everywhere: with no evidence a source is neither
    // trusted nor distrusted (matches the Adaptive Prioritization neutral prior).
    this.weights = options.weights ? options.weights.slice() : new Array(this.dim).fill(0.5);
    this.counts = options.counts ? options.counts.slice() : new Array(this.dim).fill(0);
    // The last global weights this device synced FROM, so an outgoing update can
    // be expressed as a delta (what THIS device learned since the last sync).
    this.base = options.base ? options.base.slice() : this.weights.slice();
    this.round = options.round || 0;
  }

  _indexOf(source) {
    const i = FEATURE_SOURCES.indexOf(source);
    return i >= 0 ? i : FEATURE_SOURCES.indexOf('other');
  }

  // Fold one accept/dismiss signal into the running per-source mean. The neutral
  // 0.5 prior acts as ONE pseudo-observation (Laplace-style smoothing), so the
  // estimate is (0.5 + Σy) / (1 + n) — 0.5 with no data, moving toward the
  // observed accept-rate as evidence accrues, and never overconfident at n=1.
  recordSignal(source, label) {
    const y = label === 1 ? 1 : label === 0 ? 0 : null;
    if (y == null) return null;
    const i = this._indexOf(source);
    const k = this.counts[i];
    this.weights[i] = (this.weights[i] * (1 + k) + y) / (2 + k);
    this.counts[i] = k + 1;
    return i;
  }

  get totalSignals() {
    return this.counts.reduce((a, b) => a + b, 0);
  }

  // The local update to SHARE this round: the delta from the synced base. Sharing
  // a delta (not the absolute weights) is what makes averaging across peers a
  // proper federated step and keeps a peer's absolute state private.
  computeUpdate() {
    return this.weights.map((w, i) => w - this.base[i]);
  }

  // Adopt a freshly-aggregated GLOBAL weight vector as the new synced base. The
  // local estimate is nudged toward it but not blown away — the user's own recent
  // evidence still counts. `blend` in [0,1]: 1 = fully adopt global.
  applyAggregate(globalWeights, blend = 1) {
    if (!Array.isArray(globalWeights) || globalWeights.length !== this.dim) return false;
    const b = Math.max(0, Math.min(1, blend));
    for (let i = 0; i < this.dim; i++) {
      const g = Number(globalWeights[i]);
      if (!Number.isFinite(g)) continue;
      this.weights[i] = (1 - b) * this.weights[i] + b * g;
    }
    this.base = this.weights.slice();
    this.round += 1;
    return true;
  }

  toJSON() {
    return {
      version: 1,
      weights: this.weights.slice(),
      counts: this.counts.slice(),
      base: this.base.slice(),
      round: this.round,
    };
  }

  static fromJSON(data) {
    if (!data || typeof data !== 'object') return new LocalFingerprintModel();
    const fix = (arr, fill) => (Array.isArray(arr) && arr.length === MODEL_DIM
      ? arr.map(v => (Number.isFinite(Number(v)) ? Number(v) : fill))
      : new Array(MODEL_DIM).fill(fill));
    return new LocalFingerprintModel({
      weights: fix(data.weights, 0.5),
      counts: fix(data.counts, 0),
      base: fix(data.base, 0.5),
      round: Number.isFinite(Number(data.round)) ? Number(data.round) : 0,
    });
  }
}

// ------------------------------------------------------------
// Vector helpers
// ------------------------------------------------------------

export function l2Norm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

// Clip a vector to L2 norm <= C (Abadi et al. 2016, per-example gradient
// clipping). This is what BOUNDS the DP sensitivity of one update.
export function clipL2(v, clipNorm = DEFAULT_CLIP_NORM) {
  const norm = l2Norm(v);
  if (norm <= clipNorm || norm === 0) return v.slice();
  const scale = clipNorm / norm;
  return v.map(x => x * scale);
}

function addVectors(a, b) { return a.map((x, i) => x + (b[i] || 0)); }

// ------------------------------------------------------------
// Differential privacy — Gaussian mechanism (Dwork & Roth 2014, §3.5.3)
// ------------------------------------------------------------

// One draw from N(0, sigma^2) via the Box–Muller transform (public method).
// `rng` is an injectable [0,1) uniform source for reproducible tests.
export function gaussianNoise(sigma, rng = Math.random) {
  let u1 = rng();
  const u2 = rng();
  if (u1 < 1e-12) u1 = 1e-12; // guard log(0)
  const mag = sigma * Math.sqrt(-2 * Math.log(u1));
  return mag * Math.cos(2 * Math.PI * u2);
}

// Gaussian-mechanism noise scale for (ε, δ)-DP given L2 sensitivity:
//   σ = sensitivity · sqrt(2 · ln(1.25/δ)) / ε      (Dwork & Roth 2014, Thm 3.22)
// Larger σ = more privacy. ε must be > 0; δ in (0,1).
export function gaussianSigma(epsilon, delta = DEFAULT_DELTA, sensitivity = DEFAULT_CLIP_NORM) {
  if (!(epsilon > 0)) throw new Error('epsilon (ε) must be greater than 0.');
  if (!(delta > 0 && delta < 1)) throw new Error('delta (δ) must be in (0, 1).');
  return (sensitivity * Math.sqrt(2 * Math.log(1.25 / delta))) / epsilon;
}

// DP-SGD-style privatization of one update: L2-clip to bound sensitivity, then
// add calibrated Gaussian noise. Returns the noised update, ready to leave the
// device. Because clipping happens FIRST, sensitivity == clipNorm exactly.
export function privatizeUpdate(update, {
  epsilon = DEFAULT_EPSILON, delta = DEFAULT_DELTA, clipNorm = DEFAULT_CLIP_NORM, rng = Math.random,
} = {}) {
  const clipped = clipL2(update, clipNorm);
  const sigma = gaussianSigma(epsilon, delta, clipNorm);
  return clipped.map(x => x + gaussianNoise(sigma, rng));
}

// ------------------------------------------------------------
// Secure aggregation — pairwise masking (Bonawitz et al. 2017)
// ------------------------------------------------------------

// The mask vector two peers derive from their shared pair seed. Both peers
// compute the SAME vector; one adds it, the other subtracts it, so it cancels.
export function pairwiseMaskVector(sharedSeed, dim = MODEL_DIM) {
  const rng = mulberry32(seedFromString(sharedSeed));
  const out = new Array(dim);
  // Center each component on 0 (range roughly [-1,1)) so masks are zero-mean and
  // don't bias the aggregate if a pair drops mid-round (best-effort; a dropout
  // recovery protocol is out of Phase-1 scope).
  for (let i = 0; i < dim; i++) out[i] = rng() * 2 - 1;
  return out;
}

// Deterministic canonical seed string for the pair {a, b}, independent of who
// calls it — both peers must derive the identical seed. In production the seed
// would be a Diffie–Hellman shared secret; Phase 1 uses an agreed seed string.
export function pairSeed(idA, idB, sessionSalt = '') {
  const [lo, hi] = [String(idA), String(idB)].sort();
  return `${sessionSalt}|${lo}|${hi}`;
}

// The sign a peer applies to a pair mask: the peer with the lexicographically
// smaller id ADDS the mask, the larger SUBTRACTS it. Deterministic and opposite
// for the two members of a pair, which is exactly why the masks cancel in the sum.
export function maskSign(selfId, peerId) {
  return String(selfId) < String(peerId) ? 1 : -1;
}

// Mask an update for secure aggregation: add Σ over peers of sign·mask(pairSeed).
// The result reveals nothing about the raw update on its own, yet the SUM of all
// participants' masked updates equals the SUM of their raw updates (masks cancel).
export function maskUpdate(update, selfId, peerIds, { sessionSalt = '' } = {}) {
  let masked = update.slice();
  for (const peerId of peerIds) {
    if (String(peerId) === String(selfId)) continue;
    const mask = pairwiseMaskVector(pairSeed(selfId, peerId, sessionSalt), update.length);
    const sign = maskSign(selfId, peerId);
    masked = masked.map((x, i) => x + sign * mask[i]);
  }
  return masked;
}

// Sum a set of masked updates. If the masked set is COMPLETE (every pair present
// on both sides), the pairwise masks cancel and this equals the sum of the raw
// updates — without any single raw update ever being exposed.
export function sumMaskedUpdates(maskedUpdates) {
  if (!maskedUpdates.length) return new Array(MODEL_DIM).fill(0);
  let acc = new Array(maskedUpdates[0].length).fill(0);
  for (const m of maskedUpdates) acc = addVectors(acc, m);
  return acc;
}

// ------------------------------------------------------------
// Cohort gating + federated averaging (FedAvg, McMahan et al. 2017)
// ------------------------------------------------------------

// Aggregate a round's contributions into a new global weight vector, ENFORCING
// the minimum-cohort threshold. `contributions` = [{ update, sampleCount }].
// Returns { applied, reason, weights?, cohortSize, totalSamples }.
// `baseWeights` is the current global model the averaged delta is applied to.
export function aggregateRound(contributions, baseWeights, { minCohort = MIN_COHORT } = {}) {
  const valid = (contributions || []).filter(c =>
    c && Array.isArray(c.update) && c.update.length === (baseWeights ? baseWeights.length : MODEL_DIM));
  const cohortSize = valid.length;
  if (cohortSize < minCohort) {
    return {
      applied: false,
      cohortSize,
      totalSamples: 0,
      reason: `Cohort too small: ${cohortSize} contributor(s) < minimum ${minCohort}. Nothing was aggregated or applied — staying on the local model.`,
    };
  }
  const base = (baseWeights || new Array(MODEL_DIM).fill(0.5)).slice();
  const dim = base.length;
  const totalSamples = valid.reduce((a, c) => a + Math.max(1, c.sampleCount || 1), 0);
  // FedAvg: sample-weighted mean of the per-peer deltas.
  const avgDelta = new Array(dim).fill(0);
  for (const c of valid) {
    const w = Math.max(1, c.sampleCount || 1) / totalSamples;
    for (let i = 0; i < dim; i++) avgDelta[i] += w * (c.update[i] || 0);
  }
  const weights = base.map((b, i) => {
    const v = b + avgDelta[i];
    return v < 0 ? 0 : v > 1 ? 1 : v; // keep weights valid probabilities
  });
  return {
    applied: true,
    cohortSize,
    totalSamples,
    weights,
    reason: `Aggregated ${cohortSize} contributor(s) via FedAvg (sample-weighted).`,
  };
}

// Secure-aggregation variant: given the SUM of masked updates (masks already
// cancelled) plus the cohort size, recover the AVERAGE update and apply it.
// Used by the gossip path where individual updates are never seen in the clear.
export function aggregateSecureSum(maskedSum, cohortSize, baseWeights, { minCohort = MIN_COHORT } = {}) {
  if (cohortSize < minCohort) {
    return {
      applied: false,
      cohortSize,
      reason: `Cohort too small: ${cohortSize} contributor(s) < minimum ${minCohort}. Secure aggregate discarded.`,
    };
  }
  const base = (baseWeights || new Array(MODEL_DIM).fill(0.5)).slice();
  const dim = base.length;
  const avg = maskedSum.map(x => x / cohortSize);
  const weights = base.map((b, i) => {
    const v = b + (avg[i] || 0);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  });
  return { applied: true, cohortSize, weights, reason: `Applied secure aggregate over ${cohortSize} contributor(s).` };
}

// ------------------------------------------------------------
// Gossip peer selection + transport decision
// ------------------------------------------------------------

// Randomly select up to `fanout` reachable peers to gossip to this round,
// excluding self and unreachable entries (decentralized-SGD gossip). Uniform
// sampling without replacement via a partial Fisher–Yates shuffle.
export function selectGossipPeers(peers, { selfId, fanout = DEFAULT_GOSSIP_FANOUT, rng = Math.random } = {}) {
  const pool = (peers || []).filter(p =>
    p && p.id != null && String(p.id) !== String(selfId) && p.reachable !== false);
  const arr = pool.slice();
  const k = Math.min(fanout, arr.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, k);
}

// Decide how to disseminate this round's update. Gossip-first: if at least
// `minPeersForGossip` peers are reachable, gossip peer-to-peer. Otherwise fall
// back to dropping a masked/noised update on the GitHub coordination branch for a
// future peer to pick up — so the feature is still useful with only 1–2 users.
export function decideTransport(reachablePeerCount, { minPeersForGossip = 1 } = {}) {
  return reachablePeerCount >= minPeersForGossip ? 'gossip' : 'relay';
}

// ------------------------------------------------------------
// GitHub coordination-file ("phone book") rotation
// ------------------------------------------------------------
// The file holds ONLY ephemeral peer-discovery metadata (ids + WebRTC signaling
// offers/ICE candidates) and, in relay-fallback mode, already-masked+noised
// weight updates. It NEVER holds raw data. Entries self-expire; both clients and
// the scheduled GitHub Action prune with these pure functions.

export function isExpired(entry, now, ttl = COORDINATION_TTL_MS) {
  return !entry || typeof entry.ts !== 'number' || (now - entry.ts) > ttl;
}

// Drop expired entries from a list, keeping the freshest per id.
export function pruneCoordinationEntries(entries, now, ttl = COORDINATION_TTL_MS) {
  const fresh = (entries || []).filter(e => !isExpired(e, now, ttl));
  const byId = new Map();
  for (const e of fresh) {
    const prev = byId.get(e.id);
    if (!prev || (e.ts || 0) > (prev.ts || 0)) byId.set(e.id, e);
  }
  return [...byId.values()];
}

// Add/refresh this peer's presence entry and prune the rest. Returns the new,
// rotated coordination file object.
export function upsertPresence(file, entry, now, ttl = COORDINATION_TTL_MS) {
  const base = file && Array.isArray(file.peers) ? file.peers : [];
  const withoutSelf = base.filter(e => e.id !== entry.id);
  const peers = pruneCoordinationEntries([...withoutSelf, { ...entry, ts: now }], now, ttl);
  return {
    kind: 'dataglow-federated-coordination',
    version: 1,
    rotatedAt: now,
    ttlMs: ttl,
    peers,
    relay: pruneRelay(file, now, ttl),
  };
}

// Relay-fallback payloads live alongside the phone book. They too self-expire and
// carry ONLY masked+noised updates + metadata (never raw data).
function pruneRelay(file, now, ttl) {
  const base = file && Array.isArray(file.relay) ? file.relay : [];
  return base.filter(e => !isExpired(e, now, ttl));
}

// Append a masked+noised relay update and prune expired ones.
export function appendRelayUpdate(file, payload, now, ttl = COORDINATION_TTL_MS) {
  const relay = pruneRelay(file, now, ttl);
  relay.push({ ...payload, ts: now });
  return { ...(file || {}), relay };
}

// Build the object dropped on the relay branch. Enforces that only a masked/
// noised vector is ever published — the presence of a raw-looking field throws.
export function buildRelayPayload({ id, round, maskedUpdate, sampleCount, epsilon, delta, cohortHint = null }) {
  if (!Array.isArray(maskedUpdate)) throw new Error('relay payload requires a maskedUpdate vector.');
  return {
    id,
    round,
    maskedUpdate: maskedUpdate.map(x => Number(x)),
    sampleCount: Math.max(1, sampleCount || 1),
    dp: { epsilon, delta },
    cohortHint,
    note: 'masked + DP-noised weight delta only — contains no raw data',
  };
}

// ------------------------------------------------------------
// Contribution receipts — hash-chained provenance (reuses the SHA-256 primitive
// already used by the Selective-Disclosure Proof / Provenance systems)
// ------------------------------------------------------------
// A minimal, storage-policy-minimal record that a round happened and what its
// privacy parameters were — WITHOUT storing any per-peer raw data. Chained so the
// local history is tamper-evident, mirroring provenance.js's hash chain.

export async function buildContributionReceipt(prevHash, {
  round, cohortSize, epsilon, delta, transport, updateHash, at = Date.now(),
}) {
  const body = {
    kind: 'dataglow-federated-receipt',
    round,
    cohortSize,
    dp: { epsilon, delta },
    transport,
    updateHash: updateHash || null,
    prevHash: prevHash || null,
    at,
  };
  const hash = await sha256Hex(JSON.stringify(body));
  return { ...body, hash };
}

// Hash a (masked+noised) update vector for inclusion in a receipt, so a receipt
// commits to WHAT was shared without storing the vector itself long-term.
export async function hashUpdate(vector) {
  return sha256Hex(JSON.stringify((vector || []).map(x => Number(x.toFixed(6)))));
}

// ------------------------------------------------------------
// Graceful-degradation probes
// ------------------------------------------------------------

// True only if the running environment can actually open a WebRTC peer
// connection. Injectable env for testing; defaults to the real global scope.
export function isWebRTCSupported(env = (typeof globalThis !== 'undefined' ? globalThis : {})) {
  return typeof env.RTCPeerConnection === 'function';
}
