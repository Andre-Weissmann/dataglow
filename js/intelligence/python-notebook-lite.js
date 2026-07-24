// ============================================================
// DATAGLOW - Python Notebooks-lite (pure engine)
// ============================================================
// A tiny notebook model on top of the existing on-device Pyodide
// Python tab: an ordered list of code and markdown cells that share
// one kernel session. Pure state + serialization only. No DOM, no
// network, no filesystem, no Python. The canvas wire owns execution
// and rendering.
//
// Data model contract:
//   Notebook: { id, version:1, cells: Cell[] }
//   Cell:     { id, type:'code'|'markdown', source, output?, collapsed? }
//   output:   { stdout, error, table?, elapsedMs?, status } (set by the wire)
//
// Public:
//   createNotebook(seed?)              -> Notebook
//   createCell({ type, source })       -> Cell
//   addCell(nb, index?, cell?)         -> Notebook
//   removeCell(nb, cellId)             -> Notebook
//   updateCellSource(nb, cellId, src)  -> Notebook
//   moveCell(nb, cellId, toIndex)      -> Notebook
//   setCellOutput(nb, cellId, output)  -> Notebook
//   serializeNotebook(nb)              -> string (JSON)
//   parseNotebook(json)                -> { ok, notebook?, error? }
//   defaultStarterCells()              -> Cell[]
//   canRunCell(cell)                   -> boolean
//   renderMarkdown(source)             -> string (escaped, tiny subset)

export const PYTHON_NOTEBOOK_LITE_VERSION = 1;

var _seq = 0;

function newId(prefix) {
  _seq += 1;
  var rand = Math.random().toString(36).slice(2, 8);
  return (prefix || 'cell') + '-' + _seq + '-' + rand;
}

function isCode(t) { return t === 'code'; }

// ---- cells -----------------------------------------------------------------

export function createCell(spec) {
  spec = spec || {};
  var type = isCode(spec.type) || spec.type === 'markdown' ? spec.type : 'code';
  var source = typeof spec.source === 'string' ? spec.source : '';
  return {
    id: newId(type === 'markdown' ? 'md' : 'code'),
    type: type,
    source: source,
    output: null,
    collapsed: false
  };
}

export function canRunCell(cell) {
  if (!cell || cell.type !== 'code') return false;
  return typeof cell.source === 'string' && cell.source.trim().length > 0;
}

// ---- notebook --------------------------------------------------------------

export function defaultStarterCells() {
  return [
    createCell({
      type: 'markdown',
      source: '# Python Notebook\n' +
        'Runs on this device with Pyodide and pandas. Rows never leave the browser.\n\n' +
        'Use `dg.df()` for the active dataset and `dg.show(frame)` to render a table.'
    }),
    createCell({
      type: 'code',
      source: 'df = dg.df()\nprint(df.head())'
    })
  ];
}

export function createNotebook(seed) {
  var cells;
  if (seed && Array.isArray(seed.cells)) {
    cells = seed.cells.map(function (c) { return normalizeCell(c); });
  } else if (Array.isArray(seed)) {
    cells = seed.map(function (c) { return normalizeCell(c); });
  } else {
    cells = defaultStarterCells();
  }
  return {
    id: (seed && seed.id) || newId('nb'),
    version: PYTHON_NOTEBOOK_LITE_VERSION,
    cells: cells
  };
}

function normalizeCell(c) {
  c = c || {};
  var type = c.type === 'markdown' ? 'markdown' : 'code';
  var cell = {
    id: typeof c.id === 'string' && c.id ? c.id : newId(type === 'markdown' ? 'md' : 'code'),
    type: type,
    source: typeof c.source === 'string' ? c.source : '',
    output: c.output && typeof c.output === 'object' ? c.output : null,
    collapsed: !!c.collapsed
  };
  return cell;
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
  return nb;
}

export function removeCell(nb, cellId) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var i = indexOfCell(nb, cellId);
  if (i !== -1) nb.cells.splice(i, 1);
  return nb;
}

export function updateCellSource(nb, cellId, source) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var i = indexOfCell(nb, cellId);
  if (i !== -1) nb.cells[i].source = typeof source === 'string' ? source : '';
  return nb;
}

export function moveCell(nb, cellId, toIndex) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var from = indexOfCell(nb, cellId);
  if (from === -1) return nb;
  var to = toIndex;
  if (typeof to !== 'number') return nb;
  if (to < 0) to = 0;
  if (to >= nb.cells.length) to = nb.cells.length - 1;
  if (to === from) return nb;
  var moved = nb.cells.splice(from, 1)[0];
  nb.cells.splice(to, 0, moved);
  return nb;
}

export function setCellOutput(nb, cellId, output) {
  if (!nb || !Array.isArray(nb.cells)) return nb;
  var i = indexOfCell(nb, cellId);
  if (i !== -1) nb.cells[i].output = output && typeof output === 'object' ? output : null;
  return nb;
}

// ---- serialization ---------------------------------------------------------

export function serializeNotebook(nb) {
  var safe = {
    id: (nb && nb.id) || newId('nb'),
    version: PYTHON_NOTEBOOK_LITE_VERSION,
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
  var nb = createNotebook({ id: typeof raw.id === 'string' ? raw.id : undefined, cells: raw.cells });
  return { ok: true, notebook: nb };
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
  // **bold** then `code`, on already-escaped text so no HTML injection.
  esc = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  esc = esc.replace(/`([^`]+)`/g, '<code>$1</code>');
  esc = esc.replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  return esc;
}

export const DataGlowPythonNotebookLite = {
  version: PYTHON_NOTEBOOK_LITE_VERSION,
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
  escapeHtml: escapeHtml,
  renderMarkdown: renderMarkdown
};

if (typeof window !== 'undefined') {
  window.DataGlowPythonNotebookLite = DataGlowPythonNotebookLite;
}
