// ============================================================
// DATAGLOW - Metric Contract Status (pure engine)
// ============================================================
// WHY THIS EXISTS
// js/metrics/metric-contracts.js records an append-only version history per
// metric definition, and js/app-shell/main.js appends to it whenever a human
// saves a definition in Metric Studio. js/metrics/metric-contract-diff-view.js
// shows that history, and metric-contract-confirm-gate.js keeps a proposed
// change behind a human Approve/Reject. All of that already ships and is
// tested.
//
// What nothing did was ASK the resulting question. js/gate/readiness-gate.js
// takes a `metricContractStatus` argument as its second parameter and refuses
// to call a dataset agent-consumable when that status says a contract is
// broken. Nothing in the running app produced that object, so the check was
// wired and permanently fed null: the gate had a contract input it never
// received, and a metric whose live definition had drifted away from its own
// recorded latest version passed readiness silently.
//
// This module produces that object, and defines "broken" the only way the data
// model can honestly support it: the definition the app is using right now no
// longer matches the latest version recorded in the metric's own history. That
// is drift away from the agreed contract, and it is exactly the failure mode
// metric-contracts.js was written to expose.
//
// HOW REACHABLE IS DRIFT TODAY, honestly. Every human save path in Metric
// Studio currently calls onDefinitionSaved, so a definition edited through the
// UI records its version in the same breath and cannot drift. So today this
// mostly turns "contracts were not checked" into "every contracted definition
// still matches", which is a different and more useful sentence. It becomes a
// real alarm the moment any writer reaches MetricRegistry.update() without
// recording a version: an approved agent proposal applied through the confirm
// gate, an import, or a new surface that forgets the hook. The test suite pins
// that case rather than assuming it stays hypothetical.
//
// WHAT IS NOT BROKEN, on purpose:
//   - A metric with no recorded history at all. Contracts are opt-in and the
//     flag is recent, so an unrecorded metric is untracked, not violated.
//     Counting it as broken would punish every existing metric the day the
//     feature shipped and teach people to ignore the signal.
//   - A metric whose history has several versions. Change is the point. Only
//     the gap between the live definition and the newest recorded one matters.
//
// PURITY: no DOM, no network, no crypto. Reads a metric list and a contract
// registry, returns plain data. It never records a version, because recording
// is a human-confirmed mutation and this only reports.

import { snapshotDefinition, diffVersions, summarizeDiff } from './metric-contracts.js';

export const METRIC_CONTRACT_STATUS_KIND = 'dataglow-metric-contract-status';
export const METRIC_CONTRACT_STATUS_VERSION = 1;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Accepts a MetricRegistry, a plain array of metric records, or nothing.
function metricList(metrics) {
  if (Array.isArray(metrics)) return metrics.filter(isPlainObject);
  if (metrics && typeof metrics.list === 'function') {
    try {
      const arr = metrics.list();
      return Array.isArray(arr) ? arr.filter(isPlainObject) : [];
    } catch (_e) { return []; }
  }
  return [];
}

// Accepts a MetricContractRegistry. Uses has() so an absent history is not
// created as a side effect of asking about it: historyFor() would create one,
// and a read must not write.
function latestVersionFor(registry, metricId) {
  if (!registry || typeof registry.has !== 'function' || typeof registry.historyFor !== 'function') return null;
  try {
    if (!registry.has(metricId)) return null;
    const history = registry.historyFor(metricId);
    return history && typeof history.latest === 'function' ? history.latest() : null;
  } catch (_e) { return null; }
}

/**
 * Compares every metric's live definition against the latest version recorded
 * in its contract history and returns the status object
 * computeReadinessGate() already accepts as its second argument.
 *
 * Never throws: a status producer that can break a validation run would make
 * the whole gate less trustworthy than having no contract check at all.
 *
 * @param {object|Array} metrics a MetricRegistry, or an array of metric records
 * @param {object} contractRegistry a MetricContractRegistry
 * @returns {{kind:string, version:number, ok:boolean, broken:boolean,
 *   checked:number, contracted:number, untracked:number,
 *   brokenMetrics:Array<{metricId:string, name:string, summary:string, fields:Array}>,
 *   summary:string}}
 */
export function computeMetricContractStatus(metrics, contractRegistry) {
  const list = metricList(metrics);
  const brokenMetrics = [];
  let contracted = 0;

  for (const metric of list) {
    const latest = latestVersionFor(contractRegistry, metric.id);
    if (!latest || !isPlainObject(latest.snapshot)) continue;
    contracted += 1;
    const diff = diffVersions(latest.snapshot, snapshotDefinition(metric));
    if (diff.changed) {
      brokenMetrics.push({
        metricId: metric.id,
        name: (typeof metric.name === 'string' && metric.name.trim()) ? metric.name : String(metric.id),
        recordedVersion: latest.version,
        summary: summarizeDiff(diff),
        fields: diff.fields,
      });
    }
  }

  const broken = brokenMetrics.length > 0;
  return {
    kind: METRIC_CONTRACT_STATUS_KIND,
    version: METRIC_CONTRACT_STATUS_VERSION,
    // `ok` is the field readiness-gate.js reads. broken is its inverse, kept
    // because publish-safe.js and the trust ledger both read that name.
    ok: !broken,
    broken,
    checked: list.length,
    contracted,
    untracked: Math.max(0, list.length - contracted),
    brokenMetrics,
    summary: summarizeMetricContractStatus({ broken, contracted, untracked: Math.max(0, list.length - contracted), brokenMetrics }),
  };
}

/**
 * One plain sentence for a banner or a ledger row. No em dash, because this
 * string reaches product surfaces.
 */
export function summarizeMetricContractStatus(status) {
  if (!isPlainObject(status)) return 'Metric definitions were not checked.';
  const broken = Array.isArray(status.brokenMetrics) ? status.brokenMetrics : [];
  const contracted = Number.isFinite(status.contracted) ? status.contracted : 0;
  const untracked = Number.isFinite(status.untracked) ? status.untracked : 0;
  if (contracted === 0) {
    return untracked > 0
      ? `No metric has a recorded definition history yet, so there is nothing to compare ${untracked === 1 ? 'the one metric' : `these ${untracked} metrics`} against.`
      : 'There are no metrics to check.';
  }
  if (broken.length === 0) {
    const tail = untracked > 0 ? ` ${untracked} other metric${untracked === 1 ? ' has' : 's have'} no recorded history yet.` : '';
    return `All ${contracted} metric definition${contracted === 1 ? '' : 's'} with a recorded history still match the version that was agreed.${tail}`;
  }
  const names = broken.map((b) => b && b.name).filter(Boolean).join(', ');
  return `${broken.length} metric definition${broken.length === 1 ? '' : 's'} no longer match the version that was agreed${names ? `: ${names}` : ''}. Someone changed the definition without recording it.`;
}

/**
 * Multi-line detail, field by field, for a panel or a diff view. Plain text so
 * the same string works in a DOM node, a toast, or an export.
 */
export function describeMetricContractStatus(status) {
  if (!isPlainObject(status)) return 'Metric definitions were not checked.';
  const lines = [summarizeMetricContractStatus(status)];
  for (const b of Array.isArray(status.brokenMetrics) ? status.brokenMetrics : []) {
    if (!isPlainObject(b)) continue;
    lines.push(`${b.name}: ${b.summary} since version ${b.recordedVersion}.`);
    for (const f of Array.isArray(b.fields) ? b.fields : []) {
      if (!isPlainObject(f)) continue;
      lines.push(`  ${f.field} was "${f.before}" and is now "${f.after}".`);
    }
  }
  return lines.join('\n');
}

export const DataGlowMetricContractStatus = {
  METRIC_CONTRACT_STATUS_KIND,
  METRIC_CONTRACT_STATUS_VERSION,
  computeMetricContractStatus,
  summarizeMetricContractStatus,
  describeMetricContractStatus,
};

try {
  if (typeof window !== 'undefined') window.DataGlowMetricContractStatus = DataGlowMetricContractStatus;
} catch (_e) { /* no window in Node tests */ }
