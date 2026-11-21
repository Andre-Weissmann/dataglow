// ============================================================
// DATAGLOW — Metric Contracts, Batch 4: agent-access rules (read-only gate)
// ============================================================
// WHY THIS EXISTS (the honesty gap it closes):
// Metric Contracts (Batch 1-3) answer "who changed this metric's definition,
// and when" — a WRITE-side audit trail. They say nothing about who or what is
// authorized to QUERY a metric in the first place. As DataGlow's NL-SQL,
// Query Sentinel, and agent-facing surfaces grow, an unscoped agent could read
// a sensitive metric (e.g. a re-identification-risk-flagged healthcare KPI)
// with the exact same ease as a fully public one. NORTH_STAR.md backlog item
// 2 names this gap explicitly: "Machine-readable Metric Contracts extended
// with agent-access rules (who/what is authorized to query a given metric) —
// partially exists, could be deepened." This module is that deepening.
//
// WHAT IT IS: a thin, per-metric access-rule record — an explicit allow-list
// of agent/source identifiers (or the wildcard 'any') permitted to READ a
// metric's computed value, plus a pure authorization check function. This is
// a QUERY-time read gate, not a write gate — it is a deliberately different
// concept from js/agents/agent-action-firewall.js, which governs MUTATING
// loaded data and requires per-action human confirmation for every mutation
// regardless of any "trusted" flag. Reading a metric's value is not a
// mutation, so the firewall's confirm-and-apply handshake does not apply
// here; the concept that DOES apply is closer to a capability allow-list.
//
// WHAT IT DELIBERATELY DOES NOT DO YET (future batches, not this one):
//   - It does not touch MetricRegistry, metric-studio.js, metric-contracts.js,
//     or metric-contract-confirm-gate.js at all. It is a separate, additive
//     record that a future batch can wire into an actual query path (NL-SQL,
//     Query Sentinel, MCP interface) as a caller-side check.
//   - It has no UI yet. A future batch would add an editor for these rules
//     inside the Metric Studio contract view (same identity-split pattern as
//     metric-contracts.js Batch 1 -> Batch 2 diff view).
//   - It does not enforce anything on its own. isAuthorized() is a pure,
//     side-effect-free predicate; a future batch decides which real call
//     sites (NL-SQL execution, MCP interface, Query Sentinel) actually call
//     it and what they do when it returns false. Landing pure logic first,
//     unwired, is the same identity-split precedent as Batch 1 of Metric
//     Contracts itself.
//   - It ships behind a NEW, dedicated flag (`metricAccessRules`, added this
//     PR, default OFF/dark) per standing convention: any module that will
//     eventually change what a user or agent can see/do ships dark until an
//     explicit, separate enable decision is made. Being pure logic with no
//     caller yet, it is inert regardless of the flag's value today.
//
// Identity split, same pattern as metric-contracts.js:
//   1. Pure logic (this whole file) — Node-testable, no DOM/network/storage.
//   2. DOM presenter/editor — a future batch, gated behind the flag by the
//      caller in main.js, same as metric-contracts.js's own Batch 2.

/**
 * The wildcard identifier meaning "any agent/source may query this metric."
 * Using an explicit constant (rather than an empty array or null) keeps the
 * "unrestricted" state a deliberate, visible choice in code and in any
 * serialized rule, not an ambiguous default.
 */
export const ANY_AGENT = 'any';

/**
 * A per-metric access rule: who/what is allowed to query (read) this
 * metric's computed value. `allowedAgents` is a plain array of identifier
 * strings (e.g. 'nl-sql', 'query-sentinel', 'mcp-interface', a specific
 * named agent id) or the single-element array [ANY_AGENT] for unrestricted
 * read access. An empty array means "no agent is currently authorized" —
 * this is a valid, honest state (e.g. right after a metric is flagged
 * sensitive and rules haven't been re-granted yet), not an error.
 */
export class MetricAccessRule {
  /**
   * @param {string} metricId
   * @param {{allowedAgents?: string[], reason?: string, setBy?: string, setAt?: number}} opts
   */
  constructor(metricId, opts = {}) {
    this.metricId = metricId;
    this.allowedAgents = Array.isArray(opts.allowedAgents) ? [...opts.allowedAgents] : [ANY_AGENT];
    this.reason = opts.reason || '';
    this.setBy = opts.setBy || 'unknown';
    this.setAt = typeof opts.setAt === 'number' ? opts.setAt : Date.now();
  }

  /** True if this rule permits the given agent identifier to query the metric. */
  permits(agentId) {
    if (this.allowedAgents.length === 1 && this.allowedAgents[0] === ANY_AGENT) return true;
    return this.allowedAgents.includes(agentId);
  }

  /** True if this rule is fully unrestricted (the explicit ANY_AGENT state). */
  get isUnrestricted() {
    return this.allowedAgents.length === 1 && this.allowedAgents[0] === ANY_AGENT;
  }

  toJSON() {
    return {
      kind: 'dataglow-metric-access-rule',
      version: 1,
      metricId: this.metricId,
      allowedAgents: [...this.allowedAgents],
      reason: this.reason,
      setBy: this.setBy,
      setAt: this.setAt,
    };
  }

  static fromJSON(payload) {
    if (!payload || payload.metricId == null) return null;
    // Fail CLOSED on a corrupt saved rule. The constructor defaults a missing
    // allowedAgents to [ANY_AGENT] (the deliberate "no rule configured" default),
    // but a rule that WAS saved and came back with allowedAgents missing, null or
    // a bare string ("finance") must not silently become "anyone may read".
    return new MetricAccessRule(payload.metricId, {
      allowedAgents: Array.isArray(payload.allowedAgents) ? payload.allowedAgents : [],
      reason: payload.reason,
      setBy: payload.setBy,
      setAt: payload.setAt,
    });
  }
}

/**
 * A registry of MetricAccessRule objects keyed by metric id — the read-access
 * counterpart to MetricContractRegistry's write-history, kept as a SEPARATE
 * object on purpose so metric-contracts.js and metric-studio.js need zero
 * code changes to coexist with it.
 */
export class MetricAccessRuleRegistry {
  constructor() {
    this._rules = new Map(); // metricId -> MetricAccessRule
  }

  get size() { return this._rules.size; }
  has(metricId) { return this._rules.has(metricId); }

  /**
   * Set (replacing any existing) the access rule for a metric. Unlike the
   * append-only contract history, access rules are a current-state record —
   * a metric has exactly one active rule at a time, which can be updated as
   * authorization needs change. Returns the stored rule (a copy).
   */
  setRule(metricId, opts = {}) {
    const rule = new MetricAccessRule(metricId, opts);
    this._rules.set(metricId, rule);
    return rule;
  }

  /**
   * Get the rule for a metric, or the implicit default (unrestricted) if
   * none has ever been set. This default is deliberate: a metric with no
   * rule configured behaves exactly as DataGlow always has (open access),
   * so introducing this module changes nothing until a rule is explicitly
   * set for a given metric.
   */
  ruleFor(metricId) {
    return this._rules.get(metricId) || new MetricAccessRule(metricId);
  }

  /**
   * Pure authorization check: may `agentId` query `metricId`? Convenience
   * wrapper over ruleFor(...).permits(...) — this is the one function a
   * future call site (NL-SQL, MCP interface, Query Sentinel) would call.
   */
  isAuthorized(metricId, agentId) {
    return this.ruleFor(metricId).permits(agentId);
  }

  toJSON() {
    return {
      kind: 'dataglow-metric-access-rule-registry',
      version: 1,
      rules: [...this._rules.values()].map(r => r.toJSON()),
    };
  }

  static fromJSON(payload) {
    const reg = new MetricAccessRuleRegistry();
    const arr = (payload && Array.isArray(payload.rules)) ? payload.rules : [];
    for (const r of arr) {
      const rule = MetricAccessRule.fromJSON(r);
      if (rule) reg._rules.set(rule.metricId, rule);
    }
    return reg;
  }
}

// ============================================================
// Roadmap Step 10b (2026-11-21): wiring helpers for real callers
// ============================================================
// The classes above shipped as pure logic with zero callers. These additive
// exports give query-time and MCP callers a single, pure entry point each,
// WITHOUT changing any existing class. Enforcement of what a caller does with a
// `allowed: false` verdict is the caller's decision, and the whole path ships
// dark behind the `metricAccessEnforcement` flag (default false).

/** Factory parity with the other governance stores (createRulepackRegistry, createSemanticRegistry). */
export function createMetricAccessRegistry() {
  return new MetricAccessRuleRegistry();
}

// Remove -- line comments, /* */ block comments and 'single quoted' string
// literals so a metric name that only appears in a comment or a text literal is
// not mistaken for a READ of that metric. Double-quoted identifiers are kept.
function stripCommentsAndLiterals(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function squash(expr) {
  return String(expr || '')
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\.(?=[A-Za-z_])/g, '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure read-gate evaluator: which governed metrics does this SQL (or explicit
 * metric request) read, and is `agentId` authorized for every one of them?
 *
 * A semantic metric counts as referenced when, outside comments and string
 * literals, the SQL (a) mentions its name as a whole identifier (alias, column,
 * or quoted identifier, case-insensitive) or (b) contains its canonical
 * expression (normalized: lowercase, no whitespace, no table qualifiers).
 * Explicit `metricIds` are always checked. A metric with no configured rule is
 * open by default (the registry's documented default).
 *
 * @param {string} sql
 * @param {string} agentId
 * @param {{metricIds?: string[], semanticMetrics?: Array<{id?:string,name:string,expression?:string}>, accessRegistry?: MetricAccessRuleRegistry}} [opts]
 * @returns {{allowed:boolean, blockedMetrics:string[], checkedMetrics:string[], reason:string|null}}
 */
export function evaluateSqlMetricAccess(sql, agentId, opts = {}) {
  const { metricIds = [], semanticMetrics = [], accessRegistry } = opts || {};
  const checked = [];
  const add = (id) => { if (id != null && id !== '' && !checked.includes(String(id))) checked.push(String(id)); };

  for (const id of Array.isArray(metricIds) ? metricIds : []) add(id);

  const cleaned = stripCommentsAndLiterals(typeof sql === 'string' ? sql : '');
  const squashedSql = squash(cleaned);
  for (const m of Array.isArray(semanticMetrics) ? semanticMetrics : []) {
    if (!m || !m.name) continue;
    const name = String(m.name);
    const nameRe = new RegExp(`(^|[^A-Za-z0-9_])"?${escapeRe(name)}"?(?![A-Za-z0-9_])`, 'i');
    const byName = nameRe.test(cleaned);
    const expr = squash(m.expression);
    const byExpr = expr.length > 0 && squashedSql.includes(expr);
    if (byName || byExpr) add(m.id != null ? m.id : name);
  }

  if (!accessRegistry || typeof accessRegistry.isAuthorized !== 'function') {
    return {
      allowed: true,
      blockedMetrics: [],
      checkedMetrics: checked,
      reason: checked.length ? 'No access registry supplied; metrics default to open access.' : null,
    };
  }

  const blocked = checked.filter((id) => !accessRegistry.isAuthorized(id, agentId));
  return {
    allowed: blocked.length === 0,
    blockedMetrics: blocked,
    checkedMetrics: checked,
    reason: blocked.length
      ? `Agent "${agentId}" is not authorized to read governed metric${blocked.length > 1 ? 's' : ''}: ${blocked.join(', ')}.`
      : null,
  };
}

/**
 * MCP/gate-state adapter: evaluate `check_metric_access` against an exported
 * gate-state object. Pure (no I/O). Enforcement is OFF unless the exported state
 * says `metricAccessEnforcement === true`; with no rules exported the metric is
 * open by default. Never throws on malformed state.
 *
 * @param {object|null} state parsed dataglow-gate-state.json
 * @param {string} metricId
 * @param {string} agentId
 * @returns {{allowed:boolean, enforced:boolean, ruleConfigured:boolean, metricId:string, agentId:string, reason:string|null}}
 */
export function checkMetricAccessFromGateState(state, metricId, agentId) {
  const base = { metricId: String(metricId ?? ''), agentId: String(agentId ?? '') };
  if (!state || typeof state !== 'object') {
    return { ...base, allowed: true, enforced: false, ruleConfigured: false, reason: 'No gate state exported; metric access is not enforced.' };
  }
  if (state.metricAccessEnforcement !== true) {
    return { ...base, allowed: true, enforced: false, ruleConfigured: false, reason: 'metricAccessEnforcement is not enabled in the exported gate state.' };
  }
  const registry = MetricAccessRuleRegistry.fromJSON(state.metricAccessRules);
  const ruleConfigured = registry.has(base.metricId);
  const allowed = registry.isAuthorized(base.metricId, base.agentId);
  return {
    ...base,
    allowed,
    enforced: true,
    ruleConfigured,
    reason: allowed
      ? (ruleConfigured ? null : 'No access rule configured for this metric; default is open access.')
      : `Agent "${base.agentId}" is not authorized to read metric "${base.metricId}".`,
  };
}
