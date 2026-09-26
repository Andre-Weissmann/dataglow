// ============================================================
// Data Diplomacy Tab (Batch 2) — Diplomacy tab wiring
// ============================================================
// Mounts the two-key reconciliation panel (js/diplomacy/diplomacy-ui.js) over
// the pure Batch-1 engine (js/diplomacy/*). The tab only exists in the bar
// when the dataDiplomacy flag is on (see renderTabBar); this function is the
// second, inner gate matching the meetingScribe precedent exactly.
//
// HONESTY NOTE: the two claims below are a hardcoded DEMO scenario, built with
// the real sealClaim()/reconcileClaims()/createApprovalRequest() -- NOT a
// data-loading feature. Wiring this to columns of the actually-loaded dataset
// (and to a real cross-device transport so the two keys are held by two
// different people) is deliberate future work, not this batch.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-26) -- byte-for-byte identical
// behavior, only the file location changed. Unlike Guarded Copilot/Proof Room,
// this tab needed NO dependency-injection object: every non-DOM-global
// identifier it calls (`state`, `engine`, `isEnabled`, `el`, `toast`, `$`, and
// all six diplomacy/* module functions) is already independently importable
// from its own source module, and none of it is read/written from anywhere
// else in main.js. All 6 module-level state variables below (`diplomacyMounted`,
// `diplomacyFormState`, `diplomacyReconcileState`, `diplomacyStatusText`,
// `diplomacyP2PTransport`, `diplomacyP2PShareStatusA/B`) were confirmed via a
// whole-file grep to be referenced ONLY within this function, so they moved
// here as local module state, matching the pattern already used for smaller
// batch-1 tabs with local state (Convergence/Crucible/DVC).

import { state } from '../state.js';
import { $, el, toast } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import * as engine from '../duckdb-engine.js';
import { sealClaim } from '../../diplomacy/diplomacy-claim.js';
import { reconcileClaims } from '../../diplomacy/reconciliation-engine.js';
import { createApprovalRequest, approve as approveDiplomacy, reject as rejectDiplomacy } from '../../diplomacy/diplomacy-approval-gate.js';
import { renderDiplomacyPanel } from '../../diplomacy/diplomacy-ui.js';
import { buildDiplomacyFormModel, renderDiplomacyLoader } from '../../diplomacy/diplomacy-loader.js';
import { createDiplomacyP2PTransport, NULL_DIPLOMACY_TRANSPORT } from '../../diplomacy/diplomacy-p2p-transport.js';

let diplomacyMounted = false;
// Batch 3: per-party form state -- replaces the hardcoded demo scenario.
let diplomacyFormState = {
  a: { table: '', entityIdCol: '', entityIdValue: '', valueCol: '', source: '', confidence: 0.8, sealedBy: 'analyst' },
  b: { table: '', entityIdCol: '', entityIdValue: '', valueCol: '', source: '', confidence: 0.8, sealedBy: 'reviewer' },
};
let diplomacyReconcileState = null; // { claimA, claimB, reconciliationResult, approvalRequest, partyAId, partyBId } | null
let diplomacyStatusText = null;
// Batch 4: P2P claim-exchange adapter (reuses the live Rooms transport when available).
let diplomacyP2PTransport = NULL_DIPLOMACY_TRANSPORT;
let diplomacyP2PShareStatusA = null; // 'sending' | 'sent' | 'failed' | null
let diplomacyP2PShareStatusB = null;

export async function renderDiplomacyTab() {
  const host = $('#diplomacy-body');
  if (!host) return;
  if (!isEnabled('dataDiplomacy')) { host.innerHTML = ''; diplomacyMounted = false; return; }

  host.innerHTML = '';
  diplomacyMounted = true;

  const datasets = state.datasets || [];
  const partyAId = (diplomacyFormState.a.sealedBy && diplomacyFormState.a.sealedBy.trim()) || 'analyst';
  const partyBId = (diplomacyFormState.b.sealedBy && diplomacyFormState.b.sealedBy.trim()) || 'reviewer';

  const modelA = buildDiplomacyFormModel({ partyId: 'a', datasets: datasets, currentValues: diplomacyFormState.a });
  const modelB = buildDiplomacyFormModel({ partyId: 'b', datasets: datasets, currentValues: diplomacyFormState.b });

  // Batch 3 loader: real form replacing the hardcoded demo.
  renderDiplomacyLoader({
    host: host,
    modelA: modelA,
    modelB: modelB,
    onChange: function(party, field, value) {
      diplomacyFormState[party][field] = value;
      // When table changes, reset column selections for that party.
      if (field === 'table') {
        diplomacyFormState[party].entityIdCol = '';
        diplomacyFormState[party].valueCol = '';
      }
      diplomacyReconcileState = null;
      diplomacyStatusText = null;
      renderDiplomacyTab();
    },
    onReconcile: async function() {
      diplomacyStatusText = 'Reconciling…';
      renderDiplomacyTab();
      try {
        // Look up the actual value from each dataset by querying DuckDB.
        const fa = diplomacyFormState.a;
        const fb = diplomacyFormState.b;

        const sqlA = 'SELECT "' + fa.valueCol + '" AS val FROM ' + fa.table +
          ' WHERE CAST("' + fa.entityIdCol + '" AS VARCHAR) = \'' + fa.entityIdValue.toString().replace(/'/g, '') + '\' LIMIT 1';
        const sqlB = 'SELECT "' + fb.valueCol + '" AS val FROM ' + fb.table +
          ' WHERE CAST("' + fb.entityIdCol + '" AS VARCHAR) = \'' + fb.entityIdValue.toString().replace(/'/g, '') + '\' LIMIT 1';

        const resA = await engine.runQuery(sqlA);
        const resB = await engine.runQuery(sqlB);

        const rowA = resA.rows && resA.rows[0];
        const rowB = resB.rows && resB.rows[0];

        if (!rowA) { diplomacyStatusText = 'No row found for Party A with that entity ID.'; renderDiplomacyTab(); return; }
        if (!rowB) { diplomacyStatusText = 'No row found for Party B with that entity ID.'; renderDiplomacyTab(); return; }

        const valueA = rowA.val !== undefined ? rowA.val : rowA[Object.keys(rowA)[0]];
        const valueB = rowB.val !== undefined ? rowB.val : rowB[Object.keys(rowB)[0]];

        const claimA = await sealClaim({
          entityId: fa.entityIdValue.toString(),
          field: fa.valueCol,
          value: valueA,
          confidence: fa.confidence,
          source: fa.source,
          sealedBy: fa.sealedBy || 'analyst',
        });
        const claimB = await sealClaim({
          entityId: fb.entityIdValue.toString(),
          field: fb.valueCol,
          value: valueB,
          confidence: fb.confidence,
          source: fb.source,
          sealedBy: fb.sealedBy || 'reviewer',
        });

        const reconciliationResult = reconcileClaims(claimA, claimB);
        const approvalRequest = reconciliationResult.resolved
          ? createApprovalRequest({ reconciliationResult, partyAId: claimA.sealedBy, partyBId: claimB.sealedBy })
          : null;

        diplomacyReconcileState = { claimA: claimA, claimB: claimB, reconciliationResult: reconciliationResult, approvalRequest: approvalRequest };
        diplomacyStatusText = null;
        renderDiplomacyTab();
      } catch (err) {
        diplomacyStatusText = 'Reconciliation error: ' + (err && err.message ? err.message : String(err));
        diplomacyReconcileState = null;
        renderDiplomacyTab();
      }
    },
    statusText: diplomacyStatusText,
  });

  // Batch 4: P2P claim sharing — if the Rooms broadcast transport is live and the
  // dataDiplomacyP2P flag is on, wire up a 'Share claim with peer' section.
  // The transport is created lazily once and reused across re-renders.
  if (isEnabled('dataDiplomacyP2P')) {
    // (Re-)wire the receive handler each render so it always reads the current formState.
    // The transport itself is a singleton for this tab session.
    if (!diplomacyP2PTransport.supported && typeof window !== 'undefined' && window.__dataglow_rooms_broadcast) {
      diplomacyP2PTransport = createDiplomacyP2PTransport({
        transport: window.__dataglow_rooms_broadcast,
        selfId: window.__dataglow_rooms_self_id || null,
      });
      diplomacyP2PTransport.onReceiveClaim(function(msg) {
        // Incoming sealed claim from a peer fills the OPPOSITE party's form state.
        // Convention: the local user is party A; the peer is party B.
        var claim = msg.claim;
        if (claim && typeof claim === 'object') {
          diplomacyFormState.b.source = claim.source || '';
          diplomacyFormState.b.sealedBy = claim.sealedBy || 'peer';
          diplomacyFormState.b.entityIdValue = claim.entityId || '';
          diplomacyFormState.b.valueCol = claim.field || '';
          if (typeof claim.confidence === 'number') diplomacyFormState.b.confidence = claim.confidence;
          toast('Received peer claim for ' + (claim.field || 'a field') + ' from ' + (msg.from || 'peer'), 'success');
          diplomacyReconcileState = null;
          diplomacyStatusText = null;
          renderDiplomacyTab();
        }
      });
    }

    // Render the P2P share section
    var p2pSection = el('div', {
      'data-testid': 'diplomacy-p2p-section',
      style: 'margin-top:var(--space-3); padding:var(--space-3); border:1px solid var(--color-border); border-radius:var(--radius-md);',
    });
    var p2pHeading = el('div', { style: 'font-weight:600; margin-bottom:var(--space-1);' });
    p2pHeading.textContent = 'Share claim with peer (Rooms)';
    p2pSection.appendChild(p2pHeading);

    if (!diplomacyP2PTransport.supported) {
      var p2pNotice = el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted);' });
      p2pNotice.textContent = 'Join a Room first to enable cross-device claim exchange.';
      p2pSection.appendChild(p2pNotice);
    } else {
      var shareRow = el('div', { style: 'display:flex; gap:var(--space-2); flex-wrap:wrap;' });
      var shareABtn = el('button', { type: 'button', class: 'btn btn-secondary', 'data-testid': 'diplomacy-share-a' });
      shareABtn.textContent = diplomacyP2PShareStatusA === 'sending' ? 'Sending...' :
        (diplomacyP2PShareStatusA === 'sent' ? 'Sent!' : 'Share my claim (Party A)');
      shareABtn.disabled = !modelA.isComplete || diplomacyP2PShareStatusA === 'sending';
      shareABtn.addEventListener('click', async function() {
        diplomacyP2PShareStatusA = 'sending';
        renderDiplomacyTab();
        var fa = diplomacyFormState.a;
        var claimPayload = { entityId: fa.entityIdValue, field: fa.valueCol, value: null, confidence: fa.confidence, source: fa.source, sealedBy: fa.sealedBy };
        var ok = await diplomacyP2PTransport.sendClaim(claimPayload);
        diplomacyP2PShareStatusA = ok ? 'sent' : 'failed';
        renderDiplomacyTab();
      });
      shareRow.appendChild(shareABtn);

      var shareBBtn = el('button', { type: 'button', class: 'btn btn-secondary', 'data-testid': 'diplomacy-share-b' });
      shareBBtn.textContent = diplomacyP2PShareStatusB === 'sending' ? 'Sending...' :
        (diplomacyP2PShareStatusB === 'sent' ? 'Sent!' : 'Share my claim (Party B)');
      shareBBtn.disabled = !modelB.isComplete || diplomacyP2PShareStatusB === 'sending';
      shareBBtn.addEventListener('click', async function() {
        diplomacyP2PShareStatusB = 'sending';
        renderDiplomacyTab();
        var fb = diplomacyFormState.b;
        var claimPayload = { entityId: fb.entityIdValue, field: fb.valueCol, value: null, confidence: fb.confidence, source: fb.source, sealedBy: fb.sealedBy };
        var ok2 = await diplomacyP2PTransport.sendClaim(claimPayload);
        diplomacyP2PShareStatusB = ok2 ? 'sent' : 'failed';
        renderDiplomacyTab();
      });
      shareRow.appendChild(shareBBtn);
      p2pSection.appendChild(shareRow);
    }
    host.appendChild(p2pSection);
  }

  // If reconciliation has been run, show the two-key verdict panel below the loader.
  if (diplomacyReconcileState) {
    const { claimA, claimB, reconciliationResult } = diplomacyReconcileState;
    let approvalRequest = diplomacyReconcileState.approvalRequest;
    const verdictHost = el('div', { 'data-testid': 'diplomacy-verdict-section', style: 'margin-top:var(--space-4);' });
    host.appendChild(verdictHost);
    const paint = function() {
      renderDiplomacyPanel({
        host: verdictHost,
        claimA: claimA, claimB: claimB,
        partyAId: claimA.sealedBy, partyBId: claimB.sealedBy,
        reconciliationResult: reconciliationResult, approvalRequest: approvalRequest,
        onApprove: async function(pid) {
          const res = await approveDiplomacy(approvalRequest, pid);
          if (!res.ok && res.error) toast(res.error, 'error');
          else if (res.bothApproved) toast('Both keys turned — resolution applied and sealed.', 'success');
          paint();
        },
        onReject: function(pid) {
          const res = rejectDiplomacy(approvalRequest, pid);
          if (!res.ok && res.error) toast(res.error, 'error');
          paint();
        },
      });
    };
    paint();
  }
}
