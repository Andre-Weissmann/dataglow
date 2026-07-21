# Capability detail — Universal ingestion & RAG (wave 2)

Companion to the **Universal ingestion & RAG (wave 2)** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

The multimodal drop zone: DataGlow's path toward accepting any file type and
turning it into a queryable, validatable dataset. Backing modules:
`js/drop-zone/drop-zone-router.js`, `js/rag/rag-core.js`,
`js/rag/rag-validation-bridge.js`, `js/rag/user-knowledge-store.js`,
`js/audio/audio-structurer.js`, `js/audio/whisper-worker.scaffold.js`.

## Drop zone router (`drop-zone-router.js`)

Routes each dropped file to the correct ingestion pipeline based on MIME type and
extension:

| Format | Pipeline |
|---|---|
| CSV, XLSX, JSON, Parquet | Direct DuckDB-WASM load |
| PDF | PDF.js text extraction → RAG chunking |
| MP3, WAV, M4A | Whisper in-browser transcription → structured columns |
| MP4 | WebCodecs audio extraction → Whisper → structured transcript |
| Multi-file drop | Schema-match detection → join suggestion |

## RAG core (`rag-core.js`)

- Chunks PDF text into overlapping segments, embeds them locally (no external
  embedding API), and stores vectors in the user knowledge store.
- `rag-validation-bridge.js` runs validation rules against RAG-retrieved content
  so extracted claims from PDFs go through the same trust pipeline as SQL results.
- `user-knowledge-store.js` is the local vector index — OPFS-persisted, never
  uploaded.

## Audio ingestion (`audio-structurer.js`, `whisper-worker.scaffold.js`)

- Whisper runs in a Web Worker via ONNX Runtime Web — fully in-browser, zero
  server.
- Transcribed audio is structured into columns: `timestamp`, `speaker_id` (if
  diarisation is available), `text`, `confidence`.
- The resulting dataset loads into DuckDB-WASM as a first-class table for SQL
  queries and validation.

## Privacy guarantee

All ingestion — PDF parsing, Whisper transcription, RAG embedding — runs locally.
No file content leaves the browser. The zero-upload CI source-guard pattern verifies
this in CI on every push.

## Roadmap

- MP4 frame captioning via WebCodecs + vision model
- Vector RAG embeddings with a local ONNX embedding model
- Structured audio diarisation (speaker separation)
