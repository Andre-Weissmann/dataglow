// ============================================================
// DATAGLOW — Audio Ingestion: Transcript Structurer
// ============================================================
// Pure JavaScript, browser-free, network-free. This module owns exactly one
// job: take the raw segment array that transformers.js' Whisper pipeline
// produces and turn it into a DATAGLOW-shaped dataset — the same
// `{ columns, rows }` grid shape every other ingest path (CSV, Excel,
// Databricks, SQLite, …) hands to the DuckDB loader. It does not decode
// audio, does not talk to a Worker, and does not import anything browser- or
// network-specific — that keeps it trivially unit-testable in plain Node
// (see test/audio/audio-structurer.test.js) and safe to reuse from either the
// main thread or a Worker.
//
// THE FULL PIPELINE (this file is step 6 of 7):
//
//   1. File drop  — the user drags an MP3/WAV/M4A/FLAC onto DATAGLOW's
//      Universal Drop Zone.
//   2. UI reads ArrayBuffer  — the main thread reads the file with
//      `file.arrayBuffer()` and decodes it via `AudioContext.decodeAudioData`
//      into a Float32Array + sampleRate.
//   3. Web Worker  — the raw PCM data is postMessage'd to a Worker (see
//      js/audio/whisper-worker.scaffold.js) so transcription never blocks the
//      UI thread.
//   4. transformers.js Whisper loads  — inside the Worker, the Worker lazily
//      loads the `automatic-speech-recognition` pipeline (openai/whisper-tiny.en
//      or whisper-base.en), using WebGPU when available and falling back to
//      WASM otherwise.
//   5. Transcribes  — the Worker resamples PCM to 16kHz mono and runs Whisper
//      with `return_timestamps: true`, producing an array of
//      `{ timestamp: [startSec, endSec], text }` segments.
//   6. postMessage segments back → audio-structurer.js structures them
//      (THIS FILE) — `structureTranscription()` below turns that raw segment
//      array into a fully-typed DATAGLOW dataset: one row per segment, with
//      derived columns (duration, char/word counts, estimated pace).
//   7. Dataset drops into the DuckDB grid  — the structured `{ columns, rows }`
//      object is hands off to the same `loadRowsAsDataset()` ingest path every
//      other source (CSV, Excel, Databricks, …) uses, so the transcript is
//      immediately SQL-queryable like any other table.
//
// GRACEFUL DEGRADATION: everything here is deterministic array/string/number
// logic — no LLM, no DOM, no `fetch`. Speaker diarization is intentionally
// scaffolded (see `options.speakerColumn`) but NOT implemented in this PR —
// the placeholder value 'SPEAKER_00' is emitted for every row so downstream
// UI/SQL can be built against the eventual column shape without waiting on
// an actual diarization model.

/**
 * Validates a raw Whisper segment array before structuring.
 * @param {unknown} whisperSegments
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTranscriptionInput(whisperSegments) {
  if (!Array.isArray(whisperSegments)) {
    return { valid: false, error: 'whisperSegments must be an array' };
  }
  if (whisperSegments.length === 0) {
    return { valid: false, error: 'whisperSegments is empty — nothing to transcribe' };
  }
  for (let i = 0; i < whisperSegments.length; i++) {
    const seg = whisperSegments[i];
    if (!seg || typeof seg !== 'object') {
      return { valid: false, error: `segment ${i} is not an object` };
    }
    if (!Array.isArray(seg.timestamp) || seg.timestamp.length !== 2) {
      return { valid: false, error: `segment ${i} is missing a valid timestamp [start, end] pair` };
    }
    const [start, end] = seg.timestamp;
    if (typeof start !== 'number' || typeof end !== 'number') {
      return { valid: false, error: `segment ${i} has a non-numeric timestamp` };
    }
    if (typeof seg.text !== 'string') {
      return { valid: false, error: `segment ${i} is missing text (string)` };
    }
  }
  return { valid: true };
}

// Base columns always present. `speaker` is appended conditionally.
function buildColumns(options) {
  const columns = [
    { name: 'segment_id', type: 'INTEGER' },
    { name: 'start_sec', type: 'DOUBLE' },
    { name: 'end_sec', type: 'DOUBLE' },
    { name: 'duration_sec', type: 'DOUBLE' },
    { name: 'text', type: 'VARCHAR' },
    { name: 'char_count', type: 'INTEGER' },
    { name: 'word_count', type: 'INTEGER' },
    { name: 'words_per_minute', type: 'DOUBLE' },
  ];
  if (options.speakerColumn) {
    columns.push({ name: 'speaker', type: 'VARCHAR' });
  }
  return columns;
}

function countWords(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Structures raw Whisper segments into a DATAGLOW-compatible dataset.
 *
 * @param {Array<{ timestamp: [number, number], text: string }>} whisperSegments
 *   Raw output from the transformers.js Whisper pipeline.
 * @param {string} sourceFileName - Original audio filename (e.g. "call.mp3").
 * @param {{ includeWordCount?: boolean, includeSentiment?: boolean, speakerColumn?: boolean }} [options]
 * @returns {object} Structured dataset — see module docs for full shape.
 */
export function structureTranscription(whisperSegments, sourceFileName, options = {}) {
  const validation = validateTranscriptionInput(whisperSegments);
  if (!validation.valid) {
    throw new Error(`structureTranscription: invalid input — ${validation.error}`);
  }

  const opts = {
    includeWordCount: true,
    includeSentiment: false,
    speakerColumn: false,
    ...options,
  };

  const columns = buildColumns(opts);

  let totalDurationSec = 0;
  let totalWords = 0;
  const wpmValues = [];

  const rows = whisperSegments.map((seg, index) => {
    const [startSecRaw, endSecRaw] = seg.timestamp;
    const startSec = startSecRaw;
    const endSec = endSecRaw;
    const durationSec = endSec - startSec;
    const text = seg.text.trim();
    const charCount = text.length;
    const wordCount = countWords(text);
    const wordsPerMinute = durationSec === 0 ? null : round1((wordCount / durationSec) * 60);

    totalDurationSec += durationSec;
    totalWords += wordCount;
    if (wordsPerMinute !== null) wpmValues.push(wordsPerMinute);

    const row = {
      segment_id: index + 1,
      start_sec: startSec,
      end_sec: endSec,
      duration_sec: durationSec,
      text,
      char_count: charCount,
      word_count: wordCount,
      words_per_minute: wordsPerMinute,
    };

    if (opts.speakerColumn) {
      // Diarization is a future enhancement (scaffolded, not implemented in
      // this PR) — every row gets the same placeholder speaker for now.
      row.speaker = 'SPEAKER_00';
    }

    return row;
  });

  const avgWordsPerMinute = wpmValues.length > 0
    ? round1(wpmValues.reduce((a, b) => a + b, 0) / wpmValues.length)
    : 0;

  return {
    datasetName: `${sourceFileName} (transcript)`,
    sourceFile: sourceFileName,
    format: 'audio_transcript',
    columns,
    rows,
    meta: {
      totalSegments: rows.length,
      totalDurationSec,
      totalWords,
      avgWordsPerMinute,
      transcribedAt: new Date().toISOString(),
    },
  };
}

function formatDuration(totalSec) {
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.round(totalSec % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Builds a human-readable summary of a structured audio dataset.
 * @param {object} structuredDataset - Output of structureTranscription().
 * @returns {{ headline: string, topInsight: string, suggestedQueries: string[] }}
 */
export function buildAudioDatasetSummary(structuredDataset) {
  const { rows, meta } = structuredDataset;

  const headline = `${meta.totalSegments} segments · ${formatDuration(meta.totalDurationSec)} · ~${Math.round(meta.avgWordsPerMinute)} words/min`;

  let topInsight = 'No segments to analyze.';
  if (rows.length > 0) {
    const longest = rows.reduce((max, row) => (row.duration_sec > max.duration_sec ? row : max), rows[0]);
    topInsight = `Longest segment: segment ${longest.segment_id} (${Math.round(longest.duration_sec)} seconds)`;
  }

  const suggestedQueries = [
    'SELECT segment_id, text FROM transcript WHERE word_count > 50 ORDER BY word_count DESC',
    'SELECT AVG(words_per_minute) as avg_pace FROM transcript',
    "SELECT * FROM transcript WHERE text ILIKE '%error%' OR text ILIKE '%problem%'",
  ];

  return { headline, topInsight, suggestedQueries };
}
