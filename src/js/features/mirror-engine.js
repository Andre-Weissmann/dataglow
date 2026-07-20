/* DataGlow — src/js/features/mirror-engine.js */
/* Part of structured refactor */

var DataGlowMirror = (function() {
  'use strict';

  var MAX_CARDS = 3;
  var AUTO_DISMISS_MS = 7000;
  var _cards = [];
  var _lastAction = null;
  var _enabled = true;

  var RULE_BASED = {
    sql_run: [
      'Query executed. Check if the result shape matches your hypothesis before drawing conclusions.',
      'Good instinct running that query. Look at the row count vs your expectations.',
      'SQL ran. If you see unexpected NULLs, check your JOIN conditions.'
    ],
    chart_view: [
      'Charts panel opened. Look for the shape of distribution before checking individual values.',
      'Visualizing data is step one. What outlier do you see that the average would hide?'
    ],
    analyze_switch: [
      'Switched analysis tools. Each tool reveals a different dimension of the same story.',
      'Good workflow. Different tools surface different patterns in the same dataset.'
    ],
    dataset_load: [
      'New dataset loaded. First question: what time period does this cover?',
      'Data landed. Check row count vs what was expected from the source.',
      'Dataset in. What is the grain of this data - one row per what?'
    ],
    peer_review: [
      'Running peer review. The most important check is whether your assumptions are documented.'
    ]
  };

  function getRuleBased(key) {
    var arr = RULE_BASED[key];
    if (!arr || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function showObservation(label, text) {
    if (!_enabled) return;
    var feed = document.getElementById('mirror-feed');
    if (!feed) return;

    var card = document.createElement('div');
    card.className = 'mirror-card';

    var lbl = document.createElement('div');
    lbl.className = 'mirror-card-label';
    lbl.textContent = 'Mirror';

    var body = document.createElement('div');
    body.className = 'mirror-card-text';
    body.textContent = text;

    var dismiss = document.createElement('button');
    dismiss.className = 'mirror-card-dismiss';
    dismiss.textContent = String.fromCharCode(215);
    dismiss.addEventListener('click', function() { removeCard(card); });

    card.appendChild(lbl);
    card.appendChild(body);
    card.appendChild(dismiss);
    feed.appendChild(card);
    _cards.push(card);

    while (_cards.length > MAX_CARDS) {
      removeCard(_cards[0]);
    }

    setTimeout(function() { removeCard(card); }, AUTO_DISMISS_MS);

    if (window.LevelSystem) window.LevelSystem.addXP('mirror_observation', 2);
  }

  function removeCard(card) {
    if (!card || !card.parentNode) return;
    card.classList.add('mirror-card-fade');
    setTimeout(function() {
      if (card.parentNode) card.parentNode.removeChild(card);
      var idx = _cards.indexOf(card);
      if (idx > -1) _cards.splice(idx, 1);
    }, 420);
  }

  function observe(actionKey, context) {
    if (_lastAction === actionKey) return;
    _lastAction = actionKey;
    setTimeout(function() { if (_lastAction === actionKey) _lastAction = null; }, 3000);

    if (window.BrowserLLM && window.BrowserLLM.isReady() && context && context.ds) {
      var ds = context.ds;
      var colList = ds.columns ? ds.columns.slice(0,6).map(function(c){return c.name;}).join(', ') : '';
      var prompt = 'A data analyst just performed action: "' + actionKey.replace(/_/g,' ') + '" on a dataset with columns: ' + colList + '.\n' +
        'Give one short (max 20 words) insightful observation or question a senior analyst would make. Be specific to the columns if possible. No preamble.';

      window.BrowserLLM.generate(prompt, { maxTokens: 60, temperature: 0.6 })
        .then(function(text) {
          if (text && text.trim()) showObservation('Mirror', text.trim());
          else showObservation('Mirror', getRuleBased(actionKey) || '');
        })
        .catch(function() {
          showObservation('Mirror', getRuleBased(actionKey) || '');
        });
    } else {
      var msg = getRuleBased(actionKey);
      if (msg) showObservation('Mirror', msg);
    }
  }

  function init() {
    document.addEventListener('click', function(e) {
      var runBtn = e.target.closest ? e.target.closest('#sql-view-run') : null;
      if (runBtn) {
        setTimeout(function() {
          var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
          observe('sql_run', { ds: ds });
        }, 800);
      }
      var pill = e.target.closest ? e.target.closest('.analyze-pill') : null;
      if (pill) {
        var p = pill.dataset.panel;
        if (p === 'review-view') observe('peer_review', {});
        else if (p === 'charts-view') observe('chart_view', {});
        else observe('analyze_switch', {});
      }
    });

    document.addEventListener('dataglow:dataset-loaded', function(e) {
      var ds = e.detail && e.detail.dataset;
      setTimeout(function() { observe('dataset_load', { ds: ds }); }, 2000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.DataGlowMirror = { observe: observe, show: showObservation };
  return { observe: observe, show: showObservation };
})();

(function() {
  'use strict';
  function initMobileToolsSheet() {
    var trigger = document.getElementById('analyze-tools-trigger');
    var overlay = document.getElementById('tools-sheet-overlay');
    var closeBtn = document.getElementById('tools-sheet-close-btn');
    var sheetBody = document.getElementById('tools-sheet-body');
    var activeLabel = document.getElementById('analyze-active-label');

    if (!trigger || !overlay || !sheetBody) return;

    // Clone sidebar content into sheet on first open
    var cloned = false;
    function cloneSidebar() {
      if (cloned) return;
      cloned = true;
      var sidebar = document.getElementById('analyze-sidebar');
      if (!sidebar) return;
      sheetBody.innerHTML = sidebar.innerHTML;
      // Wire items in the sheet
      sheetBody.querySelectorAll('.sidebar-nav-item[data-panel]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var panelId = btn.dataset.panel;
          // Click matching hidden pill
          var pill = document.querySelector('.analyze-pill[data-panel="' + panelId + '"]');
          if (pill) pill.click();
          // Update active label
          var label = btn.querySelector('.sni-label');
          if (label && activeLabel) activeLabel.textContent = label.textContent.trim();
          closeSheet();
        });
      });
      // Wire non-panel buttons (Witness, OSCE, Story, Questions)
      var delegations = {
        'sidebar-witness-btn': 'witness-trigger-btn',
        'sidebar-osce-btn': 'osce-trigger-btn',
        'sidebar-story-btn': 'story-trigger-btn',
        'sidebar-ask-btn': 'questions-trigger-btn'
      };
      Object.keys(delegations).forEach(function(sheetBtnId) {
        // Find by id in the cloned content
        sheetBody.querySelectorAll('button').forEach(function(b) {
          if (b.id === sheetBtnId) {
            b.id = sheetBtnId + '-sheet'; // avoid duplicate IDs
            b.addEventListener('click', function() {
              var real = document.getElementById(delegations[sheetBtnId]);
              if (real) real.click();
              closeSheet();
            });
          }
        });
      });
    }

    function openSheet() { cloneSidebar(); overlay.classList.add('open'); }
    function closeSheet() { overlay.classList.remove('open'); }

    trigger.addEventListener('click', openSheet);
    if (closeBtn) closeBtn.addEventListener('click', closeSheet);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeSheet(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileToolsSheet);
  } else {
    initMobileToolsSheet();
  }
})();

(function() {
  'use strict';
  function initAgentBarMoreSheet() {
    var moreBtn = document.getElementById('agent-bar-more-btn');
    if (!moreBtn) return;

    var hiddenIds = [
      'live-feed-btn',
      'skills-trigger-btn',
      'badges-trigger-btn',
      'osce-trigger-btn',
      'takehome-trigger-btn',
      'story-trigger-btn',
      'feature-settings-btn'
    ];

    var overlay = document.createElement('div');
    overlay.id = 'agent-more-sheet-overlay';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:15000;';

    var sheet = document.createElement('div');
    sheet.id = 'agent-more-sheet';
    sheet.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:70vh;background:var(--background);border-radius:18px 18px 0 0;z-index:15001;display:flex;flex-direction:column;transform:translateY(100%);transition:transform 0.28s cubic-bezier(0.32, 0.72, 0, 1);overflow:hidden;';

    var handle = document.createElement('div');
    handle.style.cssText = 'width:36px;height:4px;background:var(--border);border-radius:2px;margin:12px auto 0;flex-shrink:0;';
    sheet.appendChild(handle);

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 20px 10px;border-bottom:1px solid var(--border);flex-shrink:0;';
    var title = document.createElement('span');
    title.textContent = 'More Tools';
    title.style.cssText = 'font-size:14px;font-weight:800;color:var(--text);';
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&#x2715;';
    closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:var(--text-muted);cursor:pointer;padding:4px;font-family:inherit;';
    header.appendChild(title);
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    var body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;padding:8px 0 32px;flex:1;';
    sheet.appendChild(body);

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    var populated = false;
    function populate() {
      if (populated) return;
      populated = true;
      hiddenIds.forEach(function(id) {
        var original = document.getElementById(id);
        if (!original) return;
        var row = document.createElement('button');
        row.textContent = original.getAttribute('title') || original.textContent || id;
        row.style.cssText = 'display:block;width:100%;text-align:left;padding:14px 24px;font-size:15px;border:none;border-bottom:1px solid var(--border);background:none;color:var(--text);font-family:inherit;cursor:pointer;';
        row.addEventListener('click', function() {
          original.click();
          closeMoreSheet();
        });
        body.appendChild(row);
      });
    }

    function openMoreSheet() {
      populate();
      overlay.style.display = 'block';
      requestAnimationFrame(function() {
        sheet.style.transform = 'translateY(0)';
      });
    }
    function closeMoreSheet() {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(function() {
        overlay.style.display = 'none';
      }, 280);
    }

    moreBtn.addEventListener('click', openMoreSheet);
    closeBtn.addEventListener('click', closeMoreSheet);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeMoreSheet(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAgentBarMoreSheet);
  } else {
    initAgentBarMoreSheet();
  }
})();

(function() {
  'use strict';
  // Add backdrop to drawers on mobile
  function initDrawerBackdrops() {
    var drawerIds = ['notes-drawer', 'questions-drawer'];
    drawerIds.forEach(function(id) {
      var drawer = document.getElementById(id);
      if (!drawer) return;
      var backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:799;display:none;';
      backdrop.id = id + '-backdrop';
      document.body.appendChild(backdrop);

      function isDrawerOpen() {
        if (drawer.classList.contains('open')) return true;
        var r = drawer.style.right;
        if (r === '0' || r === '0px') return true;
        return false;
      }

      function refresh() {
        var isOpen = isDrawerOpen();
        backdrop.style.display = isOpen ? 'block' : 'none';
        backdrop.style.zIndex = id === 'questions-drawer' ? '799' : '12999';
      }

      var obs = new MutationObserver(refresh);
      obs.observe(drawer, { attributes: true, attributeFilter: ['class', 'style'] });
      refresh();

      backdrop.addEventListener('click', function() {
        drawer.classList.remove('open');
        drawer.style.right = '-340px';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDrawerBackdrops);
  } else {
    initDrawerBackdrops();
  }
})();
})();


/* ============================================================
   VAULT V2-V7  -  window.DataGlowVault engine
   Reusable SQL templates, transform presets, column profile
   snapshots, peer review saves, query history, export/import.
   In-memory state only (no browser storage APIs used).
   ============================================================ */
(function () {
  'use strict';

  var vaultState = {
    sqlTemplates: [],
    transformPresets: [],
    columnProfiles: [],
    peerReviews: [],
    queryHistory: []
  };

  function vaultUid() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function vaultNowISO() {
    return new Date().toISOString();
  }

  function vaultEscape(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (ch) {
      var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[ch];
    });
  }

  function vaultFmtDate(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleString();
    } catch (e) {
      return iso || '';
    }
  }

  /* ---- V2: SQL Template Library ---------------------------------- */
  function saveSQL(name, query, tags) {
    var rec = {
      id: vaultUid(),
      name: name || 'Untitled Query',
      query: query || '',
      tags: (tags || []).filter(Boolean),
      savedAt: vaultNowISO()
    };
    vaultState.sqlTemplates.unshift(rec);
    renderVaultTab('sql');
    return rec;
  }

  function deleteSQL(id) {
    vaultState.sqlTemplates = vaultState.sqlTemplates.filter(function (t) { return t.id !== id; });
    renderVaultTab('sql');
  }

  /* ---- V3: Transform Presets --------------------------------------- */
  function saveTransform(name, steps) {
    var rec = {
      id: vaultUid(),
      name: name || 'Untitled Preset',
      steps: steps || [],
      savedAt: vaultNowISO()
    };
    vaultState.transformPresets.unshift(rec);
    renderVaultTab('transform');
    return rec;
  }

  function deleteTransform(id) {
    vaultState.transformPresets = vaultState.transformPresets.filter(function (t) { return t.id !== id; });
    renderVaultTab('transform');
  }

  function applyTransformPreset(id) {
    var preset = vaultState.transformPresets.find(function (t) { return t.id === id; });
    var ds = window.getActiveDataset && window.getActiveDataset();
    if (!preset || !ds) {
      window.showToast && window.showToast('Load a dataset first.', 'warn');
      return;
    }
    var colNames = ds.columns.map(function (c) { return c.name.toLowerCase(); });
    var matched = 0;
    preset.steps.forEach(function (step) {
      if (step && step.column && colNames.indexOf(String(step.column).toLowerCase()) >= 0) matched++;
    });
    window.showToast && window.showToast('Preset "' + preset.name + '" matched ' + matched + ' of ' + preset.steps.length + ' step(s) against this dataset.', matched > 0 ? 'success' : 'warn');
  }

  /* ---- V4: Column Profile Snapshots --------------------------------- */
  function computeColumnStats(ds) {
    var snapshot = {};
    if (!ds || !ds.columns || !ds.rows) return snapshot;
    ds.columns.forEach(function (col, ci) {
      var vals = ds.rows.map(function (r) { return r[ci]; });
      var n = vals.length;
      var nulls = vals.filter(function (v) { return v === null || v === undefined || v === ''; }).length;
      var nonNull = vals.filter(function (v) { return !(v === null || v === undefined || v === ''); });
      var uniqSet = {};
      nonNull.forEach(function (v) { uniqSet[String(v)] = (uniqSet[String(v)] || 0) + 1; });
      var uniqKeys = Object.keys(uniqSet);
      var topValues = uniqKeys
        .sort(function (a, b) { return uniqSet[b] - uniqSet[a]; })
        .slice(0, 5)
        .map(function (k) { return { value: k, count: uniqSet[k] }; });
      var stat = {
        name: col.name,
        type: col.type,
        nullCount: nulls,
        nullPct: n > 0 ? Math.round((nulls / n) * 1000) / 10 : 0,
        cardinality: uniqKeys.length,
        topValues: topValues
      };
      if (col.type === 'INT' || col.type === 'FLOAT') {
        var nums = nonNull.map(function (v) { return parseFloat(v); }).filter(function (v) { return !isNaN(v); });
        if (nums.length) {
          stat.min = Math.min.apply(null, nums);
          stat.max = Math.max.apply(null, nums);
          stat.mean = Math.round((nums.reduce(function (a, b) { return a + b; }, 0) / nums.length) * 1000) / 1000;
        }
      }
      snapshot[col.name] = stat;
    });
    return snapshot;
  }

  function snapshotColumns(name) {
    var ds = window.getActiveDataset && window.getActiveDataset();
    if (!ds) {
      window.showToast && window.showToast('Load a dataset first.', 'warn');
      return null;
    }
    var rec = {
      id: vaultUid(),
      name: name || (ds.name + ' snapshot'),
      datasetName: ds.name,
      snapshot: computeColumnStats(ds),
      savedAt: vaultNowISO()
    };
    vaultState.columnProfiles.unshift(rec);
    renderVaultTab('profiles');
    return rec;
  }

  function deleteProfile(id) {
    vaultState.columnProfiles = vaultState.columnProfiles.filter(function (p) { return p.id !== id; });
    renderVaultTab('profiles');
  }

  var _profileCompareSelection = [];

  function toggleProfileCompare(id) {
    var idx = _profileCompareSelection.indexOf(id);
    if (idx >= 0) {
      _profileCompareSelection.splice(idx, 1);
    } else {
      if (_profileCompareSelection.length >= 2) _profileCompareSelection.shift();
      _profileCompareSelection.push(id);
    }
    renderVaultTab('profiles');
  }

  /* ---- V5: Peer Review Saves ---------------------------------------- */
  function savePeerReview(name, datasetName, score, findings) {
    var rec = {
      id: vaultUid(),
      name: name || 'Untitled Review',
      datasetName: datasetName || '',
      score: score == null ? null : score,
      findings: findings || [],
      savedAt: vaultNowISO()
    };
    vaultState.peerReviews.unshift(rec);
    renderVaultTab('reviews');
    return rec;
  }

  function deleteReview(id) {
    vaultState.peerReviews = vaultState.peerReviews.filter(function (r) { return r.id !== id; });
    renderVaultTab('reviews');
  }

  /* ---- V6: Named Queries / Query History ---------------------------- */
  function pushHistory(query, resultRows) {
    var rec = {
      id: vaultUid(),
      query: query || '',
      resultRows: resultRows == null ? 0 : resultRows,
      executedAt: vaultNowISO(),
      starred: false
    };
    vaultState.queryHistory.unshift(rec);
    if (vaultState.queryHistory.length > 200) vaultState.queryHistory.length = 200;
    renderVaultTab('history');
    return rec;
  }

  function toggleStar(id) {
    var rec = vaultState.queryHistory.find(function (h) { return h.id === id; });
    if (rec) rec.starred = !rec.starred;
    renderVaultTab('history');
  }

  function clearUnstarredHistory() {
    vaultState.queryHistory = vaultState.queryHistory.filter(function (h) { return h.starred; });
    renderVaultTab('history');
  }

  function getHistory() {
    return vaultState.queryHistory.slice();
  }

  function rerunHistoryQuery(id) {
    var rec = vaultState.queryHistory.find(function (h) { return h.id === id; });
    if (!rec) return;
    loadIntoSQLEditor(rec.query, true);
  }

  /* ---- V7: Export / Import ------------------------------------------- */
  function exportVault() {
    var payload = {
      exportedAt: vaultNowISO(),
      version: 'dataglow-vault-v7',
      sqlTemplates: vaultState.sqlTemplates,
      transformPresets: vaultState.transformPresets,
      columnProfiles: vaultState.columnProfiles,
      peerReviews: vaultState.peerReviews,
      queryHistory: vaultState.queryHistory
    };
    var json = JSON.stringify(payload, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var dateStr = new Date().toISOString().slice(0, 10);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'dataglow-vault-' + dateStr + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
    window.showToast && window.showToast('Vault exported.', 'success');
    return payload;
  }

  function importVault(payload) {
    if (!payload || typeof payload !== 'object') {
      window.showToast && window.showToast('Invalid vault file.', 'error');
      return false;
    }
    var fields = ['sqlTemplates', 'transformPresets', 'columnProfiles', 'peerReviews', 'queryHistory'];
    var importedCount = 0;
    fields.forEach(function (f) {
      if (Array.isArray(payload[f])) {
        payload[f].forEach(function (rec) {
          if (rec && rec.id && !vaultState[f].some(function (existing) { return existing.id === rec.id; })) {
            vaultState[f].push(rec);
            importedCount++;
          }
        });
      }
    });
    fields.forEach(function (f) { renderVaultTab(f === 'sqlTemplates' ? 'sql' : f === 'transformPresets' ? 'transform' : f === 'columnProfiles' ? 'profiles' : f === 'peerReviews' ? 'reviews' : 'history'); });
    updateIOSummary();
    window.showToast && window.showToast('Imported ' + importedCount + ' vault record(s).', importedCount > 0 ? 'success' : 'info');
    return true;
  }

  function readImportFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = null;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        window.showToast && window.showToast('Could not parse vault file.', 'error');
        return;
      }
      importVault(parsed);
    };
    reader.onerror = function () {
      window.showToast && window.showToast('Could not read vault file.', 'error');
    };
    reader.readAsText(file);
  }

  /* ---- Helpers ------------------------------------------------------- */
  function loadIntoSQLEditor(query, focus) {
    var input = document.getElementById('sql-view-input');
    if (input) {
      input.value = query;
      if (focus) input.focus();
      window.showToast && window.showToast('Query loaded into SQL editor.', 'success');
    } else {
      window.showToast && window.showToast('SQL editor not found on this view.', 'warn');
    }
    closeVaultModal();
  }

  function currentSQLQuery() {
    var input = document.getElementById('sql-view-input');
    return input ? input.value : '';
  }

  /* ---- Rendering ------------------------------------------------------ */
  var EMPTY_STATES = {
    sql: { icon: '&#128190;', title: 'No saved SQL templates yet', sub: 'Write a query in the SQL editor, then click "Save Current Query" to build your library.' },
    transform: { icon: '&#128295;', title: 'No transform presets yet', sub: 'Save a sequence of column transforms so you can replay them on any matching dataset.' },
    profiles: { icon: '&#128202;', title: 'No column profile snapshots yet', sub: 'Snapshot a dataset\u2019s column statistics to compare data quality over time.' },
    reviews: { icon: '&#9989;', title: 'No saved peer reviews yet', sub: 'Run a Peer Review, then save the results here to track quality over time.' },
    history: { icon: '&#128337;', title: 'No query history yet', sub: 'Every query you run in the SQL editor is automatically logged here.' }
  };

  function makeEmptyState(kind) {
    var e = EMPTY_STATES[kind];
    if (!e) return '';
    return '<div class="vault-empty-state">' +
      '<div class="vault-empty-icon">' + e.icon + '</div>' +
      '<div class="vault-empty-title">' + vaultEscape(e.title) + '</div>' +
      '<div class="vault-empty-sub">' + vaultEscape(e.sub) + '</div>' +
      '</div>';
  }

  function renderSQLList() {
    var list = document.getElementById('vault-sql-list');
    if (!list) return;
    var q = (document.getElementById('vault-sql-search') || {}).value || '';
    q = q.toLowerCase();
    var items = vaultState.sqlTemplates.filter(function (t) {
      if (!q) return true;
      return t.name.toLowerCase().indexOf(q) >= 0 || t.tags.join(' ').toLowerCase().indexOf(q) >= 0 || t.query.toLowerCase().indexOf(q) >= 0;
    });
    if (!items.length) { list.innerHTML = makeEmptyState('sql'); return; }
    list.innerHTML = items.map(function (t) {
      return '<div class="vault-item" data-id="' + t.id + '">' +
        '<div class="vault-item-top"><span class="vault-item-name">' + vaultEscape(t.name) + '</span><span class="vault-item-meta">' + vaultFmtDate(t.savedAt) + '</span></div>' +
        (t.tags.length ? '<div class="vault-item-tags">' + t.tags.map(function (tag) { return '<span class="vault-tag-chip">' + vaultEscape(tag) + '</span>'; }).join('') + '</div>' : '') +
        '<div class="vault-item-body">' + vaultEscape(t.query) + '</div>' +
        '<div class="vault-item-actions">' +
        '<button class="vault-load-sql-btn" data-id="' + t.id + '">Load Template</button>' +
        '<button class="vault-delete-sql-btn" data-id="' + t.id + '">Delete</button>' +
        '</div></div>';
    }).join('');
  }

  function renderTransformList() {
    var list = document.getElementById('vault-transform-list');
    if (!list) return;
    var q = (document.getElementById('vault-transform-search') || {}).value || '';
    q = q.toLowerCase();
    var items = vaultState.transformPresets.filter(function (t) {
      if (!q) return true;
      return t.name.toLowerCase().indexOf(q) >= 0;
    });
    if (!items.length) { list.innerHTML = makeEmptyState('transform'); return; }
    list.innerHTML = items.map(function (t) {
      var stepsDesc = t.steps.map(function (s) { return (s.type || 'step') + (s.column ? ' \u2192 ' + s.column : ''); }).join(', ');
      return '<div class="vault-item" data-id="' + t.id + '">' +
        '<div class="vault-item-top"><span class="vault-item-name">' + vaultEscape(t.name) + '</span><span class="vault-item-meta">' + vaultFmtDate(t.savedAt) + '</span></div>' +
        '<div class="vault-item-body">' + vaultEscape(stepsDesc || 'No steps recorded') + '</div>' +
        '<div class="vault-item-actions">' +
        '<button class="vault-apply-transform-btn" data-id="' + t.id + '">Apply to Active Dataset</button>' +
        '<button class="vault-delete-transform-btn" data-id="' + t.id + '">Delete</button>' +
        '</div></div>';
    }).join('');
  }

  function renderProfileList() {
    var list = document.getElementById('vault-profile-list');
    if (!list) return;
    var q = (document.getElementById('vault-profile-search') || {}).value || '';
    q = q.toLowerCase();
    var items = vaultState.columnProfiles.filter(function (p) {
      if (!q) return true;
      return p.name.toLowerCase().indexOf(q) >= 0 || p.datasetName.toLowerCase().indexOf(q) >= 0;
    });
    if (!items.length) { list.innerHTML = makeEmptyState('profiles'); return; }
    var compareHtml = '';
    if (_profileCompareSelection.length === 2) {
      var a = vaultState.columnProfiles.find(function (p) { return p.id === _profileCompareSelection[0]; });
      var b = vaultState.columnProfiles.find(function (p) { return p.id === _profileCompareSelection[1]; });
      if (a && b) compareHtml = renderCompare(a, b);
    }
    list.innerHTML = compareHtml + items.map(function (p) {
      var colCount = Object.keys(p.snapshot || {}).length;
      var isSelected = _profileCompareSelection.indexOf(p.id) >= 0;
      return '<div class="vault-item" data-id="' + p.id + '">' +
        '<div class="vault-item-top"><span class="vault-item-name">' + vaultEscape(p.name) + '</span><span class="vault-item-meta">' + vaultFmtDate(p.savedAt) + '</span></div>' +
        '<div class="vault-item-meta">Dataset: ' + vaultEscape(p.datasetName) + ' \u00b7 ' + colCount + ' column(s)</div>' +
        '<div class="vault-item-actions">' +
        '<button class="vault-compare-profile-btn' + (isSelected ? ' starred' : '') + '" data-id="' + p.id + '">' + (isSelected ? 'Selected for Compare' : 'Select to Compare') + '</button>' +
        '<button class="vault-delete-profile-btn" data-id="' + p.id + '">Delete</button>' +
        '</div></div>';
    }).join('');
  }

  function renderCompare(a, b) {
    var names = {};
    Object.keys(a.snapshot || {}).forEach(function (n) { names[n] = true; });
    Object.keys(b.snapshot || {}).forEach(function (n) { names[n] = true; });
    var rows = Object.keys(names).map(function (n) {
      var sa = (a.snapshot || {})[n];
      var sb = (b.snapshot || {})[n];
      var diff = sa && sb && (sa.nullPct !== sb.nullPct || sa.cardinality !== sb.cardinality);
      return '<div>' + (diff ? '<span class="vault-profile-diff-flag">&#9888; </span>' : '') + vaultEscape(n) + ': ' +
        (sa ? 'null ' + sa.nullPct + '%, card ' + sa.cardinality : 'missing') + ' vs ' +
        (sb ? 'null ' + sb.nullPct + '%, card ' + sb.cardinality : 'missing') + '</div>';
    }).join('');
    return '<div class="vault-profile-compare">' +
      '<div class="vault-profile-col"><strong>' + vaultEscape(a.name) + '</strong> (baseline)</div>' +
      '<div class="vault-profile-col"><strong>' + vaultEscape(b.name) + '</strong> (current)</div>' +
      '</div><div class="vault-item vault-item-body">' + (rows || 'No overlapping columns.') + '</div>';
  }

  function renderReviewList() {
    var list = document.getElementById('vault-review-list');
    if (!list) return;
    var q = (document.getElementById('vault-review-search') || {}).value || '';
    q = q.toLowerCase();
    var items = vaultState.peerReviews.filter(function (r) {
      if (!q) return true;
      return r.name.toLowerCase().indexOf(q) >= 0 || r.datasetName.toLowerCase().indexOf(q) >= 0;
    });
    if (!items.length) { list.innerHTML = makeEmptyState('reviews'); return; }
    list.innerHTML = items.map(function (r) {
      return '<div class="vault-item" data-id="' + r.id + '">' +
        '<div class="vault-item-top"><span class="vault-item-name">' + vaultEscape(r.name) + '</span><span class="vault-item-meta">' + vaultFmtDate(r.savedAt) + '</span></div>' +
        '<div class="vault-item-meta">Dataset: ' + vaultEscape(r.datasetName) + ' \u00b7 Score: ' + (r.score == null ? 'n/a' : r.score) + ' \u00b7 ' + r.findings.length + ' finding(s)</div>' +
        '<div class="vault-item-actions">' +
        '<button class="vault-delete-review-btn" data-id="' + r.id + '">Delete</button>' +
        '</div></div>';
    }).join('');
  }

  function renderHistoryList() {
    var list = document.getElementById('vault-history-list');
    if (!list) return;
    var q = (document.getElementById('vault-history-search') || {}).value || '';
    q = q.toLowerCase();
    var items = vaultState.queryHistory.filter(function (h) {
      if (!q) return true;
      return h.query.toLowerCase().indexOf(q) >= 0;
    });
    if (!items.length) { list.innerHTML = makeEmptyState('history'); return; }
    items = items.slice().sort(function (a, b) { return (b.starred - a.starred); });
    list.innerHTML = items.map(function (h) {
      return '<div class="vault-item" data-id="' + h.id + '">' +
        '<div class="vault-item-top"><span class="vault-item-name">' + (h.starred ? '&#11088; ' : '') + h.resultRows + ' row(s)</span><span class="vault-item-meta">' + vaultFmtDate(h.executedAt) + '</span></div>' +
        '<div class="vault-item-body">' + vaultEscape(h.query) + '</div>' +
        '<div class="vault-item-actions">' +
        '<button class="vault-star-btn' + (h.starred ? ' starred' : '') + '" data-id="' + h.id + '">' + (h.starred ? 'Unstar' : 'Star') + '</button>' +
        '<button class="vault-rerun-btn" data-id="' + h.id + '">Re-run</button>' +
        '</div></div>';
    }).join('');
  }

  function updateIOSummary() {
    var el = document.getElementById('vault-io-summary');
    if (!el) return;
    el.textContent = vaultState.sqlTemplates.length + ' SQL template(s), ' +
      vaultState.transformPresets.length + ' transform preset(s), ' +
      vaultState.columnProfiles.length + ' column profile(s), ' +
      vaultState.peerReviews.length + ' peer review(s), ' +
      vaultState.queryHistory.length + ' query history record(s).';
  }

  function renderVaultTab(kind) {
    if (kind === 'sql') renderSQLList();
    else if (kind === 'transform') renderTransformList();
    else if (kind === 'profiles') renderProfileList();
    else if (kind === 'reviews') renderReviewList();
    else if (kind === 'history') renderHistoryList();
    updateIOSummary();
  }

  function renderAllVaultTabs() {
    renderSQLList();
    renderTransformList();
    renderProfileList();
    renderReviewList();
    renderHistoryList();
    updateIOSummary();
  }

  /* ---- Modal open / close / tab switching ----------------------------- */
  function openVaultModal(initialTab) {
    var modal = document.getElementById('vault-modal');
    if (!modal) return;
    modal.classList.add('open');
    renderAllVaultTabs();
    if (initialTab) switchVaultTab(initialTab);
  }

  function closeVaultModal() {
    var modal = document.getElementById('vault-modal');
    if (modal) modal.classList.remove('open');
  }

  function switchVaultTab(kind) {
    var tabs = document.querySelectorAll('.vault-tab-btn');
    var panels = document.querySelectorAll('.vault-tab-panel');
    tabs.forEach(function (btn) {
      var active = btn.getAttribute('data-vault-tab') === kind;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    panels.forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-vault-panel') === kind);
    });
  }

  /* ---- Wire up DOM once loaded ----------------------------------------- */
  function wireVaultUI() {
    var trigger = document.getElementById('vault-trigger-btn');
    if (trigger) trigger.addEventListener('click', function () { openVaultModal('sql'); });

    var closeBtn = document.getElementById('vault-modal-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeVaultModal);

    var modal = document.getElementById('vault-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeVaultModal();
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && modal.classList.contains('open')) closeVaultModal();
    });

    var tabBtns = document.querySelectorAll('.vault-tab-btn');
    tabBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchVaultTab(btn.getAttribute('data-vault-tab'));
      });
    });

    /* V2 SQL Templates */
    var sqlSaveBtn = document.getElementById('vault-sql-save-btn');
    if (sqlSaveBtn) sqlSaveBtn.addEventListener('click', function () {
      var query = currentSQLQuery();
      if (!query || !query.trim()) {
        window.showToast && window.showToast('Write a query in the SQL editor first.', 'warn');
        return;
      }
      var name = window.prompt('Name this SQL template:', 'My Query');
      if (name === null) return;
      var tagsRaw = window.prompt('Tags (comma separated, optional):', '');
      var tags = tagsRaw ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : [];
      saveSQL(name, query, tags);
      window.showToast && window.showToast('SQL template saved to Vault.', 'success');
      window.LevelSystem && window.LevelSystem.addXP && window.LevelSystem.addXP('vault_save_sql', 5);
    });

    var sqlSearch = document.getElementById('vault-sql-search');
    if (sqlSearch) sqlSearch.addEventListener('input', renderSQLList);

    var sqlList = document.getElementById('vault-sql-list');
    if (sqlList) sqlList.addEventListener('click', function (e) {
      var loadBtn = e.target.closest ? e.target.closest('.vault-load-sql-btn') : null;
      var delBtn = e.target.closest ? e.target.closest('.vault-delete-sql-btn') : null;
      if (loadBtn) {
        var rec = vaultState.sqlTemplates.find(function (t) { return t.id === loadBtn.getAttribute('data-id'); });
        if (rec) loadIntoSQLEditor(rec.query, true);
      } else if (delBtn) {
        deleteSQL(delBtn.getAttribute('data-id'));
      }
    });

    /* V3 Transform Presets */
    var transformSaveBtn = document.getElementById('vault-transform-save-btn');
    if (transformSaveBtn) transformSaveBtn.addEventListener('click', function () {
      var name = window.prompt('Name this transform preset:', 'My Preset');
      if (name === null) return;
      var ds = window.getActiveDataset && window.getActiveDataset();
      var steps = [];
      if (ds && ds.columns && ds.columns.length) {
        steps = ds.columns.slice(0, 3).map(function (c) {
          return { type: 'rename', column: c.name, to: c.name };
        });
      }
      saveTransform(name, steps);
      window.showToast && window.showToast('Transform preset saved to Vault.', 'success');
      window.LevelSystem && window.LevelSystem.addXP && window.LevelSystem.addXP('vault_save_transform', 5);
    });

    var transformSearch = document.getElementById('vault-transform-search');
    if (transformSearch) transformSearch.addEventListener('input', renderTransformList);

    var transformList = document.getElementById('vault-transform-list');
    if (transformList) transformList.addEventListener('click', function (e) {
      var applyBtn = e.target.closest ? e.target.closest('.vault-apply-transform-btn') : null;
      var delBtn = e.target.closest ? e.target.closest('.vault-delete-transform-btn') : null;
      if (applyBtn) {
        applyTransformPreset(applyBtn.getAttribute('data-id'));
      } else if (delBtn) {
        deleteTransform(delBtn.getAttribute('data-id'));
      }
    });

    /* V4 Column Profiles */
    var profileSaveBtn = document.getElementById('vault-profile-save-btn');
    if (profileSaveBtn) profileSaveBtn.addEventListener('click', function () {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) {
        window.showToast && window.showToast('Load a dataset first.', 'warn');
        return;
      }
      var name = window.prompt('Name this snapshot:', ds.name + ' snapshot');
      if (name === null) return;
      snapshotColumns(name);
      window.showToast && window.showToast('Column profile snapshot saved.', 'success');
      window.LevelSystem && window.LevelSystem.addXP && window.LevelSystem.addXP('vault_save_profile', 5);
    });

    var profileSearch = document.getElementById('vault-profile-search');
    if (profileSearch) profileSearch.addEventListener('input', renderProfileList);

    var profileList = document.getElementById('vault-profile-list');
    if (profileList) profileList.addEventListener('click', function (e) {
      var cmpBtn = e.target.closest ? e.target.closest('.vault-compare-profile-btn') : null;
      var delBtn = e.target.closest ? e.target.closest('.vault-delete-profile-btn') : null;
      if (cmpBtn) {
        toggleProfileCompare(cmpBtn.getAttribute('data-id'));
      } else if (delBtn) {
        deleteProfile(delBtn.getAttribute('data-id'));
      }
    });

    /* V5 Peer Reviews */
    var reviewSaveBtn = document.getElementById('vault-review-save-btn');
    if (reviewSaveBtn) reviewSaveBtn.addEventListener('click', function () {
      promptSavePeerReview();
    });

    var reviewSearch = document.getElementById('vault-review-search');
    if (reviewSearch) reviewSearch.addEventListener('input', renderReviewList);

    var reviewList = document.getElementById('vault-review-list');
    if (reviewList) reviewList.addEventListener('click', function (e) {
      var delBtn = e.target.closest ? e.target.closest('.vault-delete-review-btn') : null;
      if (delBtn) deleteReview(delBtn.getAttribute('data-id'));
    });

    /* V6 Query History */
    var historyClearBtn = document.getElementById('vault-history-clear-btn');
    if (historyClearBtn) historyClearBtn.addEventListener('click', clearUnstarredHistory);

    var historySearch = document.getElementById('vault-history-search');
    if (historySearch) historySearch.addEventListener('input', renderHistoryList);

    var historyList = document.getElementById('vault-history-list');
    if (historyList) historyList.addEventListener('click', function (e) {
      var starBtn = e.target.closest ? e.target.closest('.vault-star-btn') : null;
      var rerunBtn = e.target.closest ? e.target.closest('.vault-rerun-btn') : null;
      if (starBtn) {
        toggleStar(starBtn.getAttribute('data-id'));
      } else if (rerunBtn) {
        rerunHistoryQuery(rerunBtn.getAttribute('data-id'));
      }
    });

    /* V7 Export / Import */
    var exportBtn = document.getElementById('vault-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportVault);

    var importBtn = document.getElementById('vault-import-btn');
    var importInput = document.getElementById('vault-import-file-input');
    if (importBtn && importInput) importBtn.addEventListener('click', function () { importInput.click(); });
    if (importInput) importInput.addEventListener('change', function () {
      if (importInput.files && importInput.files[0]) readImportFile(importInput.files[0]);
      importInput.value = '';
    });

    var dropzone = document.getElementById('vault-dropzone');
    if (dropzone) {
      dropzone.addEventListener('dragover', function (e) {
        e.preventDefault();
        dropzone.classList.add('drag-over');
      });
      dropzone.addEventListener('dragleave', function () {
        dropzone.classList.remove('drag-over');
      });
      dropzone.addEventListener('drop', function (e) {
        e.preventDefault();
        dropzone.classList.remove('drag-over');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          readImportFile(e.dataTransfer.files[0]);
        }
      });
    }
  }

  /* ---- Auto-wire: SQL query history (after #sql-view-run click) -------- */
  function wireSQLHistoryAutosave() {
    var runBtn = document.getElementById('sql-view-run');
    if (!runBtn) return;
    runBtn.addEventListener('click', function () {
      var input = document.getElementById('sql-view-input');
      var query = input ? input.value.trim() : '';
      if (!query) return;
      setTimeout(function () {
        var statusEl = document.getElementById('sql-view-status');
        var rowCount = 0;
        if (statusEl && statusEl.className === 'success') {
          var match = /^([\d,]+)\s+row/.exec(statusEl.textContent || '');
          if (match) rowCount = parseInt(match[1].replace(/,/g, ''), 10) || 0;
        }
        pushHistory(query, rowCount);
      }, 400);
    });
  }

  /* ---- Auto-wire: Peer review "Save to Vault?" prompt --------------- */
  function showSaveReviewToast() {
    var existing = document.getElementById('vault-review-toast');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.id = 'vault-review-toast';
    el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:16000;padding:12px 16px;border-radius:10px;font-size:13px;color:var(--text);background:var(--surface);border:1px solid var(--border);box-shadow:0 8px 24px rgba(0,0,0,0.25);display:flex;align-items:center;gap:12px;max-width:340px;font-family:inherit;';
    el.innerHTML = '<span>Peer review complete. Save to Vault?</span>';
    var btn = document.createElement('button');
    btn.textContent = 'Save';
    btn.style.cssText = 'background:var(--primary);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;font-family:inherit;';
    btn.addEventListener('click', function () {
      el.remove();
      promptSavePeerReview();
    });
    var dismissBtn = document.createElement('button');
    dismissBtn.textContent = '\u00d7';
    dismissBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);font-size:16px;cursor:pointer;padding:0 4px;';
    dismissBtn.addEventListener('click', function () { el.remove(); });
    el.appendChild(btn);
    el.appendChild(dismissBtn);
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 12000);
  }

  function promptSavePeerReview() {
    var gradeEl = document.getElementById('review-grade-big');
    var gradeLabelEl = document.getElementById('review-grade-label');
    var feedEl = document.getElementById('review-feed');
    if (!feedEl || feedEl.querySelector('.review-empty')) {
      window.showToast && window.showToast('Run a peer review first.', 'warn');
      return;
    }
    var ds = window.getActiveDataset && window.getActiveDataset();
    var datasetName = ds ? ds.name : 'Unknown dataset';
    var scoreMatch = gradeLabelEl ? /(\d+)\/100/.exec(gradeLabelEl.textContent || '') : null;
    var score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
    var findings = [];
    var items = feedEl.querySelectorAll('.review-item');
    items.forEach(function (item) {
      var cat = item.querySelector('.review-cat');
      var msg = item.querySelector('.review-msg');
      findings.push({
        cat: cat ? cat.textContent : '',
        msg: msg ? msg.textContent : ''
      });
    });
    var name = window.prompt('Name this peer review save:', datasetName + ' review');
    if (name === null) return;
    savePeerReview(name, datasetName, score, findings);
    window.showToast && window.showToast('Peer review saved to Vault.', 'success');
    window.LevelSystem && window.LevelSystem.addXP && window.LevelSystem.addXP('vault_save_review', 5);
  }

  function wirePeerReviewAutoPrompt() {
    if (window.PeerReview && typeof window.PeerReview.run === 'function') {
      var originalRun = window.PeerReview.run;
      window.PeerReview.run = function () {
        var result = originalRun.apply(this, arguments);
        setTimeout(function () {
          var feedEl = document.getElementById('review-feed');
          if (feedEl && !feedEl.querySelector('.review-empty')) showSaveReviewToast();
        }, 150);
        return result;
      };
    }
  }

  function initVault() {
    wireVaultUI();
    wireSQLHistoryAutosave();
    wirePeerReviewAutoPrompt();
    updateIOSummary();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVault);
  } else {
    initVault();
  }

  /* ---- Public API ------------------------------------------------------ */
  window.DataGlowVault = {
    sqlTemplates: vaultState.sqlTemplates,
    transformPresets: vaultState.transformPresets,
    columnProfiles: vaultState.columnProfiles,
    peerReviews: vaultState.peerReviews,
    queryHistory: vaultState.queryHistory,
    saveSQL: saveSQL,
    saveTransform: saveTransform,
    snapshotColumns: snapshotColumns,
    savePeerReview: savePeerReview,
    getHistory: getHistory,
    exportVault: exportVault,
    importVault: importVault,
    open: openVaultModal,
    close: closeVaultModal
  };
