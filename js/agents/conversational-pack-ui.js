// ============================================================
// DATAGLOW — Guided Conversational Pack Builder, Validate-tab presenter (Gen 42, Part 5)
// ============================================================
// The DOM wiring that Gen 42 (PR #89) deliberately left for a follow-up: it drives
// the already-shipped, already-tested agent modules (Parts 1–4) as an in-page,
// one-question-at-a-time card in the Validate tab HEADER AREA — never a modal.
//
// It owns only presentation + flow state; every rule/interpretation/validation
// decision is delegated to the agents so this file stays a thin controller:
//   * question wording + view model .... question-generator-agent.js
//   * "I don't know" resolution (Step D) uncertainty-resolver-agent.js
//   * confirmed-rule accumulation + the portable-pack finalize/validate path
//     ......................................... pack-builder-agent.js
//
// GATING: shouldOfferPackBuilder() is the single pure predicate the caller checks.
// It only ever returns true when the `conversationalPackBuilder` flag is on AND
// the validation run actually produced askable findings. With the flag off (its
// shipped default) the caller renders nothing — see main.js, which hides the host
// and empties it. This module NEVER reads the flag itself and names no network
// primitive; the finalize path runs inside the pack builder's runWithNetworkDenied.
//
// SCOPE NOTES / judgment calls (also flagged in the PR):
//   * Both response buttons are rendered with the SAME weight (btn btn-primary) so
//     the UI never nudges the expert toward "accept" — the spec's "two equal-weight
//     primary buttons". The free-text field below them is the lower-emphasis
//     progressive-disclosure fallback (smaller, muted type).
//   * The running summary is shown after each CONFIRMED rule; its [Add another]
//     action advances to the next data-grounded question and is omitted once no
//     findings remain (every question stays grounded in a real finding — there is
//     no blank "invent a rule" box).
//   * Voice/mic is gated by the separate conversationalPackBuilderVoice flag
//     (off); when voiceEnabled is false the mic is not rendered at all.

import { el } from '../app-shell/utils.js';
import { buildQuestionView, confirmRestatement } from './question-generator-agent.js';
import { PackBuilderSession } from './pack-builder-agent.js';
import {
  detectUncertainty, resolve, buildResolutionView, ResolverSession,
} from './uncertainty-resolver-agent.js';

/**
 * The single gate the Validate tab checks. True only when the flag is enabled AND
 * there is at least one data-grounded question to ask. Pure — no DOM, no flag read.
 * @param {{enabled?:boolean, questions?:Array}} [arg]
 * @returns {boolean}
 */
export function shouldOfferPackBuilder({ enabled, questions } = {}) {
  return enabled === true && Array.isArray(questions) && questions.length > 0;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Both primary responses share this class so neither is visually favoured.
const BTN_PRIMARY = 'btn btn-primary';

/**
 * Mount the one-question-at-a-time flow into `host`, driving the agents from the
 * first question through to the [Save locally]/[Export to share] options.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host           container to render into (emptied first)
 * @param {Array<object>} opts.questions    data-grounded question objects (Part 1)
 * @param {string} [opts.domain]            dataset domain hint, recorded on the pack
 * @param {object} [opts.index]             read-only peer pack index (Step B); optional
 * @param {boolean} [opts.voiceEnabled]     show the mic (voice flag); default false
 * @param {(filename:string,text:string,mime:string)=>void} [opts.onDownload]
 * @param {(pack:object)=>void} [opts.onSaveLocal]
 * @param {(msg:string,type?:string)=>void} [opts.onToast]
 * @returns {{destroy:Function}|null}
 */
export function mountConversationalPackBuilder(opts = {}) {
  const {
    host,
    questions = [],
    domain = '',
    index = null,
    voiceEnabled = false,
    onDownload = () => {},
    onSaveLocal = () => {},
    onToast = () => {},
  } = opts;
  if (!host) return null;

  const pending = questions.slice();
  const session = new PackBuilderSession({ domain });
  const resolverSession = new ResolverSession();
  let lastFinal = null;

  const clear = () => { host.innerHTML = ''; };
  const heading = (text) => el('div', {
    class: 'sidebar-heading', style: 'margin-bottom:var(--space-2);',
    'data-testid': 'pack-builder-heading',
  }, text);

  // Low-emphasis free-text fallback shared by the question and resolution views.
  function freeTextField(placeholder, onSubmit) {
    const input = el('input', {
      type: 'text', class: 'input', 'data-testid': 'pack-builder-freetext',
      placeholder,
      style: 'flex:1; min-width:180px; font-size:var(--text-sm); color:var(--color-text-muted);',
    });
    const submit = (v) => onSubmit(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const row = el('div', {
      style: 'display:flex; gap:var(--space-2); align-items:center; margin-top:var(--space-3);',
    }, [
      input,
      // Deliberately subtle: this is the fallback, not a third equal button.
      el('button', {
        class: 'btn btn-secondary', 'data-testid': 'pack-builder-freetext-submit',
        style: 'font-size:var(--text-xs); opacity:0.85;', onclick: () => submit(),
      }, 'Tell me'),
    ]);
    // The mic is only ever rendered when voice is available (voice flag on).
    if (voiceEnabled) {
      row.appendChild(el('button', {
        class: 'btn btn-secondary', 'data-testid': 'pack-builder-mic',
        title: 'Speak your answer', onclick: () => onToast('Voice input coming soon', 'warn'),
      }, '🎤'));
    }
    return row;
  }

  function buttonRow(buttons) {
    return el('div', {
      style: 'display:flex; gap:var(--space-2); flex-wrap:wrap;',
      'data-testid': 'pack-builder-actions',
    }, buttons);
  }

  // ---- Question view (one at a time) ----
  function renderQuestion(q) {
    const view = buildQuestionView(q, { voiceEnabled });
    clear();
    host.appendChild(heading('Teach DATAGLOW a rule from what it just found'));
    host.appendChild(el('p', {
      'data-testid': 'pack-builder-question',
      style: 'margin:0 0 var(--space-3); line-height:1.5;',
    }, view.question.text));
    host.appendChild(buttonRow(view.primary.map((b) => el('button', {
      class: BTN_PRIMARY, 'data-testid': `pack-builder-btn-${b.id}`,
      onclick: () => (b.id === 'accept' ? onAccept(q) : onSkip(q)),
    }, b.label))));
    host.appendChild(freeTextField(view.freeText.placeholder, (text) => onFreeText(q, text)));
  }

  function onAccept(q) {
    const { restatement } = session.addConfirmedAnswer({ question: q, method: 'button', text: '' });
    resolverSession.noteResolved();
    renderSummary(confirmRestatement(restatement));
  }

  function onSkip(q) {
    resolverSession.noteResolved();
    advance();
  }

  function onFreeText(q, text) {
    const t = String(text || '').trim();
    const flaggedUncertain = q.flaggedUncertain === true;
    if (t === '' && !flaggedUncertain) return; // ignore an empty submit
    if (detectUncertainty(t, { flaggedUncertain })) { handleUncertainty(q); return; }
    const { restatement } = session.addConfirmedAnswer({ question: q, method: 'typed', text: t });
    resolverSession.noteResolved();
    renderSummary(confirmRestatement(restatement));
  }

  // ---- Uncertainty ("I don't know") → resolver Steps A–D (never the debate) ----
  async function handleUncertainty(q) {
    const disposition = resolverSession.registerUncertainty(q);
    if (disposition === 'park') {
      // Step E: a SECOND "I don't know" parks the finding rather than re-asking.
      clear();
      host.appendChild(heading('No problem'));
      host.appendChild(el('p', {
        'data-testid': 'pack-builder-parked', style: 'margin:0 0 var(--space-3); line-height:1.5;',
      }, `I'll set "${q.column}" aside for now — we can come back to it later.`));
      host.appendChild(buttonRow([el('button', {
        class: BTN_PRIMARY, 'data-testid': 'pack-builder-btn-continue', onclick: () => { resolverSession.noteResolved(); advance(); },
      }, 'Continue')]));
      return;
    }
    clear();
    host.appendChild(heading('Let me help with that'));
    host.appendChild(el('p', { 'data-testid': 'pack-builder-thinking', style: 'color:var(--color-text-muted);' },
      'Thinking it through on your device…'));
    let resolution;
    try {
      resolution = await resolve(q, { domain, index, voiceEnabled });
    } catch (e) {
      onToast('Could not resolve that: ' + e.message, 'error');
      advance();
      return;
    }
    renderResolution(q, resolution);
  }

  // Step D: ONE unified suggestion — the debate/steps are never surfaced.
  function renderResolution(q, resolution) {
    const view = buildResolutionView(resolution, { voiceEnabled });
    clear();
    host.appendChild(heading('Here’s what I’d suggest'));
    host.appendChild(el('p', {
      'data-testid': 'pack-builder-resolution', style: 'margin:0 0 var(--space-3); line-height:1.5;',
    }, view.message));
    host.appendChild(buttonRow(view.primary.map((b) => el('button', {
      class: BTN_PRIMARY, 'data-testid': `pack-builder-btn-${b.id}`,
      onclick: () => (b.id === 'accept' ? onResolutionAccept(q, resolution) : onSkip(q)),
    }, b.label))));
    host.appendChild(freeTextField(view.freeText.placeholder, (text) => onFreeText(q, text)));
  }

  function onResolutionAccept(q, resolution) {
    const { restatement } = session.addConfirmedAnswer({
      question: q, method: 'resolver', text: resolution.suggestion,
    });
    resolverSession.noteResolved();
    renderSummary(confirmRestatement(restatement));
  }

  // ---- Advance / running summary ----
  function advance() {
    if (pending.length > 0) renderQuestion(pending.shift());
    else renderSummary();
  }

  function renderSummary(confirmationText) {
    const view = session.buildRunningSummaryView();
    clear();
    if (confirmationText) {
      host.appendChild(el('div', {
        'data-testid': 'pack-builder-gotit',
        style: 'margin-bottom:var(--space-3); color:var(--color-success, var(--color-text)); font-weight:600;',
      }, confirmationText));
    }
    host.appendChild(heading(view.heading));
    if (view.lines.length) {
      host.appendChild(el('ul', {
        'data-testid': 'pack-builder-summary', style: 'margin:0 0 var(--space-3); padding-left:var(--space-4); line-height:1.6;',
      }, view.lines.map((line) => el('li', {}, line))));
    } else {
      host.appendChild(el('p', {
        'data-testid': 'pack-builder-summary', style: 'color:var(--color-text-faint);',
      }, 'Nothing learned yet.'));
    }
    const actions = [];
    for (const a of view.actions) {
      if (a.id === 'add-another') {
        if (pending.length === 0) continue; // no findings left to ask about
        actions.push(el('button', {
          class: 'btn btn-secondary', 'data-testid': 'pack-builder-btn-add-another', onclick: () => advance(),
        }, a.label));
      } else {
        actions.push(el('button', {
          class: BTN_PRIMARY, 'data-testid': 'pack-builder-btn-done',
          onclick: () => renderFinalize(),
        }, a.label));
      }
    }
    host.appendChild(buttonRow(actions));
  }

  // ---- Finalize → name → [Save locally] / [Export to share] ----
  function renderFinalize() {
    clear();
    host.appendChild(heading('Save your pack'));
    const defaultName = `my-${slug(domain) || 'custom'}-pack`;
    const nameInput = el('input', {
      type: 'text', class: 'input', 'data-testid': 'pack-builder-name',
      value: defaultName, style: 'max-width:280px; margin-bottom:var(--space-3);',
    });
    const err = el('div', {
      'data-testid': 'pack-builder-error',
      style: 'color:var(--color-danger, #b00); font-size:var(--text-sm); margin-bottom:var(--space-2); min-height:1em;',
    });
    host.appendChild(el('label', {
      style: 'display:block; font-size:var(--text-sm); color:var(--color-text-muted); margin-bottom:var(--space-1);',
    }, 'Name this pack'));
    host.appendChild(nameInput);
    host.appendChild(err);
    host.appendChild(buttonRow([
      el('button', {
        class: BTN_PRIMARY, 'data-testid': 'pack-builder-btn-finalize',
        onclick: () => doFinalize(nameInput.value, err),
      }, 'Save my pack'),
      el('button', {
        class: 'btn btn-secondary', 'data-testid': 'pack-builder-btn-back', onclick: () => renderSummary(),
      }, 'Back'),
    ]));
  }

  function doFinalize(name, errEl) {
    const clean = String(name || '').trim();
    const res = session.finalize({ name: clean, label: clean, description: `Rules taught by a ${domain || 'domain'} expert.` });
    if (!res.ok) {
      errEl.textContent = res.errors.slice(0, 2).join('; ');
      return;
    }
    lastFinal = res;
    renderSaveOptions(res);
  }

  function renderSaveOptions(res) {
    const view = PackBuilderSession.saveOptionsView();
    clear();
    host.appendChild(el('div', {
      class: 'sidebar-heading', 'data-testid': 'pack-builder-saved', style: 'margin-bottom:var(--space-2); color:var(--color-success, var(--color-text));',
    }, `✅ Built "${res.pack.label}" with ${res.pack.rules.length} rule(s). How would you like to keep it?`));
    host.appendChild(buttonRow(view.actions.map((a) => el('button', {
      class: a.id === 'save-local' ? BTN_PRIMARY : 'btn btn-secondary',
      'data-testid': `pack-builder-btn-${a.id}`,
      onclick: () => (a.id === 'save-local' ? doSaveLocal(res) : doExportShare(res)),
    }, a.label))));
  }

  function doSaveLocal(res) {
    try {
      onSaveLocal(res.pack);
      onToast(`Saved "${res.pack.label}" — applied to this session`, 'success');
    } catch (e) {
      onToast('Save failed: ' + e.message, 'error');
    }
  }

  function doExportShare(res) {
    try {
      onDownload(`dataglow-pack-${res.pack.name}.json`, res.json, 'application/json');
      onToast(`Exported "${res.pack.label}"`, 'success');
    } catch (e) {
      onToast('Export failed: ' + e.message, 'error');
    }
  }

  // Kick off the flow.
  advance();

  return { destroy: () => clear() };
}
