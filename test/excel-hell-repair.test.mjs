import assert from 'assert';
import {
  detect,
  preview,
  apply,
  undo,
  refresh,
  inferColumnType,
  EXCEL_HELL_REPAIR_VERSION
} from '../js/intelligence/excel-hell-repair.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed++;
}

console.log('excel-hell-repair');
ok('version', EXCEL_HELL_REPAIR_VERSION === 1);

// ---------------------------------------------------------------------------
// Fixture A: title rows + blank + single header + data + footer
// ---------------------------------------------------------------------------
const dsA = {
  columns: ['col1', 'col2', 'col3'],
  rows: [
    ['Quarterly Sales Report', null, null],   // 0 title
    ['Generated 2026-01-01', null, null],      // 1 title
    [null, null, null],                        // 2 blank
    ['Region', 'Units', 'Revenue'],            // 3 header
    ['East', '10', '100.5'],                   // 4
    ['West', '20', '200.0'],                   // 5
    [null, null, null],                        // 6 blank spacer
    ['North', '30', '300.25'],                 // 7
    ['Total', '60', '600.75']                  // 8 footer
  ]
};

const rA = detect(dsA);
const headerFinding = rA.findings.find(f => f.kind === 'header');
ok('A header detected row 4', headerFinding && /row 4/.test(headerFinding.label));
ok('A recipe has promoteHeader', rA.recipe.steps.some(s => s.op === 'promoteHeader' && s.rowIndex === 3));
ok('A drops title rows', rA.recipe.steps.some(s => s.op === 'dropRows'));

const prevA = preview(dsA, rA.recipe);
ok('A preview names', prevA.columns.map(c => c.name).join(',') === 'Region,Units,Revenue');
ok('A preview drops footer+blanks', prevA.rows.every(r => r[0] !== 'Total' && r[0] != null));
ok('A preview row count 3', prevA.totalRows === 3);
ok('A Units typed INT', prevA.columns[1].type === 'INT');
ok('A Revenue typed FLOAT', prevA.columns[2].type === 'FLOAT');
ok('A Units coerced to number', prevA.rows[0][1] === 10);

// ---------------------------------------------------------------------------
// Fixture B: two-row (multi) header collapse
// ---------------------------------------------------------------------------
const dsB = {
  columns: ['a', 'b', 'c', 'd'],
  rows: [
    ['Sales', 'Sales', 'Region', 'Region'],   // 0 header top
    ['Q1', 'Q2', 'Name', 'Code'],              // 1 header bottom
    ['100', '200', 'East', 'E1'],
    ['150', '250', 'West', 'W1']
  ]
};
const rB = detect(dsB);
ok('B merge header detected', rB.recipe.steps.some(s => s.op === 'mergeHeaderRows' && s.rowIndices.length === 2));
const prevB = preview(dsB, rB.recipe);
ok('B merged name join', prevB.columns[0].name === 'Sales / Q1');
ok('B distinct col3', prevB.columns[2].name === 'Region / Name');
ok('B data rows kept', prevB.totalRows === 2 && prevB.rows[0][2] === 'East');

// ---------------------------------------------------------------------------
// Fixture C: empty rows + empty columns
// ---------------------------------------------------------------------------
const dsC = {
  columns: ['x', 'y', 'z'],
  rows: [
    ['name', 'unused', 'age'],
    ['alice', null, '30'],
    [null, null, null],
    ['bob', null, '25']
  ]
};
const rC = detect(dsC);
ok('C dropEmptyColumns proposed', rC.recipe.steps.some(s => s.op === 'dropEmptyColumns'));
const prevC = preview(dsC, rC.recipe);
ok('C empty col removed', prevC.columns.length === 2);
ok('C empty row removed', prevC.totalRows === 2);
ok('C age typed INT', prevC.columns[1].type === 'INT' && prevC.rows[0][1] === 30);

// ---------------------------------------------------------------------------
// Type inference unit checks
// ---------------------------------------------------------------------------
ok('infer INT', inferColumnType(['1', '2', '3']).type === 'INT');
ok('infer FLOAT', inferColumnType(['1.5', '2', '3.25']).type === 'FLOAT');
ok('infer DATE', inferColumnType(['2026-01-01', '2026-02-02']).type === 'DATE');
ok('infer BOOL', inferColumnType(['yes', 'no', 'yes']).type === 'BOOL');
ok('infer STR', inferColumnType(['east', 'west', 'north']).type === 'STR');

// ---------------------------------------------------------------------------
// Apply is reversible
// ---------------------------------------------------------------------------
const dsApply = {
  columns: ['col1', 'col2'],
  rows: [
    ['Report', null],
    ['City', 'Pop'],
    ['NYC', '800'],
    ['LA', '400']
  ]
};
const beforeRows = JSON.parse(JSON.stringify(dsApply.rows));
const detA = detect(dsApply);
apply(dsApply, detA.recipe);
ok('apply mutates columns', dsApply.columns[0].name === 'City');
ok('apply typed pop', dsApply.columns[1].type === 'INT' && dsApply.rows[0][1] === 800);
ok('undo restores', undo(dsApply) === true && JSON.stringify(dsApply.rows) === JSON.stringify(beforeRows));

// ---------------------------------------------------------------------------
// Refresh on similar shape
// ---------------------------------------------------------------------------
const dsR1 = {
  columns: ['col1', 'col2'],
  rows: [
    ['Title', null],
    ['Name', 'Score'],
    ['a', '1'],
    ['b', '2']
  ]
};
const detR = detect(dsR1);
const dsR2 = {
  columns: ['col1', 'col2'],
  rows: [
    ['Title', null],
    ['Name', 'Score'],
    ['c', '3'],
    ['d', '4'],
    ['e', '5']
  ]
};
const refreshed = refresh(dsR2, detR.recipe);
ok('refresh applied on same shape', refreshed !== null && dsR2.columns[0].name === 'Name');
ok('refresh row values', dsR2.rows.length === 3 && dsR2.rows[0][1] === 3);

// ---------------------------------------------------------------------------
// Empty dataset does not throw
// ---------------------------------------------------------------------------
const rEmpty = detect({ columns: [], rows: [] });
ok('empty detect no throw', rEmpty && rEmpty.recipe.steps.length === 0);
ok('empty preview no throw', preview({ columns: [], rows: [] }, rEmpty.recipe).rows.length === 0);
ok('apply null recipe safe', JSON.stringify(apply(null, null)) === JSON.stringify({ columns: [], rows: [] }));

console.log('\n' + passed + ' passed, 0 failed');
