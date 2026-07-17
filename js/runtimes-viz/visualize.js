// ============================================================
// DATAGLOW — Visualize Tab
// Plotly-powered drag-and-drop-style chart builder.
// ============================================================

import * as engine from '../app-shell/duckdb-engine.js';
import { state } from '../app-shell/state.js';

/**
 * Combine a chart's existing WHERE condition (may be empty) with an optional
 * extra raw-SQL boolean clause, ANDing them together. Returns a full
 * " WHERE ..." fragment (with a leading space) or '' when both are empty, so
 * it can be spliced straight after "FROM table" in every query below.
 *
 * Backward compatibility: when `whereClause` is undefined/empty this returns
 * exactly the original condition (or '' when there was none), so every existing
 * 5-argument renderChart call produces byte-identical SQL to before.
 *
 * `whereClause` is trusted raw SQL supplied by the caller. Glow Canvas builds it
 * from an activeFilter and escapes the value (doubling single quotes) before
 * passing it here; nothing user-typed reaches this unescaped.
 * @param {string} existingCondition  the query's own condition, without "WHERE"
 * @param {string} [whereClause]      optional extra boolean clause to AND in
 * @returns {string}
 */
export function combineWhere(existingCondition, whereClause) {
  const parts = [];
  if (existingCondition && String(existingCondition).trim()) parts.push(String(existingCondition).trim());
  if (whereClause && String(whereClause).trim()) parts.push(String(whereClause).trim());
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

/**
 * @param {string} containerId
 * @param {string} table
 * @param {string} chartType
 * @param {string} xCol
 * @param {string} yCol
 * @param {string} [whereClause]  optional raw-SQL boolean clause ANDed into the
 *   chart's query (used by Glow Canvas cross-filtering). Empty/undefined = no
 *   added filter, so existing single-chart callers are unaffected.
 * @param {object} [opts]
 * @param {(table:string, column:string, value:string)=>void} [opts.onPointClick]
 *   optional, generic click callback. When supplied, clicking a categorical
 *   point (bar/line/histogram x-category, or a pie slice label) invokes it with
 *   the clicked category so a caller (e.g. Glow Canvas) can cross-filter. The
 *   Visualize tab passes nothing and is completely unaffected.
 */
export async function renderChart(containerId, table, chartType, xCol, yCol, whereClause, opts = {}) {
  const container = document.getElementById(containerId);
  const isDark = state.theme === 'dark';
  const paperColor = isDark ? '#122436' : '#FFFFFF';
  const fontColor = isDark ? '#EAF1F5' : '#2D2D2D';
  const gridColor = isDark ? '#26404F' : '#EAE8E4';

  let data, layout = {
    paper_bgcolor: paperColor,
    plot_bgcolor: paperColor,
    font: { color: fontColor, family: 'Inter, sans-serif' },
    margin: { t: 20, r: 20, b: 60, l: 60 },
    xaxis: { gridcolor: gridColor, title: xCol },
    yaxis: { gridcolor: gridColor, title: yCol },
    colorway: ['#FF6B6B', '#0A7E8C', '#4A90D9', '#F5A623', '#E74C3C'],
  };

  if (chartType === 'pie') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS k, COUNT(*) AS v FROM ${table}${combineWhere('', whereClause)} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
    data = [{ type: 'pie', labels: rows.map(r => String(r.k)), values: rows.map(r => r.v), marker: { colors: ['#FF6B6B', '#0A7E8C', '#4A90D9', '#F5A623', '#E74C3C', '#2D2D2D'] } }];
    layout.xaxis = undefined; layout.yaxis = undefined;
  } else if (chartType === 'histogram') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS v FROM ${table}${combineWhere(`"${xCol}" IS NOT NULL`, whereClause)}`);
    data = [{ type: 'histogram', x: rows.map(r => r.v), marker: { color: '#FF6B6B' } }];
  } else if (chartType === 'box') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS v FROM ${table}${combineWhere(`"${xCol}" IS NOT NULL`, whereClause)}`);
    data = [{ type: 'box', y: rows.map(r => r.v), marker: { color: '#0A7E8C' } }];
  } else if (chartType === 'scatter') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS x, "${yCol}" AS y FROM ${table}${combineWhere(`"${xCol}" IS NOT NULL AND "${yCol}" IS NOT NULL`, whereClause)} LIMIT 5000`);
    data = [{ type: 'scattergl', mode: 'markers', x: rows.map(r => r.x), y: rows.map(r => r.y), marker: { color: '#FF6B6B', size: 6, opacity: 0.7 } }];
  } else if (chartType === 'line') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS x, AVG("${yCol}") AS y FROM ${table}${combineWhere('', whereClause)} GROUP BY 1 ORDER BY 1 LIMIT 500`);
    data = [{ type: 'scatter', mode: 'lines+markers', x: rows.map(r => r.x), y: rows.map(r => r.y), line: { color: '#FF6B6B', width: 2 } }];
  } else {
    // bar (default): aggregate y by x
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS x, ${yCol ? `AVG("${yCol}")` : 'COUNT(*)'} AS y FROM ${table}${combineWhere('', whereClause)} GROUP BY 1 ORDER BY 2 DESC LIMIT 25`);
    data = [{ type: 'bar', x: rows.map(r => String(r.x)), y: rows.map(r => r.y), marker: { color: '#FF6B6B' } }];
  }

  Plotly.newPlot(container, data, layout, { responsive: true, displaylogo: false });

  // Generic, optional click-to-filter. Only wired when a caller passes
  // opts.onPointClick — the single-chart Visualize tab passes nothing, so its
  // behavior is unchanged. Scatter and box are deliberately EXCLUDED: their x
  // axis is continuous (a raw numeric coordinate / distribution), so equality-
  // filtering on one clicked point isn't a meaningful cross-filter — a range
  // brush would be the right tool there, and that's a future batch.
  const onPointClick = typeof opts.onPointClick === 'function' ? opts.onPointClick : null;
  if (onPointClick && container && typeof container.on === 'function'
      && chartType !== 'scatter' && chartType !== 'box') {
    container.on('plotly_click', (ev) => {
      const pt = ev && Array.isArray(ev.points) ? ev.points[0] : null;
      if (!pt) return;
      // pie identifies the clicked wedge by label; bar/line/histogram by x.
      const value = chartType === 'pie' ? pt.label : pt.x;
      if (value === undefined || value === null) return;
      // The filtered column is the x column for all of these chart types.
      onPointClick(table, xCol, String(value));
    });
  }
}

export function exportChartPNG(containerId, filename) {
  const container = document.getElementById(containerId);
  Plotly.downloadImage(container, { format: 'png', filename: filename || 'dataglow-chart', width: 1200, height: 700 });
}
