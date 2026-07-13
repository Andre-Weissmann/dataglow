// Tests for js/rooms/room-transport-adapter.js — the real Batch-4 signaling +
// data-channel adapters that bridge RoomSignalingCoordinator/
// RoomBroadcastCoordinator to a real (faked, here) GitHub coordination branch
// and a real (faked, here) WebRTC mesh. No network, no browser: every external
// dependency (fetch, RTCPeerConnection) is injected or globally stubbed.

import assert from 'node:assert/strict';
import {
  createGithubRoomSignaling,
  createRoomWebRTCTransport,
  NULL_ROOM_SIGNALING_ADAPTER,
  NULL_ROOM_TRANSPORT_ADAPTER,
} from '../js/rooms/room-transport-adapter.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

// ------------------------------------------------------------
// createGithubRoomSignaling
// ------------------------------------------------------------

test('createGithubRoomSignaling returns the null adapter when owner/repo/fetchImpl missing', () => {
  const a1 = createGithubRoomSignaling({});
  assert.equal(a1, NULL_ROOM_SIGNALING_ADAPTER);
  const a2 = createGithubRoomSignaling({ owner: 'x', repo: 'y', fetchImpl: null });
  assert.equal(a2, NULL_ROOM_SIGNALING_ADAPTER);
});

await testAsync('fetchRoomPeers reads and filters to the requested room code', async () => {
  const now = () => 1_000_000;
  const fakeFetch = async (url) => {
    assert.ok(String(url).includes('raw.githubusercontent.com'));
    return {
      ok: true,
      json: async () => ({
        'ABCD-EFGH-JKMN': { peers: [{ id: 'p1', ts: now() - 1000 }] },
        'OTHR-ROOM-CODE': { peers: [{ id: 'p2', ts: now() - 1000 }] },
      }),
    };
  };
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch, now });
  const peers = await adapter.fetchRoomPeers({ roomCode: 'ABCD-EFGH-JKMN' });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, 'p1');
});

await testAsync('fetchRoomPeers filters out stale (TTL-expired) presence records', async () => {
  const now = () => 10_000_000;
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      ROOM1: {
        peers: [
          { id: 'fresh', ts: now() - 5000 },       // well within TTL
          { id: 'stale', ts: now() - (3 * 60 * 1000) }, // older than 2min TTL
        ],
      },
    }),
  });
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch, now });
  const peers = await adapter.fetchRoomPeers({ roomCode: 'ROOM1' });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, 'fresh');
});

await testAsync('fetchRoomPeers degrades to [] on a fetch failure, never throws', async () => {
  const fakeFetch = async () => { throw new Error('network down'); };
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch });
  const peers = await adapter.fetchRoomPeers({ roomCode: 'ROOM1' });
  assert.deepEqual(peers, []);
});

await testAsync('fetchRoomPeers degrades to [] on a non-ok response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404 });
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch });
  const peers = await adapter.fetchRoomPeers({ roomCode: 'ROOM1' });
  assert.deepEqual(peers, []);
});

await testAsync('announcePresence returns false with no token (read-only mode)', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({}) });
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch, token: null });
  const ok = await adapter.announcePresence({ roomCode: 'ROOM1', id: 'p1', ts: 1 });
  assert.equal(ok, false);
  assert.equal(adapter._hasWriteToken, false);
});

await testAsync('announcePresence with a token does a read-modify-write PUT and returns true', async () => {
  const calls = [];
  const existingContent = Buffer.from(JSON.stringify({ ROOM1: { peers: [{ id: 'existing', ts: 1 }] } })).toString('base64');
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    if (!opts.method || opts.method === 'GET') {
      return { ok: true, json: async () => ({ sha: 'abc123', content: existingContent }) };
    }
    if (opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      assert.equal(body.sha, 'abc123');
      assert.equal(body.branch, 'rooms-coordination');
      const decoded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      assert.equal(decoded.ROOM1.peers.length, 2); // existing + new
      assert.ok(decoded.ROOM1.peers.some(p => p.id === 'newpeer'));
      return { ok: true, json: async () => ({}) };
    }
    throw new Error('unexpected method ' + opts.method);
  };
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch, token: 'tok_123' });
  const ok = await adapter.announcePresence({ roomCode: 'ROOM1', id: 'newpeer', ts: 5 });
  assert.equal(ok, true);
  assert.ok(calls.some(c => c.method === 'PUT'));
  assert.equal(adapter._hasWriteToken, true);
});

await testAsync('announcePresence handles a not-yet-created file (404 on GET) by creating it', async () => {
  const fakeFetch = async (url, opts = {}) => {
    if (!opts.method || opts.method === 'GET') return { ok: false, status: 404 };
    if (opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      assert.equal(body.sha, undefined); // no sha on first-ever write
      const decoded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      assert.equal(decoded.ROOM1.peers.length, 1);
      return { ok: true, json: async () => ({}) };
    }
    throw new Error('unexpected');
  };
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch, token: 'tok' });
  const ok = await adapter.announcePresence({ roomCode: 'ROOM1', id: 'p1', ts: 1 });
  assert.equal(ok, true);
});

await testAsync('announcePresence returns false (never throws) on a PUT failure (e.g. sha conflict)', async () => {
  const fakeFetch = async (url, opts = {}) => {
    if (!opts.method || opts.method === 'GET') return { ok: true, json: async () => ({ sha: 'x', content: Buffer.from('{}').toString('base64') }) };
    return { ok: false, status: 409 };
  };
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch, token: 'tok' });
  const ok = await adapter.announcePresence({ roomCode: 'ROOM1', id: 'p1', ts: 1 });
  assert.equal(ok, false);
});

await testAsync('announcePresence with missing roomCode/id is a no-op false, no network call', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch, token: 'tok' });
  const ok = await adapter.announcePresence({ roomCode: null, id: 'p1' });
  assert.equal(ok, false);
  assert.equal(called, false);
});

await testAsync('leaveRoom removes the peer from that room only, leaving other rooms untouched', async () => {
  const initial = { ROOM1: { peers: [{ id: 'p1', ts: 1 }, { id: 'p2', ts: 1 }] }, ROOM2: { peers: [{ id: 'p3', ts: 1 }] } };
  const fakeFetch = async (url, opts = {}) => {
    if (!opts.method || opts.method === 'GET') {
      return { ok: true, json: async () => ({ sha: 's1', content: Buffer.from(JSON.stringify(initial)).toString('base64') }) };
    }
    const body = JSON.parse(opts.body);
    const decoded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    assert.equal(decoded.ROOM1.peers.length, 1);
    assert.equal(decoded.ROOM1.peers[0].id, 'p2');
    assert.equal(decoded.ROOM2.peers.length, 1); // untouched
    return { ok: true, json: async () => ({}) };
  };
  const adapter = createGithubRoomSignaling({ owner: 'o', repo: 'r', fetchImpl: fakeFetch, token: 'tok' });
  const ok = await adapter.leaveRoom({ roomCode: 'ROOM1', id: 'p1' });
  assert.equal(ok, true);
});

// ------------------------------------------------------------
// createRoomWebRTCTransport
// ------------------------------------------------------------

test('createRoomWebRTCTransport returns the null adapter when WebRTC is unsupported', () => {
  const originalRTC = globalThis.RTCPeerConnection;
  delete globalThis.RTCPeerConnection;
  try {
    const adapter = createRoomWebRTCTransport({ roomCode: 'R1', selfId: 'me' });
    assert.equal(adapter, NULL_ROOM_TRANSPORT_ADAPTER);
    assert.equal(adapter.supported, false);
  } finally {
    if (originalRTC) globalThis.RTCPeerConnection = originalRTC;
  }
});

await testAsync('send() reports false (never throws) when the peer never answers (handshake timeout)', async () => {
  // A minimal RTCPeerConnection fake whose data channel never opens and whose
  // remote description never arrives — simulates the common "peer
  // unreachable" case for a mesh with no dedicated TURN server.
  class FakeChannel {
    constructor() { this.readyState = 'connecting'; this.onopen = null; this.onclose = null; }
    send() { throw new Error('should never be called while not open'); }
    close() {}
  }
  class FakePeerConnection {
    constructor() { this.currentRemoteDescription = null; this.onicecandidate = null; }
    createDataChannel() { this._channel = new FakeChannel(); return this._channel; }
    async createOffer() { return { type: 'offer', sdp: 'fake-sdp' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {}
  }
  const originalRTC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  try {
    const signaling = { announcePresence: async () => true, fetchRoomPeers: async () => [] };
    const adapter = createRoomWebRTCTransport({
      roomCode: 'R1', selfId: 'me', signaling,
      now: (() => { let t = 0; return () => (t += 100); })(), // fast-forwards the 8s poll deadline quickly
    });
    assert.equal(adapter.supported, true);
    const ok = await adapter.send({ id: 'peer1' }, { kind: 'object-entry' });
    assert.equal(ok, false);
  } finally {
    if (originalRTC) globalThis.RTCPeerConnection = originalRTC; else delete globalThis.RTCPeerConnection;
  }
});

await testAsync('send() delivers once the fake data channel reports open', async () => {
  class FakeChannel {
    constructor() { this.readyState = 'open'; this.onopen = null; this.onclose = null; this.sent = []; }
    send(payload) { this.sent.push(payload); }
    close() {}
  }
  class FakePeerConnection {
    constructor() { this.currentRemoteDescription = null; this.onicecandidate = null; }
    createDataChannel() {
      this._channel = new FakeChannel();
      // Simulate the browser firing onopen on next microtask, before send() polls.
      queueMicrotask(() => { if (this._channel.onopen) this._channel.onopen(); });
      return this._channel;
    }
    async createOffer() { return { type: 'offer', sdp: 'fake-sdp' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {}
  }
  const originalRTC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  try {
    const signaling = { announcePresence: async () => true, fetchRoomPeers: async () => [] };
    const adapter = createRoomWebRTCTransport({ roomCode: 'R1', selfId: 'me', signaling });
    const ok = await adapter.send({ id: 'peer1' }, { kind: 'object-entry', entry: { name: 'x' } });
    assert.equal(ok, true);
  } finally {
    if (originalRTC) globalThis.RTCPeerConnection = originalRTC; else delete globalThis.RTCPeerConnection;
  }
});

test('send() with a malformed peer (no id) returns false without touching RTCPeerConnection', async () => {
  const adapter = createRoomWebRTCTransport({ roomCode: 'R1', selfId: 'me' });
  // No RTCPeerConnection stubbed globally in this test's environment context ->
  // if WebRTC is unsupported here we get the null adapter, which also returns
  // false for a malformed peer — either way this assertion holds.
  const ok = await adapter.send({}, { kind: 'object-entry' });
  assert.equal(ok, false);
});

test('closeAll() on the null adapter is a safe no-op (not present, but caller must guard)', () => {
  // NULL_ROOM_TRANSPORT_ADAPTER intentionally has no closeAll — callers must
  // guard with `transport.closeAll && transport.closeAll()`. Documented here
  // so a future refactor that removes the guard is caught by this test.
  assert.equal(typeof NULL_ROOM_TRANSPORT_ADAPTER.closeAll, 'undefined');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
