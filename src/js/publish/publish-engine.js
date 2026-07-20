/* DataGlow — js/publish/publish-engine.js */
/* Part of structured refactor — see src/ directory */

/**
 * publish-engine.js — DataGlow Publish Button (PR AG)
 *
 * Packages the active dataset + findings + insight sentence into a
 * self-contained shareable snapshot. No server. No upload. Zero raw data
 * leaves the browser except in the URL the user explicitly copies and shares.
 *
 * How it works:
 *   1. Serialize: dataset rows (capped at SNAPSHOT_ROW_LIMIT) + column metadata
 *      + findings + insight sentence + title → JSON
 *   2. Compress: gzip via CompressionStream (native browser API)
 *   3. Encode: base64url → append to a #share= fragment
 *   4. The viewer: opening that URL decodes → decompresses → renders a
 *      lightweight read-only grid + insight card. No DataGlow install needed.
 *
 * Public API:
 *   PublishEngine.canPublish(dataset)  → boolean
 *   PublishEngine.buildSnapshot(dataset, opts) → Promise<{ url, rowCount, colCount, sizeKb }>
 *   PublishEngine.decodeSnapshot(fragment) → Promise<SnapshotPayload | null>
 *   PublishEngine.SNAPSHOT_ROW_LIMIT
 */

var PublishEngine = (function () {
  'use strict';

  var SNAPSHOT_ROW_LIMIT = 2000; // rows included in snapshot
  var SNAPSHOT_VERSION = 1;

  // ── compression helpers ────────────────────────────────────────────────────

  function strToUint8(str) {
    return new TextEncoder().encode(str);
  }

  function uint8ToStr(buf) {
    return new TextDecoder().decode(buf);
  }

  function toBase64Url(bytes) {
    var binary = '';
    var chunk = 8192;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    var pad = (4 - b64.length % 4) % 4;
    b64 += '=='.slice(0, pad);
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function compressString(str) {
    if (typeof CompressionStream === 'undefined') {
      // Fallback: no compression (older browsers)
      return Promise.resolve(strToUint8(str));
    }
    var cs = new CompressionStream('gzip');
    var writer = cs.writable.getWriter();
    var chunks = [];
    var reader = cs.readable.getReader();

    function pump() {
      return reader.read().then(function (result) {
        if (result.done) return;
        chunks.push(result.value);
        return pump();
      });
    }

    writer.write(strToUint8(str));
    writer.close();

    return pump().then(function () {
      var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
      var out = new Uint8Array(total);
      var pos = 0;
      chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
      return out;
    });
  }

  function decompressBytes(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.resolve(uint8ToStr(bytes));
    }
    var ds = new DecompressionStream('gzip');
    var writer = ds.writable.getWriter();
    var chunks = [];
    var reader = ds.readable.getReader();

    function pump() {
      return reader.read().then(function (result) {
        if (result.done) return;
        chunks.push(result.value);
        return pump();
      });
    }

    writer.write(bytes);
    writer.close();

    return pump().then(function () {
      var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
      var out = new Uint8Array(total);
      var pos = 0;
      chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
      return uint8ToStr(out);
    });
  }

  // ── public API ─────────────────────────────────────────────────────────────

  function canPublish(dataset) {
    return !!(dataset && dataset.rows && dataset.rows.length > 0 && dataset.columns && dataset.columns.length > 0);
  }

  function buildSnapshot(dataset, opts) {
    opts = opts || {};
    var title = opts.title || dataset.name || 'DataGlow Snapshot';
    var insightResult = (typeof InstantInsight !== 'undefined')
      ? InstantInsight.analyze(dataset)
      : { sentence: '', type: 'default' };

    var rows = dataset.rows.slice(0, SNAPSHOT_ROW_LIMIT);

    var payload = {
      v: SNAPSHOT_VERSION,
      title: title,
      name: dataset.name || '',
      columns: dataset.columns,
      columnTypes: dataset.columnTypes || [],
      columnHealth: dataset.columnHealth || [],
      rows: rows,
      findings: (dataset.findings || []).slice(0, 50),
      insight: insightResult.sentence,
      insightType: insightResult.type,
      rowCount: dataset.rows.length,
      colCount: dataset.columns.length,
      snapshotRows: rows.length,
      createdAt: new Date().toISOString(),
      format: dataset.format || 'csv'
    };

    var json = JSON.stringify(payload);

    return compressString(json).then(function (compressed) {
      var encoded = toBase64Url(compressed);
      // Build the share URL: current origin + /snapshot#share=<encoded>
      var base = window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '/') + 'snapshot.html';
      var url = base + '#share=' + encoded;

      return {
        url: url,
        rowCount: rows.length,
        totalRows: dataset.rows.length,
        colCount: dataset.columns.length,
        sizeKb: Math.round(encoded.length / 1024 * 10) / 10,
        compressed: compressed.length < json.length,
        title: title
      };
    });
  }

  function decodeSnapshot(fragment) {
    // fragment may be full hash "#share=..." or just the encoded string
    var encoded = fragment.replace(/^#?share=/, '');
    if (!encoded) return Promise.resolve(null);
    try {
      var bytes = fromBase64Url(encoded);
      return decompressBytes(bytes).then(function (json) {
        return JSON.parse(json);
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  return {
    canPublish: canPublish,
    buildSnapshot: buildSnapshot,
    decodeSnapshot: decodeSnapshot,
    SNAPSHOT_ROW_LIMIT: SNAPSHOT_ROW_LIMIT
  };
