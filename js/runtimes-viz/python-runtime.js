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

let loadPromise = null;
let loaderScriptPromise = null;

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
    onStatus?.('Loading pandas & numpy…');
    await pyodide.loadPackage(['pandas', 'numpy']);
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
    return { stdout: stdout.join(''), result: resultStr, error: null, truncated };
  } catch (err) {
    return { stdout: stdout.join(''), result: null, error: err.message, truncated };
  }
}
