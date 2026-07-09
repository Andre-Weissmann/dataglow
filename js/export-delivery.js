// ============================================================
// DATAGLOW — Export delivery adapters (platform-specific "how")
// ============================================================
// The Universal Export Contract (js/export-report.js) turns the active dataset
// into raw bytes for a given format and knows NOTHING about how those bytes
// reach the user's disk. This file owns that second half: a tiny adapter per
// platform that takes an already-built blob descriptor and delivers it.
//
// A blob descriptor is the single currency between the two halves:
//   { data: Uint8Array, filename: string, mimeType: string }
//
// Keeping "build bytes" and "deliver bytes" apart is the whole point — a new
// runtime (a future mobile share-sheet) is a new ~20-line adapter here, with no
// change to the format builders. Every adapter is a pure function of its inputs
// plus an injected `win` (defaults to the real window), so the browser and
// desktop paths can be unit-tested with a fake window and no real DOM/Tauri.
//
// Zero-upload invariant: every delivery path writes to the LOCAL device only
// (a browser download or a native file write). No adapter performs a network
// request. Do not add one — it would break DATAGLOW's core promise.

export const DELIVERY_BROWSER = 'browser';
export const DELIVERY_DESKTOP = 'desktop';
export const DELIVERY_MOBILE = 'mobile';

function resolveWin(win) {
  return win || (typeof window !== 'undefined' ? window : undefined);
}

/**
 * Browser delivery: the standard Blob + object-URL + synthetic <a download>
 * click this repo already uses everywhere else (see downloadText in main.js).
 * Works in a plain browser AND inside the Tauri webview, so it is also the
 * desktop adapter's fallback when the native file APIs are not enabled.
 * @param {{data: Uint8Array, filename: string, mimeType: string}} blob
 * @param {{win?: object}} [opts]
 * @returns {Promise<{delivered: boolean, via: string, filename: string}>}
 */
export async function deliverViaBrowser(blob, { win } = {}) {
  const w = resolveWin(win);
  if (!w || !w.document || typeof w.URL === 'undefined' || typeof w.Blob === 'undefined') {
    throw new Error('browser delivery requires a DOM with Blob/URL support');
  }
  const b = new w.Blob([blob.data], { type: blob.mimeType });
  const url = w.URL.createObjectURL(b);
  try {
    const a = w.document.createElement('a');
    a.href = url;
    a.download = blob.filename;
    w.document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    w.URL.revokeObjectURL(url);
  }
  return { delivered: true, via: DELIVERY_BROWSER, filename: blob.filename };
}

// Does the Tauri v1 JS API expose the dialog + filesystem calls we need? This
// is only true when the desktop shell opts into them (allowlist entries plus
// `withGlobalTauri: true` in src-tauri/tauri.conf.json). The shell ships
// deny-by-default today (see docs/desktop-shell.md — the native filesystem
// bridge is a deliberately out-of-scope, separately-gated follow-up), so this
// returns false and the desktop adapter degrades to the browser download. The
// moment the shell turns those APIs on, the native "Save As" path lights up
// with no change here.
function tauriFileApi(w) {
  const t = w && w.__TAURI__;
  const save = t && t.dialog && typeof t.dialog.save === 'function' ? t.dialog.save : null;
  const write =
    t && t.fs && typeof t.fs.writeBinaryFile === 'function' ? t.fs.writeBinaryFile : null;
  return save && write ? { save, write } : null;
}

/**
 * Desktop (Tauri) delivery: native "Save As" dialog + native file write when
 * the shell enables Tauri's dialog/fs APIs; otherwise a transparent fallback to
 * the browser download (the same path every other export in the app uses inside
 * the desktop webview today). User-cancelled dialogs resolve as not-delivered
 * rather than throwing.
 * @param {{data: Uint8Array, filename: string, mimeType: string}} blob
 * @param {{win?: object}} [opts]
 * @returns {Promise<{delivered: boolean, via: string, cancelled?: boolean, filename?: string}>}
 */
export async function deliverViaDesktop(blob, { win } = {}) {
  const w = resolveWin(win);
  const api = tauriFileApi(w);
  if (!api) {
    // Native bridge not enabled — behave exactly like the browser export.
    return deliverViaBrowser(blob, { win: w });
  }
  const ext = (blob.filename.split('.').pop() || '').toLowerCase();
  const path = await api.save({
    defaultPath: blob.filename,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
  });
  if (!path) {
    return { delivered: false, via: DELIVERY_DESKTOP, cancelled: true };
  }
  // Tauri v1 fs.writeBinaryFile accepts a { path, contents } descriptor.
  await api.write({ path, contents: blob.data });
  return { delivered: true, via: DELIVERY_DESKTOP, filename: path };
}

/**
 * Mobile delivery — FUTURE WORK, intentionally not implemented.
 *
 * No mobile app exists yet (mobile/tablet are planned on the same Tauri v2
 * foundation but not built). When it lands, this is where a share-sheet-based
 * adapter goes: on Tauri v2 mobile, write the bytes to a temp/cache path via
 * the fs plugin, then hand that path to the OS share sheet (e.g. a
 * `tauri-plugin-share`/`@tauri-apps/plugin-dialog` equivalent) so the user
 * picks the destination app. It must stay a pure local hand-off — no upload —
 * to preserve the zero-upload invariant. Implementing it should require ONLY a
 * new adapter here plus a `mobile` entry in selectAdapter, with zero changes to
 * the format byte-builders in js/export-report.js.
 * @returns {never}
 */
export async function deliverViaMobile() {
  throw new Error(
    'export: mobile delivery adapter is not implemented yet (no mobile app exists). ' +
    'See deliverViaMobile in js/export-delivery.js for the planned share-sheet approach.',
  );
}

/**
 * Pick the delivery adapter for a runtime platform token (as produced by the
 * capability registry's detectPlatform). Unknown/default → browser.
 * @param {'browser'|'desktop'|'mobile'} platform
 * @returns {(blob: object, opts?: object) => Promise<object>}
 */
export function selectAdapter(platform) {
  switch (platform) {
    case DELIVERY_DESKTOP:
      return deliverViaDesktop;
    case DELIVERY_MOBILE:
      return deliverViaMobile;
    case DELIVERY_BROWSER:
    default:
      return deliverViaBrowser;
  }
}

/**
 * Deliver an already-built blob descriptor on the given platform.
 * @param {{data: Uint8Array, filename: string, mimeType: string}} blob
 * @param {{platform?: string, win?: object}} [opts]
 * @returns {Promise<object>} delivery outcome from the chosen adapter.
 */
export function deliverBlob(blob, { platform, win } = {}) {
  return selectAdapter(platform)(blob, { win });
}
