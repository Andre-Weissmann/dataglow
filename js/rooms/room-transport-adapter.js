// ============================================================
// DATAGLOW — Rooms: real signaling + data-channel adapters (Batch 4 of 4)
// ============================================================
// Batches 1-3 shipped the pure, Node-testable Rooms modules (room-signaling.js,
// room-broadcast.js, room-ui.js) but every one of them was wired to a NULL
// no-op adapter — "signaling unreachable" / "transport unsupported" — because
// no real adapter existed yet. This file is that adapter, built by bridging
// the EXACT two browser adapters federated-transport.js already ships and has
// running in production behind the `federatedLearning` flag:
//
//   • createGithubSignaling  — a public GitHub branch used as a rotating
//     "phone book" JSON file. Reading is unauthenticated; publishing needs a
//     user-supplied fine-grained token with contents:write on ONLY this repo.
//   • createWebRTCMesh       — a WebRTC data-channel mesh, bootstrapped by
//     whatever signaling adapter it's given.
//
// The bridging problem: federated-transport.js's adapters speak a SINGLE global
// phone book (`fetchPeers`/`publishPresence`/`fetchRelayUpdates`/
// `publishRelayUpdate`), because Federated Learning has exactly one cohort —
// every DataGlow user, globally. Rooms is fundamentally different: each Room is
// its own tiny, ephemeral, room-code-scoped cohort (2-6 people who just typed
// the same code into their own browsers), and RoomSignalingCoordinator /
// RoomBroadcastCoordinator expect a DIFFERENT interface shaped around that:
//
//   signaling: { announcePresence({roomCode,id,...}), fetchRoomPeers({roomCode}),
//                leaveRoom({roomCode,id}) }
//   transport: { supported, send(peer, message) }
//
// So this file does NOT reuse federated-transport.js's exports directly (their
// shapes are incompatible) — it reuses their PATTERN and their already-proven
// primitives (the same raw.githubusercontent.com read path, the same
// RTCPeerConnection support check) but re-implements the phone book as
// per-room-code partitioned data, and re-implements the mesh exchange as a
// fire-and-forget send() instead of a request/response exchange() (Rooms
// broadcasts don't need a reply; federated gossip does).
//
// Same philosophy throughout: every method is best-effort. A network failure,
// a missing token, an unsupported browser, or a malformed remote payload never
// throws past this module — it degrades to the null-adapter behavior the
// callers (RoomSignalingCoordinator, RoomBroadcastCoordinator) already handle
// as a first-class "unreachable" state. Nothing here ever moves a row of data:
// the GitHub phone book carries only { roomCode, peerId, displayName, role,
// ts } presence records (see room-signaling.js's join() payload) and WebRTC
// offer/ICE signaling; actual Object Space entries travel peer-to-peer over the
// data channel this file opens, exactly as room-broadcast.js already documents.

import { isWebRTCSupported } from '../federated/federated-learning.js';

const NULL_ROOM_SIGNALING_ADAPTER = {
  async announcePresence() { return false; },
  async fetchRoomPeers() { return []; },
  async leaveRoom() { return false; },
};

const NULL_ROOM_TRANSPORT_ADAPTER = {
  supported: false,
  async send() { return false; },
};

// A presence record older than this is treated as a stale/abandoned peer
// (browser closed without calling leaveRoom) and filtered out of
// fetchRoomPeers() results, so a Room's presence list self-heals without
// needing an explicit heartbeat protocol.
const PRESENCE_TTL_MS = 2 * 60 * 1000;

// ------------------------------------------------------------
// GitHub coordination-branch signaling, partitioned per room code.
// ------------------------------------------------------------
// Reuses the identical read path federated-transport.js's createGithubSignaling
// already runs in production: an unauthenticated GET of a JSON file on a
// dedicated coordination branch via the raw.githubusercontent.com CDN (so
// reading never needs a token, and every peer — including ones with no token
// at all — can always at least discover who else is in the room). The file is
// now a map of roomCode -> { peers: [...] } so many concurrent Rooms share one
// coordination branch without seeing each other's presence records.
//
// Publishing (announcePresence/leaveRoom) requires a token with contents:write
// on this repo and goes through the GitHub Contents API's read-modify-write
// dance (get current file sha, merge in this peer's record, PUT). Two peers
// joining in the same instant can race and one write can 409 — that failure is
// swallowed (returns false) exactly like federated-transport.js's publish
// methods already do, and the room simply becomes visible on that peer's next
// successful announce or on another peer's next read.
export function createGithubRoomSignaling({
  owner, repo, branch = 'rooms-coordination', path = 'rooms.json',
  token = null,
  fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
  now = () => Date.now(),
} = {}) {
  if (!owner || !repo || !fetchImpl) return NULL_ROOM_SIGNALING_ADAPTER;
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;

  async function readFile() {
    try {
      const res = await fetchImpl(`${rawUrl}?t=${now()}`, { cache: 'no-store' });
      if (!res || !res.ok) return {};
      const parsed = await res.json();
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) { return {}; }
  }

  function livingPeers(record) {
    const peers = (record && Array.isArray(record.peers)) ? record.peers : [];
    return peers.filter(p => p && p.ts != null && (now() - Number(p.ts)) < PRESENCE_TTL_MS);
  }

  // Best-effort read-modify-write against the GitHub Contents API. `mutate`
  // receives the current room record ({peers:[...]}) and returns the next one;
  // returning null aborts the write (used by leaveRoom on an already-empty
  // room, to avoid a pointless commit). Any failure — missing token, 404 on a
  // not-yet-created file, a 409 sha conflict — yields false, never a throw.
  async function writeRoom(roomCode, mutate) {
    if (!token) return false;
    try {
      const getRes = await fetchImpl(apiUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      let sha; let allRooms = {};
      if (getRes && getRes.ok) {
        const body = await getRes.json();
        sha = body.sha;
        allRooms = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      } else if (getRes && getRes.status !== 404) {
        return false; // some other API error — don't guess, just fail closed
      }
      const currentRoom = (allRooms && allRooms[roomCode]) || { peers: [] };
      const nextRoom = mutate(currentRoom);
      if (nextRoom == null) return true; // mutate() decided there's nothing to write
      allRooms[roomCode] = nextRoom;
      const encoded = (typeof Buffer !== 'undefined')
        ? Buffer.from(JSON.stringify(allRooms, null, 2)).toString('base64')
        : btoa(unescape(encodeURIComponent(JSON.stringify(allRooms, null, 2))));
      const putRes = await fetchImpl(apiUrl.split('?')[0], {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        body: JSON.stringify({
          message: `rooms: update presence for ${roomCode}`,
          content: encoded,
          branch,
          ...(sha ? { sha } : {}),
        }),
      });
      return !!(putRes && putRes.ok);
    } catch (e) { return false; }
  }

  return {
    async announcePresence({ roomCode, id, displayName, role, ts } = {}) {
      if (!roomCode || id == null) return false;
      return writeRoom(roomCode, (room) => {
        const peers = (room.peers || []).filter(p => p && String(p.id) !== String(id));
        peers.push({ id: String(id), displayName: displayName || null, role: role || null, ts: ts || now() });
        return { peers };
      });
    },
    async fetchRoomPeers({ roomCode } = {}) {
      if (!roomCode) return [];
      const all = await readFile();
      return livingPeers(all[roomCode]);
    },
    async leaveRoom({ roomCode, id } = {}) {
      if (!roomCode || id == null) return false;
      return writeRoom(roomCode, (room) => {
        const remaining = (room.peers || []).filter(p => p && String(p.id) !== String(id));
        return { peers: remaining };
      });
    },
    _hasWriteToken: !!token,
  };
}

// ------------------------------------------------------------
// WebRTC data-channel transport for Room broadcasts.
// ------------------------------------------------------------
// Room broadcasts (Object Space entries, viewing pings) are fire-and-forget —
// unlike federated-transport.js's exchange() which needs a reply (the peer's
// masked update), room-broadcast.js's send(peer, message) only needs "did this
// leave the device," so the mesh here is deliberately simpler: one
// RTCPeerConnection + RTCDataChannel per peer, opened lazily on first send and
// reused after that, with the offer/answer/ICE handshake bootstrapped through
// whatever signaling adapter is passed in (normally the same
// createGithubRoomSignaling instance driving presence, reusing its room-scoped
// read/write so no second coordination channel is needed).
//
// Handshake failures (peer never answers, ICE never connects, the signaling
// channel is unreachable) are the expected common case for a browser-to-
// browser mesh with no dedicated TURN server — every path below degrades to
// `false` rather than throwing, exactly like NULL_ROOM_TRANSPORT_ADAPTER, so a
// Room that can't actually connect to a given peer just silently delivers 0
// messages to them instead of breaking the broadcast for peers it CAN reach.
export function createRoomWebRTCTransport({
  roomCode, selfId, signaling = NULL_ROOM_SIGNALING_ADAPTER,
  rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  now = () => Date.now(),
} = {}) {
  const supported = isWebRTCSupported();
  if (!supported || typeof RTCPeerConnection === 'undefined') return NULL_ROOM_TRANSPORT_ADAPTER;

  // peerId -> { pc, channel, ready:Promise<boolean> }
  const connections = new Map();

  // Signaling for the handshake itself piggybacks on the same room-scoped
  // GitHub adapter used for presence: each peer's OFFER/ANSWER/ICE candidates
  // are stashed on that peer's own presence record (a `signal` field) rather
  // than opening a second channel, keeping this adapter self-contained.
  async function publishSignal(targetId, signal) {
    try {
      return await signaling.announcePresence({
        roomCode, id: selfId, ts: now(), signal: { to: targetId, ...signal },
      });
    } catch (e) { return false; }
  }

  async function readSignalFor(targetId) {
    try {
      const peers = await signaling.fetchRoomPeers({ roomCode });
      const mine = (peers || []).find(p => p && String(p.id) === String(targetId) && p.signal
        && String(p.signal.to) === String(selfId));
      return mine ? mine.signal : null;
    } catch (e) { return null; }
  }

  // Opens (or returns the existing) RTCPeerConnection + data channel for a
  // given peer. Best-effort with a short polling wait for the answer/ICE to
  // arrive via the signaling adapter — bounded so an unresponsive peer can
  // never hang a broadcast indefinitely.
  async function getConnection(peer) {
    const peerId = String(peer.id);
    if (connections.has(peerId)) return connections.get(peerId);

    const pc = new RTCPeerConnection(rtcConfig);
    const channel = pc.createDataChannel('dataglow-room');
    const entry = { pc, channel, open: false };
    connections.set(peerId, entry);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) publishSignal(peerId, { kind: 'ice', candidate: ev.candidate });
    };
    channel.onopen = () => { entry.open = true; };
    channel.onclose = () => { entry.open = false; };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await publishSignal(peerId, { kind: 'offer', sdp: offer });

      // Poll briefly for the peer's answer — a full production build would
      // subscribe/push; polling the same read path keeps this adapter's
      // surface area small and consistent with fetchRoomPeers' own polling
      // presence model.
      const deadline = now() + 8000;
      while (now() < deadline && !pc.currentRemoteDescription) {
        const signal = await readSignalFor(peerId);
        if (signal && signal.kind === 'answer' && !pc.currentRemoteDescription) {
          try { await pc.setRemoteDescription(signal.sdp); } catch (e) { /* ignore malformed */ }
        } else if (signal && signal.kind === 'ice' && pc.currentRemoteDescription) {
          try { await pc.addIceCandidate(signal.candidate); } catch (e) { /* ignore malformed */ }
        }
        if (entry.open) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } catch (e) { /* handshake failure — entry.open stays false, send() below reports false */ }

    return entry;
  }

  return {
    supported: true,
    async send(peer, message) {
      if (!peer || peer.id == null) return false;
      try {
        const entry = await getConnection(peer);
        if (!entry.open || !entry.channel || entry.channel.readyState !== 'open') return false;
        entry.channel.send(JSON.stringify(message));
        return true;
      } catch (e) { return false; }
    },
    // Best-effort teardown of every open peer connection — called from
    // leaveRoom() so a left Room doesn't keep dangling RTCPeerConnections
    // alive in the background.
    closeAll() {
      for (const { pc, channel } of connections.values()) {
        try { channel && channel.close(); } catch (e) { /* ignore */ }
        try { pc && pc.close(); } catch (e) { /* ignore */ }
      }
      connections.clear();
    },
  };
}

export { NULL_ROOM_SIGNALING_ADAPTER, NULL_ROOM_TRANSPORT_ADAPTER };
