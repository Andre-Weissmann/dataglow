// ============================================================
// DATAGLOW — Data-Grounded Question Generator test suite (Gen 42, Part 1)
// ============================================================
// Proves the cold-start question generator is ALWAYS data-grounded:
//   - every generated question references a REAL observed value from the loaded
//     data (never a blind, generic "what should never happen?" prompt),
//   - askability priority is honoured (impossible > outlier > missingness > format),
//   - the fixed question template wording is used verbatim,
//   - the two primary buttons + low-emphasis free-text/voice fallback match spec,
//   - ghost-text autocomplete completes a peer/common pattern,
//   - graceful degradation: extraction is pure arithmetic (no LLM) and a changed
//     layer shape degrades to fewer candidates, never a crash.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/question-generator.test.mjs

import {
  CATEGORY_WEIGHT, CATEGORY_ORDER,
  renderQuestionText, scanForAskableAnomalies, PRIMARY_RESPONSES,
  buildQuestion, buildQuestionView, confirmRestatement,
  COMMON_PATTERN_SUGGESTIONS, ghostCompletion, buildQuestionPrompt,
  heuristicCandidatesFromStats, candidatesFromMissingness,
  candidatesFromFormatDrift, generateQuestions,
} from '../js/agents/question-generator-agent.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function throws(fn, re, msg) {
  try { fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re ? re.test(e.message) : true, msg); }
}

// A fixture that mirrors the shapes DATAGLOW's real layers emit: per-column
// stats, missingness findings, and format-drift items — each carrying a REAL
// observed value the question must echo back.
function fixture() {
  return {
    columnStats: [
      { column: 'discount_pct', max: 150, min: 0, mean: 20, std: 15 },  // impossible: >100%
      { column: 'unit_count', max: 40, min: -3, mean: 10, std: 5 },      // impossible: negative
      { column: 'basket_value', max: 980, min: 1, mean: 50, std: 30 },   // outlier: z>3
      { column: 'store_id', max: 12, min: 1, mean: 6, std: 3 },          // nothing askable
    ],
    missingness: [
      { column: 'loyalty_tier', missingRate: 42.5, classification: 'MNAR' },
    ],
    formatDrift: [
      { column: 'phone', examples: ['(555) 123-4567', '5551234567'], severity: 0.5 },
    ],
  };
}

function main() {
  // ---------- 1. Fixed template wording is verbatim ----------
  const rendered = renderQuestionText('discount_pct', 'values up to 150%', '"discount_pct" never go above 100%');
  ok(rendered === 'I noticed your `discount_pct` column has values up to 150%. Is that expected, or should "discount_pct" never go above 100%?',
    'template: renderQuestionText matches the spec wording verbatim');

  // ---------- 2. Category weights honour askability priority ----------
  ok(CATEGORY_WEIGHT.impossible > CATEGORY_WEIGHT.outlier
    && CATEGORY_WEIGHT.outlier > CATEGORY_WEIGHT.missingness
    && CATEGORY_WEIGHT.missingness > CATEGORY_WEIGHT.format,
    'priority: impossible > outlier > missingness > format');
  ok(CATEGORY_ORDER.length === 4 && CATEGORY_ORDER[0] === 'impossible',
    'priority: CATEGORY_ORDER leads with impossible');

  // ---------- 3. Every generated question references a REAL value ----------
  const questions = generateQuestions(fixture(), { max: 5 });
  ok(questions.length >= 3, `grounded: produced at least 3 askable questions (got ${questions.length})`);
  for (const q of questions) {
    ok(q.observation.includes(String(q.value)),
      `grounded[${q.column}]: the observed value "${q.value}" appears in the observation`);
    ok(q.text.includes('`' + q.column + '`') && q.text.includes(q.observation),
      `grounded[${q.column}]: the question text embeds the real column + observation`);
    ok(!/what should never happen|in general|typically/i.test(q.text),
      `grounded[${q.column}]: the question is not a generic prompt`);
  }

  // ---------- 4. Priority ordering: impossible surfaces before missingness/format ----------
  const cats = questions.map(q => q.category);
  const firstImpossible = cats.indexOf('impossible');
  const firstFormat = cats.indexOf('format');
  ok(firstImpossible === 0, 'priority: an impossible-value question is ranked first');
  ok(firstFormat === -1 || firstFormat > cats.indexOf('outlier'),
    'priority: format ranks below outlier when both present');

  // ---------- 5. Non-grounded candidates are dropped, never surfaced ----------
  const mixed = [
    { column: 'x', category: 'impossible', observation: 'values up to 200%', value: 200, severity: 1 }, // grounded
    { column: 'y', category: 'impossible', observation: 'something vague', value: 999, severity: 1 },     // value NOT in text
    { column: 'z', category: 'outlier', observation: '', value: 5 },                                      // empty observation
    { column: '', category: 'impossible', observation: 'up to 5', value: 5 },                             // empty column
  ];
  const kept = scanForAskableAnomalies(mixed);
  ok(kept.length === 1 && kept[0].column === 'x',
    'grounded: scanForAskableAnomalies drops every non-grounded candidate');
  throws(() => buildQuestion(mixed[1]), /non-grounded/,
    'grounded: buildQuestion refuses a candidate whose value is absent from the observation');

  // ---------- 6. View model: two primary buttons + low-emphasis free-text ----------
  ok(PRIMARY_RESPONSES.length === 2
    && PRIMARY_RESPONSES[0].label === 'Sounds right — use that'
    && PRIMARY_RESPONSES[1].label === 'Skip for now',
    'view: the two equal-weight primary buttons match the spec');

  const view = buildQuestionView(questions[0], { voiceEnabled: false });
  ok(view.primary.length === 2, 'view: exactly two primary buttons (free-text is NOT a third button)');
  ok(view.freeText.emphasis === 'low', 'view: free-text field is low-emphasis (progressive disclosure)');
  ok(view.freeText.micIcon === false && view.freeText.voiceEnabled === false,
    'view: mic icon is hidden when voice is unavailable');

  const voiceView = buildQuestionView(questions[0], { voiceEnabled: true });
  ok(voiceView.freeText.micIcon === true && voiceView.freeText.voiceEnabled === true,
    'view: mic icon appears only when the caller reports voice available');

  // ---------- 7. Confirmation restatement is identical regardless of input ----------
  ok(confirmRestatement('discounts never exceed 100%') === '✅ Got it: discounts never exceed 100%',
    'confirm: restatement uses the single "✅ Got it:" wording');

  // ---------- 8. Ghost-text autocomplete ----------
  ok(COMMON_PATTERN_SUGGESTIONS.some(s => s.includes('100%')),
    'ghost: a common pattern about 100% exists');
  ok(ghostCompletion('never go a') === 'bove 100%',
    'ghost: completes a common pattern from a typed prefix');
  ok(ghostCompletion('') === '', 'ghost: empty input yields no ghost text');
  const peerGhost = ghostCompletion('disc', { peerSuggestions: ['discounts stay at or below 100%'] });
  ok(peerGhost === 'ounts stay at or below 100%',
    'ghost: a peer suggestion ranks ahead of the generic pool');

  // ---------- 9. LLM polish prompt is pure and pins the real value ----------
  const prompt = buildQuestionPrompt(questions[0]);
  ok(prompt.system && prompt.user && Array.isArray(prompt.messages),
    'polish: buildQuestionPrompt returns a system/user/messages prompt shape');
  ok(prompt.user.includes(String(questions[0].value)),
    'polish: the prompt pins the exact observed value so the LLM cannot invent one');

  // ---------- 10. Graceful degradation: tolerant readers never crash ----------
  ok(heuristicCandidatesFromStats(null).length === 0, 'degrade: null stats → no candidates, no crash');
  ok(candidatesFromMissingness(undefined).length === 0, 'degrade: undefined missingness → no candidates');
  ok(candidatesFromFormatDrift([{ nope: true }]).length === 0, 'degrade: unknown drift shape → dropped');
  ok(generateQuestions({}).length === 0, 'degrade: empty context → zero questions, no crash');

  // A percentage column at exactly 100 is NOT impossible (boundary check).
  const boundary = heuristicCandidatesFromStats([{ column: 'rate_pct', max: 100, min: 0, mean: 50, std: 10 }]);
  ok(!boundary.some(c => c.category === 'impossible'),
    'degrade: a percentage at exactly 100% is not flagged impossible');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
