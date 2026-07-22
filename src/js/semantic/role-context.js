/* ---- from js/semantic/role-context.js ---- */
/* ================================================================
   DataGlow Role Context (Session C, PR #532)
   Feature flag: window.FEATURE_FLAGS.roleContext

   The problem: a CFO and a bedside nurse can ask the same question
   of the same dataset and get identical suggested questions, because
   the system knows nothing about who is asking.

   What it does:
     - A compact role chip sits in the NL bar, left of the input
     - On first load: "Who are you?" selector (5 roles, tap once)
     - Persisted in OPFS (dg-role.json) -- survives refresh
     - Question Prompter reads window.RoleContext.current()
       and prepends role-specific question templates
     - Emits dataglow:role-changed on update

   Roles:
     analyst     -- Show me distributions, outliers, correlations
     clinician   -- Flag patient safety signals, abnormal vitals
     finance     -- Revenue drivers, cost breakdown, variance
     ops         -- Throughput, SLA breaches, queue depth
     executive   -- KPI summary, trend vs. prior period, at-risk items

   The chip is compact (initials or icon + label, tappable to change).
   It does NOT block work -- if the analyst dismisses "Who are you?"
   without picking, role stays null and Question Prompter uses generic
   templates. No gate. No friction penalty.
================================================================ */
(function () {
  'use strict';

  var FLAG = 'roleContext';
  var OPFS_FILE = 'dg-role.json';

  function isEnabled() {
    return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG]);
  }

  var ROLES = [
    {
      id: 'analyst',
      label: 'Analyst',
      icon: '&#x1F4CA;',
      color: 'var(--primary, #20C5B5)',
      questions: [
        'Show me the distribution of {col}',
        'Which {col} values are outliers?',
        'Correlation between {col1} and {col2}',
        'Find rows where {col} is null or blank',
        'Top 10 {col} by count'
      ]
    },
    {
      id: 'clinician',
      label: 'Clinician',
      icon: '&#x2695;&#xFE0F;',
      color: '#4AE38A',
      questions: [
        'Flag rows with abnormal {col} values',
        'How many patients have {col} above threshold?',
        'Show {col} trend for the last 30 days',
        'Which records are missing required fields?',
        'Group outcomes by {col}'
      ]
    },
    {
      id: 'finance',
      label: 'Finance',
      icon: '&#x1F4B0;',
      color: '#F5A623',
      questions: [
        'Show revenue by {col} for this period',
        'What drove the change in {col} vs. prior period?',
        'Break down costs by {col}',
        'Find {col} variance > 5%',
        'Which {col} segments are underperforming?'
      ]
    },
    {
      id: 'ops',
      label: 'Operations',
      icon: '&#x2699;&#xFE0F;',
      color: '#A86FDF',
      questions: [
        'Where are the bottlenecks in {col}?',
        'Average {col} processing time by {col2}',
        'Show SLA breaches by {col}',
        'Queue depth by hour for {col}',
        'Which {col} steps have the most failures?'
      ]
    },
    {
      id: 'executive',
      label: 'Executive',
      icon: '&#x1F3AF;',
      color: '#DD6974',
      questions: [
        'Summarize key metrics in one paragraph',
        'What changed most vs. last period?',
        'Which {col} are at risk?',
        'Show me the headline KPIs',
        'What requires immediate attention?'
      ]
    }
  ];

  /* ----------------------------------------------------------------
     OPFS persistence
  ---------------------------------------------------------------- */
  var _role = null;
  var _loaded = false;

  function loadRole() {
    if (_loaded) return Promise.resolve(_role);
    if (!navigator.storage || !navigator.storage.getDirectory) {
      _loaded = true;
      return Promise.resolve(null);
    }
    return navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(OPFS_FILE)
        .then(function (fh) { return fh.getFile(); })
        .then(function (f)  { return f.text(); })
        .then(function (t)  {
          try { _role = JSON.parse(t); } catch (_) { _role = null; }
          _loaded = true;
          return _role;
        });
    }).catch(function () { _loaded = true; return null; });
  }

  function saveRole() {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(OPFS_FILE, { create: true })
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w)  { return w.write(JSON.stringify(_role)).then(function () { return w.close(); }); });
    }).catch(function () {});
  }

  /* ----------------------------------------------------------------
     Set / get role
  ---------------------------------------------------------------- */
  function setRole(roleId) {
    _role = roleId;
    saveRole();
    updateChip();
    document.dispatchEvent(new CustomEvent('dataglow:role-changed', {
      detail: { role: roleId, roleData: getRoleData(roleId) }
    }));
  }

  function getRoleData(id) {
    return ROLES.find(function (r) { return r.id === id; }) || null;
  }

  function currentRole() { return _role; }
  function currentRoleData() { return getRoleData(_role); }

  /* ----------------------------------------------------------------
     Role chip
  ---------------------------------------------------------------- */
  function buildChip() {
    var chip = document.createElement('button');
    chip.id = 'dg-role-chip';
    chip.className = 'dg-role-chip';
    chip.setAttribute('data-testid', 'button-role-chip');
    chip.setAttribute('aria-label', 'Select your role');
    chip.setAttribute('data-flag-tier', '1');
    chip.innerHTML = _role
      ? _renderChipContent(getRoleData(_role))
      : '<span class="dg-role-chip-placeholder">Who are you?</span>';
    chip.addEventListener('click', function () { toggleRoleSelector(chip); });
    return chip;
  }

  function _renderChipContent(roleData) {
    if (!roleData) return '<span class="dg-role-chip-placeholder">Role</span>';
    return '<span class="dg-role-chip-icon" aria-hidden="true">' + roleData.icon + '</span>' +
           '<span class="dg-role-chip-label">' + roleData.label + '</span>';
  }

  function updateChip() {
    var chip = document.getElementById('dg-role-chip');
    if (!chip) return;
    var rd = getRoleData(_role);
    chip.innerHTML = rd ? _renderChipContent(rd) : '<span class="dg-role-chip-placeholder">Who are you?</span>';
    if (rd) chip.style.borderColor = rd.color;
    else chip.style.borderColor = '';
  }

  /* ----------------------------------------------------------------
     Role selector popover
  ---------------------------------------------------------------- */
  var _selectorOpen = false;

  function toggleRoleSelector(anchor) {
    var existing = document.getElementById('dg-role-selector');
    if (existing) {
      if (existing.parentNode) existing.parentNode.removeChild(existing);
      _selectorOpen = false;
      return;
    }
    _selectorOpen = true;
    var sel = document.createElement('div');
    sel.id = 'dg-role-selector';
    sel.className = 'dg-role-selector';
    sel.setAttribute('role', 'listbox');
    sel.setAttribute('aria-label', 'Select your role');

    sel.innerHTML = '<p class="dg-rs-prompt">Who are you today?</p>' +
      ROLES.map(function (r) {
        var active = _role === r.id ? ' dg-rs-opt-active' : '';
        return '<button class="dg-rs-opt' + active + '" data-role="' + r.id + '"' +
          ' data-testid="button-role-' + r.id + '" role="option"' +
          ' style="--role-color:' + r.color + '">' +
          '<span class="dg-rs-icon">' + r.icon + '</span>' +
          '<div class="dg-rs-text"><span class="dg-rs-label">' + r.label + '</span>' +
          '<span class="dg-rs-sample">' + r.questions[0].replace('{col}', 'column') + '</span></div>' +
          '</button>';
      }).join('') +
      (_role ? '<button class="dg-rs-clear" data-testid="button-role-clear">Clear role</button>' : '');

    if (anchor) {
      var rect = anchor.getBoundingClientRect();
      sel.style.cssText = 'position:fixed;bottom:' + (window.innerHeight - rect.top + 8) + 'px;left:' + Math.max(8, rect.left) + 'px;z-index:15000';
    }

    document.body.appendChild(sel);

    sel.addEventListener('click', function (e) {
      var opt = e.target.closest('[data-role]');
      if (opt) { setRole(opt.getAttribute('data-role')); sel.parentNode.removeChild(sel); _selectorOpen = false; return; }
      var clr = e.target.closest('.dg-rs-clear');
      if (clr) { setRole(null); sel.parentNode.removeChild(sel); _selectorOpen = false; }
    });

    setTimeout(function () {
      document.addEventListener('click', function onOut(e) {
        var s = document.getElementById('dg-role-selector');
        var c = document.getElementById('dg-role-chip');
        if (s && !s.contains(e.target) && e.target !== c && !c.contains(e.target)) {
          if (s.parentNode) s.parentNode.removeChild(s);
          _selectorOpen = false;
          document.removeEventListener('click', onOut);
        }
      });
    }, 50);
  }

  /* ----------------------------------------------------------------
     Inject chip into agent bar (left of nl-query-input)
  ---------------------------------------------------------------- */
  function injectChip() {
    if (document.getElementById('dg-role-chip')) return;
    var chip = buildChip();
    var agentBar = document.getElementById('agent-bar');
    var wrap = document.getElementById('nl-query-wrap');
    var input = document.getElementById('nl-query-input');

    if (input && input.parentNode) {
      input.parentNode.insertBefore(chip, input);
    } else if (wrap) {
      wrap.insertBefore(chip, wrap.firstChild);
    } else if (agentBar) {
      agentBar.insertBefore(chip, agentBar.firstChild);
    }

    /* If no role set yet, pulse gently to draw attention (once) */
    if (!_role) {
      chip.classList.add('dg-role-chip-pulse');
      setTimeout(function () { chip.classList.remove('dg-role-chip-pulse'); }, 3000);
    }
  }

  /* ----------------------------------------------------------------
     Question Prompter integration
     RoleContext.getQuestions(cols) returns role-aware question suggestions.
  ---------------------------------------------------------------- */
  function getQuestions(cols) {
    var rd = currentRoleData();
    if (!rd) return null; /* Question Prompter uses its own generic list */
    var colA = (cols && cols[0]) || 'value';
    var colB = (cols && cols[1]) || 'category';
    return rd.questions.map(function (q) {
      return q.replace(/\{col2\}/g, colB).replace(/\{col\}/g, colA);
    });
  }

  /* ----------------------------------------------------------------
     Init
  ---------------------------------------------------------------- */
  function init() {
    if (!isEnabled()) return;

    loadRole().then(function () {
      document.addEventListener('dataglow:dataset-loaded', function () {
        injectChip();
      });

      window.RoleContext = {
        current:       currentRole,
        currentData:   currentRoleData,
        set:           setRole,
        roles:         ROLES,
        getQuestions:  getQuestions
      };
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/semantic/role-context.js ---- */
