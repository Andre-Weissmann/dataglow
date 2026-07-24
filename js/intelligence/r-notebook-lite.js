// ============================================================
// DATAGLOW - R Notebooks-lite (pure engine, any industry)
// ============================================================
// A tiny notebook model for the on-device R (WebR) surface: an ordered
// list of code and markdown cells that share one R session. Pure state,
// serialization, starter snippets and R prelude text only. No DOM, no
// network, no WebR. The canvas wire owns execution and rendering.
//
// Data model contract:
//   Notebook: { id, version:1, title, createdAt, updatedAt, cells: Cell[] }
//   Cell:     { id, type:'code'|'markdown', source, output?, status?, images?, collapsed? }
//   output:   { stdout, error, images, notices, elapsedMs, status } (set by the wire)
//
// Any industry by design: starter snippets cover general, stats, finance
// and healthcare shapes. Nothing here assumes pharma, PHI or a schema.

export const R_NOTEBOOK_LITE_VERSION = 1;

// WebR builds a whole data.frame in wasm memory, so the bridge reads at most
// this many rows per table. Matches js/runtimes-viz/r-runtime.js.
export const R_ROW_LIMIT = 200000;

export const R_NOTEBOOK_FILE_EXT = '.dgrnb';

var _seq = 0;

function newId(prefix) {
  _seq += 1;
  var rand = Math.random().toString(36).slice(2, 8);
  return (prefix || 'cell') + '-' + _seq + '-' + rand;
}

function nowIso() {
  return new Date().toISOString();
}

// ---- cells -----------------------------------------------------------------

export function createCell(spec) {
  spec = spec || {};
  var type = spec.type === 'markdown' ? 'markdown' : 'code';
  return {
    id: newId(type === 'markdown' ? 'md' : 'code'),
    type: type,
    source: typeof spec.source === 'string' ? spec.source : '',
    output: null,
    status: 'idle',
    images: [],
    collapsed: false
  };
}

export function canRunCell(cell) {
  if (!cell || cell.type !== 'code') return false;
  return typeof cell.source === 'string' && cell.source.trim().length > 0;
}

function normalizeCell(c) {
  c = c || {};
  var type = c.type === 'markdown' ? 'markdown' : 'code';
  return {
    id: typeof c.id === 'string' && c.id ? c.id : newId(type === 'markdown' ? 'md' : 'code'),
    type: type,
    source: typeof c.source === 'string' ? c.source : '',
    output: c.output && typeof c.output === 'object' ? c.output : null,
    status: typeof c.status === 'string' ? c.status : 'idle',
    images: Array.isArray(c.images) ? c.images.slice() : [],
    collapsed: !!c.collapsed
  };
}

// ---- notebook --------------------------------------------------------------

export function defaultStarterCells() {
  return [
    createCell({
      type: 'markdown',
      source: '# R notebook\n' +
        'On-device R for any industry. Stats, finance, research, ops, healthcare.\n\n' +
        'Use `df` for the active dataset, or `dataglow_get_df("table")` for a named table. ' +
        'Rows never leave this device.'
    }),
    createCell({
      type: 'code',
      source: 'df <- dataglow_get_df()\nstr(df)\nsummary(df)'
    })
  ];
}

export function createNotebook(seed) {
  var cells;
  if (seed && Array.isArray(seed.cells)) {
    cells = seed.cells.map(normalizeCell);
  } else if (Array.isArray(seed)) {
    cells = seed.map(normalizeCell);
  } else {
    cells = defaultStarterCells();
  }
  var created = (seed && typeof seed.createdAt === 'string' && seed.createdAt) || nowIso();
  return {
    id: (seed && typeof seed.id === 'string' && seed.id) || newId('rnb'),
    version: R_NOTEBOOK_LITE_VERSION,
    title: (seed && typeof seed.title === 'string' && seed.title) || 'R notebook',
    createdAt: created,
    updatedAt: (seed && typeof seed.updatedAt === 'string' && seed.updatedAt) || created,
    cells: cells
  };
}

function touch(nb) {
  if (nb) nb.updatedAt = nowIso();
  return nb;
}

function indexOfCell(nb, cellId) {
  var cells = (nb && nb.cells) || [];
  for (var i = 0; i < cells.length; i++) {
    if (cells[i] && cells[i].id === cellId) return i;
  }
  return -1;
}

export function addCell(nb, index, cell) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var c = cell ? normalizeCell(cell) : createCell({ type: 'code', source: '' });
  var at = typeof index === 'number' && index >= 0 && index <= nb.cells.length
    ? index
    : nb.cells.length;
  nb.cells.splice(at, 0, c);
  return touch(nb);
}

export function removeCell(nb, cellId) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var i = indexOfCell(nb, cellId);
  if (i !== -1) nb.cells.splice(i, 1);
  return touch(nb);
}

export function updateCellSource(nb, cellId, source) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var i = indexOfCell(nb, cellId);
  if (i !== -1) nb.cells[i].source = typeof source === 'string' ? source : '';
  return touch(nb);
}

export function moveCell(nb, cellId, toIndex) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var from = indexOfCell(nb, cellId);
  if (from === -1 || typeof toIndex !== 'number') return nb;
  var to = toIndex;
  if (to < 0) to = 0;
  if (to >= nb.cells.length) to = nb.cells.length - 1;
  if (to === from) return nb;
  var moved = nb.cells.splice(from, 1)[0];
  nb.cells.splice(to, 0, moved);
  return touch(nb);
}

export function setCellOutput(nb, cellId, output) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var i = indexOfCell(nb, cellId);
  if (i === -1) return nb;
  var out = output && typeof output === 'object' ? output : null;
  nb.cells[i].output = out;
  nb.cells[i].status = out && typeof out.status === 'string' ? out.status : 'idle';
  nb.cells[i].images = out ? extractImageDataUrls(out.images) : [];
  return touch(nb);
}

// ---- serialization ---------------------------------------------------------

export function serializeNotebook(nb) {
  var safe = {
    id: (nb && nb.id) || newId('rnb'),
    version: R_NOTEBOOK_LITE_VERSION,
    kind: 'dataglow-r-notebook',
    title: (nb && nb.title) || 'R notebook',
    createdAt: (nb && nb.createdAt) || nowIso(),
    updatedAt: (nb && nb.updatedAt) || nowIso(),
    cells: ((nb && nb.cells) || []).map(function (c) {
      return {
        id: c.id,
        type: c.type === 'markdown' ? 'markdown' : 'code',
        source: typeof c.source === 'string' ? c.source : '',
        collapsed: !!c.collapsed
      };
    })
  };
  return JSON.stringify(safe, null, 2);
}

export function parseNotebook(json) {
  if (typeof json !== 'string' || json.trim() === '') {
    return { ok: false, error: 'Empty notebook file.' };
  }
  var raw;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: 'Not valid notebook JSON.' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Notebook root must be an object.' };
  }
  if (!Array.isArray(raw.cells)) {
    return { ok: false, error: 'Notebook is missing a cells list.' };
  }
  return { ok: true, notebook: createNotebook(raw) };
}

// ---- R bridge text ---------------------------------------------------------

// Honest one-line notice when a table was read past the row limit. Pure, so
// the UI and the tests agree on the wording.
export function buildRowCapNotice(totalRows, limit) {
  var cap = typeof limit === 'number' && limit > 0 ? limit : R_ROW_LIMIT;
  if (typeof totalRows !== 'number' || totalRows <= cap) return null;
  return 'R is reading ' + cap.toLocaleString() + ' of ' + totalRows.toLocaleString() +
    ' rows. Filter or aggregate in SQL first for a full-dataset answer.';
}

// One-line notices for the optional packages that may or may not install in a
// given WebR session. Mirrors js/runtimes-viz/r-runtime.js so both paths are
// honest in the same words.
export function buildRBridgeNotices(opts) {
  opts = opts || {};
  var notices = [];
  if (opts.hasJsonlite === false) {
    notices.push('Using a simplified data bridge (a package failed to install).');
  }
  if (opts.graphicsAvailable === false) {
    notices.push('ggplot2 could not be installed. Base R plotting still works, but ggplot2 charts are unavailable.');
  }
  if (Array.isArray(opts.rowCapNotices)) {
    opts.rowCapNotices.forEach(function (n) { if (n) notices.push(n); });
  }
  return notices;
}

// Keep only real PNG/SVG data URLs a run produced, so the UI renders exactly
// the plots R made and nothing else.
export function extractImageDataUrls(images) {
  if (!Array.isArray(images)) return [];
  return images.filter(function (s) {
    return typeof s === 'string' && s.indexOf('data:image/') === 0;
  });
}

function rStringLiteral(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// R source that defines the dataset bridge. The rows themselves are bound by
// the runtime (one JSON string per table); this only builds the R side:
// a comment listing the tables available and dataglow_get_df(name).
export function buildRBridgePrelude(datasetsMeta, opts) {
  opts = opts || {};
  var hasJsonlite = opts.hasJsonlite !== false;
  var meta = Array.isArray(datasetsMeta) ? datasetsMeta : [];
  var names = meta.map(function (d) { return (d && (d.table || d.name)) || ''; })
    .filter(function (n) { return n; });

  var header = ['# DATAGLOW bridge: your rows stay on this device.'];
  if (names.length) {
    header.push('# Tables available: ' + names.join(', '));
    meta.forEach(function (d) {
      var n = (d && (d.table || d.name)) || '';
      if (!n) return;
      var rows = d && typeof d.rows === 'number' ? d.rows : null;
      var cols = d && Array.isArray(d.columns) ? d.columns.length : null;
      header.push('#   ' + n + (rows === null ? '' : ' (' + rows + ' rows' +
        (cols === null ? '' : ', ' + cols + ' cols') + ')'));
    });
  } else {
    header.push('# No table is loaded yet. Load a file first, then re-run this cell.');
  }
  header.push('# Row limit per table: ' + R_ROW_LIMIT + '.');

  var defaultName = names.length ? names[0] : '';
  var getter = hasJsonlite
    ? [
      'library(jsonlite)',
      '.dataglow_decode <- function(json_str) jsonlite::fromJSON(json_str)'
    ].join('\n')
    : [
      '# Minimal base-R reader used only when jsonlite could not be installed.',
      '# Handles the flat {"col": scalar, ...} row shape DATAGLOW emits.',
      '.dataglow_decode <- function(json_str) {',
      '  rows_raw <- regmatches(json_str, gregexpr("\\\\{[^{}]*\\\\}", json_str))[[1]]',
      '  if (length(rows_raw) == 0) return(data.frame())',
      '  parse_row <- function(r) {',
      '    pairs <- regmatches(r, gregexpr(\'"[^"]*"\\\\s*:\\\\s*(null|true|false|-?[0-9.]+(?:[eE][-+]?[0-9]+)?|"(?:[^"\\\\\\\\]|\\\\\\\\.)*")\', r, perl = TRUE))[[1]]',
      '    vals <- list()',
      '    for (p in pairs) {',
      '      kv <- regmatches(p, regexec(\'^"([^"]*)"\\\\s*:\\\\s*(.*)$\', p, perl = TRUE))[[1]]',
      '      key <- kv[2]; raw <- kv[3]',
      '      if (raw == "null") { v <- NA }',
      '      else if (raw == "true") { v <- TRUE }',
      '      else if (raw == "false") { v <- FALSE }',
      '      else if (grepl(\'^".*"$\', raw)) { v <- substr(raw, 2, nchar(raw) - 1) }',
      '      else { v <- suppressWarnings(as.numeric(raw)) }',
      '      vals[[key]] <- v',
      '    }',
      '    vals',
      '  }',
      '  parsed <- lapply(rows_raw, parse_row)',
      '  keys <- unique(unlist(lapply(parsed, names)))',
      '  cols <- lapply(keys, function(k) sapply(parsed, function(r) if (is.null(r[[k]])) NA else r[[k]]))',
      '  names(cols) <- keys',
      '  as.data.frame(cols, stringsAsFactors = FALSE)',
      '}'
    ].join('\n');

  var body = [
    '.dataglow_default_table <- ' + rStringLiteral(defaultName),
    'dataglow_get_df <- function(name = .dataglow_default_table) {',
    '  if (is.null(name) || !nzchar(name)) stop("No table loaded. Load a file in DATAGLOW first.")',
    '  var <- paste0(".dataglow_json_", name)',
    '  if (!exists(var, envir = .GlobalEnv)) stop(paste0("Table \'", name, "\' not loaded."))',
    '  .dataglow_decode(get(var, envir = .GlobalEnv))',
    '}',
    'dataglow_tables <- function() c(' + names.map(rStringLiteral).join(', ') + ')'
  ].join('\n');

  return header.join('\n') + '\n' + getter + '\n' + body + '\n';
}

// ---- starter snippets (any industry) ---------------------------------------

var STARTERS = [
  {
    id: 'general-summary', industry: 'general', label: 'Summary',
    code: '# Shape and per-column summary\ndf <- dataglow_get_df()\nstr(df)\nsummary(df)'
  },
  {
    id: 'general-group-mean', industry: 'general', label: 'Group mean',
    code: '# Mean of the first numeric column by the first text column\ndf <- dataglow_get_df()\nnum <- names(df)[sapply(df, is.numeric)][1]\ngrp <- names(df)[sapply(df, function(x) is.character(x) || is.factor(x))][1]\naggregate(df[[num]], by = list(group = df[[grp]]), FUN = mean, na.rm = TRUE)'
  },
  {
    id: 'general-missing', industry: 'general', label: 'Missing values',
    code: '# Missing value count per column\ndf <- dataglow_get_df()\nsort(colSums(is.na(df)), decreasing = TRUE)'
  },
  {
    id: 'general-plot', industry: 'general', label: 'Simple plot',
    code: '# Histogram of the first numeric column (base R graphics)\ndf <- dataglow_get_df()\nnum <- names(df)[sapply(df, is.numeric)][1]\nhist(df[[num]], main = paste("Distribution of", num), xlab = num, col = "steelblue")'
  },
  {
    id: 'stats-ttest', industry: 'stats', label: 't-test',
    code: '# Two-sample t-test skeleton: replace value_col and group_col\ndf <- dataglow_get_df()\n# t.test(df$value_col ~ df$group_col)\nnum <- names(df)[sapply(df, is.numeric)][1]\ngrp <- names(df)[sapply(df, function(x) is.character(x) || is.factor(x))][1]\nif (!is.na(num) && !is.na(grp) && length(unique(df[[grp]])) == 2) {\n  t.test(df[[num]] ~ df[[grp]])\n} else {\n  cat("Pick a numeric column and a two-level group column.\\n")\n}'
  },
  {
    id: 'stats-lm', industry: 'stats', label: 'Linear model',
    code: '# Linear model skeleton: replace y_col and x_col\ndf <- dataglow_get_df()\n# fit <- lm(y_col ~ x_col, data = df)\nnums <- names(df)[sapply(df, is.numeric)]\nif (length(nums) >= 2) {\n  fit <- lm(as.formula(paste(nums[1], "~", nums[2])), data = df)\n  summary(fit)\n} else {\n  cat("Needs at least two numeric columns.\\n")\n}'
  },
  {
    id: 'stats-correlation', industry: 'stats', label: 'Correlation',
    code: '# Correlation matrix across numeric columns\ndf <- dataglow_get_df()\nround(cor(df[sapply(df, is.numeric)], use = "complete.obs"), 3)'
  },
  {
    id: 'finance-returns', industry: 'finance', label: 'Returns summary',
    code: '# Period returns skeleton: replace price_col with your price column\ndf <- dataglow_get_df()\nprice <- names(df)[sapply(df, is.numeric)][1]\nprices <- df[[price]]\nreturns <- diff(prices) / head(prices, -1)\ncat("Mean return:", round(mean(returns, na.rm = TRUE), 6), "\\n")\ncat("Std dev:", round(sd(returns, na.rm = TRUE), 6), "\\n")\nsummary(returns)'
  },
  {
    id: 'finance-outliers', industry: 'finance', label: 'Outliers (IQR)',
    code: '# IQR outlier count per numeric column\ndf <- dataglow_get_df()\nfor (nm in names(df)[sapply(df, is.numeric)]) {\n  q <- quantile(df[[nm]], c(0.25, 0.75), na.rm = TRUE)\n  iqr <- q[2] - q[1]\n  n <- sum(df[[nm]] < q[1] - 1.5 * iqr | df[[nm]] > q[2] + 1.5 * iqr, na.rm = TRUE)\n  cat(nm, ":", n, "outliers\\n")\n}'
  },
  {
    id: 'healthcare-count-by-category', industry: 'healthcare', label: 'Count by category',
    code: '# Counts by category: no assumption about what the categories mean\ndf <- dataglow_get_df()\ncat_col <- names(df)[sapply(df, function(x) is.character(x) || is.factor(x))][1]\nsort(table(df[[cat_col]]), decreasing = TRUE)'
  },
  {
    id: 'healthcare-rate-by-group', industry: 'healthcare', label: 'Rate by group',
    code: '# Rate of a flag column by group: replace flag_col and group_col\ndf <- dataglow_get_df()\ncats <- names(df)[sapply(df, function(x) is.character(x) || is.factor(x))]\nif (length(cats) >= 2) {\n  tbl <- table(df[[cats[1]]], df[[cats[2]]])\n  round(prop.table(tbl, margin = 1) * 100, 1)\n} else {\n  cat("Needs at least two categorical columns.\\n")\n}'
  },
  {
    id: 'ops-throughput', industry: 'ops', label: 'Throughput',
    code: '# Totals and percentiles for the first numeric column\ndf <- dataglow_get_df()\nnum <- names(df)[sapply(df, is.numeric)][1]\nv <- df[[num]]\ncat("Total:", sum(v, na.rm = TRUE), "\\n")\ncat("Mean:", round(mean(v, na.rm = TRUE), 3), "\\n")\ncat("P95:", round(quantile(v, 0.95, na.rm = TRUE), 3), "\\n")'
  }
];

export const R_STARTER_INDUSTRIES = ['general', 'stats', 'finance', 'healthcare', 'ops'];

export function suggestStarterSnippets(industry) {
  if (!industry || industry === 'all') return STARTERS.slice();
  var key = String(industry).toLowerCase();
  var picked = STARTERS.filter(function (s) { return s.industry === key; });
  if (!picked.length) return STARTERS.filter(function (s) { return s.industry === 'general'; });
  return picked;
}

// ---- tiny markdown (escaped; bold + inline code + line breaks) -------------

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(source) {
  var esc = escapeHtml(source);
  esc = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  esc = esc.replace(/`([^`]+)`/g, '<code>$1</code>');
  esc = esc.replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  return esc;
}

export const DataGlowRNotebookLite = {
  version: R_NOTEBOOK_LITE_VERSION,
  rowLimit: R_ROW_LIMIT,
  fileExt: R_NOTEBOOK_FILE_EXT,
  industries: R_STARTER_INDUSTRIES,
  createNotebook: createNotebook,
  createCell: createCell,
  addCell: addCell,
  removeCell: removeCell,
  updateCellSource: updateCellSource,
  moveCell: moveCell,
  setCellOutput: setCellOutput,
  serializeNotebook: serializeNotebook,
  parseNotebook: parseNotebook,
  defaultStarterCells: defaultStarterCells,
  canRunCell: canRunCell,
  buildRBridgePrelude: buildRBridgePrelude,
  buildRBridgeNotices: buildRBridgeNotices,
  buildRowCapNotice: buildRowCapNotice,
  extractImageDataUrls: extractImageDataUrls,
  suggestStarterSnippets: suggestStarterSnippets,
  escapeHtml: escapeHtml,
  renderMarkdown: renderMarkdown
};

if (typeof window !== 'undefined') {
  window.DataGlowRNotebookLite = DataGlowRNotebookLite;
}
