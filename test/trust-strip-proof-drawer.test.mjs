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

  // ---------- 4. Flag-off regression guard (ships dark) ----------
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'flags.manifest.json'), 'utf8'));
  configureFlags(manifest);
  ok(isEnabled('metricStudio') === false, 'flags: metricStudio ships OFF (nothing renders)');
  ok(isEnabled('trustStripProofDrawer') === false, 'flags: trustStripProofDrawer ships OFF (nothing renders)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
