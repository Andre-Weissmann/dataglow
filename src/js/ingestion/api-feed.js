/* DataGlow — js/ingestion/api-feed.js */
/* Part of structured refactor — see src/ directory */

var ApiFeed = (function () {
    var FEED_METHODS = ['GET', 'POST'];
    var POLL_INTERVALS_MS = [0, 5000, 15000, 30000, 60000, 300000];
    var POLL_LABELS = ['One-time fetch', 'Every 5s', 'Every 15s', 'Every 30s', 'Every 1 min', 'Every 5 min'];

    function isPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

    function validateFeedUrl(url) {
      if (typeof url !== 'string' || url.trim() === '') {
        return { valid: false, error: 'URL is required', normalized: null };
      }
      var trimmed = url.trim();
      var parsed;
      try { parsed = new URL(trimmed); } catch (e1) {
        try { parsed = new URL('https://' + trimmed); }
        catch (e2) { return { valid: false, error: 'Invalid URL format', normalized: null }; }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { valid: false, error: 'Only HTTP and HTTPS endpoints are supported', normalized: null };
      }
      return { valid: true, error: null, normalized: parsed.href };
    }

    function parseHeadersString(raw) {
      if (typeof raw !== 'string' || raw.trim() === '') return {};
      var out = {};
      raw.split('\n').forEach(function (line) {
        var colon = line.indexOf(':');
        if (colon < 1) return;
        var key = line.slice(0, colon).trim();
        var val = line.slice(colon + 1).trim();
        if (key && val) out[key] = val;
      });
      return out;
    }

    function flattenObjShallow(obj, maxDepth, prefix, depth) {
      prefix = prefix || '';
      depth = depth || 0;
      if (!isPlainObj(obj)) return { value: obj };
      var out = {};
      Object.keys(obj).forEach(function (k) {
        var v = obj[k];
        var key = prefix ? (prefix + '.' + k) : k;
        if (isPlainObj(v) && depth < maxDepth) {
          var nested = flattenObjShallow(v, maxDepth, key, depth + 1);
          Object.keys(nested).forEach(function (nk) { out[nk] = nested[nk]; });
        } else if (Array.isArray(v)) {
          out[key] = JSON.stringify(v);
        } else {
          out[key] = v == null ? null : v;
        }
      });
      return out;
    }

    function findFirstArray(obj, maxDepth, prefix, depth) {
      prefix = prefix || '';
      depth = depth || 0;
      if (depth > maxDepth) return null;
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = obj[k];
        var path = prefix ? (prefix + '.' + k) : k;
        if (Array.isArray(v) && v.length > 0 && isPlainObj(v[0])) return { path: path, value: v };
        if (isPlainObj(v)) {
          var found = findFirstArray(v, maxDepth, path, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    function normalizeApiResponse(parsed, opts) {
      opts = opts || {};
      var maxRows = opts.maxRows || 200000;

      if (Array.isArray(parsed) && parsed.length > 0 && isPlainObj(parsed[0])) {
        var rows = parsed.slice(0, maxRows).map(function (r) { return flattenObjShallow(r, 4); });
        return { rows: rows, path: '(root array)', confidence: 'high', warning: null };
      }
      if (isPlainObj(parsed)) {
        var found = findFirstArray(parsed, 4);
        if (found) {
          var rows2 = found.value.slice(0, maxRows).map(function (r) { return flattenObjShallow(r, 4); });
          return { rows: rows2, path: found.path, confidence: 'medium', warning: 'Rows extracted from "' + found.path + '".' };
        }
        return { rows: [flattenObjShallow(parsed, 4)], path: '(root object)', confidence: 'low', warning: 'Single object  -  treated as one row.' };
      }
      return { rows: [], path: '', confidence: 'low', warning: 'Could not extract rows from API response.' };
    }

    function buildPollSchedule(intervalMs, method, url, headers) {
      var labelIdx = POLL_INTERVALS_MS.indexOf(intervalMs);
      return {
        intervalMs: intervalMs,
        label: labelIdx >= 0 ? POLL_LABELS[labelIdx] : ('Every ' + (intervalMs / 1000) + 's'),
        method: FEED_METHODS.indexOf(method) !== -1 ? method : 'GET',
        url: url,
        headers: headers || {},
        isOneShot: intervalMs === 0
      };
    }

    function buildFeedDataset(rows, url, pollSchedule, fetchedAt) {
      return {
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        rows: rows,
        meta: {
          source: url,
          format: 'api',
          fetchedAt: fetchedAt || new Date().toISOString(),
          pollSchedule: pollSchedule.label,
          note: 'Live API feed from ' + url + '. ' + (pollSchedule.isOneShot ? 'One-time fetch.' : 'Auto-refreshes ' + pollSchedule.label + '.')
        }
      };
    }

    return {
      FEED_METHODS: FEED_METHODS,
      POLL_INTERVALS_MS: POLL_INTERVALS_MS,
      POLL_LABELS: POLL_LABELS,
      validateFeedUrl: validateFeedUrl,
      parseHeadersString: parseHeadersString,
      normalizeApiResponse: normalizeApiResponse,
      buildPollSchedule: buildPollSchedule,
      buildFeedDataset: buildFeedDataset
    };
