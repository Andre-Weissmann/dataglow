// ============================================================
// DATAGLOW — Query Memory test suite (Batch 1: fingerprint + log)
// ============================================================
// Proves the pure Query Memory module is an honest, exact-match, append-only
// fingerprint log:
//   - normalizeQueryText collapses incidental whitespace/newlines + a trailing
//     semicolon, but does NOT lowercase or parse (the documented Batch-1 floor),
//   - computeQueryFingerprint is stable and reproducible: identical + whitespace-
//     only-different runs collide; a changed value, a different table, different
//     columns, or a case difference do NOT (exact match, grounded in context),
//   - buildQueryMemoryEntry produces a plain, JSON-safe entry and never persists
//     raw query text (fingerprint + kind + author + ts + optional label only),
//   - summarizeEntries / summarizeQueryMemory report seen/count/authors/last-seen
//     honestly and never throw on junk,
//   - createQueryMemoryLog talks ONLY to an injected store adapter (mirrors
//     js/learning/memory-store.js's appendQueryMemory/getQueryMemory/
//     getQueryMemoryByFingerprint contract) so this suite never touches a real
//     IndexedDB — a tiny in-memory fake stands in — and record() captures the
//     PRIOR history so a "seen before" badge reflects state before the run.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/query-memory.test.mjs

import {
  QUERY_KINDS,
  normalizeQueryText,
  buildQuerySignaturePayload,
  computeQueryFingerprint,
  buildQueryMemoryEntry,
  summarizeEntries,
  summarizeQueryMemory,
  createQueryMemoryLog,
} from '../js/provenance/query-memory.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// In-memory stand-in for js/learning/memory-store.js's Query Memory contract.
// Mirrors the non-unique-fingerprint, append-only semantics of the real store.
function makeFakeStore() {
  const entries = [];
  return {
    entries,
    async appendQueryMemory(list) { for (const e of list) entries.push(e); return list.length; },
    async getQueryMemory() { return entries.slice(); },
    async getQueryMemoryByFingerprint(fp) { return entries.filter((e) => e.fingerprint === fp); },
    async clearQueryMemory() { entries.length = 0; },
  };
}

async function main() {
  // ---------- QUERY_KINDS ----------
  ok(QUERY_KINDS.SQL === 'sql' && QUERY_KINDS.PYTHON === 'python'
    && QUERY_KINDS.R === 'r' && QUERY_KINDS.METRIC === 'metric',
    'QUERY_KINDS exposes sql/python/r/metric');
  ok(Object.isFrozen(QUERY_KINDS), 'QUERY_KINDS is frozen');

  // ---------- normalizeQueryText ----------
  ok(normalizeQueryText('  SELECT   *\n  FROM t ;  ') === 'SELECT * FROM t',
    'normalize: collapses whitespace/newlines, trims, drops trailing semicolon');
  ok(normalizeQueryText(null) === '' && normalizeQueryText(undefined) === '',
    'normalize: nullish -> empty string, no throw');
  ok(normalizeQueryText('SELECT 1;') === 'SELECT 1', 'normalize: drops a bare trailing semicolon');
  ok(normalizeQueryText('SELECT * FROM t') === 'SELECT * FROM t', 'normalize: already-clean text is unchanged');
  // The documented Batch-1 floor: NO lowercasing / semantic parsing.
  ok(normalizeQueryText('SELECT *') !== normalizeQueryText('select *'),
    'normalize: does NOT lowercase (exact-match floor, case is significant)');

  // ---------- buildQuerySignaturePayload ----------
  {
    const p = buildQuerySignaturePayload({ kind: 'sql', text: 'SELECT a', context: { tables: ['t2', 't1', 't1'], columns: ['b', 'a'] } });
    ok(p.kind === 'sql' && p.text === 'SELECT a', 'payload: carries kind + normalized text');
    ok(JSON.stringify(p.tables) === JSON.stringify(['t1', 't2']), 'payload: tables sorted + de-duplicated');
    ok(JSON.stringify(p.columns) === JSON.stringify(['a', 'b']), 'payload: columns sorted');
    const bad = buildQuerySignaturePayload(null);
    ok(bad.kind === 'unknown' && bad.text === '' && bad.tables.length === 0,
      'payload: null run -> safe defaults (kind unknown, empty text/ids)');
    const blanks = buildQuerySignaturePayload({ text: 'x', context: { tables: ['', null, '  ', 't'] } });
    ok(JSON.stringify(blanks.tables) === JSON.stringify(['t']), 'payload: blank/nullish identifiers dropped');
  }

  // ---------- computeQueryFingerprint (exact-match semantics) ----------
  const base = { kind: 'sql', text: 'SELECT * FROM claims WHERE amt > 0', context: { tables: ['claims'], columns: ['amt'] } };
  const fpBase = await computeQueryFingerprint(base);
  ok(/^[0-9a-f]{64}$/.test(fpBase), 'fingerprint: 64-hex SHA-256 string');

  // identical run -> same fingerprint
  ok(await computeQueryFingerprint({ ...base, context: { tables: ['claims'], columns: ['amt'] } }) === fpBase,
    'fingerprint: identical run collides');
  // whitespace/newline-only difference -> same fingerprint (normalization)
  ok(await computeQueryFingerprint({ ...base, text: '  SELECT  *   FROM claims\n  WHERE amt > 0 ;' }) === fpBase,
    'fingerprint: whitespace/newline/semicolon-only difference still collides');
  // table order in context -> same fingerprint
  ok(await computeQueryFingerprint({ ...base, context: { tables: ['claims'], columns: ['amt'] } }) === fpBase,
    'fingerprint: identical context collides');

  // changed literal value -> different fingerprint (distinct query)
  ok(await computeQueryFingerprint({ ...base, text: 'SELECT * FROM claims WHERE amt > 1' }) !== fpBase,
    'fingerprint: a changed value is a DISTINCT query');
  // same text, different table -> different fingerprint (context-grounded)
  ok(await computeQueryFingerprint({ ...base, context: { tables: ['payments'], columns: ['amt'] } }) !== fpBase,
    'fingerprint: same text against a different table is DISTINCT (context-grounded)');
  // same text, different columns -> different fingerprint
  ok(await computeQueryFingerprint({ ...base, context: { tables: ['claims'], columns: ['amt', 'id'] } }) !== fpBase,
    'fingerprint: same text touching different columns is DISTINCT');
  // case difference -> different fingerprint (documented exact-match limitation)
  ok(await computeQueryFingerprint({ ...base, text: 'select * from claims where amt > 0' }) !== fpBase,
    'fingerprint: case difference is DISTINCT in Batch 1 (exact match, documented)');
  // different kind -> different fingerprint
  ok(await computeQueryFingerprint({ ...base, kind: 'python' }) !== fpBase,
    'fingerprint: a different run kind is DISTINCT');

  // ---------- buildQueryMemoryEntry ----------
  {
    const e = buildQueryMemoryEntry({ fingerprint: 'abc', kind: 'sql', author: '  Ada ', ts: 123, label: ' daily revenue ' });
    ok(e.fingerprint === 'abc' && e.kind === 'sql' && e.author === 'Ada' && e.ts === 123 && e.label === 'daily revenue',
      'entry: carries + trims fingerprint/kind/author/ts/label');
    ok(!('text' in e), 'entry: NEVER persists raw query text (privacy-minimal)');
    const d = buildQueryMemoryEntry({ fingerprint: 'x' });
    ok(d.author === 'unknown' && d.kind === 'unknown' && d.label === null && Number.isFinite(d.ts),
      'entry: safe defaults (author/kind unknown, label null, ts stamped)');
    ok(JSON.parse(JSON.stringify(e)).fingerprint === 'abc', 'entry: JSON-safe');
  }

  // ---------- summarizeEntries / summarizeQueryMemory ----------
  {
    const empty = summarizeEntries('fp', []);
    ok(empty.seen === false && empty.count === 0 && empty.authors.length === 0 && empty.firstSeenAt === null,
      'summarize: no entries -> seen false, count 0');
    ok(summarizeEntries('fp', null).seen === false, 'summarize: junk (null) -> not seen, no throw');

    const s = summarizeEntries('fp', [
      { author: 'Ada', ts: 300 },
      { author: 'Grace', ts: 100 },
      { author: 'Ada', ts: 200 },
    ]);
    ok(s.seen === true && s.count === 3, 'summarize: counts all entries');
    ok(s.firstSeenAt === 100 && s.lastSeenAt === 300, 'summarize: first/last by ts');
    ok(JSON.stringify(s.authors) === JSON.stringify(['Grace', 'Ada']),
      'summarize: distinct authors in first-seen (ts) order');

    ok(summarizeQueryMemory(null).startsWith('New query'), 'badge: null -> "New query"');
    ok(summarizeQueryMemory({ seen: false }).startsWith('New query'), 'badge: not seen -> "New query"');
    ok(/run once by Ada/.test(summarizeQueryMemory({ seen: true, count: 1, authors: ['Ada'], lastSeenAt: 0 })),
      'badge: seen once names the author');
    ok(/run 3× by 2 people/.test(summarizeQueryMemory({ seen: true, count: 3, authors: ['Ada', 'Grace'], lastSeenAt: 0 })),
      'badge: seen multiple times summarizes count + people');
  }

  // ---------- createQueryMemoryLog: guard ----------
  {
    let threw = false;
    try { createQueryMemoryLog({}); } catch (_) { threw = true; }
    ok(threw, 'log: throws without a store adapter');
    let threw2 = false;
    try { createQueryMemoryLog(); } catch (_) { threw2 = true; }
    ok(threw2, 'log: throws with no args');
  }

  // ---------- createQueryMemoryLog: record + lookup against fake store ----------
  {
    const store = makeFakeStore();
    let clock = 1000;
    const log = createQueryMemoryLog({ store, now: () => (clock += 100) });

    // First run: not seen before, prior count 0.
    const r1 = await log.record(base, 'Ada', { label: 'claims positive' });
    ok(r1.seenBefore === false && r1.priorSeenCount === 0, 'record: first run reports not-seen (prior 0)');
    ok(store.entries.length === 1 && store.entries[0].author === 'Ada' && store.entries[0].fingerprint === fpBase,
      'record: appends exactly one entry with the run fingerprint + author');
    ok(store.entries[0].label === 'claims positive', 'record: forwards optional label');

    // Lookup (no write): now seen once.
    const l1 = await log.lookup(base);
    ok(l1.seen === true && l1.count === 1 && l1.fingerprint === fpBase, 'lookup: finds the single prior run');
    ok(store.entries.length === 1, 'lookup: does NOT write');

    // Same run again by a different author: prior count reflects BEFORE this run.
    const r2 = await log.record({ ...base, text: '  SELECT * FROM claims WHERE amt > 0 ;' }, 'Grace');
    ok(r2.seenBefore === true && r2.priorSeenCount === 1,
      'record: whitespace-variant recognized as the SAME run; prior count = 1 (state before)');
    ok(store.entries.length === 2, 'record: appended a second entry (append-only, no overwrite)');

    const l2 = await log.lookup(base);
    ok(l2.count === 2 && JSON.stringify(l2.authors) === JSON.stringify(['Ada', 'Grace']),
      'lookup: count 2, both distinct authors tracked in order');

    // A genuinely distinct query is NOT seen.
    const distinct = { kind: 'sql', text: 'SELECT count(*) FROM payments', context: { tables: ['payments'] } };
    const lD = await log.lookup(distinct);
    ok(lD.seen === false && lD.count === 0, 'lookup: a distinct query is not seen');
    ok(lD.fingerprint !== fpBase, 'lookup: distinct query has a different fingerprint');

    // history() is newest-first across the whole log.
    const h = await log.history();
    ok(h.length === 2 && h[0].ts > h[1].ts, 'history: whole log, newest-first');
  }

  // ---------- fallback path: adapter WITHOUT getQueryMemoryByFingerprint ----------
  {
    const inner = makeFakeStore();
    const store = {
      async appendQueryMemory(list) { return inner.appendQueryMemory(list); },
      async getQueryMemory() { return inner.getQueryMemory(); },
      // deliberately NO getQueryMemoryByFingerprint -> forces the getQueryMemory filter path
    };
    const log = createQueryMemoryLog({ store, now: () => 5 });
    await log.record(base, 'Ada');
    const l = await log.lookup(base);
    ok(l.seen === true && l.count === 1, 'fallback: lookup filters getQueryMemory() when no by-fingerprint read exists');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
