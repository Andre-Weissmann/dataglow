// ============================================================
// DATAGLOW - Tests: Explain engine (Bundle 5, A13)
// ============================================================
// js/explain/explain-engine.js composes evidence other engines already
// produced. These tests pin the promises that make it worth trusting:
//   1. it never invents certainty: a missing source is named, and it drags
//      confidence down instead of being quietly skipped
//   2. it never re-derives: with no evidence it says there is nothing to
//      explain rather than reassuring anyone
//   3. the worst thing any section found decides the headline, so skimming one
//      line cannot mislead
//   4. borrowed sentences from the older engines lose their em dashes, which is
//      the only reason those engines can be quoted at all
//   5. nothing here writes, applies or runs
//
// The sentinel and gate fixtures are fed through the REAL engines rather than
// hand-written, so if runQuerySentinel or computeReadinessGate changes shape
// these tests fail here rather than lying.
//
// RUN WITH:  node test/explain-engine.test.mjs

import assert from 'node:assert/strict';
import {
  EXPLAIN_KIND,
  EXPLAIN_VERSION,
  EXPLAIN_SOURCES,
  EXPLAIN_CONFIDENCE,
  EXPLAIN_DISCLAIMER,
  PUBLIC_API_SURFACE,
  plainText,
  explainSentinel,
  explainGate,
  explainResultShape,
  explainPhi,
  explainAirGap,
  explainPublishSafe,
  explainTrustLedger,
  explainResult,
  describeExplanation,
  explainBadge,
  DataGlowExplain,
} from '../js/explain/explain-engine.js';
import { computeReadinessGate } from '../js/gate/readiness-gate.js';
import { evaluatePublishSafe } from '../js/gate/publish-safe.js';
import { assistDeterministic } from '../js/validation/query-sentinel-assist.js';

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

/* A sentinel report shaped exactly like runQuerySentinel()'s output, carrying
   the real em dashed message text those checks produce. */
const SENTINEL_FAIL = {
  status: 'fail',
  flagCount: 1,
  flags: [{
    kind: 'FANOUT',
    severity: 'fail',
    table: 'claims',
    column: 'claim_id',
    message: '"claims" has 900 distinct "claim_id" value(s) across 1,200 row(s) '
      + EM_DASH + ' this join can multiply matching rows before the aggregate runs.',
  }],
  ts: '2026-07-25T00:00:00.000Z',
};
const SENTINEL_CLEAN = { status: 'pass', flagCount: 0, flags: [], ts: '2026-07-25T00:00:00.000Z' };
const SENTINEL_WARN = {
  status: 'warn',
  flagCount: 1,
  flags: [{ kind: 'JOIN_KEY', severity: 'warn', message: 'types do not match ' + EM_DASH + ' check the key.' }],
};

const GATE_READY = computeReadinessGate(
  [{ layer: 'types', status: 'pass', summary: 'ok' }, { layer: 'ranges', status: 'pass', summary: 'ok' }],
  null,
);
const GATE_BLOCKED = computeReadinessGate(
  [{ layer: 'types', status: 'fail', summary: 'three columns are text where numbers were expected' }],
  null,
);
const GATE_EMPTY = computeReadinessGate([], null);

function allText(exp) {
  return [exp.headline, exp.disclaimer]
    .concat(exp.sections.map((s) => s.label + ' ' + s.text))
    .concat(exp.unknowns.map((u) => u.why))
    .join('\n');
}

// ---- constants ----

await test('the kind and the source list are the contract a surface reads', () => {
  assert.equal(EXPLAIN_KIND, 'dataglow-explain');
  assert.equal(EXPLAIN_VERSION, 1);
  assert.deepEqual([...EXPLAIN_CONFIDENCE], ['well-evidenced', 'partly-evidenced', 'unevidenced']);
  assert.ok(EXPLAIN_SOURCES.includes('query-sentinel'));
  assert.ok(EXPLAIN_SOURCES.includes('readiness-gate'));
  assert.equal(EXPLAIN_SOURCES.length, 7);
});

await test('the disclaimer admits it cannot see what was not measured', () => {
  assert.match(EXPLAIN_DISCLAIMER, /cannot see/);
  assert.ok(!EXPLAIN_DISCLAIMER.includes(EM_DASH));
});

// ---- plainText, the reason older engines can be quoted at all ----

await test('plainText turns an em dash into the comma it stood in for', () => {
  assert.equal(plainText('a ' + EM_DASH + ' b'), 'a, b');
  assert.equal(plainText('a' + EM_DASH + 'b'), 'a, b');
  assert.equal(plainText('a  ' + EM_DASH + '   b'), 'a, b');
});

await test('plainText leaves an en dash out of product text too', () => {
  assert.ok(!plainText('a – b').includes('–'));
});

await test('plainText returns an empty string for anything that is not a string', () => {
  for (const v of [null, undefined, 42, {}, []]) assert.equal(plainText(v), '');
});

await test('plainText does not leave a space before the comma it inserts', () => {
  assert.ok(!plainText('word ' + EM_DASH + ' next').includes(' ,'));
});

// ---- Query Sentinel ----

await test('a clean sentinel report says what was checked, not just that it passed', () => {
  const out = explainSentinel(SENTINEL_CLEAN, []);
  assert.equal(out.level, 'good');
  assert.match(out.text, /joins that multiply rows/);
  assert.equal(out.detail.flagCount, 0);
});

await test('a failing sentinel report quotes the engine and loses the em dash', () => {
  const out = explainSentinel(SENTINEL_FAIL, []);
  assert.equal(out.level, 'bad');
  assert.match(out.text, /can change the number/);
  assert.match(out.text, /multiply matching rows/);
  assert.ok(!out.text.includes(EM_DASH), 'the borrowed message must be normalised');
});

await test('a warning is not reported as a failure', () => {
  const out = explainSentinel(SENTINEL_WARN, []);
  assert.equal(out.level, 'warn');
  assert.match(out.text, /none of them certain to be wrong/);
});

await test('the real Assist fix sketches survive the borrow, em dashes and all', () => {
  const tier1 = assistDeterministic(SENTINEL_FAIL);
  assert.ok(tier1.suggestions.length > 0, 'the assist engine should have produced a sketch');
  const out = explainSentinel(SENTINEL_FAIL, tier1.suggestions);
  assert.match(out.text, /nothing here has applied/);
  assert.match(out.text, /Pre-aggregate/);
  assert.ok(!out.text.includes(EM_DASH));
});

await test('no sentinel report means null, so the caller records an unknown', () => {
  assert.equal(explainSentinel(null), null);
  assert.equal(explainSentinel({}), null);
  assert.equal(explainSentinel({ flags: 'nope' }), null);
});

// ---- readiness gate ----

await test('a passing gate is explained from its fields, not its em dashed summary', () => {
  const out = explainGate(GATE_READY);
  assert.equal(out.level, 'good');
  assert.match(out.text, /passed this/);
  assert.match(out.text, /out of 100/);
  assert.ok(!out.text.includes(EM_DASH));
});

await test('a blocked gate names the layer that failed and why', () => {
  const out = explainGate(GATE_BLOCKED);
  assert.equal(out.level, 'bad');
  assert.match(out.text, /holding this back/);
  assert.match(out.text, /types/);
  assert.match(out.text, /text where numbers were expected/);
});

await test('a gate with no evidence is unknown, never a failure of the data', () => {
  const out = explainGate(GATE_EMPTY);
  assert.equal(out.level, 'unknown');
  assert.match(out.text, /not a finding against your data/);
});

await test('a broken metric contract is named as its own blocker', () => {
  const out = explainGate({
    agentConsumable: false, score: 40, threshold: 70,
    failingLayers: [], blockedByContract: true, evaluatedLayerCount: 2,
  });
  assert.match(out.text, /no longer matches what was agreed/);
});

// ---- result shape ----

await test('a truncated preview is called a preview', () => {
  const out = explainResultShape({ rows: 1000, columns: 12, truncated: true });
  assert.match(out.text, /1,000 rows across 12 columns/);
  assert.match(out.text, /a total of the preview/);
  assert.equal(out.level, 'warn');
});

await test('an empty result is a real answer and also a warning', () => {
  const out = explainResultShape({ rows: 0, columns: 4 });
  assert.match(out.text, /No rows came back/);
  assert.match(out.text, /filter that is too narrow/);
  assert.equal(out.level, 'warn');
});

await test('one row reads as one row', () => {
  assert.match(explainResultShape({ rows: 1, columns: 1 }).text, /1 row across 1 column\./);
});

// ---- PHI, air gap, publish safe, trust ledger ----

await test('a PHI scan that could not run is not read as clean', () => {
  assert.equal(explainPhi({ available: false }), null);
  assert.equal(explainPhi({}), null);
});

await test('a PHI hit says nothing was removed, because nothing was', () => {
  const out = explainPhi({ available: true, sensitiveFound: true, findings: [{ count: 2 }, { count: 1 }] });
  assert.match(out.text, /matched 3 possible sensitive values/);
  assert.match(out.text, /Nothing has been removed/);
  assert.equal(out.level, 'warn');
});

await test('a clean PHI scan is a good sign rather than a guarantee', () => {
  const out = explainPhi({ available: true, sensitiveFound: false, findings: [] });
  assert.equal(out.level, 'good');
  assert.match(out.text, /rather than a guarantee/);
});

await test('air gap off is unknown, not bad, because nothing here uses the network', () => {
  assert.equal(explainAirGap({ active: false }).level, 'unknown');
  assert.equal(explainAirGap({ active: true }).level, 'good');
  assert.equal(explainAirGap({}), null);
});

await test('the Publish-Safe headline is quoted, normalised, and its level mapped', () => {
  const verdict = evaluatePublishSafe({
    destination: 'this-device',
    artifact: 'this result',
    phi: { available: true, sensitiveFound: false, findings: [] },
    readiness: 'not-applicable',
  });
  const out = explainPublishSafe(verdict);
  assert.equal(out.level, 'good');
  assert.ok(out.text.length > 0);
  assert.ok(!out.text.includes(EM_DASH));
});

await test('a blocked publish verdict is bad', () => {
  assert.equal(explainPublishSafe({ level: 'blocked', headline: 'Refused.', blocked: true }).level, 'bad');
  assert.equal(explainPublishSafe({ level: 'caution', headline: 'Check.' }).level, 'warn');
});

await test('a broken trust chain is reported as bad, not as a row count', () => {
  const out = explainTrustLedger({ size: 3, valid: false });
  assert.equal(out.level, 'bad');
  assert.match(out.text, /was changed after it was written/);
});

await test('an empty trust ledger says nothing has happened yet', () => {
  const out = explainTrustLedger({ size: 0 });
  assert.equal(out.level, 'unknown');
  assert.match(out.text, /nothing that belongs on a record/);
});

// ---- composition: the promise that matters ----

await test('no evidence at all says there is nothing to explain', () => {
  const exp = explainResult({});
  assert.equal(exp.sections.length, 0);
  assert.equal(exp.confidence, 'unevidenced');
  assert.equal(exp.level, 'unknown');
  assert.match(exp.headline, /nothing to explain yet/);
  assert.match(exp.headline, /would be invented/);
  assert.equal(exp.unknowns.length, EXPLAIN_SOURCES.length);
});

await test('every unconsulted source is named with a reason a person can act on', () => {
  const exp = explainResult({ resultShape: { rows: 10, columns: 2 } });
  const named = exp.unknowns.map((u) => u.source);
  assert.ok(named.includes('query-sentinel'));
  assert.ok(named.includes('phi-shield'));
  assert.ok(!named.includes('result-shape'), 'a source that answered is not an unknown');
  for (const u of exp.unknowns) assert.match(u.why, /\S/);
});

await test('expect narrows the apology to sources the surface could have had', () => {
  const exp = explainResult({
    resultShape: { rows: 10, columns: 2 },
    expect: ['result-shape', 'phi-shield'],
  });
  assert.deepEqual(exp.unknowns.map((u) => u.source), ['phi-shield']);
  assert.equal(exp.confidence, 'partly-evidenced');
});

await test('the worst section decides the headline, so a skim cannot mislead', () => {
  const exp = explainResult({
    sentinel: SENTINEL_FAIL,
    resultShape: { rows: 10, columns: 2 },
    phi: { available: true, sensitiveFound: false, findings: [] },
    airGap: { active: true },
    expect: ['query-sentinel', 'result-shape', 'phi-shield', 'air-gap'],
  });
  assert.equal(exp.level, 'bad');
  assert.match(exp.headline, /needs your attention/);
});

await test('all sources present reads as well evidenced', () => {
  const exp = explainResult({
    subject: 'the denials query',
    sentinel: SENTINEL_CLEAN,
    resultShape: { rows: 42, columns: 5 },
    gate: GATE_READY,
    phi: { available: true, sensitiveFound: false, findings: [] },
    airGap: { active: true },
    publishSafe: { level: 'clear', headline: 'Safe to write to this device.' },
    trustLedger: { size: 2, valid: true },
  });
  assert.equal(exp.unknowns.length, 0);
  assert.equal(exp.confidence, 'well-evidenced');
  assert.equal(exp.level, 'good');
  assert.equal(exp.subject, 'the denials query');
  assert.match(exp.headline, /Every check this could ask was asked/);
  assert.equal(exp.sections.length, 7);
});

await test('the reading order is the composer order, query first', () => {
  const exp = explainResult({
    sentinel: SENTINEL_CLEAN,
    resultShape: { rows: 1, columns: 1 },
    gate: GATE_READY,
  });
  assert.deepEqual(exp.sections.map((s) => s.id), ['query-sentinel', 'result-shape', 'readiness-gate']);
});

await test('a malformed evidence bag is a missing source, never a throw', () => {
  for (const bad of [null, undefined, 'nonsense', 42, []]) {
    const exp = explainResult(bad);
    assert.equal(exp.kind, EXPLAIN_KIND);
    assert.equal(exp.sections.length, 0);
  }
  const exp = explainResult({ sentinel: { flags: [null, 3, 'x'] }, gate: { agentConsumable: 'yes' } });
  assert.ok(exp.sections.length <= 1);
});

await test('no visible string in a full explanation carries an em dash', () => {
  const tier1 = assistDeterministic(SENTINEL_FAIL);
  const exp = explainResult({
    sentinel: SENTINEL_FAIL,
    sentinelSuggestions: tier1.suggestions,
    resultShape: { rows: 1200, columns: 14, truncated: true },
    gate: GATE_BLOCKED,
    phi: { available: true, sensitiveFound: true, findings: [{ count: 2 }] },
    airGap: { active: false },
    publishSafe: { level: 'caution', headline: 'Check this before you hand it over.' },
    trustLedger: { size: 1, valid: true },
  });
  assert.ok(!allText(exp).includes(EM_DASH), 'an em dash reached product text');
  assert.ok(!describeExplanation(exp).includes(EM_DASH));
});

// ---- rendering ----

await test('the copied text carries the headline, every section and the unknowns', () => {
  const exp = explainResult({ resultShape: { rows: 3, columns: 3 }, expect: ['result-shape', 'phi-shield'] });
  const text = describeExplanation(exp);
  assert.match(text, /^Explain: this result/);
  assert.match(text, /What is on screen: /);
  assert.match(text, /Not known:/);
  assert.match(text, /PHI Shield has not scanned this/);
  assert.ok(text.endsWith(EXPLAIN_DISCLAIMER));
});

await test('rendering something that is not an explanation says so', () => {
  assert.equal(describeExplanation(null), 'No explanation to show.');
});

await test('the badge is short enough for a chip and never claims a clean bill', () => {
  assert.equal(explainBadge({ level: 'bad' }).text, 'Needs a look');
  assert.equal(explainBadge({ level: 'warn' }).text, 'Read this');
  assert.equal(explainBadge({ level: 'good' }).text, 'Checks held');
  assert.equal(explainBadge({}).text, 'Little is known');
  assert.equal(explainBadge(null).level, 'unknown');
});

// ---- the read-only guarantee ----

await test('the public surface explains and nothing else', () => {
  assert.deepEqual([...PUBLIC_API_SURFACE], [
    'plainText', 'explainSentinel', 'explainGate', 'explainResultShape', 'explainPhi',
    'explainAirGap', 'explainPublishSafe', 'explainTrustLedger', 'explainResult',
    'describeExplanation', 'explainBadge',
  ]);
  for (const name of PUBLIC_API_SURFACE) {
    assert.ok(!/^(apply|write|mutate|run|execute|save|delete)/.test(name), `${name} sounds like an action`);
  }
});

await test('DataGlowExplain publishes everything a canvas wire needs', () => {
  for (const key of PUBLIC_API_SURFACE.concat(['EXPLAIN_SOURCES', 'EXPLAIN_DISCLAIMER', 'EXPLAIN_VERSION'])) {
    assert.ok(key in DataGlowExplain, `${key} missing from the namespace`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
