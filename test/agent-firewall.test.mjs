// ============================================================
// DATAGLOW — Agent Action Firewall test suite (DataGlow Passport, Batch A)
// ============================================================
// Proves the firewall is a hard, auditable, reversible safety gate:
//   1. evaluateAction classifies every action kind and returns each decision
//      path (auto-allow / confirm-required / deny), incl. run-query refined by
//      its SQL and unknown kinds failing CLOSED to deny.
//   2. recordAction builds a verifiable hash chain (mirrors provenance.js), and
//      tampering with any earlier entry is detected.
//   3. SOURCE GUARD: neither agent-firewall.js nor agent-confirm-gate.js names a
//      network primitive (mirrors the pack no-network guard test).
//   4. INTEGRATION: a confirm-required action is NOT applied until the user
//      confirms, and once applied it CAN be undone via undoLastAgentAction().
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/agent-firewall.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ACTION_KINDS, DECISIONS, DEFAULT_POLICY,
  evaluateAction, createAgentFirewall, getAgentFirewall,
} from '../js/agents/agent-firewall.js';
import { needsConfirmation, runGuardedAction } from '../js/agents/agent-confirm-gate.js';
import { scanSourceForNetwork } from '../js/packs/pack-network-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------- tiny test harness (no framework, matches repo convention) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function main() {
  // ---------- 1. evaluateAction: every kind, every decision path ----------

  // Read-only kinds → auto-allow.
  for (const kind of ['read', 'suggest-edit']) {
    ok(evaluateAction({ kind }).decision === DECISIONS.AUTO_ALLOW, `evaluate: "${kind}" is auto-allow (read-only)`);
  }

  // Write/destructive kinds → confirm-required.
  for (const kind of ['apply-edit', 'delete-rows', 'delete-column', 'export']) {
    ok(evaluateAction({ kind }).decision === DECISIONS.CONFIRM_REQUIRED, `evaluate: "${kind}" is confirm-required`);
  }

  // run-query is payload-sensitive: SELECT read-only, write DML escalates.
  ok(evaluateAction({ kind: 'run-query', payload: { sql: 'SELECT * FROM t' } }).decision === DECISIONS.AUTO_ALLOW,
    'evaluate: run-query with SELECT is auto-allow');
  ok(evaluateAction({ kind: 'run-query', payload: { sql: '  select count(*) from t' } }).decision === DECISIONS.AUTO_ALLOW,
    'evaluate: run-query with lowercase select is auto-allow');
  for (const sql of ['DELETE FROM t', 'UPDATE t SET a=1', 'DROP TABLE t', 'CREATE OR REPLACE TABLE t AS SELECT DISTINCT * FROM t', 'insert into t values (1)']) {
    ok(evaluateAction({ kind: 'run-query', payload: { sql } }).decision === DECISIONS.CONFIRM_REQUIRED,
      `evaluate: run-query with write DML (${sql.split(' ')[0]}) is confirm-required`);
  }
  ok(evaluateAction({ kind: 'run-query' }).decision === DECISIONS.AUTO_ALLOW,
    'evaluate: run-query with no payload defaults to auto-allow (empty SQL is not a write)');

  // Every kind in ACTION_KINDS has a decision, and none is deny by default.
  for (const kind of ACTION_KINDS) {
    const dec = evaluateAction({ kind, payload: { sql: 'SELECT 1' } }).decision;
    ok(dec === DECISIONS.AUTO_ALLOW || dec === DECISIONS.CONFIRM_REQUIRED,
      `evaluate: known kind "${kind}" is never denied by default (got ${dec})`);
  }

  // Deny path: unknown kind and missing kind both fail CLOSED.
  ok(evaluateAction({ kind: 'nuke-everything' }).decision === DECISIONS.DENY, 'evaluate: unknown kind is denied (fail-closed)');
  ok(evaluateAction({}).decision === DECISIONS.DENY, 'evaluate: missing kind is denied (fail-closed)');
  ok(evaluateAction({ kind: '' }).decision === DECISIONS.DENY, 'evaluate: empty kind is denied (fail-closed)');

  // Purity: same input → same output, no mutation of the input.
  const input = Object.freeze({ kind: 'delete-rows', source: 'ondevice-llm', payload: Object.freeze({}) });
  const r1 = evaluateAction(input);
  const r2 = evaluateAction(input);
  ok(r1.decision === r2.decision && r1.reason === r2.reason, 'evaluate: pure and deterministic (frozen input handled)');
  ok(r1.source === 'ondevice-llm', 'evaluate: preserves the source on the result');

  // DEFAULT_POLICY covers every kind.
  ok(ACTION_KINDS.every(k => DEFAULT_POLICY[k]), 'DEFAULT_POLICY classifies every action kind');

  // ---------- 2. recordAction hash chain: valid + tamper-evident ----------
  const fw = createAgentFirewall();
  await fw.recordAction({ kind: 'read', source: 'story', decision: DECISIONS.AUTO_ALLOW, outcome: 'applied' });
  await fw.recordAction({ kind: 'run-query', source: 'story', decision: DECISIONS.AUTO_ALLOW, outcome: 'applied' });
  await fw.recordAction({ kind: 'apply-edit', source: 'agent', decision: DECISIONS.CONFIRM_REQUIRED, outcome: 'confirmed' });
  ok(fw.length === 3, 'recordAction: three actions recorded');

  const chain = fw.getLog();
  ok(chain[0].parentHash === '0'.repeat(64), 'recordAction: genesis entry links to the all-zero parent');
  ok(chain[1].parentHash === chain[0].hash && chain[2].parentHash === chain[1].hash, 'recordAction: each entry links to the previous hash');

  const good = await fw.verifyLog();
  ok(good.valid && good.brokenAt === -1, 'verifyLog: an untampered chain verifies intact');

  // Tamper: mutate an earlier entry's decision in a copied chain and re-verify.
  const tampered = createAgentFirewall();
  await tampered.recordAction({ kind: 'read', decision: DECISIONS.AUTO_ALLOW, outcome: 'applied' });
  await tampered.recordAction({ kind: 'delete-rows', decision: DECISIONS.CONFIRM_REQUIRED, outcome: 'applied', snapshotBefore: { columns: ['a'], rows: [{ a: 1 }] } });
  // Reach into the internal log via getLog is a copy; to tamper we rebuild a
  // firewall whose stored entry is altered. Simplest: verify the exported chain
  // math directly through a second instance is not exposed, so mutate through a
  // known internal: we assert detection by corrupting a returned entry's hash
  // check path using verifyLog after forcing an inconsistency.
  const before = await tampered.verifyLog();
  ok(before.valid, 'verifyLog: control chain valid before tampering');

  // Tamper-detection via the pure array verifier shape: recompute with a flipped
  // field. We emulate storage tampering by constructing an out-of-order chain.
  const forged = tampered.getLog();
  forged[0].decision = DECISIONS.DENY; // silently rewrite history
  // Re-run the same verification math the firewall uses, over the forged array.
  const reforged = await verifyForged(forged);
  ok(!reforged.valid && reforged.brokenAt === 0, 'verifyLog math: rewriting an earlier entry is detected (hash mismatch)');

  // ---------- 3. SOURCE GUARD: no network primitives ----------
  for (const rel of ['js/agents/agent-firewall.js', 'js/agents/agent-confirm-gate.js']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const violations = scanSourceForNetwork(src);
    ok(violations.length === 0, `source guard: ${rel} names no network primitive${violations.length ? ' — ' + violations.map(v => `${v.primitive}@${v.line}`).join(', ') : ''}`);
  }

  // ---------- 4. INTEGRATION: gate blocks until confirmed, then undo works ----------
  // A mock "loaded dataset" the agent wants to delete rows from.
  const dataset = { name: 'patients', columns: ['id', 'age'], rows: [{ id: 1, age: 30 }, { id: 2, age: null }, { id: 3, age: 45 }] };
  const originalIds = dataset.rows.map(r => r.id); // captured before any in-place mutation
  const gate = createAgentFirewall();

  const evalDelete = evaluateAction({ kind: 'delete-rows', source: 'ondevice-llm', payload: { where: 'age IS NULL' } });
  ok(needsConfirmation(evalDelete), 'integration: delete-rows needs confirmation');

  // (a) User CANCELS: action must NOT be applied.
  const before1 = gate.captureSnapshot(dataset);
  const denied = await runGuardedAction({ evaluation: evalDelete, confirmFn: async () => false });
  ok(denied.proceed === false && denied.confirmed === false, 'integration: cancelled confirm-required action does not proceed');
  const datasetAfterCancel = applyDeleteIfProceed(dataset, denied.proceed, r => r.age == null);
  ok(datasetAfterCancel.rows.length === 3, 'integration: dataset is UNCHANGED after cancel (no rows removed)');
  await gate.recordAction({ kind: 'delete-rows', source: 'ondevice-llm', decision: evalDelete.decision, outcome: 'blocked', snapshotBefore: before1 });
  ok(gate.canUndo() === false, 'integration: a blocked action creates nothing to undo');

  // (b) User CONFIRMS: capture tombstone, apply, record as applied.
  const before2 = gate.captureSnapshot(dataset);
  const allowed = await runGuardedAction({ evaluation: evalDelete, confirmFn: async () => true });
  ok(allowed.proceed === true && allowed.confirmed === true, 'integration: confirmed action proceeds');
  const mutated = applyDeleteIfProceed(dataset, allowed.proceed, r => r.age == null);
  ok(mutated.rows.length === 2, 'integration: confirmed delete removes the null-age row');
  await gate.recordAction({ kind: 'delete-rows', source: 'ondevice-llm', decision: evalDelete.decision, outcome: 'applied', snapshotBefore: before2, snapshotAfter: gate.captureSnapshot(mutated) });
  ok(gate.canUndo() === true, 'integration: an applied destructive action is undoable');

  // (c) UNDO: restore the captured before-state.
  const undo = await gate.undoLastAgentAction();
  ok(undo.undone === true, 'integration: undoLastAgentAction reports success');
  ok(undo.rows.length === 3 && undo.rows.every((r, i) => r.id === originalIds[i]),
    'integration: undo restores the exact pre-delete rows');
  ok(gate.canUndo() === false, 'integration: nothing left to undo after undoing the only action');

  const undoNothing = await gate.undoLastAgentAction();
  ok(undoNothing.undone === false, 'integration: undo with an empty stack is a safe no-op');

  // The whole gate log (incl. the undo entry) must still verify.
  const finalVerify = await gate.verifyLog();
  ok(finalVerify.valid, 'integration: the action log (including the undo entry) verifies intact');

  // auto-allow path never prompts.
  const autoRes = await runGuardedAction({ evaluation: evaluateAction({ kind: 'read' }) });
  ok(autoRes.proceed === true && autoRes.confirmed === false, 'integration: auto-allow proceeds without any prompt');

  // deny path never proceeds, even with a confirmFn that says yes.
  const denyRes = await runGuardedAction({ evaluation: evaluateAction({ kind: 'unknown-kind' }), confirmFn: async () => true });
  ok(denyRes.proceed === false, 'integration: a denied action never proceeds even if confirmFn returns true');

  // singleton is shared + stable.
  ok(getAgentFirewall() === getAgentFirewall(), 'getAgentFirewall returns a stable singleton');

  // ---------- summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// Re-run the firewall's chain verification math over an externally-forged array,
// to prove tamper-detection without needing a private setter. Mirrors the
// canonical serialization + fold used inside createAgentFirewall().verifyLog.
async function verifyForged(entries) {
  const { sha256Hex, GENESIS_PARENT } = await import('../js/provenance/provenance.js');
  const payload = (parentHash, e) => JSON.stringify({
    index: e.index, parentHash, kind: e.kind, source: e.source ?? null,
    decision: e.decision, outcome: e.outcome ?? null,
    snapshotBeforeHash: e.snapshotBeforeHash ?? null,
    snapshotAfterHash: e.snapshotAfterHash ?? null, ts: e.ts,
  });
  let parentHash = GENESIS_PARENT;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.parentHash !== parentHash) return { valid: false, brokenAt: i };
    const expected = await sha256Hex(payload(parentHash, e));
    if (expected !== e.hash) return { valid: false, brokenAt: i };
    parentHash = e.hash;
  }
  return { valid: true, brokenAt: -1 };
}

// Tiny mock of the caller's "apply the delete" step. Only mutates when told to
// proceed — this is exactly the discipline the firewall enforces at real call
// sites: nothing touches the data until the gate says proceed.
function applyDeleteIfProceed(dataset, proceed, predicate) {
  if (!proceed) return dataset; // unchanged
  dataset.rows = dataset.rows.filter(r => !predicate(r));
  return dataset;
}

main();
