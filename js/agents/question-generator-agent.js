// ============================================================
// DATAGLOW — Data-Grounded Question Generator (Gen 42, Part 1)
// ============================================================
// The cold-start fix for pack authoring. Instead of a blank text box, this agent
// reads the findings the existing 20-layer validation pipeline already produced
// and turns the most "askable" anomalies into plain-English, DATA-GROUNDED
// questions a non-technical domain expert can answer with one tap. Every question
// references a REAL value found in the user's own loaded data — never a blind,
// generic "what should never happen?" prompt.
//
// Askability priority (highest first), per the feature spec:
//   1. Mathematically impossible values (percentage > 100%, negative counts,
//      future dates in historical data).
//   2. Extreme statistical outliers (>3 std dev from the mean; single-occurrence
//      rare values).
//   3. Missing-data clusters (the MCAR/MAR/MNAR findings the Missingness
//      Detective already computed).
//   4. Format inconsistencies (the format-fingerprint drift already detected).
//
// GRACEFUL DEGRADATION: question generation is fully deterministic — it fills the
// fixed template from the finding's own numbers, so it needs NO LLM to work. When
// the on-device LLM is available a caller may use buildQuestionPrompt() to have it
// polish wording, but the template (and its real values) remains the source of
// truth, so on a low-end device without WebGPU the flow is identical minus the
// cosmetic rephrase. This module names no network primitive and no browser global.

// AI Readiness Gate (batch 3) — the pure agent hard-block helper. Imported here
// only for the OPTIONAL gate consulted when a caller threads opts.readiness (see
// generateQuestions below). Pure logic, names no network primitive/browser global.
import { evaluateAgentReadiness, buildAgentRefusal } from '../gate/agent-gate.js';

// Category → base priority weight. Higher wins; ties broken by the candidate's
// own `severity` (0..1) then stable input order.
export const CATEGORY_WEIGHT = Object.freeze({
  impossible: 4,
  outlier: 3,
  missingness: 2,
  format: 1,
});

export const CATEGORY_ORDER = Object.freeze(['impossible', 'outlier', 'missingness', 'format']);

// The exact question template. `{column}`, `{observation}`, `{ruleGuess}` are the
// only substitution points — the spec fixes this wording verbatim.
export function renderQuestionText(column, observation, ruleGuess) {
  return `I noticed your \`${column}\` column has ${observation}. Is that expected, or should ${ruleGuess}?`;
}

// A candidate must carry a concrete, real observed value so the question can
// never be generic. `value` is the actual data point (number/string/date text).
function isGroundedCandidate(c) {
  return c && typeof c === 'object'
    && typeof c.column === 'string' && c.column !== ''
    && CATEGORY_ORDER.includes(c.category)
    && typeof c.observation === 'string' && c.observation.trim() !== ''
    && c.value != null && String(c.value).trim() !== ''
    // the real value MUST appear in the observation text — this is what makes the
    // question data-grounded rather than a blind template.
    && c.observation.includes(String(c.value));
}

function priorityScore(c) {
  const base = CATEGORY_WEIGHT[c.category] || 0;
  const sev = typeof c.severity === 'number' ? Math.max(0, Math.min(1, c.severity)) : 0;
  return base + sev; // base dominates category order; severity ranks within it
}

/**
 * Rank grounded candidates and return the top N (default 3–5) askable ones.
 * Non-grounded candidates are dropped so a generic question can never surface.
 * @param {Array<object>} candidates
 * @param {{max?:number, min?:number}} [opts]
 * @returns {Array<object>} sorted, grounded candidates (highest priority first)
 */
export function scanForAskableAnomalies(candidates, opts = {}) {
  const max = opts.max ?? 5;
  const grounded = (Array.isArray(candidates) ? candidates : []).filter(isGroundedCandidate);
  const ranked = grounded
    .map((c, i) => ({ c, i, s: priorityScore(c) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.c);
  return ranked.slice(0, Math.max(0, max));
}

// The two primary, equal-weight response buttons the spec dictates.
export const PRIMARY_RESPONSES = Object.freeze([
  Object.freeze({ id: 'accept', label: 'Sounds right — use that' }),
  Object.freeze({ id: 'skip', label: 'Skip for now' }),
]);

/**
 * Build one question object from a grounded candidate.
 * @returns {{column,category,observation,ruleGuess,value,text}}
 */
export function buildQuestion(candidate) {
  if (!isGroundedCandidate(candidate)) {
    throw new Error('question-generator: refusing to build a non-grounded (generic) question — every question must reference a real value from the loaded data.');
  }
  return {
    column: candidate.column,
    category: candidate.category,
    observation: candidate.observation,
    ruleGuess: candidate.ruleGuess,
    value: candidate.value,
    text: renderQuestionText(candidate.column, candidate.observation, candidate.ruleGuess),
  };
}

/**
 * Full view model for the Validate-tab header presenter (one question at a time,
 * inline — never a separate modal). The free-text field is a LOW-EMPHASIS
 * progressive-disclosure fallback below the two primary buttons — not a third
 * equal-weight button. Voice is offered only when the caller reports it available
 * (WebGPU/WASM speech model present); otherwise the mic is silently hidden.
 */
export function buildQuestionView(candidate, opts = {}) {
  const q = buildQuestion(candidate);
  const voiceEnabled = opts.voiceEnabled === true;
  return {
    question: q,
    primary: PRIMARY_RESPONSES.map(r => ({ ...r })),
    freeText: {
      emphasis: 'low',              // smaller type, lighter colour per the spec
      placeholder: '…or just tell me in your own words',
      micIcon: voiceEnabled,        // hidden entirely when voice is unavailable
      voiceEnabled,
      ghostSuggestions: Array.isArray(opts.ghostSuggestions) ? opts.ghostSuggestions.slice(0, 5) : [],
    },
  };
}

// Confirmation is identical regardless of input method (button / typed / voice /
// resolver), per the spec: a single "Got it" restatement of what they said.
export function confirmRestatement(restatement) {
  const text = (restatement == null ? '' : String(restatement)).trim();
  return `✅ Got it: ${text}`;
}

// ------------------------------------------------------------
// Ghost-text inline autocomplete (accept with Tab; ignorable by typing through).
// Suggestions are drawn from the local pack index (Part 3) and a small set of
// common patterns seen in built-in packs. Pure string work — no I/O.
// ------------------------------------------------------------
export const COMMON_PATTERN_SUGGESTIONS = Object.freeze([
  'never go above 100%',
  'never be negative',
  'stay within the expected range',
  'not include future dates',
  'be flagged when it looks like an outlier',
  'keep these categories separate (do not merge them)',
]);

/**
 * Compute the single best ghost-text completion for what the user has typed so
 * far. Returns the SUFFIX to show inline (empty string when nothing matches, so
 * the caller renders no ghost text). Peer suggestions (from the local pack index)
 * rank ahead of the generic common patterns.
 */
export function ghostCompletion(typed, opts = {}) {
  const prefix = (typed == null ? '' : String(typed)).toLowerCase().trimStart();
  if (prefix === '') return '';
  const peer = Array.isArray(opts.peerSuggestions) ? opts.peerSuggestions : [];
  const pool = [...peer, ...COMMON_PATTERN_SUGGESTIONS];
  for (const s of pool) {
    const cand = String(s);
    if (cand.toLowerCase().startsWith(prefix) && cand.length > prefix.length) {
      return cand.slice(prefix.length); // the remaining suffix to render as ghost
    }
  }
  return '';
}

// ------------------------------------------------------------
// LLM polish (optional). Pure prompt builder mirroring ondevice-llm.js style, so
// a caller with the on-device model can rephrase the fixed template into warmer
// wording WITHOUT ever inventing a value. The real value is passed explicitly and
// the instruction pins it. Never required — the deterministic template stands
// alone for graceful degradation.
// ------------------------------------------------------------
const POLISH_SYSTEM_PROMPT = [
  "You are DATAGLOW's pack-authoring assistant, running entirely on the user's own device.",
  'You rephrase ONE data-quality question for a non-technical domain expert.',
  'You must keep the exact column name and the exact observed value unchanged — never invent, round, or drop a number.',
  'Return a single sentence ending in a question mark. Do not add options, code, or commentary.',
].join(' ');

export function buildQuestionPrompt(candidate) {
  const q = buildQuestion(candidate);
  const user = [
    `Column: ${q.column}`,
    `Observed value (must appear verbatim): ${q.value}`,
    `Plain-English observation: ${q.observation}`,
    `Proposed rule to confirm: ${q.ruleGuess}`,
    '',
    'Rephrase this into one friendly question that keeps the column name and the observed value verbatim:',
    q.text,
  ].join('\n');
  return {
    system: POLISH_SYSTEM_PROMPT,
    user,
    messages: [
      { role: 'system', content: POLISH_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  };
}

// ============================================================
// Candidate extraction from real pipeline output + heuristic fallback
// ============================================================
// A tolerant reader that pulls grounded candidates out of the shapes DATAGLOW's
// layers actually emit. It reads defensively (every field optional) so a changed
// layer shape degrades to "fewer candidates", never a crash.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// 1 & 2 — impossible values and extreme outliers from per-column stats. This is
// also the LOW-END DEVICE FALLBACK path (percentile / z-score thresholds) the
// spec asks for when no richer finding exists: pure arithmetic, no LLM.
export function heuristicCandidatesFromStats(columnStats = []) {
  const out = [];
  for (const s of Array.isArray(columnStats) ? columnStats : []) {
    if (!s || typeof s.column !== 'string') continue;
    const looksPercent = /(pct|percent|rate|ratio|share|discount)/i.test(s.column);
    const max = num(s.max), min = num(s.min), mean = num(s.mean), std = num(s.std);

    // Mathematically impossible: a percentage-like column exceeding 100.
    if (looksPercent && max != null && max > 100) {
      out.push({
        column: s.column, category: 'impossible', value: max,
        observation: `values up to ${max}%`,
        ruleGuess: `${humanCol(s.column)} never go above 100%`,
        severity: Math.min(1, (max - 100) / 100),
      });
      continue;
    }
    // Mathematically impossible: a count/quantity-like column going negative.
    if (/(count|qty|quantity|units|age|amount|total)/i.test(s.column) && min != null && min < 0) {
      out.push({
        column: s.column, category: 'impossible', value: min,
        observation: `a minimum value of ${min}`,
        ruleGuess: `${humanCol(s.column)} never be negative`,
        severity: 1,
      });
      continue;
    }
    // Extreme statistical outlier: a max more than 3 SD above the mean.
    if (max != null && mean != null && std != null && std > 0) {
      const z = (max - mean) / std;
      if (z > 3) {
        out.push({
          column: s.column, category: 'outlier', value: max,
          observation: `an extreme value of ${max} (about ${z.toFixed(1)} standard deviations above the average)`,
          ruleGuess: `${humanCol(s.column)} be flagged when it is that far from typical`,
          severity: Math.min(1, z / 10),
        });
      }
    }
  }
  return out;
}

// 3 — missingness clusters from the Missingness Detective findings (see
// js/validation/missingness-detective.js buildColumnReport output shape).
export function candidatesFromMissingness(findings = []) {
  const out = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || typeof f.column !== 'string') continue;
    const rate = num(f.missingRate); // already a whole/one-decimal percent
    if (rate == null) continue;
    out.push({
      column: f.column, category: 'missingness', value: rate,
      observation: `${rate}% of its values missing${f.classification ? ` (${f.classification})` : ''}`,
      ruleGuess: f.classification === 'MCAR'
        ? `that be treated as ordinary random gaps`
        : `records with missing ${humanCol(f.column)} be reviewed before you rely on them`,
      severity: Math.min(1, rate / 100),
    });
  }
  return out;
}

// 4 — format inconsistencies. Reads a tolerant { column, examples:[...] } shape
// (as surfaced by format-fingerprint drift) and grounds the question in a real
// example string.
export function candidatesFromFormatDrift(driftItems = []) {
  const out = [];
  for (const d of Array.isArray(driftItems) ? driftItems : []) {
    if (!d || typeof d.column !== 'string') continue;
    const example = Array.isArray(d.examples) && d.examples.length ? String(d.examples[0]) : (d.example != null ? String(d.example) : null);
    if (!example) continue;
    out.push({
      column: d.column, category: 'format', value: example,
      observation: `mixed formats, for example "${example}"`,
      ruleGuess: `${humanCol(d.column)} follow one consistent format`,
      severity: typeof d.severity === 'number' ? d.severity : 0.4,
    });
  }
  return out;
}

// Turn a column name into a readable subject ("discount_pct" → "discount pct").
function humanCol(name) {
  return `"${name}"`;
}

/**
 * One-call extractor: assemble grounded candidates from whatever pipeline output
 * is available, then rank. `ctx` may carry any subset of
 * { columnStats, missingness, formatDrift } — each optional.
 *
 * AI READINESS GATE (batch 3): when — and ONLY when — the caller threads
 * `opts.readiness` ({ layerResults, metricContractStatus, options }), this agent
 * first asks the gate whether the underlying data is agent-consumable. If not, it
 * returns a graceful refusal object ({ blocked:true, ... }) INSTEAD of questions,
 * so an agent never authors output from ungoverned data. With no `opts.readiness`
 * (the default for every existing caller and test) the gate is not consulted and
 * behaviour is unchanged. This gates the AGENT only — humans are never affected.
 */
export function generateQuestions(ctx = {}, opts = {}) {
  if (opts.readiness) {
    const evalResult = evaluateAgentReadiness(opts.readiness);
    if (evalResult.blocked) {
      return buildAgentRefusal('question-generator-agent', evalResult);
    }
  }
  const candidates = [
    ...heuristicCandidatesFromStats(ctx.columnStats),
    ...candidatesFromMissingness(ctx.missingness),
    ...candidatesFromFormatDrift(ctx.formatDrift),
  ];
  return scanForAskableAnomalies(candidates, opts).map(buildQuestion);
}
