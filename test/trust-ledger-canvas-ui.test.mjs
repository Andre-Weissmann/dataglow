// ============================================================
// DATAGLOW - Trust Ledger + Publish-Safe canvas UI proof (real Chrome, headless)
// ============================================================
// The pure engines are covered by test/trust-ledger.test.mjs and
// test/publish-safe.test.mjs. What only a browser can prove is the wiring:
// that the ledger mounts where the flag says it should, that a row a human can
// read appears with a hash that verifies, and that the Save-as-app sheet shows
// the Publish-Safe verdict and records exactly one row when a file is written.
//
// It asserts, in order:
//   FLAG OFF (a provider reporting trustLedger disabled): no button and no
//     panel, but the API is still published, because the module publishes
//     whether or not the surface mounted and a caller must not have to know.
//   DEFAULT LOAD (no provider): trustLedger ships ON, so the button mounts.
//   EMPTY LEDGER: the panel opens and says plainly that nothing has happened
//     yet, rather than showing an empty box.
//   A REAL ROW: recording through the published API renders a row carrying the
//     time, a plain sentence and a hash prefix, and the chain verifies.
//   TAMPER: rewriting a rendered row's summary is not enough to fool verify,
//     because the hash commits to the text.
//   NO NETWORK: the panel's export buttons write to this device only.
//   PUBLISH-SAFE IN THE SHEET: with both engines present the Save-as-app sheet
//     carries a verdict block that is NOT the PHI warn block, and a PHI hit
//     drives the preselect through Publish-Safe rather than a private rule.
//   ONE ROW PER SAVE: pressing Save appends exactly one export-attempt row, the
//     proof that removing the duplicate event listener worked.
//
// Modules are loaded onto a minimal same-origin page rather than the ~5 MB
// canvas, so this stays fast and tests the code, not the bundle. The canvas
// inlines these exact files and npm run check:canvas-integrity pins the copies.
//
// RUN WITH:  node test/trust-ledger-canvas-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const EM_DASH = '—';

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks += 1; }
function eq(a, b, msg) { assert.equal(a, b, msg); checks += 1; }
function match(s, re, msg) { assert.match(s, re, msg); checks += 1; }

/* Boot conditions:
     'default'  no flags provider, which is how the app loads.
     'flagoff'  a provider that reports trustLedger disabled.
     'save'     the notebook surface plus Publish-Safe plus the ledger, which is
                the combination the Save-as-app path actually runs in.
     'savephi'  'save', plus a PHI Shield stub reporting a hit. */
function page(mode) {
  const wantsNotebook = mode === 'save' || mode === 'savephi';

  let extra = '';
  if (mode === 'flagoff') {
    extra += '<script>window.DataGlowFlags={isEnabled:function(n){return n!=="trustLedger";}};<\/script>';
  }
  if (mode === 'save') {
    // A shield that ran and found nothing. Without it the verdict would be a
    // caution rather than a clear, because Publish-Safe never reads a check that
    // could not run as a pass. That rule is pinned in test/publish-safe.test.mjs.
    extra += '<script>window.DataGlowPhiShield={guardOrBlock:function(){return {ok:true,'
      + 'sensitiveFound:false,findings:[]};}};<\/script>';
  }
  if (mode === 'savephi') {
    extra += '<script>window.DataGlowPhiShield={guardOrBlock:function(){return {ok:true,sensitiveFound:true,'
      + 'findings:[{type:"pattern",pattern:"mrn",count:2,in:"text"}]};}};<\/script>';
  }

  const notebookStubs = wantsNotebook
    ? '<div id="py-notebook-toolbar"></div><div id="r-notebook-toolbar"></div>'
    : '';

  let scripts = '<script src="/js/provenance/data-glow-trust-ledger-canvas.js"><\/script>'
    + '<script type="module" src="/js/provenance/trust-ledger.js"><\/script>'
    + '<script type="module" src="/js/gate/publish-safe.js"><\/script>';
  if (wantsNotebook) {
    scripts += '<script type="module" src="/js/intelligence/notebook-app-export.js"><\/script>'
      + '<script src="/js/intelligence/data-glow-notebook-app-canvas.js"><\/script>';
  }

  const notebookGlobals = wantsNotebook
    ? 'var nb = { id: "nb", version: 1, title: "Claims quality", cells: ['
      + '{ id: "c1", type: "markdown", source: "# Claims quality" },'
      + '{ id: "c2", type: "code", source: "print(df.shape)",'
      + '  output: { stdout: "(1200, 14)", images: [], status: "ok" } },'
      + '{ id: "c3", type: "code", source: "plot(denials)",'
      + '  output: { stdout: "", images: ["' + PNG + '"], status: "ok" } } ] };'
      + 'window.DataGlowPythonNotebook = { version: 1, getNotebook: function () { return nb; } };'
      + 'window.DataGlowRNotebook = { version: 1, getNotebook: function () { return nb; } };'
    : '';

  return '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + '<nav><button data-panel="python-view">Python</button><button data-panel="r-view">R</button></nav>'
    + notebookStubs
    + extra
    + '<script>'
    + 'window.__toasts = [];'
    + 'window.showToast = function (m, k) { window.__toasts.push({ message: m, kind: k || "info" }); };'
    + notebookGlobals
    + '<\/script>'
    + scripts
    + '</body></html>';
}

const MODES = ['default', 'flagoff', 'save', 'savephi'];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const mode = MODES.find((m) => urlPath === `/__tl__${m}.html`);
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

async function waitForLedger(p) {
  await p.waitForFunction(
    () => !!window.DataGlowTrustLedger && !!window.DataGlowTrustLedgerEngine,
    null, { timeout: 20000 },
  );
}

async function run() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({ acceptDownloads: true });
  // Nothing here may reach the network. An attempt is a failure, and also a
  // second proof that the ledger and its exports are built entirely on device.
  const offOrigin = [];
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    offOrigin.push(url);
    return route.abort();
  });
  const p = await ctx.newPage();

  try {
    // ---- FLAG OFF: nothing mounts, but the API is still published ----------
    await p.goto(base + '/__tl__flagoff.html');
    await p.waitForFunction(() => !!window.DataGlowTrustLedger, null, { timeout: 20000 });
    await p.waitForTimeout(1200);
    const offState = await p.evaluate(() => ({
      btn: !!document.getElementById('dg-trust-ledger-btn'),
      panel: !!document.getElementById('dg-trust-ledger-panel'),
      api: !!window.DataGlowTrustLedger,
      opened: window.DataGlowTrustLedger.open(),
    }));
    eq(offState.btn, false, 'a disabled flag must not mount the button');
    eq(offState.panel, false, 'a disabled flag must not build the panel');
    eq(offState.api, true, 'the API is published even with the surface unmounted');
    eq(offState.opened, false, 'open() must refuse while the flag is off');

    // ---- DEFAULT LOAD: ships ON, the button mounts with no opt-in ----------
    await p.goto(base + '/__tl__default.html');
    await waitForLedger(p);
    await p.waitForSelector('#dg-trust-ledger-btn', { timeout: 20000 });
    const onState = await p.evaluate(() => ({
      label: (document.querySelector('#dg-trust-ledger-btn [data-tl-label]') || {}).textContent || '',
      panelOpen: window.DataGlowTrustLedger.isOpen(),
      size: window.DataGlowTrustLedger.size(),
    }));
    eq(onState.label, 'Trust', 'the button reads Trust before anything is recorded');
    eq(onState.panelOpen, false, 'the panel starts closed');
    eq(onState.size, 0, 'the ledger starts empty');

    // ---- EMPTY LEDGER: the panel says so in plain language ------------------
    await p.click('#dg-trust-ledger-btn');
    await p.waitForFunction(() => window.DataGlowTrustLedger.isOpen(), null, { timeout: 5000 });
    const empty = await p.evaluate(() => ({
      text: document.getElementById('dg-trust-ledger-body').textContent,
      rows: document.querySelectorAll('#dg-trust-ledger-panel .dg-tl-row[data-tl-index]').length,
    }));
    eq(empty.rows, 0, 'an empty ledger renders no numbered rows');
    match(empty.text, /Nothing has happened yet/, 'the empty panel explains itself');
    match(empty.text, /never saved to disk/, 'the panel admits it is session scoped');
    ok(!empty.text.includes(EM_DASH), 'no em dash in the empty panel');

    // ---- A REAL ROW: readable, hashed, and it verifies ----------------------
    await p.evaluate(async () => {
      await window.DataGlowTrustLedger.record({
        kind: 'validation-run',
        subject: 'claims',
        summary: 'Validation ran and scored 88 out of 100.',
        detail: { score: 88 },
      });
    });
    await p.waitForFunction(
      () => document.querySelectorAll('#dg-trust-ledger-panel .dg-tl-row[data-tl-index]').length === 1,
      null, { timeout: 5000 },
    );
    const oneRow = await p.evaluate(() => {
      const row = document.querySelector('#dg-trust-ledger-panel .dg-tl-row[data-tl-index]');
      return {
        what: row.querySelector('.dg-tl-what').textContent,
        hash: row.querySelector('.dg-tl-hash').textContent,
        when: row.querySelector('.dg-tl-when').textContent,
        label: (document.querySelector('#dg-trust-ledger-btn [data-tl-label]') || {}).textContent,
        body: document.getElementById('dg-trust-ledger-body').textContent,
      };
    });
    match(oneRow.what, /scored 88 out of 100/, 'the row shows the sentence it was given');
    match(oneRow.hash, /^[0-9a-f]{16}$/, 'the row shows a hash prefix');
    match(oneRow.when, /Validation/, 'the row is labelled in house vocabulary');
    eq(oneRow.label, 'Trust · 1', 'the button counts the row');
    ok(!oneRow.body.includes(EM_DASH), 'no em dash once a row exists');

    const verified = await p.evaluate(() => window.DataGlowTrustLedger.verify());
    eq(verified.valid, true, 'a freshly recorded chain verifies');
    const goodBadge = await p.evaluate(() => ({
      state: document.getElementById('dg-trust-ledger-btn').getAttribute('data-state'),
      block: (document.querySelector('#dg-trust-ledger-panel .dg-tl-verify') || {}).className || '',
    }));
    eq(goodBadge.state, 'ok', 'a valid chain leaves the button calm');
    match(goodBadge.block, /good/, 'a valid chain renders the good verify block');

    // ---- TAMPER: the hash commits to the text, so an edit is caught ---------
    const tampered = await p.evaluate(async () => {
      const rows = window.DataGlowTrustLedger.getEntries();
      const copy = rows.map((r) => ({ ...r }));
      copy[0].summary = 'Validation ran and scored 100 out of 100.';
      return window.DataGlowTrustLedgerEngine.verifyTrustLedger(copy);
    });
    eq(tampered.valid, false, 'editing a summary must break the chain');
    match(tampered.reason, /\S/, 'a broken chain says why');
    ok(!tampered.reason.includes(EM_DASH), 'no em dash in the tamper reason');

    // getEntries() handed out a copy, so the live ledger is untouched.
    const stillValid = await p.evaluate(() => window.DataGlowTrustLedger.verify());
    eq(stillValid.valid, true, 'the real ledger was not mutated by the tamper attempt');

    // ---- PUBLISH-SAFE IN THE SHEET: no PHI, so a clear verdict, no warn ----
    await p.goto(base + '/__tl__save.html');
    await waitForLedger(p);
    await p.waitForFunction(() => !!window.DataGlowNotebookApp && !!window.DataGlowPublishSafeEngine,
      null, { timeout: 20000 });
    await p.waitForSelector('[data-nb-app-btn="python"]', { timeout: 20000 });
    await p.click('#py-notebook-toolbar [data-nb-app-btn="python"]');
    await p.waitForSelector('#dg-nb-app-sheet.open', { timeout: 5000 });
    const clean = await p.evaluate(() => {
      const box = document.querySelector('#dg-nb-app-sheet .dg-nba-box');
      const v = box.querySelector('[data-nba-verdict]');
      return {
        verdict: v ? v.getAttribute('data-nba-verdict') : null,
        verdictText: v ? v.textContent : '',
        warn: !!box.querySelector('.dg-nba-flag.warn'),
        checked: box.querySelector('[data-nba-outputs]').checked,
        text: box.textContent,
      };
    });
    eq(clean.verdict, 'clear', 'a clean notebook written to this device is clear');
    match(clean.verdictText, /can be written to this device/, 'the verdict speaks plainly');
    eq(clean.warn, false, 'a clear verdict must not borrow the PHI warn styling');
    eq(clean.checked, true, 'nothing sensitive means results stay preselected');
    ok(!clean.text.includes(EM_DASH), 'no em dash in the sheet with a verdict');

    // ---- ONE ROW PER SAVE --------------------------------------------------
    const before = await p.evaluate(() => window.DataGlowTrustLedger.size());
    eq(before, 0, 'opening the sheet records nothing, because nothing was written');
    const dl = p.waitForEvent('download', { timeout: 15000 });
    await p.click('#dg-nb-app-sheet [data-nba-save]');
    const download = await dl;
    ok(/\.html$/.test(download.suggestedFilename()), 'the saved file is one HTML file');
    await p.waitForFunction(() => window.DataGlowTrustLedger.size() === 1, null, { timeout: 5000 });
    const savedRow = await p.evaluate(() => {
      const rows = window.DataGlowTrustLedger.getEntries();
      return {
        n: rows.length,
        kind: rows[0].kind,
        outcome: rows[0].outcome,
        summary: rows[0].summary,
        completed: rows[0].detail && rows[0].detail.completed,
        included: rows[0].detail && rows[0].detail.includedResults,
      };
    });
    eq(savedRow.n, 1, 'exactly one row per save, so the removed listener stays removed');
    eq(savedRow.kind, 'export-attempt', 'a save is an export attempt');
    eq(savedRow.outcome, 'clear', 'the row carries the verdict the human read');
    eq(savedRow.completed, true, 'the row says the file was actually written');
    eq(savedRow.included, true, 'the row records whether results travelled');
    match(savedRow.summary, /Written to this device/, 'the row names where it went');
    ok(!savedRow.summary.includes(EM_DASH), 'no em dash in a ledger row');

    const afterSave = await p.evaluate(() => window.DataGlowTrustLedger.verify());
    eq(afterSave.valid, true, 'the chain still verifies after a real save');

    // ---- A PHI HIT DRIVES THE PRESELECT THROUGH PUBLISH-SAFE ---------------
    await p.goto(base + '/__tl__savephi.html');
    await waitForLedger(p);
    await p.waitForFunction(() => !!window.DataGlowNotebookApp && !!window.DataGlowPublishSafeEngine,
      null, { timeout: 20000 });
    await p.waitForSelector('[data-nb-app-btn="python"]', { timeout: 20000 });
    await p.click('#py-notebook-toolbar [data-nb-app-btn="python"]');
    await p.waitForSelector('#dg-nb-app-sheet.open', { timeout: 5000 });
    const phi = await p.evaluate(() => {
      const box = document.querySelector('#dg-nb-app-sheet .dg-nba-box');
      const v = box.querySelector('[data-nba-verdict]');
      return {
        verdict: v ? v.getAttribute('data-nba-verdict') : null,
        warnText: (box.querySelector('.dg-nba-flag.warn') || {}).textContent || '',
        checked: box.querySelector('[data-nba-outputs]').checked,
        saveDisabled: box.querySelector('[data-nba-save]').disabled,
        text: box.textContent,
      };
    });
    eq(phi.verdict, 'caution', 'a PHI hit staying on this device is a caution, not a refusal');
    eq(phi.checked, false, 'a PHI hit preselects leaving the results out');
    eq(phi.saveDisabled, false, 'a caution must not take the choice away');
    match(phi.warnText, /PHI Shield matched 2 possible sensitive values/,
      'the PHI block still owns the warn styling and still names the count');
    ok(!phi.text.includes(EM_DASH), 'no em dash in the PHI sheet');

    eq(offOrigin.length, 0, `nothing may leave this device, saw: ${offOrigin.join(', ')}`);

    console.log(`trust ledger + publish-safe canvas UI: ${checks} assertion(s) passed `
      + '(flag off, default mount, empty, real row, verify, tamper, verdict, one row per save, PHI preselect)');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
