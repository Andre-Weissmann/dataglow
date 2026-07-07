// ============================================================
// DATAGLOW — IRB / Regulatory Language Auto-Translation Mode
// ============================================================
// Reformats DATAGLOW's existing analysis artifacts — the Validation Receipt
// (confidence + 20 validation layers), the Assumption Ledger, and the
// Provenance Trail (chain of custody) — into a document structured with the
// section headers an IRB reviewer or HIPAA privacy officer expects, using
// template-based text generation (no LLM dependency). The validation findings
// are substituted into the templated prose so the document reflects the actual
// analysis, not boilerplate.
//
// Section structure follows common IRB data-management / human-subjects
// protocol documentation:
//   1. Study Data Overview
//   2. Data Integrity Controls (data-quality validation summary)
//   3. Chain of Custody / Provenance
//   4. De-identification Method Disclosure (HIPAA §164.514)
//   5. Assumption & Judgment Log
//   6. Known Limitations & Residual Risk
//   7. Documentation Attestation
//
// buildIRBDocument() is a pure, Node-testable model builder; renderIRBHTML()
// turns it into a self-contained, print-to-PDF-ready HTML document that reuses
// the Validation Receipt's inline-styled, script-free layout pattern.
// ============================================================

import { buildValidationReceipt } from './validation-receipt.js';
import { escapeHtml } from './utils.js';

export const IRB_DISCLAIMER =
  'This document is a documentation aid generated automatically by DATAGLOW from ' +
  'the analysis performed in-browser. It is NOT a substitute for review by a ' +
  'qualified legal, compliance, or Institutional Review Board (IRB) professional, ' +
  'and does not itself constitute IRB approval, a HIPAA determination, or legal advice.';

function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// Build the structured IRB document model. Inputs mirror what the app already
// has: the runAllLayers() result map, ledger entries, an optional provenance
// trail (array of {index, op, description, hash, parentHash}), an optional
// provenance verification result, and an optional de-identification descriptor
// (e.g. { method: 'Differential privacy (Laplace)', epsilon: 5 }).
export function buildIRBDocument({
  datasetName,
  results = {},
  ledgerEntries = [],
  provenanceTrail = [],
  provenanceVerification = null,
  deidentification = null,
  storyText = null,
  generatedAt = Date.now(),
} = {}) {
  const receipt = buildValidationReceipt({ datasetName, results, ledgerEntries, storyText, generatedAt });
  const { summary, confidence, layers } = receipt;

  const failed = layers.filter(l => l.status === 'fail');
  const warned = layers.filter(l => l.status === 'warn');

  const integrityNarrative =
    `Data quality was assessed by DATAGLOW's automated validation suite across ${summary.total} independent ` +
    `checks (schema conformance, null and duplicate detection, outlier and distributional analysis, Benford's-Law ` +
    `digit analysis, cross-column logical consistency, and an overall confidence score). ` +
    `Of these, ${summary.pass} passed, ${summary.warn} raised warnings, ${summary.fail} failed, and ${summary.idle} were not run. ` +
    (confidence ? `The composite data-confidence grade is ${confidence.grade} (${confidence.score}/100): ${confidence.verdict}. ` : '') +
    (failed.length ? `Failed checks requiring reviewer attention: ${failed.map(l => l.name).join('; ')}. ` : 'No checks failed. ') +
    (warned.length ? `Checks raising warnings: ${warned.map(l => l.name).join('; ')}.` : '');

  const custodyNarrative = provenanceTrail.length
    ? `A tamper-evident chain of custody was maintained via a SHA-256 hash chain in which each recorded ` +
      `transformation commits to the hash of the prior step, so any post-hoc alteration of an earlier step ` +
      `invalidates every subsequent hash. ${provenanceTrail.length} step(s) are recorded. ` +
      (provenanceVerification ? `Chain verification result: ${provenanceVerification.valid ? 'INTACT' : 'BROKEN'} — ${provenanceVerification.reason}` : '')
    : 'No provenance chain was recorded for this analysis. Chain of custody could not be independently established from the DATAGLOW session.';

  const deidNarrative = deidentification
    ? `De-identification was performed using: ${deidentification.method}. ` +
      (deidentification.epsilon != null ? `A formal differential-privacy budget of epsilon (ε) = ${deidentification.epsilon} was applied to aggregate/statistical outputs via the Laplace mechanism. ` : '') +
      (deidentification.notes ? deidentification.notes + ' ' : '') +
      `NOTE: DATAGLOW does not automatically verify HIPAA Safe Harbor (§164.514(b)(2)) removal of all 18 identifiers, ` +
      `nor does it perform Expert Determination (§164.514(b)(1)); the disclosed method must be independently confirmed.`
    : `No de-identification method was applied or disclosed within DATAGLOW for this analysis. If this dataset ` +
      `contains protected health information (PHI), a HIPAA de-identification method — Safe Harbor (§164.514(b)(2)) ` +
      `or Expert Determination (§164.514(b)(1)) — must be applied and documented before any external sharing.`;

  const limitations = [
    'DATAGLOW runs entirely client-side; findings reflect only the data loaded into this browser session and the checks that were actually run.',
    'Automated validation flags statistical and structural anomalies; it does not establish clinical or scientific validity, nor does it confirm regulatory compliance.',
    'De-identification status is self-reported here and is NOT automatically verified against the HIPAA Safe Harbor identifier list.',
    summary.idle > 0 ? `${summary.idle} validation check(s) were not run and therefore contribute no assurance.` : null,
    'This document is generated from a point-in-time snapshot; subsequent edits to the dataset are not reflected unless the document is regenerated.',
  ].filter(Boolean);

  const sections = [
    {
      id: 'overview', heading: '1. Study Data Overview',
      body: `This report documents automated data-integrity and provenance controls applied to the dataset ` +
        `"${datasetName || 'Untitled dataset'}" within DATAGLOW on ${fmtTime(generatedAt)}. ` +
        `It is intended to support IRB / privacy-officer review of the data-handling controls in place.`,
    },
    { id: 'integrity', heading: '2. Data Integrity Controls', body: integrityNarrative, layers },
    { id: 'custody', heading: '3. Chain of Custody / Provenance', body: custodyNarrative, trail: provenanceTrail },
    { id: 'deid', heading: '4. De-identification Method Disclosure (HIPAA §164.514)', body: deidNarrative },
    {
      id: 'assumptions', heading: '5. Assumption & Judgment Log',
      body: ledgerEntries.length
        ? `The following judgment calls were recorded by DATAGLOW's automated processing and are disclosed for reviewer scrutiny:`
        : 'No automated judgment calls were recorded for this analysis.',
      ledger: ledgerEntries.map(e => ({ ts: e.ts, source: e.source, action: e.action })),
    },
    { id: 'limitations', heading: '6. Known Limitations & Residual Risk', body: 'The following limitations bound the assurance this document provides:', items: limitations },
    {
      id: 'attestation', heading: '7. Documentation Attestation',
      body: `This document was generated automatically by DATAGLOW and reflects the analysis state at ${fmtTime(generatedAt)}. ` +
        `It requires sign-off by a qualified reviewer before use in a regulatory or IRB submission.`,
    },
  ];

  return {
    kind: 'dataglow-irb-document',
    version: 1,
    datasetName: datasetName || 'Untitled dataset',
    generatedAt,
    confidence,
    summary,
    sections,
    disclaimer: IRB_DISCLAIMER,
  };
}

const STATUS_COLOR = { pass: '#1a7f4b', fail: '#b3261e', warn: '#9a6a00', idle: '#6b7280' };

function statusPill(status) {
  const color = STATUS_COLOR[status] || STATUS_COLOR.idle;
  return `<span style="display:inline-block; min-width:52px; text-align:center; font-size:11px; font-weight:700; letter-spacing:0.04em; padding:2px 8px; border-radius:999px; color:#fff; background:${color};">${escapeHtml(status.toUpperCase())}</span>`;
}

function renderSection(s) {
  let extra = '';
  if (s.layers) {
    extra = `<table style="width:100%; border-collapse:collapse; font-size:13px; margin-top:12px;">
      <thead><tr style="text-align:left; color:#8a97a6; font-size:11px; text-transform:uppercase; letter-spacing:0.06em;">
        <th style="padding:0 10px 8px;">Control / Check</th><th style="padding:0 10px 8px;">Status</th><th style="padding:0 10px 8px;">Finding</th></tr></thead>
      <tbody>${s.layers.map(l => `<tr>
        <td style="padding:8px 10px; border-bottom:1px solid #eceff3; font-weight:600; white-space:nowrap;">${escapeHtml(l.name)}</td>
        <td style="padding:8px 10px; border-bottom:1px solid #eceff3;">${statusPill(l.status)}</td>
        <td style="padding:8px 10px; border-bottom:1px solid #eceff3; color:#42505f;">${escapeHtml(l.summary || '')}</td></tr>`).join('')}</tbody></table>`;
  }
  if (s.trail && s.trail.length) {
    extra = `<ol style="font-size:12px; color:#42505f; margin:12px 0 0; padding-left:20px;">${s.trail.map(e =>
      `<li style="padding:4px 0;"><strong>${escapeHtml(e.op || 'step')}:</strong> ${escapeHtml(e.description || '')} <span style="color:#8a97a6; font-family:monospace;">hash ${escapeHtml(String(e.hash || '').slice(0, 16))}…</span></li>`).join('')}</ol>`;
  }
  if (s.ledger && s.ledger.length) {
    extra = `<ul style="list-style:none; padding:0; margin:12px 0 0; font-size:13px;">${s.ledger.map(e =>
      `<li style="padding:6px 0; border-bottom:1px solid #eceff3;"><span style="color:#8a97a6;">[${escapeHtml(fmtTime(e.ts))}]</span> <strong style="color:#42505f;">${escapeHtml(e.source)}:</strong> ${escapeHtml(e.action)}</li>`).join('')}</ul>`;
  }
  if (s.items && s.items.length) {
    extra = `<ul style="font-size:13px; color:#42505f; margin:12px 0 0; padding-left:20px;">${s.items.map(i => `<li style="padding:3px 0;">${escapeHtml(i)}</li>`).join('')}</ul>`;
  }
  return `<section style="margin-bottom:26px;">
    <h2 style="font-size:15px; color:#1a2430; margin:0 0 8px; border-bottom:2px solid #2a3a52; padding-bottom:6px;">${escapeHtml(s.heading)}</h2>
    <p style="margin:0; line-height:1.6; color:#2a3542; font-size:13px;">${escapeHtml(s.body)}</p>
    ${extra}
  </section>`;
}

// Self-contained, print-ready HTML. No scripts, no external assets.
export function renderIRBHTML(model) {
  const dt = fmtTime(model.generatedAt);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DATAGLOW IRB / Compliance Documentation — ${escapeHtml(model.datasetName)}</title>
</head>
<body style="margin:0; padding:24px; background:#f4f6f9; font-family:Georgia,'Times New Roman',serif; color:#1a2430;">
  <div style="max-width:820px; margin:0 auto; background:#fff; border:1px solid #e3e8ee; border-radius:8px; overflow:hidden;">
    <div style="padding:24px 32px; background:#1a2430; color:#fff;">
      <div style="font-size:11px; letter-spacing:0.16em; text-transform:uppercase; opacity:0.75;">DATAGLOW · IRB / Regulatory Documentation</div>
      <div style="font-size:22px; font-weight:700; margin-top:6px;">Data Integrity &amp; Chain-of-Custody Report</div>
      <div style="font-size:13px; opacity:0.85; margin-top:4px;">Dataset: ${escapeHtml(model.datasetName)}</div>
      <div style="font-size:12px; opacity:0.65; margin-top:2px;">Generated ${escapeHtml(dt)}</div>
    </div>
    <div style="padding:20px 32px; background:#fff4e5; border-bottom:1px solid #f0d9b5;">
      <strong style="color:#9a6a00; font-size:12px; letter-spacing:0.04em; text-transform:uppercase;">Documentation Aid — Not a Compliance Determination</strong>
      <p style="margin:6px 0 0; font-size:12px; color:#6b5320; line-height:1.5;">${escapeHtml(model.disclaimer)}</p>
    </div>
    <div style="padding:28px 32px;">
      ${model.sections.map(renderSection).join('\n')}
    </div>
    <div style="padding:14px 32px; background:#f8fafc; border-top:1px solid #e3e8ee; font-size:11px; color:#8a97a6;">
      Produced by DATAGLOW — a client-side data-quality workbench. Print to PDF for submission. Requires qualified-reviewer sign-off.
    </div>
  </div>
</body>
</html>`;
}
