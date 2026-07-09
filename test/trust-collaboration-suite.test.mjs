// ============================================================
// DATAGLOW — Gen 8 Batch 3 test file
// Trust & Collaboration Suite: Receipts, Peer Review, Time-Travel Diff
// ============================================================
// Verifies the three Batch 3 features end-to-end against real logic:
//   1. Validation Receipts  — export packages grade + 20-layer + Red Team summary +
//                             ledger entries + story into one HTML artifact
//   2. Peer Review Mode      — packet exports and re-imports with feedback intact
//   3. Time-Travel Diff Mode — row add/remove/change detection, distributional
//                             drift, and a real validation-layer PASS→FAIL flip
//                             between two versions of the golden dataset
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/trust-collaboration-suite.test.mjs
//
// NOTE (test data): buildCleanGoldenVariant() below constructs a clean, 100-row
// dataset with the golden schema but no seeded defects. It is the "before"
// version diffed against the deliberately-dirty golden dataset ("after") to
// exercise the row-level diff and to force a real unit-test PASS→FAIL flip.

import { createTableFromObjects, getTableSchema, runQuery, closeConnection } from './node-duckdb-engine.mjs';

import { buildValidationReceipt, renderReceiptHTML } from '../js/validation-receipt.js';
import { buildReviewPacket, exportPacket, importReview, summarizeReview } from '../js/peer-review.js';
import { detectKeyColumn, diffRows, diffLayerStatuses, diffDistributions } from '../js/time-travel-diff.js';
import { runAllLayers } from '../js/validation.js';
import { buildGoldenDataset } from '../js/loaders.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function makeDataset(table, rows) {
  await createTableFromObjects(table, rows);
  const schema = await getTableSchema(table);
  return {
    table,
    cols: schema.map(s => ({ name: s.column_name, type: s.column_type })),
    rowCount: rows.length,
    loadedAt: Date.now(),
  };
}

// A clean, defect-free dataset that mirrors the golden schema. Used as the
// "before" snapshot in the Time-Travel Diff tests.
function buildCleanGoldenVariant() {
  const rows = [];
  for (let i = 1; i <= 100; i++) {
    const age = 25 + (i % 55); // 25..79 — always adult, never 999
    const admitDay = String((i % 27) + 1).padStart(2, '0');
    rows.push({
      patient_id: i,
      age,
      gender: i % 2 === 0 ? 'M' : 'F',
      length_of_stay: 1 + (i % 12),
      readmission_rate: Number(((i % 20) / 100).toFixed(2)),
      admit_date: `2023-06-${admitDay}`,
      discharge_date: `2023-07-${admitDay}`, // always after admit
      country: i % 3 === 0 ? 'France' : 'United States',
      has_retirement_account: true, // all adults — no minor/retirement conflict
      claim_amount: 100 + i * 3, // always positive
    });
  }
  return rows;
}

async function main() {
  // ============================================================
  // Feature 1 — Shareable Validation Receipts
  // ============================================================
  const goldenRows = buildGoldenDataset();
  const goldenDs = await makeDataset('golden_b3', goldenRows);
  const goldenResults = await runAllLayers(goldenDs, { freshnessThresholdHours: 24 });

  const sampleStory = 'The dataset returned 100 rows; claim_amount averages 1,234.56 across all patients.';
  const sampleLedger = [
    { ts: Date.now() - 2000, source: 'Categorical Consistency Engine', action: 'Clustered "FRA"/"France" — proposed canonical merge.' },
    { ts: Date.now() - 1000, source: "Benford's Law Check", action: 'Skipped "age" — bounded range, Benford not applicable.' },
  ];

  const receipt = buildValidationReceipt({
    datasetName: 'Golden Test Dataset',
    results: goldenResults,
    ledgerEntries: sampleLedger,
    storyText: sampleStory,
  });

  ok(receipt.kind === 'dataglow-validation-receipt', 'receipt: model is tagged as a DATAGLOW validation receipt');
  ok(receipt.confidence && ['A', 'B', 'C', 'D'].includes(receipt.confidence.grade), `receipt: carries an overall confidence grade (${receipt.confidence && receipt.confidence.grade})`);
  ok(receipt.layers.length === 21, `receipt: summarizes all 21 validation layers (got ${receipt.layers.length})`);
  ok(receipt.summary.total === 21 && (receipt.summary.pass + receipt.summary.fail + receipt.summary.warn + receipt.summary.idle) === 21, 'receipt: pass/fail/warn/idle tally accounts for every layer');
  ok(receipt.ledger.length === 2, 'receipt: includes the supplied Assumption Ledger entries');
  ok(receipt.story === sampleStory, 'receipt: embeds the story narrative');

  const html = renderReceiptHTML(receipt);
  ok(/^<!DOCTYPE html>/.test(html.trim()), 'receipt: renders a self-contained HTML document');
  ok(html.includes('Golden Test Dataset'), 'receipt HTML: shows the dataset name');
  ok(html.includes(`Grade ${receipt.confidence.grade}`), 'receipt HTML: shows the confidence grade');
  ok(html.includes('Unit Test Layer') && html.includes('Distributional Fingerprint Drift'), 'receipt HTML: lists validation-layer names');
  ok(html.includes('Categorical Consistency Engine') && html.includes('bounded range'), 'receipt HTML: includes the ledger entries');
  ok(html.includes(sampleStory), 'receipt HTML: includes the story narrative');
  ok(!/<script/i.test(html), 'receipt HTML: contains no scripts (safe to open standalone)');

  // ============================================================
  // Feature 2 — Async Peer Review Mode (round-trip)
  // ============================================================
  const packet = buildReviewPacket({
    datasetName: 'Golden Test Dataset',
    query: 'SELECT * FROM golden_b3',
    results: goldenResults,
    ledgerEntries: sampleLedger,
  });
  ok(packet.kind === 'dataglow-peer-review-packet', 'peer-review: packet is tagged as a DATAGLOW peer-review packet');
  const sectionIds = packet.sections.map(s => s.id);
  ok(['query', 'findings', 'validation_layers', 'assumption_ledger'].every(id => sectionIds.includes(id)), 'peer-review: packet carries query, findings, layers, and ledger sections');
  ok(packet.sections.every(s => s.review && s.review.decision === 'pending'), 'peer-review: every section starts as pending review');

  const layersSection = packet.sections.find(s => s.id === 'validation_layers');
  ok(layersSection.layers.length === 20, `peer-review: layers section covers the 20 runAllLayers layers (got ${layersSection.layers.length})`);

  const md = exportPacket(packet, 'markdown');
  ok(md.includes('# DATAGLOW Peer Review Packet') && md.includes('## Key Findings'), 'peer-review: markdown export is human-readable with section headings');

  // Reviewer fills in decisions + notes, returns the JSON, we re-import it.
  const json = exportPacket(packet, 'json');
  const roundtrip = JSON.parse(json);
  roundtrip.reviewer.name = 'Second Analyst';
  roundtrip.reviewer.submittedAt = Date.now();
  roundtrip.sections.find(s => s.id === 'findings').review = { decision: 'flagged', notes: 'The age=999 outlier must be resolved before sign-off.' };
  roundtrip.sections.find(s => s.id === 'query').review = { decision: 'approved', notes: 'Query scope looks right.' };
  roundtrip.sections.find(s => s.id === 'validation_layers').review = { decision: 'approved', notes: '' };
  roundtrip.sections.find(s => s.id === 'assumption_ledger').review = { decision: 'approved', notes: '' };

  const reimported = importReview(JSON.stringify(roundtrip));
  ok(reimported.reviewer.name === 'Second Analyst', 'peer-review: re-import preserves the reviewer name');
  const findingsReview = reimported.sections.find(s => s.id === 'findings').review;
  ok(findingsReview.decision === 'flagged' && /age=999/.test(findingsReview.notes), 'peer-review: re-import preserves per-section decision and free-text notes');

  const sum = summarizeReview(reimported);
  ok(sum.flagged === 1 && sum.approved === 3 && sum.pending === 0, `peer-review: summary tallies decisions (${sum.approved} approved / ${sum.flagged} flagged)`);
  ok(sum.verdict === 'Changes requested', 'peer-review: a flagged section yields a "Changes requested" verdict');

  let threw = false;
  try { importReview('{"kind":"something-else"}'); } catch (e) { threw = true; }
  ok(threw, 'peer-review: importing a non-DATAGLOW file is rejected');

  // ============================================================
  // Feature 3 — Time-Travel Diff Mode
  // ============================================================
  // (a) Row-level diff — pure, key-based add/remove/change detection.
  const keyCols = ['patient_id', 'age', 'gender'];
  const rowsA = [
    { patient_id: 1, age: 30, gender: 'F' },
    { patient_id: 2, age: 40, gender: 'M' },
    { patient_id: 3, age: 50, gender: 'F' },
  ];
  const rowsB = [
    { patient_id: 2, age: 41, gender: 'M' }, // age changed 40 -> 41
    { patient_id: 3, age: 50, gender: 'F' }, // unchanged
    { patient_id: 4, age: 60, gender: 'M' }, // added
  ];
  const key = detectKeyColumn(keyCols, rowsA);
  ok(key === 'patient_id', `time-travel: auto-detected "patient_id" as the primary key (got "${key}")`);

  const rowDiff = diffRows(rowsA, rowsB, key);
  ok(rowDiff.added.length === 1 && rowDiff.added[0] === '4', 'time-travel: identifies the added row');
  ok(rowDiff.removed.length === 1 && rowDiff.removed[0] === '1', 'time-travel: identifies the removed row');
  ok(rowDiff.changed.length === 1 && rowDiff.changed[0].key === '2', 'time-travel: identifies the changed row by key');
  ok(rowDiff.changed[0].fields.length === 1 && rowDiff.changed[0].fields[0].column === 'age' && String(rowDiff.changed[0].fields[0].from) === '40' && String(rowDiff.changed[0].fields[0].to) === '41', 'time-travel: pinpoints the changed field and its before/after values');
  ok(rowDiff.unchanged === 1, 'time-travel: counts the unchanged matching row');

  // (b) Validation-layer PASS -> FAIL flip between clean and dirty golden.
  const cleanRows = buildCleanGoldenVariant();
  const cleanDs = await makeDataset('golden_b3_clean', cleanRows);
  const cleanResults = await runAllLayers(cleanDs, { freshnessThresholdHours: 24 });

  ok(cleanResults.unit_tests.status === 'pass', `time-travel: clean variant passes the Unit Test Layer (status=${cleanResults.unit_tests.status})`);
  ok(goldenResults.unit_tests.status === 'fail', `time-travel: dirty golden fails the Unit Test Layer (status=${goldenResults.unit_tests.status})`);

  const flips = diffLayerStatuses(cleanResults, goldenResults);
  const passToFail = flips.filter(f => f.from === 'pass' && f.to === 'fail');
  ok(passToFail.length >= 1, `time-travel: detects at least one PASS→FAIL layer flip (found ${passToFail.length})`);
  ok(passToFail.some(f => f.layer === 'unit_tests' && f.passFailFlip), 'time-travel: the Unit Test Layer is among the PASS→FAIL flips');

  // (c) Distributional diff — reuses layer 18's fingerprint/compare logic.
  const shifted = cleanRows.map(r => ({ ...r, claim_amount: r.claim_amount + 100000 }));
  const shiftedDs = await makeDataset('golden_b3_shifted', shifted);
  const sharedNumeric = cleanDs.cols
    .filter(c => ['DOUBLE', 'BIGINT', 'INTEGER', 'HUGEINT', 'FLOAT'].includes(c.type))
    .map(c => ({ name: c.name, type: c.type }));
  const distDiff = await diffDistributions('golden_b3_clean', 'golden_b3_shifted', sharedNumeric);
  ok(distDiff.drifts.some(d => /claim_amount/.test(d)), `time-travel: distributional diff flags the shifted claim_amount column (${distDiff.drifts.length} drift(s))`);

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
