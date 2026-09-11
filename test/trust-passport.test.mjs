// ============================================================
// DATAGLOW — Tests: Trust Passport (Batch 1)
// ============================================================
// Plain node, no DOM/DuckDB/network needed — js/provenance/trust-passport.js
// is pure JS composing outputs of readiness-gate.js, ai-touch-ledger.js,
// ownership-ledger.js and agent-action-firewall.js. Covers: composition from
// well-formed inputs, graceful degradation on missing/malformed inputs
// (never throws), the fixed permission table's ALLOW/DENY/GATE verdicts, and
// the one-line summary.

import assert from 'node:assert/strict';
import {
  buildTrustPassport,
  summarizeTrustPassport,
  PASSPORT_CAPABILITIES,
  TRUST_PASSPORT_VERSION,
} from '../js/provenance/trust-passport.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

await test('buildTrustPassport: composes a well-formed passport from real-shaped inputs', () => {
  const passport = buildTrustPassport({
    gateResult: { score: 92, passed: true, reasons: ['3 nulls auto-flagged, not fixed'] },
    touchEntries: [
      { model: 'Guarded Copilot', location: 'ondevice', rejected: false },
      { model: 'External agent (Claude)', location: 'external', rejected: false },
    ],
    ownershipEvents: [
      { identity: 'andre', ts: 1000 },
      { identity: 'andre', ts: 2000 },
    ],
    meta: { datasetId: 'claims_2026_q3', datasetLabel: 'Claims Q3 2026' },
  });
  assert.equal(passport.kind, 'dataglow-trust-passport');
  assert.equal(passport.version, TRUST_PASSPORT_VERSION);
  assert.equal(passport.readiness.score, 92);
  assert.equal(passport.readiness.passed, true);
  assert.equal(passport.touchCount, 2);
  assert.equal(passport.datasetId, 'claims_2026_q3');
  assert.equal(passport.datasetLabel, 'Claims Q3 2026');
  assert.ok(passport.ownership.owner === 'andre');
  assert.equal(passport.permissions.length, PASSPORT_CAPABILITIES.length);
});

await test('buildTrustPassport: never throws on completely empty input', () => {
  const passport = buildTrustPassport({});
  assert.equal(passport.kind, 'dataglow-trust-passport');
  assert.equal(passport.readiness.score, null);
  assert.equal(passport.touchCount, 0);
  assert.equal(passport.ownership.owner, null);
  assert.equal(passport.permissions.length, PASSPORT_CAPABILITIES.length);
});

await test('buildTrustPassport: never throws on malformed inputs (wrong types)', () => {
  const passport = buildTrustPassport({
    gateResult: 'not-an-object',
    touchEntries: 'not-an-array',
    ownershipEvents: 42,
    meta: null,
  });
  assert.equal(passport.kind, 'dataglow-trust-passport');
  assert.equal(passport.readiness.score, null);
  assert.equal(passport.touchCount, 0);
  assert.equal(passport.datasetId, null);
});

await test('permissions: read-aggregate is always ALLOW', () => {
  const passport = buildTrustPassport({});
  const row = passport.permissions.find((p) => p.capability === 'read-aggregate');
  assert.equal(row.status, 'allow');
});

await test('permissions: read-row-level is always DENY', () => {
  const passport = buildTrustPassport({});
  const row = passport.permissions.find((p) => p.capability === 'read-row-level');
  assert.equal(row.status, 'deny');
});

await test('permissions: auto-apply-repair is always DENY, never allowed', () => {
  const passport = buildTrustPassport({});
  const row = passport.permissions.find((p) => p.capability === 'auto-apply-repair');
  assert.equal(row.status, 'deny');
});

await test('permissions: propose-repair is GATE, mirroring the firewall classification', () => {
  const passport = buildTrustPassport({});
  const row = passport.permissions.find((p) => p.capability === 'propose-repair');
  assert.equal(row.status, 'gate');
  assert.ok(row.risk);
});

await test('permissions: export-outside-device is GATE', () => {
  const passport = buildTrustPassport({});
  const row = passport.permissions.find((p) => p.capability === 'export-outside-device');
  assert.equal(row.status, 'gate');
});

await test('permissions: covers exactly the fixed PASSPORT_CAPABILITIES set, no more, no less', () => {
  const passport = buildTrustPassport({});
  const capabilities = passport.permissions.map((p) => p.capability).sort();
  assert.deepEqual(capabilities, [...PASSPORT_CAPABILITIES].sort());
});

await test('summarizeTrustPassport: reads plainly on a well-formed passport', () => {
  const passport = buildTrustPassport({
    gateResult: { score: 92, passed: true },
    touchEntries: [{ model: 'x', location: 'ondevice' }],
  });
  const summary = summarizeTrustPassport(passport);
  assert.match(summary, /readiness 92/);
  assert.match(summary, /1 touch/);
});

await test('summarizeTrustPassport: never throws on a non-passport input', () => {
  assert.equal(summarizeTrustPassport(null), 'No trust passport available.');
  assert.equal(summarizeTrustPassport({}), 'No trust passport available.');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
