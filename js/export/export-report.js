// ============================================================
// DATAGLOW — Export / Reporting Layer (Universal Export Contract)
// ============================================================
// One export function PER FORMAT that returns raw bytes, fully decoupled from
// how those bytes are delivered. The "how" (browser download vs. Tauri native
// Save-As vs. a future mobile share sheet) lives entirely in the small
// per-platform adapters in js/export-delivery.js. This split is the core idea:
// adding a runtime is a new adapter, never a change to a format builder.
//
//   buildDatasetView(...)  → a normalized, format-agnostic snapshot of the
//                            active dataset + optional validation summary.
//   buildWorkbookBlob(view)→ { data: Uint8Array, filename, mimeType } (.xlsx)
//   buildReportPdfBlob(v)  → { data: Uint8Array, filename, mimeType } (.pdf)
//   exportDataset(opts)    → build for the requested format, then hand the
//                            bytes to the platform adapter. The single call the
//                            UI makes.
//
// Dependencies: Excel export reuses the SheetJS (XLSX) library already vendored
// and loaded on every page (assets/xlsx/, exposed as the global `XLSX`) — no
// new dependency. The PDF is produced by a tiny, dependency-free, first-party
// text-PDF writer below (a plain summary page), so no heavy PDF library is
// added. Everything is 100% local; nothing here performs a network request.
//
// This module is loaded through the platform-aware capability registry (see
// capability-map.manifest.json → `export-reporting`, platforms
// ["browser","desktop"]) — registry-native from creation, never a static
// import in main.js.

import { deliverBlob } from './export-delivery.js';

// ------------------------------------------------------------
// View model — the format-agnostic snapshot both builders read.
// ------------------------------------------------------------

/**
 * Build a normalized, format-agnostic view of the current dataset/analysis.
 * Pure: no I/O, no globals. The caller (main.js) supplies the raw pieces it
 * already holds in app state — the active dataset descriptor, the currently
 * displayed columns/rows, and (optionally) the last validation run.
 *
 * @param {object} opts
 * @param {object} [opts.dataset]   Active dataset descriptor { name, table, rowCount, cols, loadedAt }.
 * @param {string[]} [opts.columns] Column names as currently displayed.
 * @param {Array<object>} [opts.rows] Row objects keyed by column name.
 * @param {Array<{layer:string,name?:string,status?:string,summary?:string}>} [opts.validation]
 *        Per-layer validation summary, if a validation run is available.
 * @param {object} [opts.grades]    Optional calibrated-grade roll-up { overall, integrity, plausibility }.
 * @param {Date}   [opts.generatedAt] Override the generation timestamp (tests).
 * @returns {{title:string, datasetName:string, tableName:string, generatedAt:string,
 *   columns:string[], rows:Array<object>, rowCount:number, columnCount:number,
 *   validation:Array<object>, grades:(object|null), loadedAt:(string|null)}}
 */
export function buildDatasetView(opts = {}) {
  const ds = opts.dataset || null;
  const columns = Array.isArray(opts.columns)
    ? opts.columns.slice()
    : (ds && Array.isArray(ds.cols) ? ds.cols.map((c) => c.name) : []);
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const validation = Array.isArray(opts.validation) ? opts.validation : [];
  const generatedAt = (opts.generatedAt instanceof Date ? opts.generatedAt : new Date()).toISOString();
  const datasetName = (ds && (ds.name || ds.table)) || 'dataset';

  return {
    title: `DATAGLOW export — ${datasetName}`,
    datasetName,
    tableName: (ds && ds.table) || datasetName,
    generatedAt,
    columns,
    rows,
    // Prefer the dataset's authoritative row count; fall back to exported rows.
    rowCount: ds && Number.isFinite(ds.rowCount) ? ds.rowCount : rows.length,
    columnCount: columns.length,
    validation,
    grades: opts.grades || null,
    loadedAt: ds && ds.loadedAt ? new Date(ds.loadedAt).toISOString() : null,
  };
}

// A filesystem-safe stem for generated filenames.
function safeStem(name) {
  return String(name || 'dataset').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
}

// ------------------------------------------------------------
// Excel (.xlsx) — reuse the already-loaded SheetJS global.
// ------------------------------------------------------------

// Resolve the SheetJS library. Injectable so the builder is testable without a
// browser; defaults to the global `XLSX` the page already loads.
function resolveXLSX(injected) {
  const xlsx = injected || (typeof globalThis !== 'undefined' ? globalThis.XLSX : undefined);
  if (!xlsx || !xlsx.utils || typeof xlsx.write !== 'function') {
    throw new Error('Excel export requires the SheetJS (XLSX) library, which is not loaded.');
  }
  return xlsx;
}

/**
 * Build an .xlsx workbook from a dataset view and return raw bytes. Sheet 1 is
 * the data as displayed; a "Validation Summary" sheet is added only when the
 * view carries validation metadata (otherwise a plain data export — an
 * acceptable v1). Never touches the network.
 * @param {object} view A view from buildDatasetView.
 * @param {object} [opts]
 * @param {object} [opts.xlsx] Injected SheetJS (tests); defaults to global XLSX.
 * @returns {{data: Uint8Array, filename: string, mimeType: string}}
 */
export function buildWorkbookBlob(view, opts = {}) {
  const XLSX = resolveXLSX(opts.xlsx);
  const wb = XLSX.utils.book_new();

  // --- Data sheet: header row + rows, in the displayed column order. ---
  const header = view.columns.slice();
  const aoa = [header];
  for (const r of view.rows) {
    aoa.push(header.map((c) => {
      const v = r == null ? null : r[c];
      return v === undefined ? null : v;
    }));
  }
  const dataSheet = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, dataSheet, 'Data');

  // --- Summary sheet: dataset facts (+ validation, when available). ---
  const summaryRows = [
    ['DATAGLOW export'],
    ['Dataset', view.datasetName],
    ['Table', view.tableName],
    ['Generated', view.generatedAt],
    ['Rows (dataset)', view.rowCount],
    ['Columns', view.columnCount],
    ['Rows exported', view.rows.length],
  ];
  if (view.loadedAt) summaryRows.push(['Loaded at', view.loadedAt]);
  if (view.grades) {
    if (view.grades.overall != null) summaryRows.push(['Overall grade', String(view.grades.overall)]);
    if (view.grades.integrity != null) summaryRows.push(['Integrity grade', String(view.grades.integrity)]);
    if (view.grades.plausibility != null) summaryRows.push(['Domain-confidence grade', String(view.grades.plausibility)]);
  }
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  if (view.validation.length) {
    const vAoa = [['Layer', 'Status', 'Summary']];
    for (const v of view.validation) {
      vAoa.push([v.name || v.layer || '', (v.status || '').toString().toUpperCase(), v.summary || '']);
    }
    const vSheet = XLSX.utils.aoa_to_sheet(vAoa);
    XLSX.utils.book_append_sheet(wb, vSheet, 'Validation Summary');
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  // type:'array' yields an ArrayBuffer (or a typed array) — normalize to bytes.
  const data = out instanceof Uint8Array ? out : new Uint8Array(out);
  return {
    data,
    filename: `dataglow-${safeStem(view.datasetName)}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

// ------------------------------------------------------------
// PDF — tiny, dependency-free, first-party text-PDF writer.
// ------------------------------------------------------------
// Produces a minimal but valid multi-page PDF (PDF 1.4) containing left-aligned
// text lines set in the standard Helvetica font. This is deliberately NOT a
// general PDF/layout engine — it exists only to render DATAGLOW's report
// summary (title, timestamp, dataset facts, validation summary) without pulling
// in a heavy dependency. All text is coerced to WinAnsi-safe ASCII so byte
// offsets equal character counts (keeping the xref table correct).

const PDF_PAGE_WIDTH = 612;   // US Letter, points
const PDF_PAGE_HEIGHT = 792;
const PDF_MARGIN = 54;        // 0.75"
const PDF_LEADING = 16;       // line height, points
const PDF_TOP = PDF_PAGE_HEIGHT - PDF_MARGIN;
const PDF_BOTTOM = PDF_MARGIN;

function asciiSafe(s) {
  // Replace non-ASCII with '?' and drop control chars so the byte length of the
  // serialized document matches its character length (xref offsets stay valid).
  return String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '?');
}

function pdfEscape(s) {
  return asciiSafe(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Break lines into pages that fit between the top and bottom margins.
function paginate(lines) {
  const perPage = Math.max(1, Math.floor((PDF_TOP - PDF_BOTTOM) / PDF_LEADING));
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages.length ? pages : [['']];
}

// One page's content stream: draw each line at a fixed size, stepping down.
function pageContentStream(lines) {
  const parts = ['BT', `/F1 11 Tf`, `${PDF_LEADING} TL`, `1 0 0 1 ${PDF_MARGIN} ${PDF_TOP} Tm`];
  lines.forEach((line, idx) => {
    if (idx > 0) parts.push('T*');
    parts.push(`(${pdfEscape(line)}) Tj`);
  });
  parts.push('ET');
  return parts.join('\n');
}

/**
 * Build the text lines that make up the PDF report from a dataset view.
 * @param {object} view
 * @returns {string[]}
 */
export function buildReportLines(view) {
  const lines = [];
  lines.push(view.title);
  lines.push('');
  lines.push(`Generated: ${view.generatedAt}`);
  lines.push(`Dataset: ${view.datasetName}  (table: ${view.tableName})`);
  if (view.loadedAt) lines.push(`Loaded at: ${view.loadedAt}`);
  lines.push('');
  lines.push('Dataset view summary');
  lines.push(`  Rows: ${view.rowCount}`);
  lines.push(`  Columns: ${view.columnCount}`);
  if (view.rows.length !== view.rowCount) lines.push(`  Rows in export: ${view.rows.length}`);
  if (view.columns.length) {
    const shown = view.columns.slice(0, 30).join(', ');
    lines.push(`  Column names: ${shown}${view.columns.length > 30 ? ', …' : ''}`);
  }
  if (view.grades) {
    lines.push('');
    lines.push('Grades');
    if (view.grades.overall != null) lines.push(`  Overall: ${view.grades.overall}`);
    if (view.grades.integrity != null) lines.push(`  Integrity: ${view.grades.integrity}`);
    if (view.grades.plausibility != null) lines.push(`  Domain confidence: ${view.grades.plausibility}`);
  }
  if (view.validation.length) {
    lines.push('');
    lines.push(`Validation summary (${view.validation.length} layer${view.validation.length === 1 ? '' : 's'})`);
    for (const v of view.validation) {
      const status = (v.status || '').toString().toUpperCase();
      lines.push(`  [${status || '—'}] ${v.name || v.layer || ''}`);
    }
  } else {
    lines.push('');
    lines.push('Validation summary: not available (run the Validate tab to include one).');
  }
  lines.push('');
  lines.push('Generated locally by DATAGLOW — your data never left this device.');
  return lines;
}

/**
 * Build a minimal PDF report from a dataset view and return raw bytes.
 * @param {object} view A view from buildDatasetView.
 * @returns {{data: Uint8Array, filename: string, mimeType: string}}
 */
export function buildReportPdfBlob(view) {
  const pages = paginate(buildReportLines(view));

  // Object plan (1-indexed): 1 Catalog, 2 Pages, 3 Font, then per page a Page
  // object and a Contents stream object.
  const objects = [];
  const pageObjNums = [];
  let nextObj = 4; // 1..3 reserved below
  for (let i = 0; i < pages.length; i++) {
    const pageNum = nextObj++;
    const contentNum = nextObj++;
    pageObjNums.push({ pageNum, contentNum });
  }

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const kids = pageObjNums.map((p) => `${p.pageNum} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

  pages.forEach((lines, i) => {
    const { pageNum, contentNum } = pageObjNums[i];
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const stream = pageContentStream(lines);
    objects[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // Serialize with a byte-offset xref table.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objects.length; n++) {
    if (objects[n] == null) continue;
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  const size = objects.length; // highest object number + 1
  pdf += `xref\n0 ${size}\n`;
  pdf += `0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    if (offsets[n] == null) {
      // Free entry for any gap (there are none in practice, but stay valid).
      pdf += `0000000000 00000 f \n`;
    } else {
      pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    }
  }
  pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  const data = new TextEncoder().encode(pdf);
  return {
    data,
    filename: `dataglow-${safeStem(view.datasetName)}-report.pdf`,
    mimeType: 'application/pdf',
  };
}

// ------------------------------------------------------------
// Orchestrator — build for a format, then deliver via the adapter.
// ------------------------------------------------------------

export const FORMAT_XLSX = 'xlsx';
export const FORMAT_PDF = 'pdf';

/**
 * Build the raw blob descriptor for a format from a dataset view. No delivery.
 * @param {'xlsx'|'pdf'} format
 * @param {object} view
 * @param {object} [opts] Forwarded to the format builder (e.g. { xlsx }).
 * @returns {{data: Uint8Array, filename: string, mimeType: string}}
 */
export function buildBlobFor(format, view, opts = {}) {
  if (format === FORMAT_XLSX) return buildWorkbookBlob(view, opts);
  if (format === FORMAT_PDF) return buildReportPdfBlob(view);
  throw new Error(`Unknown export format: ${format}`);
}

/**
 * The single high-level entry the UI calls: build a dataset view, produce the
 * bytes for the requested format, and deliver them via the platform adapter.
 *
 * @param {object} opts
 * @param {'xlsx'|'pdf'} opts.format
 * @param {object} [opts.view]     Pre-built view; else built from the fields below.
 * @param {object} [opts.dataset]  Active dataset descriptor (if no view given).
 * @param {string[]} [opts.columns]
 * @param {Array<object>} [opts.rows]
 * @param {Array<object>} [opts.validation]
 * @param {object} [opts.grades]
 * @param {'browser'|'desktop'|'mobile'} [opts.platform] Delivery platform.
 * @param {object} [opts.win]      Injected window (tests).
 * @param {object} [opts.xlsx]     Injected SheetJS (tests).
 * @returns {Promise<{format:string, blob:object, delivery:object}>}
 */
export async function exportDataset(opts = {}) {
  const { format, platform, win, xlsx } = opts;
  const view = opts.view || buildDatasetView(opts);
  const blob = buildBlobFor(format, view, { xlsx });
  const delivery = await deliverBlob(blob, { platform, win });
  return { format, blob, delivery };
}
