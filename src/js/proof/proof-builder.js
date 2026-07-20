/* DataGlow — js/proof/proof-builder.js */
/* Part of structured refactor — see src/ directory */

var ProofBuilder = (function () {
    function djb2(str) {
      var hash = 5381;
      var s = String(str == null ? '' : str);
      for (var i = 0; i < s.length; i++) {
        hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
      }
      return hash.toString(16);
    }

    function canExportProof(validationFindings) {
      var findings = Array.isArray(validationFindings) ? validationFindings : [];
      for (var i = 0; i < findings.length; i++) {
        var f = findings[i];
        if (f && f.severity === 'critical' && f.status !== 'resolved') {
          return { allowed: false, blockedBy: f };
        }
      }
      return { allowed: true, blockedBy: null };
    }

    function safeCall(fn, args, fallback) {
      if (typeof fn !== 'function') return fallback;
      try {
        return fn.apply(null, args);
      } catch (e) {
        return fallback;
      }
    }

    function buildProof(session, deps) {
      var s = session || {};
      var d = deps || {};
      var memorySummary = safeCall(d.summarizeMemory, [s.memoryStore], null);
      var memoryTimeline = safeCall(d.generateTimeline, [s.memoryStore], null);
      var provenanceHash = safeCall(d.computeProvenanceHash, [s.memoryStore], null);
      var memoryNDJSON = safeCall(d.exportNDJSON, [s.memoryStore], null);
      var storyHash = safeCall(d.computeStoryHash, [s.storyDoc], null);
      var storyMarkdown = safeCall(d.renderMarkdown, [s.storyDoc], null);

      return {
        formatVersion: 1,
        format: 'dataglow-proof',
        generatedAt: s.generatedAt || new Date().toISOString(),
        toolVersion: s.toolVersion || 'dataglow-canvas',
        datasetName: s.datasetName || null,
        rowCount: s.rowCount || 0,
        columnCount: s.columnCount || 0,
        sourceFileHash: s.sourceFileHash || null,
        validationFindings: Array.isArray(s.validationFindings) ? s.validationFindings : [],
        memorySummary: memorySummary,
        memoryTimeline: memoryTimeline,
        memoryProvenanceHash: provenanceHash,
        memoryNDJSON: memoryNDJSON,
        storyHash: storyHash,
        storyMarkdown: storyMarkdown,
        signature: djb2(JSON.stringify({
          datasetName: s.datasetName || null,
          rowCount: s.rowCount || 0,
          sourceFileHash: s.sourceFileHash || null,
          storyHash: storyHash,
          provenanceHash: provenanceHash
        }))
      };
    }

    function serializeProof(proofPackage) {
      var withComment = Object.assign(
        { _comment: 'DataGlow Proof Package \u2014 see docs/proof-export.md' },
        proofPackage || {}
      );
      return JSON.stringify(withComment, null, 2);
    }

    function verifyProof(proofPackage) {
      var p = proofPackage || {};
      var checks = {
        hasSignature: Boolean(p.signature),
        hasDatasetName: Boolean(p.datasetName),
        signatureMatches: p.signature === djb2(JSON.stringify({
          datasetName: p.datasetName || null,
          rowCount: p.rowCount || 0,
          sourceFileHash: p.sourceFileHash || null,
          storyHash: p.storyHash || null,
          provenanceHash: p.memoryProvenanceHash || null
        }))
      };
      var valid = checks.hasSignature && checks.hasDatasetName && checks.signatureMatches;
      return { valid: valid, checks: checks };
    }

    function generateVerificationReport(verifyResult, proofPackage) {
      var v = verifyResult || {};
      var p = proofPackage || {};
      var lines = [
        'DataGlow Proof Verification Report',
        '-----------------------------------',
        'Dataset: ' + (p.datasetName || 'unknown'),
        'Valid: ' + (v.valid ? 'YES' : 'NO')
      ];
      if (v.checks) {
        Object.keys(v.checks).forEach(function (k) {
          lines.push('  ' + k + ': ' + v.checks[k]);
        });
      }
      return lines.join('\n');
    }

    return {
      djb2: djb2,
      canExportProof: canExportProof,
      buildProof: buildProof,
      serializeProof: serializeProof,
      verifyProof: verifyProof,
      generateVerificationReport: generateVerificationReport
    };
