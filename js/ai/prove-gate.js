// ============================================================
// DATAGLOW - AI prove gate
// ============================================================
//
// The doctrine this file enforces: AI proposes, engines adjudicate, a human
// confirms. The specific failure it exists to stop is an AI narrative that
// states a number nothing computed. A sentence like "we cut processing time by
// 40%" is indistinguishable, to a reader, from a sentence backed by a query.
// The only difference is whether some engine actually produced the 40, and the
// only place this app records that is the Proof Board.
//
// So this module is a binder, not a spell-checker. It pulls every number out of
// a piece of prose and tries to bind each one to a tile that carries the value
// and the code that produced it. A number that binds is quotable. A number that
// does not bind is refused by name, so the caller can delete it or go compute
// it, rather than being told the text "may contain unverified claims".
//
// WHY A BLOCKED TILE CANNOT BACK A CLAIM.
// The four badges are not decoration. `blocked` means a check reported that
// this number is wrong or unsafe to publish. A number whose own check failed is
// worse than an unbacked number, because quoting it launders a known problem
// through the Proof Board. `unknown` is different: the number was computed by
// an engine and no check has reported on it. That binds, but the binding is
// marked unchecked and the caller is told, because "no check has run" must
// never quietly read as "this passed".
//
// WHY ROUNDING IS ALLOWED AND NOTHING ELSE IS.
// A tile holding 94.7312 written in prose as "95%" is honest rounding, and
// forcing the author to paste four decimals into a sentence would make the gate
// something people route around. So a claim binds if it is a correct rounding
// of a tile value to the precision the author actually wrote. 94.7312 backs
// "94.7" and "95". It does not back "96". Rounding is a rendering of a real
// number; anything else is a different number.
//
// Pure. No DOM, no network, no clock. Nothing here throws: a gate that crashes
// on malformed input is a gate that callers wrap in try/catch and ignore.

export const PROVE_GATE_KIND = 'dataglow-prove-gate';
export const PROVE_GATE_VERSION = 1;

// Badges that can back a quoted number, and the one that cannot. Kept as data
// so the reason for a refusal can be read off the same table that makes it.
export const PROVABLE_BADGES = Object.freeze(['clear', 'caution', 'unknown']);
export const UNPROVABLE_BADGES = Object.freeze(['blocked']);

export const BADGE_BINDING_NOTES = Object.freeze({
  clear: 'A check reported on this number and it passed.',
  caution: 'A check reported on this number and passed it with cautions.',
  unknown: 'An engine computed this number but no check has reported on it. That is an absence of evidence, not a pass.',
  blocked: 'A check reported on this number and blocked it. A blocked number must not be quoted as a result.',
});

export const PROVE_GATE_DOCTRINE =
  'AI proposes, engines adjudicate, a human confirms. No number is published unless an engine computed it and the code that produced it can be shown.';

export const NO_TILES_REASON =
  'There is nothing on the Proof Board yet, so no number in this text can be traced to anything that was computed.';

// Numbers that are part of a date, a time or a dotted version are not claims
// about the data, and treating them as claims would make the gate refuse its
// own method line. They are masked out before extraction rather than special
// cased afterwards, so the extractor stays a single simple rule.
const MASK_PATTERNS = Object.freeze([
  /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, // ISO timestamp
  /\d{4}-\d{2}-\d{2}/g, // ISO date
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g, // clock time
  /\bv?\d+\.\d+\.\d+\b/g, // dotted version
]);

const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

function str(v) {
  return typeof v === 'string' ? v : '';
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/,/g, '').trim();
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Replace date-like and version-like runs with spaces of equal length so the
 *  character offsets of the remaining numbers stay true to the original text. */
export function maskNonClaimNumbers(text) {
  let out = str(text);
  for (const re of MASK_PATTERNS) {
    out = out.replace(re, m => ' '.repeat(m.length));
  }
  return out;
}

/** Every number a reader would take as a claim, in order, with its offset. */
export function extractNumbers(text) {
  const masked = maskNonClaimNumbers(text);
  const found = [];
  let m;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(masked)) !== null) {
    const raw = m[0];
    const value = toFiniteNumber(raw);
    if (value === null) continue;
    const dot = raw.indexOf('.');
    found.push({
      text: raw,
      value,
      index: m.index,
      decimals: dot < 0 ? 0 : raw.length - dot - 1,
    });
  }
  return found;
}

/** True when `claimed` is what `actual` looks like written to `decimals` places.
 *  This is the whole of the tolerance policy: a rendering binds, a different
 *  number does not. */
export function isRoundingOf(claimed, actual, decimals) {
  if (!Number.isFinite(claimed) || !Number.isFinite(actual)) return false;
  if (claimed === actual) return true;
  const d = Number.isInteger(decimals) && decimals >= 0 ? Math.min(decimals, 12) : 0;
  const factor = Math.pow(10, d);
  return Math.round(actual * factor) / factor === claimed;
}

/** The set of numbers the board can currently back, each with its tile. */
export function provableValues(tiles) {
  const list = Array.isArray(tiles) ? tiles : [];
  const out = [];
  for (const t of list) {
    if (!isPlainObject(t)) continue;
    const value = toFiniteNumber(t.value);
    if (value === null) continue;
    const badge = str(t.gateBadge) || 'unknown';
    out.push({
      id: str(t.id),
      title: str(t.title),
      value,
      unit: str(t.unit),
      gateBadge: badge,
      provable: UNPROVABLE_BADGES.indexOf(badge) < 0,
      note: BADGE_BINDING_NOTES[badge] || BADGE_BINDING_NOTES.unknown,
      hasCode: str(t.sqlOrCode).trim() !== '',
      source: 'proof-board-tile',
    });
  }
  return out;
}

/** Engine results a caller vouches for directly, in the same shape as a tile
 *  binding. Used by the NL to SQL path, where a number exists as a query result
 *  before anyone has decided to keep it as a tile. */
export function engineValues(results) {
  const list = Array.isArray(results) ? results : [];
  const out = [];
  for (const r of list) {
    if (!isPlainObject(r)) continue;
    const value = toFiniteNumber(r.value);
    if (value === null) continue;
    out.push({
      id: str(r.id) || str(r.label),
      title: str(r.label) || str(r.title),
      value,
      unit: str(r.unit),
      gateBadge: 'unknown',
      provable: true,
      note: BADGE_BINDING_NOTES.unknown,
      hasCode: str(r.sqlOrCode).trim() !== '',
      source: 'engine-result',
    });
  }
  return out;
}

/**
 * Decide whether a piece of prose may be published.
 *
 * Returns, never throws:
 *   { allowed, kind, version, claim, numbers, bindings, unbound, refused,
 *     cautions, reasons, checkedCount, uncheckedCount }
 *
 * `unbound` is the list this exists for: numbers with nothing behind them.
 * `refused` is narrower and worse: numbers that match a tile whose own check
 * blocked it.
 */
export function assertClaimAllowed(claim, proofBoardTiles, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const text = str(claim);
  const candidates = provableValues(proofBoardTiles).concat(engineValues(options.engineResults));
  const numbers = extractNumbers(text);

  const bindings = [];
  const unbound = [];
  const refused = [];
  const cautions = [];
  const reasons = [];

  for (const n of numbers) {
    const matches = candidates.filter(c => isRoundingOf(n.value, c.value, n.decimals));
    const usable = matches.filter(c => c.provable);
    if (usable.length) {
      const pick = usable[0];
      bindings.push({ number: n.text, value: n.value, index: n.index, tileId: pick.id, tileTitle: pick.title, gateBadge: pick.gateBadge, source: pick.source, note: pick.note });
      if (pick.gateBadge === 'unknown') {
        cautions.push('The number ' + n.text + ' comes from ' + (pick.title || 'an engine result') + ', which no check has reported on. Say so or run a check before publishing it as a result.');
      }
      continue;
    }
    if (matches.length) {
      refused.push({ number: n.text, value: n.value, index: n.index, tileId: matches[0].id, tileTitle: matches[0].title, gateBadge: matches[0].gateBadge, why: BADGE_BINDING_NOTES[matches[0].gateBadge] || BADGE_BINDING_NOTES.blocked });
      continue;
    }
    unbound.push({ number: n.text, value: n.value, index: n.index });
  }

  if (!candidates.length && numbers.length) reasons.push(NO_TILES_REASON);
  for (const u of unbound) {
    reasons.push('The number ' + u.number + ' is not on the Proof Board and no engine result was supplied for it, so nothing here shows where it came from.');
  }
  for (const r of refused) {
    reasons.push('The number ' + r.number + ' matches ' + (r.tileTitle || 'a tile') + ', but that tile is ' + r.gateBadge + '. ' + r.why);
  }

  const checkedCount = bindings.filter(b => b.gateBadge !== 'unknown').length;
  return {
    kind: PROVE_GATE_KIND,
    version: PROVE_GATE_VERSION,
    allowed: unbound.length === 0 && refused.length === 0,
    claim: text,
    numbers,
    bindings,
    unbound,
    refused,
    cautions,
    reasons,
    checkedCount,
    uncheckedCount: bindings.length - checkedCount,
  };
}

/** A one-line human answer for a toast or a status row. */
export function describeGateResult(result) {
  if (!isPlainObject(result)) return 'No gate result.';
  if (result.allowed) {
    if (result.uncheckedCount > 0) {
      return 'Every number traces to the Proof Board, but ' + result.uncheckedCount + ' of them has had no check reported on it.';
    }
    if (!result.bindings.length) return 'No numbers in this text, so there is nothing to prove.';
    return 'All ' + result.bindings.length + ' number(s) trace to a Proof Board tile that shows its work.';
  }
  const parts = [];
  if (result.unbound.length) parts.push(result.unbound.length + ' number(s) with nothing behind them');
  if (result.refused.length) parts.push(result.refused.length + ' number(s) from a blocked tile');
  return 'Refused: ' + parts.join(' and ') + '.';
}

export const DataGlowProveGate = {
  PROVE_GATE_KIND,
  PROVE_GATE_VERSION,
  PROVABLE_BADGES,
  UNPROVABLE_BADGES,
  BADGE_BINDING_NOTES,
  PROVE_GATE_DOCTRINE,
  NO_TILES_REASON,
  maskNonClaimNumbers,
  extractNumbers,
  isRoundingOf,
  provableValues,
  engineValues,
  assertClaimAllowed,
  describeGateResult,
};

try {
  if (typeof window !== 'undefined') window.DataGlowProveGate = DataGlowProveGate;
} catch (_e) {}
