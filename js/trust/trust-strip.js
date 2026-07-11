// ============================================================
// DATAGLOW — Trust Strip (OneCanvas Phase 1, Part 3)
// ============================================================
// A compact, persistent horizontal bar of trust signals for the loaded dataset.
// Every field is sourced from REAL computed data — never a hardcoded placeholder:
//
//   * Data freshness      — dataset.loadedAt (app-shell/state.js)
//   * Metric certification — certified/reviewed/exploratory counts from the
//                            Metric Studio registry (0/0/0 when none exist)
//   * Validation summary   — pass/warn/fail tally from the real 20-layer
//                            validation results (validation.js); "not yet
//                            validated" before a run
//   * Anomaly indicator    — the injected anomaly module output; "not checked"
//                            when anomaly detection has not run
//   * Lineage available    — whether provenance.js has a non-empty chain for the
//                            current table
//   * Last project update  — same load-time source as freshness
//
// The collector (collectTrustSignals) is a PURE function — no DOM, no globals —
// so it is unit-testable in Node and renders sensibly with zero data loaded.
// The renderer wires each field as a button that asks the caller to open the
// Proof Drawer scoped to that field. Gated behind `trustStripProofDrawer` by the
// caller; with the flag off (default) main.js never mounts it.

import { el, timeAgo } from '../app-shell/utils.js';

// The known per-layer result statuses in a validation results object. Entries
// that are not layer results (domainPack, calibratedGrades) lack these and are
// skipped by the summary.
const LAYER_STATUSES = new Set(['pass', 'warn', 'fail', 'idle']);

function summarizeValidation(validationResults) {
  if (!validationResults || typeof validationResults !== 'object') {
    return { ran: false, pass: 0, warn: 0, fail: 0, idle: 0, total: 0 };
  }
  let pass = 0, warn = 0, fail = 0, idle = 0, total = 0;
  for (const v of Object.values(validationResults)) {
    if (!v || typeof v !== 'object' || typeof v.status !== 'string') continue;
    if (!LAYER_STATUSES.has(v.status)) continue;
    total += 1;
    if (v.status === 'pass') pass += 1;
    else if (v.status === 'warn') warn += 1;
    else if (v.status === 'fail') fail += 1;
    else idle += 1;
  }
  return { ran: total > 0, pass, warn, fail, idle, total };
}

// Best-effort anomaly count from whatever the anomaly modules produced. Accepts
// several shapes so any of js/anomaly/* outputs can feed the field honestly.
function summarizeAnomaly(anomalyResult) {
  if (anomalyResult == null) return { checked: false, count: 0 };
  if (Array.isArray(anomalyResult)) return { checked: true, count: anomalyResult.length };
  if (Array.isArray(anomalyResult.anomalies)) return { checked: true, count: anomalyResult.anomalies.length };
  if (typeof anomalyResult.count === 'number') return { checked: true, count: anomalyResult.count };
  if (typeof anomalyResult.anomalyCount === 'number') return { checked: true, count: anomalyResult.anomalyCount };
  return { checked: true, count: 0 };
}

/**
 * Assemble the Trust Strip field descriptors from real data. Pure & synchronous.
 * @param {object} arg
 * @param {{table:string, loadedAt:number}|null} [arg.dataset] the active dataset
 * @param {object} [arg.validationResults] state.validationResults
 * @param {{certified:number,reviewed:number,exploratory:number,total:number}} [arg.metricCounts]
 * @param {{length:number}|null} [arg.provenanceChain] provenance chain for the table
 * @param {*} [arg.anomalyResult] anomaly module output (or null if not run)
 * @param {number} [arg.now]
 * @returns {{loaded:boolean, fields:Array<{key,label,value,state,detail}>}}
 */
export function collectTrustSignals(arg = {}) {
  const {
    dataset = null, validationResults = null, metricCounts = null,
    provenanceChain = null, anomalyResult = null, now = Date.now(),
  } = arg;

  const loaded = !!(dataset && dataset.loadedAt);
  const fields = [];

  // Data freshness
  fields.push(loaded
    ? { key: 'freshness', label: 'Freshness', value: timeAgo(dataset.loadedAt), state: 'ok', detail: `${dataset.table} loaded ${new Date(dataset.loadedAt).toISOString()}` }
    : { key: 'freshness', label: 'Freshness', value: 'nothing loaded yet', state: 'idle', detail: 'No dataset is loaded.' });

  // Metric certification
  const mc = metricCounts || { certified: 0, reviewed: 0, exploratory: 0, total: 0 };
  fields.push({
    key: 'certification', label: 'Metrics',
    value: `${mc.certified || 0} certified · ${mc.reviewed || 0} reviewed · ${mc.exploratory || 0} exploratory`,
    state: (mc.total || 0) === 0 ? 'idle' : (mc.certified > 0 ? 'ok' : 'warn'),
    detail: `${mc.total || 0} metric(s) defined in Metric Studio.`,
  });

  // Validation summary
  const vs = summarizeValidation(validationResults);
  fields.push(vs.ran
    ? { key: 'validation', label: 'Validation', value: `${vs.pass} pass · ${vs.warn} warn · ${vs.fail} fail`, state: vs.fail > 0 ? 'bad' : (vs.warn > 0 ? 'warn' : 'ok'), detail: `${vs.total} layers evaluated.` }
    : { key: 'validation', label: 'Validation', value: 'not yet validated', state: 'idle', detail: 'Run the 20-layer validation to populate this.' });

  // Anomaly indicator
  const an = summarizeAnomaly(anomalyResult);
  fields.push(an.checked
    ? { key: 'anomaly', label: 'Anomalies', value: an.count === 0 ? 'none flagged' : `${an.count} flagged`, state: an.count > 0 ? 'warn' : 'ok', detail: 'From on-device anomaly detection.' }
    : { key: 'anomaly', label: 'Anomalies', value: 'not checked', state: 'idle', detail: 'Anomaly detection has not run on this dataset.' });

  // Lineage available
  const hasChain = !!(provenanceChain && (provenanceChain.length || 0) > 0);
  fields.push({
    key: 'lineage', label: 'Lineage',
    value: hasChain ? 'available' : (loaded ? 'none recorded' : 'not available'),
    state: hasChain ? 'ok' : 'idle',
    detail: hasChain ? `${provenanceChain.length} provenance step(s) recorded.` : 'No provenance chain for this table yet.',
  });

  // Last project update (same source as freshness)
  fields.push(loaded
    ? { key: 'lastUpdate', label: 'Last update', value: timeAgo(dataset.loadedAt), state: 'ok', detail: `Last dataset change ${new Date(dataset.loadedAt).toISOString()}` }
    : { key: 'lastUpdate', label: 'Last update', value: '—', state: 'idle', detail: 'No project activity yet.' });

  return { loaded, fields };
}

const STATE_DOT = { ok: '#2e7d32', warn: '#b8860b', bad: '#c62828', idle: '#9e9e9e' };

/**
 * Render the Trust Strip into `host`. Clicking any field invokes onFieldClick
 * with the field descriptor so the caller can open the Proof Drawer scoped to it.
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {object} opts.signals result of collectTrustSignals()
 * @param {(field:object)=>void} [opts.onFieldClick]
 */
export function renderTrustStrip(opts = {}) {
  const { host, signals, onFieldClick = () => {} } = opts;
  if (!host || !signals) return;
  host.innerHTML = '';
  const bar = el('div', {
    class: 'card',
    'data-testid': 'trust-strip',
    style: 'display:flex; flex-wrap:wrap; gap:var(--space-2); padding:var(--space-2) var(--space-3); margin-bottom:var(--space-4); align-items:center;',
  });
  for (const f of signals.fields) {
    const btn = el('button', {
      type: 'button', class: 'btn btn-ghost', 'data-testid': `trust-field-${f.key}`, 'data-field': f.key,
      title: f.detail,
      style: 'display:flex; align-items:center; gap:6px; font-size:var(--text-sm); padding:4px 10px;',
      onclick: () => onFieldClick(f),
    }, [
      el('span', { style: `width:8px; height:8px; border-radius:50%; background:${STATE_DOT[f.state] || STATE_DOT.idle}; display:inline-block;` }),
      el('span', { style: 'color:var(--color-text-muted);' }, `${f.label}:`),
      el('span', { style: 'font-weight:600;' }, f.value),
    ]);
    bar.appendChild(btn);
  }
  host.appendChild(bar);
}
