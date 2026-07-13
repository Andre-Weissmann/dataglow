// ============================================================
// DATAGLOW — Tests: Source Convergence UI (Truth Network, Batch 3 of 3, final)
// ============================================================
// Plain node, no DOM/XLSX/network needed — this batch's testable surface is the
// PURE view-model builders in js/validation/source-convergence-ui.js
// (shouldOfferConvergence / sourceKindBadge / formatTrust / formatKeyList /
// buildSourceCardModel / buildEscalationModel / toggleExpanded /
// buildConvergenceView), exactly like room-ui.test.mjs tests the pure builders
// behind room-ui.js and leaves the DOM renderer (mountConvergence) to the
// browser/e2e path. These builders invent no convergence logic — they only
// PRESENT what Batch 1's engine and Batch 2's adapters already return, so the
// end-to-end test feeds REAL adaptExcelWorkbook/adaptApiSource output straight
// through buildConvergenceView to prove the whole pipeline stays honest.
//
// RUN WITH:  node test/source-convergence-ui.test.mjs

import assert from 'node:assert/strict';
import {
  shouldOfferConvergence,
  sourceKindBadge,
  formatTrust,
  formatKeyList,
  buildSourceCardModel,
  buildEscalationModel,
  toggleExpanded,
  buildConvergenceView,
} from '../js/validation/source-convergence-ui.js';
import {
  adaptExcelWorkbook,
  adaptApiSource,
} from '../js/validation/source-convergence-ingestion.js';

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

// ---- shouldOfferConvergence: the flag gate (render / no-render) ----

test('shouldOfferConvergence: true ONLY when enabled === true', () => {
  assert.equal(shouldOfferConvergence({ enabled: true }), true);
  assert.equal(shouldOfferConvergence({ enabled: false }), false);
});

test('shouldOfferConvergence: missing/undefined/truthy-non-true -> false (dark by default, never throws)', () => {
  assert.equal(shouldOfferConvergence(), false);
  assert.equal(shouldOfferConvergence({}), false);
  assert.equal(shouldOfferConvergence({ enabled: undefined }), false);
  assert.equal(shouldOfferConvergence({ enabled: 1 }), false);
  assert.equal(shouldOfferConvergence({ enabled: 'yes' }), false);
});

// ---- sourceKindBadge ----

test('sourceKindBadge: known kinds map to existing .badge classes, invents no new color', () => {
  assert.deepEqual(sourceKindBadge('excel'), { label: 'Excel tab', className: 'badge badge-a' });
  assert.deepEqual(sourceKindBadge('api'), { label: 'API', className: 'badge badge-b' });
  assert.deepEqual(sourceKindBadge('site'), { label: 'Site export', className: 'badge badge-c' });
});

test('sourceKindBadge: unknown/empty/non-string -> neutral badge (never throws)', () => {
  assert.equal(sourceKindBadge('mystery').className, 'badge');
  assert.equal(sourceKindBadge('').label, 'Source');
  assert.equal(sourceKindBadge(null).label, 'Source');
  assert.equal(sourceKindBadge(42).label, 'Source');
});

// ---- formatTrust ----

test('formatTrust: finite number -> two decimals; anything else -> em dash', () => {
  assert.equal(formatTrust(0.9), '0.90');
  assert.equal(formatTrust(0.755), '0.76');
  assert.equal(formatTrust(null), '—');
  assert.equal(formatTrust(undefined), '—');
  assert.equal(formatTrust(NaN), '—');
  assert.equal(formatTrust('0.9'), '—');
});

// ---- formatKeyList ----

test('formatKeyList: strings + composite arrays render readably; empty -> null', () => {
  assert.equal(formatKeyList(['claim_id', 'npi']), 'claim_id, npi');
  assert.equal(formatKeyList([['patient_id', 'date_of_service']]), 'patient_id+date_of_service');
  assert.equal(formatKeyList([]), null);
  assert.equal(formatKeyList(null), null);
  assert.equal(formatKeyList('nope'), null);
});

// ---- buildSourceCardModel ----

test('buildSourceCardModel: a real API adapter source -> live pull card with badge/trust', () => {
  const src = adaptApiSource([{ claim_id: 'C1', paid: 500 }], { sourceId: 'CMS pull' });
  const m = buildSourceCardModel(src);
  assert.equal(m.id, 'CMS pull');
  assert.equal(m.ok, true);
  assert.equal(m.badge.className, 'badge badge-b');
  assert.equal(m.live, true);
  assert.equal(m.rowText, 'live pull');
  assert.equal(m.keyLabel, 'claim_id');
  assert.equal(m.trustText, formatTrust(src.trust));
});

test('buildSourceCardModel: a real Excel tab -> N rows card (not live), key label from adapter', () => {
  const [providers] = adaptExcelWorkbook(
    [{ sheetName: 'Providers', rows: [{ npi: 'N1', name: 'Dr A' }, { npi: 'N2', name: 'Dr B' }] }],
    { fileName: 'Roster.xlsx' },
  );
  const m = buildSourceCardModel(providers);
  assert.equal(m.id, 'Roster → Providers');
  assert.equal(m.live, false);
  assert.equal(m.rowText, '2 rows');
  assert.equal(m.keyLabel, 'npi');
  assert.equal(m.needsManualKey, false);
});

test('buildSourceCardModel: an ok:false error source -> ok:false with a reason, never throws', () => {
  const bad = adaptApiSource(null, { sourceId: 'broken' });
  const m = buildSourceCardModel(bad);
  assert.equal(m.ok, false);
  assert.ok(typeof m.reason === 'string' && m.reason.length > 0);
});

test('buildSourceCardModel: non-object input -> safe invalid card (never throws)', () => {
  for (const bad of [undefined, null, 42, 'x', []]) {
    let m;
    assert.doesNotThrow(() => { m = buildSourceCardModel(bad); });
    assert.equal(m.ok, false);
  }
});

// ---- toggleExpanded: the pure click-through state transition ----

test('toggleExpanded: adds a missing id, returns a NEW Set (input untouched)', () => {
  const before = new Set();
  const after = toggleExpanded(before, 'c1');
  assert.ok(after instanceof Set);
  assert.notEqual(after, before);
  assert.equal(before.size, 0, 'input Set not mutated');
  assert.ok(after.has('c1'));
});

test('toggleExpanded: removes an id that is already expanded (collapse)', () => {
  const after = toggleExpanded(new Set(['c1', 'c2']), 'c1');
  assert.ok(!after.has('c1'));
  assert.ok(after.has('c2'));
});

test('toggleExpanded: null id -> a safe copy, no throw; non-Set input tolerated', () => {
  assert.doesNotThrow(() => toggleExpanded(new Set(['x']), null));
  assert.deepEqual([...toggleExpanded(new Set(['x']), null)], ['x']);
  assert.doesNotThrow(() => toggleExpanded(undefined, 'c1'));
  assert.ok(toggleExpanded(undefined, 'c1').has('c1'));
});

// ---- buildEscalationModel ----

test('buildEscalationModel: pulls only the unresolved columns with their candidates', () => {
  const cluster = { id: 'cl1', joinKeys: [{ key: 'member_id', value: 'M1' }], sourceIds: ['A', 'B'], coverageCount: 2 };
  const resolution = {
    escalated: true,
    resolutions: [
      { column: 'name', resolved: true, value: 'Ada' },
      { column: 'allowed_amt', resolved: false, reason: 'trust margin below threshold', margin: 0,
        candidates: [{ sourceId: 'A', value: '412.00', trust: 0.75 }, { sourceId: 'B', value: '398.50', trust: 0.75 }] },
    ],
  };
  const m = buildEscalationModel(cluster, resolution);
  assert.equal(m.clusterId, 'cl1');
  assert.equal(m.joinLabel, 'member_id=M1');
  assert.equal(m.coverageCount, 2);
  assert.equal(m.fields.length, 1, 'only the unresolved column is escalated');
  assert.equal(m.fields[0].column, 'allowed_amt');
  assert.equal(m.fields[0].candidates.length, 2);
  assert.equal(m.fields[0].candidates[0].trust, 0.75);
});

test('buildEscalationModel: malformed cluster/resolution -> safe empty fields (never throws)', () => {
  let m;
  assert.doesNotThrow(() => { m = buildEscalationModel(null, null); });
  assert.deepEqual(m.fields, []);
});

// ---- buildConvergenceView: honest EMPTY STATE (no sources -> no fabricated data) ----

test('buildConvergenceView: no sources -> isEmpty:true, no matrix/summary/escalations', () => {
  const view = buildConvergenceView([]);
  assert.equal(view.ok, true);
  assert.equal(view.isEmpty, true);
  assert.equal(view.usableCount, 0);
  assert.deepEqual(view.matrix, []);
  assert.equal(view.summary, null);
  assert.deepEqual(view.escalations, []);
});

test('buildConvergenceView: only ok:false sources -> still isEmpty, but the error card shows on the rail', () => {
  const broken = adaptApiSource(null, { sourceId: 'broken' });
  const view = buildConvergenceView([broken]);
  assert.equal(view.isEmpty, true);
  assert.equal(view.usableCount, 0);
  assert.equal(view.sources.length, 1);
  assert.equal(view.sources[0].ok, false);
});

test('buildConvergenceView: malformed input -> never throws, returns a safe model', () => {
  for (const bad of [undefined, null, 42, 'x']) {
    let view;
    assert.doesNotThrow(() => { view = buildConvergenceView(bad); });
    assert.ok(view && typeof view === 'object');
    assert.equal(view.isEmpty, true);
  }
});

// ---- END-TO-END: real adapter output -> buildConvergenceView (the key test) ----

test('buildConvergenceView: two API sources conflict with equal trust -> ESCALATE row + escalation detail', () => {
  // Both are API pulls -> equal default trust -> margin 0 < 0.15 threshold ->
  // the conflict cannot auto-resolve and must escalate for a human.
  const api1 = adaptApiSource([{ member_id: 'M1', allowed_amt: '412.00' }], { sourceId: 'Roster·Adj' });
  const api2 = adaptApiSource([{ member_id: 'M1', allowed_amt: '398.50' }], { sourceId: 'CMS Elig.' });

  const view = buildConvergenceView([api1, api2]);
  assert.equal(view.ok, true);
  assert.equal(view.isEmpty, false);
  assert.equal(view.usableCount, 2);
  assert.equal(view.sources.length, 2);

  // One joined cluster spanning both sources, flagged Escalate.
  assert.equal(view.matrix.length, 1);
  assert.equal(view.matrix[0].coverageCount, 2);
  assert.equal(view.matrix[0].status, 'escalate');

  // The escalation carries the disagreeing column with both candidates + trust.
  assert.equal(view.escalations.length, 1);
  const esc = view.escalations[0];
  const amt = esc.fields.find(f => f.column === 'allowed_amt');
  assert.ok(amt, 'allowed_amt escalated');
  assert.equal(amt.candidates.length, 2);
  assert.ok(amt.candidates.every(c => typeof c.trust === 'number'));

  // The verdict summary honestly reports at least one needs-human cluster.
  assert.ok(view.summary && typeof view.summary.text === 'string');
  assert.ok(view.summary.needsHuman >= 1);
});

test('buildConvergenceView: Excel (higher trust) vs API conflict -> RESOLVED, not escalated', () => {
  // Excel default trust (~0.9) beats API (~0.75) by >= the 0.15 margin, so the
  // conflict auto-resolves to the higher-trust source and does NOT escalate.
  const workbook = adaptExcelWorkbook(
    [{ sheetName: 'Adjustments', rows: [{ claim_id: 'C1', paid: '500' }] }],
    { fileName: 'Roster.xlsx' },
  );
  const api = adaptApiSource([{ claim_id: 'C1', paid: 450 }], { sourceId: 'CMS Elig.' });

  const view = buildConvergenceView([workbook, api]);
  assert.equal(view.usableCount, 2);
  assert.equal(view.matrix.length, 1);
  assert.equal(view.matrix[0].status, 'resolved');
  assert.deepEqual(view.escalations, [], 'a decisive trust margin resolves without human review');
});

// ---- summary ----
console.log(`\n${pass} passing, ${fail} failing`);
if (fail > 0) process.exit(1);
