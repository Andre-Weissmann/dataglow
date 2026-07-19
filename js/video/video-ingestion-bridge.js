// ============================================================
// DATAGLOW — Video Ingestion Bridge (audio-only, Batch 1)
// ============================================================
// WHY THIS EXISTS:
// DATAGLOW's Universal Drop Zone already turns audio files into structured,
// queryable datasets via the Whisper pipeline (see js/audio/whisper-worker.scaffold.js,
// PR M). Video files carry the same spoken-word content, just muxed into a
// container alongside a video track. Re-using the Whisper pipeline for video
// means: extract the audio track in the browser (WebCodecs / AudioContext),
// then feed it through the exact same transcription → structuring → DuckDB
// load path that audio ingestion already uses. No new transcription engine,
// no new dataset shape — video ingestion is a BRIDGE, not a parallel pipeline.
//
// WHAT THIS MODULE IS: pure-logic helpers only — no DOM, no WebCodecs calls,
// no file I/O. It documents the shape of the video ingestion manifest,
// validates candidate files before they reach the (browser-only) extraction
// step, estimates transcription time, and derives a dataset name for the
// resulting transcript. This lets the architecture be tested with plain
// Node, independent of any browser runtime.
//
// WHAT IT DELIBERATELY DOES NOT DO YET (deferred):
//   - No audio is actually extracted here. See
//     js/video/webcodecs-audio-extractor.scaffold.js for the browser-side
//     pattern (AudioContext.decodeAudioData / WebCodecs AudioDecoder).
//   - No frame extraction / vision captioning. `extractionMode` is always
//     'audio_only' in this batch; 'audio_and_frames' is reserved for when a
//     local vision model (WebGPU) is wired in. frameExtractionStatus reports
//     'not_implemented' honestly rather than implying a capability that
//     doesn't exist.
//   - No wiring into the Universal Drop Zone UI or the Whisper worker itself
//     — that integration is a follow-up batch once this bridge lands.
//
// Identity split (same convention as js/glow/glow-signal.js): this file is
// the pure logic; any future UI batch stays in a separate module.
// ============================================================

/**
 * Build the manifest DATAGLOW uses to plan a video ingestion run.
 *
 * @param {string} fileName
 * @param {number} fileSizeMb
 * @param {number|null} durationHint - seconds, from file metadata if available
 * @returns {object} video ingestion manifest
 */
export function buildVideoManifest(fileName, fileSizeMb, durationHint) {
  return {
    fileName,
    fileSizeMb,
    durationHint,
    // ~0.3x real-time with WebGPU Whisper (5-10x speedup over CPU's ~3x real-time)
    estimatedTranscriptionMinutes: durationHint
      ? Math.ceil((durationHint / 60) * 0.3)
      : null,
    extractionMode: 'audio_only', // 'audio_only' | 'audio_and_frames' (future)
    frameExtractionStatus: 'not_implemented',
    processingSteps: [
      'read_video_as_arraybuffer',
      'extract_audio_via_webcodecs',
      'resample_to_16khz_mono',
      'run_whisper_transcription',
      'structure_via_audio_structurer',
      'load_into_duckdb',
    ],
  };
}

const VALID_EXTENSIONS = ['.mp4', '.mov', '.webm'];
const LARGE_FILE_WARNING_MB = 200;
const MAX_FILE_SIZE_MB = 500;

/**
 * Validate a candidate video file before attempting browser-side extraction.
 *
 * @param {string} fileName
 * @param {string} mimeType - may be '' if the browser couldn't sniff one
 * @param {number} fileSizeMb
 * @returns {{ valid: boolean, error?: string, warning?: string }}
 */
export function validateVideoFile(fileName, mimeType, fileSizeMb) {
  const lowerName = (fileName || '').toLowerCase();
  const hasValidExtension = VALID_EXTENSIONS.some((ext) => lowerName.endsWith(ext));

  if (!hasValidExtension) {
    return {
      valid: false,
      error: `Unsupported file type. Expected one of: ${VALID_EXTENSIONS.join(', ')}.`,
    };
  }

  const mimeOk = mimeType === '' || mimeType == null || mimeType.startsWith('video/');
  if (!mimeOk) {
    return {
      valid: false,
      error: `Unsupported MIME type "${mimeType}". Expected a video/* type.`,
    };
  }

  if (fileSizeMb >= MAX_FILE_SIZE_MB) {
    return {
      valid: false,
      error: `File too large (${fileSizeMb}MB). Maximum supported size is ${MAX_FILE_SIZE_MB}MB.`,
    };
  }

  if (fileSizeMb > LARGE_FILE_WARNING_MB) {
    return {
      valid: true,
      warning:
        'Large video file. Transcription may take several minutes. Audio extraction only — frames are not processed in this version.',
    };
  }

  return { valid: true };
}

const WEBGPU_REALTIME_FACTOR = 0.1; // 10x real-time, Whisper tiny
const WASM_REALTIME_FACTOR = 0.5; // 2x real-time, Whisper tiny WASM

function formatDurationNote(estimatedSeconds, hasWebGPU) {
  const minutes = estimatedSeconds / 60;
  const human =
    minutes >= 1
      ? `~${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`
      : `~${Math.round(estimatedSeconds)} seconds`;

  return hasWebGPU
    ? `${human} with WebGPU acceleration`
    : `${human} without WebGPU (upgrade to Chrome/Edge for faster processing)`;
}

/**
 * Estimate how long transcription will take for a given audio duration.
 *
 * @param {number} durationSec
 * @param {boolean} hasWebGPU
 * @returns {{ estimatedSeconds: number, note: string }}
 */
export function estimateTranscriptionTime(durationSec, hasWebGPU) {
  const factor = hasWebGPU ? WEBGPU_REALTIME_FACTOR : WASM_REALTIME_FACTOR;
  const estimatedSeconds = durationSec * factor;
  return {
    estimatedSeconds,
    note: formatDurationNote(estimatedSeconds, hasWebGPU),
  };
}

/**
 * Derive the dataset name for a video's transcript.
 * e.g. "interview_2026_07.mp4" -> "interview 2026 07 (video transcript)"
 *
 * @param {string} fileName
 * @returns {string}
 */
export function buildVideoTranscriptDatasetName(fileName) {
  const withoutExtension = (fileName || '').replace(/\.[^/.]+$/, '');
  const spaced = withoutExtension.replace(/[_-]+/g, ' ').trim();
  return `${spaced} (video transcript)`;
}
