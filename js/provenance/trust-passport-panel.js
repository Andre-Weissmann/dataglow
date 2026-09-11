// ============================================================
// DATAGLOW — Trust Passport Panel (Batch 1.5: UI mount)
// ============================================================
// Batch 1 (js/provenance/trust-passport.js) built the pure composition
// engine. Batch 2 (js/provenance/trust-passport-export.js) built portable
// seal/verify/export on top of it. Neither is reachable from any UI — this
// file is the mount: one tab that calls both, verbatim, and renders what
// they return. It invents no new scoring, no new crypto, no new ledger.
//
// PURITY SPLIT (same discipline as proof-room.js):
//   • buildTrustPassportPanelPlan(ctx) — pure, DOM-free, never throws. Decides
//     whether the panel has enough state to build a passport and what the
//     one-line reason is when it doesn't. Unit-tested without a DOM.
//   • renderTrustPassportPanel(opts) — thin DOM presenter. Calls the plan,
//     then (when ready) calls the caller-supplied `onBuild` closure to get a
//     real passport from live app state, and lays out the summary,
//     permission table, and export/verify controls.
//
// HONEST NAMING (inherited from every module this composes): a Trust
// Passport is not a certification, not blockchain, and not a zero-knowledge
// proof. It only summarizes what the readiness gate, AI Touch Ledger, and
// Ownership Ledger already recorded.

import { el, escapeHtml } from '../app-shell/utils.js';
import { summarizeTrustPassport } from './trust-passport.js';

export const TRUST_PASSPORT_PANEL_DISCLAIMER =
  'The Trust Passport composes the readiness gate, AI Touch Ledger, and Ownership Ledger into one '
  + 'view. It is NOT a certification, NOT "blockchain", and NOT a zero-knowledge proof — it only '
  + 'reports what those modules already recorded.';

/**
 * Pure readiness check for the panel. Never throws.
 *
 * @param {object} ctx
 * @param {boolean} ctx.datasetLoaded  A dataset is loaded.
 * @returns {{ready:boolean, reason:string}}
 */
export function buildTrustPassportPanelPlan(ctx = {}) {
  const datasetLoaded = !!(ctx && ctx.datasetLoaded);
  if (!datasetLoaded) {
    return { ready: false, reason: 'Load a dataset to assemble its Trust Passport.' };
  }
  return { ready: true, reason: '' };
}

/**
 * Render permission rows from a passport's `permissions` array. Pure string
 * building, no DOM side effects beyond the returned elements.
 */
function renderPermissionRows(passport) {
  const statusColor = { allow: 'success', gate: 'warning', deny: 'error' };
  return (passport.permissions || []).map((p) => el('div', {
    style: 'display:flex; align-items:baseline; gap:var(--space-2); padding:4px 0; '
      + 'border-bottom:1px solid var(--color-border);',
  }, [
    el('span', {
      style: `min-width:9em; font-family:var(--font-mono); font-size:var(--text-xs); `
        + `font-weight:700; color:var(--color-${statusColor[p.status] || 'text-muted'});`,
    }, p.status.toUpperCase()),
    el('span', { style: 'font-size:var(--text-xs); min-width:11em;' }, p.capability),
    el('span', { style: 'font-size:var(--text-xs); color:var(--color-text-muted);' }, p.reason || ''),
  ]));
}

/**
 * Thin DOM presenter.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host                Container to render into (cleared first).
 * @param {object} opts.plan                      Result of buildTrustPassportPanelPlan(ctx).
 * @param {() => object} [opts.onBuild]           Called only when plan.ready — returns a real
 *   passport (output of buildTrustPassport() from trust-passport.js), built by the caller from
 *   live app state. This module never fabricates the four inputs a passport needs.
 * @param {(passport:object) => Promise<object>} [opts.onSeal]      Calls sealTrustPassport().
 * @param {(sealed:object) => Promise<object>} [opts.onVerify]      Calls verifyTrustPassportExport().
 * @param {(sealed:object, format:string) => string} [opts.onExport] Calls exportTrustPassport().
 * @param {(filename:string, content:string, mime:string) => void} [opts.downloadText]
 * @param {string} [opts.disclaimer]
 */
export function renderTrustPassportPanel(opts = {}) {
  const { host, plan } = opts;
  if (!host) return;
  const disclaimer = opts.disclaimer || TRUST_PASSPORT_PANEL_DISCLAIMER;
  host.innerHTML = '';

  host.appendChild(el('div', {
    class: 'card',
    'data-testid': 'trust-passport-disclaimer',
    style: 'margin-bottom:var(--space-4); padding:var(--space-3); font-size:var(--text-xs); '
      + 'color:var(--color-text-muted); border-left:3px solid var(--color-grade-a); '
      + 'background:var(--color-surface-2, transparent);',
  }, disclaimer));

  if (!plan || !plan.ready) {
    host.appendChild(el('div', {
      class: 'card',
      'data-testid': 'trust-passport-pending',
      style: 'padding:var(--space-4); font-size:var(--text-sm); color:var(--color-text-muted); font-style:italic;',
    }, (plan && plan.reason) || 'Not available yet.'));
    return;
  }

  let passport = null;
  try {
    passport = typeof opts.onBuild === 'function' ? opts.onBuild() : null;
  } catch (e) {
    host.appendChild(el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-error);',
    }, `Trust Passport could not be built: ${escapeHtml(e && e.message ? e.message : String(e))}`));
    return;
  }
  if (!passport || passport.kind !== 'dataglow-trust-passport') {
    host.appendChild(el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-text-muted); font-style:italic;',
    }, 'No passport available for the active dataset yet.'));
    return;
  }

  const summaryCard = el('section', {
    class: 'card',
    'data-testid': 'trust-passport-summary',
    style: 'margin-bottom:var(--space-4); padding:var(--space-4); display:flex; flex-direction:column; gap:var(--space-2);',
  });
  summaryCard.appendChild(el('div', {
    style: 'font-size:var(--text-md); font-weight:600;',
  }, passport.datasetLabel ? `Trust Passport — ${escapeHtml(passport.datasetLabel)}` : 'Trust Passport'));
  summaryCard.appendChild(el('div', {
    style: 'font-size:var(--text-sm); color:var(--color-text-muted);',
  }, summarizeTrustPassport(passport)));
  summaryCard.appendChild(el('div', {
    style: 'font-size:var(--text-xs); color:var(--color-text-faint); font-family:var(--font-mono);',
  }, `generated ${passport.generatedAt}`));
  host.appendChild(summaryCard);

  const permCard = el('section', {
    class: 'card',
    'data-testid': 'trust-passport-permissions',
    style: 'margin-bottom:var(--space-4); padding:var(--space-4);',
  });
  permCard.appendChild(el('div', {
    style: 'font-size:var(--text-sm); font-weight:600; margin-bottom:var(--space-2);',
  }, 'Agent permissions'));
  renderPermissionRows(passport).forEach((row) => permCard.appendChild(row));
  host.appendChild(permCard);

  // Export/verify — only shown when the caller wired both closures (i.e. the
  // trustPassportExport flag is on). With it off this section is simply
  // absent, matching every other dark-flag composition in this codebase.
  if (typeof opts.onSeal === 'function' && typeof opts.onExport === 'function') {
    const exportCard = el('section', {
      class: 'card',
      'data-testid': 'trust-passport-export',
      style: 'padding:var(--space-4); display:flex; flex-direction:column; gap:var(--space-2);',
    });
    exportCard.appendChild(el('div', {
      style: 'font-size:var(--text-sm); font-weight:600;',
    }, 'Portable export'));
    exportCard.appendChild(el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-text-muted);',
    }, 'Seal this passport into a portable file. Anyone can re-verify it independently — no DataGlow install, no network call.'));

    const note = el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint);' }, '');
    exportCard.appendChild(note);

    exportCard.appendChild(el('button', {
      class: 'btn btn-primary',
      style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start;',
      'data-testid': 'trust-passport-seal-download',
      onclick: () => {
        (async () => {
          note.textContent = 'Sealing…';
          try {
            const sealed = await opts.onSeal(passport);
            const json = opts.onExport(sealed, 'json');
            note.textContent = '';
            if (typeof opts.downloadText === 'function') {
              opts.downloadText('dataglow-trust-passport.json', json, 'application/json');
            }
            if (typeof opts.onVerify === 'function') {
              const check = await opts.onVerify(sealed);
              note.textContent = check.valid
                ? '✓ Commitment re-verified locally'
                : `✗ Commitment failed to verify: ${check.reason || ''}`;
              note.style.color = check.valid ? 'var(--color-success)' : 'var(--color-error)';
            }
          } catch (e) {
            note.textContent = 'Could not seal this passport: ' + (e && e.message ? e.message : String(e));
            note.style.color = 'var(--color-error)';
          }
        })();
      },
    }, 'Seal & download (.json)'));

    host.appendChild(exportCard);
  }
}
