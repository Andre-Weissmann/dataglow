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
// LIVE CAPTURE (DataGlow Live Rooms, Batch 1): when the caller passes
// `liveCapture: true` (main.js sets it from isEnabled('meetingScribeLiveCapture')),
// this screen ALSO renders a "Start live capture" / "Stop" button pair beside
// the paste path. It streams on-device speech-to-text segments
// (js/agents/live-transcript-capture.js) into the SAME `taggedSegments` state
// and re-renders through the exact same renderResultsInto path as a pasted
// transcript. When `liveCapture` is falsy (its default, and the flag's shipped
// state), none of that UI renders and this module behaves byte-for-byte as
// before — the paste path is never removed or altered. This module still reads
// no flag itself and names no upload primitive; the mic/STT wiring is lazy and
// lives entirely in the sibling capture module.

import { el } from '../app-shell/utils.js';
import {
  tagSegmentsWithContext, buildActionItem, isActionItemResolved, resolveActionItem, buildMeetingNote,
  buildPushbackCandidate,
} from './meeting-scribe-agent.js';
import { isSpeechCaptureAvailable, startLiveCapture } from './live-transcript-capture.js';
import { resolve } from './uncertainty-resolver-agent.js';
import { buildDebateDiagnostics } from './debate-diagnostics.js';

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
 * @param {boolean} [opts.liveCapture]  when true, also render the live audio
 *   capture controls (DataGlow Live Rooms, Batch 1). Defaults to false so the
 *   paste path is unchanged; main.js passes isEnabled('meetingScribeLiveCapture').
 * @returns {{destroy:Function, getState:Function}|null}
 */
export function mountMeetingScribe(opts = {}) {
  const { host, onToast = () => {}, liveCapture = false } = opts;
  if (!host) return null;

  const meetingId = `meeting-${Date.now()}`;
  const startedAt = new Date().toISOString();
  let taggedSegments = [];
  const actionItems = [];
  let captureSession = null;
  let capturing = false;

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

    if (liveCapture) renderLiveCaptureControls();

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
        note.pushbackMoments.map((s, idx) => renderPushbackItem(s, idx))));
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

  // ---- Live capture (DataGlow Live Rooms, Batch 1) ----
  // Renders a Start/Stop pair only when the caller enabled liveCapture. The
  // actual mic + on-device WebGPU speech-to-text wiring lives in the sibling
  // capture module; here we only stream its committed segments into the SAME
  // taggedSegments state and re-render through the existing renderResults path.
  let captureStatusRef = null;
  function renderLiveCaptureControls() {
    const available = isSpeechCaptureAvailable();
    const startBtn = el('button', {
      class: BTN_PRIMARY, 'data-testid': 'meeting-scribe-btn-live-start',
      onclick: onStartCapture,
    }, 'Start live capture');
    const stopBtn = el('button', {
      class: 'btn btn-secondary', 'data-testid': 'meeting-scribe-btn-live-stop',
      onclick: onStopCapture,
    }, 'Stop');
    stopBtn.disabled = !capturing;
    startBtn.disabled = capturing || !available;
    captureStatusRef = el('span', {
      style: 'font-size:var(--text-sm); color:var(--color-text-muted); align-self:center;',
      'data-testid': 'meeting-scribe-live-status',
    }, available
      ? (capturing ? 'Listening — transcribing on your device…' : 'On-device speech-to-text. Audio never leaves your machine.')
      : 'Live capture needs a microphone and a WebGPU browser — paste a transcript above instead.');
    host.appendChild(el('div', {
      style: 'display:flex; gap:var(--space-2); margin-bottom:var(--space-3); flex-wrap:wrap;',
      'data-testid': 'meeting-scribe-live-controls',
    }, [startBtn, stopBtn, captureStatusRef]));
  }

  function setCaptureStatus(msg) { if (captureStatusRef) captureStatusRef.textContent = msg; }

  async function onStartCapture() {
    if (capturing) return;
    if (!isSpeechCaptureAvailable()) {
      onToast('Live capture needs a microphone and a WebGPU browser', 'warn');
      return;
    }
    capturing = true;
    render(); // re-render so buttons reflect the capturing state
    setCaptureStatus('Loading the on-device speech model…');
    try {
      captureSession = await startLiveCapture({
        onUpdate: ({ segments }) => {
          taggedSegments = tagSegmentsWithContext(segments, []);
          renderResults();
          setCaptureStatus('Listening — transcribing on your device…');
        },
        onError: (err) => { onToast(`Live capture error: ${err.message}`, 'error'); },
        onProgress: ({ text }) => { if (text) setCaptureStatus(`Preparing model: ${text}`); },
      });
    } catch (err) {
      capturing = false;
      captureSession = null;
      render();
      onToast(`Could not start live capture: ${err.message}`, 'error');
    }
  }

  function onStopCapture() {
    if (captureSession) { try { captureSession.stop(); } catch { /* already stopped */ } }
    captureSession = null;
    capturing = false;
    render();
    onToast('Live capture stopped', 'success');
  }

  // ---- Pushback moment: quote + a secondary "Re-check this number" action ----
  // The re-check routes the pushback through the EXISTING on-device uncertainty
  // resolver (uncertainty-resolver-agent.js `resolve`) — closing the gap Part 1's
  // comments named ("pushback should trigger the resolver's re-run"). This is
  // READ-ONLY: it only displays a re-check result for the analyst to read; it
  // writes to no pack, rule, dataset, or ledger and auto-applies nothing.
  function renderPushbackItem(s, idx) {
    const resultHost = el('div', {
      'data-testid': `meeting-scribe-recheck-result-${idx}`,
      style: 'margin:var(--space-2) 0 var(--space-1);',
    });
    const recheckBtn = el('button', {
      // Secondary weight — this is a per-item action, lighter than Analyze/Clear.
      class: 'btn btn-secondary', 'data-testid': `meeting-scribe-recheck-${idx}`,
      style: 'font-size:var(--text-xs); margin-left:var(--space-2);',
      onclick: () => onRecheck(s, resultHost, recheckBtn),
    }, 'Re-check this number');
    return el('li', { 'data-testid': `meeting-scribe-pushback-${idx}` }, [
      el('span', {}, `"${s.text}" — matched "${s.matched}"`),
      recheckBtn,
      resultHost,
    ]);
  }

  async function onRecheck(segment, resultHost, btn) {
    resultHost.innerHTML = '';
    btn.disabled = true;
    resultHost.appendChild(el('p', {
      'data-testid': 'meeting-scribe-recheck-loading',
      style: 'color:var(--color-text-muted); font-size:var(--text-sm); margin:0;',
    }, 'Re-checking on your device…'));
    let resolution;
    try {
      // Pure candidate from the tagged segment; the resolver runs entirely
      // on-device (no LLM injected here → deterministic Step-C debate).
      resolution = await resolve(buildPushbackCandidate(segment));
    } catch (e) {
      resultHost.innerHTML = '';
      btn.disabled = false;
      resultHost.appendChild(el('p', {
        'data-testid': 'meeting-scribe-recheck-error',
        style: 'color:var(--color-text-muted); font-size:var(--text-sm); margin:0;',
      }, "Couldn't re-check this right now."));
      return;
    }
    btn.disabled = false;
    renderRecheckResult(resolution, resultHost);
  }

  function renderRecheckResult(resolution, resultHost) {
    resultHost.innerHTML = '';
    const pct = Math.round(Math.max(0, Math.min(1, resolution.confidence || 0)) * 100);
    // Step D pattern: ONE unified suggestion + reasoning + confidence, always shown.
    resultHost.appendChild(el('div', {
      'data-testid': 'meeting-scribe-recheck-suggestion',
      style: 'font-size:var(--text-sm); line-height:1.5; padding:var(--space-2); border-left:2px solid var(--color-border, #ddd);',
    }, `A second look suggests: ${resolution.suggestion}. Why: ${resolution.reasoning}. Confidence: ${pct}%.`));
    // The SAME collapsed-by-default "Why this suggestion?" disclosure the pack
    // builder uses — only when the resolution actually ran a debate (Step C).
    appendReasoningDisclosure(resolution, resultHost);
  }

  // Opt-in transparency, mirroring conversational-pack-ui.js's appendReasoningDisclosure:
  // a low-emphasis toggle that lazily builds the debate diagnostics on first
  // expand, so the default DOM never contains the debate detail. Never shown for
  // A/B/fallback-without-debate (buildDebateDiagnostics reports available:false).
  // NOTE: this intentionally duplicates the pack-builder's disclosure rather than
  // extracting a shared module — extracting cleanly would mean editing
  // conversational-pack-ui.js (treated as read-only here). See tech-debt-tracker.md.
  function appendReasoningDisclosure(resolution, mount) {
    const diag = buildDebateDiagnostics(resolution);
    if (!diag.available) return;
    let panel = null;
    const toggle = el('button', {
      class: 'btn btn-secondary', 'data-testid': 'meeting-scribe-why',
      style: 'font-size:var(--text-xs); opacity:0.85; margin-top:var(--space-2);',
      'aria-expanded': 'false',
      onclick: () => {
        if (panel) {
          const showing = panel.style.display !== 'none';
          panel.style.display = showing ? 'none' : '';
          toggle.setAttribute('aria-expanded', showing ? 'false' : 'true');
          toggle.textContent = showing ? 'Why this suggestion?' : 'Hide reasoning';
          return;
        }
        panel = buildDiagnosticsPanel(diag);
        toggle.after(panel);
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = 'Hide reasoning';
      },
    }, 'Why this suggestion?');
    mount.appendChild(toggle);
  }

  // Per-persona proposal + its OWN confidence, then the reconciliation math — no
  // single collapsed trust score. Mirrors the pack-builder diagnostics panel.
  function buildDiagnosticsPanel(diag) {
    const kids = [el('div', {
      style: 'font-weight:600; font-size:var(--text-sm); margin-bottom:var(--space-2);',
    }, 'How I reached this')];
    if (diag.note) {
      kids.push(el('p', {
        'data-testid': 'meeting-scribe-budget-note',
        style: 'margin:0 0 var(--space-2); color:var(--color-text-muted); line-height:1.5;',
      }, diag.note));
    }
    if (diag.personas.length) {
      kids.push(el('ul', {
        'data-testid': 'meeting-scribe-personas',
        style: 'margin:0 0 var(--space-2); padding-left:var(--space-4); line-height:1.6;',
      }, diag.personas.map((p) => el('li', { 'data-testid': `meeting-scribe-persona-${p.role}` },
        `${p.label} — proposed “${p.answer}” (its own confidence ${p.confidencePct}%)`))));
    }
    if (diag.winner) {
      const groupMath = diag.groups.map((g) => `“${g.answer}” = ${g.totalConfidence} across ${g.count}`).join('; ');
      const marginText = diag.groups.length > 1
        ? `, ahead of the next option by ${diag.margin} in summed confidence`
        : ' (the only option proposed)';
      kids.push(el('p', {
        'data-testid': 'meeting-scribe-reconciliation',
        style: 'margin:0; font-size:var(--text-sm); line-height:1.5;',
      }, `I grouped the proposals by answer and summed each group's confidence (${groupMath}). ` +
         `Winner: “${diag.winner.answer}”, backed by ${diag.winner.agreement} of ${diag.personas.length} ` +
         `(mean confidence ${Math.round(diag.winner.meanConfidence * 100)}%)${marginText}.`));
    }
    return el('div', {
      'data-testid': 'meeting-scribe-diagnostics',
      style: 'margin-top:var(--space-2); padding:var(--space-3); border:1px solid var(--color-border, #ddd); border-radius:6px;',
    }, kids);
  }

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
  // getState() is an addition for Gen 43 Part 3 (the Decision Ledger): a
  // read-only snapshot of this screen's current in-progress meeting, so a
  // sibling module can offer to save it without this module importing or
  // knowing anything about a ledger. Returns null fields safely even before
  // any analysis has run — never throws. This does not change any existing
  // behavior for callers that only use `destroy` (e.g. Part 2's own tests).
  return {
    destroy: () => {
      if (captureSession) { try { captureSession.stop(); } catch { /* already stopped */ } captureSession = null; }
      capturing = false;
      clear();
    },
    getState: () => ({ meetingId, taggedSegments, actionItems }),
  };
}
