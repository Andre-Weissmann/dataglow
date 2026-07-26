/* ---- from js/dataquality/data-glow-csv-quarantine-canvas.js ---- */
/*
 * DATAGLOW - The quarantine panel.
 *
 * When a CSV load leaves rows behind, this is where they go. A table of the
 * lines that did not parse, the column each one failed on, the reason DuckDB
 * gave, and the original text of the line. Then two buttons, neither of which
 * is pressed for you.
 *
 * WHY THIS IS A MODAL AND NOT A TOAST.
 * A toast saying "2,431 rows skipped" is technically a disclosure and
 * practically a dismissal. It appears while someone is looking at the table
 * that just loaded, it goes away on its own, and the decision it was reporting
 * has already been made by then. The load pauses here instead.
 *
 * WHY THE ORIGINAL LINE TEXT IS THE WIDEST COLUMN.
 * The reason string tells you what the parser thought. The line tells you what
 * is actually wrong, and it is usually obvious in one glance: a stray quote, a
 * comma inside an unquoted field, a footer row that is not data. Everything
 * else on the row is there to help you find that line.
 *
 * WHY THE RECEIPT IS WRITTEN ON BOTH OUTCOMES.
 * Keeping the good rows is a legitimate choice and abandoning the load is a
 * legitimate choice. Making either one without a record is how a total in a
 * deck ends up describing ninety-eight percent of a file with nothing anywhere
 * saying so.
 */
;(function () {
  'use strict';

  var PANEL_ID = 'dg-quarantine-panel';
  var STYLE_ID = 'dg-quarantine-styles';

  var state = { model: null, onDecision: null };

  function flag() {
    try { if (window.DATAGLOW_SQL_POWER_DEEPEN === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_SQL_POWER_DEEPEN === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('sqlPowerDeepen') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'style') node.setAttribute('style', attrs[k]);
        else if (k === 'class') node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '#' + PANEL_ID + '{position:fixed;inset:0;z-index:2147483000;display:none;'
      + 'align-items:center;justify-content:center;background:rgba(0,0,0,.42);padding:18px}'
      + '#' + PANEL_ID + ' .dg-q-box{background:var(--color-surface,#fff);color:inherit;'
      + 'border:1px solid var(--color-border,#ccc);border-radius:12px;box-shadow:0 16px 44px rgba(0,0,0,.28);'
      + 'width:min(880px,100%);max-height:88vh;overflow:auto;padding:16px 18px;font-size:13px;line-height:1.5}'
      + '#' + PANEL_ID + ' h3{margin:0 0 4px;font-size:16px}'
      + '#' + PANEL_ID + ' h4{margin:14px 0 4px;font-size:13px}'
      + '.dg-q-note{opacity:.78;font-size:12px}'
      + '.dg-q-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}'
      + '.dg-q-btn{font:inherit;font-size:13px;padding:7px 13px;border-radius:8px;cursor:pointer;'
      + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit}'
      + '.dg-q-btn[data-primary="true"]{border-width:2px;border-color:currentColor;font-weight:700}'
      + '.dg-q-tablewrap{max-height:320px;overflow:auto;border:1px solid var(--color-border,#ddd);border-radius:8px;margin-top:6px}'
      + '.dg-q-table{border-collapse:collapse;width:100%;font-size:12px}'
      + '.dg-q-table th,.dg-q-table td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--color-border,#eee);vertical-align:top}'
      + '.dg-q-table th{position:sticky;top:0;background:var(--color-surface,#fff);font-weight:700}'
      + '.dg-q-table td.dg-q-text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;max-width:380px}'
      + '.dg-q-choice{border:1px solid var(--color-border,#ddd);border-radius:9px;padding:9px 11px;margin:8px 0}';
    var tag = el('style', { id: STYLE_ID });
    tag.textContent = css;
    (document.head || document.body).appendChild(tag);
  }

  function receiptLine(model, decision) {
    try {
      var eng = window.DataGlowCsvQuarantine;
      if (eng && typeof eng.quarantineReceiptLine === 'function') {
        return eng.quarantineReceiptLine(model, decision);
      }
    } catch (_e) {}
    return null;
  }

  /* The receipt goes wherever this build keeps one. Every sink is optional and
     a build with none of them still gets the line in the console, because a
     decision with no record anywhere is the outcome this panel exists to
     prevent. */
  function recordReceipt(line) {
    if (!line) return;
    var wrote = false;
    try {
      var t = window.DataGlowTrustLedger;
      if (t && typeof t.record === 'function') { t.record(line); wrote = true; }
    } catch (_e) {}
    try {
      var c = window.DataGlowChainOfCustody;
      if (!wrote && c && typeof c.append === 'function') { c.append(line); wrote = true; }
    } catch (_e2) {}
    try {
      if (typeof window.showToast === 'function') window.showToast(line.line);
    } catch (_e3) {}
    try { console.log('[quarantine receipt] ' + line.line); } catch (_e4) {}
    try {
      window.DataGlowCsvQuarantineUI._lastReceipt = line;
    } catch (_e5) {}
  }

  /* Bundle 16: log the accept/reject decision onto the Repair Ledger. This is
     best-effort and never throws: a build without the ledger UI mounted
     still gets the receipt line above exactly as before, it just does not
     also get a ledger row. */
  function ledgerAppendQuarantine(model, decision, line) {
    try {
      var ui = window.DataGlowRepairLedgerUI;
      if (!ui || typeof ui.appendFromSurface !== 'function') return;
      var m = model || {};
      var kept = typeof m.keptRows === 'number' ? m.keptRows : null;
      var total = typeof m.totalRows === 'number' ? m.totalRows : null;
      ui.appendFromSurface('quarantine_decision', {
        engine: 'system',
        title: 'CSV quarantine: ' + decision,
        inputTable: m.table || m.fileName || '',
        summary: line && line.line ? line.line : ('Quarantine decision: ' + decision
          + (kept !== null && total !== null ? ' (' + kept + ' of ' + total + ' rows kept)' : '')),
        status: decision === 'abandon' ? 'skipped' : 'applied',
      });
    } catch (_e) {}
  }

  function decide(id) {
    var line = receiptLine(state.model, id);
    recordReceipt(line);
    ledgerAppendQuarantine(state.model, id, line);
    var cb = state.onDecision;
    hide();
    if (typeof cb === 'function') {
      try { cb({ decision: id, receipt: line, quarantine: state.model }); } catch (_e) {}
    }
  }

  function renderTable(host, rows) {
    var wrap = el('div', { class: 'dg-q-tablewrap' });
    var table = el('table', { class: 'dg-q-table' });
    var thead = el('thead');
    var hr = el('tr');
    var heads = ['Line', 'Column', 'Reason', 'What the parser said', 'The line itself'];
    for (var h = 0; h < heads.length; h++) hr.appendChild(el('th', {}, heads[h]));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var tr = el('tr');
      tr.appendChild(el('td', {}, r.line));
      tr.appendChild(el('td', {}, r.column));
      tr.appendChild(el('td', {}, r.reason));
      tr.appendChild(el('td', {}, r.message || ''));
      tr.appendChild(el('td', { class: 'dg-q-text' }, r.text || ''));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  function render() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    var m = state.model;
    panel.innerHTML = '';

    var box = el('div', { class: 'dg-q-box' });
    if (!m) {
      box.appendChild(el('h3', {}, 'Nothing is quarantined'));
      panel.appendChild(box);
      panel.style.display = 'flex';
      return;
    }

    box.appendChild(el('h3', {}, m.headline));
    box.appendChild(el('p', {}, m.detail));

    if (m.reasons && m.reasons.length) {
      box.appendChild(el('h4', {}, 'Why they failed'));
      var ul = el('ul', { class: 'dg-q-note' });
      for (var i = 0; i < m.reasons.length && i < 8; i++) {
        var rr = m.reasons[i];
        ul.appendChild(el('li', {}, rr.n + ' x ' + rr.reason + ' in ' + rr.column
          + (rr.example ? ' (for example: ' + rr.example + ')' : '')));
      }
      box.appendChild(ul);
    }

    if (m.rows && m.rows.length) {
      box.appendChild(el('h4', {}, 'The quarantined lines'));
      if (m.truncated) {
        box.appendChild(el('div', { class: 'dg-q-note' },
          'Showing the first ' + m.shown + ' of ' + m.droppedRows + '. The rest failed the same way or a similar one.'));
      }
      renderTable(box, m.rows);
    } else {
      box.appendChild(el('p', { class: 'dg-q-note' },
        'This build could not read the individual rejected lines back out of DuckDB, so only the count is available. The count is real.'));
    }

    box.appendChild(el('h4', {}, 'What happens next is your call'));
    for (var c = 0; c < m.choices.length; c++) {
      var ch = m.choices[c];
      var card = el('div', { class: 'dg-q-choice' });
      card.appendChild(el('b', {}, ch.label));
      card.appendChild(el('div', { class: 'dg-q-note' }, ch.consequence));
      box.appendChild(card);
    }

    var row = el('div', { class: 'dg-q-row' });
    var keep = el('button', { class: 'dg-q-btn', type: 'button', 'data-primary': 'true' }, m.choices[0].label);
    keep.addEventListener('click', function () { decide('keep_good'); });
    var abandon = el('button', { class: 'dg-q-btn', type: 'button' }, m.choices[1].label);
    abandon.addEventListener('click', function () { decide('abandon'); });
    row.appendChild(keep);
    row.appendChild(abandon);
    box.appendChild(row);

    box.appendChild(el('p', { class: 'dg-q-note' }, m.doctrine));

    panel.appendChild(box);
    panel.style.display = 'flex';
  }

  function mount() {
    if (!flag()) return false;
    if (document.getElementById(PANEL_ID)) return true;
    if (!document.body) return false;
    styles();
    document.body.appendChild(el('div', {
      id: PANEL_ID,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Rows that could not be parsed',
    }));
    return true;
  }

  /**
   * Show the panel for a quarantine model.
   *
   * `onDecision` is called with the decision id and the receipt line after the
   * person chooses. There is no close button and no escape path that skips the
   * choice, because a load left in an undecided state is worse than either
   * answer.
   */
  function show(model, onDecision) {
    if (!flag()) {
      // Flag off means no panel. The caller still gets an answer so a load does
      // not hang waiting for a surface that was never mounted.
      if (typeof onDecision === 'function') onDecision({ decision: 'keep_good', receipt: null, quarantine: model });
      return false;
    }
    if (!mount()) return false;
    state.model = model || null;
    state.onDecision = typeof onDecision === 'function' ? onDecision : null;
    render();
    return true;
  }

  function hide() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';
    state.onDecision = null;
  }

  /** Build the model from raw pieces, then show it. The convenience entry. */
  function showFor(input, onDecision) {
    var eng = null;
    try { eng = window.DataGlowCsvQuarantine; } catch (_e) {}
    if (!eng || typeof eng.buildQuarantine !== 'function') return false;
    var model;
    try { model = eng.buildQuarantine(input); } catch (_e2) { return false; }
    if (model.clean) {
      // Nothing was dropped, so there is nothing to decide and no modal. The
      // clean receipt is still written, because "we checked and it was fine" is
      // a useful thing to have on the record.
      recordReceipt(receiptLine(model, 'keep_good'));
      ledgerAppendQuarantine(model, 'clean', receiptLine(model, 'keep_good'));
      if (typeof onDecision === 'function') onDecision({ decision: 'clean', receipt: null, quarantine: model });
      return false;
    }
    return show(model, onDecision);
  }

  window.DataGlowCsvQuarantineUI = {
    version: 1,
    mounted: function () { return !!document.getElementById(PANEL_ID); },
    enabled: flag,
    open: show,
    openFor: showFor,
    close: hide,
    isOpen: function () {
      var p = document.getElementById(PANEL_ID);
      return !!p && p.style.display === 'flex';
    },
    model: function () { return state.model; },
    _lastReceipt: null,
  };
})();
/* ---- end js/dataquality/data-glow-csv-quarantine-canvas.js ---- */
