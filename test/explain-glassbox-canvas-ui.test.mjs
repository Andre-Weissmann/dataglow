// ============================================================
// DATAGLOW - Explain + GlassBox canvas UI proof (real Chrome, headless)
// ============================================================
// The pure engines are covered by test/explain-engine.test.mjs and
// test/glass-box.test.mjs. What only a browser can prove is the wiring:
//
//   FLAG OFF: neither surface mounts, but both APIs are still published,
//     because a caller must not have to know whether a panel exists.
//   DEFAULT LOAD: both ship ON, so the Explain button and the three GlassBox
//     blocks mount with no opt-in.
//   GLASSBOX READS THE REAL EDITOR: the code in the panel is the text in the
//     textarea above it, character for character. Nothing is reconstructed.
//   GLASSBOX NEVER GRADES: with no gate present the block is 'unknown' and says
//     the absence out loud, never a passing chip.
//   A REAL GATE BECOMES A REAL CHIP: a Query Sentinel report handed over
//     through provide() drives the level, and PHI Shield's published report is
//     read without being asked for.
//   EXPLAIN COMPOSES WHAT IS THERE: the panel names the sources that answered
//     and the ones that did not, and its confidence follows.
//   EXPLAIN AND GLASSBOX AGREE: both read the same gates, so one cannot call a
//     query clean while the other knows nothing.
//   NO EM DASH: nothing either panel renders carries U+2014.
//   PHONE WIDTH (A14): at 390x844 the Explain panel is the full screen, its
//     head and foot are sticky so Close and Look again stay reachable, every
//     control clears 44px, and neither panel makes the document scroll
//     sideways.
//   NO NETWORK: an off-origin request is a failure. Explain is on-device.
//
// Modules are loaded onto a minimal same-origin page rather than the ~5 MB
// canvas, so this stays fast and tests the code, not the bundle. The canvas
// inlines these exact files and npm run check:canvas-integrity pins the copies.
//
// RUN WITH:  node test/explain-glassbox-canvas-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const EM_DASH = '—';
const PHONE = { width: 390, height: 844 };

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks += 1; }
function eq(a, b, msg) { assert.equal(a, b, msg); checks += 1; }
function match(s, re, msg) { assert.match(s, re, msg); checks += 1; }

const SQL = 'SELECT payer, SUM(amount) AS total\nFROM claims c\nJOIN payers p ON c.payer_id = p.id\nGROUP BY payer';

/* The three result surfaces exactly as canvas/index.html shapes them: a
   textarea holding the code, and a table whose tbody holds the rows a person is
   looking at. Anything the modules read is here; nothing else is. */
function resultSurfaces() {
  return ''
    + '<textarea id="sql-view-input"></textarea>'
    + '<div id="sql-view-results-wrapper"><table>'
    + '<thead id="sql-view-results-thead"></thead><tbody id="sql-view-results-tbody"></tbody>'
    + '</table></div>'
    + '<textarea id="sql-input"></textarea>'
    + '<div id="sql-results-wrapper"><table>'
    + '<thead id="sql-results-thead"></thead><tbody id="sql-results-tbody"></tbody>'
    + '</table></div>'
    + '<textarea id="py-view-input"></textarea>'
    + '<div id="py-result-wrap" class="hidden"><table>'
    + '<thead id="py-result-thead"></thead><tbody id="py-result-tbody"></tbody>'
    + '</table></div>';
}

/* Boot conditions:
     'default'  no flags provider, which is how the app loads.
     'flagoff'  a provider that reports both explain and glassBox disabled.
     'gates'    the two gates the app genuinely publishes, both present: an
                Air-Gap engine reporting on and a PHI Shield report with a hit. */
function page(mode) {
  let extra = '';
  if (mode === 'flagoff') {
    extra += '<script>window.DataGlowFlags={isEnabled:function(n){'
      + 'return n!=="explain"&&n!=="glassBox";}};<\/script>';
  }
  if (mode === 'gates') {
    // Shaped like the real publishers: air-gap-mode.js exposes isAirGapActive,
    // and the PHI Shield canvas exposes getLastReport whose match lives under
    // guard.sensitiveFound. A stub with a different shape would prove nothing.
    extra += '<script>'
      + 'window.DataGlowAirGap={version:1,isAirGapActive:function(){return true;}};'
      + 'window.DataGlowPhiShield={version:1,getLastReport:function(){return {'
      + 'verdict:"review",guard:{sensitiveFound:true,droppedColumns:["mrn"],findingCount:2},'
      + 'patternHitCount:3};}};'
      + 'window.DataGlowTrustLedger={version:1,getEntries:function(){return [{index:0}];}};'
      + '<\/script>';
  }

  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    // border-box on the stub textareas so the horizontal-overflow assertion
    // below measures the panels under test rather than a content-box textarea
    // whose own border pushes the fixture 6px past the viewport.
    + '<style>*{box-sizing:border-box}html,body{margin:0;padding:0}textarea{width:100%}</style>'
    + '</head><body>'
    + '<nav><button id="dg-air-gap-btn">Air-Gap</button></nav>'
    + resultSurfaces()
    + extra
    + '<script>'
    + 'window.__toasts = [];'
    + 'window.showToast = function (m, k) { window.__toasts.push({ message: m, kind: k || "info" }); };'
    + '<\/script>'
    + '<script type="module" src="/js/explain/explain-engine.js"><\/script>'
    + '<script type="module" src="/js/glassbox/glass-box.js"><\/script>'
    + '<script src="/js/glassbox/data-glow-glass-box-canvas.js"><\/script>'
    + '<script src="/js/explain/data-glow-explain-canvas.js"><\/script>'
    + '</body></html>';
}

const MODES = ['default', 'flagoff', 'gates'];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const mode = MODES.find((m) => urlPath === `/__ex__${m}.html`);
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

async function waitForBoth(p) {
  await p.waitForFunction(
    () => !!window.DataGlowExplain && !!window.DataGlowGlassBox
      && !!window.DataGlowExplainEngine && !!window.DataGlowGlassBoxEngine,
    null, { timeout: 20000 },
  );
}

/* Fill one surface the way the canvas renderers do: the code into the textarea,
   the rows into the tbody. */
async function fillSurface(p, opts) {
  await p.evaluate((o) => {
    document.getElementById(o.input).value = o.sql;
    const head = document.getElementById(o.thead);
    const body = document.getElementById(o.tbody);
    head.innerHTML = '<tr>' + o.columns.map((c) => '<th>' + c + '</th>').join('') + '</tr>';
    let html = '';
    for (let i = 0; i < o.rows; i += 1) {
      html += '<tr>' + o.columns.map((_c, j) => '<td>v' + i + '.' + j + '</td>').join('') + '</tr>';
    }
    body.innerHTML = html;
    const wrap = document.getElementById(o.wrap);
    if (wrap) wrap.classList.remove('hidden');
  }, opts);
  await p.waitForTimeout(120); // the MutationObserver refresh is async
}

const SQL_VIEW = {
  input: 'sql-view-input', thead: 'sql-view-results-thead', tbody: 'sql-view-results-tbody',
  wrap: 'sql-view-results-wrapper', sql: SQL, columns: ['payer', 'total'], rows: 4,
};

async function run() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext();
  // Nothing here may reach the network. An attempt is a failure, and also the
  // proof that explaining a result needs no cloud.
  const offOrigin = [];
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    offOrigin.push(url);
    return route.abort();
  });
  const p = await ctx.newPage();

  try {
    // ---- FLAG OFF: nothing mounts, both APIs still published ---------------
    await p.goto(base + '/__ex__flagoff.html');
    await waitForBoth(p);
    await p.waitForTimeout(1200);
    const off = await p.evaluate(() => ({
      exBtn: !!document.getElementById('dg-explain-btn'),
      exPanel: !!document.getElementById('dg-explain-panel'),
      gbBlocks: document.querySelectorAll('[data-gb-host]').length,
      exApi: !!window.DataGlowExplain,
      gbApi: !!window.DataGlowGlassBox,
      opened: window.DataGlowExplain.open(),
      // the engine still composes with the surface unmounted
      composed: window.DataGlowExplain.explain().kind,
    }));
    eq(off.exBtn, false, 'a disabled flag must not mount the Explain button');
    eq(off.exPanel, false, 'a disabled flag must not build the Explain panel');
    eq(off.gbBlocks, 0, 'a disabled flag must mount no GlassBox block');
    eq(off.exApi, true, 'the Explain API is published even with the surface unmounted');
    eq(off.gbApi, true, 'the GlassBox API is published even with the surface unmounted');
    eq(off.opened, false, 'open() must refuse while the flag is off');
    eq(off.composed, 'dataglow-explain', 'the engine still composes with nothing mounted');

    // ---- DEFAULT LOAD: both ship ON ----------------------------------------
    await p.goto(base + '/__ex__default.html');
    await waitForBoth(p);
    await p.waitForSelector('#dg-explain-btn', { timeout: 20000 });
    const on = await p.evaluate(() => ({
      label: (document.querySelector('#dg-explain-btn [data-ex-label]') || {}).textContent || '',
      blocks: Array.from(document.querySelectorAll('[data-gb-host]')).map((b) => b.getAttribute('data-gb-host')),
      hidden: Array.from(document.querySelectorAll('[data-gb-host]')).every((b) => b.hidden),
      panelOpen: window.DataGlowExplain.isOpen(),
    }));
    eq(on.label, 'Explain', 'the button reads Explain');
    assert.deepEqual(on.blocks, ['sql-view', 'sql-tab', 'py-view']);
    checks += 1;
    ok(on.blocks.length >= 2, 'the acceptance bar is two surfaces, and three mounted');
    eq(on.hidden, true, 'a block with no result yet stays out of the way');
    eq(on.panelOpen, false, 'the Explain panel starts closed');

    // ---- GLASSBOX READS THE REAL EDITOR ------------------------------------
    await fillSurface(p, SQL_VIEW);
    const shown = await p.evaluate(() => {
      const b = document.getElementById('dg-gb-sql-view');
      return {
        hidden: b.hidden,
        label: b.querySelector('[data-gb-label]').textContent,
        level: b.getAttribute('data-level'),
      };
    });
    eq(shown.hidden, false, 'a result appearing reveals the block, with no click');
    eq(shown.label, 'Show the math (SQL)', 'the toggle names the language it is about to show');
    eq(shown.level, 'unknown', 'with no gate present the block is unknown, never good');

    await p.click('#dg-gb-sql-view .dg-gb-toggle');
    const opened = await p.evaluate(() => {
      const b = document.getElementById('dg-gb-sql-view');
      return {
        open: b.classList.contains('open'),
        expanded: b.querySelector('.dg-gb-toggle').getAttribute('aria-expanded'),
        code: b.querySelector('pre.dg-gb-src').textContent,
        editor: document.getElementById('sql-view-input').value,
        finding: b.querySelector('.dg-gb-find').textContent,
        ran: b.querySelector('.dg-gb-ran').textContent,
        chips: b.querySelectorAll('.dg-gb-chip').length,
        gaps: Array.from(b.querySelectorAll('.dg-gb-gap')).map((g) => g.textContent).join(' '),
        text: b.textContent,
        // finding first, proof underneath: the headline must precede the code
        findingBeforeCode: b.querySelector('.dg-gb-find').compareDocumentPosition(
          b.querySelector('pre.dg-gb-src'),
        ) === Node.DOCUMENT_POSITION_FOLLOWING,
      };
    });
    eq(opened.open, true, 'the toggle opens the block');
    eq(opened.expanded, 'true', 'the toggle reports its state to a screen reader');
    eq(opened.code, opened.editor, 'the code shown must be the code in the editor, exactly');
    eq(opened.code, SQL, 'and that is the SQL that was typed');
    match(opened.finding, /4 rows are shown above/, 'the finding is the number a person is looking at');
    match(opened.ran, /Ran by DuckDB-WASM on this device/, 'the engine that ran it is named');
    eq(opened.chips, 0, 'no gate present means no chip at all');
    match(opened.gaps, /absence of evidence, not a clean result/, 'the missing gates are named out loud');
    eq(opened.findingBeforeCode, true, 'finding on top, proof underneath');
    ok(!opened.text.includes(EM_DASH), 'no em dash in the GlassBox panel');

    // ---- GLASSBOX NEVER INVENTS CODE --------------------------------------
    const noCode = await p.evaluate(() => {
      document.getElementById('sql-input').value = '';
      const body = document.getElementById('sql-results-tbody');
      body.innerHTML = '<tr><td>a</td></tr><tr><td>b</td></tr>';
      window.DataGlowGlassBox.refresh('sql-tab');
      window.DataGlowGlassBox.open('sql-tab');
      const b = document.getElementById('dg-gb-sql-tab');
      return {
        pre: !!b.querySelector('pre.dg-gb-src'),
        gaps: Array.from(b.querySelectorAll('.dg-gb-gap')).map((g) => g.textContent).join(' '),
      };
    });
    eq(noCode.pre, false, 'with no source text there is no code block to read');
    match(noCode.gaps, /Nothing has been reconstructed/,
      'a surface that handed over no code gets an honest gap, not a plausible query');

    // ---- A HANDED-OVER SENTINEL REPORT BECOMES A REAL CHIP -----------------
    const withSentinel = await p.evaluate(() => {
      window.DataGlowGlassBox.provide({
        sentinel: {
          status: 'fail', flagCount: 1,
          flags: [{ kind: 'FANOUT', severity: 'fail', table: 'claims', column: 'claim_id',
            message: 'this join can multiply matching rows before the aggregate runs.' }],
        },
      });
      window.DataGlowGlassBox.open('sql-view');
      const b = document.getElementById('dg-gb-sql-view');
      return {
        level: b.getAttribute('data-level'),
        chips: Array.from(b.querySelectorAll('.dg-gb-chip')).map((c) => c.textContent),
        chipLevels: Array.from(b.querySelectorAll('.dg-gb-chip')).map((c) => c.getAttribute('data-level')),
      };
    });
    eq(withSentinel.level, 'bad', 'a failing gate drives the whole block to bad');
    match(withSentinel.chips.join(' '), /Query Sentinel: 1 to fix/, 'the chip counts what must be fixed');
    eq(withSentinel.chipLevels[0], 'bad', 'and it is coloured as a failure');

    // ---- EXPLAIN COMPOSES WHAT IS THERE, AND NAMES WHAT IS NOT ------------
    await p.click('#dg-explain-btn');
    await p.waitForFunction(() => window.DataGlowExplain.isOpen(), null, { timeout: 5000 });
    const exp = await p.evaluate(() => {
      const e = window.DataGlowExplain.explain();
      const body = document.getElementById('dg-explain-body');
      return {
        sections: e.sections.map((s) => s.id),
        unknowns: e.unknowns.map((u) => u.source),
        confidence: e.confidence,
        level: e.level,
        headline: e.headline,
        bodyText: body.textContent,
        rendered: body.querySelectorAll('[data-ex-sec]').length,
        btnLevel: document.getElementById('dg-explain-btn').getAttribute('data-level'),
      };
    });
    ok(exp.sections.includes('result-shape'), 'the shape of the answer is explained');
    ok(exp.sections.includes('query-sentinel'), 'the gate GlassBox was handed is read here too');
    ok(exp.unknowns.includes('readiness-gate'),
      'the readiness gate published no result, so it is named as not known');
    eq(exp.rendered, exp.sections.length, 'every section the engine produced is on screen');
    eq(exp.level, 'bad', 'the worst section decides the level');
    eq(exp.btnLevel, 'bad', 'and the button carries it, so a skim cannot mislead');
    match(exp.bodyText, /Not known/, 'the panel names what it could not see');
    ok(!exp.bodyText.includes(EM_DASH), 'no em dash in the Explain panel');

    // ---- EXPLAIN AND GLASSBOX AGREE --------------------------------------
    const agree = await p.evaluate(() => {
      const gb = window.DataGlowGlassBox.gates();
      const ev = window.DataGlowExplain.evidence();
      return { gbHasSentinel: !!gb.sentinel, exHasSentinel: !!ev.sentinel };
    });
    eq(agree.gbHasSentinel, true, 'GlassBox holds the handed-over report');
    eq(agree.exHasSentinel, true, 'and Explain reads the same one, so they cannot disagree');

    // ---- THE GATES THE APP REALLY PUBLISHES ARE READ WITHOUT ASKING -------
    await p.goto(base + '/__ex__gates.html');
    await waitForBoth(p);
    await fillSurface(p, SQL_VIEW);
    const real = await p.evaluate(() => {
      window.DataGlowGlassBox.open('sql-view');
      const b = document.getElementById('dg-gb-sql-view');
      const ev = window.DataGlowExplain.evidence();
      const e = window.DataGlowExplain.explain();
      return {
        chips: Array.from(b.querySelectorAll('.dg-gb-chip')).map((c) => c.textContent),
        level: b.getAttribute('data-level'),
        phiFound: ev.phi && ev.phi.sensitiveFound,
        airGap: ev.airGap && ev.airGap.active,
        trustSize: ev.trustLedger && ev.trustLedger.size,
        sections: e.sections.map((s) => s.id),
        text: b.textContent + ' ' + window.DataGlowExplain.text(),
      };
    });
    match(real.chips.join(' '), /PHI Shield: matched/, 'the published PHI report is read, unasked');
    match(real.chips.join(' '), /Air-Gap: on/, 'so is the published Air-Gap posture');
    eq(real.level, 'warn', 'a PHI match is a warning, not a failure');
    eq(real.phiFound, true, 'Explain reads the match from guard.sensitiveFound');
    eq(real.airGap, true, 'and the Air-Gap posture from isAirGapActive');
    eq(real.trustSize, 1, 'and the ledger size from getEntries');
    ok(real.sections.includes('phi-shield'), 'the PHI finding is explained in words');
    ok(real.sections.includes('air-gap'), 'and so is the network posture');
    ok(!real.text.includes(EM_DASH), 'no em dash reaches either surface or the copied text');

    // ---- A14: PHONE WIDTH -------------------------------------------------
    await p.setViewportSize(PHONE);
    await p.goto(base + '/__ex__default.html');
    await waitForBoth(p);
    await fillSurface(p, SQL_VIEW);
    await p.click('#dg-gb-sql-view .dg-gb-toggle');
    await p.click('#dg-explain-btn');
    await p.waitForFunction(() => window.DataGlowExplain.isOpen(), null, { timeout: 5000 });
    const phone = await p.evaluate((vw) => {
      const panel = document.getElementById('dg-explain-panel');
      const rect = panel.getBoundingClientRect();
      const head = panel.querySelector('.dg-ex-head');
      const foot = panel.querySelector('.dg-ex-foot');
      const targets = Array.from(panel.querySelectorAll('button'))
        .concat(Array.from(document.querySelectorAll('#dg-gb-sql-view button')))
        .concat([document.getElementById('dg-explain-btn')]);
      const tooSmall = targets
        .map((b) => ({ id: b.id || b.className, h: Math.round(b.getBoundingClientRect().height) }))
        .filter((t) => t.h > 0 && t.h < 44);
      const pre = document.querySelector('#dg-gb-sql-view pre.dg-gb-src');
      return {
        panelWidth: Math.round(rect.width),
        viewport: vw,
        headSticky: getComputedStyle(head).position,
        footSticky: getComputedStyle(foot).position,
        tooSmall,
        // no horizontal trap: the page and the code block must not be wider
        // than the screen
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        preOverflow: pre.scrollWidth - pre.clientWidth,
        preWrap: getComputedStyle(pre).whiteSpace,
      };
    }, PHONE.width);
    eq(phone.panelWidth, PHONE.width, 'at phone width the Explain panel is the whole screen');
    eq(phone.headSticky, 'sticky', 'the header stays put, so Close is always reachable');
    eq(phone.footSticky, 'sticky', 'the footer stays put, so the actions are always reachable');
    assert.deepEqual(phone.tooSmall, [], `every control must clear 44px, saw ${JSON.stringify(phone.tooSmall)}`);
    checks += 1;
    ok(phone.docOverflow <= 0, `the page must not scroll sideways, overflowed by ${phone.docOverflow}px`);
    ok(phone.preOverflow <= 0, `the code block must not scroll sideways, overflowed by ${phone.preOverflow}px`);
    eq(phone.preWrap, 'pre-wrap', 'a long query wraps rather than trapping the phone in a sideways scroll');

    eq(offOrigin.length, 0, `nothing may leave this device, saw: ${offOrigin.join(', ')}`);

    console.log(`explain + glassbox canvas UI: ${checks} assertion(s) passed `
      + '(flag off, default mount, real editor read, no fabrication, real chips, composition, '
      + 'agreement, published gates, phone width, no network)');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
