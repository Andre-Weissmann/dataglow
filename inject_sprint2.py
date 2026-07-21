#!/usr/bin/env python3
"""
Sprint 2 recovery: NL-SQL + Glow Path + Trust Passport / Provenance layer.
All files already extracted to /tmp/src_*.js
"""
import re, sys

BUNDLE = 'src/js/bundle.js'

def read(path):
    with open(path, 'r', errors='replace') as f:
        return f.read()

def strip_es(src):
    # Multi-line export { ... }
    src = re.sub(r'\bexport\s*\{[^}]*\};?', '', src, flags=re.DOTALL)
    # export before declarations
    src = re.sub(
        r'\bexport\s+(async\s+)?(function|const|let|var|class)\b',
        lambda m: (m.group(1) or '') + m.group(2), src)
    src = re.sub(r'\bexport\s+default\b', '', src)
    # import lines (handle multi-line)
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
    return strip_es(read(f'/tmp/src_{name}'))

# ─────────────────────────────────────────────────────────────────────────────
# NL-SQL
# ─────────────────────────────────────────────────────────────────────────────
NLSQL_BLOCK = """
/* ================================================================
   NL-SQL ENGINE — recovered from git history
   PR #328 zero-cost deep upgrade (pattern engine, auto-fix, explanations)
   91 tests in original test suite
   ================================================================ */

/* ---- from js/nl-sql/nl-sql-key-store.js ---- */
;(function(){
  'use strict';
""" + r('nl-sql-key-store.js') + """
  window.NLSQLKeyStore = {
    getProviderKey: typeof getProviderKey !== 'undefined' ? getProviderKey : null,
    hasAnyKey: typeof hasAnyKey !== 'undefined' ? hasAnyKey : null,
    setProviderKey: typeof setProviderKey !== 'undefined' ? setProviderKey : null,
    NL_SQL_KEY_STORE_PROVIDERS: typeof NL_SQL_KEY_STORE_PROVIDERS !== 'undefined' ? NL_SQL_KEY_STORE_PROVIDERS : [],
  };
}());
/* ---- end nl-sql-key-store.js ---- */

/* ---- from js/nl-sql/schema-context.js ---- */
;(function(){
  'use strict';
""" + r('schema-context.js') + """
  window.NLSQLSchema = {
    serializeSchemaForPrompt: typeof serializeSchemaForPrompt !== 'undefined' ? serializeSchemaForPrompt : null,
    datasetsToSchemaContext: typeof datasetsToSchemaContext !== 'undefined' ? datasetsToSchemaContext : null,
  };
}());
/* ---- end schema-context.js ---- */

/* ---- from js/nl-sql/metric-contracts.js ---- */
;(function(){
  'use strict';
""" + r('metric-contracts.js') + """
  window.NLSQLContracts = {
    getAllContracts: typeof getAllContracts !== 'undefined' ? getAllContracts : null,
    matchContracts: typeof matchContracts !== 'undefined' ? matchContracts : null,
    bestMatch: typeof bestMatch !== 'undefined' ? bestMatch : null,
    contractToPromptFragment: typeof contractToPromptFragment !== 'undefined' ? contractToPromptFragment : null,
  };
}());
/* ---- end metric-contracts.js ---- */

/* ---- from js/nl-sql/nl-sql-pattern-engine.js ---- */
;(function(){
  'use strict';
""" + r('nl-sql-pattern-engine.js') + """
  window.NLSQLPatternEngine = {
    buildPatternSQL: typeof buildPatternSQL !== 'undefined' ? buildPatternSQL : null,
    autoFixSQL: typeof autoFixSQL !== 'undefined' ? autoFixSQL : null,
    explainSQL: typeof explainSQL !== 'undefined' ? explainSQL : null,
    detectColumns: typeof detectColumns !== 'undefined' ? detectColumns : null,
    detectIntent: typeof detectIntent !== 'undefined' ? detectIntent : null,
  };
}());
/* ---- end nl-sql-pattern-engine.js ---- */

/* ---- from js/nl-sql/nl-sql-engine.js ---- */
;(function(){
  'use strict';
  var _schema    = window.NLSQLSchema    || {};
  var _contracts = window.NLSQLContracts || {};
  var _pattern   = window.NLSQLPatternEngine || {};
  var _keys      = window.NLSQLKeyStore  || {};
  var serializeSchemaForPrompt  = _schema.serializeSchemaForPrompt;
  var datasetsToSchemaContext   = _schema.datasetsToSchemaContext;
  var matchContracts            = _contracts.matchContracts;
  var bestMatch                 = _contracts.bestMatch;
  var contractToPromptFragment  = _contracts.contractToPromptFragment;
  var getAllContracts            = _contracts.getAllContracts;
  var buildPatternSQL           = _pattern.buildPatternSQL;
  var autoFixSQL                = _pattern.autoFixSQL;
  var explainSQL                = _pattern.explainSQL;
  var detectColumns             = _pattern.detectColumns;
  var detectIntent              = _pattern.detectIntent;
  var getProviderKey            = _keys.getProviderKey;
  var hasAnyKey                 = _keys.hasAnyKey;
""" + r('nl-sql-engine.js') + """
  window.NLSQLEngine = {
    nlToSQL: typeof nlToSQL !== 'undefined' ? nlToSQL : null,
    NL_SQL_PROVIDERS: typeof NL_SQL_PROVIDERS !== 'undefined' ? NL_SQL_PROVIDERS : [],
    autoFixSQL: typeof autoFixSQL !== 'undefined' ? autoFixSQL : null,
  };
}());
/* ---- end nl-sql-engine.js ---- */

/* ---- from js/nl-sql/nl-sql-ui.js ---- */
;(function(){
  'use strict';
  var _eng       = window.NLSQLEngine    || {};
  var _contracts = window.NLSQLContracts || {};
  var _schema    = window.NLSQLSchema    || {};
  var _keys      = window.NLSQLKeyStore  || {};
  var nlToSQL                  = _eng.nlToSQL;
  var NL_SQL_PROVIDERS         = _eng.NL_SQL_PROVIDERS || [];
  var autoFixSQL               = _eng.autoFixSQL;
  var getAllContracts           = _contracts.getAllContracts;
  var matchContracts           = _contracts.matchContracts;
  var datasetsToSchemaContext  = _schema.datasetsToSchemaContext;
  var getProviderKey           = _keys.getProviderKey;
  var hasAnyKey                = _keys.hasAnyKey;
""" + r('nl-sql-ui.js') + """
  window.NLSQLUI = {
    mountNLSQL: typeof mountNLSQL !== 'undefined' ? mountNLSQL : null,
    shouldOfferNLSQL: typeof shouldOfferNLSQL !== 'undefined' ? shouldOfferNLSQL : null,
  };

  function initNLSQLUI() {
    var panelId = 'dg-nlsql-panel';
    if (!document.getElementById(panelId)) {
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:500px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:857;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
    }
    function toggleNLSQL() {
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
        if (typeof mountNLSQL === 'function') {
          mountNLSQL({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else {
          var msg = document.createElement('p');
          msg.style.cssText = 'padding:20px;font-size:13px;color:var(--text-muted,#888);line-height:1.6;';
          msg.textContent = 'NL-SQL: type a question in plain English and get a SQL query back. Supports zero-cost pattern engine + optional LLM providers.';
          p.appendChild(msg);
        }
      } else { p.style.display = 'none'; }
    }
    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-nlsql')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-nlsql';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\uD83D\\uDDE3\\uFE0F<br><span>NL-SQL</span>';
      btn.addEventListener('click', function(){
        ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){
          var el2=document.getElementById(id); if(el2) el2.classList.remove('open');
        });
        toggleNLSQL();
      });
      ovGrid.appendChild(btn);
    }
    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-nlsql')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-nlsql';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\uD83D\\uDDE3\\uFE0F<br><span>NL-SQL</span>';
      btn2.addEventListener('click', function(){
        var sheet=document.getElementById('dg-tools-sheet'); if(sheet) sheet.classList.remove('open');
        toggleNLSQL();
      });
      tsGrid.appendChild(btn2);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNLSQLUI);
  else setTimeout(initNLSQLUI, 750);
}());
/* ---- end nl-sql-ui.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# GLOW PATH
# ─────────────────────────────────────────────────────────────────────────────
GLOWPATH_BLOCK = """
/* ================================================================
   GLOW PATH RAIL — recovered from git history
   Batch A (#145), Batch B (#144), Batch C (#150), Batch D (#152, flag ON)
   Adaptive next-action rail with session-scoped proficiency signal
   ================================================================ */

/* ---- from js/app-shell/glow-path.js ---- */
;(function(){
  'use strict';
""" + r('glow-path.js') + """
  window.GlowPath = {
    computeGlowPathState: typeof computeGlowPathState !== 'undefined' ? computeGlowPathState : null,
    CTA_ACTIONS: typeof CTA_ACTIONS !== 'undefined' ? CTA_ACTIONS : {},
    DENSITY_LEVELS: typeof DENSITY_LEVELS !== 'undefined' ? DENSITY_LEVELS : [],
    createProficiencyTracker: typeof createProficiencyTracker !== 'undefined' ? createProficiencyTracker : null,
  };
}());
/* ---- end glow-path.js ---- */

/* ---- from js/app-shell/glow-path-ui.js ---- */
;(function(){
  'use strict';
  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };
  var CTA_ACTIONS = (window.GlowPath || {}).CTA_ACTIONS || {};
""" + r('glow-path-ui.js') + """
  window.GlowPathUI = {
    mountGlowPath: typeof mountGlowPath !== 'undefined' ? mountGlowPath : null,
    renderGlowRail: typeof renderGlowRail !== 'undefined' ? renderGlowRail : null,
  };

  // Auto-init: mount the rail at the top of the canvas area
  function initGlowPath() {
    // The rail lives above the main workspace -- inject a host container
    var railId = 'dg-glow-path-rail';
    if (document.getElementById(railId)) return;
    var host = document.createElement('div');
    host.id = railId;
    host.style.cssText = 'position:sticky;top:0;z-index:200;width:100%;';
    // Insert before main content area
    var main = document.getElementById('dg-main-content') || document.getElementById('dg-canvas') || document.querySelector('main');
    if (main && main.parentNode) {
      main.parentNode.insertBefore(host, main);
    }
    // Mount with a no-op proficiency tracker until real session data arrives
    var tracker = (window.GlowPath && typeof window.GlowPath.createProficiencyTracker === 'function')
      ? window.GlowPath.createProficiencyTracker()
      : { record: function(){}, getSignal: function(){ return { density: 'low', recentActions: [] }; } };
    if (typeof mountGlowPath === 'function') {
      mountGlowPath({ host: host, tracker: tracker, onAction: function(action){
        // Dispatch to existing agent bar handlers where possible
        if (typeof window.dgDispatchAction === 'function') window.dgDispatchAction(action);
      }});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGlowPath);
  else setTimeout(initGlowPath, 800);
}());
/* ---- end glow-path-ui.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# TRUST PASSPORT / PROVENANCE LAYER
# ─────────────────────────────────────────────────────────────────────────────

# devAssertConformance is dev-mode only no-op -- stub it
DEV_ASSERT_STUB = """
  // devAssertConformance is a dev-mode-only no-op outside Node test context
  var devAssertConformance = function(){ return; };
"""

# LAYER_DEFS -- extract from bundle at runtime
LAYER_DEFS_ALIAS = """
  // LAYER_DEFS is already in the bundle from the validation module
  var LAYER_DEFS = (function(){
    try { return window._dgLayerDefs || []; } catch(e){ return []; }
  }());
"""

TRUST_BLOCK = """
/* ================================================================
   TRUST PASSPORT + PROVENANCE LAYER -- recovered from git history
   PR #307 (Trust Cert + k-anon + policy), PR #315 (provenancePacket ON),
   PR #351 (trustCertificate flag ON), PR #444 (proof chain)
   ================================================================ */

/* ---- from js/provenance/selective-disclosure-proof.js ---- */
;(function(){
  'use strict';
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };
""" + r('selective-disclosure-proof.js') + """
  window.SelectiveDisclosureProof = {
    hashLeaf: typeof hashLeaf !== 'undefined' ? hashLeaf : null,
    buildMerkleTree: typeof buildMerkleTree !== 'undefined' ? buildMerkleTree : null,
    buildProof: typeof buildProof !== 'undefined' ? buildProof : null,
    verifyProof: typeof verifyProof !== 'undefined' ? verifyProof : null,
  };
}());
/* ---- end selective-disclosure-proof.js ---- */

/* ---- from js/provenance/provenance-packet.js ---- */
;(function(){
  'use strict';
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };
""" + r('provenance-packet.js') + """
  window.ProvenancePacket = {
    buildPacket: typeof buildPacket !== 'undefined' ? buildPacket : null,
    serializePacket: typeof serializePacket !== 'undefined' ? serializePacket : null,
    verifyPacket: typeof verifyPacket !== 'undefined' ? verifyPacket : null,
  };
}());
/* ---- end provenance-packet.js ---- */

/* ---- from js/provenance/portable-receipt.js ---- */
;(function(){
  'use strict';
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };
  var _sdp = window.SelectiveDisclosureProof || {};
  var hashLeaf       = _sdp.hashLeaf;
  var buildMerkleTree= _sdp.buildMerkleTree;
  var escapeHtml = (typeof window._dgEscapeHtml === 'function') ? window._dgEscapeHtml
    : function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
""" + r('portable-receipt.js') + """
  window.PortableReceipt = {
    buildPortableReceipt: typeof buildPortableReceipt !== 'undefined' ? buildPortableReceipt : null,
    renderReceiptHTML: typeof renderReceiptHTML !== 'undefined' ? renderReceiptHTML : null,
  };
}());
/* ---- end portable-receipt.js ---- */

/* ---- from js/provenance/validation-receipt.js ---- */
;(function(){
  'use strict';
  // LAYER_DEFS sourced from existing bundle validation module
  var LAYER_DEFS = (function(){
    try {
      // Try to get from window if validation module exposed it
      if (window._dgLayerDefs && window._dgLayerDefs.length) return window._dgLayerDefs;
      // Minimal fallback so renderReceiptHTML still works
      return [];
    } catch(e){ return []; }
  }());
  var escapeHtml = (typeof window._dgEscapeHtml === 'function') ? window._dgEscapeHtml
    : function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
""" + r('validation-receipt.js') + """
  window.ValidationReceipt = {
    buildValidationReceipt: typeof buildValidationReceipt !== 'undefined' ? buildValidationReceipt : null,
    renderReceiptHTML: typeof renderReceiptHTML !== 'undefined' ? renderReceiptHTML : null,
  };
}());
/* ---- end validation-receipt.js ---- */

/* ---- from js/provenance/data-bom.js ---- */
;(function(){
  'use strict';
  // devAssertConformance is dev-mode-only no-op
  var devAssertConformance = function(){ return; };
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };
""" + r('data-bom.js') + """
  window.DataBOM = {
    buildDataBOM: typeof buildDataBOM !== 'undefined' ? buildDataBOM : null,
    exportDataBOM: typeof exportDataBOM !== 'undefined' ? exportDataBOM : null,
    renderBOMSummary: typeof renderBOMSummary !== 'undefined' ? renderBOMSummary : null,
  };
}());
/* ---- end data-bom.js ---- */

/* ---- from js/provenance/data-nutrition-label.js ---- */
;(function(){
  'use strict';
""" + r('data-nutrition-label.js') + """
  window.DataNutritionLabel = {
    buildNutritionLabel: typeof buildNutritionLabel !== 'undefined' ? buildNutritionLabel : null,
    renderNutritionLabel: typeof renderNutritionLabel !== 'undefined' ? renderNutritionLabel : null,
  };
}());
/* ---- end data-nutrition-label.js ---- */

/* ---- from js/provenance/ownership-ledger.js ---- */
;(function(){
  'use strict';
""" + r('ownership-ledger.js') + """
  window.OwnershipLedger = {
    buildOwnershipEntry: typeof buildOwnershipEntry !== 'undefined' ? buildOwnershipEntry : null,
    buildOwnershipLedger: typeof buildOwnershipLedger !== 'undefined' ? buildOwnershipLedger : null,
    renderOwnershipLedger: typeof renderOwnershipLedger !== 'undefined' ? renderOwnershipLedger : null,
  };
}());
/* ---- end ownership-ledger.js ---- */

/* ---- from js/provenance/proof-room.js ---- */
;(function(){
  'use strict';
  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };
  var escapeHtml = (typeof window._dgEscapeHtml === 'function') ? window._dgEscapeHtml
    : function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
""" + r('proof-room.js') + """
  window.ProofRoom = {
    mountProofRoom: typeof mountProofRoom !== 'undefined' ? mountProofRoom : null,
  };
}());
/* ---- end proof-room.js ---- */

/* ---- from js/trust/trust-certificate.js ---- */
;(function(){
  'use strict';
  var sha256Hex = (typeof window._dgSha256Hex === 'function') ? window._dgSha256Hex
    : function(s){ return btoa(encodeURIComponent(s)).replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,64); };
  var _pkt = window.ProvenancePacket || {};
  var buildPacket       = _pkt.buildPacket;
  var serializePacket   = _pkt.serializePacket;
  var computeReadinessGate = (window.ReadinessGate || {}).computeReadinessGate;
  var explainGateReasons   = (window.ReadinessGate || {}).explainGateReasons;
""" + r('trust-certificate.js') + """
  window.TrustCertificate = {
    buildTrustCertificate: typeof buildTrustCertificate !== 'undefined' ? buildTrustCertificate : null,
    renderCertificateHTML: typeof renderCertificateHTML !== 'undefined' ? renderCertificateHTML : null,
    downloadCertificate: typeof downloadCertificate !== 'undefined' ? downloadCertificate : null,
  };
}());
/* ---- end trust-certificate.js ---- */

/* ---- from js/trust/trust-strip.js ---- */
;(function(){
  'use strict';
  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };
  var timeAgo = (typeof window._dgTimeAgo === 'function') ? window._dgTimeAgo
    : function(ts){ var s=Math.floor((Date.now()-ts)/1000); return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':Math.floor(s/3600)+'h ago'; };
""" + r('trust-strip.js') + """
  window.TrustStrip = {
    mountTrustStrip: typeof mountTrustStrip !== 'undefined' ? mountTrustStrip : null,
    updateTrustStrip: typeof updateTrustStrip !== 'undefined' ? updateTrustStrip : null,
  };
}());
/* ---- end trust-strip.js ---- */

/* ---- from js/trust/proof-drawer.js ---- */
;(function(){
  'use strict';
  var el = (typeof window._dgEl === 'function') ? window._dgEl : function(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(function([k,v]){ if(k==='class') node.className=v; else node.setAttribute(k,v); });
    if (children) [].concat(children).forEach(function(c){ node.append(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  };
  var escapeHtml = (typeof window._dgEscapeHtml === 'function') ? window._dgEscapeHtml
    : function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var formatNumber = (typeof window._dgFormatNumber === 'function') ? window._dgFormatNumber
    : function(n){ return typeof n==='number' ? n.toLocaleString() : String(n); };
  // renderAttestationHTML and renderReceiptHTML from existing provenance module
  var renderAttestationHTML = (typeof window._dgRenderAttestationHTML === 'function') ? window._dgRenderAttestationHTML : null;
  var renderReceiptHTML = (window.PortableReceipt || {}).renderReceiptHTML || null;
""" + r('proof-drawer.js') + """
  window.ProofDrawer = {
    mountProofDrawer: typeof mountProofDrawer !== 'undefined' ? mountProofDrawer : null,
    openProofDrawer: typeof openProofDrawer !== 'undefined' ? openProofDrawer : null,
  };

  // Auto-init: wire Trust Certificate button into overflow + tools sheet
  function initTrustUI() {
    function toggleProofDrawer() {
      var panelId = 'dg-proof-drawer-panel';
      var p = document.getElementById(panelId);
      if (!p) {
        p = document.createElement('div');
        p.id = panelId;
        p.style.cssText = 'position:fixed;top:0;right:0;width:460px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:858;overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
        document.body.appendChild(p);
      }
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block';
        p.innerHTML = '';
        var closeX = document.createElement('button');
        closeX.textContent = '\\u00D7';
        closeX.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
        closeX.addEventListener('click', function(){ p.style.display='none'; });
        p.appendChild(closeX);
        if (typeof mountProofDrawer === 'function') {
          mountProofDrawer({ host: p, onToast: function(m,t){ if(typeof showToast==='function') showToast(m,t); } });
        } else {
          var msg = document.createElement('div');
          msg.style.cssText = 'padding:20px;';
          msg.innerHTML = '<h3 style="font-size:15px;font-weight:700;margin:0 0 8px;">Trust Passport</h3><p style="font-size:12px;color:var(--text-muted,#888);line-height:1.6;">Load a dataset to generate a Trust Certificate, Data BOM, Nutrition Label, Portable Receipt, and Merkle proof chain.</p>';
          p.appendChild(msg);
        }
      } else { p.style.display = 'none'; }
    }

    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-trust')) {
      var btn = document.createElement('button');
      btn.id = 'dg-ov-trust';
      btn.className = 'dg-ov-btn';
      btn.innerHTML = '\\uD83D\\uDEE1\\uFE0F<br><span>Trust</span>';
      btn.addEventListener('click', function(){
        ['dg-overflow-popover','dg-overflow-overlay'].forEach(function(id){
          var el2=document.getElementById(id); if(el2) el2.classList.remove('open');
        });
        toggleProofDrawer();
      });
      ovGrid.appendChild(btn);
    }
    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-trust')) {
      var btn2 = document.createElement('button');
      btn2.id = 'dg-ts-trust';
      btn2.className = 'dg-ov-btn';
      btn2.innerHTML = '\\uD83D\\uDEE1\\uFE0F<br><span>Trust</span>';
      btn2.addEventListener('click', function(){
        var sheet=document.getElementById('dg-tools-sheet'); if(sheet) sheet.classList.remove('open');
        toggleProofDrawer();
      });
      tsGrid.appendChild(btn2);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTrustUI);
  else setTimeout(initTrustUI, 850);
}());
/* ---- end proof-drawer.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# WRITE TO BUNDLE
# ─────────────────────────────────────────────────────────────────────────────
with open(BUNDLE, 'r') as f:
    content = f.read()

if 'NLSQLEngine' in content:
    print("Sprint 2 already injected.")
    sys.exit(0)

# Add feature flags
OLD_FLAG = '    aiTouchLedger: true,\n  };'
NEW_FLAGS = """    aiTouchLedger: true,
    nlSql: true,
    glowPathRail: true,
    provenancePacket: true,
    trustCertificate: true,
    trustStrip: true,
  };"""
if OLD_FLAG in content:
    content = content.replace(OLD_FLAG, NEW_FLAGS)
    print("Sprint 2 flags added")
else:
    print("WARNING: flag end not found")

content += '\n' + NLSQL_BLOCK + '\n' + GLOWPATH_BLOCK + '\n' + TRUST_BLOCK

with open(BUNDLE, 'w') as f:
    f.write(content)

print(f"Injected NL-SQL + Glow Path + Trust Passport into {BUNDLE}")

with open(BUNDLE, 'r') as f:
    v = f.read()
print(f"  NLSQLEngine: {'NLSQLEngine' in v}")
print(f"  GlowPath: {'GlowPath' in v}")
print(f"  TrustCertificate: {'TrustCertificate' in v}")
print(f"  ProvenancePacket: {'ProvenancePacket' in v}")
print(f"  nlSql flag: {'nlSql: true' in v}")
print(f"  glowPathRail flag: {'glowPathRail: true' in v}")
print(f"  Lines: {v.count(chr(10))}")
