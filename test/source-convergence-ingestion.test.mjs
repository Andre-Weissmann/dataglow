// ============================================================
// DATAGLOW — Tests: Source Convergence Ingestion Adapters (Batch 2 of 3)
// ============================================================
// Plain node, no DOM/XLSX/network needed — js/validation/source-convergence-ingestion.js
// is pure JS over already-parsed data (rows/sheets/JSON), exactly like the Batch 1
// engine test (test/source-convergence.test.mjs). Covers: a multi-tab Excel
// workbook fanning out to one source per tab with correctly inferred keys, the API
// adapter on both a bare array and a wrapped { data: [...] } object, a site export
// reusing the shared helper, inferJoinKeys on unrecognizable columns, the trust
// defaults, the never-throws contract on all adapters, and — most importantly — an
// END-TO-END integration test that feeds adaptExcelWorkbook output straight through
// Batch 1's buildConvergenceGraph/computeConvergenceClusters/resolveClusterWithTrust
// to prove the shapes are actually compatible.
//
// RUN WITH:  node test/source-convergence-ingestion.test.mjs

import assert from 'node:assert/strict';
import {
  adaptExcelWorkbook,
  adaptApiSource,
  adaptSiteExport,
  inferJoinKeys,
  assignDefaultTrust,
  toEngineSources,
} from '../js/validation/source-convergence-ingestion.js';
import {
  buildConvergenceGraph,
  computeConvergenceClusters,
  resolveClusterWithTrust,
  summarizeConvergence,
} from '../js/validation/source-convergence.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ---- inferJoinKeys ----

test('inferJoinKeys: finds single-column *_id / bare id keys, preserving casing', () => {
  const keys = inferJoinKeys([{ Claim_ID: 'C1', member_no: 'M1', amount: 10 }]);
  assert.deepEqual(keys, ['Claim_ID', 'member_no']);
});

test('inferJoinKeys: emits a composite when both member columns exist', () => {
  const keys = inferJoinKeys([{ patient_id: 'P1', date_of_service: '2026-01-01', elig: 'Y' }]);
  // patient_id (single) + the [patient_id, date_of_service] composite.
  assert.ok(keys.includes('patient_id'));
  assert.ok(keys.some(k => Array.isArray(k) && k.join('+') === 'patient_id+date_of_service'));
});

test('inferJoinKeys: no recognizable key -> [] (never throws)', () => {
  assert.deepEqual(inferJoinKeys([{ name: 'Alice', color: 'red' }]), []);
});

test('inferJoinKeys: malformed / empty input -> [] (never throws)', () => {
  for (const bad of [undefined, null, 'x', 42, [], [1, 2, 3], [null], {}]) {
    let k;
    assert.doesNotThrow(() => { k = inferJoinKeys(bad); });
    assert.deepEqual(k, []);
  }
});

// ---- assignDefaultTrust ----

test('assignDefaultTrust: upload/excel > api > site, all within 0.65-0.92', () => {
  const excel = assignDefaultTrust({ kind: 'excel' });
  const api = assignDefaultTrust({ kind: 'api' });
  const site = assignDefaultTrust({ kind: 'site' });
  assert.ok(excel > api && api > site, 'excel > api > site');
  for (const t of [excel, api, site]) assert.ok(t >= 0.65 && t <= 0.92, `${t} in mockup spread`);
});

test('assignDefaultTrust: explicit caller trust wins and is clamped to [0,1]', () => {
  assert.equal(assignDefaultTrust({ kind: 'site', trust: 0.99 }), 0.99);
  assert.equal(assignDefaultTrust({ kind: 'excel', trust: 5 }), 1);
  assert.equal(assignDefaultTrust({ kind: 'excel', trust: -1 }), 0);
});

test('assignDefaultTrust: unknown/malformed meta -> finite fallback (never throws)', () => {
  for (const bad of [undefined, null, 'x', 42, {}, { kind: 'mystery' }]) {
    let t;
    assert.doesNotThrow(() => { t = assignDefaultTrust(bad); });
    assert.ok(Number.isFinite(t) && t >= 0 && t <= 1);
  }
});

// ---- adaptExcelWorkbook: one source per tab ----

const rosterWorkbook = [
  { sheetName: 'Providers', rows: [{ npi: 'N1', name: 'Dr A' }, { npi: 'N2', name: 'Dr B' }] },
  { sheetName: 'Adjustments', rows: [{ claim_id: 'C1', npi: 'N1', allowed_amt: '412.00' }] },
];

test('adaptExcelWorkbook: one source per sheet, id like "Roster → Providers"', () => {
  const sources = adaptExcelWorkbook(rosterWorkbook, { fileName: 'Roster.xlsx' });
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map(s => s.id), ['Roster → Providers', 'Roster → Adjustments']);
  assert.equal(sources[0].meta.kind, 'excel');
  assert.equal(sources[0].meta.sheetName, 'Providers');
  assert.equal(sources[0].meta.rowCount, 2);
});

test('adaptExcelWorkbook: infers per-tab keys independently', () => {
  const [providers, adjustments] = adaptExcelWorkbook(rosterWorkbook, { fileName: 'Roster.xlsx' });
  assert.deepEqual(providers.possibleKeys, ['npi']);
  assert.deepEqual(adjustments.possibleKeys, ['claim_id', 'npi']);
  assert.equal(providers.meta.needsManualKeySelection, false);
});

test('adaptExcelWorkbook: a keyless tab flags needsManualKeySelection but still yields a source', () => {
  const [s] = adaptExcelWorkbook([{ sheetName: 'Notes', rows: [{ note: 'hi', color: 'red' }] }]);
  assert.deepEqual(s.possibleKeys, []);
  assert.equal(s.meta.needsManualKeySelection, true);
  assert.equal(s.meta.ok, true);
});

test('adaptExcelWorkbook: blank/invalid tab is an error-flagged (ok:false) placeholder, not a throw', () => {
  const sources = adaptExcelWorkbook([
    { sheetName: 'Good', rows: [{ id: 1 }] },
    { sheetName: 'Empty', rows: [] },
    { sheetName: 'Bad', rows: 'not-rows' },
  ], { fileName: 'x.xlsx' });
  assert.equal(sources.length, 3);
  assert.equal(sources[0].meta.ok, true);
  assert.equal(sources[1].meta.ok, false);
  assert.equal(sources[2].meta.ok, false);
  assert.match(sources[1].meta.reason, /no usable rows/);
});

test('adaptExcelWorkbook: duplicate sheet names get disambiguated ids', () => {
  const sources = adaptExcelWorkbook([
    { sheetName: 'Data', rows: [{ id: 1 }] },
    { sheetName: 'Data', rows: [{ id: 2 }] },
  ], { fileName: 'dup.xlsx' });
  assert.deepEqual(sources.map(s => s.id), ['dup → Data', 'dup → Data (2)']);
});

test('adaptExcelWorkbook: accepts { sheets: [...] } wrapper too', () => {
  const sources = adaptExcelWorkbook({ sheets: rosterWorkbook }, { fileName: 'Roster.xlsx' });
  assert.equal(sources.length, 2);
});

test('adaptExcelWorkbook: malformed/empty input -> [] (never throws)', () => {
  for (const bad of [undefined, null, 'x', 42, {}, [], [null, 3]]) {
    let out;
    assert.doesNotThrow(() => { out = adaptExcelWorkbook(bad); });
    assert.ok(Array.isArray(out));
  }
});

// ---- adaptApiSource: array and wrapped-object shapes ----

test('adaptApiSource: bare array of objects', () => {
  const s = adaptApiSource([{ claim_id: 'C1', paid: 500 }], { sourceId: 'CMS pull', url: 'https://api.example.com/claims' });
  assert.equal(s.id, 'CMS pull');
  assert.equal(s.rows.length, 1);
  assert.deepEqual(s.possibleKeys, ['claim_id']);
  assert.equal(s.meta.kind, 'api');
  assert.equal(s.meta.url, 'https://api.example.com/claims');
  assert.equal(typeof s.meta.fetchedAt, 'string');
  assert.equal(s.meta.ok, true);
});

test('adaptApiSource: object wrapping rows under data/results/items/records', () => {
  for (const key of ['data', 'results', 'items', 'records', 'rows']) {
    const s = adaptApiSource({ [key]: [{ member_id: 'M1' }], page: 1 }, { sourceId: 'x' });
    assert.equal(s.rows.length, 1, `${key} wrapper unwrapped`);
    assert.deepEqual(s.possibleKeys, ['member_id']);
  }
});

test('adaptApiSource: derives an id from the url when sourceId is omitted', () => {
  const s = adaptApiSource([{ id: 1 }], { url: 'https://api.example.com/v1/claims/' });
  assert.match(s.id, /api:api\.example\.com\/v1\/claims/);
});

test('adaptApiSource: no usable rows -> ok:false error source (never throws)', () => {
  for (const bad of [undefined, null, 'x', 42, {}, [], { data: 'no' }, [1, 2]]) {
    let s;
    assert.doesNotThrow(() => { s = adaptApiSource(bad, { sourceId: 'bad' }); });
    assert.equal(s.meta.ok, false);
    assert.deepEqual(s.rows, []);
    assert.equal(s.meta.needsManualKeySelection, true);
  }
});

// ---- adaptSiteExport: shares the helper, differs in kind + trust ----

test('adaptSiteExport: same shape as API adapter but kind=site and lower default trust', () => {
  const api = adaptApiSource([{ claim_id: 'C1' }], { sourceId: 'a' });
  const site = adaptSiteExport([{ claim_id: 'C1' }], { sourceId: 's', url: 'https://portal.example.gov/export' });
  assert.equal(site.meta.kind, 'site');
  assert.equal(site.meta.url, 'https://portal.example.gov/export');
  assert.deepEqual(site.possibleKeys, ['claim_id']);
  assert.ok(site.trust < api.trust, 'site export trusted below api pull');
});

test('adaptSiteExport: malformed input -> ok:false (never throws)', () => {
  let s;
  assert.doesNotThrow(() => { s = adaptSiteExport(null, { sourceId: 'z' }); });
  assert.equal(s.meta.ok, false);
});

// ---- toEngineSources: flatten + drop error sources ----

test('toEngineSources: flattens workbook arrays + singles, drops ok:false, builds trust map', () => {
  const excel = adaptExcelWorkbook(rosterWorkbook, { fileName: 'Roster.xlsx' });
  const api = adaptApiSource([{ claim_id: 'C1', paid: 500 }], { sourceId: 'CMS' });
  const broken = adaptApiSource(null, { sourceId: 'broken' });
  const { sources, sourceTrust } = toEngineSources([excel, api, broken]);
  assert.equal(sources.length, 3); // 2 excel tabs + 1 api; broken dropped
  assert.ok(sources.every(s => 'id' in s && 'rows' in s && 'possibleKeys' in s));
  assert.ok(!('broken' in sourceTrust));
  assert.equal(sourceTrust['CMS'], api.trust);
});

test('toEngineSources: junk input -> safe empty result (never throws)', () => {
  for (const bad of [undefined, null, 42, 'x']) {
    let r;
    assert.doesNotThrow(() => { r = toEngineSources(bad); });
    assert.deepEqual(r.sources, []);
  }
});

// ---- END-TO-END: adapters -> Batch 1 engine (the most important test) ----

test('integration: Excel workbook adapters feed buildConvergenceGraph and converge across tabs', () => {
  // Two tabs that share `claim_id`, plus an API source that also carries claim_id
  // with a CONFLICTING paid amount vs the adjustments tab.
  const workbook = adaptExcelWorkbook([
    { sheetName: 'Providers', rows: [{ npi: 'N1', name: 'Dr A' }] },
    { sheetName: 'Adjustments', rows: [{ claim_id: 'C1', npi: 'N1', paid: '500' }] },
  ], { fileName: 'Roster.xlsx' });
  const api = adaptApiSource([{ claim_id: 'C1', paid: 450 }], { sourceId: 'CMS Elig.' });

  const { sources, sourceTrust } = toEngineSources([workbook, api]);
  const graph = buildConvergenceGraph(sources);
  assert.equal(graph.evaluated, true, 'graph evaluated from adapter output');

  // Providers↔Adjustments share npi; Adjustments↔CMS share claim_id -> one component.
  assert.equal(graph.components.length, 1);
  assert.deepEqual([...graph.components[0]].sort(), ['CMS Elig.', 'Roster → Adjustments', 'Roster → Providers'].sort());

  const clusters = computeConvergenceClusters(graph, sources);
  const conflictCluster = clusters.find(c => c.hasConflict);
  assert.ok(conflictCluster, 'the shared claim converges into a conflicting cluster');
  const paid = conflictCluster.conflicts.find(f => f.column === 'paid');
  assert.ok(paid, 'paid 500 vs 450 flagged as a conflict across sources');

  // Trust comes straight from the adapters (excel 0.9 > api 0.75, margin 0.15 >= threshold).
  const res = resolveClusterWithTrust(conflictCluster, sourceTrust);
  const paidRes = res.resolutions.find(r => r.column === 'paid');
  assert.equal(paidRes.resolved, true);
  assert.equal(paidRes.winningSource, 'Roster → Adjustments');
  assert.equal(paidRes.value, '500');
});

test('integration: summarizeConvergence runs over adapter-fed clusters', () => {
  const api1 = adaptApiSource([{ member_id: 'M1', allowed_amt: '412.00' }], { sourceId: 'Roster·Adj' });
  const api2 = adaptApiSource([{ member_id: 'M1', allowed_amt: '398.50' }], { sourceId: 'CMS Elig.' });
  const { sources } = toEngineSources([api1, api2]);
  const graph = buildConvergenceGraph(sources);
  const clusters = computeConvergenceClusters(graph, sources);
  const s = summarizeConvergence(clusters);
  assert.equal(typeof s.text, 'string');
  assert.ok(s.joinedClusters >= 1);
});

// ---- summary ----
console.log(`\n${pass} passing, ${fail} failing`);
if (fail > 0) process.exit(1);
