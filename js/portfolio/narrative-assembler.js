// ============================================================
// DATAGLOW — Portfolio Narrative Assembler
// ============================================================
// Stitches four things that already exist as separate DataGlow modules into
// ONE exportable write-up an analyst can put on a portfolio site, LinkedIn
// post, or resume attachment:
//
//   1. Problem Framer's reframing recap  (js/problem-framing/problem-framer.js)
//   2. Story View's findings narrative    (js/story/story-builder.js)
//   3. A cleaning/data-quality summary    (built from Clean tab issue/fix data)
//   4. A closing recommendation           (plain text the analyst supplies)
//
// This module does NOT call DuckDB, does NOT touch the DOM, and does NOT
// regenerate any of the four inputs — it is a pure assembly/formatting layer
// over data the other tabs already produced, exactly the "pure core, thin
// browser renderer" pattern every other DataGlow module (story-builder.js,
// pivot-builder.js, problem-framer.js) follows. That's what makes it
// Node-testable with zero mocks (see test/portfolio-narrative-assembler.test.mjs).
//
// If the Narrative Overconfidence Guard (js/rigor/narrative-overconfidence-guard.js)
// has already audited the Story section's text, its findings can be passed in
// via options.overconfidenceFindings and are rendered as an explicit caveat
// block — this assembler never re-runs that check itself, it only surfaces
// results the caller already computed, keeping the "one check, one owner"
// rule the rest of the rigor/ layer follows.

// ------------------------------------------------------------
// buildCleaningSummary
// ------------------------------------------------------------

/**
 * Turns Clean tab issue/fix data into a compact summary object suitable for
 * a portfolio write-up: what was found, what was fixed, what's still open.
 * Never throws on missing/malformed input — degrades to an empty summary.
 * @param {Array<{id:string,type:string,column?:string,count:number,label:string}>} issues - from scanForIssues()
 * @param {Array<{issueId:string,fixType:string,timestamp?:string}>} auditLog - applied fixes, most-recent-last
 * @returns {{totalIssuesFound:number, totalFixesApplied:number, resolvedIssueIds:string[], openIssues:Array, issuesByType:Object}}
 */
function buildCleaningSummary(issues, auditLog) {
  const issueList = Array.isArray(issues) ? issues : [];
  const log = Array.isArray(auditLog) ? auditLog : [];

  // auditLog entries come from two different shapes depending on caller:
  //   - structured: {issueId, fixType, timestamp?} (the documented/tested shape)
  //   - freeform strings: DataGlow's live Clean tab (js/app-shell/main.js)
  //     pushes human-readable strings like
  //     '[10:32:01 AM] Applied format fix on "amount" (whitespace).' with no
  //     issueId embedded. There is no exact-id signal in that string, so
  //     resolution is inferred best-effort by matching the issue's column
  //     name (quoted in the string) -- honest best-effort, not exact-id
  //     certainty, but it beats reporting zero resolved fixes when fixes
  //     clearly did happen. Structured entries always take priority when
  //     both an issueId and a string are present on the same run.
  const resolvedIssueIds = new Set();
  const resolvedColumns = new Set();
  for (const entry of log) {
    if (entry && typeof entry === 'object' && entry.issueId) {
      resolvedIssueIds.add(entry.issueId);
    } else if (typeof entry === 'string') {
      const match = entry.match(/"([^"]+)"/);
      if (match) resolvedColumns.add(match[1]);
    }
  }

  const openIssues = issueList.filter((issue) => {
    if (!issue) return false;
    if (resolvedIssueIds.has(issue.id)) return false;
    if (issue.column && resolvedColumns.has(issue.column)) return false;
    return true;
  });

  const issuesByType = {};
  for (const issue of issueList) {
    if (!issue || !issue.type) continue;
    issuesByType[issue.type] = (issuesByType[issue.type] || 0) + 1;
  }

  return {
    totalIssuesFound: issueList.length,
    totalFixesApplied: log.length,
    resolvedIssueIds: Array.from(resolvedIssueIds),
    openIssues,
    issuesByType,
  };
}

// ------------------------------------------------------------
// describeGuardFinding (internal helper, not exported)
// ------------------------------------------------------------

/**
 * Fallback English description for a raw narrative-overconfidence-guard.js
 * finding object ({claimKind, column, grade, issue, sentence, pattern}) when
 * the caller hasn't already run it through that module's own
 * describeOverconfidenceFinding(). Kept intentionally simple -- this only
 * fires when a caller passes raw guard output straight through without its
 * matching presenter, which the app-shell UI layer avoids by always calling
 * describeOverconfidenceFinding() itself before handing findings here.
 */
function describeGuardFinding(finding) {
  if (!finding || typeof finding !== 'object') return 'Unspecified confidence caveat.';
  const col = finding.column ? ` ("${finding.column}")` : '';
  if (finding.issue === 'missing_hedge') {
    return `A ${finding.grade || 'low'}-confidence claim${col} has no hedging language anywhere in the narrative.`;
  }
  if (finding.issue === 'overconfident_language') {
    return `A ${finding.grade || 'low'}-confidence claim${col} is stated with overconfident language.`;
  }
  return `Confidence caveat flagged on a claim${col}.`;
}

// ------------------------------------------------------------
// buildNarrativeDocument
// ------------------------------------------------------------

/**
 * Assembles the full portfolio narrative document as a structured object
 * (mirrors story-builder.js's storyDoc shape: {title, subtitle, sections[],
 * metadata, generatedAt}) so it can reuse the same downstream render path
 * pattern (renderMarkdown/renderHTML below) that Story View established.
 *
 * @param {Object} params
 * @param {string} params.problemFramerMarkdown - output of problem-framer.js's buildExportMarkdown()
 * @param {Object} params.storyDoc - output of story-builder.js's buildStory()
 * @param {Array} params.issues - Clean tab issues, from scanForIssues()
 * @param {Array} params.auditLog - Clean tab applied fixes
 * @param {string} params.recommendation - analyst-authored closing recommendation (plain text/markdown)
 * @param {Array<{status:string,message:string}>} [params.overconfidenceFindings] - optional, from checkNarrativeOverconfidence()
 * @param {Object} [params.options]
 * @param {string} [params.options.title] - document title; defaults to storyDoc's title if present
 * @param {string} [params.options.author] - defaults to 'Unknown analyst'
 * @param {string} [params.options.now] - ISO timestamp override, for deterministic tests
 * @returns {{version:number, generatedAt:string, title:string, sections:Array, metadata:Object}}
 */
function buildNarrativeDocument({
  problemFramerMarkdown,
  storyDoc,
  issues,
  auditLog,
  recommendation,
  overconfidenceFindings,
  options = {},
} = {}) {
  const generatedAt = options.now || new Date().toISOString();
  const title = options.title || (storyDoc && storyDoc.title) || 'DataGlow Portfolio Narrative';
  const author = options.author || 'Unknown analyst';

  const sections = [];

  // 1. Problem framing
  sections.push({
    type: 'problem_framing',
    heading: 'Problem Framing',
    content:
      typeof problemFramerMarkdown === 'string' && problemFramerMarkdown.trim().length > 0
        ? problemFramerMarkdown.trim()
        : '_No problem-framing recap was provided for this narrative._',
  });

  // 2. Story / findings narrative — reuse storyDoc's own sections verbatim
  // rather than re-deriving anything, so the numbers in this document are
  // provably the same numbers Story View itself already validated.
  const storySections = storyDoc && Array.isArray(storyDoc.sections) ? storyDoc.sections : [];
  sections.push({
    type: 'story',
    heading: 'Analysis & Findings',
    content: storySections.length > 0 ? storySections : null,
    subtitle: (storyDoc && storyDoc.subtitle) || null,
    keyFinding: (storyDoc && storyDoc.keyFinding) || null,
  });

  // 2b. Overconfidence caveats, if the caller already ran the guard.
  //
  // Accepts findings in either shape so this module works whether the
  // caller hands it raw output from narrative-overconfidence-guard.js's
  // checkNarrativeOverconfidence() (items shaped like {claimKind, column,
  // grade, issue, sentence, pattern} with no per-item status) or a
  // caller-normalized list (items shaped like {status, message}). Any item
  // is treated as a real caveat UNLESS it explicitly carries status 'pass'
  // or 'idle' (the guard's real per-finding objects never set a status at
  // all, so they always count as caveats here -- matching the guard's own
  // contract that everything in its findings[] array already represents a
  // problem worth surfacing).
  const findings = Array.isArray(overconfidenceFindings) ? overconfidenceFindings : [];
  const flaggedFindings = findings
    .filter((f) => f && typeof f === 'object')
    .filter((f) => f.status !== 'pass' && f.status !== 'idle')
    .map((f) => (f.message ? f : { ...f, message: describeGuardFinding(f) }));
  if (flaggedFindings.length > 0) {
    sections.push({
      type: 'overconfidence_caveat',
      heading: 'Confidence Caveats',
      content: flaggedFindings,
    });
  }

  // 3. Cleaning / data-quality summary
  const cleaningSummary = buildCleaningSummary(issues, auditLog);
  sections.push({
    type: 'cleaning_summary',
    heading: 'Data Quality & Cleaning',
    content: cleaningSummary,
  });

  // 4. Recommendation
  sections.push({
    type: 'recommendation',
    heading: 'Recommendation',
    content:
      typeof recommendation === 'string' && recommendation.trim().length > 0
        ? recommendation.trim()
        : '_No recommendation was provided for this narrative._',
  });

  return {
    version: 1,
    generatedAt,
    title,
    sections,
    metadata: {
      author,
      toolVersion: 'DataGlow Portfolio Narrative v1',
      hasOverconfidenceCaveats: flaggedFindings.length > 0,
      sourceStoryHash: (storyDoc && storyDoc.provenance && storyDoc.provenance.provenanceHash) || null,
    },
  };
}

// ------------------------------------------------------------
// Markdown rendering
// ------------------------------------------------------------

function renderCleaningSummaryMarkdown(summary) {
  const lines = [];
  lines.push(`- **Issues found:** ${summary.totalIssuesFound}`);
  lines.push(`- **Fixes applied:** ${summary.totalFixesApplied}`);
  lines.push(`- **Still open:** ${summary.openIssues.length}`);

  const typeKeys = Object.keys(summary.issuesByType);
  if (typeKeys.length > 0) {
    lines.push('');
    lines.push('| Issue type | Count |');
    lines.push('| --- | --- |');
    for (const key of typeKeys) {
      lines.push(`| ${key} | ${summary.issuesByType[key]} |`);
    }
  }

  if (summary.openIssues.length > 0) {
    lines.push('');
    lines.push('**Open issues:**');
    for (const issue of summary.openIssues) {
      lines.push(`- ${issue.label || issue.id}`);
    }
  }

  return lines.join('\n');
}

function renderStorySectionMarkdown(section) {
  if (!section.content) {
    return '_No analysis sections were available for this narrative._';
  }
  const lines = [];
  if (section.keyFinding) {
    lines.push(`**Key finding:** ${section.keyFinding}`);
    lines.push('');
  }
  for (const sub of section.content) {
    if (!sub) continue;
    lines.push(`### ${sub.heading || sub.type || 'Section'}`);
    lines.push('');
    if (typeof sub.content === 'string') {
      lines.push(sub.content);
    } else if (sub.content && typeof sub.content === 'object') {
      lines.push('```json');
      lines.push(JSON.stringify(sub.content, null, 2));
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function renderOverconfidenceCaveatMarkdown(caveats) {
  const lines = [];
  lines.push('_The following claims in the analysis above carry lower confidence and should be read with that in mind:_');
  lines.push('');
  for (const c of caveats) {
    lines.push(`- ${c.message || JSON.stringify(c)}`);
  }
  return lines.join('\n');
}

/**
 * Renders a narrativeDoc (from buildNarrativeDocument) to a single Markdown
 * string suitable for pasting into a LinkedIn post, GitHub README, or PDF
 * export pipeline. Never throws — malformed sections render as a plain
 * fallback line rather than crashing the whole document.
 * @param {Object} narrativeDoc
 * @returns {string}
 */
function renderNarrativeMarkdown(narrativeDoc) {
  if (!narrativeDoc || !Array.isArray(narrativeDoc.sections)) {
    return '# DataGlow Portfolio Narrative\n\n_This narrative could not be rendered — no sections were available._';
  }

  const lines = [];
  lines.push(`# ${narrativeDoc.title || 'DataGlow Portfolio Narrative'}`);
  lines.push('');
  lines.push(`_Generated ${narrativeDoc.generatedAt || 'unknown date'} · ${(narrativeDoc.metadata && narrativeDoc.metadata.author) || 'Unknown analyst'}_`);
  lines.push('');

  for (const section of narrativeDoc.sections) {
    if (!section) continue;
    lines.push(`## ${section.heading || section.type || 'Section'}`);
    lines.push('');
    try {
      if (section.type === 'story') {
        lines.push(renderStorySectionMarkdown(section));
      } else if (section.type === 'cleaning_summary') {
        lines.push(renderCleaningSummaryMarkdown(section.content));
      } else if (section.type === 'overconfidence_caveat') {
        lines.push(renderOverconfidenceCaveatMarkdown(section.content));
      } else if (typeof section.content === 'string') {
        lines.push(section.content);
      } else {
        lines.push('_No content available for this section._');
      }
    } catch {
      // Fail-open per section: one malformed section never takes down the
      // whole export.
      lines.push('_This section could not be rendered._');
    }
    lines.push('');
  }

  if (narrativeDoc.metadata && narrativeDoc.metadata.sourceStoryHash) {
    lines.push('---');
    lines.push(`_Provenance hash: \`${narrativeDoc.metadata.sourceStoryHash}\`_`);
  }

  return lines.join('\n').trim() + '\n';
}

// ------------------------------------------------------------
// validateNarrativeDocument
// ------------------------------------------------------------

/**
 * Sanity-checks a narrativeDoc before export/render — mirrors the shape of
 * story-builder.js's validateStory() so callers can gate an export button
 * the same way Story View gates its own export.
 * @param {Object} narrativeDoc
 * @returns {{valid:boolean, errors:string[]}}
 */
function validateNarrativeDocument(narrativeDoc) {
  const errors = [];
  if (!narrativeDoc || typeof narrativeDoc !== 'object') {
    return { valid: false, errors: ['narrativeDoc is missing or not an object'] };
  }
  if (!narrativeDoc.title || typeof narrativeDoc.title !== 'string') {
    errors.push('missing or invalid title');
  }
  if (!Array.isArray(narrativeDoc.sections) || narrativeDoc.sections.length === 0) {
    errors.push('sections must be a non-empty array');
  }
  const requiredTypes = ['problem_framing', 'story', 'cleaning_summary', 'recommendation'];
  const presentTypes = new Set((narrativeDoc.sections || []).map((s) => s && s.type));
  for (const t of requiredTypes) {
    if (!presentTypes.has(t)) {
      errors.push(`missing required section type: ${t}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ------------------------------------------------------------
// exports
// ------------------------------------------------------------

export {
  buildCleaningSummary,
  buildNarrativeDocument,
  renderNarrativeMarkdown,
  validateNarrativeDocument,
};
