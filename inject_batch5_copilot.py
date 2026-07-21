#!/usr/bin/env python3
"""
Batch 5: Guarded Copilot + its 2 deps (readiness-gate, ai-touch-ledger).
sha256Hex already in bundle. Zero further transitive deps.
"""
import re, sys

BUNDLE = 'src/js/bundle.js'

def read(path):
    with open(path, 'r', errors='replace') as f:
        return f.read()

def strip_es_modules(src):
    src = re.sub(r'\bexport\s*\{[^}]*\};?', '', src, flags=re.DOTALL)
    src = re.sub(
        r'\bexport\s+(async\s+)?(function|const|let|var|class)\b',
        lambda m: (m.group(1) or '') + m.group(2),
        src
    )
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

readiness_gate  = strip_es_modules(read('/tmp/readiness-gate.js'))
ai_touch_ledger = strip_es_modules(read('/tmp/ai-touch-ledger.js'))
guarded_copilot = strip_es_modules(read('/tmp/guarded-copilot.js'))

COPILOT_BLOCK = """
/* ================================================================
   GUARDED COPILOT -- recovered from git history
   PR #243 Batch 1, PR #245 Batch 2 (chat panel + Tier 2 model)
   PR #248 guardedCopilot flag promoted to ON
   PR #378 eval harness (20 cases)
   Deps: readiness-gate.js, ai-touch-ledger.js (sha256Hex already in bundle)
   ================================================================ */

/* ---- from js/gate/readiness-gate.js ---- */
;(function(){
  'use strict';

""" + readiness_gate + """

  window.ReadinessGate = {
    computeReadinessGate: typeof computeReadinessGate !== 'undefined' ? computeReadinessGate : null,
    explainGateReasons: typeof explainGateReasons !== 'undefined' ? explainGateReasons : null,
    GATE_REASONS: typeof GATE_REASONS !== 'undefined' ? GATE_REASONS : {},
  };
}());
/* ---- end readiness-gate.js ---- */

/* ---- from js/provenance/ai-touch-ledger.js ---- */
;(function(){
  'use strict';

  // sha256Hex already in bundle -- use it if exposed, else fallback
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };

""" + ai_touch_ledger + """

  window.AITouchLedger = {
    createTouchLedger: typeof createTouchLedger !== 'undefined' ? createTouchLedger : null,
    TOUCH_TYPES: typeof TOUCH_TYPES !== 'undefined' ? TOUCH_TYPES : {},
  };
}());
/* ---- end ai-touch-ledger.js ---- */

/* ---- from js/agents/guarded-copilot.js ---- */
;(function(){
  'use strict';

  var computeReadinessGate = (window.ReadinessGate || {}).computeReadinessGate;
  var explainGateReasons   = (window.ReadinessGate || {}).explainGateReasons;
  var createTouchLedger    = (window.AITouchLedger || {}).createTouchLedger;

""" + guarded_copilot + """

  window.GuardedCopilot = {
    createGuardedCopilot: typeof createGuardedCopilot !== 'undefined' ? createGuardedCopilot : null,
    COPILOT_MODES: typeof COPILOT_MODES !== 'undefined' ? COPILOT_MODES : {},
    mountGuardedCopilot: typeof mountGuardedCopilot !== 'undefined' ? mountGuardedCopilot : null,
  };

  // Auto-init wiring
  function initGuardedCopilotUI() {
    var panelId = 'dg-copilot-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:440px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:856;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }

    function toggleCopilot() {
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
        if (typeof mountGuardedCopilot === 'function') {
          mountGuardedCopilot({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else if (typeof createGuardedCopilot === 'function') {
          var copilot = createGuardedCopilot({});
          var h = document.createElement('div');
          h.style.cssText = 'padding:20px;';
          h.innerHTML = '<h3 style="font-size:15px;font-weight:700;margin:0 0 8px;">Guarded Copilot</h3><p style="font-size:12px;color:var(--text-muted,#888);line-height:1.6;">Read-only, lineage-citing AI chat. Every answer traces back to source data. Load a dataset to begin.</p>';
          p.appendChild(h);
        }
      } else {
        p.style.display = 'none';
      }
    }

    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-copilot')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-copilot';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\uD83E\\uDD16<br><span>Copilot</span>';
      btn.addEventListener('click', function(){
        var pop = document.getElementById('dg-overflow-popover');
        if (pop) pop.classList.remove('open');
        var ov2 = document.getElementById('dg-overflow-overlay');
        if (ov2) ov2.classList.remove('open');
        toggleCopilot();
      });
      ovGrid.appendChild(btn);
    }

    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-copilot')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-copilot';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\uD83E\\uDD16<br><span>Copilot</span>';
      btn2.addEventListener('click', function(){
        var sheet = document.getElementById('dg-tools-sheet');
        if (sheet) sheet.classList.remove('open');
        toggleCopilot();
      });
      tsGrid.appendChild(btn2);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGuardedCopilotUI);
  else setTimeout(initGuardedCopilotUI, 700);
}());
/* ---- end guarded-copilot.js ---- */
"""

with open(BUNDLE, 'r') as f:
    content = f.read()

if 'GuardedCopilot' in content:
    print("Guarded Copilot already injected.")
    sys.exit(0)

OLD_FLAG = '    crucibleRevertProposals: true,\n  };'
NEW_FLAG = '    crucibleRevertProposals: true,\n    guardedCopilot: true,\n    aiTouchLedger: true,\n  };'
if OLD_FLAG in content:
    content = content.replace(OLD_FLAG, NEW_FLAG)
    print("Guarded Copilot flags added")
else:
    print("WARNING: flag end not found")

content += '\n' + COPILOT_BLOCK

with open(BUNDLE, 'w') as f:
    f.write(content)

print(f"Injected Guarded Copilot into {BUNDLE}")

with open(BUNDLE, 'r') as f:
    v = f.read()
print(f"  ReadinessGate: {'ReadinessGate' in v}")
print(f"  AITouchLedger: {'AITouchLedger' in v}")
print(f"  GuardedCopilot: {'GuardedCopilot' in v}")
print(f"  guardedCopilot flag: {'guardedCopilot: true' in v}")
print(f"  Lines: {v.count(chr(10))}")
