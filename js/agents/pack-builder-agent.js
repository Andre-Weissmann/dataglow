// ============================================================
// DATAGLOW — Guided Pack Builder Agent (Gen 42, Part 4)
// ============================================================
// Ties Parts 1–3 together. It consumes CONFIRMED answers — however they arrived:
// a button tap, typed free text, on-device voice transcription, or a suggestion
// accepted from the uncertainty resolver — and incrementally assembles a valid,
// PORTABLE domain-pack JSON. It reuses the existing community-pack export path
// (js/teaching/community-pack.js) as the schema + safety rail rather than
// inventing a second pack format, and the pack no-network guard
// (js/packs/pack-network-guard.js) to prove the finished pack carries no network
// code.
//
// EMPOWERMENT CONSTRAINT (non-negotiable): a rule only enters the pack after the
// user explicitly confirms it. This agent never writes an inferred rule on its
// own — the caller passes it an answer the user has already accepted.
//
// SANDBOX / SCOPE NOTE: the portable pack vocabulary community-pack.js already
// enforces is ANNOTATE-ONLY (no-merge / benford-exempt / outlier-context) — an
// imported/authored pack can reinterpret findings but can never hard-fail data or
// target a core layer. A domain expert's learned bound ("discounts never exceed
// 100%") is therefore captured as the closest existing kind — an outlier-context
// rule whose plain-language reason records the bound — so the built pack stays
// inside that proven sandbox. Emitting a brand-new hard-fail "bound check" rule
// kind would require extending domain-physics.js + the portable schema and is
// deliberately out of scope here (flagged in the PR).
//
// This module names no network primitive and has no DOM/browser coupling.

import { PACK_KIND, PACK_SCHEMA_VERSION, validateImportedPack, importPack } from '../teaching/community-pack.js';
import { assertNoNetwork, runWithNetworkDenied } from '../packs/pack-network-guard.js';

// Schema bounds mirrored from community-pack.js so we build inside them.
const MAX_RULES = 32;
const MAX_NAME = 64;
const MAX_PATTERN = 512;

// Escape a string for safe literal use inside a RegExp source.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a tolerant column-matching pattern from a column name: split into word
// tokens and rejoin with a flexible separator so `discount_pct`, `discount pct`
// and `Discount-PCT` all match. Bounded to the schema's max pattern length.
function columnPattern(column) {
  const tokens = String(column).toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  const pat = tokens.length ? tokens.map(escapeRegExp).join('[_\\s-]?') : escapeRegExp(String(column).toLowerCase());
  return pat.slice(0, MAX_PATTERN);
}

// Classify a confirmed plain-language answer into one of the three portable rule
// kinds. Deterministic keyword routing — no LLM needed.
export function classifyRuleKind(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(merge|merging|separate|distinct|combine|consolidat)/.test(t)) return 'no-merge';
  if (/benford/.test(t)) return 'benford-exempt';
  return 'outlier-context';
}

// Strip a leading quoted column token and capitalise, for a readable summary line.
function cleanPlain(text) {
  let s = String(text || '').trim().replace(/^["'`]?[\w.-]+["'`]?\s+/, '');
  s = s || String(text || '').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function summaryLineFor(kind, plain) {
  const clean = cleanPlain(plain);
  if (kind === 'no-merge') return `${clean} → kept separate (not merged)`;
  if (kind === 'benford-exempt') return `${clean} → exempt from the Benford check`;
  return `${clean} → flagged`;
}

/**
 * Turn a confirmed answer into an intermediate learned rule (kind-agnostic
 * storage; compiled to a full descriptor at finalize time when the pack name is
 * known). `answer` is:
 *   { question, method: 'button'|'typed'|'voice'|'resolver', text }
 * For a button/resolver acceptance `text` defaults to the question's ruleGuess;
 * typed and voice inputs are parsed identically (voice is just transcribed text).
 * Returns { restatement, learnedRule }.
 */
export function interpretAnswer(answer = {}) {
  const q = answer.question || {};
  const method = answer.method || 'typed';
  const text = (answer.text != null && String(answer.text).trim() !== '')
    ? String(answer.text).trim()
    : String(q.ruleGuess || '').trim();
  if (text === '') throw new Error('pack-builder: cannot interpret an empty answer');

  const column = q.column || answer.column;
  if (!column) throw new Error('pack-builder: an answer must reference a column');

  const kind = classifyRuleKind(text);
  const learnedRule = {
    column,
    kind,
    method,
    plain: text,
    summaryLine: summaryLineFor(kind, text),
  };
  return { restatement: text, learnedRule };
}

/**
 * Accumulates confirmed rules and emits the incremental running summary and the
 * final portable pack. Session state only — nothing persisted here.
 */
export class PackBuilderSession {
  constructor(meta = {}) {
    this.rules = [];               // intermediate learned rules
    this.domain = meta.domain || '';
    this._seenColumns = new Set();
  }

  /** Add one CONFIRMED learned rule. Ignores an exact duplicate column+kind. */
  addRule(learnedRule) {
    if (!learnedRule || !learnedRule.column) throw new Error('pack-builder: a learned rule needs a column');
    if (this.rules.length >= MAX_RULES) throw new Error(`pack-builder: a pack may hold at most ${MAX_RULES} rules`);
    const key = `${learnedRule.column}::${learnedRule.kind}`;
    if (this._seenColumns.has(key)) return this; // already learned — idempotent
    this._seenColumns.add(key);
    this.rules.push(learnedRule);
    return this;
  }

  /** Convenience: interpret a confirmed answer and add it in one call. */
  addConfirmedAnswer(answer) {
    const { learnedRule, restatement } = interpretAnswer(answer);
    this.addRule(learnedRule);
    return { restatement, learnedRule };
  }

  /**
   * The running-summary view shown after each confirmed rule:
   *   "Here's everything I've learned so far:" + one bullet per rule +
   *   [Add another] [I'm done — save my pack].
   */
  buildRunningSummaryView() {
    return {
      heading: "Here's everything I've learned so far:",
      lines: this.rules.map(r => r.summaryLine),
      actions: [
        { id: 'add-another', label: 'Add another' },
        { id: 'done', label: "I'm done — save my pack" },
      ],
    };
  }

  // Compile an intermediate learned rule into a full portable rule descriptor
  // valid against community-pack.js's strict schema, given the final pack label.
  _compileRule(r, idx, packLabel) {
    const id = `${slug(r.column)}-${r.kind}-${idx}`.slice(0, MAX_NAME);
    const match = { pattern: columnPattern(r.column), flags: 'i' };
    const description = r.plain.slice(0, 2000);
    if (r.kind === 'no-merge') {
      return { kind: 'no-merge', id, description, match, note: r.plain.slice(0, 2000) };
    }
    if (r.kind === 'benford-exempt') {
      match.numericOnly = true;
      return { kind: 'benford-exempt', id, description, match, packLabel: packLabel.slice(0, MAX_NAME), note: r.plain.slice(0, 2000) };
    }
    // outlier-context (default): numeric column, plain reason carries the bound.
    match.numericOnly = true;
    return { kind: 'outlier-context', id, description, match, packLabel: packLabel.slice(0, MAX_NAME), reason: r.plain.slice(0, 2000) };
  }

  /**
   * Build the final portable pack envelope from the confirmed rules + metadata,
   * then run it through the EXISTING schema validator and the no-network guard,
   * and compile it via the community-pack import path (registration). All of it
   * runs inside runWithNetworkDenied() as defence in depth.
   *
   * @param {{name:string,label?:string,description?:string}} meta
   * @returns {{ok:boolean, errors:string[], envelope:object|null, json:string|null, pack:object|null}}
   */
  finalize(meta = {}) {
    const name = String(meta.name || '').trim();
    const label = String(meta.label || name).trim();
    const description = String(meta.description || `Rules taught by a ${this.domain || 'domain'} expert.`).trim();

    if (name === '') return fail(['pack: a name is required to save the pack']);
    if (name === 'none' || name === 'healthcare') return fail([`pack: "${name}" is reserved for a built-in pack`]);
    if (this.rules.length === 0) return fail(['pack: add at least one confirmed rule before saving']);

    const envelope = {
      kind: PACK_KIND,
      schemaVersion: PACK_SCHEMA_VERSION,
      pack: {
        name, label, description,
        rules: this.rules.map((r, i) => this._compileRule(r, i, label)),
      },
    };

    // Everything below is pure data-processing; deny the network around it to
    // prove the build path never reaches out (the guard's runtime trap).
    return runWithNetworkDenied(() => {
      // 1) No-network guard over the serialized pack (data-only → always clean,
      //    but this is the required, explicit guard step).
      try {
        assertNoNetwork(JSON.stringify(envelope), name);
      } catch (e) {
        return fail([e.message]);
      }
      // 2) Existing strict schema validator.
      const { valid, errors } = validateImportedPack(envelope);
      if (!valid) return fail(errors);
      // 3) Register via the community-pack import/compile path.
      const imported = importPack(envelope);
      if (!imported.ok) return fail(imported.errors);
      return {
        ok: true, errors: [], envelope,
        json: JSON.stringify(envelope, null, 2),
        pack: imported.pack,
      };
    });
  }

  /** Save/share choices offered on a successful finalize. */
  static saveOptionsView() {
    return {
      actions: [
        { id: 'save-local', label: 'Save locally' },
        { id: 'export-share', label: 'Export to share' },
      ],
    };
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'col';
}

function fail(errors) {
  return { ok: false, errors: Array.isArray(errors) ? errors : [String(errors)], envelope: null, json: null, pack: null };
}
