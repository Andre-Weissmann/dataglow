#!/usr/bin/env python3
"""
Sprint 3: Polyglot Workbench + Metric Studio + Data Diplomacy + DRG/ICD Validators
+ Verifiable Check Seal (bonus dep already needed by Diplomacy)
"""
import re, sys

BUNDLE = 'src/js/bundle.js'

def read(path):
    with open(path, 'r', errors='replace') as f:
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
    return strip_es(read(f'/tmp/s3_{name}'))

EL_SHIM = """
  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };
"""

ESCAPE_SHIM = """
  var escapeHtml = (typeof window._dgEscapeHtml === 'function') ? window._dgEscapeHtml
    : function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
"""

SHA_SHIM = """
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };
"""

def panel_init(panel_id, z, label, emoji, timeout, mount_fn_name, mount_fallback_text, overflow_id, ts_id):
    return f"""
  function initUI_{overflow_id.replace('-','_')}() {{
    var panelId = '{panel_id}';
    if (!document.getElementById(panelId)) {{
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:480px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:{z};overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }}
    function toggle() {{
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {{
        p.style.display = 'block';
        p.innerHTML = '';
        var cx = document.createElement('button');
        cx.textContent = '\\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
        cx.addEventListener('click', function(){{ p.style.display='none'; }});
        p.appendChild(cx);
        if (typeof {mount_fn_name} === 'function') {{
          {mount_fn_name}({{ host: p, onToast: function(m,t){{ if(typeof showToast==='function') showToast(m,t); }} }});
        }} else {{
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';
          msg.textContent = '{mount_fallback_text}';
          p.appendChild(msg);
        }}
      }} else {{ p.style.display = 'none'; }}
    }}
    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('{overflow_id}')) {{
      var btn = document.createElement('button');
      btn.id = '{overflow_id}';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '{emoji}<br><span>{label}</span>';
      btn.addEventListener('click', function(){{
        ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){{
          var e2=document.getElementById(id); if(e2) e2.classList.remove('open');
        }});
        toggle();
      }});
      ovGrid.appendChild(btn);
    }}
    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('{ts_id}')) {{
      var btn2 = document.createElement('button');
      btn2.id = '{ts_id}';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '{emoji}<br><span>{label}</span>';
      btn2.addEventListener('click', function(){{
        var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open');
        toggle();
      }});
      tsGrid.appendChild(btn2);
    }}
  }}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI_{overflow_id.replace('-','_')});
  else setTimeout(initUI_{overflow_id.replace('-','_')}, {timeout});
"""

# ─────────────────────────────────────────────────────────────────────────────
# VERIFIABLE CHECK SEAL (dep for Diplomacy)
# ─────────────────────────────────────────────────────────────────────────────
VCS_BLOCK = """
/* ================================================================
   VERIFIABLE CHECK SEAL -- recovered from git history
   Trust Passport Batch 3. Dep for Data Diplomacy.
   sha256Hex + selective-disclosure-proof already in bundle.
   ================================================================ */

/* ---- from js/provenance/verifiable-check-seal.js ---- */
;(function(){
  'use strict';
""" + SHA_SHIM + """
  var _sdp = window.SelectiveDisclosureProof || {};
  var hashLeaf        = _sdp.hashLeaf;
  var buildMerkleTree = _sdp.buildMerkleTree;
  var merkleProof     = _sdp.merkleProof     || null;
  var rootFromProof   = _sdp.rootFromProof   || null;
""" + r('verifiable-check-seal.js') + """
  window.VerifiableCheckSeal = {
    canonicalJSON: typeof canonicalJSON !== 'undefined' ? canonicalJSON : null,
    fingerprintData: typeof fingerprintData !== 'undefined' ? fingerprintData : null,
    sealCheckResult: typeof sealCheckResult !== 'undefined' ? sealCheckResult : null,
    verifySeal: typeof verifySeal !== 'undefined' ? verifySeal : null,
    attachSealToLabel: typeof attachSealToLabel !== 'undefined' ? attachSealToLabel : null,
    renderSealSummaryLines: typeof renderSealSummaryLines !== 'undefined' ? renderSealSummaryLines : null,
    exportSealAsJSON: typeof exportSealAsJSON !== 'undefined' ? exportSealAsJSON : null,
    CHECK_SEAL_KIND: typeof CHECK_SEAL_KIND !== 'undefined' ? CHECK_SEAL_KIND : '',
  };
}());
/* ---- end verifiable-check-seal.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# POLYGLOT WORKBENCH
# ─────────────────────────────────────────────────────────────────────────────
POLYGLOT_BLOCK = """
/* ================================================================
   POLYGLOT WORKBENCH -- recovered from git history
   Batch A (#142 multi-dialect SQL), Batch B (#141 Object Space),
   Batch D (#353 schema-aware autocomplete)
   ================================================================ */

/* ---- from js/app-shell/object-space.js ---- */
;(function(){
  'use strict';
""" + r('object-space.js') + """
  window.ObjectSpace = {
    createObjectSpace: typeof createObjectSpace !== 'undefined' ? createObjectSpace : null,
    ObjectSpaceRegistry: typeof ObjectSpaceRegistry !== 'undefined' ? ObjectSpaceRegistry : null,
  };
}());
/* ---- end object-space.js ---- */

/* ---- from js/polyglot/polyglot-autocomplete.js ---- */
;(function(){
  'use strict';
  var ObjectSpace = window.ObjectSpace || {};
  var createObjectSpace = ObjectSpace.createObjectSpace || null;
""" + r('polyglot-autocomplete.js') + """
  window.PolyglotAutocomplete = {
    buildAutocompleteSuggestions: typeof buildAutocompleteSuggestions !== 'undefined' ? buildAutocompleteSuggestions : null,
    mountAutocomplete: typeof mountAutocomplete !== 'undefined' ? mountAutocomplete : null,
  };
}());
/* ---- end polyglot-autocomplete.js ---- */

/* ---- from js/polyglot/polyglot-error-advisor.js ---- */
;(function(){
  'use strict';
""" + r('polyglot-error-advisor.js') + """
  window.PolyglotErrorAdvisor = {
    adviseError: typeof adviseError !== 'undefined' ? adviseError : null,
    mountErrorAdvisor: typeof mountErrorAdvisor !== 'undefined' ? mountErrorAdvisor : null,
  };

""" + panel_init(
    'dg-polyglot-panel', 859, 'Polyglot', '\\uD83D\\uDD24',
    900, 'mountAutocomplete',
    'Polyglot Workbench: multi-dialect SQL translation + schema-aware autocomplete.',
    'dg-ov-polyglot', 'dg-ts-polyglot'
) + """
}());
/* ---- end polyglot-error-advisor.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# METRIC STUDIO
# ─────────────────────────────────────────────────────────────────────────────
METRIC_BLOCK = """
/* ================================================================
   METRIC STUDIO -- recovered from git history
   PR #93 (OneCanvas Phase 1), PR #174 (version history wired)
   ================================================================ */

/* ---- from js/metrics/metric-contracts.js (metrics/ version) ---- */
;(function(){
  'use strict';
""" + r('metric-contracts.js') + """
  // Expose as MetricContractsCore (distinct from NLSQLContracts which is the nl-sql/ version)
  window.MetricContractsCore = {
    getAllContracts: typeof getAllContracts !== 'undefined' ? getAllContracts : null,
    matchContracts: typeof matchContracts !== 'undefined' ? matchContracts : null,
    buildContractVersion: typeof buildContractVersion !== 'undefined' ? buildContractVersion : null,
    saveContractVersion: typeof saveContractVersion !== 'undefined' ? saveContractVersion : null,
  };
}());
/* ---- end metric-contracts.js ---- */

/* ---- from js/metrics/metric-studio.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + ESCAPE_SHIM + """
  var escapeHtml_ms = escapeHtml;
  var formatNumber = (typeof window._dgFormatNumber === 'function') ? window._dgFormatNumber
    : function(n){ return typeof n==='number' ? n.toLocaleString() : String(n); };
  var timeAgo = (typeof window._dgTimeAgo === 'function') ? window._dgTimeAgo
    : function(ts){ var s=Math.floor((Date.now()-ts)/1000); return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':Math.floor(s/3600)+'h ago'; };
  var _mc = window.MetricContractsCore || {};
  var getAllContracts   = _mc.getAllContracts;
  var matchContracts   = _mc.matchContracts;
  var buildContractVersion = _mc.buildContractVersion;
  var saveContractVersion  = _mc.saveContractVersion;
""" + r('metric-studio.js') + """
  window.MetricStudio = {
    mountMetricStudio: typeof mountMetricStudio !== 'undefined' ? mountMetricStudio : null,
    buildMetricView: typeof buildMetricView !== 'undefined' ? buildMetricView : null,
  };

""" + panel_init(
    'dg-metric-studio-panel', 860, 'Metrics', '\\uD83D\\uDCCA',
    950, 'mountMetricStudio',
    'Metric Studio: versioned, access-controlled metric definitions with history.',
    'dg-ov-metricstudio', 'dg-ts-metricstudio'
) + """
}());
/* ---- end metric-studio.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# DATA DIPLOMACY
# ─────────────────────────────────────────────────────────────────────────────
DIPLOMACY_BLOCK = """
/* ================================================================
   DATA DIPLOMACY -- recovered from git history
   Batch 1 (#146 engine), Batch 2 (#148 two-key UI),
   Batch 3 (#356 real claims), Batch 4 (#357 P2P exchange)
   Flag dataDiplomacy promoted ON in PR #160
   ================================================================ */

/* ---- from js/diplomacy/reconciliation-engine.js ---- */
;(function(){
  'use strict';
""" + r('reconciliation-engine.js') + """
  window.ReconciliationEngine = {
    reconcileDatasets: typeof reconcileDatasets !== 'undefined' ? reconcileDatasets : null,
    explainReconciliation: typeof explainReconciliation !== 'undefined' ? explainReconciliation : null,
    buildReconciliationSummary: typeof buildReconciliationSummary !== 'undefined' ? buildReconciliationSummary : null,
  };
}());
/* ---- end reconciliation-engine.js ---- */

/* ---- from js/diplomacy/diplomacy-claim.js ---- */
;(function(){
  'use strict';
""" + SHA_SHIM + """
  var canonicalJSON = (window.VerifiableCheckSeal || {}).canonicalJSON
    || function(v){ return JSON.stringify(v, Object.keys(v||{}).sort()); };
""" + r('diplomacy-claim.js') + """
  window.DiplomacyClaim = {
    buildClaim: typeof buildClaim !== 'undefined' ? buildClaim : null,
    sealClaim: typeof sealClaim !== 'undefined' ? sealClaim : null,
    fingerprintClaimContent: typeof fingerprintClaimContent !== 'undefined' ? fingerprintClaimContent : null,
  };
}());
/* ---- end diplomacy-claim.js ---- */

/* ---- from js/diplomacy/diplomacy-approval-gate.js ---- */
;(function(){
  'use strict';
  var fingerprintClaimContent = (window.DiplomacyClaim || {}).fingerprintClaimContent;
""" + r('diplomacy-approval-gate.js') + """
  window.DiplomacyApprovalGate = {
    buildApprovalGate: typeof buildApprovalGate !== 'undefined' ? buildApprovalGate : null,
    approveGate: typeof approveGate !== 'undefined' ? approveGate : null,
    rejectGate: typeof rejectGate !== 'undefined' ? rejectGate : null,
    isGateApproved: typeof isGateApproved !== 'undefined' ? isGateApproved : null,
  };
}());
/* ---- end diplomacy-approval-gate.js ---- */

/* ---- from js/diplomacy/diplomacy-p2p-transport.js ---- */
;(function(){
  'use strict';
""" + r('diplomacy-p2p-transport.js') + """
  window.DiplomacyP2P = {
    createP2PTransport: typeof createP2PTransport !== 'undefined' ? createP2PTransport : null,
    createLocalTransport: typeof createLocalTransport !== 'undefined' ? createLocalTransport : null,
  };
}());
/* ---- end diplomacy-p2p-transport.js ---- */

/* ---- from js/diplomacy/diplomacy-loader.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + """
  var _claim = window.DiplomacyClaim || {};
  var _gate  = window.DiplomacyApprovalGate || {};
  var buildClaim   = _claim.buildClaim;
  var sealClaim    = _claim.sealClaim;
  var buildApprovalGate = _gate.buildApprovalGate;
  var isGateApproved    = _gate.isGateApproved;
""" + r('diplomacy-loader.js') + """
  window.DiplomacyLoader = {
    mountDiplomacyLoader: typeof mountDiplomacyLoader !== 'undefined' ? mountDiplomacyLoader : null,
    buildDatasetClaim: typeof buildDatasetClaim !== 'undefined' ? buildDatasetClaim : null,
  };
}());
/* ---- end diplomacy-loader.js ---- */

/* ---- from js/diplomacy/diplomacy-ui.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + """
  var explainReconciliation = (window.ReconciliationEngine || {}).explainReconciliation;
  var _loader = window.DiplomacyLoader || {};
  var mountDiplomacyLoader = _loader.mountDiplomacyLoader;
  var _gate = window.DiplomacyApprovalGate || {};
  var approveGate = _gate.approveGate;
  var rejectGate  = _gate.rejectGate;
  var isGateApproved = _gate.isGateApproved;
""" + r('diplomacy-ui.js') + """
  window.DiplomacyUI = {
    mountDiplomacy: typeof mountDiplomacy !== 'undefined' ? mountDiplomacy : null,
  };

""" + panel_init(
    'dg-diplomacy-panel', 861, 'Diplomacy', '\\uD83E\\uDD1D',
    1000, 'mountDiplomacy',
    'Data Diplomacy: two-key cross-org approval gate. Load a dataset to build and seal a data claim.',
    'dg-ov-diplomacy', 'dg-ts-diplomacy'
) + """
}());
/* ---- end diplomacy-ui.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# DRG/ICD VALIDATORS
# ─────────────────────────────────────────────────────────────────────────────
DRG_BLOCK = """
/* ================================================================
   DRG/ICD-10 CODING VALIDATOR -- recovered from git history
   PR #298 (LOS date-math + DRG/ICD validator)
   PR #371 (NCCI same-day P2P conflict check)
   Dep: nameTokens + hasAnyKeyword + isNumeric from cross-column-consistency
   (already in bundle as window._DgCrossColumn)
   ================================================================ */

/* ---- from js/validation/drg-icd-validator.js ---- */
;(function(){
  'use strict';
  var _cc = window._DgCrossColumn || {};
  var nameTokens    = _cc.nameTokens    || function(s){ return (s||'').toLowerCase().split(/[_\\s]+/); };
  // hasAnyKeyword and isNumeric may be local to cross-column -- provide fallbacks
  var hasAnyKeyword = (typeof hasAnyKeyword !== 'undefined') ? hasAnyKeyword
    : function(tokens, words){ return words.some(function(w){ return tokens.includes(w); }); };
  var isNumeric = (typeof isNumeric !== 'undefined') ? isNumeric
    : function(v){ return !isNaN(parseFloat(v)) && isFinite(v); };
""" + r('drg-icd-validator.js') + """
  window.DRGICDValidator = {
    validateDRGICDCoding: typeof validateDRGICDCoding !== 'undefined' ? validateDRGICDCoding : null,
    buildDRGICDReport: typeof buildDRGICDReport !== 'undefined' ? buildDRGICDReport : null,
    detectDRGICDColumns: typeof detectDRGICDColumns !== 'undefined' ? detectDRGICDColumns : null,
    DRG_ICD_RULES: typeof DRG_ICD_RULES !== 'undefined' ? DRG_ICD_RULES : [],
  };

  // Surface in overflow grid as a validation tool
  function initDRGUI() {
    var panelId = 'dg-drgvalidator-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:460px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:862;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }
    function toggle() {
      var p = document.getElementById(panelId);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block';
        p.innerHTML = '';
        var cx = document.createElement('button');
        cx.textContent = '\\u00D7';
        cx.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
        cx.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(cx);
        var h = document.createElement('div');
        h.style.cssText = 'padding:20px;';
        h.innerHTML = '<h3 style="font-size:15px;font-weight:700;margin:0 0 8px;">DRG/ICD-10 Validator</h3><p style="font-size:12px;color:var(--text-muted,#888);line-height:1.6;">Healthcare billing correctness checker. Load a claims dataset to detect DRG/ICD-10 coding errors, NCCI same-day P2P conflicts, and LOS date-math issues.</p>';
        p.appendChild(h);
        // If dataset loaded, auto-run
        if (typeof validateDRGICDCoding === 'function' && typeof window.dgGetCurrentDataset === 'function') {
          var ds = window.dgGetCurrentDataset();
          if (ds && ds.rows) {
            var report = buildDRGICDReport ? buildDRGICDReport(ds) : null;
            if (report) {
              var pre = document.createElement('pre');
              pre.style.cssText = 'padding:0 20px;font-size:11px;white-space:pre-wrap;color:var(--text,#222);';
              pre.textContent = JSON.stringify(report, null, 2);
              p.appendChild(pre);
            }
          }
        }
      } else { p.style.display = 'none'; }
    }
    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-drgvalidator')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-drgvalidator';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\uD83C\\uDFE5<br><span>DRG/ICD</span>';
      btn.addEventListener('click', function(){
        ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){
          var e2=document.getElementById(id); if(e2) e2.classList.remove('open');
        });
        toggle();
      });
      ovGrid.appendChild(btn);
    }
    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-drgvalidator')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-drgvalidator';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\uD83C\\uDFE5<br><span>DRG/ICD</span>';
      btn2.addEventListener('click', function(){
        var sh=document.getElementById('dg-tools-sheet'); if(sh) sh.classList.remove('open');
        toggle();
      });
      tsGrid.appendChild(btn2);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDRGUI);
  else setTimeout(initDRGUI, 1050);
}());
/* ---- end drg-icd-validator.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# WRITE TO BUNDLE
# ─────────────────────────────────────────────────────────────────────────────
with open(BUNDLE, 'r') as f:
    content = f.read()

if 'DRGICDValidator' in content:
    print("Sprint 3 already injected.")
    sys.exit(0)

# Add feature flags
OLD_FLAG = '    trustStrip: true,\n  };'
NEW_FLAGS = """    trustStrip: true,
    polyglotWorkbench: true,
    objectSpace: true,
    metricStudio: true,
    dataDiplomacy: true,
    verifiableCheckSeal: true,
    drgIcdValidator: true,
    ncciValidator: true,
  };"""
if OLD_FLAG in content:
    content = content.replace(OLD_FLAG, NEW_FLAGS)
    print("Sprint 3 flags added")
else:
    print("WARNING: flag end not found -- check last flag")

content += '\n' + VCS_BLOCK + '\n' + POLYGLOT_BLOCK + '\n' + METRIC_BLOCK + '\n' + DIPLOMACY_BLOCK + '\n' + DRG_BLOCK

with open(BUNDLE, 'w') as f:
    f.write(content)

print(f"Sprint 3 injected into {BUNDLE}")

with open(BUNDLE, 'r') as f:
    v = f.read()
print(f"  VerifiableCheckSeal: {'VerifiableCheckSeal' in v}")
print(f"  ObjectSpace: {'ObjectSpace' in v}")
print(f"  MetricStudio: {'MetricStudio' in v}")
print(f"  DiplomacyUI: {'DiplomacyUI' in v}")
print(f"  DRGICDValidator: {'DRGICDValidator' in v}")
print(f"  polyglotWorkbench flag: {'polyglotWorkbench: true' in v}")
print(f"  dataDiplomacy flag: {'dataDiplomacy: true' in v}")
print(f"  Lines: {v.count(chr(10))}")
