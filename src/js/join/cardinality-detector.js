/* DataGlow — js/join/cardinality-detector.js */
/* Part of structured refactor — see src/ directory */

(function() {
'use strict';

/**
 * CardinalityDetector — warns before a join creates fan-out row explosion.
 *
 * A fan-out join happens when the right-side key is not unique:
 *   Left: 100 rows with patient_id values
 *   Right: 500 rows with patient_id (multiple claims per patient)
 *   INNER JOIN → 500+ result rows — silent data multiplication
 *
 * This is one of the most common and dangerous SQL mistakes.
 * DataGlow catches it BEFORE the join runs and explains it plainly.
 *
 * Public API:
 *   CardinalityDetector.analyze(dsA, dsB, keyA, keyB)
 *     → { type, ratio, leftUnique, rightUnique, leftTotal, rightTotal,
 *          message, severity, suggestion }
 *
 *   CardinalityDetector.renderWarning(analysis, containerEl)
 *     → injects warning banner into containerEl (or clears it if safe)
 */

var CardinalityDetector = window.CardinalityDetector = {

  analyze: function(dsA, dsB, keyA, keyB) {
    if (!dsA || !dsB || !keyA || !keyB) return null;

    var rowsA = dsA.rows || [];
    var rowsB = dsB.rows || [];

    // Count unique key values on each side
    var uniqueA = new Set();
    var uniqueB = new Set();
    var freqB   = {};   // key → count of occurrences in B

    rowsA.forEach(function(r) {
      var v = r[keyA];
      if (v !== null && v !== undefined) uniqueA.add(String(v));
    });
    rowsB.forEach(function(r) {
      var v = r[keyB];
      if (v !== null && v !== undefined) {
        var k = String(v);
        uniqueB.add(k);
        freqB[k] = (freqB[k] || 0) + 1;
      }
    });

    var leftTotal    = rowsA.length;
    var rightTotal   = rowsB.length;
    var leftUnique   = uniqueA.size;
    var rightUnique  = uniqueB.size;

    // Is the right-side key unique? (1-to-1 or many-to-1 from left's perspective)
    var rightIsUnique  = rightUnique === rightTotal;
    var leftIsUnique   = leftUnique  === leftTotal;

    // Estimate output rows for INNER join (approximate fan-out)
    var matchedLeftKeys = [...uniqueA].filter(function(k){ return freqB[k]; });
    var estimatedOutputRows = matchedLeftKeys.reduce(function(sum, k){
      return sum + freqB[k];
    }, 0);

    // Fan-out ratio: how many output rows per input left row
    var fanOutRatio = leftTotal > 0 ? (estimatedOutputRows / leftTotal) : 1;

    var type, severity, message, suggestion;

    if (rightIsUnique && leftIsUnique) {
      type = '1:1';
      severity = 'safe';
      message = 'One-to-one join. Each row matches at most one row on both sides.';
      suggestion = 'This is the cleanest join type. No row duplication will occur.';
    } else if (rightIsUnique && !leftIsUnique) {
      type = 'N:1';
      severity = 'safe';
      message = 'Many-to-one join. Multiple ' + (dsA.name||'left') + ' rows share the same key, each matching one row in ' + (dsB.name||'right') + '.';
      suggestion = 'Safe for aggregations. No unexpected row explosion.';
    } else if (!rightIsUnique && leftIsUnique) {
      type = '1:N';
      severity = fanOutRatio > 5 ? 'warning' : 'caution';
      var expandFmt = fanOutRatio >= 10
        ? Math.round(fanOutRatio) + 'x more rows'
        : parseFloat(fanOutRatio.toFixed(1)) + 'x more rows';
      message = 'One-to-many join. Each ' + (dsA.name||'left') + ' row may match multiple ' + (dsB.name||'right') + ' rows, expanding the result to ~' + expandFmt + '.';
      suggestion = fanOutRatio > 5
        ? 'Consider aggregating ' + (dsB.name||'right') + ' first (e.g. GROUP BY ' + keyB + ') then joining, to avoid row explosion.'
        : 'Moderate fan-out. Verify the result row count matches your expectations.';
    } else {
      // N:N  -  most dangerous
      type = 'N:N';
      severity = 'danger';
      var leftDup  = leftTotal  - leftUnique;
      var rightDup = rightTotal - rightUnique;
      message = 'Many-to-many join detected. Both sides have duplicate key values (' +
        leftDup.toLocaleString() + ' duplicate' + (leftDup!==1?'s':'') + ' on left, ' +
        rightDup.toLocaleString() + ' duplicate' + (rightDup!==1?'s':'') + ' on right). ' +
        'This will create a row explosion  -  potentially ' + Math.round(fanOutRatio) + 'x your current row count.';
      suggestion = 'Deduplicate one or both sides before joining. A many-to-many join is almost always a sign of a data model problem.';
    }

    return {
      type: type,
      severity: severity,
      ratio: fanOutRatio,
      leftUnique: leftUnique,
      rightUnique: rightUnique,
      leftTotal: leftTotal,
      rightTotal: rightTotal,
      estimatedOutputRows: estimatedOutputRows,
      matchedKeys: matchedLeftKeys.length,
      message: message,
      suggestion: suggestion
    };
  },

  renderWarning: function(analysis, containerEl) {
    if (!containerEl) return;

    // Clear previous
    var existing = containerEl.querySelector('.cardinality-banner');
    if (existing) existing.remove();
    if (!analysis || analysis.severity === 'safe') return;

    var colors = {
      caution: { bg: 'color-mix(in srgb,#D97706 10%,transparent)', border: '#D97706', icon: '&#9888;', label: 'Caution' },
      warning: { bg: 'color-mix(in srgb,#EA580C 10%,transparent)', border: '#EA580C', icon: '&#9888;', label: 'Fan-out Warning' },
      danger:  { bg: 'color-mix(in srgb,#DC2626 10%,transparent)', border: '#DC2626', icon: '&#128680;', label: 'Many-to-Many Danger' }
    };
    var c = colors[analysis.severity] || colors.caution;

    var badge = { '1:N':'1 to Many', 'N:N':'Many to Many', 'N:1':'Many to 1', '1:1':'1 to 1' }[analysis.type] || analysis.type;

    var banner = document.createElement('div');
    banner.className = 'cardinality-banner';
    banner.style.cssText = 'background:'+c.bg+';border:1px solid '+c.border+';border-radius:8px;padding:12px 14px;margin:12px 0;';
    banner.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
        '<span style="font-size:16px;">' + c.icon + '</span>' +
        '<span style="font-size:12px;font-weight:700;color:'+c.border+';">' + c.label + '</span>' +
        '<span style="margin-left:auto;font-size:10px;font-weight:700;background:'+c.border+';color:#fff;padding:2px 7px;border-radius:10px;">' + badge + '</span>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--text);margin:0 0 6px;line-height:1.5;">' + analysis.message + '</p>' +
      '<p style="font-size:11px;color:var(--text-muted);margin:0;line-height:1.4;"><strong>Suggestion:</strong> ' + analysis.suggestion + '</p>' +
      (analysis.estimatedOutputRows > 0
        ? '<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">Estimated output: ~' + analysis.estimatedOutputRows.toLocaleString() + ' rows &middot; Matched keys: ' + analysis.matchedKeys.toLocaleString() + '</div>'
        : '');
    containerEl.insertBefore(banner, containerEl.firstChild);
  }
};
