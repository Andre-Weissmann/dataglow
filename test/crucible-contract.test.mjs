// ============================================================
// DATAGLOW — The Crucible: typed handoff contract unit tests (Batch 1)
// ============================================================
// Exercises the never-throw / validation discipline of js/validation/
// crucible-contract.js: buildCleaningResult and buildValidationVerdict return a
// safe { ok:false, errors } for malformed input and a well-formed typed object
// for valid input, and fingerprintCleaningResult reuses the provenance SHA-256
// primitive to give a CleaningResult a stable content id.
//
// RUN WITH:  node test/crucible-contract.test.mjs      (no DuckDB, no network)

import {
  buildCleaningResult,
  buildValidationVerdict,
  fingerprintCleaningResult,
  CRUCIBLE_DECISIONS,
} from '../js/validation/crucible-contract.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const validChanges = [
  { field: 'patient_name', oldValue: 'Jon Smith', newValue: 'John Smith', rule: 'nickname-normalization' },
  { field: 'dob', oldValue: null, newValue: '1980-01-01', rule: 'date-imputation' },
];

async function main() {
  // ---- buildCleaningResult: valid input ----
  {
    const r = buildCleaningResult({ changes: validChanges, confidence: 0.82, rulesCited: ['r1', 'r2'], agentId: 'cleaning-agent-1' });
    ok(r.ok === true, 'buildCleaningResult: valid input returns ok:true');
    ok(r.result.kind === 'CleaningResult', 'buildCleaningResult: result is tagged CleaningResult');
    ok(r.result.changes.length === 2, 'buildCleaningResult: preserves changes');
    ok(r.result.changes !== validChanges, 'buildCleaningResult: copies (does not alias) the changes array');
    ok(r.result.confidence === 0.82 && r.result.agentId === 'cleaning-agent-1', 'buildCleaningResult: preserves scalar fields');
  }

  // ---- buildCleaningResult: never throws on garbage ----
  {
    for (const bad of [undefined, null, 42, 'nope', []]) {
      const r = buildCleaningResult(bad);
      ok(r.ok === false && Array.isArray(r.errors) && r.errors.length > 0, `buildCleaningResult: garbage input (${JSON.stringify(bad)}) -> ok:false with errors`);
    }
  }

  // ---- buildCleaningResult: field-level validation ----
  {
    const r = buildCleaningResult({ changes: 'not-an-array', confidence: 0.5, rulesCited: ['r'], agentId: 'a' });
    ok(r.ok === false && r.errors.some(e => /changes must be an array/.test(e)), 'buildCleaningResult: non-array changes flagged');

    const r2 = buildCleaningResult({ changes: [{ field: '', oldValue: 1, newValue: 2, rule: 'x' }], confidence: 0.5, rulesCited: ['r'], agentId: 'a' });
    ok(r2.ok === false && r2.errors.some(e => /field must be a non-empty string/.test(e)), 'buildCleaningResult: empty change.field flagged');

    const r3 = buildCleaningResult({ changes: [{ field: 'f', newValue: 2, rule: 'x' }], confidence: 0.5, rulesCited: ['r'], agentId: 'a' });
    ok(r3.ok === false && r3.errors.some(e => /oldValue is required/.test(e)), 'buildCleaningResult: missing oldValue flagged (even though it may be null)');

    for (const c of [-0.1, 1.1, NaN, '0.5', undefined]) {
      const rc = buildCleaningResult({ changes: validChanges, confidence: c, rulesCited: ['r'], agentId: 'a' });
      ok(rc.ok === false && rc.errors.some(e => /confidence/.test(e)), `buildCleaningResult: out-of-range confidence ${JSON.stringify(c)} flagged`);
    }

    const r4 = buildCleaningResult({ changes: validChanges, confidence: 0.5, rulesCited: ['', 3], agentId: 'a' });
    ok(r4.ok === false && r4.errors.some(e => /rulesCited/.test(e)), 'buildCleaningResult: non-string rulesCited flagged');

    const r5 = buildCleaningResult({ changes: validChanges, confidence: 0.5, rulesCited: ['r'], agentId: '   ' });
    ok(r5.ok === false && r5.errors.some(e => /agentId/.test(e)), 'buildCleaningResult: blank agentId flagged');
  }

  // oldValue may legitimately be null — that must NOT be an error.
  {
    const r = buildCleaningResult({ changes: [{ field: 'f', oldValue: null, newValue: 'v', rule: 'x' }], confidence: 1, rulesCited: ['r'], agentId: 'a' });
    ok(r.ok === true, 'buildCleaningResult: null oldValue is accepted');
  }

  // ---- buildValidationVerdict: valid input for each decision ----
  {
    const subject = buildCleaningResult({ changes: validChanges, confidence: 0.9, rulesCited: ['r'], agentId: 'a' }).result;
    const packResults = [{ id: 'p1', label: 'P1', category: 'c', passed: true, failures: [] }];
    for (const decision of ['accept', 'reject']) {
      const v = buildValidationVerdict({ subjectResult: subject, packResults, decision });
      ok(v.ok === true && v.verdict.decision === decision, `buildValidationVerdict: ${decision} verdict returns ok:true`);
      ok(v.verdict.kind === 'ValidationVerdict', `buildValidationVerdict: ${decision} verdict is tagged`);
      ok(v.verdict.escalationReason === null, `buildValidationVerdict: ${decision} verdict has null escalationReason`);
    }
    const esc = buildValidationVerdict({ subjectResult: subject, packResults, decision: 'escalate', escalationReason: 'trust margin too thin' });
    ok(esc.ok === true && esc.verdict.escalationReason === 'trust margin too thin', 'buildValidationVerdict: escalate with reason returns ok:true');
  }

  // ---- buildValidationVerdict: validation + never-throw ----
  {
    for (const bad of [undefined, null, 7, 'x', []]) {
      const v = buildValidationVerdict(bad);
      ok(v.ok === false && v.errors.length > 0, `buildValidationVerdict: garbage input (${JSON.stringify(bad)}) -> ok:false`);
    }
    const subject = { kind: 'CleaningResult' };
    const v1 = buildValidationVerdict({ subjectResult: subject, packResults: [{ id: 'p', passed: true }], decision: 'maybe' });
    ok(v1.ok === false && v1.errors.some(e => /decision must be one of/.test(e)), 'buildValidationVerdict: bad decision flagged');

    const v2 = buildValidationVerdict({ subjectResult: subject, packResults: [{ id: 'p', passed: true }], decision: 'escalate' });
    ok(v2.ok === false && v2.errors.some(e => /escalationReason/.test(e)), 'buildValidationVerdict: escalate without reason flagged');

    const v3 = buildValidationVerdict({ subjectResult: subject, packResults: 'nope', decision: 'accept' });
    ok(v3.ok === false && v3.errors.some(e => /packResults must be an array/.test(e)), 'buildValidationVerdict: non-array packResults flagged');

    const v4 = buildValidationVerdict({ subjectResult: subject, packResults: [{ id: '', passed: 'yes' }], decision: 'accept' });
    ok(v4.ok === false && v4.errors.some(e => /packResults\[0\]/.test(e)), 'buildValidationVerdict: malformed packResults entry flagged with index');

    const v5 = buildValidationVerdict({ subjectResult: 'not-an-object', packResults: [], decision: 'accept' });
    ok(v5.ok === false && v5.errors.some(e => /subjectResult/.test(e)), 'buildValidationVerdict: non-object subjectResult flagged');
  }

  ok(Array.isArray(CRUCIBLE_DECISIONS) && CRUCIBLE_DECISIONS.join(',') === 'accept,reject,escalate', 'CRUCIBLE_DECISIONS exports the three decisions');

  // ---- fingerprintCleaningResult: stable, content-addressed, reuses SHA-256 ----
  {
    const a = buildCleaningResult({ changes: validChanges, confidence: 0.5, rulesCited: ['r'], agentId: 'a' }).result;
    const b = buildCleaningResult({ changes: validChanges, confidence: 0.5, rulesCited: ['r'], agentId: 'a' }).result;
    const h1 = await fingerprintCleaningResult(a);
    const h2 = await fingerprintCleaningResult(b);
    ok(/^[0-9a-f]{64}$/.test(h1), 'fingerprintCleaningResult: returns a 64-hex SHA-256');
    ok(h1 === h2, 'fingerprintCleaningResult: identical results hash identically');

    const c = buildCleaningResult({ changes: validChanges, confidence: 0.6, rulesCited: ['r'], agentId: 'a' }).result;
    const h3 = await fingerprintCleaningResult(c);
    ok(h3 !== h1, 'fingerprintCleaningResult: a changed field yields a different hash');

    const empty = await fingerprintCleaningResult('not-an-object');
    ok(empty === '', 'fingerprintCleaningResult: non-object input returns empty string (never throws)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
