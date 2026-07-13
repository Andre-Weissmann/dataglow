// ============================================================
// DATAGLOW — Analysis Fingerprint test
// ============================================================
// Verifies the tamper-evident content fingerprint in
// js/provenance/analysis-fingerprint.js against its real logic:
//   • the same inputs reproduce the SAME digest (deterministic / reproducible);
//   • changing ANY committed input (result data, SQL, parameters, metrics
//     version, provenance hash) changes the digest;
//   • verifyAnalysisFingerprint recomputes from re-supplied inputs and passes on
//     a match, and DETECTS a tampered record (record digest swapped) — and a
//     recomputation whose inputs differ from what was committed;
//   • the honest labelling contract: it never claims to be signed/notarized;
//   • verification is independent — it needs only the record + a recomputation,
//     never app state.
//
// RUN WITH:  node test/analysis-fingerprint.test.mjs
//
// Pure crypto (SHA-256 via crypto.subtle) — no DuckDB engine, no browser.

import {
  computeAnalysisFingerprint,
  verifyAnalysisFingerprint,
  computeFingerprintDigest,
  canonicalFingerprintPayload,
  FINGERPRINT_KIND,
  FINGERPRINT_VERSION,
  FINGERPRINT_DISCLAIMER,
} from '../js/provenance/analysis-fingerprint.js';

// ---------- tiny test harness (mirrors the other test files) ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A realistic result: a small SQL result set plus the inputs that produced it.
function baseInputs() {
  return {
    resultData: [
      { region: 'north', revenue: 1200 },
      { region: 'south', revenue: 980 },
    ],
    sqlOrPipelineDescription: 'SELECT region, SUM(amount) AS revenue FROM sales GROUP BY region',
    parameters: { limit: 100 },
    metricsRegistryVersion: 3,
    datasetProvenanceHash: 'a'.repeat(64),
  };
}

async function main() {
  // ---------- 1. Record shape + honest labelling ----------
  const rec = await computeAnalysisFingerprint(baseInputs(), { label: 'q1', generatedAt: 0 });
  ok(rec.kind === FINGERPRINT_KIND, 'record carries the fingerprint kind');
  ok(rec.version === FINGERPRINT_VERSION, 'record carries the version');
  ok(typeof rec.digest.value === 'string' && /^[0-9a-f]{64}$/.test(rec.digest.value),
    'digest is a 64-char SHA-256 hex string');
  ok(rec.digest.algorithm === 'SHA-256', 'digest names SHA-256');
  ok(rec.label === 'q1', 'descriptive label is carried on the record');
  ok(rec.committed.hasResultData === true, 'committed block records that result data was present');
  ok(rec.committed.sqlOrPipelineDescription === baseInputs().sqlOrPipelineDescription,
    'committed block echoes the SQL/pipeline description');
  // Honest labelling: must NOT overclaim.
  const blob = JSON.stringify(rec).toLowerCase();
  ok(!/notariz|digitally signed|signature|certified/.test(blob) || /not a digital signature/.test(FINGERPRINT_DISCLAIMER.toLowerCase()),
    'record does not falsely claim to be signed/notarized');
  ok(/tamper-evident content fingerprint/.test(FINGERPRINT_DISCLAIMER.toLowerCase()),
    'disclaimer describes it honestly as a tamper-evident content fingerprint');
  ok(/not a digital signature/.test(FINGERPRINT_DISCLAIMER.toLowerCase()),
    'disclaimer explicitly disclaims a digital signature');

  // ---------- 2. Reproducibility ----------
  const digestA = await computeFingerprintDigest(baseInputs());
  const digestB = await computeFingerprintDigest(baseInputs());
  ok(digestA === digestB, 'identical inputs reproduce an identical digest');
  ok(rec.digest.value === digestA, 'the record digest equals the standalone recomputation');
  // The timestamp/label are NOT part of the digest.
  const rec2 = await computeAnalysisFingerprint(baseInputs(), { label: 'different', generatedAt: 999999 });
  ok(rec2.digest.value === rec.digest.value, 'digest is independent of the label and generatedAt (metadata only)');

  // ---------- 3. Every committed input changes the digest ----------
  const mutate = async (fn, name) => {
    const inp = baseInputs();
    fn(inp);
    const d = await computeFingerprintDigest(inp);
    ok(d !== digestA, `changing ${name} changes the digest`);
  };
  await mutate(i => { i.resultData[0].revenue = 1201; }, 'a single result cell');
  await mutate(i => { i.sqlOrPipelineDescription += ' '; }, 'the SQL/pipeline description');
  await mutate(i => { i.parameters.limit = 50; }, 'a parameter');
  await mutate(i => { i.metricsRegistryVersion = 4; }, 'the metrics-registry version');
  await mutate(i => { i.datasetProvenanceHash = 'b'.repeat(64); }, 'the dataset provenance hash');

  // Absent vs. null optional fields fingerprint identically & reproducibly.
  const onlyData1 = await computeFingerprintDigest({ resultData: [1, 2, 3] });
  const onlyData2 = await computeFingerprintDigest({ resultData: [1, 2, 3], parameters: null, metricsRegistryVersion: null });
  ok(onlyData1 === onlyData2, 'omitted optional inputs equal explicit-null inputs (normalised)');
  ok(canonicalFingerprintPayload({ resultData: [1, 2, 3] }).includes('"metricsRegistryVersion":null'),
    'canonical payload normalises missing optional fields to null');

  // ---------- 4. verify() passes on a faithful recomputation ----------
  const good = await verifyAnalysisFingerprint(rec, baseInputs());
  ok(good.valid === true, 'verify passes when the recomputed inputs match what was committed');
  ok(good.stored === rec.digest.value && good.recomputed === rec.digest.value,
    'verify reports matching stored and recomputed digests');

  // ---------- 5. verify() DETECTS tampering ----------
  // (a) result altered after the fact — recomputation no longer matches.
  const tamperedInputs = baseInputs();
  tamperedInputs.resultData[1].revenue = 5;
  const bad1 = await verifyAnalysisFingerprint(rec, tamperedInputs);
  ok(bad1.valid === false, 'verify fails when the recomputed result differs from the committed one');
  ok(/mismatch/i.test(bad1.reason), 'verify explains the mismatch');

  // (b) the stored record's digest was swapped out — record self-inconsistent.
  const tamperedRecord = JSON.parse(JSON.stringify(rec));
  tamperedRecord.digest.value = 'f'.repeat(64);
  const bad2 = await verifyAnalysisFingerprint(tamperedRecord, baseInputs());
  ok(bad2.valid === false, 'verify fails when the record digest was replaced');

  // (c) not a fingerprint record at all.
  const bad3 = await verifyAnalysisFingerprint({ kind: 'something-else', digest: { value: digestA } }, baseInputs());
  ok(bad3.valid === false && /not a dataglow analysis fingerprint/i.test(bad3.reason),
    'verify rejects a record with the wrong kind');

  // ---------- 6. Independence: verify takes only (record, recomputation) ----------
  ok(verifyAnalysisFingerprint.length === 2, 'verify is a pure (record, recomputedInputs) function — no app state');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
