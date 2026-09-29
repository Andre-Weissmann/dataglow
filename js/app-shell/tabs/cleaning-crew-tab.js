// ============================================================
// Cleaning Crew Tab
// ============================================================
// Station 1 of 5 (Profiler): profiles an uploaded PDF -- how many pages have
// extractable text vs. are scanned images. Runs fully on-device.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-26) -- byte-for-byte identical
// behavior, only the file location changed. renderCleaningCrewTab now takes
// `{ ensureDuckDB, renderSidebar, iconSvg }` since those stay defined in
// main.js (ensureDuckDB/renderSidebar are app-shell-wide, iconSvg reads a
// large inline icon map that belongs to the tab bar, not this tab) --
// extracting any of the three would create a circular import.

import { $, escapeHtml } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import * as loaders from '../loaders.js';
import * as pdfProfiler from '../../cleaning-crew/pdf-profiler.js';
import { requestGlowCanvasPrefill } from './glow-canvas-tab.js';
import { isFileTranscriptionAvailable } from '../../audio/whisper-file-transcriber.js';
import { buildAudioDatasetSummary } from '../../audio/audio-structurer.js';

// Batch 4 (Glow Compiler): bridges a just-profiled, just-gated PDF dataset
// straight into Glow Canvas's "Add chart" form, instead of leaving the user to
// discover on their own that Cleaning Crew output is an ordinary queryable
// dataset like any CSV/JSON upload. `switchTab` is the same real dispatcher
// callback already threaded into join-builder-tab.js / nl-sql-tab.js — no new
// navigation mechanism invented.
export async function renderCleaningCrewTab({ ensureDuckDB, renderSidebar, iconSvg, switchTab }) {
  const host = document.getElementById('cleaning-crew-body');
  if (!host) return;
  if (!isEnabled('cleaningCrew')) { host.innerHTML = ''; return; }

  const audioOn = isEnabled('audioTranscription');
  const audioAvailable = audioOn && isFileTranscriptionAvailable();
  const audioStationHtml = audioOn ? `
      <div class="crew-station" data-testid="crew-station-audio" style="display:flex; align-items:center; gap:var(--space-2); margin-top:var(--space-4);">
        ${iconSvg('sparkles', 20)}
        <div>
          <strong>Audio transcription</strong> <span style="color:var(--color-text-faint); font-size:var(--text-xs);">assistive, verify</span>
          <div style="color:var(--color-text-muted); font-size:var(--text-sm);">Transcribes an uploaded audio file (mp3/wav/m4a/flac) fully on your device. Works best on desktop. Not fed to any AI agent until you confirm it looks right.</div>
        </div>
      </div>
      <div id="crew-audio-consent" data-testid="crew-audio-consent" style="display:flex; flex-direction:column; gap:var(--space-2);">
        ${audioAvailable ? `
          <label style="display:flex; align-items:flex-start; gap:var(--space-2); font-size:var(--text-sm); color:var(--color-text-muted);">
            <input type="checkbox" id="crew-audio-optin" data-testid="crew-audio-optin" />
            <span>I understand this downloads a speech-to-text model to my browser and transcribes the audio file on this device. Nothing is uploaded.</span>
          </label>
          <div style="display:flex; align-items:center; gap:var(--space-2);">
            <button type="button" class="btn btn-secondary" id="btn-crew-audio" data-testid="btn-crew-audio" disabled>Upload audio to transcribe</button>
            <input type="file" id="crew-audio-input" data-testid="crew-audio-input" accept="audio/*,.mp3,.wav,.m4a,.flac" style="display:none;" />
            <span id="crew-audio-status" data-testid="crew-audio-status" style="color:var(--color-text-faint); font-size:var(--text-sm);"></span>
          </div>
        ` : `<div data-testid="crew-audio-unavailable" style="color:var(--color-text-faint); font-size:var(--text-sm);">Audio transcription needs a WebGPU-capable browser (recent Chrome, Edge, or Chrome on Android; Safari 18+) and is not available here.</div>`}
      </div>
      <div id="crew-audio-result" data-testid="crew-audio-result"></div>
  ` : '';

  host.innerHTML = `
    <div class="cleaning-crew" data-testid="cleaning-crew" style="display:flex; flex-direction:column; gap:var(--space-4);">
      <div class="crew-station" data-testid="crew-station-profiler" style="display:flex; align-items:center; gap:var(--space-2);">
        ${iconSvg('sparkles', 20)}
        <div>
          <strong>Profiler</strong>
          <div style="color:var(--color-text-muted); font-size:var(--text-sm);">Station 1 of 5 — profiles an uploaded PDF: how many pages have extractable text vs. are scanned images. Runs fully on your device.</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:var(--space-2);">
        <button type="button" class="btn btn-primary" id="btn-crew-pdf" data-testid="btn-crew-pdf">Upload a PDF</button>
        <input type="file" id="crew-pdf-input" data-testid="crew-pdf-input" accept="application/pdf,.pdf" style="display:none;" />
        <span id="crew-pdf-status" data-testid="crew-pdf-status" style="color:var(--color-text-faint); font-size:var(--text-sm);"></span>
      </div>
      <div id="crew-profile" data-testid="crew-profile"></div>
      ${audioStationHtml}
    </div>`;

  const statusEl = $('#crew-pdf-status');
  const input = $('#crew-pdf-input');
  $('#btn-crew-pdf').addEventListener('click', () => input.click());
  input.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    input.value = '';
    if (!file) return;
    statusEl.textContent = 'Loading PDF runtime & extracting text…';
    $('#crew-profile').innerHTML = '';
    try {
      await ensureDuckDB();
      const { ds, profile } = await loaders.loadPdfAsDataset(file);
      statusEl.textContent = ds ? `Loaded "${escapeHtml(ds.name)}" — ${ds.rowCount} page-row(s).` : '';
      renderCleaningCrewProfile(profile, ds, switchTab);
      renderSidebar();
    } catch (err) {
      statusEl.textContent = '';
      $('#crew-profile').innerHTML = `<div class="err" data-testid="crew-profile-error">Failed to profile PDF: ${escapeHtml(err.message)}</div>`;
    }
  });

  if (audioAvailable) {
    wireAudioStation({ ensureDuckDB, renderSidebar });
  }
}

// Audio transcription station wiring (Batch 5): the opt-in checkbox is the
// explicit human consent gesture -- the upload button stays disabled until it
// is checked, so transcription can never start from a bare file picker click
// alone. Desktop-first is a soft, honest steer (coarse-pointer heuristic),
// not a hard block -- WebGPU absence already hard-blocks devices that truly
// cannot run this.
function wireAudioStation({ ensureDuckDB, renderSidebar }) {
  const optIn = $('#crew-audio-optin');
  const audioBtn = $('#btn-crew-audio');
  const audioInput = $('#crew-audio-input');
  const audioStatus = $('#crew-audio-status');
  if (!optIn || !audioBtn || !audioInput) return;

  optIn.addEventListener('change', () => {
    audioBtn.disabled = !optIn.checked;
  });

  const isCoarsePointer = typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  if (isCoarsePointer) {
    audioStatus.textContent = 'Tip: this runs best on a desktop browser.';
  }

  audioBtn.addEventListener('click', () => audioInput.click());
  audioInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    audioInput.value = '';
    if (!file) return;
    $('#crew-audio-result').innerHTML = '';
    audioStatus.textContent = 'Downloading speech-to-text model & transcribing on-device… this can take a minute the first time.';
    try {
      await ensureDuckDB();
      const { ds, structured, readiness } = await loaders.loadAudioAsDataset(file, (p) => {
        if (p && p.text) audioStatus.textContent = `${p.text}… ${Math.round((p.progress || 0) * 100)}%`;
      });
      audioStatus.textContent = ds ? `Loaded "${escapeHtml(ds.name)}" (${ds.rowCount} segment(s)).` : '';
      renderAudioResult(structured, readiness);
      renderSidebar();
    } catch (err) {
      audioStatus.textContent = '';
      $('#crew-audio-result').innerHTML = `<div class="err" data-testid="crew-audio-error">Failed to transcribe audio: ${escapeHtml(err.message)}</div>`;
    }
  });
}

function renderAudioResult(structured, readiness) {
  const el = document.getElementById('crew-audio-result');
  if (!el) return;
  const { gate, explanation } = readiness;
  const verdictClass = gate.agentConsumable ? 'ok' : 'err';
  const summary = buildAudioDatasetSummary(structured);
  el.innerHTML = `
    <div class="crew-audio-card" data-testid="crew-audio-card" style="display:flex; flex-direction:column; gap:var(--space-2);">
      <div><strong>Transcript</strong> <span style="color:var(--color-text-faint); font-size:var(--text-xs);">assistive, verify</span></div>
      <div data-testid="crew-audio-headline">${escapeHtml(summary.headline)}</div>
      <div class="${verdictClass}" data-testid="crew-audio-gate-verdict" style="white-space:pre-wrap; font-family:var(--font-mono); font-size:var(--text-sm);">${escapeHtml(explanation)}</div>
      <div style="color:var(--color-text-faint); font-size:var(--text-xs);">This transcript will not be used by any AI agent in DataGlow until a human reviews and confirms it.</div>
    </div>`;
}

function renderCleaningCrewProfile(profile, ds, switchTab) {
  const el = document.getElementById('crew-profile');
  if (!el) return;
  const { gate, explanation } = pdfProfiler.evaluatePdfReadiness(profile);
  const verdictClass = gate.agentConsumable ? 'ok' : 'err';
  const warningsHtml = (profile.warnings || [])
    .map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  // Batch 4 (Glow Compiler bridge): offer the jump to Glow Canvas whenever there
  // is an actual table to hand off AND that tab can do something with it (the
  // glowCanvas flag is on). Deliberately NOT conditioned on gate.agentConsumable
  // -- that gate governs whether an AI AGENT may treat this PDF's extracted text
  // as trustworthy, a separate question from whether a HUMAN can look at its
  // page-count/page-length data on a chart, which is safe regardless of the
  // gate verdict. The verdict text itself (already rendered below) is how the
  // user learns the trust caveat, not a reason to hide navigation.
  const showBridge = !!(ds && ds.table) && isEnabled('glowCanvas');
  const bridgeHtml = showBridge
    ? `<button type="button" class="btn btn-secondary" id="btn-crew-to-canvas" data-testid="crew-to-glow-canvas">Add to Glow Canvas</button>`
    : '';
  el.innerHTML = `
    <div class="crew-profile-card" data-testid="crew-profile-card" style="display:flex; flex-direction:column; gap:var(--space-2);">
      <div><strong>Profile</strong></div>
      <div data-testid="crew-page-count">Pages: <strong>${profile.pageCount}</strong></div>
      <div data-testid="crew-pages-with-text">Pages with extractable text: <strong>${profile.pagesWithText}</strong></div>
      <div data-testid="crew-pages-without-text">Pages without extractable text: <strong>${profile.pagesWithoutText}</strong></div>
      ${warningsHtml ? `<ul data-testid="crew-warnings" style="margin:0; color:var(--color-warn, #b7791f);">${warningsHtml}</ul>` : ''}
      <div class="${verdictClass}" data-testid="crew-gate-verdict" style="white-space:pre-wrap; font-family:var(--font-mono); font-size:var(--text-sm);">${escapeHtml(explanation)}</div>
      ${bridgeHtml}
    </div>`;
  if (showBridge) {
    document.getElementById('btn-crew-to-canvas').addEventListener('click', () => {
      requestGlowCanvasPrefill(ds.table);
      switchTab('glowcanvas');
    });
  }
}
