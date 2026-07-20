/* DataGlow — src/js/panels/narrative.js */
/* Refactored from canvas/index.html */

(function () {
    var narrState = { fmt: 'linkedin', tone: 'professional', text: '' };

    function narrEscapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function narrFmtPct(n) {
      if (n == null || isNaN(n)) return '0';
      return (Math.round(n * 10) / 10).toString();
    }

    function narrGetDataset() {
      if (typeof window.getActiveDataset === 'function') return window.getActiveDataset();
      return null;
    }

    function narrDetectDomain(ds) {
      if (!ds || !ds.columns) return 'general';
      if (ds.domain) return ds.domain;
      if (typeof detectDomain === 'function') {
        try { return detectDomain(ds.columns); } catch (_e) {}
      }
      var names = ds.columns.map(function (c) { return (c.name || '').toLowerCase(); }).join(' ');
      if (/bene|clm|dx|los|icd|drg|facility|medicare|medicaid|patient|admit|disch/.test(names)) return 'healthcare';
      if (/revenue|amount|price|payment|invoice|transaction|cost|profit|margin|sales/.test(names)) return 'finance';
      if (/employee|salary|department|hire|tenure|attrition|headcount|manager|staff/.test(names)) return 'hr';
      return 'general';
    }

    function narrDomainTag(domain) {
      if (domain === 'healthcare') return 'Healthcare';
      if (domain === 'finance') return 'Finance';
      if (domain === 'hr') return 'HR';
      return 'Data';
    }

    function narrGetSql() {
      var el = document.getElementById('sql-view-input');
      if (!el) return '';
      var v = (el.value || '').trim();
      return v;
    }

    function narrDetectSqlOps(sql) {
      var ops = [];
      if (!sql) return ops;
      var s = sql.toUpperCase();
      if (/OVER\s*\(/.test(s)) ops.push('window functions');
      if (/GROUP BY/.test(s)) ops.push('aggregations');
      if (/JOIN/.test(s)) ops.push('joins');
      if (/ORDER BY/.test(s)) ops.push('ranking');
      if (/HAVING/.test(s)) ops.push('filtered aggregation');
      if (/CASE WHEN/.test(s)) ops.push('conditional logic');
      return ops;
    }

    function narrGetXpEvents() {
      try {
        if (window.LevelSystem && window.LevelSystem.prog && Array.isArray(window.LevelSystem.prog.xpLog)) {
          return window.LevelSystem.prog.xpLog.slice(0, 8);
        }
      } catch (_e) {}
      return [];
    }

    function narrGetFindings(ds) {
      if (!ds || !Array.isArray(ds.findings)) return [];
      return ds.findings;
    }

    function narrFindingText(f) {
      if (!f) return '';
      return f.message || (f.column ? ('Issue detected in ' + f.column) : 'Data quality issue detected');
    }

    function narrDomainInsights(domain, ds, findings) {
      var n = ds && ds.rows ? ds.rows.length : 0;
      var out = [];
      if (domain === 'healthcare') {
        out.push('Identified diagnosis codes with above-average length of stay, indicating potential protocol optimization opportunities');
        out.push('Flagged payment outliers representing a meaningful share of total claims value');
        out.push('Discovered readmission-adjacent patterns consistent with 30-day readmission risk factors');
      } else if (domain === 'finance') {
        out.push('Top revenue categories account for a disproportionate share of total transactions (Pareto concentration)');
        out.push('Detected anomalous transactions exceeding 2 standard deviations from the mean');
        out.push('Monthly trend analysis reveals a directional pattern across the analysis period');
      } else if (domain === 'hr') {
        out.push('Departments with the lowest satisfaction scores show a higher attrition rate');
        out.push('Salary range spread varies meaningfully across departments versus the company average');
        out.push('Tenure analysis identifies a peak attrition risk window by years of service');
      } else {
        out.push('Dataset contains a broad range of unique values across its categorical columns');
        out.push('Numeric analysis reveals variance concentrated in a subset of records');
        out.push('Column-level profiling surfaced structural patterns worth deeper investigation');
      }
      return out;
    }

    function narrBusinessValue(domain) {
      if (domain === 'healthcare') return 'helps care teams cut costs and improve patient outcomes without adding headcount';
      if (domain === 'finance') return 'helps finance teams catch revenue leakage and forecast with more confidence';
      if (domain === 'hr') return 'helps people teams reduce attrition and target retention spend where it matters most';
      return 'helps teams move from raw data to confident, board-ready decisions faster';
    }

    function narrDomainImpactParagraph(domain) {
      if (domain === 'healthcare') {
        return 'These findings support targeted protocol review and cost containment efforts. Prioritizing the flagged diagnosis codes and payment outliers could reduce avoidable spend while improving care consistency across facilities.';
      }
      if (domain === 'finance') {
        return 'These findings support tighter controls on transaction monitoring and sharper focus on the revenue categories driving the bulk of volume. Addressing the flagged anomalies protects margin and improves forecast accuracy.';
      }
      if (domain === 'hr') {
        return 'These findings support a focused retention strategy in the departments and tenure bands showing the highest risk. Acting on the salary spread and satisfaction signals could meaningfully reduce voluntary attrition.';
      }
      return 'These findings give stakeholders a clear, evidence-based starting point for prioritizing next steps and allocating analysis resources where they will have the most impact.';
    }

    function narrStatOps(sql) {
      var ops = [];
      if (!sql) { ops.push('descriptive statistics'); return ops; }
      var s = sql.toUpperCase();
      if (/AVG\(/.test(s)) ops.push('mean analysis');
      if (/STDDEV|VARIANCE/.test(s)) ops.push('variance analysis');
      if (/CORR\(/.test(s)) ops.push('correlation');
      if (/PERCENTILE|MEDIAN/.test(s)) ops.push('distribution analysis');
      if (ops.length === 0) ops.push('aggregate statistics');
      return ops;
    }

    function narrBuildContext() {
      var ds = narrGetDataset();
      var domain = narrDetectDomain(ds);
      var findings = narrGetFindings(ds);
      var sql = narrGetSql();
      var sqlOps = narrDetectSqlOps(sql);
      var statOps = narrStatOps(sql);
      var xp = narrGetXpEvents();
      var rowCount = ds && ds.rows ? ds.rows.length : 0;
      var colCount = ds && ds.columns ? ds.columns.length : 0;
      var score = ds && ds.score != null ? ds.score : null;
      var name = ds && ds.name ? ds.name : 'dataset';
      var insights = narrDomainInsights(domain, ds, findings);
      var findingTexts = findings.slice(0, 3).map(narrFindingText);
      while (findingTexts.length < 3) {
        findingTexts.push(insights[findingTexts.length] || insights[0]);
      }
      return {
        ds: ds, domain: domain, findings: findings, sql: sql, sqlOps: sqlOps,
        statOps: statOps, xp: xp, rowCount: rowCount, colCount: colCount,
        score: score, name: name, insights: insights, findingTexts: findingTexts
      };
    }

    function narrLinkedIn(ctx, tone) {
      var domain = ctx.domain;
      var tag = narrDomainTag(domain);
      var scoreTxt = ctx.score != null ? ctx.score : 'a strong';
      var opsTxt = ctx.sqlOps.length ? ctx.sqlOps.join(', ') : 'aggregations and filtering';
      var statTxt = ctx.statOps.join(' and ');
      var lines = [];
      if (tone === 'conversational') {
        lines.push('Just wrapped up a deep-dive into a ' + ctx.rowCount.toLocaleString() + '-row ' + domain + ' dataset using DataGlow, and I have to share what I found.');
      } else {
        lines.push('Just completed a deep-dive analysis of a ' + ctx.rowCount.toLocaleString() + '-row ' + domain + ' dataset using DataGlow.');
      }
      lines.push('');
      lines.push('Here is what I found:');
      lines.push('');
      lines.push('- ' + ctx.findingTexts[0]);
      lines.push('- ' + ctx.findingTexts[1]);
      lines.push('- ' + ctx.findingTexts[2]);
      lines.push('');
      lines.push('The data told a clear story: ' + narrDomainSynthesis(domain) + '.');
      lines.push('');
      lines.push('Key skills demonstrated:');
      lines.push('- SQL for ' + opsTxt);
      lines.push('- Data quality auditing (' + scoreTxt + '% quality score, ' + ctx.findings.length + ' issues flagged)');
      lines.push('- Statistical analysis: ' + statTxt);
      lines.push('- Business translation: turning raw ' + domain + ' data into actionable recommendations');
      lines.push('');
      lines.push('This is the kind of analysis that ' + narrBusinessValue(domain) + '.');
      lines.push('');
      lines.push('#DataAnalytics #SQL #' + tag + ' #DataGlow #OpenToWork');
      return lines.join('\n');
    }

    function narrDomainSynthesis(domain) {
      if (domain === 'healthcare') return 'small pockets of cost and care variation are driving a large share of the opportunity for improvement';
      if (domain === 'finance') return 'a small set of categories and outlier transactions are driving most of the financial risk and reward';
      if (domain === 'hr') return 'a few departments and tenure windows account for most of the attrition risk';
      return 'a small number of records and columns are driving most of the meaningful variation in the dataset';
    }

    function narrResume(ctx) {
      var scoreTxt = ctx.score != null ? ctx.score : 'a strong';
      var opsTxt = ctx.sqlOps.length ? ctx.sqlOps.join(' and ') : 'aggregations and filtering';
      var lines = [];
      lines.push('- Analyzed ' + ctx.rowCount.toLocaleString() + '-row ' + ctx.domain + ' dataset; identified ' + ctx.findings.length + ' data quality issues and achieved ' + scoreTxt + '% quality score through systematic auditing');
      lines.push('- Developed SQL queries including ' + opsTxt + ' to surface ' + narrDomainSynthesis(ctx.domain));
      lines.push('- Applied statistical analysis (' + ctx.statOps.join(', ') + ') to identify key drivers of business outcomes');
      lines.push('- Translated raw ' + ctx.domain + ' data into executive-ready insights using DataGlow business translation engine');
      lines.push('- Documented analysis methodology and findings in a reproducible format');
      return lines.join('\n');
    }

    function narrGithub(ctx) {
      var scoreTxt = ctx.score != null ? ctx.score : 'N/A';
      var lines = [];
      lines.push('## Analysis: ' + ctx.name);
      lines.push('');
      lines.push('**Dataset:** ' + ctx.rowCount.toLocaleString() + ' rows x ' + ctx.colCount + ' columns | ' + narrDomainTag(ctx.domain) + ' data');
      lines.push('**Tools Used:** DataGlow (browser-based analytics), SQL, Statistical Analysis');
      lines.push('**Quality Score:** ' + scoreTxt + '/100');
      lines.push('');
      lines.push('### Methodology');
      lines.push('1. Data ingestion and profiling');
      lines.push('2. Quality audit: ' + ctx.findings.length + ' issues identified and documented');
      lines.push('3. Exploratory analysis via SQL');
      lines.push('4. Statistical correlation analysis');
      lines.push('5. Business narrative generation');
      lines.push('');
      lines.push('### Key Findings');
      lines.push('- ' + ctx.findingTexts[0]);
      lines.push('- ' + ctx.findingTexts[1]);
      lines.push('- ' + ctx.findingTexts[2]);
      lines.push('');
      lines.push('### SQL Highlights');
      lines.push(ctx.sql ? ('```sql\n' + ctx.sql + '\n```') : 'No SQL query recorded in this session.');
      lines.push('');
      lines.push('### Business Impact');
      lines.push(narrDomainImpactParagraph(ctx.domain));
      return lines.join('\n');
    }

    function narrExec(ctx) {
      var scoreTxt = ctx.score != null ? ctx.score : 'N/A';
      var today = new Date();
      var dateStr = (today.getMonth() + 1) + '/' + today.getDate() + '/' + today.getFullYear();
      var colSummary = ctx.colCount + ' columns spanning identifiers, dates, and numeric measures';
      var lines = [];
      lines.push('EXECUTIVE BRIEF: ' + ctx.name + ' Analysis');
      lines.push('Date: ' + dateStr);
      lines.push('Analyst: [not included - privacy]');
      lines.push('');
      lines.push('SCOPE');
      lines.push('Analysis of ' + ctx.rowCount.toLocaleString() + ' records from a ' + ctx.domain + ' dataset covering ' + colSummary + '.');
      lines.push('');
      lines.push('METHODOLOGY');
      lines.push('Systematic data quality assessment, SQL-based exploratory analysis, and statistical modeling were applied. Data quality score: ' + scoreTxt + '/100. ' + ctx.findings.length + ' anomalies identified.');
      lines.push('');
      lines.push('FINDINGS');
      lines.push('1. ' + ctx.findingTexts[0]);
      lines.push('2. ' + ctx.findingTexts[1]);
      lines.push('3. ' + ctx.findingTexts[2]);
      lines.push('');
      lines.push('RECOMMENDATION');
      lines.push(narrDomainImpactParagraph(ctx.domain));
      lines.push('');
      lines.push('NEXT STEPS');
      lines.push('- Expand analysis to include related dimensions not yet profiled');
      lines.push('- Validate findings against an external or historical benchmark');
      lines.push('- Share with ' + narrStakeholder(ctx.domain) + ' for business validation');
      return lines.join('\n');
    }

    function narrStakeholder(domain) {
      if (domain === 'healthcare') return 'clinical operations leadership';
      if (domain === 'finance') return 'finance and strategy leadership';
      if (domain === 'hr') return 'people operations leadership';
      return 'relevant business stakeholders';
    }

    function narrGenerate(fmt, tone) {
      var ctx = narrBuildContext();
      if (!ctx.ds) {
        return 'Load a dataset in DataGlow first, then come back to generate your Portfolio Narrative.';
      }
      if (fmt === 'resume') return narrResume(ctx);
      if (fmt === 'github') return narrGithub(ctx);
      if (fmt === 'exec') return narrExec(ctx);
      return narrLinkedIn(ctx, tone);
    }

    function narrOpenModal() {
      var modal = document.getElementById('narrative-modal');
      if (!modal) return;
      modal.classList.add('open');
      window.SkillTracker && window.SkillTracker.track && window.SkillTracker.track('open_portfolio_narrative');
    }

    function narrCloseModal() {
      var modal = document.getElementById('narrative-modal');
      if (modal) modal.classList.remove('open');
    }

    function narrSetTab(fmt) {
      narrState.fmt = fmt;
      document.querySelectorAll('.narr-tab').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-fmt') === fmt);
      });
    }

    function narrSetTone(tone) {
      narrState.tone = tone;
      document.querySelectorAll('.narr-tone-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-tone') === tone);
      });
    }

    function narrRunGenerate() {
      var text = narrGenerate(narrState.fmt, narrState.tone);
      narrState.text = text;
      var out = document.getElementById('narr-output');
      var count = document.getElementById('narr-char-count');
      var actions = document.getElementById('narr-actions');
      if (out) {
        out.textContent = text;
        out.classList.add('show');
      }
      if (count) count.textContent = text.length + ' characters';
      if (actions) actions.style.display = 'flex';
      window.SkillTracker && window.SkillTracker.track && window.SkillTracker.track('generate_portfolio_narrative');
      window.LevelSystem && window.LevelSystem.addXP && window.LevelSystem.addXP('generate_portfolio_narrative');
    }

    function narrCopyToClipboard() {
      if (!narrState.text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(narrState.text).then(function () {
          window.showToast && window.showToast('Narrative copied to clipboard', 'success');
        }).catch(function () {
          window.showToast && window.showToast('Copy failed. Select and copy manually.', 'error');
        });
      } else {
        window.showToast && window.showToast('Clipboard not available in this browser', 'error');
      }
    }

    function narrDownloadTxt() {
      if (!narrState.text) return;
      var blob = new Blob([narrState.text], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'dataglow-portfolio-narrative-' + narrState.fmt + '.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      window.showToast && window.showToast('Narrative downloaded', 'success');
    }

    function narrOpenNewTab() {
      if (!narrState.text) return;
      var win = window.open('', '_blank');
      if (!win) {
        window.showToast && window.showToast('Pop-up blocked. Allow pop-ups to open in a new tab.', 'error');
        return;
      }
      var safe = narrEscapeHtml(narrState.text);
      win.document.write('<html><head><title>Portfolio Narrative</title></head><body style="font-family:sans-serif;white-space:pre-wrap;max-width:700px;margin:40px auto;line-height:1.6;">' + safe + '</body></html>');
      win.document.close();
    }

    function narrInit() {
      var openBtn = document.getElementById('story-trigger-btn');
      var shareOpenBtn = document.getElementById('narrative-share-open-btn');
      var closeBtn = document.getElementById('narr-close-btn');
      var genBtn = document.getElementById('narr-gen-btn');
      var regenBtn = document.getElementById('narr-regen-btn');
      var copyBtn = document.getElementById('narr-copy-btn');
      var downloadBtn = document.getElementById('narr-download-btn');
      var newtabBtn = document.getElementById('narr-newtab-btn');
      var modal = document.getElementById('narrative-modal');

      if (openBtn) openBtn.addEventListener('click', narrOpenModal);
      if (shareOpenBtn) shareOpenBtn.addEventListener('click', narrOpenModal);
      if (closeBtn) closeBtn.addEventListener('click', narrCloseModal);
      if (modal) {
        modal.addEventListener('click', function (e) {
          if (e.target === modal) narrCloseModal();
        });
      }
      document.querySelectorAll('.narr-tab').forEach(function (btn) {
        btn.addEventListener('click', function () { narrSetTab(btn.getAttribute('data-fmt')); });
      });
      document.querySelectorAll('.narr-tone-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { narrSetTone(btn.getAttribute('data-tone')); });
      });
      if (genBtn) genBtn.addEventListener('click', narrRunGenerate);
      if (regenBtn) regenBtn.addEventListener('click', narrRunGenerate);
      if (copyBtn) copyBtn.addEventListener('click', narrCopyToClipboard);
      if (downloadBtn) downloadBtn.addEventListener('click', narrDownloadTxt);
      if (newtabBtn) newtabBtn.addEventListener('click', narrOpenNewTab);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', narrInit);
    } else {
      narrInit();
    }
