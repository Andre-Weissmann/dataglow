/* DataGlow — src/js/panels/business-translation.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    var BIZ_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 9h10M1 6h7M1 3h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

    function escBiz(s) {
      return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function titleCaseBiz(s) {
      return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    // Translate one technical validation finding (dataset.findings entry)
    // into a plain-English business-impact statement.
    function translateFinding(f) {
      f = f || {};
      var col = f.column || f.colName || f.col || 'this field';
      var colLabel = titleCaseBiz(col);
      var msg = f.message || f.msg || '';
      var rule = f.rule || f.type || '';
      var sev = (f.severity || '').toLowerCase();
      var rowCount = f.rowCount;

      // Null / missing values (null_threshold_v2)
      if (rule.indexOf('null_threshold') >= 0 || /null|missing/i.test(msg)) {
        var pctMatch = msg.match(/(\d+\.?\d*)\s*%/);
        var pct = pctMatch ? parseFloat(pctMatch[1]) : null;
        var high = sev === 'error' || (pct !== null && pct > 10);
        if (high) {
          var inN = pct && pct > 0 ? Math.max(1, Math.round(100 / pct)) : null;
          var text = (inN ? ('Roughly 1 in ' + inN + ' records') : (rowCount ? (rowCount + ' records') : 'A large share of records')) +
            ' is missing a value for ' + colLabel + '. This could cause incorrect totals or failed calculations in downstream reports.';
          return { sev: 'high', tag: 'Data Gap', text: text };
        }
        var pctLabel = pct !== null ? pct.toFixed(0) : 'a small percentage of';
        return { sev: 'medium', tag: 'Partial Gap', text: 'About ' + pctLabel + (pct !== null ? '%' : '') + ' of ' + colLabel + ' values are blank. Worth investigating if this is expected or a data quality issue.' };
      }

      // Negative-value check (no_negative_currency_v2) - treated as an outlier-style issue
      if (rule.indexOf('no_negative_currency') >= 0 || /negative/i.test(msg)) {
        var valMatch = msg.match(/\(([-\d.]+)\)/);
        var lowVal = valMatch ? valMatch[1] : 'an unexpectedly low value';
        return { sev: 'medium', tag: 'Unusual Values', text: colLabel + ' contains values far outside the normal range (as low as ' + lowVal + '). These outliers could skew averages and mislead trend analysis.' };
      }

      // Streaming value drift / mean shift -> outlier-style business framing
      if (rule.indexOf('streaming_value_drift') >= 0 || /mean shift/i.test(msg)) {
        return { sev: 'medium', tag: 'Unusual Values', text: colLabel + ' contains values far outside its normal historical range. These outliers could skew averages and mislead trend analysis.' };
      }

      // Schema drift -> structural change, closest to type_mismatch / structural risk
      if (rule.indexOf('streaming_schema_drift') >= 0 || /schema drift/i.test(msg)) {
        return { sev: 'high', tag: 'Mixed / Changed Structure', text: 'The set of columns in this dataset changed from the last upload. This will cause errors in any report or calculation built against the old structure.' };
      }

      // Arrival anomaly -> closest to duplicate_rows / row-count integrity issue
      if (rule.indexOf('streaming_arrival_anomaly') >= 0 || /arrival anomaly/i.test(msg)) {
        var n = rowCount || 'An unusual number of';
        return { sev: 'medium', tag: 'Volume Anomaly', text: n + ' rows arrived in this batch, outside the expected pattern. If each row should represent a unique event, this could double-count or under-count metrics.' };
      }

      // Low cardinality
      if (/low cardinality/i.test(msg) || rule.indexOf('low_cardinality') >= 0) {
        return { sev: 'low', tag: 'Limited Categories', text: colLabel + ' only has a few unique values. If it is a category field, this looks correct. If it should be free text, check for data entry issues.' };
      }

      // High cardinality
      if (/high cardinality/i.test(msg) || rule.indexOf('high_cardinality') >= 0) {
        return { sev: 'low', tag: 'ID-Like Column', text: colLabel + ' has nearly as many unique values as rows. This may be an ID or free-text field, likely not useful for grouping or charting.' };
      }

      // Type mismatch
      if (/mixed type|type mismatch/i.test(msg) || rule.indexOf('type_mismatch') >= 0) {
        return { sev: 'high', tag: 'Mixed Data Types', text: colLabel + ' has mixed data types, some values look like numbers, others like text. This will cause errors in any numeric calculation.' };
      }

      // Duplicate rows
      if (/duplicate/i.test(msg) || rule.indexOf('duplicate') >= 0) {
        var dupCount = rowCount || 'Several';
        return { sev: 'high', tag: 'Duplicate Records', text: dupCount + ' duplicate rows detected. If each row should be a unique event or record, these duplicates may double-count metrics.' };
      }

      // Empty column
      if (/completely empty|all null|empty column/i.test(msg) || rule.indexOf('empty_column') >= 0) {
        return { sev: 'high', tag: 'Empty Column', text: colLabel + ' is completely empty. It contributes nothing to analysis and may indicate a data extraction error.' };
      }

      // Outlier fallback (generic)
      if (/outlier/i.test(msg) || rule.indexOf('outlier') >= 0) {
        return { sev: 'medium', tag: 'Unusual Values', text: colLabel + ' contains values far outside the normal range. These outliers could skew averages and mislead trend analysis.' };
      }

      // Generic fallback: pass through message with a neutral tag/severity
      var fallbackSev = sev === 'error' ? 'high' : sev === 'warning' ? 'medium' : 'low';
      return { sev: fallbackSev, tag: 'Quality Flag', text: escBiz(msg) || (colLabel + ' has a data quality issue worth reviewing.') };
    }

    function renderBizFindings(findings, container) {
      if (!findings || !findings.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'biz-findings-wrap';
      var html = findings.map(function (f) {
        var t = translateFinding(f);
        var sev = t.sev || 'low';
        var color = sev === 'high' ? '#A12C7B' : sev === 'medium' ? '#964219' : '#437A22';
        return '<div class="biz-finding ' + sev + '"><div class="biz-finding-tag" style="color:' + color + '">' + escBiz(t.tag) + '</div>' + escBiz(t.text) + '</div>';
      }).join('');
      html += '<span class="biz-back-link" id="biz-back-link">Show technical findings</span>';
      wrap.innerHTML = html;

      container.innerHTML = '';
      container.appendChild(wrap);

      var backLink = wrap.querySelector('#biz-back-link');
      if (backLink) {
        backLink.addEventListener('click', function () {
          var ds = window.getActiveDataset && window.getActiveDataset();
          if (ds && window.FindingsRail) {
            window.FindingsRail.render(ds, container);
            attachTranslateBtn(container, ds.findings);
          }
        });
      }
    }

    function attachTranslateBtn(findingsContainer, findings) {
      if (!findings || !findings.length) return;
      var old = findingsContainer.querySelector('.biz-translate-btn');
      if (old) old.remove();
      var btn = document.createElement('button');
      btn.className = 'biz-translate-btn';
      btn.innerHTML = BIZ_ICON + ' Translate for Business';
      btn.addEventListener('click', function () {
        var isActive = btn.classList.contains('active');
        if (isActive) {
          var ds = window.getActiveDataset && window.getActiveDataset();
          if (ds && window.FindingsRail) {
            window.FindingsRail.render(ds, findingsContainer);
            attachTranslateBtn(findingsContainer, ds.findings);
          }
          return;
        }
        btn.classList.add('active');
        renderBizFindings(findings, findingsContainer);
        findingsContainer.appendChild(btn);
      });
      findingsContainer.appendChild(btn);
    }

    // Observe the dashboard view for findings rail renders, and attach the
    // translate button once the rail has content and real findings exist.
    function watchDashboard() {
      var dashView = document.getElementById('dashboard-view');
      if (!dashView) return;
      var obs = new MutationObserver(function () {
        var ds = window.getActiveDataset && window.getActiveDataset();
        if (!ds || !ds.findings || !ds.findings.length) return;
        var frContainer = dashView.querySelector('#findings-rail-container');
        if (!frContainer) return;
        if (!frContainer.querySelector('.biz-translate-btn')) {
          attachTranslateBtn(frContainer, ds.findings);
        }
      });
      obs.observe(dashView, { childList: true, subtree: true });
    }

    document.addEventListener('dataglow:dataset-loaded', function () {
      setTimeout(watchDashboard, 300);
    });

    watchDashboard();

    // Expose for external use / testing
    window.BusinessTranslator = { translate: translateFinding, renderBiz: renderBizFindings };
