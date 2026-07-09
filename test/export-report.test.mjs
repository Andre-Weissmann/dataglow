// ============================================================
// DATAGLOW — Export / Reporting layer unit tests
// ============================================================
// Exercises the Universal Export Contract (js/export-report.js) and its delivery
// adapters (js/export-delivery.js) with NO browser and NO real SheetJS: the
// pure view/PDF builders run as-is, SheetJS is injected as a tiny fake, and the
// browser/desktop adapters run against a fake `window`. Also asserts the two
// modules contain no network primitives, guarding DATAGLOW's zero-upload promise.
//
// RUN WITH:  node test/export-report.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDatasetView,
  buildReportLines,
  buildReportPdfBlob,
  buildWorkbookBlob,
  buildBlobFor,
  exportDataset,
} from '../js/export/export-report.js';
import {
  selectAdapter,
  deliverViaBrowser,
  deliverViaDesktop,
  deliverViaMobile,
} from '../js/export/export-delivery.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// --- Fakes -----------------------------------------------------------------

// Minimal SheetJS stand-in: records appended sheets, returns deterministic bytes.
function fakeXLSX() {
  return {
    utils: {
      book_new: () => ({ SheetNames: [], Sheets: {} }),
      aoa_to_sheet: (aoa) => ({ __aoa: aoa }),
      book_append_sheet: (wb, sheet, name) => { wb.SheetNames.push(name); wb.Sheets[name] = sheet; },
    },
    write: (wb, opts) => {
      wb.__wrote = opts;
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04" zip magic
    },
  };
}

// Minimal window: enough of Blob/URL/document for the browser adapter.
function fakeWindow() {
  const clicks = [];
  let created = 0, revoked = 0;
  return {
    __clicks: clicks,
    get __created() { return created; },
    get __revoked() { return revoked; },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    URL: {
      createObjectURL: () => { created++; return 'blob:fake/' + created; },
      revokeObjectURL: () => { revoked++; },
    },
    document: {
      body: { appendChild() {}, },
      createElement: () => {
        const a = { href: '', download: '', click() { clicks.push({ href: a.href, download: a.download }); }, remove() {}, };
        return a;
      },
    },
  };
}

function sampleView() {
  return buildDatasetView({
    dataset: { name: 'Claims 2026', table: 'claims_2026', rowCount: 1234, cols: [{ name: 'id' }, { name: 'amount' }], loadedAt: Date.now() },
    columns: ['id', 'amount'],
    rows: [{ id: 1, amount: 10.5 }, { id: 2, amount: null }],
    validation: [
      { layer: 'unit_tests', name: 'Unit Test Layer', status: 'pass', summary: 'ok' },
      { layer: 'confidence', name: 'Confidence Layer', status: 'warn', summary: 'low' },
    ],
    grades: { overall: 'B', integrity: 'A', plausibility: 'C' },
    generatedAt: new Date('2026-07-09T00:00:00Z'),
  });
}

async function main() {
  // --- buildDatasetView -----------------------------------------------------
  {
    const v = sampleView();
    ok(v.rowCount === 1234, 'view: prefers dataset rowCount over exported row length');
    ok(v.columnCount === 2, 'view: column count from columns');
    ok(v.tableName === 'claims_2026', 'view: table name carried');
    ok(v.generatedAt === '2026-07-09T00:00:00.000Z', 'view: generatedAt override applied');

    const bare = buildDatasetView({ dataset: { table: 't', cols: [{ name: 'a' }] } });
    ok(bare.columns.length === 1 && bare.columns[0] === 'a', 'view: derives columns from dataset.cols when none passed');
    ok(bare.rowCount === 0 && bare.validation.length === 0, 'view: sane defaults with no rows/validation');
  }

  // --- PDF builder ----------------------------------------------------------
  {
    const v = sampleView();
    const lines = buildReportLines(v);
    ok(lines[0].includes('Claims 2026'), 'pdf lines: title names the dataset');
    ok(lines.some(l => l.startsWith('Generated: ')), 'pdf lines: has generation timestamp');
    ok(lines.some(l => l.includes('Rows: 1234')), 'pdf lines: has row count');
    ok(lines.some(l => l.includes('Columns: 2')), 'pdf lines: has column count');
    ok(lines.some(l => l.includes('[WARN] Confidence Layer')), 'pdf lines: renders validation status');

    const blob = buildReportPdfBlob(v);
    const text = Buffer.from(blob.data).toString('latin1');
    ok(text.startsWith('%PDF-1.4'), 'pdf: begins with %PDF-1.4 header');
    ok(text.includes('\nxref\n') && text.trimEnd().endsWith('%%EOF'), 'pdf: has xref table and %%EOF trailer');
    ok(text.includes('/Type /Catalog') && text.includes('/BaseFont /Helvetica'), 'pdf: has catalog + font');
    ok(blob.mimeType === 'application/pdf' && blob.filename.endsWith('.pdf'), 'pdf: correct mime + filename');
    ok(blob.filename === 'dataglow-Claims-2026-report.pdf', 'pdf: filename stem is filesystem-safe');

    // Offsets in the xref must point at "<n> 0 obj" markers.
    const firstOffset = parseInt(text.slice(text.indexOf('xref\n0 ')).match(/\n(\d{10}) 00000 n /)[1], 10);
    ok(text.slice(firstOffset).startsWith('1 0 obj'), 'pdf: xref offset resolves to object 1');
  }

  // --- Excel builder (injected fake SheetJS) --------------------------------
  {
    const v = sampleView();
    const blob = buildWorkbookBlob(v, { xlsx: fakeXLSX() });
    ok(blob.data instanceof Uint8Array && blob.data.length > 0, 'xlsx: returns non-empty bytes');
    ok(blob.filename === 'dataglow-Claims-2026.xlsx', 'xlsx: filename derived from dataset');
    ok(blob.mimeType.includes('spreadsheetml'), 'xlsx: correct spreadsheet mime type');

    // No SheetJS available anywhere → clear error.
    let threw = false;
    try { buildWorkbookBlob(v, { xlsx: {} }); } catch { threw = true; }
    ok(threw, 'xlsx: throws a clear error when SheetJS is unavailable');
  }

  // --- Adapter selection ----------------------------------------------------
  {
    ok(selectAdapter('desktop') === deliverViaDesktop, 'adapter: desktop → deliverViaDesktop');
    ok(selectAdapter('mobile') === deliverViaMobile, 'adapter: mobile → deliverViaMobile');
    ok(selectAdapter('browser') === deliverViaBrowser, 'adapter: browser → deliverViaBrowser');
    ok(selectAdapter(undefined) === deliverViaBrowser, 'adapter: default → deliverViaBrowser');

    let threw = false;
    try { await deliverViaMobile(); } catch { threw = true; }
    ok(threw, 'adapter: mobile stub throws (future work, not implemented)');
  }

  // --- Browser delivery -----------------------------------------------------
  {
    const win = fakeWindow();
    const out = await deliverViaBrowser({ data: new Uint8Array([1, 2]), filename: 'x.pdf', mimeType: 'application/pdf' }, { win });
    ok(out.delivered && out.via === 'browser', 'browser delivery: reports delivered');
    ok(win.__clicks.length === 1 && win.__clicks[0].download === 'x.pdf', 'browser delivery: clicked a synthetic <a download>');
    ok(win.__created === 1 && win.__revoked === 1, 'browser delivery: created and revoked one object URL');
  }

  // --- Desktop delivery: fallback + native path -----------------------------
  {
    // No __TAURI__ → transparent browser fallback.
    const win = fakeWindow();
    const out = await deliverViaDesktop({ data: new Uint8Array([1]), filename: 'y.xlsx', mimeType: 'x' }, { win });
    ok(out.delivered && out.via === 'browser', 'desktop delivery: falls back to browser when Tauri APIs absent');

    // With __TAURI__ dialog+fs → native save.
    const saved = {};
    const tauriWin = {
      __TAURI__: {
        dialog: { save: async (o) => { saved.opts = o; return '/home/u/z.pdf'; } },
        fs: { writeBinaryFile: async (arg) => { saved.write = arg; } },
      },
    };
    const out2 = await deliverViaDesktop({ data: new Uint8Array([9]), filename: 'z.pdf', mimeType: 'application/pdf' }, { win: tauriWin });
    ok(out2.delivered && out2.via === 'desktop' && out2.filename === '/home/u/z.pdf', 'desktop delivery: uses Tauri dialog.save + fs.writeBinaryFile');
    ok(saved.write && saved.write.path === '/home/u/z.pdf' && saved.write.contents instanceof Uint8Array, 'desktop delivery: wrote bytes to chosen path');

    // Cancelled dialog → not delivered, no throw.
    const cancelWin = { __TAURI__: { dialog: { save: async () => null }, fs: { writeBinaryFile: async () => { throw new Error('should not write'); } } } };
    const out3 = await deliverViaDesktop({ data: new Uint8Array([1]), filename: 'c.pdf', mimeType: 'application/pdf' }, { win: cancelWin });
    ok(!out3.delivered && out3.cancelled, 'desktop delivery: cancelled Save-As reports not-delivered without throwing');
  }

  // --- exportDataset end-to-end (build + deliver) ---------------------------
  {
    const win = fakeWindow();
    const res = await exportDataset({
      format: 'pdf', platform: 'browser', win,
      dataset: { name: 'D', table: 'd', rowCount: 3, cols: [{ name: 'a' }] },
      columns: ['a'], rows: [{ a: 1 }],
    });
    ok(res.format === 'pdf' && res.delivery.delivered, 'exportDataset: pdf built and delivered');

    const res2 = await exportDataset({
      format: 'xlsx', platform: 'browser', win, xlsx: fakeXLSX(),
      dataset: { name: 'D', table: 'd', rowCount: 3, cols: [{ name: 'a' }] },
      columns: ['a'], rows: [{ a: 1 }],
    });
    ok(res2.format === 'xlsx' && res2.delivery.delivered, 'exportDataset: xlsx built (injected SheetJS) and delivered');

    let threw = false;
    try { await exportDataset({ format: 'json' }); } catch { threw = true; }
    ok(threw, 'exportDataset: unknown format is rejected');
    ok(buildBlobFor('pdf', sampleView()).mimeType === 'application/pdf', 'buildBlobFor: routes pdf');
  }

  // --- Zero-upload guard: no network primitives in the source ---------------
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/;
    for (const f of ['export-report.js', 'export-delivery.js']) {
      const src = readFileSync(join(here, '..', 'js', 'export', f), 'utf8');
      ok(!netRe.test(src), `zero-upload: js/export/${f} contains no network primitive`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
