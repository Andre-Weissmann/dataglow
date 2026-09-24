// Tests for js/rulepacks/rulepack-registry.js: the module-level default
// singleton must keep its original behavior unchanged, and the new
// createRulepackRegistry() factory must produce genuinely isolated instances
// pre-seeded with the same built-in packs -- enterprise-readiness
// singleton-isolation retrofit (2026-09-24), retrofit 3/4.
import assert from 'node:assert/strict';
import {
  getRulepack,
  listRulepacks,
  registerPack,
  createRulepackRegistry,
} from '../js/rulepacks/rulepack-registry.js';

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

function makeValidTestPack(id) {
  return {
    id,
    version: '1.0.0',
    label: `Test pack ${id}`,
    description: 'A synthetic test rulepack, valid shape only.',
    domain: 'general',
    freshness: {
      staleAfterDays: 30,
      expiredAfterDays: 90,
      decayFloor: 0.1,
      decayShape: 'linear',
      rationale: 'test',
    },
    equity: {
      binary: { rateRatioWarn: 1.25, rateRatioFail: 1.5, absDiffWarn: 0.05, absDiffFail: 0.1 },
      continuous: { smdWarn: 0.2, smdFail: 0.5 },
      minCellSize: 10,
      maxGroups: 10,
      rowSampleLimit: 10000,
      methodologyAttribution: 'test',
    },
  };
}

// ---- Default (module-level) singleton behavior is unchanged ----

test('default registry: ships with both built-in packs (healthcare, general)', () => {
  const ids = listRulepacks().map(p => p.id);
  assert.ok(ids.includes('healthcare'), 'expected the healthcare built-in pack');
  assert.ok(ids.includes('general'), 'expected the general built-in pack');
});

test('default registry: getRulepack falls back to general for an unknown id', () => {
  const pack = getRulepack('totally_unknown_pack_id');
  assert.strictEqual(pack.id, 'general', 'unknown id should fall back to the general pack');
});

test('default registry: registerPack/getRulepack round-trip for a valid custom pack', () => {
  const id = `zzz_test_pack_${Date.now()}`;
  const result = registerPack(makeValidTestPack(id));
  assert.strictEqual(result.ok, true, `expected registration to succeed: ${JSON.stringify(result.errors)}`);
  assert.strictEqual(getRulepack(id).id, id);
});

// ---- New factory: genuinely isolated instances ----

test('createRulepackRegistry: returns the full registry API surface', () => {
  const registry = createRulepackRegistry();
  for (const fn of ['getRulepack', 'listRulepacks', 'registerPack']) {
    assert.strictEqual(typeof registry[fn], 'function', `expected ${fn} to be a function on the factory registry`);
  }
});

test('createRulepackRegistry: pre-seeds the same built-in packs as the default registry', () => {
  const registry = createRulepackRegistry();
  const ids = registry.listRulepacks().map(p => p.id).sort();
  assert.deepStrictEqual(ids, ['general', 'healthcare']);
});

test('createRulepackRegistry: a custom pack registered on one instance is invisible to another (the core isolation guarantee)', () => {
  const registryA = createRulepackRegistry();
  const registryB = createRulepackRegistry();
  const id = 'isolation_test_pack_shared_id';

  const result = registryA.registerPack(makeValidTestPack(id));
  assert.strictEqual(result.ok, true);

  assert.strictEqual(registryA.getRulepack(id).id, id, 'registryA should have the custom pack it registered');
  assert.strictEqual(registryB.getRulepack(id).id, 'general', 'registryB must NOT see registryA\'s custom pack -- falls back to general, proving it never leaked in');
});

test('createRulepackRegistry: a factory-created custom pack does not leak into the module-level default registry', () => {
  const isolated = createRulepackRegistry();
  const id = `isolated_only_${Date.now()}`;
  isolated.registerPack(makeValidTestPack(id));
  assert.strictEqual(isolated.getRulepack(id).id, id, 'isolated registry should have its own custom pack');
  assert.strictEqual(getRulepack(id).id, 'general', 'the default module-level registry must not see a pack registered only on an isolated factory instance');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
