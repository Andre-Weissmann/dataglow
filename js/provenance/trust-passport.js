// ============================================================
// DATAGLOW - Trust Passport (Batch 1: pure composition engine)
// ============================================================
// WHY THIS EXISTS
// DataGlow already tracks readiness (js/gate/readiness-gate.js), every AI
// touch (js/provenance/ai-touch-ledger.js), who acted on a dataset
// (js/provenance/ownership-ledger.js), and what an agent may or may not do
// (js/agents/agent-action-firewall.js). Each of those lives on its own tab or
// panel. Nobody asking "can I trust this dataset, right now, in one look"
// gets a single answer -- they have to visit four places and assemble the
// picture themselves.
//
// This module invents NOTHING new. It reads the outputs those four modules
// already produce and composes them into one object: a score, a chain of who
// touched the dataset and when, and a plain allow/deny/gate permission table
// for AI agents. Batch 1 is read-only and in-memory only -- it does not
// export, sign, or let the passport leave the app. That is Batch 2
// (js/provenance/trust-passport-export.js), a separate flag, a separate PR.
//
// WHAT IT IS NOT. Not a fifth ledger -- it writes nothing and owns no hash
// chain of its own. Not a certification of correctness -- like every other
// provenance module in this codebase, it only reports what already happened,
// as recorded by the modules that already record it.
//
// PURITY: no DOM, no network, no storage. Identical in the browser, the
// Tauri desktop webview, and headless Node tests.

import { summarizeTouchLedger } from './ai-touch-ledger.js';
import { summarizeCurrentOwnership } from './ownership-ledger.js';
import { classifyAction, ActionRisk } from '../agents/agent-action-firewall.js';

export const TRUST_PASSPORT_VERSION = 1;

// The fixed set of agent capabilities a passport reports on. Closed
// vocabulary, same discipline as ai-touch-ledger's TOUCH_LOCATIONS -- a
// capability outside this list is not reported rather than guessed at.
export const PASSPORT_CAPABILITIES = Object.freeze([
  'read-aggregate',
  'read-row-level',
  'propose-repair',
  'auto-apply-repair',
  'export-outside-device',
]);

// Maps a capability to the firewall action-kind (or fixed verdict) that
// decides its ALLOW / DENY / GATE status. 'auto-apply-repair' and
// 'export-outside-device' are hard-coded DENY/GATE because no code path in
// this repo permits either without an explicit human confirmation -- stated
// here rather than inferred, so this table can never silently drift wider
// than what agent-action-firewall.js actually enforces.
function classifyCapability(capability) {
  switch (capability) {
    case 'read-aggregate':
      return { status: 'allow', reason: 'Aggregate/summary reads do not mutate data and are not gated by the firewall.' };
    case 'read-row-level':
      return { status: 'deny', reason: 'Row-level fields are not exposed to agents by default; no firewall action kind grants this.' };
    case 'propose-repair': {
      const c = classifyAction({ kind: 'update-values' });
      return { status: 'gate', reason: c.reason, risk: c.risk };
    }
    case 'auto-apply-repair':
      return { status: 'deny', reason: 'guardMutation() requires an explicit human confirmation object for every mutation; no code path applies one automatically.' };
    case 'export-outside-device':
      return { status: 'gate', reason: 'Exports require an owner-initiated action; nothing in this repo exports without one.' };
    default:
      return { status: 'deny', reason: `Unrecognized capability "${capability}" -- treated as denied, fail safe.` };
  }
}

/**
 * Build one Trust Passport from the outputs of the four modules it composes.
 * Never throws: any missing/malformed input degrades that section to an
 * honest "unknown" state rather than crashing the whole passport.
 *
 * @param {Object} input
 * @param {Object} input.gateResult - return value of computeReadinessGate() (or null)
 * @param {Array} input.touchEntries - AI Touch Ledger entries (or null)
 * @param {Array} input.ownershipEvents - Ownership Ledger events (or null)
 * @param {{datasetId?:string, datasetLabel?:string}} [input.meta]
 * @returns {Object} the passport
 */
export function buildTrustPassport({ gateResult, touchEntries, ownershipEvents, meta } = {}) {
  const generatedAt = new Date().toISOString();
  const safeMeta = meta && typeof meta === 'object' ? meta : {};

  const readiness = gateResult && typeof gateResult.score === 'number'
    ? { score: gateResult.score, passed: !!gateResult.passed, reasons: Array.isArray(gateResult.reasons) ? gateResult.reasons : [] }
    : { score: null, passed: null, reasons: [] };

  const touches = Array.isArray(touchEntries) ? touchEntries : [];
  const touchSummary = summarizeTouchLedger(touches);

  const ownership = summarizeCurrentOwnership(Array.isArray(ownershipEvents) ? ownershipEvents : []);

  const permissions = PASSPORT_CAPABILITIES.map((capability) => ({
    capability,
    ...classifyCapability(capability),
  }));

  return {
    kind: 'dataglow-trust-passport',
    version: TRUST_PASSPORT_VERSION,
    generatedAt,
    datasetId: typeof safeMeta.datasetId === 'string' ? safeMeta.datasetId : null,
    datasetLabel: typeof safeMeta.datasetLabel === 'string' ? safeMeta.datasetLabel : null,
    readiness,
    touchSummary,
    touchCount: touches.length,
    ownership,
    permissions,
  };
}

/** Human-readable one-line summary of a passport, for compact UI contexts. */
export function summarizeTrustPassport(passport) {
  if (!passport || passport.kind !== 'dataglow-trust-passport') {
    return 'No trust passport available.';
  }
  const scorePart = typeof passport.readiness.score === 'number'
    ? `readiness ${passport.readiness.score}`
    : 'readiness unknown';
  const deny = passport.permissions.filter((p) => p.status === 'deny').length;
  const gate = passport.permissions.filter((p) => p.status === 'gate').length;
  return `${scorePart}, ${passport.touchCount} touch${passport.touchCount === 1 ? '' : 'es'}, ${deny} capabilit${deny === 1 ? 'y' : 'ies'} denied, ${gate} gated`;
}

export { ActionRisk };
