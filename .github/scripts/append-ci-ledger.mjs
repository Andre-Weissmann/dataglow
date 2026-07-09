// ============================================================
// DATAGLOW — CI Provenance Ledger: appender
// ============================================================
// Appends ONE hash-linked entry to docs/ci-provenance-ledger.jsonl for a CI run on
// `main`. The file is append-only (JSON Lines, one entry per line) — this script only
// ever reads the last line and appends a new one; it never rewrites existing lines.
//
// Each entry records the facts of one main CI run and links to the previous entry via
// `prev_hash`, forming a tamper-evident chain that anyone can re-check offline with
// .github/scripts/verify-ci-provenance.mjs (`npm run verify:ci-provenance`).
//
// This is DIAGNOSIS/RECORDING ONLY — it takes no corrective action and never edits app
// code. Zero external dependencies; Node built-ins only.
//
// Inputs (env, all optional except the two CI facts):
//   LEDGER_COMMIT           commit SHA the CI run executed against (required)
//   LEDGER_TEST_CONCLUSION  conclusion of the main test job, e.g. success/failure (required)
//   LEDGER_SBOM_PATH        path to the SBOM to hash (default docs/sbom.json)
//   LEDGER_FILE             ledger path (default docs/ci-provenance-ledger.jsonl)
//   LEDGER_TIMESTAMP        ISO 8601 UTC override (default: now) — used only for tests

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { sha256, computeEntryHash, GENESIS_PREV_HASH } from './ci-ledger-hash.mjs';

const commit = process.env.LEDGER_COMMIT;
const testConclusion = process.env.LEDGER_TEST_CONCLUSION;
const sbomPath = process.env.LEDGER_SBOM_PATH || 'docs/sbom.json';
const ledgerFile = process.env.LEDGER_FILE || 'docs/ci-provenance-ledger.jsonl';

if (!commit) {
  console.error('append-ci-ledger: LEDGER_COMMIT is required');
  process.exit(1);
}
if (!testConclusion) {
  console.error('append-ci-ledger: LEDGER_TEST_CONCLUSION is required');
  process.exit(1);
}
if (!existsSync(sbomPath)) {
  console.error(`append-ci-ledger: SBOM not found at ${sbomPath} — generate it (npm run sbom) before appending`);
  process.exit(1);
}

const sbomHash = sha256(readFileSync(sbomPath));
const timestamp = process.env.LEDGER_TIMESTAMP || new Date().toISOString();

// prev_hash points at the previous entry's entry_hash, or the genesis anchor if this
// is the first entry. Read only the last non-empty line to avoid parsing the whole file.
let prevHash = GENESIS_PREV_HASH;
if (existsSync(ledgerFile)) {
  const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length > 0) {
    const last = JSON.parse(lines[lines.length - 1]);
    prevHash = last.entry_hash;
  }
}

const entry = {
  commit,
  timestamp,
  test_conclusion: testConclusion,
  sbom_hash: sbomHash,
  prev_hash: prevHash,
};
entry.entry_hash = computeEntryHash(entry);

appendFileSync(ledgerFile, JSON.stringify(entry) + '\n');
console.log(`append-ci-ledger: appended entry for ${commit} (test_conclusion=${testConclusion})`);
console.log(`  sbom_hash=${sbomHash}`);
console.log(`  prev_hash=${prevHash}`);
console.log(`  entry_hash=${entry.entry_hash}`);
