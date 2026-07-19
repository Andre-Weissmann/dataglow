// ============================================================
// DATAGLOW — Metric Access Rules test suite (Batch 4: agent-access rules)
// ============================================================
// Proves the read-access-rule model behaves as specified:
//   - a metric with no rule ever set defaults to unrestricted (ANY_AGENT)
//     access, so introducing this module changes nothing until a rule is
//     explicitly configured
//   - permits() correctly distinguishes wildcard vs. named-allow-list rules
//   - setRule() replaces (not appends) — current-state, not history
//   - an empty allowedAgents array is a valid "no one authorized" state
//   - the registry keys rules per metric id independently
//   - isAuthorized() convenience wrapper matches ruleFor(...).permits(...)
//   - JSON export/import round-trips both a rule and the registry
//
// RUN WITH: node test/metric-access-rules.test.mjs (pure logic, no DuckDB needed)

import {
  MetricAccessRule, MetricAccessRuleRegistry, ANY_AGENT,
} from '../js/metrics/metric-access-rules.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // ---------- 1. Default state: unrestricted until a rule is set ----------
  const reg = new MetricAccessRuleRegistry();
  ok(reg.size === 0, 'registry: starts empty');
  ok(reg.has('readmission-rate') === false, 'registry: has() false for unconfigured metric');
  const defaultRule = reg.ruleFor('readmission-rate');
  ok(defaultRule.isUnrestricted === true, 'ruleFor: unconfigured metric defaults to unrestricted');
  ok(reg.isAuthorized('readmission-rate', 'nl-sql') === true, 'isAuthorized: unconfigured metric permits any agent (no behavior change until a rule is set)');
  ok(reg.isAuthorized('readmission-rate', 'anything-at-all') === true, 'isAuthorized: unconfigured metric permits an arbitrary unknown agent id too');

  // ---------- 2. Explicit wildcard rule ----------
  const wildcardRule = new MetricAccessRule('los-avg', { allowedAgents: [ANY_AGENT], setBy: 'andre' });
  ok(wildcardRule.isUnrestricted === true, 'MetricAccessRule: explicit [ANY_AGENT] is unrestricted');
  ok(wildcardRule.permits('nl-sql') === true, 'permits: wildcard rule allows any named agent');
  ok(wildcardRule.permits('mcp-interface') === true, 'permits: wildcard rule allows a different named agent too');

  // ---------- 3. Named allow-list rule ----------
  const scopedRule = new MetricAccessRule('reidentification-risk-score', {
    allowedAgents: ['query-sentinel', 'nl-sql'],
    reason: 'Sensitive re-identification-risk KPI — scoped to vetted internal query paths only',
    setBy: 'andre',
  });
  ok(scopedRule.isUnrestricted === false, 'MetricAccessRule: named allow-list is NOT unrestricted');
  ok(scopedRule.permits('nl-sql') === true, 'permits: named agent in allow-list is permitted');
  ok(scopedRule.permits('query-sentinel') === true, 'permits: second named agent in allow-list is permitted');
  ok(scopedRule.permits('mcp-interface') === false, 'permits: agent NOT in allow-list is denied');
  ok(scopedRule.permits('any') === false, 'permits: literal string "any" is not magically treated as ANY_AGENT unless it is the sole element');

  // ---------- 4. Empty allow-list is a valid "no one authorized" state ----------
  const lockedRule = new MetricAccessRule('unreviewed-metric', { allowedAgents: [], reason: 'Flagged sensitive, rules not yet re-granted' });
  ok(lockedRule.allowedAgents.length === 0, 'MetricAccessRule: empty allowedAgents array is accepted, not defaulted away');
  ok(lockedRule.isUnrestricted === false, 'MetricAccessRule: empty allow-list is not unrestricted');
  ok(lockedRule.permits('nl-sql') === false, 'permits: empty allow-list denies every agent, including previously-trusted ones');

  // ---------- 5. setRule() replaces, does not append (current-state, not history) ----------
  reg.setRule('los-avg', { allowedAgents: [ANY_AGENT] });
  ok(reg.size === 1, 'setRule: first rule set increments registry size');
  reg.setRule('los-avg', { allowedAgents: ['nl-sql'], reason: 'Restricted after audit finding' });
  ok(reg.size === 1, 'setRule: replacing an existing metric\'s rule does not grow registry size (current-state, not append-only)');
  ok(reg.ruleFor('los-avg').permits('nl-sql') === true, 'setRule: latest rule for a metric is the one in effect');
  ok(reg.ruleFor('los-avg').permits('mcp-interface') === false, 'setRule: previous wildcard access is fully superseded, not merged');

  // ---------- 6. Registry keys rules per metric id independently ----------
  reg.setRule('readmission-rate', { allowedAgents: ['query-sentinel'] });
  ok(reg.size === 2, 'registry: a second metric gets its own independent rule');
  ok(reg.isAuthorized('readmission-rate', 'query-sentinel') === true, 'isAuthorized: readmission-rate scoped rule permits query-sentinel');
  ok(reg.isAuthorized('readmission-rate', 'nl-sql') === false, 'isAuthorized: readmission-rate scoped rule denies nl-sql');
  ok(reg.isAuthorized('los-avg', 'query-sentinel') === false, 'isAuthorized: los-avg\'s own rule (nl-sql only) is unaffected by readmission-rate\'s rule');

  // ---------- 7. JSON round-trip: single rule ----------
  const ruleJson = scopedRule.toJSON();
  ok(ruleJson.kind === 'dataglow-metric-access-rule' && ruleJson.metricId === 'reidentification-risk-score', 'toJSON: rule payload shape correct');
  const restoredRule = MetricAccessRule.fromJSON(ruleJson);
  ok(restoredRule.permits('nl-sql') === true && restoredRule.permits('mcp-interface') === false, 'fromJSON: restored single rule preserves exact allow-list behavior');
  ok(restoredRule.reason === scopedRule.reason, 'fromJSON: restored rule preserves the reason field');
  ok(MetricAccessRule.fromJSON(null) === null, 'fromJSON: null payload returns null rather than throwing');
  ok(MetricAccessRule.fromJSON({}) === null, 'fromJSON: payload missing metricId returns null rather than throwing');

  // ---------- 8. JSON round-trip: full registry ----------
  const regJson = reg.toJSON();
  ok(regJson.kind === 'dataglow-metric-access-rule-registry' && regJson.rules.length === 2, 'toJSON: registry payload carries every configured rule');
  const restoredReg = MetricAccessRuleRegistry.fromJSON(regJson);
  ok(restoredReg.size === 2, 'fromJSON: restored registry has the same number of configured rules');
  ok(restoredReg.isAuthorized('los-avg', 'nl-sql') === true, 'fromJSON: restored registry preserves los-avg authorization behavior');
  ok(restoredReg.isAuthorized('readmission-rate', 'nl-sql') === false, 'fromJSON: restored registry preserves readmission-rate authorization behavior');
  ok(restoredReg.isAuthorized('never-configured-metric', 'literally-anyone') === true, 'fromJSON: a metric absent from the restored registry still defaults to unrestricted, same as a brand-new registry');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
