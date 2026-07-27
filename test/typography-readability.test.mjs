// ============================================================
// DATAGLOW - A48 typography/readability contract test
// ============================================================
// Proves the SPEC in A48_TYPOGRAPHY_READABILITY_SPEC.md at the level cheap
// string/regex checks can prove, across both frontend surfaces:
//   - canvas/index.html (AUTHORITATIVE for the single-file web surface)
//   - css/base.css + css/app.css (shared tokens, root index.html / desktop shell)
//
// Checks:
//   1. html { font-size: 100%; } is present (honors the browser/user default,
//      typically 16px, and keeps zoom/text-size prefs working).
//   2. body font-size resolves to 1rem (canvas: literal `1rem`; shared: the
//      `--text-base` token, itself pinned at a 1rem floor via clamp()).
//   3. body line-height is 1.5 (canvas literal; shared base.css literal).
//   4. No `font-size: 9px` / `9.5px` / `10px` / `10.5px` remain anywhere in
//      canvas/index.html or css/*.css - the SPEC's "kill 9-10px actionable
//      text" floor. (Badges/meta may still sit at the 0.75rem/12px floor.)
//   5. The canvas font stack keeps Geist as an enhancement but falls back to
//      the full cross-platform system stack the SPEC names, so text still
//      looks intentional if the Geist CDN is blocked.
//
// This is a pure string-based test: no DOM, no browser, no CSS parser engine.
// RUN WITH: node test/typography-readability.test.mjs

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
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- 1. html { font-size: 100%; } ----------
ok(/html\s*\{[^}]*font-size:\s*100%/.test(canvas),
  'canvas/index.html: html { font-size: 100%; } is present (browser default root)');
ok(/html\s*\{[^}]*font-size:\s*100%/.test(baseCss),
  'css/base.css: html { font-size: 100%; } is present (browser default root)');

// ---------- 2 + 3. body font-size / line-height ----------
{
  const m = /(?<!html,\s)body\s*\{([^}]*)\}/.exec(canvas);
  ok(!!m, 'canvas/index.html: a standalone body { ... } rule exists');
  const body = m ? m[1] : '';
  ok(/font-size:\s*1rem\b/.test(body), 'canvas/index.html: body font-size is 1rem (not 14px)');
  ok(/line-height:\s*1\.5\b/.test(body), 'canvas/index.html: body line-height is 1.5');
  ok(!/font-size:\s*14px/.test(body), 'canvas/index.html: body font-size is NOT hardcoded to 14px');
}
{
  const m = /body\s*\{([^}]*)\}/.exec(baseCss);
  ok(!!m, 'css/base.css: a body { ... } rule exists');
  const body = m ? m[1] : '';
  ok(/font-size:\s*var\(--text-base\)/.test(body), 'css/base.css: body font-size uses the --text-base token');
  ok(/line-height:\s*1\.5\b/.test(body), 'css/base.css: body line-height is 1.5');
  // --text-base is a clamp() whose floor and preferred value both resolve to a
  // 1rem-scale (0.9375rem-1rem), never a fixed sub-rem px value.
  const textBaseMatch = /--text-base:\s*([^;]+);/.exec(baseCss);
  ok(!!textBaseMatch && /rem/.test(textBaseMatch[1]) && !/\dpx/.test(textBaseMatch[1]),
    'css/base.css: --text-base is defined in rem, not fixed px');
}

// ---------- 4. no 9px/9.5px/10px/10.5px font-size anywhere in scope ----------
const killPattern = /font-size:\s*(?:9(?:\.5)?|10(?:\.5)?)px/;
ok(!killPattern.test(canvas), 'canvas/index.html: no font-size at 9px/9.5px/10px/10.5px remains');
ok(!killPattern.test(baseCss), 'css/base.css: no font-size at 9px/9.5px/10px/10.5px remains');
ok(!killPattern.test(appCss), 'css/app.css: no font-size at 9px/9.5px/10px/10.5px remains');

// ---------- 5. cross-platform font stack ----------
{
  const m = /--dg-font-sans:\s*([^;]+);/.exec(canvas);
  ok(!!m, 'canvas/index.html: --dg-font-sans token is defined');
  const stack = m ? m[1] : '';
  for (const fallback of ['Geist', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']) {
    ok(stack.includes(fallback), `canvas/index.html: --dg-font-sans includes ${fallback}`);
  }
  ok(/body\s*\{[^}]*font-family:\s*var\(--dg-font-sans\)/.test(canvas),
    'canvas/index.html: body font-family uses --dg-font-sans (Geist + full fallback chain)');
}
{
  const stack = /--font-body:\s*([^;]+);/.exec(baseCss)?.[1] || '';
  for (const fallback of ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']) {
    ok(stack.includes(fallback), `css/base.css: --font-body includes ${fallback}`);
  }
}

// ---------- rem token ladder present (single source of truth) ----------
for (const token of ['--dg-text-xs', '--dg-text-sm', '--dg-text-md', '--dg-text-lg', '--dg-text-xl', '--dg-text-2xl']) {
  ok(canvas.includes(`${token}:`), `canvas/index.html: ${token} rem token is defined`);
}
ok(/--dg-text-xs:\s*0\.75rem/.test(canvas), 'canvas/index.html: --dg-text-xs floor is 0.75rem (12px badges/meta)');
ok(/--dg-text-sm:\s*0\.875rem/.test(canvas), 'canvas/index.html: --dg-text-sm is 0.875rem (14px actionable minimum)');
ok(/--dg-text-md:\s*1rem\b/.test(canvas), 'canvas/index.html: --dg-text-md is 1rem (16px body/primary)');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
