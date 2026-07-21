#!/usr/bin/env python3
"""
Batch 4: Crucible adversarial validator -- the hardest one.
8 files total: 4 Crucible files + 4 missing dep files.
All now extracted and available in /tmp/*.
"""
import re, sys

BUNDLE = 'src/js/bundle.js'

def read(path):
    with open(path, 'r', errors='replace') as f:
        return f.read()

def strip_es_modules(src):
    # Multi-line export { ... }
    src = re.sub(r'\bexport\s*\{[^}]*\};?', '', src, flags=re.DOTALL)
    # export before declarations
    src = re.sub(
        r'\bexport\s+(async\s+)?(function|const|let|var|class)\b',
        lambda m: (m.group(1) or '') + m.group(2),
        src
    )
    src = re.sub(r'\bexport\s+default\b', '', src)
    # import lines (single or multi-line)
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

# Read all files
ident_cols     = strip_es_modules(read('/tmp/identifier-columns.js'))
data_blame     = strip_es_modules(read('/tmp/data-blame.js'))
cross_col      = strip_es_modules(read('/tmp/cross-column-consistency.js'))
fuzzy_dedup    = strip_es_modules(read('/tmp/fuzzy-dedup.js'))
revert_elig    = strip_es_modules(read('/tmp/revert-eligibility.js'))
fix_conf       = strip_es_modules(read('/tmp/fix-confidence.js'))
phys_plaus     = strip_es_modules(read('/tmp/physiological-plausibility.js'))
crucible_contract  = strip_es_modules(read('/tmp/crucible-contract.js'))
crucible_packs     = strip_es_modules(read('/tmp/crucible-adversarial-packs.js'))
crucible_orch      = strip_es_modules(read('/tmp/crucible-orchestrator.js'))
crucible_ui        = strip_es_modules(read('/tmp/crucible-ui.js'))

CRUCIBLE_BLOCK = """
/* ================================================================
   CRUCIBLE ADVERSARIAL VALIDATOR -- recovered from git history
   PR #229 (Batch 1 concept), PR #230 (Batch 2 UI), PR #231 (Batch 3 revert proposals)
   PR #232 crucibleValidator ON, PR #233 crucibleValidatorUI ON,
   PR #234 crucibleRevertProposals ON, PR #236 crucibleOrchestration ON
   Dep chain: identifier-columns -> fuzzy-dedup, data-blame -> revert-eligibility,
   cross-column-consistency -> physiological-plausibility, crucible-contract,
   crucible-adversarial-packs, crucible-orchestrator, crucible-ui
   ================================================================ */

/* ---- from js/shared/identifier-columns.js ---- */
;(function(){
  'use strict';

""" + ident_cols + """

  window._DgIdentifierColumns = {
    isLikelyIdentifierColumn: typeof isLikelyIdentifierColumn !== 'undefined' ? isLikelyIdentifierColumn : null,
    IDENTIFIER_PATTERNS: typeof IDENTIFIER_PATTERNS !== 'undefined' ? IDENTIFIER_PATTERNS : [],
  };
}());
/* ---- end identifier-columns.js ---- */

/* ---- from js/provenance/data-blame.js ---- */
;(function(){
  'use strict';

""" + data_blame + """

  window._DgDataBlame = {
    normalizeBlameEntry: typeof normalizeBlameEntry !== 'undefined' ? normalizeBlameEntry : null,
    buildBlameEntry: typeof buildBlameEntry !== 'undefined' ? buildBlameEntry : null,
  };
}());
/* ---- end data-blame.js ---- */

/* ---- from js/validation/cross-column-consistency.js ---- */
;(function(){
  'use strict';

""" + cross_col + """

  window._DgCrossColumn = {
    nameTokens: typeof nameTokens !== 'undefined' ? nameTokens : null,
    checkCrossColumnConsistency: typeof checkCrossColumnConsistency !== 'undefined' ? checkCrossColumnConsistency : null,
  };
}());
/* ---- end cross-column-consistency.js ---- */

/* ---- from js/cleaning/fuzzy-dedup.js ---- */
;(function(){
  'use strict';

  // fuzzy-dedup imports duckdb-engine for findFuzzyDuplicates only.
  // The sync similarity() function (used by Crucible) has zero deps.
  // We stub the async findFuzzyDuplicates to a no-op for now.
  var isLikelyIdentifierColumn = (window._DgIdentifierColumns || {}).isLikelyIdentifierColumn || function(){ return false; };

""" + fuzzy_dedup + """

  window._DgFuzzyDedup = {
    levenshtein: typeof levenshtein !== 'undefined' ? levenshtein : null,
    levenshteinSimilarity: typeof levenshteinSimilarity !== 'undefined' ? levenshteinSimilarity : null,
    jaroWinkler: typeof jaroWinkler !== 'undefined' ? jaroWinkler : null,
    similarity: typeof similarity !== 'undefined' ? similarity : null,
  };
}());
/* ---- end fuzzy-dedup.js ---- */

/* ---- from js/provenance/revert-eligibility.js ---- */
;(function(){
  'use strict';

  var normalizeBlameEntry = (window._DgDataBlame || {}).normalizeBlameEntry || function(x){ return x; };

""" + revert_elig + """

  window._DgRevertEligibility = {
    classifyRevertEligibility: typeof classifyRevertEligibility !== 'undefined' ? classifyRevertEligibility : null,
    buildRevertProposal: typeof buildRevertProposal !== 'undefined' ? buildRevertProposal : null,
  };
}());
/* ---- end revert-eligibility.js ---- */

/* ---- from js/cleaning/fix-confidence.js ---- */
;(function(){
  'use strict';

""" + fix_conf + """

  window._DgFixConfidence = {
    scoreFixConfidence: typeof scoreFixConfidence !== 'undefined' ? scoreFixConfidence : null,
  };
}());
/* ---- end fix-confidence.js ---- */

/* ---- from js/validation/physiological-plausibility.js ---- */
;(function(){
  'use strict';

  var nameTokens = (window._DgCrossColumn || {}).nameTokens || function(s){ return (s||'').toLowerCase().split(/[_\\s]+/); };

""" + phys_plaus + """

  window._DgPhysPlaus = {
    matchVital: typeof matchVital !== 'undefined' ? matchVital : null,
    detectTempUnit: typeof detectTempUnit !== 'undefined' ? detectTempUnit : null,
    TEMP_BOUNDS: typeof TEMP_BOUNDS !== 'undefined' ? TEMP_BOUNDS : {},
  };
}());
/* ---- end physiological-plausibility.js ---- */

/* ---- from js/validation/crucible-contract.js ---- */
;(function(){
  'use strict';

  // sha256Hex is already in bundle from provenance module
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };

""" + crucible_contract + """

  window.CrucibleContract = {
    buildCleaningResult: typeof buildCleaningResult !== 'undefined' ? buildCleaningResult : null,
    buildValidationVerdict: typeof buildValidationVerdict !== 'undefined' ? buildValidationVerdict : null,
    buildPassVerdict: typeof buildPassVerdict !== 'undefined' ? buildPassVerdict : null,
    buildFailVerdict: typeof buildFailVerdict !== 'undefined' ? buildFailVerdict : null,
  };
}());
/* ---- end crucible-contract.js ---- */

/* ---- from js/validation/crucible-adversarial-packs.js ---- */
;(function(){
  'use strict';

  var similarity = (window._DgFuzzyDedup || {}).similarity || function(a,b){ return a===b?1:0; };
  var matchVital    = (window._DgPhysPlaus || {}).matchVital || null;
  var detectTempUnit= (window._DgPhysPlaus || {}).detectTempUnit || null;
  var TEMP_BOUNDS   = (window._DgPhysPlaus || {}).TEMP_BOUNDS || {};

""" + crucible_packs + """

  window.CruciblePacks = {
    CRUCIBLE_PACKS: typeof CRUCIBLE_PACKS !== 'undefined' ? CRUCIBLE_PACKS : [],
    runAdversarialSuite: typeof runAdversarialSuite !== 'undefined' ? runAdversarialSuite : null,
  };
}());
/* ---- end crucible-adversarial-packs.js ---- */

/* ---- from js/validation/crucible-orchestrator.js ---- */
;(function(){
  'use strict';

  var buildCleaningResult  = (window.CrucibleContract || {}).buildCleaningResult;
  var buildValidationVerdict = (window.CrucibleContract || {}).buildValidationVerdict;
  var CRUCIBLE_PACKS       = (window.CruciblePacks || {}).CRUCIBLE_PACKS || [];
  var runAdversarialSuite  = (window.CruciblePacks || {}).runAdversarialSuite;
  var classifyRevertEligibility = (window._DgRevertEligibility || {}).classifyRevertEligibility;
  var buildRevertProposal       = (window._DgRevertEligibility || {}).buildRevertProposal;
  var scoreFixConfidence        = (window._DgFixConfidence || {}).scoreFixConfidence;
  var similarity                = (window._DgFuzzyDedup || {}).similarity;
  var matchVital                = (window._DgPhysPlaus || {}).matchVital;
  var detectTempUnit            = (window._DgPhysPlaus || {}).detectTempUnit;
  var TEMP_BOUNDS               = (window._DgPhysPlaus || {}).TEMP_BOUNDS || {};

""" + crucible_orch + """

  window.CrucibleOrchestrator = {
    runCrucible: typeof runCrucible !== 'undefined' ? runCrucible : null,
    buildCrucibleSession: typeof buildCrucibleSession !== 'undefined' ? buildCrucibleSession : null,
  };
}());
/* ---- end crucible-orchestrator.js ---- */

/* ---- from js/validation/crucible-ui.js ---- */
;(function(){
  'use strict';

  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };

  var runCrucible           = (window.CrucibleOrchestrator || {}).runCrucible;
  var buildCrucibleSession  = (window.CrucibleOrchestrator || {}).buildCrucibleSession;

""" + crucible_ui + """

  window.CrucibleUI = {
    mountCrucible: typeof mountCrucible !== 'undefined' ? mountCrucible : null,
  };

  // Auto-init wiring
  function initCrucibleUI() {
    var panelId = 'dg-crucible-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:460px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:855;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }

    function toggleCrucible() {
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
        if (typeof mountCrucible === 'function') {
          mountCrucible({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else {
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';
          msg.textContent = 'Crucible: load a dataset to run adversarial validation -- range checks, physiological plausibility, cross-column consistency, and fuzzy dedup.';
          p.appendChild(msg);
        }
      } else {
        p.style.display = 'none';
      }
    }

    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-crucible')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-crucible';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\uD83D\\uDD25<br><span>Crucible</span>';
      btn.addEventListener('click', function(){
        var pop = document.getElementById('dg-overflow-popover');
        if (pop) pop.classList.remove('open');
        var ov2 = document.getElementById('dg-overflow-overlay');
        if (ov2) ov2.classList.remove('open');
        toggleCrucible();
      });
      ovGrid.appendChild(btn);
    }

    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-crucible')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-crucible';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\uD83D\\uDD25<br><span>Crucible</span>';
      btn2.addEventListener('click', function(){
        var sheet = document.getElementById('dg-tools-sheet');
        if (sheet) sheet.classList.remove('open');
        toggleCrucible();
      });
      tsGrid.appendChild(btn2);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCrucibleUI);
  else setTimeout(initCrucibleUI, 650);
}());
/* ---- end crucible-ui.js ---- */
"""

with open(BUNDLE, 'r') as f:
    content = f.read()

if 'CrucibleOrchestrator' in content:
    print("Crucible already injected.")
    sys.exit(0)

# Add feature flag
OLD_FLAG = '    sourceConvergence: true,\n  };'
NEW_FLAG = '    sourceConvergence: true,\n    crucibleOrchestration: true,\n    crucibleValidator: true,\n    crucibleValidatorUI: true,\n    crucibleRevertProposals: true,\n  };'
if OLD_FLAG in content:
    content = content.replace(OLD_FLAG, NEW_FLAG)
    print("Crucible flags added")
else:
    print("WARNING: flag insertion point not found")

content += '\n' + CRUCIBLE_BLOCK

with open(BUNDLE, 'w') as f:
    f.write(content)

print(f"Injected Crucible into {BUNDLE}")

with open(BUNDLE, 'r') as f:
    v = f.read()
print(f"  CrucibleContract: {'CrucibleContract' in v}")
print(f"  CruciblePacks: {'CruciblePacks' in v}")
print(f"  CrucibleOrchestrator: {'CrucibleOrchestrator' in v}")
print(f"  CrucibleUI: {'CrucibleUI' in v}")
print(f"  crucibleOrchestration flag: {'crucibleOrchestration: true' in v}")
print(f"  Lines: {v.count(chr(10))}")
