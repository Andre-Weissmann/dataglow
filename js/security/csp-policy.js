// ============================================================
// DATAGLOW - Content Security Policy, derived rather than typed
// ============================================================
//
// A CSP is a list of the places code and data are allowed to come from. It is
// the one control that still works after something else has gone wrong: if an
// injected string tries to reach an attacker's host, the policy is what refuses.
// For a product whose entire promise is that nothing leaves the machine, a
// `connect-src` naming four origins and nothing else is close to being the
// promise written in a form the browser enforces.
//
// WHY THIS IS COMPUTED FROM THE PIN LIST INSTEAD OF WRITTEN OUT.
// The desktop shell has carried a hand-written CSP for a while, and it has
// already drifted: it allows two CDNs, neither of which is where the language
// model runtime or the R runtime actually come from. So on desktop, today, the
// policy silently blocks two features the product advertises. That is what a
// hand-maintained duplicate of a list always does eventually. Here the origins
// come from `PINNED_RUNTIMES`, so adding a runtime updates the policy by
// construction and a test can assert the two never diverge again.
//
// WHY THE POLICY IS NOT AS TIGHT AS A POLICY CAN BE.
// Three unsafe-looking directives are load-bearing and are kept deliberately:
//
//   'unsafe-inline' for scripts - the shipped artifact is one HTML file whose
//     application code is inline. Removing this removes the product.
//   'unsafe-eval' - DuckDB compiled to WebAssembly instantiates its module
//     through a path this directive covers, and the narrower
//     'wasm-unsafe-eval' is not honoured everywhere the app has to run.
//   blob: in script-src and worker-src - DuckDB and Pyodide both start workers
//     from blob URLs they build at runtime.
//
// Writing a policy that omits these produces a document that scores better and
// does not work. Each one is listed in `CSP_RESIDUALS` with what it costs, so
// the gap is a recorded decision rather than an oversight.
//
// Pure. Builds strings. Never installs anything and never touches the DOM.

import { pinnedOrigins, WEIGHT_DELIVERY_ORIGINS } from '../ai/model-supply-chain.js';

export const CSP_POLICY_KIND = 'dataglow-csp-policy';
export const CSP_POLICY_VERSION = 1;

export const CSP_DOCTRINE =
  'The policy names every origin this product is allowed to reach and refuses the rest. Its connect-src is the egress promise in a form the browser enforces rather than a form the marketing page asserts.';

/**
 * Why each directive reads the way it does.
 *
 * Kept next to the policy because a CSP with no rationale gets loosened by the
 * first person who hits a console error, and a CSP that has been loosened once
 * for an unrecorded reason gets loosened again.
 */
export const CSP_DIRECTIVE_NOTES = Object.freeze([
  Object.freeze({
    directive: 'default-src',
    why: "Everything not named below falls back to this machine only.",
  }),
  Object.freeze({
    directive: 'connect-src',
    why: 'The egress list. Only the pinned runtime origins, plus this machine, blobs and data URLs. There is no analytics host and no API host, because there is no analytics and no API.',
  }),
  Object.freeze({
    directive: 'script-src',
    why: "Inline is required because the shipped artifact is a single HTML file. eval and blob are required by DuckDB and by the worker-based runtimes.",
  }),
  Object.freeze({
    directive: 'worker-src',
    why: 'DuckDB and Pyodide start workers from blob URLs they construct at runtime.',
  }),
  Object.freeze({
    directive: 'form-action',
    why: "Set to 'none'. The product has no form that submits anywhere, so any submission is someone else's idea.",
  }),
  Object.freeze({
    directive: 'frame-ancestors',
    why: "Set to 'none'. Nothing should be able to embed a page that has a user's spreadsheet open in it.",
  }),
  Object.freeze({
    directive: 'object-src',
    why: "Set to 'none'. No plugins, ever.",
  }),
]);

/**
 * The gaps, named. Each is a real weakening with a real reason.
 */
export const CSP_RESIDUALS = Object.freeze([
  Object.freeze({
    id: 'unsafe-inline',
    cost: 'An injected inline script would not be blocked by the policy.',
    why: 'The shipped artifact is one HTML file with its application code inline. Removing this directive removes the application.',
    fix: 'A hash or nonce per inline block, which needs a build step the single-file ship path does not have.',
  }),
  Object.freeze({
    id: 'unsafe-eval',
    cost: 'Code built from a string at runtime is not blocked.',
    why: "DuckDB's WebAssembly startup path needs it, and the narrower wasm-unsafe-eval is not honoured in every browser this has to run in.",
    fix: "Move to wasm-unsafe-eval alone once the browser floor allows it.",
  }),
  Object.freeze({
    id: 'cdn-origins',
    cost: 'Three public CDN origins can serve script to this page.',
    why: 'The Python, R and model runtimes are megabytes each and are fetched on first use rather than bundled.',
    fix: 'Vendor them into the repository, which trades the CDN risk for a much larger artifact and a manual update burden.',
  }),
]);

/**
 * The webfont origins, which are not runtimes and so are not in the pin list.
 *
 * They are named here rather than derived because they serve stylesheets and
 * font files, never script, and they get their own directives. Under Air-Gap
 * they are dropped along with everything else: a font request is still a
 * request, and the local fallback stack renders the product perfectly well.
 */
export const STYLE_ORIGINS = Object.freeze(['https://fonts.googleapis.com']);
export const FONT_ORIGINS = Object.freeze(['https://fonts.gstatic.com']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function joinSources(list) {
  return list.filter(Boolean).join(' ');
}

/**
 * Build the policy.
 *
 * @param {{platform?:string, airGap?:boolean}} [input]
 * @returns {{policy:string, directives:Array, airGap:boolean, platform:string}}
 */
export function recommendedCspPolicy(input) {
  const inp = isPlainObject(input) ? input : {};
  const platform = inp.platform === 'desktop' ? 'desktop' : 'web';
  const airGap = inp.airGap === true;

  // Under Air-Gap Mode the runtime origins are not merely unused, they are
  // refused. Dropping them from connect-src makes the browser enforce what the
  // mode already promises instead of relying on our own code to be careful.
  const runtimeOrigins = airGap ? [] : pinnedOrigins();
  const styleOrigins = airGap ? [] : STYLE_ORIGINS.slice();
  const fontOrigins = airGap ? [] : FONT_ORIGINS.slice();
  const deliveryOrigins = airGap ? [] : WEIGHT_DELIVERY_ORIGINS.slice();

  const directives = [
    ['default-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['script-src', ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:'].concat(runtimeOrigins)],
    ['worker-src', ["'self'", 'blob:']],
    ['child-src', ["'self'", 'blob:']],
    ['style-src', ["'self'", "'unsafe-inline'"].concat(styleOrigins)],
    ['font-src', ["'self'", 'data:'].concat(fontOrigins)],
    ['img-src', ["'self'", 'data:', 'blob:']],
    // connect-src carries the weight-delivery hosts as well, because the weight
    // request redirects off the origin in its URL and a policy that stops at the
    // redirect looks exactly like the model failing to download for no reason.
    ['connect-src', ["'self'", 'blob:', 'data:'].concat(runtimeOrigins, deliveryOrigins)],
    ['media-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'none'"]],
  ];

  const policy = directives
    .map(d => d[0] + ' ' + joinSources(d[1]))
    .join('; ') + ';';

  return {
    kind: CSP_POLICY_KIND,
    version: CSP_POLICY_VERSION,
    platform,
    airGap,
    policy,
    directives: directives.map(d => ({ directive: d[0], sources: d[1].slice() })),
    origins: runtimeOrigins.slice(),
    notes: CSP_DIRECTIVE_NOTES,
    residuals: CSP_RESIDUALS,
    doctrine: CSP_DOCTRINE,
  };
}

/**
 * Does a policy string actually permit every origin the runtimes need?
 *
 * This is the check that would have caught the desktop shell allowing two CDNs
 * that no loader in the product uses while blocking the two that it does.
 */
export function checkPolicyCoversRuntimes(policyString) {
  const s = typeof policyString === 'string' ? policyString : '';
  const missing = pinnedOrigins().filter(o => s.indexOf(o) < 0);
  return {
    ok: missing.length === 0,
    missing,
    reason: missing.length === 0
      ? 'Every pinned runtime origin appears in the policy.'
      : 'The policy does not permit ' + missing.join(', ') + ', so those runtimes would be blocked at load.',
  };
}

export const DataGlowCspPolicy = {
  CSP_POLICY_KIND,
  CSP_POLICY_VERSION,
  CSP_DOCTRINE,
  CSP_DIRECTIVE_NOTES,
  CSP_RESIDUALS,
  recommendedCspPolicy,
  checkPolicyCoversRuntimes,
};

try {
  if (typeof window !== 'undefined') window.DataGlowCspPolicy = DataGlowCspPolicy;
} catch (_e) {}
