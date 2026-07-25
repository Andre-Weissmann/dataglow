// ============================================================
// DATAGLOW - Tests: Publish-Safe (Bundle 4, A12)
// ============================================================
// js/gate/publish-safe.js is pure: no DOM, no network, no crypto. These tests
// pin the four rules that matter, in the order they matter:
//   1. sensitive values leaving the device is the one hard refusal
//   2. sensitive values staying on the device is a safer default, not a refusal
//   3. a check that could not run is never reported as a pass
//   4. nothing is mutated and nothing is decided for the human
// plus the house rule that no visible string carries a U+2014 em dash.

import assert from 'node:assert/strict';
import {
  PUBLISH_SAFE_KIND,
  PUBLISH_SAFE_VERSION,
  PUBLISH_SAFE_LEVELS,
  PUBLISH_DESTINATIONS,
  PUBLISH_SAFE_DISCLAIMER,
  normalizeDestination,
  evaluatePublishSafe,
  describePublishSafe,
  publishSafeBadge,
  DataGlowPublishSafe,
} from '../js/gate/publish-safe.js';
import { computeReadinessGate } from '../js/gate/readiness-gate.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

const EM_DASH = '—';
const PHI_CLEAR = { available: true, sensitiveFound: false, count: 0, patterns: [] };
const PHI_HIT = { available: true, sensitiveFound: true, count: 3, patterns: ['email', 'ssn'] };
const READY = { agentConsumable: true, score: 88, threshold: 70, failingLayers: [] };
const NOT_READY = { agentConsumable: false, score: 41, threshold: 70, failingLayers: [{ layer: 'types' }] };

function codes(v) { return v.reasons.map((r) => r.code); }

// ---- constants ----

await test('levels are ordered least to most severe', () => {
  assert.deepEqual([...PUBLISH_SAFE_LEVELS], ['clear', 'caution', 'blocked']);
  assert.equal(PUBLISH_SAFE_KIND, 'dataglow-publish-safe');
  assert.equal(PUBLISH_SAFE_VERSION, 1);
});

await test('destinations name the only two cases the gate distinguishes', () => {
  assert.deepEqual([...PUBLISH_DESTINATIONS], ['this-device', 'off-device']);
});

await test('the disclaimer admits the gate cannot see what it was not given', () => {
  assert.match(PUBLISH_SAFE_DISCLAIMER, /cannot see anything it was not given/i);
  assert.match(PUBLISH_SAFE_DISCLAIMER, /rather than treating a missing check as a pass/i);
});

await test('normalizeDestination defaults to this device and never invents a third case', () => {
  assert.equal(normalizeDestination('off-device'), 'off-device');
  assert.equal(normalizeDestination('remote'), 'off-device');
  assert.equal(normalizeDestination('this-device'), 'this-device');
  assert.equal(normalizeDestination(undefined), 'this-device');
  assert.equal(normalizeDestination('anything else'), 'this-device');
  assert.equal(normalizeDestination(null), 'this-device');
});

// ---- rule 1: sensitive values leaving the device is refused ----

await test('sensitive values plus a destination off this device is blocked', () => {
  const v = evaluatePublishSafe({ destination: 'off-device', phi: PHI_HIT, readiness: READY });
  assert.equal(v.level, 'blocked');
  assert.equal(v.blocked, true);
  assert.ok(codes(v).includes('phi-off-device'));
  assert.match(v.headline, /refusing to send/);
  assert.match(v.headline, /cannot be unshared/);
});

await test('the refusal names what was found and how much', () => {
  const v = evaluatePublishSafe({ destination: 'off-device', phi: PHI_HIT, readiness: READY });
  assert.match(v.lines[0], /3 possible sensitive values/);
  assert.match(v.lines[0], /email, ssn/);
});

await test('a single finding reads as singular', () => {
  const v = evaluatePublishSafe({
    destination: 'off-device',
    phi: { available: true, sensitiveFound: true, count: 1, patterns: ['email'] },
  });
  assert.match(v.lines[0], /1 possible sensitive value\b/);
  assert.ok(!v.lines[0].includes('1 possible sensitive values'));
});

await test('a blocked verdict never preselects including results', () => {
  const v = evaluatePublishSafe({ destination: 'off-device', phi: PHI_HIT, readiness: READY });
  assert.equal(v.preselect.includeResults, false);
});

// ---- rule 2: staying on the device is a safer default, not a refusal ----

await test('sensitive values staying on this device is caution, not a refusal', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_HIT, readiness: READY });
  assert.equal(v.level, 'caution');
  assert.equal(v.blocked, false);
  assert.ok(codes(v).includes('phi-this-device'));
  assert.match(v.lines[0], /your call/);
});

await test('a PHI hit on this device preselects leaving the results out', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_HIT, readiness: READY });
  assert.equal(v.preselect.includeResults, false);
  assert.match(v.lines[0], /preselected/);
});

await test('a clean scan does not talk the human out of including results', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR, readiness: READY });
  assert.equal(v.preselect.includeResults, true);
  assert.equal(v.level, 'clear');
  assert.match(v.headline, /Every check passed/);
});

await test('a PHI hit with results already left out still preselects nothing worse', () => {
  const v = evaluatePublishSafe({
    destination: 'this-device', phi: PHI_HIT, readiness: READY, includesResults: false,
  });
  assert.equal(v.level, 'caution');
  assert.equal(v.preselect.includeResults, true);
  assert.equal(v.checked.includesResults, false);
});

// ---- rule 3: a check that did not run is never a pass ----

await test('no PHI scan at all is a caution that says so', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', readiness: READY });
  assert.equal(v.level, 'caution');
  assert.ok(codes(v).includes('phi-unavailable'));
  assert.equal(v.checked.phi, 'unavailable');
});

await test('a PHI scan that failed to run is not read as clean', () => {
  const v = evaluatePublishSafe({
    destination: 'off-device',
    phi: { available: false, sensitiveFound: false },
    readiness: READY,
  });
  assert.equal(v.checked.phi, 'unavailable');
  assert.equal(v.level, 'caution');
});

await test('no readiness result is a caution, never a silent pass', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR });
  assert.equal(v.level, 'caution');
  assert.ok(codes(v).includes('readiness-unknown'));
  assert.equal(v.checked.readiness, 'unavailable');
});

await test('readiness not-applicable is silent, and is not the same as unavailable', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR, readiness: 'not-applicable' });
  assert.equal(v.level, 'clear');
  assert.equal(v.checked.readiness, 'not-applicable');
  assert.ok(!codes(v).includes('readiness-unknown'));
  assert.ok(!codes(v).includes('readiness-passed'));
  assert.ok(!v.lines.join(' ').toLowerCase().includes('readiness'));
});

await test('not-applicable must be said out loud, never inferred from silence', () => {
  const silent = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR });
  assert.equal(silent.checked.readiness, 'unavailable');
  assert.equal(silent.level, 'caution');
});

await test('not-applicable readiness does not excuse a PHI refusal', () => {
  const v = evaluatePublishSafe({ destination: 'off-device', phi: PHI_HIT, readiness: 'not-applicable' });
  assert.equal(v.level, 'blocked');
});

await test('an entirely empty call is a caution, not a clear', () => {
  const v = evaluatePublishSafe({});
  assert.equal(v.level, 'caution');
  assert.equal(v.blocked, false);
  assert.ok(codes(v).includes('phi-unavailable'));
  assert.ok(codes(v).includes('readiness-unknown'));
});

// ---- readiness and contracts are quality signals, not refusals ----

await test('failing readiness is a caution that names the score and the threshold', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR, readiness: NOT_READY });
  assert.equal(v.level, 'caution');
  assert.equal(v.blocked, false);
  assert.ok(codes(v).includes('readiness-failed'));
  const line = v.lines.find((l) => l.includes('Readiness scored'));
  assert.match(line, /41\/100/);
  assert.match(line, /threshold of 70/);
  assert.match(line, /1 check did not pass/);
  assert.match(line, /it is a draft/);
});

await test('failing readiness does not block even off this device, because it is not privacy', () => {
  const v = evaluatePublishSafe({ destination: 'off-device', phi: PHI_CLEAR, readiness: NOT_READY });
  assert.equal(v.level, 'caution');
  assert.equal(v.blocked, false);
});

await test('a broken metric contract is a caution that names the metric', () => {
  const v = evaluatePublishSafe({
    destination: 'this-device',
    phi: PHI_CLEAR,
    readiness: READY,
    metricContract: { ok: false, brokenMetrics: [{ name: 'Net revenue' }] },
  });
  assert.equal(v.level, 'caution');
  assert.ok(codes(v).includes('contract-broken'));
  assert.match(v.lines.join(' '), /Net revenue/);
  assert.equal(v.checked.metricContract, 'broken');
});

await test('an export with no metric contract at all is not penalised for it', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR, readiness: READY });
  assert.equal(v.level, 'clear');
  assert.equal(v.checked.metricContract, 'not-applicable');
  assert.ok(!codes(v).includes('contract-broken'));
  assert.ok(!codes(v).includes('contract-ok'));
});

await test('a healthy metric contract is reported as a passing check', () => {
  const v = evaluatePublishSafe({
    destination: 'this-device', phi: PHI_CLEAR, readiness: READY, metricContract: { ok: true },
  });
  assert.equal(v.level, 'clear');
  assert.equal(v.checked.metricContract, 'ok');
});

// ---- air gap ----

await test('Air-Gap Mode blocks a destination off this device', () => {
  const v = evaluatePublishSafe({
    destination: 'off-device', phi: PHI_CLEAR, readiness: READY, airGapActive: true,
  });
  assert.equal(v.level, 'blocked');
  assert.ok(codes(v).includes('air-gap-egress'));
  assert.match(v.lines[0], /Air-Gap Mode is on/);
});

await test('Air-Gap Mode does not block a local write, and says why', () => {
  const v = evaluatePublishSafe({
    destination: 'this-device', phi: PHI_CLEAR, readiness: READY, airGapActive: true,
  });
  assert.equal(v.level, 'clear');
  assert.equal(v.blocked, false);
  assert.ok(codes(v).includes('air-gap-local'));
  assert.match(v.lines.join(' '), /crosses no network/);
});

// ---- verdict shape ----

await test('the worst reason decides the verdict', () => {
  const v = evaluatePublishSafe({
    destination: 'off-device', phi: PHI_HIT, readiness: NOT_READY, metricContract: { ok: false },
  });
  assert.equal(v.level, 'blocked');
  assert.equal(v.lines.length, v.reasons.length);
});

await test('lines are ordered worst first, because a person reads the top', () => {
  const v = evaluatePublishSafe({
    destination: 'off-device', phi: PHI_HIT, readiness: NOT_READY, airGapActive: false,
  });
  assert.match(v.lines[0], /refused/);
  assert.match(v.lines[v.lines.length - 1], /\S/);
});

await test('the artifact name is carried into the copy', () => {
  const v = evaluatePublishSafe({
    destination: 'this-device', phi: PHI_CLEAR, readiness: READY, artifact: 'orders-report.html',
  });
  assert.equal(v.artifact, 'orders-report.html');
  assert.match(v.headline, /orders-report\.html/);
});

await test('a missing artifact name falls back to plain words, not a blank', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR, readiness: READY });
  assert.equal(v.artifact, 'this file');
  assert.match(v.headline, /this file/);
});

await test('evaluatePublishSafe never throws, whatever it is handed', () => {
  for (const bad of [null, undefined, 42, 'export', [], () => {}]) {
    const v = evaluatePublishSafe(bad);
    assert.ok(PUBLISH_SAFE_LEVELS.includes(v.level));
    assert.equal(typeof v.headline, 'string');
    assert.ok(Array.isArray(v.lines));
  }
});

await test('the verdict does not mutate its inputs', () => {
  const phi = { available: true, sensitiveFound: true, count: 2, patterns: ['email'] };
  const readiness = { agentConsumable: false, score: 50, threshold: 70, failingLayers: [] };
  const before = JSON.stringify({ phi, readiness });
  evaluatePublishSafe({ destination: 'off-device', phi, readiness });
  assert.equal(JSON.stringify({ phi, readiness }), before);
});

// ---- it accepts what the readiness gate actually produces ----

await test('a real computeReadinessGate result is read correctly when it passes', () => {
  const gate = computeReadinessGate([
    { layer: 'types', status: 'pass' },
    { layer: 'missingness', status: 'pass' },
  ], null);
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR, readiness: gate });
  assert.equal(gate.agentConsumable, true);
  assert.equal(v.checked.readiness, 'passed');
  assert.equal(v.level, 'clear');
});

await test('a real computeReadinessGate result is read correctly when it fails', () => {
  const gate = computeReadinessGate([
    { layer: 'types', status: 'fail', severity: 'high', reason: 'mixed types' },
    { layer: 'missingness', status: 'fail', severity: 'high', reason: 'gaps' },
  ], null);
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR, readiness: gate });
  assert.equal(gate.agentConsumable, false);
  assert.equal(v.checked.readiness, 'failed');
  assert.equal(v.level, 'caution');
});

await test('the gate own em dash text is never carried into a Publish-Safe line', () => {
  // computeReadinessGate's passingSummary contains U+2014. Publish-Safe must
  // compose its own sentence from the structured fields instead of reusing it.
  const gate = computeReadinessGate([{ layer: 'types', status: 'pass' }], null);
  assert.ok(gate.passingSummary.includes(EM_DASH), 'the gate really does emit an em dash');
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_CLEAR, readiness: gate });
  for (const l of v.lines) assert.ok(!l.includes(EM_DASH), `em dash leaked into: ${l}`);
  assert.ok(!v.headline.includes(EM_DASH));
});

// ---- rendering ----

await test('describePublishSafe is the headline plus every line', () => {
  const v = evaluatePublishSafe({ destination: 'this-device', phi: PHI_HIT, readiness: NOT_READY });
  const text = describePublishSafe(v);
  assert.ok(text.startsWith(v.headline));
  for (const l of v.lines) assert.ok(text.includes(l));
});

await test('describePublishSafe never throws on junk', () => {
  assert.match(describePublishSafe(null), /no verdict/);
  assert.match(describePublishSafe('verdict'), /no verdict/);
});

await test('publishSafeBadge is short, and defaults to the cautious label', () => {
  assert.deepEqual(publishSafeBadge({ level: 'blocked' }), { level: 'blocked', text: 'Refused', tone: 'danger' });
  assert.deepEqual(publishSafeBadge({ level: 'caution' }), { level: 'caution', text: 'Check first', tone: 'warn' });
  assert.deepEqual(publishSafeBadge({ level: 'clear' }), { level: 'clear', text: 'Safe to write', tone: 'ok' });
  assert.equal(publishSafeBadge(null).level, 'caution');
  assert.equal(publishSafeBadge({ level: 'made-up' }).level, 'caution');
});

// ---- no em dashes anywhere a human can see ----

await test('no string this engine produces contains an em dash', () => {
  const cases = [
    {},
    { destination: 'off-device', phi: PHI_HIT, readiness: NOT_READY, metricContract: { ok: false, brokenMetrics: ['Revenue'] }, airGapActive: true },
    { destination: 'this-device', phi: PHI_HIT, readiness: NOT_READY, metricContract: { ok: false } },
    { destination: 'this-device', phi: PHI_CLEAR, readiness: READY, metricContract: { ok: true }, airGapActive: true },
    { destination: 'off-device', phi: PHI_CLEAR, readiness: READY, airGapActive: true },
  ];
  const strings = [PUBLISH_SAFE_DISCLAIMER];
  for (const c of cases) {
    const v = evaluatePublishSafe(c);
    strings.push(v.headline, describePublishSafe(v), publishSafeBadge(v).text, ...v.lines);
  }
  for (const s of strings) {
    assert.ok(!String(s).includes(EM_DASH), `em dash found in: ${String(s).slice(0, 100)}`);
  }
});

// ---- the namespace the canvas surface reads ----

await test('DataGlowPublishSafe publishes what a canvas wire needs', () => {
  for (const key of [
    'PUBLISH_SAFE_LEVELS', 'PUBLISH_DESTINATIONS', 'PUBLISH_SAFE_DISCLAIMER',
    'normalizeDestination', 'evaluatePublishSafe', 'describePublishSafe', 'publishSafeBadge',
  ]) {
    assert.ok(key in DataGlowPublishSafe, `${key} missing from the namespace`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
