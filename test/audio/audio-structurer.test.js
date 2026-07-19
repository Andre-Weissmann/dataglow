// ============================================================
// DATAGLOW — Audio Ingestion: Transcript Structurer test suite
// ============================================================
// Proves the audio-structurer pipeline is deterministic and safe:
//   - validateTranscriptionInput rejects empty/malformed segment arrays and
//     accepts well-formed ones,
//   - structureTranscription produces the right row count, correct
//     duration_sec derivations, correctly computed words_per_minute, and a
//     datasetName that reads as a transcript (not a raw audio file),
//   - buildAudioDatasetSummary's headline mentions segment count and
//     duration, and always returns exactly 3 suggested queries,
//   - graceful degradation: everything here is pure arithmetic/string logic
//     (no DOM, no Worker, no network), so behaviour never depends on a
//     browser or on transformers.js being loaded.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/audio/audio-structurer.test.js

import {
  validateTranscriptionInput,
  structureTranscription,
  buildAudioDatasetSummary,
} from '../../js/audio/audio-structurer.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

function main() {
  // ---------- 1. validateTranscriptionInput ----------
  const validSegments = [
    { timestamp: [0, 5], text: 'Hello there.' },
    { timestamp: [5, 10], text: 'How are you today?' },
  ];
  ok(validateTranscriptionInput(validSegments).valid === true, 'validate: well-formed segments are valid');

  const emptyResult = validateTranscriptionInput([]);
  ok(emptyResult.valid === false, 'validate: empty array is invalid');
  ok(typeof emptyResult.error === 'string' && emptyResult.error.length > 0, 'validate: empty array carries an error message');

  const missingTimestampResult = validateTranscriptionInput([{ text: 'no timestamp here' }]);
  ok(missingTimestampResult.valid === false, 'validate: segment missing a timestamp is invalid');

  const badTimestampLengthResult = validateTranscriptionInput([{ timestamp: [0], text: 'short timestamp' }]);
  ok(badTimestampLengthResult.valid === false, 'validate: timestamp of length != 2 is invalid');

  const notArrayResult = validateTranscriptionInput('not an array');
  ok(notArrayResult.valid === false, 'validate: non-array input is invalid');

  const missingTextResult = validateTranscriptionInput([{ timestamp: [0, 1] }]);
  ok(missingTextResult.valid === false, 'validate: segment missing text is invalid');

  // ---------- 2. structureTranscription ----------
  const mockSegments = [
    { timestamp: [0, 5], text: '  This is the first segment.  ' }, // 5s, 5 words, 27 chars trimmed
    { timestamp: [5, 15], text: 'This is a longer second segment with more words in it.' }, // 10s, 11 words
    { timestamp: [15, 15], text: 'Zero duration edge case.' }, // 0s duration -> null wpm
  ];

  const structured = structureTranscription(mockSegments, 'call_recording_001.mp3');

  ok(structured.rows.length === 3, 'structure: correct row count (3)');
  ok(structured.datasetName.includes('(transcript)'), 'structure: datasetName contains "(transcript)"');
  ok(structured.sourceFile === 'call_recording_001.mp3', 'structure: sourceFile matches input filename');
  ok(structured.format === 'audio_transcript', 'structure: format is "audio_transcript"');

  const columnNames = structured.columns.map(c => c.name);
  ok(columnNames.includes('segment_id') && columnNames.includes('start_sec') &&
     columnNames.includes('end_sec') && columnNames.includes('duration_sec') &&
     columnNames.includes('text') && columnNames.includes('char_count') &&
     columnNames.includes('word_count') && columnNames.includes('words_per_minute'),
     'structure: all required columns are present');
  ok(!columnNames.includes('speaker'), 'structure: speaker column absent by default (speakerColumn: false)');

  const row1 = structured.rows[0];
  ok(row1.segment_id === 1, 'structure: first row has segment_id 1 (1-based)');
  ok(row1.duration_sec === 5, 'structure: row 1 duration_sec === end - start (5)');
  ok(row1.text === 'This is the first segment.', 'structure: row 1 text is trimmed');
  ok(row1.word_count === 5, 'structure: row 1 word_count is correct (5 words)');
  // words_per_minute = (word_count / duration_sec) * 60 = (5 / 5) * 60 = 60.0
  ok(row1.words_per_minute === 60, 'structure: row 1 words_per_minute computed correctly (60.0)');

  const row2 = structured.rows[1];
  ok(row2.duration_sec === 10, 'structure: row 2 duration_sec is correct (10)');
  ok(row2.word_count === 11, 'structure: row 2 word_count is correct (11 words)');
  // (11 / 10) * 60 = 66.0
  ok(row2.words_per_minute === 66, 'structure: row 2 words_per_minute computed correctly (66.0)');

  const row3 = structured.rows[2];
  ok(row3.duration_sec === 0, 'structure: row 3 has zero duration');
  ok(row3.words_per_minute === null, 'structure: row 3 words_per_minute is null when duration_sec === 0');

  ok(structured.meta.totalSegments === 3, 'structure: meta.totalSegments is correct');
  ok(structured.meta.totalDurationSec === 15, 'structure: meta.totalDurationSec sums durations (15)');
  ok(structured.meta.totalWords === 5 + 11 + 4, 'structure: meta.totalWords sums word counts');
  ok(typeof structured.meta.transcribedAt === 'string' && !Number.isNaN(Date.parse(structured.meta.transcribedAt)),
     'structure: meta.transcribedAt is a valid ISO timestamp');

  // speakerColumn option
  const withSpeaker = structureTranscription(mockSegments, 'interview.wav', { speakerColumn: true });
  const speakerColumnNames = withSpeaker.columns.map(c => c.name);
  ok(speakerColumnNames.includes('speaker'), 'structure: speakerColumn option adds a speaker column');
  ok(withSpeaker.rows.every(r => r.speaker === 'SPEAKER_00'), 'structure: every row gets the SPEAKER_00 placeholder');

  // structureTranscription should throw on invalid input rather than silently
  // producing a broken dataset.
  let threw = false;
  try {
    structureTranscription([], 'empty.mp3');
  } catch (err) {
    threw = true;
  }
  ok(threw === true, 'structure: throws on invalid/empty input rather than returning a broken dataset');

  // ---------- 3. buildAudioDatasetSummary ----------
  const summary = buildAudioDatasetSummary(structured);
  ok(summary.headline.includes('3'), 'summary: headline mentions the segment count (3)');
  ok(/\d+m \d+s/.test(summary.headline), 'summary: headline includes a duration in "Xm Ys" form');
  ok(typeof summary.topInsight === 'string' && summary.topInsight.length > 0, 'summary: topInsight is a non-empty string');
  ok(summary.topInsight.includes('segment 2'), 'summary: topInsight identifies the longest segment (segment 2, 10s)');
  ok(Array.isArray(summary.suggestedQueries) && summary.suggestedQueries.length === 3,
     'summary: suggestedQueries has exactly 3 items');
  ok(summary.suggestedQueries.every(q => typeof q === 'string' && q.toUpperCase().includes('SELECT')),
     'summary: every suggested query is a SELECT statement');

  // ---------- Summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
