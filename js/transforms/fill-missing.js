// ============================================================
// DATAGLOW - A25 Fill missing, and say which ones were filled
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// THE FLAG COLUMN IS NOT OPTIONAL, AND THAT IS THE ENTIRE DESIGN.
// Filling a null is the only transform in this bundle that invents data. Once a
// blank becomes 42, nothing downstream can tell it from a measured 42: not a
// chart, not an average, not the analyst who opens the file next month. So every
// fill writes a companion boolean column, <column>_was_filled, and there is no
// setting to turn it off. If you do not want the flag, you do not want this
// transform, you want to edit the cells.
//
// This matters more than it sounds. A filled column with no flag makes a
// confidence interval narrower than the data earns, and it makes "we have 1,200
// readings" true and misleading at the same time. The flag lets someone filter
// the invented rows back out, count them, or exclude them from a model, months
// after whoever ran this has forgotten they did.
//
// TWO MODES, BOTH HONEST. ON PURPOSE NOT MORE.
//   forward   Carry the last known value down, within a group and in a stated
//             order. This is the right answer for a reading that persists until
//             it next changes: a price, a status, a meter. It is the WRONG answer
//             for an independent measurement, and the notes say so.
//   constant  Write one stated value. Blunt, obvious, and unable to be mistaken
//             for a measurement.
//
// GROUP MEAN IS DELIBERATELY NOT HERE.
// js/cleaning/imputation.js already does stratified group-mean imputation with a
// global-mean fallback, as a DuckDB preview. Reimplementing it in JS would give
// this app two answers to one question. If you want a mean, use that. The gap
// worth knowing about is that it does not write a flag column, so a mean-filled
// column is not marked the way these two are.
//
// FORWARD FILL NEEDS AN ORDER, AND WILL NOT INVENT ONE.
// "The last known value" is meaningless without saying last by what. Table order
// is a real answer only if the table is genuinely sorted, and it usually is not
// after a join. So an order column is required, and if the order column cannot
// be read for a row, that row is not filled: it is left blank and counted.

import {
  quoteIdent,
  quoteLiteral,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isDateType,
  parseDateValue,
  toNumber,
  isPlainObject,
  asColumnList,
  keyOfRow,
  column,
  typeOfColumn,
  TYPE_BOOL,
  transformResult,
  transformError,
} from './transform-core.js';

export const FILL_MISSING_VERSION = 1;

export const FILL_MODES = Object.freeze(['forward', 'constant']);

export const FILL_MODE_LABELS = Object.freeze({
  forward: 'Carry the last value down',
  constant: 'Use one fixed value',
});

/** The suffix on the flag column. Fixed, not configurable: a reader who knows
    the convention can spot an imputed column in any DataGlow export. */
export const FILLED_SUFFIX = '_was_filled';

export function createEmptyFillConfig() {
  return {
    targetColumns: [],
    mode: 'forward',
    orderColumn: '',
    groupColumns: [],
    constantValue: '',
    limit: 0, // 0 means no limit on how far a value carries
  };
}

export function suggestFillConfig(dataset) {
  const cfg = createEmptyFillConfig();
  const names = columnNamesOf(dataset);
  const rows = rowsOf(dataset);

  // Suggest the column that actually has blanks, because a fill on a full column
  // is a no-op and picking one wastes the person's first look.
  let best = null;
  for (let i = 0; i < names.length; i += 1) {
    let blanks = 0;
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r];
      if (Array.isArray(row) && (row[i] == null || row[i] === '')) blanks += 1;
    }
    if (blanks > 0 && (!best || blanks > best.blanks)) best = { name: names[i], blanks: blanks };
  }
  if (best) cfg.targetColumns = [best.name];

  const cols = (dataset && dataset.columns) || [];
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] && isDateType(cols[i].type) && cols[i].name !== cfg.targetColumns[0]) {
      cfg.orderColumn = cols[i].name;
      break;
    }
  }
  if (!cfg.orderColumn) {
    cfg.orderColumn = names.filter((n) => n !== cfg.targetColumns[0])[0] || '';
  }
  return cfg;
}

export function validateFillConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  const targets = asColumnList(config.targetColumns);
  if (!targets.length) errors.push('Pick at least one column to fill.');
  for (let i = 0; i < targets.length; i += 1) {
    if (!names.includes(targets[i])) {
      errors.push('The column ' + targets[i] + ' is not in this table.');
    }
    if (names.includes(targets[i] + FILLED_SUFFIX)) {
      errors.push('This table already has a column called ' + targets[i] + FILLED_SUFFIX
        + '. Rename or remove it first, so the record of what was filled is not overwritten.');
    }
  }

  if (FILL_MODES.indexOf(config.mode) === -1) {
    errors.push('Choose how the blanks are filled.');
    return { ok: false, errors: errors };
  }

  if (config.mode === 'forward') {
    if (!config.orderColumn) {
      errors.push('Pick the column that says what order the rows are in. '
        + '"The last value" has no meaning without it.');
    } else if (!names.includes(config.orderColumn)) {
      errors.push('The order column ' + config.orderColumn + ' is not in this table.');
    }
    const groups = asColumnList(config.groupColumns);
    for (let g = 0; g < groups.length; g += 1) {
      if (!names.includes(groups[g])) {
        errors.push('The grouping column ' + groups[g] + ' is not in this table.');
      }
      if (targets.includes(groups[g])) {
        errors.push('The column ' + groups[g] + ' cannot be both filled and used to group.');
      }
    }
    if (config.orderColumn && targets.includes(config.orderColumn)) {
      errors.push('The order column cannot also be one of the columns being filled.');
    }
  }

  if (config.mode === 'constant') {
    if (config.constantValue == null || String(config.constantValue) === '') {
      errors.push('Give the value to write into the blanks. '
        + 'If the honest answer is that you do not have one, do not fill this column.');
    }
  }

  if (config.limit != null && config.limit !== '' && !(Number(config.limit) >= 0)) {
    errors.push('The limit on how far a value carries has to be zero or more.');
  }

  return { ok: errors.length === 0, errors: errors };
}

/** The flag column name for a target column. */
export function flagColumnFor(name) {
  return String(name) + FILLED_SUFFIX;
}

/**
 * The glass-box SQL.
 *
 * Forward fill is a window function, and the `IGNORE NULLS` is the part worth
 * reading: without it `last_value` returns the null it just passed over and the
 * fill silently does nothing. The flag column is in the SQL too, so the proof
 * and the result agree about the shape of the output as well as the values.
 */
export function buildFillMissingSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const t = relationName(sourceRelation, 'source');
  const targets = asColumnList(config.targetColumns);
  const groups = asColumnList(config.groupColumns);

  if (config.mode === 'constant') {
    const lit = quoteLiteral(config.constantValue);
    const selected = targets.map((n) => {
      const c = quoteIdent(n);
      return '  COALESCE(' + c + ', ' + lit + ') AS ' + c + ',\n'
        + '  (' + c + ' IS NULL) AS ' + quoteIdent(flagColumnFor(n));
    });
    const lines = [
      '-- Fill blanks in ' + targets.map(quoteIdent).join(', ') + ' with a fixed value,',
      '-- and record which rows were filled. The flag column is not optional: once a',
      '-- blank becomes a value, nothing downstream can tell it from a measurement.',
      'SELECT',
      '  * EXCLUDE (' + targets.map(quoteIdent).join(', ') + '),',
      selected.join(',\n'),
      'FROM ' + t,
    ];
    return { ok: true, sql: lines.join('\n') };
  }

  const order = quoteIdent(config.orderColumn);
  const partition = groups.length
    ? 'PARTITION BY ' + groups.map(quoteIdent).join(', ') + ' '
    : '';
  const frame = 'OVER (' + partition + 'ORDER BY ' + order
    + ' ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)';
  const selected = targets.map((n) => {
    const c = quoteIdent(n);
    return '  COALESCE(' + c + ', last_value(' + c + ' IGNORE NULLS) ' + frame + ') AS ' + c + ',\n'
      + '  (' + c + ' IS NULL AND last_value(' + c + ' IGNORE NULLS) ' + frame + ' IS NOT NULL)'
      + ' AS ' + quoteIdent(flagColumnFor(n));
  });

  const lines = [
    '-- Carry the last known value down ' + (groups.length
      ? 'within ' + groups.map(quoteIdent).join(', ') : 'across the whole table')
      + ', ordered by ' + order + '.',
    '-- IGNORE NULLS is the load-bearing part: without it last_value returns the',
    '-- null it just passed and the fill quietly does nothing.',
    '-- The flag column records which rows were filled, so an invented value can',
    '-- always be told from a measured one.',
    'SELECT',
    '  * EXCLUDE (' + targets.map(quoteIdent).join(', ') + '),',
    selected.join(',\n'),
    'FROM ' + t,
    'ORDER BY ' + (groups.length ? groups.map(quoteIdent).join(', ') + ', ' : '') + order,
  ];

  if (Number(config.limit) > 0) {
    lines.push('');
    lines.push('-- A limit of ' + Number(config.limit) + ' row(s) is applied in the computed');
    lines.push('-- result: a value does not carry further than that. Plain last_value has no');
    lines.push('-- such bound, so this SQL fills further than the preview does.');
  }

  return { ok: true, sql: lines.join('\n') };
}

export function fillMissingTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateFillConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const targets = asColumnList(config.targetColumns);
  const targetIdxs = targets.map((n) => indexOfColumn(names, n));
  const rows = rowsOf(dataset);

  // Output columns: every original column, then one flag per filled column. The
  // flags go at the end rather than beside their column so the original column
  // order is untouched, which matters when something downstream reads by index.
  const outColumns = names.map((n) => column(n, typeOfColumn(dataset, n)))
    .concat(targets.map((n) => column(flagColumnFor(n), TYPE_BOOL)));

  const filledCount = targets.map(() => 0);
  const blankBefore = targets.map(() => 0);
  const stillBlank = targets.map(() => 0);

  let outRows;
  let unorderable = 0;

  if (config.mode === 'constant') {
    const value = config.constantValue;
    outRows = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const copy = row.slice();
      const flags = [];
      for (let t = 0; t < targetIdxs.length; t += 1) {
        const at = targetIdxs[t];
        const missing = copy[at] == null || copy[at] === '';
        if (missing) {
          blankBefore[t] += 1;
          copy[at] = value;
          filledCount[t] += 1;
          flags.push(true);
        } else {
          flags.push(false);
        }
      }
      outRows.push(copy.concat(flags));
    }
  } else {
    const orderIdx = indexOfColumn(names, config.orderColumn);
    const groups = asColumnList(config.groupColumns);
    const groupIdxs = groups.map((n) => indexOfColumn(names, n));
    const orderIsDate = isDateType(typeOfColumn(dataset, config.orderColumn));
    const limit = Number(config.limit) > 0 ? Number(config.limit) : 0;

    // Sort a copy of the row references, never the dataset's own array: applying
    // is a separate confirmed step and a preview must not reorder the live table.
    const indexed = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (!Array.isArray(rows[i])) continue;
      const sortKey = orderKeyOf(rows[i][orderIdx], orderIsDate);
      if (sortKey === null) unorderable += 1;
      indexed.push({ row: rows[i], seq: i, key: sortKey });
    }

    // Rows whose order value cannot be read keep their table position at the end
    // rather than being treated as the earliest, which would make them the seed
    // value for everything after them.
    indexed.sort((a, b) => {
      if (a.key === null && b.key === null) return a.seq - b.seq;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return a.seq - b.seq;
    });

    const carried = new Map(); // group key -> { value, distance } per target
    const built = new Array(indexed.length);

    for (let i = 0; i < indexed.length; i += 1) {
      const row = indexed[i].row;
      const copy = row.slice();
      const flags = [];
      const gk = keyOfRow(row, groupIdxs);
      let state = carried.get(gk);
      if (!state) {
        state = targets.map(() => ({ value: null, has: false, distance: 0 }));
        carried.set(gk, state);
      }

      const orderable = indexed[i].key !== null;

      for (let t = 0; t < targetIdxs.length; t += 1) {
        const at = targetIdxs[t];
        const missing = copy[at] == null || copy[at] === '';
        const slot = state[t];

        if (!missing) {
          slot.value = copy[at];
          slot.has = true;
          slot.distance = 0;
          flags.push(false);
          continue;
        }

        blankBefore[t] += 1;

        // A row with no readable order value is not filled. It has no position,
        // so "the last value before it" does not exist, and filling it from
        // whatever happened to sort next to it would be a guess dressed as data.
        const tooFar = limit > 0 && slot.distance >= limit;
        if (!orderable || !slot.has || tooFar) {
          stillBlank[t] += 1;
          flags.push(false);
          continue;
        }

        copy[at] = slot.value;
        slot.distance += 1;
        filledCount[t] += 1;
        flags.push(true);
      }

      built[i] = copy.concat(flags);
    }
    outRows = built;
  }

  const built = buildFillMissingSQL(config, dataset.name);
  const totalFilled = filledCount.reduce((a, b) => a + b, 0);
  const totalBlank = blankBefore.reduce((a, b) => a + b, 0);
  const totalLeft = stillBlank.reduce((a, b) => a + b, 0);
  const notes = [];

  notes.push('Every value written is marked in '
    + targets.map((n) => flagColumnFor(n)).join(', ')
    + '. Keep '
    + (targets.length === 1 ? 'that column' : 'those columns')
    + ' with the data: without '
    + (targets.length === 1 ? 'it' : 'them')
    + ' there is no way to tell a filled value from a measured one, and an average over the '
    + 'result would count invented numbers as evidence.');

  if (config.mode === 'forward') {
    notes.push('Carrying the last value down assumes the value held until it next changed, which '
      + 'is true for a price, a status or a meter reading. It is not true for an independent '
      + 'measurement: if a sensor missed a reading, the previous reading is not what it would have '
      + 'said.');
    if (!asColumnList(config.groupColumns).length) {
      notes.push('No grouping column was chosen, so a value carries across the whole table. If '
        + 'these rows cover more than one entity, one entity\'s value will be carried onto '
        + 'another\'s blank.');
    }
    notes.push('The rows are put in ' + config.orderColumn + ' order to do this, and stay in that '
      + 'order in the result.');
    if (unorderable > 0) {
      notes.push(unorderable + ' row' + (unorderable === 1 ? '' : 's') + ' have no readable value '
        + 'in ' + config.orderColumn + '. They were left at the end and were not filled, because a '
        + 'row with no position has no "last value before it".');
    }
  } else {
    notes.push('A fixed value is blunt on purpose. It cannot be mistaken for a measurement the way '
      + 'a mean or an interpolation can, and the flag column says exactly which rows carry it.');
  }

  if (totalLeft > 0) {
    notes.push(totalLeft + ' blank' + (totalLeft === 1 ? '' : 's') + ' could not be filled and were '
      + 'left blank' + (Number(config.limit) > 0
        ? ', either because nothing came before them or because the limit of ' + Number(config.limit)
          + ' row' + (Number(config.limit) === 1 ? '' : 's') + ' was reached.'
        : ', because nothing came before them in the chosen order.'));
  }
  if (totalBlank === 0) {
    notes.push('There were no blanks to fill in '
      + targets.join(', ') + ', so only the flag column' + (targets.length === 1 ? '' : 's')
      + ' were added, all false.');
  }
  // Naming the sibling capability rather than silently offering a third answer
  // to the same question.
  notes.push('A group mean is not offered here. The Grouped Imputation Wizard already does that '
    + 'against the query engine. Note that it does not add a flag column, so a mean-filled column '
    + 'is not marked the way this one is.');

  return transformResult({
    columns: outColumns,
    rows: outRows,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: rows.length,
      rowsOut: outRows.length,
      filled: totalFilled,
      blankBefore: totalBlank,
      stillBlank: totalLeft,
      unorderable: unorderable,
      perColumn: targets.map((n, i) => ({
        column: n, blankBefore: blankBefore[i], filled: filledCount[i], stillBlank: stillBlank[i],
      })),
    },
    notes: notes,
  });
}

/** A comparable sort key for the order column: a timestamp for dates, a number
    for numbers, a string otherwise. Mixed types in one column sort by the type
    the column declares, which is why the declared type is passed in. */
function orderKeyOf(value, isDate) {
  if (value == null || value === '') return null;
  if (isDate) {
    const d = parseDateValue(value);
    return d ? d.getTime() : null;
  }
  const n = toNumber(value);
  if (n !== null) return n;
  const d = parseDateValue(value);
  if (d) return d.getTime();
  return String(value);
}

/** One plain sentence for the panel header. Leads with the count of invented
    values, because that is the part a reader needs to weigh. */
export function describeFillMissing(result) {
  if (!result || !result.ok) return 'This fill did not run.';
  const s = result.stats || {};
  if (!s.rowsIn) return 'The table has no rows, so there is nothing to fill.';
  if (!s.blankBefore) return 'There were no blanks to fill. Nothing was invented.';
  if (!s.filled) {
    return 'None of the ' + s.blankBefore + ' blanks could be filled, so nothing was invented.';
  }
  const left = s.stillBlank
    ? ' ' + s.stillBlank + ' blank' + (s.stillBlank === 1 ? '' : 's') + ' could not be filled.'
    : '';
  return s.filled + ' of ' + s.blankBefore + ' blank'
    + (s.blankBefore === 1 ? '' : 's') + ' were filled, and all '
    + (s.filled === 1 ? 'of them is' : 'of them are') + ' marked as filled.' + left;
}

export const DataGlowFillMissing = {
  FILL_MISSING_VERSION,
  FILL_MODES,
  FILL_MODE_LABELS,
  FILLED_SUFFIX,
  createEmptyFillConfig,
  suggestFillConfig,
  validateFillConfig,
  flagColumnFor,
  buildFillMissingSQL,
  fillMissingTransform,
  describeFillMissing,
};
