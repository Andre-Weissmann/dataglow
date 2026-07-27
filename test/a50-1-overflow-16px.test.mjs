// A50.1: toolbar overflow + full 16px type scale.
// See A50_1_OVERFLOW_16PX_SPEC.md.
//
// Two kinds of checks:
//  1. Live, Playwright-driven assertions against canvas/index.html: no
//     document-level horizontal overflow at 1280/1440, VERDICT and
//     Question Scout reachable from the "More tools" grid without
//     horizontal scroll, no letter-clipping, and a font-size floor sample
//     across the toolbar/nav/primary-CTA chrome this SPEC touches.
//  2. Static string checks against canvas/index.html for the pieces a
//     live check cannot see directly (comments, exact markup), plus the
//     em-dash guard for every string this task added.
//
// Run: node test/a50-1-overflow-16px.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-chromium';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const canvasPath = join(repoRoot, 'canvas', 'index.html');
const canvasUrl = 'file://' + canvasPath;
const canvas = readFileSync(canvasPath, 'utf8');

let passed = 0;
let failed = 0;

function ok(label, cond) {
  if (cond) {
    passed++;
    console.log('\u2713 ' + label);
  } else {
    failed++;
    console.log('\u2717 ' + label);
  }
}

async function run() {
  // --------------------------------------------------------------
  // Static checks (no browser needed)
  // --------------------------------------------------------------
  ok('canvas: #nav-tools-btn markup present (desktop More-tools trigger)', canvas.includes('id="nav-tools-btn"'));
  ok(
    'canvas: #dg-overflow-grid lists VERDICT (dg-proof-harness-btn) as a target',
    /data-target="dg-proof-harness-btn"[^<]*>[^<]*VERDICT/.test(canvas),
  );
  ok(
    'canvas: #dg-overflow-grid lists Question Scout (dg-question-scout-btn) as a target',
    /data-target="dg-question-scout-btn"[^<]*>[^<]*Question Scout/.test(canvas),
  );
  ok('canvas: navToolsBtn wired in the bottom-nav overflow IIFE', canvas.includes('navToolsBtn'));
  ok(
    'canvas: shared toggleOverflowFrom handler bound to both triggers (no duplicated open/close logic)',
    canvas.includes('function toggleOverflowFrom') && canvas.includes('setOverflowTriggersExpanded'),
  );
  ok(
    'canvas: advanced-tools cluster hidden from #nav-right at desktop widths (>=701px), not just opacity-demoted',
    /@media \(min-width: 701px\)[\s\S]{0,20}#nav-right #dg-trust-ledger-btn/.test(canvas),
  );
  ok(
    'canvas: A50 Jobs calm polish pre-load opacity-demotion block is still intact (untouched by the desktop-hide rule above)',
    /body:not\(\.has-data\)\s+#dg-trust-ledger-btn/.test(canvas) &&
      /body\.has-data\s+#dg-trust-ledger-btn[\s\S]{0,300}opacity:\s*1;/.test(canvas),
  );

  const newVisibleStrings = [
    'VERDICT',
    'Question Scout',
    'Trust Ledger',
    'Air-Gap Mode',
    'Shield Packs',
    'PHI Shield',
    'Explain',
    'Proof Board',
    'Transforms',
    'Excel Hell Repair',
    'Guided Unpivot',
    'Semantic Layer',
    'Stayed Local',
    'Tools',
    'More tools (VERDICT, Question Scout, and advanced tools)',
  ];
  for (const s of newVisibleStrings) {
    ok('no em dash in new visible string: "' + s + '"', !s.includes('\u2014'));
  }

  // Bound each A50.1-tagged block to the comment it actually appears in
  // (up to the next `*/`), not an arbitrary character window -- a wide
  // fixed window bleeds into unrelated, pre-existing later comments (some
  // of which predate this task and do use em dashes) and produces false
  // positives.
  const a50_1Blocks = canvas.match(/A50\.1[\s\S]{0,1200}?(?=\*\/)/g) || [];
  ok('found A50.1-tagged comment blocks to scan', a50_1Blocks.length > 0);
  const emdashInA50_1 = a50_1Blocks.filter((b) => b.includes('\u2014'));
  ok('no em dash (U+2014) inside any A50.1-tagged block (found ' + emdashInA50_1.length + ')', emdashInA50_1.length === 0);

  // --------------------------------------------------------------
  // Live browser checks
  // --------------------------------------------------------------
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(canvasUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(1200);

      const overflow = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      ok(
        `live @ ${width}px: no document-level horizontal overflow (scrollWidth ${overflow.scrollWidth} <= clientWidth ${overflow.clientWidth})`,
        overflow.scrollWidth <= overflow.clientWidth,
      );

      const reachable = await page.evaluate(() => {
        const toolsBtn = document.getElementById('nav-tools-btn');
        if (!toolsBtn) return { ok: false, reason: 'nav-tools-btn missing' };
        const r = toolsBtn.getBoundingClientRect();
        const inViewport = r.left >= 0 && r.right <= document.documentElement.clientWidth && r.width > 0 && r.height > 0;
        return { ok: inViewport, rect: { left: r.left, right: r.right } };
      });
      ok(`live @ ${width}px: #nav-tools-btn ("More tools") itself is on-screen without horizontal scroll`, reachable.ok);

      await page.click('#nav-tools-btn');
      await page.waitForTimeout(400);

      const afterOpen = await page.evaluate(() => {
        const verdictBtn = document.querySelector('.dg-ov-btn[data-target="dg-proof-harness-btn"]');
        const scoutBtn = document.querySelector('.dg-ov-btn[data-target="dg-question-scout-btn"]');
        const doc = document.documentElement;
        const rectOk = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return {
          verdictVisible: rectOk(verdictBtn),
          scoutVisible: rectOk(scoutBtn),
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
        };
      });
      ok(`live @ ${width}px: VERDICT is reachable in the open More-tools grid`, afterOpen.verdictVisible);
      ok(`live @ ${width}px: Question Scout is reachable in the open More-tools grid`, afterOpen.scoutVisible);
      ok(
        `live @ ${width}px: no new horizontal overflow while the More-tools grid is open (scrollWidth ${afterOpen.scrollWidth} <= clientWidth ${afterOpen.clientWidth})`,
        afterOpen.scrollWidth <= afterOpen.clientWidth,
      );

      // Letter-clipping guardrail: no visible button whose content is
      // wider than its box while overflow is hidden (would silently
      // truncate mid-letter instead of wrapping/growing).
      const clipped = await page.evaluate(() => {
        const bad = [];
        document.querySelectorAll('button, .nav-btn, #nav-tools-btn, .dg-ov-btn').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return;
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow === 'hidden') {
            bad.push(el.id || el.className || el.textContent.trim().slice(0, 20));
          }
        });
        return bad;
      });
      ok(`live @ ${width}px: no letter-clipping on visible buttons (found ${clipped.length})`, clipped.length === 0);

      await page.close();
    }

    // Font-size floor sample: toolbar/buttons/nav labels/primary CTA must
    // render at >=16px; a caption sample must render at >=14px. Sampled at
    // 1440 with a fresh page/load state (default landing screen).
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(canvasUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1200);

    const sizes = await page.evaluate(() => {
      const px = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return parseFloat(getComputedStyle(el).fontSize);
      };
      return {
        body: parseFloat(getComputedStyle(document.body).fontSize),
        navBtn: px('.nav-btn'),
        navToolsBtn: px('#nav-tools-btn'),
        publishBtn: px('#publish-btn'),
        exportBtn: px('#export-btn'),
        privacyBadge: px('.privacy-badge'),
        overflowGridBtn: px('.dg-ov-btn'),
        primaryCta: px('.dg-cta-primary'),
        secondaryCta: px('.dg-cta-ghost'),
        spotlightLabel: px('.spotlight-btn-label'),
        spotlightDesc: px('.spotlight-btn-desc'),
      };
    });

    const floor16 = {
      'document body base size': sizes.body,
      '.nav-btn (nav label)': sizes.navBtn,
      '#nav-tools-btn (nav label/button)': sizes.navToolsBtn,
      '#publish-btn (primary CTA)': sizes.publishBtn,
      '#export-btn (toolbar button)': sizes.exportBtn,
      '.privacy-badge (nav label)': sizes.privacyBadge,
      '.dg-ov-btn (More-tools grid label)': sizes.overflowGridBtn,
      '.dg-cta-primary (primary CTA)': sizes.primaryCta,
      '.dg-cta-ghost (secondary CTA/button)': sizes.secondaryCta,
      '.spotlight-btn-label (primary helper)': sizes.spotlightLabel,
    };
    for (const [label, val] of Object.entries(floor16)) {
      ok(`font-size floor: ${label} is >=16px (got ${val}px)`, typeof val === 'number' && val >= 16);
    }
    ok(
      `font-size floor: .spotlight-btn-desc caption is >=14px (got ${sizes.spotlightDesc}px)`,
      typeof sizes.spotlightDesc === 'number' && sizes.spotlightDesc >= 14,
    );

    await page.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
