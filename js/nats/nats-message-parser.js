// ============================================================
// DATAGLOW — NATS WebSocket Bridge: message parser
// ============================================================
// This module is PURE LOGIC. It performs no WebSocket connection, no
// network I/O, no localStorage/IndexedDB/OPFS access. It has zero
// browser-API dependencies and is safe to unit-test directly under plain
// Node. The caller (browser NATS WebSocket client, or a test harness with a
// mock transport) is responsible for actually opening `ws://localhost:4222`
// (or `wss://`) and handing this module the raw message payloads it
// receives — this module never initiates a connection of its own.
//
// Supported payload shapes:
//   - a single JSON object:            {"col1": 1, "col2": "x"}
//   - a JSON array of objects:         [{...}, {...}]
//   - NDJSON (one JSON object/line):   {"a":1}\n{"a":2}\n
//   - a single CSV line:               "val1,val2,val3" (headers inferred
//                                       or supplied via options.headers)
//   - a Protobuf stub: any payload that isn't valid text/JSON/NDJSON/CSV is
//     treated as opaque bytes and surfaced as a single base64 column so the
//     rest of the pipeline (schema inference, validation) still has
//     something to work with. This is a placeholder for a future real
//     Protobuf decoder — see docs/nats-bridge.md § Limitations.
//
// This is intentionally the same shape as the rest of DataGlow's
// local-first, transport-free validation layers (see
// js/streaming/streaming-validator.js, js/webhook/webhook-handler.js): a
// pure function core, with all I/O (network, storage, DOM) pushed out to
// the caller.
// ============================================================

/**
 * Supported NATS message payload formats.
 * @readonly
 */
const NATS_FORMATS = {
  JSON: 'json', // {"col1": val, "col2": val} or [{...}, {...}]
  NDJSON: 'ndjson', // one JSON object per line
  CSV_LINE: 'csv_line', // "val1,val2,val3" (single row, headers inferred)
  PROTOBUF_STUB: 'protobuf_stub', // placeholder — returns raw bytes as base64 column
};

// ---------- internal helpers ----------

/**
 * Converts a payload (string or Uint8Array) into a UTF-8 string for text
 * inspection, plus a flag for whether that conversion looked "clean" (i.e.
 * didn't produce the replacement character, a signal of binary data).
 */
function toTextView(payload) {
  if (typeof payload === 'string') {
    return { text: payload, looksBinary: false };
  }
  if (payload instanceof Uint8Array) {
    let text;
    try {
      // TextDecoder is available in both browsers and modern Node.
      text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
    } catch {
      text = '';
    }
    const looksBinary = text.includes('\uFFFD');
    return { text, looksBinary };
  }
  // Fallback: stringify whatever it is (e.g. someone passed an object).
  return { text: String(payload), looksBinary: false };
}

function bytesToBase64(payload) {
  if (typeof payload === 'string') {
    // Encode the string as UTF-8 bytes first, so this path is well-defined
    // even if a caller passes a string into the "binary" path by mistake.
    payload = new TextEncoder().encode(payload);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(payload).toString('base64');
  }
  // Browser fallback: build a binary string then btoa() it.
  let binary = '';
  for (let i = 0; i < payload.length; i++) binary += String.fromCharCode(payload[i]);
  return typeof btoa === 'function' ? btoa(binary) : '';
}

function tryParseJSON(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * True if `text` is multi-line and the majority of its non-empty lines each
 * parse as their own standalone JSON value. A multi-line payload is NATS's
 * NDJSON format even if one or two lines are malformed (those become
 * non-fatal parseErrors downstream) — requiring anything less than a
 * simple majority would misclassify real-world NDJSON streams that have an
 * occasional corrupt line as a single (unparseable) JSON blob instead.
 */
function looksLikeNDJSON(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return false;
  let successCount = 0;
  for (const line of lines) {
    const parsed = tryParseJSON(line);
    if (parsed.ok) successCount++;
  }
  // Require a simple majority of lines to parse cleanly as JSON.
  return successCount >= Math.ceil(lines.length / 2);
}

/** True if `text` looks like a single delimited row: no braces/brackets, has a comma. */
function looksLikeCSVLine(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('\n')) return false; // multi-line isn't a single CSV_LINE
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return trimmed.includes(',');
}

function splitCSVLine(line) {
  // Minimal CSV split: handles simple comma-separated values and basic
  // double-quoted fields. Not a full RFC 4180 parser — NATS payloads are
  // expected to be simple structured messages, not spreadsheet exports.
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((v) => v.trim());
}

function coerceCSVValue(raw) {
  if (raw === '') return null;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return parseFloat(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

// ---------- format detection ----------

/**
 * Detects the format of a NATS message payload.
 *
 * @param {string|Uint8Array} payload
 * @returns {{ format: string, confidence: 'high'|'medium'|'low' }}
 */
function detectNATSFormat(payload) {
  const { text, looksBinary } = toTextView(payload);
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { format: NATS_FORMATS.PROTOBUF_STUB, confidence: 'low' };
  }

  if (looksBinary) {
    return { format: NATS_FORMATS.PROTOBUF_STUB, confidence: 'high' };
  }

  // NDJSON is checked before single-JSON: a multi-line payload where each
  // line parses as its own JSON object is NDJSON even though the first
  // line also starts with '{' (which would otherwise look like a single
  // JSON object truncated across lines).
  if (looksLikeNDJSON(trimmed)) {
    return { format: NATS_FORMATS.NDJSON, confidence: 'high' };
  }

  // Single JSON object or array — highest-confidence structured formats.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = tryParseJSON(trimmed);
    if (parsed.ok) {
      return { format: NATS_FORMATS.JSON, confidence: 'high' };
    }
    // Looked like JSON but failed to parse — still our best guess, but with
    // lower confidence so the caller knows to expect parseErrors.
    return { format: NATS_FORMATS.JSON, confidence: 'low' };
  }

  if (looksLikeCSVLine(trimmed)) {
    return { format: NATS_FORMATS.CSV_LINE, confidence: 'medium' };
  }

  // Ambiguous: plain text with no recognizable delimiter/structure. Default
  // to CSV_LINE (single column) but flag low confidence.
  return { format: NATS_FORMATS.CSV_LINE, confidence: 'low' };
}

// ---------- message parsing ----------

/**
 * Parses a single NATS message payload into rows.
 *
 * @param {string|Uint8Array} payload
 * @param {{ format?: string, headers?: string[], subjectPattern?: string, subject?: string }} [options]
 * @returns {{ rows: object[], format: string, parseErrors: string[], subject?: string }}
 */
function parseNATSMessage(payload, options = {}) {
  const parseErrors = [];
  const detected = options.format
    ? { format: options.format, confidence: 'high' }
    : detectNATSFormat(payload);
  const format = detected.format;
  const { text, looksBinary } = toTextView(payload);
  const result = { rows: [], format, parseErrors };
  if (options.subject !== undefined) result.subject = options.subject;

  if (format === NATS_FORMATS.PROTOBUF_STUB) {
    if (text.trim().length === 0 && !looksBinary) {
      parseErrors.push('Empty payload.');
      return result;
    }
    result.rows = [{ raw_base64: bytesToBase64(payload) }];
    return result;
  }

  if (format === NATS_FORMATS.JSON) {
    const parsed = tryParseJSON(text.trim());
    if (!parsed.ok) {
      parseErrors.push(`JSON parse error: ${parsed.error}`);
      return result;
    }
    if (Array.isArray(parsed.value)) {
      const rows = [];
      parsed.value.forEach((item, idx) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          rows.push(item);
        } else {
          parseErrors.push(`Array element at index ${idx} is not an object; skipped.`);
        }
      });
      result.rows = rows;
    } else if (parsed.value && typeof parsed.value === 'object') {
      result.rows = [parsed.value];
    } else {
      parseErrors.push('JSON payload is neither an object nor an array of objects.');
    }
    return result;
  }

  if (format === NATS_FORMATS.NDJSON) {
    const lines = text.split('\n');
    const rows = [];
    lines.forEach((line, idx) => {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) return;
      const parsed = tryParseJSON(trimmedLine);
      if (!parsed.ok) {
        parseErrors.push(`Line ${idx + 1}: JSON parse error: ${parsed.error}`);
        return;
      }
      if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
        rows.push(parsed.value);
      } else {
        parseErrors.push(`Line ${idx + 1}: parsed value is not a JSON object; skipped.`);
      }
    });
    result.rows = rows;
    return result;
  }

  if (format === NATS_FORMATS.CSV_LINE) {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      parseErrors.push('Empty CSV payload.');
      return result;
    }
    const values = splitCSVLine(trimmed);
    const headers = options.headers && options.headers.length === values.length
      ? options.headers
      : values.map((_, idx) => `col${idx + 1}`);

    if (options.headers && options.headers.length !== values.length) {
      parseErrors.push(
        `Supplied headers length (${options.headers.length}) does not match field count (${values.length}); using generated column names.`
      );
    }

    const row = {};
    headers.forEach((h, idx) => {
      row[h] = coerceCSVValue(values[idx]);
    });
    result.rows = [row];
    return result;
  }

  parseErrors.push(`Unrecognized format: ${format}`);
  return result;
}

/**
 * Parses a batch of NATS messages (e.g. from a subscription that
 * accumulates over a batch window) into a single combined row set.
 *
 * @param {Array<{ payload: string|Uint8Array, subject?: string, timestamp?: string }>} messages
 * @param {{ format?: string, headers?: string[], subjectPattern?: string }} [options]
 * @returns {{ rows: object[], messageCount: number, parseErrors: string[], subjects: string[] }}
 */
function parseNATSBatch(messages, options = {}) {
  const rows = [];
  const parseErrors = [];
  const subjectSet = new Set();

  const list = Array.isArray(messages) ? messages : [];
  list.forEach((msg, idx) => {
    if (!msg || msg.payload === undefined || msg.payload === null) {
      parseErrors.push(`Message ${idx}: missing payload; skipped.`);
      return;
    }
    if (msg.subject) subjectSet.add(msg.subject);
    const parsed = parseNATSMessage(msg.payload, { ...options, subject: msg.subject });
    rows.push(...parsed.rows);
    parsed.parseErrors.forEach((err) => parseErrors.push(`Message ${idx}: ${err}`));
  });

  return {
    rows,
    messageCount: list.length,
    parseErrors,
    subjects: [...subjectSet],
  };
}

// ---------- schema inference ----------

function classifyValue(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'INTEGER' : 'DOUBLE';
  }
  if (typeof value === 'string') {
    if (/^-?\d+$/.test(value)) return 'INTEGER';
    if (/^-?\d*\.\d+$/.test(value)) return 'DOUBLE';
    if (value === 'true' || value === 'false') return 'BOOLEAN';
    if (!Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}/.test(value)) return 'TIMESTAMP';
    return 'VARCHAR';
  }
  return 'VARCHAR';
}

// Type-widening precedence when a column mixes types across rows: an
// integer column that later sees a double becomes DOUBLE; anything that
// mixes with a non-numeric value becomes VARCHAR.
const TYPE_RANK = { BOOLEAN: 0, INTEGER: 1, DOUBLE: 2, TIMESTAMP: 1.5, VARCHAR: 3 };

function widenType(a, b) {
  if (a === b) return a;
  if (a === 'NULL') return b;
  if (b === 'NULL') return a;
  // Mixing numeric-ish types widens toward DOUBLE; anything else widens to VARCHAR.
  const numericLike = new Set(['INTEGER', 'DOUBLE']);
  if (numericLike.has(a) && numericLike.has(b)) return 'DOUBLE';
  return TYPE_RANK[a] >= TYPE_RANK[b] ? (TYPE_RANK[a] > TYPE_RANK[b] ? a : 'VARCHAR') : 'VARCHAR';
}

/**
 * Infers a column schema from a batch of parsed rows.
 *
 * @param {object[]} rows
 * @returns {Array<{ name: string, type: 'INTEGER'|'DOUBLE'|'VARCHAR'|'BOOLEAN'|'TIMESTAMP', nullCount: number, sampleValues: any[] }>}
 */
function inferNATSSchema(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const columnNames = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columnNames.push(key);
      }
    }
  }

  return columnNames.map((name) => {
    let inferredType = 'NULL';
    let nullCount = 0;
    const sampleValues = [];

    for (const row of list) {
      const value = row ? row[name] : undefined;
      if (value === null || value === undefined || value === '') {
        nullCount++;
        continue;
      }
      const valueType = classifyValue(value);
      inferredType = widenType(inferredType, valueType);
      if (sampleValues.length < 5) sampleValues.push(value);
    }

    return {
      name,
      type: inferredType === 'NULL' ? 'VARCHAR' : inferredType,
      nullCount,
      sampleValues,
    };
  });
}

// ---------- subject wildcard filtering ----------

/**
 * Builds a subject filter predicate from a NATS wildcard pattern.
 *
 * NATS subject wildcard rules:
 *   - `*` matches exactly one token (segment between dots).
 *   - `>` matches one or more trailing tokens, and must be the last token
 *     in the pattern.
 *   - Any other token must match exactly.
 *
 * @param {string} pattern
 * @returns {(subject: string) => boolean}
 */
function buildSubjectFilter(pattern) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return () => false;
  }
  const patternTokens = pattern.split('.');

  return (subject) => {
    if (typeof subject !== 'string' || subject.length === 0) return false;
    const subjectTokens = subject.split('.');

    for (let i = 0; i < patternTokens.length; i++) {
      const pToken = patternTokens[i];

      if (pToken === '>') {
        // '>' must be the last pattern token and matches one-or-more
        // remaining tokens (so there must be at least one left).
        return i < subjectTokens.length;
      }

      if (i >= subjectTokens.length) {
        // Pattern has more tokens than the subject provides, and it wasn't
        // a trailing '>' — no match.
        return false;
      }

      if (pToken === '*') {
        continue; // matches exactly one token, any value
      }

      if (pToken !== subjectTokens[i]) {
        return false;
      }
    }

    // Every pattern token matched; subject must not have extra trailing
    // tokens (unless the pattern ended in '>', already handled above).
    return subjectTokens.length === patternTokens.length;
  };
}

// ---------- config validation ----------

/**
 * Validates a NATS connection config. Pure check — never opens a
 * connection.
 *
 * @param {{ url: string, subject: string, batchSize?: number, batchIntervalMs?: number }} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateNATSConfig(config) {
  const errors = [];
  const cfg = config || {};

  if (typeof cfg.url !== 'string' || cfg.url.trim().length === 0) {
    errors.push('url is required.');
  } else if (!/^wss?:\/\//.test(cfg.url)) {
    errors.push('url must start with ws:// or wss://.');
  }

  if (typeof cfg.subject !== 'string' || cfg.subject.trim().length === 0) {
    errors.push('subject is required and must be non-empty.');
  }

  if (cfg.batchSize !== undefined) {
    if (typeof cfg.batchSize !== 'number' || !Number.isFinite(cfg.batchSize)) {
      errors.push('batchSize must be a number.');
    } else if (cfg.batchSize < 1 || cfg.batchSize > 10000) {
      errors.push('batchSize must be between 1 and 10000.');
    }
  }

  if (cfg.batchIntervalMs !== undefined) {
    if (typeof cfg.batchIntervalMs !== 'number' || !Number.isFinite(cfg.batchIntervalMs)) {
      errors.push('batchIntervalMs must be a number.');
    } else if (cfg.batchIntervalMs < 100 || cfg.batchIntervalMs > 60000) {
      errors.push('batchIntervalMs must be between 100 and 60000.');
    }
  }

  return { valid: errors.length === 0, errors };
}

export {
  NATS_FORMATS,
  detectNATSFormat,
  parseNATSMessage,
  parseNATSBatch,
  inferNATSSchema,
  buildSubjectFilter,
  validateNATSConfig,
};
