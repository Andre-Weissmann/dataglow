// ============================================================
// DATAGLOW - Proof Harness v0 (VERDICT): orchestration + window export
// ============================================================
// WHY THIS EXISTS
// Composes proposal.js + score-claim.js + verdict.js + receipt.js into the
// one v0 prove cycle: AI proposes (createTypedProposal) -> engine proves (a
// caller-supplied runQuery, e.g. resolveDrillSqlRunQuery / window.engine.
// runQuery / the DuckDB singleton -- this module never talks to DuckDB
// directly, so it stays pure and Node-testable) -> verdict is decided
// (decideVerdict) -> a receipt is appended (createReceiptLedger) -> the human
// confirms (confirmReceipt), digest-bound so a statement edit after confirm
// invalidates it. That is doctrine #1 in code: "AI proposes. Engines prove.
// The human confirms. In that order, always."
//
// This module owns ONE session-scoped receipt ledger instance (module-level,
// like js/drill-floor's DRILLS registry) so every Prove click in a session
// lands on the same hash chain. A fresh ledger is created per module
// evaluation, matching createTrustLedger()'s per-session lifetime.
//
// PURITY: this file itself makes no DOM or network call. runProofCycle()
// accepts an injected `runQuery` async function so it can be exercised with a
// fake in tests, exactly like drill-floor.js's runDrillSql accepts an
// injected runtime.

import { createTypedProposal, proposalMatchesDigest } from './proposal.js';
import { decideVerdict } from './verdict.js';
import { compareClaimToRun } from './score-claim.js';
import { createReceiptLedger, verifyReceiptChain, buildReceiptPredicate } from './receipt.js';

const ledger = createReceiptLedger();

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Run one full v0 prove cycle: build a typed Proposal, execute it through the
 * injected engine runner, decide a verdict, and append a receipt. Never
 * throws: an engine rejection or an invalid proposal both resolve to a
 * definite result object rather than an exception, matching the never-throw
 * discipline used across drill-floor.js and trust-ledger.js.
 *
 * @param {{claimText?:string, statement:string, engine?:string, expected?:object,
 *          tables?:string[], author?:'ai'|'human', runQuery: (sql:string) => Promise<*>}} args
 * @returns {Promise<{ok:boolean, proposal:object, run:object|null, verdict:object|null,
 *   comparison:object|null, receipt:object|null, error?:string}>}
 */
export async function runProofCycle(args) {
  const a = isPlainObject(args) ? args : {};
  const proposal = await createTypedProposal({
    statement: a.statement,
    engine: a.engine,
    expected: a.expected,
    tables: a.tables,
    author: a.author,
    claimText: a.claimText,
    modelId: a.modelId,
  });

  if (proposal.rejected) {
    return { ok: false, proposal, run: null, verdict: null, comparison: null, receipt: null, error: proposal.reason };
  }

  if (typeof a.runQuery !== 'function') {
    const verdict = decideVerdict({ claim: { text: proposal.claimText }, proposal, run: null, expected: proposal.expected });
    return { ok: true, proposal, run: null, verdict, comparison: null, receipt: await recordReceipt({ proposal, run: null, verdict }) };
  }

  const startedAt = Date.now();
  let run;
  try {
    const result = await a.runQuery(proposal.statement);
    const durationMs = Date.now() - startedAt;
    const rowCount = Array.isArray(result && result.rows) ? result.rows.length
      : (typeof (result && result.rowCount) === 'number' ? result.rowCount : null);
    run = { status: 'ok', rowCount, scalars: {}, result, durationMs, error: null };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    run = { status: 'error', rowCount: null, scalars: {}, result: null, durationMs, error: err && err.message ? err.message : String(err) };
  }

  const comparison = run.status === 'ok' ? compareClaimToRun(proposal.expected, run) : null;
  const verdict = decideVerdict({
    claim: { text: proposal.claimText },
    proposal,
    run,
    expected: proposal.expected,
    comparison,
  });

  const receipt = await recordReceipt({ proposal, run, verdict });

  return { ok: true, proposal, run, verdict, comparison, receipt };
}

async function recordReceipt({ proposal, run, verdict }) {
  const predicate = buildReceiptPredicate({
    claim: { text: proposal.claimText, predicate_ast: null, metric_ids: [] },
    proposal: {
      engine: proposal.engine,
      statement: proposal.statement,
      expected: proposal.expected,
      author: proposal.author,
      model_id: proposal.modelId,
      digest: proposal.digest,
    },
    run: run ? {
      status: run.status,
      rowcount: run.rowCount,
      scalars: run.scalars || {},
      column_types: {},
      duration_ms: run.durationMs,
      error: run.error || null,
    } : { status: null, rowcount: null, scalars: {}, column_types: {}, duration_ms: null, error: null },
    environment: { engine_build: proposal.engine, app_version: 'proof-harness-v0' },
    verdict: { state: verdict.state, reason_code: verdict.reasonCode, blocker: verdict.blocker },
  });
  return ledger.append({ subjectName: proposal.claimText || 'claim', subjectDigest: proposal.digest, predicate });
}

/**
 * Bind a human confirm to a proposal's CURRENT digest. Fails (returns
 * {confirmed:false}) if the proposal's fields no longer match the digest it
 * carries -- i.e. the statement (or engine/expected/tables) was edited after
 * this confirm was requested, so the confirm must be redone against the new
 * content. This is the "digest-bound; byte-change invalidates" requirement.
 * @param {object} proposal
 * @param {{by?:string}} opts
 */
export async function confirmProposal(proposal, opts) {
  const stillMatches = await proposalMatchesDigest(proposal);
  if (!stillMatches) {
    return { confirmed: false, reason: 'The statement changed since this proposal was digested. Re-run Prove before confirming.' };
  }
  return {
    confirmed: true,
    by: (opts && opts.by) || 'local-user',
    at: new Date().toISOString(),
    boundDigest: proposal.digest,
  };
}

/** Read-only access to this session's receipt chain. */
export function getReceipts() {
  return ledger.getEntries();
}

/** Verify the session receipt chain has not been tampered with. */
export function verifyReceipts() {
  return verifyReceiptChain(ledger.getEntries());
}

/** Clear the session receipt chain (tests / explicit reset only). */
export function resetReceipts() {
  ledger.clear();
}

export {
  createTypedProposal,
  proposalMatchesDigest,
} from './proposal.js';
export { decideVerdict, VERDICT_STATES, VERDICT_REASON_CODES } from './verdict.js';
export { compareClaimToRun, scalarMatches, extractRowCount, extractScalar } from './score-claim.js';
export { createReceiptLedger, verifyReceiptChain, buildReceiptPredicate } from './receipt.js';

const DataGlowProofHarness = {
  version: 1,
  runProofCycle,
  confirmProposal,
  createTypedProposal,
  decideVerdict,
  compareClaimToRun,
  getReceipts,
  verifyReceipts,
  resetReceipts,
};

if (typeof window !== 'undefined') {
  window.DataGlowProofHarness = DataGlowProofHarness;
}

export default DataGlowProofHarness;
