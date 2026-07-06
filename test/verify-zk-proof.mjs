// ============================================================
// DATAGLOW — Standalone ZK-Style Provenance Proof Verifier
// ============================================================
// Independently re-verifies a DATAGLOW "prove without revealing" proof artifact
// WITHOUT the original dataset and without running the app. It recomputes each
// disclosed claim's SHA-256 Merkle leaf, folds it up the recorded proof path,
// and confirms the result equals the published Merkle root.
//
// The only DATAGLOW code it uses is js/zk-provenance.js (+ the sha256Hex helper
// it imports from js/provenance.js), whose crypto is the built-in Web Crypto API
// (crypto.subtle) — no third-party libraries, so an auditor can read the code it
// depends on and trust the math. It NEVER touches the dataset — that is the
// entire point of the scheme.
//
// USAGE:
//   node test/verify-zk-proof.mjs path/to/dataglow-zk-proof.json
//   node test/verify-zk-proof.mjs            # run a built-in self-test
//
// Exit code 0 = verified / self-test passed; non-zero = broken or tampered.

import { readFile } from 'node:fs/promises';
import { generateProof, verifyZkProof } from '../js/zk-provenance.js';

function report(res) {
  console.log('');
  console.log(res.valid ? '✓ ZK PROOF VERIFIED' : '✗ ZK PROOF FAILED VERIFICATION');
  console.log(`  ${res.reason}`);
  console.log(`  root: ${res.root ? res.root.slice(0, 24) + '…' : '—'}`);
  for (const c of res.claims) {
    console.log(`   ${c.valid ? '✓' : '✗'} [#${c.index}] ${c.statement}`);
  }
  console.log('');
  console.log('  Note: this is a cryptographic commitment/membership check only — it does');
  console.log('  not attest the raw data was correct or PHI-compliant, and is not a legal,');
  console.log('  clinical, or regulatory determination.');
}

async function verifyFile(path) {
  let artifact;
  try {
    artifact = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    console.error(`Could not read/parse "${path}": ${e.message}`);
    process.exit(2);
  }
  const res = await verifyZkProof(artifact);
  report(res);
  process.exit(res.valid ? 0 : 1);
}

// Built-in self-test: build → verify (expect pass) → tamper → verify (expect
// fail). Confirms the verifier's math independently of the app or any dataset.
async function selfTest() {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log(`✓ ${m}`); } else { fail++; console.log(`✗ FAILED: ${m}`); } };

  const results = {
    unit_tests: { status: 'pass' },
    semantic_drift: { status: 'pass' },
    outlier_detection: { status: 'warn' },
    cross_column_logic: { status: 'pass' },
  };
  const grades = { integrity: { grade: 'B' }, plausibility: { grade: 'A' } };
  const artifact = await generateProof({ recordCount: 500, grades, results });

  const good = await verifyZkProof(artifact);
  ok(good.valid, 'self-test: freshly built proof verifies');
  ok(good.claims.every(c => c.valid), 'self-test: every disclosed claim verifies');

  const tampered = JSON.parse(JSON.stringify(artifact));
  const gradeClaim = tampered.disclosedClaims.find(c => c.type === 'grade' && c.subject === 'integrity');
  gradeClaim.value = 'A'; // was 'B' — no matching proof update
  const bad = await verifyZkProof(tampered);
  ok(!bad.valid, 'self-test: a tampered claim value is detected');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

const path = process.argv[2];
if (path) verifyFile(path);
else selfTest();
