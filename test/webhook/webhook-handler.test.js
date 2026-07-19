// ============================================================
// DATAGLOW — Validation Webhook Mode: webhook-handler test suite
// ============================================================
// Pure Node tests, no DuckDB/browser needed.
//
// RUN WITH:  node test/webhook/webhook-handler.test.js

import {
  parseWebhookPayload,
  buildValidationRequest,
  buildWebhookResponse,
  processWebhookBatch,
} from '../../js/webhook/webhook-handler.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- fixtures ----------
const validPayload = {
  batchId: 'batch_20260719_001',
  source: 'airflow_dag_claims_daily',
  arrivedAt: '2026-07-19T09:00:00Z',
  schema: [
    { name: 'claim_id', type: 'VARCHAR' },
    { name: 'amount', type: 'DOUBLE' },
  ],
  rows: [
    { claim_id: 'C001', amount: 142.50 },
    { claim_id: 'C002', amount: 89.00 },
    { claim_id: 'C003', amount: 120.00 },
    { claim_id: 'C004', amount: 75.25 },
    { claim_id: 'C005', amount: 200.00 },
  ],
};

async function main() {
  // ---------- parseWebhookPayload ----------
  {
    const result = parseWebhookPayload(validPayload);
    ok(result.valid === true, 'parseWebhookPayload: valid payload passes');
    ok(result.payload === validPayload, 'parseWebhookPayload: returns the original payload on success');
  }
  {
    const missingBatchId = { ...validPayload, batchId: undefined };
    const result = parseWebhookPayload(missingBatchId);
    ok(result.valid === false, 'parseWebhookPayload: missing batchId fails');
    ok(typeof result.error === 'string' && result.error.length > 0, 'parseWebhookPayload: missing batchId error message present');
  }
  {
    const missingRows = { ...validPayload };
    delete missingRows.rows;
    const result = parseWebhookPayload(missingRows);
    ok(result.valid === false, 'parseWebhookPayload: missing rows fails');
    ok(/rows/i.test(result.error), 'parseWebhookPayload: missing rows error mentions rows');
  }
  {
    const missingSchema = { ...validPayload };
    delete missingSchema.schema;
    const result = parseWebhookPayload(missingSchema);
    ok(result.valid === false, 'parseWebhookPayload: missing schema fails');
  }
  {
    const badSchemaField = { ...validPayload, schema: [{ name: 'claim_id' }] };
    const result = parseWebhookPayload(badSchemaField);
    ok(result.valid === false, 'parseWebhookPayload: schema entry missing type fails');
  }
  {
    const result = parseWebhookPayload(null);
    ok(result.valid === false, 'parseWebhookPayload: null body fails gracefully');
  }

  // ---------- buildValidationRequest ----------
  {
    const parsed = parseWebhookPayload(validPayload);
    const batch = buildValidationRequest(parsed.payload);
    ok(batch.columns === validPayload.schema, 'buildValidationRequest: columns mapped from schema');
    ok(batch.rows === validPayload.rows, 'buildValidationRequest: rows mapped directly');
    ok(batch.arrivedAt === validPayload.arrivedAt, 'buildValidationRequest: arrivedAt carried through');
    ok(Array.isArray(batch.columns) && batch.columns.length === 2, 'buildValidationRequest: column count correct');
  }

  // ---------- buildWebhookResponse ----------
  {
    const mockValidationResult = {
      overallStatus: 'warn',
      schemaDrift: { status: 'pass', summary: 'ok' },
      valueDrift: { status: 'warn', summary: 'drifted' },
      arrivalAnomaly: { status: 'pass', summary: 'ok' },
    };
    const response = await buildWebhookResponse('batch_abc', mockValidationResult);
    ok(response.status === 'warn', 'buildWebhookResponse: status correctly mapped from overallStatus');
    ok(response.batchId === 'batch_abc', 'buildWebhookResponse: batchId carried through');
    ok(typeof response.signature === 'string' && response.signature.length > 0, 'buildWebhookResponse: signature field present and non-empty');
    ok(response.findings.schemaDrift === mockValidationResult.schemaDrift, 'buildWebhookResponse: findings.schemaDrift mapped');
    ok(response.findings.valueDrift === mockValidationResult.valueDrift, 'buildWebhookResponse: findings.valueDrift mapped');
    ok(response.findings.arrivalAnomaly === mockValidationResult.arrivalAnomaly, 'buildWebhookResponse: findings.arrivalAnomaly mapped');
    ok(response.version === '1.0', 'buildWebhookResponse: version field present');
    ok(typeof response.receivedAt === 'string', 'buildWebhookResponse: receivedAt is a string timestamp');
  }
  {
    // Two responses with different status/batchId should have different signatures.
    const resultPass = { overallStatus: 'pass', schemaDrift: {}, valueDrift: {}, arrivalAnomaly: {} };
    const resultFail = { overallStatus: 'fail', schemaDrift: {}, valueDrift: {}, arrivalAnomaly: {} };
    const r1 = await buildWebhookResponse('batch_x', resultPass, { now: '2026-01-01T00:00:00.000Z' });
    const r2 = await buildWebhookResponse('batch_x', resultFail, { now: '2026-01-01T00:00:00.000Z' });
    ok(r1.signature !== r2.signature, 'buildWebhookResponse: signature differs when status differs');
  }

  // ---------- processWebhookBatch ----------
  {
    const result = await processWebhookBatch(validPayload, null);
    ok(!result.error, 'processWebhookBatch: 5-row batch with null baseline produces no error');
    ok(result.response && result.response.status === 'pass', 'processWebhookBatch: first-run batch resolves to pass status');
    ok(result.response.batchId === validPayload.batchId, 'processWebhookBatch: response batchId matches input');
    ok(result.newBaseline && typeof result.newBaseline.schemaFingerprint === 'string', 'processWebhookBatch: newBaseline captures column shape for next call');
    ok(typeof result.response.signature === 'string' && result.response.signature.length > 0, 'processWebhookBatch: response is signed');
  }
  {
    const badPayload = { source: 'x', schema: [], rows: [] }; // no batchId
    const result = await processWebhookBatch(badPayload, null);
    ok(!!result.error, 'processWebhookBatch: invalid payload returns { error }');
    ok(!result.response, 'processWebhookBatch: invalid payload has no response');
  }
  {
    // Second call using the newBaseline from the first call should still pass
    // (same schema, similar values) — exercises the baseline round-trip.
    const first = await processWebhookBatch(validPayload, null);
    const secondPayload = { ...validPayload, batchId: 'batch_20260719_002' };
    const second = await processWebhookBatch(secondPayload, first.newBaseline);
    ok(!second.error, 'processWebhookBatch: second batch against prior baseline produces no error');
    ok(second.response.status === 'pass' || second.response.status === 'warn', 'processWebhookBatch: second batch with consistent schema/values does not fail');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
