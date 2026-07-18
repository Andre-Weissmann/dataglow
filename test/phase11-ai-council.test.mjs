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
    ok(prompt.toLowerCase().indexOf('opinion') !== -1, 'instructs models to label opinions');
    ok(prompt.toLowerCase().indexOf('hedge') !== -1, 'instructs models not to hedge excessively');
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
    ok(result.synthesis.overallAgreement === 'high', 'identical answers synthesize to high agreement');
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
    ok(synthesis.consensus.length > 0, 'identical answers produce consensus phrases');
    ok(synthesis.contested.length === 0, 'identical answers produce zero contested phrases');
    ok(synthesis.overallAgreement === 'high', 'identical answers -> high agreement');
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
    ok(synthesis.majority.length === 0, 'no shared phrases -> zero majority');
    ok(synthesis.contested.length > 0, 'all phrases land in contested');
    ok(synthesis.overallAgreement === 'low', 'overallAgreement is low for fully divergent answers');
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
    ok(synthesis.contested.length > 0, 'the divergent third answer lands in contested');
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

  // ---- Summary ----
  console.log('\n============================================================');
  console.log('Phase 11 AI Council: ' + passed + ' passed, ' + failed + ' failed');
  console.log('============================================================');
  if (failed > 0) process.exit(1);
}

main();
