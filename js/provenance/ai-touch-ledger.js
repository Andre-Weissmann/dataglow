// ============================================================
// DATAGLOW — AI Touch Ledger
// A hash-chained, tamper-evident log of every time an AI model touched a
// dataset: which model, whether the call stayed on-device or left the
// browser, which fields/columns it saw, and what human action triggered it.
// ============================================================
//
// WHY THIS EXISTS
// DataGlow already ships extensive provenance/trust infrastructure — chain of
// custody (js/provenance/provenance.js), the Assumption Ledger
// (js/provenance/assumption-ledger.js), Verifiable Check Seal, Trust Beam,
// Data Nutrition Label, Query Memory (fingerprints SQL/Python/R runs). None of
// these specifically answer: "did an AI model see this data, which model, and
// did that data ever leave this browser?" js/narrative/story.js's
// generateStory() genuinely forks into two different trust postures — an
// on-device path (WebLLM/Qwen2.5-1.5B-Instruct, zero network egress, see
// js/narrative/ondevice-llm.js) and an external-provider path (OpenAI /
// Anthropic / Gemini, which embeds real query-result rows in an HTTP request
// body to a third-party endpoint). Nothing today records which path was taken,
// for which columns, or when. This module closes that gap.
//
// PURITY: pure logic — no DOM, no engine, no network. Reuses the existing
// sha256Hex primitive from js/provenance/provenance.js; no new crypto library
// or scheme is introduced. Identical behavior in the browser, the Tauri
// desktop webview, and headless Node tests.
//
// SCOPE (Batch 1 of 2): this file is the ledger primitive and its hashing
// discipline ONLY. It is imported by nothing in js/app-shell/main.js yet —
// no UI panel, no Proof Room step, no call-site wiring. With this module
// merged and its flag off (see flags.manifest.json: aiTouchLedger, default
// false), every existing path is byte-for-byte unchanged. Batch 2 wires
// logTouch() into the real on-device/external call sites in
// js/narrative/story.js and js/narrative/ondevice-llm.js, and renders a panel
// modeled on the Assumption Ledger, composed as a sixth Proof Room step.
//
// HONEST NAMING: a hash chain (SHA-256, same primitive as the rest of
// js/provenance/) detects if an entry was edited or deleted after the fact.
// It is NOT a zero-knowledge proof, NOT "blockchain", and NOT a certification
// that the AI's output was correct — it only attests that a touch happened,
// with these parameters, and that the log of touches has not been silently
// altered since.

import { sha256Hex } from './provenance.js';

export const TOUCH_LEDGER_KIND = 'dataglow-ai-touch-ledger';
export const TOUCH_LEDGER_VERSION = 1;

// The genesis entry's parentHash — mirrors provenance.js's GENESIS_PARENT so
// every hash-chained module in this codebase anchors identically.
export const GENESIS_PARENT = '0'.repeat(64);

export const TOUCH_LEDGER_DISCLAIMER =
  'This is an AI Touch Ledger: a SHA-256 hash chain recording every time an '
  + 'AI model was invoked against this dataset — which model, whether the '
  + 'call stayed on-device or left the browser, which fields it was shown, '
  + 'and what human action triggered it. It is NOT a zero-knowledge proof, '
  + 'NOT "blockchain", and NOT a certification of the AI output\'s accuracy — '
  + 'it attests only that these touches happened, in this order, and that the '
  + 'log has not been silently edited or deleted since.';

// Fixed vocabulary for where inference actually ran. Kept as an exported
// constant (mirrors RULE_KINDS-style exports elsewhere) so callers and tests
// share one source of truth instead of duplicating string literals.
export const TOUCH_LOCATIONS = Object.freeze(['ondevice', 'external']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deterministic, order-independent serialization of the fields the hash
// commits to. Mirrors the canonicalJSON discipline in
// verifiable-check-seal.js so the same entry always hashes identically
// regardless of key insertion order.
function canonicalTouchPayload(parentHash, touch) {
  const safe = {
    parentHash,
    model: touch.model ?? null,
    location: touch.location ?? null,
    fieldsTouched: Array.isArray(touch.fieldsTouched) ? [...touch.fieldsTouched].sort() : [],
    triggeredBy: touch.triggeredBy ?? null,
    action: touch.action ?? null,
    sentTo: touch.sentTo ?? null,
    ts: touch.ts ?? null,
  };
  return JSON.stringify(safe, Object.keys(safe).sort());
}

// Validates a touch descriptor before it is allowed to enter the chain.
// Never throws — returns { valid, reason } so callers (and the eventual
// wiring in Batch 2) can decide how to surface a malformed call without a
// logging bug ever being able to crash the real AI call it is observing.
export function validateTouch(touch) {
  if (!isPlainObject(touch)) {
    return { valid: false, reason: 'touch must be a plain object' };
  }
  if (typeof touch.model !== 'string' || !touch.model.trim()) {
    return { valid: false, reason: 'touch.model is required (e.g. "Qwen2.5-1.5B-Instruct (WebLLM)")' };
  }
  if (!TOUCH_LOCATIONS.includes(touch.location)) {
    return { valid: false, reason: `touch.location must be one of: ${TOUCH_LOCATIONS.join(', ')}` };
  }
  if (touch.fieldsTouched !== undefined && !Array.isArray(touch.fieldsTouched)) {
    return { valid: false, reason: 'touch.fieldsTouched must be an array of column names when provided' };
  }
  if (touch.location === 'external' && (typeof touch.sentTo !== 'string' || !touch.sentTo.trim())) {
    return { valid: false, reason: 'touch.sentTo (destination host) is required when location is "external"' };
  }
  return { valid: true, reason: null };
}

// A hash-chained ledger for one session/dataset. Plain data + closures, no
// browser-only APIs, so it behaves identically in Node tests — same pattern
// as createProvenanceChain() in provenance.js.
export function createTouchLedger() {
  const chain = [];

  // Records one AI touch. NEVER throws: a malformed touch is appended as a
  // clearly-marked rejected entry (recorded, not silently dropped, not able
  // to break the caller) rather than either throwing into the real AI call
  // site or being silently discarded — an audit log that can silently lose
  // entries on bad input defeats its own purpose.
  async function logTouch(touch, opts = {}) {
    const { valid, reason } = validateTouch(touch);
    const parentHash = chain.length ? chain[chain.length - 1].hash : GENESIS_PARENT;
    const ts = touch && touch.ts ? touch.ts : Date.now();

    if (!valid) {
      const rejected = {
        index: chain.length,
        rejected: true,
        reason,
        raw: touch,
        ts,
        parentHash,
      };
      rejected.hash = await sha256Hex(canonicalTouchPayload(parentHash, { ...touch, ts }) + `|rejected:${reason}`);
      chain.push(rejected);
      return rejected;
    }

    const entry = {
      index: chain.length,
      rejected: false,
      model: touch.model,
      location: touch.location,
      fieldsTouched: Array.isArray(touch.fieldsTouched) ? [...touch.fieldsTouched] : [],
      triggeredBy: touch.triggeredBy ?? 'analyst',
      action: touch.action ?? null,
      sentTo: touch.location === 'external' ? touch.sentTo : null,
      ts,
      parentHash,
    };
    entry.hash = await sha256Hex(canonicalTouchPayload(parentHash, entry));
    chain.push(entry);
    return entry;
  }

  function getEntries() {
    return chain.slice();
  }

  function clear() {
    chain.length = 0;
  }

  return { logTouch, getEntries, clear };
}

// Re-derives every entry's hash from its recorded fields and parentHash and
// confirms it still matches — the same verifyProvenanceChain() discipline as
// provenance.js. Any post-hoc edit or deletion breaks the chain at the first
// altered/missing link.
export async function verifyTouchLedger(entries) {
  if (!Array.isArray(entries)) {
    return { valid: false, brokenAt: -1, reason: 'entries must be an array' };
  }
  if (entries.length === 0) {
    return { valid: true, brokenAt: -1, reason: 'Empty ledger — nothing to verify.' };
  }
  let parentHash = GENESIS_PARENT;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e.hash !== 'string' || e.parentHash !== parentHash) {
      return {
        valid: false,
        brokenAt: i,
        reason: `Entry ${i} does not chain from the previous entry — the ledger has been reordered, edited, or an entry was deleted.`,
      };
    }
    const expected = e.rejected
      ? await sha256Hex(canonicalTouchPayload(parentHash, { ...e.raw, ts: e.ts }) + `|rejected:${e.reason}`)
      : await sha256Hex(canonicalTouchPayload(parentHash, e));
    if (expected !== e.hash) {
      return {
        valid: false,
        brokenAt: i,
        reason: `Entry ${i} (${e.rejected ? 'rejected touch' : e.model}) has been modified since it was recorded — its contents no longer match its hash.`,
      };
    }
    parentHash = e.hash;
  }
  return { valid: true, brokenAt: -1, reason: `All ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} verified — the AI touch chain is intact.` };
}

// Plain-language one-liner summarizing a ledger, in the spirit of
// summarizeQueryMemory()/summarizeColumnBlame() elsewhere in this codebase.
export function summarizeTouchLedger(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 'No AI touches recorded yet.';
  }
  const valid = entries.filter((e) => !e.rejected);
  const external = valid.filter((e) => e.location === 'external');
  const rejected = entries.filter((e) => e.rejected);
  const parts = [`${valid.length} of ${entries.length} entries intact`];
  if (external.length > 0) {
    parts.push(`${external.length} external-provider touch${external.length === 1 ? '' : 'es'} flagged below`);
  } else if (valid.length > 0) {
    parts.push('all touches stayed on-device');
  }
  if (rejected.length > 0) {
    parts.push(`${rejected.length} rejected entr${rejected.length === 1 ? 'y' : 'ies'}`);
  }
  return parts.join(', ');
}

// Exports the ledger for download — mirrors exportLedger()'s format contract
// in assumption-ledger.js ('json' | 'markdown' | 'text').
export function exportTouchLedger(entries, format = 'json') {
  const generatedAt = new Date().toISOString();
  if (format === 'json') {
    return JSON.stringify({ kind: TOUCH_LEDGER_KIND, version: TOUCH_LEDGER_VERSION, generatedAt, entries }, null, 2);
  }
  const fmtTime = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  if (format === 'markdown') {
    const lines = ['# DATAGLOW AI Touch Ledger', '', `_Exported ${generatedAt}_`, ''];
    if (entries.length === 0) {
      lines.push('_No AI touches recorded yet._');
    } else {
      lines.push('| Time (UTC) | Model | Location | Fields touched | Triggered by |', '| --- | --- | --- | --- | --- |');
      for (const e of entries) {
        if (e.rejected) {
          lines.push(`| ${fmtTime(e.ts)} | _rejected_ | — | — | ${e.reason} |`);
        } else {
          lines.push(`| ${fmtTime(e.ts)} | ${e.model} | ${e.location} | ${e.fieldsTouched.join(', ')} | ${e.triggeredBy} |`);
        }
      }
    }
    return lines.join('\n');
  }
  if (entries.length === 0) return 'DATAGLOW AI Touch Ledger — no AI touches recorded yet.';
  const lines = ['DATAGLOW AI Touch Ledger', `Exported ${generatedAt}`, ''];
  for (const e of entries) {
    lines.push(e.rejected
      ? `[${fmtTime(e.ts)}] REJECTED — ${e.reason}`
      : `[${fmtTime(e.ts)}] (${e.location.toUpperCase()}) ${e.model} — fields: ${e.fieldsTouched.join(', ') || 'none'} — triggered by: ${e.triggeredBy}${e.sentTo ? ` — sent to: ${e.sentTo}` : ''}`);
  }
  return lines.join('\n');
}
