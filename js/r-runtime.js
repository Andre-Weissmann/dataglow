// ============================================================
// DATAGLOW — R Tab (WebR 4.4 in-browser)
// ============================================================

import { state } from './state.js';
import * as engine from './duckdb-engine.js';

let loadPromise = null;
let jsonlitePromise = null;

export function initWebRRuntime(onStatus) {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onStatus?.('Downloading R runtime…');
    const { WebR } = await import('https://webr.r-wasm.org/latest/webr.mjs');
    const webR = new WebR();
    await webR.init();
    onStatus?.('Installing packages…');
    try {
      // jsonlite lets the dataglow_get_df() bridge deserialize table data into a data.frame.
      // WebR ships base R only — extra packages must be installed explicitly via webR's own
      // package manager (a wasm-compiled CRAN mirror), not via library()/install.packages().
      await webR.installPackages(['jsonlite']);
      jsonlitePromise = true;
    } catch (e) {
      console.warn('Could not install jsonlite in WebR, falling back to base-R bridge:', e);
      jsonlitePromise = false;
    }
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

  const hasJsonlite = jsonlitePromise === true;
  const bridgeSetup = hasJsonlite
    ? `
    library(jsonlite)
    dataglow_get_df <- function(name) {
      var <- paste0(".dataglow_json_", name)
      if (!exists(var, envir = .GlobalEnv)) stop(paste0("Table '", name, "' not loaded."))
      json_str <- get(var, envir = .GlobalEnv)
      jsonlite::fromJSON(json_str)
    }
  `
    : `
    # Minimal base-R JSON-array-of-objects parser used only if jsonlite could not be installed.
    # Handles the flat {"col": scalar, ...} row shape DATAGLOW emits — not a general JSON parser.
    .dataglow_parse_json_rows <- function(json_str) {
      rows_raw <- regmatches(json_str, gregexpr("\\\\{[^{}]*\\\\}", json_str))[[1]]
      if (length(rows_raw) == 0) return(data.frame())
      parse_row <- function(r) {
        pairs <- regmatches(r, gregexpr('"[^"]*"\\\\s*:\\\\s*(null|true|false|-?[0-9.]+(?:[eE][-+]?[0-9]+)?|"(?:[^"\\\\\\\\]|\\\\\\\\.)*")', r, perl = TRUE))[[1]]
        vals <- list()
        for (p in pairs) {
          kv <- regmatches(p, regexec('^"([^"]*)"\\\\s*:\\\\s*(.*)$', p, perl = TRUE))[[1]]
          key <- kv[2]; raw <- kv[3]
          if (raw == "null") { v <- NA }
          else if (raw == "true") { v <- TRUE }
          else if (raw == "false") { v <- FALSE }
          else if (grepl('^".*"$', raw)) { v <- substr(raw, 2, nchar(raw) - 1) }
          else { v <- suppressWarnings(as.numeric(raw)) }
          vals[[key]] <- v
        }
        vals
      }
      parsed <- lapply(rows_raw, parse_row)
      keys <- unique(unlist(lapply(parsed, names)))
      cols <- lapply(keys, function(k) sapply(parsed, function(r) if (is.null(r[[k]])) NA else r[[k]]))
      names(cols) <- keys
      as.data.frame(cols, stringsAsFactors = FALSE)
    }
    dataglow_get_df <- function(name) {
      var <- paste0(".dataglow_json_", name)
      if (!exists(var, envir = .GlobalEnv)) stop(paste0("Table '", name, "' not loaded."))
      json_str <- get(var, envir = .GlobalEnv)
      .dataglow_parse_json_rows(json_str)
    }
  `;

  try {
    await webR.evalRVoid(bridgeSetup);
    const shelter = await new webR.Shelter();
    try {
      const result = await shelter.captureR(code, { withAutoprint: true, captureStreams: true, captureConditions: true });
      const output = result.output
        .filter(o => o.type === 'stdout' || o.type === 'stderr')
        .map(o => o.data)
        .join('\n');
      return { stdout: output, error: null };
    } finally {
      await shelter.purge();
    }
  } catch (err) {
    return { stdout: '', error: err.message || String(err) };
  }
}
