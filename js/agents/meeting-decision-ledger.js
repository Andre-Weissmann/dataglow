// ============================================================
// DATAGLOW — Meeting Decision Ledger (Gen 43, Part 3)
// ============================================================
// The first piece of the "Meeting-to-Metric Provenance & Change Requests"
// concept: a permanent, on-device, chart-anchored record of what happened in
// a meeting, so a pushback moment, a data request, or an action item is not
// lost the moment someone leaves the Meeting tab or clicks Clear.
//
// WHAT THIS MODULE IS NOT: it does not capture audio, run speech-to-text, or
// talk to any server. It takes the ALREADY-TAGGED segments and action items
// that js/agents/meeting-scribe-agent.js (Part 1) already produces and turns
// each noteworthy one into a small, permanent, JSON-safe ledger entry. This
// module has no DOM coupling and no import of any storage engine — it is
// handed a `store` adapter by the caller (same injection pattern already
// used by js/learning/self-learning-rules.js for js/learning/memory-store.js),
// so it is fully testable with a tiny in-memory fake and never assumes a
// browser or IndexedDB exist.
//
// WHY "chart-anchored": every entry keeps whatever `context` the Part 1
// tagger attached (`{chart, queryLabel}` or `null` if no context timeline
// was available yet — see meeting-scribe-agent.js's own documented
// graceful-degradation path). Nothing here invents a chart reference that
// wasn't actually on screen.
//
// APPEND-ONLY BY DESIGN: `buildLedgerEntry` never mutates an existing entry.
// Once a segment or action item is turned into an entry, that entry's
// original text/ts/context are frozen; the ONLY thing that can change on an
// action-item-derived entry later is its resolution status, and that is a
// brand-new entry via `buildLedgerEntry` again (linked by `sourceKey`), never
// an in-place edit — so the history of "was this ever open" is never erased.
// This mirrors the ledger's job: a provenance record you can trust precisely
// because nothing in it can be silently rewritten after the fact.
//
// EMPOWERMENT / PRIVACY CONSTRAINT (same as the rest of Gen 42/43): every
// entry stays on the device by default. Exporting the ledger is a separate,
// explicit, user-initiated action (`exportLedgerEntries`) that this module
// only formats — it does not name `fetch`, `XMLHttpRequest`, or any network
// primitive, and it never calls the injected store's export/write path
// without the caller asking for it.

// ---------- entry construction ----------

/**
 * Build one immutable-in-spirit ledger entry from a tagged transcript segment
 * or an action item. `kind` determines which shape `sourceKey` derives from,
 * so two calls for the exact same underlying event produce the same key
 * (useful for de-duplication by a caller, though this module never dedupes
 * on its own — that would require assuming a store's read semantics).
 *
 * @param {object} opts
 * @param {'pushback'|'dataRequest'|'actionItem'|'note'} opts.kind
 * @param {string} opts.meetingId
 * @param {string} opts.text
 * @param {number} opts.ts
 * @param {{chart:string, queryLabel:?string}|null} [opts.context]
 * @param {string} [opts.matched]      the matched phrase, for pushback/dataRequest
 * @param {string} [opts.status]      for actionItem entries: 'open'|'resolved'
 * @param {{owner:?string, dueDate:?string, outcome:?string}} [opts.actionFields]
 * @param {{resolvedBy:?string, suggestion:?string, reasoning:?string, confidence:?number}} [opts.recheckResolution]
 *        For pushback entries only: a small PLAIN summary of an on-device
 *        re-check (see meeting-scribe-ui.js `onRecheck`). Defensively
 *        sanitized here — arbitrary objects are discarded, never stored.
 * @returns {object} a plain, JSON-safe ledger entry
 */
export function buildLedgerEntry(opts = {}) {
  const {
    kind, meetingId, text, ts, context = null, matched = null, status = null, actionFields = null,
    recheckResolution = null,
  } = opts;
  const validKinds = ['pushback', 'dataRequest', 'actionItem', 'note'];
  const safeKind = validKinds.includes(kind) ? kind : 'note';
  const safeTs = typeof ts === 'number' && Number.isFinite(ts) ? ts : 0;
  const safeMeetingId = String(meetingId || '');
  const safeText = String(text || '');
  const safeContext = context && typeof context.chart === 'string' && context.chart !== ''
    ? { chart: context.chart, queryLabel: context.queryLabel || null }
    : null;

  const entry = {
    // sourceKey identifies WHICH spoken moment or action item this entry is
    // about, so a caller can later find "every entry about this one line"
    // without this module needing to know anything about storage.
    sourceKey: `${safeMeetingId}::${safeKind}::${safeTs}::${safeText.slice(0, 80)}`,
    kind: safeKind,
    meetingId: safeMeetingId,
    text: safeText,
    ts: safeTs,
    context: safeContext,
    matched: matched ? String(matched) : null,
    status: safeKind === 'actionItem' ? (status === 'resolved' ? 'resolved' : 'open') : null,
    actionFields: safeKind === 'actionItem' && actionFields ? {
      owner: actionFields.owner != null ? String(actionFields.owner) : null,
      dueDate: actionFields.dueDate != null ? String(actionFields.dueDate) : null,
      outcome: actionFields.outcome != null ? String(actionFields.outcome) : null,
    } : null,
    // recordedAt is wall-clock write time (distinct from `ts`, the meeting-
    // relative moment) — this is what makes the ledger genuinely tamper-
    // evident-in-spirit: entries append in real recorded order.
    recordedAt: Date.now(),
  };

  // recheckResolution is added ONLY when a genuine one was supplied — a draft
  // built without it is byte-identical to before (no null key), so existing
  // callers are unaffected. Sanitized field-by-field: we copy only the four
  // known scalars, coerce the strings, clamp confidence to 0-1, and drop
  // anything else — an arbitrary object is never stored verbatim.
  const safeRecheck = sanitizeRecheckResolution(recheckResolution);
  if (safeRecheck) entry.recheckResolution = safeRecheck;

  return entry;
}

// Defensive sanitizer: returns a plain 4-field object or null. Never returns
// a partially-populated object with a missing scalar as `undefined` — absent
// scalars become null so the shape is stable and JSON-safe.
function sanitizeRecheckResolution(r) {
  if (!r || typeof r !== 'object') return null;
  const conf = Number(r.confidence);
  return {
    resolvedBy: r.resolvedBy != null ? String(r.resolvedBy) : null,
    suggestion: r.suggestion != null ? String(r.suggestion) : null,
    reasoning: r.reasoning != null ? String(r.reasoning) : null,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
  };
}

/**
 * Turn a full set of Part-1 tagged segments + action items into the list of
 * ledger entries worth keeping permanently. Deliberately NOT every line of
 * the transcript — only pushback moments, data requests, and action items,
 * which is exactly the "noteworthy" set Part 1 already computes. A caller
 * who wants the full transcript archived too can pass `includeAllLines`.
 *
 * @param {{meetingId:string, taggedSegments:Array<object>, actionItems?:Array<object>, includeAllLines?:boolean}} opts
 * @returns {Array<object>} plain, JSON-safe ledger entries, oldest first
 */
export function buildLedgerEntriesFromMeeting(opts = {}) {
  const {
    meetingId, taggedSegments, actionItems = [], includeAllLines = false,
  } = opts;
  const tagged = Array.isArray(taggedSegments) ? taggedSegments : [];
  const entries = [];

  for (const s of tagged) {
    if (!s || typeof s.text !== 'string') continue;
    if (s.pushback && s.pushback.isPushback) {
      entries.push(buildLedgerEntry({
        kind: 'pushback', meetingId, text: s.text, ts: s.ts, context: s.context, matched: s.pushback.matched,
        // Pass through the on-device re-check summary if meeting-scribe-ui.js
        // attached one to this segment; absent → buildLedgerEntry omits the
        // key entirely, so an un-rechecked pushback entry is unchanged.
        recheckResolution: s.recheckResolution,
      }));
    } else if (s.dataRequest && s.dataRequest.isDataRequest) {
      entries.push(buildLedgerEntry({
        kind: 'dataRequest', meetingId, text: s.text, ts: s.ts, context: s.context, matched: s.dataRequest.matched,
      }));
    } else if (includeAllLines) {
      entries.push(buildLedgerEntry({ kind: 'note', meetingId, text: s.text, ts: s.ts, context: s.context }));
    }
  }

  for (const item of (Array.isArray(actionItems) ? actionItems : [])) {
    if (!item || typeof item.text !== 'string') continue;
    entries.push(buildLedgerEntry({
      kind: 'actionItem',
      meetingId,
      text: item.text,
      ts: item.ts,
      status: item.status,
      actionFields: { owner: item.owner, dueDate: item.dueDate, outcome: item.outcome },
    }));
  }

  return entries.sort((a, b) => a.ts - b.ts);
}

// ---------- persistence (via an injected store adapter) ----------

/**
 * The store adapter contract this module expects (mirrors memory-store.js's
 * shape for approvedRules): `{ appendLedgerEntries(entries), getLedgerEntries(),
 * clearLedgerEntries() }`. This module never imports a concrete store — the
 * caller (main.js in the browser, or a test's fake) supplies one, exactly
 * like js/learning/self-learning-rules.js does for learnedCorrections.
 */

/**
 * Persist a batch of entries via the injected store. A no-op, resolved
 * promise if `entries` is empty — never calls the store for nothing.
 * @param {object} store
 * @param {Array<object>} entries
 * @returns {Promise<number>} number of entries written
 */
export async function saveLedgerEntries(store, entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return 0;
  if (!store || typeof store.appendLedgerEntries !== 'function') {
    throw new Error('saveLedgerEntries requires a store with an appendLedgerEntries(entries) method.');
  }
  await store.appendLedgerEntries(list);
  return list.length;
}

/**
 * Read every ledger entry back out via the injected store, oldest first.
 * @param {object} store
 * @returns {Promise<Array<object>>}
 */
export async function loadLedgerEntries(store) {
  if (!store || typeof store.getLedgerEntries !== 'function') {
    throw new Error('loadLedgerEntries requires a store with a getLedgerEntries() method.');
  }
  const entries = await store.getLedgerEntries();
  return (Array.isArray(entries) ? entries : []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// ---------- filtering / summarizing (pure, no store) ----------

/**
 * Filter a list of ledger entries down to a single meeting, chart, or kind —
 * whatever the UI's browse controls ask for. Any unset filter is ignored.
 * @param {Array<object>} entries
 * @param {{meetingId?:string, chart?:string, kind?:string}} [filters]
 * @returns {Array<object>}
 */
export function filterLedgerEntries(entries, filters = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const { meetingId, chart, kind } = filters;
  return list.filter((e) => {
    if (meetingId && e.meetingId !== meetingId) return false;
    if (kind && e.kind !== kind) return false;
    if (chart && (!e.context || e.context.chart !== chart)) return false;
    return true;
  });
}

/**
 * Every distinct chart name referenced across the ledger, in first-seen
 * order — the raw material for a "browse by chart" control. Entries with no
 * context (no chart-context timeline wired in yet) are simply not counted,
 * never mislabeled.
 * @param {Array<object>} entries
 * @returns {Array<string>}
 */
export function chartsReferencedIn(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = [];
  for (const e of list) {
    const chart = e && e.context && e.context.chart;
    if (typeof chart === 'string' && chart !== '' && !seen.includes(chart)) seen.push(chart);
  }
  return seen;
}

// ---------- export (formatting only — no network) ----------

/**
 * Format a list of ledger entries as a portable, human-readable JSON export.
 * This function only builds a string; writing it to a file (browser download)
 * or presenting a copy-to-clipboard button is the UI layer's job. This
 * module names no network primitive anywhere in this file.
 * @param {Array<object>} entries
 * @returns {string}
 */
export function exportLedgerEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    entryCount: list.length,
    entries: list,
  }, null, 2);
}
