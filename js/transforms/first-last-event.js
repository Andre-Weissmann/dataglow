// ============================================================
// DATAGLOW - A20 First or last event per entity
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. "What did each customer buy first?", "what is the latest
// reading from each sensor?", "what is the most recent status of each ticket?"
// One row per entity, chosen by a column you pick.
//
// THE PROBLEM THIS MODULE EXISTS TO SOLVE IS TIES, NOT ORDERING.
// Sorting by a timestamp and taking the top row per group is four lines of code.
// It is also non-deterministic the moment two rows for one entity share the same
// timestamp, which happens constantly: two line items on one order, two sensor
// readings in the same second, a status set twice by a script. ROW_NUMBER() OVER
// (PARTITION BY entity ORDER BY ts DESC) is free to return either row, and it can
// return a different one on the next run or on a different engine. A report that
// changes when nothing changed is one of the hardest bugs to be believed about.
//
// So the tie-break here is total and stated: after the order column, rows are
// compared by every remaining column in table order. That makes the answer a
// function of the table's contents alone, identical in JS and in the glass-box
// SQL, and identical run to run. When ties actually occurred, the notes say how
// many, because a tie-break being deterministic does not make it meaningful:
// if two rows genuinely tie on the timestamp, the person needs to know that the
// choice between them was arbitrary even though it was repeatable.
//
// Rows whose order value cannot be read are excluded and counted. A row with no
// timestamp has no claim to being the first or last event, and defaulting it to
// the epoch would make it the first event for its entity.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  suggestDateColumn,
  parseDateValue,
  toNumber,
  isPlainObject,
  asColumnList,
  missingColumns,
  keyOfRow,
  column,
  typeOfColumn,
  isDateType,
  transformResult,
  transformError,
  TYPE_INT,
} from './transform-core.js';

export const FIRST_LAST_VERSION = 1;

export const FIRST_LAST_PICKS = Object.freeze(['first', 'last']);

export const FIRST_LAST_PICK_LABELS = Object.freeze({
  first: 'First event per group',
  last: 'Latest event per group',
});

// 'one' is the default because "one row per entity" is what the question means.
// 'ranked' keeps every row with its position, which is what you want when the
// next question is "and what was the one before that?".
export const FIRST_LAST_MODES = Object.freeze(['one', 'ranked']);

export function createEmptyFirstLastConfig() {
  return {
    entityColumns: [],
    orderColumn: '',
    pick: 'last',
    mode: 'one',
  };
}

export function suggestFirstLastConfig(dataset) {
  const cfg = createEmptyFirstLastConfig();
  cfg.orderColumn = suggestDateColumn(dataset) || '';
  return cfg;
}

export function validateFirstLastConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  const entities = asColumnList(config.entityColumns);
  if (entities.length === 0) errors.push('Pick at least one column that identifies the group.');
  const missing = missingColumns(names, entities);
  if (missing.length > 0) {
    errors.push('These group columns are not in this table: ' + missing.join(', ') + '.');
  }

  if (!config.orderColumn) errors.push('Pick the column that says which event came first.');
  else if (!names.includes(config.orderColumn)) {
    errors.push('The order column ' + config.orderColumn + ' is not in this table.');
  } else if (entities.includes(config.orderColumn)) {
    errors.push('The order column cannot also be a group column, since every row in a '
      + 'group would then have the same order value.');
  }

  const pick = String(config.pick || 'last').toLowerCase();
  if (!FIRST_LAST_PICKS.includes(pick)) errors.push('Choose first or last.');

  const mode = String(config.mode || 'one').toLowerCase();
  if (!FIRST_LAST_MODES.includes(mode)) errors.push('Choose one row per group, or all rows ranked.');

  return { ok: errors.length === 0, errors: errors };
}

/**
 * The glass-box SQL. DuckDB's QUALIFY, which is the readable form of "filter on
 * a window function". The full tie-break appears in the ORDER BY rather than
 * being left implicit, so the query a person reads is the query that produced
 * these exact rows.
 */
export function buildFirstLastSQL(config, sourceRelation, columnNames) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };

  const rel = relationName(sourceRelation, 'your_table');
  const entities = asColumnList(config.entityColumns);
  const pick = String(config.pick || 'last').toLowerCase();
  const mode = String(config.mode || 'one').toLowerCase();
  const dir = pick === 'first' ? 'ASC' : 'DESC';
  const orderCol = quoteIdent(config.orderColumn);

  // NULLS LAST in both directions: a row with no order value must never win the
  // first or the last slot, which matches the JS engine excluding it outright.
  const orderParts = [orderCol + ' ' + dir + ' NULLS LAST'];
  const tieCols = tieBreakColumns(columnNames, config);
  for (let i = 0; i < tieCols.length; i += 1) {
    orderParts.push(quoteIdent(tieCols[i]) + ' ' + dir + ' NULLS LAST');
  }

  const over = 'ROW_NUMBER() OVER (\n'
    + (entities.length ? '    PARTITION BY ' + entities.map(quoteIdent).join(', ') + '\n' : '')
    + '    ORDER BY ' + orderParts.join(', ') + '\n  )';

  const lines = [
    '-- ' + (pick === 'first' ? 'First' : 'Latest') + ' event per group'
      + (mode === 'ranked' ? ', every row kept with its position' : ', one row per group'),
    '-- Ties on ' + orderCol + ' are broken by the remaining columns in table order,',
    '-- so this returns the same row every run rather than whichever the engine',
    '-- happened to reach first.',
    'SELECT *,',
    '  ' + over + ' AS event_rank',
    'FROM ' + rel,
    'WHERE ' + orderCol + ' IS NOT NULL',
  ];
  if (mode === 'one') lines.push('QUALIFY event_rank = 1');
  lines.push('ORDER BY ' + (entities.length ? entities.map(quoteIdent).join(', ') + ', ' : '')
    + 'event_rank');

  return { ok: true, sql: lines.join('\n') };
}

/** Every column that is neither a group column nor the order column, in table
    order. These are the tie-break, and the order they appear in is the order
    they are compared in. */
export function tieBreakColumns(columnNames, config) {
  const names = Array.isArray(columnNames) ? columnNames : [];
  const entities = asColumnList(config && config.entityColumns);
  const orderColumn = (config && config.orderColumn) || '';
  return names.filter((n) => n !== orderColumn && !entities.includes(n));
}

export function firstLastEventTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateFirstLastConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const entities = asColumnList(config.entityColumns);
  const pick = String(config.pick || 'last').toLowerCase();
  const mode = String(config.mode || 'one').toLowerCase();
  const entityIdxs = entities.map((e) => indexOfColumn(names, e));
  const orderIdx = indexOfColumn(names, config.orderColumn);
  const orderIsDate = isDateType(typeOfColumn(dataset, config.orderColumn));
  const tieIdxs = tieBreakColumns(names, config).map((n) => indexOfColumn(names, n));

  const srcRows = rowsOf(dataset);
  const groups = new Map();
  let unreadableOrder = 0;

  for (let i = 0; i < srcRows.length; i += 1) {
    const row = srcRows[i];
    if (!Array.isArray(row)) continue;
    const sort = sortableOrderValue(row[orderIdx], orderIsDate);
    if (sort === null) { unreadableOrder += 1; continue; }
    const key = keyOfRow(row, entityIdxs);
    let g = groups.get(key);
    if (!g) { g = { key: key, rows: [] }; groups.set(key, g); }
    g.rows.push({ row: row, sort: sort });
  }

  const sign = pick === 'first' ? 1 : -1;
  const outColumns = names.map((n) => column(n, typeOfColumn(dataset, n)))
    .concat([column('event_rank', TYPE_INT)]);

  const orderedKeys = Array.from(groups.keys()).sort();
  const outRows = [];
  let tiedGroups = 0;

  for (let k = 0; k < orderedKeys.length; k += 1) {
    const g = groups.get(orderedKeys[k]);
    g.rows.sort((a, b) => {
      const c = compareSortable(a.sort, b.sort);
      if (c !== 0) return sign * c;
      // Same order value: fall through to the stated tie-break. Counted below
      // so the result can admit the choice was arbitrary.
      for (let t = 0; t < tieIdxs.length; t += 1) {
        const tc = compareValues(a.row[tieIdxs[t]], b.row[tieIdxs[t]]);
        if (tc !== 0) return sign * tc;
      }
      return 0;
    });
    if (g.rows.length > 1 && compareSortable(g.rows[0].sort, g.rows[1].sort) === 0) tiedGroups += 1;

    if (mode === 'one') {
      outRows.push(g.rows[0].row.concat([1]));
    } else {
      for (let i = 0; i < g.rows.length; i += 1) outRows.push(g.rows[i].row.concat([i + 1]));
    }
  }

  const built = buildFirstLastSQL(config, dataset.name, names);
  const notes = [];
  if (tiedGroups > 0) {
    notes.push(tiedGroups + ' group' + (tiedGroups === 1 ? '' : 's') + ' had two or more rows '
      + 'sharing the same ' + config.orderColumn + '. The row shown was chosen by comparing the '
      + 'remaining columns in table order, which is repeatable but arbitrary: if those rows are '
      + 'genuinely different events, the table needs something finer to tell them apart.');
  }
  if (unreadableOrder > 0) {
    notes.push(unreadableOrder + ' row' + (unreadableOrder === 1 ? '' : 's') + ' had no usable '
      + 'value in ' + config.orderColumn + ' and were left out, because a row with no order '
      + 'value cannot be the ' + pick + ' event.');
  }
  if (mode === 'one' && groups.size > 0) {
    notes.push('One row per group: ' + groups.size + ' group'
      + (groups.size === 1 ? '' : 's') + ' out of ' + srcRows.length + ' row'
      + (srcRows.length === 1 ? '' : 's') + '.');
  }

  return transformResult({
    columns: outColumns,
    rows: outRows,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: srcRows.length,
      rowsOut: outRows.length,
      groups: groups.size,
      tiedGroups: tiedGroups,
      unreadableOrder: unreadableOrder,
      pick: pick,
      mode: mode,
    },
    notes: notes,
  });
}

/**
 * The order value as something comparable, or null when the row cannot take part.
 *
 * A declared date column is parsed as a date so that "2024-3-5" and "2024-03-05"
 * order correctly rather than as strings. Anything numeric orders as a number so
 * that 9 comes before 10. Everything else orders as a string, which is at least
 * total and stable.
 */
function sortableOrderValue(value, preferDate) {
  if (value == null || value === '') return null;
  if (preferDate || value instanceof Date) {
    const d = parseDateValue(value);
    if (d) return { kind: 'n', v: d.getTime() };
    if (preferDate) return null;
  }
  const n = toNumber(value);
  if (n !== null && typeof value !== 'boolean') return { kind: 'n', v: n };
  const d2 = parseDateValue(value);
  if (d2) return { kind: 'n', v: d2.getTime() };
  return { kind: 's', v: String(value) };
}

function compareSortable(a, b) {
  if (a.kind === 'n' && b.kind === 'n') return a.v < b.v ? -1 : (a.v > b.v ? 1 : 0);
  const as = String(a.v);
  const bs = String(b.v);
  return as < bs ? -1 : (as > bs ? 1 : 0);
}

/** A total order over two raw cells, for the tie-break. Null sorts last in the
    ascending direction so a blank never wins a slot a real value could take. */
function compareValues(a, b) {
  const aNull = a == null || a === '';
  const bNull = b == null || b === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) return an < bn ? -1 : (an > bn ? 1 : 0);
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : (as > bs ? 1 : 0);
}

/** One plain sentence for the panel header. */
export function describeFirstLast(result, config) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  const pick = String((config && config.pick) || s.pick || 'last').toLowerCase();
  const word = pick === 'first' ? 'first' : 'latest';
  if ((s.groups || 0) === 0) return 'No groups came back, so there is nothing to pick from.';
  if (s.mode === 'ranked') {
    return s.rowsOut + ' rows across ' + s.groups + ' groups, ranked with the ' + word
      + ' event first.';
  }
  return 'The ' + word + ' event for each of ' + s.groups + ' group'
    + (s.groups === 1 ? '' : 's') + ', from ' + s.rowsIn + ' rows.';
}

export const DataGlowFirstLastEvent = {
  FIRST_LAST_VERSION,
  FIRST_LAST_PICKS,
  FIRST_LAST_PICK_LABELS,
  FIRST_LAST_MODES,
  createEmptyFirstLastConfig,
  suggestFirstLastConfig,
  validateFirstLastConfig,
  buildFirstLastSQL,
  tieBreakColumns,
  firstLastEventTransform,
  describeFirstLast,
};
