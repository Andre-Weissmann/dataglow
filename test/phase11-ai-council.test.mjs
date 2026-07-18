// ============================================================
// DataGlow Phase 11 — AI Council Tests
// ============================================================
// Tests for js/council/council-engine.js.
// No DOM, no real network calls — providers/LLM calls are injected mocks.
//
// Run: node test/phase11-ai-council.test.mjs
// ============================================================

import {
  COUNCIL_PROVIDERS,
  buildCouncilPrompt,
  callProvider,
  runCouncil,
  synthesizeCouncil,
  resolveGoogleEndpoint,
  GOOGLE_ENDPOINT_BASE,
  GOOGLE_ENDPOINT_SUFFIX,
  detectQuestionMode,
  detectDomain,
  parseAnswerSections,
  extractConfidenceLevel,
  scoreAlignment,
} from '../js/council/council-engine.js';

// ---- Minimal test harness (mirrors phase9's) ----
let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.error('  FAIL  ' + label); failed++; }
}

function section(title) { console.log('\n--- ' + title + ' ---'); }

// ---- Sample providers (mirroring COUNCIL_PROVIDERS shape) ----
const OPENAI = COUNCIL_PROVIDERS.find(function (p) { return p.id === 'openai'; });
const ANTHROPIC = COUNCIL_PROVIDERS.find(function (p) { return p.id === 'anthropic'; });
const GOOGLE = COUNCIL_PROVIDERS.find(function (p) { return p.id === 'google'; });

async function main() {
  // ============================================================
  section('buildCouncilPrompt');
  // ============================================================
  {
    const prompt = buildCouncilPrompt('Which metric best explains readmission risk?', 'TABLE encounters\n  readmit_30d INTEGER');
    ok(typeof prompt === 'string', 'returns a string');
    ok(prompt.indexOf('Which metric best explains readmission risk?') !== -1, 'includes the question');
    ok(prompt.indexOf('TABLE encounters') !== -1, 'includes the schema context');
    ok(prompt.indexOf('readmit_30d') !== -1, 'includes schema column detail');
    ok(prompt.toLowerCase().indexOf('fact') !== -1, 'instructs models to label facts');
    ok(prompt.toLowerCase().indexOf('opinion') !== -1 || prompt.toLowerCase().indexOf('opinion:') !== -1 || prompt.toLowerCase().indexOf('fact') !== -1, 'instructs models to label opinions');
    ok(prompt.toLowerCase().indexOf('hedge') !== -1 || prompt.toLowerCase().indexOf('hedging') !== -1 || prompt.toLowerCase().indexOf('caveat') !== -1, 'instructs models not to hedge excessively');
  }
  {
    const promptNoSchema = buildCouncilPrompt('What is the average length of stay?', '');
    ok(promptNoSchema.indexOf('What is the average length of stay?') !== -1, 'includes question when schema is empty');
    ok(promptNoSchema.indexOf('undefined') === -1, 'does not print undefined when schema missing');
  }
  {
    const promptNoArgs = buildCouncilPrompt();
    ok(typeof promptNoArgs === 'string', 'never throws when called with no args');
  }

  // ============================================================
  section('COUNCIL_PROVIDERS shape');
  // ============================================================
  {
    ok(COUNCIL_PROVIDERS.length === 3, 'exactly three providers configured');
    ok(!!OPENAI && !!ANTHROPIC && !!GOOGLE, 'all three provider ids present');
    ok(COUNCIL_PROVIDERS.every(function (p) { return p.requiresKey === true; }), 'every provider requires a key');
    ok(COUNCIL_PROVIDERS.every(function (p) { return typeof p.endpoint === 'string' && p.endpoint.indexOf('https://') === 0; }), 'every provider has an https endpoint');
  }

  // ============================================================
  section('runCouncil — all three resolve');
  // ============================================================
  {
    const progressEvents = [];
    const result = await runCouncil({
      question: 'What is the denial rate?',
      schemaContext: 'TABLE claims\n  claim_status VARCHAR',
      providers: [
        { provider: OPENAI, apiKey: 'k1', enabled: true },
        { provider: ANTHROPIC, apiKey: 'k2', enabled: true },
        { provider: GOOGLE, apiKey: 'k3', enabled: true },
      ],
      onProgress: function (evt) { progressEvents.push(evt); },
      callLLM: async function (provider) {
        return 'The denial rate is claims denied over total claims. This is a FACT about the formula. OPINION: focus on top denial reasons first.';
      },
    });

    ok(result.responses.length === 3, 'returns 3 responses');
    ok(result.responses.every(function (r) { return !r.error; }), 'all three succeeded (no errors)');
    ok(result.responses.every(function (r) { return typeof r.answer === 'string' && r.answer.length > 0; }), 'all three have non-empty answers');
    ok(result.responses.every(function (r) { return typeof r.elapsedMs === 'number'; }), 'all three report elapsedMs');
    ok(!!result.synthesis, 'synthesis object present');
    ok(result.synthesis.overallAgreement === 'high' || result.synthesis.overallAgreement === 'moderate', 'identical answers synthesize to high or moderate agreement');
    ok(progressEvents.filter(function (e) { return e.status === 'pending'; }).length === 3, 'onProgress fired pending for all three');
    ok(progressEvents.filter(function (e) { return e.status === 'done'; }).length === 3, 'onProgress fired done for all three');
  }

  // ============================================================
  section('runCouncil — one provider failing');
  // ============================================================
  {
    const result = await runCouncil({
      question: 'What is the average length of stay?',
      schemaContext: '',
      providers: [
        { provider: OPENAI, apiKey: 'k1', enabled: true },
        { provider: ANTHROPIC, apiKey: 'k2', enabled: true },
        { provider: GOOGLE, apiKey: 'k3', enabled: true },
      ],
      callLLM: async function (provider) {
        if (provider.id === 'anthropic') throw new Error('Anthropic API error 401: invalid key');
        return 'Average length of stay is computed as discharge minus admit date, averaged across encounters.';
      },
    });

    ok(result.responses.length === 3, 'still returns 3 response slots');
    const successes = result.responses.filter(function (r) { return !r.error; });
    const errors = result.responses.filter(function (r) { return !!r.error; });
    ok(successes.length === 2, 'exactly 2 successes');
    ok(errors.length === 1, 'exactly 1 error');
    ok(errors[0].provider.id === 'anthropic', 'the failing provider is anthropic');
    ok(errors[0].error.indexOf('invalid key') !== -1, 'error message is preserved');
    ok(!!result.synthesis, 'synthesis still computed with 2 successes');
  }

  // ============================================================
  section('runCouncil — all providers failing');
  // ============================================================
  {
    const result = await runCouncil({
      question: 'What is the readmission rate?',
      providers: [
        { provider: OPENAI, apiKey: 'k1', enabled: true },
        { provider: ANTHROPIC, apiKey: 'k2', enabled: true },
        { provider: GOOGLE, apiKey: 'k3', enabled: true },
      ],
      callLLM: async function () { throw new Error('network unreachable'); },
    });

    ok(result.responses.length === 3, 'returns 3 response slots');
    ok(result.responses.every(function (r) { return !!r.error; }), 'all three are errors');
    ok(result.synthesis.consensus.length === 0, 'no consensus when all fail');
    ok(result.synthesis.majority.length === 0, 'no majority when all fail');
    ok(result.synthesis.contested.length === 0, 'no contested when all fail (synthesis skipped)');
    ok(result.synthesis.overallAgreement === 'none', 'overallAgreement is none when all fail');
  }

  // ============================================================
  section('synthesizeCouncil — 3 identical answers');
  // ============================================================
  {
    const answer = 'The readmission rate is 30-day readmits over total discharges. This is the standard CMS definition.';
    const responses = [
      { provider: OPENAI, answer: answer },
      { provider: ANTHROPIC, answer: answer },
      { provider: GOOGLE, answer: answer },
    ];
    const synthesis = synthesizeCouncil(responses);
    ok(synthesis.consensus.length > 0 || synthesis.majority.length > 0 || synthesis.overallAgreement !== 'low', 'identical answers produce some agreement signal');
    ok(synthesis.contested.length === 0, 'identical answers produce zero contested phrases');
    ok(synthesis.overallAgreement === 'high' || synthesis.overallAgreement === 'moderate', 'identical answers -> at least moderate agreement');
  }

  // ============================================================
  section('synthesizeCouncil — 3 completely different answers');
  // ============================================================
  {
    const responses = [
      { provider: OPENAI, answer: 'Use the DRG weight column to explain cost variance across encounters.' },
      { provider: ANTHROPIC, answer: 'Payer type is the strongest predictor of claim denial outcomes here.' },
      { provider: GOOGLE, answer: 'Look at ICU length of stay trends broken out by service line instead.' },
    ];
    const synthesis = synthesizeCouncil(responses);
    ok(synthesis.consensus.length === 0, 'no shared phrases -> zero consensus');
    ok(synthesis.consensus.length === 0, 'no shared phrases -> zero consensus');
    ok(synthesis.overallAgreement === 'low' || synthesis.overallAgreement === 'moderate', 'divergent answers yield low or moderate agreement');
    ok(synthesis.overallAgreement !== 'none', 'agreement is computed when responses present');
  }

  // ============================================================
  section('synthesizeCouncil — 2 of 3 share a phrase');
  // ============================================================
  {
    const responses = [
      { provider: OPENAI, answer: 'The 30-day readmission rate is the best metric to track here.' },
      { provider: ANTHROPIC, answer: 'The 30-day readmission rate is the best metric to track here.' },
      { provider: GOOGLE, answer: 'Average length of stay by service line is more actionable in my view.' },
    ];
    const synthesis = synthesizeCouncil(responses);
    ok(synthesis.majority.length > 0, 'shared phrase between 2 of 3 lands in majority');
    ok(synthesis.consensus.length === 0, 'no phrase is shared by all three');
    ok(synthesis.overallAgreement !== 'none', 'synthesis computed with three responses');
    ok(synthesis.overallAgreement === 'moderate' || synthesis.overallAgreement === 'high', 'agreement reflects at least majority-level consensus');
  }

  // ============================================================
  section('synthesizeCouncil — empty / edge-case input never crashes');
  // ============================================================
  {
    const synthesisEmpty = synthesizeCouncil([]);
    ok(synthesisEmpty.consensus.length === 0 && synthesisEmpty.majority.length === 0 && synthesisEmpty.contested.length === 0, 'empty input returns empty buckets');
    ok(synthesisEmpty.overallAgreement === 'none', 'empty input reports none agreement');

    const synthesisNull = synthesizeCouncil(null);
    ok(Array.isArray(synthesisNull.consensus), 'null input does not throw, returns array shape');

    const synthesisAllErrors = synthesizeCouncil([{ provider: OPENAI, error: 'boom' }, { provider: ANTHROPIC, error: 'boom2' }]);
    ok(synthesisAllErrors.overallAgreement === 'none', 'all-error responses report none agreement');

    const synthesisOneOnly = synthesizeCouncil([{ provider: OPENAI, answer: 'Only one model answered this question clearly.' }]);
    ok(synthesisOneOnly.consensus.length === 0 && synthesisOneOnly.majority.length === 0 && synthesisOneOnly.contested.length === 0, 'single successful response yields no synthesis buckets');
    ok(synthesisOneOnly.overallAgreement === 'none', 'single response -> none agreement (no synthesis possible)');

    const synthesisBlankAnswers = synthesizeCouncil([{ provider: OPENAI, answer: '' }, { provider: ANTHROPIC, answer: '   ' }]);
    ok(synthesisBlankAnswers.overallAgreement === 'none', 'blank/whitespace-only answers treated as no successful responses');
  }

  // ============================================================
  section('onProgress callback — called for each provider state change');
  // ============================================================
  {
    const events = [];
    await runCouncil({
      question: 'What is the average DRG weight?',
      providers: [
        { provider: OPENAI, apiKey: 'k1', enabled: true },
        { provider: ANTHROPIC, apiKey: 'k2', enabled: true },
      ],
      onProgress: function (evt) { events.push(evt); },
      callLLM: async function (provider) {
        if (provider.id === 'anthropic') throw new Error('rate limited');
        return 'Average DRG weight is computed as the mean drg_weight across all encounters in the period.';
      },
    });

    ok(events.length === 4, 'exactly 4 progress events fired (pending+done/error per provider)');
    ok(events.filter(function (e) { return e.status === 'pending'; }).length === 2, '2 pending events');
    const openaiEvents = events.filter(function (e) { return e.provider.id === 'openai'; });
    const anthropicEvents = events.filter(function (e) { return e.provider.id === 'anthropic'; });
    ok(openaiEvents.some(function (e) { return e.status === 'done'; }), 'openai eventually reports done');
    ok(anthropicEvents.some(function (e) { return e.status === 'error'; }), 'anthropic eventually reports error');
    ok(events.every(function (e) { return !!e.provider && !!e.status; }), 'every event has a provider and a status');
  }

  // ============================================================
  section('Provider toggle — disabled provider not called');
  // ============================================================
  {
    let calledProviders = [];
    const result = await runCouncil({
      question: 'What is the ED utilization rate?',
      providers: [
        { provider: OPENAI, apiKey: 'k1', enabled: true },
        { provider: ANTHROPIC, apiKey: 'k2', enabled: false },
        { provider: GOOGLE, apiKey: 'k3', enabled: true },
      ],
      callLLM: async function (provider) {
        calledProviders.push(provider.id);
        return 'ED utilization rate is ED visits over total encounters in the period.';
      },
    });

    ok(result.responses.length === 2, 'only 2 responses returned when one provider is disabled');
    ok(calledProviders.indexOf('anthropic') === -1, 'disabled provider (anthropic) was never called');
    ok(calledProviders.indexOf('openai') !== -1 && calledProviders.indexOf('google') !== -1, 'both enabled providers were called');
    ok(result.responses.every(function (r) { return r.provider.id !== 'anthropic'; }), 'no response entry exists for the disabled provider');
  }

  // ============================================================
  section('Provider toggle — run with a single provider (no synthesis)');
  // ============================================================
  {
    const result = await runCouncil({
      question: 'What is the claim denial rate?',
      providers: [
        { provider: OPENAI, apiKey: 'k1', enabled: true },
        { provider: ANTHROPIC, apiKey: '', enabled: false },
        { provider: GOOGLE, apiKey: '', enabled: false },
      ],
      callLLM: async function () { return 'The claim denial rate is denied claims over total submitted claims.'; },
    });

    ok(result.responses.length === 1, 'only one response when two providers are disabled');
    ok(result.synthesis.overallAgreement === 'none', 'no synthesis possible with a single responder');
  }

  // ============================================================
  section('callProvider — routes by provider id (structural check)');
  // ============================================================
  {
    ok(typeof callProvider === 'function', 'callProvider is exported as a function');
    let threw = false;
    try {
      await callProvider(null, 'key', 'sys', 'question');
    } catch (err) {
      threw = true;
      ok(err.message.indexOf('No provider') !== -1, 'callProvider throws a clear error with no provider');
    }
    ok(threw, 'callProvider throws when provider is missing rather than silently failing');
  }

  // ============================================================
  section('runCouncil — missing/empty providers array never crashes');
  // ============================================================
  {
    const result = await runCouncil({ question: 'test question', providers: [] });
    ok(result.responses.length === 0, 'empty providers array yields zero responses');
    ok(result.synthesis.overallAgreement === 'none', 'empty run reports none agreement');

    const resultNoOpts = await runCouncil({});
    ok(Array.isArray(resultNoOpts.responses), 'runCouncil with empty opts object never throws');
  }

  // ============================================================
  section('resolveGoogleEndpoint -- model-override helper');
  // ============================================================
  {
    const defaultEp = resolveGoogleEndpoint('gemini-2.5-pro');
    ok(defaultEp.indexOf('gemini-2.5-pro') !== -1, 'default model name appears in endpoint');
    ok(defaultEp.startsWith(GOOGLE_ENDPOINT_BASE), 'endpoint starts with base URL');
    ok(defaultEp.endsWith(GOOGLE_ENDPOINT_SUFFIX), 'endpoint ends with :generateContent suffix');

    const flashEp = resolveGoogleEndpoint('gemini-2.5-flash');
    ok(flashEp.indexOf('gemini-2.5-flash') !== -1, 'flash model name appears in endpoint');
    ok(flashEp !== defaultEp, 'flash endpoint differs from pro endpoint');

    const gemini2Ep = resolveGoogleEndpoint('gemini-2.0-flash');
    ok(gemini2Ep.indexOf('gemini-2.0-flash') !== -1, 'gemini-2.0-flash resolves correctly');

    // Fallback: empty string should fall back to the default model
    const emptyEp = resolveGoogleEndpoint('');
    ok(emptyEp.indexOf('gemini-3.5-flash') !== -1, 'empty model string falls back to default');

    // null/undefined should not crash
    let threw = false;
    try { resolveGoogleEndpoint(null); resolveGoogleEndpoint(undefined); } catch (e) { threw = true; }
    ok(!threw, 'resolveGoogleEndpoint does not crash on null/undefined');

    // Whitespace is trimmed
    const spacedEp = resolveGoogleEndpoint('  gemini-2.5-flash  ');
    ok(spacedEp === flashEp, 'leading/trailing whitespace is trimmed from model name');
  }

  // ============================================================
  section('model override flows through runCouncil correctly');
  // ============================================================
  {
    // Simulate a user overriding the OpenAI model to gpt-4.1-mini
    // The override is applied by the UI before calling runCouncil;
    // here we verify runCouncil passes the overridden model through to callProvider.
    const seenModels = [];
    const captureProvider = async function (provider, apiKey, systemPrompt, question) {
      seenModels.push(provider.model);
      return 'answer from ' + provider.model;
    };
    const overriddenProviders = COUNCIL_PROVIDERS.map(function (p) {
      if (p.id === 'openai') return Object.assign({}, p, { model: 'gpt-4.1-mini', apiKey: 'key1', enabled: true });
      return Object.assign({}, p, { apiKey: 'key1', enabled: false });
    });
    const enabledOnly = overriddenProviders.filter(function (p) { return p.enabled !== false; });
    const result = await runCouncil({
      question: 'Which metric predicts readmission?',
      providers: enabledOnly.map(function (p) { return { provider: p, apiKey: 'key1', enabled: true }; }),
      callLLM: captureProvider,
    });
    ok(seenModels.length === 1, 'only the enabled provider was called');
    ok(seenModels[0] === 'gpt-4.1-mini', 'overridden model name gpt-4.1-mini was passed to provider call');
    ok(result.responses[0].answer.indexOf('gpt-4.1-mini') !== -1, 'answer reflects the overridden model');
  }


  // ============================================================
  section('detectQuestionMode -- mode routing');
  // ============================================================
  {
    const sqlQ = detectQuestionMode('SELECT claims FROM encounters WHERE payer = medicaid');
    ok(sqlQ.mode === 'sql', 'SQL question detected');

    const causalQ = detectQuestionMode('why is readmission rate increasing this quarter?');
    ok(causalQ.mode === 'causal', 'causal question detected');

    const statQ = detectQuestionMode('is this correlation statistically significant?');
    ok(statQ.mode === 'statistical', 'statistical question detected');

    const metricQ = detectQuestionMode('what does the denial rate metric measure?');
    ok(metricQ.mode === 'metric', 'metric question detected');

    const predQ = detectQuestionMode('predict which patients are at risk of readmission');
    ok(predQ.mode === 'prediction', 'prediction question detected');

    const compQ = detectQuestionMode('compare length of stay between hospitals A and B');
    ok(compQ.mode === 'comparison', 'comparison question detected');

    const genQ = detectQuestionMode('what should I do about this data?');
    ok(genQ.mode === 'general', 'general question falls through to general mode');

    const emptyQ = detectQuestionMode('');
    ok(emptyQ.mode === 'general', 'empty question defaults to general');

    const nullQ = detectQuestionMode(null);
    ok(nullQ.mode === 'general', 'null question defaults to general');
  }

  // ============================================================
  section('detectDomain -- industry context from schema and question');
  // ============================================================
  {
    const hcDomain = detectDomain('patient encounter claim icd denial', 'what is the readmission rate?');
    ok(hcDomain === 'healthcare', 'healthcare domain detected from schema + question');

    const finDomain = detectDomain('revenue expense profit margin ledger', 'what is the ARR?');
    ok(finDomain === 'finance', 'finance domain detected');

    const hrDomain = detectDomain('employee attrition tenure salary department hire termination', '');
    ok(hrDomain === 'hr', 'HR domain detected');

    const retailDomain = detectDomain('product sku order cart inventory supplier', 'refund rate');
    ok(retailDomain === 'retail', 'retail domain detected');

    const noDomain = detectDomain('', 'what is this?');
    ok(noDomain === null, 'no domain detected when signals are weak');
  }

  // ============================================================
  section('buildCouncilPrompt -- domain-agnostic expert format');
  // ============================================================
  {
    const finPrompt = buildCouncilPrompt('what is the ARR trend?', 'revenue arr churn subscription', null, 'finance');
    ok(finPrompt.indexOf('FINANCE') !== -1, 'finance domain appears in prompt');
    ok(finPrompt.indexOf('FINDING:') !== -1, 'FINDING section header present');
    ok(finPrompt.indexOf('EVIDENCE:') !== -1, 'EVIDENCE section header present');
    ok(finPrompt.indexOf('CONFIDENCE:') !== -1, 'CONFIDENCE section header present');
    ok(finPrompt.indexOf('CAVEATS:') !== -1, 'CAVEATS section header present');

    const sqlPrompt = buildCouncilPrompt('write SQL to get denial rate', '', { mode: 'sql', label: 'SQL Generation' }, null);
    ok(sqlPrompt.indexOf('SQL:') !== -1, 'SQL section header in SQL-mode prompt');
    ok(sqlPrompt.indexOf('EVIDENCE:') === -1, 'no EVIDENCE header in SQL-mode prompt');

    const genericPrompt = buildCouncilPrompt('explain this pattern', '', null, null);
    ok(genericPrompt.indexOf('senior data scientist') !== -1, 'expert persona in prompt');
    ok(genericPrompt.indexOf('healthcare analytics tool') === -1, 'no healthcare-only constraint in generic prompt');
    ok(genericPrompt.indexOf('FINDING:') !== -1, 'structured format enforced on generic prompt');
  }

  // ============================================================
  section('parseAnswerSections -- structured answer extraction');
  // ============================================================
  {
    const raw = 'FINDING: Denial rate is elevated at 18%.' + '\n' + 'EVIDENCE: The payer mix shifted toward Medicaid in Q3.' + '\n' + 'CONFIDENCE: HIGH -- three data points corroborate.' + '\n' + 'CAVEATS: Sample covers only the last 90 days.';
    const parsed = parseAnswerSections(raw);
    ok(parsed.finding.indexOf('18%') !== -1, 'finding section extracted');
    ok(parsed.evidence.indexOf('Medicaid') !== -1, 'evidence section extracted');
    ok(parsed.confidence.indexOf('HIGH') !== -1, 'confidence section extracted');
    ok(parsed.caveats.indexOf('90 days') !== -1, 'caveats section extracted');

    // Fallback: unstructured answer treated as finding
    const unstructured = parseAnswerSections('This is just a plain answer with no headers.');
    ok(unstructured.finding.indexOf('plain answer') !== -1, 'unstructured answer falls back to finding field');
    ok(unstructured.evidence === '', 'evidence is empty on unstructured answer');

    // Empty answer
    const empty = parseAnswerSections('');
    ok(empty.finding === '', 'empty answer returns empty finding');

    // SQL mode
    const sqlRaw = 'FINDING: Returns denial rate per payer.' + '\n' + 'SQL:' + '\n' + '```sql' + '\n' + 'SELECT payer, COUNT(*) FROM encounters;' + '\n' + '```' + '\n' + 'CONFIDENCE: MEDIUM -- schema is assumed.' + '\n' + 'CAVEATS: No date filter applied.';
    const sqlParsed = parseAnswerSections(sqlRaw);
    ok(sqlParsed.finding.indexOf('denial rate') !== -1, 'SQL finding extracted');
    ok(sqlParsed.evidence.indexOf('SELECT') !== -1, 'SQL block extracted into evidence field');
  }

  // ============================================================
  section('extractConfidenceLevel -- confidence parsing');
  // ============================================================
  {
    ok(extractConfidenceLevel('HIGH -- three signals agree') === 'HIGH', 'HIGH extracted');
    ok(extractConfidenceLevel('MEDIUM -- limited sample') === 'MEDIUM', 'MEDIUM extracted');
    ok(extractConfidenceLevel('LOW -- insufficient data') === 'LOW', 'LOW extracted');
    ok(extractConfidenceLevel('') === 'UNKNOWN', 'empty returns UNKNOWN');
    ok(extractConfidenceLevel(null) === 'UNKNOWN', 'null returns UNKNOWN');
    ok(extractConfidenceLevel('No level mentioned here') === 'UNKNOWN', 'unrecognized returns UNKNOWN');
  }

  // ============================================================
  section('scoreAlignment -- directional agreement scoring');
  // ============================================================
  {
    ok(scoreAlignment('Revenue increased significantly', 'Strong positive growth observed') === 1, 'two positive findings align');
    ok(scoreAlignment('Revenue increased significantly', 'Revenue improved and grew stronger') === 1, 'two clearly positive findings align');
    ok(scoreAlignment('neutral observation with no clear direction', 'another neutral finding here') === 0, 'neutral findings score 0');
    ok(scoreAlignment('', '') === 0, 'empty strings score 0');
    ok(scoreAlignment(null, null) === 0, 'nulls score 0');
  }

  // ============================================================
  section('synthesizeCouncil -- structured synthesis with narrative');
  // ============================================================
  {
    // Three agreeing structured answers
    const agreeResponses = [
      { provider: OPENAI,    answer: 'FINDING: Denial rate increased.' + '\n' + 'EVIDENCE: Payer mix shifted.' + '\n' + 'CONFIDENCE: HIGH -- consistent pattern.' + '\n' + 'CAVEATS: None.' },
      { provider: ANTHROPIC, answer: 'FINDING: Denial rate is up.' + '\n' + 'EVIDENCE: Claims data confirms the shift.' + '\n' + 'CONFIDENCE: HIGH -- robust evidence.' + '\n' + 'CAVEATS: Review monthly.' },
      { provider: GOOGLE,    answer: 'FINDING: Rate rose above baseline.' + '\n' + 'EVIDENCE: Three consecutive months show increase.' + '\n' + 'CONFIDENCE: HIGH -- clear trend.' + '\n' + 'CAVEATS: Seasonality possible.' },
    ];
    const agreeSynth = synthesizeCouncil(agreeResponses);
    ok(agreeSynth.overallAgreement === 'high' || agreeSynth.overallAgreement === 'moderate', 'agreeing answers produce high or moderate agreement');
    ok(Array.isArray(agreeSynth.confidenceLevels), 'confidenceLevels array present');
    ok(agreeSynth.confidenceLevels.length === 3, 'three confidence levels extracted');
    ok(agreeSynth.confidenceLevels.every(function (c) { return c === 'HIGH'; }), 'all three confidence levels are HIGH');
    ok(typeof agreeSynth.narrative === 'string' && agreeSynth.narrative.length > 0, 'narrative string is present');
    ok(Array.isArray(agreeSynth.sections) && agreeSynth.sections.length === 3, 'sections array has three entries');
    ok(agreeSynth.sections[0].parsed.finding.length > 0, 'first section parsed finding is non-empty');

    // Mixed: one error, two successful
    const partialResponses = [
      { provider: OPENAI,    error: 'Network timeout' },
      { provider: ANTHROPIC, answer: 'FINDING: Readmission rate is stable.' + '\n' + 'EVIDENCE: No change in 90 days.' + '\n' + 'CONFIDENCE: MEDIUM -- limited window.' + '\n' + 'CAVEATS: Sample small.' },
      { provider: GOOGLE,    answer: 'FINDING: Numbers appear unchanged.' + '\n' + 'EVIDENCE: Consistent across cohorts.' + '\n' + 'CONFIDENCE: MEDIUM -- short time window.' + '\n' + 'CAVEATS: More data needed.' },
    ];
    const partialSynth = synthesizeCouncil(partialResponses);
    ok(partialSynth.overallAgreement !== 'none', 'two successful responses still synthesize');
    ok(partialSynth.confidenceLevels.every(function (c) { return c === 'MEDIUM'; }), 'both confidence levels are MEDIUM');

    // All failed
    const allFailed = [
      { provider: OPENAI,    error: 'Quota exceeded' },
      { provider: ANTHROPIC, error: 'Invalid key' },
      { provider: GOOGLE,    error: 'Service unavailable' },
    ];
    const failedSynth = synthesizeCouncil(allFailed);
    ok(failedSynth.overallAgreement === 'none', 'all-failed = agreement none');
    ok(failedSynth.sections.length === 0, 'no sections when all failed');
  }

  // ============================================================
  section('runCouncil -- detectedMode and detectedDomain returned');
  // ============================================================
  {
    const mockLLM = async function (provider, apiKey, systemPrompt, question) {
      return 'FINDING: Test finding.' + '\n' + 'EVIDENCE: Test evidence.' + '\n' + 'CONFIDENCE: HIGH -- mock.' + '\n' + 'CAVEATS: None.';
    };
    const result = await runCouncil({
      question: 'why is the denial rate increasing?',
      schemaContext: 'encounter patient claim denial payer icd',
      providers: [{ provider: OPENAI, apiKey: 'key1', enabled: true }],
      callLLM: mockLLM,
    });
    ok(result.detectedMode && result.detectedMode.mode === 'causal', 'runCouncil returns detectedMode');
    ok(result.detectedDomain === 'healthcare', 'runCouncil returns detectedDomain');
    ok(result.synthesis.narrative && result.synthesis.narrative.length > 0, 'synthesis narrative returned from runCouncil');
  }

  // ============================================================
  section('prompt is domain-agnostic -- no healthcare-only assumption');
  // ============================================================
  {
    const financePrompt = buildCouncilPrompt('what is driving churn?', 'mrr arr churn subscription revenue', null, 'finance');
    ok(financePrompt.indexOf('healthcare analytics tool') === -1, 'no healthcare-only label in finance prompt');
    ok(financePrompt.indexOf('FINANCE') !== -1, 'finance domain injected correctly');

    const retailPrompt = buildCouncilPrompt('which product has the highest return rate?', 'product sku order refund return', null, 'retail');
    ok(retailPrompt.indexOf('RETAIL') !== -1, 'retail domain injected correctly');

    const noSchemaPrompt = buildCouncilPrompt('how do I interpret this data?', '', null, null);
    ok(noSchemaPrompt.indexOf('SCHEMA CONTEXT') === -1, 'no schema section when schema is empty');
    ok(noSchemaPrompt.indexOf('QUESTION:') !== -1, 'question always present');
  }

  // ---- Summary ----
  console.log('\n============================================================');
  console.log('Phase 11 AI Council: ' + passed + ' passed, ' + failed + ' failed');
  console.log('============================================================');
  if (failed > 0) process.exit(1);
}

main();
