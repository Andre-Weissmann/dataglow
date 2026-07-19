// ============================================================
// DATAGLOW — Validation Webhook Mode: webhook handler
// ============================================================
// Pure JavaScript module that parses an incoming webhook payload, routes it
// through the streaming validator, and builds a signed pass/fail/warn
// response. This module RECEIVES data handed to it by a caller (a Service
// Worker fetch handler in the browser PWA, or a native HTTP server in the
// future Tauri desktop path) — it never initiates a network request itself,
// and it never touches localStorage/IndexedDB. Baseline state is passed in
// and returned, not persisted here, so the caller controls storage.
//
// See docs/webhook-mode.md for the end-to-end usage guide (curl example,
// Airflow integration pattern, security notes).

import { runStreamingValidation } from '../streaming/streaming-validator.js';

/**
 * parseWebhookPayload(body)
 *
 * Validates the raw (already-JSON-parsed) request body against the expected
 * webhook shape:
 *   { batchId, source, arrivedAt, schema: [{name, type}], rows: [...] }
 *
 * Returns { valid: true, payload } on success, or
 * { valid: false, error: string } describing the first problem found.
 */
function parseWebhookPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Payload must be a JSON object.' };
  }

  const { batchId, schema, rows } = body;

  if (batchId === undefined || batchId === null || String(batchId).trim() === '') {
    return { valid: false, error: 'Missing required field: batchId.' };
  }

  if (!Array.isArray(schema)) {
    return { valid: false, error: 'Missing or invalid field: schema (expected an array).' };
  }
  for (let i = 0; i < schema.length; i++) {
    const col = schema[i];
    if (!col || typeof col !== 'object' || typeof col.name !== 'string' || col.name.trim() === '') {
      return { valid: false, error: `schema[${i}] is missing a valid "name" field.` };
    }
    if (typeof col.type !== 'string' || col.type.trim() === '') {
      return { valid: false, error: `schema[${i}] is missing a valid "type" field.` };
    }
  }

  if (!Array.isArray(rows)) {
    return { valid: false, error: 'Missing or invalid field: rows (expected an array).' };
  }

  return { valid: true, payload: body };
}

/**
 * buildValidationRequest(payload)
 *
 * Converts a parsed webhook payload into the batch shape expected by
 * runStreamingValidation(): { columns, rows, arrivedAt }.
 */
function buildValidationRequest(payload) {
  const safe = payload || {};
  return {
    columns: Array.isArray(safe.schema) ? safe.schema : [],
    rows: Array.isArray(safe.rows) ? safe.rows : [],
    arrivedAt: safe.arrivedAt,
  };
}

// ---------- signing ----------

// djb2 — simple, deterministic, dependency-free string hash used as a
// fallback signature source in Node test environments (or any runtime
// without globalThis.crypto.subtle). NOT cryptographically secure; this is a
// tamper-evidence signal for a localhost-only endpoint, not a security
// boundary against a hostile network (see docs/webhook-mode.md).
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + c
  }
  // Convert to an unsigned 32-bit hex string so it reads like a compact digest.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function sha256OrFallback(message) {
  const cryptoObj = globalThis && globalThis.crypto;
  if (cryptoObj && cryptoObj.subtle && typeof cryptoObj.subtle.digest === 'function') {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(message);
      const digest = await cryptoObj.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fall through to djb2 if subtle.digest is unavailable/unsupported for
      // this input in the current environment.
      return djb2Hash(message);
    }
  }
  return djb2Hash(message);
}

/**
 * buildWebhookResponse(batchId, validationResult, options = {})
 *
 * Builds the signed webhook response object returned to the caller (pipeline
 * engineer's Airflow task, Kafka consumer, etc). Async because signing may
 * use the async Web Crypto API.
 */
async function buildWebhookResponse(batchId, validationResult, options = {}) {
  const result = validationResult || {};
  const receivedAt = (options && options.now) || new Date().toISOString();

  const response = {
    batchId,
    receivedAt,
    status: result.overallStatus,
    findings: {
      schemaDrift: result.schemaDrift,
      valueDrift: result.valueDrift,
      arrivalAnomaly: result.arrivalAnomaly,
    },
    version: '1.0',
  };

  const signaturePayload = JSON.stringify({ batchId, status: response.status, receivedAt });
  response.signature = await sha256OrFallback(signaturePayload);

  return response;
}

/**
 * processWebhookBatch(body, baseline, options = {})
 *
 * Full webhook pipeline: parse -> build validation request -> run streaming
 * validation -> build signed response.
 *
 * Returns Promise<{ response, newBaseline }> on success, or
 * Promise<{ error }> if the payload fails to parse.
 */
async function processWebhookBatch(body, baseline, options = {}) {
  const parsed = parseWebhookPayload(body);
  if (!parsed.valid) {
    return { error: parsed.error };
  }

  const batch = buildValidationRequest(parsed.payload);
  const validationResult = runStreamingValidation(batch, baseline);
  const response = await buildWebhookResponse(parsed.payload.batchId, validationResult, options);

  return { response, newBaseline: validationResult.newBaseline };
}

export {
  parseWebhookPayload,
  buildValidationRequest,
  buildWebhookResponse,
  processWebhookBatch,
};
