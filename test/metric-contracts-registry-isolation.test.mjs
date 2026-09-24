// Tests for js/nl-sql/metric-contracts.js's registry: the module-level
// default singleton must keep its original behavior unchanged, and the new
// createContractRegistry() factory must produce genuinely isolated instances
// pre-seeded with the same built-in contracts -- enterprise-readiness
// singleton-isolation retrofit (2026-09-24), retrofit 2/4.
import assert from 'node:assert/strict';
import {
  registerContract,
  unregisterContract,
  getAllContracts,
  getContract,
  matchContracts,
  bestMatch,
  createContractRegistry,
} from '../js/nl-sql/metric-contracts.js';

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

// ---- Default (module-level) singleton behavior is unchanged ----

test('default registry: ships with built-in contracts pre-registered', () => {
  const all = getAllContracts();
  assert.ok(all.length > 0, 'expected built-in contracts to be registered at module load');
});

test('default registry: bestMatch finds a real built-in contract for a natural question', () => {
  const match = bestMatch('what is the unique count of patients');
  assert.ok(match, 'expected a keyword match against a built-in contract');
});

test('default registry: registerContract/getContract/unregisterContract round-trip', () => {
  const id = `zzz_test_contract_${Date.now()}`;
  registerContract({ id, name: 'Test Metric', expression: '1', keywords: ['zzz_unique_test_keyword'] });
  assert.ok(getContract(id), 'contract should be retrievable immediately after registering');
  unregisterContract(id);
  assert.strictEqual(getContract(id), null, 'contract should be gone after unregistering');
});

// ---- New factory: genuinely isolated instances ----

test('createContractRegistry: returns the full registry API surface', () => {
  const registry = createContractRegistry();
  for (const fn of ['registerContract', 'unregisterContract', 'getAllContracts', 'getContract', 'matchContracts', 'bestMatch']) {
    assert.strictEqual(typeof registry[fn], 'function', `expected ${fn} to be a function on the factory registry`);
  }
});

test('createContractRegistry: pre-seeds the same built-in contracts as the default registry', () => {
  const registry = createContractRegistry();
  assert.strictEqual(registry.getAllContracts().length, getAllContracts().length, 'factory registry should start with the same built-in contract count as the default');
});

test('createContractRegistry: a custom contract registered on one instance is invisible to another (the core isolation guarantee)', () => {
  const registryA = createContractRegistry();
  const registryB = createContractRegistry();
  const id = 'isolation_test_contract_shared_id';

  registryA.registerContract({ id, name: 'A-only metric', expression: '1', keywords: ['zzz_a_only_kw'] });

  assert.ok(registryA.getContract(id), 'registryA should have the contract it registered');
  assert.strictEqual(registryB.getContract(id), null, 'registryB must NOT see registryA\'s custom contract -- this is the actual multi-tenancy bug this retrofit prevents');
});

test('createContractRegistry: a factory-created custom contract does not leak into the module-level default registry', () => {
  const isolated = createContractRegistry();
  const id = `isolated_only_${Date.now()}`;
  isolated.registerContract({ id, name: 'Isolated only', expression: '1', keywords: ['zzz_isolated_only_kw'] });
  assert.ok(isolated.getContract(id), 'isolated registry should have its own custom contract');
  assert.strictEqual(getContract(id), null, 'the default module-level registry must not see a contract registered only on an isolated factory instance');
});

test('createContractRegistry: matchContracts/bestMatch on one instance never sees another instance\'s custom keywords', () => {
  const registryA = createContractRegistry();
  const registryB = createContractRegistry();
  registryA.registerContract({
    id: 'a_specific_metric',
    name: 'A specific metric',
    expression: '1',
    keywords: ['zorbnaxphraseonlyina'],
  });
  const matchInB = registryB.bestMatch('zorbnaxphraseonlyina');
  assert.strictEqual(matchInB, null, 'registryB must not match a keyword that was only registered as a custom contract on registryA');
  const matchInA = registryA.bestMatch('zorbnaxphraseonlyina');
  assert.ok(matchInA, 'registryA should match its own custom contract\'s keyword');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
