// ============================================================
// DATAGLOW -- AI Council: UI
// ============================================================
// Renders the Council tab: a question box, three provider config rows
// (name + BYO API key + on/off toggle), a live progress strip while the
// council deliberates, a synthesis panel (consensus / majority / contested),
// and three side-by-side answer cards.
//
// API keys live in page memory only for the lifetime of this mount -- never
// written to localStorage, cookies, or sessionStorage, and never persisted
// across a reload.
// ============================================================

import { runCouncil, COUNCIL_PROVIDERS, resolveGoogleEndpoint, detectQuestionMode, detectDomain, parseAnswerSections, extractConfidenceLevel } from './council-engine.js';

// ---------------------------------------------------------------
// Minimal HTML-escape sanitizer (esc()) -- every innerHTML write below
// runs untrusted text (question text, LLM answers) through this first.
// ---------------------------------------------------------------
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

// ---------------------------------------------------------------
// DOM helper (mirrors DataGlow's utils.el pattern, kept local so this
// module has zero DOM-framework dependency beyond the platform).
// ---------------------------------------------------------------
function h(tag, attrs, children) {
  const options = attrs || {};
  const kids = children || [];
  const node = document.createElement(tag);
  for (const key of Object.keys(options)) {
    const value = options[key];
    if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'class') {
      node.className = value;
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key.indexOf('on') === 0 && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  const list = Array.isArray(kids) ? kids : [kids];
  for (const child of list) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const PROVIDER_SHORT_LABEL = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  google: 'Gemini',
};

function providerLabel(provider) {
  if (!provider) return 'Unknown';
  return PROVIDER_SHORT_LABEL[provider.id] || provider.name || provider.id;
}

// ---------------------------------------------------------------
// Main mount function
// ---------------------------------------------------------------

/**
 * Mount the AI Council UI into a host element.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {function} [opts.getSchemaContext]  Optional () => string|null
 * @param {function} [opts.onToast]           Optional toast(msg, type) callback
 */
export function mountCouncilUI(opts) {
  const options = opts || {};
  const host = options.host;
  const getSchemaContext = typeof options.getSchemaContext === 'function' ? options.getSchemaContext : null;
  const onToast = typeof options.onToast === 'function' ? options.onToast : null;

  if (!host) return;
  host.innerHTML = '';

  // ---- Local, in-memory-only state ----
  let question = '';
  // Deep-copy provider config so the user's model overrides are per-session
  // in-memory only and never mutate the shared COUNCIL_PROVIDERS array.
  const providerState = COUNCIL_PROVIDERS.map(function (p) {
    return {
      provider: p,
      apiKey: '',
      enabled: true,
      // modelOverride: null means 'use the default from COUNCIL_PROVIDERS'
      modelOverride: null,
    };
  });
  let isRunning = false;
  let progressByProviderId = {}; // id -> { status, elapsedMs }
  let lastResult = null; // { responses, synthesis }
  let schemaDisclosureOpen = false;

  // ---- Layout containers ----
  const questionWrap = h('div', { 'data-testid': 'council-question-wrap' });
  const providerWrap = h('div', { 'data-testid': 'council-provider-wrap' });
  const schemaWrap = h('div', { 'data-testid': 'council-schema-wrap' });
  const progressWrap = h('div', { 'data-testid': 'council-progress-wrap' });
  const synthesisWrap = h('div', { 'data-testid': 'council-synthesis-wrap' });
  const cardsWrap = h('div', { 'data-testid': 'council-cards-wrap' });
  const actionsWrap = h('div', { 'data-testid': 'council-actions-wrap' });

  const modeBadgeWrap = h('div', { 'data-testid': 'council-mode-badge-wrap', style: { marginBottom: '8px' } });
  host.append(questionWrap, providerWrap, schemaWrap, modeBadgeWrap, progressWrap, synthesisWrap, cardsWrap, actionsWrap);

  // ---------------------------------------------------------------
  // Question box
  // ---------------------------------------------------------------
  function renderQuestion() {
    questionWrap.innerHTML = '';

    const row = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '12px' } });

    const textarea = h('textarea', {
      placeholder: 'Ask the Council an analytical question, for example: Which metric best explains readmission risk?',
      'data-testid': 'council-question-input',
      rows: 3,
      style: {
        flex: '1', fontSize: '14px', padding: '8px 12px',
        borderRadius: '6px', border: '1px solid var(--color-border)',
        fontFamily: 'system-ui, sans-serif', resize: 'vertical',
        background: 'var(--color-surface)', color: 'var(--color-text)',
      },
    });
    textarea.value = question;
    textarea.addEventListener('input', function () { question = textarea.value; });
    textarea.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleAsk();
      }
    });

    const askBtn = h('button', {
      class: 'btn btn-primary',
      'data-testid': 'council-ask-btn',
      style: { padding: '8px 16px', fontSize: '14px', minWidth: '140px' },
    });
    askBtn.textContent = isRunning ? 'Deliberating...' : 'Ask the Council';
    askBtn.disabled = isRunning;
    askBtn.addEventListener('click', handleAsk);

    row.append(textarea, askBtn);
    questionWrap.appendChild(row);

    const hint = h('div', { style: { fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '6px' } });
    hint.textContent = 'Best for data questions -- not general chat. Ctrl/Cmd+Enter also asks.';
    questionWrap.appendChild(hint);
  }

  // ---------------------------------------------------------------
  // Provider config rows
  // ---------------------------------------------------------------
  function renderProviders() {
    providerWrap.innerHTML = '';

    const label = h('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '6px' } });
    label.textContent = 'Council members (BYO API key -- held in page memory only, never stored):';
    providerWrap.appendChild(label);

    // Column headers for the provider rows
    const colHeaders = h('div', {
      style: {
        display: 'flex', gap: '10px', alignItems: 'center',
        padding: '0 10px', marginBottom: '2px',
      },
    });
    const chOn = h('span', { style: { fontSize: '10px', color: 'var(--color-text-muted)', width: '16px' } });
    chOn.textContent = 'On';
    const chName = h('span', { style: { fontSize: '10px', color: 'var(--color-text-muted)', minWidth: '150px' } });
    chName.textContent = 'Provider';
    const chKey = h('span', { style: { fontSize: '10px', color: 'var(--color-text-muted)', flex: '1' } });
    chKey.textContent = 'API key';
    const chModel = h('span', { style: { fontSize: '10px', color: 'var(--color-text-muted)', width: '160px' } });
    chModel.textContent = 'Model (blank = default)';
    colHeaders.append(chOn, chName, chKey, chModel);
    providerWrap.appendChild(colHeaders);

    const table = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' } });

    providerState.forEach(function (row, idx) {
      const rowEl = h('div', {
        'data-testid': 'council-provider-row-' + row.provider.id,
        style: {
          display: 'flex', gap: '10px', alignItems: 'center',
          padding: '6px 10px', borderRadius: '6px',
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        },
      });

      const toggle = h('input', {
        type: 'checkbox',
        'data-testid': 'council-provider-toggle-' + row.provider.id,
        style: { cursor: 'pointer' },
      });
      toggle.checked = row.enabled;
      toggle.addEventListener('change', function () {
        row.enabled = toggle.checked;
      });

      const nameEl = h('span', { style: { fontSize: '13px', fontWeight: 'bold', minWidth: '150px', color: 'var(--color-text)' } });
      nameEl.textContent = row.provider.name;

      const keyInput = h('input', {
        type: 'password',
        placeholder: 'API key',
        'data-testid': 'council-key-input-' + row.provider.id,
        style: {
          fontSize: '13px', padding: '5px 10px', borderRadius: '4px',
          border: '1px solid var(--color-border)', flex: '1',
        },
      });
      keyInput.value = row.apiKey;
      keyInput.addEventListener('input', function () { row.apiKey = keyInput.value; });

      // Model name input -- allows overriding the default without touching code.
      // For Google/Gemini the model name is embedded in the endpoint URL, so
      // changing it here automatically rebuilds the effective endpoint.
      const modelInput = h('input', {
        type: 'text',
        placeholder: row.provider.model,
        title: 'Model name (leave blank to use default: ' + row.provider.model + ')',
        'data-testid': 'council-model-input-' + row.provider.id,
        style: {
          fontSize: '12px', padding: '5px 8px', borderRadius: '4px',
          border: '1px solid var(--color-border)', width: '160px',
          color: 'var(--color-text-muted)',
          fontFamily: 'monospace',
        },
      });
      modelInput.value = row.modelOverride || '';
      modelInput.addEventListener('input', function () {
        var val = modelInput.value.trim();
        row.modelOverride = val || null;
        // For Google, the model name is part of the endpoint URL.
        // Rebuild it live so the engine always gets a valid URL.
        if (row.provider.id === 'google') {
          row.provider = Object.assign({}, row.provider, {
            model: val || row.provider.model,
            endpoint: resolveGoogleEndpoint(val || row.provider.model),
          });
        } else {
          row.provider = Object.assign({}, row.provider, {
            model: val || COUNCIL_PROVIDERS.find(function (p) { return p.id === row.provider.id; }).model,
          });
        }
      });

      rowEl.append(toggle, nameEl, keyInput, modelInput);
      table.appendChild(rowEl);
    });

    providerWrap.appendChild(table);

    const keyNote = h('div', { style: { fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '10px' } });
    keyNote.textContent = 'Keys are never saved to disk, localStorage, cookies, or sessionStorage. They disappear when you leave this tab or reload.';
    providerWrap.appendChild(keyNote);
  }

  // ---------------------------------------------------------------
  // Schema context disclosure
  // ---------------------------------------------------------------
  function renderSchemaDisclosure() {
    schemaWrap.innerHTML = '';
    if (!getSchemaContext) return;

    let ctx = null;
    try { ctx = getSchemaContext(); } catch (err) { ctx = null; }
    if (!ctx || !String(ctx).trim()) return;

    const details = h('details', { 'data-testid': 'council-schema-disclosure' });
    if (schemaDisclosureOpen) details.setAttribute('open', 'open');
    details.addEventListener('toggle', function () { schemaDisclosureOpen = details.open; });

    const summary = h('summary', { style: { fontSize: '12px', color: 'var(--color-text-muted)', cursor: 'pointer', marginBottom: '6px' } });
    summary.textContent = 'Schema context (sent to every model, no row data)';

    const pre = h('pre', {
      style: {
        fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap',
        background: 'var(--color-surface)', border: '1px solid var(--color-border)',
        borderRadius: '6px', padding: '10px 12px', color: 'var(--color-text)',
        marginBottom: '10px',
      },
    });
    pre.textContent = String(ctx);

    details.append(summary, pre);
    schemaWrap.appendChild(details);
  }

  // ---------------------------------------------------------------
  // Live progress strip
  // ---------------------------------------------------------------
  function statusDot(status) {
    if (status === 'done') return '\u25CF'; // filled circle, styled green via color
    if (status === 'error') return '\u2716'; // X mark
    return '\u25CB'; // hollow circle for pending
  }

  function statusColor(status) {
    if (status === 'done') return '#1F8A57';
    if (status === 'error') return '#A12C7B';
    return 'var(--color-text-muted)';
  }

  function renderProgress() {
    progressWrap.innerHTML = '';
    const activeIds = Object.keys(progressByProviderId);
    if (!isRunning && activeIds.length === 0) return;

    const strip = h('div', {
      'data-testid': 'council-progress-strip',
      style: {
        display: 'flex', gap: '16px', alignItems: 'center',
        padding: '8px 12px', marginBottom: '10px',
        border: '1px solid var(--color-border)', borderRadius: '6px',
        background: 'var(--color-surface)', fontSize: '13px',
      },
    });

    providerState.forEach(function (row) {
      if (!row.enabled) return;
      const info = progressByProviderId[row.provider.id] || { status: 'idle' };
      const item = h('span', {
        'data-testid': 'council-progress-badge-' + row.provider.id,
        style: { display: 'inline-flex', alignItems: 'center', gap: '5px', color: 'var(--color-text)' },
      });
      const dot = h('span', { style: { color: statusColor(info.status) } });
      dot.textContent = statusDot(info.status);
      const text = h('span', {});
      const elapsedTxt = info.elapsedMs != null ? ' (' + info.elapsedMs + 'ms)' : '';
      text.textContent = providerLabel(row.provider) + elapsedTxt;
      item.append(dot, text);
      strip.appendChild(item);
    });

    progressWrap.appendChild(strip);
  }

  // ---------------------------------------------------------------
  // Synthesis panel
  // ---------------------------------------------------------------
  function agreementBadgeColor(level) {
    if (level === 'high') return '#1F8A57';
    if (level === 'moderate') return '#B8860B';
    if (level === 'low') return '#A12C7B';
    return 'var(--color-text-muted)';
  }

  function buildBucketBlock(title, items, color, testid) {
    const block = h('div', { 'data-testid': testid, style: { marginBottom: '10px' } });
    const heading = h('div', { style: { fontSize: '12px', fontWeight: 'bold', color: color, marginBottom: '4px' } });
    heading.textContent = title;
    block.appendChild(heading);

    if (!items.length) {
      const empty = h('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } });
      empty.textContent = 'None found.';
      block.appendChild(empty);
      return block;
    }

    const list = h('ul', { style: { margin: '0', paddingLeft: '18px' } });
    items.forEach(function (item) {
      const li = h('li', { style: { fontSize: '13px', color: 'var(--color-text)', marginBottom: '2px' } });
      li.textContent = item;
      list.appendChild(li);
    });
    block.appendChild(list);
    return block;
  }

  function renderSynthesis() {
    synthesisWrap.innerHTML = '';
    if (!lastResult) return;

    const successful = lastResult.responses.filter(function (r) { return r && !r.error; });

    if (successful.length === 0) {
      const failBox = h('div', {
        'data-testid': 'council-all-failed',
        style: {
          padding: '10px 14px', borderRadius: '6px', marginBottom: '10px',
          border: '1px solid var(--color-error, #A12C7B)', color: 'var(--color-error, #A12C7B)',
          fontSize: '13px', background: 'rgba(161,44,123,.08)',
        },
      });
      failBox.textContent = 'All council members failed to respond. Check your API keys and try again.';
      synthesisWrap.appendChild(failBox);
      return;
    }

    if (successful.length === 1) {
      const note = h('div', {
        'data-testid': 'council-single-response-note',
        style: {
          padding: '10px 14px', borderRadius: '6px', marginBottom: '10px',
          border: '1px solid var(--color-border)', color: 'var(--color-text-muted)',
          fontSize: '13px', background: 'var(--color-surface)',
        },
      });
      note.textContent = 'Only one model responded -- no synthesis possible.';
      synthesisWrap.appendChild(note);
      return;
    }

    const synthesis = lastResult.synthesis;

    const panel = h('div', {
      'data-testid': 'council-synthesis-panel',
      style: {
        padding: '12px 14px', borderRadius: '8px', marginBottom: '14px',
        border: '1px solid var(--color-border)', background: 'var(--color-surface)',
      },
    });

    const headerRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } });
    const title = h('div', { style: { fontSize: '13px', fontWeight: 'bold', color: 'var(--color-text)' } });
    title.textContent = 'Council Synthesis';
    const badge = h('span', {
      'data-testid': 'council-agreement-badge',
      style: {
        fontSize: '11px', fontWeight: 'bold', padding: '2px 10px', borderRadius: '12px',
        color: '#fff', background: agreementBadgeColor(synthesis.overallAgreement),
      },
    });
    badge.textContent = 'Agreement: ' + synthesis.overallAgreement;

    if (synthesis.narrative) {
      const narrativeBox = h('div', {
        'data-testid': 'council-synthesis-narrative',
        style: { fontSize: '13px', color: 'var(--color-text)', marginBottom: '10px', fontStyle: 'italic' },
      });
      narrativeBox.textContent = synthesis.narrative;
      panel.appendChild(narrativeBox);
    }
    headerRow.append(title, badge);
    panel.appendChild(headerRow);

    panel.appendChild(buildBucketBlock('CONSENSUS (all responding models agree)', synthesis.consensus, '#1F8A57', 'council-consensus-block'));
    panel.appendChild(buildBucketBlock('MAJORITY (2 of 3 agree)', synthesis.majority, '#B8860B', 'council-majority-block'));
    panel.appendChild(buildBucketBlock('CONTESTED (models differ)', synthesis.contested, '#A12C7B', 'council-contested-block'));

    synthesisWrap.appendChild(panel);
  }

  // ---------------------------------------------------------------
  // Side-by-side answer cards
  // ---------------------------------------------------------------
  function buildCard(row) {
    const info = progressByProviderId[row.provider.id] || { status: 'idle' };
    const response = lastResult ? lastResult.responses.find(function (r) { return r.provider && r.provider.id === row.provider.id; }) : null;

    const card = h('div', {
      'data-testid': 'council-card-' + row.provider.id,
      style: {
        flex: '1', minWidth: '220px', border: '1px solid var(--color-border)',
        borderRadius: '8px', padding: '12px 14px', background: 'var(--color-surface)',
        display: 'flex', flexDirection: 'column', gap: '6px',
      },
    });

    const headRow = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } });
    const nameEl = h('div', { style: { fontSize: '13px', fontWeight: 'bold', color: 'var(--color-text)' } });
    nameEl.textContent = row.provider.name;
    const statusEl = h('span', { style: { fontSize: '12px', color: statusColor(info.status) } });
    if (info.status === 'pending') statusEl.textContent = 'Thinking...';
    else if (info.status === 'done') statusEl.textContent = 'Done' + (info.elapsedMs != null ? ' (' + info.elapsedMs + 'ms)' : '');
    else if (info.status === 'error') statusEl.textContent = 'Failed';
    else statusEl.textContent = '';
    headRow.append(nameEl, statusEl);
    card.appendChild(headRow);

    if (!row.enabled) {
      const offNote = h('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } });
      offNote.textContent = 'Disabled -- not called.';
      card.appendChild(offNote);
      return card;
    }

    if (response && response.error) {
      const errBox = h('div', { style: { fontSize: '12px', color: 'var(--color-error, #A12C7B)' } });
      errBox.textContent = response.error;
      card.appendChild(errBox);
    } else if (response && response.answer) {
      const parsed = parseAnswerSections(response.answer);
      const hasSections = parsed.finding || parsed.evidence;
      if (hasSections) {
        if (parsed.finding) {
          const findingLabel = h('div', { style: { fontSize: '11px', fontWeight: 'bold', color: 'var(--color-text-muted)', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' } });
          findingLabel.textContent = 'Finding';
          const findingBox = h('div', { style: { fontSize: '13px', color: 'var(--color-text)', marginBottom: '6px' } });
          findingBox.textContent = parsed.finding;
          card.appendChild(findingLabel);
          card.appendChild(findingBox);
        }
        if (parsed.evidence) {
          const isSQL = parsed.evidence.indexOf('` + '```' + `') !== -1;
          const evidenceLabel = h('div', { style: { fontSize: '11px', fontWeight: 'bold', color: 'var(--color-text-muted)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' } });
          evidenceLabel.textContent = isSQL ? 'SQL' : 'Evidence';
          const evidenceBox = h('div', { style: { fontSize: '13px', color: 'var(--color-text)', whiteSpace: 'pre-wrap', fontFamily: isSQL ? 'monospace' : 'inherit', marginBottom: '6px' } });
          evidenceBox.textContent = parsed.evidence;
          card.appendChild(evidenceLabel);
          card.appendChild(evidenceBox);
        }
        if (parsed.confidence) {
          const confLevel = extractConfidenceLevel(parsed.confidence);
          const confColor = confLevel === 'HIGH' ? '#1F8A57' : confLevel === 'LOW' ? '#A12C7B' : '#B8860B';
          const confChip = h('span', { style: { display: 'inline-block', fontSize: '11px', fontWeight: 'bold', padding: '2px 8px', borderRadius: '10px', background: confColor, color: '#fff', marginBottom: '4px' } });
          confChip.textContent = confLevel + ' confidence';
          card.appendChild(confChip);
        }
        if (parsed.caveats) {
          const cavLabel = h('div', { style: { fontSize: '11px', fontWeight: 'bold', color: 'var(--color-text-muted)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' } });
          cavLabel.textContent = 'Caveats';
          const cavBox = h('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)', whiteSpace: 'pre-wrap' } });
          cavBox.textContent = parsed.caveats;
          card.appendChild(cavLabel);
          card.appendChild(cavBox);
        }
      } else {
        const answerBox = h('div', { style: { fontSize: '13px', color: 'var(--color-text)', whiteSpace: 'pre-wrap' } });
        answerBox.textContent = response.answer;
        card.appendChild(answerBox);
      }
    } else if (isRunning) {
      const waitBox = h('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } });
      waitBox.textContent = 'Waiting for response...';
      card.appendChild(waitBox);
    } else {
      const idleBox = h('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } });
      idleBox.textContent = 'No response yet.';
      card.appendChild(idleBox);
    }

    return card;
  }

  function renderCards() {
    cardsWrap.innerHTML = '';
    const row = h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' } });
    providerState.forEach(function (p) { row.appendChild(buildCard(p)); });
    cardsWrap.appendChild(row);
  }

  // ---------------------------------------------------------------
  // Copy / export actions
  // ---------------------------------------------------------------
  function buildMarkdownExport() {
    if (!lastResult) return '';
    const lines = [];
    lines.push('# AI Council answers');
    lines.push('');
    lines.push('Question: ' + question);
    lines.push('');
    lastResult.responses.forEach(function (r) {
      lines.push('## ' + providerLabel(r.provider));
      if (r.error) {
        lines.push('Error: ' + r.error);
      } else {
        lines.push(r.answer || '');
      }
      lines.push('');
    });
    return lines.join('\n');
  }

  function renderActions() {
    actionsWrap.innerHTML = '';
    if (!lastResult) return;

    const row = h('div', { style: { display: 'flex', gap: '8px' } });

    const copyBtn = h('button', {
      class: 'btn',
      'data-testid': 'council-copy-all-btn',
      style: { fontSize: '13px', padding: '6px 14px' },
    });
    copyBtn.textContent = 'Copy all answers';
    copyBtn.addEventListener('click', function () {
      const md = buildMarkdownExport();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).then(function () {
          copyBtn.textContent = 'Copied!';
          setTimeout(function () { copyBtn.textContent = 'Copy all answers'; }, 1500);
        });
      }
      if (onToast) onToast('Copied Council answers to clipboard.', 'success');
    });

    const exportBtn = h('button', {
      class: 'btn',
      'data-testid': 'council-export-json-btn',
      style: { fontSize: '13px', padding: '6px 14px' },
    });
    exportBtn.textContent = 'Export as JSON';
    exportBtn.addEventListener('click', function () {
      const payload = {
        question: question,
        detectedMode: lastResult.detectedMode || null,
        detectedDomain: lastResult.detectedDomain || null,
        responses: lastResult.responses,
        synthesis: lastResult.synthesis,
        timestamp: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ai-council-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (onToast) onToast('Exported Council session as JSON.', 'success');
    });

    row.append(copyBtn, exportBtn);
    actionsWrap.appendChild(row);
  }

  // ---------------------------------------------------------------
  // Ask handler
  // ---------------------------------------------------------------
  async function handleAsk() {
    if (!question.trim()) {
      if (onToast) onToast('Enter a question first.', 'warn');
      return;
    }
    const enabledRows = providerState.filter(function (r) { return r.enabled; });
    if (!enabledRows.length) {
      if (onToast) onToast('Enable at least one council member.', 'warn');
      return;
    }
    const missingKey = enabledRows.some(function (r) { return !r.apiKey.trim(); });
    if (missingKey) {
      if (onToast) onToast('Add an API key for every enabled council member.', 'warn');
      return;
    }

    // Show mode + domain badge before starting
    modeBadgeWrap.innerHTML = '';
    const detectedModeNow = detectQuestionMode(question);
    let schemaCtxForBadge = '';
    if (getSchemaContext) { try { schemaCtxForBadge = getSchemaContext() || ''; } catch (e) { schemaCtxForBadge = ''; } }
    const detectedDomainNow = detectDomain(schemaCtxForBadge, question);
    const badgeRow = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' } });
    const modeChip = h('span', { 'data-testid': 'council-mode-chip', style: { display: 'inline-block', fontSize: '11px', fontWeight: 'bold', padding: '2px 10px', borderRadius: '10px', background: 'var(--color-surface-alt, #f0f0f0)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' } });
    modeChip.textContent = 'Mode: ' + detectedModeNow.label;
    badgeRow.appendChild(modeChip);
    if (detectedDomainNow) {
      const domainChip = h('span', { 'data-testid': 'council-domain-chip', style: { display: 'inline-block', fontSize: '11px', fontWeight: 'bold', padding: '2px 10px', borderRadius: '10px', background: 'var(--color-surface-alt, #f0f0f0)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' } });
      domainChip.textContent = 'Domain: ' + detectedDomainNow.charAt(0).toUpperCase() + detectedDomainNow.slice(1);
      badgeRow.appendChild(domainChip);
    }
    modeBadgeWrap.appendChild(badgeRow);

    isRunning = true;
    progressByProviderId = {};
    lastResult = null;
    renderQuestion();
    renderProgress();
    renderSynthesis();
    renderCards();
    renderActions();

    let schemaContext = null;
    if (getSchemaContext) {
      try { schemaContext = getSchemaContext(); } catch (err) { schemaContext = null; }
    }

    try {
      const result = await runCouncil({
        question: question,
        schemaContext: schemaContext || '',
        providers: providerState.map(function (r) { return { provider: r.provider, apiKey: r.apiKey, enabled: r.enabled }; }),
        onProgress: function (evt) {
          progressByProviderId = Object.assign({}, progressByProviderId);
          progressByProviderId[evt.provider.id] = { status: evt.status, elapsedMs: evt.elapsedMs };
          renderProgress();
          renderCards();
        },
      });
      lastResult = result;
    } catch (err) {
      if (onToast) onToast('Council run failed: ' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      isRunning = false;
      renderQuestion();
      renderProgress();
      renderSynthesis();
      renderCards();
      renderActions();
    }
  }

  // ---- Initial render ----
  renderQuestion();
  renderProviders();
  renderSchemaDisclosure();
  renderProgress();
  renderSynthesis();
  renderCards();
  renderActions();
}
