// ============================================================
// DATAGLOW — Capability Registry (platform-aware module loader)
// ============================================================
// js/main.js historically imported every capability module with an
// unconditional static `import`, which had no concept of "platform": a module
// that only makes sense in a plain browser (or, later, only in the Tauri
// desktop shell or a future mobile app) had no safe way to be loaded on some
// runtimes and skipped on others. This registry is that missing seam.
//
// It reads the SAME hand-authored source of truth the capability-map drift gate
// validates (`capability-map.manifest.json`), where every capability now
// declares a `platforms` list (a subset of browser/desktop/mobile). At runtime
// it detects whether we are running in a plain browser or inside the Tauri
// webview, then dynamically `import()`s ONLY the capability modules whose
// platform list includes the detected runtime. The rest of the app asks the
// registry for a module by name and never has to know how — or whether — it was
// loaded.
//
// Everything here is first-party and offline-friendly: the manifest is a
// same-origin static file (precached by the service worker and staged into the
// desktop bundle), so reading it adds no third-party network dependency and
// never routes any user data anywhere. The pure helpers (detectPlatform,
// buildRouting, moduleKey) are exported so they can be unit-tested in Node
// without a DOM, and loadRegistry accepts injected `manifest`/`importer`/
// `platform` options so the whole loader is testable without a real browser.

export const PLATFORM_BROWSER = 'browser';
export const PLATFORM_DESKTOP = 'desktop';
export const PLATFORM_MOBILE = 'mobile';

// The complete, closed set of platform tokens the manifest may use. Kept in
// sync with capability-map.manifest.json's `_platforms` note and enforced by
// the capability-map drift gate so an invalid token can't ship silently.
export const VALID_PLATFORMS = [PLATFORM_BROWSER, PLATFORM_DESKTOP, PLATFORM_MOBILE];

// Resolve the manifest relative to this module so it works whether the site is
// served from the repository root (browser) or from the staged desktop bundle
// (Tauri) — in both, this file lives under js/app-shell/ and the manifest two
// levels up at the repository root.
const DEFAULT_MANIFEST_URL = new URL('../../capability-map.manifest.json', import.meta.url);

/**
 * Detect the current runtime. The Tauri v1 webview injects globals such as
 * `window.__TAURI__` / `window.__TAURI_IPC__`; a plain browser has none of them.
 * There is no "mobile" runtime yet, so this only ever returns browser/desktop.
 * @param {*} [win] window-like object (defaults to the real window if present).
 * @returns {'browser'|'desktop'}
 */
export function detectPlatform(win = (typeof window !== 'undefined' ? window : undefined)) {
  if (win && (win.__TAURI__ || win.__TAURI_IPC__ || win.__TAURI_INTERNALS__)) {
    return PLATFORM_DESKTOP;
  }
  return PLATFORM_BROWSER;
}

/**
 * A stable lookup key for a capability module: its filename without directory
 * or extension (e.g. `js/watch-folder.js` -> `watch-folder`). This is what the
 * rest of the app passes to `registry.get(...)`.
 * @param {string} relFile
 * @returns {string}
 */
export function moduleKey(relFile) {
  const base = String(relFile).split('/').pop() || String(relFile);
  return base.replace(/\.m?js$/, '');
}

// Worker entry files run as Web Workers (via `new Worker(url)`), not as modules
// the main thread imports — importing them here would evaluate worker-only
// globals on the main thread. The registry lists them but never imports them.
function isWorkerEntry(relFile) {
  return /\.worker\.m?js$/.test(String(relFile));
}

/**
 * Build the file -> {platforms, capabilities} routing table from a manifest
 * object. Pure; no I/O. A single file may be claimed by more than one
 * capability (e.g. a module listed under two areas); its effective platform set
 * is the UNION across those capabilities, and a capability's optional
 * `platformsByFile` map overrides the capability-level `platforms` per file.
 * @param {{capabilities?: Array<object>}} manifest
 * @returns {Map<string, {file:string, key:string, platforms:Set<string>, capabilities:string[]}>}
 */
export function buildRouting(manifest) {
  const caps = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
  const byFile = new Map();
  for (const cap of caps) {
    const capPlatforms = Array.isArray(cap.platforms) ? cap.platforms : [];
    const perFile = cap.platformsByFile && typeof cap.platformsByFile === 'object' ? cap.platformsByFile : {};
    const capId = cap.id || cap.name || '(unnamed capability)';
    for (const file of Array.isArray(cap.files) ? cap.files : []) {
      const override = perFile[file];
      const effective = Array.isArray(override) && override.length ? override : capPlatforms;
      if (!byFile.has(file)) {
        byFile.set(file, { file, key: moduleKey(file), platforms: new Set(), capabilities: [] });
      }
      const rec = byFile.get(file);
      for (const p of effective) rec.platforms.add(p);
      if (!rec.capabilities.includes(capId)) rec.capabilities.push(capId);
    }
  }
  return byFile;
}

// Default dynamic importer: resolve a repo-root-relative `js/<area>/<name>.js`
// manifest path to a specifier and import it. This module lives at
// js/app-shell/, so the repository root is two levels up. Isolated so tests can
// inject a fake.
function defaultImporter(relFile) {
  const specifier = new URL('../../' + relFile, import.meta.url).href;
  return import(specifier);
}

async function readManifest(url) {
  const res = await fetch(url);
  if (!res || !res.ok) {
    throw new Error(`capability manifest fetch failed (HTTP ${res ? res.status : 'no response'})`);
  }
  return res.json();
}

/**
 * Load the capability registry for the current (or injected) runtime.
 *
 * @param {object} [opts]
 * @param {object} [opts.manifest]     Pre-parsed manifest (tests); otherwise fetched.
 * @param {URL|string} [opts.manifestUrl] Where to fetch the manifest from.
 * @param {'browser'|'desktop'|'mobile'} [opts.platform] Force a platform (tests).
 * @param {(relFile:string)=>Promise<object>} [opts.importer] Injected importer (tests).
 * @returns {Promise<{platform:string, get:Function, has:Function, available:Function,
 *   list:Function, loadedCount:number}>}
 */
export async function loadRegistry(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const manifest = opts.manifest || await readManifest(opts.manifestUrl || DEFAULT_MANIFEST_URL);
  const importer = opts.importer || defaultImporter;

  const routing = buildRouting(manifest);
  const modules = new Map();      // key -> module namespace (only what actually loaded)
  const descriptors = new Map();  // key -> { key, file, platforms, capabilities, loaded }

  for (const rec of routing.values()) {
    const platforms = [...rec.platforms];
    const desc = {
      key: rec.key,
      file: rec.file,
      platforms,
      capabilities: [...rec.capabilities],
      loaded: false,
    };
    descriptors.set(rec.key, desc);

    // Skip worker entry files and anything not shipped under js/.
    if (isWorkerEntry(rec.file) || !rec.file.startsWith('js/')) continue;
    // Platform gate: only import modules meant for the detected runtime.
    if (!platforms.includes(platform)) continue;

    try {
      const ns = await importer(rec.file);
      modules.set(rec.key, ns);
      desc.loaded = true;
    } catch (err) {
      // A failed import must never take down bootstrap: log loudly and leave the
      // module absent so consumers degrade via their own guards.
      console.error(`[capability-registry] failed to import ${rec.file}:`, err);
    }
  }

  const registry = {
    platform,

    // Return a loaded module namespace, or undefined with a clear warning when
    // the capability is unknown, restricted to other platforms, or failed to
    // load. This is the safety rail: a desktop-/mobile-only module requested in
    // a browser context (or vice versa) fails gracefully, never silently.
    get(name) {
      if (modules.has(name)) return modules.get(name);
      const desc = descriptors.get(name);
      if (!desc) {
        console.warn(`[capability-registry] unknown capability module "${name}".`);
        return undefined;
      }
      if (!desc.platforms.includes(platform)) {
        console.warn(
          `[capability-registry] "${name}" is restricted to [${desc.platforms.join(', ')}] and ` +
          `is not available on the "${platform}" runtime — skipping. (Requested by a caller that ` +
          `should guard for this.)`
        );
        return undefined;
      }
      console.warn(`[capability-registry] "${name}" is declared for "${platform}" but did not load.`);
      return undefined;
    },

    // True only if the module actually loaded on this runtime.
    has(name) { return modules.has(name); },

    // True if the module is declared for this runtime (whether or not it loaded).
    available(name) {
      const desc = descriptors.get(name);
      return !!desc && desc.platforms.includes(platform);
    },

    // Every known capability module and its status — for diagnostics/tests.
    list() {
      return [...descriptors.values()].map((d) => ({ ...d, platforms: [...d.platforms] }));
    },

    get loadedCount() { return modules.size; },
  };

  return registry;
}
