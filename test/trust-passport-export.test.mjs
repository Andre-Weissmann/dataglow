// ============================================================
// DATAGLOW — Tests: Trust Passport Export & Independent Verify (Batch 2)
// ============================================================
// Plain node, no DOM/DuckDB/network needed — trust-passport-export.js is pure
// JS reusing the Merkle/SHA-256 primitives from verifiable-check-seal.js.
// Covers: sealing a real passport, independent re-verification succeeding on
// an unmodified export, detecting tamper on every major field, refusing to
// seal a non-passport, and all three export formats.

import assert from 'node:assert/strict';
import { buildTrustPassport } from '../js/provenance/trust-passport.js';
import {
  sealTrustPassport,
  verifyTrustPassportExport,
  exportTrustPassport,
  TRUST_PASSPORT_EXPORT_KIND,
  TRUST_PASSPORT_EXPORT_VERSION,
} from '../js/provenance/trust-passport-export.js';

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

function samplePassport() {
  return buildTrustPassport({
    gateResult: { score: 92, passed: true, reasons: ['3 nulls auto-flagged, not fixed'] },
    touchEntries: [
      { model: 'Guarded Copilot', location: 'ondevice', rejected: false },
      { model: 'External agent (Claude)', location: 'external', rejected: false },
    ],
    ownershipEvents: [{ identity: 'andre', ts: 1000 }],
    meta: { datasetId: 'ds-1', datasetLabel: 'Q1 claims extract' },
  });
}

await test('sealTrustPassport: produces a well-formed sealed export', async () => {
  const passport = samplePassport();
  const sealed = await sealTrustPassport(passport);
  assert.equal(sealed.kind, TRUST_PASSPORT_EXPORT_KIND);
  assert.equal(sealed.version, TRUST_PASSPORT_EXPORT_VERSION);
  assert.equal(sealed.generatedAt, passport.generatedAt);
  assert.deepEqual(sealed.passport, passport);
  assert.ok(sealed.seal && sealed.seal.commitment && sealed.seal.commitment.merkleRoot);
  assert.match(sealed.disclaimer, /NOT a signature/);
});

await test('sealTrustPassport: refuses to seal a non-passport', async () => {
  await assert.rejects(() => sealTrustPassport(null), /expected a Trust Passport/);
  await assert.rejects(() => sealTrustPassport({}), /expected a Trust Passport/);
  await assert.rejects(() => sealTrustPassport({ kind: 'something-else' }), /expected a Trust Passport/);
});

await test('verifyTrustPassportExport: valid on an unmodified export', async () => {
  const sealed = await sealTrustPassport(samplePassport());
  const result = await verifyTrustPassportExport(sealed);
  assert.equal(result.valid, true);
  assert.equal(result.commitmentValid, true);
  assert.equal(result.dataMatch, true);
});

await test('verifyTrustPassportExport: detects the passport being edited after sealing', async () => {
  const sealed = await sealTrustPassport(samplePassport());
  const tampered = JSON.parse(JSON.stringify(sealed));
  tampered.passport.readiness.score = 100;
  const result = await verifyTrustPassportExport(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.commitmentValid, true);
  assert.equal(result.dataMatch, false);
});

await test('verifyTrustPassportExport: detects a permission row being deleted after sealing', async () => {
  const sealed = await sealTrustPassport(samplePassport());
  const tampered = JSON.parse(JSON.stringify(sealed));
  tampered.passport.permissions = tampered.passport.permissions.filter((p) => p.status !== 'deny');
  const result = await verifyTrustPassportExport(tampered);
  assert.equal(result.dataMatch, false);
});

await test('verifyTrustPassportExport: detects the seal itself being tampered (claim value changed)', async () => {
  const sealed = await sealTrustPassport(samplePassport());
  const tampered = JSON.parse(JSON.stringify(sealed));
  tampered.seal.disclosedClaims[0].value = 'forged';
  const result = await verifyTrustPassportExport(tampered);
  assert.equal(result.commitmentValid, false);
  assert.equal(result.valid, false);
});

await test('verifyTrustPassportExport: rejects a missing/incorrect kind', async () => {
  const result = await verifyTrustPassportExport({ kind: 'not-a-passport-export' });
  assert.equal(result.valid, false);
  assert.match(result.reason, /Not a DATAGLOW Trust Passport export/);
});

await test('verifyTrustPassportExport: rejects an export missing its seal or passport', async () => {
  const result = await verifyTrustPassportExport({ kind: TRUST_PASSPORT_EXPORT_KIND });
  assert.equal(result.valid, false);
  assert.match(result.reason, /missing its seal or its passport/);
});

await test('exportTrustPassport: json format round-trips through verify unchanged', async () => {
  const sealed = await sealTrustPassport(samplePassport());
  const json = exportTrustPassport(sealed, 'json');
  const parsed = JSON.parse(json);
  const result = await verifyTrustPassportExport(parsed);
  assert.equal(result.valid, true);
});

await test('exportTrustPassport: markdown format includes score, permissions table, and merkle root', async () => {
  const sealed = await sealTrustPassport(samplePassport());
  const md = exportTrustPassport(sealed, 'markdown');
  assert.match(md, /# DATAGLOW Trust Passport/);
  assert.match(md, /Readiness score:\*\* 92/);
  assert.match(md, /\| Capability \| Status \| Reason \|/);
  assert.match(md, /Merkle root:/);
});

await test('exportTrustPassport: text format includes score and permission lines', async () => {
  const sealed = await sealTrustPassport(samplePassport());
  const text = exportTrustPassport(sealed, 'text');
  assert.match(text, /DATAGLOW Trust Passport \(sealed export\)/);
  assert.match(text, /Readiness score: 92/);
  assert.match(text, /\[GATE\]|\[DENY\]|\[ALLOW\]/);
});

await test('sealTrustPassport: handles a minimal/degraded passport (missing inputs) without throwing', async () => {
  const passport = buildTrustPassport({});
  const sealed = await sealTrustPassport(passport);
  const result = await verifyTrustPassportExport(sealed);
  assert.equal(result.valid, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
