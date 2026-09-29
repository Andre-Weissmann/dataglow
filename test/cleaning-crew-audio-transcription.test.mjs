// ============================================================
// DATAGLOW — Cleaning Crew audio transcription station test suite (Batch 5)
// ============================================================
// js/app-shell/tabs/cleaning-crew-tab.js renders via raw innerHTML template
// strings (not the el() helper), so this file follows the SAME source-level
// assertion convention test/cleaning-crew-glow-canvas-bridge.test.mjs already
// established for this exact file, rather than pulling in jsdom.
//
// This file proves, by reading the real shipped source:
//   - the audio station is gated behind isEnabled('audioTranscription')
//     (ships dark by default, same convention as every other flag-gated
//     feature)
//   - the station is ALSO gated on isFileTranscriptionAvailable() (WebGPU),
//     independent of the flag -- a flag-on device with no WebGPU sees the
//     honest "not available here" message, not a dead upload button
//   - the "Upload audio to transcribe" button starts DISABLED and is only
//     enabled once the opt-in checkbox is checked -- transcription can never
//     start from a bare file-picker click without the explicit consent
//     gesture
//   - the UI copy contains the literal "assistive, verify" label the user's
//     own scoping requires
//   - the result card explicitly states the transcript is not used by any
//     AI agent until a human confirms -- the human-facing half of the
//     agent-blocking requirement (the mechanical half is proven in
//     test/audio/audio-readiness-gate.test.js)
//   - loadAudioAsDataset is never called from the automatic loadFile
//     dispatch -- it only runs from the dedicated button's click handler
//   - the flag itself defaults to false in flags.manifest.json (ships dark)
//
// RUN WITH: node test/cleaning-crew-audio-transcription.test.mjs

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

const crewSrc = readFileSync(new URL('../js/app-shell/tabs/cleaning-crew-tab.js', import.meta.url), 'utf8');
const loadersSrc = readFileSync(new URL('../js/app-shell/loaders.js', import.meta.url), 'utf8');
const flagsSrc = readFileSync(new URL('../flags.manifest.json', import.meta.url), 'utf8');

// ---------- 1. Flag gating ----------
ok(crewSrc.includes("isEnabled('audioTranscription')"), 'audio station checks isEnabled(\'audioTranscription\')');
const flags = JSON.parse(flagsSrc);
ok(flags.flags.audioTranscription != null, 'flags.manifest.json declares the audioTranscription flag');
ok(flags.flags.audioTranscription.enabled === false, 'audioTranscription flag defaults to false (ships dark)');

// ---------- 2. WebGPU availability gating, independent of the flag ----------
ok(crewSrc.includes('isFileTranscriptionAvailable'), 'audio station imports/uses isFileTranscriptionAvailable');
ok(/audioAvailable\s*=\s*audioOn\s*&&\s*isFileTranscriptionAvailable\(\)/.test(crewSrc),
   'audioAvailable is the AND of the flag AND the WebGPU capability check');
ok(crewSrc.includes('crew-audio-unavailable'), 'an honest "not available" message renders when WebGPU is missing');

// ---------- 3. Opt-in consent gates the upload button ----------
ok(/id="btn-crew-audio"[^>]*disabled/.test(crewSrc), 'the upload button starts disabled in the rendered markup');
ok(crewSrc.includes("audioBtn.disabled = !optIn.checked"),
   'the upload button is only enabled once the opt-in checkbox is checked');
ok(crewSrc.includes('crew-audio-optin'), 'a dedicated opt-in checkbox exists (not reusing an unrelated control)');

// ---------- 4. "assistive, verify" labeling (user's own required framing) ----------
ok(crewSrc.includes('assistive, verify'), 'the UI copy contains the literal "assistive, verify" label');

// ---------- 5. Desktop-first soft steer ----------
ok(crewSrc.includes("pointer: coarse"), 'a coarse-pointer (likely touch/mobile) heuristic is checked');
ok(crewSrc.includes('runs best on a desktop browser'), 'a desktop-first tip is shown on coarse-pointer devices');
ok(!/isCoarsePointer[\s\S]{0,80}return;/.test(crewSrc),
   'the coarse-pointer check is a soft tip, not an early return/hard block');

// ---------- 6. Agent-blocking is stated to the human, not just mechanical ----------
ok(crewSrc.includes('not be used by any AI agent') || crewSrc.includes('not fed to any AI agent'),
   'the result card explicitly tells the human the transcript is not agent-used until confirmed');
ok(crewSrc.includes('gate.agentConsumable') || crewSrc.includes('readiness.gate'),
   'the rendered verdict reads from the real readiness gate result, not an invented flag');

// ---------- 7. Never auto-wired into the general drop-zone/loadFile dispatch ----------
ok(loadersSrc.includes('export async function loadAudioAsDataset'),
   'loadAudioAsDataset is exported from loaders.js');
const loadFileBody = loadersSrc.slice(
  loadersSrc.indexOf('export async function loadFile'),
  loadersSrc.indexOf('export async function loadFile') + 2000
);
ok(!loadFileBody.includes('loadAudioAsDataset'),
   'loadFile\'s automatic dispatch never calls loadAudioAsDataset -- audio transcription only starts from an explicit button');
ok(crewSrc.includes('loaders.loadAudioAsDataset'),
   'the Cleaning Crew tab\'s dedicated button is the real caller of loadAudioAsDataset');

// ---------- 8. Correct module wiring (no duplicated/parallel logic) ----------
ok(crewSrc.includes("from '../../audio/whisper-file-transcriber.js'"),
   'cleaning-crew-tab.js imports the real whisper-file-transcriber module, not a duplicate');
ok(crewSrc.includes("from '../../audio/audio-structurer.js'"),
   'cleaning-crew-tab.js imports the real audio-structurer module for its summary');
ok(loadersSrc.includes("from '../audio/audio-readiness-gate.js'"),
   'loaders.js imports the real audio-readiness-gate module');

// ---------- Summary ----------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
