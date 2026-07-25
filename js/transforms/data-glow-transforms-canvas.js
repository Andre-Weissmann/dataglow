/* ---- from js/transforms/data-glow-transforms-canvas.js ---- */
;(function () {
  'use strict';

  /*
   * DATAGLOW - canvas wire for the table transforms
   *
   * One calm panel over ten pure engines in js/transforms/. This file owns no
   * analysis: every number and every sentence it shows comes from an engine, so
   * the panel and a Node test cannot disagree.
   *
   * WHY TWO GROUPS AND NOT TEN TABS. Bundle 6 shipped four tabs in a flat row,
   * which read fine. Ten would not: at 360px a ten-item row wraps to three lines
   * of near-identical pills and picking the right one becomes a memory game. So
   * the tabs are split by what a person came to do. Time and joins answers a
   * question about dates. Shape and clean changes the shape of the table itself.
   * That is one extra click to reach a tab and one fewer wrong tab opened.
   *
   * THE SHAPE IS THE HOUSE ONE. Finding first, proof under it, nothing applied
   * until a person clicks twice. The second click is not ceremony: most of these
   * change the row count and three can multiply it. A person who has read
   * "1,204 rows become 3,610" and then pressed Confirm has agreed to something
   * specific.
   *
   * THE TRANSFORMS THAT MULTIPLY SHOW THE COUNT BEFORE THE RUN, NOT AFTER.
   * Nested lists and daily rows can turn a small table into one a phone cannot
   * hold. Their engines expose a preview that counts the output without building
   * it, and the panel shows that count and its warnings above the run button, so
   * the warning arrives while it is still free to change the settings.
   *
   * Each tab is behind its own flag and a tab whose flag is off is not rendered
   * at all, so a disabled capability leaves no dead control behind. A group with
   * no enabled tab is not offered either.
   */

  var PANEL_ID = 'transforms-view';
  var BODY_ID = 'transforms-body';
  var BTN_ID = 'dg-transforms-btn';
  var PREVIEW_ROWS = 12;
  var NARROW_PX = 700;

  var GROUPS = [
    { id: 'time', label: 'Time & joins', plain: 'Time and joins' },
    { id: 'shape', label: 'Shape & clean', plain: 'Shape and clean' },
  ];

  var TABS = [
    { id: 'prior', group: 'time', flag: 'priorPeriodCompare',
      label: 'Compare to prior period', short: 'Prior period' },
    { id: 'range', group: 'time', flag: 'dateRangeJoin',
      label: 'Join on date range', short: 'Date range' },
    { id: 'firstlast', group: 'time', flag: 'firstLastEvent',
      label: 'First or last event', short: 'First / last' },
    { id: 'asof', group: 'time', flag: 'asOfLookup',
      label: 'As-of lookup', short: 'As-of' },
    { id: 'hierarchy', group: 'shape', flag: 'expandHierarchy',
      label: 'Expand a hierarchy', short: 'Hierarchy' },
    { id: 'nested', group: 'shape', flag: 'nestedToRows',
      label: 'Nested lists into rows', short: 'Nested lists' },
    { id: 'fill', group: 'shape', flag: 'fillMissingFlagged',
      label: 'Fill blanks and flag them', short: 'Fill blanks' },
    { id: 'daily', group: 'shape', flag: 'expandDailyRows',
      label: 'Date range into daily rows', short: 'Daily rows' },
    { id: 'bins', group: 'shape', flag: 'visualBinEditor',
      label: 'Group a number into bands', short: 'Bands' },
    { id: 'keep', group: 'shape', flag: 'keepMostRecent',
      label: 'Keep the most recent per group', short: 'Keep recent' },
  ];

  var _group = null;
  var _tab = null;
  var _cfg = {};            // per tab config
  var _result = null;       // last engine result for the open tab
  var _resultTab = null;    // which tab produced _result
  var _pendingConfirm = false;
  var _secondName = '';     // name of the chosen second table, for A19 and A24

  /* ------------------------------ plumbing -------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[Transforms]', msg);
  }

  function flagOn(name) {
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled(name) !== false;
      }
    } catch (_e) {}
    return true;
  }

  function enabledTabs() {
    return TABS.filter(function (t) { return flagOn(t.flag); });
  }

  function tabsInGroup(groupId) {
    return enabledTabs().filter(function (t) { return t.group === groupId; });
  }

  function enabledGroups() {
    return GROUPS.filter(function (g) { return tabsInGroup(g.id).length > 0; });
  }

  function isNarrow() {
    try { return window.innerWidth > 0 && window.innerWidth < NARROW_PX; } catch (_e) { return false; }
  }

  function engines() {
    return {
      prior: window.DataGlowPriorPeriod || null,
      range: window.DataGlowDateRangeJoin || null,
      firstlast: window.DataGlowFirstLastEvent || null,
      asof: window.DataGlowAsOfLookup || null,
      hierarchy: window.DataGlowExpandHierarchy || null,
      nested: window.DataGlowNestedToRows || null,
      fill: window.DataGlowFillMissing || null,
      daily: window.DataGlowExpandDateRange || null,
      bins: window.DataGlowBinEditor || null,
      keep: window.DataGlowKeepMostRecent || null,
    };
  }

  function activeDataset() {
    if (typeof window.getActiveDataset === 'function') {
      try { var d = window.getActiveDataset(); if (d) return d; } catch (_e) {}
    }
    if (window.state && window.state.datasets && window.state.datasets[0]) {
      return window.state.datasets[0];
    }
    return null;
  }

  function allDatasets() {
    var list = (window.state && window.state.datasets) || [];
    return Array.isArray(list) ? list : [];
  }

  function secondDataset() {
    var all = allDatasets();
    var active = activeDataset();
    for (var i = 0; i < all.length; i += 1) {
      if (all[i] && all[i].name === _secondName && all[i] !== active) return all[i];
    }
    for (var j = 0; j < all.length; j += 1) {
      if (all[j] && all[j] !== active) return all[j];
    }
    return null;
  }

  function columnNames(ds) {
    var cols = (ds && ds.columns) || [];
    return cols.map(function (c, i) {
      if (c == null) return 'col' + (i + 1);
      return (typeof c === 'string') ? c : (c.name || ('col' + (i + 1)));
    });
  }

  /* ------------------------------- config --------------------------------- */

  function ensureConfig(tabId, force) {
    var eng = engines();
    var ds = activeDataset();
    if (!ds) return null;
    if (_cfg[tabId] && !force) return _cfg[tabId];
    var names = columnNames(ds);
    var other = secondDataset();

    if (tabId === 'prior' && eng.prior) {
      _cfg.prior = eng.prior.suggestPriorPeriodConfig(ds);
    } else if (tabId === 'range' && eng.range) {
      _cfg.range = eng.range.suggestDateRangeJoinConfig(ds, other);
    } else if (tabId === 'firstlast' && eng.firstlast) {
      _cfg.firstlast = eng.firstlast.suggestFirstLastConfig(ds);
      if (!_cfg.firstlast.entityColumns.length) {
        var firstNonDate = names.filter(function (n) { return n !== _cfg.firstlast.orderColumn; })[0];
        if (firstNonDate) _cfg.firstlast.entityColumns = [firstNonDate];
      }
    } else if (tabId === 'asof' && eng.asof) {
      _cfg.asof = eng.asof.suggestAsOfConfig(ds, other);
    } else if (tabId === 'hierarchy' && eng.hierarchy) {
      _cfg.hierarchy = eng.hierarchy.suggestHierarchyConfig(ds);
    } else if (tabId === 'nested' && eng.nested) {
      _cfg.nested = eng.nested.suggestNestedConfig(ds);
      if (!_cfg.nested.listColumn && names.length) _cfg.nested.listColumn = names[0];
    } else if (tabId === 'fill' && eng.fill) {
      _cfg.fill = eng.fill.suggestFillConfig(ds);
    } else if (tabId === 'daily' && eng.daily) {
      _cfg.daily = eng.daily.suggestDateRangeConfig(ds);
    } else if (tabId === 'bins' && eng.bins) {
      _cfg.bins = eng.bins.suggestBinConfig(ds);
    } else if (tabId === 'keep' && eng.keep) {
      _cfg.keep = eng.keep.suggestKeepConfig(ds);
    }
    return _cfg[tabId] || null;
  }

  /* -------------------------------- panel --------------------------------- */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Table transforms');
    panel.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'height:100%', 'width:min(480px,100%)',
      'background:var(--surface,#141518)', 'color:var(--text,#E8E8E8)',
      'border-left:1px solid var(--border,#2A2C31)', 'box-shadow:-8px 0 32px rgba(0,0,0,.4)',
      'transform:translateX(105%)', 'transition:transform .22s ease', 'z-index:11750',
      'display:flex', 'flex-direction:column'
    ].join(';');
    panel.innerHTML =
      '<div style="width:36px;height:4px;border-radius:2px;background:var(--border,#2A2C31);margin:10px auto 0;flex-shrink:0"></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--border,#2A2C31);gap:10px;flex-shrink:0">'
      +   '<div style="min-width:0">'
      +     '<div style="font-weight:800;font-size:15px">Transforms</div>'
      +     '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:2px">On-device. Nothing changes until you confirm.</div>'
      +   '</div>'
      +   '<button type="button" data-tj-close style="min-height:44px;min-width:44px;border:none;background:transparent;color:var(--text-muted,#8A8F98);font-size:22px;cursor:pointer;border-radius:10px" aria-label="Close">&times;</button>'
      + '</div>'
      + '<div id="' + BODY_ID + '" style="flex:1;overflow-y:auto;padding:14px 16px;-webkit-overflow-scrolling:touch"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-tj-close]').addEventListener('click', closePanel);
    return panel;
  }

  /* -------------------------------- pieces -------------------------------- */

  function card(inner) {
    return '<div style="border:1px solid var(--border,#2A2C31);border-radius:12px;padding:12px 14px;'
      + 'margin-bottom:12px;background:var(--surface-2,#1A1C20)">' + inner + '</div>';
  }

  function label(text) {
    return '<div style="font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;'
      + 'color:var(--text-muted,#8A8F98);margin:0 0 5px">' + esc(text) + '</div>';
  }

  function select(key, names, current, allowBlank) {
    var opts = (allowBlank ? '<option value="">(none)</option>' : '')
      + names.map(function (n) {
        return '<option value="' + esc(n) + '"' + (n === current ? ' selected' : '') + '>' + esc(n) + '</option>';
      }).join('');
    return '<select data-tj-field="' + esc(key) + '" style="width:100%;min-height:44px;font-size:13px;'
      + 'padding:8px 10px;margin-bottom:10px;border-radius:8px;background:var(--surface,#141518);'
      + 'color:var(--text,#E8E8E8);border:1px solid var(--border,#2A2C31)">' + opts + '</select>';
  }

  function toggleRow(key, text, on) {
    return '<label style="display:flex;align-items:center;gap:9px;min-height:44px;font-size:13px;cursor:pointer">'
      + '<input type="checkbox" data-tj-toggle="' + esc(key) + '"' + (on ? ' checked' : '')
      + ' style="width:18px;height:18px;flex-shrink:0">'
      + '<span>' + esc(text) + '</span></label>';
  }

  function multiPick(key, names, chosen) {
    return names.map(function (n) {
      var on = chosen.indexOf(n) !== -1;
      return '<button type="button" data-tj-multi="' + esc(key) + '" data-tj-value="' + esc(n) + '" '
        + 'style="display:inline-flex;align-items:center;min-height:34px;font-size:12px;padding:6px 11px;'
        + 'border-radius:999px;margin:0 6px 6px 0;cursor:pointer;'
        + 'background:' + (on ? 'rgba(32,197,181,.14)' : 'var(--surface,#141518)') + ';'
        + 'color:' + (on ? 'var(--primary,#20C5B5)' : 'var(--text-secondary,#B4B8C0)') + ';'
        + 'border:1px solid ' + (on ? 'rgba(32,197,181,.4)' : 'var(--border,#2A2C31)') + '">'
        + esc(n) + '</button>';
    }).join('');
  }

  function segmented(key, options, current) {
    return '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">'
      + options.map(function (o) {
        var on = o.value === current;
        return '<button type="button" data-tj-seg="' + esc(key) + '" data-tj-value="' + esc(o.value) + '" '
          + 'style="flex:1 1 auto;min-height:40px;font-size:12px;font-weight:600;padding:8px 10px;'
          + 'border-radius:9px;cursor:pointer;'
          + 'background:' + (on ? 'rgba(32,197,181,.14)' : 'var(--surface,#141518)') + ';'
          + 'color:' + (on ? 'var(--primary,#20C5B5)' : 'var(--text-secondary,#B4B8C0)') + ';'
          + 'border:1px solid ' + (on ? 'rgba(32,197,181,.4)' : 'var(--border,#2A2C31)') + '">'
          + esc(o.label) + '</button>';
      }).join('') + '</div>';
  }

  function textInput(key, value, placeholder) {
    return '<input type="text" data-tj-field="' + esc(key) + '" value="' + esc(value == null ? '' : value)
      + '" placeholder="' + esc(placeholder || '') + '" style="width:100%;min-height:44px;font-size:13px;'
      + 'padding:8px 10px;margin-bottom:10px;border-radius:8px;background:var(--surface,#141518);'
      + 'color:var(--text,#E8E8E8);border:1px solid var(--border,#2A2C31)">';
  }

  function numberInput(key, value, min, max) {
    return '<input type="number" data-tj-num="' + esc(key) + '" value="' + esc(value == null ? '' : value)
      + '" min="' + esc(min) + '" max="' + esc(max) + '" style="width:100%;min-height:44px;font-size:13px;'
      + 'padding:8px 10px;margin-bottom:10px;border-radius:8px;background:var(--surface,#141518);'
      + 'color:var(--text,#E8E8E8);border:1px solid var(--border,#2A2C31)">';
  }

  function hint(text) {
    return '<div style="font-size:11px;color:var(--text-muted,#8A8F98);line-height:1.5;margin-top:4px">'
      + esc(text) + '</div>';
  }

  function warnLine(text) {
    return '<div style="font-size:12px;color:var(--flag,#F5A623);line-height:1.5;margin-bottom:6px">'
      + esc(text) + '</div>';
  }

  function secondTablePicker() {
    var all = allDatasets();
    var active = activeDataset();
    var others = all.filter(function (d) { return d && d !== active; });
    if (others.length === 0) {
      return card(label('Second table')
        + '<div style="font-size:12px;color:var(--flag,#F5A623)">Load a second table to join against. '
        + 'Both tables stay on this device.</div>');
    }
    var chosen = secondDataset();
    var opts = others.map(function (d) {
      var n = d.name || 'table';
      return '<option value="' + esc(n) + '"' + (chosen && chosen.name === n ? ' selected' : '') + '>'
        + esc(n) + '</option>';
    }).join('');
    return card(label('Second table')
      + '<select data-tj-second style="width:100%;min-height:44px;font-size:13px;padding:8px 10px;'
      + 'border-radius:8px;background:var(--surface,#141518);color:var(--text,#E8E8E8);'
      + 'border:1px solid var(--border,#2A2C31)">' + opts + '</select>');
  }

  /* ------------------------------- forms ---------------------------------- */

  function formFor(tabId, ds) {
    var names = columnNames(ds);
    var cfg = _cfg[tabId] || {};
    var eng = engines();
    var other = secondDataset();
    var otherNames = other ? columnNames(other) : [];

    if (tabId === 'prior') {
      var aggs = (eng.prior && eng.prior.PRIOR_PERIOD_AGGREGATES) || ['SUM'];
      var aggLabels = (eng.prior && eng.prior.PRIOR_PERIOD_AGGREGATE_LABELS) || {};
      return card(label('Date column') + select('dateColumn', names, cfg.dateColumn, false))
        + card(label('Period')
          + segmented('grain', [
            { value: 'day', label: 'Day over day' },
            { value: 'week', label: 'Week over week' },
            { value: 'month', label: 'Month over month' },
          ], cfg.grain || 'month'))
        + card(label('Combine the metric by')
          + segmented('aggregate', aggs.map(function (a) {
            return { value: a, label: aggLabels[a] || a };
          }), (cfg.aggregate || 'SUM'))
          + (cfg.aggregate === 'COUNT'
            ? '<div style="font-size:12px;color:var(--text-muted,#8A8F98)">Counting rows, so no metric column is needed.</div>'
            : label('Metric column') + select('metricColumn', names, cfg.metricColumn, false)))
        + card(label('Compare within each (optional)')
          + multiPick('entityColumns', names, cfg.entityColumns || [])
          + '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:4px">'
          + 'Leave empty to compare the table as a whole.</div>');
    }

    if (tabId === 'firstlast') {
      return card(label('Group by') + multiPick('entityColumns', names, cfg.entityColumns || []))
        + card(label('Order by') + select('orderColumn', names, cfg.orderColumn, false)
          + segmented('pick', [
            { value: 'first', label: 'First event' },
            { value: 'last', label: 'Latest event' },
          ], cfg.pick || 'last'))
        + card(label('Result')
          + segmented('mode', [
            { value: 'one', label: 'One row per group' },
            { value: 'ranked', label: 'All rows, ranked' },
          ], cfg.mode || 'one')
          + '<div style="font-size:11px;color:var(--text-muted,#8A8F98)">'
          + 'Ties on the order column are broken by the remaining columns in table order, '
          + 'so the same table always gives the same row.</div>');
    }

    if (tabId === 'range') {
      if (!other) return secondTablePicker();
      return secondTablePicker()
        + card(label('Event date on this table') + select('eventDateColumn', names, cfg.eventDateColumn, false))
        + card(label('Range start on the second table') + select('rangeStartColumn', otherNames, cfg.rangeStartColumn, false)
          + label('Range end (leave blank for open-ended)') + select('rangeEndColumn', otherNames, cfg.rangeEndColumn, true))
        + card(label('Match on') + keyPairEditor(cfg, names, otherNames))
        + card(label('Rules')
          + toggleRow('inclusiveEnd', 'An event on the end date is inside the range', cfg.inclusiveEnd !== false)
          + toggleRow('openEndedEnd', 'A blank end date means still in force', cfg.openEndedEnd !== false)
          + toggleRow('keepUnmatched', 'Keep events that match no range', cfg.keepUnmatched !== false));
    }

    if (tabId === 'asof') {
      if (!other) return secondTablePicker();
      return secondTablePicker()
        + card(label('Date on this table') + select('factDateColumn', names, cfg.factDateColumn, false))
        + card(label('Effective date on the lookup table') + select('refDateColumn', otherNames, cfg.refDateColumn, false))
        + card(label('Match on') + keyPairEditor(cfg, names, otherNames))
        + card(label('Bring across')
          + multiPick('valueColumns', otherNames.filter(function (n) { return n !== cfg.refDateColumn; }),
            cfg.valueColumns || [])
          + '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:4px">'
          + 'Leave empty to bring every column that is not a key or the effective date. '
          + 'Each arrives with an _asof suffix, so it cannot be mistaken for a current value.</div>');
    }
    if (tabId === 'hierarchy') {
      var byPath = cfg.source === 'path';
      return card(label('How the hierarchy is written')
        + segmented('source', [
          { value: 'edges', label: 'A parent column' },
          { value: 'path', label: 'A path column' },
        ], cfg.source || 'edges')
        + hint(byPath
          ? 'Each row carries its whole line of ancestors in one column, split by a separator.'
          : 'Each row names its own parent, and the chain is followed from the roots down.'))
        + (byPath
          ? card(label('Path column') + select('pathColumn', names, cfg.pathColumn, false)
            + label('Separator') + textInput('pathDelimiter', cfg.pathDelimiter || '/', '/'))
          : card(label('Node column') + select('nodeColumn', names, cfg.nodeColumn, false)
            + label('Parent column') + select('parentColumn', names, cfg.parentColumn, false)))
        + card(label('Add')
          + toggleRow('includePath', 'The full path to each node', cfg.includePath !== false)
          + toggleRow('includeIsLeaf', 'Whether a node has children', cfg.includeIsLeaf !== false)
          + toggleRow('includeRoot', 'The root each node sits under', cfg.includeRoot !== false)
          + hint('A node caught in a loop is reported with no depth rather than followed forever.'));
    }

    if (tabId === 'nested') {
      var srcLabels = (eng.nested && eng.nested.NESTED_SOURCE_LABELS) || {};
      var showDelim = (cfg.source || 'auto') !== 'json';
      return card(label('The column holding the lists') + select('listColumn', names, cfg.listColumn, false))
        + card(label('How to read it')
          + segmented('source', [
            { value: 'auto', label: srcLabels.auto || 'Work it out' },
            { value: 'json', label: srcLabels.json || 'JSON array' },
            { value: 'delimited', label: srcLabels.delimited || 'Separated text' },
          ], cfg.source || 'auto')
          + (showDelim ? label('Separator') + textInput('delimiter', cfg.delimiter || ',', ',') : ''))
        + card(label('Result')
          + toggleRow('includeIndex', 'Number each element within its row', cfg.includeIndex !== false)
          + toggleRow('trimElements', 'Trim spaces around each element', cfg.trimElements !== false)
          + segmented('emptyHandling', [
            { value: 'keep', label: 'Keep rows with an empty list' },
            { value: 'drop', label: 'Drop them' },
          ], cfg.emptyHandling || 'keep')
          + hint('Keeping them is the default because a plain UNNEST drops those rows silently, '
            + 'and a row vanishing from a count is harder to notice than a blank cell.'));
    }

    if (tabId === 'fill') {
      var byConstant = cfg.mode === 'constant';
      var suffix = (eng.fill && eng.fill.FILLED_SUFFIX) || '_was_filled';
      return card(label('Columns to fill') + multiPick('targetColumns', names, cfg.targetColumns || []))
        + card(label('Fill with')
          + segmented('mode', [
            { value: 'forward', label: 'The last value above' },
            { value: 'constant', label: 'A value I choose' },
          ], cfg.mode || 'forward')
          + (byConstant
            ? label('Value') + textInput('constantValue', cfg.constantValue, 'unknown')
            : label('Read the rows in this order') + select('orderColumn', names, cfg.orderColumn, false)
              + label('Carry forward within each (optional)')
              + multiPick('groupColumns', names, cfg.groupColumns || [])
              + label('Stop after this many rows (0 for no limit)')
              + numberInput('limit', cfg.limit || 0, 0, 100000)))
        + card('<div style="font-size:12px;color:var(--text-secondary,#B4B8C0);line-height:1.5">'
          + 'Every column filled here gets a companion ' + esc(suffix) + ' column marking which '
          + 'cells were invented. That column is not optional: a filled value that looks like a '
          + 'measured one is the reason this transform is dangerous.</div>');
    }

    if (tabId === 'daily') {
      var byAsAt = cfg.openEnd === 'asAt';
      return card(label('Start date') + select('startColumn', names, cfg.startColumn, false)
        + label('End date') + select('endColumn', names, cfg.endColumn, false))
        + card(label('New column name') + textInput('dayColumn', cfg.dayColumn || 'day', 'day')
          + toggleRow('includeDayIndex', 'Number the days within each range', cfg.includeDayIndex !== false)
          + toggleRow('includeSpanDays', 'Add the length of the range', !!cfg.includeSpanDays)
          + toggleRow('endInclusive', 'The end date counts as a day', cfg.endInclusive !== false))
        + card(label('Rows with no end date')
          + segmented('openEnd', [
            { value: 'skip', label: 'Leave them out' },
            { value: 'asAt', label: 'Run them to a date' },
          ], cfg.openEnd || 'skip')
          + (byAsAt ? textInput('asAtDate', cfg.asAtDate, 'YYYY-MM-DD') : '')
          + hint('There is no "up to today" option on purpose: a table built that way gives a '
            + 'different answer every time it is built.'));
    }

    if (tabId === 'bins') {
      var custom = cfg.mode === 'custom';
      return card(label('Column') + select('column', names, cfg.column, false))
        + card(label('Bands')
          + segmented('mode', [
            { value: 'equalWidth', label: 'Same width' },
            { value: 'custom', label: 'Edges I choose' },
          ], cfg.mode || 'equalWidth')
          + (custom
            ? label('Edges, lowest first') + textInput('edgesText', edgesText(cfg), '0, 10, 50, 100')
            : label('How many bands') + numberInput('binCount', cfg.binCount || 10, 2, 100)))
        + histogramCard()
        + card(label('Result')
          + toggleRow('keepOriginal', 'Keep the original number column', cfg.keepOriginal !== false)
          + toggleRow('includeBinIndex', 'Add the band number', cfg.includeBinIndex !== false)
          + hint('Bands are half-open: a value equal to an edge belongs to the band above it, and '
            + 'only the top band includes its own upper edge.'));
    }

    if (tabId === 'keep') {
      return card(label('Rows are the same thing when these match')
        + multiPick('keyColumns', names, cfg.keyColumns || []))
        + card(label('More recent means a later') + select('orderColumn', names, cfg.orderColumn, false)
          + segmented('pick', [
            { value: 'newest', label: 'Keep the newest' },
            { value: 'oldest', label: 'Keep the oldest' },
          ], cfg.pick || 'newest'))
        + card(label('Rows with no readable date')
          + segmented('undated', [
            { value: 'keep', label: 'Keep them' },
            { value: 'drop', label: 'Drop them' },
          ], cfg.undated || 'keep')
          + toggleRow('includeDroppedCount', 'Say how many rows each kept row stands for',
            cfg.includeDroppedCount !== false)
          + hint('This deletes rows. Rows sharing a key are only duplicates if they agree on '
            + 'their other columns, and the result names the columns where they did not.'));
    }

    return '';
  }

  /** The custom edges as the text a person types, so the field round-trips. */
  function edgesText(cfg) {
    var edges = Array.isArray(cfg && cfg.edges) ? cfg.edges : [];
    return edges.join(', ');
  }

  /**
   * The histogram, drawn from the engine's own counts rather than from a second
   * pass over the rows. If the bars and the applied bands could disagree, the
   * picture would be the thing people trusted and the wrong one.
   */
  function histogramCard() {
    var eng = engines();
    var ds = activeDataset();
    var cfg = _cfg.bins;
    if (!eng.bins || !ds || !cfg || !cfg.column) return '';
    var counted;
    try { counted = eng.bins.binCounts(ds, cfg); } catch (_e) { return ''; }
    if (!counted || !counted.ok) {
      return card(label('Bands') + warnLine(counted && counted.error ? counted.error
        : 'These bands cannot be drawn yet.'));
    }
    var most = counted.counts.reduce(function (a, b) { return b > a ? b : a; }, 0) || 1;
    var bars = counted.counts.map(function (n, i) {
      var pct = Math.round((n / most) * 100);
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">'
        + '<div style="flex:0 0 96px;font-size:10px;color:var(--text-muted,#8A8F98);'
        + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(counted.labels[i]) + '</div>'
        + '<div style="flex:1;height:12px;background:var(--surface,#141518);border-radius:3px;overflow:hidden">'
        + '<div style="height:100%;width:' + pct + '%;background:var(--primary,#20C5B5);opacity:.75"></div></div>'
        + '<div style="flex:0 0 40px;text-align:right;font-size:10px;color:var(--text-secondary,#B4B8C0)">'
        + n + '</div></div>';
    }).join('');
    var warn = (counted.warnings || []).map(warnLine).join('');
    return card(label('How the rows fall') + bars + (warn ? '<div style="margin-top:8px">' + warn + '</div>' : ''));
  }

  /**
   * The row count before the run, for the two transforms that can multiply a
   * table. Shown above the run button rather than beside the result, because a
   * warning that arrives after the browser has already built two million rows
   * has warned nobody.
   */
  function previewCard(tabId) {
    var eng = engines();
    var ds = activeDataset();
    var cfg = _cfg[tabId];
    if (!ds || !cfg) return '';
    var p = null;
    try {
      if (tabId === 'nested' && eng.nested) p = eng.nested.previewNestedToRows(ds, cfg);
      if (tabId === 'daily' && eng.daily) p = eng.daily.previewExpandDateRange(ds, cfg, { narrow: isNarrow() });
    } catch (_e) { return ''; }
    if (!p) return '';
    if (!p.ok) return card(label('Before you run this') + warnLine(p.error));

    var line = p.rowsIn + ' row' + (p.rowsIn === 1 ? '' : 's') + ' would become '
      + p.rowsOut.toLocaleString() + '.';
    var warns = (p.warnings || []).map(warnLine).join('');
    var blocked = p.overCap
      ? warnLine('This will not run at that size. Narrow the table or the range first, and nothing '
        + 'will be changed in the meantime.')
      : '';
    return card(label('Before you run this')
      + '<div style="font-size:13px;font-weight:600;line-height:1.45;margin-bottom:8px">'
      + esc(line) + '</div>' + warns + blocked);
  }

  function keyPairEditor(cfg, leftNames, rightNames) {
    var pairs = Array.isArray(cfg.keyPairs) ? cfg.keyPairs : [];
    var rows = pairs.map(function (p, i) {
      return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap">'
        + '<select data-tj-pair="' + i + '" data-tj-side="left" style="flex:1 1 120px;min-height:44px;font-size:12px;'
        + 'padding:6px 8px;border-radius:8px;background:var(--surface,#141518);color:var(--text,#E8E8E8);'
        + 'border:1px solid var(--border,#2A2C31)">'
        + leftNames.map(function (n) {
          return '<option value="' + esc(n) + '"' + (n === p.left ? ' selected' : '') + '>' + esc(n) + '</option>';
        }).join('') + '</select>'
        + '<span style="font-size:12px;color:var(--text-muted,#8A8F98)">=</span>'
        + '<select data-tj-pair="' + i + '" data-tj-side="right" style="flex:1 1 120px;min-height:44px;font-size:12px;'
        + 'padding:6px 8px;border-radius:8px;background:var(--surface,#141518);color:var(--text,#E8E8E8);'
        + 'border:1px solid var(--border,#2A2C31)">'
        + rightNames.map(function (n) {
          return '<option value="' + esc(n) + '"' + (n === p.right ? ' selected' : '') + '>' + esc(n) + '</option>';
        }).join('') + '</select>'
        + '<button type="button" data-tj-pair-remove="' + i + '" style="min-height:44px;min-width:44px;'
        + 'border-radius:8px;background:var(--surface,#141518);color:var(--text-muted,#8A8F98);'
        + 'border:1px solid var(--border,#2A2C31);cursor:pointer" aria-label="Remove">&times;</button>'
        + '</div>';
    }).join('');
    return rows
      + '<button type="button" data-tj-pair-add style="min-height:40px;font-size:12px;padding:8px 12px;'
      + 'border-radius:9px;background:var(--surface,#141518);color:var(--text-secondary,#B4B8C0);'
      + 'border:1px solid var(--border,#2A2C31);cursor:pointer">Add a matching column</button>'
      + '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:6px">'
      + 'Optional. With no matching column, every row is compared against every range.</div>';
  }

  /* ------------------------------- result --------------------------------- */

  function runCurrent() {
    var eng = engines();
    var ds = activeDataset();
    if (!ds) return { ok: false, error: 'Load a table first.' };
    var cfg = _cfg[_tab];
    if (!cfg) return { ok: false, error: 'Nothing configured yet.' };
    var other = secondDataset();
    try {
      if (_tab === 'prior' && eng.prior) return eng.prior.priorPeriodTransform(ds, cfg);
      if (_tab === 'firstlast' && eng.firstlast) return eng.firstlast.firstLastEventTransform(ds, cfg);
      if (_tab === 'range' && eng.range) return eng.range.dateRangeJoinTransform(ds, other, cfg);
      if (_tab === 'asof' && eng.asof) return eng.asof.asOfLookupTransform(ds, other, cfg);
      if (_tab === 'hierarchy' && eng.hierarchy) return eng.hierarchy.expandHierarchyTransform(ds, cfg);
      if (_tab === 'nested' && eng.nested) return eng.nested.nestedToRowsTransform(ds, cfg);
      if (_tab === 'fill' && eng.fill) return eng.fill.fillMissingTransform(ds, cfg);
      if (_tab === 'daily' && eng.daily) return eng.daily.expandDateRangeTransform(ds, cfg);
      if (_tab === 'bins' && eng.bins) return eng.bins.binColumnTransform(ds, cfg);
      if (_tab === 'keep' && eng.keep) return eng.keep.keepMostRecentTransform(ds, cfg);
    } catch (e) {
      return { ok: false, error: 'This did not run: ' + (e && e.message ? e.message : 'unknown error') };
    }
    return { ok: false, error: 'That transform is not available.' };
  }

  function findingFor(result) {
    var eng = engines();
    try {
      if (_tab === 'prior' && eng.prior) return eng.prior.describePriorPeriod(result, _cfg.prior);
      if (_tab === 'firstlast' && eng.firstlast) return eng.firstlast.describeFirstLast(result, _cfg.firstlast);
      if (_tab === 'range' && eng.range) return eng.range.describeDateRangeJoin(result);
      if (_tab === 'asof' && eng.asof) return eng.asof.describeAsOfLookup(result);
      if (_tab === 'hierarchy' && eng.hierarchy) return eng.hierarchy.describeHierarchy(result);
      if (_tab === 'nested' && eng.nested) return eng.nested.describeNestedToRows(result);
      if (_tab === 'fill' && eng.fill) return eng.fill.describeFillMissing(result);
      if (_tab === 'daily' && eng.daily) return eng.daily.describeExpandDateRange(result);
      if (_tab === 'bins' && eng.bins) return eng.bins.describeBinColumn(result);
      if (_tab === 'keep' && eng.keep) return eng.keep.describeKeepMostRecent(result);
    } catch (_e) {}
    return result && result.ok ? (result.rows.length + ' rows.') : 'This did not run.';
  }

  function previewTable(result) {
    var cols = result.columns || [];
    var rows = (result.rows || []).slice(0, PREVIEW_ROWS);
    if (!rows.length) {
      return '<div style="font-size:12px;color:var(--text-muted,#8A8F98)">No rows came back.</div>';
    }
    var head = cols.map(function (c) {
      return '<th style="text-align:left;padding:5px 8px;font-size:11px;font-weight:700;'
        + 'color:var(--text-muted,#8A8F98);white-space:nowrap;border-bottom:1px solid var(--border,#2A2C31)">'
        + esc(c.name) + '</th>';
    }).join('');
    var body = rows.map(function (r) {
      return '<tr>' + cols.map(function (_c, i) {
        var v = r[i];
        var blank = (v == null || v === '');
        return '<td style="padding:5px 8px;font-size:12px;white-space:nowrap;'
          + 'color:' + (blank ? 'var(--text-muted,#8A8F98)' : 'var(--text,#E8E8E8)') + '">'
          + (blank ? '&mdash;' : esc(v)) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    var more = (result.rows || []).length > PREVIEW_ROWS
      ? '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-top:6px">Showing the first '
        + PREVIEW_ROWS + ' of ' + result.rows.length + ' rows.</div>'
      : '';
    return '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="border-collapse:collapse;min-width:100%">'
      + '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' + more;
  }

  function resultBlock() {
    if (!_result || _resultTab !== _tab) return '';
    if (!_result.ok) {
      return card('<div style="font-size:13px;color:var(--flag,#F5A623)">' + esc(_result.error) + '</div>');
    }

    // Finding first.
    var html = card('<div style="font-size:13px;font-weight:600;line-height:1.45">'
      + esc(findingFor(_result)) + '</div>');

    // Everything the engine could not do, named rather than hidden.
    if (_result.notes && _result.notes.length) {
      html += card(label('What this could not do')
        + _result.notes.map(function (n) {
          return '<div style="font-size:12px;color:var(--text-secondary,#B4B8C0);line-height:1.5;margin-bottom:6px">'
            + esc(n) + '</div>';
        }).join(''));
    }

    html += card(label('Preview') + previewTable(_result));

    // Proof under the finding, always.
    html += card(label('The SQL that says this')
      + '<pre style="margin:0;max-height:220px;overflow:auto;-webkit-overflow-scrolling:touch;'
      + 'white-space:pre;font-family:var(--mono,monospace);font-size:11px;line-height:1.5;'
      + 'color:var(--text-secondary,#B4B8C0)">' + esc(_result.sql) + '</pre>'
      + '<button type="button" data-tj-copy style="min-height:40px;margin-top:8px;font-size:12px;'
      + 'padding:8px 12px;border-radius:9px;background:var(--surface,#141518);'
      + 'color:var(--text-secondary,#B4B8C0);border:1px solid var(--border,#2A2C31);cursor:pointer">'
      + 'Copy SQL</button>');

    // The confirm gate. Two clicks, and the second one names the consequence.
    var rowsNow = (activeDataset() && activeDataset().rows || []).length;
    var rowsAfter = _result.rows.length;
    var shape = rowsNow === rowsAfter
      ? 'The table keeps its ' + rowsNow + ' rows.'
      : rowsNow + ' rows become ' + rowsAfter + '.';
    html += card('<div style="font-size:12px;color:var(--text-secondary,#B4B8C0);margin-bottom:9px;line-height:1.5">'
      + esc(shape) + ' This replaces the loaded table in memory. Nothing is uploaded, and Undo puts it back.</div>'
      + (_pendingConfirm
        ? '<button type="button" data-tj-confirm style="width:100%;min-height:44px;font-size:13px;'
          + 'font-weight:700;border-radius:10px;background:var(--primary,#20C5B5);color:#08292A;'
          + 'border:none;cursor:pointer">Yes, replace the table</button>'
          + '<button type="button" data-tj-cancel style="width:100%;min-height:44px;margin-top:8px;'
          + 'font-size:12px;border-radius:10px;background:transparent;color:var(--text-muted,#8A8F98);'
          + 'border:1px solid var(--border,#2A2C31);cursor:pointer">Cancel</button>'
        : '<button type="button" data-tj-apply style="width:100%;min-height:44px;font-size:13px;'
          + 'font-weight:700;border-radius:10px;background:var(--surface,#141518);'
          + 'color:var(--text,#E8E8E8);border:1px solid var(--border,#2A2C31);cursor:pointer">'
          + 'Apply to the loaded table</button>')
      + (activeDataset() && activeDataset()._transformSnapshot
        ? '<button type="button" data-tj-undo style="width:100%;min-height:44px;margin-top:8px;'
          + 'font-size:12px;border-radius:10px;background:transparent;color:var(--text-secondary,#B4B8C0);'
          + 'border:1px solid var(--border,#2A2C31);cursor:pointer">Undo the last apply</button>'
        : ''));
    return html;
  }

  /* -------------------------------- render -------------------------------- */

  function renderBody() {
    var body = document.getElementById(BODY_ID);
    if (!body) return;
    var groups = enabledGroups();
    if (!groups.length) { body.innerHTML = ''; return; }
    if (!_group || !groups.some(function (g) { return g.id === _group; })) _group = groups[0].id;

    var tabs = tabsInGroup(_group);
    if (!_tab || !tabs.some(function (t) { return t.id === _tab; })) _tab = tabs[0].id;

    var ds = activeDataset();

    // The group switch is only worth its space when there is a choice to make.
    var groupNav = groups.length < 2 ? ''
      : '<div style="display:flex;gap:6px;margin-bottom:10px">'
        + groups.map(function (g) {
          var on = g.id === _group;
          return '<button type="button" data-tj-group="' + esc(g.id) + '" '
            + 'style="flex:1 1 50%;min-height:42px;font-size:12px;font-weight:700;padding:8px 6px;'
            + 'border-radius:10px;cursor:pointer;'
            + 'background:' + (on ? 'var(--primary,#20C5B5)' : 'var(--surface-2,#1A1C20)') + ';'
            + 'color:' + (on ? '#08292A' : 'var(--text-secondary,#B4B8C0)') + ';'
            + 'border:1px solid ' + (on ? 'var(--primary,#20C5B5)' : 'var(--border,#2A2C31)') + '">'
            + esc(g.label) + '</button>';
        }).join('') + '</div>';

    var nav = groupNav + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">'
      + tabs.map(function (t) {
        var on = t.id === _tab;
        return '<button type="button" data-tj-tab="' + t.id + '" '
          + 'style="flex:1 1 45%;min-height:42px;font-size:12px;font-weight:600;padding:8px 6px;'
          + 'border-radius:10px;cursor:pointer;'
          + 'background:' + (on ? 'rgba(32,197,181,.14)' : 'var(--surface-2,#1A1C20)') + ';'
          + 'color:' + (on ? 'var(--primary,#20C5B5)' : 'var(--text-secondary,#B4B8C0)') + ';'
          + 'border:1px solid ' + (on ? 'rgba(32,197,181,.4)' : 'var(--border,#2A2C31)') + '">'
          + esc(t.short) + '</button>';
      }).join('') + '</div>';

    if (!ds) {
      body.innerHTML = nav + card('<div style="font-size:13px;color:var(--text-muted,#8A8F98);line-height:1.5">'
        + 'Load a table and these transforms become available. Each one exists to stop a specific '
        + 'wrong number: comparing across a gap in the calendar, a join that quietly doubles a '
        + 'total, a tie that picks a different row every run, a filled blank that reads like a '
        + 'measurement, and a de-duplication that threw away a fact.'
        + '</div>');
      wire();
      return;
    }

    ensureConfig(_tab, false);
    var current = TABS.filter(function (t) { return t.id === _tab; })[0];
    var head = '<div style="font-size:14px;font-weight:700;margin-bottom:3px">' + esc(current.label) + '</div>'
      + '<div style="font-size:11px;color:var(--text-muted,#8A8F98);margin-bottom:12px">'
      + esc(ds.name || 'the loaded table') + '</div>';

    body.innerHTML = nav + head + formFor(_tab, ds) + previewCard(_tab)
      + '<button type="button" data-tj-run style="width:100%;min-height:44px;font-size:13px;font-weight:700;'
      + 'border-radius:10px;background:var(--surface-2,#1A1C20);color:var(--text,#E8E8E8);'
      + 'border:1px solid var(--border,#2A2C31);cursor:pointer;margin-bottom:12px">Show me the result</button>'
      + resultBlock();
    wire();
  }

  function wire() {
    var body = document.getElementById(BODY_ID);
    if (!body) return;

    body.querySelectorAll('[data-tj-group]').forEach(function (el) {
      el.onclick = function () {
        _group = el.getAttribute('data-tj-group');
        _tab = null;
        _pendingConfirm = false;
        renderBody();
      };
    });

    body.querySelectorAll('[data-tj-num]').forEach(function (el) {
      el.onchange = function () {
        var cfg = _cfg[_tab];
        if (!cfg) return;
        var n = Number(el.value);
        cfg[el.getAttribute('data-tj-num')] = Number.isFinite(n) ? n : 0;
        invalidate();
      };
    });

    body.querySelectorAll('[data-tj-tab]').forEach(function (el) {
      el.onclick = function () {
        _tab = el.getAttribute('data-tj-tab');
        _pendingConfirm = false;
        renderBody();
      };
    });

    body.querySelectorAll('[data-tj-field]').forEach(function (el) {
      el.onchange = function () {
        var cfg = _cfg[_tab];
        if (!cfg) return;
        var key = el.getAttribute('data-tj-field');
        // The edges field is typed as text and stored as numbers, so the engine
        // never has to guess what "0, 10, 50" meant.
        if (key === 'edgesText') {
          var eng = engines();
          cfg.edges = eng.bins ? eng.bins.normalizeEdges(el.value) : [];
        } else {
          cfg[key] = el.value;
        }
        invalidate();
      };
    });

    body.querySelectorAll('[data-tj-seg]').forEach(function (el) {
      el.onclick = function () {
        var cfg = _cfg[_tab];
        if (!cfg) return;
        cfg[el.getAttribute('data-tj-seg')] = el.getAttribute('data-tj-value');
        invalidate();
      };
    });

    body.querySelectorAll('[data-tj-toggle]').forEach(function (el) {
      el.onchange = function () {
        var cfg = _cfg[_tab];
        if (!cfg) return;
        cfg[el.getAttribute('data-tj-toggle')] = !!el.checked;
        invalidate();
      };
    });

    body.querySelectorAll('[data-tj-multi]').forEach(function (el) {
      el.onclick = function () {
        var cfg = _cfg[_tab];
        if (!cfg) return;
        var key = el.getAttribute('data-tj-multi');
        var value = el.getAttribute('data-tj-value');
        var list = Array.isArray(cfg[key]) ? cfg[key].slice() : [];
        var at = list.indexOf(value);
        if (at === -1) list.push(value); else list.splice(at, 1);
        cfg[key] = list;
        invalidate();
      };
    });

    var second = body.querySelector('[data-tj-second]');
    if (second) {
      second.onchange = function () {
        _secondName = second.value;
        ensureConfig(_tab, true);
        invalidate();
      };
    }

    body.querySelectorAll('[data-tj-pair]').forEach(function (el) {
      el.onchange = function () {
        var cfg = _cfg[_tab];
        if (!cfg || !Array.isArray(cfg.keyPairs)) return;
        var i = Number(el.getAttribute('data-tj-pair'));
        var side = el.getAttribute('data-tj-side');
        if (cfg.keyPairs[i]) cfg.keyPairs[i][side] = el.value;
        invalidate();
      };
    });

    body.querySelectorAll('[data-tj-pair-remove]').forEach(function (el) {
      el.onclick = function () {
        var cfg = _cfg[_tab];
        if (!cfg || !Array.isArray(cfg.keyPairs)) return;
        cfg.keyPairs.splice(Number(el.getAttribute('data-tj-pair-remove')), 1);
        invalidate();
      };
    });

    var addPair = body.querySelector('[data-tj-pair-add]');
    if (addPair) {
      addPair.onclick = function () {
        var cfg = _cfg[_tab];
        var ds = activeDataset();
        var other = secondDataset();
        if (!cfg || !ds || !other) return;
        if (!Array.isArray(cfg.keyPairs)) cfg.keyPairs = [];
        cfg.keyPairs.push({ left: columnNames(ds)[0], right: columnNames(other)[0] });
        invalidate();
      };
    }

    var runBtn = body.querySelector('[data-tj-run]');
    if (runBtn) {
      runBtn.onclick = function () {
        _result = runCurrent();
        _resultTab = _tab;
        _pendingConfirm = false;
        renderBody();
      };
    }

    var copyBtn = body.querySelector('[data-tj-copy]');
    if (copyBtn) {
      copyBtn.onclick = function () {
        var sql = (_result && _result.sql) || '';
        if (!sql) return;
        try {
          navigator.clipboard.writeText(sql);
          toast('SQL copied');
        } catch (_e) { toast('Could not copy', 'warn'); }
      };
    }

    var applyBtn = body.querySelector('[data-tj-apply]');
    if (applyBtn) applyBtn.onclick = function () { _pendingConfirm = true; renderBody(); };

    var cancelBtn = body.querySelector('[data-tj-cancel]');
    if (cancelBtn) cancelBtn.onclick = function () { _pendingConfirm = false; renderBody(); };

    var confirmBtn = body.querySelector('[data-tj-confirm]');
    if (confirmBtn) confirmBtn.onclick = doApply;

    var undoBtn = body.querySelector('[data-tj-undo]');
    if (undoBtn) undoBtn.onclick = doUndo;
  }

  // A config change makes the shown result stale, and a stale result beside a
  // live Apply button is how someone applies something they did not read.
  function invalidate() {
    _result = null;
    _resultTab = null;
    _pendingConfirm = false;
    renderBody();
  }

  /* -------------------------------- apply --------------------------------- */

  function doApply() {
    var ds = activeDataset();
    if (!ds || !_result || !_result.ok) { toast('Nothing to apply', 'warn'); return; }
    try {
      ds._transformSnapshot = {
        columns: JSON.parse(JSON.stringify(ds.columns || [])),
        rows: JSON.parse(JSON.stringify(ds.rows || [])),
      };
    } catch (_e) {}
    ds.columns = _result.columns;
    ds.rows = _result.rows;
    _pendingConfirm = false;

    try {
      if (window.ProvenanceFabric && typeof window.ProvenanceFabric.append === 'function') {
        window.ProvenanceFabric.append('table_transform', {
          transform: _tab,
          group: _group,
          rowsIn: (_result.stats && _result.stats.rowsIn) || 0,
          rowsOut: _result.rows.length,
          notes: (_result.notes || []).length,
        });
      }
    } catch (_e2) {}

    notifyDatasetChanged(ds);
    renderBody();
    toast('Applied: ' + _result.rows.length + ' rows');
  }

  function doUndo() {
    var ds = activeDataset();
    if (!ds || !ds._transformSnapshot) { toast('Nothing to undo', 'warn'); return; }
    ds.columns = ds._transformSnapshot.columns;
    ds.rows = ds._transformSnapshot.rows;
    delete ds._transformSnapshot;
    _cfg = {};
    invalidate();
    notifyDatasetChanged(ds);
    toast('Put back');
  }

  function notifyDatasetChanged(ds) {
    try {
      document.dispatchEvent(new CustomEvent('dataglow:dataset-updated',
        { detail: { dataset: ds, source: 'transforms' } }));
    } catch (_e) {}
    try {
      if (typeof window.renderGrid === 'function') window.renderGrid(ds);
      else if (typeof window.refreshGrid === 'function') window.refreshGrid();
    } catch (_e2) {}
  }

  /* --------------------------------- boot --------------------------------- */

  function openPanel() {
    if (!enabledTabs().length) return;
    var panel = ensurePanel();
    renderBody();
    panel.style.transform = 'translateX(0)';
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.transform = 'translateX(105%)';
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header, #analyze-pills, .analyze-pills');
    if (!toolbar) toolbar = document.body;
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open table transforms');
    btn.title = enabledGroups().map(function (g) { return g.plain; }).join(', ');
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:7px', 'min-height:38px',
      'padding:0 13px', 'border:1px solid var(--border,#2A2C31)', 'border-radius:10px',
      'background:var(--surface-2,#1A1C20)', 'color:var(--text,#E8E8E8)',
      'font-size:13px', 'font-weight:600', 'cursor:pointer'
    ].join(';');
    btn.innerHTML = '<span aria-hidden="true" style="width:8px;height:8px;border-radius:50%;'
      + 'background:var(--primary,#20C5B5);display:inline-block"></span><span>Transforms</span>';
    btn.addEventListener('click', function () {
      var panel = document.getElementById(PANEL_ID);
      if (panel && panel.style.transform === 'translateX(0px)') closePanel();
      else openPanel();
    });
    if (toolbar === document.body) {
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '300px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function boot() {
    // No enabled tab means no engine a person could use, so nothing mounts and
    // no dead control is left behind. This is what makes the flags honest: a
    // flag that is off leaves no button, no panel and no global.
    if (!enabledTabs().length) return;
    injectButton();
    ensurePanel();

    document.addEventListener('dataglow:dataset-loaded', function () { _cfg = {}; invalidate(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanel(); });

    window.DataGlowTransformsUI = {
      version: 2,
      openPanel: openPanel,
      closePanel: closePanel,
      groups: enabledGroups().map(function (g) { return g.id; }),
      tabs: enabledTabs().map(function (t) { return t.id; }),
      getConfig: function () { return _cfg; },
      getResult: function () { return _result; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 750); });
  } else {
    setTimeout(boot, 750);
  }
})();
/* ---- end js/transforms/data-glow-transforms-canvas.js ---- */
