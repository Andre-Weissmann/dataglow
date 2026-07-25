// ============================================================
// DATAGLOW - AI claim guard
// ============================================================
//
// The Guarded Copilot answers in two tiers. Tier 1 is deterministic: a rule
// reads an engine result and produces a sentence, and every number in that
// sentence came from the engine. Tier 2 hands that sentence to the on-device
// model and asks it to say the same thing better.
//
// The prompt tells the model not to invent numbers. That is the correct thing
// to put in a prompt and it is not a control. A model that transposes 1,204
// into 1,240, or helpfully rounds 47.3% to "nearly half" and then writes 50%,
// has done exactly what language models do, and the result is a wrong number in
// a confident sentence with no mark on it. The only reliable place to catch
// that is after generation, by comparing.
//
// WHAT THIS DOES.
// Tier 1's text is the ground truth. Its numbers become the set of values the
// rephrase is allowed to contain, and Bundle 10's prove gate does the comparing,
// including its rounding policy: a number rendered to fewer places still binds,
// a different number does not. If the rephrase introduces anything unbound, the
// deterministic text is returned verbatim and the reason is named.
//
// WHY FALLING BACK BEATS STRIPPING.
// A sentence with its numbers removed is worse than the plain sentence it was
// meant to improve: it reads as prose, it has lost the thing it was about, and
// nobody can tell by looking that it was edited. Tier 1's text always exists and
// is always correct, so the cheapest safe move is to use it. The refusal is
// reported rather than hidden, because a silent downgrade teaches the user
// nothing about why the answer looks plainer than usual.
//
// WHY THIS IS NOT INSIDE guarded-copilot.js.
// That module declares a frozen four-function public surface that a red-team
// test asserts by exact equality, and its whole claim is that it is read-only.
// Growing it is the wrong direction. The guard lives here, is called from
// there, and can be tested on its own.
//
// Pure apart from importing the gate. No DOM, no network, no model.

import { extractNumbers, assertClaimAllowed, describeGateResult } from './prove-gate.js';

export const AI_CLAIM_GUARD_KIND = 'dataglow-ai-claim-guard';
export const AI_CLAIM_GUARD_VERSION = 1;

export const GUARD_DOCTRINE =
  'A model may rephrase a sentence. It may not introduce a number. Every number in a rephrase is checked against the numbers the engine produced, and a rephrase that fails the check is discarded in favour of the sentence it was given.';

export const FALLBACK_REASON =
  'The rephrased answer contained a number the engine did not produce, so the deterministic answer was kept instead.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Turn a trusted deterministic sentence into the set of values a rephrase of it
 * is permitted to contain.
 *
 * Each is labelled by its position rather than by meaning, because this layer
 * does not know what the numbers are about. It only knows the engine said them.
 */
export function groundTruthValues(deterministicText) {
  const found = extractNumbers(str(deterministicText));
  return found.map((n, i) => ({
    id: 'tier1-' + i,
    label: 'Deterministic answer value ' + (i + 1),
    value: n.value,
    unit: '',
    sqlOrCode: 'deterministic',
  }));
}

/**
 * Check a model rephrase against the deterministic answer it was given.
 *
 * @param {string} deterministicText the Tier 1 answer, treated as ground truth
 * @param {string} modelText the Tier 2 rephrase
 * @param {{proofBoardTiles?:Array}} [opts]
 * @returns {{allowed:boolean, text:string, usedOnDeviceModel:boolean, reason:string, gate:object, summary:string}}
 */
export function guardModelRephrase(deterministicText, modelText, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const base = str(deterministicText);
  const candidate = str(modelText).trim();

  if (!candidate || candidate === base.trim()) {
    return {
      allowed: true,
      text: base,
      usedOnDeviceModel: false,
      reason: 'No rephrase to check.',
      gate: null,
      summary: 'No rephrase to check.',
    };
  }

  const tiles = Array.isArray(o.proofBoardTiles) ? o.proofBoardTiles : [];
  const gate = assertClaimAllowed(candidate, tiles, {
    engineResults: groundTruthValues(base),
  });

  if (gate.allowed) {
    return {
      allowed: true,
      text: candidate,
      usedOnDeviceModel: true,
      reason: 'Every number in the rephrase matched a number the engine produced.',
      gate,
      summary: describeGateResult(gate),
    };
  }

  return {
    allowed: false,
    text: base,
    usedOnDeviceModel: false,
    reason: FALLBACK_REASON,
    gate,
    summary: describeGateResult(gate),
  };
}

/**
 * A ledger entry for the guard decision, in the shape the AI Touch Ledger takes.
 *
 * Recorded whether or not the rephrase passed. A ledger that only holds the
 * refusals cannot tell you how often the model was trusted, and a ledger that
 * only holds the passes is a highlight reel.
 */
export function guardLedgerEntry(result) {
  const r = isPlainObject(result) ? result : {};
  const gate = isPlainObject(r.gate) ? r.gate : null;
  return {
    step: 'ai-claim-guard',
    outcome: r.allowed ? 'rephrase-kept' : 'rephrase-discarded',
    reason: str(r.reason),
    numbersChecked: gate && Array.isArray(gate.numbers) ? gate.numbers.length : 0,
    unbound: gate && Array.isArray(gate.unbound) ? gate.unbound.map(u => str(u.number)) : [],
  };
}

export const DataGlowAiClaimGuard = {
  AI_CLAIM_GUARD_KIND,
  AI_CLAIM_GUARD_VERSION,
  GUARD_DOCTRINE,
  FALLBACK_REASON,
  groundTruthValues,
  guardModelRephrase,
  guardLedgerEntry,
};

try {
  if (typeof window !== 'undefined') window.DataGlowAiClaimGuard = DataGlowAiClaimGuard;
} catch (_e) {}
