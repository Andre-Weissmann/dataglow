// ============================================================
// DATAGLOW — R Tab (WebR 4.4 in-browser)
// ============================================================

import { state } from '../app-shell/state.js';
import * as engine from '../app-shell/duckdb-engine.js';
import { isEnabled } from '../build/build-flags.js';
import { registerObject } from '../app-shell/object-space.js';
import * as provenance from '../provenance/provenance.js';
import {
  materializeWritebackTables,
  buildRuntimeWritebackDeps,
} from '../polyglot/polyglot-writeback.js';

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
    notices.push('ggplot2 could not be installed. Base R plotting still works, but ggplot2 charts are unavailable.');
  }
  return notices;
}

// Whether this session may fetch R packages at all.
//
// WHY THIS EXISTS. Installing a WebR package is a network request to the WebR
// binary repository, and until this check was added the R session made two of
// them at startup with nothing consulted first. Air-Gap mode promises that
// nothing leaves the machine, so a mode that let this through was not enforcing
// its own claim. The decision itself lives in js/polyglot/r-deepen.js as a pure
// function; this reads the mode and asks it.
//
// Blocked is not an error. Base R is complete, the session starts, and the
// recipes needing a package are listed as unavailable with the reason.
export function rPackageInstallAllowed() {
  try {
    const ag = typeof window !== 'undefined' ? window.DataGlowAirGap : null;
    if (ag && typeof ag.isAirGapActive === 'function' && ag.isAirGapActive() === true) {
      return { allowed: false, blockedBy: 'air_gap' };
    }
  } catch (_e) { /* no air-gap module in this build means no air-gap mode */ }
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { allowed: false, blockedBy: 'offline' };
    }
  } catch (_e2) {}
  return { allowed: true, blockedBy: '' };
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

// ------------------------------------------------------------
// Roadmap Step 8 (polyglotWriteback): dataglow_save_df(name, df)
// ------------------------------------------------------------
// Only evaluated into the R session when the flag is on. save_df stages each
// data.frame in a private environment; after the user's code finishes WITHOUT
// error the JS side collects them as column-oriented JSON via a small base-R
// serializer (no jsonlite dependency, so it also works in Air-Gap / offline
// sessions where R packages are never fetched) and hands them to the shared
// materializer. Factors/Dates/POSIXct become character/ISO; numeric, integer,
// logical and NA are preserved; NaN/Inf become null.
export const R_WRITEBACK_SETUP = String.raw`
.dataglow_saved_tables <- new.env(parent = emptyenv())
dataglow_save_df <- function(name, df) {
  if (!is.character(name) || length(name) != 1L || is.na(name)) {
    stop("dataglow_save_df(name, df): name must be a single string.")
  }
  if (!grepl("^[A-Za-z_][A-Za-z0-9_]{0,62}$", trimws(name))) {
    stop(paste0("dataglow_save_df: invalid table name '", name, "'. Use letters, digits and underscores only (max 63 chars)."))
  }
  df <- as.data.frame(df, stringsAsFactors = FALSE)
  if (ncol(df) == 0L) stop("dataglow_save_df: the data.frame has 0 columns.")
  if (anyDuplicated(tolower(names(df)))) stop("dataglow_save_df: duplicate column names; rename them before saving.")
  for (i in seq_along(df)) {
    col <- df[[i]]
    if (is.factor(col)) {
      df[[i]] <- as.character(col)
    } else if (inherits(col, "Date")) {
      df[[i]] <- format(col, "%Y-%m-%d")
    } else if (inherits(col, "POSIXt")) {
      df[[i]] <- format(as.POSIXct(col), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
    } else if (is.list(col)) {
      stop(paste0("dataglow_save_df: column '", names(df)[i], "' is a list column; flatten it first."))
    } else if (!(is.numeric(col) || is.logical(col) || is.character(col))) {
      df[[i]] <- as.character(col)
    }
  }
  assign(trimws(name), df, envir = .dataglow_saved_tables)
  invisible(NULL)
}
.dataglow_json_str <- function(x) {
  if (length(x) == 0L) return(character(0))
  x <- enc2utf8(as.character(x))
  x <- gsub("\\", "\\\\", x, fixed = TRUE)
  x <- gsub("\"", "\\\"", x, fixed = TRUE)
  x <- gsub("\n", "\\n", x, fixed = TRUE)
  x <- gsub("\r", "\\r", x, fixed = TRUE)
  x <- gsub("\t", "\\t", x, fixed = TRUE)
  x <- gsub("[[:cntrl:]]", "", x)
  paste0("\"", x, "\"")
}
.dataglow_json_col <- function(col) {
  if (length(col) == 0L) return("[]")
  if (is.logical(col)) {
    v <- ifelse(is.na(col), "null", ifelse(col, "true", "false"))
  } else if (is.integer(col)) {
    v <- ifelse(is.na(col), "null", as.character(col))
  } else if (is.numeric(col)) {
    v <- ifelse(is.finite(col), sprintf("%.17g", col), "null")
  } else {
    v <- .dataglow_json_str(col)
    v[is.na(col)] <- "null"
  }
  paste0("[", paste(v, collapse = ","), "]")
}
.dataglow_collect_saves <- function() {
  nms <- ls(.dataglow_saved_tables, all.names = TRUE)
  parts <- vapply(nms, function(n) {
    df <- get(n, envir = .dataglow_saved_tables)
    cn <- names(df)
    cols <- vapply(seq_along(df), function(i) {
      paste0(.dataglow_json_str(cn[i]), ":", .dataglow_json_col(df[[i]]))
    }, character(1))
    paste0(.dataglow_json_str(n), ":{\"names\":[", paste(.dataglow_json_str(cn), collapse = ","),
           "],\"columns\":{", paste(cols, collapse = ","), "}}")
  }, character(1))
  rm(list = nms, envir = .dataglow_saved_tables)
  paste0("{", paste(parts, collapse = ","), "}")
}
`;

// Pull whatever dataglow_save_df staged out of the R session as pending saves
// ({ name, rows: <columnar payload>, language: 'r' }). `webR` is injected so this
// is testable with a stub.
export async function collectRSaves(webR) {
  const json = await webR.evalRString('.dataglow_collect_saves()');
  const parsed = JSON.parse(json || '{}');
  return Object.entries(parsed).map(([name, payload]) => ({ name, rows: payload, language: 'r' }));
}

export function initWebRRuntime(onStatus) {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onStatus?.('Downloading R runtime…');
    const { WebR } = await import('https://webr.r-wasm.org/latest/webr.mjs');
    const webR = new WebR();
    await webR.init();
    const install = rPackageInstallAllowed();
    if (!install.allowed) {
      // Base R only, deliberately. Both flags go to false so the notices and the
      // power pack list the right recipes as unavailable rather than handing out
      // a library() call that errors.
      onStatus?.(install.blockedBy === 'air_gap'
        ? 'Air-Gap mode is on, so no R packages are fetched. Base R is ready.'
        : 'No network, so no R packages are fetched. Base R is ready.');
      jsonlitePromise = false;
      ggplot2Promise = false;
      onStatus?.('ready');
      state.webR = webR;
      return webR;
    }
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

export async function runR(code, { onTableSaved } = {}) {
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
    const writeback = isEnabled('polyglotWriteback');
    await webR.evalRVoid(writeback ? bridgeSetup + R_WRITEBACK_SETUP : bridgeSetup);
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
      const out = { stdout: output, error: null, images, graphicsAvailable, hasJsonlite };
      if (writeback) {
        out.saved = [];
        out.saveErrors = [];
        // Only a run that finished without an R error commits its saves.
        const rErrored = (result.output || []).some(o => o.type === 'error');
        try {
          const pending = await collectRSaves(webR);
          if (!rErrored && pending.length) {
            const { saved, failed } = await materializeWritebackTables(
              pending,
              buildRuntimeWritebackDeps({
                engine, state, provenance, onTableSaved,
                registerObject: isEnabled('objectSpaceRegistry') ? registerObject : undefined,
              }),
            );
            out.saved = saved;
            out.saveErrors = failed;
          }
        } catch (e) {
          out.saveErrors.push({ name: '(collect)', language: 'r', error: e && e.message ? e.message : String(e) });
        }
      }
      return out;
    } finally {
      await shelter.purge();
    }
  } catch (err) {
    return { stdout: '', error: err.message || String(err), images: [], graphicsAvailable, hasJsonlite };
  }
}
