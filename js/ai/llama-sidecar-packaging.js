// ============================================================
// DATAGLOW - llama.cpp sidecar packaging: the naming, and the agreement check
// ============================================================
//
// Bundle 12 established that the desktop path reports `sidecar_missing` and that
// `tauri.bundle.externalBin` is empty on purpose, because Tauri resolves each
// entry to a per-target-triple file at bundle time and an entry with no file
// behind it fails the build rather than shipping a missing feature.
//
// What was left was the packaging itself: where a binary goes, what it has to be
// called, and how anyone would get one. This file is the first two, and
// scripts/fetch-llama-sidecar.mjs is the third.
//
// WHY THE TRIPLE NAMING IS A FUNCTION AND NOT A README PARAGRAPH.
// Tauri's rule is that `externalBin: ["binaries/llama-server"]` resolves to
// `binaries/llama-server-x86_64-apple-darwin`, with `.exe` appended on Windows,
// and it fails the build with a message that does not say this. Every project
// that uses externalBin gets this wrong once. A function that produces the name
// can be called by the fetch script and asserted by a test, which is two places
// the mistake cannot happen.
//
// WHY THE CONFIG AND THE STATUS ARE CHECKED AGAINST EACH OTHER.
// There are two ways to ship a lie here. Naming the binary in the config without
// vendoring it breaks the build, which is loud. Vendoring the binary without
// naming it in the config produces a desktop app that reports `ready` from a
// file the bundle never included, which is quiet and much worse.
// `checkPackagingAgreement()` fails on both, and CI runs it against the real
// tauri.conf.json.
//
// WHAT IS NOT HERE.
// No binary, no weights, nothing multi-hundred-megabyte in git. The fetch script
// downloads on a developer's machine into an ignored directory and the bundle
// stays empty until someone decides otherwise with a licence answer in hand.
//
// Pure. No filesystem, no process, no network. The caller observes and hands in.

export const SIDECAR_PACKAGING_KIND = 'dataglow-llama-sidecar-packaging';
export const SIDECAR_PACKAGING_VERSION = 1;

/** Matches SIDECAR_NAME in js/ai/desktop-local-llm.js, asserted by a test. */
export const SIDECAR_BASENAME = 'llama-server';

/** Relative to src-tauri/. Tauri resolves externalBin entries from there. */
export const SIDECAR_DIR = 'binaries';

/** The externalBin entry, if and when one is ever added. */
export const EXTERNAL_BIN_ENTRY = SIDECAR_DIR + '/' + SIDECAR_BASENAME;

/**
 * The target triples a desktop build would cover.
 *
 * Rust triples, because that is what Tauri appends. `windows` carries the `.exe`
 * because Tauri expects the extension on the vendored file as well as on the
 * resolved one.
 */
export const TARGET_TRIPLES = Object.freeze([
  Object.freeze({ triple: 'x86_64-apple-darwin', os: 'macOS', arch: 'Intel', ext: '' }),
  Object.freeze({ triple: 'aarch64-apple-darwin', os: 'macOS', arch: 'Apple silicon', ext: '' }),
  Object.freeze({ triple: 'x86_64-unknown-linux-gnu', os: 'Linux', arch: 'x86_64', ext: '' }),
  Object.freeze({ triple: 'aarch64-unknown-linux-gnu', os: 'Linux', arch: 'arm64', ext: '' }),
  Object.freeze({ triple: 'x86_64-pc-windows-msvc', os: 'Windows', arch: 'x86_64', ext: '.exe' }),
]);

export const NO_WEIGHTS_IN_GIT =
  'The binary is a few tens of megabytes and a model is hundreds. Neither belongs in this repository. The fetch script writes into an ignored directory on a developer machine and nothing it produces is committed.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The exact filename Tauri will look for.
 *
 * @param {string} triple  a Rust target triple
 * @returns {string} e.g. binaries/llama-server-aarch64-apple-darwin
 */
export function sidecarFileName(triple) {
  const t = typeof triple === 'string' ? triple.trim() : '';
  if (!t) return '';
  const known = TARGET_TRIPLES.filter(x => x.triple === t)[0];
  const ext = known ? known.ext : (/windows/.test(t) ? '.exe' : '');
  return SIDECAR_DIR + '/' + SIDECAR_BASENAME + '-' + t + ext;
}

/** Every path a full five-platform build would need, in one list. */
export function expectedSidecarPaths() {
  return TARGET_TRIPLES.map(t => ({
    triple: t.triple,
    os: t.os,
    arch: t.arch,
    path: sidecarFileName(t.triple),
    fullPath: 'src-tauri/' + sidecarFileName(t.triple),
  }));
}

/**
 * Presence, from an observation of the filesystem the caller made.
 *
 * `sidecar_ready` requires a file for the triple being asked about, not a file
 * for some triple. A macOS binary present while building for Windows is not a
 * Windows sidecar.
 *
 * @param {{triple?:string, presentTriples?:Array<string>}} [input]
 */
export function sidecarPresence(input) {
  const inp = isPlainObject(input) ? input : {};
  const present = Array.isArray(inp.presentTriples) ? inp.presentTriples.filter(t => typeof t === 'string') : [];
  const triple = typeof inp.triple === 'string' ? inp.triple.trim() : '';

  const ready = triple ? present.indexOf(triple) >= 0 : present.length > 0;

  return {
    kind: SIDECAR_PACKAGING_KIND,
    state: ready ? 'sidecar_ready' : 'sidecar_missing',
    ready,
    triple,
    presentTriples: present,
    expectedPath: triple ? sidecarFileName(triple) : '',
    detail: ready
      ? 'A llama.cpp server binary is present for ' + (triple || 'at least one target') + '.'
      : triple
        ? 'No binary at src-tauri/' + sidecarFileName(triple) + '. Run scripts/fetch-llama-sidecar.mjs, or build llama.cpp and place the server binary there under that exact name.'
        : 'No llama.cpp server binary is vendored in this checkout, which is the committed state of the repository.',
    note: NO_WEIGHTS_IN_GIT,
  };
}

/**
 * Do the shipped Tauri config and the reported status agree?
 *
 * Both failure directions are errors:
 *   config names a binary that is not vendored  -> the desktop build fails
 *   a binary is vendored but not named          -> the app reports ready from
 *                                                  something the bundle omitted
 *
 * @param {{externalBin?:Array<string>, presentTriples?:Array<string>,
 *          statusBundled?:boolean}} [input]
 */
export function checkPackagingAgreement(input) {
  const inp = isPlainObject(input) ? input : {};
  const externalBin = Array.isArray(inp.externalBin) ? inp.externalBin.slice() : [];
  const present = Array.isArray(inp.presentTriples) ? inp.presentTriples.slice() : [];
  const declared = externalBin.indexOf(EXTERNAL_BIN_ENTRY) >= 0 || externalBin.length > 0;
  const vendored = present.length > 0;

  const problems = [];
  if (declared && !vendored) {
    problems.push('tauri.bundle.externalBin names ' + externalBin.join(', ')
      + ' but no binary is vendored under src-tauri/' + SIDECAR_DIR
      + '. Tauri resolves each entry at bundle time, so this build fails for every target.');
  }
  if (!declared && vendored) {
    problems.push('A binary is vendored for ' + present.join(', ')
      + ' but tauri.bundle.externalBin is empty, so the bundle will not include it. '
      + 'Anything reporting the sidecar as ready would be reading a file the shipped app does not have.');
  }
  if (inp.statusBundled === true && !declared) {
    problems.push('The desktop status module reports the sidecar as bundled while externalBin is empty. '
      + 'These are the same claim and they disagree.');
  }
  if (inp.statusBundled === false && declared && vendored) {
    problems.push('externalBin names a vendored binary but the status module still reports bundledInThisBuild false. '
      + 'Flip that constant in the same change that fills externalBin.');
  }

  return {
    kind: SIDECAR_PACKAGING_KIND,
    ok: problems.length === 0,
    declared,
    vendored,
    externalBin,
    presentTriples: present,
    problems,
    // The committed state, so a check can say "this is expected" rather than
    // "nothing is wrong" when nothing is wrong for a reason.
    committedState: 'externalBin empty, no binary vendored, status reports sidecar_missing.',
    reason: problems.length === 0 && !declared && !vendored
      ? 'Config and status agree: no sidecar is shipped and none is claimed.'
      : problems.length === 0
        ? 'Config and status agree: a sidecar is vendored and declared.'
        : 'Config and status disagree.',
  };
}

/** The packaging path as data, for a README section or a status panel. */
export function describePackagingPath() {
  return {
    kind: SIDECAR_PACKAGING_KIND,
    version: SIDECAR_PACKAGING_VERSION,
    script: 'scripts/fetch-llama-sidecar.mjs',
    directory: 'src-tauri/' + SIDECAR_DIR + '/',
    externalBinEntry: EXTERNAL_BIN_ENTRY,
    targets: expectedSidecarPaths(),
    steps: Object.freeze([
      'Run node scripts/fetch-llama-sidecar.mjs --triple <target> to download a llama.cpp release build, or --stub for a local development placeholder.',
      'The script writes src-tauri/' + SIDECAR_DIR + '/' + SIDECAR_BASENAME + '-<triple>, which is the exact name Tauri resolves.',
      'That directory is git-ignored. Nothing the script produces is committed.',
      'Add "' + EXTERNAL_BIN_ENTRY + '" to tauri.bundle.externalBin only once a binary exists for every target being built.',
      'Flip bundledInThisBuild in js/ai/desktop-local-llm.js in the same change, so the status and the config cannot disagree.',
      'Pass the result of a real handshake with the running server to buildDesktopLlmStatus, never the config.',
    ]),
    licence:
      'llama.cpp is MIT. A model is not covered by that and every model has its own terms, so vendoring weights is a separate decision that this path deliberately does not make for anyone.',
    note: NO_WEIGHTS_IN_GIT,
  };
}


// ============================================================
// Bundle 14 - llamaSidecarFetch: a three-state status for the fetch step
// ============================================================
//
// sidecarPresence() above answers "is a binary on disk for this triple". That
// collapses two different situations into one `sidecar_ready` state: a binary
// that scripts/fetch-llama-sidecar.mjs placed but tauri.conf.json has not been
// told about yet, and a binary that is both vendored AND declared in
// externalBin so a real desktop build would actually include it. Those are
// not the same claim, and Bundle 12/13 already established that
// checkPackagingAgreement() treats the first as a build-breaking mismatch, not
// as ready.
//
// fetchSidecarStatus() names the three states plainly instead of overloading
// sidecarPresence()'s boolean:
//
//   `missing`          nothing on disk for this triple
//   `fetched_unwired`  a binary is on disk, but externalBin does not name it
//                      (or the packaging agreement disagrees for any reason)
//   `ready`            on disk AND declared AND the agreement holds
//
// This never runs a handshake against the binary. "ready" here means the
// packaging is honest, not that the server answers a request; that second
// claim belongs to buildDesktopLlmStatus() in js/ai/desktop-local-llm.js,
// which only reports its own `ready` from an actual observed handshake.

export const SIDECAR_FETCH_STATES = Object.freeze(['missing', 'fetched_unwired', 'ready']);

function isPlainObjectFetch(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {{triple?:string, presentTriples?:Array<string>, externalBin?:Array<string>}} [input]
 */
export function fetchSidecarStatus(input) {
  const inp = isPlainObjectFetch(input) ? input : {};
  const presence = sidecarPresence(inp);
  const agreement = checkPackagingAgreement({
    externalBin: inp.externalBin,
    presentTriples: inp.presentTriples,
    statusBundled: false,
  });

  let state;
  if (!presence.ready) state = 'missing';
  else if (agreement.declared && agreement.ok) state = 'ready';
  else state = 'fetched_unwired';

  return {
    kind: SIDECAR_PACKAGING_KIND,
    state,
    triple: presence.triple,
    expectedPath: presence.expectedPath,
    declared: agreement.declared,
    vendored: agreement.vendored,
    detail: state === 'missing'
      ? presence.detail
      : state === 'ready'
        ? 'A binary is vendored for ' + (presence.triple || 'this target') + ' and tauri.bundle.externalBin declares it. A desktop build would include it.'
        : 'A binary is vendored for ' + (presence.triple || 'this target') + ' but tauri.bundle.externalBin does not (yet) declare it, or the packaging check found a mismatch. Add "' + EXTERNAL_BIN_ENTRY + '" to tauri.bundle.externalBin and flip bundledInThisBuild in js/ai/desktop-local-llm.js in the same change.',
    agreementProblems: agreement.problems,
    note: NO_WEIGHTS_IN_GIT,
  };
}

export const DataGlowLlamaSidecarPackaging = {
  SIDECAR_PACKAGING_KIND,
  SIDECAR_PACKAGING_VERSION,
  SIDECAR_BASENAME,
  SIDECAR_DIR,
  EXTERNAL_BIN_ENTRY,
  TARGET_TRIPLES,
  NO_WEIGHTS_IN_GIT,
  SIDECAR_FETCH_STATES,
  sidecarFileName,
  expectedSidecarPaths,
  sidecarPresence,
  checkPackagingAgreement,
  fetchSidecarStatus,
  describePackagingPath,
};

try {
  if (typeof window !== 'undefined') window.DataGlowLlamaSidecarPackaging = DataGlowLlamaSidecarPackaging;
} catch (_e) {}
