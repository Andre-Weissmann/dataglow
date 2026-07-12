// ============================================================
// DATAGLOW — Python Tab (Pyodide 3.12 in-browser)
// ============================================================

import { state } from '../app-shell/state.js';
import * as engine from '../app-shell/duckdb-engine.js';

const PYODIDE_CDN_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';

// Each Python cell run re-serializes every loaded DuckDB table to JSON and
// rebuilds it as a pandas DataFrame. That round-trip is O(rows), so very large
// tables are capped at this many rows for the Python bridge specifically — a
// deliberate technical limit to keep the browser tab responsive. The cap used
// to be silent; it is now surfaced to the user (see computeBridgeTruncation).
export const PY_BRIDGE_ROW_LIMIT = 200000;

// Given the loaded datasets, return a descriptor for each one whose row count
// exceeds the Python-bridge limit, so the UI can warn that Python sees a
// truncated view. Pure function — no DOM, no engine — so it is unit-testable.
export function computeBridgeTruncation(datasets, limit = PY_BRIDGE_ROW_LIMIT) {
  return (datasets || [])
    .filter(ds => Number(ds?.rowCount ?? 0) > limit)
    .map(ds => ({ table: ds.table, name: ds.name || ds.table, rowCount: Number(ds.rowCount), limit }));
}

// Keep only valid PNG data-URL strings from a runPython result's `images` field,
// so the UI can render exactly the figures matplotlib produced and nothing else.
// Pure function — no DOM — so it is unit-testable, matching the R side's shape.
export function extractImageDataUrls(images) {
  if (!Array.isArray(images)) return [];
  return images.filter(s => typeof s === 'string' && s.startsWith('data:image/'));
}

let loadPromise = null;
let loaderScriptPromise = null;
// Whether matplotlib loaded successfully this session. Defaults false so a
// failed/absent matplotlib load leaves Python fully working as text-only.
let matplotlibReady = false;

// Pyodide is a large runtime, so its loader is fetched from the CDN on demand —
// only when the Python tab is first opened — rather than on every page load.
function loadPyodideScript() {
  if (typeof loadPyodide === 'function') return Promise.resolve();
  if (loaderScriptPromise) return loaderScriptPromise;
  loaderScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${PYODIDE_CDN_BASE}pyodide.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load the Pyodide runtime from the CDN.'));
    document.head.appendChild(script);
  });
  return loaderScriptPromise;
}

export function initPyodideRuntime(onStatus) {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onStatus?.('Downloading Python runtime…');
    await loadPyodideScript();
    const pyodide = await loadPyodide({ indexURL: PYODIDE_CDN_BASE });
    onStatus?.('Loading pandas, numpy & matplotlib…');
    await pyodide.loadPackage(['pandas', 'numpy']);
    // matplotlib is loaded lazily here — on first Python-tab use, alongside
    // pandas/numpy — so charting works without slowing the core app load. It
    // uses the headless 'AGG' backend so figures render to an in-memory buffer
    // (no display), the documented Pyodide-in-browser capture pattern. If the
    // package fails to load, Python degrades cleanly to text-only.
    try {
      await pyodide.loadPackage(['matplotlib']);
      await pyodide.runPythonAsync(`
import matplotlib
matplotlib.use('AGG')
import matplotlib.pyplot as plt
import io as _dg_io, base64 as _dg_base64

def _dataglow_capture_figures():
    imgs = []
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = _dg_io.BytesIO()
        fig.savefig(buf, format='png', bbox_inches='tight', dpi=100)
        buf.seek(0)
        imgs.append('data:image/png;base64,' + _dg_base64.b64encode(buf.read()).decode('ascii'))
    plt.close('all')
    return imgs
`);
      matplotlibReady = true;
    } catch (e) {
      console.warn('Could not load matplotlib in Pyodide; Python stays text-only:', e);
      matplotlibReady = false;
    }
    // Bridge object: dataglow.get_df('table') pulls DuckDB table into pandas via JSON
    await pyodide.runPythonAsync(`
import pandas as pd
import numpy as np
import json as _json

class _DataglowBridge:
    def __init__(self):
        self._tables = {}
    def _register(self, name, json_str):
        rows = _json.loads(json_str)
        self._tables[name] = pd.DataFrame(rows)
    def get_df(self, name):
        if name not in self._tables:
            raise ValueError(f"Table '{name}' not loaded. Load it from the sidebar first, or check the name.")
        return self._tables[name].copy()

dataglow = _DataglowBridge()
    `);
    state.pyodide = pyodide;
    onStatus?.('ready');
    return pyodide;
  })();
  return loadPromise;
}

// Render any matplotlib figures the just-run code created into base64 PNG data
// URLs, then close them so repeated runs never leak or duplicate figures.
// Returns [] when matplotlib is unavailable or nothing was plotted.
async function capturePyFigures(pyodide) {
  if (!matplotlibReady) return [];
  try {
    const proxy = await pyodide.runPythonAsync('_dataglow_capture_figures()');
    if (!proxy) return [];
    const arr = typeof proxy.toJs === 'function' ? proxy.toJs() : Array.from(proxy);
    if (typeof proxy.destroy === 'function') proxy.destroy();
    return extractImageDataUrls(arr);
  } catch (e) {
    return [];
  }
}

export async function runPython(code, activeTableName) {
  const pyodide = state.pyodide;
  if (!pyodide) throw new Error('Python runtime not ready yet.');

  // Push all loaded datasets into the bridge so `dataglow.get_df(name)` works for any of them
  const truncated = computeBridgeTruncation(state.datasets);
  for (const ds of state.datasets) {
    const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT ${PY_BRIDGE_ROW_LIMIT}`);
    const jsonStr = JSON.stringify(rows);
    pyodide.globals.set('_tmp_json', jsonStr);
    pyodide.globals.set('_tmp_name', ds.table);
    await pyodide.runPythonAsync(`dataglow._register(_tmp_name, _tmp_json)`);
  }

  let stdout = [];
  pyodide.setStdout({ batched: (s) => stdout.push(s) });
  pyodide.setStderr({ batched: (s) => stdout.push('ERR: ' + s) });

  try {
    let result = await pyodide.runPythonAsync(code);
    // Try to get a repr of the last expression for notebook-style display
    let resultStr = null;
    if (result !== undefined && result !== null) {
      try { resultStr = result.toString(); } catch (e) { /* ignore */ }
    }
    const images = await capturePyFigures(pyodide);
    return { stdout: stdout.join(''), result: resultStr, error: null, truncated, images };
  } catch (err) {
    // Capture any figures drawn before the error too, so a partial plot still shows.
    const images = await capturePyFigures(pyodide);
    return { stdout: stdout.join(''), result: null, error: err.message, truncated, images };
  }
}
