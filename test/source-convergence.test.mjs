// ============================================================
// DATAGLOW — Tests: Source Convergence (Batch 1 of 3)
// ============================================================
// Plain node, no DOM/DuckDB/network needed — js/validation/source-convergence.js
// is pure JS over arrays of row objects, exactly like test/room-signaling.test.mjs
// tests the pure Rooms Batch 1 module. Covers the N-way join graph (including a
// TRANSITIVE A–B–C join where A and C share no direct key), coverage patterns,
// a trust-resolved conflict (clear margin) and an escalated one (the mockup's
// $412.00 vs $398.50 / trust 0.75 vs 0.65 case), plus the never-throws contract.
//
// RUN WITH:  node test/source-convergence.test.mjs

import assert from 'node:assert/strict';
import {
  buildConvergenceGraph,
  computeConvergenceClusters,
  resolveClusterWithTrust,
  summarizeConvergence,
  canonicalizeKey,
  normalizeValue,
  DEFAULT_MARGIN_THRESHOLD,
} from '../js/validation/source-convergence.js';

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

// ---- pure helpers ----

test('DEFAULT_MARGIN_THRESHOLD is 0.15 (matches the mockup)', () => {
  assert.equal(DEFAULT_MARGIN_THRESHOLD, 0.15);
});

test('canonicalizeKey: string -> [col], composite -> sorted cols, junk -> null', () => {
  assert.deepEqual(canonicalizeKey('claim_id'), ['claim_id']);
  assert.deepEqual(canonicalizeKey(['patient_id', 'date_of_service']), ['date_of_service', 'patient_id']);
  assert.deepEqual(canonicalizeKey(['date_of_service', 'patient_id']), ['date_of_service', 'patient_id']);
  assert.equal(canonicalizeKey(''), null);
  assert.equal(canonicalizeKey(42), null);
  assert.equal(canonicalizeKey([]), null);
});

test('normalizeValue: numeric strings and numbers converge; blanks -> null', () => {
  assert.equal(normalizeValue('412.00'), normalizeValue(412));
  assert.notEqual(normalizeValue('412.00'), normalizeValue('398.50'));
  assert.equal(normalizeValue(' Foo '), normalizeValue('foo'));
  assert.equal(normalizeValue(null), null);
  assert.equal(normalizeValue('   '), null);
});

// ---- Scenario 1: N-way join graph with a transitive join ----
// A joins B on claim_id; B joins C on (patient_id, date_of_service). A and C
// share NO direct key, but are reachable transitively through B.

const transitiveSources = [
  { id: 'A', rows: [{ claim_id: 'C1', amt: 100 }], possibleKeys: ['claim_id'] },
  { id: 'B', rows: [{ claim_id: 'C1', patient_id: 'P1', date_of_service: '2026-01-01' }], possibleKeys: ['claim_id', ['patient_id', 'date_of_service']] },
  { id: 'C', rows: [{ patient_id: 'P1', date_of_service: '2026-01-01', elig: 'Y' }], possibleKeys: [['date_of_service', 'patient_id']] },
];

test('buildConvergenceGraph: direct edges A–B and B–C, none A–C', () => {
  const g = buildConvergenceGraph(transitiveSources);
  assert.equal(g.evaluated, true);
  assert.deepEqual(g.sources, ['A', 'B', 'C']);
  const pairs = g.edges.map(e => `${e.a}-${e.b}`).sort();
  assert.deepEqual(pairs, ['A-B', 'B-C']);
  assert.ok(!pairs.includes('A-C'));
});

test('buildConvergenceGraph: transitive reachability puts A, B, C in one component', () => {
  const g = buildConvergenceGraph(transitiveSources);
  assert.equal(g.components.length, 1);
  assert.deepEqual(g.components[0], ['A', 'B', 'C']);
});

test('computeConvergenceClusters: one cluster spans all 3 sources via the transitive chain', () => {
  const g = buildConvergenceGraph(transitiveSources);
  const clusters = computeConvergenceClusters(g, transitiveSources);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].sourceIds, ['A', 'B', 'C']);
  assert.equal(clusters[0].coverageCount, 3);
  assert.equal(clusters[0].hasConflict, false); // shared columns all agree
});

// ---- Scenario 2: coverage pattern (present in some sources, absent in others) ----

test('coverage pattern: a cluster reports exactly which sources contain it', () => {
  const sources = [
    { id: 'roster', rows: [{ claim_id: 'C1', member: 'Alice' }, { claim_id: 'C2', member: 'Bob' }], possibleKeys: ['claim_id'] },
    { id: 'cms', rows: [{ claim_id: 'C1', member: 'Alice' }], possibleKeys: ['claim_id'] },
  ];
  const g = buildConvergenceGraph(sources);
  const clusters = computeConvergenceClusters(g, sources);
  const byCoverage = clusters.map(c => c.sourceIds.join(',')).sort();
  // C1 present in both; C2 present only in roster.
  assert.deepEqual(byCoverage, ['roster', 'cms,roster'].sort());
  const c1 = clusters.find(c => c.coverageCount === 2);
  assert.deepEqual(c1.sourceIds, ['cms', 'roster']);
  const c2 = clusters.find(c => c.coverageCount === 1);
  assert.deepEqual(c2.sourceIds, ['roster']);
});

// ---- Scenario 3: trust-resolved conflict (clear margin winner) ----

test('resolveClusterWithTrust: clear trust margin picks the winning value', () => {
  const sources = [
    { id: 'A', rows: [{ id: 'X', paid: 500 }], possibleKeys: ['id'] },
    { id: 'B', rows: [{ id: 'X', paid: 450 }], possibleKeys: ['id'] },
  ];
  const g = buildConvergenceGraph(sources);
  const [cluster] = computeConvergenceClusters(g, sources);
  const paidConflict = cluster.conflicts.find(f => f.column === 'paid');
  assert.ok(paidConflict, 'paid should be flagged as a conflict');
  assert.equal(paidConflict.status, 'conflict');

  const res = resolveClusterWithTrust(cluster, { A: 0.9, B: 0.6 }, { marginThreshold: 0.15 });
  assert.equal(res.escalated, false);
  assert.equal(res.resolvedCount, 1);
  const paid = res.resolutions.find(r => r.column === 'paid');
  assert.equal(paid.resolved, true);
  assert.equal(paid.value, 500);
  assert.equal(paid.winningSource, 'A');
  assert.ok(Math.abs(paid.margin - 0.3) < 1e-9);
});

// ---- Scenario 4: escalated conflict (matches the mockup) ----
// Roster·Adj (trust 0.75) says $412.00; CMS Elig. (trust 0.65) says $398.50.
// Margin 0.10 < 0.15 threshold -> escalate, no auto-resolution.

test('resolveClusterWithTrust: sub-threshold margin escalates (mockup $412.00 vs $398.50)', () => {
  const sources = [
    { id: 'Roster·Adj', rows: [{ member_id: 'M1', allowed_amt: '412.00' }], possibleKeys: ['member_id'] },
    { id: 'CMS Elig.', rows: [{ member_id: 'M1', allowed_amt: '398.50' }], possibleKeys: ['member_id'] },
  ];
  const g = buildConvergenceGraph(sources);
  const [cluster] = computeConvergenceClusters(g, sources);
  const res = resolveClusterWithTrust(cluster, { 'Roster·Adj': 0.75, 'CMS Elig.': 0.65 });
  assert.equal(res.escalated, true);
  assert.equal(res.escalatedCount, 1);
  const amt = res.resolutions.find(r => r.column === 'allowed_amt');
  assert.equal(amt.resolved, false);
  assert.equal(amt.reason, 'trust margin below threshold');
  assert.ok(Math.abs(amt.margin - 0.10) < 1e-9);
  assert.match(amt.rationale, /escalating for human review/);
});

// ---- summarizeConvergence ----

test('summarizeConvergence: counts joined clusters, auto-resolved vs human-needed', () => {
  const clusters = [
    { coverageCount: 2, hasConflict: true, resolution: { escalated: false } },
    { coverageCount: 2, hasConflict: true, resolution: { escalated: true } },
    { coverageCount: 2, hasConflict: false },
    { coverageCount: 1, hasConflict: false },
  ];
  const s = summarizeConvergence(clusters);
  assert.equal(s.joinedClusters, 3);
  assert.equal(s.needsHuman, 1);
  assert.equal(s.autoResolved, 1);
  assert.equal(s.text, '1 of 3 joined clusters need a human decision — 1 auto-resolved by trust weight.');
});

test('summarizeConvergence: thousands separators match the mockup headline', () => {
  const clusters = [];
  for (let i = 0; i < 2946; i++) clusters.push({ coverageCount: 2, hasConflict: true, resolution: { escalated: false } });
  for (let i = 0; i < 41; i++) clusters.push({ coverageCount: 2, hasConflict: true, resolution: { escalated: true } });
  const s = summarizeConvergence(clusters);
  assert.equal(s.text, '41 of 2,987 joined clusters need a human decision — 2,946 auto-resolved by trust weight.');
});

// ---- Edge cases: never throws ----

test('buildConvergenceGraph: empty / malformed input returns a safe idle result', () => {
  for (const bad of [undefined, null, [], 'x', 42, [{}], [{ id: 'A' }], [{ id: 'A', rows: 'no', possibleKeys: [] }]]) {
    let g;
    assert.doesNotThrow(() => { g = buildConvergenceGraph(bad); });
    assert.equal(g.evaluated, false);
    assert.deepEqual(g.edges, []);
    assert.deepEqual(g.sources, []);
    assert.equal(typeof g.reason, 'string');
  }
});

test('buildConvergenceGraph: duplicate source ids are rejected as idle', () => {
  const g = buildConvergenceGraph([
    { id: 'A', rows: [], possibleKeys: ['x'] },
    { id: 'A', rows: [], possibleKeys: ['x'] },
  ]);
  assert.equal(g.evaluated, false);
  assert.match(g.reason, /duplicate source id/);
});

test('no shared keys at all: graph evaluates with no edges, singleton components', () => {
  const sources = [
    { id: 'A', rows: [{ a: 1 }], possibleKeys: ['a'] },
    { id: 'B', rows: [{ b: 2 }], possibleKeys: ['b'] },
  ];
  const g = buildConvergenceGraph(sources);
  assert.equal(g.evaluated, true);
  assert.deepEqual(g.edges, []);
  assert.equal(g.components.length, 2);
  const clusters = computeConvergenceClusters(g, sources);
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every(c => c.coverageCount === 1 && !c.hasConflict));
});

test('computeConvergenceClusters: idle graph or bad sources return [] (never throws)', () => {
  assert.deepEqual(computeConvergenceClusters(buildConvergenceGraph(null), null), []);
  assert.deepEqual(computeConvergenceClusters({ evaluated: false }, []), []);
  const g = buildConvergenceGraph(transitiveSources);
  assert.deepEqual(computeConvergenceClusters(g, 'not-an-array'), []);
  assert.deepEqual(computeConvergenceClusters(g, [{ id: 'A', rows: 'bad' }]), []);
});

test('resolveClusterWithTrust: malformed trust map escalates, never throws', () => {
  const sources = [
    { id: 'A', rows: [{ id: 'X', v: 1 }], possibleKeys: ['id'] },
    { id: 'B', rows: [{ id: 'X', v: 2 }], possibleKeys: ['id'] },
  ];
  const [cluster] = computeConvergenceClusters(buildConvergenceGraph(sources), sources);
  for (const badTrust of [undefined, null, 'x', 42, {}, { A: 'high' }, { A: 0.9 }]) {
    let res;
    assert.doesNotThrow(() => { res = resolveClusterWithTrust(cluster, badTrust); });
    assert.equal(res.escalated, true);
    const v = res.resolutions.find(r => r.column === 'v');
    assert.equal(v.resolved, false);
    assert.equal(v.reason, 'insufficient trust signal');
  }
});

test('resolveClusterWithTrust: junk cluster input returns a safe empty result', () => {
  for (const bad of [undefined, null, 'x', 42, {}, { conflicts: 'no' }]) {
    let res;
    assert.doesNotThrow(() => { res = resolveClusterWithTrust(bad, { A: 0.9 }); });
    assert.equal(res.escalated, false);
    assert.deepEqual(res.resolutions, []);
    assert.equal(res.resolvedCount, 0);
  }
});

test('summarizeConvergence: safe on non-array input', () => {
  assert.match(summarizeConvergence(null), /No convergence clusters/);
  assert.match(summarizeConvergence(42), /No convergence clusters/);
});

// ---- summary ----
console.log(`\n${pass} passing, ${fail} failing`);
if (fail > 0) process.exit(1);
