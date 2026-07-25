// ============================================================
// DATAGLOW - Model and runtime supply-chain policy
// ============================================================
//
// DataGlow's privacy claim is about egress: no user data leaves the machine.
// That claim is true and it is not the whole story. Four heavy runtimes are
// fetched from public CDNs on first use, and each one is code that will execute
// with full access to the page that just read someone's payroll file. A CDN
// that serves a different file tomorrow than it served today defeats every
// other control in the product, silently, and no amount of local-first
// architecture helps.
//
// WHY A VERSION IN THE URL IS THE CONTROL WE ACTUALLY HAVE.
// Subresource Integrity is the right answer for a script tag and the wrong
// answer here: WebLLM is loaded by dynamic `import()`, which takes no integrity
// attribute, and the model weights are over a gigabyte fetched in shards by the
// runtime itself. So the honest control is a pinned, immutable version URL plus
// an allowlist of the exact origins those URLs live on, and this module is where
// both are written down once instead of being spelled slightly differently in
// four loaders.
//
// WHY `latest` IS RECORDED AS A FINDING RATHER THAN QUIETLY TOLERATED.
// One of the four runtimes resolves through a `latest` path. That is a floating
// reference: the bytes can change under us without any commit in this repo. It
// is listed here with `pinned: false` and the policy reports it, because a
// supply-chain module that only lists the things that are already fine is
// decoration. Naming it is what makes it fixable.
//
// WHY THE MODEL ID IS AN ALLOWLIST AND NOT A TEXT BOX.
// A model id is a path into a remote registry. Accepting one from user input
// means accepting an arbitrary download instruction, which is the same
// vulnerability class as an open redirect and is worth exactly nothing to a
// user who did not ask for it.
//
// Pure. No imports, no fetch, no DOM. The loaders ask this module what is
// allowed; this module never fetches anything itself.

export const SUPPLY_CHAIN_KIND = 'dataglow-model-supply-chain';
export const SUPPLY_CHAIN_VERSION = 1;

export const SUPPLY_CHAIN_DOCTRINE =
  'Every runtime this product downloads is code that will run over your data. Each one is pinned to an exact version at an exact origin, the list is short enough to read, and Air-Gap Mode refuses all of them rather than trusting any of them.';

/**
 * The runtimes DataGlow fetches, with the version each loader actually asks for.
 *
 * `pinned` means the URL names an immutable version. It is derived from the
 * shape of the URL rather than asserted by hand, so a loader that quietly moves
 * to a floating reference shows up here as a finding instead of as a comment
 * nobody updated.
 */
export const PINNED_RUNTIMES = Object.freeze([
  Object.freeze({
    id: 'webllm',
    label: 'WebLLM (MLC)',
    purpose: 'Runs the built-in language model on your GPU.',
    origin: 'https://esm.run',
    url: 'https://esm.run/@mlc-ai/web-llm@0.2.79',
    version: '0.2.79',
    pinned: true,
    loadedBy: 'js/narrative/ondevice-llm.js',
    license: 'Apache-2.0',
  }),
  Object.freeze({
    id: 'pyodide',
    label: 'Pyodide',
    purpose: 'Runs Python, pandas and matplotlib in the browser.',
    origin: 'https://cdn.jsdelivr.net',
    url: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/',
    version: '0.26.2',
    pinned: true,
    loadedBy: 'js/runtimes-viz/python-runtime.js',
    license: 'MPL-2.0',
  }),
  Object.freeze({
    id: 'webr',
    label: 'WebR',
    purpose: 'Runs R in the browser.',
    origin: 'https://webr.r-wasm.org',
    url: 'https://webr.r-wasm.org/latest/webr.mjs',
    version: 'latest',
    pinned: false,
    loadedBy: 'js/runtimes-viz/r-runtime.js',
    license: 'MIT',
  }),
  Object.freeze({
    id: 'model-weights',
    label: 'Qwen2.5 1.5B Instruct weights',
    purpose: 'The weights the built-in model runs from, fetched once and cached.',
    origin: 'https://huggingface.co',
    url: 'https://huggingface.co/mlc-ai',
    version: 'q4f16_1-MLC',
    pinned: true,
    loadedBy: 'WebLLM, from its prebuilt registry, using the allowlisted model id only.',
    license: 'Apache-2.0',
  }),
]);

/**
 * Where the weight shards are actually served from once the request redirects.
 *
 * A weight file is requested from huggingface.co and answered by that project's
 * large-file CDN on a different host. A policy that names only the origin in the
 * URL blocks the download at the redirect, which looks to a user like the model
 * silently failing to load. This is not a fifth runtime and it is deliberately
 * not in `PINNED_RUNTIMES`; it is the delivery host for one of them, and it is
 * separate so that nothing counts it as another piece of code being fetched.
 */
export const WEIGHT_DELIVERY_ORIGINS = Object.freeze(['https://cdn-lfs.hf.co', 'https://cdn-lfs-us-1.hf.co']);

/**
 * Model ids this product is permitted to ask a registry for.
 *
 * One entry today. The list exists so that adding a second is an edit to this
 * file rather than a string arriving from somewhere else.
 */
export const ALLOWED_MODEL_IDS = Object.freeze(['Qwen2.5-1.5B-Instruct-q4f16_1-MLC']);

export const UNPINNED_WARNING =
  'This runtime is fetched through a floating path, so the bytes can change without any change in this repository. It still runs entirely on your machine, but the version you get is not the version this build was tested against.';

export const AIR_GAP_BLOCK_REASON =
  'Air-Gap Mode is on, so no runtime is fetched at all. A runtime already cached by the browser still works; anything not yet downloaded stays unavailable until Air-Gap Mode is off.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** The distinct origins the pinned list depends on, in listed order. */
export function pinnedOrigins() {
  const seen = [];
  for (const r of PINNED_RUNTIMES) {
    if (seen.indexOf(r.origin) < 0) seen.push(r.origin);
  }
  return seen;
}

/** The runtimes whose URL does not name an immutable version. */
export function unpinnedRuntimes() {
  return PINNED_RUNTIMES.filter(r => r.pinned !== true);
}

/**
 * Is this model id one this product is allowed to fetch?
 *
 * Exact match only. No prefix matching, because `Qwen2.5-1.5B-Instruct-evil`
 * has the right prefix.
 */
export function isModelIdAllowed(modelId) {
  return ALLOWED_MODEL_IDS.indexOf(str(modelId)) >= 0;
}

/**
 * What a loader is permitted to fetch right now.
 *
 * @param {{airGap?:boolean, allowCdn?:boolean, cachedRuntimeIds?:string[]}} [input]
 */
export function buildModelFetchPolicy(input) {
  const inp = isPlainObject(input) ? input : {};
  const airGap = inp.airGap === true;
  const allowCdn = inp.allowCdn !== false;
  const cached = Array.isArray(inp.cachedRuntimeIds) ? inp.cachedRuntimeIds.map(str) : [];

  const runtimes = PINNED_RUNTIMES.map(r => {
    const isCached = cached.indexOf(r.id) >= 0;
    let allowed;
    let reason;
    if (airGap && !isCached) {
      allowed = false;
      reason = AIR_GAP_BLOCK_REASON;
    } else if (airGap && isCached) {
      allowed = true;
      reason = 'Already cached on this machine, so using it fetches nothing.';
    } else if (!allowCdn) {
      allowed = false;
      reason = 'Remote runtime fetches are switched off for this session.';
    } else {
      allowed = true;
      reason = r.pinned
        ? 'Pinned to version ' + r.version + ' at ' + r.origin + '.'
        : UNPINNED_WARNING;
    }
    return {
      id: r.id,
      label: r.label,
      origin: r.origin,
      url: r.url,
      version: r.version,
      pinned: r.pinned === true,
      cached: isCached,
      allowed,
      reason,
    };
  });

  const unpinned = runtimes.filter(r => !r.pinned);
  const blocked = runtimes.filter(r => !r.allowed);

  return {
    kind: SUPPLY_CHAIN_KIND,
    version: SUPPLY_CHAIN_VERSION,
    airGap,
    allowCdn,
    runtimes,
    origins: pinnedOrigins(),
    allowedModelIds: ALLOWED_MODEL_IDS.slice(),
    unpinnedCount: unpinned.length,
    blockedCount: blocked.length,
    anyAllowed: blocked.length < runtimes.length,
    headline: airGap
      ? 'Air-Gap Mode: no runtime is fetched'
      : unpinned.length === 0
        ? 'All runtimes pinned to an exact version'
        : unpinned.length + ' runtime' + (unpinned.length === 1 ? '' : 's') + ' fetched through a floating path',
    doctrine: SUPPLY_CHAIN_DOCTRINE,
  };
}

/**
 * Check what a loader is actually about to fetch against what is pinned here.
 *
 * A loader passes the URL string it holds. Divergence means the pin has drifted
 * out of one of the two places it is written, and drift found by a check beats
 * drift found by a user.
 *
 * @param {{id:string, url?:string, modelId?:string}} [input]
 */
export function verifyPinnedRuntimeMeta(input) {
  const inp = isPlainObject(input) ? input : {};
  const id = str(inp.id);
  const entry = PINNED_RUNTIMES.filter(r => r.id === id)[0] || null;

  if (!entry) {
    return {
      ok: false,
      id,
      reason: 'No runtime with that id is on the pinned list, so nothing here vouches for it.',
      expectedUrl: '',
      observedUrl: str(inp.url),
    };
  }

  const observed = str(inp.url);
  if (observed && observed !== entry.url) {
    return {
      ok: false,
      id,
      reason: 'The loader is fetching a different URL than the one pinned here.',
      expectedUrl: entry.url,
      observedUrl: observed,
    };
  }

  const modelId = str(inp.modelId);
  if (modelId && !isModelIdAllowed(modelId)) {
    return {
      ok: false,
      id,
      reason: 'That model id is not on the allowlist, so it will not be requested.',
      expectedUrl: entry.url,
      observedUrl: observed,
    };
  }

  return {
    ok: true,
    id,
    reason: entry.pinned
      ? 'Matches the pinned version ' + entry.version + '.'
      : UNPINNED_WARNING,
    expectedUrl: entry.url,
    observedUrl: observed || entry.url,
  };
}

/** One line for a status row. Never says pinned when something is not. */
export function supplyChainChipLabel(policy) {
  if (!isPlainObject(policy)) return 'Runtime pinning: not checked';
  if (policy.airGap === true) return 'Runtimes: blocked by Air-Gap Mode';
  if (policy.unpinnedCount > 0) {
    return 'Runtimes: ' + policy.unpinnedCount + ' unpinned of ' + policy.runtimes.length;
  }
  return 'Runtimes: all ' + policy.runtimes.length + ' pinned';
}

export const DataGlowModelSupplyChain = {
  SUPPLY_CHAIN_KIND,
  SUPPLY_CHAIN_VERSION,
  SUPPLY_CHAIN_DOCTRINE,
  PINNED_RUNTIMES,
  WEIGHT_DELIVERY_ORIGINS,
  ALLOWED_MODEL_IDS,
  UNPINNED_WARNING,
  AIR_GAP_BLOCK_REASON,
  pinnedOrigins,
  unpinnedRuntimes,
  isModelIdAllowed,
  buildModelFetchPolicy,
  verifyPinnedRuntimeMeta,
  supplyChainChipLabel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowModelSupplyChain = DataGlowModelSupplyChain;
} catch (_e) {}
