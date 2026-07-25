// ============================================================
// DATAGLOW - A30 Return within a window
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. An entity has an event. Does it have another one within N
// days. That is a 30-day readmission, a 7-day repeat purchase, a 14-day support
// re-contact, a 90-day churn-and-return. One shape, one arithmetic.
//
// THE POINT OF THIS MODULE IS THE DENOMINATOR, WHICH IS WHERE THIS MEASURE GOES
// WRONG IN PRACTICE.
//
// AN EVENT IN THE LAST N DAYS OF THE DATA HAS NOT HAD N DAYS TO RECUR.
// If the table ends on March 31 and the window is 30 days, then an event on
// March 20 has only been observed for 11 days. Counting it as "did not return"
// is not a finding, it is the calendar. Those events are censored, and a rate
// that includes them in the denominator is biased downward by an amount that
// grows with the window. So this module reports two rates, both labelled:
//   rate over eligible events   the honest one, censored events excluded.
//   rate over all events        the number a naive query returns, shown so the
//                               gap between them is visible rather than argued.
// The count of censored events and the last date in the data are both stated.
//
// A PAIR IS AN INDEX EVENT AND THE NEXT EVENT INSIDE THE WINDOW, NOT EVERY PAIR.
// If an entity has events on day 1, 3 and 5 with a 30-day window, that is not
// three pairs. Day 1 pairs with day 3, and day 3 pairs with day 5. Counting all
// combinations inflates the count quadratically and is the second standard error.
// Every index event contributes at most one return.
//
// SAME-DAY EVENTS ARE USUALLY ONE EVENT ENTERED TWICE.
// A gap of zero days is duplicate data far more often than it is a genuine
// same-day return, so the minimum gap defaults to one day, the excluded pairs are
// counted, and the choice is stated rather than buried.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isPlainObject,
  asColumnList,
  keyOfRow,
  parseDateValue,
  formatISODate,
  daysBetween,
  addDays,
  column,
  transformResult,
  transformError,
  TYPE_INT,
  TYPE_FLOAT,
  TYPE_STR,
  TYPE_DATE,
  TYPE_BOOL,
} from './transform-core.js';

export const WINDOW_RECURRENCE_VERSION = 1;

export const INDEX_SCOPES = Object.freeze(['all', 'first', 'last']);

export const INDEX_SCOPE_LABELS = Object.freeze({
  all: 'Every event can start a window',
  first: 'Only the first event per entity',
  last: 'Only the most recent event per entity',
});

export const DEFAULT_WINDOW_DAYS = 30;

export function createEmptyRecurrenceConfig() {
  return {
    entityColumns: [],
    dateColumn: '',
    windowDays: DEFAULT_WINDOW_DAYS,
    minGapDays: 1,
    indexScope: 'all',
    observationEnd: '',
    excludeCensored: true,
    carryColumns: [],
  };
}

export function suggestRecurrenceConfig(dataset) {
  const cfg = createEmptyRecurrenceConfig();
  const names = columnNamesOf(dataset);
  const rows = rowsOf(dataset);

  for (let i = 0; i < names.length; i += 1) {
    let dates = 0;
    let looked = 0;
    for (let r = 0; r < rows.length && looked < 200; r += 1) {
      if (!Array.isArray(rows[r])) continue;
      const cell = rows[r][i];
      if (cell == null || cell === '') continue;
      looked += 1;
      if (parseDateValue(cell)) dates += 1;
    }
    if (looked && dates / looked > 0.8 && !cfg.dateColumn) cfg.dateColumn = names[i];
  }

  // An entity column repeats: the whole question is whether the same entity comes
  // back, so a column with one distinct value per row cannot be one.
  for (let i = 0; i < names.length && !cfg.entityColumns.length; i += 1) {
    if (names[i] === cfg.dateColumn) continue;
    const seen = new Set();
    let looked = 0;
    for (let r = 0; r < rows.length && looked < 400; r += 1) {
      if (!Array.isArray(rows[r])) continue;
      const cell = rows[r][i];
      if (cell == null || cell === '') continue;
      looked += 1;
      seen.add(String(cell));
    }
    if (looked > 1 && seen.size > 1 && seen.size < looked) cfg.entityColumns = [names[i]];
  }
  return cfg;
}

export function validateRecurrenceConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  const ents = asColumnList(config.entityColumns);
  if (!ents.length) {
    errors.push('Pick the column that identifies the entity, so a return can be recognised.');
  }
  for (let i = 0; i < ents.length; i += 1) {
    if (!names.includes(ents[i])) errors.push('The column ' + ents[i] + ' is not in this table.');
  }

  if (!config.dateColumn) {
    errors.push('Pick the column that holds the event date.');
  } else if (!names.includes(config.dateColumn)) {
    errors.push('The column ' + config.dateColumn + ' is not in this table.');
  } else if (ents.includes(config.dateColumn)) {
    errors.push('The date column cannot also identify the entity.');
  }

  const win = Number(config.windowDays);
  if (!Number.isFinite(win) || win < 1 || Math.floor(win) !== win) {
    errors.push('The window has to be a whole number of days, one or more.');
  }
  const gap = Number(config.minGapDays == null ? 1 : config.minGapDays);
  if (!Number.isFinite(gap) || gap < 0 || Math.floor(gap) !== gap) {
    errors.push('The smallest gap has to be a whole number of days, zero or more.');
  }
  if (Number.isFinite(win) && Number.isFinite(gap) && gap > win) {
    errors.push('The smallest gap cannot be larger than the window, or no return could ever count.');
  }
  if (config.indexScope && INDEX_SCOPES.indexOf(config.indexScope) === -1) {
    errors.push('Choose which events can start a window.');
  }
  if (config.observationEnd && !parseDateValue(config.observationEnd)) {
    errors.push('The last date of observation could not be read as a date.');
  }

  const carry = asColumnList(config.carryColumns);
  for (let i = 0; i < carry.length; i += 1) {
    if (!names.includes(carry[i])) {
      errors.push('The column ' + carry[i] + ' is not in this table.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

/**
 * The glass-box SQL.
 *
 * LEAD over the entity gives each event the next event's date, and the window test
 * is one BETWEEN on the difference. The censoring cut is a separate, visible
 * predicate rather than something folded into the rate, because it is the part a
 * reader most needs to check.
 */
export function buildRecurrenceSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const rel = relationName(sourceRelation, 'your_table');
  const ents = asColumnList(config.entityColumns);
  const keys = ents.map(quoteIdent);
  const date = quoteIdent(config.dateColumn);
  const win = Math.max(1, Math.floor(Number(config.windowDays) || DEFAULT_WINDOW_DAYS));
  const gap = Math.max(0, Math.floor(Number(config.minGapDays == null ? 1 : config.minGapDays)));
  const partition = keys.length ? keys.join(', ') : '1';
  const scope = String(config.indexScope || 'all');

  const lines = [
    '-- Does the same entity have another event within ' + win + ' days.',
    '-- days_to_return is the gap from the index event to the very next event, so an',
    '-- entity with events on day 1, 3 and 5 gives two pairs and not three: every',
    '-- index event contributes at most one return.',
    'WITH events AS (',
    '  SELECT ' + keys.concat([
      'CAST(' + date + ' AS DATE) AS event_date',
    ]).join(', ') + ',',
    '    LEAD(CAST(' + date + ' AS DATE)) OVER (',
    '      PARTITION BY ' + partition + ' ORDER BY CAST(' + date + ' AS DATE)',
    '    ) AS next_date',
    '  FROM ' + rel,
    '  WHERE ' + date + ' IS NOT NULL',
    '), scored AS (',
    '  SELECT *,',
    '    date_diff(' + "'day'" + ', event_date, next_date) AS days_to_return,',
    '    -- An event this close to the end of the data has not had ' + win + ' days to',
    '    -- recur yet. Calling it "did not return" would be reading the calendar as a',
    '    -- finding, so it is marked and excluded from the honest rate.',
    "    event_date > (SELECT MAX(CAST(" + date + ' AS DATE)) FROM ' + rel + ') - INTERVAL \''
      + win + " day' AS censored",
    '  FROM events',
    ')',
    'SELECT ' + keys.concat([
      'event_date AS index_date',
    ]).join(', ') + ',',
    '  next_date AS return_date,',
    '  days_to_return,',
    '  censored',
    'FROM scored',
    'WHERE days_to_return BETWEEN ' + gap + ' AND ' + win,
  ];
  if (scope === 'first') {
    lines.push('  -- Only the first event per entity starts a window.');
    lines.push('  AND event_date = (SELECT MIN(CAST(' + date + ' AS DATE)) FROM ' + rel + ' e2');
    lines.push('    WHERE ' + (keys.length
      ? keys.map((k) => 'e2.' + k + ' IS NOT DISTINCT FROM scored.' + k).join(' AND ')
      : 'TRUE') + ')');
  } else if (scope === 'last') {
    lines.push('  -- Only the most recent event per entity starts a window.');
    lines.push('  AND event_date = (SELECT MAX(CAST(' + date + ' AS DATE)) FROM ' + rel + ' e2');
    lines.push('    WHERE ' + (keys.length
      ? keys.map((k) => 'e2.' + k + ' IS NOT DISTINCT FROM scored.' + k).join(' AND ')
      : 'TRUE') + ')');
  }
  lines.push('ORDER BY ' + keys.concat(['index_date']).join(', '));

  lines.push('');
  lines.push('-- The rate. Two of them, because the denominator is the whole argument:');
  lines.push('--   returns / eligible events is the honest rate, where an eligible event is one');
  lines.push('--   with a full ' + win + ' days of data after it.');
  lines.push('--   returns / all events is what a query without the censoring test returns. It');
  lines.push('--   is always lower, by an amount that grows with the window.');
  lines.push('-- SELECT');
  lines.push('--   COUNT(*) FILTER (WHERE days_to_return BETWEEN ' + gap + ' AND ' + win
    + ') AS returns,');
  lines.push('--   COUNT(*) FILTER (WHERE NOT censored) AS eligible_events,');
  lines.push('--   COUNT(*) AS all_events');
  lines.push('-- FROM scored;');
  if (gap > 0) {
    lines.push('-- The gap starts at ' + gap + ' day' + (gap === 1 ? '' : 's') + ', so two events on');
    lines.push('-- the same date are not a return. A zero-day gap is duplicate data far more');
    lines.push('-- often than it is a genuine same-day return.');
  }

  return { ok: true, sql: lines.join('\n') };
}

export function windowRecurrenceTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateRecurrenceConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const ents = asColumnList(config.entityColumns);
  const entIdxs = ents.map((n) => indexOfColumn(names, n));
  const dateIdx = indexOfColumn(names, config.dateColumn);
  const carry = asColumnList(config.carryColumns);
  const carryIdxs = carry.map((n) => indexOfColumn(names, n));
  const win = Math.max(1, Math.floor(Number(config.windowDays) || DEFAULT_WINDOW_DAYS));
  const gap = Math.max(0, Math.floor(Number(config.minGapDays == null ? 1 : config.minGapDays)));
  const scope = String(config.indexScope || 'all');

  const srcRows = rowsOf(dataset);
  const byEntity = new Map();
  let unreadableDates = 0;
  let latest = null;

  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    const d = parseDateValue(row[dateIdx]);
    if (!d) { unreadableDates += 1; continue; }
    if (!latest || d.getTime() > latest.getTime()) latest = d;
    const key = keyOfRow(row, entIdxs);
    let bucket = byEntity.get(key);
    if (!bucket) { bucket = { rows: [], key: key }; byEntity.set(key, bucket); }
    bucket.rows.push({ date: d, row: row });
  }

  // The end of observation is the last date in the data unless told otherwise. A
  // table that stops because the export stopped is not a table where nothing
  // happened after that, and the caller may know the real cut-off.
  const declaredEnd = config.observationEnd ? parseDateValue(config.observationEnd) : null;
  const observationEnd = declaredEnd || latest;
  const censorCut = observationEnd ? addDays(observationEnd, -win) : null;

  const pairs = [];
  let events = 0;
  let indexEvents = 0;
  let eligibleIndexEvents = 0;
  let censoredIndexEvents = 0;
  let returns = 0;
  let censoredReturns = 0;
  let sameDayPairs = 0;
  let beyondWindow = 0;
  let singleEventEntities = 0;
  let daysTotal = 0;

  const entities = Array.from(byEntity.values());
  for (let e = 0; e < entities.length; e += 1) {
    const list = entities[e].rows;
    list.sort((a, b) => a.date.getTime() - b.date.getTime());
    events += list.length;
    if (list.length === 1) singleEventEntities += 1;

    for (let i = 0; i < list.length; i += 1) {
      if (scope === 'first' && i !== 0) continue;
      if (scope === 'last' && i !== list.length - 1) continue;
      indexEvents += 1;
      const censored = censorCut ? list[i].date.getTime() > censorCut.getTime() : false;
      if (censored) censoredIndexEvents += 1; else eligibleIndexEvents += 1;

      // The next event only. Day 1, 3, 5 is two pairs, not three.
      if (i + 1 >= list.length) continue;
      const days = daysBetween(list[i].date, list[i + 1].date);
      if (days == null) continue;
      if (days < gap) {
        if (days === 0) sameDayPairs += 1;
        continue;
      }
      if (days > win) { beyondWindow += 1; continue; }

      returns += 1;
      daysTotal += days;
      if (censored) censoredReturns += 1;
      pairs.push({
        row: list[i].row,
        indexDate: list[i].date,
        returnDate: list[i + 1].date,
        days: days,
        censored: censored,
      });
    }
  }

  const outColumns = ents.map((n) => column(n, TYPE_STR))
    .concat([
      column('index_date', TYPE_DATE),
      column('return_date', TYPE_DATE),
      column('days_to_return', TYPE_INT),
      column('within_censored_tail', TYPE_BOOL),
    ])
    .concat(carry.map((n) => column(n, TYPE_STR)));

  pairs.sort((a, b) => (a.indexDate.getTime() - b.indexDate.getTime())
    || (a.returnDate.getTime() - b.returnDate.getTime()));

  const rowsOut = pairs.map((p) => entIdxs.map((idx) => {
    const cell = p.row[idx];
    return cell == null ? '' : String(cell);
  }).concat([
    formatISODate(p.indexDate),
    formatISODate(p.returnDate),
    p.days,
    p.censored,
  ]).concat(carryIdxs.map((idx) => {
    const cell = p.row[idx];
    return cell == null ? '' : String(cell);
  })));

  const eligibleReturns = returns - censoredReturns;
  const rateEligible = eligibleIndexEvents
    ? Math.round((1000 * eligibleReturns) / eligibleIndexEvents) / 10
    : 0;
  const rateAll = indexEvents ? Math.round((1000 * returns) / indexEvents) / 10 : 0;
  const averageDays = returns ? Math.round((10 * daysTotal) / returns) / 10 : 0;

  const built = buildRecurrenceSQL(config, dataset.name);
  const notes = [];

  if (!events) {
    notes.push('No row had a readable date, so no window could be measured.');
  } else {
    notes.push('The rate of return within ' + win + ' days is ' + rateEligible + '%, counted as '
      + eligibleReturns + ' return' + (eligibleReturns === 1 ? '' : 's') + ' out of '
      + eligibleIndexEvents + ' eligible event' + (eligibleIndexEvents === 1 ? '' : 's') + '. '
      + 'An eligible event is one with a full ' + win + ' days of data after it.');
    notes.push('Over every event instead, including the ones too recent to have had ' + win
      + ' days, the same figure reads ' + rateAll + '%. That lower number is what a query '
      + 'without the censoring test returns. The difference is not a correction of one by the '
      + 'other: the first answers "how often do entities come back", the second answers "what '
      + 'share of the rows in this file are followed by a return", and only the first is a rate.');
  }

  if (censoredIndexEvents > 0 && observationEnd) {
    notes.push(censoredIndexEvents + ' event' + (censoredIndexEvents === 1 ? '' : 's')
      + ' fall in the last ' + win + ' days of the data, which ends '
      + formatISODate(observationEnd) + (declaredEnd ? ' as given' : ' as far as this table shows')
      + '. They have not been observed long enough to return, so they are '
      + (config.excludeCensored === false
        ? 'included in the rate above anyway, at your instruction, which pushes it down.'
        : 'left out of the eligible denominator.')
      + (declaredEnd ? '' : ' If the export simply stopped there rather than the observation '
        + 'ending there, say so, because it changes this count.'));
  }

  if (sameDayPairs > 0) {
    notes.push(sameDayPairs + ' pair' + (sameDayPairs === 1 ? '' : 's') + ' of events share a date '
      + 'and ' + (sameDayPairs === 1 ? 'was' : 'were') + ' not counted as a return, because the '
      + 'smallest gap is ' + gap + ' day' + (gap === 1 ? '' : 's') + '. A zero-day gap is the same '
      + 'event entered twice far more often than it is a genuine same-day return, but if these are '
      + 'real, set the smallest gap to zero.');
  }
  if (beyondWindow > 0) {
    notes.push(beyondWindow + ' event' + (beyondWindow === 1 ? '' : 's') + ' had a next event, but '
      + 'later than ' + win + ' days, so ' + (beyondWindow === 1 ? 'it is' : 'they are')
      + ' counted as no return. Widening the window would move '
      + (beyondWindow === 1 ? 'it' : 'them') + ' across, which is worth '
      + 'knowing before treating ' + win + ' days as a natural boundary.');
  }
  if (singleEventEntities > 0) {
    notes.push(singleEventEntities + ' entit' + (singleEventEntities === 1 ? 'y has' : 'ies have')
      + ' a single event and so cannot return. They are in the denominator, because "never came '
      + 'back" is the answer this measure exists to count.');
  }
  if (returns > 0) {
    notes.push('The average gap on the returns found is ' + averageDays + ' day'
      + (averageDays === 1 ? '' : 's') + '. A gap clustered right at ' + win + ' days usually means '
      + 'the window is cutting through a real pattern rather than containing one.');
  }
  if (unreadableDates > 0) {
    notes.push(unreadableDates + ' row' + (unreadableDates === 1 ? '' : 's') + ' had no readable '
      + 'date and ' + (unreadableDates === 1 ? 'was' : 'were') + ' dropped before any counting. '
      + 'A dropped row between two events can turn a real return into a gap, so this count '
      + 'is a floor on the returns rather than an exact figure.');
  }
  if (scope !== 'all') {
    notes.push('Only the ' + (scope === 'first' ? 'first' : 'most recent') + ' event per entity '
      + 'starts a window, so this is a rate per entity and not per event. The two differ whenever '
      + 'an entity has several events, and they are not comparable.');
  }

  return transformResult({
    columns: outColumns,
    rows: rowsOut,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: rowsOut.length,
      entities: byEntity.size,
      events: events,
      indexEvents: indexEvents,
      eligibleIndexEvents: eligibleIndexEvents,
      censoredIndexEvents: censoredIndexEvents,
      returns: returns,
      eligibleReturns: eligibleReturns,
      rateEligible: rateEligible,
      rateAll: rateAll,
      averageDays: averageDays,
      sameDayPairs: sameDayPairs,
      beyondWindow: beyondWindow,
      singleEventEntities: singleEventEntities,
      unreadableDates: unreadableDates,
      windowDays: win,
      observationEnd: observationEnd ? formatISODate(observationEnd) : '',
      observationEndDeclared: !!declaredEnd,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header. Leads with the honest rate and names
    its denominator in the same breath, because the rate alone is ambiguous. */
export function describeWindowRecurrence(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  if (!s.events) return 'No row had a readable date, so no window could be measured.';
  const head = s.rateEligible + '% return within ' + s.windowDays + ' days, from '
    + s.eligibleReturns.toLocaleString() + ' return'
    + (s.eligibleReturns === 1 ? '' : 's') + ' out of ' + s.eligibleIndexEvents.toLocaleString()
    + ' event' + (s.eligibleIndexEvents === 1 ? '' : 's') + ' observed long enough to count.';
  if (!s.censoredIndexEvents) return head;
  return head + ' ' + s.censoredIndexEvents.toLocaleString() + ' event'
    + (s.censoredIndexEvents === 1 ? ' is' : 's are') + ' too recent to have had '
    + s.windowDays + ' days, and counting ' + (s.censoredIndexEvents === 1 ? 'it' : 'them')
    + ' anyway would read the rate as ' + s.rateAll + '%.';
}

export const DataGlowWindowRecurrence = {
  WINDOW_RECURRENCE_VERSION,
  INDEX_SCOPES,
  INDEX_SCOPE_LABELS,
  DEFAULT_WINDOW_DAYS,
  createEmptyRecurrenceConfig,
  suggestRecurrenceConfig,
  validateRecurrenceConfig,
  buildRecurrenceSQL,
  windowRecurrenceTransform,
  describeWindowRecurrence,
};
