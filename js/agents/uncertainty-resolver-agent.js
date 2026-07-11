// ============================================================
// DATAGLOW — "I Don't Know" Resolution Engine (Gen 42, Part 2)
// ============================================================
// When a domain expert is unsure ("I don't know", "not sure", an empty skip on a
// question flagged uncertain), DATAGLOW must not dead-end. This agent resolves
// the uncertainty ENTIRELY ON-DEVICE, in a fixed order, before ever re-asking:
//
//   STEP A — Statistical Confidence Check. A value that is >3 SD out AND rare AND
//            violates a HARD mathematical constraint (e.g. a percentage > 100%)
//            needs no debate — go straight to a confident suggestion.
//   STEP B — Local Peer-Sourced Pack Index. Check the read-only community index
//            (js/packs/local-pack-index.js) for the same domain + column pattern
//            and, if found, offer to borrow it (never auto-apply).
//   STEP C — Three-Agent Debate Panel (only if A and B are inconclusive). Three
//            lightweight prompt-based agents — Conservative, Industry-Norm,
//            Statistical — run SEQUENTIALLY against the SAME on-device LLM (one
//            WebGPU context, never parallel). Their proposals are combined by
//            confidence-weighted reconciliation (not a blind majority vote). A
//            2-second average budget caps the whole resolution; blow the budget
//            and we skip to a safe fallback default.
//   STEP D — Present ONE unified suggestion (the debate/steps are NEVER shown).
//   STEP E — Park-and-Revisit. A SECOND "I don't know" parks the finding rather
//            than re-asking; after a few other answers we may revisit it with NEW
//            evidence found elsewhere in the same dataset.
//
// EMPOWERMENT CONSTRAINT (non-negotiable): every suggestion this engine produces
// is only ever a SUGGESTION. Nothing here writes a rule into a pack — the user
// must confirm upstream (see js/agents/pack-builder-agent.js). GRACEFUL
// DEGRADATION: with no on-device LLM the three agents fall back to deterministic
// rule-based proposals, so the engine still converges on a device without WebGPU.
// This module names no network primitive; the peer-index read can be run inside
// runWithNetworkDenied() from js/packs/pack-network-guard.js as defence in depth.

// Phrases that signal uncertainty in a free-text / voice answer.
export const UNCERTAINTY_PHRASES = Object.freeze([
  "i don't know", 'i dont know', 'idk', 'not sure', 'no idea', 'unsure',
  'no clue', "don't know", 'dont know', 'dunno', 'not certain', 'who knows',
]);

/**
 * Does this free-text/voice answer express uncertainty? An empty (or whitespace)
 * answer counts as uncertain ONLY when the question was flagged uncertain — the
 * caller passes that via `opts.flaggedUncertain`.
 */
export function detectUncertainty(text, opts = {}) {
  const t = (text == null ? '' : String(text)).trim().toLowerCase();
  if (t === '') return opts.flaggedUncertain === true;
  return UNCERTAINTY_PHRASES.some(p => t === p || t.includes(p));
}

// ------------------------------------------------------------
// Confidence-weighted reconciliation (Step C). Group proposals by a normalised
// answer, sum the confidences per group, and pick the group with the greatest
// total confidence — an established weighted-vote technique, not a blind
// majority. The winning confidence is the group's mean (bounded to [0,1]).
// ------------------------------------------------------------
export function reconcile(proposals) {
  const usable = (Array.isArray(proposals) ? proposals : []).filter(
    p => p && typeof p.answer === 'string' && p.answer.trim() !== '' && typeof p.confidence === 'number'
  );
  if (usable.length === 0) return null;
  const groups = new Map(); // normalised answer -> { answer, total, count, best }
  for (const p of usable) {
    const key = p.answer.trim().toLowerCase();
    const conf = Math.max(0, Math.min(1, p.confidence));
    if (!groups.has(key)) groups.set(key, { answer: p.answer, total: 0, count: 0, best: 0 });
    const g = groups.get(key);
    g.total += conf; g.count += 1; g.best = Math.max(g.best, conf);
  }
  let winner = null;
  for (const g of groups.values()) {
    if (!winner || g.total > winner.total) winner = g;
  }
  return {
    answer: winner.answer,
    confidence: Math.max(0, Math.min(1, winner.total / winner.count)),
    agreement: winner.count, // how many agents backed the winning answer
  };
}

// ------------------------------------------------------------
// The three debate agents. Each is a role + a prompt builder + a deterministic
// rule-based fallback proposal so the panel works with or without the LLM.
// ------------------------------------------------------------
export const DEBATE_ROLES = Object.freeze(['conservative', 'industry-norm', 'statistical']);

const ROLE_INSTRUCTION = Object.freeze({
  conservative: 'Assume the strictest reasonable interpretation of what should be allowed.',
  'industry-norm': 'Answer with what comparable datasets in this domain typically show.',
  statistical: 'Answer based only on what the distribution of THIS data suggests.',
});

const DEBATE_SYSTEM_PROMPT = [
  "You are one member of DATAGLOW's on-device rule-suggestion panel, running entirely on the user's own device.",
  'You propose a single plain-English validation rule for one data column and rate your own confidence from 0 to 1.',
  'Use only the observation given; never invent numbers. Reply with one short rule sentence, then "confidence: <0..1>".',
].join(' ');

export function buildDebatePrompt(role, candidate, domain = '') {
  const instruction = ROLE_INSTRUCTION[role] || ROLE_INSTRUCTION.conservative;
  const user = [
    `Role: ${role}. ${instruction}`,
    domain ? `Domain: ${domain}` : 'Domain: (unspecified)',
    `Column: ${candidate.column}`,
    `Observation: ${candidate.observation}`,
    `Draft rule under consideration: ${candidate.ruleGuess}`,
    '',
    'Propose the rule you would set and your confidence.',
  ].join('\n');
  return {
    system: DEBATE_SYSTEM_PROMPT,
    user,
    messages: [
      { role: 'system', content: DEBATE_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  };
}

// Deterministic rule-based proposal per role (the no-LLM fallback). Confidences
// are role-shaped: the conservative and statistical agents are surer on a hard
// mathematical constraint; the industry-norm agent is surer on a percentage cap.
export function defaultAgentProposal(role, candidate) {
  const hard = candidate.category === 'impossible';
  const base = candidate.ruleGuess;
  switch (role) {
    case 'conservative':
      return { role, answer: base, confidence: hard ? 0.9 : 0.6 };
    case 'industry-norm':
      return { role, answer: base, confidence: /100%/.test(base) ? 0.8 : 0.5 };
    case 'statistical':
    default:
      return { role, answer: base, confidence: candidate.category === 'outlier' ? 0.75 : (hard ? 0.7 : 0.5) };
  }
}

// Parse "<rule>. confidence: 0.8" out of an LLM reply, defensively.
function parseAgentReply(role, text) {
  const raw = (text == null ? '' : String(text)).trim();
  if (raw === '') return null;
  const m = raw.match(/confidence\s*[:=]\s*(0?\.\d+|1(?:\.0+)?|\d{1,3}\s*%)/i);
  let confidence = 0.5;
  let answer = raw;
  if (m) {
    let c = m[1].trim();
    confidence = c.endsWith('%') ? parseFloat(c) / 100 : parseFloat(c);
    answer = raw.slice(0, m.index).replace(/[\s.]+$/, '').trim() || raw;
  }
  if (!Number.isFinite(confidence)) confidence = 0.5;
  return { role, answer, confidence: Math.max(0, Math.min(1, confidence)) };
}

/**
 * Run the three agents SEQUENTIALLY (single WebGPU context). Enforces the total
 * time budget: before each agent, if the elapsed time already exceeds the budget
 * we stop and let the caller fall back. Returns { proposals, budgetExceeded }.
 * `llm` (optional) is `{ available, generate(messages)->Promise<string> }`; with
 * no llm the deterministic per-role proposals are used.
 */
export async function runDebate(candidate, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const startedAt = typeof opts.startedAt === 'number' ? opts.startedAt : now();
  const budget = typeof opts.timeBudgetMs === 'number' ? opts.timeBudgetMs : DEFAULT_TIME_BUDGET_MS;
  const llm = opts.llm && opts.llm.available && typeof opts.llm.generate === 'function' ? opts.llm : null;
  const proposals = [];
  let budgetExceeded = false;
  for (const role of DEBATE_ROLES) {
    if (now() - startedAt > budget) { budgetExceeded = true; break; }
    if (llm) {
      try {
        const reply = await llm.generate(buildDebatePrompt(role, candidate, opts.domain));
        const parsed = parseAgentReply(role, reply);
        proposals.push(parsed || defaultAgentProposal(role, candidate));
      } catch {
        proposals.push(defaultAgentProposal(role, candidate));
      }
    } else {
      proposals.push(defaultAgentProposal(role, candidate));
    }
  }
  return { proposals, budgetExceeded };
}

// The average-hardware resolution budget the spec caps at 2 seconds.
export const DEFAULT_TIME_BUDGET_MS = 2000;

/**
 * Resolve one uncertain finding through Steps A→D. Returns a resolution:
 *   { resolvedBy, suggestion, reasoning, confidence, source, peer, stepsAttempted }
 * `stepsAttempted` records the steps tried, in order, so the ordering is
 * observable (and testable). The debate/steps are NEVER surfaced to the user;
 * only Step D's unified suggestion is (see buildResolutionView).
 */
export async function resolve(candidate, opts = {}) {
  const stepsAttempted = [];
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const startedAt = now();

  // STEP A — statistical confidence check.
  stepsAttempted.push('A');
  const stat = candidate.stat || (candidate.category === 'impossible'
    ? { hardConstraint: true, zscore: (typeof candidate.severity === 'number' ? 3.1 + candidate.severity : 3.1), rare: true }
    : null);
  if (stat && stat.hardConstraint === true && stat.zscore > 3 && stat.rare === true) {
    return {
      resolvedBy: 'A', suggestion: candidate.ruleGuess,
      reasoning: `this value breaks a hard rule that can't be right (${candidate.observation}), and it shows up only rarely`,
      confidence: 0.95, source: 'statistical-confidence', peer: null, stepsAttempted,
    };
  }

  // STEP B — local peer-sourced pack index.
  stepsAttempted.push('B');
  const index = opts.index;
  if (index && typeof index.findOne === 'function') {
    const peer = index.findOne({ domain: opts.domain, columnPattern: opts.columnPattern || candidate.column });
    if (peer) {
      return {
        resolvedBy: 'B',
        suggestion: peer.suggested_rule,
        reasoning: `someone else running a ${peer.domain} business already answered this and set it to "${peer.suggested_rule}"`,
        confidence: 0.7, source: 'peer-index', peer, stepsAttempted,
      };
    }
  }

  // STEP C — three-agent debate + confidence-weighted reconciliation.
  stepsAttempted.push('C');
  const { proposals, budgetExceeded } = await runDebate(candidate, { ...opts, now, startedAt });
  const reconciled = budgetExceeded ? null : reconcile(proposals);
  if (reconciled) {
    return {
      resolvedBy: 'C', suggestion: reconciled.answer,
      reasoning: `weighing a strict reading, what similar ${opts.domain || 'datasets'} usually do, and this data's own distribution`,
      confidence: reconciled.confidence, source: 'debate-panel', peer: null, stepsAttempted,
    };
  }

  // Budget blown (or nothing to reconcile) → safe fallback default.
  stepsAttempted.push('fallback');
  return {
    resolvedBy: 'fallback', suggestion: candidate.ruleGuess,
    reasoning: `a safe default while we keep things quick (${candidate.observation})`,
    confidence: 0.4, source: 'fallback-default', peer: null, stepsAttempted,
  };
}

/**
 * STEP D view model — ONE unified suggestion, never the debate. Buttons and the
 * low-emphasis free-text/voice fallback match the question presenter exactly.
 */
export function buildResolutionView(resolution, opts = {}) {
  const voiceEnabled = opts.voiceEnabled === true;
  const message =
    `No problem! Here's what I'd suggest and why: ${resolution.reasoning}. ` +
    `My best guess: ${resolution.suggestion}. ` +
    `You know your business best — sound right, or should I skip this for now?`;
  const primary = [
    { id: 'accept', label: 'Sounds right — use that' },
    { id: 'skip', label: 'Skip for now' },
  ];
  if (resolution.source === 'peer-index' && resolution.peer) {
    // Step B phrasing offers to "borrow" the peer answer explicitly.
    primary[0] = { id: 'accept', label: 'Borrow that' };
  }
  return {
    message,
    primary,
    freeText: { emphasis: 'low', placeholder: '…or tell me in your own words', micIcon: voiceEnabled, voiceEnabled },
  };
}

// ------------------------------------------------------------
// STEP E — Park-and-Revisit session state. A SECOND uncertainty on the same
// finding parks it; after a few other answers land, the caller may revisit it
// with NEW cross-column evidence found elsewhere in the dataset.
// ------------------------------------------------------------
export class ResolverSession {
  constructor() {
    this._uncertainCounts = new Map(); // column -> times user was uncertain
    this.parked = [];                  // [{ candidate, parkedAfterResolved }]
    this.resolvedCount = 0;
  }

  /** Record that a finding was resolved (confirmed or skipped) — advances the clock. */
  noteResolved() { this.resolvedCount += 1; return this.resolvedCount; }

  /**
   * Register an uncertain answer for a candidate. Returns 'resolve' the FIRST
   * time (run Steps A–D) and 'park' the SECOND time (Step E: stop re-asking).
   */
  registerUncertainty(candidate) {
    const key = candidate.column;
    const n = (this._uncertainCounts.get(key) || 0) + 1;
    this._uncertainCounts.set(key, n);
    if (n >= 2 && !this.parked.some(p => p.candidate.column === key)) {
      this.parked.push({ candidate, parkedAfterResolved: this.resolvedCount });
    }
    return n >= 2 ? 'park' : 'resolve';
  }

  /**
   * Which parked findings are ready to revisit: parked at least `minGap`
   * resolutions ago (default 2 — "after 2-3 other questions are resolved").
   */
  revisitable(minGap = 2) {
    return this.parked.filter(p => this.resolvedCount - p.parkedAfterResolved >= minGap);
  }
}

/**
 * Step E revisit message. `crossEvidence` is a co-occurrence found elsewhere in
 * the SAME dataset: { whenColumn, whenEvent, alsoColumn, alsoEvent }. Returns
 * null when there is no new evidence to offer (don't nag without a reason).
 */
export function buildParkedRevisit(parkedCandidate, crossEvidence) {
  if (!crossEvidence || !crossEvidence.whenEvent || !crossEvidence.alsoEvent) return null;
  const col = parkedCandidate.column;
  return (
    `Earlier you weren't sure about "${col}". I noticed something — every time ${crossEvidence.whenEvent} happens, ` +
    `${crossEvidence.alsoEvent} also happens. Does that help?`
  );
}
