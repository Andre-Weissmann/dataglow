/* DataGlow — js/join/join-builder.js */
/* Part of structured refactor — see src/ directory */

/**
 * join-builder.js — DataGlow Multi-file Join Builder (PR AL)
 *
 * Drag two datasets in, DataGlow suggests the join key automatically.
 * Supports: INNER, LEFT, RIGHT, FULL OUTER joins.
 * Result is added as a new dataset (state.datasets.push) via onJoinComplete.
 *
 * Public API:
 *   JoinBuilder.render(containerEl, datasets, onJoinComplete)
 *   JoinBuilder.suggestKey(colsA, colsB) → { keyA, keyB, confidence }
 */

var JoinBuilder = (function () {
  'use strict';

  // ── Key suggestion ─────────────────────────────────────────────────────────
  // Score column pairs: exact name match > similar name > overlapping values
  function suggestKey(colsA, colsB, rowsA, rowsB) {
    var namesA = colsA.map(function (c) { return c.name; });
    var namesB = colsB.map(function (c) { return c.name; });

    // 1. Exact name match
    for (var i = 0; i < namesA.length; i++) {
      for (var j = 0; j < namesB.length; j++) {
        if (namesA[i].toLowerCase() === namesB[j].toLowerCase()) {
          return { keyA: namesA[i], keyB: namesB[j], confidence: 'high', reason: 'Exact name match' };
        }
      }
    }

    // 2. One name contains the other (e.g. "id" in "user_id")
    var idLike = /\bid\b|_id$|^id_/i;
    var idA = namesA.filter(function (n) { return idLike.test(n); });
    var idB = namesB.filter(function (n) { return idLike.test(n); });
    if (idA.length && idB.length) {
      return { keyA: idA[0], keyB: idB[0], confidence: 'medium', reason: 'ID-like column pairing' };
    }

    // 3. Fuzzy: strip underscores/spaces and compare
    var normalize = function (s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); };
    for (var a = 0; a < namesA.length; a++) {
      for (var b = 0; b < namesB.length; b++) {
        if (normalize(namesA[a]) === normalize(namesB[b])) {
          return { keyA: namesA[a], keyB: namesB[b], confidence: 'medium', reason: 'Name similarity match' };
        }
      }
    }

    // 4. Overlap in values  -  sample first 30 rows
    if (rowsA && rowsB) {
      var sampleA = rowsA.slice(0, 30);
      var sampleB = rowsB.slice(0, 30);
      var bestScore = 0, bestA = namesA[0], bestB = namesB[0];
      namesA.forEach(function (na) {
        namesB.forEach(function (nb) {
          var valsA = new Set(sampleA.map(function (r) { return String(r[na] || ''); }));
          var valsB = new Set(sampleB.map(function (r) { return String(r[nb] || ''); }));
          var overlap = 0;
          valsA.forEach(function (v) { if (valsB.has(v)) overlap++; });
          var score = overlap / Math.max(valsA.size, valsB.size, 1);
          if (score > bestScore) { bestScore = score; bestA = na; bestB = nb; }
        });
      });
      if (bestScore > 0.3) {
        return { keyA: bestA, keyB: bestB, confidence: 'low', reason: Math.round(bestScore * 100) + '% value overlap' };
      }
    }

    // 5. Fallback: first column of each
    return { keyA: namesA[0] || '', keyB: namesB[0] || '', confidence: 'none', reason: 'No match found  -  select manually' };
  }

  // ── Join execution ─────────────────────────────────────────────────────────
  function executeJoin(dsA, dsB, keyA, keyB, joinType) {
    var rowsA = dsA.rows;
    var rowsB = dsB.rows;

    // Build lookup from B
    var indexB = {};
    rowsB.forEach(function (row) {
      var k = String(row[keyB] == null ? '' : row[keyB]);
      if (!indexB[k]) indexB[k] = [];
      indexB[k].push(row);
    });

    // Merged column list  -  avoid duplicates (keyB becomes keyA)
    var colsA = dsA.columns.map(function (c) { return c.name; });
    var colsB = dsB.columns
      .filter(function (c) { return c.name !== keyB; })
      .map(function (c) { return c.name; });

    // If a colB name clashes with colA (other than key), suffix with _B
    var finalColsB = colsB.map(function (n) {
      return colsA.indexOf(n) !== -1 ? n + '_' + dsB.name.replace(/\.[^.]+$/, '').slice(0, 6) : n;
    });

    var resultRows = [];
    var matchedBKeys = new Set();

    // Left side iteration
    rowsA.forEach(function (rowA) {
      var k = String(rowA[keyA] == null ? '' : rowA[keyA]);
      var bMatches = indexB[k] || [];

      if (bMatches.length) {
        matchedBKeys.add(k);
        bMatches.forEach(function (rowB, bi) {
          var merged = {};
          colsA.forEach(function (c) { merged[c] = rowA[c]; });
          colsB.forEach(function (c, i) { merged[finalColsB[i]] = rowB[c]; });
          resultRows.push(merged);
        });
      } else if (joinType === 'left' || joinType === 'full') {
        // Unmatched left row
        var merged = {};
        colsA.forEach(function (c) { merged[c] = rowA[c]; });
        finalColsB.forEach(function (c) { merged[c] = null; });
        resultRows.push(merged);
      }
    });

    // Right side unmatched (for RIGHT and FULL)
    if (joinType === 'right' || joinType === 'full') {
      rowsB.forEach(function (rowB) {
        var k = String(rowB[keyB] == null ? '' : rowB[keyB]);
        if (!matchedBKeys.has(k)) {
          var merged = {};
          colsA.forEach(function (c) { merged[c] = null; });
          colsB.forEach(function (c, i) { merged[finalColsB[i]] = rowB[c]; });
          merged[keyA] = rowB[keyB]; // copy key from B side
          resultRows.push(merged);
        }
      });
    }

    // Build columns array for result dataset
    var allCols = colsA.concat(finalColsB).map(function (name) {
      // Find type from either dataset
      var srcA = dsA.columns.find(function (c) { return c.name === name; });
      var srcBIdx = finalColsB.indexOf(name);
      var srcB = srcBIdx !== -1 ? dsB.columns.find(function (c) { return c.name === colsB[srcBIdx]; }) : null;
      return { name: name, type: (srcA && srcA.type) || (srcB && srcB.type) || 'text' };
    });

    return {
      columns: allCols,
      rows: resultRows,
      name: dsA.name.replace(/\.[^.]+$/, '') + '_joined',
      filename: dsA.name.replace(/\.[^.]+$/, '') + '_joined.csv',
      findings: [],
      rowFlags: resultRows.map(function () { return { warning: false, error: false }; }),
      columnHealth: null
    };
  }

  // ── UI render ──────────────────────────────────────────────────────────────
  function render(containerEl, getDatasets, onJoinComplete) {
    function rebuild() {
      containerEl.innerHTML = '';
      var datasets = getDatasets();

      if (!datasets || datasets.length < 1) {
        containerEl.innerHTML = [
          '<div class="join-empty">',
          '  <div class="join-empty-icon">&#8644;</div>',
          '  <div class="join-empty-title">Drop two files to join them</div>',
          '  <div class="join-empty-sub">Load your first file, then drop a second  -  DataGlow will suggest the join key automatically.</div>',
          '</div>'
        ].join('');
        return;
      }

      if (datasets.length === 1) {
        containerEl.innerHTML = [
          '<div class="join-empty">',
          '  <div class="join-empty-icon">&#43;</div>',
          '  <div class="join-empty-title">Drop a second file to join</div>',
          '  <div class="join-empty-sub">You have <strong>' + escHtml(datasets[0].name) + '</strong> loaded. Drop another file anywhere to enable joining.</div>',
          '</div>'
        ].join('');
        return;
      }

      // Two or more datasets  -  render the builder
      var dsNames = datasets.map(function (d, i) {
        return '<option value="' + i + '">' + escHtml(d.name) + '</option>';
      });

      // Default: last two
      var defaultA = datasets.length - 2;
      var defaultB = datasets.length - 1;
      var dsA = datasets[defaultA];
      var dsB = datasets[defaultB];
      var suggestion = suggestKey(dsA.columns, dsB.columns, dsA.rows, dsB.rows);

      containerEl.innerHTML = [
        '<div class="join-builder">',
        '  <div class="join-header">',
        '    <span class="join-header-title">Join Builder</span>',
        '    <span class="join-header-sub">Combine two datasets on a shared column</span>',
        '  </div>',

        '  <div class="join-row">',
        '    <div class="join-card" id="jcard-a">',
        '      <div class="join-card-label">Left dataset</div>',
        '      <select class="join-select" id="join-ds-a">' + dsNames.map(function (o, i) { return i === defaultA ? o.replace('<option', '<option selected') : o; }).join('') + '</select>',
        '      <div class="join-col-select-wrap">',
        '        <label class="join-col-label">Join on</label>',
        '        <select class="join-select" id="join-key-a"></select>',
        '      </div>',
        '    </div>',

        '    <div class="join-type-block">',
        '      <div class="join-type-label">Join type</div>',
        '      <div class="join-type-btns">',
        '        <button class="join-type-btn active" data-type="inner" title="Only rows that match in both">INNER</button>',
        '        <button class="join-type-btn" data-type="left"  title="All left rows, matched right">LEFT</button>',
        '        <button class="join-type-btn" data-type="right" title="All right rows, matched left">RIGHT</button>',
        '        <button class="join-type-btn" data-type="full"  title="All rows from both">FULL</button>',
        '      </div>',
        '      <div class="join-venn" id="join-venn"></div>',
        '    </div>',

        '    <div class="join-card" id="jcard-b">',
        '      <div class="join-card-label">Right dataset</div>',
        '      <select class="join-select" id="join-ds-b">' + dsNames.map(function (o, i) { return i === defaultB ? o.replace('<option', '<option selected') : o; }).join('') + '</select>',
        '      <div class="join-col-select-wrap">',
        '        <label class="join-col-label">Join on</label>',
        '        <select class="join-select" id="join-key-b"></select>',
        '      </div>',
        '    </div>',
        '  </div>',

        '  <div class="join-suggestion" id="join-suggestion"></div>',

        '  <div class="join-preview-wrap">',
        '    <div class="join-preview-label">Preview <span id="join-preview-count"></span></div>',
        '    <div id="join-preview-table-wrap"><table id="join-preview-table" class="join-preview-table"></table></div>',
        '  </div>',

        '  <div class="join-actions">',
        '    <button id="join-run-btn" class="join-run-btn">Run Join</button>',
        '  </div>',
        '</div>'
      ].join('');

      // ── Populate key dropdowns ─────────────────────────────────────────────
      function populateKeys(dsAIdx, dsBIdx) {
        var dA = datasets[dsAIdx], dB = datasets[dsBIdx];
        var keyA = containerEl.querySelector('#join-key-a');
        var keyB = containerEl.querySelector('#join-key-b');
        keyA.innerHTML = dA.columns.map(function (c) {
          return '<option value="' + escHtml(c.name) + '">' + escHtml(c.name) + '</option>';
        }).join('');
        keyB.innerHTML = dB.columns.map(function (c) {
          return '<option value="' + escHtml(c.name) + '">' + escHtml(c.name) + '</option>';
        }).join('');

        // Apply suggestion
        var sug = suggestKey(dA.columns, dB.columns, dA.rows, dB.rows);
        if (sug.keyA) keyA.value = sug.keyA;
        if (sug.keyB) keyB.value = sug.keyB;

        var sugEl = containerEl.querySelector('#join-suggestion');
        var conf = sug.confidence;
        var icon = conf === 'high' ? '&#10003;' : conf === 'medium' ? '&#9888;' : conf === 'low' ? '&#x1F4A1;' : '&#x2753;';
        sugEl.className = 'join-suggestion join-sug-' + conf;
        sugEl.innerHTML = '<span class="join-sug-icon">' + icon + '</span>' +
          '<span class="join-sug-text">Suggested key: <strong>' + escHtml(sug.keyA) + '</strong> = <strong>' + escHtml(sug.keyB) + '</strong> &mdash; ' + escHtml(sug.reason) + '</span>';

        updatePreview(dsAIdx, dsBIdx);
      }

      // ── Live preview ───────────────────────────────────────────────────────
      var currentJoinType = 'inner';

      function updatePreview(dsAIdx, dsBIdx) {
        var dA = datasets[dsAIdx], dB = datasets[dsBIdx];
        var keyA = containerEl.querySelector('#join-key-a');
        var keyB = containerEl.querySelector('#join-key-b');
        if (!keyA || !keyB) return;
        var kA = keyA.value, kB = keyB.value;
        if (!kA || !kB) return;

        var result = executeJoin(dA, dB, kA, kB, currentJoinType);
        var preview = result.rows.slice(0, 6);
        var cols = result.columns.slice(0, 8); // cap columns shown in preview

        var countEl = containerEl.querySelector('#join-preview-count');
        if (countEl) countEl.textContent = '(' + result.rows.length.toLocaleString() + ' rows)';

        var table = containerEl.querySelector('#join-preview-table');
        if (!table) return;

        var thead = '<thead><tr>' + cols.map(function (c) {
          return '<th>' + escHtml(c.name) + '</th>';
        }).join('') + (result.columns.length > 8 ? '<th class="join-more-cols">+' + (result.columns.length - 8) + ' more</th>' : '') + '</tr></thead>';

        var tbody = '<tbody>' + preview.map(function (row) {
          return '<tr>' + cols.map(function (c) {
            var v = row[c.name];
            return '<td>' + (v == null ? '<span class="join-null">null</span>' : escHtml(String(v))) + '</td>';
          }).join('') + (result.columns.length > 8 ? '<td></td>' : '') + '</tr>';
        }).join('') + '</tbody>';

        table.innerHTML = thead + tbody;

        // Store result for Run Join
        table._result = result;

        // ── Cardinality check  -  warn before fan-out join runs ───────────
        var cardWrap = containerEl.querySelector('#cardinality-warning-wrap');
        if (!cardWrap) {
          cardWrap = document.createElement('div');
          cardWrap.id = 'cardinality-warning-wrap';
          // Insert above the preview table
          var previewWrap = containerEl.querySelector('.join-preview-wrap');
          if (previewWrap) previewWrap.parentNode.insertBefore(cardWrap, previewWrap);
          else containerEl.appendChild(cardWrap);
        }
        if (window.CardinalityDetector && dsAIdx >= 0 && dsBIdx >= 0) {
          var datasets = getDatasets();
          var _dA = datasets[dsAIdx];
          var _dB = datasets[dsBIdx];
          var _kA = containerEl.querySelector('#join-key-a') && containerEl.querySelector('#join-key-a').value;
          var _kB = containerEl.querySelector('#join-key-b') && containerEl.querySelector('#join-key-b').value;
          if (_dA && _dB && _kA && _kB) {
            var cardAnalysis = CardinalityDetector.analyze(_dA, _dB, _kA, _kB);
            CardinalityDetector.renderWarning(cardAnalysis, cardWrap);
          }
        }
      }

      // ── Event wiring ───────────────────────────────────────────────────────
      var selA = containerEl.querySelector('#join-ds-a');
      var selB = containerEl.querySelector('#join-ds-b');

      selA.addEventListener('change', function () { populateKeys(+selA.value, +selB.value); });
      selB.addEventListener('change', function () { populateKeys(+selA.value, +selB.value); });

      containerEl.querySelectorAll('#join-key-a, #join-key-b').forEach(function (sel) {
        sel.addEventListener('change', function () { updatePreview(+selA.value, +selB.value); });
      });

      containerEl.querySelectorAll('.join-type-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          containerEl.querySelectorAll('.join-type-btn').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          currentJoinType = btn.dataset.type;
          updateVenn(currentJoinType);
          updatePreview(+selA.value, +selB.value);
        });
      });

      containerEl.querySelector('#join-run-btn').addEventListener('click', function () {
        var table = containerEl.querySelector('#join-preview-table');
        var result = table && table._result;
        if (!result) return;
        if (typeof onJoinComplete === 'function') onJoinComplete(result);
      });

      // Initial population
      populateKeys(defaultA, defaultB);
    }

    rebuild();

    // Return rebuild so caller can refresh when a new dataset loads
    return { refresh: rebuild };
  }

  // ── Venn diagram (SVG) ─────────────────────────────────────────────────────
  function updateVenn(type) {
    var venn = document.getElementById('join-venn');
    if (!venn) return;
    var fills = {
      inner: ['none', 'none', '#20808D44'],
      left:  ['#20808D44', 'none', '#20808D44'],
      right: ['none', '#20808D44', '#20808D44'],
      full:  ['#20808D44', '#20808D44', '#20808D44']
    }[type] || ['none','none','#20808D44'];

    venn.innerHTML = '<svg width="80" height="40" viewBox="0 0 80 40" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="25" cy="20" r="18" fill="' + fills[0] + '" stroke="#20808D" stroke-width="1.5"/>' +
      '<circle cx="55" cy="20" r="18" fill="' + fills[1] + '" stroke="#20808D" stroke-width="1.5"/>' +
      '<clipPath id="vcp"><circle cx="55" cy="20" r="18"/></clipPath>' +
      '<circle cx="25" cy="20" r="18" fill="' + fills[2] + '" clip-path="url(#vcp)"/>' +
      '</svg>';
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { render: render, suggestKey: suggestKey };
