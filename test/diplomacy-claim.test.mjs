// Data Diplomacy, Batch 1 — claim + seal builder. Pure-logic tests only (no
// DOM/browser), matching this repo's established convention: nothing is wired
// into main.js yet (a DOM/e2e test is added once a later batch wires the
// approval UI into a real page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealClaim, verifyClaimSeal, CLAIM_KIND } from '../js/diplomacy/diplomacy-claim.js';

test('sealClaim: builds an inert, fully-shaped sealed claim', async () => {
  const claim = await sealClaim({
    entityId: 'cust-42',
    field: 'region',
    value: 'West',
    confidence: 0.9,
    source: 'riverside-crm',
    sealedBy: 'party-a',
    sealedAt: '2026-07-12T00:00:00.000Z',
  });
  assert.equal(claim.kind, CLAIM_KIND);
  assert.equal(claim.entityId, 'cust-42');
  assert.equal(claim.field, 'region');
  assert.equal(claim.value, 'West');
  assert.equal(claim.confidence, 0.9);
  assert.equal(claim.source, 'riverside-crm');
  assert.equal(claim.sealedBy, 'party-a');
  assert.equal(claim.sealedAt, '2026-07-12T00:00:00.000Z');
  assert.equal(typeof claim.fingerprint, 'string');
  assert.equal(claim.fingerprint.length, 64); // SHA-256 hex
});

test('sealClaim: confidence defaults to null when omitted (Lakeside-style claim)', async () => {
  const claim = await sealClaim({ entityId: 'e1', field: 'region', value: 'Pacific', source: 'lakeside-erp' });
  assert.equal(claim.confidence, null);
  assert.equal((await verifyClaimSeal(claim)).valid, true);
});

test('sealClaim: falsy-but-real values (0, false, empty string) are valid', async () => {
  for (const value of [0, false, '']) {
    const claim = await sealClaim({ entityId: 'e1', field: 'f', value, source: 's' });
    assert.equal(claim.value, value);
    assert.equal((await verifyClaimSeal(claim)).valid, true);
  }
});

test('sealClaim: throws on any missing required field', async () => {
  await assert.rejects(() => sealClaim({ field: 'region', value: 'West', source: 's' }), /entityId/);
  await assert.rejects(() => sealClaim({ entityId: 'e', value: 'West', source: 's' }), /field/);
  await assert.rejects(() => sealClaim({ entityId: 'e', field: 'region', source: 's' }), /value/);
  await assert.rejects(() => sealClaim({ entityId: 'e', field: 'region', value: 'West' }), /source/);
  await assert.rejects(() => sealClaim(), /missing required field/);
});

test('sealClaim: rejects an out-of-range or non-numeric confidence', async () => {
  await assert.rejects(() => sealClaim({ entityId: 'e', field: 'f', value: 'v', source: 's', confidence: 1.5 }), /confidence/);
  await assert.rejects(() => sealClaim({ entityId: 'e', field: 'f', value: 'v', source: 's', confidence: -0.1 }), /confidence/);
  await assert.rejects(() => sealClaim({ entityId: 'e', field: 'f', value: 'v', source: 's', confidence: 'high' }), /confidence/);
});

test('verifyClaimSeal: a freshly sealed claim verifies', async () => {
  const claim = await sealClaim({ entityId: 'e', field: 'region', value: 'West', confidence: 0.8, source: 's' });
  assert.deepEqual(await verifyClaimSeal(claim), { valid: true });
});

test('verifyClaimSeal: catches a mutated value (genuine tamper detection)', async () => {
  const claim = await sealClaim({ entityId: 'e', field: 'region', value: 'West', confidence: 0.8, source: 's' });
  const tampered = { ...claim, value: 'East' };
  const res = await verifyClaimSeal(tampered);
  assert.equal(res.valid, false);
  assert.match(res.reason, /modified/);
});

test('verifyClaimSeal: catches a mutated confidence and a mutated source', async () => {
  const claim = await sealClaim({ entityId: 'e', field: 'region', value: 'West', confidence: 0.8, source: 's' });
  assert.equal((await verifyClaimSeal({ ...claim, confidence: 0.1 })).valid, false);
  assert.equal((await verifyClaimSeal({ ...claim, source: 'other' })).valid, false);
});

test('verifyClaimSeal: rejects non-claims and unfingerprinted objects honestly', async () => {
  assert.equal((await verifyClaimSeal(null)).valid, false);
  assert.equal((await verifyClaimSeal({})).valid, false);
  assert.equal((await verifyClaimSeal({ kind: CLAIM_KIND })).valid, false);
});
