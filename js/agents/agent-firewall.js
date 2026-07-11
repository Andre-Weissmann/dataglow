// ============================================================
// DATAGLOW — Agent Action Firewall (DataGlow Passport, Batch A)
// ============================================================
// DATAGLOW's hard safety rule has always been: never let an LLM/AI or an
// autonomous agent modify, clean, or delete the loaded dataset without an
// explicit per-action confirmation. Until now that was an implicit convention
// scattered across call sites. This module makes it a first-class, auditable,
// hard-enforced capability — the policy spine every agent-originated action
// against the user's data must pass through.
//
// It was reinforced by the April 2026 incident where a coding-agent deleted a
// company's production database AND its backups with no confirmation gate: a
// destructive action must be classified, gated, logged, and reversible.
//
// DESIGN (mirrors the existing module boundaries):
//   • Pure policy: evaluateAction({kind, source, payload}) is a pure function —
//     no DOM, no network, no side effects — returning a decision + reason.
//   • Auditable: recordAction(...) appends to a hash-chained action log using
//     the SAME hashing helper as js/provenance/provenance.js (sha256Hex +
//     GENESIS_PARENT). It does not reinvent hashing.
//   • Reversible: before a confirm-required destructive action is applied, a
//     lightweight snapshot is captured via js/simulation/time-machine.js
//     (buildSnapshot / contentHash / summarizeDiffFromPrevious — reused, not
//     duplicated) so undoLastAgentAction() can hand the caller enough to undo.
//
// ZERO NETWORK: this module names no network primitive, so it passes the same
// static source scan (js/packs/pack-network-guard.js scanSourceForNetwork) that
// domain packs must pass — enforced by a source guard in the test suite.

import { sha256Hex, GENESIS_PARENT } from '../provenance/provenance.js';
import { buildSnapshot, contentHash, summarizeDiffFromPrevious } from '../simulation/time-machine.js';

// ------------------------------------------------------------
// Action kinds — grounded in what an agent can realistically already trigger
// in this codebase, NOT invented:
//   read          — inspect schema/rows (engine.getTableSchema/getRowCount).
//   run-query      — engine.runQuery(sql). SELECT-class is read-only, but the
//                    same entry point also runs DELETE/UPDATE/CREATE (clean.js
//                    applyFix uses it), so run-query is refined by payload.sql.
//   suggest-edit   — produce a preview/suggestion only (clean.js scanForIssues,
//                    the pack builder's confirmed-answer flow). A suggestion is
//                    not an application, so it is read-only until applied.
//   apply-edit     — engine.runQuery(UPDATE ...) (clean.js fill_zero/fill_mean/
//                    fill_mode/trim/abs_value/null_out): mutates cell values.
//   delete-rows    — engine.runQuery(DELETE ...) / CREATE OR REPLACE ... DISTINCT
//                    (clean.js drop_rows / dedupe): removes rows.
//   delete-column  — a column-dropping transform (destructive to a column).
//   export         — export-report.exportDataset: produces an outbound artifact
//                    (a downloaded file) from the dataset.
// ------------------------------------------------------------
export const ACTION_KINDS = Object.freeze([
  'read',
  'run-query',
  'suggest-edit',
  'apply-edit',
  'delete-rows',
  'delete-column',
  'export',
]);

export const DECISIONS = Object.freeze({
  AUTO_ALLOW: 'auto-allow',
  CONFIRM_REQUIRED: 'confirm-required',
  DENY: 'deny',
});

// Default classification. Anything not explicitly read-only defaults to
// confirm-required — the safe default. `deny` is intentionally unused by any
// built-in kind (nothing is hard-denied by default) but the enum and DENIED_KINDS
// set below stay extensible so a future kind that must NEVER run can be added.
export const DEFAULT_POLICY = Object.freeze({
  'read': DECISIONS.AUTO_ALLOW,
  'run-query': DECISIONS.AUTO_ALLOW,   // refined by payload.sql below
  'suggest-edit': DECISIONS.AUTO_ALLOW, // a suggestion is not an application
  'apply-edit': DECISIONS.CONFIRM_REQUIRED,
  'delete-rows': DECISIONS.CONFIRM_REQUIRED,
  'delete-column': DECISIONS.CONFIRM_REQUIRED,
  'export': DECISIONS.CONFIRM_REQUIRED, // produces an outbound artifact
});

// Kinds that must never run. Empty by default (deny is reserved for a future
// kind), but a caller/config can extend it. Kept as a mutable module-local set
// seeded from an extensible source so the deny path is real and testable.
const DENIED_KINDS = new Set();

// SQL statements that WRITE. run-query with any of these in its payload.sql is
// escalated from auto-allow to confirm-required, because engine.runQuery is the
// same door DELETE/UPDATE/DROP go through, not only SELECT.
const WRITE_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|MERGE|ATTACH|COPY)\b/i;

/**
 * Classify a requested agent action. Pure — no DOM, no network, no side
 * effects. Unknown kinds fail CLOSED (deny), so an unrecognized capability can
 * never slip through as auto-allowed.
 * @param {{kind:string, source?:string, payload?:object}} action
 * @returns {{decision:string, reason:string, kind:string, source:string|null}}
 */
export function evaluateAction({ kind, source = null, payload = null } = {}) {
  const src = source || null;
  if (typeof kind !== 'string' || kind === '') {
    return { decision: DECISIONS.DENY, reason: 'No action kind supplied — denied (fail-closed).', kind: null, source: src };
  }
  if (!ACTION_KINDS.includes(kind)) {
    return { decision: DECISIONS.DENY, reason: `Unknown action kind "${kind}" — denied (fail-closed). Only ${ACTION_KINDS.join(', ')} are recognized.`, kind, source: src };
  }
  if (DENIED_KINDS.has(kind)) {
    return { decision: DECISIONS.DENY, reason: `Action kind "${kind}" is hard-denied by policy and must never run.`, kind, source: src };
  }

  // run-query is the one kind whose safety depends on its payload: a SELECT is
  // read-only, but the same runQuery door also executes write DML.
  if (kind === 'run-query') {
    const sql = payload && typeof payload.sql === 'string' ? payload.sql : '';
    if (WRITE_SQL.test(sql)) {
      return { decision: DECISIONS.CONFIRM_REQUIRED, reason: 'run-query carries a data-writing SQL statement (INSERT/UPDATE/DELETE/DROP/…), which modifies the dataset — confirmation required before it runs.', kind, source: src };
    }
    return { decision: DECISIONS.AUTO_ALLOW, reason: 'run-query is read-only (no write DML detected) — allowed automatically.', kind, source: src };
  }

  const decision = DEFAULT_POLICY[kind];
  const reason = decision === DECISIONS.AUTO_ALLOW
    ? `"${kind}" is read-only / non-destructive — allowed automatically.`
    : `"${kind}" modifies, removes, or exports the loaded dataset — confirmation required before it is applied.`;
  return { decision, reason, kind, source: src };
}

// ------------------------------------------------------------
// Hash-chained action log — the auditable record of every agent action the
// firewall evaluated and its outcome. Same construction as the provenance
// chain: each entry folds in its parent's hash, so altering any earlier entry
// invalidates every hash after it. Uses the SHARED sha256Hex primitive.
// ------------------------------------------------------------

// Canonical serialization of the fields an entry's hash commits to. Snapshots
// are committed by their content hash (not their full rows) so the chain stays
// compact and deterministic while still binding the recorded before/after state.
function actionPayload(parentHash, entry) {
  return JSON.stringify({
    index: entry.index,
    parentHash,
    kind: entry.kind,
    source: entry.source ?? null,
    decision: entry.decision,
    outcome: entry.outcome ?? null,
    snapshotBeforeHash: entry.snapshotBeforeHash ?? null,
    snapshotAfterHash: entry.snapshotAfterHash ?? null,
    ts: entry.ts,
  });
}

// Content hash of a snapshot-like value, or null. Accepts either a value that
// already carries a `hash` (a time-machine snapshot) or a {columns, rows} pair.
function snapshotHash(snap) {
  if (snap == null) return null;
  if (typeof snap === 'string') return snap;
  if (typeof snap.hash === 'string') return snap.hash;
  if (Array.isArray(snap.columns) && Array.isArray(snap.rows)) return contentHash(snap.columns, snap.rows);
  return null;
}

// The single session-scoped action log. Kept module-local so the browser app
// shares one firewall log; tests build their own via createAgentFirewall().
export function createAgentFirewall() {
  const log = [];
  // Undo stack of applied, reversible actions: { entryIndex, snapshotBefore }.
  const undoStack = [];

  /**
   * Append one action to the hash-chained log. Async because it uses the shared
   * SHA-256 helper (crypto.subtle), exactly like provenance.append.
   * @param {{kind:string, source?:string, decision:string, outcome?:string,
   *   snapshotBefore?:object, snapshotAfter?:object}} rec
   * @returns {Promise<object>} the appended, hashed entry
   */
  async function recordAction({ kind, source = null, decision, outcome = null, snapshotBefore = null, snapshotAfter = null } = {}) {
    const parentHash = log.length ? log[log.length - 1].hash : GENESIS_PARENT;
    const entry = {
      index: log.length,
      kind,
      source,
      decision,
      outcome,
      snapshotBeforeHash: snapshotHash(snapshotBefore),
      snapshotAfterHash: snapshotHash(snapshotAfter),
      ts: Date.now(),
    };
    const hash = await sha256Hex(actionPayload(parentHash, entry));
    const full = { ...entry, parentHash, hash };
    log.push(full);

    // An applied, reversible destructive action becomes undoable: we retain the
    // caller-supplied before-snapshot (the tombstone) so undoLastAgentAction can
    // return enough to restore the prior state.
    const reversible = outcome === 'applied'
      && (kind === 'delete-rows' || kind === 'delete-column' || kind === 'apply-edit')
      && snapshotBefore != null;
    if (reversible) undoStack.push({ entryIndex: full.index, snapshotBefore });
    return full;
  }

  /**
   * Re-verify the whole action log from scratch, recomputing every hash. Pure
   * given the stored entries. Mirrors provenance.verifyChainArray.
   * @returns {Promise<{valid:boolean, brokenAt:number, reason:string}>}
   */
  async function verifyLog() {
    let parentHash = GENESIS_PARENT;
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (e.parentHash !== parentHash) {
        return { valid: false, brokenAt: i, reason: `Action #${i} ("${e.kind}") does not link to the previous action's hash — the log was re-ordered or an earlier action was altered.` };
      }
      const expected = await sha256Hex(actionPayload(parentHash, e));
      if (expected !== e.hash) {
        return { valid: false, brokenAt: i, reason: `Action #${i} ("${e.kind}") has been modified since it was recorded — its contents no longer match its hash.` };
      }
      parentHash = e.hash;
    }
    return { valid: true, brokenAt: -1, reason: `All ${log.length} action(s) verified — the agent action log is intact.` };
  }

  /**
   * Capture a lightweight, restorable snapshot of the dataset BEFORE a
   * confirm-required destructive action is applied (the tombstone). Reuses the
   * time-machine snapshot primitive rather than duplicating snapshot logic.
   * @param {{name?:string, columns:string[], rows:object[]}} dataset
   * @returns {object} a time-machine snapshot (embeds rows so undo is possible)
   */
  function captureSnapshot(dataset = {}) {
    const { name = 'dataset', columns = [], rows = [] } = dataset;
    // Defensive copy: a tombstone must be independent of the live dataset, so an
    // in-place mutation by the caller cannot corrupt the state undo restores.
    const rowsCopy = rows.map(r => ({ ...r }));
    return buildSnapshot({ datasetName: name, columns: columns.slice(), rows: rowsCopy, embedRows: true });
  }

  /**
   * Undo the most recent applied, reversible agent action. Records the undo as
   * its own log entry (so the reversal is itself auditable) and returns the
   * captured before-state for the caller to restore into the engine. The
   * firewall is pure logic — it does not touch DuckDB itself — so restoring the
   * returned rows is the caller's job.
   * @returns {Promise<{undone:boolean, kind?:string, columns?:string[],
   *   rows?:object[], diffSummary?:object, reason:string}>}
   */
  async function undoLastAgentAction() {
    const top = undoStack.pop();
    if (!top) {
      return { undone: false, reason: 'There is no reversible agent action to undo.' };
    }
    const original = log[top.entryIndex];
    const snap = top.snapshotBefore;
    const cols = Array.isArray(snap.columns) ? snap.columns : [];
    const rows = Array.isArray(snap.rows) ? snap.rows : [];
    await recordAction({
      kind: original.kind,
      source: 'agent-firewall:undo',
      decision: DECISIONS.AUTO_ALLOW,
      outcome: 'undone',
      snapshotBefore: null,
      snapshotAfter: snap,
    });
    // Summarize what the undo restores, reusing the time-machine diff primitive.
    let diffSummary = null;
    try {
      diffSummary = summarizeDiffFromPrevious(cols, [], cols, rows);
    } catch { diffSummary = null; }
    return {
      undone: true,
      kind: original.kind,
      columns: cols,
      rows,
      diffSummary,
      reason: `Restored the dataset state captured before the ${original.kind} action.`,
    };
  }

  function getLog() {
    return log.map(e => ({ ...e }));
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  return {
    evaluateAction,
    recordAction,
    verifyLog,
    captureSnapshot,
    undoLastAgentAction,
    getLog,
    canUndo,
    get length() { return log.length; },
  };
}

// ---- App-level singleton so the browser shares one firewall/log ----
let singleton = null;

/** The shared app-wide firewall instance (lazily created). */
export function getAgentFirewall() {
  if (!singleton) singleton = createAgentFirewall();
  return singleton;
}
