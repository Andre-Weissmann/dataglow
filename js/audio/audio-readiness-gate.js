// ============================================================
// DATAGLOW — Audio Ingestion: AI Readiness Gate wiring (Batch 5 of the
// Glow Compiler; Whisper transcription, opt-in, desktop-first)
// ============================================================
// Mirrors js/cleaning-crew/pdf-profiler.js's buildPdfGateLayers/
// evaluatePdfReadiness EXACTLY: this module invents no new gate mechanics,
// no new severity vocabulary, and no fabricated confidence number. It
// composes the SAME js/gate/readiness-gate.js (computeReadinessGate /
// explainGateReasons) every other ingestion path already funnels through.
//
// WHY NO CONFIDENCE SCORE: transformers.js' automatic-speech-recognition
// pipeline (the one this repo already loads for live mic capture in
// js/agents/live-transcript-capture.js) does not surface a per-segment
// confidence value in its default output -- it returns plain
// { text, chunks: [{ timestamp: [start, end], text }] }, exactly the shape
// js/audio/audio-structurer.js already consumes. Whisper's underlying model
// DOES compute sequence-level log-probabilities internally, but exposing
// them requires deeper pipeline plumbing (output_scores) this repo's Whisper
// integration does not yet do. Rather than fabricate a confidence number
// DataGlow cannot actually back with evidence -- exactly the overconfidence
// failure mode this project's own research (see NORTH_STAR.md) explicitly
// warns against -- this gate uses the same honest, structural signal the
// PDF gate uses: how much of the audio actually produced any transcribed
// text at all, using ONLY the real segment array Whisper handed back.
//
// THE SIGNAL: Whisper's chunking still emits a chunk for silent/non-speech
// stretches -- it just comes back with empty (or whitespace-only) text.
// A transcript where every chunk is empty means transcription produced
// nothing usable (hard fail, mirrors PDF's "zero extractable text"). A
// transcript where SOME chunks are empty (long pauses, non-speech noise,
// intro/outro silence) is normal and expected -- warn, not fail, mirrors
// PDF's "some pages have no extractable text" case exactly. A transcript
// where every chunk has real text passes cleanly.
//
// Identity split (same convention as pdf-profiler.js): everything in this
// file is PURE, deterministic, DOM-free, Node-testable. It takes an
// ALREADY-TRANSCRIBED segment array as plain data -- it never touches
// transformers.js, WebGPU, or a Worker itself. The browser-only Whisper
// pipeline loading lives in js/agents/live-transcript-capture.js's
// loadTranscriber() pattern, reused (not duplicated) by the file-upload
// wiring in js/app-shell/loaders.js.

import { computeReadinessGate, explainGateReasons } from '../gate/readiness-gate.js';
import { validateTranscriptionInput } from './audio-structurer.js';

function chunkHasText(seg) {
  return typeof seg.text === 'string' && seg.text.trim().length > 0;
}

/**
 * Build AI Readiness Gate layers from a raw Whisper segment array. PURE --
 * never throws, never touches the network/DOM. Mirrors
 * pdf-profiler.js's buildPdfGateLayers() structure exactly: one hard-fail-or-
 * pass primary layer, plus an optional warn layer for partial coverage.
 *
 * @param {Array<{timestamp:[number,number], text:string}>} whisperSegments
 * @returns {Array<{layer:string, status:'pass'|'warn'|'fail', summary:string}>}
 */
export function buildAudioGateLayers(whisperSegments) {
  const validation = validateTranscriptionInput(whisperSegments);
  if (!validation.valid) {
    return [{
      layer: 'Audio transcription',
      status: 'fail',
      summary: `No usable transcription: ${validation.error}.`,
    }];
  }

  const total = whisperSegments.length;
  const withText = whisperSegments.filter(chunkHasText).length;
  const withoutText = total - withText;
  const layers = [];

  if (withText === 0) {
    layers.push({
      layer: 'Audio transcription',
      status: 'fail',
      summary: `No speech was transcribed across all ${total} segment(s) -- likely silence, ` +
        `non-speech audio, or a language/model mismatch.`,
    });
    return layers;
  }

  layers.push({
    layer: 'Audio transcription',
    status: 'pass',
    summary: `Transcribed speech in ${withText} of ${total} segment(s).`,
  });

  if (withoutText > 0) {
    layers.push({
      layer: 'Audio segment coverage',
      status: 'warn',
      summary: `${withoutText} of ${total} segment(s) produced no text (pauses, silence, or ` +
        `non-speech audio are expected and normal -- this is not itself an error).`,
    });
  }

  return layers;
}

/**
 * Evaluate AI Readiness for a raw Whisper transcription. Mirrors
 * pdf-profiler.js's evaluatePdfReadiness() exactly -- same composition, same
 * return shape, so any existing caller of the PDF version (e.g. a future
 * unified "Cleaning Crew profile" viewer) can treat both the same way.
 *
 * IMPORTANT: gate.agentConsumable here is the ONLY mechanism that marks a
 * transcript as "not yet safe for an AI agent to reason over." It is the
 * exact same js/gate/readiness-gate.js mechanism js/agents/guarded-copilot.js
 * already checks (answerDeterministic's is_ready_for_agent intent) -- there
 * is no separate, second "blocked from agent use" flag to keep in sync.
 *
 * @param {Array<{timestamp:[number,number], text:string}>} whisperSegments
 * @param {object} [options] forwarded to computeReadinessGate (e.g. {threshold})
 * @returns {{gate:object, explanation:string, layers:Array<object>}}
 */
export function evaluateAudioReadiness(whisperSegments, options = {}) {
  const layers = buildAudioGateLayers(whisperSegments);
  const gate = computeReadinessGate(layers, null, options);
  return { gate, explanation: explainGateReasons(gate), layers };
}
