/* ---- from js/proof-harness/data-glow-proof-harness-canvas.js ---- */
;(function () {
  'use strict';

  /* Proof Harness v0 (VERDICT): the claim bar plus a review inbox that the
     MASTER PROMPT doctrine calls for, not a chat panel. Doctrine #8: "There is
     no chat panel. The surface is a claim bar plus a review inbox." v0's inbox
     is one card: the current claim's proposal, verdict and receipt.

     The pure engine (js/proof-harness/index.js + proposal.js + verdict.js +
     score-claim.js + receipt.js, published together as window.
     DataGlowProofHarness) owns typed proposals, the verdict decision, claim
     scoring and the hash-chained receipt ledger. This module owns only what
     the engine cannot: the button, the panel, and wiring the panel's Prove
     button to the SAME live DuckDB engine Drill Floor's SQL Run/Check path
     already uses (resolveDrillSqlRunQuery / window.engine.runQuery / the
     DuckDB singleton -- see Bundle 18 hotfix 5, #613). No second wasm load
     path is created here.

     DOCTRINE IN THIS FILE:
       1. AI proposes, engines prove, human confirms, in that order. The Prove
          button always runs BEFORE the Confirm button is enabled.
       2. No free-form execution: the SQL statement the Prove button runs is
          only ever handed to createTypedProposal() first; the executor
          (runQuery) is only ever called with proposal.statement, which is
          exactly what was typed into the visible, editable field, never a
          hidden or model-composed string.
       3. Never auto-mutate: nothing here writes to a saved session/table.
          Confirm only marks the CURRENT proposal as confirmed in memory,
          bound to its digest.
       6. Exactly three verdict colors in v0: GREEN / RED / GRAY. No AMBER.
       8. No chat panel. Claim bar + one card. No free text response area.

     No em dash (U+2014) anywhere in this file's visible strings. */

  var BTN_ID = 'dg-proof-harness-btn';
  var PANEL_ID = 'dg-proof-harness-panel';
  var STYLE_ID = 'dg-proof-harness-styles';
  var BODY_ID = 'dg-proof-harness-body';

  var _lastProposal = null;
  var _lastResult = null;

  function engine() { return window.DataGlowProofHarness || null; }

  /* Same optional-provider read as Trust Ledger / Air-Gap / Shield Packs: a
     flags provider is honored when present, and its absence means on, since
     canvas registers no provider today. window.DATAGLOW_PROOF_HARNESS is the
     explicit local override in either direction, matching window.
     DATAGLOW_TRUST_LEDGER's pattern. */
  function flagOn() {
    try { if (window.DATAGLOW_PROOF_HARNESS === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_PROOF_HARNESS === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('proofHarness') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[Proof Harness]', msg);
  }

  /* ---------------------------- SQL engine resolution --------------------
     Reuses the exact resolver Drill Floor's SQL Run/Check path uses (Bundle
     18 hotfix 5, #613), with the same graduated fallbacks, so there is never
     a second wasm load path and the warm SQL connection stays shared. */
  function resolveRunQuery() {
    if (typeof window.resolveDrillSqlRunQuery === 'function') {
      try {
        var q = window.resolveDrillSqlRunQuery();
        if (q) return q;
      } catch (_e0) {}
    }
    try {
      if (window.engine && typeof window.engine.runQuery === 'function') {
        return function (sql) { return window.engine.runQuery(sql, []); };
      }
    } catch (_e1) {}
    try {
      if (window.DuckDBEngine && typeof window.DuckDBEngine.runQuery === 'function') {
        return function (sql) { return window.DuckDBEngine.runQuery(sql, []); };
      }
    } catch (_e2) {}
    try {
      if (window._sqlEngineSingleton && typeof window._sqlEngineSingleton.runQuery === 'function') {
        return function (sql) { return window._sqlEngineSingleton.runQuery(sql, []); };
      }
    } catch (_e3) {}
    if (typeof window._dgGetSQLEngine === 'function') {
      return async function (sql) {
        var eng = await window._dgGetSQLEngine();
        if (!eng || typeof eng.runQuery !== 'function') {
          throw new Error('SQL engine not ready in this canvas.');
        }
        return eng.runQuery(sql, []);
      };
    }
    try {
      if (window.SQLEngine && typeof window.SQLEngine.init === 'function') {
        return async function (sql) {
          if (!window._sqlEngineSingleton) {
            window._sqlEngineSingleton = window.SQLEngine.init({});
            window.DuckDBEngine = window._sqlEngineSingleton;
            window.engine = window._sqlEngineSingleton;
          }
          return window._sqlEngineSingleton.runQuery(sql, []);
        };
      }
    } catch (_e4) {}
    return null;
  }

  /* ---------------------------- styles ------------------------------------ */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 12px;',
      'border-radius:10px;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
      '#' + BTN_ID + ':hover{color:var(--text,#E8EAED)}',
      '#' + BTN_ID + ' .dg-ph-dot{width:7px;height:7px;border-radius:50%;background:var(--primary,#20C5B5)}',
      '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);z-index:12095;',
      'display:none;flex-direction:column;background:var(--surface,#151820);',
      'border-left:1px solid var(--border,#282D38);box-shadow:-18px 0 48px rgba(0,0,0,.45)}',
      '#' + PANEL_ID + '.open{display:flex}',
      '#' + PANEL_ID + ' .dg-ph-head{display:flex;align-items:flex-start;justify-content:space-between;',
      'gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--border,#282D38)}',
      '#' + PANEL_ID + ' .dg-ph-title{font-size:16px;font-weight:800;margin:0}',
      '#' + PANEL_ID + ' .dg-ph-sub{font-size:12px;color:var(--text-muted,#9AA1AE);margin:4px 0 0;line-height:1.55}',
      '#' + PANEL_ID + ' .dg-ph-x{min-height:44px;min-width:44px;border:none;background:transparent;',
      'color:var(--text-muted,#9AA1AE);font-size:22px;cursor:pointer;border-radius:10px;flex:0 0 auto}',
      '#' + BODY_ID + '{flex:1;overflow-y:auto;padding:14px 18px;-webkit-overflow-scrolling:touch}',
      '#' + PANEL_ID + ' label{display:block;font-size:11.5px;font-weight:700;letter-spacing:.02em;',
      'color:var(--text-muted,#9AA1AE);margin:14px 0 6px;text-transform:uppercase}',
      '#' + PANEL_ID + ' label:first-child{margin-top:0}',
      '#' + PANEL_ID + ' textarea, #' + PANEL_ID + ' input[type=text]{width:100%;box-sizing:border-box;',
      'background:var(--bg,#0E1117);border:1px solid var(--border,#282D38);border-radius:10px;',
      'color:var(--text,#E8EAED);font:inherit;font-size:12.5px;padding:9px 10px;resize:vertical}',
      '#' + PANEL_ID + ' textarea.dg-ph-statement{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-height:76px}',
      '#' + PANEL_ID + ' textarea.dg-ph-claim{min-height:44px}',
      '#' + PANEL_ID + ' .dg-ph-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}',
      '#' + PANEL_ID + ' .dg-ph-btn{min-height:38px;padding:0 13px;border-radius:10px;font:inherit;font-size:12.5px;',
      'font-weight:700;cursor:pointer;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-ph-btn.primary{background:var(--primary,#20C5B5);color:#04201C;border-color:transparent}',
      '#' + PANEL_ID + ' .dg-ph-btn.primary:disabled{opacity:.45;cursor:not-allowed}',
      '#' + PANEL_ID + ' .dg-ph-btn:hover:not(:disabled){opacity:.9}',
      '#' + PANEL_ID + ' .dg-ph-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;',
      'border-radius:999px;font-size:13px;font-weight:800;letter-spacing:.02em;margin-top:14px}',
      '#' + PANEL_ID + ' .dg-ph-chip.GREEN{background:rgba(32,197,181,.14);color:var(--primary,#20C5B5);',
      'border:1px solid rgba(32,197,181,.4)}',
      '#' + PANEL_ID + ' .dg-ph-chip.RED{background:rgba(229,83,75,.14);color:var(--danger,#E5534B);',
      'border:1px solid rgba(229,83,75,.4)}',
      '#' + PANEL_ID + ' .dg-ph-chip.GRAY{background:rgba(154,161,174,.14);color:var(--text-muted,#9AA1AE);',
      'border:1px solid rgba(154,161,174,.4)}',
      '#' + PANEL_ID + ' .dg-ph-reason{font-size:12.5px;line-height:1.55;color:var(--text-secondary,#B4B8C0);margin:8px 0 0}',
      '#' + PANEL_ID + ' .dg-ph-receipt{margin-top:14px;padding:10px 12px;border-radius:10px;',
      'border:1px solid var(--border,#282D38);font-size:12px;line-height:1.7;color:var(--text-secondary,#B4B8C0)}',
      '#' + PANEL_ID + ' .dg-ph-receipt dt{color:var(--text-muted,#9AA1AE);display:inline}',
      '#' + PANEL_ID + ' .dg-ph-receipt dd{display:inline;margin:0 0 0 6px}',
      '#' + PANEL_ID + ' .dg-ph-receipt .dg-ph-kv{display:block}',
      '#' + PANEL_ID + ' .dg-ph-hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;',
      'word-break:break-all;color:var(--text-faint,var(--text-muted,#9AA1AE))}',
      '#' + PANEL_ID + ' .dg-ph-note{font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted,#9AA1AE));',
      'padding:12px 2px 4px}',
      '#' + PANEL_ID + ' .dg-ph-confirmed{margin-top:10px;font-size:12px;font-weight:700;color:var(--primary,#20C5B5)}',
      '@media (max-width:700px){',
      '#' + BTN_ID + '{min-height:44px}',
      '#' + PANEL_ID + '{width:100%;left:0;border-left:none}',
      '#' + PANEL_ID + ' .dg-ph-head{position:sticky;top:0;z-index:2;background:var(--surface,#151820)}',
      '#' + BODY_ID + '{padding:12px 14px}',
      '}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ---------------------------- panel ------------------------------------ */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Proof Harness');
    panel.innerHTML =
      '<div class="dg-ph-head">' +
        '<div style="min-width:0">' +
          '<p class="dg-ph-title">VERDICT</p>' +
          '<p class="dg-ph-sub">Paste a claim, prove it on this device, get a receipt you can re-run.</p>' +
        '</div>' +
        '<button type="button" class="dg-ph-x" data-ph-close aria-label="Close">&#215;</button>' +
      '</div>' +
      '<div id="' + BODY_ID + '"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-ph-close]').addEventListener('click', closePanel);
    return panel;
  }

  function verdictChip(state) {
    var label = state === 'GREEN' ? 'GREEN . proven' : state === 'RED' ? 'RED . refuted' : 'GRAY . not provable';
    return '<div class="dg-ph-chip ' + esc(state) + '">' + esc(label) + '</div>';
  }

  function receiptDetails(receipt, proposal, run) {
    if (!receipt) return '';
    var duration = run && typeof run.durationMs === 'number' ? run.durationMs + ' ms' : 'not run';
    var rowCount = run && typeof run.rowCount === 'number' ? String(run.rowCount) : 'n/a';
    return '<div class="dg-ph-receipt">' +
      '<span class="dg-ph-kv"><dt>Row count:</dt><dd>' + esc(rowCount) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Duration:</dt><dd>' + esc(duration) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Engine:</dt><dd>' + esc(proposal.engine) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Statement:</dt><dd class="dg-ph-hash">' + esc(proposal.statement) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Proposal digest:</dt><dd class="dg-ph-hash">' + esc(proposal.digest) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Receipt hash:</dt><dd class="dg-ph-hash">' + esc(receipt.hash) + '</dd></span>' +
      '</div>';
  }

  function renderBody() {
    var body = document.getElementById(BODY_ID);
    if (!body) return;
    var e = engine();
    if (!e) {
      body.innerHTML = '<div class="dg-ph-note">The Proof Harness engine is unavailable, so nothing can be proven here.</div>';
      return;
    }

    var claimText = _lastProposal && _lastProposal.claimText ? _lastProposal.claimText : '';
    var statementText = _lastProposal ? _lastProposal.statement : '';
    var canUseLastSql = (function () {
      var input = document.getElementById('sql-input');
      return !!(input && input.value && input.value.trim());
    })();

    var html = '';
    html += '<label for="dg-ph-claim">Claim</label>' +
      '<textarea id="dg-ph-claim" class="dg-ph-claim" placeholder="Paste the number or sentence you want proven, e.g. total revenue is 101018">' + esc(claimText) + '</textarea>';
    if (canUseLastSql) {
      html += '<div class="dg-ph-row"><button type="button" class="dg-ph-btn" data-ph-use-last-sql>Use last SQL result</button></div>';
    }

    html += '<label for="dg-ph-statement">Proposal statement (editable SQL)</label>' +
      '<textarea id="dg-ph-statement" class="dg-ph-statement" placeholder="select count(*) as n from your_table">' + esc(statementText) + '</textarea>';

    html += '<label for="dg-ph-expected-rowcount">Expected row count (optional)</label>' +
      '<input type="text" id="dg-ph-expected-rowcount" placeholder="e.g. 42" value="' +
      esc(_lastProposal && _lastProposal.expected && _lastProposal.expected.rowCount !== undefined ? _lastProposal.expected.rowCount : '') + '">';

    html += '<div class="dg-ph-row">' +
      '<button type="button" class="dg-ph-btn primary" data-ph-prove>Prove</button>' +
      '<button type="button" class="dg-ph-btn primary" data-ph-confirm' + (_lastResult && _lastResult.verdict ? '' : ' disabled') + '>Confirm</button>' +
      '</div>';

    if (_lastResult && _lastResult.verdict) {
      html += verdictChip(_lastResult.verdict.state);
      html += '<p class="dg-ph-reason">' + esc(_lastResult.verdict.reason) +
        (_lastResult.verdict.blocker ? ' ' + esc(_lastResult.verdict.blocker) : '') + '</p>';
      html += receiptDetails(_lastResult.receipt, _lastResult.proposal, _lastResult.run);
    }

    if (_lastConfirm) {
      if (_lastConfirm.confirmed) {
        html += '<p class="dg-ph-confirmed">Confirmed by ' + esc(_lastConfirm.by) + ' at ' + esc(_lastConfirm.at) + '. Bound to this exact statement.</p>';
      } else {
        html += '<p class="dg-ph-reason">' + esc(_lastConfirm.reason) + '</p>';
      }
    }

    html += '<div class="dg-ph-note">Nothing here uploads. The statement runs on your own device against the same DuckDB engine the SQL tab uses. A false green is treated as a bug, so an unclear result comes back gray with the missing piece named, never a guess.</div>';

    body.innerHTML = html;
    wireBody(body);
  }

  var _lastConfirm = null;

  function wireBody(body) {
    var useLastSqlBtn = body.querySelector('[data-ph-use-last-sql]');
    if (useLastSqlBtn) {
      useLastSqlBtn.addEventListener('click', function () {
        var input = document.getElementById('sql-input');
        var stmt = body.querySelector('#dg-ph-statement');
        if (input && stmt) {
          stmt.value = input.value;
          toast('Statement loaded from the SQL editor.', 'info');
        }
      });
    }

    var proveBtn = body.querySelector('[data-ph-prove]');
    if (proveBtn) {
      proveBtn.addEventListener('click', function () { onProve(body); });
    }

    var confirmBtn = body.querySelector('[data-ph-confirm]');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () { onConfirm(); });
    }
  }

  async function onProve(body) {
    var e = engine();
    if (!e) { toast('Proof Harness engine unavailable.', 'error'); return; }

    var claimText = (body.querySelector('#dg-ph-claim') || {}).value || '';
    var statement = (body.querySelector('#dg-ph-statement') || {}).value || '';
    var expectedRowCountRaw = (body.querySelector('#dg-ph-expected-rowcount') || {}).value || '';
    var expected = {};
    if (expectedRowCountRaw.trim() !== '' && !isNaN(Number(expectedRowCountRaw))) {
      expected.rowCount = Number(expectedRowCountRaw);
    }

    var runQuery = resolveRunQuery();
    if (!runQuery) {
      toast('SQL engine not ready in this canvas.', 'error');
    }

    var result = await e.runProofCycle({
      claimText: claimText,
      statement: statement,
      engine: 'duckdb',
      expected: expected,
      author: 'human',
      runQuery: runQuery || function () { throw new Error('SQL engine not ready in this canvas.'); },
    });

    if (!result.ok) {
      toast(result.error || 'The proposal could not be built.', 'error');
      return;
    }

    _lastProposal = result.proposal;
    _lastResult = result;
    _lastConfirm = null;

    if (window.DataGlowTrustLedger && typeof window.DataGlowTrustLedger.record === 'function') {
      try {
        window.DataGlowTrustLedger.record({
          kind: 'gate-verdict',
          subject: 'Proof Harness',
          summary: 'A claim was proven with verdict ' + result.verdict.state + '.',
          outcome: result.verdict.state === 'GREEN' ? 'clear' : (result.verdict.state === 'RED' ? 'blocked' : 'caution'),
          actor: 'you',
          detail: { state: result.verdict.state, reasonCode: result.verdict.reasonCode, digest: result.proposal.digest },
        });
      } catch (_e) {}
    } else if (typeof window.ledgerAppendFromSurface === 'function') {
      try {
        window.ledgerAppendFromSurface('proof-harness-verdict', {
          state: result.verdict.state,
          reasonCode: result.verdict.reasonCode,
          digest: result.proposal.digest,
        });
      } catch (_e) {}
    }

    renderBody();
    toast('Verdict: ' + result.verdict.state, result.verdict.state === 'GREEN' ? 'success' : (result.verdict.state === 'RED' ? 'error' : 'info'));
  }

  async function onConfirm() {
    var e = engine();
    if (!e || !_lastResult || !_lastResult.proposal) return;
    var body = document.getElementById(BODY_ID);
    var currentStatement = (body && body.querySelector('#dg-ph-statement') || {}).value || '';
    var proposalToCheck = Object.assign({}, _lastResult.proposal, { statement: currentStatement.trim() });
    var confirmResult = await e.confirmProposal(proposalToCheck, { by: 'local-user' });
    _lastConfirm = confirmResult;
    renderBody();
    toast(confirmResult.confirmed ? 'Confirmed and bound to this statement.' : confirmResult.reason, confirmResult.confirmed ? 'success' : 'error');
  }

  function isOpen() {
    var panel = document.getElementById(PANEL_ID);
    return !!(panel && panel.classList.contains('open'));
  }

  function openPanel() {
    if (!flagOn()) return false;
    ensurePanel().classList.add('open');
    renderBody();
    return true;
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  /* ---------------------------- mounting --------------------------------- */

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    ensureStyles();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open the Proof Harness');
    btn.title = 'VERDICT: prove a claim locally and get a receipt';
    btn.innerHTML = '<span class="dg-ph-dot" aria-hidden="true"></span><span>VERDICT</span>';
    btn.addEventListener('click', function () {
      if (isOpen()) closePanel(); else openPanel();
    });
    /* Next to Trust, so the whole "prove it, then trust it" posture reads as
       one row of buttons. Falls back the same way Trust Ledger's own button
       does when neither anchor exists. */
    var anchor = document.getElementById('dg-trust-ledger-btn') || document.getElementById('dg-air-gap-btn') || document.getElementById('dg-shield-packs-btn');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      if (anchor.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '400px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '400px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function boot() {
    if (flagOn()) {
      injectButton();
      ensurePanel();
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closePanel();
      });
    }
    /* Nothing new to publish on window: js/proof-harness/index.js already
       publishes window.DataGlowProofHarness with the pure engine calls this
       module wires into buttons. Publishing a second global here would be a
       second source of truth for exactly the thing doctrine #5 says must not
       fork. */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 860); });
  } else {
    setTimeout(boot, 860);
  }
})();
/* ---- end js/proof-harness/data-glow-proof-harness-canvas.js ---- */
