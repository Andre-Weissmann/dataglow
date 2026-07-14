// ============================================================
// DATAGLOW — Open Floor Sandbox Twin RED-TEAM regression suite
// ============================================================
// The sandbox twin exists so an autonomous agent can propose destructive
// operations FREELY against a disposable copy while the real dataset stays safe.
// This suite plays the agent-gone-rogue from the April 2026 incident: it tries to
// "delete everything" — against the twin AND against the real dataset — WITHOUT a
// valid, per-action human confirmation, and asserts the two guarantees hold:
//
//   (a) A twin op is INERT until confirmed: an unconfirmed "delete all" leaves the
//       twin's rows untouched, and even after a confirmed twin wipe, reset()
//       restores the fork baseline (reversible/disposable by construction).
//   (b) The REAL dataset is NEVER touched without going through the firewall: an
//       unconfirmed / bypass-flagged promote throws AgentActionBlocked and the
//       real-table writer is NEVER called; only a valid human confirmation lets a
//       promote through.
//
// Also covers graceful degradation when the firewall module is absent: the twin
// comes up disabled and fails closed (warns, applies nothing) instead of throwing.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/sandbox-twin.test.mjs

import { createSandboxTwin } from '../js/simulation/sandbox-twin.js';
import {
  AgentActionBlocked,
  _resetFirewallForTests,
} from '../js/agents/agent-action-firewall.js';
// The injected firewall = the REAL module, so this suite exercises the genuine
// gate, not a stand-in.
import * as realFirewall from '../js/agents/agent-action-firewall.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
async function assertBlocked(msg, spy, promise) {
  let threw = null;
  try { await promise; } catch (e) { threw = e; }
  ok(threw instanceof AgentActionBlocked, `${msg}: throws AgentActionBlocked`);
  ok(spy.ran === false, `${msg}: real-data executor NEVER ran`);
}

const COLUMNS = [
  { name: 'patient_id', type: 'INTEGER' },
  { name: 'diagnosis', type: 'VARCHAR' },
  { name: 'cost', type: 'DOUBLE' },
];
function sampleRows() {
  return [
    { patient_id: 1, diagnosis: 'A', cost: 100 },
    { patient_id: 2, diagnosis: 'B', cost: 200 },
    { patient_id: 3, diagnosis: 'A', cost: 300 },
  ];
}
const GOOD_CONFIRM = { confirmed: true, identity: { displayName: 'Dana Analyst', sessionId: 's-1' } };
// The "delete everything" mutate an attacker wants to run.
const deleteEverything = () => [];

async function main() {
  _resetFirewallForTests();

  // ================================================================
  // 0. Fork isolation — the twin is a deep copy of the real rows.
  // ================================================================
  const realRows = sampleRows();
  const twin = await createSandboxTwin({ realRows, columns: COLUMNS, firewall: realFirewall });
  ok(twin.isSandboxTwin === true && twin.enabled === true, 'twin: constructed & enabled with firewall present');
  ok(twin.getRowCount() === 3, 'twin: forked with all real rows');
  // Mutating the caller's original array must not leak into the twin and vice versa.
  realRows.push({ patient_id: 999, diagnosis: 'X', cost: 0 });
  ok(twin.getRowCount() === 3, 'twin: fork is isolated from later mutation of the source array');
  realRows.pop();

  // ================================================================
  // 1. GUARANTEE (a): an UNCONFIRMED destructive twin op is INERT.
  // ================================================================
  const proposal = twin.propose({ kind: 'delete-rows', table: '__twin', description: 'delete ALL rows', affectedCount: 3 });
  ok(proposal && typeof proposal.nonce === 'string', 'twin.propose: returns a firewall proposal (executes nothing)');
  ok(twin.getRowCount() === 3, 'twin.propose: proposing alone changes NOTHING');

  // No confirmation at all.
  {
    let threw = null;
    try { await twin.applyToTwin({ proposal, confirmation: undefined, mutate: deleteEverything }); }
    catch (e) { threw = e; }
    ok(threw instanceof AgentActionBlocked, 'twin.applyToTwin (no confirmation): throws AgentActionBlocked');
    ok(twin.getRowCount() === 3, 'twin.applyToTwin (no confirmation): twin rows UNTOUCHED (inert)');
  }

  // A forged "trusted/force/auto" bypass attempt — inert, because the firewall has
  // no such path and confirmed !== true.
  {
    let threw = null;
    const bypass = { confirmed: false, trusted: true, force: true, auto: true, nonce: proposal.nonce, identity: GOOD_CONFIRM.identity };
    try { await twin.applyToTwin({ proposal, confirmation: bypass, mutate: deleteEverything }); }
    catch (e) { threw = e; }
    ok(threw instanceof AgentActionBlocked, 'twin.applyToTwin (trusted/force/auto bypass): still blocked');
    ok(twin.getRowCount() === 3, 'twin.applyToTwin (bypass): twin rows UNTOUCHED');
  }

  // Anonymous confirmation (no identity) — blocked by the identity rider.
  {
    let threw = null;
    try { await twin.applyToTwin({ proposal, confirmation: { confirmed: true, nonce: proposal.nonce }, mutate: deleteEverything }); }
    catch (e) { threw = e; }
    ok(threw instanceof AgentActionBlocked, 'twin.applyToTwin (no identity): blocked by identity rider');
    ok(twin.getRowCount() === 3, 'twin.applyToTwin (no identity): twin rows UNTOUCHED');
  }

  // ================================================================
  // 2. A CONFIRMED twin wipe DOES apply — but only to the twin, and is
  //    reversible (guarantee (a), disposability half).
  // ================================================================
  const wipeProposal = twin.propose({ kind: 'delete-rows', affectedCount: 3 });
  const wipeRes = await twin.applyToTwin({
    proposal: wipeProposal,
    confirmation: { ...GOOD_CONFIRM, nonce: wipeProposal.nonce },
    mutate: deleteEverything,
  });
  ok(wipeRes.applied === true && twin.getRowCount() === 0, 'twin: a CONFIRMED delete-all empties the twin');
  ok(realRows.length === 3, 'twin: real source array STILL intact after a confirmed twin wipe');
  twin.reset();
  ok(twin.getRowCount() === 3, 'twin.reset(): restores the fork baseline (twin op was reversible)');

  // ================================================================
  // 3. GUARANTEE (b): the REAL dataset is never touched without the firewall.
  //    The real-table writer is a spy; if it EVER runs on a blocked path, the
  //    incident is possible again.
  // ================================================================
  const realWriter = { ran: false, calls: 0, rows: null };
  const applyToReal = async (rows) => { realWriter.ran = true; realWriter.calls++; realWriter.rows = rows; return 'PROMOTED'; };

  // First, wreck the twin (confirmed) so there IS a destructive result to promote.
  const wipe2 = twin.propose({ kind: 'delete-rows', affectedCount: 3 });
  await twin.applyToTwin({ proposal: wipe2, confirmation: { ...GOOD_CONFIRM, nonce: wipe2.nonce }, mutate: deleteEverything });
  ok(twin.getRowCount() === 0, 'twin: wrecked (0 rows) and ready to attempt promotion');

  // Attack: promote the wipe into reality with NO confirmation.
  const promoteProposal = twin.propose({ kind: 'drop-table', description: 'promote the emptied twin over the real dataset' });
  await assertBlocked('promoteToReal (no confirmation)', realWriter,
    twin.promoteToReal({ proposal: promoteProposal, confirmation: undefined, applyToReal }));

  // Attack: promote with a bypass-flagged, unconfirmed object.
  await assertBlocked('promoteToReal (trusted/force bypass)', realWriter,
    twin.promoteToReal({ proposal: promoteProposal, confirmation: { confirmed: false, trusted: true, nonce: promoteProposal.nonce, identity: GOOD_CONFIRM.identity }, applyToReal }));

  // Attack: replay a DIFFERENT proposal's confirmation (nonce mismatch).
  await assertBlocked('promoteToReal (nonce replay from another action)', realWriter,
    twin.promoteToReal({ proposal: promoteProposal, confirmation: { confirmed: true, nonce: 'not-the-right-nonce', identity: GOOD_CONFIRM.identity }, applyToReal }));

  ok(realWriter.ran === false, 'GUARANTEE (b): after ALL unconfirmed promote attacks, the real writer NEVER ran');

  // ================================================================
  // 4. A VALID human confirmation lets a promote through — exactly once — and
  //    records the authorizing identity into the injected audit recorder.
  // ================================================================
  const audit = [];
  const okPromote = await twin.promoteToReal({
    proposal: promoteProposal,
    confirmation: { ...GOOD_CONFIRM, nonce: promoteProposal.nonce },
    applyToReal,
    recordAudit: (rec) => audit.push(rec),
  });
  ok(okPromote.promoted === true && realWriter.calls === 1, 'promoteToReal (valid confirm): real writer ran exactly once');
  ok(Array.isArray(realWriter.rows) && realWriter.rows.length === 0, 'promoteToReal: the twin state (0 rows) was what got promoted');
  ok(audit.length === 1 && audit[0].authorizedBy && audit[0].authorizedBy.displayName === 'Dana Analyst',
    'promoteToReal: the authorizing human identity was recorded to the chain of custody');

  // Replaying the SAME valid confirmation a second time is refused (single-use nonce).
  {
    let threw = null;
    try {
      await twin.promoteToReal({ proposal: promoteProposal, confirmation: { ...GOOD_CONFIRM, nonce: promoteProposal.nonce }, applyToReal });
    } catch (e) { threw = e; }
    ok(threw instanceof AgentActionBlocked, 'promoteToReal: a used confirmation cannot be replayed (single-use nonce)');
    ok(realWriter.calls === 1, 'promoteToReal: replay did NOT run the real writer a second time');
  }

  // ================================================================
  // 5. REUSE proof — perturbTwin routes a digital-twin perturbation through the
  //    same firewall gate, and diff() uses time-travel-diff (no duplicated logic).
  // ================================================================
  _resetFirewallForTests();
  const twin2 = await createSandboxTwin({ realRows: sampleRows(), columns: COLUMNS, firewall: realFirewall });
  const before = twin2.getRowCount();
  const pRes = await twin2.perturbTwin({ knobs: { 'duplicate': 100 }, seed: 1, confirmation: GOOD_CONFIRM });
  ok(pRes.applied === true && twin2.getRowCount() > before, 'perturbTwin: a confirmed reused perturbation grew the twin (duplicate rows)');
  const d = twin2.diff();
  ok(d.keyColumn === 'patient_id', 'diff(): reuses time-travel-diff and auto-detected the patient_id key');
  ok(Array.isArray(d.added), 'diff(): returns a time-travel-diff row-level diff shape');

  // An UNCONFIRMED perturbTwin is inert too.
  {
    let threw = null;
    const n0 = twin2.getRowCount();
    try { await twin2.perturbTwin({ knobs: { 'duplicate': 100 }, seed: 2, confirmation: { confirmed: false } }); }
    catch (e) { threw = e; }
    ok(threw instanceof AgentActionBlocked, 'perturbTwin (unconfirmed): blocked');
    ok(twin2.getRowCount() === n0, 'perturbTwin (unconfirmed): twin UNTOUCHED');
  }

  // ================================================================
  // 6. GRACEFUL DEGRADATION — firewall unavailable → the REAL module comes up
  //    disabled, fails closed, throws NOTHING at construction, and applies NO
  //    mutation. `firewall: false` drives the exact same disabled branch the
  //    dynamic-import failure takes in the browser, so this exercises the real
  //    module code (not a stand-in).
  // ================================================================
  const brokenWriter = { ran: false };
  const disabled = await createSandboxTwin({ realRows: sampleRows(), columns: COLUMNS, firewall: false });
  ok(disabled.isSandboxTwin === true, 'disabled twin: still CONSTRUCTED (no throw when firewall absent)');
  ok(disabled.enabled === false, 'disabled twin: enabled === false when firewall unavailable');
  ok(disabled.propose({ kind: 'delete-rows' }) === null, 'disabled twin: propose() returns null (fail closed)');

  const appliedRes = await disabled.applyToTwin({ proposal: {}, confirmation: GOOD_CONFIRM, mutate: deleteEverything });
  ok(appliedRes.blocked === true && appliedRes.applied === false, 'disabled twin: applyToTwin refuses (fail closed, no throw)');
  ok(disabled.getRowCount() === 3, 'disabled twin: twin rows untouched by the refused apply');

  const promoteRes = await disabled.promoteToReal({ proposal: {}, confirmation: GOOD_CONFIRM, applyToReal: async () => { brokenWriter.ran = true; } });
  ok(promoteRes.blocked === true && brokenWriter.ran === false, 'disabled twin: promoteToReal refuses and NEVER touches real data');

  const perturbRes = await disabled.perturbTwin({ knobs: { duplicate: 100 }, confirmation: GOOD_CONFIRM });
  ok(perturbRes.blocked === true, 'disabled twin: perturbTwin refuses (fail closed)');

  // An INVALID injected firewall (missing methods) also disables, rather than
  // silently doing something else.
  const badInject = await createSandboxTwin({ realRows: sampleRows(), columns: COLUMNS, firewall: { nope: true } });
  ok(badInject.enabled === false, 'invalid injected firewall: twin comes up disabled (fail closed)');

  // ---------- summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
