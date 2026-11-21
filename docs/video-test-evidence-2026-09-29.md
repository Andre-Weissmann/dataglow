# Video extraction and transcript review: test record

Date: September 29, 2026, America/Chicago. Branch: `feat/video-transcription-review`.
Video defaults off. This record is not a production-release or ASR-accuracy certification.

## Passed locally

| Command | Result | Scope |
|---|---|---|
| `npm run test:videobrowser` | 19 checks | Real Chromium demux, WebCodecs decode, review UI and DuckDB; deterministic model double for UI/SQL |
| `npm run test:mediareview` | 20 tests | Consent, flags, revisions, replay, discard, PCM and bridge validation |
| `npm run test:audioreadinessgate` | 16 tests | Strict human approval plus structural validity |
| `npm run test:audiotranscription` | 5 tests | Flag/wiring/source-boundary checks, not ASR |
| `npm run test:audiostructurer` | 36 assertions | Transcript row structure and summaries |
| `npm run test:cleaningcrew` | 46 assertions | Existing PDF profiler and gate regressions |
| `npm run test:glowcanvas` | 96 + 6 + 11 assertions | Existing Canvas model and PDF bridge regressions |
| `npm run test:sql` | 14 assertions | Existing SQL cleaning/validation logic |
| `npm run test:capdrift` | 24 assertions | Capability registry drift |
| `npm run check:capability-map` | Pass | Flag-linked registry consistency |
| `npm run check:canvas-integrity` | Pass | Existing separately inlined canvas is untouched and valid |

These are heterogeneous assertions/checks, not a claim of hundreds of independent
end-to-end scenarios.

## Actual browser evidence

- MP4/AAC and MOV/AAC: 32,085 mono samples at 16kHz; RMS 0.10595.
- WebM/Opus: 32,216 mono samples at 16kHz; RMS 0.10567.
- Fixtures put signal only in the right stereo channel, so this detects a left-channel-only bug.
- No external request occurred during real extraction checks.
- Missing audio, corrupt file, absent consent, pre-cancellation, size over 200 MiB,
  unsupported ADPCM codec and 601-second timeline were rejected.
- A two-track MP4 disclosed two tracks and selected only the primary track.
- Actual root-tab UI never created a dataset before confirmation.
- Text edits invalidated prior checkbox approval; discard and cancellation imported nothing.
- Confirmed deterministic segments became real DuckDB rows with review metadata.
- A separate all-numeric text column preserved `00123` and `00456`, while ordinary
  numeric inference still produced 123 and 456.
- UI layouts had no horizontal overflow at 1440, 768, 375 and 320 pixels.
- Missing WebGPU showed an unavailable state rather than a dead upload button.

## Failed to establish

The optional real Whisper run used the shared production module and a synthetic
speech MP4. Generic model files downloaded and the pipeline initialized, then
inference did not complete within the 180-second observation limit on software
WebGPU. The result was `Real Whisper proof timed out after 180s`.

No successful ASR result or word-error rate is claimed. This is a hardware-backed
follow-up before recommending enablement, not a reason to replace the test output
with a mock and claim success.

Native Tauri, Safari, physical Android/iOS, long noisy speech, clinical recordings,
and model-cache/offline behavior were not tested. No new production deployment was
performed. The separate canvas UI does not mount these root modules.

## Reproduce

Run `npm ci`, `npx playwright install --with-deps chromium`, then the commands above.
Committed fixtures need no FFmpeg at test time. To regenerate them, use
`bash test/video/generate-fixtures.sh` with FFmpeg supporting `flite`.

For the separate model attempt, run
`MEDIA_REAL_WHISPER=1 MEDIA_QA_OUTPUT=/tmp/dataglow-media-qa npm run test:videobrowser`.
Its JSON and screenshots are written to the selected directory. The ordinary suite
never treats deterministic test segments as a real speech-model result.
