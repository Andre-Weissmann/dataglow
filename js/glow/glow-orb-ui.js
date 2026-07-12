// ============================================================
// DATAGLOW — The Glow (topbar orb UI, Batch 2 of 2)
// ============================================================
// WHAT THIS IS: the thin UI layer for the pure aggregator scored in Batch 1
// (js/glow/glow-signal.js, computeGlowSignal/explainGlowSignal). It surfaces one
// at-a-glance glowing orb in the topbar whose color reflects the composed
// verdict's `status`, and — on click — expands an inline panel listing the
// status label + score, each composed signal as a label/value row, an honest
// next-action callout when present, and a "Show the math" toggle revealing the
// raw explainGlowSignal() text. It re-runs NOTHING and invents NO new verdict
// logic, score, or severity vocabulary — it only PRESENTS what computeGlowSignal()
// already returned.
//
// WHAT IT DELIBERATELY DOES NOT DO: this batch ships dark behind the `glowOrb`
// flag (enabled:false); it is wired into the topbar but renders nothing until the
// flag flips on. A future hold-to-unfold gesture is NOT built here — interaction
// is click-to-expand only, mirroring the Readiness Gate badge's Show-the-math
// toggle. No new network/engine calls; the orb reads only the already-composed
// verdict handed to it.
//
// Identity split (same convention as readiness-gate-ui.js / trust-strip.js): the
// model builder (buildGlowOrbModel) is a PURE, Node-testable function with no
// DOM; the renderer (renderGlowOrb) turns that model into DOM and is thin enough
// to leave to the browser/e2e path.

import { el } from '../app-shell/utils.js';
import { explainGlowSignal } from './glow-signal.js';

// Reuse the Trust Strip's field-state dot colors VERBATIM (js/trust/trust-strip.js
// STATE_DOT) — we invent no new colors. The Glow status vocabulary is the same
// ok/warn/bad/idle the strip and the Batch-1 aggregator already share.
const STATE_DOT = { ok: '#2e7d32', warn: '#b8860b', bad: '#c62828', idle: '#9e9e9e' };

// Short human label per status — plain words, no new severity vocabulary.
const STATUS_LABEL = { ok: 'Glowing', warn: 'Caution', bad: 'Alert', idle: 'Idle' };

/**
 * Turn a Glow verdict (from computeGlowSignal) into a pure, DOM-free orb view
 * model. Never throws; a missing/malformed verdict yields an honest "idle" model
 * rather than a fabricated status.
 * @param {ReturnType<import('./glow-signal.js').computeGlowSignal>} glowResult
 * @returns {{
 *   status:'ok'|'warn'|'bad'|'idle',
 *   tone:'ok'|'warn'|'bad'|'idle',
 *   dotColor:string,
 *   scoreText:string,
 *   label:string,
 *   summary:string,
 *   nextActionLabel:(string|null),
 *   signals:Array<{source:string,label:string,value:string,state:string,detail:string}>
 * }}
 */
export function buildGlowOrbModel(glowResult) {
  const g = (glowResult && typeof glowResult === 'object') ? glowResult : null;
  const status = g && typeof g.status === 'string' ? g.status : 'idle';
  const tone = STATE_DOT[status] ? status : 'idle';
  const score = g && Number.isFinite(g.score) ? g.score : 0;
  // Only the readiness-gate branch produces a real 0-100 number; when the verdict
  // came from folding trust states (score 0) we show no number, mirroring the
  // gate badge's "—" placeholder, rather than a misleading 0/100.
  const scoreText = tone === 'idle' || score === 0 ? '—' : `${score}/100`;
  const signals = g && Array.isArray(g.signals) ? g.signals : [];
  const nextAction = g && g.nextAction && typeof g.nextAction === 'object' ? g.nextAction : null;
  const nextActionLabel = nextAction && typeof nextAction.label === 'string' ? nextAction.label : null;

  return {
    status: tone,
    tone,
    dotColor: STATE_DOT[tone],
    scoreText,
    label: STATUS_LABEL[tone] || STATUS_LABEL.idle,
    summary: g && typeof g.summary === 'string' ? g.summary : 'No dataset signals available.',
    nextActionLabel,
    signals,
  };
}

/**
 * Render the compact Glow orb into `host`. The orb is a ~30px circular button
 * with a colored dot/ring reflecting the verdict; clicking it toggles an inline
 * panel (initially display:none) listing status/score, each signal as a
 * label/value row, an honest next-action callout when present, and a
 * "Show the math" toggle revealing the raw explainGlowSignal() text — the same
 * click-to-expand interaction the Readiness Gate badge uses. Purely informational:
 * it never blocks or alters anything it sits beside.
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {ReturnType<import('./glow-signal.js').computeGlowSignal>} opts.glowResult
 * @returns {{model:object}|undefined}
 */
export function renderGlowOrb(opts = {}) {
  const { host, glowResult } = opts;
  if (!host) return;
  const model = buildGlowOrbModel(glowResult);
  host.innerHTML = '';

  // Raw "show the math" node — hidden until the sub-toggle is clicked.
  const math = el('pre', {
    'data-testid': 'glow-orb-math',
    style: 'display:none; margin:8px 0 0; padding:10px; background:var(--color-bg-subtle,#f6f8fa); border-radius:var(--radius-2,6px); overflow:auto; font-size:var(--text-xs,12px); white-space:pre-wrap;',
  }, explainGlowSignal(glowResult));

  const mathToggle = el('button', {
    type: 'button',
    'data-testid': 'glow-orb-math-toggle',
    'aria-expanded': 'false',
    style: 'cursor:pointer; border:none; background:none; padding:0; margin-top:6px; color:var(--color-text-muted); font-size:var(--text-xs,12px); text-decoration:underline;',
  }, 'Show the math');
  mathToggle.addEventListener('click', () => {
    const open = math.style.display === 'none';
    math.style.display = open ? '' : 'none';
    mathToggle.textContent = open ? 'Hide the math' : 'Show the math';
    mathToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // Per-signal label/value rows — every row traces to a real composed signal.
  const signalRows = model.signals.map((s) => el('div', {
    class: 'glow-orb-signal',
    style: 'display:flex; justify-content:space-between; gap:var(--space-3,12px); font-size:var(--text-xs,12px); padding:2px 0;',
  }, [
    el('span', { style: 'display:flex; align-items:center; gap:6px;' }, [
      el('span', { style: `width:7px; height:7px; border-radius:50%; background:${STATE_DOT[s.state] || STATE_DOT.idle}; display:inline-block;` }),
      el('span', {}, typeof s.label === 'string' ? s.label : ''),
    ]),
    el('span', { style: 'color:var(--color-text-muted); text-align:right;' }, typeof s.value === 'string' ? s.value : ''),
  ]));

  const panelChildren = [
    el('div', {
      style: 'font-weight:600; display:flex; justify-content:space-between; gap:var(--space-3,12px);',
    }, [
      el('span', {}, model.label),
      el('span', { style: 'color:var(--color-text-muted);' }, model.scoreText),
    ]),
    el('div', { style: 'font-size:var(--text-xs,12px); color:var(--color-text-muted); margin:4px 0 8px;' }, model.summary),
    signalRows.length
      ? el('div', {}, signalRows)
      : el('div', { style: 'font-size:var(--text-xs,12px); color:var(--color-text-muted);' }, 'No signals composed.'),
  ];
  if (model.nextActionLabel) {
    panelChildren.push(el('div', {
      class: 'glow-orb-next-action',
      'data-testid': 'glow-orb-next-action',
      style: 'margin-top:8px; padding:6px 8px; border-radius:var(--radius-2,6px); background:var(--color-bg-subtle,#f6f8fa); font-size:var(--text-xs,12px); font-weight:600;',
    }, model.nextActionLabel));
  }
  panelChildren.push(mathToggle, math);

  const panel = el('div', {
    'data-testid': 'glow-orb-panel',
    class: 'glow-orb-panel',
    style: 'display:none; position:absolute; top:calc(100% + 6px); right:0; z-index:50; min-width:240px; max-width:320px; padding:var(--space-3,12px); background:var(--color-surface,#fff); border:1px solid var(--color-border,#e2e2e2); border-radius:var(--radius-3,8px); box-shadow:0 6px 20px rgba(0,0,0,0.14);',
  }, panelChildren);

  const orb = el('button', {
    type: 'button',
    class: 'glow-orb',
    'data-testid': 'glow-orb',
    'data-status': model.status,
    'aria-expanded': 'false',
    'aria-label': `Data glow: ${model.label} ${model.scoreText}`,
    title: model.summary,
    style: `width:30px; height:30px; border-radius:50%; cursor:pointer; border:2px solid ${model.dotColor}; background:${model.dotColor}22; display:inline-flex; align-items:center; justify-content:center; padding:0;`,
  }, [
    el('span', { style: `width:12px; height:12px; border-radius:50%; background:${model.dotColor}; display:inline-block;` }),
  ]);
  orb.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? '' : 'none';
    orb.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  const wrap = el('div', {
    'data-testid': 'glow-orb-wrap',
    class: 'glow-orb-wrap',
    style: 'position:relative; display:inline-flex; align-items:center;',
  }, [orb, panel]);
  host.appendChild(wrap);
  return { model };
}
