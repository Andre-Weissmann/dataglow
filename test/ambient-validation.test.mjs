// ============================================================
// DATAGLOW — Ambient Validation worker logic tests
// ============================================================
// Exercises the pure check functions inside js/ambient-validation.worker.js
// directly, without spinning up an actual Web Worker (the worker wiring is
// guarded to only activate inside a real WorkerGlobalScope). This is the
// deterministic, framework-free way to cover the live-typing checks.
//
// RUN WITH:  node test/ambient-validation.test.mjs

import {
  extractGroupByColumns,
  checkSensitiveGrouping,
  checkCrossColumnLogic,
  checkSanityAnchor,
  runAmbientChecks,
} from '../js/ambient-validation.worker.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
const hasId = (ws, id) => ws.some(w => w.id === id);

// ---------- GROUP BY extraction ----------
ok(JSON.stringify(extractGroupByColumns('SELECT race, COUNT(*) FROM t GROUP BY race')) === '["race"]',
  'extractGroupByColumns: single bare column');
ok(JSON.stringify(extractGroupByColumns('SELECT * FROM t GROUP BY t.race, "insurance" ORDER BY 1')) === '["race","insurance"]',
  'extractGroupByColumns: dotted + quoted, stops at ORDER BY');
ok(extractGroupByColumns('SELECT * FROM t GROUP BY 1, 2').length === 0,
  'extractGroupByColumns: positional references are ignored');
ok(extractGroupByColumns('SELECT * FROM t WHERE x=1').length === 0,
  'extractGroupByColumns: no GROUP BY → empty');

// ---------- Check 1: sensitive-category grouping ----------
{
  const ws = checkSensitiveGrouping('SELECT race, COUNT(*) FROM patients GROUP BY race',
    { columns: [{ name: 'race' }, { name: 'age' }] });
  ok(hasId(ws, 'sensitive_grouping') && ws[0].column === 'race',
    'sensitive grouping: GROUP BY race on a known schema is flagged');
  ok(/protected column/i.test(ws[0].message) && /race/.test(ws[0].message),
    'sensitive grouping: message names the protected column');
}
{
  const ws = checkSensitiveGrouping('SELECT admission_type, COUNT(*) FROM t GROUP BY admission_type',
    { columns: [{ name: 'admission_type' }] });
  ok(ws.length === 0, 'sensitive grouping: a non-sensitive GROUP BY is NOT flagged');
}
{
  // No schema supplied → fall back to name-based matching so the check still works.
  const ws = checkSensitiveGrouping('SELECT ethnicity, COUNT(*) FROM t GROUP BY ethnicity');
  ok(hasId(ws, 'sensitive_grouping'), 'sensitive grouping: works without a schema via name matching');
}
{
  // Known schema that does NOT contain the grouped token → not flagged (avoids
  // false positives on aliases/expressions).
  const ws = checkSensitiveGrouping('SELECT race_bucket FROM t GROUP BY race_bucket',
    { columns: [{ name: 'race' }] });
  ok(ws.length === 0, 'sensitive grouping: grouped alias not in schema is not flagged');
}
{
  const ws = checkSensitiveGrouping("SELECT SUBSTR(race,1,1) AS r FROM t GROUP BY 1",
    { columns: [{ name: 'race' }] });
  ok(hasId(ws, 'sensitive_transform'),
    'sensitive transform: SUBSTR() over a protected column is flagged as a merge risk');
}

// ---------- Check 2: cross-column logical consistency ----------
{
  const ws = checkCrossColumnLogic('SELECT * FROM t WHERE discharge_date < admit_date');
  ok(hasId(ws, 'cross_column_logic'),
    'cross-column: end(discharge) < start(admit) filter is flagged');
}
{
  const ws = checkCrossColumnLogic('SELECT * FROM t WHERE max_temp < min_temp');
  ok(hasId(ws, 'cross_column_logic'), 'cross-column: max < min filter is flagged');
}
{
  const ws = checkCrossColumnLogic('SELECT * FROM t WHERE admit_date < discharge_date');
  ok(ws.length === 0, 'cross-column: a sensible start < end filter is NOT flagged');
}
{
  const ws = checkCrossColumnLogic('SELECT * FROM t WHERE amount < 100');
  ok(ws.length === 0, 'cross-column: comparison against a literal is not a cross-column issue');
}

// ---------- Check 3: Sanity Anchor (aggregation × join) ----------
{
  const ws = checkSanityAnchor('SELECT SUM(amount) FROM orders o JOIN items i ON o.id=i.order_id');
  ok(hasId(ws, 'sanity_anchor'), 'sanity anchor: SUM across a JOIN without DISTINCT is flagged');
}
{
  const ws = checkSanityAnchor('SELECT SUM(amount) FROM orders');
  ok(ws.length === 0, 'sanity anchor: aggregation without a JOIN is fine');
}
{
  const ws = checkSanityAnchor('SELECT COUNT(DISTINCT o.id) FROM orders o JOIN items i ON o.id=i.order_id');
  ok(ws.length === 0, 'sanity anchor: COUNT(DISTINCT ...) across a JOIN is not flagged');
}

// ---------- Robustness: literals & comments must not create false hits ----------
{
  const ws = runAmbientChecks("SELECT 'group by race' AS label FROM t -- group by race\n WHERE x=1");
  ok(ws.length === 0, 'robustness: keywords inside string literals / comments are ignored');
}
{
  ok(runAmbientChecks('').length === 0, 'robustness: empty query yields no warnings');
  ok(runAmbientChecks('   ').length === 0, 'robustness: whitespace-only query yields no warnings');
}

// ---------- De-duplication ----------
{
  const ws = runAmbientChecks('SELECT race FROM t GROUP BY race, race',
    { columns: [{ name: 'race' }] });
  ok(ws.filter(w => w.id === 'sensitive_grouping').length === 1,
    'de-dupe: a column grouped twice produces a single warning');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
