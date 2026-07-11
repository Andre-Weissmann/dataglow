// ============================================================
// DATAGLOW — Conversational Pack Builder UI wiring test (Gen 42, Part 5)
// ============================================================
// A real-browser DOM/integration test for the Validate-tab presenter
// (js/agents/conversational-pack-ui.js) that wires the already-tested Gen 42
// agent modules into the UI. It runs the presenter the exact way main.js does —
// through the pure gate shouldOfferPackBuilder() — and asserts:
//
//   FLAG OFF (the shipped default): the caller's gate returns false, so nothing
//     is mounted and the host stays empty (the regression guard the follow-up
//     PR must never break — the feature ships dark).
//   FLAG ON: the one-question-at-a-time card renders with the question text, the
//     two EQUAL-WEIGHT primary buttons, and NO mic (voice flag off); clicking
//     "Sounds right" shows the "✅ Got it" confirmation and the running summary;
//     "I'm done" → naming → finalize produces a pack and offers
//     [Save locally]/[Export to share], with export firing the download callback.
//   UNCERTAINTY: typing "not sure" routes through the resolver and renders ONE
//     unified suggestion (Step D) — never the internal debate — which can then be
//     accepted into a rule.
//
// WHY a real browser: the presenter builds DOM via document.createElement and the
// agent chain it imports is browser-native ES modules. No DuckDB/WASM is needed
// (the pack builder's finalize path is pure schema validation), so this is robust
// in headless CI. The test imports the presenter on a served origin and drives it
// on a DETACHED host div, so it never boots the full app.
//
// RUN WITH:  node test/pack-builder-ui.test.mjs

import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TEST_PAGE = '/__packbuilder_test__.html';

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
      const m = await import('/js/agents/conversational-pack-ui.js');
      return {
        offWithQ: m.shouldOfferPackBuilder({ enabled: false, questions: [{}] }),
        onNoQ: m.shouldOfferPackBuilder({ enabled: true, questions: [] }),
        onWithQ: m.shouldOfferPackBuilder({ enabled: true, questions: [{}] }),
      };
    });
    ok(gate.offWithQ === false, 'gate: flag OFF with findings → do not offer');
    ok(gate.onNoQ === false, 'gate: flag ON but no findings → do not offer');
    ok(gate.onWithQ === true, 'gate: flag ON with findings → offer');

    // ---------- 2. Flag OFF → nothing renders (regression guard) ----------
    const off = await page.evaluate(async () => {
      const ui = await import('/js/agents/conversational-pack-ui.js');
      const qg = await import('/js/agents/question-generator-agent.js');
      const questions = qg.generateQuestions({ columnStats: [{ column: 'discount_pct', max: 150, min: 0, mean: 40, std: 10 }] }, { max: 5 });
      const host = document.createElement('div');
      document.body.appendChild(host);
      // Replicate main.js's decision exactly: only mount when the gate passes.
      const enabled = false;
      if (ui.shouldOfferPackBuilder({ enabled, questions })) {
        ui.mountConversationalPackBuilder({ host, questions });
      }
      return { childCount: host.children.length, generated: questions.length };
    });
    ok(off.generated > 0, 'off: the generator did produce findings (so the guard is meaningful)');
    ok(off.childCount === 0, 'off: with the flag off nothing is mounted into the host');

    // ---------- 3. Flag ON → card renders, advances, summarises, finalises ----------
    const on = await page.evaluate(async () => {
      const ui = await import('/js/agents/conversational-pack-ui.js');
      const qg = await import('/js/agents/question-generator-agent.js');
      const questions = qg.generateQuestions({
        columnStats: [{ column: 'discount_pct', max: 150, min: 0, mean: 40, std: 10 }],
        missingness: [{ column: 'notes', missingRate: 35.0, classification: 'MCAR' }],
      }, { max: 5 });
      const host = document.createElement('div');
      document.body.appendChild(host);
      const downloads = [];
      const saved = [];
      if (ui.shouldOfferPackBuilder({ enabled: true, questions })) {
        ui.mountConversationalPackBuilder({
          host, questions, domain: 'retail', voiceEnabled: false,
          onDownload: (f) => downloads.push(f),
          onSaveLocal: (p) => saved.push(p),
          onToast: () => {},
        });
      }
      const q = host.querySelector('[data-testid="pack-builder-question"]');
      const accept = host.querySelector('[data-testid="pack-builder-btn-accept"]');
      const skip = host.querySelector('[data-testid="pack-builder-btn-skip"]');
      const freetext = host.querySelector('[data-testid="pack-builder-freetext"]');
      const result = {
        questionText: q ? q.textContent : null,
        hasAccept: !!accept, hasSkip: !!skip, hasFreetext: !!freetext,
        equalWeight: !!(accept && skip) && accept.className === skip.className,
        micHidden: !host.querySelector('[data-testid="pack-builder-mic"]'),
      };
      // Confirm an answer → "✅ Got it" + running summary.
      accept.click();
      const gotit = host.querySelector('[data-testid="pack-builder-gotit"]');
      const summary = host.querySelector('[data-testid="pack-builder-summary"]');
      const done = host.querySelector('[data-testid="pack-builder-btn-done"]');
      result.gotitText = gotit ? gotit.textContent : null;
      result.summaryItems = summary ? summary.querySelectorAll('li').length : -1;
      result.hasDone = !!done;
      // Finish → name → finalize → save options.
      done.click();
      const finalizeBtn = host.querySelector('[data-testid="pack-builder-btn-finalize"]');
      result.hasNameInput = !!host.querySelector('[data-testid="pack-builder-name"]');
      finalizeBtn.click();
      const savedView = host.querySelector('[data-testid="pack-builder-saved"]');
      const exportBtn = host.querySelector('[data-testid="pack-builder-btn-export-share"]');
      const saveLocalBtn = host.querySelector('[data-testid="pack-builder-btn-save-local"]');
      result.savedText = savedView ? savedView.textContent : null;
      if (saveLocalBtn) saveLocalBtn.click();
      if (exportBtn) exportBtn.click();
      result.downloads = downloads.slice();
      result.savedCount = saved.length;
      result.savedPackRules = saved.length ? saved[0].rules.length : -1;
      return result;
    });
    ok(/discount_pct/.test(on.questionText || ''), 'on: question card renders grounded in a real column');
    ok(on.hasAccept && on.hasSkip && on.hasFreetext, 'on: two response buttons + free-text field render');
    ok(on.equalWeight, 'on: the two primary buttons are equal-weight (identical class)');
    ok(on.micHidden, 'on: the mic is hidden while the voice flag is off');
    ok(/^✅ Got it:/.test(on.gotitText || ''), 'on: accepting shows the "✅ Got it" confirmation');
    ok(on.summaryItems === 1, 'on: the running summary lists the one confirmed rule');
    ok(on.hasDone, 'on: the summary offers "I\'m done — save my pack"');
    ok(on.hasNameInput, 'on: finishing prompts for a pack name');
    ok(/Built "my-retail-pack"/.test(on.savedText || ''), 'on: finalize builds a valid pack and shows save/share options');
    ok(on.savedCount === 1 && on.savedPackRules === 1, 'on: [Save locally] registers the built pack');
    ok(on.downloads.length === 1 && /my-retail-pack\.json$/.test(on.downloads[0]), 'on: [Export to share] fires the JSON download');

    // ---------- 4. Uncertainty → ONE unified suggestion (never the debate) ----------
    const unc = await page.evaluate(async () => {
      const ui = await import('/js/agents/conversational-pack-ui.js');
      const qg = await import('/js/agents/question-generator-agent.js');
      const questions = qg.generateQuestions({ columnStats: [{ column: 'discount_pct', max: 150, min: 0, mean: 40, std: 10 }] }, { max: 5 });
      const host = document.createElement('div');
      document.body.appendChild(host);
      ui.mountConversationalPackBuilder({ host, questions, domain: 'retail', onToast: () => {} });
      const input = host.querySelector('[data-testid="pack-builder-freetext"]');
      input.value = 'not sure';
      host.querySelector('[data-testid="pack-builder-freetext-submit"]').click();
      await new Promise(r => setTimeout(r, 150));
      const resolution = host.querySelector('[data-testid="pack-builder-resolution"]');
      const debateLeaked = /conservative|industry-norm|debate panel|reconcile/i.test(host.textContent);
      const accept = host.querySelector('[data-testid="pack-builder-btn-accept"]');
      if (accept) accept.click();
      return {
        hasResolution: !!resolution,
        resolutionText: resolution ? resolution.textContent : null,
        debateLeaked,
        resolvedToRule: !!host.querySelector('[data-testid="pack-builder-gotit"]'),
      };
    });
    ok(unc.hasResolution, 'uncertainty: "not sure" routes through the resolver and shows a suggestion');
    ok(!unc.debateLeaked, 'uncertainty: the internal debate steps are never surfaced to the user');
    ok(unc.resolvedToRule, 'uncertainty: accepting the suggestion records it as a confirmed rule');

    // ---------- 5. OPT-IN "Why this suggestion?" transparency disclosure ----------
    // A Step-C (debate) resolution offers a low-emphasis disclosure that stays
    // COLLAPSED by default and expands on demand to show per-persona confidence +
    // the reconciliation math — never shown or leaked unless the user opts in.
    const why = await page.evaluate(async () => {
      const ui = await import('/js/agents/conversational-pack-ui.js');
      const host = document.createElement('div');
      document.body.appendChild(host);
      // An extreme-outlier column (not percent-like, not negative) misses Steps A
      // and B and resolves at Step C — the three-agent debate — deterministically
      // (no LLM injected), so there is genuine debate detail to reveal.
      const questions = [{
        column: 'basket_value', category: 'outlier', value: 980,
        observation: 'an extreme value of 980',
        ruleGuess: '"basket_value" be flagged when it is that far from typical',
        text: 'I noticed your `basket_value` column has an extreme value of 980. Is that expected?',
      }];
      ui.mountConversationalPackBuilder({ host, questions, domain: 'retail', onToast: () => {} });
      const input = host.querySelector('[data-testid="pack-builder-freetext"]');
      input.value = 'no idea';
      host.querySelector('[data-testid="pack-builder-freetext-submit"]').click();
      await new Promise(r => setTimeout(r, 150));

      const out = {};
      // Default (collapsed) state: link present, panel absent, no leak.
      const toggle = host.querySelector('[data-testid="pack-builder-why"]');
      out.hasToggle = !!toggle;
      out.toggleLabel = toggle ? toggle.textContent : null;
      out.panelBeforeClick = !!host.querySelector('[data-testid="pack-builder-diagnostics"]');
      out.leakBeforeClick = /conservative|industry-norm|debate panel|reconcile/i.test(host.textContent);
      out.expandedBefore = toggle ? toggle.getAttribute('aria-expanded') : null;

      // Expand.
      toggle.click();
      const panel = host.querySelector('[data-testid="pack-builder-diagnostics"]');
      out.panelAfterClick = !!panel;
      out.expandedAfter = toggle.getAttribute('aria-expanded');
      out.personaCount = panel ? panel.querySelectorAll('[data-testid^="pack-builder-persona-"]').length : -1;
      out.panelText = panel ? panel.textContent : '';
      const recon = host.querySelector('[data-testid="pack-builder-reconciliation"]');
      out.reconText = recon ? recon.textContent : '';

      // Collapse again.
      toggle.click();
      out.panelHiddenAfterToggle = panel && panel.style.display === 'none';
      out.expandedAfterCollapse = toggle.getAttribute('aria-expanded');
      return out;
    });
    ok(why.hasToggle, 'why: a Step-C resolution offers the opt-in "Why this suggestion?" disclosure');
    ok(why.toggleLabel === 'Why this suggestion?', 'why: the disclosure is labelled plainly');
    ok(why.panelBeforeClick === false, 'why: the diagnostics panel is NOT rendered by default (collapsed)');
    ok(why.leakBeforeClick === false, 'why: no debate detail leaks into the DOM before opting in');
    ok(why.expandedBefore === 'false', 'why: the disclosure reports itself collapsed by default');
    ok(why.panelAfterClick === true && why.expandedAfter === 'true', 'why: clicking expands the diagnostics panel');
    ok(why.personaCount === 3, 'why: all three persona viewpoints are shown when expanded');
    ok(/confidence\s*\d+%/i.test(why.panelText), 'why: each persona shows its OWN confidence percentage (per-persona, not aggregate)');
    ok(/Winner:/.test(why.reconText) && /summed each group/i.test(why.reconText),
      'why: the reconciliation math (grouping + winner) is shown, not a single collapsed score');
    ok(why.panelHiddenAfterToggle === true && why.expandedAfterCollapse === 'false',
      'why: clicking again collapses the panel');

    // ---------- 6. A/B resolutions must NOT fabricate a debate view ----------
    const noDebate = await page.evaluate(async () => {
      const ui = await import('/js/agents/conversational-pack-ui.js');
      const host = document.createElement('div');
      document.body.appendChild(host);
      // A percentage-like column over 100% is mathematically impossible → Step A
      // resolves it directly, with NO debate to reveal.
      const questions = [{
        column: 'discount_pct', category: 'impossible', value: 150,
        observation: 'values up to 150%',
        ruleGuess: '"discount_pct" never go above 100%',
        text: 'I noticed your `discount_pct` column has values up to 150%. Is that expected?',
      }];
      ui.mountConversationalPackBuilder({ host, questions, domain: 'retail', onToast: () => {} });
      const input = host.querySelector('[data-testid="pack-builder-freetext"]');
      input.value = "i don't know";
      host.querySelector('[data-testid="pack-builder-freetext-submit"]').click();
      await new Promise(r => setTimeout(r, 150));
      return {
        hasResolution: !!host.querySelector('[data-testid="pack-builder-resolution"]'),
        hasToggle: !!host.querySelector('[data-testid="pack-builder-why"]'),
      };
    });
    ok(noDebate.hasResolution, 'no-debate: a Step-A resolution still shows the unified suggestion');
    ok(noDebate.hasToggle === false, 'no-debate: Step A offers NO "Why" disclosure (no fabricated debate)');
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
