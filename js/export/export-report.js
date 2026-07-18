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
 * @param {string[]} [opts.nutritionLabelLines] Optional pre-rendered Data Nutrition Label summary
 *        lines (js/provenance/data-nutrition-label.js). Present ONLY when the human opted in; when
 *        absent the export is byte-for-byte unchanged. This module stays decoupled from the label
 *        module — it just appends the already-rendered lines.
 * @param {Date}   [opts.generatedAt] Override the generation timestamp (tests).
 * @returns {{title:string, datasetName:string, tableName:string, generatedAt:string,
 *   columns:string[], rows:Array<object>, rowCount:number, columnCount:number,
 *   validation:Array<object>, grades:(object|null), loadedAt:(string|null),
 *   nutritionLabelLines:(string[]|null)}}
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
    nutritionLabelLines: Array.isArray(opts.nutritionLabelLines) ? opts.nutritionLabelLines.slice() : null,
  };
}

// A filesystem-safe stem for generated filenames.
// Phase 6 fix: strip trailing format extensions from the input name so that a
// dataset loaded from "claims.csv" produces "dataglow-claims.xlsx" rather than
// "dataglow-claims.csv.xlsx" (double-extension bug).
function safeStem(name) {
  const stripped = String(name || 'dataset')
    // Remove common data-file extensions from the tail only.
    .replace(/\.(csv|tsv|json|ndjson|parquet|xlsx|xls|arrow|feather|pdf|txt)$/i, '');
  return stripped.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
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

// ------------------------------------------------------------
// Phase 7 — Excel round-trip fidelity helpers
// (buildWorkbookBlob follows after the helper declarations)
// ------------------------------------------------------------

// Coerce ISO date strings to JS Date objects so SheetJS emits native date
// serial cells (Phase 6). Kept here so all Excel helpers live together.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;
export function coerceForExcel(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v;
  if (typeof v === 'string' && ISO_DATE_RE.test(v)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return v;
}

// Truncate a sheet name to 31 chars (Excel hard limit) and strip forbidden
// characters: \ / ? * [ ] : — silently, never throw.
export function safeSheetName(raw, fallback = 'Data') {
  const cleaned = String(raw || fallback)
    .replace(/[\\/\?\*\[\]:\x00-\x1F]/g, ' ')
    .trim()
    .slice(0, 31)
    .trim();
  return cleaned || fallback;
}

// Compute column widths: for each column take the max character length across
// the header and (up to) the first 500 rows, then clamp to [8, 60] chars.
// Returns an array of { wch: number } objects in column order.
export function computeColWidths(header, rows) {
  return header.map((col) => {
    let max = String(col).length;
    const sample = rows.length > 500 ? rows.slice(0, 500) : rows;
    for (const r of sample) {
      const v = r == null ? null : r[col];
      if (v != null) max = Math.max(max, String(v).length);
    }
    return { wch: Math.min(60, Math.max(8, max + 2)) };
  });
}

// Apply bold + background fill styling to the header row of a SheetJS sheet.
// SheetJS CE (community edition) supports cell styles only in the Pro build;
// we write the style objects anyway — Pro users get formatting, CE users get
// clean data with no error. Never throws if a cell is missing.
function styleHeaderRow(sheet, colCount) {
  for (let c = 0; c < colCount; c++) {
    const addr = String.fromCharCode(65 + (c < 26 ? c : 25)) + '1';
    // For columns beyond Z, use AA, AB… — SheetJS encode_cell handles this cleanly.
    const cellAddr = sheet['!ref']
      ? (typeof XLSX !== 'undefined' && XLSX.utils
          ? (XLSX.utils.encode_cell ? XLSX.utils.encode_cell({ r: 0, c }) : addr)
          : addr)
      : addr;
    const cell = sheet[cellAddr];
    if (!cell) continue;
    cell.s = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '1A3A4A' }, patternType: 'solid' },
      alignment: { horizontal: 'left', vertical: 'center', wrapText: false },
      border: {
        bottom: { style: 'thin', color: { rgb: 'AAAAAA' } },
      },
    };
  }
}

// Build a human-readable sheet name from a dataset name.
// "my_claims_data.csv" -> "my_claims_data" (31 char max).
function dataSheetName(datasetName) {
  const stripped = String(datasetName || 'Data')
    .replace(/\.(csv|tsv|json|ndjson|parquet|xlsx|xls|arrow|feather|pdf|txt)$/i, '');
  return safeSheetName(stripped || 'Data', 'Data');
}

export function buildWorkbookBlob(view, opts = {}) {
  const XLSX = resolveXLSX(opts.xlsx);
  const wb = XLSX.utils.book_new();

  // --- Data sheet ---
  // Phase 6: date coercion to native Excel date serials.
  // Phase 7: named sheet, frozen header row, auto column widths, bold headers.
  const header = view.columns.slice();
  const aoa = [header];
  for (const r of view.rows) {
    aoa.push(header.map((c) => {
      const v = r == null ? null : r[c];
      return coerceForExcel(v === undefined ? null : v);
    }));
  }
  const dataSheet = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

  // Phase 7: auto-size column widths so nothing gets cut off.
  dataSheet['!cols'] = computeColWidths(header, view.rows);

  // Phase 7: freeze the top header row so it stays visible when scrolling.
  dataSheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };

  // Phase 7: bold + coloured header row (Pro only; CE ignores cell.s cleanly).
  styleHeaderRow(dataSheet, header.length);

  // Phase 7: named sheet derived from the dataset name instead of generic 'Data'.
  const dataTab = dataSheetName(view.datasetName);
  XLSX.utils.book_append_sheet(wb, dataSheet, dataTab);

  // --- Summary sheet ---
  // Phase 7: richer summary — grade colour indicators and a Validation Overview
  // section that gives a quick pass/warn/fail count at a glance.
  const summaryRows = [
    ['DATAGLOW Export Report'],
    [],
    ['Dataset', view.datasetName],
    ['Table', view.tableName],
    ['Generated', view.generatedAt],
    ['Rows (full dataset)', view.rowCount],
    ['Columns', view.columnCount],
    ['Rows in this export', view.rows.length],
  ];
  if (view.loadedAt) summaryRows.push(['Loaded at', view.loadedAt]);

  if (view.grades) {
    summaryRows.push([]);
    summaryRows.push(['Validation Grades']);
    if (view.grades.overall != null) summaryRows.push(['  Overall', String(view.grades.overall)]);
    if (view.grades.integrity != null) summaryRows.push(['  Integrity', String(view.grades.integrity)]);
    if (view.grades.plausibility != null) summaryRows.push(['  Domain confidence', String(view.grades.plausibility)]);
  }

  // Phase 7: add a pass/warn/fail counts block when validation data is available.
  if (view.validation.length) {
    const passed = view.validation.filter(v => (v.status || '').toString().toUpperCase() === 'PASS').length;
    const warned = view.validation.filter(v => (v.status || '').toString().toUpperCase() === 'WARN').length;
    const failed = view.validation.filter(v => (v.status || '').toString().toUpperCase() === 'FAIL').length;
    const skipped = view.validation.length - passed - warned - failed;
    summaryRows.push([]);
    summaryRows.push(['Validation Overview', `${view.validation.length} layers`]);
    summaryRows.push(['  PASS', passed]);
    summaryRows.push(['  WARN', warned]);
    summaryRows.push(['  FAIL', failed]);
    if (skipped > 0) summaryRows.push(['  SKIP / other', skipped]);
  }

  summaryRows.push([]);
  summaryRows.push(['Generated locally by DATAGLOW — your data never left this device.']);

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  // Phase 7: widen the label column on the summary sheet.
  summarySheet['!cols'] = [{ wch: 28 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  // --- Validation Detail sheet (when validation data exists) ---
  if (view.validation.length) {
    const vAoa = [['Layer', 'Status', 'Summary']];
    for (const v of view.validation) {
      vAoa.push([
        v.name || v.layer || '',
        (v.status || '').toString().toUpperCase(),
        v.summary || '',
      ]);
    }
    const vSheet = XLSX.utils.aoa_to_sheet(vAoa);
    // Phase 7: size the columns for readability.
    vSheet['!cols'] = [{ wch: 32 }, { wch: 8 }, { wch: 60 }];
    vSheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
    styleHeaderRow(vSheet, 3);
    XLSX.utils.book_append_sheet(wb, vSheet, 'Validation Detail');
  }

  // --- Data Nutrition Label sheet (opt-in only) ---
  if (view.nutritionLabelLines && view.nutritionLabelLines.length) {
    const labelSheet = XLSX.utils.aoa_to_sheet(view.nutritionLabelLines.map((l) => [l]));
    labelSheet['!cols'] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(wb, labelSheet, 'Data Nutrition Label');
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
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

// Phase 6 fix: replace common typographic Unicode characters with their
// WinAnsi/ASCII equivalents BEFORE falling back to '?' so that em dashes,
// curly quotes, ellipses, bullet points, and similar characters that
// DataGlow's own validation layer generates (e.g. '—' in layer summaries)
// render as recognizable text rather than mystery question marks in the PDF.
const UNICODE_TO_ASCII = [
  [/\u2014/g, '--'],   // em dash -> double hyphen
  [/\u2013/g, '-'],    // en dash -> hyphen
  [/\u2026/g, '...'],  // ellipsis -> three dots
  [/[\u2018\u2019]/g, "'"],  // curly single quotes -> straight
  [/[\u201C\u201D]/g, '"'],  // curly double quotes -> straight
  [/\u2022/g, '*'],    // bullet
  [/\u00B7/g, '*'],    // middle dot
  [/\u00A9/g, '(c)'],  // copyright
  [/\u00AE/g, '(R)'],  // registered
  [/\u2122/g, '(TM)'], // trademark
  [/\u00B0/g, 'deg'],  // degree sign
  [/\u00B1/g, '+/-'],  // plus-minus
  [/\u00D7/g, 'x'],    // multiplication sign
  [/\u00F7/g, '/'],    // division sign
  [/\u2248/g, '~='],   // approximately equal
  [/\u2260/g, '!='],   // not equal
  [/\u2264/g, '<='],   // less-than-or-equal
  [/\u2265/g, '>='],   // greater-than-or-equal
  [/\u00A0/g, ' '],    // non-breaking space
  [/[\u2000-\u200F]/g, ' '], // various spaces and zero-width chars
];

function asciiSafe(s) {
  // Transliterate known typographic Unicode to ASCII equivalents, then
  // replace any remaining non-ASCII with '?'. The byte length of the
  // serialized PDF still equals its character length because every substitution
  // uses only ASCII bytes, keeping the xref offset table valid.
  let result = String(s == null ? '' : s);
  for (const [re, sub] of UNICODE_TO_ASCII) result = result.replace(re, sub);
  return result.replace(/[^\x20-\x7E]/g, '?');
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
  if (view.nutritionLabelLines && view.nutritionLabelLines.length) {
    lines.push('');
    lines.push('----------------------------------------');
    for (const l of view.nutritionLabelLines) lines.push(l);
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
