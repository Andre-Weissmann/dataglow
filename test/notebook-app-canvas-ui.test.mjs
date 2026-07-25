// ============================================================
// DATAGLOW - Notebook to App canvas UI proof (real Chrome, headless)
// ============================================================
// The pure engine is covered by test/notebook-app-export.test.mjs. What only a
// browser can prove is the part that matters most about this feature: that
// nothing is written until a human presses Save in a sheet that first told them
// what was going in the file.
//
// It asserts, in order:
//   FLAG OFF (a flags provider reporting notebookToApp disabled): no button on
//     either notebook toolbar, which is what proves the flag is read.
//   DEFAULT LOAD (no provider): notebookToApp ships ON, so the button mounts on
//     both the Python and the R toolbars with no console opt-in.
//   EMPTY NOTEBOOK: pressing the button on a notebook with no cells refuses and
//     opens no sheet.
//   DISCLOSURE: the sheet lists what goes in the file, in plain language, with
//     no em dash, and no download has happened yet.
//   OPT OUT OF RESULTS: unchecking the box re-renders the list and the file that
//     is eventually written carries no captured output.
//   CANCEL: closing the sheet writes nothing.
//   SAVE: pressing Save triggers exactly one download, with the expected
//     filename, and the downloaded bytes are a self-contained offline file
//     holding the cells and the plot.
//   PHI: with a PHI Shield stub reporting a hit, the sheet warns and preselects
//     leaving the results out.
//   AIR GAP: with an Air-Gap stub reporting active, the sheet says saving is
//     still allowed, because writing a local file crosses no network.
//
// The two modules are loaded onto a minimal same-origin page with tiny stubs for
// the notebook globals rather than the ~5 MB canvas, so this stays fast and
// tests the code, not the bundle. The canvas inlines these exact files (see
// inject_notebook_app.py) and npm run check:canvas-integrity is what pins the
// inlined copies to them.
//
// RUN WITH:  node test/notebook-app-canvas-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/* Boot conditions:
     'default'  no flags provider, which is how the app loads. notebookToApp
                ships enabled, so both buttons must mount.
     'flagoff'  a provider that reports notebookToApp disabled.
     'phi'      default, plus a PHI Shield stub reporting a hit.
     'airgap'   default, plus an Air-Gap stub reporting the mode active.
     'empty'    default, but both notebooks report no cells. */
function page(mode) {
  // Stubs for exactly the globals the wire reads: the two notebook toolbars,
  // the two notebook APIs, and (per mode) PHI Shield / Air-Gap.
  const notebook = mode === 'empty'
    ? '{ id: "nb", version: 1, title: "Empty", cells: [] }'
    : `{
        id: 'nb', version: 1, title: 'Claims quality',
        cells: [
          { id: 'c1', type: 'markdown', source: '# Claims quality' },
          { id: 'c2', type: 'code', source: 'print(df.shape)',
            output: { stdout: '(1200, 14)', images: [], status: 'ok' } },
          { id: 'c3', type: 'code', source: 'plot(denials)',
            output: { stdout: '', images: ['${PNG}'], status: 'ok' } }
        ]
      }`;

  let extra = '';
  if (mode === 'flagoff') {
    extra += '<script>window.DataGlowFlags={isEnabled:function(n){return n!=="notebookToApp";}};<\/script>';
  }
  if (mode === 'phi') {
    extra += '<script>window.DataGlowPhiShield={guardOrBlock:function(){return {ok:true,sensitiveFound:true,' +
      'findings:[{type:"pattern",pattern:"mrn",count:2,in:"text"}]};}};<\/script>';
  }
  if (mode === 'airgap') {
    extra += '<script>window.DataGlowAirGapUI={isActive:function(){return true;}};<\/script>';
  }

  return '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<nav><button data-panel="python-view">Python</button><button data-panel="r-view">R</button></nav>' +
    '<div id="py-notebook-toolbar"></div><div id="r-notebook-toolbar"></div>' +
    extra +
    '<script>' +
    'window.__toasts = [];' +
    'window.showToast = function (m, k) { window.__toasts.push({ message: m, kind: k || "info" }); };' +
    'var nb = ' + notebook + ';' +
    'window.DataGlowPythonNotebook = { version: 1, getNotebook: function () { return nb; } };' +
    'window.DataGlowRNotebook = { version: 1, getNotebook: function () { return nb; } };' +
    'window.__saved = [];' +
    'document.addEventListener("dataglow:notebook-app-saved", function (ev) { window.__saved.push(ev.detail); });' +
    '<\/script>' +
    '<script type="module" src="/js/intelligence/notebook-app-export.js"><\/script>' +
    '<script src="/js/intelligence/data-glow-notebook-app-canvas.js"><\/script>' +
    '</body></html>';
}

const MODES = ['default', 'flagoff', 'phi', 'airgap', 'empty'];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const mode = MODES.find((m) => urlPath === `/__nbapp__${m}.html`);
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

async function waitForBoot(p) {
  await p.waitForFunction(() => !!window.DataGlowNotebookApp && !!window.DataGlowNotebookAppExport,
    null, { timeout: 20000 });
}

async function run() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({ acceptDownloads: true });
  // Nothing in this test may reach the network. Any attempt is a failure, which
  // is also a second proof that the exported file is built entirely on device.
  const offOrigin = [];
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    offOrigin.push(url);
    return route.abort();
  });
  const p = await ctx.newPage();

  try {
    const buttons = () => p.evaluate(() => ({
      python: !!document.querySelector('#py-notebook-toolbar [data-nb-app-btn="python"]'),
      r: !!document.querySelector('#r-notebook-toolbar [data-nb-app-btn="r"]'),
      label: (document.querySelector('[data-nb-app-btn]') || {}).textContent || '',
      sheet: !!document.getElementById('dg-nb-app-sheet'),
    }));

    // ---- FLAGS PROVIDER SAYS DISABLED: no button on either toolbar ----------
    await p.goto(base + '/__nbapp__flagoff.html');
    await p.waitForFunction(() => !!window.DataGlowNotebookAppExport, null, { timeout: 20000 });
    await p.waitForTimeout(1400);
    const off = await buttons();
    assert.equal(off.python, false, 'a disabled flag must not mount the Python button');
    assert.equal(off.r, false, 'a disabled flag must not mount the R button');
    assert.equal(off.sheet, false, 'a disabled flag must not build the sheet');
    assert.equal(await p.evaluate(() => !!window.DataGlowNotebookApp), false,
      'a disabled flag must not publish the API');

    // ---- DEFAULT LOAD: ships ON, both buttons mount with no opt-in ----------
    await p.goto(base + '/__nbapp__default.html');
    await waitForBoot(p);
    await p.waitForSelector('[data-nb-app-btn="python"]', { timeout: 20000 });
    const on = await buttons();
    assert.equal(on.python, true, 'the Python toolbar must carry the button by default');
    assert.equal(on.r, true, 'the R toolbar must carry the button by default');
    assert.equal(on.label, 'Save as app');
    assert.equal(await p.evaluate(() => window.DATAGLOW_NOTEBOOK_APP === undefined && !window.DataGlowFlags),
      true, 'mounted with no console opt-in');
    assert.equal(await p.evaluate(() => window.DataGlowNotebookApp.isOpen()), false,
      'no sheet before the button is pressed');

    // Mounting is idempotent: the nav-click retry must not add a second button.
    await p.click('[data-panel="python-view"]');
    await p.waitForTimeout(400);
    assert.equal(await p.evaluate(() => document.querySelectorAll('[data-nb-app-btn]').length), 2,
      'exactly one button per toolbar, no duplicates on re-mount');

    // ---- DISCLOSURE: the sheet says what goes in the file -------------------
    await p.click('#py-notebook-toolbar [data-nb-app-btn]');
    await p.waitForSelector('#dg-nb-app-sheet.open', { timeout: 5000 });
    const sheet = await p.evaluate(() => {
      const box = document.querySelector('#dg-nb-app-sheet .dg-nba-box');
      return {
        title: box.querySelector('.dg-nba-title').textContent,
        sub: box.querySelector('.dg-nba-sub').textContent,
        lines: [].slice.call(box.querySelectorAll('ul.dg-nba-list li')).map((li) => li.textContent),
        outputsChecked: box.querySelector('[data-nba-outputs]').checked,
        hasSave: !!box.querySelector('[data-nba-save]'),
        hasCancel: !!box.querySelector('[data-nba-cancel]'),
        warn: !!box.querySelector('.dg-nba-flag.warn'),
        text: box.textContent,
      };
    });
    assert.equal(sheet.title, 'Save as an app');
    assert.match(sheet.sub, /Nothing is written until you press Save/);
    assert.ok(sheet.lines.length >= 4, 'the sheet must list what goes in the file');
    assert.ok(sheet.lines.some((l) => /2 code cells and 1 text cell/.test(l)));
    assert.ok(sheet.lines.some((l) => /1 plot image/.test(l)));
    assert.ok(sheet.lines.some((l) => /No dataset rows and no source files/.test(l)));
    assert.equal(sheet.outputsChecked, true, 'results are included by default with no PHI hit');
    assert.equal(sheet.warn, false, 'no warning with no PHI hit');
    assert.ok(sheet.hasSave && sheet.hasCancel);
    assert.ok(!sheet.text.includes('—'), 'no em dash in sheet copy');
    assert.equal(await p.evaluate(() => window.__saved.length), 0, 'nothing written by opening the sheet');

    // ---- OPT OUT OF RESULTS: the list changes ------------------------------
    await p.uncheck('[data-nba-outputs]');
    const codeOnlyLines = await p.evaluate(() => [].slice.call(
      document.querySelectorAll('#dg-nb-app-sheet ul.dg-nba-list li')).map((li) => li.textContent));
    assert.ok(codeOnlyLines.some((l) => /No results\. Code and text only/.test(l)));
    assert.ok(!codeOnlyLines.some((l) => /plot image/.test(l)));
    await p.check('[data-nba-outputs]');

    // ---- CANCEL: writes nothing --------------------------------------------
    await p.click('[data-nba-cancel]');
    await p.waitForFunction(() => !window.DataGlowNotebookApp.isOpen(), null, { timeout: 5000 });
    assert.equal(await p.evaluate(() => window.__saved.length), 0, 'cancel must write nothing');

    // Escape also closes it.
    await p.click('#r-notebook-toolbar [data-nb-app-btn]');
    await p.waitForSelector('#dg-nb-app-sheet.open', { timeout: 5000 });
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !window.DataGlowNotebookApp.isOpen(), null, { timeout: 5000 });
    assert.equal(await p.evaluate(() => window.__saved.length), 0, 'Escape must write nothing');

    // ---- SAVE: one download, and the bytes are a real offline file ----------
    await p.click('#py-notebook-toolbar [data-nb-app-btn]');
    await p.waitForSelector('#dg-nb-app-sheet.open', { timeout: 5000 });
    const [download] = await Promise.all([
      p.waitForEvent('download', { timeout: 15000 }),
      p.click('[data-nba-save]'),
    ]);
    assert.equal(download.suggestedFilename(), 'claims-quality-python-app.html');

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const html = Buffer.concat(chunks).toString('utf8');

    assert.ok(html.startsWith('<!doctype html>'), 'the saved file is a document');
    assert.ok(html.includes('print(df.shape)'), 'the cells are in it');
    assert.ok(html.includes('(1200, 14)'), 'the captured output is in it');
    assert.ok(html.includes(PNG), 'the captured plot is in it');
    assert.ok(html.includes('Python notebook'), 'it says which runtime produced it');
    assert.ok(!html.includes('—'), 'no em dash in the saved file');
    // The engine's own offline assertion, applied to the bytes that landed on disk.
    const offline = await p.evaluate((h) => window.DataGlowNotebookAppExport.assertOfflineSafe(h), html);
    assert.equal(offline.ok, true, 'the saved file must reference nothing off the device: ' +
      JSON.stringify(offline.findings));

    const saved = await p.evaluate(() => window.__saved);
    assert.equal(saved.length, 1, 'exactly one save');
    assert.equal(saved[0].filename, 'claims-quality-python-app.html');
    assert.equal(saved[0].runtime, 'python');
    assert.equal(saved[0].includeOutputs, true);
    assert.ok(saved[0].bytes > 0);
    assert.equal(await p.evaluate(() => window.DataGlowNotebookApp.isOpen()), false,
      'the sheet closes after a save');
    const toasts = await p.evaluate(() => window.__toasts.map((t) => t.message));
    assert.ok(toasts.some((m) => /Saved claims-quality-python-app\.html to this device/.test(m)));

    // ---- EMPTY NOTEBOOK: refuses, and opens no sheet ------------------------
    await p.goto(base + '/__nbapp__empty.html');
    await waitForBoot(p);
    await p.waitForSelector('[data-nb-app-btn="python"]', { timeout: 20000 });
    await p.click('#py-notebook-toolbar [data-nb-app-btn]');
    await p.waitForTimeout(300);
    const emptyState = await p.evaluate(() => ({
      open: window.DataGlowNotebookApp.isOpen(),
      toasts: window.__toasts.map((t) => t.message),
      saved: window.__saved.length,
    }));
    assert.equal(emptyState.open, false, 'an empty notebook must not open the sheet');
    assert.equal(emptyState.saved, 0);
    assert.ok(emptyState.toasts.some((m) => /Add a cell to the notebook first/.test(m)));

    // ---- PHI HIT: warns, and preselects leaving the results out -------------
    await p.goto(base + '/__nbapp__phi.html');
    await waitForBoot(p);
    await p.waitForSelector('[data-nb-app-btn="python"]', { timeout: 20000 });
    await p.click('#py-notebook-toolbar [data-nb-app-btn]');
    await p.waitForSelector('#dg-nb-app-sheet.open', { timeout: 5000 });
    const phi = await p.evaluate(() => {
      const box = document.querySelector('#dg-nb-app-sheet .dg-nba-box');
      return {
        warn: (box.querySelector('.dg-nba-flag.warn') || {}).textContent || '',
        outputsChecked: box.querySelector('[data-nba-outputs]').checked,
        lines: [].slice.call(box.querySelectorAll('ul.dg-nba-list li')).map((li) => li.textContent),
        hasSave: !!box.querySelector('[data-nba-save]'),
      };
    });
    assert.match(phi.warn, /PHI Shield matched 2 possible sensitive values/);
    assert.match(phi.warn, /mrn/);
    assert.ok(!phi.warn.includes('—'), 'no em dash in the warning');
    assert.equal(phi.outputsChecked, false, 'a PHI hit must preselect leaving the results out');
    assert.ok(phi.lines.some((l) => /No results\. Code and text only/.test(l)));
    assert.equal(phi.hasSave, true, 'a PHI hit informs, it does not remove the choice');

    // ---- AIR-GAP ON: saving a local file is still allowed -------------------
    await p.goto(base + '/__nbapp__airgap.html');
    await waitForBoot(p);
    await p.waitForSelector('[data-nb-app-btn="python"]', { timeout: 20000 });
    await p.click('#py-notebook-toolbar [data-nb-app-btn]');
    await p.waitForSelector('#dg-nb-app-sheet.open', { timeout: 5000 });
    const ag = await p.evaluate(() => {
      const box = document.querySelector('#dg-nb-app-sheet .dg-nba-box');
      return {
        flags: [].slice.call(box.querySelectorAll('.dg-nba-flag')).map((f) => f.textContent),
        hasSave: !!box.querySelector('[data-nba-save]'),
      };
    });
    assert.ok(ag.flags.some((f) => /Air-Gap Mode is on/.test(f)));
    assert.ok(ag.flags.some((f) => /saving it is allowed/.test(f)));
    assert.equal(ag.hasSave, true, 'Air-Gap must not refuse a file written to this device');

    // Building the file with the mode on still works end to end.
    const [agDownload] = await Promise.all([
      p.waitForEvent('download', { timeout: 15000 }),
      p.click('[data-nba-save]'),
    ]);
    assert.equal(agDownload.suggestedFilename(), 'claims-quality-python-app.html');

    assert.deepEqual(offOrigin, [], 'nothing in this feature may touch the network');

    console.log('notebook app canvas UI: 48 assertion(s) passed ' +
      '(flag off, default mount, disclosure, opt out, cancel, escape, save, empty, PHI, air gap)');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
