// test/chart-context-timeline.test.mjs
// Tests for js/agents/chart-context-timeline.js (Live Rooms Batch 3)
// Node-only: pure recorder logic + integration with tagSegmentsWithContext.

import { ok, strictEqual, deepEqual, throws, doesNotThrow } from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 FAILED: ' + name + '\n    ' + e.message); failed++; }
}

const {
  buildChartContextEntry,
  createChartContextTimeline,
} = await import('../js/agents/chart-context-timeline.js');

const { tagSegmentsWithContext } = await import('../js/agents/meeting-scribe-agent.js');

// ---- buildChartContextEntry: happy path -----------------------------------
test('buildChartContextEntry returns chart, queryLabel, ts', function() {
  const e = buildChartContextEntry({ chart: 'revenue-by-region', queryLabel: 'SELECT * FROM sales', ts: 1000 });
  strictEqual(e.chart, 'revenue-by-region');
  strictEqual(e.queryLabel, 'SELECT * FROM sales');
  strictEqual(e.ts, 1000);
});

test('buildChartContextEntry defaults queryLabel to null when missing', function() {
  const e = buildChartContextEntry({ chart: 'chart-1', ts: 1000 });
  strictEqual(e.queryLabel, null);
});

test('buildChartContextEntry defaults queryLabel to null for empty string', function() {
  const e = buildChartContextEntry({ chart: 'chart-1', queryLabel: '', ts: 1000 });
  strictEqual(e.queryLabel, null);
});

test('buildChartContextEntry defaults ts to a number when missing', function() {
  const e = buildChartContextEntry({ chart: 'chart-1' });
  strictEqual(typeof e.ts, 'number');
  ok(e.ts > 0);
});

test('buildChartContextEntry coerces numeric-string ts to a number', function() {
  const e = buildChartContextEntry({ chart: 'chart-1', ts: '2500' });
  strictEqual(e.ts, 2500);
});

// ---- buildChartContextEntry: validation -----------------------------------
test('buildChartContextEntry returns null for missing chart', function() {
  strictEqual(buildChartContextEntry({ queryLabel: 'x', ts: 1 }), null);
});

test('buildChartContextEntry returns null for empty chart string', function() {
  strictEqual(buildChartContextEntry({ chart: '', ts: 1 }), null);
});

test('buildChartContextEntry returns null for non-string chart', function() {
  strictEqual(buildChartContextEntry({ chart: 42 }), null);
  strictEqual(buildChartContextEntry({ chart: null }), null);
  strictEqual(buildChartContextEntry({ chart: {} }), null);
});

test('buildChartContextEntry with no args returns null (never throws)', function() {
  doesNotThrow(function() { buildChartContextEntry(); });
  strictEqual(buildChartContextEntry(), null);
});

// ---- createChartContextTimeline: recordChartView --------------------------
test('recordChartView adds an entry and returns true', function() {
  const t = createChartContextTimeline();
  strictEqual(t.recordChartView({ chart: 'chart-1', queryLabel: 'q1', ts: 100 }), true);
  strictEqual(t.getTimeline().length, 1);
});

test('recordChartView records multiple entries in order', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'a', ts: 100 });
  t.recordChartView({ chart: 'b', ts: 200 });
  t.recordChartView({ chart: 'c', ts: 300 });
  const tl = t.getTimeline();
  strictEqual(tl.length, 3);
  deepEqual(tl.map(function(e) { return e.chart; }), ['a', 'b', 'c']);
});

test('recordChartView returns false and records nothing for bad input', function() {
  const t = createChartContextTimeline();
  strictEqual(t.recordChartView({ chart: '' }), false);
  strictEqual(t.recordChartView({ queryLabel: 'x' }), false);
  strictEqual(t.recordChartView(null), false);
  strictEqual(t.recordChartView(), false);
  strictEqual(t.getTimeline().length, 0);
});

test('recordChartView never throws on bad input', function() {
  const t = createChartContextTimeline();
  doesNotThrow(function() {
    t.recordChartView(undefined);
    t.recordChartView({ chart: 123 });
    t.recordChartView('nope');
  });
});

test('recordChartView entry carries queryLabel and ts', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'sales', queryLabel: 'SELECT 1', ts: 555 });
  const e = t.getTimeline()[0];
  strictEqual(e.chart, 'sales');
  strictEqual(e.queryLabel, 'SELECT 1');
  strictEqual(e.ts, 555);
});

// ---- getTimeline: frozen / safe copy --------------------------------------
test('getTimeline returns a frozen array', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'a', ts: 1 });
  const tl = t.getTimeline();
  ok(Object.isFrozen(tl));
});

test('getTimeline entries are frozen', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'a', ts: 1 });
  ok(Object.isFrozen(t.getTimeline()[0]));
});

test('getTimeline: mutating the returned array does not change internal state', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'a', ts: 1 });
  const tl = t.getTimeline();
  try { tl.push({ chart: 'evil', ts: 999 }); } catch (e) { /* frozen array throws in strict mode; ignore */ }
  strictEqual(t.getTimeline().length, 1);
});

test('getTimeline: mutating a returned entry does not change internal state', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'a', ts: 1 });
  const e = t.getTimeline()[0];
  try { e.chart = 'tampered'; } catch (err) { /* frozen; ignore */ }
  strictEqual(t.getTimeline()[0].chart, 'a');
});

test('getTimeline returns a NEW array each call (not the same reference)', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'a', ts: 1 });
  ok(t.getTimeline() !== t.getTimeline());
});

test('getTimeline on an empty timeline returns an empty frozen array', function() {
  const t = createChartContextTimeline();
  const tl = t.getTimeline();
  strictEqual(tl.length, 0);
  ok(Object.isFrozen(tl));
});

// ---- clear ----------------------------------------------------------------
test('clear resets the timeline', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'a', ts: 1 });
  t.recordChartView({ chart: 'b', ts: 2 });
  strictEqual(t.getTimeline().length, 2);
  t.clear();
  strictEqual(t.getTimeline().length, 0);
});

test('clear then record works normally', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'a', ts: 1 });
  t.clear();
  t.recordChartView({ chart: 'b', ts: 2 });
  const tl = t.getTimeline();
  strictEqual(tl.length, 1);
  strictEqual(tl[0].chart, 'b');
});

test('clear never throws on an empty timeline', function() {
  const t = createChartContextTimeline();
  doesNotThrow(function() { t.clear(); });
});

// ---- integration with tagSegmentsWithContext ------------------------------
test('integration: tagSegmentsWithContext tags segments from a real timeline', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'revenue-by-region', queryLabel: 'SELECT region, SUM(rev)', ts: 100 });
  t.recordChartView({ chart: 'churn-cohort', queryLabel: 'SELECT cohort, churn', ts: 300 });

  const segments = [
    { text: 'Before any chart was opened', ts: 50 },
    { text: 'Looking at revenue here', ts: 150 },
    { text: 'Now the churn cohort', ts: 350 },
  ];

  const tagged = tagSegmentsWithContext(segments, t.getTimeline());
  strictEqual(tagged.length, 3);
  strictEqual(tagged[0].context, null, 'segment before first context event is null');
  strictEqual(tagged[1].context.chart, 'revenue-by-region');
  strictEqual(tagged[1].context.queryLabel, 'SELECT region, SUM(rev)');
  strictEqual(tagged[2].context.chart, 'churn-cohort');
  strictEqual(tagged[2].context.queryLabel, 'SELECT cohort, churn');
});

test('integration: empty timeline yields all-null context (matches old behavior)', function() {
  const t = createChartContextTimeline();
  const segments = [{ text: 'no context yet', ts: 100 }];
  const tagged = tagSegmentsWithContext(segments, t.getTimeline());
  strictEqual(tagged[0].context, null);
});

test('integration: queryLabel null flows through to the tagged context', function() {
  const t = createChartContextTimeline();
  t.recordChartView({ chart: 'ad-hoc-view', ts: 100 });
  const tagged = tagSegmentsWithContext([{ text: 'x', ts: 200 }], t.getTimeline());
  strictEqual(tagged[0].context.chart, 'ad-hoc-view');
  strictEqual(tagged[0].context.queryLabel, null);
});

// ---- summary --------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
