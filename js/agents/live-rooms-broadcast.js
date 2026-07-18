// ============================================================
// DATAGLOW — Live Rooms Broadcast (Batch 2): mirrored action-item view
// ============================================================
// WHAT THIS IS: a thin adapter that adds a "live-action-items" message kind to
// the existing Rooms data channel (js/rooms/room-broadcast.js /
// room-signaling.js). Others in a meeting room can watch the grounded
// action-item list update live on their own device, peer-to-peer, with no
// server and no upload.
//
// ARCHITECTURE (follows the exact dependency-injection discipline proven by
// diplomacy-p2p-transport.js, federated-transport.js, room-signaling.js, and
// room-broadcast.js):
//   - createLiveRoomsBroadcast COMPOSES an injected broadcast transport (any
//     object with the same .send(msg)/onReceive(fn) shape RoomBroadcastCoordinator
//     uses). It never owns the WebRTC connection — Rooms does.
//   - NULL_LIVE_ROOMS_BROADCAST is a no-op adapter: "no Rooms session is live"
//     is a first-class state, not an exception.
//   - broadcastActionItems() / onReceiveActionItems() are the public surface:
//       broadcastActionItems(actionItems, meetingId) -> Promise<boolean>
//       onReceiveActionItems(fn)                     -> unsubscribe()
//   - Nothing here renders or mutates the local action-item list. The main.js
//     wiring merges incoming items and re-renders (same separation as all
//     prior batches).
//
// WIRE FORMAT (one new message kind: "live-action-items"):
//   {
//     kind: "live-action-items",
//     from: <peerId|null>,
//     ts: <epoch ms>,
//     meetingId: <string|null>,
//     actionItems: [ ...action item objects ]  // verbatim from the scribe
//   }
//   An unknown/missing "kind" on receive is silently ignored — same discipline
//   as buildEntryMessage()/receive() in room-broadcast.js.
//
// SCOPE (Batch 2): this is a pure, Node-testable DATA-LAYER module. No DOM,
// no UI, no WebRTC adapter construction, no DuckDB. The main.js wiring injects
// the real Rooms transport from the live RoomBroadcastCoordinator instance when
// the liveRoomsBroadcast flag is on.
// ============================================================

export const LIVE_ACTION_ITEMS_MESSAGE_KIND = 'live-action-items';

// No-op transport — "no Rooms session is active" is a valid, error-free state.
export const NULL_LIVE_ROOMS_BROADCAST = {
  supported: false,
  async broadcastActionItems() { return false; },
  onReceiveActionItems() { return function() {}; },
  destroy() {},
};

/**
 * Build a live-action-items wire message.
 * Pure function, no side effects. Never throws.
 *
 * @param {object} opts
 * @param {Array<object>} opts.actionItems  the action item objects to share
 * @param {string|null} [opts.meetingId]  id of the meeting the items belong to
 * @param {string|null} [opts.from]  peerId of the sender
 * @param {number} [opts.ts]  timestamp in ms (defaults to Date.now())
 * @returns {{ kind: string, from: string|null, ts: number, meetingId: string|null, actionItems: Array<object> }|null}
 *   Returns null when actionItems is not a non-empty array (nothing to send).
 */
export function buildActionItemsMessage({ actionItems, meetingId, from, ts } = {}) {
  if (!Array.isArray(actionItems) || actionItems.length === 0) return null;
  return {
    kind: LIVE_ACTION_ITEMS_MESSAGE_KIND,
    from: from != null ? String(from) : null,
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
    meetingId: meetingId != null ? String(meetingId) : null,
    actionItems: actionItems.slice(),
  };
}

/**
 * Validate that a received message is a well-formed live-action-items message.
 * Returns true only when: kind === LIVE_ACTION_ITEMS_MESSAGE_KIND AND
 * actionItems is a non-null array. Never throws.
 *
 * @param {any} msg
 * @returns {boolean}
 */
export function isValidActionItemsMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.kind !== LIVE_ACTION_ITEMS_MESSAGE_KIND) return false;
  if (msg.actionItems == null || !Array.isArray(msg.actionItems)) return false;
  return true;
}

/**
 * Create a LiveRoomsBroadcast adapter.
 *
 * @param {object} opts
 * @param {object} opts.transport  an object with:
 *   - send(msg: object): Promise<boolean> — delivers a message to all peers
 *   - onReceive(fn): () => void          — registers a handler for incoming messages
 *     (handler is called with the raw wire message object)
 *   The injected transport is typically a RoomBroadcastCoordinator. For tests,
 *   use an in-memory fake (see test/live-rooms-broadcast.test.mjs).
 * @param {string|null} [opts.selfId]  peerId of the local user
 * @returns {{
 *   supported: boolean,
 *   broadcastActionItems: (actionItems: Array<object>, meetingId?: string) => Promise<boolean>,
 *   onReceiveActionItems: (fn: (msg: object) => void) => (() => void),
 *   destroy: () => void
 * }}
 */
export function createLiveRoomsBroadcast(opts) {
  var transport = (opts && opts.transport) ? opts.transport : null;
  var selfId = (opts && opts.selfId != null) ? String(opts.selfId) : null;

  if (!transport || typeof transport.send !== 'function' || typeof transport.onReceive !== 'function') {
    return NULL_LIVE_ROOMS_BROADCAST;
  }

  var receivers = [];

  // Register once with the underlying transport to fan out to our handlers.
  var unsubscribeUnderlying = transport.onReceive(function(msg) {
    if (!isValidActionItemsMessage(msg)) return;
    for (var i = 0; i < receivers.length; i++) {
      try { receivers[i](msg); } catch (e) { /* handler errors never abort other handlers */ }
    }
  });

  return {
    supported: true,

    /**
     * Broadcast the current action items to all peers in the current Room.
     *
     * @param {Array<object>} actionItems  the current action item objects
     * @param {string} [meetingId]  the meeting the items belong to
     * @returns {Promise<boolean>}  true = delivered; false on any failure. Never throws.
     */
    broadcastActionItems: async function(actionItems, meetingId) {
      var msg = buildActionItemsMessage({ actionItems: actionItems, meetingId: meetingId, from: selfId, ts: Date.now() });
      if (!msg) return false;
      try {
        var result = await transport.send(msg);
        return result === true;
      } catch (e) {
        return false;
      }
    },

    /**
     * Register a handler called whenever a "live-action-items" message arrives.
     *
     * @param {(msg: {kind:string, from:string|null, ts:number, meetingId:string|null, actionItems:Array<object>}) => void} fn
     * @returns {() => void}  unsubscribe function
     */
    onReceiveActionItems: function(fn) {
      if (typeof fn !== 'function') return function() {};
      receivers.push(fn);
      return function() {
        receivers = receivers.filter(function(r) { return r !== fn; });
      };
    },

    /**
     * Tear down the adapter: unsubscribes from the underlying channel and
     * clears all registered handlers. Call when the Meeting tab unmounts.
     */
    destroy: function() {
      receivers = [];
      if (typeof unsubscribeUnderlying === 'function') unsubscribeUnderlying();
    },
  };
}
