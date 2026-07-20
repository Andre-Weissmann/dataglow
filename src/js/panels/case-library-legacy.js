/* DataGlow — js/panels/case-library-legacy.js */
/* Part of structured refactor — see src/ directory */

(function () {
  'use strict';

  var CASES = [
    {
      id: 'los-by-diagnosis',
      domain: 'healthcare',
      difficulty: 'beginner',
      title: 'Average Length of Stay by Diagnosis',
      desc: 'Which diagnoses drive the longest hospitalizations?',
      steps: [
        { sql: 'SELECT dx_primary, ROUND(AVG(los_days), 1) as avg_los, COUNT(*) as claims FROM your_table GROUP BY dx_primary ORDER BY avg_los DESC LIMIT 10', insight: 'Which diagnosis codes drive the longest hospitalizations?' },
        { sql: 'SELECT facility_state, ROUND(AVG(los_days), 1) as avg_los FROM your_table GROUP BY facility_state ORDER BY avg_los DESC', insight: 'Do certain states show longer stays?' }
      ]
    },
    {
      id: 'claims-payment-outliers',
      domain: 'healthcare',
      difficulty: 'intermediate',
      title: 'Claims Payment Outlier Detection',
      desc: 'Which claims deviate most from average payment?',
      steps: [
        { sql: 'SELECT CLM_ID, pmt_amt_usd, AVG(pmt_amt_usd) OVER () as avg_pmt, pmt_amt_usd - AVG(pmt_amt_usd) OVER () as deviation FROM your_table ORDER BY deviation DESC LIMIT 20', insight: 'Which claims deviate most from average payment?' },
        { sql: 'SELECT dx_primary, COUNT(*) as claim_count, ROUND(AVG(pmt_amt_usd),2) as avg_pmt, MAX(pmt_amt_usd) as max_pmt FROM your_table GROUP BY dx_primary HAVING COUNT(*) >= 3 ORDER BY avg_pmt DESC', insight: 'High-cost diagnosis groups vs typical payment profiles.' }
      ]
    },
    {
      id: 'readmission-risk',
      domain: 'healthcare',
      difficulty: 'advanced',
      title: 'Readmission Risk Pattern',
      desc: 'Spot patients with repeat admissions and gaps between stays.',
      steps: [
        { sql: 'SELECT bene_id, COUNT(*) as admissions, MIN(adm_date) as first_admit, MAX(adm_date) as last_admit FROM your_table GROUP BY bene_id HAVING COUNT(*) > 1 ORDER BY admissions DESC LIMIT 15', insight: 'Patients with multiple admissions - potential readmission risk.' },
        { sql: 'SELECT bene_id, adm_date, disch_date, los_days, dx_primary, LAG(disch_date) OVER (PARTITION BY bene_id ORDER BY adm_date) as prev_discharge FROM your_table ORDER BY bene_id, adm_date', insight: 'Days between discharge and re-admission by patient.' }
      ]
    },
    {
      id: 'revenue-by-category',
      domain: 'finance',
      difficulty: 'beginner',
      title: 'Revenue by Category',
      desc: 'Which categories drive the most revenue?',
      steps: [
        { sql: 'SELECT category, ROUND(SUM(amount),2) as total_revenue, COUNT(*) as transactions FROM your_table GROUP BY category ORDER BY total_revenue DESC', insight: 'Which categories drive the most revenue?' },
        { sql: 'SELECT category, ROUND(AVG(amount),2) as avg_txn, MIN(amount) as min_txn, MAX(amount) as max_txn FROM your_table GROUP BY category', insight: 'Transaction size distribution by category.' }
      ]
    },
    {
      id: 'monthly-trend',
      domain: 'finance',
      difficulty: 'intermediate',
      title: 'Monthly Trend Analysis',
      desc: 'Track month-over-month revenue trend and growth rate.',
      steps: [
        { sql: "SELECT SUBSTR(CAST(date_col AS VARCHAR), 1, 7) as month, ROUND(SUM(amount),2) as revenue, COUNT(*) as txns FROM your_table GROUP BY month ORDER BY month", insight: 'Month-over-month revenue trend.' },
        { sql: "SELECT month, revenue, LAG(revenue) OVER (ORDER BY month) as prev_month, ROUND((revenue - LAG(revenue) OVER (ORDER BY month)) / NULLIF(LAG(revenue) OVER (ORDER BY month),0) * 100, 1) as pct_change FROM (SELECT SUBSTR(CAST(date_col AS VARCHAR),1,7) as month, ROUND(SUM(amount),2) as revenue FROM your_table GROUP BY month) ORDER BY month", insight: 'Growth rate month over month.' }
      ]
    },
    {
      id: 'txn-anomaly',
      domain: 'finance',
      difficulty: 'advanced',
      title: 'Anomaly Detection in Transactions',
      desc: 'Find transactions that deviate sharply from typical patterns.',
      steps: [
        { sql: 'SELECT *, ABS(amount - AVG(amount) OVER ()) / NULLIF(STDDEV(amount) OVER (), 0) as z_score FROM your_table ORDER BY z_score DESC LIMIT 20', insight: 'Transactions more than 2 standard deviations from the mean.' },
        { sql: 'SELECT EXTRACT(DOW FROM CAST(date_col AS DATE)) as day_of_week, COUNT(*) as txns, ROUND(AVG(amount),2) as avg_amt FROM your_table GROUP BY day_of_week ORDER BY day_of_week', insight: 'Transaction patterns by day of week.' }
      ]
    },
    {
      id: 'headcount-by-dept',
      domain: 'hr',
      difficulty: 'beginner',
      title: 'Headcount by Department',
      desc: 'Team sizes and average compensation by department.',
      steps: [
        { sql: 'SELECT department, COUNT(*) as headcount, ROUND(AVG(salary),2) as avg_salary FROM your_table GROUP BY department ORDER BY headcount DESC', insight: 'Team sizes and average compensation by department.' },
        { sql: 'SELECT department, MIN(salary) as min_sal, MAX(salary) as max_sal, MAX(salary) - MIN(salary) as sal_range FROM your_table GROUP BY department ORDER BY sal_range DESC', insight: 'Pay range spread - wide spreads may indicate leveling inconsistencies.' }
      ]
    },
    {
      id: 'attrition-risk',
      domain: 'hr',
      difficulty: 'intermediate',
      title: 'Attrition Risk Analysis',
      desc: 'Which tenure bands and departments carry the highest attrition risk?',
      steps: [
        { sql: "SELECT tenure_years, COUNT(*) as employees, SUM(CASE WHEN status = 'left' THEN 1 ELSE 0 END) as attrited, ROUND(SUM(CASE WHEN status = 'left' THEN 1 ELSE 0 END)*100.0/COUNT(*),1) as attrition_rate FROM your_table GROUP BY tenure_years ORDER BY tenure_years", insight: 'Which tenure band has the highest attrition?' },
        { sql: "SELECT department, ROUND(AVG(satisfaction_score),2) as avg_satisfaction, SUM(CASE WHEN status='left' THEN 1 ELSE 0 END)*100/COUNT(*) as attrition_pct FROM your_table GROUP BY department ORDER BY avg_satisfaction", insight: 'Departments with low satisfaction correlate with high attrition.' }
      ]
    },
    {
      id: 'ops-throughput',
      domain: 'hr',
      difficulty: 'advanced',
      title: 'Operations Throughput',
      desc: 'Which process steps consume the most time, and where do the worst cases pile up?',
      steps: [
        { sql: 'SELECT process_step, ROUND(AVG(duration_mins),1) as avg_mins, COUNT(*) as volume, ROUND(AVG(duration_mins)*COUNT(*),0) as total_mins FROM your_table GROUP BY process_step ORDER BY total_mins DESC', insight: 'Which process steps consume the most time overall?' },
        { sql: 'SELECT process_step, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_mins) as median_mins, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_mins) as p95_mins FROM your_table GROUP BY process_step ORDER BY p95_mins DESC', insight: 'P95 latency - where do the worst 5% of cases pile up?' }
      ]
    }
  ];

  var activeCase = null;
  var activeStepIdx = 0;

  function domainLabel(d) {
    if (d === 'healthcare') return 'Healthcare';
    if (d === 'finance') return 'Finance';
    if (d === 'hr') return 'HR';
    return d;
  }

  function difficultyLabel(d) {
    if (d === 'beginner') return 'Beginner';
    if (d === 'intermediate') return 'Intermediate';
    if (d === 'advanced') return 'Advanced';
    return d;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderCards(filterDomain, searchTerm) {
    var grid = document.getElementById('cases-grid');
    if (!grid) return;
    var term = (searchTerm || '').toLowerCase().trim();
    var list = CASES.filter(function (c) {
      var domainOk = !filterDomain || filterDomain === 'all' || c.domain === filterDomain;
      if (!domainOk) return false;
      if (!term) return true;
      var hay = (c.title + ' ' + c.desc + ' ' + c.domain + ' ' + c.difficulty).toLowerCase();
      return hay.indexOf(term) !== -1;
    });
    if (!list.length) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);font-size:12px;padding:24px;">No cases match your search.</div>';
      return;
    }
    grid.innerHTML = list.map(function (c, i) {
      var idx = CASES.indexOf(c);
      return '<div class="case-card">' +
        '<div class="case-tags">' +
          '<span class="case-tag ' + c.domain + '">' + escapeHtml(domainLabel(c.domain)) + '</span>' +
          '<span class="case-tag ' + c.difficulty + '">' + escapeHtml(difficultyLabel(c.difficulty)) + '</span>' +
        '</div>' +
        '<div class="case-title">' + escapeHtml(c.title) + '</div>' +
        '<div class="case-desc">' + escapeHtml(c.desc) + '</div>' +
        '<button class="case-run-btn" data-case-idx="' + idx + '">Run Case</button>' +
      '</div>';
    }).join('');
    grid.querySelectorAll('.case-run-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-case-idx'), 10);
        runCase(CASES[idx]);
      });
    });
  }

  function getActiveTableName() {
    var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
    if (!ds) return 'your_table';
    if (window.SQLEngine && typeof window.SQLEngine.safeTableName === 'function') {
      return window.SQLEngine.safeTableName(ds.name);
    }
    return (ds.name || 'data').replace(/[^a-zA-Z0-9_]/g, '_');
  }

  function fuzzyMatchColumn(columns, placeholder) {
    // columns: [{name,type}]
    var names = columns.map(function (c) { return c.name; });
    var lowerNames = names.map(function (n) { return n.toLowerCase(); });
    var target = placeholder.toLowerCase();

    // exact match first
    var exactIdx = lowerNames.indexOf(target);
    if (exactIdx !== -1) return names[exactIdx];

    // synonym map for common placeholders
    var synonyms = {
      'dx_primary': ['diagnosis', 'dx', 'diagnosis_code', 'primary_diagnosis'],
      'los_days': ['length_of_stay', 'los', 'stay_days'],
      'facility_state': ['state', 'provider_state', 'hospital_state'],
      'clm_id': ['claim_id', 'claimid', 'clm'],
      'pmt_amt_usd': ['payment_amount', 'pmt_amt', 'amount_paid', 'paid_amount'],
      'bene_id': ['beneficiary_id', 'patient_id', 'member_id'],
      'adm_date': ['admission_date', 'admit_date'],
      'disch_date': ['discharge_date', 'disch'],
      'category': ['type', 'txn_category', 'transaction_category'],
      'amount': ['amt', 'value', 'total', 'transaction_amount'],
      'date_col': ['date', 'txn_date', 'transaction_date', 'created_at'],
      'department': ['dept', 'team', 'division'],
      'salary': ['comp', 'compensation', 'pay', 'base_salary'],
      'tenure_years': ['tenure', 'years_of_service', 'years_employed'],
      'status': ['employment_status', 'active_status'],
      'satisfaction_score': ['satisfaction', 'engagement_score'],
      'process_step': ['step', 'stage', 'process_stage'],
      'duration_mins': ['duration', 'duration_minutes', 'time_mins', 'minutes']
    };

    var candidates = synonyms[target] || [];
    for (var i = 0; i < candidates.length; i++) {
      var cIdx = lowerNames.indexOf(candidates[i]);
      if (cIdx !== -1) return names[cIdx];
    }

    // partial/contains match
    for (var j = 0; j < lowerNames.length; j++) {
      if (lowerNames[j].indexOf(target) !== -1 || target.indexOf(lowerNames[j]) !== -1) {
        return names[j];
      }
    }
    for (var k = 0; k < candidates.length; k++) {
      for (var m = 0; m < lowerNames.length; m++) {
        if (lowerNames[m].indexOf(candidates[k]) !== -1) return names[m];
      }
    }

    return null; // no match, leave placeholder as-is
  }

  function resolveSql(sql) {
    var tableName = getActiveTableName();
    var resolved = sql.replace(/your_table/g, tableName);

    var ds = typeof window.getActiveDataset === 'function' ? window.getActiveDataset() : null;
    var columns = (ds && ds.columns) ? ds.columns : [];
    if (!columns.length) return resolved;

    var placeholders = ['dx_primary', 'los_days', 'facility_state', 'clm_id', 'pmt_amt_usd',
      'bene_id', 'adm_date', 'disch_date', 'category', 'amount', 'date_col',
      'department', 'salary', 'tenure_years', 'status', 'satisfaction_score',
      'process_step', 'duration_mins'];

    placeholders.forEach(function (ph) {
      var re = new RegExp('\\b' + ph + '\\b', 'g');
      if (re.test(resolved)) {
        var match = fuzzyMatchColumn(columns, ph);
        if (match && match.toLowerCase() !== ph.toLowerCase()) {
          resolved = resolved.replace(new RegExp('\\b' + ph + '\\b', 'g'), match);
        }
      }
    });

    return resolved;
  }

  function renderCaseGuide() {
    var stepsEl = document.getElementById('cg-steps');
    var titleEl = document.getElementById('cg-title');
    var nextBtn = document.getElementById('cg-next-btn');
    if (!stepsEl || !activeCase) return;
    titleEl.textContent = activeCase.title;
    stepsEl.innerHTML = activeCase.steps.map(function (step, i) {
      var isActive = i === activeStepIdx;
      var resolved = resolveSql(step.sql);
      return '<div class="cg-step' + (isActive ? ' active' : '') + '">' +
        '<div class="cg-step-num">Step ' + (i + 1) + ' of ' + activeCase.steps.length + '</div>' +
        '<div class="cg-step-insight">' + escapeHtml(step.insight) + '</div>' +
        '<code class="cg-step-sql">' + escapeHtml(resolved) + '</code>' +
      '</div>';
    }).join('');
    if (nextBtn) {
      nextBtn.disabled = activeStepIdx >= activeCase.steps.length - 1;
      nextBtn.textContent = activeStepIdx >= activeCase.steps.length - 1 ? 'Case Complete' : 'Next Step';
    }
  }

  function openCaseGuide() {
    var guide = document.getElementById('case-guide');
    if (guide) guide.classList.add('open');
  }

  function closeCaseGuide() {
    var guide = document.getElementById('case-guide');
    if (guide) guide.classList.remove('open');
  }

  function runStep(stepIdx) {
    if (!activeCase) return;
    activeStepIdx = stepIdx;
    var step = activeCase.steps[stepIdx];
    var resolved = resolveSql(step.sql);
    var input = document.getElementById('sql-view-input');
    if (input) input.value = resolved;
    renderCaseGuide();
    var runBtn = document.getElementById('sql-view-run');
    if (runBtn) runBtn.click();
    if (window.SkillTracker && typeof window.SkillTracker.track === 'function') {
      window.SkillTracker.track('run_case_step');
    }
  }

  function runCase(caseObj) {
    activeCase = caseObj;
    activeStepIdx = 0;

    var sqlPill = document.querySelector('[data-panel="sql-view"]');
    if (sqlPill) sqlPill.click();

    setTimeout(function () {
      runStep(0);
      openCaseGuide();
    }, 60);

    if (window.SkillTracker && typeof window.SkillTracker.track === 'function') {
      window.SkillTracker.track('run_case');
    }
    if (typeof window.showToast === 'function') {
      window.showToast('Running case: ' + caseObj.title, 'info');
    }
  }
  window.runDomainCase = runCase;

  function init() {
    renderCards('all', '');

    var searchInput = document.getElementById('cases-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        var activeFilterBtn = document.querySelector('.cases-filter-btn.active');
        var domain = activeFilterBtn ? activeFilterBtn.getAttribute('data-domain') : 'all';
        renderCards(domain, searchInput.value);
      });
    }

    document.querySelectorAll('.cases-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.cases-filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var searchEl = document.getElementById('cases-search');
        renderCards(btn.getAttribute('data-domain'), searchEl ? searchEl.value : '');
      });
    });

    var cgClose = document.getElementById('cg-close');
    if (cgClose) cgClose.addEventListener('click', closeCaseGuide);

    var cgNext = document.getElementById('cg-next-btn');
    if (cgNext) {
      cgNext.addEventListener('click', function () {
        if (!activeCase) return;
        if (activeStepIdx < activeCase.steps.length - 1) {
          runStep(activeStepIdx + 1);
        }
      });
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 0);
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
