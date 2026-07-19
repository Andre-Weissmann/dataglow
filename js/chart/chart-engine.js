/**
 * chart-engine.js — DataGlow Chart Layer (PR AI)
 *
 * Auto-generates charts from any dataset. No clicks required.
 * Picks the right chart type for the right data automatically.
 * Renders using Canvas 2D — zero dependencies.
 *
 * Public API:
 *   ChartEngine.renderAll(dataset, containerEl)  → renders all charts
 *   ChartEngine.clear(containerEl)               → removes all charts
 *
 * Chart types selected automatically:
 *   - Bar chart       — categorical column × numeric column (top 10 groups)
 *   - Histogram       — numeric column distribution
 *   - Donut chart     — low-cardinality categorical (≤ 8 unique values)
 *   - Line chart      — date/time column × numeric column (trend)
 */

export var ChartEngine = (function () {
  'use strict';

  // ── palette (matches DataGlow design tokens) ──────────────────────────────
  var COLORS = [
    '#20808D', '#A84B2F', '#1B474D', '#4F8FA3',
    '#944454', '#6DAA45', '#D19900', '#7A39BB'
  ];
  var C_GRID   = 'rgba(128,128,128,0.12)';
  var C_TEXT   = '#7A7974';
  var C_LABEL  = '#28251D';

  // ── helpers ───────────────────────────────────────────────────────────────
  function isNum(v) {
    return v !== null && v !== undefined && v !== '' &&
           !isNaN(parseFloat(v)) && isFinite(v);
  }
  function num(v) { return parseFloat(v); }
  function fmt(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    if (n === Math.floor(n)) return n.toLocaleString();
    return parseFloat(n.toFixed(2)).toString();
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function darkMode() {
    return document.documentElement.dataset.theme === 'dark';
  }
  function textColor() { return darkMode() ? '#CDCCCA' : '#28251D'; }
  function mutedColor() { return darkMode() ? '#797876' : '#7A7974'; }
  function gridColor()  { return darkMode() ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'; }
  function bgColor()    { return darkMode() ? '#1C1B19' : '#FFFFFF'; }

  function isDate(col, rows) {
    var sample = rows.slice(0, 8).map(function (r) { return String(r[col] || ''); });
    return sample.filter(function (v) {
      return /^\d{4}[-/]/.test(v) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(v);
    }).length >= 3;
  }
  function numericCols(dataset) {
    return dataset.columns.filter(function (col) {
      var sample = dataset.rows.slice(0, 20).filter(function (r) { return isNum(r[col]); });
      return sample.length >= 5;
    });
  }
  function categoricalCols(dataset) {
    return dataset.columns.filter(function (col) {
      var sample = dataset.rows.slice(0, 20).filter(function (r) { return isNum(r[col]); });
      return sample.length < 5;
    });
  }
  function dateCols(dataset) {
    return dataset.columns.filter(function (col) { return isDate(col, dataset.rows); });
  }
  function groupBy(rows, groupCol, valueCol, agg) {
    var g = {};
    rows.forEach(function (r) {
      var k = String(r[groupCol] == null ? '(blank)' : r[groupCol]).trim();
      if (!g[k]) g[k] = [];
      g[k].push(r[valueCol]);
    });
    return Object.keys(g).map(function (k) {
      var vals = g[k].filter(isNum).map(num);
      var v = agg === 'sum' ? vals.reduce(function (s, x) { return s + x; }, 0) :
              agg === 'count' ? g[k].length :
              vals.length ? vals.reduce(function (s, x) { return s + x; }, 0) / vals.length : 0;
      return { key: k, value: v, count: g[k].length };
    });
  }

  // ── canvas setup ─────────────────────────────────────────────────────────
  function makeCanvas(w, h) {
    var dpr = window.devicePixelRatio || 1;
    var c = document.createElement('canvas');
    c.width  = w * dpr;
    c.height = h * dpr;
    c.style.width  = w + 'px';
    c.style.height = h + 'px';
    var ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    return { canvas: c, ctx: ctx, w: w, h: h };
  }

  function makeCard(title, subtitle) {
    var card = document.createElement('div');
    card.className = 'chart-card';
    var hdr = document.createElement('div');
    hdr.className = 'chart-card-header';
    var ttl = document.createElement('div');
    ttl.className = 'chart-card-title';
    ttl.textContent = title;
    var sub = document.createElement('div');
    sub.className = 'chart-card-subtitle';
    sub.textContent = subtitle;
    hdr.appendChild(ttl);
    hdr.appendChild(sub);
    card.appendChild(hdr);
    return card;
  }

  // ── draw helpers ──────────────────────────────────────────────────────────
  function drawGrid(ctx, x, y, w, h, steps) {
    ctx.strokeStyle = gridColor();
    ctx.lineWidth = 1;
    for (var i = 0; i <= steps; i++) {
      var yy = y + h - (h / steps) * i;
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
    }
  }

  function drawAxisLabel(ctx, text, x, y, align, color) {
    ctx.fillStyle = color || mutedColor();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = align || 'center';
    ctx.fillText(text, x, y);
  }

  // ── BAR CHART ─────────────────────────────────────────────────────────────
  function renderBar(dataset, groupCol, valueCol, agg) {
    var groups = groupBy(dataset.rows, groupCol, valueCol, agg);
    groups.sort(function (a, b) { return b.value - a.value; });
    var top = groups.slice(0, 10);
    if (!top.length) return null;

    var aggWord = agg === 'count' ? 'Count' : agg === 'avg' ? 'Avg ' : 'Total ';
    var title   = aggWord + valueCol.replace(/_/g, ' ');
    var sub     = 'by ' + groupCol.replace(/_/g, ' ') + (groups.length > 10 ? ' (top 10)' : '');
    var card    = makeCard(title, sub);

    var W = 340, H = 220, PAD = { t: 20, r: 16, b: 48, l: 52 };
    var cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
    var rig = makeCanvas(W, H);
    var ctx = rig.ctx;

    ctx.fillStyle = bgColor();
    ctx.fillRect(0, 0, W, H);

    var maxV = Math.max.apply(null, top.map(function (g) { return g.value; })) || 1;
    var steps = 4;
    drawGrid(ctx, PAD.l, PAD.t, cw, ch, steps);

    // Y axis labels
    for (var i = 0; i <= steps; i++) {
      var v = maxV * (i / steps);
      var yy = PAD.t + ch - (ch / steps) * i;
      drawAxisLabel(ctx, fmt(v), PAD.l - 6, yy + 4, 'right');
    }

    var barW = Math.floor(cw / top.length) - 4;
    barW = clamp(barW, 6, 48);

    top.forEach(function (g, i) {
      var bh = Math.max(2, (g.value / maxV) * ch);
      var bx = PAD.l + (cw / top.length) * i + (cw / top.length - barW) / 2;
      var by = PAD.t + ch - bh;

      // Bar with rounded top
      var color = COLORS[i % COLORS.length];
      ctx.fillStyle = color;
      ctx.beginPath();
      var r = Math.min(4, barW / 2);
      ctx.moveTo(bx + r, by);
      ctx.lineTo(bx + barW - r, by);
      ctx.quadraticCurveTo(bx + barW, by, bx + barW, by + r);
      ctx.lineTo(bx + barW, by + bh);
      ctx.lineTo(bx, by + bh);
      ctx.lineTo(bx, by + r);
      ctx.quadraticCurveTo(bx, by, bx + r, by);
      ctx.closePath();
      ctx.fill();

      // X label — truncate
      var lbl = g.key.length > 8 ? g.key.slice(0, 7) + '…' : g.key;
      var cx2 = bx + barW / 2;
      ctx.save();
      ctx.translate(cx2, PAD.t + ch + 10);
      ctx.rotate(-Math.PI / 4);
      drawAxisLabel(ctx, lbl, 0, 0, 'right');
      ctx.restore();
    });

    card.appendChild(rig.canvas);
    return card;
  }

  // ── HISTOGRAM ─────────────────────────────────────────────────────────────
  function renderHistogram(dataset, col) {
    var vals = dataset.rows.map(function (r) { return r[col]; }).filter(isNum).map(num);
    if (vals.length < 5) return null;

    var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
    if (minV === maxV) return null;

    var bins = Math.min(20, Math.ceil(Math.sqrt(vals.length)));
    var binW = (maxV - minV) / bins;
    var counts = new Array(bins).fill(0);
    vals.forEach(function (v) {
      var i = Math.min(bins - 1, Math.floor((v - minV) / binW));
      counts[i]++;
    });

    var card = makeCard('Distribution of ' + col.replace(/_/g, ' '),
                        vals.length.toLocaleString() + ' values');

    var W = 340, H = 200, PAD = { t: 16, r: 16, b: 40, l: 48 };
    var cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
    var rig = makeCanvas(W, H);
    var ctx = rig.ctx;

    ctx.fillStyle = bgColor();
    ctx.fillRect(0, 0, W, H);

    var maxC = Math.max.apply(null, counts) || 1;
    drawGrid(ctx, PAD.l, PAD.t, cw, ch, 4);

    var bw = cw / bins;
    counts.forEach(function (c, i) {
      var bh = (c / maxC) * ch;
      var bx = PAD.l + i * bw;
      var by = PAD.t + ch - bh;
      ctx.fillStyle = COLORS[0];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(bx + 1, by, bw - 2, bh);
      ctx.globalAlpha = 1;
    });

    // X axis: min, mid, max
    [[0, minV], [Math.floor(bins / 2), (minV + maxV) / 2], [bins, maxV]].forEach(function (pair) {
      var xi = PAD.l + (pair[0] / bins) * cw;
      drawAxisLabel(ctx, fmt(pair[1]), xi, PAD.t + ch + 16, 'center');
    });

    // Y axis
    [0, Math.ceil(maxC / 2), maxC].forEach(function (c) {
      var yi = PAD.t + ch - (c / maxC) * ch;
      drawAxisLabel(ctx, c.toString(), PAD.l - 6, yi + 4, 'right');
    });

    card.appendChild(rig.canvas);
    return card;
  }

  // ── DONUT CHART ───────────────────────────────────────────────────────────
  function renderDonut(dataset, col) {
    var freq = {};
    dataset.rows.forEach(function (r) {
      var k = String(r[col] == null ? '(blank)' : r[col]).trim();
      freq[k] = (freq[k] || 0) + 1;
    });
    var entries = Object.keys(freq).map(function (k) { return { key: k, n: freq[k] }; });
    entries.sort(function (a, b) { return b.n - a.n; });
    if (entries.length < 2 || entries.length > 8) return null;

    var total = dataset.rows.length;
    var card  = makeCard(col.replace(/_/g, ' ') + ' breakdown',
                         entries.length + ' categories');

    var W = 340, H = 220;
    var rig = makeCanvas(W, H);
    var ctx = rig.ctx;

    ctx.fillStyle = bgColor();
    ctx.fillRect(0, 0, W, H);

    var cx = 110, cy = H / 2, outerR = 80, innerR = 46;
    var start = -Math.PI / 2;
    entries.forEach(function (e, i) {
      var sweep = (e.n / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, start, start + sweep);
      ctx.closePath();
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.fill();
      start += sweep;
    });

    // Inner hole
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = bgColor();
    ctx.fill();

    // Center label
    ctx.fillStyle = textColor();
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(entries.length.toString(), cx, cy + 2);
    ctx.fillStyle = mutedColor();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('types', cx, cy + 16);

    // Legend
    var lx = 200, ly = cy - (entries.length * 18) / 2;
    entries.forEach(function (e, i) {
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.fillRect(lx, ly + i * 20, 10, 10);
      ctx.fillStyle = textColor();
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      var lbl = e.key.length > 14 ? e.key.slice(0, 13) + '…' : e.key;
      ctx.fillText(lbl + '  ' + Math.round(e.n / total * 100) + '%', lx + 14, ly + i * 20 + 9);
    });

    card.appendChild(rig.canvas);
    return card;
  }

  // ── LINE CHART (trend) ────────────────────────────────────────────────────
  function renderLine(dataset, dateCol, valueCol) {
    var pairs = dataset.rows.map(function (r) {
      return { d: new Date(r[dateCol]), v: r[valueCol] };
    }).filter(function (p) { return !isNaN(p.d) && isNum(p.v); });
    pairs.sort(function (a, b) { return a.d - b.d; });
    if (pairs.length < 3) return null;

    // Downsample to max 60 points
    var step = Math.max(1, Math.floor(pairs.length / 60));
    var pts  = pairs.filter(function (_, i) { return i % step === 0; });

    var card = makeCard(valueCol.replace(/_/g, ' ') + ' over time',
                        'by ' + dateCol.replace(/_/g, ' '));

    var W = 340, H = 200, PAD = { t: 16, r: 16, b: 36, l: 52 };
    var cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
    var rig = makeCanvas(W, H);
    var ctx = rig.ctx;

    ctx.fillStyle = bgColor();
    ctx.fillRect(0, 0, W, H);

    var minV = Math.min.apply(null, pts.map(function (p) { return num(p.v); }));
    var maxV = Math.max.apply(null, pts.map(function (p) { return num(p.v); }));
    var range = maxV - minV || 1;
    drawGrid(ctx, PAD.l, PAD.t, cw, ch, 4);

    // Area fill
    var color = COLORS[0];
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var px = PAD.l + (i / (pts.length - 1)) * cw;
      var py = PAD.t + ch - ((num(p.v) - minV) / range) * ch;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    // Close area
    ctx.lineTo(PAD.l + cw, PAD.t + ch);
    ctx.lineTo(PAD.l, PAD.t + ch);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + ch);
    grad.addColorStop(0, color + '40');
    grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    pts.forEach(function (p, i) {
      var px = PAD.l + (i / (pts.length - 1)) * cw;
      var py = PAD.t + ch - ((num(p.v) - minV) / range) * ch;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // Y axis
    [minV, (minV + maxV) / 2, maxV].forEach(function (v, i) {
      var yi = PAD.t + ch - ((v - minV) / range) * ch;
      drawAxisLabel(ctx, fmt(v), PAD.l - 6, yi + 4, 'right');
    });

    // X axis: first and last date
    var fmtDate = function (d) {
      return (d.getMonth() + 1) + '/' + d.getFullYear().toString().slice(2);
    };
    drawAxisLabel(ctx, fmtDate(pts[0].d), PAD.l, PAD.t + ch + 16, 'left');
    drawAxisLabel(ctx, fmtDate(pts[pts.length - 1].d), PAD.l + cw, PAD.t + ch + 16, 'right');

    card.appendChild(rig.canvas);
    return card;
  }

  // ── main render ───────────────────────────────────────────────────────────
  function renderAll(dataset, containerEl) {
    containerEl.innerHTML = '';

    if (!dataset || !dataset.rows || dataset.rows.length < 2) {
      var empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'Drop a dataset to see charts.';
      containerEl.appendChild(empty);
      return;
    }

    var numCols_ = numericCols(dataset);
    var catCols_ = categoricalCols(dataset);
    var dateCols_ = dateCols(dataset);
    var charts = [];

    // 1. Trend lines — date × numeric
    dateCols_.forEach(function (dc) {
      numCols_.slice(0, 2).forEach(function (nc) {
        var card = renderLine(dataset, dc, nc);
        if (card) charts.push(card);
      });
    });

    // 2. Bar charts — categorical × numeric (top 3 pairs)
    var barCount = 0;
    catCols_.forEach(function (cc) {
      if (barCount >= 3) return;
      var uniq = new Set(dataset.rows.map(function (r) { return r[cc]; })).size;
      if (uniq < 2 || uniq > 30) return;
      numCols_.slice(0, 1).forEach(function (nc) {
        var agg = /rate|pct|percent|ratio/i.test(nc) ? 'avg' : 'sum';
        var card = renderBar(dataset, cc, nc, agg);
        if (card) { charts.push(card); barCount++; }
      });
    });

    // 3. Count bar — categorical with no numeric pair
    if (barCount === 0 && catCols_.length) {
      var cc = catCols_[0];
      var card = renderBar(dataset, cc, cc, 'count');
      if (card) charts.push(card);
    }

    // 4. Donut — low-cardinality categoricals
    catCols_.slice(0, 2).forEach(function (cc) {
      var uniq = new Set(dataset.rows.map(function (r) { return r[cc]; })).size;
      if (uniq >= 2 && uniq <= 8) {
        var card = renderDonut(dataset, cc);
        if (card) charts.push(card);
      }
    });

    // 5. Histograms — numeric distributions
    numCols_.slice(0, 3).forEach(function (nc) {
      var card = renderHistogram(dataset, nc);
      if (card) charts.push(card);
    });

    if (!charts.length) {
      var empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'No chartable patterns found in this dataset.';
      containerEl.appendChild(empty);
      return;
    }

    charts.forEach(function (c) { containerEl.appendChild(c); });
  }

  function clear(containerEl) {
    if (containerEl) containerEl.innerHTML = '';
  }

  return { renderAll: renderAll, clear: clear };
})();
