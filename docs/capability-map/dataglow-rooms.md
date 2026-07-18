# Capability detail — DataGlow Rooms

Companion to the **DataGlow Rooms** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the peer-to-peer Rooms collaboration path; the index alone is enough for most
tasks.

## What this area is

Rooms lets an analyst, a data scientist, and a data engineer open the **same**
loaded dataset from their own browsers and see each other's SQL/Python/R results
and Object Space entries appear live — **peer-to-peer, zero server, zero upload**.
Only shape metadata and presence records ever cross the wire; never a row of
data. It shipped as four batches, each a pure/DOM-free data layer plus a thin
renderer, reusing the dependency-injection + NULL-adapter discipline proven by
`js/federated/federated-transport.js` (an "unreachable" transport is a
first-class, never-thrown state rather than an error).

All three Rooms flags — **`roomsSignaling`**, **`roomsBroadcast`**,
**`roomsUi`** — are currently `enabled: true` (promoted in
`feat/enable-rooms-flags`), so Rooms is a **live surface for every user**.
`renderRoomUiWidget()` in `js/app-shell/main.js` renders `#room-ui-host` by
default; turning any flag off restores the byte-for-byte prior behavior.

## `js/rooms/room-signaling.js` — Batch 1: room codes + peer discovery

Pure, Node-testable. `isRoomsSupported()`; `generateRoomCode(rng)` (three groups
of four chars from a confusable-free alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`),
`normalizeRoomCode`, `isValidRoomCode`; `class RoomSignalingCoordinator`
(`join`/`listPeers`/`leave`, all best-effort, never throwing). `listPeers()`
excludes self. `NULL_ROOM_SIGNALING` is the no-op adapter.

## `js/rooms/room-broadcast.js` — Batch 2: the first real payload

Pure. `ROOM_MESSAGE_KINDS` = `['object-entry','viewing','viewing-clear']`;
`buildEntryMessage`/`buildViewingMessage`; `class RoomBroadcastCoordinator`
COMPOSES a `RoomSignalingCoordinator` with a data-channel transport —
`broadcastEntry`/`broadcastViewing`/`receive` plus the who's-viewing map
(`viewersOf`/`objectsViewedBy`/`viewingSnapshot`, last-write-wins via
`_lastSeen`). Broadcast payloads carry only an entry's already-public shape
metadata (name/originLanguage/kind/schema/rowCount/provenance pointer), never raw
rows. `NULL_ROOM_TRANSPORT` and `createRoomBroadcastTransport({ mesh })` (reuses
the federated WebRTC mesh) live here.

## `js/rooms/room-ui.js` — Batch 3: the topbar surface

Pure model builders split from a thin DOM renderer (same identity split as
`glow-orb-ui.js`). `buildRoomPillModel({ roomCode, joined, supported })` →
`state` of `unsupported|idle|joined` with label/action; `buildPresenceModel({
peers, viewingSnapshot })` → one avatar badge per peer, composing Batch 1's
`listPeers()` with Batch 2's viewing snapshot; `peerInitials`/`avatarColor`
(deterministic, stable-per-peer, explicitly *not* a security hash);
`buildRemoteEntryToast`/`notifyRemoteEntry` (a live toast on an incoming remote
entry, reusing the app's `toast()` verbatim). `renderRoomUi()` draws the models
and wires injected `onStart`/`onLeave`/`onCopy` — it holds no Room state; the
caller in `main.js` owns the coordinators and re-invokes with fresh models.

## `js/rooms/room-transport-adapter.js` — Batch 4: the real adapters

Replaces the NULL defaults with live browser adapters, reusing
`federated-transport.js`'s **pattern** and primitives (not its exports — the
shapes differ: Rooms is per-room-code-scoped, Federated Learning is one global
cohort). Has **no dedicated flag** of its own; it is activated as part of the
Rooms trio and wired in `main.js`'s `renderRoomUiWidget()`.
- `createGithubRoomSignaling({ owner, repo, branch, path, token, fetchImpl,
  now })` — a public GitHub coordination branch as a rotating "phone book"
  (`rooms.json`, map of roomCode → `{ peers: [...] }`). Reads are
  unauthenticated via `raw.githubusercontent.com`; publishing
  (`announcePresence`/`leaveRoom`) needs a `contents:write` token and does the
  Contents-API read-modify-write dance. `PRESENCE_TTL_MS` (2 min) self-heals
  abandoned peers with no heartbeat protocol. Any failure (missing token, 404,
  409 sha race) → `false`, never a throw.
- `createRoomWebRTCTransport({ roomCode, selfId, signaling, rtcConfig, now })` —
  one `RTCPeerConnection` + data channel per peer, opened lazily, offer/answer/
  ICE piggybacked on the same room-scoped presence record (`signal` field).
  Fire-and-forget `send(peer, message)` (Rooms broadcasts need no reply, unlike
  federated `exchange()`); bounded 8s handshake poll so an unresponsive peer
  can't hang a broadcast; `closeAll()` teardown. Degrades to
  `NULL_ROOM_TRANSPORT_ADAPTER` on any failure.

`main.js` wires it at `renderRoomUiWidget()` (line ~2103): `startRoom()` calls
`createGithubRoomSignaling({ owner:'Andre-Weissmann', repo:'dataglow' })` (read-
only, no write token by default) then `createRoomWebRTCTransport(...)`.

## Live Rooms extensions (filed under "Meeting Scribe" in the manifest)

Two agent-layer modules extend the Rooms channel for the Meeting tab. Both flags
(**`liveRoomsBroadcast`**, **`chartContextTimeline`**) are currently
`enabled: true`, even though both descriptions still read "Ships DARK" — they
have been promoted since.

- `js/agents/live-rooms-broadcast.js` — **genuinely a Rooms broadcast feature**:
  adds a `live-action-items` message kind on top of the existing Rooms data
  channel. `LIVE_ACTION_ITEMS_MESSAGE_KIND`; pure `buildActionItemsMessage`/
  `isValidActionItemsMessage`; `createLiveRoomsBroadcast({ transport, selfId })`
  wraps any injected `send`/`onReceive` transport (a `RoomBroadcastCoordinator`)
  with `broadcastActionItems`/`onReceiveActionItems`; `NULL_LIVE_ROOMS_BROADCAST`
  fallback. Wired into `renderMeetingScribeTab` in `main.js` when the flag is on
  and `window.__dataglow_rooms_broadcast` exists. Its *payload* is Meeting Scribe
  action items, but the *mechanism* is pure Rooms transport.
- `js/agents/chart-context-timeline.js` — **not actually a Rooms feature** despite
  its "Live Rooms Batch 3" header: it has no WebRTC/Rooms/transport involvement
  at all. It is a pure in-memory recorder (`createChartContextTimeline` →
  `recordChartView`/`getTimeline`/`clear`, plus pure `buildChartContextEntry`)
  that feeds the Meeting Scribe's `tagSegmentsWithContext` a real timeline instead
  of `[]`. It belongs conceptually to Meeting scribe; it is noted here only
  because it is grouped with `live-rooms-broadcast.js` in the manifest.

## Tests

- `test/room-signaling.test.mjs`, `test/room-broadcast.test.mjs`,
  `test/room-ui.test.mjs`, `test/room-transport-adapter.test.mjs` — the four
  Rooms batches.
- `test/live-rooms-broadcast.test.mjs`, `test/chart-context-timeline.test.mjs` —
  the two Live Rooms extensions above.

## Honest caveat — manifest area-name inconsistency

`capability-map.manifest.json` files the four core Rooms modules under
`"area": "DataGlow Rooms"`, the transcription modules under
`"area": "Meeting scribe"` (lowercase *s*), but `live-rooms-broadcast.js` and
`chart-context-timeline.js` under a **third, distinct string**
`"area": "Meeting Scribe"` (capital *S*). This capital-S variant is a manifest
naming inconsistency, not a real third area. Of the two files it groups, one
(`live-rooms-broadcast.js`) is a true Rooms-transport extension documented above;
the other (`chart-context-timeline.js`) is really Meeting-scribe support with no
Rooms involvement. See [`meeting-scribe.md`](meeting-scribe.md) for the
transcription side.
