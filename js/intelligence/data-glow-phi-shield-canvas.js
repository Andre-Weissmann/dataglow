/* ---- from js/intelligence/data-glow-phi-shield-canvas.js ---- */
;(function () {
  'use strict';

  var PANEL_ID = 'dg-phi-shield-panel';
  var BTN_ID = 'dg-phi-shield-btn';
  var SAMPLE_CAP = 400;
  var _last = null;
  var _dataset = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[PHI Shield]', msg);
  }

  function flagOn() {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('phiShield') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function colNames(ds) {
    var cols = (ds && ds.columns) || [];
    return cols.map(function (c, i) {
      if (typeof c === 'string') return c;
      return (c && (c.name || c.field)) || ('col' + i);
    });
  }

  function colTypes(ds) {
    var cols = (ds && ds.columns) || [];
    return cols.map(function (c, i) {
      if (typeof c === 'string') return { name: c, type: 'STR' };
      return {
        name: (c && (c.name || c.field)) || ('col' + i),
        type: (c && c.type) || 'STR'
      };
    });
  }

  function buildSamples(ds) {
    var names = colNames(ds);
    var rows = (ds && ds.rows) || [];
    var n = Math.min(rows.length, SAMPLE_CAP);
    var samples = {};
    for (var i = 0; i < names.length; i++) samples[names[i]] = [];
    for (var r = 0; r < n; r++) {
      var row = rows[r];
      for (var c = 0; c < names.length; c++) {
        var v = Array.isArray(row) ? row[c] : (row ? row[names[c]] : null);
        if (v != null && v !== '') samples[names[c]].push(v);
      }
    }
    return samples;
  }

  function objectRowsSample(ds) {
    var names = colNames(ds);
    var rows = (ds && ds.rows) || [];
    var n = Math.min(rows.length, 40);
    var out = [];
    for (var r = 0; r < n; r++) {
      var row = rows[r];
      var o = {};
      for (var c = 0; c < names.length; c++) {
        o[names[c]] = Array.isArray(row) ? row[c] : (row ? row[names[c]] : null);
      }
      out.push(o);
    }
    return out;
  }

  /**
   * One scan path — Safe Harbor screen + prompt-guard column/value patterns.
   * Always on-device. Never uploads.
   */
  function scanDataset(ds) {
    if (!ds) return null;
    var columns = colTypes(ds);
    var names = colNames(ds);
    var samples = buildSamples(ds);
    var rowCount = (ds.rows && ds.rows.length) || 0;

    var deid = null;
    var DV = window.DeidentificationVerifier;
    if (DV && typeof DV.buildDeidReport === 'function') {
      try {
        deid = DV.buildDeidReport({
          columns: columns,
          samples: samples,
          table: ds.name || ds.table || 'dataset',
          rowCount: rowCount
        });
      } catch (e) {
        console.warn('[PHI Shield] deid report failed', e);
      }
    }

    var sensitiveCols = [];
    var PG = window.PhiPromptGuard;
    if (PG && typeof PG.classifySensitiveColumns === 'function') {
      try { sensitiveCols = PG.classifySensitiveColumns(names) || []; } catch (_e2) {}
    }

    var patternFindings = [];
    var patternHits = 0;
    if (PG && typeof PG.redactSensitiveText === 'function') {
      for (var i = 0; i < names.length; i++) {
        var vals = samples[names[i]] || [];
        var colHits = 0;
        for (var j = 0; j < vals.length; j++) {
          if (typeof vals[j] !== 'string') continue;
          var rr = PG.redactSensitiveText(String(vals[j]));
          if (rr.findings && rr.findings.length) {
            colHits++;
            patternHits += rr.findings.length;
            for (var k = 0; k < rr.findings.length; k++) {
              patternFindings.push({
                column: names[i],
                pattern: rr.findings[k].pattern || rr.findings[k].type,
                count: rr.findings[k].count || 1
              });
            }
          }
        }
        if (colHits > 0 && sensitiveCols.indexOf(names[i]) === -1) {
          /* value-pattern only column */
        }
      }
    }

    /* Prompt-path dry run: would sample rows be safe for any LLM? */
    var guard = null;
    if (PG && typeof PG.guardPromptPayload === 'function') {
      try {
        guard = PG.guardPromptPayload({
          text: 'Summarize trends for leadership',
          rows: objectRowsSample(ds),
          columns: names
        });
      } catch (_e3) {}
    }

    var verdict = (deid && deid.verdict) || 'review';
    var flaggedCount = (deid && deid.safeHarbor && deid.safeHarbor.flaggedCount) || 0;
    if (patternHits > 0 && verdict === 'pass') verdict = 'review';
    if (flaggedCount > 0) verdict = 'fail';
    if ((deid && deid.reidentification && deid.reidentification.level === 'high')) verdict = 'fail';

    var status = verdict; /* pass | review | fail */

    var report = {
      generatedAt: new Date().toISOString(),
      platform: 'web+desktop+pwa',
      onDevice: true,
      network: false,
      verdict: verdict,
      status: status,
      rowCount: rowCount,
      columnCount: names.length,
      deid: deid,
      sensitiveColumns: sensitiveCols,
      patternFindings: patternFindings.slice(0, 40),
      patternHitCount: patternHits,
      guard: guard ? {
        sensitiveFound: !!guard.sensitiveFound,
        droppedColumns: guard.droppedColumns || [],
        findingCount: (guard.findings || []).length
      } : null,
      disclaimer:
        'Automated PHI / Safe Harbor screening aid only. Not a HIPAA certification, legal determination, or permission to share data.'
    };

    /* Soft-mark column health for canvas grid dots when available */
    try {
      if (ds && Array.isArray(ds.columns)) {
        var hot = {};
        sensitiveCols.forEach(function (n) { hot[n] = 1; });
        if (deid && deid.safeHarbor && Array.isArray(deid.safeHarbor.categories)) {
          deid.safeHarbor.categories.forEach(function (cat) {
            (cat.matchedColumns || cat.columns || []).forEach(function (n) {
              var name = typeof n === 'string' ? n : (n && (n.column || n.name));
              if (name) hot[name] = 1;
            });
          });
        }
        patternFindings.forEach(function (f) { if (f.column) hot[f.column] = 1; });
        var health = [];
        for (var ci = 0; ci < names.length; ci++) {
          health[ci] = hot[names[ci]] ? 'amber' : (ds.columnHealth && ds.columnHealth[ci]) || 'green';
        }
        ds.columnHealth = health;
      }
    } catch (_eH) {}

    _last = report;
    _dataset = ds;
    return report;
  }

  function statusLabel(st) {
    if (st === 'pass') return 'Clear';
    if (st === 'fail') return 'PHI risk';
    return 'Review';
  }

  function statusColor(st) {
    if (st === 'pass') return 'var(--proof, #4AE38A)';
    if (st === 'fail') return 'var(--error, #E85D4C)';
    return 'var(--flag, #F5A623)';
  }

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'PHI Shield');
    panel.innerHTML =
      '<div style="width:36px;height:4px;border-radius:2px;background:var(--border);margin:10px auto 0;flex-shrink:0"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--border);gap:10px">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:800;font-size:15px">PHI Shield</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">On-device · never uploads rows</div>' +
        '</div>' +
        '<button type="button" data-phi-close style="min-height:44px;min-width:44px;border:none;background:transparent;color:var(--text-muted);font-size:22px;cursor:pointer;border-radius:10px" aria-label="Close">\u00D7</button>' +
      '</div>' +
      '<div id="dg-phi-shield-body" style="flex:1;overflow-y:auto;padding:14px 16px;-webkit-overflow-scrolling:touch"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-phi-close]').addEventListener('click', closePanel);
    return panel;
  }

  function renderBody(report) {
    var body = document.getElementById('dg-phi-shield-body');
    if (!body) return;
    if (!report) {
      body.innerHTML = '<div class="dg-phi-card" style="color:var(--text-muted)">Load a dataset to scan for PHI patterns. Everything stays on this device.</div>';
      return;
    }
    var st = report.status || report.verdict || 'review';
    var sh = report.deid && report.deid.safeHarbor;
    var re = report.deid && report.deid.reidentification;
    var cats = (sh && sh.categories) || [];
    var flagged = cats.filter(function (c) {
      return c.status === 'flag' || (c.matchedColumns && c.matchedColumns.length) || c.flagged;
    });

    function colNamesFromMatched(arr) {
      if (!arr || !arr.length) return [];
      return arr.map(function (m) {
        if (typeof m === 'string') return m;
        return (m && (m.column || m.name)) || '';
      }).filter(Boolean);
    }

    var catHtml = flagged.slice(0, 12).map(function (c) {
      var cols = colNamesFromMatched(c.matchedColumns || c.columns || []);
      return '<div style="margin-bottom:8px"><div style="font-weight:700;font-size:12px">' + esc(c.label || c.id) +
        '</div><div style="font-size:11px;color:var(--text-muted)">' + esc(cols.join(', ') || 'flagged') + '</div></div>';
    }).join('') || '<div style="color:var(--text-muted);font-size:12px">No Safe Harbor name/value hits in sample.</div>';

    var sens = (report.sensitiveColumns || []).map(function (n) {
      return '<span class="dg-phi-chip hot">' + esc(n) + '</span>';
    }).join('') || '<span style="color:var(--text-muted);font-size:12px">None by column-name rules</span>';

    var aiLine = report.guard && report.guard.sensitiveFound
      ? 'AI paths would redact ' + esc((report.guard.droppedColumns || []).length) + ' column(s) and ' +
        esc(report.guard.findingCount) + ' finding(s) before any model sees text.'
      : 'AI paths: sample looks clean for prompt guard (still never auto-sends rows).';

    body.innerHTML =
      '<div class="dg-phi-card" style="border-color:' + statusColor(st) + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
          '<div><div style="font-size:11px;color:var(--text-muted);letter-spacing:.04em">STATUS</div>' +
          '<div style="font-size:22px;font-weight:800;color:' + statusColor(st) + '">' + esc(statusLabel(st)) + '</div></div>' +
          '<div style="text-align:right;font-size:11px;color:var(--text-muted)">' +
            esc(report.rowCount) + ' rows<br>' + esc(report.columnCount) + ' cols</div>' +
        '</div>' +
        '<div style="margin-top:10px;font-size:12px;line-height:1.5;color:var(--text)">' +
          esc(re && re.rationale ? re.rationale : 'Screening complete on device.') +
        '</div>' +
      '</div>' +

      '<div class="dg-phi-card">' +
        '<div style="font-weight:800;margin-bottom:8px">How protection works</div>' +
        '<div style="font-size:12px;line-height:1.55;color:var(--text-secondary,var(--text-muted))">' +
          'One default: <b style="color:var(--text)">protect</b>. No model picker. ' +
          'Rows stay on this phone, desktop, or browser. Optional cloud is off unless you turn it on. ' +
          'AI may draft; DuckDB proves numbers. Language never overrides verified results.' +
        '</div>' +
      '</div>' +

      '<div class="dg-phi-card">' +
        '<div style="font-weight:800;margin-bottom:8px">Safe Harbor screen</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Flagged categories (sample-based)</div>' +
        catHtml +
      '</div>' +

      '<div class="dg-phi-card">' +
        '<div style="font-weight:800;margin-bottom:8px">Sensitive columns</div>' +
        '<div>' + sens + '</div>' +
        '<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">' +
          'Value-pattern hits in sample: <b style="color:var(--text)">' + esc(report.patternHitCount) + '</b></div>' +
      '</div>' +

      '<div class="dg-phi-card">' +
        '<div style="font-weight:800;margin-bottom:6px">AI safety layer</div>' +
        '<div style="font-size:12px;line-height:1.5;color:var(--text-secondary,var(--text-muted))">' + esc(aiLine) + '</div>' +
      '</div>' +

      '<div style="font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted));padding:4px 2px 8px">' +
        esc(report.disclaimer) +
      '</div>' +

      '<div class="dg-phi-actions">' +
        '<button type="button" class="primary" data-phi-rescan>Scan again</button>' +
        '<button type="button" class="ghost" data-phi-export>Download report</button>' +
        '<button type="button" class="ghost" data-phi-datalens>Open DataLens</button>' +
      '</div>';

    var rescan = body.querySelector('[data-phi-rescan]');
    if (rescan) rescan.onclick = function () {
      var ds = _dataset || (typeof getActiveDataset === 'function' ? getActiveDataset() : null);
      if (!ds && window.state && window.state.datasets && window.state.datasets[0]) ds = window.state.datasets[0];
      if (!ds) { toast('Load data first', 'warn'); return; }
      var rep = scanDataset(ds);
      updateBadge(rep);
      renderBody(rep);
      toast('PHI Shield rescanned on device');
    };
    var exp = body.querySelector('[data-phi-export]');
    if (exp) exp.onclick = function () { downloadReport(report); };
    var dl = body.querySelector('[data-phi-datalens]');
    if (dl) dl.onclick = function () {
      if (window.DataLens && window.DataLens.openPanel) window.DataLens.openPanel();
    };
  }

  function downloadReport(report) {
    try {
      var blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'dataglow-phi-shield-' + Date.now() + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast('Report downloaded (local file only)');
    } catch (e) {
      toast('Could not download report', 'error');
    }
  }

  function updateBadge(report) {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var st = (report && (report.status || report.verdict)) || 'idle';
    if (st === 'idle') {
      btn.setAttribute('data-status', '');
      btn.querySelector('[data-phi-label]').textContent = 'PHI';
      return;
    }
    btn.setAttribute('data-status', st);
    btn.querySelector('[data-phi-label]').textContent = 'PHI · ' + statusLabel(st);
  }

  function openPanel() {
    if (!flagOn()) return;
    var panel = ensurePanel();
    if (!_last) {
      var ds = _dataset;
      if (!ds && typeof getActiveDataset === 'function') {
        try { ds = getActiveDataset(); } catch (_e) {}
      }
      if (ds) {
        var rep = scanDataset(ds);
        updateBadge(rep);
      }
    }
    renderBody(_last);
    panel.classList.add('open');
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header, #analyze-pills, .analyze-pills');
    if (!toolbar) {
      /* fallback: floating safe control */
      toolbar = document.body;
    }
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open PHI Shield');
    btn.title = 'PHI Shield — on-device privacy screen';
    btn.innerHTML = '<span class="dg-phi-dot" aria-hidden="true"></span><span data-phi-label>PHI</span>';
    btn.addEventListener('click', function () {
      var panel = document.getElementById(PANEL_ID);
      if (panel && panel.classList.contains('open')) closePanel();
      else openPanel();
    });
    if (toolbar === document.body) {
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '16px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function onDataset(ds) {
    if (!flagOn() || !ds) return;
    try {
      var rep = scanDataset(ds);
      updateBadge(rep);
      try {
        if (window.ProvenanceFabric && typeof window.ProvenanceFabric.append === 'function') {
          window.ProvenanceFabric.append('phi_shield_scan', {
            verdict: rep.verdict,
            flagged: (rep.deid && rep.deid.safeHarbor && rep.deid.safeHarbor.flaggedCount) || 0,
            patternHits: rep.patternHitCount,
            columns: rep.columnCount
          });
        }
      } catch (_eP) {}
    } catch (e) {
      console.warn('[PHI Shield] scan failed', e);
    }
  }

  function boot() {
    if (!flagOn()) return;
    injectButton();
    ensurePanel();

    document.addEventListener('dataglow:dataset-loaded', function (e) {
      var ds = e && e.detail && e.detail.dataset;
      onDataset(ds);
    });

    /* Escape closes */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });

    window.DataGlowPhiShield = {
      version: 1,
      scanDataset: scanDataset,
      openPanel: openPanel,
      closePanel: closePanel,
      getLastReport: function () { return _last; },
      /* Fail-closed helper for any AI path: never send raw if sensitive */
      guardOrBlock: function (payload) {
        var PG = window.PhiPromptGuard;
        if (!PG || typeof PG.guardPromptPayload !== 'function') {
          return { ok: false, reason: 'guard_unavailable', payload: null };
        }
        var g = PG.guardPromptPayload(payload || {});
        return {
          ok: true,
          sensitiveFound: !!g.sensitiveFound,
          payload: { text: g.text, rows: g.rows, columns: payload && payload.columns },
          findings: g.findings,
          droppedColumns: g.droppedColumns
        };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 600); });
  } else {
    setTimeout(boot, 600);
  }
})();
/* ---- end js/intelligence/data-glow-phi-shield-canvas.js ---- */
