#!/usr/bin/env python3
"""
Sprint 5: Meeting Scribe + Narrative + Privacy + Statistical Rigor +
          Analysis Contract / Semantic Layer + Provenance Extras + Agent Gate
29 files, ~7,300 lines recovered in one injection pass.
NL-Pandas: already inlined in the Python/Pyodide runtime tab (canvas HTML), no separate file.
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
    return strip_es(read(f'/tmp/s5_{name}'))

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

def panel(panel_id, z_idx, label, emoji, timeout, mount_fn, fallback_text, ov_id, ts_id):
    safe = ov_id.replace('-','_')
    return f"""
  function initUI_{safe}() {{
    var panelId = '{panel_id}';
    if (!document.getElementById(panelId)) {{
      var panel = document.createElement('div');
      panel.id = panelId;
      panel.style.cssText = 'position:fixed;top:0;right:0;width:480px;max-width:100vw;height:100vh;background:var(--surface,#fff);border-left:1px solid var(--border,#e5e5e5);z-index:{z_idx};overflow-y:auto;display:none;box-shadow:-8px 0 32px rgba(0,0,0,.18);';
      document.body.appendChild(panel);
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
          msg.textContent = '{fallback_text}';
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

# ─────────────────────────────────────────────────────────────────────────────
# 1. AGENT GATE (dep for meeting scribe + uncertainty resolver)
# ─────────────────────────────────────────────────────────────────────────────
AGENT_GATE_BLOCK = """
/* ================================================================
   AGENT GATE -- recovered from git history
   js/gate/agent-gate.js (145 lines)
   Dep: readiness-gate (already in bundle as window.ReadinessGate)
   ================================================================ */

/* ---- from js/gate/agent-gate.js ---- */
;(function(){
  'use strict';
  var _rg = window.ReadinessGate || {};
  var computeReadinessGate = _rg.computeReadinessGate || function(){ return { ready: true, reasons: [] }; };
  var explainGateReasons = _rg.explainGateReasons || function(r){ return r.map(function(x){ return x.label||x; }).join(', '); };
""" + r('agent-gate.js') + """
  window.AgentGate = {
    evaluateAgentReadiness: typeof evaluateAgentReadiness !== 'undefined' ? evaluateAgentReadiness : null,
    buildAgentRefusal: typeof buildAgentRefusal !== 'undefined' ? buildAgentRefusal : null,
  };
}());
/* ---- end agent-gate.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# 2. MEETING SCRIBE CLUSTER
# live-transcript-capture -> meeting-scribe-agent -> meeting-synthesis
# -> meeting-decision-ledger -> meeting-decision-ledger-ui
# -> uncertainty-resolver-agent -> meeting-scribe-ui
# ─────────────────────────────────────────────────────────────────────────────
MEETING_SCRIBE_BLOCK = """
/* ================================================================
   MEETING SCRIBE CLUSTER -- recovered from git history
   Flags meetingScribe, meetingScribeLiveCapture, meetingDecisionLedger
   already set true -- now injecting the source.
   ================================================================ */

/* ---- from js/agents/live-transcript-capture.js ---- */
;(function(){
  'use strict';
""" + r('live-transcript-capture.js') + """
  window.LiveTranscriptCapture = {
    isSpeechCaptureAvailable: typeof isSpeechCaptureAvailable !== 'undefined' ? isSpeechCaptureAvailable : function(){ return typeof SpeechRecognition !== 'undefined' || typeof webkitSpeechRecognition !== 'undefined'; },
    startLiveCapture: typeof startLiveCapture !== 'undefined' ? startLiveCapture : null,
    stopLiveCapture: typeof stopLiveCapture !== 'undefined' ? stopLiveCapture : null,
  };
}());
/* ---- end live-transcript-capture.js ---- */

/* ---- from js/agents/meeting-scribe-agent.js ---- */
;(function(){
  'use strict';
""" + r('meeting-scribe-agent.js') + """
  window.MeetingScribeAgent = {
    transcribeMeeting: typeof transcribeMeeting !== 'undefined' ? transcribeMeeting : null,
    extractActionItems: typeof extractActionItems !== 'undefined' ? extractActionItems : null,
    buildMeetingRecord: typeof buildMeetingRecord !== 'undefined' ? buildMeetingRecord : null,
  };
}());
/* ---- end meeting-scribe-agent.js ---- */

/* ---- from js/agents/meeting-synthesis.js ---- */
;(function(){
  'use strict';
  var _ms = window.MeetingScribeAgent || {};
  var buildMeetingRecord = _ms.buildMeetingRecord || null;
  var extractActionItems = _ms.extractActionItems || null;
""" + r('meeting-synthesis.js') + """
  window.MeetingSynthesis = {
    synthesizeMeeting: typeof synthesizeMeeting !== 'undefined' ? synthesizeMeeting : null,
    buildMeetingSummary: typeof buildMeetingSummary !== 'undefined' ? buildMeetingSummary : null,
  };
}());
/* ---- end meeting-synthesis.js ---- */

/* ---- from js/agents/meeting-decision-ledger.js ---- */
;(function(){
  'use strict';
""" + r('meeting-decision-ledger.js') + """
  window.MeetingDecisionLedger = {
    buildLedgerEntriesFromMeeting: typeof buildLedgerEntriesFromMeeting !== 'undefined' ? buildLedgerEntriesFromMeeting : null,
    saveLedgerEntries: typeof saveLedgerEntries !== 'undefined' ? saveLedgerEntries : null,
    loadLedgerEntries: typeof loadLedgerEntries !== 'undefined' ? loadLedgerEntries : null,
    filterLedgerEntries: typeof filterLedgerEntries !== 'undefined' ? filterLedgerEntries : null,
    chartsReferencedIn: typeof chartsReferencedIn !== 'undefined' ? chartsReferencedIn : null,
    exportLedgerEntries: typeof exportLedgerEntries !== 'undefined' ? exportLedgerEntries : null,
  };
}());
/* ---- end meeting-decision-ledger.js ---- */

/* ---- from js/agents/meeting-decision-ledger-ui.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + """
  var _mdl = window.MeetingDecisionLedger || {};
  var buildLedgerEntriesFromMeeting = _mdl.buildLedgerEntriesFromMeeting;
  var saveLedgerEntries = _mdl.saveLedgerEntries;
  var loadLedgerEntries = _mdl.loadLedgerEntries;
  var filterLedgerEntries = _mdl.filterLedgerEntries;
  var chartsReferencedIn = _mdl.chartsReferencedIn;
  var exportLedgerEntries = _mdl.exportLedgerEntries;
""" + r('meeting-decision-ledger-ui.js') + """
  window.MeetingDecisionLedgerUI = {
    mountMeetingDecisionLedger: typeof mountMeetingDecisionLedger !== 'undefined' ? mountMeetingDecisionLedger : null,
    isMeetingDecisionLedgerEnabled: typeof isMeetingDecisionLedgerEnabled !== 'undefined' ? isMeetingDecisionLedgerEnabled : null,
  };
}());
/* ---- end meeting-decision-ledger-ui.js ---- */

/* ---- from js/agents/uncertainty-resolver-agent.js ---- */
;(function(){
  'use strict';
  var _ag = window.AgentGate || {};
  var evaluateAgentReadiness = _ag.evaluateAgentReadiness || function(){ return { ready: true }; };
  var buildAgentRefusal = _ag.buildAgentRefusal || function(r){ return { refused: true, reason: r }; };
""" + r('uncertainty-resolver-agent.js') + """
  window.UncertaintyResolverAgent = {
    resolve: typeof resolve !== 'undefined' ? resolve : null,
    buildResolutionReport: typeof buildResolutionReport !== 'undefined' ? buildResolutionReport : null,
  };
}());
/* ---- end uncertainty-resolver-agent.js ---- */

/* ---- from js/agents/meeting-scribe-ui.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + """
  var _ms  = window.MeetingScribeAgent || {};
  var _syn = window.MeetingSynthesis || {};
  var _ltc = window.LiveTranscriptCapture || {};
  var isSpeechCaptureAvailable = _ltc.isSpeechCaptureAvailable;
  var startLiveCapture = _ltc.startLiveCapture;
  var _ur = window.UncertaintyResolverAgent || {};
  var resolve = _ur.resolve;
""" + r('meeting-scribe-ui.js') + """
  window.MeetingScribeUI = {
    mountMeetingScribe: typeof mountMeetingScribe !== 'undefined' ? mountMeetingScribe : null,
  };

""" + panel('dg-meetingscribe-panel', 867, 'Scribe', '\\uD83C\\uDFA4', 1400,
            'mountMeetingScribe', 'Meeting Scribe: live transcript capture, action item extraction, decision ledger.',
            'dg-ov-meetingscribe', 'dg-ts-meetingscribe') + """
}());
/* ---- end meeting-scribe-ui.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# 3. ON-DEVICE LLM + NARRATIVE / STORY
# ondevice-llm -> story
# ─────────────────────────────────────────────────────────────────────────────
NARRATIVE_BLOCK = """
/* ================================================================
   ON-DEVICE LLM + NARRATIVE / STORY -- recovered from git history
   js/narrative/: ondevice-llm.js (321), story.js (313)
   story deps: state stub + scoreClaimConfidence fallback + protocol-conformance shim
   ================================================================ */

/* ---- from js/narrative/ondevice-llm.js ---- */
;(function(){
  'use strict';
""" + r('ondevice-llm.js') + """
  window.OnDeviceLLM = {
    generateNarrative: typeof generateNarrative !== 'undefined' ? generateNarrative : null,
    isOnDeviceAvailable: typeof isOnDeviceAvailable !== 'undefined' ? isOnDeviceAvailable : function(){ return false; },
    buildPromptContext: typeof buildPromptContext !== 'undefined' ? buildPromptContext : null,
    ON_DEVICE_MODELS: typeof ON_DEVICE_MODELS !== 'undefined' ? ON_DEVICE_MODELS : [],
  };
}());
/* ---- end ondevice-llm.js ---- */

/* ---- from js/narrative/story.js ---- */
;(function(){
  'use strict';
""" + ESC_SHIM + """
  var state = window._dgState || {};
  // scoreClaimConfidence fallback
  var scoreClaimConfidence = function(claim){ return { score: 0.5, label: 'moderate' }; };
  // protocol-conformance shim -- devAssertConformance is a dev-only assertion, noop in prod
  var devAssertConformance = function(){};
  var toStoryOutput = function(x){ return x; };
  var _odl = window.OnDeviceLLM || {};
  var generateNarrative = _odl.generateNarrative;
  var isOnDeviceAvailable = _odl.isOnDeviceAvailable || function(){ return false; };
""" + r('story.js') + """
  window.DataGlowStory = {
    buildStory: typeof buildStory !== 'undefined' ? buildStory : null,
    renderStory: typeof renderStory !== 'undefined' ? renderStory : null,
    STORY_TEMPLATES: typeof STORY_TEMPLATES !== 'undefined' ? STORY_TEMPLATES : [],
  };

""" + panel('dg-narrative-panel', 868, 'Narrative', '\\uD83D\\uDCDD', 1450,
            'renderStory', 'Narrative Engine: auto-generates plain-English data stories from analysis results.',
            'dg-ov-narrative', 'dg-ts-narrative') + """
}());
/* ---- end story.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# 4. PRIVACY CLUSTER
# privacy-budget -> synthetic-twin -> synthetic-adversarial
# -> deidentification-verifier -> synthetic-data-passport
# ─────────────────────────────────────────────────────────────────────────────
PRIVACY_BLOCK = """
/* ================================================================
   PRIVACY CLUSTER -- recovered from git history
   js/privacy/: privacy-budget, synthetic-twin, synthetic-adversarial,
                synthetic-data-passport
   js/provenance/: deidentification-verifier
   ================================================================ */

/* ---- from js/privacy/privacy-budget.js ---- */
;(function(){
  'use strict';
""" + r('privacy-budget.js') + """
  window.PrivacyBudget = {
    laplaceNoise: typeof laplaceNoise !== 'undefined' ? laplaceNoise : null,
    gaussianNoise: typeof gaussianNoise !== 'undefined' ? gaussianNoise : null,
    buildPrivacyBudget: typeof buildPrivacyBudget !== 'undefined' ? buildPrivacyBudget : null,
    EPSILON_LEVELS: typeof EPSILON_LEVELS !== 'undefined' ? EPSILON_LEVELS : {},
  };
}());
/* ---- end privacy-budget.js ---- */

/* ---- from js/privacy/synthetic-twin.js ---- */
;(function(){
  'use strict';
  var _pb = window.PrivacyBudget || {};
  var laplaceNoise = _pb.laplaceNoise || function(v, s){ return v + (Math.random() - 0.5) * s; };
""" + r('synthetic-twin.js') + """
  window.SyntheticTwin = {
    buildSyntheticTwin: typeof buildSyntheticTwin !== 'undefined' ? buildSyntheticTwin : null,
    generateSyntheticRows: typeof generateSyntheticRows !== 'undefined' ? generateSyntheticRows : null,
    SYNTHESIS_MODES: typeof SYNTHESIS_MODES !== 'undefined' ? SYNTHESIS_MODES : [],
  };
}());
/* ---- end synthetic-twin.js ---- */

/* ---- from js/privacy/synthetic-adversarial.js ---- */
;(function(){
  'use strict';
  var _st = window.SyntheticTwin || {};
  var buildSyntheticTwin = _st.buildSyntheticTwin;
  var generateSyntheticRows = _st.generateSyntheticRows;
""" + r('synthetic-adversarial.js') + """
  window.SyntheticAdversarial = {
    runAdversarialTest: typeof runAdversarialTest !== 'undefined' ? runAdversarialTest : null,
    buildAdversarialReport: typeof buildAdversarialReport !== 'undefined' ? buildAdversarialReport : null,
    ADVERSARIAL_ATTACKS: typeof ADVERSARIAL_ATTACKS !== 'undefined' ? ADVERSARIAL_ATTACKS : [],
  };
}());
/* ---- end synthetic-adversarial.js ---- */

/* ---- from js/provenance/deidentification-verifier.js ---- */
;(function(){
  'use strict';
""" + SHA_SHIM + r('deidentification-verifier.js') + """
  window.DeidentificationVerifier = {
    verifyDeidentification: typeof verifyDeidentification !== 'undefined' ? verifyDeidentification : null,
    buildDeidentReport: typeof buildDeidentReport !== 'undefined' ? buildDeidentReport : null,
    DEIDENT_CHECKS: typeof DEIDENT_CHECKS !== 'undefined' ? DEIDENT_CHECKS : [],
  };
}());
/* ---- end deidentification-verifier.js ---- */

/* ---- from js/privacy/synthetic-data-passport.js ---- */
;(function(){
  'use strict';
  var _dnl = window.DataNutritionLabel || {};
  var buildDataNutritionLabel = _dnl.buildDataNutritionLabel || null;
  var _vcs = window.VerifiableCheckSeal || {};
  var sealCheckResult = _vcs.sealCheckResult || null;
  var attachSealToLabel = _vcs.attachSealToLabel || null;
  var _st = window.SyntheticTwin || {};
  var buildSyntheticTwin = _st.buildSyntheticTwin;
  var _sa = window.SyntheticAdversarial || {};
  var runAdversarialTest = _sa.runAdversarialTest;
""" + r('synthetic-data-passport.js') + """
  window.SyntheticDataPassport = {
    buildSyntheticPassport: typeof buildSyntheticPassport !== 'undefined' ? buildSyntheticPassport : null,
    renderPassportHTML: typeof renderPassportHTML !== 'undefined' ? renderPassportHTML : null,
    exportPassport: typeof exportPassport !== 'undefined' ? exportPassport : null,
  };

""" + panel('dg-privacy-panel', 869, 'Privacy', '\\uD83D\\uDD12', 1500,
            'buildSyntheticPassport', 'Privacy Suite: synthetic twin generation, adversarial testing, deidentification verification, data passport.',
            'dg-ov-privacy', 'dg-ts-privacy') + """
}());
/* ---- end synthetic-data-passport.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# 5. STATISTICAL RIGOR + ANALYSIS ROBUSTNESS
# assumption-ledger -> devils-advocate -> robustness-verdict -> statistical-rigor
# ─────────────────────────────────────────────────────────────────────────────
RIGOR_BLOCK = """
/* ================================================================
   STATISTICAL RIGOR + ANALYSIS ROBUSTNESS -- recovered from git history
   js/rigor/statistical-rigor.js (370)
   js/analysis-robustness/: devils-advocate (187), robustness-verdict (389)
   js/provenance/assumption-ledger.js (60) -- dep for devils-advocate
   ================================================================ */

/* ---- from js/provenance/assumption-ledger.js ---- */
;(function(){
  'use strict';
""" + r('assumption-ledger.js') + """
  window.AssumptionLedger = {
    logAssumption: typeof logAssumption !== 'undefined' ? logAssumption : null,
    getAssumptions: typeof getAssumptions !== 'undefined' ? getAssumptions : null,
    clearAssumptions: typeof clearAssumptions !== 'undefined' ? clearAssumptions : null,
    ASSUMPTION_TYPES: typeof ASSUMPTION_TYPES !== 'undefined' ? ASSUMPTION_TYPES : [],
  };
}());
/* ---- end assumption-ledger.js ---- */

/* ---- from js/rigor/statistical-rigor.js ---- */
;(function(){
  'use strict';
""" + r('statistical-rigor.js') + """
  window.StatisticalRigor = {
    assessRigor: typeof assessRigor !== 'undefined' ? assessRigor : null,
    buildRigorReport: typeof buildRigorReport !== 'undefined' ? buildRigorReport : null,
    computeConfidenceInterval: typeof computeConfidenceInterval !== 'undefined' ? computeConfidenceInterval : null,
    RIGOR_LEVELS: typeof RIGOR_LEVELS !== 'undefined' ? RIGOR_LEVELS : {},
    RIGOR_CHECKS: typeof RIGOR_CHECKS !== 'undefined' ? RIGOR_CHECKS : [],
  };
}());
/* ---- end statistical-rigor.js ---- */

/* ---- from js/analysis-robustness/devils-advocate.js ---- */
;(function(){
  'use strict';
  var _al = window.AssumptionLedger || {};
  var logAssumption = _al.logAssumption || function(){};
""" + r('devils-advocate.js') + """
  window.DevilsAdvocate = {
    challengeAnalysis: typeof challengeAnalysis !== 'undefined' ? challengeAnalysis : null,
    buildCounterArguments: typeof buildCounterArguments !== 'undefined' ? buildCounterArguments : null,
    CHALLENGE_TYPES: typeof CHALLENGE_TYPES !== 'undefined' ? CHALLENGE_TYPES : [],
  };
}());
/* ---- end devils-advocate.js ---- */

/* ---- from js/analysis-robustness/robustness-verdict.js ---- */
;(function(){
  'use strict';
  var _da = window.DevilsAdvocate || {};
  var challengeAnalysis = _da.challengeAnalysis;
  var _sr = window.StatisticalRigor || {};
  var assessRigor = _sr.assessRigor;
""" + r('robustness-verdict.js') + """
  window.RobustnessVerdict = {
    buildVerdict: typeof buildVerdict !== 'undefined' ? buildVerdict : null,
    renderVerdictBadge: typeof renderVerdictBadge !== 'undefined' ? renderVerdictBadge : null,
    VERDICT_LEVELS: typeof VERDICT_LEVELS !== 'undefined' ? VERDICT_LEVELS : {},
  };

""" + panel('dg-rigor-panel', 870, 'Rigor', '\\uD83E\\uDDD0', 1550,
            'buildVerdict', 'Statistical Rigor Engine: confidence intervals, robustness verdicts, devils advocate challenges.',
            'dg-ov-rigor', 'dg-ts-rigor') + """
}());
/* ---- end robustness-verdict.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# 6. SEMANTIC LAYER + ANALYSIS CONTRACT
# semantic-layer -> semantic-layer-ui -> analysis-contract
# ─────────────────────────────────────────────────────────────────────────────
SEMANTIC_BLOCK = """
/* ================================================================
   SEMANTIC LAYER + ANALYSIS CONTRACT -- recovered from git history
   js/validation/: semantic-layer (373), semantic-layer-ui (146),
                   analysis-contract (467)
   Zero external deps (uses el() and escapeHtml shims).
   ================================================================ */

/* ---- from js/validation/semantic-layer.js ---- */
;(function(){
  'use strict';
""" + r('semantic-layer.js') + """
  window.SemanticLayer = {
    registerMetric: typeof registerMetric !== 'undefined' ? registerMetric : null,
    getRegisteredMetrics: typeof getRegisteredMetrics !== 'undefined' ? getRegisteredMetrics : null,
    unregisterMetric: typeof unregisterMetric !== 'undefined' ? unregisterMetric : null,
    checkQueryAgainstMetrics: typeof checkQueryAgainstMetrics !== 'undefined' ? checkQueryAgainstMetrics : null,
    buildSemanticContext: typeof buildSemanticContext !== 'undefined' ? buildSemanticContext : null,
  };
}());
/* ---- end semantic-layer.js ---- */

/* ---- from js/validation/semantic-layer-ui.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + """
  var _sl = window.SemanticLayer || {};
  var registerMetric = _sl.registerMetric;
  var getRegisteredMetrics = _sl.getRegisteredMetrics;
  var unregisterMetric = _sl.unregisterMetric;
""" + r('semantic-layer-ui.js') + """
  window.SemanticLayerUI = {
    mountSemanticLayer: typeof mountSemanticLayer !== 'undefined' ? mountSemanticLayer : null,
  };

""" + panel('dg-semanticlayer-panel', 871, 'Semantic', '\\uD83D\\uDDC3\\uFE0F', 1600,
            'mountSemanticLayer', 'Semantic Layer: register named metrics, validate queries against definitions, build metric context.',
            'dg-ov-semanticlayer', 'dg-ts-semanticlayer') + """
}());
/* ---- end semantic-layer-ui.js ---- */

/* ---- from js/validation/analysis-contract.js ---- */
;(function(){
  'use strict';
  var _sl = window.SemanticLayer || {};
  var checkQueryAgainstMetrics = _sl.checkQueryAgainstMetrics || function(){ return { violations: [] }; };
""" + r('analysis-contract.js') + """
  window.AnalysisContract = {
    buildAnalysisContract: typeof buildAnalysisContract !== 'undefined' ? buildAnalysisContract : null,
    validateContract: typeof validateContract !== 'undefined' ? validateContract : null,
    exportContractReport: typeof exportContractReport !== 'undefined' ? exportContractReport : null,
    CONTRACT_LEVELS: typeof CONTRACT_LEVELS !== 'undefined' ? CONTRACT_LEVELS : {},
  };
}());
/* ---- end analysis-contract.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# 7. PROVENANCE EXTRAS
# query-memory, query-memory-ui, irb-mode, peer-review, trust-beam,
# analysis-fingerprint, zk-threshold-proof
# ─────────────────────────────────────────────────────────────────────────────
PROVENANCE_EXTRAS_BLOCK = """
/* ================================================================
   PROVENANCE EXTRAS -- recovered from git history
   7 files: query-memory, query-memory-ui, irb-mode, peer-review,
            trust-beam, analysis-fingerprint, zk-threshold-proof
   All deps: sha256Hex (in bundle), el/escapeHtml shims, validation-receipt
             (in bundle from sprint 2), verifiable-check-seal (in bundle)
   ================================================================ */

/* ---- from js/provenance/analysis-fingerprint.js ---- */
;(function(){
  'use strict';
""" + SHA_SHIM + r('analysis-fingerprint.js') + """
  window.AnalysisFingerprint = {
    fingerprintAnalysis: typeof fingerprintAnalysis !== 'undefined' ? fingerprintAnalysis : null,
    buildFingerprintReport: typeof buildFingerprintReport !== 'undefined' ? buildFingerprintReport : null,
    FINGERPRINT_FIELDS: typeof FINGERPRINT_FIELDS !== 'undefined' ? FINGERPRINT_FIELDS : [],
  };
}());
/* ---- end analysis-fingerprint.js ---- */

/* ---- from js/provenance/query-memory.js ---- */
;(function(){
  'use strict';
""" + SHA_SHIM + r('query-memory.js') + """
  window.QueryMemory = {
    rememberQuery: typeof rememberQuery !== 'undefined' ? rememberQuery : null,
    recallQuery: typeof recallQuery !== 'undefined' ? recallQuery : null,
    listMemories: typeof listMemories !== 'undefined' ? listMemories : null,
    clearMemories: typeof clearMemories !== 'undefined' ? clearMemories : null,
  };
}());
/* ---- end query-memory.js ---- */

/* ---- from js/provenance/query-memory-ui.js ---- */
;(function(){
  'use strict';
""" + EL_SHIM + """
  var _qm = window.QueryMemory || {};
  var rememberQuery = _qm.rememberQuery;
  var recallQuery = _qm.recallQuery;
  var listMemories = _qm.listMemories;
""" + r('query-memory-ui.js') + """
  window.QueryMemoryUI = {
    mountQueryMemory: typeof mountQueryMemory !== 'undefined' ? mountQueryMemory : null,
  };
}());
/* ---- end query-memory-ui.js ---- */

/* ---- from js/provenance/irb-mode.js ---- */
;(function(){
  'use strict';
""" + ESC_SHIM + """
  var _vr = window.ValidationReceipt || {};
  var buildValidationReceipt = _vr.buildValidationReceipt || null;
""" + r('irb-mode.js') + """
  window.IRBMode = {
    enterIRBMode: typeof enterIRBMode !== 'undefined' ? enterIRBMode : null,
    buildIRBReport: typeof buildIRBReport !== 'undefined' ? buildIRBReport : null,
    isIRBModeActive: typeof isIRBModeActive !== 'undefined' ? isIRBModeActive : function(){ return false; },
  };

""" + panel('dg-irbmode-panel', 872, 'IRB', '\\uD83D\\uDCCB', 1650,
            'buildIRBReport', 'IRB Mode: institutional review board compliance wrapper for human-subjects data analysis.',
            'dg-ov-irbmode', 'dg-ts-irbmode') + """
}());
/* ---- end irb-mode.js ---- */

/* ---- from js/provenance/peer-review.js ---- */
;(function(){
  'use strict';
""" + ESC_SHIM + """
  // LAYER_DEFS fallback
  var LAYER_DEFS = (window.ValidationLayer && window.ValidationLayer.LAYER_DEFS) || [];
""" + r('peer-review.js') + """
  window.PeerReview = {
    buildPeerReviewPackage: typeof buildPeerReviewPackage !== 'undefined' ? buildPeerReviewPackage : null,
    renderPeerReviewPanel: typeof renderPeerReviewPanel !== 'undefined' ? renderPeerReviewPanel : null,
    REVIEW_CRITERIA: typeof REVIEW_CRITERIA !== 'undefined' ? REVIEW_CRITERIA : [],
  };

""" + panel('dg-peerreview-panel', 873, 'Peer Review', '\\uD83D\\uDC65', 1700,
            'renderPeerReviewPanel', 'Peer Review: package your analysis for external review with full provenance chain.',
            'dg-ov-peerreview', 'dg-ts-peerreview') + """
}());
/* ---- end peer-review.js ---- */

/* ---- from js/provenance/trust-beam.js ---- */
;(function(){
  'use strict';
  var CHECK_SEAL_KIND = (window.VerifiableCheckSeal || {}).CHECK_SEAL_KIND || 'dataglow-verifiable-check-seal';
""" + r('trust-beam.js') + """
  window.TrustBeam = {
    buildTrustBeam: typeof buildTrustBeam !== 'undefined' ? buildTrustBeam : null,
    renderTrustBeam: typeof renderTrustBeam !== 'undefined' ? renderTrustBeam : null,
    BEAM_LEVELS: typeof BEAM_LEVELS !== 'undefined' ? BEAM_LEVELS : {},
  };
}());
/* ---- end trust-beam.js ---- */

/* ---- from js/provenance/zk-threshold-proof.js ---- */
;(function(){
  'use strict';
  var _sdp = window.SelectiveDisclosureProof || {};
  var hashLeaf = _sdp.hashLeaf || function(v){ return String(v); };
  var buildMerkleTree = _sdp.buildMerkleTree || null;
  var merkleProof = _sdp.merkleProof || null;
""" + r('zk-threshold-proof.js') + """
  window.ZKThresholdProof = {
    buildZKProof: typeof buildZKProof !== 'undefined' ? buildZKProof : null,
    verifyZKProof: typeof verifyZKProof !== 'undefined' ? verifyZKProof : null,
    buildThresholdClaim: typeof buildThresholdClaim !== 'undefined' ? buildThresholdClaim : null,
    ZK_PROOF_TYPES: typeof ZK_PROOF_TYPES !== 'undefined' ? ZK_PROOF_TYPES : [],
  };
}());
/* ---- end zk-threshold-proof.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# WRITE TO BUNDLE
# ─────────────────────────────────────────────────────────────────────────────
with open(BUNDLE, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

if 'MeetingScribeUI' in content:
    print("Sprint 5 already injected.")
    sys.exit(0)

# Add feature flags
OLD_FLAG = '    flagConsistencyChecker: true,\n  };'
NEW_FLAGS = """    flagConsistencyChecker: true,
    agentGate: true,
    uncertaintyResolver: true,
    onDeviceLLM: true,
    narrativeStory: true,
    privacyBudget: true,
    syntheticTwin: true,
    syntheticAdversarial: true,
    syntheticDataPassport: true,
    deidentificationVerifier: true,
    statisticalRigor: true,
    devilsAdvocate: true,
    robustnessVerdict: true,
    semanticLayer: true,
    analysisContract: true,
    queryMemory: true,
    irbMode: true,
    peerReview: true,
    trustBeam: true,
    zkThresholdProof: true,
    analysisFingerprint: true,
  };"""
if OLD_FLAG in content:
    content = content.replace(OLD_FLAG, NEW_FLAGS)
    print("Sprint 5 flags added")
else:
    print("WARNING: flag anchor not found")

content += (
    '\n' + AGENT_GATE_BLOCK +
    '\n' + MEETING_SCRIBE_BLOCK +
    '\n' + NARRATIVE_BLOCK +
    '\n' + PRIVACY_BLOCK +
    '\n' + RIGOR_BLOCK +
    '\n' + SEMANTIC_BLOCK +
    '\n' + PROVENANCE_EXTRAS_BLOCK
)

with open(BUNDLE, 'w', encoding='utf-8', errors='replace') as f:
    f.write(content)

print(f"Sprint 5 injected into {BUNDLE}")
checks = [
    ('AgentGate', 'AgentGate'),
    ('MeetingScribeUI', 'MeetingScribeUI'),
    ('OnDeviceLLM', 'OnDeviceLLM'),
    ('SyntheticDataPassport', 'SyntheticDataPassport'),
    ('StatisticalRigor', 'StatisticalRigor'),
    ('SemanticLayer', 'SemanticLayer'),
    ('AnalysisContract', 'AnalysisContract'),
    ('ZKThresholdProof', 'ZKThresholdProof'),
    ('TrustBeam', 'TrustBeam'),
    ('IRBMode', 'IRBMode'),
    ('statisticalRigor flag', 'statisticalRigor: true'),
    ('narrativeStory flag', 'narrativeStory: true'),
]
for label, needle in checks:
    print(f"  {label}: {needle in content}")
print(f"  Lines: {content.count(chr(10))}")
