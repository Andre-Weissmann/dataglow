// ============================================================
// DATAGLOW — Query Memory UI test suite (Batch 2: badge view-model)
// ============================================================
// Proves buildQueryMemoryBadgeModel() is a pure, DOM-free, honest presenter
// over a record()/lookup() result:
//   - a "not seen" result yields the honest "New query" label, never a
//     fabricated count,
//   - a "seen" result reports the real count/authors/last-seen text,
//   - singular vs. plural phrasing ("once" vs "N×", "by X" vs "by N people"),
//   - never throws on missing/malformed input.
//
// Pure JS — no DOM, no DuckDB, no network. RUN WITH:
//   node test/query-memory-ui.test.mjs

import { buildQueryMemoryBadgeModel } from '../js/provenance/query-memory-ui.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// --- Not seen ---
{
  const model = buildQueryMemoryBadgeModel({ seen: false, count: 0, authors: [], lastSeenAt: null });
  ok(model.seen === false, 'not-seen result reports seen:false');
  ok(model.label === 'New query', 'not-seen label is honest "New query"');
  ok(model.detail === 'New query — not seen before on this device.', 'not-seen detail matches pure module wording');
}

// --- Missing/malformed input never throws ---
{
  const a = buildQueryMemoryBadgeModel(undefined);
  ok(a.seen === false, 'undefined input treated as not-seen');
  const b = buildQueryMemoryBadgeModel(null);
  ok(b.seen === false, 'null input treated as not-seen');
  const c = buildQueryMemoryBadgeModel('garbage');
  ok(c.seen === false, 'non-object input treated as not-seen');
}

// --- Seen once, by one author ---
{
  const model = buildQueryMemoryBadgeModel({ seen: true, count: 1, authors: ['you'], lastSeenAt: 1752000000000 });
  ok(model.seen === true, 'seen-once result reports seen:true');
  ok(model.label === 'Seen before · once', 'singular "once" phrasing used for count 1');
  ok(model.detail.includes('by you'), 'single author phrased as "by <name>"');
  ok(model.detail.includes('exact match'), 'detail is honest about exact-match floor');
}

// --- Seen multiple times, by multiple authors ---
{
  const model = buildQueryMemoryBadgeModel({ seen: true, count: 4, authors: ['you', 'analyst2'], lastSeenAt: 1752000000000 });
  ok(model.label === 'Seen before · 4×', 'plural "4×" phrasing used for count > 1');
  ok(model.detail.includes('by 2 people'), 'multiple authors phrased as "by N people"');
}

// --- No lastSeenAt still renders without a "most recently" clause ---
{
  const model = buildQueryMemoryBadgeModel({ seen: true, count: 2, authors: ['you'], lastSeenAt: null });
  ok(!model.detail.includes('most recently'), 'missing lastSeenAt omits the "most recently" clause');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
