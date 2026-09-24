// Tests for js/provenance/provenance.js's registry: the module-level default
// singleton (startProvenance/getProvenance/recordStep) must keep its original
// behavior unchanged, and the new createProvenanceRegistry() factory must
// produce genuinely isolated instances -- this is the enterprise-readiness
// singleton-isolation retrofit (2026-09-24).
import assert from 'node:assert/strict';
import {
  startProvenance,
  getProvenance,
  recordStep,
  createProvenanceRegistry,
} from '../js/provenance/provenance.js';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ---- Default (module-level) singleton behavior is unchanged ----

test('startProvenance/getProvenance: default singleton registers and retrieves a chain', () => {
  const table = `test_table_${Date.now()}_a`;
  const chain = startProvenance(table);
  assert.ok(chain, 'startProvenance should return a chain');
  const retrieved = getProvenance(table);
  assert.strictEqual(retrieved, chain, 'getProvenance should return the SAME chain instance registered for this table');
});

test('getProvenance: default singleton returns null for an unregistered table', () => {
  const result = getProvenance(`never_registered_${Date.now()}`);
  assert.strictEqual(result, null);
});

await testAsync('recordStep: default singleton appends to the registered chain', async () => {
  const table = `test_table_${Date.now()}_b`;
  startProvenance(table);
  const step = await recordStep(table, 'load', 'Loaded test file');
  assert.ok(step, 'recordStep should return the appended step');
  const chain = getProvenance(table);
  assert.strictEqual(chain.getTrail().length, 1);
});

await testAsync('recordStep: default singleton silently no-ops for an unregistered table', async () => {
  const result = await recordStep(`never_registered_${Date.now()}`, 'load', 'x');
  assert.strictEqual(result, null);
});

// ---- New factory: genuinely isolated instances ----

test('createProvenanceRegistry: returns an object with the same three functions', () => {
  const registry = createProvenanceRegistry();
  assert.strictEqual(typeof registry.startProvenance, 'function');
  assert.strictEqual(typeof registry.getProvenance, 'function');
  assert.strictEqual(typeof registry.recordStep, 'function');
});

test('createProvenanceRegistry: two separate registries do not share state (the core isolation guarantee)', () => {
  const registryA = createProvenanceRegistry();
  const registryB = createProvenanceRegistry();
  const sharedTableName = 'same_table_name_in_both_registries';

  registryA.startProvenance(sharedTableName);
  // registryB never registered this table name.
  assert.ok(registryA.getProvenance(sharedTableName), 'registryA should have the chain it registered');
  assert.strictEqual(registryB.getProvenance(sharedTableName), null, 'registryB must NOT see registryA\'s chain for the same table name -- this is the actual multi-tenancy bug this retrofit prevents');
});

test('createProvenanceRegistry: a factory-created registry does not leak into the module-level default singleton', () => {
  const isolated = createProvenanceRegistry();
  const table = `isolated_only_${Date.now()}`;
  isolated.startProvenance(table);
  assert.ok(isolated.getProvenance(table), 'isolated registry should have its own chain');
  assert.strictEqual(getProvenance(table), null, 'the default module-level singleton must not see a chain registered only on an isolated factory instance');
});

await testAsync('createProvenanceRegistry: recordStep on one registry does not affect a same-named chain on another', async () => {
  const registryA = createProvenanceRegistry();
  const registryB = createProvenanceRegistry();
  const table = 'shared_name_recordstep_test';
  registryA.startProvenance(table);
  registryB.startProvenance(table);
  await registryA.recordStep(table, 'clean', 'Fix in A only');
  assert.strictEqual(registryA.getProvenance(table).getTrail().length, 1);
  assert.strictEqual(registryB.getProvenance(table).getTrail().length, 0, 'registryB\'s same-named chain must remain untouched by a recordStep call on registryA');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
