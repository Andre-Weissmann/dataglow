// ============================================================
// DATAGLOW — Data Diplomacy Loader (Batch 3): real dataset claim builder
// ============================================================
// WHAT THIS IS: replaces the Batch-2 hardcoded demo scenario in
// renderDiplomacyTab (main.js) with a real data-loading form.
// Users pick a loaded table, choose which column holds the entity ID
// and which column holds the disputed value, then fill in source label,
// confidence, and sealedBy party. The module is PURE (no DOM reads from
// outside; el() is the only DOM primitive it uses) and accepts callbacks so
// the caller (main.js) owns all engine interaction.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - It never calls sealClaim(), reconcileClaims(), or createApprovalRequest()
//     itself — those stay in main.js (same separation as Batch 2).
//   - It does NOT validate that the picked row actually exists. The calling
//     code passes the engine's honest error to onError().
//   - Cross-device transport (real two-key-across-two-browsers) remains Batch 4.
//
// Identity split: buildDiplomacyFormModel() is pure / Node-testable;
// renderDiplomacyForm() handles DOM.
// ============================================================

import { el } from '../app-shell/utils.js';

// ---- Pure model builder --------------------------------------------------

/**
 * Build the view-model for one claim-form panel.
 *
 * @param {object} opts
 * @param {string} opts.partyId    e.g. 'analyst', 'reviewer'
 * @param {Array<{name:string, table:string, cols:Array<string>}>} opts.datasets
 *   snapshot of state.datasets at render time; empty array = no data loaded.
 * @param {object|null} opts.currentValues  the partially-filled form state
 *   (table, entityIdCol, entityIdValue, valueCol, source, confidence, sealedBy)
 * @returns {{
 *   partyId:string,
 *   hasDatasets:boolean,
 *   datasetOptions:Array<{label:string, value:string}>,
 *   columnOptions:Array<{label:string, value:string}>,
 *   current:object,
 *   isComplete:boolean
 * }}
 */
export function buildDiplomacyFormModel(opts) {
  const { partyId, datasets, currentValues } = opts;
  const cur = currentValues || {};
  const hasDatasets = Array.isArray(datasets) && datasets.length > 0;

  const datasetOptions = hasDatasets
    ? datasets.map(function(ds) { return { label: ds.name, value: ds.table }; })
    : [];

  // derive column options from the selected table
  let columnOptions = [];
  if (hasDatasets && cur.table) {
    const matched = datasets.find(function(ds) { return ds.table === cur.table; });
    if (matched && Array.isArray(matched.cols)) {
      columnOptions = matched.cols.map(function(c) {
        var label = typeof c === 'object' && c !== null ? (c.name || String(c)) : String(c);
        return { label: label, value: label };
      });
    }
  }

  const isComplete = !!(
    cur.table &&
    cur.entityIdCol &&
    cur.entityIdValue &&
    cur.entityIdValue.toString().trim() !== '' &&
    cur.valueCol &&
    cur.source &&
    cur.source.trim() !== '' &&
    cur.sealedBy &&
    cur.sealedBy.trim() !== '' &&
    typeof cur.confidence === 'number' &&
    Number.isFinite(cur.confidence) &&
    cur.confidence >= 0 &&
    cur.confidence <= 1
  );

  return {
    partyId: partyId,
    hasDatasets: hasDatasets,
    datasetOptions: datasetOptions,
    columnOptions: columnOptions,
    current: cur,
    isComplete: isComplete,
  };
}

// ---- DOM helpers ---------------------------------------------------------

function inputId(partyId, field) {
  return 'diplomacy-' + partyId + '-' + field;
}

const MUTED = 'font-size:var(--text-sm); color:var(--color-text-muted);';

function labelFor(id, text) {
  var lbl = el('label', { for: id, style: 'display:block; font-weight:600; margin-bottom:2px;' });
  lbl.textContent = text;
  return lbl;
}

function selectEl(id, options, value, onChange, testId) {
  var attrs = { id: id, 'data-testid': testId || id, style: 'width:100%; margin-bottom:var(--space-2);' };
  var sel = el('select', attrs);
  var placeholder = el('option', { value: '' });
  placeholder.textContent = '— pick one —';
  sel.appendChild(placeholder);
  options.forEach(function(opt) {
    var o = el('option', { value: opt.value });
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', function() { onChange(sel.value); });
  return sel;
}

function inputEl(id, value, onChange, testId, type, step, min, max) {
  var attrs = {
    id: id, 'data-testid': testId || id,
    type: type || 'text', value: value || '',
    style: 'width:100%; margin-bottom:var(--space-2);',
  };
  if (step !== undefined) attrs.step = step;
  if (min !== undefined) attrs.min = min;
  if (max !== undefined) attrs.max = max;
  var inp = el('input', attrs);
  inp.addEventListener('input', function() { onChange(inp.value); });
  return inp;
}

// ---- Renderer ------------------------------------------------------------

/**
 * Render a claim-builder form for one party into `host`.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host  container (emptied on each call)
 * @param {object} opts.model  from buildDiplomacyFormModel()
 * @param {(field:string, value:any)=>void} opts.onChange  called on every field change
 */
export function renderDiplomacyForm(opts) {
  var host = opts.host, model = opts.model, onChange = opts.onChange;
  if (!host) return;
  host.innerHTML = '';

  var wrap = el('div', {
    'data-testid': 'diplomacy-form-' + model.partyId,
    class: 'card',
    style: 'flex:1 1 0; min-width:0;',
  });
  var heading = el('div', { style: 'font-weight:600; margin-bottom:var(--space-2);' });
  heading.textContent = model.partyId + "'s claim";
  wrap.appendChild(heading);

  if (!model.hasDatasets) {
    var notice = el('div', { style: MUTED });
    notice.textContent = 'Load a dataset first to build a claim.';
    wrap.appendChild(notice);
    host.appendChild(wrap);
    return;
  }

  // Dataset picker
  wrap.appendChild(labelFor(inputId(model.partyId, 'table'), 'Dataset'));
  wrap.appendChild(selectEl(
    inputId(model.partyId, 'table'),
    model.datasetOptions,
    model.current.table || '',
    function(v) { onChange('table', v); },
    'diplomacy-' + model.partyId + '-table'
  ));

  if (model.columnOptions.length === 0) {
    host.appendChild(wrap);
    return;
  }

  // Entity ID column + value
  wrap.appendChild(labelFor(inputId(model.partyId, 'entityIdCol'), 'Entity ID column'));
  wrap.appendChild(selectEl(
    inputId(model.partyId, 'entityIdCol'),
    model.columnOptions,
    model.current.entityIdCol || '',
    function(v) { onChange('entityIdCol', v); },
    'diplomacy-' + model.partyId + '-entityIdCol'
  ));

  wrap.appendChild(labelFor(inputId(model.partyId, 'entityIdValue'), 'Entity ID value (the row to compare)'));
  wrap.appendChild(inputEl(
    inputId(model.partyId, 'entityIdValue'),
    model.current.entityIdValue || '',
    function(v) { onChange('entityIdValue', v); },
    'diplomacy-' + model.partyId + '-entityIdValue'
  ));

  // Value column
  wrap.appendChild(labelFor(inputId(model.partyId, 'valueCol'), 'Disputed value column'));
  wrap.appendChild(selectEl(
    inputId(model.partyId, 'valueCol'),
    model.columnOptions,
    model.current.valueCol || '',
    function(v) { onChange('valueCol', v); },
    'diplomacy-' + model.partyId + '-valueCol'
  ));

  // Source label
  wrap.appendChild(labelFor(inputId(model.partyId, 'source'), 'Source label (e.g. "warehouse-export")'));
  wrap.appendChild(inputEl(
    inputId(model.partyId, 'source'),
    model.current.source || '',
    function(v) { onChange('source', v); },
    'diplomacy-' + model.partyId + '-source'
  ));

  // Confidence
  wrap.appendChild(labelFor(inputId(model.partyId, 'confidence'), 'Confidence (0 = lowest, 1 = highest)'));
  wrap.appendChild(inputEl(
    inputId(model.partyId, 'confidence'),
    model.current.confidence !== undefined ? String(model.current.confidence) : '0.8',
    function(v) { onChange('confidence', parseFloat(v)); },
    'diplomacy-' + model.partyId + '-confidence',
    'number', '0.01', '0', '1'
  ));

  // SealedBy
  wrap.appendChild(labelFor(inputId(model.partyId, 'sealedBy'), 'Party name / signer ID'));
  wrap.appendChild(inputEl(
    inputId(model.partyId, 'sealedBy'),
    model.current.sealedBy || model.partyId,
    function(v) { onChange('sealedBy', v); },
    'diplomacy-' + model.partyId + '-sealedBy'
  ));

  host.appendChild(wrap);
}

/**
 * Render the full Batch-3 loader UI: two claim-builder forms side by side,
 * a "Reconcile" button (enabled only when both forms are complete), and a
 * status line. Does NOT render the Diplomacy panel itself — that stays in
 * main.js's paint() call so the Batch-2 two-key UX is unchanged.
 *
 * @param {object} opts
 * @param {HTMLElement}  opts.host       container (NOT emptied — caller owns layout)
 * @param {object}       opts.modelA     from buildDiplomacyFormModel() for party A
 * @param {object}       opts.modelB     from buildDiplomacyFormModel() for party B
 * @param {(partyId:string,field:string,value:any)=>void}  opts.onChange
 * @param {()=>void}     opts.onReconcile  called when the Reconcile button is clicked
 * @param {string|null}  opts.statusText  optional status line under the button
 */
export function renderDiplomacyLoader(opts) {
  var host = opts.host, modelA = opts.modelA, modelB = opts.modelB;
  var onChange = opts.onChange, onReconcile = opts.onReconcile;
  var statusText = opts.statusText || null;

  if (!host) return;

  // ---- heading & intro ---------------------------------------------------
  var heading = el('div', { style: 'font-weight:600; margin-bottom:var(--space-1);', 'data-testid': 'diplomacy-heading' });
  heading.textContent = 'Data Diplomacy';
  host.appendChild(heading);

  var intro = el('p', { style: MUTED + ' margin:0 0 var(--space-3); line-height:1.5;' });
  intro.textContent = 'Two sources disagree on the same fact. Build each claim below, then hit Reconcile to let the engine compare them.';
  host.appendChild(intro);

  // ---- two claim-form columns -------------------------------------------
  var row = el('div', {
    'data-testid': 'diplomacy-form-row',
    style: 'display:flex; gap:var(--space-3); flex-wrap:wrap; margin-bottom:var(--space-3);',
  });

  var hostA = el('div', { style: 'flex:1 1 0; min-width:0;' });
  var hostB = el('div', { style: 'flex:1 1 0; min-width:0;' });
  renderDiplomacyForm({ host: hostA, model: modelA, onChange: function(field, v) { onChange('a', field, v); } });
  renderDiplomacyForm({ host: hostB, model: modelB, onChange: function(field, v) { onChange('b', field, v); } });
  row.appendChild(hostA);
  row.appendChild(hostB);
  host.appendChild(row);

  // ---- reconcile button --------------------------------------------------
  var bothComplete = modelA.isComplete && modelB.isComplete;
  var reconcileBtn = el('button', {
    type: 'button',
    class: 'btn btn-primary',
    'data-testid': 'diplomacy-reconcile-btn',
    style: 'margin-bottom:var(--space-2);',
  });
  reconcileBtn.textContent = 'Reconcile';
  if (!bothComplete) reconcileBtn.disabled = true;
  reconcileBtn.addEventListener('click', onReconcile);
  host.appendChild(reconcileBtn);

  // ---- status line -------------------------------------------------------
  if (statusText) {
    var status = el('div', { style: MUTED + ' margin-top:var(--space-1);', 'data-testid': 'diplomacy-status' });
    status.textContent = statusText;
    host.appendChild(status);
  }
}
