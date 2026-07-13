// ============================================================
// DATAGLOW — AI Touch Ledger × Story Engine wiring tests (Batch 2)
// ============================================================
// Covers js/narrative/story.js's logStoryTouch() — the ONLY new logic in this
// batch's Story-Engine-facing wiring. ai-touch-ledger.js itself is already
// fully unit-tested (test/ai-touch-ledger.test.mjs); this suite verifies that
// generateStory() calls a real injected touchLedger honestly for every real
// outcome, and — just as importantly — does NOT log when no AI model was
// actually touched (source: 'local', or an on-device failure that never left
// the browser).
//
// RUN WITH:  node test/ai-touch-ledger-story-wiring.test.mjs

import { generateStory } from '../js/narrative/story.js';
import { createTouchLedger } from '../js/provenance/ai-touch-ledger.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const sampleResult = {
  columns: ['amount', 'dept'],
  rows: [
    { amount: 10, dept: 'cardiology' },
    { amount: 20, dept: 'cardiology' },
    { amount: 30, dept: 'oncology' },
  ],
  rowCount: 3,
};

async function main() {
  // ---------- 1. On-device success: logged as ondevice ----------
  {
    const touchLedger = createTouchLedger();
    const stub = async () => 'A tidy on-device narrative.';
    await generateStory(sampleResult, 'patients', 'ondevice', null, { ondeviceGenerate: stub, touchLedger });
    const entries = touchLedger.getEntries();
    ok(entries.length === 1, 'ondevice success: exactly one touch logged');
    ok(entries[0] && entries[0].location === 'ondevice', 'ondevice success: logged location is ondevice');
    ok(entries[0] && entries[0].sentTo === null, 'ondevice success: sentTo is null (nothing left the browser)');
    ok(Array.isArray(entries[0] && entries[0].fieldsTouched) && entries[0].fieldsTouched.join(',') === 'amount,dept',
      'ondevice success: fieldsTouched carries the real query-result columns');
    ok(typeof entries[0].action === 'string' && /patients/.test(entries[0].action),
      'ondevice success: action names the real table');
  }

  // ---------- 2. On-device failure (never left the browser): NOT logged ----------
  {
    const touchLedger = createTouchLedger();
    const boom = async () => { throw new Error('WebGPU out of memory'); };
    const res = await generateStory(sampleResult, 'patients', 'ondevice', null, { ondeviceGenerate: boom, touchLedger });
    ok(res.source === 'local-fallback', 'ondevice failure: source is local-fallback (sanity check)');
    ok(touchLedger.getEntries().length === 0,
      'ondevice failure: NOT logged \u2014 nothing ever left the browser, so this is not an AI touch');
  }

  // ---------- 3. On-device, no engine injected at all: NOT logged ----------
  {
    const touchLedger = createTouchLedger();
    await generateStory(sampleResult, 'patients', 'ondevice', null, { touchLedger });
    ok(touchLedger.getEntries().length === 0,
      'ondevice no-engine: NOT logged \u2014 falls back to rule-based without any model touch');
  }

  // ---------- 4. Explicit rule-based (local) mode: NOT logged ----------
  {
    const touchLedger = createTouchLedger();
    await generateStory(sampleResult, 'patients', 'local', null, { touchLedger });
    ok(touchLedger.getEntries().length === 0, 'local mode: NOT logged \u2014 no AI model is ever touched');
  }

  // ---------- 5. External provider with no API key (degrades to local): NOT logged ----------
  {
    const touchLedger = createTouchLedger();
    await generateStory(sampleResult, 'patients', 'perplexity', '', { touchLedger });
    ok(touchLedger.getEntries().length === 0,
      'external no-key: NOT logged \u2014 degrades to local before any network call is attempted');
  }

  // ---------- 6. External provider success: logged as external with real sentTo ----------
  {
    const touchLedger = createTouchLedger();
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'An external narrative.' } }] }),
    });
    try {
      const res = await generateStory(sampleResult, 'patients', 'perplexity', 'sk-test', { touchLedger });
      ok(res.source === 'perplexity', 'external success: source is the provider id (sanity check)');
      const entries = touchLedger.getEntries();
      ok(entries.length === 1, 'external success: exactly one touch logged');
      ok(entries[0] && entries[0].location === 'external', 'external success: logged location is external');
      ok(entries[0] && entries[0].sentTo === 'https://api.perplexity.ai/chat/completions',
        'external success: sentTo is the real provider endpoint that received the request body');
      ok(entries[0] && entries[0].model === 'Perplexity (Sonar)', 'external success: model is the real provider name');
    } finally {
      global.fetch = originalFetch;
    }
  }

  // ---------- 7. External provider that FAILS after sending the request: STILL logged ----------
  // This is the subtle honesty case: the fetch() body (with real fieldsTouched)
  // already went out over the network before the non-OK status caused a
  // fallback. Not logging this would hide a real instance of data leaving the
  // browser, so it must be logged as external even though the user-facing
  // result degrades to the local rule-based story.
  {
    const touchLedger = createTouchLedger();
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500 });
    try {
      const res = await generateStory(sampleResult, 'patients', 'anthropic', 'sk-test', { touchLedger });
      ok(res.source === 'local-fallback', 'external failure: source degrades to local-fallback (sanity check)');
      const entries = touchLedger.getEntries();
      ok(entries.length === 1, 'external failure: STILL logged exactly once \u2014 the request already left the browser');
      ok(entries[0] && entries[0].location === 'external', 'external failure: logged location is external, not ondevice');
      ok(entries[0] && entries[0].sentTo === 'https://api.anthropic.com/v1/messages',
        'external failure: sentTo is the real endpoint the failed request was sent to');
    } finally {
      global.fetch = originalFetch;
    }
  }

  // ---------- 8. No touchLedger injected at all: generateStory works unchanged ----------
  {
    const stub = async () => 'A narrative with no ledger present.';
    const res = await generateStory(sampleResult, 'patients', 'ondevice', null, { ondeviceGenerate: stub });
    ok(res.source === 'ondevice' && res.text === 'A narrative with no ledger present.',
      'no ledger injected: generateStory behaves identically to before this batch existed');
  }

  // ---------- 9. A broken/foreign injected touchLedger never breaks story generation ----------
  {
    const brokenLedger = { logTouch: () => { throw new Error('boom, a foreign object misbehaving'); } };
    const stub = async () => 'Still works.';
    let threw = false;
    let res = null;
    try {
      res = await generateStory(sampleResult, 'patients', 'ondevice', null, { ondeviceGenerate: stub, touchLedger: brokenLedger });
    } catch (e) { threw = true; }
    ok(!threw, 'defensive: a throwing injected touchLedger.logTouch never breaks generateStory');
    ok(res && res.text === 'Still works.', 'defensive: the real story result is still returned intact');
  }

  // ---------- 10. Multiple sequential touches chain correctly (hash-chain sanity) ----------
  {
    const touchLedger = createTouchLedger();
    const stub = async () => 'First.';
    await generateStory(sampleResult, 'patients', 'ondevice', null, { ondeviceGenerate: stub, touchLedger });
    await generateStory(sampleResult, 'claims', 'ondevice', null, { ondeviceGenerate: async () => 'Second.', touchLedger });
    const entries = touchLedger.getEntries();
    ok(entries.length === 2, 'sequential: two separate Story generations produce two chained entries');
    ok(entries[1].parentHash === entries[0].hash, 'sequential: second entry chains from the first entry\'s hash');
    ok(/claims/.test(entries[1].action) && /patients/.test(entries[0].action),
      'sequential: each entry\'s action names its own table, not a stale one');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
