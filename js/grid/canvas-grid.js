/**
 * canvas-grid.js — DataGlow High-Performance Canvas Grid (PR AO)
 *
 * Pure HTML5 Canvas grid renderer. No DOM nodes per cell. No React.
 * Zero dependencies. Renders 1M+ rows at 60fps via virtual scrolling.
 *
 * Architecture:
 *  - Only draws the visible viewport (typically 20-40 rows)
 *  - Virtual scroll: scrollTop/scrollLeft determine which rows/cols to draw
 *  - Canvas is resized to fill container via ResizeObserver
 *  - Header drawn on a separate sticky canvas above the main canvas
 *  - Row flags (warning/error) drawn as left-border colored stripes
 *  - Health dots drawn in column headers
 *  - Column widths are measured from data samples on first render
 *  - Click → row selection + opens validation rail (same as DOM grid)
 *  - Double-click header → triggers ColumnEditor rename (same as DOM grid)
 *  - Formula bar wired to show active cell value
 *
 * Public API:
 *   CanvasGrid.mount(containerEl, dataset, opts) → instance
 *   instance.update(dataset)    — swap to new dataset, re-render
 *   instance.destroy()          — remove canvases, cancel RAF
 *   instance.getActiveCell()    → { row, col } or null
 *   instance.scrollToRow(idx)
 */

export var CanvasGrid = (function () {
  'use strict';

  // ── Design tokens (keep in sync with CSS vars) ────────────────────────────
  function getTokens(isDark) {
    return isDark ? {
      bg:          '#171614',
      surface:     '#1C1B19',
      border:      '#393836',
      text:        '#CDCCCA',
      textMuted:   '#797876',
      textFaint:   '#5A5957',
      primary:     '#4F98A3',
      mono:        'Consolas, "Courier New", monospace',
      sans:        'system-ui, -apple-system, sans-serif',
      rowAlt:      '#1C1B19',
      rowHover:    '#20201E',
      rowSelected: '#1B3A3D',
      rowWarning:  'rgba(217,119,6,0.07)',
      rowError:    'rgba(185,28,28,0.07)',
      flagWarning: '#D97706',
      flagError:   '#DC2626',
      flagGreen:   '#16A34A',
      flagAmber:   '#D97706',
      flagRed:     '#DC2626',
      headerBg:    '#201F1D',
      headerBorder:'#393836',
      chipBg:      '#171614',
      chipBorder:  '#393836',
      chipText:    '#797876',
      emptyText:   '#5A5957',
      scrollThumb: '#393836',
    } : {
      bg:          '#F7F6F2',
      surface:     '#F9F8F5',
      border:      '#D4D1CA',
      text:        '#28251D',
      textMuted:   '#7A7974',
      textFaint:   '#BAB9B4',
      primary:     '#01696F',
      mono:        'Consolas, "Courier New", monospace',
      sans:        'system-ui, -apple-system, sans-serif',
      rowAlt:      '#FAFAF8',
      rowHover:    '#F0EFE9',
      rowSelected: '#E0F0F1',
      rowWarning:  'rgba(217,119,6,0.06)',
      rowError:    'rgba(185,28,28,0.06)',
      flagWarning: '#D97706',
      flagError:   '#DC2626',
      flagGreen:   '#16A34A',
      flagAmber:   '#D97706',
      flagRed:     '#DC2626',
      headerBg:    '#F2F1ED',
      headerBorder:'#D4D1CA',
      chipBg:      '#F7F6F2',
      chipBorder:  '#D4D1CA',
      chipText:    '#7A7974',
      emptyText:   '#BAB9B4',
      scrollThumb: '#D4D1CA',
    };
  }

  // ── Constants ─────────────────────────────────────────────────────────────
  var ROW_H        = 34;    // px per data row
  var HEADER_H     = 40;    // px for column header
  var FLAG_W       = 3;     // px left border for row flags
  var MIN_COL_W    = 80;
  var MAX_COL_W    = 320;
  var PAD_H        = 12;    // horizontal cell padding
  var PAD_V        = 10;    // vertical cell padding
  var FONT_CELL    = '13px system-ui,-apple-system,sans-serif';
  var FONT_HEADER  = '600 13px system-ui,-apple-system,sans-serif';
  var FONT_CHIP    = '10px Consolas,"Courier New",monospace';
  var FONT_EMPTY   = 'italic 13px system-ui,-apple-system,sans-serif';
  var SCROLL_BAR_W = 12;    // virtual scrollbar width
  var OVERDRAW     = 2;     // extra rows drawn above/below viewport

  // ── Column width measurement ──────────────────────────────────────────────
  function measureColWidths(ctx, dataset) {
    var cols = dataset.columns, rows = dataset.rows;
    return cols.map(function (col, ci) {
      // Measure header: name + type chip
      ctx.font = FONT_HEADER;
      var hw = ctx.measureText(col.name).width + 60; // 60 for chip + dot + padding
      // Sample up to 30 rows
      ctx.font = FONT_CELL;
      var maxSample = Math.min(rows.length, 30);
      var mw = hw;
      for (var ri = 0; ri < maxSample; ri++) {
        var v = rows[ri][ci];
        var s = (v === null || v === undefined || v === '') ? '' : String(v);
        var w = ctx.measureText(s).width + PAD_H * 2 + FLAG_W;
        if (w > mw) mw = w;
      }
      return Math.max(MIN_COL_W, Math.min(MAX_COL_W, mw));
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function isDarkMode() {
    return document.documentElement.classList.contains('dark');
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function formatCell(v) {
    if (v === null || v === undefined || v === '') return null; // null = render as empty
    return String(v);
  }

  function colHealthColor(dataset, colIdx, tok) {
    if (!dataset.columnHealth) return tok.flagGreen;
    var h = dataset.columnHealth[colIdx];
    if (h === 'red')   return tok.flagRed;
    if (h === 'amber') return tok.flagAmber;
    return tok.flagGreen;
  }

  // ── Canvas Grid Instance ──────────────────────────────────────────────────
  function create(container, dataset, opts) {
    opts = opts || {};
    var onRowClick   = opts.onRowClick   || function () {};
    var onColDblClick= opts.onColDblClick|| function () {};
    var onCellFocus  = opts.onCellFocus  || function () {};
    var onColHover   = opts.onColHover   || function () {};
    var onColHoverEnd= opts.onColHoverEnd|| function () {};

    // Wrapper takes full container space
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';

    // Header canvas (sticky, top)
    var headerCanvas = document.createElement('canvas');
    headerCanvas.style.cssText = 'display:block;position:absolute;top:0;left:0;z-index:2;';

    // Main canvas (scrollable content)
    var mainCanvas = document.createElement('canvas');
    mainCanvas.style.cssText = 'display:block;position:absolute;top:'+HEADER_H+'px;left:0;';
    mainCanvas.setAttribute('tabindex', '0');

    // Virtual scrollbar div (thin overlay on right edge)
    var vScroll = document.createElement('div');
    vScroll.style.cssText = 'position:absolute;right:0;top:'+HEADER_H+'px;width:'+SCROLL_BAR_W+'px;overflow-y:scroll;overflow-x:hidden;z-index:3;';
    var vScrollInner = document.createElement('div');
    vScrollInner.style.cssText = 'width:1px;';
    vScroll.appendChild(vScrollInner);

    var hScroll = document.createElement('div');
    hScroll.style.cssText = 'position:absolute;bottom:0;left:0;right:'+SCROLL_BAR_W+'px;height:'+SCROLL_BAR_W+'px;overflow-x:scroll;overflow-y:hidden;z-index:3;';
    var hScrollInner = document.createElement('div');
    hScrollInner.style.cssText = 'height:1px;';
    hScroll.appendChild(hScrollInner);

    wrapper.appendChild(headerCanvas);
    wrapper.appendChild(mainCanvas);
    wrapper.appendChild(vScroll);
    wrapper.appendChild(hScroll);
    container.innerHTML = '';
    container.appendChild(wrapper);

    var hCtx = headerCanvas.getContext('2d');
    var mCtx = mainCanvas.getContext('2d');

    var state = {
      dataset:     dataset,
      colWidths:   [],
      totalW:      0,
      totalH:      0,
      scrollTop:   0,
      scrollLeft:  0,
      activeRow:   -1,
      activeCol:   -1,
      hoverRow:    -1,
      width:       0,    // canvas draw width (CSS pixels)
      height:      0,    // main canvas draw height
      dpr:         window.devicePixelRatio || 1,
      rafId:       null,
      dirty:       true,
    };

    function initColWidths() {
      // Use offscreen canvas for measurement (no draw side effects)
      var mc = document.createElement('canvas');
      var mx = mc.getContext('2d');
      state.colWidths = measureColWidths(mx, state.dataset);
      state.totalW = state.colWidths.reduce(function (s, w) { return s + w; }, 0) + FLAG_W;
      state.totalH = state.dataset.rows.length * ROW_H;
    }

    function resize() {
      var rect = container.getBoundingClientRect();
      var dpr  = window.devicePixelRatio || 1;
      var w    = Math.floor(rect.width);
      var h    = Math.floor(rect.height);
      state.width  = w;
      state.height = h - HEADER_H - SCROLL_BAR_W;
      state.dpr    = dpr;

      // Header canvas
      headerCanvas.width  = w * dpr;
      headerCanvas.height = HEADER_H * dpr;
      headerCanvas.style.width  = w + 'px';
      headerCanvas.style.height = HEADER_H + 'px';
      hCtx.scale(dpr, dpr);

      // Main canvas
      mainCanvas.width  = w * dpr;
      mainCanvas.height = state.height * dpr;
      mainCanvas.style.width  = w + 'px';
      mainCanvas.style.height = state.height + 'px';
      mCtx.scale(dpr, dpr);

      // Virtual scrollbar heights
      vScroll.style.height = state.height + 'px';
      vScrollInner.style.height = state.totalH + 'px';
      hScrollInner.style.width  = state.totalW + 'px';

      state.dirty = true;
    }

    // ── Draw header ──────────────────────────────────────────────────────
    function drawHeader() {
      var tok  = getTokens(isDarkMode());
      var ctx  = hCtx;
      var w    = state.width;
      var cols = state.dataset.columns;
      var dpr  = state.dpr;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = tok.headerBg;
      ctx.fillRect(0, 0, w, HEADER_H);

      // Bottom border
      ctx.fillStyle = tok.headerBorder;
      ctx.fillRect(0, HEADER_H - 1, w, 1);

      var x = FLAG_W - state.scrollLeft;

      cols.forEach(function (col, ci) {
        var cw = state.colWidths[ci];
        if (x + cw < 0 || x > w) { x += cw; return; }

        // Column right border
        ctx.fillStyle = tok.border;
        ctx.fillRect(x + cw - 1, 0, 1, HEADER_H - 1);

        // Clip to column
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.max(FLAG_W, x), 0, cw - 1, HEADER_H);
        ctx.clip();

        // Column name
        ctx.font = FONT_HEADER;
        ctx.fillStyle = tok.text;
        ctx.textBaseline = 'middle';
        ctx.fillText(col.name, x + PAD_H, HEADER_H / 2 - 5);

        // Type chip
        var chipText = col.type || 'STR';
        ctx.font = FONT_CHIP;
        var chipW = ctx.measureText(chipText).width + 8;
        var chipX = x + PAD_H;
        var chipY = HEADER_H / 2 + 6;

        ctx.fillStyle = tok.chipBg;
        ctx.strokeStyle = tok.chipBorder;
        ctx.lineWidth = 1;
        roundRect(ctx, chipX - 1, chipY - 8, chipW + 2, 14, 3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = tok.chipText;
        ctx.textBaseline = 'middle';
        ctx.fillText(chipText, chipX + 3, chipY);

        // Health dot
        var dotColor = colHealthColor(state.dataset, ci, tok);
        var dotX = x + cw - 18;
        var dotY = HEADER_H / 2;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();

        ctx.restore();
        x += cw;
      });

      ctx.restore();
    }

    // ── Draw main grid ───────────────────────────────────────────────────
    function drawGrid() {
      var tok    = getTokens(isDarkMode());
      var ctx    = mCtx;
      var w      = state.width;
      var h      = state.height;
      var rows   = state.dataset.rows;
      var cols   = state.dataset.columns;
      var flags  = state.dataset.rowFlags || [];
      var dpr    = state.dpr;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = tok.bg;
      ctx.fillRect(0, 0, w, h);

      var firstRow = Math.max(0, Math.floor(state.scrollTop / ROW_H) - OVERDRAW);
      var lastRow  = Math.min(rows.length - 1, Math.ceil((state.scrollTop + h) / ROW_H) + OVERDRAW);

      for (var ri = firstRow; ri <= lastRow; ri++) {
        var y    = ri * ROW_H - state.scrollTop;
        var row  = rows[ri];
        var flag = flags[ri] || {};
        var isActive  = ri === state.activeRow;
        var isHovered = ri === state.hoverRow;

        // Row background
        var rowBg;
        if (isActive)       rowBg = tok.rowSelected;
        else if (isHovered) rowBg = tok.rowHover;
        else if (flag.error)   rowBg = tok.rowError;
        else if (flag.warning) rowBg = tok.rowWarning;
        else if (ri % 2 === 0) rowBg = tok.bg;
        else                   rowBg = tok.rowAlt;

        ctx.fillStyle = rowBg;
        ctx.fillRect(0, y, w, ROW_H);

        // Row flag stripe (left edge)
        if (flag.error) {
          ctx.fillStyle = tok.flagError;
          ctx.fillRect(0, y, FLAG_W, ROW_H);
        } else if (flag.warning) {
          ctx.fillStyle = tok.flagWarning;
          ctx.fillRect(0, y, FLAG_W, ROW_H);
        }

        // Row bottom divider
        ctx.fillStyle = tok.border;
        ctx.globalAlpha = 0.4;
        ctx.fillRect(0, y + ROW_H - 1, w, 1);
        ctx.globalAlpha = 1;

        // Cells
        var x = FLAG_W - state.scrollLeft;
        cols.forEach(function (col, ci) {
          var cw  = state.colWidths[ci];
          if (x + cw < 0 || x > w) { x += cw; return; }

          // Column divider
          ctx.fillStyle = tok.border;
          ctx.globalAlpha = 0.35;
          ctx.fillRect(x + cw - 1, y, 1, ROW_H);
          ctx.globalAlpha = 1;

          // Cell value
          var raw = row ? row[ci] : undefined;
          var txt = formatCell(raw);

          ctx.save();
          ctx.beginPath();
          ctx.rect(Math.max(FLAG_W, x + 1), y, cw - 2, ROW_H - 1);
          ctx.clip();

          if (txt === null) {
            ctx.font = FONT_EMPTY;
            ctx.fillStyle = tok.emptyText;
            ctx.textBaseline = 'middle';
            ctx.fillText('\u2014', x + PAD_H, y + ROW_H / 2);
          } else {
            ctx.font = FONT_CELL;
            ctx.fillStyle = (isActive && ci === state.activeCol) ? tok.primary : tok.text;
            ctx.textBaseline = 'middle';
            ctx.fillText(txt, x + PAD_H, y + ROW_H / 2);
          }

          ctx.restore();
          x += cw;
        });
      }

      // Empty state
      if (rows.length === 0) {
        ctx.font = '14px system-ui,-apple-system,sans-serif';
        ctx.fillStyle = tok.textMuted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No data loaded', w / 2, h / 2);
        ctx.textAlign = 'left';
      }

      ctx.restore();
    }

    // ── Rounded rect helper ──────────────────────────────────────────────
    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    // ── RAF render loop ──────────────────────────────────────────────────
    function renderLoop() {
      if (state.dirty) {
        drawHeader();
        drawGrid();
        state.dirty = false;
      }
      state.rafId = requestAnimationFrame(renderLoop);
    }

    // ── Scroll sync ──────────────────────────────────────────────────────
    vScroll.addEventListener('scroll', function () {
      state.scrollTop = vScroll.scrollTop;
      headerCanvas.style.left = '0px'; // header doesn't scroll vertically
      state.dirty = true;
    }, { passive: true });

    hScroll.addEventListener('scroll', function () {
      state.scrollLeft = hScroll.scrollLeft;
      state.dirty = true;
    }, { passive: true });

    // Also allow wheel on main canvas
    mainCanvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      vScroll.scrollTop  += e.deltaY;
      hScroll.scrollLeft += e.deltaX;
    }, { passive: false });

    // ── Mouse events ──────────────────────────────────────────────────────
    function rowFromY(y) {
      return Math.floor((y + state.scrollTop) / ROW_H);
    }

    function colFromX(x) {
      var cx = FLAG_W - state.scrollLeft;
      for (var ci = 0; ci < state.colWidths.length; ci++) {
        cx += state.colWidths[ci];
        if (x < cx) return ci;
      }
      return state.colWidths.length - 1;
    }

    mainCanvas.addEventListener('mousemove', function (e) {
      var rect = mainCanvas.getBoundingClientRect();
      var ri = rowFromY(e.clientY - rect.top);
      if (ri !== state.hoverRow) {
        state.hoverRow = ri;
        state.dirty = true;
      }
    });

    mainCanvas.addEventListener('mouseleave', function () {
      state.hoverRow = -1;
      state.dirty = true;
    });

    mainCanvas.addEventListener('click', function (e) {
      var rect = mainCanvas.getBoundingClientRect();
      var ri = rowFromY(e.clientY - rect.top);
      var ci = colFromX(e.clientX - rect.left);
      if (ri >= 0 && ri < state.dataset.rows.length) {
        state.activeRow = ri;
        state.activeCol = ci;
        state.dirty = true;
        var raw = state.dataset.rows[ri][ci];
        onCellFocus({ row: ri, col: ci, value: raw, colName: (state.dataset.columns[ci] || {}).name });
        onRowClick(state.dataset, ri);
      }
    });

    // Header hit-test helper (shared by dblclick + hover + touch)
    function colIndexFromHeaderEvent(e) {
      var rect = headerCanvas.getBoundingClientRect();
      var clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX
        : (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX
        : e.clientX;
      var x = clientX - rect.left + state.scrollLeft - FLAG_W;
      if (x < 0) return -1;
      var cx = 0;
      for (var ci = 0; ci < state.colWidths.length; ci++) {
        cx += state.colWidths[ci];
        if (x < cx) return ci;
      }
      return -1;
    }

    function headerColScreenRect(ci) {
      if (ci < 0 || ci >= state.colWidths.length) return null;
      var rect = headerCanvas.getBoundingClientRect();
      var left = FLAG_W - state.scrollLeft;
      for (var i = 0; i < ci; i++) left += state.colWidths[i];
      return {
        left: rect.left + left,
        top: rect.top,
        width: state.colWidths[ci],
        height: HEADER_H,
        right: rect.left + left + state.colWidths[ci],
        bottom: rect.top + HEADER_H
      };
    }

    var hoverCol = -1;
    var hoverTimer = null;
    var HOVER_DELAY_MS = 220;

    function clearHoverTimer() {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    }

    function emitHover(ci, e) {
      var col = state.dataset.columns && state.dataset.columns[ci];
      var name = col ? (typeof col === 'string' ? col : col.name) : ('col' + ci);
      var box = headerColScreenRect(ci);
      onColHover(ci, {
        colIdx: ci,
        colName: name,
        clientX: e && (e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX)) || 0,
        clientY: e && (e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY)) || 0,
        headerRect: box,
        dataset: state.dataset
      });
    }

    // Header hover → column profiler popover (desktop)
    headerCanvas.addEventListener('mousemove', function (e) {
      var ci = colIndexFromHeaderEvent(e);
      if (ci === hoverCol) return;
      hoverCol = ci;
      clearHoverTimer();
      if (ci < 0) {
        onColHoverEnd();
        return;
      }
      hoverTimer = setTimeout(function () {
        hoverTimer = null;
        if (hoverCol === ci) emitHover(ci, e);
      }, HOVER_DELAY_MS);
    });

    headerCanvas.addEventListener('mouseleave', function () {
      hoverCol = -1;
      clearHoverTimer();
      onColHoverEnd();
    });

    // Touch: tap header to pin profiler (mobile / PWA)
    headerCanvas.addEventListener('touchend', function (e) {
      var ci = colIndexFromHeaderEvent(e);
      if (ci < 0) return;
      // Do not preventDefault here — allow scroll; profiler is additive
      emitHover(ci, e);
    }, { passive: true });

    // Header double-click → rename column
    headerCanvas.addEventListener('dblclick', function (e) {
      var ci = colIndexFromHeaderEvent(e);
      if (ci >= 0) onColDblClick(ci);
    });

    // ── Keyboard navigation ───────────────────────────────────────────────
    mainCanvas.addEventListener('keydown', function (e) {
      var rows = state.dataset.rows;
      var cols = state.dataset.columns;
      if (!rows.length) return;

      var ar = state.activeRow < 0 ? 0 : state.activeRow;
      var ac = state.activeCol < 0 ? 0 : state.activeCol;

      switch (e.key) {
        case 'ArrowDown':  ar = Math.min(rows.length - 1, ar + 1); e.preventDefault(); break;
        case 'ArrowUp':    ar = Math.max(0, ar - 1); e.preventDefault(); break;
        case 'ArrowRight': ac = Math.min(cols.length - 1, ac + 1); e.preventDefault(); break;
        case 'ArrowLeft':  ac = Math.max(0, ac - 1); e.preventDefault(); break;
        case 'Home':       ar = 0; e.preventDefault(); break;
        case 'End':        ar = rows.length - 1; e.preventDefault(); break;
        default: return;
      }

      state.activeRow = ar;
      state.activeCol = ac;

      // Auto-scroll to keep active row visible
      var rowTop = ar * ROW_H;
      var rowBot = rowTop + ROW_H;
      if (rowTop < state.scrollTop)
        vScroll.scrollTop = rowTop;
      else if (rowBot > state.scrollTop + state.height)
        vScroll.scrollTop = rowBot - state.height;

      var raw = rows[ar][ac];
      onCellFocus({ row: ar, col: ac, value: raw, colName: (cols[ac] || {}).name });
      state.dirty = true;
    });

    // ── ResizeObserver ────────────────────────────────────────────────────
    var ro = new ResizeObserver(function () {
      resize();
    });
    ro.observe(container);

    // ── Init ──────────────────────────────────────────────────────────────
    function init(ds) {
      state.dataset   = ds;
      state.scrollTop = 0;
      state.scrollLeft= 0;
      state.activeRow = -1;
      state.activeCol = -1;
      state.hoverRow  = -1;
      initColWidths();
      resize();
      vScrollInner.style.height = state.totalH + 'px';
      hScrollInner.style.width  = state.totalW + 'px';
      state.dirty = true;
    }

    init(dataset);
    renderLoop();

    // ── Watch for dark mode changes ───────────────────────────────────────
    var darkObserver = new MutationObserver(function () {
      state.dirty = true;
    });
    darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // ── Public API ────────────────────────────────────────────────────────
    return {
      update: function (ds) {
        clearHoverTimer();
        hoverCol = -1;
        onColHoverEnd();
        init(ds);
      },
      destroy: function () {
        clearHoverTimer();
        hoverCol = -1;
        onColHoverEnd();
        if (state.rafId) cancelAnimationFrame(state.rafId);
        ro.disconnect();
        darkObserver.disconnect();
        container.innerHTML = '';
      },
      getHeaderColRect: headerColScreenRect,
      getActiveCell: function () {
        if (state.activeRow < 0) return null;
        return { row: state.activeRow, col: state.activeCol };
      },
      scrollToRow: function (idx) {
        vScroll.scrollTop = Math.max(0, idx * ROW_H - state.height / 2);
      },
      markDirty: function () { state.dirty = true; }
    };
  }

  return { mount: create };
})();
