# DATAGLOW Video Ingestion

Video ingestion extends the Universal Drop Zone to accept video files, so a
spoken-word video becomes the same kind of structured, queryable dataset that
audio ingestion already produces — without the file ever leaving the browser.

## 1. What video ingestion does

Drop an `.mp4`, `.mov`, or `.webm` file onto DataGlow's drop zone:

1. The audio track is extracted **in the browser** — no upload, no server.
2. The extracted audio is transcribed by the same Whisper pipeline used for
   plain audio files (`js/audio/whisper-worker.scaffold.js`, from PR M).
3. The transcript is structured through the existing audio structurer and
   loaded into DuckDB as a queryable table — a dataset you can filter, join,
   and analyze exactly like any other DataGlow dataset.

The output is intentionally identical in shape to audio ingestion's output.
Video ingestion is a **bridge** into the existing pipeline, not a parallel one.

## 2. The two-step architecture

**Step 1 — Audio extraction (browser-side, this PR's scaffold)**

Two patterns, both documented in
[`js/video/webcodecs-audio-extractor.scaffold.js`](../js/video/webcodecs-audio-extractor.scaffold.js):

- **Pattern A — `AudioContext.decodeAudioData`.** Reads the whole file into
  memory and lets the browser's native media decoder pull the audio track out
  of the MP4/MOV/WebM container. Simple, widely supported, covers 95%+ of
  cases. This is the recommended default.
- **Pattern B — WebCodecs `AudioDecoder`/`VideoDecoder`.** Lower-level, more
  control, needed for edge cases Pattern A can't decode (very large files,
  unusual codecs). Scaffolded but not implemented — requires a demuxer
  (e.g. MP4Box.js) to pull encoded chunks out of the container first.

**Step 2 — Whisper Web Worker (already exists, from PR M)**

The extracted `Float32Array` audio + sample rate is handed off exactly the way
a plain audio file would be:

```js
worker.postMessage({ type: 'transcribe', audioData: mono, sampleRate: audioBuffer.sampleRate });
```

From here, video ingestion is indistinguishable from audio ingestion: the same
transcription, structuring, and DuckDB load steps run unchanged.

## 3. WebCodecs browser support matrix

| Browser | Support |
| --- | --- |
| Chrome 94+ | ✓ Full |
| Edge 94+ | ✓ Full |
| Safari (2026) | ✓ Full (Technology Preview → Stable) |
| Firefox | Partial — `AudioDecoder` available, `VideoDecoder` in progress |

Pattern A (`AudioContext.decodeAudioData`) does not require `AudioDecoder` /
`VideoDecoder` directly, so it works even on browsers with partial WebCodecs
support — this is why it's the recommended default pattern.

## 4. Current limitations

- **Audio track only.** No frame captioning yet — `frameExtractionStatus` is
  reported as `not_implemented` in the manifest, honestly, rather than
  implying a capability that doesn't exist.
- **No vision analysis.** Frame extraction is scaffolded
  (`frameExtractionScaffold()`) but not implemented.
- **File size.** Under 500MB required; over 200MB triggers a warning that
  transcription may take several minutes.
- **No wiring into the Drop Zone UI yet.** This PR establishes the pure-logic
  bridge and the extraction pattern; UI integration is a follow-up batch.

## 5. Future: frame extraction + local vision captioning

Once local vision models (LLaVA, Moondream, or similar, running via WebGPU)
mature enough for in-browser use, DataGlow will extract a `VideoFrame` every
3-4 seconds, caption it with the local vision model, and cross-index those
captions with the transcript by timestamp:

```
{ timestamp_sec, caption, objects: [...] }
```

Merged with the transcript by timestamp, this becomes a single, fully
queryable video dataset — "what was said" and "what was shown" indexed
together in DuckDB. `extractionMode` will move from `'audio_only'` to
`'audio_and_frames'` once this lands.

## 6. Example use cases

- **Body camera footage analysis** — EMS and law enforcement reviewing and
  indexing incident recordings.
- **Interview recordings** — insurance, HR, and qualitative-research
  interviews turned into searchable transcripts.
- **Training video indexing** — making internal training libraries
  queryable by spoken content.
- **Security footage annotation** — transcribing any spoken audio captured
  alongside security video, with frame captioning as a future enhancement.

---

Part of: DataGlow Canvas — Multimodal ingestion (Tier 1, Zach Wilson "Variety" dimension)
