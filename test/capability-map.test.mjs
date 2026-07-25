// ============================================================
// DATAGLOW - Capability registry as data (unit tests)
// ============================================================
// Two things are worth testing here. First the pure derivation helpers, because
// they are what make "status" a fact rather than a claim: if deriveStatus ever
// returned "shipped" for a disabled flag, the CI gate would happily wave through
// exactly the fake shipped claim it exists to catch. Second the real repository,
// so this file fails the moment the committed manifest drifts from the flags.
//
// RUN WITH:  node --test test/capability-map.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VALID_PLATFORMS,
  VALID_STATUSES,
  flagToCapabilityId,
  deriveRelatedFlags,
  deriveStatus,
  normalizeCapability,
  runCheck,
} from '../scripts/check-capability-map.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FLAGS = {
  shieldPacks: { enabled: true },
  airGapMode: { enabled: false },
  someOtherThing: { enabled: true },
};

test('flagToCapabilityId kebab-cases a camelCase flag name', () => {
  assert.equal(flagToCapabilityId('airGapMode'), 'air-gap-mode');
  assert.equal(flagToCapabilityId('shieldPacks'), 'shield-packs');
  // Runs of capitals stay together, which is what the committed ids look like.
  assert.equal(flagToCapabilityId('sourceConvergenceUI'), 'source-convergence-ui');
  assert.equal(flagToCapabilityId('plain'), 'plain');
  assert.equal(flagToCapabilityId(''), '');
  assert.equal(flagToCapabilityId(null), '');
});

test('deriveRelatedFlags picks up a name-matched flag that was never declared', () => {
  const cap = { id: 'air-gap-mode' };
  assert.deepEqual(deriveRelatedFlags(cap, FLAGS), ['airGapMode']);
});

test('deriveRelatedFlags merges declared and matched, sorted and de-duplicated', () => {
  const cap = { id: 'air-gap-mode', relatedFlags: ['someOtherThing', 'airGapMode'] };
  assert.deepEqual(deriveRelatedFlags(cap, FLAGS), ['airGapMode', 'someOtherThing']);
});

test('deriveRelatedFlags is empty for a capability no flag gates', () => {
  assert.deepEqual(deriveRelatedFlags({ id: 'csv-import' }, FLAGS), []);
});

test('a capability with no flag at all is shipped', () => {
  assert.equal(deriveStatus({ id: 'csv-import' }, FLAGS), 'shipped');
});

test('a capability whose flag is enabled is shipped', () => {
  assert.equal(deriveStatus({ id: 'shield-packs' }, FLAGS), 'shipped');
});

test('a capability whose flag ships disabled is behind-flag', () => {
  assert.equal(deriveStatus({ id: 'air-gap-mode' }, FLAGS), 'behind-flag');
});

test('one disabled flag is enough to make a multi-flag capability behind-flag', () => {
  const cap = { id: 'mixed', relatedFlags: ['shieldPacks', 'airGapMode'] };
  assert.equal(deriveStatus(cap, FLAGS, deriveRelatedFlags(cap, FLAGS)), 'behind-flag');
});

test('a relatedFlag that does not exist in the manifest is behind-flag, not shipped', () => {
  // Fail closed: a dangling flag reference must never read as a shipped claim.
  assert.equal(deriveStatus({ id: 'ghost', relatedFlags: ['noSuchFlag'] }, FLAGS), 'behind-flag');
});

test('normalizeCapability returns exactly the five registry fields', () => {
  const rec = normalizeCapability(
    { id: 'air-gap-mode', name: 'Air-Gap Mode', platforms: ['browser'], status: 'shipped', area: 'ignored' },
    FLAGS,
  );
  assert.deepEqual(Object.keys(rec).sort(), ['id', 'platforms', 'relatedFlags', 'status', 'title']);
  assert.equal(rec.title, 'Air-Gap Mode');
  assert.deepEqual(rec.platforms, ['browser']);
  // Authored status is ignored; the flags decide.
  assert.equal(rec.status, 'behind-flag');
});

test('normalizeCapability falls back to the id when no name is authored', () => {
  assert.equal(normalizeCapability({ id: 'csv-import' }, FLAGS).title, 'csv-import');
});

test('the committed capability map passes its own check', () => {
  const { failures, registry } = runCheck({ root: REPO_ROOT });
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.ok(registry.length > 100, 'the registry should describe the whole product');
});

test('every registry record is well formed', () => {
  const { registry } = runCheck({ root: REPO_ROOT });
  for (const rec of registry) {
    assert.ok(rec.id && typeof rec.id === 'string', 'id');
    assert.ok(rec.title && typeof rec.title === 'string', `${rec.id}: title`);
    assert.ok(VALID_STATUSES.includes(rec.status), `${rec.id}: status`);
    assert.ok(Array.isArray(rec.relatedFlags), `${rec.id}: relatedFlags`);
    assert.ok(rec.platforms.length > 0, `${rec.id}: platforms`);
    for (const p of rec.platforms) assert.ok(VALID_PLATFORMS.includes(p), `${rec.id}: platform ${p}`);
  }
});

test('Air-Gap Mode is recorded as shipped now that its flag ships enabled', () => {
  const flags = JSON.parse(readFileSync(join(REPO_ROOT, 'flags.manifest.json'), 'utf8')).flags || {};
  assert.equal(flags.airGapMode.enabled, true, 'airGapMode ships ON');
  const { registry } = runCheck({ root: REPO_ROOT });
  const rec = registry.find((r) => r.id === 'air-gap-mode');
  assert.ok(rec, 'air-gap-mode must be in the capability map');
  assert.deepEqual(rec.relatedFlags, ['airGapMode']);
  assert.equal(rec.status, 'shipped');
});

test('every flag-linked capability agrees with flags.manifest.json', () => {
  const flags = JSON.parse(readFileSync(join(REPO_ROOT, 'flags.manifest.json'), 'utf8')).flags || {};
  const { registry } = runCheck({ root: REPO_ROOT });
  for (const rec of registry) {
    const allOn = rec.relatedFlags.every((n) => flags[n] && flags[n].enabled === true);
    assert.equal(rec.status, allOn ? 'shipped' : 'behind-flag', `${rec.id}: status must follow its flags`);
  }
});
