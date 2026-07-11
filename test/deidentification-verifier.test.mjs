// ============================================================
// DATAGLOW — De-identification Verifier test suite
// ============================================================
// Covers the pure, offline logic behind the one-click HIPAA Safe Harbor
// de-identification checker + re-identification risk score + signed attestation
// (js/provenance/deidentification-verifier.js). Every unit under test is pure JS
// operating on an in-memory { columns, samples } snapshot, so it needs no DuckDB
// and no browser; the async DuckDB wrapper is exercised against a tiny FAKE
// engine. The signed attestation reuses the EXISTING SHA-256 primitive from
// js/provenance/provenance.js — no new crypto is introduced.
//
// RUN WITH:  node test/deidentification-verifier.test.mjs

import {
  HIPAA_SAFE_HARBOR,
  checkSafeHarbor,
  scoreReidentificationRisk,
  buildDeidReport,
  buildDeidAttestation,
  computeDeidDigest,
  verifyDeidAttestation,
  runDeidentificationCheck,
} from '../js/provenance/deidentification-verifier.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A deliberately identifier-heavy dataset snapshot.
const PHI = {
  columns: [
    { name: 'patient_name', type: 'VARCHAR' },
    { name: 'email', type: 'VARCHAR' },
    { name: 'ssn', type: 'VARCHAR' },
    { name: 'zip', type: 'VARCHAR' },
    { name: 'date_of_birth', type: 'DATE' },
    { name: 'age', type: 'INTEGER' },
    { name: 'sex', type: 'VARCHAR' },
    { name: 'phone', type: 'VARCHAR' },
    { name: 'ip_address', type: 'VARCHAR' },
    { name: 'mrn', type: 'VARCHAR' },
    { name: 'systolic_bp', type: 'INTEGER' },
  ],
  samples: {
    patient_name: ['Jane Doe', 'John Smith'],
    email: ['a@b.com', 'c@d.org'],
    ssn: ['123-45-6789', '987-65-4321'],
    zip: ['02138', '90210'],
    date_of_birth: ['1980-04-01', '1975-12-30'],
    age: [44, 91, 33], // includes an age > 89
    sex: ['F', 'M'],
    phone: ['(617) 555-1234', '212-555-9999'],
    ip_address: ['192.168.0.1', '10.0.0.5'],
    mrn: ['MRN0001', 'MRN0002'],
    systolic_bp: [120, 130],
  },
};

// A dataset with no direct identifiers at all.
const CLEAN = {
  columns: [
    { name: 'measurement_kind', type: 'VARCHAR' },
    { name: 'value', type: 'DOUBLE' },
    { name: 'unit', type: 'VARCHAR' },
  ],
  samples: {
    measurement_kind: ['glucose', 'sodium'],
    value: [5.4, 140],
    unit: ['mmol/L', 'mmol/L'],
  },
};

async function main() {
  // ============================================================
  // 1) The 18 categories are all present and well-formed
  // ============================================================
  ok(Array.isArray(HIPAA_SAFE_HARBOR) && HIPAA_SAFE_HARBOR.length === 18,
    'HIPAA_SAFE_HARBOR: exactly the 18 Safe Harbor identifier categories');
  ok(HIPAA_SAFE_HARBOR.every(c => c.id && c.label && typeof c.n === 'number'),
    'HIPAA_SAFE_HARBOR: every category has id/label/number');
  const ns = HIPAA_SAFE_HARBOR.map(c => c.n).sort((a, b) => a - b);
  ok(ns.join(',') === Array.from({ length: 18 }, (_, i) => i + 1).join(','),
    'HIPAA_SAFE_HARBOR: numbered 1..18 with no gaps or duplicates');

  // ============================================================
  // 2) checkSafeHarbor — flags identifiers, clears the rest
  // ============================================================
  const sh = checkSafeHarbor(PHI);
  ok(Array.isArray(sh.categories) && sh.categories.length === 18,
    'checkSafeHarbor: one result per category');
  const byId = Object.fromEntries(sh.categories.map(c => [c.id, c]));
  ok(byId.names.status === 'flag' && byId.names.matchedColumns.some(m => m.column === 'patient_name'),
    'checkSafeHarbor: flags names (patient_name)');
  ok(byId.email.status === 'flag', 'checkSafeHarbor: flags email addresses');
  ok(byId.ssn.status === 'flag', 'checkSafeHarbor: flags SSN');
  ok(byId.telephone.status === 'flag', 'checkSafeHarbor: flags telephone numbers');
  ok(byId.ip.status === 'flag' && byId.ip.matchedColumns.some(m => m.column === 'ip_address'),
    'checkSafeHarbor: flags IP addresses');
  ok(byId.geo.status === 'flag', 'checkSafeHarbor: flags geographic subdivisions (zip)');
  ok(byId.dates.status === 'flag', 'checkSafeHarbor: flags dates / ages over 89');
  ok(byId.dates.matchedColumns.some(m => /89|age/i.test(m.reason)),
    'checkSafeHarbor: dates category calls out an age over 89');
  ok(byId.mrn.status === 'flag', 'checkSafeHarbor: flags medical record numbers');
  ok(sh.flaggedCount >= 8 && sh.clearCount === 18 - sh.flaggedCount,
    'checkSafeHarbor: flagged + clear counts partition the 18 categories');

  const shClean = checkSafeHarbor(CLEAN);
  ok(shClean.flaggedCount === 0 && shClean.categories.every(c => c.status === 'clear'),
    'checkSafeHarbor: a non-PHI dataset clears every category');

  // Value-based detection catches a mislabeled column (email values under a
  // generic column name).
  const sneaky = checkSafeHarbor({
    columns: [{ name: 'contact', type: 'VARCHAR' }],
    samples: { contact: ['x@y.com', 'z@w.net'] },
  });
  ok(Object.fromEntries(sneaky.categories.map(c => [c.id, c])).email.status === 'flag',
    'checkSafeHarbor: value patterns catch identifiers hiding under a generic column name');

  // ============================================================
  // 3) scoreReidentificationRisk — quasi-identifier combination
  // ============================================================
  const risk = scoreReidentificationRisk(PHI);
  ok(risk.level === 'high', 'scoreReidentificationRisk: age + sex + zip + dob → high risk');
  ok(risk.present.includes('age') && risk.present.includes('sex') && risk.present.includes('zip'),
    'scoreReidentificationRisk: lists the quasi-identifiers it found');
  ok(risk.score >= 0 && risk.score <= 100, 'scoreReidentificationRisk: score is bounded 0..100');

  const lowRisk = scoreReidentificationRisk(CLEAN);
  ok(lowRisk.level === 'low' && lowRisk.present.length === 0,
    'scoreReidentificationRisk: no quasi-identifiers → low risk');

  const oneQuasi = scoreReidentificationRisk({
    columns: [{ name: 'age', type: 'INTEGER' }, { name: 'value', type: 'DOUBLE' }],
    samples: { age: [40, 50], value: [1, 2] },
  });
  ok(oneQuasi.level !== 'high', 'scoreReidentificationRisk: a single quasi-identifier is not high risk');

  // ============================================================
  // 4) buildDeidReport — combined verdict
  // ============================================================
  const report = buildDeidReport({ ...PHI, table: 'patients', rowCount: 1000 });
  ok(report.safeHarbor && report.reidentification, 'buildDeidReport: bundles both checks');
  ok(report.verdict === 'fail', 'buildDeidReport: identifiers present → overall verdict fail');
  ok(buildDeidReport({ ...CLEAN, table: 't', rowCount: 10 }).verdict === 'pass',
    'buildDeidReport: no identifiers + low risk → verdict pass');

  // ============================================================
  // 5) buildDeidAttestation / verifyDeidAttestation — signed record
  // ============================================================
  const att = await buildDeidAttestation(report, { table: 'patients', rowCount: 1000 });
  ok(att.kind === 'dataglow-deidentification-attestation' && att.version >= 1,
    'buildDeidAttestation: self-describing kind + version');
  ok(att.digest && att.digest.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(att.digest.value),
    'buildDeidAttestation: carries a SHA-256 digest over its canonical core');
  ok(att.dataset && Array.isArray(att.dataset.columns) && att.dataset.columns.length === PHI.columns.length,
    'buildDeidAttestation: signs over the dataset STRUCTURE (column names + types)');

  const recomputed = await computeDeidDigest(att);
  ok(recomputed === att.digest.value, 'computeDeidDigest: digest recomputes to the stored value');

  const good = await verifyDeidAttestation(att);
  ok(good.valid, 'verifyDeidAttestation: a freshly built attestation verifies');

  const tampered = JSON.parse(JSON.stringify(att));
  tampered.reidentification.level = 'low'; // downgrade the recorded risk
  const bad = await verifyDeidAttestation(tampered);
  ok(!bad.valid, 'verifyDeidAttestation: tampering with the results breaks the digest');

  const tampered2 = JSON.parse(JSON.stringify(att));
  tampered2.dataset.columns.push({ name: 'injected', type: 'VARCHAR' });
  const bad2 = await verifyDeidAttestation(tampered2);
  ok(!bad2.valid, 'verifyDeidAttestation: tampering with the dataset structure breaks the digest');

  const notOurs = await verifyDeidAttestation({ kind: 'something-else' });
  ok(!notOurs.valid && /not a dataglow/i.test(notOurs.reason),
    'verifyDeidAttestation: rejects a foreign document by kind');

  // ============================================================
  // 6) runDeidentificationCheck — DuckDB wrapper against a fake engine
  // ============================================================
  const fakeEngine = {
    async getRowCount() { return 2; },
    async runQuery(sql) {
      // The wrapper asks for a small sample per column; return canned values.
      const m = sql.match(/SELECT\s+"([^"]+)"/i);
      const col = m ? m[1] : null;
      const vals = (PHI.samples[col] || []).map(v => ({ [col]: v }));
      return { rows: vals };
    },
  };
  const live = await runDeidentificationCheck('patients', PHI.columns, fakeEngine);
  ok(live.report && live.attestation, 'runDeidentificationCheck: returns a report + signed attestation');
  ok(live.report.verdict === 'fail', 'runDeidentificationCheck: end-to-end flags the PHI dataset');
  ok((await verifyDeidAttestation(live.attestation)).valid,
    'runDeidentificationCheck: the attestation it emits verifies');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
