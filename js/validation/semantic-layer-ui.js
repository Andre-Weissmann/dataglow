// ============================================================
// DATAGLOW — Semantic / Metrics Layer, SQL-tab presenter (Trust Passport Batch 1)
// ============================================================
// A minimal, unobtrusive "Define a metric" affordance for the SQL tab. It is a
// THIN presenter over js/validation/semantic-layer.js: it owns only the form DOM
// and delegates every definition/storage decision to registerMetric(). It reads
// no flag itself — main.js decides, from the `semanticMetricsLayer` flag, whether
// to offer it at all (see shouldOfferMetricDefiner()).
//
// This is a HUMAN-authored-content flow, not an AI-write flow: a person types the
// metric name + canonical expression + (optional) description and clicks Register.
// Nothing here invents, infers, or auto-fills a definition. The mounted form is
// the only way a definition enters the in-memory registry from the UI.
//
// Names it plainly: this defines a metric in a local dictionary. It is not
// "AI-powered" and makes no network call.

import { el } from '../app-shell/utils.js';
import { registerMetric, getRegisteredMetrics } from './semantic-layer.js';

/**
 * The single gate the SQL tab checks before offering the affordance. Pure — no
 * DOM, no flag read of its own.
 * @param {{enabled?:boolean}} [arg]
 * @returns {boolean}
 */
export function shouldOfferMetricDefiner({ enabled } = {}) {
  return enabled === true;
}

function renderRegisteredList(listHost) {
  const metrics = getRegisteredMetrics();
  listHost.innerHTML = '';
  if (!metrics.length) {
    listHost.appendChild(el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-text-faint);',
    }, 'No metrics defined yet. A defined metric lets the Local Analysis Contract flag a query that computes it differently.'));
    return;
  }
  listHost.appendChild(el('div', {
    style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:6px;',
  }, `Defined metrics (${metrics.length}) — in-memory only, cleared on reload:`));
  listHost.appendChild(el('ul', {
    style: 'margin:0; padding-left:0; list-style:none; display:flex; flex-direction:column; gap:6px;',
  }, metrics.map(m => el('li', {
    style: 'font-size:var(--text-xs); display:flex; flex-direction:column; gap:2px;',
  }, [
    el('span', { class: 'mono', style: 'font-weight:600;' }, m.name),
    el('span', { class: 'mono', style: 'color:var(--color-text-muted);' }, m.expression),
    m.description ? el('span', { style: 'color:var(--color-text-faint);' }, m.description) : null,
  ]))));
}

/**
 * Mount the metric-definer form into `host` (emptied first).
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host                container to render into
 * @param {(def:object)=>void} [opts.onRegister] called with the stored def after
 *   a successful registration (e.g. so the caller can re-run the contract check)
 * @param {(msg:string,type?:string)=>void} [opts.onToast]
 */
export function mountMetricDefiner({ host, onRegister, onToast } = {}) {
  if (!host) return;
  host.innerHTML = '';

  const nameInput = el('input', {
    type: 'text', class: 'mono', 'data-testid': 'metric-name-input',
    placeholder: 'net_revenue',
    style: 'width:100%; padding:6px 8px; font-size:var(--text-xs);',
  });
  const exprInput = el('input', {
    type: 'text', class: 'mono', 'data-testid': 'metric-expression-input',
    placeholder: 'SUM(amount) - SUM(refund_amount)',
    style: 'width:100%; padding:6px 8px; font-size:var(--text-xs);',
  });
  const descInput = el('input', {
    type: 'text', 'data-testid': 'metric-description-input',
    placeholder: 'Revenue after refunds (optional)',
    style: 'width:100%; padding:6px 8px; font-size:var(--text-xs);',
  });

  const field = (label, input) => el('label', {
    style: 'display:flex; flex-direction:column; gap:3px; font-size:var(--text-xs); color:var(--color-text-muted);',
  }, [label, input]);

  const listHost = el('div', { 'data-testid': 'metric-list' });

  const registerBtn = el('button', {
    class: 'btn btn-primary', 'data-testid': 'metric-register-btn',
    style: 'font-size:var(--text-xs); padding:6px 12px; align-self:flex-start;',
    onclick: () => {
      const name = nameInput.value.trim();
      const expression = exprInput.value.trim();
      if (!name || !expression) {
        onToast?.('A metric needs both a name and a canonical expression.', 'warn');
        return;
      }
      let stored;
      try {
        stored = registerMetric({ name, expression, description: descInput.value.trim(), owner: 'ui' });
      } catch (err) {
        onToast?.(`Could not define metric: ${err.message}`, 'error');
        return;
      }
      nameInput.value = '';
      exprInput.value = '';
      descInput.value = '';
      renderRegisteredList(listHost);
      onToast?.(`Defined metric "${stored.name}". The Local Analysis Contract will now flag queries that compute it differently.`, 'success');
      onRegister?.(stored);
    },
  }, 'Register metric');

  const card = el('div', {
    class: 'card', 'data-testid': 'metric-definer-card',
    style: 'margin-top:var(--space-2); padding:var(--space-3); display:flex; flex-direction:column; gap:var(--space-2);',
  }, [
    el('div', { style: 'font-weight:600; font-size:var(--text-sm);' }, 'Define a metric'),
    el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' },
      'Record what a metric MEANS so a query that computes it differently gets flagged. Definitions are local and in-memory only — nothing is uploaded.'),
    field('Name', nameInput),
    field('Canonical expression', exprInput),
    field('Description', descInput),
    registerBtn,
    listHost,
  ]);

  host.appendChild(card);
  renderRegisteredList(listHost);
}
