// ============================================================
// DATAGLOW — Air-Gap Mode canvas UI proof (real Chrome, headless)
// ============================================================
// The pure posture engine is covered by test/air-gap-mode.test.mjs and the
// golden suite. What only a browser can prove is the part that matters most
// about this feature: that turning the mode ON actually stops an outbound
// request, and that turning it OFF gives the page its network back.
//
// It asserts, in order:
//   OPT-OUT (window.DATAGLOW_AIR_GAP = false): no button, no panel, no banner,
//     and window.fetch is the untouched original.
//   PROVIDER OFF (a flags provider reporting airGapMode disabled): the same,
//     which is what proves the flag is read rather than assumed.
//   DEFAULT LOAD (no override, no provider): airGapMode ships enabled, so the
//     button mounts and the panel opens with no console opt-in. The block itself
//     still starts off, because mounting the surface is not engaging it.
//   TOGGLE: the toggle flips the posture and raises the calm banner.
//   BLOCK: with the mode on, a cross-origin fetch is refused before it leaves,
//     while a same-origin asset fetch still succeeds (local engines keep working).
//   RESTORE: turning the mode off restores window.fetch and the cross-origin
//     request succeeds again.
//
// The two modules are loaded onto a minimal same-origin page rather than the
// 6 MB canvas, so this stays fast and tests the code, not the bundle. The
// canvas inlines these exact files (see inject_air_gap_mode.py) and
// npm run check:canvas-integrity is what pins the inlined copies to them.
//
// RUN WITH:  node test/air-gap-canvas-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TEST_PAGE = '/__airgap_test__.html';
const OPT_OUT_PAGE = '/__airgap_test__opt-out.html';
const FLAG_OFF_PAGE = '/__airgap_test__flag-off.html';
const LOCAL_ASSET = '/__airgap_local_asset__.txt';
const CROSS_ORIGIN = 'https://api.openai.example/v1/messages';

/* Three boot conditions:
     'default'  no override and no flags provider, which is how the app loads.
                airGapMode ships enabled, so the surface must mount.
     'optout'   window.DATAGLOW_AIR_GAP = false, the explicit local opt-out.
     'flagoff'  a flags provider that reports airGapMode disabled. */
function page(mode) {
  var pre = '';
  if (mode === 'optout') pre = '<script>window.DATAGLOW_AIR_GAP = false;<\/script>';
  if (mode === 'flagoff') {
    pre = '<script>window.DataGlowFlags = { isEnabled: function (n) { return n !== "airGapMode"; } };<\/script>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"></head><body>' + pre +
    '<script type="module" src="/js/privacy/air-gap-mode.js"><\/script>' +
    '<script src="/js/privacy/data-glow-air-gap-canvas.js"><\/script>' +
    '</body></html>';
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === TEST_PAGE || urlPath === OPT_OUT_PAGE || urlPath === FLAG_OFF_PAGE) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(urlPath === OPT_OUT_PAGE ? 'optout' : (urlPath === FLAG_OFF_PAGE ? 'flagoff' : 'default')));
        return;
      }
      if (urlPath === LOCAL_ASSET) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('local-ok');
        return;
      }
      if (urlPath.startsWith('/js/')) {
        try {
          const body = await readFile(join(REPO_ROOT, urlPath.slice(1)));
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
          res.end(body);
        } catch {
          res.writeHead(404).end('not found');
        }
        return;
      }
      res.writeHead(404).end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForBoot(p) {
  await p.waitForFunction(() => !!window.DataGlowAirGapUI, null, { timeout: 15000 });
}

async function run() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  // CI installs real Chrome via setup-chrome and points at it here, the same way
  // the other e2e tests do; locally this is unset and Playwright's own build runs.
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext();
  // Any request to the fake external origin resolves, so a blocked request is
  // proof of the guard and not of an unreachable host.
  await ctx.route('**://api.openai.example/**', (route) => route.fulfill({ status: 200, body: 'remote-ok' }));
  const p = await ctx.newPage();

  try {
    const surfaceState = () => p.evaluate(() => ({
      btn: !!document.getElementById('dg-air-gap-btn'),
      panel: !!document.getElementById('dg-air-gap-panel'),
      banner: !!document.getElementById('dg-air-gap-banner'),
      fetchIsNative: /\[native code\]/.test(String(window.fetch)),
      allowsAi: window.DataGlowAirGapUI.allowAi(),
    }));

    // ---- EXPLICIT OPT-OUT: window.DATAGLOW_AIR_GAP = false keeps it off ----
    await p.goto(base + OPT_OUT_PAGE);
    await waitForBoot(p);
    const optedOut = await surfaceState();
    assert.equal(optedOut.btn, false, 'the opt-out must not mount the button');
    assert.equal(optedOut.panel, false, 'the opt-out must not mount the panel');
    assert.equal(optedOut.banner, false, 'the opt-out must not mount the banner');
    assert.equal(optedOut.fetchIsNative, true, 'the opt-out must not wrap window.fetch');
    assert.equal(optedOut.allowsAi, true, 'the opt-out must not block anything');

    // ---- FLAGS PROVIDER SAYS DISABLED: the flag read is honored ----
    await p.goto(base + FLAG_OFF_PAGE);
    await waitForBoot(p);
    const flagOff = await surfaceState();
    assert.equal(flagOff.btn, false, 'a provider reporting airGapMode disabled must not mount the button');
    assert.equal(flagOff.fetchIsNative, true, 'a disabled flag must not wrap window.fetch');
    assert.equal(flagOff.allowsAi, true, 'a disabled flag must not block anything');

    // ---- DEFAULT LOAD: ships ON, so the surface mounts with no opt-in ----
    await p.goto(base + TEST_PAGE);
    await waitForBoot(p);
    await p.waitForSelector('#dg-air-gap-btn', { timeout: 15000 });
    const mounted = await p.evaluate(() => {
      const btn = document.getElementById('dg-air-gap-btn');
      const box = btn.getBoundingClientRect();
      return {
        label: btn.querySelector('[data-ag-label]').textContent,
        state: btn.getAttribute('data-state'),
        height: box.height,
        width: box.width,
        active: window.DataGlowAirGapUI.isActive(),
        bannerOpen: document.getElementById('dg-air-gap-banner').classList.contains('open'),
        mountedWithoutOptIn: window.DATAGLOW_AIR_GAP === undefined && !window.DataGlowFlags,
      };
    });
    assert.equal(mounted.label, 'Air-Gap', 'button starts in the off label');
    assert.equal(mounted.mountedWithoutOptIn, true, 'the surface must mount with no console opt-in');
    assert.equal(mounted.state, 'off');
    // Mounting the surface is not the same as engaging the block: the toggle is
    // there by default, and turning it on stays the user's session choice.
    assert.equal(mounted.active, false, 'the block itself is still the user session choice');
    assert.equal(mounted.bannerOpen, false, 'no banner while off');
    // The inline canvas CSS is what sizes the button to 44px; on this bare page
    // it is unstyled, so only assert it is a real, clickable element.
    assert.ok(mounted.height > 0 && mounted.width > 0, 'button must be visible');

    // ---- PANEL OPEN ----
    await p.click('#dg-air-gap-btn');
    await p.waitForSelector('#dg-air-gap-panel.open', { timeout: 5000 });
    const panelText = await p.textContent('#dg-air-gap-body');
    assert.match(panelText, /Air-Gap Mode is off/);
    assert.ok(!panelText.includes('—'), 'no em dash in panel copy');

    // ---- TOGGLE ON ----
    await p.click('[data-ag-toggle]');
    const on = await p.evaluate(() => ({
      active: window.DataGlowAirGapUI.isActive(),
      state: document.getElementById('dg-air-gap-btn').getAttribute('data-state'),
      bannerOpen: document.getElementById('dg-air-gap-banner').classList.contains('open'),
      bannerText: document.getElementById('dg-air-gap-banner').textContent,
      allowsAi: window.DataGlowAirGapUI.allowAi(),
      allowsMcp: window.DataGlowAirGapUI.allowMcp(),
      allowsOffload: window.DataGlowAirGapUI.allowServerOffload(),
      allowsSql: window.DataGlowAirGapUI.allowNetwork('sql'),
      fetchIsNative: /\[native code\]/.test(String(window.fetch)),
    }));
    assert.equal(on.active, true);
    assert.equal(on.state, 'on');
    assert.equal(on.bannerOpen, true, 'calm banner must be visible while on');
    assert.match(on.bannerText, /Nothing leaves this device/);
    assert.equal(on.allowsAi, false, 'AI must be blocked while on');
    assert.equal(on.allowsMcp, false, 'MCP must be blocked while on');
    assert.equal(on.allowsOffload, false, 'server offload must be blocked while on');
    assert.equal(on.allowsSql, true, 'local SQL must keep working while on');
    assert.equal(on.fetchIsNative, false, 'fetch must be wrapped while on');

    // ---- BLOCK: cross-origin refused, same-origin still served ----
    const blocked = await p.evaluate(async (url) => {
      try { await window.fetch(url); return { blocked: false, name: '' }; } catch (e) {
        return { blocked: true, name: e.name, message: e.message };
      }
    }, CROSS_ORIGIN);
    assert.equal(blocked.blocked, true, 'cross-origin fetch must be refused while on');
    assert.equal(blocked.name, 'AirGapBlockedError');
    assert.match(blocked.message, /Air-Gap Mode is on/);

    const localOk = await p.evaluate(async (url) => {
      const res = await window.fetch(url);
      return res.text();
    }, LOCAL_ASSET);
    assert.equal(localOk, 'local-ok', 'same-origin assets must keep loading while on');

    const xhrBlocked = await p.evaluate((url) => {
      try { new XMLHttpRequest().open('GET', url); return false; } catch (e) { return e.name === 'AirGapBlockedError'; }
    }, CROSS_ORIGIN);
    assert.equal(xhrBlocked, true, 'cross-origin XHR must be refused while on');

    // ---- RESTORE ----
    await p.click('[data-ag-toggle]');
    const restored = await p.evaluate(async (url) => {
      const out = {
        active: window.DataGlowAirGapUI.isActive(),
        state: document.getElementById('dg-air-gap-btn').getAttribute('data-state'),
        bannerOpen: document.getElementById('dg-air-gap-banner').classList.contains('open'),
        fetchIsNative: /\[native code\]/.test(String(window.fetch)),
        allowsAi: window.DataGlowAirGapUI.allowAi(),
        remote: '',
      };
      out.remote = await window.fetch(url).then((r) => r.text());
      return out;
    }, CROSS_ORIGIN);
    assert.equal(restored.active, false);
    assert.equal(restored.state, 'off');
    assert.equal(restored.bannerOpen, false, 'banner must clear when the mode is off');
    assert.equal(restored.fetchIsNative, true, 'fetch must be restored');
    assert.equal(restored.allowsAi, true);
    assert.equal(restored.remote, 'remote-ok', 'outbound requests must work again');

    console.log('air-gap canvas UI: 32 assertion(s) passed (opt-out, provider off, default mount, open, toggle, block, restore)');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
