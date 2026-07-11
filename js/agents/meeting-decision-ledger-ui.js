// ============================================================
// DATAGLOW — Meeting Decision Ledger, Meeting tab presenter (Gen 43, Part 3)
// ============================================================
// A small, separate UI surface bolted onto the bottom of the Meeting tab,
// underneath the existing paste/analyze screen (js/agents/meeting-scribe-ui.js).
// It does two things, and only two things:
//   1. Offers a [Save to ledger] button once a transcript has been analyzed,
//      so the analyst can explicitly decide to keep this meeting's pushback
//      moments, data requests, and action items permanently. Nothing is ever
//      saved automatically — this respects the same EMPOWERMENT CONSTRAINT
//      documented in meeting-scribe-agent.js: the analyst decides what
//      happens next, every time.
//   2. Offers a read-only "Browse ledger" list with filters by chart and by
//      kind, plus an explicit [Export] (downloads a JSON file — a browser
//      Blob/anchor-click, never a network call) and an explicit [Clear
//      ledger] (asks to confirm, wipes only the ledger store).
//
// GATING: shouldOfferDecisionLedger() is the single pure predicate the
// caller checks before mounting — see main.js, which only mounts this into
// #meeting-decision-ledger-body when the meetingDecisionLedger flag is on.
// This is a SEPARATE flag from meetingScribe, so this piece can ship dark
// independently of whatever state that flag is in.
//
// This module names no network primitive — export is a client-side
// Blob + anchor-click download, and persistence goes through the injected
// `store` (see js/learning/memory-store.js's appendLedgerEntries /
// getLedgerEntries / clearLedgerEntries), never a hardcoded import of a
// storage engine.

import { el } from '../app-shell/utils.js';
import {
  buildLedgerEntriesFromMeeting, saveLedgerEntries, loadLedgerEntries,
  filterLedgerEntries, chartsReferencedIn, exportLedgerEntries,
} from './meeting-decision-ledger.js';

/**
 * The single gate the caller checks before mounting anything for this
 * sub-section. True only when the flag is enabled. Pure — no DOM, no flag
 * read of its own.
 * @param {{enabled?:boolean}} [arg]
 * @returns {boolean}
 */
export function shouldOfferDecisionLedger({ enabled } = {}) {
  return enabled === true;
}

const BTN_PRIMARY = 'btn btn-primary';
const BTN_SECONDARY = 'btn btn-secondary';

/**
 * Mount the Decision Ledger section into `host` (emptied first).
 * @param {object} opts
 * @param {HTMLElement} opts.host   container to render into
 * @param {object} opts.store       injected persistence adapter — must expose
 *                                  appendLedgerEntries(entries) and
 *                                  getLedgerEntries(); clearLedgerEntries()
 *                                  is optional (Clear button hides without it)
 * @param {()=>{meetingId:string, taggedSegments:Array, actionItems:Array}} opts.getCurrentMeeting
 *   Called only when the analyst clicks [Save to ledger] — returns the
 *   in-progress meeting's tagged segments + action items from the sibling
 *   meeting-scribe-ui.js screen. May return null if nothing analyzed yet.
 * @param {(msg:string,type?:string)=>void} [opts.onToast]
 * @returns {{destroy:Function, refresh:Function}|null}
 */
export function mountDecisionLedger(opts = {}) {
  const {
    host, store, getCurrentMeeting = () => null, onToast = () => {},
  } = opts;
  if (!host || !store) return null;

  let activeFilters = { chart: '', kind: '' };
  let cachedEntries = [];

  const clear = () => { host.innerHTML = ''; };
  const heading = (text) => el('div', {
    class: 'sidebar-heading', style: 'margin-top:var(--space-5); margin-bottom:var(--space-2);', 'data-testid': 'decision-ledger-heading',
  }, text);

  async function render() {
    clear();
    host.appendChild(heading('Decision Ledger'));
    host.appendChild(el('p', {
      style: 'color:var(--color-text-muted); font-size:var(--text-sm); margin:0 0 var(--space-3); line-height:1.5;',
    }, 'A permanent local record of pushback, data requests, and action items \u2014 kept only when you choose to save them. Stays on this device.'));

    host.appendChild(el('div', { style: 'display:flex; gap:var(--space-2); margin-bottom:var(--space-3); flex-wrap:wrap;' }, [
      el('button', {
        class: BTN_PRIMARY, 'data-testid': 'decision-ledger-btn-save',
        onclick: onSaveCurrentMeeting,
      }, 'Save this meeting to ledger'),
      el('button', {
        class: BTN_SECONDARY, 'data-testid': 'decision-ledger-btn-export',
        onclick: onExport,
      }, 'Export ledger (.json)'),
      el('button', {
        class: BTN_SECONDARY, 'data-testid': 'decision-ledger-btn-clear',
        onclick: onClear,
      }, 'Clear ledger'),
    ]));

    const filterHost = el('div', { style: 'display:flex; gap:var(--space-2); margin-bottom:var(--space-3); flex-wrap:wrap;' });
    host.appendChild(filterHost);

    const listHost = el('div', { 'data-testid': 'decision-ledger-list' });
    host.appendChild(listHost);

    await refreshList(filterHost, listHost);
  }

  async function refreshList(filterHost, listHost) {
    cachedEntries = await loadLedgerEntries(store);
    renderFilters(filterHost, listHost);
    renderList(listHost);
  }

  function renderFilters(filterHost, listHost) {
    filterHost.innerHTML = '';
    const charts = chartsReferencedIn(cachedEntries);
    const kinds = ['pushback', 'dataRequest', 'actionItem', 'note'];

    const chartSelect = el('select', { class: 'input', style: 'width:180px;', 'data-testid': 'decision-ledger-filter-chart' }, [
      el('option', { value: '' }, 'All charts'),
      ...charts.map((c) => el('option', { value: c }, c)),
    ]);
    chartSelect.value = activeFilters.chart;
    chartSelect.addEventListener('change', () => { activeFilters.chart = chartSelect.value; renderList(listHost); });

    const kindSelect = el('select', { class: 'input', style: 'width:150px;', 'data-testid': 'decision-ledger-filter-kind' }, [
      el('option', { value: '' }, 'All types'),
      ...kinds.map((k) => el('option', { value: k }, k)),
    ]);
    kindSelect.value = activeFilters.kind;
    kindSelect.addEventListener('change', () => { activeFilters.kind = kindSelect.value; renderList(listHost); });

    filterHost.appendChild(chartSelect);
    filterHost.appendChild(kindSelect);
  }

  function renderList(listHost) {
    listHost.innerHTML = '';
    const filtered = filterLedgerEntries(cachedEntries, {
      chart: activeFilters.chart || undefined,
      kind: activeFilters.kind || undefined,
    });
    if (filtered.length === 0) {
      listHost.appendChild(el('p', {
        style: 'color:var(--color-text-faint); font-size:var(--text-sm);', 'data-testid': 'decision-ledger-empty',
      }, cachedEntries.length === 0 ? 'Nothing saved yet.' : 'No entries match these filters.'));
      return;
    }
    listHost.appendChild(el('ul', {
      style: 'margin:0; padding-left:var(--space-4); line-height:1.7; max-height:280px; overflow:auto;',
      'data-testid': 'decision-ledger-entries',
    }, filtered.slice().reverse().map((e) => el('li', {}, [
      el('span', { style: 'font-weight:600;' }, `[${e.kind}] `),
      `"${e.text}"`,
      e.context ? ` \u2014 while viewing "${e.context.chart}"` : '',
      e.kind === 'actionItem' ? ` \u2014 ${e.status}` : '',
    ]))));
  }

  async function onSaveCurrentMeeting() {
    const meeting = getCurrentMeeting();
    if (!meeting || !Array.isArray(meeting.taggedSegments) || meeting.taggedSegments.length === 0) {
      onToast('Nothing analyzed yet \u2014 analyze a transcript above first', 'warn');
      return;
    }
    const entries = buildLedgerEntriesFromMeeting(meeting);
    if (entries.length === 0) {
      onToast('No pushback, data requests, or action items to save', 'warn');
      return;
    }
    const written = await saveLedgerEntries(store, entries);
    onToast(`Saved ${written} entr${written === 1 ? 'y' : 'ies'} to the ledger`, 'success');
    const filterHost = host.querySelector('[data-testid="decision-ledger-filter-chart"]')?.parentElement;
    const listHost = host.querySelector('[data-testid="decision-ledger-list"]');
    if (filterHost && listHost) await refreshList(filterHost, listHost);
  }

  function onExport() {
    if (cachedEntries.length === 0) {
      onToast('Nothing to export yet', 'warn');
      return;
    }
    const json = exportLedgerEntries(cachedEntries);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dataglow-decision-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onToast(`Exported ${cachedEntries.length} entries`, 'success');
  }

  async function onClear() {
    if (typeof store.clearLedgerEntries !== 'function') return;
    // eslint-disable-next-line no-alert
    const confirmed = window.confirm ? window.confirm('Clear the entire decision ledger? This cannot be undone.') : true;
    if (!confirmed) return;
    await store.clearLedgerEntries();
    onToast('Ledger cleared', 'success');
    const filterHost = host.querySelector('[data-testid="decision-ledger-filter-chart"]')?.parentElement;
    const listHost = host.querySelector('[data-testid="decision-ledger-list"]');
    if (filterHost && listHost) await refreshList(filterHost, listHost);
  }

  render();
  return {
    destroy: () => clear(),
    refresh: async () => {
      const filterHost = host.querySelector('[data-testid="decision-ledger-filter-chart"]')?.parentElement;
      const listHost = host.querySelector('[data-testid="decision-ledger-list"]');
      if (filterHost && listHost) await refreshList(filterHost, listHost);
    },
  };
}
