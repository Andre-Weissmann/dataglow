// ============================================================
// DATAGLOW - Bundle 14 canvas UI proof (real Chrome, headless)
// ============================================================
// The pure engines are covered by test/bundle14-ledger-pq-arrow-llama-lanes.test.mjs.
// What only a browser can prove is the wiring: that the Repair Ledger panel
// mounts and unmounts by its own flag, and that the "Project fit" lanes tab
// appears in the power packs panel only when polyglotProjectLanes is on.
//
// Same split and same server-per-mode pattern as
// test/trust-ledger-canvas-ui.test.mjs.
//
// RUN WITH:  node test/bundle14-canvas-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks += 1; }
function eq(a, b, msg) { assert.equal(a, b, msg); checks += 1; }

/* Boot conditions:
     'default'    no flags provider: repairLedger and polyglotProjectLanes both
                  ship ON, which is how the app loads.
     'ledgeroff'  a provider that reports repairLedger disabled, lanes on.
     'lanesoff'   a provider that reports polyglotProjectLanes disabled, ledger on. */
function page(mode) {
  let extra = '';
  if (mode === 'ledgeroff') {
    extra = '<script>window.DataGlowFlags={isEnabled:function(n){return n!=="repairLedger";}};<\/script>';
  }
  if (mode === 'lanesoff') {
    extra = '<script>window.DataGlowFlags={isEnabled:function(n){return n!=="polyglotProjectLanes";}};<\/script>';
  }

  const scripts = '<script type="module" src="/js/spine/repair-ledger.js"><\/script>'
    + '<script src="/js/spine/data-glow-repair-ledger-canvas.js"><\/script>'
    + '<script type="module" src="/js/polyglot/pq-parity-recipes.js"><\/script>'
    + '<script type="module" src="/js/polyglot/project-lanes.js"><\/script>'
    + '<script type="module" src="/js/polyglot/arrow-bridge.js"><\/script>'
    + '<script src="/js/polyglot/data-glow-power-packs-canvas.js"><\/script>';

  return '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + extra
    + '<script>window.__toasts=[];window.showToast=function(m,k){window.__toasts.push({message:m,kind:k||"info"});};<\/script>'
    + scripts
    + '</body></html>';
}

const MODES = ['default', 'ledgeroff', 'lanesoff'];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const mode = MODES.find((m) => urlPath === `/__b14__${m}.html`);
      if (mode) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(mode));
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

async function waitForModules(p) {
  await p.waitForFunction(
    () => !!window.DataGlowRepairLedgerUI && !!window.DataGlowPowerPacksUI && !!window.DataGlowRepairLedger,
    null, { timeout: 20000 },
  );
  // Both canvas modules boot on a setTimeout(fn, 1400) after DOMContentLoaded;
  // give that boot a chance to run before asserting mount state.
  await p.waitForTimeout(1800);
}

async function run() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext();
  const offOrigin = [];
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    offOrigin.push(url);
    return route.abort();
  });
  const p = await ctx.newPage();

  try {
    // ---- DEFAULT LOAD: both surfaces ship ON with no opt-in -----------------
    await p.goto(base + '/__b14__default.html');
    await waitForModules(p);
    const onState = await p.evaluate(() => ({
      ledgerBtn: !!document.getElementById('dg-ledger-btn'),
      ledgerPanel: !!document.getElementById('dg-ledger-panel'),
      ledgerMounted: window.DataGlowRepairLedgerUI.mounted(),
      lanesTab: window.DataGlowPowerPacksUI.tabs().some((t) => t.id === 'lanes'),
    }));
    eq(onState.ledgerBtn, true, 'default load mounts the Repair Ledger button');
    eq(onState.ledgerPanel, true, 'default load builds the Repair Ledger panel');
    eq(onState.ledgerMounted, true, 'mounted() agrees with the DOM');
    eq(onState.lanesTab, true, 'default load exposes the Project fit lanes tab');

    // ---- LEDGER FLAG OFF: no button, no panel, API still published ---------
    await p.goto(base + '/__b14__ledgeroff.html');
    await waitForModules(p);
    const ledgerOffState = await p.evaluate(() => ({
      btn: !!document.getElementById('dg-ledger-btn'),
      panel: !!document.getElementById('dg-ledger-panel'),
      apiPublished: !!window.DataGlowRepairLedgerUI,
      lanesTabStillPresent: window.DataGlowPowerPacksUI.tabs().some((t) => t.id === 'lanes'),
    }));
    eq(ledgerOffState.btn, false, 'repairLedger disabled must not mount the button');
    eq(ledgerOffState.panel, false, 'repairLedger disabled must not build the panel');
    eq(ledgerOffState.apiPublished, true, 'the ledger UI API is still published when the flag is off');
    eq(ledgerOffState.lanesTabStillPresent, true, 'disabling repairLedger must not disable the unrelated lanes tab');

    // ---- LANES FLAG OFF: tab disappears, ledger unaffected ------------------
    await p.goto(base + '/__b14__lanesoff.html');
    await waitForModules(p);
    const lanesOffState = await p.evaluate(() => ({
      lanesTab: window.DataGlowPowerPacksUI.tabs().some((t) => t.id === 'lanes'),
      otherTabsPresent: window.DataGlowPowerPacksUI.tabs().length > 0,
      ledgerBtnStillThere: !!document.getElementById('dg-ledger-btn'),
    }));
    eq(lanesOffState.lanesTab, false, 'polyglotProjectLanes disabled removes the Project fit tab');
    eq(lanesOffState.otherTabsPresent, true, 'disabling lanes must not remove the SQL/Python/Excel/R tabs');
    eq(lanesOffState.ledgerBtnStillThere, true, 'disabling lanes must not disable the unrelated Repair Ledger');

    // ---- Repair Ledger panel content is readable and has no em dash --------
    await p.goto(base + '/__b14__default.html');
    await waitForModules(p);
    await p.click('#dg-ledger-btn');
    await p.waitForFunction(() => window.DataGlowRepairLedgerUI.isOpen(), null, { timeout: 5000 });
    const panelText = await p.evaluate(() => document.getElementById('dg-ledger-panel').textContent);
    ok(!panelText.includes(EM_DASH), 'no em dash in the Repair Ledger panel');
    ok(/Repair Ledger/i.test(panelText), 'the panel names itself');

    eq(offOrigin.length, 0, `nothing may leave this device, saw: ${offOrigin.join(', ')}`);

    console.log(`bundle 14 canvas UI: ${checks} assertion(s) passed `
      + '(default mount, ledger flag off, lanes tab flag off, panel content)');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
