// ============================================================
// DATAGLOW - Bundle C: Excel import and export, for real
// ============================================================
// Before this bundle, Excel was a claim, not a feature:
//
//   * canvas/index.html had NO script tag for SheetJS at all, so window.XLSX
//     was undefined on the canvas surface and every .xlsx drop fell through to
//     the unsupported-format branch;
//   * the only vendored copy (0.18.5) was loaded solely by the root index.html;
//   * exportXLSX() therefore could never run on the canvas.
//
// This suite proves the fix without a network connection of any kind:
//
//   1. the vendored file is the official SheetJS 0.20.3 build, byte for byte,
//      matched against the SHA-256 recorded in assets/xlsx/PROVENANCE.md;
//   2. it loads and runs as a PLAIN BROWSER SCRIPT (evaluated in a vm context
//      with no require, no module, no fs), which is exactly how the two HTML
//      surfaces load it;
//   3. nothing at runtime points at a CDN;
//   4. both index.html and canvas/index.html carry a script tag for it;
//   5. the converter turns a real workbook into DataGlow's POSITIONAL-ARRAY row
//      shape, with the right row count, column names and spot-checked cells;
//   6. the messy cases a real spreadsheet throws at you are DETECTED and
//      REPORTED rather than silently mangled: header not on row 1, blank
//      leading rows, trailing empty columns, merged ranges, Excel serial dates,
//      numbers stored as text;
//   7. a dataset survives an export-then-reimport round trip unchanged;
//   8. the copy inlined into canvas/index.html behaves identically to the
//      module, because it is executed verbatim out of the shipped HTML.
//
// Network access is actively blocked for the duration of the suite: fetch,
// http.request and https.request are replaced with functions that throw. If
// anything here reached for a CDN the suite would fail loudly.
//
// If the real Excel-authored fixtures are present on the machine (they live
// outside the repo and are not in CI), a few extra assertions run against them.
//
// RUN WITH: node test/excel-roundtrip.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import http from 'node:http';
import https from 'node:https';

import {
  aoaToDataset,
  findHeaderRow,
  normalizeHeaders,
  excelSerialToISO,
  looksNumericText,
  summarizeSheets,
  sheetIsEmpty,
} from '../js/shared/excel-import.js';
import { columnNames, getCell, rowToArray } from '../js/shared/row-shape.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// ------------------------------------------------------------
// Hard offline guard. Any network call from here on is a failure.
// ------------------------------------------------------------
const boom = () => { throw new Error('NETWORK ACCESS ATTEMPTED during the Excel suite. Everything must be local.'); };
globalThis.fetch = boom;
http.request = boom;
http.get = boom;
https.request = boom;
https.get = boom;

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

// ============================================================
// 1. The vendored file
// ============================================================
console.log('\n--- vendored SheetJS build ---');

const VENDORED = join(repoRoot, 'assets', 'xlsx', 'xlsx-0.20.3.full.min.js');
const EXPECTED_SHA256 = 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41';
const EXPECTED_BYTES = 951904;

ok('assets/xlsx/xlsx-0.20.3.full.min.js exists in the repo', existsSync(VENDORED));
const vendorBytes = readFileSync(VENDORED);
eq('vendored build byte count', vendorBytes.length, EXPECTED_BYTES);
eq('vendored build SHA-256 matches PROVENANCE.md',
   createHash('sha256').update(vendorBytes).digest('hex'), EXPECTED_SHA256);

const provenance = readFileSync(join(repoRoot, 'assets', 'xlsx', 'PROVENANCE.md'), 'utf8');
ok('PROVENANCE.md records the SHA-256', provenance.includes(EXPECTED_SHA256));
ok('PROVENANCE.md records the official download origin', provenance.includes('cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'));
ok('Apache-2.0 licence text is vendored alongside it',
   readFileSync(join(repoRoot, 'assets', 'xlsx', 'SHEETJS-LICENSE'), 'utf8').includes('Apache License'));
ok('the superseded 0.18.5 build is gone from the tree',
   !existsSync(join(repoRoot, 'assets', 'xlsx', 'xlsx-0.18.5.full.min.js')));

// ------------------------------------------------------------
// Load it the way a browser does: as a bare script, in a context with a window
// and nothing else. No require, no module, no fs, no process.
// ------------------------------------------------------------
function loadVendoredXLSX() {
  const sandbox = {
    window: {}, console, TextDecoder, TextEncoder, Date, Math, JSON,
    Uint8Array, Uint16Array, Int32Array, Float64Array, ArrayBuffer, DataView,
    Array, Object, String, Number, Boolean, RegExp, Error, TypeError,
    isFinite, isNaN, parseInt, parseFloat, decodeURIComponent, encodeURIComponent,
    setTimeout, clearTimeout,
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(VENDORED, 'utf8'), sandbox, { filename: 'xlsx.full.min.js' });
  return sandbox.XLSX || sandbox.window.XLSX;
}

let XLSX = null;
try { XLSX = loadVendoredXLSX(); } catch (err) { console.log('  load error: ' + err.message); }
ok('the vendored file runs as a plain browser script and defines XLSX', !!(XLSX && typeof XLSX.read === 'function'));
eq('XLSX.version reported by the library itself', XLSX && XLSX.version, '0.20.3');
ok('it exposes the writer as well as the reader', !!(XLSX && typeof XLSX.write === 'function'));

// ============================================================
// 2. No CDN at runtime, script tag present on both surfaces
// ============================================================
console.log('\n--- runtime wiring ---');

const rootHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8');
const canvasHtml = readFileSync(join(repoRoot, 'canvas', 'index.html'), 'utf8');

ok('root index.html loads the vendored 0.20.3 build',
   /<script src="assets\/xlsx\/xlsx-0\.20\.3\.full\.min\.js"><\/script>/.test(rootHtml));
ok('canvas/index.html loads the vendored 0.20.3 build (this tag did not exist before)',
   /<script src="\.\.\/assets\/xlsx\/xlsx-0\.20\.3\.full\.min\.js"><\/script>/.test(canvasHtml));
ok('no page references the superseded 0.18.5 file',
   !rootHtml.includes('xlsx-0.18.5') && !canvasHtml.includes('xlsx-0.18.5'));

const CDN_HOSTS = ['cdn.sheetjs.com', 'unpkg.com/xlsx', 'cdn.jsdelivr.net/npm/xlsx', 'cdnjs.cloudflare.com/ajax/libs/xlsx'];
for (const host of CDN_HOSTS) {
  // A URL may appear inside a /* */ provenance comment. It may NOT appear in a
  // src= or an import that would run.
  const live = new RegExp('(src|href)\\s*=\\s*["\\\'][^"\\\']*' + host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  ok(`nothing loads xlsx from ${host} at runtime`, !live.test(rootHtml) && !live.test(canvasHtml));
}

// ============================================================
// 3. The messy-workbook conversion, on a workbook we build here
// ============================================================
console.log('\n--- messy workbook, built with the vendored writer ---');

// Deliberately awful, and every kind of awful is one a real export produces.
const messyAoa = [
  ['Q3 Regional Roll-up', null, null, null, null, null],   // title row
  [null, null, null, null, null, null],                    // blank row
  ['Region', 'Signed On', 'Revenue', 'Units', '', 'Region'], // header on row 3, blank + duplicate name
  ['North', 45292, '$1,204.50', 12, null, 'North'],        // serial date, number as text
  ['South', 45293, '$980.00', 7, null, 'South'],
  [null, null, null, null, null, null],                    // blank body row
  ['East', 45294, '$2,010.75', 31, null, 'East'],
];

const messyWs = XLSX.utils.aoa_to_sheet(messyAoa);
// Give the date column a real Excel date number format, and merge the title.
['B4', 'B5', 'B7'].forEach((addr) => { if (messyWs[addr]) messyWs[addr].z = 'yyyy-mm-dd'; });
messyWs['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];

const messyWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(messyWb, messyWs, 'Roll Up');
XLSX.utils.book_append_sheet(messyWb, XLSX.utils.aoa_to_sheet([[]]), 'Blank Sheet');

// Round-trip it through real .xlsx bytes so we are parsing a file, not an object.
const messyBytes = XLSX.write(messyWb, { type: 'array', bookType: 'xlsx' });
ok('the vendored writer produced real xlsx bytes', messyBytes && messyBytes.byteLength > 0);
const reread = XLSX.read(new Uint8Array(messyBytes), { type: 'array' });
eq('both sheets survive the write and re-read', reread.SheetNames, ['Roll Up', 'Blank Sheet']);

const toAoa = (wb, sn) => XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null, blankrows: true });

const summaries = summarizeSheets(reread.SheetNames, (sn) => toAoa(reread, sn));
eq('sheet summary names', summaries.map((s) => s.name), ['Roll Up', 'Blank Sheet']);
ok('the empty sheet is reported as empty so the picker can disable it', summaries[1].empty === true);
ok('the populated sheet is not reported as empty', summaries[0].empty === false);

const messyRes = aoaToDataset(toAoa(reread, 'Roll Up'), 'messy.xlsx', {
  dateColumns: [1],
  merges: reread.Sheets['Roll Up']['!merges'] || [],
  is1904: false,
});

eq('header row found on row 3, not row 1', messyRes.headerRowIndex, 2);
eq('column names, with the blank one named and the duplicate suffixed',
   messyRes.columns.map((c) => c.name), ['Region', 'Signed On', 'Revenue', 'Units', 'column_5', 'Region_2']);
eq('blank body rows are dropped, real ones are kept', messyRes.rows.length, 3);
ok('rows are POSITIONAL ARRAYS, not objects', Array.isArray(messyRes.rows[0]));
eq('every row is exactly as wide as the column list',
   messyRes.rows.map((r) => r.length), [6, 6, 6]);

eq('spot check: first row reads back in column order',
   messyRes.rows[0], ['North', '2024-01-01', '$1,204.50', 12, null, 'North']);
eq('spot check by column name through the shared row-shape helper',
   getCell(messyRes.rows[2], messyRes.columns, 'Revenue'), '$2,010.75');
eq('Excel serial 45294 became a readable date', getCell(messyRes.rows[2], messyRes.columns, 'Signed On'), '2024-01-03');

const noteText = messyRes.notes.join(' | ');
ok('it says the header was not on row 1', /header was not on row 1/i.test(noteText));
ok('it says how many rows above the header were skipped', /Row 3 was used as the header/.test(noteText));
ok('it names the blank header cell it renamed', /blank and got a placeholder name/i.test(noteText));
ok('it says a duplicate header name was suffixed', /duplicated and got a numeric suffix/i.test(noteText));
ok('it reports the merged range', /merged cell range/i.test(noteText));
ok('it reports the serial dates it converted', /Excel serial number/i.test(noteText));
ok('it reports the numbers stored as text', /stored as text/i.test(noteText));
ok('it promises NOT to coerce the numbers-as-text values', /left exactly as they are so nothing is invented/i.test(noteText));
ok('no note contains an em dash', !/\u2014/.test(noteText));

// The values it warned about really were left alone.
eq('numbers stored as text are still text, not silently coerced',
   messyRes.rows.map((r) => r[2]), ['$1,204.50', '$980.00', '$2,010.75']);

// Trailing-empty-column trimming, tested on its own.
const paddedRes = aoaToDataset([['a', 'b', null, null], [1, 2, null, null]], 'padded.xlsx', {});
eq('trailing all-empty columns are dropped', paddedRes.columns.map((c) => c.name), ['a', 'b']);
ok('and it says so', /trailing empty column/i.test(paddedRes.notes.join(' ')));

const emptyRes = aoaToDataset([[null, null], [null, null]], 'empty.xlsx', {});
eq('an empty sheet yields no rows', emptyRes.rows.length, 0);
ok('an empty sheet says nothing was loaded', /Nothing was loaded/.test(emptyRes.notes.join(' ')));
ok('sheetIsEmpty agrees', sheetIsEmpty([[null, ''], [undefined]]) === true);

// ============================================================
// 4. Unit-level behaviour of the helpers
// ============================================================
console.log('\n--- converter helpers ---');

eq('excelSerialToISO on the 1900 system', excelSerialToISO(45292, false), '2024-01-01');
eq('excelSerialToISO on the 1904 system', excelSerialToISO(43830, true), '2024-01-01');
eq('excelSerialToISO keeps a time component when the serial has one',
   excelSerialToISO(45292.5, false), '2024-01-01 12:00:00');
eq('a plain large number is not mistaken for a date', excelSerialToISO(15634602, false), null);
eq('a non-number is never a date', excelSerialToISO('45292', false), null);

ok('a currency string counts as a number stored as text', looksNumericText('$1,204.50'));
ok('a euro amount counts too', looksNumericText('\u20AC101348.88'));
ok('a percent counts too', looksNumericText('12.5%'));
ok('a real word does not', !looksNumericText('Hargrave'));
ok('an empty string does not', !looksNumericText('   '));

eq('findHeaderRow skips a one-cell title row', findHeaderRow([['Title'], [], ['a', 'b'], [1, 2]]), 2);
eq('findHeaderRow returns row 0 for a clean sheet', findHeaderRow([['a', 'b'], [1, 2]]), 0);
eq('normalizeHeaders numbers repeated names', normalizeHeaders(['x', 'x', 'x']).names, ['x', 'x_2', 'x_3']);

// ============================================================
// 5. Export, then re-import, unchanged
// ============================================================
console.log('\n--- export and re-import round trip ---');

const dataset = {
  columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'STR' }, { name: 'amount', type: 'FLOAT' }],
  rows: [[1, 'Ann, Lee', 10.5], [2, 'Quote "Q"', -3], [3, 'line\nbreak', 0]],
};

const headers = columnNames(dataset.columns);
eq('column names come out as strings, never [object Object]', headers, ['id', 'name', 'amount']);

const outWs = XLSX.utils.aoa_to_sheet([headers].concat(dataset.rows.map((r) => rowToArray(r, dataset.columns))));
const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, outWs, 'Data');
const outBytes = XLSX.write(outWb, { type: 'array', bookType: 'xlsx' });

const backWb = XLSX.read(new Uint8Array(outBytes), { type: 'array' });
const backRes = aoaToDataset(toAoa(backWb, 'Data'), 'roundtrip.xlsx', {});
eq('round trip keeps the column names', backRes.columns.map((c) => c.name), ['id', 'name', 'amount']);
eq('round trip keeps the row count', backRes.rows.length, 3);
eq('round trip keeps commas, quotes and newlines inside cells',
   backRes.rows, [[1, 'Ann, Lee', 10.5], [2, 'Quote "Q"', -3], [3, 'line\nbreak', 0]]);

// ============================================================
// 6. The canvas copy is the same code, and the wiring is really there
// ============================================================
console.log('\n--- canvas inline copy and wiring ---');

const inlineStart = canvasHtml.indexOf('/* ---- from js/shared/excel-import.js ---- */');
const inlineEnd = canvasHtml.indexOf('/* ---- end excel-import.js ---- */');
ok('the converter is inlined into the canvas with its provenance markers', inlineStart !== -1 && inlineEnd > inlineStart);

const inlineSrc = canvasHtml.slice(inlineStart, inlineEnd);
let DGExcel = null;
try {
  DGExcel = new Function(inlineSrc + '; return DGExcel;')();
} catch (err) {
  console.log('  inline eval error: ' + err.message);
}
ok('the inlined block evaluates and exposes DGExcel', !!(DGExcel && typeof DGExcel.aoaToDataset === 'function'));

if (DGExcel) {
  const inlineRes = DGExcel.aoaToDataset(toAoa(reread, 'Roll Up'), 'messy.xlsx', {
    dateColumns: [1],
    merges: reread.Sheets['Roll Up']['!merges'] || [],
    is1904: false,
  });
  eq('the canvas copy produces byte-identical output to the module',
     JSON.stringify(inlineRes), JSON.stringify(messyRes));
  eq('the canvas copy exposes the sheet summariser too',
     DGExcel.summarizeSheets(reread.SheetNames, (sn) => toAoa(reread, sn)).map((s) => s.name),
     ['Roll Up', 'Blank Sheet']);
}

ok('routeDroppedFile has a real xlsx branch', /fmt === 'xlsx' \|\| fmt === 'xls'/.test(canvasHtml));
ok('that branch calls the Excel ingester', /ingestExcelFile\(file, name, fmt, fileHash, seenBefore, advance\)/.test(canvasHtml));
ok('ingestExcelFile is defined', /function ingestExcelFile\(/.test(canvasHtml));
ok('a multi-sheet workbook opens a picker instead of guessing', /function showSheetPicker\(/.test(canvasHtml));
ok('the picker offers a cancel that loads nothing', /Cancel, load nothing/.test(canvasHtml));
ok('what was found in the sheet is reported to the user', /function showExcelNotes\(/.test(canvasHtml));
ok('the file is read with FileReader, never uploaded', /readAsArrayBuffer\(file\)/.test(canvasHtml));

// Bundle B's honest refusal must no longer claim Excel is unsupported.
const helpTableMatch = /var UNSUPPORTED_FORMAT_HELP = \{[\s\S]*?\n  \};/.exec(canvasHtml);
ok('the unsupported-format help table was found', !!helpTableMatch);
if (helpTableMatch) {
  const table = helpTableMatch[0];
  ok('the refusal table no longer has an xlsx entry', !/\n\s*xlsx:/.test(table));
  ok('the refusal table no longer has an xls entry', !/\n\s*xls:/.test(table));
  ok('it no longer tells anyone Excel files are not supported', !/Excel files are not supported/.test(table));
}
ok('nowhere in the canvas still says Excel files are not supported',
   !canvasHtml.includes('Excel files are not supported yet'));

ok('the drop area lists Excel among the formats it reads',
   /<p id="drop-formats">[^<]*Excel \(\.xlsx, \.xls\)/.test(canvasHtml));
ok('the file picker accepts .xlsx', /accept="[^"]*\.xlsx/.test(canvasHtml));
ok('the file picker accepts .xls', /accept="[^"]*,\.xls,/.test(canvasHtml));
ok('the folder watcher accepts xlsx and xls',
   /var ACCEPTED = \/\\\.\(csv\|tsv\|json\|ndjson\|jsonl\|x12\|edi\|txt\|log\|xlsx\|xls\)\$\/i;/.test(canvasHtml));
ok('legacy .xls is detected by its OLE2 container magic', /function isCfbContainer\(/.test(canvasHtml));
ok('detectFileFormat returns the xls format', /return \{ format: 'xls', confidence: 'high'/.test(canvasHtml));

// The detector, executed verbatim out of the shipped canvas.
const detectorStart = canvasHtml.indexOf("var DropZoneRouter = (function () {");
// The block has no end marker, so close it at the IIFE's own terminator.
const detectorEnd = detectorStart === -1 ? -1 : canvasHtml.indexOf('\n  })();', detectorStart);
if (detectorStart !== -1 && detectorEnd > detectorStart) {
  let Router = null;
  try {
    Router = new Function(canvasHtml.slice(detectorStart, detectorEnd + '\n  })();'.length) + '\n; return DropZoneRouter;')();
  } catch (err) { console.log('  router eval error: ' + err.message); }
  ok('DropZoneRouter evaluates out of the shipped canvas', !!(Router && Router.detectFileFormat));
  if (Router && Router.detectFileFormat) {
    const pk = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    eq('a real xlsx is detected as xlsx', Router.detectFileFormat('book.xlsx', '', pk).format, 'xlsx');
    eq('a real xls is detected as xls', Router.detectFileFormat('book.xls', '', cfb).format, 'xls');
    eq('a legacy .doc in the same container is NOT called a spreadsheet',
       Router.detectFileFormat('memo.doc', '', cfb).format !== 'xls', true);
    eq('an extension-only xlsx is still routed to the Excel reader',
       Router.detectFileFormat('book.xlsx', '', null).format, 'xlsx');
  }
} else {
  ok('DropZoneRouter block located in the canvas', false);
}

// ============================================================
// 7. Optional: the real Excel-authored fixtures, when present
// ============================================================
const FIXTURES = '/home/user/workspace/maven-fixtures/x';
if (existsSync(join(FIXTURES, 'Bank_Churn_Messy.xlsx'))) {
  console.log('\n--- real Excel-authored fixture: Bank_Churn_Messy.xlsx ---');
  const wb = XLSX.read(new Uint8Array(readFileSync(join(FIXTURES, 'Bank_Churn_Messy.xlsx'))), { type: 'array' });
  eq('both sheets are found', wb.SheetNames, ['Customer_Info', 'Account_Info']);

  const res = aoaToDataset(toAoa(wb, 'Customer_Info'), 'Bank_Churn_Messy.xlsx', { merges: [], is1904: false });
  eq('Customer_Info row count', res.rows.length, 10001);
  eq('Customer_Info column names', res.columns.map((c) => c.name),
     ['CustomerId', 'Surname', 'CreditScore', 'Geography', 'Gender', 'Age', 'Tenure', 'EstimatedSalary']);
  eq('spot check: first row', res.rows[0], [15634602, 'Hargrave', 619, 'FRA', 'Female', 42, 2, '\u20AC101348.88']);
  eq('spot check by name: the salary of row 1', getCell(res.rows[0], res.columns, 'EstimatedSalary'), '\u20AC101348.88');
  ok('the six phantom trailing columns Excel padded in are dropped',
     /6 trailing empty columns were dropped/.test(res.notes.join(' ')));
  ok('the euro-prefixed salaries are flagged as numbers stored as text',
     /stored as text/.test(res.notes.join(' ')));

  const res2 = aoaToDataset(toAoa(wb, 'Account_Info'), 'Bank_Churn_Messy.xlsx', { merges: [], is1904: false });
  eq('Account_Info row count', res2.rows.length, 10002);
  eq('Account_Info column names', res2.columns.map((c) => c.name),
     ['CustomerId', 'Balance', 'NumOfProducts', 'HasCrCard', 'Tenure', 'IsActiveMember', 'Exited']);
} else {
  console.log('\n(real Excel fixtures not present on this machine, skipping that section)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
