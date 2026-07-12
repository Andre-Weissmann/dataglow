// ============================================================
// DATAGLOW — Object Space Registry test suite (Polyglot Workbench, Batch B)
// ============================================================
// Proves js/app-shell/object-space.js is an honest, PURE in-memory read model
// for named cross-language objects:
//   - register/get/list/getSchema/unregister/clear round-trip
//   - objects from all three origin languages (sql/python/r)
//   - schema retrieval returns a defensive {name,type} copy
//   - re-registering the same NAME updates in place (never duplicates), and
//     keeps the original createdAt
//   - unknown originLanguage/kind fall back to safe defaults rather than throwing
//   - the shared app singleton (registerObject/listObjectSpace) stays in sync
//
// RUN WITH: node test/object-space.test.mjs (pure logic, no DuckDB/Pyodide/WebR)

import {
  createObjectSpace,
  registerObject,
  listObjectSpace,
  getAppObjectSpace,
  ORIGIN_LANGUAGES,
  OBJECT_KINDS,
} from '../js/app-shell/object-space.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // --- exported vocab is the documented closed set ---
  ok(JSON.stringify(ORIGIN_LANGUAGES) === JSON.stringify(['sql', 'python', 'r']),
    'ORIGIN_LANGUAGES is exactly sql/python/r');
  ok(JSON.stringify(OBJECT_KINDS) === JSON.stringify(['dataframe', 'model', 'scalar']),
    'OBJECT_KINDS is exactly dataframe/model/scalar');

  // --- register + get round-trip, all three origin languages ---
  {
    const os = createObjectSpace();
    os.register({ name: 'sales', originLanguage: 'sql', kind: 'dataframe', schema: [{ name: 'amount', type: 'DOUBLE' }], rowCount: 100 });
    os.register({ name: 'py:sales_df', originLanguage: 'python', kind: 'dataframe', schema: [{ name: 'amount', type: 'float64' }], rowCount: 100 });
    os.register({ name: 'r:fit', originLanguage: 'r', kind: 'model', rowCount: null });

    ok(os.size === 3, `three distinct objects registered (got ${os.size})`);

    const sql = os.get('sales');
    ok(sql && sql.originLanguage === 'sql', 'sql object stored with sql origin');
    ok(sql.kind === 'dataframe' && sql.rowCount === 100, 'sql object keeps kind + rowCount');

    const py = os.get('py:sales_df');
    ok(py && py.originLanguage === 'python', 'python object stored with python origin');

    const r = os.get('r:fit');
    ok(r && r.originLanguage === 'r', 'r object stored with r origin');
    ok(r.kind === 'model', 'non-tabular r object recorded by kind only (model)');
    ok(r.rowCount === null, 'model object has null rowCount, not a fabricated number');

    ok(os.get('does-not-exist') === null, 'get() of an unknown name returns null, does not throw');
  }

  // --- list() reflects everything and returns copies (no aliasing) ---
  {
    const os = createObjectSpace();
    os.register({ name: 'a', originLanguage: 'sql', schema: [{ name: 'x', type: 'INT' }], rowCount: 1 });
    os.register({ name: 'b', originLanguage: 'python', schema: [], rowCount: 2 });
    const listed = os.list();
    ok(listed.length === 2, `list() returns all registered objects (got ${listed.length})`);
    listed[0].name = 'MUTATED';
    ok(os.get('a') !== null, 'mutating a list() result does not corrupt the registry (defensive copy)');
  }

  // --- getSchema returns a defensive {name,type} copy ---
  {
    const os = createObjectSpace();
    os.register({ name: 'orders', originLanguage: 'sql', schema: [{ name: 'id', type: 'INT' }, { name: 'ts', type: 'DATE' }], rowCount: 5 });
    const schema = os.getSchema('orders');
    ok(Array.isArray(schema) && schema.length === 2, 'getSchema returns the two-column schema');
    ok(schema[0].name === 'id' && schema[0].type === 'INT', 'getSchema carries {name,type}');
    schema.push({ name: 'evil', type: 'X' });
    ok(os.getSchema('orders').length === 2, 'mutating a getSchema result does not corrupt stored schema');
    ok(os.getSchema('missing') === null, 'getSchema of unknown name returns null');
  }

  // --- EDGE CASE: re-registering the same NAME updates, never duplicates ---
  {
    const os = createObjectSpace();
    const first = os.register({ name: 'sales', originLanguage: 'sql', schema: [{ name: 'amount', type: 'DOUBLE' }], rowCount: 100 });
    ok(os.size === 1, 'one object after first register');
    // simulate the object growing on a later run
    const second = os.register({ name: 'sales', originLanguage: 'sql', schema: [{ name: 'amount', type: 'DOUBLE' }, { name: 'region', type: 'VARCHAR' }], rowCount: 250 });
    ok(os.size === 1, `re-register of same name does NOT duplicate (size still 1, got ${os.size})`);
    ok(os.get('sales').rowCount === 250, 'updated fields (rowCount) take effect on re-register');
    ok(os.getSchema('sales').length === 2, 'updated schema takes effect on re-register');
    ok(second.createdAt === first.createdAt, 'createdAt is preserved (first-seen time) across an update');
  }

  // --- unregister + clear ---
  {
    const os = createObjectSpace();
    os.register({ name: 'a', originLanguage: 'sql', rowCount: 1 });
    os.register({ name: 'b', originLanguage: 'r', kind: 'scalar' });
    ok(os.unregister('a') === true, 'unregister returns true for a present name');
    ok(os.get('a') === null && os.size === 1, 'unregister removes exactly that object');
    ok(os.unregister('a') === false, 'unregister of an already-gone name returns false');
    os.clear();
    ok(os.size === 0 && os.list().length === 0, 'clear empties the whole registry');
  }

  // --- robustness: unknown origin/kind fall back safely, empty name throws ---
  {
    const os = createObjectSpace();
    const e = os.register({ name: 'weird', originLanguage: 'cobol', kind: 'blob', schema: [{ name: 'c', type: 'X' }] });
    ok(e.originLanguage === 'sql', 'unknown originLanguage falls back to sql (safe default), no throw');
    ok(e.kind === 'dataframe', 'unknown kind with a schema falls back to dataframe');
    const scalar = os.register({ name: 'n', originLanguage: 'python', kind: '???' });
    ok(scalar.kind === 'scalar', 'unknown kind with no schema falls back to scalar');
    let threw = false;
    try { os.register({ originLanguage: 'sql' }); } catch (_) { threw = true; }
    ok(threw, 'register() without a name throws (a name is required)');
  }

  // --- shared app singleton: registerObject/listObjectSpace stay in sync ---
  {
    const app = getAppObjectSpace();
    app.clear();
    registerObject({ name: 'sales', originLanguage: 'sql', schema: [{ name: 'amount', type: 'DOUBLE' }], rowCount: 42 });
    registerObject({ name: 'py:sales', originLanguage: 'python', schema: [{ name: 'amount', type: 'float64' }], rowCount: 42 });
    const listed = listObjectSpace();
    ok(listed.length === 2, `app singleton lists both registered objects (got ${listed.length})`);
    const names = listed.map(o => o.name).sort();
    ok(JSON.stringify(names) === JSON.stringify(['py:sales', 'sales']), 'app singleton holds both origin-qualified names');
    app.clear();
    ok(listObjectSpace().length === 0, 'clearing the app singleton empties listObjectSpace()');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
