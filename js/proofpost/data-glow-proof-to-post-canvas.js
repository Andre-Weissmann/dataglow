/* ---- from js/proofpost/data-glow-proof-to-post-canvas.js ---- */
/*
 * DATAGLOW - Proof to Post canvas surface.
 *
 * The panel that closes the loop: prove on the Proof Board, publish a file,
 * then copy a draft to post yourself. It is a thin surface. Every decision it
 * renders was made by a pure engine that can be tested without a browser, and
 * the only things this file owns are the DOM, the confirms and the clipboard.
 *
 * WHY EVERY OUTBOUND ARTIFACT ASKS FIRST.
 * A download and a clipboard write are the two ways data leaves this app. They
 * are the moments the zero-upload promise is actually kept or broken by a
 * person rather than by the architecture, so each one is a confirm a human has
 * to read. If the browser has no confirm the answer is no, because a silent yes
 * here writes a file nobody asked for.
 *
 * WHY THE STEPS GO GREY INSTEAD OF DISAPPEARING.
 * A hidden step teaches nothing. A visible step that says why it is not ready
 * yet tells the person what to go do. So Publish and Post render at all times
 * and carry their own blocker text.
 *
 * Everything is feature-detected. This panel mounts beside surfaces that may or
 * may not be inlined in a given build, and a missing engine removes a control
 * rather than throwing.
 */
;(function () {
  'use strict';

  var BTN_ID = 'dg-p2p-btn';
  var PANEL_ID = 'dg-p2p-panel';
  var STYLE_ID = 'dg-p2p-styles';
  var STEPS_ID = 'dg-p2p-steps';
  var DRAFT_ID = 'dg-p2p-draft';
  var GATE_ID = 'dg-p2p-gate';
  var COPY_ID = 'dg-p2p-copy';
  var COACH_ID = 'dg-p2p-coach';
  var REVIEW_ID = 'dg-p2p-review';

  var state = { open: false, published: false, reviewed: false, coachIndex: 0, coachOpen: false, pack: null };

  function flag(explicitKey, flagKey) {
    try { if (window[explicitKey] === false) return false; } catch (_e0) {}
    try { if (window[explicitKey] === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled(flagKey) !== false;
      }
    } catch (_e) {}
    return true;
  }

  function flagOn() { return flag('DATAGLOW_PROOF_TO_POST', 'proofToPost'); }
  function handoffOn() { return flag('DATAGLOW_BI_HANDOFF', 'biHandoff'); }
  function receiptOn() { return flag('DATAGLOW_DEID_RECEIPT', 'deidReceipt'); }
  function proveGateOn() { return flag('DATAGLOW_AI_PROVE_GATE', 'aiProveGate'); }

  function engine(name) {
    try { return window[name] || null; } catch (_e) { return null; }
  }

  /* The one prompt on this page a person cannot mistake for decoration. No
     confirm available means no. */
  function askHuman(question) {
    try {
      if (typeof window.confirm === 'function') return window.confirm(question) === true;
    } catch (_e) {}
    return false;
  }

  function toast(message) {
    try {
      if (typeof window.showToast === 'function') { window.showToast(message); return; }
    } catch (_e) {}
    try { console.log('[proof-to-post] ' + message); } catch (_e2) {}
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
    var css = [
      '#' + PANEL_ID + '{position:fixed;right:18px;bottom:74px;width:min(560px,calc(100vw - 36px));',
      'max-height:min(74vh,700px);overflow:auto;z-index:2147483000;display:none;',
      'background:var(--color-surface,#fff);color:var(--color-text,#1a1a1a);',
      'border:1px solid var(--color-border,#ddd);border-radius:10px;padding:16px 18px;',
      'box-shadow:0 12px 40px rgba(0,0,0,.22);font-size:14px;line-height:1.5}',
      '#' + PANEL_ID + ' h3{margin:0 0 4px;font-size:16px}',
      '#' + PANEL_ID + ' h4{margin:16px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;opacity:.7}',
      '.dg-p2p-step{border:1px solid var(--color-border,#ddd);border-radius:8px;padding:10px 12px;margin-bottom:8px}',
      '.dg-p2p-step.ready{border-color:#1f9d55;background:rgba(31,157,85,.06)}',
      '.dg-p2p-step.waiting{opacity:.72}',
      '.dg-p2p-step-t{font-weight:600;margin-bottom:2px}',
      '.dg-p2p-blocker{font-size:12px;color:#A12C7B;margin-top:4px}',
      '.dg-p2p-row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}',
      '.dg-p2p-btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:6px;cursor:pointer;',
      'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit}',
      '.dg-p2p-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dg-p2p-btn.primary{background:#20808D;border-color:#20808D;color:#fff}',
      '#' + DRAFT_ID + '{white-space:pre-wrap;font-family:inherit;background:var(--color-bg,#f7f7f7);',
      'border:1px solid var(--color-border,#e2e2e2);border-radius:8px;padding:12px 14px;margin:6px 0;font-size:13px}',
      '#' + GATE_ID + '{border-radius:8px;padding:10px 12px;margin:8px 0;font-size:13px}',
      '#' + GATE_ID + '.pass{background:rgba(31,157,85,.08);border:1px solid #1f9d55}',
      '#' + GATE_ID + '.fail{background:rgba(161,44,123,.08);border:1px solid #A12C7B}',
      '#' + GATE_ID + ' ul{margin:6px 0 0;padding-left:20px}',
      '.dg-p2p-note{font-size:12px;opacity:.75;margin-top:10px}',
      '.dg-p2p-empty{padding:14px;border:1px dashed var(--color-border,#ccc);border-radius:8px;text-align:center}',
      '#' + COACH_ID + '{border:1px solid #20808D;background:rgba(32,128,141,.07);border-radius:8px;',
      'padding:10px 12px;margin-bottom:10px;font-size:13px}',
      '#' + REVIEW_ID + '{margin-right:6px}',
      '@media (max-width:640px){#' + PANEL_ID + '{right:8px;left:8px;width:auto;bottom:64px}}',
    ].join('');
    var tag = el('style', { id: STYLE_ID });
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  /* ---- reading the rest of the app ------------------------------------- */

  function activeDataset() {
    try {
      if (typeof window.getActiveDataset === 'function') {
        var d = window.getActiveDataset();
        if (d) return d;
      }
    } catch (_e) {}
    try {
      if (window.state && Array.isArray(window.state.datasets) && window.state.datasets.length) {
        return window.state.datasets[0];
      }
    } catch (_e2) {}
    return null;
  }

  /* Tiles come from the Proof Board surface when it is open, and are otherwise
     recomputed from the loaded rows. Never invented: no dataset means no tiles
     and the panel says so. */
  function currentTiles() {
    var ui = engine('DataGlowProofBoardUI');
    try {
      if (ui && typeof ui.board === 'function') {
        var b = ui.board();
        if (b && Array.isArray(b.tiles) && b.tiles.length) return b.tiles;
      }
    } catch (_e) {}
    var tilesEngine = engine('DataGlowProofBoardTiles');
    var boardEngine = engine('DataGlowProofBoard');
    var ds = activeDataset();
    if (!tilesEngine || !boardEngine || !ds) return [];
    try {
      var raw = tilesEngine.tilesFromDataset(ds, {});
      var board = boardEngine.buildProofBoard(raw, { title: ds.name || '' });
      return board && Array.isArray(board.tiles) ? board.tiles : [];
    } catch (_e2) { return []; }
  }

  function buildPack() {
    var post = engine('DataGlowProofToPost');
    if (!post) return null;
    var ds = activeDataset();
    try {
      return post.buildProofToPostPack({
        tiles: currentTiles(),
        boardMeta: { title: (ds && ds.name) ? ds.name : '' },
        title: (ds && ds.name) ? ('What I found in ' + ds.name) : '',
        state: { published: state.published, reviewed: state.reviewed },
      });
    } catch (_e) { return null; }
  }

  /* ---- writing files out ------------------------------------------------ */

  function saveText(filename, mimeType, text) {
    var delivery = engine('ExportDelivery');
    try {
      if (delivery && typeof delivery.deliverText === 'function') {
        delivery.deliverText(text, { filename: filename, mimeType: mimeType });
        return true;
      }
    } catch (_e) {}
    try {
      var blob = new window.Blob([text], { type: mimeType });
      var url = window.URL.createObjectURL(blob);
      var a = el('a', { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      return true;
    } catch (_e2) { return false; }
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_e) {}
    return false;
  }

  /* ---- actions ---------------------------------------------------------- */

  function downloadPortfolio() {
    var pack = state.pack;
    if (!pack || pack.empty) { toast('There is nothing proved yet, so there is nothing to publish.'); return; }
    if (!askHuman('Write the portfolio markdown to your downloads folder?\n\nIt contains the numbers from the Proof Board and the queries that produced them.')) return;
    if (saveText('portfolio.md', 'text/markdown', pack.portfolioMarkdown)) {
      state.published = true;
      toast('Portfolio markdown saved.');
      render();
    }
  }

  function downloadGlowbook() {
    var gb = engine('DataGlowGlowbook');
    var boardEngine = engine('DataGlowProofBoard');
    if (!gb || !boardEngine) { toast('The Glowbook export is not available in this build.'); return; }
    var tiles = currentTiles();
    if (!tiles.length) { toast('There is nothing proved yet, so there is nothing to publish.'); return; }
    if (!askHuman('Write the Glowbook to your downloads folder?\n\nIt is one self-contained HTML file containing these numbers and the code behind them. Anyone you send it to can read all of it.')) return;
    try {
      var board = boardEngine.buildProofBoard(tiles, {});
      var model = gb.buildGlowbook(board, { confirmed: true });
      if (saveText('glowbook.html', 'text/html', gb.renderGlowbookHTML(model))) {
        state.published = true;
        toast('Glowbook saved.');
        render();
      }
    } catch (_e) { toast('The Glowbook could not be built from this board.'); }
  }

  function downloadHandoff() {
    var bi = engine('DataGlowBIHandoff');
    if (!bi) { toast('The hand-off pack is not available in this build.'); return; }
    var ds = activeDataset();
    var pack;
    try {
      pack = bi.buildHandoffPack({ dataset: ds, tiles: currentTiles() });
    } catch (_e) { toast('The hand-off pack could not be built.'); return; }
    var names = pack.manifest.map(function (f) { return f.name; }).join(', ');
    if (!askHuman('Write ' + pack.files.length + ' files to your downloads folder?\n\n' + names + '\n\nThis is a hand-off aid, not a Power BI or Tableau file, and it is not certified by either tool.')) return;
    var written = 0;
    for (var i = 0; i < pack.files.length; i++) {
      var f = pack.files[i];
      if (saveText(f.name, f.mimeType, f.text)) written++;
    }
    state.published = written > 0;
    toast(written + ' of ' + pack.files.length + ' hand-off files saved.');
    render();
  }

  function downloadDeidReceipt() {
    var receipt = engine('DataGlowDeidReceipt');
    var verifier = engine('DeidentificationVerifier');
    if (!receipt) { toast('The de-id receipt is not available in this build.'); return; }
    var ds = activeDataset();
    if (!ds || !Array.isArray(ds.columns) || !ds.columns.length) {
      toast('No data is loaded, so there is nothing to screen.');
      return;
    }
    if (!verifier || typeof verifier.buildDeidReport !== 'function') {
      toast('The Safe Harbor screen is not available in this build.');
      return;
    }
    if (!askHuman('Run the de-identification screen and write the receipt to your downloads folder?\n\nThis is an automated screening aid. It is NOT a HIPAA certification and it does not make this data safe to release.')) return;
    try {
      var samples = {};
      var rows = Array.isArray(ds.rows) ? ds.rows.slice(0, 200) : [];
      for (var c = 0; c < ds.columns.length; c++) {
        var name = ds.columns[c].name;
        var vals = [];
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          vals.push(Array.isArray(row) ? row[c] : row[name]);
        }
        samples[name] = vals;
      }
      var report = verifier.buildDeidReport({
        columns: ds.columns,
        samples: samples,
        table: ds.name || null,
        rowCount: Array.isArray(ds.rows) ? ds.rows.length : null,
      });
      var model = receipt.buildDeidReceipt(report, {});
      if (saveText('deid-screening-receipt.html', 'text/html', receipt.renderDeidReceiptHTML(model))) {
        toast('De-id screening receipt saved. It is a screening aid, not a certification.');
      }
    } catch (_e) { toast('The de-identification screen could not be run on this dataset.'); }
  }

  function copyDraft() {
    var pack = state.pack;
    if (!pack) return;
    if (!state.reviewed) { toast('Tick the review box first.'); return; }
    if (!pack.validation.ok) { toast('The draft still has a number that does not trace to a tile.'); return; }
    if (!askHuman('Copy this draft to your clipboard?\n\nDataGlow does not post it and has no connected account. You paste it yourself, wherever you choose.')) return;
    if (copyText(pack.linkedInDraft.text)) toast('Draft copied. Nothing was posted.');
    else toast('This browser did not allow a clipboard write. Select the draft text and copy it manually.');
  }

  /* ---- rendering -------------------------------------------------------- */

  function renderCoach(host) {
    var post = engine('DataGlowProofToPost');
    if (!post || !state.coachOpen) return;
    var model;
    try { model = post.postCoachModel(state.coachIndex); } catch (_e) { return; }
    if (!model) return;
    var box = el('div', { id: COACH_ID });
    box.appendChild(el('div', { style: 'font-weight:600' }, model.step.title));
    box.appendChild(el('div', {}, model.step.body));
    var row = el('div', { class: 'dg-p2p-row' });
    var next = el('button', { class: 'dg-p2p-btn' }, model.nextLabel);
    next.addEventListener('click', function () {
      if (model.isLast) { state.coachOpen = false; }
      else { state.coachIndex = model.index + 1; }
      render();
    });
    var skip = el('button', { class: 'dg-p2p-btn' }, 'Dismiss');
    skip.addEventListener('click', function () { state.coachOpen = false; render(); });
    row.appendChild(next);
    row.appendChild(skip);
    box.appendChild(row);
    box.appendChild(el('div', { class: 'dg-p2p-note' }, model.progress));
    host.appendChild(box);
  }

  function renderSteps(host, pack) {
    var wrap = el('div', { id: STEPS_ID });
    for (var i = 0; i < pack.steps.length; i++) {
      var s = pack.steps[i];
      var box = el('div', { class: 'dg-p2p-step ' + (s.ready ? 'ready' : 'waiting') });
      box.appendChild(el('div', { class: 'dg-p2p-step-t' }, (i + 1) + '. ' + s.title + (s.ready ? ' (done)' : '')));
      box.appendChild(el('div', {}, s.body));
      if (s.blocker) box.appendChild(el('div', { class: 'dg-p2p-blocker' }, s.blocker));
      wrap.appendChild(box);
    }
    host.appendChild(wrap);
  }

  function renderGate(host, pack) {
    if (!proveGateOn()) return;
    var v = pack.validation;
    var box = el('div', { id: GATE_ID, class: v.ok ? 'pass' : 'fail' });
    box.appendChild(el('div', { style: 'font-weight:600' }, v.ok ? 'Every number in this draft traces to a tile.' : 'This draft is refused.'));
    box.appendChild(el('div', {}, v.summary));
    var list = [];
    var k;
    for (k = 0; k < v.problems.length; k++) list.push(v.problems[k]);
    for (k = 0; k < v.cautions.length; k++) list.push(v.cautions[k]);
    if (list.length) {
      var ul = el('ul');
      for (k = 0; k < list.length; k++) ul.appendChild(el('li', {}, list[k]));
      box.appendChild(ul);
    }
    host.appendChild(box);
  }

  function renderBody(host) {
    var post = engine('DataGlowProofToPost');
    if (!post) {
      host.appendChild(el('div', { class: 'dg-p2p-empty' }, 'The Proof to Post engine is not available in this build.'));
      return;
    }
    var pack = buildPack();
    state.pack = pack;
    if (!pack) {
      host.appendChild(el('div', { class: 'dg-p2p-empty' }, 'The Proof to Post engine could not read the board.'));
      return;
    }

    renderCoach(host);

    if (pack.empty) {
      var empty = el('div', { class: 'dg-p2p-empty' });
      empty.appendChild(el('div', { style: 'font-weight:600;margin-bottom:6px' }, pack.emptyHeadline));
      empty.appendChild(el('div', {}, pack.emptyCta));
      host.appendChild(empty);
      host.appendChild(el('div', { class: 'dg-p2p-note' }, pack.disclaimer));
      return;
    }

    renderSteps(host, pack);

    host.appendChild(el('h4', {}, 'Publish'));
    var pubRow = el('div', { class: 'dg-p2p-row' });
    var gbBtn = el('button', { class: 'dg-p2p-btn' }, 'Download Glowbook');
    gbBtn.addEventListener('click', downloadGlowbook);
    if (!engine('DataGlowGlowbook')) gbBtn.disabled = true;
    pubRow.appendChild(gbBtn);
    var pfBtn = el('button', { class: 'dg-p2p-btn' }, 'Download portfolio markdown');
    pfBtn.addEventListener('click', downloadPortfolio);
    pubRow.appendChild(pfBtn);
    if (handoffOn() && engine('DataGlowBIHandoff')) {
      var biBtn = el('button', { class: 'dg-p2p-btn' }, 'Hand off to Power BI / Tableau');
      biBtn.addEventListener('click', downloadHandoff);
      pubRow.appendChild(biBtn);
    }
    if (receiptOn() && engine('DataGlowDeidReceipt') && engine('DeidentificationVerifier')) {
      var deBtn = el('button', { class: 'dg-p2p-btn' }, 'De-id screening receipt');
      deBtn.addEventListener('click', downloadDeidReceipt);
      pubRow.appendChild(deBtn);
    }
    host.appendChild(pubRow);

    host.appendChild(el('h4', {}, 'Post'));
    var pre = el('pre', { id: DRAFT_ID });
    pre.textContent = pack.linkedInDraft.text;
    host.appendChild(pre);

    if (pack.excluded.length) {
      var ex = el('div', { class: 'dg-p2p-note' });
      ex.textContent = 'Left out of the draft: ' + pack.excluded.map(function (e) {
        return (e.title || e.id) + ' (' + e.why + ')';
      }).join(' ');
      host.appendChild(ex);
    }

    renderGate(host, pack);

    var reviewRow = el('label', { class: 'dg-p2p-row', style: 'align-items:center;cursor:pointer' });
    var cb = el('input', { type: 'checkbox', id: REVIEW_ID });
    cb.checked = state.reviewed === true;
    cb.addEventListener('change', function () { state.reviewed = cb.checked === true; render(); });
    reviewRow.appendChild(cb);
    reviewRow.appendChild(el('span', {}, 'I reviewed these numbers.'));
    host.appendChild(reviewRow);

    var copyRow = el('div', { class: 'dg-p2p-row' });
    var copyBtn = el('button', { class: 'dg-p2p-btn primary', id: COPY_ID }, 'Copy draft');
    copyBtn.disabled = !(state.reviewed && pack.validation.ok);
    copyBtn.addEventListener('click', copyDraft);
    copyRow.appendChild(copyBtn);
    host.appendChild(copyRow);

    host.appendChild(el('div', { class: 'dg-p2p-note' }, pack.disclaimer));
  }

  function render() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = '';

    var head = el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:10px' });
    var titleWrap = el('div');
    titleWrap.appendChild(el('h3', {}, 'Proof to Post'));
    titleWrap.appendChild(el('div', { class: 'dg-p2p-note', style: 'margin:0' }, 'Prove it, publish it, then post it yourself.'));
    head.appendChild(titleWrap);
    var btns = el('div', { class: 'dg-p2p-row', style: 'margin:0' });
    var coachBtn = el('button', { class: 'dg-p2p-btn' }, 'Tips');
    coachBtn.addEventListener('click', function () { state.coachOpen = !state.coachOpen; state.coachIndex = 0; render(); });
    btns.appendChild(coachBtn);
    var closeBtn = el('button', { class: 'dg-p2p-btn' }, 'Close');
    closeBtn.addEventListener('click', close);
    btns.appendChild(closeBtn);
    head.appendChild(btns);
    panel.appendChild(head);

    renderBody(panel);
  }

  function open() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    state.open = true;
    panel.style.display = 'block';
    render();
  }

  function close() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    state.open = false;
    panel.style.display = 'none';
  }

  function anchorRight() {
    var ids = ['dg-pb-btn', 'dg-trust-ledger-btn', 'dg-air-gap-btn'];
    for (var i = 0; i < ids.length; i++) {
      var node = document.getElementById(ids[i]);
      if (!node) continue;
      try {
        var rect = node.getBoundingClientRect();
        if (rect && rect.width > 0) return Math.round(window.innerWidth - rect.left + 10);
      } catch (_e) {}
    }
    return 508;
  }

  function mount() {
    if (!flagOn()) return;
    if (document.getElementById(BTN_ID)) return;
    if (!document.body) return;
    styles();

    var btn = el('button', {
      id: BTN_ID,
      type: 'button',
      title: 'Turn the Proof Board into a portfolio page and a post draft',
      style: 'position:fixed;bottom:18px;right:' + anchorRight() + 'px;z-index:2147483000;'
        + 'font:inherit;font-size:13px;padding:7px 13px;border-radius:8px;cursor:pointer;'
        + 'border:1px solid var(--color-border,#ccc);background:var(--color-surface,#fff);color:inherit;'
        + 'box-shadow:0 2px 8px rgba(0,0,0,.14)',
    }, 'Proof to Post');
    btn.addEventListener('click', function () { if (state.open) close(); else open(); });
    document.body.appendChild(btn);

    document.body.appendChild(el('div', { id: PANEL_ID, role: 'dialog', 'aria-label': 'Proof to Post' }));
  }

  function boot() {
    try { mount(); } catch (_e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 950); });
  } else {
    setTimeout(boot, 950);
  }

  window.DataGlowProofToPostUI = {
    version: 1,
    mounted: function () { return !!document.getElementById(BTN_ID); },
    open: open,
    close: close,
    isOpen: function () { return state.open === true; },
    refresh: render,
    pack: function () { return state.pack; },
    tiles: currentTiles,
    downloadGlowbook: downloadGlowbook,
    downloadPortfolio: downloadPortfolio,
    downloadHandoff: downloadHandoff,
    downloadDeidReceipt: downloadDeidReceipt,
    copyDraft: copyDraft,
    coach: {
      start: function () { state.coachOpen = true; state.coachIndex = 0; render(); },
      dismiss: function () { state.coachOpen = false; render(); },
    },
  };
})();
/* ---- end js/proofpost/data-glow-proof-to-post-canvas.js ---- */
