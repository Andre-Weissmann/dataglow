// ============================================================
// DATAGLOW - Desktop local LLM path (llama.cpp sidecar)
// ============================================================
//
// The browser model runs on WebGPU, which caps what it can be. A 1.5B model at
// 4-bit is what fits in a tab that also has DuckDB and a spreadsheet in it, and
// on a machine with no WebGPU there is no model at all. The desktop build has
// no such ceiling: a llama.cpp server process can use the whole GPU, or the
// whole CPU, and can run a model several times larger.
//
// So the desktop upgrade path is real and worth building. What it must not do
// is be announced before it exists.
//
// WHY THE SIDECAR IS NOT BUNDLED IN THIS BUILD.
// A llama.cpp binary is platform-specific and tens of megabytes per target, and
// Tauri's `externalBin` requires the binary to be present at bundle time for
// every target triple being built. Naming one in `tauri.conf.json` without
// shipping it does not produce a desktop app with a missing feature, it produces
// a desktop build that fails. So `externalBin` stays an empty array, this module
// reports `sidecar_missing` honestly, and `describeSidecarScaffold()` writes down
// the exact configuration to add on the day the binary is vendored. Complete
// path, no fake ready.
//
// WHY `unavailable_web` IS A STATE AND NOT AN ERROR.
// Most people run this in a browser, where a sidecar cannot exist by
// definition. That is the normal case, not a fault, and telling a browser user
// their sidecar is missing would be describing the absence of something they
// never could have had.
//
// Pure. No imports, no process spawning, no Tauri call. The caller observes the
// environment and hands the observation in.

export const DESKTOP_LLM_KIND = 'dataglow-desktop-local-llm';
export const DESKTOP_LLM_VERSION = 1;

export const DESKTOP_LLM_STATES = Object.freeze([
  'unavailable_web',
  'sidecar_missing',
  'ready',
  'error',
]);

export const SIDECAR_NAME = 'llama-server';

export const DESKTOP_UPGRADE_PITCH =
  'The desktop build can run a larger model than a browser tab can. It talks to a llama.cpp server running on this machine over the loopback interface, so nothing leaves the machine there either.';

export const NOT_BUNDLED_NOTE =
  'This build does not bundle a llama.cpp binary. The code path is complete and the desktop app will use the server the moment one is present, but nothing here downloads or installs it for you.';

const STATE_LABEL = Object.freeze({
  unavailable_web: 'Desktop model: not applicable in a browser',
  sidecar_missing: 'Desktop model: llama.cpp not bundled in this build',
  ready: 'Desktop model: llama.cpp server available',
  error: 'Desktop model: the local server reported a problem',
});

const STATE_DETAIL = Object.freeze({
  unavailable_web:
    'A sidecar process is a desktop concept. In a browser the built-in model is the WebGPU one, and that is the whole story here.',
  sidecar_missing:
    'The desktop shell is running but no llama.cpp server was found beside it. The browser-grade built-in model still works; the larger local model does not.',
  ready:
    'A llama.cpp server is reachable on the loopback interface. Prompts go to a process on this machine and no request leaves it.',
  error:
    'The desktop shell found a server and could not use it. The built-in WebGPU model remains available, so nothing is blocked by this.',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {{isTauri?:boolean, sidecarPresent?:boolean, modelPath?:string, error?:string}} [input]
 */
export function buildDesktopLlmStatus(input) {
  const inp = isPlainObject(input) ? input : {};
  const isTauri = inp.isTauri === true;
  const sidecarPresent = inp.sidecarPresent === true;
  const modelPath = str(inp.modelPath);
  const error = str(inp.error);

  // Precedence. A browser has no sidecar and cannot have one, so that answer
  // comes first and no later condition can override it. An error only means
  // something when the desktop shell is the one reporting it, which is why a
  // stray error string cannot make a browser look broken.
  let state;
  if (!isTauri) state = 'unavailable_web';
  else if (error) state = 'error';
  else if (!sidecarPresent) state = 'sidecar_missing';
  else state = 'ready';

  return {
    kind: DESKTOP_LLM_KIND,
    version: DESKTOP_LLM_VERSION,
    state,
    label: STATE_LABEL[state],
    detail: state === 'error' && error ? STATE_DETAIL.error + ' Reported: ' + error : STATE_DETAIL[state],
    usable: state === 'ready',
    sidecarName: SIDECAR_NAME,
    modelPath: state === 'ready' ? modelPath : '',
    bundledInThisBuild: false,
    note: NOT_BUNDLED_NOTE,
    upgradePitch: DESKTOP_UPGRADE_PITCH,
    // The browser model is never taken away by any of this. Whatever the
    // desktop path is doing, the WebGPU path is the floor.
    fallsBackTo: 'The built-in WebGPU model, which is unaffected by any state here.',
    observed: { isTauri, sidecarPresent, hasModelPath: !!modelPath, hasError: !!error },
  };
}

/**
 * The exact configuration change that turns this path on, written down so the
 * work left to do is a diff rather than an investigation.
 *
 * Returned as data rather than prose so a test can assert that the empty
 * `externalBin` in the shipped Tauri config still matches what this describes.
 */
export function describeSidecarScaffold() {
  return {
    kind: DESKTOP_LLM_KIND,
    configFile: 'src-tauri/tauri.conf.json',
    configPath: 'tauri.bundle.externalBin',
    currentValue: [],
    valueWhenShipped: ['bin/' + SIDECAR_NAME],
    whyEmptyToday:
      'Tauri resolves each externalBin entry to a file named for the target triple at bundle time. An entry with no binary behind it fails the build for every platform, so the slot stays empty until a binary is vendored.',
    steps: Object.freeze([
      'Vendor a llama.cpp server binary per target triple as src-tauri/bin/' + SIDECAR_NAME + '-<triple>.',
      'Add "bin/' + SIDECAR_NAME + '" to tauri.bundle.externalBin.',
      'Allow the shell scope for that one sidecar in the Tauri allowlist, and nothing else.',
      'Start it bound to the loopback interface on a port chosen at launch, never a fixed public one.',
      'Pass sidecarPresent to buildDesktopLlmStatus from the real handshake, not from the config.',
    ]),
    boundary:
      'The server binds to loopback only. There is no remote inference mode here and there is no setting that adds one.',
    note: NOT_BUNDLED_NOTE,
  };
}

/** One line for a status row. */
export function desktopLlmChipLabel(status) {
  if (!isPlainObject(status)) return STATE_LABEL.unavailable_web;
  return STATE_LABEL[status.state] || STATE_LABEL.unavailable_web;
}

export const DataGlowDesktopLocalLlm = {
  DESKTOP_LLM_KIND,
  DESKTOP_LLM_VERSION,
  DESKTOP_LLM_STATES,
  SIDECAR_NAME,
  DESKTOP_UPGRADE_PITCH,
  NOT_BUNDLED_NOTE,
  buildDesktopLlmStatus,
  describeSidecarScaffold,
  desktopLlmChipLabel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowDesktopLocalLlm = DataGlowDesktopLocalLlm;
} catch (_e) {}
