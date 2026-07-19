// ============================================================
// DATAGLOW — Portfolio Narrative Assembler test suite
// ============================================================
// Proves js/portfolio/narrative-assembler.js:
//   - buildCleaningSummary correctly separates resolved vs. open issues;
//   - buildNarrativeDocument always includes all four required sections,
//     even with missing/partial inputs (fail-open, never throws);
//   - overconfidence caveats only render when flagged findings exist;
//   - renderNarrativeMarkdown produces a non-empty, well-formed document
//     and never throws on malformed section content;
//   - validateNarrativeDocument correctly flags missing required sections;
//   - the whole pipeline is pure JS with no DOM/DuckDB/network dependency.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/portfolio-narrative-assembler.test.mjs

import {
  buildCleaningSummary,
  buildNarrativeDocument,
  renderNarrativeMarkdown,
  validateNarrativeDocument,
} from '../js/portfolio/narrative-assembler.js';

// ---------- tiny test harness (no framework, matches repo convention) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- fixtures ----------
const sampleIssues = [
  { id: 'null_age', type: 'nulls', column: 'age', count: 12, label: '12 null value(s) in "age"' },
  { id: 'duplicates', type: 'duplicates', count: 3, label: '3 duplicate row(s)' },
  { id: 'whitespace_name', type: 'whitespace', column: 'name', count: 5, label: '5 value(s) with whitespace in "name"' },
];

const sampleAuditLog = [
  { issueId: 'null_age', fixType: 'fill_mean', timestamp: '2026-07-19T10:00:00Z' },
];

const sampleStoryDoc = {
  version: 1,
  generatedAt: '2026-07-19T10:05:00Z',
  title: 'Analysis of patients.csv',
  subtitle: '1000 rows, 8 columns',
  keyFinding: 'Average length of stay is 4.2 days.',
  sections: [
    { type: 'summary', heading: 'Summary', content: 'The dataset has 1000 rows.' },
    { type: 'findings', heading: 'Findings', content: '3 findings detected.' },
  ],
  provenance: { provenanceHash: 'abc123hash' },
  metadata: { author: 'Andre', toolVersion: 'DataGlow Canvas v1' },
};

// ============================================================
// buildCleaningSummary
// ============================================================

{
  const summary = buildCleaningSummary(sampleIssues, sampleAuditLog);
  ok(summary.totalIssuesFound === 3, 'buildCleaningSummary counts total issues found');
  ok(summary.totalFixesApplied === 1, 'buildCleaningSummary counts total fixes applied');
  ok(summary.openIssues.length === 2, 'buildCleaningSummary correctly separates open issues (2 remain unresolved)');
  ok(summary.resolvedIssueIds.includes('null_age'), 'buildCleaningSummary marks fixed issue as resolved');
  ok(!summary.openIssues.some((i) => i.id === 'null_age'), 'resolved issue is excluded from openIssues');
  ok(summary.issuesByType.nulls === 1 && summary.issuesByType.duplicates === 1, 'buildCleaningSummary tallies issuesByType correctly');
}

// ---------- degrades gracefully on missing/malformed input ----------
{
  const s1 = buildCleaningSummary(null, null);
  ok(s1.totalIssuesFound === 0 && s1.totalFixesApplied === 0, 'buildCleaningSummary handles null inputs without throwing');

  const s2 = buildCleaningSummary(undefined, undefined);
  ok(s2.openIssues.length === 0, 'buildCleaningSummary handles undefined inputs without throwing');

  const s3 = buildCleaningSummary('not an array', 'also not an array');
  ok(s3.totalIssuesFound === 0, 'buildCleaningSummary handles non-array inputs without throwing');
}

// ============================================================
// buildNarrativeDocument — always includes all four sections
// ============================================================

{
  const doc = buildNarrativeDocument({
    problemFramerMarkdown: '# Problem Framer Recap\n\nSome recap text.',
    storyDoc: sampleStoryDoc,
    issues: sampleIssues,
    auditLog: sampleAuditLog,
    recommendation: 'Recommend reviewing outlier LOS values before publishing.',
  });

  ok(doc.version === 1, 'buildNarrativeDocument sets version 1');
  ok(typeof doc.generatedAt === 'string', 'buildNarrativeDocument sets a generatedAt timestamp');
  ok(doc.title === 'Analysis of patients.csv', 'buildNarrativeDocument defaults title to storyDoc.title when not overridden');

  const types = doc.sections.map((s) => s.type);
  ok(types.includes('problem_framing'), 'document includes problem_framing section');
  ok(types.includes('story'), 'document includes story section');
  ok(types.includes('cleaning_summary'), 'document includes cleaning_summary section');
  ok(types.includes('recommendation'), 'document includes recommendation section');
  ok(!types.includes('overconfidence_caveat'), 'no overconfidence_caveat section when none provided');

  ok(doc.metadata.sourceStoryHash === 'abc123hash', 'metadata.sourceStoryHash is carried over from storyDoc.provenance');
  ok(doc.metadata.hasOverconfidenceCaveats === false, 'hasOverconfidenceCaveats is false with no findings');
}

// ---------- fail-open on missing inputs — never throws, still produces all 4 sections ----------
{
  const doc = buildNarrativeDocument({});
  const types = doc.sections.map((s) => s.type);
  ok(types.length === 4, 'buildNarrativeDocument with zero inputs still produces exactly 4 required sections');
  ok(doc.title === 'DataGlow Portfolio Narrative', 'buildNarrativeDocument falls back to a default title when no storyDoc given');

  const problemSection = doc.sections.find((s) => s.type === 'problem_framing');
  ok(problemSection.content.includes('No problem-framing recap'), 'missing problemFramerMarkdown renders an explicit placeholder, not a crash');

  const recSection = doc.sections.find((s) => s.type === 'recommendation');
  ok(recSection.content.includes('No recommendation'), 'missing recommendation renders an explicit placeholder');

  const storySection = doc.sections.find((s) => s.type === 'story');
  ok(storySection.content === null, 'missing storyDoc leaves story section content null rather than throwing');
}

{
  // Completely malformed / wrong-type inputs should not throw.
  let threw = false;
  let doc = null;
  try {
    doc = buildNarrativeDocument({
      problemFramerMarkdown: 12345,
      storyDoc: 'not an object',
      issues: 'nope',
      auditLog: { not: 'an array' },
      recommendation: null,
      overconfidenceFindings: 'nope',
    });
  } catch {
    threw = true;
  }
  ok(!threw, 'buildNarrativeDocument never throws on malformed input types');
  ok(doc && doc.sections.length === 4, 'malformed input still produces a valid 4-section document');
}

// ============================================================
// overconfidence caveats — only render when findings exist
// ============================================================

{
  const docNoCaveats = buildNarrativeDocument({
    storyDoc: sampleStoryDoc,
    overconfidenceFindings: [{ status: 'pass', message: 'all good' }, { status: 'idle', message: 'n/a' }],
  });
  ok(
    !docNoCaveats.sections.some((s) => s.type === 'overconfidence_caveat'),
    'pass/idle-only findings do not produce a caveat section'
  );

  const docWithCaveats = buildNarrativeDocument({
    storyDoc: sampleStoryDoc,
    overconfidenceFindings: [
      { status: 'pass', message: 'fine' },
      { status: 'flag', message: 'LOS mean stated with high confidence but n=6, missingRate=0.5' },
    ],
  });
  const caveatSection = docWithCaveats.sections.find((s) => s.type === 'overconfidence_caveat');
  ok(!!caveatSection, 'flagged finding produces a caveat section');
  ok(caveatSection.content.length === 1, 'caveat section only includes the flagged (non-pass/idle) findings');
  ok(docWithCaveats.metadata.hasOverconfidenceCaveats === true, 'metadata.hasOverconfidenceCaveats is true when findings are flagged');
}

// ============================================================
// renderNarrativeMarkdown
// ============================================================

{
  const doc = buildNarrativeDocument({
    problemFramerMarkdown: '# Problem Framer Recap\n\n## Original question\n\n> Why is LOS so variable?',
    storyDoc: sampleStoryDoc,
    issues: sampleIssues,
    auditLog: sampleAuditLog,
    recommendation: 'Investigate outlier LOS values in the ICU cohort before publishing this finding externally.',
    overconfidenceFindings: [{ status: 'flag', message: 'LOS mean has a small sample (n=6).' }],
  });

  const md = renderNarrativeMarkdown(doc);

  ok(typeof md === 'string' && md.length > 0, 'renderNarrativeMarkdown returns a non-empty string');
  ok(md.startsWith('# Analysis of patients.csv'), 'rendered markdown starts with the document title as an H1');
  ok(md.includes('## Problem Framing'), 'rendered markdown includes Problem Framing section header');
  ok(md.includes('## Analysis & Findings'), 'rendered markdown includes Analysis & Findings section header');
  ok(md.includes('## Data Quality & Cleaning'), 'rendered markdown includes Data Quality & Cleaning section header');
  ok(md.includes('## Recommendation'), 'rendered markdown includes Recommendation section header');
  ok(md.includes('## Confidence Caveats'), 'rendered markdown includes Confidence Caveats section when findings are flagged');
  ok(md.includes('Investigate outlier LOS values'), 'rendered markdown includes the actual recommendation text');
  ok(md.includes('| Issue type | Count |'), 'rendered markdown includes the cleaning-summary issue-type table');
  ok(md.includes('abc123hash'), 'rendered markdown includes the provenance hash footer');
}

// ---------- renderNarrativeMarkdown never throws on malformed doc ----------
{
  ok(renderNarrativeMarkdown(null).includes('could not be rendered'), 'renderNarrativeMarkdown handles null doc gracefully');
  ok(renderNarrativeMarkdown({}).includes('could not be rendered'), 'renderNarrativeMarkdown handles empty object gracefully');
  ok(renderNarrativeMarkdown({ sections: 'not an array' }).includes('could not be rendered'), 'renderNarrativeMarkdown handles malformed sections gracefully');

  let threw = false;
  try {
    renderNarrativeMarkdown({
      title: 'Test',
      generatedAt: 'now',
      sections: [{ type: 'story', heading: 'Story', content: [{ heading: 'Weird', content: { circular: true } }] }],
    });
  } catch {
    threw = true;
  }
  ok(!threw, 'renderNarrativeMarkdown never throws even with unusual nested section content');
}

// ============================================================
// validateNarrativeDocument
// ============================================================

{
  const validDoc = buildNarrativeDocument({
    problemFramerMarkdown: 'recap',
    storyDoc: sampleStoryDoc,
    issues: sampleIssues,
    auditLog: sampleAuditLog,
    recommendation: 'do this',
  });
  const result = validateNarrativeDocument(validDoc);
  ok(result.valid === true, 'validateNarrativeDocument passes a fully-assembled document');
  ok(result.errors.length === 0, 'valid document has zero validation errors');
}

{
  const result = validateNarrativeDocument(null);
  ok(result.valid === false, 'validateNarrativeDocument rejects null');
  ok(result.errors.length > 0, 'null document produces at least one error');
}

{
  const result = validateNarrativeDocument({ title: 'Missing sections', sections: [] });
  ok(result.valid === false, 'validateNarrativeDocument rejects a document with empty sections');
  ok(result.errors.some((e) => e.includes('non-empty array')), 'empty-sections error message is specific');
}

{
  // Even a fail-open (zero-input) buildNarrativeDocument() result should
  // still validate, since it always includes all 4 required section types.
  const doc = buildNarrativeDocument({});
  const result = validateNarrativeDocument(doc);
  ok(result.valid === true, 'a fail-open zero-input document still passes validation (all 4 section types always present)');
}

// ============================================================
// summary
// ============================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
