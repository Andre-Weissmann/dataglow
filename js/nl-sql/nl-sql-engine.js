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
// The engine is dependency-injected: it accepts a callLLM function so it
// remains unit-testable in Node without a real LLM and without network calls.
// ============================================================

import { serializeSchemaForPrompt, datasetsToSchemaContext } from './schema-context.js';
import { matchContracts, bestMatch, contractToPromptFragment, getAllContracts } from './metric-contracts.js';
import { buildPatternSQL, autoFixSQL, explainSQL, detectColumns, detectIntent } from './nl-sql-pattern-engine.js';
import { getProviderKey, hasAnyKey } from './nl-sql-key-store.js';

// Re-export the pattern-engine helpers so the UI can import everything from
// the engine module and call autoFixSQL / explainSQL on DuckDB errors.
export { buildPatternSQL, autoFixSQL, explainSQL, detectColumns, detectIntent };

// ---------------------------------------------------------------
// LLM provider configs (models current as of July 2026) — same shape as
// narrative/story.js. The LLM path is SECONDARY: the pattern engine answers
// most questions with no key and no network call.
// ---------------------------------------------------------------
export const NL_SQL_PROVIDERS = [
  { id: 'openai',     name: 'OpenAI (GPT-5.6 Sol)',    endpoint: 'https://api.openai.com/v1/chat/completions',           model: 'gpt-5.6-sol',       requiresKey: true  },
  { id: 'anthropic',  name: 'Claude (Fable 5)',        endpoint: 'https://api.anthropic.com/v1/messages',               model: 'claude-fable-5',    requiresKey: true  },
  { id: 'google',     name: 'Gemini (3.5 Flash)',      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', model: 'gemini-3.5-flash', requiresKey: true },
  { id: 'perplexity', name: 'Perplexity (Sonar)',      endpoint: 'https://api.perplexity.ai/chat/completions',          model: 'sonar',             requiresKey: true  },
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
    "You are DATAGLOW's NL->SQL engine. Your only job is to convert a natural language question into a single, valid DuckDB SQL SELECT statement.",
    '',
    'RULES (follow every one without exception):',
    '1. Output ONLY raw SQL — no markdown fences, no backticks, no explanation, no preamble.',
    '2. The SQL must be a SELECT statement. No INSERT, UPDATE, DELETE, DROP, or DDL.',
    '3. Use only the tables and columns listed in the schema below. Do not invent columns.',
    '4. Quote all identifiers with double-quotes: "column_name", "table_name".',
    '5. If a METRIC CONTRACT is provided, use its expression VERBATIM in your SELECT.',
    '6. If the question is ambiguous, make the most reasonable healthcare-analyst interpretation.',
    '7. Default to LIMIT 1000 unless the question asks for all rows or a specific count.',
    "8. If you cannot answer from the schema alone, output: SELECT 'Unable to generate SQL from schema' AS error",
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
 * Handles fenced markdown code blocks and bare SQL.
 * @param {string} raw
 * @returns {string}
 */
export function extractSQL(raw) {
  if (!raw) return '';
  // Strip triple-backtick fenced blocks (with or without a language tag).
  // Built via RegExp string form to avoid literal backticks in source.
  const fence = String.fromCharCode(96, 96, 96);
  const fencedRe = new RegExp(fence + '(?:sql)?\\s*([\\s\\S]*?)' + fence, 'i');
  const fenced = raw.match(fencedRe);
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
      problems.push('SQL contains forbidden keyword: ' + forbidden + '.');
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
      'Authorization': 'Bearer ' + apiKey,
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
    throw new Error('LLM API error ' + resp.status + ': ' + text.slice(0, 200));
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
    throw new Error('Anthropic API error ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

/**
 * Call Google Gemini generateContent API.
 */
async function callGoogle(endpoint, model, apiKey, systemPrompt, userQuestion) {
  const url = endpoint.includes('?') ? (endpoint + '&key=' + apiKey) : (endpoint + '?key=' + apiKey);
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
    throw new Error('Google API error ' + resp.status + ': ' + text.slice(0, 200));
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
 * NEW FLOW (July 2026): the zero-cost pattern engine runs FIRST. Only when it
 * cannot build a confident query do we fall through to an LLM provider. This
 * means most questions are answered instantly, offline, with no API key.
 *
 * @param {object} opts
 * @param {string} opts.question              The user's natural language question.
 * @param {object[]} opts.datasets            DataGlow state.datasets array.
 * @param {string} [opts.domainContext]       e.g. "healthcare claims"
 * @param {object} [opts.provider]            One of NL_SQL_PROVIDERS (required for the LLM path).
 * @param {string} [opts.apiKey]              BYO API key (falls back to the in-memory key store).
 * @param {function} [opts.callLLM]           Injection point for testing: async (systemPrompt, question) => rawText
 * @param {boolean} [opts.preferPattern]      When true, always try the pattern engine before an injected callLLM.
 * @returns {Promise<{ sql: string, explanation: string, contractsUsed: string[], warnings: string[], raw: string, systemPrompt: string, steps: string[], confidence: string, source: string }>}
 */
export async function nlToSQL(opts) {
  const { question, datasets, domainContext, provider, apiKey, callLLM, preferPattern } = opts;

  const base = {
    sql: '', explanation: '', contractsUsed: [], warnings: [], raw: '',
    systemPrompt: '', steps: [], confidence: 'low', source: 'none',
  };

  if (!question || !question.trim()) {
    return Object.assign({}, base, { warnings: ['Question is empty.'] });
  }

  // 1. Build schema context (no row data)
  const schemaCtx = datasetsToSchemaContext(datasets || [], domainContext || 'healthcare');
  if (schemaCtx.tables.length === 0) {
    return Object.assign({}, base, { warnings: ['No datasets loaded — load a file first.'] });
  }

  // 2. Collect all column names for contract matching
  const allCols = schemaCtx.tables.flatMap(t => t.cols.map(c => c.name));

  // 3. Match metric contracts
  const matchedContracts = matchContracts(question, allCols);
  const contractsUsed = matchedContracts.map(c => c.name);

  // 4. Build system prompt (still built so callers can inspect it)
  const systemPrompt = buildSystemPrompt(schemaCtx, matchedContracts);

  // 5. PRIMARY PATH — the zero-cost pattern engine.
  // Skip it only when an explicit callLLM injection is present and the caller
  // did not ask to prefer the pattern engine (preserves dependency-injection
  // tests that want to exercise the LLM path directly).
  const usePatternFirst = !callLLM || preferPattern === true;
  if (usePatternFirst) {
    const pat = buildPatternSQL(question, schemaCtx, matchedContracts);
    if (pat.sql && (pat.confidence === 'high' || pat.confidence === 'medium')) {
      const { valid, problems } = validateSQL(pat.sql);
      const source = matchedContracts.length ? 'contract' : 'pattern';
      return {
        sql: pat.sql,
        explanation: pat.explanation || explainSQL(pat.sql, schemaCtx),
        contractsUsed,
        warnings: valid ? [] : problems,
        raw: pat.sql,
        systemPrompt,
        steps: pat.steps || [],
        confidence: pat.confidence,
        source: source,
      };
    }
  }

  // 6. SECONDARY PATH — LLM. Resolve an API key from opts or the key store.
  const resolvedKey = apiKey || (provider ? getProviderKey(provider.id) : '');
  let raw = '';
  try {
    if (callLLM) {
      raw = await callLLM(systemPrompt, question);
    } else if (provider && resolvedKey) {
      raw = await callLLMProvider(provider, resolvedKey, systemPrompt, question);
    } else {
      return Object.assign({}, base, {
        contractsUsed,
        systemPrompt,
        warnings: ['The pattern engine could not answer this one. Add an API key in Settings to unlock AI-powered generation.'],
      });
    }
  } catch (err) {
    return Object.assign({}, base, {
      contractsUsed,
      systemPrompt,
      warnings: ['LLM call failed: ' + err.message],
    });
  }

  // 7. Extract, validate, and explain the LLM SQL.
  const sql = extractSQL(raw);
  const { valid, problems } = validateSQL(sql);
  const warnings = valid ? [] : problems;
  const explanation = sql ? explainSQL(sql, schemaCtx) : '';

  return {
    sql,
    explanation,
    contractsUsed,
    warnings,
    raw,
    systemPrompt,
    steps: ['Used AI model: ' + (provider ? provider.name : 'injected')],
    confidence: valid ? 'medium' : 'low',
    source: 'llm',
  };
}
