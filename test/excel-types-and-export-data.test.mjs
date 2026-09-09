// ============================================================
// DATAGLOW - Excel column types + the export data path
// ============================================================
// Two bugs, both proved here against code lifted verbatim out of
// canvas/index.html, so what is tested is what ships.
//
// FIX 3 - every Excel column typed STR.
//   loadExcelSheet() re-runs DataGlow's own detectType() over each imported
//   column. It read the cells with
//       DGRowShape.getCell(row, result.columns, idx)
//   but getCell's third argument is a column NAME, never an index. Asking for
//   a column called "0" returns undefined, so detectType only ever saw empty
//   strings and returned STR for every column. A sheet of integers imported as
//   a sheet of text, and SQL could not add up a column without a TRY_CAST.
//
//   The second half of the same bug: a real sheet carries rows that are not
//   observations. The CMS IDR table has a period banner ("2025 Q2") under the
//   header and a Source and a Notes line under the last state. One text cell
//   is enough to type a whole integer column as STR, so type detection now
//   reads from the structurally well formed rows only. Those rows are still
//   kept, shown and exported; only the TYPE SAMPLE excludes them.
//
// FIX 2 - exports wrote empty files and reported success.
//   _getDataRows() read window.DataGlowDataset. Nothing in the bundle ever
//   assigns that global, so headers and rows were always empty: the CSV was
//   0 bytes, the XLSX Data sheet was one empty cell, and both paths still
//   fired a green success toast. It now reads the live dataset the grid and
//   the SQL engine use (window.getActiveDataset()), and neither exporter
//   reports success unless a non-empty write actually happened.
//
// FIX 3, SECOND HALF - the types never reached the SQL engine.
//   Detecting a type and painting it on the grid is not the same as the query
//   engine knowing it. registerDataset() serialised the dataset to CSV and let
//   read_csv_auto guess, and one period banner cell is enough to make a column
//   of integers VARCHAR, so `SELECT SUM("Total")` still failed with
//   sum(VARCHAR) while the grid badge said INT. The CREATE TABLE now reads the
//   CSV as text and casts each column to the type DataGlow already decided on.
//   Proved below against a real DuckDB, both directions.
//
// RUN WITH: node test/excel-types-and-export-data.test.mjs

import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import * as DGExcel from '../js/shared/excel-import.js';
import * as DGRowShapeMod from '../js/shared/row-shape.js';
import { runQuery, closeConnection } from './node-duckdb-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const canvas = readFileSync(join(repoRoot, 'canvas', 'index.html'), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log('\u2713 ' + label); }
  else { failed++; console.log('\u2717 FAILED: ' + label); }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
     JSON.stringify(actual) === JSON.stringify(expected));
}

// ------------------------------------------------------------
// Lift a function verbatim out of the canvas by brace matching.
// ------------------------------------------------------------
function extractFunctionSource(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) return null;
  let depth = 0;
  for (let i = startIdx + startMarker.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return null;
}

function need(marker, name) {
  const src = extractFunctionSource(canvas, marker);
  ok(`canvas: ${name} is present verbatim with a matching closing brace`, src !== null);
  return src || '';
}

// Same idea for a single line declaration, which has no braces to match.
function needLine(marker, name) {
  const startIdx = canvas.indexOf(marker);
  ok(`canvas: ${name} is present verbatim`, startIdx !== -1);
  if (startIdx === -1) return '';
  return canvas.slice(startIdx, canvas.indexOf('\n', startIdx));
}

const rowShapeInline = (() => {
  const from = canvas.indexOf('/* ---- from js/shared/row-shape.js ---- */');
  const end = canvas.indexOf('/* ---- end row-shape.js ---- */');
  return from !== -1 && end !== -1 ? canvas.slice(from, end) : null;
})();
ok('canvas: the shared DGRowShape module is inlined with from/end markers', rowShapeInline !== null);

// The vendored SheetJS, loaded the way a browser loads it: a bare script in a
// context with a window and nothing else.
function loadVendoredXLSX() {
  const file = join(repoRoot, 'assets', 'xlsx', 'xlsx-0.20.3.full.min.js');
  if (!existsSync(file)) return null;
  const sandbox = {
    window: {}, console, TextDecoder, TextEncoder, Date, Math, JSON,
    Uint8Array, Uint16Array, Int32Array, Float64Array, ArrayBuffer, DataView,
    Array, Object, String, Number, Boolean, RegExp, Error, TypeError,
    isFinite, isNaN, parseInt, parseFloat, decodeURIComponent, encodeURIComponent,
    setTimeout, clearTimeout,
  };
  sandbox.global = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: 'xlsx.full.min.js' });
  return sandbox.XLSX || sandbox.window.XLSX;
}
const XLSX = loadVendoredXLSX();
ok('the vendored SheetJS build loads and exposes the writer', !!(XLSX && XLSX.utils && typeof XLSX.write === 'function'));

// ============================================================
console.log('\n1. Fix 3: Excel column type detection, run through loadExcelSheet');
// ============================================================
const detectTypeSrc = need('  function detectType(values) {', 'detectType');
const typeSampleSrc = need('  function typeSampleRows(rows, columns) {', 'typeSampleRows');
const loadSheetSrc = need(
  '  function loadExcelSheet(workbook, sheetName, fileName, fmt, fileHash, seenBefore, advance, summaries) {',
  'loadExcelSheet'
);
const sheetToAoaSrc = need('  function excelSheetToAoa(workbook, sheetName) {', 'excelSheetToAoa');
const dateColumnsSrc = need('  function excelDateColumns(workbook, sheetName, headerRowIndex) {', 'excelDateColumns');

// The banner and footnote rows are the reason the sheet typed as text, so the
// fixture keeps them: header, a "2025 Q2" period banner with no state, six
// state rows, a Source line and a Notes line. Shaped exactly like the CMS
// sheet "Initiations by State".
const IDR_AOA = [
  ['Table 7: Federal IDR Dispute Initiations by State or Territory', null, null, null],
  ['State or Territory', 'Initiations - Non-Group Health Plan', 'Initiations - Group Health Plan', 'Total'],
  [null, null, null, null],
  [null, '2025 Q2', '2025 Q2', '2025 Q2'],
  ['Texas+', 246807, 2270, 249077],
  ['Arizona', 41059, 603, 41662],
  ['Florida+', 38441, 459, 38900],
  ['North Dakota', 5, 22, 27],
  ['Guam', 1, 0, 1],
  ['Northern Mariana Islands', 1, 0, 1],
  ['Source: Notices of IDR Initiation submitted to the Federal IDR portal.', null, null, null],
  ['Notes: + State has specified state law that applies to certain OON disputes.', null, null, null],
];

/*
 * Build loadExcelSheet with the real DGExcel and the real inlined DGRowShape,
 * and stub only the UI it calls. `getCellExpr` lets the same harness run the
 * OLD buggy lookup, so the test proves the fix in both directions instead of
 * asserting that the current code equals itself.
 */
function runImport(aoa, { getCellExpr = null, useSample = true } = {}) {
  let sheetSrc = loadSheetSrc;
  if (getCellExpr) {
    sheetSrc = sheetSrc
      .replace('var columns = result.columns.map(function (col) {',
               'var columns = result.columns.map(function (col, idx) {')
      .replace('DGRowShape.getCell(row, result.columns, col.name)', getCellExpr);
  }
  if (!useSample) {
    sheetSrc = sheetSrc.replace('typeSampleRows(result.rows, result.columns)', 'result.rows');
  }
  const factory = new Function(
    'window', 'DGExcel', 'setAgentStatus', 'showExcelNotes', 'runSequencedReveal',
    `${rowShapeInline}
     ${detectTypeSrc}
     ${typeSampleSrc}
     ${sheetToAoaSrc}
     ${dateColumnsSrc}
     ${sheetSrc}
     return loadExcelSheet;`
  );
  const captured = {};
  const workbook = { Sheets: { Sheet1: {} } };
  const loadExcelSheet = factory(
    { XLSX: { utils: { sheet_to_json: () => aoa, decode_range: XLSX.utils.decode_range, encode_cell: XLSX.utils.encode_cell } } },
    DGExcel,
    (s) => { captured.status = s; },
    () => {},
    (ds) => { captured.dataset = ds; }
  );
  loadExcelSheet(workbook, 'Sheet1', 'idr.xlsx', 'xlsx', 'hash1', null, () => {}, [{ name: 'Sheet1' }]);
  return captured;
}

const fixed = runImport(IDR_AOA);
const fixedTypes = fixed.dataset ? fixed.dataset.columns.map((c) => c.type) : [];
const fixedNames = fixed.dataset ? fixed.dataset.columns.map((c) => c.name) : [];

eq('the four CMS-shaped columns are found by name',
   fixedNames,
   ['State or Territory', 'Initiations - Non-Group Health Plan', 'Initiations - Group Health Plan', 'Total']);
eq('State or Territory stays text', fixedTypes[0], 'STR');
eq('Initiations - Non-Group Health Plan types numeric', fixedTypes[1], 'INT');
eq('Initiations - Group Health Plan types numeric', fixedTypes[2], 'INT');
eq('Total types numeric', fixedTypes[3], 'INT');
ok('not every column is STR any more', fixedTypes.filter((t) => t === 'STR').length === 1);

// UPDATED. This block used to assert that the "2025 Q2" banner and the two
// footnote lines stayed in the dataset as rows, on the principle that type
// detection must not drop data. That principle still holds and is still tested
// below: no state row may go missing and no cell may be rewritten.
//
// What changed is who counts. The banner and the footnotes are not
// observations, and counting them made the app report 59 rows for a 56 row CMS
// sheet and type every column as text. The importer now sets exactly those
// rows aside, names them by their sheet row number, and says so in a note. The
// file on disk is never touched. See test/honesty-toasts-footnotes.test.mjs for
// the detector's own limits, including the cases where it deliberately leaves a
// note-looking row alone.
eq('the six real state rows are the dataset', fixed.dataset.rows.length, 6);
eq('the first state row is verbatim and is now row one', fixed.dataset.rows[0], ['Texas+', 246807, 2270, 249077]);
eq('the last state row is still there', fixed.dataset.rows[5], ['Northern Mariana Islands', 1, 0, 1]);
eq('the banner row was set aside as a label, not counted as a record',
   fixed.dataset.nonDataRows.labels.map((r) => r.sheetRow), [4]);
eq('both footnote lines were set aside as footnotes',
   fixed.dataset.nonDataRows.footnotes.map((r) => r.sheetRow), [11, 12]);
ok('the import notes tell the reader what was set aside and why',
   (fixed.dataset.importNotes || []).some((n) => /rows look like notes or labels/.test(n)));
eq('numeric cells stayed numbers, not strings', typeof fixed.dataset.rows[0][3], 'number');

// Direction 2: restore the old index lookup and watch every column go STR.
const buggy = runImport(IDR_AOA, { getCellExpr: 'DGRowShape.getCell(row, result.columns, idx)' });
ok('with the old index lookup restored, the same sheet types every column STR',
   buggy.dataset && buggy.dataset.columns.every((c) => c.type === 'STR'));

// Direction 3: one text cell above a numeric column is enough to type that
// column as text. There are now two independent defences against it and they
// are tested separately.
//
// The real CMS banner has an empty first cell, so the importer sets it aside
// before anything types anything, and the measures come out numeric even with
// the sample filter switched off. Before this fix the sample filter was the
// only thing standing between that banner and four STR columns.
const noSample = runImport(IDR_AOA, { useSample: false });
ok('with the banner row set aside, the measures type INT even with the sample filter off',
   noSample.dataset && noSample.dataset.columns.slice(1).every((c) => c.type === 'INT'));

// And the limit, written down rather than hidden. A period label with something
// in its first cell cannot be told apart from a real record, so the detector
// leaves it alone, and one text cell is still one text cell. The result is an
// honest STR column that SQL can TRY_CAST, not a silently wrong number.
const STUBBORN_BANNER_AOA = IDR_AOA.map((r) => r.slice());
STUBBORN_BANNER_AOA[3] = ['All plan types', '2025 Q2', '2025 Q2', '2025 Q2'];
const stubborn = runImport(STUBBORN_BANNER_AOA);
eq('a banner the detector cannot safely identify is kept as a row',
   stubborn.dataset.rows.length, 7);
eq('only the two footnote lines were set aside on that sheet, not the banner',
   stubborn.dataset.nonDataRows.count, 2);
ok('the measures type STR in that case, which is the honest answer for a text cell',
   stubborn.dataset.columns.slice(1).every((c) => c.type === 'STR'));

// The sample filter must not fire on a sparse but legitimate dataset.
const sparse = [
  ['id', 'a', 'b'],
  [null, 1, 2],
  [null, 3, 4],
  [null, 5, 6],
  [null, 7, 8],
  [null, 9, 10],
  [null, 11, 12],
];
const sparseDs = runImport(sparse);
ok('a dataset whose first column is legitimately blank still types off all of its rows',
   sparseDs.dataset && sparseDs.dataset.columns[1].type === 'INT' && sparseDs.dataset.rows.length === 6);

// ============================================================
console.log('\n2. Fix 2: the export path reads the live dataset');
// ============================================================
const exportSrcs = [
  need('  function _liveDataset() {', '_liveDataset'),
  need('  function _getDataRows() {', '_getDataRows'),
  need('  function _exportFailed(format, reason, message) {', '_exportFailed'),
  need('  function _hasRows(data) {', '_hasRows'),
  need('  function _describeBytes(n) {', '_describeBytes'),
  need('  function _sheetShape(SheetJS, sheet) {', '_sheetShape'),
  need('  function _getProofChainRows() {', '_getProofChainRows'),
  need('  function _getFQSRows() {', '_getFQSRows'),
  need('  function exportXLSX() {', 'exportXLSX'),
  need('  function exportCSV() {', 'exportCSV'),
].join('\n');

ok('canvas: _getDataRows no longer reads the global nothing assigns',
   !/function _getDataRows\(\) \{\s*var ds = window\.DataGlowDataset;/.test(canvas));
ok('canvas: _getDataRows reads the live dataset store',
   /function _getDataRows\(\) \{\s*var ds = _liveDataset\(\);/.test(canvas) &&
   exportSrcs.includes('window.getActiveDataset()'));
ok('canvas: nothing in the export path creates a second dataset object',
   !/window\.DataGlowDataset\s*=/.test(canvas));

// A harness that runs the two exporters with a fake browser around them.
function makeExportHarness(dataset) {
  const events = [];
  const toasts = [];
  const downloads = [];
  const written = [];

  const fakeWindow = {
    FEATURE_FLAGS: { exportXlsx: true },
    getActiveDataset: () => dataset,
    showToast: (msg, type) => toasts.push({ msg, type }),
  };
  class FakeBlob {
    constructor(parts, opts) {
      this.text = (parts || []).join('');
      this.size = Buffer.byteLength(this.text, 'utf8');
      this.type = opts && opts.type;
    }
  }
  const fakeDocument = {
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({
      set href(v) { this._href = v; },
      get href() { return this._href; },
      click() { downloads.push({ name: this.download, href: this._href }); },
    }),
    dispatchEvent: (e) => events.push({ type: e.type, detail: e.detail }),
  };
  class FakeCustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
  }
  const fakeURL = {
    createObjectURL: (b) => { fakeURL._last = b; return 'blob:fake'; },
    revokeObjectURL: () => {},
  };

  // Real SheetJS, real aoa_to_sheet, real decode_range. Only writeFile is
  // swapped, because in a browser it triggers a download.
  const SheetJS = Object.create(XLSX);
  SheetJS.writeFile = (wb, name) => { written.push({ wb, name }); };
  fakeWindow.XLSX = SheetJS;

  const factory = new Function(
    'window', 'document', 'URL', 'Blob', 'CustomEvent',
    `${rowShapeInline}
     ${exportSrcs}
     return { exportCSV: exportCSV, exportXLSX: exportXLSX, getDataRows: _getDataRows };`
  );
  const api = factory(fakeWindow, fakeDocument, fakeURL, FakeBlob, FakeCustomEvent);
  return { api, events, toasts, downloads, written, blobOf: () => fakeURL._last };
}

// The dataset the Excel path actually produces: positional array rows,
// { name, type } columns, six state rows, with the banner and footnote lines
// set aside at import and reported on dataset.nonDataRows.
const liveDataset = {
  id: 'ds-1',
  name: 'federal-idr-supplemental-tables-2025-q2.xlsx',
  sheetName: 'Initiations by State',
  columns: fixed.dataset.columns,
  rows: fixed.dataset.rows,
};

const live = makeExportHarness(liveDataset);
const data = live.api.getDataRows();
eq('the export sees the live column names', data.headers, fixedNames);
eq('the export sees every live row', data.rows.length, 6);
eq('the export sees the real first state values', data.rows[0], ['Texas+', 246807, 2270, 249077]);

live.api.exportCSV();
const csvBlob = live.blobOf();
const csvLines = csvBlob.text.split('\n');
ok('CSV export is not zero bytes', csvBlob.size > 0);
eq('CSV has one header line plus one line per live row', csvLines.length, 7);
eq('CSV header is the real column names',
   csvLines[0],
   'State or Territory,Initiations - Non-Group Health Plan,Initiations - Group Health Plan,Total');
eq('the first CSV data line is the Texas+ row from the sheet', csvLines[1], 'Texas+,246807,2270,249077');
eq('a CSV download was actually clicked', live.downloads.length, 1);
ok('the CSV filename ends in .csv', /\.csv$/.test(live.downloads[0].name));
eq('exactly one toast fired', live.toasts.length, 1);
eq('the CSV toast is a success', live.toasts[0].type, 'success');
ok('the CSV toast states the row count it wrote', live.toasts[0].msg.includes('6 rows'));
eq('the export event reports the real row count',
   live.events.filter((e) => e.type === 'dataglow:export-triggered').map((e) => e.detail.rows), [6]);

live.api.exportXLSX();
const wb = live.written.length ? live.written[0].wb : null;
ok('an .xlsx was written', !!wb);
eq('the workbook still carries all three sheets', wb && wb.SheetNames, ['Data', 'Proof Chain', 'FQS Scorecard']);
const dataSheet = wb && wb.Sheets.Data;
const dataRange = dataSheet && dataSheet['!ref'] ? XLSX.utils.decode_range(dataSheet['!ref']) : null;
ok('the Data sheet is not the 1x1 empty cell the old path produced', dataSheet && dataSheet['!ref'] !== 'A1');
eq('the Data sheet covers a header row plus every data row',
   dataRange ? (dataRange.e.r - dataRange.s.r) + 1 : 0, 7);
eq('the Data sheet covers all four columns',
   dataRange ? (dataRange.e.c - dataRange.s.c) + 1 : 0, 4);
const sheetRows = dataSheet ? XLSX.utils.sheet_to_json(dataSheet, { header: 1 }) : [];
eq('the Data sheet header is the real column names', sheetRows[0], fixedNames);
eq('the Data sheet Texas+ row kept its numbers', sheetRows[1], ['Texas+', 246807, 2270, 249077]);
ok('the XLSX toast is a success that names the row count',
   live.toasts.length === 2 && live.toasts[1].type === 'success' && live.toasts[1].msg.includes('6 rows'));

// ============================================================
console.log('\n3. Fix 3 in SQL: the detected types reach DuckDB, so a bare SUM works');
// ============================================================
// registerDataset is lifted out of the canvas whole and run against the real
// native DuckDB, with only db.registerFileBuffer and conn.query swapped for
// thin adapters. The SQL that executes below is the SQL the browser sends.
const typeMapSrc = need('    var DUCKDB_TYPE_BY_DG_TYPE = {', 'DUCKDB_TYPE_BY_DG_TYPE');
const isoDateishSrc = needLine('    var ISO_DATEISH =', 'ISO_DATEISH');
const castTargetSrc = need('    function columnCastTarget(dataset, col, name) {', 'columnCastTarget');
const selectListSrc = need('    function typedSelectList(dataset) {', 'typedSelectList');
const registerSrc = need('    async function registerDataset(dataset) {', 'registerDataset');

ok('canvas: registration applies the dataset types instead of letting the CSV reader guess',
   registerSrc.includes('typedSelectList(dataset)') && registerSrc.includes('all_varchar=true'));
ok('canvas: the cast is TRY_CAST, so one bad cell cannot fail the whole load',
   selectListSrc.includes('TRY_CAST(') && !selectListSrc.includes(' CAST('));

function safeTableName(filename) {
  return (filename || 'dataset').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
}

// One temp directory per run. read_csv_auto resolves the registered file name
// relative to the process directory, so the harness runs in there.
const sqlWorkDir = mkdtempSync(join(tmpdir(), 'dg-types-'));

function makeSqlHarness() {
  const statements = [];
  const db = {
    registerFileBuffer: async (fname, bytes) => {
      writeFileSync(join(sqlWorkDir, fname), Buffer.from(bytes));
    },
  };
  const conn = {
    query: async (sql) => {
      statements.push(sql);
      const r = await runQuery(sql);
      return { toArray: () => r.rows.map((o) => ({ toJSON: () => o })) };
    },
  };
  const factory = new Function(
    'window', 'DGRowShape', 'TextEncoder', 'safeTableName', 'ensureInit', 'db', 'conn', 'registeredTables',
    `${typeMapSrc}
     ${isoDateishSrc}
     ${castTargetSrc}
     ${selectListSrc}
     ${registerSrc}
     return { registerDataset: registerDataset, typedSelectList: typedSelectList };`
  );
  const api = factory({}, DGRowShapeMod, TextEncoder, safeTableName, async () => {}, db, conn, {});
  return { api, statements };
}

async function registerInDuckDB(dataset) {
  const h = makeSqlHarness();
  const cwd = process.cwd();
  process.chdir(sqlWorkDir);
  let tbl;
  try { tbl = await h.api.registerDataset(dataset); }
  finally { process.chdir(cwd); }
  const schema = (await runQuery(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='${tbl}' ORDER BY ordinal_position`
  )).rows;
  return { tbl, schema, statements: h.statements, typedSelectList: h.api.typedSelectList };
}

// The same CMS-shaped dataset the import section produced: six state rows,
// columns typed STR then INT INT INT, with the banner and footnote lines set
// aside at import.
const idrDataset = {
  name: 'federal-idr-supplemental-tables-2025-q2.xlsx',
  columns: fixed.dataset.columns,
  rows: fixed.dataset.rows,
};

const idrSql = await registerInDuckDB(idrDataset);
eq('the text column is left as text in DuckDB', idrSql.schema[0].data_type, 'VARCHAR');
eq('the first measure column is an integer in DuckDB', idrSql.schema[1].data_type, 'BIGINT');
eq('the second measure column is an integer in DuckDB', idrSql.schema[2].data_type, 'BIGINT');
eq('Total is an integer in DuckDB, not VARCHAR', idrSql.schema[3].data_type, 'BIGINT');
eq('the DuckDB column names still match the grid',
   idrSql.schema.map((c) => c.column_name), fixedNames);

eq('every row the grid shows is in the table',
   (await runQuery(`SELECT COUNT(*) AS n FROM "${idrSql.tbl}"`)).rows[0].n, 6);

let bareSumErr = null;
let bareSum = null;
try {
  bareSum = (await runQuery(
    `SELECT SUM("Total") AS s, COUNT("Total") AS n FROM "${idrSql.tbl}"`)).rows[0];
} catch (e) { bareSumErr = e.message; }
ok('a bare SUM with no TRY_CAST runs at all' +
   (bareSumErr ? ` (${String(bareSumErr).split('\n')[0]})` : ''), bareSumErr === null);
eq('the bare SUM is the total of the six real state rows', bareSum && bareSum.s, 329668);
eq('every one of the six rows counted, because they are all observations now',
   bareSum && bareSum.n, 6);
eq('the two measure columns still add up to the Total column',
   (await runQuery(`SELECT SUM("${fixedNames[1]}") + SUM("${fixedNames[2]}") AS s FROM "${idrSql.tbl}"`)).rows[0].s,
   329668);
eq('no NULL Total is left in the table, because the rows that had none are out of it',
   (await runQuery(`SELECT COUNT(*) AS n FROM "${idrSql.tbl}" WHERE "Total" IS NULL`)).rows[0].n, 0);

// Direction 2: the pre-fix statement, run on a CSV that still contains a text
// banner row, fails the same way the live bug report showed. The IDR export no
// longer contains that row, so this direction uses the stubborn banner sheet
// from section 1, which is a real case the detector deliberately leaves alone.
// That keeps this a test of read_csv_auto guessing, which is what it was always
// about, rather than a test of the row that is now gone.
const preFixDataset = { name: 'stubborn.xlsx', columns: stubborn.dataset.columns, rows: stubborn.dataset.rows };
const preFixCsv = join(sqlWorkDir, 'prefix.csv');
writeFileSync(preFixCsv, DGRowShapeMod.datasetToCsv(preFixDataset));
await runQuery(`CREATE OR REPLACE TABLE prefix_t AS SELECT * FROM read_csv_auto('${preFixCsv}', header=true, ignore_errors=true)`);
eq('before the fix DuckDB typed the integer column VARCHAR',
   (await runQuery("SELECT data_type FROM information_schema.columns WHERE table_name='prefix_t' AND column_name='Total'")).rows[0].data_type,
   'VARCHAR');
let preFixSumErr = null;
try { await runQuery('SELECT SUM("Total") FROM prefix_t'); }
catch (e) { preFixSumErr = e.message; }
ok('before the fix the same bare SUM failed with sum(VARCHAR)',
   preFixSumErr !== null && preFixSumErr.includes('sum(VARCHAR)'));

// A dataset with nothing to cast keeps the old untyped read verbatim, so this
// change cannot alter what read_csv_auto does for a text only file.
const textOnly = {
  name: 'notes.csv',
  columns: [{ name: 'label', type: 'STR' }, { name: 'note', type: 'STR' }],
  rows: [['a', 'one'], ['b', 'two']],
};
const textOnlySql = await registerInDuckDB(textOnly);
eq('a text only dataset produces no cast list', textOnlySql.typedSelectList(textOnly), null);
ok('a text only dataset is still read with SELECT * and no all_varchar',
   textOnlySql.statements[0].includes('SELECT * FROM read_csv_auto') &&
   !textOnlySql.statements[0].includes('all_varchar'));

// Both numeric names the bundle uses have to land on a DuckDB type that SUM
// and AVG accept, and BOOL has to survive as a boolean.
const mixedNumbers = {
  name: 'measures.csv',
  columns: [{ name: 'id', type: 'INT' }, { name: 'rate', type: 'FLOAT' }, { name: 'flag', type: 'BOOL' }],
  rows: [[1, '0.25', 'true'], [2, '0.75', 'false']],
};
const mixedSql = await registerInDuckDB(mixedNumbers);
eq('INT becomes BIGINT', mixedSql.schema[0].data_type, 'BIGINT');
eq('FLOAT becomes DOUBLE', mixedSql.schema[1].data_type, 'DOUBLE');
eq('BOOL becomes BOOLEAN', mixedSql.schema[2].data_type, 'BOOLEAN');
eq('a decimal column averages without a cast',
   (await runQuery(`SELECT AVG("rate") AS a FROM "${mixedSql.tbl}"`)).rows[0].a, 0.5);

// ISO dates are cast, because DuckDB parses them.
const isoDates = {
  name: 'iso-dates.csv',
  columns: [{ name: 'day', type: 'DATE' }, { name: 'n', type: 'INT' }],
  rows: [['2025-06-30', 3], ['2025-04-01', 4]],
};
const isoSql = await registerInDuckDB(isoDates);
eq('an ISO date column becomes a real DATE', isoSql.schema[0].data_type, 'DATE');
eq('date comparison works on it without a cast',
   (await runQuery(`SELECT COUNT(*) AS n FROM "${isoSql.tbl}" WHERE "day" >= DATE '2025-05-01'`)).rows[0].n, 1);

// Loose dates are NOT cast. Date.parse accepts these, DuckDB does not, and
// casting them would replace readable text with NULL.
const looseDates = {
  name: 'loose-dates.csv',
  columns: [{ name: 'day', type: 'DATE' }, { name: 'n', type: 'INT' }],
  rows: [['Jan 5 2025', 3], ['March 2 2025', 4]],
};
const looseSql = await registerInDuckDB(looseDates);
eq('a loosely formatted date column stays text instead of turning into NULL',
   looseSql.schema[0].data_type, 'VARCHAR');
eq('its values are still readable',
   (await runQuery(`SELECT "day" FROM "${looseSql.tbl}" ORDER BY "n"`)).rows.map((r) => r.day),
   ['Jan 5 2025', 'March 2 2025']);
eq('the numeric column beside it was still typed', looseSql.schema[1].data_type, 'BIGINT');

// A column name containing a double quote must not break the projection.
const awkwardName = {
  name: 'awkward.csv',
  columns: [{ name: 'the "total"', type: 'INT' }],
  rows: [[5], [7]],
};
const awkwardSql = await registerInDuckDB(awkwardName);
eq('a quoted column name is escaped, not concatenated into broken SQL',
   awkwardSql.schema[0].data_type, 'BIGINT');
eq('and it still adds up',
   (await runQuery(`SELECT SUM("the ""total""") AS s FROM "${awkwardSql.tbl}"`)).rows[0].s, 12);

await closeConnection();

// ============================================================
console.log('\n4. Fix 2: an empty export is never reported as a success');
// ============================================================
for (const [label, ds] of [
  ['no dataset loaded at all', null],
  ['a dataset with columns but no rows', { columns: fixed.dataset.columns, rows: [] }],
  ['the shape the old global would have had', { columns: [], rows: [] }],
]) {
  const empty = makeExportHarness(ds);
  empty.api.exportCSV();
  empty.api.exportXLSX();
  const successes = empty.toasts.filter((t) => t.type === 'success');
  const errors = empty.toasts.filter((t) => t.type === 'error');
  eq(`${label}: no success toast`, successes.length, 0);
  eq(`${label}: two clear failure toasts, one per format`, errors.length, 2);
  ok(`${label}: the failure says nothing was exported`,
     errors.every((t) => t.msg.includes('Nothing was exported')));
  eq(`${label}: no file was downloaded`, empty.downloads.length, 0);
  eq(`${label}: no .xlsx was written`, empty.written.length, 0);
  eq(`${label}: an export-failed event was dispatched for each format`,
     empty.events.filter((e) => e.type === 'dataglow:export-failed').map((e) => e.detail.format),
     ['csv', 'xlsx']);
  eq(`${label}: no export-triggered event claimed a write`,
     empty.events.filter((e) => e.type === 'dataglow:export-triggered').length, 0);
}

// A dataset that is present but unreachable through the store still must not
// produce a celebratory toast.
const unreachable = makeExportHarness(undefined);
unreachable.api.exportCSV();
eq('an undefined active dataset fails loudly rather than silently', unreachable.toasts[0].type, 'error');

// ============================================================
console.log('\n5. House rules');
// ============================================================
const newVisibleStrings = [
  'Nothing was exported. There are no data rows loaded, so the CSV would have been empty. Load a file, then export again.',
  'Nothing was exported. There are no data rows loaded, so the Data sheet would have been empty. Load a file, then export again.',
  'Nothing was exported. The Data sheet came out empty, so no .xlsx was written.',
  'Exported 9 rows and 4 columns as CSV (1.0 KB).',
  'Exported 9 rows and 4 columns as XLSX (Data, Proof Chain, FQS Scorecard).',
];
ok('no em dash in any string this fix added to visible product text',
   newVisibleStrings.every((s) => !s.includes('\u2014')));
ok('no HIPAA claim was added anywhere in this change',
   !exportSrcs.includes('HIPAA') && !loadSheetSrc.includes('HIPAA') && !typeSampleSrc.includes('HIPAA'));

// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
