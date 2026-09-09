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

/*
 * NON-DATA ROWS: sub-labels under the header and footnotes at the bottom.
 *
 * A government statistics sheet is laid out for a human reader, not for a
 * parser. The CMS Federal IDR tables are typical: a merged title on row 1, the
 * column names on row 2, a period sub-label ("2025 Q2") on row 5 sitting under
 * each numeric column, 56 states and territories, then two paragraphs of
 * Source and Notes at the bottom. Read naively that is 59 rows, and the app
 * then reports 59 rows of data with no hint that three of them are not data at
 * all. The count is the first number anyone reads and it was wrong.
 *
 * These two detectors are deliberately narrow. A row is only set aside when it
 * is structurally impossible for it to be a data row in this table, never
 * because its content looks unusual. Anything the detectors are unsure about
 * stays in the table, because a missing row is a worse failure than an extra
 * one, and every row that is set aside is named in the import notes with its
 * sheet row number so the reader can check the call.
 */

var FOOTNOTE_PREFIX = /^\s*(sources?|notes?|footnotes?|definitions?|methodology|abbreviations?|caveats?|disclaimer)\b\s*[:.\-]/i;
var FOOTNOTE_MARKER = /^\s*[*+\u2020\u2021\u00a7#]\s*\S/;
var LONG_PROSE = 80;

function cellText(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function filledIndexes(row, width) {
  var out = [];
  for (var c = 0; c < width; c++) {
    if (!isBlankCell(row && row[c])) out.push(c);
  }
  return out;
}

/**
 * A footnote row: one filled cell, in the first column, in the trailing block
 * of the sheet, holding either a labelled note ("Source:", "Notes:") or a
 * marker line, or a paragraph far too long to be a key.
 *
 * The trailing-block requirement is what makes this safe. A row like this in
 * the middle of a table is left alone, because there it could be a real record
 * whose other columns happen to be empty.
 */
function looksLikeFootnoteRow(row, width) {
  if (width < 2) return false;
  var filled = filledIndexes(row, width);
  if (filled.length !== 1 || filled[0] !== 0) return false;
  var text = cellText(row[0]);
  if (!text || looksNumericText(text) || typeof row[0] === 'number') return false;
  return FOOTNOTE_PREFIX.test(text) || FOOTNOTE_MARKER.test(text) || text.length >= LONG_PROSE;
}

/**
 * A sub-label row: the row directly under the header that carries a period or
 * unit label over the numeric columns instead of a record. Its key cell is
 * blank (usually because the header cell above it is merged down over it), and
 * every value it does carry is short text standing over a column that is
 * numeric everywhere else.
 */
function looksLikeSubLabelRow(row, width, laterRows) {
  if (width < 2) return false;
  if (!isBlankCell(row && row[0])) return false;
  var filled = filledIndexes(row, width);
  if (!filled.length) return false;

  for (var i = 0; i < filled.length; i++) {
    var c = filled[i];
    var v = row[c];
    if (typeof v !== 'string') return false;
    var text = cellText(v);
    if (!text || text.length > 40 || looksNumericText(text)) return false;

    // The column underneath has to be genuinely numeric, otherwise this is
    // just a record with a blank key.
    var numeric = 0;
    var seen = 0;
    for (var r = 0; r < laterRows.length; r++) {
      var below = laterRows[r][c];
      if (isBlankCell(below)) continue;
      seen++;
      if (typeof below === 'number' || looksNumericText(below)) numeric++;
    }
    if (seen < 3 || numeric / seen < 0.8) return false;
  }
  return true;
}

/**
 * Classify body rows into data and not-data.
 *
 * @param {Array<Array<*>>} bodyRows non-blank rows under the header, in order
 * @param {number} width  columns in play
 * @returns {{ flagged:boolean[], labels:number[], footnotes:number[], count:number }}
 *          indexes are into `bodyRows`
 */
export function classifyNonDataRows(bodyRows, width) {
  var rows = Array.isArray(bodyRows) ? bodyRows : [];
  var flagged = rows.map(function () { return false; });
  var labels = [];
  var footnotes = [];

  // Footnotes, walking up from the bottom. The moment a row is not a footnote
  // the block has ended, so nothing above it is examined.
  for (var i = rows.length - 1; i >= 0; i--) {
    if (!looksLikeFootnoteRow(rows[i], width)) break;
    flagged[i] = true;
    footnotes.unshift(i);
  }

  // Sub-labels, only in the first two rows under the header, and only while
  // every row so far has been a sub-label. A label three rows into a table is
  // not a header artefact.
  var remaining = rows.filter(function (_r, idx) { return !flagged[idx]; });
  for (var j = 0; j < Math.min(2, rows.length); j++) {
    if (flagged[j]) break;
    var later = remaining.slice(j + 1);
    if (!looksLikeSubLabelRow(rows[j], width, later)) break;
    flagged[j] = true;
    labels.push(j);
  }

  return { flagged: flagged, labels: labels, footnotes: footnotes, count: labels.length + footnotes.length };
}

/** Plain-language sentence for what was set aside. Never a score, never a grade. */
export function describeNonDataRows(detail) {
  if (!detail || !detail.count) return '';
  var count = detail.count;
  var parts = [];
  if (detail.labels.length) {
    parts.push(detail.labels.length === 1
      ? 'One is a sub-label under the header (' + rowWord(detail.labels) + ').'
      : detail.labels.length + ' are sub-labels under the header (' + rowWord(detail.labels) + ').');
  }
  if (detail.footnotes.length) {
    parts.push(detail.footnotes.length === 1
      ? 'One is a footnote at the bottom (' + rowWord(detail.footnotes) + ').'
      : detail.footnotes.length + ' are footnotes at the bottom (' + rowWord(detail.footnotes) + ').');
  }
  return count + ' row' + (count === 1 ? '' : 's') + ' look like notes or labels, not data, so ' +
    (count === 1 ? 'it was' : 'they were') + ' left out of the table. ' + parts.join(' ') +
    ' The row count you see is the count of real data rows. Your file is unchanged.';
}

function rowWord(entries) {
  var nums = entries.map(function (e) { return String(e.sheetRow); });
  var lead = nums.length === 1 ? 'row ' : 'rows ';
  if (nums.length === 1) return lead + nums[0];
  if (nums.length === 2) return lead + nums[0] + ' and ' + nums[1];
  return lead + nums.slice(0, -1).join(', ') + ' and ' + nums[nums.length - 1];
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
    return {
      columns: [], rows: [], notes: ['This sheet is empty. Nothing was loaded from it.'],
      headerRowIndex: -1, nonDataRows: { count: 0, labels: [], footnotes: [] },
    };
  }

  var headerRowIndex = findHeaderRow(aoa);
  if (headerRowIndex === -1) headerRowIndex = 0;
  if (headerRowIndex > 0) {
    notes.push('The header was not on row 1. Row ' + (headerRowIndex + 1) +
      ' was used as the header and the ' + headerRowIndex + ' row' +
      (headerRowIndex === 1 ? '' : 's') + ' above it were skipped.');
  }

  var headerCells = aoa[headerRowIndex] || [];
  // Keep each surviving row's sheet row number (1-indexed, the number Excel
  // shows) so anything set aside later can be named rather than just counted.
  var bodyRows = [];
  var bodySheetRows = [];
  for (var bi = headerRowIndex + 1; bi < aoa.length; bi++) {
    if (rowIsBlank(aoa[bi])) continue;
    bodyRows.push(aoa[bi]);
    bodySheetRows.push(bi + 1);
  }
  var bodyRaw = bodyRows;

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
    return {
      columns: [], rows: [], notes: ['This sheet has no usable columns. Nothing was loaded from it.'],
      headerRowIndex: headerRowIndex, nonDataRows: { count: 0, labels: [], footnotes: [] },
    };
  }

  // Sub-labels and footnotes are not records. Set them aside before anything
  // counts rows or infers a type, and say so in the notes.
  var nonData = classifyNonDataRows(bodyRaw, width);
  var nonDataRows = { count: 0, labels: [], footnotes: [] };
  if (nonData.count) {
    nonData.labels.forEach(function (idx) {
      nonDataRows.labels.push({ sheetRow: bodySheetRows[idx], text: rowPreview(bodyRaw[idx], width) });
    });
    nonData.footnotes.forEach(function (idx) {
      nonDataRows.footnotes.push({ sheetRow: bodySheetRows[idx], text: rowPreview(bodyRaw[idx], width) });
    });
    nonDataRows.count = nonDataRows.labels.length + nonDataRows.footnotes.length;

    var keptRows = [];
    var keptSheetRows = [];
    for (var kd = 0; kd < bodyRaw.length; kd++) {
      if (nonData.flagged[kd]) continue;
      keptRows.push(bodyRaw[kd]);
      keptSheetRows.push(bodySheetRows[kd]);
    }
    bodyRaw = keptRows;
    bodySheetRows = keptSheetRows;
    notes.push(describeNonDataRows(nonDataRows));
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

  return {
    columns: columns,
    rows: rows,
    notes: notes,
    headerRowIndex: headerRowIndex,
    nonDataRows: nonDataRows,
  };
}

/** First 120 characters of a row, joined, for naming a row in a notice. */
export function rowPreview(row, width) {
  var parts = [];
  for (var c = 0; c < (width || (row ? row.length : 0)); c++) {
    var t = cellText(row ? row[c] : null);
    if (t) parts.push(t);
  }
  var joined = parts.join(' | ');
  return joined.length > 120 ? joined.slice(0, 117) + '...' : joined;
}

/**
 * A small summary per sheet so the UI can offer a real choice instead of
 * silently taking the first sheet.
 *
 * The row count here is the count of data rows, matching what the sheet will
 * report once it is loaded. A picker that promises 59 rows and then loads 56 is
 * its own small lie, so notes and labels are discounted the same way.
 */
export function summarizeSheets(sheetNames, getAoa) {
  return (sheetNames || []).map(function (sheetName) {
    var aoa = getAoa(sheetName) || [];
    var body = aoa.filter(function (r) { return !rowIsBlank(r); });
    var headerIdx = findHeaderRow(aoa);
    var headerCells = headerIdx >= 0 ? (aoa[headerIdx] || []) : [];
    var cols = headerCells.filter(function (c) { return !isBlankCell(c); }).length;

    var dataRows = [];
    var startAt = headerIdx >= 0 ? headerIdx + 1 : 0;
    for (var i = startAt; i < aoa.length; i++) {
      if (!rowIsBlank(aoa[i])) dataRows.push(aoa[i]);
    }
    var widest = headerCells.length;
    dataRows.forEach(function (r) { if (r.length > widest) widest = r.length; });
    var aside = classifyNonDataRows(dataRows, widest);

    return {
      name: sheetName,
      // Count the rows the loader will actually load: everything under the
      // header, minus the blanks it drops and the notes and labels it sets
      // aside. The old arithmetic started from every non-blank row in the
      // sheet and subtracted only the header, so a merged title sitting above
      // the header was counted as a record here too.
      rowCount: Math.max(0, dataRows.length - aside.count),
      nonDataRowCount: aside.count,
      columnCount: cols,
      empty: sheetIsEmpty(aoa),
    };
  });
}
