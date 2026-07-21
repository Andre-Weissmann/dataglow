#!/usr/bin/env python3
"""
Sprint 4: Digital Twin / Simulation + Drift + Glow Canvas + Anomaly + Relational Validators
+ Glow Orb + Glow Signal + Semantic Drift Watchdog flag
21 files, ~4,500 lines recovered in one injection pass.
"""
import re, sys

BUNDLE = 'src/js/bundle.js'

def read(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()

def strip_es(src):
    src = re.sub(r'\bexport\s*\{[^}]*\};?', '', src, flags=re.DOTALL)
    src = re.sub(
        r'\bexport\s+(async\s+)?(function|const|let|var|class)\b',
        lambda m: (m.group(1) or '') + m.group(2), src)
    src = re.sub(r'\bexport\s+default\b', '', src)
    lines = src.split('\n')
    out = []
    in_import = False
    for line in lines:
        s = line.lstrip()
        if re.match(r'^import\s+', s):
            out.append('// [stripped import] ' + line.rstrip())
            if '{' in line and '}' not in line:
                in_import = True
            continue
        if in_import:
            out.append('// ' + line.rstrip())
            if '}' in line:
                in_import = False
            continue
        out.append(line)
    return '\n'.join(out)

def r(name):
    return strip_es(read(f'/tmp/s4_{name}'))

EL_SHIM = """
  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };
"""

# ─────────────────────────────────────────────────────────────────────────────
# SIMULATION / DIGITAL TWIN CLUSTER
# time-travel-diff -> digital-twin -> sandbox-twin -> time-machine
# ─────────────────────────────────────────────────────────────────────────────
SIMULATION_BLOCK = """
/* ================================================================
   SIMULATION / DIGITAL TWIN CLUSTER -- recovered from git history
   js/simulation/: digital-twin, sandbox-twin, time-machine, time-travel-diff
   Zero external deps (validation.js refs stripped to local fallbacks)
   ================================================================ */

/* ---- from js/simulation/time-travel-diff.js ---- */
;(function(){
  'use strict';
  // computeDistributionFingerprint / compareDistributions -- fallbacks
  var computeDistributionFingerprint = function(rows, col) {
    var vals = rows.map(function(r){ return r[col]; }).filter(function(v){ return v!=null; });
    var sorted = vals.slice().sort();
    return { col: col, count: vals.length, sample: sorted.slice(0,5) };
  };
  var compareDistributions = function(a, b) {
    return { changed: a.count !== b.count, deltaCount: b.count - a.count };
  };
""" + r('time-travel-diff.js') + """
  window.TimeTravelDiff = {
    diffRows: typeof diffRows !== 'undefined' ? diffRows : null,
    detectKeyColumn: typeof detectKeyColumn !== 'undefined' ? detectKeyColumn : null,
    buildTimeTravelSummary: typeof buildTimeTravelSummary !== 'undefined' ? buildTimeTravelSummary : null,
  };
}());
/* ---- end time-travel-diff.js ---- */

/* ---- from js/simulation/digital-twin.js ---- */
;(function(){
  'use strict';
""" + r('digital-twin.js') + """
  window.DigitalTwin = {
    perturbRows: typeof perturbRows !== 'undefined' ? perturbRows : null,
    buildTwinConfig: typeof buildTwinConfig !== 'undefined' ? buildTwinConfig : null,
    runDigitalTwin: typeof runDigitalTwin !== 'undefined' ? runDigitalTwin : null,
    PERTURBATION_TYPES: typeof PERTURBATION_TYPES !== 'undefined' ? PERTURBATION_TYPES : [],
  };
}());
/* ---- end digital-twin.js ---- */

/* ---- from js/simulation/sandbox-twin.js ---- */
;(function(){
  'use strict';
  var _dt = window.DigitalTwin || {};
  var perturbRows = _dt.perturbRows || function(rows){ return rows; };
  var _ttd = window.TimeTravelDiff || {};
  var diffRows = _ttd.diffRows || null;
  var detectKeyColumn = _ttd.detectKeyColumn || null;
""" + r('sandbox-twin.js') + """
  window.SandboxTwin = {
    mountSandboxTwin: typeof mountSandboxTwin !== 'undefined' ? mountSandboxTwin : null,
    runSandboxExperiment: typeof runSandboxExperiment !== 'undefined' ? runSandboxExperiment : null,
  };
}());
/* ---- end sandbox-twin.js ---- */

/* ---- from js/simulation/time-machine.js ---- */
;(function(){
  'use strict';
  var _ttd = window.TimeTravelDiff || {};
  var diffRows = _ttd.diffRows || null;
  var detectKeyColumn = _ttd.detectKeyColumn || null;
  var buildTimeTravelSummary = _ttd.buildTimeTravelSummary || null;
""" + r('time-machine.js') + """
  window.TimeMachine = {
    mountTimeMachine: typeof mountTimeMachine !== 'undefined' ? mountTimeMachine : null,
    buildTimeline: typeof buildTimeline !== 'undefined' ? buildTimeline : null,
    snapshotDataset: typeof snapshotDataset !== 'undefined' ? snapshotDataset : null,
  };

  // Wire into overflow grid + mobile tools sheet
  function initSimUI() {
    var panelId = 'dg-simulation-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:480px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:863;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }
    function toggle() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block'; p.innerHTML = '';
        var cx = document.createElement('button');
        cx.textContent = '\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;';
        cx.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(cx);
        if (typeof mountTimeMachine === 'function') {
          mountTimeMachine({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else if (typeof mountSandboxTwin === 'function') {
          mountSandboxTwin({ host: p });
        } else {
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';
          msg.textContent = 'Digital Twin + Time Machine: snapshot datasets, run counterfactual experiments, and travel through data history.';
          p.appendChild(msg);
        }
      } else { p.style.display = 'none'; }
    }
    ['dg-overflow-grid','dg-tools-sheet-grid'].forEach(function(gridId, i) {
      var grid = document.getElementById(gridId);
      var btnId = i === 0 ? 'dg-ov-digitaltwin' : 'dg-ts-digitaltwin';
      if (grid && !document.getElementById(btnId)) {
        var btn = document.createElement('button');
        btn.id = btnId;
        btn.className = 'dg-ov-btn';
        btn.innerHTML = '\uD83E\uDDE0<br><span>Twin</span>';
        btn.addEventListener('click', function(){
          if (i === 0) { ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){ var e=document.getElementById(id); if(e) e.classList.remove('open'); }); }
          else { var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open'); }
          toggle();
        });
        grid.appendChild(btn);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSimUI);
  else setTimeout(initSimUI, 1100);
}());
/* ---- end time-machine.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# DRIFT CLUSTER
# dataset-differ -> drift-forecast -> drift-watchdog -> freshness-decay
# ─────────────────────────────────────────────────────────────────────────────
DRIFT_BLOCK = """
/* ================================================================
   DRIFT CLUSTER -- recovered from git history
   js/drift/ + js/ambient/drift-watchdog.js
   PR #218 enabled semanticDriftWatchdog flag
   ================================================================ */

/* ---- from js/drift/dataset-differ.js ---- */
;(function(){
  'use strict';
""" + r('dataset-differ.js') + """
  window.DatasetDiffer = {
    diffDatasets: typeof diffDatasets !== 'undefined' ? diffDatasets : null,
    buildDriftSummary: typeof buildDriftSummary !== 'undefined' ? buildDriftSummary : null,
    computeColumnStats: typeof computeColumnStats !== 'undefined' ? computeColumnStats : null,
    DRIFT_SEVERITY: typeof DRIFT_SEVERITY !== 'undefined' ? DRIFT_SEVERITY : {},
  };
}());
/* ---- end dataset-differ.js ---- */

/* ---- from js/drift/drift-forecast.js ---- */
;(function(){
  'use strict';
  var _dd = window.DatasetDiffer || {};
  var diffDatasets = _dd.diffDatasets || null;
  var DRIFT_SEVERITY = _dd.DRIFT_SEVERITY || {};
""" + r('drift-forecast.js') + """
  window.DriftForecast = {
    forecastDrift: typeof forecastDrift !== 'undefined' ? forecastDrift : null,
    buildForecastReport: typeof buildForecastReport !== 'undefined' ? buildForecastReport : null,
    formatStatValue: typeof formatStatValue !== 'undefined' ? formatStatValue : null,
    MIN_FORECAST_HISTORY: typeof MIN_FORECAST_HISTORY !== 'undefined' ? MIN_FORECAST_HISTORY : 3,
  };
}());
/* ---- end drift-forecast.js ---- */

/* ---- from js/drift/freshness-decay.js ---- */
;(function(){
  'use strict';
  // getRulepack fallback -- rulepacks not yet in this build
  var getRulepack = function(name) { return { name: name, rules: [] }; };
  var _dd = window.DatasetDiffer || {};
  var DRIFT_SEVERITY = _dd.DRIFT_SEVERITY || {};
""" + r('freshness-decay.js') + """
  window.FreshnessDecay = {
    computeFreshnessScore: typeof computeFreshnessScore !== 'undefined' ? computeFreshnessScore : null,
    buildFreshnessReport: typeof buildFreshnessReport !== 'undefined' ? buildFreshnessReport : null,
    FRESHNESS_DECAY_TABLE: typeof FRESHNESS_DECAY_TABLE !== 'undefined' ? FRESHNESS_DECAY_TABLE : {},
  };
}());
/* ---- end freshness-decay.js ---- */

/* ---- from js/ambient/drift-watchdog.js ---- */
;(function(){
  'use strict';
  var _dd = window.DatasetDiffer || {};
  var diffDatasets = _dd.diffDatasets || null;
  var buildDriftSummary = _dd.buildDriftSummary || null;
  var _df = window.DriftForecast || {};
  var forecastDrift = _df.forecastDrift || null;
""" + r('drift-watchdog.js') + """
  window.DriftWatchdog = {
    startDriftWatchdog: typeof startDriftWatchdog !== 'undefined' ? startDriftWatchdog : null,
    stopDriftWatchdog: typeof stopDriftWatchdog !== 'undefined' ? stopDriftWatchdog : null,
    getDriftStatus: typeof getDriftStatus !== 'undefined' ? getDriftStatus : null,
  };

  // Wire into overflow grid
  function initDriftUI() {
    ['dg-overflow-grid','dg-tools-sheet-grid'].forEach(function(gridId, i) {
      var grid = document.getElementById(gridId);
      var btnId = i === 0 ? 'dg-ov-driftwatchdog' : 'dg-ts-driftwatchdog';
      if (grid && !document.getElementById(btnId)) {
        var btn = document.createElement('button');
        btn.id = btnId;
        btn.className = 'dg-ov-btn';
        btn.innerHTML = '\uD83D\uDCA7<br><span>Drift</span>';
        btn.title = 'Semantic Drift Watchdog: monitors schema and value distribution shifts between dataset versions';
        btn.addEventListener('click', function(){
          if (i === 0) { ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){ var e=document.getElementById(id); if(e) e.classList.remove('open'); }); }
          else { var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open'); }
          if (typeof showToast === 'function') showToast('Drift Watchdog active. Load two datasets to compare distributions.', 'info');
          var status = typeof getDriftStatus === 'function' ? getDriftStatus() : null;
          if (status) { if (typeof showToast === 'function') showToast(JSON.stringify(status, null, 2), 'info'); }
        });
        grid.appendChild(btn);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDriftUI);
  else setTimeout(initDriftUI, 1150);
}());
/* ---- end drift-watchdog.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# GLOW CANVAS + VISUALIZE RUNTIME
# visualize -> glow-canvas
# ─────────────────────────────────────────────────────────────────────────────
GLOW_CANVAS_BLOCK = """
/* ================================================================
   GLOW CANVAS + VISUALIZE RUNTIME -- recovered from git history
   js/runtimes-viz/: visualize.js, glow-canvas.js
   PR #93 (OneCanvas Phase 1) -- verification layer for analyses
   Deps: el() shim (already in bundle), engine/state stripped to fallbacks
   ================================================================ */

/* ---- from js/runtimes-viz/visualize.js ---- */
;(function(){
  'use strict';
  // engine + state stubs (DuckDB lives in wasm worker -- not re-injected here)
  var engine = { query: function(sql){ return Promise.resolve({ rows: [], columns: [] }); } };
  var state = window._dgState || {};
""" + r('visualize.js') + """
  window.DataGlowVisualize = {
    buildVizSpec: typeof buildVizSpec !== 'undefined' ? buildVizSpec : null,
    renderVisualization: typeof renderVisualization !== 'undefined' ? renderVisualization : null,
    VIZ_TYPES: typeof VIZ_TYPES !== 'undefined' ? VIZ_TYPES : [],
  };
}());
/* ---- end visualize.js ---- */

/* ---- from js/runtimes-viz/glow-canvas.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + """
  var viz = window.DataGlowVisualize || {};
  var buildVizSpec = viz.buildVizSpec || null;
  var renderVisualization = viz.renderVisualization || null;
  var VIZ_TYPES = viz.VIZ_TYPES || [];
""" + r('glow-canvas.js') + """
  window.GlowCanvas = {
    mountGlowCanvas: typeof mountGlowCanvas !== 'undefined' ? mountGlowCanvas : null,
    buildCanvasSpec: typeof buildCanvasSpec !== 'undefined' ? buildCanvasSpec : null,
    renderGlowCanvas: typeof renderGlowCanvas !== 'undefined' ? renderGlowCanvas : null,
  };

  function initGlowCanvasUI() {
    var panelId = 'dg-glowcanvas-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:520px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:864;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }
    function toggle() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block'; p.innerHTML = '';
        var cx = document.createElement('button');
        cx.textContent = '\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;';
        cx.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(cx);
        if (typeof mountGlowCanvas === 'function') {
          mountGlowCanvas({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else {
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';
          msg.textContent = 'Glow Canvas: visual verification layer for analysis outputs. Charts, distributions, and audit trails.';
          p.appendChild(msg);
        }
      } else { p.style.display = 'none'; }
    }
    ['dg-overflow-grid','dg-tools-sheet-grid'].forEach(function(gridId, i) {
      var grid = document.getElementById(gridId);
      var btnId = i === 0 ? 'dg-ov-glowcanvas' : 'dg-ts-glowcanvas';
      if (grid && !document.getElementById(btnId)) {
        var btn = document.createElement('button');
        btn.id = btnId;
        btn.className = 'dg-ov-btn';
        btn.innerHTML = '\uD83D\uDCA1<br><span>Canvas</span>';
        btn.addEventListener('click', function(){
          if (i === 0) { ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){ var e=document.getElementById(id); if(e) e.classList.remove('open'); }); }
          else { var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open'); }
          toggle();
        });
        grid.appendChild(btn);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGlowCanvasUI);
  else setTimeout(initGlowCanvasUI, 1200);
}());
/* ---- end glow-canvas.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# GLOW SIGNAL + GLOW ORB UI
# ─────────────────────────────────────────────────────────────────────────────
GLOW_ORB_BLOCK = """
/* ================================================================
   GLOW SIGNAL + GLOW ORB UI -- recovered from git history
   js/glow/: glow-signal.js, glow-orb-ui.js
   Ambient confidence visualization layer
   ================================================================ */

/* ---- from js/glow/glow-signal.js ---- */
;(function(){
  'use strict';
""" + r('glow-signal.js') + """
  window.GlowSignal = {
    computeGlowSignal: typeof computeGlowSignal !== 'undefined' ? computeGlowSignal : null,
    explainGlowSignal: typeof explainGlowSignal !== 'undefined' ? explainGlowSignal : null,
    GLOW_LEVELS: typeof GLOW_LEVELS !== 'undefined' ? GLOW_LEVELS : [],
    GLOW_THRESHOLDS: typeof GLOW_THRESHOLDS !== 'undefined' ? GLOW_THRESHOLDS : {},
  };
}());
/* ---- end glow-signal.js ---- */

/* ---- from js/glow/glow-orb-ui.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + """
  var explainGlowSignal = (window.GlowSignal || {}).explainGlowSignal;
  var computeGlowSignal = (window.GlowSignal || {}).computeGlowSignal;
""" + r('glow-orb-ui.js') + """
  window.GlowOrbUI = {
    mountGlowOrb: typeof mountGlowOrb !== 'undefined' ? mountGlowOrb : null,
    updateGlowOrb: typeof updateGlowOrb !== 'undefined' ? updateGlowOrb : null,
  };

  // Auto-mount orb into header if slot exists
  function initGlowOrb() {
    var slot = document.getElementById('dg-glow-orb-slot');
    if (slot && typeof mountGlowOrb === 'function') {
      mountGlowOrb({ host: slot });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGlowOrb);
  else setTimeout(initGlowOrb, 1250);
}());
/* ---- end glow-orb-ui.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# ANOMALY CLUSTER
# entity-baseline -> isolation-forest -> spc-control -> active-learning -> predictive-anomaly
# ─────────────────────────────────────────────────────────────────────────────
ANOMALY_BLOCK = """
/* ================================================================
   ANOMALY DETECTION CLUSTER -- recovered from git history
   js/anomaly/: entity-baseline, isolation-forest, spc-control,
                active-learning, predictive-anomaly
   Zero external deps -- pure statistical engines
   ================================================================ */

/* ---- from js/anomaly/entity-baseline.js ---- */
;(function(){
  'use strict';
""" + r('entity-baseline.js') + """
  window.EntityBaseline = {
    buildEntityBaseline: typeof buildEntityBaseline !== 'undefined' ? buildEntityBaseline : null,
    detectEntityAnomalies: typeof detectEntityAnomalies !== 'undefined' ? detectEntityAnomalies : null,
  };
}());
/* ---- end entity-baseline.js ---- */

/* ---- from js/anomaly/isolation-forest.js ---- */
;(function(){
  'use strict';
""" + r('isolation-forest.js') + """
  window.IsolationForest = {
    buildIsolationForest: typeof buildIsolationForest !== 'undefined' ? buildIsolationForest : null,
    scoreAnomalies: typeof scoreAnomalies !== 'undefined' ? scoreAnomalies : null,
    detectOutliers: typeof detectOutliers !== 'undefined' ? detectOutliers : null,
  };
}());
/* ---- end isolation-forest.js ---- */

/* ---- from js/anomaly/spc-control.js ---- */
;(function(){
  'use strict';
  // duckdb-engine stub (SPC works on raw row arrays primarily)
  var engine = { query: function(){ return Promise.resolve({ rows: [] }); } };
""" + r('spc-control.js') + """
  window.SPCControl = {
    computeControlChart: typeof computeControlChart !== 'undefined' ? computeControlChart : null,
    detectSPCViolations: typeof detectSPCViolations !== 'undefined' ? detectSPCViolations : null,
    SPC_RULES: typeof SPC_RULES !== 'undefined' ? SPC_RULES : [],
  };
}());
/* ---- end spc-control.js ---- */

/* ---- from js/anomaly/active-learning.js ---- */
;(function(){
  'use strict';
""" + r('active-learning.js') + """
  window.ActiveLearning = {
    selectActiveLearningCandidates: typeof selectActiveLearningCandidates !== 'undefined' ? selectActiveLearningCandidates : null,
    updateActiveLearningModel: typeof updateActiveLearningModel !== 'undefined' ? updateActiveLearningModel : null,
  };
}());
/* ---- end active-learning.js ---- */

/* ---- from js/anomaly/predictive-anomaly.js ---- */
;(function(){
  'use strict';
  var _if = window.IsolationForest || {};
  var buildIsolationForest = _if.buildIsolationForest || null;
  var scoreAnomalies = _if.scoreAnomalies || null;
  var _eb = window.EntityBaseline || {};
  var buildEntityBaseline = _eb.buildEntityBaseline || null;
  var detectEntityAnomalies = _eb.detectEntityAnomalies || null;
  var _al = window.ActiveLearning || {};
  var selectActiveLearningCandidates = _al.selectActiveLearningCandidates || null;
""" + r('predictive-anomaly.js') + """
  window.PredictiveAnomaly = {
    detectPredictiveAnomalies: typeof detectPredictiveAnomalies !== 'undefined' ? detectPredictiveAnomalies : null,
    buildAnomalyReport: typeof buildAnomalyReport !== 'undefined' ? buildAnomalyReport : null,
    ANOMALY_SEVERITY: typeof ANOMALY_SEVERITY !== 'undefined' ? ANOMALY_SEVERITY : {},
  };

  function initAnomalyUI() {
    var panelId = 'dg-anomaly-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:480px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:865;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }
    function toggle() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block'; p.innerHTML = '';
        var cx = document.createElement('button');
        cx.textContent = '\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;';
        cx.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(cx);
        var h = document.createElement('div');
        h.style.cssText = 'padding:20px;';
        h.innerHTML = '<h3 style="font-size:15px;font-weight:700;margin:0 0 8px;">Anomaly Detection</h3>' +
          '<p style="font-size:12px;color:var(--text-muted,#888);line-height:1.6;">Isolation Forest + SPC control charts + entity baseline + predictive drift. Load a dataset to detect statistical outliers.</p>';
        p.appendChild(h);
        // Auto-run on current dataset if available
        if (typeof detectPredictiveAnomalies === 'function' && window.dgGetCurrentDataset) {
          var ds = window.dgGetCurrentDataset();
          if (ds && ds.rows && ds.rows.length) {
            var report = buildAnomalyReport ? buildAnomalyReport(ds) : null;
            if (report) {
              var pre = document.createElement('pre');
              pre.style.cssText = 'padding:0 20px;font-size:11px;white-space:pre-wrap;';
              pre.textContent = JSON.stringify(report, null, 2);
              p.appendChild(pre);
            }
          }
        }
      } else { p.style.display = 'none'; }
    }
    ['dg-overflow-grid','dg-tools-sheet-grid'].forEach(function(gridId, i) {
      var grid = document.getElementById(gridId);
      var btnId = i === 0 ? 'dg-ov-anomaly' : 'dg-ts-anomaly';
      if (grid && !document.getElementById(btnId)) {
        var btn = document.createElement('button');
        btn.id = btnId;
        btn.className = 'dg-ov-btn';
        btn.innerHTML = '\uD83D\uDEA8<br><span>Anomaly</span>';
        btn.addEventListener('click', function(){
          if (i === 0) { ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){ var e=document.getElementById(id); if(e) e.classList.remove('open'); }); }
          else { var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open'); }
          toggle();
        });
        grid.appendChild(btn);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAnomalyUI);
  else setTimeout(initAnomalyUI, 1300);
}());
/* ---- end predictive-anomaly.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# RELATIONAL VALIDATORS
# All zero deps -- pure column-analysis engines
# ─────────────────────────────────────────────────────────────────────────────
RELATIONAL_BLOCK = """
/* ================================================================
   RELATIONAL VALIDATORS -- recovered from git history
   js/relational/: foreign-key, join-coverage, temporal-order, flag-consistency
   Zero external deps. Pure referential integrity checkers.
   ================================================================ */

/* ---- from js/relational/foreign-key-checker.js ---- */
;(function(){
  'use strict';
""" + r('foreign-key-checker.js') + """
  window.ForeignKeyChecker = {
    detectForeignKeyViolations: typeof detectForeignKeyViolations !== 'undefined' ? detectForeignKeyViolations : null,
    buildFKReport: typeof buildFKReport !== 'undefined' ? buildFKReport : null,
    suggestFKPairs: typeof suggestFKPairs !== 'undefined' ? suggestFKPairs : null,
  };
}());
/* ---- end foreign-key-checker.js ---- */

/* ---- from js/relational/join-coverage-checker.js ---- */
;(function(){
  'use strict';
  var _fk = window.ForeignKeyChecker || {};
  var detectForeignKeyViolations = _fk.detectForeignKeyViolations || null;
  var suggestFKPairs = _fk.suggestFKPairs || null;
""" + r('join-coverage-checker.js') + """
  window.JoinCoverageChecker = {
    checkJoinCoverage: typeof checkJoinCoverage !== 'undefined' ? checkJoinCoverage : null,
    buildJoinCoverageReport: typeof buildJoinCoverageReport !== 'undefined' ? buildJoinCoverageReport : null,
    JOIN_COVERAGE_LEVELS: typeof JOIN_COVERAGE_LEVELS !== 'undefined' ? JOIN_COVERAGE_LEVELS : {},
  };
}());
/* ---- end join-coverage-checker.js ---- */

/* ---- from js/relational/temporal-order-checker.js ---- */
;(function(){
  'use strict';
""" + r('temporal-order-checker.js') + """
  window.TemporalOrderChecker = {
    detectTemporalViolations: typeof detectTemporalViolations !== 'undefined' ? detectTemporalViolations : null,
    buildTemporalReport: typeof buildTemporalReport !== 'undefined' ? buildTemporalReport : null,
    TEMPORAL_RULES: typeof TEMPORAL_RULES !== 'undefined' ? TEMPORAL_RULES : [],
  };
}());
/* ---- end temporal-order-checker.js ---- */

/* ---- from js/relational/flag-consistency-checker.js ---- */
;(function(){
  'use strict';
""" + r('flag-consistency-checker.js') + """
  window.FlagConsistencyChecker = {
    detectFlagInconsistencies: typeof detectFlagInconsistencies !== 'undefined' ? detectFlagInconsistencies : null,
    buildFlagReport: typeof buildFlagReport !== 'undefined' ? buildFlagReport : null,
    FLAG_PATTERNS: typeof FLAG_PATTERNS !== 'undefined' ? FLAG_PATTERNS : [],
  };

  // Single "Relational" panel covering all 4 checkers
  function initRelationalUI() {
    var panelId = 'dg-relational-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:480px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:866;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }
    function toggle() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block'; p.innerHTML = '';
        var cx = document.createElement('button');
        cx.textContent = '\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;';
        cx.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(cx);
        var h = document.createElement('div');
        h.style.cssText = 'padding:20px;';
        h.innerHTML = '<h3 style="font-size:15px;font-weight:700;margin:0 0 8px;">Relational Validators</h3>' +
          '<p style="font-size:12px;color:var(--text-muted,#888);line-height:1.6;">Foreign key integrity, join coverage analysis, temporal ordering, and flag consistency checks.</p>';
        p.appendChild(h);
      } else { p.style.display = 'none'; }
    }
    ['dg-overflow-grid','dg-tools-sheet-grid'].forEach(function(gridId, i) {
      var grid = document.getElementById(gridId);
      var btnId = i === 0 ? 'dg-ov-relational' : 'dg-ts-relational';
      if (grid && !document.getElementById(btnId)) {
        var btn = document.createElement('button');
        btn.id = btnId;
        btn.className = 'dg-ov-btn';
        btn.innerHTML = '\uD83D\uDD17<br><span>Relational</span>';
        btn.addEventListener('click', function(){
          if (i === 0) { ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){ var e=document.getElementById(id); if(e) e.classList.remove('open'); }); }
          else { var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open'); }
          toggle();
        });
        grid.appendChild(btn);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initRelationalUI);
  else setTimeout(initRelationalUI, 1350);
}());
/* ---- end flag-consistency-checker.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# WRITE TO BUNDLE
# ─────────────────────────────────────────────────────────────────────────────
with open(BUNDLE, 'r') as f:
    content = f.read()

if 'IsolationForest' in content:
    print("Sprint 4 already injected.")
    sys.exit(0)

# Add feature flags
OLD_FLAG = '    ncciValidator: true,\n  };'
NEW_FLAGS = """    ncciValidator: true,
    digitalTwin: true,
    timeMachine: true,
    semanticDriftWatchdog: true,
    glowCanvas: true,
    glowOrb: true,
    anomalyDetection: true,
    isolationForest: true,
    spcControl: true,
    relationalValidators: true,
    foreignKeyChecker: true,
    joinCoverageChecker: true,
    temporalOrderChecker: true,
    flagConsistencyChecker: true,
  };"""
if OLD_FLAG in content:
    content = content.replace(OLD_FLAG, NEW_FLAGS)
    print("Sprint 4 flags added")
else:
    print("WARNING: flag end anchor not found")

content += (
    '\n' + SIMULATION_BLOCK +
    '\n' + DRIFT_BLOCK +
    '\n' + GLOW_CANVAS_BLOCK +
    '\n' + GLOW_ORB_BLOCK +
    '\n' + ANOMALY_BLOCK +
    '\n' + RELATIONAL_BLOCK
)

with open(BUNDLE, 'w', errors='replace') as f:
    f.write(content)

print(f"Sprint 4 injected into {BUNDLE}")
v = content
print(f"  DigitalTwin: {'DigitalTwin' in v}")
print(f"  TimeMachine: {'TimeMachine' in v}")
print(f"  DriftWatchdog: {'DriftWatchdog' in v}")
print(f"  GlowCanvas: {'GlowCanvas' in v}")
print(f"  IsolationForest: {'IsolationForest' in v}")
print(f"  ForeignKeyChecker: {'ForeignKeyChecker' in v}")
print(f"  semanticDriftWatchdog flag: {'semanticDriftWatchdog: true' in v}")
print(f"  Lines: {v.count(chr(10))}")
