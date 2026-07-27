// ============================================================
// DATAGLOW - A48 HIG cross-platform contract test
// ============================================================
// Proves A48_APPLE_HIG_CROSS_PLATFORM_SPEC.md at the level cheap string/regex
// checks can prove, across both frontend surfaces:
//   - canvas/index.html (AUTHORITATIVE for the single-file web surface)
//   - css/base.css + css/app.css (shared tokens, root index.html / Tauri
//     desktop shell)
//
// This slice is additive to test/typography-readability.test.mjs (slice 0)
// and test/jobs-polish-a48.test.mjs (#630): it does not re-check the rem type
// ladder or the control-height/spacing/radius/shadow tokens those already
// cover. It proves the NEW SPEC surface only: safe-area insets, a dedicated
// touch-min floor, coarse-pointer hit targets, semantic label utilities, calm
// forms, calm empty/loading states, and that the full cross-platform font
// stack (not "-apple-system only") is still intact.
//
// Checks:
//   1. Safe-area tokens (--dg-safe-top/bottom/left/right in canvas,
//      --safe-top/bottom/left/right in css/base.css) are defined via env().
//   2. --dg-touch-min / --touch-min resolve to 2.75rem (never a bare px
//      literal), applied on primary nav + primary CTAs.
//   3. Hairline tokens (--dg-hairline / --hairline) are defined.
//   4. @media (pointer: coarse) hit-target bump exists in canvas, css/base.css
//      (mirrors the pre-existing PR #557 coarse-pointer block; this asserts
//      the NEW token-driven rule this slice adds).
//   5. Semantic label utility classes (title/headline/body/callout/caption/
//      footnote) exist in canvas and css/base.css, built on existing rem type
//      tokens (not new hardcoded font-size literals).
//   6. Calm forms: label-above-field markup class + caption-size helper text
//      + non-scream error color (role token, not a hardcoded red) in both
//      canvas and css/base.css.
//   7. Calm empty/loading utility classes exist and the loading spinner
//      honors prefers-reduced-motion.
//   8. Cross-platform font stack: no font-family declaration anywhere in
//      canvas/index.html, css/base.css, or css/app.css references Apple
//      system fonts (-apple-system/BlinkMacSystemFont/SF Pro) WITHOUT also
//      carrying a Windows (Segoe UI) or Android (Roboto) fallback -- i.e.
//      never "iOS-only cosplay".
//   9. No Career Lane C reference introduced by this slice.
//  10. No em dash (U+2014) introduced in this slice's new token/rule comments.
//
// This is a pure string-based test: no DOM, no browser, no CSS parser engine.
// RUN WITH: node test/a48-hig-cross-platform.test.mjs

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

// ---------- 1. safe-area tokens ----------
for (const token of ['--dg-safe-top', '--dg-safe-bottom', '--dg-safe-left', '--dg-safe-right']) {
  ok(new RegExp(`${token}:\\s*env\\(safe-area-inset-`).test(canvas),
    `canvas/index.html: ${token} is defined via env(safe-area-inset-*)`);
}
for (const token of ['--safe-top', '--safe-bottom', '--safe-left', '--safe-right']) {
  ok(new RegExp(`${token}:\\s*env\\(safe-area-inset-`).test(baseCss),
    `css/base.css: ${token} is defined via env(safe-area-inset-*)`);
}
ok(/var\(--dg-safe-left\)/.test(canvas) && (canvas.match(/var\(--dg-safe-(top|bottom|left|right)\)/g) || []).length >= 4,
  'canvas/index.html: --dg-safe-* tokens are consumed somewhere (not just defined and unused)');
ok(/padding-left:\s*var\(--safe-left\)/.test(baseCss),
  'css/base.css: --safe-left is consumed on body');

// ---------- 2. touch-min token ----------
{
  const m = /--dg-touch-min:\s*([^;]+);/.exec(canvas);
  ok(!!m, 'canvas/index.html: --dg-touch-min is defined');
  const val = m ? m[1].trim() : '';
  ok(val === '2.75rem', 'canvas/index.html: --dg-touch-min resolves to 2.75rem');
}
{
  const m = /--touch-min:\s*([^;]+);/.exec(baseCss);
  ok(!!m, 'css/base.css: --touch-min is defined');
  const val = m ? m[1].trim() : '';
  ok(val === '2.75rem', 'css/base.css: --touch-min resolves to 2.75rem');
}
ok(/min-height:\s*var\(--dg-touch-min\)/.test(canvas),
  'canvas/index.html: something consumes var(--dg-touch-min) for a real min-height');
ok(/min-height:\s*var\(--touch-min\)/.test(baseCss),
  'css/base.css: something consumes var(--touch-min) for a real min-height');
// primary CTAs specifically
ok(/\.btn-primary[^{]*\{[^}]*min-height:\s*var\(--touch-min\)/.test(baseCss),
  'css/base.css: .btn-primary uses the touch-min floor');

// ---------- 3. hairline tokens ----------
ok(/--dg-hairline:\s*[\d.]+px/.test(canvas), 'canvas/index.html: --dg-hairline token is defined');
ok(/--hairline:\s*[\d.]+px/.test(baseCss), 'css/base.css: --hairline token is defined');
ok(/\(min-resolution:\s*2dppx\)/.test(canvas), 'canvas/index.html: hairline gets a high-density progressive enhancement');
ok(/\(min-resolution:\s*2dppx\)/.test(baseCss), 'css/base.css: hairline gets a high-density progressive enhancement');

// ---------- 4. coarse-pointer hit-target bump ----------
{
  const coarseBlocks = canvas.match(/@media\s*\(pointer:\s*coarse\)[^{]*\{/g) || [];
  ok(coarseBlocks.length >= 2,
    `canvas/index.html: at least 2 @media (pointer: coarse) blocks exist (pre-existing PR #557 + this slice's new token-driven one), saw ${coarseBlocks.length}`);
}
ok(/@media\s*\(pointer:\s*coarse\)\s*\{[^}]*min-height:\s*var\(--dg-touch-min\)/s.test(canvas),
  'canvas/index.html: a @media (pointer: coarse) block bumps hit targets using var(--dg-touch-min)');
ok(/@media\s*\(pointer:\s*coarse\)\s*\{[^}]*min-height:\s*var\(--touch-min\)/s.test(baseCss),
  'css/base.css: a @media (pointer: coarse) block bumps hit targets using var(--touch-min)');

// ---------- 5. semantic label utilities ----------
for (const cls of ['dg-label-title', 'dg-label-headline', 'dg-label-body', 'dg-label-callout', 'dg-label-caption', 'dg-label-footnote']) {
  ok(canvas.includes(`.${cls}`), `canvas/index.html: .${cls} semantic label utility exists`);
}
for (const cls of ['label-title', 'label-headline', 'label-body', 'label-callout', 'label-caption', 'label-footnote']) {
  ok(baseCss.includes(`.${cls}`), `css/base.css: .${cls} semantic label utility exists`);
}
// Built on existing rem tokens, not new hardcoded px font-sizes
{
  const block = /\.dg-label-title[\s\S]{0,600}\.dg-label-footnote[^}]*\}/.exec(canvas);
  ok(!!block, 'canvas/index.html: semantic label utility block found');
  ok(!!block && /var\(--dg-text-/.test(block[0]) && !/font-size:\s*\d+px/.test(block[0]),
    'canvas/index.html: semantic labels use --dg-text-* rem tokens, not hardcoded px');
}

// ---------- 6. calm forms ----------
ok(/\.dg-field\s*\{/.test(canvas), 'canvas/index.html: .dg-field label-above-field container exists');
ok(/\.dg-field-label\s*\{/.test(canvas), 'canvas/index.html: .dg-field-label exists');
ok(/\.dg-field-help\s*\{[^}]*font-size:\s*var\(--dg-text-xs\)/.test(canvas),
  'canvas/index.html: .dg-field-help uses caption-size (--dg-text-xs) helper text');
ok(/\.dg-field-error\s*\{[^}]*color:\s*var\(--error\)/.test(canvas),
  'canvas/index.html: .dg-field-error uses the semantic --error role token (calm, theme-aware), not a hardcoded scream-red hex');
ok(/\.field\s*\{/.test(baseCss), 'css/base.css: .field label-above-field container exists');
ok(/\.field-error\s*\{[^}]*color:\s*var\(--color-error\)/.test(baseCss),
  'css/base.css: .field-error uses the semantic --color-error role token');

// ---------- 7. calm empty / loading states ----------
ok(/\.dg-empty-state\s*\{/.test(canvas), 'canvas/index.html: .dg-empty-state utility exists');
ok(/\.dg-empty-state-body[^}]*max-width:\s*42ch/.test(canvas),
  'canvas/index.html: empty-state body copy is width-capped (short, scannable, not a wall of text)');
ok(/\.dg-loading-inline\s*\{/.test(canvas), 'canvas/index.html: .dg-loading-inline (non-blocking) loading utility exists');
{
  const spinnerBlock = /\.dg-loading-spinner[\s\S]{0,400}/.exec(canvas);
  ok(!!spinnerBlock, 'canvas/index.html: .dg-loading-spinner found');
  const afterSpinner = spinnerBlock ? spinnerBlock[0] : '';
  ok(/prefers-reduced-motion:\s*reduce\)\s*\{\s*\.dg-loading-spinner/.test(afterSpinner),
    'canvas/index.html: the new loading spinner has its own prefers-reduced-motion override');
}
ok(/\.loading-inline\s*\{/.test(baseCss), 'css/base.css: .loading-inline utility exists');
ok(/prefers-reduced-motion:\s*reduce\)\s*\{\s*\.loading-spinner/.test(baseCss),
  'css/base.css: .loading-spinner has its own prefers-reduced-motion override');

// ---------- 8. cross-platform font stack: no iOS-only cosplay ----------
{
  // Any font-family value that references an Apple system font must also
  // carry a Windows and/or Android fallback somewhere in the same value.
  const appleFontRe = /font-family\s*:\s*([^;]+);/g;
  const offenders = [];
  for (const src of [
    { name: 'canvas/index.html', text: canvas },
    { name: 'css/base.css', text: baseCss },
    { name: 'css/app.css', text: appCss },
  ]) {
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = appleFontRe.exec(src.text))) {
      const decl = m[1];
      const mentionsApple = /-apple-system|BlinkMacSystemFont|SF Pro|San Francisco/i.test(decl);
      if (!mentionsApple) continue;
      const hasWindowsOrAndroid = /Segoe UI|Roboto|system-ui/i.test(decl);
      if (!hasWindowsOrAndroid) offenders.push(`${src.name}: font-family: ${decl.trim().slice(0, 120)}`);
    }
    appleFontRe.lastIndex = 0;
  }
  ok(offenders.length === 0,
    `no Apple-only font stack (missing Segoe UI/Roboto/system-ui fallback) found; offenders: ${JSON.stringify(offenders)}`);
}
ok(/system-ui/.test(canvas), 'canvas/index.html: system-ui appears in the font stack');
ok(/Segoe UI/.test(canvas), 'canvas/index.html: Segoe UI (Windows) appears in the font stack');
ok(/Roboto/.test(canvas), 'canvas/index.html: Roboto (Android) appears in the font stack');
ok(/Segoe UI/.test(baseCss), 'css/base.css: font-body fallback chain includes Segoe UI (Windows)');
ok(/Roboto/.test(baseCss), 'css/base.css: font-body fallback chain includes Roboto (Android)');

// ---------- 9. no Career Lane C ----------
ok(!/Career Lane C/i.test(canvas), 'canvas/index.html: no Career Lane C reference introduced');
ok(!/Career Lane C/i.test(baseCss) && !/Career Lane C/i.test(appCss),
  'css/base.css and css/app.css: no Career Lane C reference introduced');

// ---------- 10. no em dash in this slice's new comments/rules ----------
{
  const sliceStart = canvas.indexOf('A48 HIG cross-platform (SPEC: A48_APPLE_HIG_CROSS_PLATFORM_SPEC.md)');
  ok(sliceStart !== -1, 'canvas/index.html: this slice\'s marker comment is present');
  const sliceBlock = sliceStart !== -1 ? canvas.slice(sliceStart, sliceStart + 6000) : '';
  ok(!sliceBlock.includes('\u2014'), 'canvas/index.html: no em dash introduced in this slice\'s new CSS block');
}
{
  const sliceStart = baseCss.indexOf('A48 HIG cross-platform (SPEC: A48_APPLE_HIG_CROSS_PLATFORM_SPEC.md)');
  ok(sliceStart !== -1, 'css/base.css: this slice\'s marker comment is present');
  const sliceBlock = sliceStart !== -1 ? baseCss.slice(sliceStart) : '';
  ok(!sliceBlock.includes('\u2014'), 'css/base.css: no em dash introduced in this slice\'s new CSS block');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
