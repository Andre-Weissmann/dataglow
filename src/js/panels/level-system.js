/* DataGlow — src/js/panels/level-system.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    var LEVELS = [
      {n:1,  title:'Apprentice',      xp:0},
      {n:2,  title:'Analyst',         xp:100},
      {n:3,  title:'Investigator',    xp:300},
      {n:4,  title:'Explorer',        xp:600},
      {n:5,  title:'Practitioner',    xp:1000},
      {n:6,  title:'Specialist',      xp:1500},
      {n:7,  title:'Craftsman',       xp:2200},
      {n:8,  title:'Expert',          xp:3000},
      {n:9,  title:'Master',          xp:4000},
      {n:10, title:'Architect',       xp:5500},
      {n:11, title:'Visionary',       xp:7500},
      {n:12, title:'Pioneer',         xp:10000},
      {n:13, title:'Luminary',        xp:13500},
      {n:14, title:'Legend',          xp:18000},
      {n:15, title:'DataGlow Elite',  xp:25000}
    ];

    var BADGES = [
      {id:'first_light',   icon:'sunrise',  label:'First Light',         desc:'Load your first dataset'},
      {id:'sql_initiate',  icon:'database', label:'SQL Initiate',        desc:'Run your first SQL query'},
      {id:'chart_maker',   icon:'bar-chart',label:'Chart Maker',         desc:'Generate your first chart'},
      {id:'py_starter',    icon:'code',     label:'Python Starter',      desc:'Run your first Python script'},
      {id:'stats_explorer',icon:'activity', label:'Stats Explorer',      desc:'Complete all 3 stat modes'},
      {id:'data_detective',icon:'search',   label:'Data Detective',      desc:'Find a data quality issue'},
      {id:'dojo_student',  icon:'zap',      label:'Dojo Student',        desc:'Use Window Dojo 3 times'},
      {id:'arena_champ',   icon:'layers',   label:'Arena Champion',      desc:'Run an Arena comparison'},
      {id:'polyglot',      icon:'globe',    label:'Polyglot',            desc:'Use SQL, Python, and R in one session'},
      {id:'perfectionist', icon:'star',     label:'Perfectionist',       desc:'Achieve a data quality score of 100'}
    ];

    var XP_EVENTS = {
      load_dataset:   10,
      run_sql:        15,
      build_chart:    5,
      run_python:     20,
      run_r:          20,
      run_correlation:25,
      run_regression: 25,
      run_hypothesis: 25,
      use_dojo:       15,
      use_arena:      10,
      use_excel:      5,
      quality_90:     30,
      skill_unlock:   50
    };

    var prog = { xp:0, level:1, badges:[], streak:0, lastDate:null, sessionBadges:[], xpLog:[] };
    var sessionUsed = { sql:false, python:false, r:false };
    var statsDone = { corr:false, reg:false, hyp:false };

    function saveXP() {
      try {
        if (window.OPFSEngine && window.OPFSEngine._supported) {
          window.OPFSEngine.saveDataset('__xp__', [JSON.stringify(prog)], [{name:'d',type:'STR'}]).catch(function(){});
        }
      } catch(e){}
    }

    function loadXP() {
      try {
        if (window.OPFSEngine && window.OPFSEngine._supported) {
          window.OPFSEngine.loadDataset('__xp__').then(function(ds) {
            if (ds && ds.rows && ds.rows[0] && ds.rows[0][0]) {
              try {
                var p = JSON.parse(ds.rows[0][0]);
                prog.xp = p.xp||0; prog.level = p.level||1;
                prog.badges = p.badges||[]; prog.streak = p.streak||0;
                prog.lastDate = p.lastDate||null; prog.xpLog = p.xpLog||[];
                prog.sessionBadges = [];
              } catch(e){}
              updateStreak();
              updateXPBar();
              renderBadgesPanel();
            }
          }).catch(function(){});
        }
      } catch(e){}
    }

    function updateStreak() {
      var today = new Date().toISOString().slice(0,10);
      if (!prog.lastDate) { prog.streak = 1; prog.lastDate = today; return; }
      if (prog.lastDate === today) return;
      var last = new Date(prog.lastDate);
      var diff = Math.round((new Date(today) - last) / 86400000);
      if (diff === 1) {
        prog.streak++;
        var milestones = [3,7,14,30];
        if (milestones.indexOf(prog.streak) >= 0) {
          window.showToast && window.showToast(prog.streak + '-day streak! Keep it up.', 'success');
        }
      } else {
        prog.streak = 1;
      }
      prog.lastDate = today;
    }

    function getLevelForXP(xp) {
      var lvl = LEVELS[0];
      for (var i = 0; i < LEVELS.length; i++) {
        if (xp >= LEVELS[i].xp) lvl = LEVELS[i];
        else break;
      }
      return lvl;
    }

    function getNextLevel(lvl) {
      for (var i = 0; i < LEVELS.length; i++) {
        if (LEVELS[i].n === lvl.n + 1) return LEVELS[i];
      }
      return null;
    }

    function addXP(eventKey, amount) { return; }

    function showLevelUp(lvl) {
      var overlay = document.getElementById('levelup-overlay');
      var titleEl = document.getElementById('levelup-title');
      var subEl = document.getElementById('levelup-sub');
      if (!overlay) return;
      if (titleEl) titleEl.textContent = 'Level Up! Level ' + lvl.n;
      if (subEl) subEl.textContent = 'You are now Level ' + lvl.n + ' - ' + lvl.title;
      overlay.classList.add('show');
      setTimeout(function() { overlay.classList.remove('show'); }, 2600);
    }

    function awardBadge(id) {
      if (prog.badges.indexOf(id) >= 0) return;
      prog.badges.push(id);
      prog.sessionBadges.push(id);
      var badge = BADGES.find(function(b){ return b.id === id; });
      if (badge) {
        window.showToast && window.showToast('Badge: ' + badge.label + ' - ' + badge.desc, 'success');
      }
      renderBadgesPanel();
      saveXP();
    }

    function updateXPBar() {
      var lvl = getLevelForXP(prog.xp);
      var next = getNextLevel(lvl);
      var badge = document.getElementById('xp-level-badge');
      var fill = document.getElementById('xp-progress-fill');
      var count = document.getElementById('xp-count-label');
      if (badge) badge.textContent = lvl.title;
      if (fill) {
        var pct = next ? Math.min(100, Math.round((prog.xp - lvl.xp) / (next.xp - lvl.xp) * 100)) : 100;
        fill.style.width = pct + '%';
      }
      if (count) count.textContent = prog.xp.toLocaleString() + ' XP' + (prog.streak > 1 ? ' - ' + prog.streak + 'd' : '');
    }

    function renderBadgesPanel() {
      var list = document.getElementById('badges-list');
      if (!list) return;
      list.innerHTML = BADGES.map(function(b) {
        var earned = prog.badges.indexOf(b.id) >= 0;
        return '<div class="badge-item' + (earned ? ' earned' : '') + '">' +
          '<div class="badge-icon">' + (earned ? '&#x2605;' : '&#x25CB;') + '</div>' +
          '<div class="badge-info">' +
          '<div class="badge-label">' + b.label + '</div>' +
          '<div class="badge-desc">' + b.desc + '</div>' +
          '</div></div>';
      }).join('');
    }

    // Event hooks
    document.addEventListener('dataglow:dataset-loaded', function(e) {
      addXP('load_dataset');
      awardBadge('first_light');
      updateStreak();
      var ds = e.detail && (e.detail.dataset || e.detail);
      if (ds && ds.score >= 90) addXP('quality_90');
      if (ds && ds.score >= 100) awardBadge('perfectionist');
      var hasIssue = ds && ds.findings && ds.findings.length > 0 && ds.score < 80;
      if (hasIssue) awardBadge('data_detective');
    });

    // SQL
    var sqlRunBtn = document.getElementById('sql-view-run') || document.getElementById('sql-run');
    if (sqlRunBtn) sqlRunBtn.addEventListener('click', function() {
      addXP('run_sql'); awardBadge('sql_initiate'); sessionUsed.sql = true; checkPolyglot();
    });

    // Charts
    document.addEventListener('dataglow:chart-rendered', function() { addXP('build_chart'); awardBadge('chart_maker'); });
    var chartsPill = document.querySelector('[data-panel="charts-view"]');
    if (chartsPill) chartsPill.addEventListener('click', function() { addXP('build_chart'); awardBadge('chart_maker'); });

    // Python
    var pyRunBtn = document.getElementById('py-view-run') || document.getElementById('py-run');
    if (pyRunBtn) pyRunBtn.addEventListener('click', function() {
      addXP('run_python'); awardBadge('py_starter'); sessionUsed.python = true; checkPolyglot();
    });

    // R
    var rRunBtn = document.getElementById('r-run-btn') || document.querySelector('.r-run-btn');
    if (rRunBtn) rRunBtn.addEventListener('click', function() {
      addXP('run_r'); sessionUsed.r = true; checkPolyglot();
    });

    // Stats
    var corrBtn = document.getElementById('stats-run-corr') || document.querySelector('[data-stats="corr"]');
    if (corrBtn) corrBtn.addEventListener('click', function() { addXP('run_correlation'); statsDone.corr=true; checkStats(); });
    var regRunBtn = document.getElementById('stats-reg-run');
    if (regRunBtn) regRunBtn.addEventListener('click', function() { addXP('run_regression'); statsDone.reg=true; checkStats(); });
    var hypRunBtn = document.getElementById('stats-hyp-run');
    if (hypRunBtn) hypRunBtn.addEventListener('click', function() { addXP('run_hypothesis'); statsDone.hyp=true; checkStats(); });
    var chiRunBtn = document.getElementById('stats-chi-run');
    if (chiRunBtn) chiRunBtn.addEventListener('click', function() { addXP('run_hypothesis'); statsDone.hyp=true; checkStats(); });

    // Dojo
    var dojoCount = 0;
    var dojoRunBtn = document.getElementById('dojo-run-btn') || document.querySelector('.dojo-run-btn');
    if (dojoRunBtn) dojoRunBtn.addEventListener('click', function() {
      addXP('use_dojo'); dojoCount++;
      if (dojoCount >= 3) awardBadge('dojo_student');
    });

    // Arena
    var arenaRunBoth = document.getElementById('arena-run-both');
    if (arenaRunBoth) arenaRunBoth.addEventListener('click', function() { addXP('use_arena'); awardBadge('arena_champ'); });

    // Excel
    var excelPill = document.querySelector('[data-panel="excel-view"]');
    if (excelPill) excelPill.addEventListener('click', function() { addXP('use_excel'); });

    // Skill unlock XP bonus
    document.addEventListener('dataglow:skill-unlocked', function() { addXP('skill_unlock'); });

    function checkPolyglot() {
      if (sessionUsed.sql && sessionUsed.python && sessionUsed.r) awardBadge('polyglot');
    }
    function checkStats() {
      if (statsDone.corr && statsDone.reg && statsDone.hyp) awardBadge('stats_explorer');
    }

    // Panel open/close
    var badgesPanel = document.getElementById('badges-panel');
    var badgesTrigger = document.getElementById('badges-trigger-btn');
    var badgesClose = document.getElementById('badges-close-btn');
    if (badgesTrigger) badgesTrigger.addEventListener('click', function() {
      if (badgesPanel) { badgesPanel.classList.toggle('open'); renderBadgesPanel(); }
    });
    if (badgesClose) badgesClose.addEventListener('click', function() {
      if (badgesPanel) badgesPanel.classList.remove('open');
    });

    // Expose
    window.LevelSystem = { addXP: addXP, awardBadge: awardBadge, prog: prog };

    // Load saved XP on start
    setTimeout(loadXP, 600);
    setTimeout(updateXPBar, 800);
