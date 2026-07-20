/* DataGlow — js/provenance/provenance-engine.js */
/* Part of structured refactor — see src/ directory */

(function() {
'use strict';

var _registry = {};
var _panelEl  = null;

var ProvenanceEngine = window.ProvenanceEngine = {

  register: function(id, record) {
    _registry[id] = Object.assign({ ts: Date.now() }, record);
    return id;
  },

  registerKPI: function(dataset, colIdx, agg) {
    agg = agg || 'SUM';
    var col = dataset.columns[colIdx];
    if (!col) return null;
    var rawValues = [];
    var rowIndices = [];
    dataset.rows.forEach(function(row, i) {
      var v = row[colIdx];
      if (v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v))) {
        rawValues.push(parseFloat(v));
        rowIndices.push(i);
      }
    });
    var result = ProvenanceEngine._aggregate(agg, rawValues);
    var safeName = col.name.replace(/[^a-zA-Z0-9]/g, '_');
    var id = 'prov_' + agg + '_' + safeName + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
    ProvenanceEngine.register(id, {
      label: col.name, agg: agg, col: col.name, colType: col.type,
      filter: null, rowIndices: rowIndices, rawValues: rawValues,
      result: result, datasetName: dataset.name, totalRows: dataset.rows.length
    });
    return id;
  },

  _aggregate: function(agg, vals) {
    if (!vals.length) return 0;
    switch(agg) {
      case 'SUM':    return vals.reduce(function(a,b){return a+b;},0);
      case 'AVG':    return vals.reduce(function(a,b){return a+b;},0)/vals.length;
      case 'COUNT':  return vals.length;
      case 'MAX':    return Math.max.apply(null,vals);
      case 'MIN':    return Math.min.apply(null,vals);
      case 'MEDIAN': {
        var s=[].concat(vals).sort(function(a,b){return a-b;});
        var m=Math.floor(s.length/2);
        return s.length%2?s[m]:(s[m-1]+s[m])/2;
      }
      default: return vals.reduce(function(a,b){return a+b;},0);
    }
  },

  show: function(id) {
    var rec = _registry[id];
    if (!rec) return;
    ProvenanceEngine._ensurePanel();
    ProvenanceEngine._renderPanel(rec);
    _panelEl.classList.remove('hidden');
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ _panelEl.classList.add('visible'); });
    });
  },

  hide: function() {
    if (_panelEl) {
      _panelEl.classList.remove('visible');
      setTimeout(function(){ if(_panelEl) _panelEl.classList.add('hidden'); }, 310);
    }
  },

  _ensurePanel: function() {
    if (_panelEl && document.body.contains(_panelEl)) return;
    _panelEl = document.createElement('div');
    _panelEl.id = 'provenance-panel';
    _panelEl.className = 'provenance-panel hidden';
    _panelEl.setAttribute('role','dialog');
    _panelEl.setAttribute('aria-label','Proof chain');
    document.body.appendChild(_panelEl);
  },

  _fmt: function(v) {
    if (v === null || v === undefined) return 'null';
    var n = parseFloat(v);
    if (isNaN(n)) return String(v);
    if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2)+'B';
    if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2)+'M';
    if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(2)+'K';
    return parseFloat(n.toFixed(4)).toString();
  },

  _renderPanel: function(rec) {
    var fmt = ProvenanceEngine._fmt;
    var vals = rec.rawValues || [];
    var n = vals.length;
    var shown = vals.slice(0,12);
    var moreCount = n - shown.length;
    var maxVal = shown.length ? Math.max.apply(null, shown.map(function(v){return Math.abs(v);})) : 1;
    if (maxVal === 0) maxVal = 1;

    var bars = shown.map(function(v) {
      var pct = Math.round((Math.abs(v)/maxVal)*80);
      var color = v >= 0 ? 'var(--primary)' : '#DC2626';
      return '<div class="prov-bar-row">' +
        '<span class="prov-bar-val">' + fmt(v) + '</span>' +
        '<div class="prov-bar-track"><div class="prov-bar-fill" style="width:'+pct+'%;background:'+color+'"></div></div>' +
        '</div>';
    }).join('');

    var formulaMap = { SUM:'SUM', AVG:'AVG', COUNT:'COUNT', MAX:'MAX', MIN:'MIN', MEDIAN:'MEDIAN' };
    var formula = (formulaMap[rec.agg] || rec.agg) + '(' + rec.col + ')';
    var usedRows = n;
    var skippedRows = (rec.totalRows||0) - n;
    var pctUsed = rec.totalRows ? Math.round((n/rec.totalRows)*100) : 100;

    function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    _panelEl.innerHTML =
      '<div class="prov-header">' +
        '<div>' +
          '<div class="prov-title">Proof Chain</div>' +
          '<div class="prov-subtitle">Every number, fully explained</div>' +
        '</div>' +
        '<button class="prov-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="prov-body">' +
        '<div class="prov-result-block">' +
          '<div class="prov-result-label">' + esc(rec.label) + '</div>' +
          '<div class="prov-result-value">' + fmt(rec.result) + '</div>' +
          '<div class="prov-formula-chip">' + esc(formula) + '</div>' +
        '</div>' +
        '<div class="prov-section-label">Source chain</div>' +
        '<div class="prov-source-row">' +
          '<span class="prov-source-icon">&#128196;</span>' +
          '<span class="prov-source-text">' + esc(rec.datasetName||'Dataset') + '</span>' +
          '<span class="prov-arrow">&#8594;</span>' +
          '<span class="prov-col-chip">' + esc(rec.col) + '</span>' +
          (rec.filter ? '<span class="prov-arrow">&#8594;</span><span class="prov-filter-chip">WHERE ' + esc(rec.filter) + '</span>' : '') +
        '</div>' +
        '<div class="prov-section-label">Row coverage</div>' +
        '<div class="prov-coverage-bar-wrap"><div class="prov-coverage-bar-fill" style="width:'+pctUsed+'%"></div></div>' +
        '<p class="prov-coverage-text">'+usedRows.toLocaleString()+' rows contributed &middot; '+skippedRows.toLocaleString()+' skipped (null / non-numeric) &middot; '+pctUsed+'% coverage</p>' +
        '<div class="prov-section-label">Contributing values'+(moreCount>0?' (first 12 of '+n+')':'')+'</div>' +
        '<div class="prov-bars">' + bars + '</div>' +
        (moreCount>0?'<p class="prov-more">+ '+moreCount+' more values</p>':'') +
        '<div class="prov-footer">Computed ' + new Date(rec.ts||Date.now()).toLocaleTimeString() + ' &middot; DataGlow Provenance v1 &middot; Data never left your browser</div>' +
      '</div>';

    _panelEl.querySelector('.prov-close').addEventListener('click', ProvenanceEngine.hide);
  }
};

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') ProvenanceEngine.hide();
});
