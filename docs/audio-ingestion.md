# Audio Ingestion

Drop an MP3, WAV, M4A, or FLAC file onto DATAGLOW's Universal Drop Zone and get
back a **queryable transcript** — one row per spoken segment, ready for SQL —
without ever leaving the browser.

## 1. What audio ingestion does

Audio ingestion turns a recording into a structured, DuckDB-backed table:

- **Drop** an MP3/WAV/M4A/FLAC file the same way you'd drop a CSV or Excel
  file onto DATAGLOW.
- **Transcribe in-browser**, via [transformers.js](https://huggingface.co/docs/transformers.js)
  (Hugging Face) running Whisper inside a Web Worker.
- **Zero upload.** The audio never leaves your machine — there is no server
  in this path, no API key, no third-party transcription vendor. This matches
  DATAGLOW's standing no-persistence, no-upload posture used for every other
  ingest path (see [`docs/databricks-connect.md`](databricks-connect.md) for
  the same trust model applied to a different connector).
- **Structured, not a wall of text.** The output is not one big transcript
  string — it's a grid: one row per spoken segment, with derived columns like
  duration and words-per-minute, so it drops straight into the same DuckDB
  grid every other dataset uses.

## 2. The technical pipeline

```
File drop
  → UI reads ArrayBuffer (file.arrayBuffer())
  → AudioContext.decodeAudioData() → Float32Array + sampleRate
  → postMessage to Web Worker
  → Worker resamples to 16kHz mono (required by Whisper)
  → transformers.js Whisper pipeline transcribes (WebGPU or WASM)
  → Worker postMessage's back { type: 'segments', data: [...] }
  → js/audio/audio-structurer.js: structureTranscription()
  → structured dataset { columns, rows, meta }
  → DuckDB-WASM grid (same loadRowsAsDataset() path as CSV/Excel/SQLite)
```

Two new modules implement the pieces that are new in this PR:

- [`js/audio/whisper-worker.scaffold.js`](../js/audio/whisper-worker.scaffold.js) —
  documents (and, once transformers.js is wired in, will run) the Worker side
  of the pipeline: resampling, pipeline initialization, and the three
  `postMessage` shapes (`segments`, `progress`, `error`).
- [`js/audio/audio-structurer.js`](../js/audio/audio-structurer.js) — pure,
  browser-free logic that takes the Worker's raw Whisper segments and turns
  them into a DATAGLOW dataset. It has no DOM or network dependency, so it is
  unit tested directly in Node (see
  [`test/audio/audio-structurer.test.js`](../test/audio/audio-structurer.test.js)).

The Worker boundary matters: transcription is CPU/GPU-intensive, and running
it on the main thread would freeze the UI for the entire file. Keeping it in a
Worker means the drop zone, the rest of the grid, and any other open tab stay
responsive while a multi-minute recording transcribes in the background.

## 3. Whisper model choices

transformers.js runs Whisper directly via the `automatic-speech-recognition`
pipeline. Two model choices are recommended for the initial ingestion path:

| Model | Params | Approx. download | Best for |
|---|---|---|---|
| `openai/whisper-tiny.en` | 39M | ~40MB | Speed — fast first-pass transcripts, lower-end hardware |
| `openai/whisper-base.en` | 74M | ~150MB | Accuracy — cleaner text, better on accents/noisy audio |

Both are **English-primary** `.en` variants — smaller and faster than the
multilingual Whisper checkpoints, which trade that speed for broader language
coverage (see [Known limitations](#6-known-limitations)).

Models are downloaded once and **cached by the browser** (Cache Storage /
IndexedDB, depending on the transformers.js backend), so only the first
transcription in a session pays the download cost.

**WebGPU acceleration**: transformers.js automatically requests a WebGPU
device when available (Chrome 113+, Edge, and Safari as of the 2026 release
cycle) and transparently falls back to a WASM backend on browsers without
WebGPU support. WebGPU transcription runs roughly **5–10x faster** than the
WASM fallback, which is the difference between a multi-minute recording
transcribing in seconds versus tens of seconds.

## 4. The structured output schema

`structureTranscription()` in `js/audio/audio-structurer.js` turns the raw
Whisper segment array (`[{ timestamp: [start, end], text }]`) into a dataset
with one row per segment:

| Column | Type | Description |
|---|---|---|
| `segment_id` | INTEGER | 1-based row number |
| `start_sec` | DOUBLE | Segment start time, in seconds |
| `end_sec` | DOUBLE | Segment end time, in seconds |
| `duration_sec` | DOUBLE | `end_sec - start_sec` |
| `text` | VARCHAR | Trimmed transcribed text for the segment |
| `char_count` | INTEGER | Character length of `text` |
| `word_count` | INTEGER | Whitespace-delimited word count |
| `words_per_minute` | DOUBLE | Estimated pace: `(word_count / duration_sec) * 60`, rounded to 1 decimal. `null` when `duration_sec` is 0. |

An optional `speaker` column (VARCHAR) can be requested via
`options.speakerColumn`. **Speaker diarization is a future enhancement** —
this PR scaffolds the column shape with a `'SPEAKER_00'` placeholder on every
row so downstream UI and SQL can be built against the eventual schema without
waiting on an actual diarization model.

The dataset also carries a `meta` block (`totalSegments`, `totalDurationSec`,
`totalWords`, `avgWordsPerMinute`, `transcribedAt`) and a companion
`buildAudioDatasetSummary()` helper that produces a one-line headline (e.g.
*"47 segments · 8m 32s · ~142 words/min"*), a "top insight" (the longest
segment), and three example DuckDB queries to jump-start analysis.

## 5. Example use cases

- **EMS call recordings** — turn a dispatch recording into a searchable,
  timestamped log for QA or training review.
- **Insurance interviews** — structure a recorded claims interview so an
  adjuster can query for specific statements instead of re-listening.
- **Meeting transcripts** — pair with DATAGLOW's existing meeting-scribe
  tooling (see [`js/agents/meeting-scribe-agent.js`](../js/agents/meeting-scribe-agent.js))
  to tag transcript segments against the chart/query that was on screen when
  they were said.
- **Qualitative research recordings** — turn interview audio into a table a
  researcher can filter, aggregate, and cross-reference alongside other study
  data — all inside the same local DuckDB session.

## 6. Known limitations

- **4GB WASM memory cap.** Browsers without WebGPU fall back to a WASM
  runtime, which is subject to WebAssembly's ~4GB linear memory ceiling. Very
  long recordings (multi-hour) should be chunked before transcription on
  WASM-only browsers.
- **Whisper hallucination risk.** Like all Whisper variants, the model can
  fabricate plausible-sounding text on silent, very noisy, or otherwise
  low-quality audio segments. Treat transcript text as a strong first draft,
  not a verified ground truth, especially for compliance-sensitive use cases
  (EMS, insurance).
- **English-primary.** The recommended `.en` model variants are
  English-only. Multilingual Whisper checkpoints exist but are larger and
  slower to download; they are not the default in this PR.
- **No diarization yet.** As noted above, the `speaker` column is a
  placeholder (`'SPEAKER_00'` for every row) — actual speaker separation is
  scaffolded but not implemented.

## 7. Querying the transcript in DataGlow SQL mode

Once a transcript is structured and loaded, it behaves like any other DATAGLOW
table (default table name mirrors the dataset, e.g. `transcript`). Example
queries:

```sql
-- Find the longest / most substantive segments
SELECT segment_id, text
FROM transcript
WHERE word_count > 50
ORDER BY word_count DESC;

-- Get the overall speaking pace
SELECT AVG(words_per_minute) AS avg_pace
FROM transcript;

-- Search for specific keywords across the whole recording
SELECT *
FROM transcript
WHERE text ILIKE '%error%' OR text ILIKE '%problem%';

-- Find long pauses between segments (potential silence / dead air)
SELECT segment_id,
       start_sec - LAG(end_sec) OVER (ORDER BY segment_id) AS gap_sec
FROM transcript
QUALIFY gap_sec > 5
ORDER BY gap_sec DESC;
```

These same three example queries (minus the pause-detection one) are also
returned programmatically by `buildAudioDatasetSummary()`, so the UI can
surface "try this query" suggestions immediately after a transcript finishes
structuring.
