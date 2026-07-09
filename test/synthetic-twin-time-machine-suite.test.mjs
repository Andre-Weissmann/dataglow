// ============================================================
// DATAGLOW — Gen 9 Batch 3 test file
// Synthetic Adversarial Twin · Data Time Machine ·
// Federated Fingerprinting (Experimental) · IRB Mode
// ============================================================
// Verifies the four Batch 3 features against their real logic:
//   6. Synthetic Twin  — DP Laplace-mechanism correctness + statistical utility
//                        of the synthetic column stats vs. the real ones
//   7. Time Machine     — content-hash determinism, snapshot/diff round-trip,
//                        and archive export/parse round-trip
//   8. Fingerprinting   — min-n suppression, no raw values leak, JSD distance
//                        correctness, and a meaningful-difference comparison
//   9. IRB Mode         — templated document model + HTML rendering with the
//                        actual validation findings substituted in
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/synthetic-twin-time-machine-suite.test.mjs
//
// These four feature modules are pure (no DOM/engine), so datasets here are
// built as plain JS row arrays — no DuckDB needed.

import { laplaceNoise, addPrivacyBudgetNoise } from '../js/privacy/privacy-budget.js';
import {
  generateSyntheticTwin, buildNumericHistogram, noiseHistogramCounts,
  numericStats, toCSV, DEFAULT_EPSILON, SYNTHETIC_TWIN_DISCLAIMER,
} from '../js/privacy/synthetic-twin.js';
import {
  contentHash, canonicalize, summarizeDiffFromPrevious, buildSnapshot,
  exportArchive, parseArchive,
} from '../js/simulation/time-machine.js';
import {
  buildFingerprint, computeColumnFingerprint, jensenShannonDivergence,
  rebinDistribution, compareFingerprints, MIN_N, FINGERPRINT_DISCLAIMER,
} from '../js/federated/federated-fingerprint.js';
import { buildIRBDocument, renderIRBHTML, IRB_DISCLAIMER } from '../js/provenance/irb-mode.js';

// ---------- tiny test harness ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// Deterministic PRNG (mulberry32, public domain) for reproducible DP draws.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  // ============================================================
  // Feature 6 — Synthetic Adversarial Twin
  // ============================================================

  // (a) Laplace mechanism formula correctness. laplaceNoise(scale, rng) uses the
  // inverse CDF -scale*sign(u)*ln(1-2|u|) with u = rng()-0.5.
  ok(approx(laplaceNoise(1, () => 0.5), 0, 1e-12), 'DP: Laplace noise is 0 at the distribution median (u=0)');
  ok(approx(laplaceNoise(1, () => 0.75), Math.log(2), 1e-9), 'DP: Laplace(scale=1) at u=0.25 equals scale·ln2 (inverse-CDF check)');
  ok(approx(laplaceNoise(4, () => 0.75), 4 * Math.log(2), 1e-9), 'DP: Laplace noise scales linearly with the scale parameter');

  // addPrivacyBudgetNoise: scale = sensitivity/epsilon.
  ok(approx(addPrivacyBudgetNoise(10, 2, 2, () => 0.75), 10 + (2 / 2) * Math.log(2), 1e-9), 'DP: addPrivacyBudgetNoise uses scale = sensitivity / epsilon');
  let threw = false; try { addPrivacyBudgetNoise(1, 1, 0); } catch { threw = true; }
  ok(threw, 'DP: epsilon <= 0 is rejected');

  // (b) Laplace draws have ~0 mean and std ≈ scale·√2 over many samples.
  {
    const rng = mulberry32(7);
    const scale = 3, N = 40000;
    let sum = 0, sumsq = 0;
    for (let i = 0; i < N; i++) { const x = laplaceNoise(scale, rng); sum += x; sumsq += x * x; }
    const mean = sum / N, std = Math.sqrt(sumsq / N - mean * mean);
    ok(approx(mean, 0, 0.15), `DP: empirical Laplace mean ≈ 0 (got ${mean.toFixed(3)})`);
    ok(approx(std, scale * Math.SQRT2, scale * 0.15), `DP: empirical Laplace std ≈ scale·√2 (got ${std.toFixed(3)}, expected ${(scale * Math.SQRT2).toFixed(3)})`);
  }

  // (c) Histogram noising keeps counts non-negative.
  {
    const hist = buildNumericHistogram([1, 2, 2, 3, 3, 3, 4, 4, 4, 4], 4);
    ok(hist.counts.reduce((a, b) => a + b, 0) === 10, 'twin: histogram bins every value exactly once');
    const noised = noiseHistogramCounts(hist.counts, 0.5, mulberry32(1));
    ok(noised.every(c => c >= 0), 'twin: DP-noised histogram counts are clamped to >= 0');
  }

  // (d) Statistical utility: synthetic numeric column mean/std track the real
  // ones within noise bounds when epsilon is generous.
  {
    const rng = mulberry32(42);
    const rows = [];
    for (let i = 0; i < 600; i++) {
      const age = 30 + Math.round((rng() + rng() + rng()) / 3 * 40); // ~ centered around 50
      rows.push({ age, region: rng() < 0.6 ? 'North' : (rng() < 0.5 ? 'South' : 'East') });
    }
    const columns = [{ name: 'age', type: 'BIGINT' }, { name: 'region', type: 'VARCHAR' }];
    const twin = generateSyntheticTwin({ columns, rows, epsilon: 40, bins: 24, rng: mulberry32(99) });

    ok(twin.rows.length === rows.length, 'twin: synthetic dataset has the same row count as the source');
    ok(twin.epsilon === 40 && /Laplace/.test(twin.mechanism), 'twin: records the DP epsilon budget and Laplace mechanism');
    ok(twin.disclaimer === SYNTHETIC_TWIN_DISCLAIMER, 'twin: carries the mandatory research-preview disclaimer');

    const ageCmp = twin.comparison.find(c => c.column === 'age');
    ok(ageCmp.type === 'numeric', 'twin: age column is modeled as numeric');
    ok(approx(ageCmp.synthetic.mean, ageCmp.real.mean, 4), `twin: synthetic age mean within noise bound of real (real=${ageCmp.real.mean}, synth=${ageCmp.synthetic.mean})`);
    ok(approx(ageCmp.synthetic.std, ageCmp.real.std, Math.max(3, ageCmp.real.std * 0.4)), `twin: synthetic age spread is comparable to real (real std=${ageCmp.real.std}, synth std=${ageCmp.synthetic.std})`);

    const regionCmp = twin.comparison.find(c => c.column === 'region');
    const realTop = regionCmp.real.top[0].value, synthTop = regionCmp.synthetic.top[0].value;
    ok(realTop === synthTop, `twin: synthetic categorical modal value matches the real modal value ("${realTop}")`);

    // DEFAULT_EPSILON is 5 per the brainstorm doc.
    ok(DEFAULT_EPSILON === 5, 'twin: default epsilon is 5 (privacy/utility tradeoff from the brainstorm doc)');

    const csv = toCSV(twin.columns, twin.rows);
    ok(csv.split('\n').length === rows.length + 1 && csv.startsWith('age,region'), 'twin: CSV export has a header plus one line per synthetic row');
  }

  // ============================================================
  // Feature 7 — Data Time Machine
  // ============================================================
  const colsTM = ['id', 'value', 'label'];
  const stateA = [
    { id: 1, value: 10, label: 'a' },
    { id: 2, value: 20, label: 'b' },
    { id: 3, value: 30, label: 'c' },
  ];
  // stateB: id 3 changed value, id 4 added, id 1 removed.
  const stateB = [
    { id: 2, value: 20, label: 'b' },
    { id: 3, value: 33, label: 'c' },
    { id: 4, value: 40, label: 'd' },
  ];

  ok(contentHash(colsTM, stateA) === contentHash(colsTM, stateA), 'time-machine: content hash is deterministic for identical state');
  ok(contentHash(colsTM, stateA) !== contentHash(colsTM, stateB), 'time-machine: content hash differs when the data differs');
  ok(canonicalize(colsTM, stateA).includes('10'), 'time-machine: canonicalization includes cell values in a stable order');

  const diffSum = summarizeDiffFromPrevious(colsTM, stateA, colsTM, stateB);
  ok(diffSum.rowChanges && diffSum.rowChanges.keyColumn === 'id', 'time-machine: diff summary auto-keys on the id column');
  ok(diffSum.rowChanges.added === 1 && diffSum.rowChanges.removed === 1 && diffSum.rowChanges.changed === 1, `time-machine: diff summary counts add/remove/change (${diffSum.text})`);

  const snap1 = buildSnapshot({ datasetName: 'demo', columns: colsTM, rows: stateA, previous: null, now: 1000 });
  const snap2 = buildSnapshot({ datasetName: 'demo', columns: colsTM, rows: stateB, previous: snap1, now: 2000 });
  ok(snap1.kind === 'dataglow-snapshot' && snap1.hash === contentHash(colsTM, stateA), 'time-machine: snapshot embeds the content hash');
  ok(/Initial snapshot/.test(snap1.diffSummary.text), 'time-machine: first snapshot is labeled as the initial state');
  ok(snap2.diffSummary.rowChanges.changed === 1 && snap2.rows.length === 3, 'time-machine: second snapshot diffs against the first and embeds rows');

  const archiveJson = exportArchive([snap1, snap2]);
  const parsed = parseArchive(archiveJson);
  ok(parsed.kind === 'dataglow-snapshot-archive' && parsed.snapshots.length === 2, 'time-machine: archive export/parse round-trips both snapshots');
  ok(contentHash(parsed.snapshots[0].columns, parsed.snapshots[0].rows) === snap1.hash, 'time-machine: archived snapshot rows still hash to the original snapshot hash (round-trip integrity)');
  let badArchive = false; try { parseArchive('{"kind":"nope"}'); } catch { badArchive = true; }
  ok(badArchive, 'time-machine: a non-DATAGLOW archive file is rejected');

  // ============================================================
  // Feature 8 — Federated Fingerprinting (Experimental)
  // ============================================================
  // (a) JSD correctness: identical => 0, disjoint => ln2 (max), symmetric.
  ok(approx(jensenShannonDivergence([0.5, 0.5], [0.5, 0.5]), 0, 1e-12), 'fingerprint: JSD of identical distributions is 0');
  ok(approx(jensenShannonDivergence([1, 0], [0, 1]), Math.log(2), 1e-9), 'fingerprint: JSD of disjoint distributions equals ln2 (maximum)');
  ok(approx(jensenShannonDivergence([0.7, 0.3], [0.3, 0.7]), jensenShannonDivergence([0.3, 0.7], [0.7, 0.3]), 1e-12), 'fingerprint: JSD is symmetric');

  // (b) rebinDistribution conserves probability mass.
  {
    const reb = rebinDistribution([0.25, 0.25, 0.25, 0.25], 0, 4, -1, 5, 6);
    ok(approx(reb.reduce((a, b) => a + b, 0), 1, 1e-9), 'fingerprint: re-binning a numeric distribution conserves total mass');
  }

  // (c) Minimum-n floor: a column with < MIN_N non-null rows is suppressed.
  {
    const small = Array.from({ length: MIN_N - 1 }, (_, i) => i);
    const fpSmall = computeColumnFingerprint({ name: 'x', type: 'BIGINT' }, small, { epsilon: 1, rng: mulberry32(3) });
    ok(fpSmall.suppressed === true && !fpSmall.distribution, `fingerprint: column with n=${MIN_N - 1} (< ${MIN_N}) is suppressed with no distribution emitted`);
    const big = Array.from({ length: MIN_N }, (_, i) => i);
    const fpBig = computeColumnFingerprint({ name: 'x', type: 'BIGINT' }, big, { epsilon: 1, rng: mulberry32(3) });
    ok(!fpBig.suppressed && Array.isArray(fpBig.distribution), `fingerprint: column with n=${MIN_N} (>= floor) is fingerprinted`);
  }

  // (d) No raw values leak into an exported fingerprint. Use deliberately
  // non-round observations so the exact extremes cannot coincide with a
  // rounded/aggregate number.
  {
    const rows = [];
    for (let i = 0; i < 200; i++) rows.push({ score: 1013 + i * 11, site: i % 2 ? 'Common' : 'Other' });
    const rawMin = 1013, rawMax = 1013 + 199 * 11; // 3202
    const columns = [{ name: 'score', type: 'BIGINT' }, { name: 'site', type: 'VARCHAR' }];
    const fp = buildFingerprint({ datasetName: 'siteA', columns, rows, epsilon: 5, rng: mulberry32(11) });
    ok(fp.experimental === true && fp.disclaimer === FINGERPRINT_DISCLAIMER, 'fingerprint: export is flagged experimental and carries the mandatory disclaimer');
    ok(fp.minN === MIN_N, 'fingerprint: export records the min-n floor that was enforced');
    const json = JSON.stringify(fp);
    // The exact extreme observations must NOT appear (they are individual data
    // points); only coarsened bounds and noised distribution shape are exported.
    const leaked = [rawMin, rawMax, 1013 + 50 * 11, 1013 + 137 * 11].some(v => json.includes(String(v)));
    ok(!leaked, 'fingerprint: no exact raw observation (incl. min/max extremes) appears in the exported JSON');
    const scoreCol = fp.columns.find(c => c.name === 'score');
    ok(scoreCol.min <= rawMin && scoreCol.max >= rawMax && scoreCol.min !== rawMin && scoreCol.max !== rawMax, 'fingerprint: numeric bounds are coarsened outward, hiding the exact extremes');
    ok(/"note":"Contains only noised/.test(json), 'fingerprint: export self-documents that it contains no raw values');
  }

  // (e) Comparison distance: a shifted numeric column shows a higher JSD than an
  // unchanged one, and is flagged meaningful.
  {
    const cols = [{ name: 'age', type: 'BIGINT' }, { name: 'los', type: 'BIGINT' }];
    const rowsA = [], rowsB = [];
    const rA = mulberry32(1), rB = mulberry32(2);
    for (let i = 0; i < 400; i++) {
      const age = 40 + Math.round(rA() * 20);
      rowsA.push({ age, los: 3 + Math.round(rA() * 4) });
      // Site B: same age distribution, but LOS shifted much higher.
      rowsB.push({ age: 40 + Math.round(rB() * 20), los: 20 + Math.round(rB() * 4) });
    }
    const fpA = buildFingerprint({ datasetName: 'siteA', columns: cols, rows: rowsA, epsilon: 30, rng: mulberry32(5) });
    const fpB = buildFingerprint({ datasetName: 'siteB', columns: cols, rows: rowsB, epsilon: 30, rng: mulberry32(6) });
    const cmp = compareFingerprints(fpA, fpB);
    ok(cmp.kind === 'dataglow-fingerprint-comparison', 'fingerprint: comparison produces a DATAGLOW comparison report');
    const ageEntry = cmp.columns.find(c => c.column === 'age');
    const losEntry = cmp.columns.find(c => c.column === 'los');
    ok(losEntry.jsd > ageEntry.jsd, `fingerprint: shifted LOS column has higher JSD than the unchanged age column (los=${losEntry.jsd} > age=${ageEntry.jsd})`);
    ok(losEntry.meaningful === true, 'fingerprint: the shifted column is flagged as meaningfully different');
    ok(cmp.summary.meaningfullyDifferent >= 1, 'fingerprint: comparison summary counts the meaningfully-different columns');
  }

  // ============================================================
  // Feature 9 — IRB / Regulatory Language Auto-Translation Mode
  // ============================================================
  {
    // Minimal but realistic validation results map + supporting artifacts.
    const results = {
      unit_tests: { status: 'fail', summary: '2 unit assertions failed (age out of range; duplicate rows).' },
      null_check: { status: 'warn', summary: '3% nulls in discharge_date.' },
      schema_fingerprint: { status: 'pass', summary: 'Schema matches expected fingerprint.' },
      confidence: { status: 'warn', score: 68, grade: 'C', verdict: 'Use with caution' },
    };
    const ledger = [
      { ts: 1000, source: 'Imputation Engine', action: 'Filled 3 null discharge_date values with column median.' },
      { ts: 2000, source: "Benford's Law Check", action: 'Skipped "age" — bounded range.' },
    ];
    const trail = [
      { index: 0, op: 'load', description: 'Loaded patients.csv (100 rows).', hash: 'abcdef0123456789aaaa', parentHash: '0'.repeat(64) },
      { index: 1, op: 'clean', description: 'Removed 2 duplicate rows.', hash: 'fedcba9876543210bbbb', parentHash: 'abcdef0123456789aaaa' },
    ];

    const doc = buildIRBDocument({
      datasetName: 'MIMIC sample cohort',
      results, ledgerEntries: ledger, provenanceTrail: trail,
      provenanceVerification: { valid: true, reason: 'All 2 step(s) verified — the provenance chain is intact.' },
      deidentification: { method: 'Differential privacy (Laplace mechanism)', epsilon: 5, notes: 'Applied to aggregate exports only.' },
      generatedAt: 1700000000000,
    });

    ok(doc.kind === 'dataglow-irb-document' && doc.sections.length === 7, `IRB: builds a 7-section document model (got ${doc.sections.length})`);
    const headings = doc.sections.map(s => s.heading);
    ok(headings.some(h => /Data Integrity Controls/.test(h)), 'IRB: includes a "Data Integrity Controls" section');
    ok(headings.some(h => /Chain of Custody/.test(h)), 'IRB: includes a "Chain of Custody / Provenance" section');
    ok(headings.some(h => /De-identification Method Disclosure/.test(h)), 'IRB: includes a "De-identification Method Disclosure" section');
    ok(headings.some(h => /Known Limitations/.test(h)), 'IRB: includes a "Known Limitations & Residual Risk" section');

    const integrity = doc.sections.find(s => s.id === 'integrity');
    ok(/Unit Test Layer/.test(integrity.body) || integrity.layers.some(l => l.name === 'Unit Test Layer' && l.status === 'fail'), 'IRB: the integrity section reflects the real failed validation layer');
    const deid = doc.sections.find(s => s.id === 'deid');
    ok(/epsilon \(ε\) = 5/.test(deid.body) && /Laplace/.test(deid.body), 'IRB: de-identification disclosure states the actual DP epsilon budget');

    const html = renderIRBHTML(doc);
    ok(/^<!DOCTYPE html>/.test(html.trim()), 'IRB: renders a self-contained HTML document');
    ok(html.includes('MIMIC sample cohort'), 'IRB: HTML shows the dataset name');
    ok(html.includes('Data Integrity Controls') && html.includes('Chain of Custody'), 'IRB: HTML shows the IRB section headers');
    ok(html.includes('Removed 2 duplicate rows'), 'IRB: HTML substitutes the real provenance chain-of-custody steps');
    ok(html.includes('Filled 3 null discharge_date values'), 'IRB: HTML substitutes the real assumption-ledger entries');
    ok(html.includes(IRB_DISCLAIMER) || html.includes('documentation aid'), 'IRB: HTML includes the "documentation aid, not a substitute" disclaimer');
    ok(!/<script/i.test(html), 'IRB: HTML contains no scripts (safe to open/print standalone)');

    // No-deid path: document must instruct that a HIPAA method be applied.
    const doc2 = buildIRBDocument({ datasetName: 'raw cohort', results, generatedAt: 1700000000000 });
    const deid2 = doc2.sections.find(s => s.id === 'deid');
    ok(/No de-identification method/.test(deid2.body) && /164\.514/.test(deid2.body), 'IRB: when no de-id method is disclosed, the document cites HIPAA §164.514 and flags the gap');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
