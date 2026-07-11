// ============================================================
// DATAGLOW — Meeting Decision Ledger test suite (Gen 43, Part 3)
// ============================================================
// Proves the ledger is a safe, append-only, chart-anchored record:
//   - buildLedgerEntry produces a plain JSON-safe object, never mutates its
//     inputs, and only ever carries a context that was actually supplied,
//   - buildLedgerEntriesFromMeeting turns Part 1's tagged segments + action
//     items into exactly the "noteworthy" entries (pushback, data request,
//     action item), never every line, unless includeAllLines is requested,
//   - saveLedgerEntries/loadLedgerEntries talk ONLY to an injected store
//     adapter (mirrors js/learning/memory-store.js's contract) so this suite
//     never touches a real IndexedDB — a tiny in-memory fake stands in,
//   - filterLedgerEntries and chartsReferencedIn are pure, correct, and
//     never invent a chart an entry doesn't actually have,
//   - exportLedgerEntries only formats a string — it never calls a network
//     primitive and this file proves no such import exists in the module.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/meeting-decision-ledger.test.mjs

import { readFileSync } from 'fs';
import {
  buildLedgerEntry, buildLedgerEntriesFromMeeting,
  saveLedgerEntries, loadLedgerEntries,
  filterLedgerEntries, chartsReferencedIn, exportLedgerEntries,
} from '../js/agents/meeting-decision-ledger.js';
import { tagSegmentsWithContext, buildActionItem, resolveActionItem } from '../js/agents/meeting-scribe-agent.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

// In-memory stand-in for js/learning/memory-store.js's
// appendLedgerEntries/getLedgerEntries/clearLedgerEntries contract.
function makeFakeStore() {
  let entries = [];
  return {
    entries,
    async appendLedgerEntries(list) { entries = entries.concat(list); return list.length; },
    async getLedgerEntries() { return entries.slice(); },
    async clearLedgerEntries() { entries = []; },
  };
}

async function main() {
  // ---------- 1. buildLedgerEntry ----------
  const e1 = buildLedgerEntry({
    kind: 'pushback', meetingId: 'mtg-1', text: 'Why did revenue drop?', ts: 120,
    context: { chart: 'revenue-trend', queryLabel: 'monthly_revenue' }, matched: 'why did',
  });
  ok(e1.kind === 'pushback', 'buildLedgerEntry: kind carried through');
  ok(e1.context.chart === 'revenue-trend', 'buildLedgerEntry: supplied context is kept');
  ok(e1.matched === 'why did', 'buildLedgerEntry: matched phrase kept');
  ok(typeof e1.recordedAt === 'number' && e1.recordedAt > 0, 'buildLedgerEntry: recordedAt is stamped');
  ok(e1.sourceKey.includes('mtg-1') && e1.sourceKey.includes('pushback'), 'buildLedgerEntry: sourceKey encodes meeting + kind');
  ok(JSON.stringify(e1).length > 0, 'buildLedgerEntry: output is JSON-safe');

  const e2 = buildLedgerEntry({ kind: 'note', meetingId: 'mtg-1', text: 'ok', ts: 5 });
  ok(e2.context === null, 'buildLedgerEntry: no context supplied \u2192 null, never invented');
  ok(e2.status === null, 'buildLedgerEntry: non-actionItem kinds carry no status');

  const e3 = buildLedgerEntry({
    kind: 'actionItem', meetingId: 'mtg-1', text: 'Follow up with finance', ts: 900, status: 'resolved',
    actionFields: { owner: 'Priya', dueDate: '2026-07-18', outcome: 'Traced to a bug' },
  });
  ok(e3.status === 'resolved', 'buildLedgerEntry: actionItem status carried through');
  ok(e3.actionFields.owner === 'Priya', 'buildLedgerEntry: actionFields carried through');

  const eBad = buildLedgerEntry({ kind: 'not-a-real-kind', meetingId: 'm', text: 't', ts: 1 });
  ok(eBad.kind === 'note', 'buildLedgerEntry: unknown kind degrades to \'note\', never throws');
  const eEmpty = buildLedgerEntry({});
  ok(eEmpty.text === '' && eEmpty.ts === 0 && eEmpty.context === null, 'buildLedgerEntry: empty input degrades safely, no throw');

  // ---------- 2. buildLedgerEntriesFromMeeting ----------
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
  const rawItem = buildActionItem({ text: 'Follow up with finance', ts: 900 });
  const resolvedItem = resolveActionItem(rawItem, { owner: 'Priya', dueDate: '2026-07-18', outcome: 'Traced to a bug' });

  const entries = buildLedgerEntriesFromMeeting({ meetingId: 'mtg-1', taggedSegments: tagged, actionItems: [resolvedItem] });
  ok(entries.length === 3, 'buildLedgerEntriesFromMeeting: only pushback + dataRequest + actionItem entries are kept, not every line');
  ok(entries.filter((e) => e.kind === 'pushback').length === 1, 'buildLedgerEntriesFromMeeting: exactly one pushback entry');
  ok(entries.filter((e) => e.kind === 'dataRequest').length === 1, 'buildLedgerEntriesFromMeeting: exactly one data-request entry');
  ok(entries.filter((e) => e.kind === 'actionItem').length === 1, 'buildLedgerEntriesFromMeeting: exactly one action-item entry');
  ok(entries.every((a, i) => i === 0 || a.ts >= entries[i - 1].ts), 'buildLedgerEntriesFromMeeting: entries are ordered oldest-ts-first');

  const withAllLines = buildLedgerEntriesFromMeeting({
    meetingId: 'mtg-1', taggedSegments: tagged, actionItems: [resolvedItem], includeAllLines: true,
  });
  ok(withAllLines.length === 5, 'buildLedgerEntriesFromMeeting: includeAllLines adds the remaining plain lines too');

  const emptyEntries = buildLedgerEntriesFromMeeting({});
  ok(Array.isArray(emptyEntries) && emptyEntries.length === 0, 'buildLedgerEntriesFromMeeting: empty input degrades to an empty array, no throw');

  // ---------- 3. Persistence via injected store (fake, no real IndexedDB) ----------
  const store = makeFakeStore();
  const written = await saveLedgerEntries(store, entries);
  ok(written === 3, 'saveLedgerEntries: reports the number of entries written');
  const loaded = await loadLedgerEntries(store);
  ok(loaded.length === 3, 'loadLedgerEntries: reads back everything written via the injected store');
  ok(loaded.every((e, i) => i === 0 || e.ts >= loaded[i - 1].ts), 'loadLedgerEntries: results are ordered oldest-ts-first');

  const wroteNothing = await saveLedgerEntries(store, []);
  ok(wroteNothing === 0, 'saveLedgerEntries: an empty batch is a no-op, never calls the store');

  let threw = false;
  try { await saveLedgerEntries({}, [{ text: 'x' }]); } catch { threw = true; }
  ok(threw, 'saveLedgerEntries: throws a clear error if the store lacks appendLedgerEntries');

  // ---------- 4. Filtering / summarizing (pure) ----------
  const byChart = filterLedgerEntries(loaded, { chart: 'revenue-trend' });
  ok(byChart.length === 2 && byChart.some((e) => e.kind === 'pushback') && byChart.some((e) => e.kind === 'dataRequest'), 'filterLedgerEntries: filters correctly by chart');
  const byKind = filterLedgerEntries(loaded, { kind: 'actionItem' });
  ok(byKind.length === 1, 'filterLedgerEntries: filters correctly by kind');
  const noFilter = filterLedgerEntries(loaded, {});
  ok(noFilter.length === loaded.length, 'filterLedgerEntries: no filters returns everything');

  const charts = chartsReferencedIn(loaded);
  ok(charts.includes('revenue-trend') && charts.length === 1, 'chartsReferencedIn: lists every distinct chart actually referenced (refund-rate only appears on the unflagged final line, which the ledger correctly excludes)');
  ok(chartsReferencedIn([]).length === 0, 'chartsReferencedIn: empty input degrades to an empty array, no throw');

  // ---------- 4b. recheckResolution: optional, sanitized, opt-in ----------
  // A pushback entry can optionally carry a small PLAIN summary of an on-device
  // re-check (see js/agents/meeting-scribe-ui.js onRecheck). It must be
  // sanitized field-by-field and only present when genuinely supplied.
  const eRecheck = buildLedgerEntry({
    kind: 'pushback', meetingId: 'mtg-1', text: 'Are you sure?', ts: 50, matched: 'are you sure',
    recheckResolution: {
      resolvedBy: 'C', suggestion: 'The March figure looks right', reasoning: 'Two personas agreed', confidence: 0.82,
    },
  });
  ok(eRecheck.recheckResolution && eRecheck.recheckResolution.suggestion === 'The March figure looks right',
    'buildLedgerEntry: recheckResolution suggestion carried through when present');
  ok(eRecheck.recheckResolution.resolvedBy === 'C' && eRecheck.recheckResolution.reasoning === 'Two personas agreed',
    'buildLedgerEntry: recheckResolution resolvedBy + reasoning carried through');
  ok(eRecheck.recheckResolution.confidence === 0.82, 'buildLedgerEntry: recheckResolution confidence carried through');
  ok(Object.keys(eRecheck.recheckResolution).length === 4,
    'buildLedgerEntry: recheckResolution carries ONLY the four known fields');

  const eClamp = buildLedgerEntry({
    kind: 'pushback', meetingId: 'm', text: 't', ts: 1,
    recheckResolution: { suggestion: 's', confidence: 4.5 },
  });
  ok(eClamp.recheckResolution.confidence === 1, 'buildLedgerEntry: recheckResolution confidence clamped to <= 1');
  const eClampLow = buildLedgerEntry({
    kind: 'pushback', meetingId: 'm', text: 't', ts: 1,
    recheckResolution: { suggestion: 's', confidence: -3 },
  });
  ok(eClampLow.recheckResolution.confidence === 0, 'buildLedgerEntry: recheckResolution confidence clamped to >= 0');

  const eGarbage = buildLedgerEntry({
    kind: 'pushback', meetingId: 'm', text: 't', ts: 1,
    recheckResolution: { suggestion: 's', confidence: 'not-a-number', evil: { nested: 'object' }, applyFix: true },
  });
  ok(eGarbage.recheckResolution.confidence === null, 'buildLedgerEntry: non-finite recheck confidence becomes null, never NaN');
  ok(!('evil' in eGarbage.recheckResolution) && !('applyFix' in eGarbage.recheckResolution),
    'buildLedgerEntry: arbitrary extra recheck fields are discarded, never stored verbatim');

  const eNotObject = buildLedgerEntry({
    kind: 'pushback', meetingId: 'm', text: 't', ts: 1, recheckResolution: 'just a string',
  });
  ok(!('recheckResolution' in eNotObject), 'buildLedgerEntry: a non-object recheckResolution is dropped (no key)');
  const eNoRecheck = buildLedgerEntry({ kind: 'pushback', meetingId: 'm', text: 't', ts: 1 });
  ok(!('recheckResolution' in eNoRecheck), 'buildLedgerEntry: absent recheckResolution → no key at all (byte-identical to before)');

  // End-to-end: a tagged pushback segment carrying .recheckResolution flows
  // through buildLedgerEntriesFromMeeting into an entry with a sanitized copy,
  // while an un-rechecked pushback stays key-free (regression safety).
  const e2eSegments = tagSegmentsWithContext([
    { text: 'Why did this drop in March?', ts: 500 },
    { text: 'Are you sure about that Q2 number?', ts: 800 },
  ], []);
  const pushbacks = e2eSegments.filter((s) => s.pushback && s.pushback.isPushback);
  ok(pushbacks.length >= 2, 'e2e setup: both challenge lines tagged as pushback');
  // Attach a re-check to the FIRST pushback only (with a junk extra field to
  // prove the sanitizer runs on the through-path, not just direct calls).
  pushbacks[0].recheckResolution = {
    resolvedBy: 'C', suggestion: 'March figure is correct', reasoning: 'debate agreed', confidence: 0.9, applyFix: 'SHOULD_BE_DROPPED',
  };
  const e2eEntries = buildLedgerEntriesFromMeeting({ meetingId: 'mtg-e2e', taggedSegments: e2eSegments });
  const rechecked = e2eEntries.find((e) => e.kind === 'pushback' && e.recheckResolution);
  const notRechecked = e2eEntries.find((e) => e.kind === 'pushback' && !e.recheckResolution);
  ok(rechecked && rechecked.recheckResolution.suggestion === 'March figure is correct',
    'buildLedgerEntriesFromMeeting: a segment\'s recheckResolution flows end-to-end into its entry');
  ok(rechecked && !('applyFix' in rechecked.recheckResolution),
    'buildLedgerEntriesFromMeeting: the through-path sanitizes too — junk fields never reach the entry');
  ok(notRechecked && !('recheckResolution' in notRechecked),
    'buildLedgerEntriesFromMeeting: an un-rechecked pushback entry carries no recheckResolution key (regression safety)');

  // ---------- 5. Export (formatting only, no network) ----------
  const exported = exportLedgerEntries(loaded);
  const parsed = JSON.parse(exported);
  ok(parsed.entryCount === loaded.length, 'exportLedgerEntries: entryCount matches the entries provided');
  ok(Array.isArray(parsed.entries) && parsed.entries.length === loaded.length, 'exportLedgerEntries: entries array round-trips through JSON');

  const srcRaw = readFileSync(new URL('../js/agents/meeting-decision-ledger.js', import.meta.url), 'utf8');
  // Strip line comments before scanning so the file's own explanatory prose
  // (which names fetch/XMLHttpRequest to say they are ABSENT) can't trigger
  // a false positive — only actual code usage should fail this check.
  const srcCode = srcRaw.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const hasNetworkPrimitive = /\bfetch\s*\(|\bXMLHttpRequest\s*\(|\bWebSocket\s*\(|navigator\.sendBeacon\s*\(/.test(srcCode);
  ok(hasNetworkPrimitive === false, 'meeting-decision-ledger.js: names no network primitive call anywhere in actual code (comments excluded)');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
