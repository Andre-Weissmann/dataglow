// ============================================================
// DATAGLOW — Story View builder test suite
// ============================================================
// Pure Node, no DOM, no DuckDB, no network.
// RUN WITH: node test/story/story-builder.test.js

import {
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
} from '../../js/story/story-builder.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- Fixtures ----------

const dataset = {
  id: 'ds-1',
  name: 'claims_Q2_2026.csv',
  rowCount: 14203,
  columnCount: 18,
  columns: [
    { name: 'patient_id', type: 'string', healthScore: 98, findingCount: 0 },
    { name: 'claim_amount', type: 'number', healthScore: 90, findingCount: 2 },
    { name: 'diagnosis_code', type: 'string', healthScore: 94, findingCount: 1 },
  ],
};

const findings = [
  { severity: 'warning', column: 'claim_amount', message: 'Outlier values detected', rowsAffected: 12, suggestedFix: 'Cap at 99th percentile' },
  { severity: 'error', column: 'diagnosis_code', message: 'Invalid ICD-10 codes found', rowsAffected: 5, suggestedFix: 'Map to nearest valid code' },
  { severity: 'info', column: 'patient_id', message: 'All values unique', rowsAffected: 0, suggestedFix: null },
  { severity: 'error', column: 'claim_amount', message: 'Negative claim amounts', rowsAffected: 3, suggestedFix: 'Review and correct sign' },
];

const memoryRecords = [
  { type: 'SQL_QUERY', datasetId: 'ds-1', sql: 'SELECT * FROM claims LIMIT 10', timestamp: '2026-07-10T10:00:00.000Z', note: 'initial look', author: 'Andre' },
  { type: 'NOTE', datasetId: 'ds-1', note: 'Flagged for review', timestamp: '2026-07-11T09:00:00.000Z', author: 'Andre' },
  { type: 'SQL_QUERY', datasetId: 'ds-1', sql: 'SELECT diagnosis_code, COUNT(*) FROM claims GROUP BY 1', timestamp: '2026-07-12T14:30:00.000Z', note: 'checking distribution', author: 'Priya' },
  { type: 'FINDING_RESOLVED', datasetId: 'ds-1', column: 'claim_amount', timestamp: '2026-07-13T09:00:00.000Z', author: 'Priya' },
  { type: 'SQL_QUERY', datasetId: 'other-ds', sql: 'SELECT 1', timestamp: '2026-07-14T09:00:00.000Z', author: 'Someone else' },
];

const memoryStore = { records: memoryRecords };

function injectedGenerateTimeline(store, datasetId, options) {
  const max = (options && options.maxTimelineEntries) || 10;
  return store.records
    .filter((r) => r.datasetId === datasetId)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(0, max)
    .map((r) => `${r.author} — ${r.type} @ ${r.timestamp}`);
}

function injectedComputeProvenanceHash(store, datasetId) {
  return 'ph-' + store.records.filter((r) => r.datasetId === datasetId).length;
}

function main() {
  // ---------- buildStory: overall shape ----------
  {
    const doc = buildStory(dataset, findings, memoryStore, {
      title: 'Analysis of claims_Q2_2026.csv',
      author: 'Andre Weissmann',
      generateTimeline: injectedGenerateTimeline,
      computeProvenanceHash: injectedComputeProvenanceHash,
      datasetId: 'ds-1',
    });

    ok(doc.version === 1, 'buildStory: version is 1');
    ok(typeof doc.generatedAt === 'string' && !Number.isNaN(Date.parse(doc.generatedAt)), 'buildStory: generatedAt is a valid ISO string');
    ok(doc.title === 'Analysis of claims_Q2_2026.csv', 'buildStory: title matches supplied option');
    ok(typeof doc.subtitle === 'string' && doc.subtitle.includes('18 columns'), 'buildStory: subtitle mentions column count');
    ok(doc.subtitle.includes('14,203 rows'), 'buildStory: subtitle formats row count with thousands separator');
    ok(typeof doc.keyFinding === 'string' && doc.keyFinding.length > 0, 'buildStory: keyFinding is a non-empty string');
    ok(Array.isArray(doc.sections) && doc.sections.length >= 4, 'buildStory: sections is an array with at least 4 entries');
    ok(doc.sections.some((s) => s.type === 'summary'), 'buildStory: includes a summary section');
    ok(doc.sections.some((s) => s.type === 'findings'), 'buildStory: includes a findings section');
    ok(doc.sections.some((s) => s.type === 'timeline'), 'buildStory: includes a timeline section by default');
    ok(doc.sections.some((s) => s.type === 'sql_audit'), 'buildStory: includes a sql_audit section by default');
    ok(doc.sections.some((s) => s.type === 'provenance'), 'buildStory: includes a provenance section');
    ok(doc.provenance && doc.provenance.provenanceHash === 'ph-4', 'buildStory: provenance hash comes from injected computeProvenanceHash and scopes to dataset');
    ok(doc.provenance.datasetName === 'claims_Q2_2026.csv', 'buildStory: provenance.datasetName matches dataset');
    ok(doc.metadata.author === 'Andre Weissmann', 'buildStory: metadata.author matches supplied option');
    ok(doc.metadata.toolVersion === 'DataGlow Canvas v1', 'buildStory: metadata.toolVersion is set');
    ok(doc.metadata.includesTimeline === true, 'buildStory: metadata.includesTimeline is true by default');

    const docNoTimeline = buildStory(dataset, findings, memoryStore, { includeTimeline: false, includeSQL: false, datasetId: 'ds-1' });
    ok(!docNoTimeline.sections.some((s) => s.type === 'timeline'), 'buildStory: options.includeTimeline=false omits timeline section');
    ok(!docNoTimeline.sections.some((s) => s.type === 'sql_audit'), 'buildStory: options.includeSQL=false omits sql_audit section');
    ok(docNoTimeline.metadata.includesTimeline === false, 'buildStory: metadata.includesTimeline reflects options.includeTimeline=false');
  }

  // ---------- buildSummarySection ----------
  {
    const section = buildSummarySection(dataset, findings);
    ok(section.type === 'summary', 'buildSummarySection: type is summary');
    ok(section.id === 'summary', 'buildSummarySection: id is summary');
    const expectedHealth = Math.round((98 + 90 + 94) / 3);
    ok(Math.round(section.content.overallHealth) === expectedHealth, 'buildSummarySection: overallHealth averages column health scores correctly');
    ok(section.content.totalFindings === 4, 'buildSummarySection: totalFindings counts all findings');
    ok(section.content.errorCount === 2, 'buildSummarySection: errorCount counts only error severity');
    ok(section.content.warningCount === 1, 'buildSummarySection: warningCount counts only warning severity');
    ok(Array.isArray(section.content.topIssues) && section.content.topIssues.length <= 3, 'buildSummarySection: topIssues is capped at 3');

    const manyFindings = Array.from({ length: 10 }, (_, i) => ({ severity: 'warning', column: `col${i}`, message: `issue ${i}` }));
    const bigSection = buildSummarySection(dataset, manyFindings);
    ok(bigSection.content.topIssues.length === 3, 'buildSummarySection: topIssues limits to exactly 3 with 10 findings supplied');

    const noColumnsDataset = { name: 'x', rowCount: 10, columnCount: 1, columns: [] };
    const derivedHealthSection = buildSummarySection(noColumnsDataset, findings);
    ok(derivedHealthSection.content.overallHealth < 100, 'buildSummarySection: derives a deduction-based health score when no column scores are present');
  }

  // ---------- buildFindingsSection ----------
  {
    const section = buildFindingsSection(findings);
    ok(section.type === 'findings', 'buildFindingsSection: type is findings');
    ok(section.content.items.length === 4, 'buildFindingsSection: includes all findings as items');
    ok(section.content.items[0].severity === 'error', 'buildFindingsSection: first item is an error (sorted first)');
    const lastErrorIdx = section.content.items.map((i) => i.severity).lastIndexOf('error');
    const firstWarningIdx = section.content.items.map((i) => i.severity).indexOf('warning');
    ok(lastErrorIdx < firstWarningIdx, 'buildFindingsSection: all errors sort before warnings');
    const firstInfoIdx = section.content.items.map((i) => i.severity).indexOf('info');
    ok(firstWarningIdx < firstInfoIdx, 'buildFindingsSection: warnings sort before info');
    ok(section.content.items[0].suggestedFix === 'Map to nearest valid code' || section.content.items[0].suggestedFix === 'Review and correct sign', 'buildFindingsSection: preserves suggestedFix field');

    const emptySection = buildFindingsSection([]);
    ok(Array.isArray(emptySection.content.items) && emptySection.content.items.length === 0, 'buildFindingsSection: handles empty findings array gracefully');

    const undefinedSection = buildFindingsSection(undefined);
    ok(Array.isArray(undefinedSection.content.items) && undefinedSection.content.items.length === 0, 'buildFindingsSection: handles undefined findings gracefully');
  }

  // ---------- buildTimelineSection ----------
  {
    const section = buildTimelineSection(memoryStore, 'ds-1', { generateTimeline: injectedGenerateTimeline });
    ok(section.type === 'timeline', 'buildTimelineSection: type is timeline');
    ok(Array.isArray(section.content.entries), 'buildTimelineSection: content.entries is an array');
    ok(section.content.entries.length === 4, 'buildTimelineSection: returns entries scoped to the dataset (4 for ds-1)');
    ok(section.content.entries.every((e) => typeof e === 'string'), 'buildTimelineSection: every entry is a plain string');

    const limited = buildTimelineSection(memoryStore, 'ds-1', { generateTimeline: injectedGenerateTimeline, maxTimelineEntries: 2 });
    ok(limited.content.entries.length === 2, 'buildTimelineSection: respects maxTimelineEntries option');

    const fallbackSection = buildTimelineSection(memoryStore, 'ds-1', {});
    ok(Array.isArray(fallbackSection.content.entries), 'buildTimelineSection: falls back to inline implementation when generateTimeline is not injected');
  }

  // ---------- buildSQLAuditSection ----------
  {
    const section = buildSQLAuditSection(memoryStore, 'ds-1');
    ok(section.type === 'sql_audit', 'buildSQLAuditSection: type is sql_audit');
    ok(section.content.queries.length === 2, 'buildSQLAuditSection: filters to only SQL_QUERY records for the dataset');
    ok(section.content.queries.every((q) => typeof q.sql === 'string' && q.sql.length > 0), 'buildSQLAuditSection: every query entry has a non-empty sql string');
    ok(section.content.queries[0].timestamp === '2026-07-10T10:00:00.000Z', 'buildSQLAuditSection: sorts queries chronologically (earliest first)');
    ok(!section.content.queries.some((q) => q.sql === 'SELECT 1'), 'buildSQLAuditSection: excludes SQL_QUERY records from a different dataset');
  }

  // ---------- buildProvenanceSection ----------
  {
    const section = buildProvenanceSection(dataset, memoryStore, 'ds-1', { computeProvenanceHash: injectedComputeProvenanceHash });
    ok(section.type === 'provenance', 'buildProvenanceSection: type is provenance');
    ok(section.content.provenanceHash === 'ph-4', 'buildProvenanceSection: includes hash from injected function');
    ok(section.content.datasetName === 'claims_Q2_2026.csv', 'buildProvenanceSection: includes dataset name');
    ok(section.content.recordCount === 4, 'buildProvenanceSection: recordCount reflects only this dataset\'s records');

    const fallbackSection = buildProvenanceSection(dataset, memoryStore, 'ds-1', {});
    ok(typeof fallbackSection.content.provenanceHash === 'string' && fallbackSection.content.provenanceHash.length > 0, 'buildProvenanceSection: falls back to inline hash when computeProvenanceHash is not injected');
  }

  // ---------- renderMarkdown ----------
  {
    const doc = buildStory(dataset, findings, memoryStore, {
      generateTimeline: injectedGenerateTimeline,
      computeProvenanceHash: injectedComputeProvenanceHash,
      datasetId: 'ds-1',
    });
    const md = renderMarkdown(doc);
    ok(typeof md === 'string' && md.length > 0, 'renderMarkdown: returns a non-empty string');
    ok(md.includes(doc.title), 'renderMarkdown: contains the title');
    ok(md.includes(doc.keyFinding), 'renderMarkdown: contains the key finding text');
    ok(md.includes(doc.provenance.provenanceHash), 'renderMarkdown: contains the provenance hash');
    ok(md.includes('| Severity | Column | Issue | Rows Affected |'), 'renderMarkdown: findings table has the correct headers');
    ok(md.includes('## Timeline'), 'renderMarkdown: includes a Timeline heading when timeline section is present');
    ok(md.includes('## SQL Audit'), 'renderMarkdown: includes an SQL Audit heading when SQL queries exist');
  }

  // ---------- renderHTML ----------
  {
    const doc = buildStory(dataset, findings, memoryStore, {
      generateTimeline: injectedGenerateTimeline,
      computeProvenanceHash: injectedComputeProvenanceHash,
      datasetId: 'ds-1',
    });
    const html = renderHTML(doc);
    ok(typeof html === 'string' && (html.includes('<!DOCTYPE') || html.includes('<html')), 'renderHTML: output looks like valid HTML (has DOCTYPE or <html>)');
    ok(html.includes('</html>'), 'renderHTML: output is closed with </html>');
    ok(html.includes('@media print'), 'renderHTML: includes print media styles');
    ok(html.includes('#01696F'), 'renderHTML: uses the DataGlow primary color token');
    ok(html.includes(doc.title), 'renderHTML: contains the story title');
  }

  // ---------- computeStoryHash ----------
  {
    const doc1 = buildStory(dataset, findings, memoryStore, { generateTimeline: injectedGenerateTimeline, computeProvenanceHash: injectedComputeProvenanceHash, datasetId: 'ds-1', now: '2026-07-19T10:00:00.000Z' });
    const doc1Again = buildStory(dataset, findings, memoryStore, { generateTimeline: injectedGenerateTimeline, computeProvenanceHash: injectedComputeProvenanceHash, datasetId: 'ds-1', now: '2026-07-19T10:00:00.000Z' });
    ok(computeStoryHash(doc1) === computeStoryHash(doc1Again), 'computeStoryHash: deterministic for identical documents');

    const doc2 = buildStory(dataset, findings.slice(0, 1), memoryStore, { generateTimeline: injectedGenerateTimeline, computeProvenanceHash: injectedComputeProvenanceHash, datasetId: 'ds-1', now: '2026-07-19T10:00:00.000Z' });
    ok(computeStoryHash(doc1) !== computeStoryHash(doc2), 'computeStoryHash: differs for documents with different findings content');
    ok(computeStoryHash(doc1) !== doc1.provenance.provenanceHash, 'computeStoryHash: is distinct from provenanceHash (dual-hash system)');
  }

  // ---------- validateStory ----------
  {
    const doc = buildStory(dataset, findings, memoryStore, { generateTimeline: injectedGenerateTimeline, computeProvenanceHash: injectedComputeProvenanceHash, datasetId: 'ds-1' });
    const result = validateStory(doc);
    ok(result.valid === true, 'validateStory: passes a complete, valid document');
    ok(Array.isArray(result.errors) && result.errors.length === 0, 'validateStory: valid document has zero errors');

    const missingVersion = { ...doc, version: undefined };
    const r2 = validateStory(missingVersion);
    ok(r2.valid === false && r2.errors.some((e) => e.includes('version')), 'validateStory: catches a missing version field');

    const emptyTitle = { ...doc, title: '' };
    const r3 = validateStory(emptyTitle);
    ok(r3.valid === false && r3.errors.some((e) => e.toLowerCase().includes('title')), 'validateStory: catches an empty title field');

    const badSection = { ...doc, sections: [{ type: 'summary', title: 'Summary', content: {} }] };
    const r4 = validateStory(badSection);
    ok(r4.valid === false && r4.errors.some((e) => e.toLowerCase().includes('id')), 'validateStory: catches a section missing its id field');

    const noProvenanceHash = { ...doc, provenance: { datasetName: 'x' } };
    const r5 = validateStory(noProvenanceHash);
    ok(r5.valid === false && r5.errors.some((e) => e.toLowerCase().includes('provenance')), 'validateStory: catches missing provenance.provenanceHash');

    const r6 = validateStory(null);
    ok(r6.valid === false, 'validateStory: catches a null document rather than throwing');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
