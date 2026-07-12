// ============================================================
// DATAGLOW — Tests: Room signaling / peer discovery (Rooms Batch 1)
// ============================================================
// Plain node, no DOM/DuckDB/network needed — this module is pure JS with an
// injected signaling adapter, exactly like federated-learning.test.mjs tests
// FederatedCoordinator via injected fakes.

import assert from 'node:assert/strict';
import {
  isRoomsSupported, generateRoomCode, normalizeRoomCode, isValidRoomCode,
  RoomSignalingCoordinator, NULL_ROOM_SIGNALING,
} from '../js/rooms/room-signaling.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ---- isRoomsSupported ----

test('isRoomsSupported: true when RTCPeerConnection present', () => {
  assert.equal(isRoomsSupported({ RTCPeerConnection: function () {} }), true);
});

test('isRoomsSupported: false when RTCPeerConnection absent (never throws)', () => {
  assert.equal(isRoomsSupported({}), false);
});

test('isRoomsSupported: false on an empty/undefined env', () => {
  assert.equal(isRoomsSupported(undefined), false);
});

// ---- generateRoomCode ----

test('generateRoomCode: produces XXXX-XXXX-XXXX shape', () => {
  const code = generateRoomCode(() => 0.5);
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test('generateRoomCode: never contains ambiguous chars 0/O/1/I/L', () => {
  // Sweep rng across the full [0,1) range to exercise every alphabet index.
  for (let i = 0; i < 100; i++) {
    const rng = () => i / 100;
    const code = generateRoomCode(rng);
    assert.equal(/[01ILO]/.test(code), false, `code ${code} contained an ambiguous char`);
  }
});

test('generateRoomCode: deterministic given a fixed rng', () => {
  const a = generateRoomCode(() => 0.1);
  const b = generateRoomCode(() => 0.1);
  assert.equal(a, b);
});

test('generateRoomCode: defaults to Math.random without throwing', () => {
  const code = generateRoomCode();
  assert.equal(isValidRoomCode(code), true);
});

// ---- normalizeRoomCode / isValidRoomCode ----

test('normalizeRoomCode: accepts lowercase and re-uppercases', () => {
  const code = generateRoomCode(() => 0.3);
  const lower = code.toLowerCase();
  assert.equal(normalizeRoomCode(lower), code);
});

test('normalizeRoomCode: tolerates extra spaces/dashes variance', () => {
  const code = generateRoomCode(() => 0.7); // e.g. "XXXX-XXXX-XXXX"
  const messy = ' ' + code.replace(/-/g, ' ') + ' ';
  assert.equal(normalizeRoomCode(messy), code);
});

test('normalizeRoomCode: rejects wrong length', () => {
  assert.equal(normalizeRoomCode('ABCD-ABCD'), null);
  assert.equal(normalizeRoomCode('ABCD-ABCD-ABCD-ABCD'), null);
});

test('normalizeRoomCode: rejects non-alphabet characters (ambiguous or invalid)', () => {
  assert.equal(normalizeRoomCode('AAAA-AAAA-AAA0'), null); // '0' not in alphabet
  assert.equal(normalizeRoomCode('AAAA-AAAA-AAAI'), null); // 'I' not in alphabet
});

test('normalizeRoomCode: non-string input returns null, never throws', () => {
  assert.equal(normalizeRoomCode(null), null);
  assert.equal(normalizeRoomCode(undefined), null);
  assert.equal(normalizeRoomCode(12345), null);
});

test('isValidRoomCode: true for a freshly generated code', () => {
  assert.equal(isValidRoomCode(generateRoomCode(() => 0.42)), true);
});

test('isValidRoomCode: false for garbage input', () => {
  assert.equal(isValidRoomCode('not-a-room-code'), false);
});

// ---- RoomSignalingCoordinator: construction ----

test('constructor: throws on missing/invalid roomCode', () => {
  assert.throws(() => new RoomSignalingCoordinator({ roomCode: 'bad' }));
  assert.throws(() => new RoomSignalingCoordinator({}));
});

test('constructor: normalizes the roomCode', () => {
  const code = generateRoomCode(() => 0.2);
  const coord = new RoomSignalingCoordinator({ roomCode: code.toLowerCase() });
  assert.equal(coord.roomCode, code);
});

test('constructor: generates a selfId when none given', () => {
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode() });
  assert.equal(typeof coord.selfId, 'string');
  assert.ok(coord.selfId.startsWith('peer-'));
});

test('constructor: preserves displayName/role as informational-only fields', () => {
  const coord = new RoomSignalingCoordinator({
    roomCode: generateRoomCode(), displayName: 'Andre R.', role: 'Analyst',
  });
  assert.equal(coord.displayName, 'Andre R.');
  assert.equal(coord.role, 'Analyst');
});

test('constructor: defaults to NULL_ROOM_SIGNALING (never throws when unused)', async () => {
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode() });
  const result = await coord.join();
  assert.equal(result.ok, false);
});

// ---- join() ----

test('join(): true when the injected signaling adapter succeeds', async () => {
  const fakeSignaling = {
    announcePresence: async () => true,
    fetchRoomPeers: async () => [],
    leaveRoom: async () => true,
  };
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode(), signaling: fakeSignaling });
  const result = await coord.join();
  assert.equal(result.ok, true);
  assert.equal(coord.joined, true);
  assert.equal(result.roomCode, coord.roomCode);
});

test('join(): false, never throws, when the signaling adapter rejects', async () => {
  const fakeSignaling = {
    announcePresence: async () => { throw new Error('network down'); },
    fetchRoomPeers: async () => [],
    leaveRoom: async () => false,
  };
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode(), signaling: fakeSignaling });
  const result = await coord.join();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signaling-unreachable');
  assert.equal(coord.joined, false);
});

test('join(): passes roomCode, selfId, displayName, role, ts to the adapter', async () => {
  let captured = null;
  const fakeSignaling = {
    announcePresence: async (payload) => { captured = payload; return true; },
    fetchRoomPeers: async () => [],
    leaveRoom: async () => true,
  };
  const code = generateRoomCode();
  const coord = new RoomSignalingCoordinator({
    roomCode: code, selfId: 'peer-42', displayName: 'Jamie T.', role: 'Data Engineer',
    signaling: fakeSignaling, now: () => 999,
  });
  await coord.join();
  assert.deepEqual(captured, {
    roomCode: code, id: 'peer-42', displayName: 'Jamie T.', role: 'Data Engineer', ts: 999,
  });
});

// ---- listPeers() ----

test('listPeers(): returns peers from the adapter, excluding self', async () => {
  const fakeSignaling = {
    announcePresence: async () => true,
    fetchRoomPeers: async () => [
      { id: 'peer-1', displayName: 'Andre R.' },
      { id: 'peer-2', displayName: 'Mika K.' },
      { id: 'self-id', displayName: 'me' },
    ],
    leaveRoom: async () => true,
  };
  const coord = new RoomSignalingCoordinator({
    roomCode: generateRoomCode(), selfId: 'self-id', signaling: fakeSignaling,
  });
  const peers = await coord.listPeers();
  assert.equal(peers.length, 2);
  assert.deepEqual(peers.map(p => p.id), ['peer-1', 'peer-2']);
});

test('listPeers(): filters out malformed peer entries (null, missing id)', async () => {
  const fakeSignaling = {
    announcePresence: async () => true,
    fetchRoomPeers: async () => [null, {}, { id: 'peer-1' }, { id: null }],
    leaveRoom: async () => true,
  };
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode(), signaling: fakeSignaling });
  const peers = await coord.listPeers();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, 'peer-1');
});

test('listPeers(): returns [] (never throws) when the adapter is unreachable', async () => {
  const fakeSignaling = {
    announcePresence: async () => true,
    fetchRoomPeers: async () => { throw new Error('unreachable'); },
    leaveRoom: async () => true,
  };
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode(), signaling: fakeSignaling });
  const peers = await coord.listPeers();
  assert.deepEqual(peers, []);
});

test('listPeers(): returns [] with the default NULL_ROOM_SIGNALING adapter', async () => {
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode() });
  const peers = await coord.listPeers();
  assert.deepEqual(peers, []);
});

// ---- leave() ----

test('leave(): true and clears joined state on success', async () => {
  const fakeSignaling = {
    announcePresence: async () => true,
    fetchRoomPeers: async () => [],
    leaveRoom: async () => true,
  };
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode(), signaling: fakeSignaling });
  await coord.join();
  assert.equal(coord.joined, true);
  const result = await coord.leave();
  assert.equal(result.ok, true);
  assert.equal(coord.joined, false);
});

test('leave(): false, never throws, when the adapter fails', async () => {
  const fakeSignaling = {
    announcePresence: async () => true,
    fetchRoomPeers: async () => [],
    leaveRoom: async () => { throw new Error('gone'); },
  };
  const coord = new RoomSignalingCoordinator({ roomCode: generateRoomCode(), signaling: fakeSignaling });
  await coord.join();
  const result = await coord.leave();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signaling-unreachable');
  assert.equal(coord.joined, false);
});

// ---- NULL_ROOM_SIGNALING contract ----

test('NULL_ROOM_SIGNALING: every method resolves to a safe no-op value', async () => {
  assert.equal(await NULL_ROOM_SIGNALING.announcePresence(), false);
  assert.deepEqual(await NULL_ROOM_SIGNALING.fetchRoomPeers(), []);
  assert.equal(await NULL_ROOM_SIGNALING.leaveRoom(), false);
});

// ---- summary ----
console.log(`\n${pass} passing, ${fail} failing`);
if (fail > 0) process.exit(1);
