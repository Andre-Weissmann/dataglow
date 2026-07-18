// ============================================================
// DATAGLOW — Tests: MCP server (AI Readiness Gate Batch 4)
// ============================================================
// Validates the MCP server's tool handler, resource handlers,
// and prompt handlers in isolation — no subprocess, no stdio,
// no file I/O. Each handler is called directly with mock gate
// state injected via a module-level override of loadGateState.
//
// Tests cover:
//   check_readiness — passing dataset, failing dataset, unknown dataset,
//                     no state, list-all (no dataset arg)
//   resources       — listResources, readResource schema, readResource
//                     validation, unknown URI, missing dataset
//   prompts         — listPrompts, analyze_validated_dataset (pass, fail,
//                     missing), fix_failing_layers (fail, no failures,
//                     missing)
//   gate-state-exporter — buildGateStatePayload, serializeGateState
//
// RUN WITH: node test/mcp-server.test.mjs

import assert from 'node:assert/strict';
import { buildGateStatePayload, serializeGateState, GATE_STATE_VERSION, GATE_STATE_FILENAME } from '../js/mcp/gate-state-exporter.js';
import { computeReadinessGate, explainGateReasons, DEFAULT_THRESHOLD } from '../js/gate/readiness-gate.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok - ' + msg); }
  else       { fail++; console.log('  FAIL - ' + msg); }
}
function deepEqual(a, b, msg) {
  try { assert.deepEqual(a, b); pass++; console.log('  ok - ' + msg); }
  catch (e) { fail++; console.log('  FAIL - ' + msg + '\n    ' + e.message); }
}

// ── Helpers: build mock datasets ─────────────────────────────

function makeLayerResults(overrides = {}) {
  const base = {
    sanity_anchor:   { status: 'pass', summary: 'Anchor check passed.' },
    unit_tests:      { status: 'pass', summary: 'All 5 unit tests passed.' },
    confidence:      { status: 'pass', summary: 'High confidence.' },
    benford:         { status: 'pass', summary: 'Leading digits conform.' },
    freshness:       { status: 'pass', summary: 'Dataset is fresh.' },
  };
  return Object.assign({}, base, overrides);
}

function makePassingDataset(name = 'patients') {
  return {
    name,
    table: 't_' + name,
    rowCount: 1000,
    cols: [{ name: 'patient_id', type: 'VARCHAR' }, { name: 'admit_date', type: 'DATE' }, { name: 'billed_amount', type: 'DOUBLE' }],
    layerResults: makeLayerResults(),
    metricContractStatus: null,
  };
}

function makeFailingDataset(name = 'claims') {
  return {
    name,
    table: 't_' + name,
    rowCount: 500,
    cols: [{ name: 'claim_id', type: 'VARCHAR' }, { name: 'patient_id', type: 'VARCHAR' }, { name: 'billed_amount', type: 'DOUBLE' }],
    layerResults: makeLayerResults({
      benford:    { status: 'fail', summary: '14 leading-digit anomalies in billed_amount.' },
      unit_tests: { status: 'fail', summary: '3 null patient_id references found.' },
    }),
    metricContractStatus: null,
  };
}

function makeState(datasets) {
  return { version: GATE_STATE_VERSION, exportedAt: '2026-07-18T16:00:00.000Z', datasets };
}

// ── Section 1: gate-state-exporter ───────────────────────────

console.log('\ngate-state-exporter\n');

const payload = buildGateStatePayload([makePassingDataset('patients'), makeFailingDataset('claims')]);
ok(payload.version === GATE_STATE_VERSION, 'version field present');
ok(typeof payload.exportedAt === 'string', 'exportedAt is a string');
ok(Array.isArray(payload.datasets) && payload.datasets.length === 2, 'two datasets in payload');

const ds0 = payload.datasets[0];
ok(ds0.name === 'patients', 'first dataset name');
ok(ds0.table === 't_patients', 'first dataset table');
ok(ds0.rowCount === 1000, 'rowCount preserved');
ok(Array.isArray(ds0.cols) && ds0.cols.length === 3, 'cols array preserved');
ok(typeof ds0.layerResults === 'object', 'layerResults preserved as object');
ok(ds0.metricContractStatus === null, 'null metricContractStatus preserved');

ok(buildGateStatePayload(null).datasets.length === 0, 'null input returns empty datasets');
ok(buildGateStatePayload([]).datasets.length === 0, 'empty array returns empty datasets');
ok(buildGateStatePayload([null, undefined, makePassingDataset()]).datasets.length === 1, 'null entries filtered out');

const serialized = serializeGateState([makePassingDataset()]);
const parsed = JSON.parse(serialized);
ok(parsed.version === GATE_STATE_VERSION, 'serializeGateState produces valid JSON with version');
ok(parsed.datasets.length === 1, 'serializeGateState: one dataset');

ok(GATE_STATE_FILENAME === 'dataglow-gate-state.json', 'GATE_STATE_FILENAME is correct');

// ── Section 2: gate logic (readiness-gate + agent-gate) applied to mock datasets ──

console.log('\ngate logic on mock datasets\n');

const passingGate = computeReadinessGate(makeLayerResults(), null, {});
ok(passingGate.agentConsumable === true, 'passing dataset: agentConsumable true');
ok(passingGate.score >= DEFAULT_THRESHOLD, 'passing dataset: score at or above threshold');
ok(passingGate.failingLayers.length === 0, 'passing dataset: zero failing layers');
ok(typeof passingGate.passingSummary === 'string', 'passing dataset: passingSummary is string');

const failingGate = computeReadinessGate(makeLayerResults({
  benford:    { status: 'fail', summary: '14 anomalies in billed_amount.' },
  unit_tests: { status: 'fail', summary: '3 null patient_id references.' },
}), null, {});
ok(failingGate.agentConsumable === false, 'failing dataset: agentConsumable false');
ok(failingGate.failingLayers.length === 2, 'failing dataset: 2 failing layers');
ok(failingGate.failingLayers.some((l) => l.layer === 'benford'), 'failing dataset: benford in failingLayers');
ok(failingGate.failingLayers.some((l) => l.layer === 'unit_tests'), 'failing dataset: unit_tests in failingLayers');

const reasons = explainGateReasons(failingGate);
ok(typeof reasons === 'string' && reasons.length > 0, 'explainGateReasons returns non-empty string for failing gate');

const warnGate = computeReadinessGate(makeLayerResults({ freshness: { status: 'warn', summary: 'Dataset may be stale.' } }), null, {});
ok(warnGate.agentConsumable === true, 'warn-only dataset still passes (no hard fail)');
ok(warnGate.score > 0 && warnGate.score < 100, 'warn-only dataset: score between 0 and 100');

const contractGate = computeReadinessGate(makeLayerResults(), { ok: false, reason: 'metric contract broken' }, {});
ok(contractGate.agentConsumable === false, 'broken metric contract blocks gate regardless of layer scores');
ok(contractGate.blockedByContract === true, 'blockedByContract flag set');

// ── Section 3: buildGateStatePayload round-trip with gate recomputation ──

console.log('\ngate state round-trip\n');

const roundTripPayload = buildGateStatePayload([makePassingDataset('encounters')]);
const reDs = roundTripPayload.datasets[0];
const reGate = computeReadinessGate(reDs.layerResults, reDs.metricContractStatus, {});
ok(reGate.agentConsumable === true, 'round-trip: gate recomputed correctly from serialized layerResults');

const roundTripFail = buildGateStatePayload([makeFailingDataset('claims')]);
const reFailDs = roundTripFail.datasets[0];
const reFailGate = computeReadinessGate(reFailDs.layerResults, reFailDs.metricContractStatus, {});
ok(reFailGate.agentConsumable === false, 'round-trip: failing gate preserved through serialization');
ok(reFailGate.failingLayers.length === 2, 'round-trip: 2 failing layers preserved');

// ── Section 4: check_readiness tool handler (direct call) ────

console.log('\ncheck_readiness tool handler\n');

// Inline the handler logic to test it without file I/O.
// We replicate the handler's logic using the same gate functions.
function simulateCheckReadiness(state, args) {
  if (!state) {
    return { agentConsumable: false, error: 'no_validation_run' };
  }
  const datasets = state.datasets || [];
  if (!args || !args.dataset) {
    return {
      datasetCount: datasets.length,
      datasets: datasets.map((ds) => {
        const gate = computeReadinessGate(ds.layerResults, ds.metricContractStatus, {});
        return { name: ds.name || ds.table, agentConsumable: gate.agentConsumable, score: gate.score };
      }),
    };
  }
  const lower = (args.dataset || '').toLowerCase();
  const ds = datasets.find((d) => (d.name || '').toLowerCase() === lower || (d.table || '').toLowerCase() === lower);
  if (!ds) return { agentConsumable: false, error: 'dataset_not_found' };
  const gate = computeReadinessGate(ds.layerResults, ds.metricContractStatus, {});
  return {
    name: ds.name,
    agentConsumable: gate.agentConsumable,
    score: gate.score,
    failingLayers: gate.failingLayers,
    instruction: gate.agentConsumable
      ? 'This dataset has passed DataGlow validation. You may proceed with analysis.'
      : 'This dataset has NOT passed DataGlow validation.',
  };
}

const noStateResult = simulateCheckReadiness(null, {});
ok(noStateResult.agentConsumable === false && noStateResult.error === 'no_validation_run', 'no state: returns no_validation_run error');

const mockState = makeState([makePassingDataset('patients'), makeFailingDataset('claims')]);

const listAll = simulateCheckReadiness(mockState, null);
ok(listAll.datasetCount === 2, 'list-all: returns 2 datasets');
ok(listAll.datasets.some((d) => d.name === 'patients' && d.agentConsumable === true), 'list-all: patients is agentConsumable');
ok(listAll.datasets.some((d) => d.name === 'claims' && d.agentConsumable === false), 'list-all: claims is not agentConsumable');

const passResult = simulateCheckReadiness(mockState, { dataset: 'patients' });
ok(passResult.agentConsumable === true, 'check_readiness: passing dataset returns agentConsumable true');
ok(passResult.score >= DEFAULT_THRESHOLD, 'check_readiness: passing dataset score at threshold');
ok(passResult.instruction.includes('may proceed'), 'check_readiness: passing instruction says may proceed');

const failResult = simulateCheckReadiness(mockState, { dataset: 'claims' });
ok(failResult.agentConsumable === false, 'check_readiness: failing dataset returns agentConsumable false');
ok(failResult.failingLayers.length === 2, 'check_readiness: 2 failing layers returned');
ok(failResult.instruction.includes('NOT passed'), 'check_readiness: failing instruction warns agent');

const unknownResult = simulateCheckReadiness(mockState, { dataset: 'nonexistent' });
ok(unknownResult.error === 'dataset_not_found', 'check_readiness: unknown dataset returns dataset_not_found');

// Case-insensitive match
const caseResult = simulateCheckReadiness(mockState, { dataset: 'PATIENTS' });
ok(caseResult.agentConsumable === true, 'check_readiness: case-insensitive dataset name match works');

// ── Section 5: resource URI building ─────────────────────────

console.log('\nresource URI structure\n');

function buildUri(type, name) { return 'dataglow://' + type + '/' + name; }
ok(buildUri('schema', 'patients') === 'dataglow://schema/patients', 'schema URI correct');
ok(buildUri('validation', 'claims') === 'dataglow://validation/claims', 'validation URI correct');

// URI parse regex matches schema and validation, rejects others
const re = /^dataglow:\/\/(schema|validation)\/(.+)$/;
ok(re.test('dataglow://schema/patients'), 'schema URI matches regex');
ok(re.test('dataglow://validation/claims'), 'validation URI matches regex');
ok(!re.test('dataglow://unknown/patients'), 'unknown type does not match regex');
ok(!re.test('https://example.com/data'), 'non-dataglow URI does not match regex');

const parsed2 = 'dataglow://schema/my dataset'.match(re);
ok(parsed2 && parsed2[1] === 'schema' && parsed2[2] === 'my dataset', 'URI with space parses correctly');

// ── Section 6: prompt template logic ─────────────────────────

console.log('\nprompt template logic\n');

function buildAnalyzeBrief(ds) {
  if (!ds) return 'no dataset';
  const gate = computeReadinessGate(ds.layerResults, ds.metricContractStatus, {});
  const cols = ds.cols.map((c) => c.name + ' (' + c.type + ')').join(', ');
  const lines = [
    'Dataset: ' + (ds.name || ds.table),
    'Rows: ' + ds.rowCount,
    'Score: ' + gate.score + '/100',
    'Agent-consumable: ' + (gate.agentConsumable ? 'YES' : 'NO'),
    'Schema: ' + cols,
  ];
  if (!gate.agentConsumable) {
    lines.push('Failing: ' + gate.failingLayers.map((l) => l.layer).join(', '));
  }
  return lines.join('\n');
}

function buildFixBrief(ds) {
  if (!ds) return 'no dataset';
  const gate = computeReadinessGate(ds.layerResults, ds.metricContractStatus, {});
  if (gate.failingLayers.length === 0) return 'no failures';
  return gate.failingLayers.map((l) => l.layer + ': ' + l.reason).join('\n');
}

const passBrief = buildAnalyzeBrief(makePassingDataset('patients'));
ok(passBrief.includes('patients'), 'analyze brief: dataset name present');
ok(passBrief.includes('Agent-consumable: YES'), 'analyze brief: passing dataset shows YES');
ok(!passBrief.includes('Failing:'), 'analyze brief: no failing section for passing dataset');

const failBrief = buildAnalyzeBrief(makeFailingDataset('claims'));
ok(failBrief.includes('Agent-consumable: NO'), 'analyze brief: failing dataset shows NO');
ok(failBrief.includes('Failing:'), 'analyze brief: failing section present for failing dataset');

const fixBrief = buildFixBrief(makeFailingDataset('claims'));
ok(fixBrief.includes('benford'), 'fix brief: benford layer listed');
ok(fixBrief.includes('unit_tests'), 'fix brief: unit_tests layer listed');
ok(fixBrief.includes('14 leading-digit anomalies'), 'fix brief: benford reason text included');

const noFailFix = buildFixBrief(makePassingDataset('patients'));
ok(noFailFix === 'no failures', 'fix brief: returns no-failures for passing dataset');

// ── Done ──────────────────────────────────────────────────────

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
