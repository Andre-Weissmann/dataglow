// ============================================================
// DATAGLOW — Glow Canvas <-> Cleaning Crew bridge test suite (Batch 4)
// ============================================================
// Proves the one-shot handoff contract introduced in
// js/app-shell/tabs/glow-canvas-tab.js (requestGlowCanvasPrefill) and consumed
// by js/app-shell/tabs/cleaning-crew-tab.js's "Add to Glow Canvas" button:
//
//   - requestGlowCanvasPrefill(table) is a plain in-memory setter (no DOM, no
//     IndexedDB) and is safe to call before any tab has ever rendered.
//   - The VERY NEXT renderGlowCanvasTab() call opens Glow Canvas with that
//     table already selected in the add-chart form.
//   - It is consumed EXACTLY ONCE: a second, unrelated render (e.g. from a
//     later onChange-triggered redraw, or a later unrelated tab activation)
//     does NOT re-open the form with a stale table.
//   - With the glowCanvas flag OFF, renderGlowCanvasTab() is a no-op (matches
//     existing Batch 1 behavior) regardless of any pending prefill request.
//
// A minimal DOM + IndexedDB-free shim is used, in the same style as
// test/glow-canvas.test.mjs's drag-and-drop block, since renderGlowCanvasTab
// drives document.getElementById('glow-canvas-body') and then delegates all
// actual rendering to the real (also-under-test) glowCanvas.renderCanvas.
//
// RUN WITH: node test/glow-canvas-cleaning-crew-bridge.test.mjs

import { configureFlags } from '../js/build/build-flags.js';
import { requestGlowCanvasPrefill, renderGlowCanvasTab } from '../js/app-shell/tabs/glow-canvas-tab.js';
import { state } from '../js/app-shell/state.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---- minimal DOM shim (mirrors test/glow-canvas.test.mjs's makeEl) ----
const registry = {};
function makeEl(tag) {
  const classes = new Set();
  const node = {
    tagName: tag, children: [], attributes: {}, style: {}, _listeners: {},
    className: '', textContent: '', value: '',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') registry[v] = this; },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
  };
  // renderCanvas resets the host via `host.innerHTML = ''` before re-rendering
  // (real DOM semantics: setting innerHTML empties the node's children); the
  // setter here mirrors that so a SECOND render doesn't leave stale children
  // (like a previous test's form) sitting alongside the freshly appended ones.
  let _innerHTML = '';
  Object.defineProperty(node, 'innerHTML', {
    get() { return _innerHTML; },
    set(v) { _innerHTML = v; if (v === '') node.children = []; },
  });
  return node;
}
function installDom() {
  const host = makeEl('div');
  host.setAttribute('id', 'glow-canvas-body');
  registry['glow-canvas-body'] = host;
  global.document = {
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: (id) => registry[id] || null,
  };
  return host;
}
function findForm(host) {
  return host.children.find((c) => c.attributes && c.attributes['data-testid'] === 'glow-canvas-add-form');
}
function findField(form, testid) {
  for (const label of form.children) {
    const input = label.children && label.children[1];
    if (input && input.attributes && input.attributes['data-testid'] === testid) return input;
  }
  return null;
}

// ---- Case 1: glowCanvas flag OFF -> renderGlowCanvasTab is a no-op, even with a pending prefill ----
{
  configureFlags({ glowCanvas: { enabled: false } });
  const host = installDom();
  state.datasets = [{ table: 'crew_report_pdf', name: 'crew_report.pdf', rowCount: 3, cols: [] }];
  requestGlowCanvasPrefill('crew_report_pdf');
  await renderGlowCanvasTab();
  ok(host.innerHTML === '', 'with glowCanvas OFF, renderGlowCanvasTab clears the host and never renders the form, even with a pending prefill request');
  delete global.document;
}

// ---- Case 2: glowCanvas flag ON, a pending prefill was requested -> the very next render opens pre-filled ----
{
  configureFlags({ glowCanvas: { enabled: true } });
  const host = installDom();
  state.datasets = [{ table: 'sales', name: 'sales.csv', rowCount: 10, cols: [] }, { table: 'crew_report_pdf', name: 'crew_report.pdf', rowCount: 3, cols: [] }];
  requestGlowCanvasPrefill('crew_report_pdf');
  await renderGlowCanvasTab();
  const form = findForm(host);
  ok(!!form, 'renderGlowCanvasTab renders the add-chart form when the flag is on');
  ok(form.attributes.style.includes('display:flex'), 'a pending prefill request opens the form on the very next render');
  const tableField = findField(form, 'glow-canvas-field-table');
  ok(tableField.value === 'crew_report_pdf', 'the table field is pre-set to the requested table on the very next render');
  delete global.document;
}

// ---- Case 3: the prefill is one-shot -- a second, later render does not re-open with a stale table ----
{
  configureFlags({ glowCanvas: { enabled: true } });
  const host = installDom();
  state.datasets = [{ table: 'crew_report_pdf', name: 'crew_report.pdf', rowCount: 3, cols: [] }];
  requestGlowCanvasPrefill('crew_report_pdf');
  await renderGlowCanvasTab(); // consumes the pending prefill
  await renderGlowCanvasTab(); // a second, unrelated activation (e.g. switching tabs away and back)
  const form = findForm(host);
  ok(form.attributes.style.includes('display:none'), 'a second render after the prefill was already consumed does not re-open the form (one-shot, not sticky)');
  delete global.document;
}

// ---- Case 4: no prefill was ever requested -> ordinary render, form closed (baseline, unaffected) ----
{
  configureFlags({ glowCanvas: { enabled: true } });
  const host = installDom();
  state.datasets = [{ table: 'sales', name: 'sales.csv', rowCount: 10, cols: [] }];
  await renderGlowCanvasTab();
  const form = findForm(host);
  ok(form.attributes.style.includes('display:none'), 'with no prefill ever requested, the form stays closed by default (Batch 1 behavior unchanged)');
  delete global.document;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
