// ============================================================
// DATAGLOW — Query Memory UI (batch 2 of N)
// ============================================================
// WHAT THIS IS: the thin UI layer for the pure batch-1 module
// (js/provenance/query-memory.js). It surfaces a compact "seen before?" BADGE
// near a SQL/Python/R result and, on click, expands the real history
// (who ran it, how many times, when last) that summarizeEntries() already
// computed — no new matching logic, no new persistence shape, no new
// vocabulary. It only PRESENTS what record()/lookup() already returned.
//
// Identity split (same convention as readiness-gate-ui.js / trust-strip.js):
// buildQueryMemoryBadgeModel() is a PURE, Node-testable function (no DOM);
// renderQueryMemoryBadge() is the thin DOM renderer left to the browser/e2e
// path, exactly like readiness-gate-ui.js's renderReadinessBadge().
//
// WHAT THIS BATCH DELIBERATELY DOES NOT DO YET:
//   - No fuzzy/near-match surface — batch 1's exact-match floor is presented
//     honestly ("(exact match)"), never implying a smarter comparison.
//   - No cross-device history — the log is local to this browser's IndexedDB,
//     same zero-upload/local-first posture as every other DataGlow store.
//   - No author/login system — DataGlow has none; the caller passes whatever
//     it has (defaults to 'you' for this single-user local app), matching the
//     pure module's own honest 'unknown' fallback when nothing is supplied.

import { el } from '../app-shell/utils.js';

// Reuse the existing pill vocabulary from css/base.css — no new colors.
//   seen  -> a neutral/informational badge (not a pass/fail grade, so the
//            plain `badge` class, not badge-a/c/d, avoids implying a verdict)
//   new   -> the same neutral badge with muted text, honestly "nothing to
//            report yet" rather than a false-negative-looking warning color
const BADGE_CLASS = 'badge';

/**
 * Turn a record()/lookup() result into a pure, DOM-free badge view model.
 * Never throws; a missing/malformed result yields an honest "new" state.
 * @param {{seen?:boolean, count?:number, authors?:string[], lastSeenAt?:number|null, priorSeenCount?:number}} lookupResult
 * @returns {{seen:boolean, label:string, title:string, detail:string, badgeClass:string}}
 */
export function buildQueryMemoryBadgeModel(lookupResult) {
  const r = lookupResult && typeof lookupResult === 'object' ? lookupResult : {};
  const seen = !!r.seen;
  const count = Number.isFinite(r.count) ? r.count : 0;
  const authors = Array.isArray(r.authors) ? r.authors : [];
  const lastSeenAt = Number.isFinite(r.lastSeenAt) ? r.lastSeenAt : null;

  if (!seen) {
    return {
      seen: false,
      label: 'New query',
      title: 'Not seen before on this device (exact match).',
      detail: 'New query — not seen before on this device.',
      badgeClass: BADGE_CLASS,
    };
  }

  const times = count === 1 ? 'once' : `${count}×`;
  const who = authors.length === 1 ? `by ${authors[0]}` : `by ${authors.length} people`;
  const when = lastSeenAt != null
    ? `, most recently ${new Date(lastSeenAt).toISOString().slice(0, 19).replace('T', ' ')} UTC`
    : '';
  return {
    seen: true,
    label: `Seen before · ${times}`,
    title: `Run ${times} ${who}${when} (exact match).`,
    detail: `Seen before — run ${times} ${who}${when} (exact match).`,
    badgeClass: BADGE_CLASS,
  };
}

/**
 * Render the compact "seen before?" badge into `host`. The badge is a button;
 * clicking it toggles an inline panel with the same detail text
 * buildQueryMemoryBadgeModel() already computed. Purely informational: it
 * never blocks, delays, or alters the run it sits beside.
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {ReturnType<import('./query-memory.js').summarizeEntries>} opts.lookupResult
 * @returns {{model:object}|undefined}
 */
export function renderQueryMemoryBadge(opts = {}) {
  const { host, lookupResult } = opts;
  if (!host) return;
  const model = buildQueryMemoryBadgeModel(lookupResult);
  host.innerHTML = '';

  const detail = el('div', {
    'data-testid': 'query-memory-detail',
    style: 'display:none; margin-top:6px; padding:8px 10px; background:var(--color-bg-subtle,#f6f8fa); border-radius:6px; font-size:12px; color:var(--color-text-muted);',
  }, model.detail);

  const badge = el('button', {
    type: 'button',
    class: model.badgeClass,
    'data-testid': 'query-memory-badge',
    'data-seen': model.seen ? 'true' : 'false',
    'aria-expanded': 'false',
    title: model.title,
    style: 'cursor:pointer; border:none;',
  }, [
    el('span', { style: `width:8px; height:8px; border-radius:50%; background:${model.seen ? '#5b7cfa' : '#9e9e9e'}; display:inline-block;` }),
    el('span', {}, model.label),
  ]);
  badge.addEventListener('click', () => {
    const open = detail.style.display === 'none';
    detail.style.display = open ? '' : 'none';
    badge.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  const wrap = el('div', {
    'data-testid': 'query-memory',
    class: 'query-memory',
    style: 'margin-top:var(--space-2);',
  }, [badge, detail]);
  host.appendChild(wrap);
  return { model };
}
