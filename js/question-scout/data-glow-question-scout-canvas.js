;(function () {
  'use strict';

  /* ============================================================
     DATAGLOW - Question Scout (A49) canvas UI
     ============================================================
     Implements A49_QUESTION_SCOUT_SPEC.md's panel: profile strip, Propose
     (local model when warm, deterministic templates when cold), a candidate
     list with Keep/Edit/Reject, a keepers tray (max 5), Send to Prove
     prefill, an honest professional-vs-cheating banner, and a profile-only
     Browse mode chat.

     DOCTRINE (restated from the SPEC, enforced by this file):
       1. AI proposes. Human chooses. Engines prove. Human confirms before
          portfolio/post. This panel NEVER calls a SQL engine and NEVER marks
          anything proven -- "Send to Prove" only prefills the Proof Harness's
          own editable fields; the human still clicks Prove there.
       2. Never auto-mutate data. Keep/Edit/Reject only change in-memory
          panel state.
       3. Never invent numeric findings. Browse mode answers that assert a
          number are flagged "unverified - run Prove" (see
          js/question-scout/question-scout.js's annotateUnverifiedNumbers).
       4. Local-first: the profile summary handed to the model/prompt never
          includes raw row data, only the same profile-strip shown on screen.

     The pure engine (js/question-scout/question-scout.js, published as
     window.DataGlowQuestionScout) owns profiling, deterministic scoring,
     template fallback, prompt construction, and prefill mapping. This module
     owns only what the engine cannot: the button, the panel, rendering, and
     wiring "Propose" to the existing local AI bridge
     (js/narrative/ondevice-llm.js's loadModel()/isModelLoaded() pattern)
     when it is warm, falling back to the deterministic templates
     immediately (no blocking on a cold/absent model) otherwise.

     No em dash (U+2014) anywhere in this file's visible strings. */

  var BTN_ID = 'dg-question-scout-btn';
  var PANEL_ID = 'dg-question-scout-panel';
  var STYLE_ID = 'dg-question-scout-styles';
  var BODY_ID = 'dg-question-scout-body';

  var _candidates = [];   // current ranked candidate list (post deterministic filter)
  var _keepers = [];      // accepted keepers (max 5, enforced by engine.addKeeper)
  var _rejected = {};     // id -> true, hidden from the active list
  var _editingId = null;  // candidate id currently in edit mode
  var _lastProposeMode = null; // 'model' | 'template' | null (nothing proposed yet)
  var _browseHistory = []; // [{role:'user'|'assistant', text}]
  var _browseBusy = false;

  function engine() { return window.DataGlowQuestionScout || null; }

  /* Optional-provider flag read, same pattern as Proof Harness / Trust
     Ledger / Air-Gap: a flags provider is honored when present, its absence
     means on, and an explicit window override always wins in either
     direction. */
  function flagOn() {
    try { if (window.DATAGLOW_QUESTION_SCOUT === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_QUESTION_SCOUT === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('questionScout') !== false;
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
    console.info('[Question Scout]', msg);
  }

  /* ---------------------------- table discovery ---------------------------
     Best-effort: looks for a few shapes DataGlow has used elsewhere in this
     canvas for "the currently loaded tables" without inventing a new global
     contract. Always falls back to an empty list (never throws), which the
     engine's buildProfileStrip() renders as an honest empty/cold state. */
  function discoverTables() {
    try {
      if (typeof window.dgGetLoadedTables === 'function') {
        var t = window.dgGetLoadedTables();
        if (Array.isArray(t)) return t;
      }
    } catch (_e0) {}
    try {
      if (window.DataGlowTables && Array.isArray(window.DataGlowTables.list)) {
        return window.DataGlowTables.list;
      }
    } catch (_e1) {}
    try {
      if (Array.isArray(window._dgLoadedTables)) return window._dgLoadedTables;
    } catch (_e2) {}
    try {
      if (window.dataset && (Array.isArray(window.dataset.columns) || Array.isArray(window.dataset.rows))) {
        return [window.dataset];
      }
    } catch (_e3) {}
    return [];
  }

  /* ---------------------------- local AI bridge ---------------------------
     Wires to the EXISTING local AI bridge this canvas already ships:
     js/narrative/ondevice-llm.js is inlined earlier in this same file and
     publishes window.OnDeviceLLM (isModelLoaded/isModelLoading/loadModel/
     MODEL_ID/MODEL_LABEL -- see the "from js/narrative/ondevice-llm.js"
     canvas section). Scout reuses that SAME bridge rather than standing up
     a second model-loading path: `window.OnDeviceLLM.loadModel()` resolves
     to the live MLC engine handle exactly like Story's synthesizeFindings()
     obtains it, and this module only ever calls chat.completions.create()
     on that handle -- no separate WebLLM import, no separate model choice.
     If window.OnDeviceLLM is absent (older build) Propose falls straight to
     the deterministic templates with no error surfaced, since a cold/absent
     model is an expected, honest state, not a bug. This module NEVER
     triggers a model DOWNLOAD on its own; it only uses the model if
     isModelLoaded() is ALREADY true, matching the SPEC's "do not block
     Scout on big models". */
  function localLlmBridge() {
    try {
      var b = window.OnDeviceLLM;
      if (b && typeof b.isModelLoaded === 'function') return b;
    } catch (_e) {}
    return null;
  }

  function modelIsWarm() {
    var b = localLlmBridge();
    try { return !!(b && b.isModelLoaded()); } catch (_e) { return false; }
  }

  /* Runs the model with the engine's pure prompt builder. Returns a Promise
     resolving to parsed candidates (never rejects -- any model error
     degrades to null so the caller falls back to templates). */
  function proposeViaModel(profileStrip) {
    var e = engine();
    var bridge = localLlmBridge();
    if (!e || !bridge || !modelIsWarm()) return Promise.resolve(null);
    try {
      var prompt = e.buildScoutPrompt(profileStrip);
      // loadModel() resolves immediately (no re-download) once modelIsWarm()
      // is true -- it returns the SAME cached engine promise ondevice-llm.js
      // already holds, per that module's `if (enginePromise) return
      // enginePromise;` guard.
      return bridge.loadModel().then(function (mlcEngine) {
        return mlcEngine.chat.completions.create({
          messages: prompt.messages, temperature: 0.4, max_tokens: 900, stream: false,
        });
      }).then(function (res) {
        var text = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
        return e.parseModelCandidates(text || '');
      }).catch(function () { return null; });
    } catch (_e) {}
    return Promise.resolve(null);
  }

  /* Single free-form completion against the same warm bridge, used by Browse
     mode. Returns a Promise<string|null>; never rejects. */
  function chatOnceViaBridge(messages) {
    var bridge = localLlmBridge();
    if (!bridge || !modelIsWarm()) return Promise.resolve(null);
    try {
      return bridge.loadModel().then(function (mlcEngine) {
        return mlcEngine.chat.completions.create({ messages: messages, temperature: 0.4, max_tokens: 400, stream: false });
      }).then(function (res) {
        return (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || null;
      }).catch(function () { return null; });
    } catch (_e) { return Promise.resolve(null); }
  }

  /* ---------------------------- Propose flow ------------------------------
     1. Always compute the deterministic profile strip.
     2. Try the model ONLY if it is already warm (no download triggered here).
     3. If the model returns nothing usable, fall back to deterministic
        templates -- Scout must work with the model offline (SPEC acceptance
        #6). Every candidate is scored by the deterministic filter either
        way, so a model candidate can never bypass the rule-based ranking. */
  function propose() {
    var e = engine();
    if (!e) { toast('Question Scout engine unavailable.', 'error'); return; }
    var tables = discoverTables();
    var profileStrip = e.buildProfileStrip(tables);
    renderBody(profileStrip, true /* proposing */);

    proposeViaModel(profileStrip).then(function (modelCandidates) {
      var templateCandidates = e.templateCandidatesFromProfile(profileStrip);
      var usedModel = Array.isArray(modelCandidates) && modelCandidates.length > 0;
      var pool = usedModel ? modelCandidates.concat(templateCandidates) : templateCandidates;
      var ranked = e.rankCandidates(pool, profileStrip).slice(0, e.MAX_CANDIDATES);
      _candidates = ranked;
      _rejected = {};
      _lastProposeMode = usedModel ? 'model' : 'template';
      renderBody(profileStrip, false);
      toast(usedModel
        ? 'Question Scout proposed candidates using the on-device model.'
        : 'On-device model is cold/unavailable -- showing template candidates (no model).', 'info');
    });
  }

  /* ---------------------------- Keep / Edit / Reject ----------------------- */
  function keepCandidate(id) {
    var e = engine();
    if (!e) return;
    var c = _candidates.find(function (x) { return x.id === id; });
    if (!c) return;
    if (_keepers.length >= e.MAX_KEEPERS && !_keepers.some(function (k) { return k.id === id; })) {
      toast('Keepers tray is full (max ' + e.MAX_KEEPERS + '). Remove one first.', 'warning');
      return;
    }
    _keepers = e.addKeeper(_keepers, c);
    renderBody(null, false);
  }

  function removeKeeperFromTray(id) {
    var e = engine();
    if (!e) return;
    _keepers = e.removeKeeper(_keepers, id);
    renderBody(null, false);
  }

  function rejectCandidate(id) {
    _rejected[id] = true;
    _keepers = _keepers.filter(function (k) { return k.id !== id; });
    renderBody(null, false);
  }

  function startEdit(id) {
    _editingId = id;
    renderBody(null, false);
  }

  function saveEdit(id, newText, newSql) {
    var idx = _candidates.findIndex(function (x) { return x.id === id; });
    if (idx === -1) return;
    var e = engine();
    var updated = Object.assign({}, _candidates[idx], { text: newText, sql: newSql, edited: true });
    if (e) {
      var strip = e.buildProfileStrip(discoverTables());
      var detail = e.scoreCandidate(updated, strip);
      updated.score = detail.score;
      updated.scoreDetail = detail;
    }
    _candidates[idx] = updated;
    // If this candidate was already a keeper, keep the tray copy in sync.
    var kIdx = _keepers.findIndex(function (k) { return k.id === id; });
    if (kIdx !== -1) _keepers[kIdx] = updated;
    _editingId = null;
    renderBody(null, false);
  }

  /* ---------------------------- Send to Prove ------------------------------
     Never runs SQL itself. Prefers a real Proof Harness prefill hook if the
     Proof Harness canvas module (js/proof-harness/data-glow-proof-harness-
     canvas.js) has published one; otherwise falls back to dispatching a
     CustomEvent + copying the statement into a visible field so the human
     can still act on it, matching SPEC acceptance #4 ("prefills SQL/claim
     when Prove API exists; else copies statement to a visible field /
     dispatches existing event"). */
  function sendToProve(id) {
    var e = engine();
    var c = _keepers.find(function (k) { return k.id === id; }) || _candidates.find(function (x) { return x.id === id; });
    if (!e || !c) return;
    var prefill = e.buildProvePrefill(c);
    if (!prefill) return;

    var handled = false;
    try {
      if (typeof window.dgOpenProofHarnessWithPrefill === 'function') {
        window.dgOpenProofHarnessWithPrefill(prefill.claimText, prefill.statement);
        handled = true;
      }
    } catch (_e0) {}

    if (!handled) {
      try {
        var btn = document.getElementById('dg-proof-harness-btn');
        var panel = document.getElementById('dg-proof-harness-panel');
        if (btn && panel && !panel.classList.contains('open')) btn.click();
        setTimeout(function () {
          var claimBox = document.getElementById('dg-ph-claim');
          var stmtBox = document.getElementById('dg-ph-statement');
          if (claimBox) { claimBox.value = prefill.claimText; claimBox.dispatchEvent(new Event('input', { bubbles: true })); }
          if (stmtBox) { stmtBox.value = prefill.statement; stmtBox.dispatchEvent(new Event('input', { bubbles: true })); }
          if (claimBox || stmtBox) handled = true;
        }, 30);
      } catch (_e1) {}
    }

    /* Always dispatch the event too, so any other listener (or a future
       Proof Harness build without the two globals above) can still pick this
       up -- an additive fallback, never the only path when the direct DOM
       hooks exist. */
    try {
      document.dispatchEvent(new CustomEvent('dataglow:proof-harness-prefill', { detail: prefill }));
    } catch (_e2) {}

    toast('Sent to Prove: statement prefilled, nothing has been run yet.', 'info');
    renderBody(null, false);
  }

  /* ---------------------------- Browse mode (grounded chat) ---------------- */
  function browseAsk(question) {
    var e = engine();
    if (!e || !question || !question.trim()) return;
    _browseHistory.push({ role: 'user', text: question.trim() });
    _browseBusy = true;
    renderBody(null, false);

    var strip = e.buildProfileStrip(discoverTables());
    var grounding = e.buildBrowseGrounding(strip);

    var respond = function (rawAnswer) {
      var answer = e.annotateUnverifiedNumbers(rawAnswer || 'I do not have enough profile information to answer that yet.');
      _browseHistory.push({ role: 'assistant', text: answer });
      _browseBusy = false;
      renderBody(null, false);
    };

    if (modelIsWarm()) {
      var messages = [
        { role: 'system', content: 'Answer using ONLY the profile summary below. Never invent numbers. Ground every answer in the listed columns/tables. This module never proves numbers; the human must run Prove for anything numeric.' },
        { role: 'user', content: grounding + '\n\nQuestion: ' + question },
      ];
      chatOnceViaBridge(messages).then(respond);
    } else {
      // Deterministic fallback: honest, no-model browse response.
      respond('On-device model is not warm, so this is a rule-based response: ' + grounding + '. Ask Propose for candidate questions, or load the model for freer browsing.');
    }
  }

  /* ---------------------------- rendering ---------------------------------- */
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + PANEL_ID + '{position:fixed;top:0;right:-460px;width:440px;max-width:92vw;height:100%;',
      'background:var(--surface,#fff);color:var(--text,#111);border-left:1px solid var(--border,#ddd);',
      'box-shadow:-8px 0 24px rgba(0,0,0,.12);z-index:12500;transition:right .22s ease;overflow-y:auto;font-size:13px}',
      '#' + PANEL_ID + '.open{right:0}',
      '#' + PANEL_ID + ' .dg-qs-header{position:sticky;top:0;background:var(--surface,#fff);padding:14px 16px;border-bottom:1px solid var(--border,#ddd);display:flex;justify-content:space-between;align-items:center;z-index:1}',
      '#' + PANEL_ID + ' .dg-qs-header h3{margin:0;font-size:15px}',
      '#' + PANEL_ID + ' .dg-qs-close{background:none;border:none;font-size:18px;cursor:pointer;color:var(--text,#111)}',
      '#' + PANEL_ID + ' .dg-qs-body{padding:14px 16px}',
      '#' + PANEL_ID + ' .dg-qs-banner{background:var(--surface-2,#f4f4f5);border:1px solid var(--border,#ddd);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;line-height:1.5}',
      '#' + PANEL_ID + ' .dg-qs-profile{border:1px solid var(--border,#ddd);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px}',
      '#' + PANEL_ID + ' .dg-qs-profile table{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:6px}',
      '#' + PANEL_ID + ' .dg-qs-profile td{padding:2px 4px;border-bottom:1px solid var(--border,#eee)}',
      '#' + PANEL_ID + ' .dg-qs-propose-btn{width:100%;padding:9px;border-radius:8px;border:1px solid var(--primary,#2563eb);background:var(--primary,#2563eb);color:#fff;font-weight:600;cursor:pointer;margin-bottom:12px}',
      '#' + PANEL_ID + ' .dg-qs-mode-tag{display:inline-block;font-size:var(--dg-text-xs,0.75rem);padding:1px 6px;border-radius:999px;margin-left:6px;background:var(--surface-2,#eee)}',
      '#' + PANEL_ID + ' .dg-qs-mode-tag.model{background:#dcfce7;color:#166534}',
      '#' + PANEL_ID + ' .dg-qs-mode-tag.template{background:#fef3c7;color:#92400e}',
      '#' + PANEL_ID + ' .dg-qs-candidate{border:1px solid var(--border,#ddd);border-radius:8px;padding:10px 12px;margin-bottom:10px}',
      '#' + PANEL_ID + ' .dg-qs-candidate .dg-qs-score{float:right;font-weight:700;font-size:11px}',
      '#' + PANEL_ID + ' .dg-qs-candidate .dg-qs-why{color:var(--text-muted,#666);font-size:11.5px;margin:4px 0}',
      '#' + PANEL_ID + ' .dg-qs-candidate .dg-qs-sql{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--surface-2,#f4f4f5);border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-word;margin:6px 0}',
      '#' + PANEL_ID + ' .dg-qs-candidate textarea{width:100%;box-sizing:border-box;font-size:12px;margin:4px 0;border-radius:6px;border:1px solid var(--border,#ddd);padding:6px}',
      '#' + PANEL_ID + ' .dg-qs-actions{display:flex;gap:6px;margin-top:6px}',
      '#' + PANEL_ID + ' .dg-qs-actions button{flex:1;padding:6px 4px;border-radius:6px;border:1px solid var(--border,#ddd);background:var(--surface,#fff);cursor:pointer;font-size:11.5px}',
      '#' + PANEL_ID + ' .dg-qs-actions button.dg-qs-keep{border-color:#16a34a;color:#16a34a}',
      '#' + PANEL_ID + ' .dg-qs-actions button.dg-qs-reject{border-color:#dc2626;color:#dc2626}',
      '#' + PANEL_ID + ' .dg-qs-tray{border:2px dashed var(--primary,#2563eb);border-radius:8px;padding:10px 12px;margin-bottom:14px}',
      '#' + PANEL_ID + ' .dg-qs-tray h4{margin:0 0 6px;font-size:12.5px}',
      '#' + PANEL_ID + ' .dg-qs-keeper-row{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border,#eee);font-size:12px}',
      '#' + PANEL_ID + ' .dg-qs-keeper-row button{font-size:var(--dg-text-xs,0.75rem);padding:3px 6px;border-radius:6px;border:1px solid var(--border,#ddd);background:var(--surface,#fff);cursor:pointer}',
      '#' + PANEL_ID + ' .dg-qs-browse{border-top:1px solid var(--border,#ddd);padding-top:12px;margin-top:12px}',
      '#' + PANEL_ID + ' .dg-qs-browse-msg{margin-bottom:8px;font-size:12px}',
      '#' + PANEL_ID + ' .dg-qs-browse-msg.assistant{color:var(--text,#111)}',
      '#' + PANEL_ID + ' .dg-qs-browse-msg.user{color:var(--text-muted,#666);font-weight:600}',
      '#' + PANEL_ID + ' .dg-qs-browse-input{display:flex;gap:6px;margin-top:8px}',
      '#' + PANEL_ID + ' .dg-qs-browse-input input{flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#ddd)}',
      '#' + PANEL_ID + ' .dg-qs-note{color:var(--text-muted,#666);font-size:11px;margin-top:4px}',
      '#' + BTN_ID + '{cursor:pointer}',
    ].join('');
    document.head.appendChild(style);
  }

  function renderProfileStrip(strip) {
    if (!strip) return '';
    if (strip.isEmpty) {
      return '<div class="dg-qs-profile">No tables loaded yet. Load data, then click Propose.</div>';
    }
    var rows = '';
    strip.tables.forEach(function (t) {
      rows += '<tr><td>' + esc(t.name) + '</td><td>' + (t.rowCount == null ? '?' : t.rowCount) + ' rows</td><td>' + t.columnCount + ' cols</td></tr>';
    });
    return '<div class="dg-qs-profile"><strong>Profile</strong> (deterministic, no model needed)' +
      '<table>' + rows + '</table></div>';
  }

  function renderCandidate(c) {
    var isKeeper = _keepers.some(function (k) { return k.id === c.id; });
    var modeTag = c.source === 'model'
      ? '<span class="dg-qs-mode-tag model">model</span>'
      : '<span class="dg-qs-mode-tag template">template (no model)</span>';

    if (_editingId === c.id) {
      return '<div class="dg-qs-candidate" data-id="' + esc(c.id) + '">' +
        '<span class="dg-qs-score">' + c.score + '/100</span>' +
        '<div>' + modeTag + '</div>' +
        '<textarea class="dg-qs-edit-text" rows="2">' + esc(c.text) + '</textarea>' +
        '<textarea class="dg-qs-edit-sql" rows="2">' + esc(c.sql || '') + '</textarea>' +
        '<div class="dg-qs-actions">' +
        '<button type="button" class="dg-qs-save" data-id="' + esc(c.id) + '">Save</button>' +
        '<button type="button" class="dg-qs-cancel-edit" data-id="' + esc(c.id) + '">Cancel</button>' +
        '</div></div>';
    }

    return '<div class="dg-qs-candidate" data-id="' + esc(c.id) + '">' +
      '<span class="dg-qs-score">' + c.score + '/100</span>' +
      '<div>' + modeTag + (c.edited ? '<span class="dg-qs-mode-tag">edited</span>' : '') + (isKeeper ? '<span class="dg-qs-mode-tag model">kept</span>' : '') + '</div>' +
      '<div>' + esc(c.text) + '</div>' +
      (c.why ? '<div class="dg-qs-why">' + esc(c.why) + '</div>' : '') +
      '<div class="dg-qs-note">Metric: ' + esc(c.metricType || 'unknown') + '</div>' +
      (c.sql ? '<div class="dg-qs-sql">' + esc(c.sql) + '</div>' : '') +
      '<div class="dg-qs-actions">' +
      '<button type="button" class="dg-qs-keep" data-id="' + esc(c.id) + '"' + (isKeeper ? ' disabled' : '') + '>Keep</button>' +
      '<button type="button" class="dg-qs-edit" data-id="' + esc(c.id) + '">Edit</button>' +
      '<button type="button" class="dg-qs-reject" data-id="' + esc(c.id) + '">Reject</button>' +
      '</div></div>';
  }

  function renderKeepersTray() {
    var e = engine();
    var max = e ? e.MAX_KEEPERS : 5;
    var rows = _keepers.map(function (k) {
      return '<div class="dg-qs-keeper-row"><span>' + esc(k.text) + '</span>' +
        '<span>' +
        '<button type="button" class="dg-qs-send-prove" data-id="' + esc(k.id) + '">Send to Prove</button> ' +
        '<button type="button" class="dg-qs-remove-keeper" data-id="' + esc(k.id) + '">Remove</button>' +
        '</span></div>';
    }).join('');
    return '<div class="dg-qs-tray"><h4>Keepers (' + _keepers.length + '/' + max + ')</h4>' +
      (rows || '<div class="dg-qs-note">No keepers yet. Keep a candidate below.</div>') + '</div>';
  }

  function renderBrowse() {
    var msgs = _browseHistory.map(function (m) {
      return '<div class="dg-qs-browse-msg ' + m.role + '">' + (m.role === 'user' ? 'You: ' : 'Scout: ') + esc(m.text) + '</div>';
    }).join('');
    return '<div class="dg-qs-browse">' +
      '<h4 style="margin:0 0 6px;font-size:12.5px">Browse mode (grounded on profile only)</h4>' +
      msgs +
      (_browseBusy ? '<div class="dg-qs-note">Thinking...</div>' : '') +
      '<div class="dg-qs-browse-input">' +
      '<input type="text" id="dg-qs-browse-input" placeholder="Ask about this data (profile-grounded)">' +
      '<button type="button" id="dg-qs-browse-send">Ask</button>' +
      '</div></div>';
  }

  function renderBody(profileStripArg, proposing) {
    var body = document.getElementById(BODY_ID);
    if (!body) return;
    var e = engine();
    var strip = profileStripArg || (e ? e.buildProfileStrip(discoverTables()) : { isEmpty: true, tables: [] });
    var banner = e ? e.CHEATING_BOUNDARY_BANNER : '';

    var html = '';
    html += '<div class="dg-qs-banner">' + esc(banner) + '</div>';
    html += renderProfileStrip(strip);
    html += '<button type="button" class="dg-qs-propose-btn" id="dg-qs-propose-btn"' + (proposing ? ' disabled' : '') + '>' +
      (proposing ? 'Proposing...' : 'Propose keepers from this data') + '</button>';

    if (_lastProposeMode) {
      html += '<div class="dg-qs-note">Last proposal used: ' +
        (_lastProposeMode === 'model' ? 'on-device model' : 'deterministic templates (no model)') + '</div>';
    }

    html += renderKeepersTray();

    var visible = _candidates.filter(function (c) { return !_rejected[c.id]; });
    if (visible.length === 0 && !proposing) {
      html += '<div class="dg-qs-note">No candidates yet. Click Propose.</div>';
    } else {
      html += visible.map(renderCandidate).join('');
    }

    html += renderBrowse();

    body.innerHTML = html;
    wireBodyEvents(body);
  }

  function wireBodyEvents(body) {
    var proposeBtn = body.querySelector('#dg-qs-propose-btn');
    if (proposeBtn) proposeBtn.addEventListener('click', propose);

    body.querySelectorAll('.dg-qs-keep').forEach(function (btn) {
      btn.addEventListener('click', function () { keepCandidate(btn.getAttribute('data-id')); });
    });
    body.querySelectorAll('.dg-qs-reject').forEach(function (btn) {
      btn.addEventListener('click', function () { rejectCandidate(btn.getAttribute('data-id')); });
    });
    body.querySelectorAll('.dg-qs-edit').forEach(function (btn) {
      btn.addEventListener('click', function () { startEdit(btn.getAttribute('data-id')); });
    });
    body.querySelectorAll('.dg-qs-cancel-edit').forEach(function (btn) {
      btn.addEventListener('click', function () { _editingId = null; renderBody(null, false); });
    });
    body.querySelectorAll('.dg-qs-save').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var card = body.querySelector('.dg-qs-candidate[data-id="' + id + '"]');
        var text = card.querySelector('.dg-qs-edit-text').value;
        var sql = card.querySelector('.dg-qs-edit-sql').value;
        saveEdit(id, text, sql);
      });
    });
    body.querySelectorAll('.dg-qs-remove-keeper').forEach(function (btn) {
      btn.addEventListener('click', function () { removeKeeperFromTray(btn.getAttribute('data-id')); });
    });
    body.querySelectorAll('.dg-qs-send-prove').forEach(function (btn) {
      btn.addEventListener('click', function () { sendToProve(btn.getAttribute('data-id')); });
    });

    var browseSend = body.querySelector('#dg-qs-browse-send');
    var browseInput = body.querySelector('#dg-qs-browse-input');
    if (browseSend && browseInput) {
      var submit = function () {
        var v = browseInput.value;
        browseInput.value = '';
        browseAsk(v);
      };
      browseSend.addEventListener('click', submit);
      browseInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') submit();
      });
    }
  }

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Question Scout');
    panel.innerHTML =
      '<div class="dg-qs-header"><h3>Question Scout</h3>' +
      '<button type="button" class="dg-qs-close" id="dg-question-scout-close" aria-label="Close">\u00d7</button></div>' +
      '<div class="dg-qs-body" id="' + BODY_ID + '"></div>';
    document.body.appendChild(panel);
    var closeBtn = panel.querySelector('#dg-question-scout-close');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    return panel;
  }

  /* ---------------------------- open / close ------------------------------ */
  function isOpen() {
    var panel = document.getElementById(PANEL_ID);
    return !!(panel && panel.classList.contains('open'));
  }

  function openPanel() {
    if (!flagOn()) return false;
    ensurePanel().classList.add('open');
    renderBody(null, false);
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
    btn.setAttribute('aria-label', 'Open Question Scout');
    btn.title = 'Question Scout: propose candidate questions from this data';
    btn.innerHTML = '<span>Question Scout</span>';
    btn.addEventListener('click', function () {
      if (isOpen()) closePanel(); else openPanel();
    });
    /* Next to the Proof Harness button, so "propose, then prove" reads as one
       row -- same anchoring convention Proof Harness itself used against
       Trust Ledger / Air-Gap / Shield Packs. */
    var anchor = document.getElementById('dg-proof-harness-btn') || document.getElementById('dg-trust-ledger-btn') || document.getElementById('dg-air-gap-btn');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      if (anchor.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '540px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '540px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  /* ---------------------------- ask-bar surfacing --------------------------
     SPEC: "Also surface from empty ask bar when tables exist: 'Propose
     keepers from this data'." Best-effort: looks for a known ask-bar input
     id/class used elsewhere in canvas; a no-op (not an error) if none of
     these exist in a given build. */
  function surfaceFromAskBar() {
    try {
      var askBar = document.querySelector('#ask-bar, .ask-bar, #dg-ask-input, [data-role="ask-bar"]');
      if (!askBar || askBar._dgQuestionScoutHinted) return;
      var tables = discoverTables();
      if (!tables || tables.length === 0) return;
      askBar._dgQuestionScoutHinted = true;
      askBar.setAttribute('placeholder', 'Propose keepers from this data (Question Scout), or ask a question...');
    } catch (_e) {}
  }

  function boot() {
    if (flagOn()) {
      injectButton();
      ensurePanel();
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closePanel();
      });
      surfaceFromAskBar();
    }
  }

  /* Published for tests and for other modules (e.g. a future "Analyze" tab
     entry point) to open Scout programmatically, matching the SPEC's
     "Entry: After data load (or from Analyze / Ask bar): button Question
     Scout". Also published so Proof Harness or any other module could, in
     principle, call back into Scout without a circular require. */
  window.DataGlowQuestionScoutCanvas = {
    openPanel: openPanel,
    closePanel: closePanel,
    isOpen: isOpen,
    propose: propose,
    getCandidates: function () { return _candidates.slice(); },
    getKeepers: function () { return _keepers.slice(); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 900); });
  } else {
    setTimeout(boot, 900);
  }
})();
