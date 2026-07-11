// ============================================================
// DATAGLOW — Cell-level Data Blame (transform history)
// ============================================================
// "Who/what changed this cell, and why?" — the git-blame equivalent for a
// dataset. Every cleaning / validation / merge transform the user applies is
// already recorded, in order, on the tamper-evident provenance chain of custody
// (js/provenance/provenance.js). Data Blame is a pure READER over that chain: it
// does NOT keep a second parallel log (which would drift), it re-projects the
// existing append-only, hash-linked trail into a per-column / per-cell history.
//
// The one thing it standardizes is the shape of a transform step's `detail`
// field, so the projection is reliable: call sites record cleaning ops with
// `buildBlameDetail(...)` (which older sites can adopt incrementally — the reader
// stays back-compatible with the pre-existing `{ fixType, column }` detail).
//
// Everything here is pure, synchronous, browser-free and network-free: it only
// walks an array of provenance steps that was produced elsewhere.

// Build the normalized `detail` object stored on a provenance step for a data
// transform. Pass this as the `detail` argument to `recordStep`/`chain.append`.
//   buildBlameDetail({ rule, columns|column, affectedCount, predicate, before, after, note })
export function buildBlameDetail({ rule = null, columns = null, column = null,
  affectedCount = null, predicate = null, before, after, note } = {}) {
  const cols = Array.isArray(columns)
    ? columns.filter(c => c != null).map(String)
    : (column != null ? [String(column)] : []);
  const detail = {
    rule: rule != null ? String(rule) : null,
    columns: cols,
    affected: { count: affectedCount != null ? affectedCount : null, predicate: predicate != null ? String(predicate) : null },
  };
  if (before !== undefined) detail.before = before;
  if (after !== undefined) detail.after = after;
  if (note !== undefined) detail.note = note;
  return detail;
}

// Project one raw provenance step into a normalized blame entry. Understands
// both the current `buildBlameDetail` shape and the legacy `{ fixType, column }`
// detail that predates this module, so no historical trail is misread.
export function normalizeBlameEntry(step) {
  const d = step && step.detail && typeof step.detail === 'object' ? step.detail : {};
  let columns = [];
  let rule = null;
  let affectedCount = null;
  let predicate = null;

  if (Array.isArray(d.columns)) {
    columns = d.columns.filter(c => c != null).map(String);
  } else if (d.column != null) {
    columns = [String(d.column)];
  }
  if (d.rule != null) rule = String(d.rule);
  else if (d.fixType != null) rule = String(d.fixType); // legacy call sites

  if (d.affected && typeof d.affected === 'object') {
    if (d.affected.count != null) affectedCount = d.affected.count;
    if (d.affected.predicate != null) predicate = String(d.affected.predicate);
  }

  return {
    index: step ? step.index : null,
    op: step ? step.op : null,
    description: step ? step.description : '',
    ts: step ? step.ts : null,
    hash: step ? step.hash : null,
    columns,
    rule,
    affectedCount,
    predicate,
    before: d.before,
    after: d.after,
    note: d.note,
  };
}

// Normalize a whole trail (array of provenance steps) into ordered blame entries.
function normalizeTrail(trail) {
  const steps = Array.isArray(trail) ? trail : [];
  return steps
    .map(normalizeBlameEntry)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

// Build a per-column index of transforms plus the flat ordered entry list.
// `byColumn` only contains columns that were actually changed by some step.
export function buildBlameIndex(trail) {
  const entries = normalizeTrail(trail);
  const byColumn = {};
  for (const e of entries) {
    for (const col of e.columns) {
      (byColumn[col] || (byColumn[col] = [])).push(e);
    }
  }
  return { entries, byColumn };
}

// Ordered history of every transform that touched a given column.
export function blameForColumn(trail, column) {
  if (column == null) return [];
  const key = String(column);
  return normalizeTrail(trail).filter(e => e.columns.includes(key));
}

// History for a specific cell. Because DuckDB transforms are set-based
// (`UPDATE ... WHERE`), the honest answer for a cell is "every transform that
// touched this column, each of which MAY have changed this cell". Callers that
// can evaluate a recorded predicate against a concrete row pass a `match`
// function to narrow the list to the transforms that plausibly hit the cell.
export function blameForCell(trail, column, match = null) {
  const hist = blameForColumn(trail, column);
  if (typeof match !== 'function') return hist;
  return hist.filter(e => {
    try { return !!match(e); } catch { return true; }
  });
}

// The full ordered, append-only, replayable transform history — one entry per
// provenance step, nothing collapsed or dropped.
export function replayLog(trail) {
  return normalizeTrail(trail).map(e => ({
    index: e.index,
    op: e.op,
    rule: e.rule,
    columns: e.columns,
    affectedCount: e.affectedCount,
    predicate: e.predicate,
    ts: e.ts,
    description: e.description,
    hash: e.hash,
  }));
}

// A plain-language one-liner for a column's change history.
export function summarizeColumnBlame(trail, column) {
  const hist = blameForColumn(trail, column);
  const col = column != null ? String(column) : '(unnamed)';
  if (hist.length === 0) return `"${col}": no recorded changes.`;
  const n = hist.length;
  const rules = hist.map(e => e.rule || e.op).filter(Boolean);
  const affected = hist.reduce((sum, e) => sum + (typeof e.affectedCount === 'number' ? e.affectedCount : 0), 0);
  const affPart = affected > 0 ? `, ${affected} cell(s) affected in total` : '';
  return `"${col}": ${n} recorded change${n === 1 ? '' : 's'}${rules.length ? ` (${rules.join(' → ')})` : ''}${affPart}.`;
}
