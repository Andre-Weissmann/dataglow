// ============================================================
// DATAGLOW — Live Transcript Capture (DataGlow Live Rooms, Batch 1)
// ============================================================
// The follow-up the Meeting Scribe agent (js/agents/meeting-scribe-agent.js)
// deliberately deferred: an actual LIVE audio-capture + on-device
// speech-to-text input path, so the Meeting tab no longer requires a person to
// paste a transcript by hand. It does NOT replace the paste path — it sits
// beside it as an additional input.
//
// This module follows the EXACT pure-vs-browser split js/narrative/ondevice-llm.js
// established:
//   • The top half is pure, deterministic, DOM/browser-API-free logic that is
//     unit-tested in Node — a capability check that never throws
//     (`isSpeechCaptureAvailable`, mirroring `isWebGPUAvailable`) plus a
//     segment-assembly reducer/streamer that turns raw STT output chunks
//     (interim/final text + timestamps) into the SAME `{text, ts}` segment
//     shape `parseTranscriptText` (js/agents/meeting-scribe-ui.js) already
//     produces, so the result can be fed directly into the EXISTING, unchanged
//     `tagSegmentsWithContext` (js/agents/meeting-scribe-agent.js).
//   • The bottom half (below the "Browser-only" banner) is the getUserMedia mic
//     capture + a lazily-CDN-loaded on-device WebGPU Whisper-family STT
//     pipeline. It requires a microphone and WebGPU and is exercised only in a
//     real browser (same posture as ondevice-llm.js's model loading).
//
// PRIVACY / LEGAL POSTURE (non-negotiable, identical to ondevice-llm.js):
//   • Transcription runs 100% on-device via WebGPU. The STT library is fetched
//     from a CDN as CODE (an ES module), never as a path that sends microphone
//     audio anywhere — after the one-time model-weight download (generic model
//     files, never user audio) no audio ever leaves the machine.
//   • This module names no upload primitive. The only network reference is the
//     lazy `import()` of the STT runtime, exactly like WebLLM in ondevice-llm.js.
//
// The pure segment-assembly logic is complete and correct on its own: a device
// with no microphone or no WebGPU simply cannot start a live capture (the
// capability check returns false and the UI degrades gracefully), but the
// assembler, the tagging, and the paste path all keep working untouched.

// ---------- pure: capability check ----------

// Live capture needs BOTH a microphone (navigator.mediaDevices.getUserMedia)
// AND WebGPU (the on-device STT engine runs on the GPU, same requirement as the
// on-device LLM in ondevice-llm.js). Returns false (never throws) when either is
// unavailable, so callers can degrade gracefully — the paste-a-transcript path
// is always still available.
export function isSpeechCaptureAvailable() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const hasMic = !!(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function');
    const hasGpu = !!(nav && nav.gpu);
    return hasMic && hasGpu;
  } catch {
    return false;
  }
}

// ---------- pure: STT-chunk → segment assembly ----------

/**
 * A raw STT output chunk, as a Whisper-family streaming pipeline emits them:
 *   { text: string, ts?: number, isFinal?: boolean }
 * where `ts` is a meeting-relative timestamp in SECONDS (matching the unit
 * `parseTranscriptText` uses so the two input paths are interchangeable), and
 * `isFinal` distinguishes a committed result from a superseded interim guess.
 * Interim chunks (`isFinal !== true`) are provisional partial transcripts the
 * engine will revise; only final chunks become committed segments.
 *
 * The output segment is exactly `parseTranscriptText`'s shape: `{ text, ts }`
 * with `text` trimmed and non-empty and `ts` an integer second, so it feeds
 * straight into the unchanged `tagSegmentsWithContext`.
 */

function normalizeTs(ts) {
  return typeof ts === 'number' && Number.isFinite(ts) ? Math.max(0, Math.floor(ts)) : null;
}

/**
 * Reduce a full list of STT chunks into committed `{text, ts}` segments.
 * Interim results are discarded (they are superseded by a later final for the
 * same span); empty/whitespace-only text is filtered; a chunk with no explicit
 * `ts` is auto-numbered one second after the previous committed segment (or 0
 * for the first) — the SAME auto-numbering rule `parseTranscriptText` uses for a
 * bare typed line, so a live capture and a pasted transcript produce identical
 * segment shapes. Pure and deterministic; never throws on malformed input.
 * @param {Array<{text:string, ts?:number, isFinal?:boolean}>} chunks
 * @returns {Array<{text:string, ts:number}>}
 */
export function assembleSegments(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const out = [];
  let lastTs = -1;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (c.isFinal !== true) continue; // interim results are provisional, never committed
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (text === '') continue; // empty/whitespace-only chunks are dropped
    const given = normalizeTs(c.ts);
    const ts = given != null ? given : lastTs + 1;
    lastTs = ts;
    out.push({ text, ts });
  }
  return out;
}

/**
 * Stateful streaming assembler for the live path: feed it one STT chunk at a
 * time and it tracks the committed segments plus the current in-flight interim
 * ("pending") text so a caller can show a live "…" line without committing it.
 * A final chunk commits and clears the pending line; an interim chunk only
 * updates the pending line. This is the streaming counterpart to
 * `assembleSegments` and produces byte-identical committed output for the same
 * final-chunk sequence. Pure/browser-free — no DOM, no network.
 * @returns {{addChunk:Function, snapshot:Function, reset:Function}}
 */
export function createTranscriptAssembler() {
  const committed = [];
  let lastTs = -1;
  let pending = null;

  const snapshot = () => ({
    segments: committed.map((s) => ({ ...s })),
    pending: pending ? { ...pending } : null,
  });

  function addChunk(chunk) {
    if (!chunk || typeof chunk !== 'object') return snapshot();
    const text = typeof chunk.text === 'string' ? chunk.text.trim() : '';
    const given = normalizeTs(chunk.ts);
    if (chunk.isFinal === true) {
      if (text === '') { pending = null; return snapshot(); }
      const ts = given != null ? given : lastTs + 1;
      lastTs = ts;
      committed.push({ text, ts });
      pending = null;
    } else {
      pending = text === '' ? null : { text, ts: given != null ? given : lastTs + 1 };
    }
    return snapshot();
  }

  function reset() {
    committed.length = 0;
    lastTs = -1;
    pending = null;
  }

  return { addChunk, snapshot, reset };
}

// ============================================================
// Browser-only: microphone capture + on-device WebGPU STT
// ============================================================
// Everything below requires a real browser (getUserMedia + WebGPU) and is NOT
// unit-tested — it mirrors ondevice-llm.js's model-loading path, which is
// likewise browser-only and verified manually in a WebGPU-capable browser.
//
// MODEL & LICENSE (per DataGlow's open-weights guardrail, same posture as the
// Qwen model in ondevice-llm.js):
//   • Model:   whisper-base  (OpenAI), ONNX build from the community mirror
//   • Runtime: Hugging Face Transformers.js, Apache-2.0
//              (https://github.com/huggingface/transformers.js)
// Both are permissively licensed and open-weight; the library is loaded lazily
// from a CDN as CODE the moment the user opts in, keeping it out of the initial
// page load and never routing audio anywhere.
export const STT_MODEL_ID = 'onnx-community/whisper-base';
export const STT_MODEL_LABEL = 'Whisper base (on-device, WebGPU)';

// Pinned Transformers.js ESM build. Loaded only on opt-in (mirrors WEBLLM_ESM_URL).
const TRANSFORMERS_ESM_URL = 'https://esm.run/@huggingface/transformers@3.0.2';

// Sample rate Whisper expects.
const TARGET_SAMPLE_RATE = 16000;
// How much audio to accumulate before running one transcription pass.
const WINDOW_MS = 5000;

let transcriberPromise = null;

// Lazily download + initialize the on-device STT pipeline. Throws a tagged
// error when WebGPU is unavailable so the caller can show an honest message,
// exactly like loadModel() in ondevice-llm.js.
async function loadTranscriber(onProgress) {
  if (!isSpeechCaptureAvailable()) {
    const err = new Error('Live capture needs a microphone and a WebGPU-capable browser (recent Chrome, Edge, or Chrome on Android; Safari 18+).');
    err.code = 'NO_SPEECH_CAPTURE';
    throw err;
  }
  if (transcriberPromise) return transcriberPromise;
  transcriberPromise = (async () => {
    const tf = await import(/* @vite-ignore */ TRANSFORMERS_ESM_URL);
    return tf.pipeline('automatic-speech-recognition', STT_MODEL_ID, {
      device: 'webgpu',
      progress_callback: (report) => {
        if (typeof onProgress === 'function') {
          onProgress({ progress: report && report.progress ? report.progress / 100 : 0, text: (report && report.status) || '' });
        }
      },
    });
  })().catch((err) => {
    transcriberPromise = null; // allow retry after a failed load
    throw err;
  });
  return transcriberPromise;
}

export function isTranscriberLoaded() {
  return transcriberPromise != null;
}

// Downmix + resample a decoded AudioBuffer to the mono 16kHz Float32Array
// Whisper expects. Linear resample is plenty for speech.
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
 * Start a live microphone capture that streams committed `{text, ts}` segments
 * to `onUpdate` as the on-device STT engine transcribes rolling audio windows.
 * Browser-only. Returns a controller with `stop()`; nothing is uploaded — the
 * MediaRecorder blob is decoded and transcribed entirely on-device.
 *
 * @param {object} opts
 * @param {(update:{segments:Array<{text:string,ts:number}>, pending:object|null})=>void} opts.onUpdate
 * @param {(err:Error)=>void} [opts.onError]
 * @param {(p:{progress:number,text:string})=>void} [opts.onProgress]
 * @returns {Promise<{stop:Function}>}
 */
export async function startLiveCapture({ onUpdate = () => {}, onError = () => {}, onProgress = () => {} } = {}) {
  const transcriber = await loadTranscriber(onProgress);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const assembler = createTranscriptAssembler();
  const startedAt = Date.now();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const recorder = new MediaRecorder(stream);
  let stopped = false;

  recorder.ondataavailable = async (evt) => {
    if (stopped || !evt.data || evt.data.size === 0) return;
    try {
      const buf = await evt.data.arrayBuffer();
      const ctx = new AudioCtx();
      const decoded = await ctx.decodeAudioData(buf);
      await ctx.close();
      const audio = toMono16k(decoded);
      const result = await transcriber(audio);
      const text = (result && (Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text)) || '';
      const ts = Math.floor((Date.now() - startedAt) / 1000);
      onUpdate(assembler.addChunk({ text, ts, isFinal: true }));
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  recorder.start();
  const tick = setInterval(() => { if (!stopped && recorder.state === 'recording') recorder.requestData(); }, WINDOW_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(tick);
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ }
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
