// ============================================================
// DATAGLOW — Audio Ingestion: Whisper file transcription (Batch 5 of the
// Glow Compiler; opt-in, desktop-first, blocked from agent use until a
// human confirms)
// ============================================================
// This is the REAL implementation js/audio/whisper-worker.scaffold.js was a
// reference sketch for -- but it does NOT follow that scaffold's dedicated-
// Worker design. This repo already shipped a working on-device Whisper
// integration for live microphone capture (js/agents/live-transcript-
// capture.js, DataGlow Live Rooms Batch 1) that runs transformers.js'
// WebGPU pipeline directly on the main thread with no dedicated Worker --
// GPU-backed inference does not block the main thread the way CPU-bound
// synchronous work would. This module follows THAT proven, already-shipped
// pattern for one-shot file transcription instead of building a second,
// divergent Worker-based path for the same underlying pipeline. The
// scaffold file is left in place as historical reference/documentation of
// the alternative Worker-based approach; it is not deleted, but it is not
// what ships.
//
// PRIVACY / LEGAL POSTURE (identical to live-transcript-capture.js and
// ondevice-llm.js -- this is a hard, non-negotiable house rule, not a
// per-feature choice): transcription runs 100% on-device via WebGPU. The
// only network reference anywhere in this file is the lazy `import()` of
// the Transformers.js runtime as CODE (the same pinned CDN URL live capture
// already uses) -- after that one-time, generic model-weight download, the
// audio file itself and its transcript NEVER leave the machine. No upload
// primitive is named anywhere in this module.
//
// OPT-IN, DESKTOP-FIRST: this only ever runs when a human explicitly
// uploads an audio file to the Cleaning Crew tab (never automatically, never
// on file drop elsewhere) AND the browser reports WebGPU support --
// isSpeechCaptureAvailable()-style gating, but WITHOUT requiring a
// microphone (file transcription needs no getUserMedia permission at all,
// unlike live capture). "Desktop-first" is enforced at the UI layer (see
// js/app-shell/tabs/cleaning-crew-tab.js): a coarse-pointer/touch heuristic
// labels the upload as "best on desktop" rather than hard-blocking it,
// because WebGPU absence already hard-blocks unsupported devices here, and
// a second hard block would be presuming to know a specific user's device
// better than the actual capability check does. This mirrors the prior
// research finding (recorded in NORTH_STAR.md) that WebGPU support on
// mobile is real but meaningfully more fragile than desktop Chrome/Edge --
// a soft steer, not a wall.
//
// BLOCKED FROM AGENT USE UNTIL A HUMAN CONFIRMS: this module produces raw
// Whisper segments and nothing else -- it does NOT decide whether those
// segments are trustworthy. That decision is made by the EXISTING, real
// mechanism every other ingestion path already uses: js/audio/
// audio-readiness-gate.js's evaluateAudioReadiness() computes
// gate.agentConsumable via the shared js/gate/readiness-gate.js, the exact
// same field js/agents/guarded-copilot.js already checks before answering
// "is this ready for an agent." There is no second, parallel "agent block"
// flag invented here -- wiring a transcript through the SAME gate every
// other source already respects is what makes the block real rather than
// decorative.

import { isWebGPUAvailable } from '../narrative/ondevice-llm.js';

// Same pinned Transformers.js ESM build + model js/agents/live-transcript-
// capture.js already uses for live mic capture -- one model, one CDN
// reference, reused rather than duplicated so there is exactly one place
// that pins the version.
export const WHISPER_FILE_MODEL_ID = 'onnx-community/whisper-base';
export const WHISPER_FILE_MODEL_LABEL = 'Whisper base (on-device, WebGPU)';
const TRANSFORMERS_ESM_URL = 'https://esm.run/@huggingface/transformers@3.0.2';
const TARGET_SAMPLE_RATE = 16000;

/**
 * Whether this browser can run on-device Whisper file transcription. Unlike
 * js/agents/live-transcript-capture.js's isSpeechCaptureAvailable(), this
 * does NOT require a microphone -- transcribing an already-uploaded file
 * needs no getUserMedia permission. Never throws.
 * @returns {boolean}
 */
export function isFileTranscriptionAvailable() {
  try {
    return isWebGPUAvailable();
  } catch {
    return false;
  }
}

let transcriberPromise = null;

// Lazily download + initialize the on-device STT pipeline. Throws a tagged
// error when WebGPU is unavailable, exactly like live-transcript-capture.js's
// loadTranscriber(), so the caller can show an honest message rather than a
// confusing downstream failure.
async function loadFileTranscriber(onProgress) {
  if (!isFileTranscriptionAvailable()) {
    const err = new Error(
      'Audio transcription needs a WebGPU-capable browser (recent Chrome, Edge, or Chrome on ' +
      'Android; Safari 18+). It works best on desktop.'
    );
    err.code = 'NO_WEBGPU';
    throw err;
  }
  if (transcriberPromise) return transcriberPromise;
  transcriberPromise = (async () => {
    const tf = await import(/* @vite-ignore */ TRANSFORMERS_ESM_URL);
    return tf.pipeline('automatic-speech-recognition', WHISPER_FILE_MODEL_ID, {
      device: 'webgpu',
      progress_callback: (report) => {
        if (typeof onProgress === 'function') {
          onProgress({
            progress: report && report.progress ? report.progress / 100 : 0,
            text: (report && report.status) || '',
          });
        }
      },
    });
  })().catch((err) => {
    transcriberPromise = null; // allow retry after a failed load
    throw err;
  });
  return transcriberPromise;
}

// Downmix a decoded AudioBuffer to mono at Whisper's expected 16kHz. Linear
// resample -- identical approach to live-transcript-capture.js's toMono16k
// and the original whisper-worker.scaffold.js's resampleTo16kHz, just named
// to match this file's own local convention.
function toMono16k(audioBuffer) {
  const src = audioBuffer.getChannelData(0);
  const ratio = audioBuffer.sampleRate / TARGET_SAMPLE_RATE;
  if (ratio <= 1) return src;
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = src[Math.floor(i * ratio)];
  return out;
}

/**
 * Transcribe an uploaded audio File entirely on-device. BROWSER-ONLY (real
 * WebGPU/transformers.js) -- not covered by Node tests, exactly like
 * profilePdf() in js/cleaning-crew/pdf-profiler.js and the browser-only half
 * of live-transcript-capture.js. The pure structuring/gating it feeds into
 * (js/audio/audio-structurer.js, js/audio/audio-readiness-gate.js) IS tested
 * against injected segment arrays.
 *
 * @param {File|Blob} file the uploaded audio file (mp3/wav/m4a/flac)
 * @param {(p:{progress:number,text:string})=>void} [onProgress]
 * @returns {Promise<Array<{timestamp:[number,number], text:string}>>} raw
 *   Whisper segments, the SAME shape js/audio/audio-structurer.js expects
 */
export async function transcribeAudioFile(file, onProgress) {
  const transcriber = await loadFileTranscriber(onProgress);
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const buf = await file.arrayBuffer();
  const ctx = new AudioCtx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } finally {
    await ctx.close();
  }
  const mono16k = toMono16k(decoded);
  const result = await transcriber(mono16k, { return_timestamps: true });
  const chunks = (result && result.chunks) || [];
  // Defensive normalization: a Whisper result with no chunks (e.g. a very
  // short clip) still returns { text }, not { chunks: [...] } -- fall back
  // to one whole-clip segment so downstream code never sees an empty array
  // for audio that DID produce a top-level text.
  if (chunks.length === 0 && result && typeof result.text === 'string' && result.text.trim()) {
    return [{ timestamp: [0, decoded.duration || 0], text: result.text }];
  }
  return chunks.map((c) => ({
    timestamp: Array.isArray(c.timestamp) ? c.timestamp : [0, decoded.duration || 0],
    text: typeof c.text === 'string' ? c.text : '',
  }));
}
