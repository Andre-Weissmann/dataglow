// ============================================================
// DataGlow Phase 10 — Data Version Control: Diff Engine
// ============================================================
// Compares two snapshots and produces a structured diff report:
//
//   Schema diff  — columns added, removed, or type-changed
//   Stats diff   — per-column: rowCount delta, null rate change,
//                  distinct count change, mean shift, range shift
//   Overall risk — BREAKING | WARN | OK
//
// All inputs are Snapshot objects from dvc-store.js.
// No row data is ever accessed here.
//
// Usage:
//   import { diffSnapshots, summarizeDiff } from './dvc-diff.js';
//   const diff = diffSnapshots(snapA, snapB);
//   const summary = summarizeDiff(diff);
// ============================================================

// ---- Risk levels ----
export const RISK = {
  OK: 'ok',
  WARN: 'warn',
  BREAKING: 'breaking',
};

// ---- Change type labels ----
export const SCHEMA_CHANGE = {
  ADDED: 'added',
  REMOVED: 'removed',
  TYPE_CHANGED: 'type_changed',
  UNCHANGED: 'unchanged',
};

// ============================================================
// Schema Diff
// ============================================================

/**
 * Compare column schemas between two snapshots.
 * @param {import('./dvc-store.js').Snapshot} before
 * @param {import('./dvc-store.js').Snapshot} after
 * @returns {SchemaDiff}
 */
export function diffSchema(before, after) {
  const beforeMap = new Map(before.cols.map(c => [c.name, c]));
  const afterMap = new Map(after.cols.map(c => [c.name, c]));

  const added = [];
  const removed = [];
  const typeChanged = [];
  const unchanged = [];

  // Check for removed or type-changed columns
  for (const [name, bCol] of beforeMap) {
    if (!afterMap.has(name)) {
      removed.push({ name, col: bCol });
    } else {
      const aCol = afterMap.get(name);
      if (bCol.type !== aCol.type) {
        typeChanged.push({ name, before: bCol.type, after: aCol.type, rawBefore: bCol.rawType, rawAfter: aCol.rawType });
      } else {
        unchanged.push(name);
      }
    }
  }

  // Check for added columns
  for (const [name, aCol] of afterMap) {
    if (!beforeMap.has(name)) {
      added.push({ name, col: aCol });
    }
  }

  const risk = removed.length > 0 || typeChanged.length > 0
    ? RISK.BREAKING
    : added.length > 0
      ? RISK.WARN
      : RISK.OK;

  return { added, removed, typeChanged, unchanged, risk };
}

// ============================================================
// Statistical Diff — per column
// ============================================================

/**
 * @typedef {Object} ColDiff
 * @property {string} name
 * @property {string} type
 * @property {number} nullDelta        - after.nullCount - before.nullCount (abs)
 * @property {number} nullRateBefore   - 0..1
 * @property {number} nullRateAfter    - 0..1
 * @property {number} nullRateDelta    - after - before (signed)
 * @property {number} distinctDelta    - after.distinctCount - before.distinctCount
 * @property {number|null} meanDelta   - numeric cols only
 * @property {number|null} minDelta
 * @property {number|null} maxDelta
 * @property {string} risk             - RISK.*
 * @property {string[]} flags          - human-readable flag messages
 */

/**
 * Compute diff between two ColStats objects.
 * @param {import('./dvc-store.js').ColStats} before
 * @param {import('./dvc-store.js').ColStats} after
 * @param {number} rowsBefore
 * @param {number} rowsAfter
 * @returns {ColDiff}
 */
export function diffCol(before, after, rowsBefore, rowsAfter) {
  const flags = [];

  const nullRateBefore = rowsBefore > 0 ? before.nullCount / rowsBefore : 0;
  const nullRateAfter = rowsAfter > 0 ? after.nullCount / rowsAfter : 0;
  const nullRateDelta = nullRateAfter - nullRateBefore;

  const nullDelta = after.nullCount - before.nullCount;
  const distinctDelta = after.distinctCount - before.distinctCount;

  let meanDelta = null, minDelta = null, maxDelta = null;

  if (before.type === 'number' && after.type === 'number') {
    if (before.mean !== null && after.mean !== null) {
      meanDelta = Math.round((after.mean - before.mean) * 10000) / 10000;
    }
    if (before.min !== null && after.min !== null) {
      minDelta = Math.round((after.min - before.min) * 10000) / 10000;
    }
    if (before.max !== null && after.max !== null) {
      maxDelta = Math.round((after.max - before.max) * 10000) / 10000;
    }
  }

  // Risk assessment
  let risk = RISK.OK;

  // Null rate jumped by > 5% — warn
  if (nullRateDelta > 0.05) {
    flags.push('Null rate increased by ' + pct(nullRateDelta) + ' — possible data quality issue');
    risk = RISK.WARN;
  }
  // Null rate jumped by > 20% — breaking
  if (nullRateDelta > 0.2) {
    flags.push('Null rate increased by ' + pct(nullRateDelta) + ' — likely data loss or join failure');
    risk = RISK.BREAKING;
  }
  // Null rate decreased significantly — data was filled in (good, but notable)
  if (nullRateDelta < -0.05) {
    flags.push('Null rate decreased by ' + pct(-nullRateDelta) + ' — data filled in or source changed');
    if (risk === RISK.OK) risk = RISK.WARN;
  }

  // Distinct count dropped to 1 — possible constant injection / data corruption
  if (after.distinctCount === 1 && before.distinctCount > 1) {
    flags.push('All values became identical (distinctCount = 1) — possible data corruption');
    risk = RISK.BREAKING;
  }
  // Distinct count went to 0 — all nulls
  if (after.distinctCount === 0 && before.distinctCount > 0) {
    flags.push('Column became entirely null — data loss');
    risk = RISK.BREAKING;
  }

  // Mean shifted by > 20% relative — warn
  if (meanDelta !== null && before.mean !== null && before.mean !== 0) {
    const relShift = Math.abs(meanDelta / before.mean);
    if (relShift > 0.2) {
      flags.push('Mean shifted ' + pct(relShift) + ' (' + fmt(before.mean) + ' -> ' + fmt(after.mean) + ')');
      if (risk === RISK.OK) risk = RISK.WARN;
    }
    if (relShift > 0.5) {
      risk = RISK.BREAKING;
    }
  }

  return {
    name: before.name,
    type: before.type,
    nullDelta,
    nullRateBefore: Math.round(nullRateBefore * 10000) / 10000,
    nullRateAfter: Math.round(nullRateAfter * 10000) / 10000,
    nullRateDelta: Math.round(nullRateDelta * 10000) / 10000,
    distinctDelta,
    meanDelta,
    minDelta,
    maxDelta,
    risk,
    flags,
  };
}

// ============================================================
// Full Snapshot Diff
// ============================================================

/**
 * @typedef {Object} SnapshotDiff
 * @property {string} beforeId
 * @property {string} afterId
 * @property {string} beforeLabel
 * @property {string} afterLabel
 * @property {string} datasetName
 * @property {number} rowCountBefore
 * @property {number} rowCountAfter
 * @property {number} rowCountDelta
 * @property {number} rowCountPct         - signed % change
 * @property {Object} schema              - SchemaDiff
 * @property {ColDiff[]} colDiffs         - diffs for columns present in both
 * @property {string} overallRisk         - RISK.*
 * @property {string[]} summary           - human-readable top-level findings
 */

/**
 * Compare two snapshots and produce a full diff report.
 * @param {import('./dvc-store.js').Snapshot} before
 * @param {import('./dvc-store.js').Snapshot} after
 * @returns {SnapshotDiff}
 */
export function diffSnapshots(before, after) {
  if (!before || !after) throw new Error('diffSnapshots: both before and after are required');

  const schema = diffSchema(before, after);

  // Only diff columns present in both snapshots
  const beforeMap = new Map(before.cols.map(c => [c.name, c]));
  const afterMap = new Map(after.cols.map(c => [c.name, c]));
  const sharedNames = before.cols.map(c => c.name).filter(n => afterMap.has(n));

  const colDiffs = sharedNames.map(name =>
    diffCol(beforeMap.get(name), afterMap.get(name), before.rowCount, after.rowCount)
  );

  const rowCountDelta = after.rowCount - before.rowCount;
  const rowCountPct = before.rowCount > 0
    ? Math.round((rowCountDelta / before.rowCount) * 10000) / 100
    : null;

  // Roll up overall risk
  let overallRisk = schema.risk;
  for (const cd of colDiffs) {
    if (cd.risk === RISK.BREAKING) { overallRisk = RISK.BREAKING; break; }
    if (cd.risk === RISK.WARN && overallRisk === RISK.OK) overallRisk = RISK.WARN;
  }

  // Human summary
  const summary = [];

  if (rowCountDelta !== 0) {
    const dir = rowCountDelta > 0 ? '+' : '';
    summary.push('Row count: ' + before.rowCount.toLocaleString() + ' -> ' + after.rowCount.toLocaleString() +
      ' (' + dir + rowCountDelta.toLocaleString() + (rowCountPct !== null ? ', ' + dir + rowCountPct + '%' : '') + ')');
  } else {
    summary.push('Row count unchanged: ' + after.rowCount.toLocaleString());
  }

  if (schema.added.length > 0)     summary.push(schema.added.length + ' column(s) added: ' + schema.added.map(c => c.name).join(', '));
  if (schema.removed.length > 0)   summary.push(schema.removed.length + ' column(s) removed: ' + schema.removed.map(c => c.name).join(', '));
  if (schema.typeChanged.length > 0) {
    for (const tc of schema.typeChanged) {
      summary.push('Type changed: ' + tc.name + ' (' + tc.before + ' -> ' + tc.after + ')');
    }
  }

  const flagged = colDiffs.filter(cd => cd.flags.length > 0);
  for (const cd of flagged) {
    for (const f of cd.flags) {
      summary.push('[' + cd.name + '] ' + f);
    }
  }

  if (summary.length === 1 && overallRisk === RISK.OK) {
    summary.push('No significant changes detected.');
  }

  return {
    beforeId: before.id,
    afterId: after.id,
    beforeLabel: before.label,
    afterLabel: after.label,
    datasetName: before.datasetName,
    rowCountBefore: before.rowCount,
    rowCountAfter: after.rowCount,
    rowCountDelta,
    rowCountPct,
    schema,
    colDiffs,
    overallRisk,
    summary,
  };
}

// ============================================================
// Human-readable summary helpers
// ============================================================

/**
 * Produce a compact text summary of a diff (for toasts / notifications).
 * @param {SnapshotDiff} diff
 * @returns {string}
 */
export function summarizeDiff(diff) {
  const riskLabel = { ok: 'OK', warn: 'Warning', breaking: 'Breaking' }[diff.overallRisk] || diff.overallRisk;
  const lines = ['[' + riskLabel + '] ' + diff.datasetName + ': ' + diff.beforeLabel + ' -> ' + diff.afterLabel];
  for (const s of diff.summary) lines.push('  ' + s);
  return lines.join('\n');
}

/**
 * Build an HTML fragment for the diff — used by dvc-ui.js.
 * @param {SnapshotDiff} diff
 * @returns {string} HTML string
 */
export function diffToHTML(diff) {
  const riskColors = { ok: '#437A22', warn: '#964219', breaking: '#A12C7B' };
  const riskLabels = { ok: 'No Issues', warn: 'Warning', breaking: 'Breaking Changes' };
  const rc = riskColors[diff.overallRisk] || '#7A7974';
  const rl = riskLabels[diff.overallRisk] || diff.overallRisk;

  const rowDeltaStr = diff.rowCountDelta === 0
    ? '<span style="color:#7A7974">no change</span>'
    : (diff.rowCountDelta > 0 ? '<span style="color:#437A22">+' : '<span style="color:#A12C7B">') +
      diff.rowCountDelta.toLocaleString() + (diff.rowCountPct !== null ? ' (' + (diff.rowCountDelta > 0 ? '+' : '') + diff.rowCountPct + '%)' : '') + '</span>';

  let schemaHTML = '';
  if (diff.schema.added.length + diff.schema.removed.length + diff.schema.typeChanged.length > 0) {
    schemaHTML = '<div class="dvc-schema-changes">' +
      diff.schema.added.map(c => '<div class="dvc-change dvc-added">+ ' + esc(c.name) + ' <span class="dvc-type">' + esc(c.col.rawType) + '</span></div>').join('') +
      diff.schema.removed.map(c => '<div class="dvc-change dvc-removed">- ' + esc(c.name) + ' <span class="dvc-type">' + esc(c.col.rawType) + '</span></div>').join('') +
      diff.schema.typeChanged.map(tc => '<div class="dvc-change dvc-type-changed">~ ' + esc(tc.name) + ': <span class="dvc-type">' + esc(tc.before) + '</span> -> <span class="dvc-type">' + esc(tc.after) + '</span></div>').join('') +
      '</div>';
  }

  const flaggedCols = diff.colDiffs.filter(cd => cd.flags.length > 0);
  let statsHTML = '';
  if (flaggedCols.length > 0) {
    statsHTML = '<div class="dvc-stat-flags">' +
      flaggedCols.map(cd =>
        '<div class="dvc-col-flag dvc-risk-' + cd.risk + '">' +
        '<span class="dvc-col-name">' + esc(cd.name) + '</span>' +
        cd.flags.map(f => '<div class="dvc-flag-msg">' + esc(f) + '</div>').join('') +
        '</div>'
      ).join('') +
      '</div>';
  }

  return [
    '<div class="dvc-diff-report">',
    '  <div class="dvc-diff-header">',
    '    <span class="dvc-risk-badge" style="background:' + rc + '">' + rl + '</span>',
    '    <span class="dvc-diff-title">' + esc(diff.beforeLabel) + ' <span class="dvc-arrow">&#8594;</span> ' + esc(diff.afterLabel) + '</span>',
    '  </div>',
    '  <div class="dvc-diff-rows">Rows: ' + diff.rowCountBefore.toLocaleString() + ' -> ' + diff.rowCountAfter.toLocaleString() + ' ' + rowDeltaStr + '</div>',
    schemaHTML,
    statsHTML,
    diff.summary.length === 0 ? '<div class="dvc-ok">No issues detected.</div>' : '',
    '</div>',
  ].join('\n');
}

// ============================================================
// Internal helpers
// ============================================================
function pct(ratio) { return Math.round(ratio * 1000) / 10 + '%'; }
function fmt(n) { return n === null ? 'null' : (Math.round(n * 100) / 100).toLocaleString(); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
