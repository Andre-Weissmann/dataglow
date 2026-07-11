// ============================================================
// DATAGLOW — Proof Drawer (OneCanvas Phase 1, Part 4)
// ============================================================
// A slide-out panel that explains WHY a number can be trusted, opened from a
// Metric Studio metric, a Trust Strip field, or a provenance/lineage view. Every
// block it shows traces to real computed data. No SQL knowledge is required to
// read the default view; the raw DuckDB expression + its query are opt-in behind
// a "Show the math" toggle.
//
// buildProofContent() is a PURE function returning a normalised content model, so
// each trigger type is unit-testable in Node. The renderer turns that model into
// DOM. For provenance/lineage it does NOT re-implement rendering — it calls the
// EXISTING renderAttestationHTML()/renderReceiptHTML() from js/provenance/ and
// embeds their output in an iframe.

import { el, escapeHtml, formatNumber } from '../app-shell/utils.js';
import { renderAttestationHTML } from '../provenance/provenance.js';
import { renderReceiptHTML } from '../provenance/validation-receipt.js';

function metricValueString(m) {
  if (m.computeError) return `compute error: ${m.computeError}`;
  if (m.computedValue == null) return 'not yet computed';
  return typeof m.computedValue === 'number' ? formatNumber(m.computedValue) : String(m.computedValue);
}

function metricContent(metric) {
  const blocks = [];
  blocks.push({ kind: 'text', label: 'Plain-English definition', text: metric.plainEnglish || '(none given)' });
  blocks.push({ kind: 'kv', label: 'Certification status', value: metric.status });
  blocks.push({ kind: 'kv', label: 'Computed value', value: metricValueString(metric) });
  if (metric.computedAt) blocks.push({ kind: 'kv', label: 'Computed at', value: new Date(metric.computedAt).toISOString() });
  blocks.push({ kind: 'list', label: 'Source columns', items: (metric.columns && metric.columns.length) ? metric.columns : ['(none detected)'] });
  if (metric.owner) blocks.push({ kind: 'kv', label: 'Owner', value: metric.owner });
  if (metric.tag) blocks.push({ kind: 'kv', label: 'Tag', value: metric.tag });
  // Show the math (opt-in).
  blocks.push({ kind: 'code', label: 'Formula (raw DuckDB expression)', code: metric.expression, collapsible: true });
  blocks.push({ kind: 'code', label: 'Query run against the loaded table', code: `SELECT (${metric.expression}) AS value FROM <table>`, collapsible: true });
  return { title: metric.name, subtitle: 'Metric', blocks };
}

function validationContent(validationResults) {
  const items = [];
  for (const [id, v] of Object.entries(validationResults || {})) {
    if (!v || typeof v !== 'object' || typeof v.status !== 'string') continue;
    if (!['pass', 'warn', 'fail', 'idle'].includes(v.status)) continue;
    items.push(`${v.status.toUpperCase()} — ${id}${v.summary ? `: ${v.summary}` : ''}`);
  }
  return {
    title: 'Validation results',
    subtitle: 'Trust Strip · per-layer pass/fail',
    blocks: [items.length
      ? { kind: 'list', label: `${items.length} layers`, items }
      : { kind: 'text', label: 'Status', text: 'Validation has not been run on this dataset yet.' }],
  };
}

function certificationContent(metrics) {
  const list = (metrics || []).map(m => `${m.status.toUpperCase()} — ${m.name}`);
  return {
    title: 'Metric certification',
    subtitle: 'Trust Strip · Metric Studio registry',
    blocks: [list.length
      ? { kind: 'list', label: `${list.length} metric(s)`, items: list }
      : { kind: 'text', label: 'Status', text: 'No metrics defined yet (0 certified · 0 reviewed · 0 exploratory).' }],
  };
}

function provenanceHtml({ attestation, receipt }) {
  if (attestation) return renderAttestationHTML(attestation);
  if (receipt) return renderReceiptHTML(receipt);
  return null;
}

/**
 * Build the normalised content model for the drawer. Pure & synchronous.
 * @param {object} trigger
 * @param {'metric'|'trust-field'|'provenance'} trigger.type
 * @returns {{title:string, subtitle?:string, blocks:Array<object>}}
 */
export function buildProofContent(trigger = {}) {
  switch (trigger.type) {
    case 'metric':
      return metricContent(trigger.metric || {});
    case 'provenance': {
      const html = provenanceHtml(trigger);
      return {
        title: 'Provenance & lineage',
        subtitle: 'Chain of custody',
        blocks: [html
          ? { kind: 'html', label: 'Attestation', html }
          : { kind: 'text', label: 'Status', text: 'No provenance chain recorded for this table yet.' }],
      };
    }
    case 'trust-field': {
      const field = trigger.field || {};
      switch (field.key) {
        case 'validation':
          return validationContent(trigger.validationResults);
        case 'certification':
          return certificationContent(trigger.metrics);
        case 'lineage': {
          const html = provenanceHtml(trigger);
          return {
            title: 'Lineage',
            subtitle: 'Trust Strip · provenance',
            blocks: [html
              ? { kind: 'html', label: 'Attestation', html }
              : { kind: 'text', label: field.label || 'Lineage', text: field.detail || 'No provenance chain recorded for this table yet.' }],
          };
        }
        default:
          return {
            title: field.label || 'Detail',
            subtitle: 'Trust Strip',
            blocks: [
              { kind: 'kv', label: 'Value', value: field.value != null ? String(field.value) : '—' },
              { kind: 'text', label: 'What this means', text: field.detail || '' },
            ],
          };
      }
    }
    default:
      return { title: 'Proof', subtitle: '', blocks: [{ kind: 'text', label: '', text: 'Nothing to show.' }] };
  }
}

function renderBlock(block) {
  switch (block.kind) {
    case 'kv':
      return el('div', { style: 'margin:var(--space-2) 0;' }, [
        el('span', { style: 'color:var(--color-text-muted); margin-right:6px;' }, `${block.label}:`),
        el('span', { style: 'font-weight:600;' }, String(block.value)),
      ]);
    case 'text':
      return el('div', { style: 'margin:var(--space-2) 0;' }, [
        block.label ? el('div', { style: 'color:var(--color-text-muted); font-size:var(--text-sm);' }, block.label) : null,
        el('div', {}, block.text || ''),
      ]);
    case 'list':
      return el('div', { style: 'margin:var(--space-2) 0;' }, [
        el('div', { style: 'color:var(--color-text-muted); font-size:var(--text-sm); margin-bottom:4px;' }, block.label || ''),
        el('ul', { style: 'margin:0; padding-left:20px;' }, (block.items || []).map(it => el('li', {}, String(it)))),
      ]);
    case 'code': {
      const pre = el('pre', {
        'data-testid': 'proof-code',
        style: `margin:6px 0 0; padding:10px; background:var(--color-bg-subtle,#f6f8fa); border-radius:6px; overflow:auto; font-size:12px; ${block.collapsible ? 'display:none;' : ''}`,
      }, block.code || '');
      const wrap = el('div', { style: 'margin:var(--space-2) 0;' });
      if (block.collapsible) {
        const toggle = el('button', { class: 'btn btn-ghost', type: 'button', 'data-testid': 'proof-show-math' }, `Show the math — ${block.label}`);
        toggle.addEventListener('click', () => {
          const open = pre.style.display === 'none';
          pre.style.display = open ? '' : 'none';
          toggle.textContent = `${open ? 'Hide' : 'Show'} the math — ${block.label}`;
        });
        wrap.appendChild(toggle);
      } else {
        wrap.appendChild(el('div', { style: 'color:var(--color-text-muted); font-size:var(--text-sm);' }, block.label || ''));
      }
      wrap.appendChild(pre);
      return wrap;
    }
    case 'html': {
      const frame = el('iframe', {
        'data-testid': 'proof-html-frame',
        style: 'width:100%; height:420px; border:1px solid var(--color-border,#ddd); border-radius:8px; background:#fff;',
        srcdoc: block.html || '',
      });
      return el('div', { style: 'margin:var(--space-2) 0;' }, [frame]);
    }
    default:
      return el('div', {});
  }
}

/**
 * Open (or replace) the slide-out Proof Drawer for a trigger. Idempotent: reuses
 * a single drawer + backdrop element per host. Returns { close }.
 * @param {object} opts
 * @param {object} opts.trigger passed to buildProofContent
 * @param {HTMLElement} [opts.mount] where to attach (defaults to document.body)
 */
export function openProofDrawer(opts = {}) {
  const { trigger, mount = document.body } = opts;
  const content = buildProofContent(trigger);

  // Remove any existing drawer so re-triggering scopes cleanly.
  const existing = mount.querySelector('[data-testid="proof-drawer"]');
  if (existing) existing.remove();
  const existingBackdrop = mount.querySelector('[data-testid="proof-drawer-backdrop"]');
  if (existingBackdrop) existingBackdrop.remove();

  const backdrop = el('div', {
    'data-testid': 'proof-drawer-backdrop',
    style: 'position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:900;',
  });
  const drawer = el('div', {
    'data-testid': 'proof-drawer', role: 'dialog', 'aria-label': 'Proof drawer',
    style: 'position:fixed; top:0; right:0; height:100%; width:min(560px,92vw); background:var(--color-bg,#fff); box-shadow:-4px 0 24px rgba(0,0,0,0.2); z-index:901; overflow:auto; padding:var(--space-4);',
  });
  const close = () => { drawer.remove(); backdrop.remove(); };
  backdrop.addEventListener('click', close);

  drawer.appendChild(el('div', { style: 'display:flex; justify-content:space-between; align-items:baseline; margin-bottom:var(--space-3);' }, [
    el('div', {}, [
      content.subtitle ? el('div', { style: 'color:var(--color-text-muted); font-size:var(--text-sm);' }, content.subtitle) : null,
      el('h2', { style: 'margin:2px 0 0; font-size:var(--text-lg);' }, content.title),
    ]),
    el('button', { class: 'btn btn-ghost', type: 'button', 'data-testid': 'proof-drawer-close', onclick: close }, '✕'),
  ]));
  for (const block of content.blocks) drawer.appendChild(renderBlock(block));

  mount.appendChild(backdrop);
  mount.appendChild(drawer);
  return { close };
}
