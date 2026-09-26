// ============================================================
// DATAGLOW - Start here rail, mobile-viewport overlap fix (real Chrome, headless)
// ============================================================
// 2026-09-26: live testing on a real mobile viewport found the RECEIPT
// spine rail (js/spine/data-glow-receipt-spine-canvas.js) open by default
// on first load, covering roughly the bottom third of whatever tab was
// open, on every tab -- because it defaults open until the visitor has
// dismissed it once, and a phone-width/short visitor had never had the
// chance to. This test proves the fix: the rail defaults collapsed to its
// existing chip state on a narrow-width OR short-height viewport, stays
// open as before on desktop/tablet, and is still fully reachable (tap the
// chip) and still bounded in height even when a mobile visitor opens it
// on purpose.
//
// RUN WITH:  node test/spine-mobile-viewport.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks += 1; }
function eq(a, b, msg) { assert.equal(a, b, msg); checks += 1; }

function pageHtml() {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<script>window.SQLEngine = { safeTableName: function (n) { return n; } };</script>'
    + '</head><body>'
    + '<script type="module" src="/js/spine/receipt-spine.js"></script>'
    + '<script src="/js/spine/data-glow-receipt-spine-canvas.js"></script>'
    + '</body></html>';
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/__spine_mobile__.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageHtml());
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

async function waitForSpine(p) {
  await p.waitForFunction(() => !!window.DataGlowReceiptSpineUI, null, { timeout: 20000 });
  await p.waitForTimeout(1800); // spine boots on setTimeout(boot, 1200)
}

async function freshPage(ctx, base, viewport) {
  const p = await ctx.newPage();
  await p.setViewportSize(viewport);
  await p.goto(base + '/__spine_mobile__.html');
  // Fresh visitor every time: no SEEN_KEY dismissed-memory from a prior case.
  await p.evaluate(() => { try { localStorage.clear(); } catch (_e) {} });
  await p.reload();
  await waitForSpine(p);
  return p;
}

async function railChipState(p) {
  return p.evaluate(() => {
    const rail = document.getElementById('dg-spine-rail');
    const chip = document.getElementById('dg-spine-chip');
    const rcs = getComputedStyle(rail);
    const ccs = getComputedStyle(chip);
    return {
      railDisplay: rcs.display,
      railMaxHeight: rcs.maxHeight,
      chipDisplay: ccs.display,
    };
  });
}

async function run() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext();
  const consoleErrors = [];
  ctx.on('page', (p) => p.on('pageerror', (err) => consoleErrors.push(String(err))));

  try {
    // ---- Phone portrait widths: rail defaults collapsed to the chip ----
    for (const [w, h, label] of [[390, 844, 'iPhone 14'], [375, 667, 'SE-class'], [414, 896, 'iPhone 11']]) {
      const p = await freshPage(ctx, base, { width: w, height: h });
      const state = await railChipState(p);
      eq(state.railDisplay, 'none', `${label} (${w}x${h}): rail defaults collapsed, not covering the tab`);
      eq(state.chipDisplay, 'block', `${label} (${w}x${h}): chip is visible so the rail is still reachable`);
      await p.close();
    }

    // ---- Small landscape/short viewport (width alone would miss this) ----
    {
      const p = await freshPage(ctx, base, { width: 740, height: 400 });
      const state = await railChipState(p);
      eq(state.railDisplay, 'none', 'wide-but-short 740x400 viewport: rail also defaults collapsed');
      await p.close();
    }

    // ---- Desktop and tablet: unaffected, rail still opens by default -----
    for (const [w, h, label] of [[1400, 900, 'desktop'], [1024, 768, 'iPad landscape'], [768, 1024, 'iPad portrait']]) {
      const p = await freshPage(ctx, base, { width: w, height: h });
      const state = await railChipState(p);
      eq(state.railDisplay, 'block', `${label} (${w}x${h}): rail still opens by default, unaffected by the mobile fix`);
      eq(state.chipDisplay, 'none', `${label} (${w}x${h}): chip stays hidden while the rail is open`);
      await p.close();
    }

    // ---- Manual reopen on mobile still works and stays height-bounded ----
    {
      const p = await freshPage(ctx, base, { width: 390, height: 844 });
      let state = await railChipState(p);
      eq(state.railDisplay, 'none', 'mobile: starts collapsed');
      await p.evaluate(() => { document.getElementById('dg-spine-chip').click(); });
      await p.waitForTimeout(400);
      state = await railChipState(p);
      eq(state.railDisplay, 'block', 'mobile: tapping the chip still opens the rail on purpose');
      const rect = await p.evaluate(() => document.getElementById('dg-spine-rail').getBoundingClientRect());
      ok(rect.height / 844 < 0.5, 'mobile: even intentionally opened, the rail stays under half the viewport height (max-height cap holds)');
      await p.close();
    }

    eq(consoleErrors.length, 0, `no page errors across any viewport (saw: ${consoleErrors.join(' | ')})`);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`spine mobile-viewport overlap fix: ${checks} assertion(s) passed (default-collapsed on narrow/short viewports, unaffected on desktop/tablet, still reachable and height-bounded on mobile).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
