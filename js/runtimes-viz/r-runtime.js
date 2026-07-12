// ============================================================
// DATAGLOW — R Tab (WebR 4.4 in-browser)
// ============================================================

import { state } from '../app-shell/state.js';
import * as engine from '../app-shell/duckdb-engine.js';

let loadPromise = null;
let jsonlitePromise = null;
let ggplot2Promise = null;

// Keep only valid PNG data-URL strings from a runR result's `images` field, so
// the UI renders exactly the plots R produced and nothing else. Pure — no DOM —
// so it is unit-testable, and matches the Python side's `extractImageDataUrls`.
export function extractImageDataUrls(images) {
  if (!Array.isArray(images)) return [];
  return images.filter(s => typeof s === 'string' && s.startsWith('data:image/'));
}

// Build honest, one-line notices for the R output based on which optional
// packages actually installed this session. Pure — no DOM — so the wiring layer
// can render them and tests can assert them. Historically both fallbacks were
// silent; these strings make them visible.
export function buildRBridgeNotices({ graphicsAvailable, hasJsonlite } = {}) {
  const notices = [];
  if (hasJsonlite === false) {
    notices.push('Using a simplified data bridge (a package failed to install).');
  }
  if (graphicsAvailable === false) {
    notices.push('ggplot2 could not be installed — base R plotting still works, but ggplot2 charts are unavailable.');
  }
  return notices;
}

// Draw each captured ImageBitmap onto a canvas and read it back as a base64 PNG
// data URL. Browser-only (runR only ever runs in the browser); tolerant of a
// bad bitmap so one failed plot never sinks the whole run.
async function bitmapsToDataUrls(images) {
  const urls = [];
  for (const bmp of images || []) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      urls.push(canvas.toDataURL('image/png'));
      if (typeof bmp.close === 'function') bmp.close();
    } catch (e) { /* skip a bitmap we could not rasterize */ }
  }
  return urls;
}

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
    try {
      // ggplot2 enables richer charting. Same best-effort pattern as jsonlite:
      // if it fails, base R graphics still work and the UI shows an honest note.
      await webR.installPackages(['ggplot2']);
      ggplot2Promise = true;
    } catch (e) {
      console.warn('Could not install ggplot2 in WebR; base R plotting still works, ggplot2 charts unavailable:', e);
      ggplot2Promise = false;
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
  const graphicsAvailable = ggplot2Promise === true;
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
      // captureGraphics uses WebR's canvas graphics device to capture base R and
      // ggplot2 plots as ImageBitmaps (result.images), which we rasterize to PNG.
      const result = await shelter.captureR(code, {
        withAutoprint: true,
        captureStreams: true,
        captureConditions: true,
        captureGraphics: true,
      });
      const output = result.output
        .filter(o => o.type === 'stdout' || o.type === 'stderr')
        .map(o => o.data)
        .join('\n');
      const images = await bitmapsToDataUrls(result.images);
      return { stdout: output, error: null, images, graphicsAvailable, hasJsonlite };
    } finally {
      await shelter.purge();
    }
  } catch (err) {
    return { stdout: '', error: err.message || String(err), images: [], graphicsAvailable, hasJsonlite };
  }
}
