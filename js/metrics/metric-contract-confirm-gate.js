// ============================================================
// DATAGLOW — Metric Contracts, Batch 3: confirm-gate
// ============================================================
// WHY THIS EXISTS (the hard autonomy-safety rule it enforces):
// DATAGLOW must NEVER let an AI agent auto-apply or modify a metric definition
// without explicit, per-action human confirmation. This module is the single
// enforcement point of that rule for metric contracts. Batch 1
// (js/metrics/metric-contracts.js) shipped the append-only version history and
// stated plainly that it has "no AI-agent write path yet (Batch 3: confirm
// gate)". Batch 2 (js/metrics/metric-contract-diff-view.js) shipped the pure
// read-only diff view. This batch adds the ONE thing that stood between a
// proposed change and a recorded one: an explicit human confirm step.
//
// THE SHAPE OF THE SAFETY GUARANTEE (structural, not just documented):
//   - prepareProposedChange() builds an inert `pending-change` object and
//     REUSES Batch 2's buildDiffViewContent() so an AI-proposed change renders
//     visually IDENTICAL to a human's past change — the only difference is the
//     confirm step this file adds around it. It is not handed a registry, so it
//     CANNOT persist anything.
//   - buildConfirmGateContent() / renderConfirmGate() are presentation only.
//     Neither is handed a registry, so neither can persist anything either.
//   - rejectProposedChange() marks a pending change rejected and, like the rest,
//     has no registry and persists nothing.
//   - confirmProposedChange() is the ONLY exported function that receives a
//     MetricContractRegistry and is therefore the ONLY code path that can call
//     recordVersion(). It is meant to run behind a real user click and nowhere
//     else — never on page load, never on a timer, never from an agent path.
// Because the registry is only ever threaded into confirmProposedChange(), "no
// silent write" is enforced by the module's shape, not merely by comment — the
// other functions have nothing to write with. The test asserts exactly this.
//
// Follows the same pure-logic-vs-DOM split as Batches 1 & 2 and js/trust/proof-drawer.js:
//   1. prepareProposedChange / buildConfirmGateContent / confirmProposedChange /
//      rejectProposedChange — PURE, Node-testable, no DOM.
//   2. renderConfirmGate() — DOM presenter, reusing Batch 2's renderDiffView().
//
// Ships behind the `metricContractsConfirmGate` flag (added this PR, OFF by
// default); the minimal main.js wiring mounts nothing while the flag is off.

import { el } from '../app-shell/utils.js';
import { snapshotDefinition } from './metric-contracts.js';
import { buildDiffViewContent, renderDiffView } from './metric-contract-diff-view.js';

/**
 * Human-readable label for a proposed change's source. This is the SAME logic
 * Batch 2's diff view uses (`source === 'agent-proposed' ? 'AI-agent proposed'
 * : 'Human edit'`), factored out here so the confirm gate and the diff view can
 * never drift on how they name who is asking for a change.
 * @param {'human'|'agent-proposed'} source
 * @returns {string}
 */
export function sourceLabel(source) {
  return source === 'agent-proposed' ? 'AI-agent proposed' : 'Human edit';
}

/**
 * Prepare an inert pending-change object for a proposed new metric definition.
 * This NEVER records anything — it only snapshots the current and proposed
 * definitions, normalises the source, and builds the exact same diff-view
 * content model Batch 2 renders, so the human sees precisely what would change
 * BEFORE anything is applied. It is deliberately not given a registry.
 * @param {object} opts
 * @param {string} opts.metricId id of the metric this change targets
 * @param {string} [opts.metricName] display name for the diff title
 * @param {object} opts.current the current metric definition (or its snapshot)
 * @param {object} opts.proposed the candidate new metric definition
 * @param {'human'|'agent-proposed'} [opts.source] who/what proposed it
 * @param {string} [opts.changedBy] the proposer's name/id (honest metadata)
 * @param {string} [opts.reason] why the change is proposed (honest metadata)
 * @returns {object} a pending-change object; status is always 'pending'
 */
export function prepareProposedChange({ metricId, metricName, current, proposed, source, changedBy, reason } = {}) {
  const beforeSnap = snapshotDefinition(current || {});
  const afterSnap = snapshotDefinition(proposed || {});
  const normSource = source === 'agent-proposed' ? 'agent-proposed' : 'human';
  // Shape the `after` like a version entry so buildDiffViewContent surfaces the
  // same who/when/why/source metadata it does for a recorded version. `before`
  // is a bare snapshot (no wrapper metadata) so no metadata is invented for it.
  const afterEntry = {
    snapshot: afterSnap,
    changedBy: changedBy || 'unknown',
    changedAt: Date.now(),
    reason: reason || '',
    source: normSource,
  };
  const diffContent = buildDiffViewContent({ metricName, before: { snapshot: beforeSnap }, after: afterEntry });
  return {
    kind: 'dataglow-metric-contract-pending-change',
    status: 'pending',
    metricId,
    metricName: metricName || '',
    before: beforeSnap,
    after: afterSnap,
    source: normSource,
    changedBy: changedBy || 'unknown',
    reason: reason || '',
    hasChanges: diffContent.diff.changed,
    diffContent,
  };
}

/**
 * Build the pure content model shown ABOVE the confirm/reject controls. It wraps
 * Batch 2's diff-view content unchanged and adds one honest source badge so the
 * human is never confused about who is asking: an AI-proposed change is clearly
 * marked "AI-suggested". Presentation only — no registry, persists nothing.
 * @param {object} pending a pending-change object from prepareProposedChange
 * @returns {{title:string, subtitle:string, source:string, sourceLabel:string,
 *            badge:{text:string, isAgent:boolean}, diffContent:object,
 *            confirmLabel:string}}
 */
export function buildConfirmGateContent(pending) {
  const p = pending || {};
  const isAgent = p.source === 'agent-proposed';
  return {
    title: p.metricName || 'Proposed metric change',
    subtitle: p.hasChanges
      ? 'Review this proposed change. Nothing is recorded until you confirm.'
      : 'This proposal makes no changes to the current definition.',
    source: p.source || 'human',
    sourceLabel: sourceLabel(p.source),
    badge: { text: isAgent ? 'AI-suggested' : 'Human edit', isAgent },
    diffContent: p.diffContent,
    confirmLabel: isAgent ? 'Confirm & apply AI suggestion' : 'Confirm & apply change',
  };
}

/**
 * Apply a pending change. This is the ONLY function that touches a registry and
 * therefore the ONLY path that can call recordVersion(). It is meant to be
 * invoked from an explicit human action (a button click) — never on load, never
 * on a timer, never from an agent code path. It records the proposed definition
 * as a new version carrying the proposal's honest source/changedBy/reason, then
 * marks the pending object applied.
 * @param {object} opts
 * @param {object} opts.pending a pending-change object from prepareProposedChange
 * @param {object} opts.registry a MetricContractRegistry (or history) to record into
 * @returns {object} the appended version entry
 */
export function confirmProposedChange({ pending, registry } = {}) {
  if (!pending || pending.status !== 'pending') {
    throw new Error('confirmProposedChange: no pending change to confirm');
  }
  if (!registry || typeof registry.recordVersion !== 'function') {
    throw new Error('confirmProposedChange: a registry with recordVersion() is required');
  }
  const entry = registry.recordVersion(pending.metricId, pending.after, {
    changedBy: pending.changedBy,
    reason: pending.reason,
    source: pending.source,
  });
  pending.status = 'applied';
  pending.appliedVersion = entry.version;
  return entry;
}

/**
 * Reject a pending change. Persists NOTHING — it only flips the pending object's
 * status so the UI can clear it. Present so a "no, don't apply" action is a
 * first-class, explicit path rather than just closing a panel.
 * @param {object} pending a pending-change object from prepareProposedChange
 * @returns {object} the same pending object with status 'rejected'
 */
export function rejectProposedChange(pending) {
  if (pending && pending.status === 'pending') pending.status = 'rejected';
  return pending;
}

// ------------------------------------------------------------
// DOM presenter
// ------------------------------------------------------------

/**
 * Render the confirm gate into `host`: the Batch 2 diff view (so a proposed
 * change looks identical to a recorded one), a source badge, and Confirm/Reject
 * buttons. The confirm button calls `onConfirm` ONLY on a real click — this
 * presenter never calls recordVersion() itself and is never handed a registry.
 * The caller wires `onConfirm` to confirmProposedChange (which does the write).
 * @param {object} opts
 * @param {HTMLElement} opts.host mount point
 * @param {object} opts.pending a pending-change object from prepareProposedChange
 * @param {(pending:object)=>void} [opts.onConfirm] click handler for confirm
 * @param {(pending:object)=>void} [opts.onReject] click handler for reject
 */
export function renderConfirmGate({ host, pending, onConfirm, onReject } = {}) {
  if (!host || !pending) return;
  const content = buildConfirmGateContent(pending);
  host.innerHTML = '';

  // Source badge — an AI-suggested change is visually distinct so the human is
  // never confused about who is asking for the change.
  const badge = el('span', {
    'data-testid': 'confirm-gate-badge',
    'data-source': content.source,
    style: `display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:600; margin-bottom:8px; ${content.badge.isAgent
      ? 'background:var(--color-warning-bg,#fff5e6); color:var(--color-warning,#a15c00); border:1px solid var(--color-warning,#e0a458);'
      : 'background:var(--color-surface-2,#eef1f4); color:var(--color-text-muted,#57606a); border:1px solid var(--color-border,#d0d7de);'}`,
  }, content.badge.text);
  host.appendChild(badge);

  // The diff itself, rendered by Batch 2's presenter — identical to how a
  // recorded human change would look.
  const diffHost = el('div', { 'data-testid': 'confirm-gate-diff' });
  host.appendChild(diffHost);
  renderDiffView({ host: diffHost, content: content.diffContent });

  // Explicit, equal-weight action controls. Nothing fires without a click.
  const actions = el('div', { style: 'display:flex; gap:8px; margin-top:12px;' });
  const confirmBtn = el('button', {
    type: 'button',
    class: 'btn btn-primary',
    'data-testid': 'confirm-gate-confirm',
    onclick: () => { if (typeof onConfirm === 'function') onConfirm(pending); },
  }, content.confirmLabel);
  const rejectBtn = el('button', {
    type: 'button',
    class: 'btn',
    'data-testid': 'confirm-gate-reject',
    onclick: () => { if (typeof onReject === 'function') onReject(pending); },
  }, 'Reject');
  actions.appendChild(confirmBtn);
  actions.appendChild(rejectBtn);
  host.appendChild(actions);
}
