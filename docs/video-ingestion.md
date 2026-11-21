# Video audio transcripts

The implemented path is in the root ES-module app's Cleaning Crew tab, behind default-off `videoTranscription`. It also requires `cleaningCrew` and `audioTranscription`; this is not a claim of delivery in the separate `canvas/index.html` UI.

## What happens

- **Opt in:** choose a local MP4, MOV or WebM after agreeing to on-device transcription and generic model/runtime downloads. Dropping a file elsewhere never starts this.
- **Extract:** the locally bundled Mediabunny 1.61.0 demuxer reads the file and a browser WebCodecs AudioDecoder decodes the primary audio track. Other audio tracks are counted and disclosed, not silently merged. No video frames are decoded.
- **Transcribe:** the shared audio-file Whisper path receives bounded, 16kHz mono PCM with timeline offsets retained. The file and transcript are not uploaded; first use needs downloads of generic model/runtime files.
- **Review:** editable timestamped text stays outside DuckDB and the app dataset registry. A local reviewer name plus an explicit approval of the exact revision is required. Editing resets approval; cancel/discard imports nothing.
- **Import:** a single-use confirmation creates ordinary queryable segment rows and records review metadata in provenance. The transcript's `text` column stays text, even for strings such as `00123`.

The use of audio sinks and local BlobSource follows the [Mediabunny quick start](https://mediabunny.dev/guide/quick-start). Decoder availability is browser-dependent, as documented in [supported formats and codecs](https://mediabunny.dev/guide/supported-formats-and-codecs).

## Boundaries

- Maximum input: 200 MiB; maximum audio timeline: 10 minutes. These are enforced guardrails, not performance promises.
- Supported containers do not imply every codec works. Missing audio, unsupported codec, invalid file, unavailable WebCodecs or unavailable WebGPU stops with an error. There is no cloud fallback.
- Speech recognition is assistive. Text presence, successful decoding and human approval do not certify word accuracy. Silence/noise may still lead Whisper to invent words.
- No scene understanding, frame OCR, speaker diarization, clinical interpretation or automatic summaries.
- Cancellation during decoding disposes the input. A running Whisper inference/model download may finish before stopping, but a cancelled result cannot be imported.
- No immediate replay player in this panel: review against the original recording in your media player.
- Native Tauri, Safari and physical mobile devices require independent runtime proof. A compile pass or narrow Chromium viewport is not equivalent.
- Pending drafts are session-local and discarded on rerender/reload. Review metadata is not a cryptographic identity or an arbitrary-JavaScript security boundary.

## Modules and tests

`js/video/video-audio-extractor.js` is the real extractor. `js/video/video-ingestion-bridge.js` contains validation/naming helpers; the old `webcodecs-audio-extractor.scaffold.js` is historical reference, not imported.

Shared processing lives in `js/audio/audio-pcm.js`, `js/audio/whisper-file-transcriber.js`, `js/audio/transcript-review.js`, `js/audio/audio-readiness-gate.js` and `js/audio/media-transcription-station.js`. The root loaders enforce flags at prepare and confirm.

Run `npm run test:mediareview`, `npm run test:audioreadinessgate` and `npm run test:videobrowser`. Fixtures in `test/video/fixtures` are synthetic; regenerate using `bash test/video/generate-fixtures.sh` with FFmpeg. Browser tests use real container decoding and DuckDB, but a clearly separated deterministic model double for review/SQL tests. Optional `MEDIA_REAL_WHISPER=1` attempts real WebGPU inference and writes separate evidence; it is not part of ordinary CI.

### September 29, 2026 runtime evidence

Actual MP4/AAC, MOV/AAC and WebM/Opus decoding passed in Chromium, preserving signal from a right-only stereo fixture. No external requests occurred during those extraction checks. Negative paths covered missing audio, corrupt input, absent consent, cancellation, oversized files, unsupported codec and a 601-second audio timeline. Multiple tracks were disclosed.

The actual root-tab review UI and DuckDB import were tested with deterministic substituted Whisper output. This proves the review/import boundary, not speech recognition. Desktop (1440px), tablet (768px), mobile (375px) and narrow (320px) layouts had no horizontal overflow; this is not physical-device parity.

Real Whisper downloaded and initialized using sandbox Chromium's software WebGPU adapter, but did not complete within 180 seconds. End-to-end ASR and word accuracy remain unproven in this run. Hardware-backed runtime verification is a follow-up before recommending enablement.
