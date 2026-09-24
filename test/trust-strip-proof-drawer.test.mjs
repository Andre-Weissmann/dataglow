// ============================================================
// DATAGLOW — Trust Strip + Proof Drawer test suite (OneCanvas Phase 1, Parts 3 & 4)
// ============================================================
// Proves the real-data collectors + content builders behave as specified:
//   - collectTrustSignals renders sensibly with ZERO data loaded (clean empty
//     state, no undefined/broken values),
//   - with real data it reports the true validation pass/warn/fail tally, the
//     metric certification counts, and lineage availability from the chain,
//   - buildProofContent produces correct content for each trigger type (metric,
//     each Trust Strip field, provenance) — reusing the existing attestation
//     renderer for lineage rather than duplicating it,
//   - the flag-off regression guard: with metricStudio + trustStripProofDrawer
//     both OFF (their shipped defaults in flags.manifest.json), the gate the
//     caller checks returns false so nothing renders.
//
// Pure JS — no DuckDB, no DOM. RUN WITH:
//   node test/trust-strip-proof-drawer.test.mjs

import { collectTrustSignals } from '../js/trust/trust-strip.js';
import { buildProofContent } from '../js/trust/proof-drawer.js';
import { createLineage, addStep } from '../js/app-shell/bench-shell.js';
import { configureFlags, isEnabled } from '../js/build/build-flags.js';
import { createProvenanceChain } from '../js/provenance/provenance.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const field = (signals, key) => signals.fields.find(f => f.key === key);

async function main() {
  // ---------- 1. Zero-data (nothing loaded) state ----------
  const empty = collectTrustSignals({});
  ok(empty.loaded === false, 'empty: reports not-loaded');
  ok(field(empty, 'freshness').value === 'nothing loaded yet' && field(empty, 'freshness').state === 'idle',
    'empty: freshness shows a clean "nothing loaded" state');
  ok(field(empty, 'validation').value === 'not yet validated', 'empty: validation is honest ("not yet validated")');
  ok(field(empty, 'anomaly').value === 'not checked', 'empty: anomaly is honest ("not checked")');
  ok(field(empty, 'certification').value === '0 certified · 0 reviewed · 0 exploratory', 'empty: 0/0/0 metrics, not faked');
  ok(field(empty, 'lineage').state === 'idle', 'empty: lineage not available');
  ok(empty.fields.every(f => typeof f.value === 'string' && f.value.length > 0), 'empty: no undefined/broken field values');

  // ---------- 2. Real-data state ----------
  const chain = createProvenanceChain();
  await chain.append('load', 'Loaded encounters.csv');
  await chain.append('clean', 'Trimmed whitespace');
  const dataset = { table: 'encounters', rowCount: 3, cols: [{ name: 'a' }], loadedAt: Date.now() - 5000 };
  const validationResults = {
    unit_tests: { status: 'pass', summary: 'all good' },
    outlier_detection: { status: 'warn', summary: '2 outliers' },
    cross_column_logic: { status: 'fail', summary: '1 impossible row' },
    narrative_consistency: { status: 'idle', summary: 'no story' },
    domainPack: { packName: 'healthcare' }, // not a layer result — must be skipped
  };
  const signals = collectTrustSignals({
    dataset, validationResults,
    metricCounts: { certified: 1, reviewed: 0, exploratory: 2, total: 3 },
    provenanceChain: chain,
    anomalyResult: { anomalies: [1, 2] },
  });
  ok(signals.loaded === true, 'real: reports loaded');
  ok(field(signals, 'validation').value === '1 pass · 1 warn · 1 fail' && field(signals, 'validation').state === 'bad',
    'real: validation tally counts only layer results (domainPack skipped) and flags fail');
  ok(field(signals, 'certification').value === '1 certified · 0 reviewed · 2 exploratory', 'real: metric counts reflect the registry');
  ok(field(signals, 'lineage').value === 'available' && /2 provenance step/.test(field(signals, 'lineage').detail),
    'real: lineage available with the true step count');
  ok(field(signals, 'anomaly').value === '2 flagged', 'real: anomaly count surfaced from injected result');

  // ---------- 3. buildProofContent — each trigger type ----------
  const metric = {
    name: 'Readmission Rate', plainEnglish: 'readmissions / discharges',
    expression: 'SUM(readmissions)/SUM(discharges)', columns: ['readmissions', 'discharges'],
    status: 'certified', computedValue: 0.125, computedAt: Date.now(),
  };
  const mContent = buildProofContent({ type: 'metric', metric });
  ok(mContent.title === 'Readmission Rate', 'proof/metric: title is the metric name');
  ok(mContent.blocks.some(b => b.kind === 'code' && b.collapsible && /SUM\(readmissions\)/.test(b.code)),
    'proof/metric: raw formula is behind a collapsible "Show the math" block');
  ok(mContent.blocks.some(b => b.kind === 'list' && b.items.includes('readmissions')), 'proof/metric: source columns listed');
  ok(mContent.blocks.some(b => b.kind === 'kv' && b.label === 'Certification status' && b.value === 'certified'),
    'proof/metric: certification status shown');

  const vContent = buildProofContent({ type: 'trust-field', field: field(signals, 'validation'), validationResults });
  ok(vContent.blocks[0].kind === 'list' && vContent.blocks[0].items.some(i => /FAIL — cross_column_logic/.test(i)),
    'proof/validation: opens the real per-layer pass/fail list');

  const cContent = buildProofContent({ type: 'trust-field', field: field(signals, 'certification'), metrics: [metric] });
  ok(cContent.blocks[0].items.some(i => /CERTIFIED — Readmission Rate/.test(i)), 'proof/certification: lists metrics by status');

  // Provenance / lineage reuses the EXISTING attestation renderer.
  const att = await chain.attest({ table: 'encounters', rowCount: 3, colCount: 1 });
  const pContent = buildProofContent({ type: 'provenance', attestation: att });
  const html = pContent.blocks.find(b => b.kind === 'html');
  ok(html && /DATAGLOW Provenance Attestation/.test(html.html), 'proof/provenance: renders via the existing renderAttestationHTML()');
  ok(/clean/.test(html.html) && /load/.test(html.html), 'proof/provenance: the real chain steps appear in the attestation');

  // Lineage with no chain → honest text, not a broken frame.
  const noChain = buildProofContent({ type: 'trust-field', field: { key: 'lineage', label: 'Lineage', detail: 'No chain.' } });
  ok(noChain.blocks[0].kind === 'text', 'proof/lineage: no chain → honest text block');

  // ---------- 3b. The Bench (Batch 3): session lineage folded into the SAME field ----------
  // benchLineage omitted entirely → byte-for-byte identical to before this param
  // existed (regression guard: the earlier assertion on `signals` above already
  // ran with no benchLineage passed, and passed).
  ok(field(signals, 'lineage').value === 'available' && !/Bench story/.test(field(signals, 'lineage').detail),
    'lineage (benchLineage omitted): unchanged detail text, no Bench story mention');

  // benchLineage WITH real steps, alongside an existing provenance chain — both
  // signals appear, neither silently drops the other.
  let bench = createLineage();
  bench = addStep(bench, { kind: 'upload', label: 'Uploaded (3 rows)' });
  bench = addStep(bench, { kind: 'sql', label: 'SELECT * FROM encounters' });
  const signalsWithBench = collectTrustSignals({
    dataset, validationResults,
    metricCounts: { certified: 1, reviewed: 0, exploratory: 2, total: 3 },
    provenanceChain: chain,
    anomalyResult: { anomalies: [1, 2] },
    benchLineage: bench,
  });
  const lf = field(signalsWithBench, 'lineage');
  ok(lf.value === 'available' && /2 provenance step/.test(lf.detail) && /2 step\(s\) in this session's Bench story/.test(lf.detail),
    'lineage (benchLineage present + chain present): both counts named in the detail text, neither dropped');

  // benchLineage WITH steps but NO provenance chain — still reports "available"
  // from the Bench story alone, not falsely "none recorded".
  const signalsBenchOnly = collectTrustSignals({ dataset, benchLineage: bench });
  const lf2 = field(signalsBenchOnly, 'lineage');
  ok(lf2.value === 'available' && lf2.state === 'ok' && /Bench story/.test(lf2.detail),
    'lineage (benchLineage present, no chain): reports available from the Bench story alone');

  // benchLineage with zero steps (freshly created, never appended to) behaves
  // exactly like benchLineage being absent — an empty story is not "available".
  const signalsEmptyBench = collectTrustSignals({ dataset, provenanceChain: chain, benchLineage: createLineage() });
  ok(field(signalsEmptyBench, 'lineage').detail === field(signals, 'lineage').detail,
    'lineage (benchLineage present but empty): identical detail text to no benchLineage at all');

  // buildProofContent's lineage case: the Bench story renders as its OWN list
  // block alongside the attestation, distinctly labelled.
  const lineageProofWithBench = buildProofContent({
    type: 'trust-field',
    field: lf,
    attestation: att,
    benchLineage: bench,
  });
  const benchBlock = lineageProofWithBench.blocks.find(b => b.kind === 'list' && b.label === "This session's Bench story");
  ok(!!benchBlock, 'proof/lineage: a Bench-story list block appears alongside the attestation when benchLineage has steps');
  ok(!!benchBlock && benchBlock.items.length === 2 && /upload: Uploaded/.test(benchBlock.items[0]) && /sql: SELECT/.test(benchBlock.items[1]),
    'proof/lineage: Bench-story items are kind-prefixed and in step order');

  // No benchLineage on the trigger → no Bench-story block appended (regression
  // guard matching the very first proof/lineage assertion above, which never
  // passed benchLineage and still only got the honest-text block).
  const lineageProofNoBench = buildProofContent({ type: 'trust-field', field: lf, attestation: att });
  ok(!lineageProofNoBench.blocks.some(b => b.kind === 'list' && b.label === "This session's Bench story"),
    'proof/lineage: no Bench-story block when the trigger carries no benchLineage');

  // ---------- 4. Flag promotion + kill-switch guard ----------
  // Both flags were PROMOTED to ON (shipped default). The gate still reads the
  // flag, so setting either back to false makes isEnabled() report false and
  // main.js's renderTrustStripPanel()/renderMetricStudioPanel() render nothing —
  // the kill-switch is intact.
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'flags.manifest.json'), 'utf8'));
  configureFlags(manifest);
  ok(isEnabled('metricStudio') === true, 'flags: metricStudio ships ON (promoted)');
  ok(isEnabled('trustStripProofDrawer') === true, 'flags: trustStripProofDrawer ships ON (promoted)');
  configureFlags({ flags: { metricStudio: { enabled: false }, trustStripProofDrawer: { enabled: false } } });
  ok(isEnabled('metricStudio') === false, 'flags: kill-switch — metricStudio OFF disables it');
  ok(isEnabled('trustStripProofDrawer') === false, 'flags: kill-switch — trustStripProofDrawer OFF disables it');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
