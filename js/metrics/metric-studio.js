// ============================================================
// DATAGLOW — Metric Studio (OneCanvas Phase 1, Part 5)
// ============================================================
// A local-only registry for user-defined metrics: a named business metric
// described in plain English, tied to REAL columns of the currently loaded
// dataset, with a formula that is actually computed against the in-browser
// DuckDB engine (never a mocked value). It follows the same local-only
// named-thing registry pattern as js/packs/pack-registry.js — an in-memory Map
// plus explicit toJSON()/fromJSON() for the exportable/importable JSON the spec
// asks for — and deliberately carries ZERO platform coupling in its logic core:
//
//   * no localStorage / cookies / network of its own;
//   * the DuckDB engine is INJECTED (same seam the anomaly modules use), so the
//     pure logic is unit-testable in Node against the native test engine.
//
// The identity split, mirrored by the file's two halves:
//   1. Pure logic + registry (validation, column-ref extraction, formula
//      suggestion, DuckDB compute, duplicate detection). Node-testable.
//   2. DOM presenters (renderMetricStudio, the create form + saved list +
//      duplicate prompt), gated behind the `metricStudio` flag by the caller in
//      app-shell/main.js — with the flag off (its shipped default) nothing
//      renders.
//
// HONESTY: a metric is only ever stored with a value that Metric Studio actually
// computed against the loaded table. If the formula fails to compute, the metric
// records the error, not a placeholder number.

import { el, escapeHtml, formatNumber, timeAgo } from '../app-shell/utils.js';

export const METRIC_STATUSES = ['exploratory', 'reviewed', 'certified'];
const DEFAULT_STATUS = 'exploratory';

// Similarity at or above this fraction on the plain-English text is treated as a
// likely duplicate and prompts merge/keep-both. Same-formula is an exact match.
export const DUPLICATE_TEXT_THRESHOLD = 0.9;

// SQL keywords / built-in functions a bareword identifier in a formula may be
// WITHOUT being a column reference. Anything left over after removing these must
// resolve to a real column, otherwise the metric is rejected. Deliberately
// conservative — unknown barewords fail loudly rather than being accepted as
// silent garbage.
const SQL_TOKENS = new Set([
  'select', 'from', 'where', 'group', 'by', 'having', 'order', 'as', 'distinct',
  'sum', 'count', 'avg', 'min', 'max', 'median', 'mode', 'stddev', 'stddev_pop',
  'stddev_samp', 'var_pop', 'var_samp', 'variance', 'first', 'last', 'total',
  'case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'null', 'is', 'in',
  'between', 'like', 'ilike', 'true', 'false', 'cast', 'try_cast', 'coalesce',
  'nullif', 'round', 'floor', 'ceil', 'ceiling', 'abs', 'sqrt', 'pow', 'power',
  'exp', 'ln', 'log', 'greatest', 'least', 'over', 'partition', 'filter',
  'double', 'integer', 'int', 'bigint', 'varchar', 'date', 'timestamp', 'boolean',
  'decimal', 'numeric', 'real', 'float', 'asc', 'desc', 'on', 'using', 'length',
  'lower', 'upper', 'trim', 'extract', 'year', 'month', 'day', 'epoch',
]);

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// A normalised set of the schema's column names for case-insensitive lookup.
// Accepts either the app's `cols` shape ([{name,type}]) or a bare string[].
function normalizeSchema(schemaCols) {
  const out = new Map(); // lowercased -> canonical name
  for (const c of schemaCols || []) {
    const name = typeof c === 'string' ? c : (c && c.name);
    if (typeof name === 'string' && name.trim() !== '') out.set(name.toLowerCase(), name);
  }
  return out;
}

/**
 * Extract the candidate column references from a formula: every bareword or
 * double-quoted identifier that is not a known SQL token or a pure number.
 * Pure — no schema needed. Returns lowercased identifier strings, de-duped.
 * @param {string} expression
 * @returns {string[]}
 */
export function referencedIdentifiers(expression) {
  const expr = String(expression || '');
  const found = new Set();
  // Double-quoted identifiers keep spaces/case; store lowercased for matching.
  for (const m of expr.matchAll(/"([^"]+)"/g)) found.add(m[1].toLowerCase());
  // Barewords, minus anything that was inside quotes (already captured).
  const unquoted = expr.replace(/"[^"]+"/g, ' ');
  for (const m of unquoted.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const tok = m[0].toLowerCase();
    if (!SQL_TOKENS.has(tok)) found.add(tok);
  }
  return [...found];
}

/**
 * Validate a metric definition against the loaded dataset's schema. Rejects an
 * empty name/expression and — the important honesty guard — any column the
 * formula references that does not exist in the schema.
 * @param {{name?:string, plainEnglish?:string, expression?:string}} def
 * @param {Array<{name:string}|string>} schemaCols the loaded dataset's columns
 * @returns {{valid:boolean, errors:string[], columns:string[]}}
 */
export function validateMetricDefinition(def, schemaCols) {
  const errors = [];
  const name = (def && def.name || '').trim();
  const expression = (def && def.expression || '').trim();
  if (!name) errors.push('Metric name is required.');
  if (!expression) errors.push('A formula/expression is required.');
  // A single expression only — reject statement chaining outright.
  if (expression.includes(';')) errors.push('The formula must be a single expression (no ";").');

  const schema = normalizeSchema(schemaCols);
  const refs = referencedIdentifiers(expression);
  const columns = [];
  const undefined_ = [];
  for (const ref of refs) {
    if (schema.has(ref)) columns.push(schema.get(ref));
    else undefined_.push(ref);
  }
  if (schema.size === 0 && refs.length > 0) {
    errors.push('No dataset is loaded, so the formula\'s columns cannot be validated.');
  } else if (undefined_.length > 0) {
    errors.push(`Formula references column(s) not in the dataset: ${undefined_.join(', ')}.`);
  }
  if (schema.size > 0 && refs.length === 0) {
    errors.push('The formula does not reference any dataset column.');
  }
  return { valid: errors.length === 0, errors, columns };
}

// ------------------------------------------------------------
// Plain-English → formula suggestion (best-effort, editable)
// ------------------------------------------------------------
// Turns "readmission rate = readmissions / total_discharges" into a runnable
// aggregate. It is a SUGGESTION only — the "Show the math" toggle always lets the
// user see and edit the raw expression before saving. Not ML; a small heuristic.

function matchColumn(word, schema) {
  const w = word.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (schema.has(w)) return schema.get(w);
  // try snake/space variants
  for (const [k, v] of schema) {
    if (k.replace(/_/g, '') === w.replace(/_/g, '')) return v;
  }
  return null;
}

/**
 * Best-effort formula suggestion from a plain-English definition. Recognises an
 * explicit "= <rhs>" and simple "A per/over/divided by B" ratios, mapping words
 * to real columns and wrapping bare column ratios in SUM(...) so they aggregate.
 * Returns '' when nothing confident can be suggested (the user then writes it).
 * @param {string} plainEnglish
 * @param {Array<{name:string}|string>} schemaCols
 * @returns {string}
 */
export function suggestExpression(plainEnglish, schemaCols) {
  const text = String(plainEnglish || '').trim();
  if (!text) return '';
  const schema = normalizeSchema(schemaCols);

  // 1. Explicit "name = expression": trust the RHS, but only if every bareword
  //    it references resolves to a real column (else it is not yet runnable).
  const eq = text.split('=');
  if (eq.length === 2 && eq[1].trim()) {
    const rhs = eq[1].trim();
    const refs = referencedIdentifiers(rhs);
    if (refs.length > 0 && refs.every(r => schema.has(r))) return rhs;
  }

  // 2. "A per|over|divided by|/ B" ratio → SUM(A) / NULLIF(SUM(B), 0).
  const ratio = text.match(/([A-Za-z0-9_ ]+?)\s*(?:per|over|divided by|\/)\s*([A-Za-z0-9_ ]+)/i);
  if (ratio) {
    const num = matchColumn(ratio[1].split(/\s+/).pop(), schema);
    const den = matchColumn(ratio[2].split(/\s+/).shift(), schema);
    if (num && den) return `SUM("${num}") / NULLIF(SUM("${den}"), 0)`;
  }

  // 3. A single mentioned column with an average/mean/total hint.
  const words = text.split(/\s+/);
  for (const w of words) {
    const col = matchColumn(w, schema);
    if (col) {
      if (/\b(average|mean|avg)\b/i.test(text)) return `AVG("${col}")`;
      if (/\b(total|sum)\b/i.test(text)) return `SUM("${col}")`;
      if (/\b(count|number of|how many)\b/i.test(text)) return `COUNT("${col}")`;
    }
  }
  return '';
}

// ------------------------------------------------------------
// DuckDB compute (engine injected)
// ------------------------------------------------------------

/**
 * Actually compute a metric's formula against the loaded table via the injected
 * engine's runQuery({columns,rows}) contract. Returns the scalar value + a
 * timestamp, or an ok:false error — never a placeholder number.
 * @param {{table:string, expression:string, engine:{runQuery:Function}}} arg
 * @returns {Promise<{ok:boolean, value:(number|string|null), computedAt:number, error?:string, sql?:string}>}
 */
export async function computeMetricValue({ table, expression, engine }) {
  if (!engine || typeof engine.runQuery !== 'function') {
    return { ok: false, value: null, computedAt: Date.now(), error: 'No query engine available.' };
  }
  if (!table) return { ok: false, value: null, computedAt: Date.now(), error: 'No table loaded.' };
  const sql = `SELECT (${expression}) AS value FROM ${table}`;
  try {
    const res = await engine.runQuery(sql);
    const rows = res && res.rows ? res.rows : [];
    let value = rows.length ? rows[0].value : null;
    if (typeof value === 'bigint') value = Number(value);
    return { ok: true, value, computedAt: Date.now(), sql };
  } catch (e) {
    return { ok: false, value: null, computedAt: Date.now(), error: e.message || String(e), sql };
  }
}

// ------------------------------------------------------------
// Duplicate / conflict detection
// ------------------------------------------------------------

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeExpr(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

/**
 * Dice coefficient over character bigrams — a simple, dependency-free string
 * similarity in [0,1]. 1.0 for identical normalised text.
 * @returns {number}
 */
export function textSimilarity(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let totalX = 0;
  let totalY = 0;
  for (const v of bx.values()) totalX += v;
  for (const v of by.values()) totalY += v;
  for (const [g, c] of bx) if (by.has(g)) overlap += Math.min(c, by.get(g));
  return (2 * overlap) / (totalX + totalY);
}

/**
 * Find existing metrics that conflict with a candidate definition: an exact
 * (normalised) formula match, or >DUPLICATE_TEXT_THRESHOLD plain-English text
 * similarity. Real check, returns every conflict with its reason.
 * @param {Array<object>} existing
 * @param {{plainEnglish?:string, expression?:string}} candidate
 * @returns {Array<{metric:object, reason:string, similarity:number}>}
 */
export function findDuplicates(existing, candidate) {
  const out = [];
  const candExpr = normalizeExpr(candidate.expression);
  for (const m of existing || []) {
    if (candExpr && normalizeExpr(m.expression) === candExpr) {
      out.push({ metric: m, reason: 'same-formula', similarity: 1 });
      continue;
    }
    const sim = textSimilarity(m.plainEnglish, candidate.plainEnglish);
    if (sim >= DUPLICATE_TEXT_THRESHOLD) {
      out.push({ metric: m, reason: 'similar-text', similarity: sim });
    }
  }
  return out;
}

// ------------------------------------------------------------
// Registry (local-only, in-memory + JSON export/import)
// ------------------------------------------------------------

export class MetricRegistry {
  constructor() {
    this._metrics = new Map(); // id -> metric
  }

  get size() { return this._metrics.size; }
  has(id) { return this._metrics.has(id); }
  get(id) { return this._metrics.get(id) || null; }
  list() { return [...this._metrics.values()]; }

  _uniqueId(name) {
    const base = slug(name) || 'metric';
    let id = base;
    let n = 2;
    while (this._metrics.has(id)) id = `${base}-${n++}`;
    return id;
  }

  /**
   * Add a fully-formed metric record. Assigns an id + timestamps. Does NOT run
   * duplicate detection itself — the caller runs findDuplicates first and
   * decides merge/keep-both, matching the spec's explicit prompt.
   * @returns {object} the stored metric
   */
  add(metric) {
    const now = Date.now();
    const id = metric.id && !this._metrics.has(metric.id) ? metric.id : this._uniqueId(metric.name);
    const record = {
      id,
      name: metric.name,
      plainEnglish: metric.plainEnglish || '',
      expression: metric.expression,
      columns: Array.isArray(metric.columns) ? metric.columns : [],
      status: METRIC_STATUSES.includes(metric.status) ? metric.status : DEFAULT_STATUS,
      owner: metric.owner || '',
      tag: metric.tag || '',
      computedValue: metric.computedValue ?? null,
      computedAt: metric.computedAt ?? null,
      computeError: metric.computeError ?? null,
      createdAt: metric.createdAt || now,
      updatedAt: now,
    };
    this._metrics.set(id, record);
    return record;
  }

  update(id, patch) {
    const cur = this._metrics.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id, updatedAt: Date.now() };
    if (!METRIC_STATUSES.includes(next.status)) next.status = cur.status;
    this._metrics.set(id, next);
    return next;
  }

  remove(id) { return this._metrics.delete(id); }

  setStatus(id, status) {
    if (!METRIC_STATUSES.includes(status)) throw new Error(`Unknown metric status "${status}"`);
    return this.update(id, { status });
  }

  /** Counts by status for the Trust Strip certification field. */
  statusCounts() {
    const counts = { certified: 0, reviewed: 0, exploratory: 0, total: 0 };
    for (const m of this._metrics.values()) {
      counts[m.status] = (counts[m.status] || 0) + 1;
      counts.total += 1;
    }
    return counts;
  }

  /** The exportable local-only JSON payload (parsed object, not a string). */
  toJSON() {
    return { kind: 'dataglow-metric-registry', version: 1, metrics: this.list() };
  }

  /** Rebuild a registry from a toJSON() payload (bare array also accepted). */
  static fromJSON(payload) {
    const reg = new MetricRegistry();
    const arr = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.metrics) ? payload.metrics : []);
    for (const m of arr) {
      if (m && typeof m === 'object' && m.name && m.expression) reg.add(m);
    }
    return reg;
  }
}

// ------------------------------------------------------------
// DOM presenter (gated behind the `metricStudio` flag by the caller)
// ------------------------------------------------------------

function statusBadge(status) {
  const cls = { certified: 'badge-pass', reviewed: 'badge-warn', exploratory: 'badge-idle' };
  return el('span', { class: `badge ${cls[status] || 'badge-idle'}`, 'data-testid': 'metric-status-badge' }, status);
}

function metricValueText(m) {
  if (m.computeError) return `compute error: ${m.computeError}`;
  if (m.computedValue == null) return 'not yet computed';
  const v = typeof m.computedValue === 'number' ? formatNumber(m.computedValue) : String(m.computedValue);
  return `${v}${m.computedAt ? ` · ${timeAgo(m.computedAt)}` : ''}`;
}

/**
 * Render the Metric Studio panel into `host`: the create form (plain English +
 * auto-suggested formula with a "Show the math" toggle), the saved-metric list
 * with status badges, and the duplicate-detection prompt when a candidate
 * collides. All DOM built with the shared `el` helper + existing CSS classes.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {MetricRegistry} opts.registry
 * @param {Array<{name:string}|string>} [opts.schemaCols] loaded dataset columns
 * @param {string} [opts.table] loaded table name (for compute)
 * @param {{runQuery:Function}} [opts.engine] the DuckDB engine
 * @param {(m:object)=>void} [opts.onOpenProof] open the Proof Drawer for a metric
 * @param {(msg:string,type?:string)=>void} [opts.onToast]
 * @param {()=>void} [opts.onChange] called after the registry mutates
 */
export function renderMetricStudio(opts = {}) {
  const {
    host, registry, schemaCols = [], table = null, engine = null,
    onOpenProof = () => {}, onToast = () => {}, onChange = () => {},
  } = opts;
  if (!host || !registry) return;
  host.innerHTML = '';

  const hasData = normalizeSchema(schemaCols).size > 0;

  // ---- Create form ----
  const nameInput = el('input', { class: 'input', type: 'text', placeholder: 'Metric name (e.g. Readmission Rate)', 'data-testid': 'metric-name' });
  const plainInput = el('textarea', { class: 'input', rows: '2', placeholder: 'Plain English (e.g. readmission rate = readmissions / total_discharges)', 'data-testid': 'metric-plain' });
  const exprInput = el('input', { class: 'input', type: 'text', placeholder: 'Formula (DuckDB expression)', 'data-testid': 'metric-expr' });
  const exprRow = el('div', { style: 'display:none; margin-top:var(--space-2);' }, [
    el('label', { style: 'font-size:var(--text-sm); color:var(--color-text-muted);' }, 'Formula (raw DuckDB expression):'),
    exprInput,
  ]);
  const showMath = el('button', { class: 'btn btn-ghost', type: 'button', 'data-testid': 'metric-show-math' }, 'Show the math');
  showMath.addEventListener('click', () => {
    const open = exprRow.style.display === 'none';
    exprRow.style.display = open ? '' : 'none';
    showMath.textContent = open ? 'Hide the math' : 'Show the math';
  });
  // Auto-suggest the formula from plain English (editable via Show the math).
  plainInput.addEventListener('input', () => {
    if (exprInput.dataset.touched === '1') return;
    const s = suggestExpression(plainInput.value, schemaCols);
    if (s) exprInput.value = s;
  });
  exprInput.addEventListener('input', () => { exprInput.dataset.touched = '1'; });

  const ownerInput = el('input', { class: 'input', type: 'text', placeholder: 'Owner (optional)', 'data-testid': 'metric-owner' });
  const tagInput = el('input', { class: 'input', type: 'text', placeholder: 'Tag (optional)', 'data-testid': 'metric-tag' });
  const statusSel = el('select', { class: 'input', 'data-testid': 'metric-status-select' },
    METRIC_STATUSES.map(s => el('option', { value: s }, s)));

  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'metric-save' }, 'Create metric');
  const promptHost = el('div', { 'data-testid': 'metric-dup-prompt' });

  async function persist(candidate, { force = false } = {}) {
    const check = validateMetricDefinition(candidate, schemaCols);
    if (!check.valid) { onToast(check.errors.join(' '), 'error'); return; }
    candidate.columns = check.columns;

    if (!force) {
      const dups = findDuplicates(registry.list(), candidate);
      if (dups.length > 0) { renderDuplicatePrompt(candidate, dups); return; }
    }
    promptHost.innerHTML = '';

    // Actually compute the value against the loaded table (never a placeholder).
    let computed = { ok: false, value: null, computedAt: null, error: 'not computed' };
    if (table && engine) computed = await computeMetricValue({ table, expression: candidate.expression, engine });
    const stored = registry.add({
      ...candidate,
      computedValue: computed.ok ? computed.value : null,
      computedAt: computed.ok ? computed.computedAt : null,
      computeError: computed.ok ? null : computed.error,
    });
    onToast(`Metric "${stored.name}" saved${computed.ok ? '' : ' (formula did not compute)'}`, computed.ok ? 'success' : 'warn');
    nameInput.value = ''; plainInput.value = ''; exprInput.value = ''; exprInput.dataset.touched = '';
    ownerInput.value = ''; tagInput.value = '';
    onChange();
    renderList();
  }

  function renderDuplicatePrompt(candidate, dups) {
    promptHost.innerHTML = '';
    const first = dups[0];
    const box = el('div', { class: 'card', style: 'padding:var(--space-3); margin-top:var(--space-3); border:1px solid var(--color-warn, #b8860b);' }, [
      el('div', { style: 'font-weight:600; margin-bottom:var(--space-2);' },
        first.reason === 'same-formula'
          ? `A metric with the same formula already exists: "${first.metric.name}".`
          : `This looks ${Math.round(first.similarity * 100)}% similar to "${first.metric.name}".`),
      el('div', { style: 'display:flex; gap:var(--space-2);' }, [
        el('button', { class: 'btn btn-ghost', type: 'button', 'data-testid': 'metric-dup-merge',
          onclick: () => {
            // Merge = update the existing metric's definition in place.
            registry.update(first.metric.id, {
              plainEnglish: candidate.plainEnglish, expression: candidate.expression, columns: candidate.columns,
            });
            promptHost.innerHTML = '';
            onToast(`Merged into "${first.metric.name}"`, 'success');
            onChange(); renderList();
          } }, 'Merge into existing'),
        el('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'metric-dup-keepboth',
          onclick: () => persist(candidate, { force: true }) }, 'Keep both'),
      ]),
    ]);
    promptHost.appendChild(box);
  }

  saveBtn.addEventListener('click', () => {
    persist({
      name: nameInput.value.trim(),
      plainEnglish: plainInput.value.trim(),
      expression: exprInput.value.trim(),
      status: statusSel.value,
      owner: ownerInput.value.trim(),
      tag: tagInput.value.trim(),
    });
  });

  const form = el('div', { class: 'card', style: 'padding:var(--space-4); margin-bottom:var(--space-4);', 'data-testid': 'metric-studio-form' }, [
    el('div', { style: 'font-weight:600; margin-bottom:var(--space-3);' }, 'Define a metric'),
    nameInput,
    el('div', { style: 'margin-top:var(--space-2);' }, [plainInput]),
    el('div', { style: 'display:flex; gap:var(--space-2); margin-top:var(--space-2); flex-wrap:wrap;' }, [ownerInput, tagInput, statusSel]),
    el('div', { style: 'margin-top:var(--space-2);' }, [showMath]),
    exprRow,
    el('div', { style: 'margin-top:var(--space-3); display:flex; gap:var(--space-2);' }, [saveBtn]),
    hasData ? null : el('div', { style: 'margin-top:var(--space-2); font-size:var(--text-sm); color:var(--color-text-muted);' },
      'Load a dataset to tie metrics to real columns.'),
    promptHost,
  ]);

  // ---- Saved list ----
  const listHost = el('div', { 'data-testid': 'metric-studio-list' });
  function renderList() {
    listHost.innerHTML = '';
    const metrics = registry.list();
    if (metrics.length === 0) {
      listHost.appendChild(el('div', { class: 'empty-state', style: 'padding:var(--space-3);' }, 'No metrics defined yet.'));
      return;
    }
    for (const m of metrics) {
      const row = el('div', { class: 'card', style: 'padding:var(--space-3); margin-bottom:var(--space-2); cursor:pointer;', 'data-testid': 'metric-row',
        onclick: () => onOpenProof(m) }, [
        el('div', { style: 'display:flex; justify-content:space-between; align-items:center; gap:var(--space-2);' }, [
          el('div', { style: 'font-weight:600;' }, m.name),
          statusBadge(m.status),
        ]),
        el('div', { style: 'font-size:var(--text-sm); color:var(--color-text-muted); margin-top:2px;' }, m.plainEnglish || m.expression),
        el('div', { style: 'font-size:var(--text-sm); margin-top:2px;' }, `Value: ${metricValueText(m)}`),
      ]);
      listHost.appendChild(row);
    }
  }
  renderList();

  host.appendChild(form);
  host.appendChild(el('div', { style: 'font-weight:600; margin:var(--space-3) 0 var(--space-2);' }, 'Saved metrics'));
  host.appendChild(listHost);
}
