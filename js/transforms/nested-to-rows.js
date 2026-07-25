// ============================================================
// DATAGLOW - A17 Nested to rows (one row per element)
// ============================================================
// Pure ES module. No DOM, no network, no DuckDB.
//
// WHAT THIS ANSWERS. A column holds a list: tags, line items, diagnosis codes,
// the `items` array from an API response. You cannot count, group or filter on
// anything inside it while it is one cell. This gives each element its own row.
//
// THIS IS THE OTHER HALF OF THE JSON FLATTENER.
// js/ingestion/json-flattener.js runs at load and widens nested objects into
// dot-named columns, but when it meets an array it calls JSON.stringify and puts
// the text in the cell, because at ingest time there is nowhere else to put it.
// That is the right call there and it is why this module exists: A17 is where
// those strings get unpacked. The two are complementary, not two versions of the
// same thing, and neither should start doing the other's job.
//
// THE ROW COUNT IS THE DANGEROUS PART, SO IT IS THE HEADLINE.
// Unnesting is the transform most likely to turn a table a person understands
// into one they do not. A 5,000-row export with an average of 6 line items is
// 30,000 rows, every non-list column repeated six times, and every existing SUM
// over those columns now six times too big. Nothing about the result looks
// broken. So previewNestedToRows() counts the elements without building the
// output, and the confirm names the number before anything happens.
//
// WHAT COUNTS AS A LIST.
// A real array, a JSON array in a string, or a delimited string. JSON is tried
// before the delimiter, because "[1, 2]" split on a comma gives "[1" and " 2]"
// and that is a silently mangled value rather than a visible failure. A cell
// that is neither is not a one-element list by assumption: what happens to it is
// a choice the person makes, and it is stated in the notes either way.

import {
  quoteIdent,
  relationName,
  columnNamesOf,
  indexOfColumn,
  rowsOf,
  isPlainObject,
  column,
  typeOfColumn,
  TYPE_INT,
  TYPE_STR,
  transformResult,
  transformError,
} from './transform-core.js';

export const NESTED_TO_ROWS_VERSION = 1;

export const NESTED_SOURCES = Object.freeze(['auto', 'json', 'delimited']);

export const NESTED_SOURCE_LABELS = Object.freeze({
  auto: 'Work it out',
  json: 'JSON array',
  delimited: 'Separated by a character',
});

// What to do with a row whose list is empty or unreadable. Named rather than
// boolean because "drop" and "keep" are both defensible and the difference
// changes the row count, which is the number this transform is judged on.
export const EMPTY_HANDLING = Object.freeze(['keep', 'drop']);

// Above this the result stops being a table someone can look at, and on a phone
// it is enough to make the tab unresponsive. Not a hard stop: it is a warning
// carried on the preview so the confirm can say it out loud.
export const EXPLOSION_WARN_ROWS = 100000;

// A single cell producing more than this is nearly always a parse gone wrong,
// such as splitting a paragraph on the space character.
export const PER_ROW_WARN = 500;

export function createEmptyNestedConfig() {
  return {
    listColumn: '',
    source: 'auto',
    delimiter: ',',
    elementColumn: '',
    includeIndex: true,
    emptyHandling: 'keep',
    trimElements: true,
  };
}

export function suggestNestedConfig(dataset) {
  const cfg = createEmptyNestedConfig();
  const names = columnNamesOf(dataset);
  const rows = rowsOf(dataset);

  // Pick by what the data looks like, not by the column name: a column called
  // "tags" holding one word per row is not a list, and a column called "notes"
  // holding a JSON array is.
  let best = null;
  for (let i = 0; i < names.length; i += 1) {
    let listy = 0;
    let looked = 0;
    for (let r = 0; r < rows.length && looked < 40; r += 1) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      looked += 1;
      const parsed = readList(row[i], 'auto', ',');
      if (parsed.kind !== 'scalar' && parsed.values.length > 1) listy += 1;
    }
    const score = looked ? listy / looked : 0;
    if (score > 0.3 && (!best || score > best.score)) best = { name: names[i], score: score };
  }
  cfg.listColumn = best ? best.name : (names[0] || '');
  if (cfg.listColumn) cfg.elementColumn = cfg.listColumn + '_item';
  return cfg;
}

export function validateNestedConfig(config, columnNames) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const names = Array.isArray(columnNames) ? columnNames : [];

  if (!config.listColumn) errors.push('Pick the column that holds the list.');
  else if (!names.includes(config.listColumn)) {
    errors.push('The column ' + config.listColumn + ' is not in this table.');
  }
  if (NESTED_SOURCES.indexOf(config.source || 'auto') === -1) {
    errors.push('Choose how the list is written: JSON, or separated by a character.');
  }
  if ((config.source === 'delimited') && !String(config.delimiter || '')) {
    errors.push('Give the character that separates the values, such as a comma.');
  }
  if (config.emptyHandling && EMPTY_HANDLING.indexOf(config.emptyHandling) === -1) {
    errors.push('Choose whether rows with an empty list are kept or dropped.');
  }
  return { ok: errors.length === 0, errors: errors };
}

/** The name of the column holding each element. Defaults from the source column
    so the output is readable without the person having to name it. */
export function elementColumnName(config) {
  const explicit = String((config && config.elementColumn) || '').trim();
  if (explicit) return explicit;
  return String((config && config.listColumn) || 'value') + '_item';
}

/**
 * Read one cell as a list.
 *
 * Order matters. A real array first, then JSON, then the delimiter. Trying the
 * delimiter before JSON would turn "[1, 2]" into "[1" and " 2]", which is worse
 * than failing because it looks like it worked.
 */
export function readList(value, source, delimiter) {
  if (Array.isArray(value)) {
    return { kind: 'array', values: value.slice() };
  }
  if (value == null || value === '') {
    return { kind: 'empty', values: [] };
  }
  if (isPlainObject(value)) {
    // An object is not a list. Widening it is the flattener's job, not this
    // module's, so it is left alone and reported rather than half-handled.
    return { kind: 'scalar', values: [value] };
  }

  const text = String(value).trim();
  if (!text) return { kind: 'empty', values: [] };

  const mode = source || 'auto';
  if (mode === 'auto' || mode === 'json') {
    if (text.charAt(0) === '[' && text.charAt(text.length - 1) === ']') {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return { kind: 'json', values: parsed };
      } catch (_e) {
        // Looks like JSON and is not. In auto mode fall through to the
        // delimiter; in json mode say so rather than quietly splitting.
        if (mode === 'json') return { kind: 'unreadable', values: [] };
      }
    } else if (mode === 'json') {
      return { kind: 'unreadable', values: [] };
    }
  }

  if (mode === 'auto' || mode === 'delimited') {
    const d = String(delimiter || ',');
    if (d && text.indexOf(d) !== -1) {
      return { kind: 'delimited', values: text.split(d) };
    }
  }

  return { kind: 'scalar', values: [text] };
}

function cellText(v, trim) {
  if (v == null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return trim ? s.trim() : s;
}

/**
 * Count what apply would produce, without building it.
 *
 * Deliberately a separate pass rather than "build it and look at length": the
 * whole point is to warn before a 40x expansion is materialised in a browser
 * tab, and building it first defeats that.
 */
export function previewNestedToRows(dataset, config) {
  if (!dataset || typeof dataset !== 'object') {
    return { ok: false, error: 'There is no table loaded.' };
  }
  const names = columnNamesOf(dataset);
  const v = validateNestedConfig(config, names);
  if (!v.ok) return { ok: false, error: v.errors.join(' ') };

  const idx = indexOfColumn(names, config.listColumn);
  const rows = rowsOf(dataset);
  const source = config.source || 'auto';
  const delimiter = config.delimiter || ',';
  const dropEmpty = config.emptyHandling === 'drop';

  let elements = 0;
  let emptyRows = 0;
  let scalarRows = 0;
  let unreadableRows = 0;
  let biggest = 0;
  let listRows = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const parsed = readList(row[idx], source, delimiter);
    // These branches mirror nestedToRowsTransform() case for case. Preview and
    // apply disagreeing about the row count would make the confirm a lie, which
    // is the one thing this preview exists to prevent.
    if (parsed.kind === 'empty' || parsed.kind === 'unreadable' || parsed.values.length === 0) {
      if (parsed.kind === 'empty') emptyRows += 1;
      else if (parsed.kind === 'unreadable') unreadableRows += 1;
      if (!dropEmpty) elements += 1;
      continue;
    }
    if (parsed.kind === 'scalar') { scalarRows += 1; elements += 1; continue; }
    listRows += 1;
    elements += parsed.values.length;
    if (parsed.values.length > biggest) biggest = parsed.values.length;
  }

  const rowsIn = rows.length;
  const ratio = rowsIn > 0 ? elements / rowsIn : 1;
  const warnings = [];
  if (elements > EXPLOSION_WARN_ROWS) {
    warnings.push('This makes ' + elements.toLocaleString() + ' rows, which is more than '
      + EXPLOSION_WARN_ROWS.toLocaleString() + '. A table that size is slow to scroll and slow to '
      + 'chart, and on a phone it may stop responding. Consider filtering first.');
  }
  if (biggest > PER_ROW_WARN) {
    warnings.push('One row alone produces ' + biggest.toLocaleString() + ' elements. That is '
      + 'usually a sign the separator is wrong, such as splitting a sentence on the space.');
  }
  if (rowsIn > 0 && listRows === 0) {
    warnings.push('No row in ' + config.listColumn + ' looks like a list. Check the column and the '
      + 'separator: as configured, this would change nothing except adding a column.');
  }

  return {
    ok: true,
    rowsIn: rowsIn,
    rowsOut: elements,
    ratio: ratio,
    listRows: listRows,
    emptyRows: emptyRows,
    scalarRows: scalarRows,
    unreadableRows: unreadableRows,
    largestList: biggest,
    willGrow: elements > rowsIn,
    warnings: warnings,
  };
}

/**
 * The glass-box SQL. DuckDB's UNNEST, with the JSON form shown when the column
 * holds text rather than a real list, because which one applies depends on how
 * the file was loaded and a person checking this needs the one that matches.
 */
export function buildNestedToRowsSQL(config, sourceRelation) {
  if (!isPlainObject(config)) return { ok: false, errors: ['There is no configuration to check.'] };
  const t = relationName(sourceRelation, 'source');
  const c = quoteIdent(config.listColumn);
  const out = quoteIdent(elementColumnName(config));
  const keepEmpty = config.emptyHandling !== 'drop';
  const d = String(config.delimiter || ',');
  const dl = "'" + d.replace(/'/g, "''") + "'";
  const idxCol = config.includeIndex !== false
    ? ',\n  generate_subscripts(' + listExpr(config, c, dl) + ', 1) AS ' + quoteIdent(elementColumnName(config) + '_index')
    : '';

  const lines = [
    '-- One row per element of ' + c + '.',
    '-- Every other column is repeated on each new row, so any total already',
    '-- computed over this table will change. That is the point of the count',
    '-- shown beside this SQL.',
    'SELECT',
    '  * EXCLUDE (' + c + '),',
    '  ' + c + ',',
    '  UNNEST(' + listExpr(config, c, dl) + ') AS ' + out + idxCol,
    'FROM ' + t,
  ];

  if (!keepEmpty) {
    lines.push('WHERE len(' + listExpr(config, c, dl) + ') > 0');
  } else {
    lines.push('');
    lines.push('-- Rows with an empty list are kept, with a blank element. UNNEST on its');
    lines.push('-- own drops them, so the honest equivalent is a left join onto the list:');
    lines.push('-- SELECT s.*, e.' + out.replace(/"/g, '') + ' FROM ' + t + ' AS s');
    lines.push('-- LEFT JOIN LATERAL UNNEST(' + listExpr(config, c, dl) + ') AS e(' + out.replace(/"/g, '') + ') ON TRUE');
  }

  return { ok: true, sql: lines.join('\n') };
}

function listExpr(config, quotedCol, quotedDelim) {
  if (config.source === 'delimited') return 'str_split(' + quotedCol + ', ' + quotedDelim + ')';
  if (config.source === 'json') return 'from_json(' + quotedCol + ", '[\"VARCHAR\"]')";
  // Auto: the column may already be a list, or hold JSON text. TRY_CAST keeps a
  // real list intact and falls back to parsing the string form.
  return 'COALESCE(TRY_CAST(' + quotedCol + " AS VARCHAR[]), str_split(" + quotedCol + ', ' + quotedDelim + '))';
}

export function nestedToRowsTransform(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return transformError('There is no table loaded.');
  const names = columnNamesOf(dataset);
  const v = validateNestedConfig(config, names);
  if (!v.ok) return transformError(v.errors.join(' '));

  const idx = indexOfColumn(names, config.listColumn);
  const rows = rowsOf(dataset);
  const source = config.source || 'auto';
  const delimiter = config.delimiter || ',';
  const dropEmpty = config.emptyHandling === 'drop';
  const trim = config.trimElements !== false;
  const withIndex = config.includeIndex !== false;
  const elemName = elementColumnName(config);

  const outColumns = names.map((n) => column(n, typeOfColumn(dataset, n)));
  outColumns.push(column(elemName, TYPE_STR));
  if (withIndex) outColumns.push(column(elemName + '_index', TYPE_INT));

  const out = [];
  let emptyRows = 0;
  let scalarRows = 0;
  let unreadableRows = 0;
  let listRows = 0;
  let biggest = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const parsed = readList(row[idx], source, delimiter);

    if (parsed.kind === 'empty' || parsed.kind === 'unreadable' || parsed.values.length === 0) {
      if (parsed.kind === 'empty') emptyRows += 1;
      else if (parsed.kind === 'unreadable') unreadableRows += 1;
      // A row with nothing in the list is kept by default with a blank element,
      // because dropping it loses a fact that was in the table: this entity had
      // no items. Plain UNNEST would drop it silently.
      if (!dropEmpty) out.push(row.concat(withIndex ? [null, null] : [null]));
      continue;
    }

    if (parsed.kind === 'scalar') {
      scalarRows += 1;
      out.push(row.concat(withIndex ? [cellText(parsed.values[0], trim), 1] : [cellText(parsed.values[0], trim)]));
      continue;
    }

    listRows += 1;
    if (parsed.values.length > biggest) biggest = parsed.values.length;
    for (let e = 0; e < parsed.values.length; e += 1) {
      const text = cellText(parsed.values[e], trim);
      out.push(row.concat(withIndex ? [text, e + 1] : [text]));
    }
  }

  const built = buildNestedToRowsSQL(config, dataset.name);
  const notes = [];

  if (out.length > rows.length) {
    notes.push('Every column other than ' + config.listColumn + ' is now repeated once per '
      + 'element. Any total, average or count already computed over this table will change, and a '
      + 'sum of a repeated column will be too big. That is expected here, not a fault, but it is '
      + 'the reason to re-check any number carried over from before.');
  }
  if (scalarRows > 0) {
    notes.push(scalarRows + ' row' + (scalarRows === 1 ? '' : 's') + ' held a single value rather '
      + 'than a list, so ' + (scalarRows === 1 ? 'it was' : 'they were') + ' carried across '
      + 'unchanged as a list of one.');
  }
  if (emptyRows > 0) {
    notes.push(emptyRows + ' row' + (emptyRows === 1 ? '' : 's') + ' had nothing in '
      + config.listColumn + (dropEmpty
        ? ' and were dropped, as configured.'
        : '. They were kept with a blank element, because "this one had no items" is a fact worth '
          + 'keeping. Plain UNNEST would have dropped them without saying so.'));
  }
  if (unreadableRows > 0) {
    notes.push(unreadableRows + ' row' + (unreadableRows === 1 ? '' : 's') + ' could not be read as '
      + 'a list in the format chosen' + (dropEmpty ? ' and were dropped.' : ' and were kept with a '
      + 'blank element rather than being split on a guess.'));
  }
  if (biggest > PER_ROW_WARN) {
    notes.push('The longest single list has ' + biggest + ' elements, which usually means the '
      + 'separator is not the right one for this column.');
  }

  return transformResult({
    columns: outColumns,
    rows: out,
    sql: built.ok ? built.sql : '',
    stats: {
      rowsIn: rows.length,
      rowsOut: out.length,
      listRows: listRows,
      emptyRows: emptyRows,
      scalarRows: scalarRows,
      unreadableRows: unreadableRows,
      largestList: biggest,
      ratio: rows.length ? out.length / rows.length : 1,
    },
    notes: notes,
  });
}

/** One plain sentence for the panel header, leading with the row count because
    that is the consequence a person is agreeing to. */
export function describeNestedToRows(result) {
  if (!result || !result.ok) return 'This did not run.';
  const s = result.stats || {};
  if (!s.rowsIn) return 'The table has no rows, so there is nothing to expand.';
  if (s.rowsOut === s.rowsIn) {
    return 'The row count does not change: nothing in this column held more than one value.';
  }
  const times = (s.ratio || 1).toFixed(1).replace(/\.0$/, '');
  return s.rowsIn.toLocaleString() + ' rows become ' + s.rowsOut.toLocaleString()
    + ', about ' + times + ' times as many. Every other column is repeated on each new row.';
}

export const DataGlowNestedToRows = {
  NESTED_TO_ROWS_VERSION,
  NESTED_SOURCES,
  NESTED_SOURCE_LABELS,
  EMPTY_HANDLING,
  EXPLOSION_WARN_ROWS,
  PER_ROW_WARN,
  createEmptyNestedConfig,
  suggestNestedConfig,
  validateNestedConfig,
  elementColumnName,
  readList,
  previewNestedToRows,
  buildNestedToRowsSQL,
  nestedToRowsTransform,
  describeNestedToRows,
};
