import assert from 'assert';
import {
  profileColumnLocal,
  profileAllLocal,
  qualityScoreLocal,
  COLUMN_PROFILER_LOCAL_VERSION
} from '../js/intelligence/column-profiler-local.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed++;
}

console.log('column-profiler-local');
ok('version', COLUMN_PROFILER_LOCAL_VERSION === 1);

const ds = {
  columns: [
    { name: 'patient_id', type: 'INT' },
    { name: 'dept', type: 'STR' },
    { name: 'unnamed_3', type: 'STR' }
  ],
  rows: [
    [1, 'ER', 'a'],
    [2, 'ER', 'b'],
    [3, null, 'c'],
    [4, 'ICU', 'd'],
    [5, 'ICU', null]
  ]
};

const p0 = profileColumnLocal(ds, 0);
ok('id name', p0.name === 'patient_id');
ok('id card', p0.cardinality === 5);
ok('id nulls 0', p0.nullRate === 0);
ok('id min max', p0.min === 1 && p0.max === 5);
ok('id quality high', p0.quality >= 80);

const p1 = profileColumnLocal(ds, 1);
ok('dept nulls', Math.abs(p1.nullRate - 0.2) < 0.001);
ok('dept card', p1.cardinality === 2);
ok('dept top ER', p1.topValues[0].value === 'ER' || p1.topValues[0].value === 'ICU');

const bad = qualityScoreLocal({ name: 'col1', type: 'STR', nullRate: 0.5, cardinality: 1, rowCount: 10 });
ok('quality penalizes nulls+const+badname', bad < 70);

const all = profileAllLocal(ds);
ok('all 3', all.length === 3);

// array row contract
const pArr = profileColumnLocal({ columns: [{ name: 'x', type: 'FLOAT' }], rows: [[1.5], [2.5], [null]] }, 0);
ok('array rows', pArr.cardinality === 2 && Math.abs(pArr.nullRate - 1/3) < 0.01);

console.log('\n' + passed + ' passed, 0 failed');
