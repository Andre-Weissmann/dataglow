// ============================================================
// DATAGLOW — Tests: Cross-Table Relational Rules (Truth Network, Batch 1/3)
// ============================================================
// Plain node, no DOM/DuckDB/network needed — js/validation/cross-table-rules.js
// is pure JS operating on arrays of row objects, exactly like
// test/room-signaling.test.mjs tests the pure Rooms Batch 1 module. Covers the
// two NORTH_STAR.md run-4 P1 scenarios (death-date washout, claims-total
// set-difference) plus the never-throws edge cases the module contract promises.

import assert from 'node:assert/strict';
import {
  checkCrossTableRule,
  summarizeCrossTableCheck,
  normalizeKey,
  toEpochMs,
  RULE_KINDS,
} from '../js/validation/cross-table-rules.js';

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

// ---- helpers / exported utilities ----

test('RULE_KINDS exposes the supported vocabulary', () => {
  assert.deepEqual([...RULE_KINDS].sort(), ['date_after', 'set_difference']);
});

test('normalizeKey: coerces types, trims, lowercases; nullish/blank -> null', () => {
  assert.equal(normalizeKey(42), '42');
  assert.equal(normalizeKey(' P42 '), 'p42');
  assert.equal(normalizeKey(null), null);
  assert.equal(normalizeKey(undefined), null);
  assert.equal(normalizeKey('   '), null);
});

test('toEpochMs: parses Date, ISO strings, epoch numbers; junk -> null', () => {
  assert.equal(toEpochMs('2026-01-01'), Date.parse('2026-01-01'));
  assert.equal(toEpochMs(new Date('2026-01-01')), Date.parse('2026-01-01'));
  assert.equal(toEpochMs(0), 0);
  assert.equal(toEpochMs('not a date'), null);
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs(''), null);
});

// ---- Scenario 1: death-date washout (date_after) ----
// tableA = claims (patient_id, claim_date), tableB = patients (id, death_date).
// A 60-day washout window tolerates legitimate trailing claims; claims beyond
// it are implausible (a claim long after the patient's recorded death).

const claims = [
  { claim_id: 'C1', patient_id: 'P1', claim_date: '2026-01-10' }, // P1 died 2026-01-01 -> 9 days after (within grace)
  { claim_id: 'C2', patient_id: 'P1', claim_date: '2026-04-01' }, // 90 days after -> VIOLATION
  { claim_id: 'C3', patient_id: 'P2', claim_date: '2026-02-01' }, // P2 alive (no death_date) -> skipped
  { claim_id: 'C4', patient_id: 'P3', claim_date: '2026-03-15' }, // P3 died 2025-12-01 -> ~104 days -> VIOLATION
  { claim_id: 'C5', patient_id: 'P3', claim_date: '2025-11-20' }, // before death -> OK
  { claim_id: 'C6', patient_id: 'P9', claim_date: '2026-01-01' }, // no matching patient row -> skipped
];
const patients = [
  { id: 'P1', death_date: '2026-01-01' },
  { id: 'P2', death_date: null },
  { id: 'P3', death_date: '2025-12-01' },
];

test('death-date washout: flags claims beyond the 60-day grace window only', () => {
  const result = checkCrossTableRule({
    tableA: claims, tableB: patients,
    joinKeyA: 'patient_id', joinKeyB: 'id',
    rule: { kind: 'date_after', columnA: 'claim_date', columnB: 'death_date', maxDaysAfter: 60 },
  });
  assert.equal(result.evaluated, true);
  assert.equal(result.kind, 'date_after');
  assert.equal(result.violationCount, 2);
  const flagged = result.violations.map(v => v.valueA).sort();
  assert.deepEqual(flagged, ['2026-03-15', '2026-04-01']);
  // P2 (no death date) and P9 (no join match) never produce a violation.
  assert.ok(!result.violations.some(v => v.key === 'p2' || v.key === 'p9'));
  // comparablePairs counts only pairs where BOTH dates parsed (P1x2, P3x2 = 4).
  assert.equal(result.comparablePairs, 4);
  // each violation carries its computed daysAfter and a plain-language reason.
  const c2 = result.violations.find(v => v.valueA === '2026-04-01');
  assert.ok(c2.daysAfter > 60);
  assert.match(c2.reason, /grace window/);
});

test('death-date washout: maxDaysAfter defaults to 0 (any claim after death flags)', () => {
  const result = checkCrossTableRule({
    tableA: claims, tableB: patients,
    joinKeyA: 'patient_id', joinKeyB: 'id',
    rule: { kind: 'date_after', columnA: 'claim_date', columnB: 'death_date' },
  });
  // C1 (9 days), C2 (90 days), C4 (~104 days) all now flag; C5 (before) does not.
  assert.equal(result.violationCount, 3);
  assert.equal(result.maxDaysAfter, 0);
});

test('death-date washout: accepts pre-joined pairs instead of raw tables', () => {
  const result = checkCrossTableRule({
    pairs: [
      { a: { claim_date: '2026-04-01' }, b: { death_date: '2026-01-01' }, key: 'P1' },
      { a: { claim_date: '2026-01-05' }, b: { death_date: '2026-01-01' }, key: 'P1' },
    ],
    rule: { kind: 'date_after', columnA: 'claim_date', columnB: 'death_date', maxDaysAfter: 60 },
  });
  assert.equal(result.violationCount, 1);
  assert.equal(result.violations[0].key, 'P1');
});

test('summarizeCrossTableCheck: date_after one-liners for hit and clean', () => {
  const hit = checkCrossTableRule({
    tableA: claims, tableB: patients, joinKeyA: 'patient_id', joinKeyB: 'id',
    rule: { kind: 'date_after', columnA: 'claim_date', columnB: 'death_date', maxDaysAfter: 60 },
  });
  assert.match(summarizeCrossTableCheck(hit), /^2 VIOLATION\(S\)/);
  const clean = checkCrossTableRule({
    tableA: [{ patient_id: 'P3', claim_date: '2025-11-20' }], tableB: patients,
    joinKeyA: 'patient_id', joinKeyB: 'id',
    rule: { kind: 'date_after', columnA: 'claim_date', columnB: 'death_date', maxDaysAfter: 60 },
  });
  assert.match(summarizeCrossTableCheck(clean), /^OK —/);
});

// ---- Scenario 2: claims-total mismatch (set_difference) ----
// Mirrors the mockup's "16 rows / $8,562.25 present in A but not B" example:
// 15 claims of $500.00 + 1 claim of $1,062.25 == $8,562.25, all missing from B.

function buildMismatchTables() {
  const tableA = [];
  // 4 claims that DO reconcile (present in both A and B).
  for (let i = 0; i < 4; i++) tableA.push({ claim_id: `MATCH${i}`, amount: 100 });
  // 16 claims present in A but missing from B, summing to exactly 8562.25.
  for (let i = 0; i < 15; i++) tableA.push({ claim_id: `ONLY_A_${i}`, amount: 500.0 });
  tableA.push({ claim_id: 'ONLY_A_15', amount: 1062.25 });

  const tableB = [];
  for (let i = 0; i < 4; i++) tableB.push({ claim_id: `MATCH${i}`, amount: 100 });
  return { tableA, tableB };
}

test('claims mismatch: finds the 16 rows in A missing from B, totalling $8,562.25', () => {
  const { tableA, tableB } = buildMismatchTables();
  const result = checkCrossTableRule({
    tableA, tableB,
    joinKeyA: 'claim_id', joinKeyB: 'claim_id',
    rule: { kind: 'set_difference', columnA: 'claim_id', columnB: 'claim_id', amountColumnA: 'amount' },
  });
  assert.equal(result.evaluated, true);
  assert.equal(result.kind, 'set_difference');
  assert.equal(result.violationCount, 16);
  assert.equal(result.amountColumn, 'amount');
  assert.equal(result.amountTotal, 8562.25);
  assert.ok(result.violations.every(v => v.valueA.startsWith('ONLY_A_')));
});

test('claims mismatch: summarize reports count and money total', () => {
  const { tableA, tableB } = buildMismatchTables();
  const result = checkCrossTableRule({
    tableA, tableB, joinKeyA: 'claim_id', joinKeyB: 'claim_id',
    rule: { kind: 'set_difference', columnA: 'claim_id', columnB: 'claim_id', amountColumnA: 'amount' },
  });
  const s = summarizeCrossTableCheck(result);
  assert.match(s, /16 VIOLATION\(S\)/);
  assert.match(s, /8562\.25/);
});

test('claims mismatch: works without an amount column (count only)', () => {
  const { tableA, tableB } = buildMismatchTables();
  const result = checkCrossTableRule({
    tableA, tableB, joinKeyA: 'claim_id', joinKeyB: 'claim_id',
    rule: { kind: 'set_difference', columnA: 'claim_id', columnB: 'claim_id' },
  });
  assert.equal(result.violationCount, 16);
  assert.equal(result.amountColumn, undefined);
  assert.match(summarizeCrossTableCheck(result), /16 VIOLATION\(S\)/);
});

test('set_difference: value equality is type-insensitive (42 matches "42")', () => {
  const result = checkCrossTableRule({
    tableA: [{ id: 42 }, { id: 7 }], tableB: [{ id: '42' }],
    joinKeyA: 'id', joinKeyB: 'id',
    rule: { kind: 'set_difference', columnA: 'id', columnB: 'id' },
  });
  assert.equal(result.violationCount, 1);
  assert.equal(result.violations[0].valueA, 7);
});

// ---- Edge cases: never throws, safe idle/empty results ----

test('empty tables: evaluated with zero violations, never throws', () => {
  const dateRes = checkCrossTableRule({
    tableA: [], tableB: [], joinKeyA: 'patient_id', joinKeyB: 'id',
    rule: { kind: 'date_after', columnA: 'claim_date', columnB: 'death_date', maxDaysAfter: 60 },
  });
  assert.equal(dateRes.evaluated, true);
  assert.equal(dateRes.violationCount, 0);
  const setRes = checkCrossTableRule({
    tableA: [], tableB: [], joinKeyA: 'claim_id', joinKeyB: 'claim_id',
    rule: { kind: 'set_difference', columnA: 'claim_id', columnB: 'claim_id' },
  });
  assert.equal(setRes.evaluated, true);
  assert.equal(setRes.violationCount, 0);
});

test('no matching join keys: date_after evaluates to zero comparable pairs', () => {
  const result = checkCrossTableRule({
    tableA: [{ patient_id: 'X', claim_date: '2026-01-01' }],
    tableB: [{ id: 'Y', death_date: '2020-01-01' }],
    joinKeyA: 'patient_id', joinKeyB: 'id',
    rule: { kind: 'date_after', columnA: 'claim_date', columnB: 'death_date', maxDaysAfter: 60 },
  });
  assert.equal(result.evaluated, true);
  assert.equal(result.comparablePairs, 0);
  assert.equal(result.violationCount, 0);
});

test('malformed rule object never throws — returns idle evaluated:false', () => {
  const cases = [
    undefined,
    null,
    42,
    'string',
    {},
    { rule: null },
    { rule: {} },
    { rule: { kind: 'no_such_kind' } },
    { rule: { kind: 'date_after' }, tableA: [], tableB: [], joinKeyA: 'a', joinKeyB: 'b' }, // missing columns
    { rule: { kind: 'date_after', columnA: 'a', columnB: 'b', maxDaysAfter: -5 }, tableA: [], tableB: [], joinKeyA: 'a', joinKeyB: 'b' },
    { rule: { kind: 'date_after', columnA: 'a', columnB: 'b' } }, // no tables and no pairs
    { rule: { kind: 'set_difference', columnA: 'a', columnB: 'b' } }, // no tables
    { rule: { kind: 'set_difference', columnA: 'a', columnB: 'b', amountColumnA: 5 }, tableA: [], tableB: [] },
  ];
  for (const input of cases) {
    let result;
    assert.doesNotThrow(() => { result = checkCrossTableRule(input); }, `threw on ${JSON.stringify(input)}`);
    assert.equal(result.evaluated, false, `should be idle for ${JSON.stringify(input)}`);
    assert.deepEqual(result.violations, []);
    assert.equal(typeof result.reason, 'string');
  }
});

test('malformed table entries do not crash the join', () => {
  const result = checkCrossTableRule({
    tableA: [{ patient_id: 'P1', claim_date: '2026-04-01' }],
    tableB: [{ id: 'P1', death_date: '2026-01-01' }],
    joinKeyA: 'patient_id', joinKeyB: 'id',
    rule: { kind: 'date_after', columnA: 'claim_date', columnB: 'death_date', maxDaysAfter: 60 },
  });
  assert.equal(result.violationCount, 1);
});

test('non-array tables are rejected as idle, never throw', () => {
  const result = checkCrossTableRule({
    tableA: 'nope', tableB: [], joinKeyA: 'a', joinKeyB: 'b',
    rule: { kind: 'set_difference', columnA: 'a', columnB: 'b' },
  });
  assert.equal(result.evaluated, false);
});

test('summarizeCrossTableCheck: safe on junk and on idle results', () => {
  assert.match(summarizeCrossTableCheck(null), /No cross-table check result/);
  assert.match(summarizeCrossTableCheck({ evaluated: false, reason: 'bad rule' }), /^NOT EVALUATED — bad rule/);
});

// ---- summary ----
console.log(`\n${pass} passing, ${fail} failing`);
if (fail > 0) process.exit(1);
