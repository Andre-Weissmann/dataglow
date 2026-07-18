// ============================================================
// DATAGLOW — NL→SQL: UI
// ============================================================
// Renders the NL→SQL tab: question input, provider/key config,
// matched contract badges, generated SQL preview, and run button.
// Browser-only — no DOM references in the engine or model files.
// ============================================================

import { nlToSQL, NL_SQL_PROVIDERS } from './nl-sql-engine.js';
import { getAllContracts, matchContracts } from './metric-contracts.js';
import { datasetsToSchemaContext } from './schema-context.js';

// ---------------------------------------------------------------
// DOM helpers (mirrors DataGlow's utils.el pattern)
// ---------------------------------------------------------------
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, String(v));
  }
  for (const child of (Array.isArray(children) ? children : [children])) {
    if (child == null) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

// Suggested questions for each domain
const SUGGESTIONS = [
  'What is the 30-day readmission rate?',
  'Show me the average length of stay by payer type',
  'How many patients were admitted in 2024?',
  'What is the claim denial rate by provider?',
  'Show me ED utilization rate by month',
  'Which diagnosis codes have the highest mortality rate?',
  'List patients with length of stay greater than 10 days',
  'What is the average DRG weight by service line?',
];

// ---------------------------------------------------------------
// Privacy badge
// ---------------------------------------------------------------
function buildPrivacyBadge() {
  const badge = h('div', {
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '4px 10px', borderRadius: '20px',
      background: 'rgba(32,128,141,.12)', border: '1px solid #20808D',
      fontSize: '11px', color: '#20808D', fontWeight: 'bold',
    },
  });
  badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#20808D" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Schema only — no row data sent to LLM';
  return badge;
}

// ---------------------------------------------------------------
// Provider / API key config section
// ---------------------------------------------------------------
function buildProviderConfig({ onProviderChange, onKeyChange, currentProviderId, currentKey }) {
  const wrap = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' } });

  const providerSel = h('select', {
    'data-testid': 'nlsql-provider-select',
    style: { fontSize: '13px', padding: '5px 8px', borderRadius: '4px', border: '1px solid var(--color-border)' },
  });
  for (const p of NL_SQL_PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === currentProviderId) opt.selected = true;
    providerSel.appendChild(opt);
  }
  providerSel.addEventListener('change', () => onProviderChange(providerSel.value));

  const keyInput = h('input', {
    type: 'password',
    placeholder: 'API key (stored in memory only)',
    'data-testid': 'nlsql-api-key-input',
    style: { fontSize: '13px', padding: '5px 10px', borderRadius: '4px', border: '1px solid var(--color-border)', minWidth: '220px' },
  });
  if (currentKey) keyInput.value = currentKey;
  keyInput.addEventListener('input', () => onKeyChange(keyInput.value));

  const keyNote = h('span', { style: { fontSize: '11px', color: 'var(--color-text-muted)' } });
  keyNote.textContent = 'Key held in page memory only — never stored or sent with data';

  wrap.append(providerSel, keyInput, keyNote);
  return wrap;
}

// ---------------------------------------------------------------
// Contract suggestion chips
// ---------------------------------------------------------------
function buildContractChips(contracts, onChipClick) {
  if (!contracts.length) return null;
  const wrap = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } });
  const label = h('span', { style: { fontSize: '11px', color: 'var(--color-text-muted)', alignSelf: 'center' } });
  label.textContent = 'Metric Contracts detected:';
  wrap.appendChild(label);
  for (const c of contracts) {
    const chip = h('button', {
      class: 'btn',
      'data-testid': `nlsql-contract-chip-${c.id}`,
      style: {
        fontSize: '11px', padding: '2px 8px', borderRadius: '12px',
        background: 'rgba(32,128,141,.12)', color: '#20808D',
        border: '1px solid #20808D', cursor: 'pointer',
      },
    });
    chip.textContent = c.name;
    chip.title = c.description;
    chip.addEventListener('click', () => onChipClick(c));
    wrap.appendChild(chip);
  }
  return wrap;
}

// ---------------------------------------------------------------
// Main UI mount
// ---------------------------------------------------------------

/**
 * Mount the NL→SQL UI into a host element.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {object[]} opts.datasets          DataGlow state.datasets
 * @param {function} opts.onRunSQL          Callback(sql) — pushes SQL to SQL tab
 * @param {function} [opts.onToast]         Optional toast(msg) callback
 */
export function mountNLSQLUI({ host, datasets, onRunSQL, onToast }) {
  host.innerHTML = '';

  // ---- State (local to this mount) ----
  let providerId = NL_SQL_PROVIDERS[0].id;
  let apiKey = '';
  let question = '';
  let generatedSQL = '';
  let isLoading = false;
  let lastWarnings = [];
  let lastContractsUsed = [];

  // ---- Layout ----
  const header = h('div', { style: { marginBottom: '16px' } });
  header.appendChild(buildPrivacyBadge());

  const providerWrap = h('div', { 'data-testid': 'nlsql-provider-wrap' });
  const questionWrap = h('div', { 'data-testid': 'nlsql-question-wrap' });
  const contractChipsWrap = h('div', { 'data-testid': 'nlsql-contract-chips-wrap' });
  const resultWrap = h('div', { 'data-testid': 'nlsql-result-wrap' });
  const suggestionsWrap = h('div', { 'data-testid': 'nlsql-suggestions-wrap' });

  host.append(header, providerWrap, questionWrap, contractChipsWrap, suggestionsWrap, resultWrap);

  // ---- Provider config ----
  function renderProvider() {
    providerWrap.innerHTML = '';
    providerWrap.appendChild(buildProviderConfig({
      currentProviderId: providerId,
      currentKey: apiKey,
      onProviderChange: (id) => { providerId = id; },
      onKeyChange: (key) => { apiKey = key; },
    }));
  }

  // ---- Question input ----
  function renderQuestion() {
    questionWrap.innerHTML = '';

    const inputRow = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '10px' } });

    const textarea = h('textarea', {
      placeholder: 'Ask a question about your data in plain English...',
      'data-testid': 'nlsql-question-input',
      rows: 2,
      style: {
        flex: 1, fontSize: '14px', padding: '8px 12px',
        borderRadius: '6px', border: '1px solid var(--color-border)',
        fontFamily: 'system-ui, sans-serif', resize: 'vertical',
        background: 'var(--color-surface)', color: 'var(--color-text)',
      },
    });
    textarea.value = question;

    textarea.addEventListener('input', () => {
      question = textarea.value;
      updateContractChips();
    });
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleGenerate();
      }
    });

    const generateBtn = h('button', {
      class: 'btn btn-primary',
      'data-testid': 'nlsql-generate-btn',
      style: { padding: '8px 16px', fontSize: '14px', minWidth: '100px' },
    });
    generateBtn.textContent = isLoading ? 'Generating\u2026' : 'Generate SQL';
    generateBtn.disabled = isLoading;
    generateBtn.addEventListener('click', handleGenerate);

    inputRow.append(textarea, generateBtn);
    questionWrap.appendChild(inputRow);
  }

  // ---- Contract chips (live update as user types) ----
  function updateContractChips() {
    contractChipsWrap.innerHTML = '';
    if (!question.trim()) return;
    const allCols = (datasets || []).flatMap(d => (d.columns || d.cols || []).map(c => typeof c === 'string' ? c : c.name));
    const matches = matchContracts(question, allCols);
    if (!matches.length) return;
    const chips = buildContractChips(matches, (contract) => {
      // Clicking a chip appends the contract name to the question
      question = question.trimEnd() + (question.endsWith('?') ? ' ' : ' ') + contract.name;
      renderQuestion();
      updateContractChips();
    });
    if (chips) contractChipsWrap.appendChild(chips);
  }

  // ---- Suggestion chips ----
  function renderSuggestions() {
    suggestionsWrap.innerHTML = '';
    const label = h('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '6px' } });
    label.textContent = 'Try asking:';
    suggestionsWrap.appendChild(label);
    const chipRow = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '16px' } });
    for (const s of SUGGESTIONS.slice(0, 6)) {
      const chip = h('button', {
        class: 'btn',
        style: {
          fontSize: '12px', padding: '3px 10px', borderRadius: '12px',
          background: 'var(--color-surface)', border: '1px solid var(--color-border)',
          cursor: 'pointer', color: 'var(--color-text)',
        },
      });
      chip.textContent = s;
      chip.addEventListener('click', () => {
        question = s;
        renderQuestion();
        updateContractChips();
      });
      chipRow.appendChild(chip);
    }
    suggestionsWrap.appendChild(chipRow);
  }

  // ---- Result area ----
  function renderResult() {
    resultWrap.innerHTML = '';
    if (!generatedSQL && !lastWarnings.length) return;

    if (lastWarnings.length) {
      const warnBox = h('div', {
        style: {
          padding: '10px 14px', background: 'rgba(161,44,123,.08)',
          border: '1px solid var(--color-error, #A12C7B)',
          borderRadius: '6px', marginBottom: '10px',
          fontSize: '13px', color: 'var(--color-error, #A12C7B)',
        },
        'data-testid': 'nlsql-warnings',
      });
      warnBox.innerHTML = '<strong>Warnings:</strong><br>' + lastWarnings.map(w => `&bull; ${w}`).join('<br>');
      resultWrap.appendChild(warnBox);
    }

    if (lastContractsUsed.length) {
      const contractNote = h('div', {
        style: { fontSize: '12px', color: '#20808D', marginBottom: '8px' },
        'data-testid': 'nlsql-contracts-used',
      });
      contractNote.textContent = 'Metric Contracts used: ' + lastContractsUsed.join(', ');
      resultWrap.appendChild(contractNote);
    }

    if (generatedSQL) {
      const sqlLabel = h('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' } });
      sqlLabel.textContent = 'Generated SQL (review before running):';
      resultWrap.appendChild(sqlLabel);

      const sqlPre = h('pre', {
        'data-testid': 'nlsql-sql-preview',
        style: {
          padding: '12px 14px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          fontSize: '13px',
          fontFamily: 'monospace',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          color: 'var(--color-text)',
          marginBottom: '10px',
        },
      });
      sqlPre.textContent = generatedSQL;
      resultWrap.appendChild(sqlPre);

      const btnRow = h('div', { style: { display: 'flex', gap: '8px' } });

      const runBtn = h('button', {
        class: 'btn btn-primary',
        'data-testid': 'nlsql-run-btn',
        style: { fontSize: '13px', padding: '6px 14px' },
      });
      runBtn.textContent = 'Run in SQL tab';
      runBtn.addEventListener('click', () => {
        if (onRunSQL) onRunSQL(generatedSQL);
      });

      const copyBtn = h('button', {
        class: 'btn',
        'data-testid': 'nlsql-copy-btn',
        style: { fontSize: '13px', padding: '6px 14px' },
      });
      copyBtn.textContent = 'Copy SQL';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(generatedSQL).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy SQL'; }, 1500);
        });
      });

      btnRow.append(runBtn, copyBtn);
      resultWrap.appendChild(btnRow);
    }
  }

  // ---- Generate handler ----
  async function handleGenerate() {
    if (!question.trim()) { if (onToast) onToast('Enter a question first.'); return; }
    if (!apiKey.trim()) { if (onToast) onToast('Add an API key to use NL\u2192SQL.'); return; }

    isLoading = true;
    generatedSQL = '';
    lastWarnings = [];
    lastContractsUsed = [];
    renderQuestion();
    renderResult();

    try {
      const provider = NL_SQL_PROVIDERS.find(p => p.id === providerId) || NL_SQL_PROVIDERS[0];
      const result = await nlToSQL({
        question,
        datasets,
        domainContext: 'healthcare',
        provider,
        apiKey,
      });
      generatedSQL = result.sql;
      lastWarnings = result.warnings;
      lastContractsUsed = result.contractsUsed;
    } catch (err) {
      lastWarnings = [`Unexpected error: ${err.message}`];
    } finally {
      isLoading = false;
      renderQuestion();
      renderResult();
    }
  }

  // ---- Initial render ----
  renderProvider();
  renderQuestion();
  renderSuggestions();
  renderResult();
}
