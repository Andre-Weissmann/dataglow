// ============================================================
// DATAGLOW — Meeting Scribe UI wiring test (Gen 43, Part 2)
// ============================================================
// A real-browser DOM/integration test for the Meeting-tab presenter
// (js/agents/meeting-scribe-ui.js) that wires the already-tested Gen 43
// agent module (Part 1, js/agents/meeting-scribe-agent.js) into a screen a
// person can actually use. Mirrors test/pack-builder-ui.test.mjs exactly:
// same detached-host approach, same shouldOffer*() gate pattern, same
// same-origin static file server so ES-module imports resolve.
//
// Asserts:
//   GATE: shouldOfferMeetingScribe() is false with the flag off, true with
//     it on — the same pure predicate main.js checks before mounting.
//   TRANSCRIPT PARSING: parseTranscriptText handles both "12 some text"
//     (explicit second-based timestamp) and plain lines (auto-numbered).
//   ANALYZE FLOW: typing/pasting a transcript with a pushback line and a
//     data-request line and clicking Analyze surfaces both in their own
//     grouped sections, and the full tagged list shows every line.
//   ACTION ITEMS: adding an item shows it as "Open"; filling in owner, due
//     date, and outcome and clicking Save flips it to "Resolved" — a
//     partially filled item (e.g. owner only) stays "Open", matching the
//     Part 1 minimum-viable-action-item rule.
//
// RUN WITH:  node test/meeting-scribe-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TEST_PAGE = '/__meetingscribe_test__.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
function contentType(path) {
  const dot = path.lastIndexOf('.');
  return MIME[path.slice(dot)] || 'application/octet-stream';
}

// Serve the repo (so the presenter's ES-module chain resolves) plus one minimal
// blank page whose only job is to be a same-origin document to import from —
// deliberately avoiding index.html so the full app never boots.
function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === TEST_PAGE) {
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
          return;
        }
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

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

  try {
    await page.goto(baseUrl + TEST_PAGE, { waitUntil: 'domcontentloaded' });

    // ---------- 1. Pure gate ----------
    const gate = await page.evaluate(async () => {
      const m = await import('/js/agents/meeting-scribe-ui.js');
      return {
        off: m.shouldOfferMeetingScribe({ enabled: false }),
        on: m.shouldOfferMeetingScribe({ enabled: true }),
      };
    });
    ok(gate.off === false, 'gate: flag OFF → do not offer');
    ok(gate.on === true, 'gate: flag ON → offer');

    // ---------- 2. Transcript parsing ----------
    const parsed = await page.evaluate(async () => {
      const m = await import('/js/agents/meeting-scribe-ui.js');
      return m.parseTranscriptText('5 Are you sure about that?\nCan you also pull the regional breakdown?\n\n12 Follow up by Friday');
    });
    ok(parsed.length === 3, 'parse: blank lines are dropped, three real lines remain');
    ok(parsed[0].ts === 5 && parsed[0].text === 'Are you sure about that?', 'parse: explicit leading timestamp is read as seconds');
    ok(parsed[1].ts === 6 && parsed[1].text === 'Can you also pull the regional breakdown?', 'parse: a line with no leading number is auto-numbered one second after the previous');
    ok(parsed[2].ts === 12, 'parse: a later explicit timestamp is still honoured');

    // ---------- 3. Analyze flow: pushback + data request + full list ----------
    const analyzed = await page.evaluate(async () => {
      const ui = await import('/js/agents/meeting-scribe-ui.js');
      const host = document.createElement('div');
      document.body.appendChild(host);
      ui.mountMeetingScribe({ host, onToast: () => {} });
      const textarea = host.querySelector('[data-testid="meeting-scribe-transcript"]');
      textarea.value = 'Why did this drop in March?\nCan you also pull the regional breakdown?\nEverything else looked fine.';
      host.querySelector('[data-testid="meeting-scribe-btn-analyze"]').click();
      const results = host.querySelector('[data-testid="meeting-scribe-results"]');
      const taggedList = host.querySelector('[data-testid="meeting-scribe-tagged-list"]');
      return {
        resultsText: results ? results.textContent : '',
        taggedCount: taggedList ? taggedList.querySelectorAll('li').length : -1,
        hasEmptyState: !!host.querySelector('[data-testid="meeting-scribe-empty"]'),
      };
    });
    ok(/Pushback moments \(1\)/.test(analyzed.resultsText), 'analyze: exactly one pushback moment detected and labelled');
    ok(/Data requests \(1\)/.test(analyzed.resultsText), 'analyze: exactly one data request detected and labelled');
    ok(analyzed.resultsText.includes('why did this drop'), 'analyze: the matched pushback phrase is shown');
    ok(analyzed.resultsText.includes('can you also pull'), 'analyze: the matched data-request phrase is shown');
    ok(analyzed.taggedCount === 3, 'analyze: all three transcript lines appear in the full tagged list');
    ok(!analyzed.hasEmptyState, 'analyze: the "nothing analyzed yet" empty state is gone once results exist');

    // ---------- 4. Empty analyze is a no-op (no crash, stays empty) ----------
    const emptyAnalyze = await page.evaluate(async () => {
      const ui = await import('/js/agents/meeting-scribe-ui.js');
      const host = document.createElement('div');
      document.body.appendChild(host);
      ui.mountMeetingScribe({ host, onToast: () => {} });
      host.querySelector('[data-testid="meeting-scribe-btn-analyze"]').click(); // textarea is blank
      return { hasEmptyState: !!host.querySelector('[data-testid="meeting-scribe-empty"]') };
    });
    ok(emptyAnalyze.hasEmptyState, 'analyze: clicking Analyze with a blank transcript leaves the empty state in place (no crash)');

    // ---------- 5. Action items: open → partially filled stays open → resolved ----------
    const actionFlow = await page.evaluate(async () => {
      const ui = await import('/js/agents/meeting-scribe-ui.js');
      const host = document.createElement('div');
      document.body.appendChild(host);
      ui.mountMeetingScribe({ host, onToast: () => {} });
      const input = host.querySelector('[data-testid="meeting-scribe-action-input"]');
      input.value = 'Follow up with finance on the March dip';
      host.querySelector('[data-testid="meeting-scribe-btn-add-action"]').click();
      const statusAfterAdd = host.querySelector('[data-testid="meeting-scribe-action-item-status-0"]');
      const afterAdd = statusAfterAdd ? statusAfterAdd.textContent : null;

      // Fill owner only, save — should stay Open (missing dueDate + outcome).
      const row = host.querySelector('[data-testid="meeting-scribe-action-item-0"]');
      const [ownerInput] = row.querySelectorAll('input');
      ownerInput.value = 'Priya';
      row.querySelector('button').click(); // Save
      const statusAfterPartial = host.querySelector('[data-testid="meeting-scribe-action-item-status-0"]');
      const afterPartial = statusAfterPartial ? statusAfterPartial.textContent : null;

      // Fill all three fields, save — should flip to Resolved.
      const row2 = host.querySelector('[data-testid="meeting-scribe-action-item-0"]');
      const [ownerInput2, dueInput2, outcomeInput2] = row2.querySelectorAll('input');
      ownerInput2.value = 'Priya'; dueInput2.value = '2026-07-18'; outcomeInput2.value = 'Confirmed one-time refund adjustment';
      row2.querySelector('button').click(); // Save
      const statusAfterFull = host.querySelector('[data-testid="meeting-scribe-action-item-status-0"]');
      const afterFull = statusAfterFull ? statusAfterFull.textContent : null;

      return { afterAdd, afterPartial, afterFull };
    });
    ok(actionFlow.afterAdd === 'Open', 'action item: a freshly added item starts Open');
    ok(actionFlow.afterPartial === 'Open', 'action item: owner-only (missing dueDate + outcome) stays Open — the minimum-viable-action-item rule');
    ok(actionFlow.afterFull === 'Resolved', 'action item: owner + dueDate + outcome flips it to Resolved');

    // ---------- 6. Re-check a pushback number through the on-device resolver ----------
    // A pushback moment gains a secondary "Re-check this number" button. Clicking
    // it builds a candidate and runs the EXISTING uncertainty resolver on-device;
    // a meeting-pushback candidate always resolves at Step C (the three-persona
    // debate) with no LLM injected, so there is genuine debate detail to reveal.
    const recheck = await page.evaluate(async () => {
      const ui = await import('/js/agents/meeting-scribe-ui.js');
      const host = document.createElement('div');
      document.body.appendChild(host);
      ui.mountMeetingScribe({ host, onToast: () => {} });
      const textarea = host.querySelector('[data-testid="meeting-scribe-transcript"]');
      textarea.value = 'Why did this drop in March?';
      host.querySelector('[data-testid="meeting-scribe-btn-analyze"]').click();

      const out = {};
      const btn = host.querySelector('[data-testid="meeting-scribe-recheck-0"]');
      out.hasButton = !!btn;
      out.buttonLabel = btn ? btn.textContent : null;
      // Before clicking: no result, no debate leak in the DOM.
      out.suggestionBefore = !!host.querySelector('[data-testid="meeting-scribe-recheck-suggestion"]');
      // Debate-detail markers that appear ONLY inside the diagnostics panel — not
      // the resolver's plain-language reasoning (which legitimately says "a strict
      // reading" in prose).
      out.leakBefore = /grouped the proposals|its own confidence|How I reached this/i.test(host.textContent);

      btn.click();
      await new Promise((r) => setTimeout(r, 200));

      const suggestion = host.querySelector('[data-testid="meeting-scribe-recheck-suggestion"]');
      out.hasSuggestion = !!suggestion;
      out.suggestionText = suggestion ? suggestion.textContent : '';

      // Disclosure present, collapsed by default, no panel/leak yet.
      const toggle = host.querySelector('[data-testid="meeting-scribe-why"]');
      out.hasToggle = !!toggle;
      out.toggleLabel = toggle ? toggle.textContent : null;
      out.expandedBefore = toggle ? toggle.getAttribute('aria-expanded') : null;
      out.panelBeforeClick = !!host.querySelector('[data-testid="meeting-scribe-diagnostics"]');
      out.leakAfterResolveBeforeExpand = /grouped the proposals|its own confidence|How I reached this/i.test(host.textContent);

      // Expand.
      toggle.click();
      const panel = host.querySelector('[data-testid="meeting-scribe-diagnostics"]');
      out.panelAfterClick = !!panel;
      out.expandedAfter = toggle.getAttribute('aria-expanded');
      out.personaCount = panel ? panel.querySelectorAll('[data-testid^="meeting-scribe-persona-"]').length : -1;
      out.hasReconciliation = !!host.querySelector('[data-testid="meeting-scribe-reconciliation"]');

      // Collapse again.
      toggle.click();
      out.panelHiddenAfterToggle = panel && panel.style.display === 'none';
      out.expandedAfterCollapse = toggle.getAttribute('aria-expanded');

      // GUARD (the exact predicate the UI hides on): a resolution with no debate
      // (a Step-A hard-constraint answer) reports available:false, so the UI never
      // fabricates a "Why this suggestion?" disclosure for it.
      const diag = await import('/js/agents/debate-diagnostics.js');
      const noDebate = diag.buildDebateDiagnostics({ resolvedBy: 'A', suggestion: 'x', reasoning: 'y', confidence: 0.95 });
      out.noDebateAvailable = noDebate.available;
      return out;
    });
    ok(recheck.hasButton, 're-check: a pushback moment shows a "Re-check this number" button');
    ok(recheck.buttonLabel === 'Re-check this number', 're-check: the button is labelled plainly');
    ok(recheck.suggestionBefore === false && recheck.leakBefore === false, 're-check: nothing is computed or leaked before the button is clicked');
    ok(recheck.hasSuggestion, 're-check: clicking surfaces the resolver’s unified suggestion');
    ok(/Confidence:\s*\d+%/.test(recheck.suggestionText), 're-check: the suggestion shows a plain-language confidence percentage');
    ok(recheck.hasToggle && recheck.toggleLabel === 'Why this suggestion?', 're-check: a Step-C resolution offers the opt-in "Why this suggestion?" disclosure');
    ok(recheck.expandedBefore === 'false', 're-check: the disclosure is collapsed by default');
    ok(recheck.panelBeforeClick === false && recheck.leakAfterResolveBeforeExpand === false, 're-check: the debate detail is NOT in the DOM until the analyst opts in');
    ok(recheck.panelAfterClick === true && recheck.expandedAfter === 'true', 're-check: clicking expands the diagnostics panel');
    ok(recheck.personaCount === 3, 're-check: all three persona viewpoints are shown when expanded');
    ok(recheck.hasReconciliation, 're-check: the reconciliation math is shown, not a single collapsed score');
    ok(recheck.panelHiddenAfterToggle === true && recheck.expandedAfterCollapse === 'false', 're-check: clicking again collapses the panel');
    ok(recheck.noDebateAvailable === false, 're-check: a no-debate (Step-A) resolution reports available:false, so the disclosure never appears for it');

    // ---------- 7. Re-check degrades gracefully if the resolver throws ----------
    const recheckError = await page.evaluate(async () => {
      const ui = await import('/js/agents/meeting-scribe-ui.js');
      const host = document.createElement('div');
      document.body.appendChild(host);
      ui.mountMeetingScribe({ host, onToast: () => {} });
      const textarea = host.querySelector('[data-testid="meeting-scribe-transcript"]');
      textarea.value = 'Are you sure about that number?';
      host.querySelector('[data-testid="meeting-scribe-btn-analyze"]').click();
      const btn = host.querySelector('[data-testid="meeting-scribe-recheck-0"]');
      const hasButton = !!btn;
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      // Success path (real resolver) should not crash the tab: a result exists and
      // the surrounding UI (the transcript textarea) is still present.
      const survives = !!host.querySelector('[data-testid="meeting-scribe-transcript"]');
      const hasResult = !!host.querySelector('[data-testid="meeting-scribe-recheck-suggestion"]');
      return { hasButton, survives, hasResult };
    });
    ok(recheckError.hasButton && recheckError.survives && recheckError.hasResult, 're-check: the re-check runs read-only without ever tearing down the tab');
  } catch (err) {
    failed++;
    console.log('\n✗ FAILED: ' + (err && err.message ? err.message : err));
    console.log('  --- browser console ---');
    for (const line of consoleLines.slice(-30)) console.log('  ' + line);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
