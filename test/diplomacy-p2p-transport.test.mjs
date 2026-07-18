// test/diplomacy-p2p-transport.test.mjs
// Tests for js/diplomacy/diplomacy-p2p-transport.js (Batch 4)
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
  DIPLOMACY_CLAIM_MESSAGE_KIND,
  NULL_DIPLOMACY_TRANSPORT,
  buildClaimMessage,
  isValidClaimMessage,
  createDiplomacyP2PTransport,
} = await import('../js/diplomacy/diplomacy-p2p-transport.js');

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

// ---- DIPLOMACY_CLAIM_MESSAGE_KIND -----------------------------------------
test('DIPLOMACY_CLAIM_MESSAGE_KIND is "diplomacy-claim"', function() {
  strictEqual(DIPLOMACY_CLAIM_MESSAGE_KIND, 'diplomacy-claim');
});

// ---- NULL_DIPLOMACY_TRANSPORT ----------------------------------------------
test('null transport: supported is false', function() {
  strictEqual(NULL_DIPLOMACY_TRANSPORT.supported, false);
});

testAsync('null transport: sendClaim returns false', async function() {
  const r = await NULL_DIPLOMACY_TRANSPORT.sendClaim({ entityId: 'x' });
  strictEqual(r, false);
});

test('null transport: onReceiveClaim returns a no-op unsubscribe', function() {
  const unsub = NULL_DIPLOMACY_TRANSPORT.onReceiveClaim(function() {});
  strictEqual(typeof unsub, 'function');
});

// ---- buildClaimMessage -----------------------------------------------------
test('buildClaimMessage returns correct kind', function() {
  const msg = buildClaimMessage({ claim: { entityId: 'x' }, from: 'alice', ts: 1000 });
  strictEqual(msg.kind, 'diplomacy-claim');
});

test('buildClaimMessage echoes claim, from, ts', function() {
  const claim = { entityId: 'P001', field: 'dob', value: '1980-01-01', confidence: 0.95 };
  const msg = buildClaimMessage({ claim: claim, from: 'bob', ts: 1234567890 });
  deepEqual(msg.claim, claim);
  strictEqual(msg.from, 'bob');
  strictEqual(msg.ts, 1234567890);
});

test('buildClaimMessage defaults ts to a number when not provided', function() {
  const msg = buildClaimMessage({ claim: { entityId: 'x' }, from: null });
  strictEqual(typeof msg.ts, 'number');
});

test('buildClaimMessage coerces from to string', function() {
  const msg = buildClaimMessage({ claim: {}, from: 42 });
  strictEqual(msg.from, '42');
});

test('buildClaimMessage sets claim to null when claim is missing', function() {
  const msg = buildClaimMessage({ from: 'alice', ts: 100 });
  strictEqual(msg.claim, null);
});

// ---- isValidClaimMessage ---------------------------------------------------
test('isValidClaimMessage true for a well-formed message', function() {
  const msg = buildClaimMessage({ claim: { entityId: 'x' }, from: 'a', ts: 100 });
  strictEqual(isValidClaimMessage(msg), true);
});

test('isValidClaimMessage false when kind is wrong', function() {
  strictEqual(isValidClaimMessage({ kind: 'object-entry', claim: {} }), false);
});

test('isValidClaimMessage false when claim is null', function() {
  strictEqual(isValidClaimMessage({ kind: 'diplomacy-claim', claim: null }), false);
});

test('isValidClaimMessage false for non-object', function() {
  strictEqual(isValidClaimMessage(null), false);
  strictEqual(isValidClaimMessage('string'), false);
  strictEqual(isValidClaimMessage(42), false);
});

test('isValidClaimMessage false when claim is a string', function() {
  strictEqual(isValidClaimMessage({ kind: 'diplomacy-claim', claim: 'not an object' }), false);
});

// ---- createDiplomacyP2PTransport: null/invalid transport ------------------
test('null transport injection returns NULL_DIPLOMACY_TRANSPORT shape', function() {
  const t = createDiplomacyP2PTransport({ transport: null });
  strictEqual(t.supported, false);
});

test('missing send method returns null transport', function() {
  const t = createDiplomacyP2PTransport({ transport: { onReceive: function() {} } });
  strictEqual(t.supported, false);
});

test('missing onReceive method returns null transport', function() {
  const t = createDiplomacyP2PTransport({ transport: { send: async function() {} } });
  strictEqual(t.supported, false);
});

// ---- createDiplomacyP2PTransport: real transport --------------------------
testAsync('sendClaim sends a diplomacy-claim message', async function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake, selfId: 'alice' });
  await pt.sendClaim({ entityId: 'P001', field: 'dob', value: '1980-01-01' });
  strictEqual(fake.sentMessages.length, 1);
  strictEqual(fake.sentMessages[0].kind, 'diplomacy-claim');
});

testAsync('sendClaim sets from to selfId', async function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake, selfId: 'alice' });
  await pt.sendClaim({ entityId: 'P001' });
  strictEqual(fake.sentMessages[0].from, 'alice');
});

testAsync('sendClaim returns true when transport.send returns true', async function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake, selfId: 'alice' });
  const result = await pt.sendClaim({ entityId: 'P001' });
  strictEqual(result, true);
});

testAsync('sendClaim returns false for null/missing claim', async function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake, selfId: 'alice' });
  strictEqual(await pt.sendClaim(null), false);
  strictEqual(await pt.sendClaim(undefined), false);
});

testAsync('sendClaim returns false when transport.send throws', async function() {
  const badTransport = {
    send: async function() { throw new Error('network down'); },
    onReceive: function() { return function() {}; },
  };
  const pt = createDiplomacyP2PTransport({ transport: badTransport, selfId: 'alice' });
  const result = await pt.sendClaim({ entityId: 'P001' });
  strictEqual(result, false);
});

// ---- onReceiveClaim --------------------------------------------------------
test('onReceiveClaim fires handler when a valid claim message arrives', function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake, selfId: 'bob' });
  var received = [];
  pt.onReceiveClaim(function(msg) { received.push(msg); });
  const msg = buildClaimMessage({ claim: { entityId: 'P001' }, from: 'alice', ts: 100 });
  fake.simulate(msg);
  strictEqual(received.length, 1);
  strictEqual(received[0].kind, 'diplomacy-claim');
});

test('onReceiveClaim ignores non-claim messages', function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake });
  var received = [];
  pt.onReceiveClaim(function(msg) { received.push(msg); });
  fake.simulate({ kind: 'object-entry', entry: {} });
  fake.simulate({ kind: 'viewing', from: 'alice' });
  strictEqual(received.length, 0);
});

test('onReceiveClaim: multiple handlers all fire', function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake });
  var a = 0, b = 0;
  pt.onReceiveClaim(function() { a++; });
  pt.onReceiveClaim(function() { b++; });
  fake.simulate(buildClaimMessage({ claim: { entityId: 'x' }, from: 'alice', ts: 1 }));
  strictEqual(a, 1);
  strictEqual(b, 1);
});

test('onReceiveClaim: unsubscribe stops handler', function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake });
  var count = 0;
  var unsub = pt.onReceiveClaim(function() { count++; });
  fake.simulate(buildClaimMessage({ claim: { entityId: 'x' }, from: 'alice', ts: 1 }));
  unsub();
  fake.simulate(buildClaimMessage({ claim: { entityId: 'y' }, from: 'alice', ts: 2 }));
  strictEqual(count, 1);
});

test('onReceiveClaim: handler error does not abort other handlers', function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake });
  var reached = false;
  pt.onReceiveClaim(function() { throw new Error('handler crash'); });
  pt.onReceiveClaim(function() { reached = true; });
  fake.simulate(buildClaimMessage({ claim: { entityId: 'x' }, from: 'alice', ts: 1 }));
  strictEqual(reached, true);
});

test('onReceiveClaim: passing non-function returns no-op unsubscribe', function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake });
  const unsub = pt.onReceiveClaim('not a function');
  strictEqual(typeof unsub, 'function');
});

// ---- destroy ---------------------------------------------------------------
test('destroy clears all handlers', function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake });
  var count = 0;
  pt.onReceiveClaim(function() { count++; });
  pt.destroy();
  fake.simulate(buildClaimMessage({ claim: { entityId: 'x' }, from: 'alice', ts: 1 }));
  strictEqual(count, 0);
});

// ---- supported flag --------------------------------------------------------
test('created transport has supported:true when real transport injected', function() {
  const fake = makeFakeTransport();
  const pt = createDiplomacyP2PTransport({ transport: fake });
  strictEqual(pt.supported, true);
});

// ---- summary ---------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
