// ============================================================
// DATAGLOW — Python Tab (Pyodide 3.12 in-browser)
// ============================================================

import { state } from './state.js';
import * as engine from './duckdb-engine.js';

let loadPromise = null;

export function initPyodideRuntime(onStatus) {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onStatus?.('Downloading Python runtime…');
    const pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/' });
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
  for (const ds of state.datasets) {
    const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 200000`);
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
    return { stdout: stdout.join(''), result: resultStr, error: null };
  } catch (err) {
    return { stdout: stdout.join(''), result: null, error: err.message };
  }
}
