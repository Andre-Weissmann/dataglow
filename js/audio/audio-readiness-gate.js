// Structural checks are NOT speech-recognition accuracy or human approval.
// Pending transcripts live outside DuckDB; transcript-review.js owns release.
import { computeReadinessGate, explainGateReasons } from '../gate/readiness-gate.js';
import { validateTranscriptionInput } from './audio-structurer.js';

export function buildAudioGateLayers(segments, { humanConfirmed = false } = {}) {
  const validation = validateTranscriptionInput(segments);
  const hasText = validation.valid && segments.some(s => s.text.trim());
  return [
    {
      layer: 'Transcript structure',
      status: hasText ? 'pass' : 'fail',
      summary: hasText
        ? 'Timestamped text is present. This does not prove the words are correct.'
        : 'No usable timestamped text. Retry with a clear spoken recording.',
    },
    {
      layer: 'Human transcript review',
      status: humanConfirmed === true ? 'pass' : 'fail',
      summary: humanConfirmed === true
        ? 'A person confirmed this transcript revision. Assistive, verify.'
        : 'Human review required. Not imported and not available to dataset agents.',
    },
  ];
}

export function evaluateAudioReadiness(segments, options = {}) {
  const layers = buildAudioGateLayers(segments, options);
  const gate = computeReadinessGate(layers, null);
  return { gate, explanation: explainGateReasons(gate).replaceAll('\u2014', ':'), layers };
}
