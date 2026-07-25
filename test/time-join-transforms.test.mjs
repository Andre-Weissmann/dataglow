// ============================================================
// DATAGLOW - Bundle 6 time and join transforms test suite
// ============================================================
// Pure, no DuckDB, no network, no DOM.
// Run: node test/time-join-transforms.test.mjs
//
// These assertions are written around the ways each transform could be quietly
// wrong rather than around its happy path, because every one of these four
// exists to prevent a specific plausible-looking wrong number:
//   A18 comparing March to January and calling it month over month
//   A19 doubling a total through an unnoticed range overlap
//   A20 returning a different row on each run when timestamps tie
//   A24 pricing an old sale at today's price
import assert from 'assert';

import {
  parseDateValue,
  formatISODate,
  periodKeyOf,
  priorPeriodKeyOf,
  pctChange,
  toNumber,
  keyOfRow,
  quoteIdent,
  relationName,
  asColumnList,
} from '../js/transforms/transform-core.js';

import {
  PRIOR_PERIOD_AGGREGATES,
  createEmptyPriorPeriodConfig,
  validatePriorPeriodConfig,
  buildPriorPeriodSQL,
  priorPeriodTransform,
  describePriorPeriod,
} from '../js/transforms/prior-period.js';

import {
  createEmptyDateRangeJoinConfig,
  validateDateRangeJoinConfig,
  buildDateRangeJoinSQL,
  previewDateRangeJoin,
  dateRangeJoinTransform,
} from '../js/transforms/date-range-join.js';

import {
  validateFirstLastConfig,
  buildFirstLastSQL,
  tieBreakColumns,
  firstLastEventTransform,
} from '../js/transforms/first-last-event.js';

import {
  createEmptyAsOfConfig,
  validateAsOfConfig,
  broughtColumns,
  buildAsOfSQL,
  asOfLookupTransform,
  describeAsOfLookup,
} from '../js/transforms/as-of-lookup.js';

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

/* ==================== transform-core ==================== */

console.log('transform-core');

ok('quoteIdent escapes internal quotes', quoteIdent('a"b') === '"a""b"');
ok('relationName falls back when blank', relationName('', 'src') === '"src"');
ok('relationName quotes a name with a quote', relationName('a"b') === '"a""b"');

ok('parseDateValue reads ISO', formatISODate(parseDateValue('2024-03-05')) === '2024-03-05');
ok('parseDateValue reads ISO with a time', formatISODate(parseDateValue('2024-03-05T23:59:00Z')) === '2024-03-05');
ok('parseDateValue reads US M/D/YYYY', formatISODate(parseDateValue('3/5/2024')) === '2024-03-05');
ok('parseDateValue rejects Feb 31 rather than rolling into March', parseDateValue('2024-02-31') === null);
ok('parseDateValue rejects month 13', parseDateValue('2024-13-01') === null);
ok('parseDateValue rejects free text rather than guessing', parseDateValue('last Tuesday') === null);
ok('parseDateValue rejects blank', parseDateValue('') === null && parseDateValue(null) === null);
ok('parseDateValue accepts a real Date', formatISODate(parseDateValue(new Date(Date.UTC(2024, 0, 2)))) === '2024-01-02');
ok('parseDateValue rejects an invalid Date', parseDateValue(new Date('nope')) === null);

ok('periodKeyOf month', periodKeyOf(parseDateValue('2024-03-31'), 'month') === '2024-03');
ok('periodKeyOf day', periodKeyOf(parseDateValue('2024-03-31'), 'day') === '2024-03-31');
ok('periodKeyOf week anchors on Monday', periodKeyOf(parseDateValue('2024-03-07'), 'week') === '2024-03-04');
ok('periodKeyOf week puts Sunday in the week that started Monday',
  periodKeyOf(parseDateValue('2024-03-10'), 'week') === '2024-03-04');
ok('periodKeyOf week rolls to the next Monday', periodKeyOf(parseDateValue('2024-03-11'), 'week') === '2024-03-11');

ok('priorPeriodKeyOf month steps back one month', priorPeriodKeyOf('2024-03', 'month') === '2024-02');
ok('priorPeriodKeyOf month crosses the year', priorPeriodKeyOf('2024-01', 'month') === '2023-12');
ok('priorPeriodKeyOf week steps back seven days', priorPeriodKeyOf('2024-03-11', 'week') === '2024-03-04');
ok('priorPeriodKeyOf day steps back one day', priorPeriodKeyOf('2024-03-01', 'day') === '2024-02-29');
ok('priorPeriodKeyOf rejects a malformed key', priorPeriodKeyOf('March', 'month') === null);

ok('toNumber strips thousands separators', toNumber('1,234') === 1234);
ok('toNumber treats blank as missing, not zero', toNumber('') === null && toNumber(null) === null);
ok('toNumber rejects text', toNumber('n/a') === null);

ok('pctChange is a ratio', pctChange(150, 100) === 0.5);
ok('pctChange is null when prior is zero rather than Infinity', pctChange(5, 0) === null);
ok('pctChange is null when prior is missing', pctChange(5, null) === null);
ok('pctChange uses the magnitude of a negative prior', pctChange(-50, -100) === 0.5);

ok('keyOfRow keeps a separator collision apart',
  keyOfRow(['a', 'b'], [0, 1]) !== keyOfRow(['ab', ''], [0, 1]));
ok('keyOfRow distinguishes null from empty string',
  keyOfRow([null], [0]) !== keyOfRow([''], [0]));
ok('asColumnList drops blanks and duplicates',
  asColumnList(['a', '', 'a', null, 'b']).join(',') === 'a,b');

/* ==================== A18 prior period ==================== */

console.log('\nA18 compare to previous period');

const sales = ds('sales', [col('shop', 'STR'), col('day', 'DATE'), col('amount', 'FLOAT')], [
  ['north', '2024-01-15', 100],
  ['north', '2024-01-20', 50],
  ['north', '2024-02-03', 200],
  // March deliberately skips February for the south shop, which is the gap that
  // a bare LAG would misreport as month over month.
  ['south', '2024-01-10', 10],
  ['south', '2024-03-10', 40],
]);

const a18cfg = Object.assign(createEmptyPriorPeriodConfig(), {
  dateColumn: 'day', metricColumn: 'amount', grain: 'month', entityColumns: ['shop'],
});

ok('A18 empty config defaults to SUM over months',
  createEmptyPriorPeriodConfig().aggregate === 'SUM' && createEmptyPriorPeriodConfig().grain === 'month');
ok('A18 offers SUM first', PRIOR_PERIOD_AGGREGATES[0] === 'SUM');
ok('A18 validate needs a date column',
  validatePriorPeriodConfig({ metricColumn: 'amount' }, ['amount']).ok === false);
ok('A18 validate rejects a column not in the table',
  validatePriorPeriodConfig({ dateColumn: 'nope', metricColumn: 'amount' }, ['amount']).ok === false);
ok('A18 validate rejects the date column as a group column',
  validatePriorPeriodConfig({ dateColumn: 'day', metricColumn: 'amount', entityColumns: ['day'] },
    ['day', 'amount']).ok === false);
ok('A18 validate accepts COUNT with no metric column',
  validatePriorPeriodConfig({ dateColumn: 'day', aggregate: 'COUNT' }, ['day']).ok === true);
ok('A18 validate rejects a nonsense aggregate',
  validatePriorPeriodConfig({ dateColumn: 'day', metricColumn: 'amount', aggregate: 'MEDIAN' },
    ['day', 'amount']).ok === false);
ok('A18 validate accepts the good config', validatePriorPeriodConfig(a18cfg, ['shop', 'day', 'amount']).ok === true);

const a18 = priorPeriodTransform(sales, a18cfg);
ok('A18 runs', a18.ok === true);
ok('A18 returns one row per entity-period', a18.rows.length === 4);
ok('A18 columns end with the comparison', a18.columns.map((c) => c.name).join(',')
  === 'shop,period_start,metric_value,prior_value,change,pct_change');

function findRow(res, shop, period) {
  return res.rows.find((r) => r[0] === shop && r[1] === period);
}
const northJan = findRow(a18, 'north', '2024-01');
const northFeb = findRow(a18, 'north', '2024-02');
const southMar = findRow(a18, 'south', '2024-03');

ok('A18 sums within the period', northJan[2] === 150);
ok('A18 first period has no prior', northJan[3] === null && northJan[4] === null && northJan[5] === null);
ok('A18 second period compares to the first', northFeb[3] === 150 && northFeb[4] === 50);
ok('A18 pct change is computed off the prior', Math.abs(northFeb[5] - (50 / 150)) < 1e-12);
ok('A18 does NOT reach across a gap: March has no prior when February is absent',
  southMar[3] === null && southMar[4] === null);
ok('A18 says out loud that a prior was missing',
  a18.notes.some((n) => n.includes('no previous month')));
ok('A18 counts the periods without a prior', a18.stats.withoutPrior === 3);
ok('A18 keeps entities apart', findRow(a18, 'south', '2024-01')[2] === 10);
ok('A18 describe names the comparable count', describePriorPeriod(a18, a18cfg).includes('of 4 periods'));

const a18bad = priorPeriodTransform(
  ds('t', [col('day', 'STR'), col('amount', 'FLOAT')], [
    ['not a date', 5], ['2024-01-01', 'n/a'], ['2024-01-02', 7],
  ]),
  { dateColumn: 'day', metricColumn: 'amount', grain: 'month' },
);
ok('A18 counts unreadable dates instead of dropping them silently', a18bad.stats.unreadableDates === 1);
ok('A18 counts unreadable metrics separately', a18bad.stats.unreadableMetrics === 1);
ok('A18 names the offending column in the note',
  a18bad.notes.some((n) => n.includes('day')) && a18bad.notes.some((n) => n.includes('amount')));

const a18count = priorPeriodTransform(sales, Object.assign({}, a18cfg, { aggregate: 'COUNT', metricColumn: '' }));
ok('A18 COUNT needs no metric column', a18count.ok === true);
ok('A18 COUNT counts rows', findRow(a18count, 'north', '2024-01')[2] === 2);

const a18avg = priorPeriodTransform(sales, Object.assign({}, a18cfg, { aggregate: 'AVG' }));
ok('A18 AVG averages within the period', findRow(a18avg, 'north', '2024-01')[2] === 75);

const a18day = priorPeriodTransform(
  ds('t', [col('day', 'DATE'), col('v', 'FLOAT')], [['2024-03-01', 1], ['2024-03-02', 2], ['2024-03-04', 4]]),
  { dateColumn: 'day', metricColumn: 'v', grain: 'day' },
);
ok('A18 day grain compares to yesterday', a18day.rows[1][2] === 1);
ok('A18 day grain skips a missing yesterday', a18day.rows[2][2] === null);

const a18sql = buildPriorPeriodSQL(a18cfg, 'sales');
ok('A18 SQL builds', a18sql.ok === true);
ok('A18 SQL uses a LEFT JOIN on the stepped-back period, not a bare LAG',
  a18sql.sql.includes('LEFT JOIN') && a18sql.sql.includes('INTERVAL 1 MONTH')
  && !a18sql.sql.includes('LAG('));
ok('A18 SQL guards division by a zero prior', a18sql.sql.includes('prior.metric_value = 0 THEN NULL'));
ok('A18 SQL states the gap rule in a comment', a18sql.sql.includes('previous CALENDAR'));
ok('A18 SQL quotes identifiers', a18sql.sql.includes('"amount"') && a18sql.sql.includes('"shop"'));
ok('A18 SQL for COUNT has no metric column',
  buildPriorPeriodSQL(Object.assign({}, a18cfg, { aggregate: 'COUNT' }), 'sales').sql.includes('COUNT(*)'));
ok('A18 error when there is no table', priorPeriodTransform(null, a18cfg).ok === false);

/* ==================== A19 join on date range ==================== */

console.log('\nA19 join on date range');

const events = ds('events', [col('sku', 'STR'), col('sold_on', 'DATE'), col('units', 'INT')], [
  ['a', '2024-01-15', 2],
  ['a', '2024-03-01', 1],
  ['b', '2024-01-15', 5],
  ['z', '2024-01-15', 9],
]);

// Two overlapping ranges for sku a in January: the fanout case.
const ranges = ds('promos', [col('sku', 'STR'), col('starts', 'DATE'), col('ends', 'DATE'), col('promo', 'STR')], [
  ['a', '2024-01-01', '2024-01-31', 'new-year'],
  ['a', '2024-01-10', '2024-01-20', 'flash'],
  ['a', '2024-02-01', null, 'ongoing'],
  ['b', '2024-01-01', '2024-01-14', 'early'],
]);

const a19cfg = Object.assign(createEmptyDateRangeJoinConfig(), {
  eventDateColumn: 'sold_on',
  rangeStartColumn: 'starts',
  rangeEndColumn: 'ends',
  keyPairs: [{ left: 'sku', right: 'sku' }],
});

ok('A19 empty config treats a blank end as still in force',
  createEmptyDateRangeJoinConfig().openEndedEnd === true);
ok('A19 validate needs an event date',
  validateDateRangeJoinConfig({ rangeStartColumn: 'starts' }, ['sold_on'], ['starts']).ok === false);
ok('A19 validate needs a start column',
  validateDateRangeJoinConfig({ eventDateColumn: 'sold_on' }, ['sold_on'], ['starts']).ok === false);
ok('A19 validate allows no end column at all',
  validateDateRangeJoinConfig({ eventDateColumn: 'sold_on', rangeStartColumn: 'starts' },
    ['sold_on'], ['starts']).ok === true);
ok('A19 validate rejects a key column missing on the right',
  validateDateRangeJoinConfig({
    eventDateColumn: 'sold_on', rangeStartColumn: 'starts', keyPairs: [{ left: 'sku', right: 'nope' }],
  }, ['sku', 'sold_on'], ['starts']).ok === false);

const pv = previewDateRangeJoin(events, ranges, a19cfg);
ok('A19 preview runs without building rows', pv.ok === true && pv.rows === undefined);
ok('A19 preview reports the fanout ratio above 1', pv.stats.fanoutRatio > 1);
ok('A19 preview names the worst fanout', pv.stats.maxFanout === 2);
ok('A19 preview counts the multi-match rows', pv.stats.multiMatchEvents === 1);
ok('A19 preview warns about overlapping ranges',
  pv.warnings.some((w) => w.includes('more than one range')));
ok('A19 preview counts unmatched events', pv.stats.unmatchedEvents === 2);

const a19 = dateRangeJoinTransform(events, ranges, a19cfg);
ok('A19 runs', a19.ok === true);
ok('A19 fans out an event inside two ranges into two rows',
  a19.rows.filter((r) => r[0] === 'a' && r[1] === '2024-01-15').length === 2);
ok('A19 open-ended end matches a later event',
  a19.rows.some((r) => r[1] === '2024-03-01' && r[r.length - 1] === 'ongoing'));
ok('A19 keeps an unmatched event with blanks by default',
  a19.rows.some((r) => r[0] === 'z' && r[r.length - 1] === null));
ok('A19 respects the key: sku b never gets a promo for sku a',
  a19.rows.filter((r) => r[0] === 'b').every((r) => r[r.length - 1] === 'early' || r[r.length - 1] === null));
ok('A19 excludes an event past a closed end (b sold 01-15, promo ended 01-14)',
  a19.rows.filter((r) => r[0] === 'b').every((r) => r[r.length - 1] === null));
ok('A19 suffixes a colliding column name',
  a19.columns.map((c) => c.name).filter((n) => n === 'sku_range').length === 1);
ok('A19 preview and apply agree on the row count', a19.stats.rowsOut === pv.stats.rowsOut);
ok('A19 carries the warnings into notes', a19.notes.length === pv.warnings.length);

const a19inner = dateRangeJoinTransform(events, ranges, Object.assign({}, a19cfg, { keepUnmatched: false }));
ok('A19 inner mode drops unmatched events',
  a19inner.rows.every((r) => r[0] !== 'z') && a19inner.stats.unmatchedEvents === 2);

const a19excl = dateRangeJoinTransform(
  ds('e', [col('d', 'DATE')], [['2024-01-31']]),
  ds('r', [col('s', 'DATE'), col('e', 'DATE'), col('tag', 'STR')], [['2024-01-01', '2024-01-31', 'jan']]),
  { eventDateColumn: 'd', rangeStartColumn: 's', rangeEndColumn: 'e', inclusiveEnd: false, keepUnmatched: true },
);
ok('A19 exclusive end excludes an event on the end date', a19excl.rows[0][a19excl.rows[0].length - 1] === null);

const a19incl = dateRangeJoinTransform(
  ds('e', [col('d', 'DATE')], [['2024-01-31']]),
  ds('r', [col('s', 'DATE'), col('e', 'DATE'), col('tag', 'STR')], [['2024-01-01', '2024-01-31', 'jan']]),
  { eventDateColumn: 'd', rangeStartColumn: 's', rangeEndColumn: 'e', keepUnmatched: true },
);
ok('A19 inclusive end includes an event on the end date', a19incl.rows[0][a19incl.rows[0].length - 1] === 'jan');

const a19closed = dateRangeJoinTransform(events, ranges,
  Object.assign({}, a19cfg, { openEndedEnd: false }));
ok('A19 with openEndedEnd off drops the blank-ended range',
  a19closed.rows.every((r) => r[r.length - 1] !== 'ongoing'));

const a19null = dateRangeJoinTransform(
  ds('e', [col('d', 'STR')], [['nope'], ['2024-01-05']]),
  ds('r', [col('s', 'STR'), col('e', 'STR'), col('tag', 'STR')], [
    ['2024-01-01', '2024-01-31', 'ok'], ['bad', '2024-02-01', 'skipped'], ['2024-03-01', '31/13/2024', 'badend'],
  ]),
  { eventDateColumn: 'd', rangeStartColumn: 's', rangeEndColumn: 'e', keepUnmatched: true },
);
ok('A19 counts unreadable event dates', a19null.stats.unreadableEventDates === 1);
ok('A19 counts unreadable range bounds', a19null.stats.unreadableRangeBounds === 2);
ok('A19 an unreadable end is not treated as open',
  a19null.rows.every((r) => r[r.length - 1] !== 'badend'));

const a19many = dateRangeJoinTransform(
  ds('e', [col('d', 'DATE')], [['2024-01-05'], ['2024-01-06']]),
  ds('r', [col('s', 'DATE'), col('e', 'DATE'), col('tag', 'STR')], [
    ['2024-01-01', '2024-01-31', 'x'], ['2024-01-02', '2024-01-30', 'y'], ['2024-01-03', '2024-01-29', 'z'],
  ]),
  { eventDateColumn: 'd', rangeStartColumn: 's', rangeEndColumn: 'e' },
);
ok('A19 many-to-many produces the cross product of overlaps', a19many.rows.length === 6);
ok('A19 many-to-many reports the fanout', a19many.stats.maxFanout === 3);
ok('A19 warns that totals will grow once the ratio passes the threshold',
  a19many.notes.some((n) => n.includes('larger than the')));
ok('A19 does not cry fanout when the ratio is modest',
  pv.stats.fanoutRatio < 1.5 && !pv.warnings.some((w) => w.includes('larger than the')));

const a19sql = buildDateRangeJoinSQL(a19cfg, 'events', 'promos');
ok('A19 SQL builds', a19sql.ok === true);
ok('A19 SQL is a non-equi join on the bounds',
  a19sql.sql.includes('>= r."starts"') && a19sql.sql.includes('<= r."ends"'));
ok('A19 SQL makes the open end explicit', a19sql.sql.includes('r."ends" IS NULL'));
ok('A19 SQL states the inclusive-end rule in a comment',
  a19sql.sql.includes('end date is INCLUDED'));
ok('A19 SQL uses INNER JOIN when unmatched are dropped',
  buildDateRangeJoinSQL(Object.assign({}, a19cfg, { keepUnmatched: false }), 'e', 'r')
    .sql.includes('INNER JOIN'));
ok('A19 SQL omits the end comparison when there is no end column',
  buildDateRangeJoinSQL({ eventDateColumn: 'd', rangeStartColumn: 's' }, 'e', 'r')
    .sql.includes('runs from its start onward'));
ok('A19 error without a second table', dateRangeJoinTransform(events, null, a19cfg).ok === false);

/* ==================== A20 first / last event ==================== */

console.log('\nA20 first or last event per entity');

const logins = ds('logins', [col('user', 'STR'), col('at', 'DATE'), col('device', 'STR')], [
  ['u1', '2024-01-01', 'phone'],
  ['u1', '2024-03-01', 'laptop'],
  ['u1', '2024-02-01', 'tablet'],
  ['u2', '2024-05-05', 'phone'],
  // A genuine tie for u3: same timestamp, two different devices.
  ['u3', '2024-01-09', 'watch'],
  ['u3', '2024-01-09', 'alpha'],
]);

const a20cfg = { entityColumns: ['user'], orderColumn: 'at', pick: 'last', mode: 'one' };

ok('A20 validate needs a group column',
  validateFirstLastConfig({ orderColumn: 'at' }, ['user', 'at']).ok === false);
ok('A20 validate needs an order column',
  validateFirstLastConfig({ entityColumns: ['user'] }, ['user', 'at']).ok === false);
ok('A20 validate rejects the order column as a group column',
  validateFirstLastConfig({ entityColumns: ['at'], orderColumn: 'at' }, ['at']).ok === false);
ok('A20 validate rejects a nonsense pick',
  validateFirstLastConfig({ entityColumns: ['user'], orderColumn: 'at', pick: 'middle' },
    ['user', 'at']).ok === false);
ok('A20 validate accepts the good config', validateFirstLastConfig(a20cfg, ['user', 'at', 'device']).ok === true);
ok('A20 tie-break columns are everything else in table order',
  tieBreakColumns(['user', 'at', 'device'], a20cfg).join(',') === 'device');

const a20last = firstLastEventTransform(logins, a20cfg);
ok('A20 last runs', a20last.ok === true);
ok('A20 last gives one row per group', a20last.rows.length === 3 && a20last.stats.groups === 3);
ok('A20 last picks the greatest order value',
  a20last.rows.find((r) => r[0] === 'u1')[1] === '2024-03-01');
ok('A20 appends a rank column', a20last.columns[a20last.columns.length - 1].name === 'event_rank');
ok('A20 one-per-group rank is always 1', a20last.rows.every((r) => r[r.length - 1] === 1));

const a20first = firstLastEventTransform(logins, Object.assign({}, a20cfg, { pick: 'first' }));
ok('A20 first picks the smallest order value',
  a20first.rows.find((r) => r[0] === 'u1')[1] === '2024-01-01');

ok('A20 counts the tied groups', a20last.stats.tiedGroups === 1);
ok('A20 admits the tie-break was arbitrary',
  a20last.notes.some((n) => n.includes('repeatable but arbitrary')));
ok('A20 tie-break is deterministic across runs',
  JSON.stringify(firstLastEventTransform(logins, a20cfg).rows)
  === JSON.stringify(firstLastEventTransform(logins, a20cfg).rows));
ok('A20 tie-break on last takes the greater remaining column (watch, not alpha)',
  a20last.rows.find((r) => r[0] === 'u3')[2] === 'watch');
ok('A20 tie-break on first takes the lesser remaining column (alpha, not watch)',
  a20first.rows.find((r) => r[0] === 'u3')[2] === 'alpha');
ok('A20 tie-break survives a reversed input order', (function () {
  const flipped = ds('logins', logins.columns, logins.rows.slice().reverse());
  return firstLastEventTransform(flipped, a20cfg).rows.find((r) => r[0] === 'u3')[2] === 'watch';
}()));

const a20ranked = firstLastEventTransform(logins, Object.assign({}, a20cfg, { mode: 'ranked' }));
ok('A20 ranked keeps every row', a20ranked.rows.length === 6);
ok('A20 ranked numbers within the group',
  a20ranked.rows.filter((r) => r[0] === 'u1').map((r) => r[r.length - 1]).join(',') === '1,2,3');
ok('A20 ranked orders u1 latest first',
  a20ranked.rows.filter((r) => r[0] === 'u1')[0][1] === '2024-03-01');

const a20null = firstLastEventTransform(
  ds('t', [col('u', 'STR'), col('at', 'DATE')], [['a', null], ['a', '2024-01-01'], ['b', '']]),
  { entityColumns: ['u'], orderColumn: 'at', pick: 'last' },
);
ok('A20 excludes rows with no order value', a20null.stats.unreadableOrder === 2);
ok('A20 a group whose only row has no order value disappears rather than winning',
  a20null.stats.groups === 1 && a20null.rows.length === 1);
ok('A20 explains why those rows went', a20null.notes.some((n) => n.includes('cannot be the last event')));

const a20num = firstLastEventTransform(
  ds('t', [col('u', 'STR'), col('n', 'INT')], [['a', 9], ['a', 10]]),
  { entityColumns: ['u'], orderColumn: 'n', pick: 'last' },
);
ok('A20 orders a numeric column numerically, so 10 beats 9', a20num.rows[0][1] === 10);

const a20multi = firstLastEventTransform(
  ds('t', [col('a', 'STR'), col('b', 'STR'), col('at', 'DATE')], [
    ['x', 'p', '2024-01-01'], ['x', 'q', '2024-02-01'], ['x', 'p', '2024-03-01'],
  ]),
  { entityColumns: ['a', 'b'], orderColumn: 'at', pick: 'last' },
);
ok('A20 groups on a composite key', a20multi.stats.groups === 2);
ok('A20 composite group picks within its own key',
  a20multi.rows.find((r) => r[1] === 'p')[2] === '2024-03-01');

const a20sql = buildFirstLastSQL(a20cfg, 'logins', ['user', 'at', 'device']);
ok('A20 SQL builds', a20sql.ok === true);
ok('A20 SQL uses ROW_NUMBER with QUALIFY',
  a20sql.sql.includes('ROW_NUMBER() OVER') && a20sql.sql.includes('QUALIFY event_rank = 1'));
ok('A20 SQL partitions by the group', a20sql.sql.includes('PARTITION BY "user"'));
ok('A20 SQL puts the tie-break in the ORDER BY, not in prose only',
  a20sql.sql.includes('"at" DESC NULLS LAST, "device" DESC NULLS LAST'));
ok('A20 SQL documents the tie-break rule', a20sql.sql.includes('broken by the remaining columns'));
ok('A20 SQL excludes null order values', a20sql.sql.includes('WHERE "at" IS NOT NULL'));
ok('A20 SQL for first sorts ascending',
  buildFirstLastSQL(Object.assign({}, a20cfg, { pick: 'first' }), 'logins', ['user', 'at'])
    .sql.includes('"at" ASC NULLS LAST'));
ok('A20 SQL for ranked mode omits QUALIFY',
  !buildFirstLastSQL(Object.assign({}, a20cfg, { mode: 'ranked' }), 'logins', ['user', 'at'])
    .sql.includes('QUALIFY'));
ok('A20 error when there is no table', firstLastEventTransform(null, a20cfg).ok === false);

/* ==================== A24 as-of lookup ==================== */

console.log('\nA24 as-of lookup');

const facts = ds('sales', [col('sku', 'STR'), col('sold_on', 'DATE'), col('units', 'INT')], [
  ['a', '2024-01-15', 2],
  ['a', '2024-02-15', 3],
  ['a', '2023-06-01', 1],
  ['b', '2024-01-15', 4],
  ['c', '2024-01-15', 7],
]);

const prices = ds('prices', [col('sku', 'STR'), col('effective', 'DATE'), col('price', 'FLOAT')], [
  ['a', '2024-01-01', 10],
  ['a', '2024-02-01', 12],
  ['b', '2024-01-01', 99],
  // Two rows sharing one effective date for b: the ambiguity A24 must report.
  ['b', '2024-01-01', 98],
]);

const a24cfg = Object.assign(createEmptyAsOfConfig(), {
  factDateColumn: 'sold_on',
  refDateColumn: 'effective',
  keyPairs: [{ left: 'sku', right: 'sku' }],
});

ok('A24 validate needs a fact date',
  validateAsOfConfig({ refDateColumn: 'effective' }, ['sold_on'], ['effective']).ok === false);
ok('A24 validate needs an effective date',
  validateAsOfConfig({ factDateColumn: 'sold_on' }, ['sold_on'], ['effective']).ok === false);
ok('A24 validate rejects a value column not in the lookup table',
  validateAsOfConfig({ factDateColumn: 'sold_on', refDateColumn: 'effective', valueColumns: ['nope'] },
    ['sold_on'], ['effective']).ok === false);
ok('A24 validate accepts the good config',
  validateAsOfConfig(a24cfg, ['sku', 'sold_on', 'units'], ['sku', 'effective', 'price']).ok === true);
ok('A24 brings across everything but the key and the date by default',
  broughtColumns(a24cfg, ['sku', 'effective', 'price']).join(',') === 'price');
ok('A24 honours an explicit value column list',
  broughtColumns(Object.assign({}, a24cfg, { valueColumns: ['price'] }),
    ['sku', 'effective', 'price', 'note']).join(',') === 'price');

const a24 = asOfLookupTransform(facts, prices, a24cfg);
ok('A24 runs', a24.ok === true);
ok('A24 keeps every fact row, one output row each', a24.rows.length === 5 && a24.stats.rowsIn === 5);
ok('A24 suffixes the brought column so it cannot be mistaken for a current value',
  a24.columns[a24.columns.length - 1].name === 'price_asof');

function factRow(sku, date) { return a24.rows.find((r) => r[0] === sku && r[1] === date); }
ok('A24 takes the value in force, not the latest one',
  factRow('a', '2024-01-15')[3] === 10);
ok('A24 moves to the next value once it takes effect',
  factRow('a', '2024-02-15')[3] === 12);
ok('A24 leaves a fact older than every lookup row blank rather than back-filling',
  factRow('a', '2023-06-01')[3] === null);
ok('A24 says so in the notes', a24.notes.some((n) => n.includes('dated before the')));
ok('A24 refuses to fill with the oldest value on record',
  a24.notes.some((n) => n.includes('not in force then')));
ok('A24 counts the before-first rows', a24.stats.beforeFirst === 1);
ok('A24 blanks a fact whose key is absent from the lookup table',
  factRow('c', '2024-01-15')[3] === null && a24.stats.noKey === 1);
ok('A24 calls out the missing key', a24.notes.some((n) => n.includes('no matching entry')));
ok('A24 counts the matches', a24.stats.matched === 3);
ok('A24 counts the unmatched', a24.stats.unmatched === 2);
ok('A24 reports a duplicated effective date', a24.stats.duplicateEffectiveDates === 1);
ok('A24 names the tie-break for duplicates',
  a24.notes.some((n) => n.includes('later one in table order')));
ok('A24 duplicate tie-break takes the later row in table order', factRow('b', '2024-01-15')[3] === 98);
ok('A24 describe leads with what is blank', describeAsOfLookup(a24).includes('blank rather than guessed'));

const a24exact = asOfLookupTransform(
  ds('f', [col('d', 'DATE')], [['2024-01-01']]),
  ds('r', [col('e', 'DATE'), col('v', 'INT')], [['2024-01-01', 5]]),
  { factDateColumn: 'd', refDateColumn: 'e' },
);
ok('A24 a fact on the exact effective date matches it', a24exact.rows[0][1] === 5);

const a24nokey = asOfLookupTransform(
  ds('f', [col('d', 'DATE')], [['2024-02-01']]),
  ds('r', [col('e', 'DATE'), col('v', 'INT')], [['2024-01-01', 1], ['2024-03-01', 3]]),
  { factDateColumn: 'd', refDateColumn: 'e' },
);
ok('A24 works with no key at all, one shared timeline', a24nokey.rows[0][1] === 1);

const a24bad = asOfLookupTransform(
  ds('f', [col('d', 'STR')], [['nope'], ['2024-02-01']]),
  ds('r', [col('e', 'STR'), col('v', 'INT')], [['bad', 9], ['2024-01-01', 1]]),
  { factDateColumn: 'd', refDateColumn: 'e' },
);
ok('A24 an unreadable fact date is blanked, not looked up as of today',
  a24bad.rows[0][1] === null && a24bad.stats.unreadableFactDates === 1);
ok('A24 warns against the as-of-today reading',
  a24bad.notes.some((n) => n.includes('looked up as of today')));
ok('A24 counts unreadable lookup dates', a24bad.stats.unreadableRefDates === 1);
ok('A24 still matches the readable rows', a24bad.rows[1][1] === 1);

const a24sql = buildAsOfSQL(a24cfg, 'sales', 'prices', ['sku', 'effective', 'price']);
ok('A24 SQL builds', a24sql.ok === true);
ok('A24 SQL uses ASOF LEFT JOIN', a24sql.sql.includes('ASOF LEFT JOIN'));
ok('A24 SQL compares fact date to effective date',
  a24sql.sql.includes('f."sold_on" >= r."effective"'));
ok('A24 SQL aliases the brought column with the suffix',
  a24sql.sql.includes('AS "price_asof"'));
ok('A24 SQL offers a window-function equivalent',
  a24sql.sql.includes('ROW_NUMBER() OVER') && a24sql.sql.includes('engines that do not support it'));
ok('A24 SQL states that an early fact gets NULL, not the oldest value',
  a24sql.sql.includes('Not the current row'));
ok('A24 error without a lookup table', asOfLookupTransform(facts, null, a24cfg).ok === false);

/* ==================== house rules ==================== */

console.log('\nhouse rules');

const noEmDash = [
  a18.notes, a19.notes, a20last.notes, a24.notes,
  [a18sql.sql, a19sql.sql, a20sql.sql, a24sql.sql],
  [describePriorPeriod(a18, a18cfg), describeAsOfLookup(a24)],
].flat().join(' ');
ok('no em dash in any generated text or SQL', !noEmDash.includes('—'));

for (const res of [a18, a19, a20last, a24]) {
  assert(Array.isArray(res.columns) && Array.isArray(res.rows), 'shape');
  assert(typeof res.sql === 'string' && res.sql.length > 0, 'sql present');
  assert(res.stats && typeof res.stats === 'object', 'stats present');
  assert(Array.isArray(res.notes), 'notes present');
  for (const r of res.rows) {
    assert(Array.isArray(r) && r.length === res.columns.length,
      'every row is an array matching the column count');
  }
}
ok('all four transforms return the same result shape with matching row widths', true);
ok('all four column types are uppercase house types',
  [a18, a19, a20last, a24].every((res) => res.columns.every((c) => c.type === c.type.toUpperCase())));

console.log('\n' + passed + ' passed');
assert(passed >= 130, 'expected at least 130 assertions, got ' + passed);
console.log('time-join-transforms: all ' + passed + ' assertions passed');
