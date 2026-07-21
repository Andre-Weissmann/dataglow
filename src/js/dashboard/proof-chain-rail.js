/* DataGlow -- js/dashboard/proof-chain-rail.js */
/* PR AZ: Proof Chain Rail -- SQL + Python lineage visible on every AI insight */

/**
 * ProofChainRail -- wraps every insight card with its verifiable SQL and Python lineage.
 *
 * Philosophy: "DataGlow shows its work."
 * Every claim made by the insight engine must be traceable to:
 *   1. The SQL that produced the number (DuckDB-verifiable)
 *   2. The equivalent Python/pandas code that reproduces the same result
 *   3. The columns and row-range it touched
 *   4. A confidence tier (Verified / Estimated / Inferred)
 *
 * Public API:
 *   ProofChainRail.attachToCard(cardEl, proof)
 *   ProofChainRail.buildProof(findingObj, dataset) -> proofObj
 *   ProofChainRail.renderInline(containerEl, dataset, findings)
 *   ProofChainRail.attachToChartCard(cardEl, colName, chartType, dataset)
 */

var ProofChainRail = (function () {
  'use strict';

  /* ---- confidence tier classification ---- */
  function confidenceTier(finding) {
    var c = finding.confidence;
    if (c === undefined || c === null) c = 0.7;
    if (c >= 0.9) return { label: 'Verified', cls: 'pcr-tier-verified', icon: '\u2713' };
    if (c >= 0.7) return { label: 'Estimated', cls: 'pcr-tier-estimated', icon: '\u223C' };
    return { label: 'Inferred', cls: 'pcr-tier-inferred', icon: '\u2248' };
  }

  /* ---- build the SQL that explains the finding ---- */
  function buildExplanatorySQL(finding, dataset) {
    if (!dataset || !dataset.columns || !dataset.rows) return null;
    var tbl = '"' + (dataset.name || 'dataset').replace(/"/g, '') + '"';
    var type = finding.type || finding.statType || 'summary';
    var col = finding.col || finding.column || null;
    var colB = finding.colB || null;

    if (col && (type === 'outlier' || type === 'anomaly')) {
      var mean = (finding.mean || 0).toFixed(2);
      var sd3  = ((finding.stddev || 0) * 3).toFixed(2);
      return [
        'SELECT "' + col + '",',
        '       COUNT(*) AS row_count,',
        '       AVG("' + col + '") AS avg_val,',
        '       STDDEV("' + col + '") AS stddev_val',
        'FROM ' + tbl,
        'WHERE ABS("' + col + '" - ' + mean + ') > ' + sd3,
        'ORDER BY ABS("' + col + '" - ' + mean + ') DESC',
        'LIMIT 20'
      ].join('\n');
    }

    if (col && (type === 'correlation' || type === 'skew')) {
      var col2 = colB || col;
      return [
        'SELECT',
        '  CORR("' + col + '", "' + col2 + '") AS correlation,',
        '  AVG("' + col + '")              AS avg_' + safeAlias(col) + ',',
        '  AVG("' + col2 + '")             AS avg_' + safeAlias(col2),
        'FROM ' + tbl
      ].join('\n');
    }

    if (col && (type === 'top_category' || type === 'categorical')) {
      return [
        'SELECT "' + col + '",',
        '       COUNT(*) AS freq,',
        '       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct',
        'FROM ' + tbl,
        'GROUP BY "' + col + '"',
        'ORDER BY freq DESC',
        'LIMIT 10'
      ].join('\n');
    }

    if (col && (type === 'numeric' || type === 'distribution')) {
      return [
        'SELECT',
        '  COUNT("' + col + '")         AS n,',
        '  AVG("' + col + '")           AS mean,',
        '  MEDIAN("' + col + '")        AS median,',
        '  STDDEV("' + col + '")        AS stddev,',
        '  MIN("' + col + '")           AS min,',
        '  MAX("' + col + '")           AS max,',
        '  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY "' + col + '") AS p25,',
        '  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY "' + col + '") AS p75',
        'FROM ' + tbl
      ].join('\n');
    }

    if (col && (type === 'null_rate' || type === 'missing')) {
      return [
        'SELECT',
        '  COUNT(*) AS total_rows,',
        '  COUNT("' + col + '") AS non_null,',
        '  COUNT(*) - COUNT("' + col + '") AS null_count,',
        '  ROUND((COUNT(*) - COUNT("' + col + '")) * 100.0 / COUNT(*), 1) AS null_pct',
        'FROM ' + tbl
      ].join('\n');
    }

    /* generic fallback */
    var colList = dataset.columns.slice(0, 6).map(function (c) {
      return '  AVG(TRY_CAST("' + c.name + '" AS DOUBLE)) AS avg_' + safeAlias(c.name);
    }).join(',\n');
    return [
      'SELECT',
      '  COUNT(*) AS total_rows,',
      colList,
      'FROM ' + tbl
    ].join('\n');
  }

  /* ---- build the Python/pandas code that reproduces the finding ---- */
  function buildExplanatoryPython(finding, dataset) {
    if (!dataset || !dataset.columns || !dataset.rows) return null;
    var dfName = 'df';
    var dsName = (dataset.name || 'dataset').replace(/[^a-zA-Z0-9_]/g, '_');
    var type = finding.type || finding.statType || 'summary';
    var col = finding.col || finding.column || null;
    var colB = finding.colB || null;

    /* header comment -- always shown */
    var header = [
      '# DataGlow Python lineage -- reproduces this insight with pandas',
      '# Load your data:',
      '# df = pd.read_csv("' + dsName + '.csv")',
      '# or: df = dataglow.get_df("' + dsName + '")',
      ''
    ].join('\n');

    if (col && (type === 'outlier' || type === 'anomaly')) {
      var mean = (finding.mean || 0).toFixed(4);
      var stddev = (finding.stddev || 0).toFixed(4);
      return header + [
        'import pandas as pd',
        '',
        'mean_val  = ' + mean,
        'stddev_val = ' + stddev,
        'threshold = stddev_val * 3',
        '',
        'outliers = df[abs(df["' + col + '"] - mean_val) > threshold].copy()',
        'outliers = outliers.sort_values(',
        '    by="' + col + '",',
        '    key=lambda s: (s - mean_val).abs(),',
        '    ascending=False',
        ').head(20)',
        '',
        'print(f"Outliers in \'' + col + '\': {len(outliers)} / {len(df)} rows")',
        'print(outliers[["' + col + '"]].describe())'
      ].join('\n');
    }

    if (col && (type === 'correlation' || type === 'skew')) {
      var col2 = colB || col;
      if (col === col2) {
        return header + [
          'import pandas as pd',
          '',
          '# Skewness of ' + col,
          'skew = df["' + col + '"].skew()',
          'print(f"Skewness of \'' + col + '\': {skew:.4f}")',
          '',
          '# Distribution stats',
          'print(df["' + col + '"].describe())'
        ].join('\n');
      }
      return header + [
        'import pandas as pd',
        '',
        '# Pearson correlation',
        'corr = df["' + col + '"].corr(df["' + col2 + '"])',
        'print(f"Correlation \'' + col + '\' vs \'' + col2 + '\': {corr:.4f}")',
        '',
        '# Pair stats',
        'print(df[["' + col + '", "' + col2 + '"]].describe())'
      ].join('\n');
    }

    if (col && (type === 'top_category' || type === 'categorical')) {
      return header + [
        'import pandas as pd',
        '',
        'freq = (',
        '    df["' + col + '"].value_counts()',
        '    .reset_index()',
        '    .rename(columns={"' + col + '": "freq", "index": "' + col + '"})',
        '    .head(10)',
        ')',
        'freq["pct"] = (freq["freq"] / len(df) * 100).round(1)',
        'print(freq)'
      ].join('\n');
    }

    if (col && (type === 'numeric' || type === 'distribution')) {
      return header + [
        'import pandas as pd',
        '',
        'stats = df["' + col + '"].describe(percentiles=[0.25, 0.5, 0.75])',
        'stats["median"] = df["' + col + '"].median()',
        'stats["stddev"] = df["' + col + '"].std()',
        'print(stats)'
      ].join('\n');
    }

    if (col && (type === 'null_rate' || type === 'missing')) {
      return header + [
        'import pandas as pd',
        '',
        'total    = len(df)',
        'non_null = df["' + col + '"].count()',
        'null_ct  = total - non_null',
        'null_pct = round(null_ct / total * 100, 1)',
        '',
        'print(f"Column: \'' + col + '\'")',
        'print(f"  Total rows : {total:,}")',
        'print(f"  Non-null   : {non_null:,}")',
        'print(f"  Null count : {null_ct:,} ({null_pct}%)")'
      ].join('\n');
    }

    /* generic summary fallback */
    var numCols = dataset.columns
      .filter(function (c) { return c.type === 'INT' || c.type === 'FLOAT'; })
      .slice(0, 6)
      .map(function (c) { return '"' + c.name + '"'; });
    var colStr = numCols.length ? '[' + numCols.join(', ') + ']' : 'df.select_dtypes(include="number").columns.tolist()';
    return header + [
      'import pandas as pd',
      '',
      '# Dataset summary',
      'print(f"Rows: {len(df):,}  Cols: {len(df.columns)}")',
      'print()',
      'print(df[' + colStr + '].describe())'
    ].join('\n');
  }

  function safeAlias(name) {
    return (name || 'col').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(0, 20);
  }

  /* ---- build a proof object for a finding ---- */
  function buildProof(finding, dataset) {
    if (!finding || !dataset) return null;
    var tier = confidenceTier(finding);
    var sql  = buildExplanatorySQL(finding, dataset);
    var python = buildExplanatoryPython(finding, dataset);
    var rowsAffected = finding.rowsAffected || finding.outlierCount || null;
    var colsInvolved = [];
    if (finding.col)  colsInvolved.push(finding.col);
    if (finding.colB) colsInvolved.push(finding.colB);
    if (finding.column) colsInvolved.push(finding.column);

    return {
      tier: tier,
      sql: sql,
      python: python,
      rowsAffected: rowsAffected,
      totalRows: dataset.rows ? dataset.rows.length : 0,
      colsInvolved: colsInvolved,
      computedAt: new Date().toISOString(),
      engine: 'DataGlow InstantInsight v1',
      datasetName: dataset.name || 'dataset',
      hash: djb2(JSON.stringify({ finding: finding.type, col: finding.col, ds: dataset.name }))
    };
  }

  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(16).slice(0, 8);
  }

  /* ---- attach proof footer to an existing insight card element ---- */
  function attachToCard(cardEl, proof) {
    if (!cardEl || !proof) return;
    /* remove existing */
    var old = cardEl.querySelector('.pcr-footer');
    if (old) old.parentNode.removeChild(old);

    var footer = document.createElement('div');
    footer.className = 'pcr-footer';

    /* tier badge */
    var tierBadge = document.createElement('span');
    tierBadge.className = 'pcr-tier ' + proof.tier.cls;
    tierBadge.textContent = proof.tier.icon + ' ' + proof.tier.label;
    footer.appendChild(tierBadge);

    /* row scope */
    if (proof.rowsAffected !== null && proof.rowsAffected !== undefined) {
      var scope = document.createElement('span');
      scope.className = 'pcr-scope';
      scope.textContent = proof.rowsAffected.toLocaleString() + ' / ' + proof.totalRows.toLocaleString() + ' rows';
      footer.appendChild(scope);
    }

    /* columns touched */
    if (proof.colsInvolved && proof.colsInvolved.length) {
      var cols = document.createElement('span');
      cols.className = 'pcr-cols';
      cols.textContent = proof.colsInvolved.slice(0, 3).join(', ');
      footer.appendChild(cols);
    }

    /* expand SQL button */
    if (proof.sql) {
      var sqlBtn = document.createElement('button');
      sqlBtn.className = 'pcr-sql-btn';
      sqlBtn.title = 'View the SQL behind this insight';
      sqlBtn.innerHTML = '<span class="pcr-sql-icon">\u007B\u007D</span> SQL';
      sqlBtn.setAttribute('data-sql', proof.sql);
      sqlBtn.setAttribute('data-hash', proof.hash || '');
      sqlBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleCodeDrawer(cardEl, proof.sql, proof.hash, 'sql');
      });
      footer.appendChild(sqlBtn);
    }

    /* expand Python button */
    if (proof.python) {
      var pyBtn = document.createElement('button');
      pyBtn.className = 'pcr-py-btn';
      pyBtn.title = 'View the Python code that reproduces this insight';
      pyBtn.innerHTML = '\u03BB Python';
      pyBtn.setAttribute('data-python', proof.python);
      pyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleCodeDrawer(cardEl, proof.python, proof.hash, 'python');
      });
      footer.appendChild(pyBtn);
    }

    /* copy proof hash */
    var hashEl = document.createElement('span');
    hashEl.className = 'pcr-hash';
    hashEl.title = 'Proof fingerprint: ' + proof.hash;
    hashEl.textContent = '#' + (proof.hash || '').slice(0, 7);
    hashEl.style.cursor = 'pointer';
    hashEl.addEventListener('click', function () {
      try { navigator.clipboard.writeText(proof.hash); } catch (_) {}
      hashEl.textContent = 'Copied!';
      setTimeout(function () { hashEl.textContent = '#' + (proof.hash || '').slice(0, 7); }, 1500);
    });
    footer.appendChild(hashEl);

    cardEl.appendChild(footer);
  }

  /* ---- unified code drawer (SQL or Python) ---- */
  function toggleCodeDrawer(cardEl, code, hash, lang) {
    var existing = cardEl.querySelector('.pcr-sql-drawer');
    /* if same lang drawer is open, toggle it; if different lang, replace it */
    if (existing) {
      var existingLang = existing.getAttribute('data-lang');
      if (existingLang === lang) {
        existing.classList.toggle('pcr-drawer-open');
        return;
      }
      /* different lang: remove and rebuild below */
      existing.parentNode.removeChild(existing);
    }
    buildCodeDrawer(cardEl, code, hash, lang);
  }

  function buildCodeDrawer(cardEl, code, hash, lang) {
    var drawer = document.createElement('div');
    drawer.className = 'pcr-sql-drawer pcr-drawer-open';
    drawer.setAttribute('data-lang', lang);

    var header = document.createElement('div');
    header.className = 'pcr-drawer-header';

    var label = document.createElement('span');
    label.className = 'pcr-drawer-label';
    if (lang === 'python') {
      label.innerHTML = '<span style="color:var(--primary)">\u03BB Python lineage</span> -- copy to Python tab to reproduce';
    } else {
      label.innerHTML = '<span style="color:var(--proof)">Verify this insight</span> -- run this SQL in the editor';
    }
    header.appendChild(label);

    var actions = document.createElement('div');
    actions.className = 'pcr-drawer-actions';

    if (lang === 'sql') {
      var runBtn = document.createElement('button');
      runBtn.className = 'pcr-drawer-run';
      runBtn.textContent = 'Run in SQL Editor';
      runBtn.addEventListener('click', function () { pushSQLToEditor(code); });
      actions.appendChild(runBtn);
    } else {
      var pyBtn = document.createElement('button');
      pyBtn.className = 'pcr-drawer-run';
      pyBtn.textContent = 'Open Python Tab';
      pyBtn.addEventListener('click', function () { pushPythonToEditor(code); });
      actions.appendChild(pyBtn);
    }

    var copyBtn = document.createElement('button');
    copyBtn.className = 'pcr-drawer-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', function () {
      try { navigator.clipboard.writeText(code); } catch (_) {}
      copyBtn.textContent = 'Copied!';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
    });

    var closeBtn = document.createElement('button');
    closeBtn.className = 'pcr-drawer-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', function () {
      drawer.classList.remove('pcr-drawer-open');
      setTimeout(function () {
        if (!drawer.classList.contains('pcr-drawer-open') && drawer.parentNode) {
          drawer.parentNode.removeChild(drawer);
        }
      }, 300);
    });

    actions.appendChild(copyBtn);
    actions.appendChild(closeBtn);
    header.appendChild(actions);
    drawer.appendChild(header);

    var pre = document.createElement('pre');
    pre.className = 'pcr-sql-pre';
    pre.textContent = code;
    drawer.appendChild(pre);

    if (hash && lang === 'sql') {
      var hashLine = document.createElement('div');
      hashLine.className = 'pcr-drawer-hash';
      hashLine.textContent = 'Proof fingerprint: ' + hash;
      drawer.appendChild(hashLine);
    }

    cardEl.appendChild(drawer);
  }

  /* ---- push SQL into the SQL editor tab ---- */
  function pushSQLToEditor(sql) {
    var editors = [
      document.getElementById('sql-editor'),
      document.getElementById('sql-input'),
      document.getElementById('sql-view-editor'),
      document.querySelector('#sql-view textarea'),
      document.querySelector('.sql-editor-textarea'),
      document.querySelector('textarea[id*="sql"]')
    ];
    var found = editors.find(function (el) { return el && el.tagName === 'TEXTAREA'; });
    if (found) {
      found.value = sql;
      found.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var sqlNavBtn = document.querySelector('[data-panel="sql-view"]') ||
                    document.querySelector('.sidebar-nav-item[data-panel="sql-view"]') ||
                    document.querySelector('.analyze-pill[data-panel="sql-view"]');
    if (sqlNavBtn) sqlNavBtn.click();
    var analyzeNavBtn = document.querySelector('.nav-btn[data-view="analyze"]');
    if (analyzeNavBtn && !analyzeNavBtn.classList.contains('active')) analyzeNavBtn.click();
  }

  /* ---- push Python code into the Python tab editor ---- */
  function pushPythonToEditor(code) {
    var editors = [
      document.getElementById('py-view-input'),
      document.getElementById('py-editor'),
      document.getElementById('python-editor'),
      document.querySelector('#python-view textarea'),
      document.querySelector('.py-editor textarea')
    ];
    var found = editors.find(function (el) { return el && el.tagName === 'TEXTAREA'; });
    if (found) {
      found.value = code;
      found.dispatchEvent(new Event('input', { bubbles: true }));
    }
    /* switch to Python tab */
    var pyNavBtn = document.querySelector('[data-panel="python-view"]') ||
                   document.querySelector('.sidebar-nav-item[data-panel="python-view"]');
    if (pyNavBtn) pyNavBtn.click();
    var analyzeNavBtn = document.querySelector('.nav-btn[data-view="analyze"]');
    if (analyzeNavBtn && !analyzeNavBtn.classList.contains('active')) analyzeNavBtn.click();
  }

  /* ---- render the proof chain rail above/inside findings rail ---- */
  function renderInline(containerEl, dataset, findings) {
    if (!containerEl || !dataset || !Array.isArray(findings) || !findings.length) return;
    var cards = containerEl.querySelectorAll('.finding-card, .fr-card, .insight-card');
    cards.forEach(function (card, i) {
      var f = findings[i];
      if (!f) return;
      var proof = buildProof(f, dataset);
      if (proof) attachToCard(card, proof);
    });
  }

  /* ---- wrap the chart-engine card with proof ---- */
  function attachToChartCard(cardEl, colName, chartType, dataset) {
    if (!cardEl || !dataset) return;
    var pseudoFinding = {
      type: chartType === 'bar' ? 'categorical' :
            chartType === 'line' ? 'correlation' :
            chartType === 'histogram' ? 'distribution' :
            chartType === 'donut' ? 'top_category' : 'numeric',
      col: colName,
      confidence: 0.92
    };
    var proof = buildProof(pseudoFinding, dataset);
    if (proof) attachToCard(cardEl, proof);
  }

  return {
    buildProof: buildProof,
    attachToCard: attachToCard,
    attachToChartCard: attachToChartCard,
    renderInline: renderInline
  };

}());
