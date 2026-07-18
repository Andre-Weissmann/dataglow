// ============================================================
// DATAGLOW — Meeting Synthesis (Live Rooms Batch 4)
// ============================================================
// WHAT THIS IS: a pure, Node-testable prompt builder + result summarizer for the
// on-device LLM synthesis panel. It turns a grounded meeting note (the output of
// buildMeetingNote() in js/agents/meeting-scribe-agent.js) into a focused
// system+user prompt pair that asks the EXISTING on-device model (WebLLM, loaded
// exactly as the Story and Guarded Copilot tabs load it) for a short summary of
// what was actually said: pushback moments, data requests, action items, and the
// chart/query grounding context.
//
// GROUNDING DISCIPLINE: the prompt instructs the model to summarize ONLY what is
// in the note and to never invent owners, dates, numbers, or facts. This mirrors
// the honesty rule the rest of DataGlow follows — the model rephrases grounded
// content, it does not fabricate.
//
// SCOPE (Batch 4): pure DATA-LAYER module. No DOM, no DuckDB, no WebLLM import,
// no network. The main.js wiring calls the real ondevice-llm loadModel()/engine
// and injects isOnDeviceLLMAvailable via DI; isSynthesisAvailable() here is a
// pure stub returning false until wired. Never throws.
//
// iOS WKWebView: no template literals, no apostrophes inside single-quoted
// strings (the prompt text uses plain double-quoted strings).
// ============================================================

// Small helpers ------------------------------------------------------------

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function safeCount(v) {
  return Array.isArray(v) ? v.length : 0;
}

function lineFromMoment(m) {
  // A pushback/data-request moment is { text, ts, context, matched }. We only
  // echo grounded fields; never invent anything.
  var text = (m && typeof m.text === 'string') ? m.text : '';
  var chart = (m && m.context && typeof m.context.chart === 'string') ? m.context.chart : '';
  if (chart !== '') return '- "' + text + '" (while viewing: ' + chart + ')';
  return '- "' + text + '"';
}

function lineFromActionItem(a) {
  var text = (a && typeof a.text === 'string') ? a.text : '';
  var status = (a && typeof a.status === 'string') ? a.status : 'open';
  var owner = (a && typeof a.owner === 'string' && a.owner.trim() !== '') ? a.owner : '';
  var due = (a && typeof a.dueDate === 'string' && a.dueDate.trim() !== '') ? a.dueDate : '';
  var suffix = ' [' + status;
  if (owner !== '') suffix += ', owner: ' + owner;
  if (due !== '') suffix += ', due: ' + due;
  suffix += ']';
  return '- ' + text + suffix;
}

function joinLines(lines) {
  return lines.join('\n');
}

// buildSynthesisPrompt ------------------------------------------------------

/**
 * Build a focused system+user prompt pair for summarizing a grounded meeting.
 * Pure. Always returns valid strings, even for an empty or null note.
 *
 * @param {object|null} meetingNote  output of buildMeetingNote()
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildSynthesisPrompt(meetingNote) {
  var note = (meetingNote && typeof meetingNote === 'object') ? meetingNote : {};

  var systemPrompt = joinLines([
    'You are a meeting summarizer for a data-analysis session.',
    'Summarize ONLY what is provided below. Do not invent owners, due dates, numbers, or facts that are not present.',
    'If a section is empty, say so plainly rather than guessing.',
    'Write a short, plain-language summary in four labeled parts: Pushback moments, Data requests, Action items, and Key grounding context (the charts and queries that were on screen).',
    'Keep it concise and faithful to the source.',
  ]);

  var pushback = asArray(note.pushbackMoments);
  var dataRequests = asArray(note.dataRequests);
  var actionItems = asArray(note.actionItems);
  var charts = asArray(note.chartsDiscussed);

  var parts = [];
  parts.push('Meeting id: ' + String(note.meetingId || '(none)'));
  parts.push('Started at: ' + String(note.startedAt || '(unknown)'));
  parts.push('Quotes captured: ' + String(typeof note.quoteCount === 'number' ? note.quoteCount : 0));
  parts.push('');

  parts.push('Pushback moments (' + pushback.length + '):');
  if (pushback.length === 0) parts.push('- none');
  else for (var i = 0; i < pushback.length; i++) parts.push(lineFromMoment(pushback[i]));
  parts.push('');

  parts.push('Data requests (' + dataRequests.length + '):');
  if (dataRequests.length === 0) parts.push('- none');
  else for (var j = 0; j < dataRequests.length; j++) parts.push(lineFromMoment(dataRequests[j]));
  parts.push('');

  parts.push('Action items (' + actionItems.length + '):');
  if (actionItems.length === 0) parts.push('- none');
  else for (var k = 0; k < actionItems.length; k++) parts.push(lineFromActionItem(actionItems[k]));
  parts.push('');

  parts.push('Key grounding context (charts and queries discussed, ' + charts.length + '):');
  if (charts.length === 0) parts.push('- none recorded');
  else for (var m = 0; m < charts.length; m++) parts.push('- ' + String(charts[m]));
  parts.push('');

  parts.push('Write the four-part summary now, using only the information above.');

  var userPrompt = joinLines(parts);

  return { systemPrompt: systemPrompt, userPrompt: userPrompt };
}

// summarizeMeetingSynthesis -------------------------------------------------

/**
 * Package a raw LLM response with the counts drawn from the original meeting
 * note. Pure. Never throws.
 *
 * @param {string|null} synthesisResult  raw LLM response text
 * @param {object|null} [meetingNote]    the note the prompt was built from
 * @returns {{ summary: string, actionItemCount: number, pushbackCount: number, contextReferenceCount: number }}
 */
export function summarizeMeetingSynthesis(synthesisResult, meetingNote) {
  var summary = (typeof synthesisResult === 'string') ? synthesisResult.trim() : '';
  var note = (meetingNote && typeof meetingNote === 'object') ? meetingNote : {};
  return {
    summary: summary,
    actionItemCount: safeCount(note.actionItems),
    pushbackCount: safeCount(note.pushbackMoments),
    contextReferenceCount: safeCount(note.chartsDiscussed),
  };
}

// isSynthesisAvailable ------------------------------------------------------

/**
 * Pure stub. Wired to isOnDeviceLLMAvailable() in main.js via dependency
 * injection. Returns false here so the module has no runtime dependency on
 * WebGPU/WebLLM. Never throws.
 *
 * @returns {boolean}
 */
export function isSynthesisAvailable() {
  return false;
}
