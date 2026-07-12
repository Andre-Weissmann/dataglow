// ============================================================
// DATAGLOW — AI Readiness Gate UI badge (batch 2 of 4)
// ============================================================
// WHAT THIS IS: the thin UI layer for the pure gate scored in batch 1
// (js/gate/readiness-gate.js). It surfaces a compact pass/fail BADGE near a
// query/metric result and, on click, expands the exact human-readable reasons
// list explainGateReasons() already produces — no new verdict logic, no new
// severity vocabulary, no re-running of validation. It only PRESENTS the verdict
// computeReadinessGate() returned.
//
// WHAT IT DELIBERATELY DOES NOT DO YET (see NORTH_STAR.md "Build batches"):
//   - Batch 3: wire the verdict into js/agents/* as a HARD BLOCK. This badge is
//     purely INFORMATIONAL — it never blocks, delays, or gates anything for a
//     human. Humans always see the full result; the block is agents-only, later.
//   - Batch 4: expose the gate via any future MCP interface.
//
// Identity split (same convention as trust-strip.js / proof-drawer.js): the
// model builder is a PURE, Node-testable function (no DOM); the renderer turns
// that model into DOM and is thin enough to leave to the browser/e2e path.

import { el } from '../app-shell/utils.js';
import { explainGateReasons } from './readiness-gate.js';

// Reuse the existing pill vocabulary from css/base.css (.badge + grade colors)
// and the validation status tones — we invent no new colors here.
//   ready       -> green  (badge-a) : agent-consumable
//   blocked-hard -> red   (badge-d) : a layer hard-failed or the contract broke
//   blocked-soft -> amber (badge-c) : nothing hard-failed but below threshold
//   idle        -> neutral          : no validation evidence yet (honest "unknown",
//                                      NOT a failure)
const TONE_BADGE_CLASS = {
  ready: 'badge badge-a',
  'blocked-hard': 'badge badge-d',
  'blocked-soft': 'badge badge-c',
  idle: 'badge',
};

/**
 * Turn a gate verdict (from computeReadinessGate) into a pure, DOM-free badge
 * view model. Never throws; a missing/malformed verdict yields an honest "idle"
 * (not-evaluated) model rather than a red failure.
 * @param {ReturnType<import('./readiness-gate.js').computeReadinessGate>} gateResult
 * @returns {{
 *   status:'ready'|'blocked'|'idle',
 *   tone:'ready'|'blocked-hard'|'blocked-soft'|'idle',
 *   badgeClass:string,
 *   label:string,
 *   score:(number|null),
 *   scoreText:string,
 *   title:string,
 *   reasons:string,
 *   consumable:boolean
 * }}
 */
export function buildReadinessBadgeModel(gateResult) {
  if (!gateResult || typeof gateResult !== 'object') {
    return {
      status: 'idle', tone: 'idle', badgeClass: TONE_BADGE_CLASS.idle,
      label: 'Readiness not evaluated', score: null, scoreText: '—',
      title: 'Run validation to evaluate agent-readiness.',
      reasons: explainGateReasons(gateResult), consumable: false,
    };
  }

  const {
    agentConsumable = false,
    score = 0,
    failingLayers = [],
    blockedByContract = false,
    evaluatedLayerCount = 0,
    passingSummary = '',
  } = gateResult;

  // No evidence yet (validation not run) is neither pass nor fail — say so
  // honestly instead of showing a red "Not agent-ready".
  const noEvidence = evaluatedLayerCount === 0 && !blockedByContract;

  let status, tone, label;
  if (noEvidence) {
    status = 'idle'; tone = 'idle'; label = 'Readiness not evaluated';
  } else if (agentConsumable) {
    status = 'ready'; tone = 'ready'; label = 'Agent-ready';
  } else {
    status = 'blocked';
    const hard = failingLayers.length > 0 || blockedByContract;
    tone = hard ? 'blocked-hard' : 'blocked-soft';
    label = 'Not agent-ready';
  }

  return {
    status,
    tone,
    badgeClass: TONE_BADGE_CLASS[tone] || TONE_BADGE_CLASS.idle,
    label,
    score: noEvidence ? null : score,
    scoreText: noEvidence ? '—' : `${score}/100`,
    title: passingSummary || 'Agent-readiness verdict.',
    reasons: explainGateReasons(gateResult),
    consumable: !!agentConsumable,
  };
}

const TONE_DOT = { ready: '#2e7d32', 'blocked-hard': '#c62828', 'blocked-soft': '#b8860b', idle: '#9e9e9e' };

/**
 * Render the compact readiness badge into `host`. The badge is a button; clicking
 * it toggles an inline panel showing the full explainGateReasons() text — the
 * same click-to-expand interaction the Proof Drawer's "Show the math" toggle uses.
 * Purely informational: it never blocks or alters the result it sits beside.
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {ReturnType<import('./readiness-gate.js').computeReadinessGate>} opts.gateResult
 * @returns {{model:object}|undefined}
 */
export function renderReadinessBadge(opts = {}) {
  const { host, gateResult } = opts;
  if (!host) return;
  const model = buildReadinessBadgeModel(gateResult);
  host.innerHTML = '';

  const reasons = el('pre', {
    'data-testid': 'readiness-gate-reasons',
    style: 'display:none; margin:6px 0 0; padding:10px; background:var(--color-bg-subtle,#f6f8fa); border-radius:6px; overflow:auto; font-size:12px; white-space:pre-wrap;',
  }, model.reasons);

  const badge = el('button', {
    type: 'button',
    class: model.badgeClass,
    'data-testid': 'readiness-gate-badge',
    'data-status': model.status,
    'aria-expanded': 'false',
    title: model.title,
    style: 'cursor:pointer; border:none;',
  }, [
    el('span', { style: `width:8px; height:8px; border-radius:50%; background:${TONE_DOT[model.tone] || TONE_DOT.idle}; display:inline-block;` }),
    el('span', {}, `AI: ${model.label}`),
    el('span', { style: 'opacity:0.8; font-weight:500;' }, model.scoreText),
  ]);
  badge.addEventListener('click', () => {
    const open = reasons.style.display === 'none';
    reasons.style.display = open ? '' : 'none';
    badge.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  const wrap = el('div', {
    'data-testid': 'readiness-gate',
    class: 'readiness-gate',
    style: 'margin-top:var(--space-3);',
  }, [badge, reasons]);
  host.appendChild(wrap);
  return { model };
}
