// ============================================================
// DATAGLOW — DataGlow Passport, Batch D — Ownership Ledger test
// ============================================================
// Ownership Ledger (js/provenance/ownership-ledger.js) answers a DIFFERENT
// question from the Chain of Custody: custody tracks WHAT transformations
// happened; the Ownership Ledger INFERS WHO is/was responsible, by reading the
// SAME audit trails that already exist (the provenance chain + the assumption
// ledger) rather than a manual stewardship spreadsheet.
//
// These tests pin the honesty discipline: it NEVER fabricates an identity that
// is not actually present in the trail (identity is optional today — the Agent
// Action Firewall's identity rider is not merged to main — so most real events
// degrade to "unattributed"); the summary says "unknown" honestly when nothing
// is attributed; and the ONLY write path (an explicit ownership claim) is
// opt-in, requires a real local identity, and is strictly append-only.
//
// RUN WITH:  node test/ownership-ledger.test.mjs
//
// Pure JS — no DuckDB, no DOM, no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanSourceForNetwork } from '../js/packs/pack-network-guard.js';
import {
  deriveOwnershipEvents,
  summarizeCurrentOwnership,
  claimOwnership,
  buildOwnershipTimelineContent,
} from '../js/provenance/ownership-ledger.js';

// ---------- tiny test harness (mirrors the other test files) ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  ok(threw, msg);
}

// A realistic provenance trail (as chain.getTrail() would return): the first
// step is the file load, later steps are confirmed mutations. On current main
// NONE of these carry an identity — that is the common case we must handle.
function trailNoIdentity() {
  return [
    { index: 0, op: 'load', description: 'Loaded patients.csv (5000 rows)', ts: 1000, hash: 'a'.repeat(64), parentHash: '0'.repeat(64) },
    { index: 1, op: 'clean', description: 'Trimmed whitespace in "name"', ts: 2000, hash: 'b'.repeat(64), parentHash: 'a'.repeat(64) },
    { index: 2, op: 'merge', description: 'Merged lab_results.csv', ts: 3000, hash: 'c'.repeat(64), parentHash: 'b'.repeat(64) },
  ];
}

// The same shape but WITH an optional identity rider attached (as a future
// Agent Action Firewall would attach). Identity may live directly on the step
// or inside detail — we read either, but never invent one.
function trailWithIdentity() {
  return [
    { index: 0, op: 'load', description: 'Loaded patients.csv', ts: 1000, identity: 'alice', hash: 'a'.repeat(64), parentHash: '0'.repeat(64) },
    { index: 1, op: 'clean', description: 'Dropped duplicate rows', ts: 2000, detail: { authorizedBy: 'bob' }, hash: 'b'.repeat(64), parentHash: 'a'.repeat(64) },
    { index: 2, op: 'clean', description: 'Imputed missing ages', ts: 2500, hash: 'c'.repeat(64), parentHash: 'b'.repeat(64) }, // unattributed
  ];
}

// ---------------------------------------------------------------
// deriveOwnershipEvents
// ---------------------------------------------------------------
(() => {
  const empty = deriveOwnershipEvents({ provenanceTrail: [], assumptionEntries: [] });
  ok(Array.isArray(empty) && empty.length === 0, 'deriveOwnershipEvents: empty trail → empty event list');

  const events = deriveOwnershipEvents({ provenanceTrail: trailNoIdentity(), assumptionEntries: [] });
  ok(events.length === 3, 'deriveOwnershipEvents: one event per provenance step');
  ok(events[0].type === 'load', 'deriveOwnershipEvents: first load step classified as "load"');
  ok(events.every(e => e.identity === null), 'deriveOwnershipEvents: no identity in trail → every event unattributed (never fabricated)');
  ok(events.every(e => e.kind === 'inferred'), 'deriveOwnershipEvents: derived events are marked "inferred"');
  ok(events[0].ts <= events[1].ts && events[1].ts <= events[2].ts, 'deriveOwnershipEvents: events ordered oldest-first');

  const attributed = deriveOwnershipEvents({ provenanceTrail: trailWithIdentity(), assumptionEntries: [] });
  ok(attributed[0].identity === 'alice', 'deriveOwnershipEvents: reads identity directly off a step');
  ok(attributed[1].identity === 'bob', 'deriveOwnershipEvents: reads identity from detail.authorizedBy');
  ok(attributed[2].identity === null, 'deriveOwnershipEvents: step without identity stays unattributed even when siblings have one');

  // Assumption-ledger entries fold in as validation-type events, ordered by ts
  // against the provenance events.
  const mixed = deriveOwnershipEvents({
    provenanceTrail: [{ index: 0, op: 'load', description: 'Loaded x', ts: 1000 }],
    assumptionEntries: [
      { ts: 1500, source: 'Categorical Consistency Engine', action: 'Auto-merged "M"/"Male"', detail: { identity: 'carol' } },
      { ts: 500, source: 'Missingness Detective', action: 'Flagged 3% missing' },
    ],
  });
  ok(mixed.length === 3, 'deriveOwnershipEvents: folds assumption entries in alongside provenance steps');
  ok(mixed[0].ts === 500 && mixed[2].ts === 1500, 'deriveOwnershipEvents: merged stream sorted by ts across both sources');
  const carol = mixed.find(e => e.identity === 'carol');
  ok(carol && carol.type === 'validation' && carol.source === 'assumption-ledger', 'deriveOwnershipEvents: attributed assumption entry becomes a validation event with its identity');

  // Robustness: garbage in, no throw, no fabricated identities.
  const junk = deriveOwnershipEvents({ provenanceTrail: null, assumptionEntries: null });
  ok(Array.isArray(junk) && junk.length === 0, 'deriveOwnershipEvents: null inputs degrade to empty list, no throw');
})();

// ---------------------------------------------------------------
// summarizeCurrentOwnership
// ---------------------------------------------------------------
(() => {
  const none = summarizeCurrentOwnership(deriveOwnershipEvents({ provenanceTrail: trailNoIdentity(), assumptionEntries: [] }));
  ok(none.confidence === 'none', 'summarizeCurrentOwnership: no attributed actions → confidence "none"');
  ok(/unknown/i.test(none.label), 'summarizeCurrentOwnership: unattributed trail → honestly reports ownership unknown');
  ok(none.attributedCount === 0, 'summarizeCurrentOwnership: attributedCount 0 when nothing is attributed');

  const single = summarizeCurrentOwnership([
    { kind: 'inferred', type: 'load', identity: 'alice', ts: 1000 },
    { kind: 'inferred', type: 'mutation', identity: null, ts: 2000 },
  ]);
  ok(single.owner === 'alice', 'summarizeCurrentOwnership: single attributed identity is surfaced as likely owner');
  ok(single.confidence === 'low', 'summarizeCurrentOwnership: a single attributed action yields LOW confidence');
  ok(/inferred/i.test(single.basis), 'summarizeCurrentOwnership: basis carries an honest "inferred" caveat');

  // Recency-weighting: "bob" has FEWER actions than "alice" but they are the
  // most recent, so weight (rank in ts-order) makes bob the likely current owner.
  const recency = summarizeCurrentOwnership([
    { kind: 'inferred', identity: 'alice', ts: 100 },
    { kind: 'inferred', identity: 'alice', ts: 200 },
    { kind: 'inferred', identity: 'alice', ts: 300 },
    { kind: 'inferred', identity: 'bob', ts: 400 },
    { kind: 'inferred', identity: 'bob', ts: 500 },
  ]);
  ok(recency.owner === 'bob', 'summarizeCurrentOwnership: recency-weighted — most recent identity wins despite fewer actions');
  ok(recency.attributedCount === 5, 'summarizeCurrentOwnership: counts only attributed actions');
})();

// ---------------------------------------------------------------
// claimOwnership (the ONLY write path — opt-in, append-only)
// ---------------------------------------------------------------
(() => {
  throws(() => claimOwnership({ datasetId: 'patients', identity: '' }), 'claimOwnership: rejects empty identity');
  throws(() => claimOwnership({ datasetId: 'patients', identity: '   ' }), 'claimOwnership: rejects whitespace-only identity');
  throws(() => claimOwnership({ datasetId: 'patients' }), 'claimOwnership: rejects missing identity');
  throws(() => claimOwnership({ datasetId: '', identity: 'alice' }), 'claimOwnership: rejects missing datasetId');

  const prior = Object.freeze([]);
  const after1 = claimOwnership({ datasetId: 'patients', identity: '  alice  ', note: 'took over Q3' }, prior);
  ok(after1.length === 1, 'claimOwnership: appends a claim');
  ok(after1[0].identity === 'alice', 'claimOwnership: trims/normalizes identity');
  ok(after1[0].kind === 'claim', 'claimOwnership: record is marked as an explicit claim (not inferred)');
  ok(after1[0].note === 'took over Q3', 'claimOwnership: preserves the optional note');
  ok(prior.length === 0, 'claimOwnership: never mutates the prior claims array (append-only, additive)');

  const after2 = claimOwnership({ datasetId: 'patients', identity: 'bob' }, after1);
  ok(after2.length === 2 && after2[0].identity === 'alice' && after2[1].identity === 'bob', 'claimOwnership: additive — a new claim never overwrites a prior one');
  ok(after1.length === 1, 'claimOwnership: the second claim did not mutate the first result either');
})();

// ---------------------------------------------------------------
// buildOwnershipTimelineContent (pure content model, oldest-first)
// ---------------------------------------------------------------
(() => {
  const events = deriveOwnershipEvents({ provenanceTrail: trailWithIdentity(), assumptionEntries: [] });
  const claims = claimOwnership({ datasetId: 'patients', identity: 'dave', note: 'current steward' }, []);
  const content = buildOwnershipTimelineContent(events, claims);
  ok(Array.isArray(content.rows), 'buildOwnershipTimelineContent: returns a rows array (content model, no DOM)');
  ok(content.rows.length === events.length + claims.length, 'buildOwnershipTimelineContent: includes every inferred event and every explicit claim');
  const kinds = new Set(content.rows.map(r => r.kind));
  ok(kinds.has('inferred') && kinds.has('claim'), 'buildOwnershipTimelineContent: distinguishes inferred events from explicit claims');
  for (let i = 1; i < content.rows.length; i++) {
    ok(content.rows[i - 1].ts <= content.rows[i].ts, `buildOwnershipTimelineContent: row ${i} is not older than row ${i - 1} (oldest-first)`);
  }
  ok(typeof content.summary === 'object' && 'confidence' in content.summary, 'buildOwnershipTimelineContent: bundles the current-ownership summary');
})();

// ---------------------------------------------------------------
// No-network source guard (mirrors pack-architecture.test.mjs)
// ---------------------------------------------------------------
(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'js', 'provenance', 'ownership-ledger.js'), 'utf8');
  const violations = scanSourceForNetwork(src);
  ok(violations.length === 0, `ownership-ledger.js references no network primitive (found: ${violations.map(v => v.primitive).join(', ') || 'none'})`);
  ok(!/<script\s+src=/i.test(src), 'ownership-ledger.js embeds no external <script src=>');
  ok(!/https?:\/\//i.test(src.replace(/\/\/[^\n]*/g, '')), 'ownership-ledger.js contains no outbound http(s) URL in code');
})();

// ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
