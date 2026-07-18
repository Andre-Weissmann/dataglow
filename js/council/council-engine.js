// ============================================================
// DATAGLOW -- AI Council Engine
// ============================================================
// Calls three LLM providers (OpenAI, Anthropic, Google Gemini) in parallel
// with the SAME question and schema context, then synthesizes their answers
// into consensus / majority / contested buckets so an analyst can see at a
// glance where the models agree and where they do not.
//
// Uses the same BYO-key, dependency-injected provider pattern as
// js/nl-sql/nl-sql-engine.js: callLLM (or callProvider) can be injected for
// tests, so this whole module is runnable in Node with zero network calls
// and zero real API keys.
//
// Privacy: the same schema-only guarantee as NL->SQL applies here. The
// caller decides what schemaContext text (if any) is passed in -- this
// module never reads row data itself.
// ============================================================

// ---------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------
export const COUNCIL_PROVIDERS = [
  { id: 'openai',    name: 'OpenAI (GPT)',       endpoint: 'https://api.openai.com/v1/chat/completions',   model: 'gpt-4o',          requiresKey: true },
  { id: 'anthropic', name: 'Anthropic (Claude)', endpoint: 'https://api.anthropic.com/v1/messages',        model: 'claude-opus-4-5', requiresKey: true },
  { id: 'google',    name: 'Google (Gemini)',    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', model: 'gemini-2.5-pro', requiresKey: true },
];

// ---------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------

/**
 * Build the shared system prompt sent to every council member.
 * Every provider gets the exact same instructions and schema context so
 * differences in their answers reflect model behavior, not prompt drift.
 *
 * @param {string} question
 * @param {string} [schemaContext]  Optional schema-only text (no row data).
 * @returns {string}
 */
export function buildCouncilPrompt(question, schemaContext) {
  const lines = [];
  lines.push('You are one member of a three-model AI Council inside DataGlow, a healthcare analytics tool.');
  lines.push('Another two independent models are answering the SAME question right now. Your answers will be compared side by side.');
  lines.push('');
  lines.push('RULES (follow every one without exception):');
  lines.push('1. Answer in 3 to 5 sentences, OR a single SQL block if the question asks for SQL. Do not do both.');
  lines.push('2. Clearly label facts vs your own opinion/judgment. Use the words FACT: and OPINION: as prefixes when it matters.');
  lines.push('3. Do not hedge excessively -- give your best concrete answer rather than a list of caveats.');
  lines.push('4. If you reference a metric, name it precisely (for example: 30-day readmission rate, denial rate, average length of stay).');
  lines.push('5. If schema context is provided below, use only the tables/columns listed. Never invent columns.');
  lines.push('6. Never include patient-identifying examples -- speak only about metrics, columns, and methodology.');
  lines.push('');

  if (schemaContext && schemaContext.trim()) {
    lines.push(schemaContext.trim());
    lines.push('');
  }

  lines.push('QUESTION:');
  lines.push(question || '');

  return lines.join('\n');
}

// ---------------------------------------------------------------
// LLM call implementations (browser-side, BYO API key)
// Mirrors js/nl-sql/nl-sql-engine.js routing exactly.
// ---------------------------------------------------------------

async function callOpenAICompat(endpoint, model, apiKey, systemPrompt, userQuestion) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuestion },
      ],
      temperature: 0.2,
      max_tokens: 512,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(function () { return ''; });
    throw new Error('OpenAI API error ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

async function callAnthropic(endpoint, model, apiKey, systemPrompt, userQuestion) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userQuestion }],
      temperature: 0.2,
      max_tokens: 512,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(function () { return ''; });
    throw new Error('Anthropic API error ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

async function callGoogle(endpoint, model, apiKey, systemPrompt, userQuestion) {
  const url = endpoint.indexOf('?') !== -1 ? (endpoint + '&key=' + apiKey) : (endpoint + '?key=' + apiKey);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userQuestion }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(function () { return ''; });
    throw new Error('Google API error ' + resp.status + ': ' + text.slice(0, 200));
  }
  const data = await resp.json();
  return (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '';
}

/**
 * Route a single call to the correct provider implementation.
 * @param {object} provider   One of COUNCIL_PROVIDERS
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {string} question
 * @returns {Promise<string>} raw text response
 */
export async function callProvider(provider, apiKey, systemPrompt, question) {
  if (!provider) throw new Error('No provider specified.');
  if (provider.id === 'anthropic') {
    return callAnthropic(provider.endpoint, provider.model, apiKey, systemPrompt, question);
  }
  if (provider.id === 'google') {
    return callGoogle(provider.endpoint, provider.model, apiKey, systemPrompt, question);
  }
  // OpenAI-compatible default
  return callOpenAICompat(provider.endpoint, provider.model, apiKey, systemPrompt, question);
}

// ---------------------------------------------------------------
// Synthesis -- compare answers into consensus / majority / contested
// ---------------------------------------------------------------

/**
 * Split an answer into simple, comparable phrases.
 * Splits on ". " (sentence boundaries), lowercases, trims, drops empties.
 * @param {string} answer
 * @returns {string[]}
 */
function tokenizePhrases(answer) {
  if (!answer || typeof answer !== 'string') return [];
  return answer
    .split('. ')
    .map(function (s) { return s.trim().toLowerCase().replace(/[.\s]+$/, ''); })
    .filter(function (s) { return s.length > 0; });
}

/**
 * Compare successful answers and bucket their phrases by how many of the
 * successful responses contain a matching (or near-matching) phrase.
 *
 * A phrase from one answer is considered "shared" with another answer if
 * that other answer contains a phrase that is either identical, or where
 * one phrase contains the other as a substring (handles minor wording
 * differences without needing a full NLP similarity model).
 *
 * @param {{provider: object, answer?: string, error?: string}[]} responses
 * @returns {{ consensus: string[], majority: string[], contested: string[], overallAgreement: 'high'|'moderate'|'low'|'none' }}
 */
export function synthesizeCouncil(responses) {
  const safeResponses = Array.isArray(responses) ? responses : [];
  const successful = safeResponses.filter(function (r) { return r && !r.error && r.answer && r.answer.trim(); });

  if (successful.length === 0) {
    return { consensus: [], majority: [], contested: [], overallAgreement: 'none' };
  }

  if (successful.length === 1) {
    return { consensus: [], majority: [], contested: [], overallAgreement: 'none' };
  }

  // Build per-answer phrase lists.
  const perAnswerPhrases = successful.map(function (r) { return tokenizePhrases(r.answer); });

  // Flatten unique phrases (dedupe within a single answer first).
  const allPhrases = [];
  const seenGlobal = new Set();
  for (let i = 0; i < perAnswerPhrases.length; i++) {
    const uniqueInAnswer = Array.from(new Set(perAnswerPhrases[i]));
    for (let j = 0; j < uniqueInAnswer.length; j++) {
      const phrase = uniqueInAnswer[j];
      const key = i + '::' + phrase;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      allPhrases.push({ phrase: phrase, fromAnswer: i });
    }
  }

  function phrasesMatch(a, b) {
    if (a === b) return true;
    if (a.length < 6 || b.length < 6) return false; // too short to compare fairly
    return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
  }

  const total = successful.length;
  const consensus = [];
  const majority = [];
  const contested = [];
  const countedPhrases = new Set(); // avoid re-processing near-duplicate phrases already bucketed

  for (let i = 0; i < allPhrases.length; i++) {
    const entry = allPhrases[i];
    if (countedPhrases.has(entry.phrase)) continue;

    // Count how many DISTINCT answers contain a matching phrase.
    const matchingAnswers = new Set();
    matchingAnswers.add(entry.fromAnswer);
    for (let a = 0; a < perAnswerPhrases.length; a++) {
      if (a === entry.fromAnswer) continue;
      const found = perAnswerPhrases[a].some(function (p) { return phrasesMatch(p, entry.phrase); });
      if (found) matchingAnswers.add(a);
    }

    countedPhrases.add(entry.phrase);

    const matchCount = matchingAnswers.size;
    if (matchCount >= total && total >= 2) {
      consensus.push(entry.phrase);
    } else if (matchCount >= 2) {
      majority.push(entry.phrase);
    } else {
      contested.push(entry.phrase);
    }
  }

  let overallAgreement = 'low';
  if (consensus.length > 0 && consensus.length >= majority.length && consensus.length >= contested.length) {
    overallAgreement = 'high';
  } else if (majority.length > 0 && majority.length >= contested.length) {
    overallAgreement = 'moderate';
  } else if (consensus.length === 0 && majority.length === 0) {
    overallAgreement = 'low';
  } else {
    overallAgreement = 'moderate';
  }

  return { consensus: consensus, majority: majority, contested: contested, overallAgreement: overallAgreement };
}

// ---------------------------------------------------------------
// Parallel council runner
// ---------------------------------------------------------------

/**
 * Run the council: call every configured, enabled provider in parallel via
 * Promise.allSettled, then synthesize the successful answers.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {string} [opts.schemaContext]
 * @param {{provider: object, apiKey?: string, enabled?: boolean}[]} opts.providers
 *   Each entry pairs a COUNCIL_PROVIDERS entry with its BYO key and on/off toggle.
 *   Providers with enabled === false are skipped entirely (not called, not counted).
 * @param {function} [opts.onProgress]  Called with { provider, status, elapsedMs? }
 * @param {function} [opts.callLLM]    Test injection point: async (provider, apiKey, systemPrompt, question) => rawText
 * @returns {Promise<{ responses: Array<{provider: object, answer?: string, elapsedMs?: number, error?: string}>, synthesis: object }>}
 */
export async function runCouncil(opts) {
  const options = opts || {};
  const question = options.question || '';
  const schemaContext = options.schemaContext || '';
  const providerConfigs = Array.isArray(options.providers) ? options.providers : [];
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const callLLM = typeof options.callLLM === 'function' ? options.callLLM : null;

  const systemPrompt = buildCouncilPrompt(question, schemaContext);

  const active = providerConfigs.filter(function (p) { return p && p.provider && p.enabled !== false; });

  const tasks = active.map(function (cfg) {
    const provider = cfg.provider;
    const apiKey = cfg.apiKey || '';
    const startedAt = Date.now();

    if (onProgress) onProgress({ provider: provider, status: 'pending' });

    const invoke = callLLM
      ? callLLM(provider, apiKey, systemPrompt, question)
      : callProvider(provider, apiKey, systemPrompt, question);

    return Promise.resolve(invoke)
      .then(function (answer) {
        const elapsedMs = Date.now() - startedAt;
        if (onProgress) onProgress({ provider: provider, status: 'done', elapsedMs: elapsedMs });
        return { provider: provider, answer: answer, elapsedMs: elapsedMs };
      })
      .catch(function (err) {
        const elapsedMs = Date.now() - startedAt;
        if (onProgress) onProgress({ provider: provider, status: 'error', elapsedMs: elapsedMs });
        return { provider: provider, error: (err && err.message) ? err.message : String(err), elapsedMs: elapsedMs };
      });
  });

  const settled = await Promise.allSettled(tasks);

  const responses = settled.map(function (result, idx) {
    if (result.status === 'fulfilled') return result.value;
    // Should not normally happen since each task already catches its own
    // errors, but guard anyway so a runner-level rejection never propagates.
    const provider = active[idx] ? active[idx].provider : null;
    return { provider: provider, error: (result.reason && result.reason.message) ? result.reason.message : String(result.reason) };
  });

  const synthesis = synthesizeCouncil(responses);

  return { responses: responses, synthesis: synthesis };
}
