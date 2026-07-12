// ============================================================
// DATAGLOW — Rooms: signaling / peer discovery (Batch 1 of 4)
// ============================================================
// DataGlow Rooms lets an analyst, a data scientist, and a data engineer open
// the SAME loaded dataset from their own browsers and see each other's SQL/
// Python/R results and Object Space entries appear live, peer-to-peer, with
// zero server and zero upload — the natural next step for DataGlow's existing
// multi-abstraction-level workflow (drag-and-drop / SQL / Python / R), and the
// gap the 2026-07-12 research pass ("no product lets mixed skill levels work
// one live dataset together without cloud sync") called out as the biggest
// unmet need in the data-tooling market. See NORTH_STAR.md, "Concept:
// DataGlow Rooms" for the full plan.
//
// Batch 1 (this file) ships ONLY room-code generation + a pure peer-discovery/
// signaling contract, reusing the EXACT dependency-injection pattern already
// proven by js/federated/federated-transport.js: a NULL_SIGNALING/NULL_RTC
// no-op adapter pair makes "unreachable" a first-class, never-thrown state,
// and real adapters are injected at the call site (browser) vs. faked (tests).
// No Object Space broadcasting, no UI, and no wiring into the SQL/Python/R
// tabs yet — that is Batch 2. Ships OFF behind the `roomsSignaling` flag
// (default false): with the flag off, nothing in the app ever imports or
// calls into this module, so every existing path is byte-for-byte unchanged.
//
// Nothing here ever moves a row of data. A Room's signaling payload is
// STRICTLY: { roomCode, peerId, offer/ICE candidates for WebRTC negotiation,
// ts }. Actual query results / Object Space entries travel later (Batch 2)
// directly peer-to-peer over the WebRTC data channel this batch opens — they
// are never routed through any signaling adapter, GitHub-backed or otherwise.

import { isWebRTCSupported } from '../federated/federated-learning.js';

// Room codes are short, human-shareable, and collision-resistant enough for a
// same-session, small-cohort use case (this is a live pairing code, not a
// security boundary — WebRTC's own SDP/ICE exchange is what actually
// authenticates the peer connection). 5 groups of 4 base32-ish chars,
// deliberately excluding visually-ambiguous characters (0/O, 1/I/L).
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ROOM_CODE_GROUPS = 3;
const ROOM_CODE_GROUP_LEN = 4;

export function isRoomsSupported(env = (typeof globalThis !== 'undefined' ? globalThis : {})) {
  // Rooms are built entirely on the same WebRTC data-channel primitive as
  // Federated Learning — if that's unavailable, Rooms gracefully report
  // unsupported rather than half-working.
  return isWebRTCSupported(env);
}

// Generates a fresh, shareable room code. Deterministic given an injected
// `rng` (defaults to Math.random) so tests never depend on real randomness.
export function generateRoomCode(rng = Math.random) {
  const groups = [];
  for (let g = 0; g < ROOM_CODE_GROUPS; g++) {
    let group = '';
    for (let i = 0; i < ROOM_CODE_GROUP_LEN; i++) {
      const idx = Math.floor(rng() * ROOM_CODE_ALPHABET.length);
      group += ROOM_CODE_ALPHABET[idx];
    }
    groups.push(group);
  }
  return groups.join('-');
}

// Room codes are case/whitespace-tolerant on input (a person may type or
// paste one with different casing/spacing) but always normalize to the
// canonical generateRoomCode() shape for comparison/storage.
export function normalizeRoomCode(code) {
  if (typeof code !== 'string') return null;
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== ROOM_CODE_GROUPS * ROOM_CODE_GROUP_LEN) return null;
  for (const ch of cleaned) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  }
  const groups = [];
  for (let g = 0; g < ROOM_CODE_GROUPS; g++) {
    groups.push(cleaned.slice(g * ROOM_CODE_GROUP_LEN, (g + 1) * ROOM_CODE_GROUP_LEN));
  }
  return groups.join('-');
}

export function isValidRoomCode(code) {
  return normalizeRoomCode(code) !== null;
}

// A no-op signaling adapter — identical philosophy to federated-transport.js's
// NULL_SIGNALING: "the coordination channel is unreachable" is a first-class,
// error-free state, not a thrown exception.
const NULL_ROOM_SIGNALING = {
  async announcePresence() { return false; },
  async fetchRoomPeers() { return []; },
  async leaveRoom() { return false; },
};

// selfId, roomCode kept explicit and immutable per instance (mirrors
// FederatedCoordinator's constructor discipline) so a caller can never
// accidentally rejoin a different room without creating a fresh coordinator.
export class RoomSignalingCoordinator {
  constructor({
    roomCode,
    selfId,
    displayName = null,
    role = null, // e.g. "Analyst" / "Data Engineer" / "Data Scientist" — informational only, never enforced
    signaling = NULL_ROOM_SIGNALING,
    rng = Math.random,
    now = () => Date.now(),
  } = {}) {
    const normalized = normalizeRoomCode(roomCode);
    if (!normalized) throw new Error('RoomSignalingCoordinator requires a valid roomCode.');
    this.roomCode = normalized;
    this.selfId = selfId || `peer-${Math.floor((rng() * 1e9))}`;
    this.displayName = displayName;
    this.role = role;
    this.signaling = signaling || NULL_ROOM_SIGNALING;
    this.rng = rng;
    this.now = now;
    this.joined = false;
  }

  // Announce this peer's presence in the room. Best-effort: any signaling
  // failure is swallowed and reported, never thrown — matches
  // FederatedCoordinator.announce()'s discipline exactly.
  async join() {
    try {
      const ok = await this.signaling.announcePresence({
        roomCode: this.roomCode,
        id: this.selfId,
        displayName: this.displayName,
        role: this.role,
        ts: this.now(),
      });
      this.joined = !!ok;
      return { ok: !!ok, roomCode: this.roomCode };
    } catch (e) {
      this.joined = false;
      return { ok: false, reason: 'signaling-unreachable', roomCode: this.roomCode };
    }
  }

  // Returns the other peers currently known to be in this room (never
  // includes selfId). Unreachable signaling -> [] rather than a throw.
  async listPeers() {
    try {
      const peers = await this.signaling.fetchRoomPeers({ roomCode: this.roomCode });
      return (peers || []).filter(p => p && p.id != null && String(p.id) !== String(this.selfId));
    } catch (e) {
      return [];
    }
  }

  async leave() {
    try {
      const ok = await this.signaling.leaveRoom({ roomCode: this.roomCode, id: this.selfId });
      this.joined = false;
      return { ok: !!ok };
    } catch (e) {
      this.joined = false;
      return { ok: false, reason: 'signaling-unreachable' };
    }
  }
}

export { NULL_ROOM_SIGNALING };
