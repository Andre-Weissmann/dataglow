// ============================================================
// DATAGLOW — In-Browser Story Model tests
// ============================================================
// Covers the deterministic, browser-free logic behind the Story tab's new
// in-browser (WebLLM) model mode. The actual model download + WebGPU inference
// can't run in CI (no GPU, multi-hundred-MB weights), so this suite exercises
// everything AROUND that: prompt construction, provider/mode selection, and the
// generateStory() routing/fallback with the on-device engine STUBBED.
//
// RUN WITH:  node test/story-model.test.mjs

import { buildStoryModelPrompt, MODEL_ID, MODEL_LABEL } from '../js/ondevice-llm.js';
import { generateStory, buildStoryClaims, MODEL_PROVIDERS, generateLocalStory } from '../js/story.js';

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

// ---------- Provider registry: the on-device model is the recommended default ----------
{
  const ondevice = MODEL_PROVIDERS.find(p => p.id === 'ondevice');
  ok(!!ondevice, 'providers: an "ondevice" provider is registered');
  ok(ondevice && ondevice.default === true, 'providers: ondevice is the default');
  ok(ondevice && ondevice.requiresKey === false, 'providers: ondevice needs no API key');
  ok(ondevice && ondevice.inBrowser === true, 'providers: ondevice is flagged inBrowser');
  ok(ondevice && ondevice.endpoint === null, 'providers: ondevice has no network endpoint');
  const defaults = MODEL_PROVIDERS.filter(p => p.default);
  ok(defaults.length === 1, 'providers: exactly one default provider');
  // The graceful-degradation options must still exist.
  ok(MODEL_PROVIDERS.some(p => p.id === 'local' && !p.requiresKey), 'providers: rule-based (local) still present');
  ok(MODEL_PROVIDERS.some(p => p.id === 'perplexity' && p.requiresKey), 'providers: an API-key provider still present');
}

// ---------- Prompt construction (pure) ----------
{
  const claims = buildStoryClaims(sampleResult);
  const { system, user, messages } = buildStoryModelPrompt({
    tableName: 'patients',
    queryResult: sampleResult,
    claims,
  });

  ok(/Story Engine/i.test(system), 'prompt: system frames it as the Story Engine');
  ok(/on the user's own device|on the user’s own device/i.test(system), 'prompt: system states it runs on-device');
  ok(/NOT a medical|not a medical/i.test(system) && /clinical/i.test(system),
    'prompt: system disclaims medical/clinical reasoning (legal constraint)');

  ok(/## Query result/.test(user), 'prompt: includes the query-result section');
  ok(/Source table: patients/.test(user), 'prompt: embeds the table name');
  ok(/Rows returned: 3/.test(user), 'prompt: embeds the row count');
  ok(/Columns \(2\): amount, dept/.test(user), 'prompt: lists the columns');
  ok(/## Key figures/.test(user), 'prompt: includes the confidence-graded figures section');
  ok(/\[confidence [ABCD]\]/.test(user), 'prompt: annotates figures with a confidence grade');
  ok(/## Task/.test(user) && /caveat/i.test(user), 'prompt: asks for a story with an honest caveat');
  ok(/never invent|Use only the numbers/i.test(user + system), 'prompt: forbids inventing numbers');

  ok(Array.isArray(messages) && messages.length === 2 &&
     messages[0].role === 'system' && messages[1].role === 'user',
    'prompt: messages is a valid system+user chat payload');
}

// ---------- Prompt is robust to missing / empty inputs ----------
{
  const { user } = buildStoryModelPrompt();
  ok(user.length > 0 && /Rows returned: 0/.test(user), 'prompt: builds with all defaults (0 rows)');
  const noClaims = buildStoryModelPrompt({ tableName: 't', queryResult: sampleResult, claims: [] }).user;
  ok(!/## Key figures/.test(noClaims), 'prompt: omits the figures section when no claims are provided');
}

// ---------- Model constants exist ----------
ok(typeof MODEL_ID === 'string' && MODEL_ID.length > 0, 'model id constant is defined');
ok(typeof MODEL_LABEL === 'string' && /GB/i.test(MODEL_LABEL), 'model label advertises the download size');

// ---------- generateStory routing: ondevice happy path (engine stubbed) ----------
{
  let receivedTable = null;
  let receivedRows = null;
  const stub = async (queryResult, tableName) => {
    receivedTable = tableName;
    receivedRows = queryResult.rowCount;
    return '  A tidy on-device narrative.  ';
  };
  const res = await generateStory(sampleResult, 'patients', 'ondevice', null, { ondeviceGenerate: stub });
  ok(res.source === 'ondevice', 'routing: ondevice provider yields source "ondevice"');
  ok(res.text === 'A tidy on-device narrative.', 'routing: on-device text is trimmed and returned verbatim');
  ok(receivedTable === 'patients' && receivedRows === 3, 'routing: injected generator receives the query result + table');
}

// ---------- generateStory routing: ondevice failure falls back to rule-based ----------
{
  const boom = async () => { throw new Error('WebGPU out of memory'); };
  const res = await generateStory(sampleResult, 'patients', 'ondevice', null, { ondeviceGenerate: boom });
  ok(res.source === 'local-fallback', 'fallback: a model error degrades to source "local-fallback"');
  ok(res.error === 'WebGPU out of memory', 'fallback: the triggering error is surfaced');
  ok(res.text === generateLocalStory(sampleResult, 'patients'), 'fallback: text equals the rule-based story');
}

// ---------- ondevice with empty model output also falls back ----------
{
  const empty = async () => '   ';
  const res = await generateStory(sampleResult, 'patients', 'ondevice', null, { ondeviceGenerate: empty });
  ok(res.source === 'local-fallback', 'fallback: empty model output degrades to rule-based');
}

// ---------- ondevice selected but NO engine injected (e.g. non-browser) falls back ----------
{
  const res = await generateStory(sampleResult, 'patients', 'ondevice', null, {});
  ok(res.source === 'local-fallback', 'fallback: ondevice with no injected engine uses rule-based');
  ok(res.text === generateLocalStory(sampleResult, 'patients'), 'fallback: no-engine text equals the rule-based story');
}

// ---------- other modes are unaffected by the new routing ----------
{
  const local = await generateStory(sampleResult, 'patients', 'local', null, { ondeviceGenerate: async () => 'x' });
  ok(local.source === 'local', 'routing: explicit rule-based mode still returns source "local"');
  const noKey = await generateStory(sampleResult, 'patients', 'perplexity', '', { ondeviceGenerate: async () => 'x' });
  ok(noKey.source === 'local', 'routing: API provider with no key still returns source "local"');
}

// ---------- empty result throws regardless of mode ----------
{
  let threw = false;
  try {
    await generateStory({ columns: ['a'], rows: [], rowCount: 0 }, 't', 'ondevice', null, { ondeviceGenerate: async () => 'x' });
  } catch { threw = true; }
  ok(threw, 'routing: an empty query result throws before any generation');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
