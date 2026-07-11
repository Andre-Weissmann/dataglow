// ============================================================
// DATAGLOW — Ownership Ledger (DataGlow Passport, Batch D)
// ============================================================
// A DIFFERENT question from the Chain of Custody. The provenance chain
// (js/provenance/provenance.js) and the Assumption Ledger
// (js/provenance/assumption-ledger.js) already record WHAT happened to a
// dataset — every transformation, every judgment call. This module answers
// WHO is / was responsible for it: the failure mode where a dataset or
// dashboard quietly changes hands (the builder leaves, it gets reassigned, it
// is handed off with no record) and, when it later breaks, nobody can say
// "whose is this, and who touched it last".
//
// DESIGN — inference over assertion. Ownership is DERIVED from the audit
// trails that already exist, not from a new manual stewardship spreadsheet.
// We read whatever identity information happens to be attached to a provenance
// step or a ledger entry and build an ordered, append-only history of
// ownership-relevant events. There is exactly ONE write path, `claimOwnership`,
// an OPT-IN supplement for when a person wants to assert ownership explicitly.
//
// HONESTY DISCIPLINE (the whole point):
//   • We NEVER invent an identity. Today, identity riders are optional — the
//     Agent Action Firewall that would attach them is not merged to main — so
//     most real events legitimately have `identity: null` ("unattributed").
//     That is reported honestly, never guessed.
//   • `summarizeCurrentOwnership` says "ownership unknown" when nothing is
//     attributed, and always carries an "inferred, not verified" caveat.
//   • An explicit `claimOwnership` record is HUMAN-ASSERTED, not independently
//     verified; it is marked `kind: 'claim'` to keep it distinct from inferred
//     events, and claims are append-only (a new claim never overwrites a prior).
//
// Pure, dependency-free, offline: no DuckDB, no DOM, no network. The presenter
// (js/app-shell/main.js) turns `buildOwnershipTimelineContent` into DOM.

// ------------------------------------------------------------
// Identity extraction — read, never fabricate.
// ------------------------------------------------------------
// Normalize an arbitrary identity value to a trimmed non-empty string, or null.
// A single choke point so "what counts as an identity" is defined once.
function normalizeIdentity(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

// Pull an identity off a provenance step or ledger entry if one is present.
// Checks the small set of places an identity rider could realistically live,
// in priority order. Returns null (unattributed) when none is found — this is
// the common, honest case, not an error.
function identityOf(record) {
  if (!record || typeof record !== 'object') return null;
  const direct = normalizeIdentity(record.identity) || normalizeIdentity(record.actor);
  if (direct) return direct;
  const d = record.detail;
  if (d && typeof d === 'object') {
    return normalizeIdentity(d.identity) || normalizeIdentity(d.actor) || normalizeIdentity(d.authorizedBy);
  }
  return null;
}

// Classify a provenance step into an ownership-event type from its operation.
// The FIRST load/ingest/import step anchors the dataset; validation/verify ops
// are validation events; everything else is a mutation (a change to the data).
function classifyProvenanceStep(step, isFirstLoad) {
  const op = String(step && step.op || '').toLowerCase();
  if (isFirstLoad && /(^|[^a-z])(load|ingest|import)/.test(op)) return 'load';
  if (/(valid|verif|check)/.test(op)) return 'validation';
  return 'mutation';
}

/**
 * Derive an ordered, append-only list of ownership-relevant events by reading
 * the existing chain-of-custody trail and assumption-ledger entries.
 *
 * @param {object} input
 * @param {Array=} input.provenanceTrail  from chain.getTrail() — steps
 *   { index, op, description, detail, ts, ... }; identity optional.
 * @param {Array=} input.assumptionEntries from getLedgerEntries() — entries
 *   { ts, source, action, detail }; identity optional.
 * @param {string=} input.localIdentity  the current viewer's local identity, if
 *   any — used ONLY to annotate the summary's viewpoint, never to backfill
 *   historical events.
 * @returns {Array<{kind:'inferred', type:string, identity:?string, ts:number,
 *   description:string, source:string, ref:object}>} oldest-first.
 */
export function deriveOwnershipEvents({ provenanceTrail, assumptionEntries } = {}) {
  const events = [];
  const trail = Array.isArray(provenanceTrail) ? provenanceTrail : [];
  let seenLoad = false;
  for (const step of trail) {
    if (!step || typeof step !== 'object') continue;
    const isFirstLoad = !seenLoad;
    const type = classifyProvenanceStep(step, isFirstLoad);
    if (type === 'load') seenLoad = true;
    events.push({
      kind: 'inferred',
      type,
      identity: identityOf(step),
      ts: typeof step.ts === 'number' ? step.ts : 0,
      description: String(step.description || step.op || 'transformation'),
      source: 'provenance',
      ref: { index: step.index, op: step.op || null },
    });
  }

  const entries = Array.isArray(assumptionEntries) ? assumptionEntries : [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    events.push({
      kind: 'inferred',
      type: 'validation',
      identity: identityOf(e),
      ts: typeof e.ts === 'number' ? e.ts : 0,
      description: String(e.action || 'judgment call'),
      source: 'assumption-ledger',
      ref: { source: e.source || null },
    });
  }

  // Stable oldest-first ordering across both sources.
  events.sort((a, b) => (a.ts - b.ts));
  return events;
}

/**
 * Infer "who is most likely responsible now" from the attributed events, using
 * a recency-weighted vote: each attributed action's weight is its rank in
 * time-order (most recent = highest), so a recent handoff outranks stale
 * history even with fewer actions. Returns an honest, caveated summary; when no
 * action is attributed it reports ownership as unknown rather than guessing.
 *
 * @param {Array} events output of deriveOwnershipEvents
 * @returns {{owner:?string, label:string, confidence:'none'|'low'|'medium'|'high',
 *   basis:string, attributedCount:number}}
 */
export function summarizeCurrentOwnership(events) {
  const list = Array.isArray(events) ? events.slice() : [];
  const attributed = list.filter(e => e && normalizeIdentity(e.identity)).sort((a, b) => (a.ts - b.ts));
  const attributedCount = attributed.length;

  if (attributedCount === 0) {
    return {
      owner: null,
      label: 'Ownership unknown — no attributed actions found in the audit trail',
      confidence: 'none',
      basis: 'No provenance step or ledger entry carried an identity, so ownership cannot be inferred (it was not fabricated).',
      attributedCount: 0,
    };
  }

  // Recency-weighted tally: rank 1..N in ascending time order, weight = rank.
  const weightByIdentity = new Map();
  const lastTsByIdentity = new Map();
  attributed.forEach((e, i) => {
    const id = normalizeIdentity(e.identity);
    const weight = i + 1;
    weightByIdentity.set(id, (weightByIdentity.get(id) || 0) + weight);
    lastTsByIdentity.set(id, Math.max(lastTsByIdentity.get(id) || 0, e.ts));
  });

  let owner = null, best = -Infinity, totalWeight = 0;
  for (const [id, w] of weightByIdentity) {
    totalWeight += w;
    if (w > best || (w === best && lastTsByIdentity.get(id) > lastTsByIdentity.get(owner))) {
      best = w; owner = id;
    }
  }

  const share = totalWeight > 0 ? best / totalWeight : 0;
  let confidence;
  if (attributedCount < 2) confidence = 'low';
  else if (share >= 0.66 && attributedCount >= 3) confidence = 'high';
  else if (share >= 0.4) confidence = 'medium';
  else confidence = 'low';

  return {
    owner,
    label: `Likely owned by "${owner}" (inferred, not verified)`,
    confidence,
    basis: `Inferred from the ${attributedCount} attributed action(s) in the audit trail, recency-weighted. This is a best-effort inference from who acted most and most recently — not a verified assignment.`,
    attributedCount,
  };
}

/**
 * Record an EXPLICIT, human-asserted ownership claim. This is the ONLY write
 * path in the module and is strictly opt-in and append-only: it returns a NEW
 * array with the claim appended and never mutates `priorClaims`, so an earlier
 * claim can never be silently overwritten. Requires a real local identity and
 * a datasetId — it will not record an anonymous or dataset-less claim.
 *
 * @param {{datasetId:string, identity:string, note?:string}} input
 * @param {Array=} priorClaims existing claim records (unchanged)
 * @returns {Array} priorClaims + the new claim
 */
export function claimOwnership({ datasetId, identity, note } = {}, priorClaims = []) {
  const id = normalizeIdentity(identity);
  if (!id) throw new Error('claimOwnership requires a non-empty local identity — an ownership claim is never recorded anonymously.');
  const ds = normalizeIdentity(datasetId);
  if (!ds) throw new Error('claimOwnership requires a non-empty datasetId.');
  const prior = Array.isArray(priorClaims) ? priorClaims : [];
  const claim = {
    kind: 'claim',
    datasetId: ds,
    identity: id,
    note: normalizeIdentity(note),
    ts: Date.now(),
  };
  return [...prior, claim];
}

/**
 * Build a pure content model (no DOM) for an ownership timeline: inferred
 * events and explicit claims merged oldest-first, each row tagged with its kind
 * so the presenter can visually distinguish an inference from a human claim.
 * Bundles the current-ownership summary for the panel header.
 *
 * @param {Array} events output of deriveOwnershipEvents
 * @param {Array} claims output of claimOwnership (or [])
 * @returns {{summary:object, rows:Array<{kind:string, type:string, ts:number,
 *   when:string, who:string, what:string, identityKnown:boolean}>}}
 */
export function buildOwnershipTimelineContent(events, claims) {
  const evs = Array.isArray(events) ? events : [];
  const cls = Array.isArray(claims) ? claims : [];

  const rows = [];
  for (const e of evs) {
    const id = normalizeIdentity(e.identity);
    rows.push({
      kind: 'inferred',
      type: e.type || 'mutation',
      ts: typeof e.ts === 'number' ? e.ts : 0,
      when: fmtTime(e.ts),
      who: id || 'unattributed',
      what: String(e.description || ''),
      identityKnown: !!id,
    });
  }
  for (const c of cls) {
    const id = normalizeIdentity(c.identity);
    rows.push({
      kind: 'claim',
      type: 'claim',
      ts: typeof c.ts === 'number' ? c.ts : 0,
      when: fmtTime(c.ts),
      who: id || 'unattributed',
      what: c.note ? `Explicit ownership claim — ${c.note}` : 'Explicit ownership claim',
      identityKnown: !!id,
    });
  }
  rows.sort((a, b) => (a.ts - b.ts));

  return { summary: summarizeCurrentOwnership(evs), rows };
}

function fmtTime(ts) {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}
