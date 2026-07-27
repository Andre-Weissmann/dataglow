/* ---- from js/proofboard/data-glow-proof-board-canvas.js ---- */
;(function () {
  'use strict';

  /* Proof Board: several numbers on one surface, each with its query under it.

     The pure engines own everything that can be decided without a screen:
       window.DataGlowProofBoard       the tile model, the board, the verify pass
       window.DataGlowProofBoardTiles  the tiles computed from the loaded rows
       window.DataGlowGlowbook         the portable HTML document
       window.DataGlowProofBoardCoach  the coach steps, as data
     This module owns only what they cannot: the button, the panel, the grid,
     and the two places a human has to say yes.

     WHERE THE NUMBERS COME FROM. window.state.datasets[0], read at the moment
     the panel is opened or refreshed. Every tile is arithmetic over those rows
     done in JavaScript, with the equivalent SQL printed beside it. There is no
     seed data, no sample board and no placeholder tile anywhere in this file:
     with no dataset loaded the grid shows its empty state and one call to
     action, because a board of illustrative numbers on a surface whose whole
     promise is "every number shows its work" would be a fabricated proof.

     THE TWO CONFIRMS. Export Glowbook asks before it writes a file, and Stamp
     receipt asks before it appends a row to the Trust Ledger. Both use the
     browser confirm, which is the only prompt on this page a person cannot
     mistake for decoration.

     WHAT IT DOES NOT REACH FOR. Portable receipts and the Proof Room are not
     present in this build, so the controls that would compose them are
     feature-detected and say why they are unavailable rather than appearing and
     failing. The Trust Ledger is present, so the stamp path uses it and gets its
     hash chain for free. No hashing or crypto is written here.

     Styles are injected at runtime, matching the other canvas surfaces. */

  var BTN_ID = 'dg-pb-btn';
  var PANEL_ID = 'dg-pb-panel';
  var STYLE_ID = 'dg-pb-styles';
  var GRID_ID = 'dg-pb-grid';
  var VERIFY_ID = 'dg-pb-verify';
  var EXPORT_ID = 'dg-pb-export';
  var COACH_ID = 'dg-pb-coach';

  var _board = null;
  var _extraTiles = [];
  var _coachIndex = 0;
  var _coachSteps = [];

  function boardEngine() { return window.DataGlowProofBoard || null; }
  function tilesEngine() { return window.DataGlowProofBoardTiles || null; }
  function glowbookEngine() { return window.DataGlowGlowbook || null; }
  function coachEngine() { return window.DataGlowProofBoardCoach || null; }
  function glassEngine() { return window.DataGlowGlassBoxEngine || null; }
  function ledger() { return window.DataGlowTrustLedger || null; }

  /* Same read as the other canvas surfaces: an explicit override wins, then a
     flags provider when one is registered, and the absence of both means on. */
  function flagOn() {
    try { if (window.DATAGLOW_PROOF_BOARD === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_PROOF_BOARD === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('proofBoard') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function coachFlagOn() {
    try { if (window.DATAGLOW_PROOF_BOARD_COACH === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_PROOF_BOARD_COACH === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('proofBoardCoach') !== false;
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
    console.info('[Proof Board]', msg);
  }

  /* The one prompt on this page a person cannot mistake for decoration. If the
     browser has no confirm the answer is no, because a silent yes here would
     write a file or a ledger row nobody asked for. */
  function askHuman(question) {
    try {
      if (typeof window.confirm === 'function') return window.confirm(question) === true;
    } catch (_e) {}
    return false;
  }

  function activeDataset() {
    if (typeof window.getActiveDataset === 'function') {
      try { var d = window.getActiveDataset(); if (d) return d; } catch (_e) {}
    }
    if (window.state && window.state.datasets && window.state.datasets[0]) {
      return window.state.datasets[0];
    }
    return null;
  }

  /* ------------------------------- styles --------------------------------- */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 12px;',
      'border-radius:10px;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
      '#' + BTN_ID + ':hover{color:var(--text,#E8EAED)}',
      '#' + BTN_ID + ' .dg-pb-dot{width:7px;height:7px;border-radius:50%;background:var(--primary,#20C5B5)}',
      '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:min(720px,100%);z-index:12100;',
      'display:none;flex-direction:column;background:var(--surface,#151820);',
      'border-left:1px solid var(--border,#282D38);box-shadow:-18px 0 48px rgba(0,0,0,.45)}',
      '#' + PANEL_ID + '.open{display:flex}',
      '#' + PANEL_ID + ' .dg-pb-head{display:flex;align-items:flex-start;justify-content:space-between;',
      'gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--border,#282D38)}',
      '#' + PANEL_ID + ' .dg-pb-title{font-size:16px;font-weight:800;margin:0}',
      '#' + PANEL_ID + ' .dg-pb-sum{font-size:12px;line-height:1.5;margin:4px 0 0;color:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-pb-x{min-width:36px;min-height:36px;border-radius:9px;border:1px solid var(--border,#282D38);',
      'background:transparent;color:var(--text-muted,#9AA1AE);font:inherit;font-size:15px;cursor:pointer}',
      '#' + PANEL_ID + ' .dg-pb-scroll{flex:1 1 auto;overflow-y:auto;padding:14px 18px 22px;',
      '-webkit-overflow-scrolling:touch}',
      /* Two columns on a desktop panel, one everywhere narrower. A tile whose
         query has wrapped to six lines beside a tile with a one-line query is
         still readable; three columns is not. */
      '#' + GRID_ID + '{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '@media (max-width:900px){#' + GRID_ID + '{grid-template-columns:minmax(0,1fr)}}',
      '.dg-pb-tile{border:1px solid var(--border,#282D38);border-radius:12px;padding:13px 14px;',
      'background:var(--surface-2,var(--bg,#0E1015));min-width:0}',
      '.dg-pb-tile-title{font-size:11.5px;font-weight:700;letter-spacing:.03em;margin:0;',
      'color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-val{font-size:27px;font-weight:800;margin:5px 0 0;letter-spacing:-.01em;',
      'color:var(--text,#E8EAED);word-break:break-word}',
      '.dg-pb-val-none{font-size:13px;font-weight:600;color:var(--warn,#E3A34A)}',
      '.dg-pb-badge{display:inline-block;margin:8px 0 0;padding:3px 9px;border-radius:999px;',
      'font-size:var(--dg-text-xs);font-weight:700;border:1px solid var(--border,#282D38);color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-badge[data-b="clear"]{border-color:var(--primary,#20C5B5);color:var(--primary,#20C5B5)}',
      '.dg-pb-badge[data-b="caution"]{border-color:var(--warn,#E3A34A);color:var(--warn,#E3A34A)}',
      '.dg-pb-badge[data-b="blocked"]{border-color:var(--danger,#E5534B);color:var(--danger,#E5534B)}',
      '.dg-pb-why{font-size:11.5px;line-height:1.5;margin:6px 0 0;color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-acts{display:flex;flex-wrap:wrap;gap:7px;margin:11px 0 0}',
      '.dg-pb-btn{min-height:38px;padding:0 12px;border-radius:10px;font:inherit;font-size:12px;',
      'font-weight:700;cursor:pointer;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-btn:hover{color:var(--text,#E8EAED)}',
      '.dg-pb-work{display:none;margin:11px 0 0;padding:11px 0 0;border-top:1px solid var(--border,#282D38)}',
      '.dg-pb-tile.open .dg-pb-work{display:block}',
      '.dg-pb-find{font-size:12.5px;line-height:1.55;margin:0;color:var(--text,#E8EAED)}',
      '.dg-pb-detail{font-size:11.5px;line-height:1.55;margin:4px 0 0;color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-ran{font-size:11px;margin:9px 0 5px;color:var(--text-muted,#9AA1AE);letter-spacing:.03em}',
      /* Wraps rather than scrolling sideways, so a phone is never trapped in a
         horizontal scroll to read the query behind a number. */
      'pre.dg-pb-src{margin:0;padding:10px 11px;border-radius:10px;max-height:300px;overflow-y:auto;',
      'overflow-x:hidden;background:var(--bg,#0E1015);border:1px solid var(--border,#282D38);',
      'font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;',
      'line-height:1.6;color:var(--text-secondary,#B4B8C0);white-space:pre-wrap;word-break:break-word}',
      '.dg-pb-note{font-size:11px;line-height:1.5;margin:9px 0 0;color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-problem{font-size:11.5px;line-height:1.5;margin:6px 0 0;color:var(--warn,#E3A34A)}',
      '.dg-pb-empty{border:1px dashed var(--border,#282D38);border-radius:12px;padding:22px 18px;text-align:center}',
      '.dg-pb-empty h3{font-size:14px;font-weight:700;margin:0 0 6px;color:var(--text,#E8EAED)}',
      '.dg-pb-empty p{font-size:12.5px;line-height:1.55;margin:0;color:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-pb-bar{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px;',
      'border-top:1px solid var(--border,#282D38);background:var(--surface,#151820)}',
      '#' + PANEL_ID + ' .dg-pb-foot{font-size:11px;line-height:1.5;padding:0 18px 14px;',
      'color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-verdict{border:1px solid var(--border,#282D38);border-radius:12px;padding:12px 13px;',
      'margin:14px 0 0;background:var(--surface-2,var(--bg,#0E1015))}',
      '.dg-pb-verdict h4{font-size:12.5px;font-weight:700;margin:0 0 6px;color:var(--text,#E8EAED)}',
      '.dg-pb-verdict ul{margin:6px 0 0;padding-left:18px}',
      '.dg-pb-verdict li{font-size:11.5px;line-height:1.55;color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-verdict li[data-pass="no"]{color:var(--danger,#E5534B)}',
      /* The coach strip sits in the flow above the grid. Nothing is dimmed and
         nothing is blocked, so the panel stays fully usable with it open. */
      '#' + COACH_ID + '{border:1px solid var(--primary,#20C5B5);border-radius:12px;padding:12px 13px;',
      'margin:0 0 13px;background:var(--surface-2,var(--bg,#0E1015))}',
      '#' + COACH_ID + '[hidden]{display:none}',
      '#' + COACH_ID + ' .dg-pb-coach-step{font-size:var(--dg-text-xs);font-weight:700;letter-spacing:.04em;',
      'margin:0;color:var(--primary,#20C5B5)}',
      '#' + COACH_ID + ' h4{font-size:13px;font-weight:700;margin:4px 0 0;color:var(--text,#E8EAED)}',
      '#' + COACH_ID + ' p{font-size:12px;line-height:1.55;margin:4px 0 0;color:var(--text-muted,#9AA1AE)}',
      '.dg-pb-spot{outline:2px solid var(--primary,#20C5B5);outline-offset:3px;border-radius:12px}',
      '@media (max-width:700px){',
      '#' + PANEL_ID + ' .dg-pb-bar .dg-pb-btn{flex:1 1 100%;min-height:44px}',
      '.dg-pb-btn{min-height:44px}',
      '.dg-pb-val{font-size:24px}',
      'pre.dg-pb-src{max-height:220px;font-size:11px}',
      '}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ------------------------------ the board ------------------------------- */

  function buildBoard() {
    var be = boardEngine();
    var te = tilesEngine();
    if (!be) return null;
    var ds = activeDataset();
    var rows = (ds && Array.isArray(ds.rows)) ? ds.rows : [];
    var cols = (ds && Array.isArray(ds.columns)) ? ds.columns : [];
    var fingerprint = (ds && typeof ds.fingerprint === 'string') ? ds.fingerprint : '';
    var tiles = (te && ds) ? te.tilesFromDataset(ds, { fingerprint: fingerprint }) : [];
    /* Tiles added by hand from a query result survive a rebuild, because the
       board is rebuilt every time the panel opens and losing them silently
       would be worse than not offering the button at all. They are appended
       rather than merged so a session tile never overwrites one. */
    if (_extraTiles.length) tiles = tiles.concat(_extraTiles);
    var l = ledger();
    var summary = '';
    try {
      if (l && typeof l.size === 'function') {
        var n = l.size();
        summary = n === 1
          ? '1 event was recorded on the Trust Ledger this session.'
          : n + ' events were recorded on the Trust Ledger this session.';
      }
    } catch (_e) {}
    _board = be.buildProofBoard(tiles, {
      datasetName: (ds && ds.name) || '',
      datasetFingerprint: fingerprint,
      rowCount: rows.length,
      columnCount: cols.length,
      generatedAt: Date.now(),
      trustLedgerSummary: summary
    });
    return _board;
  }

  /* --------------------------- rendering tiles ----------------------------- */

  function tileHTML(tile) {
    var h = '';
    h += '<article class="dg-pb-tile" data-tile="' + esc(tile.id) + '">';
    h += '<h3 class="dg-pb-tile-title">' + esc(tile.title || tile.id) + '</h3>';
    if (tile.valueText) {
      h += '<p class="dg-pb-val">' + esc(tile.valueText) + '</p>';
    } else {
      h += '<p class="dg-pb-val dg-pb-val-none">No value arrived for this tile. '
        + 'It is left empty rather than shown as a zero.</p>';
    }
    h += '<span class="dg-pb-badge" data-b="' + esc(tile.gateBadge) + '">'
      + esc(tile.badgeLabel) + '</span>';
    h += '<p class="dg-pb-why">' + esc(tile.badgeWhy) + '</p>';
    for (var p = 0; p < tile.problems.length; p++) {
      h += '<p class="dg-pb-problem">' + esc(tile.problems[p]) + '</p>';
    }
    h += '<div class="dg-pb-acts">';
    h += '<button type="button" class="dg-pb-btn" data-pb-work="' + esc(tile.id) + '"'
      + ' aria-expanded="false">Show the work</button>';
    if (ledger()) {
      h += '<button type="button" class="dg-pb-btn" data-pb-stamp="' + esc(tile.id) + '">'
        + 'Stamp receipt</button>';
    }
    h += '</div>';
    h += '<div class="dg-pb-work" data-pb-workbody="' + esc(tile.id) + '"></div>';
    h += '</article>';
    return h;
  }

  /* The proof under a tile is the GlassBox model, built by the shared engine so
     it renders here exactly as it does under a SQL result. When that engine is
     absent the tile still shows its query, because the query is the point. */
  function renderWork(tile, host) {
    var be = boardEngine();
    var ge = glassEngine();
    var h = '';
    if (be && ge) {
      var model = be.buildTileGlassBox(tile, ge.buildGlassBox);
      h += '<p class="dg-pb-find">' + esc(model.finding.headline) + '</p>';
      if (model.finding.detail) {
        h += '<p class="dg-pb-detail">' + esc(model.finding.detail) + '</p>';
      }
      if (model.math.available) {
        var ran = 'Ran by ' + model.math.engine;
        if (model.math.truncated) {
          ran += '. Showing the first ' + model.math.shownLines + ' of ' + model.math.lineCount + ' lines';
        }
        h += '<p class="dg-pb-ran">' + esc(ran) + '</p>';
        h += '<pre class="dg-pb-src">' + esc(model.math.source) + '</pre>';
      }
      for (var i = 0; i < model.missing.length; i++) {
        h += '<p class="dg-pb-note">' + esc(model.missing[i].why) + '</p>';
      }
      h += '<p class="dg-pb-note">' + esc(model.disclaimer) + '</p>';
    } else {
      h += '<p class="dg-pb-find">' + esc(tile.title || tile.id)
        + (tile.valueText ? ': ' + esc(tile.valueText) : '') + '</p>';
      if (tile.sqlOrCode) {
        h += '<p class="dg-pb-ran">Ran by ' + esc(tile.engine) + '</p>';
        h += '<pre class="dg-pb-src">' + esc(tile.sqlOrCode) + '</pre>';
      }
      h += '<p class="dg-pb-note">The shared proof panel is unavailable in this build, so the '
        + 'query is shown on its own. Nothing has been reconstructed.</p>';
    }
    host.innerHTML = h;
  }

  function tileById(id) {
    if (!_board || !Array.isArray(_board.tiles)) return null;
    for (var i = 0; i < _board.tiles.length; i++) {
      if (_board.tiles[i].id === id) return _board.tiles[i];
    }
    return null;
  }

  function toggleWork(id) {
    var tile = tileById(id);
    var art = document.querySelector('[data-tile="' + id + '"]');
    if (!tile || !art) return false;
    var btn = art.querySelector('[data-pb-work]');
    if (art.classList.contains('open')) {
      art.classList.remove('open');
      if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Show the work'; }
      return false;
    }
    renderWork(tile, art.querySelector('[data-pb-workbody]'));
    art.classList.add('open');
    if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Hide the work'; }
    return true;
  }

  /* A stamp is a Trust Ledger row carrying the claim, nothing more. The hash
     chain is the ledger's, and this bundle writes no crypto of its own. */
  function stampTile(id) {
    var be = boardEngine();
    var l = ledger();
    var tile = tileById(id);
    if (!be || !l || !tile) { toast('There is nothing to stamp', 'error'); return null; }
    var claim = be.tileReceiptClaim(tile, _board);
    var ok = askHuman('Record this number on the Trust Ledger for this session?\n\n'
      + claim.claim.statement + '\n\n'
      + 'The row stays on this device and is not uploaded. It is a record of what was '
      + 'computed, not a certification.');
    if (!ok) { toast('Nothing was recorded'); return null; }
    try {
      l.record({
        kind: 'claim-stamped',
        subject: claim.claim.label,
        summary: claim.claim.statement + ' Check result at the time: ' + tile.badgeLabel + '.',
        actor: 'proof-board',
        outcome: 'recorded',
        detail: {
          value: claim.claim.value,
          gateBadge: tile.gateBadge,
          language: tile.language,
          datasetFingerprint: claim.datasetFingerprint
        }
      });
    } catch (_e) {
      toast('Could not record the row', 'error');
      return null;
    }
    toast('Recorded on the Trust Ledger');
    return claim;
  }

  /* ------------------------------ board acts ------------------------------- */

  function verifyNow() {
    var be = boardEngine();
    if (!be || !_board) return null;
    var v = be.verifyBoard(_board);
    var host = document.getElementById('dg-pb-verdict');
    if (host) {
      var h = '<h4>' + esc(v.headline) + '</h4><ul>';
      for (var i = 0; i < v.checked.length; i++) {
        var c = v.checked[i];
        h += '<li data-pass="' + (c.pass ? 'yes' : 'no') + '">'
          + esc((c.pass ? 'Passed: ' : 'Did not pass: ') + c.what + ' ' + c.note) + '</li>';
      }
      h += '</ul><p class="dg-pb-note">What this pass does not cover:</p><ul>';
      for (var j = 0; j < v.cannotCheck.length; j++) {
        h += '<li>' + esc(v.cannotCheck[j]) + '</li>';
      }
      h += '</ul>';
      host.innerHTML = h;
      host.hidden = false;
    }
    return v;
  }

  function ledgerEntryLines() {
    var l = ledger();
    var out = [];
    try {
      if (!l || typeof l.getEntries !== 'function') return out;
      var rows = l.getEntries() || [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i] || {};
        out.push(String(r.kind || 'event') + ': ' + String(r.summary || ''));
      }
    } catch (_e) {}
    return out;
  }

  /* Writes one file, and only after a person has said yes. No network, no
     auto-export, and no upload anywhere in this path. */
  function exportGlowbook() {
    var gb = glowbookEngine();
    if (!gb || !_board) { toast('There is no board to export', 'error'); return null; }
    var tileCount = _board.tiles.length;
    var ok = askHuman('Write this board to one HTML file on this device?\n\n'
      + 'It will contain all ' + tileCount + ' tile(s), every number and every query behind them. '
      + 'Anyone you send the file to can read all of it.\n\n'
      + 'Nothing is uploaded. The file is written to your downloads.');
    if (!ok) { toast('Nothing was exported'); return null; }
    var model = gb.buildGlowbook(_board, {
      title: _board.datasetName ? 'Proof Board for ' + _board.datasetName : 'Proof Board',
      generatedAt: Date.now(),
      trustLedgerSummary: _board.trustLedgerSummary,
      trustLedgerEntries: ledgerEntryLines()
    });
    var blob = gb.glowbookBlob(model, _board.datasetName
      ? 'glowbook-' + _board.datasetName
      : 'glowbook');
    var url = '';
    try {
      url = URL.createObjectURL(new Blob([blob.data], { type: blob.mimeType }));
      var a = document.createElement('a');
      a.href = url;
      a.download = blob.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (_err) {
      if (url) URL.revokeObjectURL(url);
      toast('Could not write the file', 'error');
      return null;
    }
    setTimeout(function () { if (url) URL.revokeObjectURL(url); }, 1000);
    try {
      document.dispatchEvent(new CustomEvent('dataglow:export-triggered', {
        detail: { format: 'glowbook', rows: tileCount }
      }));
    } catch (_e2) {}
    toast('Saved ' + blob.filename + ' to this device');
    return { filename: blob.filename, bytes: blob.data.length };
  }

  /* ------------------------------- the coach ------------------------------- */

  function readFlag(key) {
    try { return window.localStorage.getItem(key); } catch (_e) { return null; }
  }

  function writeSeen() {
    var ce = coachEngine();
    if (!ce) return;
    try { window.localStorage.setItem(ce.COACH_SEEN_KEY, '1'); } catch (_e) {}
  }

  function clearSpotlight() {
    var lit = document.querySelectorAll('.dg-pb-spot');
    for (var i = 0; i < lit.length; i++) lit[i].classList.remove('dg-pb-spot');
  }

  function renderCoach() {
    var ce = coachEngine();
    var strip = document.getElementById(COACH_ID);
    if (!ce || !strip) return;
    var m = ce.coachStripModel(_coachSteps, _coachIndex);
    if (!m) { strip.hidden = true; return; }
    strip.hidden = false;
    strip.innerHTML =
      '<p class="dg-pb-coach-step">' + esc(m.progress) + '</p>'
      + '<h4>' + esc(m.step.title) + '</h4>'
      + '<p>' + esc(m.step.body) + '</p>'
      + '<div class="dg-pb-acts">'
      + (m.isFirst ? '' : '<button type="button" class="dg-pb-btn" data-pb-coach="back">Back</button>')
      + '<button type="button" class="dg-pb-btn" data-pb-coach="next">' + esc(m.nextLabel) + '</button>'
      + '<button type="button" class="dg-pb-btn" data-pb-coach="dismiss">Dismiss these tips</button>'
      + '</div>';
    clearSpotlight();
    var target = document.getElementById(m.step.target);
    if (target) target.classList.add('dg-pb-spot');
  }

  function closeCoach(remember) {
    var strip = document.getElementById(COACH_ID);
    if (strip) strip.hidden = true;
    clearSpotlight();
    if (remember) writeSeen();
  }

  function coachAction(what) {
    var ce = coachEngine();
    if (!ce) return;
    if (what === 'dismiss') { closeCoach(true); return; }
    if (what === 'back') { _coachIndex = ce.clampStep(_coachIndex - 1, _coachSteps.length); renderCoach(); return; }
    if (_coachIndex >= _coachSteps.length - 1) { closeCoach(true); return; }
    _coachIndex = ce.clampStep(_coachIndex + 1, _coachSteps.length);
    renderCoach();
  }

  function maybeStartCoach() {
    var ce = coachEngine();
    var strip = document.getElementById(COACH_ID);
    if (!ce || !strip) return;
    if (!ce.shouldShowCoach(readFlag, coachFlagOn())) { strip.hidden = true; return; }
    _coachSteps = ce.stepsForDom(function (id) { return !!document.getElementById(id); });
    if (_coachSteps.length === 0) { strip.hidden = true; return; }
    _coachIndex = 0;
    renderCoach();
  }

  /* ------------------------------ the panel -------------------------------- */

  function renderPanel() {
    var be = boardEngine();
    var board = buildBoard();
    var sum = document.getElementById('dg-pb-sum');
    if (sum && be) sum.textContent = be.summarizeBoard(board);

    var grid = document.getElementById(GRID_ID);
    if (!grid) return;
    if (!board || board.empty) {
      var state = (board && board.emptyState) || {
        headline: 'No data is loaded, so there is nothing to prove yet.',
        cta: 'Load a file to build a board from real numbers.'
      };
      grid.innerHTML = '<div class="dg-pb-empty"><h3>' + esc(state.headline) + '</h3>'
        + '<p>' + esc(state.cta) + '</p></div>';
      grid.style.gridTemplateColumns = 'minmax(0,1fr)';
    } else {
      var h = '';
      for (var i = 0; i < board.tiles.length; i++) h += tileHTML(board.tiles[i]);
      grid.innerHTML = h;
      grid.style.gridTemplateColumns = '';
    }
    var verdict = document.getElementById('dg-pb-verdict');
    if (verdict) { verdict.hidden = true; verdict.innerHTML = ''; }
  }

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
    ensureStyles();
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Proof Board');

    var links = '';
    /* Feature-detected rather than assumed. A link to a surface that is not in
       this build would be a dead end wearing a working button. */
    if (window.DataGlowTrustLedger) {
      links += '<button type="button" class="dg-pb-btn" data-pb-open="ledger">Open the Trust Ledger</button>';
    }
    if (window.DataGlowProofRoom) {
      links += '<button type="button" class="dg-pb-btn" data-pb-open="proofroom">Open the Proof Room</button>';
    }

    panel.innerHTML =
      '<div class="dg-pb-head">'
        + '<div><h2 class="dg-pb-title">Proof Board</h2>'
        + '<p class="dg-pb-sum" id="dg-pb-sum">Reading the loaded rows.</p></div>'
        + '<button type="button" class="dg-pb-x" data-pb-close aria-label="Close the Proof Board">&#10005;</button>'
      + '</div>'
      + '<div class="dg-pb-scroll">'
        + '<div id="' + COACH_ID + '" hidden></div>'
        + '<div id="' + GRID_ID + '"></div>'
        + '<div class="dg-pb-verdict" id="dg-pb-verdict" hidden></div>'
      + '</div>'
      + '<div class="dg-pb-bar">'
        + '<button type="button" class="dg-pb-btn" id="' + VERIFY_ID + '">Verify board</button>'
        + '<button type="button" class="dg-pb-btn" id="' + EXPORT_ID + '">Export Glowbook</button>'
        + '<button type="button" class="dg-pb-btn" data-pb-refresh>Rebuild from the data</button>'
        + links
      + '</div>'
      + '<p class="dg-pb-foot">'
        + esc((boardEngine() && boardEngine().PROOF_BOARD_DISCLAIMER)
          || 'This board shows the code that produced each number.')
      + '</p>';

    panel.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || typeof t.getAttribute !== 'function') return;
      if (t.hasAttribute('data-pb-close')) { closePanel(); return; }
      if (t.hasAttribute('data-pb-refresh')) { renderPanel(); toast('The board was rebuilt from the loaded rows'); return; }
      if (t.id === VERIFY_ID) { verifyNow(); return; }
      if (t.id === EXPORT_ID) { exportGlowbook(); return; }
      var work = t.getAttribute('data-pb-work');
      if (work) { toggleWork(work); return; }
      var stamp = t.getAttribute('data-pb-stamp');
      if (stamp) { stampTile(stamp); return; }
      var coach = t.getAttribute('data-pb-coach');
      if (coach) { coachAction(coach); return; }
      var open = t.getAttribute('data-pb-open');
      if (open === 'ledger' && window.DataGlowTrustLedger
        && typeof window.DataGlowTrustLedger.open === 'function') {
        window.DataGlowTrustLedger.open();
        return;
      }
      if (open === 'proofroom' && window.DataGlowProofRoom
        && typeof window.DataGlowProofRoom.open === 'function') {
        window.DataGlowProofRoom.open();
      }
    });

    document.body.appendChild(panel);
    return panel;
  }

  function isOpen() {
    var panel = document.getElementById(PANEL_ID);
    return !!(panel && panel.classList.contains('open'));
  }

  function openPanel() {
    var panel = ensurePanel();
    if (!panel) return false;
    panel.classList.add('open');
    renderPanel();
    maybeStartCoach();
    return true;
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
    clearSpotlight();
    return true;
  }

  /* ------------------------------- mounting -------------------------------- */

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    ensureStyles();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open the Proof Board');
    btn.title = 'Proof Board . every number with the query under it';
    btn.innerHTML = '<span class="dg-pb-dot" aria-hidden="true"></span><span>Proof</span>';
    btn.addEventListener('click', function () {
      if (isOpen()) closePanel(); else openPanel();
    });
    /* Beside the Trust Ledger, so the whole "can I trust this" row stays
       together. Falls back the same way the other surfaces do. */
    var anchor = document.getElementById('dg-trust-ledger-btn')
      || document.getElementById('dg-air-gap-btn')
      || document.getElementById('dg-shield-packs-btn');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      if (anchor.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '404px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '404px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function boot() {
    var mounted = false;
    if (flagOn()) {
      injectButton();
      ensurePanel();
      mounted = true;
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closePanel();
      });
    }

    /* Keep a number that came out of a query the user actually ran. The value
       is passed in by the caller and never guessed: an empty value is refused
       here as well as at the prompt, because a tile with no number is the one
       thing this board must never show. A tile added this way carries the
       `unknown` badge until a real check reports on it. */
    function addTile(tile) {
      var be = boardEngine();
      if (!be || !tile) return null;
      if (!be.hasValue(tile.value)) return null;
      var id = 'added-' + (_extraTiles.length + 1);
      var kept = {
        id: tile.id || id,
        title: tile.title || 'Result of a query',
        value: tile.value,
        unit: tile.unit || '',
        sqlOrCode: tile.sqlOrCode || '',
        language: tile.language || 'sql',
        engine: tile.engine || '',
        gateBadge: 'unknown',
        checksSummary: tile.checksSummary || 'No check has reported on this number.'
      };
      _extraTiles.push(kept);
      buildBoard();
      if (isOpen()) renderPanel();
      return kept;
    }

    /* Published whether or not the surface mounted, matching the other canvas
       surfaces: a caller can build a board without needing a panel to exist.
       With the flag off nothing mounted, so open() is the only way in and the
       button and panel are absent from the page. */
    window.DataGlowProofBoardUI = {
      version: 1,
      mounted: mounted,
      open: openPanel,
      close: closePanel,
      isOpen: isOpen,
      refresh: renderPanel,
      board: function () { return _board; },
      build: buildBoard,
      addTile: addTile,
      addedTiles: function () { return _extraTiles.slice(); },
      verify: verifyNow,
      exportGlowbook: exportGlowbook,
      stamp: stampTile,
      showWork: toggleWork,
      coach: {
        start: maybeStartCoach,
        step: function () { return _coachIndex; },
        steps: function () { return _coachSteps.slice(); },
        dismiss: function () { closeCoach(true); }
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 900); });
  } else {
    setTimeout(boot, 900);
  }
})();
/* ---- end js/proofboard/data-glow-proof-board-canvas.js ---- */
