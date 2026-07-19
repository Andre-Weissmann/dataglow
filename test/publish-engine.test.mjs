// ============================================================
// DATAGLOW — Publish Engine (PR AG)
// ============================================================
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Stub browser APIs needed by publish-engine
const ctx = {
  window: { location: { origin: 'https://dataglow-platform.pplx.app', pathname: '/index.html' } },
  CompressionStream: undefined,    // test without compression too
  DecompressionStream: undefined,
  TextEncoder: TextEncoder,
  TextDecoder: TextDecoder,
  btoa: btoa,
  atob: atob,
};
createContext(ctx);

// Stub InstantInsight so publish-engine can call it
ctx.InstantInsight = { analyze: function() { return { sentence: 'Test insight.', type: 'default' }; } };

const src = readFileSync('./js/publish/publish-engine.js', 'utf8')
  .replace(/^export\s+/gm, '');
runInContext(src, ctx);
const PE = ctx.PublishEngine;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.error(`✗ FAILED: ${msg}`); }
}

function makeDataset(cols, rows) {
  return { columns: cols, rows: rows, findings: [], columnHealth: [], name: 'test.csv', format: 'csv' };
}

// 1. canPublish — empty
ok(!PE.canPublish(null), 'canPublish(null) = false');
ok(!PE.canPublish(makeDataset([], [])), 'canPublish(empty) = false');

// 2. canPublish — valid
ok(PE.canPublish(makeDataset(['a','b'], [{a:1,b:2}])), 'canPublish(valid) = true');

// 3. buildSnapshot returns expected shape
const ds = makeDataset(['id','amount','status'], Array.from({length:50}, (_,i) => ({id:i, amount:i*10, status: i%2===0 ? 'OK' : 'Err'})));
const result = await PE.buildSnapshot(ds, { title: 'My Test' });
ok(typeof result.url === 'string' && result.url.includes('#share='), 'buildSnapshot returns URL with #share=');
ok(result.rowCount > 0, 'buildSnapshot rowCount > 0');
ok(result.colCount === 3, 'buildSnapshot colCount = 3');
ok(typeof result.sizeKb === 'number' && result.sizeKb > 0, 'buildSnapshot sizeKb > 0');
ok(result.title === 'My Test', 'buildSnapshot title preserved');

// 4. decodeSnapshot round-trips
const fragment = result.url.split('#')[1];
const decoded = await PE.decodeSnapshot('#' + fragment);
ok(decoded !== null, 'decodeSnapshot returns non-null');
ok(decoded.columns.length === 3, 'decoded columns match');
ok(decoded.rows.length === 50, 'decoded rows match');
ok(decoded.title === 'My Test', 'decoded title matches');
ok(decoded.insight === 'Test insight.', 'decoded insight matches');

// 5. decodeSnapshot with bad input
const bad = await PE.decodeSnapshot('#share=notvalidbase64!!!');
ok(bad === null, 'decodeSnapshot(bad) = null');

// 6. Row cap
const bigDs = makeDataset(['x'], Array.from({length:5000}, (_,i) => ({x:i})));
const bigResult = await PE.buildSnapshot(bigDs, {});
ok(bigResult.rowCount <= PE.SNAPSHOT_ROW_LIMIT, 'row cap enforced at SNAPSHOT_ROW_LIMIT');
ok(bigResult.totalRows === 5000, 'totalRows reflects full dataset');

// 7. SNAPSHOT_ROW_LIMIT is defined
ok(typeof PE.SNAPSHOT_ROW_LIMIT === 'number' && PE.SNAPSHOT_ROW_LIMIT > 0, 'SNAPSHOT_ROW_LIMIT defined');

// 8. No title fallback to dataset name
const noTitle = await PE.buildSnapshot(ds, {});
ok(noTitle.title === 'test.csv', 'no title falls back to dataset name');

console.log(`\n${passed+failed} assertions — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
