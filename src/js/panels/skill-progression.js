/* DataGlow — src/js/panels/skill-progression.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    var SKILL_DEFS = [
      { id:'data_loading',    label:'Data Loading',    tiers:[{key:'load_file',   thresh:1,  label:'Novice'},{key:'load_3_files',  thresh:3,  label:'Practitioner'},{key:'load_10_files', thresh:10, label:'Expert'}] },
      { id:'validation',      label:'Validation',      tiers:[{key:'run_validation',thresh:1, label:'Novice'},{key:'fix_finding',   thresh:3,  label:'Practitioner'},{key:'perfect_score', thresh:1,  label:'Expert'}] },
      { id:'sql',             label:'SQL',             tiers:[{key:'run_sql',     thresh:1,  label:'Novice'},{key:'run_10_sql',    thresh:10, label:'Practitioner'},{key:'write_join',    thresh:1,  label:'Expert'}] },
      { id:'charts',          label:'Charts',          tiers:[{key:'view_chart',  thresh:1,  label:'Novice'},{key:'customize_chart',thresh:3, label:'Practitioner'},{key:'multi_chart',   thresh:5,  label:'Expert'}] },
      { id:'python',          label:'Python',          tiers:[{key:'run_python',  thresh:1,  label:'Novice'},{key:'run_10_python', thresh:10, label:'Practitioner'},{key:'save_python',   thresh:1,  label:'Expert'}] },
      { id:'stats',           label:'Stats',           tiers:[{key:'run_correlation',thresh:1,label:'Novice'},{key:'run_regression',thresh:1, label:'Practitioner'},{key:'run_hypothesis',thresh:1, label:'Expert'}] },
      { id:'dashboard',       label:'Dashboard',       tiers:[{key:'build_dashboard',thresh:1,label:'Novice'},{key:'translate_findings',thresh:1,label:'Practitioner'},{key:'export_csv', thresh:1,  label:'Expert'}] },
      { id:'r_language',      label:'R Language',      tiers:[{key:'run_r',       thresh:1,  label:'Novice'},{key:'run_10_r',     thresh:10, label:'Practitioner'},{key:'use_domain_r',  thresh:1,  label:'Expert'}] },
      { id:'window_fns',      label:'Window Functions',tiers:[{key:'open_dojo',   thresh:1,  label:'Novice'},{key:'run_window_fn', thresh:3, label:'Practitioner'},{key:'all_8_fns',     thresh:8,  label:'Expert'}] },
      { id:'excel_mode',      label:'Excel Mode',      tiers:[{key:'use_excel',   thresh:1,  label:'Novice'},{key:'use_formula',  thresh:1,  label:'Practitioner'},{key:'use_10_formulas',thresh:10,label:'Expert'}] },
      { id:'data_quality',    label:'Data Quality',    tiers:[{key:'score_80',    thresh:1,  label:'Novice'},{key:'score_90',     thresh:1,  label:'Practitioner'},{key:'score_100',     thresh:1,  label:'Expert'}] },
      { id:'explorer',        label:'Explorer',        tiers:[{key:'datasets_3',  thresh:3,  label:'Novice'},{key:'datasets_10',  thresh:10, label:'Practitioner'},{key:'use_5_features', thresh:5, label:'Expert'}] }
    ];

    var progress = { actions: {}, unlocked: [] };

    function save() {
      try {
        if (window.OPFSEngine && window.OPFSEngine._supported) {
          window.OPFSEngine.saveDataset('__skills__', [JSON.stringify(progress)], [{name:'data',type:'STR'}]).catch(function(){});
        }
      } catch(e) {}
    }

    function load() {
      try {
        if (window.OPFSEngine && window.OPFSEngine._supported) {
          window.OPFSEngine.loadDataset('__skills__').then(function(ds) {
            if (ds && ds.rows && ds.rows[0] && ds.rows[0][0]) {
              try { var p = JSON.parse(ds.rows[0][0]); progress.actions = p.actions||{}; progress.unlocked = p.unlocked||[]; } catch(e){}
              renderSkills();
            }
          }).catch(function(){});
        }
      } catch(e) {}
    }

    function trackAction(key, count) {
      count = count || 1;
      progress.actions[key] = (progress.actions[key] || 0) + count;
      checkUnlocks();
      save();
      renderSkills();
    }

    function checkUnlocks() {
      SKILL_DEFS.forEach(function(skill) {
        skill.tiers.forEach(function(tier, ti) {
          var unlockKey = skill.id + '_t' + (ti + 1);
          if (progress.unlocked.indexOf(unlockKey) >= 0) return;
          var count = progress.actions[tier.key] || 0;
          if (count >= tier.thresh) {
            progress.unlocked.push(unlockKey);
            var msg = tier.label === 'Expert'
              ? 'Expert unlocked: ' + skill.label + '! You mastered it.'
              : skill.label + ' ' + tier.label + ' unlocked!';
            window.showToast && window.showToast(msg, tier.label === 'Expert' ? 'success' : 'info');
          }
        });
      });
    }

    function getCurrentTier(skill) {
      var tier = -1;
      skill.tiers.forEach(function(t, i) {
        if ((progress.actions[t.key] || 0) >= t.thresh) tier = i;
      });
      return tier; // -1 = not started, 0 = novice, 1 = practitioner, 2 = expert
    }

    function getNextTierProgress(skill) {
      var cur = getCurrentTier(skill);
      if (cur >= 2) return { pct: 100, label: 'Expert', sub: 'Fully mastered' };
      var nextIdx = cur + 1;
      var next = skill.tiers[nextIdx];
      var have = progress.actions[next.key] || 0;
      var need = next.thresh;
      var pct = Math.min(100, Math.round(have / need * 100));
      return { pct: pct, label: cur < 0 ? 'Not started' : skill.tiers[cur].label, next: next.label, sub: have + '/' + need + ' to ' + next.label };
    }

    function renderSkills() {
      var list = document.getElementById('skills-list');
      if (!list) return;
      list.innerHTML = SKILL_DEFS.map(function(skill) {
        var p = getNextTierProgress(skill);
        var curTier = getCurrentTier(skill);
        var tierLabel = curTier < 0 ? 'Not started' : skill.tiers[curTier].label;
        var tierColor = curTier < 0 ? 'var(--text-muted)' : curTier === 2 ? '#6DAA45' : 'var(--primary)';
        return '<div class="skill-row">' +
          '<div class="skill-row-header">' +
          '<span class="skill-name">' + skill.label + '</span>' +
          '<span class="skill-tier" style="color:' + tierColor + ';">' + tierLabel + '</span>' +
          '</div>' +
          '<div class="skill-bar-track"><div class="skill-bar-fill" style="width:' + p.pct + '%;"></div></div>' +
          '<div class="skill-sub">' + (curTier >= 2 ? 'Fully mastered' : p.sub) + '</div>' +
          '</div>';
      }).join('');
    }

    // Panel open/close
    var panel = document.getElementById('skills-panel');
    var triggerBtn = document.getElementById('skills-trigger-btn');
    var closeBtn = document.getElementById('skills-close-btn');

    if (triggerBtn) triggerBtn.addEventListener('click', function() {
      if (panel) { panel.classList.toggle('open'); renderSkills(); }
    });
    if (closeBtn) closeBtn.addEventListener('click', function() {
      if (panel) panel.classList.remove('open');
    });

    // Dataset loaded
    document.addEventListener('dataglow:dataset-loaded', function(e) {
      trackAction('load_file');
      var ds = e.detail && (e.detail.dataset || e.detail);
      var loadCount = progress.actions['load_file'] || 0;
      if (loadCount >= 3) trackAction('load_3_files');
      if (loadCount >= 10) trackAction('load_10_files');
      if (ds && ds.score) {
        if (ds.score >= 80) trackAction('score_80');
        if (ds.score >= 90) trackAction('score_90');
        if (ds.score >= 100) trackAction('score_100');
      }
      var dsCount = window.state && window.state.datasets ? window.state.datasets.length : 0;
      if (dsCount >= 3) trackAction('datasets_3');
      if (dsCount >= 10) trackAction('datasets_10');
    });

    // Validation run + findings fixed
    document.addEventListener('dataglow:validation-run', function() {
      trackAction('run_validation');
    });
    document.addEventListener('dataglow:finding-fixed', function() {
      trackAction('fix_finding');
    });

    // SQL run
    document.addEventListener('dataglow:sql-run', function(e) {
      trackAction('run_sql');
      if ((progress.actions['run_sql'] || 0) >= 10) trackAction('run_10_sql');
      var sql = e.detail && e.detail.sql || '';
      if (sql.toUpperCase().indexOf('JOIN') >= 0) trackAction('write_join');
    });

    // Fallback: watch the SQL run button click
    var sqlRunBtn = document.getElementById('sql-view-run');
    if (sqlRunBtn) sqlRunBtn.addEventListener('click', function() {
      var input = document.getElementById('sql-view-input');
      var sql = input ? input.value : '';
      trackAction('run_sql');
      if ((progress.actions['run_sql'] || 0) >= 10) trackAction('run_10_sql');
      if (sql.toUpperCase().indexOf('JOIN') >= 0) trackAction('write_join');
    });

    // Python run
    var pyRunBtn = document.getElementById('py-view-run');
    if (pyRunBtn) pyRunBtn.addEventListener('click', function() {
      trackAction('run_python');
      if ((progress.actions['run_python'] || 0) >= 10) trackAction('run_10_python');
    });

    // Python save script
    var pySaveBtn = document.getElementById('py-save-btn');
    if (pySaveBtn) pySaveBtn.addEventListener('click', function() {
      trackAction('save_python');
    });

    // R run
    var rRunBtn = document.getElementById('r-run-btn');
    if (rRunBtn) rRunBtn.addEventListener('click', function() {
      trackAction('run_r');
      if ((progress.actions['run_r'] || 0) >= 10) trackAction('run_10_r');
    });

    // Charts tab view + customize/multi tracking
    var chartsPill = document.querySelector('[data-panel="charts-view"]');
    if (chartsPill) chartsPill.addEventListener('click', function() { trackAction('view_chart'); });

    document.addEventListener('dataglow:chart-customized', function() {
      trackAction('customize_chart');
    });
    document.addEventListener('dataglow:chart-added', function() {
      trackAction('multi_chart');
    });

    // Dashboard build
    var dashBuildBtn = document.querySelector('.dash-btn-primary');
    if (dashBuildBtn) dashBuildBtn.addEventListener('click', function() { trackAction('build_dashboard'); });

    // Export CSV
    var exportCsvBtn = document.getElementById('export-csv-btn');
    if (exportCsvBtn) exportCsvBtn.addEventListener('click', function() { trackAction('export_csv'); });
    var dashCsvBtn = document.getElementById('dash-csv-btn');
    if (dashCsvBtn) dashCsvBtn.addEventListener('click', function() { trackAction('export_csv'); });

    // Stats correlation / regression / hypothesis
    var corrBtn = document.querySelector('[data-stats="corr"]');
    if (corrBtn) corrBtn.addEventListener('click', function() { trackAction('run_correlation'); });
    var regRunBtn = document.getElementById('stats-reg-run');
    if (regRunBtn) regRunBtn.addEventListener('click', function() { trackAction('run_regression'); });
    var hypRunBtn = document.getElementById('stats-hyp-run');
    if (hypRunBtn) hypRunBtn.addEventListener('click', function() { trackAction('run_hypothesis'); });

    // Dojo open + window function run + distinct fn coverage
    var dojoBtn = document.getElementById('dojo-btn');
    if (dojoBtn) dojoBtn.addEventListener('click', function() {
      trackAction('open_dojo');
    });

    var dojoFnsSeen = {};
    var dojoFnCount = 0;
    document.querySelectorAll('#dojo-fn-grid .dojo-fn-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var fn = card.getAttribute('data-fn');
        if (fn && !dojoFnsSeen[fn]) {
          dojoFnsSeen[fn] = true;
          dojoFnCount++;
          if (dojoFnCount >= 8) trackAction('all_8_fns', 8);
        }
      });
    });

    var dojoRunBtn = document.getElementById('dojo-run-btn');
    if (dojoRunBtn) dojoRunBtn.addEventListener('click', function() {
      trackAction('run_window_fn');
    });

    // Excel pill + formula usage
    var excelPill = document.querySelector('[data-panel="excel-view"]');
    if (excelPill) excelPill.addEventListener('click', function() { trackAction('use_excel'); });

    document.addEventListener('dataglow:formula-used', function() {
      trackAction('use_formula');
      if ((progress.actions['use_formula'] || 0) >= 10) trackAction('use_10_formulas');
    });

    var formulaBar = document.getElementById('formula-bar');
    if (formulaBar) {
      formulaBar.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          var val = formulaBar.value || (formulaBar.querySelector ? '' : '');
          var text = formulaBar.value !== undefined ? formulaBar.value : '';
          if (text && text.charAt(0) === '=') {
            trackAction('use_formula');
            if ((progress.actions['use_formula'] || 0) >= 10) trackAction('use_10_formulas');
          }
        }
      });
    }

    // Business translate btn
    var bizBtn = document.querySelector('.biz-translate-btn');
    if (bizBtn) bizBtn.addEventListener('click', function() { trackAction('translate_findings'); });

    // Explorer: feature diversity tracking
    var featuresSeen = {};
    var featuresSeenCount = 0;
    ['charts-view','sql-view','python-view','r-view','excel-view','stats-view','dashboard-view'].forEach(function(panelName) {
      var pill = document.querySelector('[data-panel="' + panelName + '"]');
      if (pill) pill.addEventListener('click', function() {
        if (!featuresSeen[panelName]) {
          featuresSeen[panelName] = true;
          featuresSeenCount++;
          if (featuresSeenCount >= 5) trackAction('use_5_features');
        }
      });
    });

    // Load saved progress on startup
    setTimeout(load, 500);

    // Expose for external hooks
    window.SkillTracker = { track: trackAction, progress: progress };
