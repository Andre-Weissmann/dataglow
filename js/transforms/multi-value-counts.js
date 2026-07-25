// ============================================================
// DATAGLOW - A23 Multi-value field counts, honestly
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. A column holds "Cardiology; Endocrinology" or
// "email,sms,push" or a JSON array of tags. Somebody wants to know how many
// records fall in each category. Counting the raw cell counts the combination,
// not the categories, so "Cardiology; Endocrinology" becomes its own bucket with
// a count of one and neither real category is counted at all.
//
// THE POINT OF THIS MODULE IS THE ARITHMETIC IT REFUSES TO HIDE.
// Split the cell and count each value, and the counts now sum to more than the
// number of records, because one record is in several categories. That is not an
// error, it is what multi-membership means. The error is presenting those counts
// with a percentage denominator that implies they are exclusive, which is what
// every naive version of this does: percentages that sum to 180% get quietly
// rescaled by a reader into something that adds to 100, and the conclusion drawn
// from it is wrong.
//
// SO EVERY COUNT HERE CARRIES TWO PERCENTAGES, BOTH LABELLED.
//   pct_of_records  count / number of records. Reads as "34% of patients have a
//                   cardiology tag". These sum to more than 100 whenever any
//                   record has more than one value, and that is correct.
//   pct_of_mentions count / total number of values mentioned. These sum to 100
//                   and answer a different question: share of tags, not share of
//                   people.
// Both are shown because either one alone gets misread as the other. The notes
// state the sum out loud whenever it exceeds 100.
//
// A RECORD IS COUNTED ONCE PER CATEGORY, NOT ONCE PER MENTION.
// "asthma, asthma" is one record with asthma, not two. The duplicate mentions are
// counted separately and reported, because a column full of them is usually a
// concatenation bug rather than a fact about the record.
//
// AN EMPTY CELL IS A REAL ANSWER AND IS NOT DROPPED FROM THE DENOMINATOR.
// A record with no tags is still a record. Removing it from the denominator
// inflates every percentage, so it is kept, counted, and reported as its own line
// when asked for.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isPlainObject,
  asColumnList,
  keyOfRow,
  readList,
  cellText,
  column,
  typeOfColumn,
  TYPE_INT,
  TYPE_FLOAT,
  TYPE_STR,
  transformResult,
  transformError,
} from './transform-core.js';

export const MULTI_VALUE_COUNTS_VERSION = 1;

export const VALUE_SOURCES = Object.freeze(['auto', 'json', 'delimited']);

export const VALUE_SOURCE_LABELS = Object.freeze({
  auto: 'Work it out from the cell',
  json: 'A JSON array',
  delimited: 'Separated by a character',
});

export const CASE_MODES = Object.freeze(['exact', 'fold']);

export const CASE_LABELS = Object.freeze({
  exact: 'Treat different capitalisation as different values',
  fold: 'Treat Email and email as the same value',
});

// Above this the list is no longer a list of categories, it is free text, and
// counting it produces a table with one row per record and no insight.
export const TOO_MANY_DISTINCT = 500;

/** Separators worth guessing at, most common first. */
export const CANDIDATE_DELIMITERS = Object.freeze([',', ';', '|']);

export function createEmptyMultiValueConfig() {
  return {
    valueColumn: '',
    source: 'auto',
    delimiter: ',',
    caseMode: 'fold',
    trim: true,
    recordColumns: [],
    includeEmpty: true,
    minCount: 1,
    topN: 0,
  };
}

export function suggestMultiValueConfig(dataset) {
  const cfg = createEmptyMultiValueConfig();
  const names = columnNamesOf(dataset);
  const rows = rowsOf(dataset);

  // Suggest the column that most often holds several values. A column that never
  // splits makes this transform a plain value count, which is not the point.
  // Each candidate separator is tried, because guessing a comma against a
  // semicolon-separated column finds nothing and reads as "no such column here".
  let best = null;
  for (let i = 0; i < names.length; i += 1) {
    for (let d = 0; d < CANDIDATE_DELIMITERS.length; d += 1) {
      const delim = CANDIDATE_DELIMITERS[d];
      let multi = 0;
      let looked = 0;
      for (let r = 0; r < rows.length && looked < 400; r += 1) {
        if (!Array.isArray(rows[r])) continue;
        const cell = rows[r][i];
        if (cell == null || cell === '') continue;
        looked += 1;
        if (readList(cell, 'auto', delim).values.length > 1) multi += 1;
      }
      if (!looked) continue;
      const share = multi / looked;
      if (share > 0 && (!best || share > best.share)) {
        best = { name: names[i], share: share, delimiter: delim };
      }
    }
  }
  if (best) {
    cfg.valueColumn = best.name;
    cfg.delimiter = best.delimiter;
  }
  return cfg;
}

export function validateMultiValueConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  if (!config.valueColumn) {
    errors.push('Pick the column that holds several values in one cell.');
  } else if (!names.includes(config.valueColumn)) {
    errors.push('The column ' + config.valueColumn + ' is not in this table.');
  }

  if (config.source && VALUE_SOURCES.indexOf(config.source) === -1) {
    errors.push('Choose how the values in a cell are separated.');
  }
  if (String(config.source || 'auto') === 'delimited' && !String(config.delimiter || '')) {
    errors.push('Give the character that separates the values.');
  }
  if (config.caseMode && CASE_MODES.indexOf(config.caseMode) === -1) {
    errors.push('Choose whether capitalisation makes two values different.');
  }

  const recs = asColumnList(config.recordColumns);
  for (let i = 0; i < recs.length; i += 1) {
    if (!names.includes(recs[i])) {
      errors.push('The column ' + recs[i] + ' is not in this table.');
    } else if (recs[i] === config.valueColumn) {
      errors.push('The value column cannot also identify the record.');
    }
  }

  const min = Number(config.minCount);
  if (config.minCount !== '' && config.minCount != null
    && (!Number.isFinite(min) || min < 1 || Math.floor(min) !== min)) {
    errors.push('The smallest count to show has to be a whole number of one or more.');
  }
  const top = Number(config.topN || 0);
  if (config.topN && (!Number.isFinite(top) || top < 1 || Math.floor(top) !== top)) {
    errors.push('The number of values to show has to be a whole number of one or more.');
  }

  return { ok: errors.length === 0, errors: errors };
}

/** The label used for a record that has no values at all. Written out rather than
    left blank, because a blank row in a count table reads as a bug. */
export const NO_VALUE_LABEL = '(no value)';

function normalise(text, config) {
  let s = config && config.trim === false ? text : text.trim();
  if (String((config && config.caseMode) || 'fold') === 'fold') s = s.toLowerCase();
  return s;
}

/**
 * The glass-box SQL.
 *
 * UNNEST over the split list, then count DISTINCT records per value, not COUNT(*).
 * That DISTINCT is the difference between counting records and counting mentions,
 * and both denominators appear as scalar subqueries so a reader can see exactly
 * what each percentage is a percentage of.
 */
export function buildMultiValueCountsSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const rel = relationName(sourceRelation, 'your_table');
  const col = quoteIdent(config.valueColumn);
  const source = String(config.source || 'auto');
  const delim = String(config.delimiter || ',');
  const fold = String(config.caseMode || 'fold') === 'fold';
  const recs = asColumnList(config.recordColumns);
  const recordKey = recs.length ? recs.map(quoteIdent).join(', ') : 'rowid';
  const min = Math.max(1, Math.floor(Number(config.minCount) || 1));
  const top = Math.max(0, Math.floor(Number(config.topN) || 0));

  const split = source === 'json'
    ? 'json_extract_string(' + col + ", '$[*]')"
    : 'str_split(CAST(' + col + ' AS VARCHAR), ' + "'" + delim.replace(/'/g, "''") + "')";
  const value = fold ? 'lower(trim(item))' : 'trim(item)';

  const lines = [
    '-- How many records fall in each value of ' + col + ', where one cell can hold several.',
    '-- The two percentages answer two different questions and are both shown on purpose:',
    '--   pct_of_records  share of RECORDS carrying this value. Sums to MORE than 100',
    '--                   whenever a record has more than one value. That is correct.',
    '--   pct_of_mentions share of MENTIONS. Sums to 100.',
    '-- Reading the first as if it were the second is the mistake this table exists to stop.',
    'WITH exploded AS (',
    '  SELECT ' + recordKey + ' AS record_key, ' + value + ' AS value',
    '  FROM ' + rel + ', UNNEST(' + split + ') AS dg_values(item)',
    "  WHERE item IS NOT NULL AND trim(item) <> ''",
    '), per_value AS (',
    '  -- COUNT(DISTINCT record_key), not COUNT(*): a cell reading "asthma, asthma" is',
    '  -- one record with asthma, not two.',
    '  SELECT value,',
    '    COUNT(DISTINCT record_key) AS records,',
    '    COUNT(*) AS mentions',
    '  FROM exploded GROUP BY value',
    ')',
    'SELECT value,',
    '  records,',
    '  mentions,',
    '  ROUND(100.0 * records / (SELECT COUNT(*) FROM ' + rel + '), 1) AS pct_of_records,',
    '  ROUND(100.0 * mentions / (SELECT SUM(mentions) FROM per_value), 1) AS pct_of_mentions',
    'FROM per_value',
  ];
  if (min > 1) lines.push('WHERE records >= ' + min);
  lines.push('ORDER BY records DESC, value');
  if (top) lines.push('LIMIT ' + top);

  lines.push('');
  lines.push('-- The denominator of pct_of_records is COUNT(*) over the whole table, which');
  lines.push('-- includes records whose cell was empty. Excluding them would raise every');
  lines.push('-- percentage here, and a record with no value is still a record.');

  return { ok: true, sql: lines.join('\n') };
}

export function multiValueCountsTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateMultiValueConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const valIdx = indexOfColumn(names, config.valueColumn);
  const recs = asColumnList(config.recordColumns);
  const recIdxs = recs.map((n) => indexOfColumn(names, n));
  const source = String(config.source || 'auto');
  const delim = String(config.delimiter || ',');
  const min = Math.max(1, Math.floor(Number(config.minCount) || 1));
  const top = Math.max(0, Math.floor(Number(config.topN) || 0));

  const srcRows = rowsOf(dataset);
  const tally = new Map();
  let records = 0;
  let emptyRecords = 0;
  let mentions = 0;
  let duplicateMentions = 0;
  let unreadable = 0;
  let multiValueRecords = 0;
  let maxPerRecord = 0;

  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    records += 1;

    const parsed = readList(row[valIdx], source, delim);
    if (parsed.kind === 'unreadable') { unreadable += 1; continue; }
    if (parsed.kind === 'empty') { emptyRecords += 1; continue; }

    // Per record, so a record is counted once per category however many times it
    // mentions it. The identity of the record is its key columns when given, and
    // its position otherwise, which is what rowid means in the SQL above.
    const seenHere = new Set();
    let kept = 0;
    for (let j = 0; j < parsed.values.length; j += 1) {
      const text = cellText(parsed.values[j], config.trim !== false);
      if (text == null || text === '') continue;
      const key = normalise(text, config);
      if (key === '') continue;
      mentions += 1;
      kept += 1;
      if (seenHere.has(key)) { duplicateMentions += 1; continue; }
      seenHere.add(key);

      let t = tally.get(key);
      if (!t) { t = { key: key, label: text, records: 0, mentions: 0, seq: tally.size }; tally.set(key, t); }
      t.records += 1;
    }
    // Mentions are tallied per value after the record loop so a repeated value
    // adds to mentions without adding to records.
    for (let j = 0; j < parsed.values.length; j += 1) {
      const text = cellText(parsed.values[j], config.trim !== false);
      if (text == null || text === '') continue;
      const key = normalise(text, config);
      if (key === '') continue;
      const t = tally.get(key);
      if (t) t.mentions += 1;
    }

    if (!kept) { emptyRecords += 1; continue; }
    if (seenHere.size > 1) multiValueRecords += 1;
    if (seenHere.size > maxPerRecord) maxPerRecord = seenHere.size;
  }

  const outColumns = [
    column(config.valueColumn, TYPE_STR),
    column('records', TYPE_INT),
    column('mentions', TYPE_INT),
    column('pct_of_records', TYPE_FLOAT),
    column('pct_of_mentions', TYPE_FLOAT),
  ];

  const all = Array.from(tally.values());
  all.sort((a, b) => (b.records - a.records) || a.label.localeCompare(b.label));

  const distinct = all.length;
  let hidden = 0;
  const rowsOut = [];
  for (let i = 0; i < all.length; i += 1) {
    const t = all[i];
    if (t.records < min) { hidden += 1; continue; }
    if (top && rowsOut.length >= top) { hidden += 1; continue; }
    rowsOut.push([
      t.label,
      t.records,
      t.mentions,
      records ? Math.round((1000 * t.records) / records) / 10 : 0,
      mentions ? Math.round((1000 * t.mentions) / mentions) / 10 : 0,
    ]);
  }

  if (config.includeEmpty !== false && emptyRecords > 0) {
    rowsOut.push([
      NO_VALUE_LABEL,
      emptyRecords,
      0,
      records ? Math.round((1000 * emptyRecords) / records) / 10 : 0,
      0,
    ]);
  }

  const pctSum = records
    ? Math.round((1000 * mentions) / records) / 10
    : 0;
  const recordPctSum = rowsOut.reduce((acc, r) => (r[0] === NO_VALUE_LABEL ? acc : acc + r[3]), 0);

  const built = buildMultiValueCountsSQL(config, dataset.name);
  const notes = [];

  if (!records) {
    notes.push('The table has no rows, so there is nothing to count.');
  } else if (multiValueRecords > 0) {
    notes.push(multiValueRecords + ' of ' + records + ' record'
      + (records === 1 ? '' : 's') + ' hold more than one value, up to ' + maxPerRecord
      + ' at once. This means a record is counted in several rows below, on purpose. '
      + 'pct_of_records therefore adds up to about ' + Math.round(recordPctSum * 10) / 10
      + '%, not 100%, and that is the correct answer rather than a rounding fault.');
  } else {
    notes.push('No record holds more than one value, so every record appears in exactly one row '
      + 'below and pct_of_records behaves like an ordinary share. The moment a multi-value cell '
      + 'appears that stops being true.');
  }

  notes.push('The two percentage columns answer different questions. pct_of_records is the share '
    + 'of records carrying the value, which is what "how many of our customers use sms" means. '
    + 'pct_of_mentions is the share of all values mentioned, which sums to 100 and is what a pie '
    + 'chart of this column would show. They are not interchangeable and neither one is a '
    + 'correction of the other.');

  if (records && mentions) {
    notes.push('There are ' + mentions + ' value mentions across ' + records + ' record'
      + (records === 1 ? '' : 's') + ', an average of ' + (Math.round((10 * mentions) / records) / 10)
      + ' each. Any total, average or chart built from the records column is over memberships and '
      + 'not over records, so it should not be compared against a plain row count of this table.');
  }

  if (duplicateMentions > 0) {
    notes.push(duplicateMentions + ' mention' + (duplicateMentions === 1 ? '' : 's') + ' repeated a '
      + 'value already present in the same record, and '
      + (duplicateMentions === 1 ? 'was' : 'were') + ' counted in mentions but not twice in '
      + 'records. A cell holding the same value twice is usually a concatenation that ran more '
      + 'than once rather than a fact about the record.');
  }
  if (emptyRecords > 0) {
    notes.push(emptyRecords + ' record' + (emptyRecords === 1 ? ' has' : 's have') + ' no value at '
      + 'all. ' + (config.includeEmpty !== false
        ? 'They are shown as the ' + NO_VALUE_LABEL + ' row, and they stay in the denominator of '
          + 'pct_of_records.'
        : 'They are not shown, but they are still in the denominator of pct_of_records, because '
          + 'dropping them would raise every percentage in this table.'));
  }
  if (unreadable > 0) {
    notes.push(unreadable + ' cell' + (unreadable === 1 ? '' : 's') + ' could not be read as a list '
      + 'in the chosen format and were skipped entirely. Those records are in the denominator but '
      + 'in none of the values, so every percentage here is slightly low rather than slightly high.');
  }
  if (hidden > 0) {
    notes.push(hidden + ' value' + (hidden === 1 ? ' is' : 's are') + ' not shown, because of the '
      + (top ? 'top ' + top + ' limit' : 'minimum count of ' + min)
      + '. The percentages are still calculated over everything, so the visible rows will not add '
      + 'up to the totals stated above.');
  }
  if (distinct >= TOO_MANY_DISTINCT) {
    notes.push('There are ' + distinct + ' distinct values, which is more than this kind of count '
      + 'usually means anything at. A column with this many distinct entries is closer to free '
      + 'text than to a set of categories; standardising the values first would change the answer '
      + 'substantially.');
  }

  return transformResult({
    columns: outColumns,
    rows: rowsOut,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: rowsOut.length,
      records: records,
      distinctValues: distinct,
      mentions: mentions,
      mentionsPerRecord: records ? mentions / records : 0,
      multiValueRecords: multiValueRecords,
      maxPerRecord: maxPerRecord,
      duplicateMentions: duplicateMentions,
      emptyRecords: emptyRecords,
      unreadable: unreadable,
      hidden: hidden,
      recordPctSum: Math.round(recordPctSum * 10) / 10,
      mentionsPctOfRecords: pctSum,
      exclusive: multiValueRecords === 0,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header. Leads with the double count when
    there is one, because that is the thing a reader must know before the number. */
export function describeMultiValueCounts(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  if (!s.records) return 'The table has no rows, so there is nothing to count.';
  if (!s.distinctValues) return 'No value could be read from that column.';
  const head = s.distinctValues.toLocaleString() + ' distinct value'
    + (s.distinctValues === 1 ? '' : 's') + ' across ' + s.records.toLocaleString() + ' record'
    + (s.records === 1 ? '' : 's') + '.';
  if (s.exclusive) {
    return head + ' No record has more than one, so the shares behave like ordinary percentages.';
  }
  return head + ' ' + s.multiValueRecords.toLocaleString() + ' record'
    + (s.multiValueRecords === 1 ? '' : 's') + ' hold several values, so the record shares sum to '
    + 'about ' + s.recordPctSum + '% rather than 100%.';
}

export const DataGlowMultiValueCounts = {
  MULTI_VALUE_COUNTS_VERSION,
  VALUE_SOURCES,
  VALUE_SOURCE_LABELS,
  CASE_MODES,
  CASE_LABELS,
  TOO_MANY_DISTINCT,
  CANDIDATE_DELIMITERS,
  NO_VALUE_LABEL,
  createEmptyMultiValueConfig,
  suggestMultiValueConfig,
  validateMultiValueConfig,
  buildMultiValueCountsSQL,
  multiValueCountsTransform,
  describeMultiValueCounts,
};
