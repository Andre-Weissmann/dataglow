// ============================================================
// DATAGLOW — The Glow topbar orb UI test suite (Batch 2 of 2)
// ============================================================
// Proves the PURE orb model builder (buildGlowOrbModel) turns a Batch-1 Glow
// verdict into the right status / tone / dot color / score text / label /
// nextActionLabel / signals — without any DOM — and that the thin renderer
// (renderGlowOrb) builds the orb button + an initially-hidden expand panel into
// a host, and is null-safe.
//
// The renderer touches the DOM via el() (js/app-shell/utils.js), which needs a
// `document`. No lightweight DOM shim exists in this repo (the sibling
// readiness-gate-ui / glow-path-ui tests only exercise their pure builders, and
// the heavier meeting-scribe-ui tests spin up real Chromium via playwright). To
// keep this test dependency-free AND still cover the renderer, we install a tiny
// self-contained fake `document` supporting exactly the surface el() + the
// renderer use (createElement/createTextNode, className/innerHTML/style,
// setAttribute/getAttribute, addEventListener/click, appendChild). It is NOT a
// general DOM — just enough to assert structure and the initial hidden state.
//
// RUN WITH: node test/glow-orb-ui.test.mjs  (pure logic + shimmed DOM, no browser)

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// --- minimal DOM shim (see header) --------------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.className = '';
    this._text = '';
    this._html = '';
    this._listeners = {};
  }
  set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = v; }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join('');
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    // The browser reflects the `style` attribute into element.style; mirror the
    // camelCased subset the renderer reads/writes (e.g. display).
    if (k === 'style') {
      for (const decl of String(v).split(';')) {
        const idx = decl.indexOf(':');
        if (idx === -1) continue;
        const prop = decl.slice(0, idx).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (prop) this.style[prop] = decl.slice(idx + 1).trim();
      }
    }
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type) { (this._listeners[type] || []).forEach((fn) => fn({ type })); }
  appendChild(node) { this.children.push(node); return node; }
  // Depth-first search by a matcher over the FakeNode tree.
  find(pred) {
    for (const c of this.children) {
      if (c instanceof FakeText) continue;
      if (pred(c)) return c;
      const deep = c.find(pred);
      if (deep) return deep;
    }
    return null;
  }
  findAll(pred, acc = []) {
    for (const c of this.children) {
      if (c instanceof FakeText) continue;
      if (pred(c)) acc.push(c);
      c.findAll(pred, acc);
    }
    return acc;
  }
  byTestId(id) { return this.find((n) => n.getAttribute('data-testid') === id); }
}
class FakeText { constructor(t) { this.text = String(t); } }

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (t) => new FakeText(t),
};

// Import AFTER the shim so el()'s module-level `document` reference resolves.
const { buildGlowOrbModel, renderGlowOrb } = await import('../js/glow/glow-orb-ui.js');
const { computeGlowSignal } = await import('../js/glow/glow-signal.js');

// Shared Trust Strip dot colors the orb must reuse verbatim.
const DOT = { ok: '#2e7d32', warn: '#b8860b', bad: '#c62828', idle: '#9e9e9e' };

function main() {
  // --- no input: honest idle model, well-formed, no throw ---
  {
    let threw = false; let m;
    try { m = buildGlowOrbModel(); } catch (_) { threw = true; }
    ok(!threw, 'no input: buildGlowOrbModel does not throw');
    ok(m.status === 'idle' && m.tone === 'idle', 'no input: status/tone idle');
    ok(m.dotColor === DOT.idle, 'no input: idle dot color reused from Trust Strip');
    ok(m.scoreText === '—', 'no input: score shown as em-dash, not a fake 0/100');
    ok(Array.isArray(m.signals) && m.signals.length === 0, 'no input: empty signals array');
    ok(m.nextActionLabel === null, 'no input: no nextActionLabel');
    ok(typeof m.summary === 'string' && m.summary.length > 0, 'no input: has a summary string');
    ok(buildGlowOrbModel(null).tone === 'idle', 'null input: safe idle');
    ok(buildGlowOrbModel(42).tone === 'idle', 'non-object input: safe idle');
  }

  // --- ok verdict -> tone 'ok', green dot, score echoed ---
  {
    const glow = computeGlowSignal({
      readinessGateResult: { agentConsumable: true, score: 91, evaluatedLayerCount: 5, failingLayers: [] },
    });
    const m = buildGlowOrbModel(glow);
    ok(m.status === 'ok' && m.tone === 'ok', 'gate ok: tone ok');
    ok(m.dotColor === DOT.ok, 'gate ok: green dot color');
    ok(m.scoreText === '91/100', 'gate ok: real gate score echoed');
    ok(m.nextActionLabel === null, 'gate ok: no next action when agent-ready');
  }

  // --- bad verdict + next action -> tone 'bad', red dot, nextActionLabel present ---
  {
    const glow = computeGlowSignal({
      readinessGateResult: {
        agentConsumable: false, score: 38, evaluatedLayerCount: 5,
        failingLayers: [{ layer: 'Physiological Plausibility' }],
      },
    });
    const m = buildGlowOrbModel(glow);
    ok(m.status === 'bad' && m.tone === 'bad', 'gate blocked: tone bad');
    ok(m.dotColor === DOT.bad, 'gate blocked: red dot color');
    ok(typeof m.nextActionLabel === 'string' && m.nextActionLabel.length > 0,
      'gate blocked: nextActionLabel present');
  }

  // --- no-gate trust fold -> no invented score, em-dash ---
  {
    const glow = computeGlowSignal({
      trustSignals: { loaded: true, fields: [{ label: 'Rows', value: '100', state: 'warn', detail: '' }] },
    });
    const m = buildGlowOrbModel(glow);
    ok(m.tone === 'warn', 'trust warn (no gate): tone warn');
    ok(m.scoreText === '—', 'trust warn (no gate): no fabricated score number');
    ok(m.signals.length === 1, 'trust warn: the composed signal is carried through');
  }

  // --- renderGlowOrb({host:null}) is a safe no-op ---
  {
    let threw = false; let r;
    try { r = renderGlowOrb({ host: null }); } catch (_) { threw = true; }
    ok(!threw, 'render with null host: does not throw');
    ok(r === undefined, 'render with null host: returns undefined (early return)');
  }

  // --- render into a (shimmed) host: orb button + panel initially hidden ---
  {
    const host = new FakeNode('div');
    const glow = computeGlowSignal({
      readinessGateResult: {
        agentConsumable: false, score: 40, evaluatedLayerCount: 4,
        failingLayers: [{ layer: 'Missingness Detective' }],
      },
    });
    const { model } = renderGlowOrb({ host, glowResult: glow });

    const orb = host.byTestId('glow-orb');
    ok(orb && orb.tagName === 'BUTTON', 'render: orb button with data-testid="glow-orb"');
    ok(orb.getAttribute('data-status') === 'bad', 'render: orb carries the verdict status');
    ok(orb.getAttribute('aria-expanded') === 'false', 'render: orb starts collapsed (aria-expanded false)');

    const panel = host.byTestId('glow-orb-panel');
    ok(panel, 'render: expand panel present');
    ok(panel.style.display === 'none', 'render: panel initially hidden (display:none)');

    const nextAction = host.byTestId('glow-orb-next-action');
    ok(nextAction && nextAction.textContent === model.nextActionLabel,
      'render: next-action callout shows the model nextActionLabel');

    // click toggles the panel open and flips aria-expanded
    orb.dispatch('click');
    ok(panel.style.display === '' && orb.getAttribute('aria-expanded') === 'true',
      'render: clicking the orb expands the panel');
    orb.dispatch('click');
    ok(panel.style.display === 'none' && orb.getAttribute('aria-expanded') === 'false',
      'render: clicking again collapses the panel');

    // "Show the math" toggle reveals the raw explain text
    const mathToggle = host.byTestId('glow-orb-math-toggle');
    const math = host.byTestId('glow-orb-math');
    ok(math.style.display === 'none', 'render: math block starts hidden');
    mathToggle.dispatch('click');
    ok(math.style.display === '' && mathToggle.textContent === 'Hide the math',
      'render: Show-the-math toggle reveals the raw explanation');
  }

  // --- render with no verdict still produces a well-formed idle orb ---
  {
    const host = new FakeNode('div');
    renderGlowOrb({ host, glowResult: undefined });
    const orb = host.byTestId('glow-orb');
    ok(orb && orb.getAttribute('data-status') === 'idle', 'render idle: orb renders with idle status');
    const panel = host.byTestId('glow-orb-panel');
    ok(panel.style.display === 'none', 'render idle: panel still initially hidden');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
