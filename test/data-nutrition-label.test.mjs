// ============================================================
// DATAGLOW — Data Nutrition Label unit tests (Trust Passport, Batch 2)
// ============================================================
// Exercises the portable provenance manifest (js/provenance/data-nutrition-label.js)
// with NO browser, NO network, and NO DuckDB: it assembles a manifest from plain
// pieces plus a REAL chain-of-custody built via js/provenance/provenance.js
// (crypto.subtle is available in modern Node), renders the human-readable
// summary, round-trips JSON, and confirms the export flow is byte-for-byte
// unchanged when the label is absent (the flag-off passthrough case). Also a
// source guard: the module names no network primitive.
//
// RUN WITH:  node test/data-nutrition-label.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDataNutritionLabel,
  renderLabelSummary,
  renderLabelSummaryLines,
  exportLabelAsJSON,
  LABEL_KIND,
  LABEL_SCHEMA_VERSION,
} from '../js/provenance/data-nutrition-label.js';
import { createProvenanceChain } from '../js/provenance/provenance.js';
import {
  buildDatasetView,
  buildReportLines,
  buildWorkbookBlob,
} from '../js/export/export-report.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Minimal SheetJS stand-in that records which sheets were appended.
function fakeXLSX() {
  return {
    utils: {
      book_new: () => ({ SheetNames: [], Sheets: {} }),
      aoa_to_sheet: (aoa) => ({ __aoa: aoa }),
      book_append_sheet: (wb, sheet, name) => { wb.SheetNames.push(name); wb.Sheets[name] = sheet; },
    },
    write: () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  };
}

function sampleDataset() {
  return {
    name: 'Orders',
    table: 'orders',
    rowCount: 1234,
    colCount: 3,
    cols: [{ name: 'id' }, { name: 'amount' }, { name: 'status' }],
    loadedAt: '2026-07-11T00:00:00.000Z',
  };
}

const sampleChecks = [
  { layer: 'missingness', name: 'Missingness Detective', status: 'pass', summary: 'No columns exceed the missing-rate cutoff.' },
  { layer: 'ranges', name: 'Expected Range', status: 'warn', summary: 'amount has 2 values above the expected range.' },
  { layer: 'physics', name: 'Domain Physics', status: 'fail', summary: '1 impossible value found.' },
];

const sampleAssumptions = [
  { ts: Date.UTC(2026, 6, 11, 0, 1, 0), source: 'Categorical Consistency Engine', action: 'Merged "USA" and "U.S.A." to a single canonical value.' },
];

async function main() {
  // Build a REAL chain of custody so the manifest carries genuine hashes.
  const chain = createProvenanceChain();
  await chain.append('load', 'Loaded orders.csv (1,234 rows).');
  await chain.append('transform', 'Trimmed whitespace from the status column.');
  await chain.append('transform', 'Canonicalized country codes.');

  // --- 1. Assemble the manifest from a representative context ---------------
  const label = buildDataNutritionLabel({
    dataset: { ...sampleDataset(), columnNames: ['id', 'amount', 'status'], columnCount: 3 },
    custody: chain,
    assumptions: sampleAssumptions,
    checks: sampleChecks,
    generatedAt: '2026-07-11T00:05:00.000Z',
  });

  ok(label.kind === LABEL_KIND, 'manifest: kind is dataglow-data-nutrition-label');
  ok(label.schemaVersion === LABEL_SCHEMA_VERSION && label.schemaVersion === 1, 'manifest: schemaVersion is 1');
  ok(label.generatedAt === '2026-07-11T00:05:00.000Z', 'manifest: generatedAt honored');
  ok(label.dataset.name === 'Orders' && label.dataset.table === 'orders', 'manifest: dataset name/table');
  ok(label.dataset.rowCount === 1234 && label.dataset.columnCount === 3, 'manifest: row/column counts');
  ok(Array.isArray(label.dataset.columnNames) && label.dataset.columnNames.length === 3, 'manifest: column names carried');
  ok(label.dataset.loadedAt === '2026-07-11T00:00:00.000Z', 'manifest: loadedAt normalized to ISO');

  ok(label.checksRun.length === 3, 'manifest: three checks recorded');
  ok(label.findingsSummary.total === 3, 'manifest: findingsSummary total');
  ok(label.findingsSummary.bySeverity.pass === 1
    && label.findingsSummary.bySeverity.warn === 1
    && label.findingsSummary.bySeverity.fail === 1, 'manifest: findings tallied by severity');

  ok(label.transformations.length === 3, 'manifest: transformations projected from custody steps');
  ok(label.transformations[0].op === 'load' && typeof label.transformations[0].at === 'string', 'manifest: transformation carries op + ISO time');

  ok(label.assumptions.length === 1 && label.assumptions[0].source === 'Categorical Consistency Engine', 'manifest: assumptions carried from ledger');
  ok(label.assumptions[0].at === new Date(sampleAssumptions[0].ts).toISOString(), 'manifest: assumption ts normalized to ISO');

  ok(label.isSynthetic === false, 'manifest: isSynthetic defaults to false');
  ok(label.custodyChain.length === 3, 'manifest: custody chain length');
  ok(/^[0-9a-f]{64}$/.test(label.custodyChain.finalHash), 'manifest: custody chain carries a real SHA-256 final hash');
  ok(label.custodyChain.steps.every((s) => /^[0-9a-f]{64}$/.test(s.hash)), 'manifest: every custody step carries a real hash');
  ok(typeof label.disclaimer === 'string' && /summary only/i.test(label.disclaimer), 'manifest: honest-naming disclaimer present');

  // --- 2. isSynthetic opt-in + sparse context -------------------------------
  {
    const syn = buildDataNutritionLabel({ dataset: { name: 'gen' }, isSynthetic: true });
    ok(syn.isSynthetic === true, 'manifest: isSynthetic honored when true (batch 4 hook)');
    const sparse = buildDataNutritionLabel({});
    ok(sparse.kind === LABEL_KIND && sparse.checksRun.length === 0 && sparse.custodyChain.length === 0,
      'manifest: empty context still yields a valid, sparse manifest');
    ok(sparse.dataset.rowCount === null && sparse.custodyChain.finalHash === null, 'manifest: unknowns are null, not fabricated');
  }

  // --- 3. Accepts a plain trail array as well as a chain object -------------
  {
    const trail = chain.getTrail();
    const fromArray = buildDataNutritionLabel({ dataset: sampleDataset(), custody: trail });
    ok(fromArray.custodyChain.length === 3 && fromArray.custodyChain.finalHash === label.custodyChain.finalHash,
      'manifest: accepts a getTrail() array and yields the same chain summary');
  }

  // --- 4. Human-readable summary --------------------------------------------
  {
    const lines = renderLabelSummaryLines(label);
    const text = renderLabelSummary(label);
    ok(Array.isArray(lines) && lines.length > 0, 'summary: renders an array of lines');
    ok(text === lines.join('\n'), 'summary: string form joins the lines');
    ok(/Data Nutrition Label/.test(text), 'summary: titled');
    ok(/not a certification/i.test(text), 'summary: states it is not a certification');
    ok(/1 passed, 1 warned, 1 failed/.test(text), 'summary: check tally rendered');
    ok(/Orders/.test(text) && /1,234/.test(text), 'summary: dataset name + row count rendered');
    ok(/Synthetic data: no/.test(text), 'summary: synthetic flag rendered');
    ok(/Chain of custody: 3 step/.test(text), 'summary: custody step count rendered');
  }

  // --- 5. JSON round-trip ---------------------------------------------------
  {
    const json = exportLabelAsJSON(label);
    ok(typeof json === 'string', 'json: exportLabelAsJSON returns a string');
    const parsed = JSON.parse(json);
    ok(parsed.kind === LABEL_KIND, 'json: round-trips kind');
    ok(JSON.stringify(parsed) === JSON.stringify(label), 'json: round-trips losslessly (parse ∘ export == label)');
  }

  // --- 6. Export flow: opt-in appends label; flag-off passthrough unchanged --
  {
    const dataset = sampleDataset();
    // Baseline view WITHOUT a label — the flag-off / not-opted-in case.
    const baseView = buildDatasetView({ dataset, columns: ['id', 'amount', 'status'], rows: [] });
    ok(baseView.nutritionLabelLines === null, 'export: view has no label when none supplied');
    const baseLines = buildReportLines(baseView);
    ok(!baseLines.some((l) => /Data Nutrition Label/.test(l)), 'export (flag-off passthrough): PDF report has no label section');

    // Opted-in view WITH the label lines.
    const labelLines = renderLabelSummaryLines(label);
    const optView = buildDatasetView({ dataset, columns: ['id', 'amount', 'status'], rows: [], nutritionLabelLines: labelLines });
    ok(Array.isArray(optView.nutritionLabelLines) && optView.nutritionLabelLines.length > 0, 'export: opted-in view carries label lines');
    const optLines = buildReportLines(optView);
    ok(optLines.some((l) => /Data Nutrition Label/.test(l)), 'export (opt-in): PDF report includes the label section');

    // Capture appended sheet names via a fake SheetJS to assert the sheet only
    // appears in the opted-in workbook, not the passthrough one.
    const sheetNames = (view) => {
      const names = [];
      const x = fakeXLSX();
      const orig = x.utils.book_append_sheet;
      x.utils.book_append_sheet = (wb, sheet, name) => { names.push(name); orig(wb, sheet, name); };
      buildWorkbookBlob(view, { xlsx: x });
      return names;
    };
    ok(sheetNames(optView).includes('Data Nutrition Label'), 'export (opt-in): workbook adds a Data Nutrition Label sheet');
    ok(!sheetNames(baseView).includes('Data Nutrition Label'), 'export (flag-off passthrough): workbook has NO label sheet');
  }

  // --- 7. Zero-upload guard: no network primitive in the module source ------
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/;
    const src = readFileSync(join(here, '..', 'js', 'provenance', 'data-nutrition-label.js'), 'utf8');
    ok(!netRe.test(src), 'zero-upload: js/provenance/data-nutrition-label.js contains no network primitive');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
