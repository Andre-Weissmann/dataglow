// ============================================================
// DATAGLOW — Rooms: Object Space broadcast wiring (Batch 2 of 4)
// ============================================================
// Batch 1 (js/rooms/room-signaling.js) opened a Room: a short shareable code, a
// peer-discovery/signaling contract, and the WebRTC data channel over which
// peers negotiate a connection. It never moved a byte of anyone's work. Batch 2
// (this file) is what finally puts something ON that channel: when a Room is
// active, new/updated Object Space entries (js/app-shell/object-space.js — the
// cross-language shared registry of named SQL/Python/R objects) are broadcast to
// the other peers, and each peer's read-only "who's viewing" tags are tracked so
// a later UI batch can show presence. See NORTH_STAR.md, "Concept in progress:
// DataGlow Rooms" for the full plan.
//
// Batch 2 builds ON TOP of Batch 1 — it does not touch or re-open the signaling
// contract. A RoomBroadcastCoordinator COMPOSES a RoomSignalingCoordinator (to
// know self + the live peer list + whether a Room is actually joined) with a
// data-channel transport ADAPTER, reusing the exact dependency-injection
// discipline both js/federated/federated-transport.js and Batch 1 already prove:
// a NULL_ROOM_TRANSPORT no-op adapter makes "the data channel is unreachable" a
// first-class, never-thrown state; the browser injects a real adapter built on
// federated-transport.js's WebRTC mesh, and tests inject an in-memory fake.
//
// SCOPE (Batch 2): this is a pure, Node-testable DATA-LAYER module only. NO DOM,
// NO HTML/CSS, NO Room pill / avatars / toasts — that visible layer is Batch 3.
// The "who's viewing" surface here is only the underlying peer→object viewing
// map, not any rendering of it. It ships OFF behind the `roomsBroadcast` flag
// (default false): with the flag off nothing in the app constructs a coordinator
// or calls broadcastEntry(), so every existing single-user Object Space code
// path is byte-for-byte unchanged — broadcasting is strictly additive and only
// ever happens when a Room has actually been joined.
//
// A broadcast payload carries ONLY an Object Space entry's already-public shape
// metadata (name, originLanguage, kind, schema, rowCount, provenance pointer) —
// the same descriptor the local registry holds. It never carries raw rows: like
// every other DataGlow feature, the data itself never leaves the browser.

// A no-op data-channel transport — identical philosophy to Batch 1's
// NULL_ROOM_SIGNALING and federated-transport.js's NULL_RTC: "we can't reach any
// peer right now" is an error-free state, not a thrown exception. `send()`
// resolves false so callers can count deliveries without a try/catch.
const NULL_ROOM_TRANSPORT = {
  supported: false,
  async send() { return false; },
};

// The kinds of message that travel over a Room's data channel. Kept as a small
// closed set (mirrors object-space.js's ORIGIN_LANGUAGES/OBJECT_KINDS discipline)
// so an unknown/typo'd kind is ignored on receive rather than silently applied.
export const ROOM_MESSAGE_KINDS = ['object-entry', 'viewing', 'viewing-clear'];

// Build the wire message announcing a new/updated Object Space entry. Pure and
// side-effect-free so it is trivially testable and reusable by the real browser
// adapter. Copies only the entry's shape metadata — never raw rows.
export function buildEntryMessage({ entry, from, ts } = {}) {
  const e = entry || {};
  return {
    kind: 'object-entry',
    from: from != null ? String(from) : null,
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
    entry: {
      name: e.name != null ? String(e.name) : '',
      originLanguage: e.originLanguage != null ? String(e.originLanguage) : 'sql',
      kind: e.kind != null ? String(e.kind) : 'dataframe',
      schema: Array.isArray(e.schema)
        ? e.schema.filter(c => c && c.name != null).map(c => ({ name: String(c.name), type: c.type != null ? String(c.type) : 'unknown' }))
        : [],
      rowCount: (e.rowCount != null && Number.isFinite(Number(e.rowCount))) ? Number(e.rowCount) : null,
      provenance: e.provenance != null ? String(e.provenance) : (e.name != null ? String(e.name) : ''),
    },
  };
}

// Build the wire message announcing that a peer is (or, with a null objectName,
// is no longer) viewing a given object. Feeds the read-only viewing map only —
// no enforcement, purely informational, exactly like Batch 1's role field.
export function buildViewingMessage({ objectName, from, ts } = {}) {
  const clearing = objectName == null || objectName === '';
  return {
    kind: clearing ? 'viewing-clear' : 'viewing',
    from: from != null ? String(from) : null,
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
    objectName: clearing ? null : String(objectName),
  };
}

// Composes a Batch-1 RoomSignalingCoordinator (the source of selfId, the live
// peer list, and whether a Room is actually joined) with a data-channel
// transport adapter. Mirrors FederatedCoordinator/RoomSignalingCoordinator
// constructor discipline: collaborators are injected and every method is
// best-effort and never throws.
export class RoomBroadcastCoordinator {
  constructor({
    room,                          // a RoomSignalingCoordinator (duck-typed: { selfId, joined, listPeers() })
    transport = NULL_ROOM_TRANSPORT,
    objectSpace = null,            // optional local Object Space (duck-typed: { register }) remote entries are applied into
    now = () => Date.now(),
    onRemoteEntry = null,          // (entry, message) => void — fired after a remote entry is applied
    onViewersChanged = null,       // (objectName, viewerIds) => void — fired after the viewing map changes
  } = {}) {
    if (!room) throw new Error('RoomBroadcastCoordinator requires a RoomSignalingCoordinator (room).');
    this.room = room;
    this.transport = transport || NULL_ROOM_TRANSPORT;
    this.objectSpace = objectSpace;
    this.now = now;
    this.onRemoteEntry = onRemoteEntry;
    this.onViewersChanged = onViewersChanged;
    // peerId -> { name, ts } of the most recent entry we accepted from that peer,
    // so an out-of-order / duplicate older message is ignored rather than
    // re-applied. Keyed by `${from}::${name}`.
    this._lastSeen = new Map();
    // objectName -> Set(peerId) currently viewing it. The read-only "who's
    // viewing" data layer; Batch 3 renders it, this batch only maintains it.
    this._viewers = new Map();
  }

  // Whether a Room is actually open. Broadcasting only ever happens when this is
  // true — with no active Room the coordinator is inert and every existing
  // single-user path stays byte-for-byte unchanged.
  isActive() {
    return !!(this.room && this.room.joined);
  }

  selfId() {
    return this.room ? this.room.selfId : null;
  }

  // Broadcast a new/updated Object Space entry to every other peer in the Room.
  // Best-effort: with no active Room it is a no-op ({ ok:false, reason:'no-room' })
  // that never touches the transport; otherwise it sends to each peer and reports
  // how many deliveries succeeded. One peer (or the whole transport) failing is
  // swallowed — a broadcast never throws and never blocks the local save.
  async broadcastEntry(entry) {
    if (!this.isActive()) return { ok: false, reason: 'no-room', delivered: 0, peers: 0 };
    const message = buildEntryMessage({ entry, from: this.selfId(), ts: this.now() });
    return this._sendToPeers(message);
  }

  // Announce that this peer is now viewing (or, with a null/empty objectName, has
  // stopped viewing) a given object. Same best-effort no-room semantics as
  // broadcastEntry. Informational only.
  async broadcastViewing(objectName) {
    if (!this.isActive()) return { ok: false, reason: 'no-room', delivered: 0, peers: 0 };
    const message = buildViewingMessage({ objectName, from: this.selfId(), ts: this.now() });
    return this._sendToPeers(message);
  }

  async _sendToPeers(message) {
    let peers = [];
    try { peers = await this.room.listPeers(); } catch (e) { peers = []; }
    const targets = (peers || []).filter(p => p && p.id != null && String(p.id) !== String(this.selfId()));
    let delivered = 0;
    for (const peer of targets) {
      try {
        const ok = await this.transport.send(peer, message);
        if (ok) delivered++;
      } catch (e) { /* one unreachable peer must not abort the broadcast */ }
    }
    return { ok: delivered > 0, delivered, peers: targets.length, message };
  }

  // Handle one message arriving from a peer over the data channel. Routes by
  // kind; anything malformed or from ourselves is ignored (never thrown). Returns
  // a small status object describing what, if anything, was applied.
  async receive(message) {
    const m = message || {};
    if (!ROOM_MESSAGE_KINDS.includes(m.kind)) return { applied: false, reason: 'unknown-kind' };
    if (m.from != null && String(m.from) === String(this.selfId())) return { applied: false, reason: 'self' };
    if (m.kind === 'object-entry') return this._receiveEntry(m);
    if (m.kind === 'viewing') return this._receiveViewing(m);
    return this._receiveViewingClear(m); // 'viewing-clear'
  }

  _receiveEntry(m) {
    const entry = m.entry;
    if (!entry || entry.name == null || entry.name === '') return { applied: false, reason: 'malformed' };
    const name = String(entry.name);
    const key = `${m.from == null ? '' : m.from}::${name}`;
    const ts = Number.isFinite(Number(m.ts)) ? Number(m.ts) : 0;
    const prev = this._lastSeen.get(key);
    // Ignore a duplicate or out-of-order (older-or-equal) update from the same
    // peer for the same object — the newest write wins.
    if (prev && ts <= prev) return { applied: false, reason: 'stale' };
    this._lastSeen.set(key, ts);
    if (this.objectSpace && typeof this.objectSpace.register === 'function') {
      try { this.objectSpace.register(entry); } catch (e) { /* a wiring bug must not break receive */ }
    }
    if (typeof this.onRemoteEntry === 'function') { try { this.onRemoteEntry(entry, m); } catch (e) { /* non-fatal */ } }
    return { applied: true, entry, from: m.from };
  }

  _receiveViewing(m) {
    if (m.objectName == null || m.objectName === '' || m.from == null) return { applied: false, reason: 'malformed' };
    const name = String(m.objectName);
    const peerId = String(m.from);
    if (!this._viewers.has(name)) this._viewers.set(name, new Set());
    this._viewers.get(name).add(peerId);
    this._notifyViewers(name);
    return { applied: true, objectName: name, from: peerId };
  }

  _receiveViewingClear(m) {
    if (m.from == null) return { applied: false, reason: 'malformed' };
    const peerId = String(m.from);
    const touched = [];
    for (const [name, set] of this._viewers) {
      if (set.delete(peerId)) touched.push(name);
    }
    for (const name of touched) this._notifyViewers(name);
    return { applied: true, from: peerId, cleared: touched };
  }

  _notifyViewers(objectName) {
    if (typeof this.onViewersChanged !== 'function') return;
    try { this.onViewersChanged(objectName, this.viewersOf(objectName)); } catch (e) { /* non-fatal */ }
  }

  // ---- read-only "who's viewing" accessors (the data layer Batch 3 renders) ----

  // The peer ids currently viewing a given object (defensive copy, never self).
  viewersOf(objectName) {
    const set = this._viewers.get(String(objectName));
    return set ? [...set] : [];
  }

  // The object names a given peer is currently viewing.
  objectsViewedBy(peerId) {
    const id = String(peerId);
    const names = [];
    for (const [name, set] of this._viewers) {
      if (set.has(id)) names.push(name);
    }
    return names;
  }

  // The full viewing map as a plain object { objectName: [peerId, ...] } — a
  // defensive snapshot for a renderer to read without touching internal state.
  viewingSnapshot() {
    const out = {};
    for (const [name, set] of this._viewers) {
      if (set.size) out[name] = [...set];
    }
    return out;
  }

  // Drop a peer entirely (e.g. it left the Room) from the viewing map.
  forgetPeer(peerId) {
    const m = { kind: 'viewing-clear', from: peerId };
    return this._receiveViewingClear(m);
  }
}

// ------------------------------------------------------------
// Browser adapter (best-effort, defensive). Not exercised in CI — it needs a
// real WebRTC data channel, exactly like federated-transport.js's own browser
// adapters; the coordinator logic it feeds IS fully tested via injected fakes.
// It REUSES the Federated Learning WebRTC mesh's data-channel primitive rather
// than opening a second, parallel transport: Rooms and Federated Learning share
// the one proven peer-to-peer path. Degrades to NULL_ROOM_TRANSPORT on error.
// ------------------------------------------------------------
export function createRoomBroadcastTransport({ mesh = null } = {}) {
  if (!mesh || !mesh.supported || typeof mesh.exchange !== 'function') return NULL_ROOM_TRANSPORT;
  return {
    supported: true,
    mesh,
    // The federated mesh's data-channel primitive is exchange(peer, payload);
    // for a one-way broadcast we send our message and ignore any reply. Any
    // failure is swallowed to false so a single unreachable peer never aborts a
    // broadcast — the coordinator counts only successful deliveries.
    async send(peer, message) {
      try {
        await mesh.exchange(peer, message);
        return true;
      } catch (e) {
        return false;
      }
    },
  };
}

export { NULL_ROOM_TRANSPORT };
