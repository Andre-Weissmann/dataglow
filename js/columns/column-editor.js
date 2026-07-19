/**
 * column-editor.js — DataGlow Smart Column Editor (PR AK)
 *
 * Inline column editing directly in the grid header:
 *   - Double-click column name → rename inline
 *   - Click type chip → cycle through types (text → number → date → boolean → text)
 *   - "+" button at end of header → add new column (constant or formula)
 *
 * Public API:
 *   ColumnEditor.attachToGrid(dataset, gridThead, onDatasetChange)
 *   ColumnEditor.suggestCleanNames(columns)  → returns { col: suggestedName }
 */

export var ColumnEditor = (function () {
  'use strict';

  var TYPE_CYCLE = ['text', 'number', 'date', 'boolean'];

  // ── Name suggestions ──────────────────────────────────────────────────────
  // Strip underscores/camelCase, title-case, remove junk prefixes
  function suggestCleanName(raw) {
    var s = String(raw);
    // snake_case / kebab-case → words
    s = s.replace(/[_\-]+/g, ' ');
    // camelCase → words
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
    // Remove leading/trailing numbers if name is otherwise readable
    s = s.replace(/^\d+\s*/, '').replace(/\s*\d+$/, '');
    // Collapse whitespace
    s = s.replace(/\s+/g, ' ').trim();
    // Title case
    s = s.split(' ').map(function (w) {
      return w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
    }).join(' ');
    return s || raw;
  }

  function suggestCleanNames(columns) {
    var result = {};
    columns.forEach(function (col) {
      var name = typeof col === 'string' ? col : col.name;
      var suggested = suggestCleanName(name);
      if (suggested !== name) result[name] = suggested;
    });
    return result;
  }

  // ── Type detection helpers ─────────────────────────────────────────────────
  function castValue(val, toType) {
    if (val === null || val === undefined || val === '') return val;
    if (toType === 'number') {
      var n = parseFloat(val);
      return isNaN(n) ? val : n;
    }
    if (toType === 'boolean') {
      var s = String(val).toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return 'true';
      if (s === 'false' || s === '0' || s === 'no') return 'false';
      return val;
    }
    if (toType === 'date') {
      var d = new Date(val);
      return isNaN(d) ? val : d.toISOString().split('T')[0];
    }
    return String(val);
  }

  // ── Formula evaluator (safe subset) ──────────────────────────────────────
  // Supports: column refs via {ColumnName}, basic math, string concat
  function evalFormula(formula, row, columns) {
    try {
      var expr = formula;
      // Replace {Col Name} references with values
      columns.forEach(function (col) {
        var name = typeof col === 'string' ? col : col.name;
        var val = row[name];
        if (val === null || val === undefined || val === '') {
          expr = expr.split('{' + name + '}').join('""');
        } else if (typeof val === 'number' || !isNaN(parseFloat(val))) {
          expr = expr.split('{' + name + '}').join(String(val));
        } else {
          expr = expr.split('{' + name + '}').join('"' + String(val).replace(/"/g, '\\"') + '"');
        }
      });
      // Evaluate only arithmetic + string ops — guard against code injection
      // Allow: numbers, strings, +, -, *, /, %, (, ), ., Math.*
      if (/[^0-9\s\+\-\*\/\%\(\)\.\"\'\,]/.test(expr.replace(/Math\.\w+/g, ''))) {
        return expr; // not safe to eval — return as-is
      }
      // eslint-disable-next-line no-new-func
      var result = Function('"use strict"; return (' + expr + ')')();
      return result === undefined || result === null ? '' : String(result);
    } catch (e) {
      return '(error)';
    }
  }

  // ── Attach to grid ─────────────────────────────────────────────────────────
  function attachToGrid(dataset, gridThead, onDatasetChange) {
    var headRow = gridThead.querySelector('tr');
    if (!headRow) return;

    // ── Rename: double-click col name ────────────────────────────────────────
    headRow.querySelectorAll('.col-name').forEach(function (nameSpan, idx) {
      nameSpan.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        var col = dataset.columns[idx];
        var origName = col.name;
        var input = document.createElement('input');
        input.type = 'text';
        input.value = origName;
        input.className = 'col-rename-input';
        input.style.cssText = 'font-size:12px;font-weight:600;background:var(--surface-alt);border:1px solid var(--primary);border-radius:4px;padding:1px 4px;width:' + Math.max(60, origName.length * 8) + 'px;color:var(--text);outline:none;';

        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        function commit() {
          var newName = input.value.trim() || origName;
          // Rename in columns + rows
          if (newName !== origName) {
            col.name = newName;
            dataset.rows.forEach(function (row) {
              if (Object.prototype.hasOwnProperty.call(row, origName)) {
                row[newName] = row[origName];
                delete row[origName];
              }
            });
            if (dataset.columnHealth) {
              var keys = Object.keys(dataset.columnHealth);
              // columnHealth is indexed by position — no rename needed
            }
          }
          var newSpan = document.createElement('span');
          newSpan.className = 'col-name';
          newSpan.textContent = newName;
          newSpan.title = 'Double-click to rename';
          input.replaceWith(newSpan);
          // Re-attach listener for next rename
          newSpan.addEventListener('dblclick', arguments.callee || function () {});
          attachRenameListener(newSpan, idx, dataset, gridThead, onDatasetChange);
          if (typeof onDatasetChange === 'function') onDatasetChange(dataset);
        }

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { input.blur(); }
          if (e.key === 'Escape') { input.value = origName; input.blur(); }
        });
      });
    });

    // ── Type chip: click to cycle ────────────────────────────────────────────
    headRow.querySelectorAll('.col-type-chip').forEach(function (chip, idx) {
      chip.style.cursor = 'pointer';
      chip.title = 'Click to change type';
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        var col = dataset.columns[idx];
        var curType = col.type || 'text';
        var curIdx = TYPE_CYCLE.indexOf(curType);
        var nextType = TYPE_CYCLE[(curIdx + 1) % TYPE_CYCLE.length];
        col.type = nextType;
        chip.textContent = nextType;

        // Re-cast all values in this column
        dataset.rows.forEach(function (row) {
          row[col.name] = castValue(row[col.name], nextType);
        });

        chip.classList.add('type-changed');
        setTimeout(function () { chip.classList.remove('type-changed'); }, 600);

        if (typeof onDatasetChange === 'function') onDatasetChange(dataset);
      });
    });

    // ── "+" Add Column button at end of header row ───────────────────────────
    var addTh = document.createElement('th');
    addTh.className = 'add-col-th';
    var addBtn = document.createElement('button');
    addBtn.id = 'add-col-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add column';
    addTh.appendChild(addBtn);
    headRow.appendChild(addTh);

    // ── Add Column popover ────────────────────────────────────────────────────
    var popoverOpen = false;
    var popover = null;

    addBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (popoverOpen && popover) { popover.remove(); popoverOpen = false; return; }

      popover = document.createElement('div');
      popover.id = 'add-col-popover';
      popover.innerHTML = [
        '<div class="acp-title">Add Column</div>',
        '<div class="acp-row">',
        '  <label class="acp-label">Name</label>',
        '  <input id="acp-name" class="acp-input" placeholder="New Column" autocomplete="off" />',
        '</div>',
        '<div class="acp-row">',
        '  <label class="acp-label">Type</label>',
        '  <select id="acp-type" class="acp-input">',
        '    <option value="text">text</option>',
        '    <option value="number">number</option>',
        '    <option value="date">date</option>',
        '    <option value="boolean">boolean</option>',
        '  </select>',
        '</div>',
        '<div class="acp-row">',
        '  <label class="acp-label">Value</label>',
        '  <input id="acp-value" class="acp-input" placeholder="Constant or {Col} formula" autocomplete="off" />',
        '</div>',
        '<div class="acp-hint">Use {Column Name} to reference columns. E.g. {Revenue} * 0.1</div>',
        '<div class="acp-actions">',
        '  <button id="acp-cancel" class="acp-btn-cancel">Cancel</button>',
        '  <button id="acp-add" class="acp-btn-add">Add</button>',
        '</div>'
      ].join('');

      // Position below the + button
      var rect = addBtn.getBoundingClientRect();
      var canvasRect = document.getElementById('canvas').getBoundingClientRect();
      popover.style.cssText = 'position:absolute;top:' + (rect.bottom - canvasRect.top + 4) + 'px;right:12px;z-index:40;';
      document.getElementById('canvas').appendChild(popover);
      popoverOpen = true;

      var nameInput  = popover.querySelector('#acp-name');
      var typeSelect = popover.querySelector('#acp-type');
      var valInput   = popover.querySelector('#acp-value');

      nameInput.focus();

      popover.querySelector('#acp-cancel').addEventListener('click', function () {
        popover.remove(); popoverOpen = false;
      });

      popover.querySelector('#acp-add').addEventListener('click', function () {
        var colName = nameInput.value.trim() || 'New Column';
        var colType = typeSelect.value;
        var formula = valInput.value.trim();

        // Prevent duplicate names
        var baseName = colName;
        var n = 1;
        while (dataset.columns.some(function (c) { return c.name === colName; })) {
          colName = baseName + ' ' + (n++);
        }

        dataset.columns.push({ name: colName, type: colType });

        dataset.rows.forEach(function (row) {
          var computed = formula ? evalFormula(formula, row, dataset.columns) : '';
          row[colName] = castValue(computed, colType);
        });

        popover.remove(); popoverOpen = false;
        if (typeof onDatasetChange === 'function') onDatasetChange(dataset);
      });

      // Close on outside click
      setTimeout(function () {
        document.addEventListener('click', function outsideClick(ev) {
          if (popover && !popover.contains(ev.target) && ev.target !== addBtn) {
            popover.remove(); popoverOpen = false;
            document.removeEventListener('click', outsideClick);
          }
        });
      }, 50);
    });

    // ── Suggest clean names banner ────────────────────────────────────────────
    var suggestions = suggestCleanNames(dataset.columns);
    var suggCount = Object.keys(suggestions).length;
    if (suggCount > 0) {
      var existingBanner = document.getElementById('col-clean-banner');
      if (!existingBanner) {
        var banner = document.createElement('div');
        banner.id = 'col-clean-banner';
        banner.innerHTML = '<span>&#10024; ' + suggCount + ' column name' + (suggCount > 1 ? 's' : '') +
          ' could be cleaner.</span> <button id="col-clean-apply">Apply suggestions</button>' +
          ' <button id="col-clean-dismiss">&#x2715;</button>';
        var gridView = document.getElementById('grid-view');
        if (gridView) gridView.insertBefore(banner, gridView.firstChild);

        document.getElementById('col-clean-apply').addEventListener('click', function () {
          dataset.columns.forEach(function (col) {
            if (suggestions[col.name]) {
              var oldName = col.name;
              col.name = suggestions[col.name];
              dataset.rows.forEach(function (row) {
                if (Object.prototype.hasOwnProperty.call(row, oldName)) {
                  row[col.name] = row[oldName];
                  delete row[oldName];
                }
              });
            }
          });
          banner.remove();
          if (typeof onDatasetChange === 'function') onDatasetChange(dataset);
        });

        document.getElementById('col-clean-dismiss').addEventListener('click', function () {
          banner.remove();
        });
      }
    }
  }

  // helper — re-attach rename listener after commit
  function attachRenameListener(span, idx, dataset, gridThead, onDatasetChange) {
    span.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      var col = dataset.columns[idx];
      var origName = col.name;
      var input = document.createElement('input');
      input.type = 'text';
      input.value = origName;
      input.className = 'col-rename-input';
      input.style.cssText = 'font-size:12px;font-weight:600;background:var(--surface-alt);border:1px solid var(--primary);border-radius:4px;padding:1px 4px;width:' + Math.max(60, origName.length * 8) + 'px;color:var(--text);outline:none;';
      span.replaceWith(input);
      input.focus(); input.select();
      function commit() {
        var newName = input.value.trim() || origName;
        if (newName !== origName) {
          col.name = newName;
          dataset.rows.forEach(function (row) {
            if (Object.prototype.hasOwnProperty.call(row, origName)) {
              row[newName] = row[origName]; delete row[origName];
            }
          });
        }
        var newSpan = document.createElement('span');
        newSpan.className = 'col-name';
        newSpan.textContent = newName;
        newSpan.title = 'Double-click to rename';
        input.replaceWith(newSpan);
        attachRenameListener(newSpan, idx, dataset, gridThead, onDatasetChange);
        if (typeof onDatasetChange === 'function') onDatasetChange(dataset);
      }
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = origName; input.blur(); }
      });
    });
  }

  return { attachToGrid: attachToGrid, suggestCleanNames: suggestCleanNames };
})();
