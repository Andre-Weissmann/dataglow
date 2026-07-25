// ============================================================
// DATAGLOW - Trust Ledger (pure engine)
// ============================================================
// WHY THIS EXISTS
// DataGlow already proves a lot of individual things. Validation grades a
// dataset (js/validation/validation.js). The readiness gate turns those grades
// into an agent-consumability verdict (js/gate/readiness-gate.js). Metric
// Contracts keep an append-only version trail per metric definition
// (js/metrics/metric-contracts.js). PHI Shield scans text before it travels.
// Publish-Safe (js/gate/publish-safe.js) decides whether an export may leave.
//
// What nothing answered was the question a human actually asks when they are
// held responsible for a number: "what happened here, in order, and can I show
// someone?" Each of those surfaces knows its own moment and forgets it. This
// module is the one calm place those moments land, oldest first, in rows a
// person can read out loud.
//
// WHAT IT IS NOT. This invents no new crypto scheme and no second source of
// truth. It records that an event happened, with these parameters, in this
// order, and that the log has not been silently edited since. It is not a
// zero-knowledge proof, not "blockchain", and not a claim that the event it
// records was correct. The hash chain is the same SHA-256 discipline every
// other ledger in js/provenance/ uses: canonical JSON over the fields the hash
// commits to, each entry carrying the previous entry's hash.
//
// WHY sha256Hex IS RESTATED HERE. js/provenance/provenance.js exports the same
// three-line function, and ai-touch-ledger.js imports it. This module cannot:
// it is inlined into canvas/index.html's single inline <script>, where ESM
// imports do not resolve, so a cross-module import would break the canvas
// surface. test/trust-ledger.test.mjs pins this copy against provenance.js's
// by digesting the same inputs through both, so the two cannot drift apart
// without a test failing.
//
// PURITY: no DOM, no network, no engine. Identical in the browser, the Tauri
// desktop webview, and headless Node tests.

export const TRUST_LEDGER_KIND = 'dataglow-trust-ledger';
export const TRUST_LEDGER_VERSION = 1;

// Mirrors GENESIS_PARENT in provenance.js and ai-touch-ledger.js so every
// hash-chained ledger in this codebase anchors identically.
export const GENESIS_PARENT = '0'.repeat(64);

// The closed vocabulary of what this ledger records. A kind outside this list
// is recorded as rejected rather than silently accepted, so the ledger cannot
// quietly become a general-purpose log.
export const TRUST_EVENT_KINDS = Object.freeze([
  'validation-run',
  'metric-contract-version',
  'export-attempt',
  'gate-verdict',
]);

// What each kind means in one line, for the panel header and the exports.
export const TRUST_EVENT_LABELS = Object.freeze({
  'validation-run': 'Validation run',
  'metric-contract-version': 'Metric definition version',
  'export-attempt': 'Export attempt',
  'gate-verdict': 'Gate verdict',
});

// The honest outcome vocabulary, shared with Publish-Safe's levels so a verdict
// does not get relabelled on its way into the ledger.
export const TRUST_OUTCOMES = Object.freeze(['clear', 'caution', 'blocked', 'recorded']);

export const TRUST_LEDGER_DISCLAIMER =
  'This is a Trust Ledger: a SHA-256 hash chain of the trust events this '
  + 'session produced, oldest first. Each row carries the hash of the row '
  + 'before it, so an entry that was edited or removed after the fact breaks '
  + 'the chain and is reported. It attests that these events happened, in this '
  + 'order, and that the log has not been silently altered. It does not certify '
  + 'that any recorded result was correct, and it is not a zero-knowledge proof.';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * SHA-256 of a string, lowercase hex. Behaviourally identical to
 * js/provenance/provenance.js's sha256Hex; see the header for why it is
 * restated rather than imported, and test/trust-ledger.test.mjs for the test
 * that pins the two together.
 */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Deterministic serialization of exactly the fields the hash commits to, so the
// same event always hashes identically regardless of key order. Same
// canonicalJSON discipline as verifiable-check-seal.js and ai-touch-ledger.js.
function canonicalEventPayload(parentHash, ev) {
  const fields = {
    actor: ev.actor ?? null,
    detail: isPlainObject(ev.detail) ? stableDetail(ev.detail) : null,
    kind: ev.kind ?? null,
    outcome: ev.outcome ?? null,
    parentHash,
    subject: ev.subject ?? null,
    summary: ev.summary ?? null,
    ts: ev.ts ?? null,
  };
  // Keys are written in sorted order above, and stableDetail sorts the nested
  // ones, so plain stringify is already canonical. Passing a key array as
  // JSON.stringify's replacer would look equivalent but is not: a replacer
  // array filters at every depth, so it would silently drop every detail key
  // and the hash would stop committing to the detail it displays.
  return JSON.stringify(fields);
}

// Details are free-form per kind, so they are flattened to sorted key/value
// pairs before hashing. Values are stringified: the hash commits to what the
// row displays, not to a nested object's shape.
function stableDetail(detail) {
  const out = {};
  for (const key of Object.keys(detail).sort()) {
    const v = detail[key];
    if (v === undefined) continue;
    out[key] = v === null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return out;
}

/**
 * Checks an event before it is allowed into the chain. Never throws: returns
 * { valid, reason } so a logging mistake cannot break the real work that was
 * being recorded.
 */
export function validateTrustEvent(ev) {
  if (!isPlainObject(ev)) {
    return { valid: false, reason: 'event must be a plain object' };
  }
  if (!TRUST_EVENT_KINDS.includes(ev.kind)) {
    return { valid: false, reason: `event.kind must be one of: ${TRUST_EVENT_KINDS.join(', ')}` };
  }
  if (typeof ev.summary !== 'string' || !ev.summary.trim()) {
    return { valid: false, reason: 'event.summary is required and must say what happened in plain language' };
  }
  if (ev.outcome !== undefined && !TRUST_OUTCOMES.includes(ev.outcome)) {
    return { valid: false, reason: `event.outcome must be one of: ${TRUST_OUTCOMES.join(', ')}` };
  }
  if (ev.detail !== undefined && !isPlainObject(ev.detail)) {
    return { valid: false, reason: 'event.detail must be a plain object when provided' };
  }
  return { valid: true, reason: null };
}

/**
 * A hash-chained, append-only ledger for one session. Plain data and closures,
 * no browser-only APIs beyond crypto.subtle, so it behaves identically in Node
 * tests. Same shape as createProvenanceChain() and createTouchLedger().
 */
export function createTrustLedger() {
  const chain = [];

  /**
   * Appends one event. NEVER throws and never silently drops: a malformed
   * event is appended as a clearly marked rejected row, because a log that can
   * lose entries on bad input defeats its own purpose.
   */
  async function record(ev) {
    const { valid, reason } = validateTrustEvent(ev);
    const parentHash = chain.length ? chain[chain.length - 1].hash : GENESIS_PARENT;
    const ts = isPlainObject(ev) && Number.isFinite(ev.ts) ? ev.ts : Date.now();

    if (!valid) {
      const rejected = {
        index: chain.length,
        rejected: true,
        reason,
        raw: ev,
        ts,
        parentHash,
      };
      rejected.hash = await sha256Hex(
        canonicalEventPayload(parentHash, { ...(isPlainObject(ev) ? ev : {}), ts }) + `|rejected:${reason}`,
      );
      chain.push(rejected);
      return rejected;
    }

    const entry = {
      index: chain.length,
      rejected: false,
      kind: ev.kind,
      subject: typeof ev.subject === 'string' && ev.subject.trim() ? ev.subject : null,
      summary: ev.summary,
      outcome: ev.outcome || 'recorded',
      actor: typeof ev.actor === 'string' && ev.actor.trim() ? ev.actor : 'you',
      detail: isPlainObject(ev.detail) ? { ...ev.detail } : {},
      ts,
      parentHash,
    };
    entry.hash = await sha256Hex(canonicalEventPayload(parentHash, entry));
    chain.push(entry);
    return entry;
  }

  return {
    record,
    getEntries: () => chain.slice(),
    clear: () => { chain.length = 0; },
    get size() { return chain.length; },
  };
}

/**
 * Re-derives every entry's hash from its recorded fields and confirms it still
 * matches, the same verifyProvenanceChain() discipline as provenance.js. Any
 * edit, reorder or deletion breaks the chain at the first altered link.
 */
export async function verifyTrustLedger(entries) {
  if (!Array.isArray(entries)) {
    return { valid: false, brokenAt: -1, reason: 'entries must be an array' };
  }
  if (entries.length === 0) {
    return { valid: true, brokenAt: -1, reason: 'Nothing recorded yet, so there is nothing to verify.' };
  }
  let parentHash = GENESIS_PARENT;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e.hash !== 'string' || e.parentHash !== parentHash) {
      return {
        valid: false,
        brokenAt: i,
        reason: `Row ${i + 1} does not follow from the row before it, so the ledger has been reordered, edited, or a row was removed.`,
      };
    }
    const expected = e.rejected
      ? await sha256Hex(canonicalEventPayload(parentHash, { ...(e.raw || {}), ts: e.ts }) + `|rejected:${e.reason}`)
      : await sha256Hex(canonicalEventPayload(parentHash, e));
    if (expected !== e.hash) {
      return {
        valid: false,
        brokenAt: i,
        reason: `Row ${i + 1} has been changed since it was recorded, so its contents no longer match its hash.`,
      };
    }
    parentHash = e.hash;
  }
  return {
    valid: true,
    brokenAt: -1,
    reason: `All ${entries.length} row${entries.length === 1 ? '' : 's'} verified. The chain is intact.`,
  };
}

/** UTC timestamp trimmed to the second, the format the ledger exports use. */
export function formatTrustTime(ts) {
  if (!Number.isFinite(ts)) return 'unknown time';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/**
 * One human-readable row. This is the string the panel shows and the text
 * export writes, so it stays plain: what happened, to what, and how it came
 * out. No em dash.
 */
export function describeTrustEntry(entry) {
  if (!isPlainObject(entry)) return 'Unreadable row.';
  if (entry.rejected) {
    return `${formatTrustTime(entry.ts)}: a row was refused because ${entry.reason || 'it was malformed'}. It is kept here so nothing is lost.`;
  }
  const label = TRUST_EVENT_LABELS[entry.kind] || entry.kind;
  const parts = [`${formatTrustTime(entry.ts)}: ${label}`];
  if (entry.subject) parts.push(`for ${entry.subject}`);
  let line = parts.join(' ') + '. ' + entry.summary;
  if (!/[.!?]$/.test(line)) line += '.';
  if (entry.outcome && entry.outcome !== 'recorded') line += ` Outcome: ${entry.outcome}.`;
  return line;
}

/** Plain-language one-liner for the panel header. */
export function summarizeTrustLedger(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 'No trust events recorded yet this session.';
  }
  const kept = entries.filter((e) => e && !e.rejected);
  const rejected = entries.length - kept.length;
  const blocked = kept.filter((e) => e.outcome === 'blocked').length;
  const caution = kept.filter((e) => e.outcome === 'caution').length;
  const parts = [`${entries.length} row${entries.length === 1 ? '' : 's'} recorded this session`];
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (caution > 0) parts.push(`${caution} needed care`);
  if (rejected > 0) parts.push(`${rejected} refused as malformed`);
  if (blocked === 0 && caution === 0 && rejected === 0) parts.push('nothing was blocked');
  return parts.join(', ') + '.';
}

/** Count of each kind present, for the panel and for tests. */
export function countTrustKinds(entries) {
  const out = {};
  for (const kind of TRUST_EVENT_KINDS) out[kind] = 0;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    if (e && !e.rejected && Object.prototype.hasOwnProperty.call(out, e.kind)) out[e.kind] += 1;
  }
  return out;
}

/**
 * Exports the ledger for download. Mirrors exportLedger()'s format contract in
 * assumption-ledger.js and exportTouchLedger()'s in ai-touch-ledger.js:
 * 'json' | 'markdown' | 'text'.
 */
export function exportTrustLedger(entries, format = 'json') {
  const rows = Array.isArray(entries) ? entries : [];
  const generatedAt = new Date().toISOString();
  if (format === 'json') {
    return JSON.stringify({
      kind: TRUST_LEDGER_KIND,
      version: TRUST_LEDGER_VERSION,
      generatedAt,
      disclaimer: TRUST_LEDGER_DISCLAIMER,
      entries: rows,
    }, null, 2);
  }
  if (format === 'markdown') {
    const lines = ['# DataGlow Trust Ledger', '', `Exported ${generatedAt}`, '', TRUST_LEDGER_DISCLAIMER, ''];
    if (rows.length === 0) {
      lines.push('No trust events recorded yet this session.');
    } else {
      lines.push('| Time (UTC) | Event | Subject | What happened | Outcome |', '| --- | --- | --- | --- | --- |');
      for (const e of rows) {
        if (e && e.rejected) {
          lines.push(`| ${formatTrustTime(e.ts)} | refused | | ${e.reason || 'malformed row'} | refused |`);
        } else if (e) {
          lines.push(`| ${formatTrustTime(e.ts)} | ${TRUST_EVENT_LABELS[e.kind] || e.kind} | ${e.subject || ''} | ${e.summary} | ${e.outcome} |`);
        }
      }
    }
    return lines.join('\n');
  }
  const lines = ['DataGlow Trust Ledger', `Exported ${generatedAt}`, '', summarizeTrustLedger(rows), ''];
  for (const e of rows) lines.push(describeTrustEntry(e));
  return lines.join('\n');
}

/* ------------------------------------------------------------------
   Composers: turn what an existing surface already produced into an
   event, so no caller has to invent ledger vocabulary of its own.
   ------------------------------------------------------------------ */

/**
 * A readiness gate verdict (js/gate/readiness-gate.js computeReadinessGate)
 * becomes a gate-verdict row. The gate's own passingSummary is deliberately
 * NOT reused: it contains an em dash, which product text here must not carry.
 */
export function fromReadinessGate(gateResult, opts = {}) {
  const g = isPlainObject(gateResult) ? gateResult : {};
  const failing = Array.isArray(g.failingLayers) ? g.failingLayers : [];
  const ready = g.agentConsumable === true;
  const summary = ready
    ? `Readiness passed with a score of ${g.score}/100 against a threshold of ${g.threshold}.`
    : `Readiness did not pass: score ${g.score}/100 against a threshold of ${g.threshold}`
      + (g.blockedByContract ? ', and a metric contract is broken' : '')
      + (failing.length > 0 ? `, with ${failing.length} check${failing.length === 1 ? '' : 's'} failing` : '')
      + '.';
  return {
    kind: 'gate-verdict',
    subject: opts.subject || 'this dataset',
    summary,
    outcome: ready ? 'clear' : 'blocked',
    actor: opts.actor || 'readiness gate',
    detail: {
      score: g.score,
      threshold: g.threshold,
      failingLayers: failing.map((f) => f && f.layer).filter(Boolean).join(', '),
      blockedByContract: !!g.blockedByContract,
    },
  };
}

/**
 * One recorded Metric Contract version (js/metrics/metric-contracts.js, the
 * entries MetricContractHistory.list() returns) becomes a
 * metric-contract-version row.
 */
export function fromContractVersion(version, opts = {}) {
  const v = isPlainObject(version) ? version : {};
  const snap = isPlainObject(v.snapshot) ? v.snapshot : {};
  const name = opts.metricName || snap.name || opts.metricId || 'a metric';
  const proposed = v.source === 'agent-proposed';
  return {
    kind: 'metric-contract-version',
    subject: name,
    summary: `Version ${v.version} of this definition was recorded`
      + (proposed ? ' after a human approved a proposed change' : ' by a human edit')
      + (v.reason ? `. Reason given: ${v.reason}` : '')
      + '.',
    outcome: 'recorded',
    actor: v.changedBy || 'you',
    ts: Number.isFinite(v.changedAt) ? v.changedAt : undefined,
    detail: {
      version: v.version,
      metricId: opts.metricId || null,
      source: v.source || 'human',
      expression: snap.expression || null,
    },
  };
}

/**
 * A Publish-Safe verdict (js/gate/publish-safe.js evaluatePublishSafe) becomes
 * an export-attempt row. The verdict's level is carried through unchanged so
 * the ledger cannot report an outcome softer than the gate reached.
 */
export function fromPublishSafe(verdict, opts = {}) {
  const v = isPlainObject(verdict) ? verdict : {};
  const level = TRUST_OUTCOMES.includes(v.level) ? v.level : 'caution';
  const what = opts.artifact || 'a file';
  const where = v.destination === 'off-device' ? 'somewhere off this device' : 'this device';
  const acted = opts.completed === true;
  return {
    kind: 'export-attempt',
    subject: what,
    summary: (acted ? 'Written to ' : 'Offered to write to ') + where + '. '
      + (v.headline || 'Publish-Safe reached no verdict.'),
    outcome: level,
    actor: opts.actor || 'you',
    detail: {
      destination: v.destination || 'this-device',
      completed: acted,
      phiFound: !!(v.checked && v.checked.phiFound),
      includedResults: opts.includedResults === undefined ? null : !!opts.includedResults,
      bytes: Number.isFinite(opts.bytes) ? opts.bytes : null,
    },
  };
}

export const DataGlowTrustLedger = {
  TRUST_LEDGER_KIND,
  TRUST_LEDGER_VERSION,
  TRUST_EVENT_KINDS,
  TRUST_EVENT_LABELS,
  TRUST_OUTCOMES,
  TRUST_LEDGER_DISCLAIMER,
  GENESIS_PARENT,
  sha256Hex,
  validateTrustEvent,
  createTrustLedger,
  verifyTrustLedger,
  formatTrustTime,
  describeTrustEntry,
  summarizeTrustLedger,
  countTrustKinds,
  exportTrustLedger,
  fromReadinessGate,
  fromContractVersion,
  fromPublishSafe,
};

// Same publication pattern as notebook-app-export.js: the canvas surface reads
// the namespace off window because its inlined copy has no module scope.
try {
  if (typeof window !== 'undefined') window.DataGlowTrustLedgerEngine = DataGlowTrustLedger;
} catch (_e) { /* no window in Node tests */ }
