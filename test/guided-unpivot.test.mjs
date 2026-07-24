// ============================================================
// DATAGLOW - Guided Unpivot / Reshape engine test suite
// ============================================================
// Pure, no DuckDB, no network. Run: node test/guided-unpivot.test.mjs
import assert from 'assert';
import {
  GUIDED_UNPIVOT_VERSION,
  createEmptyConfig,
  suggestConfig,
  validateConfig,
  quoteIdent,
  buildUnpivotSQL,
  unpivotTransform,
  preview,
  fingerprintColumns,
  serializeConfig,
  parseConfig,
} from '../js/intelligence/guided-unpivot.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed++;
}

console.log('guided-unpivot');

// --- version + empty config -------------------------------------------------
ok('version is 1', GUIDED_UNPIVOT_VERSION === 1);

const empty = createEmptyConfig(['region', 'jan', 'feb']);
ok('empty config default nameColumn attribute', empty.nameColumn === 'attribute');
ok('empty config default valueColumn value', empty.valueColumn === 'value');
ok('empty config remembers columns', empty.allColumns.length === 3);
ok('empty config no unpivot columns', empty.unpivotColumns.length === 0);

// --- quoteIdent (same rules as pivot-builder) -------------------------------
ok('quoteIdent wraps in double quotes', quoteIdent('region') === '"region"');
ok('quoteIdent escapes internal quotes', quoteIdent('a"b') === '"a""b"');
ok('quoteIdent handles spaces', quoteIdent('patient id') === '"patient id"');

// --- suggestConfig heuristic ------------------------------------------------
const sug = suggestConfig(['Region', 'Product', 'Jan', 'Feb', 'Mar']);
ok('suggest picks month columns to unpivot', sug.unpivotColumns.indexOf('Jan') !== -1 &&
  sug.unpivotColumns.indexOf('Feb') !== -1 && sug.unpivotColumns.indexOf('Mar') !== -1);
ok('suggest keeps non-month columns', sug.keepColumns.indexOf('Region') !== -1);
ok('suggest does not unpivot id columns', sug.unpivotColumns.indexOf('Region') === -1);

const sugYear = suggestConfig(['country', '2019', '2020', '2021']);
ok('suggest picks year columns', sugYear.unpivotColumns.length === 3 &&
  sugYear.keepColumns.indexOf('country') !== -1);

const sugNumeric = suggestConfig(['name', 'q1', 'q2'], [['Alice', '10', '20'], ['Bob', '30', '40']]);
ok('suggest uses numeric-tail sample rows', sugNumeric.unpivotColumns.indexOf('q1') !== -1 &&
  sugNumeric.unpivotColumns.indexOf('q2') !== -1);

ok('suggest empty column list is safe', suggestConfig([]).unpivotColumns.length === 0);
ok('suggest never throws on odd input', (function () {
  try { suggestConfig(null); suggestConfig(undefined, null); return true; } catch (_e) { return false; }
})());

// --- validateConfig ---------------------------------------------------------
const names = ['region', 'jan', 'feb', 'mar'];
const goodCfg = {
  keepColumns: ['region'], unpivotColumns: ['jan', 'feb', 'mar'],
  nameColumn: 'month', valueColumn: 'sales',
};
ok('validate good config ok', validateConfig(goodCfg, names).ok === true);

const emptyUnpiv = validateConfig({ keepColumns: ['region'], unpivotColumns: [], nameColumn: 'a', valueColumn: 'b' }, names);
ok('validate empty unpivot list fails', emptyUnpiv.ok === false && emptyUnpiv.errors.length > 0);

const unknownCol = validateConfig({ keepColumns: ['region'], unpivotColumns: ['ghost'], nameColumn: 'a', valueColumn: 'b' }, names);
ok('validate unknown column fails', unknownCol.ok === false);

const overlap = validateConfig({ keepColumns: ['jan'], unpivotColumns: ['jan'], nameColumn: 'a', valueColumn: 'b' }, names);
ok('validate keep/unpivot overlap fails', overlap.ok === false);

const sameNames = validateConfig({ keepColumns: ['region'], unpivotColumns: ['jan'], nameColumn: 'x', valueColumn: 'x' }, names);
ok('validate identical name/value cols fails', sameNames.ok === false);

const badValueAs = validateConfig({ keepColumns: [], unpivotColumns: ['jan'], nameColumn: 'a', valueColumn: 'b', valueAs: 'DATE' }, names);
ok('validate bad valueAs fails', badValueAs.ok === false);

// --- unpivotTransform: shape + values + order -------------------------------
const wide = {
  columns: [
    { name: 'region', type: 'STR' },
    { name: 'jan', type: 'INT' },
    { name: 'feb', type: 'INT' },
    { name: 'mar', type: 'INT' },
  ],
  rows: [
    ['East', 10, 11, 12],
    ['West', 20, 21, 22],
  ],
};
const cfg = {
  keepColumns: ['region'], unpivotColumns: ['jan', 'feb', 'mar'],
  nameColumn: 'month', valueColumn: 'sales',
};
const t = unpivotTransform(wide, cfg);
ok('transform ok', t.ok === true);
ok('transform output columns are keep + name + value', t.columns.length === 3 &&
  t.columns[0].name === 'region' && t.columns[1].name === 'month' && t.columns[2].name === 'sales');
ok('transform row count = inputRows * unpivotCols', t.rows.length === 2 * 3);
ok('transform first row keep value carried', t.rows[0][0] === 'East');
ok('transform first row name = first unpivot col', t.rows[0][1] === 'jan');
ok('transform first row value carried', t.rows[0][2] === 10);
ok('transform preserves row order (row 0 before row 1)', t.rows[3][0] === 'West' && t.rows[3][1] === 'jan');
ok('transform keep column type preserved', t.columns[0].type === 'STR');
ok('transform value type inferred INT from numeric sources', t.columns[2].type === 'INT');
ok('transform name column is STR', t.columns[1].type === 'STR');

// keep column type preservation with a DATE id column
const wideDate = {
  columns: [{ name: 'day', type: 'DATE' }, { name: 'a', type: 'FLOAT' }, { name: 'b', type: 'FLOAT' }],
  rows: [['2020-01-01', 1.5, 2.5]],
};
const tDate = unpivotTransform(wideDate, { keepColumns: ['day'], unpivotColumns: ['a', 'b'], nameColumn: 'attribute', valueColumn: 'value' });
ok('transform preserves DATE keep type', tDate.columns[0].type === 'DATE');
ok('transform infers FLOAT value type', tDate.columns[2].type === 'FLOAT');

// empty unpivot -> error, no throw
const tErr = unpivotTransform(wide, { keepColumns: ['region'], unpivotColumns: [], nameColumn: 'a', valueColumn: 'b' });
ok('transform empty unpivot returns error (no throw)', tErr.ok === false && typeof tErr.error === 'string');

// valueAs coercion hint
const wideStr = {
  columns: [{ name: 'id', type: 'STR' }, { name: 'x', type: 'STR' }, { name: 'y', type: 'STR' }],
  rows: [['a', '1,000', '2.5']],
};
const tCoerce = unpivotTransform(wideStr, { keepColumns: ['id'], unpivotColumns: ['x', 'y'], nameColumn: 'k', valueColumn: 'v', valueAs: 'FLOAT' });
ok('transform valueAs=FLOAT coerces "1,000" to 1000', tCoerce.rows[0][2] === 1000);
ok('transform valueAs=FLOAT sets value column type', tCoerce.columns[2].type === 'FLOAT');

// no keep columns -> just name + value
const tNoKeep = unpivotTransform(wide, { keepColumns: [], unpivotColumns: ['jan', 'feb'], nameColumn: 'k', valueColumn: 'v' });
ok('transform no-keep yields 2 columns', tNoKeep.columns.length === 2);
ok('transform no-keep row count correct', tNoKeep.rows.length === 2 * 2);

// dropNullValues option
const wideNull = {
  columns: [{ name: 'id', type: 'STR' }, { name: 'a', type: 'INT' }, { name: 'b', type: 'INT' }],
  rows: [['x', 5, null]],
};
const tDrop = unpivotTransform(wideNull, { keepColumns: ['id'], unpivotColumns: ['a', 'b'], nameColumn: 'k', valueColumn: 'v', dropNullValues: true });
ok('transform dropNullValues drops blank value rows', tDrop.rows.length === 1 && tDrop.rows[0][1] === 'a');

// --- preview ----------------------------------------------------------------
const bigRows = [];
for (let i = 0; i < 50; i++) bigRows.push(['R' + i, i, i + 1, i + 2]);
const bigWide = { columns: wide.columns, rows: bigRows };
const p = preview(bigWide, cfg, { maxRows: 20 });
ok('preview ok', p.ok === true);
ok('preview respects maxRows', p.rows.length === 20);
ok('preview outputRowEstimate = inputRows * unpivotCols', p.outputRowEstimate === 50 * 3);
ok('preview reports inputRow count', p.inputRow === 50);
ok('preview totalRows is full output', p.totalRows === 150);
const pErr = preview(wide, { keepColumns: [], unpivotColumns: [], nameColumn: 'a', valueColumn: 'b' });
ok('preview error path is safe', pErr.ok === false && typeof pErr.error === 'string');

// --- buildUnpivotSQL --------------------------------------------------------
const sqlRes = buildUnpivotSQL(cfg, quoteIdent('sales_wide'));
ok('buildUnpivotSQL ok', sqlRes.ok === true);
ok('SQL contains UNPIVOT keyword', /UNPIVOT/.test(sqlRes.sql));
ok('SQL contains INTO NAME ... VALUE', /INTO NAME "month" VALUE "sales"/.test(sqlRes.sql));
ok('SQL quotes unpivot idents', /ON "jan", "feb", "mar"/.test(sqlRes.sql));
ok('SQL quotes source relation', /"sales_wide"/.test(sqlRes.sql));
ok('SQL projects keep column', /SELECT "region"/.test(sqlRes.sql));
const sqlNoKeep = buildUnpivotSQL({ keepColumns: [], unpivotColumns: ['jan'], nameColumn: 'a', valueColumn: 'b' }, 'src');
ok('buildUnpivotSQL no-keep still ok + has UNPIVOT', sqlNoKeep.ok === true && /UNPIVOT/.test(sqlNoKeep.sql));
const sqlErr = buildUnpivotSQL({ keepColumns: [], unpivotColumns: [], nameColumn: 'a', valueColumn: 'b' }, 'src');
ok('buildUnpivotSQL empty unpivot fails cleanly', sqlErr.ok === false && Array.isArray(sqlErr.errors));

// --- fingerprint + serialize/parse ------------------------------------------
ok('fingerprintColumns stable', fingerprintColumns(['a', 'b']) === fingerprintColumns(['a', 'b']));
ok('fingerprintColumns differs on change', fingerprintColumns(['a', 'b']) !== fingerprintColumns(['a', 'c']));

const round = parseConfig(serializeConfig(cfg));
ok('serialize/parse round-trips keepColumns', round.ok === true && round.config.keepColumns[0] === 'region');
ok('serialize/parse round-trips unpivotColumns', round.config.unpivotColumns.length === 3);
ok('serialize/parse round-trips nameColumn', round.config.nameColumn === 'month');
ok('parseConfig bad JSON is safe', parseConfig('{not json').ok === false);

console.log('\n' + passed + ' passed');
assert(passed >= 25, 'expected at least 25 assertions, got ' + passed);
console.log('guided-unpivot: all ' + passed + ' assertions passed');
