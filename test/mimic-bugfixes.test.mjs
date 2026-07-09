// ============================================================
// DATAGLOW — MIMIC-IV stress-test bug-fix regression suite
// ============================================================
// Covers five real, reproducible bugs surfaced by running DATAGLOW against
// the MIMIC-IV Clinical Database Demo, plus one healthcare-safety hardening:
//   Bug 1 — Provenance hash must be taken BEFORE the engine detaches the buffer
//   Bug 2 — Benford eligibility must not crash on 0/1 flag columns (log10(0))
//   Bug 3 — Narrative Consistency must accept correct DERIVED stats (%, avg)
//   Bug 4 — Anomaly Explainer peer group must skip near-unique/timestamp columns
//   Bug 5 — Unit Test "future dates" must warn (not fail) on de-id date-shifting
//   Bonus — Categorical merges disabled on sensitive demographic/payer columns
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/mimic-bugfixes.test.mjs
//
// The production modules import '../js/duckdb-engine.js'; the loader hook
// transparently redirects that to the native node-duckdb-engine.mjs.

import { createTableFromObjects, getTableSchema, runQuery, closeConnection } from './node-duckdb-engine.mjs';

import { hashBytes } from '../js/provenance/provenance.js';
import { runAllLayers, checkNarrativeConsistency } from '../js/validation/validation.js';
import { pickPeerGroupColumn } from '../js/anomaly/ondevice-ml.js';
import { isSensitiveCategory } from '../js/validation/categorical-consistency.js';
import { clearLedger } from '../js/provenance/assumption-ledger.js';

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

function detailStr(r) {
  return JSON.stringify((r && (r.detail || r.summary)) || '');
}

const engineLike = { runQuery };

async function main() {
  clearLedger();

  // ============================================================
  // Bug 1 — Provenance Trail: hash the raw bytes BEFORE the engine detaches
  // the ArrayBuffer. DuckDB-WASM's registerFileBuffer transfers/detaches the
  // buffer, so any hash taken afterward throws on a detached buffer and
  // provenance is silently never recorded.
  // ============================================================
  const csvBytes = new TextEncoder().encode('patient_id,age\n1,50\n2,60\n');
  const buf = csvBytes.buffer.slice(0); // a standalone ArrayBuffer
  const hashBefore = await hashBytes(buf);
  ok(/^[0-9a-f]{64}$/.test(hashBefore), 'bug1: raw-bytes hash computed from the buffer BEFORE it reaches the engine');
  // Simulate what db.registerFileBuffer() does — transfer detaches the buffer.
  structuredClone(buf, { transfer: [buf] });
  ok(buf.byteLength === 0, 'bug1: registerFileBuffer-style transfer detaches the ArrayBuffer (reproduces root cause)');
  let threwOnDetached = false;
  try { await hashBytes(buf); } catch { threwOnDetached = true; }
  ok(threwOnDetached, 'bug1: hashing AFTER detachment throws — so the hash MUST be taken first (the fix ordering)');

  // ============================================================
  // Bug 2 — Benford's Law must not crash on a 0/1 flag column. Pre-fix the
  // LOG10(ABS(col)) was evaluated across the whole column before the FILTER,
  // throwing "cannot take logarithm of zero" and aborting the whole layer.
  // ============================================================
  const benRows = [];
  for (let i = 0; i < 60; i++) {
    benRows.push({
      mortality_flag: i % 2,                       // literal 0s — the crash trigger
      claim_amount: Math.round((10 + i * 137.5) * 100) / 100, // spans several orders
    });
  }
  const benDs = await makeDataset('mimic_benford', benRows);
  const benResults = await runAllLayers(benDs);
  ok(benResults.benford && !/Could not run/i.test(benResults.benford.summary),
    `bug2: Benford layer runs without crashing on a 0/1 flag column (status=${benResults.benford && benResults.benford.status})`);
  ok(!/"claim_amount" skipped/.test(detailStr(benResults.benford)),
    'bug2: the naturally-scaled "claim_amount" column is still tested (not aborted)');

  // ============================================================
  // Bug 3 — Narrative Consistency must accept correct DERIVED statistics
  // (percentages / averages / min / max) that never appear as raw grid cells.
  // ============================================================
  const nrRows = [];
  for (let i = 1; i <= 10; i++) {
    nrRows.push({ los: i, admission_type: i <= 6 ? 'EW EMER.' : 'ELECTIVE' });
  }
  // avg(los)=5.5 (NOT a raw cell value), min=1, max=10; mode share = 6/10 = 60.0%.
  const nrResult = { columns: ['los', 'admission_type'], rows: nrRows, rowCount: nrRows.length };
  const goodStory = `The query returned 10 rows across 2 columns. los averages 5.50, ranging from 1.00 to 10.00. The most common admission_type is "EW EMER." at 60.0% of rows.`;
  const goodCheck = await checkNarrativeConsistency(goodStory, nrResult);
  ok(goodCheck.status === 'pass',
    `bug3: a story with correct computed avg (5.50) and share (60.0%) passes (status=${goodCheck.status}, mismatches=${JSON.stringify(goodCheck.mismatches)})`);
  // Negative control — a genuinely wrong percentage must still be flagged.
  const badStory = `The most common admission_type is "EW EMER." at 99.9% of rows.`;
  const badCheck = await checkNarrativeConsistency(badStory, nrResult);
  ok(badCheck.status === 'fail' && badCheck.mismatches.includes('99.9%'),
    'bug3: a mathematically wrong percentage (99.9%) is still caught as a mismatch');

  // ============================================================
  // Bug 4 — Anomaly Explainer peer group must reject a per-row-unique timestamp
  // (e.g. MIMIC deathtime, mostly-null and unique among deaths) and pick a
  // genuinely low-cardinality categorical column instead.
  // ============================================================
  const pgRows = [];
  for (let i = 0; i < 100; i++) {
    pgRows.push({
      // deathtime: null for survivors, a UNIQUE timestamp for the 10 who died —
      // near-unique among its non-null values, so a bad "peer group" of ~1.
      deathtime: i < 10 ? `2137-09-${String(i + 1).padStart(2, '0')} 12:00:00` : null,
      admission_type: ['EW EMER.', 'ELECTIVE', 'URGENT', 'DIRECT EMER.'][i % 4],
      heart_rate: 60 + (i % 40),
    });
  }
  const pgDs = await makeDataset('mimic_peergroup', pgRows);
  // deathtime is deliberately the FIRST categorical column, so a naive picker
  // would grab it; d=10 <= upperBound(20) passes the count gate but its
  // distinct/non-null ratio of 1.0 must disqualify it.
  const picked = await pickPeerGroupColumn('mimic_peergroup', pgDs.cols, engineLike, { rowCount: pgDs.rowCount });
  ok(picked === 'admission_type',
    `bug4: peer group is the low-cardinality categorical, not the near-unique timestamp (picked "${picked}")`);

  // ============================================================
  // Bug 5 — Unit Test Layer: systematic de-identification date-shifting should
  // WARN (not fail), while a sporadic minority of future dates stays a FAIL.
  // ============================================================
  // (a) Systematic shift: every admit_date decades in the future, no other issues.
  const shiftRows = [];
  for (let i = 1; i <= 40; i++) {
    shiftRows.push({ patient_id: i, admit_date: `21${String(50 + (i % 40)).padStart(2, '0')}-06-15` });
  }
  const shiftDs = await makeDataset('mimic_shifted_dates', shiftRows);
  const shiftResults = await runAllLayers(shiftDs);
  ok(shiftResults.unit_tests.status === 'warn',
    `bug5: systematic far-future dates downgrade Unit Test Layer to warn (status=${shiftResults.unit_tests.status})`);
  ok(/de-identification|date-shifting|MIMIC/i.test(detailStr(shiftResults.unit_tests)),
    'bug5: the warning explains the de-identification date-shifting pattern');

  // (b) Sporadic future dates among mostly-valid past dates → still a failure.
  const sporadicRows = [];
  for (let i = 1; i <= 30; i++) {
    const yr = i <= 28 ? 2019 : 2505; // 2 of 30 are far-future "typos"
    sporadicRows.push({ patient_id: i, admit_date: `${yr}-03-${String((i % 27) + 1).padStart(2, '0')}` });
  }
  const sporadicDs = await makeDataset('mimic_sporadic_dates', sporadicRows);
  const sporadicResults = await runAllLayers(sporadicDs);
  ok(sporadicResults.unit_tests.status === 'fail',
    `bug5: a small minority of future dates stays a failure (status=${sporadicResults.unit_tests.status})`);
  ok(/future date/i.test(detailStr(sporadicResults.unit_tests)),
    'bug5: the sporadic future dates are reported as a hard unit-test failure');

  // ============================================================
  // Bonus — Sensitive category detection + merge disabling.
  // ============================================================
  ok(isSensitiveCategory('race') && isSensitiveCategory('insurance') &&
     isSensitiveCategory('ethnicity') && isSensitiveCategory('payer_type'),
    'bonus: sensitive demographic/payer column names are detected');
  ok(!isSensitiveCategory('admit_provider_id') && !isSensitiveCategory('admission_type'),
    'bonus: non-sensitive columns are NOT flagged');

  const sensRows = [];
  for (let i = 0; i < 20; i++) {
    sensRows.push({
      patient_id: i + 1,
      // Legally distinct values that are textually near-identical (hyphen vs space).
      race: i < 12 ? 'BLACK/AFRICAN AMERICAN' : 'BLACK/AFRICAN-AMERICAN',
      // Non-sensitive column with a genuine spelling typo cluster.
      admission_type: i < 12 ? 'ELECTIVE' : 'ELECTIVEE',
    });
  }
  const sensDs = await makeDataset('mimic_sensitive', sensRows);
  const sensResults = await runAllLayers(sensDs);
  const clusters = (sensResults.categorical_consistency && sensResults.categorical_consistency.clusters) || [];
  const raceCluster = clusters.find(c => c.column === 'race');
  const admitCluster = clusters.find(c => c.column === 'admission_type');
  ok(raceCluster && raceCluster.sensitive === true,
    'bonus: the "race" cluster is marked sensitive (Apply Merge disabled in the UI)');
  ok(admitCluster && admitCluster.sensitive === false && admitCluster.merges.length >= 1,
    'bonus: the non-sensitive "admission_type" cluster still offers a normal merge');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
