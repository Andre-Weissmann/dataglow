// ============================================================
// DATAGLOW - Built-in AI status and local model registry
// ============================================================
//
// DataGlow has had a local model running in the browser for a long time and
// almost nobody could tell. There was no place on the page that said so, which
// means the single most differentiating thing about the product was invisible
// unless you opened a panel and got lucky. This module exists so a status can
// be shown continuously, and so that status is computed rather than asserted.
//
// WHY THE STATE IS DERIVED AND NOT STORED.
// "Built-in AI: ready" is a claim about this machine at this moment, and it is
// wrong the instant WebGPU is missing, or Air-Gap Mode is on with nothing
// cached, or the model has simply not been downloaded yet. A stored boolean
// drifts from the truth silently. So the state is a function of four observed
// facts and nothing else, and every state carries the reason it is in that
// state, because a chip that says "not available" without saying why sends the
// user to a support page that does not exist.
//
// WHY `rule_only` IS A FIRST-CLASS STATE AND NOT A FAILURE.
// Most of what DataGlow calls AI is not the model. Validation, profiling, the
// readiness gate, the repair recipes and the deterministic tier of the Copilot
// are all rules, and they run everywhere with no download and no GPU. Treating
// "no model" as a broken state would be a lie in the unhelpful direction: it
// would tell a person on a machine without WebGPU that the product does not
// work for them, when in fact almost all of it does. So `rule_only` says what
// still works, and `canUseBuiltInAi` is false only for the generative tier.
//
// WHY THE REGISTRY LISTS MODELS THAT ARE NOT SHIPPED.
// A registry with one entry is not a registry, it is a constant wearing a
// costume. The honest thing is to name the alternatives that were considered
// with what is actually true about each: what it would cost to download, what
// licence it carries, and whether it runs in a browser tab at all. Every entry
// carries a `fit` that is `shipped` for exactly one model and something honest
// for the rest, so nobody reads the list as a menu of things they can pick
// today.
//
// Pure. No DOM, no network, no model loading. The canvas surface observes the
// four facts and calls in; this module never touches navigator.gpu itself,
// because a module that probes the machine cannot be tested on a machine that
// does not have one.

export const LOCAL_AI_STATUS_KIND = 'dataglow-local-ai-status';
export const LOCAL_AI_STATUS_VERSION = 1;

/** The model actually shipped today. Kept in step with js/narrative/ondevice-llm.js
 *  by a test rather than by hope: test/local-ai-ambient.test.mjs reads MODEL_ID
 *  out of that module and fails if these two ever disagree. */
export const SHIPPED_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
export const SHIPPED_MODEL_LABEL = 'Qwen2.5 1.5B Instruct (4-bit, ~1.1 GB)';

export const LOCAL_AI_STATES = Object.freeze([
  'ready',
  'available',
  'loading',
  'blocked_airgap',
  'no_webgpu',
  'rule_only',
]);

/** What the built-in AI is for, in the order a person meets it. Deliberately
 *  three verbs and not a feature list: the point is the division of labour. */
export const WHAT_BUILT_IN_AI_DOES = Object.freeze([
  Object.freeze({
    id: 'propose',
    title: 'It proposes',
    body: 'It suggests a query, a repair or a way to phrase a finding. A suggestion is a starting point and it is never applied on its own.',
  }),
  Object.freeze({
    id: 'explain',
    title: 'It explains',
    body: 'It puts a readiness grade, a validation result or a drift warning into plain sentences. The grade itself is computed by a rule, not by the model.',
  }),
  Object.freeze({
    id: 'draft',
    title: 'It drafts',
    body: 'It writes the prose around numbers that already exist. Every number in that prose is checked against the Proof Board before it can leave.',
  }),
]);

export const AI_DIVISION_OF_LABOUR =
  'AI proposes, engines adjudicate, a human confirms. The model never decides whether a number is right and it never sends anything anywhere.';

export const NOT_A_CERTIFICATION_NOTE =
  'A local model is a privacy property, not a compliance one. Running on this machine means the data did not leave it. It does not make any output certified, audited or safe to release.';

const DETAIL = Object.freeze({
  ready:
    'The model is downloaded and loaded in this tab. Prompts and data stay on this machine, and no request goes out when it runs.',
  available:
    'This machine can run the built-in model, but it has not been downloaded yet. The download is about a gigabyte and it only happens when you ask for it.',
  loading:
    'The model is downloading or warming up. Nothing is blocked while this happens, and every rule-based feature keeps working.',
  blocked_airgap:
    'Air-Gap Mode is on and the model is not already cached, so fetching it would mean a network request. Air-Gap Mode wins: nothing is downloaded.',
  no_webgpu:
    'This browser does not expose WebGPU, so the generative tier cannot run here. Everything computed by rules still runs, and it runs at full strength.',
  rule_only:
    'The generative tier is off. Validation, profiling, the readiness gate and the repair recipes are all rules and they need no model at all.',
});

const HEADLINE = Object.freeze({
  ready: 'Built-in AI: on-device, ready',
  available: 'Built-in AI: on-device, not downloaded',
  loading: 'Built-in AI: loading on this machine',
  blocked_airgap: 'Built-in AI: blocked by Air-Gap, model not cached',
  no_webgpu: 'Built-in AI: rule-based, no WebGPU here',
  rule_only: 'Built-in AI: rule-based',
});

/** What a person can actually do from each state. Empty when there is nothing
 *  honest to offer, rather than a button that cannot help. */
const NEXT_STEP = Object.freeze({
  ready: '',
  available: 'Load the model when you want the generative tier. It is a one-time download and it is cached afterwards.',
  loading: 'Nothing to do. Carry on working while it finishes.',
  blocked_airgap: 'Turn off Air-Gap Mode if you want to download the model, or keep Air-Gap Mode and stay on the rule-based tier.',
  no_webgpu: 'Try a browser with WebGPU, or use the desktop build. Neither is required for the rule-based tier.',
  rule_only: '',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Derive the state from what is actually true about this machine.
 *
 * The order of the checks is the point. Air-Gap outranks capability, because a
 * machine that could download the model must not be told it can when the whole
 * posture of the session is that nothing goes out. Capability outranks
 * loadedness, because a loaded flag on a machine with no WebGPU is a stale flag
 * and trusting it would put a ready chip on a page that cannot generate a word.
 */
export function buildLocalAiStatus(input) {
  const inp = isPlainObject(input) ? input : {};
  const webgpu = inp.webgpu === true;
  const modelLoaded = inp.modelLoaded === true;
  const loading = inp.loading === true;
  const airGap = inp.airGap === true;
  const modelCached = inp.modelCached === true;
  const enabled = inp.enabled !== false;

  const modelId = str(inp.modelId) || SHIPPED_MODEL_ID;
  const modelLabel = str(inp.modelLabel) || SHIPPED_MODEL_LABEL;
  const platform = str(inp.platform) || 'web';

  let state;
  if (!enabled) {
    state = 'rule_only';
  } else if (!webgpu) {
    state = 'no_webgpu';
  } else if (modelLoaded) {
    // Loaded beats Air-Gap: the model is already here, so running it sends
    // nothing. Air-Gap only ever objects to the download.
    state = 'ready';
  } else if (airGap && !modelCached) {
    state = 'blocked_airgap';
  } else if (loading) {
    state = 'loading';
  } else {
    state = 'available';
  }

  return {
    kind: LOCAL_AI_STATUS_KIND,
    version: LOCAL_AI_STATUS_VERSION,
    state,
    headline: HEADLINE[state],
    detail: DETAIL[state],
    nextStep: NEXT_STEP[state],
    canUseBuiltInAi: state === 'ready',
    ruleTierAvailable: true,
    onDevice: true,
    sendsNothing: true,
    modelId,
    modelLabel,
    platform,
    observed: { webgpu, modelLoaded, loading, airGap, modelCached, enabled },
    note: NOT_A_CERTIFICATION_NOTE,
  };
}

/** One short line for a chip that has no room for the detail. */
export function statusChipLabel(status) {
  if (!isPlainObject(status)) return HEADLINE.rule_only;
  return HEADLINE[status.state] || HEADLINE.rule_only;
}

/**
 * The models considered for the in-browser generative tier, as of July 2026.
 *
 * `fit` is the honest field. Exactly one entry is `shipped`. The rest say what
 * is actually in the way, so the list reads as a record of a decision rather
 * than as a set of options waiting behind a switch.
 */
export function listRecommendedLocalModels() {
  return [
    {
      id: SHIPPED_MODEL_ID,
      label: SHIPPED_MODEL_LABEL,
      family: 'Qwen2.5',
      params: '1.5B',
      quantization: '4-bit (q4f16_1, MLC)',
      sizeHint: 'about 1.1 GB once downloaded',
      license: 'Apache-2.0',
      runtime: 'WebLLM / WebGPU',
      platforms: {
        web: 'Runs in a browser tab that exposes WebGPU.',
        desktop: 'Runs in the desktop build with the same WebGPU path.',
        mobile: 'Usually too large for a phone browser tab. Treat as unavailable there.',
      },
      fit: 'shipped',
      why: 'Small enough that the download is a decision a person can live with, permissive enough to ship, and good enough at rephrasing a sentence it was handed. It is not asked to compute anything.',
    },
    {
      id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
      label: 'Qwen2.5 Coder 3B Instruct (4-bit)',
      family: 'Qwen2.5-Coder',
      params: '3B',
      quantization: '4-bit (q4f16_1, MLC)',
      sizeHint: 'about 2.1 GB once downloaded',
      license: 'Apache-2.0',
      runtime: 'WebLLM / WebGPU',
      platforms: {
        web: 'Runs where WebGPU is present and there is memory headroom.',
        desktop: 'Comfortable on the desktop build.',
        mobile: 'No.',
      },
      fit: 'candidate',
      why: 'Better at SQL than the shipped model, but it roughly doubles a download that is already the largest thing DataGlow ever asks for. Held as a candidate for the desktop build rather than made the default for everyone.',
    },
    {
      id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      label: 'Llama 3.2 1B Instruct (4-bit)',
      family: 'Llama 3.2',
      params: '1B',
      quantization: '4-bit (q4f16_1, MLC)',
      sizeHint: 'about 0.8 GB once downloaded',
      license: 'Llama 3.2 Community License (not OSI-approved)',
      runtime: 'WebLLM / WebGPU',
      platforms: {
        web: 'Runs where WebGPU is present.',
        desktop: 'Runs.',
        mobile: 'Borderline. Not relied on.',
      },
      fit: 'candidate',
      why: 'The smallest credible option, which matters because download size is the real barrier. The licence is a community licence with use restrictions rather than Apache-2.0, so it is not the default in a tool people ship work from.',
    },
    {
      id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
      label: 'Phi-3.5 mini Instruct (4-bit)',
      family: 'Phi-3.5',
      params: '3.8B',
      quantization: '4-bit (q4f16_1, MLC)',
      sizeHint: 'about 2.4 GB once downloaded',
      license: 'MIT',
      runtime: 'WebLLM / WebGPU',
      platforms: {
        web: 'Needs real memory headroom in the tab.',
        desktop: 'Reasonable on the desktop build.',
        mobile: 'No.',
      },
      fit: 'desktop_only',
      why: 'Strong for its size and cleanly licensed, but the download and the memory footprint are past what a browser tab should ask of someone who just wanted to clean a spreadsheet.',
    },
    {
      id: 'whisper-base-q4',
      label: 'Whisper base (4-bit) for on-device speech',
      family: 'Whisper',
      params: '74M',
      quantization: '4-bit',
      sizeHint: 'about 75 MB once downloaded',
      license: 'MIT',
      runtime: 'Transformers.js / WebGPU',
      platforms: {
        web: 'Feasible in a tab.',
        desktop: 'Feasible.',
        mobile: 'Feasible in principle.',
      },
      fit: 'not_yet',
      why: 'Would let a person ask a column what is wrong out loud with no cloud speech service. Scaffolded in js/audio/ and not wired to anything, so it is listed here as not yet rather than as a feature.',
    },
  ];
}

/** The shipped entry, for a surface that wants to name it without filtering. */
export function shippedModel() {
  return listRecommendedLocalModels().find(m => m.fit === 'shipped') || null;
}

export const DataGlowLocalAiStatus = {
  LOCAL_AI_STATUS_KIND,
  LOCAL_AI_STATUS_VERSION,
  SHIPPED_MODEL_ID,
  SHIPPED_MODEL_LABEL,
  LOCAL_AI_STATES,
  WHAT_BUILT_IN_AI_DOES,
  AI_DIVISION_OF_LABOUR,
  NOT_A_CERTIFICATION_NOTE,
  buildLocalAiStatus,
  statusChipLabel,
  listRecommendedLocalModels,
  shippedModel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowLocalAiStatus = DataGlowLocalAiStatus;
} catch (_e) {}
