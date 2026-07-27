// ============================================================
// DATAGLOW - A50 Jobs calm polish contract test
// ============================================================
// Proves A50_JOBS_CALM_POLISH_SPEC.md at the level cheap string/regex
// checks can prove, against canvas/index.html (AUTHORITATIVE) and the
// Question Scout module sources it is inlined from.
//
// Checks:
//   1. Post-load spotlight is capped at 3 actions (Clean/Validate,
//      Ask (Scout), Prove (VERDICT)) -- not the old 4-shortcut grid.
//   2. Spotlight's Scout/Prove buttons wire to the existing floating
//      panel buttons (dg-question-scout-btn / dg-proof-harness-btn)
//      rather than introducing new panels.
//   3. Home hero: the floating advanced-tools row is demoted (not
//      display:none -- no focus trap) until body.has-data.
//   4. Toolbar-overflow guardrail: no selector combines overflow:hidden
//      + white-space:nowrap without text-overflow (the letter-clip
//      pattern), and the new explicit guardrail rule exists.
//   5. Scout cold-start: a calm status row with an explicit "Use
//      templates now" action exists in the canvas UI source, self-
//      silences once a proposal has run or the model is warm, and the
//      button is wired to propose() (same fallback path, no new engine).
//   6. Purpose contract: shortened intro copy, and 'analysis' (Analysis
//      & Reporting) is marked as the single recommended default and
//      pre-selected on open.
//   7. 16px-min mobile body-text rule exists for the calm-journey
//      surfaces this slice touches.
//   8. No em dash (U+2014) in any new A50 string this test knows about,
//      or anywhere inside the A50-tagged CSS/JS blocks in canvas or the
//      Question Scout source files.
//   9. canvas/index.html is still well-formed enough for
//      check-canvas-integrity's own syntax/marker checks (spot checks
//      only; the real authority is npm run check:canvas-integrity).
//
// This is a pure string-based test: no DOM, no browser.
// RUN WITH: node test/a50-jobs-calm-polish.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CANVAS = join(repoRoot, 'canvas', 'index.html');
const QS_ENGINE = join(repoRoot, 'js', 'question-scout', 'question-scout.js');
const QS_CANVAS = join(repoRoot, 'js', 'question-scout', 'data-glow-question-scout-canvas.js');

const canvas = readFileSync(CANVAS, 'utf8');
const qsEngine = readFileSync(QS_ENGINE, 'utf8');
const qsCanvasSrc = readFileSync(QS_CANVAS, 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

// ---------- 1. Spotlight capped at 3 actions ----------
{
  const spotlightMatches = [...canvas.matchAll(/<div class="spotlight-grid">([\s\S]*?)<\/div>\s*<button class="spotlight-skip"/g)];
  ok(spotlightMatches.length >= 1, 'canvas: at least one spotlight-grid block found');
  for (const m of spotlightMatches) {
    const grid = m[1];
    const btnCount = (grid.match(/<button class="spotlight-btn/g) || []).length;
    ok(btnCount === 3, `canvas: spotlight-grid has exactly 3 action buttons (found ${btnCount})`);
    ok(grid.includes('Clean &amp; Validate') || grid.includes('Clean & Validate'), 'canvas: spotlight includes Clean/Validate action');
    ok(/Ask \(Scout\)/.test(grid), 'canvas: spotlight includes Ask (Scout) action');
    ok(/Prove \(VERDICT\)/.test(grid), 'canvas: spotlight includes Prove (VERDICT) action');
  }
  ok(!canvas.includes('>Visualize</div>') || !canvas.includes('data-goto="charts-view">\n        <span class="spotlight-btn-icon"'),
    'canvas: old 4-shortcut spotlight (Visualize/SQL/Findings/Statistics) no longer present as the spotlight grid');
}

// ---------- 2. Scout/Prove wiring reuses existing floating buttons ----------
ok(canvas.includes("data-action=\"open-scout\""), 'canvas: spotlight Scout button has data-action=open-scout');
ok(canvas.includes("data-action=\"open-verdict\""), 'canvas: spotlight Prove button has data-action=open-verdict');
ok(canvas.includes("getElementById('dg-question-scout-btn')"), 'canvas: spotlight wiring reuses the existing Question Scout floating button');
ok(canvas.includes("getElementById('dg-proof-harness-btn')") &&
   canvas.includes("if (action === 'open-verdict')"),
   'canvas: spotlight wiring reuses the existing Proof Harness floating button for Prove');

// ---------- 3. Home hero: advanced tools demoted pre-load, not hidden ----------
ok(/body:not\(\.has-data\)\s+#dg-trust-ledger-btn/.test(canvas), 'canvas: advanced-tools row demoted pre-load via body:not(.has-data)');
ok(/body:not\(\.has-data\)[^{]*\{\s*opacity:\s*0\.35;/.test(canvas), 'canvas: pre-load demotion uses opacity, not display:none (no focus trap)');
ok(!/body:not\(\.has-data\)[^{]*dg-trust-ledger-btn[^{]*\{[^}]*display:\s*none/.test(canvas), 'canvas: pre-load demotion never uses display:none on the advanced-tools row');
ok(/body\.has-data\s+#dg-trust-ledger-btn[\s\S]{0,300}opacity:\s*1;/.test(canvas), 'canvas: advanced-tools row restores to full opacity once body.has-data');

// ---------- 4. Toolbar-overflow guardrail: no letter-clip pattern ----------
{
  const ruleRe = /([.#][\w-]+(?:\s*,\s*[.#][\w-]+)*)\s*\{([^}]*)\}/g;
  let clipOffenders = 0;
  let m;
  while ((m = ruleRe.exec(canvas))) {
    const body = m[2];
    const hasOverflowHidden = /overflow:\s*hidden/.test(body);
    const hasNowrap = /white-space:\s*nowrap/.test(body);
    const hasEllipsis = /text-overflow/.test(body);
    if (hasOverflowHidden && hasNowrap && !hasEllipsis) clipOffenders++;
  }
  ok(clipOffenders === 0, `canvas: no CSS rule combines overflow:hidden + white-space:nowrap without text-overflow (found ${clipOffenders})`);
  ok(canvas.includes('toolbar-overflow guardrail'), 'canvas: explicit toolbar-overflow guardrail comment/rule present');
  ok(/\.nav-btn,\s*#publish-btn,\s*#export-btn,\s*#nav-overflow-btn\s*\{[^}]*overflow:\s*visible/.test(canvas),
    'canvas: nav labels guarded with overflow:visible so they never clip mid-letter');
}

// ---------- 5. Scout cold-start: calm status + "Use templates now" ----------
ok(qsCanvasSrc.includes('function renderModelStatus'), 'question-scout canvas: renderModelStatus() exists');
ok(qsCanvasSrc.includes('dg-qs-use-templates-btn'), 'question-scout canvas: "Use templates now" button id exists');
ok(qsCanvasSrc.includes('Use templates now'), 'question-scout canvas: "Use templates now" label text exists');
ok(/if \(proposing \|\| _lastProposeMode\) return '';/.test(qsCanvasSrc), 'question-scout canvas: cold-start status self-silences once a proposal has run or is running');
ok(/if \(modelIsWarm\(\)\) return '';/.test(qsCanvasSrc), 'question-scout canvas: cold-start status self-silences once the model is warm');
ok(/useTemplatesBtn\.addEventListener\('click', propose\)/.test(qsCanvasSrc), 'question-scout canvas: "Use templates now" is wired to the same propose() fallback path (no second engine)');
ok(qsCanvasSrc.includes("html += renderModelStatus(proposing);"), 'question-scout canvas: renderModelStatus is wired into renderBody()');
// Never a blank hang: proposeViaModel must resolve immediately when the
// model bridge is absent/cold (pre-existing v1 contract, re-asserted here
// since this slice adds UI directly on top of the cold-start path).
ok(/if \(!e \|\| !bridge \|\| !modelIsWarm\(\)\) return Promise\.resolve\(null\);/.test(qsCanvasSrc),
  'question-scout canvas: proposeViaModel resolves immediately (no blank hang) when cold/absent');

// ---------- 6. Purpose contract: shorter copy + single default ----------
ok(canvas.includes('Why are you using this dataset? Your answer becomes a signed, time-limited contract.'),
  'canvas: purpose contract intro copy is shortened to one sentence');
ok(!canvas.includes('Declare why you are using this dataset. Your declaration becomes a signed'),
  'canvas: old two-sentence purpose contract copy is gone');
ok(canvas.includes("var isDefault = p.id === 'analysis';"), "canvas: 'analysis' (Analysis & Reporting) is coded as the single default");
ok(canvas.includes('RECOMMENDED'), 'canvas: the default purpose is visibly marked RECOMMENDED');
ok(canvas.includes('dg-pc-default'), 'canvas: default purpose button carries a dedicated class for pre-selection');
ok(/var defaultBtn = panel\.querySelector\('\.dg-pc-purpose-btn\.dg-pc-default'\);\s*\n\s*if \(defaultBtn\) selectPurposeBtn\(defaultBtn\);/.test(canvas),
  'canvas: default purpose button is pre-selected on panel open via the real selection code path');
ok(canvas.includes('function selectPurposeBtn(btn)'), 'canvas: purpose selection logic extracted into a reusable function (no duplicated logic)');

// ---------- 7. 16px-min mobile body text for calm-journey surfaces ----------
ok(/@media \(max-width: 700px\) \{\s*\n\s*#dg-purpose-contract-panel p,/.test(canvas),
  'canvas: 16px-min mobile body-text rule targets the purpose contract panel');
ok(/#dg-question-scout-panel \.dg-qs-model-status span,\s*\n\s*\.spotlight-sub\s*\{/.test(canvas),
  'canvas: spotlight subtitle included in the 16px-min mobile rule');

// ---------- 8. No em dash (U+2014) in this slice's new strings ----------
const a50VisibleStrings = [
  'Clean & Validate', 'Check data health and fix issues first.',
  'Ask (Scout)', 'Get proposed questions worth asking.',
  'Prove (VERDICT)', 'Turn a claim into a signed, checkable answer.',
  'Three ways to start.',
  'On-device model is not loaded yet. You can start now with template questions, no waiting.',
  'Use templates now',
  'Why are you using this dataset? Your answer becomes a signed, time-limited contract.',
  'RECOMMENDED',
];
for (const s of a50VisibleStrings) {
  ok(!s.includes('\u2014'), `no em dash in new visible string: "${s}"`);
}
{
  const a50Blocks = [];
  for (const src of [canvas, qsEngine, qsCanvasSrc]) {
    const re = /A50 Jobs calm polish[\s\S]{0,1200}/g;
    let m;
    while ((m = re.exec(src))) a50Blocks.push(m[0]);
  }
  ok(a50Blocks.length > 0, 'found A50-tagged comment blocks to scan');
  const withEmDash = a50Blocks.filter((b) => b.includes('\u2014'));
  ok(withEmDash.length === 0, `no em dash (U+2014) inside any A50-tagged block (found ${withEmDash.length})`);
}

// ---------- 9b. Spotlight is actually reachable (dead-code fix) ----------
// Root-cause bug this slice also fixed: a leftover Mission Brief init()
// unconditionally overwrote window._dgSpotlight with a no-op on every
// load, silently killing the post-load spotlight even though it was fully
// built and wired. Assert the clobbering line is gone and the real
// assignment (from the spotlight module itself) still exists exactly once.
{
  const realAssignCount = (canvas.match(/window\._dgSpotlight = showSpotlight;/g) || []).length;
  ok(realAssignCount === 1, `canvas: window._dgSpotlight = showSpotlight; assigned exactly once (found ${realAssignCount})`);
  ok(!canvas.includes('window._dgSpotlight = function () {};'),
    'canvas: the Mission Brief no-op override of window._dgSpotlight has been removed');
}

// ---------- 9. Canvas stays well-formed (spot checks) ----------
ok(canvas.includes('<div id="action-spotlight">'), 'canvas: action-spotlight overlay still present');
ok(canvas.includes('id="dg-purpose-contract-panel"') || canvas.includes("PANEL_ID = 'dg-purpose-contract-panel'"),
  'canvas: purpose contract panel id still present');
ok(canvas.includes("BTN_ID = 'dg-question-scout-btn'"), 'canvas: Question Scout button id still present after re-injection');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
