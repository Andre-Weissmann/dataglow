// ============================================================
// DATAGLOW — "I don't know" Resolution Engine test suite (Gen 42, Part 2)
// ============================================================
// Proves the on-device uncertainty resolver behaves exactly as the spec fixes:
//   - uncertainty phrases (and a flagged empty skip) are detected,
//   - Steps A→D run IN ORDER (A statistical, B peer-index, C debate, D unified),
//   - the three debate agents run SEQUENTIALLY (single WebGPU context, never
//     parallel) and confidence-weighted reconciliation is used, not majority vote,
//   - the 2-second time budget is enforced → safe fallback when blown,
//   - Step E parks a SECOND "I don't know" instead of re-asking, and revisits
//     only with NEW cross-column evidence,
//   - the resolution path makes ZERO network calls (reuses the pack no-network
//     guard's runtime trap as the proof),
//   - only the ONE unified Step-D suggestion is surfaced (never the debate).
//
// Pure JS — no DuckDB, DOM, or real network. RUN WITH:
//   node test/uncertainty-resolver.test.mjs

import {
  UNCERTAINTY_PHRASES, detectUncertainty, reconcile,
  DEBATE_ROLES, buildDebatePrompt, defaultAgentProposal, runDebate,
  DEFAULT_TIME_BUDGET_MS, resolve, buildResolutionView,
  ResolverSession, buildParkedRevisit,
} from '../js/agents/uncertainty-resolver-agent.js';
import { runWithNetworkDenied, scanSourceForNetwork } from '../js/packs/pack-network-guard.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A hard-constraint candidate (percentage > 100) — Step A should resolve it.
function impossibleCandidate() {
  return {
    column: 'discount_pct', category: 'impossible', value: 150,
    observation: 'values up to 150%',
    ruleGuess: '"discount_pct" never go above 100%',
    severity: 0.5,
  };
}
// A soft outlier candidate — Steps A and B miss, Step C (debate) resolves it.
function outlierCandidate() {
  return {
    column: 'basket_value', category: 'outlier', value: 980,
    observation: 'an extreme value of 980',
    ruleGuess: '"basket_value" be flagged when it is that far from typical',
    severity: 0.3,
  };
}

async function main() {
  // ---------- 1. Uncertainty detection ----------
  ok(UNCERTAINTY_PHRASES.includes("i don't know"), 'detect: the phrase list includes "i don\'t know"');
  ok(detectUncertainty('I don\'t know') === true, 'detect: "I don\'t know" is uncertain');
  ok(detectUncertainty('not sure honestly') === true, 'detect: a phrase embedded in text is uncertain');
  ok(detectUncertainty('discounts cap at 100%') === false, 'detect: a confident answer is not uncertain');
  ok(detectUncertainty('', { flaggedUncertain: true }) === true,
    'detect: an empty skip counts as uncertain ONLY when the question was flagged uncertain');
  ok(detectUncertainty('') === false, 'detect: a plain empty answer is not uncertain by itself');

  // ---------- 2. Confidence-weighted reconciliation (NOT majority vote) ----------
  // Two low-confidence votes for "A" vs one high-confidence vote for "B".
  // A blind majority would pick "A"; weighted reconciliation picks "B".
  const reconciled = reconcile([
    { role: 'conservative', answer: 'cap at 90%', confidence: 0.3 },
    { role: 'industry-norm', answer: 'cap at 90%', confidence: 0.3 },
    { role: 'statistical', answer: 'cap at 100%', confidence: 0.9 },
  ]);
  ok(reconciled.answer === 'cap at 100%',
    'reconcile: confidence weighting beats a blind majority vote');
  ok(reconcile([]) === null, 'reconcile: nothing usable → null');

  // ---------- 3. Debate agents run SEQUENTIALLY against one context ----------
  ok(DEBATE_ROLES.length === 3
    && DEBATE_ROLES.join(',') === 'conservative,industry-norm,statistical',
    'debate: exactly three roles in the fixed order');
  const prompt = buildDebatePrompt('conservative', impossibleCandidate(), 'retail');
  ok(/on-device|own device/i.test(prompt.system) && prompt.user.includes('discount_pct'),
    'debate: the prompt is on-device framed and grounded in the column');

  // A stub LLM that records the ORDER and OVERLAP of calls — proves sequential,
  // single-context use (no two calls in flight at once).
  let inFlight = 0;
  let maxInFlight = 0;
  const callOrder = [];
  const seqLLM = {
    available: true,
    generate: async (p) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      callOrder.push(p.user.match(/Role: ([\w-]+)/)[1]);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return 'cap at 100%. confidence: 0.8';
    },
  };
  const { proposals } = await runDebate(outlierCandidate(), { llm: seqLLM, domain: 'retail' });
  ok(maxInFlight === 1, 'debate: never more than one LLM call in flight (single WebGPU context)');
  ok(callOrder.join(',') === 'conservative,industry-norm,statistical',
    'debate: the three agents ran in the fixed sequential order');
  ok(proposals.length === 3, 'debate: three proposals produced');

  // ---------- 4. No-LLM graceful degradation: deterministic proposals ----------
  const det = await runDebate(outlierCandidate(), {});
  ok(det.proposals.length === 3 && det.proposals.every(p => typeof p.confidence === 'number'),
    'debate: with no LLM, three deterministic rule-based proposals are produced');
  const consProp = defaultAgentProposal('conservative', impossibleCandidate());
  ok(consProp.confidence >= 0.9, 'debate: conservative agent is surest on a hard constraint');

  // ---------- 5. Steps A→D run IN ORDER ----------
  // Step A resolves an impossible value directly (no debate).
  const rA = await resolve(impossibleCandidate(), { domain: 'retail' });
  ok(rA.resolvedBy === 'A' && rA.source === 'statistical-confidence',
    'order: a hard-constraint value is resolved at Step A');
  ok(rA.stepsAttempted[0] === 'A', 'order: Step A is always attempted first');

  // Step B resolves via the peer index when A misses.
  const peerIndex = {
    findOne: ({ domain, columnPattern }) =>
      (domain === 'retail' && columnPattern === 'basket_value')
        ? { domain: 'retail', column_pattern: 'basket_value', suggested_rule: 'flag baskets over 500', source_pack: 'retail-shared' }
        : null,
  };
  const rB = await resolve(outlierCandidate(), { domain: 'retail', index: peerIndex });
  ok(rB.resolvedBy === 'B' && rB.source === 'peer-index' && rB.peer,
    'order: Step B borrows a peer answer when A misses');
  ok(rB.stepsAttempted.join(',') === 'A,B', 'order: B runs only after A is attempted');

  // Step C resolves via the debate when A and B both miss.
  const rC = await resolve(outlierCandidate(), { domain: 'retail' });
  ok(rC.resolvedBy === 'C' && rC.source === 'debate-panel',
    'order: Step C debate resolves when A and B miss');
  ok(rC.stepsAttempted.join(',') === 'A,B,C', 'order: C runs only after A and B');

  // ---------- 6. The 2-second budget is enforced → fallback ----------
  ok(DEFAULT_TIME_BUDGET_MS === 2000, 'budget: the default resolution budget is 2 seconds');
  // A fake clock that has ALREADY blown the budget before the debate starts.
  let t = 0;
  const clock = () => t;
  const slowLLM = { available: true, generate: async () => { t += 3000; return 'x. confidence: 0.9'; } };
  const rFallback = await resolve(outlierCandidate(), { domain: 'retail', now: clock, timeBudgetMs: 2000, llm: slowLLM });
  ok(rFallback.resolvedBy === 'fallback' && rFallback.source === 'fallback-default',
    'budget: a blown time budget falls back to a safe default');
  ok(rFallback.confidence <= 0.5, 'budget: the fallback carries low confidence');

  // ---------- 7. Step D surfaces ONE unified suggestion, never the debate ----------
  const view = buildResolutionView(rC, { voiceEnabled: false });
  ok(view.primary.length === 2, 'view: exactly two primary buttons');
  ok(!/conservative|industry-norm|statistical|debate|panel/i.test(view.message),
    'view: the debate/steps are NEVER shown to the user');
  ok(view.freeText.emphasis === 'low', 'view: the free-text fallback stays low-emphasis');
  const peerView = buildResolutionView(rB);
  ok(peerView.primary[0].label === 'Borrow that',
    'view: a peer-sourced suggestion offers to "Borrow that"');

  // ---------- 8. Step E: park-and-revisit ----------
  const session = new ResolverSession();
  const cand = outlierCandidate();
  ok(session.registerUncertainty(cand) === 'resolve', 'park: the FIRST uncertainty runs the resolver');
  ok(session.registerUncertainty(cand) === 'park', 'park: the SECOND uncertainty parks instead of re-asking');
  ok(session.parked.length === 1, 'park: the finding is parked exactly once');
  // Not revisitable until a couple of other findings resolve.
  ok(session.revisitable().length === 0, 'park: nothing to revisit until other findings resolve');
  session.noteResolved(); session.noteResolved();
  ok(session.revisitable(2).length === 1, 'park: revisitable after the min-gap of resolutions');

  // Revisit message only when NEW cross-column evidence exists.
  ok(buildParkedRevisit(cand, null) === null, 'revisit: no new evidence → do not nag');
  const msg = buildParkedRevisit(cand, {
    whenColumn: 'promo', whenEvent: 'a promo code is used',
    alsoColumn: 'basket_value', alsoEvent: 'the basket total spikes',
  });
  ok(msg && msg.includes('basket_value') && msg.includes('the basket total spikes'),
    'revisit: a cross-column co-occurrence is offered as new evidence');

  // ---------- 9. ZERO network calls across the whole resolution path ----------
  // Primary proof: the resolver's own source names NO network primitive at all
  // (reuses the pack no-network guard's static scan — the same mechanism CI runs
  // over every shipped pack file).
  const resolverSrc = readFileSync(join(__dirname, '..', 'js', 'agents', 'uncertainty-resolver-agent.js'), 'utf8');
  const violations = scanSourceForNetwork(resolverSrc);
  ok(violations.length === 0,
    `network: the resolver source references zero network primitives (found ${violations.map(v => v.primitive).join(', ') || 'none'})`);

  // Defence in depth: the synchronous entry into a resolution runs inside the
  // runtime trap without tripping it.
  let trapError = null;
  const resultInsideTrap = await runWithNetworkDenied(() => resolve(outlierCandidate(), { domain: 'retail' }))
    .catch(e => { trapError = e; return null; });
  ok(trapError === null && resultInsideTrap && resultInsideTrap.resolvedBy === 'C',
    'network: a full resolution runs to completion inside the no-network trap');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
