// ============================================================
// DATAGLOW — Gen 9 Batch 1 test suite
// ============================================================
// Covers the three Gen 9 Batch 1 features:
//   Feature 1 — Domain Physics Engine (pack rule matching + transforms, and the
//               end-to-end runAllLayers wiring with the pack on vs "none")
//   Feature 2 — Confidence-Calibrated Grades (two-axis, edge cases)
//   Feature 3 — Verifiable Provenance Attestation (export + independent verify
//               round-trip, tamper detection, honest notarization labelling)
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/domain-physics.test.mjs
//
// The production modules import '../js/duckdb-engine.js'; the loader hook
// transparently redirects that to the native node-duckdb-engine.mjs.

import { createTableFromObjects, getTableSchema, runQuery, closeConnection } from './node-duckdb-engine.mjs';

import { runAllLayers } from '../js/validation.js';
import {
  applyDomainPack, listPacks, summarizeUnitTests, DOMAIN_PACKS,
} from '../js/domain-physics.js';
import { computeCalibratedGrades } from '../js/calibrated-grades.js';
import {
  createProvenanceChain, buildAttestation, verifyAttestation,
  computeAttestationDigest, verifyChainArray, renderAttestationHTML,
} from '../js/provenance.js';
import { clearLedger, getLedgerEntries } from '../js/assumption-ledger.js';

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

async function main() {
  clearLedger();

  // ============================================================
  // Feature 1 — Domain Physics Engine
  // ============================================================

  // -- listPacks exposes "none" and "healthcare" for the UI selector.
  const packs = listPacks();
  ok(packs.some(p => p.name === 'none') && packs.some(p => p.name === 'healthcare'),
    'physics: listPacks() exposes both "none" and "healthcare"');
  ok(DOMAIN_PACKS.none.rules.length === 0,
    'physics: the "none" pack applies zero rules (raw, domain-agnostic output)');

  // -- summarizeUnitTests derives pass/warn/fail from the same findings array.
  ok(summarizeUnitTests([]).status === 'pass',
    'physics: summarizeUnitTests([]) → pass');
  ok(summarizeUnitTests([{ severity: 'warn', text: 'x' }]).status === 'warn',
    'physics: a warn-only findings array → warn');
  ok(summarizeUnitTests([{ severity: 'fail', text: 'x' }, { severity: 'warn', text: 'y' }]).status === 'fail',
    'physics: any fail finding → fail');

  // -- Rule matching: applyDomainPack only touches columns its match() selects.
  //    Build a synthetic layer-result map + column metadata and confirm the
  //    de-id date-shift rule downgrades only the systematic far-future column.
  {
    const findings = [
      { kind: 'future_date', column: 'admit_date', severity: 'fail', text: 'future', meta: { farFutureShare: 0.99 } },
      { kind: 'future_date', column: 'note_date', severity: 'fail', text: 'future', meta: { farFutureShare: 0.05 } },
    ];
    const layerResults = { unit_tests: { ...summarizeUnitTests(findings), findings } };
    const columns = [
      { name: 'admit_date', type: 'DATE', numeric: false, isBinary01: false },
      { name: 'note_date', type: 'DATE', numeric: false, isBinary01: false },
      { name: 'patient_id', type: 'BIGINT', numeric: true, isBinary01: false },
    ];
    const summary = applyDomainPack(layerResults, 'healthcare', { columns });
    const f = layerResults.unit_tests.findings;
    const admit = f.find(x => x.column === 'admit_date');
    const note = f.find(x => x.column === 'note_date');
    ok(admit.severity === 'warn', 'physics: systematic far-future date column downgraded fail→warn');
    ok(note.severity === 'fail', 'physics: sporadic future-date column stays a hard fail');
    ok(summary.annotations.some(a => a.rule === 'deid-date-shift' && a.column === 'admit_date'),
      'physics: an annotation records the de-id reinterpretation for the calibrated grades');
    ok(layerResults.unit_tests.status === 'fail',
      'physics: overall unit_tests still fail (the sporadic column is a real defect)');
  }

  // -- Rule matching: protected-category rule flips a cluster to sensitive.
  {
    const clusters = [
      { column: 'race', canonical: 'A', variants: [{ value: 'A', count: 5 }, { value: 'A ', count: 3 }], merges: [{ from: 'A ', to: 'A', count: 3 }], sensitive: false },
      { column: 'city', canonical: 'Paris', variants: [{ value: 'Paris', count: 5 }, { value: 'paris', count: 3 }], merges: [{ from: 'paris', to: 'Paris', count: 3 }], sensitive: false },
    ];
    const layerResults = { categorical_consistency: { status: 'warn', detail: [], clusters } };
    const columns = [
      { name: 'race', type: 'VARCHAR', numeric: false, isBinary01: false },
      { name: 'city', type: 'VARCHAR', numeric: false, isBinary01: false },
    ];
    applyDomainPack(layerResults, 'healthcare', { columns });
    const race = layerResults.categorical_consistency.clusters.find(c => c.column === 'race');
    const city = layerResults.categorical_consistency.clusters.find(c => c.column === 'city');
    ok(race.sensitive === true, 'physics: "race" cluster flipped to sensitive (auto-merge disabled)');
    ok(city.sensitive === false, 'physics: non-protected "city" cluster stays mergeable');
  }

  // -- Rule matching: binary 0/1 columns are exempted from Benford.
  {
    const layerResults = { benford: { status: 'warn', detail: ['"mortality_flag": deviates'], flags: ['"mortality_flag": deviates'], skips: [] } };
    const columns = [{ name: 'mortality_flag', type: 'BIGINT', numeric: true, isBinary01: true }];
    applyDomainPack(layerResults, 'healthcare', { columns });
    const b = layerResults.benford;
    ok(!b.flags.some(f => /mortality_flag/.test(f)),
      'physics: binary 0/1 column removed from Benford flags');
    ok(b.skips.some(s => /binary 0\/1 flag column/.test(s)),
      'physics: binary column recorded as an explained Benford exemption');
  }

  // -- "none" pack is a genuine no-op (raw output restored).
  {
    const findings = [{ kind: 'future_date', column: 'admit_date', severity: 'fail', text: 'future', meta: { farFutureShare: 0.99 } }];
    const layerResults = { unit_tests: { ...summarizeUnitTests(findings), findings } };
    const columns = [{ name: 'admit_date', type: 'DATE', numeric: false, isBinary01: false }];
    applyDomainPack(layerResults, 'none', { columns });
    ok(layerResults.unit_tests.findings[0].severity === 'fail',
      'physics: the "none" pack leaves the raw fail untouched');
  }

  // -- End-to-end: runAllLayers with healthcare (default) vs none.
  const deidRows = [];
  for (let i = 1; i <= 40; i++) {
    deidRows.push({ patient_id: i, admit_date: `${2180 + (i % 5)}-06-${String((i % 27) + 1).padStart(2, '0')}`, mortality_flag: i % 2 });
  }
  const deidDs = await makeDataset('phys_deid', deidRows);
  const healthcareResults = await runAllLayers(deidDs, { pack: 'healthcare' });
  ok(healthcareResults.unit_tests.status === 'warn',
    'physics(e2e): healthcare pack downgrades systematic de-id dates to warn');
  ok(healthcareResults.domainPack && healthcareResults.domainPack.packName === 'healthcare',
    'physics(e2e): results.domainPack records the active pack');
  const noneResults = await runAllLayers(deidDs, { pack: 'none' });
  ok(noneResults.unit_tests.status === 'fail',
    'physics(e2e): turning the pack off restores the raw fail on the same data');

  // ============================================================
  // Gen 34 Stage B — Domain Pack Marketplace (Retail + Finance)
  //   The two new packs generalize the swappable pack architecture beyond
  //   healthcare. Each must fire on matching columns, stay silent on
  //   non-matching ones, and never break the run if a rule throws.
  // ============================================================

  // -- listPacks now exposes all four packs for the picker UI.
  {
    const names = listPacks().map(p => p.name);
    ok(['none', 'healthcare', 'retail', 'finance'].every(n => names.includes(n)),
      'stageB: listPacks() exposes none, healthcare, retail, and finance');
    ok(DOMAIN_PACKS.retail.rules.length >= 2 && DOMAIN_PACKS.finance.rules.length >= 2,
      'stageB: retail and finance packs each ship 2-3 rules');
  }

  // -- Retail: SKU columns get auto-merge disabled; a plain text column stays mergeable.
  {
    const clusters = [
      { column: 'sku', canonical: 'A', variants: [], merges: [], sensitive: false },
      { column: 'city', canonical: 'Paris', variants: [], merges: [], sensitive: false },
    ];
    const layerResults = { categorical_consistency: { status: 'warn', detail: [], clusters } };
    const columns = [
      { name: 'sku', type: 'VARCHAR', numeric: false, isBinary01: false },
      { name: 'city', type: 'VARCHAR', numeric: false, isBinary01: false },
    ];
    const summary = applyDomainPack(layerResults, 'retail', { columns });
    const sku = layerResults.categorical_consistency.clusters.find(c => c.column === 'sku');
    const city = layerResults.categorical_consistency.clusters.find(c => c.column === 'city');
    ok(sku.sensitive === true, 'stageB(retail): "sku" cluster flipped to no-merge');
    ok(city.sensitive === false, 'stageB(retail): non-SKU "city" cluster stays mergeable');
    ok(summary.annotations.some(a => a.rule === 'retail-sku-no-merge' && a.column === 'sku'),
      'stageB(retail): an annotation records the SKU no-merge reinterpretation');
  }

  // -- Retail: a binary return flag is exempted from Benford; a real numeric amount is not.
  {
    const layerResults = { benford: { status: 'warn', detail: ['"is_returned": deviates'], flags: ['"is_returned": deviates'], skips: [] } };
    const columns = [
      { name: 'is_returned', type: 'BIGINT', numeric: true, isBinary01: true },
      { name: 'order_total', type: 'DOUBLE', numeric: true, isBinary01: false },
    ];
    applyDomainPack(layerResults, 'retail', { columns });
    const b = layerResults.benford;
    ok(!b.flags.some(f => /is_returned/.test(f)), 'stageB(retail): binary return flag removed from Benford flags');
    ok(b.skips.some(s => /binary 0\/1 flag column/.test(s) && /retail pack/.test(s)),
      'stageB(retail): return flag recorded as an explained retail Benford exemption');
  }

  // -- Retail: price outliers reinterpreted as seasonal; a non-price numeric column is untouched.
  {
    const layerResults = { outlier_detection: { status: 'warn', summary: '2 column(s) contain outliers', detail: ['"unit_price": 4 high (MAD z>3.5)', '"customer_id": 1 above IQR fence'] } };
    const columns = [
      { name: 'unit_price', type: 'DOUBLE', numeric: true, isBinary01: false },
      { name: 'customer_id', type: 'BIGINT', numeric: true, isBinary01: false },
    ];
    const summary = applyDomainPack(layerResults, 'retail', { columns });
    const o = layerResults.outlier_detection;
    ok(o.detail.some(d => /unit_price/.test(d) && /seasonal|promotions/i.test(d)),
      'stageB(retail): price outlier replaced with an explanatory seasonal note (not silently dropped)');
    ok(o.detail.some(d => /customer_id/.test(d) && /IQR fence/.test(d)),
      'stageB(retail): a non-price column\'s outlier finding is left untouched');
    ok(summary.annotations.some(a => a.rule === 'retail-seasonal-outlier' && a.column === 'unit_price'),
      'stageB(retail): the seasonal reinterpretation is annotated');
  }

  // -- Finance: ledger/account columns get auto-merge disabled.
  {
    const clusters = [
      { column: 'gl_account', canonical: '4000', variants: [], merges: [], sensitive: false },
      { column: 'notes', canonical: 'misc', variants: [], merges: [], sensitive: false },
    ];
    const layerResults = { categorical_consistency: { status: 'warn', detail: [], clusters } };
    const columns = [
      { name: 'gl_account', type: 'VARCHAR', numeric: false, isBinary01: false },
      { name: 'notes', type: 'VARCHAR', numeric: false, isBinary01: false },
    ];
    applyDomainPack(layerResults, 'finance', { columns });
    const acct = layerResults.categorical_consistency.clusters.find(c => c.column === 'gl_account');
    const notes = layerResults.categorical_consistency.clusters.find(c => c.column === 'notes');
    ok(acct.sensitive === true, 'stageB(finance): "gl_account" cluster flipped to no-merge');
    ok(notes.sensitive === false, 'stageB(finance): non-account "notes" cluster stays mergeable');
  }

  // -- Finance: reconciliation flag exempted from Benford; debit/credit outliers reinterpreted.
  {
    const benfordResults = { benford: { status: 'warn', detail: ['"is_reconciled": deviates'], flags: ['"is_reconciled": deviates'], skips: [] } };
    applyDomainPack(benfordResults, 'finance', { columns: [{ name: 'is_reconciled', type: 'BIGINT', numeric: true, isBinary01: true }] });
    ok(!benfordResults.benford.flags.some(f => /is_reconciled/.test(f)) &&
       benfordResults.benford.skips.some(s => /finance pack/.test(s)),
      'stageB(finance): binary reconciliation flag recorded as an explained finance Benford exemption');

    const outlierResults = { outlier_detection: { status: 'warn', summary: '1 column(s) contain outliers', detail: ['"debit_amount": 6 high (MAD z>3.5)'] } };
    applyDomainPack(outlierResults, 'finance', { columns: [{ name: 'debit_amount', type: 'DOUBLE', numeric: true, isBinary01: false }] });
    ok(outlierResults.outlier_detection.status === 'pass' &&
       outlierResults.outlier_detection.detail.some(d => /debit_amount/.test(d) && /double-entry/i.test(d)),
      'stageB(finance): the only outlier column is reinterpreted, dropping the layer to pass with a note');
  }

  // -- Safety contract: a rule that throws is caught and skipped, and the run's
  //    other rules still apply — a buggy pack rule can never break validation.
  {
    const broken = {
      id: 'retail-broken-test-rule',
      appliesToLayer: 'categorical_consistency',
      description: 'Deliberately throws to exercise the engine\'s error isolation.',
      match: (c) => c.name === 'sku',
      transform() { throw new Error('deliberate rule failure'); },
    };
    DOMAIN_PACKS.retail.rules.push(broken);
    const clusters = [{ column: 'sku', canonical: 'A', variants: [], merges: [], sensitive: false }];
    const layerResults = { categorical_consistency: { status: 'warn', detail: [], clusters } };
    const columns = [{ name: 'sku', type: 'VARCHAR', numeric: false, isBinary01: false }];
    let threw = false;
    let summary = null;
    try { summary = applyDomainPack(layerResults, 'retail', { columns }); }
    catch { threw = true; }
    DOMAIN_PACKS.retail.rules.pop(); // restore the pack so later tests are unaffected
    ok(threw === false && summary && summary.packName === 'retail',
      'stageB(safety): a rule that throws does not break applyDomainPack');
    ok(layerResults.categorical_consistency.clusters[0].sensitive === true,
      'stageB(safety): the healthy SKU no-merge rule still applied despite the broken rule');
  }

  // ============================================================
  // Feature 2 — Confidence-Calibrated Grades (two-axis)
  //   Integrity  = mechanical well-formedness (unit_tests, cross_column_logic,
  //                categorical_consistency, schema_fingerprint, sanity_anchor,
  //                reproducibility).
  //   Domain     = real-world plausibility (physiological_plausibility,
  //                distribution_drift, semantic_drift, outlier_detection,
  //                benford, correlation_watchdog), with reinterpretation credit.
  // ============================================================

  // -- All layers pass on both axes → both grade A + honest labelling.
  {
    const results = {
      unit_tests: { status: 'pass' }, cross_column_logic: { status: 'pass' },
      categorical_consistency: { status: 'pass' }, schema_fingerprint: { status: 'pass' },
      sanity_anchor: { status: 'pass' }, reproducibility: { status: 'pass' },
      physiological_plausibility: { status: 'pass' }, distribution_drift: { status: 'pass' },
      semantic_drift: { status: 'pass' }, outlier_detection: { status: 'pass' },
      benford: { status: 'pass' }, correlation_watchdog: { status: 'pass' },
    };
    const cg = computeCalibratedGrades({ results, packName: 'healthcare', annotations: [] });
    ok(cg.integrity.grade === 'A', 'grades: all mechanical checks pass → integrity A');
    ok(cg.plausibility.grade === 'A' && cg.plausibility.concerns === 0,
      'grades: all domain checks pass → domain confidence A, no concerns');
    ok(cg.overall.grade === 'A', 'grades: both axes A → overall A');
    ok(/[Hh]euristic/.test(cg.integrity.explanation) && /[Hh]euristic/.test(cg.plausibility.explanation),
      'grades: both axes are explicitly labelled heuristic');
    ok(/[Nn]ot a legal or clinical/.test(cg.integrity.explanation),
      'grades: integrity explanation disclaims legal/clinical determination');
    ok(cg.integrity.considered === 6 && cg.plausibility.considered === 6,
      'grades: each axis aggregates its six mapped layers when all ran');
  }

  // -- Only idle/absent layers → axis defaults to full (never a false failure).
  {
    const cg = computeCalibratedGrades({ results: { unit_tests: { status: 'idle' } }, packName: 'none', annotations: [] });
    ok(cg.integrity.considered === 0 && cg.integrity.grade === 'A',
      'grades: idle/not-run layers are excluded, not counted as failures');
  }

  // -- KEY DIFFERENTIATOR A: HIGH integrity + LOW domain confidence.
  //    Every mechanical check passes (the data is perfectly well-formed) but the
  //    subject-matter layers fail — physiologically impossible values that no
  //    longer resemble known-good data. Integrity must stay high while domain
  //    confidence collapses; the two axes are independent.
  {
    const results = {
      unit_tests: { status: 'pass' }, cross_column_logic: { status: 'pass' },
      categorical_consistency: { status: 'pass' }, schema_fingerprint: { status: 'pass' },
      sanity_anchor: { status: 'pass' }, reproducibility: { status: 'pass' },
      physiological_plausibility: { status: 'fail' }, distribution_drift: { status: 'fail' },
      semantic_drift: { status: 'fail' }, outlier_detection: { status: 'fail' },
      benford: { status: 'fail' }, correlation_watchdog: { status: 'fail' },
    };
    const cg = computeCalibratedGrades({ results, packName: 'none', annotations: [] });
    ok(cg.integrity.grade === 'A', 'grades(differentiator): mechanically clean data keeps integrity A');
    ok(cg.plausibility.grade === 'F', 'grades(differentiator): domain-implausible data drops domain confidence to F');
    ok(cg.integrity.score > cg.plausibility.score,
      'grades(differentiator): integrity can be high while domain confidence is low');
    ok(cg.plausibility.concerns === 6,
      'grades(differentiator): all six domain layers register as concerns');
  }

  // -- KEY DIFFERENTIATOR B: LOW integrity + HIGH domain confidence.
  //    Mechanically broken (duplicates, impossible cross-column combos) but the
  //    values that ARE present are domain-plausible.
  {
    const results = {
      unit_tests: { status: 'fail' }, cross_column_logic: { status: 'fail' },
      categorical_consistency: { status: 'fail' }, schema_fingerprint: { status: 'fail' },
      sanity_anchor: { status: 'fail' }, reproducibility: { status: 'fail' },
      physiological_plausibility: { status: 'pass' }, distribution_drift: { status: 'pass' },
      semantic_drift: { status: 'pass' }, outlier_detection: { status: 'pass' },
      benford: { status: 'pass' }, correlation_watchdog: { status: 'pass' },
    };
    const cg = computeCalibratedGrades({ results, packName: 'none', annotations: [] });
    ok(cg.integrity.grade === 'F', 'grades(differentiator): mechanically broken data → integrity F');
    ok(cg.plausibility.grade === 'A', 'grades(differentiator): domain-plausible values → domain confidence A');
    ok(cg.plausibility.score > cg.integrity.score,
      'grades(differentiator): domain confidence can be high while integrity is low');
  }

  // -- Reinterpretation credit: a domain layer flag the pack contextualised
  //    (annotation carries the matching `layer`) counts LESS against domain
  //    confidence than the same flag left unexplained.
  {
    const results = {
      physiological_plausibility: { status: 'pass' }, distribution_drift: { status: 'pass' },
      semantic_drift: { status: 'pass' }, outlier_detection: { status: 'pass' },
      benford: { status: 'warn' }, correlation_watchdog: { status: 'pass' },
    };
    const unreviewed = computeCalibratedGrades({ results, packName: 'none', annotations: [] });
    const reinterpreted = computeCalibratedGrades({ results, packName: 'healthcare', annotations: [{ layer: 'benford' }] });
    ok(unreviewed.plausibility.concerns === 1 && unreviewed.plausibility.interpreted === 0,
      'grades: an unreviewed domain flag is a concern with no interpretation credit');
    ok(reinterpreted.plausibility.interpreted === 1 &&
       reinterpreted.plausibility.score > unreviewed.plausibility.score,
      'grades: a domain flag the pack reinterpreted raises domain confidence vs. the raw flag');
    ok(reinterpreted.plausibility.layers.some(l => l.layer === 'benford' && l.credited === true),
      'grades: the per-layer breakdown marks the reinterpreted layer as credited');
  }

  // ============================================================
  // Feature 3 — Verifiable Provenance Attestation
  // ============================================================
  {
    const chain = createProvenanceChain();
    await chain.append('load', 'Loaded raw CSV', null, 'a'.repeat(64));
    await chain.append('clean', 'Removed 2 duplicate rows');
    await chain.append('query', 'Aggregated by department');

    const att = await chain.attest({ table: 'claims', rowCount: 1234, columns: [{ name: 'id', type: 'BIGINT' }, { name: 'amt', type: 'DOUBLE' }], loadedAt: Date.now() });

    ok(att.kind === 'dataglow-provenance-attestation' && att.chain.length === 3,
      'attest: attestation packages the full 3-step chain + metadata');
    ok(att.dataset.rowCount === 1234 && att.dataset.colCount === 2,
      'attest: dataset row/column counts are captured');
    ok(typeof att.summary === 'string' && /not a legal or clinical/i.test(att.summary),
      'attest: human-readable summary is present and honestly labelled');

    // Honest notarization labelling (legal-risk constraint #1).
    ok(att.notarization && att.notarization.notarized === false && att.notarization.status === 'digest-ready-for-notarization',
      'attest: notarization is honestly labelled "digest-ready", never falsely "notarized"');
    ok(Array.isArray(att.notarization.howToNotarize) &&
       att.notarization.howToNotarize.some(h => /opentimestamps/i.test(h)) &&
       att.notarization.howToNotarize.some(h => /openssl ts/i.test(h)),
      'attest: documents independent notarization via OpenTimestamps and `openssl ts`');

    // Round-trip verify on the untouched export.
    const good = await verifyAttestation(att);
    ok(good.valid && good.chain.valid && good.digest.valid,
      'attest: an untouched attestation verifies (chain + digest both valid)');

    // Independent chain re-verification (what verify-attestation.mjs does).
    const chainOnly = await verifyChainArray(att.chain.steps);
    ok(chainOnly.valid, 'attest: verifyChainArray independently confirms the hash-chain math');

    // Tamper with a step's description → chain hash mismatch is caught.
    const tampered = JSON.parse(JSON.stringify(att));
    tampered.chain.steps[1].description = 'Removed 0 duplicate rows (falsified)';
    const badChain = await verifyAttestation(tampered);
    ok(!badChain.valid && badChain.chain.brokenAt === 1,
      'attest: editing a recorded step is detected (chain broken at that step)');

    // Tamper with dataset metadata only → chain still links, but the document
    // digest no longer matches its content.
    const tampered2 = JSON.parse(JSON.stringify(att));
    tampered2.dataset.rowCount = 9999;
    const badDigest = await verifyAttestation(tampered2);
    ok(!badDigest.valid && !badDigest.digest.valid,
      'attest: editing metadata after export breaks the document digest');

    // Digest is a deterministic function of content.
    const d1 = await computeAttestationDigest(att);
    const d2 = await computeAttestationDigest(att);
    ok(d1 === d2 && d1 === att.digest.value,
      'attest: the digest is deterministic and matches the stored value');

    // PDF-friendly HTML renders and contains the key facts.
    const html = renderAttestationHTML(att);
    ok(/<html/i.test(html) && html.includes('claims') && html.includes(att.digest.value),
      'attest: renderAttestationHTML produces a self-contained certificate with the digest');
    ok(/not.*(legal|clinical)/i.test(html) && /notariz/i.test(html),
      'attest: the HTML certificate keeps the honest, non-legal disclaimer');
  }

  await closeConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
