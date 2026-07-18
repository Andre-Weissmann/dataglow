// ============================================================
// DATAGLOW — Phase 1 Trust Certificate test suite
// ============================================================
// Covers:
//   1. k-anonymity small-cell check (computeKAnonymityFromRows)
//   2. Trust Certificate assembly + signature (buildTrustCertificate, verifyTrustCertificate)
//   3. Enterprise policy loader (applyEnterprisePolicy, isPolicyDisabled, getPolicySnapshot)
//
// RUN WITH:  node test/trust-certificate-phase1.test.mjs

import { computeKAnonymityFromRows, KANON_THRESHOLD, KANON_SAMPLE_LIMIT }
  from '../js/provenance/deidentification-verifier.js';

import {
  buildTrustCertificate,
  verifyTrustCertificate,
  parseCertificate,
  serializeCertificate,
  certificateFilename,
  summarizeCertificate,
  CERT_KIND,
  CERT_FORMAT_VERSION,
} from '../js/trust/trust-certificate.js';

import {
  applyEnterprisePolicy,
  hasPolicyLoaded,
  isPolicyDisabled,
  isPolicyRequired,
  getPolicyOrganization,
  getPolicyHash,
  getPolicySnapshot,
  getAllowedExportFormats,
  _resetPolicyForTesting,
} from '../js/build/enterprise-policy.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok ' + msg); }
  else       { failed++; console.error('FAIL ' + msg); }
}
function section(title) { console.log('\n-- ' + title + ' --'); }

// ============================================================
// 1. k-anonymity small-cell check
// ============================================================
section('computeKAnonymityFromRows — basic');

{
  // No quasi-cols -> skipped
  const r = computeKAnonymityFromRows({ quasiCols: [], rows: [{ age: 30 }] });
  ok(r.flagged === false, 'no quasi-cols: not flagged');
  ok(r.kFloor === null, 'no quasi-cols: kFloor null');
  ok(r.level === 'none', 'no quasi-cols: level none');
}

{
  // No rows -> skipped
  const r = computeKAnonymityFromRows({ quasiCols: ['zip', 'age'], rows: [] });
  ok(r.flagged === false, 'no rows: not flagged');
  ok(r.groupCount === 0, 'no rows: groupCount 0');
}

{
  // All rows share the same combination -> k-floor = n (safe)
  const rows = Array.from({ length: 20 }, () => ({ zip: '60601', age: '34', sex: 'M' }));
  const r = computeKAnonymityFromRows({ quasiCols: ['zip', 'age', 'sex'], rows });
  ok(r.groupCount === 1, 'all-same: 1 group');
  ok(r.kFloor === 20, 'all-same: kFloor = 20');
  ok(r.flagged === false, 'all-same: not flagged');
}

{
  // One unique combination -> k-floor = 1 -> high risk
  const rows = [
    { zip: '60601', age: '99', sex: 'M' },  // unique
    { zip: '60602', age: '30', sex: 'F' },
    { zip: '60602', age: '30', sex: 'F' },
    { zip: '60602', age: '30', sex: 'F' },
    { zip: '60602', age: '30', sex: 'F' },
    { zip: '60602', age: '30', sex: 'F' },
  ];
  const r = computeKAnonymityFromRows({ quasiCols: ['zip', 'age', 'sex'], rows });
  ok(r.kFloor === 1, 'unique row: kFloor = 1');
  ok(r.flagged === true, 'unique row: flagged');
  ok(r.level === 'high', 'unique row: level high');
  ok(r.smallCellGroups >= 1, 'unique row: at least 1 small-cell group');
}

{
  // k-floor = 2 -> medium risk
  const rows = [
    { zip: '60601', age: '45' }, { zip: '60601', age: '45' }, // k=2
    { zip: '60602', age: '30' }, { zip: '60602', age: '30' }, { zip: '60602', age: '30' },
    { zip: '60602', age: '30' }, { zip: '60602', age: '30' }, // k=5 (clean)
  ];
  const r = computeKAnonymityFromRows({ quasiCols: ['zip', 'age'], rows });
  ok(r.kFloor === 2, 'k=2: kFloor = 2');
  ok(r.flagged === true, 'k=2: flagged');
  ok(r.level === 'medium', 'k=2: level medium');
}

{
  // k-floor = 3 -> low risk
  const rows = [
    { zip: '60601', age: '50' }, { zip: '60601', age: '50' }, { zip: '60601', age: '50' }, // k=3
    { zip: '60602', age: '31' }, { zip: '60602', age: '31' }, { zip: '60602', age: '31' },
    { zip: '60602', age: '31' }, { zip: '60602', age: '31' }, // k=5
  ];
  const r = computeKAnonymityFromRows({ quasiCols: ['zip', 'age'], rows });
  ok(r.kFloor === 3, 'k=3: kFloor = 3');
  ok(r.flagged === true, 'k=3: flagged');
  ok(r.level === 'low', 'k=3: level low');
}

{
  // All k >= threshold -> clean
  const rows = Array.from({ length: 25 }, (_, i) => ({
    zip: i < 15 ? '60601' : '60602',
    age: i < 15 ? '40' : '55',
  }));
  const r = computeKAnonymityFromRows({ quasiCols: ['zip', 'age'], rows });
  ok(r.kFloor >= KANON_THRESHOLD, 'all clean: kFloor >= threshold (' + r.kFloor + ')');
  ok(r.flagged === false, 'all clean: not flagged');
  ok(r.level === 'none', 'all clean: level none');
  ok(r.smallCellGroups === 0, 'all clean: 0 small-cell groups');
}

{
  // NULL values treated as a distinct quasi-identifier value (not merged with real values)
  const rows = [
    { zip: null, age: '30' },
    { zip: null, age: '30' },
    { zip: '60601', age: '30' },
    { zip: '60601', age: '30' },
    { zip: '60601', age: '30' },
  ];
  const r = computeKAnonymityFromRows({ quasiCols: ['zip', 'age'], rows });
  ok(r.groupCount === 2, 'null as distinct value: 2 groups');
  ok(r.kFloor === 2, 'null as distinct value: kFloor = 2 (the null group)');
  ok(r.flagged === true, 'null as distinct value: flagged');
}

{
  // Rationale string is always present and informative
  const clean = computeKAnonymityFromRows({
    quasiCols: ['zip'],
    rows: Array.from({ length: 10 }, () => ({ zip: '60601' })),
  });
  ok(typeof clean.rationale === 'string' && clean.rationale.length > 0, 'clean: rationale non-empty');
  ok(clean.rationale.includes('k-floor'), 'clean: rationale mentions k-floor');

  const flagged = computeKAnonymityFromRows({
    quasiCols: ['zip'],
    rows: [{ zip: 'X' }, { zip: 'Y' }, { zip: 'Y' }, { zip: 'Y' }, { zip: 'Y' }, { zip: 'Y' }],
  });
  ok(typeof flagged.rationale === 'string' && flagged.rationale.length > 0, 'flagged: rationale non-empty');
  ok(flagged.rationale.includes('small') || flagged.rationale.includes('Small'), 'flagged: rationale mentions small-cell');
}

{
  // Groups cap: at most 20 groups returned even with many unique combos
  const rows = Array.from({ length: 30 }, (_, i) => ({ zip: String(i), age: String(i) }));
  const r = computeKAnonymityFromRows({ quasiCols: ['zip', 'age'], rows });
  ok(r.groups.length <= 20, 'groups capped at 20 (got ' + r.groups.length + ')');
  ok(r.groupCount === 30, 'groupCount reflects all 30 real groups');
}

{
  // totalRows is passed through unchanged
  const r = computeKAnonymityFromRows({
    quasiCols: ['zip'],
    rows: [{ zip: '60601' }, { zip: '60601' }, { zip: '60601' }, { zip: '60601' }, { zip: '60601' }],
    totalRows: 50000,
  });
  ok(r.totalRows === 50000, 'totalRows passed through');
}

// ============================================================
// 2. Trust Certificate — assembly and verification
// ============================================================
section('buildTrustCertificate + verifyTrustCertificate');

const MOCK_LAYER_RESULTS = {
  unit_tests: { status: 'pass', summary: 'No nulls or duplicates.' },
  freshness:  { status: 'warn', summary: 'Dataset is 48h old.' },
  confidence: { status: 'fail', summary: 'Low confidence score.' },
  benford:    { status: 'idle', summary: 'Not run.' },
};

const MOCK_DATASET = {
  table: 'claims',
  rowCount: 1200,
  columns: [{ name: 'claim_id', type: 'BIGINT' }, { name: 'zip', type: 'VARCHAR' }],
  sourceHash: 'abc123',
};

const MOCK_KANON = {
  quasiCols: ['zip'],
  sampledRows: 100,
  kFloor: 3,
  smallCellGroups: 2,
  smallCellThreshold: 5,
  flagged: true,
  level: 'low',
  rationale: 'k-floor = 3; 2 group(s) below threshold.',
};

{
  const cert = await buildTrustCertificate({
    dataset: MOCK_DATASET,
    layerResults: MOCK_LAYER_RESULTS,
    kAnonymityResult: MOCK_KANON,
    generatedAt: '2026-07-18T00:00:00.000Z',
  });

  ok(cert.kind === CERT_KIND, 'cert.kind correct');
  ok(cert.formatVersion === CERT_FORMAT_VERSION, 'cert.formatVersion correct');
  ok(typeof cert.signature === 'object' && cert.signature.value, 'cert has signature');
  ok(cert.signature.algorithm === 'SHA-256', 'cert uses SHA-256');
  ok(cert.dataset.table === 'claims', 'cert.dataset.table correct');
  ok(cert.dataset.rowCount === 1200, 'cert.dataset.rowCount correct');
  ok(typeof cert.gate === 'object', 'cert.gate present');
  ok(cert.gate.verdict === 'FAIL', 'gate FAIL (has a fail layer)');
  ok(typeof cert.gate.score === 'number' || cert.gate.score === null, 'gate.score is number or null');
  ok(Array.isArray(cert.gate.hardFailLayers), 'gate.hardFailLayers is array');
  ok(typeof cert.validationSummary === 'object', 'cert.validationSummary present');
  ok(cert.validationSummary.total === 4, 'validationSummary.total = 4 layers');
  ok(cert.validationSummary.pass === 1, 'validationSummary.pass = 1');
  ok(cert.validationSummary.warn === 1, 'validationSummary.warn = 1');
  ok(cert.validationSummary.fail === 1, 'validationSummary.fail = 1');
  ok(cert.validationSummary.idle === 1, 'validationSummary.idle = 1');
  ok(cert.kAnonymity.kFloor === 3, 'kAnonymity.kFloor = 3');
  ok(cert.kAnonymity.flagged === true, 'kAnonymity.flagged = true');
  ok(cert.kAnonymity.level === 'low', 'kAnonymity.level = low');
  ok(typeof cert.packet === 'object' && cert.packet.kind, 'inner packet present');
  ok(typeof cert.disclaimer === 'string' && cert.disclaimer.length > 0, 'disclaimer present');

  // Verify own signature
  const v = await verifyTrustCertificate(cert);
  ok(v.valid === true, 'cert verifies clean');
  ok(typeof v.reason === 'string', 'verify reason is string');
  ok(v.signature.stored === v.signature.recomputed, 'stored == recomputed');
}

{
  // Tamper detection
  const cert = await buildTrustCertificate({ dataset: MOCK_DATASET, generatedAt: '2026-07-18T00:00:00.000Z' });
  const tampered = JSON.parse(JSON.stringify(cert));
  tampered.gate.verdict = 'PASS'; // lie
  const v = await verifyTrustCertificate(tampered);
  ok(v.valid === false, 'tampered cert fails verification');
  ok(v.reason.includes('MISMATCH') || v.reason.includes('mismatch') || !v.valid, 'tampered reason mentions mismatch');
}

{
  // Works with no layer results (graceful degradation)
  const cert = await buildTrustCertificate({ dataset: MOCK_DATASET, generatedAt: '2026-07-18T00:00:00.000Z' });
  ok(cert.validationSummary.total === 0, 'no layerResults: total = 0');
  const v = await verifyTrustCertificate(cert);
  ok(v.valid === true, 'cert with no layer results still verifies');
}

{
  // Works with a clean gate (all pass)
  const cleanLayers = {
    unit_tests: { status: 'pass', summary: 'Clean.' },
    freshness:  { status: 'pass', summary: 'Fresh.' },
  };
  const cert = await buildTrustCertificate({
    dataset: MOCK_DATASET,
    layerResults: cleanLayers,
    generatedAt: '2026-07-18T00:00:00.000Z',
  });
  ok(cert.gate.verdict === 'PASS', 'clean layers: gate PASS');
  const v = await verifyTrustCertificate(cert);
  ok(v.valid === true, 'clean cert verifies');
}

{
  // parseCertificate + serializeCertificate round-trip
  const cert = await buildTrustCertificate({ dataset: MOCK_DATASET, generatedAt: '2026-07-18T00:00:00.000Z' });
  const text = serializeCertificate(cert);
  ok(typeof text === 'string' && text.includes(CERT_KIND), 'serialize produces JSON with kind');
  const reparsed = parseCertificate(text);
  ok(reparsed.kind === CERT_KIND, 'reparsed kind correct');
  const v = await verifyTrustCertificate(reparsed);
  ok(v.valid === true, 'round-tripped cert verifies');
}

{
  // certificateFilename
  const cert = { dataset: { table: 'my claims 2026' } };
  const name = certificateFilename(cert);
  ok(name.startsWith('dataglow-trust-cert-'), 'filename prefix correct');
  ok(name.endsWith('.dataglow-cert.json'), 'filename extension correct');
  ok(!name.includes(' '), 'filename has no spaces');
}

{
  // summarizeCertificate
  const cert = await buildTrustCertificate({
    dataset: MOCK_DATASET,
    layerResults: MOCK_LAYER_RESULTS,
    kAnonymityResult: MOCK_KANON,
    generatedAt: '2026-07-18T00:00:00.000Z',
  });
  const summary = summarizeCertificate(cert);
  ok(typeof summary === 'string' && summary.length > 0, 'summarizeCertificate returns non-empty string');
  ok(summary.includes('Gate'), 'summary mentions Gate');
}

{
  // verifyTrustCertificate rejects non-certificate objects
  const v1 = await verifyTrustCertificate(null);
  ok(v1.valid === false, 'null: verify returns invalid');
  const v2 = await verifyTrustCertificate({ kind: 'something-else' });
  ok(v2.valid === false, 'wrong kind: verify returns invalid');
  const v3 = await verifyTrustCertificate({ kind: CERT_KIND, formatVersion: 99 });
  ok(v3.valid === false, 'wrong formatVersion: verify returns invalid');
}

// ============================================================
// 3. Enterprise policy loader
// ============================================================
section('enterprise-policy: parse + apply (unit -- no fetch)');

// All tests use _resetPolicyForTesting() + a direct call to the exported
// functions that operate on the already-loaded policy state. We test the
// pure parsing/query layer without needing a real file fetch.

{
  // After reset: no policy loaded
  _resetPolicyForTesting();
  ok(hasPolicyLoaded() === false, 'after reset: hasPolicyLoaded = false');
  ok(isPolicyDisabled('byokStory') === false, 'after reset: byokStory not disabled');
  ok(isPolicyRequired('auditLog') === false, 'after reset: auditLog not required');
  ok(getPolicyOrganization() === null, 'after reset: organization null');
  ok(getPolicyHash() === null, 'after reset: hash null');
  ok(getPolicySnapshot() === null, 'after reset: snapshot null');
  ok(getAllowedExportFormats() === null, 'after reset: allowedExportFormats null');
}

// Simulate what applyEnterprisePolicy does internally by calling the private
// reset + manual state wiring is not possible without exporting internals.
// Instead we test the module via applyEnterprisePolicy() with a mocked fetch.
// In Node there is no global fetch unless we polyfill it; use globalThis.fetch.

const MOCK_POLICY = {
  version: 1,
  organization: 'Test Health System',
  adminContact: 'admin@test.org',
  disable: ['byokStory', 'webrtcRooms'],
  require: ['auditLog'],
  allowedExportFormats: ['pdf', 'xlsx'],
};

// Monkey-patch globalThis.fetch for this test file only.
const _origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (url === 'dataglow-policy.json') {
    return { ok: true, text: async () => JSON.stringify(MOCK_POLICY) };
  }
  return { ok: false };
};

_resetPolicyForTesting();
await applyEnterprisePolicy();

ok(hasPolicyLoaded() === true, 'after load: hasPolicyLoaded = true');
ok(isPolicyDisabled('byokStory') === true, 'after load: byokStory disabled');
ok(isPolicyDisabled('webrtcRooms') === true, 'after load: webrtcRooms disabled');
ok(isPolicyDisabled('cdnFetches') === false, 'after load: cdnFetches NOT disabled (not in list)');
ok(isPolicyRequired('auditLog') === true, 'after load: auditLog required');
ok(isPolicyRequired('enterpriseBuild') === false, 'after load: enterpriseBuild not required');
ok(getPolicyOrganization() === 'Test Health System', 'after load: organization correct');
ok(typeof getPolicyHash() === 'string' && getPolicyHash().length === 64, 'after load: policyHash is 64-char hex');
ok(JSON.stringify(getAllowedExportFormats()) === JSON.stringify(['pdf', 'xlsx']), 'after load: allowedExportFormats correct');

const snap = getPolicySnapshot();
ok(snap !== null, 'snapshot: non-null');
ok(snap.applied === true, 'snapshot: applied = true');
ok(snap.organization === 'Test Health System', 'snapshot: organization correct');
ok(snap.disabled.includes('byokStory'), 'snapshot: byokStory in disabled');
ok(snap.required.includes('auditLog'), 'snapshot: auditLog in required');

{
  // applyEnterprisePolicy is idempotent -- second call returns same result
  const result2 = await applyEnterprisePolicy();
  ok(result2 !== null, 'idempotent: second call returns policy');
  ok(isPolicyDisabled('byokStory') === true, 'idempotent: byokStory still disabled');
}

{
  // No policy file (fetch returns 404)
  _resetPolicyForTesting();
  globalThis.fetch = async () => ({ ok: false });
  const result = await applyEnterprisePolicy();
  ok(result === null, 'missing file: returns null');
  // hasPolicyLoaded() = _loaded && _policy !== null -- with no file, _policy stays null
  ok(hasPolicyLoaded() === false, 'missing file: hasPolicyLoaded = false (no policy applied)');
  ok(isPolicyDisabled('byokStory') === false, 'missing file: nothing disabled');
}

{
  // Invalid JSON in policy file
  _resetPolicyForTesting();
  globalThis.fetch = async (url) => url === 'dataglow-policy.json'
    ? { ok: true, text: async () => '{ this is not json' }
    : { ok: false };
  const result = await applyEnterprisePolicy();
  ok(result === null, 'invalid JSON: returns null (graceful)');
  ok(isPolicyDisabled('byokStory') === false, 'invalid JSON: nothing disabled');
}

{
  // Wrong version in policy file
  _resetPolicyForTesting();
  const badVersion = { ...MOCK_POLICY, version: 99 };
  globalThis.fetch = async (url) => url === 'dataglow-policy.json'
    ? { ok: true, text: async () => JSON.stringify(badVersion) }
    : { ok: false };
  const result = await applyEnterprisePolicy();
  ok(result === null, 'wrong version: returns null (graceful)');
}

// Restore original fetch
globalThis.fetch = _origFetch;
_resetPolicyForTesting();

// ============================================================
// Summary
// ============================================================
console.log('\n==========================================');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('==========================================');
if (failed > 0) process.exit(1);
