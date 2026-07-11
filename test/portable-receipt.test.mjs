// ============================================================
// DATAGLOW — DataGlow Passport (Batch B) test
// Portable Receipts — per-artifact, independently-verifiable lineage stamp
// ============================================================
// Verifies js/provenance/portable-receipt.js against its real logic:
//   • builds a portable receipt for a single exported artifact (one KPI / chart)
//     and asserts the independent verifier accepts an untampered receipt;
//   • TAMPERING: mutating the displayed claim value, the query-chain content
//     hash, or the timestamp each makes verifyClaimReceipt return false with a
//     clear, field-specific reason;
//   • the self-contained HTML verifier embeds the receipt + an inline verifier
//     and references NO network primitive / external script / outbound URL
//     (offline-verifiable by anyone, same no-network discipline as the packs);
//   • the opt-in gate never produces a receipt unless attach === true (trust
//     artifacts are opt-in and visible, never silent);
//   • the delivered blob follows the Universal Export Contract descriptor.
//
// RUN WITH:  node test/portable-receipt.test.mjs
//
// Pure crypto (SHA-256 via crypto.subtle) — no DuckDB, DOM, or network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildClaimReceipt, verifyClaimReceipt, renderReceiptVerifierHTML,
  attachPortableReceiptIfRequested, receiptBlob,
  PORTABLE_RECEIPT_KIND, PORTABLE_RECEIPT_VERSION,
} from '../js/provenance/portable-receipt.js';
import { scanSourceForNetwork } from '../js/packs/pack-network-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- tiny test harness (mirrors the other test files) ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A realistic single-artifact fixture: one KPI pasted out of DATAGLOW.
function kpiInput() {
  return {
    claim: { label: 'SUM(revenue) for Q1', value: 482910, statement: 'SUM(revenue) for Q1 = 482,910' },
    queryOrTransformChain: [
      { op: 'load', detail: 'sales_2026.csv' },
      { op: 'filter', detail: "quarter = 'Q1'" },
      { op: 'aggregate', detail: 'SUM(revenue)' },
    ],
    validationStateAtCompute: { grade: 'A', summary: '18 of 20 layers passed; 0 failed.' },
    datasetFingerprint: 'a'.repeat(64),
    generatedAt: Date.UTC(2026, 6, 11, 12, 0, 0),
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

async function run() {
  // ---------- build + shape ----------
  const receipt = await buildClaimReceipt(kpiInput());
  ok(receipt.kind === PORTABLE_RECEIPT_KIND, 'receipt has the portable-receipt kind');
  ok(receipt.version === PORTABLE_RECEIPT_VERSION, 'receipt carries a version');
  ok(typeof receipt.commitment.merkleRoot === 'string' && receipt.commitment.merkleRoot.length === 64,
    'commitment has a 64-hex SHA-256 Merkle root');
  ok(typeof receipt.queryChainHash === 'string' && receipt.queryChainHash.length === 64,
    'receipt commits a content hash of the query/transform chain');
  ok(receipt.validationState && receipt.validationState.grade === 'A',
    'receipt carries the dataset validation state AT compute time');
  ok(receipt.generatedAt === '2026-07-11T12:00:00.000Z', 'receipt carries an ISO timestamp');
  ok(typeof receipt.shortCode === 'string' && receipt.shortCode.length === 8,
    'receipt exposes a human-readable short code (truncated fingerprint)');

  // ---------- happy-path verification ----------
  const good = await verifyClaimReceipt(receipt);
  ok(good.valid === true, 'an untampered receipt verifies as valid');
  ok(/Integrity|tamper/i.test(good.reason), 'the valid reason states it is an integrity/tamper-evidence check');

  // ---------- tamper: displayed claim value ----------
  const t1 = clone(receipt);
  t1.claim.value = 999999;
  t1.claim.statement = 'SUM(revenue) for Q1 = 999,999';
  const r1 = await verifyClaimReceipt(t1);
  ok(r1.valid === false, 'tampering the claim value makes verification fail');
  ok(/claim/i.test(r1.reason), 'the failure reason names the claim field');

  // ---------- tamper: query-chain content hash ----------
  const t2 = clone(receipt);
  t2.queryChainHash = 'b'.repeat(64);
  const r2 = await verifyClaimReceipt(t2);
  ok(r2.valid === false, 'tampering the query-chain hash makes verification fail');
  ok(/chain/i.test(r2.reason), 'the failure reason names the query/transform chain');

  // ---------- tamper: the query chain itself (hash no longer matches) ----------
  const t2b = clone(receipt);
  t2b.queryChain[2].detail = 'SUM(profit)';
  const r2b = await verifyClaimReceipt(t2b);
  ok(r2b.valid === false, 'editing the query chain without re-hashing fails verification');

  // ---------- tamper: timestamp ----------
  const t3 = clone(receipt);
  t3.generatedAt = '2020-01-01T00:00:00.000Z';
  const r3 = await verifyClaimReceipt(t3);
  ok(r3.valid === false, 'tampering the timestamp makes verification fail');

  // ---------- tamper: committed field directly ----------
  const t4 = clone(receipt);
  t4.commitment.fields[0].value = 'not the claim';
  const r4 = await verifyClaimReceipt(t4);
  ok(r4.valid === false, 'tampering a committed field directly fails verification');

  // ---------- tamper: root only ----------
  const t5 = clone(receipt);
  t5.commitment.merkleRoot = 'c'.repeat(64);
  const r5 = await verifyClaimReceipt(t5);
  ok(r5.valid === false, 'a forged Merkle root fails verification');

  // ---------- not-a-receipt guard ----------
  const rNull = await verifyClaimReceipt(null);
  ok(rNull.valid === false && /kind/i.test(rNull.reason), 'a non-receipt object is rejected with a clear reason');

  // ---------- self-contained HTML verifier: offline, no network ----------
  const html = renderReceiptVerifierHTML(receipt);
  ok(html.startsWith('<!DOCTYPE html>'), 'renderReceiptVerifierHTML returns a full HTML document');
  const netHits = scanSourceForNetwork(html);
  ok(netHits.length === 0,
    `verifier HTML references no network primitive (found: ${netHits.map(h => h.primitive).join(',') || 'none'})`);
  ok(!/<script\s+src=/i.test(html), 'verifier HTML has no external <script src=>');
  ok(!/https?:\/\//i.test(html), 'verifier HTML embeds no outbound http(s) URL');
  ok(html.includes(receipt.commitment.merkleRoot), 'verifier HTML embeds the committed Merkle root');
  ok(html.includes(receipt.shortCode), 'verifier HTML shows the short code');
  ok(/crypto\.subtle/.test(html), 'verifier HTML reruns the hash check client-side (crypto.subtle)');

  // ---------- source guard on the module itself ----------
  const moduleSrc = readFileSync(join(__dirname, '..', 'js', 'provenance', 'portable-receipt.js'), 'utf8');
  ok(scanSourceForNetwork(moduleSrc).length === 0,
    'portable-receipt.js source references no network primitive');

  // ---------- opt-in gate: never silent ----------
  const notAttached = await attachPortableReceiptIfRequested(false, kpiInput());
  ok(notAttached === null, 'no receipt is produced when attach is false');
  const notAttached2 = await attachPortableReceiptIfRequested(undefined, kpiInput());
  ok(notAttached2 === null, 'no receipt is produced when attach is omitted');
  const notAttached3 = await attachPortableReceiptIfRequested('true', kpiInput());
  ok(notAttached3 === null, 'a truthy non-true value does not trigger a receipt (explicit opt-in only)');
  const attached = await attachPortableReceiptIfRequested(true, kpiInput());
  ok(attached && attached.kind === PORTABLE_RECEIPT_KIND, 'a receipt is produced only on explicit attach === true');
  ok((await verifyClaimReceipt(attached)).valid === true, 'the opt-in-built receipt verifies');

  // ---------- delivery blob follows the Universal Export Contract ----------
  const blob = receiptBlob(receipt, 'q1-revenue-chart');
  ok(blob.filename === 'q1-revenue-chart.receipt.html', 'blob filename is <stem>.receipt.html');
  ok(blob.mimeType === 'text/html', 'blob mimeType is text/html');
  ok(blob.data instanceof Uint8Array, 'blob data is a Uint8Array (export descriptor currency)');
  ok(new TextDecoder().decode(blob.data).startsWith('<!DOCTYPE html>'), 'blob decodes to the verifier HTML');

  // ---------- summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
