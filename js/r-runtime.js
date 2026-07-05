// ============================================================
// DATAGLOW — R Tab (WebR 4.4 in-browser)
// ============================================================

import { state } from './state.js';
import * as engine from './duckdb-engine.js';

let loadPromise = null;

export function initWebRRuntime(onStatus) {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onStatus?.('Downloading R runtime…');
    const { WebR } = await import('https://webr.r-wasm.org/latest/webr.mjs');
    const webR = new WebR();
    await webR.init();
    onStatus?.('ready');
    state.webR = webR;
    return webR;
  })();
  return loadPromise;
}

export async function runR(code) {
  const webR = state.webR;
  if (!webR) throw new Error('R runtime not ready yet.');

  // Register a helper: dataglow_get_df(name) reads a JSON blob written by JS into an R data.frame
  for (const ds of state.datasets) {
    const { rows } = await engine.runQuery(`SELECT * FROM ${ds.table} LIMIT 200000`);
    await webR.objs.globalEnv.bind(`.dataglow_json_${ds.table}`, JSON.stringify(rows));
  }
  const bridgeSetup = `
    dataglow_get_df <- function(name) {
      var <- paste0(".dataglow_json_", name)
      if (!exists(var, envir = .GlobalEnv)) stop(paste0("Table '", name, "' not loaded."))
      json_str <- get(var, envir = .GlobalEnv)
      if (!requireNamespace("jsonlite", quietly = TRUE)) {
        stop("jsonlite not available in this WebR build")
      }
      jsonlite::fromJSON(json_str)
    }
  `;

  try {
    await webR.evalRVoid(`try(library(jsonlite), silent=TRUE)`);
  } catch (e) { /* jsonlite may not be preinstalled; user code should handle gracefully */ }

  try {
    await webR.evalRVoid(bridgeSetup);
    const shelter = await new webR.Shelter();
    try {
      const result = await shelter.captureR(code, { withAutoprint: true, captureStreams: true, captureConditions: true });
      const output = result.output
        .filter(o => o.type === 'stdout' || o.type === 'stderr')
        .map(o => o.data)
        .join('\n');
      const errors = result.output.filter(o => o.type === 'stderr' || o.type === 'error').length > 0;
      return { stdout: output, error: null };
    } finally {
      await shelter.purge();
    }
  } catch (err) {
    return { stdout: '', error: err.message || String(err) };
  }
}
