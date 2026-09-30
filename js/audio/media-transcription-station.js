import { escapeHtml } from '../app-shell/utils.js';
import { isFileTranscriptionAvailable } from './whisper-file-transcriber.js';
import { isVideoExtractionAvailable } from '../video/video-audio-extractor.js';
import { buildAudioDatasetSummary } from './audio-structurer.js';

// Both stations use the SAME UI lifecycle and review/confirm path. Dependencies
// are supplied by the tab, allowing real browser tests without model downloads.
export function mountMediaTranscriptionStation(host, kind, deps) {
  const video = kind === 'video';
  const available = isFileTranscriptionAvailable() && (!video || isVideoExtractionAvailable());
  const title = video ? 'Video audio transcript' : 'Audio transcription';
  const formats = video ? '.mp4,.mov,.webm' : '.mp3,.wav,.m4a,.flac';
  let busy = false;
  let review = null;
  let controller = null;
  let disposed = false;
  const html = escapeHtml;
  host.innerHTML = `
    <section data-testid="crew-${kind}-station" style="border-top:1px solid var(--color-border);padding-top:var(--space-4);min-width:0">
      <h3 style="margin:0 0 8px">${title}</h3>
      <p style="margin:0 0 12px;color:var(--color-text-muted)">assistive, verify. Desktop-first. Up to 200 MiB and 10 minutes of audio.
        ${video ? 'Primary audio track only; no frames, scene understanding or speaker identification.' : 'No microphone access needed.'}</p>
      ${available ? `
      <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:12px">
        <input type="checkbox" data-testid="crew-${kind}-optin">
        <span>I agree to download the speech model and runtime, and process this file on this device. The recording is not uploaded.</span>
      </label>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <button type="button" class="btn btn-secondary" data-testid="btn-crew-${kind}" disabled>Choose ${kind} and transcribe</button>
        <button type="button" class="btn btn-secondary" data-testid="crew-${kind}-cancel" style="display:none">Cancel</button>
        <input type="file" data-testid="crew-${kind}-input" accept="${formats}" hidden>
      </div>` : `<p data-testid="crew-${kind}-unavailable">Unavailable here. A working WebGPU adapter${video ? ' and a supported WebCodecs audio decoder' : ''} are required. No cloud fallback.</p>`}
      <p role="status" aria-live="polite" data-testid="crew-${kind}-status" style="overflow-wrap:anywhere"></p>
      <div data-testid="crew-${kind}-result" style="min-width:0"></div>
    </section>`;
  if (!available) return () => { disposed = true; };
  const find = id => host.querySelector(`[data-testid="${id}"]`);
  const optIn = find(`crew-${kind}-optin`);
  const button = find(`btn-crew-${kind}`);
  const cancel = find(`crew-${kind}-cancel`);
  const input = find(`crew-${kind}-input`);
  const status = find(`crew-${kind}-status`);
  const result = find(`crew-${kind}-result`);
  const active = () => !disposed && host.isConnected;
  function discard() {
    try { review?.discard(); } catch { /* consumed */ }
    review = null;
  }
  function setBusy(value) {
    busy = value;
    button.disabled = busy || !optIn.checked;
    optIn.disabled = busy;
    cancel.style.display = busy ? '' : 'none';
  }
  optIn.addEventListener('change', () => { button.disabled = busy || !optIn.checked; });
  if (globalThis.matchMedia?.('(pointer: coarse)').matches) {
    status.textContent = 'This runs best on a desktop browser. Mobile is not independently verified.';
  }
  button.addEventListener('click', () => { if (optIn.checked && !busy) input.click(); });
  cancel.addEventListener('click', () => {
    controller?.abort();
    status.textContent = 'Cancellation requested. A running model step may finish, but nothing will be imported.';
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !optIn.checked || busy || !active()) return;
    discard();
    result.replaceChildren();
    controller = new AbortController();
    setBusy(true);
    status.textContent = 'Preparing local transcription. First model download can take several minutes.';
    try {
      review = await deps.prepare(file, {
        consent: optIn.checked, signal: controller.signal,
        onProgress: p => {
          if (active() && !controller.signal.aborted) status.textContent = p.text;
        },
      });
      if (!active() || controller.signal.aborted) { discard(); return; }
      renderReview();
      status.textContent = 'Ready for your review. No dataset has been imported.';
    } catch (error) {
      if (active()) status.textContent = error.message || 'Transcription failed. Nothing was imported.';
    } finally {
      if (active()) setBusy(false);
    }
  });

  function renderReview() {
    const current = review;
    const view = current.preview();
    result.innerHTML = `
      <h4>Review transcript <small>assistive, verify</small></h4>
      <p>${html(buildAudioDatasetSummary(view.structured).headline)}</p>
      <p data-testid="crew-${kind}-gate">Blocked from dataset agents until confirmed. Text presence is not accuracy.
        Check the words against your original recording in your media player; playback is not included here.</p>
      ${video ? `<p>Audio tracks: ${view.metadata.audioTrackCount}. Selected: primary. Codec: ${html(view.metadata.codec)}.</p>` : ''}
      <div style="max-height:360px;overflow:auto">
        ${view.structured.rows.map((row, i) => `
          <label style="display:block;margin-bottom:12px">
            <span>Segment ${i + 1}: ${row.start_sec.toFixed(2)} to ${row.end_sec.toFixed(2)} seconds</span>
            <textarea data-segment="${i}" rows="3" style="display:block;box-sizing:border-box;width:100%;min-width:0;resize:vertical;font:inherit">${html(row.text)}</textarea>
          </label>`).join('')}
      </div>
      <label style="display:block;margin:12px 0">Local reviewer name
        <input data-testid="crew-${kind}-reviewer" type="text" maxlength="120" autocomplete="off" style="display:block;box-sizing:border-box;max-width:100%;font:inherit">
      </label>
      <label style="display:flex;gap:10px;align-items:flex-start;margin:12px 0">
        <input type="checkbox" data-testid="crew-${kind}-reviewed">
        <span>I checked this exact transcript against the recording and approve importing it for analysis.</span>
      </label>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <button type="button" class="btn btn-primary" data-testid="crew-${kind}-confirm" disabled>Confirm and import transcript</button>
        <button type="button" class="btn btn-secondary" data-testid="crew-${kind}-discard">Discard transcript</button>
      </div>`;
    const checked = find(`crew-${kind}-reviewed`);
    const reviewer = find(`crew-${kind}-reviewer`);
    const confirm = find(`crew-${kind}-confirm`);
    const discardBtn = find(`crew-${kind}-discard`);
    let acceptedRevision = null;
    function update() {
      confirm.disabled = !checked.checked || !reviewer.value.trim() || busy;
    }
    reviewer.addEventListener('input', update);
    checked.addEventListener('change', () => {
      acceptedRevision = checked.checked ? current.preview().revision : null;
      update();
    });
    for (const textarea of result.querySelectorAll('textarea')) {
      textarea.addEventListener('input', () => {
        current.edit(Number(textarea.dataset.segment), textarea.value);
        checked.checked = false;
        acceptedRevision = null;
        update();
      });
    }
    discardBtn.addEventListener('click', () => {
      if (busy) return;
      discard();
      result.replaceChildren();
      status.textContent = 'Discarded. Nothing was imported.';
    });
    confirm.addEventListener('click', async event => {
      if (!event.isTrusted || confirm.disabled || busy || current !== review || !active()) return;
      const confirmation = { confirmed: checked.checked, reviewer: reviewer.value.trim(), revision: acceptedRevision };
      setBusy(true);
      cancel.style.display = 'none';
      confirm.disabled = true;
      discardBtn.disabled = true;
      for (const node of result.querySelectorAll('input,textarea')) node.disabled = true;
      try {
        await deps.ensureDuckDB();
        if (!active()) return;
        const ds = await deps.confirm(current, confirmation);
        review = null;
        if (!active()) return;
        result.replaceChildren();
        status.textContent = `Imported ${ds.rowCount} reviewed segments as "${ds.name}". Assistive, verify.`;
        deps.renderSidebar();
      } catch (error) {
        if (active()) {
          status.textContent = `Import stopped: ${error.message}. Start a new review before retrying.`;
          discard();
          result.replaceChildren();
        }
      } finally { if (active()) setBusy(false); }
    });
  }
  return () => {
    disposed = true;
    controller?.abort();
    discard();
  };
}
