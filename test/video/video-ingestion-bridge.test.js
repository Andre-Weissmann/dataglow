import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVideoFile, buildVideoManifest, estimateTranscriptionTime, buildVideoTranscriptDatasetName } from '../../js/video/video-ingestion-bridge.js';
test('MP4/MOV/WebM are candidates only within the configured byte budget', () => {
  for (const ext of ['mp4', 'mov', 'webm', 'MP4']) assert.equal(validateVideoFile(`clip.${ext}`, '', 10).valid, true);
  for (const n of [0, -1, NaN, Infinity, 201]) assert.equal(validateVideoFile('clip.mp4', '', n).valid, false);
  assert.equal(validateVideoFile('clip.mp4', '', 200).valid, true);
  assert.equal(validateVideoFile('clip.csv', '', 2).valid, false);
  assert.equal(validateVideoFile('clip.mp4', 'audio/mp3', 2).valid, false);
});
test('manifest includes human review, does not imply frame processing or a speed guarantee', () => {
  const m = buildVideoManifest('clip.mp4', 2, 12);
  assert.equal(m.frameExtractionStatus, 'not_implemented');
  assert.equal(m.estimatedTranscriptionMinutes, null);
  assert.ok(m.processingSteps.includes('human_review_and_confirm'));
  assert.equal(estimateTranscriptionTime(300, true).estimatedSeconds, null);
});
test('video transcript names stay distinct from raw video', () => {
  assert.equal(buildVideoTranscriptDatasetName('interview_2026_07.mp4'), 'interview 2026 07 (video transcript)');
});
