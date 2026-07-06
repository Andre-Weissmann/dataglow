// ============================================================
// DATAGLOW — Ambient Watch-Folder change-detection + reuse test suite
// ============================================================
// showDirectoryPicker() needs a real browser + user gesture, so it can't be
// unit tested in Node. Per the spec, this suite covers the two testable seams:
//   1. The pure file-change-detection logic (fileSignature / hasFileChanged /
//      diffEntries / isSupportedFile) with mock file metadata + timestamps.
//   2. Validation-pipeline REUSE — WatchFolderController delegates each detected
//      file to the injected ingestAndValidate spy exactly once per new/changed
//      file (and NOT for unchanged files), proving it reuses the shared pipeline
//      rather than duplicating validation logic.
//
// RUN WITH:  node test/watch-folder.test.mjs      (no DuckDB needed)

import {
  SUPPORTED_EXTENSIONS, fileExtension, isSupportedFile,
  fileSignature, hasFileChanged, diffEntries,
  directoryPickerSupported, UNSUPPORTED_MESSAGE, PRIVACY_NOTICE,
  WatchFolderController,
} from '../js/watch-folder.js';

// ---------- tiny test harness (no framework) ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A synchronous, manually-driven scheduler so tests trigger polls on demand
// rather than waiting on real timers.
function makeManualScheduler() {
  let fn = null;
  return {
    set: (f) => { fn = f; return 1; },
    clear: () => { fn = null; },
    tick: async () => { if (fn) await fn(); },
    get armed() { return fn != null; },
  };
}

// A mock FileSystemDirectoryHandle whose enumeration the test controls. Each
// entry mimics a FileSystemFileHandle: kind:'file', name, getFile() → {size,
// lastModified}. The `files` array is swapped between polls to simulate drops
// and edits.
function makeMockDir(getFiles) {
  return {
    async *values() {
      for (const f of getFiles()) {
        yield {
          kind: 'file',
          name: f.name,
          async getFile() { return { size: f.size, lastModified: f.lastModified }; },
        };
      }
    },
  };
}

async function main() {
  // ============================================================
  // 1 — Pure helpers: extensions + supported types.
  // ============================================================
  ok(fileExtension('claims.CSV') === 'csv' && fileExtension('a.tar.gz') === 'gz' && fileExtension('noext') === '',
    'ext: fileExtension lowercases and takes the last segment');
  ok(isSupportedFile('data.csv') && isSupportedFile('x.parquet') && !isSupportedFile('readme.txt'),
    'ext: isSupportedFile matches the existing upload accept-list');
  ok(SUPPORTED_EXTENSIONS.includes('csv') && SUPPORTED_EXTENSIONS.includes('ndjson'),
    'ext: the supported-extension list mirrors the upload pipeline');

  // ============================================================
  // 2 — Change detection: signature identity vs. mtime/size deltas.
  // ============================================================
  const a1 = { size: 100, lastModified: 1000 };
  const a1same = { size: 100, lastModified: 1000 };
  const a1touched = { size: 100, lastModified: 2000 };
  const a1grown = { size: 250, lastModified: 1000 };
  ok(fileSignature(a1) === fileSignature(a1same),
    'change: identical (size,mtime) yields an identical signature');
  ok(hasFileChanged(null, a1) === true,
    'change: a brand-new file (no prior signature) counts as changed');
  ok(hasFileChanged(fileSignature(a1), a1same) === false,
    'change: an untouched file is NOT reported as changed');
  ok(hasFileChanged(fileSignature(a1), a1touched) === true,
    'change: a newer lastModified is detected as a change');
  ok(hasFileChanged(fileSignature(a1), a1grown) === true,
    'change: a changed size is detected as a change');

  // diffEntries: only supported + actually-changed files are returned.
  const prev = new Map();
  const first = diffEntries(prev, [
    { name: 'a.csv', size: 10, lastModified: 1 },
    { name: 'b.parquet', size: 20, lastModified: 1 },
    { name: 'notes.txt', size: 5, lastModified: 1 }, // unsupported → ignored
  ]);
  ok(first.changed.length === 2 && first.changed.every(e => isSupportedFile(e.name)),
    'diff: first enumeration returns all supported files as changed, ignoring unsupported types');
  ok(!first.next.has('notes.txt'),
    'diff: unsupported files are never tracked in the signature map');

  const second = diffEntries(first.next, [
    { name: 'a.csv', size: 10, lastModified: 1 },      // unchanged
    { name: 'b.parquet', size: 20, lastModified: 999 }, // edited
    { name: 'c.json', size: 7, lastModified: 3 },       // new
  ]);
  const changedNames = second.changed.map(e => e.name).sort();
  ok(changedNames.length === 2 && changedNames[0] === 'b.parquet' && changedNames[1] === 'c.json',
    'diff: only the edited + newly-added supported files are reported on a subsequent poll');

  // ============================================================
  // 3 — Feature detection + user-facing copy.
  // ============================================================
  ok(directoryPickerSupported({ showDirectoryPicker: () => {} }) === true,
    'support: detected when showDirectoryPicker exists on the scope');
  ok(directoryPickerSupported({}) === false,
    'support: reported unsupported when the API is absent (Safari/Firefox)');
  ok(/Chrome|Edge|Chromium/i.test(UNSUPPORTED_MESSAGE) && /never uploaded/i.test(UNSUPPORTED_MESSAGE),
    'support: the unsupported message names Chromium browsers and reassures on privacy');
  ok(/never uploads/i.test(PRIVACY_NOTICE),
    'privacy: the privacy notice states files are never uploaded');

  // ============================================================
  // 4 — Controller delegates to the SHARED validation pipeline (reuse proof).
  // ============================================================
  const calls = [];
  const spyIngest = async (file, entry) => { calls.push(entry.name); return { grade: 'A' }; };
  let files = [
    { name: 'a.csv', size: 10, lastModified: 1 },
    { name: 'ignore.txt', size: 3, lastModified: 1 },
  ];
  const sched = makeManualScheduler();
  const updates = [];
  const controller = new WatchFolderController({ ingestAndValidate: spyIngest, scheduler: sched, intervalMs: 1000 });
  controller.onUpdate = (u) => updates.push(u);

  await controller.start(makeMockDir(() => files)); // immediate first poll
  ok(calls.length === 1 && calls[0] === 'a.csv',
    'controller: the injected ingestAndValidate ran once for the supported file (unsupported ignored)');
  ok(sched.armed, 'controller: the poll loop is armed after start');
  ok(updates.length === 1 && updates[0].ok === true && updates[0].result.grade === 'A',
    'controller: onUpdate surfaced the pipeline result (grade A) for the validated file');

  // A poll with no changes must NOT re-invoke the pipeline.
  await sched.tick();
  ok(calls.length === 1, 'controller: an unchanged folder does NOT re-run validation (no duplicate work)');

  // Drop a new file + edit the existing one → exactly two more invocations.
  files = [
    { name: 'a.csv', size: 999, lastModified: 500 }, // edited
    { name: 'b.json', size: 4, lastModified: 2 },     // new
    { name: 'ignore.txt', size: 3, lastModified: 1 },
  ];
  await sched.tick();
  ok(calls.length === 3 && calls.slice(1).sort().join(',') === 'a.csv,b.json',
    'controller: only the new + edited supported files trigger the shared pipeline on the next poll');

  // stop() clears the loop so nothing dangles.
  controller.stop();
  ok(!sched.armed && controller.watching === false,
    'controller: stop() clears the interval and marks the watcher inactive');

  // ============================================================
  // 5 — Graceful failure when the handle throws (permission revoked).
  // ============================================================
  const throwingDir = { async *values() { throw new Error('permission revoked'); } };
  let sawError = null;
  const c2 = new WatchFolderController({ ingestAndValidate: spyIngest, scheduler: makeManualScheduler() });
  c2.onError = (e) => { sawError = e; };
  await c2.start(throwingDir);
  ok(sawError && /permission/i.test(sawError.message) && c2.watching === false,
    'controller: a revoked-permission enumeration error is caught, surfaced via onError, and stops the loop');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — test run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
