// Bundle 13 - SQL SUMMARIZE-to-Proof-Board and CSV quarantine, the Excel
// type-guard, deeper Python and R recipes gated on real probes, the Arrow
// bridge honesty status, the Power Query honest note, and the llama.cpp
// desktop sidecar packaging path.
//
// Pure Node, no DOM. Same rule as Bundle 12: anything this bundle restates
// about another module is read back out of that module, so a drift fails in
// CI rather than in front of someone.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SQL_DEEPEN_KIND,
  NULL_RATE_TILE_THRESHOLD,
  SUMMARIZE_HONESTY,
  quoteIdent,
  summarizeSql,
  readSummarizeRow,
  summarizeToTiles,
  SQL_DEEPEN_SNIPPETS,
  deepenTopics,
  listDeepenSnippets,
  buildSqlDeepen,
} from '../js/polyglot/sql-deepen.js';

import {
  TYPE_GUARD_KIND,
  GUARD_MIN_SHARE,
  scanColumn,
  detectTypeRisks,
  previewGuard,
  typeGuardReceiptLine,
} from '../js/intelligence/excel-type-guard.js';

import {
  PY_DEEPEN_KIND,
  PROBED_PACKAGES,
  PROBE_CELL,
  PY_DEEPEN_RECIPES,
  readProbe,
  packageAvailability,
  buildPythonDeepen,
} from '../js/polyglot/python-deepen.js';

import {
  R_DEEPEN_KIND,
  R_STARTUP_PACKAGES,
  R_OPTIONAL_PACKAGES,
  AIR_GAP_BLOCK_REASON,
  packageInstallDecision,
  R_DEEPEN_RECIPES,
  buildRDeepen,
} from '../js/polyglot/r-deepen.js';

import {
  ARROW_BRIDGE_KIND,
  ARROW_BRIDGE_STATES,
  JSON_BRIDGE_ROW_LIMIT,
  NEVER_UNLIMITED,
  buildArrowBridgeStatus,
  describeArrowStepUp,
  arrowBridgeChipLabel,
} from '../js/polyglot/arrow-bridge.js';

import {
  PQ_NOTE_KIND,
  POWER_QUERY_NOTE,
  POWER_QUERY_EQUIVALENTS,
  powerQueryCeilingGroup,
  buildPowerQueryNote,
} from '../js/polyglot/power-query-note.js';

import {
  QUARANTINE_KIND,
  REJECT_PREVIEW_LIMIT,
  rejectTableNames,
  rejectRowsSql,
  rejectCountSql,
  readRejectRow,
  buildQuarantine,
  quarantineReceiptLine,
} from '../js/dataquality/csv-quarantine.js';

import {
  SIDECAR_BASENAME,
  TARGET_TRIPLES,
  NO_WEIGHTS_IN_GIT,
  sidecarFileName,
  sidecarPresence,
  checkPackagingAgreement,
} from '../js/ai/llama-sidecar-packaging.js';

import {
  POWER_QUERY_CEILING_NOTE,
} from '../js/ai/capability-ceiling.js';

import { rPackageInstallAllowed } from '../js/runtimes-viz/r-runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  \u2713 ' + name);
  passed++;
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const NEW_FILES = [
  'js/polyglot/sql-deepen.js',
  'js/intelligence/excel-type-guard.js',
  'js/polyglot/python-deepen.js',
  'js/polyglot/r-deepen.js',
  'js/polyglot/arrow-bridge.js',
  'js/polyglot/power-query-note.js',
  'js/dataquality/csv-quarantine.js',
  'js/dataquality/data-glow-csv-quarantine-canvas.js',
  'js/ai/llama-sidecar-packaging.js',
];

// ---------------------------------------------------------------
console.log('\nSQL deepen: SUMMARIZE becomes tiles nobody has graded yet');
// ---------------------------------------------------------------

ok('quoteIdent double-quotes and escapes an embedded quote',
  quoteIdent('weird"col') === '"weird""col"');

ok('summarizeSql runs SUMMARIZE against the exact quoted table name',
  summarizeSql('my table').indexOf('SUMMARIZE "my table"') === 0);

ok('readSummarizeRow reads a fixture SUMMARIZE row into a fixed shape',
  (() => {
    const row = { column_name: 'age', null_percentage: 42, approx_unique: 3, count: 100 };
    const tile = readSummarizeRow(row);
    return tile.column === 'age' && tile.nullPercentage === 42 && tile.approxUnique === 3;
  })());

ok('summarizeToTiles marks every tile unknown until a person reviews it',
  (() => {
    const rows = [
      { column_name: 'id', null_percentage: 0, approx_unique: 100, count: 100 },
      { column_name: 'age', null_percentage: 42, approx_unique: 3, count: 100 },
    ];
    const result = summarizeToTiles({ table: 'patients', rows, rowCount: 100 });
    return result.tiles.length > 0 && result.tiles.every(t => t.gateBadge === 'unknown');
  })());

ok('a column over the null-rate threshold produces a null-rate tile',
  (() => {
    const rows = [{ column_name: 'age', null_percentage: NULL_RATE_TILE_THRESHOLD + 5, approx_unique: 3, count: 100 }];
    const result = summarizeToTiles({ table: 'patients', rows, rowCount: 100 });
    return result.tiles.some(t => /missing/i.test(t.title));
  })());

ok('a constant column (one distinct value, more than one row) gets its own tile',
  (() => {
    const rows = [{ column_name: 'flag', null_percentage: 0, approx_unique: 1, count: 50 }];
    const result = summarizeToTiles({ table: 't', rows, rowCount: 50 });
    return result.tiles.some(t => /same value in every row/i.test(t.title));
  })());

ok('a candidate key column (distinct count matches row count, no nulls) is flagged',
  (() => {
    const rows = [{ column_name: 'id', null_percentage: 0, approx_unique: 50, count: 50 }];
    const result = summarizeToTiles({ table: 't', rows, rowCount: 50 });
    return result.tiles.some(t => /looks like a key/i.test(t.title));
  })());

ok('no rows to profile is reported as nothing to profile, not an error',
  summarizeToTiles({ table: 't', rows: [] }).tiles.length === 0);

ok('SUMMARIZE honesty text is a real sentence, not empty',
  typeof SUMMARIZE_HONESTY === 'string' && SUMMARIZE_HONESTY.length > 20);

ok('there are more than ten SQL deepen recipes, past the Bundle 12 ten',
  SQL_DEEPEN_SNIPPETS.length > 10);

ok('every deepen snippet names the question it answers',
  SQL_DEEPEN_SNIPPETS.every(s => typeof s.why === 'string' && s.why.length > 10));

ok('listDeepenSnippets with no topic returns every snippet',
  listDeepenSnippets().length === SQL_DEEPEN_SNIPPETS.length);

ok('deepenTopics lists each topic once',
  new Set(deepenTopics()).size === deepenTopics().length);

ok('buildSqlDeepen produces the full snippet set plus the honesty text',
  (() => {
    const pack = buildSqlDeepen();
    return pack.snippets.length === SQL_DEEPEN_SNIPPETS.length && pack.summarizeHonesty === SUMMARIZE_HONESTY;
  })());

// ---------------------------------------------------------------
console.log('\nExcel type-guard: catches a gene symbol read as a date before it is silent');
// ---------------------------------------------------------------

ok('a column of real full dates raises no risk',
  detectTypeRisks({ columns: ['visit_date'], rows: [{ visit_date: '2024-01-01' }, { visit_date: '2024-02-01' }, { visit_date: '2024-03-01' }] }).findings.length === 0);

ok('a gene-symbol-looking column coerced to dates is caught (already_coerced)',
  (() => {
    // Excel writes MARCH1/SEPT2-style gene symbols as "1-Mar" / "2-Sep" once
    // opened and saved, which is what already_coerced detects.
    const values = ['1-Mar', '2-Sep', '1-Mar', '2-Sep', '1-Mar'];
    const found = scanColumn('gene', values);
    return !!found && found.severity === 'already_coerced';
  })());

ok('an identifier at risk of scientific-notation coercion is caught (at_risk)',
  (() => {
    // A two-digit mantissa like 12E5 matches the at-risk pattern but not the
    // already-coerced one (which only matches a single leading digit), so this
    // is genuinely at_risk rather than already_coerced.
    const values = ['12E5', '23E5', '34E5', '45E5', '56E5'];
    const found = scanColumn('code', values);
    return !!found && found.severity === 'at_risk';
  })());

ok('scanColumn respects the minimum-share threshold so one stray value is not a finding',
  (() => {
    const values = ['Alice', 'Bob', 'Carol', 'Dan', 'Eve', 'Frank', 'Gina', '1-Mar'];
    // 1 in 8 is 12.5%, under GUARD_MIN_SHARE (0.15).
    return GUARD_MIN_SHARE === 0.15 && scanColumn('name', values) === null;
  })());

ok('detectTypeRisks scans a full dataset and separates already_coerced from at_risk',
  (() => {
    const dataset = {
      columns: ['gene', 'code', 'name'],
      rows: [
        { gene: '1-Mar', code: '12E5', name: 'Alice' },
        { gene: '2-Sep', code: '23E5', name: 'Bob' },
        { gene: '1-Mar', code: '34E5', name: 'Carol' },
        { gene: '2-Sep', code: '45E5', name: 'Dan' },
      ],
    };
    const result = detectTypeRisks(dataset);
    return result.alreadyCoerced.length > 0 && result.atRisk.length > 0 && result.fired === true;
  })());

ok('previewGuard only ever offers holding the column as text (op holdAsText)',
  (() => {
    const detection = detectTypeRisks({ columns: ['code'], rows: [{ code: '12E5' }, { code: '23E5' }, { code: '34E5' }] });
    const preview = previewGuard(detection);
    return preview.steps.every(s => s.op === 'holdAsText');
  })());

ok('previewGuard declines to touch an already-coerced column rather than pretending to fix it',
  (() => {
    const detection = detectTypeRisks({ columns: ['gene'], rows: [{ gene: '1-Mar' }, { gene: '2-Sep' }, { gene: '1-Mar' }] });
    const preview = previewGuard(detection, ['gene']);
    return preview.declined.length > 0 && preview.steps.length === 0;
  })());

ok('the receipt line records clean, applied or overridden and nothing else',
  ['clean', 'applied', 'overridden'].includes(typeGuardReceiptLine({ fired: false, scannedColumns: 3 }, 'clean').outcome));

ok('an overridden receipt names the columns that were flagged and left alone',
  (() => {
    const detection = detectTypeRisks({ columns: ['code'], rows: [{ code: '12E5' }, { code: '23E5' }, { code: '34E5' }] });
    const line = typeGuardReceiptLine(detection, 'overridden');
    return line.outcome === 'overridden' && /code/.test(line.line);
  })());

// ---------------------------------------------------------------
console.log('\nPython deepen: polars status comes from a real probe, not a guess');
// ---------------------------------------------------------------

ok('the probe cell actually probes all four tracked packages',
  PROBED_PACKAGES.every(p => PROBE_CELL.indexOf(p) >= 0));

ok('an unprobed session reports unknown rather than assuming installed or missing',
  packageAvailability('polars', { probed: false }).state === 'unknown');

ok('a probed session that found the package reports available',
  packageAvailability('polars', { probed: true, present: true }).state === 'available');

ok('a probed session that did not find the package reports not_loaded',
  packageAvailability('polars', { probed: true, present: false }).state === 'not_loaded');

ok('there are at least eight Python deepen recipes',
  PY_DEEPEN_RECIPES.length >= 8);

ok('every polars recipe is only listed live (runnable) once the probe confirms polars',
  (() => {
    const deep = buildPythonDeepen({ probed: true, packages: { polars: true } });
    const polarsRecipes = deep.recipes.filter(r => r.needs === 'polars');
    const blockedPolars = deep.blocked.filter(b => b.needs === 'polars');
    return polarsRecipes.length > 0 && blockedPolars.length === 0;
  })());

ok('with nothing probed present, polars recipes are blocked with a reason rather than hidden',
  (() => {
    const deep = buildPythonDeepen({ probed: true, packages: {} });
    const blockedPolars = deep.blocked.filter(b => b.needs === 'polars');
    return blockedPolars.length > 0 && blockedPolars.every(b => typeof b.reason === 'string' && b.reason.length > 5);
  })());

ok('an unprobed session reports every recipe as pending rather than silently missing',
  /has not been probed/i.test(buildPythonDeepen({ probed: false }).headline));

ok('readProbe tolerates a missing or malformed probe result without throwing',
  (() => {
    readProbe(undefined);
    readProbe(null);
    readProbe({});
    return true;
  })());

ok('this fixes the Bundle 11 hard-coded-false bug: presence true actually reports available',
  buildPythonDeepen({ probed: true, packages: { polars: true, sklearn: true, statsmodels: true, pyarrow: true } })
    .recipes.length === PY_DEEPEN_RECIPES.length);

// ---------------------------------------------------------------
console.log('\nR deepen: recipes gated on real package state, Air-Gap actually blocks install');
// ---------------------------------------------------------------

ok('jsonlite and ggplot2 are the two startup packages the runtime already tracks',
  R_STARTUP_PACKAGES.indexOf('jsonlite') >= 0 && R_STARTUP_PACKAGES.indexOf('ggplot2') >= 0);

ok('dplyr and tidyr are optional packages, not assumed present at startup',
  R_OPTIONAL_PACKAGES.indexOf('dplyr') >= 0 && R_OPTIONAL_PACKAGES.indexOf('tidyr') >= 0);

ok('Air-Gap Mode blocks a package install decision with air_gap as the reason',
  packageInstallDecision({ airGap: true }).blockedBy === 'air_gap');

ok('being offline without Air-Gap Mode blocks with offline as the reason',
  packageInstallDecision({ airGap: false, offline: true }).blockedBy === 'offline');

ok('online with Air-Gap Mode off is not blocked',
  packageInstallDecision({ airGap: false, offline: false }).blockedBy === '');

ok('there are at least ten R deepen recipes',
  R_DEEPEN_RECIPES.length >= 10);

ok('a session with dplyr available can run the dplyr recipes',
  (() => {
    const deep = buildRDeepen({ hasJsonlite: true, hasGgplot2: true, hasDplyr: true, hasTidyr: true });
    return deep.recipes.some(r => r.needs === 'dplyr');
  })());

ok('a session with nothing optional installed lists dplyr recipes as blocked, not missing',
  (() => {
    const deep = buildRDeepen({ hasJsonlite: true, hasGgplot2: true, hasDplyr: false, hasTidyr: false });
    return deep.blocked.some(b => b.needs === 'dplyr');
  })());

ok('every blocked recipe with a base R alternative points at it by name',
  (() => {
    const deep = buildRDeepen({ hasJsonlite: false, hasGgplot2: false, hasDplyr: false, hasTidyr: false });
    const withAlt = deep.blocked.filter(b => b.instead);
    return withAlt.length > 0 && withAlt.every(b => typeof b.instead.title === 'string');
  })());

ok('Air-Gap Mode blocking an install surfaces the Air-Gap reason on every blocked recipe',
  (() => {
    const deep = buildRDeepen({ hasJsonlite: false, hasGgplot2: false, hasDplyr: false, hasTidyr: false, airGap: true });
    return deep.airGapBlocksInstall === true && deep.blocked.every(b => b.reason === AIR_GAP_BLOCK_REASON);
  })());

ok('rPackageInstallAllowed is exported from the runtime and returns an allowed/blockedBy shape',
  (() => {
    const d = rPackageInstallAllowed();
    return typeof d === 'object' && ('allowed' in d) && ('blockedBy' in d);
  })());

ok('the R runtime calls the install-allowed gate before installing packages at startup',
  /rPackageInstallAllowed\s*\(/.test(read('js/runtimes-viz/r-runtime.js')));

ok('the install gate runs before the jsonlite/ggplot2 installPackages calls, not after',
  (() => {
    const src = read('js/runtimes-viz/r-runtime.js');
    const gateAt = src.indexOf('rPackageInstallAllowed(');
    const installAt = src.indexOf('installPackages(');
    return gateAt >= 0 && installAt >= 0 && gateAt < installAt;
  })());

// ---------------------------------------------------------------
console.log('\nArrow bridge: partial and honest, JSON rows are never called unlimited');
// ---------------------------------------------------------------

ok('the bridge states a real numeric row ceiling for the JSON path',
  typeof JSON_BRIDGE_ROW_LIMIT === 'number' && JSON_BRIDGE_ROW_LIMIT === 200000);

ok('the never-unlimited line actually says there is no unlimited mode',
  /no unlimited/i.test(NEVER_UNLIMITED));

ok('with nothing available the bridge status is missing',
  buildArrowBridgeStatus({ duckdbArrow: false, pyarrow: false }).state === 'missing');

ok('with only pyarrow probed present the bridge status is partial, not ready',
  buildArrowBridgeStatus({ duckdbArrow: false, pyarrow: true }).state === 'partial');

ok('with both ends able to speak Arrow the status is ready',
  buildArrowBridgeStatus({ duckdbArrow: true, pyarrow: true }).state === 'ready');

ok('every reported state is one of the three declared states',
  ARROW_BRIDGE_STATES.indexOf(buildArrowBridgeStatus({ duckdbArrow: false, pyarrow: true }).state) >= 0);

ok('the step-up plan says probing pyarrow is done and raising the row limit is not',
  (() => {
    const steps = describeArrowStepUp().steps;
    const probe = steps.find(s => s.id === 'probe-pyarrow');
    const raise = steps.find(s => s.id === 'raise-the-limit');
    return !!probe && probe.done === true && !!raise && raise.done === false;
  })());

ok('the overall step-up status is partial, matching the honest ceiling today',
  describeArrowStepUp().status === 'partial');

ok('the chip label never claims ready when the state is partial',
  !/available$/i.test(arrowBridgeChipLabel(buildArrowBridgeStatus({ duckdbArrow: false, pyarrow: true }))));

// ---------------------------------------------------------------
console.log('\nPower Query honest note: names the gap instead of hiding it');
// ---------------------------------------------------------------

ok('the note states plainly that Power Query M is not embedded',
  /Power Query M is not embedded/i.test(POWER_QUERY_NOTE));

ok('the note names at least three concrete DataGlow equivalents',
  POWER_QUERY_EQUIVALENTS.length >= 3);

ok('every equivalent names both the M step and the DataGlow answer',
  POWER_QUERY_EQUIVALENTS.every(e => typeof e.step === 'string' && typeof e.here === 'string' && e.step.length > 5 && e.here.length > 5));

ok('the ceiling group for Power Query reuses the exact same note text, not a rewritten copy',
  POWER_QUERY_CEILING_NOTE === POWER_QUERY_NOTE);

ok('powerQueryCeilingGroup names what this product does and does not do',
  (() => {
    const g = powerQueryCeilingGroup();
    return typeof g.does === 'string' && typeof g.notThis === 'string';
  })());

ok('buildPowerQueryNote returns the equivalents list alongside the note and never claims capability',
  (() => {
    const n = buildPowerQueryNote();
    return n.equivalents.length === POWER_QUERY_EQUIVALENTS.length && n.claims === false;
  })());

// ---------------------------------------------------------------
console.log('\nCSV quarantine: a malformed row is held, never silently dropped');
// ---------------------------------------------------------------

ok('rejectRowsSql and rejectCountSql both reference the exact rejects table they were given',
  rejectRowsSql('_dg_csv_rejects_t1').indexOf('_dg_csv_rejects_t1') >= 0
  && rejectCountSql('_dg_csv_rejects_t1').indexOf('_dg_csv_rejects_t1') >= 0);

ok('rejectTableNames derives deterministic, distinct table and scan names from the same seed',
  (() => {
    const a = rejectTableNames('patients');
    const b = rejectTableNames('patients');
    return a.rejectsTable === b.rejectsTable && a.rejectsTable !== a.rejectsScan;
  })());

ok('readRejectRow reads DuckDB store_rejects column names (line, column_name, error_type, csv_line)',
  (() => {
    const row = readRejectRow({ line: 4, column_name: 'age', error_type: 'CAST', error_message: 'bad cast', csv_line: '4,50,Dan,extracol' });
    return row.line === 4 && row.column === 'age' && row.reason === 'CAST';
  })());

ok('readRejectRow tolerates a malformed row object without throwing',
  readRejectRow(null) === null && readRejectRow({}) === null);

ok('zero reject rows is reported clean',
  buildQuarantine({ fileName: 'ok.csv', table: 't', keptRows: 10, rejectRows: [], droppedLines: 0 }).clean === true);

ok('a non-empty reject set is not reported clean, and keeps the kept/dropped counts honest',
  (() => {
    const rejectRows = Array.from({ length: 5 }, (_, i) => ({ line: i + 1, column_name: 'age', error_type: 'CAST', error_message: 'bad', csv_line: 'x' }));
    const q = buildQuarantine({ fileName: 'bad.csv', table: 't', keptRows: 7, rejectRows, droppedLines: 5 });
    return q.clean === false && q.droppedRows === 5 && q.keptRows === 7;
  })());

ok('the reject preview limit constant is 200',
  REJECT_PREVIEW_LIMIT === 200);

ok('the quarantine offers exactly two choices: keep_good and abandon, never a silent default',
  (() => {
    const q = buildQuarantine({ fileName: 'bad.csv', table: 't', keptRows: 7, rejectRows: [{ line: 1, column_name: 'a', error_type: 'x', csv_line: 'y' }], droppedLines: 1 });
    const ids = q.choices.map(c => c.id);
    return ids.length === 2 && ids.includes('keep_good') && ids.includes('abandon');
  })());

ok('the quarantine receipt line records one of the three real decisions',
  ['clean', 'abandon', 'keep_good'].includes(quarantineReceiptLine({ clean: true }, 'clean').decision));

ok('a keep_good receipt line names the dropped count so the record is honest about what happened',
  (() => {
    const q = { clean: false, fileName: 'bad.csv', keptRows: 7, totalRows: 12, droppedRows: 5, reasons: [] };
    const line = quarantineReceiptLine(q, 'keep_good');
    return line.decision === 'keep_good' && /5/.test(line.line);
  })());

// ---------------------------------------------------------------
console.log('\nllama.cpp sidecar packaging: no huge binaries in git, external bin only if present');
// ---------------------------------------------------------------

ok('there are packaging targets for at least macOS, Linux and Windows',
  new Set(TARGET_TRIPLES.map(t => t.os)).size >= 3);

ok('the Windows triple is the only one with an .exe suffix',
  TARGET_TRIPLES.filter(t => t.ext === '.exe').every(t => t.os === 'Windows')
  && TARGET_TRIPLES.some(t => t.os === 'Windows' && t.ext === '.exe'));

ok('sidecarFileName produces the basename this build looks for, with the triple suffix',
  (() => {
    const name = sidecarFileName('x86_64-apple-darwin');
    return name.indexOf(SIDECAR_BASENAME) >= 0 && name.indexOf('x86_64-apple-darwin') >= 0;
  })());

ok('sidecarFileName appends .exe only for the Windows triple',
  sidecarFileName('x86_64-pc-windows-msvc').endsWith('.exe')
  && !sidecarFileName('x86_64-apple-darwin').endsWith('.exe'));

ok('with no binary on disk, presence is reported missing rather than assumed ready',
  sidecarPresence({ triple: 'x86_64-apple-darwin', presentTriples: [] }).state === 'sidecar_missing');

ok('with a binary confirmed present for the requested triple, presence is reported ready',
  sidecarPresence({ triple: 'x86_64-apple-darwin', presentTriples: ['x86_64-apple-darwin'] }).state === 'sidecar_ready');

ok('a binary present for a different triple does not make the requested triple ready',
  sidecarPresence({ triple: 'x86_64-pc-windows-msvc', presentTriples: ['x86_64-apple-darwin'] }).state === 'sidecar_missing');

ok('the packaging agreement check catches externalBin configured with no binary vendored',
  checkPackagingAgreement({ externalBin: ['binaries/llama-server'], presentTriples: [] }).ok === false);

ok('the packaging agreement check catches a vendored binary with no externalBin entry',
  checkPackagingAgreement({ externalBin: [], presentTriples: ['x86_64-apple-darwin'] }).ok === false);

ok('the packaging agreement check is satisfied when nothing is declared and nothing is vendored (the committed state)',
  checkPackagingAgreement({ externalBin: [], presentTriples: [] }).ok === true);

ok('the no-weights doctrine text says weights and the binary do not belong in git',
  /repository/i.test(NO_WEIGHTS_IN_GIT) && /ignored directory/i.test(NO_WEIGHTS_IN_GIT));

ok('.gitignore actually excludes the binaries directory the fetch script writes to',
  /src-tauri\/binaries\//.test(read('.gitignore')));

ok('the fetch script never downloads model weights, only the server binary or a stub',
  !/\.gguf|weights\.bin/i.test(read('scripts/fetch-llama-sidecar.mjs')));

// ---------------------------------------------------------------
console.log('\nCanvas wiring: the new flags actually gate a render function');
// ---------------------------------------------------------------

const canvasSrc = read('js/polyglot/data-glow-power-packs-canvas.js');

ok('renderPython calls the Python deepen renderer, gated on pyDeepOn',
  /function renderPythonDeepen\(/.test(canvasSrc) && /if \(pyDeepOn\(\)\) renderPythonDeepen\(host\)/.test(canvasSrc));

ok('renderR calls an R deepen renderer, gated on rDeepOn',
  /function renderRDeepen\(/.test(canvasSrc) && /if \(rDeepOn\(\)\) renderRDeepen\(host\)/.test(canvasSrc));

ok('renderExcel calls both the type-guard and the Power Query note renderers',
  /if \(typeGuardOn\(\)\) renderTypeGuard\(host\)/.test(canvasSrc)
  && /if \(pqNoteOn\(\)\) renderPowerQueryNote\(host\)/.test(canvasSrc));

ok('all six Bundle 13 flag-check helpers exist',
  ['sqlDeepOn', 'pyDeepOn', 'rDeepOn', 'typeGuardOn', 'arrowOn', 'pqNoteOn']
    .every(fn => new RegExp('function ' + fn + '\\(').test(canvasSrc)));

ok('no top-level tab was added: tabs() only ever returns sql, excel, python or r ids',
  (() => {
    const m = canvasSrc.match(/function tabs\(\) \{[\s\S]*?\n  \}/);
    if (!m) return false;
    const ids = [...m[0].matchAll(/id:\s*'([a-z]+)'/g)].map(x => x[1]);
    return ids.length > 0 && ids.every(id => ['sql', 'excel', 'python', 'r'].includes(id));
  })());

ok('the registerDataset CSV load path now sets ignore_errors and store_rejects',
  (() => {
    const canvas = read('canvas/index.html');
    return /ignore_errors=true, store_rejects=true, rejects_table=/.test(canvas);
  })());

// ---------------------------------------------------------------
console.log('\nHouse rules');
// ---------------------------------------------------------------

ok('no new file contains a U+2014 em dash',
  NEW_FILES.every(f => read(f).indexOf('\u2014') < 0));

ok('no new file contains a control character that would break the canvas splice',
  NEW_FILES.every(f => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(read(f))));

ok('no new file closes the script tag it will be spliced into',
  NEW_FILES.every(f => read(f).indexOf('</scr' + 'ipt>') < 0));

ok('no pure engine touches the DOM',
  NEW_FILES.filter(f => f.indexOf('canvas') < 0).every(f => !/document\./.test(read(f))));

ok('no new file reaches the network',
  NEW_FILES.every(f => !/\bfetch\(|XMLHttpRequest/.test(read(f))));

ok('every pure engine publishes itself onto window defensively',
  NEW_FILES.filter(f => f.indexOf('canvas') < 0)
    .every(f => /typeof window !== 'undefined'/.test(read(f))));

ok('the quarantine canvas surface carries its own from and end markers',
  (() => {
    const f = 'js/dataquality/data-glow-csv-quarantine-canvas.js';
    const s = read(f);
    return s.indexOf('/* ---- from ' + f + ' ---- */') === 0
      && s.indexOf('/* ---- end ' + f + ' ---- */') > 0;
  })());

ok('nothing in this bundle claims HIPAA compliance or beats a hosted model',
  NEW_FILES.every(f => !/HIPAA compliant|smarter than|beats Claude/i.test(read(f))));

ok('the canvas itself contains no em dash inside any of the nine Bundle 13 injected blocks',
  (() => {
    const markers = [
      'js/polyglot/sql-deepen.js', 'js/intelligence/excel-type-guard.js', 'js/polyglot/python-deepen.js',
      'js/polyglot/r-deepen.js', 'js/polyglot/arrow-bridge.js', 'js/polyglot/power-query-note.js',
      'js/dataquality/csv-quarantine.js', 'js/ai/llama-sidecar-packaging.js',
      'js/dataquality/data-glow-csv-quarantine-canvas.js',
    ];
    const canvas = read('canvas/index.html');
    return markers.every(f => {
      const s = canvas.indexOf('/* ---- from ' + f + ' ---- */');
      const e = canvas.indexOf('/* ---- end ' + f + ' ---- */');
      if (s < 0 || e < 0) return false;
      return canvas.slice(s, e).indexOf('\u2014') < 0;
    });
  })());

ok('the six Bundle 13 flags are declared enabled in flags.manifest.json, dated to bundle-13',
  (() => {
    const manifest = JSON.parse(read('flags.manifest.json'));
    const names = ['sqlPowerDeepen', 'excelTypeGuard', 'pythonPowerDeepen', 'rPowerDeepen', 'arrowBridge', 'powerQueryHonestNote'];
    return names.every(n => manifest.flags[n] && manifest.flags[n].enabled === true && manifest.flags[n].addedInPR === 'bundle-13');
  })());

console.log('\n' + passed + ' passed, 0 failed');
