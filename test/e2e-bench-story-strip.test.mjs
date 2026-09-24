// ============================================================
// DATAGLOW — The Bench: dataset story strip e2e (real Chromium)
// ============================================================
// Batch 2 wired js/app-shell/bench-shell.js's pure lineage algebra (Batch 1,
// PR #670) into the live app: an upload step is logged when a dataset loads,
// a sql step when a query runs, and the SAME lineage renders identically
// into #bench-story-sql / #bench-story-python / #bench-story-r — proving
// this is one continuous story, not three separate per-tab histories.
//
// This test only exercises the SQL tab's run path (not Python/R): those
// notebook runtimes download Pyodide/WebR from a public CDN on first run,
// which would make this test flaky/slow in CI for no extra coverage — the
// logBenchStep() call sites in the Python/R run handlers are identical in
// shape to the SQL one (see main.js), and are covered by direct code
// inspection plus the shared renderBenchStoryStrip()/logBenchStep() unit
// tests in test/bench-shell.test.mjs. What this test uniquely proves is the
// cross-tab rendering: that switching tabs shows the SAME lineage, not that
// each runtime can independently produce a step.
//
// RUN WITH:  node test/e2e-bench-story-strip.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const READY_TIMEOUT_MS = 90000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentType(path) {
  const ext = path.slice(path.lastIndexOf('.'));
  return MIME[ext] || 'application/octet-stream';
}

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
        res.writeHead(e.code === 'ENOENT' ? 404 : 500);
        res.end(String(e.message || e));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function gotoAndInitEngine(page, baseUrl) {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string',
    { timeout: READY_TIMEOUT_MS, polling: 1000 }
  );
  const initError = await page.evaluate(() => window.__dataglowInitError || null);
  if (initError) throw new Error('DuckDB-WASM engine failed to initialize: ' + initError);
}

async function loadGoldenDataset(page) {
  await page.click('#btn-load-golden');
  await page.waitForFunction(
    () => document.querySelectorAll('#dataset-list .dataset-item').length > 0,
    { timeout: 30000, polling: 500 }
  );
}

async function runSql(page, sql) {
  await page.fill('#sql-input', sql);
  await page.click('#btn-sql-run');
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#sql-status');
      const wrap = document.querySelector('#sql-result-wrap');
      const errored = wrap && wrap.querySelector('[data-testid="sql-error"]');
      return errored || (status && /row\(s\)/i.test(status.textContent));
    },
    { timeout: 30000, polling: 250 }
  );
}

async function disableServiceWorker(page) {
  // sw.js intercepts same-origin fetches at the SW layer, which page.route
  // cannot see through — the flags.manifest.json route below would silently
  // never fire with the SW active. Same pattern as e2e-rigor-engine-badges.
  await page.addInitScript(() => {
    try {
      delete Object.getPrototypeOf(navigator).serviceWorker;
      Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
      delete navigator.serviceWorker;
    } catch (e) { /* ignore on engines where this isn't deletable */ }
  });
}

async function main() {
  const { server, baseUrl } = await startServer();
  console.log(`▶ static server up at ${baseUrl}`);

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'],
  });

  // ---- Page 1: flag OFF (the shipped default) — no story strip anywhere ----
  {
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

    try {
      await gotoAndInitEngine(page, baseUrl);
      await loadGoldenDataset(page);
      await page.click('[data-testid="tab-sql"]');
      await runSql(page, 'SELECT 1;');

      const mountsHidden = await page.evaluate(() => {
        const ids = ['#bench-story-sql', '#bench-story-python', '#bench-story-r'];
        return ids.every((id) => {
          const el = document.querySelector(id);
          return el && el.style.display === 'none' && el.innerHTML.trim() === '';
        });
      });
      ok(mountsHidden, 'flag OFF (default): all three story-strip mounts stay hidden and empty after a real dataset load + SQL run');

      const pageErrors = consoleLines.filter(l => l.startsWith('[pageerror]'));
      ok(pageErrors.length === 0, `flag OFF: no page errors thrown (${pageErrors.length} found)`);
    } finally {
      await page.close();
    }
  }

  // ---- Page 2: flag ON (forced via route intercept, byte-for-byte code unchanged) ----
  {
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

    await disableServiceWorker(page);
    await page.route('**/flags.manifest.json', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (body.flags && body.flags.theBench) body.flags.theBench.enabled = true;
      await route.fulfill({ response: res, json: body });
    });

    try {
      await gotoAndInitEngine(page, baseUrl);
      await loadGoldenDataset(page);
      await page.click('[data-testid="tab-sql"]');

      // 1. A fresh dataset load alone should have already logged an "Uploaded" step.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('#bench-story-sql');
          return el && el.style.display !== 'none' && /Uploaded/i.test(el.textContent);
        },
        { timeout: 15000, polling: 250 }
      );
      const sqlStripAfterLoad = await page.evaluate(() => document.querySelector('#bench-story-sql').textContent);
      ok(/Uploaded/i.test(sqlStripAfterLoad), 'flag ON: story strip shows an "Uploaded" step right after the golden dataset loads');

      // 2. Running a SQL query appends a second step, visible in the SAME strip.
      await runSql(page, 'SELECT * FROM golden_test_dataset LIMIT 5;');
      await page.waitForFunction(
        () => {
          const steps = document.querySelectorAll('#bench-story-sql .bench-story-step');
          return steps.length >= 2;
        },
        { timeout: 15000, polling: 250 }
      );
      const stepCountAfterSql = await page.evaluate(() => document.querySelectorAll('#bench-story-sql .bench-story-step').length);
      ok(stepCountAfterSql >= 2, `flag ON: running a SQL query appends a step (now ${stepCountAfterSql} step(s) in the SQL-tab strip)`);

      const lastStepIsCurrent = await page.evaluate(() => {
        const steps = document.querySelectorAll('#bench-story-sql .bench-story-step');
        return steps.length > 0 && steps[steps.length - 1].classList.contains('current');
      });
      ok(lastStepIsCurrent, 'flag ON: the most recent step is visually marked as current');

      // 3. Switch to the Python tab — the SAME lineage (both steps) must appear
      // in that tab's mount too, proving one shared story rather than a
      // per-tab-siloed one. (Not clicking Run Python here — see file header.)
      await page.click('[data-testid="tab-python"]');
      await page.waitForFunction(
        () => document.querySelectorAll('#bench-story-python .bench-story-step').length >= 2,
        { timeout: 15000, polling: 250 }
      );
      const pythonStripText = await page.evaluate(() => document.querySelector('#bench-story-python').textContent);
      const sqlStripTextNow = await page.evaluate(() => document.querySelector('#bench-story-sql').textContent);
      ok(pythonStripText.replace(/\s+/g, ' ').trim() === sqlStripTextNow.replace(/\s+/g, ' ').trim(),
        'flag ON: switching to the Python tab renders the IDENTICAL lineage as the SQL tab (one shared story, not three separate histories)');

      // 4. Switch to the R tab — same check.
      await page.click('[data-testid="tab-r"]');
      await page.waitForFunction(
        () => document.querySelectorAll('#bench-story-r .bench-story-step').length >= 2,
        { timeout: 15000, polling: 250 }
      );
      const rStripText = await page.evaluate(() => document.querySelector('#bench-story-r').textContent);
      ok(rStripText.replace(/\s+/g, ' ').trim() === sqlStripTextNow.replace(/\s+/g, ' ').trim(),
        'flag ON: the R tab also renders the IDENTICAL lineage');

      const pageErrors = consoleLines.filter(l => l.startsWith('[pageerror]'));
      ok(pageErrors.length === 0, `flag ON: no page errors thrown (${pageErrors.length} found)`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nE2E BENCH STORY STRIP: FAILED');
    process.exit(1);
  }
  console.log('\nE2E BENCH STORY STRIP: PASSED');
}

main().catch((err) => {
  console.error('\n✗ UNEXPECTED ERROR — e2e run aborted:');
  console.error(err);
  process.exit(1);
});
