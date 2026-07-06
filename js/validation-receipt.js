// ============================================================
// DATAGLOW — Shareable Validation Receipts
// ============================================================
// Packages a completed analysis into ONE self-contained, readable artifact a
// non-technical stakeholder can open in any browser without running DATAGLOW:
//   • the overall Confidence grade,
//   • a pass/fail summary of all 18 validation layers,
//   • the key Assumption Ledger entries, and
//   • the generated Story narrative.
//
// The receipt is a single HTML file with inline styles — no external assets, no
// scripts, no fonts fetched at open time. buildValidationReceipt() is a pure,
// Node-testable function; renderReceiptHTML() turns that model into the file.
// ============================================================

import { LAYER_DEFS } from './validation.js';
import { escapeHtml } from './utils.js';

// Layers that are not part of the runAllLayers status map: confidence is a
// score object (handled on its own), red_team is run via its own modal.
const SCORE_LAYER = 'confidence';
const MODAL_LAYER = 'red_team';

// Assemble the structured receipt model from the pieces DATAGLOW already has:
// the runAllLayers() result map, the Confidence score object, the ledger
// entries, and the story text. Pure — no DOM, no engine.
export function buildValidationReceipt({ datasetName, results = {}, ledgerEntries = [], storyText = null, generatedAt = Date.now() } = {}) {
  const confidence = results[SCORE_LAYER]
    ? {
        score: results[SCORE_LAYER].score,
        grade: results[SCORE_LAYER].grade,
        verdict: results[SCORE_LAYER].verdict,
        status: results[SCORE_LAYER].status,
      }
    : null;

  const layers = [];
  const summary = { pass: 0, fail: 0, warn: 0, idle: 0, total: 0 };
  for (const def of LAYER_DEFS) {
    if (def.id === SCORE_LAYER) {
      // Fold the Confidence Layer in using its grade→status mapping so the
      // pass/fail tally covers all 18 layers.
      const status = confidence ? confidence.status : 'idle';
      layers.push({ id: def.id, name: def.name, status, summary: confidence ? `Grade ${confidence.grade} — ${confidence.verdict} (${confidence.score}/100).` : 'Not run.' });
      summary[status] = (summary[status] || 0) + 1;
      summary.total++;
      continue;
    }
    if (def.id === MODAL_LAYER) {
      // Red Team is a separate self-attack drill, not part of runAllLayers.
      layers.push({ id: def.id, name: def.name, status: 'idle', summary: 'Run separately from the Red Team drill.' });
      summary.idle++;
      summary.total++;
      continue;
    }
    const r = results[def.id] || { status: 'idle', summary: 'Not run.' };
    const status = r.status || 'idle';
    layers.push({ id: def.id, name: def.name, status, summary: r.summary || '' });
    summary[status] = (summary[status] || 0) + 1;
    summary.total++;
  }

  return {
    kind: 'dataglow-validation-receipt',
    version: 1,
    datasetName: datasetName || 'Untitled dataset',
    generatedAt,
    confidence,
    layers,
    summary,
    ledger: ledgerEntries.map(e => ({ ts: e.ts, source: e.source, action: e.action })),
    story: storyText || null,
  };
}

const STATUS_COLOR = { pass: '#1a7f4b', fail: '#b3261e', warn: '#9a6a00', idle: '#6b7280' };
const GRADE_COLOR = { A: '#1a7f4b', B: '#3a7bd5', C: '#9a6a00', D: '#b3261e' };

function statusPill(status) {
  const color = STATUS_COLOR[status] || STATUS_COLOR.idle;
  return `<span style="display:inline-block; min-width:52px; text-align:center; font-size:11px; font-weight:700; letter-spacing:0.04em; padding:2px 8px; border-radius:999px; color:#fff; background:${color};">${escapeHtml(status.toUpperCase())}</span>`;
}

// Render the model into a fully self-contained HTML document. DATAGLOW's own
// receipt layout — a centered "certificate" card, a confidence ring badge, and
// a plain-language layer table — deliberately NOT modeled on any other tool's
// report or review UI.
export function renderReceiptHTML(model) {
  const dt = new Date(model.generatedAt).toLocaleString();
  const c = model.confidence;
  const gradeColor = c ? (GRADE_COLOR[c.grade] || '#6b7280') : '#6b7280';

  const layerRows = model.layers.map(l => `
        <tr>
          <td style="padding:8px 10px; border-bottom:1px solid #eceff3; font-weight:600; white-space:nowrap;">${escapeHtml(l.name)}</td>
          <td style="padding:8px 10px; border-bottom:1px solid #eceff3;">${statusPill(l.status)}</td>
          <td style="padding:8px 10px; border-bottom:1px solid #eceff3; color:#42505f;">${escapeHtml(l.summary || '')}</td>
        </tr>`).join('');

  const ledgerRows = model.ledger.length
    ? model.ledger.map(e => `
        <li style="padding:6px 0; border-bottom:1px solid #eceff3;">
          <span style="color:#8a97a6;">[${escapeHtml(new Date(e.ts).toLocaleTimeString())}]</span>
          <strong style="color:#42505f;">${escapeHtml(e.source)}:</strong>
          ${escapeHtml(e.action)}
        </li>`).join('')
    : '<li style="padding:6px 0; color:#8a97a6;">No assumptions were recorded for this analysis.</li>';

  const storyBlock = model.story
    ? `<p style="margin:0; line-height:1.6; color:#2a3542;">${escapeHtml(model.story)}</p>`
    : `<p style="margin:0; color:#8a97a6;">No story narrative was generated for this analysis.</p>`;

  const confidenceBlock = c
    ? `
      <div style="display:flex; align-items:center; gap:18px; flex-wrap:wrap;">
        <div style="width:96px; height:96px; border-radius:50%; border:8px solid ${gradeColor}; display:flex; flex-direction:column; align-items:center; justify-content:center; flex:none;">
          <div style="font-size:26px; font-weight:800; color:#1a2430; line-height:1;">${escapeHtml(String(c.score))}</div>
          <div style="font-size:12px; font-weight:700; color:${gradeColor};">Grade ${escapeHtml(c.grade)}</div>
        </div>
        <div>
          <div style="font-size:18px; font-weight:700; color:#1a2430;">${escapeHtml(c.verdict)}</div>
          <div style="font-size:13px; color:#6b7280;">Overall confidence in this analysis, scored across DATAGLOW's six signals.</div>
        </div>
      </div>`
    : `<div style="color:#8a97a6;">Confidence Layer was not run for this analysis.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DATAGLOW Validation Receipt — ${escapeHtml(model.datasetName)}</title>
</head>
<body style="margin:0; padding:24px; background:#f4f6f9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1a2430;">
  <div style="max-width:820px; margin:0 auto; background:#fff; border:1px solid #e3e8ee; border-radius:14px; overflow:hidden; box-shadow:0 1px 3px rgba(16,24,40,0.06);">
    <div style="padding:22px 28px; background:linear-gradient(135deg,#1a2430,#2a3a52); color:#fff;">
      <div style="font-size:12px; letter-spacing:0.14em; text-transform:uppercase; opacity:0.75;">DATAGLOW · Validation Receipt</div>
      <div style="font-size:22px; font-weight:800; margin-top:4px;">${escapeHtml(model.datasetName)}</div>
      <div style="font-size:12px; opacity:0.7; margin-top:2px;">Generated ${escapeHtml(dt)}</div>
    </div>

    <div style="padding:24px 28px;">
      <section style="margin-bottom:26px;">
        <h2 style="font-size:13px; letter-spacing:0.08em; text-transform:uppercase; color:#6b7280; margin:0 0 12px;">Overall Confidence</h2>
        ${confidenceBlock}
      </section>

      <section style="margin-bottom:26px;">
        <h2 style="font-size:13px; letter-spacing:0.08em; text-transform:uppercase; color:#6b7280; margin:0 0 12px;">
          Validation Layers — ${model.summary.pass} passed · ${model.summary.fail} failed · ${model.summary.warn} warned · ${model.summary.idle} not run
        </h2>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="text-align:left; color:#8a97a6; font-size:11px; text-transform:uppercase; letter-spacing:0.06em;">
              <th style="padding:0 10px 8px;">Layer</th>
              <th style="padding:0 10px 8px;">Status</th>
              <th style="padding:0 10px 8px;">Result</th>
            </tr>
          </thead>
          <tbody>${layerRows}
          </tbody>
        </table>
      </section>

      <section style="margin-bottom:26px;">
        <h2 style="font-size:13px; letter-spacing:0.08em; text-transform:uppercase; color:#6b7280; margin:0 0 12px;">Key Assumptions</h2>
        <ul style="list-style:none; padding:0; margin:0; font-size:13px;">${ledgerRows}
        </ul>
      </section>

      <section>
        <h2 style="font-size:13px; letter-spacing:0.08em; text-transform:uppercase; color:#6b7280; margin:0 0 12px;">Story</h2>
        ${storyBlock}
      </section>
    </div>

    <div style="padding:14px 28px; background:#f8fafc; border-top:1px solid #e3e8ee; font-size:11px; color:#8a97a6;">
      This receipt was produced by DATAGLOW. It is a static snapshot — open it in any browser to review the analysis without running DATAGLOW.
    </div>
  </div>
</body>
</html>`;
}
