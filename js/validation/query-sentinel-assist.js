// ============================================================
// DATAGLOW — Query Sentinel Assist (Batch 2 of 3: bounded on-device assist)
// ============================================================
// WHY THIS EXISTS
// Batch 1 (js/validation/query-sentinel.js) ships a deterministic, zero-model
// classifier that flags FANOUT/JOIN_KEY/ADDITIVITY/SENSITIVE_COLUMN risk on
// the query just run. That is a Tier-1 answer: correct, auditable, but
// terse ("[FANOUT] joined table 'claims' is not unique on claim_id before
// the aggregate"). Practitioner research already collected for this project
// (research_coding_practitioner_2026-07-15.md) names a repeated wish: not
// just "you have a bug" but "explain it in plain language, and if there's an
// obvious fix, show me the shape of it so I can decide." This module is that
// SECOND, OPT-IN layer — modeled EXACTLY on js/agents/guarded-copilot.js's
// two-tier answer contract, reused rather than reinvented.
//
// WHAT MAKES THIS SAFE AND BOUNDED (composition, not new invention):
//   1. This module NEVER re-runs or re-derives detection. It only consumes
//      the flags array Batch 1's runQuerySentinel() already produced. It
//      cannot report a finding Batch 1 didn't already report, and it cannot
//      suppress one either — the underlying flags list passed through
//      unchanged in every returned shape.
//   2. Tier 1 (default, zero cost, zero model): buildFixSuggestion() is a
//      small, explicit, per-RULE_CLASS lookup of a SQL PATTERN sketch (never
//      a full corrected query, never auto-applied) — e.g. FANOUT suggests
//      wrapping the joined table in a pre-aggregated subquery, ADDITIVITY
//      suggests aggregating before the join instead of after. This is
//      template text, not generated text, so it is exactly as auditable and
//      zero-cost as Query Sentinel's own Tier 1.
//   3. Tier 2 (opt-in, same on-device model as Guarded Copilot's Tier 2 and
//      Story's on-device path, js/narrative/ondevice-llm.js's
//      Qwen2.5-1.5B-Instruct via WebLLM): reuses that EXACT loader — no
//      second model, no second license, no new WebGPU code path — to turn
//      Tier 1's flags + fix-sketch into one plain-language paragraph. The
//      system prompt (ASSIST_SYSTEM_PROMPT below) is deliberately as narrow
//      as Guarded Copilot's own REPHRASE_SYSTEM_PROMPT: the model may only
//      explain/rephrase the ALREADY-COMPUTED flags and fix sketch, and is
//      explicitly forbidden from inventing a new finding, a new severity, or
//      a corrected query of its own. If WebGPU is unavailable or the model
//      isn't loaded, this falls back to the Tier 1 template text
//      automatically — a caller never sees a hard failure for lack of a GPU,
//      the same fallback guarantee guarded-copilot.js already gives.
//   4. NEVER writes, executes, or auto-applies anything. No import of any
//      DuckDB write/mutation helper, no import of
//      agent-action-firewall.js's confirmAndApply, no export named
//      apply/write/mutate/run/execute. A human reads a suggestion; nothing
//      in this file can act on the dataset or the query on its own. See
//      PUBLIC_API_SURFACE at the bottom — same red-team-testable pattern
//      guarded-copilot.js and query-sentinel.js already use.
//
// SCOPE (Batch 2 of 3, matches this repo's dark-ship convention): this file
// is the assist engine ONLY. It is not imported by js/app-shell/main.js yet
// — no chat/assist UI in the SQL tab. That wiring is a small, separate,
// independently-flagged follow-up once this core has run dark for a cycle,
// same batching discipline Guarded Copilot itself used (Batch 1 core, Batch
// 2 UI).
//
// PURITY: pure logic for Tier 1 — no DOM, no DuckDB, no network. Tier 2
// dynamically imports ondevice-llm.js only when a caller explicitly opts in
// via assistWithOnDeviceModel(), so this file has zero cost / zero network
// access by default, identical to guarded-copilot.js's refineWithOnDeviceModel().

export const QUERY_SENTINEL_ASSIST_KIND = 'dataglow-query-sentinel-assist';
export const QUERY_SENTINEL_ASSIST_VERSION = 1;

// ------------------------------------------------------------
// Tier 1: per-RULE_CLASS fix-sketch templates. Deliberately a fixed lookup,
// not generated — every possible output string is visible and auditable by
// reading this file, the same design Query Sentinel's own severity/message
// templates already use. Never a full corrected query: a SHAPE the analyst
// can apply themselves, e.g. "wrap X in a subquery that pre-aggregates Y".
// ------------------------------------------------------------
const FIX_SKETCH_TEMPLATES = Object.freeze({
  FANOUT:
    'Pre-aggregate the joined table in a subquery (or CTE) down to one row per join key BEFORE joining it to the driving table, so the join can no longer multiply rows ahead of your aggregate.',
  JOIN_KEY:
    'Double-check both sides of the JOIN ON: confirm the columns are the same type and that at least one side is actually unique on that column — otherwise the join key itself may not mean what it looks like it means.',
  ADDITIVITY:
    'Move the aggregate (SUM/COUNT/etc.) into a subquery that runs BEFORE the join, at the grain the joined table actually has, then join the pre-aggregated result — so per-group totals will sum back to the ungrouped total.',
  SENSITIVE_COLUMN:
    'Consider whether this sensitive column needs to be selected/filtered at all for this analysis, or whether it can be aggregated/bucketed instead of returned at the row level.',
});

/**
 * Tier 1: build a plain-text fix suggestion for one Query Sentinel flag.
 * Never re-derives whether the flag is correct — takes it as given. Returns
 * null for a flag `kind` this module has no template for (never guesses).
 * @param {{kind:string, severity:string, message:string}} flag
 * @returns {{kind:string, sketch:string}|null}
 */
export function buildFixSuggestion(flag) {
  if (!flag || typeof flag.kind !== 'string') return null;
  const sketch = FIX_SKETCH_TEMPLATES[flag.kind];
  if (!sketch) return null;
  return { kind: flag.kind, sketch };
}

/**
 * Tier 1: deterministic, template-based assist for a full Query Sentinel
 * report. Composes buildFixSuggestion() over every flag and a short
 * plain-language lead-in — zero model, zero cost, 100% predictable output
 * (Node-testable). This is what a caller gets if Tier 2 is never invoked, or
 * if Tier 2 falls back.
 * @param {{status:string, flagCount:number, flags:Array}} report - the
 *   object returned by js/validation/query-sentinel.js's runQuerySentinel().
 * @returns {{answered:boolean, text:string, suggestions:Array<{kind:string,sketch:string}>, citedFrom:string[]}}
 */
export function assistDeterministic(report) {
  const citedFrom = ['js/validation/query-sentinel.js:runQuerySentinel'];
  if (!report || !Array.isArray(report.flags) || report.flags.length === 0) {
    return {
      answered: true,
      text: 'Query Sentinel found nothing to fix on this query — no suggestions to add.',
      suggestions: [],
      citedFrom,
    };
  }
  const suggestions = [];
  const seenKinds = new Set();
  for (const flag of report.flags) {
    if (seenKinds.has(flag.kind)) continue; // one sketch per rule class, not per flag instance
    const s = buildFixSuggestion(flag);
    if (s) {
      suggestions.push(s);
      seenKinds.add(flag.kind);
    }
  }
  const lead = report.status === 'fail'
    ? 'Query Sentinel flagged one or more likely correctness bugs in this query.'
    : 'Query Sentinel flagged something worth a second look in this query.';
  const lines = suggestions.map((s) => `- [${s.kind}] ${s.sketch}`);
  const text = suggestions.length > 0
    ? `${lead}\n${lines.join('\n')}`
    : `${lead} No template fix is available for this specific finding — review the flag text above.`;
  return { answered: true, text, suggestions, citedFrom };
}

// System prompt for the Tier 2 rephrase. Deliberately as narrow as
// guarded-copilot.js's own REPHRASE_SYSTEM_PROMPT: the model may ONLY restate
// the already-computed Tier 1 flags + fix sketches in plain language. It is
// explicitly forbidden from adding a new finding, a new severity, a new fix
// idea, or a corrected query of its own — Tier 1's facts remain the single
// source of truth even when a model is in the loop.
const ASSIST_SYSTEM_PROMPT =
  'You are a careful assistant that rephrases a SQL correctness warning and its suggested fix '
  + 'shape into two or three natural, plain sentences for a data analyst. Do NOT add any new '
  + 'finding, severity, fix idea, or corrected SQL query that is not already in the provided '
  + 'text. Do NOT write or complete any SQL yourself. If you are unsure, repeat the provided '
  + 'text as-is. Never invent a verdict.';

/**
 * Tier 2 (opt-in): reuse the EXACT on-device model loader + generation
 * machinery js/narrative/ondevice-llm.js already exposes (the same module
 * Story and Guarded Copilot's own Tier 2 already use) to rephrase Tier 1's
 * deterministic assist text into more natural language. Never calls any
 * external provider, never adds facts/fixes of its own (see
 * ASSIST_SYSTEM_PROMPT), and never touches the query or the dataset. Falls
 * back to the Tier 1 text UNTOUCHED — with usedOnDeviceModel:false — whenever
 * WebGPU is missing, the model isn't loaded, or generation yields nothing,
 * so a caller never gets a hard failure or a blank answer. Identical
 * fallback contract to guarded-copilot.js's refineWithOnDeviceModel().
 *
 * The on-device module is dynamically imported (not a top-level import) so
 * Tier 1 and this file's Node tests never pay the cost of loading WebLLM.
 * Tests inject a stub via the optional `deps` param instead of loading a
 * real WebGPU model.
 *
 * @param {{status:string, flagCount:number, flags:Array}} report
 * @param {{answered:boolean, text:string, suggestions:Array}} tier1Result -
 *   the object returned by assistDeterministic() for this same report.
 * @param {{isWebGPUAvailable:Function,isModelLoaded:Function,loadModel:Function}} [deps]
 *   - injectable on-device-LLM surface; defaults to the real module.
 * @returns {Promise<{text:string, usedOnDeviceModel:boolean}>}
 */
export async function assistWithOnDeviceModel(report, tier1Result, deps = null) {
  const fallback = { text: tier1Result.text, usedOnDeviceModel: false };
  try {
    const llm = deps || await import('../narrative/ondevice-llm.js');
    // The model must already be warmed (loaded) by the caller's opt-in flow;
    // this function never triggers a ~1GB download on its own — identical
    // guarantee to guarded-copilot.js's refineWithOnDeviceModel().
    if (!llm.isWebGPUAvailable() || !llm.isModelLoaded()) return fallback;

    const engine = await llm.loadModel(); // memoized — returns the warm engine.
    const stream = await engine.chat.completions.create({
      messages: [
        { role: 'system', content: ASSIST_SYSTEM_PROMPT },
        { role: 'user', content: `Query Sentinel findings and suggested fix shape to rephrase:\n${tier1Result.text}` },
      ],
      temperature: 0.3,
      max_tokens: 220,
      stream: true,
    });
    let refined = '';
    for await (const chunk of stream) {
      refined += chunk?.choices?.[0]?.delta?.content || '';
    }
    refined = refined.trim();
    return refined ? { text: refined, usedOnDeviceModel: true } : fallback;
  } catch {
    // Any failure (no WebGPU, load error, generation error) → exact Tier 1 text.
    return fallback;
  }
}

// Explicit, testable proof of the read-only, suggestion-only guarantee: this
// module has no import of agent-action-firewall's confirmAndApply, no import
// of any DuckDB write/mutation helper, and exports nothing named
// apply/write/mutate/run/execute. A red-team test (see
// test/query-sentinel-assist.test.mjs) asserts this list stays exactly this
// shape so a future edit can't silently add a write or auto-apply path.
export const PUBLIC_API_SURFACE = Object.freeze([
  'buildFixSuggestion',
  'assistDeterministic',
  'assistWithOnDeviceModel',
]);
