// ============================================================
// DATAGLOW — Async Peer Review Mode
// ============================================================
// A lightweight, file-based review workflow — no backend, no real-time
// multiplayer. DATAGLOW exports a structured "review packet" (the query, key
// findings, validation-layer results, and Assumption Ledger). A second person
// opens it, records a per-section decision (approve / flag) plus free-text
// notes, and sends the completed file back. DATAGLOW re-imports it and shows
// the review alongside the original analysis.
//
// This is DATAGLOW's OWN checklist model — a flat list of analysis sections,
// each with a three-state decision chip. It is intentionally not modeled on any
// pull-request review or document-commenting product.
// ============================================================

import { LAYER_DEFS } from './validation.js';
import { escapeHtml } from './utils.js';

export const PACKET_KIND = 'dataglow-peer-review-packet';
export const PACKET_VERSION = 1;
export const DECISIONS = ['approved', 'flagged', 'pending'];

const SCORE_LAYER = 'confidence';
const MODAL_LAYER = 'red_team';

// Build the structured review packet from the current analysis. Pure and
// Node-testable. Each section carries a machine id, a human title, the content
// to review, and an empty `review` slot the reviewer fills in.
export function buildReviewPacket({ datasetName, query = null, results = {}, ledgerEntries = [], generatedAt = Date.now() } = {}) {
  const sections = [];

  sections.push({
    id: 'query',
    title: 'Query / Analysis',
    body: query ? String(query) : '(No SQL query was recorded for this analysis.)',
    review: emptyReview(),
  });

  // Key findings = the layers that did NOT cleanly pass, surfaced first so the
  // reviewer sees the risks up front.
  const findings = [];
  for (const def of LAYER_DEFS) {
    if (def.id === SCORE_LAYER || def.id === MODAL_LAYER) continue;
    const r = results[def.id];
    if (r && (r.status === 'fail' || r.status === 'warn')) {
      findings.push(`${def.name} [${r.status.toUpperCase()}]: ${r.summary || ''}`.trim());
    }
  }
  const conf = results[SCORE_LAYER];
  sections.push({
    id: 'findings',
    title: 'Key Findings',
    body: findings.length ? findings.join('\n') : 'No failing or warning layers — all checks passed cleanly.',
    meta: conf ? { confidenceGrade: conf.grade, confidenceScore: conf.score, confidenceVerdict: conf.verdict } : null,
    review: emptyReview(),
  });

  // Full validation-layer roll-up.
  const layers = [];
  for (const def of LAYER_DEFS) {
    if (def.id === MODAL_LAYER) continue;
    if (def.id === SCORE_LAYER) {
      layers.push({ id: def.id, name: def.name, status: conf ? conf.status : 'idle', summary: conf ? `Grade ${conf.grade} (${conf.score}/100) — ${conf.verdict}` : 'Not run.' });
      continue;
    }
    const r = results[def.id] || { status: 'idle', summary: 'Not run.' };
    layers.push({ id: def.id, name: def.name, status: r.status || 'idle', summary: r.summary || '' });
  }
  sections.push({
    id: 'validation_layers',
    title: 'Validation Layers',
    layers,
    review: emptyReview(),
  });

  sections.push({
    id: 'assumption_ledger',
    title: 'Assumption Ledger',
    entries: ledgerEntries.map(e => ({ ts: e.ts, source: e.source, action: e.action })),
    review: emptyReview(),
  });

  return {
    kind: PACKET_KIND,
    version: PACKET_VERSION,
    datasetName: datasetName || 'Untitled dataset',
    generatedAt,
    sections,
    reviewer: { name: '', submittedAt: null },
  };
}

function emptyReview() {
  return { decision: 'pending', notes: '' };
}

// Serialize the packet for sharing. JSON is the round-trippable format the
// reviewer edits and returns; markdown is a human-readable companion.
export function exportPacket(packet, format = 'json') {
  if (format === 'json') return JSON.stringify(packet, null, 2);
  if (format === 'markdown') return packetToMarkdown(packet);
  throw new Error(`Unknown peer-review export format: ${format}`);
}

function packetToMarkdown(packet) {
  const lines = [];
  lines.push(`# DATAGLOW Peer Review Packet`);
  lines.push('');
  lines.push(`**Dataset:** ${packet.datasetName}`);
  lines.push(`**Generated:** ${new Date(packet.generatedAt).toISOString()}`);
  lines.push('');
  lines.push('> Reviewer: for each section set a decision (approved / flagged) and add notes, then return this file (JSON version) to re-import into DATAGLOW.');
  lines.push('');
  for (const s of packet.sections) {
    lines.push(`## ${s.title}`);
    if (s.body) lines.push('', '```', s.body, '```');
    if (s.layers) {
      lines.push('');
      for (const l of s.layers) lines.push(`- **${l.name}** — \`${l.status.toUpperCase()}\` — ${l.summary}`);
    }
    if (s.entries) {
      lines.push('');
      if (!s.entries.length) lines.push('- (no assumptions recorded)');
      for (const e of s.entries) lines.push(`- [${new Date(e.ts).toISOString()}] **${e.source}:** ${e.action}`);
    }
    lines.push('');
    lines.push(`- Decision: ${s.review.decision}`);
    lines.push(`- Notes: ${s.review.notes || '_(none)_'}`);
    lines.push('');
  }
  return lines.join('\n');
}

// Re-import a completed review. Accepts the JSON string the reviewer returns,
// validates it is a DATAGLOW packet, and normalizes every section's review slot
// so downstream rendering can trust the shape. Throws on a non-packet file.
export function importReview(jsonText) {
  let parsed;
  try {
    parsed = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
  } catch (e) {
    throw new Error('Not valid JSON — expected a DATAGLOW peer-review packet.');
  }
  if (!parsed || parsed.kind !== PACKET_KIND) {
    throw new Error('This file is not a DATAGLOW peer-review packet.');
  }
  parsed.sections = (parsed.sections || []).map(s => ({
    ...s,
    review: {
      decision: DECISIONS.includes(s.review && s.review.decision) ? s.review.decision : 'pending',
      notes: (s.review && typeof s.review.notes === 'string') ? s.review.notes : '',
    },
  }));
  return parsed;
}

// Tally the reviewer's decisions for an at-a-glance verdict.
export function summarizeReview(packet) {
  const counts = { approved: 0, flagged: 0, pending: 0 };
  for (const s of packet.sections || []) {
    const d = s.review && s.review.decision;
    if (counts[d] != null) counts[d]++;
  }
  const total = (packet.sections || []).length;
  return {
    ...counts,
    total,
    complete: counts.pending === 0 && total > 0,
    verdict: counts.flagged > 0 ? 'Changes requested' : (counts.pending === 0 && total > 0 ? 'Approved' : 'In review'),
  };
}

// Render the imported review as HTML for display beside the original analysis.
// Uses DATAGLOW's own card list; not a clone of any review UI.
export function renderReviewHTML(packet) {
  const sum = summarizeReview(packet);
  const color = sum.flagged > 0 ? '#b3261e' : (sum.complete ? '#1a7f4b' : '#9a6a00');
  const chip = { approved: '#1a7f4b', flagged: '#b3261e', pending: '#6b7280' };
  const sections = (packet.sections || []).map(s => `
    <div style="padding:10px 0; border-top:1px solid var(--color-divider);">
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-weight:600;">${escapeHtml(s.title)}</span>
        <span style="margin-left:auto; font-size:11px; font-weight:700; color:#fff; background:${chip[s.review.decision] || chip.pending}; padding:2px 8px; border-radius:999px;">${escapeHtml((s.review.decision || 'pending').toUpperCase())}</span>
      </div>
      ${s.review.notes ? `<div style="font-size:var(--text-sm); color:var(--color-text-muted); margin-top:4px;">${escapeHtml(s.review.notes)}</div>` : ''}
    </div>`).join('');
  return `
    <div style="font-weight:700; color:${color}; margin-bottom:4px;">${escapeHtml(sum.verdict)} — ${sum.approved} approved · ${sum.flagged} flagged · ${sum.pending} pending</div>
    ${packet.reviewer && packet.reviewer.name ? `<div style="font-size:var(--text-xs); color:var(--color-text-faint); margin-bottom:6px;">Reviewed by ${escapeHtml(packet.reviewer.name)}</div>` : ''}
    ${sections}`;
}
