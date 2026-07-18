// ============================================================
// DATAGLOW — NL→SQL Engine
// ============================================================
// Converts a natural language question into a DuckDB SQL SELECT statement.
//
// Pipeline:
//   1. Extract schema context (column names + types only — no row data).
//   2. Match the question against Metric Contracts for deterministic expressions.
//   3. Build a system prompt: schema context + matched contracts + instructions.
//   4. Call the configured LLM endpoint with the user's question.
//   5. Extract and validate the SQL from the response.
//   6. Return { sql, contractsUsed, warnings, raw }.
//
// Privacy: the LLM receives ONLY:
//   - Column names and types (from serializeSchemaForPrompt)
//   - Metric Contract expressions (human-authored, no row data)
//   - The user's natural language question
//   NEVER: actual row values, patient identifiers, or any data content.
//
// The engine is dependency-injected: it accepts a `callLLM` function so it
// remains unit-testable in Node without a real LLM and without network calls.
// ============================================================

import { serializeSchemaForPrompt, datasetsToSchemaContext } from './schema-context.js';
import { matchContracts, bestMatch, contractToPromptFragment, getAllContracts } from './metric-contracts.js';

// ---------------------------------------------------------------
// LLM provider configs — same shape as narrative/story.js
// ---------------------------------------------------------------
export const NL_SQL_PROVIDERS = [
  { id: 'openai',     name: 'OpenAI (GPT-4o)',   endpoint: 'https://api.openai.com/v1/chat/completions',           model: 'gpt-4o',                        requiresKey: true  },
  { id: 'anthropic',  name: 'Claude (Sonnet)',    endpoint: 'https://api.anthropic.com/v1/messages',               model: 'claude-sonnet-4-5',              requiresKey: true  },
  { id: 'google',     name: 'Gemini (Flash)',     endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', model: 'gemini-2.0-flash', requiresKey: true },
  { id: 'perplexity', name: 'Perplexity (Sonar)', endpoint: 'https://api.perplexity.ai/chat/completions',          model: 'sonar',                         requiresKey: true  },
];

// ---------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------

/**
 * Build the system prompt for the LLM.
 * @param {import('./schema-context.js').SchemaContext} schemaCtx
 * @param {import('./metric-contracts.js').MetricContract[]} matchedContracts
 * @returns {string}
 */
export function buildSystemPrompt(schemaCtx, matchedContracts) {
  const schemaText = serializeSchemaForPrompt(schemaCtx);

  const contractSection = matchedContracts.length
    ? [
        'METRIC CONTRACTS (use these exact SQL expressions for the named metrics — do not rephrase):',
        '',
        ...matchedContracts.map(c => contractToPromptFragment(c)),
      ].join('\n')
    : '';

  return [
    'You are DATAGLOW\'s NL→SQL engine. Your only job is to convert a natural language question into a single, valid DuckDB SQL SELECT statement.',
    '',
    'RULES (follow every one without exception):',
    '1. Output ONLY raw SQL — no markdown fences, no backticks, no explanation, no preamble.',
    '2. The SQL must be a SELECT statement. No INSERT, UPDATE, DELETE, DROP, or DDL.',
    '3. Use only the tables and columns listed in the schema below. Do not invent columns.',
    '4. Quote all identifiers with double-quotes: "column_name", "table_name".',
    '5. If a METRIC CONTRACT is provided, use its expression VERBATIM in your SELECT.',
    '6. If the question is ambiguous, make the most reasonable healthcare-analyst interpretation.',
    '7. Default to LIMIT 1000 unless the question asks for all rows or a specific count.',
    '8. If you cannot answer from the schema alone, output: SELECT \'Unable to generate SQL from schema\' AS error',
    '',
    schemaText,
    contractSection,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------
// SQL extractor — strip markdown fences the model might add anyway
// ---------------------------------------------------------------

/**
 * Extract the SQL statement from a raw LLM response.
 * Handles fenced code blocks (```sql ... ```) and bare SQL.
 * @param {string} raw
 * @returns {string}
 */
export function extractSQL(raw) {
  if (!raw) return '';
  // Strip ```sql ... ``` or ``` ... ``` blocks
  const fenced = raw.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return raw.trim();
}

// ---------------------------------------------------------------
// SQL validator — lightweight sanity checks (no full parse)
// ---------------------------------------------------------------

/**
 * Validate that the extracted SQL looks safe and sane.
 * Returns { valid: boolean, problems: string[] }.
 * @param {string} sql
 * @returns {{ valid: boolean, problems: string[] }}
 */
export function validateSQL(sql) {
  const problems = [];
  if (!sql || !sql.trim()) {
    problems.push('Empty SQL returned.');
    return { valid: false, problems };
  }
  const upper = sql.toUpperCase().trim();

  // Must start with SELECT
  if (!upper.startsWith('SELECT')) {
    problems.push('SQL does not begin with SELECT.');
  }

  // Block write operations
  for (const forbidden of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE']) {
    if (upper.includes(forbidden + ' ')) {
      problems.push(`SQL contains forbidden keyword: ${forbidden}.`);
    }
  }

  // Block semicolon-chained statements
  const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
  if (stmts.length > 1) {
    problems.push('SQL contains multiple statements (;). Only one SELECT is allowed.');
  }

  // Warn if no FROM clause (likely an error)
  if (!upper.includes('FROM')) {
    problems.push('SQL has no FROM clause — did the model hallucinate a column-less query?');
  }

  return { valid: problems.length === 0, problems };
}

// ---------------------------------------------------------------
// LLM call implementations (browser-side, BYO API key)
// ---------------------------------------------------------------

/**
 * Call OpenAI or Perplexity (OpenAI-compatible chat/completions).
 */
async function callOpenAICompat(endpoint, model, apiKey, systemPrompt, userQuestion) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuestion },
      ],
      temperature: 0,
      max_tokens: 512,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Call Anthropic Claude messages API.
 */
async function callAnthropic(endpoint, model, apiKey, systemPrompt, userQuestion) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userQuestion }],
      temperature: 0,
      max_tokens: 512,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Anthropic API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

/**
 * Call Google Gemini generateContent API.
 */
async function callGoogle(endpoint, model, apiKey, systemPrompt, userQuestion) {
  const url = endpoint.includes('?') ? `${endpoint}&key=${apiKey}` : `${endpoint}?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userQuestion }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 512 },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Google API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * Route an LLM call to the right provider implementation.
 * @param {object} provider  One of NL_SQL_PROVIDERS
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {string} userQuestion
 * @returns {Promise<string>}  Raw LLM response text
 */
export async function callLLMProvider(provider, apiKey, systemPrompt, userQuestion) {
  if (provider.id === 'anthropic') {
    return callAnthropic(provider.endpoint, provider.model, apiKey, systemPrompt, userQuestion);
  }
  if (provider.id === 'google') {
    return callGoogle(provider.endpoint, provider.model, apiKey, systemPrompt, userQuestion);
  }
  // OpenAI-compatible: openai, perplexity
  return callOpenAICompat(provider.endpoint, provider.model, apiKey, systemPrompt, userQuestion);
}

// ---------------------------------------------------------------
// Main NL→SQL entry point
// ---------------------------------------------------------------

/**
 * Convert a natural language question to DuckDB SQL.
 *
 * @param {object} opts
 * @param {string} opts.question              The user's natural language question.
 * @param {object[]} opts.datasets            DataGlow state.datasets array.
 * @param {string} [opts.domainContext]       e.g. "healthcare claims"
 * @param {object} [opts.provider]            One of NL_SQL_PROVIDERS (required unless callLLM is provided).
 * @param {string} [opts.apiKey]              BYO API key (required unless callLLM is provided).
 * @param {function} [opts.callLLM]           Injection point for testing: async (systemPrompt, question) => rawText
 * @returns {Promise<{ sql: string, contractsUsed: string[], warnings: string[], raw: string, systemPrompt: string }>}
 */
export async function nlToSQL(opts) {
  const { question, datasets, domainContext, provider, apiKey, callLLM } = opts;

  if (!question || !question.trim()) {
    return { sql: '', contractsUsed: [], warnings: ['Question is empty.'], raw: '', systemPrompt: '' };
  }

  // 1. Build schema context (no row data)
  const schemaCtx = datasetsToSchemaContext(datasets || [], domainContext || 'healthcare');
  if (schemaCtx.tables.length === 0) {
    return { sql: '', contractsUsed: [], warnings: ['No datasets loaded — load a file first.'], raw: '', systemPrompt: '' };
  }

  // 2. Collect all column names for contract matching
  const allCols = schemaCtx.tables.flatMap(t => t.cols.map(c => c.name));

  // 3. Match metric contracts
  const matchedContracts = matchContracts(question, allCols);
  const contractsUsed = matchedContracts.map(c => c.name);

  // 4. Build system prompt
  const systemPrompt = buildSystemPrompt(schemaCtx, matchedContracts);

  // 5. Call the LLM (injected or real)
  let raw = '';
  try {
    if (callLLM) {
      raw = await callLLM(systemPrompt, question);
    } else if (provider && apiKey) {
      raw = await callLLMProvider(provider, apiKey, systemPrompt, question);
    } else {
      return {
        sql: '',
        contractsUsed,
        warnings: ['No LLM provider configured. Add an API key in Settings.'],
        raw: '',
        systemPrompt,
      };
    }
  } catch (err) {
    return {
      sql: '',
      contractsUsed,
      warnings: [`LLM call failed: ${err.message}`],
      raw: '',
      systemPrompt,
    };
  }

  // 6. Extract and validate SQL
  const sql = extractSQL(raw);
  const { valid, problems } = validateSQL(sql);
  const warnings = valid ? [] : problems;

  return { sql, contractsUsed, warnings, raw, systemPrompt };
}
