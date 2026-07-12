// ============================================================
// DATAGLOW — Query Memory (fingerprint + log, Batch 1 of N)
// ============================================================
// WHY THIS EXISTS (the concept, batch 1):
// Every SQL / Python / R / Metric Studio run an analyst executes is a moment of
// intent. Today those moments evaporate: nothing records that "this exact query,
// against these exact columns, was run before — and last time it passed
// validation." Query Memory fingerprints each run (a hash of its normalized text
// plus the tables/columns it touches), logs WHO ran it and WHEN, and can later
// answer "have we seen this before, how often, and by whom?". A future phase can
// surface that as a "seen before" badge that grounds trust in real, validated
// usage history — explicitly complementary to the shipped AI Readiness Gate
// (js/gate/readiness-gate.js): the Gate decides whether data is agent-ready right
// now; Query Memory can become the audit trail BEHIND those decisions over time.
//
// WHAT THIS MODULE IS: the pure, Node-testable half. It computes fingerprints and
// composes log entries / lookup verdicts, and it talks to persistence ONLY through
// an injected `store` adapter (the exact dependency-injection pattern
// js/agents/meeting-decision-ledger.js uses for js/learning/memory-store.js). It
// has no DOM coupling, imports no storage engine, and never assumes a browser or
// IndexedDB exist — so it is fully testable against a tiny in-memory fake. The
// real IndexedDB store lives in js/learning/memory-store.js
// (appendQueryMemory / getQueryMemory / getQueryMemoryByFingerprint / clearQueryMemory).
//
// HASHING: reuses the SINGLE sha256Hex primitive from js/provenance/provenance.js
// (Web Crypto SHA-256, available in the browser and modern Node) rather than
// introducing a second hashing approach — same discipline as the selective-
// disclosure proof and the diplomacy claim seal.
//
// BATCH-1 MATCHING = EXACT (documented on purpose). Two runs share a fingerprint
// iff their NORMALIZED text is byte-identical AND they touch the same set of
// tables/columns. Normalization only trims and collapses whitespace/newlines and
// drops a trailing semicolon; it does NOT parse SQL, lowercase keywords, or
// canonicalize identifiers — so `SELECT *` and `select *` are DISTINCT in Batch 1.
// Fuzzy / semantic "near-match" (e.g. keyword-case-insensitive, alias-normalized,
// or edit-distance similarity) is deliberately deferred to a later batch; exact
// match is the honest, false-positive-free floor to build the badge on first.
//
// WHAT THIS BATCH DELIBERATELY DOES NOT DO YET (nothing calls it):
//   - No UI, no "seen before" badge, no wiring into the SQL / Python / R /
//     Metric Studio run paths — that is a later batch.
// This batch is pure logic + tests ONLY, behind the OFF-by-default `queryMemory`
// flag. Same batch-1 pattern as the AI Readiness Gate, The Glow, and Data Diplomacy.

import { sha256Hex } from './provenance.js';

// The run kinds Query Memory understands. A run whose kind isn't one of these is
// still fingerprinted and logged (recorded verbatim), so an unforeseen future
// surface is never silently dropped — the set is for labeling, not gatekeeping.
export const QUERY_KINDS = Object.freeze({
  SQL: 'sql',
  PYTHON: 'python',
  R: 'r',
  METRIC: 'metric',
});

// Collapse a query/run body to a stable form for hashing: coerce to string, trim,
// collapse every run of whitespace (spaces, tabs, newlines) to a single space,
// and drop a single trailing semicolon + surrounding space. Intentionally shallow
// (see the BATCH-1 note above) — it removes incidental formatting noise WITHOUT
// pretending to understand the language.
export function normalizeQueryText(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*;\s*$/, '');
}

// Normalize a list of identifiers (table or column names) into a stable, sorted,
// de-duplicated, string array so the SAME set in a different order or with dupes
// produces the SAME signature. Blank/nullish entries are dropped.
function normalizeIdentifiers(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const item of list) {
    if (item == null) continue;
    const s = String(item).trim();
    if (s) seen.add(s);
  }
  return [...seen].sort();
}

// The canonical object a fingerprint commits to. Kept explicit and stable so a
// re-fingerprint of the same run is reproducible across sessions and machines.
// `context` grounds a run in the data it actually touched: the identical text
// against a different table (or different columns) is a DIFFERENT run, so the
// "seen before" history is honest per-dataset rather than text-only.
export function buildQuerySignaturePayload(run) {
  const r = run && typeof run === 'object' ? run : {};
  const ctx = r.context && typeof r.context === 'object' ? r.context : {};
  return {
    kind: typeof r.kind === 'string' && r.kind ? r.kind : 'unknown',
    text: normalizeQueryText(r.text),
    tables: normalizeIdentifiers(ctx.tables),
    columns: normalizeIdentifiers(ctx.columns),
  };
}

// SHA-256 hex fingerprint of a run. Async because it uses the shared Web Crypto
// primitive. Two runs collide iff their canonical payloads are byte-identical.
export async function computeQueryFingerprint(run) {
  return sha256Hex(JSON.stringify(buildQuerySignaturePayload(run)));
}

// Build one plain, JSON-safe log entry. Privacy-minimal by design: it stores the
// FINGERPRINT (identity), the run KIND, WHO ran it, and WHEN — plus an OPTIONAL
// short human `label` the caller may supply (e.g. a metric name or a truncated
// preview). It deliberately does NOT persist the raw query text by default,
// mirroring memory-store.js's "store derived summaries, not raw content" ethos;
// the fingerprint is the stable identity the lookup needs, not the source text.
export function buildQueryMemoryEntry({ fingerprint, kind, author, ts, label } = {}) {
  return {
    fingerprint: typeof fingerprint === 'string' ? fingerprint : '',
    kind: typeof kind === 'string' && kind ? kind : 'unknown',
    author: author != null && String(author).trim() ? String(author).trim() : 'unknown',
    ts: Number.isFinite(ts) ? ts : Date.now(),
    label: label != null && String(label).trim() ? String(label).trim() : null,
  };
}

// Fold a list of stored entries for ONE fingerprint into a lookup verdict. Pure:
// given the entries, it reports whether the run was seen before, how many times,
// when first/last, and by which distinct authors (in first-seen order). Never
// throws on junk — a non-array is treated as "no history".
export function summarizeEntries(fingerprint, entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const count = list.length;
  const sorted = [...list].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const authors = [];
  for (const e of sorted) {
    const a = e.author || 'unknown';
    if (!authors.includes(a)) authors.push(a);
  }
  return {
    fingerprint,
    seen: count > 0,
    count,
    firstSeenAt: count ? sorted[0].ts ?? null : null,
    lastSeenAt: count ? sorted[count - 1].ts ?? null : null,
    authors,
    entries: sorted,
  };
}

// Human-readable one-liner for a future "seen before" badge. Pure string builder,
// no DOM. Honest about the exact-match floor and never invents a count.
export function summarizeQueryMemory(lookupResult) {
  if (!lookupResult || typeof lookupResult !== 'object' || !lookupResult.seen) {
    return 'New query — not seen before on this device.';
  }
  const { count, authors = [], lastSeenAt } = lookupResult;
  const times = count === 1 ? 'once' : `${count}×`;
  const who = authors.length === 1 ? `by ${authors[0]}` : `by ${authors.length} people`;
  const when = Number.isFinite(lastSeenAt) ? `, most recently ${new Date(lastSeenAt).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '';
  return `Seen before — run ${times} ${who}${when} (exact match).`;
}

// Factory over an injected `store` adapter. The adapter mirrors the
// js/learning/memory-store.js contract:
//   appendQueryMemory(entries: object[]): Promise<number>
//   getQueryMemoryByFingerprint(fp: string): Promise<object[]>   (all logs for fp)
//   getQueryMemory(): Promise<object[]>                          (whole log)
// `now` is injectable for deterministic tests; defaults to Date.now.
export function createQueryMemoryLog({ store, now = Date.now } = {}) {
  if (!store || typeof store.appendQueryMemory !== 'function') {
    throw new Error('createQueryMemoryLog requires a store adapter with appendQueryMemory().');
  }

  // Look up a run's history WITHOUT recording it. Prefers the indexed
  // by-fingerprint read when the adapter exposes it, else filters the whole log.
  async function lookup(run) {
    const fingerprint = await computeQueryFingerprint(run);
    let entries;
    if (typeof store.getQueryMemoryByFingerprint === 'function') {
      entries = await store.getQueryMemoryByFingerprint(fingerprint);
    } else if (typeof store.getQueryMemory === 'function') {
      const all = await store.getQueryMemory();
      entries = (Array.isArray(all) ? all : []).filter((e) => e && e.fingerprint === fingerprint);
    } else {
      entries = [];
    }
    return summarizeEntries(fingerprint, entries);
  }

  // Record a run: compute its fingerprint, capture the PRIOR history (so the
  // caller can render "seen before" reflecting the state BEFORE this run), append
  // one entry, and return both. Appending is the only write; nothing is mutated.
  async function record(run, author, opts = {}) {
    const priorLookup = await lookup(run);
    const entry = buildQueryMemoryEntry({
      fingerprint: priorLookup.fingerprint,
      kind: run && typeof run === 'object' ? run.kind : undefined,
      author,
      ts: now(),
      label: opts.label,
    });
    await store.appendQueryMemory([entry]);
    return { entry, priorSeenCount: priorLookup.count, seenBefore: priorLookup.seen, priorLookup };
  }

  // The whole log, newest-first, for a future "recent runs" surface.
  async function history() {
    if (typeof store.getQueryMemory !== 'function') return [];
    const all = await store.getQueryMemory();
    return (Array.isArray(all) ? all : []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  return { record, lookup, history };
}
