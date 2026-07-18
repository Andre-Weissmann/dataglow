// ============================================================
// DATAGLOW — Data Diplomacy P2P Transport (Batch 4): sealed-claim exchange
// ============================================================
// WHAT THIS IS: a thin adapter that adds a 'sealed-claim' message kind to the
// existing Rooms data channel (js/rooms/room-broadcast.js / room-signaling.js).
// Two analysts in two browsers can exchange sealed claims produced by Batch 1
// (sealClaim, js/diplomacy/diplomacy-claim.js) without any server or upload.
//
// ARCHITECTURE (follows the exact dependency-injection discipline proven by
// federated-transport.js, room-signaling.js, and room-broadcast.js):
//   - DiplomacyP2PTransport COMPOSES an injected RoomBroadcastCoordinator
//     (or any object with the same .send(msg)/onReceive(fn) shape). It never
//     owns the WebRTC connection — Rooms does.
//   - NULL_DIPLOMACY_TRANSPORT is a no-op adapter: "no Rooms session is live"
//     is a first-class state, not an exception.
//   - sendClaim() / onReceiveClaim() are the only public surface:
//       sendClaim(sealedClaim)  → Promise<boolean> (delivered=true/false)
//       onReceiveClaim(fn)      → unsubscribe()
//   - Nothing here calls sealClaim(), reconcileClaims(), or any approval gate.
//     Those stay in main.js (same separation as all prior batches).
//
// WIRE FORMAT (one new ROOM_MESSAGE_KINDS entry: 'diplomacy-claim'):
//   {
//     kind: 'diplomacy-claim',
//     from: <peerId>,
//     ts: <epoch ms>,
//     claim: { ...sealed claim fields }  // verbatim sealClaim() output
//   }
//   An unknown/missing 'kind' on receive is silently ignored — same discipline
//   as buildEntryMessage()/receive() in room-broadcast.js.
//
// SCOPE (Batch 4): this is a pure, Node-testable DATA-LAYER module. No DOM,
// no UI, no WebRTC adapter construction. The main.js wiring injects the real
// Rooms coordinator from the live RoomBroadcastCoordinator instance when the
// dataDiplomacyP2P flag is on.
// ============================================================

export const DIPLOMACY_CLAIM_MESSAGE_KIND = 'diplomacy-claim';

// No-op transport — "no Rooms session is active" is a valid, error-free state.
export const NULL_DIPLOMACY_TRANSPORT = {
  supported: false,
  async sendClaim() { return false; },
  onReceiveClaim() { return function() {}; },
};

/**
 * Build a claim wire message.
 * Pure function, no side effects.
 *
 * @param {object} opts
 * @param {object} opts.claim  sealed claim (output of sealClaim())
 * @param {string|null} opts.from  peerId of the sender
 * @param {number} [opts.ts]  timestamp in ms (defaults to Date.now())
 * @returns {{ kind: 'diplomacy-claim', from: string|null, ts: number, claim: object }}
 */
export function buildClaimMessage({ claim, from, ts } = {}) {
  return {
    kind: DIPLOMACY_CLAIM_MESSAGE_KIND,
    from: from != null ? String(from) : null,
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
    claim: claim && typeof claim === 'object' ? claim : null,
  };
}

/**
 * Validate that a received message is a well-formed diplomacy-claim message.
 * Returns true only when: kind === 'diplomacy-claim' AND claim is a non-null object.
 * Never throws.
 *
 * @param {any} msg
 * @returns {boolean}
 */
export function isValidClaimMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.kind !== DIPLOMACY_CLAIM_MESSAGE_KIND) return false;
  if (!msg.claim || typeof msg.claim !== 'object') return false;
  return true;
}

/**
 * Create a DiplomacyP2PTransport.
 *
 * @param {object} opts
 * @param {object} opts.transport  an object with:
 *   - send(msg: object): Promise<boolean> — delivers a message to all peers
 *   - onReceive(fn): () => void          — registers a handler for incoming messages
 *     (handler is called with the raw wire message object)
 *   The injected transport is typically a RoomBroadcastCoordinator. For tests,
 *   use an in-memory fake (see test/diplomacy-p2p-transport.test.mjs).
 * @param {string|null} [opts.selfId]  peerId of the local user
 * @returns {{
 *   sendClaim: (claim: object) => Promise<boolean>,
 *   onReceiveClaim: (fn: (claimMsg: object) => void) => (() => void),
 *   supported: boolean
 * }}
 */
export function createDiplomacyP2PTransport(opts) {
  var transport = (opts && opts.transport) ? opts.transport : null;
  var selfId = (opts && opts.selfId != null) ? String(opts.selfId) : null;

  if (!transport || typeof transport.send !== 'function' || typeof transport.onReceive !== 'function') {
    return NULL_DIPLOMACY_TRANSPORT;
  }

  var receivers = [];

  // Register once with the underlying transport to fan out to our handlers.
  var unsubscribeUnderlying = transport.onReceive(function(msg) {
    if (!isValidClaimMessage(msg)) return;
    for (var i = 0; i < receivers.length; i++) {
      try { receivers[i](msg); } catch (e) { /* handler errors never abort other handlers */ }
    }
  });

  return {
    supported: true,

    /**
     * Send a sealed claim to all peers in the current Room.
     *
     * @param {object} claim  output of sealClaim()
     * @returns {Promise<boolean>}  true = at least one peer received it
     */
    sendClaim: async function(claim) {
      if (!claim || typeof claim !== 'object') return false;
      var msg = buildClaimMessage({ claim: claim, from: selfId, ts: Date.now() });
      try {
        var result = await transport.send(msg);
        return result === true;
      } catch (e) {
        return false;
      }
    },

    /**
     * Register a handler called whenever a 'diplomacy-claim' message arrives.
     *
     * @param {(claimMsg: {kind:string, from:string|null, ts:number, claim:object}) => void} fn
     * @returns {() => void}  unsubscribe function
     */
    onReceiveClaim: function(fn) {
      if (typeof fn !== 'function') return function() {};
      receivers.push(fn);
      return function() {
        receivers = receivers.filter(function(r) { return r !== fn; });
      };
    },

    /**
     * Tear down the transport: unsubscribes from the underlying channel and
     * clears all registered handlers. Call when the Diplomacy tab unmounts.
     */
    destroy: function() {
      receivers = [];
      if (typeof unsubscribeUnderlying === 'function') unsubscribeUnderlying();
    },
  };
}
