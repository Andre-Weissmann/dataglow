# Video audio extraction implementation plan

Build approved September 29, 2026. No merge or enable approval implied.

- [x] Inspect existing scaffold, shared Whisper path, flags, open/recent PRs.
- [x] Identify prerequisite: audio gate did not require confirmation and inserted unreviewed text.
- [x] Implement real local demuxing plus WebCodecs audio extraction.
- [x] Share bounded 16kHz Whisper input and review-before-import for audio/video.
- [x] Prove malformed/unsupported/no-audio/cancel paths, review/replay/edit gates.
- [x] Exercise actual MP4/MOV/WebM files in Chromium; separate decoder proof from ASR proof.
- [x] Inspect desktop, tablet and mobile layouts; no claims of native/mobile runtime parity.
- [x] Update capability map, flags, test evidence, roadmap and dependency license record.
- [ ] Open PR with `videoTranscription: false`, complete CI, request merge approval.
- [ ] Only after a separate explicit decision: enable the exact video flag in its own PR.

Scope: Cleaning Crew in the root ES-module app and staged Tauri assets, not the separate canvas bundle. Preserve PDF and other ingestion paths. No video vision, speaker diarization, automatic import, uploads, or live/API feed refresh in this batch.

Real Whisper runtime follow-up: model downloaded and initialized, but the software-WebGPU sandbox did not complete transcription within 180 seconds. Decoder/review/SQL proof is separate from that unsuccessful ASR attempt. Do not enable by inference from deterministic test output.
