// ============================================================
// Guarded Copilot Tab
// ============================================================
// A chat-style, read-only Q&A surface over the pure, deterministic answer
// core (js/agents/guarded-copilot.js). Gated by ONE flag, guardedCopilot (off
// by default): with it off the tab is never in the bar (see renderTabBar) and
// this function clears the panel. The core is architecturally incapable of
// writing data — it holds no firewall executor (no proposeAction/confirmAndApply)
// and has no DuckDB mutation path — so this UI only ever ASKS and DISPLAYS; it
// never proposes or applies a change. Answers are composed from the same real
// readiness-gate / grade / touch-ledger data the rest of the app already uses,
// and each query is logged to the shared AI Touch Ledger by askGuardedCopilot()
// itself — so this function must NOT double-log.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-26) -- byte-for-byte identical
// behavior, only the file location changed. renderGuardedCopilotTab now takes
// `{ state, aiTouchLedger, gradeFromResults, renderAiTouchLedgerPanel }` since
// those stay defined/instantiated in main.js: `state` and `aiTouchLedger` are
// shared app-wide singletons (the ledger in particular is read/written from
// ~20 other places in main.js, so re-creating it here would fragment its
// state), and `gradeFromResults`/`renderAiTouchLedgerPanel` are each called
// from at least one other place in main.js too -- extracting any of the four
// would create either a circular import or a second, diverging copy of
// shared state.

import { $, el, toast } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import * as ondeviceLLM from '../../narrative/ondevice-llm.js';
import { askGuardedCopilot, refineWithOnDeviceModel } from '../../agents/guarded-copilot.js';

let guardedCopilotMounted = false;

export function renderGuardedCopilotTab({ state, aiTouchLedger, gradeFromResults, renderAiTouchLedgerPanel }) {
  const host = $('#guarded-copilot-body');
  if (!host) return;
  if (!isEnabled('guardedCopilot')) { host.innerHTML = ''; guardedCopilotMounted = false; return; }
  if (guardedCopilotMounted) return; // mount once per session
  guardedCopilotMounted = true;
  host.innerHTML = '';

  // Persistent safety note — NOT optional. The engine is read-only; say so up front.
  host.appendChild(el('div', {
    style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:var(--space-3); padding:var(--space-3); border-left:3px solid var(--color-grade-a); background:var(--color-surface-2, transparent);',
    'data-testid': 'guarded-copilot-safety-note',
  }, 'Read-only — never modifies your data. Guarded Copilot only explains readiness, grades, recent changes, and who/what touched this dataset, citing the real modules its answers come from.'));

  const messages = el('div', {
    'data-testid': 'guarded-copilot-messages',
    style: 'display:flex; flex-direction:column; gap:var(--space-3); margin-bottom:var(--space-4); max-height:420px; overflow-y:auto;',
  });
  host.appendChild(messages);

  // Optional Tier 2 refine toggle — OFF by default. When on, the answer is
  // rephrased by the SAME on-device model the Story tab uses (private, WebGPU).
  const refineToggle = el('input', { type: 'checkbox', id: 'guarded-copilot-refine', 'data-testid': 'guarded-copilot-refine' });
  host.appendChild(el('label', {
    for: 'guarded-copilot-refine',
    style: 'display:flex; align-items:center; gap:var(--space-2); font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:var(--space-2); cursor:pointer;',
  }, [refineToggle, el('span', {}, 'Refine with the on-device model (private; needs WebGPU — falls back to the exact answer if unavailable).')]));

  // Model-download progress + cancel, mirrored from the Story tab's pattern.
  const cpProgressBar = el('div', { 'data-testid': 'guarded-copilot-progress-bar', style: 'height:6px; width:0%; background:var(--color-grade-a); border-radius:3px; transition:width 150ms;' });
  const cpProgressText = el('div', { style: 'font-size:var(--text-xs); color:var(--color-text-faint); margin-top:2px;' }, 'Preparing…');
  const cpCancelBtn = el('button', { class: 'btn btn-sm', style: 'margin-top:var(--space-2);' }, 'Cancel');
  const cpProgressWrap = el('div', { 'data-testid': 'guarded-copilot-progress', style: 'display:none; margin-bottom:var(--space-2);' }, [
    el('div', { style: 'background:var(--color-surface-2, #eee); border-radius:3px; overflow:hidden;' }, [cpProgressBar]),
    cpProgressText, cpCancelBtn,
  ]);
  host.appendChild(cpProgressWrap);
  let cpModelCancelled = false;
  cpCancelBtn.addEventListener('click', () => { cpModelCancelled = true; toast('Cancelling model download…', 'info'); });

  const input = el('input', {
    type: 'text', id: 'guarded-copilot-input', 'data-testid': 'guarded-copilot-input',
    placeholder: 'Ask why this data looks the way it does…',
    style: 'flex:1; padding:var(--space-2) var(--space-3); border:1px solid var(--color-divider); border-radius:var(--radius-md, 6px); background:var(--color-surface, transparent); color:inherit;',
  });
  const askBtn = el('button', { class: 'btn', 'data-testid': 'guarded-copilot-ask' }, 'Ask');
  host.appendChild(el('div', { style: 'display:flex; gap:var(--space-2);' }, [input, askBtn]));

  function addMessage(role, text, sources) {
    const isUser = role === 'user';
    const bubble = el('div', {
      'data-testid': `guarded-copilot-msg-${role}`,
      style: `align-self:${isUser ? 'flex-end' : 'flex-start'}; max-width:85%; padding:var(--space-3); border-radius:var(--radius-md, 8px); background:${isUser ? 'var(--color-surface-2, #f0f0f0)' : 'var(--color-surface, transparent)'}; border:1px solid var(--color-divider); white-space:pre-wrap; font-size:var(--text-sm);`,
    }, text);
    if (!isUser && Array.isArray(sources) && sources.length) {
      bubble.appendChild(el('div', {
        class: 'mono',
        style: 'margin-top:var(--space-2); font-size:var(--text-xs); color:var(--color-text-faint);',
      }, [
        el('div', { style: 'font-weight:600;' }, 'Sources:'),
        ...sources.map((s) => el('div', {}, s)),
      ]));
    }
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
  }

  async function refineCopilotAnswer(question, answer) {
    if (!ondeviceLLM.isWebGPUAvailable()) {
      toast('On-device model needs WebGPU — showing the exact answer instead.', 'info');
      return { text: answer.text, usedOnDeviceModel: false };
    }
    if (!ondeviceLLM.isModelLoaded()) {
      cpModelCancelled = false;
      cpProgressWrap.style.display = '';
      cpProgressBar.style.width = '0%';
      cpProgressText.textContent = 'Preparing download…';
      try {
        await ondeviceLLM.loadModel(({ progress, text }) => {
          if (cpModelCancelled) { const e = new Error('Model download cancelled.'); e.code = 'CANCELLED'; throw e; }
          cpProgressBar.style.width = `${Math.round((progress || 0) * 100)}%`;
          cpProgressText.textContent = text || `Downloading model… ${Math.round((progress || 0) * 100)}%`;
        });
      } catch (err) {
        if (err.code === 'CANCELLED') return { text: answer.text, usedOnDeviceModel: false };
        throw err;
      } finally {
        cpProgressWrap.style.display = 'none';
      }
    }
    // The model is loaded now; the read-only engine does the actual rephrase,
    // reusing the exact same loader/generation machinery the Story engine uses.
    return refineWithOnDeviceModel(question, answer);
  }

  async function submit() {
    const question = input.value.trim();
    if (!question) return;
    addMessage('user', question);
    input.value = '';
    askBtn.disabled = true;
    try {
      // Build context from REAL app state — never invented. answerDeterministic
      // is null-safe, so undefined/empty values degrade gracefully to honest
      // "I don't have that yet" answers rather than guesses.
      const results = state.validationResults || window.__dataglowLastValidation || null;
      const g = results ? gradeFromResults(results) : null;
      const answer = await askGuardedCopilot(question, {
        layerResults: results || undefined,
        grade: (g && g !== '?') ? g : undefined,
        touchLedger: isEnabled('aiTouchLedger') ? aiTouchLedger : undefined,
        journalEntries: [],
        touchLedgerEntries: aiTouchLedger.getEntries ? aiTouchLedger.getEntries() : [],
      });
      let text = answer.text;
      if (refineToggle.checked) {
        const refined = await refineCopilotAnswer(question, answer);
        text = refined.text;
      }
      addMessage('assistant', text, answer.citedFrom);
      // The query was already logged to the ledger inside askGuardedCopilot();
      // just refresh the ledger panel if it's visible. NEVER log again here.
      if (isEnabled('aiTouchLedger')) renderAiTouchLedgerPanel();
    } catch (err) {
      toast('Copilot failed: ' + (err.message || err), 'error');
    } finally {
      askBtn.disabled = false;
    }
  }
  askBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}
