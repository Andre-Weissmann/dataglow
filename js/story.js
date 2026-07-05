// ============================================================
// DATAGLOW — Story Engine
// Reads query results, writes the data narrative in plain English.
// Model-agnostic: Perplexity by default, pluggable Claude/Gemini/etc.
// ============================================================

import { state } from './state.js';

export const MODEL_PROVIDERS = [
  { id: 'perplexity', name: 'Perplexity (Sonar)', endpoint: 'https://api.perplexity.ai/chat/completions', model: 'sonar', builtIn: true },
  { id: 'anthropic', name: 'Claude (Anthropic)', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-5', builtIn: false },
  { id: 'google', name: 'Gemini (Google)', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', model: 'gemini-2.0-flash', builtIn: false },
  { id: 'openai', name: 'OpenAI (GPT)', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o', builtIn: false },
  { id: 'local', name: 'Rule-based (offline, no API key)', endpoint: null, model: null, builtIn: true },
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

// Deterministic, template-based fallback narrative (no LLM, no API key, works fully offline)
function generateLocalStory(queryResult, tableName) {
  const { columns, rows, rowCount } = queryResult;
  if (rows.length === 0) return `The query against "${tableName}" returned no rows. There's nothing to summarize until the filters are loosened or the underlying data is checked.`;

  const numericCols = columns.filter(c => rows.every(r => r[c] == null || typeof r[c] === 'number'));
  const catCols = columns.filter(c => !numericCols.includes(c));

  let sentence1 = `The query against "${tableName}" returned ${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'} across ${columns.length} column${columns.length === 1 ? '' : 's'}.`;

  let sentence2 = '';
  if (numericCols.length > 0) {
    const nc = numericCols[0];
    const vals = rows.map(r => r[nc]).filter(v => typeof v === 'number');
    if (vals.length > 0) {
      const sum = vals.reduce((a, b) => a + b, 0);
      const avg = sum / vals.length;
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      sentence2 = ` Looking at <span class="story-highlight">${nc}</span>, values range from ${min.toLocaleString(undefined, { maximumFractionDigits: 2 })} to ${max.toLocaleString(undefined, { maximumFractionDigits: 2 })}, averaging ${avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`;
    }
  }

  let sentence3 = '';
  if (catCols.length > 0) {
    const cc = catCols[0];
    const counts = {};
    for (const r of rows) { const v = r[cc]; if (v != null) counts[v] = (counts[v] || 0) + 1; }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const pct = ((top[1] / rows.length) * 100).toFixed(1);
      sentence3 = ` The most common value in <span class="story-highlight">${cc}</span> is "${top[0]}", appearing in ${pct}% of returned rows.`;
    }
  }

  const caveat = ` This reflects only the rows returned by the current query — it does not account for records filtered out, or populations entirely absent from this dataset.`;

  return sentence1 + sentence2 + sentence3 + caveat;
}

export async function generateStory(queryResult, tableName, provider, apiKey) {
  if (!queryResult || queryResult.rows.length === 0) {
    throw new Error('Run a SQL query with results first.');
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
