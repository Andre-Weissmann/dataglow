/* ---- from js/semantic/stakeholder-templates.js ---- */
/* ================================================================
   DataGlow Stakeholder Question Templates (Session D, PR #537)
   Feature flag: window.FEATURE_FLAGS.stakeholderTemplates

   The gap: an analyst staring at a fresh dataset doesn't know what
   a CFO cares about versus what a clinical director needs.
   Stakeholder Templates bridge that gap: when a dataset is loaded,
   Gemma3 inspects the schema and generates 5-8 role-specific
   questions. The top 3 show as tappable chips above the NL bar.

   Architecture:
     1. On dataglow:dataset-loaded, inspect column names + types
     2. Route to RoleContext.current() to get the active role
     3. Build schema summary string (col names, types, row count)
     4. If Gemma3 (window.GemmaEngine) is available -- run inference
        to generate contextual questions for that role + schema
     5. If Gemma3 unavailable -- fall back to pattern-matched
        templates per role (heuristic, still schema-aware)
     6. Top 3 questions render as chips in #dg-stakeholder-chips
     7. Tapping a chip fills the NL bar
     8. Chips refresh when role changes (dataglow:role-changed)
     9. Analyst can cycle through all generated questions (Next ->)

   Chip container: inserted between #dg-kpi-chips and #agent-bar.
   Emits: dataglow:stakeholder-questions-ready
================================================================ */
(function () {
  'use strict';

  var FLAG = 'stakeholderTemplates';
  var MAX_CHIPS    = 3;
  var MAX_GENERATE = 8;

  /* ----------------------------------------------------------------
     Schema-aware heuristic templates per role
     Used as fallback when Gemma3 is unavailable.
     Column names are matched loosely by keyword.
  ---------------------------------------------------------------- */
  var ROLE_HEURISTICS = {
    analyst: [
      { keys: ['date','time','created','updated'], q: 'Show volume trend over time for {dateCol}' },
      { keys: ['amount','revenue','cost','price','sales'], q: 'What is the distribution of {col}?' },
      { keys: ['id','user','patient','customer'], q: 'How many unique {col} records are there?' },
      { keys: ['status','type','category','label'], q: 'Show breakdown by {col}' },
      { keys: ['null','missing'], q: 'Which columns have the most missing values?' },
      { keys: [], q: 'Show me the top 10 rows sorted by the most numeric column' },
      { keys: [], q: 'What columns correlate most with each other?' },
      { keys: [], q: 'Flag any values that appear only once (potential data entry errors)' }
    ],
    clinician: [
      { keys: ['admit','admission','encounter','visit'], q: 'How many admissions per month?' },
      { keys: ['discharge','discharg'], q: 'What is the average length of stay by discharge type?' },
      { keys: ['diagnosis','dx','icd'], q: 'Top 10 diagnoses by frequency' },
      { keys: ['readmit','return'], q: 'What is the 30-day readmission rate?' },
      { keys: ['age','dob','birth'], q: 'Age distribution of the patient cohort' },
      { keys: ['vital','bp','hr','bmi','weight'], q: 'Distribution of {col} -- flag outliers' },
      { keys: ['medication','med','drug','rx'], q: 'Most frequently prescribed medications' },
      { keys: [], q: 'Which patients have more than 3 encounters in the dataset?' }
    ],
    finance: [
      { keys: ['revenue','sales','amount','income'], q: 'Total {col} by month -- show trend' },
      { keys: ['cost','expense','spend'], q: 'Top cost categories by total spend' },
      { keys: ['margin','profit','net'], q: 'What is the gross margin distribution?' },
      { keys: ['region','territory','location','state'], q: 'Revenue breakdown by {col}' },
      { keys: ['customer','client','account'], q: 'Top 10 customers by revenue contribution' },
      { keys: ['budget','forecast','target'], q: 'Actual vs budget variance by category' },
      { keys: [], q: 'Which rows are driving the top 20% of total revenue?' },
      { keys: [], q: 'Show month-over-month growth rate' }
    ],
    executive: [
      { keys: ['revenue','sales','amount'], q: 'Executive summary: total {col} this period vs prior' },
      { keys: ['growth','trend','change'], q: 'What is the growth trend for key metrics?' },
      { keys: ['customer','client','user'], q: 'Customer count trend -- are we growing?' },
      { keys: ['risk','issue','flag'], q: 'Highlight any red flags or anomalies in this data' },
      { keys: [], q: 'What are the top 3 insights from this dataset?' },
      { keys: [], q: 'Which metric is most off-track this period?' },
      { keys: [], q: 'Give me a one-paragraph narrative summary of this data' },
      { keys: [], q: 'What should I be most concerned about in this data?' }
    ],
    engineer: [
      { keys: ['null','missing','blank'], q: 'Which columns have null values and how many?' },
      { keys: ['id','key','pk'], q: 'Are {col} values unique? Check for duplicates.' },
      { keys: ['date','time','created'], q: 'Are timestamps well-formed and in expected range?' },
      { keys: ['type','dtype','format'], q: 'Flag any columns with mixed data types' },
      { keys: ['row','record'], q: 'Row count and file size summary' },
      { keys: [], q: 'Show cardinality of each categorical column' },
      { keys: [], q: 'Are there any duplicate rows in this dataset?' },
      { keys: [], q: 'Which numeric columns have values outside expected range (outliers)?' }
    ]
  };

  /* ----------------------------------------------------------------
     State
  ---------------------------------------------------------------- */
  var _currentRole       = 'analyst';
  var _generatedQuestions = [];
  var _chipOffset        = 0;
  var _schema            = null;
  var _generating        = false;

  /* ----------------------------------------------------------------
     Schema inspector
     Builds a compact string description of the loaded dataset.
  ---------------------------------------------------------------- */
  function buildSchemaString(schema) {
    if (!schema) return '';
    var cols = schema.columns || schema.cols || [];
    var rows = schema.rowCount || schema.rows || '?';
    if (!cols.length) return '';
    var summary = cols.slice(0, 20).map(function (c) {
      var name = c.name || c;
      var type = c.type || c.dtype || 'unknown';
      return name + ':' + type;
    }).join(', ');
    return rows + ' rows. Columns: ' + summary + (cols.length > 20 ? '... and ' + (cols.length - 20) + ' more' : '');
  }

  /* ----------------------------------------------------------------
     Heuristic question generator (no AI -- schema-aware)
  ---------------------------------------------------------------- */
  function heuristicQuestions(role, schema) {
    var cols = (schema && (schema.columns || schema.cols)) || [];
    var colNames = cols.map(function (c) { return (c.name || c).toLowerCase(); });
    var heuristics = ROLE_HEURISTICS[role] || ROLE_HEURISTICS.analyst;
    var questions = [];

    heuristics.forEach(function (h) {
      if (questions.length >= MAX_GENERATE) return;
      if (!h.keys.length) {
        questions.push(h.q);
        return;
      }
      /* Find a matching column */
      var matchedCol = null;
      for (var i = 0; i < colNames.length; i++) {
        if (h.keys.some(function (k) { return colNames[i].includes(k); })) {
          matchedCol = cols[i] ? (cols[i].name || cols[i]) : colNames[i];
          break;
        }
      }
      if (matchedCol) {
        var q = h.q
          .replace('{col}', matchedCol)
          .replace('{dateCol}', matchedCol)
          .replace('{col1}', matchedCol)
          .replace('{col2}', colNames.find(function (c, idx) { return idx > 0 && c !== matchedCol.toLowerCase(); }) || matchedCol);
        questions.push(q);
      }
    });

    /* Fill remaining slots with generic questions if needed */
    var fallbacks = ['What patterns exist in this dataset?', 'Show me summary statistics', 'Which rows need attention?'];
    fallbacks.forEach(function (f) { if (questions.length < 4) questions.push(f); });
    return questions.slice(0, MAX_GENERATE);
  }

  /* ----------------------------------------------------------------
     Gemma3 question generator
     Builds a structured prompt, runs inference, parses numbered list.
  ---------------------------------------------------------------- */
  function gemmaQuestions(role, schemaStr) {
    var roleLabels = { analyst: 'Data Analyst', clinician: 'Clinical Data Analyst', finance: 'Finance Analyst', executive: 'Executive / C-suite', engineer: 'Data Engineer' };
    var roleLabel = roleLabels[role] || 'Data Analyst';
    var prompt = 'You are a data assistant. Generate ' + MAX_GENERATE + ' specific, answerable questions ' +
      'a ' + roleLabel + ' would ask about this dataset. ' +
      'Each question should be actionable in SQL or analytics. ' +
      'Dataset: ' + schemaStr + '. ' +
      'Return ONLY a numbered list. No explanations. Example:\n' +
      '1. What is the total revenue by month?\n2. Which customers have the highest churn risk?';

    return window.GemmaEngine.run(prompt).then(function (response) {
      /* Parse numbered list from response */
      var lines = (response || '').split('\n');
      var questions = [];
      lines.forEach(function (line) {
        var m = line.match(/^\d+[\.\)]\s*(.+)/);
        if (m && m[1].trim().length > 10) {
          questions.push(m[1].trim());
        }
      });
      if (!questions.length) {
        /* Fallback: split by sentence if parsing failed */
        questions = (response || '').split(/[.!?]/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 15 && s.length < 120; }).slice(0, MAX_GENERATE);
      }
      return questions.slice(0, MAX_GENERATE);
    }).catch(function () { return null; });
  }

  /* ----------------------------------------------------------------
     Main generator -- tries Gemma3, falls back to heuristics
  ---------------------------------------------------------------- */
  function generateQuestions(role, schema) {
    if (_generating) return;
    _generating = true;
    _chipOffset = 0;

    var schemaStr = buildSchemaString(schema);

    /* Try Gemma3 first if loaded and schema is available */
    var gemmaPromise = (window.GemmaEngine && window.GemmaEngine.run && schemaStr)
      ? gemmaQuestions(role, schemaStr)
      : Promise.resolve(null);

    gemmaPromise.then(function (gemmaResult) {
      if (gemmaResult && gemmaResult.length >= 3) {
        _generatedQuestions = gemmaResult;
      } else {
        /* Heuristic fallback */
        _generatedQuestions = heuristicQuestions(role, schema);
      }
      _generating = false;
      renderChips();
      document.dispatchEvent(new CustomEvent('dataglow:stakeholder-questions-ready', {
        detail: { role: role, count: _generatedQuestions.length, source: (gemmaResult && gemmaResult.length >= 3) ? 'gemma3' : 'heuristic' }
      }));
    });
  }

  /* ----------------------------------------------------------------
     Chip rendering
  ---------------------------------------------------------------- */
  function renderChips() {
    var container = document.getElementById('dg-stakeholder-chips');
    if (!container) return;

    var visible = _generatedQuestions.slice(_chipOffset, _chipOffset + MAX_CHIPS);
    if (!visible.length) { container.innerHTML = ''; container.style.display = 'none'; return; }

    container.style.display = 'flex';
    var hasMore = _generatedQuestions.length > MAX_CHIPS;

    container.innerHTML =
      '<span class="dg-st-label">For you:</span>' +
      visible.map(function (q, i) {
        return '<button class="dg-st-chip" data-qi="' + (_chipOffset + i) + '"' +
          ' data-testid="chip-stakeholder-' + (_chipOffset + i) + '"' +
          ' title="' + q.replace(/"/g, '&quot;') + '">' +
          _truncateQ(q) +
          '</button>';
      }).join('') +
      (hasMore ? '<button class="dg-st-next" data-testid="button-stakeholder-next" title="More questions">Next</button>' : '');

    /* Chip click -- fill NL bar */
    container.querySelectorAll('.dg-st-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById('nl-query-input');
        if (input) {
          input.value = _generatedQuestions[parseInt(btn.getAttribute('data-qi'), 10)] || '';
          input.focus();
          /* Subtle highlight to confirm selection */
          btn.classList.add('dg-st-chip-used');
          setTimeout(function () { btn.classList.remove('dg-st-chip-used'); }, 1200);
        }
      });
    });

    /* Next button -- cycle through questions */
    var nextBtn = container.querySelector('.dg-st-next');
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        _chipOffset = (_chipOffset + MAX_CHIPS) % _generatedQuestions.length;
        if (_chipOffset + MAX_CHIPS > _generatedQuestions.length) {
          _chipOffset = Math.max(0, _generatedQuestions.length - MAX_CHIPS);
        }
        renderChips();
      });
    }
  }

  function _truncateQ(q) {
    return q.length > 52 ? q.slice(0, 50) + '...' : q;
  }

  /* ----------------------------------------------------------------
     Chip container injection
  ---------------------------------------------------------------- */
  function injectChipBar() {
    if (document.getElementById('dg-stakeholder-chips')) return;
    var bar = document.createElement('div');
    bar.id = 'dg-stakeholder-chips';
    bar.className = 'dg-st-chips';
    bar.setAttribute('data-flag-tier', '1');
    bar.style.display = 'none';
    /* Insert above the KPI chips (which are above agent-bar) */
    var kpiChips = document.getElementById('dg-kpi-chips');
    var agentBar = document.getElementById('agent-bar');
    var anchor   = kpiChips || agentBar;
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(bar, anchor);
    }
  }

  /* ----------------------------------------------------------------
     Event wiring
  ---------------------------------------------------------------- */
  function wireEvents() {
    /* Dataset loaded -- generate questions */
    document.addEventListener('dataglow:dataset-loaded', function (e) {
      _schema = (e.detail && e.detail.schema) || _inferSchemaFromDOM();
      _currentRole = (window.RoleContext && window.RoleContext.current()) || 'analyst';
      generateQuestions(_currentRole, _schema);
    });

    /* Role changed -- regenerate */
    document.addEventListener('dataglow:role-changed', function (e) {
      _currentRole = (e.detail && e.detail.role) || _currentRole;
      generateQuestions(_currentRole, _schema);
    });

    /* Pulse score updated -- after tier-1 unlocks, ensure chips visible */
    document.addEventListener('dataglow:pulse-scored', function () {
      if (_generatedQuestions.length) renderChips();
    });
  }

  /* ----------------------------------------------------------------
     Schema inference from DOM (fallback if event has no schema detail)
  ---------------------------------------------------------------- */
  function _inferSchemaFromDOM() {
    /* Try to read column headers from the active grid */
    var headers = document.querySelectorAll('.dg-grid-header, .ag-header-cell-label, th[data-col]');
    if (!headers.length) return null;
    var cols = [];
    headers.forEach(function (h) {
      var name = h.textContent.trim();
      if (name && name.length < 60) cols.push({ name: name, type: 'STR' });
    });
    return cols.length ? { columns: cols, rowCount: '?' } : null;
  }

  /* ----------------------------------------------------------------
     Public API -- also allows Question Prompter to hand questions to us
  ---------------------------------------------------------------- */
  function getGeneratedQuestions() { return _generatedQuestions.slice(); }
  function refreshForRole(role, schema) {
    _currentRole = role || _currentRole;
    if (schema) _schema = schema;
    generateQuestions(_currentRole, _schema);
  }

  /* ----------------------------------------------------------------
     Init
  ---------------------------------------------------------------- */
  function init() {
    if (!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG])) return;
    injectChipBar();
    wireEvents();
    window.StakeholderTemplates = {
      getQuestions:  getGeneratedQuestions,
      refresh:       refreshForRole,
      renderChips:   renderChips
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/semantic/stakeholder-templates.js ---- */
