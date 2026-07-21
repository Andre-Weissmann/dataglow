#!/usr/bin/env python3
"""
Inject all 6 meeting modules into src/js/bundle.js as IIFE-compatible
plain JS blocks, exposing public APIs via window globals.
"""

import re, os, sys

BUNDLE = 'src/js/bundle.js'

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def strip_es_module(src):
    """Remove export keywords, strip top-level import lines."""
    lines = src.split('\n')
    out = []
    for line in lines:
        stripped = line.lstrip()
        # Remove import statements (top-level only — leave dynamic imports)
        if re.match(r'^import\s+', stripped):
            out.append('// [stripped import] ' + line)
            continue
        # Remove export keywords (export function / export const / export async)
        line2 = re.sub(r'\bexport\s+(default\s+)?(function|const|let|var|class|async)\b', lambda m: m.group(2) if not m.group(1) else m.group(2), line)
        # Remove bare `export { ... }` lines
        if re.match(r'^\s*export\s*\{', line2):
            out.append('// [stripped export] ' + line)
            continue
        out.append(line2)
    return '\n'.join(out)

def read(path):
    with open(path, 'r') as f:
        return f.read()

# ─────────────────────────────────────────────────────────────────────────────
# Build the injection block
# ─────────────────────────────────────────────────────────────────────────────

agent_src   = strip_es_module(read('/tmp/meeting-scribe-agent.js'))
ledger_src  = strip_es_module(read('/tmp/meeting-decision-ledger.js'))

# We write the UI inline as self-contained code rather than adapting the full
# ES-module UI files (they import from app-shell utilities that don't exist as
# globals). Instead we use the hand-written IIFE UI from the inject block.

INJECTION = r"""
/* ================================================================
   MEETING SCRIBE — recovered from git history (commit 0662f76)
   Injected by inject_meeting.py
   ================================================================ */

/* ---- from js/agents/meeting-scribe-agent.js ---- */
;(function(){
  'use strict';

""" + agent_src + r"""

  // Expose public API
  window.MeetingScribeAgent = {
    detectPushback: detectPushback,
    detectDataRequest: detectDataRequest,
    tagSegmentsWithContext: tagSegmentsWithContext,
    parseTranscriptText: parseTranscriptText,
    buildActionItem: buildActionItem,
    isActionItemResolved: isActionItemResolved,
    resolveActionItem: resolveActionItem,
    buildMeetingNote: buildMeetingNote,
    PUSHBACK_PHRASES: PUSHBACK_PHRASES,
    DATA_REQUEST_PHRASES: DATA_REQUEST_PHRASES,
  };
}());
/* ---- end meeting-scribe-agent.js ---- */

/* ---- from js/agents/meeting-decision-ledger.js ---- */
;(function(){
  'use strict';

""" + ledger_src + r"""

  // Simple OPFS-backed store
  function createLedgerStore() {
    var OPFS_KEY = '__dg_meeting_ledger__';
    var mem = [];
    function doLoad() {
      if (window.OPFSEngine && typeof OPFSEngine.loadJSON === 'function') {
        return OPFSEngine.loadJSON(OPFS_KEY).then(function(d){ mem = Array.isArray(d) ? d : []; return mem; }).catch(function(){ return mem; });
      }
      return Promise.resolve(mem);
    }
    function doSave() {
      if (window.OPFSEngine && typeof OPFSEngine.saveJSON === 'function') {
        return OPFSEngine.saveJSON(OPFS_KEY, mem).catch(function(){});
      }
      return Promise.resolve();
    }
    return {
      appendLedgerEntries: function(e){ mem = mem.concat(e); return doSave(); },
      getLedgerEntries: function(){ return doLoad(); },
      clearLedgerEntries: function(){ mem = []; return doSave(); },
    };
  }
  var _store = null;
  function getStore(){ if(!_store) _store=createLedgerStore(); return _store; }

  window.MeetingDecisionLedger = {
    buildLedgerEntry: buildLedgerEntry,
    buildLedgerEntriesFromMeeting: buildLedgerEntriesFromMeeting,
    filterLedgerEntries: filterLedgerEntries,
    chartsReferencedIn: chartsReferencedIn,
    exportLedgerEntries: exportLedgerEntries,
    getStore: getStore,
  };
}());
/* ---- end meeting-decision-ledger.js ---- */

/* ---- from js/agents/meeting-scribe-ui.js + meeting-decision-ledger-ui.js ---- */
;(function(){
  'use strict';

  var PANEL_ID = 'dg-meeting-panel';

  /* Tiny el() helper that mirrors bundle.js convention */
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function(k) {
        if (k === 'onclick') e.addEventListener('click', attrs[k]);
        else if (k === 'style') e.style.cssText = attrs[k];
        else e.setAttribute(k, attrs[k]);
      });
    }
    if (typeof children === 'string') { e.textContent = children; }
    else if (Array.isArray(children)) {
      children.forEach(function(c) {
        if (!c) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    } else if (children) { e.appendChild(children); }
    return e;
  }

  function showToastIfAvailable(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
  }

  /* ---- Mount the sliding panel content ---- */
  function mountMeetingPanel() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = '';

    var agent  = window.MeetingScribeAgent;
    var ledger = window.MeetingDecisionLedger;
    if (!agent) {
      panel.appendChild(el('p', { style: 'padding:16px;color:var(--text-muted);font-size:13px;' }, 'Meeting Scribe agent not loaded.'));
      return;
    }

    var meetingId   = 'meeting-' + Date.now();
    var startedAt   = new Date().toISOString();
    var taggedSegs  = [];
    var actionItems = [];
    var store       = ledger ? ledger.getStore() : null;

    /* ── Header ── */
    var hdr = el('div', { style: 'padding:16px 20px 0;' });
    hdr.appendChild(el('h3', { style: 'font-size:15px;font-weight:700;margin:0 0 4px;' }, 'Meeting Notes'));
    hdr.appendChild(el('p', { style: 'font-size:12px;color:var(--text-muted);margin:0 0 14px;line-height:1.5;' },
      'Paste or type what was said. One line per person. Nothing records audio and nothing leaves your device.'));
    panel.appendChild(hdr);

    /* ── Transcript textarea ── */
    var txWrap = el('div', { style: 'padding:0 20px;' });
    var textarea = document.createElement('textarea');
    textarea.rows = 9;
    textarea.placeholder = 'e.g.\nWhy did revenue drop in March?\nCan you also pull the regional breakdown?\nOK, follow up with finance on that by Friday?';
    textarea.style.cssText = 'width:100%;font-family:inherit;font-size:13px;border:1px solid var(--border,#e5e5e5);border-radius:8px;padding:10px;background:var(--surface-alt,#f5f5f5);color:var(--text,#111);resize:vertical;box-sizing:border-box;';
    txWrap.appendChild(textarea);
    panel.appendChild(txWrap);

    /* ── Buttons ── */
    var btnRow = el('div', { style: 'display:flex;gap:8px;padding:10px 20px;' });
    btnRow.appendChild(el('button', {
      style: 'background:var(--primary,#0d6efd);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;',
      onclick: onAnalyze,
    }, 'Analyze'));
    btnRow.appendChild(el('button', {
      style: 'background:none;border:1px solid var(--border,#ccc);border-radius:6px;padding:6px 14px;font-size:12px;color:var(--text-muted,#666);cursor:pointer;font-family:inherit;',
      onclick: function() { textarea.value=''; taggedSegs=[]; renderResults(); },
    }, 'Clear'));
    panel.appendChild(btnRow);

    /* ── Results ── */
    var resultsEl = el('div', { style: 'padding:0 20px;' });
    panel.appendChild(resultsEl);

    /* ── Action items ── */
    var actSection = el('div', { style: 'padding:0 20px;border-top:1px solid var(--border,#e5e5e5);margin-top:12px;' });
    actSection.appendChild(el('div', { style: 'font-size:11px;font-weight:700;color:var(--text-muted,#888);text-transform:uppercase;letter-spacing:.06em;margin:12px 0 8px;' }, 'Action Items'));
    var actNewRow = el('div', { style: 'display:flex;gap:6px;margin-bottom:8px;' });
    var actInput  = document.createElement('input');
    actInput.type = 'text';
    actInput.placeholder = 'New action item...';
    actInput.style.cssText = 'flex:1;border:1px solid var(--border,#ccc);border-radius:6px;padding:5px 10px;font-size:12px;background:var(--surface-alt,#f5f5f5);color:var(--text,#111);font-family:inherit;';
    actInput.addEventListener('keydown', function(e){ if(e.key==='Enter') addActionItem(); });
    actNewRow.appendChild(actInput);
    actNewRow.appendChild(el('button', {
      style: 'background:none;border:1px solid var(--border,#ccc);border-radius:6px;padding:5px 12px;font-size:12px;color:var(--text,#111);cursor:pointer;font-family:inherit;white-space:nowrap;',
      onclick: addActionItem,
    }, '+ Add'));
    actSection.appendChild(actNewRow);
    var actListEl = el('div', {});
    actSection.appendChild(actListEl);
    panel.appendChild(actSection);

    /* ── Decision Ledger section ── */
    var ledgerListEl = null;
    if (store && ledger) {
      var ldgSection = el('div', { style: 'padding:0 20px 20px;border-top:1px solid var(--border,#e5e5e5);margin-top:12px;' });
      ldgSection.appendChild(el('div', { style: 'font-size:11px;font-weight:700;color:var(--text-muted,#888);text-transform:uppercase;letter-spacing:.06em;margin:12px 0 4px;' }, 'Decision Ledger'));
      ldgSection.appendChild(el('p', { style: 'font-size:12px;color:var(--text-muted,#888);margin:0 0 10px;line-height:1.5;' },
        'Save pushback moments, data requests, and action items permanently on this device.'));
      var ldgBtns = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;' });
      ldgBtns.appendChild(el('button', {
        style: 'background:var(--primary,#0d6efd);color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;',
        onclick: onSaveToLedger,
      }, 'Save this meeting'));
      ldgBtns.appendChild(el('button', {
        style: 'background:none;border:1px solid var(--border,#ccc);border-radius:6px;padding:5px 10px;font-size:12px;color:var(--text-muted,#666);cursor:pointer;font-family:inherit;',
        onclick: onExportLedger,
      }, 'Export .json'));
      ldgBtns.appendChild(el('button', {
        style: 'background:none;border:1px solid var(--border,#ccc);border-radius:6px;padding:5px 10px;font-size:12px;color:var(--text-muted,#666);cursor:pointer;font-family:inherit;',
        onclick: onClearLedger,
      }, 'Clear ledger'));
      ldgSection.appendChild(ldgBtns);
      ledgerListEl = el('div', { style: 'max-height:200px;overflow-y:auto;font-size:12px;' });
      ldgSection.appendChild(ledgerListEl);
      panel.appendChild(ldgSection);
      refreshLedgerList();
    }

    /* ── Internals ── */
    function onAnalyze() {
      var segs = agent.parseTranscriptText(textarea.value);
      if (!segs.length) { showToastIfAvailable('Paste at least one line to analyze','warn'); return; }
      taggedSegs = agent.tagSegmentsWithContext(segs, []);
      renderResults();
      showToastIfAvailable('Analyzed ' + segs.length + ' line(s)','success');
    }

    function renderResults() {
      resultsEl.innerHTML = '';
      if (!taggedSegs.length) return;
      var note = agent.buildMeetingNote({ meetingId:meetingId, startedAt:startedAt, taggedSegments:taggedSegs, actionItems:actionItems });
      var sectionLabel = function(txt){ return el('div',{style:'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 4px;color:var(--text-muted,#888);'},txt); };
      if (note.pushbackMoments.length) {
        resultsEl.appendChild(sectionLabel('Pushback moments (' + note.pushbackMoments.length + ')'));
        var ul=el('ul',{style:'margin:0 0 10px;padding-left:18px;font-size:12px;line-height:1.6;'});
        note.pushbackMoments.forEach(function(s){ ul.appendChild(el('li',{},'"'+s.text+'" \u2014 matched "'+s.matched+'"')); });
        resultsEl.appendChild(ul);
      }
      if (note.dataRequests.length) {
        resultsEl.appendChild(sectionLabel('Data requests (' + note.dataRequests.length + ')'));
        var ul2=el('ul',{style:'margin:0 0 10px;padding-left:18px;font-size:12px;line-height:1.6;'});
        note.dataRequests.forEach(function(s){ ul2.appendChild(el('li',{},'"'+s.text+'" \u2014 matched "'+s.matched+'"')); });
        resultsEl.appendChild(ul2);
      }
      if (!note.pushbackMoments.length && !note.dataRequests.length) {
        resultsEl.appendChild(el('p',{style:'font-size:12px;color:var(--text-muted,#888);margin:8px 0;'},'No pushback or data requests detected in '+taggedSegs.length+' line(s).'));
      }
    }

    function addActionItem() {
      var t=actInput.value.trim(); if(!t) return;
      var lastTs=taggedSegs.length?taggedSegs[taggedSegs.length-1].ts:0;
      actionItems.push(agent.buildActionItem({text:t,ts:lastTs}));
      actInput.value=''; renderActionItems();
    }

    function renderActionItems() {
      actListEl.innerHTML='';
      if (!actionItems.length){ actListEl.appendChild(el('p',{style:'font-size:12px;color:var(--text-muted,#888);margin:0;'},'No action items yet.')); return; }
      actionItems.forEach(function(item,idx){
        var resolved=agent.isActionItemResolved(item);
        var row=el('div',{style:'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--border,#e5e5e5);font-size:12px;'});
        var textSp=el('span',{style:'flex:1;min-width:100px;'},item.text);
        var mkIn=function(ph,w,val){var i=document.createElement('input');i.type='text';i.placeholder=ph;i.value=val||'';i.style.cssText='width:'+w+'px;border:1px solid var(--border,#ccc);border-radius:5px;padding:3px 7px;font-size:11px;background:var(--surface-alt,#f5f5f5);color:var(--text,#111);font-family:inherit;';return i;};
        var ownerIn=mkIn('Owner',80,item.owner);
        var dueIn=mkIn('Due',72,item.dueDate);
        var outcomeIn=mkIn('Outcome',100,item.outcome);
        var saveBtn=el('button',{style:'background:none;border:1px solid var(--border,#ccc);border-radius:5px;padding:2px 8px;font-size:11px;color:var(--text-muted,#666);cursor:pointer;font-family:inherit;',onclick:function(){
          actionItems[idx]=agent.resolveActionItem(item,{owner:ownerIn.value,dueDate:dueIn.value,outcome:outcomeIn.value}); renderActionItems();
        }},'Save');
        var statusSp=el('span',{style:'font-size:11px;font-weight:600;color:'+(resolved?'#16a34a':'var(--text-muted,#888)');'},resolved?'Resolved':'Open');
        row.appendChild(textSp);row.appendChild(ownerIn);row.appendChild(dueIn);row.appendChild(outcomeIn);row.appendChild(saveBtn);row.appendChild(statusSp);
        actListEl.appendChild(row);
      });
    }

    function onSaveToLedger() {
      if(!store||!ledger) return;
      if(!taggedSegs.length){ showToastIfAvailable('Analyze a transcript first','warn'); return; }
      var entries=ledger.buildLedgerEntriesFromMeeting({meetingId:meetingId,taggedSegments:taggedSegs,actionItems:actionItems});
      if(!entries.length){ showToastIfAvailable('No pushback, data requests, or action items to save','warn'); return; }
      store.appendLedgerEntries(entries).then(function(){
        showToastIfAvailable('Saved '+entries.length+' entr'+(entries.length===1?'y':'ies')+' to the ledger','success');
        refreshLedgerList();
      });
    }

    function onExportLedger() {
      if(!store||!ledger) return;
      store.getLedgerEntries().then(function(entries){
        if(!entries||!entries.length){ showToastIfAvailable('Nothing to export yet','warn'); return; }
        var json=ledger.exportLedgerEntries(entries);
        var blob=new Blob([json],{type:'application/json'});
        var url=URL.createObjectURL(blob);
        var a=document.createElement('a');
        a.href=url;a.download='dataglow-decision-ledger-'+new Date().toISOString().slice(0,10)+'.json';
        document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
        showToastIfAvailable('Exported '+entries.length+' entries','success');
      });
    }

    function onClearLedger() {
      if(!store) return;
      if(!window.confirm('Clear the entire decision ledger? This cannot be undone.')) return;
      store.clearLedgerEntries().then(function(){ showToastIfAvailable('Ledger cleared','success'); refreshLedgerList(); });
    }

    function refreshLedgerList() {
      if(!store||!ledger||!ledgerListEl) return;
      store.getLedgerEntries().then(function(entries){
        ledgerListEl.innerHTML='';
        if(!entries||!entries.length){ ledgerListEl.appendChild(el('p',{style:'color:var(--text-muted,#888);font-size:12px;margin:0;'},'Nothing saved yet.')); return; }
        var ul=el('ul',{style:'margin:0;padding-left:16px;line-height:1.7;'});
        entries.slice().reverse().forEach(function(e){
          var txt='['+e.kind+'] "'+e.text+'"'+(e.context?' \u2014 '+e.context.chart:'')+(e.kind==='actionItem'?' \u2014 '+e.status:'');
          ul.appendChild(el('li',{style:'font-size:12px;'},txt));
        });
        ledgerListEl.appendChild(ul);
      });
    }

    renderActionItems();
  }

  /* ── Wire Meeting button into the UI after DOM ready ── */
  function initMeetingScribe() {
    /* Create the sliding panel if absent */
    if (!document.getElementById(PANEL_ID)) {
      var panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.cssText = [
        'position:fixed','top:0','right:0','width:360px','max-width:100vw',
        'height:100vh','background:var(--surface,#fff)','border-left:1px solid var(--border,#e5e5e5)',
        'z-index:850','overflow-y:auto','display:none',
        'box-shadow:-8px 0 32px rgba(0,0,0,.18)','transition:transform .25s ease',
      ].join(';');
      var closeX = document.createElement('button');
      closeX.textContent = '\u00D7';
      closeX.style.cssText = 'position:sticky;top:12px;float:right;margin:12px 14px 0 0;background:none;border:none;font-size:20px;color:var(--text-muted,#888);cursor:pointer;z-index:1;';
      closeX.addEventListener('click', function(){ panel.style.display='none'; });
      panel.appendChild(closeX);
      document.body.appendChild(panel);
    }

    function togglePanel() {
      var p = document.getElementById(PANEL_ID);
      if (!p) return;
      if (p.style.display === 'none' || !p.style.display) {
        p.style.display = 'block';
        mountMeetingPanel();
      } else {
        p.style.display = 'none';
      }
    }

    /* Add to desktop agent bar right section */
    var barRight = document.getElementById('agent-bar-right');
    if (barRight && !document.getElementById('dg-meeting-bar-btn')) {
      var btn = document.createElement('button');
      btn.id = 'dg-meeting-bar-btn';
      btn.className = 'agent-btn';
      btn.title = 'Meeting Notes';
      btn.setAttribute('aria-label', 'Meeting Notes');
      btn.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12px;';
      btn.innerHTML = '\uD83D\uDDD2\uFE0F <span>Meeting</span>';
      btn.addEventListener('click', togglePanel);
      barRight.insertBefore(btn, barRight.firstChild);
    }

    /* Add to overflow grid (the desktop More popover) */
    var ovGrid = document.getElementById('dg-overflow-grid');
    if (ovGrid && !document.getElementById('dg-ov-meeting')) {
      var ovBtn = document.createElement('button');
      ovBtn.id = 'dg-ov-meeting';
      ovBtn.className = 'dg-ov-btn';
      ovBtn.innerHTML = '\uD83D\uDDD2\uFE0F<br><span>Meeting</span>';
      ovBtn.addEventListener('click', function(){
        // close overflow popover first
        var pop = document.getElementById('dg-overflow-popover');
        if (pop) pop.classList.remove('open');
        var ov2 = document.getElementById('dg-overflow-overlay');
        if (ov2) ov2.classList.remove('open');
        var moreBtn = document.getElementById('agent-bar-more-btn');
        if (moreBtn) moreBtn.classList.remove('active');
        togglePanel();
      });
      ovGrid.insertBefore(ovBtn, ovGrid.firstChild);
    }

    /* Add to mobile bottom nav tools sheet grid */
    var tsGrid = document.getElementById('dg-tools-sheet-grid');
    if (tsGrid && !document.getElementById('dg-ts-meeting')) {
      var tsBtn = document.createElement('button');
      tsBtn.id = 'dg-ts-meeting';
      tsBtn.className = 'dg-ov-btn';
      tsBtn.innerHTML = '\uD83D\uDDD2\uFE0F<br><span>Meeting</span>';
      tsBtn.addEventListener('click', function(){
        var sheet = document.getElementById('dg-tools-sheet');
        if (sheet) sheet.classList.remove('open');
        var sheetOv = document.getElementById('dg-tools-sheet-overlay');
        if (sheetOv) sheetOv.classList.remove('open');
        togglePanel();
      });
      tsGrid.insertBefore(tsBtn, tsGrid.firstChild);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMeetingScribe);
  } else {
    setTimeout(initMeetingScribe, 400);
  }

  window.mountMeetingPanel = mountMeetingPanel;
}());
/* ---- end meeting-scribe-ui.js + meeting-decision-ledger-ui.js ---- */
"""

# ─────────────────────────────────────────────────────────────────────────────
# Read current bundle.js and append
# ─────────────────────────────────────────────────────────────────────────────
with open(BUNDLE, 'r') as f:
    current = f.read()

if 'MeetingScribeAgent' in current:
    print("Meeting modules already injected, skipping.")
    sys.exit(0)

with open(BUNDLE, 'a') as f:
    f.write('\n')
    f.write(INJECTION)

print("Meeting modules injected into", BUNDLE)

# Verify
with open(BUNDLE, 'r') as f:
    content = f.read()
total_lines = content.count('\n')
has_agent   = 'MeetingScribeAgent' in content
has_ledger  = 'MeetingDecisionLedger' in content
has_panel   = 'dg-meeting-panel' in content
print(f"  Lines: {total_lines}")
print(f"  MeetingScribeAgent: {has_agent}")
print(f"  MeetingDecisionLedger: {has_ledger}")
print(f"  Meeting panel: {has_panel}")
