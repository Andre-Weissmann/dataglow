// ============================================================
// DATAGLOW — Visualize Tab
// Plotly-powered drag-and-drop-style chart builder.
// ============================================================

import * as engine from '../app-shell/duckdb-engine.js';
import { state } from '../app-shell/state.js';

export async function renderChart(containerId, table, chartType, xCol, yCol) {
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
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS k, COUNT(*) AS v FROM ${table} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
    data = [{ type: 'pie', labels: rows.map(r => String(r.k)), values: rows.map(r => r.v), marker: { colors: ['#FF6B6B', '#0A7E8C', '#4A90D9', '#F5A623', '#E74C3C', '#2D2D2D'] } }];
    layout.xaxis = undefined; layout.yaxis = undefined;
  } else if (chartType === 'histogram') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS v FROM ${table} WHERE "${xCol}" IS NOT NULL`);
    data = [{ type: 'histogram', x: rows.map(r => r.v), marker: { color: '#FF6B6B' } }];
  } else if (chartType === 'box') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS v FROM ${table} WHERE "${xCol}" IS NOT NULL`);
    data = [{ type: 'box', y: rows.map(r => r.v), marker: { color: '#0A7E8C' } }];
  } else if (chartType === 'scatter') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS x, "${yCol}" AS y FROM ${table} WHERE "${xCol}" IS NOT NULL AND "${yCol}" IS NOT NULL LIMIT 5000`);
    data = [{ type: 'scattergl', mode: 'markers', x: rows.map(r => r.x), y: rows.map(r => r.y), marker: { color: '#FF6B6B', size: 6, opacity: 0.7 } }];
  } else if (chartType === 'line') {
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS x, AVG("${yCol}") AS y FROM ${table} GROUP BY 1 ORDER BY 1 LIMIT 500`);
    data = [{ type: 'scatter', mode: 'lines+markers', x: rows.map(r => r.x), y: rows.map(r => r.y), line: { color: '#FF6B6B', width: 2 } }];
  } else {
    // bar (default): aggregate y by x
    const { rows } = await engine.runQuery(`SELECT "${xCol}" AS x, ${yCol ? `AVG("${yCol}")` : 'COUNT(*)'} AS y FROM ${table} GROUP BY 1 ORDER BY 2 DESC LIMIT 25`);
    data = [{ type: 'bar', x: rows.map(r => String(r.x)), y: rows.map(r => r.y), marker: { color: '#FF6B6B' } }];
  }

  Plotly.newPlot(container, data, layout, { responsive: true, displaylogo: false });
}

export function exportChartPNG(containerId, filename) {
  const container = document.getElementById(containerId);
  Plotly.downloadImage(container, { format: 'png', filename: filename || 'dataglow-chart', width: 1200, height: 700 });
}
