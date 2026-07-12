// ============================================================
// DATAGLOW — Personal Data Bill of Materials test
// ============================================================
// Verifies js/provenance/data-bom.js against its real logic:
//   • builds a BOM composing an attestation + schema + distribution + local
//     model fields, and asserts every field is present and correctly shaped;
//   • asserts a freshly-built BOM independently VERIFIES (outer digest +
//     nested attestation digest both intact) — this is the "does the math
//     actually work" check, not just a shape check;
//   • TAMPERING: mutates a field after the fact and asserts the verifier
//     detects it and returns false, for both the outer digest and the nested
//     attestation digest paths;
//   • the "no distribution computed" / "no local model used" paths degrade
//     gracefully (computed:false / used:false) rather than fabricating data;
//   • honest-labelling: notarization.notarized is ALWAYS false and the status
//     string never claims third-party notarization;
//   • the HTML renderer produces well-formed, non-crashing output referencing
//     the real column names and digest.
//
// RUN WITH:  node test/data-bom.test.mjs
//
// Pure crypto (SHA-256 via crypto.subtle, same primitive provenance.js uses)
// — no DuckDB engine needed, so this fixture is a plain JS object/array like
// the other pure-module tests (selective-disclosure-proof.test.mjs, etc.).

import { createProvenanceChain } from '../js/provenance/provenance.js';
import {
  buildPersonalDataBom, verifyPersonalDataBom, renderPersonalDataBomHTML,
  describeBomVerification,
  schemaSignature, schemaVersionHash, buildLocalModelRecord, BOM_KIND, BOM_VERSION,
} from '../js/provenance/data-bom.js';

// ---------- tiny test harness (mirrors the other test files) ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A realistic healthcare-claims-shaped fixture, matching the user's own
// domain (billing claims processing) rather than a generic placeholder.
async function claimsFixture() {
  const chain = createProvenanceChain();
  await chain.append('load', 'Loaded raw file "claims_2026_06.csv" (1200 rows, CSV)', { file: 'claims_2026_06.csv', rows: 1200 }, 'b'.repeat(64));
  await chain.append('transform', 'Filtered 3 rows with null claim_id', { dropped: 3 });
  const dataset = {
    table: 'claims_2026_06',
    name: 'claims_2026_06.csv',
    rowCount: 1197,
    cols: [
      { name: 'claim_id', type: 'BIGINT' },
      { name: 'billed_amount', type: 'DOUBLE' },
      { name: 'status', type: 'VARCHAR' },
    ],
    loadedAt: Date.now(),
    sizeBytes: 245678,
  };
  const distribution = {
    claim_id: { kind: 'numeric', nullRate: 0, cardinality: 1.0, mean: 50000, std: 2000, skew: 0.1, min: 1, max: 99999 },
    billed_amount: { kind: 'numeric', nullRate: 0.01, cardinality: 0.9, mean: 452.3, std: 120.5, skew: 1.2, min: 0, max: 5000 },
    status: { kind: 'categorical', nullRate: 0, cardinality: 0.002, top: ['paid', 'denied'], topLabel: 'paid', topProp: 0.7 },
  };
  return { chain, dataset, distribution };
}

async function main() {
  // ============================================================
  // (1) Shape — every DBoM-spec field is present with the right kind
  // ============================================================
  {
    const { chain, dataset, distribution } = await claimsFixture();
    const bom = await buildPersonalDataBom({
      dataset, trail: chain.getTrail(), distribution,
      localModel: { modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', modelLabel: 'Qwen2.5 1.5B Instruct (4-bit, ~1.1 GB)', used: true },
      sourceDescription: 'Uploaded file: claims_2026_06.csv',
    });
    ok(bom.kind === BOM_KIND, 'shape: kind is the DATAGLOW BOM discriminator');
    ok(bom.version === BOM_VERSION, 'shape: version is set');
    ok(typeof bom.generatedAt === 'string' && !Number.isNaN(Date.parse(bom.generatedAt)), 'shape: generatedAt is a valid ISO timestamp');
    ok(bom.source.description === 'Uploaded file: claims_2026_06.csv', 'shape: source.description honors the caller-supplied description');
    ok(bom.source.table === 'claims_2026_06', 'shape: source.table matches dataset.table');
    ok(bom.source.sizeBytes === 245678, 'shape: source.sizeBytes carried through');
    ok(bom.schema.columnCount === 3, 'shape: schema.columnCount matches column list length');
    ok(typeof bom.schema.signature === 'string' && bom.schema.signature.includes('claim_id'), 'shape: schema.signature is a stable signature string');
    ok(/^[0-9a-f]{64}$/.test(bom.schema.signatureHash), 'shape: schema.signatureHash is a 64-hex-char SHA-256');
    ok(bom.distribution.computed === true, 'shape: distribution.computed true when a snapshot is supplied');
    ok(bom.distribution.snapshot.billed_amount.kind === 'numeric', 'shape: distribution.snapshot passes through the caller-supplied fingerprint unmodified');
    ok(bom.localModel.used === true && bom.localModel.modelId === 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'shape: localModel records the real on-device model id');
    ok(!!bom.attestation && bom.attestation.chain.length === 2, 'shape: nested attestation carries the full 2-step provenance chain');
    ok(/^[0-9a-f]{64}$/.test(bom.digest.value), 'shape: outer digest.value is a 64-hex-char SHA-256');
    ok(bom.digest.algorithm === 'SHA-256', 'shape: digest.algorithm is SHA-256');
  }

  // ============================================================
  // (2) Verification — a freshly-built BOM must independently verify true
  // ============================================================
  {
    const { chain, dataset, distribution } = await claimsFixture();
    const bom = await buildPersonalDataBom({ dataset, trail: chain.getTrail(), distribution });
    const res = await verifyPersonalDataBom(bom);
    ok(res.valid === true, 'verify: a freshly-built, untampered BOM verifies true');
    ok(res.outer.valid === true, 'verify: outer digest matches on an untampered BOM');
    ok(res.attestation.valid === true, 'verify: nested attestation digest matches on an untampered BOM');
  }

  // ============================================================
  // (3) Tampering — mutating content after the fact must be detected
  // ============================================================
  {
    const { chain, dataset, distribution } = await claimsFixture();
    const bom = await buildPersonalDataBom({ dataset, trail: chain.getTrail(), distribution });

    // (3a) Tamper with a top-level BOM field (outside the nested attestation).
    const tamperedSource = JSON.parse(JSON.stringify(bom));
    tamperedSource.source.description = 'a completely different dataset';
    const resA = await verifyPersonalDataBom(tamperedSource);
    ok(resA.valid === false, 'tamper: mutating source.description is detected (outer digest mismatch)');
    ok(resA.outer.valid === false, 'tamper: outer.valid is false after mutating source.description');

    // (3b) Tamper with a nested attestation field (a chain step's description).
    const tamperedChain = JSON.parse(JSON.stringify(bom));
    tamperedChain.attestation.chain.steps[0].description = 'a forged step description';
    const resB = await verifyPersonalDataBom(tamperedChain);
    ok(resB.valid === false, 'tamper: mutating a nested attestation step is detected');
    ok(resB.attestation.valid === false, 'tamper: nested attestation digest mismatch is reported specifically');

    // (3c) Tamper with the distribution snapshot.
    const tamperedDist = JSON.parse(JSON.stringify(bom));
    tamperedDist.distribution.snapshot.billed_amount.mean = 999999;
    const resC = await verifyPersonalDataBom(tamperedDist);
    ok(resC.valid === false, 'tamper: mutating the distribution snapshot is detected');
  }

  // ============================================================
  // (4) Graceful degradation — missing optional inputs never fabricate data
  // ============================================================
  {
    const { chain, dataset } = await claimsFixture();
    const bom = await buildPersonalDataBom({ dataset, trail: chain.getTrail() }); // no distribution, no localModel
    ok(bom.distribution.computed === false && bom.distribution.snapshot === null, 'degrade: no distribution supplied -> computed:false, snapshot:null (never fabricated)');
    ok(bom.localModel.used === false && bom.localModel.modelId === null, 'degrade: no localModel supplied -> used:false, modelId:null (never fabricated)');
    const res = await verifyPersonalDataBom(bom);
    ok(res.valid === true, 'degrade: a minimal BOM (no distribution, no local model) still verifies true');

    const emptyChain = createProvenanceChain(); // never appended to
    const bomNoChain = await buildPersonalDataBom({ dataset, trail: emptyChain.getTrail() });
    ok(bomNoChain.attestation.chain.length === 0, 'degrade: an empty provenance chain produces a zero-length (not fabricated) attestation chain');
    const resNoChain = await verifyPersonalDataBom(bomNoChain);
    ok(resNoChain.valid === true, 'degrade: a BOM built from an empty chain still verifies true');
  }

  // ============================================================
  // (5) Honest labelling — never claims third-party notarization/signing
  // ============================================================
  {
    const { chain, dataset } = await claimsFixture();
    const bom = await buildPersonalDataBom({ dataset, trail: chain.getTrail() });
    ok(bom.notarization.notarized === false, 'honesty: notarization.notarized is always false');
    ok(bom.notarization.status === 'digest-ready-for-notarization', 'honesty: notarization.status uses the exact honest label, not "notarized" or "signed"');
    ok(!/\bsigned\b/i.test(bom.notarization.note) && !/\bnotarized\b(?!.*not)/i.test(bom.notarization.status.replace('digest-ready-for-notarization', '')), 'honesty: notarization.note never claims the artifact is cryptographically signed');
    ok(Array.isArray(bom.notarization.howToNotarize) && bom.notarization.howToNotarize.length > 0, 'honesty: independent notarization instructions are documented (OpenTimestamps / RFC-3161), mirroring provenance.js');
  }

  // ============================================================
  // (6) schemaSignature / schemaVersionHash — stable across re-derivation,
  //     and consistent with the equivalent function in validation.js's
  //     schemaSignature() (same [name,type] sorted-pair definition).
  // ============================================================
  {
    const cols = [{ name: 'b', type: 'VARCHAR' }, { name: 'a', type: 'BIGINT' }];
    const sigA = schemaSignature(cols);
    const sigB = schemaSignature([...cols].reverse()); // order-independent
    ok(sigA === sigB, 'schemaSignature: column order does not affect the signature (sorted pairs)');
    const hash1 = await schemaVersionHash(cols);
    const hash2 = await schemaVersionHash(cols);
    ok(hash1 === hash2, 'schemaVersionHash: deterministic given the same columns');
    const hashDifferentType = await schemaVersionHash([{ name: 'a', type: 'DOUBLE' }, { name: 'b', type: 'VARCHAR' }]);
    ok(hash1 !== hashDifferentType, 'schemaVersionHash: changes when a column type changes (a real schema-version bump)');
  }

  // ============================================================
  // (7) buildLocalModelRecord — the "used" flag actually gates the fields
  // ============================================================
  {
    const notUsed = buildLocalModelRecord({ modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', used: false });
    ok(notUsed.used === false && notUsed.modelId === null, 'localModelRecord: used:false blanks out modelId even if one was passed in (never fabricate usage)');
    const used = buildLocalModelRecord({ modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', modelLabel: 'Qwen2.5 1.5B Instruct (4-bit, ~1.1 GB)', used: true });
    ok(used.used === true && used.modelId === 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'localModelRecord: used:true carries the real model id through');
    ok(/on-device/i.test(used.note) && /no dataset content/i.test(used.note), 'localModelRecord: note discloses on-device/offline execution, no data sent anywhere');
  }

  // ============================================================
  // (8) HTML renderer — well-formed, references real values, no crash
  // ============================================================
  {
    const { chain, dataset, distribution } = await claimsFixture();
    const bom = await buildPersonalDataBom({ dataset, trail: chain.getTrail(), distribution });
    const html = renderPersonalDataBomHTML(bom);
    ok(html.startsWith('<!doctype html>'), 'html: renderer produces a well-formed HTML document');
    ok(html.includes('claim_id') && html.includes('billed_amount'), 'html: renderer lists the real column names');
    ok(html.includes(bom.digest.value), 'html: renderer surfaces the real digest value');
    ok(html.includes('digest-ready-for-notarization'), 'html: renderer surfaces the honest notarization status');
    ok(!html.includes('<script'), 'html: renderer emits no inline <script> (static certificate, not executable)');

    // XSS-style injection in a column name must not break out of its table cell.
    const evilDataset = { ...dataset, cols: [{ name: '<img src=x onerror=alert(1)>', type: 'VARCHAR' }] };
    const evilBom = await buildPersonalDataBom({ dataset: evilDataset, trail: chain.getTrail() });
    const evilHtml = renderPersonalDataBomHTML(evilBom);
    ok(!evilHtml.includes('<img src=x onerror=alert(1)>'), 'html: a malicious column name is HTML-escaped, not rendered as a live tag');
  }

  // ============================================================
  // (9) describeBomVerification — the plain-language mapping the "Verify Data
  //     BOM" button renders. Pure, DOM-free; it turns a verify result into a
  //     verdict + which-part-failed detail lines for a non-engineer analyst.
  //     Exercised here against REAL verify results (valid + each tamper class)
  //     so the UI text stays coupled to the verifier's actual output shape.
  // ============================================================
  {
    const { chain, dataset, distribution } = await claimsFixture();
    const bom = await buildPersonalDataBom({ dataset, trail: chain.getTrail(), distribution });

    const validDesc = describeBomVerification(await verifyPersonalDataBom(bom));
    ok(validDesc.ok === true, 'describe: a valid BOM maps to ok:true');
    ok(/has not been tampered with/i.test(validDesc.headline), 'describe: valid headline says the BOM was not tampered with');

    const tamperedSource = JSON.parse(JSON.stringify(bom));
    tamperedSource.source.description = 'a completely different dataset';
    const srcDesc = describeBomVerification(await verifyPersonalDataBom(tamperedSource));
    ok(srcDesc.ok === false, 'describe: an outer-tampered BOM maps to ok:false');
    ok(srcDesc.details.some(d => /source, schema, or column-distribution/i.test(d)),
      'describe: outer tamper is explained as a source/schema/distribution change, not jargon');
    ok(!srcDesc.details.some(d => /chain of custody/i.test(d)),
      'describe: an intact chain is NOT falsely reported as altered when only the outer digest failed');

    const tamperedChain = JSON.parse(JSON.stringify(bom));
    tamperedChain.attestation.chain.steps[0].description = 'a forged step description';
    const chainDesc = describeBomVerification(await verifyPersonalDataBom(tamperedChain));
    ok(chainDesc.ok === false, 'describe: a chain-tampered BOM maps to ok:false');
    ok(chainDesc.details.some(d => /chain of custody/i.test(d)),
      'describe: chain tamper is explained as a chain-of-custody alteration');

    // Robustness: a null/failed verify (e.g. verifyPersonalDataBom threw in the
    // caller) still produces a safe, non-throwing verdict rather than crashing.
    const nullDesc = describeBomVerification(null);
    ok(nullDesc.ok === false && Array.isArray(nullDesc.details),
      'describe: a null verify result degrades to a safe ok:false verdict, never throws');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
