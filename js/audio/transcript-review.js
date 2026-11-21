// Session-local quarantine: no engine, global registry, storage or network.
// Preview returns copies. Approval is revision-bound and single-use.
import { structureTranscription } from './audio-structurer.js';
import { evaluateAudioReadiness } from './audio-readiness-gate.js';

export function createTranscriptReview(segments, name, metadata = {}) {
  let data = segments.map(s => ({ timestamp: [...s.timestamp], text: s.text }));
  structureTranscription(data, name); // reject malformed model output
  let revision = 0;
  let phase = 'pending';
  const meta = JSON.parse(JSON.stringify(metadata));
  function pending() {
    if (phase !== 'pending') throw new Error('This transcript review is no longer pending.');
  }
  return Object.freeze({
    preview() {
      pending();
      return {
        revision, name, metadata: JSON.parse(JSON.stringify(meta)),
        structured: structureTranscription(data, name),
        readiness: evaluateAudioReadiness(data),
      };
    },
    edit(index, text) {
      pending();
      if (!Number.isInteger(index) || !data[index] || typeof text !== 'string') {
        throw new Error('Invalid transcript edit.');
      }
      data[index].text = text;
      revision++;
      return revision;
    },
    discard() {
      pending();
      phase = 'discarded';
      data = [];
    },
    async confirmAndImport(confirmation, importer) {
      pending();
      if (confirmation?.confirmed !== true || confirmation.revision !== revision
        || typeof confirmation.reviewer !== 'string' || !confirmation.reviewer.trim()) {
        throw new Error('Review this exact transcript revision and enter a local reviewer name.');
      }
      const readiness = evaluateAudioReadiness(data, { humanConfirmed: true });
      if (!readiness.gate.agentConsumable) throw new Error('No usable transcript to import.');
      if (typeof importer !== 'function') throw new Error('No dataset importer available.');
      const structured = structureTranscription(data, name);
      phase = 'consumed'; // lock BEFORE await: double-click/replay cannot duplicate a load
      data = [];
      return importer({
        name,
        columns: structured.columns.map(c => c.name),
        rows: structured.rows,
        source: meta.source || 'audio-transcript',
        meta: {
          ...meta, assistive: true, humanConfirmed: true, revision,
          reviewer: confirmation.reviewer.trim(), reviewedAt: new Date().toISOString(),
        },
      });
    },
  });
}
