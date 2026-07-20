/* DataGlow — js/dashboard/dashboard-engine.js */
/* Part of structured refactor — see src/ directory */

/**
 * dashboard-engine.js — DataGlow Dashboard View (PR AN)
 *
 * DataGlow rows are arrays (not objects). Columns are { name, type } where
 * type is one of: 'INT', 'FLOAT', 'STR', 'DATE', 'BOOL' (from detectType).
 * Access: r[colIdx] — NOT r[col.name].
 *
 * Research-grounded rules:
 *  - Data readiness gate first (null rates, dupes, row count, type consistency)
 *  - 3-4 KPI cards, top row, Z-pattern
 *  - Three-in-one KPI anatomy: headline + sparkline + delta badge
 *  - RAG colors: green #16A34A / amber #D97706 / red #DC2626 — never inverted
 *  - Bar + line charts only — no pie, no 3D, no dual-axis
 *  - 6 charts max
 *  - Outliers flagged, never silently removed
 *  - Export CSV front and center
 */

var DashboardEngine = (function () {
  'use strict';

  var RAG = {
    green: { bg: '#DCFCE7', text: '#15803D', dot: '#16A34A' },
    amber: { bg: '#FEF3C7', text: '#B45309', dot: '#D97706' },
    red:   { bg: '#FEE2E2', text: '#B91C1C', dot: '#DC2626' },
    gray:  { bg: '#F3F4F6', text: '#4B5563', dot: '#6B7280' },
    blue:  { bg: '#DBEAFE', text: '#1D4ED8', dot: '#2563EB' }
  };

  // DataGlow numeric types
  var NUMERIC_TYPES = { 'INT': true, 'FLOAT': true, 'number': true, 'integer': true, 'float': true, 'double': true };
  var TEXT_TYPES    = { 'STR': true, 'BOOL': true, 'text': true, 'varchar': true, 'string': true };
  var DATE_TYPES    = { 'DATE': true, 'date': true, 'timestamp': true };

  function isNum(v) { return v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v)) && isFinite(v); }
  function toNum(v) { return parseFloat(v); }
  function escH(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '\u2014';
    var abs = Math.abs(n);
    if (abs >= 1e9) return (n/1e9).toFixed(1)+'B';
    if (abs >= 1e6) return (n/1e6).toFixed(1)+'M';
    if (abs >= 1e3) return (n/1e3).toFixed(1)+'K';
    if (abs < 1 && abs > 0) return n.toFixed(2);
    return parseFloat(n.toFixed(2)).toLocaleString();
  }
  function fmtPct(n) {
    if (n === null || isNaN(n)) return '';
    return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
  }

  // Get value from a row by column index
  function getVal(row, colIdx) { return row[colIdx]; }

  // ── Data Readiness Check ──────────────────────────────────────────────────
  function runReadinessCheck(dataset) {
    var issues = [], warnings = [], passed = [];
    if (!dataset || !dataset.rows || !dataset.columns) {
      return { pass: false, issues: [{ msg: 'No dataset loaded.', severity: 'block' }], warnings: [], passed: [], outlierCols: [] };
    }
    var rows = dataset.rows, cols = dataset.columns, n = rows.length;

    // Row count
    if (n === 0) {
      issues.push({ severity: 'block', msg: 'Dataset is empty (0 rows).' });
    } else if (n < 30) {
      warnings.push({ severity: 'warn', msg: n + ' rows \u2014 below the 30-row minimum. KPI values may be statistically unreliable.' });
    } else {
      passed.push('Row count: ' + n.toLocaleString() + ' rows');
    }

    // Duplicates (Uber SLA: <=1%)
    var seen = {}, dupeCount = 0;
    rows.forEach(function(r) { var k=JSON.stringify(r); if(seen[k]) dupeCount++; else seen[k]=true; });
    var dupePct = n > 0 ? dupeCount/n : 0;
    if (dupePct > 0.01) {
      issues.push({ severity: 'block', msg: dupeCount + ' duplicate rows (' + (dupePct*100).toFixed(1) + '%) exceeds the 1% threshold.', detail: 'Duplicates inflate KPIs. Use the Grid view to remove them first.' });
    } else if (dupeCount > 0) {
      warnings.push({ severity: 'warn', msg: dupeCount + ' duplicate row(s) found (within 1% tolerance).' });
    } else {
      passed.push('Duplicates: none found');
    }

    // Null rates per numeric column (block >30%, warn 10-30%)
    var highNullCols = [];
    cols.forEach(function(col, ci) {
      var nullC = rows.filter(function(r){ var v=getVal(r,ci); return v===null||v===undefined||v===''; }).length;
      var pct = n > 0 ? nullC/n : 0;
      if (pct > 0.30 && NUMERIC_TYPES[col.type]) {
        highNullCols.push(col.name);
        issues.push({ severity: 'block', field: col.name, msg: '"'+col.name+'": '+(pct*100).toFixed(0)+'% empty \u2014 too incomplete to chart reliably.', detail: 'Above 30% nulls on a metric column produces misleading charts. Fix with Column Editor.' });
      } else if (pct > 0.10) {
        warnings.push({ severity: 'warn', msg: '"'+col.name+'": '+(pct*100).toFixed(0)+'% empty (10\u201330% \u2014 null rows excluded from charts).' });
      }
    });
    if (!highNullCols.length) passed.push('Null rates: all columns within safe thresholds');

    // Outliers (1.5x IQR, flag only, never remove)
    var outlierCols = [];
    cols.forEach(function(col, ci) {
      if (!NUMERIC_TYPES[col.type]) return;
      var vals = rows.map(function(r){return getVal(r,ci);}).filter(isNum).map(toNum);
      if (vals.length < 10) return;
      var sorted = vals.slice().sort(function(a,b){return a-b;});
      var q1=sorted[Math.floor(sorted.length*0.25)], q3=sorted[Math.floor(sorted.length*0.75)];
      var iqr=q3-q1, lo=q1-1.5*iqr, hi=q3+1.5*iqr;
      var cnt=vals.filter(function(v){return v<lo||v>hi;}).length;
      if (cnt > 0) outlierCols.push({ name: col.name, count: cnt });
    });
    if (outlierCols.length) {
      warnings.push({ severity: 'info', msg: 'Outliers flagged in: '+outlierCols.map(function(c){return c.name+' ('+c.count+')';}).join(', ')+'. Shown in context, not removed (Tableau best practice).' });
    }

    return { pass: issues.length===0, issues: issues, warnings: warnings, passed: passed, outlierCols: outlierCols };
  }

  // ── KPI derivation ────────────────────────────────────────────────────────
  function deriveKPIs(dataset) {
    var rows = dataset.rows, cols = dataset.columns;
    // Find numeric columns by type OR by value inspection
    var numColIdxs = [];
    cols.forEach(function(col, ci) {
      if (NUMERIC_TYPES[col.type]) {
        numColIdxs.push(ci);
      } else {
        // Fallback: check if 50%+ of values are numeric
        var vals = rows.slice(0,30).map(function(r){return getVal(r,ci);}).filter(isNum);
        if (vals.length >= Math.max(1, Math.min(30, rows.length)*0.5)) numColIdxs.push(ci);
      }
    });

    return numColIdxs.slice(0,4).map(function(ci) {
      var col = cols[ci];
      var vals = rows.map(function(r){return getVal(r,ci);}).filter(isNum).map(toNum);
      if (!vals.length) return null;
      var total = vals.reduce(function(s,v){return s+v;},0);
      var avg = total/vals.length;
      var mn = Math.min.apply(null,vals), mx = Math.max.apply(null,vals);
      var spark = vals.slice(-12);
      var half = Math.floor(vals.length/2);
      var avg1 = half>0 ? vals.slice(0,half).reduce(function(s,v){return s+v;},0)/half : avg;
      var avg2 = (vals.length-half)>0 ? vals.slice(half).reduce(function(s,v){return s+v;},0)/(vals.length-half) : avg;
      var delta = avg1 !== 0 ? (avg2-avg1)/Math.abs(avg1) : 0;
      return { name: col.name, value: fmtNum(avg), total: fmtNum(total), min: fmtNum(mn), max: fmtNum(mx), count: vals.length, delta: delta, deltaStr: fmtPct(delta), spark: spark };
    }).filter(Boolean);
  }

  // ── Chart derivation (bar + line only) ───────────────────────────────────
  function deriveCharts(dataset) {
    var rows = dataset.rows, cols = dataset.columns, charts = [];

    // Classify columns
    var numIdxs = [], catIdxs = [], dateIdxs = [];
    cols.forEach(function(col, ci) {
      if (NUMERIC_TYPES[col.type]) {
        numIdxs.push(ci);
      } else if (DATE_TYPES[col.type]) {
        dateIdxs.push(ci);
      } else if (TEXT_TYPES[col.type]) {
        // Check cardinality for categorical use
        var uniq = new Set(rows.slice(0,50).map(function(r){return getVal(r,ci);}).filter(function(v){return v!==null&&v!==undefined&&v!=='';} )).size;
        if (uniq >= 2 && uniq <= 25) catIdxs.push(ci);
      }
    });

    // Fallback: if no classified cols, infer from values
    if (!numIdxs.length && !catIdxs.length) {
      cols.forEach(function(col, ci) {
        var vals30 = rows.slice(0,30).map(function(r){return getVal(r,ci);});
        var numCount = vals30.filter(isNum).length;
        if (numCount >= vals30.length*0.5) numIdxs.push(ci);
        else {
          var uniq = new Set(vals30.filter(Boolean)).size;
          if (uniq >= 2 && uniq <= 20) catIdxs.push(ci);
        }
      });
    }

    // 1. Avg metric by top categorical col
    if (catIdxs.length && numIdxs.length) {
      var ci=catIdxs[0], mi=numIdxs[0], g={};
      rows.forEach(function(r){ var k=String(getVal(r,ci)||'Unknown'); if(!g[k]) g[k]={sum:0,n:0}; var v=getVal(r,mi); if(isNum(v)){g[k].sum+=toNum(v);g[k].n++;} });
      var s=Object.keys(g).map(function(k){return{label:k,value:g[k].n?g[k].sum/g[k].n:0};}).sort(function(a,b){return b.value-a.value;}).slice(0,8);
      if (s.length>=2) charts.push({type:'bar',title:'Avg '+cols[mi].name+' by '+cols[ci].name,data:s,question:'Which '+cols[ci].name+' has the highest avg '+cols[mi].name+'?',_xLabel:cols[ci].name,_yLabel:'Avg '+cols[mi].name});
    }

    // 2. Count by category
    if (catIdxs.length) {
      var ci2=catIdxs.length>1?catIdxs[1]:catIdxs[0], freq={};
      rows.forEach(function(r){ var k=String(getVal(r,ci2)||'Unknown'); freq[k]=(freq[k]||0)+1; });
      var fs=Object.keys(freq).map(function(k){return{label:k,value:freq[k]};}).sort(function(a,b){return b.value-a.value;}).slice(0,8);
      if (fs.length>=2&&(catIdxs.length>1||charts.length===0)) charts.push({type:'bar',title:'Count by '+cols[ci2].name,data:fs,question:'How many records per '+cols[ci2].name+'?',_xLabel:cols[ci2].name,_yLabel:'Count'});
    }

    // 3. Time series line (date col + metric col)
    if (dateIdxs.length && numIdxs.length) {
      var di=dateIdxs[0], mi2=numIdxs[0], tg={};
      rows.forEach(function(r){ var d=new Date(String(getVal(r,di)||'')); if(isNaN(d)) return; var k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); if(!tg[k])tg[k]={sum:0,n:0}; var v=getVal(r,mi2); if(isNum(v)){tg[k].sum+=toNum(v);tg[k].n++;} });
      var ts=Object.keys(tg).sort().map(function(k){return{label:k,value:tg[k].n?tg[k].sum/tg[k].n:0};});
      if (ts.length>=2) charts.push({type:'line',title:cols[mi2].name+' trend over time',data:ts,question:'How has '+cols[mi2].name+' trended over time?',_xLabel:'Date',_yLabel:cols[mi2].name});
    }

    // 4. Distribution histogram of primary numeric col
    if (numIdxs.length) {
      var hci=numIdxs[0];
      var hv=rows.map(function(r){return getVal(r,hci);}).filter(isNum).map(toNum);
      if (hv.length>=5) {
        var mn=Math.min.apply(null,hv), mx=Math.max.apply(null,hv), binCnt=Math.min(8,Math.ceil(Math.sqrt(hv.length))), bw=(mx-mn)/binCnt||1;
        var bd=[]; for(var b=0;b<binCnt;b++){ var lo=mn+b*bw,hi=mn+(b+1)*bw; bd.push({label:fmtNum(lo)+'\u2013'+fmtNum(hi),value:hv.filter(function(v){return v>=lo&&(b===binCnt-1?v<=hi:v<hi);}).length}); }
        if (bd.length>1) charts.push({type:'bar',title:'Distribution: '+cols[hci].name,data:bd,question:'What is the distribution of '+cols[hci].name+'?',_xLabel:cols[hci].name,_yLabel:'Count'});
      }
    }

    // 5. Second numeric by first categorical
    if (numIdxs.length>1 && catIdxs.length) {
      var ci5=catIdxs[0], mi5=numIdxs[1], g5={};
      rows.forEach(function(r){ var k=String(getVal(r,ci5)||'Unknown'); if(!g5[k])g5[k]={sum:0,n:0}; var v=getVal(r,mi5); if(isNum(v)){g5[k].sum+=toNum(v);g5[k].n++;} });
      var s5=Object.keys(g5).map(function(k){return{label:k,value:g5[k].n?g5[k].sum/g5[k].n:0};}).sort(function(a,b){return b.value-a.value;}).slice(0,8);
      if (s5.length>=2) charts.push({type:'bar',title:'Avg '+cols[mi5].name+' by '+cols[ci5].name,data:s5,question:'How does '+cols[mi5].name+' compare across '+cols[ci5].name+'?',_xLabel:cols[ci5].name,_yLabel:'Avg '+cols[mi5].name});
    }

    return charts.slice(0,6);
  }

  // ── Sparkline SVG ─────────────────────────────────────────────────────────
  function sparkSVG(vals, color) {
    if (!vals||vals.length<2) return '';
    var w=80, h=28, mn=Math.min.apply(null,vals), mx=Math.max.apply(null,vals), rng=mx-mn||1;
    var pts=vals.map(function(v,i){ return ((i/(vals.length-1))*w).toFixed(1)+','+(h-((v-mn)/rng)*h).toFixed(1); }).join(' ');
    return '<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  // ── Chart.js rendering ────────────────────────────────────────────────────
  var chartInstances = [];
  function destroyCharts() { chartInstances.forEach(function(c){try{c.destroy();}catch(e){}}); chartInstances=[]; }

  function loadChartJs() {
    if (window.Chart) return Promise.resolve();
    return new Promise(function(resolve,reject){
      var s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
      s.onload=resolve; s.onerror=function(){resolve();};  // don't block on CDN failure
      document.head.appendChild(s);
    });
  }

  function renderChartCanvas(canvas, chart, isDark) {
    if (!window.Chart||!canvas) return;
    var tc=isDark?'#CDCCCA':'#28251D', gc=isDark?'#393836':'#D4D1CA', primary='#20808D';
    var labels=chart.data.map(function(d){return d.label;}), vals=chart.data.map(function(d){return d.value;});
    var isHoriz=chart.type==='bar'&&labels.some(function(l){return String(l).length>10;});
    var cfg={
      type:chart.type==='line'?'line':'bar',
      data:{ labels:labels, datasets:[{
        data:vals,
        backgroundColor:chart.type==='line'?'transparent':primary+'88',
        borderColor:primary, borderWidth:chart.type==='line'?2:0,
        borderRadius:chart.type==='bar'?4:0,
        pointBackgroundColor:primary, pointRadius:chart.type==='line'?3:0,
        tension:0.35,
        fill:chart.type==='line'?{target:'origin',above:primary+'18'}:false
      }]},
      options:{
        responsive:true, maintainAspectRatio:false,
        indexAxis:isHoriz?'y':'x',
        plugins:{ legend:{display:false}, tooltip:{callbacks:{label:function(ctx){return fmtNum(ctx.parsed[isHoriz?'x':'y']);}}} },
        scales:{
          x:{ grid:{color:gc,lineWidth:0.5}, ticks:{color:tc,font:{size:10},maxRotation:isHoriz?0:35,maxTicksLimit:8},
              title:{ display:!isHoriz, text:chart._xLabel||'', color:tc, font:{size:10}, padding:{top:4} } },
          y:{ grid:{color:gc,lineWidth:0.5}, ticks:{color:tc,font:{size:10},callback:function(v){return fmtNum(v);}},
              title:{ display:isHoriz||true, text:chart._yLabel||'', color:tc, font:{size:10}, padding:{bottom:4} } }
        }
      }
    };
    chartInstances.push(new window.Chart(canvas,cfg));
  }

  // ── Gate UI ───────────────────────────────────────────────────────────────
  function renderGate(report, el, onProceed) {
    el.innerHTML='';
    var wrap=document.createElement('div'); wrap.className='dash-gate';
    var hasBlocks=report.issues.length>0;
    wrap.innerHTML='<div class="dash-gate-title">'+(report.pass?'<span class="dash-gate-icon ok">&#10003;</span> Data Readiness Check Passed':'<span class="dash-gate-icon fail">&#9888;</span> Data Needs Attention Before Dashboarding')+'</div>'+
      '<div class="dash-gate-sub">'+(report.pass?'All quality checks passed. Building dashboard\u2026':'Presenting incomplete or duplicate data in a dashboard is bad practice. Fix the issues below first.')+'</div>';

    if (report.issues.length) {
      var il=document.createElement('div'); il.className='dash-gate-section';
      il.innerHTML='<div class="dash-gate-section-title">Blocking issues</div>';
      report.issues.forEach(function(i){ var r=document.createElement('div'); r.className='dash-gate-row block'; r.innerHTML='<span class="dash-dot red"></span><div><div class="dash-row-msg">'+escH(i.msg)+'</div>'+(i.detail?'<div class="dash-row-detail">'+escH(i.detail)+'</div>':'')+'</div>'; il.appendChild(r); });
      wrap.appendChild(il);
    }
    if (report.warnings.length) {
      var wl=document.createElement('div'); wl.className='dash-gate-section';
      wl.innerHTML='<div class="dash-gate-section-title">Quality notes</div>';
      report.warnings.forEach(function(w){ var r=document.createElement('div'); r.className='dash-gate-row warn'; r.innerHTML='<span class="dash-dot '+(w.severity==='info'?'blue':'amber')+'"></span><div><div class="dash-row-msg">'+escH(w.msg)+'</div>'+(w.detail?'<div class="dash-row-detail">'+escH(w.detail)+'</div>':'')+'</div>'; wl.appendChild(r); });
      wrap.appendChild(wl);
    }
    if (report.passed.length) {
      var pl=document.createElement('div'); pl.className='dash-gate-section';
      pl.innerHTML='<div class="dash-gate-section-title">Checks passed</div>';
      report.passed.forEach(function(p){ var r=document.createElement('div'); r.className='dash-gate-row'; r.innerHTML='<span class="dash-dot green"></span><div class="dash-row-msg">'+escH(p)+'</div>'; pl.appendChild(r); });
      wrap.appendChild(pl);
    }
    var ba=document.createElement('div'); ba.className='dash-gate-actions';
    if (!hasBlocks) {
      var btn=document.createElement('button'); btn.className='dash-btn-primary'; btn.textContent='Build Dashboard'; btn.addEventListener('click',onProceed); ba.appendChild(btn);
    } else {
      var hint=document.createElement('div'); hint.className='dash-gate-hint'; hint.textContent='Fix the blocking issues in the Grid or Column Editor, then return to the Dashboard tab.'; ba.appendChild(hint);
      var ob=document.createElement('button'); ob.className='dash-btn-secondary'; ob.textContent='Build anyway (quality caveats shown)'; ob.addEventListener('click',onProceed); ba.appendChild(ob);
    }
    wrap.appendChild(ba);
    el.appendChild(wrap);
  }

  // ── Dashboard render ──────────────────────────────────────────────────────
  function renderDashboard(dataset, report, el) {
    destroyCharts();
    el.innerHTML='';
    var isDark=document.documentElement.classList.contains('dark');
    var kpis=deriveKPIs(dataset), charts=deriveCharts(dataset);
    var dsName=(dataset.name||'Dataset').replace(/\.[^.]+$/,'');
    var now=new Date().toLocaleString();

    var dash=document.createElement('div'); dash.className='dash-root';

    // Header
    var hdr=document.createElement('div'); hdr.className='dash-header';
    hdr.innerHTML='<div class="dash-hdr-left"><div class="dash-title">'+escH(dsName)+'</div><div class="dash-meta">'+dataset.rows.length.toLocaleString()+' rows \u00b7 '+dataset.columns.length+' cols \u00b7 '+escH(now)+'</div></div>'+
      '<div class="dash-hdr-right">'+
      (report.warnings.length?'<span class="dash-quality-badge warn">&#9888; '+report.warnings.length+' note'+(report.warnings.length>1?'s':'')+'</span>':'<span class="dash-quality-badge ok">&#10003; Quality passed</span>')+
      '<button class="dash-export-btn" id="dash-csv-btn">&#8681; Export CSV</button></div>';
    dash.appendChild(hdr);

    // Findings Rail (PR AU)  -  above KPI row
    var frContainer = document.createElement('div');
    frContainer.id = 'findings-rail-container';
    if (typeof FindingsRail !== 'undefined') {
      FindingsRail.render(dataset, frContainer);
    }
    dash.appendChild(frContainer);

    // KPI row (3-4 max)
    if (kpis.length) {
      var kr=document.createElement('div'); kr.className='dash-kpi-row';
            // Register provenance for each KPI upfront
      var _whatIfFirstLoad = !sessionStorage.getItem('dg_whatif_seen');
      var _provIds = kpis.map(function(kpi) {
        if (!dataset) return null;
        var colIdx = dataset.columns.findIndex(function(c){ return c.name === kpi.name; });
        if (colIdx < 0) return null;
        return window.ProvenanceEngine ? ProvenanceEngine.registerKPI(dataset, colIdx, 'SUM') : null;
      });
      kpis.forEach(function(kpi,i){
        var card=document.createElement('div'); card.className='dash-kpi-card'+(i===0?' primary':'');
        card.dataset.kpiName = kpi.name;
        card.dataset.kpiOriginal = kpi.value;
        var ragC=kpi.delta>0.05?RAG.green:kpi.delta<-0.05?RAG.red:RAG.gray;
        var arrow=kpi.delta>0?'\u2191':kpi.delta<0?'\u2193':'\u2192';

        // What-if hint  -  shows once, first card only
        var hintHtml = (i===0 && _whatIfFirstLoad)
          ? '<div class="kpi-whatif-hint">Click any number to model a scenario</div>'
          : '';

        card.innerHTML=
          '<div class="dash-kpi-label">'+escH(kpi.name)+'</div>'+
          '<div class="dash-kpi-value-wrap">'+
            '<div class="dash-kpi-value" title="Click to enter a what-if scenario value" ' + (_provIds[i] ? 'data-prov-id="'+_provIds[i]+'"' : '') + '>'+escH(kpi.value)+'</div>'+
            '<input class="kpi-whatif-input hidden" type="number" step="any" placeholder="Enter scenario value" aria-label="What-if value for '+escH(kpi.name)+'" />'+
          '</div>'+
          hintHtml+
          '<div class="dash-kpi-footer"><span class="dash-delta" style="background:'+ragC.bg+';color:'+ragC.text+'">'+arrow+' '+escH(kpi.deltaStr||'\u2014')+'</span><span class="dash-spark">'+sparkSVG(kpi.spark,ragC.dot)+'</span></div>'+
          '<div class="dash-kpi-sub">min '+escH(kpi.min)+' \u00b7 max '+escH(kpi.max)+'</div>';

        // Click value to activate what-if input OR show provenance
        card.addEventListener('click', function(e) {
          if (e.target.classList.contains('kpi-whatif-input')) return;
          // Provenance: if clicked directly on the value element with a prov-id
          var valEl2 = card.querySelector('.dash-kpi-value');
          if (e.target === valEl2 && valEl2.dataset.provId && window.ProvenanceEngine) {
            ProvenanceEngine.show(valEl2.dataset.provId);
            return;
          }
          var valEl = card.querySelector('.dash-kpi-value');
          var inputEl = card.querySelector('.kpi-whatif-input');
          var hintEl = card.querySelector('.kpi-whatif-hint');
          if (!inputEl) return;
          // Dismiss hint permanently
          if (hintEl) { hintEl.style.display='none'; sessionStorage.setItem('dg_whatif_seen','1'); }
          valEl.classList.add('hidden');
          inputEl.classList.remove('hidden');
          inputEl.value = parseFloat(kpi.value.replace(/[^0-9.-]/g,'')) || '';
          inputEl.focus();
          inputEl.select();
        });

        // On input change: recompute delta vs original
        card.addEventListener('input', function(e) {
          if (!e.target.classList.contains('kpi-whatif-input')) return;
          var inputEl = e.target;
          var newVal = parseFloat(inputEl.value);
          if (isNaN(newVal)) return;
          var orig = parseFloat(kpi.value.replace(/[^0-9.-]/g,'')) || 0;
          var diff = newVal - orig;
          var pct = orig !== 0 ? ((diff / Math.abs(orig)) * 100).toFixed(1) : '0';
          var sign = diff >= 0 ? '+' : '';
          var deltaEl = card.querySelector('.dash-delta');
          if (deltaEl) {
            var newRag = diff > 0 ? RAG.green : diff < 0 ? RAG.red : RAG.gray;
            var newArrow = diff > 0 ? '\u2191' : diff < 0 ? '\u2193' : '\u2192';
            deltaEl.style.background = newRag.bg;
            deltaEl.style.color = newRag.text;
            deltaEl.textContent = newArrow + ' ' + sign + pct + '% vs actual';
          }
          // Scenario badge
          var sub = card.querySelector('.dash-kpi-sub');
          if (sub) sub.innerHTML = '\u26A0 Scenario mode \u00b7 actual: '+escH(kpi.value);
        });

        // Escape / blur: restore original
        card.addEventListener('keydown', function(e) {
          if (e.key !== 'Escape') return;
          var inputEl = card.querySelector('.kpi-whatif-input');
          var valEl = card.querySelector('.dash-kpi-value');
          if (!inputEl) return;
          inputEl.classList.add('hidden');
          valEl.classList.remove('hidden');
          var deltaEl = card.querySelector('.dash-delta');
          if (deltaEl) { deltaEl.style.background=ragC.bg; deltaEl.style.color=ragC.text; deltaEl.textContent=arrow+' '+escH(kpi.deltaStr||'\u2014'); }
          var sub = card.querySelector('.dash-kpi-sub');
          if (sub) sub.innerHTML='min '+escH(kpi.min)+' \u00b7 max '+escH(kpi.max);
        });

        card.addEventListener('focusout', function(e) {
          if (e.relatedTarget && card.contains(e.relatedTarget)) return;
          var inputEl = card.querySelector('.kpi-whatif-input');
          var valEl = card.querySelector('.dash-kpi-value');
          if (inputEl && !inputEl.classList.contains('hidden')) {
            inputEl.classList.add('hidden');
            valEl.classList.remove('hidden');
          }
        });

        kr.appendChild(card);
      });
      if (_whatIfFirstLoad) sessionStorage.setItem('dg_whatif_seen','1');
      dash.appendChild(kr);
    } else {
      var noKpi=document.createElement('div'); noKpi.className='dash-no-numeric';
      noKpi.textContent='No numeric columns detected. Add numeric data for KPI cards.';
      dash.appendChild(noKpi);
    }

    // Outlier banner (never silent)
    if (report.outlierCols&&report.outlierCols.length) {
      var ob=document.createElement('div'); ob.className='dash-outlier-banner';
      ob.innerHTML='<strong>Outliers visible:</strong> '+report.outlierCols.map(function(c){return escH(c.name)+' ('+c.count+' point'+(c.count>1?'s':'')+')'}).join(', ')+'. Shown in context per Tableau best practice \u2014 not removed.';
      dash.appendChild(ob);
    }

    // Chart grid (max 6)
    if (charts.length) {
      var cg=document.createElement('div'); cg.className='dash-chart-grid';
      charts.forEach(function(chart){
        var card=document.createElement('div'); card.className='dash-chart-card';
        var q=document.createElement('div'); q.className='dash-chart-title'; q.textContent=chart.question;
        var topD=chart.data[0];
        var insightTxt = topD ? 'Top: ' + String(topD.label).substring(0,22) + ' · ' + fmtNum(topD.value) : chart.title;
        var ins=document.createElement('div'); ins.className='dash-chart-insight'; ins.innerHTML=insightTxt;
        var cw=document.createElement('div'); cw.className='dash-chart-wrap';
        var canvas=document.createElement('canvas');
        cw.appendChild(canvas); card.appendChild(q); card.appendChild(ins); card.appendChild(cw); cg.appendChild(card);
        loadChartJs().then(function(){ renderChartCanvas(canvas,chart,isDark); });
      });
      dash.appendChild(cg);
    } else {
      var noChart=document.createElement('div'); noChart.className='dash-no-numeric';
      noChart.textContent='Not enough structured data to auto-generate charts. Try adding numeric or categorical columns.';
      dash.appendChild(noChart);
    }

    // Footer quality notes
    if (report.warnings.length) {
      var ft=document.createElement('div'); ft.className='dash-footer';
      ft.innerHTML='<strong>Quality notes:</strong> '+report.warnings.map(function(w){return escH(w.msg);}).join(' \u00b7 ');
      dash.appendChild(ft);
    }

    el.appendChild(dash);

    // Export CSV
    var csvBtn=el.querySelector('#dash-csv-btn');
    if (csvBtn) {
      csvBtn.addEventListener('click', function(){
        var colNames=dataset.columns.map(function(c){return c.name;});
        var lines=[colNames.map(function(c){return JSON.stringify(c);}).join(',')];
        dataset.rows.forEach(function(r){ lines.push(dataset.columns.map(function(col,ci){var v=getVal(r,ci);return v===null||v===undefined?'':JSON.stringify(String(v));}).join(',')); });
        var blob=new Blob([lines.join('\n')],{type:'text/csv'});
        var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=dsName+'_dashboard.csv'; a.click();
        setTimeout(function(){URL.revokeObjectURL(a.href);},2000);
      });
    }
  }

  // ── Public render ─────────────────────────────────────────────────────────
  function render(dataset, el) {
    el.innerHTML='';
    if (!dataset) {
      el.innerHTML='<div class="dash-empty"><div class="dash-empty-icon">&#9783;</div><div class="dash-empty-title">No data loaded</div><div class="dash-empty-sub">Drop a CSV file anywhere to get started.</div></div>';
      return;
    }
    var report=runReadinessCheck(dataset);
    renderGate(report, el, function(){ renderDashboard(dataset, report, el); });
    if (report.pass) {
      setTimeout(function(){ renderDashboard(dataset, report, el); }, 350);
    }
  }

  return { render: render, runReadinessCheck: runReadinessCheck };
