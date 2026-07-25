// ============================================================
// DATAGLOW - Bundle 7 shape and clean transforms test suite
// ============================================================
// Pure, no DuckDB, no network, no DOM.
// Run: node test/shape-clean-transforms.test.mjs
//
// Written around the way each transform could be quietly wrong rather than
// around its happy path, because each of the six has one failure mode that
// produces a table nobody questions:
//   A16 a cyclic edge list that hangs, or an orphan reported as a root
//   A17 a 40x row explosion applied before anyone saw the number
//   A25 a filled value that cannot be told from a measured one
//   A26 an open-ended range silently run to "today", so the answer moves
//   A27 nine empty bands and one holding 99% of the rows
//   A29 a de-duplication that deleted rows which were not duplicates
import assert from 'assert';

import {
  sortableOrderValue,
  compareSortable,
  compareValues,
  readList,
} from '../js/transforms/transform-core.js';

import {
  MAX_DEPTH,
  createEmptyHierarchyConfig,
  suggestHierarchyConfig,
  validateHierarchyConfig,
  hierarchyOutputColumns,
  buildHierarchySQL,
  expandHierarchyTransform,
  describeHierarchy,
} from '../js/transforms/expand-hierarchy.js';

import {
  EXPLOSION_WARN_ROWS,
  createEmptyNestedConfig,
  suggestNestedConfig,
  validateNestedConfig,
  elementColumnName,
  previewNestedToRows,
  buildNestedToRowsSQL,
  nestedToRowsTransform,
  describeNestedToRows,
} from '../js/transforms/nested-to-rows.js';

import {
  FILL_MODES,
  FILLED_SUFFIX,
  createEmptyFillConfig,
  suggestFillConfig,
  validateFillConfig,
  flagColumnFor,
  buildFillMissingSQL,
  fillMissingTransform,
  describeFillMissing,
} from '../js/transforms/fill-missing.js';

import {
  MAX_DAILY_ROWS,
  DAILY_WARN_ROWS_NARROW,
  createEmptyDateRangeConfig,
  suggestDateRangeConfig,
  validateDateRangeConfig,
  dayColumnName,
  previewExpandDateRange,
  buildExpandDateRangeSQL,
  expandDateRangeTransform,
  describeExpandDateRange,
} from '../js/transforms/expand-date-range.js';

import {
  MAX_BINS,
  createEmptyBinConfig,
  suggestBinConfig,
  validateBinConfig,
  normalizeEdges,
  numericExtent,
  resolveBins,
  binLabels,
  binIndexOf,
  binCounts,
  buildBinSQL,
  binColumnTransform,
  describeBinColumn,
} from '../js/transforms/bin-editor.js';

import {
  createEmptyKeepConfig,
  suggestKeepConfig,
  validateKeepConfig,
  comparableColumns,
  buildKeepMostRecentSQL,
  keepMostRecentTransform,
  describeKeepMostRecent,
} from '../js/transforms/keep-most-recent.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed++;
}

function ds(name, cols, rows) {
  return { name: name, columns: cols, rows: rows };
}
function col(n, t) { return { name: n, type: t }; }

/** The value of an output column by name, for one row. */
function valueAt(res, row, colName) {
  const i = res.columns.findIndex((c) => c.name === colName);
  return i === -1 ? undefined : row[i];
}
function rowWhere(res, colName, value) {
  return res.rows.find((r) => valueAt(res, r, colName) === value);
}

/* ==========================================================================
   Shared core: the comparators A20 and A29 both read
   ========================================================================== */
console.log('\nshared ordering core');

ok('an empty order value cannot take part', sortableOrderValue('', false) === null);
ok('a null order value cannot take part', sortableOrderValue(null, true) === null);
ok('a declared date column parses ISO to a UTC day',
  sortableOrderValue('2024-03-05', true).v === Date.UTC(2024, 2, 5));
ok('a date with a time attached compares as the day it names',
  sortableOrderValue('2024-03-05T22:14:00Z', true).v === Date.UTC(2024, 2, 5));
ok('an unreadable value in a declared date column is out, not string-sorted',
  sortableOrderValue('later', true) === null);
ok('9 orders before 10 as a number, not as a string',
  compareSortable(sortableOrderValue('9', false), sortableOrderValue('10', false)) < 0);
ok('text orders as text', compareSortable(sortableOrderValue('a', false),
  sortableOrderValue('b', false)) < 0);
ok('a blank cell loses the tie-break to a real value', compareValues('', 'x') > 0);
ok('two blanks tie', compareValues(null, '') === 0);
ok('the tie-break compares numbers as numbers', compareValues('9', '10') < 0);

/* ==========================================================================
   A16 Expand hierarchy
   ========================================================================== */
console.log('\nA16 expand hierarchy');

const orgCols = [col('id', 'STR'), col('parent_id', 'STR'), col('name', 'STR')];
const org = ds('org', orgCols, [
  ['1', null, 'Chief'],
  ['2', '1', 'Ops'],
  ['3', '1', 'Eng'],
  ['4', '2', 'Depot'],
  ['9', '99', 'Adrift'],
]);
const edgeCfg = Object.assign(createEmptyHierarchyConfig(), {
  source: 'edges', nodeColumn: 'id', parentColumn: 'parent_id',
});

const a16 = expandHierarchyTransform(org, edgeCfg);
ok('A16 runs on an edge list', a16.ok === true);
ok('A16 keeps every row', a16.stats.rowsOut === 5);
ok('A16 appends the documented columns',
  hierarchyOutputColumns(edgeCfg).map((c) => c.name).join(',')
    === 'depth,parent_node,root_node,node_path,is_leaf,in_cycle');
ok('A16 row width matches its columns',
  a16.rows.every((r) => r.length === a16.columns.length));
ok('A16 gives the top row depth 0', valueAt(a16, rowWhere(a16, 'id', '1'), 'depth') === 0);
ok('A16 gives a child depth 1', valueAt(a16, rowWhere(a16, 'id', '2'), 'depth') === 1);
ok('A16 gives a grandchild depth 2', valueAt(a16, rowWhere(a16, 'id', '4'), 'depth') === 2);
ok('A16 reports the deepest branch', a16.stats.maxDepth === 2);
ok('A16 builds the full path',
  valueAt(a16, rowWhere(a16, 'id', '4'), 'node_path') === '1/2/4');
ok('A16 carries the root down the branch',
  valueAt(a16, rowWhere(a16, 'id', '4'), 'root_node') === '1');
ok('A16 marks a childless node as a leaf',
  valueAt(a16, rowWhere(a16, 'id', '3'), 'is_leaf') === true);
ok('A16 does not mark a node with children as a leaf',
  valueAt(a16, rowWhere(a16, 'id', '2'), 'is_leaf') === false);
ok('A16 counts leaves', a16.stats.leaves === 3);
ok('A16 counts exactly one root', a16.stats.roots === 1);
ok('A16 does not count an orphan as a root', a16.stats.orphans === 1);
ok('A16 places an orphan at depth 0 so the table stays usable',
  valueAt(a16, rowWhere(a16, 'id', '9'), 'depth') === 0);
ok('A16 says an orphan is a gap, not the top of the tree',
  a16.notes.some((n) => n.includes('not roots')));
ok('A16 keeps the raw parent value on the row',
  valueAt(a16, rowWhere(a16, 'id', '9'), 'parent_node') === '99');
ok('A16 nothing is marked as looping in a clean tree',
  a16.rows.every((r) => valueAt(a16, r, 'in_cycle') === false));

const selfLoop = ds('loop', orgCols, [
  ['1', null, 'Chief'],
  ['5', '6', 'Ping'],
  ['6', '5', 'Pong'],
]);
const a16loop = expandHierarchyTransform(selfLoop, edgeCfg);
ok('A16 terminates on a closed loop rather than running forever', a16loop.ok === true);
ok('A16 emits the looped rows instead of dropping them', a16loop.stats.rowsOut === 3);
ok('A16 counts the looped rows', a16loop.stats.cycleNodes === 2);
ok('A16 marks looped rows in the in_cycle column',
  valueAt(a16loop, rowWhere(a16loop, 'id', '5'), 'in_cycle') === true);
ok('A16 gives a looped row no depth rather than a made-up one',
  valueAt(a16loop, rowWhere(a16loop, 'id', '5'), 'depth') === null);
ok('A16 says a loop is a defect in the parent column',
  a16loop.notes.some((n) => n.includes('loop')));
ok('A16 headline names the loop', describeHierarchy(a16loop).includes('loop'));

const selfParent = ds('self', orgCols, [['1', '1', 'Ouroboros']]);
const a16self = expandHierarchyTransform(selfParent, edgeCfg);
ok('A16 survives a row that is its own parent', a16self.ok === true);
ok('A16 reports a self-parent as a loop, not as a root', a16self.stats.cycleNodes === 1);

const dupes = ds('dupes', orgCols, [
  ['1', null, 'Chief'],
  ['2', '1', 'Ops'],
  ['2', '1', 'Ops again'],
]);
const a16dupes = expandHierarchyTransform(dupes, edgeCfg);
ok('A16 counts a repeated id rather than building two subtrees',
  a16dupes.stats.duplicateNodes === 1);
ok('A16 says which tree a repeated id describes cannot be known',
  a16dupes.notes.some((n) => n.includes('cannot say which is meant')));

const looped = expandHierarchyTransform(ds('branchloop', orgCols, [
  ['1', null, 'Chief'],
  ['2', '1', 'Ops'],
  ['3', '2', 'Depot'],
  ['2b', '3', 'Ops copy'],
]), edgeCfg);
ok('A16 still reports is_leaf from the edge list, not from where the walk stopped',
  valueAt(looped, rowWhere(looped, 'id', '3'), 'is_leaf') === false);

const pathCfg = Object.assign(createEmptyHierarchyConfig(), {
  source: 'path', pathColumn: 'path', pathDelimiter: '/',
});
const paths = ds('cats', [col('path', 'STR'), col('sku', 'STR')], [
  ['Food', 'a'],
  ['Food/Produce', 'b'],
  ['Food/Produce/Apples', 'c'],
  ['', 'd'],
  ['Food//Produce/', 'e'],
]);
const a16p = expandHierarchyTransform(paths, pathCfg);
ok('A16 reads a path column', a16p.ok === true);
ok('A16 path form keeps every row', a16p.stats.rowsOut === 5);
ok('A16 path form has no parent_node column',
  !a16p.columns.some((c) => c.name === 'parent_node'));
ok('A16 counts separators as depth', valueAt(a16p, a16p.rows[2], 'depth') === 2);
ok('A16 path form finds the root', valueAt(a16p, a16p.rows[2], 'root_node') === 'Food');
ok('A16 treats a blank path as having no depth', valueAt(a16p, a16p.rows[3], 'depth') === null);
ok('A16 says blank paths are kept, not moved to the root',
  a16p.notes.some((n) => n.includes('blank path')));
ok('A16 does not count an empty segment as a level',
  valueAt(a16p, a16p.rows[4], 'depth') === 1);
ok('A16 does not count a trailing separator as a level',
  valueAt(a16p, a16p.rows[4], 'node_path') === 'Food/Produce');
ok('A16 marks a path with no children as a leaf',
  valueAt(a16p, a16p.rows[2], 'is_leaf') === true);
ok('A16 does not mark a path other rows sit under as a leaf',
  valueAt(a16p, a16p.rows[0], 'is_leaf') === false);

const impliedOnly = expandHierarchyTransform(
  ds('implied', [col('path', 'STR')], [['a/b/c']]), pathCfg);
ok('A16 warns when a level exists only inside another row\'s path',
  impliedOnly.notes.some((n) => n.includes('no row of their own')));

const a16sql = buildHierarchySQL(edgeCfg, 'org');
ok('A16 SQL builds', a16sql.ok === true);
ok('A16 SQL is a recursive CTE', a16sql.sql.includes('WITH RECURSIVE'));
ok('A16 SQL shows the cycle guard rather than assuming it',
  a16sql.sql.includes('NOT list_contains'));
ok('A16 SQL bounds the depth', a16sql.sql.includes(String(MAX_DEPTH)));
ok('A16 SQL seeds on a missing parent as well as a null one',
  a16sql.sql.includes('NOT EXISTS'));
ok('A16 SQL says an orphan is not a root', a16sql.sql.includes('NOT the same thing as a'));
ok('A16 SQL derives is_leaf from the edge list', a16sql.sql.includes('AS is_leaf'));
ok('A16 path SQL splits on the delimiter',
  buildHierarchySQL(pathCfg, 'cats').sql.includes('str_split'));

ok('A16 refuses a config with no columns',
  validateHierarchyConfig(createEmptyHierarchyConfig(), ['id']).ok === false);
ok('A16 refuses a node column that is not in the table',
  validateHierarchyConfig({ source: 'edges', nodeColumn: 'nope', parentColumn: 'parent_id' },
    ['id', 'parent_id']).errors.join(' ').includes('not in this table'));
ok('A16 refuses the same column as node and parent',
  validateHierarchyConfig({ source: 'edges', nodeColumn: 'id', parentColumn: 'id' }, ['id'])
    .errors.join(' ').includes('have to be different'));
ok('A16 refuses an unknown source',
  validateHierarchyConfig({ source: 'guess' }, ['id']).ok === false);
ok('A16 suggests the parent column when one is named',
  suggestHierarchyConfig(org).parentColumn === 'parent_id');
ok('A16 suggests edge form over path form when both look possible',
  suggestHierarchyConfig(org).source === 'edges');
ok('A16 suggests path form when there is no parent column',
  suggestHierarchyConfig(paths).source === 'path');
ok('A16 errors without a table', expandHierarchyTransform(null, edgeCfg).ok === false);
ok('A16 headline on an empty table says so',
  describeHierarchy(expandHierarchyTransform(ds('e', orgCols, []), edgeCfg))
    .includes('no rows'));

/* ==========================================================================
   A17 Nested to rows
   ========================================================================== */
console.log('\nA17 nested to rows');

ok('A17 reads a real array', readList(['a', 'b'], 'auto', ',').kind === 'array');
ok('A17 reads a JSON array from text', readList('[1, 2, 3]', 'auto', ',').values.length === 3);
ok('A17 tries JSON before the delimiter, so [1, 2] is not split into [1 and 2]',
  readList('[1, 2]', 'auto', ',').values[0] === 1);
ok('A17 reads a delimited string', readList('a,b,c', 'auto', ',').values.length === 3);
ok('A17 treats a blank cell as an empty list', readList('', 'auto', ',').kind === 'empty');
ok('A17 treats a lone value as a scalar, not a one-element list by assumption',
  readList('solo', 'auto', ',').kind === 'scalar');
ok('A17 does not widen an object', readList({ a: 1 }, 'auto', ',').kind === 'scalar');
ok('A17 in JSON mode refuses to split broken JSON on a comma',
  readList('[1, 2', 'json', ',').kind === 'unreadable');
ok('A17 in auto mode falls back to the delimiter for broken JSON',
  readList('[1, 2', 'auto', ',').kind === 'delimited');
ok('A17 in JSON mode rejects a plain delimited string',
  readList('a,b', 'json', ',').kind === 'unreadable');
ok('A17 honours a non-comma delimiter', readList('a|b|c', 'delimited', '|').values.length === 3);

const orders = ds('orders', [col('order_id', 'STR'), col('items', 'STR'), col('total', 'INT')], [
  ['o1', '["nut","bolt","washer"]', 30],
  ['o2', 'screw', 5],
  ['o3', '', 0],
  ['o4', 'a,b', 12],
]);
const nestedCfg = Object.assign(createEmptyNestedConfig(), {
  listColumn: 'items', source: 'auto', delimiter: ',',
});

const a17pre = previewNestedToRows(orders, nestedCfg);
ok('A17 preview runs', a17pre.ok === true);
ok('A17 preview counts the output rows without building them', a17pre.rowsOut === 7);
ok('A17 preview reports the multiplier', a17pre.ratio === 7 / 4);
ok('A17 preview says the table will grow', a17pre.willGrow === true);
ok('A17 preview counts the rows that held a real list', a17pre.listRows === 2);
ok('A17 preview counts the scalars', a17pre.scalarRows === 1);
ok('A17 preview counts the empties', a17pre.emptyRows === 1);
ok('A17 preview reports the largest single list', a17pre.largestList === 3);

const a17 = nestedToRowsTransform(orders, nestedCfg);
ok('A17 runs', a17.ok === true);
ok('A17 apply produces exactly what the preview promised', a17.stats.rowsOut === a17pre.rowsOut);
ok('A17 row width matches its columns',
  a17.rows.every((r) => r.length === a17.columns.length));
ok('A17 names the element column from the source column',
  a17.columns[a17.columns.length - 2].name === 'items_item');
ok('A17 adds a position column', a17.columns[a17.columns.length - 1].name === 'items_item_index');
ok('A17 numbers the elements from 1', a17.rows[0][a17.rows[0].length - 1] === 1);
ok('A17 gives each element its own row', a17.rows[2][a17.rows[2].length - 2] === 'washer');
ok('A17 repeats the other columns on each new row',
  a17.rows[0][0] === 'o1' && a17.rows[1][0] === 'o1' && a17.rows[2][0] === 'o1');
ok('A17 keeps a row whose list was empty rather than dropping it silently',
  a17.rows.some((r) => r[0] === 'o3'));
ok('A17 leaves the element blank on an empty list',
  a17.rows.find((r) => r[0] === 'o3')[a17.columns.length - 2] === null);
ok('A17 says plain UNNEST would have dropped those rows',
  a17.notes.some((n) => n.includes('UNNEST would have dropped')));
ok('A17 warns that every existing total over this table changes',
  a17.notes.some((n) => n.includes('will be too big')));
ok('A17 says how many rows were single values',
  a17.notes.some((n) => n.includes('single value')));
ok('A17 headline leads with the row count',
  describeNestedToRows(a17).startsWith('4 rows become 7'));

const dropped = nestedToRowsTransform(orders,
  Object.assign({}, nestedCfg, { emptyHandling: 'drop' }));
ok('A17 can drop empty rows when asked', dropped.stats.rowsOut === 6);
ok('A17 preview agrees when empties are dropped',
  previewNestedToRows(orders, Object.assign({}, nestedCfg, { emptyHandling: 'drop' })).rowsOut === 6);
ok('A17 says the empty rows were dropped as configured',
  dropped.notes.some((n) => n.includes('as configured')));

const noIndex = nestedToRowsTransform(orders,
  Object.assign({}, nestedCfg, { includeIndex: false }));
ok('A17 can leave out the position column',
  !noIndex.columns.some((c) => c.name === 'items_item_index'));

const trimmed = nestedToRowsTransform(
  ds('t', [col('tags', 'STR')], [[' a , b ']]), { listColumn: 'tags', source: 'auto', delimiter: ',' });
ok('A17 trims elements by default', trimmed.rows[0][1] === 'a');
const untrimmed = nestedToRowsTransform(
  ds('t', [col('tags', 'STR')], [[' a , b ']]),
  { listColumn: 'tags', source: 'auto', delimiter: ',', trimElements: false });
ok('A17 can leave whitespace inside the list alone', untrimmed.rows[0][1] === 'a ');
ok('A17 trimming off still keeps the second element intact',
  untrimmed.rows[1][1] === ' b');

const flat = ds('flat', [col('name', 'STR')], [['alpha'], ['beta']]);
ok('A17 warns when nothing in the column looks like a list',
  previewNestedToRows(flat, { listColumn: 'name', source: 'auto', delimiter: ',' })
    .warnings.some((w) => w.includes('No row')));
ok('A17 headline says so when the row count does not change',
  describeNestedToRows(nestedToRowsTransform(flat,
    { listColumn: 'name', source: 'auto', delimiter: ',' })).includes('does not change'));

const bigRow = [];
for (let i = 0; i < 600; i += 1) bigRow.push('w' + i);
const wordy = ds('wordy', [col('sentence', 'STR')], [[bigRow.join(' ')]]);
ok('A17 warns when one cell alone produces hundreds of elements',
  previewNestedToRows(wordy, { listColumn: 'sentence', source: 'delimited', delimiter: ' ' })
    .warnings.some((w) => w.includes('separator is wrong')));

const hugeRows = [];
for (let i = 0; i < 400; i += 1) hugeRows.push(['x'.repeat(1) + i, new Array(300).fill('e').join(',')]);
const hugePre = previewNestedToRows(
  ds('huge', [col('id', 'STR'), col('list', 'STR')], hugeRows),
  { listColumn: 'list', source: 'delimited', delimiter: ',' });
ok('A17 preview computes a large count without building the rows',
  hugePre.rowsOut === 400 * 300);
ok('A17 warns above the explosion threshold when it is crossed',
  hugePre.rowsOut > EXPLOSION_WARN_ROWS && hugePre.warnings.length > 0);

const a17sql = buildNestedToRowsSQL(nestedCfg, 'orders');
ok('A17 SQL builds', a17sql.ok === true);
ok('A17 SQL uses UNNEST', a17sql.sql.includes('UNNEST('));
ok('A17 SQL says every other column is repeated', a17sql.sql.includes('repeated on each new row'));
ok('A17 SQL offers the left join form that keeps empty rows',
  a17sql.sql.includes('LEFT JOIN LATERAL'));
ok('A17 SQL filters out empties when configured to drop them',
  buildNestedToRowsSQL(Object.assign({}, nestedCfg, { emptyHandling: 'drop' }), 'orders')
    .sql.includes('WHERE len('));
ok('A17 SQL uses from_json in JSON mode',
  buildNestedToRowsSQL(Object.assign({}, nestedCfg, { source: 'json' }), 'orders')
    .sql.includes('from_json'));
ok('A17 SQL uses str_split in delimited mode',
  buildNestedToRowsSQL(Object.assign({}, nestedCfg, { source: 'delimited' }), 'orders')
    .sql.includes('str_split'));

ok('A17 refuses a missing list column',
  validateNestedConfig({ listColumn: '' }, ['items']).ok === false);
ok('A17 refuses a list column that is not in the table',
  validateNestedConfig({ listColumn: 'nope' }, ['items']).ok === false);
ok('A17 names the element column from the config when given',
  elementColumnName({ listColumn: 'items', elementColumn: 'thing' }) === 'thing');
ok('A17 suggests the column that actually looks like a list',
  suggestNestedConfig(orders).listColumn === 'items');
ok('A17 preview errors without a table', previewNestedToRows(null, nestedCfg).ok === false);

/* ==========================================================================
   A25 Fill missing, always flagged
   ========================================================================== */
console.log('\nA25 fill missing and flag');

const readings = ds('readings', [col('sensor', 'STR'), col('ts', 'DATE'), col('value', 'INT')], [
  ['a', '2024-01-01', 10],
  ['a', '2024-01-02', null],
  ['a', '2024-01-03', 12],
  ['b', '2024-01-01', null],
  ['b', '2024-01-02', 7],
  ['b', '2024-01-03', null],
]);
const fwdCfg = Object.assign(createEmptyFillConfig(), {
  targetColumns: ['value'], mode: 'forward', orderColumn: 'ts', groupColumns: ['sensor'],
});

const a25 = fillMissingTransform(readings, fwdCfg);
ok('A25 runs a forward fill', a25.ok === true);
ok('A25 does not change the row count', a25.stats.rowsOut === 6);
ok('A25 row width matches its columns', a25.rows.every((r) => r.length === a25.columns.length));
ok('A25 adds the flag column and does not make it optional',
  a25.columns.some((c) => c.name === 'value' + FILLED_SUFFIX));
ok('A25 names the flag column by the fixed convention', flagColumnFor('value') === 'value_was_filled');
ok('A25 types the flag column as a boolean',
  a25.columns.find((c) => c.name === 'value_was_filled').type === 'BOOL');
ok('A25 puts the flag column at the end so the original order is untouched',
  a25.columns[a25.columns.length - 1].name === 'value_was_filled');
ok('A25 carries the last value down',
  valueAt(a25, a25.rows.find((r) => r[0] === 'a' && r[1] === '2024-01-02'), 'value') === 10);
ok('A25 flags the value it invented',
  valueAt(a25, a25.rows.find((r) => r[0] === 'a' && r[1] === '2024-01-02'),
    'value_was_filled') === true);
ok('A25 does not flag a measured value',
  valueAt(a25, a25.rows.find((r) => r[0] === 'a' && r[1] === '2024-01-01'),
    'value_was_filled') === false);
ok('A25 does not carry a value across a group boundary',
  valueAt(a25, a25.rows.find((r) => r[0] === 'b' && r[1] === '2024-01-01'), 'value') === null);
ok('A25 leaves a blank with nothing before it blank', a25.stats.stillBlank === 1);
ok('A25 counts what it filled', a25.stats.filled === 2);
ok('A25 counts the blanks it started with', a25.stats.blankBefore === 3);
ok('A25 reports per column', a25.stats.perColumn[0].column === 'value');
ok('A25 warns that the flag column has to travel with the data',
  a25.notes.some((n) => n.includes('no way to tell a filled value from a measured one')));
ok('A25 warns that forward fill is wrong for an independent measurement',
  a25.notes.some((n) => n.includes('previous reading is not what it would have said')));
ok('A25 points at the existing wizard rather than offering a second group mean',
  a25.notes.some((n) => n.includes('Grouped Imputation Wizard')));
ok('A25 says the wizard does not flag its fills',
  a25.notes.some((n) => n.includes('does not add a flag column')));
ok('A25 headline leads with how many values were invented',
  describeFillMissing(a25).startsWith('2 of 3 blanks were filled'));

const ungrouped = fillMissingTransform(readings,
  Object.assign({}, fwdCfg, { groupColumns: [] }));
ok('A25 warns when no grouping column was chosen',
  ungrouped.notes.some((n) => n.includes('carries across the whole table')));
ok('A25 without grouping carries one entity value onto another',
  ungrouped.stats.filled === 3);

const limited = fillMissingTransform(ds('gap', [col('ts', 'DATE'), col('v', 'INT')], [
  ['2024-01-01', 5],
  ['2024-01-02', null],
  ['2024-01-03', null],
  ['2024-01-04', null],
]), { targetColumns: ['v'], mode: 'forward', orderColumn: 'ts', limit: 2 });
ok('A25 stops carrying at the limit', limited.stats.filled === 2);
ok('A25 leaves the rest blank', limited.stats.stillBlank === 1);
ok('A25 says the limit is why some blanks are still blank',
  limited.notes.some((n) => n.includes('limit of 2')));

const unorderable = fillMissingTransform(ds('bad', [col('ts', 'DATE'), col('v', 'INT')], [
  ['2024-01-01', 5],
  ['', null],
  ['2024-01-03', null],
]), { targetColumns: ['v'], mode: 'forward', orderColumn: 'ts' });
ok('A25 does not fill a row whose order value cannot be read',
  unorderable.stats.unorderable === 1);
ok('A25 says a row with no position has no last value before it',
  unorderable.notes.some((n) => n.includes('no "last value before it"')));
ok('A25 still fills the rows that do have a position', unorderable.stats.filled === 1);

const constFilled = fillMissingTransform(readings, {
  targetColumns: ['value'], mode: 'constant', constantValue: 0,
});
ok('A25 fills with a constant', constFilled.stats.filled === 3);
ok('A25 writes the constant', valueAt(constFilled, constFilled.rows[1], 'value') === 0);
ok('A25 flags every constant fill',
  constFilled.rows.filter((r) => valueAt(constFilled, r, 'value_was_filled') === true).length === 3);
ok('A25 says a fixed value is blunt on purpose',
  constFilled.notes.some((n) => n.includes('blunt on purpose')));

const nothingToFill = fillMissingTransform(
  ds('full', [col('ts', 'DATE'), col('v', 'INT')], [['2024-01-01', 1]]),
  { targetColumns: ['v'], mode: 'forward', orderColumn: 'ts' });
ok('A25 still adds the flag column when there was nothing to fill',
  nothingToFill.columns.some((c) => c.name === 'v_was_filled'));
ok('A25 says so when there were no blanks',
  nothingToFill.notes.some((n) => n.includes('no blanks to fill')));
ok('A25 headline says nothing was invented',
  describeFillMissing(nothingToFill).includes('Nothing was invented'));

ok('A25 offers exactly two modes, both honest', FILL_MODES.length === 2);
ok('A25 refuses to overwrite an existing flag column',
  validateFillConfig({ targetColumns: ['v'], mode: 'constant', constantValue: 1 },
    ['v', 'v_was_filled']).errors.join(' ').includes('already has a column'));
ok('A25 refuses a forward fill with no order column',
  validateFillConfig({ targetColumns: ['v'], mode: 'forward' }, ['v'])
    .errors.join(' ').includes('has no meaning without it'));
ok('A25 refuses a constant fill with no value',
  validateFillConfig({ targetColumns: ['v'], mode: 'constant', constantValue: '' }, ['v'])
    .errors.join(' ').includes('do not fill this column'));
ok('A25 refuses to fill and order on the same column',
  validateFillConfig({ targetColumns: ['ts'], mode: 'forward', orderColumn: 'ts' }, ['ts'])
    .errors.join(' ').includes('cannot also be one of the columns being filled'));
ok('A25 refuses to fill and group on the same column',
  validateFillConfig({ targetColumns: ['g'], mode: 'forward', orderColumn: 'ts', groupColumns: ['g'] },
    ['g', 'ts']).errors.join(' ').includes('both filled and used to group'));
ok('A25 refuses a negative limit',
  validateFillConfig({ targetColumns: ['v'], mode: 'constant', constantValue: 1, limit: -1 }, ['v'])
    .ok === false);
ok('A25 suggests the column that actually has blanks',
  suggestFillConfig(readings).targetColumns[0] === 'value');
ok('A25 suggests a date column for the order',
  suggestFillConfig(readings).orderColumn === 'ts');

const a25sql = buildFillMissingSQL(fwdCfg, 'readings');
ok('A25 SQL builds', a25sql.ok === true);
ok('A25 SQL uses IGNORE NULLS, which is the load-bearing part',
  a25sql.sql.includes('IGNORE NULLS'));
ok('A25 SQL says why IGNORE NULLS matters', a25sql.sql.includes('load-bearing'));
ok('A25 SQL partitions by the group column', a25sql.sql.includes('PARTITION BY "sensor"'));
ok('A25 SQL writes the flag column too, so proof and result agree on the shape',
  a25sql.sql.includes('"value_was_filled"'));
ok('A25 SQL admits the limit is not applied in the SQL',
  buildFillMissingSQL(Object.assign({}, fwdCfg, { limit: 2 }), 'readings')
    .sql.includes('fills further than the preview does'));
ok('A25 constant SQL uses COALESCE',
  buildFillMissingSQL({ targetColumns: ['value'], mode: 'constant', constantValue: 0 }, 'r')
    .sql.includes('COALESCE'));
ok('A25 errors without a table', fillMissingTransform(null, fwdCfg).ok === false);

/* ==========================================================================
   A26 Expand a date range into daily rows
   ========================================================================== */
console.log('\nA26 expand date range to daily rows');

const stays = ds('stays', [col('bed', 'STR'), col('start', 'DATE'), col('end', 'DATE')], [
  ['b1', '2024-01-01', '2024-01-03'],
  ['b2', '2024-01-05', '2024-01-05'],
  ['b3', '2024-01-10', ''],
  ['b4', '2024-01-20', '2024-01-15'],
  ['b5', 'not a date', '2024-01-02'],
]);
const rangeCfg = Object.assign(createEmptyDateRangeConfig(), {
  startColumn: 'start', endColumn: 'end',
});

const a26pre = previewExpandDateRange(stays, rangeCfg);
ok('A26 preview runs', a26pre.ok === true);
ok('A26 preview counts days without building rows', a26pre.rowsOut === 4);
ok('A26 preview counts the expandable rows', a26pre.expandable === 2);
ok('A26 preview counts the open-ended rows', a26pre.openRows === 1);
ok('A26 preview counts the reversed rows', a26pre.reversedRows === 1);
ok('A26 preview counts unreadable start dates', a26pre.unreadableStart === 1);
ok('A26 preview warns that open rows will not expand',
  a26pre.warnings.some((w) => w.includes('no end date')));

const a26 = expandDateRangeTransform(stays, rangeCfg);
ok('A26 runs', a26.ok === true);
ok('A26 apply produces exactly what the preview promised', a26.stats.rowsOut === a26pre.rowsOut);
ok('A26 row width matches its columns', a26.rows.every((r) => r.length === a26.columns.length));
ok('A26 adds a day column', a26.columns.some((c) => c.name === 'day'));
ok('A26 types the day column as a date',
  a26.columns.find((c) => c.name === 'day').type === 'DATE');
ok('A26 adds a day position column', a26.columns.some((c) => c.name === 'day_index'));
ok('A26 counts the end day by default: the 1st to the 3rd is three days',
  a26.rows.filter((r) => r[0] === 'b1').length === 3);
ok('A26 emits consecutive calendar days',
  valueAt(a26, a26.rows[0], 'day') === '2024-01-01'
  && valueAt(a26, a26.rows[1], 'day') === '2024-01-02'
  && valueAt(a26, a26.rows[2], 'day') === '2024-01-03');
ok('A26 numbers the days from 1', valueAt(a26, a26.rows[0], 'day_index') === 1);
ok('A26 expands a same-day range to one day', a26.rows.filter((r) => r[0] === 'b2').length === 1);
ok('A26 repeats the other columns on each day', a26.rows[1][0] === 'b1');
ok('A26 does not expand a reversed range', a26.rows.every((r) => r[0] !== 'b4'));
ok('A26 says a reversed range is a data fault',
  a26.notes.some((n) => n.includes('data fault')));
ok('A26 does not expand an unreadable start date', a26.rows.every((r) => r[0] !== 'b5'));
ok('A26 says an unreadable end is not the same as an open end',
  a26.notes.some((n) => n.includes('not treated as an open')));
ok('A26 refuses to run an open range to today by default',
  a26.rows.every((r) => r[0] !== 'b3'));
ok('A26 says why defaulting to today would be dishonest',
  a26.notes.some((n) => n.includes('different answer every time')));
ok('A26 states which end convention it used',
  a26.notes.some((n) => n.includes('seven') || n.includes('six')));
ok('A26 warns that totals over the table now multiply',
  a26.notes.some((n) => n.includes('multiplied by the length of each range')));
ok('A26 headline leads with the row count',
  describeExpandDateRange(a26).startsWith('5 rows become 4'));

const exclusive = expandDateRangeTransform(stays,
  Object.assign({}, rangeCfg, { endInclusive: false }));
ok('A26 can exclude the end day', exclusive.rows.filter((r) => r[0] === 'b1').length === 2);
ok('A26 with an exclusive end makes a same-day range zero days',
  exclusive.stats.zeroLengthRows === 1);
ok('A26 says a zero-length stay produced no rows',
  exclusive.notes.some((n) => n.includes('zero days')));

const asAt = expandDateRangeTransform(stays,
  Object.assign({}, rangeCfg, { openEnd: 'asAt', asAtDate: '2024-01-12' }));
ok('A26 runs an open range up to a stated date',
  asAt.rows.filter((r) => r[0] === 'b3').length === 3);
ok('A26 counts the open rows it expanded', asAt.stats.openExpanded === 1);
ok('A26 records the as-at date in the notes',
  asAt.notes.some((n) => n.includes('2024-01-12')));
ok('A26 says the answer depends on the as-at date',
  asAt.notes.some((n) => n.includes('these counts change')));

const future = expandDateRangeTransform(
  ds('f', [col('start', 'DATE'), col('end', 'DATE')], [['2024-06-01', '']]),
  Object.assign({}, rangeCfg, { openEnd: 'asAt', asAtDate: '2024-01-01' }));
ok('A26 does not expand an open range that starts after the as-at date',
  future.stats.notYetStarted === 1);
ok('A26 does not call a not-yet-started range reversed', future.stats.reversedRows === 0);

const wideStays = [];
for (let i = 0; i < 100; i += 1) wideStays.push(['e' + i, '2024-01-01', '2024-12-31']);
const wide = ds('wide', [col('id', 'STR'), col('start', 'DATE'), col('end', 'DATE')], wideStays);
const widePre = previewExpandDateRange(wide, rangeCfg);
ok('A26 preview counts a large expansion exactly', widePre.rowsOut === 36600);
ok('A26 warns on a narrow screen at a much lower threshold',
  previewExpandDateRange(wide, rangeCfg, { narrow: true })
    .warnings.some((w) => w.includes('phone-sized')));
ok('A26 narrow warning fires below the desktop threshold',
  widePre.rowsOut > DAILY_WARN_ROWS_NARROW && widePre.warnings.length === 0);

const sentinel = previewExpandDateRange(
  ds('s', [col('start', 'DATE'), col('end', 'DATE')], [['2024-01-01', '9999-12-31']]), rangeCfg);
ok('A26 warns about a placeholder end date',
  sentinel.warnings.some((w) => w.includes('placeholder end date')));

const overCap = {
  name: 'over',
  columns: [col('start', 'DATE'), col('end', 'DATE')],
  rows: [['1000-01-01', '9999-12-31'], ['1000-01-01', '9999-12-31']],
};
ok('A26 preview flags a run over the hard cap',
  previewExpandDateRange(overCap, rangeCfg).overCap === true);
ok('A26 refuses to build over the hard cap rather than dying halfway',
  expandDateRangeTransform(overCap, rangeCfg).ok === false);
ok('A26 says nothing was changed when it refuses',
  expandDateRangeTransform(overCap, rangeCfg).error.includes('Nothing was changed'));
ok('A26 names the cap in the refusal',
  expandDateRangeTransform(overCap, rangeCfg).error.includes(MAX_DAILY_ROWS.toLocaleString()));

const a26sql = buildExpandDateRangeSQL(rangeCfg, 'stays');
ok('A26 SQL builds', a26sql.ok === true);
ok('A26 SQL uses generate_series', a26sql.sql.includes('generate_series'));
ok('A26 SQL steps by one day', a26sql.sql.includes('INTERVAL 1 DAY'));
ok('A26 SQL states the end convention', a26sql.sql.includes('is included'));
ok('A26 SQL says a NULL end produces nothing',
  a26sql.sql.includes('NULL bound returns no rows'));
ok('A26 SQL writes the as-at date as a literal, not current_date',
  buildExpandDateRangeSQL(Object.assign({}, rangeCfg, { openEnd: 'asAt', asAtDate: '2024-01-12' }),
    'stays').sql.includes('2024-01-12'));
ok('A26 SQL never reaches for current_date', !a26sql.sql.includes('current_date'));
ok('A26 SQL shortens the range when the end is excluded',
  buildExpandDateRangeSQL(Object.assign({}, rangeCfg, { endInclusive: false }), 'stays')
    .sql.includes('- INTERVAL 1 DAY'));

ok('A26 refuses the same column as start and end',
  validateDateRangeConfig({ startColumn: 'a', endColumn: 'a' }, ['a'])
    .errors.join(' ').includes('have to be different'));
ok('A26 refuses an as-at mode with no date',
  validateDateRangeConfig({ startColumn: 'start', endColumn: 'end', openEnd: 'asAt' },
    ['start', 'end']).errors.join(' ').includes('change the answer every time'));
ok('A26 refuses an unreadable as-at date',
  validateDateRangeConfig({ startColumn: 'start', endColumn: 'end', openEnd: 'asAt',
    asAtDate: '31/13/2024' }, ['start', 'end']).ok === false);
ok('A26 refuses to overwrite an existing column with the day column',
  validateDateRangeConfig({ startColumn: 'start', endColumn: 'end', dayColumn: 'bed' },
    ['bed', 'start', 'end']).errors.join(' ').includes('already has a column'));
ok('A26 names the day column from the config', dayColumnName({ dayColumn: 'stay_day' }) === 'stay_day');
ok('A26 suggests a start and end pair by name',
  suggestDateRangeConfig(stays).startColumn === 'start'
  && suggestDateRangeConfig(stays).endColumn === 'end');
ok('A26 errors without a table', expandDateRangeTransform(null, rangeCfg).ok === false);
ok('A26 headline on an empty table says so',
  describeExpandDateRange(expandDateRangeTransform(
    ds('e', [col('start', 'DATE'), col('end', 'DATE')], []), rangeCfg)).includes('no rows'));

/* ==========================================================================
   A27 Visual bin editor
   ========================================================================== */
console.log('\nA27 bin editor');

const scores = ds('scores', [col('person', 'STR'), col('score', 'INT')],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n, i) => ['p' + i, n]));
const binCfg = Object.assign(createEmptyBinConfig(), {
  column: 'score', mode: 'equalWidth', binCount: 5,
});

ok('A27 reads the extent of a numeric column', numericExtent(scores, 'score').min === 0);
ok('A27 reads the top of the extent', numericExtent(scores, 'score').max === 10);
ok('A27 counts the readable values', numericExtent(scores, 'score').readable === 11);

const resolved = resolveBins(scores, binCfg);
ok('A27 makes one more edge than bins', resolved.edges.length === 6);
ok('A27 starts the edges at the smallest value', resolved.edges[0] === 0);
ok('A27 sets the top edge to the largest value exactly',
  resolved.edges[resolved.edges.length - 1] === 10);
ok('A27 spaces equal-width edges evenly', resolved.edges[1] === 2);

ok('A27 labels a bin as a range', binLabels([0, 2, 4], 0)[0] === '0 to 2');
ok('A27 puts a value on an edge into the band above it', binIndexOf(2, [0, 2, 4]) === 1);
ok('A27 keeps a value below an edge in the band below', binIndexOf(1.9, [0, 2, 4]) === 0);
ok('A27 closes the top band so the largest value has somewhere to go',
  binIndexOf(4, [0, 2, 4]) === 1);
ok('A27 puts a value below every edge outside the bands', binIndexOf(-1, [0, 2, 4]) === -1);
ok('A27 puts a value above every edge outside the bands', binIndexOf(5, [0, 2, 4]) === -1);
ok('A27 puts an unreadable value outside the bands', binIndexOf('abc', [0, 2, 4]) === -1);

const counted = binCounts(scores, binCfg);
ok('A27 counts every bin', counted.counts.length === 5);
ok('A27 counts add up to the rows in range',
  counted.counts.reduce((a, b) => a + b, 0) === 11);
ok('A27 puts the values in the right bins', counted.counts.join(',') === '2,2,2,2,3');
ok('A27 reports the edges alongside the counts', counted.edges.length === 6);

const skewed = ds('spend', [col('spend', 'FLOAT')],
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000000].map((n) => [n]));
const skewCount = binCounts(skewed, Object.assign({}, binCfg, { column: 'spend', binCount: 10 }));
ok('A27 warns when one band holds almost everything',
  skewCount.warnings.some((w) => w.includes('% of the rows')));
ok('A27 names skew as the reason and points at custom edges',
  skewCount.warnings.some((w) => w.includes('Custom edges')));
ok('A27 warns about empty bands',
  skewCount.warnings.some((w) => w.includes('empty')));

const a27 = binColumnTransform(scores, binCfg);
ok('A27 runs', a27.ok === true);
ok('A27 does not change the row count', a27.stats.rowsOut === 11);
ok('A27 row width matches its columns', a27.rows.every((r) => r.length === a27.columns.length));
ok('A27 adds a band column', a27.columns.some((c) => c.name === 'score_bin'));
ok('A27 adds a band position column', a27.columns.some((c) => c.name === 'score_bin_index'));
ok('A27 keeps the original column by default',
  a27.columns.some((c) => c.name === 'score'));
ok('A27 labels a row with its band', valueAt(a27, a27.rows[0], 'score_bin') === '0 to 2');
ok('A27 numbers the bands from 1', valueAt(a27, a27.rows[0], 'score_bin_index') === 1);
ok('A27 puts the largest value in the top band',
  valueAt(a27, a27.rows[10], 'score_bin_index') === 5);
ok('A27 states the half-open rule in the notes',
  a27.notes.some((n) => n.includes('half-open')));
ok('A27 warns that equal-width edges depend on this table',
  a27.notes.some((n) => n.includes('property of')));
ok('A27 headline says the row count does not change',
  describeBinColumn(a27).includes('row count does not change'));

const dropped27 = binColumnTransform(scores, Object.assign({}, binCfg, { keepOriginal: false }));
ok('A27 can drop the original column',
  !dropped27.columns.some((c) => c.name === 'score'));
ok('A27 keeps every other column when dropping the original',
  dropped27.columns[0].name === 'person');
ok('A27 warns that the exact value cannot be recovered from a band',
  dropped27.notes.some((n) => n.includes('cannot be recovered')));

const custom = binColumnTransform(scores, {
  column: 'score', mode: 'custom', edges: [0, 5, 8], labelColumn: 'band',
});
ok('A27 accepts custom edges', custom.ok === true);
ok('A27 makes one band fewer than edges', custom.stats.bins === 2);
ok('A27 uses the label column name given', custom.columns.some((c) => c.name === 'band'));
ok('A27 leaves an out-of-range value blank rather than in the nearest band',
  valueAt(custom, custom.rows[10], 'band') === null);
ok('A27 counts the out-of-range rows', custom.stats.above === 2);
ok('A27 says an out-of-range value is worth seeing',
  custom.notes.some((n) => n.includes('worth looking at')));
ok('A27 sorts custom edges given out of order',
  normalizeEdges([8, 0, 5]).join(',') === '0,5,8');
ok('A27 accepts custom edges as a typed string', normalizeEdges('0, 5, 8').length === 3);
ok('A27 drops a repeated edge', normalizeEdges([0, 5, 5, 8]).length === 3);
ok('A27 ignores an unreadable edge', normalizeEdges(['0', 'x', '8']).length === 2);

const flatCol = binColumnTransform(ds('same', [col('v', 'INT')], [[5], [5], [5]]),
  Object.assign({}, binCfg, { column: 'v' }));
ok('A27 does not invent nine empty bands when every value is the same',
  flatCol.stats.bins === 1);
ok('A27 still bands the identical values', flatCol.stats.labelled === 3);

const withBlanks = binColumnTransform(
  ds('b', [col('v', 'INT')], [[1], [null], ['x'], [9]]),
  Object.assign({}, binCfg, { column: 'v', binCount: 2 }));
ok('A27 leaves an unreadable value with a blank band', withBlanks.stats.blank === 2);
ok('A27 counts the unreadable values', withBlanks.stats.unreadable === 2);
ok('A27 says why a blank band is not filled in',
  withBlanks.notes.some((n) => n.includes('pulled into the nearest band')));

const a27sql = buildBinSQL(binCfg, 'scores', resolved.edges, 1);
ok('A27 SQL builds', a27sql.ok === true);
ok('A27 SQL is a readable CASE ladder rather than a bucket number',
  a27sql.sql.includes('CASE') && !a27sql.sql.includes('width_bucket'));
ok('A27 SQL states the half-open rule', a27sql.sql.includes('half-open'));
ok('A27 SQL closes the top band', a27sql.sql.includes('<= 10'));
ok('A27 SQL has no catch-all ELSE band', a27sql.sql.includes('ELSE NULL'));
ok('A27 SQL keeps the original column by default', a27sql.sql.includes('  *,'));
ok('A27 SQL excludes the original when configured to drop it',
  buildBinSQL(Object.assign({}, binCfg, { keepOriginal: false }), 'scores', resolved.edges, 1)
    .sql.includes('EXCLUDE'));
ok('A27 SQL refuses to build without edges',
  buildBinSQL({ column: 'score', mode: 'custom', edges: [] }, 'scores').ok === false);

ok('A27 refuses a band count below two',
  validateBinConfig({ column: 'score', mode: 'equalWidth', binCount: 1 }, ['score']).ok === false);
ok('A27 refuses more bands than the maximum',
  validateBinConfig({ column: 'score', mode: 'equalWidth', binCount: MAX_BINS + 1 }, ['score'])
    .ok === false);
ok('A27 refuses a fractional band count',
  validateBinConfig({ column: 'score', mode: 'equalWidth', binCount: 2.5 }, ['score']).ok === false);
ok('A27 refuses custom mode with one edge',
  validateBinConfig({ column: 'score', mode: 'custom', edges: [1] }, ['score'])
    .errors.join(' ').includes('at least two edges'));
ok('A27 refuses to overwrite an existing column',
  validateBinConfig({ column: 'score', mode: 'equalWidth', binCount: 5, labelColumn: 'person' },
    ['person', 'score']).errors.join(' ').includes('already has a column'));
ok('A27 suggests a numeric column with many distinct values',
  suggestBinConfig(scores).column === 'score');
ok('A27 does not suggest a column with almost no distinct values',
  suggestBinConfig(ds('f', [col('flag', 'INT'), col('amt', 'FLOAT')],
    [[0, 1.5], [1, 2.5], [0, 3.5], [1, 4.5], [0, 5.5]])).column === 'amt');
ok('A27 errors without a table', binColumnTransform(null, binCfg).ok === false);
ok('A27 errors when no number can be read',
  binColumnTransform(ds('n', [col('v', 'STR')], [['a'], ['b']]),
    Object.assign({}, binCfg, { column: 'v' })).ok === false);

/* ==========================================================================
   A29 Keep the most recent per group
   ========================================================================== */
console.log('\nA29 keep most recent per group');

const records = ds('records', [col('customer', 'STR'), col('updated', 'DATE'), col('city', 'STR')], [
  ['c1', '2024-01-01', 'Leeds'],
  ['c1', '2024-03-01', 'York'],
  ['c2', '2024-02-01', 'Hull'],
  ['c3', '2024-01-01', 'Ely'],
  ['c3', '2024-01-01', 'Ely'],
]);
const keepCfg = Object.assign(createEmptyKeepConfig(), {
  keyColumns: ['customer'], orderColumn: 'updated',
});

const a29 = keepMostRecentTransform(records, keepCfg);
ok('A29 runs', a29.ok === true);
ok('A29 keeps one row per key', a29.stats.rowsOut === 3);
ok('A29 counts what it removed', a29.stats.removed === 2);
ok('A29 row width matches its columns', a29.rows.every((r) => r.length === a29.columns.length));
ok('A29 keeps the newest row', valueAt(a29, rowWhere(a29, 'customer', 'c1'), 'city') === 'York');
ok('A29 leaves a key with one row alone',
  valueAt(a29, rowWhere(a29, 'customer', 'c2'), 'city') === 'Hull');
ok('A29 adds a column saying how many rows each survivor stands for',
  a29.columns.some((c) => c.name === 'rows_dropped'));
ok('A29 counts the rows behind a survivor',
  valueAt(a29, rowWhere(a29, 'customer', 'c1'), 'rows_dropped') === 1);
ok('A29 reports zero dropped for a sole record',
  valueAt(a29, rowWhere(a29, 'customer', 'c2'), 'rows_dropped') === 0);
ok('A29 does not reorder the table', a29.rows[0][0] === 'c1' && a29.rows[1][0] === 'c2');
ok('A29 says this is a deletion, not a filter',
  a29.notes.some((n) => n.includes('This is a')));
ok('A29 separates rows that disagreed from exact copies',
  a29.stats.conflictedGroups === 1);
ok('A29 names the columns where the discarded rows disagreed',
  a29.stats.conflictColumns.join(',') === 'city');
ok('A29 says those were not duplicates but different records sharing a key',
  a29.notes.some((n) => n.includes('different records sharing a key')));
ok('A29 warns that counts over the table now mean something different',
  a29.notes.some((n) => n.includes('one row per')));
ok('A29 headline leads with what is removed',
  describeKeepMostRecent(a29).includes('removing 2 rows'));
ok('A29 headline names the disagreement',
  describeKeepMostRecent(a29).includes('real values are discarded'));

const exactCopies = keepMostRecentTransform(
  ds('copies', [col('k', 'STR'), col('ts', 'DATE'), col('v', 'INT')], [
    ['a', '2024-01-01', 1],
    ['a', '2024-01-01', 1],
  ]), { keyColumns: ['k'], orderColumn: 'ts' });
ok('A29 removes an exact copy', exactCopies.stats.removed === 1);
ok('A29 does not call an exact copy a conflict', exactCopies.stats.conflictedGroups === 0);
ok('A29 says nothing beyond the duplicate row was lost',
  exactCopies.notes.some((n) => n.includes('nothing beyond the duplicate rows')));
ok('A29 headline says the removed rows matched exactly',
  describeKeepMostRecent(exactCopies).includes('exact match'));

const oldest = keepMostRecentTransform(records, Object.assign({}, keepCfg, { pick: 'oldest' }));
ok('A29 can keep the oldest instead',
  valueAt(oldest, rowWhere(oldest, 'customer', 'c1'), 'city') === 'Leeds');
ok('A29 removes the same number either way', oldest.stats.removed === 2);

const tied = keepMostRecentTransform(
  ds('tied', [col('k', 'STR'), col('ts', 'DATE'), col('v', 'STR')], [
    ['a', '2024-01-01', 'x'],
    ['a', '2024-01-01', 'y'],
  ]), { keyColumns: ['k'], orderColumn: 'ts' });
ok('A29 counts the tied groups', tied.stats.tiedGroups === 1);
ok('A29 admits the tie-break is arbitrary even though it is repeatable',
  tied.notes.some((n) => n.includes('no rule recovers which one is current')));
const tiedAgain = keepMostRecentTransform(
  ds('tied', [col('k', 'STR'), col('ts', 'DATE'), col('v', 'STR')], [
    ['a', '2024-01-01', 'y'],
    ['a', '2024-01-01', 'x'],
  ]), { keyColumns: ['k'], orderColumn: 'ts' });
ok('A29 returns the same row whichever order the tied rows arrive in',
  tied.rows[0][2] === tiedAgain.rows[0][2]);

const undated = ds('undated', [col('k', 'STR'), col('ts', 'DATE'), col('v', 'INT')], [
  ['a', '', 1],
  ['a', '2024-01-01', 2],
  ['b', '', 3],
]);
const keptUndated = keepMostRecentTransform(undated, { keyColumns: ['k'], orderColumn: 'ts' });
ok('A29 counts the rows with no readable date', keptUndated.stats.undatedRows === 2);
ok('A29 never lets an undated row beat a dated one',
  valueAt(keptUndated, rowWhere(keptUndated, 'k', 'a'), 'v') === 2);
ok('A29 does not delete an entity whose every row is undated',
  keptUndated.rows.some((r) => r[0] === 'b'));
ok('A29 says an undated row cannot be the most recent',
  keptUndated.notes.some((n) => n.includes('cannot be the newest record')));

const droppedUndated = keepMostRecentTransform(undated,
  { keyColumns: ['k'], orderColumn: 'ts', undated: 'drop' });
ok('A29 can drop undated rows when told to', droppedUndated.stats.droppedUndated === 2);
ok('A29 loses the all-undated entity when dropping is chosen',
  droppedUndated.rows.every((r) => r[0] !== 'b'));
ok('A29 warns that dropping on an unreadable date deletes data',
  droppedUndated.notes.some((n) => n.includes('mistyped')));

const multiKey = keepMostRecentTransform(
  ds('mk', [col('site', 'STR'), col('bay', 'STR'), col('ts', 'DATE'), col('v', 'INT')], [
    ['s1', 'b1', '2024-01-01', 1],
    ['s1', 'b1', '2024-02-01', 2],
    ['s1', 'b2', '2024-01-01', 3],
    ['s2', 'b1', '2024-01-01', 4],
  ]), { keyColumns: ['site', 'bay'], orderColumn: 'ts' });
ok('A29 groups on a composite key', multiKey.stats.rowsOut === 3);
ok('A29 removes only within a key', multiKey.stats.removed === 1);

const nothingRemoved = keepMostRecentTransform(
  ds('u', [col('k', 'STR'), col('ts', 'DATE')], [['a', '2024-01-01'], ['b', '2024-01-01']]),
  { keyColumns: ['k'], orderColumn: 'ts' });
ok('A29 removes nothing when every key is already unique', nothingRemoved.stats.removed === 0);
ok('A29 says nothing was gained either',
  nothingRemoved.notes.some((n) => n.includes('nothing was gained')));
ok('A29 headline says no rows would be removed',
  describeKeepMostRecent(nothingRemoved).includes('No rows would be removed'));

const noCount = keepMostRecentTransform(records,
  Object.assign({}, keepCfg, { includeDroppedCount: false }));
ok('A29 can leave out the dropped-count column',
  !noCount.columns.some((c) => c.name === 'rows_dropped'));
ok('A29 without the count column keeps the original width',
  noCount.columns.length === records.columns.length);

const a29sql = buildKeepMostRecentSQL(keepCfg, 'records', ['customer', 'updated', 'city']);
ok('A29 SQL builds', a29sql.ok === true);
ok('A29 SQL uses ROW_NUMBER over the key', a29sql.sql.includes('ROW_NUMBER() OVER'));
ok('A29 SQL partitions by the key columns', a29sql.sql.includes('PARTITION BY "customer"'));
ok('A29 SQL orders newest first by default', a29sql.sql.includes('"updated" DESC NULLS LAST'));
ok('A29 SQL writes the whole tie-break out rather than leaving it implicit',
  a29sql.sql.includes('"city" DESC NULLS LAST'));
ok('A29 SQL keeps only the first row per key', a29sql.sql.includes('WHERE keep_rank = 1'));
ok('A29 SQL says the dropped rows may not have been duplicates',
  a29sql.sql.includes('facts'));
ok('A29 SQL admits the tie-break is arbitrary', a29sql.sql.includes('still arbitrary'));
ok('A29 SQL keeps undated rows in the running by default',
  a29sql.sql.includes('NULLS LAST stops them winning'));
ok('A29 SQL filters undated rows out when configured to drop them',
  buildKeepMostRecentSQL(Object.assign({}, keepCfg, { undated: 'drop' }), 'records',
    ['customer', 'updated', 'city']).sql.includes('IS NOT NULL'));
ok('A29 SQL orders oldest first when asked',
  buildKeepMostRecentSQL(Object.assign({}, keepCfg, { pick: 'oldest' }), 'records',
    ['customer', 'updated']).sql.includes('ASC NULLS LAST'));

ok('A29 refuses to run with no key columns',
  validateKeepConfig({ keyColumns: [], orderColumn: 'ts' }, ['ts'])
    .errors.join(' ').includes('one row for the whole table'));
ok('A29 refuses an order column that is also a key',
  validateKeepConfig({ keyColumns: ['ts'], orderColumn: 'ts' }, ['ts'])
    .errors.join(' ').includes('cannot also be one of the key columns'));
ok('A29 refuses a key column that is not in the table',
  validateKeepConfig({ keyColumns: ['nope'], orderColumn: 'ts' }, ['ts']).ok === false);
ok('A29 refuses an unknown pick',
  validateKeepConfig({ keyColumns: ['k'], orderColumn: 'ts', pick: 'middle' }, ['k', 'ts'])
    .ok === false);
ok('A29 tie-break columns are everything but the key and the order column',
  comparableColumns(['customer', 'updated', 'city'], keepCfg).join(',') === 'city');
ok('A29 suggests a key column that actually repeats',
  suggestKeepConfig(records).keyColumns[0] === 'customer');
ok('A29 suggests a date column for the order', suggestKeepConfig(records).orderColumn === 'updated');
ok('A29 errors without a table', keepMostRecentTransform(null, keepCfg).ok === false);
ok('A29 headline on an empty table says so',
  describeKeepMostRecent(keepMostRecentTransform(
    ds('e', [col('k', 'STR'), col('ts', 'DATE')], []),
    { keyColumns: ['k'], orderColumn: 'ts' })).includes('no rows'));

/* ==========================================================================
   House rules, across all six
   ========================================================================== */
console.log('\nhouse rules');

// Written as an escape so this file itself contains no literal em dash.
const EM_DASH = String.fromCharCode(0x2014);

const allResults = [a16, a16p, a17, a25, constFilled, a26, asAt, a27, custom, a29, oldest];
const allSql = [
  buildHierarchySQL(edgeCfg, 'org').sql,
  buildHierarchySQL(pathCfg, 'cats').sql,
  buildNestedToRowsSQL(nestedCfg, 'orders').sql,
  buildFillMissingSQL(fwdCfg, 'readings').sql,
  buildExpandDateRangeSQL(rangeCfg, 'stays').sql,
  buildBinSQL(binCfg, 'scores', resolved.edges, 1).sql,
  buildKeepMostRecentSQL(keepCfg, 'records', ['customer', 'updated', 'city']).sql,
];

const everyString = allResults
  .map((r) => r.notes.concat([r.sql]))
  .flat()
  .concat(allSql)
  .concat(allResults.map((r) => r.columns.map((c) => c.name)).flat())
  .join(' ');
ok('no em dash in any generated text or SQL', !everyString.includes(EM_DASH));

for (const res of allResults) {
  assert(res.ok === true, 'result ok');
  assert(Array.isArray(res.columns) && Array.isArray(res.rows), 'shape');
  assert(typeof res.sql === 'string' && res.sql.length > 0, 'sql present');
  assert(res.stats && typeof res.stats === 'object', 'stats present');
  assert(Array.isArray(res.notes) && res.notes.length > 0, 'notes present');
  for (const r of res.rows) {
    assert(Array.isArray(r) && r.length === res.columns.length, 'row width');
  }
}
ok('every transform returns the house result shape with matching row widths', true);
ok('every column type is an uppercase house type',
  allResults.every((r) => r.columns.every((c) => c.type === c.type.toUpperCase())));
ok('every transform ships its glass-box SQL alongside the rows',
  allResults.every((r) => r.sql.includes('SELECT') || r.sql.includes('WITH')));
ok('every transform says something about what it could not do',
  allResults.every((r) => r.notes.length > 0));
ok('every SQL proof carries a plain-language comment', allSql.every((s) => s.includes('--')));
ok('no transform mutates the dataset it was given',
  records.rows.length === 5 && readings.rows.length === 6 && orders.rows.length === 4);

console.log('\n' + passed + ' passed');
assert(passed >= 200, 'expected at least 200 assertions, got ' + passed);
console.log('shape-clean-transforms: all ' + passed + ' assertions passed');
