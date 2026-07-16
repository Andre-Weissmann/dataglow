// Standalone independent verifier — deliberately does NOT import anything
// from selective-disclosure-proof.js, to prove the artifact is verifiable
// without trusting the issuer's own code. Re-implements the same, simple,
// documented Merkle-fold algorithm from scratch using only Node's built-in
// crypto, exactly as an external reviewer with no access to this repo's
// source would do armed only with the credential JSON and the disclaimer's
// documented construction (SHA-256, 'L:'/'N:' domain-separated leaf/node
// prefixes, canonical JSON of {type, subject, value}).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function sha256Hex(str) {
  return createHash('sha256').update(str).digest('hex');
}
function canonicalClaim(claim) {
  return JSON.stringify({ type: claim.type, subject: claim.subject ?? null, value: claim.value ?? null });
}
function hashLeaf(claim) {
  return sha256Hex('L:' + canonicalClaim(claim));
}
function hashNode(l, r) {
  return sha256Hex('N:' + l + r);
}
function rootFromProof(leafHash, path) {
  let acc = leafHash;
  for (const step of path) {
    acc = step.position === 'left' ? hashNode(step.hash, acc) : hashNode(acc, step.hash);
  }
  return acc;
}

const file = process.argv[2];
const credential = JSON.parse(readFileSync(file, 'utf8'));
let allOk = true;
for (const disclosed of credential.disclosedClaims) {
  const recomputedLeaf = hashLeaf(disclosed.claim);
  const leafMatch = recomputedLeaf === disclosed.leafHash;
  const recomputedRoot = rootFromProof(recomputedLeaf, disclosed.proof);
  const rootMatch = recomputedRoot === credential.root;
  const ok = leafMatch && rootMatch;
  allOk = allOk && ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${disclosed.claim.statement}`);
  if (!ok) {
    console.log(`  leafMatch=${leafMatch} rootMatch=${rootMatch}`);
  }
}
console.log(allOk ? '\nALL CLAIMS VERIFIED against published root.' : '\nVERIFICATION FAILED for one or more claims.');
process.exitCode = allOk ? 0 : 1;
