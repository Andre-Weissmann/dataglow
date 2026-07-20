/* DataGlow — js/ingestion/json-flattener.js */
/* Part of structured refactor — see src/ directory */

var JsonFlattener = (function () {
    function isPlainObj(v) {
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    function flattenObj(obj, maxDepth, prefix, depth) {
      prefix = prefix || '';
      depth = depth || 0;
      if (!isPlainObj(obj)) return { value: obj };
      var out = {};
      Object.keys(obj).forEach(function (k) {
        var v = obj[k];
        var key = prefix ? (prefix + '.' + k) : k;
        if (isPlainObj(v) && depth < maxDepth) {
          var nested = flattenObj(v, maxDepth, key, depth + 1);
          Object.keys(nested).forEach(function (nk) { out[nk] = nested[nk]; });
        } else if (Array.isArray(v)) {
          out[key] = JSON.stringify(v);
        } else {
          out[key] = v == null ? null : v;
        }
      });
      return out;
    }

    function findFirstArrayPath(obj, maxDepth, prefix, depth) {
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
          var found = findFirstArrayPath(v, maxDepth, path, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    function flattenJson(parsed, opts) {
      opts = opts || {};
      var maxDepth = opts.maxDepth || 4;
      var maxRows = opts.maxRows || 200000;

      if (Array.isArray(parsed) && parsed.length > 0 && isPlainObj(parsed[0])) {
        var rows = parsed.slice(0, maxRows).map(function (r) { return flattenObj(r, maxDepth); });
        return { rows: rows, path: '(root array)', confidence: 'high', warning: null };
      }

      if (Array.isArray(parsed) && parsed.length > 0 && !isPlainObj(parsed[0])) {
        var rows2 = parsed.slice(0, maxRows).map(function (v, i) { return { index: i, value: v == null ? null : String(v) }; });
        return { rows: rows2, path: '(root array of scalars)', confidence: 'medium', warning: 'Array of scalar values  -  each entry becomes a row with index + value columns.' };
      }

      if (isPlainObj(parsed)) {
        var found = findFirstArrayPath(parsed, maxDepth);
        if (found) {
          var rows3 = found.value.slice(0, maxRows).map(function (r) { return flattenObj(r, maxDepth); });
          return { rows: rows3, path: found.path, confidence: 'medium', warning: 'Extracted rows from "' + found.path + '". Other keys in the envelope were discarded.' };
        }
        return { rows: [flattenObj(parsed, maxDepth)], path: '(root object)', confidence: 'low', warning: 'Single JSON object  -  treated as one row. Consider if this is an API envelope.' };
      }

      return { rows: [], path: '', confidence: 'low', warning: 'Could not extract rows from this JSON structure.' };
    }

    function parseJsonOrNdjson(text) {
      if (typeof text !== 'string' || text.trim() === '') {
        return { parsed: null, isNdjson: false, error: 'Empty input' };
      }
      try {
        return { parsed: JSON.parse(text), isNdjson: false, error: null };
      } catch (e1) {}
      try {
        var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return !!l; });
        var rows = lines.map(function (l) { return JSON.parse(l); });
        if (rows.length > 0 && rows.every(isPlainObj)) {
          return { parsed: rows, isNdjson: true, error: null };
        }
      } catch (e2) {}
      return { parsed: null, isNdjson: false, error: 'Could not parse as JSON or NDJSON' };
    }

    function jsonNeedsFlattening(format) {
      return format === 'json' || format === 'ndjson';
    }

    return {
      flattenJson: flattenJson,
      parseJsonOrNdjson: parseJsonOrNdjson,
      jsonNeedsFlattening: jsonNeedsFlattening
    };
