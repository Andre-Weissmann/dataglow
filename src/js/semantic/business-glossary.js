/* ---- from js/semantic/business-glossary.js ---- */
/* ================================================================
   DataGlow Business Glossary (Session D, PR #536)
   Feature flag: window.FEATURE_FLAGS.businessGlossary

   The gap: before SQL runs, "revenue" might mean gross revenue,
   net revenue, or something completely different depending on who
   defined the schema. The Business Glossary makes the definition
   explicit -- visible at the moment the analyst types.

   What it does:
     - Term-to-definition store (OPFS: dg-glossary.json, max 80 terms)
     - Each term has: term, definition, sql_expr (optional),
       aliases, owner, category, source
     - NL bar tooltip: when analyst pauses typing (500ms debounce),
       any glossary term found in the query triggers an inline tooltip
       showing the definition BEFORE Enter is hit
     - Glossary panel: browse, search, add, delete terms
     - SQL intercept comment: when a glossary term is used in a query,
       a SQL comment header is prepended:
         /* Glossary: revenue = gross sales minus returns; churn = ... * /
       This makes the assumption explicit in the proof artifact.
     - Emits: dataglow:glossary-term-added, dataglow:glossary-term-triggered
     - Seeded with 8 common healthcare/analytics terms on first run
================================================================ */
(function () {
  'use strict';

  var FLAG     = 'businessGlossary';
  var OPFS_FILE = 'dg-glossary.json';
  var MAX_TERMS = 80;

  var SEED_TERMS = [
    { term: 'revenue',    definition: 'Total income generated from sales before deductions.', sql_expr: 'SUM(amount)', aliases: ['gross revenue'], owner: 'DataGlow', category: 'finance', source: 'default' },
    { term: 'churn',      definition: 'Rate at which customers stop using the service over a period.', sql_expr: '', aliases: ['attrition'], owner: 'DataGlow', category: 'product', source: 'default' },
    { term: 'dau',        definition: 'Daily Active Users -- unique users who performed at least one action in a 24h window.', sql_expr: 'COUNT(DISTINCT user_id)', aliases: ['daily active users'], owner: 'DataGlow', category: 'product', source: 'default' },
    { term: 'cohort',     definition: 'A group of patients or users sharing a common characteristic defined at a specific time point.', sql_expr: '', aliases: [], owner: 'DataGlow', category: 'clinical', source: 'default' },
    { term: 'readmission', definition: '30-day hospital readmission: patient return within 30 days of discharge for related condition.', sql_expr: '', aliases: ['30-day readmit'], owner: 'DataGlow', category: 'clinical', source: 'default' },
    { term: 'los',        definition: 'Length of Stay -- number of days from admission to discharge.', sql_expr: 'DATEDIFF(discharge_date, admit_date)', aliases: ['length of stay'], owner: 'DataGlow', category: 'clinical', source: 'default' },
    { term: 'cac',        definition: 'Customer Acquisition Cost -- total sales and marketing spend divided by new customers acquired.', sql_expr: '', aliases: ['customer acquisition cost'], owner: 'DataGlow', category: 'finance', source: 'default' },
    { term: 'p&l',        definition: 'Profit and Loss -- summary of revenues, costs, and expenses over a specific period.', sql_expr: '', aliases: ['profit and loss','income statement'], owner: 'DataGlow', category: 'finance', source: 'default' }
  ];

  var CATEGORIES = ['finance','product','clinical','operations','compliance','custom'];

  /* ----------------------------------------------------------------
     OPFS
  ---------------------------------------------------------------- */
  var _terms  = [];
  var _loaded = false;

  function load() {
    if (_loaded) return Promise.resolve(_terms);
    if (!navigator.storage || !navigator.storage.getDirectory) {
      _terms = SEED_TERMS.map(function (t) { return Object.assign({ created: Date.now(), used: 0 }, t); });
      _loaded = true;
      return Promise.resolve(_terms);
    }
    return navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(OPFS_FILE)
        .then(function (fh) { return fh.getFile(); })
        .then(function (f)  { return f.text(); })
        .then(function (t)  {
          try { _terms = JSON.parse(t) || []; } catch(_) { _terms = []; }
          /* Seed if empty */
          if (!_terms.length) {
            _terms = SEED_TERMS.map(function (t) { return Object.assign({ created: Date.now(), used: 0 }, t); });
            save();
          }
          _loaded = true;
          return _terms;
        });
    }).catch(function () {
      _terms = SEED_TERMS.map(function (t) { return Object.assign({ created: Date.now(), used: 0 }, t); });
      _loaded = true;
      return _terms;
    });
  }

  function save() {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(OPFS_FILE, { create: true })
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w)  { return w.write(JSON.stringify(_terms)).then(function () { return w.close(); }); });
    }).catch(function () {});
  }

  /* ----------------------------------------------------------------
     Term CRUD
  ---------------------------------------------------------------- */
  function addTerm(opts) {
    var term = (opts.term || '').trim().toLowerCase();
    if (!term || !opts.definition) return { ok: false, error: 'Term and definition required.' };
    if (_terms.length >= MAX_TERMS) return { ok: false, error: 'Maximum ' + MAX_TERMS + ' terms reached.' };
    if (_terms.some(function (t) { return t.term === term; })) {
      return { ok: false, error: '"' + term + '" already defined.' };
    }
    var aliases = (opts.aliases || '').split(',').map(function (a) { return a.trim().toLowerCase(); }).filter(Boolean);
    var entry = {
      term:       term,
      definition: opts.definition.trim(),
      sql_expr:   (opts.sql_expr || '').trim(),
      aliases:    aliases,
      owner:      opts.owner || 'this analyst',
      category:   CATEGORIES.includes(opts.category) ? opts.category : 'custom',
      source:     'user',
      created:    Date.now(),
      used:       0
    };
    _terms.push(entry);
    save();
    document.dispatchEvent(new CustomEvent('dataglow:glossary-term-added', { detail: { term: term } }));
    return { ok: true };
  }

  function deleteTerm(term) {
    _terms = _terms.filter(function (t) { return t.term !== term; });
    save();
  }

  function getTerms(category) {
    if (category) return _terms.filter(function (t) { return t.category === category; });
    return _terms.slice();
  }

  /* ----------------------------------------------------------------
     Term detection (check a query string for glossary terms)
  ---------------------------------------------------------------- */
  function detectTerms(text) {
    if (!text || !_terms.length) return [];
    var lower = text.toLowerCase();
    var found = [];
    _terms.forEach(function (t) {
      var allForms = [t.term].concat(t.aliases || []);
      var hit = allForms.some(function (form) {
        return form && lower.includes(form.toLowerCase());
      });
      if (hit && !found.find(function (f) { return f.term === t.term; })) {
        found.push(t);
      }
    });
    return found;
  }

  /* ----------------------------------------------------------------
     Inline tooltip (shows BEFORE Enter)
  ---------------------------------------------------------------- */
  var _tooltipEl = null;
  var _debounce  = null;

  function showTooltip(terms, anchorEl) {
    removeTooltip();
    if (!terms.length || !anchorEl) return;
    _tooltipEl = document.createElement('div');
    _tooltipEl.id = 'dg-glossary-tooltip';
    _tooltipEl.className = 'dg-glossary-tooltip';
    _tooltipEl.setAttribute('role', 'tooltip');
    _tooltipEl.innerHTML = terms.map(function (t) {
      return '<div class="dg-gl-tip-item">' +
        '<span class="dg-gl-tip-term">' + t.term + '</span>' +
        '<span class="dg-gl-tip-def">' + t.definition + '</span>' +
        (t.sql_expr ? '<code class="dg-gl-tip-expr">' + t.sql_expr + '</code>' : '') +
      '</div>';
    }).join('') +
    '<div class="dg-gl-tip-hint">Definitions will appear as comments in generated SQL.</div>';
    document.body.appendChild(_tooltipEl);
    /* Position above the NL bar */
    var rect = anchorEl.getBoundingClientRect();
    _tooltipEl.style.cssText = 'position:fixed;bottom:' + (window.innerHeight - rect.top + 6) + 'px;left:' + rect.left + 'px;z-index:16000';
    requestAnimationFrame(function () { _tooltipEl.classList.add('dg-gl-visible'); });
  }

  function removeTooltip() {
    if (_tooltipEl && _tooltipEl.parentNode) _tooltipEl.parentNode.removeChild(_tooltipEl);
    _tooltipEl = null;
  }

  /* ----------------------------------------------------------------
     SQL comment injection
     Prepends a Glossary comment block to generated SQL when terms hit.
  ---------------------------------------------------------------- */
  function buildGlossaryComment(foundTerms) {
    if (!foundTerms.length) return '';
    var lines = foundTerms.map(function (t) {
      return ' * ' + t.term + ': ' + t.definition + (t.sql_expr ? ' [expr: ' + t.sql_expr + ']' : '');
    });
    return '/*\n * Glossary assumptions for this query:\n' + lines.join('\n') + '\n */\n';
  }

  /* Intercept the NL-to-SQL pipeline to prepend the glossary comment */
  function hookSqlOutput() {
    document.addEventListener('dataglow:sql-generated', function (e) {
      if (!_terms.length) return;
      var query = e.detail && e.detail.nlQuery ? e.detail.nlQuery : '';
      var found = detectTerms(query);
      if (!found.length) return;
      found.forEach(function (t) { t.used++; });
      save();
      var comment = buildGlossaryComment(found);
      if (e.detail && comment) {
        e.detail.sqlComment = comment;
      }
      document.dispatchEvent(new CustomEvent('dataglow:glossary-term-triggered', { detail: { terms: found.map(function (t) { return t.term; }) } }));
    });
  }

  /* ----------------------------------------------------------------
     NL bar input hook -- debounced tooltip
  ---------------------------------------------------------------- */
  function hookNlBar() {
    var input = document.getElementById('nl-query-input');
    if (!input) { setTimeout(hookNlBar, 900); return; }
    input.addEventListener('input', function () {
      clearTimeout(_debounce);
      if (!input.value.trim()) { removeTooltip(); return; }
      _debounce = setTimeout(function () {
        var found = detectTerms(input.value);
        if (found.length) { showTooltip(found, input); }
        else { removeTooltip(); }
      }, 500);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        clearTimeout(_debounce);
        removeTooltip();
      }
      if (e.key === 'Escape') { removeTooltip(); }
    });
    input.addEventListener('blur', function () {
      clearTimeout(_debounce);
      setTimeout(removeTooltip, 200);
    });
  }

  /* ----------------------------------------------------------------
     Glossary panel
  ---------------------------------------------------------------- */
  var _panelOpen = false;

  function toggleGlossaryPanel() {
    var existing = document.getElementById('dg-glossary-panel');
    if (existing) {
      existing.classList.remove('dg-gl-panel-open');
      setTimeout(function () { if (existing.parentNode) existing.parentNode.removeChild(existing); }, 220);
      _panelOpen = false;
      return;
    }
    _panelOpen = true;
    renderPanel();
  }

  function renderPanel() {
    var panel = document.createElement('div');
    panel.id = 'dg-glossary-panel';
    panel.className = 'dg-glossary-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Business Glossary');
    panel.innerHTML = _buildPanelHTML();
    _positionPanel(panel);
    document.body.appendChild(panel);
    requestAnimationFrame(function () { panel.classList.add('dg-gl-panel-open'); });

    panel.querySelector('#dg-gl-search').addEventListener('input', function () {
      panel.querySelector('#dg-gl-list').innerHTML = _buildTermList(this.value.trim(), _activeCategory(panel));
      _wireListEvents(panel);
    });
    panel.querySelectorAll('[data-glcat]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        panel.querySelectorAll('[data-glcat]').forEach(function (t) { t.classList.remove('active'); });
        this.classList.add('active');
        panel.querySelector('#dg-gl-list').innerHTML = _buildTermList(panel.querySelector('#dg-gl-search').value.trim(), this.getAttribute('data-glcat') === 'all' ? null : this.getAttribute('data-glcat'));
        _wireListEvents(panel);
      });
    });
    panel.querySelector('#dg-gl-add-btn').addEventListener('click', function () { _handleAdd(panel); });
    panel.querySelector('.dg-gl-close').addEventListener('click', toggleGlossaryPanel);
    _wireListEvents(panel);
    panel.querySelector('#dg-gl-term').focus();

    setTimeout(function () {
      document.addEventListener('click', function onOut(e) {
        var p2 = document.getElementById('dg-glossary-panel');
        var btn = document.getElementById('dg-glossary-btn');
        if (p2 && !p2.contains(e.target) && (!btn || !btn.contains(e.target))) {
          if (p2.parentNode) p2.parentNode.removeChild(p2);
          _panelOpen = false;
          document.removeEventListener('click', onOut);
        }
      });
    }, 50);
  }

  function _activeCategory(panel) {
    var tab = panel.querySelector('[data-glcat].active');
    return tab && tab.getAttribute('data-glcat') !== 'all' ? tab.getAttribute('data-glcat') : null;
  }

  function _buildPanelHTML() {
    var catTabs = ['all'].concat(CATEGORIES).map(function (c) {
      return '<button class="dg-gl-cat-tab' + (c === 'all' ? ' active' : '') + '" data-glcat="' + c + '">' + c + '</button>';
    }).join('');
    return '<div class="dg-gl-header">' +
      '<span class="dg-gl-title">Business Glossary</span>' +
      '<span class="dg-gl-count">' + _terms.length + ' terms</span>' +
      '<button class="dg-gl-close" aria-label="Close Glossary">' +
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
      '</button>' +
    '</div>' +
    '<input id="dg-gl-search" class="dg-gl-search" type="text" placeholder="Search terms..." autocomplete="off" data-testid="input-glossary-search"/>' +
    '<div class="dg-gl-cat-tabs">' + catTabs + '</div>' +
    '<div id="dg-gl-list" class="dg-gl-list">' + _buildTermList('', null) + '</div>' +
    '<div class="dg-gl-add-form">' +
      '<div class="dg-gl-add-title">Define term</div>' +
      '<div class="dg-gl-add-row">' +
        '<input id="dg-gl-term" class="dg-gl-input" type="text" placeholder="Term" maxlength="40" data-testid="input-glossary-term" autocomplete="off"/>' +
        '<select id="dg-gl-cat" class="dg-gl-select" data-testid="select-glossary-category">' +
          CATEGORIES.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('') +
        '</select>' +
      '</div>' +
      '<textarea id="dg-gl-def" class="dg-gl-textarea" placeholder="Definition" rows="2" data-testid="input-glossary-def"></textarea>' +
      '<input id="dg-gl-expr" class="dg-gl-input" type="text" placeholder="SQL expression (optional)" data-testid="input-glossary-expr" autocomplete="off"/>' +
      '<input id="dg-gl-aliases" class="dg-gl-input" type="text" placeholder="Aliases (comma-separated)" data-testid="input-glossary-aliases" autocomplete="off"/>' +
      '<input id="dg-gl-owner" class="dg-gl-input" type="text" placeholder="Owner" maxlength="40" data-testid="input-glossary-owner" autocomplete="off"/>' +
      '<p id="dg-gl-error" class="dg-gl-error hidden"></p>' +
      '<button id="dg-gl-add-btn" class="dg-gl-add-btn" data-testid="button-glossary-add">Add Term</button>' +
    '</div>';
  }

  function _buildTermList(search, category) {
    var items = _terms.filter(function (t) {
      var matchSearch = !search || t.term.includes(search.toLowerCase()) ||
                        t.definition.toLowerCase().includes(search.toLowerCase()) ||
                        (t.aliases || []).some(function (a) { return a.includes(search.toLowerCase()); });
      var matchCat = !category || t.category === category;
      return matchSearch && matchCat;
    });
    if (!items.length) return '<p class="dg-gl-empty">No terms' + (search ? ' match "' + search + '"' : ' defined yet') + '.</p>';
    return items.map(function (t) {
      var badge = t.source === 'default' ? '<span class="dg-gl-default-badge">built-in</span>' : '';
      return '<div class="dg-gl-item" data-testid="glossary-item-' + t.term + '">' +
        '<div class="dg-gl-item-top">' +
          '<span class="dg-gl-term-name">' + t.term + '</span>' +
          badge +
          '<span class="dg-gl-item-cat">' + t.category + '</span>' +
          (t.source !== 'default' ?
            '<button class="dg-gl-del-btn" data-del="' + t.term + '" data-testid="button-del-term-' + t.term + '" aria-label="Delete ' + t.term + '">' +
              '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
            '</button>' : '') +
        '</div>' +
        '<p class="dg-gl-def-text">' + t.definition + '</p>' +
        (t.sql_expr ? '<code class="dg-gl-expr-code">' + t.sql_expr + '</code>' : '') +
        ((t.aliases || []).length ? '<p class="dg-gl-aliases">Also: ' + t.aliases.join(', ') + '</p>' : '') +
        (t.used ? '<span class="dg-gl-used">' + t.used + 'x triggered</span>' : '') +
      '</div>';
    }).join('');
  }

  function _wireListEvents(panel) {
    panel.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteTerm(btn.getAttribute('data-del'));
        panel.querySelector('#dg-gl-list').innerHTML = _buildTermList(
          panel.querySelector('#dg-gl-search').value.trim(),
          _activeCategory(panel)
        );
        _wireListEvents(panel);
        panel.querySelector('.dg-gl-count').textContent = _terms.length + ' terms';
        if (typeof window.showToast === 'function') window.showToast('Term deleted.', 'info');
      });
    });
  }

  function _handleAdd(panel) {
    var result = addTerm({
      term:       panel.querySelector('#dg-gl-term').value,
      definition: panel.querySelector('#dg-gl-def').value,
      sql_expr:   panel.querySelector('#dg-gl-expr').value,
      aliases:    panel.querySelector('#dg-gl-aliases').value,
      owner:      panel.querySelector('#dg-gl-owner').value,
      category:   panel.querySelector('#dg-gl-cat').value
    });
    var err = panel.querySelector('#dg-gl-error');
    if (!result.ok) { err.textContent = result.error; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    ['#dg-gl-term','#dg-gl-def','#dg-gl-expr','#dg-gl-aliases','#dg-gl-owner'].forEach(function (s) {
      var el = panel.querySelector(s); if (el) el.value = '';
    });
    panel.querySelector('#dg-gl-list').innerHTML = _buildTermList('', null);
    _wireListEvents(panel);
    panel.querySelector('.dg-gl-count').textContent = _terms.length + ' terms';
    if (typeof window.showToast === 'function') window.showToast('Term defined.', 'success');
    panel.querySelector('#dg-gl-term').focus();
  }

  function _positionPanel(panel) {
    var btn = document.getElementById('dg-glossary-btn') || document.getElementById('agent-bar');
    if (btn) {
      var rect = btn.getBoundingClientRect();
      panel.style.cssText = 'position:fixed;bottom:' + (window.innerHeight - rect.top + 8) + 'px;left:' + Math.max(8, rect.left + 100) + 'px;z-index:15000';
    }
  }

  /* ----------------------------------------------------------------
     Glossary button (in agent bar)
  ---------------------------------------------------------------- */
  function injectGlossaryBtn() {
    if (document.getElementById('dg-glossary-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'dg-glossary-btn';
    btn.className = 'dg-glossary-btn';
    btn.setAttribute('data-testid', 'button-glossary');
    btn.setAttribute('aria-label', 'Business Glossary');
    btn.setAttribute('data-flag-tier', '1');
    btn.title = 'Business Glossary -- term definitions and SQL expressions';
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3h12v10H2z"/><line x1="5" y1="6" x2="11" y2="6"/><line x1="5" y1="9" x2="9" y2="9"/></svg> <span>Glossary</span>';
    btn.addEventListener('click', toggleGlossaryPanel);
    /* Place next to the KPI button */
    var kpiBtn = document.getElementById('dg-kpi-registry-btn');
    if (kpiBtn && kpiBtn.parentNode) {
      kpiBtn.parentNode.insertBefore(btn, kpiBtn.nextSibling);
    } else {
      var wrap = document.getElementById('nl-query-wrap') || document.getElementById('agent-bar');
      if (wrap) wrap.appendChild(btn);
    }
  }

  /* ----------------------------------------------------------------
     Init
  ---------------------------------------------------------------- */
  function init() {
    if (!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG])) return;
    load().then(function () {
      document.addEventListener('dataglow:dataset-loaded', function () {
        injectGlossaryBtn();
        hookNlBar();
        hookSqlOutput();
      });
      window.BusinessGlossary = {
        add:         addTerm,
        remove:      deleteTerm,
        list:        getTerms,
        detect:      detectTerms,
        comment:     buildGlossaryComment,
        openPanel:   toggleGlossaryPanel
      };
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/semantic/business-glossary.js ---- */
