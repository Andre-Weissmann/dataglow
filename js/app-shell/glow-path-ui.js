// ============================================================
// DATAGLOW — Glow Path UI (adaptive next-action rail, Batch A: presenter)
// ============================================================
// The thin UI layer for the pure decision function in js/app-shell/glow-path.js,
// mirroring the readiness-gate.js / readiness-gate-ui.js split. buildGlowPathBadgeModel
// is a PURE, Node-testable view-model builder (no DOM); renderGlowPath turns that
// model into a dismissible rail element inside a host. It PRESENTS the verdict the
// pure function returned — it invents no new messages and makes no decisions.
//
// The rail is purely informational: it never blocks or delays anything for a human.
// When the verdict carries no message, we render NOTHING (the host stays empty) —
// never an empty box.

import { el } from './utils.js';
import { CTA_ACTIONS } from './glow-path.js';

// Which icon glyph the rail shows for a given CTA action. Kept declarative so the
// pure model builder can pick an icon without touching the DOM. Reuses simple
// inline-SVG path data in the same style as the existing chrome.
const ICON_PATHS = {
  [CTA_ACTIONS.LOAD_DATA]: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M17 8 L12 3 L7 8 M12 3 L12 15',
  [CTA_ACTIONS.RUN_VALIDATE]: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  [CTA_ACTIONS.REVIEW_WARNINGS]: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
  [CTA_ACTIONS.SEE_FAILING_LAYERS]: 'M18 6 L6 18 M6 6 L18 18',
  [CTA_ACTIONS.SAVE_QUERY]: 'M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z',
  [CTA_ACTIONS.NONE]: 'M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z',
};

// A blocked/failing verdict gets the alert tone; everything else is the neutral
// primary tone. We reuse the existing rail CSS classes rather than new colors.
function toneFor(ctaAction) {
  return ctaAction === CTA_ACTIONS.SEE_FAILING_LAYERS ? 'blocked' : 'primary';
}

/**
 * Turn a glow-path verdict (from computeGlowPathState) into a pure, DOM-free view
 * model. Never throws. When the verdict has no message, `visible` is false and the
 * renderer draws nothing.
 * @param {ReturnType<import('./glow-path.js').computeGlowPathState>} glowPathState
 * @returns {{
 *   visible: boolean,
 *   message: (string|null),
 *   subMessage: (string|null),
 *   ctaLabel: (string|null),
 *   ctaAction: string,
 *   tone: string,
 *   densityLevel: string,
 *   showDetail: boolean,
 *   iconPath: string
 * }}
 */
export function buildGlowPathBadgeModel(glowPathState) {
  const s = (glowPathState && typeof glowPathState === 'object') ? glowPathState : {};
  const visible = typeof s.message === 'string' && s.message.length > 0;
  const ctaAction = s.ctaAction || CTA_ACTIONS.NONE;
  const densityLevel = s.densityLevel || 'low';
  return {
    visible,
    message: visible ? s.message : null,
    subMessage: s.subMessage != null ? s.subMessage : null,
    ctaLabel: s.ctaLabel != null ? s.ctaLabel : null,
    ctaAction,
    tone: toneFor(ctaAction),
    densityLevel,
    // The extra detail row (density chips) is only meaningful in the denser
    // presentation — matches the CSS: .density-low hides it, .density-high shows it.
    showDetail: densityLevel === 'high',
    iconPath: ICON_PATHS[ctaAction] || ICON_PATHS[CTA_ACTIONS.NONE],
  };
}

function iconSvg(pathData) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  for (const d of pathData.split(' M').map((seg, i) => (i === 0 ? seg : 'M' + seg))) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d.trim());
    svg.appendChild(p);
  }
  return svg;
}

/**
 * Render (or clear) the Glow Path rail into `host`. When the verdict has no
 * message, or has been dismissed this session for the given key, the host is
 * emptied and nothing renders — never an empty box.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {ReturnType<import('./glow-path.js').computeGlowPathState>} opts.glowPathState
 * @param {(action:string)=>void} [opts.onCtaClick] - called with the symbolic ctaAction.
 * @param {()=>void} [opts.onDismiss] - called when the × control is clicked.
 * @returns {{model:object}|undefined}
 */
export function renderGlowPath(opts = {}) {
  const { host, glowPathState, onCtaClick, onDismiss } = opts;
  if (!host) return;
  const model = buildGlowPathBadgeModel(glowPathState);
  host.innerHTML = '';
  if (!model.visible) return { model };

  const body = [
    el('div', { class: 'glow-path-label' }, 'Next'),
    el('div', { class: 'glow-path-message', 'data-testid': 'glow-path-message' }, model.message),
  ];
  if (model.subMessage) {
    body.push(el('div', { class: 'glow-path-sub' }, model.subMessage));
  }

  const children = [
    el('div', { class: 'glow-path-icon' }, [iconSvg(model.iconPath)]),
    el('div', { class: 'glow-path-body' }, body),
  ];

  if (model.ctaLabel) {
    const cta = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      'data-testid': 'glow-path-cta',
      'data-action': model.ctaAction,
    }, model.ctaLabel);
    cta.addEventListener('click', () => { if (typeof onCtaClick === 'function') onCtaClick(model.ctaAction); });
    children.push(el('div', { class: 'glow-path-actions' }, [cta]));
  }

  const dismiss = el('div', {
    class: 'glow-path-dismiss',
    'data-testid': 'glow-path-dismiss',
    title: 'Not now',
    role: 'button',
    'aria-label': 'Dismiss',
  }, [iconSvg('M18 6 L6 18 M6 6 L18 18')]);
  dismiss.addEventListener('click', () => { if (typeof onDismiss === 'function') onDismiss(); });
  children.push(dismiss);

  const rail = el('div', {
    class: `glow-path density-${model.densityLevel}`,
    'data-testid': 'glow-path',
    'data-action': model.ctaAction,
  }, children);
  host.appendChild(rail);
  return { model };
}

/**
 * Per-key, in-memory dismissal memory for the rail (same pattern as
 * createValidateFocusStore()): a Set of keys the user has dismissed this session.
 * Never persisted, never network, never IndexedDB — resets on reload, and each
 * dataset/key is tracked independently so dismissing the rail for one dataset
 * doesn't suppress it for another.
 */
export function createGlowPathDismissalStore() {
  const dismissed = new Set();
  return {
    markDismissed(key) { if (key) dismissed.add(key); },
    isDismissed(key) { return key ? dismissed.has(key) : false; },
    reset(key) {
      if (key) dismissed.delete(key);
      else dismissed.clear();
    },
  };
}
