// ============================================================
// DATAGLOW - Mobile viewport smoke over the real canvas (B57 artifact)
// ============================================================
// WHY THIS EXISTS
// B57 is not defined anywhere in this repository. Every doc, manifest and
// changelog was searched and there is no B-series numbering at all; the factory
// notes use "Batch". BUNDLE5_SPEC.md says in that case to ship a durable mobile
// QA script and a CI-friendly smoke that catches layout and flag regressions on
// narrow viewports, and not to claim B57 without a real artifact. This file and
// docs/mobile-qa-checklist.md are that artifact.
//
// WHAT IT PROVES, and why each one is worth a test rather than a checklist line
//   1. NO HORIZONTAL TRAP. At three phone widths the document must not scroll
//      sideways. This is the single failure that makes a phone unusable, it is
//      invisible on a laptop, and one absolutely-positioned panel added without
//      a width cap reintroduces it. Asserted on the REAL canvas/index.html, not
//      a fixture, because the bug only appears when everything is on the page
//      at once.
//   2. THE CORE CHROME MOUNTS. Air-Gap, Trust and Explain are the buttons the
//      spec calls the core path, and a flag regression or a boot-order change
//      silently unmounts them. Their absence at phone width would otherwise be
//      noticed by a user before a test.
//   3. EVERY VISIBLE CONTROL IN THAT CHROME CLEARS 44px. Below that a thumb
//      misses. Checked by measurement, so a CSS edit that shrinks a button
//      fails here.
//   4. GLASSBOX MOUNTS ON THE REAL SURFACES. The acceptance bar is two; this
//      asserts the blocks attach to the actual canvas DOM ids rather than the
//      ids a test fixture invented.
//   5. NO NEW NETWORK DEPENDENCY. The canvas requests exactly one off-origin
//      resource, the Google Fonts stylesheet, which predates this bundle. A
//      second one appearing is a regression worth failing on, and this is the
//      only place that would catch it.
//   6. NO PAGE ERROR AT PHONE WIDTH. A throw during boot on a narrow viewport
//      leaves half the chrome unmounted.
//
// It loads canvas/index.html from a local server with every off-origin request
// aborted, so it runs offline and in CI without a network.
//
// RUN WITH:  node test/mobile-viewport-smoke.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));

/* Three widths, each chosen for a reason:
     360  the narrowest Android still in wide use, and the worst case
     390  the iPhone class most analysts carry
     700  the house breakpoint itself, where a rule either applies or does not
          and an off-by-one shows up */
const VIEWPORTS = [
  { name: 'android-360', width: 360, height: 800 },
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'breakpoint-700', width: 700, height: 900 },
];

/* The one off-origin request the canvas already made before this bundle. Listed
   rather than allowed by pattern so a different font host is still a failure. */
const KNOWN_OFF_ORIGIN = [
  'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap',
];

/* The chrome the spec calls the core analyst path. Each must mount, and each
   must be tappable. */
const CORE_CHROME = [
  { id: 'dg-air-gap-btn', why: 'Air-Gap Mode is how a person in a locked room trusts the app' },
  { id: 'dg-trust-ledger-btn', why: 'Trust is where what happened is on the record' },
  { id: 'dg-explain-btn', why: 'Explain is the plain-language door into all of it' },
];

/* Sorted, and compared sorted below. These are collected in document order, and
   the Python result surface happens to sit above the SQL tab in the canvas, so
   asserting a fixed order would be asserting the page's layout rather than that
   every surface got a block. */
const GLASS_BOX_HOSTS = ['py-view', 'sql-tab', 'sql-view'];

const MIN_TARGET = 44;

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks += 1; }
function eq(a, b, msg) { assert.equal(a, b, msg); checks += 1; }

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath === '/' ? '/canvas/index.html' : urlPath;
      // Everything is served from inside the repo; a path leaving it is a 404
      // rather than a read.
      const abs = normalize(join(REPO_ROOT, rel));
      if (!abs.startsWith(REPO_ROOT)) {
        res.writeHead(403).end('outside the repo');
        return;
      }
      try {
        const body = await readFile(abs);
        const ext = rel.slice(rel.lastIndexOf('.'));
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* One pass over the loaded canvas at one width. Returns everything the
   assertions need, measured in the page so nothing is inferred. */
function inspect(minTarget) {
  const de = document.documentElement;
  const width = de.clientWidth;

  const chrome = {};
  for (const id of ['dg-air-gap-btn', 'dg-trust-ledger-btn', 'dg-explain-btn']) {
    const el = document.getElementById(id);
    chrome[id] = el
      ? { mounted: true, height: Math.round(el.getBoundingClientRect().height) }
      : { mounted: false, height: 0 };
  }

  /* Only controls that are actually on screen are measured. An off-canvas
     drawer legitimately reports a zero box, and failing on it would push
     everyone toward asserting nothing. */
  const small = [];
  const scope = document.querySelectorAll(
    '#dg-air-gap-btn, #dg-trust-ledger-btn, #dg-explain-btn,'
    + ' #dg-explain-panel button, [data-gb-host] button',
  );
  for (const el of scope) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (el.offsetParent === null) continue;
    if (Math.round(r.height) < minTarget) {
      small.push({ id: el.id || String(el.className).slice(0, 40), height: Math.round(r.height) });
    }
  }

  const blocks = Array.from(document.querySelectorAll('[data-gb-host]'))
    .map((b) => b.getAttribute('data-gb-host'));

  return {
    width,
    overflow: de.scrollWidth - de.clientWidth,
    chrome,
    small,
    blocks,
    apis: {
      explain: !!window.DataGlowExplain,
      glassBox: !!window.DataGlowGlassBox,
      explainEngine: !!window.DataGlowExplainEngine,
      glassBoxEngine: !!window.DataGlowGlassBoxEngine,
    },
  };
}

async function run() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });

  const results = [];
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.width < 700,
        hasTouch: true,
      });
      const offOrigin = [];
      await ctx.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(base)) return route.continue();
        offOrigin.push(url);
        return route.abort();
      });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e).slice(0, 200)));

      await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
      // The canvas surfaces boot on staggered timers, the last of them at
      // 880ms. Waiting past that is the difference between testing the app and
      // testing an empty page.
      await p.waitForFunction(
        () => !!window.DataGlowExplain && !!window.DataGlowGlassBox,
        null, { timeout: 30000 },
      );
      await p.waitForTimeout(1400);

      const seen = await p.evaluate(inspect, MIN_TARGET);
      results.push({ vp, seen, errors, offOrigin });
      await ctx.close();
    }

    for (const { vp, seen, errors, offOrigin } of results) {
      const at = `at ${vp.name} (${vp.width}px)`;

      eq(errors.length, 0, `no script may throw while booting ${at}: ${errors.join(' | ')}`);

      ok(seen.overflow <= 0,
        `the page must not scroll sideways ${at}, it overflowed by ${seen.overflow}px`);

      for (const entry of CORE_CHROME) {
        const got = seen.chrome[entry.id];
        eq(got.mounted, true, `${entry.id} must mount ${at}: ${entry.why}`);
      }

      assert.deepEqual(seen.small, [],
        `every visible control must clear ${MIN_TARGET}px ${at}, saw ${JSON.stringify(seen.small)}`);
      checks += 1;

      assert.deepEqual(seen.blocks.slice().sort(), GLASS_BOX_HOSTS,
        `GlassBox must mount on every real result surface ${at}, saw ${JSON.stringify(seen.blocks)}`);
      checks += 1;
      ok(seen.blocks.length >= 2, `the acceptance bar is two GlassBox surfaces ${at}`);

      eq(seen.apis.explain, true, `window.DataGlowExplain must be published ${at}`);
      eq(seen.apis.glassBox, true, `window.DataGlowGlassBox must be published ${at}`);
      eq(seen.apis.explainEngine, true, `the Explain engine must be published ${at}`);
      eq(seen.apis.glassBoxEngine, true, `the GlassBox engine must be published ${at}`);

      const unexpected = offOrigin.filter((u) => !KNOWN_OFF_ORIGIN.includes(u));
      assert.deepEqual(unexpected, [],
        `the canvas must gain no new off-origin dependency ${at}, saw ${unexpected.join(', ')}`);
      checks += 1;
    }

    console.log(`mobile viewport smoke: ${checks} assertion(s) passed across `
      + VIEWPORTS.map((v) => v.name).join(', ')
      + ' (no horizontal trap, core chrome mounted, 44px targets, GlassBox on 3 surfaces, no new network)');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
