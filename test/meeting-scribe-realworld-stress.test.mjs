// ============================================================
// DATAGLOW — Meeting Scribe real-world stress test (permanent regression)
// ============================================================
// Structural Readiness Phase item 1 ("prove breadth"), first pass, 2026-09-24.
//
// The existing test/meeting-scribe.test.mjs proves detectPushback/
// detectDataRequest work against phrasing that near-exactly matches the
// module's own PUSHBACK_PHRASES/DATA_REQUEST_PHRASES catalogs — which proves
// the code does what it does, but not whether it holds up against how people
// actually talk in a meeting (hedging, interruptions, self-correction,
// texting-style abbreviation, indirect phrasing).
//
// This file is the permanent regression form of that separate stress test:
// a 14-line synthetic-but-realistic meeting transcript, hand-annotated
// against ground truth BEFORE the module was run (see
// test-harness/meeting-scribe-realworld/realistic_transcript.md for the full
// annotated writeup and reasoning per line), run against the REAL,
// unmodified detectPushback/detectDataRequest — no mocking.
//
// First run (2026-09-24, before catalog widening): 6 of 14 lines (43%) fully
// correct, 8 false negatives, 0 false positives. The 8 misses' concrete
// phrase variants were then added to PUSHBACK_PHRASES/DATA_REQUEST_PHRASES
// (same substring-list design, no fuzzy/NLU matching — that stays a
// separate, bigger design decision). Second run: 14 of 14 (100%).
//
// This test locks in that 14/14 result as a floor: if a future change to the
// catalogs or matching logic regresses recall on any of these realistic
// lines, this test fails.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/meeting-scribe-realworld-stress.test.mjs

import { detectPushback, detectDataRequest } from '../js/agents/meeting-scribe-agent.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`✗ ${msg}`); }
}

// [text, groundTruthPushback, groundTruthDataRequest, note]
const CASES = [
  ["So, um, before we get into it, the retention numbers this month — they're kind of surprising to me, honestly.",
    true, false, "indirect skepticism, no original catalog phrase"],
  ["Yeah I saw that too, is that number even right? Feels off.",
    true, false, "\"feels off\" + \"is that number even right\" — extra words broke the original substring match"],
  ["Can we double check the churn calc before we present this Friday?",
    true, false, "contains original catalog phrase \"double check\""],
  ["Where's that number even coming from, the CRM or the billing system?",
    true, false, "different verb form + inserted \"even\" vs. original exact phrase"],
  ["Okay, let's also look at this by region if we can, curious if it's concentrated somewhere.",
    false, true, "conversational break-down-by-region ask, different construction than original catalog"],
  ["Actually can you pull the same thing for last quarter too, for comparison?",
    false, true, "contains original catalog phrase \"can you pull\""],
  ["Hmm. I don't know, something about this doesn't sit right with me.",
    true, false, "vague skepticism, no original catalog phrase — previously an honest edge case, now covered"],
  ["No that's fine, moving on — next slide please.",
    false, false, "plain transition — sanity check against over-triggering"],
  ["Wait, hold on — sorry to interrupt — are you sure? Are you sure that's not double-counting the churned accounts that came back?",
    true, false, "contains original catalog phrase \"are you sure\" despite interruption noise"],
  ["Fair question. Let's also grab the cohort data — could you send that over after this call?",
    false, true, "\"could you send\" without trailing \"me\" vs. original catalog's \"could you send me\""],
  ["Great, thanks. Also, small thing — can u add the churn definition as a footnote so nobody asks again?",
    false, true, "texting abbreviation \"u\" vs. original catalog's full word \"you\""],
  ["Sounds good. I don't love how volatile this metric is week to week, but that's a separate conversation.",
    false, false, "general unease, explicitly deferred — sanity check, not a challenge to a specific number"],
  ["One more thing — can you also break down the November cohort specifically, I think that's where the anomaly is.",
    false, true, "\"can you also break down X\" vs. original catalog's \"can you break this down by X\""],
  ["Yeah that tracks. Okay let's wrap — good discussion everyone.",
    false, false, "plain meeting close — sanity check"],
];

function main() {
  let fullyCorrect = 0;
  for (const [text, gtPushback, gtRequest, note] of CASES) {
    const pb = detectPushback(text);
    const dr = detectDataRequest(text);
    ok(pb.isPushback === gtPushback, `pushback on "${text}": expected ${gtPushback}, got ${pb.isPushback} (${note})`);
    ok(dr.isDataRequest === gtRequest, `data-request on "${text}": expected ${gtRequest}, got ${dr.isDataRequest} (${note})`);
    if (pb.isPushback === gtPushback && dr.isDataRequest === gtRequest) fullyCorrect++;
  }

  ok(fullyCorrect === CASES.length,
    `all ${CASES.length} realistic transcript lines are judged correctly (regression floor locked in 2026-09-24 after catalog widening) — got ${fullyCorrect}/${CASES.length}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
