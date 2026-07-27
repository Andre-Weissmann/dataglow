// ============================================================
// DATAGLOW - A48 full Jobs polish contract test
// ============================================================
// Proves the SPEC in A48_JOBS_POLISH_FULL_SPEC.md at the level cheap
// string/regex checks can prove, across both frontend surfaces:
//   - canvas/index.html (AUTHORITATIVE for the single-file web surface)
//   - css/base.css + css/app.css (shared tokens, root index.html / desktop shell)
//
// This test is additive to test/typography-readability.test.mjs (slice 0):
// it does not re-check the html/body rem contract or the 9-10px sweep that
// slice already covers, but it DOES re-assert the "no 9/10px chrome relapse"
// floor scoped to the specific chrome selectors this slice touched, so a
// future edit cannot quietly reintroduce it in exactly the surfaces this PR
// hardened.
//
// Checks:
//   1. The rem spacing/radius/control-height/shadow token ladder from the
//      SPEC is present in canvas/index.html :root (--dg-space-1..8,
//      --dg-radius-sm/md/lg, --dg-control-h, --dg-shadow-soft-*).
//   2. The matching --control-h token exists in css/base.css.
//   3. --dg-control-h resolves to 2.75rem (~44px), never a literal px value.
//   4. Primary buttons (canvas + css/base.css .btn-primary) use the
//      control-height token, not a bare "44px" literal, so it stays a token
//      that scales with root font-size instead of drifting back to a magic
//      number.
//   5. No 9px/9.5px/10px/10.5px font-size relapse anywhere in canvas/index.html,
//      css/base.css, or css/app.css (mirrors slice 0's floor, re-asserted here
//      since this slice edits nearby chrome).
//   6. Dense data-table selectors never drop below the 0.75rem floor.
//   7. focus-visible coverage exists for buttons, tabs and inputs (not just
//      a single selector) in both canvas and css/base.css/app.css.
//   8. prefers-reduced-motion is honored in both css/base.css and
//      canvas/index.html.
//   9. Tab active/inactive visual distinction exists (font-weight or color
//      delta) in css/app.css and canvas/index.html.
//  10. No em dash (U+2014) was introduced in this slice's new tokens/rules
//      (spot-checked against the literal strings this test file itself
//      knows it added).
//
// This is a pure string-based test: no DOM, no browser, no CSS parser engine.
// RUN WITH: node test/jobs-polish-a48.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CANVAS = join(repoRoot, 'canvas', 'index.html');
const BASE_CSS = join(repoRoot, 'css', 'base.css');
const APP_CSS = join(repoRoot, 'css', 'app.css');

const canvas = readFileSync(CANVAS, 'utf8');
const baseCss = readFileSync(BASE_CSS, 'utf8');
const appCss = readFileSync(APP_CSS, 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

// ---------- 1. rem token ladder in canvas/index.html :root ----------
for (const token of [
  '--dg-space-1', '--dg-space-2', '--dg-space-3', '--dg-space-4',
  '--dg-space-5', '--dg-space-6', '--dg-space-7', '--dg-space-8',
  '--dg-radius-sm', '--dg-radius-md', '--dg-radius-lg',
  '--dg-control-h',
  '--dg-shadow-soft-sm', '--dg-shadow-soft-md', '--dg-shadow-soft-lg'
]) {
  ok(canvas.includes(`${token}:`), `canvas/index.html: ${token} token is defined`);
}

// ---------- 2. shared --control-h token in css/base.css ----------
ok(/--control-h:\s*[\d.]+rem/.test(baseCss), 'css/base.css: --control-h token is defined in rem');

// ---------- 3. control-height tokens resolve to rem, never a bare px literal ----------
{
  const m = /--dg-control-h:\s*([^;]+);/.exec(canvas);
  ok(!!m, 'canvas/index.html: --dg-control-h value is present');
  const val = m ? m[1].trim() : '';
  ok(/rem/.test(val), 'canvas/index.html: --dg-control-h is expressed in rem');
  ok(!/^\d+(\.\d+)?px$/.test(val), 'canvas/index.html: --dg-control-h is not a bare px literal');
}
{
  const m = /--control-h:\s*([^;]+);/.exec(baseCss);
  ok(!!m, 'css/base.css: --control-h value is present');
  const val = m ? m[1].trim() : '';
  ok(/rem/.test(val), 'css/base.css: --control-h is expressed in rem');
}

// ---------- 4. primary buttons consume the control-height token ----------
ok(/\.btn-primary\s*\{[^}]*min-height:\s*var\(--control-h\)/.test(baseCss),
  'css/base.css: .btn-primary uses var(--control-h), not a literal 44px');
{
  // canvas: the shared primary-button selector group (pivot run / #run-sql-btn / .run-btn / etc.)
  const primaryBlock = /\.pivot-run-btn,[\s\S]{0,400}?min-height:\s*([^;]+);/.exec(canvas);
  ok(!!primaryBlock, 'canvas/index.html: primary-button rule block found');
  ok(!!primaryBlock && /var\(--dg-control-h\)/.test(primaryBlock[1]),
    'canvas/index.html: primary buttons use var(--dg-control-h), not a literal 44px');
}

// ---------- 5. no 9/10px chrome relapse (re-assert slice 0's floor) ----------
const killPattern = /font-size:\s*(?:9(?:\.5)?|10(?:\.5)?)px/;
ok(!killPattern.test(canvas), 'canvas/index.html: no font-size at 9px/9.5px/10px/10.5px remains');
ok(!killPattern.test(baseCss), 'css/base.css: no font-size at 9px/9.5px/10px/10.5px remains');
ok(!killPattern.test(appCss), 'css/app.css: no font-size at 9px/9.5px/10px/10.5px remains');

// ---------- 6. dense data-table selectors never drop below the 0.75rem floor ----------
{
  // .result-table (css/app.css) must resolve through a token, never a literal
  // sub-0.75rem px/rem value.
  const m = /\.result-table\s*\{([^}]*)\}/.exec(appCss);
  ok(!!m, 'css/app.css: .result-table rule exists');
  const body = m ? m[1] : '';
  const literalPx = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(body);
  const literalRem = /font-size:\s*(\d+(?:\.\d+)?)rem/.exec(body);
  ok(!literalPx || Number(literalPx[1]) >= 12, '.result-table: no literal px font-size below the 12px/0.75rem floor');
  ok(!literalRem || Number(literalRem[1]) >= 0.75, '.result-table: no literal rem font-size below the 0.75rem floor');
}

// ---------- 7. focus-visible coverage on buttons/tabs/inputs ----------
ok(/:focus-visible\s*\{/.test(baseCss), 'css/base.css: a global :focus-visible rule exists');
ok(/\.btn:focus-visible/.test(baseCss), 'css/base.css: .btn:focus-visible is defined');
ok(/\.tab:focus-visible/.test(appCss), 'css/app.css: .tab:focus-visible is defined');
ok(/focus-visible/.test(canvas) && (canvas.match(/:focus-visible/g) || []).length >= 5,
  'canvas/index.html: multiple :focus-visible rules exist (not just a single selector)');
{
  // The canvas focus-visible rule group should cover more than just buttons
  // (inputs/textareas/selects/links/tabs), per the SPEC's "focus and feedback" pillar.
  const focusBlock = /\.pivot-run-btn:focus-visible,[\s\S]{0,400}?\{/.exec(canvas);
  ok(!!focusBlock, 'canvas/index.html: primary focus-visible rule group found');
  const group = focusBlock ? focusBlock[0] : '';
  for (const sel of ['input:focus-visible', 'textarea:focus-visible', 'select:focus-visible', 'a:focus-visible']) {
    ok(group.includes(sel), `canvas/index.html: focus-visible group includes ${sel}`);
  }
}

// ---------- 8. prefers-reduced-motion honored ----------
ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(baseCss),
  'css/base.css: prefers-reduced-motion is honored');
ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(canvas),
  'canvas/index.html: prefers-reduced-motion is honored');

// ---------- 9. tab active/inactive distinction ----------
ok(/\.tab\.active\s*\{[^}]*font-weight:\s*600/.test(appCss),
  'css/app.css: .tab.active is visually stronger (font-weight 600) than the default-weight inactive tab');
ok(/\.tab-btn\.active\s*\{[^}]*font-weight:\s*600/.test(canvas) || /\.tab-btn\.active\s*\{\s*background:\s*var\(--primary\)/.test(canvas),
  'canvas/index.html: .tab-btn.active reads as a clearly stronger state than inactive tabs');

// ---------- 10. no em dash introduced by this slice's new rules ----------
{
  const newTokenSection = canvas.slice(canvas.indexOf('--dg-space-1'), canvas.indexOf('--dg-control-h') + 200);
  ok(!newTokenSection.includes('\u2014'), 'canvas/index.html: no em dash introduced in the new spacing/radius/control-height token block');
}
{
  const toastCommentMatch = /showToast global shim[\s\S]{0,700}?\*\//.exec(canvas);
  ok(!!toastCommentMatch, 'canvas/index.html: showToast shim doc comment found');
  ok(!!toastCommentMatch && !toastCommentMatch[0].includes('\u2014'),
    'canvas/index.html: showToast shim doc comment has no em dash');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
