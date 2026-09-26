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

export async function renderCleaningCrewTab({ ensureDuckDB, renderSidebar, iconSvg }) {
  const host = document.getElementById('cleaning-crew-body');
  if (!host) return;
  if (!isEnabled('cleaningCrew')) { host.innerHTML = ''; return; }

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
      renderCleaningCrewProfile(profile);
      renderSidebar();
    } catch (err) {
      statusEl.textContent = '';
      $('#crew-profile').innerHTML = `<div class="err" data-testid="crew-profile-error">Failed to profile PDF: ${escapeHtml(err.message)}</div>`;
    }
  });
}

function renderCleaningCrewProfile(profile) {
  const el = document.getElementById('crew-profile');
  if (!el) return;
  const { gate, explanation } = pdfProfiler.evaluatePdfReadiness(profile);
  const verdictClass = gate.agentConsumable ? 'ok' : 'err';
  const warningsHtml = (profile.warnings || [])
    .map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  el.innerHTML = `
    <div class="crew-profile-card" data-testid="crew-profile-card" style="display:flex; flex-direction:column; gap:var(--space-2);">
      <div><strong>Profile</strong></div>
      <div data-testid="crew-page-count">Pages: <strong>${profile.pageCount}</strong></div>
      <div data-testid="crew-pages-with-text">Pages with extractable text: <strong>${profile.pagesWithText}</strong></div>
      <div data-testid="crew-pages-without-text">Pages without extractable text: <strong>${profile.pagesWithoutText}</strong></div>
      ${warningsHtml ? `<ul data-testid="crew-warnings" style="margin:0; color:var(--color-warn, #b7791f);">${warningsHtml}</ul>` : ''}
      <div class="${verdictClass}" data-testid="crew-gate-verdict" style="white-space:pre-wrap; font-family:var(--font-mono); font-size:var(--text-sm);">${escapeHtml(explanation)}</div>
    </div>`;
}
