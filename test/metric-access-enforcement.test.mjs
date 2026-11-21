// Tests for Roadmap Step 10b: metric access rules wired to SQL evaluation, the
// gate-state exporter, and the real MCP server's check_metric_access tool
// (exercised end-to-end over stdio via the MCP SDK client).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MetricAccessRuleRegistry, createMetricAccessRegistry, evaluateSqlMetricAccess,
  checkMetricAccessFromGateState, ANY_AGENT,
} from '../js/metrics/metric-access-rules.js';
import { buildGateStatePayload, serializeGateState } from '../js/mcp/gate-state-exporter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

function makeRegistry() {
  const r = createMetricAccessRegistry();
  r.setRule('reid_risk_score', { allowedAgents: ['compliance-bot'], reason: 'PHI-adjacent', setBy: 'andre' });
  r.setRule('denial_rate', { allowedAgents: [ANY_AGENT] });
  r.setRule('locked_metric', { allowedAgents: [] });
  return r;
}
const SEMANTIC = [
  { name: 'reid_risk_score', expression: 'AVG(k_anon_risk)' },
  { name: 'denial_rate', expression: 'SUM(denied) / COUNT(*)' },
  { name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)' },
];

// ---------- evaluateSqlMetricAccess ----------
await test('factory returns a MetricAccessRuleRegistry', () => {
  assert.ok(createMetricAccessRegistry() instanceof MetricAccessRuleRegistry);
});
await test('authorized agent reading a governed metric by alias is allowed', () => {
  const v = evaluateSqlMetricAccess('SELECT AVG(k_anon_risk) AS reid_risk_score FROM claims', 'compliance-bot', { semanticMetrics: SEMANTIC, accessRegistry: makeRegistry() });
  assert.equal(v.allowed, true);
  assert.deepEqual(v.checkedMetrics, ['reid_risk_score']);
  assert.equal(v.reason, null);
});
await test('unauthorized agent is blocked with a reason naming the metric', () => {
  const v = evaluateSqlMetricAccess('SELECT AVG(k_anon_risk) AS reid_risk_score FROM claims', 'cursor', { semanticMetrics: SEMANTIC, accessRegistry: makeRegistry() });
  assert.equal(v.allowed, false);
  assert.deepEqual(v.blockedMetrics, ['reid_risk_score']);
  assert.match(v.reason, /cursor/);
  assert.match(v.reason, /reid_risk_score/);
});
await test('renaming the alias does not evade the gate (expression match)', () => {
  const v = evaluateSqlMetricAccess('SELECT avg( c.k_anon_risk )   AS totally_innocent FROM claims c', 'cursor', { semanticMetrics: SEMANTIC, accessRegistry: makeRegistry() });
  assert.equal(v.allowed, false);
  assert.deepEqual(v.blockedMetrics, ['reid_risk_score']);
});
await test('case-insensitive and quoted-identifier references are caught', () => {
  const r = makeRegistry();
  assert.equal(evaluateSqlMetricAccess('select "REID_RISK_SCORE" from v', 'cursor', { semanticMetrics: SEMANTIC, accessRegistry: r }).allowed, false);
  assert.equal(evaluateSqlMetricAccess('SELECT Reid_Risk_Score FROM v', 'cursor', { semanticMetrics: SEMANTIC, accessRegistry: r }).allowed, false);
});
await test('name inside a comment or string literal is NOT a read', () => {
  const r = makeRegistry();
  const sql = "SELECT COUNT(*) FROM claims -- reid_risk_score is off limits\n WHERE note = 'reid_risk_score' /* reid_risk_score */";
  const v = evaluateSqlMetricAccess(sql, 'cursor', { semanticMetrics: SEMANTIC, accessRegistry: r });
  assert.equal(v.allowed, true);
  assert.deepEqual(v.checkedMetrics, []);
});
await test('identifier that merely contains the metric name as a prefix is not matched', () => {
  const v = evaluateSqlMetricAccess('SELECT reid_risk_score_v2 FROM t', 'cursor', { semanticMetrics: SEMANTIC, accessRegistry: makeRegistry() });
  assert.deepEqual(v.checkedMetrics, []);
});
await test('explicit metricIds are checked even when SQL is empty/null/garbage', () => {
  const r = makeRegistry();
  for (const sql of ['', null, undefined, 42]) {
    const v = evaluateSqlMetricAccess(sql, 'cursor', { metricIds: ['locked_metric'], accessRegistry: r });
    assert.equal(v.allowed, false);
    assert.deepEqual(v.blockedMetrics, ['locked_metric']);
  }
});
await test('empty allow-list denies everyone; wildcard allows everyone; unconfigured metric is open', () => {
  const r = makeRegistry();
  assert.equal(evaluateSqlMetricAccess('', 'compliance-bot', { metricIds: ['locked_metric'], accessRegistry: r }).allowed, false);
  assert.equal(evaluateSqlMetricAccess('', 'anyone', { metricIds: ['denial_rate'], accessRegistry: r }).allowed, true);
  assert.equal(evaluateSqlMetricAccess('SELECT SUM(amount) - SUM(refund_amount) AS nr FROM o', 'anyone', { semanticMetrics: SEMANTIC, accessRegistry: r }).allowed, true);
});
await test('missing/undefined agentId is denied for restricted metrics (fail closed)', () => {
  const r = makeRegistry();
  assert.equal(evaluateSqlMetricAccess('', undefined, { metricIds: ['reid_risk_score'], accessRegistry: r }).allowed, false);
  assert.equal(evaluateSqlMetricAccess('', null, { metricIds: ['reid_risk_score'], accessRegistry: r }).allowed, false);
});
await test('multiple metrics: one blocked blocks the whole query and all are reported', () => {
  const sql = 'SELECT AVG(k_anon_risk) AS reid_risk_score, SUM(denied)/COUNT(*) AS denial_rate FROM claims';
  const v = evaluateSqlMetricAccess(sql, 'cursor', { semanticMetrics: SEMANTIC, accessRegistry: makeRegistry() });
  assert.equal(v.allowed, false);
  assert.deepEqual(v.checkedMetrics.sort(), ['denial_rate', 'reid_risk_score']);
  assert.deepEqual(v.blockedMetrics, ['reid_risk_score']);
});
await test('SQL-injection style strings cannot smuggle a metric past the gate or crash it', () => {
  const r = makeRegistry();
  const sql = "SELECT 1; DROP TABLE x; SELECT reid_risk_score FROM v WHERE a = '' OR ''=''";
  assert.equal(evaluateSqlMetricAccess(sql, 'cursor', { semanticMetrics: SEMANTIC, accessRegistry: r }).allowed, false);
  const weird = [{ name: 'a.b(c)+*' , expression: '' }, null, { expression: 'x' }];
  assert.doesNotThrow(() => evaluateSqlMetricAccess('SELECT a.b(c)+* FROM t', 'x', { semanticMetrics: weird, accessRegistry: r }));
});
await test('no registry supplied -> default open with an honest reason; no opts at all is safe', () => {
  const v = evaluateSqlMetricAccess('SELECT reid_risk_score FROM v', 'x', { semanticMetrics: SEMANTIC });
  assert.equal(v.allowed, true);
  assert.match(v.reason, /No access registry/);
  assert.deepEqual(evaluateSqlMetricAccess('', 'x'), { allowed: true, blockedMetrics: [], checkedMetrics: [], reason: null });
});

// ---------- gate-state exporter ----------
await test('exporter without the new extras is byte-compatible (no new keys)', () => {
  const p = buildGateStatePayload([], { proofRoomSeal: null });
  assert.equal('metricAccessRules' in p, false);
  assert.equal('metricAccessEnforcement' in p, false);
  assert.equal('metricAccessRules' in buildGateStatePayload([]), false);
});
await test('exporter serializes a live registry and round-trips through JSON', () => {
  const json = serializeGateState([], { metricAccessRules: makeRegistry(), metricAccessEnforcement: true });
  const parsed = JSON.parse(json);
  assert.equal(parsed.metricAccessEnforcement, true);
  assert.equal(parsed.metricAccessRules.rules.length, 3);
  const back = MetricAccessRuleRegistry.fromJSON(parsed.metricAccessRules);
  assert.equal(back.isAuthorized('reid_risk_score', 'compliance-bot'), true);
  assert.equal(back.isAuthorized('reid_risk_score', 'cursor'), false);
  assert.equal(back.isAuthorized('locked_metric', 'compliance-bot'), false);
});
await test('exporter accepts pre-serialized rules, null, and coerces enforcement to strict boolean', () => {
  const pre = makeRegistry().toJSON();
  assert.deepEqual(buildGateStatePayload([], { metricAccessRules: pre }).metricAccessRules, pre);
  assert.equal(buildGateStatePayload([], { metricAccessRules: null }).metricAccessRules, null);
  assert.equal(buildGateStatePayload([], { metricAccessEnforcement: 'yes' }).metricAccessEnforcement, false);
});

// ---------- checkMetricAccessFromGateState (pure adapter) ----------
await test('adapter: not enforced by default (null state, missing flag, false flag)', () => {
  const st = JSON.parse(serializeGateState([], { metricAccessRules: makeRegistry() }));
  for (const s of [null, undefined, 'junk', st, { ...st, metricAccessEnforcement: false }]) {
    const v = checkMetricAccessFromGateState(s, 'reid_risk_score', 'cursor');
    assert.equal(v.allowed, true); assert.equal(v.enforced, false);
  }
});
await test('adapter: enforced allow / deny / unconfigured-default-open / malformed rules', () => {
  const st = JSON.parse(serializeGateState([], { metricAccessRules: makeRegistry(), metricAccessEnforcement: true }));
  const a = checkMetricAccessFromGateState(st, 'reid_risk_score', 'compliance-bot');
  assert.deepEqual([a.allowed, a.enforced, a.ruleConfigured], [true, true, true]);
  const d = checkMetricAccessFromGateState(st, 'reid_risk_score', 'cursor');
  assert.deepEqual([d.allowed, d.enforced, d.ruleConfigured], [false, true, true]);
  const u = checkMetricAccessFromGateState(st, 'never_configured', 'cursor');
  assert.deepEqual([u.allowed, u.enforced, u.ruleConfigured], [true, true, false]);
  const m = checkMetricAccessFromGateState({ metricAccessEnforcement: true, metricAccessRules: 'garbage' }, 'x', 'y');
  assert.equal(m.allowed, true);
});

// ---------- real MCP server over stdio ----------
const dir = mkdtempSync(join(tmpdir(), 'dg-mcp-'));
async function withServer(stateObj, fn) {
  const statePath = join(dir, `state-${Math.random().toString(36).slice(2)}.json`);
  if (stateObj !== undefined) writeFileSync(statePath, typeof stateObj === 'string' ? stateObj : JSON.stringify(stateObj));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(here, '../js/mcp/dataglow-mcp-server.mjs')],
    env: { ...process.env, DATAGLOW_GATE_STATE_PATH: statePath },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}
const call = async (c, args) => {
  const r = await c.callTool({ name: 'check_metric_access', arguments: args });
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};
const enforcedState = () => JSON.parse(serializeGateState([], { metricAccessRules: makeRegistry(), metricAccessEnforcement: true }));

await test('MCP: tool is listed alongside the existing tools', () => withServer(enforcedState(), async (c) => {
  const names = (await c.listTools()).tools.map(t => t.name);
  assert.ok(names.includes('check_metric_access'));
  assert.ok(names.includes('check_readiness') && names.includes('get_agent_passport'));
}));
await test('MCP: allow, deny and unconfigured-default-open when enforcement is on', () => withServer(enforcedState(), async (c) => {
  assert.equal((await call(c, { metric_id: 'reid_risk_score', agent_id: 'compliance-bot' })).body.allowed, true);
  const deny = await call(c, { metric_id: 'reid_risk_score', agent_id: 'claude-code' });
  assert.equal(deny.body.allowed, false); assert.equal(deny.body.enforced, true);
  const open = await call(c, { metric_id: 'brand_new_metric', agent_id: 'claude-code' });
  assert.equal(open.body.allowed, true); assert.equal(open.body.ruleConfigured, false);
}));
await test('MCP: enforcement off in exported state -> always allowed, enforced:false', () => withServer({ ...enforcedState(), metricAccessEnforcement: false }, async (c) => {
  const r = await call(c, { metric_id: 'reid_risk_score', agent_id: 'claude-code' });
  assert.equal(r.body.allowed, true); assert.equal(r.body.enforced, false);
}));
await test('MCP: no state file / corrupt state file -> fail-open honest answer', async () => {
  await withServer(undefined, async (c) => assert.equal((await call(c, { metric_id: 'm', agent_id: 'a' })).body.enforced, false));
  await withServer('{not json', async (c) => assert.equal((await call(c, { metric_id: 'm', agent_id: 'a' })).body.allowed, true));
});
await test('MCP: missing / empty / non-string arguments return isError, never allowed:true', () => withServer(enforcedState(), async (c) => {
  for (const args of [{}, { metric_id: 'x' }, { agent_id: 'x' }, { metric_id: '', agent_id: '' }, { metric_id: 5, agent_id: 'x' }]) {
    const r = await call(c, args);
    assert.equal(r.isError, true); assert.equal(r.body.allowed, false);
  }
}));
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
