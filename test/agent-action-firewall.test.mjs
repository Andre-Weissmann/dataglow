// ============================================================
// DATAGLOW — Agent Action Firewall RED-TEAM regression suite
// ============================================================
// This is the direct regression test for the real-world incident the Agent
// Action Firewall exists to prevent: the April 2026 case where an AI agent with
// unrestricted permissions deleted a production database and all backups in nine
// seconds with NO confirmation step.
//
// The suite plays the attacker. Every "attack" below is an attempt to make a
// destructive/mutating action apply WITHOUT a valid, per-action human
// confirmation carrying an authenticated identity. Each attack MUST fail closed:
// the caller-supplied executor must NEVER run, and AgentActionBlocked must be
// thrown. A single leaked execution is a hard failure.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/agent-action-firewall.test.mjs

import {
  ActionRisk,
  classifyAction,
  proposeAction,
  confirmAndApply,
  guardMutation,
  normalizeIdentity,
  AgentActionBlocked,
  _resetFirewallForTests,
} from '../js/agents/agent-action-firewall.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A spy executor: records whether it ran. Used to prove the mutation NEVER
// executes when the gate blocks. If this ever flips true on a blocked path, the
// firewall has failed and the incident is possible again.
function makeExecutor(result = 'MUTATION-RAN') {
  const spy = { ran: false, calls: 0 };
  const fn = async () => { spy.ran = true; spy.calls++; return result; };
  return { spy, fn };
}

// Assert that awaiting `promise` rejects with AgentActionBlocked AND the spy
// never ran. This is the core red-team assertion.
async function assertBlocked(msg, spy, promise) {
  let threw = null;
  try { await promise; } catch (e) { threw = e; }
  ok(threw instanceof AgentActionBlocked, `${msg}: throws AgentActionBlocked`);
  ok(spy.ran === false, `${msg}: executor NEVER ran (mutation blocked)`);
}

// A valid, authenticated local identity used on the happy paths.
const GOOD_IDENTITY = { displayName: 'Dana Analyst', sessionId: 'session-abc', source: 'local-device' };

async function main() {
  // ================================================================
  // 1. Classification — an unknown/destructive action gets the MOST
  //    cautious treatment, never the least (fail safe, not fail open).
  // ================================================================
  ok(classifyAction({ kind: 'delete-rows' }).risk === ActionRisk.CRITICAL, 'classify: delete-rows is CRITICAL');
  ok(classifyAction({ kind: 'delete-rows' }).reversible === false, 'classify: delete-rows is irreversible');
  ok(classifyAction({ kind: 'drop-table' }).risk === ActionRisk.CRITICAL, 'classify: drop-table is CRITICAL');
  ok(classifyAction({ kind: 'impute' }).risk === ActionRisk.MODERATE, 'classify: impute is MODERATE');
  ok(classifyAction({ kind: 'annotate' }).risk === ActionRisk.LOW, 'classify: annotate is LOW');
  ok(classifyAction({ kind: 'annotate' }).reversible === true, 'classify: annotate is reversible');
  const unknown = classifyAction({ kind: 'wipe-everything-now' });
  ok(unknown.risk === ActionRisk.CRITICAL && unknown.reversible === false && unknown.known === false,
    'classify: an UNKNOWN action defaults to CRITICAL + irreversible (fail safe)');
  ok(classifyAction({}).risk === ActionRisk.CRITICAL, 'classify: a missing kind defaults to CRITICAL');

  // ================================================================
  // 2. THE INCIDENT REPLAY: an autonomous agent tries to delete all
  //    data with no confirmation at all. Must fail closed.
  // ================================================================
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const proposal = proposeAction({ kind: 'delete-rows', table: 'prod', description: 'DROP ALL ROWS', affectedCount: 5_000_000 });
    // Agent supplies NO confirmation object — the classic "unrestricted
    // permissions, no confirm step" path from the incident.
    await assertBlocked('incident replay (no confirmation)', spy,
      confirmAndApply({ proposal, apply: fn }));
  }

  // ================================================================
  // 3. Fail-closed matrix — every missing/invalid piece blocks.
  // ================================================================
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const p = proposeAction({ kind: 'delete-rows', table: 't' });
    await assertBlocked('confirmed:false', spy,
      confirmAndApply({ proposal: p, confirmation: { confirmed: false, nonce: p.nonce, identity: GOOD_IDENTITY }, apply: fn }));
  }
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const p = proposeAction({ kind: 'delete-rows', table: 't' });
    // "truthy but not exactly true" must not count — no coercion sneaks through.
    await assertBlocked('confirmed:"true" (string, not boolean true)', spy,
      confirmAndApply({ proposal: p, confirmation: { confirmed: 'true', nonce: p.nonce, identity: GOOD_IDENTITY }, apply: fn }));
  }
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const p = proposeAction({ kind: 'delete-rows', table: 't' });
    await assertBlocked('confirmed:1 (truthy number)', spy,
      confirmAndApply({ proposal: p, confirmation: { confirmed: 1, nonce: p.nonce, identity: GOOD_IDENTITY }, apply: fn }));
  }
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const p = proposeAction({ kind: 'delete-rows', table: 't' });
    await assertBlocked('no executor supplied', spy,
      confirmAndApply({ proposal: p, confirmation: { confirmed: true, nonce: p.nonce, identity: GOOD_IDENTITY } }));
  }

  // ================================================================
  // 4. THE RIDER: a confirmation with NO authenticated identity is not a
  //    confirmation. The audit trail must always name who authorized it.
  // ================================================================
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const p = proposeAction({ kind: 'delete-rows', table: 't' });
    await assertBlocked('missing identity', spy,
      confirmAndApply({ proposal: p, confirmation: { confirmed: true, nonce: p.nonce }, apply: fn }));
  }
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const p = proposeAction({ kind: 'delete-rows', table: 't' });
    await assertBlocked('empty/anonymous identity ({})', spy,
      confirmAndApply({ proposal: p, confirmation: { confirmed: true, nonce: p.nonce, identity: {} }, apply: fn }));
  }
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const p = proposeAction({ kind: 'delete-rows', table: 't' });
    await assertBlocked('identity with only blank strings', spy,
      confirmAndApply({ proposal: p, confirmation: { confirmed: true, nonce: p.nonce, identity: { displayName: '   ', sessionId: '' } }, apply: fn }));
  }

  // ================================================================
  // 5. NONCE binding — a confirmation for action A cannot authorize B,
  //    and a confirmation cannot be replayed twice.
  // ================================================================
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    const pA = proposeAction({ kind: 'annotate', table: 't' });          // harmless action A
    const pB = proposeAction({ kind: 'delete-rows', table: 'prod' });     // dangerous action B
    // Attacker captures the confirmation minted for the harmless A and tries to
    // use it to authorize the dangerous B.
    await assertBlocked('replay a confirmation across proposals (A->B)', spy,
      confirmAndApply({ proposal: pB, confirmation: { confirmed: true, nonce: pA.nonce, identity: GOOD_IDENTITY }, apply: fn }));
  }
  _resetFirewallForTests();
  {
    // A confirmation authorizes EXACTLY ONE mutation. Second use is blocked.
    const first = makeExecutor();
    const p = proposeAction({ kind: 'update-values', table: 't' });
    const conf = { confirmed: true, nonce: p.nonce, identity: GOOD_IDENTITY };
    const r1 = await confirmAndApply({ proposal: p, confirmation: conf, apply: first.fn });
    ok(r1.ok === true && first.spy.calls === 1, 'nonce single-use: first confirmed apply runs exactly once');
    const second = makeExecutor();
    await assertBlocked('nonce single-use: replaying the same confirmation is blocked', second.spy,
      confirmAndApply({ proposal: p, confirmation: conf, apply: second.fn }));
  }

  // ================================================================
  // 6. NO BYPASS PARAMETER — the headline guarantee. Extra "trusted",
  //    "force", "auto", "bypass" flags are inert; the gate still holds.
  // ================================================================
  _resetFirewallForTests();
  for (const bypass of [
    { trusted: true }, { force: true }, { auto: true }, { bypass: true },
    { skipConfirmation: true }, { admin: true }, { confirmed: false, force: true },
  ]) {
    const { spy, fn } = makeExecutor();
    const p = proposeAction({ kind: 'delete-rows', table: 'prod' });
    // A "trusted mode" attacker: omit a real confirmation but pass a bypass flag.
    await assertBlocked(`bypass attempt ${JSON.stringify(bypass)} is inert`, spy,
      confirmAndApply({ proposal: p, confirmation: { ...bypass, nonce: p.nonce, identity: GOOD_IDENTITY }, apply: fn }));
  }

  // ================================================================
  // 7. HAPPY PATH — a real human confirmation with identity runs exactly
  //    once and records the authorizer into the (injected) audit trail.
  // ================================================================
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor('CLEANED');
    const audits = [];
    const p = proposeAction({ kind: 'delete-rows', table: 't', column: 'x', affectedCount: 3 });
    const res = await confirmAndApply({
      proposal: p,
      confirmation: { confirmed: true, nonce: p.nonce, identity: GOOD_IDENTITY },
      apply: fn,
      recordAudit: (rec) => audits.push(rec),
    });
    ok(res.ok === true && res.result === 'CLEANED', 'happy path: returns executor result');
    ok(spy.calls === 1, 'happy path: executor ran exactly once');
    ok(audits.length === 1, 'happy path: audit recorder called once');
    ok(audits[0].authorizedBy && audits[0].authorizedBy.displayName === 'Dana Analyst',
      'happy path: audit record names the authorizing human (identity rider)');
    ok(audits[0].classification.risk === ActionRisk.CRITICAL,
      'happy path: audit record carries the risk classification');
  }

  // A recorder that throws must NOT block a properly-confirmed mutation, nor
  // silently swallow the fact that it was confirmed (audit is best-effort).
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor('OK');
    const p = proposeAction({ kind: 'impute', table: 't' });
    const res = await confirmAndApply({
      proposal: p,
      confirmation: { confirmed: true, nonce: p.nonce, identity: GOOD_IDENTITY },
      apply: fn,
      recordAudit: () => { throw new Error('audit sink offline'); },
    });
    ok(res.ok === true && spy.calls === 1, 'happy path: a failing audit recorder does not block a confirmed mutation');
  }

  // ================================================================
  // 8. guardMutation one-shot — same guarantees via the convenience path.
  // ================================================================
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor();
    // No confirmation.confirmed -> blocked even though identity is present.
    await assertBlocked('guardMutation without confirmed:true', spy,
      guardMutation({ kind: 'delete-rows', table: 'prod' }, { identity: GOOD_IDENTITY }, fn));
  }
  _resetFirewallForTests();
  {
    const { spy, fn } = makeExecutor('DONE');
    const res = await guardMutation({ kind: 'update-values', table: 't' }, { confirmed: true, identity: GOOD_IDENTITY }, fn);
    ok(res.ok === true && spy.calls === 1, 'guardMutation happy path: confirmed + identity runs once');
  }

  // ================================================================
  // 9. proposeAction input validation.
  // ================================================================
  {
    let threw = false;
    try { proposeAction({}); } catch (e) { threw = e instanceof AgentActionBlocked; }
    ok(threw, 'proposeAction: a proposal with no kind is rejected');
  }
  {
    let threw = false;
    try { proposeAction(null); } catch (e) { threw = e instanceof AgentActionBlocked; }
    ok(threw, 'proposeAction: a null proposal is rejected');
  }
  // Two proposals never share a nonce.
  ok(proposeAction({ kind: 'annotate' }).nonce !== proposeAction({ kind: 'annotate' }).nonce,
    'proposeAction: each proposal gets a distinct nonce');

  // ================================================================
  // 10. normalizeIdentity unit behaviour.
  // ================================================================
  ok(normalizeIdentity({ displayName: 'Ann' }).label === 'Ann', 'normalizeIdentity: display name only');
  ok(normalizeIdentity({ sessionId: 's1' }).label === 's1', 'normalizeIdentity: session id only');
  ok(normalizeIdentity({ displayName: 'Ann', sessionId: 's1' }).label === 'Ann (s1)', 'normalizeIdentity: name + session');
  ok(normalizeIdentity({}) === null, 'normalizeIdentity: empty object -> null');
  ok(normalizeIdentity(null) === null, 'normalizeIdentity: null -> null');
  ok(normalizeIdentity({ deviceId: 'd9' }).sessionId === 'd9', 'normalizeIdentity: deviceId is accepted as a local id');

  // ---------- summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
