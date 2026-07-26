// ============================================================
// DATAGLOW - Proof Harness orchestration + window export
// (v0: proposal -> run -> verdict -> receipt -> confirm)
// (v1: + Second Engine Rule corroboration, AMBER staleness, Regression
//      Vault auto-capture, Proof Cartridge, Proof Inbox queue)
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
// v1 composes four more pure modules into the SAME cycle, without changing
// any v0 call's shape or default behavior:
//   - second-engine.js: if a caller injects `runSecondEngine` (or one is
//     resolvable via resolveSecondEngine()), corroborateRun() checks it
//     against the primary run and decideVerdict()'s corroboration gate can
//     pull a candidate GREEN down to RED on disagreement. No second engine
//     injected/resolvable => behavior is byte-for-byte v0 (single-engine).
//   - verdict.js: a `staleness` check (this module computes it from the
//     proposal's current digest vs. the digest a supplied prior receipt was
//     bound to) can now return AMBER. No prior receipt supplied => no
//     staleness check => v0 GREEN/RED/GRAY behavior unchanged.
//   - vault.js: every RED verdict (and every explicit rejectProposal() call)
//     is appended to the module-level Regression Vault automatically, so a
//     seeded repeat of a prior RED is caught again by runVaultCheck().
//   - inbox.js / cartridge.js: exposed as named exports + on
//     window.DataGlowProofHarness for the canvas UI to drive; this module
//     does not itself maintain inbox/vault UI state, only the vault ledger
//     (module-scoped, same lifetime rule as the receipt ledger) and pure
//     passthroughs for cartridge export/import.
//
// This module owns ONE session-scoped receipt ledger instance and ONE
// session-scoped vault instance (module-level, like js/drill-floor's DRILLS
// registry) so every Prove/Reject click in a session lands on the same
// chain/vault. Fresh instances are created per module evaluation, matching
// createTrustLedger()'s per-session lifetime.
//
// PURITY: this file itself makes no DOM call. runProofCycle() accepts an
// injected `runQuery` (and optional `runSecondEngine`) async function so it
// can be exercised with a fake in tests, exactly like drill-floor.js's
// runDrillSql accepts an injected runtime. The vault's storage may reach
// localStorage (browser only, never uploads) via vault.js's own resolver.
//
// HOTFIX (post-#622): runProofCycle's primary run always reported
// `scalars: {}` -- it never read the first result row at all, so any named
// scalar in `expected.scalars` (e.g. {n:10}) could only ever be found via
// score-claim.js's own `run.result` fallback extraction, and a second
// engine corroborating that scalar had nothing on `primary.scalars` to
// compare against (second-engine.js's corroborateRun reads
// `primary.scalars[key]`, not `primary.result`). Separately, DuckDB-WASM
// returns BigInt for COUNT/SUM-style aggregates, which fails strict
// `typeof === 'number'` checks throughout scalarMatches/valuesAgree and
// breaks JSON.stringify in receipt hashing if never coerced. See
// extractRunScalars()/coerceBigInt() below, and the matching defense-in-depth
// coercion added to second-engine.js's corroborateRun and score-claim.js's
// extractScalar.

import { createTypedProposal, proposalMatchesDigest, digestProposal } from './proposal.js';
import { decideVerdict, VERDICT_STATES, VERDICT_REASON_CODES } from './verdict.js';
import { compareClaimToRun } from './score-claim.js';
import { createReceiptLedger, verifyReceiptChain, buildReceiptPredicate } from './receipt.js';
import { corroborateRun, resolveSecondEngine, buildCorroborationField } from './second-engine.js';
import { createVault, runVault, VAULT_STORAGE_KEY } from './vault.js';
import { exportCartridgeCore, importCartridgeCore, normalizeImportArgs, parseCartridge, verifyCartridgeHash, serializeCartridge, PROOF_CARTRIDGE_TYPE } from './cartridge.js';
import { createInbox, statusLabel, INBOX_ITEM_STATUSES } from './inbox.js';

const ledger = createReceiptLedger();
const vault = createVault();

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Coerce a BigInt to a Number, passing everything else through unchanged.
 * DuckDB-WASM returns BigInt for COUNT/SUM-style integer aggregates (so the
 * value round-trips exactly through its own Arrow-backed types), but a raw
 * BigInt breaks JSON.stringify (receipt.js's ledger hashing), strict/epsilon
 * numeric comparison in score-claim.js's scalarMatches (`typeof x ===
 * 'number'` is false for a BigInt), and second-engine.js's valuesAgree the
 * same way. Coercing at the boundary, once, here (and mirrored defensively
 * in second-engine.js/score-claim.js) means every downstream consumer only
 * ever sees a plain Number.
 * @param {*} v
 */
function coerceBigInt(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/**
 * Extract a {rowCount, scalars} pair from a raw engine result, coercing any
 * BigInt to Number throughout. Mirrors score-claim.js's extractRowCount/
 * extractScalar reading discipline (object rows -> keys directly; array
 * rows + a parallel `columns` array -> map positionally by column name),
 * so a primary engine result is read exactly the same way score-claim.js
 * would read it later for comparison -- the whole point of this fix is that
 * `run.scalars` is no longer always `{}`.
 *
 * Precedence for rowCount: an explicit numeric `result.rowCount` always wins
 * over inferring length from `result.rows`, matching normalizeSecondRun's
 * existing precedence in second-engine.js (an explicit rowCount from the
 * engine is authoritative; a fake/partial rows array must never override it).
 * @param {*} result
 * @returns {{rowCount: number|null, scalars: object}}
 */
function extractRunScalars(result) {
  const scalars = {};
  if (!isPlainObject(result)) {
    return { rowCount: null, scalars };
  }

  let rowCount = null;
  if (typeof result.rowCount === 'number' || typeof result.rowCount === 'bigint') {
    rowCount = Number(coerceBigInt(result.rowCount));
  } else if (Array.isArray(result.rows)) {
    rowCount = result.rows.length;
  }

  if (Array.isArray(result.rows) && result.rows.length > 0) {
    const firstRow = result.rows[0];
    if (Array.isArray(firstRow)) {
      // Array row shape: only readable with a parallel `columns` array naming
      // each position (string column names, or {name} column-descriptor
      // objects, matching score-claim.js's extractScalar column lookup).
      if (Array.isArray(result.columns)) {
        result.columns.forEach((col, i) => {
          const name = typeof col === 'string' ? col : (col && col.name);
          if (typeof name === 'string' && i < firstRow.length) {
            scalars[name] = coerceBigInt(firstRow[i]);
          }
        });
      }
    } else if (isPlainObject(firstRow)) {
      // Object row shape: every key on the first row is a scalar.
      for (const key of Object.keys(firstRow)) {
        scalars[key] = coerceBigInt(firstRow[key]);
      }
    }
  } else if (isPlainObject(result.scalars)) {
    // A caller/engine that already supplies its own `scalars` map (e.g. the
    // canvas bridge's pyodide-duckdb/pyodide-pandas/webr paths) is still
    // coerced defensively, in case that map itself carries a raw BigInt.
    for (const key of Object.keys(result.scalars)) {
      scalars[key] = coerceBigInt(result.scalars[key]);
    }
  }

  return { rowCount, scalars };
}

/**
 * Compute a staleness check for AMBER: true when a prior receipt's bound
 * proposal digest no longer matches the CURRENT proposal's digest. Returns
 * {stale:false} when no priorReceiptDigest is supplied at all, so a caller
 * that never uses this v1 feature gets v0 behavior unchanged.
 * @param {object} proposal freshly built typed proposal (has .digest)
 * @param {string|null|undefined} priorReceiptDigest the digest a previously
 *   written receipt for this same claim was bound to, if the caller tracks one
 */
function computeStaleness(proposal, priorReceiptDigest) {
  if (typeof priorReceiptDigest !== 'string' || !priorReceiptDigest.trim()) {
    return { stale: false };
  }
  if (!isPlainObject(proposal) || typeof proposal.digest !== 'string') {
    return { stale: false };
  }
  if (proposal.digest === priorReceiptDigest) {
    return { stale: false };
  }
  return {
    stale: true,
    reason: 'This proposal no longer matches the digest its earlier receipt was bound to. Press Prove again to bind a fresh receipt.',
  };
}

/**
 * Run one full prove cycle: build a typed Proposal, execute it through the
 * injected engine runner, optionally corroborate with a second engine,
 * decide a verdict (including AMBER staleness when a prior receipt digest is
 * supplied), append a receipt, and auto-capture a RED verdict into the
 * Regression Vault. Never throws: an engine rejection or an invalid proposal
 * both resolve to a definite result object rather than an exception, matching
 * the never-throw discipline used across drill-floor.js and trust-ledger.js.
 *
 * v0 callers that never pass `runSecondEngine`/`secondEngineName`/
 * `priorReceiptDigest` see byte-for-byte v0 behavior: no corroboration field,
 * no AMBER, and this function's return shape is a strict superset of v0's
 * (adds `corroboration`, `staleness`, `vaulted`, all null/false when unused).
 *
 * @param {{claimText?:string, statement:string, engine?:string, expected?:object,
 *          tables?:string[], author?:'ai'|'human', runQuery: (sql:string) => Promise<*>,
 *          runSecondEngine?: (sql:string) => Promise<*>, secondEngineName?: string,
 *          priorReceiptDigest?: string}} args
 * @returns {Promise<{ok:boolean, proposal:object, run:object|null, verdict:object|null,
 *   comparison:object|null, receipt:object|null, corroboration:object|null,
 *   staleness:object|null, vaulted:boolean, error?:string}>}
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
    return { ok: false, proposal, run: null, verdict: null, comparison: null, receipt: null, corroboration: null, staleness: null, vaulted: false, error: proposal.reason };
  }

  const staleness = computeStaleness(proposal, a.priorReceiptDigest);

  if (staleness.stale) {
    const verdict = decideVerdict({ claim: { text: proposal.claimText }, proposal, run: null, expected: proposal.expected, staleness });
    const receipt = await recordReceipt({ proposal, run: null, verdict, corroboration: null });
    return { ok: true, proposal, run: null, verdict, comparison: null, receipt, corroboration: null, staleness, vaulted: false };
  }

  if (typeof a.runQuery !== 'function') {
    const verdict = decideVerdict({ claim: { text: proposal.claimText }, proposal, run: null, expected: proposal.expected, staleness });
    const receipt = await recordReceipt({ proposal, run: null, verdict, corroboration: null });
    return { ok: true, proposal, run: null, verdict, comparison: null, receipt, corroboration: null, staleness, vaulted: false };
  }

  const startedAt = Date.now();
  let run;
  try {
    const result = await a.runQuery(proposal.statement);
    const durationMs = Date.now() - startedAt;
    const { rowCount, scalars } = extractRunScalars(result);
    run = { status: 'ok', rowCount, scalars, result, durationMs, error: null };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    run = { status: 'error', rowCount: null, scalars: {}, result: null, durationMs, error: err && err.message ? err.message : String(err) };
  }

  const comparison = run.status === 'ok' ? compareClaimToRun(proposal.expected, run) : null;

  // Second Engine Rule (v1): only attempted for a candidate-passing run, and
  // only when the caller injected a second runner or one is resolvable.
  // Never runs for a run that already errored or already failed comparison
  // -- there is no candidate GREEN to corroborate in that case, and running
  // a second engine anyway would not change a RED into anything else.
  let corroboration = null;
  const candidateGreen = run.status === 'ok' && comparison && comparison.pass;
  if (candidateGreen) {
    const secondRunner = typeof a.runSecondEngine === 'function'
      ? { name: a.secondEngineName || 'second-engine', run: a.runSecondEngine }
      : resolveSecondEngine({});
    if (secondRunner && typeof secondRunner.run === 'function') {
      let secondRun;
      try {
        secondRun = await secondRunner.run(proposal.statement);
      } catch (err) {
        secondRun = { error: err && err.message ? err.message : String(err) };
      }
      corroboration = corroborateRun({
        primaryRun: run,
        secondRun,
        secondEngineName: secondRunner.name,
        expected: proposal.expected,
      });
    }
  }

  const verdict = decideVerdict({
    claim: { text: proposal.claimText },
    proposal,
    run,
    expected: proposal.expected,
    comparison,
    corroboration,
    staleness,
  });

  const receipt = await recordReceipt({ proposal, run, verdict, corroboration });

  let vaulted = false;
  if (verdict.state === 'RED') {
    await vault.add({
      claimText: proposal.claimText,
      statement: proposal.statement,
      expected: proposal.expected,
      source: 'red',
    });
    vaulted = true;
  }

  return { ok: true, proposal, run, verdict, comparison, receipt, corroboration, staleness, vaulted };
}

async function recordReceipt({ proposal, run, verdict, corroboration }) {
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
    corroboration: buildCorroborationField(corroboration),
    environment: { engine_build: proposal.engine, app_version: 'proof-harness-v1' },
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

/**
 * Human Reject action (v1 Proof Inbox): explicitly reject a proposal/result
 * that was never confirmed. Every rejection is itself a Regression Vault
 * event, per the spec ("every RED verdict and every human rejection...
 * appends a durable local vault test"). Never throws.
 * @param {{claimText?:string, statement:string, expected?:object}} proposal
 * @param {{reason?:string, by?:string}} [opts]
 */
export async function rejectProposal(proposal, opts) {
  const p = isPlainObject(proposal) ? proposal : {};
  const o = isPlainObject(opts) ? opts : {};
  const test = await vault.add({
    claimText: p.claimText,
    statement: p.statement,
    expected: p.expected,
    source: 'reject',
  });
  return {
    rejected: true,
    by: o.by || 'local-user',
    reason: typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : 'Rejected by reviewer.',
    at: new Date().toISOString(),
    vaultTestId: test.id,
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

/** Read-only access to this session's Regression Vault tests. */
export function getVaultTests() {
  return vault.list();
}

/** Number of stored vault tests. */
export function getVaultSize() {
  return vault.size();
}

/** Explicitly add a vault test (used by the canvas Reject action, and
 *  available directly for a caller that already has a RED result in hand). */
export async function addVaultTest(input) {
  return vault.add(input);
}

/** Re-run every stored vault test against the injected runner. */
export async function runVaultCheck(runQuery) {
  return runVault({ runQuery, tests: vault.list(), compareClaimToRun });
}

/** Clear the session Regression Vault (tests / explicit user reset only). */
export function resetVault() {
  vault.clear();
}

// ------------------------------------------------------------------------
// v1.1: Cartridge wrappers (PROOF_HARNESS_V1_1_SPEC.md pillar A)
// ------------------------------------------------------------------------
// cartridge.js stays a zero-dependency pure module (no import of
// score-claim.js), so it cannot supply its own compareClaimToRun default.
// This harness-level wrapper is the one place that CAN: it owns
// compareClaimToRun (imported above), so whenever a caller omits
// compareClaimToRun this wrapper auto-injects the harness's own scorer
// instead of falling through to cartridge.js's always-fail stub. A caller
// that already passes compareClaimToRun (e.g. the canvas Cartridge tab)
// is unaffected -- their function is used unchanged.
//
// Both wrappers accept every call shape cartridge.js's own
// normalizeImportArgs()/importCartridge() accept (object args bag,
// exportCartridge()'s whole {rejected:false, cartridge} result passed as
// cartridgeText, or the positional (cartridgeOrText, opts) convenience
// form), since window.DataGlowProofHarness.importCartridge is the ONLY
// importCartridge a live caller (canvas, tests, a future integration) ever
// sees -- the pure module's own export is not itself reassigned.

/**
 * DataGlowProofHarness.importCartridge: flexible-argument, auto-scoring
 * wrapper over cartridge.js's pure importCartridge(). See module header for
 * the exact call shapes accepted.
 * @param {object|string} args
 * @param {object} [opts]
 */
export async function importCartridgeWrapped(args, opts) {
  const normalized = normalizeImportArgs(args, opts);
  const withScorer = {
    cartridgeText: normalized.cartridgeText,
    runQuery: normalized.runQuery,
    compareClaimToRun: typeof normalized.compareClaimToRun === 'function' ? normalized.compareClaimToRun : compareClaimToRun,
  };
  return importCartridgeCore(withScorer);
}

/**
 * DataGlowProofHarness.exportCartridge: shape-compatible passthrough to
 * cartridge.js's pure exportCartridge(). Exported under its own name so a
 * future harness-level concern (e.g. auto-attaching environment metadata)
 * has a home without touching the pure module directly, matching how
 * importCartridge already needed one.
 * @param {object} args
 */
export async function exportCartridgeWrapped(args) {
  return exportCartridgeCore(args);
}

/**
 * roundTripCartridge: the full export -> import cycle in one call, for
 * tests and any live caller that wants a single "does this claim survive
 * being packaged up and re-proven" check without wiring the two halves
 * itself. Exports a cartridge from {proposal, verdict, receipt, run}, and
 * if that export succeeds, immediately imports it back against the SAME
 * `runQuery` (typically the live engine on the SAME device/session, which
 * is exactly the "re-prove on this device" acceptance gate). Auto-injects
 * this harness's own compareClaimToRun, same as importCartridgeWrapped.
 * Never throws: an export refusal is returned as-is (not re-thrown into an
 * import attempt).
 * @param {{proposal:object, verdict:object, run?:object, receipt?:object,
 *          runQuery:(sql:string)=>Promise<*>, environment?:object,
 *          schemaFingerprints?:object, compareClaimToRun?:Function}} args
 * @returns {Promise<{exported:object, imported:object|null}>}
 */
export async function roundTripCartridge(args) {
  const a = isPlainObject(args) ? args : {};
  const exported = await exportCartridgeCore({
    proposal: a.proposal,
    verdict: a.verdict,
    run: a.run,
    receipt: a.receipt,
    environment: a.environment,
    schemaFingerprints: a.schemaFingerprints,
  });
  if (exported.rejected) {
    return { exported, imported: null };
  }
  const imported = await importCartridgeWrapped({
    cartridgeText: exported,
    runQuery: a.runQuery,
    compareClaimToRun: a.compareClaimToRun,
  });
  return { exported, imported };
}

export {
  createTypedProposal,
  proposalMatchesDigest,
  digestProposal,
} from './proposal.js';
export { decideVerdict, VERDICT_STATES, VERDICT_REASON_CODES } from './verdict.js';
export { compareClaimToRun, scalarMatches, extractRowCount, extractScalar } from './score-claim.js';
export { createReceiptLedger, verifyReceiptChain, buildReceiptPredicate } from './receipt.js';
export { corroborateRun, resolveSecondEngine, normalizeSecondRun, buildCorroborationField } from './second-engine.js';
export { createVault, runVault, buildVaultTest, VAULT_STORAGE_KEY } from './vault.js';
export { normalizeImportArgs, parseCartridge, verifyCartridgeHash, serializeCartridge, PROOF_CARTRIDGE_TYPE } from './cartridge.js';
export { createInbox, buildPendingItem, itemFromCycleResult, statusLabel, INBOX_ITEM_STATUSES } from './inbox.js';
export { extractRunScalars, coerceBigInt };

const DataGlowProofHarness = {
  version: 3,
  // v0 API (unchanged shape/behavior when v1 features are not used)
  runProofCycle,
  confirmProposal,
  createTypedProposal,
  decideVerdict,
  compareClaimToRun,
  getReceipts,
  verifyReceipts,
  resetReceipts,
  // v1 additions
  rejectProposal,
  getVaultTests,
  getVaultSize,
  addVaultTest,
  runVaultCheck,
  resetVault,
  parseCartridge,
  verifyCartridgeHash,
  serializeCartridge,
  createInbox,
  statusLabel,
  resolveSecondEngine,
  VERDICT_STATES,
  // v1.1 additions/wraps (PROOF_HARNESS_V1_1_SPEC.md): importCartridge and
  // exportCartridge on THIS object are the flexible-argument, auto-scoring
  // wrappers, not the bare pure-module functions re-exported above under
  // the same names -- a caller of window.DataGlowProofHarness.importCartridge
  // gets the auto-inject-compareClaimToRun behavior; a caller that imports
  // cartridge.js directly still gets the strict pure version.
  exportCartridge: exportCartridgeWrapped,
  importCartridge: importCartridgeWrapped,
  roundTripCartridge,
};

if (typeof window !== 'undefined') {
  window.DataGlowProofHarness = DataGlowProofHarness;
}

export default DataGlowProofHarness;
