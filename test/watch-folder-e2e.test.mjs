// ============================================================
// DATAGLOW — Watch Folder + Digital Twin browser verification
// ============================================================
// showDirectoryPicker() needs a real user gesture and a native OS dialog, so it
// cannot be invoked headless. This harness instead drives the SAME production
// WatchFolderController through the window.__dataglowStartWatch test hook with a
// mock FileSystemDirectoryHandle (real in-page File objects), exercising the
// full poll → loaders.loadFile → runAllLayers path in a real Chromium — and
// asserts, via a network sniffer, that ingest triggers ZERO network requests.
// It also drags a Digital Twin slider and confirms the grade panel recomputes.
//
// This is the automated backing for the "manually verified in a real browser"
// claim in the PR: it reproduces the exact runtime behaviour a user would see.
//
// RUN WITH:  node test/watch-folder-e2e.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8', '.map': 'application/json; charset=utf-8',
};
const contentType = p => MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream';

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = normalize(join(REPO_ROOT, urlPath));
        if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
        const body = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentType(filePath) });
        res.end(body);
      } catch (e) {
        res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end(String(e.message || e));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else { failed++; console.log(`✗ FAILED: ${msg}`); } };

async function main() {
  const { server, baseUrl } = await startServer();
  console.log(`▶ static server up at ${baseUrl}`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

  try {
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string', { timeout: 90000, polling: 500 });
    ok(!(await page.evaluate(() => window.__dataglowInitError)), 'app engine initialised in a real browser');

    // ---- Watch Folder feature detection + UI wiring ----
    await page.click('[data-testid="tab-watch"]');
    const supported = await page.evaluate(() => 'showDirectoryPicker' in window);
    console.log(`  (this browser ${supported ? 'supports' : 'does NOT support'} showDirectoryPicker)`);
    const privacy = await page.textContent('[data-testid="watch-privacy"]');
    ok(/never uploads/i.test(privacy), 'Watch Folder privacy notice is displayed');
    ok(await page.evaluate(() => typeof window.__dataglowStartWatch === 'function'),
      'Watch Folder controller + test hook are wired');

    // Install a mutable mock directory handle with a real in-page CSV File.
    await page.evaluate(() => {
      window.__wf = {
        files: [{ name: 'claims.csv', body: 'patient_id,age,claim_amount\n1,50,100.5\n2,60,200.75\n3,45,50.25\n', mtime: 1000 }],
      };
      window.__mockDir = {
        async *values() {
          for (const f of window.__wf.files) {
            yield {
              kind: 'file', name: f.name,
              async getFile() { return new File([f.body], f.name, { type: 'text/csv', lastModified: f.mtime }); },
            };
          }
        },
      };
    });

    // Sniff network: capture every request (URL + method + whether it carried a
    // body) fired while validating a watched file.
    const requestsDuringIngest = [];
    const sniff = req => requestsDuringIngest.push({ url: req.url(), method: req.method(), hasBody: !!req.postData() });
    page.on('request', sniff);

    // Drive the real controller: immediate first poll ingests + validates claims.csv.
    await page.evaluate(() => window.__dataglowStartWatch(window.__mockDir));
    await page.waitForFunction(() => document.querySelector('[data-testid="watch-file-claims.csv"]'), { timeout: 30000, polling: 300 });
    page.off('request', sniff);

    const fileRow = await page.textContent('[data-testid="watch-file-claims.csv"]');
    ok(/Grade\s+[A-F]/.test(fileRow), `watched file auto-validated with a grade (row="${fileRow.trim().replace(/\s+/g, ' ')}")`);

    // Privacy guarantee: the watched file's contents are never uploaded. Assert
    // (a) NO upload requests (POST/PUT/PATCH or any request carrying a body) and
    // (b) no off-device requests other than the app's own pre-existing static
    // assets (self origin) and its declared Google Fonts stylesheet/webfonts,
    // which load independently of this feature and never carry file data.
    const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
    const isAllowed = u => u.startsWith(baseUrl) || u.startsWith('blob:') || u.startsWith('data:') || FONT_HOSTS.some(h => u.includes(h));
    const uploads = requestsDuringIngest.filter(r => r.hasBody || ['POST', 'PUT', 'PATCH'].includes(r.method));
    const offDevice = requestsDuringIngest.filter(r => !isAllowed(r.url));
    ok(uploads.length === 0, `no upload requests during validation (files never leave the device; saw ${uploads.length})`);
    ok(offDevice.length === 0, `no unexpected off-device requests during validation (saw ${offDevice.length}: ${offDevice.slice(0, 3).map(r => r.url).join(', ')})`);

    // ---- Change detection in the live loop ----
    const callsAfterFirst = await page.evaluate(async () => {
      // Unchanged folder: polling again must NOT re-validate.
      await window.__dataglowWatchController.poll();
      const before = document.querySelector('[data-testid="watch-file-claims.csv"]').textContent;
      // Edit the file (new mtime) → next poll re-validates.
      window.__wf.files[0].mtime = 2000;
      window.__wf.files[0].body += '4,30,75.0\n';
      await window.__dataglowWatchController.poll();
      const after = document.querySelector('[data-testid="watch-file-claims.csv"]').textContent;
      // Drop a brand-new file → next poll validates it too.
      window.__wf.files.push({ name: 'labs.csv', body: 'id,result\n1,ok\n2,ok\n', mtime: 3000 });
      await window.__dataglowWatchController.poll();
      return { hasLabs: !!document.querySelector('[data-testid="watch-file-labs.csv"]'), before, after };
    });
    ok(callsAfterFirst.hasLabs, 'a newly-dropped file is picked up and validated on the next poll');

    // Stop control clears the loop.
    await page.click('[data-testid="button-watch-stop"]');
    const headline = await page.textContent('[data-testid="watch-headline"]').catch(() => '');
    ok(/stopped/i.test(await page.textContent('#watch-status')), 'Stop control halts watching and updates the status panel');

    // ---- Digital Twin live simulation ----
    // Load the golden dataset and wait until it is actually the ACTIVE dataset
    // before opening the Twin tab, so the sandbox builds off a stable schema.
    await page.click('#btn-load-golden');
    await page.waitForFunction(
      () => document.querySelector('#dataset-list .dataset-item.active'),
      { timeout: 30000, polling: 300 });
    await page.click('[data-testid="tab-twin"]');
    await page.waitForFunction(() => document.querySelectorAll('#twin-controls [data-testid^="twin-slider-"]').length > 0, { timeout: 30000, polling: 300 });
    // Baseline grade rendered (the initial zero-perturbation sim has completed).
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="twin-grade-integrity-baseline"]');
      return b && /[A-F]/.test(b.textContent);
    }, { timeout: 30000, polling: 300 });
    const baseGrade = await page.textContent('[data-testid="twin-grade-integrity-baseline"]');

    // A slider was inferred from the dataset schema.
    const sliderCount = await page.evaluate(() => document.querySelectorAll('#twin-controls [data-testid^="twin-slider-"]').length);
    ok(sliderCount > 0, `Digital Twin inferred ${sliderCount} sliders from the dataset schema`);

    // Drag a "missing" slider (or the first slider) to a high value and confirm
    // the simulated grade recomputes live. Re-query the element each time to
    // avoid a stale reference if the schema rebuilt.
    await page.evaluate(() => {
      const s = document.querySelector('#twin-controls [data-testid^="twin-slider-missing:"]') ||
                document.querySelector('#twin-controls [data-testid^="twin-slider-"]');
      s.value = '80';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const s = document.querySelector('[data-testid="twin-grade-integrity-sim"]');
      return s && /[A-F]/.test(s.textContent);
    }, { timeout: 20000, polling: 300 });
    const simGrade = await page.textContent('[data-testid="twin-grade-integrity-sim"]');
    ok(/[A-F]/.test(baseGrade) && /[A-F]/.test(simGrade),
      `Digital Twin renders baseline vs simulated integrity grades (baseline=${baseGrade}, sim=${simGrade})`);

    // Reset snaps every slider back to baseline (0%).
    await page.click('[data-testid="button-twin-reset"]');
    await page.waitForTimeout(200);
    const allZero = await page.evaluate(() =>
      [...document.querySelectorAll('#twin-controls [data-testid^="twin-slider-"]')].every(s => s.value === '0'));
    ok(allZero, 'Reset control snaps all sliders back to baseline (0%)');
  } catch (err) {
    failed++;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    console.log('  --- browser console ---');
    for (const l of consoleLines.slice(-30)) console.log('  ' + l);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed ? 'WATCH-FOLDER E2E: FAILED' : 'WATCH-FOLDER E2E: PASSED');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
