#!/usr/bin/env python3
"""
Batch 3 recovery: Source Convergence (N-way truth reconciliation)
3 files, closed loop (engine + ingestion + ui only import from each other + el() which exists in bundle)
"""
import re, sys

BUNDLE = 'src/js/bundle.js'

def read(path):
    with open(path, 'r', errors='replace') as f:
        return f.read()

def strip_es_modules(src):
    """Strip all ES module import/export syntax."""
    # Multi-line export { ... } blocks
    src = re.sub(r'\bexport\s*\{[^}]*\};?', '', src, flags=re.DOTALL)
    # export keyword before declarations
    src = re.sub(
        r'\bexport\s+(async\s+)?(function|const|let|var|class)\b',
        lambda m: (m.group(1) or '') + m.group(2),
        src
    )
    # export default
    src = re.sub(r'\bexport\s+default\b', '', src)
    # import lines
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

sc_engine    = strip_es_modules(read('/tmp/sc-engine-clean.js'))
sc_ingestion = strip_es_modules(read('/tmp/sc-ingestion.js'))
sc_ui        = strip_es_modules(read('/tmp/sc-ui.js'))

SC_BLOCK = """
/* ================================================================
   SOURCE CONVERGENCE (Truth Network) -- recovered from git history
   PR #203 Batch 1 (engine), PR #204 Batch 2 (ingestion), PR #205 Batch 3 (UI)
   All 3 flag-promote PRs: #210, #211, #212 (all enabled:true)
   ================================================================ */

/* ---- from js/validation/source-convergence.js ---- */
;(function(){
  'use strict';

""" + sc_engine + """

  window.SourceConvergenceEngine = {
    DEFAULT_MARGIN_THRESHOLD: typeof DEFAULT_MARGIN_THRESHOLD !== 'undefined' ? DEFAULT_MARGIN_THRESHOLD : 0.15,
    canonicalizeKey: typeof canonicalizeKey !== 'undefined' ? canonicalizeKey : null,
    normalizeValue: typeof normalizeValue !== 'undefined' ? normalizeValue : null,
    buildConvergenceGraph: typeof buildConvergenceGraph !== 'undefined' ? buildConvergenceGraph : null,
    computeConvergenceClusters: typeof computeConvergenceClusters !== 'undefined' ? computeConvergenceClusters : null,
    resolveClusterWithTrust: typeof resolveClusterWithTrust !== 'undefined' ? resolveClusterWithTrust : null,
    summarizeConvergence: typeof summarizeConvergence !== 'undefined' ? summarizeConvergence : null,
  };
}());
/* ---- end source-convergence.js ---- */

/* ---- from js/validation/source-convergence-ingestion.js ---- */
;(function(){
  'use strict';

""" + sc_ingestion + """

  window.SourceConvergenceIngestion = {
    inferJoinKeys: typeof inferJoinKeys !== 'undefined' ? inferJoinKeys : null,
    assignDefaultTrust: typeof assignDefaultTrust !== 'undefined' ? assignDefaultTrust : null,
    adaptExcelWorkbook: typeof adaptExcelWorkbook !== 'undefined' ? adaptExcelWorkbook : null,
    adaptApiSource: typeof adaptApiSource !== 'undefined' ? adaptApiSource : null,
    adaptSiteExport: typeof adaptSiteExport !== 'undefined' ? adaptSiteExport : null,
    toEngineSources: typeof toEngineSources !== 'undefined' ? toEngineSources : null,
  };
}());
/* ---- end source-convergence-ingestion.js ---- */

/* ---- from js/validation/source-convergence-ui.js ---- */
;(function(){
  'use strict';

  // Alias engine deps from globals
  var _eng = window.SourceConvergenceEngine || {};
  var buildConvergenceGraph       = _eng.buildConvergenceGraph;
  var computeConvergenceClusters  = _eng.computeConvergenceClusters;
  var resolveClusterWithTrust     = _eng.resolveClusterWithTrust;
  var summarizeConvergence        = _eng.summarizeConvergence;
  var DEFAULT_MARGIN_THRESHOLD    = _eng.DEFAULT_MARGIN_THRESHOLD || 0.15;

  var _ing = window.SourceConvergenceIngestion || {};
  var adaptExcelWorkbook = _ing.adaptExcelWorkbook;
  var adaptApiSource     = _ing.adaptApiSource;
  var adaptSiteExport    = _ing.adaptSiteExport;
  var toEngineSources    = _ing.toEngineSources;

  // el() shim -- use existing bundle el() if present, else minimal fallback
  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };

""" + sc_ui + """

  window.SourceConvergenceUI = {
    shouldOfferConvergence: typeof shouldOfferConvergence !== 'undefined' ? shouldOfferConvergence : null,
    mountConvergence: typeof mountConvergence !== 'undefined' ? mountConvergence : null,
    buildConvergenceView: typeof buildConvergenceView !== 'undefined' ? buildConvergenceView : null,
  };

  // Auto-init: wire Source Convergence into overflow + mobile tools sheet
  function initConvergenceUI() {
    var panelId = 'dg-convergence-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:460px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:854;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }

    function toggleConvergence() {
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
        if (typeof mountConvergence === 'function') {
          mountConvergence({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else {
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';
          msg.textContent = 'Source Convergence: load two or more datasets to reconcile them into a unified truth network.';
          p.appendChild(msg);
        }
      } else {
        p.style.display = 'none';
      }
    }

    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-convergence')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-convergence';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\uD83D\\uDD03<br><span>Convergence</span>';
      btn.addEventListener('click', function(){
        var pop = document.getElementById('dg-overflow-popover');
        if (pop) pop.classList.remove('open');
        var ov2 = document.getElementById('dg-overflow-overlay');
        if (ov2) ov2.classList.remove('open');
        toggleConvergence();
      });
      ovGrid.appendChild(btn);
    }

    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-convergence')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-convergence';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\uD83D\\uDD03<br><span>Convergence</span>';
      btn2.addEventListener('click', function(){
        var sheet = document.getElementById('dg-tools-sheet');
        if (sheet) sheet.classList.remove('open');
        toggleConvergence();
      });
      tsGrid.appendChild(btn2);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initConvergenceUI);
  else setTimeout(initConvergenceUI, 600);
}());
/* ---- end source-convergence-ui.js ---- */
"""

with open(BUNDLE, 'r') as f:
    content = f.read()

if 'SourceConvergenceEngine' in content:
    print("Batch 3 already injected.")
    sys.exit(0)

# Add feature flag
OLD_FLAG = '    equityStratification: true,\n  };'
NEW_FLAG = '    equityStratification: true,\n    sourceConvergence: true,\n  };'
if OLD_FLAG in content:
    content = content.replace(OLD_FLAG, NEW_FLAG)
    print("sourceConvergence flag added")
else:
    print("WARNING: could not find flag end -- appending anyway")

content += '\n' + SC_BLOCK

with open(BUNDLE, 'w') as f:
    f.write(content)

print(f"Injected Source Convergence into {BUNDLE}")

with open(BUNDLE, 'r') as f:
    v = f.read()
print(f"  SourceConvergenceEngine: {'SourceConvergenceEngine' in v}")
print(f"  SourceConvergenceIngestion: {'SourceConvergenceIngestion' in v}")
print(f"  mountConvergence: {'mountConvergence' in v}")
print(f"  sourceConvergence flag: {'sourceConvergence: true' in v}")
print(f"  Lines: {v.count(chr(10))}")
