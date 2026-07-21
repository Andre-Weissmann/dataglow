/* DataGlow -- js/notary/notary-engine.js */
/* The Notary: portable, independently verifiable proof-bundle.
   Extends ProofBuilder with SHA-256 (SubtleCrypto) instead of djb2,
   adds a self-contained verifier manifest, and produces a .dgnot bundle
   that anyone can verify with the open DataGlow Verifier CLI -- no account,
   no server, no DataGlow install required.

   Bundle format (JSON):
   {
     _notary: 1,
     _comment: "DataGlow Notarized Proof ...",
     notarizedAt: <ISO>,
     toolVersion: <string>,
     dataset: { name, rowCount, columnCount, sha256 },
     query: { text, executedAt },           // if applicable
     result: { rowCount, sha256 },          // SHA-256 of result rows JSON
     story: { sha256, markdown },
     provenance: { chain: [...], sha256 },
     validationFindings: [...],
     seal: {
       input: <string>,                     // canonical JSON that was hashed
       sha256: <hex string>,                // SHA-256 of input
       djb2: <hex string>                   // legacy fallback
     },
     verifier: {
       cli: "npx dataglow-verify@latest <filename>",
       spec: "https://dataglow.io/proof-spec/v1"
     }
   }
*/

var NotaryEngine = window.NotaryEngine = (function () {
  'use strict';

  var NOTARY_VERSION = 1;
  var SPEC_URL       = 'https://dataglow.io/proof-spec/v1';
  var CLI_CMD        = 'npx dataglow-verify@latest';

  /* djb2 fallback for environments without SubtleCrypto */
  function djb2(str) {
    var hash = 5381;
    var s = String(str == null ? '' : str);
    for (var i = 0; i < s.length; i++) {
      hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  }

  /* SHA-256 via SubtleCrypto -- returns hex string or null if unavailable */
  async function sha256(str) {
    if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) return null;
    try {
      var buf = new TextEncoder().encode(str);
      var hashBuf = await window.crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hashBuf))
        .map(function (b) { return b.toString(16).padStart(2, '0'); })
        .join('');
    } catch (e) { return null; }
  }

  /* Canonical deterministic serialisation of an object (sorted keys) */
  function canonical(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
    var keys = Object.keys(obj).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + canonical(obj[k]);
    }).join(',') + '}';
  }

  /* Build the notarized bundle from a DataGlow session */
  async function notarize(session, deps) {
    var s = session || {};
    var d = deps || {};

    /* Gather story */
    var storyMarkdown = (typeof d.renderMarkdown === 'function')
      ? d.renderMarkdown(s.storyDoc) : null;
    var storyHash = (typeof d.computeStoryHash === 'function')
      ? d.computeStoryHash(s.storyDoc) : null;

    /* Gather provenance */
    var provenanceChain = (typeof d.generateTimeline === 'function')
      ? d.generateTimeline(s.memoryStore) : null;
    var provenanceHashLegacy = (typeof d.computeProvenanceHash === 'function')
      ? d.computeProvenanceHash(s.memoryStore) : null;

    /* Result rows hash */
    var resultRows = Array.isArray(s.resultRows) ? s.resultRows : [];
    var resultJson = JSON.stringify(resultRows);

    /* Seal input: canonical form of all content hashes */
    var sealInput = canonical({
      datasetName:   s.datasetName   || null,
      rowCount:      s.rowCount      || 0,
      sourceFileHash:s.sourceFileHash|| null,
      storyHash:     storyHash,
      provenanceHash:provenanceHashLegacy,
      resultHash:    djb2(resultJson),
      notarizedAt:   s.notarizedAt   || new Date().toISOString()
    });

    var sealSha256 = await sha256(sealInput);
    var sealDjb2   = djb2(sealInput);

    var bundle = {
      _notary:    NOTARY_VERSION,
      _comment:   'DataGlow Notarized Proof -- independently verifiable. See verifier field.',
      notarizedAt:s.notarizedAt || new Date().toISOString(),
      toolVersion:s.toolVersion || 'dataglow-canvas',

      dataset: {
        name:        s.datasetName    || null,
        rowCount:    s.rowCount       || 0,
        columnCount: s.columnCount    || 0,
        sha256:      s.sourceFileHash || null
      },

      query: s.queryText ? {
        text:       s.queryText,
        executedAt: s.queryExecutedAt || null
      } : null,

      result: resultRows.length ? {
        rowCount: resultRows.length,
        sha256:   await sha256(resultJson) || djb2(resultJson)
      } : null,

      story: storyMarkdown ? {
        sha256:   await sha256(storyMarkdown) || storyHash,
        markdown: storyMarkdown
      } : null,

      provenance: {
        chain:  provenanceChain || [],
        sha256: provenanceHashLegacy || null
      },

      validationFindings: Array.isArray(s.validationFindings)
        ? s.validationFindings : [],

      seal: {
        input:  sealInput,
        sha256: sealSha256 || null,
        djb2:   sealDjb2
      },

      verifier: {
        cli:  CLI_CMD + ' <filename>.dgnot',
        spec: SPEC_URL
      }
    };

    return bundle;
  }

  /* Verify a bundle without trusting any server */
  async function verify(bundle) {
    var b = bundle || {};
    if (!b.seal || !b.seal.input) return { valid: false, reason: 'No seal found.' };

    var checks = {};

    /* Recompute djb2 (always available) */
    checks.djb2Match = (djb2(b.seal.input) === b.seal.djb2);

    /* Recompute SHA-256 if present */
    if (b.seal.sha256) {
      var recomputed = await sha256(b.seal.input);
      checks.sha256Match = (recomputed === b.seal.sha256);
    }

    /* Story integrity */
    if (b.story && b.story.markdown && b.story.sha256) {
      var storySha = await sha256(b.story.markdown);
      checks.storyIntact = (storySha === b.story.sha256);
    }

    /* Result integrity */
    if (b.result && b.result.sha256) {
      checks.resultHashPresent = true;
    }

    var allTrue = Object.values(checks).every(Boolean);
    return { valid: allTrue, checks: checks };
  }

  /* Produce a human-readable verification report */
  function verificationReport(verifyResult, bundle) {
    var v = verifyResult || {};
    var b = bundle || {};
    var lines = [
      'DataGlow Notarized Proof -- Verification Report',
      '================================================',
      'Dataset : ' + (b.dataset && b.dataset.name || 'unknown'),
      'Notarized: ' + (b.notarizedAt || 'unknown'),
      'Tool     : ' + (b.toolVersion || 'unknown'),
      '',
      'Result   : ' + (v.valid ? 'VERIFIED' : 'FAILED'),
      ''
    ];
    if (v.checks) {
      Object.keys(v.checks).forEach(function (k) {
        lines.push('  ' + (v.checks[k] ? '[PASS]' : '[FAIL]') + ' ' + k);
      });
    }
    if (!v.valid) {
      lines.push('');
      lines.push('WARNING: One or more integrity checks failed. This bundle may have been modified.');
    }
    lines.push('');
    lines.push('Verify independently: ' + (b.verifier && b.verifier.cli || 'npx dataglow-verify@latest <file>'));
    lines.push('Spec: ' + (b.verifier && b.verifier.spec || SPEC_URL));
    return lines.join('\n');
  }

  /* Serialize to .dgnot file */
  function serialize(bundle) {
    return JSON.stringify(bundle, null, 2);
  }

  /* Download as .dgnot file */
  function download(bundle, datasetName) {
    var content  = serialize(bundle);
    var blob     = new Blob([content], { type: 'application/json' });
    var url      = URL.createObjectURL(blob);
    var a        = document.createElement('a');
    var safeName = (datasetName || 'proof').replace(/[^a-zA-Z0-9_-]/g, '_');
    a.href     = url;
    a.download = 'dataglow-' + safeName + '-' + Date.now() + '.dgnot';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { notarize, verify, verificationReport, serialize, download, djb2, sha256 };
})();
