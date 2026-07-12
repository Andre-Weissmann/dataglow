// ============================================================
// DATAGLOW — Tests: AI Touch Ledger (Batch 1)
// ============================================================
// Plain node, no DOM/DuckDB/network needed — js/provenance/ai-touch-ledger.js
// is pure JS + Web Crypto (crypto.subtle, available in Node's global scope),
// exactly like test/verifiable-check-seal.test.mjs tests its module. Covers
// the hash-chain integrity guarantee, the on-device/external distinction,
// the never-throws contract on malformed input, and the export formats.

import assert from 'node:assert/strict';
import {
  createTouchLedger,
  verifyTouchLedger,
  summarizeTouchLedger,
  exportTouchLedger,
  validateTouch,
  TOUCH_LOCATIONS,
  GENESIS_PARENT,
  TOUCH_LEDGER_KIND,
  TOUCH_LEDGER_VERSION,
  TOUCH_LEDGER_DISCLAIMER,
} from '../js/provenance/ai-touch-ledger.js';

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

// ---- constants / exports ----

await test('TOUCH_LOCATIONS exposes exactly ondevice + external', () => {
  assert.deepEqual([...TOUCH_LOCATIONS].sort(), ['external', 'ondevice']);
});

await test('GENESIS_PARENT is a 64-char zero string matching provenance.js convention', () => {
  assert.equal(GENESIS_PARENT, '0'.repeat(64));
  assert.equal(GENESIS_PARENT.length, 64);
});

await test('TOUCH_LEDGER_KIND / VERSION / DISCLAIMER are stable and honestly worded', () => {
  assert.equal(TOUCH_LEDGER_KIND, 'dataglow-ai-touch-ledger');
  assert.equal(TOUCH_LEDGER_VERSION, 1);
  assert.match(TOUCH_LEDGER_DISCLAIMER, /NOT a zero-knowledge proof/);
  assert.match(TOUCH_LEDGER_DISCLAIMER, /NOT "blockchain"/);
});

// ---- validateTouch ----

await test('validateTouch: rejects non-objects', () => {
  assert.equal(validateTouch(null).valid, false);
  assert.equal(validateTouch('nope').valid, false);
  assert.equal(validateTouch([]).valid, false);
});

await test('validateTouch: requires a non-empty model string', () => {
  const r = validateTouch({ location: 'ondevice' });
  assert.equal(r.valid, false);
  assert.match(r.reason, /model/);
});

await test('validateTouch: requires location to be ondevice or external', () => {
  const r = validateTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'cloud' });
  assert.equal(r.valid, false);
  assert.match(r.reason, /ondevice, external/);
});

await test('validateTouch: external location requires sentTo', () => {
  const r = validateTouch({ model: 'Claude', location: 'external' });
  assert.equal(r.valid, false);
  assert.match(r.reason, /sentTo/);
});

await test('validateTouch: valid ondevice touch passes with no sentTo required', () => {
  const r = validateTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['claim_status'] });
  assert.equal(r.valid, true);
});

await test('validateTouch: valid external touch requires sentTo, which is honored', () => {
  const r = validateTouch({ model: 'Anthropic API (Claude)', location: 'external', sentTo: 'api.anthropic.com' });
  assert.equal(r.valid, true);
});

// ---- createTouchLedger / logTouch / hash chaining ----

await test('logTouch: genesis entry chains from GENESIS_PARENT', async () => {
  const ledger = createTouchLedger();
  const e = await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['claim_status', 'paid_amount'], triggeredBy: 'analyst (you)', action: 'Story Engine synthesis' });
  assert.equal(e.parentHash, GENESIS_PARENT);
  assert.equal(typeof e.hash, 'string');
  assert.equal(e.hash.length, 64);
  assert.equal(e.rejected, false);
  assert.equal(e.index, 0);
});

await test('logTouch: second entry chains from the first entry\'s hash', async () => {
  const ledger = createTouchLedger();
  const e1 = await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['admission_type'] });
  const e2 = await ledger.logTouch({ model: 'Anthropic API (Claude, external provider)', location: 'external', sentTo: 'api.anthropic.com', fieldsTouched: ['patient_id', 'diagnosis_code'] });
  assert.equal(e2.parentHash, e1.hash);
  assert.notEqual(e1.hash, e2.hash);
});

await test('logTouch: same inputs at the same ts produce the same hash (deterministic)', async () => {
  const ts = 1752349263000;
  const ledgerA = createTouchLedger();
  const ledgerB = createTouchLedger();
  const eA = await ledgerA.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['b', 'a'], ts });
  const eB = await ledgerB.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['a', 'b'], ts });
  assert.equal(eA.hash, eB.hash, 'field order should not change the hash — canonical payload sorts fieldsTouched');
});

await test('logTouch: never throws on malformed input — records a rejected entry instead', async () => {
  const ledger = createTouchLedger();
  const e = await ledger.logTouch({ model: '', location: 'nowhere' });
  assert.equal(e.rejected, true);
  assert.equal(typeof e.reason, 'string');
  assert.equal(typeof e.hash, 'string');
  assert.equal(e.parentHash, GENESIS_PARENT);
});

await test('logTouch: a rejected entry still occupies a real chain slot future entries link from', async () => {
  const ledger = createTouchLedger();
  const rejected = await ledger.logTouch({ model: null, location: 'external' });
  const good = await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice' });
  assert.equal(good.parentHash, rejected.hash);
});

await test('getEntries returns a copy, not the live array', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice' });
  const snapshot = ledger.getEntries();
  snapshot.push({ fake: true });
  assert.equal(ledger.getEntries().length, 1);
});

await test('clear empties the ledger', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice' });
  ledger.clear();
  assert.equal(ledger.getEntries().length, 0);
});

// ---- verifyTouchLedger ----

await test('verifyTouchLedger: empty array is valid (nothing to verify)', async () => {
  const r = await verifyTouchLedger([]);
  assert.equal(r.valid, true);
});

await test('verifyTouchLedger: rejects non-array input without throwing', async () => {
  const r = await verifyTouchLedger('not an array');
  assert.equal(r.valid, false);
});

await test('verifyTouchLedger: a freshly logged chain of 3 (matching the concept mockup) verifies intact', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['claim_status', 'paid_amount', 'denial_reason'], triggeredBy: 'analyst (you)', action: 'Story Engine synthesis' });
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['admission_type', 'length_of_stay'], triggeredBy: 'analyst (you)', action: 'Validate -> AI Synthesis' });
  await ledger.logTouch({ model: 'Anthropic API (Claude, external provider)', location: 'external', sentTo: 'api.anthropic.com', fieldsTouched: ['patient_id', 'diagnosis_code', 'paid_amount'], triggeredBy: 'analyst (you)', action: 'Story Engine' });
  const entries = ledger.getEntries();
  const result = await verifyTouchLedger(entries);
  assert.equal(result.valid, true);
  assert.match(result.reason, /All 3 entr/);
});

await test('verifyTouchLedger: detects a tampered field (e.g. model name silently swapped)', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['claim_status'] });
  await ledger.logTouch({ model: 'Anthropic API (Claude)', location: 'external', sentTo: 'api.anthropic.com', fieldsTouched: ['patient_id'] });
  const entries = ledger.getEntries();
  entries[0].model = 'Some other model entirely';
  const result = await verifyTouchLedger(entries);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 0);
});

await test('verifyTouchLedger: detects a deleted middle entry (chain link breaks)', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice' });
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice' });
  await ledger.logTouch({ model: 'Anthropic API (Claude)', location: 'external', sentTo: 'api.anthropic.com' });
  const entries = ledger.getEntries();
  entries.splice(1, 1); // delete the middle entry
  const result = await verifyTouchLedger(entries);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1, 'the third entry now sits where the second was and its parentHash no longer matches');
});

await test('verifyTouchLedger: detects reordering (swap two entries)', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'A', location: 'ondevice' });
  await ledger.logTouch({ model: 'B', location: 'ondevice' });
  const entries = ledger.getEntries();
  [entries[0], entries[1]] = [entries[1], entries[0]];
  const result = await verifyTouchLedger(entries);
  assert.equal(result.valid, false);
});

await test('verifyTouchLedger: a rejected entry preserved verbatim still verifies intact', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: '', location: 'bogus' });
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice' });
  const result = await verifyTouchLedger(ledger.getEntries());
  assert.equal(result.valid, true);
});

// ---- summarizeTouchLedger ----

await test('summarizeTouchLedger: empty ledger', () => {
  assert.match(summarizeTouchLedger([]), /No AI touches recorded/);
});

await test('summarizeTouchLedger: all on-device, no external flag mentioned as present', () => {
  const s = summarizeTouchLedger([
    { rejected: false, location: 'ondevice' },
    { rejected: false, location: 'ondevice' },
  ]);
  assert.match(s, /all touches stayed on-device/);
});

await test('summarizeTouchLedger: mixed chain flags the external count (mockup scenario: 3 total, 1 external)', () => {
  const s = summarizeTouchLedger([
    { rejected: false, location: 'ondevice' },
    { rejected: false, location: 'ondevice' },
    { rejected: false, location: 'external' },
  ]);
  assert.match(s, /3 of 3 entries intact/);
  assert.match(s, /1 external-provider touch flagged below/);
});

await test('summarizeTouchLedger: counts rejected entries separately from intact ones', () => {
  const s = summarizeTouchLedger([
    { rejected: true },
    { rejected: false, location: 'ondevice' },
  ]);
  assert.match(s, /1 of 2 entries intact/);
  assert.match(s, /1 rejected entry/);
});

// ---- exportTouchLedger ----

await test('exportTouchLedger: json format round-trips entries verbatim', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['x'] });
  const json = exportTouchLedger(ledger.getEntries(), 'json');
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, TOUCH_LEDGER_KIND);
  assert.equal(parsed.entries.length, 1);
});

await test('exportTouchLedger: markdown format produces a table row per entry', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice', fieldsTouched: ['claim_status'], triggeredBy: 'analyst (you)' });
  const md = exportTouchLedger(ledger.getEntries(), 'markdown');
  assert.match(md, /# DATAGLOW AI Touch Ledger/);
  assert.match(md, /Qwen2.5-1.5B-Instruct \(WebLLM\)/);
  assert.match(md, /claim_status/);
});

await test('exportTouchLedger: text format on an empty ledger says so plainly', () => {
  assert.match(exportTouchLedger([], 'text'), /no AI touches recorded yet/);
});

await test('exportTouchLedger: text format shows sentTo only for external entries', async () => {
  const ledger = createTouchLedger();
  await ledger.logTouch({ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice' });
  await ledger.logTouch({ model: 'Anthropic API (Claude)', location: 'external', sentTo: 'api.anthropic.com' });
  const text = exportTouchLedger(ledger.getEntries(), 'text');
  assert.match(text, /sent to: api\.anthropic\.com/);
  const lines = text.split('\n');
  const ondeviceLine = lines.find((l) => l.includes('ONDEVICE'));
  assert.ok(ondeviceLine && !ondeviceLine.includes('sent to:'));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
