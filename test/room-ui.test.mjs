// ============================================================
// DATAGLOW — Tests: Rooms topbar UI layer (Rooms Batch 3)
// ============================================================
// Plain node, no DOM/DuckDB/network needed — this batch's testable surface is
// the PURE view-model builders (buildRoomPillModel / buildPresenceModel /
// buildRemoteEntryToast) plus the peerInitials/avatarColor helpers and the
// notifyRemoteEntry toast composer, exactly like glow-signal.test.mjs tests the
// pure aggregator behind glow-orb-ui.js. The DOM renderer (renderRoomUi) is left
// to the browser/e2e path, same as glow-orb-ui.js's renderer. These builders
// only PRESENT the Room state Batches 1 & 2 already returned — they invent no
// Room concept, no signaling, and no broadcast payload of their own.

import assert from 'node:assert/strict';
import {
  buildRoomPillModel, buildPresenceModel, buildRemoteEntryToast,
  peerInitials, avatarColor, notifyRemoteEntry,
} from '../js/rooms/room-ui.js';

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

const tests = [];
function queue(name, fn) { tests.push([name, fn]); }

// ---- peerInitials ----

queue('peerInitials: two words -> first letter of each, uppercased', () => {
  assert.equal(peerInitials({ displayName: 'Ada Lovelace' }), 'AL');
});

queue('peerInitials: one word -> up to first two letters', () => {
  assert.equal(peerInitials({ displayName: 'Grace' }), 'GR');
});

queue('peerInitials: three+ words -> only the first two', () => {
  assert.equal(peerInitials({ displayName: 'Jean Baptiste Zorg' }), 'JB');
});

queue('peerInitials: no name -> falls back to leading alphanumerics of id', () => {
  assert.equal(peerInitials({ id: 'peer-42' }), 'PE');
});

queue('peerInitials: nameless + idless peer -> "?" (never throws)', () => {
  assert.equal(peerInitials({}), '?');
  assert.equal(peerInitials(null), '?');
  assert.equal(peerInitials(undefined), '?');
});

// ---- avatarColor ----

queue('avatarColor: deterministic for the same seed', () => {
  assert.equal(avatarColor('peer-1'), avatarColor('peer-1'));
});

queue('avatarColor: always returns one of the fixed palette hexes', () => {
  const palette = ['#FF6B6B', '#2e7d32', '#1565c0', '#b8860b', '#6a1b9a', '#00838f'];
  for (const seed of ['a', 'peer-9', 'Ada Lovelace', '', '12345', 'zzz']) {
    assert.ok(palette.includes(avatarColor(seed)), `unexpected color for ${seed}`);
  }
});

queue('avatarColor: null/undefined seed never throws', () => {
  assert.ok(typeof avatarColor(null) === 'string');
  assert.ok(typeof avatarColor(undefined) === 'string');
});

// ---- buildRoomPillModel ----

queue('buildRoomPillModel: unsupported WebRTC -> honest unavailable state, no action', () => {
  const m = buildRoomPillModel({ supported: false });
  assert.equal(m.state, 'unsupported');
  assert.equal(m.actionKind, 'none');
  assert.equal(m.roomCode, null);
});

queue('buildRoomPillModel: not joined -> idle "Start a Room" affordance', () => {
  const m = buildRoomPillModel({ joined: false });
  assert.equal(m.state, 'idle');
  assert.equal(m.actionKind, 'start');
  assert.equal(m.actionLabel, 'Start a Room');
  assert.equal(m.roomCode, null);
});

queue('buildRoomPillModel: joined with a code -> shows the code + a Leave action', () => {
  const m = buildRoomPillModel({ joined: true, roomCode: 'ABCD-EFGH-JKMN' });
  assert.equal(m.state, 'joined');
  assert.equal(m.label, 'ABCD-EFGH-JKMN');
  assert.equal(m.roomCode, 'ABCD-EFGH-JKMN');
  assert.equal(m.actionKind, 'leave');
  assert.equal(m.actionLabel, 'Leave');
});

queue('buildRoomPillModel: joined:true but no code -> falls back to idle (never a blank code)', () => {
  const m = buildRoomPillModel({ joined: true, roomCode: null });
  assert.equal(m.state, 'idle');
  assert.equal(m.actionKind, 'start');
});

queue('buildRoomPillModel: defaults (no args) -> supported + idle, never throws', () => {
  const m = buildRoomPillModel();
  assert.equal(m.state, 'idle');
});

// ---- buildPresenceModel ----

queue('buildPresenceModel: empty peer list -> count 0 + honest "no one else" summary', () => {
  const m = buildPresenceModel({ peers: [] });
  assert.equal(m.count, 0);
  assert.equal(m.summaryLabel, 'No one else here yet');
  assert.deepEqual(m.badges, []);
});

queue('buildPresenceModel: one/many peer pluralization', () => {
  assert.equal(buildPresenceModel({ peers: [{ id: 'p1' }] }).summaryLabel, '1 peer');
  assert.equal(buildPresenceModel({ peers: [{ id: 'p1' }, { id: 'p2' }] }).summaryLabel, '2 peers');
});

queue('buildPresenceModel: a badge carries initials, a stable color, and role in its title', () => {
  const m = buildPresenceModel({ peers: [{ id: 'p1', displayName: 'Ada Lovelace', role: 'Analyst' }] });
  assert.equal(m.badges.length, 1);
  const b = m.badges[0];
  assert.equal(b.id, 'p1');
  assert.equal(b.initials, 'AL');
  assert.equal(b.displayName, 'Ada Lovelace');
  assert.equal(b.role, 'Analyst');
  assert.equal(b.color, avatarColor('Ada Lovelace'));
  assert.ok(b.title.includes('Ada Lovelace'));
  assert.ok(b.title.includes('Analyst'));
});

queue('buildPresenceModel: composes Batch 2 who\'s-viewing into each badge', () => {
  const m = buildPresenceModel({
    peers: [{ id: 'p1', displayName: 'Ada' }, { id: 'p2', displayName: 'Bo' }],
    viewingSnapshot: { sales: ['p1', 'p2'], costs: ['p1'] },
  });
  const ada = m.badges.find(b => b.id === 'p1');
  const bo = m.badges.find(b => b.id === 'p2');
  assert.deepEqual(ada.viewing, ['costs', 'sales']); // sorted
  assert.deepEqual(bo.viewing, ['sales']);
  assert.ok(ada.title.includes('viewing costs, sales'));
});

queue('buildPresenceModel: a nameless peer still gets a badge (id-derived initials, "Peer <id>" title)', () => {
  const m = buildPresenceModel({ peers: [{ id: 'peer-7' }] });
  assert.equal(m.badges[0].initials, 'PE');
  assert.equal(m.badges[0].displayName, null);
  assert.ok(m.badges[0].title.includes('Peer peer-7'));
});

queue('buildPresenceModel: peers without an id are skipped; malformed input never throws', () => {
  const m = buildPresenceModel({ peers: [{ displayName: 'no id' }, null, { id: 'p1' }] });
  assert.equal(m.count, 1);
  assert.equal(m.badges[0].id, 'p1');
  assert.doesNotThrow(() => buildPresenceModel(null));
  assert.doesNotThrow(() => buildPresenceModel());
});

// ---- buildRemoteEntryToast ----

queue('buildRemoteEntryToast: resolves the sender name from the peer list', () => {
  const t = buildRemoteEntryToast({
    entry: { name: 'sales', originLanguage: 'python' },
    from: 'p1',
    peers: [{ id: 'p1', displayName: 'Ada' }],
  });
  assert.equal(t.type, 'success');
  assert.equal(t.message, 'Ada shared "sales" (PYTHON)');
});

queue('buildRemoteEntryToast: unknown sender -> "Peer <id>" fallback', () => {
  const t = buildRemoteEntryToast({ entry: { name: 'x' }, from: 'p9', peers: [] });
  assert.equal(t.message, 'Peer p9 shared "x"');
});

queue('buildRemoteEntryToast: no entry name -> null (nothing to announce)', () => {
  assert.equal(buildRemoteEntryToast({ entry: {}, from: 'p1' }), null);
  assert.equal(buildRemoteEntryToast({ from: 'p1' }), null);
  assert.equal(buildRemoteEntryToast(), null);
});

queue('buildRemoteEntryToast: missing originLanguage -> no language suffix', () => {
  const t = buildRemoteEntryToast({ entry: { name: 'df' }, from: 'p1', peers: [{ id: 'p1', displayName: 'Bo' }] });
  assert.equal(t.message, 'Bo shared "df"');
});

// ---- notifyRemoteEntry (toast composer) ----

queue('notifyRemoteEntry: fires the injected toast with the built message + type', () => {
  const calls = [];
  const t = notifyRemoteEntry({
    entry: { name: 'sales', originLanguage: 'r' },
    from: 'p1',
    peers: [{ id: 'p1', displayName: 'Ada' }],
    toast: (msg, type) => calls.push([msg, type]),
  });
  assert.deepEqual(calls, [['Ada shared "sales" (R)', 'success']]);
  assert.equal(t.message, 'Ada shared "sales" (R)');
});

queue('notifyRemoteEntry: nothing to announce -> no toast fired, returns null', () => {
  let fired = false;
  const t = notifyRemoteEntry({ entry: {}, from: 'p1', toast: () => { fired = true; } });
  assert.equal(fired, false);
  assert.equal(t, null);
});

queue('notifyRemoteEntry: default no-op toast + a throwing toast both never bubble', () => {
  assert.doesNotThrow(() => notifyRemoteEntry({ entry: { name: 'x' }, from: 'p1' }));
  assert.doesNotThrow(() => notifyRemoteEntry({
    entry: { name: 'x' }, from: 'p1', toast: () => { throw new Error('boom'); },
  }));
});

// ---- run ----
(async () => {
  for (const [name, fn] of tests) {
    await test(name, fn);
  }
  console.log(`\n${pass} passing, ${fail} failing`);
  if (fail > 0) process.exit(1);
})();
