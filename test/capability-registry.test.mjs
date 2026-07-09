// ============================================================
// DATAGLOW — Capability registry test suite
// ============================================================
// Unit-tests the platform-aware module loader in js/capability-registry.js.
// Every case injects a fake manifest, a fake importer, and a forced platform, so
// nothing here touches the network, the DOM, or the real module tree — the loader
// is exercised end-to-end without a browser.
//
// RUN WITH:  node test/capability-registry.test.mjs

import {
  detectPlatform, moduleKey, buildRouting, loadRegistry,
  PLATFORM_BROWSER, PLATFORM_DESKTOP, VALID_PLATFORMS,
} from '../js/capability-registry.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function main() {
  // --- detectPlatform --------------------------------------------------------
  ok(detectPlatform({}) === PLATFORM_BROWSER, 'detectPlatform: plain window is browser');
  ok(detectPlatform({ __TAURI__: {} }) === PLATFORM_DESKTOP, 'detectPlatform: __TAURI__ is desktop');
  ok(detectPlatform({ __TAURI_IPC__: () => {} }) === PLATFORM_DESKTOP, 'detectPlatform: __TAURI_IPC__ is desktop');
  ok(detectPlatform(undefined) === PLATFORM_BROWSER, 'detectPlatform: no window defaults to browser');

  // --- moduleKey -------------------------------------------------------------
  ok(moduleKey('js/watch-folder.js') === 'watch-folder', 'moduleKey: strips dir and extension');
  ok(moduleKey('js/a.mjs') === 'a', 'moduleKey: handles .mjs');

  // --- VALID_PLATFORMS matches the drift gate's closed set -------------------
  ok(JSON.stringify(VALID_PLATFORMS) === JSON.stringify(['browser', 'desktop', 'mobile']),
    'VALID_PLATFORMS: browser/desktop/mobile');

  // --- buildRouting: union across capabilities + per-file override -----------
  {
    const manifest = {
      capabilities: [
        { id: 'x', platforms: ['browser'], files: ['js/shared.js'] },
        { id: 'y', platforms: ['desktop'], files: ['js/shared.js', 'js/only.js'] },
        { id: 'z', platforms: ['browser', 'desktop'], files: ['js/w.js'],
          platformsByFile: { 'js/w.js': ['browser'] } },
      ],
    };
    const r = buildRouting(manifest);
    ok([...r.get('js/shared.js').platforms].sort().join(',') === 'browser,desktop',
      'buildRouting: shared file unions platforms across capabilities');
    ok(r.get('js/shared.js').capabilities.length === 2, 'buildRouting: shared file records both capabilities');
    ok([...r.get('js/w.js').platforms].join(',') === 'browser',
      'buildRouting: platformsByFile override narrows platforms');
  }

  // --- loadRegistry: only platform-appropriate modules load ------------------
  {
    const manifest = {
      capabilities: [
        { id: 'universal', platforms: ['browser', 'desktop'], files: ['js/universal.js'] },
        { id: 'browseronly', platforms: ['browser'], files: ['js/browseronly.js'] },
        { id: 'desktoponly', platforms: ['desktop'], files: ['js/desktoponly.js'] },
        { id: 'worker', platforms: ['browser', 'desktop'], files: ['js/thing.worker.js'] },
      ],
    };
    const imported = [];
    const importer = async (relFile) => { imported.push(relFile); return { tag: relFile }; };

    const browser = await loadRegistry({ manifest, importer, platform: PLATFORM_BROWSER });
    ok(browser.platform === PLATFORM_BROWSER, 'loadRegistry: reports forced platform');
    ok(browser.has('universal') && browser.has('browseronly'), 'loadRegistry(browser): loads browser modules');
    ok(!browser.has('desktoponly'), 'loadRegistry(browser): skips desktop-only module');
    ok(!imported.includes('js/thing.worker.js'), 'loadRegistry: never imports worker entry files');
    ok(browser.get('universal').tag === 'js/universal.js', 'loadRegistry: get returns the module namespace');

    // Graceful fail: a desktop-only capability requested in a browser is undefined
    // (with a warning), never a throw — this is the runtime safety rail.
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      ok(browser.get('desktoponly') === undefined, 'loadRegistry(browser): desktop-only get is undefined');
      ok(browser.available('desktoponly') === false, 'loadRegistry(browser): desktop-only is unavailable');
      ok(browser.get('nope') === undefined, 'loadRegistry: unknown capability get is undefined');
    } finally {
      console.warn = origWarn;
    }
    ok(warns.some((w) => /restricted to/.test(w)), 'loadRegistry: warns when a wrong-platform module is requested');
    ok(warns.some((w) => /unknown capability/.test(w)), 'loadRegistry: warns on unknown capability');

    const desktop = await loadRegistry({ manifest, importer, platform: PLATFORM_DESKTOP });
    ok(desktop.has('desktoponly') && !desktop.has('browseronly'), 'loadRegistry(desktop): loads desktop, skips browser-only');
  }

  // --- loadRegistry: a failed import degrades gracefully ---------------------
  {
    const manifest = { capabilities: [{ id: 'boom', platforms: ['browser'], files: ['js/boom.js'] }] };
    const importer = async () => { throw new Error('kaboom'); };
    const origErr = console.error;
    console.error = () => {};
    let reg;
    try { reg = await loadRegistry({ manifest, importer, platform: PLATFORM_BROWSER }); }
    finally { console.error = origErr; }
    ok(reg.has('boom') === false, 'loadRegistry: a throwing import leaves the module absent, no crash');
    ok(reg.available('boom') === true, 'loadRegistry: module is still "available" (declared) though it failed to load');
    ok(reg.loadedCount === 0, 'loadRegistry: loadedCount reflects nothing loaded');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
