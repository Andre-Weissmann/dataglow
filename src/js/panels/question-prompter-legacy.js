/* DataGlow — js/panels/question-prompter-legacy.js */
/* Part of structured refactor — see src/ directory */

(function () {
  'use strict';

  var AUTO_DELAY_MS = 800;

  function $(id) { return document.getElementById(id); }

  function isNullish(v) {
    return v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '');
  }

  function colIndexByName(ds, name) {
    for (var i = 0; i < ds.columns.length; i++) {
      if (ds.columns[i].name === name) return i;
    }
    return -1;
  }

  function colsByType(ds, types) {
    return ds.columns.filter(function (c) { return types.indexOf(c.type) !== -1; });
  }

  function nameMatches(name, re) {
    return re.test(String(name).toLowerCase());
  }

  function findCol(ds, re, types) {
    for (var i = 0; i < ds.columns.length; i++) {
      var c = ds.columns[i];
      if (types && types.indexOf(c.type) === -1) continue;
      if (nameMatches(c.name, re)) return c;
    }
    return null;
  }

  function getTableName(ds) {
    if (window.SQLEngine && typeof window.SQLEngine.safeTableName === 'function') {
      return window.SQLEngine.safeTableName(ds.name || 'dataset');
    }
    return (ds.name || 'dataset').replace(/[^a-zA-Z0-9_]/g, '_');
  }

  function nullCountsByColumn(ds) {
    var counts = {};
    ds.columns.forEach(function (c) { counts[c.name] = 0; });
    var sampleRows = ds.rows.slice(0, 2000);
    sampleRows.forEach(function (row) {
      ds.columns.forEach(function (c, i) {
        if (isNullish(row[i])) counts[c.name] = (counts[c.name] || 0) + 1;
      });
    });
    return counts;
  }

  function mostNumericCol(ds, numCols) {
    if (!numCols.length) return null;
    var best = numCols[0];
    var bestVariance = -1;
    numCols.forEach(function (c) {
      var idx = colIndexByName(ds, c.name);
      var vals = ds.rows.slice(0, 500).map(function (r) { return Number(r[idx]); }).filter(function (v) { return !isNaN(v); });
      if (!vals.length) return;
      var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      var variance = vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / vals.length;
      if (variance > bestVariance) { bestVariance = variance; best = c; }
    });
    return best;
  }

  function generateQuestions(ds) {
    var questions = [];
    if (!ds || !ds.columns || !ds.columns.length) return questions;

    var cols = ds.columns;
    var tbl = getTableName(ds);
    var rowCount = ds.rows ? ds.rows.length : 0;
    var allNames = cols.map(function (c) { return c.name.toLowerCase(); }).join(' ');

    var dateCols = colsByType(ds, ['DATE']);
    var numCols = colsByType(ds, ['INT', 'FLOAT']);
    var strCols = colsByType(ds, ['STR']);

    var amountCol = findCol(ds, /amount|revenue|cost|payment|price|charge|total|spend|sale/, ['INT', 'FLOAT']);
    var categoryCol = strCols.length ? strCols[0] : null;

    var nullCounts = nullCountsByColumn(ds);
    var hasNulls = Object.keys(nullCounts).some(function (k) { return nullCounts[k] > 0; });
    var worstNullCol = null;
    var worstNullCount = 0;
    Object.keys(nullCounts).forEach(function (k) {
      if (nullCounts[k] > worstNullCount) { worstNullCount = nullCounts[k]; worstNullCol = k; }
    });

    var isHealth = /claim|diagnosis|patient|icd|provider|admit|discharge|procedure|cpt|drg|npi|member|rx|readmission|facility/.test(allNames);
    var isFinance = /revenue|amount|cost|price|sale|profit|margin|spend|budget|invoice|payment|charge|transaction/.test(allNames);
    var isHR = /employee|salary|department|hire|tenure|headcount|role|position|manager|satisfaction|turnover/.test(allNames);

    // ---- DATE-driven questions ----
    if (dateCols.length) {
      var measureCol = amountCol || numCols[0];
      if (measureCol) {
        questions.push({
          text: 'How does ' + measureCol.name + ' change over time?',
          context: 'Trend lines reveal seasonality, growth, or decline that raw tables hide.',
          category: 'Trend',
          tool: 'Charts',
          sql: null
        });
      }
      questions.push({
        text: 'What time period does this dataset cover and are there gaps?',
        category: 'Quality',
        context: 'Coverage gaps can silently bias any trend or comparison you run later.',
        tool: 'SQL',
        sql: 'SELECT MIN(' + q(dateCols[0].name) + ') AS earliest, MAX(' + q(dateCols[0].name) + ') AS latest, COUNT(DISTINCT ' + q(dateCols[0].name) + ') AS distinct_dates FROM ' + q(tbl)
      });
    }

    // ---- Amount/revenue/cost driven questions ----
    if (amountCol) {
      if (categoryCol) {
        questions.push({
          text: 'Which ' + categoryCol.name + ' drives the most ' + amountCol.name + '?',
          context: 'Identifies the biggest concentration of value, a key input for prioritization and CFO reporting.',
          category: 'Distribution',
          tool: 'SQL',
          sql: 'SELECT ' + q(categoryCol.name) + ', SUM(' + q(amountCol.name) + ') AS total_' + safeIdent(amountCol.name) + ' FROM ' + q(tbl) + ' GROUP BY ' + q(categoryCol.name) + ' ORDER BY total_' + safeIdent(amountCol.name) + ' DESC LIMIT 20'
        });
      }
      questions.push({
        text: 'Are there outlier transactions that skew the averages?',
        context: 'A handful of extreme values can distort means and mislead decisions based on averages.',
        category: 'Outlier',
        tool: 'Stats',
        sql: null
      });
    }

    // ---- Numeric column questions ----
    if (numCols.length) {
      var bestNumCol = mostNumericCol(ds, numCols);
      questions.push({
        text: 'What is the distribution of ' + bestNumCol.name + '? Are there outliers?',
        context: 'Understanding the shape of the data (skew, spread, extremes) is the foundation for every downstream analysis.',
        category: 'Distribution',
        tool: 'Charts',
        sql: null
      });
      if (numCols.length > 1) {
        questions.push({
          text: 'Which columns correlate with ' + bestNumCol.name + '?',
          context: 'Correlated variables often point to drivers worth investigating or controlling for.',
          category: 'Correlation',
          tool: 'Stats',
          sql: null
        });
      }
    }

    // ---- STR columns quality ----
    if (strCols.length >= 2) {
      var strTarget = categoryCol || strCols[0];
      questions.push({
        text: 'What are the most common values in ' + strTarget.name + ' and are there data entry inconsistencies?',
        context: 'Inconsistent labels (casing, typos, duplicates) quietly break every GROUP BY you run.',
        category: 'Quality',
        tool: 'SQL',
        sql: 'SELECT ' + q(strTarget.name) + ', COUNT(*) AS n FROM ' + q(tbl) + ' GROUP BY ' + q(strTarget.name) + ' ORDER BY n DESC LIMIT 25'
      });
    }

    // ---- NULL detection ----
    if (hasNulls && worstNullCol) {
      questions.push({
        text: 'Which columns have the most missing data and does the absence follow a pattern?',
        context: 'Missing data is rarely random. Patterns in nulls can reveal broken pipelines or biased samples.',
        category: 'Quality',
        tool: 'SQL',
        sql: 'SELECT ' + q(worstNullCol) + ', COUNT(*) AS n FROM ' + q(tbl) + ' WHERE ' + q(worstNullCol) + ' IS NULL GROUP BY ' + q(worstNullCol) + ' LIMIT 25'
      });
    }

    // ---- Segmentation for large datasets ----
    if (rowCount > 1000) {
      questions.push({
        text: 'Can this data be segmented into meaningful cohorts?',
        context: 'With over ' + rowCount.toLocaleString() + ' rows, aggregate stats hide meaningful subgroup differences.',
        category: 'Comparison',
        tool: 'SQL',
        sql: 'SELECT ' + (categoryCol ? q(categoryCol.name) : '*') + ', COUNT(*) AS n' + (amountCol ? (', AVG(' + q(amountCol.name) + ') AS avg_' + safeIdent(amountCol.name)) : '') + ' FROM ' + q(tbl) + (categoryCol ? (' GROUP BY ' + q(categoryCol.name) + ' ORDER BY n DESC') : '') + ' LIMIT 20'
      });
    }

    // ---- Healthcare-specific ----
    if (isHealth) {
      var dxCol = findCol(ds, /diag|icd|dx/, null);
      var costCol = amountCol || findCol(ds, /cost|charge|payment/, ['INT', 'FLOAT']);
      var losCol = findCol(ds, /length.?of.?stay|los/, ['INT', 'FLOAT']);
      if (dxCol && costCol) {
        questions.push({
          text: 'Which diagnosis codes have the highest average cost and length of stay?',
          context: 'Pinpoints the clinical categories driving spend, the starting point for cost containment.',
          category: 'Distribution',
          tool: 'SQL',
          sql: 'SELECT ' + q(dxCol.name) + ', AVG(' + q(costCol.name) + ') AS avg_cost' + (losCol ? (', AVG(' + q(losCol.name) + ') AS avg_los') : '') + ', COUNT(*) AS n FROM ' + q(tbl) + ' GROUP BY ' + q(dxCol.name) + ' ORDER BY avg_cost DESC LIMIT 20'
        });
      }
      var readmitCol = findCol(ds, /readmit/, null);
      var patientCol = findCol(ds, /patient|member/, null);
      if (readmitCol || patientCol) {
        questions.push({
          text: 'Are there patients with unusually high readmission rates?',
          context: 'High readmission concentrations often flag quality-of-care issues or fraud patterns.',
          category: 'Outlier',
          tool: 'SQL',
          sql: patientCol ? ('SELECT ' + q(patientCol.name) + ', COUNT(*) AS visit_count FROM ' + q(tbl) + ' GROUP BY ' + q(patientCol.name) + ' ORDER BY visit_count DESC LIMIT 20') : ('SELECT * FROM ' + q(tbl) + ' LIMIT 20')
        });
      }
      var facilityCol = findCol(ds, /facility|hospital|provider/, null);
      var stateCol = findCol(ds, /state|region/, null);
      if ((facilityCol || stateCol) && costCol) {
        var geoCol = facilityCol || stateCol;
        questions.push({
          text: 'Do payment amounts vary significantly by facility or state?',
          context: 'Geographic or facility level variation can reveal pricing discrepancies or access disparities.',
          category: 'Comparison',
          tool: 'SQL',
          sql: 'SELECT ' + q(geoCol.name) + ', AVG(' + q(costCol.name) + ') AS avg_payment, COUNT(*) AS n FROM ' + q(tbl) + ' GROUP BY ' + q(geoCol.name) + ' ORDER BY avg_payment DESC LIMIT 20'
        });
      }
    }

    // ---- Finance-specific ----
    if (isFinance && amountCol) {
      if (categoryCol) {
        questions.push({
          text: 'Which categories contribute 80% of total revenue (Pareto analysis)?',
          context: 'Pareto analysis shows where to focus attention; usually a small share of categories drives most value.',
          category: 'Distribution',
          tool: 'SQL',
          sql: 'SELECT ' + q(categoryCol.name) + ', SUM(' + q(amountCol.name) + ') AS total FROM ' + q(tbl) + ' GROUP BY ' + q(categoryCol.name) + ' ORDER BY total DESC LIMIT 20'
        });
      }
      var dtCol = dateCols.length ? dateCols[0] : null;
      if (dtCol) {
        questions.push({
          text: 'Are there suspicious transaction patterns by time of day or day of week?',
          context: 'Unusual timing clusters can signal fraud, automation abuse, or operational anomalies.',
          category: 'Outlier',
          tool: 'SQL',
          sql: 'SELECT ' + q(dtCol.name) + ', COUNT(*) AS n, SUM(' + q(amountCol.name) + ') AS total FROM ' + q(tbl) + ' GROUP BY ' + q(dtCol.name) + ' ORDER BY n DESC LIMIT 20'
        });
      }
    }

    // ---- HR-specific ----
    if (isHR) {
      var deptCol = findCol(ds, /dept|department|team/, null);
      var tenureCol = findCol(ds, /tenure|years|hire/, ['INT', 'FLOAT']);
      var satCol = findCol(ds, /satisfaction|engagement|review|score/, ['INT', 'FLOAT']);
      if (deptCol && (tenureCol || satCol)) {
        var riskCol = tenureCol || satCol;
        questions.push({
          text: 'Which departments have the highest turnover risk based on tenure and satisfaction?',
          context: 'Combining tenure and satisfaction signals surfaces flight risk before attrition happens.',
          category: 'Comparison',
          tool: 'SQL',
          sql: 'SELECT ' + q(deptCol.name) + ', AVG(' + q(riskCol.name) + ') AS avg_' + safeIdent(riskCol.name) + ', COUNT(*) AS n FROM ' + q(tbl) + ' GROUP BY ' + q(deptCol.name) + ' ORDER BY avg_' + safeIdent(riskCol.name) + ' ASC LIMIT 20'
        });
      }
    }

    // ---- General reflection questions (always include) ----
    questions.push({
      text: 'What does a typical record look like and what makes a record unusual?',
      context: 'Establishing the baseline record helps you recognize anomalies faster everywhere else.',
      category: 'Distribution',
      tool: 'Stats',
      sql: null
    });
    questions.push({
      text: 'What business decision could this data inform today?',
      context: 'The most valuable analyses start by tying the data back to a real decision someone needs to make.',
      category: 'Comparison',
      tool: null,
      sql: null
    });

    // Deduplicate by text, cap to 8-12
    var seen = {};
    var deduped = [];
    questions.forEach(function (qq) {
      if (!seen[qq.text]) { seen[qq.text] = true; deduped.push(qq); }
    });

    if (deduped.length < 8) {
      var fillers = [
        { text: 'How many total records and columns does this dataset have?', context: 'A quick shape check anchors every other question you ask.', category: 'Distribution', tool: 'SQL', sql: 'SELECT COUNT(*) AS row_count FROM ' + q(tbl) },
        { text: 'Are there duplicate records that should be deduplicated?', context: 'Duplicates silently inflate counts and sums across every downstream report.', category: 'Quality', tool: 'SQL', sql: 'SELECT *, COUNT(*) AS dup_count FROM ' + q(tbl) + ' GROUP BY ' + cols.map(function (c) { return q(c.name); }).join(', ') + ' HAVING COUNT(*) > 1 LIMIT 20' },
        { text: 'What are the min and max values across the key numeric fields?', context: 'Range checks catch obviously bad data (negative ages, impossible dates) early.', category: 'Distribution', tool: 'SQL', sql: 'SELECT * FROM ' + q(tbl) + ' LIMIT 10' }
      ];
      fillers.forEach(function (f) {
        if (deduped.length >= 8 && deduped.length >= 12) return;
        if (!seen[f.text]) { seen[f.text] = true; deduped.push(f); }
      });
    }

    if (deduped.length > 12) deduped = deduped.slice(0, 12);

    return deduped;
  }

  function q(name) {
    return '"' + String(name).replace(/"/g, '') + '"';
  }

  function safeIdent(name) {
    return String(name).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  }

  function catClass(category) {
    var map = {
      'Distribution': 'cat-distribution',
      'Trend': 'cat-trend',
      'Quality': 'cat-quality',
      'Outlier': 'cat-outlier',
      'Comparison': 'cat-comparison',
      'Correlation': 'cat-correlation'
    };
    return map[category] || 'cat-distribution';
  }

  function renderDrawer(questions, ds) {
    var list = $('qd-list');
    var subtitle = $('qd-subtitle');
    if (!list) return;

    var rowCount = ds && ds.rows ? ds.rows.length : 0;
    var colCount = ds && ds.columns ? ds.columns.length : 0;
    var dsName = ds ? (ds.name || 'dataset') : 'dataset';

    var titleEl = document.querySelector('#questions-drawer .qd-title');
    if (titleEl) titleEl.textContent = questions.length + ' Questions Worth Asking';

    if (subtitle) {
      subtitle.textContent = dsName + '  -  ' + rowCount.toLocaleString() + ' rows, ' + colCount + ' columns';
    }

    if (!questions.length) {
      list.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-muted);font-size:13px;">Load a dataset to generate analytical questions tailored to your data.</div>';
      return;
    }

    list.innerHTML = '';
    questions.forEach(function (qq, idx) {
      var card = document.createElement('div');
      card.className = 'qd-card';

      var tags = document.createElement('div');
      tags.className = 'qd-tags';

      var catTag = document.createElement('span');
      catTag.className = 'qd-tag ' + catClass(qq.category);
      catTag.textContent = qq.category;
      tags.appendChild(catTag);

      if (qq.tool) {
        var toolTag = document.createElement('span');
        toolTag.className = 'qd-tag tool';
        toolTag.textContent = qq.tool;
        tags.appendChild(toolTag);
      }

      var qText = document.createElement('div');
      qText.className = 'qd-question';
      qText.textContent = qq.text;

      var ctx = document.createElement('div');
      ctx.className = 'qd-context';
      ctx.textContent = qq.context;

      card.appendChild(tags);
      card.appendChild(qText);
      card.appendChild(ctx);

      if (qq.tool) {
        var askBtn = document.createElement('button');
        askBtn.className = 'qd-ask-btn';
        askBtn.textContent = 'Ask This';
        askBtn.addEventListener('click', function () {
          askQuestion(qq, ds);
        });
        card.appendChild(askBtn);
      }

      list.appendChild(card);
    });
  }

  function switchToPanel(panelId) {
    var navBtns = document.querySelectorAll('.nav-btn');
    navBtns.forEach(function (b) { b.classList.remove('active'); });
    var analyzeBtn = document.querySelector('.nav-btn[data-view="analyze"]');
    if (analyzeBtn) analyzeBtn.classList.add('active');

    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.add('hidden'); v.classList.remove('active');
    });
    var analyzeView = $('analyze-view');
    if (analyzeView) { analyzeView.classList.remove('hidden'); analyzeView.classList.add('active'); }

    var pill = document.querySelector('.analyze-pill[data-panel="' + panelId + '"]');
    if (pill) {
      pill.click();
    } else {
      document.querySelectorAll('.analyze-panel').forEach(function (p) {
        p.classList.remove('active'); p.classList.add('hidden');
      });
      var panel = $(panelId);
      if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }
    }
  }

  function askQuestion(qq, ds) {
    if (qq.tool === 'SQL') {
      switchToPanel('sql-view');
      if (qq.sql) {
        setTimeout(function () {
          var input = $('sql-view-input');
          if (input) input.value = qq.sql;
        }, 60);
      }
    } else if (qq.tool === 'Stats') {
      switchToPanel('stats-view');
    } else if (qq.tool === 'Charts') {
      switchToPanel('charts-view');
    } else if (qq.tool === 'Python') {
      switchToPanel('python-view');
    }

    hideDrawer();

    if (window.LevelSystem && typeof window.LevelSystem.addXP === 'function') {
      window.LevelSystem.addXP('ask_question', 5);
    }
    if (window.SkillTracker && typeof window.SkillTracker.track === 'function') {
      window.SkillTracker.track('ask_question');
    }
    if (typeof window.showToast === 'function') {
      window.showToast('Loaded: ' + qq.text, 'info');
    }
  }

  function showDrawer(ds) {
    var drawer = $('questions-drawer');
    if (!drawer) return;
    if (ds) {
      var questions = generateQuestions(ds);
      renderDrawer(questions, ds);
    }
    drawer.classList.add('open');
  }

  function hideDrawer() {
    var drawer = $('questions-drawer');
    if (drawer) drawer.classList.remove('open');
  }

  function init() {
    var trigger = $('questions-trigger-btn');
    if (trigger) {
      trigger.addEventListener('click', function () {
        var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
        showDrawer(ds);
      });
    }

    var dismissBtn = $('qd-dismiss-btn');
    if (dismissBtn) dismissBtn.addEventListener('click', hideDrawer);

    document.addEventListener('dataglow:dataset-loaded', function (e) {
      if (e.detail && e.detail.fromProjectRestore) return;
      var ds = e.detail && (e.detail.dataset || e.detail);
      setTimeout(function () {
        showDrawer(ds);
      }, AUTO_DELAY_MS);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.QuestionPrompter = {
    show: showDrawer,
    hide: hideDrawer,
    generate: generateQuestions
  };
