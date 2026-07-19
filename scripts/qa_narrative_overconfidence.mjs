// Ad-hoc QA script for the Narrative Overconfidence Guard (Story tab). Run with:
//   node scripts/qa_narrative_overconfidence.mjs
// Requires the local server running (pplx-tool start_server, port 8931) and
// flags.manifest.json's narrativeOverconfidenceGuard flag temporarily set to
// true for this run only -- revert to false before commit/PR.
import { chromium } from 'playwright';

const BASE = 'http://localhost:8931';
const results = [];
function log(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Small dataset engineered so a query result has BOTH a strong (high-n, low-
// missing) claim and a weak (low-n, high-missing) claim, so the Story model's
// (or local fallback's) text can be checked against both.
async function loadSampleCsv(page) {
  const rows = ['patient_id,los,payer'];
  // 40 well-populated rows -> strong claim material (grade A/B territory).
  for (let i = 0; i < 40; i++) {
    rows.push(`${i + 1},${4 + (i % 3)},Medicare`);
  }
  // 6 rows with a mostly-missing 'los' -> weak claim material (grade C/D).
  for (let i = 40; i < 46; i++) {
    rows.push(`${i + 1},${i % 2 === 0 ? '' : 30 + i},Medicaid`);
  }
  const csv = rows.join('\n');
  const fileInput = page.locator('#file-input');
  await fileInput.setInputFiles({ name: 'los_sample.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  // DataGlow registers the uploaded CSV in DuckDB under a table name derived
  // from the filename (minus extension) -- 'los_sample.csv' -> 'los_sample'.
  // Give the DuckDB-WASM worker enough time to actually create the table
  // before any SQL tab interaction (1500ms was empirically too short and
  // produced intermittent 'Catalog Error: Table ... does not exist').
  await page.waitForTimeout(3000);
}

async function runQuery(page, sql) {
  await page.locator('[data-testid="tab-sql"]').click();
  await page.waitForTimeout(400);
  const input = page.locator('#sql-input');
  await input.fill(sql);
  await page.locator('[data-testid="button-sql-run"]').click();
  await page.waitForTimeout(1000);
}

async function goToStoryAndGenerate(page) {
  await page.locator('[data-testid="tab-story"]').click();
  await page.waitForTimeout(500);
  const genBtn = page.locator('[data-testid="button-story-generate"]');
  await genBtn.click();
  // Local rule-based fallback is near-instant; on-device model path can take
  // longer if a model was previously cached -- give it a generous window.
  await page.waitForTimeout(4000);
}

async function main() {
  const browser = await chromium.launch();

  // ---------- Desktop pass ----------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await loadSampleCsv(page);

    // Query the payer with the smaller, more-missing group (Medicaid, weak
    // claim territory) so the generated narrative has real grade C/D content
    // for the guard to check.
    await runQuery(page, "SELECT payer, AVG(los) AS avg_los, COUNT(*) AS n FROM los_sample WHERE payer = 'Medicaid' GROUP BY payer;");
    await goToStoryAndGenerate(page);

    const storyClaims = page.locator('#story-claims');
    log('desktop: story claims panel rendered', await storyClaims.count() > 0);

    const guardWrap = page.locator('#story-overconfidence-guard');
    log('desktop: overconfidence guard card exists in DOM', await guardWrap.count() > 0);
    const guardVisible = await guardWrap.isVisible().catch(() => false);
    log('desktop: overconfidence guard card is visible (flag on, claims present)', guardVisible);

    const guardText = guardVisible ? await guardWrap.innerText() : '(not visible)';
    console.log('  guard card text:', JSON.stringify(guardText).slice(0, 300));

    await page.screenshot({ path: '/home/user/workspace/narrative_overconfidence_qa_desktop.png', fullPage: true });
    log('desktop: no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.close();
  }

  // ---------- Mobile pass ----------
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await loadSampleCsv(page);
    await runQuery(page, "SELECT payer, AVG(los) AS avg_los, COUNT(*) AS n FROM los_sample WHERE payer = 'Medicaid' GROUP BY payer;");
    await goToStoryAndGenerate(page);

    const guardWrap = page.locator('#story-overconfidence-guard');
    log('mobile: overconfidence guard card exists in DOM', await guardWrap.count() > 0);
    const guardVisible = await guardWrap.isVisible().catch(() => false);
    log('mobile: overconfidence guard card is visible', guardVisible);

    await page.screenshot({ path: '/home/user/workspace/narrative_overconfidence_qa_mobile.png', fullPage: true });
    log('mobile: no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.close();
  }

  // ---------- Desktop pass-state check (well-populated Medicare group,
  // grade A/B -- guard should render the green 'matches confidence grades'
  // pass message, not warn findings) ----------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await loadSampleCsv(page);
    await runQuery(page, "SELECT payer, AVG(los) AS avg_los, COUNT(*) AS n FROM los_sample WHERE payer = 'Medicare' GROUP BY payer;");
    await goToStoryAndGenerate(page);

    const guardWrap = page.locator('#story-overconfidence-guard');
    const guardVisible = await guardWrap.isVisible().catch(() => false);
    log('desktop (strong claim): overconfidence guard card is visible', guardVisible);
    const guardText = guardVisible ? await guardWrap.innerText() : '(not visible)';
    console.log('  guard card text (strong claim):', JSON.stringify(guardText).slice(0, 300));
    log('desktop (strong claim): renders pass message, not a warn finding', guardText.toLowerCase().includes('matches its own confidence grades'));

    await page.evaluate(() => document.querySelector('#story-overconfidence-guard')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/home/user/workspace/narrative_overconfidence_qa_desktop_pass.png', fullPage: false });
    log('desktop (strong claim): no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
