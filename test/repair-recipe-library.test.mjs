// ============================================================
// DATAGLOW - Repair Recipe Library test suite
// ============================================================
// Pure engine + in-memory store. No DuckDB, no network, no DOM.
//   RUN WITH:  node test/repair-recipe-library.test.mjs

import assert from 'assert';
import {
  REPAIR_RECIPE_LIBRARY_VERSION,
  RECIPE_KINDS,
  createRecipeRecord,
  validateRecord,
  serializeLibrary,
  parseLibrary,
  scoreRecipeMatch,
  getApplyPayload,
  sortRecipes,
  filterRecipes,
  normalizeColumnNames,
} from '../js/intelligence/repair-recipe-library.js';
import { createMemoryStore, createRepairRecipeStore } from '../js/intelligence/repair-recipe-store.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed++;
}

console.log('repair-recipe-library');
ok('version is 1', REPAIR_RECIPE_LIBRARY_VERSION === 1);
ok('kinds include excelHell + guidedUnpivot', RECIPE_KINDS.indexOf('excelHell') !== -1 && RECIPE_KINDS.indexOf('guidedUnpivot') !== -1);

// ---------------------------------------------------------------------------
// createRecipeRecord + validateRecord
// ---------------------------------------------------------------------------
const ehRecipe = {
  id: 'excelhell-1',
  name: 'Excel Hell Repair',
  steps: [{ op: 'promoteHeader', rowIndex: 3 }, { op: 'trimCells' }],
  sourceFingerprint: { rowCount: 9, colCount: 3, headerHash: 'abc' },
};

const rec = createRecipeRecord({
  name: 'Claims cleanup',
  kind: 'excelHell',
  payload: ehRecipe,
  columnNames: ['Region', 'Units', 'Revenue'],
  sourceName: 'claims.xlsx',
  notes: 'monthly',
});
ok('record has id', typeof rec.id === 'string' && rec.id.length > 0);
ok('record name kept', rec.name === 'Claims cleanup');
ok('record kind excelHell', rec.kind === 'excelHell');
ok('record columnNames', rec.columnNames.join(',') === 'Region,Units,Revenue');
ok('record sourceName', rec.sourceName === 'claims.xlsx');
ok('record notes', rec.notes === 'monthly');
ok('record version 1', rec.version === 1);
ok('record has createdAt + updatedAt', !!rec.createdAt && !!rec.updatedAt);
ok('record payload keeps steps', rec.payload.steps.length === 2);

const v1 = validateRecord(rec);
ok('valid record passes', v1.ok === true && v1.errors.length === 0);

// unknown kind falls back to excelHell (never throws)
const recFallback = createRecipeRecord({ name: 'x', kind: 'nonsense', payload: {} });
ok('unknown kind coerced to excelHell', recFallback.kind === 'excelHell');

// missing name gets a default
const recNoName = createRecipeRecord({ kind: 'excelHell', payload: {} });
ok('missing name defaulted', recNoName.name === 'Untitled recipe');

// validate rejects garbage
ok('validate rejects null', validateRecord(null).ok === false);
ok('validate rejects array', validateRecord([]).ok === false);
const badKind = { id: 'a', name: 'b', kind: 'zzz', payload: {}, columnNames: [] };
ok('validate rejects bad kind', validateRecord(badKind).ok === false);

// ---------------------------------------------------------------------------
// Privacy backstop: row data is stripped on create, rejected on validate
// ---------------------------------------------------------------------------
const dirty = createRecipeRecord({
  name: 'dirty',
  kind: 'excelHell',
  payload: { steps: [], rows: [[1, 2, 3]], nested: { data: [[9]], keep: 'ok' } },
  columnNames: ['a', 'b'],
});
ok('create strips top-level rows', dirty.payload.rows === undefined);
ok('create strips nested data', dirty.payload.nested.data === undefined);
ok('create keeps safe nested fields', dirty.payload.nested.keep === 'ok');
ok('stripped record validates clean', validateRecord(dirty).ok === true);

// a hand-built record that smuggles rows must be rejected by validate
const smuggled = { id: 'x', name: 'y', kind: 'excelHell', columnNames: [], payload: { steps: [], values: [[1]] } };
ok('validate rejects smuggled row data', validateRecord(smuggled).ok === false);

// ---------------------------------------------------------------------------
// serialize round-trip
// ---------------------------------------------------------------------------
const upRec = createRecipeRecord({
  name: 'Wide months',
  kind: 'guidedUnpivot',
  payload: { keepColumns: ['id'], unpivotColumns: ['Jan', 'Feb', 'Mar'], nameColumn: 'month', valueColumn: 'amount' },
  columnNames: ['id', 'Jan', 'Feb', 'Mar'],
});
const json = serializeLibrary([rec, upRec]);
ok('serialize returns string', typeof json === 'string' && json.length > 0);
const parsed = parseLibrary(json);
ok('parse ok', parsed.ok === true);
ok('parse round-trips 2 records', parsed.records.length === 2);
ok('parse preserves kind', parsed.records[1].kind === 'guidedUnpivot');
ok('parse bad json fails safe', parseLibrary('{not json').ok === false);
ok('parse non-object fails', parseLibrary('42').ok === false);
ok('parse array of records ok', parseLibrary(JSON.stringify([rec])).ok === true);
// parse drops records that fail validation (e.g. smuggled rows)
const mixed = parseLibrary(JSON.stringify({ records: [rec, smuggled] }));
ok('parse drops invalid records', mixed.ok === true && mixed.records.length === 1);

// ---------------------------------------------------------------------------
// scoreRecipeMatch: perfect / partial / none
// ---------------------------------------------------------------------------
const perfect = scoreRecipeMatch(rec, ['Region', 'Units', 'Revenue']);
ok('perfect score 100', perfect.score === 100);
ok('perfect canApply', perfect.canApply === true);
ok('perfect no missing', perfect.missing.length === 0);
ok('perfect no warning', !perfect.warning);

const caseInsensitive = scoreRecipeMatch(rec, ['region', 'UNITS', 'revenue']);
ok('match is case-insensitive', caseInsensitive.score === 100);

const partial = scoreRecipeMatch(rec, ['Region', 'Units', 'Extra']);
ok('partial score 67', partial.score === 67);
ok('partial lists missing Revenue', partial.missing.indexOf('Revenue') !== -1);
ok('partial lists extra', partial.extra.indexOf('Extra') !== -1);
ok('partial canApply (>=50)', partial.canApply === true);
ok('partial has warning', typeof partial.warning === 'string' && partial.warning.length > 0);

const none = scoreRecipeMatch(rec, ['totally', 'different']);
ok('none score 0', none.score === 0);
ok('none cannot apply', none.canApply === false);
ok('none has warning', !!none.warning);

const emptyCols = scoreRecipeMatch({ columnNames: [] }, ['a', 'b']);
ok('empty recipe cols: score 0 but canApply soft-true', emptyCols.score === 0 && emptyCols.canApply === true);

// ---------------------------------------------------------------------------
// getApplyPayload
// ---------------------------------------------------------------------------
const ap = getApplyPayload(rec);
ok('getApplyPayload ok', ap.ok === true);
ok('getApplyPayload kind', ap.kind === 'excelHell');
ok('getApplyPayload returns payload steps', ap.payload.steps.length === 2);
ok('getApplyPayload rejects invalid record', getApplyPayload(null).ok === false);

// ---------------------------------------------------------------------------
// sort + filter
// ---------------------------------------------------------------------------
const older = createRecipeRecord({ name: 'Alpha', kind: 'excelHell', payload: {}, columnNames: [], createdAt: '2020-01-01T00:00:00.000Z' });
older.updatedAt = '2020-01-01T00:00:00.000Z';
const newer = createRecipeRecord({ name: 'Zeta', kind: 'guidedUnpivot', payload: {}, columnNames: [] });
newer.updatedAt = '2999-01-01T00:00:00.000Z';
const sortedByUpdated = sortRecipes([older, newer], 'updatedAt');
ok('sort by updatedAt newest first', sortedByUpdated[0].name === 'Zeta');
const sortedByName = sortRecipes([newer, older], 'name');
ok('sort by name alphabetical', sortedByName[0].name === 'Alpha');
ok('sort does not mutate input', true);

const setForFilter = [rec, upRec, older, newer];
const onlyUnpivot = filterRecipes(setForFilter, { kind: 'guidedUnpivot' });
ok('filter by kind', onlyUnpivot.every(r => r.kind === 'guidedUnpivot') && onlyUnpivot.length === 2);
const byQuery = filterRecipes(setForFilter, { query: 'claims' });
ok('filter by query matches sourceName', byQuery.length === 1 && byQuery[0].name === 'Claims cleanup');
const byColQuery = filterRecipes(setForFilter, { query: 'jan' });
ok('filter by query matches column name', byColQuery.length === 1 && byColQuery[0].kind === 'guidedUnpivot');
ok('filter empty query returns all', filterRecipes(setForFilter, {}).length === 4);

// ---------------------------------------------------------------------------
// normalizeColumnNames
// ---------------------------------------------------------------------------
ok('normalize from array of strings', normalizeColumnNames(['a', 'b']).join(',') === 'a,b');
ok('normalize from dataset shape', normalizeColumnNames({ columns: [{ name: 'x' }, { name: 'y' }] }).join(',') === 'x,y');
ok('normalize null -> empty', normalizeColumnNames(null).length === 0);

// ---------------------------------------------------------------------------
// memory store CRUD (async)
// ---------------------------------------------------------------------------
async function storeTests() {
  const store = createMemoryStore();
  ok('empty store lists nothing', (await store.listRecipes()).length === 0);

  await store.putRecipe(rec);
  await store.putRecipe(upRec);
  const list = await store.listRecipes();
  ok('store lists 2 after put', list.length === 2);

  const got = await store.getRecipe(rec.id);
  ok('store get by id', got && got.name === 'Claims cleanup');
  ok('store get missing -> null', (await store.getRecipe('nope')) === null);

  // put with same id overwrites, not duplicates
  const rec2 = Object.assign({}, rec, { name: 'Renamed' });
  await store.putRecipe(rec2);
  ok('store overwrites same id', (await store.listRecipes()).length === 2);
  ok('store reflects overwrite', (await store.getRecipe(rec.id)).name === 'Renamed');

  // stored value is a clone, not a live reference
  got.name = 'MUTATED';
  ok('store returns clones (no aliasing)', (await store.getRecipe(rec.id)).name === 'Renamed');

  const deleted = await store.deleteRecipe(upRec.id);
  ok('store delete returns true', deleted === true);
  ok('store delete missing returns false', (await store.deleteRecipe('nope')) === false);
  ok('store has 1 after delete', (await store.listRecipes()).length === 1);

  await store.clearAll();
  ok('store clearAll empties', (await store.listRecipes()).length === 0);

  await store.putRecipe(rec).catch(() => {});
  const noId = store.putRecipe({ name: 'x' });
  let rejected = false;
  await noId.catch(() => { rejected = true; });
  ok('store put without id rejects', rejected === true);

  // createRepairRecipeStore degrades to a working store in Node (no IDB)
  const auto = createRepairRecipeStore();
  ok('createRepairRecipeStore works in Node', typeof auto.listRecipes === 'function');
  ok('auto store falls back to memory', auto.kind === 'memory');
}

storeTests().then(() => {
  console.log('\nrepair-recipe-library: ' + passed + ' assertions passed');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
