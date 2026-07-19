/**
 * webcodecs-audio-extractor.scaffold.js
 *
 * SCAFFOLD — Documents the WebCodecs API pattern for audio extraction from video files.
 * Copy and adapt for the DataGlow UI layer.
 *
 * WebCodecs API is cross-browser as of 2026:
 * - Chrome 94+ ✓
 * - Edge 94+ ✓
 * - Safari 2026 (Technology Preview → Stable) ✓
 * - Firefox: partial (AudioDecoder available, VideoDecoder in progress)
 *
 * The goal: extract Float32Array audio data from a video File, then hand off
 * to the Whisper Web Worker (see js/audio/whisper-worker.scaffold.js).
 */

/**
 * Extract audio from a video File using WebCodecs + AudioContext.
 *
 * Pattern A (simpler, widely supported): Use AudioContext.decodeAudioData
 * This reads the entire file into memory and decodes. Works for files < 2GB.
 * The browser's media decoder handles the video container (MP4/MOV/WebM) natively.
 *
 * @param {File} videoFile - The video file from the drop event
 * @returns {Promise<{audioData: Float32Array, sampleRate: number}>}
 */
async function extractAudioPatternA(videoFile) {
  // Step 1: Read file as ArrayBuffer
  const arrayBuffer = await videoFile.arrayBuffer();

  // Step 2: Create AudioContext
  const audioContext = new AudioContext();

  // Step 3: Decode audio (browser extracts audio track from video container)
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  // Step 4: Get mono channel (Whisper requires mono)
  // If stereo, average left and right channels
  const left = audioBuffer.getChannelData(0);
  const mono = audioBuffer.numberOfChannels === 1
    ? left
    : (() => {
        const right = audioBuffer.getChannelData(1);
        return Float32Array.from(left, (v, i) => (v + right[i]) / 2);
      })();

  return { audioData: mono, sampleRate: audioBuffer.sampleRate };
  // Hand off to whisper-worker: worker.postMessage({ type: 'transcribe', audioData: mono, sampleRate: audioBuffer.sampleRate });
}

/**
 * Pattern B (WebCodecs native, for larger files / more control):
 * Uses VideoDecoder + AudioDecoder directly.
 * More complex but handles files that AudioContext can't decode.
 *
 * This pattern is scaffolded here for future implementation.
 */
async function extractAudioPatternB_scaffold(videoFile) {
  // Step 1: Read as ReadableStream for memory efficiency
  // const stream = videoFile.stream();

  // Step 2: Create AudioDecoder
  // const decoder = new AudioDecoder({
  //   output: (audioData) => { /* collect Float32Array chunks */ },
  //   error: (err) => { console.error('AudioDecoder error:', err); }
  // });

  // Step 3: Configure decoder (codec from container metadata)
  // decoder.configure({ codec: 'mp4a.40.2' }); // AAC for MP4

  // Step 4: Feed encoded chunks from the container
  // ... (requires MP4Box.js or similar demuxer to extract encoded audio chunks)

  // Note: Pattern A covers 95%+ of cases. Pattern B is for edge cases.
  throw new Error('Pattern B not yet implemented — use extractAudioPatternA for now');
}

/**
 * Frame extraction scaffold (future vision layer)
 *
 * When local vision models mature (LLaVA, Moondream, etc. running via WebGPU),
 * DataGlow will extract frames every N seconds and caption them locally.
 * The frame captions + transcript will be cross-indexed by timestamp.
 *
 * VideoDecoder pattern:
 * - One VideoFrame every 3-4 seconds (configurable)
 * - Frame → OffscreenCanvas → ImageData → vision model
 * - Output: { timestamp_sec, caption, objects: [...] }
 * - Merged with transcript by timestamp → unified video dataset
 */
function frameExtractionScaffold() {
  // const decoder = new VideoDecoder({
  //   output: (frame) => { captureFrame(frame); frame.close(); },
  //   error: (err) => { console.error(err); }
  // });
  // Status: not_implemented — awaiting local vision model maturity
}
