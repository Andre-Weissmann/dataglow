// ============================================================
// DATAGLOW — 18-layer validation + Assumption Ledger test suite
// ============================================================
// Loads the extended golden dataset and confirms every validation layer —
// including the three new ones (Categorical Consistency Engine #16,
// Cross-Column Logical Consistency #17, Distributional Fingerprint Drift #18),
// the Benford Statistical Test Eligibility Gate, and the Assumption Ledger —
// catches the issues seeded into the fixture.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/validation-layers.test.mjs
//
// The production modules import '../js/duckdb-engine.js'; the loader hook
// transparently redirects that to the native node-duckdb-engine.mjs.

import { createTableFromObjects, getTableSchema, closeConnection } from './node-duckdb-engine.mjs';

import { LAYER_DEFS, runAllLayers } from '../js/validation.js';
import { buildGoldenDataset } from '../js/loaders.js';
import { clusterValues, withCanonical } from '../js/categorical-consistency.js';
import { getLedgerEntries, clearLedger } from '../js/assumption-ledger.js';

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
  return JSON.stringify(r && (r.detail || r.summary) || '');
}

// ============================================================
async function main() {
  clearLedger();

  // ---- Layer registry ----
  ok(LAYER_DEFS.length === 18, `registry: 18 validation layers defined (got ${LAYER_DEFS.length})`);
  const ids = new Set(LAYER_DEFS.map(l => l.id));
  ok(ids.has('categorical_consistency'), 'registry: layer 16 (categorical_consistency) present');
  ok(ids.has('cross_column_logic'), 'registry: layer 17 (cross_column_logic) present');
  ok(ids.has('distribution_drift'), 'registry: layer 18 (distribution_drift) present');

  // ---- Pure clustering algorithm (dependency-free) ----
  const clusters = clusterValues([
    { value: 'United States', n: 30 },
    { value: 'United State', n: 4 },
    { value: 'USA', n: 5 },
    { value: 'US', n: 5 },
    { value: 'France', n: 8 },
    { value: 'FRA', n: 3 },
  ]);
  const usCluster = clusters.find(c => c.canonical === 'United States');
  ok(usCluster && usCluster.variants.length >= 3, 'cluster: near-duplicate + abbreviation spellings of "United States" grouped');
  const frCluster = clusters.find(c => c.variants.some(v => v.value === 'France') && c.variants.some(v => v.value === 'FRA'));
  ok(!!frCluster, 'cluster: "France" and abbreviation "FRA" grouped via ISO lookup');

  // ---- User-editable canonical (accept / reject / edit per cluster) ----
  const editCluster = usCluster;
  // Accept-as-is: withCanonical with the proposal is a no-op on the mapping.
  const asIs = withCanonical(editCluster, editCluster.canonical);
  ok(asIs.canonical === editCluster.canonical && asIs.merges.length === editCluster.merges.length,
    'withCanonical: accepting the proposal preserves the suggested mapping');
  // Edit to an existing variant: that variant becomes the untouched target.
  const toUSA = withCanonical(editCluster, 'USA');
  ok(toUSA.canonical === 'USA' && toUSA.merges.every(m => m.from !== 'USA') && toUSA.merges.some(m => m.from === 'United States'),
    'withCanonical: editing to an existing variant remaps every other variant to it');
  // Edit to a brand-new spelling not among the variants: all variants merge in.
  const custom = withCanonical(editCluster, 'U.S.A.');
  ok(custom.canonical === 'U.S.A.' && custom.merges.length === editCluster.variants.length,
    'withCanonical: a custom canonical merges every observed variant into it');
  // Empty / whitespace override is ignored (keeps the original proposal).
  const empty = withCanonical(editCluster, '   ');
  ok(empty.canonical === editCluster.canonical, 'withCanonical: blank override falls back to the proposal');
  // Purity: the source cluster is never mutated.
  ok(editCluster.canonical === 'United States', 'withCanonical: does not mutate the input cluster');

  // ---- Full 18-layer run on the extended golden dataset ----
  const goldenRows = buildGoldenDataset();
  const ds = await makeDataset('golden_test_dataset', goldenRows);
  const results = await runAllLayers(ds);

  // Layer 16 — Categorical Consistency Engine
  const cc = results.categorical_consistency;
  ok(cc && cc.status === 'warn', `layer16: flagged inconsistent categories (status=${cc && cc.status})`);
  ok(cc && Array.isArray(cc.clusters) && cc.clusters.some(c => c.canonical === 'United States'),
    'layer16: proposed "United States" as canonical merge target');
  ok(/country/.test(detailStr(cc)), 'layer16: reported the "country" column');

  // Layer 17 — Cross-Column Logical Consistency
  const cx = results.cross_column_logic;
  ok(cx && cx.status === 'fail', `layer17: flagged logical inconsistencies (status=${cx && cx.status})`);
  ok(/discharge_date.*admit_date|admit_date.*discharge_date/.test(detailStr(cx)),
    'layer17: detected discharge_date before admit_date');
  ok(/has_retirement_account/.test(detailStr(cx)),
    'layer17: detected minor (age<18) with adult-only status');

  // Benford Statistical Test Eligibility Gate
  const bf = results.benford;
  ok(/age.*skipped|skipped.*age/i.test(detailStr(bf)),
    'benford-gate: "age" skipped as a bounded range with an explanation');
  ok(!/"claim_amount" skipped/.test(detailStr(bf)),
    'benford-gate: "claim_amount" (naturally scaled) was NOT skipped');

  // Existing layers still catch their seeded issues
  ok(results.unit_tests.status === 'fail', `unit_tests: still fails on seeded issues (status=${results.unit_tests.status})`);
  ok(results.semantic_drift.status === 'fail', `semantic_drift: still catches age=999 (status=${results.semantic_drift.status})`);

  // Layer 18 — Distributional Fingerprint Drift: baseline on first load
  const dd1 = results.distribution_drift;
  ok(dd1 && dd1.status === 'pass' && /baseline/i.test(dd1.summary),
    `layer18: baseline fingerprint recorded on first load (status=${dd1 && dd1.status})`);

  // Second load of the SAME schema with drifted data -> drift flagged
  const drifted = buildGoldenDataset().map(r => ({
    ...r,
    claim_amount: (r.claim_amount == null ? null : Number(r.claim_amount) * 6 + 5000),
    country: 'Germany',
  }));
  const ds2 = await makeDataset('golden_test_dataset', drifted);
  const results2 = await runAllLayers(ds2);
  const dd2 = results2.distribution_drift;
  ok(dd2 && dd2.status === 'fail', `layer18: drift flagged on same-schema reload (status=${dd2 && dd2.status})`);
  ok(/claim_amount|country/.test(detailStr(dd2)), 'layer18: named the drifted column(s)');

  // ---- Assumption Ledger ----
  const entries = getLedgerEntries();
  ok(entries.length > 0, `ledger: recorded entries during validation (got ${entries.length})`);
  const sources = new Set(entries.map(e => e.source));
  ok(sources.has('Categorical Consistency Engine'), 'ledger: Categorical Consistency Engine logged a decision');
  ok(sources.has('Statistical Test Eligibility Gate'), 'ledger: Benford eligibility gate logged a skip decision');
  ok(sources.has('Cross-Column Logical Consistency'), 'ledger: Cross-Column checker logged a finding');
  ok(sources.has('Distributional Fingerprint Drift'), 'ledger: drift detector logged a drift entry');

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
