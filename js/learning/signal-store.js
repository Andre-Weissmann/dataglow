// ============================================================
// DATAGLOW — Unified Signal Layer (shared in-memory signal store)
// ============================================================
// DATAGLOW's on-device analysis modules — the self-learning validation ranker,
// the predictive (kNN/Gower) anomaly scorer, the adaptive layer prioritizer, and
// the forecast-based drift alerter — each compute their own signal in isolation
// and render it straight to the UI. In silos they can talk past each other: the
// anomaly scorer can flag a row the ranker has already learned the user always
// dismisses, or the drift alerter can warn about a column whose validation rule
// the user just turned off, with no acknowledgement of the connection.
//
// This module is the lightweight coordination point that lets those modules read
// each other's conclusions BEFORE anything is rendered. It is deliberately:
//   • synchronous + in-memory (no IndexedDB, no DOM, no async) — a shared scratch
//     pad for one analysis pass, not a persistence layer;
//   • dependency-free and framework-free, so it unit-tests in plain Node exactly
//     like the sibling detection modules;
//   • purely ADDITIVE — it stores and answers questions. It never runs a model,
//     never changes any module's statistics, and a module that ignores it behaves
//     exactly as it did before.
//
// A signal is keyed by ROW (a stable row index / fingerprint) and/or COLUMN name.
// Producers `register(...)` signals; consumers `query(...)` / use the convenience
// lookups (`dismissalVerdict`, `recentRuleChange`) to ask "has another module
// already spoken for this row/column, and with what verdict/confidence?".
// ============================================================

// The signal vocabulary shared across modules. Kept small and explicit so a new
// producer/consumer pair has one obvious place to agree on a name.
export const SIGNAL_TYPES = {
  // The self-learning ranker's learned, per-column verdict ("the user has
  // repeatedly dismissed flags on this column as false positives", or accepted
  // them as real). Consumed by the anomaly scorer to suppress/de-rank duplicates.
  LEARNED_VERDICT: 'learned_verdict',
  // A validation rule affecting a column was recently disabled/changed by the
  // user (e.g. they dismissed/rejected its flag). Consumed by the drift alerter
  // to explain an otherwise-mysterious drift warning on that column.
  RULE_CHANGE: 'rule_change',
};

// A verdict leans one way or the other; kept as plain strings for readability.
export const VERDICTS = { DISMISS: 'dismiss', ACCEPT: 'accept' };

function nkey(v) {
  return v == null ? null : String(v);
}

export class SignalStore {
  constructor() {
    this._signals = [];               // insertion-ordered list of every signal
    this._byRow = new Map();          // rowKey -> [signal, ...]
    this._byColumn = new Map();       // columnKey -> [signal, ...]
    this._seq = 0;
  }

  // Register one signal. `module` (producer name) and `type` are required by
  // convention; `row` and/or `column` provide the key(s). `verdict`, `confidence`,
  // `value` and `meta` are free-form payload. Returns the stored signal (with a
  // monotonic `seq` and, if absent, an `at` timestamp) so callers can chain.
  register(signal = {}) {
    const row = nkey(signal.row);
    const column = nkey(signal.column);
    const stored = {
      module: signal.module ?? null,
      type: signal.type ?? null,
      row,
      column,
      verdict: signal.verdict ?? null,
      confidence: signal.confidence == null ? null : Number(signal.confidence),
      value: signal.value === undefined ? null : signal.value,
      meta: signal.meta ?? null,
      at: signal.at == null ? Date.now() : signal.at,
      seq: this._seq++,
    };
    this._signals.push(stored);
    if (row != null) {
      if (!this._byRow.has(row)) this._byRow.set(row, []);
      this._byRow.get(row).push(stored);
    }
    if (column != null) {
      if (!this._byColumn.has(column)) this._byColumn.set(column, []);
      this._byColumn.get(column).push(stored);
    }
    return stored;
  }

  // Every signal registered against a given row key (never null-safe surprises:
  // an unknown row returns an empty array).
  signalsForRow(row) {
    return (this._byRow.get(nkey(row)) || []).slice();
  }

  // Every signal registered against a given column name.
  signalsForColumn(column) {
    return (this._byColumn.get(nkey(column)) || []).slice();
  }

  // General filter. Any subset of { row, column, type, module, verdict } narrows
  // the result; omitted fields are wildcards. Newest-first so "the most recent
  // signal about X" is simply query(...)[0].
  query(filter = {}) {
    const row = filter.row === undefined ? undefined : nkey(filter.row);
    const column = filter.column === undefined ? undefined : nkey(filter.column);
    // Start from the narrowest available index to keep this cheap.
    let pool;
    if (row !== undefined && row != null) pool = this._byRow.get(row) || [];
    else if (column !== undefined && column != null) pool = this._byColumn.get(column) || [];
    else pool = this._signals;
    const out = pool.filter(s =>
      (row === undefined || s.row === row) &&
      (column === undefined || s.column === column) &&
      (filter.type === undefined || s.type === filter.type) &&
      (filter.module === undefined || s.module === filter.module) &&
      (filter.verdict === undefined || s.verdict === filter.verdict)
    );
    return out.sort((a, b) => b.at - a.at || b.seq - a.seq);
  }

  // Convenience: does another module already carry a DISMISS learned-verdict for
  // this column? Returns that signal (highest-confidence, then most recent) or
  // null. This is the exact question the anomaly scorer asks before flagging a row.
  dismissalVerdict(column) {
    const hits = this.query({ column, type: SIGNAL_TYPES.LEARNED_VERDICT, verdict: VERDICTS.DISMISS });
    if (!hits.length) return null;
    hits.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || b.at - a.at || b.seq - a.seq);
    return hits[0];
  }

  // Convenience: the most recent rule-change signal on a column, if any. This is
  // the question the drift alerter asks before showing an isolated drift warning.
  recentRuleChange(column) {
    const hits = this.query({ column, type: SIGNAL_TYPES.RULE_CHANGE });
    return hits.length ? hits[0] : null;
  }

  // Total registered signals (handy in tests/UI).
  get size() {
    return this._signals.length;
  }

  // Remove signals. With no argument, wipes everything. With a predicate
  // (signal -> boolean), removes only matching signals — used to re-publish a
  // freshly recomputed set (e.g. the ranker's per-column verdicts each run)
  // without discarding session-lived signals (e.g. accumulated rule changes).
  clear(predicate) {
    if (typeof predicate !== 'function') {
      this._signals = [];
      this._byRow.clear();
      this._byColumn.clear();
      return;
    }
    const keep = s => !predicate(s);
    this._signals = this._signals.filter(keep);
    for (const [k, arr] of this._byRow) {
      const f = arr.filter(keep);
      if (f.length) this._byRow.set(k, f); else this._byRow.delete(k);
    }
    for (const [k, arr] of this._byColumn) {
      const f = arr.filter(keep);
      if (f.length) this._byColumn.set(k, f); else this._byColumn.delete(k);
    }
  }
}
