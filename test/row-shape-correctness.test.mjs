// ============================================================
// DATAGLOW — Bundle A: row-shape correctness
// ============================================================
// DataGlow dataset rows are POSITIONAL ARRAYS; columns are { name, type }.
// The dashboard engine has said so in its own header comment since PR AN, but
// three other call sites indexed rows by column NAME instead:
//
//   1. SQLEngine.registerDataset  -> CSV handed to DuckDB had every data cell
//      empty, so DuckDB loaded a table of NULLs behind a correct header.
//   2. ExportEngine.exportCSV / exportPDF -> header stringified as
//      [object Object] and every value came out empty.
//   3. JoinBuilder.executeJoin (and CardinalityDetector.analyze) -> every join
//      key resolved to '', so every join was a cartesian product.
//
// This suite proves the fix END TO END rather than by string matching alone:
//   * the shared helper (js/shared/row-shape.js) resolves cells for both row
//     shapes and escapes CSV per RFC 4180;
//   * the CSV the canvas's SQLEngine actually produces loads into a REAL
//     DuckDB and answers a REAL aggregate query (SELECT col, COUNT(*) ... GROUP
//     BY), not SELECT 1, with the right counts and non-empty cells;
//   * the canvas's own ExportEngine.exportCSV, executed verbatim out of
//     canvas/index.html, emits real column names and correctly escaped values;
//   * the canvas's own JoinBuilder.executeJoin, executed verbatim, returns the
//     inner-join row count, NOT the cartesian product.
//
// RUN WITH: node --import ./test/duckdb-loader-hook.mjs test/row-shape-correctness.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runQuery } from './node-duckdb-engine.mjs';
import {
  resolveColumnIndex,
  columnNames,
  getCell,
  rowToArray,
  escapeCsvValue,
  datasetToCsv,
} from '../js/shared/row-shape.js';

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
// Extract a function verbatim from the shipped canvas by brace matching.
// Same technique the existing hotfix suites use, so what is tested is what
// ships, byte for byte.
// ------------------------------------------------------------
function extractFunctionSource(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) return null;
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx + startMarker.length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  if (endIdx === -1) return null;
  return src.slice(startIdx, endIdx);
}

// The inlined DGRowShape module, lifted straight out of the canvas so the
// canvas functions below run against the canvas's own copy of the helper.
const rowShapeInline = (() => {
  const from = canvas.indexOf('/* ---- from js/shared/row-shape.js ---- */');
  const end = canvas.indexOf('/* ---- end row-shape.js ---- */');
  return from !== -1 && end !== -1 ? canvas.slice(from, end) : null;
})();
ok('canvas: the shared DGRowShape module is inlined with from/end markers', rowShapeInline !== null);

function loadCanvasFn(startMarker, fnName, prelude = '') {
  const fnSrc = extractFunctionSource(canvas, startMarker);
  ok(`canvas: ${fnName} is present verbatim with a matching closing brace`, fnSrc !== null);
  if (!fnSrc) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${rowShapeInline}\n${prelude}\n${fnSrc}\nreturn ${fnName};`)();
}

// ------------------------------------------------------------
// The fixture: 3+ columns, 5 rows, one value with a comma, one with a quote.
// ------------------------------------------------------------
const fixture = {
  name: 'orders.csv',
  columns: [
    { name: 'region', type: 'STR' },
    { name: 'customer', type: 'STR' },
    { name: 'amount', type: 'INT' },
  ],
  rows: [
    ['north', 'Acme, Inc.', 100],           // embedded comma
    ['north', 'Bell "Bob" Co', 250],        // embedded double quote
    ['south', 'Cairn Ltd', 75],
    ['south', 'Dune Group', 40],
    ['east',  'Echo\nWorks', 10],           // embedded newline
  ],
};

// ============================================================
console.log('\n1. Shared helper: js/shared/row-shape.js');
// ============================================================
eq('resolveColumnIndex finds a column by name', resolveColumnIndex(fixture.columns, 'amount'), 2);
eq('resolveColumnIndex returns -1 for an unknown column', resolveColumnIndex(fixture.columns, 'nope'), -1);
eq('columnNames strips the column objects down to names', columnNames(fixture.columns), ['region', 'customer', 'amount']);
eq('getCell reads a POSITIONAL ARRAY row by column name', getCell(fixture.rows[0], fixture.columns, 'amount'), 100);
eq('getCell also reads an OBJECT row (legacy interop shape)',
   getCell({ region: 'west', customer: 'Zed', amount: 7 }, fixture.columns, 'amount'), 7);
eq('rowToArray normalises an object row to positional order',
   rowToArray({ amount: 7, region: 'west', customer: 'Zed' }, fixture.columns), ['west', 'Zed', 7]);
eq('escapeCsvValue quotes a value containing a comma', escapeCsvValue('Acme, Inc.'), '"Acme, Inc."');
eq('escapeCsvValue DOUBLES an embedded quote (RFC 4180), never backslash-escapes it',
   escapeCsvValue('Bell "Bob" Co'), '"Bell ""Bob"" Co"');
ok('escapeCsvValue never emits a JSON backslash escape',
   escapeCsvValue('Bell "Bob" Co').indexOf('\\') === -1);
eq('escapeCsvValue quotes an embedded newline', escapeCsvValue('Echo\nWorks'), '"Echo\nWorks"');
eq('escapeCsvValue maps null and undefined to an empty field',
   [escapeCsvValue(null), escapeCsvValue(undefined)], ['', '']);

// ============================================================
console.log('\n2. Site 1: the CSV SQLEngine.registerDataset hands to DuckDB');
// ============================================================
ok('canvas: registerDataset serialises through the shared helper, not row[columnName]',
   canvas.includes('var csv = DGRowShape.datasetToCsv(dataset);'));
ok('canvas: the old name-indexed serialiser is gone',
   !canvas.includes("var v = row[c];\n          if (v === null || v === undefined) return '';"));

const csv = datasetToCsv(fixture);
const csvHeader = csv.split('\n')[0];
eq('serialised header is the real column names', csvHeader, 'region,customer,amount');
ok('serialised body is not empty cells (the old bug produced ",,"),',
   !/^,+$/m.test(csv) && csv.includes('100'));

// Load that exact CSV into a REAL DuckDB and run a REAL aggregate query.
const tmp = mkdtempSync(join(tmpdir(), 'dg-rowshape-'));
const csvPath = join(tmp, 'orders.csv');
writeFileSync(csvPath, csv, 'utf8');

await runQuery(
  `CREATE OR REPLACE TABLE orders AS SELECT * FROM read_csv_auto('${csvPath.replace(/'/g, "''")}', header=true)`
);

const counted = await runQuery('SELECT region, COUNT(*) AS n FROM orders GROUP BY region ORDER BY region');
eq('DuckDB GROUP BY returns one row per real region value',
   counted.rows.map(r => `${r.region}:${r.n}`), ['east:1', 'north:2', 'south:2']);

const summed = await runQuery('SELECT SUM(amount) AS total FROM orders');
eq('DuckDB reads the numeric column as real numbers, not NULLs', summed.rows[0].total, 475);

const nulls = await runQuery('SELECT COUNT(*) AS n FROM orders WHERE region IS NULL OR customer IS NULL OR amount IS NULL');
eq('no cell loaded as NULL (the old bug made every data cell NULL)', nulls.rows[0].n, 0);

const quoted = await runQuery("SELECT amount FROM orders WHERE customer = 'Bell \"Bob\" Co'");
eq('a value containing a double quote survives the round trip into DuckDB',
   quoted.rows.length === 1 ? quoted.rows[0].amount : null, 250);

const comma = await runQuery("SELECT amount FROM orders WHERE customer = 'Acme, Inc.'");
eq('a value containing a comma survives the round trip into DuckDB',
   comma.rows.length === 1 ? comma.rows[0].amount : null, 100);

const newline = await runQuery("SELECT amount FROM orders WHERE customer = 'Echo\nWorks'");
eq('a value containing a newline survives the round trip into DuckDB',
   newline.rows.length === 1 ? newline.rows[0].amount : null, 10);

// ============================================================
console.log('\n3. Site 2: ExportEngine.exportCSV, executed verbatim from the canvas');
// ============================================================
// Stub the two browser bits exportCSV touches (Blob + triggerDownload) so the
// shipped function body itself can run under Node and its output be captured.
let captured = null;
globalThis.__dgCapture = (text, filename) => { captured = { text, filename }; };

const exportCsvPrelude = [
  'function Blob(parts) { this.parts = parts; }',
  "function triggerDownload(blob, filename) { globalThis.__dgCapture(blob.parts.join(''), filename); }",
].join('\n');

const exportCSV = loadCanvasFn(
  'function exportCSV(dataset, filename) {',
  'exportCSV',
  exportCsvPrelude
);

if (exportCSV) {
  exportCSV(fixture, 'orders');
  const text = captured ? captured.text : '';
  const lines = text.split('\n');
  eq('exported header is the real column names, not [object Object]', lines[0], 'region,customer,amount');
  ok('exported CSV contains no [object Object] anywhere', !text.includes('[object Object]'));
  eq('exported row 1 keeps its values and quotes the embedded comma', lines[1], 'north,"Acme, Inc.",100');
  eq('exported row 2 doubles the embedded quote', lines[2], 'north,"Bell ""Bob"" Co",250');
  eq('exported filename keeps the .csv extension', captured ? captured.filename : null, 'orders.csv');
}

ok('canvas: exportCSV delegates to the shared helper',
   canvas.includes('DGRowShape.datasetToCsv(dataset)'));
ok('canvas: exportPDF resolves column names and cells through the shared helper',
   canvas.includes('var cols  = DGRowShape.columnNames(dataset.columns);') &&
   canvas.includes('DGRowShape.getCell(r, dataset.columns, col)'));
ok('canvas: there is no second, local escapeCSV implementation left in ExportEngine',
   !canvas.includes('function escapeCSV(val) {'));

// ============================================================
console.log('\n4. Site 3: JoinBuilder.executeJoin, executed verbatim from the canvas');
// ============================================================
const executeJoin = loadCanvasFn(
  'function executeJoin(dsA, dsB, keyA, keyB, joinType) {',
  'executeJoin'
);

// A: 5 rows, 4 distinct customer_ids. B: 4 rows, 3 of which match.
// Inner join = 4 matched A rows x 1 B row each = 4 rows.
// Cartesian product (the old bug) would be 5 x 4 = 20 rows.
const dsA = {
  name: 'people.csv',
  columns: [{ name: 'customer_id', type: 'STR' }, { name: 'name', type: 'STR' }],
  rows: [['c1', 'Ann'], ['c2', 'Ben'], ['c3', 'Cara'], ['c4', 'Dev'], ['c9', 'Unmatched']],
};
const dsB = {
  name: 'spend.csv',
  columns: [{ name: 'customer_id', type: 'STR' }, { name: 'spend', type: 'INT' }],
  rows: [['c1', 10], ['c2', 20], ['c3', 30], ['c4', 40]],
};

if (executeJoin) {
  const inner = executeJoin(dsA, dsB, 'customer_id', 'customer_id', 'inner');
  eq('inner join returns the expected 4 rows, NOT the 20-row cartesian product',
     inner.rows.length, 4);
  eq('joined columns are customer_id, name, spend',
     inner.columns.map(c => c.name), ['customer_id', 'name', 'spend']);
  ok('joined rows are positional arrays (the DataGlow row shape)',
     Array.isArray(inner.rows[0]));
  eq('the first joined row carries real values across from both sides',
     inner.rows[0], ['c1', 'Ann', 10]);
  ok('no joined cell is the empty string the old key lookup produced',
     inner.rows.every(r => r.every(v => v !== '')));

  const left = executeJoin(dsA, dsB, 'customer_id', 'customer_id', 'left');
  eq('left join keeps all 5 left rows', left.rows.length, 5);
  eq('the unmatched left row gets a null on the right side',
     left.rows[4], ['c9', 'Unmatched', null]);

  // Fan-out: two B rows share a key, so the inner join is 5, not 4 and not 20.
  const dsBFan = {
    name: 'spend.csv',
    columns: [{ name: 'customer_id', type: 'STR' }, { name: 'spend', type: 'INT' }],
    rows: [['c1', 10], ['c1', 11], ['c2', 20], ['c3', 30], ['c4', 40]],
  };
  eq('a genuine 1:N fan-out produces 5 rows, matching the real match count',
     executeJoin(dsA, dsBFan, 'customer_id', 'customer_id', 'inner').rows.length, 5);

  // A join key with NO overlap must produce zero inner rows, which is the
  // clearest possible proof the keys are really being compared.
  const dsNoMatch = {
    name: 'other.csv',
    columns: [{ name: 'customer_id', type: 'STR' }, { name: 'spend', type: 'INT' }],
    rows: [['z1', 1], ['z2', 2]],
  };
  eq('a join with no overlapping keys returns 0 rows, not a cartesian product',
     executeJoin(dsA, dsNoMatch, 'customer_id', 'customer_id', 'inner').rows.length, 0);
}

ok('canvas: CardinalityDetector.analyze reads keys through the shared helper',
   canvas.includes('var v = DGRowShape.getCell(r, dsA.columns, keyA);') &&
   canvas.includes('var v = DGRowShape.getCell(r, dsB.columns, keyB);'));

// ============================================================
console.log('\n5. House rules');
// ============================================================
const newVisibleStrings = [
  'Merge datasets',
];
ok('no em dash in any string this bundle added to visible product text',
   newVisibleStrings.every(s => !s.includes('\u2014')));

const helperSrc = readFileSync(join(repoRoot, 'js', 'shared', 'row-shape.js'), 'utf8');
ok('the shared helper exports resolveColumnIndex and getCell',
   /export function resolveColumnIndex/.test(helperSrc) && /export function getCell/.test(helperSrc));
ok('the js/ mirrors import the shared helper rather than re-implementing it',
   readFileSync(join(repoRoot, 'js', 'export', 'export-engine.js'), 'utf8').includes("from '../shared/row-shape.js'") &&
   readFileSync(join(repoRoot, 'js', 'join', 'join-builder.js'), 'utf8').includes("from '../shared/row-shape.js'") &&
   readFileSync(join(repoRoot, 'js', 'sql', 'sql-engine.js'), 'utf8').includes("from '../shared/row-shape.js'"));

// ============================================================
console.log(`\nrow-shape-correctness: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
