#!/usr/bin/env python3
"""
Sprint 6: Drill Floor + Export + Learning + Rulepacks + Teaching +
          Provenance Extras II + Grades + Problem Framer + Cleaning +
          SQL Tools + Validation Deep Stack + Query Sentinel + Phi Guard
The final sweep -- clearing the bottom of the tree.
40 files, ~9,200 lines.
"""
import re, sys

BUNDLE = 'src/js/bundle.js'

def read(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()

def strip_es(src, keep_default=False):
    src = re.sub(r'\bexport\s*\{[^}]*\};?', '', src, flags=re.DOTALL)
    src = re.sub(
        r'\bexport\s+(async\s+)?(function|const|let|var|class)\b',
        lambda m: (m.group(1) or '') + m.group(2), src)
    if keep_default:
        src = re.sub(r'\bexport\s+default\b', 'var _defaultExport =', src)
    else:
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
    return strip_es(read(f'/tmp/s6_{name}'))

def rd(name):
    """Strip ES module syntax, converting export default to var _defaultExport."""
    return strip_es(read(f'/tmp/s6_{name}'), keep_default=True)

EL_SHIM = """
  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };
"""
ESC_SHIM = """
  var escapeHtml = (typeof window._dgEscapeHtml === 'function') ? window._dgEscapeHtml
    : function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
"""
SHA_SHIM = """
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };
"""
ENGINE_STUB = """
  var engine = { query: function(){ return Promise.resolve({ rows: [], columns: [] }); } };
  var state = window._dgState || {};
"""

def panel(panel_id, z, label, emoji, timeout, mount_fn, fallback, ov_id, ts_id):
    safe = ov_id.replace('-','_')
    return f"""
  function initUI_{safe}() {{
    var panelId = '{panel_id}';
    if (!document.getElementById(panelId)) {{
      var p = document.createElement('div');
      p.id = panelId;
      p.style.cssText = 'position:fixed;top:0;right:0;width:480px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:{z};overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(p);
    }}
    function toggle() {{
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {{
        p.style.display = 'block'; p.innerHTML = '';
        var cx = document.createElement('button');
        cx.textContent = '\\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;';
        cx.addEventListener('click', function(){{ p.style.display='none'; }});
        p.appendChild(cx);
        if (typeof {mount_fn} === 'function') {{
          {mount_fn}({{ host: p, onToast: function(m,t){{ if(typeof showToast==='function') showToast(m,t); }} }});
        }} else {{
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';
          msg.textContent = '{fallback}';
          p.appendChild(msg);
        }}
      }} else {{ p.style.display = 'none'; }}
    }}
    ['dg-overflow-grid','dg-tools-sheet-grid'].forEach(function(gridId, i) {{
      var grid = document.getElementById(gridId);
      var btnId = i === 0 ? '{ov_id}' : '{ts_id}';
      if (grid && !document.getElementById(btnId)) {{
        var btn = document.createElement('button');
        btn.id = btnId; btn.className = 'dg-ov-btn';
        btn.innerHTML = '{emoji}<br><span>{label}</span>';
        btn.addEventListener('click', function(){{
          if (i === 0) {{ ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){{ var e=document.getElementById(id); if(e) e.classList.remove('open'); }}); }}
          else {{ var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open'); }}
          toggle();
        }});
        grid.appendChild(btn);
      }}
    }});
  }}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI_{safe});
  else setTimeout(initUI_{safe}, {timeout});
"""

# ── 1. VALIDATION DEEP STACK (must come first -- others depend on it) ─────────
# categorical-consistency -> missingness-detective -> upper-bound-sanity
# -> health-standards -> domain-physics
VALIDATION_DEEP = """
/* ================================================================
   VALIDATION DEEP STACK -- recovered from git history
   categorical-consistency, missingness-detective, upper-bound-sanity,
   health-standards, domain-physics
   Deps: nameTokens (in bundle as _DgCrossColumn), matchVital (in bundle),
         similarity (in bundle via FuzzyDedup), identifier-columns (in bundle)
   ================================================================ */

/* ---- from js/validation/categorical-consistency.js ---- */
;(function(){
  'use strict';
  var _cc = window._DgCrossColumn || {};
  var nameTokens = _cc.nameTokens || function(s){ return (s||'').toLowerCase().split(/[_\s]+/); };
  var _fd = window.FuzzyDedup || {};
  var similarity = _fd.similarity || function(a,b){ return a===b?1:0; };
  var _ic = window.IdentifierColumns || {};
  var isLikelyIdentifierColumn = _ic.isLikelyIdentifierColumn || function(){ return false; };
  var isNearUniqueColumn = _ic.isNearUniqueColumn || function(){ return false; };
""" + r('categorical-consistency.js') + """
  window.CategoricalConsistency = {
    isSensitiveCategory: typeof isSensitiveCategory !== 'undefined' ? isSensitiveCategory : null,
    describeCluster: typeof describeCluster !== 'undefined' ? describeCluster : null,
    detectCategoricalIssues: typeof detectCategoricalIssues !== 'undefined' ? detectCategoricalIssues : null,
    buildCategoryReport: typeof buildCategoryReport !== 'undefined' ? buildCategoryReport : null,
  };
}());
/* ---- end categorical-consistency.js ---- */

/* ---- from js/validation/missingness-detective.js ---- */
;(function(){
  'use strict';
  var _cc2 = window._DgCrossColumn || {};
  var nameTokens = _cc2.nameTokens || function(s){ return (s||'').toLowerCase().split(/[_\s]+/); };
""" + r('missingness-detective.js') + """
  window.MissingnessDetective = {
    detectMissingnessPatterns: typeof detectMissingnessPatterns !== 'undefined' ? detectMissingnessPatterns : null,
    buildMissingnessReport: typeof buildMissingnessReport !== 'undefined' ? buildMissingnessReport : null,
    MIN_MISSING_RATE: typeof MIN_MISSING_RATE !== 'undefined' ? MIN_MISSING_RATE : 0.05,
  };
}());
/* ---- end missingness-detective.js ---- */

/* ---- from js/validation/upper-bound-sanity.js ---- */
;(function(){
  'use strict';
  var _cc3 = window._DgCrossColumn || {};
  var nameTokens = _cc3.nameTokens || function(s){ return (s||'').toLowerCase().split(/[_\s]+/); };
  var _pp = window.PhysiologicalPlausibility || {};
  var matchVital = _pp.matchVital || null;
""" + r('upper-bound-sanity.js') + """
  window.UpperBoundSanity = {
    checkUpperBounds: typeof checkUpperBounds !== 'undefined' ? checkUpperBounds : null,
    buildSanityReport: typeof buildSanityReport !== 'undefined' ? buildSanityReport : null,
    SANITY_RULES: typeof SANITY_RULES !== 'undefined' ? SANITY_RULES : [],
  };
}());
/* ---- end upper-bound-sanity.js ---- */

/* ---- from js/validation/health-standards.js ---- */
;(function(){
  'use strict';
  var _pp2 = window.PhysiologicalPlausibility || {};
  var VITALS = _pp2.VITALS || {};
  var _cc4 = window._DgCrossColumn || {};
  var nameTokens = _cc4.nameTokens || function(s){ return (s||'').toLowerCase().split(/[_\s]+/); };
  var _md = window.MissingnessDetective || {};
  var MIN_MISSING_RATE = _md.MIN_MISSING_RATE || 0.05;
""" + r('health-standards.js') + """
  window.HealthStandards = {
    validateHealthStandards: typeof validateHealthStandards !== 'undefined' ? validateHealthStandards : null,
    buildHealthReport: typeof buildHealthReport !== 'undefined' ? buildHealthReport : null,
    MEDICAL_DISCLAIMER: typeof MEDICAL_DISCLAIMER !== 'undefined' ? MEDICAL_DISCLAIMER : '',
    HEALTH_RULES: typeof HEALTH_RULES !== 'undefined' ? HEALTH_RULES : [],
  };
}());
/* ---- end health-standards.js ---- */

/* ---- from js/validation/domain-physics.js ---- */
;(function(){
  'use strict';
  var _catcon = window.CategoricalConsistency || {};
  var isSensitiveCategory = _catcon.isSensitiveCategory || null;
  var describeCluster = _catcon.describeCluster || null;
  var _hs = window.HealthStandards || {};
  var MEDICAL_DISCLAIMER = _hs.MEDICAL_DISCLAIMER || '';
""" + r('domain-physics.js') + """
  window.DomainPhysics = {
    applyDomainPhysics: typeof applyDomainPhysics !== 'undefined' ? applyDomainPhysics : null,
    buildDomainReport: typeof buildDomainReport !== 'undefined' ? buildDomainReport : null,
    DOMAIN_PACKS: typeof DOMAIN_PACKS !== 'undefined' ? DOMAIN_PACKS : {},
    PACK_RULE_LAYERS: typeof PACK_RULE_LAYERS !== 'undefined' ? PACK_RULE_LAYERS : [],
    compilePackRule: typeof compilePackRule !== 'undefined' ? compilePackRule : null,
    packFromDescriptor: typeof packFromDescriptor !== 'undefined' ? packFromDescriptor : null,
  };
}());
/* ---- end domain-physics.js ---- */
"""

# ── 2. PHI PROMPT GUARD ────────────────────────────────────────────────────
PHI_GUARD = """
/* ================================================================
   PHI PROMPT GUARD -- recovered from git history
   js/agents/phi-prompt-guard.js (163 lines)
   Dep for query-sentinel
   ================================================================ */

/* ---- from js/agents/phi-prompt-guard.js ---- */
;(function(){
  'use strict';
  var _catcon = window.CategoricalConsistency || {};
  var isSensitiveCategory = _catcon.isSensitiveCategory || function(){ return false; };
""" + r('phi-prompt-guard.js') + """
  window.PhiPromptGuard = {
    classifySensitiveColumns: typeof classifySensitiveColumns !== 'undefined' ? classifySensitiveColumns : null,
    buildPhiGuardReport: typeof buildPhiGuardReport !== 'undefined' ? buildPhiGuardReport : null,
    PHI_CATEGORIES: typeof PHI_CATEGORIES !== 'undefined' ? PHI_CATEGORIES : [],
  };
}());
/* ---- end phi-prompt-guard.js ---- */
"""

# ── 3. QUERY SENTINEL ──────────────────────────────────────────────────────
QUERY_SENTINEL = """
/* ================================================================
   QUERY SENTINEL -- recovered from git history
   query-sentinel (383), query-sentinel-assist (215), query-sentinel-bridge (175)
   ================================================================ */

/* ---- from js/validation/query-sentinel-assist.js ---- */
;(function(){
  'use strict';
""" + r('query-sentinel-assist.js') + """
  window.QuerySentinelAssist = {
    buildAssistSuggestions: typeof buildAssistSuggestions !== 'undefined' ? buildAssistSuggestions : null,
    explainSentinelViolation: typeof explainSentinelViolation !== 'undefined' ? explainSentinelViolation : null,
  };
}());
/* ---- end query-sentinel-assist.js ---- */

/* ---- from js/validation/query-sentinel-bridge.js ---- */
;(function(){
  'use strict';
  var _qsa = window.QuerySentinelAssist || {};
  var buildAssistSuggestions = _qsa.buildAssistSuggestions;
""" + r('query-sentinel-bridge.js') + """
  window.QuerySentinelBridge = {
    bridgeSentinelToEditor: typeof bridgeSentinelToEditor !== 'undefined' ? bridgeSentinelToEditor : null,
    buildBridgeReport: typeof buildBridgeReport !== 'undefined' ? buildBridgeReport : null,
  };
}());
/* ---- end query-sentinel-bridge.js ---- */

/* ---- from js/validation/query-sentinel.js ---- */
;(function(){
  'use strict';
  var _phg = window.PhiPromptGuard || {};
  var classifySensitiveColumns = _phg.classifySensitiveColumns || function(){ return []; };
  var _qsb = window.QuerySentinelBridge || {};
  var bridgeSentinelToEditor = _qsb.bridgeSentinelToEditor;
""" + r('query-sentinel.js') + """
  window.QuerySentinel = {
    runQuerySentinel: typeof runQuerySentinel !== 'undefined' ? runQuerySentinel : null,
    buildSentinelReport: typeof buildSentinelReport !== 'undefined' ? buildSentinelReport : null,
    SENTINEL_RULES: typeof SENTINEL_RULES !== 'undefined' ? SENTINEL_RULES : [],
  };

""" + panel('dg-querysentinel-panel', 874, 'Sentinel', '\U0001f6e1\ufe0f', 1750,
            'runQuerySentinel', 'Query Sentinel: pre-flight PHI/PII detection, sensitive-column guard, SQL safety checks.',
            'dg-ov-querysentinel', 'dg-ts-querysentinel') + """
}());
/* ---- end query-sentinel.js ---- */
"""

# ── 4. RULEPACKS ───────────────────────────────────────────────────────────
RULEPACKS = """
/* ================================================================
   RULEPACKS + COMMUNITY PACK + MICRO-LESSONS -- recovered from git history
   rulepacks/: general, healthcare, rulepack-registry
   teaching/: community-pack, micro-lessons
   ================================================================ */

/* ---- from js/rulepacks/packs/general.js ---- */
;(function(){
  'use strict';
""" + rd('general.js') + """
  window.GeneralRulepack = {
    pack: typeof _defaultExport !== 'undefined' ? _defaultExport : null,
  };
}());
/* ---- end general.js ---- */

/* ---- from js/rulepacks/packs/healthcare.js ---- */
;(function(){
  'use strict';
""" + rd('healthcare.js') + """
  window.HealthcareRulepack = {
    pack: typeof _defaultExport !== 'undefined' ? _defaultExport : null,
  };
}());
/* ---- end healthcare.js ---- */

/* ---- from js/rulepacks/rulepack-registry.js ---- */
;(function(){
  'use strict';
  var healthcarePack = (window.HealthcareRulepack || {}).pack || null;
  var generalPack = (window.GeneralRulepack || {}).pack || null;
""" + r('rulepack-registry.js') + """
  window.RulepackRegistry = {
    getRulepack: typeof getRulepack !== 'undefined' ? getRulepack : null,
    listRulepacks: typeof listRulepacks !== 'undefined' ? listRulepacks : null,
    registerRulepack: typeof registerRulepack !== 'undefined' ? registerRulepack : null,
  };
}());
/* ---- end rulepack-registry.js ---- */

/* ---- from js/packs/pack-network-guard.js ---- */
;(function(){
  'use strict';
""" + r('pack-network-guard.js') + """
  window.PackNetworkGuard = {
    assertNoNetwork: typeof assertNoNetwork !== 'undefined' ? assertNoNetwork : null,
    runWithNetworkDenied: typeof runWithNetworkDenied !== 'undefined' ? runWithNetworkDenied : null,
  };
}());
/* ---- end pack-network-guard.js ---- */

/* ---- from js/packs/extension-points.js ---- */
;(function(){
  'use strict';
""" + r('extension-points.js') + """
  window.ExtensionPoints = {
    isExtensionPoint: typeof isExtensionPoint !== 'undefined' ? isExtensionPoint : null,
    EXTENSION_POINT_IDS: typeof EXTENSION_POINT_IDS !== 'undefined' ? EXTENSION_POINT_IDS : [],
  };
}());
/* ---- end extension-points.js ---- */

/* ---- from js/validation/domain-physics.js already done above ---- */

/* ---- from js/teaching/community-pack.js ---- */
;(function(){
  'use strict';
  var _dp = window.DomainPhysics || {};
  var PACK_RULE_LAYERS  = _dp.PACK_RULE_LAYERS || [];
  var compilePackRule   = _dp.compilePackRule || null;
  var packFromDescriptor = _dp.packFromDescriptor || null;
  var DOMAIN_PACKS      = _dp.DOMAIN_PACKS || {};
""" + r('community-pack.js') + """
  window.CommunityPack = {
    PACK_KIND: typeof PACK_KIND !== 'undefined' ? PACK_KIND : 'dataglow-pack',
    PACK_SCHEMA_VERSION: typeof PACK_SCHEMA_VERSION !== 'undefined' ? PACK_SCHEMA_VERSION : 1,
    validateImportedPack: typeof validateImportedPack !== 'undefined' ? validateImportedPack : null,
    importPack: typeof importPack !== 'undefined' ? importPack : null,
    exportPack: typeof exportPack !== 'undefined' ? exportPack : null,
  };
}());
/* ---- end community-pack.js ---- */

/* ---- from js/teaching/micro-lessons.js ---- */
;(function(){
  'use strict';
""" + r('micro-lessons.js') + """
  window.MicroLessons = {
    buildLesson: typeof buildLesson !== 'undefined' ? buildLesson : null,
    getLessonsForContext: typeof getLessonsForContext !== 'undefined' ? getLessonsForContext : null,
    LESSON_CATALOG: typeof LESSON_CATALOG !== 'undefined' ? LESSON_CATALOG : [],
  };

""" + panel('dg-microlessons-panel', 875, 'Learn', '\U0001f393', 1800,
            'buildLesson', 'Micro-lessons: context-aware educational nudges as you analyze. Learn while you work.',
            'dg-ov-microlessons', 'dg-ts-microlessons') + """
}());
/* ---- end micro-lessons.js ---- */
"""

# ── 5. DRILL FLOOR ─────────────────────────────────────────────────────────
DRILL_FLOOR = """
/* ================================================================
   DRILL FLOOR -- recovered from git history
   js/drill-floor/: drill-floor-data, drill-floor, drill-diff
   ================================================================ */

/* ---- from js/drill-floor/drill-floor-data.js ---- */
;(function(){
  'use strict';
""" + r('drill-floor-data.js') + """
  window.DrillFloorData = {
    DRILL_ORDERS_TABLE: typeof DRILL_ORDERS_TABLE !== 'undefined' ? DRILL_ORDERS_TABLE : null,
    DRILL_PROMOS_TABLE: typeof DRILL_PROMOS_TABLE !== 'undefined' ? DRILL_PROMOS_TABLE : null,
    buildDrillDataset: typeof buildDrillDataset !== 'undefined' ? buildDrillDataset : null,
  };
}());
/* ---- end drill-floor-data.js ---- */

/* ---- from js/drill-floor/drill-diff.js ---- */
;(function(){
  'use strict';
""" + r('drill-diff.js') + """
  window.DrillDiff = {
    computeDrillDiff: typeof computeDrillDiff !== 'undefined' ? computeDrillDiff : null,
    buildDrillDiffReport: typeof buildDrillDiffReport !== 'undefined' ? buildDrillDiffReport : null,
    DRILL_DIFF_TYPES: typeof DRILL_DIFF_TYPES !== 'undefined' ? DRILL_DIFF_TYPES : [],
  };
}());
/* ---- end drill-diff.js ---- */

/* ---- from js/drill-floor/drill-floor.js ---- */
;(function(){
  'use strict';
  var _dfd = window.DrillFloorData || {};
  var DRILL_ORDERS_TABLE = _dfd.DRILL_ORDERS_TABLE;
  var DRILL_PROMOS_TABLE = _dfd.DRILL_PROMOS_TABLE;
  var _dd = window.DrillDiff || {};
  var computeDrillDiff = _dd.computeDrillDiff;
""" + r('drill-floor.js') + """
  window.DrillFloor = {
    mountDrillFloor: typeof mountDrillFloor !== 'undefined' ? mountDrillFloor : null,
    buildDrillSession: typeof buildDrillSession !== 'undefined' ? buildDrillSession : null,
  };

""" + panel('dg-drillfloor-panel', 876, 'Drill', '\U0001f9e0', 1850,
            'mountDrillFloor', 'Drill Floor: interactive practice environment for SQL and analysis skills.',
            'dg-ov-drillfloor', 'dg-ts-drillfloor') + """
}());
/* ---- end drill-floor.js ---- */
"""

# ── 6. EXPORT ENGINE ───────────────────────────────────────────────────────
EXPORT_ENGINE = """
/* ================================================================
   EXPORT ENGINE -- recovered from git history
   js/export/: export-delivery (152), export-report (531)
   ================================================================ */

/* ---- from js/export/export-delivery.js ---- */
;(function(){
  'use strict';
""" + r('export-delivery.js') + """
  window.ExportDelivery = {
    deliverBlob: typeof deliverBlob !== 'undefined' ? deliverBlob : null,
    deliverText: typeof deliverText !== 'undefined' ? deliverText : null,
    deliverJSON: typeof deliverJSON !== 'undefined' ? deliverJSON : null,
  };
}());
/* ---- end export-delivery.js ---- */

/* ---- from js/export/export-report.js ---- */
;(function(){
  'use strict';
  var _ed = window.ExportDelivery || {};
  var deliverBlob = _ed.deliverBlob || function(blob, name){ var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); };
""" + r('export-report.js') + """
  window.ExportReport = {
    buildExportReport: typeof buildExportReport !== 'undefined' ? buildExportReport : null,
    exportAsHTML: typeof exportAsHTML !== 'undefined' ? exportAsHTML : null,
    exportAsMarkdown: typeof exportAsMarkdown !== 'undefined' ? exportAsMarkdown : null,
    exportAsJSON: typeof exportAsJSON !== 'undefined' ? exportAsJSON : null,
    exportAsCSV: typeof exportAsCSV !== 'undefined' ? exportAsCSV : null,
    EXPORT_FORMATS: typeof EXPORT_FORMATS !== 'undefined' ? EXPORT_FORMATS : [],
  };
}());
/* ---- end export-report.js ---- */
"""

# ── 7. LEARNING CLUSTER ────────────────────────────────────────────────────
LEARNING = """
/* ================================================================
   LEARNING CLUSTER -- recovered from git history
   self-learning-rules, rule-suggestions, proficiency-signal,
   signal-store, adaptive-priority, memory-store
   ================================================================ */

/* ---- from js/learning/self-learning-rules.js ---- */
;(function(){
  'use strict';
""" + r('self-learning-rules.js') + """
  window.SelfLearningRules = {
    buildRuleFromFeedback: typeof buildRuleFromFeedback !== 'undefined' ? buildRuleFromFeedback : null,
    applyLearnedRules: typeof applyLearnedRules !== 'undefined' ? applyLearnedRules : null,
    actionToLabel: typeof actionToLabel !== 'undefined' ? actionToLabel : null,
    KNOWN_SOURCES: typeof KNOWN_SOURCES !== 'undefined' ? KNOWN_SOURCES : [],
  };
}());
/* ---- end self-learning-rules.js ---- */

/* ---- from js/learning/memory-store.js ---- */
;(function(){
  'use strict';
""" + r('memory-store.js') + """
  window.MemoryStore = {
    createMemoryStore: typeof createMemoryStore !== 'undefined' ? createMemoryStore : null,
    MemoryStore: typeof MemoryStore !== 'undefined' ? MemoryStore : null,
  };
}());
/* ---- end memory-store.js ---- */

/* ---- from js/learning/proficiency-signal.js ---- */
;(function(){
  'use strict';
""" + r('proficiency-signal.js') + """
  window.ProficiencySignal = {
    computeProficiency: typeof computeProficiency !== 'undefined' ? computeProficiency : null,
    buildProficiencyProfile: typeof buildProficiencyProfile !== 'undefined' ? buildProficiencyProfile : null,
    PROFICIENCY_LEVELS: typeof PROFICIENCY_LEVELS !== 'undefined' ? PROFICIENCY_LEVELS : {},
  };
}());
/* ---- end proficiency-signal.js ---- */

/* ---- from js/learning/signal-store.js ---- */
;(function(){
  'use strict';
""" + r('signal-store.js') + """
  window.SignalStore = {
    createSignalStore: typeof createSignalStore !== 'undefined' ? createSignalStore : null,
    recordSignal: typeof recordSignal !== 'undefined' ? recordSignal : null,
    getSignals: typeof getSignals !== 'undefined' ? getSignals : null,
  };
}());
/* ---- end signal-store.js ---- */

/* ---- from js/learning/rule-suggestions.js ---- */
;(function(){
  'use strict';
  var _ms = window.MemoryStore || {};
  var createMemoryStore = _ms.createMemoryStore;
""" + r('rule-suggestions.js') + """
  window.RuleSuggestions = {
    buildRuleSuggestions: typeof buildRuleSuggestions !== 'undefined' ? buildRuleSuggestions : null,
    rankSuggestions: typeof rankSuggestions !== 'undefined' ? rankSuggestions : null,
  };
}());
/* ---- end rule-suggestions.js ---- */

/* ---- from js/learning/adaptive-priority.js ---- */
;(function(){
  'use strict';
  var _slr = window.SelfLearningRules || {};
  var actionToLabel = _slr.actionToLabel || function(a){ return String(a); };
""" + r('adaptive-priority.js') + """
  window.AdaptivePriority = {
    computeAdaptivePriority: typeof computeAdaptivePriority !== 'undefined' ? computeAdaptivePriority : null,
    buildPriorityQueue: typeof buildPriorityQueue !== 'undefined' ? buildPriorityQueue : null,
    PRIORITY_SIGNALS: typeof PRIORITY_SIGNALS !== 'undefined' ? PRIORITY_SIGNALS : [],
  };
}());
/* ---- end adaptive-priority.js ---- */
"""

# ── 8. GRADES + PROVENANCE EXTRAS II + PROBLEM FRAMER + SQL TOOLS ─────────
EXTRAS = """
/* ================================================================
   GRADES + PROVENANCE EXTRAS II + PROBLEM FRAMER + SQL TOOLS
   + CLEANING + NUTRITION BADGES
   ================================================================ */

/* ---- from js/grades/calibrated-grades.js ---- */
;(function(){
  'use strict';
""" + r('calibrated-grades.js') + """
  window.CalibratedGrades = {
    computeGrade: typeof computeGrade !== 'undefined' ? computeGrade : null,
    buildGradeReport: typeof buildGradeReport !== 'undefined' ? buildGradeReport : null,
    GRADE_SCALE: typeof GRADE_SCALE !== 'undefined' ? GRADE_SCALE : {},
  };
}());
/* ---- end calibrated-grades.js ---- */

/* ---- from js/grades/cat-scorecard.js ---- */
;(function(){
  'use strict';
""" + ENGINE_STUB + r('cat-scorecard.js') + """
  window.CatScorecard = {
    buildCatScorecard: typeof buildCatScorecard !== 'undefined' ? buildCatScorecard : null,
    CAT_WEIGHTS: typeof CAT_WEIGHTS !== 'undefined' ? CAT_WEIGHTS : {},
  };
}());
/* ---- end cat-scorecard.js ---- */

/* ---- from js/grades/golden-signals.js ---- */
;(function(){
  'use strict';
""" + ENGINE_STUB + r('golden-signals.js') + """
  window.GoldenSignals = {
    computeGoldenSignals: typeof computeGoldenSignals !== 'undefined' ? computeGoldenSignals : null,
    GOLDEN_SIGNAL_DEFS: typeof GOLDEN_SIGNAL_DEFS !== 'undefined' ? GOLDEN_SIGNAL_DEFS : [],
  };
}());
/* ---- end golden-signals.js ---- */

/* ---- from js/problem-framing/problem-framer.js ---- */
;(function(){
  'use strict';
""" + r('problem-framer.js') + """
  window.ProblemFramer = {
    buildProblemFrame: typeof buildProblemFrame !== 'undefined' ? buildProblemFrame : null,
    refineProblemFrame: typeof refineProblemFrame !== 'undefined' ? refineProblemFrame : null,
    FRAME_TYPES: typeof FRAME_TYPES !== 'undefined' ? FRAME_TYPES : [],
  };

""" + panel('dg-problemframer-panel', 877, 'Frame', '\U0001f4cb', 1900,
            'buildProblemFrame', 'Problem Framer: structure your analysis question before diving in.',
            'dg-ov-problemframer', 'dg-ts-problemframer') + """
}());
/* ---- end problem-framer.js ---- */

/* ---- from js/cleaning/materiality.js ---- */
;(function(){
  'use strict';
""" + r('materiality.js') + """
  window.Materiality = {
    isMaterial: typeof isMaterial !== 'undefined' ? isMaterial : null,
    MATERIALITY_THRESHOLD: typeof MATERIALITY_THRESHOLD !== 'undefined' ? MATERIALITY_THRESHOLD : 0.01,
  };
}());
/* ---- end materiality.js ---- */

/* ---- from js/cleaning/format-fingerprint.js ---- */
;(function(){
  'use strict';
""" + ENGINE_STUB + r('format-fingerprint.js') + """
  window.FormatFingerprint = {
    fingerprintFormat: typeof fingerprintFormat !== 'undefined' ? fingerprintFormat : null,
    detectFormatAnomalies: typeof detectFormatAnomalies !== 'undefined' ? detectFormatAnomalies : null,
  };
}());
/* ---- end format-fingerprint.js ---- */

/* ---- from js/cleaning/imputation.js ---- */
;(function(){
  'use strict';
""" + ENGINE_STUB + r('imputation.js') + """
  window.Imputation = {
    imputeMissing: typeof imputeMissing !== 'undefined' ? imputeMissing : null,
    IMPUTATION_STRATEGIES: typeof IMPUTATION_STRATEGIES !== 'undefined' ? IMPUTATION_STRATEGIES : [],
  };
}());
/* ---- end imputation.js ---- */

/* ---- from js/provenance/nutrition-badges.js ---- */
;(function(){
  'use strict';
""" + r('nutrition-badges.js') + """
  window.NutritionBadges = {
    buildNutritionBadge: typeof buildNutritionBadge !== 'undefined' ? buildNutritionBadge : null,
    renderBadgeHTML: typeof renderBadgeHTML !== 'undefined' ? renderBadgeHTML : null,
    BADGE_TYPES: typeof BADGE_TYPES !== 'undefined' ? BADGE_TYPES : [],
  };
}());
/* ---- end nutrition-badges.js ---- */

/* ---- from js/provenance/cost-of-bad-data.js ---- */
;(function(){
  'use strict';
""" + r('cost-of-bad-data.js') + """
  window.CostOfBadData = {
    estimateCostOfBadData: typeof estimateCostOfBadData !== 'undefined' ? estimateCostOfBadData : null,
    buildCostReport: typeof buildCostReport !== 'undefined' ? buildCostReport : null,
    COST_FACTORS: typeof COST_FACTORS !== 'undefined' ? COST_FACTORS : {},
  };
}());
/* ---- end cost-of-bad-data.js ---- */

/* ---- from js/provenance/denial-root-cause.js ---- */
;(function(){
  'use strict';
""" + SHA_SHIM + """
  var _cbd = window.CostOfBadData || {};
  var estimateCostOfBadData = _cbd.estimateCostOfBadData || null;
""" + r('denial-root-cause.js') + """
  window.DenialRootCause = {
    analyzeDenialRootCause: typeof analyzeDenialRootCause !== 'undefined' ? analyzeDenialRootCause : null,
    buildDenialReport: typeof buildDenialReport !== 'undefined' ? buildDenialReport : null,
    DENIAL_CATEGORIES: typeof DENIAL_CATEGORIES !== 'undefined' ? DENIAL_CATEGORIES : [],
  };

""" + panel('dg-denialrca-panel', 878, 'Denial RCA', '\U0001f3e5', 1950,
            'analyzeDenialRootCause', 'Claims Denial Root Cause Analyzer: trace billing denials back to their data origin.',
            'dg-ov-denialrca', 'dg-ts-denialrca') + """
}());
/* ---- end denial-root-cause.js ---- */

/* ---- from js/provenance/incident-postmortem.js ---- */
;(function(){
  'use strict';
""" + r('incident-postmortem.js') + """
  window.IncidentPostmortem = {
    buildPostmortem: typeof buildPostmortem !== 'undefined' ? buildPostmortem : null,
    renderPostmortemReport: typeof renderPostmortemReport !== 'undefined' ? renderPostmortemReport : null,
    exportPostmortem: typeof exportPostmortem !== 'undefined' ? exportPostmortem : null,
  };

""" + panel('dg-postmortem-panel', 879, 'Postmortem', '\U0001f4dd', 2000,
            'renderPostmortemReport', 'Incident Postmortem: document data quality incidents with full provenance chain.',
            'dg-ov-postmortem', 'dg-ts-postmortem') + """
}());
/* ---- end incident-postmortem.js ---- */

/* ---- from js/app-shell/sql-dialect-adapter.js ---- */
;(function(){
  'use strict';
""" + r('sql-dialect-adapter.js') + """
  window.SQLDialectAdapter = {
    adaptSQL: typeof adaptSQL !== 'undefined' ? adaptSQL : null,
    detectDialect: typeof detectDialect !== 'undefined' ? detectDialect : null,
    SUPPORTED_DIALECTS: typeof SUPPORTED_DIALECTS !== 'undefined' ? SUPPORTED_DIALECTS : [],
  };
}());
/* ---- end sql-dialect-adapter.js ---- */

/* ---- from js/app-shell/sql-highlight.js ---- */
;(function(){
  'use strict';
""" + r('sql-highlight.js') + """
  window.SQLHighlight = {
    highlightSQL: typeof highlightSQL !== 'undefined' ? highlightSQL : null,
    buildHighlightTokens: typeof buildHighlightTokens !== 'undefined' ? buildHighlightTokens : null,
    SQL_KEYWORDS: typeof SQL_KEYWORDS !== 'undefined' ? SQL_KEYWORDS : [],
  };
}());
/* ---- end sql-highlight.js ---- */

/* ---- from js/app-shell/command-palette.js ---- */
;(function(){
  'use strict';
""" + r('command-palette.js') + """
  window.CommandPalette = {
    mountCommandPalette: typeof mountCommandPalette !== 'undefined' ? mountCommandPalette : null,
    registerCommand: typeof registerCommand !== 'undefined' ? registerCommand : null,
    openCommandPalette: typeof openCommandPalette !== 'undefined' ? openCommandPalette : null,
  };

  // Auto-mount on Cmd+K / Ctrl+K
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (typeof openCommandPalette === 'function') openCommandPalette();
    }
  });
}());
/* ---- end command-palette.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# WRITE TO BUNDLE
# ─────────────────────────────────────────────────────────────────────────────
with open(BUNDLE, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

if 'DrillFloor' in content:
    print("Sprint 6 already injected.")
    sys.exit(0)

OLD_FLAG = '    analysisFingerprint: true,\n  };'
NEW_FLAGS = """    analysisFingerprint: true,
    categoricalConsistency: true,
    missingnessDetective: true,
    upperBoundSanity: true,
    healthStandards: true,
    domainPhysics: true,
    phiPromptGuard: true,
    querySentinel: true,
    querySentinelAssist: true,
    rulepacks: true,
    communityPack: true,
    microLessons: true,
    drillFloor: true,
    exportEngine: true,
    selfLearningRules: true,
    adaptivePriority: true,
    memoryStore: true,
    calibratedGrades: true,
    goldenSignals: true,
    problemFramer: true,
    costOfBadData: true,
    denialRootCause: true,
    incidentPostmortem: true,
    sqlDialectAdapter: true,
    commandPalette: true,
    nutritionBadges: true,
    imputation: true,
    formatFingerprint: true,
  };"""
if OLD_FLAG in content:
    content = content.replace(OLD_FLAG, NEW_FLAGS)
    print("Sprint 6 flags added")
else:
    print("WARNING: flag anchor not found -- check last flag in bundle")

content += (
    '\n' + VALIDATION_DEEP +
    '\n' + PHI_GUARD +
    '\n' + QUERY_SENTINEL +
    '\n' + RULEPACKS +
    '\n' + DRILL_FLOOR +
    '\n' + EXPORT_ENGINE +
    '\n' + LEARNING +
    '\n' + EXTRAS
)

with open(BUNDLE, 'w', encoding='utf-8', errors='replace') as f:
    f.write(content)

print(f"Sprint 6 injected into {BUNDLE}")
checks = [
    ('DomainPhysics', 'DomainPhysics'),
    ('PhiPromptGuard', 'PhiPromptGuard'),
    ('QuerySentinel', 'QuerySentinel'),
    ('RulepackRegistry', 'RulepackRegistry'),
    ('DrillFloor', 'DrillFloor'),
    ('ExportReport', 'ExportReport'),
    ('AdaptivePriority', 'AdaptivePriority'),
    ('SelfLearningRules', 'SelfLearningRules'),
    ('CommandPalette', 'CommandPalette'),
    ('DenialRootCause', 'DenialRootCause'),
    ('IncidentPostmortem', 'IncidentPostmortem'),
    ('domainPhysics flag', 'domainPhysics: true'),
    ('denialRootCause flag', 'denialRootCause: true'),
]
for label, needle in checks:
    print(f"  {label}: {needle in content}")
print(f"  Lines: {content.count(chr(10))}")
