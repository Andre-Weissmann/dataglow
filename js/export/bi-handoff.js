// ============================================================
// DATAGLOW - Power BI / Tableau hand-off pack
// ============================================================
//
// The handshake this solves is the moment an analyst finishes in DataGlow and
// someone says "can you put that in Power BI". Today that means exporting a CSV
// and losing everything around it: which column meant what, which query
// produced the headline number, and whether the data passed its checks. The
// number arrives in the BI tool with no way to reconstruct how it was made, and
// the person rebuilding it guesses.
//
// So the pack is five files, not one. The CSV is the least interesting of them.
// The dictionary says what the columns are, queries.sql says how the numbers
// were produced so they can be reproduced in the other tool, and the validation
// summary says what was and was not checked, which is the part a dashboard
// silently drops.
//
// WHY THERE IS NO ZIP.
// Zipping in the browser means a compression dependency, and DataGlow ships as
// one file with no build step reaching the network. Five downloads that a
// person can read individually is a worse click count and a better artifact:
// each file opens in the tool that wants it, and nothing has to be unpacked on
// a machine where unpacking downloads is discouraged. The manifest lists the
// files so nothing is silently missing.
//
// WHY THE VALIDATION SUMMARY REFUSES TO GRADE WHAT IT DID NOT SEE.
// A summary that prints a tick next to every row reads as an audit. Where no
// check reported, this writes that no check reported. `unknown` is never
// rendered as a pass, and the header of that file says so before the table.
//
// Pure. Builds strings. Downloading and confirming belong to the surface.

export const BI_HANDOFF_KIND = 'dataglow-bi-handoff';
export const BI_HANDOFF_VERSION = 1;

export const HANDOFF_DISCLAIMER =
  'This pack is a hand-off aid, not a certified deliverable. It is not a Power BI or Tableau file, it does not reproduce a dashboard, and it is not endorsed by or certified with either tool. It carries the data, what the columns mean, the queries that produced the numbers, and an honest note on what was checked.';

export const VALIDATION_HEADER_NOTE =
  'Where no check reported on a number, this file says so. An entry reading "not checked" is an absence of evidence, not a pass. Do not read this file as an audit.';

export const NO_DATASET_NOTE =
  'No dataset is loaded, so there are no rows and no columns to hand off. Load a file first.';

const CSV_MIME = 'text/csv';
const MD_MIME = 'text/markdown';
const SQL_MIME = 'application/sql';

function str(v) {
  return typeof v === 'string' ? v : '';
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A CSV field. Quotes anything that could otherwise change the shape of the
 *  row, including the leading characters spreadsheets treat as a formula. */
export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  const risky = /^[=+\-@\t\r]/.test(s);
  if (risky) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Rows may be positional arrays (the house shape) or objects keyed by column
 *  name. Both are accepted because both exist in this codebase. */
export function cellAt(row, columnName, columnIndex) {
  if (Array.isArray(row)) return row[columnIndex];
  if (isPlainObject(row)) return row[columnName];
  return undefined;
}

export function toCSV(columns, rows, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const cols = Array.isArray(columns) ? columns : [];
  const names = cols.map(c => (isPlainObject(c) ? str(c.name) : str(c)));
  const data = Array.isArray(rows) ? rows : [];
  const limit = Number.isInteger(options.maxRows) && options.maxRows >= 0 ? options.maxRows : data.length;
  const out = [names.map(csvEscape).join(',')];
  for (let i = 0; i < data.length && i < limit; i++) {
    const row = data[i];
    out.push(names.map((n, k) => csvEscape(cellAt(row, n, k))).join(','));
  }
  return out.join('\n') + '\n';
}

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Null rate is computed from the rows that are actually present, or reported
 *  as unknown. It is never estimated. */
export function columnStats(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  const data = Array.isArray(rows) ? rows : [];
  return cols.map((c, k) => {
    const name = isPlainObject(c) ? str(c.name) : str(c);
    const type = isPlainObject(c) ? str(c.type) : '';
    if (!data.length) {
      return { name, type, rowCount: 0, blankCount: null, nullRate: null, nullRateText: 'not known (no rows were available)' };
    }
    let blanks = 0;
    for (const row of data) if (isBlank(cellAt(row, name, k))) blanks++;
    const rate = blanks / data.length;
    return {
      name,
      type,
      rowCount: data.length,
      blankCount: blanks,
      nullRate: rate,
      nullRateText: (Math.round(rate * 1000) / 10) + '%',
    };
  });
}

export function buildDictionary(dataset) {
  const ds = isPlainObject(dataset) ? dataset : {};
  const stats = columnStats(ds.columns, ds.rows);
  const out = ['# Column dictionary', ''];
  const name = str(ds.name);
  if (name) out.push('Dataset: ' + name, '');
  if (!stats.length) {
    out.push(NO_DATASET_NOTE, '');
    return out.join('\n');
  }
  out.push('Blank rate is counted over the rows present in this export. Where no rows were available it says so rather than showing a zero.', '');
  out.push('| Column | Type | Blank rate | Rows counted |', '|---|---|---|---|');
  for (const s of stats) {
    out.push('| ' + cell(s.name) + ' | ' + cell(s.type || 'not recorded') + ' | ' + cell(s.nullRateText) + ' | ' + cell(s.rowCount) + ' |');
  }
  out.push('');
  return out.join('\n');
}

function cell(v) {
  return str(v === null || v === undefined ? '' : String(v)).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/** Every query behind every number, so the other tool can reproduce them rather
 *  than trusting the CSV. */
export function buildQueriesSQL(tiles, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const list = (Array.isArray(tiles) ? tiles : []).filter(isPlainObject);
  const out = [
    '-- DataGlow hand-off: the queries behind the numbers.',
    '-- Each block is one number on the Proof Board. Table and column names are',
    '-- as they were in DataGlow; adjust the relation name for your warehouse.',
    '',
  ];
  let written = 0;
  for (const t of list) {
    const code = str(t.sqlOrCode).trim();
    const lang = str(t.language) || 'sql';
    if (!code) continue;
    out.push('-- ' + (str(t.title) || str(t.id) || 'untitled number'));
    if (lang !== 'sql') {
      out.push('-- This block is ' + lang + ', not SQL. It is included so the method is not lost.');
      out.push(code.split('\n').map(l => '-- ' + l).join('\n'));
    } else {
      out.push(code.endsWith(';') ? code : code + ';');
    }
    out.push('');
    written++;
  }
  const sessionSQL = str(options.sessionSQL).trim();
  if (sessionSQL) {
    out.push('-- Last query run in this session.', sessionSQL.endsWith(';') ? sessionSQL : sessionSQL + ';', '');
    written++;
  }
  if (!written) {
    out.push('-- No query was recorded. Nothing is invented here, so this file is empty on purpose.', '');
  }
  return out.join('\n');
}

export function buildValidationSummary(tiles, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const list = (Array.isArray(tiles) ? tiles : []).filter(isPlainObject);
  const out = ['# Validation summary', '', VALIDATION_HEADER_NOTE, ''];

  const gate = isPlainObject(options.gate) ? options.gate : null;
  if (gate) {
    out.push('## Readiness gate', '');
    const consumable = gate.agentConsumable === true ? 'yes' : (gate.agentConsumable === false ? 'no' : 'not reported');
    out.push('- Agent consumable: ' + consumable);
    if (typeof gate.score === 'number' && Number.isFinite(gate.score)) out.push('- Score: ' + gate.score);
    if (typeof gate.threshold === 'number' && Number.isFinite(gate.threshold)) out.push('- Threshold: ' + gate.threshold);
    out.push('');
  }

  out.push('## Numbers and their checks', '');
  if (!list.length) {
    out.push('No numbers were on the Proof Board, so nothing here has been checked.', '');
    return out.join('\n');
  }
  out.push('| Number | Value | Check reported |', '|---|---|---|');
  for (const t of list) {
    const badge = str(t.gateBadge) || 'unknown';
    const said = badge === 'unknown' || badge === ''
      ? 'not checked'
      : (str(t.badgeLabel) || badge);
    out.push('| ' + cell(t.title) + ' | ' + cell(t.valueText || t.value) + ' | ' + cell(said) + ' |');
  }
  out.push('');

  const unchecked = list.filter(t => !str(t.gateBadge) || str(t.gateBadge) === 'unknown').length;
  const blocked = list.filter(t => str(t.gateBadge) === 'blocked').length;
  out.push('## What this does not tell you', '');
  out.push('- Whether each query still returns the number shown. That needs the data and the engine, and re-running here would report a fresh number as if it were the recorded one.');
  out.push('- Whether these are the right numbers to be looking at. No engine can answer that.');
  if (unchecked) out.push('- ' + unchecked + ' number(s) have had no check reported on them at all.');
  if (blocked) out.push('- ' + blocked + ' number(s) were blocked by a check and should not be republished as results.');
  out.push('');
  return out.join('\n');
}

export function buildHandoffReadme(meta) {
  const m = isPlainObject(meta) ? meta : {};
  const files = Array.isArray(m.files) ? m.files : [];
  const out = [
    '# Hand-off to Power BI or Tableau',
    '',
    'This folder is what DataGlow can hand a BI tool without pretending to be one.',
    '',
    '## What is here',
    '',
  ];
  if (files.length) {
    out.push('| File | What it is |', '|---|---|');
    for (const f of files) out.push('| ' + cell(f.name) + ' | ' + cell(f.note) + ' |');
    out.push('');
  }
  out.push(
    '## Power BI',
    '',
    '1. Get Data, then Text/CSV, and pick `data.csv`.',
    '2. Check the column types on the preview against `dictionary.md` before loading. Power BI guesses types and its guess is not always the type the analysis used.',
    '3. To reproduce a number rather than trusting the CSV, open `queries.sql` and run the block for that number against your own source.',
    '',
    '## Tableau',
    '',
    '1. Connect, then Text file, and pick `data.csv`.',
    '2. Compare the field types on the data source tab against `dictionary.md`.',
    '3. For a number you intend to publish, use the matching block in `queries.sql` as a custom SQL source instead of the CSV.',
    '',
    '## Before you publish anything from this',
    '',
    'Read `validation-summary.md`. It lists which numbers had a check reported on them and which did not. A number marked "not checked" has not failed anything, but nothing has passed it either.',
    '',
    '---',
    '',
    HANDOFF_DISCLAIMER,
    '',
  );
  return out.join('\n');
}

/**
 * The pack. Returns file descriptors rather than triggering anything, so the
 * surface can show the list, get one confirmation for the set, and then write
 * them.
 */
export function buildHandoffPack(input) {
  const inp = isPlainObject(input) ? input : {};
  const dataset = isPlainObject(inp.dataset) ? inp.dataset : null;
  const tiles = (Array.isArray(inp.tiles) ? inp.tiles : []).filter(isPlainObject);
  const problems = [];

  if (!dataset || !Array.isArray(dataset.columns) || !dataset.columns.length) {
    problems.push(NO_DATASET_NOTE);
  }
  if (!tiles.length) {
    problems.push('The Proof Board has no tiles, so queries.sql and the validation summary will say that nothing was recorded rather than inventing entries.');
  }

  const csv = toCSV(dataset ? dataset.columns : [], dataset ? dataset.rows : [], { maxRows: inp.maxRows });
  const files = [
    { name: 'data.csv', mimeType: CSV_MIME, text: csv, note: 'The rows as they stand in DataGlow right now.' },
    { name: 'dictionary.md', mimeType: MD_MIME, text: buildDictionary(dataset), note: 'Column names, types, and blank rate counted over the exported rows.' },
    { name: 'queries.sql', mimeType: SQL_MIME, text: buildQueriesSQL(tiles, { sessionSQL: inp.sessionSQL }), note: 'The query behind each number, so the other tool can reproduce it.' },
    { name: 'validation-summary.md', mimeType: MD_MIME, text: buildValidationSummary(tiles, { gate: inp.gate }), note: 'What was checked, what was not, and what neither can tell you.' },
  ];
  files.push({
    name: 'README-handoff.md',
    mimeType: MD_MIME,
    text: buildHandoffReadme({ files: files.map(f => ({ name: f.name, note: f.note })) }),
    note: 'How to open these in Power BI or Tableau.',
  });

  for (const f of files) f.bytes = f.text.length;

  return {
    kind: BI_HANDOFF_KIND,
    version: BI_HANDOFF_VERSION,
    files,
    manifest: files.map(f => ({ name: f.name, mimeType: f.mimeType, bytes: f.bytes, note: f.note })),
    rowCount: dataset && Array.isArray(dataset.rows) ? dataset.rows.length : 0,
    columnCount: dataset && Array.isArray(dataset.columns) ? dataset.columns.length : 0,
    tileCount: tiles.length,
    problems,
    disclaimer: HANDOFF_DISCLAIMER,
  };
}

export const DataGlowBIHandoff = {
  BI_HANDOFF_KIND,
  BI_HANDOFF_VERSION,
  HANDOFF_DISCLAIMER,
  VALIDATION_HEADER_NOTE,
  NO_DATASET_NOTE,
  csvEscape,
  cellAt,
  toCSV,
  columnStats,
  buildDictionary,
  buildQueriesSQL,
  buildValidationSummary,
  buildHandoffReadme,
  buildHandoffPack,
};

try {
  if (typeof window !== 'undefined') window.DataGlowBIHandoff = DataGlowBIHandoff;
} catch (_e) {}
