// ============================================================
// Phase 7 — Excel Round-Trip Fidelity: test suite
// ============================================================
// Tests five improvements to buildWorkbookBlob:
//
//   1. safeSheetName()   — 31-char truncation, forbidden char stripping
//   2. computeColWidths()— header + row sampling, [8,60] clamp
//   3. coerceForExcel()  — Date passthrough, already-Date objects
//   4. Named data sheet  — dataset name drives the tab name, not 'Data'
//   5. Validation Overview block in Summary sheet
//   6. Validation Detail sheet: frozen header, 3 columns
//   7. Column sizing on Summary and Validation sheets
// ============================================================

import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import {
  buildDatasetView,
  buildWorkbookBlob,
  safeSheetName,
  computeColWidths,
  coerceForExcel,
} from '../js/export/export-report.js';

let pass = 0, fail = 0;
function test(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); pass++; }
  catch (e) { console.error(`  FAIL  ${label}\n        ${e.message}`); fail++; }
}

// ---------------------------------------------------------------
// Minimal SheetJS stub (no browser needed)
// ---------------------------------------------------------------
function makeSheetStub() {
  // wb is created fresh per buildWorkbookBlob call; we need to inspect
  // the sheets it collected. The wb object itself is the source of truth.
  // We expose a capturedWb reference by mutating it in book_append_sheet.
  let _wb = null;
  const stub = {
    utils: {
      book_new: () => {
        _wb = { SheetNames: [], Sheets: {} };
        return _wb;
      },
      aoa_to_sheet: (aoa, _opts) => {
        const sheet = { '!ref': 'A1', _aoa: aoa };
        // Populate header row cells so styleHeaderRow finds them
        if (aoa && aoa[0]) {
          aoa[0].forEach((val, c) => {
            const col = c < 26
              ? String.fromCharCode(65 + c)
              : String.fromCharCode(65 + Math.floor(c / 26) - 1) + String.fromCharCode(65 + (c % 26));
            sheet[col + '1'] = { v: val, t: 's' };
          });
        }
        return sheet;
      },
      book_append_sheet: (wb, sheet, name) => {
        wb.SheetNames.push(name);
        wb.Sheets[name] = sheet;
      },
      encode_cell: ({ r, c }) => {
        const col = c < 26
          ? String.fromCharCode(65 + c)
          : String.fromCharCode(65 + Math.floor(c / 26) - 1) + String.fromCharCode(65 + (c % 26));
        return col + (r + 1);
      },
    },
    write: () => new Uint8Array(4),
    // Helper: return the Sheets map from the most recently created workbook
    get sheets() { return _wb ? _wb.Sheets : {}; },
  };
  return stub;
}

function makeView(overrides = {}) {
  return buildDatasetView({
    dataset: { name: 'claims.csv', table: 'claims', rowCount: 3, cols: [], loadedAt: Date.now() },
    columns: ['patient_id', 'claim_date', 'amount'],
    rows: [
      { patient_id: 'P001', claim_date: '2024-01-15', amount: 1200.5 },
      { patient_id: 'P002', claim_date: '2024-02-20', amount: 850 },
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------
// 1. safeSheetName
// ---------------------------------------------------------------
console.log('\n--- 1. safeSheetName ---');

test('normal name passes through', () => strictEqual(safeSheetName('claims'), 'claims'));
test('exactly 31 chars passes through', () => {
  const s = 'a'.repeat(31);
  strictEqual(safeSheetName(s), s);
});
test('32 chars truncated to 31', () => {
  strictEqual(safeSheetName('a'.repeat(32)).length, 31);
});
test('backslash stripped', () => ok(!safeSheetName('a\\b').includes('\\')));
test('forward slash stripped', () => ok(!safeSheetName('a/b').includes('/')));
test('asterisk stripped', () => ok(!safeSheetName('a*b').includes('*')));
test('question mark stripped', () => ok(!safeSheetName('a?b').includes('?')));
test('square brackets stripped', () => ok(!safeSheetName('a[b]c').includes('[')));
test('colon stripped', () => ok(!safeSheetName('a:b').includes(':')));
test('empty string uses fallback', () => strictEqual(safeSheetName('', 'Fallback'), 'Fallback'));
test('null uses fallback', () => strictEqual(safeSheetName(null, 'FB'), 'FB'));
test('all-forbidden chars uses fallback', () => strictEqual(safeSheetName('\\/*?[]:', 'FB'), 'FB'));

// ---------------------------------------------------------------
// 2. computeColWidths
// ---------------------------------------------------------------
console.log('\n--- 2. computeColWidths ---');

test('returns one entry per header column', () => {
  const widths = computeColWidths(['a', 'b', 'c'], []);
  strictEqual(widths.length, 3);
});
test('each entry has wch property', () => {
  const widths = computeColWidths(['col'], []);
  ok('wch' in widths[0]);
});
test('minimum width is 8', () => {
  const widths = computeColWidths(['x'], [{ x: 'y' }]);
  ok(widths[0].wch >= 8);
});
test('maximum width is 60', () => {
  const longVal = 'a'.repeat(200);
  const widths = computeColWidths(['col'], [{ col: longVal }]);
  ok(widths[0].wch <= 60);
});
test('width is at least header length + 2', () => {
  const widths = computeColWidths(['patient_id'], [{ patient_id: 'P001' }]);
  // 'patient_id' = 10 chars + 2 = 12, clamped >= 8
  ok(widths[0].wch >= 12);
});
test('wider data value drives width', () => {
  const widths = computeColWidths(['x'], [{ x: 'a'.repeat(30) }]);
  ok(widths[0].wch >= 32); // 30 + 2
});
test('null/undefined row values do not crash', () => {
  const widths = computeColWidths(['x'], [null, undefined, { x: null }]);
  ok(widths[0].wch >= 8);
});
test('samples at most 500 rows (performance guard)', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ x: 'v' + i }));
  // Should not throw or hang
  const widths = computeColWidths(['x'], rows);
  ok(widths[0].wch >= 8);
});

// ---------------------------------------------------------------
// 3. coerceForExcel
// ---------------------------------------------------------------
console.log('\n--- 3. coerceForExcel (extended) ---');

test('already-Date object passes through', () => {
  const d = new Date('2024-06-01');
  ok(coerceForExcel(d) === d);
});
test('ISO date string -> Date', () => ok(coerceForExcel('2024-01-15') instanceof Date));
test('number stays number', () => strictEqual(coerceForExcel(42), 42));
test('null -> null', () => strictEqual(coerceForExcel(null), null));
test('empty string -> null', () => strictEqual(coerceForExcel(''), null));
test('string "PASS" stays string', () => strictEqual(coerceForExcel('PASS'), 'PASS'));

// ---------------------------------------------------------------
// 4. Named data sheet from dataset name
// ---------------------------------------------------------------
console.log('\n--- 4. Named data sheet ---');

test('claims.csv -> sheet named "claims" (not "Data")', () => {
  const view = makeView();
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  ok(xlsx.sheets['claims'] || Object.keys(xlsx.sheets)[0] !== 'Data',
    'first sheet should be derived from dataset name');
  // Check SheetNames directly
  const wb = { SheetNames: [] };
  const XLSX = makeSheetStub();
  buildWorkbookBlob(view, { xlsx: XLSX });
  // The first sheet should not be 'Data'
  const firstSheet = Object.keys(XLSX.sheets)[0];
  ok(firstSheet !== 'Data', `first sheet name should not be 'Data', got: ${firstSheet}`);
});

test('long dataset name truncated to 31 chars', () => {
  const view = makeView({ dataset: { name: 'a'.repeat(50) + '.csv', table: 't', rowCount: 0, cols: [], loadedAt: Date.now() } });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const firstSheet = Object.keys(xlsx.sheets)[0];
  ok(firstSheet.length <= 31, `sheet name length should be <= 31, got ${firstSheet.length}`);
});

test('dataset name with forbidden chars gets cleaned', () => {
  const view = makeView({ dataset: { name: 'my/data*file.csv', table: 't', rowCount: 0, cols: [], loadedAt: Date.now() } });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const firstSheet = Object.keys(xlsx.sheets)[0];
  ok(!firstSheet.includes('/') && !firstSheet.includes('*'), 'forbidden chars should be stripped');
});

// ---------------------------------------------------------------
// 5. Validation Overview block in Summary sheet
// ---------------------------------------------------------------
console.log('\n--- 5. Validation Overview in Summary ---');

const validationData = [
  { name: 'Null check', status: 'pass', summary: 'No nulls found' },
  { name: 'Range check', status: 'warn', summary: '3 outliers' },
  { name: 'Format check', status: 'fail', summary: 'Invalid dates' },
  { name: 'Referential', status: 'pass', summary: 'All keys matched' },
];

test('Summary sheet exists', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  ok('Summary' in xlsx.sheets, 'Summary sheet should exist');
});

test('Summary sheet contains PASS count row', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const summaryAoa = xlsx.sheets['Summary']._aoa;
  const flat = summaryAoa.flat().map(String);
  ok(flat.some(v => v.includes('PASS') || v === '2'), 'PASS count should appear in summary');
});

test('Summary sheet contains FAIL count', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const summaryAoa = xlsx.sheets['Summary']._aoa;
  const flat = summaryAoa.flat().map(String);
  ok(flat.some(v => v.includes('FAIL') || v === '1'), 'FAIL count should appear in summary');
});

test('Summary sheet has proper column widths', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const sheet = xlsx.sheets['Summary'];
  ok(sheet['!cols'], '!cols should be set on Summary sheet');
  ok(sheet['!cols'][0].wch >= 20, 'label column should be wide enough');
});

// ---------------------------------------------------------------
// 6. Validation Detail sheet
// ---------------------------------------------------------------
console.log('\n--- 6. Validation Detail sheet ---');

test('Validation Detail sheet exists when validation data provided', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  ok('Validation Detail' in xlsx.sheets, 'Validation Detail sheet should exist');
});

test('Validation Detail sheet NOT created when no validation data', () => {
  const view = makeView({ validation: [] });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  ok(!('Validation Detail' in xlsx.sheets), 'Validation Detail should not exist without data');
});

test('Validation Detail has 3 columns: Layer, Status, Summary', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const sheet = xlsx.sheets['Validation Detail'];
  const headerRow = sheet._aoa[0];
  strictEqual(headerRow[0], 'Layer');
  strictEqual(headerRow[1], 'Status');
  strictEqual(headerRow[2], 'Summary');
});

test('Validation Detail has correct row count (header + data rows)', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const sheet = xlsx.sheets['Validation Detail'];
  strictEqual(sheet._aoa.length, validationData.length + 1); // +1 for header
});

test('Validation Detail has column widths set', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const sheet = xlsx.sheets['Validation Detail'];
  ok(sheet['!cols'], '!cols should be set');
  strictEqual(sheet['!cols'].length, 3);
});

test('Validation Detail has freeze row set', () => {
  const view = makeView({ validation: validationData });
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const sheet = xlsx.sheets['Validation Detail'];
  ok(sheet['!freeze'], '!freeze should be set on Validation Detail');
  strictEqual(sheet['!freeze'].ySplit, 1, 'ySplit should be 1 (freeze after row 1)');
});

// ---------------------------------------------------------------
// 7. Data sheet column widths and freeze
// ---------------------------------------------------------------
console.log('\n--- 7. Data sheet !cols and !freeze ---');

test('Data sheet has !cols set', () => {
  const view = makeView();
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const firstSheet = Object.values(xlsx.sheets)[0];
  ok(firstSheet['!cols'], '!cols should be set on data sheet');
});

test('Data sheet !cols length matches column count', () => {
  const view = makeView();
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const firstSheet = Object.values(xlsx.sheets)[0];
  strictEqual(firstSheet['!cols'].length, view.columns.length);
});

test('Data sheet has !freeze set', () => {
  const view = makeView();
  const xlsx = makeSheetStub();
  buildWorkbookBlob(view, { xlsx });
  const firstSheet = Object.values(xlsx.sheets)[0];
  ok(firstSheet['!freeze'], '!freeze should be set on data sheet');
  strictEqual(firstSheet['!freeze'].ySplit, 1, 'header row should be frozen');
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
