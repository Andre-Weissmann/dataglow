// test/meeting-synthesis.test.mjs
// Tests for js/agents/meeting-synthesis.js (Live Rooms Batch 4)
// Node-only: pure prompt builder + result summarizer.

import { ok, strictEqual, doesNotThrow } from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 FAILED: ' + name + '\n    ' + e.message); failed++; }
}

const {
  buildSynthesisPrompt,
  summarizeMeetingSynthesis,
  isSynthesisAvailable,
} = await import('../js/agents/meeting-synthesis.js');

// Optionally cross-check against a real note shape built by the scribe agent.
const { buildMeetingNote, tagSegmentsWithContext, buildActionItem } =
  await import('../js/agents/meeting-scribe-agent.js');

// ---- a full, realistic meeting note ---------------------------------------
function makeFullNote() {
  const segments = [
    { text: 'Why did revenue drop in March?', ts: 100 },
    { text: 'Can you also pull the regional breakdown?', ts: 200 },
    { text: 'Are you sure that number is right?', ts: 300 },
  ];
  const timeline = [
    { ts: 50, chart: 'revenue-trend', queryLabel: 'SELECT month, rev' },
    { ts: 250, chart: 'regional-breakdown', queryLabel: 'SELECT region, rev' },
  ];
  const tagged = tagSegmentsWithContext(segments, timeline);
  const actionItems = [
    buildActionItem({ text: 'Follow up with finance on March revenue', ts: 400 }),
    buildActionItem({ text: 'Pull regional breakdown', ts: 500 }),
  ];
  return buildMeetingNote({ meetingId: 'm-1', startedAt: '2026-07-18T10:00:00Z', taggedSegments: tagged, actionItems });
}

// ---- buildSynthesisPrompt: full note --------------------------------------
test('buildSynthesisPrompt returns systemPrompt and userPrompt strings', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  strictEqual(typeof p.systemPrompt, 'string');
  strictEqual(typeof p.userPrompt, 'string');
  ok(p.systemPrompt.length > 0);
  ok(p.userPrompt.length > 0);
});

test('buildSynthesisPrompt userPrompt mentions action items', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  ok(/Action items/i.test(p.userPrompt));
  ok(/Follow up with finance/.test(p.userPrompt));
});

test('buildSynthesisPrompt userPrompt mentions pushback', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  ok(/Pushback moments/i.test(p.userPrompt));
});

test('buildSynthesisPrompt userPrompt mentions data requests', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  ok(/Data requests/i.test(p.userPrompt));
});

test('buildSynthesisPrompt userPrompt mentions the grounding context (charts)', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  ok(/grounding context/i.test(p.userPrompt));
  ok(/revenue-trend/.test(p.userPrompt) || /regional-breakdown/.test(p.userPrompt));
});

test('buildSynthesisPrompt systemPrompt forbids fabrication', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  ok(/do not invent|only|faithful/i.test(p.systemPrompt));
});

test('buildSynthesisPrompt systemPrompt names the four parts', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  ok(/Pushback/i.test(p.systemPrompt));
  ok(/Data requests/i.test(p.systemPrompt));
  ok(/Action items/i.test(p.systemPrompt));
  ok(/grounding context/i.test(p.systemPrompt));
});

test('buildSynthesisPrompt includes the meeting id and quote count', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  ok(/m-1/.test(p.userPrompt));
  ok(/Quotes captured/i.test(p.userPrompt));
});

// ---- buildSynthesisPrompt: empty / null -----------------------------------
test('buildSynthesisPrompt with null does not throw and returns strings', function() {
  doesNotThrow(function() { buildSynthesisPrompt(null); });
  const p = buildSynthesisPrompt(null);
  strictEqual(typeof p.systemPrompt, 'string');
  strictEqual(typeof p.userPrompt, 'string');
  ok(p.systemPrompt.length > 0);
});

test('buildSynthesisPrompt with undefined does not throw', function() {
  doesNotThrow(function() { buildSynthesisPrompt(undefined); });
});

test('buildSynthesisPrompt with empty object degrades gracefully (all none)', function() {
  const p = buildSynthesisPrompt({});
  ok(/none/i.test(p.userPrompt));
  ok(/Pushback moments \(0\)/.test(p.userPrompt));
  ok(/Action items \(0\)/.test(p.userPrompt));
});

test('buildSynthesisPrompt with a non-object (string) does not throw', function() {
  doesNotThrow(function() { buildSynthesisPrompt('not a note'); });
  const p = buildSynthesisPrompt('not a note');
  strictEqual(typeof p.userPrompt, 'string');
});

// ---- iOS constraint: no template literals in output -----------------------
test('prompts contain no backtick characters (iOS: no template literals)', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  strictEqual(p.systemPrompt.indexOf('`'), -1);
  strictEqual(p.userPrompt.indexOf('`'), -1);
});

test('prompts are plain-language multi-line strings', function() {
  const p = buildSynthesisPrompt(makeFullNote());
  ok(p.userPrompt.indexOf('\n') > -1);
  ok(p.systemPrompt.indexOf('\n') > -1);
});

// ---- summarizeMeetingSynthesis: happy path --------------------------------
test('summarizeMeetingSynthesis returns the trimmed summary text', function() {
  const out = summarizeMeetingSynthesis('  Here is the summary.  ', makeFullNote());
  strictEqual(out.summary, 'Here is the summary.');
});

test('summarizeMeetingSynthesis extracts actionItemCount from the note', function() {
  const out = summarizeMeetingSynthesis('summary', makeFullNote());
  strictEqual(out.actionItemCount, 2);
});

test('summarizeMeetingSynthesis extracts pushbackCount from the note', function() {
  const note = makeFullNote();
  const out = summarizeMeetingSynthesis('summary', note);
  strictEqual(out.pushbackCount, note.pushbackMoments.length);
  ok(out.pushbackCount >= 1);
});

test('summarizeMeetingSynthesis extracts contextReferenceCount from the note', function() {
  const note = makeFullNote();
  const out = summarizeMeetingSynthesis('summary', note);
  strictEqual(out.contextReferenceCount, note.chartsDiscussed.length);
});

test('summarizeMeetingSynthesis returns all four fields', function() {
  const out = summarizeMeetingSynthesis('x', makeFullNote());
  ok('summary' in out);
  ok('actionItemCount' in out);
  ok('pushbackCount' in out);
  ok('contextReferenceCount' in out);
});

// ---- summarizeMeetingSynthesis: null / empty ------------------------------
test('summarizeMeetingSynthesis with null response yields empty summary, zero counts', function() {
  const out = summarizeMeetingSynthesis(null, null);
  strictEqual(out.summary, '');
  strictEqual(out.actionItemCount, 0);
  strictEqual(out.pushbackCount, 0);
  strictEqual(out.contextReferenceCount, 0);
});

test('summarizeMeetingSynthesis with no args does not throw', function() {
  doesNotThrow(function() { summarizeMeetingSynthesis(); });
  const out = summarizeMeetingSynthesis();
  strictEqual(out.summary, '');
  strictEqual(out.actionItemCount, 0);
});

test('summarizeMeetingSynthesis with a non-string response yields empty summary', function() {
  const out = summarizeMeetingSynthesis({ not: 'a string' }, makeFullNote());
  strictEqual(out.summary, '');
  strictEqual(out.actionItemCount, 2);
});

test('summarizeMeetingSynthesis with response but no note yields zero counts', function() {
  const out = summarizeMeetingSynthesis('a valid summary', null);
  strictEqual(out.summary, 'a valid summary');
  strictEqual(out.actionItemCount, 0);
  strictEqual(out.pushbackCount, 0);
});

// ---- isSynthesisAvailable -------------------------------------------------
test('isSynthesisAvailable returns a boolean', function() {
  strictEqual(typeof isSynthesisAvailable(), 'boolean');
});

test('isSynthesisAvailable returns false (stub, wired via DI in main.js)', function() {
  strictEqual(isSynthesisAvailable(), false);
});

test('isSynthesisAvailable never throws', function() {
  doesNotThrow(function() { isSynthesisAvailable(); });
});

// ---- summary --------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
