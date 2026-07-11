// ============================================================
// DATAGLOW — Verifiable Check Seal unit tests (Trust Passport, Batch 3)
// ============================================================
// Exercises the "Proof-of-Clean" sealing module
// (js/provenance/verifiable-check-seal.js) with NO browser, NO network, and NO
// DuckDB: crypto.subtle is available in modern Node, so the real Merkle/SHA-256
// commitment (reused from js/provenance/selective-disclosure-proof.js) runs
// unchanged. It seals a real Local Analysis Contract result, re-verifies the
// commitment, confirms a matching-data check passes and a TAMPERED-data check
// FAILS (the single most important property — a seal that verifies no matter
// what is not a real seal), tampers with the seal artifact itself, attaches a
// seal additively to a batch-2 Data Nutrition Label, and includes a zero-upload
// source guard.
//
// RUN WITH:  node test/verifiable-check-seal.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sealCheckResult,
  verifySeal,
  attachSealToLabel,
  fingerprintData,
  canonicalJSON,
  renderSealSummaryLines,
  exportSealAsJSON,
  CHECK_SEAL_KIND,
  CHECK_SEAL_VERSION,
} from '../js/provenance/verifiable-check-seal.js';
import { runAnalysisContract } from '../js/validation/analysis-contract.js';
import { buildDataNutritionLabel } from '../js/provenance/data-nutrition-label.js';
import { createProvenanceChain } from '../js/provenance/provenance.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A small, realistic dataset the check "ran against".
function sampleRows() {
  return [
    { id: 1, customer_id: 10, amount: 5.0, is_test: false },
    { id: 2, customer_id: 10, amount: 7.5, is_test: false },
    { id: 3, customer_id: 11, amount: 2.0, is_test: true },
  ];
}

const sampleSchema = {
  tables: {
    orders: {
      columns: [
        { name: 'id' }, { name: 'customer_id' }, { name: 'amount' }, { name: 'is_test' },
      ],
      rowCount: 3,
      approxDistinct: {},
    },
  },
};

async function main() {
  // --- 1. fingerprintData / canonicalJSON determinism -----------------------
  {
    const a = await fingerprintData(sampleRows());
    const b = await fingerprintData(sampleRows());
    ok(a === b, 'fingerprintData is deterministic for equal data');
    ok(/^[0-9a-f]{64}$/.test(a), 'fingerprintData returns a 64-char SHA-256 hex string');

    // Canonical JSON sorts object keys so key order does not change the hash.
    const reordered = [{ amount: 5.0, id: 1, is_test: false, customer_id: 10 }];
    const straight = [{ id: 1, customer_id: 10, amount: 5.0, is_test: false }];
    ok(canonicalJSON(reordered) === canonicalJSON(straight),
      'canonicalJSON is key-order-independent for objects');

    // But array (row) order IS part of the fingerprint — documented behaviour.
    const swapped = [sampleRows()[1], sampleRows()[0], sampleRows()[2]];
    ok(await fingerprintData(swapped) !== a,
      'fingerprintData is row-order-sensitive (documented: caller sorts for order-independence)');

    // A string is hashed as-is.
    const s1 = await fingerprintData('hello');
    const s2 = await fingerprintData('hello');
    ok(s1 === s2 && /^[0-9a-f]{64}$/.test(s1), 'fingerprintData hashes a string input as-is');
  }

  // --- 2. Seal a real Local Analysis Contract result ------------------------
  const rows = sampleRows();
  const report = runAnalysisContract('SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id', sampleSchema);
  const seal = await sealCheckResult(report, {
    check: { name: 'Local Analysis Contract', kind: 'local-analysis-contract' },
    params: 'SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id',
    dataset: { name: 'Orders', rowCount: 3, columnNames: ['id', 'customer_id', 'amount', 'is_test'] },
    data: rows,
    generatedAt: '2026-07-11T00:00:00.000Z',
    dataglow: { version: 'test', build: 'unit' },
  });

  {
    ok(seal.kind === CHECK_SEAL_KIND, 'seal has the correct kind');
    ok(seal.version === CHECK_SEAL_VERSION, 'seal carries the schema version');
    ok(seal.generatedAt === '2026-07-11T00:00:00.000Z', 'seal honours an explicit generatedAt');
    ok(/^[0-9a-f]{64}$/.test(seal.commitment.merkleRoot), 'seal has a 64-char SHA-256 Merkle root');
    ok(seal.commitment.leafCount === seal.disclosedClaims.length, 'leafCount matches disclosed claim count');
    ok(seal.disclosedClaims.length === 9, 'seal discloses the full 9-claim set');
    ok(seal.result.status === report.status, 'seal records the check status');
    ok(/^[0-9a-f]{64}$/.test(seal.fingerprints.data), 'seal carries a data fingerprint');
    ok(seal.fingerprints.dataSource === 'computed-from-data', 'seal records the fingerprint source');
    // Honest naming: the disclaimer must NOT overclaim.
    ok(/NOT a zero-knowledge proof/i.test(seal.disclaimer), 'disclaimer states it is NOT a zero-knowledge proof');
    ok(!/\bcertified\b/i.test(seal.disclaimer) || /NOT/i.test(seal.disclaimer),
      'disclaimer never claims to be a certification');
    ok(/does NOT attest that the underlying data is accurate/i.test(seal.disclaimer),
      'disclaimer states it does not attest data accuracy');
    // A disclosed claim carries the sealed data fingerprint as cleartext (selective
    // disclosure of the fingerprint, never the data).
    const dfClaim = seal.disclosedClaims.find(c => c.type === 'data_fingerprint');
    ok(dfClaim && dfClaim.value === seal.fingerprints.data, 'data_fingerprint claim matches the artifact fingerprint');
    // The raw data must NOT be in the artifact — only the fingerprint.
    const json = exportSealAsJSON(seal);
    ok(!/customer_id.*:\s*10/.test(json) && !json.includes('"amount":5'),
      'zero-data: raw row values do not appear in the serialized seal');
    ok(JSON.parse(json).commitment.merkleRoot === seal.commitment.merkleRoot, 'seal round-trips losslessly through JSON');
  }

  // --- 3. Verify a valid seal — commitment only (no data) -------------------
  {
    const v = await verifySeal(seal);
    ok(v.commitmentValid === true, 'commitment verifies from the artifact alone');
    ok(v.valid === true, 'seal is valid on a commitment-only check');
    ok(v.dataMatch === null, 'dataMatch is null (not checked) when no data supplied');
    ok(v.claims.length === 9 && v.claims.every(c => c.valid), 'every disclosed claim folds to the committed root');
  }

  // --- 4. Verify with MATCHING data -----------------------------------------
  {
    const v = await verifySeal(seal, sampleRows());
    ok(v.dataMatch === true, 'matching data re-fingerprints to the committed value');
    ok(v.valid === true, 'seal is valid when data matches');
  }

  // --- 5. Verify with TAMPERED data — MUST FAIL (the key property) ----------
  {
    const tampered = sampleRows();
    tampered[0].amount = 999999; // silently change a value
    const v = await verifySeal(seal, tampered);
    ok(v.commitmentValid === true, 'commitment still intact (only the data changed)');
    ok(v.dataMatch === false, 'TAMPER DETECTED: modified data does NOT match the sealed fingerprint');
    ok(v.valid === false, 'seal is INVALID when the data was modified since sealing');
    ok(/modified/i.test(v.reason), 'reason names the data as modified');
  }

  // --- 6. Tamper with the SEAL ARTIFACT itself — MUST FAIL commitment -------
  {
    const clone = JSON.parse(exportSealAsJSON(seal));
    // Flip the recorded result status without touching the Merkle root.
    const statusClaim = clone.disclosedClaims.find(c => c.type === 'result_status');
    statusClaim.value = 'pass-but-actually-tampered';
    const v = await verifySeal(clone, sampleRows());
    ok(v.commitmentValid === false, 'altering a sealed claim value breaks the commitment');
    ok(v.valid === false, 'seal is INVALID when the artifact was tampered with');
    ok(v.claims.some(c => !c.valid), 'the tampered claim is reported as a non-member of the committed set');
  }

  // --- 7. A wrong-kind object is rejected cleanly ---------------------------
  {
    const v = await verifySeal({ kind: 'something-else' });
    ok(v.valid === false && /not a dataglow verifiable check seal/i.test(v.reason),
      'verifySeal rejects a non-seal object with an honest reason');
  }

  // --- 8. Refuse to mint a seal with no data binding ------------------------
  {
    let threw = false;
    try {
      await sealCheckResult(report, { check: { name: 'x', kind: 'y' }, dataset: {} });
    } catch (e) {
      threw = /data fingerprint is required/i.test(e.message);
    }
    ok(threw, 'sealCheckResult refuses to mint a seal with no data or fingerprint');

    // But a precomputed fingerprint is accepted (the large-table path).
    const fp = await fingerprintData(sampleRows());
    const sealFromFp = await sealCheckResult(report, {
      check: { name: 'Local Analysis Contract', kind: 'local-analysis-contract' },
      dataset: { name: 'Orders', rowCount: 3, columnNames: ['id', 'customer_id', 'amount', 'is_test'] },
      dataFingerprint: fp,
    });
    ok(sealFromFp.fingerprints.dataSource === 'caller-supplied', 'a precomputed fingerprint is recorded as caller-supplied');
    const vFp = await verifySeal(sealFromFp, { dataFingerprint: fp });
    ok(vFp.valid === true && vFp.dataMatch === true, 'a seal from a precomputed fingerprint verifies against that fingerprint');
  }

  // --- 9. Attach a seal to a Data Nutrition Label (batch 2) — additive ------
  {
    const chain = createProvenanceChain();
    await chain.append({ op: 'load', description: 'Loaded orders.csv' });
    await chain.append({ op: 'clean', description: 'Trimmed whitespace' });
    const label = buildDataNutritionLabel({
      dataset: { name: 'Orders', table: 'orders', rowCount: 3, colCount: 4 },
      custody: chain,
      checks: [{ layer: 'ranges', name: 'Expected Range', status: 'pass', summary: 'ok' }],
      generatedAt: '2026-07-11T00:00:00.000Z',
    });

    const before = JSON.stringify(label);
    const withSeal = attachSealToLabel(label, seal);

    // Original label is not mutated.
    ok(JSON.stringify(label) === before, 'attachSealToLabel does not mutate the input label');
    // Existing batch-2 custodyChain fields are preserved exactly.
    ok(withSeal.custodyChain.algorithm === label.custodyChain.algorithm, 'custodyChain.algorithm unchanged');
    ok(withSeal.custodyChain.length === label.custodyChain.length, 'custodyChain.length unchanged');
    ok(withSeal.custodyChain.finalHash === label.custodyChain.finalHash, 'custodyChain.finalHash unchanged');
    ok(JSON.stringify(withSeal.custodyChain.steps) === JSON.stringify(label.custodyChain.steps), 'custodyChain.steps unchanged');
    // The seal lands in a new custodyChain.seals array.
    ok(Array.isArray(withSeal.custodyChain.seals) && withSeal.custodyChain.seals.length === 1,
      'seal is appended to a new custodyChain.seals array');
    // The seal is anchored to the label's custody finalHash.
    ok(withSeal.custodyChain.seals[0].labelAnchor === label.custodyChain.finalHash,
      'attached seal is anchored to the label custodyChain.finalHash');
    // Every other top-level label field is untouched.
    ok(withSeal.kind === label.kind && withSeal.schemaVersion === label.schemaVersion && withSeal.disclaimer === label.disclaimer,
      'top-level label fields (kind, schemaVersion, disclaimer) unchanged');
    // A second attach appends, does not overwrite.
    const withTwo = attachSealToLabel(withSeal, seal);
    ok(withTwo.custodyChain.seals.length === 2, 'a second attach appends rather than overwriting');
    // The attached seal still verifies out of the label.
    const v = await verifySeal(withSeal.custodyChain.seals[0], sampleRows());
    ok(v.valid === true, 'a seal extracted from the label still verifies');
  }

  // --- 10. Human-readable summary -------------------------------------------
  {
    const lines = renderSealSummaryLines(seal);
    ok(Array.isArray(lines) && lines[0] === 'Verifiable Check Seal', 'renderSealSummaryLines returns titled lines');
    ok(lines.some(l => /not a certification, not zero-knowledge/i.test(l)),
      'summary carries the honest not-a-certification/not-ZK note');
  }

  // --- 11. Zero-upload guard: no network primitive in the module source -----
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/;
    const src = readFileSync(join(here, '..', 'js', 'provenance', 'verifiable-check-seal.js'), 'utf8');
    ok(!netRe.test(src), 'zero-upload: js/provenance/verifiable-check-seal.js contains no network primitive');
    // Honest-naming source guard: any line mentioning a forbidden term must also
    // carry a negation (NOT / never / avoid / no ) — i.e. the term may appear only
    // to explicitly disclaim it, never as a self-description.
    const forbidden = ['zero-knowledge', 'zkp', 'blockchain', 'certified'];
    const lines = src.split('\n');
    for (const term of forbidden) {
      const offending = lines.filter(l =>
        new RegExp(`\\b${term}\\b`, 'i').test(l) && !/\b(not|never|avoid|no|isn't|nor)\b/i.test(l));
      ok(offending.length === 0, `honest-naming: "${term}" only ever appears in a disclaiming line`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
