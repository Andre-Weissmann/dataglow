/**
 * excel-import.js - turn a SheetJS worksheet into a DataGlow dataset.
 *
 * DataGlow rows are POSITIONAL ARRAYS and columns are { name, type } objects
 * (see js/shared/row-shape.js). This module is the single place that converts
 * a sheet's array-of-arrays into that shape.
 *
 * It is deliberately pure: it takes an array of arrays plus a small options
 * object and returns a plain result. It never touches the DOM, never fetches,
 * and does not require the XLSX global, so it is testable under plain Node.
 *
 * Real spreadsheets are messy. Rather than silently mangling them, this module
 * DETECTS and REPORTS the common problems and says what it did about each one:
 *
 *   - blank leading rows before the real header
 *   - a header row that is not row 1
 *   - trailing all-empty columns (Excel pads the used range constantly)
 *   - blank or duplicated header cells
 *   - merged cells, which flatten to a value in the first cell and blanks after
 *   - dates stored as Excel serial numbers
 *   - numbers stored as text
 *
 * Public API:
 *   sheetIsEmpty(aoa)                   -> boolean
 *   findHeaderRow(aoa)                  -> index into aoa, or -1
 *   normalizeHeaders(cells)             -> { names, notes }
 *   excelSerialToISO(serial, is1904)    -> 'YYYY-MM-DD' or null
 *   aoaToDataset(aoa, name, opts)       -> { columns, rows, notes, headerRowIndex }
 */

// Excel's day 0 is 1899-12-30 in the 1900 date system (the off-by-one is
// Excel's, not ours: it thinks 1900 was a leap year). The 1904 system, used by
// some old Mac workbooks, starts at 1904-01-01.
var EPOCH_1900_MS = Date.UTC(1899, 11, 30);
var EPOCH_1904_MS = Date.UTC(1904, 0, 1);
var MS_PER_DAY = 86400000;

// A serial outside this window is almost certainly a plain number, not a date.
// 1 is 1899-12-31; 100000 is well past the year 2170.
var MIN_DATE_SERIAL = 1;
var MAX_DATE_SERIAL = 100000;

export function isBlankCell(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export function rowIsBlank(row) {
  return !row || !row.length || row.every(isBlankCell);
}

export function sheetIsEmpty(aoa) {
  return !aoa || !aoa.length || aoa.every(rowIsBlank);
}

/**
 * Find the header row. Excel exports routinely start with a title, a blank
 * line, and a merged banner before the real column names. The header is taken
 * to be the first non-blank row whose cells are mostly short, non-numeric
 * strings, and which is followed by at least one row of the same width.
 */
export function findHeaderRow(aoa) {
  if (!aoa || !aoa.length) return -1;
  var limit = Math.min(aoa.length, 20);
  var best = -1;
  var bestScore = -1;

  for (var i = 0; i < limit; i++) {
    var row = aoa[i];
    if (rowIsBlank(row)) continue;

    var filled = 0;
    var stringy = 0;
    for (var c = 0; c < row.length; c++) {
      if (isBlankCell(row[c])) continue;
      filled++;
      var v = row[c];
      if (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 120 && !/^-?[\d.,]+$/.test(v.trim())) {
        stringy++;
      }
    }
    if (!filled) continue;

    // A header should be mostly text and should have more than one filled cell,
    // otherwise it is a title line.
    var score = (stringy / filled) * 100 + Math.min(filled, 20);
    if (filled === 1) score -= 60;

    if (score > bestScore) { bestScore = score; best = i; }
    // A clean, fully textual, multi-column row is good enough. Stop looking.
    if (filled > 1 && stringy === filled) return i;
  }
  return best;
}

/** Blank and duplicate header cells get stable, obvious names. */
export function normalizeHeaders(cells) {
  var notes = [];
  var seen = {};
  var names = [];
  var blanks = 0;
  var dupes = 0;

  for (var i = 0; i < cells.length; i++) {
    var raw = cells[i];
    var name = isBlankCell(raw) ? '' : String(raw).trim();
    if (!name) {
      name = 'column_' + (i + 1);
      blanks++;
    }
    if (Object.prototype.hasOwnProperty.call(seen, name)) {
      seen[name] += 1;
      name = name + '_' + seen[name];
      dupes++;
    } else {
      seen[name] = 1;
    }
    names.push(name);
  }

  if (blanks) {
    notes.push(blanks + ' header cell' + (blanks === 1 ? ' was' : 's were') +
      ' blank and got a placeholder name such as column_3.');
  }
  if (dupes) {
    notes.push(dupes + ' header name' + (dupes === 1 ? ' was' : 's were') +
      ' duplicated and got a numeric suffix so each column stays addressable.');
  }
  return { names: names, notes: notes };
}

/** Excel serial number to an ISO date string. Returns null if out of range. */
export function excelSerialToISO(serial, is1904) {
  if (typeof serial !== 'number' || !isFinite(serial)) return null;
  if (serial < MIN_DATE_SERIAL || serial > MAX_DATE_SERIAL) return null;
  var base = is1904 ? EPOCH_1904_MS : EPOCH_1900_MS;
  var ms = base + Math.round(serial * MS_PER_DAY);
  var d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  var iso = d.toISOString();
  // A whole-day serial has no time component worth showing.
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

/** True when a string is really a number wearing a text costume. */
export function looksNumericText(v) {
  if (typeof v !== 'string') return false;
  var s = v.trim();
  if (!s) return false;
  // Allow a leading currency symbol, thousands separators, and a trailing
  // percent, since those are exactly how Excel stores "numbers as text".
  return /^[-+]?[$£€]?\s?\d{1,3}(,\d{3})*(\.\d+)?%?$/.test(s) ||
         /^[-+]?[$£€]?\s?\d+(\.\d+)?%?$/.test(s);
}

function inferType(values) {
  var nonBlank = values.filter(function (v) { return !isBlankCell(v); });
  if (!nonBlank.length) return 'STR';
  var allNum = nonBlank.every(function (v) { return typeof v === 'number'; });
  if (allNum) return nonBlank.every(function (v) { return v % 1 === 0; }) ? 'INT' : 'NUM';
  var allBool = nonBlank.every(function (v) { return typeof v === 'boolean'; });
  if (allBool) return 'BOOL';
  return 'STR';
}

/**
 * Convert an array of arrays into a DataGlow dataset.
 *
 * opts:
 *   dateColumns  array of 0-based column indexes SheetJS says are date-formatted
 *   merges       SheetJS `!merges` list, used only to report the count
 *   is1904       workbook uses the 1904 date system
 *   sheetName    for the notes
 */
export function aoaToDataset(aoa, name, opts) {
  opts = opts || {};
  var notes = [];

  if (sheetIsEmpty(aoa)) {
    return { columns: [], rows: [], notes: ['This sheet is empty. Nothing was loaded from it.'], headerRowIndex: -1 };
  }

  var headerRowIndex = findHeaderRow(aoa);
  if (headerRowIndex === -1) headerRowIndex = 0;
  if (headerRowIndex > 0) {
    notes.push('The header was not on row 1. Row ' + (headerRowIndex + 1) +
      ' was used as the header and the ' + headerRowIndex + ' row' +
      (headerRowIndex === 1 ? '' : 's') + ' above it were skipped.');
  }

  var headerCells = aoa[headerRowIndex] || [];
  var bodyRaw = aoa.slice(headerRowIndex + 1).filter(function (r) { return !rowIsBlank(r); });

  // Widest row wins, so a short header does not truncate real data.
  var width = headerCells.length;
  bodyRaw.forEach(function (r) { if (r.length > width) width = r.length; });

  // Trim trailing columns that are empty in the header AND in every data row.
  // Excel pads the used range constantly and those phantom columns are noise.
  var lastUsed = -1;
  for (var c = 0; c < width; c++) {
    var used = !isBlankCell(headerCells[c]);
    if (!used) {
      for (var r = 0; r < bodyRaw.length; r++) {
        if (!isBlankCell(bodyRaw[r][c])) { used = true; break; }
      }
    }
    if (used) lastUsed = c;
  }
  var trimmed = width - (lastUsed + 1);
  if (trimmed > 0) {
    notes.push(trimmed + ' trailing empty column' + (trimmed === 1 ? ' was' : 's were') +
      ' dropped. Excel pads the used range with blanks.');
  }
  width = lastUsed + 1;
  if (width <= 0) {
    return { columns: [], rows: [], notes: ['This sheet has no usable columns. Nothing was loaded from it.'], headerRowIndex: headerRowIndex };
  }

  var header = normalizeHeaders(headerCells.slice(0, width));
  notes = notes.concat(header.notes);

  var dateCols = {};
  (opts.dateColumns || []).forEach(function (i) { if (i < width) dateCols[i] = true; });

  // Build positional-array rows, converting as we go and counting what we did.
  var serialDatesConverted = 0;
  var numericTextCells = 0;
  var columnValues = [];
  for (var i = 0; i < width; i++) columnValues.push([]);

  var rows = bodyRaw.map(function (raw) {
    var out = new Array(width);
    for (var c2 = 0; c2 < width; c2++) {
      var v = c2 < raw.length ? raw[c2] : null;
      if (v === undefined) v = null;

      if (dateCols[c2] && typeof v === 'number') {
        var iso = excelSerialToISO(v, !!opts.is1904);
        if (iso !== null) { v = iso; serialDatesConverted++; }
      } else if (typeof v === 'string' && looksNumericText(v)) {
        numericTextCells++;
      }
      out[c2] = v;
      columnValues[c2].push(v);
    }
    return out;
  });

  if (serialDatesConverted) {
    notes.push(serialDatesConverted + ' cell' + (serialDatesConverted === 1 ? '' : 's') +
      ' held a date as an Excel serial number and ' + (serialDatesConverted === 1 ? 'was' : 'were') +
      ' converted to a readable date.');
  }
  if (numericTextCells) {
    notes.push(numericTextCells + ' cell' + (numericTextCells === 1 ? '' : 's') +
      ' look like numbers but are stored as text, often because of a currency symbol or a thousands separator. ' +
      'They were left exactly as they are so nothing is invented. Clean them before doing arithmetic on that column.');
  }
  var mergeCount = (opts.merges || []).length;
  if (mergeCount) {
    notes.push(mergeCount + ' merged cell range' + (mergeCount === 1 ? '' : 's') +
      ' in this sheet. A merged range keeps its value in the first cell and the rest read as blank. ' +
      'Check those columns before trusting them.');
  }

  var columns = header.names.map(function (n, i) {
    return { name: n, type: inferType(columnValues[i]) };
  });

  return { columns: columns, rows: rows, notes: notes, headerRowIndex: headerRowIndex };
}

/**
 * A small summary per sheet so the UI can offer a real choice instead of
 * silently taking the first sheet.
 */
export function summarizeSheets(sheetNames, getAoa) {
  return (sheetNames || []).map(function (sheetName) {
    var aoa = getAoa(sheetName) || [];
    var body = aoa.filter(function (r) { return !rowIsBlank(r); });
    var headerIdx = findHeaderRow(aoa);
    var headerCells = headerIdx >= 0 ? (aoa[headerIdx] || []) : [];
    var cols = headerCells.filter(function (c) { return !isBlankCell(c); }).length;
    return {
      name: sheetName,
      rowCount: Math.max(0, body.length - (headerIdx >= 0 ? 1 : 0)),
      columnCount: cols,
      empty: sheetIsEmpty(aoa),
    };
  });
}
