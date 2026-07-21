#!/usr/bin/env python3
"""
Batch 2 recovery injection: AI Council + DVC + Equity Stratification
All three systems are self-contained (only import from each other).
Pattern: strip ES module syntax, wrap in IIFE, expose via window globals.
"""
import re, sys

BUNDLE = 'src/js/bundle.js'

def read(path):
    with open(path, 'r') as f:
        return f.read()

def strip_imports(src):
    """Remove top-level import/export lines, return cleaned source.
    Handles multi-line export { ... } blocks too."""
    # First pass: remove multi-line export { ... } blocks
    src = re.sub(r'\bexport\s*\{[^}]*\};?', '', src, flags=re.DOTALL)
    # Remove export keyword before function/const/let/var/async/class
    src = re.sub(
        r'\bexport\s+(async\s+)?(function|const|let|var|class)\b',
        lambda m: (m.group(1) or '') + m.group(2),
        src
    )
    # Remove export default
    src = re.sub(r'\bexport\s+default\b', '', src)

    lines = src.split('\n')
    out = []
    for line in lines:
        s = line.lstrip()
        if re.match(r'^import\s+', s):
            out.append('// [stripped import] ' + line.rstrip())
            continue
        out.append(line)
    return '\n'.join(out)

# ─────────────────────────────────────────────────────────────────────────────
# AI COUNCIL
# ─────────────────────────────────────────────────────────────────────────────
council_engine = strip_imports(read('/tmp/council-engine.js'))
council_ui     = strip_imports(read('/tmp/council-ui.js'))

COUNCIL_BLOCK = """
/* ================================================================
   AI COUNCIL — recovered from git history (commit 0662f76)
   PR #323 Phase 11, upgraded PR #326 (deep reasoning edition)
   ================================================================ */

/* ---- from js/council/council-engine.js ---- */
;(function(){
  'use strict';

""" + council_engine + """

  window.CouncilEngine = {
    COUNCIL_PROVIDERS: typeof COUNCIL_PROVIDERS !== 'undefined' ? COUNCIL_PROVIDERS : [],
    GOOGLE_ENDPOINT_BASE: typeof GOOGLE_ENDPOINT_BASE !== 'undefined' ? GOOGLE_ENDPOINT_BASE : '',
    resolveGoogleEndpoint: typeof resolveGoogleEndpoint !== 'undefined' ? resolveGoogleEndpoint : null,
    detectQuestionMode: typeof detectQuestionMode !== 'undefined' ? detectQuestionMode : null,
    detectDomain: typeof detectDomain !== 'undefined' ? detectDomain : null,
    buildCouncilPrompt: typeof buildCouncilPrompt !== 'undefined' ? buildCouncilPrompt : null,
    callProvider: typeof callProvider !== 'undefined' ? callProvider : null,
    parseAnswerSections: typeof parseAnswerSections !== 'undefined' ? parseAnswerSections : null,
    extractConfidenceLevel: typeof extractConfidenceLevel !== 'undefined' ? extractConfidenceLevel : null,
    scoreAlignment: typeof scoreAlignment !== 'undefined' ? scoreAlignment : null,
    synthesizeCouncil: typeof synthesizeCouncil !== 'undefined' ? synthesizeCouncil : null,
    runCouncil: typeof runCouncil !== 'undefined' ? runCouncil : null,
  };
}());
/* ---- end council-engine.js ---- */

/* ---- from js/council/council-ui.js ---- */
;(function(){
  'use strict';

  // Alias engine exports from global
  var _eng = window.CouncilEngine || {};
  var runCouncil = _eng.runCouncil;
  var COUNCIL_PROVIDERS = _eng.COUNCIL_PROVIDERS || [];
  var resolveGoogleEndpoint = _eng.resolveGoogleEndpoint;
  var detectQuestionMode = _eng.detectQuestionMode;
  var detectDomain = _eng.detectDomain;
  var parseAnswerSections = _eng.parseAnswerSections;
  var extractConfidenceLevel = _eng.extractConfidenceLevel;

""" + council_ui + """

  // Expose mount function
  window.CouncilUI = {
    mountCouncil: typeof mountCouncil !== 'undefined' ? mountCouncil : null,
    shouldOfferCouncil: typeof shouldOfferCouncil !== 'undefined' ? shouldOfferCouncil : null,
  };

  // Auto-init: wire Council button into overflow + tools sheet
  function initCouncilUI() {
    var panelId = 'dg-council-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:420px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:851;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      var closeX = document.createElement('button');
      closeX.textContent = '\\u00D7';
      closeX.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
      closeX.addEventListener('click', function(){ panel.style.display='none'; });
      panel.appendChild(closeX);
      document.body.appendChild(panel);
    }

    function toggleCouncil() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block';
        p.innerHTML = '';
        var closeX2 = document.createElement('button');
        closeX2.textContent = '\\u00D7';
        closeX2.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
        closeX2.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(closeX2);
        if (typeof mountCouncil === 'function') {
          mountCouncil({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else {
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;color:var(--text-muted,#888);font-size:13px;';
          msg.textContent = 'AI Council module not fully loaded.';
          p.appendChild(msg);
        }
      } else {
        p.style.display = 'none';
      }
    }

    // Desktop overflow grid
    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-council')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-council';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\u2696\\uFE0F<br><span>AI Council</span>';
      btn.addEventListener('click', function(){
        var pop = document.getElementById('dg-overflow-popover');
        if (pop) pop.classList.remove('open');
        var ov2 = document.getElementById('dg-overflow-overlay');
        if (ov2) ov2.classList.remove('open');
        toggleCouncil();
      });
      ovGrid.appendChild(btn);
    }

    // Mobile tools sheet
    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-council')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-council';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\u2696\\uFE0F<br><span>AI Council</span>';
      btn2.addEventListener('click', function(){
        var sheet = document.getElementById('dg-tools-sheet');
        if (sheet) sheet.classList.remove('open');
        var sheetOv = document.getElementById('dg-tools-sheet-overlay');
        if (sheetOv) sheetOv.classList.remove('open');
        toggleCouncil();
      });
      tsGrid.appendChild(btn2);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCouncilUI);
  else setTimeout(initCouncilUI, 450);
}());
/* ---- end council-ui.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# DVC
# ─────────────────────────────────────────────────────────────────────────────
dvc_store = strip_imports(read('/tmp/dvc-store.js'))
dvc_diff  = strip_imports(read('/tmp/dvc-diff.js'))
dvc_ui    = strip_imports(read('/tmp/dvc-ui.js'))

DVC_BLOCK = """
/* ================================================================
   DATA VERSION CONTROL (DVC) — recovered from git history
   PR #320 Phase 10, 115 tests
   ================================================================ */

/* ---- from js/dvc/dvc-store.js ---- */
;(function(){
  'use strict';

""" + dvc_store + """

  window.DVCStore = {
    dvcStore: typeof dvcStore !== 'undefined' ? dvcStore : null,
    statsFromDataset: typeof statsFromDataset !== 'undefined' ? statsFromDataset : null,
  };
}());
/* ---- end dvc-store.js ---- */

/* ---- from js/dvc/dvc-diff.js ---- */
;(function(){
  'use strict';

""" + dvc_diff + """

  window.DVCDiff = {
    diffSnapshots: typeof diffSnapshots !== 'undefined' ? diffSnapshots : null,
    diffToHTML: typeof diffToHTML !== 'undefined' ? diffToHTML : null,
    RISK: typeof RISK !== 'undefined' ? RISK : null,
  };
}());
/* ---- end dvc-diff.js ---- */

/* ---- from js/dvc/dvc-ui.js ---- */
;(function(){
  'use strict';

  // Alias deps from globals
  var _store = window.DVCStore || {};
  var _diff  = window.DVCDiff  || {};
  var dvcStore         = _store.dvcStore;
  var statsFromDataset = _store.statsFromDataset;
  var diffSnapshots    = _diff.diffSnapshots;
  var diffToHTML       = _diff.diffToHTML;
  var RISK             = _diff.RISK;

""" + dvc_ui + """

  window.DVCUI = {
    mountDVC: typeof mountDVC !== 'undefined' ? mountDVC : null,
    shouldOfferDVC: typeof shouldOfferDVC !== 'undefined' ? shouldOfferDVC : null,
  };

  // Auto-init: wire DVC button
  function initDVCUI() {
    var panelId = 'dg-dvc-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:420px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:852;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }

    function toggleDVC() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block';
        p.innerHTML = '';
        var closeX = document.createElement('button');
        closeX.textContent = '\\u00D7';
        closeX.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
        closeX.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(closeX);
        if (typeof mountDVC === 'function') {
          mountDVC({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        }
      } else {
        p.style.display = 'none';
      }
    }

    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-dvc')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-dvc';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\uD83D\\uDDC2\\uFE0F<br><span>DVC</span>';
      btn.addEventListener('click', function(){
        var pop = document.getElementById('dg-overflow-popover');
        if (pop) pop.classList.remove('open');
        var ov2 = document.getElementById('dg-overflow-overlay');
        if (ov2) ov2.classList.remove('open');
        toggleDVC();
      });
      ovGrid.appendChild(btn);
    }

    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-dvc')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-dvc';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\uD83D\\uDDC2\\uFE0F<br><span>DVC</span>';
      btn2.addEventListener('click', function(){
        var sheet = document.getElementById('dg-tools-sheet');
        if (sheet) sheet.classList.remove('open');
        toggleDVC();
      });
      tsGrid.appendChild(btn2);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDVCUI);
  else setTimeout(initDVCUI, 500);
}());
/* ---- end dvc-ui.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# EQUITY STRATIFICATION
# ─────────────────────────────────────────────────────────────────────────────
eq_detector   = strip_imports(read('/tmp/equity-detector.js'))
eq_scorer     = strip_imports(read('/tmp/disparity-scorer.js'))
eq_stratifier = strip_imports(read('/tmp/equity-stratifier.js'))
eq_attest     = strip_imports(read('/tmp/equity-attestation.js'))

EQUITY_BLOCK = """
/* ================================================================
   EQUITY STRATIFICATION LAYER — recovered from git history
   PR #310 Phase 3
   ================================================================ */

/* ---- from js/equity/disparity-scorer.js ---- */
;(function(){
  'use strict';

""" + eq_scorer + """

  window.DisparityScorer = {
    scoreDisparities: typeof scoreDisparities !== 'undefined' ? scoreDisparities : null,
    MIN_CELL_SIZE: typeof MIN_CELL_SIZE !== 'undefined' ? MIN_CELL_SIZE : 5,
  };
}());
/* ---- end disparity-scorer.js ---- */

/* ---- from js/equity/equity-detector.js ---- */
;(function(){
  'use strict';

  var _sc = window.DisparityScorer || {};
  var scoreDisparities = _sc.scoreDisparities;
  var MIN_CELL_SIZE    = _sc.MIN_CELL_SIZE || 5;

""" + eq_detector + """

  window.EquityDetector = {
    detectEquitySignals: typeof detectEquitySignals !== 'undefined' ? detectEquitySignals : null,
    PROTECTED_FIELDS: typeof PROTECTED_FIELDS !== 'undefined' ? PROTECTED_FIELDS : [],
  };
}());
/* ---- end equity-detector.js ---- */

/* ---- from js/equity/equity-stratifier.js ---- */
;(function(){
  'use strict';

  var _det = window.EquityDetector || {};
  var _sc  = window.DisparityScorer || {};
  var detectEquitySignals = _det.detectEquitySignals;
  var scoreDisparities    = _sc.scoreDisparities;

""" + eq_stratifier + """

  window.EquityStratifier = {
    stratifyEquity: typeof stratifyEquity !== 'undefined' ? stratifyEquity : null,
    buildEquitySummary: typeof buildEquitySummary !== 'undefined' ? buildEquitySummary : null,
  };
}());
/* ---- end equity-stratifier.js ---- */

/* ---- from js/equity/equity-attestation.js ---- */
;(function(){
  'use strict';

  var _strat = window.EquityStratifier || {};
  var _det   = window.EquityDetector || {};
  var stratifyEquity    = _strat.stratifyEquity;
  var buildEquitySummary = _strat.buildEquitySummary;
  var detectEquitySignals = _det.detectEquitySignals;

""" + eq_attest + """

  window.EquityAttestation = {
    buildEquityAttestation: typeof buildEquityAttestation !== 'undefined' ? buildEquityAttestation : null,
    mountEquityPanel: typeof mountEquityPanel !== 'undefined' ? mountEquityPanel : null,
    shouldOfferEquity: typeof shouldOfferEquity !== 'undefined' ? shouldOfferEquity : null,
  };

  // Auto-init: wire Equity button
  function initEquityUI() {
    var panelId = 'dg-equity-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:420px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:853;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }

    function toggleEquity() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block';
        p.innerHTML = '';
        var closeX = document.createElement('button');
        closeX.textContent = '\\u00D7';
        closeX.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
        closeX.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(closeX);
        if (typeof mountEquityPanel === 'function') {
          mountEquityPanel({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else {
          // Fallback summary panel
          var h = document.createElement('div');
          h.style.cssText = 'padding:20px;';
          h.innerHTML = '<h3 style="font-size:15px;font-weight:700;margin:0 0 8px;">Equity Stratification</h3><p style="font-size:12px;color:var(--text-muted,#888);line-height:1.6;">Load a dataset first. The equity layer will detect protected-class fields (race, gender, age, etc.) and score outcome disparities across strata automatically.</p>';
          p.appendChild(h);
        }
      } else {
        p.style.display = 'none';
      }
    }

    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-equity')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-equity';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\u2696\\uFE0F<br><span>Equity</span>';
      btn.addEventListener('click', function(){
        var pop = document.getElementById('dg-overflow-popover');
        if (pop) pop.classList.remove('open');
        var ov2 = document.getElementById('dg-overflow-overlay');
        if (ov2) ov2.classList.remove('open');
        toggleEquity();
      });
      ovGrid.appendChild(btn);
    }

    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-equity')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-equity';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\u2696\\uFE0F<br><span>Equity</span>';
      btn2.addEventListener('click', function(){
        var sheet = document.getElementById('dg-tools-sheet');
        if (sheet) sheet.classList.remove('open');
        toggleEquity();
      });
      tsGrid.appendChild(btn2);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEquityUI);
  else setTimeout(initEquityUI, 550);
}());
/* ---- end equity-attestation.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE FLAGS additions
# ─────────────────────────────────────────────────────────────────────────────
NEW_FLAGS = """
    aiCouncil: true,
    dataVersionControl: true,
    equityStratification: true,"""

# ─────────────────────────────────────────────────────────────────────────────
# Write to bundle
# ─────────────────────────────────────────────────────────────────────────────
with open(BUNDLE, 'r') as f:
    content = f.read()

if 'CouncilEngine' in content:
    print("Batch 2 already injected.")
    sys.exit(0)

# 1. Add feature flags
OLD_FLAG_END = '    meetingDecisionLedger: true\n  };'
NEW_FLAG_END = '    meetingDecisionLedger: true,' + NEW_FLAGS + '\n  };'
if OLD_FLAG_END in content:
    content = content.replace(OLD_FLAG_END, NEW_FLAG_END)
    print("Feature flags updated")
else:
    print("WARNING: could not find flag insertion point")

# 2. Append all three recovery blocks
content += '\n' + COUNCIL_BLOCK + '\n' + DVC_BLOCK + '\n' + EQUITY_BLOCK

with open(BUNDLE, 'w') as f:
    f.write(content)

print(f"Injected AI Council + DVC + Equity into {BUNDLE}")

# Verify
with open(BUNDLE, 'r') as f:
    v = f.read()
print(f"  CouncilEngine: {'CouncilEngine' in v}")
print(f"  DVCStore: {'DVCStore' in v}")
print(f"  EquityDetector: {'EquityDetector' in v}")
print(f"  aiCouncil flag: {'aiCouncil: true' in v}")
print(f"  Lines: {v.count(chr(10))}")
