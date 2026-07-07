// ============================================================
// DATAGLOW — Playwright end-to-end smoke test
// ============================================================
// Boots the real app in a real (headless) Chromium, waits for the DuckDB-WASM
// engine to come alive, loads the built-in golden dataset, runs the 20-layer
// validation suite, and asserts the Validate tab actually populates with
// result cards. This is the closest thing to "a human opened the page and it
// worked" that can run unattended.
//
// WHY a real browser (not jsdom / happy-dom): DATAGLOW's core is DuckDB-WASM,
// which needs a genuine Web Worker + WebAssembly + Blob URL pipeline. Only a
// real browser engine exercises that path.
//
// HEADLESS CAVEAT: some sandboxed/headless environments block the WASM+Worker
// bootstrap and the engine never signals ready — so a local timeout here is
// EXPECTED and not necessarily a product bug. GitHub Actions (real Chrome,
// see .github/workflows/test.yml) is the authoritative source of truth.
//
// RUN WITH:  node test/e2e-smoke.test.mjs

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
  const dot = path.lastIndexOf('.');
  return MIME[path.slice(dot)] || 'application/octet-stream';
}

// Minimal, dependency-free static file server rooted at the repo. Path
// traversal is blocked by resolving against REPO_ROOT and rejecting escapes.
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

async function main() {
  const { server, baseUrl } = await startServer();
  console.log(`▶ static server up at ${baseUrl}`);

  // In CI we point Playwright at the system-installed real Chrome (see the
  // workflow). Locally, fall back to Playwright's bundled Chromium.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();

  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

  let failed = false;
  try {
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
    console.log('▶ page loaded, waiting for DuckDB-WASM engine to signal ready…');

    // Poll for the engine-ready flag, printing elapsed time so a slow (but not
    // hung) WASM boot is visible in CI logs rather than looking frozen.
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      console.log(`  … still waiting (${((Date.now() - startedAt) / 1000).toFixed(0)}s elapsed)`);
    }, 5000);
    try {
      await page.waitForFunction(
        () => window.__dataglowReady === true || typeof window.__dataglowInitError === 'string',
        { timeout: READY_TIMEOUT_MS, polling: 1000 }
      );
    } finally {
      clearInterval(ticker);
    }

    const initError = await page.evaluate(() => window.__dataglowInitError || null);
    if (initError) throw new Error('DuckDB-WASM engine failed to initialize: ' + initError);
    console.log(`✓ engine ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    // Load the built-in golden dataset through the real UI path. The click
    // handler is async, so wait for the dataset to actually register in the
    // sidebar before proceeding (otherwise validation runs with no dataset).
    await page.click('#btn-load-golden');
    console.log('▶ golden dataset load triggered, waiting for it to register…');
    await page.waitForFunction(
      () => document.querySelectorAll('#dataset-list .dataset-item').length > 0,
      { timeout: 30000, polling: 500 }
    );
    console.log('✓ golden dataset loaded');

    // Move to the Validate tab and run the 20-layer suite.
    await page.click('[data-testid="tab-validate"]');
    await page.click('#btn-validate-run');
    console.log('▶ validation run triggered, waiting for result cards…');

    await page.waitForFunction(
      () => document.querySelectorAll('#validation-grid [data-testid^="card-validation-"]').length > 0,
      { timeout: 30000, polling: 500 }
    );

    const cardCount = await page.evaluate(
      () => document.querySelectorAll('#validation-grid [data-testid^="card-validation-"]').length
    );
    if (cardCount > 0) {
      console.log(`✓ Validate tab populated with ${cardCount} layer card(s)`);
    } else {
      failed = true;
      console.log('✗ FAILED: Validate tab produced no result cards');
    }

    // ---- Gen 9 Batch 1 UI smoke checks ----

    // Feature 1: the Domain Physics pack selector is present and defaults to
    // "healthcare", with a "none" option to turn reinterpretation off.
    const packInfo = await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="select-domain-pack"]');
      if (!sel) return null;
      return { value: sel.value, options: Array.from(sel.options).map(o => o.value) };
    });
    if (packInfo && packInfo.value === 'healthcare' && packInfo.options.includes('none')) {
      console.log('✓ Domain pack selector present (default "healthcare", includes "none")');
    } else {
      failed = true;
      console.log('✗ FAILED: Domain pack selector missing or misconfigured: ' + JSON.stringify(packInfo));
    }

    // Feature 2: the two-axis Confidence-Calibrated Grades render with letter grades.
    await page.waitForFunction(
      () => {
        const i = document.querySelector('[data-testid="grade-integrity-grade"]');
        const p = document.querySelector('[data-testid="grade-plausibility-grade"]');
        return i && p && /[A-F]/.test(i.textContent) && /[A-F]/.test(p.textContent);
      },
      { timeout: 15000, polling: 500 }
    );
    const grades = await page.evaluate(() => ({
      integrity: document.querySelector('[data-testid="grade-integrity-grade"]').textContent.trim(),
      plausibility: document.querySelector('[data-testid="grade-plausibility-grade"]').textContent.trim(),
    }));
    console.log(`✓ Two-axis grades rendered (Integrity=${grades.integrity}, Plausibility=${grades.plausibility})`);

    // ---- Quality-grade visual hierarchy (IA fix) ----
    // The three coexisting "how good is this data" surfaces are now ranked:
    //   1. Overall combined grade = the prominent headline (seen first, largest);
    //   2. Integrity/Domain breakdown = one tap away, expanded by default;
    //   3. legacy confidence ring + CAT scorecard = under a collapsed
    //      Advanced/Legacy disclosure (de-prioritised, not deleted).

    // 1. PRIMARY: the Overall headline renders with a letter grade and appears
    //    visually before (above) the Integrity/Domain breakdown cards.
    const hierarchy = await page.evaluate(() => {
      const overall = document.querySelector('[data-testid="grade-overall-grade"]');
      const breakdown = document.querySelector('[data-testid="grade-breakdown"]');
      const headline = document.querySelector('[data-testid="overall-headline"]');
      const integrity = document.querySelector('[data-testid="grade-integrity"]');
      if (!overall || !breakdown || !headline || !integrity) return null;
      const overallFont = parseFloat(getComputedStyle(overall).fontSize) || 0;
      const integrityGrade = document.querySelector('[data-testid="grade-integrity-grade"]');
      const integrityFont = parseFloat(getComputedStyle(integrityGrade).fontSize) || 0;
      // Position: headline top must be above the breakdown top.
      const headlineTop = headline.getBoundingClientRect().top;
      const breakdownTop = breakdown.getBoundingClientRect().top;
      return {
        overallGrade: overall.textContent.trim(),
        overallFont, integrityFont,
        headlineAboveBreakdown: headlineTop < breakdownTop,
        breakdownOpen: breakdown.open === true,
      };
    });
    if (hierarchy && /[A-F]/.test(hierarchy.overallGrade)
        && hierarchy.overallFont > hierarchy.integrityFont
        && hierarchy.headlineAboveBreakdown && hierarchy.breakdownOpen) {
      console.log(`✓ Overall grade is the headline (grade=${hierarchy.overallGrade}, `
        + `font ${hierarchy.overallFont}px > breakdown ${hierarchy.integrityFont}px, above & breakdown open)`);
    } else {
      failed = true;
      console.log('✗ FAILED: Overall grade hierarchy incorrect: ' + JSON.stringify(hierarchy));
    }

    // 3. ADVANCED/LEGACY: the disclosure exists and is COLLAPSED by default, yet
    //    still contains the fully-rendered legacy confidence ring + CAT scorecard.
    const legacy = await page.evaluate(() => {
      const adv = document.querySelector('[data-testid="advanced-legacy"]');
      if (!adv) return null;
      const cat = adv.querySelector('#cat-scorecard');
      const ring = adv.querySelector('#confidence-summary');
      const ringScore = adv.querySelector('#confidence-score');
      return {
        collapsedByDefault: adv.open === false,
        containsCat: !!cat && cat.children.length > 0,
        containsRing: !!ring,
        ringScore: ringScore ? ringScore.textContent.trim() : null,
      };
    });
    if (legacy && legacy.collapsedByDefault && legacy.containsCat
        && legacy.containsRing && /\d/.test(legacy.ringScore || '')) {
      console.log(`✓ Advanced/Legacy section collapsed by default, still contains `
        + `CAT scorecard + confidence ring (score=${legacy.ringScore})`);
    } else {
      failed = true;
      console.log('✗ FAILED: Advanced/Legacy disclosure incorrect: ' + JSON.stringify(legacy));
    }

    // The legacy views must remain reachable: expanding the disclosure reveals
    // the confidence ring (proving it is de-prioritised, not removed/broken).
    await page.click('[data-testid="advanced-legacy"] > summary');
    const ringVisible = await page.evaluate(() => {
      const ring = document.querySelector('#confidence-summary');
      if (!ring) return false;
      return ring.getBoundingClientRect().height > 0;
    });
    if (ringVisible) {
      console.log('✓ Expanding Advanced/Legacy reveals the legacy confidence ring (still functional)');
    } else {
      failed = true;
      console.log('✗ FAILED: legacy confidence ring not visible after expanding disclosure');
    }

    // Feature 3: the Export Attestation button is present and clickable (it
    // triggers a client-side download; we assert it exists and does not throw).
    const attBtn = await page.$('[data-testid="button-attestation-export"]');
    if (attBtn) {
      await attBtn.click();
      console.log('✓ Export Attestation button present and clickable');
    } else {
      failed = true;
      console.log('✗ FAILED: Export Attestation button missing');
    }

    // ---- Gen 9 Batch 3 feature smoke checks ----
    const expectDownload = async (label, doTrigger) => {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        doTrigger(),
      ]);
      const name = download.suggestedFilename();
      console.log(`✓ ${label} → download "${name}"`);
      return name;
    };

    // Feature 9 — IRB / Compliance export (validation already ran). Downloads HTML.
    await expectDownload('IRB export', () => page.click('[data-testid="button-export-irb"]'));

    // Feature 8 — Federated Fingerprint export. Downloads JSON.
    await page.click('[data-testid="tab-diff"]');
    await expectDownload('Fingerprint export', () => page.click('[data-testid="button-fp-export"]'));

    // Feature 7 — Data Time Machine: save a snapshot and confirm it lists.
    await page.click('[data-testid="button-tm-save"]');
    await page.waitForFunction(
      () => document.querySelectorAll('#tm-list [data-testid^="tm-snap-"]').length > 0,
      { timeout: 15000, polling: 500 }
    );
    console.log('✓ Time Machine snapshot saved and listed');

    // Feature 6 — Synthetic Adversarial Twin: open Red Team modal, generate.
    await page.click('#btn-red-team');
    await page.click('[data-testid="button-twin-generate"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="twin-summary"]') &&
            getComputedStyle(document.querySelector('[data-testid="twin-disclaimer"]')).display !== 'none',
      { timeout: 20000, polling: 500 }
    );
    console.log('✓ Synthetic Twin generated with disclaimer shown');
  } catch (err) {
    failed = true;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    try {
      await page.screenshot({ path: join(REPO_ROOT, 'test', 'e2e-failure.png'), fullPage: true });
      console.log('  saved screenshot → test/e2e-failure.png');
    } catch { /* ignore screenshot errors */ }
    console.log('  --- browser console ---');
    for (const line of consoleLines.slice(-40)) console.log('  ' + line);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed ? '\nE2E SMOKE: FAILED' : '\nE2E SMOKE: PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\n✗ UNEXPECTED ERROR — e2e run aborted:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
