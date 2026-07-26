// ============================================================
// DATAGLOW - Proof Harness v1: Proof Inbox (review queue)
// ============================================================
// WHY THIS EXISTS
// PROOF_HARNESS_V1_SPEC.md, pillar 4: doctrine #8 says "There is no chat
// panel. The surface is a claim bar plus a review inbox." v0 shipped one
// card (the current claim). v1's Inbox is the primary review QUEUE surface
// inside the VERDICT panel: a list of proposals/results awaiting review --
// pending prove, proven GREEN awaiting confirm, RED, GRAY, AMBER -- with
// actions Prove / Confirm / Reject / Open, each reachable in at most two
// interactions (open the item, press the action), per the spec.
//
// This module owns ONLY the queue state machine: pure data in, pure data
// out, no DOM. The canvas UI module renders whatever this returns and calls
// back into these functions on button clicks. Every entry here is plain
// data shaped like what runProofCycle() already returns (proposal, run,
// verdict, receipt), so the Inbox never invents a second description of a
// prove cycle's result -- it queues and labels the SAME objects.
//
// PURITY: no DOM, no network, no engine call, never throws.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export const INBOX_ITEM_STATUSES = Object.freeze([
  'pending-prove',   // queued, not yet run
  'awaiting-confirm', // proven GREEN, not yet confirmed
  'red',             // refuted
  'gray',            // not provable, blocker named
  'amber',           // stale, re-prove required
  'confirmed',       // human confirmed
  'rejected',        // human rejected
]);

function statusFromVerdictState(state) {
  if (state === 'GREEN') return 'awaiting-confirm';
  if (state === 'RED') return 'red';
  if (state === 'AMBER') return 'amber';
  return 'gray';
}

/**
 * Build one inbox item from a claim/proposal that has not been run yet.
 * @param {{claimText?:string, statement?:string, expected?:object}} input
 */
export function buildPendingItem(input) {
  const inp = isPlainObject(input) ? input : {};
  return {
    id: 'inbox-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36),
    status: 'pending-prove',
    claimText: typeof inp.claimText === 'string' ? inp.claimText : '',
    statement: typeof inp.statement === 'string' ? inp.statement : '',
    expected: isPlainObject(inp.expected) ? inp.expected : {},
    proposal: null,
    run: null,
    verdict: null,
    receipt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Build (or update) an inbox item from a completed runProofCycle() result.
 * Never throws; a malformed result still produces a usable, labeled item.
 * @param {ReturnType<typeof import('./index.js').runProofCycle> | object} cycleResult
 * @param {object} [existingItem] item being updated in place (Prove again)
 */
export function itemFromCycleResult(cycleResult, existingItem) {
  const r = isPlainObject(cycleResult) ? cycleResult : {};
  const base = isPlainObject(existingItem) ? existingItem : buildPendingItem({});
  const verdictState = r.verdict && typeof r.verdict.state === 'string' ? r.verdict.state : null;
  return {
    ...base,
    status: verdictState ? statusFromVerdictState(verdictState) : 'gray',
    claimText: (r.proposal && r.proposal.claimText) || base.claimText || '',
    statement: (r.proposal && r.proposal.statement) || base.statement || '',
    expected: (r.proposal && r.proposal.expected) || base.expected || {},
    proposal: r.proposal || base.proposal || null,
    run: r.run || null,
    verdict: r.verdict || null,
    receipt: r.receipt || null,
    updatedAt: Date.now(),
  };
}

/**
 * A review queue: an ordered list of inbox items plus the mutators the
 * spec's Prove / Confirm / Reject / Open actions need. Newest-first ordering
 * for display is a canvas rendering choice, not stored here -- this module
 * keeps insertion order and lets the caller sort.
 *
 * HOTFIX NOTE (createInbox is factory-only, by design, not a bug): this
 * module deliberately exposes NO module-level singleton (no getInbox() /
 * listInbox() / getInboxItems() on window.DataGlowProofHarness). Unlike the
 * receipt ledger and vault, which are session-scoped singletons owned by
 * index.js (so every caller shares one chain), the review inbox is UI-owned
 * state: the canvas (data-glow-proof-harness-canvas.js) is the only caller,
 * and it already does the right thing -- it lazily creates exactly ONE
 * inbox instance via `engine().createInbox()` on first use and holds it in
 * its own module-level `_inboxStore` variable (see `function inbox()` in
 * the canvas module), reusing that same instance for every render/action
 * for the life of the page. A second window-level singleton here would just
 * be a second, redundant place the same list could drift out of sync with
 * the canvas's copy. Any OTHER caller that wants its own queue (e.g. a
 * future desktop shell surface) can and should call createInbox() itself
 * and hold onto the returned handle the same way the canvas does -- that is
 * what "factory-only" means here, not a missing accessor.
 */
export function createInbox() {
  let items = [];

  /** Add (queue) a new pending item; returns the created item. */
  function enqueue(input) {
    const item = buildPendingItem(input);
    items = items.concat([item]);
    return item;
  }

  /** Replace an item's fields after a Prove cycle completes. */
  function recordCycleResult(id, cycleResult) {
    let updated = null;
    items = items.map((it) => {
      if (it.id !== id) return it;
      updated = itemFromCycleResult(cycleResult, it);
      return updated;
    });
    return updated;
  }

  /** Mark an item confirmed (human Confirm action). */
  function confirm(id, confirmResult) {
    let updated = null;
    items = items.map((it) => {
      if (it.id !== id) return it;
      updated = { ...it, status: 'confirmed', confirm: confirmResult || null, updatedAt: Date.now() };
      return updated;
    });
    return updated;
  }

  /** Mark an item rejected (human Reject action). Rejection is itself a
   *  vault-worthy event per the spec, so the returned item carries enough
   *  (statement/expected) for a caller to feed vault.js's add(). */
  function reject(id, reason) {
    let updated = null;
    items = items.map((it) => {
      if (it.id !== id) return it;
      updated = { ...it, status: 'rejected', rejectReason: typeof reason === 'string' ? reason : null, updatedAt: Date.now() };
      return updated;
    });
    return updated;
  }

  /** Read-only snapshot of the current queue, oldest first. */
  function list() {
    return items.slice();
  }

  /** Items still needing a human look: not yet confirmed or rejected. */
  function pendingReview() {
    return items.filter((it) => it.status !== 'confirmed' && it.status !== 'rejected');
  }

  function get(id) {
    return items.find((it) => it.id === id) || null;
  }

  function size() {
    return items.length;
  }

  function clear() {
    items = [];
  }

  return { enqueue, recordCycleResult, confirm, reject, list, pendingReview, get, size, clear };
}

/**
 * Plain-language, no-em-dash label for an inbox item's status, for the
 * canvas UI to render directly without inventing its own copy.
 * @param {string} status one of INBOX_ITEM_STATUSES
 */
export function statusLabel(status) {
  switch (status) {
    case 'pending-prove': return 'Waiting to be proven';
    case 'awaiting-confirm': return 'Proven, awaiting confirm';
    case 'red': return 'Refuted';
    case 'gray': return 'Not provable yet';
    case 'amber': return 'Stale, re-prove required';
    case 'confirmed': return 'Confirmed';
    case 'rejected': return 'Rejected';
    default: return 'Unknown';
  }
}
