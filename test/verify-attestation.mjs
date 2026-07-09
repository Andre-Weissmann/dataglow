// ============================================================
// DATAGLOW — Standalone Provenance Attestation Verifier
// ============================================================
// Independently re-verifies a DATAGLOW provenance attestation JSON file WITHOUT
// running the app or any query engine. It recomputes the SHA-256 hash chain
// from scratch and recomputes the document digest, then reports whether the
// recorded chain of custody is intact and unmodified.
//
// The only DATAGLOW code it uses is js/provenance.js, whose crypto is the
// built-in Web Crypto API (crypto.subtle) — no third-party libraries, so an
// auditor can read the ~200 lines it depends on and trust the math.
//
// USAGE:
//   node test/verify-attestation.mjs path/to/dataglow-attestation.json
//   node test/verify-attestation.mjs            # run a built-in self-test
//
// Exit code 0 = verified / self-test passed; non-zero = broken or tampered.

import { readFile } from 'node:fs/promises';
import {
  createProvenanceChain, verifyAttestation, verifyChainArray, computeAttestationDigest,
} from '../js/provenance/provenance.js';

function report(res) {
  console.log('');
  console.log(res.valid ? '✓ ATTESTATION VERIFIED' : '✗ ATTESTATION FAILED VERIFICATION');
  console.log(`  ${res.reason}`);
  if (res.chain) console.log(`  chain: ${res.chain.valid ? 'intact' : `broken at step ${res.chain.brokenAt}`}`);
  if (res.digest) console.log(`  digest: ${res.digest.valid ? 'matches content' : 'MISMATCH'}`);
  if (res.digest && !res.digest.valid) {
    console.log(`    stored:     ${res.digest.stored}`);
    console.log(`    recomputed: ${res.digest.recomputed}`);
  }
  console.log('');
  console.log('  Note: this is a cryptographic integrity check only — not a notarization,');
  console.log('  and not a legal, clinical, or regulatory determination.');
}

async function verifyFile(path) {
  let att;
  try {
    att = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    console.error(`Could not read/parse "${path}": ${e.message}`);
    process.exit(2);
  }
  const res = await verifyAttestation(att);
  report(res);
  process.exit(res.valid ? 0 : 1);
}

// Built-in self-test: build → verify (expect pass) → tamper → verify (expect
// fail). Confirms the verifier's math independently of the app.
async function selfTest() {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log(`✓ ${m}`); } else { fail++; console.log(`✗ FAILED: ${m}`); } };

  const chain = createProvenanceChain();
  await chain.append('load', 'Loaded raw CSV', null, 'f'.repeat(64));
  await chain.append('clean', 'Normalized column names');
  await chain.append('query', 'Grouped by region');
  const att = await chain.attest({ table: 'demo', rowCount: 500, columns: [{ name: 'region', type: 'VARCHAR' }] });

  const good = await verifyAttestation(att);
  ok(good.valid, 'self-test: freshly built attestation verifies');

  const chainOnly = await verifyChainArray(att.chain.steps);
  ok(chainOnly.valid, 'self-test: independent hash-chain recomputation is intact');

  const recomputed = await computeAttestationDigest(att);
  ok(recomputed === att.digest.value, 'self-test: digest recomputes to the stored value');

  const tampered = JSON.parse(JSON.stringify(att));
  tampered.chain.steps[1].description = 'falsified';
  const bad = await verifyAttestation(tampered);
  ok(!bad.valid && bad.chain.brokenAt === 1, 'self-test: a tampered step is detected');

  const tampered2 = JSON.parse(JSON.stringify(att));
  tampered2.dataset.rowCount = 1;
  const bad2 = await verifyAttestation(tampered2);
  ok(!bad2.valid && !bad2.digest.valid, 'self-test: tampered metadata breaks the digest');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

const path = process.argv[2];
if (path) verifyFile(path);
else selfTest();
