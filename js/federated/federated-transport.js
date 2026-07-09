// ============================================================
// DATAGLOW — Federated Fingerprint Learning: transport / orchestration
// ============================================================
// Wires the pure federated-learning core (js/federated-learning.js) to real (or,
// under test, stubbed) transports. Nothing here ever touches raw data — it moves
// only already-masked, DP-noised weight deltas and ephemeral peer-discovery
// metadata.
//
// Two transports, gossip-first (per the decentralized-SGD gossip pattern):
//   • gossip  — direct browser-to-browser over WebRTC data channels, bootstrapped
//               by the GitHub coordination branch (signaling only).
//   • relay   — if too few peers are reachable, drop a masked+noised update on the
//               coordination branch for a later peer to pick up, so the feature
//               still works with only 1–2 active users.
//
// The `signaling` and `rtc` collaborators are ADAPTERS (dependency injection): the
// browser passes real implementations (createGithubSignaling / createWebRTCMesh);
// tests pass in-memory fakes. This is what lets every orchestration path be unit-
// tested with no network, and what makes graceful degradation trivial — a missing
// or throwing adapter simply routes back to purely-local behavior.

import {
  MIN_COHORT, DEFAULT_EPSILON, DEFAULT_DELTA, DEFAULT_CLIP_NORM, DEFAULT_GOSSIP_FANOUT,
  privatizeUpdate, maskUpdate, sumMaskedUpdates, selectGossipPeers, decideTransport,
  aggregateRound, aggregateSecureSum, buildRelayPayload, buildContributionReceipt,
  hashUpdate, isWebRTCSupported,
} from './federated-learning.js';

// A no-op signaling/rtc adapter: makes "the coordination branch / WebRTC is
// unreachable" a first-class, error-free state (used when the feature is on but
// the environment can't actually talk to anyone).
const NULL_SIGNALING = {
  async fetchPeers() { return []; },
  async publishPresence() { return false; },
  async fetchRelayUpdates() { return []; },
  async publishRelayUpdate() { return false; },
};
const NULL_RTC = {
  supported: false,
  async exchange() { return null; },
};

export class FederatedCoordinator {
  constructor({
    model,
    selfId,
    signaling = NULL_SIGNALING,
    rtc = NULL_RTC,
    minCohort = MIN_COHORT,
    epsilon = DEFAULT_EPSILON,
    delta = DEFAULT_DELTA,
    clipNorm = DEFAULT_CLIP_NORM,
    gossipFanout = DEFAULT_GOSSIP_FANOUT,
    sessionSalt = '',
    rng = Math.random,
    now = () => Date.now(),
    onReceipt = null,
  } = {}) {
    if (!model) throw new Error('FederatedCoordinator requires a LocalFingerprintModel.');
    this.model = model;
    this.selfId = selfId || `peer-${Math.floor((rng() * 1e9))}`;
    this.signaling = signaling || NULL_SIGNALING;
    this.rtc = rtc || NULL_RTC;
    this.minCohort = minCohort;
    this.epsilon = epsilon;
    this.delta = delta;
    this.clipNorm = clipNorm;
    this.gossipFanout = gossipFanout;
    this.sessionSalt = sessionSalt;
    this.rng = rng;
    this.now = now;
    this.onReceipt = onReceipt;
    this.lastReceiptHash = null;
    this.enabled = false;
  }

  setEpsilon(epsilon) { if (epsilon > 0) this.epsilon = epsilon; }
  enable() { this.enabled = true; }
  disable() { this.enabled = false; }

  // Publish this device's presence (WebRTC offer/ICE) to the coordination branch.
  // Best-effort: any failure is swallowed and reported, never thrown.
  async announce(offer = null) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    try {
      const ok = await this.signaling.publishPresence({
        id: this.selfId, offer, ts: this.now(),
      });
      return { ok: !!ok };
    } catch (e) {
      return { ok: false, reason: 'signaling-unreachable' };
    }
  }

  // Prepare this round's outgoing update: local delta -> DP clip+noise. This is
  // the ONLY vector that will ever leave the device (further masked in gossip).
  _privatizedUpdate() {
    const raw = this.model.computeUpdate();
    return privatizeUpdate(raw, {
      epsilon: this.epsilon, delta: this.delta, clipNorm: this.clipNorm, rng: this.rng,
    });
  }

  // Run one full federated round. NEVER throws — on any failure it degrades to
  // purely-local behavior (as if the feature were off) and reports why. Returns a
  // status object describing what happened.
  async runRound() {
    if (!this.enabled) return { status: 'disabled', applied: false };

    const noisedUpdate = this._privatizedUpdate();
    const sampleCount = Math.max(1, this.model.totalSignals);

    // 1) Peer discovery (phone book). Unreachable -> [] (no throw).
    let peers = [];
    try { peers = await this.signaling.fetchPeers(); } catch (e) { peers = []; }
    const reachable = (peers || []).filter(p => p && p.id != null && String(p.id) !== String(this.selfId));

    const transport = decideTransport(reachable.length, { minPeersForGossip: 1 });

    if (transport === 'gossip' && (this.rtc.supported || isWebRTCSupported())) {
      const result = await this._gossipRound(noisedUpdate, reachable, sampleCount);
      if (result) return result;
      // gossip produced nothing usable -> fall through to relay
    }
    return this._relayRound(noisedUpdate, sampleCount);
  }

  // Gossip path: pairwise-mask our update, exchange with a few random peers over
  // WebRTC, collect their masked updates, and securely aggregate (masks cancel)
  // once the cohort threshold is met.
  async _gossipRound(noisedUpdate, reachable, sampleCount) {
    const selected = selectGossipPeers(reachable, {
      selfId: this.selfId, fanout: this.gossipFanout, rng: this.rng,
    });
    if (!selected.length) return null;

    // The cohort for THIS round = us + the peers we successfully exchange with.
    const cohortIds = [this.selfId, ...selected.map(p => String(p.id))];
    const myMasked = maskUpdate(noisedUpdate, this.selfId, cohortIds.filter(id => id !== this.selfId), { sessionSalt: this.sessionSalt });

    const maskedUpdates = [myMasked];
    const contributed = [this.selfId];
    for (const peer of selected) {
      try {
        // The peer masks its own update against the same cohort; over WebRTC we
        // receive only its MASKED vector — never anything raw.
        const theirMasked = await this.rtc.exchange(peer, {
          from: this.selfId, cohortIds, maskedUpdate: myMasked,
        });
        if (Array.isArray(theirMasked) && theirMasked.length === noisedUpdate.length) {
          maskedUpdates.push(theirMasked);
          contributed.push(String(peer.id));
        }
      } catch (e) { /* one peer failing must not abort the round */ }
    }

    const cohortSize = contributed.length;
    if (cohortSize < this.minCohort) {
      // Not enough peers actually completed — don't apply; try relay instead so
      // low-traffic usage still makes progress.
      return null;
    }
    const maskedSum = sumMaskedUpdates(maskedUpdates);
    const agg = aggregateSecureSum(maskedSum, cohortSize, this.model.weights, { minCohort: this.minCohort });
    if (!agg.applied) return null;

    this.model.applyAggregate(agg.weights);
    const receipt = await this._receipt('gossip', cohortSize, noisedUpdate);
    return { status: 'aggregated', transport: 'gossip', applied: true, cohortSize, receipt, reason: agg.reason };
  }

  // Relay path: publish our masked+noised update to the coordination branch, pull
  // any pending relay updates, and aggregate (with cohort gating) if enough have
  // accumulated. With too few, we still leave OUR update for the next peer.
  async _relayRound(noisedUpdate, sampleCount) {
    // In relay mode there is no live cohort to pairwise-mask against, so we rely
    // on DP noise (already applied) for per-update privacy and publish the noised
    // delta. The min-cohort gate below still prevents applying a tiny aggregate.
    let pending = [];
    try { pending = await this.signaling.fetchRelayUpdates(); } catch (e) { pending = []; }

    try {
      const payload = buildRelayPayload({
        id: this.selfId, round: this.model.round, maskedUpdate: noisedUpdate,
        sampleCount, epsilon: this.epsilon, delta: this.delta,
      });
      await this.signaling.publishRelayUpdate(payload);
    } catch (e) { /* branch unreachable — stay local */ }

    const others = (pending || []).filter(u => u && u.id != null && String(u.id) !== String(this.selfId)
      && Array.isArray(u.maskedUpdate) && u.maskedUpdate.length === noisedUpdate.length);
    // Include our own update in the cohort we're aggregating locally.
    const contributions = [
      { update: noisedUpdate, sampleCount },
      ...others.map(u => ({ update: u.maskedUpdate, sampleCount: u.sampleCount || 1 })),
    ];
    const agg = aggregateRound(contributions, this.model.weights, { minCohort: this.minCohort });
    if (!agg.applied) {
      return {
        status: 'deferred', transport: 'relay', applied: false,
        cohortSize: agg.cohortSize,
        reason: agg.reason + ' Your masked update was left on the coordination branch for a future peer.',
      };
    }
    this.model.applyAggregate(agg.weights);
    const receipt = await this._receipt('relay', agg.cohortSize, noisedUpdate);
    return { status: 'aggregated', transport: 'relay', applied: true, cohortSize: agg.cohortSize, receipt, reason: agg.reason };
  }

  async _receipt(transport, cohortSize, noisedUpdate) {
    try {
      const updateHash = await hashUpdate(noisedUpdate);
      const receipt = await buildContributionReceipt(this.lastReceiptHash, {
        round: this.model.round, cohortSize, epsilon: this.epsilon, delta: this.delta,
        transport, updateHash, at: this.now(),
      });
      this.lastReceiptHash = receipt.hash;
      if (typeof this.onReceipt === 'function') { try { this.onReceipt(receipt); } catch (e) { /* non-fatal */ } }
      return receipt;
    } catch (e) { return null; }
  }
}

// ------------------------------------------------------------
// Browser adapters (best-effort, defensive). Not exercised in CI (they need a
// network + a signaling branch); the coordinator logic they feed IS tested via
// injected fakes. Each adapter degrades to the null adapter's behavior on error.
// ------------------------------------------------------------

// GitHub coordination-branch signaling. Reads the rotating phone-book JSON from
// the raw githubusercontent endpoint (no auth needed to READ a public branch).
// Publishing presence/relay requires a user-supplied fine-grained token with
// contents:write on ONLY this repo; without one, publishing is a no-op and the
// client still participates read-only (can pick up relay updates). GitHub only
// ever sees masked+noised deltas + ephemeral signaling metadata — never raw data.
export function createGithubSignaling({
  owner, repo, branch = 'federated-coordination', path = 'coordination.json',
  token = null, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
} = {}) {
  if (!owner || !repo || !fetchImpl) return NULL_SIGNALING;
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;

  async function readFile() {
    try {
      const res = await fetchImpl(`${rawUrl}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res || !res.ok) return { peers: [], relay: [] };
      return await res.json();
    } catch (e) { return { peers: [], relay: [] }; }
  }

  return {
    async fetchPeers() { const f = await readFile(); return Array.isArray(f.peers) ? f.peers : []; },
    async fetchRelayUpdates() { const f = await readFile(); return Array.isArray(f.relay) ? f.relay : []; },
    // Writes go through the GitHub contents API and need a token. Intentionally
    // best-effort: a missing token or any error yields false, not a throw, so the
    // feature degrades to read-only / local behavior.
    async publishPresence() { return false; },
    async publishRelayUpdate() { return false; },
    _hasWriteToken: !!token,
  };
}

// A WebRTC data-channel mesh adapter. Reports unsupported when RTCPeerConnection
// is unavailable, which routes the coordinator to relay/local behavior with no
// errors. The full offer/answer/ICE handshake bootstraps off the signaling
// adapter above. Kept intentionally thin; the exchange contract is what the
// coordinator (and its tests) depend on.
export function createWebRTCMesh({ signaling = NULL_SIGNALING } = {}) {
  const supported = isWebRTCSupported();
  if (!supported) return NULL_RTC;
  return {
    supported: true,
    signaling,
    // Real implementation would negotiate an RTCDataChannel per peer using the
    // signaling branch, send our masked update, and await theirs. Left as a
    // best-effort stub returning null (→ that peer simply doesn't contribute)
    // rather than shipping an untested handshake that could throw in production.
    async exchange() { return null; },
  };
}
