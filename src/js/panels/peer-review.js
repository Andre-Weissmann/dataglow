/* DataGlow — src/js/panels/peer-review.js */
/* Refactored from canvas/index.html */

(function() {
  'use strict';

  var SQL_CHECKS = [
    {id:'select_star', fn: function(sql) {
      if (/SELECT\s+\*/i.test(sql)) return {severity:'warning', msg:'Avoid SELECT star. Explicitly name the columns you need for clarity and performance.'};
      return null;
    }},
    {id:'no_limit', fn: function(sql) {
      if (!/\bLIMIT\b/i.test(sql) && /\bSELECT\b/i.test(sql)) return {severity:'info', msg:'No LIMIT clause. This query could return all rows. Add LIMIT for exploration.'};
      return null;
    }},
    {id:'cartesian_join', fn: function(sql) {
      if (/\bJOIN\b/i.test(sql) && !/\bON\b/i.test(sql) && !/\bUSING\b/i.test(sql)) return {severity:'error', msg:'JOIN without ON clause detected. This may be a Cartesian product, every row matched with every other row.'};
      return null;
    }},
    {id:'division_no_nullif', fn: function(sql) {
      if (/\/\s*(?!NULLIF)[a-z0-9_]+/i.test(sql) && /\//.test(sql)) return {severity:'warning', msg:'Division detected without NULLIF protection. A zero denominator will cause a runtime error. Wrap the divisor: NULLIF(col, 0).'};
      return null;
    }},
    {id:'order_by_number', fn: function(sql) {
      if (/ORDER\s+BY\s+\d+/i.test(sql)) return {severity:'info', msg:'ORDER BY column number is fragile. If the SELECT list changes, sorting breaks silently. Use the column name.'};
      return null;
    }},
    {id:'having_only', fn: function(sql) {
      if (/\bHAVING\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) return {severity:'info', msg:'HAVING filters after aggregation. If you can filter rows first with WHERE, your query will run faster.'};
      return null;
    }},
    {id:'non_sargable', fn: function(sql) {
      if (/WHERE.*?(LOWER|UPPER|TRIM)\s*\(/i.test(sql)) return {severity:'warning', msg:'Function in WHERE clause (LOWER, UPPER, or TRIM) prevents index use in indexed systems. Consider storing normalized values.'};
      return null;
    }},
    {id:'deep_nesting', fn: function(sql) {
      var depth = 0; var max = 0;
      for (var i=0; i<sql.length; i++) { if(sql[i]==='(') { depth++; max=Math.max(max,depth); } else if(sql[i]===')') depth--; }
      if (max >= 3) return {severity:'info', msg:'Deep subquery nesting (depth ' + max + '). Consider refactoring with WITH (CTE) clauses for readability.'};
      return null;
    }},
    {id:'count_star', fn: function(sql) {
      if (/COUNT\s*\(\s*\*\s*\)/i.test(sql)) return {severity:'info', msg:'COUNT(*) counts all rows including NULLs. If NULL rows should be excluded, use COUNT(column_name) instead.'};
      return null;
    }},
    {id:'in_many', fn: function(sql) {
      var m = sql.match(/\bIN\s*\(([^)]+)\)/gi);
      if (m) {
        for (var i=0;i<m.length;i++) {
          var vals = m[i].split(',').length;
          if (vals > 10) return {severity:'info', msg:'IN clause with ' + vals + ' values. Consider loading these into a temp table or using a JOIN for maintainability.'};
        }
      }
      return null;
    }},
    {id:'string_date_compare', fn: function(sql) {
      if (/WHERE.*[a-z_]+(date|dt|time)[a-z_]*\s*=\s*'[0-9]{4}-/i.test(sql)) return {severity:'info', msg:'Comparing a date column to a string literal. An explicit CAST is safer: WHERE date_col = CAST(2024-01-01 AS DATE).'};
      return null;
    }},
    {id:'no_alias_join', fn: function(sql) {
      if (/\bJOIN\b/i.test(sql) && !/\b(AS\s+[a-z]|[a-z]\s+ON\b)/i.test(sql)) return {severity:'info', msg:'JOIN without table aliases. Using aliases (t1, t2, or descriptive names) makes queries easier to read.'};
      return null;
    }},
    {id:'implicit_cast', fn: function(sql) {
      if (/WHERE\s+\w+\s*=\s*\d+/i.test(sql)) return {severity:'info', msg:'Comparing a column to an unquoted number. If the column is VARCHAR, this triggers implicit casting and may miss values.'};
      return null;
    }},
    {id:'missing_group_col', fn: function(sql) {
      if (/\b(SUM|AVG|MAX|MIN|COUNT)\s*\(/i.test(sql) && !/\bGROUP\s+BY\b/i.test(sql) && !/\bOVER\s*\(/i.test(sql)) return {severity:'warning', msg:'Aggregate function without GROUP BY or OVER(). This will collapse all rows into one. Is that intended?'};
      return null;
    }},
    {id:'cte_suggestion', fn: function(sql) {
      var subCount = (sql.match(/SELECT\b/gi) || []).length;
      if (subCount >= 3 && !/\bWITH\b/i.test(sql)) return {severity:'info', msg:'Multiple SELECT statements (' + subCount + '). Consider restructuring with WITH (CTE) clauses for clarity.'};
      return null;
    }}
  ];

  var PYTHON_CHECKS = [
    {fn: function(code) { if (/['"][A-Z]:[\\\/]/.test(code) || /['"]\/home\//.test(code) || /['"]\/Users\//.test(code)) return {severity:'warning', msg:'Hardcoded file path detected. Use variables or config files for portability.'}; return null; }},
    {fn: function(code) { if (/\.iterrows\(\)/.test(code)) return {severity:'warning', msg:'iterrows() is slow on large DataFrames. Use vectorized operations or apply() for better performance.'}; return null; }},
    {fn: function(code) { if (/\bprint\s*\(/.test(code)) return {severity:'info', msg:'Debug print() statements found. Remove them before finalizing your analysis.'}; return null; }},
    {fn: function(code) { if (/\.ix\[/.test(code) || /\.as_matrix\(\)/.test(code)) return {severity:'error', msg:'Deprecated pandas API detected (.ix or .as_matrix). Use .iloc, .loc, and .to_numpy() instead.'}; return null; }},
    {fn: function(code) { if (!/"""[\s\S]*?"""|#/.test(code)) return {severity:'info', msg:'No docstring or comments found. Add a brief comment explaining what this script analyzes.'}; return null; }},
    {fn: function(code) { if (!/\btry\b/.test(code) && (/read_csv|read_sql|read_excel|to_csv|open\s*\(/.test(code))) return {severity:'warning', msg:'No error handling found around data loading or file operations. Wrap risky operations in a try/except block.'}; return null; }}
  ];

  var PRAISE_POOL = [
    'Clean aggregate query, well-structured GROUP BY logic.',
    'Proper use of ROUND() on numeric output, reader-friendly results.',
    'Good use of aliases, makes the output easy to interpret.',
    'Effective use of HAVING for post-aggregation filtering.',
    'CTE usage shows strong SQL structuring instincts.',
    'Appropriate LIMIT for exploratory query, good habit.',
    'NULLIF used for safe division, defensive coding.',
    'Window function usage shows advanced SQL command.',
    'CASE WHEN logic is clean and readable.',
    'Good column naming in the SELECT list.'
  ];

  function runSQLChecks(sql) {
    var issues = [];
    SQL_CHECKS.forEach(function(chk) {
      var r = chk.fn(sql);
      if (r) issues.push(Object.assign({cat:'SQL'}, r));
    });
    var errors = issues.filter(function(i){ return i.severity==='error'; }).length;
    var warnings = issues.filter(function(i){ return i.severity==='warning'; }).length;
    if (errors === 0 && warnings <= 1 && sql.trim().length > 10) {
      var praise = PRAISE_POOL[Math.floor(Math.random() * PRAISE_POOL.length)];
      issues.push({cat:'SQL', severity:'praise', msg: praise});
    }
    return issues;
  }

  function runDataChecks(ds) {
    var issues = [];
    if (!ds || !ds.columns || !ds.rows) return issues;
    var cols = ds.columns; var rows = ds.rows; var n = rows.length;
    if (n === 0) return issues;
    cols.forEach(function(col, ci) {
      var vals = rows.map(function(r){ return r[ci]; });
      var nullCount = vals.filter(function(v){ return v === null || v === undefined || v === ''; }).length;
      if (nullCount / n > 0.3) issues.push({cat:'Data', severity:'warning', msg: col.name + ' is ' + Math.round(nullCount/n*100) + '% null. Investigate before analysis.'});

      if ((col.name.toLowerCase().indexOf('amount') >= 0 || col.name.toLowerCase().indexOf('price') >= 0 || col.name.toLowerCase().indexOf('pmt') >= 0) && (col.type === 'INT' || col.type === 'FLOAT')) {
        var negs = vals.filter(function(v){ return parseFloat(v) < 0; }).length;
        if (negs > 0) issues.push({cat:'Data', severity:'warning', msg: col.name + ' has ' + negs + ' negative value(s). Verify these are valid (credits or refunds) versus data errors.'});
      }

      if ((col.type === 'INT' || col.type === 'FLOAT') && n > 20) {
        var uniq = new Set(vals.filter(function(v){ return v !== null && v !== undefined; }).map(String)).size;
        if (uniq <= 2) issues.push({cat:'Data', severity:'info', msg: col.name + ' has only ' + uniq + ' distinct value(s). May be a boolean flag stored as a number.'});
      }

      if (col.type === 'STR') {
        var caps = vals.filter(function(v){ return typeof v === 'string' && v === v.toUpperCase() && v.length > 2 && /[A-Z]/.test(v); }).length;
        if (caps / n > 0.8) issues.push({cat:'Data', severity:'info', msg: col.name + ' values are predominantly uppercase. May indicate a legacy system export or data entry inconsistency.'});
      }

      if (col.type === 'DATE') {
        var today = new Date();
        var future = vals.filter(function(v){ var d = new Date(v); return !isNaN(d.getTime()) && d.getTime() > today.getTime(); }).length;
        if (future > 0) issues.push({cat:'Data', severity:'warning', msg: col.name + ' has ' + future + ' date(s) in the future. Verify these are not data entry errors.'});
      }

      if (col.type === 'INT' || col.type === 'FLOAT') {
        var nums = vals.map(function(v){ return parseFloat(v); }).filter(function(v){ return !isNaN(v); });
        if (nums.length > 10) {
          var mean = nums.reduce(function(a,b){ return a+b; }, 0) / nums.length;
          var variance = nums.reduce(function(a,b){ return a + Math.pow(b-mean,2); }, 0) / nums.length;
          var stddev = Math.sqrt(variance);
          if (stddev > 0) {
            var outliers = nums.filter(function(v){ return Math.abs(v-mean) > 3*stddev; }).length;
            if (outliers > 0) issues.push({cat:'Data', severity:'info', msg: col.name + ' has ' + outliers + ' value(s) beyond 3 standard deviations from the mean. Review for outliers.'});
          }
        }
      }
    });

    if (n > 10) {
      var keySet = new Set(rows.map(function(r){ return r.slice(0,5).join('|'); }));
      if (keySet.size < n * 0.95) issues.push({cat:'Data', severity:'warning', msg: 'Potential duplicate rows detected (' + (n - keySet.size) + ' duplicates by first 5 columns). Run a dedup check before analysis.'});
    }
    return issues;
  }

  function runPythonChecks(code) {
    var issues = [];
    PYTHON_CHECKS.forEach(function(chk) {
      var r = chk.fn(code);
      if (r) issues.push(Object.assign({cat:'Python'}, r));
    });
    var errors = issues.filter(function(i){ return i.severity==='error'; }).length;
    var warnings = issues.filter(function(i){ return i.severity==='warning'; }).length;
    if (errors === 0 && warnings === 0 && code.trim().length > 10) {
      issues.push({cat:'Python', severity:'praise', msg:'No debug prints, no deprecated APIs, and clean structure. Solid analysis script.'});
    }
    return issues;
  }

  function computeGrade(issues) {
    var errors = issues.filter(function(i){ return i.severity==='error'; }).length;
    var warnings = issues.filter(function(i){ return i.severity==='warning'; }).length;
    var score = 100 - (errors * 25) - (warnings * 10);
    score = Math.max(0, score);
    var grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
    return {score: score, grade: grade, errors: errors, warnings: warnings};
  }

  function subScore(issues) {
    if (issues.length === 0) return null;
    var errors = issues.filter(function(i){ return i.severity==='error'; }).length;
    var warnings = issues.filter(function(i){ return i.severity==='warning'; }).length;
    var score = 100 - (errors * 25) - (warnings * 10);
    return Math.max(0, score);
  }

  function renderReview() {
    var feedEl = document.getElementById('review-feed');
    var gradeEl = document.getElementById('review-grade-big');
    var gradeLabelEl = document.getElementById('review-grade-label');
    var errCountEl = document.getElementById('review-err-count');
    var warnCountEl = document.getElementById('review-warn-count');
    var infoCountEl = document.getElementById('review-info-count');
    var praiseCountEl = document.getElementById('review-praise-count');
    var sqlScoreEl = document.getElementById('review-sql-score');
    var dataScoreEl = document.getElementById('review-data-score');
    var pyScoreEl = document.getElementById('review-py-score');
    if (!feedEl) return;

    var sqlIssues = [];
    var dataIssues = [];
    var pyIssues = [];

    var sqlInput = document.getElementById('sql-view-input');
    if (sqlInput && sqlInput.value.trim()) {
      sqlIssues = runSQLChecks(sqlInput.value);
    }
    var ds = window.getActiveDataset && window.getActiveDataset();
    if (ds) dataIssues = runDataChecks(ds);
    var pyInput = document.getElementById('py-view-input') || document.getElementById('py-editor') || document.getElementById('python-editor') || document.querySelector('.py-editor textarea');
    if (pyInput && pyInput.value && pyInput.value.trim().length > 0) {
      pyIssues = runPythonChecks(pyInput.value);
    }

    var issues = sqlIssues.concat(dataIssues, pyIssues);

    if (sqlScoreEl) { var ss = subScore(sqlIssues); sqlScoreEl.textContent = ss === null ? '-' : ss; }
    if (dataScoreEl) { var ds2 = subScore(dataIssues); dataScoreEl.textContent = ds2 === null ? '-' : ds2; }
    if (pyScoreEl) { var ps = subScore(pyIssues); pyScoreEl.textContent = ps === null ? '-' : ps; }

    if (issues.length === 0) {
      feedEl.innerHTML = '<div class="review-empty">No issues found. Load a dataset and run a query to get a peer review.</div>';
      if (gradeEl) { gradeEl.textContent = '-'; gradeEl.className = 'review-grade-big'; }
      if (gradeLabelEl) gradeLabelEl.textContent = 'Quality Score';
      if (errCountEl) errCountEl.textContent = '0';
      if (warnCountEl) warnCountEl.textContent = '0';
      if (infoCountEl) infoCountEl.textContent = '0';
      if (praiseCountEl) praiseCountEl.textContent = '0';
      return;
    }

    var SEV_ICON = {error:'&#9940;', warning:'&#9888;', info:'&#8505;', praise:'&#10003;'};
    feedEl.innerHTML = issues.map(function(issue) {
      return '<div class="review-item ' + issue.severity + '">' +
        '<span class="review-sev-icon">' + (SEV_ICON[issue.severity] || '') + '</span>' +
        '<div class="review-body">' +
        '<div class="review-cat">' + issue.cat + ' - ' + issue.severity.toUpperCase() + '</div>' +
        '<div class="review-msg">' + issue.msg + '</div>' +
        '</div></div>';
    }).join('');

    var g = computeGrade(issues);
    if (gradeEl) { gradeEl.textContent = g.grade; gradeEl.className = 'review-grade-big review-grade-' + g.grade; }
    if (gradeLabelEl) gradeLabelEl.textContent = g.score + '/100 Quality Score';
    if (errCountEl) errCountEl.textContent = g.errors;
    if (warnCountEl) warnCountEl.textContent = g.warnings;
    if (infoCountEl) infoCountEl.textContent = issues.filter(function(i){ return i.severity==='info'; }).length;
    if (praiseCountEl) praiseCountEl.textContent = issues.filter(function(i){ return i.severity==='praise'; }).length;

    if (window.SkillTracker && typeof window.SkillTracker.track === 'function') window.SkillTracker.track('peer_review');
  }

  var reviewPill = document.querySelector('[data-panel="review-view"]');
  if (reviewPill) reviewPill.addEventListener('click', function() { setTimeout(renderReview, 50); });

  document.addEventListener('dataglow:dataset-loaded', function() {
    var rv = document.getElementById('review-view');
    if (rv && rv.classList.contains('active')) renderReview();
  });

  var shareBtn = document.getElementById('review-share-btn');
  if (shareBtn) shareBtn.addEventListener('click', function() {
    var feedEl = document.getElementById('review-feed');
    var items = feedEl ? feedEl.querySelectorAll('.review-item') : [];
    var text = 'DataGlow Peer Review\n' + '='.repeat(40) + '\n';
    items.forEach(function(el) {
      var cat = el.querySelector('.review-cat'); var msg = el.querySelector('.review-msg');
      if (cat && msg) text += '[' + cat.textContent + '] ' + msg.textContent + '\n';
    });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        if (window.showToast) window.showToast('Review copied to clipboard', 'success');
      }).catch(function() {
        if (window.showToast) window.showToast('Could not copy review', 'error');
      });
    }
  });

  window.PeerReview = { run: renderReview };

})();

// ---- #49 Take-Home Case ----
(function () {
  var thState = {
    role: 'Data Analyst',
    difficulty: 'Mid-Level',
    timeLimit: '4 hours',
    focus: ['Data Quality', 'Exploratory Analysis', 'Business Insights'],
    hints: true,
    caseData: null
  };

  function th$(id) { return document.getElementById(id); }

  function openTakeHome() {
    var modal = th$('takehome-modal');
    if (!modal) return;
    modal.classList.add('open');
    showThGenScreen();
    window.SkillTracker && window.SkillTracker.track && window.SkillTracker.track('open_takehome_case');
  }

  function closeTakeHome() {
    var modal = th$('takehome-modal');
    if (modal) modal.classList.remove('open');
  }

  function showThGenScreen() {
    var gen = th$('th-gen-screen');
    var prev = th$('th-preview-screen');
    if (gen) gen.style.display = 'flex';
    if (prev) prev.classList.remove('open');
  }

  function showThPreviewScreen() {
    var gen = th$('th-gen-screen');
    var prev = th$('th-preview-screen');
    if (gen) gen.style.display = 'none';
    if (prev) prev.classList.add('open');
  }

  function detectDomain(cols) {
    var names = cols.map(function (c) { return c.name.toLowerCase(); }).join(' ');
    if (/bene|clm|dx|los|icd|drg|facility|medicare|medicaid|patient|admit|disch/.test(names)) return 'healthcare';
    if (/revenue|amount|price|payment|invoice|transaction|cost|profit|margin|sales/.test(names)) return 'finance';
    if (/employee|salary|department|hire|tenure|attrition|headcount|manager|staff/.test(names)) return 'hr';
    return 'general';
  }

  function inferColDescription(name, type) {
    var n = name.toLowerCase();
    if (/^id$|_id$|^id_/.test(n)) return 'Unique identifier field';
    if (/date|time|dt$/.test(n)) return 'Date or timestamp field';
    if (/amount|price|revenue|cost|total|payment/.test(n)) return 'Monetary value field';
    if (/name/.test(n)) return 'Descriptive name or label field';
    if (/status|flag|type|category|code/.test(n)) return 'Categorical classification field';
    if (/count|qty|quantity|num|number/.test(n)) return 'Numeric count or quantity field';
    if (/pct|percent|rate|ratio/.test(n)) return 'Rate or percentage field';
    if (type === 'INT' || type === 'FLOAT') return 'Numeric measure field';
    if (type === 'DATE') return 'Date or timestamp field';
    if (type === 'BOOL') return 'Boolean indicator field';
    return 'Descriptive attribute field';
  }

  function findKeyMetricCol(cols) {
    for (var i = 0; i < cols.length; i++) {
      if (cols[i].type === 'INT' || cols[i].type === 'FLOAT') return cols[i];
    }
    return cols[0];
  }

  function findEntityCol(cols) {
    for (var i = 0; i < cols.length; i++) {
      var n = cols[i].name.toLowerCase();
      if (/name|category|type|region|state|facility|department|product|provider/.test(n) && cols[i].type === 'STR') return cols[i];
    }
    for (var j = 0; j < cols.length; j++) {
      if (cols[j].type === 'STR') return cols[j];
    }
    return cols[0];
  }

  function findDateCol(cols) {
    for (var i = 0; i < cols.length; i++) {
      if (cols[i].type === 'DATE') return cols[i];
    }
    return null;
  }

  function buildBackground(domain, ds) {
    var name = ds.name || 'this dataset';
    if (domain === 'healthcare') {
      return [
        'You have joined the analytics team at a mid-size healthcare organization that is working to improve care quality and control costs across its patient population. Leadership has provided a claims and encounter dataset, "' + name + '", and wants a rigorous, data-driven review before the next budget cycle.',
        'Your task is to independently explore this data, identify quality issues, and surface actionable insights. The analytics team places a high value on clear communication: findings must be understandable to both technical peers and non-technical executives who will use your work to make resourcing decisions.'
      ];
    }
    if (domain === 'finance') {
      return [
        'You have joined the analytics function at a growing fintech company. The finance and strategy team has handed you a transaction and revenue dataset, "' + name + '", ahead of an upcoming board review, and needs a clear read on performance drivers and data integrity risks.',
        'Your task is to independently explore this data, validate its quality, and produce insights that inform pricing, risk, and growth decisions. Strong SQL fluency and the ability to translate numbers into a business narrative are essential for this role.'
      ];
    }
    if (domain === 'hr') {
      return [
        'You have joined the people analytics team at a growing company. HR leadership has shared a workforce dataset, "' + name + '", and is looking for an independent, data-backed perspective on staffing trends, attrition risk, and organizational health.',
        'Your task is to independently explore this data, flag any quality concerns, and deliver insights that could inform headcount planning and retention strategy. As with any people data, precision and clear communication matter as much as the numbers themselves.'
      ];
    }
    return [
      'You have joined the analytics team at a growing organization that relies on data to make key operating decisions. The team has provided a dataset, "' + name + '", and wants an independent, rigorous review of what it contains and what it means for the business.',
      'Your task is to independently explore this data, identify any quality issues, and produce insights that could directly inform decision-making. Clear communication of technical findings to a non-technical audience is a core part of this assessment.'
    ];
  }

  function buildDeliverables(difficulty, focus, ds, domain) {
    var entityCol = findEntityCol(ds.columns);
    var metricCol = findKeyMetricCol(ds.columns);
    var dateCol = findDateCol(ds.columns);
    var entityLabel = entityCol ? entityCol.name : 'records';
    var metricLabel = metricCol ? metricCol.name : 'value';
    var outcomeLabel = metricCol ? metricCol.name : 'the key outcome metric';
    var businessQuestion = 'How does ' + metricLabel + ' vary across ' + entityLabel + (dateCol ? ' over time (' + dateCol.name + ')' : '') + ', and what segments should the business prioritize?';

    if (difficulty === 'Junior') {
      return [
        { title: 'Task 1: Data Profiling', body: 'Load and profile the dataset. Describe its structure (row count, column count, types) and identify any data quality issues you observe.' },
        { title: 'Task 2: Top Entities Query', body: 'Write a SQL query to find the top 10 ' + entityLabel + ' values by ' + metricLabel + '.' },
        { title: 'Task 3: Summary Table', body: 'Create a summary table showing ' + entityLabel + ' broken down by ' + metricLabel + '.' },
        { title: 'Task 4: Anomaly Check', body: 'Identify any anomalies or outliers in the data and explain how you detected them.' },
        { title: 'Task 5: Executive Summary', body: 'Write a 1 paragraph executive summary of your findings, written for a non-technical audience.' }
      ];
    }
    if (difficulty === 'Senior') {
      return [
        { title: 'Task 1: Data Quality Audit', body: 'Perform a comprehensive data quality audit. Document every issue you find with a proposed remediation for each.' },
        { title: 'Task 2: Multi-Step SQL Pipeline', body: 'Build a multi-step SQL pipeline to answer: ' + businessQuestion },
        { title: 'Task 3: Statistical Drivers', body: 'Apply statistical analysis (correlation or regression) to identify key drivers of ' + outcomeLabel + '.' },
        { title: 'Task 4: Executive Narrative', body: 'Construct a business narrative for a non-technical executive audience, grounded in your analysis.' },
        { title: 'Task 5: Follow-up Roadmap', body: 'Propose 3 follow-up analyses you would pursue given more time and additional data sources.' }
      ];
    }
    return [
      { title: 'Task 1: Data Profiling and Quality Review', body: 'Load and profile the dataset. Describe its structure and document data quality issues, with notes on how each would affect downstream analysis.' },
      { title: 'Task 2: SQL Investigation', body: 'Write SQL queries to answer: ' + businessQuestion },
      { title: 'Task 3: Segment Analysis', body: 'Create a summary table showing ' + entityLabel + ' broken down by ' + metricLabel + ', and highlight the most notable segment.' },
      { title: 'Task 4: Anomaly and Outlier Analysis', body: 'Identify anomalies or outliers in ' + outcomeLabel + ' and assess whether they represent data errors or genuine business signal.' },
      { title: 'Task 5: Business Narrative', body: 'Write an executive summary that translates your technical findings into a clear business recommendation.' }
    ];
  }

  function buildHints(deliverables, ds) {
    var entityCol = findEntityCol(ds.columns);
    var entityLabel = entityCol ? entityCol.name : 'records';
    var generic = [
      'Use GROUP BY with COUNT(*) or SUM() and ORDER BY DESC to find top ' + entityLabel + '.',
      'Check column types and NULL counts first. A quick profiling pass saves time later.',
      'Check for NULL values using IS NULL in your WHERE clause, and watch for placeholder values like 0, -1, or "Unknown".',
      'Visualize the distribution of your key metric before deciding what counts as an outlier.',
      'Keep your executive summary to 4 to 6 sentences. Lead with the finding, not the method.'
    ];
    return deliverables.map(function (d, i) {
      return 'Hint ' + (i + 1) + ': ' + (generic[i] || generic[generic.length - 1]);
    });
  }

  function buildRubric(focus) {
    var base = [
      { criterion: 'SQL Quality', weight: '25%', description: 'Correctness, efficiency, readability' },
      { criterion: 'Analysis Depth', weight: '30%', description: 'Insight quality, business framing' },
      { criterion: 'Communication', weight: '25%', description: 'Clarity, structure, executive summary' },
      { criterion: 'Data Quality', weight: '20%', description: 'Issue identification and handling' }
    ];
    return base;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sampleValues(ds, colIdx) {
    var out = [];
    for (var i = 0; i < ds.rows.length && out.length < 3; i++) {
      var v = ds.rows[i][colIdx];
      if (v !== null && v !== undefined && v !== '') out.push(v);
    }
    return out.join(', ') || '(no data)';
  }

  function getDateRangeNote(ds) {
    var dateCol = findDateCol(ds.columns);
    if (!dateCol) return null;
    var idx = ds.columns.indexOf(dateCol);
    var vals = [];
    for (var i = 0; i < ds.rows.length; i++) {
      var v = ds.rows[i][idx];
      if (v) {
        var t = new Date(v).getTime();
        if (!isNaN(t)) vals.push(t);
      }
    }
    if (!vals.length) return null;
    vals.sort(function (a, b) { return a - b; });
    var min = new Date(vals[0]);
    var max = new Date(vals[vals.length - 1]);
    return min.toISOString().slice(0, 10) + ' to ' + max.toISOString().slice(0, 10);
  }

  function generateCase() {
    var ds = window.getActiveDataset ? window.getActiveDataset() : null;
    if (!ds) {
      window.showToast && window.showToast('Load a dataset first to generate a take-home case.', 'warn');
      return;
    }

    var domain = detectDomain(ds.columns);
    var background = buildBackground(domain, ds);
    var deliverables = buildDeliverables(thState.difficulty, thState.focus, ds, domain);
    var hints = thState.hints ? buildHints(deliverables, ds) : [];
    var rubric = buildRubric(thState.focus);
    var dateRange = getDateRangeNote(ds);
    var domainLabelMap = { healthcare: 'Claims Analysis', finance: 'Financial Data Analysis', hr: 'Workforce Analysis', general: 'Data Analysis' };
    var titlePrefix = ds.name ? ds.name : 'Dataset';
    var caseTitle = titlePrefix + ' - ' + thState.role + ' Take-Home Assessment';
    var dateIssued = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    thState.caseData = {
      title: caseTitle,
      role: thState.role,
      difficulty: thState.difficulty,
      timeLimit: thState.timeLimit,
      dateIssued: dateIssued,
      background: background,
      dataset: ds,
      domain: domain,
      deliverables: deliverables,
      hints: hints,
      rubric: rubric,
      dateRange: dateRange
    };

    renderCase(thState.caseData);
    showThPreviewScreen();
    window.SkillTracker && window.SkillTracker.track && window.SkillTracker.track('generate_takehome_case');
    window.LevelSystem && window.LevelSystem.addXP && window.LevelSystem.addXP('generate_takehome_case');
    if (window.showToast) window.showToast('Take-home case generated', 'success');
  }

  function renderCase(cd) {
    var el = th$('th-case-content');
    if (!el) return;
    var ds = cd.dataset;

    var html = '';
    html += '<div class="th-confidential">Confidential - For Candidate Use Only</div>';
    html += '<h1>' + escapeHtml(cd.title) + '</h1>';
    html += '<p><strong>Role:</strong> ' + escapeHtml(cd.role) + ' &nbsp; | &nbsp; <strong>Difficulty:</strong> ' + escapeHtml(cd.difficulty) + ' &nbsp; | &nbsp; <strong>Time Limit:</strong> ' + escapeHtml(cd.timeLimit) + ' &nbsp; | &nbsp; <strong>Date Issued:</strong> ' + escapeHtml(cd.dateIssued) + '</p>';

    html += '<h2>Section 1: Background</h2>';
    html += '<p>' + escapeHtml(cd.background[0]) + '</p>';
    html += '<p>' + escapeHtml(cd.background[1]) + '</p>';

    html += '<h2>Section 2: The Dataset</h2>';
    html += '<table><thead><tr><th>Column</th><th>Type</th><th>Description</th><th>Sample Values</th></tr></thead><tbody>';
    for (var i = 0; i < ds.columns.length; i++) {
      var col = ds.columns[i];
      html += '<tr><td>' + escapeHtml(col.name) + '</td><td>' + escapeHtml(col.type) + '</td><td>' + escapeHtml(inferColDescription(col.name, col.type)) + '</td><td>' + escapeHtml(sampleValues(ds, i)) + '</td></tr>';
    }
    html += '</tbody></table>';
    var rangeNote = cd.dateRange ? ' spanning ' + cd.dateRange : '';
    html += '<p>Note: The dataset contains ' + ds.rows.length.toLocaleString() + ' records across ' + ds.columns.length + ' columns' + rangeNote + '.</p>';

    html += '<h2>Section 3: Required Deliverables</h2>';
    for (var j = 0; j < cd.deliverables.length; j++) {
      var d = cd.deliverables[j];
      html += '<div class="th-deliverable"><strong>' + escapeHtml(d.title) + '</strong><p>' + escapeHtml(d.body) + '</p></div>';
      if (cd.hints[j]) {
        html += '<div class="th-hint">' + escapeHtml(cd.hints[j]) + '</div>';
      }
    }

    html += '<h2>Section 4: Evaluation Criteria</h2>';
    html += '<table class="th-rubric-table"><thead><tr><th>Criterion</th><th>Weight</th><th>Description</th></tr></thead><tbody>';
    for (var k = 0; k < cd.rubric.length; k++) {
      var r = cd.rubric[k];
      html += '<tr><td>' + escapeHtml(r.criterion) + '</td><td>' + escapeHtml(r.weight) + '</td><td>' + escapeHtml(r.description) + '</td></tr>';
    }
    html += '</tbody></table>';

    html += '<h2>Section 5: Submission Instructions</h2>';
    html += '<p>Submit your work as a PDF report or Jupyter notebook. Include all SQL queries you wrote along with output screenshots. Time yourself and stay within the ' + escapeHtml(cd.timeLimit) + ' limit.</p>';

    el.innerHTML = html;
  }

  function caseToMarkdown(cd) {
    var ds = cd.dataset;
    var lines = [];
    lines.push('CONFIDENTIAL - FOR CANDIDATE USE ONLY');
    lines.push('');
    lines.push('# ' + cd.title);
    lines.push('');
    lines.push('**Role:** ' + cd.role + '  |  **Difficulty:** ' + cd.difficulty + '  |  **Time Limit:** ' + cd.timeLimit + '  |  **Date Issued:** ' + cd.dateIssued);
    lines.push('');
    lines.push('## Section 1: Background');
    lines.push('');
    lines.push(cd.background[0]);
    lines.push('');
    lines.push(cd.background[1]);
    lines.push('');
    lines.push('## Section 2: The Dataset');
    lines.push('');
    lines.push('| Column | Type | Description | Sample Values |');
    lines.push('|---|---|---|---|');
    for (var i = 0; i < ds.columns.length; i++) {
      var col = ds.columns[i];
      lines.push('| ' + col.name + ' | ' + col.type + ' | ' + inferColDescription(col.name, col.type) + ' | ' + sampleValues(ds, i) + ' |');
    }
    lines.push('');
    var rangeNote = cd.dateRange ? ' spanning ' + cd.dateRange : '';
    lines.push('Note: The dataset contains ' + ds.rows.length.toLocaleString() + ' records across ' + ds.columns.length + ' columns' + rangeNote + '.');
    lines.push('');
    lines.push('## Section 3: Required Deliverables');
    lines.push('');
    for (var j = 0; j < cd.deliverables.length; j++) {
      var d = cd.deliverables[j];
      lines.push((j + 1) + '. **' + d.title + '**: ' + d.body);
      if (cd.hints[j]) {
        lines.push('   > ' + cd.hints[j]);
      }
    }
    lines.push('');
    lines.push('## Section 4: Evaluation Criteria');
    lines.push('');
    lines.push('| Criterion | Weight | Description |');
    lines.push('|---|---|---|');
    for (var k = 0; k < cd.rubric.length; k++) {
      var r = cd.rubric[k];
      lines.push('| ' + r.criterion + ' | ' + r.weight + ' | ' + r.description + ' |');
    }
    lines.push('');
    lines.push('## Section 5: Submission Instructions');
    lines.push('');
    lines.push('Submit your work as a PDF report or Jupyter notebook. Include all SQL queries you wrote along with output screenshots. Time yourself and stay within the ' + cd.timeLimit + ' limit.');
    return lines.join('\n');
  }

  function copyAsMarkdown() {
    if (!thState.caseData) return;
    var md = caseToMarkdown(thState.caseData);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(function () {
        window.showToast && window.showToast('Case copied as markdown', 'success');
      }).catch(function () {
        window.showToast && window.showToast('Could not copy to clipboard', 'error');
      });
    } else {
      window.showToast && window.showToast('Clipboard not available', 'error');
    }
  }

  function printCase() {
    window.print();
  }

  function shareCase() {
    if (!thState.caseData) return;
    var el = th$('th-case-content');
    if (!el) return;
    var htmlDoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(thState.caseData.title) + '</title></head><body>' + el.innerHTML + '</body></html>';
    var encoded;
    try {
      encoded = btoa(unescape(encodeURIComponent(htmlDoc)));
    } catch (e) {
      window.showToast && window.showToast('Could not build share link', 'error');
      return;
    }
    var dataUrl = 'data:text/html;base64,' + encoded;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(dataUrl).then(function () {
        window.showToast && window.showToast('Share link copied to clipboard', 'success');
      }).catch(function () {
        window.showToast && window.showToast('Could not copy share link', 'error');
      });
    } else {
      window.showToast && window.showToast('Clipboard not available', 'error');
    }
  }

  function toggleFocusCheckbox(label) {
    var focus = label.getAttribute('data-focus');
    var checkbox = label.querySelector('input');
    var isChecked = label.classList.contains('checked');
    if (isChecked) {
      label.classList.remove('checked');
      if (checkbox) checkbox.checked = false;
      var idx = thState.focus.indexOf(focus);
      if (idx > -1) thState.focus.splice(idx, 1);
    } else {
      label.classList.add('checked');
      if (checkbox) checkbox.checked = true;
      if (thState.focus.indexOf(focus) === -1) thState.focus.push(focus);
    }
  }

  function wireTakeHome() {
    var trigger = th$('takehome-trigger-btn');
    if (trigger) trigger.addEventListener('click', openTakeHome);

    var closeBtn = th$('th-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeTakeHome);

    var backBtn = th$('th-back-btn');
    if (backBtn) backBtn.addEventListener('click', showThGenScreen);

    var roleSel = th$('th-role-select');
    if (roleSel) roleSel.addEventListener('change', function () { thState.role = roleSel.value; });

    var diffSel = th$('th-difficulty-select');
    if (diffSel) diffSel.addEventListener('change', function () { thState.difficulty = diffSel.value; });

    var timeSel = th$('th-time-select');
    if (timeSel) timeSel.addEventListener('change', function () { thState.timeLimit = timeSel.value; });

    var focusWrap = th$('th-focus-checkboxes');
    if (focusWrap) {
      var labels = focusWrap.querySelectorAll('.th-checkbox-label');
      for (var i = 0; i < labels.length; i++) {
        labels[i].addEventListener('click', function (e) {
          e.preventDefault();
          toggleFocusCheckbox(this);
        });
      }
    }

    var hintsToggle = th$('th-hints-toggle');
    if (hintsToggle) {
      hintsToggle.addEventListener('click', function () {
        thState.hints = !thState.hints;
        hintsToggle.classList.toggle('on', thState.hints);
      });
    }

    var genBtn = th$('th-generate-btn');
    if (genBtn) genBtn.addEventListener('click', generateCase);

    var copyBtn = th$('th-copy-md-btn');
    if (copyBtn) copyBtn.addEventListener('click', copyAsMarkdown);

    var printBtn = th$('th-print-btn');
    if (printBtn) printBtn.addEventListener('click', printCase);

    var shareBtn = th$('th-share-btn');
    if (shareBtn) shareBtn.addEventListener('click', shareCase);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireTakeHome);
  } else {
    wireTakeHome();
  }

  window.TakeHomeCase = {
    open: openTakeHome,
    close: closeTakeHome,
    generate: generateCase
  };
