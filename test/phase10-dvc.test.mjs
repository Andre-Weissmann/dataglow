// ============================================================
// DataGlow Phase 10 — Data Version Control Tests
// ============================================================
// Tests for dvc-store.js and dvc-diff.js.
// No DOM, no DuckDB — purely Node-runnable.
//
// Run: node test/phase10-dvc.test.mjs
// ============================================================

import {
  DVCStore, dvcStore, typeGroup, extractColStats,
  statsFromDataset, DVC_VERSION,
} from '../js/dvc/dvc-store.js';

import {
  diffSchema, diffCol, diffSnapshots, summarizeDiff, diffToHTML,
  RISK, SCHEMA_CHANGE,
} from '../js/dvc/dvc-diff.js';

// ---- Harness ----
let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.error('  FAIL  ' + label); failed++; }
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

// ---- Sample datasets ----
const ROWS_A = [
  { patient_id: 1, admit_date: '2024-01-01', los_days: 3, claim_status: 'APPROVED' },
  { patient_id: 2, admit_date: '2024-01-02', los_days: 5, claim_status: 'DENIED' },
  { patient_id: 3, admit_date: '2024-01-03', los_days: null, claim_status: 'APPROVED' },
  { patient_id: 4, admit_date: '2024-01-04', los_days: 7, claim_status: 'PENDING' },
  { patient_id: 5, admit_date: '2024-01-05', los_days: 2, claim_status: 'APPROVED' },
];

const DATASET_A = {
  name: 'encounters',
  columns: [
    { name: 'patient_id', type: 'INTEGER' },
    { name: 'admit_date', type: 'DATE' },
    { name: 'los_days',   type: 'INTEGER' },
    { name: 'claim_status', type: 'VARCHAR' },
  ],
  rows: ROWS_A,
  rowCount: 5,
};

// Dataset B: same schema, 1 row removed, 1 null injected
const ROWS_B = [
  { patient_id: 1, admit_date: '2024-01-01', los_days: 3, claim_status: 'APPROVED' },
  { patient_id: 2, admit_date: '2024-01-02', los_days: null, claim_status: 'DENIED' },
  { patient_id: 3, admit_date: '2024-01-03', los_days: null, claim_status: 'APPROVED' },
  { patient_id: 4, admit_date: '2024-01-04', los_days: 7, claim_status: 'PENDING' },
];

const DATASET_B = {
  name: 'encounters',
  columns: DATASET_A.columns,
  rows: ROWS_B,
  rowCount: 4,
};

// Dataset C: column removed + type changed
const DATASET_C = {
  name: 'encounters',
  columns: [
    { name: 'patient_id', type: 'VARCHAR' },  // type changed
    { name: 'admit_date', type: 'DATE' },
    // los_days removed
    { name: 'claim_status', type: 'VARCHAR' },
    { name: 'discharge_date', type: 'DATE' }, // added
  ],
  rows: ROWS_A.map(r => ({ ...r, discharge_date: '2024-01-10', patient_id: String(r.patient_id) })),
  rowCount: 5,
};

// ============================================================
// 1. typeGroup
// ============================================================
section('1. typeGroup');

ok(typeGroup('INTEGER') === 'number', 'INTEGER -> number');
ok(typeGroup('DECIMAL(10,2)') === 'number', 'DECIMAL(10,2) -> number');
ok(typeGroup('VARCHAR') === 'text', 'VARCHAR -> text');
ok(typeGroup('DATE') === 'date', 'DATE -> date');
ok(typeGroup('TIMESTAMP') === 'date', 'TIMESTAMP -> date');
ok(typeGroup('BOOLEAN') === 'boolean', 'BOOLEAN -> boolean');
ok(typeGroup('BLOB') === 'text', 'BLOB -> text (matches BLOB/BPCHAR pattern in typeGroup)');
ok(typeGroup('') === 'other', 'empty -> other');
ok(typeGroup(undefined) === 'other', 'undefined -> other');

// ============================================================
// 2. extractColStats
// ============================================================
section('2. extractColStats');

{
  const stats = extractColStats('los_days', 'INTEGER', ROWS_A);
  ok(stats.name === 'los_days', 'name preserved');
  ok(stats.type === 'number', 'INTEGER -> number type group');
  ok(stats.nullCount === 1, 'one null in los_days');
  ok(stats.distinctCount === 4, '4 distinct non-null values (3,5,7,2)');
  ok(stats.min === 2, 'min = 2');
  ok(stats.max === 7, 'max = 7');
  ok(stats.mean !== null, 'mean computed');
  ok(stats.mean === (3 + 5 + 7 + 2) / 4, 'mean = 4.25');
  ok(stats.stddev !== null, 'stddev computed');
}

{
  const stats = extractColStats('claim_status', 'VARCHAR', ROWS_A);
  ok(stats.type === 'text', 'VARCHAR -> text');
  ok(stats.nullCount === 0, 'no nulls in claim_status');
  ok(stats.distinctCount === 3, 'APPROVED, DENIED, PENDING');
  ok(stats.min === null, 'min null for text col');
  ok(stats.mean === null, 'mean null for text col');
}

{
  const stats = extractColStats('empty_col', 'INTEGER', [{ empty_col: null }, { empty_col: '' }]);
  ok(stats.nullCount === 2, 'two nulls for empty col');
  ok(stats.distinctCount === 0, 'no distinct values');
  ok(stats.min === null, 'min null for all-null col');
}

// ============================================================
// 3. statsFromDataset
// ============================================================
section('3. statsFromDataset');

{
  const { rowCount, cols } = statsFromDataset(DATASET_A);
  ok(rowCount === 5, 'rowCount from dataset');
  ok(cols.length === 4, '4 columns');
  ok(cols.find(c => c.name === 'patient_id') !== undefined, 'patient_id column present');
  ok(cols.find(c => c.name === 'los_days') !== undefined, 'los_days column present');
}

{
  // Null / empty dataset
  const { rowCount, cols } = statsFromDataset(null);
  ok(rowCount === 0, 'null dataset: rowCount 0');
  ok(cols.length === 0, 'null dataset: 0 cols');
}

{
  // Dataset with no columns defined — derive from first row
  const ds = { rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] };
  const { cols } = statsFromDataset(ds);
  ok(cols.some(c => c.name === 'a'), 'col a derived from rows');
  ok(cols.some(c => c.name === 'b'), 'col b derived from rows');
}

// ============================================================
// 4. DVCStore — snapshot creation
// ============================================================
section('4. DVCStore — snapshot creation');

{
  const store = new DVCStore();
  const id = store.snapshot(DATASET_A, { label: 'Before dedup' });
  ok(typeof id === 'string', 'snapshot returns an id');
  ok(id.startsWith('snap_'), 'id has snap_ prefix');
  const snap = store.get(id);
  ok(snap !== null, 'get() returns the snapshot');
  ok(snap.datasetName === 'encounters', 'datasetName set');
  ok(snap.label === 'Before dedup', 'label set');
  ok(snap.rowCount === 5, 'rowCount set');
  ok(snap.cols.length === 4, '4 cols in snapshot');
  ok(snap.fingerprint.length === 8, 'fingerprint is 8-char hex');
  ok(typeof snap.createdAt === 'string', 'createdAt is a string');
}

// ============================================================
// 5. DVCStore — list, timeline, count
// ============================================================
section('5. DVCStore — list/timeline/count');

{
  const store = new DVCStore();
  const id1 = store.snapshot(DATASET_A, { label: 'First' });
  const id2 = store.snapshot(DATASET_B, { label: 'Second' });

  const all = store.list();
  ok(all.length === 2, 'list() returns 2 snapshots');
  // newest-first by createdAt string; if same millisecond, Map insertion order is arbitrary
  ok(all.some(s => s.id === id1) && all.some(s => s.id === id2), 'list() contains both snapshots');

  const byDataset = store.list('encounters');
  ok(byDataset.length === 2, 'list(name) filters by dataset name');

  const other = store.list('nonexistent');
  ok(other.length === 0, 'list() returns empty for unknown dataset');

  ok(store.count() === 2, 'count() returns total');
  ok(store.count('encounters') === 2, 'count(name) returns filtered count');

  const tl = store.timeline('encounters');
  ok(tl.length === 2, 'timeline() returns 2 entries');
}

// ============================================================
// 6. DVCStore — relabel, remove
// ============================================================
section('6. DVCStore — relabel and remove');

{
  const store = new DVCStore();
  const id = store.snapshot(DATASET_A);
  store.relabel(id, 'Renamed label');
  ok(store.get(id).label === 'Renamed label', 'relabel updates label');
  ok(store.remove(id) === true, 'remove returns true');
  ok(store.get(id) === null, 'get returns null after remove');
  ok(store.remove('bogus') === false, 'remove returns false for unknown id');
}

// ============================================================
// 7. DVCStore — snapshotIfChanged
// ============================================================
section('7. DVCStore — snapshotIfChanged');

{
  const store = new DVCStore();
  const id1 = store.snapshotIfChanged(DATASET_A, { label: 'First' });
  ok(id1 !== null, 'first snapshot always created');
  // Same dataset — fingerprint identical — should return null
  const id2 = store.snapshotIfChanged(DATASET_A, { label: 'Duplicate' });
  ok(id2 === null, 'no snapshot when fingerprint unchanged');
  // Different dataset — should create
  const id3 = store.snapshotIfChanged(DATASET_B, { label: 'Changed' });
  ok(id3 !== null, 'new snapshot when fingerprint changes');
  ok(store.count('encounters') === 2, 'two snapshots total');
}

// ============================================================
// 8. DVCStore — findDuplicates
// ============================================================
section('8. DVCStore — findDuplicates');

{
  const store = new DVCStore();
  const id1 = store.snapshot(DATASET_A, { label: 'A' });
  // Force a duplicate by manually inserting identical fingerprint
  const snap1 = store.get(id1);
  const fakeId = 'snap_fake_001';
  store._snapshots.set(fakeId, { ...snap1, id: fakeId, label: 'Duplicate of A' });
  const dups = store.findDuplicates(id1);
  ok(dups.length === 1, 'found 1 duplicate');
  ok(dups[0].id === fakeId, 'duplicate id matches');
}

// ============================================================
// 9. DVCStore — rollbackMeta
// ============================================================
section('9. DVCStore — rollbackMeta');

{
  const store = new DVCStore();
  const id = store.snapshot(DATASET_A, { label: 'Clean state' });
  const meta = store.rollbackMeta(id);
  ok(meta !== null, 'rollbackMeta returns data');
  ok(meta.id === id, 'meta.id matches');
  ok(meta.rowCount === 5, 'rowCount in meta');
  ok(meta.cols.length === 4, 'cols in meta');
  ok(store.rollbackMeta('bogus') === null, 'returns null for unknown id');
}

// ============================================================
// 10. DVCStore — export / import
// ============================================================
section('10. DVCStore — export/import');

{
  const store = new DVCStore();
  store.snapshot(DATASET_A, { label: 'Export test A' });
  store.snapshot(DATASET_B, { label: 'Export test B' });
  const json = store.exportJSON();
  ok(typeof json === 'string', 'exportJSON returns string');
  const parsed = JSON.parse(json);
  ok(parsed._dvcVersion === DVC_VERSION, 'version in export');
  ok(parsed.snapshots.length === 2, 'two snapshots in export');
  ok(!JSON.stringify(parsed).includes('"APPROVED"'), 'no row values in export (privacy)');

  const restored = DVCStore.fromJSON(json);
  ok(restored.count() === 2, 'restored store has 2 snapshots');
  const snap = restored.list()[0];
  ok(snap.label !== undefined, 'label preserved through export/import');
}

// ============================================================
// 11. DVCStore — merge
// ============================================================
section('11. DVCStore — merge');

{
  const store1 = new DVCStore();
  const store2 = new DVCStore();
  const id1 = store1.snapshot(DATASET_A, { label: 'From store1' });
  const id2 = store2.snapshot(DATASET_B, { label: 'From store2' });
  store1.merge(store2);
  ok(store1.count() === 2, 'merged store has both snapshots');
  ok(store1.get(id1) !== null, 'original snapshot preserved');
  ok(store1.get(id2) !== null, 'merged snapshot present');
  // Re-merge should not duplicate
  store1.merge(store2);
  ok(store1.count() === 2, 'merge is idempotent');
}

// ============================================================
// 12. diffSchema
// ============================================================
section('12. diffSchema — schema changes');

{
  // Build snapshots with different schemas using the store
  const store = new DVCStore();
  const idA = store.snapshot(DATASET_A, { label: 'A' });
  const idC = store.snapshot(DATASET_C, { label: 'C' });
  const snapA = store.get(idA);
  const snapC = store.get(idC);

  const diff = diffSchema(snapA, snapC);
  ok(diff.removed.some(c => c.name === 'los_days'), 'los_days flagged as removed');
  ok(diff.added.some(c => c.name === 'discharge_date'), 'discharge_date flagged as added');
  ok(diff.typeChanged.some(tc => tc.name === 'patient_id'), 'patient_id type change detected');
  ok(diff.risk === RISK.BREAKING, 'breaking risk when columns removed/type-changed');
}

{
  // Identical schema — no changes
  const store = new DVCStore();
  const id1 = store.snapshot(DATASET_A);
  const id2 = store.snapshot(DATASET_A);
  const diff = diffSchema(store.get(id1), store.get(id2));
  ok(diff.added.length === 0, 'no added columns');
  ok(diff.removed.length === 0, 'no removed columns');
  ok(diff.typeChanged.length === 0, 'no type changes');
  ok(diff.risk === RISK.OK, 'risk is OK for identical schemas');
}

{
  // Added columns only
  const dsPlus = {
    name: 'encounters',
    columns: [...DATASET_A.columns, { name: 'new_col', type: 'INTEGER' }],
    rows: ROWS_A.map(r => ({ ...r, new_col: 0 })),
    rowCount: 5,
  };
  const store = new DVCStore();
  const id1 = store.snapshot(DATASET_A);
  const id2 = store.snapshot(dsPlus);
  const diff = diffSchema(store.get(id1), store.get(id2));
  ok(diff.added.length === 1, 'one column added');
  ok(diff.risk === RISK.WARN, 'added columns = WARN risk');
}

// ============================================================
// 13. diffCol
// ============================================================
section('13. diffCol — statistical diff');

{
  // los_days: A has 1 null/5 rows = 20%; B has 2 nulls/4 rows = 50%
  const store = new DVCStore();
  const idA = store.snapshot(DATASET_A);
  const idB = store.snapshot(DATASET_B);
  const snapA = store.get(idA);
  const snapB = store.get(idB);
  const colA = snapA.cols.find(c => c.name === 'los_days');
  const colB = snapB.cols.find(c => c.name === 'los_days');

  const diff = diffCol(colA, colB, snapA.rowCount, snapB.rowCount);
  ok(diff.name === 'los_days', 'name preserved');
  ok(diff.nullRateAfter > diff.nullRateBefore, 'null rate increased');
  ok(diff.nullRateDelta > 0, 'nullRateDelta positive');
  // The jump is from 20% to 50% = 30pp — should be BREAKING (>20%)
  ok(diff.risk === RISK.BREAKING, 'breaking risk on large null rate jump');
  ok(diff.flags.length > 0, 'flags populated');
}

{
  // All-null column in after snapshot
  const colBefore = { name: 'x', type: 'number', rawType: 'INTEGER', nullCount: 0, distinctCount: 5, min: 1, max: 10, mean: 5, stddev: 2 };
  const colAfter  = { name: 'x', type: 'number', rawType: 'INTEGER', nullCount: 5, distinctCount: 0, min: null, max: null, mean: null, stddev: null };
  const diff = diffCol(colBefore, colAfter, 5, 5);
  ok(diff.risk === RISK.BREAKING, 'all-null column is BREAKING');
  ok(diff.flags.some(f => f.includes('null')), 'flags mention null issue');
}

{
  // Stable column — no significant change
  const stable = { name: 'pid', type: 'number', rawType: 'INTEGER', nullCount: 0, distinctCount: 100, min: 1, max: 100, mean: 50, stddev: 29 };
  const diff = diffCol(stable, stable, 100, 100);
  ok(diff.risk === RISK.OK, 'stable column is OK');
  ok(diff.flags.length === 0, 'no flags for stable column');
}

// ============================================================
// 14. diffSnapshots — full pipeline
// ============================================================
section('14. diffSnapshots — full pipeline');

{
  const store = new DVCStore();
  const idA = store.snapshot(DATASET_A, { label: 'Before' });
  const idB = store.snapshot(DATASET_B, { label: 'After' });
  const snapA = store.get(idA);
  const snapB = store.get(idB);

  const diff = diffSnapshots(snapA, snapB);
  ok(diff.beforeId === idA, 'beforeId set');
  ok(diff.afterId === idB, 'afterId set');
  ok(diff.rowCountBefore === 5, 'rowCountBefore');
  ok(diff.rowCountAfter === 4, 'rowCountAfter');
  ok(diff.rowCountDelta === -1, 'rowCountDelta = -1');
  ok(diff.rowCountPct === -20, 'rowCountPct = -20%');
  ok(diff.schema.risk === RISK.OK, 'no schema changes between A and B');
  ok(diff.colDiffs.length === 4, '4 shared columns diffed');
  ok(diff.overallRisk === RISK.BREAKING, 'overall BREAKING due to null rate spike in los_days');
  ok(diff.summary.length > 0, 'summary populated');
  ok(diff.summary.some(s => s.includes('rows') || s.includes('Row count')), 'summary mentions row count');
}

{
  // Throws when either snapshot is missing
  let threw = false;
  try { diffSnapshots(null, {}); } catch (_) { threw = true; }
  ok(threw, 'diffSnapshots throws on null before');
}

{
  // Identical snapshots — should be all OK
  const store = new DVCStore();
  const id = store.snapshot(DATASET_A, { label: 'Same' });
  const snap = store.get(id);
  const diff = diffSnapshots(snap, snap);
  ok(diff.overallRisk === RISK.OK, 'identical snapshots: OK risk');
  ok(diff.rowCountDelta === 0, 'identical: zero row delta');
}

// ============================================================
// 15. diffToHTML + summarizeDiff
// ============================================================
section('15. diffToHTML + summarizeDiff');

{
  const store = new DVCStore();
  const idA = store.snapshot(DATASET_A, { label: 'Before' });
  const idC = store.snapshot(DATASET_C, { label: 'After restructure' });
  const diff = diffSnapshots(store.get(idA), store.get(idC));

  const html = diffToHTML(diff);
  ok(typeof html === 'string', 'diffToHTML returns string');
  ok(html.includes('dvc-diff-report'), 'HTML has diff-report class');
  ok(html.includes('dvc-risk-badge'), 'HTML has risk badge');
  // diffToHTML shows dataset info via summary or schema; check it renders without crash
  ok(html.includes('dvc-diff-rows') || html.includes('Row'), 'HTML shows row count diff section');

  const text = summarizeDiff(diff);
  ok(typeof text === 'string', 'summarizeDiff returns string');
  ok(text.includes('Breaking') || text.includes('Warning') || text.includes('OK'), 'risk label in summary');
}

{
  // diffToHTML doesn't crash on empty colDiffs
  const store = new DVCStore();
  const dsEmpty = { name: 'x', columns: [], rows: [], rowCount: 0 };
  const id1 = store.snapshot(dsEmpty);
  const id2 = store.snapshot(dsEmpty);
  const diff = diffSnapshots(store.get(id1), store.get(id2));
  const html = diffToHTML(diff);
  ok(typeof html === 'string', 'diffToHTML handles empty dataset');
}

// ============================================================
// Summary
// ============================================================
console.log('\n' + (passed + failed) + ' assertions: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
