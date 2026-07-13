// ============================================================
// DATAGLOW — Meeting Scribe Agent (Gen 43, Part 1)
// ============================================================
// The first piece of the "analyst team goes to the meeting" capability. This
// module does NOT capture audio and does NOT run speech-to-text — that is a
// separate, browser-API-heavy UI concern (getDisplayMedia + an on-device
// WebGPU transcription model) deliberately left for a follow-up PR so this
// piece can ship small, pure, and testable without a browser or a GPU.
//
// What THIS module does: given transcript segments the caller already has
// (plain text + a timestamp, from whatever capture path lands later) and a
// timeline of "chart/query changed" events the app already emits when the
// analyst switches views, it:
//
//   1. TAGS each transcript segment with whichever chart/query was on screen
//      at that moment (`tagSegmentsWithContext`) — so a note is never
//      floating free of the number it was said about.
//   2. DETECTS pushback phrases ("why did this drop", "are you sure", "that
//      doesn't look right", …) that should trigger the EXISTING on-device
//      uncertainty resolver's re-run rather than a prose reply
//      (`detectPushback`) — per the repo's existing rule (see
//      js/agents/uncertainty-resolver-agent.js) that a critique-style check
//      must re-run its own query, never argue in text.
//   3. DETECTS data-request phrases ("can you also pull …", "could we get …")
//      into a lightweight request queue the analyst can triage after the
//      meeting (`detectDataRequest`).
//   4. ENFORCES that an action item only counts as resolved once it carries an
//      owner, a due date, and an outcome — a bare "will follow up" note stays
//      OPEN rather than silently counting as done (`buildActionItem`,
//      `isActionItemResolved`).
//   5. ASSEMBLES a meeting note ledger entry (`buildMeetingNote`) shaped to
//      append onto the SAME portable, signed export path packs and other
//      agent output already use — this module builds the plain object only;
//      writing/signing it is the export layer's job, not this one's.
//
// GRACEFUL DEGRADATION: every function here is deterministic string/array
// logic — no LLM, no DOM, no browser global. A caller MAY later use an
// on-device LLM to polish a note's wording (mirroring
// js/agents/question-generator-agent.js's buildQuestionPrompt pattern), but
// the structured tag/flag/queue output below is already complete and correct
// without one, so a device with no WebGPU loses nothing but a cosmetic
// rephrase.
//
// EMPOWERMENT CONSTRAINT (same as the rest of Gen 42/43): nothing here writes
// to a pack, a rule, or a chart. It only produces a note object the analyst
// reviews; the analyst decides what (if anything) happens next.
//
// This module names no network primitive and has no DOM/browser coupling.

// ---------- pushback / data-request phrase catalogs ----------

// Phrases that signal a stakeholder is challenging a number rather than just
// asking about it — the Skeptic-style re-run trigger, not a prose answer.
export const PUSHBACK_PHRASES = Object.freeze([
  'why did this drop', 'why did that drop', 'why is this down', 'why is that down',
  'are you sure', 'is that right', 'is that correct', 'that doesn\u2019t look right',
  "that doesn't look right", 'that seems off', 'that seems wrong', 'double check',
  'double-check', 'can you verify', 'can we verify', 'i don\u2019t believe that',
  "i don't believe that", 'that can\u2019t be right', "that can't be right",
  'where does that number come from', 'how did you get that number',
]);

// Phrases that signal a NEW data request rather than a question about what is
// already on screen.
export const DATA_REQUEST_PHRASES = Object.freeze([
  'can you also pull', 'can you pull', 'could you pull', 'can we get',
  'could we get', 'can you also get', 'can you add', 'could you add',
  'can you break this down by', 'could you break this down by',
  'can you send me', 'could you send me', 'can you also look at',
  'is it possible to see', 'one more thing, can you',
]);

function normalize(text) {
  return (text == null ? '' : String(text)).trim().toLowerCase();
}

/**
 * Does this transcript segment contain a pushback phrase?
 * @param {string} text
 * @returns {{isPushback:boolean, matched:string|null}}
 */
export function detectPushback(text) {
  const t = normalize(text);
  if (t === '') return { isPushback: false, matched: null };
  const matched = PUSHBACK_PHRASES.find((p) => t.includes(p));
  return { isPushback: !!matched, matched: matched || null };
}

/**
 * Does this transcript segment contain a new data-request phrase?
 * @param {string} text
 * @returns {{isDataRequest:boolean, matched:string|null}}
 */
export function detectDataRequest(text) {
  const t = normalize(text);
  if (t === '') return { isDataRequest: false, matched: null };
  const matched = DATA_REQUEST_PHRASES.find((p) => t.includes(p));
  return { isDataRequest: !!matched, matched: matched || null };
}

// ---------- pushback → resolver candidate ----------

// Category tag for a pushback candidate. Deliberately a NEW category (not
// 'impossible'/'outlier'/etc.) so resolve() does NOT trigger Step A's
// hard-constraint fast path — a raw meeting line has no statistic behind it —
// and instead falls through Step A (no stat) → Step B (no peer unless supplied)
// → Step C, the generic three-persona debate, which reasons off
// {observation, ruleGuess} regardless of category.
export const MEETING_PUSHBACK_CATEGORY = 'meeting-pushback';

/**
 * Build a resolver `candidate` from a tagged pushback segment so a stakeholder's
 * "are you sure?" moment can be re-checked through the EXISTING on-device
 * uncertainty resolver (js/agents/uncertainty-resolver-agent.js `resolve`) — the
 * call site the Part 1 comments said "should" trigger but never had.
 *
 * HONESTY: there is no real numeric finding behind a raw transcript line, so this
 * NEVER invents a statistic or claims a hard-constraint violation. `observation`
 * quotes literally what was said; `ruleGuess` is a generic "worth a second look"
 * placeholder, not a fabricated specific rule; `column` is whatever chart/query
 * the segment was tagged against (or a neutral placeholder when none was
 * captured — never guessed).
 *
 * Pure and synchronous — no DOM, no LLM, no network. Never mutates its input.
 *
 * @param {{text?:string, matched?:string|null, ts?:number, context?:{chart?:string, queryLabel?:string}|null}} segment
 * @returns {{observation:string, ruleGuess:string, category:string, column:string}}
 */
export function buildPushbackCandidate(segment) {
  const seg = segment && typeof segment === 'object' ? segment : {};
  const text = typeof seg.text === 'string' ? seg.text.trim() : '';
  const context = seg.context && typeof seg.context === 'object' ? seg.context : null;
  const chart = context && typeof context.chart === 'string' ? context.chart.trim() : '';
  const queryLabel = context && typeof context.queryLabel === 'string' ? context.queryLabel.trim() : '';
  const column = chart !== '' ? chart : (queryLabel !== '' ? queryLabel : 'the number under discussion');
  const observation = text !== ''
    ? `A stakeholder pushed back on this number, saying: "${text}"`
    : 'A stakeholder pushed back on this number.';
  return {
    observation,
    ruleGuess: 'treat this as worth a second look',
    category: MEETING_PUSHBACK_CATEGORY,
    column,
  };
}

// ---------- context tagging ----------

/**
 * A transcript segment: `{ text: string, ts: number }` where `ts` is a
 * monotonic meeting-relative timestamp in milliseconds (whatever unit the
 * capture path uses, as long as it matches the context timeline's `ts`).
 *
 * A context-change event: `{ ts: number, chart: string, queryLabel?: string }`
 * emitted whenever the analyst switches the visible chart/query — the app
 * already knows this moment-to-moment; this module never inspects the DOM to
 * find out, it only accepts the timeline as input.
 */

/**
 * Tag each transcript segment with whichever context event was active at
 * (or immediately before) its timestamp. Segments spoken before the first
 * context event are tagged with `context: null` rather than guessing.
 * @param {Array<{text:string, ts:number}>} segments
 * @param {Array<{ts:number, chart:string, queryLabel?:string}>} contextTimeline
 * @returns {Array<{text:string, ts:number, context:{chart:string, queryLabel:string|null}|null, pushback:object, dataRequest:object}>}
 */
export function tagSegmentsWithContext(segments, contextTimeline) {
  const segs = Array.isArray(segments) ? segments : [];
  const timeline = (Array.isArray(contextTimeline) ? contextTimeline : [])
    .filter((e) => e && typeof e.ts === 'number' && typeof e.chart === 'string' && e.chart !== '')
    .slice()
    .sort((a, b) => a.ts - b.ts);

  return segs
    .filter((s) => s && typeof s.text === 'string' && typeof s.ts === 'number')
    .map((s) => {
      // Last context event whose ts <= this segment's ts (binary search would
      // be overkill for a meeting's segment count; linear scan is plenty).
      let active = null;
      for (const e of timeline) {
        if (e.ts <= s.ts) active = e;
        else break;
      }
      return {
        text: s.text,
        ts: s.ts,
        context: active ? { chart: active.chart, queryLabel: active.queryLabel || null } : null,
        pushback: detectPushback(s.text),
        dataRequest: detectDataRequest(s.text),
      };
    });
}

// ---------- action items ----------

/**
 * Build an action item record. It starts OPEN by construction — resolving it
 * is a separate, explicit step (`resolveActionItem`), never implied by
 * merely creating the record.
 * @param {{text:string, ts:number}} opts
 * @returns {{text:string, ts:number, owner:null, dueDate:null, outcome:null, status:'open'}}
 */
export function buildActionItem({ text, ts }) {
  return { text: String(text || ''), ts: typeof ts === 'number' ? ts : null, owner: null, dueDate: null, outcome: null, status: 'open' };
}

/**
 * An action item is resolved ONLY when it carries all three of owner, due
 * date, and outcome. A "will follow up" note with none of those stays open —
 * this is the minimum-viable-action-item rule from the v3 brief.
 * @param {{owner:?string, dueDate:?string, outcome:?string}} item
 * @returns {boolean}
 */
export function isActionItemResolved(item) {
  if (!item || typeof item !== 'object') return false;
  const hasOwner = typeof item.owner === 'string' && item.owner.trim() !== '';
  const hasDueDate = typeof item.dueDate === 'string' && item.dueDate.trim() !== '';
  const hasOutcome = typeof item.outcome === 'string' && item.outcome.trim() !== '';
  return hasOwner && hasDueDate && hasOutcome;
}

/**
 * Attach owner/dueDate/outcome to an action item and flip its status only if
 * the minimum-viable-action-item rule is satisfied; otherwise it stays open
 * (partial info is recorded, but never silently counted as done).
 * @param {object} item
 * @param {{owner?:string, dueDate?:string, outcome?:string}} fields
 * @returns {object} a NEW item object (never mutates the input)
 */
export function resolveActionItem(item, fields = {}) {
  const next = {
    ...item,
    owner: fields.owner != null ? String(fields.owner) : (item ? item.owner : null),
    dueDate: fields.dueDate != null ? String(fields.dueDate) : (item ? item.dueDate : null),
    outcome: fields.outcome != null ? String(fields.outcome) : (item ? item.outcome : null),
  };
  next.status = isActionItemResolved(next) ? 'resolved' : 'open';
  return next;
}

// ---------- meeting note assembly ----------

/**
 * Assemble one meeting note ledger entry from tagged segments. This is a
 * plain, JSON-safe object — signing/appending it to the portable export file
 * is the export layer's responsibility, not this module's.
 * @param {{meetingId:string, startedAt:string, taggedSegments:Array<object>, actionItems?:Array<object>}} opts
 * @returns {{meetingId:string, startedAt:string, quoteCount:number, pushbackMoments:Array<object>, dataRequests:Array<object>, actionItems:Array<object>, chartsDiscussed:Array<string>}}
 */
export function buildMeetingNote({ meetingId, startedAt, taggedSegments, actionItems }) {
  const tagged = Array.isArray(taggedSegments) ? taggedSegments : [];
  const pushbackMoments = tagged.filter((s) => s.pushback && s.pushback.isPushback);
  const dataRequests = tagged.filter((s) => s.dataRequest && s.dataRequest.isDataRequest);
  const chartsDiscussed = [...new Set(
    tagged.map((s) => s.context && s.context.chart).filter((c) => typeof c === 'string' && c !== '')
  )];
  return {
    meetingId: String(meetingId || ''),
    startedAt: String(startedAt || ''),
    quoteCount: tagged.length,
    pushbackMoments: pushbackMoments.map((s) => ({ text: s.text, ts: s.ts, context: s.context, matched: s.pushback.matched })),
    dataRequests: dataRequests.map((s) => ({ text: s.text, ts: s.ts, context: s.context, matched: s.dataRequest.matched })),
    actionItems: Array.isArray(actionItems) ? actionItems : [],
    chartsDiscussed,
  };
}
