// ============================================================
// DATAGLOW - Bundle 15 canvas UI proof (real Chrome, headless)
// ============================================================
// The pure engines are covered by
// test/bundle15-duckdb-harden-ledger-spine-replay-dojo.test.mjs. What only a
// browser can prove is the wiring:
//   - the Repair Ledger chip mounts on the RECEIPT spine rail only when
//     repairLedgerSpine is on, and the rail is unaffected when it is off;
//   - "Run again" on a rerunnable step asks for confirm before it inserts
//     SQL into the editor, and does nothing if the person declines;
//   - the SQL Dojo opens without throwing even against an empty/awkward
//     DOM and dataset stub, and the Run button is disabled with a plain
//     message when the SQL engine is not mounted.
//
// The SQL Dojo has no js/ source module of its own (canvas/index.html is
// its only home; see CODEMAP), so this test extracts the live Dojo IIFE(s)
// straight out of canvas/index.html at run time rather than re-typing the
// logic here. That means this test is exercising the actual shipped code,
// and it fails loudly if the extraction anchors ever stop matching (a
// sign the canvas source moved and this test needs updating with it).
//
// Same server-per-mode pattern as test/bundle14-canvas-ui.test.mjs.
//
// RUN WITH:  node test/bundle15-canvas-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '\u2014';

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks += 1; }
function eq(a, b, msg) { assert.equal(a, b, msg); checks += 1; }

// ---- Extract the live Dojo module + sidebar wiring straight from canvas ----

function extractDojoScript() {
  const canvas = readFileSync(join(REPO_ROOT, 'canvas', 'index.html'), 'utf-8');

  const dojoStart = canvas.indexOf("(function () {\n    'use strict';\n    /* sqlDojoSafe");
  if (dojoStart === -1) throw new Error('bundle15-canvas-ui: dojo module anchor not found in canvas/index.html');
  const dojoEnd = canvas.indexOf('})();', dojoStart) + 5;
  const dojoBlock = canvas.slice(dojoStart, dojoEnd);

  const sidebarStart = canvas.indexOf('/* Window Dojo sidebar button');
  if (sidebarStart === -1) throw new Error('bundle15-canvas-ui: sidebar dojo button anchor not found in canvas/index.html');
  // The sidebar block ends at the next top-level comment marker for the next button group.
  const sidebarEnd = canvas.indexOf("/* Take-Home Case agent bar button */", sidebarStart);
  if (sidebarEnd === -1) throw new Error('bundle15-canvas-ui: sidebar dojo button end anchor not found in canvas/index.html');
  const sidebarBlock = canvas.slice(sidebarStart, sidebarEnd);

  return dojoBlock + '\n' + sidebarBlock;
}

const DOJO_SCRIPT = extractDojoScript();

// ---- Extract the live receipt-spine + ledger canvas UI js/ files ----

async function readJs(relPath) {
  return readFile(join(REPO_ROOT, relPath), 'utf-8');
}

/* Boot conditions:
     'default'      no flags provider: repairLedgerSpine, repairLedger, and
                     replayReceiptThin all ship ON.
     'spineoff'     repairLedgerSpine disabled; repairLedger (floating) stays on.
     'replayoff'    replayReceiptThin disabled; Run again must not render.
     'noengine'     default flags, but no window.SQLEngine/db/duckdbConn at all,
                     to prove the Dojo Run button disables itself and the
                     ledger's Run again reports the engine is not ready. */
function page(mode) {
  let flagScript = '';
  if (mode === 'spineoff') {
    flagScript = '<script>window.DataGlowFlags={isEnabled:function(n){return n!=="repairLedgerSpine";}};<\/script>';
  }
  if (mode === 'replayoff') {
    flagScript = '<script>window.DataGlowFlags={isEnabled:function(n){return n!=="replayReceiptThin";}};<\/script>';
  }

  const engineStub = mode === 'noengine'
    ? '' // no window.SQLEngine / window.db / window.duckdbConn at all
    : '<script>window.SQLEngine = { safeTableName: function(n){ return n; } };<\/script>';

  const scripts = '<script type="module" src="/js/spine/receipt-spine.js"><\/script>'
    + '<script src="/js/spine/data-glow-receipt-spine-canvas.js"><\/script>'
    + '<script type="module" src="/js/spine/repair-ledger.js"><\/script>'
    + '<script src="/js/spine/data-glow-repair-ledger-canvas.js"><\/script>';

  // Minimal DOM the Dojo module and its sidebar wiring guard against being
  // missing: sql-view pill, editor input/run button, dojo tab markup.
  const dojoDom = ''
    + '<button class="analyze-pill" data-panel="sql-view">SQL</button>'
    + '<button class="sidebar-nav-item" id="sidebar-dojo-btn">SQL Dojo</button>'
    + '<div class="dojo-toggle-bar">'
    + '  <button class="dojo-tab-btn active" id="dojo-editor-btn">Editor</button>'
    + '  <button class="dojo-tab-btn" id="dojo-btn">Dojo</button>'
    + '</div>'
    + '<div id="dojo-panel">'
    + '  <div class="dojo-fn-grid" id="dojo-fn-grid">'
    + '    <div class="dojo-fn-card active" data-fn="rank">Rank</div>'
    + '    <div class="dojo-fn-card" data-fn="rownum">Row Number</div>'
    + '  </div>'
    + '  <div id="dojo-fn-desc"></div>'
    + '  <div class="dojo-controls" id="dojo-controls">'
    + '    <div id="dojo-cg-partition"><select id="dojo-partition"><option value="">(none)</option></select></div>'
    + '    <div id="dojo-cg-order"><select id="dojo-orderby"><option value="">(select)</option></select></div>'
    + '    <div id="dojo-cg-value"><select id="dojo-valuecol"><option value="">(select)</option></select></div>'
    + '  </div>'
    + '  <div class="dojo-preview" id="dojo-preview">-- Select a function and columns above</div>'
    + '  <button class="dojo-run-btn" id="dojo-run-btn">Run in SQL Editor</button>'
    + '</div>'
    + '<textarea id="sql-view-input"></textarea>'
    + '<button id="sql-view-run">Run</button>';

  return '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + flagScript
    + engineStub
    + '<script>window.__toasts=[];window.showToast=function(m,k){window.__toasts.push({message:m,kind:k||"info"});};<\/script>'
    + scripts
    + dojoDom
    + '<script>' + DOJO_SCRIPT + '<\/script>'
    + '</body></html>';
}

const MODES = ['default', 'spineoff', 'replayoff', 'noengine'];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const mode = MODES.find((m) => urlPath === `/__b15__${m}.html`);
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

async function waitForSpineModules(p) {
  await p.waitForFunction(
    () => !!window.DataGlowReceiptSpineUI && !!window.DataGlowRepairLedgerUI,
    null, { timeout: 20000 },
  );
  // Spine boots on setTimeout(boot,1200); ledger boots on setTimeout(fn,1400).
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
  const consoleErrors = [];
  const p = await ctx.newPage();
  p.on('pageerror', (err) => consoleErrors.push(String(err)));

  try {
    // ---- DEFAULT LOAD: ledger chip mounted on the spine rail's top row -----
    await p.goto(base + '/__b15__default.html');
    await waitForSpineModules(p);
    const onState = await p.evaluate(() => ({
      railPresent: !!document.getElementById('dg-spine-rail'),
      ledgerChipOnRail: !!document.getElementById('dg-spine-ledger-chip'),
      ledgerChipLabel: (document.getElementById('dg-spine-ledger-chip') || {}).textContent || '',
    }));
    ok(onState.railPresent, 'default load mounts the RECEIPT spine rail');
    eq(onState.ledgerChipOnRail, true, 'repairLedgerSpine on: the Repair Ledger chip mounts on the spine rail');
    ok(/Repair Ledger/i.test(onState.ledgerChipLabel), 'the spine chip names itself Repair Ledger');

    // ---- SPINE FLAG OFF: no chip on the rail, rail itself unaffected -------
    await p.goto(base + '/__b15__spineoff.html');
    await waitForSpineModules(p);
    const spineOffState = await p.evaluate(() => ({
      railPresent: !!document.getElementById('dg-spine-rail'),
      ledgerChipOnRail: !!document.getElementById('dg-spine-ledger-chip'),
      apiPublished: !!window.DataGlowReceiptSpineUI,
    }));
    eq(spineOffState.railPresent, true, 'repairLedgerSpine off must not remove the spine rail itself');
    eq(spineOffState.ledgerChipOnRail, false, 'repairLedgerSpine off: no ledger chip anywhere on the rail');
    eq(spineOffState.apiPublished, true, 'the spine UI API is still published when this flag is off');

    // ---- REPLAY: "Run again" appears on a rerunnable step and asks confirm -
    await p.goto(base + '/__b15__default.html');
    await waitForSpineModules(p);
    await p.evaluate(() => {
      const ledger = window.DataGlowRepairLedger;
      const step = ledger.buildStep({ kind: 'sql_recipe_run', engine: 'sql', status: 'applied', code: 'SELECT 1;', title: 'Bundle 15 test step' });
      window.__testLedger = [step];
      // Monkeypatch the module's private state via its public surface: reuse
      // ledgerArray() so the panel renders from a real, non-empty ledger.
      const arr = window.DataGlowRepairLedgerUI.ledgerArray();
      arr.push(step);
    });
    await p.click('#dg-spine-ledger-chip', { force: true });
    await p.waitForFunction(() => window.DataGlowRepairLedgerUI.isOpen(), null, { timeout: 5000 });
    const replayState = await p.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#dg-ledger-panel button')).map((b) => b.textContent);
      return { buttons };
    });
    ok(replayState.buttons.some((t) => /Run again/i.test(t)), 'replayReceiptThin on: a rerunnable step offers Run again');

    // Confirm gate: decline the browser confirm dialog and prove nothing ran.
    // The click is dispatched from inside page.evaluate (not page.click) so
    // the confirm() call and the persistent 'dialog' listener race the same
    // way real production interaction does; the fixed RECEIPT spine rail
    // overlapping the panel in this bare-bones test DOM is irrelevant to
    // the confirm-gate behavior this step is proving.
    let dialogSeen = false;
    let dialogAccept = false;
    p.on('dialog', async (dialog) => {
      dialogSeen = true;
      if (dialogAccept) await dialog.accept(); else await dialog.dismiss();
    });
    async function clickRunAgain() {
      return p.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('#dg-ledger-panel button')).find((b) => /Run again/i.test(b.textContent));
        if (!btn) return false;
        btn.click();
        return true;
      });
    }

    dialogAccept = false;
    ok(await clickRunAgain(), 'found the Run again button to click');
    await p.waitForTimeout(300);
    const afterDecline = await p.evaluate(() => (document.getElementById('sql-view-input') || {}).value || '');
    ok(dialogSeen, 'Run again triggers a human confirm dialog before anything runs');
    eq(afterDecline, '', 'declining the confirm must not insert SQL into the editor');

    // Accept this time: SQL should land in the editor.
    dialogSeen = false;
    dialogAccept = true;
    await clickRunAgain();
    await p.waitForFunction(
      () => !!(document.getElementById('sql-view-input') || {}).value,
      null, { timeout: 5000 },
    );
    const afterAccept = await p.evaluate(() => document.getElementById('sql-view-input').value);
    ok(/SELECT 1/.test(afterAccept), 'confirming Run again inserts the exact rerunnable SQL into the editor');

    // ---- REPLAY FLAG OFF: no Run again button -------------------------------
    await p.goto(base + '/__b15__replayoff.html');
    await waitForSpineModules(p);
    await p.evaluate(() => {
      const ledger = window.DataGlowRepairLedger;
      const step = ledger.buildStep({ kind: 'sql_recipe_run', engine: 'sql', status: 'applied', code: 'SELECT 1;', title: 'Bundle 15 test step' });
      window.DataGlowRepairLedgerUI.ledgerArray().push(step);
    });
    await p.evaluate(() => window.DataGlowRepairLedgerUI.open());
    await p.waitForFunction(() => window.DataGlowRepairLedgerUI.isOpen(), null, { timeout: 5000 });
    const replayOffButtons = await p.evaluate(() => Array.from(document.querySelectorAll('#dg-ledger-panel button')).map((b) => b.textContent));
    ok(!replayOffButtons.some((t) => /Run again/i.test(t)), 'replayReceiptThin off: no Run again button anywhere in the panel');
    ok(replayOffButtons.some((t) => /Re-run plan/i.test(t)), 'the pre-existing copy-to-clipboard Re-run plan action is unaffected');

    // ---- SQL DOJO: opens without throwing against a minimal DOM stub -------
    await p.goto(base + '/__b15__default.html');
    await waitForSpineModules(p);
    await p.click('#dojo-btn', { force: true });
    await p.waitForTimeout(300); // populateDropdowns is deferred with setTimeout(0)
    const dojoOpenState = await p.evaluate(() => ({
      panelOpen: document.getElementById('dojo-panel').classList.contains('open'),
      preview: document.getElementById('dojo-preview').textContent,
    }));
    eq(dojoOpenState.panelOpen, true, 'clicking the Dojo tab opens the panel without throwing');
    ok(/RANK\(\)/.test(dojoOpenState.preview), 'Dojo generates SQL for the default rank template');
    eq(consoleErrors.length, 0, `SQL Dojo open must not raise an uncaught page error, saw: ${consoleErrors.join(', ')}`);

    // ---- SQL DOJO: sidebar proxy button does not throw with a real click ---
    await p.goto(base + '/__b15__default.html');
    await waitForSpineModules(p);
    await p.click('#sidebar-dojo-btn', { force: true });
    await p.waitForTimeout(300);
    eq(consoleErrors.length, 0, 'the sidebar Dojo proxy click chain must not throw');

    // ---- SQL DOJO: Run disabled with a clear message when engine missing ---
    await p.goto(base + '/__b15__noengine.html');
    await waitForSpineModules(p);
    await p.click('#dojo-btn', { force: true });
    await p.waitForTimeout(300);
    const noEngineState = await p.evaluate(() => {
      const btn = document.getElementById('dojo-run-btn');
      return { disabled: btn.disabled, title: btn.title };
    });
    eq(noEngineState.disabled, true, 'sqlDojoSafe on, no engine mounted: Run is disabled');
    ok(noEngineState.title.length > 0, 'the disabled Run button carries a plain-language reason');
    ok(!noEngineState.title.includes(EM_DASH), 'no em dash in the Dojo disabled-Run message');

    // Clicking a disabled button fires no click handler in a real browser,
    // but confirm the handler itself also declines to act if forced.
    await p.evaluate(() => { document.getElementById('dojo-run-btn').disabled = false; });
    await p.click('#dojo-run-btn', { force: true });
    await p.waitForTimeout(200);
    const editorAfterNoEngineRun = await p.evaluate(() => (document.getElementById('sql-view-input') || {}).value || '');
    eq(editorAfterNoEngineRun, '', 'Run does nothing when the SQL engine is missing, even if re-enabled by hand');

    eq(offOrigin.length, 0, `nothing may leave this device, saw: ${offOrigin.join(', ')}`);

    console.log(`bundle 15 canvas UI: ${checks} assertion(s) passed `
      + '(spine ledger chip mount/flag-off, replay confirm gate, dojo safe open, dojo run-disabled).');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
