// ============================================================
// DATAGLOW - Tests: Trust Ledger (Bundle 4, A10)
// ============================================================
// Plain node, no DOM/DuckDB/network: js/provenance/trust-ledger.js is pure JS
// plus Web Crypto (crypto.subtle is global in Node), exactly like
// test/ai-touch-ledger.test.mjs tests its module.
//
// The pin that matters most here is the last suite: trust-ledger.js restates
// sha256Hex instead of importing it from provenance.js, because the canvas
// surface inlines the module into a single <script> where ESM imports do not
// resolve. That duplication is only safe if a test digests the same inputs
// through both copies and fails when they diverge. That test lives below.

import assert from 'node:assert/strict';
import {
  TRUST_LEDGER_KIND,
  TRUST_LEDGER_VERSION,
  TRUST_EVENT_KINDS,
  TRUST_EVENT_LABELS,
  TRUST_OUTCOMES,
  TRUST_LEDGER_DISCLAIMER,
  GENESIS_PARENT,
  sha256Hex,
  validateTrustEvent,
  createTrustLedger,
  verifyTrustLedger,
  formatTrustTime,
  describeTrustEntry,
  summarizeTrustLedger,
  countTrustKinds,
  exportTrustLedger,
  fromReadinessGate,
  fromContractVersion,
  fromPublishSafe,
  DataGlowTrustLedger,
} from '../js/provenance/trust-ledger.js';
import { sha256Hex as provenanceSha256Hex, GENESIS_PARENT as PROVENANCE_GENESIS } from '../js/provenance/provenance.js';

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

// ---- constants ----

await test('the event vocabulary is closed and named', () => {
  assert.deepEqual([...TRUST_EVENT_KINDS].sort(), [
    'export-attempt', 'gate-verdict', 'metric-contract-version', 'validation-run',
  ]);
  for (const kind of TRUST_EVENT_KINDS) {
    assert.equal(typeof TRUST_EVENT_LABELS[kind], 'string', `${kind} needs a label`);
    assert.ok(TRUST_EVENT_LABELS[kind].length > 0);
  }
});

await test('outcomes carry Publish-Safe levels plus a neutral recorded', () => {
  for (const level of ['clear', 'caution', 'blocked']) {
    assert.ok(TRUST_OUTCOMES.includes(level), `${level} must be a valid outcome`);
  }
  assert.ok(TRUST_OUTCOMES.includes('recorded'));
});

await test('kind and version identify the export format', () => {
  assert.equal(TRUST_LEDGER_KIND, 'dataglow-trust-ledger');
  assert.equal(TRUST_LEDGER_VERSION, 1);
});

await test('the disclaimer refuses the claims this ledger cannot make', () => {
  assert.match(TRUST_LEDGER_DISCLAIMER, /does not certify/i);
  assert.match(TRUST_LEDGER_DISCLAIMER, /not a zero-knowledge proof/i);
  assert.match(TRUST_LEDGER_DISCLAIMER, /SHA-256/);
});

// ---- validation: never throws ----

await test('validateTrustEvent refuses a kind outside the vocabulary', () => {
  const r = validateTrustEvent({ kind: 'anything-at-all', summary: 'x' });
  assert.equal(r.valid, false);
  assert.match(r.reason, /event\.kind must be one of/);
});

await test('validateTrustEvent requires a plain-language summary', () => {
  assert.equal(validateTrustEvent({ kind: 'validation-run' }).valid, false);
  assert.equal(validateTrustEvent({ kind: 'validation-run', summary: '   ' }).valid, false);
  assert.equal(validateTrustEvent({ kind: 'validation-run', summary: 'It ran.' }).valid, true);
});

await test('validateTrustEvent refuses an outcome it cannot honestly display', () => {
  const r = validateTrustEvent({ kind: 'gate-verdict', summary: 'x', outcome: 'probably-fine' });
  assert.equal(r.valid, false);
  assert.match(r.reason, /event\.outcome must be one of/);
});

await test('validateTrustEvent never throws on hostile input', () => {
  for (const bad of [null, undefined, 42, 'string', [], () => {}, NaN]) {
    const r = validateTrustEvent(bad);
    assert.equal(r.valid, false);
    assert.equal(typeof r.reason, 'string');
  }
});

// ---- the chain ----

await test('the first entry anchors on the shared genesis parent', async () => {
  const ledger = createTrustLedger();
  const e = await ledger.record({ kind: 'validation-run', summary: 'Ran all layers.' });
  assert.equal(e.parentHash, GENESIS_PARENT);
  assert.equal(GENESIS_PARENT.length, 64);
});

await test('genesis matches provenance.js so every ledger anchors identically', () => {
  assert.equal(GENESIS_PARENT, PROVENANCE_GENESIS);
});

await test('each entry carries the hash of the one before it', async () => {
  const ledger = createTrustLedger();
  const a = await ledger.record({ kind: 'validation-run', summary: 'First.' });
  const b = await ledger.record({ kind: 'gate-verdict', summary: 'Second.' });
  const c = await ledger.record({ kind: 'export-attempt', summary: 'Third.' });
  assert.equal(b.parentHash, a.hash);
  assert.equal(c.parentHash, b.hash);
  assert.deepEqual([a.index, b.index, c.index], [0, 1, 2]);
});

await test('an intact chain verifies and says how many rows', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'One.' });
  await ledger.record({ kind: 'gate-verdict', summary: 'Two.' });
  const v = await verifyTrustLedger(ledger.getEntries());
  assert.equal(v.valid, true);
  assert.equal(v.brokenAt, -1);
  assert.match(v.reason, /All 2 rows verified/);
});

await test('an empty ledger verifies without pretending it proved something', async () => {
  const v = await verifyTrustLedger([]);
  assert.equal(v.valid, true);
  assert.match(v.reason, /nothing to verify/i);
});

await test('editing a row after the fact breaks the chain at that row', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'Honest.' });
  await ledger.record({ kind: 'gate-verdict', summary: 'Also honest.' });
  await ledger.record({ kind: 'export-attempt', summary: 'Third.' });
  const rows = ledger.getEntries();
  rows[1] = { ...rows[1], summary: 'Rewritten later.' };
  const v = await verifyTrustLedger(rows);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 1);
  assert.match(v.reason, /Row 2 has been changed/);
});

await test('changing a detail value breaks the chain, because details are hashed', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'gate-verdict', summary: 'Scored.', detail: { score: 71 } });
  const rows = ledger.getEntries();
  rows[0] = { ...rows[0], detail: { score: 99 } };
  const v = await verifyTrustLedger(rows);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 0);
});

await test('removing a row breaks the chain', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'One.' });
  await ledger.record({ kind: 'validation-run', summary: 'Two.' });
  await ledger.record({ kind: 'validation-run', summary: 'Three.' });
  const rows = ledger.getEntries();
  rows.splice(1, 1);
  const v = await verifyTrustLedger(rows);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 1);
  assert.match(v.reason, /does not follow from the row before it/);
});

await test('reordering rows breaks the chain', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'One.' });
  await ledger.record({ kind: 'gate-verdict', summary: 'Two.' });
  const rows = ledger.getEntries();
  const v = await verifyTrustLedger([rows[1], rows[0]]);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 0);
});

await test('verifyTrustLedger never throws on non-arrays', async () => {
  for (const bad of [null, undefined, 42, {}, 'rows']) {
    const v = await verifyTrustLedger(bad);
    assert.equal(v.valid, false);
    assert.equal(typeof v.reason, 'string');
  }
});

await test('key order in the recorded event does not change the hash', async () => {
  const a = createTrustLedger();
  const b = createTrustLedger();
  const ea = await a.record({ kind: 'gate-verdict', summary: 'Same.', ts: 1700000000000, detail: { x: 1, y: 2 } });
  const eb = await b.record({ detail: { y: 2, x: 1 }, ts: 1700000000000, summary: 'Same.', kind: 'gate-verdict' });
  assert.equal(ea.hash, eb.hash);
});

// ---- malformed input is recorded, not dropped ----

await test('a malformed event is appended as a rejected row rather than lost', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'Good.' });
  const bad = await ledger.record({ kind: 'not-a-kind', summary: 'Tried.' });
  assert.equal(bad.rejected, true);
  assert.equal(typeof bad.reason, 'string');
  assert.equal(ledger.size, 2);
  assert.equal(bad.parentHash, ledger.getEntries()[0].hash);
});

await test('record never throws, even on input that is not an object', async () => {
  const ledger = createTrustLedger();
  for (const bad of [null, undefined, 7, 'nope', []]) {
    const e = await ledger.record(bad);
    assert.equal(e.rejected, true);
  }
  assert.equal(ledger.size, 5);
});

await test('rejected rows are part of the chain and verify like any other row', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'Good.' });
  await ledger.record({ kind: 'bogus', summary: 'Bad.' });
  await ledger.record({ kind: 'gate-verdict', summary: 'Good again.' });
  const v = await verifyTrustLedger(ledger.getEntries());
  assert.equal(v.valid, true);
});

await test('a rejected row cannot be silently rewritten either', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'bogus', summary: 'Bad.' });
  const rows = ledger.getEntries();
  rows[0] = { ...rows[0], reason: 'nothing to see here' };
  const v = await verifyTrustLedger(rows);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 0);
});

// ---- defaults ----

await test('a recorded event gets honest defaults for actor and outcome', async () => {
  const ledger = createTrustLedger();
  const e = await ledger.record({ kind: 'validation-run', summary: 'Ran.' });
  assert.equal(e.outcome, 'recorded');
  assert.equal(e.actor, 'you');
  assert.deepEqual(e.detail, {});
  assert.equal(e.subject, null);
  assert.ok(Number.isFinite(e.ts));
});

await test('an explicit timestamp is honoured so replayed history keeps its order', async () => {
  const ledger = createTrustLedger();
  const e = await ledger.record({ kind: 'validation-run', summary: 'Then.', ts: 1600000000000 });
  assert.equal(e.ts, 1600000000000);
});

await test('getEntries hands back a copy, so a caller cannot mutate the chain', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'One.' });
  const rows = ledger.getEntries();
  rows.push({ index: 99 });
  assert.equal(ledger.size, 1);
});

await test('clear empties the ledger for a new session', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'One.' });
  ledger.clear();
  assert.equal(ledger.size, 0);
  const e = await ledger.record({ kind: 'validation-run', summary: 'Fresh.' });
  assert.equal(e.parentHash, GENESIS_PARENT);
});

// ---- human-readable output ----

await test('formatTrustTime is a plain UTC stamp, and says so when it cannot be', () => {
  assert.equal(formatTrustTime(0), '1970-01-01 00:00:00 UTC');
  assert.equal(formatTrustTime(NaN), 'unknown time');
  assert.equal(formatTrustTime(undefined), 'unknown time');
});

await test('describeTrustEntry reads as a sentence a person could say out loud', async () => {
  const ledger = createTrustLedger();
  const e = await ledger.record({
    kind: 'gate-verdict',
    subject: 'orders.csv',
    summary: 'Readiness did not pass',
    outcome: 'blocked',
    ts: 1700000000000,
  });
  const line = describeTrustEntry(e);
  assert.match(line, /Gate verdict/);
  assert.match(line, /for orders\.csv/);
  assert.match(line, /Readiness did not pass\./);
  assert.match(line, /Outcome: blocked\./);
});

await test('describeTrustEntry does not append a redundant recorded outcome', async () => {
  const ledger = createTrustLedger();
  const e = await ledger.record({ kind: 'validation-run', summary: 'Ran all layers.' });
  assert.ok(!describeTrustEntry(e).includes('Outcome:'));
});

await test('describeTrustEntry explains a refused row instead of hiding it', async () => {
  const ledger = createTrustLedger();
  const e = await ledger.record({ kind: 'bogus', summary: 'Bad.' });
  const line = describeTrustEntry(e);
  assert.match(line, /refused/);
  assert.match(line, /kept here so nothing is lost/);
});

await test('describeTrustEntry never throws on an unreadable row', () => {
  assert.equal(describeTrustEntry(null), 'Unreadable row.');
  assert.equal(describeTrustEntry('row'), 'Unreadable row.');
});

await test('summarizeTrustLedger counts what a person would want to know first', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'Ran.' });
  await ledger.record({ kind: 'export-attempt', summary: 'Blocked.', outcome: 'blocked' });
  await ledger.record({ kind: 'export-attempt', summary: 'Careful.', outcome: 'caution' });
  await ledger.record({ kind: 'bogus', summary: 'Bad.' });
  const s = summarizeTrustLedger(ledger.getEntries());
  assert.match(s, /4 rows recorded this session/);
  assert.match(s, /1 blocked/);
  assert.match(s, /1 needed care/);
  assert.match(s, /1 refused as malformed/);
});

await test('summarizeTrustLedger says nothing was blocked when nothing was', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'Ran.' });
  assert.match(summarizeTrustLedger(ledger.getEntries()), /nothing was blocked/);
});

await test('summarizeTrustLedger is honest about an empty session', () => {
  assert.match(summarizeTrustLedger([]), /No trust events recorded yet/);
  assert.match(summarizeTrustLedger(null), /No trust events recorded yet/);
});

await test('countTrustKinds reports every kind, including the zeroes', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'One.' });
  await ledger.record({ kind: 'validation-run', summary: 'Two.' });
  await ledger.record({ kind: 'bogus', summary: 'Bad.' });
  const counts = countTrustKinds(ledger.getEntries());
  assert.equal(counts['validation-run'], 2);
  assert.equal(counts['export-attempt'], 0);
  assert.equal(counts['gate-verdict'], 0);
  assert.equal(counts['metric-contract-version'], 0);
  assert.deepEqual(Object.keys(counts).sort(), [...TRUST_EVENT_KINDS].sort());
});

// ---- exports ----

await test('exportTrustLedger json carries kind, version and the disclaimer', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'Ran.' });
  const parsed = JSON.parse(exportTrustLedger(ledger.getEntries(), 'json'));
  assert.equal(parsed.kind, TRUST_LEDGER_KIND);
  assert.equal(parsed.version, TRUST_LEDGER_VERSION);
  assert.equal(parsed.disclaimer, TRUST_LEDGER_DISCLAIMER);
  assert.equal(parsed.entries.length, 1);
  assert.equal(typeof parsed.entries[0].hash, 'string');
});

await test('a json export round-trips back through verifyTrustLedger', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'One.', detail: { rows: 1200 } });
  await ledger.record({ kind: 'bogus', summary: 'Bad.' });
  await ledger.record({ kind: 'gate-verdict', summary: 'Two.', outcome: 'clear' });
  const parsed = JSON.parse(exportTrustLedger(ledger.getEntries(), 'json'));
  const v = await verifyTrustLedger(parsed.entries);
  assert.equal(v.valid, true, v.reason);
});

await test('exportTrustLedger markdown is a table a human can paste anywhere', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'export-attempt', subject: 'report.html', summary: 'Offered.', outcome: 'caution' });
  const md = exportTrustLedger(ledger.getEntries(), 'markdown');
  assert.match(md, /# DataGlow Trust Ledger/);
  assert.match(md, /\| Time \(UTC\) \| Event \| Subject \| What happened \| Outcome \|/);
  assert.match(md, /report\.html/);
  assert.match(md, /caution/);
});

await test('exportTrustLedger markdown says plainly when there is nothing yet', () => {
  assert.match(exportTrustLedger([], 'markdown'), /No trust events recorded yet/);
});

await test('exportTrustLedger text is the readable rows, oldest first', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', summary: 'Older.', ts: 1600000000000 });
  await ledger.record({ kind: 'gate-verdict', summary: 'Newer.', ts: 1700000000000 });
  const text = exportTrustLedger(ledger.getEntries(), 'text');
  assert.ok(text.indexOf('Older.') < text.indexOf('Newer.'));
});

// ---- composers ----

await test('fromReadinessGate turns a passing verdict into a clear row', () => {
  const ev = fromReadinessGate({ agentConsumable: true, score: 88, threshold: 70, failingLayers: [] });
  assert.equal(validateTrustEvent(ev).valid, true);
  assert.equal(ev.kind, 'gate-verdict');
  assert.equal(ev.outcome, 'clear');
  assert.match(ev.summary, /Readiness passed with a score of 88\/100/);
  assert.equal(ev.detail.score, 88);
});

await test('fromReadinessGate reports a failing verdict as blocked, with the reasons', () => {
  const ev = fromReadinessGate({
    agentConsumable: false,
    score: 41,
    threshold: 70,
    blockedByContract: true,
    failingLayers: [{ layer: 'missingness' }, { layer: 'types' }],
  }, { subject: 'orders.csv' });
  assert.equal(ev.outcome, 'blocked');
  assert.equal(ev.subject, 'orders.csv');
  assert.match(ev.summary, /did not pass/);
  assert.match(ev.summary, /metric contract is broken/);
  assert.match(ev.summary, /2 checks failing/);
  assert.equal(ev.detail.failingLayers, 'missingness, types');
  assert.equal(ev.detail.blockedByContract, true);
});

await test('fromReadinessGate does not carry the gate own em dash text into the ledger', () => {
  // js/gate/readiness-gate.js's passingSummary contains U+2014, which product
  // text here must never show. This asserts the composer rebuilt the sentence.
  const ev = fromReadinessGate({
    agentConsumable: true, score: 90, threshold: 70, failingLayers: [],
    passingSummary: `Ready for agent use ${EM_DASH} score 90/100`,
  });
  assert.ok(!ev.summary.includes(EM_DASH), 'summary must not contain an em dash');
});

await test('fromReadinessGate never throws on junk', () => {
  for (const bad of [null, undefined, 42, 'gate']) {
    const ev = fromReadinessGate(bad);
    assert.equal(ev.kind, 'gate-verdict');
    assert.equal(typeof ev.summary, 'string');
  }
});

await test('fromContractVersion records a human edit with its reason', () => {
  const ev = fromContractVersion({
    version: 3,
    source: 'human',
    reason: 'Excluded refunded orders',
    changedBy: 'ana',
    changedAt: 1700000000000,
    snapshot: { name: 'Net revenue', expression: 'SUM(amount)' },
  }, { metricId: 'm-1' });
  assert.equal(validateTrustEvent(ev).valid, true);
  assert.equal(ev.kind, 'metric-contract-version');
  assert.equal(ev.subject, 'Net revenue');
  assert.equal(ev.actor, 'ana');
  assert.equal(ev.ts, 1700000000000);
  assert.match(ev.summary, /Version 3 of this definition was recorded by a human edit/);
  assert.match(ev.summary, /Reason given: Excluded refunded orders/);
  assert.equal(ev.detail.expression, 'SUM(amount)');
  assert.equal(ev.detail.metricId, 'm-1');
});

await test('fromContractVersion says a proposal was approved, never that AI changed it', () => {
  const ev = fromContractVersion({ version: 2, source: 'agent-proposed', snapshot: { name: 'Churn' } });
  assert.match(ev.summary, /after a human approved a proposed change/);
  assert.equal(ev.detail.source, 'agent-proposed');
});

await test('fromPublishSafe carries the verdict level through unchanged', () => {
  const ev = fromPublishSafe({
    level: 'blocked',
    destination: 'off-device',
    headline: 'Sensitive values were found, so this cannot leave the device.',
    checked: { phiFound: true },
  }, { artifact: 'report.html' });
  assert.equal(validateTrustEvent(ev).valid, true);
  assert.equal(ev.kind, 'export-attempt');
  assert.equal(ev.outcome, 'blocked');
  assert.equal(ev.subject, 'report.html');
  assert.match(ev.summary, /somewhere off this device/);
  assert.match(ev.summary, /cannot leave the device/);
  assert.equal(ev.detail.phiFound, true);
});

await test('fromPublishSafe cannot soften an unknown level into a clear', () => {
  const ev = fromPublishSafe({ level: 'totally-fine', destination: 'this-device' });
  assert.equal(ev.outcome, 'caution');
});

await test('fromPublishSafe distinguishes an offer from a completed write', () => {
  const offered = fromPublishSafe({ level: 'clear', destination: 'this-device', headline: 'Nothing found.' }, {});
  const done = fromPublishSafe({ level: 'clear', destination: 'this-device', headline: 'Nothing found.' }, {
    completed: true, bytes: 4096, includedResults: false,
  });
  assert.match(offered.summary, /^Offered to write to this device\./);
  assert.match(done.summary, /^Written to this device\./);
  assert.equal(done.detail.bytes, 4096);
  assert.equal(done.detail.includedResults, false);
  assert.equal(offered.detail.includedResults, null);
});

await test('every composer produces an event this ledger will actually accept', async () => {
  const ledger = createTrustLedger();
  const events = [
    fromReadinessGate({ agentConsumable: false, score: 10, threshold: 70, failingLayers: [] }),
    fromContractVersion({ version: 1, snapshot: { name: 'Revenue' } }),
    fromPublishSafe({ level: 'caution', destination: 'this-device', headline: 'Check first.' }),
  ];
  for (const ev of events) {
    const e = await ledger.record(ev);
    assert.equal(e.rejected, false, `${ev.kind} should not be rejected`);
  }
  assert.equal((await verifyTrustLedger(ledger.getEntries())).valid, true);
});

// ---- no em dashes anywhere a human can see ----

await test('no product string this module produces contains an em dash', async () => {
  const ledger = createTrustLedger();
  await ledger.record({ kind: 'validation-run', subject: 'orders.csv', summary: 'Ran all layers.' });
  await ledger.record({ kind: 'export-attempt', summary: 'Blocked.', outcome: 'blocked' });
  await ledger.record({ kind: 'bogus', summary: 'Bad.' });
  const rows = ledger.getEntries();
  const strings = [
    TRUST_LEDGER_DISCLAIMER,
    ...Object.values(TRUST_EVENT_LABELS),
    summarizeTrustLedger(rows),
    ...rows.map(describeTrustEntry),
    exportTrustLedger(rows, 'json'),
    exportTrustLedger(rows, 'markdown'),
    exportTrustLedger(rows, 'text'),
    exportTrustLedger([], 'markdown'),
    (await verifyTrustLedger(rows)).reason,
    validateTrustEvent({}).reason,
    validateTrustEvent({ kind: 'validation-run' }).reason,
  ];
  for (const s of strings) {
    assert.ok(!String(s).includes(EM_DASH), `em dash found in: ${String(s).slice(0, 90)}`);
  }
});

// ---- the drift pin: this copy of sha256Hex against provenance.js's ----

await test('sha256Hex matches provenance.js digest for digest, so the two cannot drift', async () => {
  const inputs = [
    '',
    'a',
    'dataglow',
    GENESIS_PARENT,
    JSON.stringify({ kind: 'gate-verdict', score: 88 }),
    'a'.repeat(4096),
    'unicode: éü中文 \u{1F512}',
    '{"parentHash":"' + GENESIS_PARENT + '","ts":1700000000000}',
  ];
  for (const input of inputs) {
    const mine = await sha256Hex(input);
    const theirs = await provenanceSha256Hex(input);
    assert.equal(mine, theirs, `digest drift on input of length ${input.length}`);
    assert.match(mine, /^[0-9a-f]{64}$/);
  }
});

await test('sha256Hex is a known-answer SHA-256, not merely self-consistent', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    await sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

// ---- the namespace the canvas surface reads ----

await test('DataGlowTrustLedger publishes everything the canvas wire needs', () => {
  for (const key of [
    'TRUST_EVENT_KINDS', 'TRUST_EVENT_LABELS', 'TRUST_OUTCOMES', 'TRUST_LEDGER_DISCLAIMER',
    'GENESIS_PARENT', 'sha256Hex', 'validateTrustEvent', 'createTrustLedger', 'verifyTrustLedger',
    'formatTrustTime', 'describeTrustEntry', 'summarizeTrustLedger', 'countTrustKinds',
    'exportTrustLedger', 'fromReadinessGate', 'fromContractVersion', 'fromPublishSafe',
  ]) {
    assert.ok(key in DataGlowTrustLedger, `${key} missing from the namespace`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
