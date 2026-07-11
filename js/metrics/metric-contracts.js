// ============================================================
// DATAGLOW — Metric Contracts, Batch 1: versioned data model (read-only)
// ============================================================
// WHY THIS EXISTS (the honesty gap it closes):
// js/metrics/metric-studio.js's MetricRegistry.update() replaces a metric's
// definition in place — the previous name/formula/filters/owner are simply
// gone. Across the data-quality research this project has done, the #1 named
// cause of dashboard distrust in real teams is not dirty data, it is
// CONFLICTING METRIC DEFINITIONS that quietly drift with no record of who
// changed what, when, or why. This module adds that record, without touching
// MetricRegistry's existing (already-tested) behaviour at all.
//
// WHAT IT IS: a thin, append-only version history sitting ALONGSIDE a metric
// record. Every call to recordVersion() appends an immutable, timestamped
// snapshot of the metric's definition fields; nothing already stored is ever
// edited or deleted. diffVersions() compares any two snapshots field-by-field
// and returns a plain, structured list of what changed.
//
// WHAT IT DELIBERATELY DOES NOT DO YET (future batches, not this one):
//   - It does not touch MetricRegistry or metric-studio.js at all.
//   - It has no UI yet (Batch 2: diff view).
//   - It has no AI-agent write path yet (Batch 3: confirm gate). No agent of
//     any kind can call recordVersion() through this module today — only
//     whatever human-driven code a future batch wires up will.
//   - It ships behind the `metricContracts` flag (added this PR, OFF by
//     default) once wired into the UI in a later batch; right now, being pure
//     logic with no caller, it is inert regardless of the flag.
//
// Identity split, same pattern as metric-studio.js:
//   1. Pure logic (this whole file, currently) — Node-testable, no DOM/network.
//   2. DOM presenter — added in Batch 2 as a new exported render function in
//      this same file, gated behind the flag by the caller in main.js.

const CONTRACT_FIELDS = ['name', 'plainEnglish', 'expression', 'owner', 'tag'];

/**
 * Take an immutable snapshot of the contract-relevant fields of a metric
 * definition. Only the fields a "definition" actually consists of are kept —
 * runtime fields like computedValue/computedAt/status live on the metric
 * record itself and are NOT part of the contract (a metric can be recomputed
 * or recertified without that being a definition change).
 * @param {object} metric a metric-studio record (or metric-shaped candidate)
 * @returns {object} plain snapshot of just the contract fields
 */
export function snapshotDefinition(metric) {
  const snap = {};
  for (const f of CONTRACT_FIELDS) snap[f] = (metric && metric[f] != null) ? metric[f] : '';
  return snap;
}

/**
 * An append-only version history for one metric's definition. Holds a plain
 * array of immutable version entries; nothing is ever mutated or removed once
 * appended — this IS the audit trail, so the array itself is the source of
 * truth, not a side effect of one.
 */
export class MetricContractHistory {
  constructor(metricId) {
    this.metricId = metricId;
    this._versions = []; // [{version, snapshot, changedAt, changedBy, reason, source}]
  }

  get length() { return this._versions.length; }

  /** All versions, oldest first. Returns a copy — callers cannot mutate history via this. */
  list() { return this._versions.map(v => ({ ...v, snapshot: { ...v.snapshot } })); }

  /** The most recent version, or null if none recorded yet. */
  latest() {
    if (this._versions.length === 0) return null;
    const v = this._versions[this._versions.length - 1];
    return { ...v, snapshot: { ...v.snapshot } };
  }

  /** Look up one version by its 1-based version number. */
  get(versionNumber) {
    const v = this._versions.find(v => v.version === versionNumber);
    return v ? { ...v, snapshot: { ...v.snapshot } } : null;
  }

  /**
   * Append a new version snapshot. This is the ONLY way an entry is added —
   * there is deliberately no update()/remove() on this class. `changedBy` and
   * `reason` are honest metadata, not enforced strings: an empty reason is
   * recorded as empty, never invented.
   * @param {object} metric the metric definition to snapshot
   * @param {{changedBy?:string, reason?:string, source?:'human'|'agent-proposed'}} meta
   * @returns {object} the appended version entry (a copy)
   */
  recordVersion(metric, meta = {}) {
    const snapshot = snapshotDefinition(metric);
    const entry = {
      version: this._versions.length + 1,
      snapshot,
      changedAt: Date.now(),
      changedBy: meta.changedBy || 'unknown',
      reason: meta.reason || '',
      source: meta.source === 'agent-proposed' ? 'agent-proposed' : 'human',
    };
    this._versions.push(entry);
    return { ...entry, snapshot: { ...entry.snapshot } };
  }

  /** The exportable local-only JSON payload (parsed object, not a string). */
  toJSON() {
    return { kind: 'dataglow-metric-contract-history', version: 1, metricId: this.metricId, versions: this.list() };
  }

  /** Rebuild a history from a toJSON() payload. */
  static fromJSON(payload) {
    const h = new MetricContractHistory(payload && payload.metricId);
    const arr = (payload && Array.isArray(payload.versions)) ? payload.versions : [];
    for (const v of arr) {
      if (v && v.snapshot) h._versions.push({ ...v, snapshot: { ...v.snapshot } });
    }
    return h;
  }
}

/**
 * A registry of MetricContractHistory objects keyed by metric id — the
 * append-only counterpart to metric-studio's MetricRegistry, kept as a
 * SEPARATE object on purpose so metric-studio.js needs zero code changes to
 * coexist with it. A caller that wants contracts wires the two together (a
 * later batch); this batch only proves the data model itself is correct.
 */
export class MetricContractRegistry {
  constructor() {
    this._histories = new Map(); // metricId -> MetricContractHistory
  }

  get size() { return this._histories.size; }
  has(metricId) { return this._histories.has(metricId); }

  /** Get (creating if absent) the history for a metric id. */
  historyFor(metricId) {
    if (!this._histories.has(metricId)) this._histories.set(metricId, new MetricContractHistory(metricId));
    return this._histories.get(metricId);
  }

  /** Convenience: snapshot + append in one call. Returns the appended version entry. */
  recordVersion(metricId, metric, meta = {}) {
    return this.historyFor(metricId).recordVersion(metric, meta);
  }

  toJSON() {
    return {
      kind: 'dataglow-metric-contract-registry',
      version: 1,
      histories: [...this._histories.values()].map(h => h.toJSON()),
    };
  }

  static fromJSON(payload) {
    const reg = new MetricContractRegistry();
    const arr = (payload && Array.isArray(payload.histories)) ? payload.histories : [];
    for (const h of arr) {
      if (h && h.metricId != null) reg._histories.set(h.metricId, MetricContractHistory.fromJSON(h));
    }
    return reg;
  }
}

/**
 * Compare two contract snapshots field-by-field. Pure, no history/registry
 * needed — this is what Batch 2's diff view and Batch 3's confirm-gate both
 * render, so it is the one place "what changed" is computed.
 * @param {object} before a snapshot (or metric; extra fields are ignored)
 * @param {object} after a snapshot (or metric; extra fields are ignored)
 * @returns {{changed:boolean, fields:Array<{field:string, before:string, after:string}>}}
 */
export function diffVersions(before, after) {
  const b = snapshotDefinition(before || {});
  const a = snapshotDefinition(after || {});
  const fields = [];
  for (const f of CONTRACT_FIELDS) {
    if (String(b[f]) !== String(a[f])) {
      fields.push({ field: f, before: b[f], after: a[f] });
    }
  }
  return { changed: fields.length > 0, fields };
}

/**
 * Human-readable one-line summary of a diff, e.g. "expression changed" or
 * "name, owner changed" or "no changes". Used by the Batch 2 diff view and
 * anywhere a compact label is needed (e.g. a list row).
 * @param {{changed:boolean, fields:Array<{field:string}>}} diff
 * @returns {string}
 */
export function summarizeDiff(diff) {
  if (!diff || !diff.changed || diff.fields.length === 0) return 'no changes';
  return `${diff.fields.map(f => f.field).join(', ')} changed`;
}

export { CONTRACT_FIELDS };
