// ============================================================
// DATAGLOW — Meeting Scribe Agent test suite (Gen 43, Part 1)
// ============================================================
// Proves the meeting scribe agent is deterministic and safe:
//   - pushback phrases are detected so they can trigger the EXISTING
//     uncertainty resolver's re-run, never a prose reply,
//   - data-request phrases are detected into a request queue,
//   - transcript segments are tagged with whichever chart/query context was
//     active at their timestamp, and segments before the first context event
//     are tagged null rather than guessing,
//   - an action item resolves ONLY once it carries owner + due date +
//     outcome; partial info stays open,
//   - the assembled meeting note is a plain JSON-safe object with the right
//     shape,
//   - graceful degradation: everything is pure arithmetic/string logic (no
//     LLM, no DOM, no network) so behaviour never depends on a browser.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/meeting-scribe.test.mjs

import {
  PUSHBACK_PHRASES, DATA_REQUEST_PHRASES,
  detectPushback, detectDataRequest, tagSegmentsWithContext,
  buildActionItem, isActionItemResolved, resolveActionItem, buildMeetingNote,
  buildPushbackCandidate, MEETING_PUSHBACK_CATEGORY,
} from '../js/agents/meeting-scribe-agent.js';
import { resolve } from '../js/agents/uncertainty-resolver-agent.js';
import { buildDebateDiagnostics } from '../js/agents/debate-diagnostics.js';
import { scanSourceForNetwork } from '../js/packs/pack-network-guard.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = readFileSync(join(HERE, '../js/agents/meeting-scribe-agent.js'), 'utf8');
const UI_SRC = readFileSync(join(HERE, '../js/agents/meeting-scribe-ui.js'), 'utf8');

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

async function main() {
  // ---------- 1. Pushback detection ----------
  ok(detectPushback('Why did this drop last week?').isPushback, 'pushback: "why did this drop" is detected');
  ok(detectPushback('Are you sure about that number?').isPushback, 'pushback: "are you sure" is detected');
  ok(detectPushback('Great, thanks for the update.').isPushback === false, 'pushback: a plain remark is NOT flagged');
  ok(detectPushback('').isPushback === false, 'pushback: empty text is NOT flagged');
  ok(detectPushback(null).isPushback === false, 'pushback: null text is handled without throwing');

  // ---------- 2. Data-request detection ----------
  ok(detectDataRequest('Can you also pull last quarter\u2019s numbers?').isDataRequest, 'data-request: "can you also pull" is detected');
  ok(detectDataRequest('Could we get a breakdown by region?').isDataRequest, 'data-request: "could we get" is detected');
  ok(detectDataRequest('This chart looks good.').isDataRequest === false, 'data-request: a plain remark is NOT flagged');

  // ---------- 3. Every catalog phrase is actually detectable ----------
  const allPushbackDetected = PUSHBACK_PHRASES.every((p) => detectPushback(`So, ${p}?`).isPushback);
  ok(allPushbackDetected, 'every PUSHBACK_PHRASES entry is detected in context');
  const allRequestDetected = DATA_REQUEST_PHRASES.every((p) => detectDataRequest(`${p} the raw export too?`).isDataRequest);
  ok(allRequestDetected, 'every DATA_REQUEST_PHRASES entry is detected in context');

  // ---------- 4. Context tagging ----------
  const segments = [
    { text: 'Let\u2019s start with revenue.', ts: 100 },
    { text: 'Why did this drop in March?', ts: 500 },
    { text: 'Can you also pull the refund rate?', ts: 900 },
    { text: 'Looks fine overall.', ts: 1500 },
  ];
  const timeline = [
    { ts: 200, chart: 'revenue-trend', queryLabel: 'monthly_revenue' },
    { ts: 1000, chart: 'refund-rate', queryLabel: 'refund_rate_by_month' },
  ];
  const tagged = tagSegmentsWithContext(segments, timeline);
  ok(tagged.length === 4, 'tagSegmentsWithContext: returns one tagged entry per segment');
  ok(tagged[0].context === null, 'tagSegmentsWithContext: segment before first context event is tagged null');
  ok(tagged[1].context && tagged[1].context.chart === 'revenue-trend', 'tagSegmentsWithContext: segment tagged with active chart at its timestamp');
  ok(tagged[1].pushback.isPushback === true, 'tagSegmentsWithContext: pushback flag carried onto the tagged segment');
  ok(tagged[2].dataRequest.isDataRequest === true, 'tagSegmentsWithContext: data-request flag carried onto the tagged segment');
  ok(tagged[3].context && tagged[3].context.chart === 'refund-rate', 'tagSegmentsWithContext: later segment tagged with the newer context event');

  // Malformed input degrades gracefully rather than throwing.
  const taggedEmpty = tagSegmentsWithContext(null, undefined);
  ok(Array.isArray(taggedEmpty) && taggedEmpty.length === 0, 'tagSegmentsWithContext: null/undefined input degrades to an empty array, no throw');
  const taggedNoContext = tagSegmentsWithContext(segments, []);
  ok(taggedNoContext.every((s) => s.context === null), 'tagSegmentsWithContext: empty timeline tags every segment null, never guesses');

  // ---------- 5. Action item minimum-viable-record rule ----------
  const item = buildActionItem({ text: 'Will follow up on refund spike', ts: 900 });
  ok(item.status === 'open', 'buildActionItem: a fresh action item starts open');
  ok(isActionItemResolved(item) === false, 'isActionItemResolved: an item with no owner/dueDate/outcome is NOT resolved');

  const partiallyResolved = resolveActionItem(item, { owner: 'Priya' });
  ok(partiallyResolved.status === 'open', 'resolveActionItem: owner alone does NOT resolve the item (stays open)');

  const fullyResolved = resolveActionItem(item, { owner: 'Priya', dueDate: '2026-07-18', outcome: 'Refund spike traced to a March return-window bug' });
  ok(fullyResolved.status === 'resolved', 'resolveActionItem: owner + dueDate + outcome resolves the item');
  ok(item.status === 'open', 'resolveActionItem: does not mutate the original item object');

  // ---------- 6. Meeting note assembly ----------
  const note = buildMeetingNote({
    meetingId: 'mtg-2026-07-11-standup',
    startedAt: '2026-07-11T15:00:00Z',
    taggedSegments: tagged,
    actionItems: [fullyResolved],
  });
  ok(note.meetingId === 'mtg-2026-07-11-standup', 'buildMeetingNote: meetingId carried through');
  ok(note.quoteCount === 4, 'buildMeetingNote: quoteCount matches the number of tagged segments');
  ok(note.pushbackMoments.length === 1, 'buildMeetingNote: pushbackMoments collects exactly the flagged segment');
  ok(note.dataRequests.length === 1, 'buildMeetingNote: dataRequests collects exactly the flagged segment');
  ok(note.chartsDiscussed.includes('revenue-trend') && note.chartsDiscussed.includes('refund-rate'), 'buildMeetingNote: chartsDiscussed lists every distinct chart touched');
  ok(note.actionItems[0].status === 'resolved', 'buildMeetingNote: actionItems passed through untouched');
  ok(JSON.stringify(note).length > 0, 'buildMeetingNote: output is JSON-safe (no functions/circular refs)');

  // Malformed input degrades gracefully rather than throwing.
  const emptyNote = buildMeetingNote({});
  ok(emptyNote.quoteCount === 0 && Array.isArray(emptyNote.chartsDiscussed), 'buildMeetingNote: empty input degrades to a well-shaped empty note, no throw');

  // ---------- 7. Pushback → resolver candidate (pure, honest) ----------
  const withContext = buildPushbackCandidate({
    text: 'Why did this drop in March?', matched: 'why did this drop', ts: 500,
    context: { chart: 'revenue-trend', queryLabel: 'monthly_revenue' },
  });
  ok(withContext.category === MEETING_PUSHBACK_CATEGORY, 'candidate: uses the NEW meeting-pushback category (not impossible/outlier)');
  ok(withContext.column === 'revenue-trend', 'candidate: column comes from the tagged chart context');
  ok(withContext.observation.includes('Why did this drop in March?'), 'candidate: observation quotes the actual transcript text verbatim');
  ok(withContext.ruleGuess === 'treat this as worth a second look', 'candidate: ruleGuess is a generic placeholder, not a fabricated specific rule');

  const noContext = buildPushbackCandidate({ text: 'Are you sure about that number?', matched: 'are you sure', ts: 12, context: null });
  ok(noContext.column === 'the number under discussion', 'candidate: null context yields a neutral placeholder column, never a guessed one');
  ok(noContext.observation.includes('Are you sure about that number?'), 'candidate: observation still quotes the text with no context');

  // HONESTY: the candidate never fabricates a statistic or hard-constraint claim.
  const honest = buildPushbackCandidate({ text: 'That seems off to me', matched: 'that seems off', ts: 3, context: null });
  const blob = JSON.stringify(honest).toLowerCase();
  ok(!/\bstd\b|standard deviation|z-?score|percentile|\d+\s*sd|hardconstraint|impossible/.test(blob),
    'candidate: names no fabricated statistic or hard-constraint — it only quotes what was said');
  ok(honest.stat === undefined && honest.severity === undefined,
    'candidate: sets no stat/severity, so resolve() cannot take Step A’s hard-constraint fast path');

  // Malformed / empty input degrades gracefully.
  const emptyCand = buildPushbackCandidate(null);
  ok(emptyCand.category === MEETING_PUSHBACK_CATEGORY && typeof emptyCand.observation === 'string',
    'candidate: null input degrades to a well-shaped candidate, no throw');

  // Does not mutate its input.
  const input = Object.freeze({ text: 'is that right?', matched: 'is that right', ts: 1, context: null });
  buildPushbackCandidate(input);
  ok(input.text === 'is that right?', 'candidate: never mutates its input segment');

  // ---------- 8. The candidate really routes through resolve() to the debate ----------
  // No LLM injected → the resolver falls back to its deterministic Step-C debate,
  // so a meeting-pushback candidate resolves at Step C with revealable diagnostics
  // rather than Step A's hard-constraint fast path.
  const resolution = await resolve(withContext);
  ok(resolution.resolvedBy === 'C', 'resolve(candidate): a meeting-pushback candidate routes to Step C (the debate), not Step A/B');
  ok(typeof resolution.suggestion === 'string' && typeof resolution.confidence === 'number', 'resolve(candidate): yields a suggestion + numeric confidence');
  ok(buildDebateDiagnostics(resolution).available === true, 'resolve(candidate): the Step-C resolution exposes revealable debate diagnostics');

  // ---------- 9. SAFETY: the re-check path is READ-ONLY (no apply/mutation/network) ----------
  // The whole feature only DISPLAYS a re-check result. It must never auto-apply
  // anything: it names no primitive that writes to a pack, rule, dataset, metrics
  // registry, decision ledger, or persistent storage, and no network primitive.
  ok(scanSourceForNetwork(AGENT_SRC).length === 0, 'safety: meeting-scribe-agent.js names no network primitive');
  ok(scanSourceForNetwork(UI_SRC).length === 0, 'safety: meeting-scribe-ui.js names no network primitive');
  const APPLY_TOKENS = [
    'importPack(', 'registerRuntimePack(', 'applyFix(', 'recordStep(', 'defineMetric(',
    'appendLedgerEntries(', 'saveLedgerEntries(', 'clearLedgerEntries(', 'localStorage',
  ];
  for (const tok of APPLY_TOKENS) {
    ok(!AGENT_SRC.includes(tok), `safety: meeting-scribe-agent.js names no apply/mutation primitive (${tok})`);
    ok(!UI_SRC.includes(tok), `safety: meeting-scribe-ui.js names no apply/mutation primitive (${tok})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
