// ============================================================
// DATAGLOW — CI Provenance Ledger: offline verifier
// ============================================================
// Re-checks the hash chain in docs/ci-provenance-ledger.jsonl end to end. For every
// entry it (1) recomputes entry_hash from the entry's own contents and confirms it
// matches the stored value, and (2) confirms prev_hash links to the previous entry's
// entry_hash (or the genesis anchor for the first entry). Prints a clear pass/fail
// report and exits non-zero on any break so it can gate CI or a maintainer's check.
//
// FULLY OFFLINE: zero network access, zero GitHub API calls, zero npm dependencies
// (Node built-ins only). Clone the repo and run `npm run verify:ci-provenance` to
// independently confirm the ledger was not rewritten after the fact.
//
// Inputs (env):
//   LEDGER_FILE  ledger path (default docs/ci-provenance-ledger.jsonl)

import { readFileSync, existsSync } from 'node:fs';
import { computeEntryHash, GENESIS_PREV_HASH } from './ci-ledger-hash.mjs';

const ledgerFile = process.env.LEDGER_FILE || 'docs/ci-provenance-ledger.jsonl';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!existsSync(ledgerFile)) {
  console.log(`✓ no ledger file at ${ledgerFile} yet — nothing to verify (0 entries)`);
  process.exit(0);
}

const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter((l) => l.trim() !== '');

let prevEntryHash = GENESIS_PREV_HASH;
for (let i = 0; i < lines.length; i++) {
  const n = i + 1; // human-friendly 1-based entry number
  let entry;
  try {
    entry = JSON.parse(lines[i]);
  } catch (e) {
    fail(`entry ${n}: not valid JSON (${e.message})`);
  }

  const recomputed = computeEntryHash(entry);
  if (recomputed !== entry.entry_hash) {
    fail(`entry ${n} (commit ${entry.commit ?? '?'}): entry_hash mismatch — stored ${entry.entry_hash}, recomputed ${recomputed}. This entry's contents were altered after it was written.`);
  }

  if (entry.prev_hash !== prevEntryHash) {
    if (i === 0) {
      fail(`entry 1 (commit ${entry.commit ?? '?'}): prev_hash is ${entry.prev_hash}, expected genesis ${GENESIS_PREV_HASH}.`);
    }
    fail(`entry ${n} (commit ${entry.commit ?? '?'}): broken chain link — prev_hash ${entry.prev_hash} does not match entry ${n - 1}'s entry_hash ${prevEntryHash}.`);
  }

  prevEntryHash = entry.entry_hash;
}

console.log(`✓ ${lines.length} entries verified, chain intact`);
