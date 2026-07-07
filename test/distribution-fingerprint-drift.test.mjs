// ============================================================
// DATAGLOW — Distributional Fingerprint Drift test suite (layer 18)
// ============================================================
// Covers the fingerprint computation (enriched with null rate / cardinality /
// min / max), the schema-signature matcher, the drift comparator (mean shift,
// null-rate jump, cardinality change, categorical composition), and the opt-in
// CROSS-SESSION persistence path via an injected fingerprint store.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/distribution-fingerprint-drift.test.mjs
//
// The persistence layer (js/memory-store.js) is browser-only (IndexedDB), so
// here we inject a tiny in-memory fake that mirrors its getBaseline/saveBaseline
// contract — this is exactly how main.js hands the real store to the layer.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';
import {
  computeDistributionFingerprint,
  compareDistributions,
  schemaSignature,
  runAllLayers,
} from '../js/validation.js';
import { clearLedger } from '../js/assumption-ledger.js';

// ---------- tiny test harness ----------
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

// In-memory stand-in for js/memory-store.js's datasetBaselines store.
function makeFakeStore() {
  const map = new Map();
  return {
    map,
    async getBaseline(hash) { return map.get(hash); },
    async saveBaseline(hash, stats) {
      const existing = map.get(hash);
      const version = existing ? (existing.version || 1) + 1 : 1;
      const rec = { fingerprintHash: hash, columnStats: stats, version };
      map.set(hash, rec);
      return rec;
    },
  };
}

async function main() {
  clearLedger();

  // ---- schemaSignature: filename/order-independent, type-sensitive ----
  const sigA = schemaSignature([{ name: 'age', type: 'INTEGER' }, { name: 'city', type: 'VARCHAR' }]);
  const sigReordered = schemaSignature([{ name: 'city', type: 'VARCHAR' }, { name: 'age', type: 'INTEGER' }]);
  const sigRetyped = schemaSignature([{ name: 'age', type: 'DOUBLE' }, { name: 'city', type: 'VARCHAR' }]);
  ok(sigA === sigReordered, 'schemaSignature: identical schema in different column order yields the same signature');
  ok(sigA !== sigRetyped, 'schemaSignature: a changed column type yields a different signature');

  // ---- computeDistributionFingerprint: enriched stats ----
  const baseRows = [];
  for (let i = 0; i < 100; i++) {
    baseRows.push({
      id: i,
      amount: 100 + (i % 10),                 // tight cluster around ~104
      category: i % 4 === 0 ? 'A' : 'B',      // 2 distinct labels
      note: i < 2 ? null : `n${i}`,           // ~2% null
    });
  }
  const dsBase = await makeDataset('fp_base', baseRows);
  const fpBase = await computeDistributionFingerprint(dsBase.table, dsBase.cols);

  const amt = fpBase.amount;
  ok(amt && amt.kind === 'numeric', 'fingerprint: numeric column classified as numeric');
  ok(amt.mean != null && amt.std != null && amt.min != null && amt.max != null,
    'fingerprint: numeric column carries mean/std/min/max');
  ok(amt.min <= amt.max && amt.min >= 100 && amt.max <= 109,
    `fingerprint: numeric min/max sensible (min=${amt && amt.min}, max=${amt && amt.max})`);
  ok(amt.nullRate != null && Math.abs(amt.nullRate) < 1e-9,
    `fingerprint: amount has ~0 null rate (got ${amt && amt.nullRate})`);

  const cat = fpBase.category;
  ok(cat && cat.kind === 'categorical' && Array.isArray(cat.top),
    'fingerprint: VARCHAR column classified as categorical with a top list');
  ok(Math.abs(cat.cardinality - 2 / 100) < 1e-9,
    `fingerprint: category cardinality ratio = distinct/nonnull (got ${cat && cat.cardinality})`);

  const note = fpBase.note;
  ok(note && Math.abs(note.nullRate - 0.02) < 1e-9,
    `fingerprint: note null rate ~2% (got ${note && note.nullRate})`);

  // ---- compareDistributions: mean shift ----
  const shifted = { amount: { ...amt, mean: amt.mean + 5 * (amt.std || 1) } };
  const meanDrift = compareDistributions({ amount: amt }, shifted);
  ok(meanDrift.some(d => /mean shifted/.test(d)), 'compare: >2σ mean shift is flagged');

  // ---- compareDistributions: null-rate jump (2% -> 40%) ----
  const nullDrift = compareDistributions(
    { note: { kind: 'categorical', nullRate: 0.02, cardinality: 0.9, top: ['x'] } },
    { note: { kind: 'categorical', nullRate: 0.40, cardinality: 0.9, top: ['x'] } },
  );
  ok(nullDrift.some(d => /null rate jumped/.test(d)), 'compare: a 2%→40% null-rate jump is flagged');

  // ---- compareDistributions: cardinality change ----
  const cardDrift = compareDistributions(
    { code: { kind: 'categorical', nullRate: 0, cardinality: 0.95, top: ['x'] } },
    { code: { kind: 'categorical', nullRate: 0, cardinality: 0.10, top: ['x'] } },
  );
  ok(cardDrift.some(d => /distinct-value ratio changed/.test(d)), 'compare: a large cardinality change is flagged');

  // ---- compareDistributions: stable -> no drift ----
  ok(compareDistributions(fpBase, fpBase).length === 0, 'compare: identical fingerprints report no drift');

  // ---- compareDistributions: tolerates an older baseline missing new fields ----
  const legacyBaseline = { amount: { kind: 'numeric', mean: amt.mean, std: amt.std } }; // no nullRate/cardinality/min/max
  ok(Array.isArray(compareDistributions(legacyBaseline, { amount: amt })),
    'compare: does not throw when the stored baseline predates null-rate/cardinality fields');

  // ---- CROSS-SESSION persistence via injected store ----
  // Two DIFFERENT table names (i.e. different files) sharing ONE schema. The
  // store keys by schema signature, so the second file is compared against the
  // fingerprint the first file left behind — the headline "last month vs this
  // month" scenario. Distinct table names also mean the in-session baseline
  // cannot fire, isolating the persistent path.
  const store = makeFakeStore();

  const monthOne = baseRows.map(r => ({ ...r }));
  const dsMonth1 = await makeDataset('export_january', monthOne);
  const r1 = await runAllLayers(dsMonth1, { fingerprintStore: store });
  ok(r1.distribution_drift.status === 'pass' && /baseline/i.test(r1.distribution_drift.summary),
    `persist: first file establishes a baseline (status=${r1.distribution_drift.status})`);
  ok(store.map.size === 1, 'persist: exactly one schema fingerprint stored after the first file');

  const monthTwo = [];
  for (let i = 0; i < 100; i++) {
    monthTwo.push({
      id: i,
      amount: 1000 + (i % 10),                 // mean shifted ~10x -> huge σ shift
      category: i % 4 === 0 ? 'A' : 'B',
      note: i < 40 ? null : `n${i}`,           // null rate 2% -> 40%
    });
  }
  const dsMonth2 = await makeDataset('export_february', monthTwo);
  const r2 = await runAllLayers(dsMonth2, { fingerprintStore: store });
  ok(r2.distribution_drift.status === 'fail',
    `persist: second same-schema file is flagged for drift vs the stored fingerprint (status=${r2.distribution_drift.status})`);
  ok(/previous session/.test(r2.distribution_drift.summary),
    'persist: drift is attributed to the stored (previous-session) fingerprint, not the in-session one');
  const detail = JSON.stringify(r2.distribution_drift.detail || []);
  ok(/amount/.test(detail) && /null rate/.test(detail),
    'persist: drift detail names the shifted mean and the null-rate jump');
  ok((store.map.values().next().value.version) === 2,
    'persist: the stored baseline was updated to version 2 after the second file');

  // ---- OPT-OUT: no store injected => no persistence, in-session only ----
  const dsNoStore = await makeDataset('export_march', monthTwo.map(r => ({ ...r })));
  const r3 = await runAllLayers(dsNoStore, {}); // no fingerprintStore
  ok(r3.distribution_drift.status === 'pass',
    'opt-out: with no store injected the layer only establishes an in-session baseline (no cross-session drift)');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
