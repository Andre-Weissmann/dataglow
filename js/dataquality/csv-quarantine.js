// ============================================================
// DATAGLOW - CSV quarantine: the rows that did not make it in
// ============================================================
//
// The CSV loader in this product already asks DuckDB for the rejected rows. It
// sets `ignore_errors=true` and `store_rejects=true`, which writes every line
// DuckDB refused into a rejects table together with the column it failed on and
// the reason it failed. Then it runs one COUNT over that table, drops it, and
// returns a number.
//
// So a person who loads a hundred thousand row file and gets ninety-eight
// thousand rows is told two thousand were skipped and has no way to find out
// which two thousand, or why, or whether the two thousand were the ones that
// mattered. The information existed. It was thrown away between two statements.
//
// This module keeps it. It is the pure half: the SQL that reads the rejects
// table before anything drops it, the normalisation of DuckDB's reject rows
// into something a table can render, and the receipt line that has to be
// written whether the person keeps the good rows or abandons the load.
//
// WHY "KEEP THE GOOD ROWS" IS A CONFIRM AND NOT A DEFAULT.
// Dropping two percent of a file is sometimes correct and sometimes the whole
// answer. A malformed trailing section is noise; a numeric column that failed
// to parse on every row after a certain date is the finding. The product cannot
// tell those apart, and the person can, in about four seconds, given the rows.
// So the load pauses and asks.
//
// WHY THERE IS A RECEIPT EITHER WAY.
// If someone keeps the good rows and later publishes a total, that total is a
// total of the rows that parsed. The receipt is what makes that recoverable six
// weeks later. Discarding rows silently is the failure mode this whole module
// exists to remove, so an override without a receipt line would reintroduce it
// through the back door.
//
// Pure. No DOM, no DuckDB handle, no network. The caller runs the SQL and hands
// the rows back.

export const QUARANTINE_KIND = 'dataglow-csv-quarantine';
export const QUARANTINE_VERSION = 1;

/** How many reject rows a surface should render before it stops and says so. */
export const REJECT_PREVIEW_LIMIT = 200;

export const QUARANTINE_DOCTRINE =
  'A row DuckDB could not parse is not a row that never existed. It is quarantined, shown, and either accepted as a loss on the record or the load is abandoned.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return '';
}

function int(v) {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' && isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (isFinite(n)) return Math.floor(n);
  }
  return null;
}

function quoteIdent(name) {
  return '"' + String(name == null ? '' : name).replace(/"/g, '""') + '"';
}

/**
 * Suffix for the pair of temporary tables DuckDB writes rejects into.
 *
 * Deterministic when a seed is given, so a test does not have to stub
 * Math.random to assert the SQL.
 */
export function rejectTableNames(seed) {
  const s = str(seed) || Math.random().toString(36).slice(2, 10);
  const safe = s.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'x';
  return {
    rejectsTable: '_dg_csv_rejects_' + safe,
    rejectsScan: '_dg_csv_scans_' + safe,
  };
}

/**
 * Read the quarantined rows themselves, not just their count.
 *
 * The columns named here are DuckDB's reject-table schema. Older builds do not
 * have every one of them, which is why the reader below looks each field up
 * defensively rather than indexing a fixed position.
 */
export function rejectRowsSql(rejectsTable, limit) {
  const cap = int(limit) && int(limit) > 0 ? int(limit) : REJECT_PREVIEW_LIMIT;
  return 'SELECT line, column_idx, column_name, error_type, error_message, csv_line\n'
    + 'FROM ' + quoteIdent(rejectsTable) + '\n'
    + 'ORDER BY line\n'
    + 'LIMIT ' + cap + ';';
}

/** Distinct source lines rejected. One line can raise several column errors. */
export function rejectCountSql(rejectsTable) {
  return 'SELECT count(DISTINCT line) AS dropped, count(*) AS errors\n'
    + 'FROM ' + quoteIdent(rejectsTable) + ';';
}

/** Errors grouped by reason, which is the summary that makes the cause obvious. */
export function rejectReasonsSql(rejectsTable) {
  return 'SELECT error_type, column_name, count(*) AS n\n'
    + 'FROM ' + quoteIdent(rejectsTable) + '\n'
    + 'GROUP BY ALL\n'
    + 'ORDER BY n DESC;';
}

/** Both temporary tables, dropped after the rows have been read out. */
export function dropRejectTablesSql(rejectsTable, rejectsScan) {
  return [
    'DROP TABLE IF EXISTS ' + quoteIdent(rejectsTable) + ';',
    'DROP TABLE IF EXISTS ' + quoteIdent(rejectsScan) + ';',
  ];
}

/**
 * One DuckDB reject row, read defensively into a fixed shape.
 *
 * `csv_line` is the original text of the line. It is the single most useful
 * field and the one most likely to be absent, because it is large and some
 * builds omit it.
 */
export function readRejectRow(row) {
  if (!isPlainObject(row)) return null;
  const pick = (...keys) => {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(row, k) && row[k] != null) return row[k];
    }
    return null;
  };
  const line = int(pick('line', 'line_number', 'row'));
  if (line == null) return null;
  return {
    line,
    columnIndex: int(pick('column_idx', 'column_index')),
    column: str(pick('column_name', 'column')) || 'unknown column',
    reason: str(pick('error_type', 'error')) || 'unknown',
    message: str(pick('error_message', 'message')),
    text: str(pick('csv_line', 'line_text', 'raw')),
  };
}

/**
 * The quarantine model a surface renders.
 *
 * @param {{fileName?:string, table?:string, keptRows?:number, rejectRows?:Array,
 *          droppedLines?:number, errorCount?:number, truncated?:boolean}} [input]
 */
export function buildQuarantine(input) {
  const inp = isPlainObject(input) ? input : {};
  const rows = (Array.isArray(inp.rejectRows) ? inp.rejectRows : []).map(readRejectRow).filter(Boolean);

  const distinctLines = [];
  for (const r of rows) if (distinctLines.indexOf(r.line) < 0) distinctLines.push(r.line);

  const dropped = int(inp.droppedLines) != null ? int(inp.droppedLines) : distinctLines.length;
  const kept = int(inp.keptRows) != null ? int(inp.keptRows) : 0;
  const total = kept + dropped;

  const byReason = [];
  for (const r of rows) {
    const key = r.reason + ' | ' + r.column;
    let found = null;
    for (const b of byReason) if (b.key === key) { found = b; break; }
    if (found) found.n += 1;
    else byReason.push({ key, reason: r.reason, column: r.column, n: 1, example: r.message || r.text });
  }
  byReason.sort((a, b) => b.n - a.n);

  const clean = dropped === 0;
  const pct = total > 0 ? Math.round((10000 * dropped) / total) / 100 : 0;

  return {
    kind: QUARANTINE_KIND,
    version: QUARANTINE_VERSION,
    fileName: str(inp.fileName),
    table: str(inp.table),
    clean,
    keptRows: kept,
    droppedRows: dropped,
    totalRows: total,
    droppedPercent: pct,
    errorCount: int(inp.errorCount) != null ? int(inp.errorCount) : rows.length,
    rows,
    // A reject table can hold more rows than anyone will read. The surface shows
    // a bounded slice and this says so, rather than letting a truncated list
    // read as the complete one.
    shown: rows.length,
    truncated: inp.truncated === true || rows.length >= REJECT_PREVIEW_LIMIT,
    reasons: byReason.map(b => ({ reason: b.reason, column: b.column, n: b.n, example: b.example })),
    doctrine: QUARANTINE_DOCTRINE,
    headline: clean
      ? 'Every line in this file parsed. Nothing was quarantined.'
      : dropped + ' line' + (dropped === 1 ? '' : 's') + ' of ' + total
        + ' could not be parsed and are held out of the table',
    detail: clean
      ? 'The row count in the table is the row count in the file.'
      : 'That is ' + pct + ' percent of the file. Any total computed from this table is a total of the '
        + kept + ' line' + (kept === 1 ? '' : 's') + ' that parsed, and the quarantined lines are listed below with the reason each one failed.',
    // Never the default. The surface presents both and waits.
    choices: Object.freeze([
      Object.freeze({
        id: 'keep_good',
        label: 'Keep the ' + kept + ' rows that parsed',
        consequence: 'The table holds the parsed rows only. A receipt line records what was dropped and why.',
      }),
      Object.freeze({
        id: 'abandon',
        label: 'Abandon this load',
        consequence: 'The table is not created. Fix the file or the delimiter and try again.',
      }),
    ]),
  };
}

/**
 * The receipt line. Written on both outcomes, on purpose.
 *
 * @param {object} quarantine  the model above
 * @param {'keep_good'|'abandon'} decision
 */
export function quarantineReceiptLine(quarantine, decision) {
  const q = isPlainObject(quarantine) ? quarantine : {};
  const name = str(q.fileName) || str(q.table) || 'the file';
  if (q.clean === true) {
    return {
      kind: QUARANTINE_KIND,
      decision: 'clean',
      severity: 'info',
      line: 'Loaded ' + name + '. Every line parsed and nothing was quarantined.',
    };
  }
  if (decision === 'abandon') {
    return {
      kind: QUARANTINE_KIND,
      decision: 'abandon',
      severity: 'info',
      line: 'Abandoned the load of ' + name + ' after ' + (q.droppedRows || 0)
        + ' line(s) failed to parse. No table was created.',
    };
  }
  return {
    kind: QUARANTINE_KIND,
    decision: 'keep_good',
    severity: 'caution',
    line: 'Loaded ' + name + ' with ' + (q.keptRows || 0) + ' of ' + (q.totalRows || 0)
      + ' line(s). ' + (q.droppedRows || 0) + ' line(s) failed to parse and were held out, confirmed by the person loading it. '
      + 'Numbers from this table describe the rows that parsed.',
    reasons: Array.isArray(q.reasons) ? q.reasons.slice(0, 5) : [],
  };
}

export const DataGlowCsvQuarantine = {
  QUARANTINE_KIND,
  QUARANTINE_VERSION,
  REJECT_PREVIEW_LIMIT,
  QUARANTINE_DOCTRINE,
  rejectTableNames,
  rejectRowsSql,
  rejectCountSql,
  rejectReasonsSql,
  dropRejectTablesSql,
  readRejectRow,
  buildQuarantine,
  quarantineReceiptLine,
};

try {
  if (typeof window !== 'undefined') window.DataGlowCsvQuarantine = DataGlowCsvQuarantine;
} catch (_e) {}
