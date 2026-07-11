// ============================================================
// DATAGLOW — Agent Confirm Gate (Agent Action Firewall UI affordance)
// ============================================================
// The user-facing side of the Agent Action Firewall. When
// evaluateAction (js/agents/agent-firewall.js) returns `confirm-required`, an
// agent-originated action must be explicitly confirmed by the user BEFORE it is
// applied. This module is that gate.
//
// It is split the same way the rest of the codebase splits pure logic from DOM
// (cf. js/agents/conversational-pack-ui.js): the decision plumbing
// (needsConfirmation / runGuardedAction) is pure and Node-testable via an
// injected confirmFn, while mountConfirmGate is the browser-only presenter that
// reuses the app's existing `.modal.open` overlay pattern (see #redteam-modal /
// #settings-modal in js/app-shell/main.js) rather than inventing a new dialog.
//
// SAFETY DEFAULTS: the destructive button is never the pre-focused / default
// action — Cancel is. A gate that fails to render, or a confirmFn that throws,
// resolves to NOT-confirmed, so the action is blocked rather than slipping
// through. This module names no network primitive.

import { DECISIONS } from './agent-firewall.js';

/**
 * Whether an evaluation requires explicit user confirmation before proceeding.
 * @param {{decision:string}} evaluation the result of evaluateAction
 * @returns {boolean}
 */
export function needsConfirmation(evaluation) {
  return !!evaluation && evaluation.decision === DECISIONS.CONFIRM_REQUIRED;
}

/**
 * Route an agent action through the firewall's decision. Pure orchestration —
 * it performs NO data mutation itself; it only decides whether the caller may
 * proceed, awaiting explicit confirmation when required.
 *
 *   auto-allow       → proceed (no prompt).
 *   confirm-required → await confirmFn(evaluation); proceed only if it resolves truthy.
 *   deny             → never proceed.
 *
 * @param {object} opts
 * @param {{decision:string, reason:string}} opts.evaluation result of evaluateAction
 * @param {(evaluation:object)=>Promise<boolean>|boolean} [opts.confirmFn] asks the
 *   user to confirm; required for a confirm-required action to be able to proceed.
 * @returns {Promise<{proceed:boolean, confirmed:boolean, decision:string, reason:string}>}
 */
export async function runGuardedAction({ evaluation, confirmFn } = {}) {
  if (!evaluation || typeof evaluation.decision !== 'string') {
    return { proceed: false, confirmed: false, decision: DECISIONS.DENY, reason: 'No firewall evaluation supplied — blocked (fail-closed).' };
  }
  const { decision, reason } = evaluation;

  if (decision === DECISIONS.DENY) {
    return { proceed: false, confirmed: false, decision, reason };
  }
  if (decision === DECISIONS.AUTO_ALLOW) {
    return { proceed: true, confirmed: false, decision, reason };
  }
  // confirm-required: must have a way to ask, and the user must say yes.
  if (typeof confirmFn !== 'function') {
    return { proceed: false, confirmed: false, decision, reason: 'This action requires confirmation but no confirmation prompt was available — blocked.' };
  }
  let ok = false;
  try {
    ok = await confirmFn(evaluation);
  } catch {
    ok = false; // a failing prompt blocks the action rather than allowing it
  }
  return { proceed: !!ok, confirmed: !!ok, decision, reason };
}

// ------------------------------------------------------------
// Browser-only presenter. Builds a small modal that asks the user to confirm a
// confirm-required agent action, following the app's `.modal.open` pattern.
// Returns a Promise<boolean> (true = confirmed, false = cancelled). Kept out of
// the pure path above so this file stays unit-testable without a DOM.
// ------------------------------------------------------------
function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Show the confirm-gate modal for a confirm-required evaluation and resolve with
 * the user's choice. Browser-only (needs a DOM); resolves false if no DOM.
 * @param {object} opts
 * @param {{kind:string, reason:string, source?:string}} opts.evaluation
 * @param {Document} [opts.doc] injectable document (defaults to the global one)
 * @returns {Promise<boolean>}
 */
export function mountConfirmGate({ evaluation, doc } = {}) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || !evaluation) return Promise.resolve(false);

  return new Promise((resolve) => {
    const overlay = d.createElement('div');
    overlay.className = 'modal open agent-confirm-gate';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Confirm agent action');

    const kind = escapeText(evaluation.kind);
    const reason = escapeText(evaluation.reason);
    const source = escapeText(evaluation.source || 'an AI/agent');

    overlay.innerHTML = `
      <div class="modal-content agent-confirm-gate-card">
        <h3 class="agent-confirm-gate-title">Confirm this action</h3>
        <p class="agent-confirm-gate-body">
          <strong>${source}</strong> wants to run a <code>${kind}</code> action on your loaded dataset.
        </p>
        <p class="agent-confirm-gate-reason">${reason}</p>
        <p class="agent-confirm-gate-note">DATAGLOW never applies an agent's data change without your explicit go-ahead. You can undo it afterwards.</p>
        <div class="agent-confirm-gate-actions">
          <button type="button" class="btn" data-gate="cancel">Cancel (keep data as-is)</button>
          <button type="button" class="btn btn-danger" data-gate="confirm">Apply this change</button>
        </div>
      </div>`;

    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      try { overlay.remove(); } catch { /* best effort */ }
      resolve(!!result);
    };

    const cancelBtn = overlay.querySelector('[data-gate="cancel"]');
    const confirmBtn = overlay.querySelector('[data-gate="confirm"]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
    if (confirmBtn) confirmBtn.addEventListener('click', () => close(true));
    // Clicking the backdrop cancels (safe default).
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    (d.body || d.documentElement).appendChild(overlay);
    // Cancel is the safe default focus — never pre-focus the destructive button.
    if (cancelBtn && typeof cancelBtn.focus === 'function') {
      try { cancelBtn.focus(); } catch { /* ignore */ }
    }
  });
}

/**
 * Convenience: build a confirmFn (for runGuardedAction) backed by the browser
 * modal. Lets a call site write
 *   runGuardedAction({ evaluation, confirmFn: browserConfirmFn() })
 * without importing the mount details.
 * @param {Document} [doc]
 * @returns {(evaluation:object)=>Promise<boolean>}
 */
export function browserConfirmFn(doc) {
  return (evaluation) => mountConfirmGate({ evaluation, doc });
}
