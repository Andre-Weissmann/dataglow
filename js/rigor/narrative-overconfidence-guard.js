// ============================================================
// DATAGLOW — Narrative Overconfidence Guard
// ============================================================
// WHY THIS EXISTS: the Story Engine (js/narrative/story.js) already scores
// each quantitative claim with a per-claim confidence grade (A-D, via the
// Confidence Layer's scoreClaimConfidence) and its own model prompts already
// INSTRUCT the model to hedge on weak claims and end with an honest caveat
// (see STORY_SYSTEM_PROMPT / buildStoryModelPrompt in
// js/narrative/ondevice-llm.js). But nothing verifies the model's actual
// GENERATED text obeys that instruction. A model — on-device or an external
// provider — can silently ignore "hedge on grade C/D" and write confident,
// assertive prose anyway. That gap is the exact mechanism named in Stanford
// HAI's reporting on AI "delusional spirals": a model trained to sound
// agreeable/confident can drift past what its own evidence supports, with
// nothing in the pipeline catching it (see
// https://hai.stanford.edu/news/ais-delusional-spirals-and-what-to-do-about-them).
// DataGlow's stakes here are narrower and lower — this only ever grades
// wording against a STATISTICAL claim's confidence grade, never a person's
// beliefs — but the failure mode is the same shape: unearned certainty in
// generated text, undetected.
//
// This module deliberately does NOT re-derive confidence grades (that stays
// owned by js/validation/validation.js's scoreClaimConfidence, exactly as
// story.js's buildStoryClaims already does) and does NOT re-implement
// anything from the Rigor Engine (js/rigor/statistical-rigor.js), which
// grades STRUCTURED claims (SQL/Visualize sample-size and Simpson's-paradox
// verdicts). This module's job is narrower and complementary: it grades
// GENERATED PROSE TEXT against confidence grades that already exist,
// wherever that text sits next to a claim-confidence badge in the app (today:
// Story tab; Guarded Copilot's narrative rephrase is a documented future
// follow-up, not in scope this batch — see NORTH_STAR.md).
//
// PURE LOGIC ONLY: no DOM, no network, no model call, no import of anything
// in js/narrative/ or js/app-shell/ — so it stays trivially Node-testable and
// composes cleanly with any future caller the same way story.js's own claim
// scoring does.
// ============================================================

// Absolute/overconfident language patterns. Deliberately conservative and
// narrow (word-boundary regexes) so this never flags ordinary hedged prose —
// false positives here would train the user to ignore the badge, which is
// worse than under-detecting. Each pattern is checked case-insensitively.
const OVERCONFIDENT_PATTERNS = [
  /\bclearly\b/i,
  /\bdefinitely\b/i,
  /\bcertainly\b/i,
  /\bproves?\b/i,
  /\bconclusively\b/i,
  /\bundoubtedly\b/i,
  /\bguarantees?\b/i,
  /\bwithout (?:a )?doubt\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bevery (?:single )?time\b/i,
  /\b100% (?:certain|sure|confident)\b/i,
];

// Hedging language a caveat sentence is expected to contain when a claim's
// grade is C or D. Mirrors the exact hedge vocabulary story.js's own
// generateLocalStory() already uses ("treat this ... cautiously", "limited or
// partly-missing data") plus a few reasonable synonyms, so this module holds
// the local rule-based path to the same bar it already meets, and holds any
// model-generated path (on-device or external) to that same bar.
const HEDGE_PATTERNS = [
  /\bcaution/i,
  /\bcautiously/i,
  /\blimited\b/i,
  /\bsmall sample/i,
  /\bfew (?:data points|rows|records)/i,
  /\bmissing data/i,
  /\bpartly[- ]missing/i,
  /\buncertain/i,
  /\bshould(?:n't| not) be (?:read|taken) as (?:definitive|conclusive)/i,
  /\bnot (?:definitive|conclusive)/i,
  /\btentative/i,
  /\bpreliminary/i,
  /\bmay not (?:fully )?reflect/i,
  /\bdoes(?:n't| not) (?:fully )?(?:capture|reflect|show)/i,
];

const WEAK_GRADES = new Set(['C', 'D']);

/**
 * Find every sentence in `text` that contains a value/phrase drawn from a
 * specific claim (matched by the claim's already-rounded display value or
 * its column name) so overconfident language can be attributed to the RIGHT
 * claim rather than judged against the whole narrative at once. Falls back
 * to whole-text scanning for a claim whose value/column can't be located
 * verbatim (e.g. a model paraphrased the number differently) — see
 * `findRelevantSentences` for exactly how "relevant" is decided.
 *
 * Sentence splitting is intentionally simple (split on ., !, ? followed by
 * whitespace/end) — this module is a wording-tone check, not an NLP parser,
 * and a fully correct sentence tokenizer would add a dependency for no real
 * accuracy gain on the short, plain-English prose the Story tab produces.
 */
function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Build a small set of tokens that would plausibly appear in a sentence
// discussing this claim: its column name (if any) and a handful of numeric
// renderings of its value (rounded/toFixed variants), mirroring the same
// tolerant-numeric-matching approach checkNarrativeConsistency() already uses
// in js/validation/validation.js so this module stays consistent with how
// DataGlow already reasons about "does this text describe this number."
function claimTokens(claim) {
  const tokens = [];
  if (claim.column) tokens.push(String(claim.column).toLowerCase());
  const v = claim.value;
  if (typeof v === 'number' && !Number.isNaN(v)) {
    tokens.push(v.toFixed(2));
    tokens.push(v.toFixed(1));
    tokens.push(String(Math.round(v)));
  }
  return tokens;
}

function findRelevantSentences(sentences, claim) {
  const tokens = claimTokens(claim);
  if (!tokens.length) return [];
  return sentences.filter((s) => {
    const lower = s.toLowerCase();
    return tokens.some((t) => t && lower.includes(t));
  });
}

/**
 * Scan generated narrative text for overconfident wording that is NOT backed
 * by the claims' own confidence grades. Two independent checks per claim:
 *
 *   1. OVERCONFIDENT LANGUAGE — any sentence discussing a claim uses an
 *      absolute/overconfident word (see OVERCONFIDENT_PATTERNS) while that
 *      claim's grade is C or D (weak). This is always a flag regardless of
 *      grade for the STRONGEST patterns is deliberately NOT done — even a
 *      grade-A claim saying "clearly" is ordinary confident prose, not an
 *      overconfidence problem; the risk this module targets is specifically
 *      confident-SOUNDING text that outruns weak evidence.
 *   2. MISSING HEDGE — a claim graded C or D has no sentence describing it
 *      that contains ANY recognizable hedge/caveat language. A model that
 *      simply omits the required caveat sentence entirely is the most direct
 *      version of the Stanford HAI failure mode (confident by omission,
 *      rather than confident by word choice).
 *
 * Never mutates its inputs. Never throws — a malformed/empty `text` or
 * `claims` array degrades to `{ status: 'idle', findings: [] }` rather than
 * blocking the Story tab, matching every other validation module's
 * fail-open discipline in this codebase (see e.g. findReferenceCandidate in
 * js/validation/validation.js).
 *
 * @param {string} text - The generated narrative (plain text; strip HTML/
 *   markup before calling, same as state.lastStory in main.js already does).
 * @param {Array<{kind:string, column:?string, value:*, text:string, confidence:{grade:string,n:number,missingRate:number}}>} claims
 *   - The exact shape story.js's buildStoryClaims() returns. Never re-derived
 *   here — always the caller's own already-scored claims.
 * @returns {{status: 'pass'|'warn'|'idle', findings: Array<{claimKind:string, column:?string, grade:string, issue:'overconfident_language'|'missing_hedge', sentence:?string, pattern:?string}>}}
 */
export function checkNarrativeOverconfidence(text, claims) {
  if (typeof text !== 'string' || !text.trim()) return { status: 'idle', findings: [] };
  if (!Array.isArray(claims) || claims.length === 0) return { status: 'idle', findings: [] };

  const sentences = splitSentences(text);
  const findings = [];

  for (const claim of claims) {
    const grade = claim && claim.confidence && claim.confidence.grade;
    if (!grade) continue;

    const relevant = findRelevantSentences(sentences, claim);
    // If the claim's value/column can't be located in any sentence, fall back
    // to scanning the whole narrative — a paraphrased number is still worth
    // checking for overconfident tone even if this module can't pin it to one
    // sentence; `sentence: null` in the finding honestly reflects that.
    const overconfidenceSearchSpace = relevant.length ? relevant : sentences;
    // A hedge/caveat sentence legitimately does NOT need to repeat the
    // claim's number or column name verbatim (story.js's own
    // generateLocalStory() writes "Treat this average cautiously — it rests
    // on limited or partly-missing data.", a follow-on sentence with no
    // number in it at all) — so the missing-hedge check always scans the
    // WHOLE narrative for hedge language, never narrowed to `relevant`. Only
    // the overconfident-language check (which DOES need to attribute a
    // specific confident phrase to a specific claim) uses the narrowed set.
    const hedgeSearchSpace = sentences;

    if (WEAK_GRADES.has(grade)) {
      // Check 1: overconfident language attached to a weak claim.
      for (const sentence of overconfidenceSearchSpace) {
        const hit = OVERCONFIDENT_PATTERNS.find((re) => re.test(sentence));
        if (hit) {
          findings.push({
            claimKind: claim.kind,
            column: claim.column || null,
            grade,
            issue: 'overconfident_language',
            sentence: relevant.length ? sentence : null,
            pattern: hit.source,
          });
          break; // one finding per claim per issue type is enough signal
        }
      }

      // Check 2: no hedge anywhere in the narrative at all for this claim.
      const hasHedge = hedgeSearchSpace.some((s) => HEDGE_PATTERNS.some((re) => re.test(s)));
      if (!hasHedge) {
        findings.push({
          claimKind: claim.kind,
          column: claim.column || null,
          grade,
          issue: 'missing_hedge',
          sentence: null,
          pattern: null,
        });
      }
    }
  }

  return { status: findings.length ? 'warn' : 'pass', findings };
}

/**
 * Render-ready summary line for the finding list, kept here (pure, no DOM) so
 * the thin presenter that calls this module never needs its own English
 * strings — same split as story.js's confidenceBadgeHTML vs. buildStoryClaims.
 */
export function describeOverconfidenceFinding(finding) {
  const col = finding.column ? ` ("${finding.column}")` : '';
  if (finding.issue === 'overconfident_language') {
    return `The ${finding.claimKind}${col} claim is graded ${finding.grade} (weak) but the narrative uses confident language ("${finding.pattern.replace(/\\b/g, '')}") without hedging.`;
  }
  return `The ${finding.claimKind}${col} claim is graded ${finding.grade} (weak) but the narrative never hedges or caveats it.`;
}
