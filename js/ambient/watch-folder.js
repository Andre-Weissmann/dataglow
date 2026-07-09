// ============================================================
// DATAGLOW — Ambient "Watch Folder" Mode (File System Access API)
// ============================================================
// Point DATAGLOW at a local folder; it auto-detects new/changed files dropped
// into that folder and runs them through the EXISTING validation pipeline — no
// manual upload click. Everything stays on-device: the File System Access API
// hands us a directory handle the user explicitly granted via the browser's own
// native picker, and we only ever read from it. This module issues ZERO network
// calls; the only I/O is local file reads + the same in-browser DuckDB-WASM
// validation the manual upload path already performs.
//
// There is no native "changed" event for a FileSystemDirectoryHandle, so we poll
// it on an interval (see WatchFolderController) and diff each enumeration against
// the last, keyed by (size, lastModified). The change-detection logic and the
// controller's delegation to the shared validation function are pulled out as
// pure, injectable units so they can be unit-tested in Node without a real
// browser picker (see test/watch-folder.test.mjs).
// ============================================================

// File types the existing upload flow accepts (mirrors index.html's file input
// accept list and loaders.loadFile's extension switch). Kept in sync so the
// watcher never tries to ingest a type the pipeline can't load.
export const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'json', 'ndjson', 'parquet', 'xlsx', 'xls', 'arrow', 'feather'];

export function fileExtension(name) {
  const parts = String(name).split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function isSupportedFile(name) {
  return SUPPORTED_EXTENSIONS.includes(fileExtension(name));
}

// A stable content signature for a file. Two enumerations of the same untouched
// file produce the same signature; any save (size or mtime change) alters it.
export function fileSignature(meta) {
  const size = meta && meta.size != null ? meta.size : '?';
  const mtime = meta && meta.lastModified != null ? meta.lastModified : '?';
  return `${size}:${mtime}`;
}

// Has this file changed relative to the signature we last recorded for it?
// A brand-new file (no prior signature) counts as changed.
export function hasFileChanged(prevSignature, meta) {
  if (prevSignature == null) return true;
  return prevSignature !== fileSignature(meta);
}

// Diff a fresh directory enumeration against the previously-known signatures.
// `entries` : [{ name, size, lastModified, ... }]
// `prevMap` : Map<name, signature>
// Returns { changed: [entries needing (re)validation], next: Map<name,sig> }.
// Unsupported file types are ignored entirely.
export function diffEntries(prevMap, entries) {
  const next = new Map();
  const changed = [];
  for (const e of entries) {
    if (!isSupportedFile(e.name)) continue;
    const sig = fileSignature(e);
    next.set(e.name, sig);
    if (hasFileChanged(prevMap.get(e.name), e)) changed.push(e);
  }
  return { changed, next };
}

// Feature detection — the File System Access directory picker is Chromium-only.
// Callers use this to gracefully hide/disable the feature on Safari/Firefox.
export function directoryPickerSupported(scope) {
  const g = scope || (typeof globalThis !== 'undefined' ? globalThis : undefined);
  return !!g && typeof g.showDirectoryPicker === 'function';
}

// User-facing copy for unsupported browsers (kept here so UI + tests agree).
export const UNSUPPORTED_MESSAGE =
  'Watch Folder needs the File System Access API, which is currently only available in ' +
  'Chromium-based browsers (Chrome, Edge). Open DATAGLOW in Chrome or Edge to use this feature. ' +
  'Your files are never uploaded — everything stays on your device.';

export const PRIVACY_NOTICE =
  'DATAGLOW never uploads these files anywhere. The folder is read locally in your browser and ' +
  'validated on-device; nothing leaves this machine.';

// ---------------------------------------------------------------------------
// WatchFolderController — owns the poll loop and delegates each detected file to
// an injected `ingestAndValidate` function. It deliberately contains NO
// validation logic of its own: production wires `ingestAndValidate` to the exact
// same loaders.loadFile + validation.runAllLayers path the manual upload uses,
// and the unit test injects a spy to prove the delegation.
// ---------------------------------------------------------------------------
export class WatchFolderController {
  constructor({ ingestAndValidate, intervalMs = 4000, scheduler } = {}) {
    if (typeof ingestAndValidate !== 'function') {
      throw new Error('WatchFolderController requires an ingestAndValidate(file, entry) function.');
    }
    this.ingestAndValidate = ingestAndValidate;
    this.intervalMs = intervalMs;
    // Injectable timer so tests can drive polls deterministically.
    this.scheduler = scheduler || {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (id) => clearInterval(id),
    };
    this.dirHandle = null;
    this.timer = null;
    this.watching = false;
    this.known = new Map();     // name -> signature
    this.onUpdate = null;       // ({ name, ok, result?, error?, ts }) => void
    this.onError = null;        // (err) => void  — permission lost / enumeration failed
    this._polling = false;      // guard against overlapping polls
  }

  // Enumerate the directory handle into plain metadata + a live File object.
  async listEntries() {
    const out = [];
    for await (const entry of this.dirHandle.values()) {
      if (entry.kind !== 'file') continue;
      const file = await entry.getFile();
      out.push({ name: entry.name, size: file.size, lastModified: file.lastModified, handle: entry, file });
    }
    return out;
  }

  async start(dirHandle) {
    this.stop();
    this.dirHandle = dirHandle;
    this.known = new Map();
    this.watching = true;
    await this.poll(); // immediate first pass so the panel populates at once
    if (this.watching) this.timer = this.scheduler.set(() => this.poll(), this.intervalMs);
    return this;
  }

  stop() {
    if (this.timer != null) this.scheduler.clear(this.timer);
    this.timer = null;
    this.watching = false;
    this.dirHandle = null;
    this._polling = false;
  }

  async poll() {
    if (!this.watching || !this.dirHandle || this._polling) return [];
    this._polling = true;
    let entries;
    try {
      entries = await this.listEntries();
    } catch (err) {
      // Permission may have been revoked externally, or the folder moved. Fail
      // gracefully: stop the loop and surface a reconnect prompt rather than
      // throwing an unhandled error on every tick.
      this._polling = false;
      this.stop();
      if (this.onError) this.onError(err);
      return [];
    }

    const { changed, next } = diffEntries(this.known, entries);
    this.known = next;

    for (const entry of changed) {
      try {
        const result = await this.ingestAndValidate(entry.file, entry);
        if (this.onUpdate) this.onUpdate({ name: entry.name, ok: true, result, ts: Date.now() });
      } catch (err) {
        if (this.onUpdate) this.onUpdate({ name: entry.name, ok: false, error: err, ts: Date.now() });
      }
    }
    this._polling = false;
    return changed;
  }
}
