// ============================================================
// DATAGLOW - A24 As-of lookup (the value that was true on that date)
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. "What was the price when this sale happened?", "what was
// this account's tier on the day of the claim?", "what was the exchange rate on
// the invoice date?" For every fact row, it finds the reference row that was in
// force at that moment: the one with the greatest effective date at or before
// the fact's date.
//
// THE ERROR THIS PREVENTS IS THE MOST EXPENSIVE ONE IN THIS BUNDLE.
// The natural thing to do with a price table is join on product id. If that table
// holds one row per product, you get today's price. Multiply it by last year's
// units and you have revenue that never happened, in a number that looks
// completely ordinary and will be quoted in a meeting. Nothing in the output of
// that join says anything is wrong. The only defence is to make the point in time
// part of the join, which is what this does.
//
// WHY IT IS NOT A RANGE JOIN (A19).
// A19 needs the reference table to carry a start AND an end. Reference data
// usually does not: a price list is a series of "from this date, the price is X"
// rows, and the end of each row is implied by the start of the next. Deriving
// those ends and then range-joining works, but it breaks the moment two rows
// share an effective date, and it invents data. Taking the latest row at or
// before the fact date needs no invented column and is what a database's ASOF
// JOIN does.
//
// THREE THINGS IT REFUSES TO DO QUIETLY.
//   1. A fact earlier than every reference row gets NULLs, never the first
//      reference row. "The oldest price we have" is not "the price then", and
//      back-filling it is exactly the fabrication this module exists to stop.
//      Those facts are counted and named in the notes.
//   2. Two reference rows sharing one effective date are a genuine ambiguity, so
//      the tie is broken by taking the LAST such row in table order and the count
//      is reported. Silently averaging them or picking one without saying so
//      would hide a defect in the reference table.
//   3. A fact whose date cannot be read is excluded and counted, not treated as
//      today. Treating an unreadable date as now is how you get today's price on
//      an old sale by a different route.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  suggestDateColumn,
  parseDateValue,
  formatISODate,
  isPlainObject,
  asColumnList,
  keyOfRow,
  column,
  typeOfColumn,
  transformResult,
  transformError,
} from './transform-core.js';

export const AS_OF_LOOKUP_VERSION = 1;

export function createEmptyAsOfConfig() {
  return {
    factDateColumn: '',
    refDateColumn: '',
    keyPairs: [],
    valueColumns: [],
    refSuffix: '_asof',
  };
}

export function suggestAsOfConfig(factDataset, refDataset) {
  const cfg = createEmptyAsOfConfig();
  cfg.factDateColumn = suggestDateColumn(factDataset) || '';
  const refNames = columnNamesOf(refDataset);
  cfg.refDateColumn = pickByHint(refNames, ['effective', 'valid_from', 'as_of', 'start', 'from'])
    || suggestDateColumn(refDataset) || '';
  return cfg;
}

function pickByHint(names, hints) {
  for (let h = 0; h < hints.length; h += 1) {
    for (let i = 0; i < names.length; i += 1) {
      if (String(names[i] || '').toLowerCase().includes(hints[h])) return names[i];
    }
  }
  return null;
}

export function validateAsOfConfig(config, factNames, refNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const facts = Array.isArray(factNames) ? factNames : [];
  const refs = Array.isArray(refNames) ? refNames : [];

  if (!config.factDateColumn) errors.push('Pick the date column on the main table.');
  else if (!facts.includes(config.factDateColumn)) {
    errors.push('The date column ' + config.factDateColumn + ' is not in the main table.');
  }

  if (!config.refDateColumn) errors.push('Pick the effective-date column on the lookup table.');
  else if (!refs.includes(config.refDateColumn)) {
    errors.push('The effective-date column ' + config.refDateColumn
      + ' is not in the lookup table.');
  }

  const pairs = normalizeKeyPairs(config.keyPairs);
  for (let i = 0; i < pairs.length; i += 1) {
    if (!facts.includes(pairs[i].left)) {
      errors.push('The matching column ' + pairs[i].left + ' is not in the main table.');
    }
    if (!refs.includes(pairs[i].right)) {
      errors.push('The matching column ' + pairs[i].right + ' is not in the lookup table.');
    }
  }

  const wanted = asColumnList(config.valueColumns);
  for (let i = 0; i < wanted.length; i += 1) {
    if (!refs.includes(wanted[i])) {
      errors.push('The column to bring across, ' + wanted[i] + ', is not in the lookup table.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

export function normalizeKeyPairs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const p = value[i];
    if (!isPlainObject(p)) continue;
    const l = p.left == null ? '' : String(p.left);
    const r = p.right == null ? '' : String(p.right);
    if (l && r) out.push({ left: l, right: r });
  }
  return out;
}

/** The columns brought across from the lookup table. Defaults to everything
    except the effective date and the matching keys, since those are already on
    the fact row and repeating them is noise. */
export function broughtColumns(config, refNames) {
  const names = Array.isArray(refNames) ? refNames : [];
  const explicit = asColumnList(config && config.valueColumns);
  if (explicit.length > 0) return explicit.filter((n) => names.includes(n));
  const pairs = normalizeKeyPairs(config && config.keyPairs).map((p) => p.right);
  const dateCol = (config && config.refDateColumn) || '';
  return names.filter((n) => n !== dateCol && !pairs.includes(n));
}

/**
 * The glass-box SQL. DuckDB's ASOF JOIN, which says exactly this in one clause,
 * with the equivalent window form underneath as a comment for engines that do
 * not have it. Both are shown because a person checking the number should be
 * able to run it wherever they are.
 */
export function buildAsOfSQL(config, factRelation, refRelation, refNames) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };

  const f = relationName(factRelation, 'facts');
  const r = relationName(refRelation, 'lookup');
  const pairs = normalizeKeyPairs(config.keyPairs);
  const factDate = 'f.' + quoteIdent(config.factDateColumn);
  const refDate = 'r.' + quoteIdent(config.refDateColumn);
  const bring = broughtColumns(config, refNames);
  const suffix = String(config.refSuffix || '_asof');

  const onParts = pairs.map((p) => 'f.' + quoteIdent(p.left) + ' = r.' + quoteIdent(p.right));
  onParts.push(factDate + ' >= ' + refDate);

  const selected = ['f.*'].concat(bring.map((n) => 'r.' + quoteIdent(n) + ' AS ' + quoteIdent(n + suffix)));

  const lines = [
    '-- As-of lookup: the ' + r + ' row that was in force on each ' + f + ' date.',
    '-- Not the current row. A fact dated before every lookup row gets NULL rather',
    '-- than the oldest value, because the oldest value on record is not the value',
    '-- that was true then.',
    'SELECT ' + selected.join(', '),
    'FROM ' + f + ' AS f',
    'ASOF LEFT JOIN ' + r + ' AS r',
    '  ON ' + onParts.join('\n  AND '),
    '',
    '-- Equivalent without ASOF JOIN, for engines that do not support it:',
    '-- SELECT ' + selected.join(', '),
    '-- FROM ' + f + ' AS f',
    '-- LEFT JOIN ' + r + ' AS r',
    '--   ON ' + onParts.join(' AND '),
    '-- QUALIFY ROW_NUMBER() OVER (',
    '--   PARTITION BY ' + (pairs.length
      ? pairs.map((p) => 'f.' + quoteIdent(p.left)).join(', ') + ', ' + factDate
      : factDate),
    '--   ORDER BY ' + refDate + ' DESC',
    '-- ) = 1',
  ];

  return { ok: true, sql: lines.join('\n') };
}

export function asOfLookupTransform(factDataset, refDataset, config) {
  if (!factDataset || typeof factDataset !== 'object') {
    return transformError('There is no main table loaded.');
  }
  if (!refDataset || typeof refDataset !== 'object') {
    return transformError('Pick a second table to look values up in.');
  }
  const factNames = columnNamesOf(factDataset);
  const refNames = columnNamesOf(refDataset);
  const v = validateAsOfConfig(config, factNames, refNames);
  if (!v.ok) return transformError(v.errors.join(' '));

  const pairs = normalizeKeyPairs(config.keyPairs);
  const factDateIdx = indexOfColumn(factNames, config.factDateColumn);
  const refDateIdx = indexOfColumn(refNames, config.refDateColumn);
  const leftKeyIdxs = pairs.map((p) => indexOfColumn(factNames, p.left));
  const rightKeyIdxs = pairs.map((p) => indexOfColumn(refNames, p.right));
  const bring = broughtColumns(config, refNames);
  const bringIdxs = bring.map((n) => indexOfColumn(refNames, n));
  const suffix = String(config.refSuffix || '_asof');

  // One sorted timeline per key. Sorting once and then walking backwards from a
  // binary search is what makes this cheap; the alternative, scanning every
  // reference row for every fact row, is the same answer done slowly.
  const timelines = new Map();
  let unreadableRefDates = 0;
  const refRows = rowsOf(refDataset);
  for (let i = 0; i < refRows.length; i += 1) {
    const row = refRows[i];
    if (!Array.isArray(row)) continue;
    const d = parseDateValue(row[refDateIdx]);
    if (!d) { unreadableRefDates += 1; continue; }
    const key = keyOfRow(row, rightKeyIdxs);
    let list = timelines.get(key);
    if (!list) { list = []; timelines.set(key, list); }
    list.push({ at: d.getTime(), seq: i, values: bringIdxs.map((idx) => row[idx]) });
  }

  let duplicateEffectiveDates = 0;
  for (const list of timelines.values()) {
    // Ascending by date, then by original position, so the tie-break is the
    // documented one: the last such row in table order wins.
    list.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].at === list[i - 1].at) duplicateEffectiveDates += 1;
    }
  }

  // Every brought column is suffixed, even when the name would not have collided.
  // A "price" column that sometimes means the fact's own and sometimes the
  // looked-up one is how the point-in-time value gets confused for the current
  // one two steps later, which is the whole error this transform prevents.
  const outColumns = factNames.map((n) => column(n, typeOfColumn(factDataset, n)))
    .concat(bring.map((n) => column(n + suffix, typeOfColumn(refDataset, n))));

  const blank = bring.map(() => null);
  const outRows = [];
  let matched = 0;
  let beforeFirst = 0;
  let noKey = 0;
  let unreadableFactDates = 0;
  let earliestUnmatched = null;

  const factRows = rowsOf(factDataset);
  for (let i = 0; i < factRows.length; i += 1) {
    const row = factRows[i];
    if (!Array.isArray(row)) continue;
    const d = parseDateValue(row[factDateIdx]);
    if (!d) {
      unreadableFactDates += 1;
      outRows.push(row.concat(blank));
      continue;
    }
    const list = timelines.get(keyOfRow(row, leftKeyIdxs));
    if (!list || list.length === 0) {
      noKey += 1;
      outRows.push(row.concat(blank));
      continue;
    }
    const hit = latestAtOrBefore(list, d.getTime());
    if (!hit) {
      beforeFirst += 1;
      if (earliestUnmatched === null || d.getTime() < earliestUnmatched) {
        earliestUnmatched = d.getTime();
      }
      outRows.push(row.concat(blank));
      continue;
    }
    matched += 1;
    outRows.push(row.concat(hit.values));
  }

  const built = buildAsOfSQL(config, factDataset.name, refDataset.name, refNames);
  const notes = [];
  if (beforeFirst > 0) {
    notes.push(beforeFirst + ' row' + (beforeFirst === 1 ? '' : 's') + ' are dated before the '
      + 'earliest matching row in the lookup table'
      + (earliestUnmatched === null ? '' : ' (the earliest is ' + formatISODate(new Date(earliestUnmatched)) + ')')
      + ', so those values are blank. They were not filled in with the oldest value on record, '
      + 'because that value was not in force then.');
  }
  if (noKey > 0) {
    notes.push(noKey + ' row' + (noKey === 1 ? '' : 's') + ' have no matching entry in the lookup '
      + 'table at all, on any date.');
  }
  if (duplicateEffectiveDates > 0) {
    notes.push(duplicateEffectiveDates + ' lookup row'
      + (duplicateEffectiveDates === 1 ? '' : 's') + ' share an effective date with another row '
      + 'for the same key. The later one in table order was used. If they disagree, the lookup '
      + 'table cannot say which value was in force and this result inherits that.');
  }
  if (unreadableFactDates > 0) {
    notes.push(unreadableFactDates + ' row' + (unreadableFactDates === 1 ? '' : 's') + ' had a '
      + 'date that could not be read in ' + config.factDateColumn + ', so they were kept with '
      + 'blank values rather than being looked up as of today.');
  }
  if (unreadableRefDates > 0) {
    notes.push(unreadableRefDates + ' lookup row' + (unreadableRefDates === 1 ? '' : 's')
      + ' had an unreadable effective date and were left out of the timeline.');
  }

  return transformResult({
    columns: outColumns,
    rows: outRows,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: factRows.length,
      rowsOut: outRows.length,
      matched: matched,
      unmatched: beforeFirst + noKey + unreadableFactDates,
      beforeFirst: beforeFirst,
      noKey: noKey,
      duplicateEffectiveDates: duplicateEffectiveDates,
      unreadableFactDates: unreadableFactDates,
      unreadableRefDates: unreadableRefDates,
      refRowsIn: refRows.length,
      keys: timelines.size,
    },
    notes: notes,
  });
}

/** The last entry at or before `at` in a list sorted ascending, or null when the
    whole timeline starts later. Binary search: the fact table is the big one and
    this runs once per row. */
function latestAtOrBefore(list, at) {
  let lo = 0;
  let hi = list.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].at <= at) { found = list[mid]; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

/** One plain sentence for the panel header. Leads with what was not matched,
    since that is the part a person would otherwise miss. */
export function describeAsOfLookup(result) {
  if (!result || !result.ok) return 'This lookup did not run.';
  const s = result.stats || {};
  if ((s.rowsIn || 0) === 0) return 'The main table has no rows, so there is nothing to look up.';
  if ((s.matched || 0) === 0) {
    return 'None of the ' + s.rowsIn + ' rows had a lookup value in force on their date.';
  }
  if ((s.unmatched || 0) === 0) {
    return 'All ' + s.rowsIn + ' rows got the value that was in force on their own date.';
  }
  return s.matched + ' of ' + s.rowsIn + ' rows got the value that was in force on their own '
    + 'date. The other ' + s.unmatched + ' are blank rather than guessed.';
}

export const DataGlowAsOfLookup = {
  AS_OF_LOOKUP_VERSION,
  createEmptyAsOfConfig,
  suggestAsOfConfig,
  validateAsOfConfig,
  normalizeKeyPairs,
  broughtColumns,
  buildAsOfSQL,
  asOfLookupTransform,
  describeAsOfLookup,
};
