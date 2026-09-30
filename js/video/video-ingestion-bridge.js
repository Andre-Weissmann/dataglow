// Pure planning helpers. Actual demux/decoding: video-audio-extractor.js.
// File extensions select candidates, never guarantee browser codec support.
import { MAX_MEDIA_BYTES } from '../audio/audio-pcm.js';

export function buildVideoManifest(fileName, fileSizeMb, durationHint) {
  return {
    fileName, fileSizeMb, durationHint,
    estimatedTranscriptionMinutes: null, // hardware/model dependent, unbenchmarked
    extractionMode: 'audio_only', frameExtractionStatus: 'not_implemented',
    processingSteps: [
      'read_local_blob_ranges', 'extract_primary_audio_via_webcodecs',
      'resample_to_16khz_mono', 'run_whisper_transcription',
      'human_review_and_confirm', 'load_reviewed_transcript_into_duckdb',
    ],
  };
}

export function validateVideoFile(fileName, mimeType, fileSizeMb) {
  if (typeof fileName !== 'string' || !/\.(mp4|mov|webm)$/i.test(fileName)) {
    return { valid: false, error: 'Choose an MP4, MOV or WebM file.' };
  }
  if (mimeType != null && mimeType !== ''
    && (typeof mimeType !== 'string' || !mimeType.startsWith('video/'))) {
    return { valid: false, error: 'Expected a video file MIME type.' };
  }
  if (!Number.isFinite(fileSizeMb) || fileSizeMb <= 0 || fileSizeMb * 1024 * 1024 > MAX_MEDIA_BYTES) {
    return { valid: false, error: 'Choose a non-empty video up to 200 MiB.' };
  }
  return { valid: true };
}

// Retained public helper; the old fixed speed factors were not measurements.
export function estimateTranscriptionTime() {
  return { estimatedSeconds: null, note: 'Processing time depends on your device and the recording. No benchmark estimate is available.' };
}

export function buildVideoTranscriptDatasetName(fileName) {
  const spaced = String(fileName || '').replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return `${spaced} (video transcript)`;
}
