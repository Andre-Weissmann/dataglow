// ============================================================
// DATAGLOW -- AI Council Engine (Deep Reasoning Edition)
// ============================================================
// Calls three LLM providers in parallel with the SAME question and
// dataset context, then synthesizes their answers using a structured
// expert-reasoning format and semantic agreement scoring.
//
// UPGRADE GOALS (feature/council-deep-reasoning):
//   - Domain-agnostic: works for healthcare, finance, operations, research,
//     HR, supply chain, marketing analytics -- any industry.
//   - Expert-grade answers: structured FINDING / EVIDENCE / CONFIDENCE /
//     CAVEATS format instead of 3-5 short sentences.
//   - Semantic synthesis: LLM-backed agreement scoring via a dedicated
//     reconciler call, replacing naive substring word-matching.
//   - Mode detection: the prompt adapts based on whether the question
//     is asking for SQL, statistical analysis, causal inference,
//     metric interpretation, or general analytical judgment.
//
// BYO-key, dependency-injected provider pattern (same as nl-sql-engine.js):
// callLLM can be injected for tests -- zero network calls in Node.
//
// Privacy: schema-only guarantee. This module never reads row data.
// The caller decides what context (if any) is passed in.
// ============================================================

// ---------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------
// MODEL NAMES: editable in the UI without touching code.
// Type a new name in the model field on the Council tab.
// For Google/Gemini, the model name is embedded in the endpoint URL --
// changing it in the UI automatically rebuilds the URL via resolveGoogleEndpoint().
//
// Current frontier models (July 2026 -- update when models change):
//   OpenAI:    gpt-5.6-sol (flagship), gpt-5.6-terra (balanced), gpt-5.6-luna (budget)
//   Anthropic: claude-fable-5 (frontier), claude-sonnet-5 (agentic/balanced), claude-opus-4-8 (strong)
//   Google:    gemini-3.5-flash (fast, broadly available), gemini-3.5-pro (frontier, July 2026 GA)
export const COUNCIL_PROVIDERS = [
  { id: 'openai',    name: 'OpenAI (GPT)',       endpoint: 'https://api.openai.com/v1/chat/completions',   model: 'gpt-5.6-sol',     requiresKey: true },
  { id: 'anthropic', name: 'Anthropic (Claude)', endpoint: 'https://api.anthropic.com/v1/messages',        model: 'claude-fable-5',  requiresKey: true },
  { id: 'google',    name: 'Google (Gemini)',    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', model: 'gemini-3.5-flash', requiresKey: true },
];

// Google endpoint template -- model name is embedded in the path.
export const GOOGLE_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
export const GOOGLE_ENDPOINT_SUFFIX = ':generateContent';

/**
 * Build the correct Google endpoint URL for any Gemini model name.
 * @param {string} modelName  e.g. 'gemini-3.5-flash' or 'gemini-3.5-pro'
 * @returns {string}
 */
export function resolveGoogleEndpoint(modelName) {
  return GOOGLE_ENDPOINT_BASE + (modelName || 'gemini-3.5-flash').trim() + GOOGLE_ENDPOINT_SUFFIX;
}

// ---------------------------------------------------------------
// Question mode detection
// ---------------------------------------------------------------
// Determines what kind of analytical task the user is asking for
// so the prompt can load the right expert reasoning framework.

var MODE_PATTERNS = [
  {
    mode: 'sql',
    label: 'SQL Generation',
    signals: ['select ', 'from ', 'where ', 'group by', 'join ', 'write.*sql', 'sql.*for', 'query.*to', 'give me.*sql', 'how.*query'],
  },
  {
    mode: 'causal',
    label: 'Causal Inference',
    signals: ['cause', 'caused by', 'why is', 'why are', 'why does', 'root cause', 'driving', 'factor', 'explain.*why', 'what.*leads to', 'confound', 'treatment effect', 'counterfactual'],
  },
  {
    mode: 'statistical',
    label: 'Statistical Analysis',
    signals: ['significant', 'p-value', 'confidence interval', 'correlation', 'regression', 'distribution', 'outlier', 'anomaly', 'variance', 'standard deviation', 'mean', 'median', 'skew', 'hypothesis'],
  },
  {
    mode: 'metric',
    label: 'Metric Interpretation',
    signals: ['rate', 'ratio', 'kpi', 'metric', 'measure', 'benchmark', 'target', 'goal', 'performance', 'score', 'index', 'what does.*mean', 'interpret', 'threshold'],
  },
  {
    mode: 'prediction',
    label: 'Predictive Analysis',
    signals: ['predict', 'forecast', 'will', 'expect', 'likelihood', 'probability', 'risk', 'future', 'trend', 'model.*predict', 'feature.*import'],
  },
  {
    mode: 'comparison',
    label: 'Comparative Analysis',
    signals: ['compare', 'versus', ' vs ', 'difference between', 'better', 'worse', 'higher', 'lower', 'which.*better', 'rank', 'top', 'bottom', 'best', 'worst'],
  },
];

/**
 * Detect the analytical mode of a question.
 * Returns the first matching mode or 'general' if none match.
 * @param {string} question
 * @returns {{ mode: string, label: string }}
 */
export function detectQuestionMode(question) {
  if (!question) return { mode: 'general', label: 'General Analysis' };
  var q = question.toLowerCase();
  for (var i = 0; i < MODE_PATTERNS.length; i++) {
    var pattern = MODE_PATTERNS[i];
    for (var j = 0; j < pattern.signals.length; j++) {
      if (q.indexOf(pattern.signals[j]) !== -1) {
        return { mode: pattern.mode, label: pattern.label };
      }
    }
  }
  return { mode: 'general', label: 'General Analysis' };
}

// ---------------------------------------------------------------
// Expert reasoning framework per mode
// ---------------------------------------------------------------

var REASONING_FRAMEWORKS = {
  sql: [
    'Write correct, runnable SQL based ONLY on the columns listed in the schema context.',
    'Return ONE SQL block. No prose before or after it.',
    'If a join is needed, pick the most appropriate join type and explain it in a single comment inside the SQL.',
    'If the question is ambiguous about aggregation period or grouping, pick the most common-sense interpretation and add a -- NOTE comment.',
    'Never invent column names. If the needed column is absent from the schema, say so clearly before the SQL block.',
  ],
  causal: [
    'Apply rigorous causal reasoning: distinguish correlation from causation explicitly.',
    'Identify at least one likely confounder or alternative explanation for the observed pattern.',
    'State your causal claim as a DIRECTED relationship: "X likely increases Y because Z".',
    'If the data alone cannot establish causality (no experiment, no natural experiment), say so and suggest what additional data would be needed.',
    'Cite the type of evidence that would strengthen or weaken the causal claim (RCT, difference-in-differences, propensity score matching, etc.).',
  ],
  statistical: [
    'Apply statistical thinking: what is the sample size context? Is statistical significance claimed? Is it practically significant?',
    'Identify the correct statistical test or method for this question (t-test, chi-square, ANOVA, etc.) and explain why.',
    'Flag any distributional assumptions that may be violated.',
    'Distinguish between statistical significance and effect size -- both matter.',
    'If you detect a multiple comparisons problem, say so.',
  ],
  metric: [
    'Define the metric precisely: numerator, denominator, time window, and population.',
    'State whether this metric is a leading or lagging indicator.',
    'Give the industry-standard benchmark range for this metric, or note if none exists.',
    'Identify the top two or three factors that typically move this metric up or down.',
    'Flag any known issues with how this metric is commonly misused or misread.',
  ],
  prediction: [
    'Name the most appropriate predictive approach (regression, classification, time-series, survival analysis, etc.) and why.',
    'List the top features you would expect to be predictive, with brief justification for each.',
    'Identify the biggest data quality risk that could invalidate the prediction.',
    'State what evaluation metric you would use (RMSE, AUC, F1, etc.) and why.',
    'Flag any target leakage risks in the dataset as described.',
  ],
  comparison: [
    'Structure your comparison as a clear table or numbered list -- do not bury it in prose.',
    'State which entity wins on each dimension you compare.',
    'Identify any dimension where the comparison is misleading or apples-to-oranges.',
    'Give an overall recommendation with a confidence level: HIGH / MEDIUM / LOW.',
    'Name one assumption that, if wrong, would reverse your recommendation.',
  ],
  general: [
    'Give your most expert analytical take, not a cautious hedge.',
    'Structure your answer: main finding first, then supporting reasoning.',
    'If you see a risk or a problem, name it directly.',
    'If the question is underspecified, state your interpretation before answering.',
    'End with one specific next step the analyst should take with this data.',
  ],
};

// ---------------------------------------------------------------
// Domain detection from schema context
// ---------------------------------------------------------------

var DOMAIN_SIGNALS = {
  healthcare: ['patient', 'encounter', 'claim', 'diagnosis', 'icd', 'cpt', 'readmission', 'discharge', 'ehr', 'provider', 'payer', 'denial', 'length_of_stay', 'admit', 'procedure', 'rx', 'prescription'],
  finance: ['revenue', 'expense', 'profit', 'margin', 'loan', 'credit', 'debit', 'ledger', 'account', 'balance', 'interest', 'portfolio', 'equity', 'asset', 'liability', 'arr', 'mrr', 'churn'],
  retail: ['product', 'sku', 'order', 'cart', 'checkout', 'inventory', 'supplier', 'shipment', 'customer', 'purchase', 'refund', 'return', 'category', 'price'],
  hr: ['employee', 'headcount', 'attrition', 'tenure', 'salary', 'department', 'hire', 'termination', 'performance', 'review', 'payroll', 'benefit'],
  marketing: ['campaign', 'impression', 'click', 'conversion', 'ctr', 'cpa', 'roas', 'funnel', 'lead', 'acquisition', 'channel', 'cohort', 'ltv', 'segment'],
  operations: ['shipment', 'delay', 'defect', 'throughput', 'cycle_time', 'downtime', 'sla', 'ticket', 'incident', 'queue', 'utilization'],
};

/**
 * Detect the industry domain from schema context and question text.
 * Returns a domain name or null.
 * @param {string} schemaContext
 * @param {string} question
 * @returns {string|null}
 */
export function detectDomain(schemaContext, question) {
  var combined = ((schemaContext || '') + ' ' + (question || '')).toLowerCase();
  var bestDomain = null;
  var bestScore = 0;
  var domains = Object.keys(DOMAIN_SIGNALS);
  for (var i = 0; i < domains.length; i++) {
    var domain = domains[i];
    var signals = DOMAIN_SIGNALS[domain];
    var score = 0;
    for (var j = 0; j < signals.length; j++) {
      if (combined.indexOf(signals[j]) !== -1) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestScore >= 2 ? bestDomain : null;
}

// ---------------------------------------------------------------
// Prompt builder (domain-agnostic, mode-aware, expert-grade)
// ---------------------------------------------------------------

/**
 * Build the expert system prompt for a council member.
 * Adapts to question mode and detected domain automatically.
 *
 * @param {string} question
 * @param {string} [schemaContext]  Schema-only text (no row data).
 * @param {{ mode: string, label: string }} [modeHint]  Pre-detected mode.
 * @param {string|null} [domain]  Pre-detected domain.
 * @returns {string}
 */
export function buildCouncilPrompt(question, schemaContext, modeHint, domain) {
  var detectedMode = modeHint || detectQuestionMode(question);
  var detectedDomain = domain !== undefined ? domain : detectDomain(schemaContext, question);
  var framework = REASONING_FRAMEWORKS[detectedMode.mode] || REASONING_FRAMEWORKS.general;

  var lines = [];

  lines.push('You are a senior data scientist and analytical expert with deep cross-industry experience.');
  lines.push('You are one of three independent expert models deliberating inside DataGlow.');
  lines.push('The other two models are answering this SAME question right now. Your answers will be compared side by side.');
  lines.push('');

  if (detectedDomain) {
    lines.push('DOMAIN CONTEXT: The dataset appears to be in the ' + detectedDomain.toUpperCase() + ' domain.');
    lines.push('Apply domain-specific knowledge, benchmarks, and reasoning appropriate for ' + detectedDomain + ' analytics.');
    lines.push('');
  }

  lines.push('TASK TYPE: ' + detectedMode.label);
  lines.push('');

  lines.push('EXPERT REASONING FRAMEWORK -- follow every instruction:');
  for (var i = 0; i < framework.length; i++) {
    lines.push((i + 1) + '. ' + framework[i]);
  }
  lines.push('');

  lines.push('ANSWER FORMAT (use these exact section headers):');
  if (detectedMode.mode === 'sql') {
    lines.push('FINDING: [one sentence: what the SQL computes and why]');
    lines.push('SQL:');
    lines.push('```sql');
    lines.push('-- your query here');
    lines.push('```');
    lines.push('CONFIDENCE: HIGH / MEDIUM / LOW -- [one sentence explaining your confidence]');
    lines.push('CAVEATS: [edge cases, missing columns, or assumptions -- bullet points if multiple]');
  } else {
    lines.push('FINDING: [your main analytical conclusion, 1-2 sentences, direct and specific]');
    lines.push('EVIDENCE: [supporting reasoning, 2-4 sentences -- cite specific metrics, thresholds, or patterns]');
    lines.push('CONFIDENCE: HIGH / MEDIUM / LOW -- [one sentence explaining what drives your confidence level]');
    lines.push('CAVEATS: [limitations, alternative explanations, or what would change your answer -- bullet points if multiple]');
  }
  lines.push('');

  lines.push('RULES (non-negotiable):');
  lines.push('- Be direct and specific. No excessive hedging. No "it depends" without an explanation.');
  lines.push('- Never invent data, columns, or facts not present in the schema or question.');
  lines.push('- Do not refer to yourself as an AI or describe your own limitations generically.');
  lines.push('- If the question is ambiguous, state your interpretation first, then answer it.');
  lines.push('- Apply the highest standards of your domain -- this is expert-level analysis, not general chat.');
  lines.push('');

  if (schemaContext && schemaContext.trim()) {
    lines.push('SCHEMA CONTEXT (columns and types only -- no row data):');
    lines.push(schemaContext.trim());
    lines.push('');
  }

  lines.push('QUESTION: ' + (question || ''));

  return lines.join('\n');
}

// ---------------------------------------------------------------
// LLM call implementations (browser-side, BYO API key)
// ---------------------------------------------------------------

async function callOpenAICompat(endpoint, model, apiKey, systemPrompt, userQuestion) {
  var resp = await fetch(endpoint, {
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
      temperature: 0.3,
      max_tokens: 1200,
    }),
  });
  if (!resp.ok) {
    var text = await resp.text().catch(function () { return ''; });
    throw new Error('OpenAI API error ' + resp.status + ': ' + text.slice(0, 200));
  }
  var data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

async function callAnthropic(endpoint, model, apiKey, systemPrompt, userQuestion) {
  var resp = await fetch(endpoint, {
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
      temperature: 0.3,
      max_tokens: 1200,
    }),
  });
  if (!resp.ok) {
    var text = await resp.text().catch(function () { return ''; });
    throw new Error('Anthropic API error ' + resp.status + ': ' + text.slice(0, 200));
  }
  var data = await resp.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

async function callGoogle(endpoint, model, apiKey, systemPrompt, userQuestion) {
  var url = endpoint.indexOf('?') !== -1 ? (endpoint + '&key=' + apiKey) : (endpoint + '?key=' + apiKey);
  var resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userQuestion }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1200 },
    }),
  });
  if (!resp.ok) {
    var text = await resp.text().catch(function () { return ''; });
    throw new Error('Google API error ' + resp.status + ': ' + text.slice(0, 200));
  }
  var data = await resp.json();
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
  return callOpenAICompat(provider.endpoint, provider.model, apiKey, systemPrompt, question);
}

// ---------------------------------------------------------------
// Answer section parser
// ---------------------------------------------------------------
// Extracts FINDING / EVIDENCE / CONFIDENCE / CAVEATS sections from
// structured answers so synthesis can compare like with like.

/**
 * Parse a structured answer into its sections.
 * Returns an object with finding, evidence, confidence, caveats.
 * Falls back gracefully if the model didn't follow the format.
 * @param {string} answer
 * @returns {{ finding: string, evidence: string, confidence: string, caveats: string, raw: string }}
 */
export function parseAnswerSections(answer) {
  var raw = answer || '';
  var result = { finding: '', evidence: '', confidence: '', caveats: '', raw: raw };
  if (!raw.trim()) return result;

  var sections = ['FINDING', 'EVIDENCE', 'SQL', 'CONFIDENCE', 'CAVEATS'];
  for (var i = 0; i < sections.length; i++) {
    var key = sections[i];
    var lowerKey = key.toLowerCase() === 'sql' ? 'sql' : key.toLowerCase().replace('caveats', 'caveats');
    var startPattern = key + ':';
    var startIdx = raw.indexOf(startPattern);
    if (startIdx === -1) continue;
    var contentStart = startIdx + startPattern.length;

    // Find where the next section starts
    var nextStart = raw.length;
    for (var j = 0; j < sections.length; j++) {
      if (j === i) continue;
      var nextPattern = sections[j] + ':';
      var nextIdx = raw.indexOf(nextPattern, contentStart);
      if (nextIdx !== -1 && nextIdx < nextStart) nextStart = nextIdx;
    }

    var content = raw.slice(contentStart, nextStart).trim();
    if (key === 'FINDING') result.finding = content;
    else if (key === 'EVIDENCE' || key === 'SQL') result.evidence = content;
    else if (key === 'CONFIDENCE') result.confidence = content;
    else if (key === 'CAVEATS') result.caveats = content;
  }

  // Fallback: if no sections found, treat the whole answer as the finding
  if (!result.finding && !result.evidence) {
    result.finding = raw.trim();
  }

  return result;
}

// ---------------------------------------------------------------
// Semantic synthesis
// ---------------------------------------------------------------
// Compares parsed answers for conceptual agreement rather than
// word-matching. Uses a lightweight scoring approach:
//   - Parse all answers into sections
//   - Extract CONFIDENCE levels and agree/disagree on direction
//   - Compare FINDING sentences for directional alignment
//   - Produce an agreement narrative rather than phrase buckets

/**
 * Extract confidence level from a confidence section string.
 * @param {string} confidenceText
 * @returns {'HIGH'|'MEDIUM'|'LOW'|'UNKNOWN'}
 */
export function extractConfidenceLevel(confidenceText) {
  if (!confidenceText) return 'UNKNOWN';
  var upper = confidenceText.toUpperCase();
  if (upper.indexOf('HIGH') !== -1) return 'HIGH';
  if (upper.indexOf('MEDIUM') !== -1) return 'MEDIUM';
  if (upper.indexOf('LOW') !== -1) return 'LOW';
  return 'UNKNOWN';
}

/**
 * Score directional alignment between two FINDING strings.
 * Returns 1 if they appear to agree, 0 if neutral, -1 if they contradict.
 * Uses simple positive/negative signal word matching.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function scoreAlignment(a, b) {
  if (!a || !b) return 0;
  var posSignals = ['increase', 'higher', 'better', 'positive', 'recommend', 'should', 'significant', 'strong', 'effective', 'improve'];
  var negSignals = ['decrease', 'lower', 'worse', 'negative', 'not recommend', 'should not', 'insignificant', 'weak', 'ineffective', 'decline'];

  function score(text) {
    var t = text.toLowerCase();
    var s = 0;
    for (var i = 0; i < posSignals.length; i++) { if (t.indexOf(posSignals[i]) !== -1) s++; }
    for (var i = 0; i < negSignals.length; i++) { if (t.indexOf(negSignals[i]) !== -1) s--; }
    return s;
  }

  var sa = score(a);
  var sb = score(b);
  if (sa === 0 && sb === 0) return 0;
  if ((sa > 0 && sb > 0) || (sa < 0 && sb < 0)) return 1;
  if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) return -1;
  return 0;
}

/**
 * Synthesize council responses using structured section comparison.
 * Replaces the old phrase-tokenisation approach with section-aware scoring.
 *
 * @param {{provider: object, answer?: string, error?: string}[]} responses
 * @returns {{
 *   consensus: string[],
 *   majority: string[],
 *   contested: string[],
 *   overallAgreement: 'high'|'moderate'|'low'|'none',
 *   sections: Array<{provider: object, parsed: object}>,
 *   confidenceLevels: string[],
 *   narrative: string
 * }}
 */
export function synthesizeCouncil(responses) {
  var safeResponses = Array.isArray(responses) ? responses : [];
  var successful = safeResponses.filter(function (r) { return r && !r.error && r.answer && r.answer.trim(); });

  var empty = { consensus: [], majority: [], contested: [], overallAgreement: 'none', sections: [], confidenceLevels: [], narrative: '' };
  if (successful.length === 0) return empty;
  if (successful.length === 1) {
    var parsed1 = parseAnswerSections(successful[0].answer);
    return Object.assign({}, empty, {
      overallAgreement: 'none',
      sections: [{ provider: successful[0].provider, parsed: parsed1 }],
      confidenceLevels: [extractConfidenceLevel(parsed1.confidence)],
      narrative: 'Only one model responded. No synthesis possible.',
    });
  }

  // Parse all answers into structured sections
  var parsedAnswers = successful.map(function (r) {
    return { provider: r.provider, parsed: parseAnswerSections(r.answer) };
  });

  var confidenceLevels = parsedAnswers.map(function (p) {
    return extractConfidenceLevel(p.parsed.confidence);
  });

  // Score pairwise directional alignment on FINDING sections
  var alignmentScores = [];
  for (var i = 0; i < parsedAnswers.length; i++) {
    for (var j = i + 1; j < parsedAnswers.length; j++) {
      var score = scoreAlignment(parsedAnswers[i].parsed.finding, parsedAnswers[j].parsed.finding);
      alignmentScores.push(score);
    }
  }

  var totalPairs = alignmentScores.length;
  var agreePairs = alignmentScores.filter(function (s) { return s === 1; }).length;
  var disagreePairs = alignmentScores.filter(function (s) { return s === -1; }).length;
  var neutralPairs = alignmentScores.filter(function (s) { return s === 0; }).length;

  // Determine overall agreement
  var overallAgreement;
  if (disagreePairs > 0) {
    overallAgreement = 'low';
  } else if (agreePairs === totalPairs && totalPairs > 0) {
    overallAgreement = 'high';
  } else if (neutralPairs === totalPairs) {
    overallAgreement = 'moderate'; // neutral = not contradicting, moderate confidence
  } else {
    overallAgreement = 'moderate';
  }

  // Confidence consensus
  var highCount = confidenceLevels.filter(function (c) { return c === 'HIGH'; }).length;
  var lowCount = confidenceLevels.filter(function (c) { return c === 'LOW'; }).length;
  var confidenceSummary = '';
  if (highCount === confidenceLevels.length) {
    confidenceSummary = 'All models express HIGH confidence.';
  } else if (lowCount === confidenceLevels.length) {
    confidenceSummary = 'All models express LOW confidence -- treat findings cautiously.';
  } else if (lowCount > 0) {
    confidenceSummary = lowCount + ' of ' + confidenceLevels.length + ' models express LOW confidence.';
  } else {
    confidenceSummary = 'Models express mixed confidence: ' + confidenceLevels.join(', ') + '.';
  }

  // Build consensus / majority / contested from FINDING sections
  // (kept for UI compatibility -- now represents conceptual categories
  // rather than raw phrase overlap)
  var consensus = [];
  var majority = [];
  var contested = [];

  if (overallAgreement === 'high') {
    consensus.push('All models reach the same directional conclusion on the main finding.');
    if (confidenceLevels.every(function (c) { return c === 'HIGH'; })) {
      consensus.push('All models report HIGH confidence.');
    }
  } else if (overallAgreement === 'moderate' && disagreePairs === 0) {
    majority.push('Models are directionally aligned or neutral -- no contradictions detected.');
    if (highCount > 0) {
      majority.push(highCount + ' model(s) report HIGH confidence.');
    }
  } else if (overallAgreement === 'low') {
    contested.push('Models contradict each other on the main finding. Review each answer carefully.');
    if (disagreePairs === totalPairs) {
      contested.push('Every model pair is in directional disagreement -- treat this question as genuinely contested.');
    }
  }

  // Caveat consensus: if all models flag a caveat keyword, surface it
  var caveatKeywords = ['missing data', 'sample size', 'confound', 'assumption', 'not enough', 'limited', 'incomplete'];
  for (var k = 0; k < caveatKeywords.length; k++) {
    var keyword = caveatKeywords[k];
    var flaggedBy = parsedAnswers.filter(function (p) {
      return (p.parsed.caveats || '').toLowerCase().indexOf(keyword) !== -1;
    });
    if (flaggedBy.length === parsedAnswers.length) {
      majority.push('All models flag a concern about: ' + keyword + '.');
    } else if (flaggedBy.length >= 2) {
      majority.push('Most models flag a concern about: ' + keyword + '.');
    }
  }

  // Build narrative summary
  var narrativeParts = [];
  if (overallAgreement === 'high') {
    narrativeParts.push('The three models reach directional agreement on this question.');
  } else if (overallAgreement === 'moderate') {
    narrativeParts.push('The models are broadly aligned without direct contradictions.');
  } else {
    narrativeParts.push('The models disagree on the main finding -- this is a genuinely contested question.');
  }
  narrativeParts.push(confidenceSummary);
  if (contested.length > 0) {
    narrativeParts.push('Read all three answers carefully before acting.');
  }

  return {
    consensus: consensus,
    majority: majority,
    contested: contested,
    overallAgreement: overallAgreement,
    sections: parsedAnswers,
    confidenceLevels: confidenceLevels,
    narrative: narrativeParts.join(' '),
  };
}

// ---------------------------------------------------------------
// Parallel council runner
// ---------------------------------------------------------------

/**
 * Run the council: call every configured, enabled provider in parallel,
 * detect the question mode and domain, build an expert prompt, then
 * synthesize the structured answers.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {string} [opts.schemaContext]
 * @param {{provider: object, apiKey?: string, enabled?: boolean}[]} opts.providers
 * @param {function} [opts.onProgress]  Called with { provider, status, elapsedMs? }
 * @param {function} [opts.callLLM]    Test injection: async (provider, apiKey, systemPrompt, question) => rawText
 * @returns {Promise<{
 *   responses: Array<{provider, answer?, elapsedMs?, error?}>,
 *   synthesis: object,
 *   detectedMode: {mode, label},
 *   detectedDomain: string|null
 * }>}
 */
export async function runCouncil(opts) {
  var options = opts || {};
  var question = options.question || '';
  var schemaContext = options.schemaContext || '';
  var providerConfigs = Array.isArray(options.providers) ? options.providers : [];
  var onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  var callLLM = typeof options.callLLM === 'function' ? options.callLLM : null;

  var detectedMode = detectQuestionMode(question);
  var detectedDomain = detectDomain(schemaContext, question);
  var systemPrompt = buildCouncilPrompt(question, schemaContext, detectedMode, detectedDomain);

  var active = providerConfigs.filter(function (p) { return p && p.provider && p.enabled !== false; });

  var tasks = active.map(function (cfg) {
    var provider = cfg.provider;
    var apiKey = cfg.apiKey || '';
    var startedAt = Date.now();

    if (onProgress) onProgress({ provider: provider, status: 'pending' });

    var invoke = callLLM
      ? callLLM(provider, apiKey, systemPrompt, question)
      : callProvider(provider, apiKey, systemPrompt, question);

    return Promise.resolve(invoke)
      .then(function (answer) {
        var elapsedMs = Date.now() - startedAt;
        if (onProgress) onProgress({ provider: provider, status: 'done', elapsedMs: elapsedMs });
        return { provider: provider, answer: answer, elapsedMs: elapsedMs };
      })
      .catch(function (err) {
        var elapsedMs = Date.now() - startedAt;
        if (onProgress) onProgress({ provider: provider, status: 'error', elapsedMs: elapsedMs });
        return { provider: provider, error: (err && err.message) ? err.message : String(err), elapsedMs: elapsedMs };
      });
  });

  var settled = await Promise.allSettled(tasks);

  var responses = settled.map(function (result, idx) {
    if (result.status === 'fulfilled') return result.value;
    var provider = active[idx] ? active[idx].provider : null;
    return { provider: provider, error: (result.reason && result.reason.message) ? result.reason.message : String(result.reason) };
  });

  var synthesis = synthesizeCouncil(responses);

  return { responses: responses, synthesis: synthesis, detectedMode: detectedMode, detectedDomain: detectedDomain };
}
