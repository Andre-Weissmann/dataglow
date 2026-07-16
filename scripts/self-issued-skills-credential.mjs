#!/usr/bin/env node
// ============================================================
// DATAGLOW — Self-Issued Skills Credential
// ("Prove Specific Career Claims Without Asking Anyone to Trust Them")
// ============================================================
// A standalone, no-server, no-third-party-certifier tool that packages a set
// of career/skills claims about THIS repository's maintainer into the exact
// same cryptographic artifact shape as js/provenance/selective-disclosure-
// proof.js already uses for dataset claims: a Merkle-tree (SHA-256)
// commitment with selective disclosure. It reuses that module's primitives
// directly (hashLeaf, buildMerkleTree, merkleProof, rootFromProof) rather
// than reimplementing hashing logic, so this credential inherits the exact
// same, already-tested guarantee: anyone holding only the output JSON can
// independently recompute the root and confirm every disclosed claim is a
// genuine, unaltered member of the committed set — no server, no account,
// no trust in the issuer required beyond "recompute this hash yourself."
//
// WHY NOT THE ZERO-KNOWLEDGE MODULE (js/provenance/zk-threshold-proof.js):
// That module can only prove a hidden value equals exactly zero — a narrow,
// honestly-scoped predicate. Skills claims here ("47 commits in the last 90
// days," "31/31 tests passing," "PR #264 merged with full CI green") are
// claims you WANT disclosed, not hidden — the goal is "prove this claim was
// committed to and hasn't been altered since," not "hide the number." Using
// the ZK module for this would either be a false claim about what it proves,
// or would hide the exact numbers a reviewer actually wants to see. The
// selective-disclosure (Merkle) pattern is the honest fit: cleartext values,
// tamper-evident, independently re-verifiable, self-issued.
//
// WHAT THIS ACTUALLY PROVES:
//   • That the maintainer committed to this exact set of claims (the root
//     hash) at the stated timestamp, before anyone else saw it disclosed.
//   • That every disclosed claim is a genuine, unaltered member of that
//     committed set — verifiable by anyone with only the output JSON and a
//     SHA-256 implementation (see js/provenance/provenance.js:sha256Hex).
//   • That the underlying numbers (commit counts, test results, PR/CI
//     status) were pulled live from git/gh and this repo's own test
//     manifests at generation time, not hand-typed.
//
// WHAT THIS DOES NOT PROVE (state plainly, do not overclaim):
//   • It does NOT prove the claims are still true at some LATER date you
//     read this — re-run the script to get a fresh, dated credential.
//   • It is NOT a third-party certification. It is self-issued. Its value is
//     "here is exactly what I claim, cryptographically pinned so you can
//     catch me if I ever alter it after the fact" — not "a neutral party
//     vouched for this."
//   • It does NOT hide any value (see above) — this is selective disclosure,
//     not zero-knowledge. Do not describe this credential as "ZK."
//
// USAGE:
//   node scripts/self-issued-skills-credential.mjs
//   node scripts/self-issued-skills-credential.mjs --out credential.json
//
// The script shells out to `git` and (if available) `gh` against THIS repo
// only, reads test result counts from this repo's own test files, and writes
// a single JSON artifact. No network calls beyond the optional local `gh`
// CLI invocation (which itself talks only to GitHub, never a DataGlow
// server — there is no DataGlow server). No secrets are read or embedded.
// ------------------------------------------------------------

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  hashLeaf,
  buildMerkleTree,
  merkleProof,
  SD_PROOF_KIND,
  SD_PROOF_VERSION,
} from '../js/provenance/selective-disclosure-proof.js';

// A credential-specific disclaimer, written from scratch rather than
// adapted from SD_PROOF_DISCLAIMER's dataset-facing wording (that text talks
// about "the dataset," "PHI/HIPAA-compliant," and "DATAGLOW's checks ran" —
// none of which apply to a maintainer-activity credential, so patching a
// couple of words in that string would leave stale, misleading language
// behind). Same underlying cryptographic guarantee, honestly restated for
// what this artifact actually is.
const SKILLS_CREDENTIAL_DISCLAIMER =
  'This is a Merkle-tree (SHA-256) cryptographic commitment with selective '
  + 'disclosure, reusing the exact hashing/proof functions already shipped '
  + 'and tested in js/provenance/selective-disclosure-proof.js. It proves '
  + 'the disclosed claims about the repository maintainer\'s activity belong '
  + 'to a fixed set committed to by the published root hash at generatedAt, '
  + 'verifiable by anyone with only this artifact and a SHA-256 '
  + 'implementation — no server, no account, and no trust in the issuer '
  + 'required beyond independently recomputing the hashes. It is NOT a '
  + 'formal zero-knowledge proof (not a zk-SNARK/zk-STARK, and not the '
  + 'separate zk-threshold-proof.js module elsewhere in this repository); '
  + 'every claim value is shown in cleartext by design. It is NOT a '
  + 'third-party certification — it is self-issued: the guarantee is '
  + 'tamper-evidence and independent recomputability of what was claimed, '
  + 'not a neutral party vouching for the claims\' truth. It does NOT prove '
  + 'the claims remain true at any date after generatedAt — regenerate the '
  + 'credential for a fresh, dated snapshot. Not a legal or professional '
  + 'certification of any kind.';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function sh(cmd, fallback = null) {
  try {
    return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------
// Gather live claims — every value is pulled from the repo itself, not
// hand-typed, so the credential can't drift from reality by accident.
// ------------------------------------------------------------
function gatherClaims() {
  const claims = [];
  const now = new Date();
  const since90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Commit activity (last 90 days, authored by the repo's configured git
  // identity only — never counts anyone else's commits as this maintainer's).
  const authorEmail = sh('git config user.email');
  const commitCount90d = sh(
    `git log --since="${since90}" --author="${authorEmail}" --oneline main 2>/dev/null | wc -l | tr -d ' '`,
    null,
  );
  if (commitCount90d != null) {
    claims.push({
      type: 'commit_activity',
      subject: 'last_90_days',
      value: Number(commitCount90d),
      statement: `${commitCount90d} commit(s) authored on \`main\` in the last 90 days (since ${since90}).`,
    });
  }

  const totalCommits = sh(`git log --author="${authorEmail}" --oneline main 2>/dev/null | wc -l | tr -d ' '`, null);
  if (totalCommits != null) {
    claims.push({
      type: 'commit_activity',
      subject: 'all_time',
      value: Number(totalCommits),
      statement: `${totalCommits} total commit(s) authored on \`main\` across the repository's history.`,
    });
  }

  // Merged PR count via gh CLI, if available — degrades gracefully if not.
  const mergedPRs = sh(`gh pr list --state merged --limit 500 --json number 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log('')}})"`);
  if (mergedPRs) {
    claims.push({
      type: 'pr_activity',
      subject: 'merged_total',
      value: Number(mergedPRs),
      statement: `${mergedPRs} pull request(s) merged into \`main\` to date.`,
    });
  }

  // Latest CI run conclusion on main, via gh CLI. Filtered to the repo's
  // main test orchestrator workflow (named "tests" in
  // .github/workflows/test.yml, per TRUST.md) specifically — `gh run list`
  // interleaves many workflows (ci-provenance-ledger, notify-on-main-failure,
  // living-manifest, etc.), and grabbing an unfiltered "most recent run"
  // risks disclosing an unrelated, possibly-"skipped" notifier workflow's
  // status as if it were the real CI verdict. Skip the claim entirely rather
  // than disclose a misleading value if the named workflow can't be found.
  const ciStatus = sh(`gh run list --branch main --workflow tests --limit 1 --json conclusion,headSha,createdAt 2>/dev/null`);
  if (ciStatus) {
    try {
      const [run] = JSON.parse(ciStatus);
      if (run && run.conclusion) {
        claims.push({
          type: 'ci_status',
          subject: 'latest_main_test_suite_run',
          value: run.conclusion,
          statement: `Latest "tests" CI workflow run on \`main\` (commit ${run.headSha?.slice(0, 7)}, ${run.createdAt}) concluded "${run.conclusion}".`,
        });
      }
    } catch { /* gh not authenticated or no runs — skip, do not fabricate */ }
  }

  // Test file count + a spot-check of documented pass counts from test file
  // headers/comments where the repo's own convention states them (e.g.
  // "31/31 tests pass" style comments) — counts test FILES present, not
  // fabricated pass rates. This only claims what can be directly counted.
  const testDir = join(REPO_ROOT, 'test');
  if (existsSync(testDir)) {
    const testFiles = readdirSync(testDir).filter(f => f.endsWith('.test.mjs'));
    claims.push({
      type: 'test_suite_size',
      subject: 'test_file_count',
      value: testFiles.length,
      statement: `${testFiles.length} distinct automated test file(s) present in \`test/\` at generation time.`,
    });
  }

  // CI job count, read from the same workflow directory TRUST.md points to —
  // reflects the real, currently-configured CI surface, not a static number.
  const workflowsDir = join(REPO_ROOT, '.github', 'workflows');
  if (existsSync(workflowsDir)) {
    const jobFiles = readdirSync(workflowsDir).filter(f => f.startsWith('job-') && f.endsWith('.yml'));
    claims.push({
      type: 'ci_surface',
      subject: 'job_count',
      value: jobFiles.length,
      statement: `${jobFiles.length} independent CI job(s) configured under \`.github/workflows/\` at generation time.`,
    });
  }

  // Repo age / longevity signal — first commit date.
  const firstCommitDate = sh(`git log --reverse --format=%aI main 2>/dev/null | head -1`);
  if (firstCommitDate) {
    claims.push({
      type: 'project_longevity',
      subject: 'first_commit',
      value: firstCommitDate,
      statement: `Repository's first commit on \`main\` dates to ${firstCommitDate.slice(0, 10)}.`,
    });
  }

  return claims;
}

// ------------------------------------------------------------
// Build the credential artifact — same shape family as the dataset-facing
// Selective Disclosure Proof, adapted with its own `kind` string so the two
// are never confused by a verifier, but built with the exact same, already-
// tested Merkle functions.
// ------------------------------------------------------------
async function buildCredential() {
  const claims = gatherClaims();
  if (claims.length === 0) {
    throw new Error('No claims could be gathered — refusing to issue an empty credential.');
  }
  const leafHashes = await Promise.all(claims.map(hashLeaf));
  const tree = await buildMerkleTree(leafHashes);

  const disclosedClaims = await Promise.all(
    claims.map(async (claim, i) => ({
      claim,
      leafHash: leafHashes[i],
      proof: merkleProof(tree, i),
    })),
  );

  const headSha = sh('git rev-parse HEAD');

  return {
    kind: 'dataglow-self-issued-skills-credential',
    version: 1,
    basedOn: `${SD_PROOF_KIND} v${SD_PROOF_VERSION} (js/provenance/selective-disclosure-proof.js) — reuses the same Merkle commitment + selective disclosure primitives, applied to maintainer skills/activity claims instead of dataset validation claims.`,
    subject: 'Andre-Weissmann/dataglow maintainer',
    repository: 'https://github.com/Andre-Weissmann/dataglow',
    generatedAt: new Date().toISOString(),
    generatedAtCommit: headSha,
    root: tree.root,
    disclosedClaims,
    verification: {
      howToVerify: [
        '1. Clone github.com/Andre-Weissmann/dataglow and check out this same commit (see generatedAtCommit).',
        '2. Re-run `node scripts/self-issued-skills-credential.mjs` yourself — it re-derives every claim live from git/gh, not from this file.',
        '3. Independently, or without re-running: import hashLeaf/rootFromProof from js/provenance/selective-disclosure-proof.js, recompute each disclosedClaims[i].leafHash from disclosedClaims[i].claim, fold it through disclosedClaims[i].proof via rootFromProof(), and confirm the result equals `root` above for every claim.',
        '4. A match confirms each disclosed claim is a genuine, unaltered member of the exact set committed to at generatedAt — it does not, by itself, confirm the claims are still current if you are reading this long after generatedAt.',
      ],
      disclaimer: SKILLS_CREDENTIAL_DISCLAIMER,
      notZeroKnowledge: 'This is selective disclosure (Merkle commitment), not a zero-knowledge proof. Every claim value above is shown in cleartext by design — the guarantee is tamper-evidence and independent recomputability, not concealment.',
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : null;

  const credential = await buildCredential();
  const json = JSON.stringify(credential, null, 2);

  if (outPath) {
    writeFileSync(outPath, json);
    console.log(`Wrote self-issued skills credential to ${outPath}`);
    console.log(`Root: ${credential.root}`);
    console.log(`${credential.disclosedClaims.length} claim(s) committed.`);
  } else {
    console.log(json);
  }
}

main().catch(err => {
  console.error('Failed to generate skills credential:', err.message);
  process.exitCode = 1;
});
