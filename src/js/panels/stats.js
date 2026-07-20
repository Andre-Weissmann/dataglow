/* DataGlow — src/js/panels/stats.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    // ── HTML-escape helper ─────────────────────────────────────────────
    function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }


    // ── Pure-JS stats helpers ───────────────────────────────────────────
    function mean(arr) { return arr.reduce(function(a,b){return a+b;},0)/arr.length; }
    function variance(arr) { var m=mean(arr); return arr.reduce(function(a,b){return a+(b-m)*(b-m);},0)/(arr.length-1); }
    function stddev(arr) { return Math.sqrt(variance(arr)); }

    function pearson(xs, ys) {
      if (xs.length !== ys.length || xs.length < 3) return null;
      var mx=mean(xs), my=mean(ys);
      var num=0, dx=0, dy=0;
      for (var i=0;i<xs.length;i++) { num+=(xs[i]-mx)*(ys[i]-my); dx+=(xs[i]-mx)*(xs[i]-mx); dy+=(ys[i]-my)*(ys[i]-my); }
      var denom=Math.sqrt(dx*dy);
      return denom===0?0:num/denom;
    }

    function linReg(xs, ys) {
      var n=xs.length, mx=mean(xs), my=mean(ys);
      var sxy=0, sxx=0;
      for (var i=0;i<n;i++) { sxy+=(xs[i]-mx)*(ys[i]-my); sxx+=(xs[i]-mx)*(xs[i]-mx); }
      var slope=sxy/sxx, intercept=my-slope*mx;
      var yhat=xs.map(function(x){return slope*x+intercept;});
      var ssTot=ys.reduce(function(a,b,i){return a+(b-my)*(b-my);},0);
      var ssRes=ys.reduce(function(a,b,i){return a+(b-yhat[i])*(b-yhat[i]);},0);
      var r2=1-ssRes/ssTot;
      var se=Math.sqrt(ssRes/(n-2)/sxx);
      var tStat=slope/se;
      var df=n-2;
      // t-distribution p-value approximation (two-tailed)
      var p=tPval(Math.abs(tStat), df);
      return {slope:slope, intercept:intercept, r2:r2, tStat:tStat, se:se, df:df, p:p};
    }

    // t-distribution survival function approximation (Abramowitz & Stegun)
    function tPval(t, df) {
      var x=df/(df+t*t);
      var betaInc=incompleteBeta(df/2, 0.5, x);
      return Math.min(1, betaInc);
    }

    function incompleteBeta(a, b, x) {
      // Continued fraction approximation
      if (x<0||x>1) return 0;
      if (x===0) return 0; if (x===1) return 1;
      var lbeta=lgamma(a+b)-lgamma(a)-lgamma(b);
      var front=Math.exp(lbeta+a*Math.log(x)+b*Math.log(1-x));
      return front*betaCF(a,b,x)/a;
    }

    function betaCF(a, b, x) {
      var maxIter=200, eps=1e-8;
      var qab=a+b, qap=a+1, qam=a-1, c=1, d=1-qab*x/qap;
      if (Math.abs(d)<1e-30) d=1e-30; d=1/d;
      var h=d;
      for (var m=1;m<=maxIter;m++) {
        var m2=2*m;
        var aa=m*(b-m)*x/((qam+m2)*(a+m2));
        d=1+aa*d; if(Math.abs(d)<1e-30)d=1e-30; c=1+aa/c; if(Math.abs(c)<1e-30)c=1e-30; d=1/d; h*=d*c;
        aa=-(a+m)*(qab+m)*x/((a+m2)*(qap+m2));
        d=1+aa*d; if(Math.abs(d)<1e-30)d=1e-30; c=1+aa/c; if(Math.abs(c)<1e-30)c=1e-30; d=1/d; var del=d*c; h*=del;
        if (Math.abs(del-1)<eps) break;
      }
      return h;
    }

    function lgamma(x) {
      var cof=[76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,0.1208650973866179e-2,-0.5395239384953e-5];
      var y=x, tmp=x+5.5; tmp-=(x+0.5)*Math.log(tmp);
      var ser=1.000000000190015;
      for (var j=0;j<6;j++){y++;ser+=cof[j]/y;}
      return -tmp+Math.log(2.5066282746310005*ser/x);
    }

    function chiSquare(colA, colB) {
      // Build contingency table
      var cats={};
      for (var i=0;i<colA.length;i++) { var a=String(colA[i]),b=String(colB[i]); if(!cats[a])cats[a]={}; cats[a][b]=(cats[a][b]||0)+1; }
      var rowKeys=Object.keys(cats), colKeys=[];
      rowKeys.forEach(function(r){Object.keys(cats[r]).forEach(function(c){if(colKeys.indexOf(c)<0)colKeys.push(c);});});
      var n=colA.length, chi2=0, df=(rowKeys.length-1)*(colKeys.length-1);
      var rowTots={}, colTots={};
      rowKeys.forEach(function(r){rowTots[r]=colKeys.reduce(function(s,c){return s+(cats[r][c]||0);},0);});
      colKeys.forEach(function(c){colTots[c]=rowKeys.reduce(function(s,r){return s+(cats[r]&&cats[r][c]?cats[r][c]:0);},0);});
      rowKeys.forEach(function(r){colKeys.forEach(function(c){var o=cats[r]&&cats[r][c]?cats[r][c]:0; var e=rowTots[r]*colTots[c]/n; if(e>0)chi2+=(o-e)*(o-e)/e;});});
      // p-value: chi2 CDF approximation
      var p=chiPval(chi2, df);
      return {chi2:chi2, df:df, p:p};
    }

    function chiPval(x, df) {
      if (x<=0) return 1;
      return 1-gammaInc(df/2, x/2);
    }

    function gammaInc(a, x) {
      // Regularized incomplete gamma (series expansion)
      if (x<0) return 0;
      if (x===0) return 0;
      var sum=1/a, term=1/a, n=0;
      while (n<200) { n++; term*=x/(a+n); sum+=term; if(term<1e-10*sum)break; }
      return sum*Math.exp(-x+a*Math.log(x)-lgamma(a));
    }

    function tTest(vals, mu0) {
      var n=vals.length, m=mean(vals), sd=stddev(vals);
      var t=(m-mu0)/(sd/Math.sqrt(n));
      var p=tPval(Math.abs(t), n-1);
      return {t:t, p:p, n:n, mean:m, sd:sd, df:n-1};
    }

    function pLabel(p) {
      if (p<0.001) return 'p < 0.001';
      if (p<0.01) return 'p < 0.01';
      if (p<0.05) return 'p < 0.05';
      return 'p = '+p.toFixed(3);
    }

    function r2Label(r2) {
      if (r2>=0.9) return 'Excellent fit (R2 >= 0.9)';
      if (r2>=0.7) return 'Strong fit (R2 >= 0.7)';
      if (r2>=0.5) return 'Moderate fit (R2 >= 0.5)';
      if (r2>=0.3) return 'Weak fit (R2 >= 0.3)';
      return 'Poor fit (R2 < 0.3)';
    }

    function corrColor(r) {
      // teal for positive, red for negative, gray for near zero
      var abs=Math.abs(r);
      if (r>0.1) return 'rgba(32,128,141,'+( abs*0.85+0.1).toFixed(2)+')';
      if (r<-0.1) return 'rgba(161,53,68,'+(abs*0.85+0.1).toFixed(2)+')';
      return 'rgba(100,100,100,0.12)';
    }

    function corrStrengthLabel(r) {
      var abs=Math.abs(r);
      var strength = abs>=0.7?'strong':(abs>=0.4?'moderate':(abs>=0.1?'weak':'near zero'));
      var dir = r>0.1?'positive':(r<-0.1?'negative':'');
      return dir ? (strength+' '+dir+' correlation') : 'near zero correlation';
    }

    // ── DOM refs ────────────────────────────────────────────
    var statsView    = document.getElementById('stats-view');
    var corrOutput   = document.getElementById('stats-corr-output');
    var regOutput    = document.getElementById('stats-reg-output');
    var hypOutput    = document.getElementById('stats-hyp-output');
    var regX         = document.getElementById('stats-reg-x');
    var regY         = document.getElementById('stats-reg-y');
    var hypCol       = document.getElementById('stats-hyp-col');
    var hypMean      = document.getElementById('stats-hyp-mean');
    var chiA         = document.getElementById('stats-chi-a');
    var chiB         = document.getElementById('stats-chi-b');

    if (!statsView) return;

    // ── Segmented control ─────────────────────────────────────────
    document.querySelectorAll('#stats-seg .stats-seg-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('#stats-seg .stats-seg-btn').forEach(function(b){b.classList.remove('active');});
        btn.classList.add('active');
        var target = btn.dataset.stats;
        document.querySelectorAll('.stats-panel').forEach(function(p){p.classList.remove('active');});
        var panel = document.getElementById('stats-'+target+'-panel');
        if (panel) panel.classList.add('active');
        if (target==='corr') renderCorr();
        if (target==='reg') populateRegDropdowns();
        if (target==='hyp') populateHypDropdowns();
      });
    });

    // T-test / Chi-square toggle
    var hypTBtn = document.getElementById('hyp-t-btn');
    var hypChiBtn = document.getElementById('hyp-chi-btn');
    var hypTCtrl = document.getElementById('hyp-t-controls');
    var hypChiCtrl = document.getElementById('hyp-chi-controls');
    if (hypTBtn) hypTBtn.addEventListener('click', function() {
      hypTBtn.classList.add('active'); hypChiBtn.classList.remove('active');
      hypTCtrl.style.display=''; hypChiCtrl.style.display='none';
    });
    if (hypChiBtn) hypChiBtn.addEventListener('click', function() {
      hypChiBtn.classList.add('active'); hypTBtn.classList.remove('active');
      hypTCtrl.style.display='none'; hypChiCtrl.style.display='';
    });

    // ── Render Correlation Matrix ──────────────────────────
    function renderCorr() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) { corrOutput.innerHTML='<div class="stats-empty">No dataset loaded.</div>'; return; }
      var numCols = ds.columns.map(function(c,i){return{name:c.name,idx:i};}).filter(function(c){return ds.columns[c.idx].type==='FLOAT'||ds.columns[c.idx].type==='INT';});
      if (numCols.length < 2) { corrOutput.innerHTML='<div class="stats-empty">Need at least 2 numeric columns for correlation.</div>'; return; }
      var html='<div style="overflow-x:auto;"><table class="corr-table"><tr><th></th>';
      numCols.forEach(function(c){html+='<th>'+escH(c.name.substring(0,12))+'</th>';});
      html+='</tr>';
      numCols.forEach(function(ci,i){
        html+='<tr><th style="text-align:left;padding:4px 8px;">'+escH(ci.name.substring(0,12))+'</th>';
        numCols.forEach(function(cj,j){
          var xv=ds.rows.map(function(r){return parseFloat(r[ci.idx]);});
          var yv=ds.rows.map(function(r){return parseFloat(r[cj.idx]);});
          var pairs=xv.map(function(v,k){return[v,yv[k]];}).filter(function(p){return !isNaN(p[0])&&!isNaN(p[1]);});
          var r=i===j?1:pearson(pairs.map(function(p){return p[0];}),pairs.map(function(p){return p[1];}));
          var rStr=(r===null?'N/A':(r>=0?'+':'')+r.toFixed(2));
          var bg=r===null?'transparent':corrColor(r);
          var textColor=Math.abs(r||0)>0.4?'#fff':'var(--text)';
          var tip=r!==null?('r = '+r.toFixed(2)+'  -  '+corrStrengthLabel(r)):'Not enough data';
          tip=tip.replace(/\u2014/g,' - ');
          html+='<td style="background:'+bg+';color:'+textColor+';" data-tip="'+escH(tip)+'" title="'+escH(tip)+'">'+rStr+'</td>';
        });
        html+='</tr>';
      });
      html+='</table></div><div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Pearson r. Teal = positive, red = negative. Click any cell for details.</div>';
      corrOutput.innerHTML=html;

      // Click-to-tooltip behavior (in addition to native title attribute)
      corrOutput.querySelectorAll('.corr-table td').forEach(function(td) {
        td.addEventListener('click', function() {
          var tip = td.getAttribute('data-tip');
          if (tip && window.showToast) window.showToast(tip, 'info');
        });
      });
    }

    // ── Regression ─────────────────────────────────────────
    function populateRegDropdowns() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds||!regX||!regY) return;
      var numCols=ds.columns.filter(function(c){return c.type==='FLOAT'||c.type==='INT';});
      var opts='<option value="">-- select --</option>'+numCols.map(function(c){return '<option value="'+escH(c.name)+'">'+escH(c.name)+'</option>';}).join('');
      regX.innerHTML=opts; regY.innerHTML=opts;
    }

    var regRunBtn = document.getElementById('stats-reg-run');
    if (regRunBtn) regRunBtn.addEventListener('click', function() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) { regOutput.innerHTML='<div class="stats-empty">No dataset loaded.</div>'; return; }
      var xName=regX.value, yName=regY.value;
      if (!xName||!yName||xName===yName) { regOutput.innerHTML='<div class="stats-empty">Select two different numeric columns.</div>'; return; }
      var xi=ds.columns.findIndex(function(c){return c.name===xName;}), yi=ds.columns.findIndex(function(c){return c.name===yName;});
      var pairs=ds.rows.map(function(r){return[parseFloat(r[xi]),parseFloat(r[yi])];}).filter(function(p){return !isNaN(p[0])&&!isNaN(p[1]);});
      if (pairs.length<5) { regOutput.innerHTML='<div class="stats-empty">Need at least 5 valid data points.</div>'; return; }
      var xs=pairs.map(function(p){return p[0];}), ys=pairs.map(function(p){return p[1];});
      var res=linReg(xs, ys);
      var sigClass=res.p<0.05?'sig':'ns';
      var sigText=res.p<0.05?'Statistically significant (p < 0.05)':'Not significant (p >= 0.05)';
      // SVG scatter
      var mnX=Math.min.apply(null,xs), mxX=Math.max.apply(null,xs), mnY=Math.min.apply(null,ys), mxY=Math.max.apply(null,ys);
      var W=300, H=140, pad=20;
      function sx(v){return pad+(v-mnX)/(mxX-mnX||1)*(W-2*pad);}
      function sy(v){return H-pad-(v-mnY)/(mxY-mnY||1)*(H-2*pad);}
      var dots=pairs.slice(0,200).map(function(p){return '<circle cx="'+sx(p[0]).toFixed(1)+'" cy="'+sy(p[1]).toFixed(1)+'" r="2.5" fill="#20808D" opacity="0.55"/>';}).join('');
      var x1=mnX, y1=res.slope*mnX+res.intercept, x2=mxX, y2=res.slope*mxX+res.intercept;
      var line='<line x1="'+sx(x1).toFixed(1)+'" y1="'+sy(y1).toFixed(1)+'" x2="'+sx(x2).toFixed(1)+'" y2="'+sy(y2).toFixed(1)+'" stroke="#20808D" stroke-width="2" opacity="0.9"/>';
      var svg='<svg class="reg-svg" viewBox="0 0 '+W+' '+H+'" style="border:1px solid var(--border);border-radius:6px;background:var(--surface-alt);margin-top:10px;">'+dots+line+'<text x="'+sx(mnX)+'" y="'+(H-4)+'" font-size="9" fill="var(--text-muted)">'+mnX.toFixed(1)+'</text><text x="'+(sx(mxX)-20)+'" y="'+(H-4)+'" font-size="9" fill="var(--text-muted)">'+mxX.toFixed(1)+'</text></svg>';
      regOutput.innerHTML='<div class="stats-result">'+escH(yName)+' = '+(res.slope>=0?'+':'')+res.slope.toFixed(4)+' x '+escH(xName)+' + '+res.intercept.toFixed(4)+'</div>'+
        '<div class="stats-sub">R2 = '+res.r2.toFixed(3)+' - '+r2Label(res.r2)+'<br>'+pLabel(res.p)+' (t = '+res.tStat.toFixed(3)+', df = '+res.df+', SE = '+res.se.toFixed(4)+')<br>n = '+pairs.length+' valid pairs</div>'+
        '<span class="stats-verdict '+sigClass+'">'+sigText+'</span>'+svg;
    });

    // ── Hypothesis Testing ──────────────────────────────────────
    function populateHypDropdowns() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds) return;
      var numCols=ds.columns.filter(function(c){return c.type==='FLOAT'||c.type==='INT';});
      var catCols=ds.columns.filter(function(c){return c.type==='STR'||c.type==='BOOL';});
      if (hypCol) hypCol.innerHTML='<option value="">-- select --</option>'+numCols.map(function(c){return '<option value="'+escH(c.name)+'">'+escH(c.name)+'</option>';}).join('');
      if (chiA) chiA.innerHTML='<option value="">-- select --</option>'+catCols.map(function(c){return '<option value="'+escH(c.name)+'">'+escH(c.name)+'</option>';}).join('');
      if (chiB) chiB.innerHTML='<option value="">-- select --</option>'+catCols.map(function(c){return '<option value="'+escH(c.name)+'">'+escH(c.name)+'</option>';}).join('');
    }

    var hypRunBtn = document.getElementById('stats-hyp-run');
    if (hypRunBtn) hypRunBtn.addEventListener('click', function() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds||!hypCol||!hypCol.value) { hypOutput.innerHTML='<div class="stats-empty">Select a column.</div>'; return; }
      var ci=ds.columns.findIndex(function(c){return c.name===hypCol.value;});
      var vals=ds.rows.map(function(r){return parseFloat(r[ci]);}).filter(function(v){return !isNaN(v);});
      if (vals.length<3) { hypOutput.innerHTML='<div class="stats-empty">Need at least 3 valid values.</div>'; return; }
      var mu0=parseFloat(hypMean.value)||0;
      var res=tTest(vals, mu0);
      var sig=res.p<0.05;
      var conclusion=sig?('Reject H0: The mean of '+hypCol.value+' ('+res.mean.toFixed(2)+') is significantly different from '+mu0+'.'):('Fail to reject H0: No significant difference from '+mu0+' detected.');
      hypOutput.innerHTML='<div class="stats-result">One-sample t-test: '+escH(hypCol.value)+' vs mean = '+mu0+'</div>'+
        '<div class="stats-sub">t = '+res.t.toFixed(3)+', df = '+res.df+', '+pLabel(res.p)+'<br>Sample mean = '+res.mean.toFixed(4)+', SD = '+res.sd.toFixed(4)+', n = '+res.n+'</div>'+
        '<span class="stats-verdict '+(sig?'sig':'ns')+'">'+escH(conclusion)+'</span>';
    });

    var chiRunBtn = document.getElementById('stats-chi-run');
    if (chiRunBtn) chiRunBtn.addEventListener('click', function() {
      var ds = window.getActiveDataset && window.getActiveDataset();
      if (!ds||!chiA||!chiA.value||!chiB||!chiB.value) { hypOutput.innerHTML='<div class="stats-empty">Select two categorical columns.</div>'; return; }
      var ai=ds.columns.findIndex(function(c){return c.name===chiA.value;}), bi=ds.columns.findIndex(function(c){return c.name===chiB.value;});
      var colA=ds.rows.map(function(r){return String(r[ai]||'');});
      var colB=ds.rows.map(function(r){return String(r[bi]||'');});
      var res=chiSquare(colA, colB);
      var sig=res.p<0.05;
      var conclusion=sig?('Significant association between '+chiA.value+' and '+chiB.value+' (p < 0.05).'):('No significant association detected (p >= 0.05).');
      hypOutput.innerHTML='<div class="stats-result">Chi-square test: '+escH(chiA.value)+' vs '+escH(chiB.value)+'</div>'+
        '<div class="stats-sub">chi2 = '+res.chi2.toFixed(3)+', df = '+res.df+', '+pLabel(res.p)+'</div>'+
        '<span class="stats-verdict '+(sig?'sig':'ns')+'">'+escH(conclusion)+'</span>';
    });

    // ── Auto-refresh on dataset load ───────────────────────────
    document.addEventListener('dataglow:dataset-loaded', function() {
      populateRegDropdowns(); populateHypDropdowns();
      var corrPanel = document.getElementById('stats-corr-panel');
      if (corrPanel && corrPanel.classList.contains('active')) renderCorr();
    });

    // Also hook analyze pill click
    var statsPill = document.querySelector('[data-panel="stats-view"]');
    if (statsPill) statsPill.addEventListener('click', function() {
      var active = document.querySelector('#stats-seg .stats-seg-btn.active');
      if (!active || active.dataset.stats === 'corr') renderCorr();
      else if (active.dataset.stats === 'reg') populateRegDropdowns();
      else populateHypDropdowns();
    });
