// ============================================================
// DATAGLOW — Polyglot write-back tests (Roadmap Step 8, polyglotWriteback)
// ============================================================
// Python and R tables saved BACK into DuckDB. Everything below runs against the
// real native DuckDB engine (the loader hook swaps only the browser-only
// duckdb-engine.js), the exact production materializer, and the exact
// production python-runtime.js / r-runtime.js entry points with stubbed
// Pyodide / WebR. The real Python bridge source is also executed under CPython
// (with pandas) when available, so `dataglow.save_df` itself is tested.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/polyglot-writeback.test.mjs

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { state } from '../js/app-shell/state.js';
import * as engine from '../js/app-shell/duckdb-engine.js';
import { configureFlags } from '../js/build/build-flags.js';
import { createObjectSpace } from '../js/app-shell/object-space.js';
import { createProvenanceRegistry } from '../js/provenance/provenance.js';
import {
  WRITEBACK_ROW_LIMIT,
  validateWritebackTableName,
  normalizeWritebackRows,
  sanitizeWritebackValue,
  inferColumnType,
  buildWritebackPlan,
  makeSqlTableCreator,
  materializeWritebackTables,
  buildRuntimeWritebackDeps,
  formatSavedLine,
} from '../js/polyglot/polyglot-writeback.js';
import { runPython, installPySaveQueue } from '../js/runtimes-viz/python-runtime.js';
import { runR, collectRSaves, R_WRITEBACK_SETUP } from '../js/runtimes-viz/r-runtime.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}
function throwsMsg(fn, re) {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
}
async function rejectsMsg(p, re) {
  try { await p; return false; } catch (e) { return re.test(e.message); }
}
const q = async (sql) => (await engine.runQuery(sql)).rows;

function freshDeps(extra = {}) {
  const datasets = [];
  const objects = createObjectSpace();
  const prov = createProvenanceRegistry();
  return {
    datasets, objects, prov,
    deps: {
      createTable: makeSqlTableCreator(engine.runQuery),
      getTableSchema: engine.getTableSchema,
      getRowCount: engine.getRowCount,
      datasets,
      registerObject: (d) => objects.register(d),
      recordProvenance: async (info) => {
        const chain = prov.getProvenance(info.table) || prov.startProvenance(info.table);
        await chain.append('load', info.message || 'saved', { rows: info.rowCount });
      },
      ...extra,
    },
  };
}

// ---------------------------------------------------------------- names
console.log('\nvalidateWritebackTableName');
ok('accepts a plain name', validateWritebackTableName('cohort_2024') === 'cohort_2024');
ok('trims whitespace', validateWritebackTableName('  my_df  ') === 'my_df');
ok('accepts leading underscore', validateWritebackTableName('_tmp') === '_tmp');
for (const bad of ['', '   ', '1abc', 'a b', 'a-b', 'a.b', 'a"b', "a'b", 'a;b', 'x; DROP TABLE t', 'a--b', 'é', 'a'.repeat(64)]) {
  ok(`rejects ${JSON.stringify(bad.slice(0, 24))}`, throwsMsg(() => validateWritebackTableName(bad), /table name/i));
}
for (const bad of [null, undefined, 5, {}, ['a']]) {
  ok(`rejects non-string ${JSON.stringify(bad)}`, throwsMsg(() => validateWritebackTableName(bad), /string/));
}
for (const bad of ['select', 'TABLE', 'From', 'null', 'true']) {
  ok(`rejects SQL keyword "${bad}"`, throwsMsg(() => validateWritebackTableName(bad), /keyword/));
}
for (const bad of ['sqlite_master', 'duckdb_tables', 'PG_catalog', '__hidden', '__dataglow_wb_stage_x']) {
  ok(`rejects reserved prefix "${bad}"`, throwsMsg(() => validateWritebackTableName(bad), /reserved prefix/));
}
ok('accepts a 63-char name', validateWritebackTableName('a'.repeat(63)).length === 63);

// ---------------------------------------------------------------- sanitize
console.log('\nsanitizeWritebackValue');
ok('NaN -> null', sanitizeWritebackValue(NaN) === null);
ok('Infinity -> null', sanitizeWritebackValue(Infinity) === null);
ok('-Infinity -> null', sanitizeWritebackValue(-Infinity) === null);
ok('undefined -> null', sanitizeWritebackValue(undefined) === null);
ok('safe BigInt -> number', sanitizeWritebackValue(42n) === 42);
ok('unsafe BigInt -> string', sanitizeWritebackValue(2n ** 70n) === (2n ** 70n).toString());
ok('Date -> ISO', sanitizeWritebackValue(new Date('2024-03-05T01:02:03Z')) === '2024-03-05T01:02:03.000Z');
ok('invalid Date -> null', sanitizeWritebackValue(new Date('nope')) === null);
ok('object -> JSON string', sanitizeWritebackValue({ a: 1 }) === '{"a":1}');
ok('array -> JSON string', sanitizeWritebackValue([1, 2]) === '[1,2]');
ok('object with BigInt/NaN is safe', sanitizeWritebackValue({ a: 1n, b: NaN }) === '{"a":"1","b":null}');
ok('preserves 0, "", false, "x"', sanitizeWritebackValue(0) === 0 && sanitizeWritebackValue('') === '' && sanitizeWritebackValue(false) === false && sanitizeWritebackValue('x') === 'x');

// ---------------------------------------------------------------- normalize
console.log('\nnormalizeWritebackRows');
{
  const r = normalizeWritebackRows([{ a: 1, b: 'x' }, { a: 2, c: true }]);
  ok('row-oriented: union of keys in first-seen order', r.columns.join() === 'a,b,c');
  ok('row-oriented: missing keys become null', r.rows[1].b === null && r.rows[0].c === null);
  const c = normalizeWritebackRows({ columns: { a: [1, 2], b: ['x', 'y'] } });
  ok('columnar: columns', c.columns.join() === 'a,b');
  ok('columnar: transposed rows', c.rows.length === 2 && c.rows[1].a === 2 && c.rows[1].b === 'y');
  const n = normalizeWritebackRows({ names: ['z', 'a'], columns: { a: [1], z: [2] } });
  ok('columnar: names pins column order', n.columns.join() === 'z,a');
  const sc = normalizeWritebackRows({ columns: { a: 5, b: 'q' } });
  ok('columnar: scalar column is a 1-row column', sc.rows.length === 1 && sc.rows[0].a === 5);
  const orig = { columns: { a: 5 } };
  normalizeWritebackRows(orig);
  ok('columnar: does not mutate its input', orig.columns.a === 5);
  const e = normalizeWritebackRows({ columns: ['a', 'b'], rows: [] });
  ok('names + empty rows keeps the columns', e.columns.join() === 'a,b' && e.rows.length === 0);
  const hinted = normalizeWritebackRows([], { columns: ['k', 'v'] });
  ok('empty array + columns hint keeps columns', hinted.columns.join() === 'k,v');
  const sanitized = normalizeWritebackRows([{ a: NaN, b: undefined, c: new Date(0), d: { x: 1 } }]);
  ok('values are sanitized', sanitized.rows[0].a === null && sanitized.rows[0].b === null
    && sanitized.rows[0].c === '1970-01-01T00:00:00.000Z' && sanitized.rows[0].d === '{"x":1}');
}
ok('0 columns (empty array) is a clear error', throwsMsg(() => normalizeWritebackRows([]), /0 columns/));
ok('0 columns ({}) is a clear error', throwsMsg(() => normalizeWritebackRows([{}, {}]), /0 columns/));
ok('ragged columnar is rejected', throwsMsg(() => normalizeWritebackRows({ columns: { a: [1, 2], b: [1] } }), /values but other columns/));
ok('names missing from columns rejected', throwsMsg(() => normalizeWritebackRows({ names: ['a', 'b'], columns: { a: [1] } }), /missing data for column "b"/));
ok('non-object rows rejected', throwsMsg(() => normalizeWritebackRows([1, 2]), /array of row objects/));
ok('unsupported payload rejected', throwsMsg(() => normalizeWritebackRows('nope'), /Unsupported/));
ok('duplicate column names rejected', throwsMsg(() => normalizeWritebackRows({ names: ['a', 'A'], columns: { a: [1], A: [2] } }), /Duplicate column/));
ok('__proto__ column rejected', throwsMsg(() => normalizeWritebackRows(JSON.parse('[{"__proto__": 1}]')), /__proto__/));
ok('WRITEBACK_ROW_LIMIT is 500000', WRITEBACK_ROW_LIMIT === 500_000);
ok('row limit (row-oriented) is a loud error', throwsMsg(() => normalizeWritebackRows([{ a: 1 }, { a: 2 }, { a: 3 }], { maxRows: 2 }), /Too many rows.*3 exceeds.*2 rows/));
ok('row limit (columnar) is a loud error', throwsMsg(() => normalizeWritebackRows({ columns: { a: [1, 2, 3] } }, { maxRows: 2 }), /Too many rows/));
ok('exactly at the limit passes', normalizeWritebackRows([{ a: 1 }, { a: 2 }], { maxRows: 2 }).rows.length === 2);

console.log('\ninferColumnType');
ok('ints -> BIGINT', inferColumnType([1, null, 3]) === 'BIGINT');
ok('floats -> DOUBLE', inferColumnType([1, 2.5]) === 'DOUBLE');
ok('bools -> BOOLEAN', inferColumnType([true, false, null]) === 'BOOLEAN');
ok('strings -> VARCHAR', inferColumnType(['a', null]) === 'VARCHAR');
ok('mixed -> VARCHAR', inferColumnType([1, 'a']) === 'VARCHAR' && inferColumnType([true, 1]) === 'VARCHAR');
ok('all null -> VARCHAR', inferColumnType([null, null]) === 'VARCHAR');

// ---------------------------------------------------------------- real DuckDB
console.log('\nmaterializeWritebackTables — real DuckDB round trip');
try {
  const { datasets, objects, prov, deps } = freshDeps();
  const saved = [];
  deps.onTableSaved = (i) => saved.push(i.name);

  const pySave = {
    name: 'py_people', language: 'python',
    rows: [
      { id: 1, name: "O'Brien", score: 91.5, active: true, note: 'say "hi"; DROP TABLE x; --', born: '1990-01-02T00:00:00.000' },
      { id: 2, name: 'Zoë 日本 🚀', score: NaN, active: false, note: null, born: null },
      { id: 3, name: 'back\\slash', score: Infinity, active: null, note: 'line1\nline2', born: '2000-12-31' },
    ],
  };
  const rSave = {
    name: 'r_scores', language: 'r',
    rows: { names: ['grp', 'val', 'flag'], columns: { grp: ['a', 'a', 'b', 'b'], val: [1, 2, 3, null], flag: [true, false, true, null] } },
  };
  const res = await materializeWritebackTables([pySave, rSave], deps);
  ok('both saved, none failed', res.saved.length === 2 && res.failed.length === 0, JSON.stringify(res.failed));

  const people = await q('SELECT * FROM py_people ORDER BY id');
  ok('python table has 3 rows', people.length === 3);
  ok('single quote round-trips', people[0].name === "O'Brien");
  ok('SQL-injection-looking text is stored as data', people[0].note === 'say "hi"; DROP TABLE x; --');
  ok('unicode/emoji round-trips', people[1].name === 'Zoë 日本 🚀');
  ok('backslash round-trips', people[2].name === 'back\\slash');
  ok('newline round-trips', people[2].note === 'line1\nline2');
  ok('NaN stored as NULL', people[1].score === null);
  ok('Infinity stored as NULL', people[2].score === null);
  ok('null stays NULL', people[1].note === null && people[1].born === null);
  ok('booleans stay BOOLEAN', people[0].active === true && people[1].active === false && people[2].active === null);
  const schema = Object.fromEntries((await engine.getTableSchema('py_people')).map(s => [s.column_name, s.column_type]));
  ok('column types: BIGINT/VARCHAR/DOUBLE/BOOLEAN', schema.id === 'BIGINT' && schema.name === 'VARCHAR' && schema.score === 'DOUBLE' && schema.active === 'BOOLEAN', JSON.stringify(schema));
  ok('ISO date strings stay queryable text (castable)', (await q(`SELECT CAST(born AS DATE) AS d FROM py_people WHERE id = 1`))[0].d != null);
  ok('real SQL aggregate over a Python table', (await q('SELECT SUM(score) AS s, COUNT(score) AS c FROM py_people'))[0].s === 91.5);

  const grouped = await q('SELECT grp, SUM(val) AS s, COUNT(*) AS n FROM r_scores GROUP BY grp ORDER BY grp');
  ok('real GROUP BY over an R table', grouped.length === 2 && grouped[0].s === 3 && grouped[1].s === 3 && grouped[1].n === 2, JSON.stringify(grouped));
  const rs = Object.fromEntries((await engine.getTableSchema('r_scores')).map(s => [s.column_name, s.column_type]));
  ok('R columnar column types', rs.grp === 'VARCHAR' && rs.val === 'BIGINT' && rs.flag === 'BOOLEAN', JSON.stringify(rs));
  const joined = await q(`SELECT p.name, r.val FROM py_people p JOIN r_scores r ON p.id = r.val ORDER BY p.id`);
  ok('JOIN across a Python-saved and an R-saved table', joined.length === 3 && joined[0].name === "O'Brien", JSON.stringify(joined));

  // state.datasets registration
  const dsP = datasets.find(d => d.table === 'py_people');
  ok('registered in datasets', datasets.length === 2 && !!dsP);
  ok('dataset rowCount from DuckDB', dsP.rowCount === 3);
  ok('dataset cols are {name,type}', dsP.cols.length === 6 && dsP.cols[0].name === 'id' && dsP.cols[0].type === 'BIGINT');
  ok('dataset name === table name', dsP.name === 'py_people' && dsP.table === 'py_people');
  ok('meta.source (python)', dsP.meta.source === 'Python runtime (dataglow.save_df)');
  ok('meta.format/originLanguage (python)', dsP.meta.format === 'python' && dsP.meta.originLanguage === 'python');
  ok('meta.savedAt is ISO', !Number.isNaN(Date.parse(dsP.meta.savedAt)) && dsP.meta.savedAt.endsWith('Z'));
  const dsR = datasets.find(d => d.table === 'r_scores');
  ok('meta.source (r)', dsR.meta.source === 'R runtime (dataglow_save_df)' && dsR.meta.originLanguage === 'r');

  // object space + provenance + callbacks
  const op = objects.get('py:py_people');
  ok('Object Space entry registered (py:)', !!op && op.originLanguage === 'python' && op.kind === 'dataframe' && op.rowCount === 3 && op.provenance === 'py_people');
  ok('Object Space entry registered (r:)', objects.get('r:r_scores')?.originLanguage === 'r');
  ok('Object Space schema carries types', op.schema.some(c => c.name === 'score' && c.type === 'DOUBLE'));
  ok('provenance chain started', !!prov.getProvenance('py_people'));
  ok('onTableSaved fired per table', saved.join() === 'py_people,r_scores');
  ok('result carries a confirmation line', res.saved[0].message === 'Saved table "py_people" (3 rows × 6 cols) to DuckDB — ready in SQL, Glow Canvas & Export', res.saved[0].message);
  ok('formatSavedLine matches', formatSavedLine(res.saved[1]) === res.saved[1].message);

  // replace semantics
  const res2 = await materializeWritebackTables([{ name: 'py_people', language: 'python', rows: [{ id: 9 }] }], deps);
  ok('re-save replaces the table', (await q('SELECT COUNT(*) AS n FROM py_people'))[0].n === 1);
  ok('re-save flagged replaced and datasets not duplicated', res2.saved[0].replaced === true && datasets.filter(d => d.table === 'py_people').length === 1);
  ok('re-save updated rowCount/cols', datasets.find(d => d.table === 'py_people').rowCount === 1 && datasets.find(d => d.table === 'py_people').cols.length === 1);
  ok('replacement drops old columns', !(await engine.getTableSchema('py_people')).some(c => c.column_name === 'name'));
  ok('case-insensitive name collision replaces, not duplicates', await (async () => {
    await materializeWritebackTables([{ name: 'PY_PEOPLE', language: 'r', rows: [{ id: 1 }, { id: 2 }] }], deps);
    return datasets.filter(d => d.table.toLowerCase() === 'py_people').length === 1;
  })());

  // last-write-wins within one batch
  await materializeWritebackTables([
    { name: 'dup', language: 'python', rows: [{ v: 1 }] },
    { name: 'dup', language: 'python', rows: [{ v: 1 }, { v: 2 }] },
  ], deps);
  ok('same name twice in one run: last save wins', (await q('SELECT COUNT(*) AS n FROM dup'))[0].n === 2);

  // the stage table never leaks
  const tables = (await q(`SELECT table_name FROM information_schema.tables`)).map(t => t.table_name);
  ok('no staging tables left behind', !tables.some(t => t.startsWith('__dataglow_wb_stage_')), tables.join());

  // empty (0-row, known columns)
  const emp = await materializeWritebackTables([{ name: 'empty_t', language: 'python', rows: { columns: ['a', 'b'], rows: [] } }], deps);
  ok('0-row table with columns is created', emp.saved.length === 1 && (await q('SELECT COUNT(*) AS n FROM empty_t'))[0].n === 0 && emp.saved[0].cols.length === 2);

  // weird-but-legal column names are quoted safely
  const weird = await materializeWritebackTables([{ name: 'weird_cols', language: 'python', rows: [{ 'a b': 1, 'sel"ect': 2, 'x; DROP TABLE dup; --': 3, 'Ünï': 4 }] }], deps);
  ok('hostile column names are quote-escaped', weird.saved.length === 1 && (await q('SELECT COUNT(*) AS n FROM dup'))[0].n === 2);
  ok('hostile column names are queryable', (await q('SELECT "sel""ect" AS v FROM weird_cols'))[0].v === 2);

  // batching crosses INSERT batch boundaries
  const many = Array.from({ length: 1234 }, (_, i) => ({ i, s: `row ${i}` }));
  const big = await materializeWritebackTables([{ name: 'batched', language: 'r', rows: many }], deps);
  ok('1234 rows across 3 INSERT batches', big.saved[0]?.rowCount === 1234 && (await q('SELECT SUM(i) AS s FROM batched'))[0].s === 1234 * 1233 / 2);

  // failures: reported, others continue, existing data untouched
  const mixed = await materializeWritebackTables([
    { name: 'good_one', language: 'python', rows: [{ a: 1 }] },
    { name: 'bad name; DROP TABLE good_one', language: 'python', rows: [{ a: 1 }] },
    { name: 'select', language: 'python', rows: [{ a: 1 }] },
    { name: 'zero_cols', language: 'r', rows: [] },
    { name: 'too_big', language: 'r', rows: [{ a: 1 }, { a: 2 }, { a: 3 }] },
    { name: 'bad_lang', language: 'julia', rows: [{ a: 1 }] },
  ], { ...deps, maxRows: 2 });
  ok('valid save still lands next to failures', mixed.saved.length === 1 && mixed.saved[0].name === 'good_one');
  ok('5 failures reported with messages', mixed.failed.length === 5 && mixed.failed.every(f => typeof f.error === 'string' && f.error.length > 5), JSON.stringify(mixed.failed));
  ok('injection attempt did not execute', (await q('SELECT COUNT(*) AS n FROM good_one'))[0].n === 1);
  ok('row limit failure names the limit', mixed.failed.some(f => f.name === 'too_big' && /Too many rows/.test(f.error)));
  ok('failed saves are not registered', !datasets.some(d => d.table === 'too_big' || d.table === 'select'));
  ok('failed table was never created', !(await q(`SELECT table_name FROM information_schema.tables`)).some(t => t.table_name === 'too_big'));

  // atomic replace: an INSERT failure leaves the existing table intact
  let calls = 0;
  const flakyRun = async (sql) => { if (/^INSERT/.test(sql) && ++calls === 2) throw new Error('boom'); return engine.runQuery(sql); };
  const flaky = makeSqlTableCreator(flakyRun);
  await materializeWritebackTables([{ name: 'atomic_t', language: 'python', rows: [{ a: 'keep' }] }], deps);
  const r3 = await materializeWritebackTables(
    [{ name: 'atomic_t', language: 'python', rows: Array.from({ length: 1200 }, (_, i) => ({ a: String(i) })) }],
    { ...deps, createTable: flaky });
  ok('mid-insert failure is reported', r3.failed.length === 1 && /boom/.test(r3.failed[0].error));
  ok('existing table untouched after mid-insert failure', (await q('SELECT a FROM atomic_t'))[0].a === 'keep');
  ok('stage table cleaned up after failure', !(await q(`SELECT table_name FROM information_schema.tables`)).some(t => t.table_name.startsWith('__dataglow_wb_stage_')));

  // registry/provenance/onSaved errors never undo a save
  const resilient = await materializeWritebackTables([{ name: 'resilient', language: 'python', rows: [{ a: 1 }] }], {
    ...deps,
    registerObject: () => { throw new Error('registry down'); },
    recordProvenance: async () => { throw new Error('prov down'); },
    onTableSaved: () => { throw new Error('ui down'); },
  });
  ok('registry/provenance/UI failures never undo a save', resilient.saved.length === 1 && resilient.failed.length === 0);

  // the SQL builder itself
  const plan = buildWritebackPlan('t1', ['a'], [{ a: "it's" }]);
  ok('plan escapes quotes in literals', plan.inserts[0].includes("'it''s'"));
  ok('plan swaps atomically via CREATE OR REPLACE', plan.swap.startsWith('CREATE OR REPLACE TABLE "t1"'));
  ok('plan rejects hostile table names', throwsMsg(() => buildWritebackPlan('t"; DROP TABLE x;--', ['a'], []), /table name/i));

  // deps validation
  ok('createTable is required', await rejectsMsg(materializeWritebackTables([], { getTableSchema() {}, datasets: [] }), /createTable/));
  ok('datasets array is required', await rejectsMsg(materializeWritebackTables([], { createTable() {}, getTableSchema() {} }), /datasets/));
} catch (e) {
  ok('materializer round trip executes without throwing', false, e.stack || e.message);
}

// ---------------------------------------------------------------- python runtime
console.log('\nrunPython — write-back wiring (stub Pyodide, real DuckDB)');
function makePyodideStub(userCode) {
  return {
    globals: { set() {} },
    setStdout() {}, setStderr() {},
    async runPythonAsync(code) {
      if (code.includes('_register')) return undefined;
      if (code.includes('_dataglow_capture_figures')) return undefined;
      return userCode(code);
    },
  };
}
try {
  state.datasets = [];
  await engine.runQuery(`CREATE OR REPLACE TABLE src AS SELECT 1 AS id, 'a' AS g UNION ALL SELECT 2, 'b'`);
  state.datasets = [{ name: 'src', table: 'src', rowCount: 2, cols: [{ name: 'id', type: 'INTEGER' }] }];

  // FLAG OFF
  configureFlags({ flags: { polyglotWriteback: { enabled: false } } });
  let sawQueueWhileOff = 'unset';
  state.pyodide = makePyodideStub(() => { sawQueueWhileOff = typeof globalThis.__dataglowQueuePySave; return 'ok'; });
  globalThis.__dataglowQueuePySave = () => { throw new Error('stale'); };
  const off = await runPython('x = 1', 'src');
  ok('flag off: no JS queue is installed (stale one removed)', sawQueueWhileOff === 'undefined');
  ok('flag off: result shape is unchanged (no saved/saveErrors)', !('saved' in off) && !('saveErrors' in off));
  ok('flag off: datasets untouched', state.datasets.length === 1);

  // FLAG ON — successful save
  configureFlags({ flags: { polyglotWriteback: { enabled: true }, objectSpaceRegistry: { enabled: false } } });
  state.pyodide = makePyodideStub(() => {
    globalThis.__dataglowQueuePySave('py_result', JSON.stringify([{ id: 1, v: 2.5, ok: true }, { id: 2, v: null, ok: false }]), JSON.stringify(['id', 'v', 'ok']));
    return 'done';
  });
  const on = await runPython('dataglow.save_df("py_result", df)', 'src');
  ok('flag on: run succeeded', on.error === null && on.result === 'done');
  ok('flag on: reports saved table', on.saved.length === 1 && on.saved[0].name === 'py_result' && on.saveErrors.length === 0);
  ok('flag on: confirmation text', on.saved[0].message === 'Saved table "py_result" (2 rows × 3 cols) to DuckDB — ready in SQL, Glow Canvas & Export', on.saved[0].message);
  ok('flag on: SQL can query it', (await q('SELECT SUM(v) AS s FROM py_result'))[0].s === 2.5);
  ok('flag on: joins to the loaded table', (await q('SELECT COUNT(*) AS n FROM py_result p JOIN src s ON s.id = p.id'))[0].n === 2);
  ok('flag on: state.datasets updated', state.datasets.some(d => d.table === 'py_result' && d.meta.originLanguage === 'python'));
  ok('flag on: queue removed after the run', typeof globalThis.__dataglowQueuePySave === 'undefined');

  // validation happens INSIDE the script (so Python sees the error)
  let queueError = null;
  state.pyodide = makePyodideStub(() => {
    try { globalThis.__dataglowQueuePySave('bad name', '[{"a":1}]', '["a"]'); } catch (e) { queueError = e.message; }
    try { globalThis.__dataglowQueuePySave('ok_name', '{not json', '[]'); } catch (e) { queueError += ' | ' + e.message; }
    return null;
  });
  const bad = await runPython('...', 'src');
  ok('queue rejects a bad name immediately', /Invalid table name/.test(queueError), queueError);
  ok('queue rejects unreadable JSON immediately', /could not read the DataFrame JSON/.test(queueError), queueError);
  ok('nothing saved when every queue call failed', bad.saved.length === 0);

  // a failing run commits nothing
  const before = state.datasets.length;
  state.pyodide = makePyodideStub(() => {
    globalThis.__dataglowQueuePySave('never_saved', '[{"a":1}]', '["a"]');
    throw new Error('NameError: boom');
  });
  const errRun = await runPython('1/0', 'src');
  ok('error run reports the error', errRun.error === 'NameError: boom');
  ok('error run commits nothing', errRun.saved.length === 0 && state.datasets.length === before
    && !(await q(`SELECT table_name FROM information_schema.tables`)).some(t => t.table_name === 'never_saved'));
  ok('error run still disposes the queue', typeof globalThis.__dataglowQueuePySave === 'undefined');

  // row limit surfaces as saveErrors through the runtime path
  const q2 = installPySaveQueue({});
  ok('installPySaveQueue returns pending + dispose', Array.isArray(q2.pending) && typeof q2.dispose === 'function');

  // Object Space gating by objectSpaceRegistry
  const os = await import('../js/app-shell/object-space.js');
  configureFlags({ flags: { polyglotWriteback: { enabled: true }, objectSpaceRegistry: { enabled: true } } });
  state.pyodide = makePyodideStub(() => { globalThis.__dataglowQueuePySave('os_t', '[{"a":1}]', '["a"]'); return null; });
  await runPython('x', 'src');
  ok('objectSpaceRegistry on: registered as py:<name>', os.listObjectSpace().some(o => o.name === 'py:os_t'));
} catch (e) {
  ok('runPython write-back path executes without throwing', false, e.stack || e.message);
}

// ---------------------------------------------------------------- real CPython bridge
console.log('\nPython bridge source (real CPython + pandas, if available)');
{
  const src = readFileSync(new URL('../js/runtimes-viz/python-runtime.js', import.meta.url), 'utf8');
  const m = src.match(/import pandas as pd\nimport numpy as np\nimport json as _json[\s\S]*?\ndataglow = _DataglowBridge\(\)/);
  ok('bridge source found in python-runtime.js', !!m);
  const probe = spawnSync('python3', ['-c', 'import pandas'], { encoding: 'utf8' });
  if (!m || probe.status !== 0) {
    console.log('  - skipped (python3 + pandas not available)');
  } else {
    const script = `
import sys, types, json
calls = []
js = types.ModuleType('js')
sys.modules['js'] = js
${m[0]}
out = {}
# 1) flag off: no queue on the js module
try:
    dataglow.save_df('t', pd.DataFrame({'a':[1]}))
    out['off'] = 'no error'
except RuntimeError as e:
    out['off'] = str(e)
# 2) flag on: install a queue
setattr(js, '__dataglowQueuePySave', lambda n, j, c: calls.append([n, j, c]))
df = pd.DataFrame({'id':[1,2], 'x':[1.5, float('nan')], 'when': pd.to_datetime(['2024-01-02','2024-03-04']), 'b':[True, False], 's':['a', None]})
dataglow.save_df('frame', df)
dataglow.save_df('lst', [{'k': 1, 'v': 'z'}, {'k': 2, 'v': 'y'}])
dataglow.save_df('empty', pd.DataFrame({'a': [], 'b': []}))
dataglow.save_df('numcols', pd.DataFrame([[1, 2]], columns=[0, 1]))
for label, fn in [
    ('dupcols', lambda: dataglow.save_df('d', pd.DataFrame([[1, 2]], columns=['a', 'A']))),
    ('badname', lambda: dataglow.save_df(5, df)),
    ('baddf', lambda: dataglow.save_df('x', 5)),
]:
    try:
        fn(); out[label] = 'no error'
    except Exception as e:
        out[label] = type(e).__name__ + ': ' + str(e)
out['calls'] = calls
print(json.dumps(out))
`;
    const run = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
    if (run.status !== 0) {
      ok('bridge source runs under CPython', false, run.stderr);
    } else {
      const out = JSON.parse(run.stdout.trim().split('\n').pop());
      ok('flag off: save_df raises the documented RuntimeError', out.off === 'dataglow.save_df requires the polyglotWriteback feature flag to be enabled.', out.off);
      ok('4 queued saves', out.calls.length === 4);
      const [frame, lst, empty, numcols] = out.calls;
      ok('frame JSON is records-oriented with ISO dates and null for NaN', (() => {
        const rows = JSON.parse(frame[1]);
        return rows.length === 2 && rows[1].x === null && /^2024-03-04T/.test(rows[1].when) && rows[0].b === true && rows[1].s === null;
      })(), frame[1]);
      ok('columns JSON preserves column order', JSON.parse(frame[2]).join() === 'id,x,when,b,s');
      ok('list of dicts is accepted', JSON.parse(lst[1]).length === 2 && lst[0] === 'lst');
      ok('empty DataFrame keeps its columns', JSON.parse(empty[1]).length === 0 && JSON.parse(empty[2]).join() === 'a,b');
      ok('non-string column labels are stringified', JSON.parse(numcols[2]).join() === '0,1');
      ok('duplicate columns raise ValueError', /^ValueError: .*duplicate column names/.test(out.dupcols), out.dupcols);
      ok('non-string name raises TypeError', /^TypeError/.test(out.badname), out.badname);
      ok('non-DataFrame raises TypeError', /^TypeError/.test(out.baddf), out.baddf);

      // Feed the REAL payloads through the production JS queue + materializer into DuckDB.
      configureFlags({ flags: { polyglotWriteback: { enabled: true } } });
      const tgt = {};
      const real = installPySaveQueue(tgt);
      for (const [n, j, c] of out.calls) tgt.__dataglowQueuePySave(n, j, c);
      const h = freshDeps();
      const res = await materializeWritebackTables(real.pending, h.deps);
      ok('real pandas payloads all materialize', res.saved.length === 4 && res.failed.length === 0, JSON.stringify(res.failed));
      ok('pandas NaN is SQL NULL', (await q('SELECT COUNT(*) AS n FROM frame WHERE x IS NULL'))[0].n === 1);
      ok('pandas ISO datetimes are castable', (await q('SELECT CAST(\"when\" AS DATE) AS d FROM frame ORDER BY id'))[1].d != null);
      ok('empty pandas frame becomes an empty table with 2 columns', (await engine.getTableSchema('empty')).length === 2);
      real.dispose();
    }
  }
}

// ---------------------------------------------------------------- r runtime
console.log('\nrunR — write-back wiring (stub WebR, real DuckDB)');
function makeWebRStub({ savesJson = '{}', output = [], failCapture = false } = {}) {
  const evald = [];
  return {
    evald,
    objs: { globalEnv: { async bind() {} } },
    async evalRVoid(code) { evald.push(code); },
    async evalRString(code) { evald.push(code); return savesJson; },
    Shelter: class {
      async captureR() { if (failCapture) throw new Error('R error'); return { output, images: [] }; }
      async purge() {}
    },
  };
}
try {
  ok('R helper defines dataglow_save_df and the collector', /dataglow_save_df <- function\(name, df\)/.test(R_WRITEBACK_SETUP) && /\.dataglow_collect_saves <- function/.test(R_WRITEBACK_SETUP));
  ok('R helper converts factors, Dates and POSIXct', /is\.factor/.test(R_WRITEBACK_SETUP) && /"Date"/.test(R_WRITEBACK_SETUP) && /POSIXt/.test(R_WRITEBACK_SETUP));
  ok('R helper emits null for NA and non-finite numbers', /is\.finite\(col\)/.test(R_WRITEBACK_SETUP) && /"null"/.test(R_WRITEBACK_SETUP));
  ok('R helper does not depend on jsonlite', !/jsonlite/.test(R_WRITEBACK_SETUP));

  const wire = JSON.stringify({
    r_out: { names: ['g', 'n', 'ok', 'when'], columns: { g: ['a', 'b', 'c'], n: [1, 2.5, null], ok: [true, null, false], when: ['2024-01-02', null, '2025-12-31'] } },
    one_row: { names: ['x'], columns: { x: [7] } },
  });
  const stub = makeWebRStub({ savesJson: wire });
  const pending = await collectRSaves(stub);
  ok('collectRSaves parses the R wire format', pending.length === 2 && pending[0].name === 'r_out' && pending[0].language === 'r');
  ok('collectRSaves asks R for .dataglow_collect_saves()', stub.evald.at(-1) === '.dataglow_collect_saves()');
  ok('collectRSaves tolerates an empty result', (await collectRSaves(makeWebRStub({ savesJson: '{}' }))).length === 0);

  state.webR = stub;
  state.datasets = [];
  // FLAG OFF
  configureFlags({ flags: { polyglotWriteback: { enabled: false } } });
  stub.evald.length = 0;
  const off = await runR('x <- 1');
  ok('flag off: R helper is never evaluated', !stub.evald.some(c => /dataglow_save_df/.test(c)));
  ok('flag off: result shape unchanged (no saved/saveErrors)', !('saved' in off) && !('saveErrors' in off));
  ok('flag off: nothing collected from R', !stub.evald.some(c => /collect_saves/.test(c)));

  // FLAG ON
  configureFlags({ flags: { polyglotWriteback: { enabled: true }, objectSpaceRegistry: { enabled: true } } });
  stub.evald.length = 0;
  const on = await runR('dataglow_save_df("r_out", df)');
  ok('flag on: helper evaluated alongside the bridge', stub.evald.some(c => /dataglow_save_df <- function/.test(c)));
  ok('flag on: both tables saved', on.saved.length === 2 && on.saveErrors.length === 0, JSON.stringify(on.saveErrors));
  ok('flag on: confirmation text', on.saved[0].message === 'Saved table "r_out" (3 rows × 4 cols) to DuckDB — ready in SQL, Glow Canvas & Export', on.saved[0].message);
  const rOut = await q('SELECT * FROM r_out ORDER BY g');
  ok('R NA -> SQL NULL, values preserved', rOut[2].n === null && rOut[1].n === 2.5 && rOut[0].ok === true && rOut[1].ok === null);
  ok('R Date strings kept as ISO text', rOut[0].when === '2024-01-02');
  ok('state.datasets has R-origin metadata', state.datasets.some(d => d.table === 'r_out' && d.meta.source === 'R runtime (dataglow_save_df)'));
  ok('Object Space has r:r_out', (await import('../js/app-shell/object-space.js')).listObjectSpace().some(o => o.name === 'r:r_out'));

  // R error: nothing committed
  const errStub = makeWebRStub({ savesJson: wire, output: [{ type: 'error', data: 'oops' }] });
  state.webR = errStub;
  state.datasets = [];
  await engine.runQuery('DROP TABLE IF EXISTS one_row');
  const errRun = await runR('stop("x")');
  ok('R error output: nothing materialized', errRun.saved.length === 0 && !state.datasets.length);
  ok('R error output: staged tables were still drained from R', errStub.evald.some(c => /collect_saves/.test(c)));

  // a throwing collector is reported, never thrown
  const collectFail = makeWebRStub();
  collectFail.evalRString = async () => { throw new Error('R is gone'); };
  state.webR = collectFail;
  const cf = await runR('1');
  ok('collector failure is reported as a saveError', cf.saveErrors.length === 1 && /R is gone/.test(cf.saveErrors[0].error) && cf.error === null);

  // R row limit surfaces as a failed save
  const huge = { names: ['a'], columns: { a: new Array(WRITEBACK_ROW_LIMIT + 1).fill(1) } };
  state.webR = makeWebRStub({ savesJson: JSON.stringify({ huge }) });
  const hugeRun = await runR('1');
  ok('over-limit R table is a loud saveError, not a truncation', hugeRun.saved.length === 0 && /Too many rows/.test(hugeRun.saveErrors[0].error));
} catch (e) {
  ok('runR write-back path executes without throwing', false, e.stack || e.message);
}

// ---------------------------------------------------------------- wiring helpers + isolation
console.log('\nbuildRuntimeWritebackDeps + flag-off isolation');
{
  ok('requires engine.runQuery', throwsMsg(() => buildRuntimeWritebackDeps({ engine: {}, state: {} }), /runQuery/));
  const st = {};
  const d = buildRuntimeWritebackDeps({ engine, state: st });
  ok('creates state.datasets when missing and shares the array', Array.isArray(st.datasets) && d.datasets === st.datasets);
  ok('no recordProvenance without a provenance module', d.recordProvenance === undefined);
  const prov = createProvenanceRegistry();
  const d2 = buildRuntimeWritebackDeps({ engine, state: { datasets: [] }, provenance: prov });
  const info = { table: 't', name: 't', rowCount: 3, columns: ['a'], language: 'r', replaced: false, dataset: { meta: { source: 'R runtime (dataglow_save_df)' } } };
  await d2.recordProvenance(info);
  await d2.recordProvenance({ ...info, replaced: true });
  ok('default provenance wiring starts then appends to the chain', !!prov.getProvenance('t'));

  const flags = JSON.parse(readFileSync(new URL('../flags.manifest.json', import.meta.url), 'utf8')).flags;
  ok('polyglotWriteback ships enabled after Step 8 confirmation', flags.polyglotWriteback?.enabled === true);
  ok('polyglotWriteback names its PR', flags.polyglotWriteback?.addedInPR === 'feat/polyglot-writeback-to-duckdb');
  const keys = Object.keys(flags);
  ok('polyglotWriteback sits right after polyglotErrorAdvisor', keys[keys.indexOf('polyglotErrorAdvisor') + 1] === 'polyglotWriteback');

  const writeback = readFileSync(new URL('../js/polyglot/polyglot-writeback.js', import.meta.url), 'utf8');
  ok('writeback module imports nothing (pure + injected)', !/^\s*import\s/m.test(writeback));
  ok('writeback module never reads the flag itself', !/isEnabled|polyglotWriteback['"]/.test(writeback.replace(/\/\/.*$/gm, '')));
  const py = readFileSync(new URL('../js/runtimes-viz/python-runtime.js', import.meta.url), 'utf8');
  const r = readFileSync(new URL('../js/runtimes-viz/r-runtime.js', import.meta.url), 'utf8');
  ok("python-runtime gates the queue on isEnabled('polyglotWriteback')", /isEnabled\('polyglotWriteback'\)\s*\?\s*installPySaveQueue/.test(py));
  ok("r-runtime gates the helper on isEnabled('polyglotWriteback')", /isEnabled\('polyglotWriteback'\)/.test(r) && /writeback \? bridgeSetup \+ R_WRITEBACK_SETUP : bridgeSetup/.test(r));
  ok('flag-off bridgeSetup path is byte-identical (no helper appended)', /writeback \? bridgeSetup \+ R_WRITEBACK_SETUP : bridgeSetup/.test(r));
}

await engine.closeConnection?.();
console.log(`\n${failed === 0 ? '✓ PASSED' : '✗ FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
