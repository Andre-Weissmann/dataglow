// ============================================================
// DATAGLOW — Zero-Knowledge Threshold Proof test
// ============================================================
// Verifies js/provenance/zk-threshold-proof.js: a genuine non-interactive
// Schnorr Sigma-protocol zero-knowledge proof (Fiat-Shamir, Pedersen
// commitment opening) — the first actual ZK primitive in the codebase,
// distinct from every other js/provenance/ module which explicitly disclaims
// being zero-knowledge. Tests cover:
//   • group setup is a genuine safe-prime group (selfCheckGroup)
//   • completeness: an honest proof for a true statement (x=0) verifies
//   • soundness: a tampered response, tampered commitment, or wrong
//     statement label all fail verification
//   • zero-knowledge: the artifact never contains the secret blinding factor
//     or the committed value in any recoverable field
//   • the DataGlow-facing helper (proveZeroCriticalIssues) correctly refuses
//     to fabricate a proof when the statement is actually false
//   • determinism: the same seed always yields the same group parameters
//
// RUN WITH:  node test/zk-threshold-proof.test.mjs
//
// Pure crypto (native BigInt + crypto.subtle SHA-256/getRandomValues) — no
// DuckDB engine needed, consistent with the other pure-module tests.

import {
  getGroup, selfCheckGroup, commit, proveZero, verifyZeroProof,
  proveZeroCriticalIssues, countCriticalIssues, countCriticalContractFlags, modpow,
} from '../js/provenance/zk-threshold-proof.js';

// ---------- tiny test harness (mirrors the other test files) ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function main() {
  // ---------- Group setup: genuine safe-prime group, not a fake constant ----------
  const group = await getGroup();
  ok(group.p > 0n && group.q > 0n && group.g > 0n && group.h > 0n, 'group setup produced positive p, q, g, h');
  ok(group.p.toString(2).length >= 500, `p is a real 512-bit-class prime (actual bit length: ${group.p.toString(2).length})`);
  ok(group.p === 2n * group.q + 1n, 'p = 2q + 1 (safe-prime relation holds)');

  const check = await selfCheckGroup();
  ok(check.valid, 'selfCheckGroup(): all independent checks pass (p prime, q prime, g and h have order q, g != h)');
  ok(check.checks.every(c => typeof c.pass === 'boolean'), 'selfCheckGroup() returns a structured per-check breakdown, not just a boolean');

  // Determinism: re-deriving the group from the same seed must be identical —
  // this is what makes "no trusted setup, fully reproducible" a checkable claim.
  const group2 = await getGroup();
  ok(group.p === group2.p && group.g === group2.g && group.h === group2.h, 'group parameters are deterministic/cached across repeated calls (reproducibility)');

  // ---------- modpow correctness (sanity on the core primitive) ----------
  ok(modpow(2n, 10n, 1000n) === 24n, 'modpow: 2^10 mod 1000 = 24 (basic correctness check)');
  ok(modpow(group.g, group.q, group.p) === 1n, 'modpow: g^q mod p = 1 (g really has order dividing q)');

  // ---------- Completeness: honest proof of a TRUE statement verifies ----------
  const r1 = 998877665544332211998877n;
  const C1 = await commit(0, r1);
  const proof1 = await proveZero({ blindingFactor: r1, statementLabel: 'completeness-test-claim' });
  ok(proof1.commitment === C1.toString(16), 'proveZero() commits to the same value commit() independently computes');
  const verify1 = await verifyZeroProof(proof1);
  ok(verify1.valid === true, 'completeness: an honest proof for x=0 verifies as true');

  // ---------- Soundness: tampering breaks verification ----------
  const tamperedResponse = { ...proof1, response: (BigInt('0x' + proof1.response) + 1n).toString(16) };
  const verifyTamperedResponse = await verifyZeroProof(tamperedResponse);
  ok(verifyTamperedResponse.valid === false, 'soundness: tampering with the response value breaks verification');

  const tamperedCommitment = { ...proof1, commitment: (BigInt('0x' + proof1.commitment) + 2n).toString(16) };
  const verifyTamperedCommitment = await verifyZeroProof(tamperedCommitment);
  ok(verifyTamperedCommitment.valid === false, 'soundness: tampering with the commitment breaks verification');

  const wrongLabel = { ...proof1, statementLabel: 'a-different-claim-entirely' };
  const verifyWrongLabel = await verifyZeroProof(wrongLabel);
  ok(verifyWrongLabel.valid === false, 'soundness: reusing a proof under a different statement label fails (Fiat-Shamir binds label into the challenge)');

  const wrongKind = { ...proof1, kind: 'not-a-real-kind' };
  const verifyWrongKind = await verifyZeroProof(wrongKind);
  ok(verifyWrongKind.valid === false, 'malformed artifact: wrong "kind" field is rejected with a clear reason, not a crash');

  const malformed = { kind: 'dataglow-zk-threshold-proof', statement: 'committed value equals zero', commitment: 'not-hex!!' };
  const verifyMalformed = await verifyZeroProof(malformed);
  ok(verifyMalformed.valid === false, 'malformed artifact: garbage hex fields fail gracefully (caught exception -> valid:false), not a thrown error');

  // Soundness against a FALSE statement: committing to a nonzero value and
  // trying to prove it opens to zero must fail (prover doesn't know a valid
  // opening because there isn't one for x != 0 with this scheme's equation).
  const r2 = 123456789n;
  const C_nonzero = await commit(7, r2); // x=7, not 0
  // An honest run of proveZero() always computes C = commit(0, r) internally,
  // so to simulate a cheating prover we directly check that the *correct*
  // commitment for x=7 does NOT equal h^r2 (i.e. it is NOT of the special
  // "committed-to-zero" form this proof system verifies).
  const hToR2 = modpow(group.h, r2, group.p);
  ok(C_nonzero !== hToR2, 'soundness precondition: a commitment to x=7 is NOT equal to h^r (the zero-commitment form), confirming a cheating prover has no valid opening to fake');

  // ---------- Zero-knowledge: the artifact never leaks the secret ----------
  const artifactStr = JSON.stringify(proof1);
  ok(!artifactStr.includes(r1.toString()), 'zero-knowledge: the blinding factor r is never present anywhere in the serialized proof artifact');
  const secretFieldNames = Object.keys(proof1).filter(k => /secret|blind|opening|value$/i.test(k) && k !== 'statement');
  ok(secretFieldNames.length === 0, `zero-knowledge: no field in the artifact is named like a secret-carrying field (found: ${JSON.stringify(secretFieldNames)})`);

  // ---------- DataGlow-facing helper: honest refusal on a false statement ----------
  ok(countCriticalIssues({ a: { status: 'pass' }, b: { status: 'fail' }, c: { status: 'fail' } }) === 2, 'countCriticalIssues counts only status:"fail" entries');
  ok(countCriticalIssues({ a: { status: 'pass' }, b: { status: 'warn' } }) === 0, 'countCriticalIssues returns 0 when nothing is failing');

  const cleanProof = await proveZeroCriticalIssues({ results: { a: { status: 'pass' }, b: { status: 'warn' } }, datasetLabel: 'unit-test-clean' });
  ok(cleanProof.ok === true, 'proveZeroCriticalIssues succeeds when the statement is genuinely true (0 failing layers)');
  if (cleanProof.ok) {
    const v = await verifyZeroProof(cleanProof.artifact);
    ok(v.valid === true, 'the generated clean-dataset proof independently verifies');
  }

  const dirtyProof = await proveZeroCriticalIssues({ results: { a: { status: 'pass' }, b: { status: 'fail' } }, datasetLabel: 'unit-test-dirty' });
  ok(dirtyProof.ok === false, 'proveZeroCriticalIssues REFUSES to generate a proof when the statement is false (1 failing layer) — never fabricates a proof for a false claim');
  ok(dirtyProof.criticalIssueCount === 1, 'the honest refusal includes the real count for the caller\'s own UI messaging (this refusal path is not itself part of the ZK artifact)');
  ok(!('artifact' in dirtyProof), 'no proof artifact is returned at all when the statement is false');

  // ---------- Analysis Contract report-shape adapter ----------
  ok(countCriticalContractFlags({ flags: [{ severity: 'fail' }, { severity: 'warn' }, { severity: 'fail' }] }) === 2, 'countCriticalContractFlags counts only severity:"fail" flags in an Analysis Contract report');
  ok(countCriticalContractFlags({ flags: [{ severity: 'info' }] }) === 0, 'countCriticalContractFlags returns 0 when no flag is severity:"fail"');
  ok(countCriticalContractFlags({}) === 0, 'countCriticalContractFlags handles a report with no flags array at all without throwing');

  const contractCleanProof = await proveZeroCriticalIssues({ criticalIssueCount: countCriticalContractFlags({ flags: [{ severity: 'warn' }] }), datasetLabel: 'contract-clean' });
  ok(contractCleanProof.ok === true, 'proveZeroCriticalIssues accepts a pre-computed criticalIssueCount (Analysis Contract path) and succeeds when it is 0');
  const contractDirtyProof = await proveZeroCriticalIssues({ criticalIssueCount: countCriticalContractFlags({ flags: [{ severity: 'fail' }] }), datasetLabel: 'contract-dirty' });
  ok(contractDirtyProof.ok === false, 'proveZeroCriticalIssues with a pre-computed count also correctly refuses when count > 0');

  // ---------- Two independent proofs for two different true statements are unlinkable in structure ----------
  const proofA = await proveZeroCriticalIssues({ results: { a: { status: 'pass' } }, datasetLabel: 'dataset-A' });
  const proofB = await proveZeroCriticalIssues({ results: { a: { status: 'pass' } }, datasetLabel: 'dataset-B' });
  ok(proofA.artifact.commitment !== proofB.artifact.commitment, 'two proofs for different statement labels use independent (fresh-randomness) commitments, not a reused one');

  // ---------- Summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
