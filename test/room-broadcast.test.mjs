// ============================================================
// DATAGLOW — Tests: Object Space broadcast wiring (Rooms Batch 2)
// ============================================================
// Plain node, no DOM/DuckDB/network needed — this module is pure JS with an
// injected data-channel transport adapter and a duck-typed room, exactly like
// room-signaling.test.mjs (Batch 1) tests RoomSignalingCoordinator via injected
// fakes. We import the REAL object-space.js registry to prove that broadcasting
// is strictly additive: with no active Room, every existing single-user Object
// Space path is byte-for-byte unchanged.

import assert from 'node:assert/strict';
import {
  RoomBroadcastCoordinator, NULL_ROOM_TRANSPORT, ROOM_MESSAGE_KINDS,
  buildEntryMessage, buildViewingMessage, createRoomBroadcastTransport,
} from '../js/rooms/room-broadcast.js';
import { createObjectSpace } from '../js/app-shell/object-space.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { pass++; console.log(`  ok - ${name}`); },
        (e) => { fail++; console.log(`  FAIL - ${name}`); console.log(`    ${e.message}`); });
    }
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

// A minimal duck-typed room mirroring RoomSignalingCoordinator's surface: the
// only bits the broadcast coordinator reads are selfId, joined, and listPeers().
function fakeRoom({ selfId = 'self', joined = true, peers = [], listThrows = false } = {}) {
  return {
    selfId, joined,
    async listPeers() {
      if (listThrows) throw new Error('signaling down');
      return peers;
    },
  };
}

// A transport fake that records every send. `fail` makes a specific peer (or
// all) reject, to exercise per-peer degradation.
function fakeTransport({ failFor = null } = {}) {
  const sent = [];
  return {
    sent,
    async send(peer, message) {
      if (failFor === 'all' || (failFor && String(peer.id) === String(failFor))) {
        throw new Error('channel closed');
      }
      sent.push({ peer, message });
      return true;
    },
  };
}

const tests = [];
function queue(name, fn) { tests.push([name, fn]); }

// ---- buildEntryMessage / buildViewingMessage (pure wire helpers) ----

queue('buildEntryMessage: copies only shape metadata, never raw rows', () => {
  const m = buildEntryMessage({
    entry: { name: 'sales', originLanguage: 'python', kind: 'dataframe', rowCount: 42, provenance: 'p1', schema: [{ name: 'amt', type: 'DOUBLE' }], rows: [[1], [2]] },
    from: 'peer-1', ts: 100,
  });
  assert.equal(m.kind, 'object-entry');
  assert.equal(m.from, 'peer-1');
  assert.equal(m.ts, 100);
  assert.deepEqual(m.entry, {
    name: 'sales', originLanguage: 'python', kind: 'dataframe', rowCount: 42, provenance: 'p1', schema: [{ name: 'amt', type: 'DOUBLE' }],
  });
  assert.equal('rows' in m.entry, false); // raw rows never travel
});

queue('buildEntryMessage: tolerates a sparse entry with safe defaults', () => {
  const m = buildEntryMessage({ entry: { name: 'x' }, from: 'p', ts: 1 });
  assert.equal(m.entry.originLanguage, 'sql');
  assert.equal(m.entry.kind, 'dataframe');
  assert.equal(m.entry.rowCount, null);
  assert.deepEqual(m.entry.schema, []);
  assert.equal(m.entry.provenance, 'x');
});

queue('buildViewingMessage: an object name produces a viewing message', () => {
  const m = buildViewingMessage({ objectName: 'sales', from: 'p', ts: 7 });
  assert.deepEqual(m, { kind: 'viewing', from: 'p', ts: 7, objectName: 'sales' });
});

queue('buildViewingMessage: a null/empty name produces a viewing-clear message', () => {
  assert.equal(buildViewingMessage({ objectName: null, from: 'p', ts: 7 }).kind, 'viewing-clear');
  assert.equal(buildViewingMessage({ objectName: '', from: 'p', ts: 7 }).objectName, null);
});

queue('ROOM_MESSAGE_KINDS: the closed set the receiver accepts', () => {
  assert.deepEqual(ROOM_MESSAGE_KINDS, ['object-entry', 'viewing', 'viewing-clear']);
});

// ---- construction ----

queue('constructor: throws without a room', () => {
  assert.throws(() => new RoomBroadcastCoordinator({}));
});

queue('constructor: defaults to NULL_ROOM_TRANSPORT', () => {
  const c = new RoomBroadcastCoordinator({ room: fakeRoom() });
  assert.equal(c.transport, NULL_ROOM_TRANSPORT);
});

queue('isActive(): reflects the room.joined state', () => {
  assert.equal(new RoomBroadcastCoordinator({ room: fakeRoom({ joined: true }) }).isActive(), true);
  assert.equal(new RoomBroadcastCoordinator({ room: fakeRoom({ joined: false }) }).isActive(), false);
});

// ---- broadcastEntry: active vs no-room ----

queue('broadcastEntry: sends to every other peer when a Room is active', async () => {
  const transport = fakeTransport();
  const room = fakeRoom({ selfId: 'self', peers: [{ id: 'p1' }, { id: 'p2' }] });
  const c = new RoomBroadcastCoordinator({ room, transport, now: () => 500 });
  const res = await c.broadcastEntry({ name: 'sales', originLanguage: 'sql', schema: [{ name: 'amt', type: 'DOUBLE' }] });
  assert.equal(res.ok, true);
  assert.equal(res.delivered, 2);
  assert.equal(res.peers, 2);
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[0].message.kind, 'object-entry');
  assert.equal(transport.sent[0].message.entry.name, 'sales');
  assert.equal(transport.sent[0].message.from, 'self');
});

queue('broadcastEntry: excludes self from the peer list', async () => {
  const transport = fakeTransport();
  const room = fakeRoom({ selfId: 'self', peers: [{ id: 'p1' }, { id: 'self' }] });
  const c = new RoomBroadcastCoordinator({ room, transport });
  const res = await c.broadcastEntry({ name: 'x' });
  assert.equal(res.peers, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].peer.id, 'p1');
});

queue('broadcastEntry: NO-OP when no Room is active (never touches transport)', async () => {
  const transport = fakeTransport();
  const room = fakeRoom({ joined: false, peers: [{ id: 'p1' }] });
  const c = new RoomBroadcastCoordinator({ room, transport });
  const res = await c.broadcastEntry({ name: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-room');
  assert.equal(res.delivered, 0);
  assert.equal(transport.sent.length, 0);
});

queue('broadcastEntry: never throws when a single peer is unreachable (partial delivery)', async () => {
  const transport = fakeTransport({ failFor: 'p2' });
  const room = fakeRoom({ selfId: 'self', peers: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] });
  const c = new RoomBroadcastCoordinator({ room, transport });
  const res = await c.broadcastEntry({ name: 'x' });
  assert.equal(res.delivered, 2); // p1 + p3 succeed, p2 threw
  assert.equal(res.peers, 3);
  assert.equal(res.ok, true);
});

queue('broadcastEntry: never throws when the whole transport is down (delivered 0)', async () => {
  const transport = fakeTransport({ failFor: 'all' });
  const room = fakeRoom({ selfId: 'self', peers: [{ id: 'p1' }] });
  const c = new RoomBroadcastCoordinator({ room, transport });
  const res = await c.broadcastEntry({ name: 'x' });
  assert.equal(res.delivered, 0);
  assert.equal(res.ok, false);
});

queue('broadcastEntry: returns [] peers cleanly when signaling.listPeers throws', async () => {
  const transport = fakeTransport();
  const room = fakeRoom({ listThrows: true });
  const c = new RoomBroadcastCoordinator({ room, transport });
  const res = await c.broadcastEntry({ name: 'x' });
  assert.equal(res.peers, 0);
  assert.equal(res.delivered, 0);
});

queue('broadcastEntry: with the default NULL transport, delivers to nobody without throwing', async () => {
  const room = fakeRoom({ selfId: 'self', peers: [{ id: 'p1' }] });
  const c = new RoomBroadcastCoordinator({ room });
  const res = await c.broadcastEntry({ name: 'x' });
  assert.equal(res.delivered, 0);
  assert.equal(res.ok, false);
});

// ---- broadcastViewing ----

queue('broadcastViewing: sends a viewing message when active, no-op when not', async () => {
  const transport = fakeTransport();
  const room = fakeRoom({ selfId: 'self', peers: [{ id: 'p1' }] });
  const c = new RoomBroadcastCoordinator({ room, transport, now: () => 9 });
  const res = await c.broadcastViewing('sales');
  assert.equal(transport.sent[0].message.kind, 'viewing');
  assert.equal(transport.sent[0].message.objectName, 'sales');
  assert.equal(res.delivered, 1);

  const off = new RoomBroadcastCoordinator({ room: fakeRoom({ joined: false }), transport });
  assert.equal((await off.broadcastViewing('sales')).reason, 'no-room');
});

// ---- receive: object-entry ----

queue('receive: applies a remote object-entry into the injected Object Space', async () => {
  const objectSpace = createObjectSpace();
  let cbEntry = null;
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }), objectSpace, onRemoteEntry: (e) => { cbEntry = e; } });
  const msg = buildEntryMessage({ entry: { name: 'remote_df', originLanguage: 'r', kind: 'dataframe', rowCount: 3 }, from: 'p1', ts: 10 });
  const res = await c.receive(msg);
  assert.equal(res.applied, true);
  assert.equal(objectSpace.size, 1);
  assert.equal(objectSpace.get('remote_df').originLanguage, 'r');
  assert.equal(cbEntry.name, 'remote_df');
});

queue('receive: ignores a message that originated from ourselves', async () => {
  const objectSpace = createObjectSpace();
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }), objectSpace });
  const res = await c.receive(buildEntryMessage({ entry: { name: 'x' }, from: 'self', ts: 1 }));
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'self');
  assert.equal(objectSpace.size, 0);
});

queue('receive: ignores an unknown message kind, never throws', async () => {
  const c = new RoomBroadcastCoordinator({ room: fakeRoom() });
  const res = await c.receive({ kind: 'nonsense', from: 'p1' });
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'unknown-kind');
});

queue('receive: ignores a malformed object-entry (missing name), Object Space untouched', async () => {
  const objectSpace = createObjectSpace();
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }), objectSpace });
  const res = await c.receive({ kind: 'object-entry', from: 'p1', ts: 1, entry: { originLanguage: 'sql' } });
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'malformed');
  assert.equal(objectSpace.size, 0);
});

queue('receive: newest-write-wins — a stale/older update from the same peer is ignored', async () => {
  const objectSpace = createObjectSpace();
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }), objectSpace });
  await c.receive(buildEntryMessage({ entry: { name: 'df', rowCount: 5 }, from: 'p1', ts: 20 }));
  const stale = await c.receive(buildEntryMessage({ entry: { name: 'df', rowCount: 99 }, from: 'p1', ts: 10 }));
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(objectSpace.get('df').rowCount, 5); // the older update did not overwrite
  const newer = await c.receive(buildEntryMessage({ entry: { name: 'df', rowCount: 7 }, from: 'p1', ts: 30 }));
  assert.equal(newer.applied, true);
  assert.equal(objectSpace.get('df').rowCount, 7);
});

queue('receive: works with no objectSpace injected (fires callback only)', async () => {
  let fired = false;
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }), onRemoteEntry: () => { fired = true; } });
  const res = await c.receive(buildEntryMessage({ entry: { name: 'x' }, from: 'p1', ts: 1 }));
  assert.equal(res.applied, true);
  assert.equal(fired, true);
});

// ---- receive: viewing / who's-viewing map ----

queue('receive viewing: records a peer as viewing an object', async () => {
  let changed = null;
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }), onViewersChanged: (name, ids) => { changed = { name, ids }; } });
  const res = await c.receive(buildViewingMessage({ objectName: 'sales', from: 'p1', ts: 1 }));
  assert.equal(res.applied, true);
  assert.deepEqual(c.viewersOf('sales'), ['p1']);
  assert.deepEqual(c.objectsViewedBy('p1'), ['sales']);
  assert.deepEqual(changed, { name: 'sales', ids: ['p1'] });
});

queue('receive viewing: multiple peers viewing the same object accumulate', async () => {
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }) });
  await c.receive(buildViewingMessage({ objectName: 'sales', from: 'p1', ts: 1 }));
  await c.receive(buildViewingMessage({ objectName: 'sales', from: 'p2', ts: 1 }));
  await c.receive(buildViewingMessage({ objectName: 'costs', from: 'p1', ts: 1 }));
  assert.deepEqual(c.viewersOf('sales').sort(), ['p1', 'p2']);
  assert.deepEqual(c.objectsViewedBy('p1').sort(), ['costs', 'sales']);
  assert.deepEqual(c.viewingSnapshot(), { sales: ['p1', 'p2'], costs: ['p1'] });
});

queue('receive viewing: the same peer viewing twice is idempotent (a Set, not a list)', async () => {
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }) });
  await c.receive(buildViewingMessage({ objectName: 'sales', from: 'p1', ts: 1 }));
  await c.receive(buildViewingMessage({ objectName: 'sales', from: 'p1', ts: 2 }));
  assert.deepEqual(c.viewersOf('sales'), ['p1']);
});

queue('receive viewing-clear: drops a peer from every object it was viewing', async () => {
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }) });
  await c.receive(buildViewingMessage({ objectName: 'sales', from: 'p1', ts: 1 }));
  await c.receive(buildViewingMessage({ objectName: 'costs', from: 'p1', ts: 1 }));
  await c.receive(buildViewingMessage({ objectName: 'sales', from: 'p2', ts: 1 }));
  const res = await c.receive(buildViewingMessage({ objectName: null, from: 'p1', ts: 2 }));
  assert.equal(res.applied, true);
  assert.deepEqual(res.cleared.sort(), ['costs', 'sales']);
  assert.deepEqual(c.viewersOf('sales'), ['p2']); // p2 stays
  assert.deepEqual(c.viewersOf('costs'), []);
  assert.deepEqual(c.objectsViewedBy('p1'), []);
});

queue('forgetPeer: removes a departed peer from the viewing map', async () => {
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }) });
  await c.receive(buildViewingMessage({ objectName: 'sales', from: 'p1', ts: 1 }));
  c.forgetPeer('p1');
  assert.deepEqual(c.viewersOf('sales'), []);
});

queue('receive viewing: a malformed viewing message (no from) is ignored', async () => {
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ selfId: 'self' }) });
  const res = await c.receive({ kind: 'viewing', objectName: 'sales', ts: 1 });
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'malformed');
});

// ---- byte-for-byte: single-user Object Space is unchanged when no Room is open ----

queue('additive: an inactive coordinator never mutates the Object Space or the transport', async () => {
  // Baseline: what a plain single-user register produces, no Rooms involved.
  const baseline = createObjectSpace();
  const beforeEntry = baseline.register({ name: 'sales', originLanguage: 'sql', kind: 'dataframe', rowCount: 10, provenance: 'sales', createdAt: 111 });

  // Same registry + a broadcast coordinator with NO active Room. Broadcasting is
  // a no-op that must not touch the transport, and the registry state is byte-
  // for-byte what it was without the coordinator at all.
  const transport = fakeTransport();
  const c = new RoomBroadcastCoordinator({ room: fakeRoom({ joined: false, peers: [{ id: 'p1' }] }), transport, objectSpace: baseline });
  await c.broadcastEntry(beforeEntry);
  await c.broadcastViewing('sales');

  assert.equal(transport.sent.length, 0);
  assert.equal(baseline.size, 1);
  assert.deepEqual(baseline.get('sales'), {
    name: 'sales', originLanguage: 'sql', kind: 'dataframe', schema: [], rowCount: 10, provenance: 'sales', createdAt: 111,
  });
  assert.deepEqual(c.viewingSnapshot(), {}); // nothing broadcast, nothing tracked
});

// ---- transport adapter factory ----

queue('createRoomBroadcastTransport: falls back to NULL when no usable mesh', () => {
  assert.equal(createRoomBroadcastTransport({}), NULL_ROOM_TRANSPORT);
  assert.equal(createRoomBroadcastTransport({ mesh: { supported: false } }), NULL_ROOM_TRANSPORT);
});

queue('createRoomBroadcastTransport: wraps a supported mesh, mapping send -> exchange', async () => {
  let exchanged = null;
  const mesh = { supported: true, async exchange(peer, payload) { exchanged = { peer, payload }; return null; } };
  const t = createRoomBroadcastTransport({ mesh });
  assert.equal(t.supported, true);
  const ok = await t.send({ id: 'p1' }, { kind: 'object-entry' });
  assert.equal(ok, true);
  assert.deepEqual(exchanged.peer, { id: 'p1' });
});

queue('createRoomBroadcastTransport: send returns false (never throws) when exchange rejects', async () => {
  const mesh = { supported: true, async exchange() { throw new Error('no channel'); } };
  const t = createRoomBroadcastTransport({ mesh });
  assert.equal(await t.send({ id: 'p1' }, {}), false);
});

// ---- NULL_ROOM_TRANSPORT contract ----

queue('NULL_ROOM_TRANSPORT: send resolves false and it is unsupported', async () => {
  assert.equal(NULL_ROOM_TRANSPORT.supported, false);
  assert.equal(await NULL_ROOM_TRANSPORT.send(), false);
});

// ---- run ----
(async () => {
  for (const [name, fn] of tests) {
    await test(name, fn);
  }
  console.log(`\n${pass} passing, ${fail} failing`);
  if (fail > 0) process.exit(1);
})();
