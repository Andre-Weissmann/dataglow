// ============================================================
// DATAGLOW — Gen 10 Batch 3 test
// Selective-Disclosure Provenance Proof
// ============================================================
// Verifies the Merkle-tree commitment + selective-disclosure scheme in
// js/selective-disclosure-proof.js against its real logic:
//   • builds a proof artifact for a realistic MIMIC-IV-style fixture, using the
//     existing Confidence-Calibrated Grades to derive the claim set;
//   • runs the independent verifier and asserts true claims validate;
//   • TAMPERING: mutates a disclosed claim value (grade B → A) without updating
//     its Merkle proof and asserts the verifier detects it and returns false;
//   • asserts the verifier needs ONLY the proof artifact — never the dataset.
//
// RUN WITH:  node test/selective-disclosure-proof.test.mjs
//
// Pure crypto (SHA-256 via crypto.subtle) — no DuckDB engine needed, so the
// fixture is a plain JS results map like the other pure-module tests.

import { computeCalibratedGrades } from '../js/grades/calibrated-grades.js';
import {
  generateProof, verifyProof, buildClaims, hashLeaf,
  buildMerkleTree, merkleProof, rootFromProof, SD_PROOF_KIND,
} from '../js/provenance/selective-disclosure-proof.js';

// ---------- tiny test harness (mirrors the other test files) ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A realistic MIMIC-IV-style validation results map (patient cohort). Statuses
// mirror what runAllLayers would produce for a moderately-dirty clinical
// dataset: internal-consistency layers pass, an outlier warn, a null-key fail.
function mimicFixture() {
  const results = {
    sanity_anchor: { status: 'pass' },
    unit_tests: { status: 'pass' },
    semantic_drift: { status: 'pass' },
    cross_column_logic: { status: 'pass' },
    outlier_detection: { status: 'warn' },
    categorical_consistency: { status: 'warn' },
    benford: { status: 'idle' },
    freshness: { status: 'pass' },
  };
  // Domain pack reinterpreted 1 of the 2 raised flags → plausibility rises.
  const grades = computeCalibratedGrades({
    results, packName: 'healthcare', packLabel: 'Healthcare',
    annotations: [{ layer: 'categorical_consistency' }],
  });
  return { results, grades, recordCount: 26437, table: 'mimic_admissions' };
}

async function main() {
  // ============================================================
  // (1) Merkle primitives — proof-path folding matches the tree root
  // ============================================================
  {
    const leaves = await Promise.all(
      [{ type: 't', subject: null, value: 1 }, { type: 't', subject: null, value: 2 },
       { type: 't', subject: null, value: 3 }].map(hashLeaf), // odd leaf count
    );
    const tree = await buildMerkleTree(leaves);
    let allFold = true;
    for (let i = 0; i < leaves.length; i++) {
      const derived = await rootFromProof(leaves[i], merkleProof(tree, i));
      if (derived !== tree.root) allFold = false;
    }
    ok(allFold, 'Merkle: every leaf folds back to the root via its proof path (odd leaf count handled)');

    const bogus = await rootFromProof(await hashLeaf({ type: 't', subject: null, value: 999 }), merkleProof(tree, 0));
    ok(bogus !== tree.root, 'Merkle: a non-member leaf does NOT fold to the root');
  }

  // ============================================================
  // (2) Claim extraction from the calibrated grades + results
  // ============================================================
  const { results, grades, recordCount, table } = mimicFixture();
  {
    const claims = buildClaims({ recordCount, grades, results });
    const types = new Set(claims.map(c => c.type));
    ok(types.has('record_count') && types.has('grade') && types.has('layer_status') && types.has('layers_passed'),
      'claims: record count, grades, per-layer status, and pass-count are all committed');
    const gradeClaims = claims.filter(c => c.type === 'grade');
    ok(gradeClaims.length === 2 && gradeClaims.some(c => c.subject === 'integrity') && gradeClaims.some(c => c.subject === 'plausibility'),
      'claims: both grade axes (integrity + plausibility) are present');

    // Determinism: same inputs → same leaf set → same root.
    const rootA = (await buildMerkleTree(await Promise.all(claims.map(hashLeaf)))).root;
    const claims2 = buildClaims({ recordCount, grades, results });
    const rootB = (await buildMerkleTree(await Promise.all(claims2.map(hashLeaf)))).root;
    ok(rootA === rootB && /^[0-9a-f]{64}$/.test(rootA), 'claims: commitment root is deterministic and a 64-hex SHA-256 digest');
  }

  // ============================================================
  // (3) Generate a proof artifact and verify true claims
  // ============================================================
  const artifact = await generateProof({
    recordCount, grades, results,
    dataglow: { version: '1.0.0', build: 'gen10-batch3' },
    attestationRef: { digest: 'a'.repeat(64), finalHash: 'b'.repeat(64) },
  });
  {
    ok(artifact.kind === SD_PROOF_KIND && artifact.version === 1, 'artifact: correct kind + version');
    ok(/^[0-9a-f]{64}$/.test(artifact.commitment.merkleRoot), 'artifact: publishes a SHA-256 Merkle root as the shareable fingerprint');
    ok(artifact.disclosedClaims.length === artifact.commitment.leafCount, 'artifact: discloses all claims by default (each with a proof path)');
    ok(artifact.attestationRef && artifact.attestationRef.digest === 'a'.repeat(64),
      'artifact: links back to the existing Provenance Attestation (builds on, not replaces)');
    ok(/not a formal zero-knowledge/i.test(artifact.disclaimer), 'artifact: disclaimer is honest that this is NOT a formal ZK proof');

    const res = await verifyProof(artifact);
    ok(res.valid, 'verify: an untampered proof validates');
    ok(res.claims.length === artifact.disclosedClaims.length && res.claims.every(c => c.valid),
      'verify: every disclosed claim is confirmed a member of the committed set');
  }

  // ============================================================
  // (4) Selective disclosure — reveal only a subset, still verifiable
  // ============================================================
  {
    const partial = await generateProof({
      recordCount, grades, results,
      disclose: (c) => c.type === 'grade' || c.type === 'layers_passed',
    });
    ok(partial.disclosedClaims.length < partial.commitment.leafCount,
      'selective: fewer claims disclosed than committed (undisclosed leaves stay private)');
    const res = await verifyProof(partial);
    ok(res.valid && res.claims.length === partial.disclosedClaims.length,
      'selective: the disclosed subset still verifies against the full commitment root');
  }

  // ============================================================
  // (5) TAMPERING TEST (required) — mutate a disclosed claim value
  //     WITHOUT correctly updating its Merkle proof.
  // ============================================================
  {
    const tampered = JSON.parse(JSON.stringify(artifact));
    const gradeClaim = tampered.disclosedClaims.find(c => c.type === 'grade' && c.subject === 'integrity');
    const original = gradeClaim.value;
    gradeClaim.value = original === 'A' ? 'B' : 'A'; // e.g. forge "grade: A"
    gradeClaim.statement = `Data Integrity grade was "${gradeClaim.value}".`;
    // NOTE: proof path left untouched — the forger cannot recompute it without
    // the committed sibling hashes, which the root binds.

    const res = await verifyProof(tampered);
    ok(!res.valid, 'TAMPER: verifier returns invalid when a disclosed grade is forged');
    const badClaim = res.claims.find(c => c.index === gradeClaim.index);
    ok(badClaim && !badClaim.valid, 'TAMPER: the specific forged claim is flagged as not a member of the committed set');
    ok(res.claims.filter(c => c.index !== gradeClaim.index).every(c => c.valid),
      'TAMPER: untampered claims in the same artifact still verify');
  }

  // Second tampering vector: swap the published root itself.
  {
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.commitment.merkleRoot = 'c'.repeat(64);
    const res = await verifyProof(tampered);
    ok(!res.valid, 'TAMPER: verifier returns invalid when the published root is swapped');
  }

  // ============================================================
  // (6) Verifier must NOT require the dataset (spec §4)
  //     We serialise the artifact to JSON and verify inside a scope that has
  //     no reference whatsoever to the fixture/dataset objects.
  // ============================================================
  {
    const wireJson = JSON.stringify(artifact); // only the artifact crosses the boundary
    const verifyWithoutDataset = async (json) => {
      // Inside this closure the only binding available is `json`. There is no
      // `results`, `grades`, `recordCount`, or dataset object in scope.
      const only = JSON.parse(json);
      return verifyProof(only);
    };
    const res = await verifyWithoutDataset(wireJson);
    ok(res.valid, 'independence: proof verifies from JSON alone, with no dataset argument in scope');
    ok(verifyProof.length === 1, 'independence: verifyProof takes exactly one argument (the artifact) — no dataset parameter exists');
    // The artifact must not smuggle raw rows/values from the dataset.
    ok(!/mimic_admissions|subject_id|hadm_id/.test(wireJson),
      'independence: the artifact contains no raw dataset rows/identifiers, only hashes + committed claim results');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
