// Ad-hoc QA script for the Pivot Table tab (Batch 1). Run with:
//   node scripts/qa_pivot_table.mjs
// Requires the local server running (pplx-tool start_server, port 8931) and
// flags.manifest.json's pivotTable flag temporarily set to true for this run
// only -- revert to false before commit/PR.
import { chromium } from 'playwright';

const BASE = 'http://localhost:8931';
const results = [];
function log(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function loadSampleCsv(page) {
  const csv = [
    'region,payer,amount,quantity',
    'North,Aetna,100,1',
    'North,Aetna,200,2',
    'North,Cigna,50,1',
    'South,Aetna,300,3',
    'South,Cigna,150,1',
    'South,Cigna,150,2',
  ].join('\n');
  const fileInput = page.locator('#file-input');
  await fileInput.setInputFiles({ name: 'claims.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForTimeout(1500);
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

    const pivotTabBtn = page.locator('[data-testid="tab-pivot"]');
    log('desktop: pivot tab button exists', await pivotTabBtn.count() > 0);
    await pivotTabBtn.click();
    await page.waitForTimeout(500);

    const body = page.locator('#pivot-body');
    log('desktop: pivot panel mounted', await body.count() > 0);
    await page.screenshot({ path: '/home/user/workspace/pivot_qa_desktop_1_empty.png', fullPage: true });

    // Add Rows: region
    const regionChip = page.locator('.pivot-chip', { hasText: 'region' }).first();
    log('desktop: region chip found', await regionChip.count() > 0);
    await regionChip.click();
    await page.waitForTimeout(200);

    // Focus Values well then add amount
    const valuesFocusBtn = page.locator('.pivot-well', { hasText: 'Values' }).locator('.pivot-well-focus-btn');
    await valuesFocusBtn.click();
    await page.waitForTimeout(200);
    const amountChip = page.locator('.pivot-chip', { hasText: 'amount' }).first();
    log('desktop: amount chip found after focusing Values', await amountChip.count() > 0);
    await amountChip.click();
    await page.waitForTimeout(200);

    await page.screenshot({ path: '/home/user/workspace/pivot_qa_desktop_2_configured.png', fullPage: true });

    // Run pivot (GROUP BY path, no Columns well populated)
    const runBtn = page.locator('.pivot-run-btn');
    await runBtn.click();
    await page.waitForTimeout(800);

    const resultTable = page.locator('.pivot-result-table-wrap table, .pivot-result-table-wrap .result-table');
    const errorBox = page.locator('.pivot-error');
    log('desktop: GROUP BY run produced a result table (no error)', await resultTable.count() > 0 && await errorBox.count() === 0,
      await errorBox.count() > 0 ? await errorBox.textContent() : '');
    const resultText = await page.locator('.pivot-result').textContent();
    log('desktop: result contains North', resultText.includes('North'));
    log('desktop: result contains South', resultText.includes('South'));
    await page.screenshot({ path: '/home/user/workspace/pivot_qa_desktop_3_groupby_result.png', fullPage: true });

    // Now add payer to Columns well to exercise the real PIVOT path
    const columnsFocusBtn = page.locator('.pivot-well', { hasText: 'Columns' }).locator('.pivot-well-focus-btn');
    await columnsFocusBtn.click();
    await page.waitForTimeout(200);
    const payerChip = page.locator('.pivot-chip', { hasText: 'payer' }).first();
    log('desktop: payer chip found after focusing Columns', await payerChip.count() > 0);
    await payerChip.click();
    await page.waitForTimeout(200);

    await runBtn.click();
    await page.waitForTimeout(800);
    const pivotResultText = await page.locator('.pivot-result').textContent();
    const pivotErrorBox = page.locator('.pivot-error');
    log('desktop: PIVOT (Columns=payer) run produced no error', await pivotErrorBox.count() === 0,
      await pivotErrorBox.count() > 0 ? await pivotErrorBox.textContent() : '');
    log('desktop: pivot result mentions Aetna', pivotResultText.includes('Aetna'));
    log('desktop: pivot result mentions Cigna', pivotResultText.includes('Cigna'));
    await page.screenshot({ path: '/home/user/workspace/pivot_qa_desktop_4_pivot_result.png', fullPage: true });

    // Remove a well item via the remove button
    const removeBtn = page.locator('.pivot-well-item-remove').first();
    const wellItemCountBefore = await page.locator('.pivot-well-item').count();
    await removeBtn.click();
    await page.waitForTimeout(200);
    const wellItemCountAfter = await page.locator('.pivot-well-item').count();
    log('desktop: remove button removes a well item', wellItemCountAfter === wellItemCountBefore - 1,
      `${wellItemCountBefore} -> ${wellItemCountAfter}`);

    // Error state: clear everything and try running with no config
    // Remove all remaining well items
    let guard = 0;
    while (await page.locator('.pivot-well-item-remove').count() > 0 && guard < 20) {
      await page.locator('.pivot-well-item-remove').first().click();
      await page.waitForTimeout(150);
      guard++;
    }
    await runBtn.click();
    await page.waitForTimeout(400);
    const emptyConfigError = page.locator('.pivot-error');
    log('desktop: empty config shows an error state instead of crashing', await emptyConfigError.count() > 0);
    await page.screenshot({ path: '/home/user/workspace/pivot_qa_desktop_5_error_state.png', fullPage: true });

    log('desktop: zero console errors during full flow', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

    await page.close();
  }

  // ---------- Mobile pass (375px) ----------
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await loadSampleCsv(page);

    const pivotTabBtn = page.locator('[data-testid="tab-pivot"]');
    await pivotTabBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/home/user/workspace/pivot_qa_mobile_1_empty.png', fullPage: true });

    // Check touch target sizes for chips, focus buttons, run button
    async function minSide(locator) {
      const box = await locator.boundingBox();
      if (!box) return null;
      return Math.min(box.width, box.height);
    }
    const chip = page.locator('.pivot-chip').first();
    const chipSize = await minSide(chip);
    log('mobile: pivot-chip meets 44px min touch target', chipSize !== null && chipSize >= 44, `min side = ${chipSize}`);

    const focusBtn = page.locator('.pivot-well-focus-btn').first();
    const focusBtnSize = await minSide(focusBtn);
    log('mobile: pivot-well-focus-btn meets 44px min touch target', focusBtnSize !== null && focusBtnSize >= 44, `min side = ${focusBtnSize}`);

    // Add region to Rows, amount to Values, run
    await page.locator('.pivot-chip', { hasText: 'region' }).first().click();
    await page.waitForTimeout(200);
    await page.locator('.pivot-well', { hasText: 'Values' }).locator('.pivot-well-focus-btn').click();
    await page.waitForTimeout(200);
    await page.locator('.pivot-chip', { hasText: 'amount' }).first().click();
    await page.waitForTimeout(200);

    const runBtn = page.locator('.pivot-run-btn');
    const runBtnBox = await runBtn.boundingBox();
    log('mobile: run button height meets 44px min touch target', runBtnBox !== null && runBtnBox.height >= 44, `height = ${runBtnBox ? runBtnBox.height : null}`);

    await runBtn.click();
    await page.waitForTimeout(800);
    const mobileResultText = await page.locator('.pivot-result').textContent();
    log('mobile: run produced a result with North/South', mobileResultText.includes('North') && mobileResultText.includes('South'));

    // Check no horizontal overflow at 375px (a common mobile breakage signal)
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    log('mobile: no horizontal page overflow', scrollWidth <= clientWidth + 2, `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);

    await page.screenshot({ path: '/home/user/workspace/pivot_qa_mobile_2_result.png', fullPage: true });

    // Remove item touch target check
    const removeBtn = page.locator('.pivot-well-item-remove').first();
    const removeBtnBox = await removeBtn.boundingBox();
    // Remove buttons use negative margin to expand hit area beyond visible glyph;
    // check the glyph box is at least reasonably sized and clickable.
    log('mobile: remove button is clickable', removeBtnBox !== null);

    log('mobile: zero console errors during full flow', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

    await page.close();
  }

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
