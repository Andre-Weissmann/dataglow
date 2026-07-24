// ============================================================
// DATAGLOW - Excel Hell Repair (pure engine)
// ============================================================
// Detects the real header, strips junk title/blank/footer rows,
// collapses multi-row headers, and coerces column types. Produces
// a reversible, refreshable Power Query-style recipe. On-device.
// No DOM. No network. No LLM.
//
// Data model contract:
//   - rows are arrays: cell = row[colIdx]
//   - column types are UPPERCASE: 'INT'|'FLOAT'|'STR'|'DATE'|'BOOL'
//
// Public:
//   detect(dataset)           -> { findings, recipe }
//   preview(dataset, recipe)  -> { columns, rows } (non-mutating)
//   apply(dataset, recipe)    -> { columns, rows, undo } (mutates dataset)
//   undo(dataset)             -> boolean (restores pre-image if present)
//   refresh(dataset, recipe)  -> apply result if fingerprint roughly matches

export const EXCEL_HELL_REPAIR_VERSION = 1;

var SCAN_ROWS = 25;
var PREVIEW_ROWS = 20;
var FOOTER_KEYWORDS = /^(total|totals|subtotal|sum|grand total|notes?|source:|generated|confidential|end of report)/i;
var BOOL_TRUE = ['true', 'yes', 'y', 't'];
var BOOL_FALSE = ['false', 'no', 'n', 'f'];

// ---- small helpers ---------------------------------------------------------

function isBlank(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

function cellStr(v) {
  return v == null ? '' : String(v);
}

function colName(col, i) {
  if (col == null) return 'col' + (i + 1);
  if (typeof col === 'string') return col;
  return col.name || col.field || ('col' + (i + 1));
}

function gridWidth(dataset) {
  var w = (dataset && dataset.columns && dataset.columns.length) || 0;
  var rows = (dataset && dataset.rows) || [];
  for (var i = 0; i < rows.length; i++) {
    if (Array.isArray(rows[i]) && rows[i].length > w) w = rows[i].length;
  }
  return w;
}

function rowFilled(row, width) {
  var n = 0;
  for (var c = 0; c < width; c++) {
    if (!isBlank(row ? row[c] : null)) n++;
  }
  return n;
}

// ---- type inference --------------------------------------------------------

var INT_RE = /^-?\d{1,15}$/;
var FLOAT_RE = /^-?\d*\.\d+$|^-?\d+\.\d*$|^-?\d+(?:\.\d+)?[eE][-+]?\d+$/;
var DATE_RES = [
  /^\d{4}-\d{1,2}-\d{1,2}$/,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/,
  /^\d{4}\/\d{1,2}\/\d{1,2}$/
];

function looksInt(s) { return INT_RE.test(s); }
function looksFloat(s) { return FLOAT_RE.test(s) || (INT_RE.test(s) && s.length <= 15); }
function looksDate(s) {
  for (var i = 0; i < DATE_RES.length; i++) if (DATE_RES[i].test(s)) return true;
  return false;
}
function looksBool(s) {
  var l = s.toLowerCase();
  return BOOL_TRUE.indexOf(l) !== -1 || BOOL_FALSE.indexOf(l) !== -1;
}

export function inferColumnType(values) {
  var nonEmpty = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (!isBlank(v)) nonEmpty.push(String(v).trim());
  }
  if (nonEmpty.length === 0) return { type: 'STR', confidence: 0 };

  var counts = { INT: 0, FLOAT: 0, DATE: 0, BOOL: 0 };
  for (var j = 0; j < nonEmpty.length; j++) {
    var s = nonEmpty[j];
    if (looksBool(s)) counts.BOOL++;
    if (looksInt(s)) counts.INT++;
    else if (looksFloat(s)) counts.FLOAT++;
    if (looksDate(s)) counts.DATE++;
  }
  var n = nonEmpty.length;
  // Order of preference: BOOL > DATE > INT > FLOAT, each needs a strong majority.
  if (counts.BOOL === n) return { type: 'BOOL', confidence: 1 };
  if (counts.DATE / n >= 0.9) return { type: 'DATE', confidence: counts.DATE / n };
  if (counts.INT === n) return { type: 'INT', confidence: 1 };
  if ((counts.INT + counts.FLOAT) / n >= 0.9) {
    // any decimals present -> FLOAT, else INT
    return { type: counts.FLOAT > 0 ? 'FLOAT' : 'INT', confidence: (counts.INT + counts.FLOAT) / n };
  }
  return { type: 'STR', confidence: 1 };
}

function coerceValue(v, type) {
  if (isBlank(v)) return null;
  var s = String(v).trim();
  switch (type) {
    case 'INT': {
      var n = parseInt(s.replace(/,/g, ''), 10);
      return isNaN(n) ? v : n;
    }
    case 'FLOAT': {
      var f = parseFloat(s.replace(/,/g, ''));
      return isNaN(f) ? v : f;
    }
    case 'BOOL': {
      var l = s.toLowerCase();
      if (BOOL_TRUE.indexOf(l) !== -1) return true;
      if (BOOL_FALSE.indexOf(l) !== -1) return false;
      return v;
    }
    case 'DATE':
      return s; // keep normalized string; downstream DATE parsing owns format
    default:
      return s;
  }
}

// ---- header scoring --------------------------------------------------------

function scoreHeaderRow(row, width) {
  if (!row) return 0;
  var filled = 0, stringish = 0, numeric = 0;
  var seen = Object.create(null);
  var unique = 0;
  for (var c = 0; c < width; c++) {
    var v = row[c];
    if (isBlank(v)) continue;
    filled++;
    var s = String(v).trim();
    var key = s.toLowerCase();
    if (!seen[key]) { seen[key] = 1; unique++; }
    if (INT_RE.test(s) || FLOAT_RE.test(s)) numeric++;
    else stringish++;
  }
  if (filled < 2) return 0;
  var density = filled / width;
  var uniqueness = filled ? unique / filled : 0;
  var stringRatio = filled ? stringish / filled : 0;
  var score = density * 0.35 + uniqueness * 0.3 + stringRatio * 0.35;
  if (numeric === filled) score *= 0.2; // all-numeric row is data, not a header
  return score;
}

function isHeaderish(row, width) {
  return scoreHeaderRow(row, width) >= 0.45;
}

function hashNames(names) {
  var h = 0;
  var s = names.join('|').toLowerCase();
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

// ---- detect ----------------------------------------------------------------

export function detect(dataset) {
  var rows = (dataset && Array.isArray(dataset.rows)) ? dataset.rows : [];
  var width = gridWidth(dataset);
  var findings = [];
  var steps = [];

  if (rows.length === 0 || width === 0) {
    return {
      findings: [{ kind: 'empty', label: 'No rows to repair', detail: 'Dataset is empty.' }],
      recipe: emptyRecipe(dataset, width)
    };
  }

  var scanN = Math.min(rows.length, SCAN_ROWS);

  // 1. Best header row among the first N rows.
  var bestIdx = 0, bestScore = -1;
  for (var i = 0; i < scanN; i++) {
    var sc = scoreHeaderRow(rows[i], width);
    if (sc > bestScore) { bestScore = sc; bestIdx = i; }
  }
  var headerIdx = bestScore > 0 ? bestIdx : 0;

  // 2. Multi-row header collapse: consecutive header-ish rows just above/at header.
  var headerRows = [headerIdx];
  var up = headerIdx - 1;
  while (up >= 0 && headerRows.length < 3 && isHeaderish(rows[up], width)) {
    headerRows.unshift(up);
    up--;
  }
  var multiHeader = headerRows.length > 1;

  // 3. Column names from header row(s).
  var names = buildHeaderNames(rows, headerRows, width);

  if (multiHeader) {
    steps.push({ op: 'mergeHeaderRows', rowIndices: headerRows.slice(), joiner: ' / ' });
    findings.push({
      kind: 'multiHeader',
      label: 'Merge ' + headerRows.length + ' header rows',
      detail: 'Rows ' + headerRows.map(function (r) { return r + 1; }).join(' and ') + ' form one header.'
    });
  } else {
    steps.push({ op: 'promoteHeader', rowIndex: headerIdx });
  }
  findings.unshift({
    kind: 'header',
    label: 'Header is on row ' + (headerRows[0] + 1),
    detail: 'Detected the real column names automatically.'
  });

  // 4. Junk title rows above the header.
  var titleIdx = [];
  for (var t = 0; t < headerRows[0]; t++) titleIdx.push(t);
  if (titleIdx.length) {
    steps.push({ op: 'dropRows', indices: titleIdx.slice() });
    findings.push({
      kind: 'title',
      label: 'Drop ' + titleIdx.length + ' title row' + (titleIdx.length > 1 ? 's' : ''),
      detail: 'Rows above the header look like titles or notes.'
    });
  }

  // 5. Footer junk: trailing sparse / total / note rows.
  var footerIdx = [];
  var lastHeader = headerRows[headerRows.length - 1];
  for (var f = rows.length - 1; f > lastHeader; f--) {
    var row = rows[f];
    var filled = rowFilled(row, width);
    var first = row ? cellStr(row[0]).trim() : '';
    var isFooter = filled > 0 && (filled <= Math.max(1, Math.floor(width * 0.4)) || FOOTER_KEYWORDS.test(first));
    if (isFooter) footerIdx.push(f);
    else if (filled > 0) break; // stop at first real data row from the bottom
  }
  if (footerIdx.length) {
    footerIdx.sort(function (a, b) { return a - b; });
    steps.push({ op: 'dropRows', indices: footerIdx });
    findings.push({
      kind: 'footer',
      label: 'Drop ' + footerIdx.length + ' footer row' + (footerIdx.length > 1 ? 's' : ''),
      detail: 'Trailing totals or notes below the data.'
    });
  }

  // 6. Blank spacer rows inside the body.
  var bodyStart = lastHeader + 1;
  var footerSet = {};
  footerIdx.forEach(function (x) { footerSet[x] = 1; });
  var blankCount = 0;
  for (var b = bodyStart; b < rows.length; b++) {
    if (footerSet[b]) continue;
    if (rowFilled(rows[b], width) === 0) blankCount++;
  }
  if (blankCount) {
    steps.push({ op: 'dropEmptyRows' });
    findings.push({
      kind: 'blank',
      label: 'Drop ' + blankCount + ' empty row' + (blankCount > 1 ? 's' : ''),
      detail: 'Blank spacer rows removed from the table.'
    });
  }

  // 7. Empty columns (fully blank in the body).
  var emptyCols = 0;
  for (var cc = 0; cc < width; cc++) {
    var any = false;
    for (var rr = bodyStart; rr < rows.length; rr++) {
      if (footerSet[rr]) continue;
      if (!isBlank(rows[rr] ? rows[rr][cc] : null)) { any = true; break; }
    }
    if (!any) emptyCols++;
  }
  if (emptyCols) {
    steps.push({ op: 'dropEmptyColumns' });
    findings.push({
      kind: 'emptyCols',
      label: 'Drop ' + emptyCols + ' empty column' + (emptyCols > 1 ? 's' : ''),
      detail: 'Columns with no values were removed.'
    });
  }

  // Always trim whitespace.
  steps.push({ op: 'trimCells' });

  // 8. Type coercion proposals from the body.
  var typeMap = {};
  var typeFixes = 0;
  for (var col = 0; col < names.length; col++) {
    var vals = [];
    for (var rw = bodyStart; rw < rows.length && vals.length < 500; rw++) {
      if (footerSet[rw]) continue;
      if (rowFilled(rows[rw], width) === 0) continue;
      vals.push(rows[rw] ? rows[rw][col] : null);
    }
    var inf = inferColumnType(vals);
    if (inf.type !== 'STR' && inf.confidence >= 0.9) {
      typeMap[names[col]] = inf.type;
      typeFixes++;
    }
  }
  if (typeFixes) {
    steps.push({ op: 'coerceTypes', types: typeMap });
    findings.push({
      kind: 'types',
      label: typeFixes + ' type fix' + (typeFixes > 1 ? 'es' : ''),
      detail: 'Numbers, dates and booleans typed correctly.'
    });
  }

  var recipe = {
    id: 'excelhell-' + Date.now(),
    name: 'Excel Hell Repair',
    createdAt: new Date().toISOString(),
    steps: steps,
    sourceFingerprint: {
      rowCount: rows.length,
      colCount: width,
      headerHash: hashNames(names)
    }
  };

  return { findings: findings, recipe: recipe };
}

function emptyRecipe(dataset, width) {
  return {
    id: 'excelhell-' + Date.now(),
    name: 'Excel Hell Repair',
    createdAt: new Date().toISOString(),
    steps: [],
    sourceFingerprint: {
      rowCount: (dataset && dataset.rows && dataset.rows.length) || 0,
      colCount: width || 0,
      headerHash: '0'
    }
  };
}

function buildHeaderNames(rows, headerRows, width) {
  var names = [];
  for (var c = 0; c < width; c++) {
    var parts = [];
    for (var h = 0; h < headerRows.length; h++) {
      var v = rows[headerRows[h]] ? rows[headerRows[h]][c] : null;
      var s = cellStr(v).trim();
      if (s && parts.indexOf(s) === -1) parts.push(s);
    }
    var nm = parts.join(' / ');
    if (!nm) nm = 'col' + (c + 1);
    names.push(nm);
  }
  // de-duplicate
  var seen = Object.create(null);
  for (var i = 0; i < names.length; i++) {
    var base = names[i];
    var k = base.toLowerCase();
    if (seen[k]) {
      var n = 2;
      while (seen[(base + '_' + n).toLowerCase()]) n++;
      names[i] = base + '_' + n;
    }
    seen[names[i].toLowerCase()] = 1;
  }
  return names;
}

// ---- transform (shared by preview / apply / refresh) -----------------------

function findStep(steps, op) {
  for (var i = 0; i < steps.length; i++) if (steps[i].op === op) return steps[i];
  return null;
}

function transform(dataset, recipe) {
  var srcRows = (dataset && Array.isArray(dataset.rows)) ? dataset.rows : [];
  var width = gridWidth(dataset);
  var steps = (recipe && recipe.steps) || [];

  // 1. Establish header + column names.
  var headerRows = [];
  var merge = findStep(steps, 'mergeHeaderRows');
  var promote = findStep(steps, 'promoteHeader');
  var names;
  if (merge) {
    headerRows = merge.rowIndices.slice();
    names = buildHeaderNames(srcRows, headerRows, width);
  } else if (promote) {
    headerRows = [promote.rowIndex];
    names = buildHeaderNames(srcRows, headerRows, width);
  } else {
    names = (dataset && dataset.columns) ? dataset.columns.map(colName) : [];
    for (var g = names.length; g < width; g++) names.push('col' + (g + 1));
  }
  var maxHeader = headerRows.length ? Math.max.apply(null, headerRows) : -1;

  // 2. Build removal set of raw row indices.
  var remove = Object.create(null);
  for (var i = 0; i <= maxHeader; i++) remove[i] = 1; // header + everything above
  steps.forEach(function (st) {
    if (st.op === 'dropRows' && Array.isArray(st.indices)) {
      st.indices.forEach(function (x) { remove[x] = 1; });
    } else if (st.op === 'dropRowRange') {
      for (var r = st.start; r <= st.end; r++) remove[r] = 1;
    }
  });

  // 3. Body rows (normalized to width).
  var body = [];
  for (var rr = 0; rr < srcRows.length; rr++) {
    if (remove[rr]) continue;
    var src = srcRows[rr] || [];
    var row = [];
    for (var c = 0; c < width; c++) row[c] = src[c] == null ? null : src[c];
    body.push(row);
  }

  var doTrim = !!findStep(steps, 'trimCells');
  if (doTrim) {
    for (var t = 0; t < body.length; t++) {
      for (var tc = 0; tc < width; tc++) {
        if (typeof body[t][tc] === 'string') body[t][tc] = body[t][tc].trim();
      }
    }
  }

  // 4. renameColumns.
  var rename = findStep(steps, 'renameColumns');
  if (rename && rename.map) {
    for (var rn = 0; rn < names.length; rn++) {
      if (Object.prototype.hasOwnProperty.call(rename.map, names[rn])) {
        names[rn] = rename.map[names[rn]];
      }
    }
  }

  // 5. Column type map (start STR).
  var types = [];
  for (var ct = 0; ct < names.length; ct++) types.push('STR');
  var coerce = findStep(steps, 'coerceTypes');
  if (coerce && coerce.types) {
    for (var cq = 0; cq < names.length; cq++) {
      if (Object.prototype.hasOwnProperty.call(coerce.types, names[cq])) {
        types[cq] = coerce.types[names[cq]];
      }
    }
    for (var br = 0; br < body.length; br++) {
      for (var bc = 0; bc < width; bc++) {
        if (types[bc] !== 'STR') body[br][bc] = coerceValue(body[br][bc], types[bc]);
      }
    }
  }

  // 6. dropEmptyRows.
  if (findStep(steps, 'dropEmptyRows')) {
    body = body.filter(function (row) { return rowFilled(row, width) > 0; });
  }

  // 7. dropEmptyColumns.
  var keepCols = [];
  for (var kc = 0; kc < width; kc++) keepCols.push(kc);
  if (findStep(steps, 'dropEmptyColumns')) {
    keepCols = keepCols.filter(function (ci) {
      for (var b = 0; b < body.length; b++) {
        if (!isBlank(body[b][ci])) return true;
      }
      return false;
    });
  }

  var outColumns = keepCols.map(function (ci) {
    return { name: names[ci], type: types[ci] };
  });
  var outRows = body.map(function (row) {
    return keepCols.map(function (ci) { return row[ci]; });
  });

  return { columns: outColumns, rows: outRows };
}

// ---- public: preview / apply / undo / refresh ------------------------------

export function preview(dataset, recipe, opts) {
  opts = opts || {};
  var limit = typeof opts.limit === 'number' ? opts.limit : PREVIEW_ROWS;
  if (!dataset || !recipe) return { columns: [], rows: [] };
  var out = transform(dataset, recipe);
  return {
    columns: out.columns,
    rows: out.rows.slice(0, limit),
    totalRows: out.rows.length
  };
}

function snapshot(dataset) {
  return {
    columns: JSON.parse(JSON.stringify(dataset.columns || [])),
    rows: JSON.parse(JSON.stringify(dataset.rows || []))
  };
}

export function apply(dataset, recipe) {
  if (!dataset || !recipe) return { columns: [], rows: [] };
  var out = transform(dataset, recipe);

  // Store pre-image for undo.
  try {
    dataset._excelHellSnapshot = snapshot(dataset);
    dataset._excelHellRecipe = recipe;
  } catch (_e) {}

  dataset.columns = out.columns;
  dataset.rows = out.rows;

  // Audit trail (best effort; engine stays DOM/host agnostic).
  try {
    if (typeof window !== 'undefined' && window.ProvenanceFabric &&
        typeof window.ProvenanceFabric.append === 'function') {
      window.ProvenanceFabric.append('excel_hell_repair', {
        steps: recipe.steps.map(function (s) { return s.op; }),
        columns: out.columns.length,
        rows: out.rows.length
      });
    }
  } catch (_e2) {}

  return { columns: out.columns, rows: out.rows, undo: function () { return undo(dataset); } };
}

export function undo(dataset) {
  if (!dataset || !dataset._excelHellSnapshot) return false;
  dataset.columns = dataset._excelHellSnapshot.columns;
  dataset.rows = dataset._excelHellSnapshot.rows;
  delete dataset._excelHellSnapshot;
  return true;
}

export function fingerprintMatches(dataset, recipe) {
  if (!recipe || !recipe.sourceFingerprint) return false;
  var fp = recipe.sourceFingerprint;
  var width = gridWidth(dataset);
  var rowCount = (dataset && dataset.rows && dataset.rows.length) || 0;
  if (fp.colCount === width) return true; // same shape width -> refreshable
  if (fp.rowCount === rowCount) return true;
  return false;
}

export function refresh(dataset, recipe) {
  if (!dataset || !recipe) return null;
  if (!fingerprintMatches(dataset, recipe)) return null;
  return apply(dataset, recipe);
}

export const DataGlowExcelHellRepair = {
  version: EXCEL_HELL_REPAIR_VERSION,
  detect: detect,
  preview: preview,
  apply: apply,
  undo: undo,
  refresh: refresh,
  fingerprintMatches: fingerprintMatches,
  inferColumnType: inferColumnType
};

if (typeof window !== 'undefined') {
  window.DataGlowExcelHellRepair = DataGlowExcelHellRepair;
}
