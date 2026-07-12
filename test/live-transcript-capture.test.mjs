// ============================================================
// DATAGLOW — Live Transcript Capture test suite (DataGlow Live Rooms, Batch 1)
// ============================================================
// Proves the PURE half of js/agents/live-transcript-capture.js is deterministic
// and safe, exactly the way test/meeting-scribe.test.mjs proves the agent:
//   - isSpeechCaptureAvailable() is a graceful capability check — false (never
//     a throw) when navigator/mediaDevices/WebGPU are missing, true only when
//     BOTH a microphone and WebGPU are present,
//   - assembleSegments() turns raw STT chunks into the SAME {text, ts} shape
//     parseTranscriptText produces — interim results are dropped, only finals
//     commit, empty/whitespace text is filtered, explicit timestamps are kept
//     and missing ones are auto-numbered like a bare typed line,
//   - createTranscriptAssembler() streams the same committed output while
//     tracking the in-flight interim ("pending") line,
//   - the assembled segments feed correctly into the EXISTING, unchanged
//     tagSegmentsWithContext from the meeting scribe agent.
//
// Pure JS — no DuckDB, DOM, mic, WebGPU, or network. RUN WITH:
//   node test/live-transcript-capture.test.mjs

import {
  isSpeechCaptureAvailable, assembleSegments, createTranscriptAssembler,
} from '../js/agents/live-transcript-capture.js';
import { tagSegmentsWithContext } from '../js/agents/meeting-scribe-agent.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Temporarily replace the global `navigator` binding with `value`, run `fn`,
// then restore. Uses defineProperty because Node exposes `navigator` as a
// non-writable lazy global. Never leaves the stub in place.
function withNavigator(value, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  try { return fn(); } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  }
}

function main() {
  // ---------- 1. Capability check: graceful degradation ----------
  ok(typeof isSpeechCaptureAvailable() === 'boolean', 'isSpeechCaptureAvailable: returns a boolean, never throws');
  ok(withNavigator(undefined, () => isSpeechCaptureAvailable()) === false,
    'isSpeechCaptureAvailable: no navigator at all -> false (no throw)');
  ok(withNavigator({}, () => isSpeechCaptureAvailable()) === false,
    'isSpeechCaptureAvailable: navigator with neither mediaDevices nor gpu -> false');
  ok(withNavigator({ mediaDevices: { getUserMedia() {} } }, () => isSpeechCaptureAvailable()) === false,
    'isSpeechCaptureAvailable: microphone but NO WebGPU -> false');
  ok(withNavigator({ gpu: {} }, () => isSpeechCaptureAvailable()) === false,
    'isSpeechCaptureAvailable: WebGPU but NO microphone -> false');
  ok(withNavigator({ mediaDevices: {} , gpu: {} }, () => isSpeechCaptureAvailable()) === false,
    'isSpeechCaptureAvailable: mediaDevices present but getUserMedia missing -> false');
  ok(withNavigator({ mediaDevices: { getUserMedia() {} }, gpu: {} }, () => isSpeechCaptureAvailable()) === true,
    'isSpeechCaptureAvailable: BOTH microphone and WebGPU present -> true');

  // ---------- 2. assembleSegments: chunk -> {text, ts} ----------
  const chunks = [
    { text: 'Why did', ts: 3, isFinal: false },                 // interim, superseded
    { text: 'Why did revenue drop?', ts: 3, isFinal: true },    // final
    { text: '   ', ts: 6, isFinal: true },                      // whitespace-only, dropped
    { text: 'Can you pull the refund rate?', ts: 8, isFinal: true },
    { text: 'still thinking', isFinal: false },                 // interim, dropped
  ];
  const segs = assembleSegments(chunks);
  ok(segs.length === 2, 'assembleSegments: only final, non-empty chunks are committed (interim + whitespace dropped)');
  ok(segs[0].text === 'Why did revenue drop?' && segs[0].ts === 3, 'assembleSegments: explicit timestamp on a final chunk is kept');
  ok(segs[1].text === 'Can you pull the refund rate?' && segs[1].ts === 8, 'assembleSegments: second final chunk kept with its timestamp');
  ok(segs.every((s) => typeof s.text === 'string' && typeof s.ts === 'number'), 'assembleSegments: output matches the {text:string, ts:number} shape');

  // Auto-numbering when a final chunk carries no explicit ts (mirrors parseTranscriptText).
  const auto = assembleSegments([
    { text: 'first line', isFinal: true },
    { text: 'second line', isFinal: true },
    { text: 'jump ahead', ts: 20, isFinal: true },
    { text: 'after the jump', isFinal: true },
  ]);
  ok(auto[0].ts === 0 && auto[1].ts === 1, 'assembleSegments: missing ts auto-numbers from 0, then +1 like a bare typed line');
  ok(auto[2].ts === 20 && auto[3].ts === 21, 'assembleSegments: an explicit ts resets the auto-number baseline');

  // Malformed input degrades gracefully.
  ok(Array.isArray(assembleSegments(null)) && assembleSegments(null).length === 0, 'assembleSegments: null input -> empty array, no throw');
  ok(assembleSegments([null, 42, { isFinal: true }, { text: 5, isFinal: true }]).length === 0,
    'assembleSegments: junk entries (null/number/no-text/non-string-text) are skipped, no throw');
  ok(Math.floor(assembleSegments([{ text: 'x', ts: 4.9, isFinal: true }])[0].ts) === 4,
    'assembleSegments: a fractional timestamp is floored to an integer second');

  // ---------- 3. createTranscriptAssembler: streaming ----------
  const asm = createTranscriptAssembler();
  let snap = asm.addChunk({ text: 'Why did', ts: 2, isFinal: false });
  ok(snap.segments.length === 0 && snap.pending && snap.pending.text === 'Why did',
    'assembler: an interim chunk sets pending but commits nothing');
  snap = asm.addChunk({ text: 'Why did revenue drop?', ts: 2, isFinal: true });
  ok(snap.segments.length === 1 && snap.pending === null,
    'assembler: a final chunk commits the segment and clears pending');
  snap = asm.addChunk({ text: '   ', isFinal: true });
  ok(snap.segments.length === 1, 'assembler: a whitespace-only final chunk commits nothing');
  asm.addChunk({ text: 'interim two', isFinal: false });
  snap = asm.addChunk({ text: 'Can you also pull last quarter?', ts: 9, isFinal: true });
  ok(snap.segments.length === 2 && snap.segments[1].ts === 9, 'assembler: second final chunk appends with its timestamp');
  asm.reset();
  ok(asm.snapshot().segments.length === 0 && asm.snapshot().pending === null, 'assembler: reset clears committed segments and pending');

  // The streaming assembler and the batch reducer agree on committed output for
  // the same sequence of FINAL chunks.
  const finals = [
    { text: 'line a', ts: 1, isFinal: true },
    { text: 'line b', ts: 4, isFinal: true },
  ];
  const streamed = (() => { const a = createTranscriptAssembler(); let s; for (const c of finals) s = a.addChunk(c); return s.segments; })();
  ok(JSON.stringify(streamed) === JSON.stringify(assembleSegments(finals)),
    'assembler vs assembleSegments: identical committed output for the same final sequence');

  // ---------- 4. Integration with the EXISTING tagSegmentsWithContext ----------
  const assembled = assembleSegments([
    { text: 'Are you sure revenue dropped in March?', ts: 100, isFinal: true },
    { text: 'Can you also pull the refund rate?', ts: 900, isFinal: true },
  ]);
  const taggedNoContext = tagSegmentsWithContext(assembled, []);
  ok(taggedNoContext.length === 2, 'integration: assembled segments feed tagSegmentsWithContext one-for-one');
  ok(taggedNoContext.every((s) => s.context === null), 'integration: with no context timeline every assembled segment is tagged null (agent graceful-degradation path)');
  ok(taggedNoContext[0].pushback.isPushback === true, 'integration: pushback detection still fires on an assembled segment');
  ok(taggedNoContext[1].dataRequest.isDataRequest === true, 'integration: data-request detection still fires on an assembled segment');

  const timeline = [
    { ts: 50, chart: 'revenue-trend', queryLabel: 'monthly_revenue' },
    { ts: 800, chart: 'refund-rate', queryLabel: 'refund_rate_by_month' },
  ];
  const taggedWithContext = tagSegmentsWithContext(assembled, timeline);
  ok(taggedWithContext[0].context && taggedWithContext[0].context.chart === 'revenue-trend',
    'integration: assembled segment is tagged with the active chart at its timestamp');
  ok(taggedWithContext[1].context && taggedWithContext[1].context.chart === 'refund-rate',
    'integration: later assembled segment picks up the newer context event');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
