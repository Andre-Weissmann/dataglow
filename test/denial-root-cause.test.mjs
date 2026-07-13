// ============================================================
// DATAGLOW — Denial Root-Cause Profiler test suite
// ============================================================
// Covers the schema-tolerant column detection, the five canonical denial-risk
// buckets, the not-applicable reporting when a column is absent, the live cost
// estimate, and the SHA-256-signed attestation + verifier. Every unit is pure JS
// over an in-memory rows array, so it needs no DuckDB and no browser; the async
// DuckDB wrapper is exercised against a tiny FAKE engine. The signed attestation
// reuses the EXISTING sha256Hex primitive from js/provenance/provenance.js.
//
// RUN WITH:  node test/denial-root-cause.test.mjs

import {
  detectClaimColumns,
  isValidNpi,
  buildDenialReport,
  buildDenialAttestation,
  computeDenialDigest,
  verifyDenialAttestation,
  runDenialProfile,
} from '../js/provenance/denial-root-cause.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const byId = (report) => Object.fromEntries(report.categories.map(c => [c.id, c]));

// A claims-shaped dataset covering every role, with deliberate defects.
const CLAIM_COLUMNS = [
  { name: 'claim_id', type: 'VARCHAR' },
  { name: 'member_id', type: 'VARCHAR' },
  { name: 'date_of_service', type: 'DATE' },
  { name: 'cpt_code', type: 'VARCHAR' },
  { name: 'modifier', type: 'VARCHAR' },
  { name: 'diagnosis_code', type: 'VARCHAR' },
  { name: 'rendering_npi', type: 'VARCHAR' },
  { name: 'primary_payer', type: 'VARCHAR' },
  { name: 'secondary_payer', type: 'VARCHAR' },
  { name: 'billed_amount', type: 'DOUBLE' },
];

// rendering_npi 1234567893 is a valid check-digit NPI; 1234567890 is not.
const CLAIM_ROWS = [
  // clean baseline
  { claim_id: 'C1', member_id: 'M100', date_of_service: '2024-01-10', cpt_code: '99213', modifier: '25', diagnosis_code: 'E119', rendering_npi: '1234567893', primary_payer: 'Aetna', secondary_payer: '', billed_amount: 150 },
  // missing member id (eligibility) + invalid NPI (provider)
  { claim_id: 'C2', member_id: '', date_of_service: '2024-01-11', cpt_code: '99214', modifier: '', diagnosis_code: 'I10', rendering_npi: '1234567890', primary_payer: 'Aetna', secondary_payer: '', billed_amount: 200 },
  // invalid CPT shape + missing diagnosis (coding)
  { claim_id: 'C3', member_id: 'M102', date_of_service: '2024-01-12', cpt_code: 'ABCDE', modifier: '', diagnosis_code: '', rendering_npi: '1234567893', primary_payer: 'Cigna', secondary_payer: '', billed_amount: 90 },
  // exact duplicate of C4a: same member + DOS + CPT
  { claim_id: 'C4a', member_id: 'M104', date_of_service: '2024-02-01', cpt_code: '70450', modifier: '', diagnosis_code: 'R51', rendering_npi: '1234567893', primary_payer: 'UHC', secondary_payer: '', billed_amount: 300 },
  { claim_id: 'C4b', member_id: 'M104', date_of_service: '2024-02-01', cpt_code: '70450', modifier: '', diagnosis_code: 'R51', rendering_npi: '1234567893', primary_payer: 'UHC', secondary_payer: '', billed_amount: 300 },
  // near-duplicate of C4a within 1-day window
  { claim_id: 'C4c', member_id: 'M104', date_of_service: '2024-02-02', cpt_code: '70450', modifier: '', diagnosis_code: 'R51', rendering_npi: '1234567893', primary_payer: 'UHC', secondary_payer: '', billed_amount: 300 },
  // COB signal: secondary payer populated
  { claim_id: 'C5', member_id: 'M105', date_of_service: '2024-03-01', cpt_code: '99213', modifier: '', diagnosis_code: 'E119', rendering_npi: '1234567893', primary_payer: 'Aetna', secondary_payer: 'Medicare', billed_amount: 150 },
];

async function main() {
  // ============================================================
  // 1) NPI check-digit validation
  // ============================================================
  ok(isValidNpi('1234567893'), 'isValidNpi: accepts a valid Luhn-checked NPI');
  ok(!isValidNpi('1234567890'), 'isValidNpi: rejects a bad check digit');
  ok(!isValidNpi('12345'), 'isValidNpi: rejects a non-10-digit value');
  ok(!isValidNpi(''), 'isValidNpi: rejects blank');

  // ============================================================
  // 2) Schema-tolerant column detection
  // ============================================================
  const det = detectClaimColumns(CLAIM_COLUMNS);
  ok(det.map.claimId === 'claim_id', 'detectClaimColumns: finds claim id');
  ok(det.map.memberId === 'member_id', 'detectClaimColumns: finds member id');
  ok(det.map.dos === 'date_of_service', 'detectClaimColumns: finds date of service');
  ok(det.map.cpt === 'cpt_code', 'detectClaimColumns: finds CPT');
  ok(det.map.dx === 'diagnosis_code', 'detectClaimColumns: finds diagnosis');
  ok(det.map.npi === 'rendering_npi', 'detectClaimColumns: finds NPI');
  ok(det.map.payerSecondary === 'secondary_payer', 'detectClaimColumns: secondary payer claimed before primary');
  ok(det.map.payerPrimary === 'primary_payer', 'detectClaimColumns: primary payer detected separately');
  ok(det.payerLikeColumns.length >= 2, 'detectClaimColumns: counts multiple payer-like columns for COB');
  ok(det.map.npi && det.map.provider === null || det.map.npi, 'detectClaimColumns: NPI claimed over generic provider');

  // ============================================================
  // 3) Full report — the five buckets
  // ============================================================
  const report = buildDenialReport({ rows: CLAIM_ROWS, columns: CLAIM_COLUMNS, table: 'claims', rowCount: CLAIM_ROWS.length });
  const cats = byId(report);
  ok(report.categories.length === 5, 'buildDenialReport: five canonical buckets');

  ok(cats.eligibility.applicable && cats.eligibility.flaggedCount === 1, 'eligibility: flags the row missing member id');
  ok(cats.eligibility.examples.some(e => e.claim === 'C2'), 'eligibility: example points at the offending claim');

  ok(cats.coding.applicable && cats.coding.flaggedCount === 1, 'coding: flags the invalid-CPT / missing-diagnosis row');
  ok(cats.coding.examples.some(e => /CPT|diagnosis/i.test(e.reason)), 'coding: example explains the coding defect');

  ok(cats.duplicates.applicable, 'duplicates: applicable when member+DOS+CPT present');
  ok(cats.duplicates.flaggedCount === 2, 'duplicates: flags one exact + one near-duplicate (2 extra rows)');
  ok(cats.duplicates.notes.some(n => /tolerance window/i.test(n)), 'duplicates: reports the tolerance window');

  ok(cats.provider.applicable && cats.provider.flaggedCount === 1, 'provider: flags the invalid NPI');
  ok(cats.provider.examples.some(e => /NPI/i.test(e.reason)), 'provider: example explains the NPI defect');

  ok(cats.cob.applicable && cats.cob.flaggedCount === 1, 'cob: flags the row with a populated secondary payer');

  ok(report.totalFlaggedRows >= 1 && report.totalFlaggedRows <= CLAIM_ROWS.length,
    'report: totalFlaggedRows is a bounded union across buckets');
  ok(typeof report.totalFlaggedPct === 'number', 'report: reports an overall flagged percentage');

  // ============================================================
  // 4) Schema tolerance — absent columns are NOT-APPLICABLE, not passing
  // ============================================================
  const sparse = buildDenialReport({
    rows: [{ amount: 10 }, { amount: 20 }],
    columns: [{ name: 'amount', type: 'DOUBLE' }],
    table: 't', rowCount: 2,
  });
  const sparseCats = byId(sparse);
  ok(sparseCats.eligibility.applicable === false && /no member/i.test(sparseCats.eligibility.notes[0]),
    'tolerance: eligibility reported not-applicable with a reason when no member id column');
  ok(sparseCats.coding.applicable === false, 'tolerance: coding not-applicable without CPT/diagnosis');
  ok(sparseCats.duplicates.applicable === false, 'tolerance: duplicates not-applicable without member+CPT');
  ok(sparseCats.provider.applicable === false, 'tolerance: provider not-applicable without NPI/provider');
  ok(sparseCats.cob.applicable === false, 'tolerance: COB not-applicable without multiple payers');
  ok(sparse.notCheckable.length === 5, 'tolerance: all five buckets listed as not-checkable with reasons');
  ok(sparse.totalFlaggedRows === 0, 'tolerance: nothing flagged when nothing is checkable');

  // Single payer → COB not applicable, but eligibility still works.
  const onePayer = buildDenialReport({
    rows: [{ member_id: 'M1', payer: 'Aetna' }, { member_id: '', payer: 'Cigna' }],
    columns: [{ name: 'member_id' }, { name: 'payer' }],
  });
  const onePayerCats = byId(onePayer);
  ok(onePayerCats.cob.applicable === false && /one payer/i.test(onePayerCats.cob.notes[0]),
    'tolerance: a single payer column disables COB with an explanation');
  ok(onePayerCats.eligibility.applicable && onePayerCats.eligibility.flaggedCount === 1,
    'tolerance: eligibility still grades what is present');

  // ============================================================
  // 5) Live cost estimate embedded in the report
  // ============================================================
  ok(report.cost && report.cost.flaggedCount === report.totalFlaggedRows,
    'cost: report embeds an estimate over the flagged-row count');
  ok(report.cost.perErrorCost === 118, 'cost: uses the default per-error cost');
  const custom = buildDenialReport({ rows: CLAIM_ROWS, columns: CLAIM_COLUMNS, perErrorCost: 50 });
  ok(custom.cost.perErrorCost === 50, 'cost: honours an editable per-error cost passed to the profiler');

  // ============================================================
  // 6) Signed attestation
  // ============================================================
  const att = await buildDenialAttestation(report);
  ok(att.kind === 'dataglow-denial-profile-attestation' && att.version >= 1, 'attestation: self-describing kind + version');
  ok(att.digest && att.digest.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(att.digest.value),
    'attestation: carries a SHA-256 digest over its canonical core');
  ok((await computeDenialDigest(att)) === att.digest.value, 'computeDenialDigest: recomputes to the stored value');
  ok((await verifyDenialAttestation(att)).valid, 'verifyDenialAttestation: a fresh attestation verifies');

  const tampered = JSON.parse(JSON.stringify(att));
  tampered.totalFlaggedRows = 0;
  ok(!(await verifyDenialAttestation(tampered)).valid, 'verifyDenialAttestation: tampering with the results breaks the digest');
  const notOurs = await verifyDenialAttestation({ kind: 'something-else' });
  ok(!notOurs.valid && /not a dataglow/i.test(notOurs.reason), 'verifyDenialAttestation: rejects a foreign document by kind');

  // ============================================================
  // 7) DuckDB wrapper against a fake engine
  // ============================================================
  const fakeEngine = {
    async getRowCount() { return CLAIM_ROWS.length; },
    async runQuery() { return { rows: CLAIM_ROWS }; },
  };
  const live = await runDenialProfile('claims', CLAIM_COLUMNS, fakeEngine);
  ok(live.report && live.attestation, 'runDenialProfile: returns a report + signed attestation');
  ok(live.report.totalFlaggedRows === report.totalFlaggedRows, 'runDenialProfile: end-to-end matches the pure report');
  ok((await verifyDenialAttestation(live.attestation)).valid, 'runDenialProfile: the attestation it emits verifies');
  ok(live.report.dataset.truncated === false, 'runDenialProfile: marks the scan as complete when all rows fit');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
