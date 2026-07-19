/**
 * whisper-worker.scaffold.js
 *
 * SCAFFOLD — Copy this file to whisper-worker.js in your build output.
 * transformers.js must be loaded via importScripts or ESM import in the actual worker.
 *
 * This worker:
 * 1. Receives an AudioBuffer (as Float32Array + sampleRate) from the main thread
 * 2. Resamples to 16kHz mono (required by Whisper)
 * 3. Runs Whisper transcription via transformers.js pipeline
 * 4. Posts back { type: 'segments', data: [...] } with the raw Whisper output
 * 5. Posts { type: 'progress', percent: number } during transcription
 * 6. Posts { type: 'error', message: string } on failure
 *
 * WebGPU note: transformers.js automatically uses WebGPU when available (Chrome 113+,
 * Edge, Safari 2026). Falls back to WASM on unsupported browsers. 5-10x speedup with WebGPU.
 *
 * Model: openai/whisper-tiny.en for speed (39M params), whisper-base.en for accuracy (74M params)
 * Models are cached in the browser after first download (~150MB for base).
 *
 * DOWNSTREAM: the raw `{ timestamp: [start, end], text }` segments posted back
 * in the 'segments' message are handed to `structureTranscription()` in
 * js/audio/audio-structurer.js, which turns them into a DATAGLOW dataset
 * (segment_id, start_sec, end_sec, duration_sec, text, char_count, word_count,
 * words_per_minute) ready to load into the DuckDB grid.
 *
 * SPEAKER DIARIZATION: not implemented in this PR. `audio-structurer.js`
 * already scaffolds a `speaker` column (via `options.speakerColumn`) with a
 * 'SPEAKER_00' placeholder so the eventual diarization model can be dropped
 * in later without changing the dataset shape.
 */

// ------------------------------------------------------------------
// Step 1: Import transformers.js (uncomment in actual worker)
// ------------------------------------------------------------------
// transformers.js ships as an ESM module and works directly inside a Worker
// via a dynamic `import()` (module workers) or `importScripts()` (classic
// workers, if a UMD build is used). The CDN build is the zero-install path;
// swap for a locally bundled copy if an offline/air-gapped build is needed.
//
// import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

// ------------------------------------------------------------------
// Step 2: Initialize the Whisper pipeline (lazy, on first message)
// ------------------------------------------------------------------
// The pipeline is expensive to construct (it downloads + compiles the model),
// so it is built once and cached in this module-level variable rather than
// on every 'transcribe' message. The first transcription request in a session
// pays the download cost; every request after that reuses the cached pipeline
// and the browser's own model cache (IndexedDB/Cache Storage).
let whisperPipeline = null;

async function initPipeline() {
  if (whisperPipeline) return;
  // whisperPipeline = await pipeline('automatic-speech-recognition', 'openai/whisper-tiny.en', {
  //   device: 'webgpu',    // falls back to 'wasm' automatically if WebGPU unavailable
  //   dtype: 'fp32',
  // });
}

// ------------------------------------------------------------------
// Step 3: Resample audio to 16kHz mono (required by Whisper)
// ------------------------------------------------------------------
// Whisper was trained on 16kHz mono audio. Most browser-decoded audio (via
// AudioContext) comes in at 44.1kHz or 48kHz, so the raw PCM must be
// downsampled before it reaches the pipeline. This is a naive nearest-sample
// resampler — good enough for speech-to-text (which is far more sensitive to
// spectral content than to resampling artifacts) and cheap enough to run
// synchronously in the worker without pulling in an extra DSP dependency.
function resampleTo16kHz(float32Array, originalSampleRate) {
  if (originalSampleRate === 16000) return float32Array;
  const ratio = originalSampleRate / 16000;
  const newLength = Math.round(float32Array.length / ratio);
  const resampled = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    resampled[i] = float32Array[Math.round(i * ratio)];
  }
  return resampled;
}

// ------------------------------------------------------------------
// Step 4: Handle messages from main thread
// ------------------------------------------------------------------
// The main thread posts { type: 'transcribe', audioData: Float32Array,
// sampleRate: number } after decoding the dropped file via AudioContext. This
// worker never touches the DOM, never does its own file I/O, and never
// uploads anything — the raw PCM samples arrive already decoded, and the
// only outputs are the three postMessage shapes documented above.
self.addEventListener('message', async (event) => {
  const { type, audioData, sampleRate } = event.data;

  if (type === 'transcribe') {
    try {
      await initPipeline();
      const mono16k = resampleTo16kHz(audioData, sampleRate);

      // Run Whisper with timestamp generation
      // const result = await whisperPipeline(mono16k, {
      //   return_timestamps: true,
      //   chunk_length_s: 30,
      //   callback_function: (partial) => {
      //     self.postMessage({ type: 'progress', percent: partial.progress ?? 0 });
      //   }
      // });
      // self.postMessage({ type: 'segments', data: result.chunks });

      // SCAFFOLD: post mock data for development testing
      self.postMessage({
        type: 'segments',
        data: [{ timestamp: [0, 5.2], text: 'This is a scaffold response.' }]
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
});
