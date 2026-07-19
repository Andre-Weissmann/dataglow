// ============================================================
// DATAGLOW — Video Ingestion Bridge test suite (batch 1: pure logic)
// ============================================================
// Proves the pure helpers in js/video/video-ingestion-bridge.js behave as
// documented: file validation (extension/size/mime), transcription-time
// estimation (WebGPU vs WASM), dataset naming, and the manifest shape used
// to plan a video ingestion run.
//
// RUN WITH: node test/video/video-ingestion-bridge.test.js (pure logic, no DuckDB needed)

import {
  buildVideoManifest,
  validateVideoFile,
  estimateTranscriptionTime,
  buildVideoTranscriptDatasetName,
} from '../../js/video/video-ingestion-bridge.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // --- validateVideoFile ---
  {
    const small = validateVideoFile('clip.mp4', 'video/mp4', 150);
    ok(small.valid === true, 'validateVideoFile: .mp4 under 200MB is valid');
    ok(small.warning === undefined, 'validateVideoFile: .mp4 under 200MB has no warning');
    ok(small.error === undefined, 'validateVideoFile: .mp4 under 200MB has no error');

    const large = validateVideoFile('clip.mp4', 'video/mp4', 250);
    ok(large.valid === true, 'validateVideoFile: .mp4 at 250MB is still valid');
    ok(typeof large.warning === 'string' && large.warning.length > 0,
      'validateVideoFile: .mp4 at 250MB has a warning');
    ok(/frames are not processed/.test(large.warning),
      'validateVideoFile: warning mentions frames are not processed');

    const badExt = validateVideoFile('report.pdf', 'application/pdf', 10);
    ok(badExt.valid === false, 'validateVideoFile: .pdf extension is invalid');
    ok(typeof badExt.error === 'string' && badExt.error.length > 0,
      'validateVideoFile: .pdf extension produces an error message');

    const emptyMime = validateVideoFile('clip.webm', '', 50);
    ok(emptyMime.valid === true, 'validateVideoFile: empty mimeType string is accepted');

    const tooBig = validateVideoFile('clip.mov', 'video/quicktime', 600);
    ok(tooBig.valid === false, 'validateVideoFile: file >= 500MB is invalid');

    const wrongMime = validateVideoFile('clip.mp4', 'application/octet-stream', 50);
    ok(wrongMime.valid === false, 'validateVideoFile: non-video mimeType (non-empty) is invalid');
  }

  // --- estimateTranscriptionTime ---
  {
    const withGpu = estimateTranscriptionTime(300, true);
    ok(Math.abs(withGpu.estimatedSeconds - 30) < 0.001,
      `estimateTranscriptionTime: 300s + WebGPU ~30s (got ${withGpu.estimatedSeconds})`);
    ok(/WebGPU/.test(withGpu.note), 'estimateTranscriptionTime: note mentions WebGPU when accelerated');

    const withoutGpu = estimateTranscriptionTime(300, false);
    ok(Math.abs(withoutGpu.estimatedSeconds - 150) < 0.001,
      `estimateTranscriptionTime: 300s without WebGPU ~150s (got ${withoutGpu.estimatedSeconds})`);
    ok(/without WebGPU/.test(withoutGpu.note),
      'estimateTranscriptionTime: note mentions lack of WebGPU acceleration');
    ok(/Chrome\/Edge/.test(withoutGpu.note),
      'estimateTranscriptionTime: note suggests upgrading to Chrome/Edge without WebGPU');
  }

  // --- buildVideoTranscriptDatasetName ---
  {
    const name = buildVideoTranscriptDatasetName('body_cam_20260719.mp4');
    ok(name.includes('(video transcript)'),
      `buildVideoTranscriptDatasetName: contains "(video transcript)" (got "${name}")`);
    ok(!name.includes('_') && !name.includes('.mp4'),
      'buildVideoTranscriptDatasetName: strips extension and underscores');

    const example = buildVideoTranscriptDatasetName('interview_2026_07.mp4');
    ok(example === 'interview 2026 07 (video transcript)',
      `buildVideoTranscriptDatasetName: exact expected output (got "${example}")`);

    const hyphenated = buildVideoTranscriptDatasetName('security-footage-lobby.webm');
    ok(hyphenated === 'security footage lobby (video transcript)',
      `buildVideoTranscriptDatasetName: hyphens replaced with spaces (got "${hyphenated}")`);
  }

  // --- buildVideoManifest ---
  {
    const manifest = buildVideoManifest('interview_2026_07.mp4', 120, 600);
    ok(Array.isArray(manifest.processingSteps) && manifest.processingSteps.length === 6,
      `buildVideoManifest: processingSteps has 6 items (got ${manifest.processingSteps && manifest.processingSteps.length})`);
    ok(manifest.extractionMode === 'audio_only',
      `buildVideoManifest: extractionMode is 'audio_only' (got ${manifest.extractionMode})`);
    ok(manifest.frameExtractionStatus === 'not_implemented',
      'buildVideoManifest: frameExtractionStatus is not_implemented');
    ok(manifest.estimatedTranscriptionMinutes === Math.ceil((600 / 60) * 0.3),
      `buildVideoManifest: estimatedTranscriptionMinutes derived from durationHint (got ${manifest.estimatedTranscriptionMinutes})`);

    const noDuration = buildVideoManifest('unknown.mov', 80, null);
    ok(noDuration.estimatedTranscriptionMinutes === null,
      'buildVideoManifest: estimatedTranscriptionMinutes is null when durationHint is null');
    ok(noDuration.fileName === 'unknown.mov' && noDuration.fileSizeMb === 80,
      'buildVideoManifest: echoes fileName and fileSizeMb unchanged');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
