# Audio file transcripts

The root Cleaning Crew app accepts an explicitly opted-in MP3, WAV, M4A or FLAC through `audioTranscription`. Audio decoding and Whisper inference run on the device; generic runtime/model files download on first use. WebGPU is required. A filename extension does not guarantee the browser can decode its codec.

## Review before import

Audio and video share the same transcript review. Pending text is not added to DuckDB or the dataset registry. A person sees every timestamped segment, can correct the words, enters a local reviewer name, and approves the exact revision before import. Any edit invalidates approval. Discard/cancel produces no dataset.

This corrects the original audio implementation in [PR #705](https://github.com/Andre-Weissmann/dataglow/pull/705), which computed a passing structural gate for nonempty text and imported it immediately despite UI copy promising human confirmation. Structural checks alone were not an enforcement mechanism.

## Limits

Up to 200 MiB and 10 minutes of audio per file. Both stereo channels are averaged; audio is resampled to 16kHz including inputs below that rate. No automatic transcription on general drag/drop, no microphone access, no diarization and no guarantee of word accuracy. No cloud fallback. Check important words, identifiers and numbers against the original recording.

Desktop-first means a capable desktop browser is the initial target, not that every Tauri webview or phone has been functionally verified. See [video-ingestion.md](video-ingestion.md) for the shared processing, cancellation and test boundaries.
