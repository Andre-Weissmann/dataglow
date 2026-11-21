// Shared audio/video file Whisper pipeline. Inference is local; generic runtime
// and model files download after consent. Browser-only, WebGPU required.
import {
  audioBufferToMono16k, requireMediaConsent, checkAbort,
  SAMPLE_RATE, MAX_MEDIA_SECONDS, MAX_MEDIA_BYTES,
} from './audio-pcm.js';

export const WHISPER_FILE_MODEL_ID = 'onnx-community/whisper-base';
export const WHISPER_FILE_MODEL_LABEL = 'Whisper base (on-device, WebGPU)';
const TRANSFORMERS_ESM_URL = 'https://esm.run/@huggingface/transformers@3.0.2';
let transcriberPromise = null;
let busy = false;

export function isFileTranscriptionAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

async function loadFileTranscriber(onProgress) {
  if (!isFileTranscriptionAvailable()) {
    throw new Error('A WebGPU-capable desktop browser is required. No cloud fallback is used.');
  }
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      if (!await navigator.gpu.requestAdapter()) throw new Error('No usable WebGPU adapter found.');
      const tf = await import(/* @vite-ignore */ TRANSFORMERS_ESM_URL);
      tf.env.allowLocalModels = false;
      return tf.pipeline('automatic-speech-recognition', WHISPER_FILE_MODEL_ID, {
        device: 'webgpu',
        progress_callback: report => onProgress?.({
          text: report.status || 'Loading model',
          progress: Number.isFinite(report.progress) ? report.progress / 100 : 0,
        }),
      });
    })().catch(error => { transcriberPromise = null; throw error; });
  }
  return transcriberPromise;
}

export function normalizeWhisperSegments(result, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid audio duration.');
  // Do not invent timestamps when the model fails to supply chunks.
  if (!Array.isArray(result?.chunks)) throw new Error('Whisper returned no timestamped segments.');
  return result.chunks.map(chunk => {
    const [start, rawEnd] = chunk.timestamp || [];
    const end = rawEnd === null ? duration : rawEnd;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0
      || start > duration || end < start || end > duration + 0.25
      || typeof chunk.text !== 'string') throw new Error('Whisper returned an invalid timestamped segment.');
    return { timestamp: [start, Math.min(end, duration)], text: chunk.text };
  });
}

export async function transcribePcm(audio, options = {}) {
  requireMediaConsent(options);
  if (!(audio instanceof Float32Array) || !audio.length
    || audio.length > MAX_MEDIA_SECONDS * SAMPLE_RATE || audio.some(x => !Number.isFinite(x))) {
    throw new Error('Invalid or oversized 16kHz mono audio.');
  }
  if (busy) throw new Error('Another transcription is running. Wait or cancel it first.');
  busy = true;
  try {
    const transcriber = await loadFileTranscriber(options.onProgress);
    checkAbort(options.signal);
    options.onProgress?.({ text: 'Transcribing on this device', progress: 0 });
    const result = await transcriber(audio, {
      return_timestamps: true, chunk_length_s: 30, stride_length_s: 5,
    });
    // Transformers.js 3 does not promise immediate inference cancellation.
    // A cancelled run must never return a review or import, even if it finishes.
    checkAbort(options.signal);
    return normalizeWhisperSegments(result, audio.length / SAMPLE_RATE);
  } finally {
    busy = false;
  }
}

export async function transcribeAudioFile(file, options = {}) {
  requireMediaConsent(options);
  if (!file || !(file.size > 0) || file.size > MAX_MEDIA_BYTES
    || !/\.(mp3|wav|m4a|flac)$/i.test(file.name || '')) {
    throw new Error('Choose an MP3, WAV, M4A or FLAC file up to 200 MiB.');
  }
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) throw new Error('Audio decoding is unavailable in this browser.');
  const ctx = new AudioCtx();
  let audio;
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    checkAbort(options.signal);
    audio = audioBufferToMono16k(decoded);
  } finally {
    await ctx.close();
  }
  return transcribePcm(audio, options);
}
