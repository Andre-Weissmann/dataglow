// test/live-rooms-broadcast.test.mjs
// Tests for js/agents/live-rooms-broadcast.js (Live Rooms Batch 2)
// Node-only: pure adapter logic, in-memory fake transport.

import { ok, strictEqual, deepEqual } from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 FAILED: ' + name + '\n    ' + e.message); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 FAILED: ' + name + '\n    ' + e.message); failed++; }
}

const {
  LIVE_ACTION_ITEMS_MESSAGE_KIND,
  NULL_LIVE_ROOMS_BROADCAST,
  buildActionItemsMessage,
  isValidActionItemsMessage,
  createLiveRoomsBroadcast,
} = await import('../js/agents/live-rooms-broadcast.js');

// ---- in-memory fake transport (mirrors room-broadcast.js test pattern) ----
function makeFakeTransport() {
  var handlers = [];
  var sent = [];
  return {
    send: async function(msg) { sent.push(msg); return true; },
    onReceive: function(fn) { handlers.push(fn); return function() { handlers = handlers.filter(function(h) { return h !== fn; }); }; },
    simulate: function(msg) { handlers.forEach(function(h) { h(msg); }); },
    sentMessages: sent,
  };
}

const SAMPLE_ITEMS = [
  { text: 'Follow up on churn cohort', ts: 100, owner: null, dueDate: null, outcome: null, status: 'open' },
  { text: 'Pull Q3 revenue by region', ts: 200, owner: null, dueDate: null, outcome: null, status: 'open' },
];

// ---- LIVE_ACTION_ITEMS_MESSAGE_KIND ---------------------------------------
test('LIVE_ACTION_ITEMS_MESSAGE_KIND is "live-action-items"', function() {
  strictEqual(LIVE_ACTION_ITEMS_MESSAGE_KIND, 'live-action-items');
});

// ---- NULL_LIVE_ROOMS_BROADCAST --------------------------------------------
test('null broadcast: supported is false', function() {
  strictEqual(NULL_LIVE_ROOMS_BROADCAST.supported, false);
});

testAsync('null broadcast: broadcastActionItems returns false', async function() {
  const r = await NULL_LIVE_ROOMS_BROADCAST.broadcastActionItems(SAMPLE_ITEMS, 'm1');
  strictEqual(r, false);
});

test('null broadcast: onReceiveActionItems returns a no-op unsubscribe', function() {
  const unsub = NULL_LIVE_ROOMS_BROADCAST.onReceiveActionItems(function() {});
  strictEqual(typeof unsub, 'function');
});

test('null broadcast: destroy never throws', function() {
  NULL_LIVE_ROOMS_BROADCAST.destroy();
  ok(true);
});

// ---- buildActionItemsMessage ----------------------------------------------
test('buildActionItemsMessage returns correct kind', function() {
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, meetingId: 'm1', from: 'alice', ts: 1000 });
  strictEqual(msg.kind, 'live-action-items');
});

test('buildActionItemsMessage echoes actionItems, meetingId, from, ts', function() {
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, meetingId: 'm1', from: 'bob', ts: 1234567890 });
  deepEqual(msg.actionItems, SAMPLE_ITEMS);
  strictEqual(msg.meetingId, 'm1');
  strictEqual(msg.from, 'bob');
  strictEqual(msg.ts, 1234567890);
});

test('buildActionItemsMessage defaults ts to a number when not provided', function() {
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, meetingId: 'm1', from: null });
  strictEqual(typeof msg.ts, 'number');
});

test('buildActionItemsMessage coerces from to string', function() {
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, from: 42 });
  strictEqual(msg.from, '42');
});

test('buildActionItemsMessage sets from to null when missing', function() {
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS });
  strictEqual(msg.from, null);
});

test('buildActionItemsMessage sets meetingId to null when missing', function() {
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS });
  strictEqual(msg.meetingId, null);
});

test('buildActionItemsMessage returns null for empty actionItems array', function() {
  strictEqual(buildActionItemsMessage({ actionItems: [], meetingId: 'm1' }), null);
});

test('buildActionItemsMessage returns null when actionItems is missing', function() {
  strictEqual(buildActionItemsMessage({ meetingId: 'm1' }), null);
});

test('buildActionItemsMessage returns null when actionItems is not an array', function() {
  strictEqual(buildActionItemsMessage({ actionItems: 'nope' }), null);
});

test('buildActionItemsMessage copies the array (not a reference)', function() {
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS });
  ok(msg.actionItems !== SAMPLE_ITEMS);
  deepEqual(msg.actionItems, SAMPLE_ITEMS);
});

test('buildActionItemsMessage with no args returns null (never throws)', function() {
  strictEqual(buildActionItemsMessage(), null);
});

// ---- isValidActionItemsMessage --------------------------------------------
test('isValidActionItemsMessage true for a well-formed message', function() {
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, meetingId: 'm1', from: 'a', ts: 100 });
  strictEqual(isValidActionItemsMessage(msg), true);
});

test('isValidActionItemsMessage true for empty-array actionItems on receive', function() {
  strictEqual(isValidActionItemsMessage({ kind: 'live-action-items', actionItems: [] }), true);
});

test('isValidActionItemsMessage false when kind is wrong', function() {
  strictEqual(isValidActionItemsMessage({ kind: 'object-entry', actionItems: [] }), false);
});

test('isValidActionItemsMessage false when actionItems is null', function() {
  strictEqual(isValidActionItemsMessage({ kind: 'live-action-items', actionItems: null }), false);
});

test('isValidActionItemsMessage false when actionItems is missing', function() {
  strictEqual(isValidActionItemsMessage({ kind: 'live-action-items' }), false);
});

test('isValidActionItemsMessage false when actionItems is not an array', function() {
  strictEqual(isValidActionItemsMessage({ kind: 'live-action-items', actionItems: {} }), false);
});

test('isValidActionItemsMessage false for non-object', function() {
  strictEqual(isValidActionItemsMessage(null), false);
  strictEqual(isValidActionItemsMessage('string'), false);
  strictEqual(isValidActionItemsMessage(42), false);
  strictEqual(isValidActionItemsMessage(undefined), false);
});

// ---- createLiveRoomsBroadcast: null/invalid transport ---------------------
test('null transport injection returns NULL_LIVE_ROOMS_BROADCAST shape', function() {
  const t = createLiveRoomsBroadcast({ transport: null });
  strictEqual(t.supported, false);
});

test('missing send method returns null broadcast', function() {
  const t = createLiveRoomsBroadcast({ transport: { onReceive: function() {} } });
  strictEqual(t.supported, false);
});

test('missing onReceive method returns null broadcast', function() {
  const t = createLiveRoomsBroadcast({ transport: { send: async function() {} } });
  strictEqual(t.supported, false);
});

test('createLiveRoomsBroadcast with no opts returns null broadcast', function() {
  const t = createLiveRoomsBroadcast();
  strictEqual(t.supported, false);
});

// ---- createLiveRoomsBroadcast: real transport -----------------------------
testAsync('broadcastActionItems sends a live-action-items message', async function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake, selfId: 'alice' });
  await b.broadcastActionItems(SAMPLE_ITEMS, 'm1');
  strictEqual(fake.sentMessages.length, 1);
  strictEqual(fake.sentMessages[0].kind, 'live-action-items');
});

testAsync('broadcastActionItems sets from to selfId and meetingId', async function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake, selfId: 'alice' });
  await b.broadcastActionItems(SAMPLE_ITEMS, 'meeting-42');
  strictEqual(fake.sentMessages[0].from, 'alice');
  strictEqual(fake.sentMessages[0].meetingId, 'meeting-42');
});

testAsync('broadcastActionItems returns true when transport.send returns true', async function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake, selfId: 'alice' });
  const result = await b.broadcastActionItems(SAMPLE_ITEMS, 'm1');
  strictEqual(result, true);
});

testAsync('broadcastActionItems returns false for empty items (nothing sent)', async function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake, selfId: 'alice' });
  strictEqual(await b.broadcastActionItems([], 'm1'), false);
  strictEqual(await b.broadcastActionItems(null, 'm1'), false);
  strictEqual(fake.sentMessages.length, 0);
});

testAsync('broadcastActionItems returns false when transport.send throws (never throws)', async function() {
  const badTransport = {
    send: async function() { throw new Error('network down'); },
    onReceive: function() { return function() {}; },
  };
  const b = createLiveRoomsBroadcast({ transport: badTransport, selfId: 'alice' });
  const result = await b.broadcastActionItems(SAMPLE_ITEMS, 'm1');
  strictEqual(result, false);
});

testAsync('broadcastActionItems returns false when transport.send returns false', async function() {
  const t = {
    send: async function() { return false; },
    onReceive: function() { return function() {}; },
  };
  const b = createLiveRoomsBroadcast({ transport: t, selfId: 'alice' });
  strictEqual(await b.broadcastActionItems(SAMPLE_ITEMS, 'm1'), false);
});

// ---- onReceiveActionItems -------------------------------------------------
test('onReceiveActionItems fires handler when a valid message arrives', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake, selfId: 'bob' });
  var received = [];
  b.onReceiveActionItems(function(msg) { received.push(msg); });
  const msg = buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, meetingId: 'm1', from: 'alice', ts: 100 });
  fake.simulate(msg);
  strictEqual(received.length, 1);
  strictEqual(received[0].kind, 'live-action-items');
  deepEqual(received[0].actionItems, SAMPLE_ITEMS);
});

test('onReceiveActionItems ignores non-action-items messages', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake });
  var received = [];
  b.onReceiveActionItems(function(msg) { received.push(msg); });
  fake.simulate({ kind: 'object-entry', entry: {} });
  fake.simulate({ kind: 'viewing', from: 'alice' });
  fake.simulate({ kind: 'live-action-items', actionItems: null });
  strictEqual(received.length, 0);
});

test('onReceiveActionItems: multiple handlers all fire', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake });
  var a = 0, c = 0;
  b.onReceiveActionItems(function() { a++; });
  b.onReceiveActionItems(function() { c++; });
  fake.simulate(buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, from: 'alice', ts: 1 }));
  strictEqual(a, 1);
  strictEqual(c, 1);
});

test('onReceiveActionItems: unsubscribe stops handler', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake });
  var count = 0;
  var unsub = b.onReceiveActionItems(function() { count++; });
  fake.simulate(buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, from: 'alice', ts: 1 }));
  unsub();
  fake.simulate(buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, from: 'alice', ts: 2 }));
  strictEqual(count, 1);
});

test('onReceiveActionItems: handler error does not abort other handlers', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake });
  var reached = false;
  b.onReceiveActionItems(function() { throw new Error('handler crash'); });
  b.onReceiveActionItems(function() { reached = true; });
  fake.simulate(buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, from: 'alice', ts: 1 }));
  strictEqual(reached, true);
});

test('onReceiveActionItems: passing non-function returns no-op unsubscribe', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake });
  const unsub = b.onReceiveActionItems('not a function');
  strictEqual(typeof unsub, 'function');
});

// ---- destroy --------------------------------------------------------------
test('destroy clears all handlers', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake });
  var count = 0;
  b.onReceiveActionItems(function() { count++; });
  b.destroy();
  fake.simulate(buildActionItemsMessage({ actionItems: SAMPLE_ITEMS, from: 'alice', ts: 1 }));
  strictEqual(count, 0);
});

test('destroy never throws', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake });
  b.destroy();
  ok(true);
});

// ---- supported flag -------------------------------------------------------
test('created broadcast has supported:true when real transport injected', function() {
  const fake = makeFakeTransport();
  const b = createLiveRoomsBroadcast({ transport: fake });
  strictEqual(b.supported, true);
});

// ---- summary --------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
