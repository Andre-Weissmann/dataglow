// ============================================================
// DATAGLOW — Metric Contracts, Batch 3: confirm gate (the safety-critical piece)
// ============================================================
// THE RULE THIS FILE EXISTS TO ENFORCE (never relaxed, never bypassed):
//
//   An AI agent may PROPOSE a change to a metric's contract. It may never
//   APPLY one. Applying — the only thing that calls
//   MetricContractHistory.recordVersion() with an agent-sourced entry — happens
//   through exactly one function in this whole codebase, approve(), and
//   approve() only runs from a human clicking the one Approve button this
//   file's own DOM presenter renders. There is no other path in, and no
//   auto-approve/auto-apply timer, config flag, or "trusted agent" bypass of
//   any kind — not for this PR, not for any future one, per this project's
//   hard autonomy-safety rule (an April 2026 incident is the concrete reason
//   why: an AI coding agent deleted a production database and its backups in
//   9 seconds with no confirmation prompt).
//
// WHAT A "PROPOSAL" IS: a plain, inert data object — { metricId, proposedBy,
// reason, candidate }. Creating one (proposeContractChange) does nothing to
// any registry; it is pure data construction, exactly as inert as writing the
// object literal by hand. It only becomes real once approve() is called on it
// with the actual MetricContractRegistry AND the metric-studio MetricRegistry
// to write to — and approve() is a synchronous, single-shot function, not a
// long-running agent loop, so there is no window where a "yes" leads to more
// than the one change that was shown.
//
// THE GATE STATE MACHINE (a proposal's only three states):
//   pending  → the default state; nothing has happened yet.
//   applied  → approve() was called; recordVersion() ran with source:
//              'agent-proposed' and the metric's live definition was updated
//              to match. A proposal can only reach 'applied' once — approving
//              twice is a no-op returning the same result, never a double-apply.
//   rejected → reject() was called; nothing was ever written anywhere.
//
// This batch REUSES Batch 2's exact content builder/renderer
// (buildDiffViewContent/renderDiffView from metric-contract-diff-view.js) for
// what the human sees, unmodified — so an agent's proposed change looks
// pixel-for-pixel identical to a past human edit, with the addition of the
// Approve/Reject buttons this file adds around it.

import { el } from '../app-shell/utils.js';
import { snapshotDefinition } from './metric-contracts.js';
import { buildDiffViewContent, renderDiffView } from './metric-contract-diff-view.js';

/**
 * Construct a PROPOSAL — pure data, zero side effects, nothing written
 * anywhere. This is the only thing an "AI agent" caller in this codebase is
 * allowed to produce with respect to a metric contract; it has no access to
 * approve()'s write path at all (that lives in this same module but is a
 * separate export the agent-facing call site never needs to touch).
 * @param {object} opts
 * @param {string} opts.metricId the metric this proposal targets
 * @param {object} opts.currentMetric the metric's CURRENT live definition (for the diff's "before")
 * @param {object} opts.candidate the PROPOSED new definition fields (name/plainEnglish/expression/owner/tag)
 * @param {string} [opts.proposedBy] identifies the agent, e.g. "metric-copilot"
 * @param {string} [opts.reason] the agent's stated reason — never invented downstream, only ever this string
 * @returns {object} an inert proposal record; `status` is always 'pending' at creation
 */
export function proposeContractChange({ metricId, currentMetric, candidate, proposedBy = 'agent', reason = '' } = {}) {
  if (!metricId) throw new Error('metric-contract-confirm-gate: a proposal needs a metricId');
  if (!candidate) throw new Error('metric-contract-confirm-gate: a proposal needs a candidate definition');
  return {
    metricId,
    before: snapshotDefinition(currentMetric || {}),
    candidate: snapshotDefinition(candidate),
    proposedBy,
    reason,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
  };
}

/**
 * Build the exact same diff-view content Batch 2 renders for a human's past
 * edit, but for a still-PENDING proposal (before vs. candidate, neither of
 * which has been written anywhere yet). Pure — safe to call as many times as
 * the UI re-renders; never mutates the proposal.
 * @param {{metricName?:string, proposal:object}} opts
 * @returns {{title:string, subtitle:string, blocks:Array<object>}}
 */
export function buildProposalDiffContent({ metricName, proposal } = {}) {
  return buildDiffViewContent({
    metricName,
    before: { version: 'current', snapshot: proposal.before },
    after: {
      version: 'proposed',
      snapshot: proposal.candidate,
      changedBy: proposal.proposedBy,
      reason: proposal.reason,
      source: 'agent-proposed',
    },
  });
}

/**
 * THE ONLY WRITE PATH. Approves a pending proposal: records a new version in
 * the contract history (source: 'agent-proposed', carrying the real
 * proposedBy/reason) AND updates the metric's live definition in the
 * metric-studio registry to match the candidate — the two are kept in sync
 * deliberately, since a contract history entry for a change nobody actually
 * applied to the live metric would itself be a kind of dishonesty.
 *
 * Idempotent by design: approving an already-applied proposal is a no-op that
 * returns the ORIGINAL result, never appends a second version — this
 * "explicit click only" gate exists specifically so a duplicate click, retry,
 * or race can never accidentally cause a duplicate apply.
 *
 * @param {object} opts
 * @param {object} opts.proposal a proposal from proposeContractChange() (mutated in place: status/decidedAt/appliedVersion set on success)
 * @param {import('./metric-contracts.js').MetricContractRegistry} opts.contractRegistry
 * @param {{update:Function}} opts.metricRegistry the metric-studio MetricRegistry (duck-typed: needs update(id, patch))
 * @returns {{ok:boolean, version?:object, error?:string}}
 */
export function approve({ proposal, contractRegistry, metricRegistry } = {}) {
  if (!proposal) return { ok: false, error: 'No proposal given.' };
  if (proposal.status === 'applied') return { ok: true, version: proposal._appliedVersion, error: undefined };
  if (proposal.status === 'rejected') return { ok: false, error: 'This proposal was already rejected; create a new one to try again.' };
  if (!contractRegistry) return { ok: false, error: 'No contract registry given — cannot record a version.' };
  if (!metricRegistry || typeof metricRegistry.update !== 'function') {
    return { ok: false, error: 'No metric registry given — cannot apply the change to the live metric.' };
  }

  const version = contractRegistry.recordVersion(proposal.metricId, proposal.candidate, {
    changedBy: proposal.proposedBy,
    reason: proposal.reason,
    source: 'agent-proposed',
  });
  metricRegistry.update(proposal.metricId, { ...proposal.candidate });

  proposal.status = 'applied';
  proposal.decidedAt = Date.now();
  proposal._appliedVersion = version;
  return { ok: true, version };
}

/**
 * Rejects a pending proposal. Writes nothing anywhere — the metric and its
 * contract history are left exactly as they were. Idempotent: rejecting an
 * already-rejected proposal is a harmless no-op.
 * @param {object} opts
 * @param {object} opts.proposal
 * @param {string} [opts.note] optional free-text reason a human gives for rejecting
 * @returns {{ok:boolean, error?:string}}
 */
export function reject({ proposal, note = '' } = {}) {
  if (!proposal) return { ok: false, error: 'No proposal given.' };
  if (proposal.status === 'applied') {
    return { ok: false, error: 'This proposal was already applied; rejecting it now would not undo that.' };
  }
  proposal.status = 'rejected';
  proposal.decidedAt = Date.now();
  proposal.rejectionNote = note;
  return { ok: true };
}

// ------------------------------------------------------------
// DOM presenter
// ------------------------------------------------------------

/**
 * Render a pending proposal as: the Batch 2 diff view (unmodified) + one
 * Approve button + one Reject button, EQUAL visual weight (this project's
 * established pattern from the conversational pack builder — never nudge the
 * user toward "accept"). Clicking Approve calls approve() with the registries
 * given here; clicking Reject calls reject(). Both callbacks fire exactly
 * once per click and immediately re-render to a static "applied"/"rejected"
 * state — the buttons are removed after a decision so a second click on a
 * stale render can't matter.
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {object} opts.proposal
 * @param {string} [opts.metricName]
 * @param {import('./metric-contracts.js').MetricContractRegistry} opts.contractRegistry
 * @param {{update:Function}} opts.metricRegistry
 * @param {(result:{ok:boolean})=>void} [opts.onDecision] called after approve/reject resolves
 */
export function renderConfirmGate({ host, proposal, metricName, contractRegistry, metricRegistry, onDecision = () => {} } = {}) {
  if (!host || !proposal) return;
  host.innerHTML = '';

  const diffHost = el('div', { 'data-testid': 'confirm-gate-diff' });
  host.appendChild(diffHost);
  renderDiffView({ host: diffHost, content: buildProposalDiffContent({ metricName, proposal }) });

  if (proposal.status !== 'pending') {
    host.appendChild(el('div', {
      'data-testid': 'confirm-gate-status',
      style: 'margin-top:var(--space-2); font-weight:600;',
    }, proposal.status === 'applied' ? '✅ Applied' : '✋ Rejected'));
    return;
  }

  const warning = el('div', {
    'data-testid': 'confirm-gate-warning',
    style: 'margin:var(--space-2) 0; color:var(--color-text-muted); font-size:var(--text-sm);',
  }, `Proposed by ${proposal.proposedBy}. Nothing has been changed yet — this metric stays exactly as it is until you choose below.`);
  host.appendChild(warning);

  const approveBtn = el('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'confirm-gate-approve' }, 'Approve this change');
  const rejectBtn = el('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'confirm-gate-reject' }, 'Reject');
  const actions = el('div', { style: 'display:flex; gap:8px; margin-top:var(--space-2);' }, [approveBtn, rejectBtn]);
  host.appendChild(actions);

  approveBtn.addEventListener('click', () => {
    const result = approve({ proposal, contractRegistry, metricRegistry });
    renderConfirmGate({ host, proposal, metricName, contractRegistry, metricRegistry, onDecision });
    onDecision(result);
  });
  rejectBtn.addEventListener('click', () => {
    const result = reject({ proposal });
    renderConfirmGate({ host, proposal, metricName, contractRegistry, metricRegistry, onDecision });
    onDecision(result);
  });
}
