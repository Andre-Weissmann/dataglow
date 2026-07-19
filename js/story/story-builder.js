// ============================================================
// DATAGLOW — Story View: dataset narrative builder
// ============================================================
// Pure-logic layer that turns a validated dataset + institutional memory
// into a structured narrative document (the "Story" tab in DataGlow Canvas).
// One-click: grid -> narrative -> PDF-ready output with a provenance hash.
//
// NO BROWSER APIS. Every function here is plain-object in, plain-object (or
// string) out, and is fully testable under plain Node with no DOM, no
// IndexedDB, no fetch. This mirrors the pure-builder / thin-renderer split
// used throughout the codebase (js/rooms/room-ui.js, js/diplomacy/diplomacy-ui.js,
// js/validation/source-convergence-ui.js).
//
// Institutional memory (js/institutional-memory.js, PR Q) is NOT imported
// directly. `buildTimelineSection` and `buildProvenanceSection` accept
// `generateTimeline` / `computeProvenanceHash` as injected functions (or fall
// back to a small inline djb2 implementation below), so this module runs
// standalone and does not require PR Q to be merged first. When PR Q lands,
// the Canvas wiring simply passes the real functions in via `options`.
// ============================================================

// ---------- djb2 hash (dependency-free, deterministic, sync) ----------
// Same algorithm used elsewhere in the codebase (see js/webhook/webhook-handler.js)
// for a tamper-evidence signal — NOT a cryptographic security boundary, just a
// fast, deterministic, dependency-free fingerprint over a string.
function djb2Hash(str) {
  let hash = 5381;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0; // hash * 33 + c
  }
  // Convert to an unsigned 32-bit hex string so it reads like a compact digest.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Fallback provenance hash used only when the caller does not inject a real
// computeProvenanceHash (e.g. from institutional-memory.js). Hashes a stable
// JSON representation of the dataset identity + record count so the value is
// deterministic given the same inputs.
function fallbackComputeProvenanceHash(memoryStore, datasetId) {
  const records = getRecordsForDataset(memoryStore, datasetId);
  const basis = JSON.stringify({
    datasetId: datasetId || null,
    recordCount: records.length,
    recordTypes: records.map((r) => r && r.type).sort(),
  });
  return djb2Hash(basis);
}

// Fallback timeline builder used only when the caller does not inject a real
// generateTimeline (e.g. from institutional-memory.js). Produces plain
// language strings from whatever records are available, oldest first.
function fallbackGenerateTimeline(memoryStore, datasetId, options = {}) {
  const max = options.maxTimelineEntries || 20;
  const records = getRecordsForDataset(memoryStore, datasetId)
    .slice()
    .sort((a, b) => timeValue(a) - timeValue(b));
  return records.slice(0, max).map((r) => describeRecord(r));
}

function timeValue(record) {
  const t = record && (record.timestamp || record.ts || record.recordedAt);
  const parsed = t ? Date.parse(t) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function describeRecord(record) {
  if (!record || typeof record !== 'object') return 'An unrecorded event occurred.';
  const type = record.type || 'EVENT';
  const when = record.timestamp || record.ts || record.recordedAt || 'an unknown time';
  const who = record.author || record.user || 'An analyst';
  switch (type) {
    case 'SQL_QUERY':
      return `${who} ran a SQL query at ${when}${record.note ? ` — ${record.note}` : ''}.`;
    case 'FINDING_RESOLVED':
      return `${who} resolved a finding${record.column ? ` on "${record.column}"` : ''} at ${when}.`;
    case 'NOTE':
      return `${who} added a note at ${when}${record.note ? `: ${record.note}` : ''}.`;
    default:
      return `${who} recorded a ${type} event at ${when}.`;
  }
}

// Safely pulls the array of memory records for a dataset out of a variety of
// plausible memoryStore shapes, so this module degrades gracefully rather
// than throwing when institutional-memory.js's exact shape shifts.
function getRecordsForDataset(memoryStore, datasetId) {
  if (!memoryStore) return [];
  let all = [];
  if (Array.isArray(memoryStore)) {
    all = memoryStore;
  } else if (Array.isArray(memoryStore.records)) {
    all = memoryStore.records;
  } else if (typeof memoryStore.getRecords === 'function') {
    try {
      all = memoryStore.getRecords(datasetId) || [];
      // getRecords may already be dataset-scoped; if so, skip the filter below.
      return all.filter(Boolean);
    } catch (_e) {
      all = [];
    }
  } else if (memoryStore.byDataset && datasetId != null) {
    all = memoryStore.byDataset[datasetId] || [];
  }
  if (!Array.isArray(all)) return [];
  if (datasetId == null) return all.filter(Boolean);
  return all.filter((r) => r && (r.datasetId === datasetId || r.datasetId == null));
}

// ---------- Section builders ----------

function clampHealth(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function severityRank(severity) {
  switch (severity) {
    case 'error': return 0;
    case 'critical': return 0;
    case 'warning': return 1;
    case 'info': return 2;
    default: return 3;
  }
}

/**
 * buildSummarySection(dataset, findings)
 * Returns a StorySection of type 'summary'.
 */
function buildSummarySection(dataset, findings) {
  const list = Array.isArray(findings) ? findings : [];
  const errorCount = list.filter((f) => f && (f.severity === 'error' || f.severity === 'critical')).length;
  const warningCount = list.filter((f) => f && f.severity === 'warning').length;
  const totalFindings = list.length;

  // Overall health: prefer an explicit dataset-level health score if present
  // (average of column healthScores), otherwise derive a simple deduction
  // model from finding severity so the section always has an honest number.
  let overallHealth;
  const columns = (dataset && Array.isArray(dataset.columns)) ? dataset.columns : [];
  const columnScores = columns
    .map((c) => c && typeof c.healthScore === 'number' ? c.healthScore : null)
    .filter((v) => v != null);
  if (columnScores.length > 0) {
    overallHealth = clampHealth(columnScores.reduce((a, b) => a + b, 0) / columnScores.length);
  } else {
    overallHealth = clampHealth(100 - errorCount * 10 - warningCount * 3);
  }

  const sortedForTop = list.slice().sort((a, b) => severityRank(a && a.severity) - severityRank(b && b.severity));
  const topIssues = sortedForTop.slice(0, 3).map((f) => ({
    column: (f && f.column) || 'dataset',
    severity: (f && f.severity) || 'info',
    message: (f && f.message) || '',
  }));

  return {
    id: 'summary',
    type: 'summary',
    title: 'Summary',
    content: {
      overallHealth,
      totalFindings,
      errorCount,
      warningCount,
      topIssues,
    },
  };
}

/**
 * buildFindingsSection(findings)
 * Returns a StorySection of type 'findings', sorted errors -> warnings -> info.
 */
function buildFindingsSection(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const items = list
    .slice()
    .sort((a, b) => severityRank(a && a.severity) - severityRank(b && b.severity))
    .map((f) => ({
      severity: (f && f.severity) || 'info',
      column: (f && f.column) || '',
      message: (f && f.message) || '',
      rowsAffected: (f && typeof f.rowsAffected === 'number') ? f.rowsAffected : null,
      suggestedFix: (f && f.suggestedFix) || null,
    }));

  return {
    id: 'findings',
    type: 'findings',
    title: 'Findings',
    content: { items },
  };
}

/**
 * buildTimelineSection(memoryStore, datasetId, options = {})
 * Returns a StorySection of type 'timeline'.
 * options.generateTimeline: injected function(memoryStore, datasetId, options) -> string[]
 *   Falls back to a small inline implementation when not provided (e.g.
 *   institutional-memory.js / PR Q not yet available).
 */
function buildTimelineSection(memoryStore, datasetId, options = {}) {
  const generate = typeof options.generateTimeline === 'function'
    ? options.generateTimeline
    : fallbackGenerateTimeline;
  let entries = [];
  try {
    entries = generate(memoryStore, datasetId, options) || [];
  } catch (_e) {
    entries = [];
  }
  if (!Array.isArray(entries)) entries = [];
  if (options.maxTimelineEntries) {
    entries = entries.slice(0, options.maxTimelineEntries);
  }

  return {
    id: 'timeline',
    type: 'timeline',
    title: 'Timeline',
    content: { entries },
  };
}

/**
 * buildSQLAuditSection(memoryStore, datasetId)
 * Returns a StorySection of type 'sql_audit'. Pulls all SQL_QUERY records
 * from the memory store for this dataset.
 */
function buildSQLAuditSection(memoryStore, datasetId) {
  const records = getRecordsForDataset(memoryStore, datasetId);
  const queries = records
    .filter((r) => r && r.type === 'SQL_QUERY')
    .slice()
    .sort((a, b) => timeValue(a) - timeValue(b))
    .map((r) => ({
      sql: r.sql || '',
      timestamp: r.timestamp || r.ts || r.recordedAt || null,
      note: r.note || '',
    }));

  return {
    id: 'sql_audit',
    type: 'sql_audit',
    title: 'SQL Audit',
    content: { queries },
  };
}

/**
 * buildProvenanceSection(dataset, memoryStore, datasetId)
 * Returns a StorySection of type 'provenance'.
 */
function buildProvenanceSection(dataset, memoryStore, datasetId, options = {}) {
  const computeHash = typeof options.computeProvenanceHash === 'function'
    ? options.computeProvenanceHash
    : fallbackComputeProvenanceHash;
  let provenanceHash;
  try {
    provenanceHash = computeHash(memoryStore, datasetId);
  } catch (_e) {
    provenanceHash = fallbackComputeProvenanceHash(memoryStore, datasetId);
  }
  const recordCount = getRecordsForDataset(memoryStore, datasetId).length;
  const generatedAt = (options.now) || new Date().toISOString();

  return {
    id: 'provenance',
    type: 'provenance',
    title: 'Provenance',
    content: {
      datasetName: (dataset && dataset.name) || 'Untitled dataset',
      rowCount: (dataset && dataset.rowCount) || 0,
      columnCount: (dataset && dataset.columnCount) || 0,
      provenanceHash,
      generatedAt,
      recordCount,
    },
  };
}

// ---------- Top-level story assembly ----------

function formatSubtitle(dataset, summaryContent) {
  const rows = (dataset && typeof dataset.rowCount === 'number') ? dataset.rowCount : 0;
  const cols = (dataset && typeof dataset.columnCount === 'number') ? dataset.columnCount : 0;
  const health = summaryContent ? Math.round(summaryContent.overallHealth) : 0;
  return `${rows.toLocaleString('en-US')} rows · ${cols} columns · Validation ${health}%`;
}

function deriveKeyFinding(summaryContent, findingsContent) {
  const top = summaryContent && summaryContent.topIssues && summaryContent.topIssues[0];
  if (top && top.message) {
    const label = top.severity === 'error' || top.severity === 'critical' ? 'Critical issue' : 'Top finding';
    return `${label}: ${top.message}`;
  }
  if (findingsContent && findingsContent.items && findingsContent.items.length === 0) {
    return 'No validation issues were found — this dataset is clean.';
  }
  return 'This dataset has no standout issues to report.';
}

/**
 * buildStory(dataset, findings, memoryStore, options = {})
 * Builds a complete StoryDocument from a dataset + findings + memory.
 */
function buildStory(dataset, findings, memoryStore, options = {}) {
  const datasetId = options.datasetId != null ? options.datasetId : (dataset && dataset.id);
  const includeTimeline = options.includeTimeline !== false; // default true
  const includeSQL = options.includeSQL !== false; // default true

  const summarySection = buildSummarySection(dataset, findings);
  const findingsSection = buildFindingsSection(findings);
  const provenanceSection = buildProvenanceSection(dataset, memoryStore, datasetId, options);

  const sections = [summarySection, findingsSection];

  if (includeTimeline) {
    sections.push(buildTimelineSection(memoryStore, datasetId, options));
  }
  if (includeSQL) {
    const sqlSection = buildSQLAuditSection(memoryStore, datasetId);
    // Only include the section in the document if there's something to show,
    // or the caller explicitly asked for it via includeSQL — matches the
    // "## SQL Audit (if any SQL queries)" rendering contract, but the
    // section is still always available for callers composing custom stories.
    sections.push(sqlSection);
  }

  sections.push(provenanceSection);

  const title = options.title || `Analysis of ${(dataset && dataset.name) || 'dataset'}`;
  const subtitle = formatSubtitle(dataset, summarySection.content);
  const keyFinding = deriveKeyFinding(summarySection.content, findingsSection.content);
  const generatedAt = options.now || new Date().toISOString();

  const storyDoc = {
    version: 1,
    generatedAt,
    title,
    subtitle,
    keyFinding,
    sections,
    provenance: {
      datasetName: provenanceSection.content.datasetName,
      rowCount: provenanceSection.content.rowCount,
      columnCount: provenanceSection.content.columnCount,
      provenanceHash: provenanceSection.content.provenanceHash,
      generatedAt: provenanceSection.content.generatedAt,
    },
    metadata: {
      author: options.author || 'Unknown analyst',
      toolVersion: 'DataGlow Canvas v1',
      includesTimeline: includeTimeline,
    },
  };

  return storyDoc;
}

// ---------- Rendering ----------

function escapeMarkdownCell(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function findSection(storyDoc, type) {
  return (storyDoc && Array.isArray(storyDoc.sections))
    ? storyDoc.sections.find((s) => s && s.type === type)
    : null;
}

/**
 * renderMarkdown(storyDoc)
 * Produces clean Markdown for the story document.
 */
function renderMarkdown(storyDoc) {
  const doc = storyDoc || {};
  const lines = [];

  lines.push(`# ${doc.title || 'Untitled Story'}`);
  lines.push('');
  lines.push(`*${doc.subtitle || ''}*`);
  lines.push('');
  lines.push('## Key Finding');
  lines.push('');
  lines.push(`> ${doc.keyFinding || ''}`);
  lines.push('');

  const summary = findSection(doc, 'summary');
  lines.push('## Summary');
  lines.push('');
  if (summary && summary.content) {
    const c = summary.content;
    lines.push(`- Overall health: **${Math.round(c.overallHealth)}%**`);
    lines.push(`- Total findings: **${c.totalFindings}** (${c.errorCount} errors, ${c.warningCount} warnings)`);
    if (c.topIssues && c.topIssues.length) {
      lines.push('');
      lines.push('Top issues:');
      for (const issue of c.topIssues) {
        lines.push(`- **${issue.severity}** — ${issue.column}: ${issue.message}`);
      }
    }
  }
  lines.push('');

  const findings = findSection(doc, 'findings');
  lines.push('## Findings');
  lines.push('');
  const items = (findings && findings.content && findings.content.items) || [];
  if (items.length === 0) {
    lines.push('_No findings recorded._');
  } else {
    lines.push('| Severity | Column | Issue | Rows Affected |');
    lines.push('|---|---|---|---|');
    for (const item of items) {
      lines.push(`| ${escapeMarkdownCell(item.severity)} | ${escapeMarkdownCell(item.column)} | ${escapeMarkdownCell(item.message)} | ${item.rowsAffected != null ? item.rowsAffected : '—'} |`);
    }
  }
  lines.push('');

  const timeline = findSection(doc, 'timeline');
  if (timeline) {
    lines.push('## Timeline');
    lines.push('');
    const entries = (timeline.content && timeline.content.entries) || [];
    if (entries.length === 0) {
      lines.push('_No timeline entries recorded._');
    } else {
      for (const entry of entries) {
        lines.push(`1. ${entry}`);
      }
    }
    lines.push('');
  }

  const sqlAudit = findSection(doc, 'sql_audit');
  const sqlQueries = (sqlAudit && sqlAudit.content && sqlAudit.content.queries) || [];
  if (sqlAudit && sqlQueries.length > 0) {
    lines.push('## SQL Audit');
    lines.push('');
    for (const q of sqlQueries) {
      lines.push(`\`\`\`sql`);
      lines.push(q.sql || '');
      lines.push('```');
      const meta = [q.timestamp, q.note].filter(Boolean).join(' — ');
      if (meta) lines.push(`*${meta}*`);
      lines.push('');
    }
  }

  const provenance = findSection(doc, 'provenance');
  lines.push('## Provenance');
  lines.push('');
  if (provenance && provenance.content) {
    const c = provenance.content;
    lines.push(`- Dataset: **${c.datasetName}**`);
    lines.push(`- Rows: ${c.rowCount} · Columns: ${c.columnCount}`);
    lines.push(`- Provenance hash: \`${c.provenanceHash}\``);
    lines.push(`- Generated at: ${c.generatedAt}`);
    lines.push(`- Memory records: ${c.recordCount}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*Generated by DataGlow Canvas. Provenance hash: ${doc.provenance ? doc.provenance.provenanceHash : ''}*`);

  return lines.join('\n');
}

// ---------- HTML rendering ----------

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COLOR_BACKGROUND = '#F7F6F2';
const COLOR_PRIMARY = '#01696F';
const COLOR_WARNING = '#964219';
const COLOR_ERROR = '#A12C7B';

function severityColor(severity) {
  if (severity === 'error' || severity === 'critical') return COLOR_ERROR;
  if (severity === 'warning') return COLOR_WARNING;
  return COLOR_PRIMARY;
}

/**
 * renderHTML(storyDoc)
 * Clean, print-friendly HTML using inline styles + a <style> block with
 * @media print rules. Works in any browser print context (PDF via
 * window.print()), no build step, no external stylesheet.
 */
function renderHTML(storyDoc) {
  const doc = storyDoc || {};
  const summary = findSection(doc, 'summary');
  const findings = findSection(doc, 'findings');
  const timeline = findSection(doc, 'timeline');
  const sqlAudit = findSection(doc, 'sql_audit');
  const provenance = findSection(doc, 'provenance');

  const summaryContent = (summary && summary.content) || {};
  const findingsItems = (findings && findings.content && findings.content.items) || [];
  const timelineEntries = (timeline && timeline.content && timeline.content.entries) || [];
  const sqlQueries = (sqlAudit && sqlAudit.content && sqlAudit.content.queries) || [];
  const provenanceContent = (provenance && provenance.content) || {};

  const topIssuesHtml = (summaryContent.topIssues || [])
    .map((issue) => `<li><span style="color:${severityColor(issue.severity)}; font-weight:600;">${escapeHtml(issue.severity)}</span> — ${escapeHtml(issue.column)}: ${escapeHtml(issue.message)}</li>`)
    .join('\n');

  const findingsRowsHtml = findingsItems.length === 0
    ? `<tr><td colspan="4" style="padding:8px 12px; color:#666;">No findings recorded.</td></tr>`
    : findingsItems.map((item, idx) => {
      const stripe = idx % 2 === 0 ? COLOR_BACKGROUND : '#FFFFFF';
      return `<tr style="background:${stripe};">
        <td style="padding:8px 12px; color:${severityColor(item.severity)}; font-weight:600;">${escapeHtml(item.severity)}</td>
        <td style="padding:8px 12px;">${escapeHtml(item.column)}</td>
        <td style="padding:8px 12px;">${escapeHtml(item.message)}</td>
        <td style="padding:8px 12px; text-align:right;">${item.rowsAffected != null ? escapeHtml(item.rowsAffected) : '—'}</td>
      </tr>`;
    }).join('\n');

  const timelineHtml = timelineEntries.length === 0
    ? '<p style="color:#666;">No timeline entries recorded.</p>'
    : `<ol style="margin:0; padding-left:20px;">${timelineEntries.map((entry) => `<li style="margin-bottom:6px;">${escapeHtml(entry)}</li>`).join('\n')}</ol>`;

  const sqlHtml = sqlQueries.length === 0
    ? ''
    : `<h2 style="color:${COLOR_PRIMARY}; border-bottom:1px solid #ddd; padding-bottom:4px;">SQL Audit</h2>
       ${sqlQueries.map((q) => `
         <pre style="background:#1e1e1e; color:#f5f5f5; padding:12px; border-radius:4px; overflow-x:auto; font-size:12px;"><code>${escapeHtml(q.sql)}</code></pre>
         <p style="color:#888; font-size:12px; margin-top:-4px;">${escapeHtml([q.timestamp, q.note].filter(Boolean).join(' — '))}</p>
       `).join('\n')}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(doc.title || 'DataGlow Story')}</title>
<style>
  @media print {
    body { background: #FFFFFF !important; }
    .no-print { display: none !important; }
    a { color: inherit; text-decoration: none; }
    table, pre { page-break-inside: avoid; }
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: ${COLOR_BACKGROUND};
    color: #1a1a1a;
    margin: 0;
    padding: 32px;
    line-height: 1.5;
  }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; padding: 8px 12px; background: ${COLOR_PRIMARY}; color: #FFFFFF; }
</style>
</head>
<body>
  <h1 style="color:${COLOR_PRIMARY}; margin-bottom:4px;">${escapeHtml(doc.title || 'Untitled Story')}</h1>
  <p style="color:#555; margin-top:0;"><em>${escapeHtml(doc.subtitle || '')}</em></p>

  <h2 style="color:${COLOR_PRIMARY}; border-bottom:1px solid #ddd; padding-bottom:4px;">Key Finding</h2>
  <blockquote style="border-left:4px solid ${COLOR_PRIMARY}; margin:0; padding:8px 16px; background:#FFFFFF;">
    ${escapeHtml(doc.keyFinding || '')}
  </blockquote>

  <h2 style="color:${COLOR_PRIMARY}; border-bottom:1px solid #ddd; padding-bottom:4px;">Summary</h2>
  <p>Overall health: <strong>${Math.round(summaryContent.overallHealth || 0)}%</strong> &middot;
     Total findings: <strong>${summaryContent.totalFindings || 0}</strong>
     (${summaryContent.errorCount || 0} errors, ${summaryContent.warningCount || 0} warnings)</p>
  ${topIssuesHtml ? `<ul>${topIssuesHtml}</ul>` : ''}

  <h2 style="color:${COLOR_PRIMARY}; border-bottom:1px solid #ddd; padding-bottom:4px;">Findings</h2>
  <table>
    <thead>
      <tr><th>Severity</th><th>Column</th><th>Issue</th><th style="text-align:right;">Rows Affected</th></tr>
    </thead>
    <tbody>
      ${findingsRowsHtml}
    </tbody>
  </table>

  ${timeline ? `<h2 style="color:${COLOR_PRIMARY}; border-bottom:1px solid #ddd; padding-bottom:4px;">Timeline</h2>${timelineHtml}` : ''}

  ${sqlHtml}

  <h2 style="color:${COLOR_PRIMARY}; border-bottom:1px solid #ddd; padding-bottom:4px;">Provenance</h2>
  <table>
    <tbody>
      <tr><td style="padding:4px 12px; font-weight:600;">Dataset</td><td style="padding:4px 12px;">${escapeHtml(provenanceContent.datasetName)}</td></tr>
      <tr><td style="padding:4px 12px; font-weight:600;">Rows</td><td style="padding:4px 12px;">${escapeHtml(provenanceContent.rowCount)}</td></tr>
      <tr><td style="padding:4px 12px; font-weight:600;">Columns</td><td style="padding:4px 12px;">${escapeHtml(provenanceContent.columnCount)}</td></tr>
      <tr><td style="padding:4px 12px; font-weight:600;">Provenance hash</td><td style="padding:4px 12px; font-family:monospace;">${escapeHtml(provenanceContent.provenanceHash)}</td></tr>
      <tr><td style="padding:4px 12px; font-weight:600;">Generated at</td><td style="padding:4px 12px;">${escapeHtml(provenanceContent.generatedAt)}</td></tr>
    </tbody>
  </table>

  <hr style="margin:32px 0; border:none; border-top:1px solid #ccc;" />
  <p style="color:#888; font-size:12px;"><em>Generated by DataGlow Canvas. Provenance hash: ${escapeHtml(doc.provenance ? doc.provenance.provenanceHash : '')}</em></p>
</body>
</html>`;
}

// ---------- Hashing & validation ----------

/**
 * computeStoryHash(storyDoc)
 * djb2 hash over JSON.stringify of the story's sections content. Different
 * from the provenance hash (which hashes the memory records) — together
 * they form the dual-hash in the Proof Package.
 */
function computeStoryHash(storyDoc) {
  const sections = (storyDoc && Array.isArray(storyDoc.sections)) ? storyDoc.sections : [];
  const contentBasis = sections.map((s) => ({ id: s && s.id, type: s && s.type, content: s && s.content }));
  return djb2Hash(JSON.stringify(contentBasis));
}

/**
 * validateStory(storyDoc)
 * Returns { valid: boolean, errors: string[] }.
 */
function validateStory(storyDoc) {
  const errors = [];
  const doc = storyDoc;

  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['storyDoc is missing or not an object'] };
  }

  if (doc.version == null) {
    errors.push('version is missing');
  }

  if (!doc.generatedAt || Number.isNaN(Date.parse(doc.generatedAt))) {
    errors.push('generatedAt is missing or not a valid ISO date string');
  }

  if (!doc.title || typeof doc.title !== 'string' || doc.title.trim() === '') {
    errors.push('title is missing or empty');
  }

  if (!Array.isArray(doc.sections)) {
    errors.push('sections is missing or not an array');
  } else {
    doc.sections.forEach((section, idx) => {
      if (!section || typeof section !== 'object') {
        errors.push(`section at index ${idx} is missing or not an object`);
        return;
      }
      if (!section.id) errors.push(`section at index ${idx} is missing an id`);
      if (!section.type) errors.push(`section at index ${idx} is missing a type`);
      if (!section.title) errors.push(`section at index ${idx} is missing a title`);
      if (section.content == null) errors.push(`section at index ${idx} is missing content`);
    });
  }

  if (!doc.provenance || typeof doc.provenance !== 'object' || !doc.provenance.provenanceHash) {
    errors.push('provenance.provenanceHash is missing');
  }

  return { valid: errors.length === 0, errors };
}

// ---------- Exports ----------

// ESM export — package.json declares "type": "module", and every sibling
// pure-logic module in js/ (e.g. js/webhook/webhook-handler.js) exports the
// same way. Consumed directly by <script type="module"> in the browser and
// by `node test/story/story-builder.test.js` via a plain `import` in Node.
export {
  buildStory,
  buildSummarySection,
  buildFindingsSection,
  buildTimelineSection,
  buildSQLAuditSection,
  buildProvenanceSection,
  renderMarkdown,
  renderHTML,
  computeStoryHash,
  validateStory,
  // exported for reuse/testing of the fallback primitives
  djb2Hash,
};
