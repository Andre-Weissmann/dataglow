/* DataGlow — js/story/story-builder.js */
/* Part of structured refactor — see src/ directory */

var StoryBuilder = (function () {
    function djb2Hash(str) {
      var hash = 5381;
      var s = String(str == null ? '' : str);
      for (var i = 0; i < s.length; i++) {
        hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
      }
      var h = (hash >>> 0).toString(16);
      return h.length >= 8 ? h : new Array(8 - h.length + 1).join('0') + h;
    }

    function clampHealth(n) {
      if (typeof n !== 'number' || isNaN(n)) return 0;
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

    function buildSummarySection(dataset, findings) {
      var list = Array.isArray(findings) ? findings : [];
      var errorCount = list.filter(function (f) { return f && (f.severity === 'error' || f.severity === 'critical'); }).length;
      var warningCount = list.filter(function (f) { return f && f.severity === 'warning'; }).length;
      var totalFindings = list.length;

      var overallHealth;
      var columns = (dataset && Array.isArray(dataset.columns)) ? dataset.columns : [];
      var columnScores = columns
        .map(function (c) { return (c && typeof c.healthScore === 'number') ? c.healthScore : null; })
        .filter(function (v) { return v != null; });
      if (columnScores.length > 0) {
        overallHealth = clampHealth(columnScores.reduce(function (a, b) { return a + b; }, 0) / columnScores.length);
      } else {
        overallHealth = clampHealth(100 - errorCount * 10 - warningCount * 3);
      }

      var sortedForTop = list.slice().sort(function (a, b) { return severityRank(a && a.severity) - severityRank(b && b.severity); });
      var topIssues = sortedForTop.slice(0, 3).map(function (f) {
        return { column: (f && f.column) || 'dataset', severity: (f && f.severity) || 'info', message: (f && f.message) || '' };
      });

      return {
        id: 'summary', type: 'summary', title: 'Summary',
        content: { overallHealth: overallHealth, totalFindings: totalFindings, errorCount: errorCount, warningCount: warningCount, topIssues: topIssues }
      };
    }

    function buildFindingsSection(findings) {
      var list = Array.isArray(findings) ? findings : [];
      var items = list.slice()
        .sort(function (a, b) { return severityRank(a && a.severity) - severityRank(b && b.severity); })
        .map(function (f) {
          return {
            severity: (f && f.severity) || 'info',
            column: (f && f.column) || '',
            message: (f && f.message) || '',
            rowsAffected: (f && typeof f.rowsAffected === 'number') ? f.rowsAffected : null,
            suggestedFix: (f && f.suggestedFix) || null
          };
        });
      return { id: 'findings', type: 'findings', title: 'Findings', content: { items: items } };
    }

    function buildTimelineSection(memoryStore, datasetId, options) {
      options = options || {};
      var generate = typeof options.generateTimeline === 'function' ? options.generateTimeline : function () { return []; };
      var entries = [];
      try { entries = generate(memoryStore, datasetId, options) || []; } catch (_e) { entries = []; }
      if (!Array.isArray(entries)) entries = [];
      if (options.maxTimelineEntries) entries = entries.slice(0, options.maxTimelineEntries);
      return { id: 'timeline', type: 'timeline', title: 'Timeline', content: { entries: entries } };
    }

    function buildSQLAuditSection(memoryStore, datasetId) {
      var records = (memoryStore && Array.isArray(memoryStore.records))
        ? memoryStore.records.filter(function (r) { return datasetId === undefined || r.datasetId === datasetId; })
        : [];
      var queries = records
        .filter(function (r) { return r && r.type === 'sql_query'; })
        .slice()
        .sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? -1 : 1; })
        .map(function (r) { return { sql: r.sql || '', timestamp: r.timestamp || null, note: (r.reason || '') }; });
      return { id: 'sql_audit', type: 'sql_audit', title: 'SQL Audit', content: { queries: queries } };
    }

    function buildProvenanceSection(dataset, memoryStore, datasetId, options) {
      options = options || {};
      var computeHash = typeof options.computeProvenanceHash === 'function' ? options.computeProvenanceHash : function () { return 'djb2:00000000'; };
      var provenanceHash;
      try { provenanceHash = computeHash(memoryStore, datasetId); } catch (_e) { provenanceHash = 'djb2:00000000'; }
      var recordCount = (memoryStore && Array.isArray(memoryStore.records))
        ? memoryStore.records.filter(function (r) { return datasetId === undefined || r.datasetId === datasetId; }).length
        : 0;
      var generatedAt = options.now || new Date().toISOString();

      return {
        id: 'provenance', type: 'provenance', title: 'Provenance',
        content: {
          datasetName: (dataset && dataset.name) || 'Untitled dataset',
          rowCount: (dataset && dataset.rowCount) || 0,
          columnCount: (dataset && dataset.columnCount) || 0,
          provenanceHash: provenanceHash,
          generatedAt: generatedAt,
          recordCount: recordCount
        }
      };
    }

    function formatSubtitle(dataset, summaryContent) {
      var rows = (dataset && typeof dataset.rowCount === 'number') ? dataset.rowCount : 0;
      var cols = (dataset && typeof dataset.columnCount === 'number') ? dataset.columnCount : 0;
      var health = summaryContent ? Math.round(summaryContent.overallHealth) : 0;
      return rows.toLocaleString('en-US') + ' rows · ' + cols + ' columns · Validation ' + health + '%';
    }

    function deriveKeyFinding(summaryContent, findingsContent) {
      var top = summaryContent && summaryContent.topIssues && summaryContent.topIssues[0];
      if (top && top.message) {
        var label = (top.severity === 'error' || top.severity === 'critical') ? 'Critical issue' : 'Top finding';
        return label + ': ' + top.message;
      }
      if (findingsContent && findingsContent.items && findingsContent.items.length === 0) {
        return 'No validation issues were found  -  this dataset is clean.';
      }
      return 'This dataset has no standout issues to report.';
    }

    function buildStory(dataset, findings, memoryStore, options) {
      options = options || {};
      var datasetId = options.datasetId != null ? options.datasetId : (dataset && dataset.id);
      var includeTimeline = options.includeTimeline !== false;
      var includeSQL = options.includeSQL !== false;

      var summarySection = buildSummarySection(dataset, findings);
      var findingsSection = buildFindingsSection(findings);
      var provenanceSection = buildProvenanceSection(dataset, memoryStore, datasetId, options);

      var sections = [summarySection, findingsSection];
      if (includeTimeline) sections.push(buildTimelineSection(memoryStore, datasetId, options));
      if (includeSQL) sections.push(buildSQLAuditSection(memoryStore, datasetId));
      sections.push(provenanceSection);

      var title = options.title || ('Analysis of ' + ((dataset && dataset.name) || 'dataset'));
      var subtitle = formatSubtitle(dataset, summarySection.content);
      var keyFinding = deriveKeyFinding(summarySection.content, findingsSection.content);
      var generatedAt = options.now || new Date().toISOString();

      return {
        version: 1,
        generatedAt: generatedAt,
        title: title,
        subtitle: subtitle,
        keyFinding: keyFinding,
        sections: sections,
        provenance: {
          datasetName: provenanceSection.content.datasetName,
          rowCount: provenanceSection.content.rowCount,
          columnCount: provenanceSection.content.columnCount,
          provenanceHash: provenanceSection.content.provenanceHash,
          generatedAt: provenanceSection.content.generatedAt
        },
        metadata: {
          author: options.author || 'Unknown analyst',
          toolVersion: 'DataGlow Canvas v1',
          includesTimeline: includeTimeline
        }
      };
    }

    function escapeMarkdownCell(text) {
      return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    }
    function findSection(storyDoc, type) {
      return (storyDoc && Array.isArray(storyDoc.sections)) ? storyDoc.sections.filter(function (s) { return s && s.type === type; })[0] : null;
    }

    function renderMarkdown(storyDoc) {
      var doc = storyDoc || {};
      var lines = [];

      lines.push('# ' + (doc.title || 'Untitled Story'));
      lines.push('');
      lines.push('*' + (doc.subtitle || '') + '*');
      lines.push('');
      lines.push('## Key Finding');
      lines.push('');
      lines.push('> ' + (doc.keyFinding || ''));
      lines.push('');

      var summary = findSection(doc, 'summary');
      lines.push('## Summary');
      lines.push('');
      if (summary && summary.content) {
        var c = summary.content;
        lines.push('- Overall health: **' + Math.round(c.overallHealth) + '%**');
        lines.push('- Total findings: **' + c.totalFindings + '** (' + c.errorCount + ' errors, ' + c.warningCount + ' warnings)');
        if (c.topIssues && c.topIssues.length) {
          lines.push('');
          lines.push('Top issues:');
          c.topIssues.forEach(function (issue) {
            lines.push('- **' + issue.severity + '**  -  ' + issue.column + ': ' + issue.message);
          });
        }
      }
      lines.push('');

      var findings = findSection(doc, 'findings');
      lines.push('## Findings');
      lines.push('');
      var items = (findings && findings.content && findings.content.items) || [];
      if (items.length === 0) {
        lines.push('_No findings recorded._');
      } else {
        lines.push('| Severity | Column | Issue | Rows Affected |');
        lines.push('|---|---|---|---|');
        items.forEach(function (item) {
          lines.push('| ' + escapeMarkdownCell(item.severity) + ' | ' + escapeMarkdownCell(item.column) + ' | ' + escapeMarkdownCell(item.message) + ' | ' + (item.rowsAffected != null ? item.rowsAffected : ' - ') + ' |');
        });
      }
      lines.push('');

      var timeline = findSection(doc, 'timeline');
      if (timeline) {
        lines.push('## Timeline');
        lines.push('');
        var entries = (timeline.content && timeline.content.entries) || [];
        if (entries.length === 0) {
          lines.push('_No timeline entries recorded._');
        } else {
          entries.forEach(function (entry) { lines.push('1. ' + entry); });
        }
        lines.push('');
      }

      var sqlAudit = findSection(doc, 'sql_audit');
      var sqlQueries = (sqlAudit && sqlAudit.content && sqlAudit.content.queries) || [];
      if (sqlAudit && sqlQueries.length > 0) {
        lines.push('## SQL Audit');
        lines.push('');
        sqlQueries.forEach(function (q) {
          lines.push('```sql');
          lines.push(q.sql || '');
          lines.push('```');
          var meta = [q.timestamp, q.note].filter(Boolean).join('  -  ');
          if (meta) lines.push('*' + meta + '*');
          lines.push('');
        });
      }

      var provenance = findSection(doc, 'provenance');
      lines.push('## Provenance');
      lines.push('');
      if (provenance && provenance.content) {
        var pc = provenance.content;
        lines.push('- Dataset: **' + pc.datasetName + '**');
        lines.push('- Rows: ' + pc.rowCount + ' · Columns: ' + pc.columnCount);
        lines.push('- Provenance hash: `' + pc.provenanceHash + '`');
        lines.push('- Generated at: ' + pc.generatedAt);
        lines.push('- Memory records: ' + pc.recordCount);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push('*Generated by DataGlow Canvas. Provenance hash: ' + (doc.provenance ? doc.provenance.provenanceHash : '') + '*');

      return lines.join('\n');
    }

    function escapeHtml(text) {
      return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var COLOR_BACKGROUND = '#F7F6F2';
    var COLOR_PRIMARY = '#01696F';
    var COLOR_WARNING = '#964219';
    var COLOR_ERROR = '#A12C7B';

    function severityColor(severity) {
      if (severity === 'error' || severity === 'critical') return COLOR_ERROR;
      if (severity === 'warning') return COLOR_WARNING;
      return COLOR_PRIMARY;
    }

    function renderHTML(storyDoc) {
      var doc = storyDoc || {};
      var summary = findSection(doc, 'summary');
      var findings = findSection(doc, 'findings');
      var timeline = findSection(doc, 'timeline');
      var sqlAudit = findSection(doc, 'sql_audit');
      var provenance = findSection(doc, 'provenance');

      var summaryContent = (summary && summary.content) || {};
      var findingsItems = (findings && findings.content && findings.content.items) || [];
      var timelineEntries = (timeline && timeline.content && timeline.content.entries) || [];
      var sqlQueries = (sqlAudit && sqlAudit.content && sqlAudit.content.queries) || [];
      var provenanceContent = (provenance && provenance.content) || {};

      var topIssuesHtml = (summaryContent.topIssues || [])
        .map(function (issue) {
          return '<li><span style="color:' + severityColor(issue.severity) + '; font-weight:600;">' + escapeHtml(issue.severity) + '</span>  -  ' + escapeHtml(issue.column) + ': ' + escapeHtml(issue.message) + '</li>';
        }).join('\n');

      var findingsRowsHtml = findingsItems.length === 0
        ? '<tr><td colspan="4" style="padding:8px 12px; color:#666;">No findings recorded.</td></tr>'
        : findingsItems.map(function (item, idx) {
          var stripe = idx % 2 === 0 ? COLOR_BACKGROUND : '#FFFFFF';
          return '<tr style="background:' + stripe + ';">' +
            '<td style="padding:8px 12px; color:' + severityColor(item.severity) + '; font-weight:600;">' + escapeHtml(item.severity) + '</td>' +
            '<td style="padding:8px 12px;">' + escapeHtml(item.column) + '</td>' +
            '<td style="padding:8px 12px;">' + escapeHtml(item.message) + '</td>' +
            '<td style="padding:8px 12px; text-align:right;">' + (item.rowsAffected != null ? escapeHtml(item.rowsAffected) : ' - ') + '</td>' +
          '</tr>';
        }).join('\n');

      var timelineHtml = timelineEntries.length === 0
        ? '<p style="color:#666;">No timeline entries recorded.</p>'
        : '<ol style="margin:0; padding-left:20px;">' + timelineEntries.map(function (entry) { return '<li style="margin-bottom:6px;">' + escapeHtml(entry) + '</li>'; }).join('\n') + '</ol>';

      var sqlHtml = sqlQueries.length === 0 ? '' :
        '<h2 style="color:' + COLOR_PRIMARY + '; border-bottom:1px solid #ddd; padding-bottom:4px;">SQL Audit</h2>' +
        sqlQueries.map(function (q) {
          return '<pre style="background:#1e1e1e; color:#f5f5f5; padding:12px; border-radius:4px; overflow-x:auto; font-size:12px;"><code>' + escapeHtml(q.sql) + '</code></pre>' +
            '<p style="color:#888; font-size:12px; margin-top:-4px;">' + escapeHtml([q.timestamp, q.note].filter(Boolean).join('  -  ')) + '</p>';
        }).join('\n');

      return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n<title>' + escapeHtml(doc.title || 'DataGlow Story') + '</title>\n<style>\n' +
        '  @media print {\n    body { background: #FFFFFF !important; }\n    .no-print { display: none !important; }\n    a { color: inherit; text-decoration: none; }\n    table, pre { page-break-inside: avoid; }\n  }\n' +
        '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: ' + COLOR_BACKGROUND + '; color: #1a1a1a; margin: 0; padding: 32px; line-height: 1.5; }\n' +
        '  table { border-collapse: collapse; width: 100%; }\n  th { text-align: left; padding: 8px 12px; background: ' + COLOR_PRIMARY + '; color: #FFFFFF; }\n</style>\n</head>\n<body>\n' +
        '  <h1 style="color:' + COLOR_PRIMARY + '; margin-bottom:4px;">' + escapeHtml(doc.title || 'Untitled Story') + '</h1>\n' +
        '  <p style="color:#555; margin-top:0;"><em>' + escapeHtml(doc.subtitle || '') + '</em></p>\n\n' +
        '  <h2 style="color:' + COLOR_PRIMARY + '; border-bottom:1px solid #ddd; padding-bottom:4px;">Key Finding</h2>\n' +
        '  <blockquote style="border-left:4px solid ' + COLOR_PRIMARY + '; margin:0; padding:8px 16px; background:#FFFFFF;">\n    ' + escapeHtml(doc.keyFinding || '') + '\n  </blockquote>\n\n' +
        '  <h2 style="color:' + COLOR_PRIMARY + '; border-bottom:1px solid #ddd; padding-bottom:4px;">Summary</h2>\n' +
        '  <p>Overall health: <strong>' + Math.round(summaryContent.overallHealth || 0) + '%</strong> &middot;\n' +
        '     Total findings: <strong>' + (summaryContent.totalFindings || 0) + '</strong>\n' +
        '     (' + (summaryContent.errorCount || 0) + ' errors, ' + (summaryContent.warningCount || 0) + ' warnings)</p>\n' +
        (topIssuesHtml ? ('  <ul>' + topIssuesHtml + '</ul>\n') : '') +
        '  <h2 style="color:' + COLOR_PRIMARY + '; border-bottom:1px solid #ddd; padding-bottom:4px;">Findings</h2>\n' +
        '  <table>\n    <thead>\n      <tr><th>Severity</th><th>Column</th><th>Issue</th><th style="text-align:right;">Rows Affected</th></tr>\n    </thead>\n    <tbody>\n      ' + findingsRowsHtml + '\n    </tbody>\n  </table>\n\n' +
        (timeline ? ('  <h2 style="color:' + COLOR_PRIMARY + '; border-bottom:1px solid #ddd; padding-bottom:4px;">Timeline</h2>' + timelineHtml + '\n') : '') +
        '  ' + sqlHtml + '\n\n' +
        '  <h2 style="color:' + COLOR_PRIMARY + '; border-bottom:1px solid #ddd; padding-bottom:4px;">Provenance</h2>\n' +
        '  <table>\n    <tbody>\n' +
        '      <tr><td style="padding:4px 12px; font-weight:600;">Dataset</td><td style="padding:4px 12px;">' + escapeHtml(provenanceContent.datasetName) + '</td></tr>\n' +
        '      <tr><td style="padding:4px 12px; font-weight:600;">Rows</td><td style="padding:4px 12px;">' + escapeHtml(provenanceContent.rowCount) + '</td></tr>\n' +
        '      <tr><td style="padding:4px 12px; font-weight:600;">Columns</td><td style="padding:4px 12px;">' + escapeHtml(provenanceContent.columnCount) + '</td></tr>\n' +
        '      <tr><td style="padding:4px 12px; font-weight:600;">Provenance hash</td><td style="padding:4px 12px; font-family:monospace;">' + escapeHtml(provenanceContent.provenanceHash) + '</td></tr>\n' +
        '      <tr><td style="padding:4px 12px; font-weight:600;">Generated at</td><td style="padding:4px 12px;">' + escapeHtml(provenanceContent.generatedAt) + '</td></tr>\n' +
        '    </tbody>\n  </table>\n\n' +
        '  <hr style="margin:32px 0; border:none; border-top:1px solid #ccc;" />\n' +
        '  <p style="color:#888; font-size:12px;"><em>Generated by DataGlow Canvas. Provenance hash: ' + escapeHtml(doc.provenance ? doc.provenance.provenanceHash : '') + '</em></p>\n' +
        '</body>\n</html>';

/* ---- tail from end infrastructure.js ---- */
}

    function computeStoryHash(storyDoc) {
      var sections = (storyDoc && Array.isArray(storyDoc.sections)) ? storyDoc.sections : [];
      var contentBasis = sections.map(function (s) { return { id: s && s.id, type: s && s.type, content: s && s.content }; });
      return djb2Hash(JSON.stringify(contentBasis));
    }

    function validateStory(storyDoc) {
      var errors = [];
      var doc = storyDoc;

      if (!doc || typeof doc !== 'object') {
        return { valid: false, errors: ['storyDoc is missing or not an object'] };
      }
      if (doc.version == null) errors.push('version is missing');
      if (!doc.generatedAt || isNaN(Date.parse(doc.generatedAt))) errors.push('generatedAt is missing or not a valid ISO date string');
      if (!doc.title || typeof doc.title !== 'string' || doc.title.trim() === '') errors.push('title is missing or empty');

      if (!Array.isArray(doc.sections)) {
        errors.push('sections is missing or not an array');
      } else {
        doc.sections.forEach(function (section, idx) {
          if (!section || typeof section !== 'object') { errors.push('section at index ' + idx + ' is missing or not an object'); return; }
          if (!section.id) errors.push('section at index ' + idx + ' is missing an id');
          if (!section.type) errors.push('section at index ' + idx + ' is missing a type');
          if (!section.title) errors.push('section at index ' + idx + ' is missing a title');
          if (section.content == null) errors.push('section at index ' + idx + ' is missing content');
        });
      }
      if (!doc.provenance || typeof doc.provenance !== 'object' || !doc.provenance.provenanceHash) errors.push('provenance.provenanceHash is missing');

      return { valid: errors.length === 0, errors: errors };
    }

    return {
      buildStory: buildStory,
      renderMarkdown: renderMarkdown,
      renderHTML: renderHTML,
      computeStoryHash: computeStoryHash,
      validateStory: validateStory
    };
