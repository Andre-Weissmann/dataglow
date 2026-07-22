/* ---- from js/ux/ethics-escape.js ---- */
/* ================================================================
   DataGlow Ethics Escape Hatch (Session C, PR #531)
   Steve Jobs audit: "Forgiveness Concern" -- no visible escape path
   from Purpose Contracts, Bias Preflight ethics flows.

   Fix:
   - Every ethics overlay/panel gets an X close button (top-right)
   - Every ethics overlay/panel gets a "Skip for now" link (bottom-left)
   - Skipping adds a subtle "Governance skipped" badge to the proof chain
   - Close/skip always returns analyst to where they were

   Selectors targeted:
     #purpose-contract-overlay, #purpose-contract-panel,
     #bias-preflight-overlay, #bias-preflight-panel,
     #training-passport-panel, #irb-mode-panel,
     .ethics-layer-panel, .governance-overlay
================================================================ */
(function () {
  'use strict';

  var ETHICS_SELECTORS = [
    '#purpose-contract-overlay',
    '#purpose-contract-panel',
    '#bias-preflight-overlay',
    '#bias-preflight-panel',
    '#training-passport-panel',
    '#irb-mode-panel',
    '.ethics-layer-panel',
    '.governance-overlay',
    '[data-ethics-panel]'
  ];

  var SKIPPED_PANELS = {};

  /* ---- Add escape controls to a panel ---- */
  function addEscapeControls(panel) {
    if (panel.dataset.escapeAdded) return;
    panel.dataset.escapeAdded = '1';

    /* X close button */
    var xBtn = document.createElement('button');
    xBtn.className = 'dg-ethics-close';
    xBtn.setAttribute('aria-label', 'Close');
    xBtn.setAttribute('data-testid', 'button-ethics-close');
    xBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>';
    xBtn.addEventListener('click', function () { closePanel(panel, false); });

    /* Skip for now link */
    var skipLink = document.createElement('button');
    skipLink.className = 'dg-ethics-skip';
    skipLink.setAttribute('data-testid', 'button-ethics-skip');
    skipLink.textContent = 'Skip for now';
    skipLink.addEventListener('click', function () { closePanel(panel, true); });

    panel.style.position = panel.style.position || 'relative';
    panel.appendChild(xBtn);
    panel.appendChild(skipLink);
  }

  /* ---- Close/skip a panel ---- */
  function closePanel(panel, skipped) {
    var panelId = panel.id || panel.className.split(' ')[0];

    if (skipped) {
      SKIPPED_PANELS[panelId] = Date.now();
      addSkippedBadge(panelId);
    }

    /* Hide the panel */
    panel.classList.add('hidden');
    panel.classList.remove('open');
    panel.style.display = 'none';

    /* Restore focus to the element that was focused before the overlay */
    if (panel._previousFocus && typeof panel._previousFocus.focus === 'function') {
      panel._previousFocus.focus();
    }

    document.dispatchEvent(new CustomEvent('dataglow:ethics-closed', {
      detail: { panelId: panelId, skipped: skipped }
    }));
  }

  /* ---- Add a "Governance skipped" badge to the proof chain ---- */
  function addSkippedBadge(panelId) {
    /* Try to find the proof rail or trust strip */
    var proofRail = document.querySelector(
      '#dg-proof-rail, .proof-rail, #trust-strip, .dg-trust-strip'
    );
    if (!proofRail) return;

    var badge = document.createElement('span');
    badge.className = 'dg-skipped-badge';
    badge.title = 'Governance step skipped: ' + panelId;
    badge.textContent = 'Governance skipped';
    badge.setAttribute('data-testid', 'badge-governance-skipped');
    proofRail.appendChild(badge);
  }

  /* ---- Intercept panel open events to record previous focus ---- */
  function onPanelOpen(panel) {
    panel._previousFocus = document.activeElement;
    addEscapeControls(panel);
  }

  /* ---- MutationObserver: catch panels that render dynamically ---- */
  function scanForEthicsPanels() {
    ETHICS_SELECTORS.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        /* Only add to visible panels */
        var isVisible = el.offsetParent !== null || el.style.display === 'flex';
        if (isVisible) {
          onPanelOpen(el);
        } else {
          /* Add controls preemptively for panels that are display:none */
          addEscapeControls(el);
        }
      });
    });
  }

  /* ---- Escape key support ---- */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    ETHICS_SELECTORS.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        var isVisible = el.offsetParent !== null ||
          (el.style.display && el.style.display !== 'none');
        if (isVisible) closePanel(el, false);
      });
    });
  });

  /* ---- Init ---- */
  function init() {
    scanForEthicsPanels();

    if (window.MutationObserver) {
      var obs = new MutationObserver(function (mutations) {
        var changed = mutations.some(function (m) {
          return m.addedNodes.length > 0 ||
            (m.type === 'attributes' && (m.attributeName === 'class' || m.attributeName === 'style'));
        });
        if (changed) scanForEthicsPanels();
      });
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }

    window.EthicsEscape = {
      getSkippedPanels: function () { return Object.assign({}, SKIPPED_PANELS); },
      hasSkipped: function () { return Object.keys(SKIPPED_PANELS).length > 0; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/ux/ethics-escape.js ---- */
