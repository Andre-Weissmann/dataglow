// ============================================================
// DATAGLOW — Metric Contract Diff View test suite (Batch 2: read-only diff view)
// ============================================================
// Proves the pure content-model builders behave as specified:
//   - buildDiffViewContent() reports the same fields diffVersions() would,
//     plus honest metadata (who/when/why/source) taken only from the `after`
//     version entry, never invented
//   - a no-op diff (identical snapshots) says so plainly, no fake "changed" block
//   - "AI-agent proposed" vs "Human edit" source labelling is correct and
//     defaults sanely when a bare snapshot (no `source` field) is passed
//   - buildHistoryListContent() renders every version in order with the same
//     honest metadata, and handles zero-history gracefully
//
// This batch's renderDiffView() DOM presenter has no caller anywhere in the
// app yet (same principle as Batch 1) so, matching this repo's convention for
// ships-dark UI with no wiring yet (see test/metric-studio.test.mjs /
// test/trust-strip-proof-drawer.test.mjs), only the pure content builders are
// unit-tested here; the DOM presenter gets exercised once a later batch wires
// it into a real page for the e2e suite to reach.
//
// RUN WITH: node test/metric-contract-diff-view.test.mjs (pure logic only)

import { MetricContractHistory } from '../js/metrics/metric-contracts.js';
import { buildDiffViewContent, buildHistoryListContent } from '../js/metrics/metric-contract-diff-view.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  const metric = {
    id: 'readmission-rate', name: 'Readmission Rate', plainEnglish: 'readmissions / discharges',
    expression: 'SUM(readmissions) / NULLIF(SUM(discharges), 0)', owner: 'andre', tag: 'quality',
  };

  const hist = new MetricContractHistory('readmission-rate');
  const v1 = hist.recordVersion(metric, { changedBy: 'andre', reason: 'initial definition', source: 'human' });
  const v2 = hist.recordVersion(
    { ...metric, expression: 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)', owner: 'priya' },
    { changedBy: 'priya', reason: 'fixed column name + reassigned owner', source: 'human' },
  );
  const v3 = hist.recordVersion(
    { ...metric, expression: 'SUM(readmissions) / NULLIF(SUM(total_discharges), 0)', owner: 'priya' },
    { changedBy: 'metric-copilot', reason: 'proposed dedup of near-identical metric', source: 'agent-proposed' },
  );

  // ---------- 1. Pairwise diff: fields reported ----------
  const d12 = buildDiffViewContent({ metricName: metric.name, before: hist.get(1), after: hist.get(2) });
  ok(d12.title === 'Readmission Rate', 'diff: title is the metric name');
  ok(d12.subtitle === 'expression, owner changed', 'diff: subtitle summarizes exactly the changed fields');
  const fieldDiffBlock = d12.blocks.find(b => b.kind === 'field-diff');
  ok(fieldDiffBlock && fieldDiffBlock.fields.length === 2, 'diff: field-diff block lists exactly the 2 changed fields');
  ok(fieldDiffBlock.fields.some(f => f.field === 'expression' && f.after.includes('total_discharges')),
    'diff: expression field shows the real after-value');

  // ---------- 2. Honest metadata, only from `after` ----------
  const metaKv = d12.blocks.filter(b => b.kind === 'kv').map(b => `${b.label}:${b.value}`);
  ok(metaKv.some(s => s.startsWith('Changed by:priya')), 'diff: "Changed by" reflects the after-version author, not before');
  ok(metaKv.some(s => s === 'Source:Human edit'), 'diff: human source is labelled "Human edit"');
  const reasonBlock = d12.blocks.find(b => b.kind === 'text' && b.label === 'Reason given');
  ok(reasonBlock && reasonBlock.text === 'fixed column name + reassigned owner', 'diff: reason is the real recorded reason, not invented');

  // ---------- 3. AI-agent-proposed labelling (Batch 3 will build on this) ----------
  const d23 = buildDiffViewContent({ metricName: metric.name, before: hist.get(2), after: hist.get(3) });
  const metaKv23 = d23.blocks.filter(b => b.kind === 'kv').map(b => `${b.label}:${b.value}`);
  ok(metaKv23.some(s => s === 'Source:AI-agent proposed'), 'diff: agent-proposed source is clearly labelled, distinct from a human edit');
  ok(d23.subtitle === 'no changes', 'diff: v2→v3 correctly reports no field changes (only metadata differs)');
  ok(!d23.blocks.some(b => b.kind === 'field-diff'), 'diff: no fake field-diff block rendered when nothing actually changed');
  const resultBlock = d23.blocks.find(b => b.kind === 'text' && b.label === 'Result');
  ok(resultBlock && resultBlock.text === 'No changes between these two versions.', 'diff: no-op case states plainly there were no changes');

  // ---------- 4. Comparing label uses real version numbers ----------
  const comparing = d12.blocks.find(b => b.label === 'Comparing');
  ok(comparing && comparing.text === 'version 1 → version 2', 'diff: "Comparing" label cites the real version numbers');

  // ---------- 5. Defensive: bare snapshot with no `source`/metadata ----------
  const dBare = buildDiffViewContent({ metricName: 'Bare', before: { name: 'A' }, after: { name: 'B' } });
  ok(dBare.subtitle === 'name changed', 'diff: works with bare snapshots (no version/changedBy/source wrapper) without crashing');
  ok(!dBare.blocks.some(b => b.kind === 'kv'), 'diff: no metadata kv blocks invented when the wrapper metadata is absent');

  // ---------- 6. History list ----------
  const histContent = buildHistoryListContent({ metricName: metric.name, versions: hist.list() });
  ok(histContent.subtitle === '3 versions recorded', 'history: subtitle counts all recorded versions');
  const listBlock = histContent.blocks.find(b => b.kind === 'list');
  ok(listBlock && listBlock.items.length === 3, 'history: one line per version');
  ok(listBlock.items[0].startsWith('v1 —') && listBlock.items[0].includes('andre'), 'history: oldest version listed first, with its real author');
  ok(listBlock.items[2].includes('AI-agent proposed'), 'history: the agent-proposed version is flagged as such in the timeline');

  // ---------- 7. Empty history is handled honestly ----------
  const emptyContent = buildHistoryListContent({ metricName: 'New Metric', versions: [] });
  ok(emptyContent.subtitle === '0 versions recorded', 'history: empty case reports 0, not an error');
  const emptyBlock = emptyContent.blocks.find(b => b.kind === 'text');
  ok(emptyBlock && emptyBlock.text === 'No versions recorded yet for this metric.', 'history: empty case gives an honest message, not a blank list');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
