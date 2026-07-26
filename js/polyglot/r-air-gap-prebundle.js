// ============================================================
// DATAGLOW - R Air-Gap prebundle: what is actually offline, named honestly
// ============================================================
//
// r-deepen.js (Bundle 17) fixed the bug where Air-Gap mode did not stop the
// two-package startup fetch, and it named jsonlite and ggplot2 as the
// packages the runtime tries, both over the network, every session. That is
// correct: as of that build, nothing R-side is actually prebundled. A person
// reading "Available offline" next to a package this build cannot vouch for
// would be reading a claim this file exists specifically to prevent.
//
// This module is the manifest of INTENT and REALITY for a target package
// list this product would like to ship prebundled: dplyr, tidyr, ggplot2,
// jsonlite, readr, broom. For each one it declares an honest `availability`:
//
//   'bundled'      - shipped as a local/static asset this build loads with
//                    no network request, in Air-Gap mode or otherwise.
//   'network-only' - works, but only by fetching from the WebR repository;
//                    this is blocked by Air-Gap mode (see r-deepen.js).
//   'unavailable'  - not known to be installable in this WebR build at all.
//
// AS OF THIS BUNDLE, EVERY ENTRY IS 'network-only' OR 'unavailable' except
// none are 'bundled' yet: there is no local/static R package asset checked
// into this repository. That is the honest current state, not a placeholder
// to be quietly upgraded later without re-checking it against what actually
// loads. The loader below still prefers a local/static asset over the
// network for any package that DOES become bundled, without a code change
// at the call site, so bundling one is additive.
//
// Gated by the `rAirGapPrebundle` flag (checked by the CALLER, never in
// here). Flag OFF: the caller does not import or render anything from this
// module, and prior R Air-Gap behavior (r-deepen.js's packageInstallDecision
// blocking every network install in Air-Gap mode) is completely unchanged.
//
// Cross-platform: this module touches no DOM, no Node-only API, and no
// Tauri-only API. It is imported by the same path from the browser bundle,
// a Tauri desktop shell, and a mobile PWA build, and every exported
// function is pure and Node-testable.

export const R_AIRGAP_PREBUNDLE_KIND = 'dataglow-r-airgap-prebundle';
export const R_AIRGAP_PREBUNDLE_VERSION = 1;

/**
 * The manifest: target packages this product would like to ship prebundled
 * for Air-Gap R sessions, with an HONEST current availability per package.
 * `version` is the package version this manifest was checked against (not a
 * promise of what a live WebR repository currently serves); `assetPath` is
 * where a 'bundled' package's local/static asset would live once one exists
 * (null until then, deliberately, rather than a path nothing serves).
 */
export const R_AIRGAP_PREBUNDLE = Object.freeze([
  Object.freeze({
    name: 'jsonlite',
    version: '1.8.8',
    availability: 'network-only',
    assetPath: null,
    note: 'One of the two packages the runtime already fetches at startup (see r-power-pack.js / r-deepen.js). Works today with network access; Air-Gap mode blocks the fetch, same as every other package here.',
  }),
  Object.freeze({
    name: 'ggplot2',
    version: '3.5.1',
    availability: 'network-only',
    assetPath: null,
    note: 'The other startup-fetched package. Same story as jsonlite: works with network access, blocked by Air-Gap mode.',
  }),
  Object.freeze({
    name: 'dplyr',
    version: '1.1.4',
    availability: 'network-only',
    assetPath: null,
    note: 'Not fetched at startup. Installable on request if the WebR repository carries it and the session has network access; every dplyr recipe has a base R alternative (r-deepen.js) for when it does not.',
  }),
  Object.freeze({
    name: 'tidyr',
    version: '1.3.1',
    availability: 'network-only',
    assetPath: null,
    note: 'Same as dplyr: on-request network install, not prebundled.',
  }),
  Object.freeze({
    name: 'readr',
    version: '2.1.5',
    availability: 'unavailable',
    assetPath: null,
    note: 'Not confirmed installable in this WebR build. Listed as a target rather than silently dropped, so the gap is visible instead of hidden.',
  }),
  Object.freeze({
    name: 'broom',
    version: '1.0.5',
    availability: 'unavailable',
    assetPath: null,
    note: 'Same as readr: a target package this build does not yet confirm works in WebR at all, prebundled or not.',
  }),
]);

/**
 * Copy for a package's row in an "Available offline" vs "Needs network /
 * not prebundled" list. NEVER returns an offline claim for anything except
 * `availability: 'bundled'`, because that claim is the one thing this whole
 * module exists to keep honest.
 * @param {{name:string, availability:string}} entry one row of R_AIRGAP_PREBUNDLE
 * @returns {{label:string, offline:boolean, detail:string}}
 */
export function prebundleStatusCopy(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const name = typeof e.name === 'string' ? e.name : 'this package';
  if (e.availability === 'bundled') {
    return {
      label: 'Available offline',
      offline: true,
      detail: name + ' is a local asset this build loads with no network request, including in Air-Gap mode.',
    };
  }
  if (e.availability === 'network-only') {
    return {
      label: 'Needs network / not prebundled',
      offline: false,
      detail: name + ' works with network access but is fetched from the WebR repository, not prebundled. Air-Gap mode blocks that fetch.',
    };
  }
  return {
    label: 'Needs network / not prebundled',
    offline: false,
    detail: name + ' is not confirmed installable in this WebR build at all, prebundled or otherwise.',
  };
}

/**
 * Decide how to load one package: prefer a local/static asset if the
 * manifest says one is bundled, otherwise fall back to the existing
 * network-install decision (r-deepen.js's packageInstallDecision, passed in
 * by the caller so this module has no dependency on it and no duplicate
 * air-gap logic). PURE: takes the network decision as input rather than
 * computing it, so this function has nothing to get out of sync.
 *
 * @param {string} packageName
 * @param {{allowed:boolean, blockedBy:string, reason:string}} networkDecision
 *   the same shape `packageInstallDecision()` in r-deepen.js returns
 * @returns {{kind:string, package:string, source:'local'|'network'|'none', allowed:boolean, reason:string}}
 */
export function resolvePackageLoad(packageName, networkDecision) {
  const entry = R_AIRGAP_PREBUNDLE.find((p) => p.name === packageName) || null;
  const nd = networkDecision && typeof networkDecision === 'object' ? networkDecision : { allowed: false, reason: 'no network decision supplied' };

  if (entry && entry.availability === 'bundled' && entry.assetPath) {
    return {
      kind: R_AIRGAP_PREBUNDLE_KIND,
      package: packageName,
      source: 'local',
      allowed: true,
      reason: 'Loaded from ' + entry.assetPath + '. No network request, works in Air-Gap mode.',
    };
  }
  if (!entry) {
    return {
      kind: R_AIRGAP_PREBUNDLE_KIND,
      package: packageName,
      source: 'none',
      allowed: false,
      reason: packageName + ' is not on the target prebundle list. Falling back to the network-install decision.',
    };
  }
  if (entry.availability === 'unavailable') {
    return {
      kind: R_AIRGAP_PREBUNDLE_KIND,
      package: packageName,
      source: 'none',
      allowed: false,
      reason: entry.note,
    };
  }
  // network-only: defer entirely to the caller-supplied network decision.
  return {
    kind: R_AIRGAP_PREBUNDLE_KIND,
    package: packageName,
    source: nd.allowed ? 'network' : 'none',
    allowed: nd.allowed === true,
    reason: nd.reason || entry.note,
  };
}

/**
 * The manifest rows a UI would render for the target package list, each
 * annotated with `statusCopy` from prebundleStatusCopy() above. Pure, no
 * side effects, safe to call every render.
 * @returns {Array<object>}
 */
export function listPrebundleManifest() {
  return R_AIRGAP_PREBUNDLE.map((entry) => ({
    ...entry,
    statusCopy: prebundleStatusCopy(entry),
  }));
}

/**
 * Smoke-testable summary: how many of the target packages are honestly
 * offline-available right now, versus needing network. Used by the test
 * suite and by a UI header line ("0 of 6 available offline" etc.) rather
 * than each caller recomputing the same count.
 * @returns {{total:number, bundledCount:number, networkOnlyCount:number, unavailableCount:number, bundledNames:Array<string>}}
 */
export function summarizePrebundleAvailability() {
  const bundledNames = [];
  let networkOnlyCount = 0;
  let unavailableCount = 0;
  for (const entry of R_AIRGAP_PREBUNDLE) {
    if (entry.availability === 'bundled') bundledNames.push(entry.name);
    else if (entry.availability === 'network-only') networkOnlyCount += 1;
    else unavailableCount += 1;
  }
  return {
    total: R_AIRGAP_PREBUNDLE.length,
    bundledCount: bundledNames.length,
    networkOnlyCount,
    unavailableCount,
    bundledNames,
  };
}

export const DataGlowRAirGapPrebundle = {
  R_AIRGAP_PREBUNDLE_KIND,
  R_AIRGAP_PREBUNDLE_VERSION,
  R_AIRGAP_PREBUNDLE,
  prebundleStatusCopy,
  resolvePackageLoad,
  listPrebundleManifest,
  summarizePrebundleAvailability,
};

try {
  if (typeof window !== 'undefined') window.DataGlowRAirGapPrebundle = DataGlowRAirGapPrebundle;
} catch (_e) {}
