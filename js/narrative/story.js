// ============================================================
// DATAGLOW — Story Engine
// Reads query results, writes the data narrative in plain English.
// Model-agnostic: Perplexity by default, pluggable Claude/Gemini/etc.
// ============================================================

import { state } from '../app-shell/state.js';
import { scoreClaimConfidence } from '../validation/validation.js';
import { escapeHtml } from '../app-shell/utils.js';
import { devAssertConformance, toStoryOutput } from '../protocol/protocol-conformance.js';

// Grade → color, matching the Confidence Layer's ring colors so a claim badge
// reads the same as the table-level grade.
const GRADE_COLOR = { A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)', D: 'var(--color-grade-d)' };

function confidenceBadgeHTML(conf) {
  const pctMissing = (conf.missingRate * 100).toFixed(conf.missingRate ? 1 : 0);
  const color = GRADE_COLOR[conf.grade] || 'var(--color-text-muted)';
  return ` <span class="conf-badge" style="display:inline-block; font-size:0.75em; font-weight:700; padding:1px 6px; border-radius:6px; color:#fff; background:${color};" title="Confidence ${conf.grade} — reused from DATAGLOW's Confidence Layer scoring (n=${conf.n}, ${pctMissing}% missing)">Confidence: ${conf.grade} · n=${conf.n} · ${pctMissing}% missing</span>`;
}

// Extract the individual quantitative claims a rule-based story makes, each
// scored per-claim by the SAME Confidence Layer logic (scoreClaimConfidence)
// rather than one global score for the whole narrative. Pure + Node-testable.
export function buildStoryClaims(queryResult) {
  const { columns, rows, rowCount } = queryResult;
  const claims = [];
  if (!rows || rows.length === 0) return claims;

  const numericCols = columns.filter(c => rows.every(r => r[c] == null || typeof r[c] === 'number'));
  const catCols = columns.filter(c => !numericCols.includes(c));

  // Claim: how many rows the result rests on.
  claims.push({
    kind: 'rowcount',
    column: null,
    value: rowCount,
    text: `returned ${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'}`,
    confidence: scoreClaimConfidence({ n: rowCount, missingRate: 0 }),
  });

  // Claim: the average of the first numeric column.
  if (numericCols.length > 0) {
    const nc = numericCols[0];
    const vals = rows.map(r => r[nc]).filter(v => typeof v === 'number');
    if (vals.length > 0) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const missingRate = rows.length ? (rows.length - vals.length) / rows.length : 0;
      claims.push({
        kind: 'numeric_mean',
        column: nc,
        value: avg,
        text: `${nc} averages ${avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        confidence: scoreClaimConfidence({ n: vals.length, missingRate }),
      });
    }
  }

  // Claim: the dominant category and its share.
  if (catCols.length > 0) {
    const cc = catCols[0];
    const counts = {};
    let nonNull = 0;
    for (const r of rows) { const v = r[cc]; if (v != null) { counts[v] = (counts[v] || 0) + 1; nonNull++; } }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const pct = ((top[1] / rows.length) * 100).toFixed(1);
      const missingRate = rows.length ? (rows.length - nonNull) / rows.length : 0;
      claims.push({
        kind: 'category_share',
        column: cc,
        value: Number(pct),
        text: `the most common ${cc} is "${top[0]}" at ${pct}% of rows`,
        confidence: scoreClaimConfidence({ n: nonNull, missingRate }),
      });
    }
  }

  return claims;
}


export const MODEL_PROVIDERS = [
  // "default" marks the provider pre-selected on first load. "requiresKey" controls
  // whether the Settings UI shows an API-key field and whether the badge/generation
  // logic falls back to the offline rule-based engine when no key is present.
  // "inBrowser" marks the on-device WebLLM model: no key, no network at inference
  // time, runs 100% on the user's device (see js/ondevice-llm.js). It is the
  // recommended default — private by construction and DATAGLOW's core promise.
  { id: 'ondevice', name: 'In-browser AI (private, no API key)', endpoint: null, model: null, default: true, requiresKey: false, inBrowser: true },
  { id: 'perplexity', name: 'Perplexity (Sonar)', endpoint: 'https://api.perplexity.ai/chat/completions', model: 'sonar', default: false, requiresKey: true },
  { id: 'anthropic', name: 'Claude (Anthropic)', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-5', default: false, requiresKey: true },
  { id: 'google', name: 'Gemini (Google)', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', model: 'gemini-2.0-flash', default: false, requiresKey: true },
  { id: 'openai', name: 'OpenAI (GPT)', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o', default: false, requiresKey: true },
  { id: 'local', name: 'Rule-based (offline, no API key)', endpoint: null, model: null, default: false, requiresKey: false },
];

function buildPrompt(queryResult, tableName) {
  const sample = queryResult.rows.slice(0, 30);
  return `You are DATAGLOW's Story Engine, a data analyst assistant. Given this SQL query result from table "${tableName}" (${queryResult.rowCount} rows returned, columns: ${queryResult.columns.join(', ')}), write a short data story in plain English (3-5 sentences).

Rules:
- Every number you mention MUST come directly from this data — never invent or round loosely.
- State one clear insight, then its implication for a healthcare data analyst.
- End with one honest caveat about what the data does NOT show.
- No headers, no bullet points — just flowing prose.

Data sample (JSON):
${JSON.stringify(sample, null, 0).slice(0, 4000)}`;
}

// Deterministic, template-based fallback narrative (no LLM, no API key, works
// fully offline). Every quantitative claim carries an inline confidence badge
// scored per-claim by the Confidence Layer (see buildStoryClaims), and any
// low-confidence (grade C/D) claim gets a visible caveat.
export function generateLocalStory(queryResult, tableName) {
  const { columns, rows, rowCount } = queryResult;
  if (rows.length === 0) return `The query against "${escapeHtml(tableName)}" returned no rows. There's nothing to summarize until the filters are loosened or the underlying data is checked.`;

  const claims = buildStoryClaims(queryResult);
  const byKind = Object.fromEntries(claims.map(c => [c.kind, c]));

  const rc = byKind.rowcount;
  let sentence1 = `The query against "${escapeHtml(tableName)}" returned ${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'} across ${columns.length} column${columns.length === 1 ? '' : 's'}.${rc ? confidenceBadgeHTML(rc.confidence) : ''}`;

  let sentence2 = '';
  const numericCols = columns.filter(c => rows.every(r => r[c] == null || typeof r[c] === 'number'));
  if (byKind.numeric_mean) {
    const nc = byKind.numeric_mean.column;
    const vals = rows.map(r => r[nc]).filter(v => typeof v === 'number');
    const avg = byKind.numeric_mean.value;
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    sentence2 = ` Looking at <span class="story-highlight">${escapeHtml(nc)}</span>, values range from ${min.toLocaleString(undefined, { maximumFractionDigits: 2 })} to ${max.toLocaleString(undefined, { maximumFractionDigits: 2 })}, averaging ${avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}.${confidenceBadgeHTML(byKind.numeric_mean.confidence)}`;
    if (['C', 'D'].includes(byKind.numeric_mean.confidence.grade)) {
      sentence2 += ` <em>(Treat this average cautiously — it rests on limited or partly-missing data.)</em>`;
    }
  }

  let sentence3 = '';
  if (byKind.category_share) {
    const cc = byKind.category_share.column;
    const counts = {};
    for (const r of rows) { const v = r[cc]; if (v != null) counts[v] = (counts[v] || 0) + 1; }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const pct = byKind.category_share.value.toFixed(1);
    sentence3 = ` The most common value in <span class="story-highlight">${escapeHtml(cc)}</span> is "${escapeHtml(top[0])}", appearing in ${pct}% of returned rows.${confidenceBadgeHTML(byKind.category_share.confidence)}`;
  }

  const caveat = ` This reflects only the rows returned by the current query — it does not account for records filtered out, or populations entirely absent from this dataset.`;

  return sentence1 + sentence2 + sentence3 + caveat;
}

// `opts.ondeviceGenerate(queryResult, tableName)` is injected by the browser
// (main.js) to run the on-device WebLLM model. It is a dependency so this module
// stays free of any WebGPU/WebLLM import and remains unit-testable in Node.
//
// `opts.touchLedger` (AI Touch Ledger, Batch 2) is an OPTIONAL injected object
// exposing `logTouch(touch)` — same dependency-injection shape as
// `ondeviceGenerate`, so this module stays free of any import from
// js/provenance/ai-touch-ledger.js and remains unit-testable in Node without a
// ledger present. When supplied, every attempted AI touch (on-device or
// external — including ones that fail or fall back) is logged exactly once,
// AFTER the real outcome is known, so `location`/`sentTo`/`model` always
// reflect what actually happened rather than what was requested. `logTouch`
// never throws (see ai-touch-ledger.js's own contract), but a defensive
// try/catch here means even a broken injected ledger can never break story
// generation itself.
export async function generateStory(queryResult, tableName, provider, apiKey, opts = {}) {
  const result = await produceStory(queryResult, tableName, provider, apiKey, opts);
  await logStoryTouch(queryResult, tableName, provider, opts, result);
  // Dev-mode, non-fatal: confirm the Story Engine output conforms to the
  // published protocol/schema/story-output.schema.json.
  const claims = (queryResult && queryResult.rows && queryResult.rows.length) ? buildStoryClaims(queryResult) : [];
  devAssertConformance('story-output', toStoryOutput(result, claims));
  return result;
}

// Map a produceStory() result to an AI Touch Ledger entry, and log it via the
// injected opts.touchLedger if present.
//
// The subtle case: `source: 'local-fallback'` can mean two very different
// things, and conflating them would be dishonest about what actually left
// the browser:
//   1. provider === 'ondevice' failed BEFORE any network call — nothing ever
//      left the browser, so this is NOT an AI touch at all. Not logged.
//   2. An EXTERNAL provider's fetch() already sent the real query-result rows
//      in its request body, then threw (bad status or network error) AFTER
//      that send. The touch already happened even though the story text that
//      reaches the user is the local fallback — logging nothing here would
//      hide a real instance of data leaving the browser. Logged as external.
// `source: 'local'` (provider was 'local' or no API key configured, or an
// unrecognized/keyless provider) never attempts any AI call, so it is never
// logged either.
async function logStoryTouch(queryResult, tableName, provider, opts, result) {
  const touchLedger = opts && opts.touchLedger;
  if (!touchLedger || typeof touchLedger.logTouch !== 'function') return;
  if (!result) return;

  const fieldsTouched = Array.isArray(queryResult && queryResult.columns) ? queryResult.columns : [];
  const action = `Generate Story narrative for "${tableName}"`;
  const providerDef = MODEL_PROVIDERS.find((p) => p.id === provider);

  try {
    if (result.source === 'ondevice') {
      await touchLedger.logTouch({
        model: (providerDef && providerDef.name) || 'On-device model',
        location: 'ondevice',
        action,
        fieldsTouched,
      });
    } else if (result.source === 'local-fallback' && provider !== 'ondevice' && providerDef && providerDef.endpoint) {
      // An external provider's request body (containing fieldsTouched) already
      // went out over the network before this call failed and fell back locally.
      await touchLedger.logTouch({
        model: providerDef.name,
        location: 'external',
        sentTo: providerDef.endpoint,
        action,
        fieldsTouched,
      });
    } else if (result.source !== 'local' && result.source !== 'local-fallback') {
      // Any other source value is a successful external-provider id
      // (perplexity/anthropic/google/openai) — the real query-result columns
      // were embedded in the HTTP request body sent to providerDef.endpoint.
      await touchLedger.logTouch({
        model: (providerDef && providerDef.name) || result.source,
        location: 'external',
        sentTo: (providerDef && providerDef.endpoint) || result.source,
        action,
        fieldsTouched,
      });
    }
    // else: source === 'local', or an ondevice local-fallback that never sent
    // anything — correctly not logged, since no AI model was touched.
  } catch (_e) {
    // logTouch() itself never throws, but a broken/foreign injected object
    // (e.g. missing logTouch after a typeof check race, or a getter that
    // throws) must still never break story generation.
  }
}

async function produceStory(queryResult, tableName, provider, apiKey, opts = {}) {
  if (!queryResult || queryResult.rows.length === 0) {
    throw new Error('Run a SQL query with results first.');
  }

  // On-device model path: no API key, nothing leaves the browser. Any failure
  // (no WebGPU, out-of-memory, cancelled download, empty output) degrades to the
  // deterministic rule-based story so the tab always produces something.
  if (provider === 'ondevice') {
    const gen = opts.ondeviceGenerate;
    if (typeof gen !== 'function') {
      return { text: generateLocalStory(queryResult, tableName), source: 'local-fallback' };
    }
    try {
      const text = await gen(queryResult, tableName);
      if (!text || !String(text).trim()) throw new Error('The on-device model returned no text.');
      return { text: String(text).trim(), source: 'ondevice' };
    } catch (err) {
      console.warn('On-device model failed, falling back to local story engine:', err);
      return { text: generateLocalStory(queryResult, tableName), source: 'local-fallback', error: err.message };
    }
  }

  if (provider === 'local' || !apiKey) {
    return { text: generateLocalStory(queryResult, tableName), source: 'local' };
  }

  const providerDef = MODEL_PROVIDERS.find(p => p.id === provider);
  if (!providerDef || !providerDef.endpoint) {
    return { text: generateLocalStory(queryResult, tableName), source: 'local' };
  }

  const prompt = buildPrompt(queryResult, tableName);

  try {
    if (provider === 'perplexity' || provider === 'openai') {
      const res = await fetch(providerDef.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: providerDef.model, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`${providerDef.name} API returned ${res.status}`);
      const data = await res.json();
      return { text: data.choices[0].message.content, source: provider };
    } else if (provider === 'anthropic') {
      const res = await fetch(providerDef.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: providerDef.model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`Claude API returned ${res.status}`);
      const data = await res.json();
      return { text: data.content[0].text, source: provider };
    } else if (provider === 'google') {
      const res = await fetch(`${providerDef.endpoint}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (!res.ok) throw new Error(`Gemini API returned ${res.status}`);
      const data = await res.json();
      return { text: data.candidates[0].content.parts[0].text, source: provider };
    }
  } catch (err) {
    console.warn('Model call failed, falling back to local story engine:', err);
    return { text: generateLocalStory(queryResult, tableName), source: 'local-fallback', error: err.message };
  }

  return { text: generateLocalStory(queryResult, tableName), source: 'local' };
}
