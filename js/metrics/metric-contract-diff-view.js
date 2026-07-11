// ============================================================
// DATAGLOW — Metric Contracts, Batch 2: diff view (read-only)
// ============================================================
// Turns the pure diffVersions()/history data from js/metrics/metric-contracts.js
// into something a person can actually look at: "what changed between version 2
// and version 3 of this metric, who changed it, and why." Read-only — this batch
// has no write path, no "apply" button, and no AI-agent involvement. That is
// Batch 3, which will call the SAME buildDiffViewContent()/renderDiffView() this
// batch ships, so an AI-proposed change looks visually IDENTICAL to a human's
// past change — the only difference is a confirm step Batch 3 adds around it.
//
// Follows the exact split js/trust/proof-drawer.js already established:
//   1. buildDiffViewContent() — PURE, returns a normalised block model
//      ({kind:'kv'|'text'|'list'|'field-diff'}). No DOM. Node-testable.
//   2. renderDiffView() — DOM presenter, reusing proof-drawer's existing block
//      renderer for the kinds it shares (kv/text/list) plus one new kind
//      ('field-diff') this file renders itself, so the two panels look and
//      behave consistently without duplicating CSS or layout logic.
//
// Gated behind the `metricContracts` flag by the caller (a later wiring step,
// not this batch — nothing in main.js calls renderDiffView() yet).

import { el, escapeHtml } from '../app-shell/utils.js';
import { diffVersions, summarizeDiff } from './metric-contracts.js';

const FIELD_LABELS = {
  name: 'Name',
  plainEnglish: 'Plain-English definition',
  expression: 'Formula',
  owner: 'Owner',
  tag: 'Tag',
};

function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

/**
 * Build the pure content model for a diff between two contract versions of the
 * same metric. Accepts either two version entries (as returned by
 * MetricContractHistory.list()/get()) or two bare snapshots — diffVersions()
 * already handles both via snapshotDefinition().
 * @param {object} opts
 * @param {string} opts.metricName display name for the title
 * @param {object} opts.before earlier version entry or snapshot
 * @param {object} opts.after later version entry or snapshot
 * @returns {{title:string, subtitle:string, blocks:Array<object>}}
 */
export function buildDiffViewContent({ metricName, before, after } = {}) {
  const beforeSnap = before && before.snapshot ? before.snapshot : before;
  const afterSnap = after && after.snapshot ? after.snapshot : after;
  const diff = diffVersions(beforeSnap, afterSnap);

  const blocks = [];
  const beforeLabel = before && typeof before.version === 'number' ? `version ${before.version}` : 'before';
  const afterLabel = after && typeof after.version === 'number' ? `version ${after.version}` : 'after';
  blocks.push({ kind: 'text', label: 'Comparing', text: `${beforeLabel} → ${afterLabel}` });

  if (after && after.changedBy) blocks.push({ kind: 'kv', label: 'Changed by', value: after.changedBy });
  if (after && after.changedAt) blocks.push({ kind: 'kv', label: 'Changed at', value: new Date(after.changedAt).toISOString() });
  if (after && after.source) blocks.push({ kind: 'kv', label: 'Source', value: after.source === 'agent-proposed' ? 'AI-agent proposed' : 'Human edit' });
  if (after && after.reason) blocks.push({ kind: 'text', label: 'Reason given', text: after.reason });

  if (!diff.changed) {
    blocks.push({ kind: 'text', label: 'Result', text: 'No changes between these two versions.' });
  } else {
    blocks.push({
      kind: 'field-diff',
      label: `${diff.fields.length} field${diff.fields.length === 1 ? '' : 's'} changed`,
      fields: diff.fields.map(f => ({ field: f.field, fieldLabel: fieldLabel(f.field), before: f.before, after: f.after })),
    });
  }

  return {
    title: metricName || 'Metric contract diff',
    subtitle: summarizeDiff(diff),
    diff,
    blocks,
  };
}

/**
 * Build the content model for a metric's FULL version history (a timeline,
 * not a single pairwise diff) — used by the history list view before a user
 * picks two versions to compare.
 * @param {{metricName?:string, versions:Array<object>}} opts
 * @returns {{title:string, subtitle:string, blocks:Array<object>}}
 */
export function buildHistoryListContent({ metricName, versions } = {}) {
  const list = Array.isArray(versions) ? versions : [];
  const items = list.map(v => {
    const when = v.changedAt ? new Date(v.changedAt).toISOString() : 'unknown time';
    const who = v.changedBy || 'unknown';
    const src = v.source === 'agent-proposed' ? ' (AI-agent proposed)' : '';
    return `v${v.version} — ${when} — ${who}${src}${v.reason ? `: ${v.reason}` : ''}`;
  });
  return {
    title: metricName || 'Metric contract',
    subtitle: `${list.length} version${list.length === 1 ? '' : 's'} recorded`,
    blocks: [items.length
      ? { kind: 'list', label: 'Version history (oldest first)', items }
      : { kind: 'text', label: 'History', text: 'No versions recorded yet for this metric.' }],
  };
}

// ------------------------------------------------------------
// DOM presenter
// ------------------------------------------------------------

function renderFieldDiffBlock(block) {
  const wrap = el('div', { style: 'margin:var(--space-2) 0;', 'data-testid': 'diff-field-diff' });
  wrap.appendChild(el('div', { style: 'color:var(--color-text-muted); font-size:var(--text-sm); margin-bottom:6px;' }, block.label || ''));
  const table = el('div', { style: 'display:flex; flex-direction:column; gap:8px;' });
  for (const f of block.fields) {
    const row = el('div', {
      style: 'border:1px solid var(--color-border,#e1e4e8); border-radius:6px; padding:8px;',
      'data-testid': 'diff-field-row',
      'data-field': f.field,
    });
    row.appendChild(el('div', { style: 'font-weight:600; margin-bottom:4px;' }, f.fieldLabel));
    row.appendChild(el('div', { style: 'display:flex; gap:8px; align-items:flex-start;' }, [
      el('div', { style: 'flex:1; padding:4px 6px; background:var(--color-danger-bg,#ffeef0); border-radius:4px; font-size:12px; word-break:break-word;', 'data-testid': 'diff-before' }, `− ${f.before || '(empty)'}`),
      el('div', { style: 'flex:1; padding:4px 6px; background:var(--color-success-bg,#e6ffed); border-radius:4px; font-size:12px; word-break:break-word;', 'data-testid': 'diff-after' }, `+ ${f.after || '(empty)'}`),
    ]));
    table.appendChild(row);
  }
  wrap.appendChild(table);
  return wrap;
}

function renderBlockShared(block) {
  // Mirrors js/trust/proof-drawer.js's renderBlock for the kinds this view
  // shares with it, so both panels look and behave the same way. Kept as a
  // small local copy rather than an import to avoid coupling this module's
  // DOM rendering to proof-drawer's internals (that function isn't exported).
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
    case 'field-diff':
      return renderFieldDiffBlock(block);
    default:
      return null;
  }
}

/**
 * Render a diff-view content model (from buildDiffViewContent or
 * buildHistoryListContent) into `host`. Pure DOM, no state of its own — the
 * caller decides when/how this mounts (e.g. inside the existing Proof Drawer
 * slide-out, or its own panel); that wiring is a later step, not this batch.
 * @param {{host:HTMLElement, content:{title:string, subtitle:string, blocks:Array<object>}}} opts
 */
export function renderDiffView({ host, content } = {}) {
  if (!host || !content) return;
  host.innerHTML = '';
  host.appendChild(el('h3', { 'data-testid': 'diff-title', style: 'margin:0 0 2px;' }, escapeHtml(content.title || '')));
  if (content.subtitle) host.appendChild(el('div', { 'data-testid': 'diff-subtitle', style: 'color:var(--color-text-muted); font-size:var(--text-sm); margin-bottom:8px;' }, escapeHtml(content.subtitle)));
  for (const block of content.blocks || []) {
    const node = renderBlockShared(block);
    if (node) host.appendChild(node);
  }
}
