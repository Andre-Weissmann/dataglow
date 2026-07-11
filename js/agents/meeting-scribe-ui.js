// ============================================================
// DATAGLOW — Meeting Scribe, Meeting tab presenter (Gen 43, Part 2)
// ============================================================
// The DOM wiring that Part 1 (js/agents/meeting-scribe-agent.js) deliberately
// left for a follow-up: a plain "paste or type a transcript" screen so the
// pure grounding/tagging/action-item logic has something a person can
// actually see and try, WITHOUT live audio capture or speech-to-text (those
// stay separate, harder, browser-API-heavy follow-up pieces).
//
// This is intentionally the simplest possible front end for Part 1:
//   * a textarea for pasting/typing lines of transcript (one line = one
//     spoken segment; a leading number is treated as a timestamp in
//     seconds, e.g. "12 Are you sure about that?" — a bare line with no
//     leading number is auto-numbered from the previous segment + 1s so
//     typing plain text works with zero setup)
//   * an [Analyze transcript] button that runs the pasted text through the
//     Part 1 agent (tagSegmentsWithContext) and renders three grouped
//     results: pushback moments, data requests, and the full tagged list
//   * a small action-item tracker: type an item, [Add]; each item shows
//     owner / due date / outcome fields and only ever displays as
//     "Resolved" once all three are filled in (the Part 1 rule) — a bare
//     "will follow up" stays visibly "Open"
//
// GATING: shouldOfferMeetingScribe() is the single pure predicate the caller
// checks before even mounting this module — see main.js, which only adds
// the "Meeting" tab to the tab bar when the meetingScribe flag is on. This
// module never reads the flag itself, matching the conversational-pack-ui.js
// precedent.
//
// No chart-context timeline is wired in yet (nothing in the app emits a
// "chart changed" event stream to feed tagSegmentsWithContext), so every
// segment here is tagged context: null by the agent — this is the agent's
// own documented graceful-degradation path, not a bug. Wiring a live context
// timeline is a natural next piece once this screen exists to show it in.
//
// This module names no network primitive and has no import of any capture
// API — it works entirely from text a person pastes or types.

import { el } from '../app-shell/utils.js';
import {
  tagSegmentsWithContext, buildActionItem, isActionItemResolved, resolveActionItem, buildMeetingNote,
} from './meeting-scribe-agent.js';

/**
 * The single gate the caller checks before mounting anything for this tab.
 * True only when the flag is enabled. Pure — no DOM, no flag read.
 * @param {{enabled?:boolean}} [arg]
 * @returns {boolean}
 */
export function shouldOfferMeetingScribe({ enabled } = {}) {
  return enabled === true;
}

// Parse pasted/typed transcript text into `{text, ts}` segments. A leading
// integer on a line is read as a timestamp in seconds ("12 are you sure?");
// a line with no leading number is auto-numbered one second after the
// previous segment (or 0 for the first line) so plain typed text works too.
export function parseTranscriptText(raw) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  let lastTs = -1;
  return lines.map((line) => {
    const m = line.match(/^(\d+)\s+(.*)$/);
    let ts;
    let text;
    if (m) { ts = parseInt(m[1], 10); text = m[2]; } else { ts = lastTs + 1; text = line; }
    lastTs = ts;
    return { text, ts };
  }).filter((s) => s.text !== '');
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const BTN_PRIMARY = 'btn btn-primary';

/**
 * Mount the Meeting Notes screen into `host` (emptied first).
 * @param {object} opts
 * @param {HTMLElement} opts.host   container to render into
 * @param {(msg:string,type?:string)=>void} [opts.onToast]
 * @returns {{destroy:Function}|null}
 */
export function mountMeetingScribe(opts = {}) {
  const { host, onToast = () => {} } = opts;
  if (!host) return null;

  const meetingId = `meeting-${Date.now()}`;
  const startedAt = new Date().toISOString();
  let taggedSegments = [];
  const actionItems = [];

  const clear = () => { host.innerHTML = ''; };
  const heading = (text) => el('div', {
    class: 'sidebar-heading', style: 'margin-bottom:var(--space-2);', 'data-testid': 'meeting-scribe-heading',
  }, text);
  const sectionLabel = (text) => el('div', {
    style: 'font-size:var(--text-sm); font-weight:600; color:var(--color-text-muted); margin:var(--space-4) 0 var(--space-2);',
  }, text);

  function render() {
    clear();
    host.appendChild(heading('Meeting Notes'));
    host.appendChild(el('p', {
      style: 'color:var(--color-text-muted); font-size:var(--text-sm); margin:0 0 var(--space-3); line-height:1.5;',
    }, 'Paste or type what was said in a meeting, one line per thing someone said. Nothing here records audio — this reads text you provide. Nothing leaves your device.'));

    const textarea = el('textarea', {
      class: 'input', rows: '10', 'data-testid': 'meeting-scribe-transcript',
      placeholder: 'e.g.\nWhy did revenue drop in March?\nCan you also pull the regional breakdown?\nOK, can you follow up with finance on that by Friday?',
      style: 'width:100%; font-family:inherit; resize:vertical; margin-bottom:var(--space-3);',
    });
    host.appendChild(textarea);

    host.appendChild(el('div', { style: 'display:flex; gap:var(--space-2); margin-bottom:var(--space-2);' }, [
      el('button', {
        class: BTN_PRIMARY, 'data-testid': 'meeting-scribe-btn-analyze',
        onclick: () => onAnalyze(textarea.value),
      }, 'Analyze transcript'),
      el('button', {
        class: 'btn btn-secondary', 'data-testid': 'meeting-scribe-btn-clear',
        onclick: () => { textarea.value = ''; taggedSegments = []; renderResults(); },
      }, 'Clear'),
    ]));

    const resultsHost = el('div', { 'data-testid': 'meeting-scribe-results' });
    host.appendChild(resultsHost);
    renderResultsInto(resultsHost);

    host.appendChild(sectionLabel('Action items'));
    const actionHost = el('div', { 'data-testid': 'meeting-scribe-action-items' });
    host.appendChild(actionHost);
    renderActionAddRow();
    renderActionItemsInto(actionHost);
  }

  let resultsHostRef = null;
  function renderResultsInto(container) {
    resultsHostRef = container;
    container.innerHTML = '';
    if (taggedSegments.length === 0) {
      container.appendChild(el('p', {
        style: 'color:var(--color-text-faint); font-size:var(--text-sm);', 'data-testid': 'meeting-scribe-empty',
      }, 'Nothing analyzed yet — paste a transcript above and click Analyze.'));
      return;
    }
    const note = buildMeetingNote({ meetingId, startedAt, taggedSegments, actionItems });

    container.appendChild(sectionLabel(`Pushback moments (${note.pushbackMoments.length})`));
    if (note.pushbackMoments.length === 0) {
      container.appendChild(el('p', { style: 'color:var(--color-text-faint); font-size:var(--text-sm);' }, 'None detected.'));
    } else {
      container.appendChild(el('ul', { style: 'margin:0; padding-left:var(--space-4); line-height:1.6;' },
        note.pushbackMoments.map((s) => el('li', {}, `"${s.text}" — matched "${s.matched}"`))));
    }

    container.appendChild(sectionLabel(`Data requests (${note.dataRequests.length})`));
    if (note.dataRequests.length === 0) {
      container.appendChild(el('p', { style: 'color:var(--color-text-faint); font-size:var(--text-sm);' }, 'None detected.'));
    } else {
      container.appendChild(el('ul', { style: 'margin:0; padding-left:var(--space-4); line-height:1.6;' },
        note.dataRequests.map((s) => el('li', {}, `"${s.text}" — matched "${s.matched}"`))));
    }

    container.appendChild(sectionLabel(`All tagged lines (${taggedSegments.length})`));
    container.appendChild(el('ul', {
      style: 'margin:0; padding-left:var(--space-4); line-height:1.6; max-height:220px; overflow:auto;',
      'data-testid': 'meeting-scribe-tagged-list',
    }, taggedSegments.map((s) => el('li', {}, `[${s.ts}s] ${s.text}${s.context ? ` — while viewing "${s.context.chart}"` : ''}`))));
  }
  function renderResults() { if (resultsHostRef) renderResultsInto(resultsHostRef); }

  function onAnalyze(raw) {
    const segments = parseTranscriptText(raw);
    if (segments.length === 0) {
      onToast('Nothing to analyze — paste or type at least one line', 'warn');
      return;
    }
    // No live chart-context timeline is wired in yet, so every segment is
    // tagged context: null — this is the agent's own graceful-degradation
    // path (see meeting-scribe-agent.js), not an error.
    taggedSegments = tagSegmentsWithContext(segments, []);
    renderResults();
    onToast(`Analyzed ${segments.length} line(s)`, 'success');
  }

  // ---- Action items ----
  let actionItemsHostRef = null;
  function renderActionItemsInto(container) {
    actionItemsHostRef = container;
    container.innerHTML = '';
    if (actionItems.length === 0) {
      container.appendChild(el('p', {
        style: 'color:var(--color-text-faint); font-size:var(--text-sm);', 'data-testid': 'meeting-scribe-action-items-empty',
      }, 'No action items yet.'));
      return;
    }
    actionItems.forEach((item, idx) => container.appendChild(renderActionItemRow(item, idx)));
  }
  function renderActionItems() { if (actionItemsHostRef) renderActionItemsInto(actionItemsHostRef); }

  function renderActionItemRow(item, idx) {
    const resolved = isActionItemResolved(item);
    const ownerInput = el('input', { type: 'text', class: 'input', placeholder: 'Owner', value: item.owner || '', style: 'width:120px;' });
    const dueInput = el('input', { type: 'text', class: 'input', placeholder: 'Due date', value: item.dueDate || '', style: 'width:120px;' });
    const outcomeInput = el('input', { type: 'text', class: 'input', placeholder: 'Outcome', value: item.outcome || '', style: 'width:160px;' });
    const save = () => {
      actionItems[idx] = resolveActionItem(item, {
        owner: ownerInput.value, dueDate: dueInput.value, outcome: outcomeInput.value,
      });
      renderActionItems();
    };
    return el('div', {
      style: 'display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap; padding:var(--space-2) 0; border-bottom:1px solid var(--color-divider);',
      'data-testid': `meeting-scribe-action-item-${idx}`,
    }, [
      el('span', { style: 'flex:1; min-width:160px;' }, item.text),
      ownerInput, dueInput, outcomeInput,
      el('button', { class: 'btn btn-secondary', style: 'font-size:var(--text-xs);', onclick: save }, 'Save'),
      el('span', {
        style: `font-size:var(--text-xs); font-weight:600; color:${resolved ? 'var(--color-success, var(--color-text))' : 'var(--color-text-faint)'};`,
        'data-testid': `meeting-scribe-action-item-status-${idx}`,
      }, resolved ? 'Resolved' : 'Open'),
    ]);
  }

  function renderActionAddRow() {
    const input = el('input', {
      type: 'text', class: 'input', 'data-testid': 'meeting-scribe-action-input',
      placeholder: 'New action item, e.g. Follow up with finance on the March dip',
      style: 'flex:1; min-width:220px;',
    });
    const add = () => {
      const t = input.value.trim();
      if (t === '') return;
      actionItems.push(buildActionItem({ text: t, ts: taggedSegments.length ? taggedSegments[taggedSegments.length - 1].ts : 0 }));
      input.value = '';
      renderActionItems();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    host.appendChild(el('div', { style: 'display:flex; gap:var(--space-2); margin-bottom:var(--space-3);' }, [
      input,
      el('button', { class: 'btn btn-secondary', 'data-testid': 'meeting-scribe-btn-add-action', onclick: add }, 'Add'),
    ]));
  }

  render();
  return { destroy: () => clear() };
}
