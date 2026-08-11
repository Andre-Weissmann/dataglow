/**
 * row-shape.js — DataGlow row-shape helpers (the one place that knows how a
 * cell is addressed).
 *
 * DataGlow dataset rows are POSITIONAL ARRAYS. Columns are `{ name, type }`.
 * The correct access is `row[columnIndex]`, never `row[columnName]`.
 * The dashboard engine has said so in its own header comment since PR AN, but
 * three other call sites (the DuckDB CSV serialiser, the CSV/PDF exporters and
 * the join executor) indexed rows by NAME instead. On an array row that always
 * yields `undefined`, so those paths produced empty cells, `[object Object]`
 * headers and cartesian-product joins.
 *
 * This module exists so there is exactly ONE implementation of "get me the
 * value of column X in this row", used by every one of those sites. It also
 * tolerates the object-shaped rows a few older code paths still hand around
 * (join results before this change, OCR fixtures, hand-built test rows), so the
 * helper is safe to drop into any call site without first proving which shape
 * arrives.
 *
 * Pure logic: no DOM, no network, no globals.
 */

/**
 * Index of `name` inside a `[{ name, type }, ...]` column list.
 * Accepts a list of plain strings too, since a few call sites keep column
 * names rather than column objects.
 * @returns {number} zero-based index, or -1 when the column is unknown.
 */
export function resolveColumnIndex(columns, name) {
  if (!columns || typeof columns.length !== 'number') return -1;
  for (var i = 0; i < columns.length; i++) {
    var c = columns[i];
    var cn = c && typeof c === 'object' ? c.name : c;
    if (cn === name) return i;
  }
  return -1;
}

/** Column names as a plain string array, whatever shape the list arrived in. */
export function columnNames(columns) {
  if (!columns || typeof columns.length !== 'number') return [];
  var out = [];
  for (var i = 0; i < columns.length; i++) {
    var c = columns[i];
    out.push(c && typeof c === 'object' ? c.name : c);
  }
  return out;
}

/**
 * Value of column `name` in `row`, for BOTH row shapes:
 *  - positional array row (the DataGlow norm) -> row[index]
 *  - object row (legacy/interop)              -> row[name]
 * Returns `undefined` when the row or column is missing.
 */
export function getCell(row, columns, name) {
  if (row == null) return undefined;
  if (Array.isArray(row)) {
    var idx = resolveColumnIndex(columns, name);
    return idx >= 0 ? row[idx] : undefined;
  }
  if (typeof row === 'object') {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
    // An object row that happens to be array-like (arguments, typed wrapper).
    var i2 = resolveColumnIndex(columns, name);
    return i2 >= 0 ? row[i2] : undefined;
  }
  return undefined;
}

/** Normalise any row shape to a positional array aligned to `columns`. */
export function rowToArray(row, columns) {
  if (Array.isArray(row)) return row;
  var names = columnNames(columns);
  var out = [];
  for (var i = 0; i < names.length; i++) out.push(getCell(row, columns, names[i]));
  return out;
}

/**
 * RFC 4180 field escaping: quote when the value contains a comma, a double
 * quote, CR or LF, and double any embedded quote. The previous serialisers
 * used JSON.stringify, which escapes an embedded quote as \" (a backslash) and
 * is therefore NOT valid CSV: DuckDB and Excel both read that back wrong.
 */
export function escapeCsvValue(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Serialise a `{ columns, rows }` dataset to an RFC 4180 CSV string, header
 * included. Rows may be arrays or objects.
 */
export function datasetToCsv(dataset) {
  if (!dataset || !dataset.columns) return '';
  var names = columnNames(dataset.columns);
  var lines = [names.map(escapeCsvValue).join(',')];
  var rows = dataset.rows || [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var cells = [];
    for (var c = 0; c < names.length; c++) {
      cells.push(escapeCsvValue(getCell(row, dataset.columns, names[c])));
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}
