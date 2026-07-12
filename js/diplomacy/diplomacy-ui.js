// ============================================================
// DATAGLOW — Data Diplomacy UI (Batch 2 of N): the thin two-key panel
// ============================================================
// WHAT THIS IS: the presenter for the pure Batch-1 engine (js/diplomacy/*:
// diplomacy-claim.js, reconciliation-engine.js, diplomacy-approval-gate.js).
// It shows two competing sealed claims side by side, the reconciliation
// verdict the engine ALREADY produced, and — only when that verdict actually
// resolved — a two-key approval row where each party holds exactly one key.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - It runs NO reconciliation logic of its own. reconcileClaims() decided;
//     this only presents that decision, verbatim rationale included.
//   - When the engine honestly refused (resolved:false — "needs human
//     debate"), it renders NO approval UI at all. There is no path here that
//     dresses an unresolved conflict up as an applied resolution.
//   - The per-party Approve button for partyA calls onApprove(partyAId) and
//     NOTHING else — one party can never turn the other party's key. The
//     mandatory two-key rule lives in the engine's approve(); this UI just
//     never gives one party both buttons.
//
// Identity split (same convention as js/gate/readiness-gate-ui.js and
// js/metrics/metric-contract-confirm-gate.js): the model builders are PURE,
// Node-testable, DOM-free functions; the renderer turns those models into DOM
// and, like renderConfirmGate, re-renders after each decision so a decided
// party's buttons are gone and a stale second click can't matter.

import { el } from '../app-shell/utils.js';
import { explainReconciliation } from './reconciliation-engine.js';

// Reuse the existing pill vocabulary from css/base.css (.badge + grade colors);
// we invent no new colors. Resolved -> green (agreement reached), unresolved ->
// amber (honest "needs a human", NOT a red failure — refusing to guess is the
// correct behavior, not an error).
const RESOLVED_BADGE = 'badge badge-a';
const UNRESOLVED_BADGE = 'badge badge-c';

function valueToText(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function shortFingerprint(fp) {
  if (typeof fp !== 'string' || !fp) return null;
  return fp.length > 16 ? `${fp.slice(0, 12)}…${fp.slice(-4)}` : fp;
}

/**
 * Turn one sealed claim (from sealClaim()) into a pure, DOM-free card view
 * model. Never throws; a missing/malformed claim yields an honest placeholder
 * card rather than crashing the panel.
 * @param {object} claim a sealed claim: { entityId, field, value, confidence, source, sealedBy, fingerprint, ... }
 * @returns {{
 *   source:string, entityId:string, field:string, valueText:string,
 *   hasConfidence:boolean, confidenceText:string, sealedBy:(string|null),
 *   fingerprintShort:(string|null), title:string
 * }}
 */
export function buildClaimCardModel(claim) {
  if (!claim || typeof claim !== 'object') {
    return {
      source: 'unknown source', entityId: '—', field: '—', valueText: '—',
      hasConfidence: false, confidenceText: 'no confidence stated',
      sealedBy: null, fingerprintShort: null, title: 'Malformed claim',
    };
  }
  const source = claim.source == null || claim.source === '' ? 'unknown source' : String(claim.source);
  const entityId = claim.entityId == null ? '—' : String(claim.entityId);
  const field = claim.field == null ? '—' : String(claim.field);
  const hasConfidence = typeof claim.confidence === 'number' && Number.isFinite(claim.confidence);
  return {
    source,
    entityId,
    field,
    valueText: valueToText(claim.value),
    hasConfidence,
    confidenceText: hasConfidence ? `confidence ${claim.confidence}` : 'no confidence stated',
    sealedBy: claim.sealedBy == null || claim.sealedBy === '' ? null : String(claim.sealedBy),
    fingerprintShort: shortFingerprint(claim.fingerprint),
    title: `"${field}" of "${entityId}", claimed by ${source}`,
  };
}

/**
 * Turn a reconciliation result (from reconcileClaims()) into a pure, DOM-free
 * panel view model. Honestly preserves the engine's resolved/unresolved split:
 * when resolved:false, showApproval is false and there is no proposed value —
 * the panel must render the "needs human debate" state, never hide it.
 * Never throws; a missing/malformed result is treated as unresolved.
 * @param {ReturnType<import('./reconciliation-engine.js').reconcileClaims>} reconciliationResult
 * @returns {{
 *   resolved:boolean, showApproval:boolean, badgeClass:string, headline:string,
 *   reason:string, rationale:string, proposedValueText:(string|null),
 *   winningSource:(string|null), losingSource:(string|null),
 *   marginText:(string|null), explanation:string
 * }}
 */
export function buildReconciliationPanelModel(reconciliationResult) {
  const r = reconciliationResult && typeof reconciliationResult === 'object' ? reconciliationResult : null;
  const resolved = !!(r && r.resolved === true);
  const reason = (r && r.reason) ? String(r.reason) : (resolved ? 'resolved' : 'no reconciliation result');
  const rationale = (r && r.rationale) ? String(r.rationale)
    : 'No reconciliation has been run for these two claims yet.';

  if (!resolved) {
    return {
      resolved: false,
      showApproval: false,
      badgeClass: UNRESOLVED_BADGE,
      headline: 'Needs human debate',
      reason,
      rationale,
      proposedValueText: null,
      winningSource: null,
      losingSource: null,
      marginText: null,
      explanation: explainReconciliation(r),
    };
  }

  const winning = r.winningClaim || {};
  const losing = r.losingClaim || {};
  const marginText = (typeof r.marginOfConfidence === 'number' && Number.isFinite(r.marginOfConfidence))
    ? `confidence margin ${r.marginOfConfidence.toFixed(3)}`
    : null;
  return {
    resolved: true,
    showApproval: true,
    badgeClass: RESOLVED_BADGE,
    headline: 'Resolved — needs two-key sign-off',
    reason,
    rationale,
    proposedValueText: valueToText(winning.value),
    winningSource: winning.source == null ? null : String(winning.source),
    losingSource: losing.source == null ? null : String(losing.source),
    marginText,
    explanation: explainReconciliation(r),
  };
}

// ------------------------------------------------------------
// DOM presenter
// ------------------------------------------------------------

const MUTED = 'color:var(--color-text-muted); font-size:var(--text-sm);';

function renderClaimCard(model) {
  return el('div', {
    class: 'card',
    'data-testid': 'diplomacy-claim-card',
    'data-source': model.source,
    style: 'flex:1 1 0; min-width:0;',
  }, [
    el('div', { style: 'font-weight:600; margin-bottom:var(--space-1);' }, model.source),
    el('div', { style: `${MUTED} margin-bottom:var(--space-2);` }, `${model.field} · ${model.entityId}`),
    el('div', { style: 'font-size:var(--text-lg); font-weight:600; word-break:break-word;', 'data-testid': 'diplomacy-claim-value' }, model.valueText),
    el('div', { style: `${MUTED} margin-top:var(--space-2);` }, model.confidenceText),
    model.sealedBy ? el('div', { style: MUTED }, `sealed by ${model.sealedBy}`) : null,
    model.fingerprintShort
      ? el('div', { style: `${MUTED} margin-top:var(--space-1); font-family:var(--font-mono, monospace);`, title: 'SHA-256 seal' }, model.fingerprintShort)
      : null,
  ].filter(Boolean));
}

// The two-key approval row. Reads the CURRENT approvalRequest state on every
// render (the caller re-invokes renderDiplomacyPanel after each decision, so a
// decided party shows a static verdict and its buttons are gone). Each party
// gets its OWN Approve/Reject buttons wired to ONLY that party's id.
function renderApprovalRow({ approvalRequest, partyAId, partyBId, onApprove, onReject }) {
  const wrap = el('div', { 'data-testid': 'diplomacy-approval', style: 'margin-top:var(--space-4);' });

  wrap.appendChild(el('div', {
    'data-testid': 'diplomacy-two-key-note',
    style: `${MUTED} margin-bottom:var(--space-2);`,
  }, 'Two-key rule: this proposal only applies once BOTH parties independently approve. One approval alone changes nothing; either party may reject.'));

  if (!approvalRequest || typeof approvalRequest !== 'object') {
    wrap.appendChild(el('div', { style: MUTED }, 'No approval request was created for this verdict.'));
    return wrap;
  }

  const status = approvalRequest.status;
  const approvals = approvalRequest.approvals || {};

  if (status === 'applied') {
    wrap.appendChild(el('div', {
      'data-testid': 'diplomacy-applied',
      style: 'font-weight:600; color:var(--color-grade-a);',
    }, '✅ Applied — both keys turned; the resolution is sealed.'));
    const fp = shortFingerprint(approvalRequest.sealedRecord && approvalRequest.sealedRecord.fingerprint);
    if (fp) {
      wrap.appendChild(el('div', {
        'data-testid': 'diplomacy-sealed-fingerprint',
        style: `${MUTED} margin-top:var(--space-1); font-family:var(--font-mono, monospace);`,
      }, `sealed record ${fp}`));
    }
    return wrap;
  }

  if (status === 'rejected') {
    const by = approvalRequest.rejection && approvalRequest.rejection.by ? approvalRequest.rejection.by : 'a party';
    const note = approvalRequest.rejection && approvalRequest.rejection.note ? ` — "${approvalRequest.rejection.note}"` : '';
    wrap.appendChild(el('div', {
      'data-testid': 'diplomacy-rejected',
      style: 'font-weight:600; color:var(--color-grade-d);',
    }, `✋ Rejected by ${by}${note}. Nothing was applied.`));
    return wrap;
  }

  // Pending: one control block per party, EQUAL visual weight.
  const row = el('div', { style: 'display:flex; gap:var(--space-3); flex-wrap:wrap;' });
  for (const partyId of [partyAId, partyBId]) {
    const already = approvals[partyId] === true;
    const cell = el('div', {
      'data-testid': `diplomacy-party-${partyId}`,
      style: 'flex:1 1 0; min-width:0;',
    }, [el('div', { style: 'font-weight:600; margin-bottom:var(--space-1);' }, partyId)]);

    if (already) {
      cell.appendChild(el('div', {
        'data-testid': `diplomacy-approved-${partyId}`,
        style: `${MUTED}`,
      }, '✓ approved — waiting for the other key'));
    } else {
      const approveBtn = el('button', {
        type: 'button', class: 'btn btn-primary',
        'data-testid': `diplomacy-approve-${partyId}`,
      }, 'Approve');
      const rejectBtn = el('button', {
        type: 'button', class: 'btn btn-secondary',
        'data-testid': `diplomacy-reject-${partyId}`,
      }, 'Reject');
      // This button belongs to `partyId` and can ONLY act as `partyId`.
      approveBtn.addEventListener('click', () => onApprove(partyId));
      rejectBtn.addEventListener('click', () => onReject(partyId));
      cell.appendChild(el('div', { style: 'display:flex; gap:var(--space-2);' }, [approveBtn, rejectBtn]));
    }
    row.appendChild(cell);
  }
  wrap.appendChild(row);
  return wrap;
}

/**
 * Render the full Data Diplomacy panel into `host` (emptied first): the two
 * claim cards, the reconciliation verdict, and — only when the verdict
 * resolved — the two-key approval row. When unresolved, NO approval UI renders.
 *
 * Callback contract (mirrors renderConfirmGate): onApprove(partyId) /
 * onReject(partyId) do the actual engine call and then re-invoke this function
 * with the mutated approvalRequest, so the decided state re-renders in place.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {object} opts.claimA sealed claim
 * @param {object} opts.claimB competing sealed claim
 * @param {string} opts.partyAId
 * @param {string} opts.partyBId
 * @param {object} opts.reconciliationResult from reconcileClaims()
 * @param {object|null} [opts.approvalRequest] from createApprovalRequest() (null when unresolved)
 * @param {(partyId:string)=>void} [opts.onApprove]
 * @param {(partyId:string)=>void} [opts.onReject]
 * @returns {{reconciliationModel:object}|undefined}
 */
export function renderDiplomacyPanel(opts = {}) {
  const {
    host, claimA, claimB, partyAId, partyBId,
    reconciliationResult, approvalRequest = null,
    onApprove = () => {}, onReject = () => {},
  } = opts;
  if (!host) return;
  host.innerHTML = '';

  const reconciliationModel = buildReconciliationPanelModel(reconciliationResult);

  const wrap = el('div', { 'data-testid': 'diplomacy-panel', class: 'diplomacy-panel' });

  wrap.appendChild(el('div', {
    style: 'font-weight:600; margin-bottom:var(--space-1);', 'data-testid': 'diplomacy-heading',
  }, 'Data Diplomacy'));
  wrap.appendChild(el('p', {
    style: `${MUTED} margin:0 0 var(--space-3); line-height:1.5;`,
  }, 'Two sources disagree on the same fact. The engine below reconciles them if it honestly can; if it cannot, it says so and asks for human debate rather than guessing.'));

  // Two competing claim cards, side by side.
  wrap.appendChild(el('div', {
    'data-testid': 'diplomacy-claims',
    style: 'display:flex; gap:var(--space-3); flex-wrap:wrap; margin-bottom:var(--space-3);',
  }, [renderClaimCard(buildClaimCardModel(claimA)), renderClaimCard(buildClaimCardModel(claimB))]));

  // Reconciliation verdict.
  const verdict = el('div', {
    class: 'card', 'data-testid': 'diplomacy-reconciliation',
    'data-resolved': reconciliationModel.resolved ? 'true' : 'false',
  }, [
    el('div', { style: 'display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-2);' }, [
      el('span', { class: reconciliationModel.badgeClass, 'data-testid': 'diplomacy-verdict-badge' }, reconciliationModel.headline),
    ]),
    el('div', { style: `${MUTED} line-height:1.5;`, 'data-testid': 'diplomacy-rationale' }, reconciliationModel.rationale),
  ]);
  if (reconciliationModel.resolved) {
    verdict.appendChild(el('div', {
      style: 'margin-top:var(--space-2); font-weight:600;', 'data-testid': 'diplomacy-proposed-value',
    }, `Proposed value: ${reconciliationModel.proposedValueText} (from ${reconciliationModel.winningSource})`));
    if (reconciliationModel.marginText) {
      verdict.appendChild(el('div', { style: MUTED }, reconciliationModel.marginText));
    }
  }
  wrap.appendChild(verdict);

  // Two-key approval — ONLY when the engine actually resolved the conflict.
  if (reconciliationModel.showApproval) {
    wrap.appendChild(renderApprovalRow({ approvalRequest, partyAId, partyBId, onApprove, onReject }));
  }

  host.appendChild(wrap);
  return { reconciliationModel };
}
