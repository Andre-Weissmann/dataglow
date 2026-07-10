// ============================================================
// DATAGLOW — PWA manifest + service worker sanity tests
// ============================================================
// Validates the installability contract without a real browser:
//   1. manifest.webmanifest is well-formed JSON with all required fields and
//      the required icon sizes (192 + 512, plus a maskable variant).
//   2. Every icon referenced by the manifest actually exists on disk and the
//      PNGs carry the pixel dimensions they claim.
//   3. index.html links the manifest, the iOS meta tags, and registers sw.js.
//   4. sw.js exists, parses without syntax error, versions its cache, and cleans
//      up old caches on activate.
//
// Full runtime service-worker behavior (offline caching) is a browser concern
// verified manually / in e2e; this suite is the static sanity gate.
//
// RUN WITH:  node test/pwa-manifest.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}
function read(p) { return readFileSync(join(root, p), 'utf8'); }

// PNG dimensions straight from the IHDR chunk (no image library needed).
function pngSize(relPath) {
  const buf = readFileSync(join(root, relPath));
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error(`${relPath} is not a PNG`);
  // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ============================================================
console.log('\nManifest');
let manifest;
try {
  manifest = JSON.parse(read('manifest.webmanifest'));
  ok('manifest.webmanifest is valid JSON', true);
} catch (e) {
  ok('manifest.webmanifest is valid JSON', false, e.message);
  console.log('\n✗ FAILURES — cannot continue without a parseable manifest\n');
  process.exit(1);
}

const requiredFields = ['name', 'short_name', 'description', 'start_url', 'display', 'background_color', 'theme_color', 'icons'];
for (const f of requiredFields) ok(`manifest has "${f}"`, manifest[f] !== undefined, `missing ${f}`);

ok('short_name is "DATAGLOW"', manifest.short_name === 'DATAGLOW', `got ${manifest.short_name}`);
ok('display is "standalone"', manifest.display === 'standalone', `got ${manifest.display}`);
ok('theme_color is a hex color', /^#[0-9a-fA-F]{6}$/.test(manifest.theme_color || ''), `got ${manifest.theme_color}`);
ok('background_color is a hex color', /^#[0-9a-fA-F]{6}$/.test(manifest.background_color || ''), `got ${manifest.background_color}`);
ok('icons is a non-empty array', Array.isArray(manifest.icons) && manifest.icons.length > 0);

// Required PNG sizes.
const pngIcons = manifest.icons.filter(i => i.type === 'image/png');
const has192 = pngIcons.some(i => i.sizes === '192x192');
const has512 = pngIcons.some(i => i.sizes === '512x512');
ok('has a 192x192 PNG icon', has192);
ok('has a 512x512 PNG icon', has512);
const hasMaskable = manifest.icons.some(i => typeof i.purpose === 'string' && i.purpose.split(/\s+/).includes('maskable'));
ok('has a maskable icon variant', hasMaskable);

// Every referenced icon exists; PNGs match declared dimensions.
console.log('\nIcon files');
for (const icon of manifest.icons) {
  let exists = true;
  try { readFileSync(join(root, icon.src)); } catch { exists = false; }
  ok(`icon exists: ${icon.src}`, exists);
  if (exists && icon.type === 'image/png' && /^\d+x\d+$/.test(icon.sizes || '')) {
    const [w, h] = icon.sizes.split('x').map(Number);
    let dims;
    try { dims = pngSize(icon.src); } catch (e) { dims = null; }
    ok(`icon ${icon.src} is ${icon.sizes}`, !!dims && dims.width === w && dims.height === h,
      dims ? `actual ${dims.width}x${dims.height}` : 'could not read PNG');
  }
}

// ============================================================
console.log('\nindex.html wiring');
const html = read('index.html');
ok('links the manifest', /<link[^>]+rel=["']manifest["'][^>]+href=["']manifest\.webmanifest["']/.test(html));
ok('has theme-color meta', /<meta[^>]+name=["']theme-color["']/.test(html));
ok('has apple-touch-icon', /<link[^>]+rel=["']apple-touch-icon["']/.test(html));
ok('has apple-mobile-web-app-capable', /name=["']apple-mobile-web-app-capable["']/.test(html));
ok('has apple-mobile-web-app-status-bar-style', /name=["']apple-mobile-web-app-status-bar-style["']/.test(html));
ok('has apple-mobile-web-app-title', /name=["']apple-mobile-web-app-title["']/.test(html));
ok('registers the service worker', /serviceWorker/.test(html) && /register\(\s*['"]sw\.js['"]\s*\)/.test(html));
ok('guards SW registration with feature check', /'serviceWorker'\s+in\s+navigator/.test(html));
ok('handles beforeinstallprompt', /beforeinstallprompt/.test(html));
// The one cross-origin subresource on a normal page load (Google Fonts CSS) must
// be requested crossorigin so it satisfies the SW-stamped COEP: require-corp.
ok('Google Fonts stylesheet is loaded crossorigin (COEP-safe)',
  /<link[^>]+fonts\.googleapis\.com[^>]+crossorigin/.test(html));

// ============================================================
console.log('\nService worker (sw.js)');
const sw = read('sw.js');

// Parses without syntax error (compile in a throwaway VM context — do NOT run,
// since it references self/caches which only exist in a SW runtime).
let parses = true, parseErr = '';
try { new vm.Script(sw, { filename: 'sw.js' }); } catch (e) { parses = false; parseErr = e.message; }
ok('sw.js parses without syntax error', parses, parseErr);

ok('sw.js versions its cache name', /dataglow-shell-/.test(sw) && /CACHE_VERSION/.test(sw));
ok('sw.js precaches an app shell list', /PRECACHE_URLS/.test(sw) && /index\.html/.test(sw));
ok('sw.js cleans up old caches on activate', /addEventListener\(\s*['"]activate['"]/.test(sw) && /caches\.delete/.test(sw));
ok('sw.js handles fetch events', /addEventListener\(\s*['"]fetch['"]/.test(sw));
ok('sw.js only touches same-origin requests', /self\.location\.origin/.test(sw));
ok('sw.js skips non-GET (does not cache LLM POSTs)', /request\.method\s*!==\s*['"]GET['"]/.test(sw));
// Cross-origin isolation: the host sets COOP but not COEP, so the SW must stamp
// both onto navigations to make window.crossOriginIsolated true for DuckDB-WASM.
ok('sw.js stamps COOP: same-origin on navigations',
  /Cross-Origin-Opener-Policy['"]\s*,\s*['"]same-origin/.test(sw));
ok('sw.js stamps COEP: require-corp on navigations',
  /Cross-Origin-Embedder-Policy['"]\s*,\s*['"]require-corp/.test(sw));

// ============================================================
console.log(`\n${failed === 0 ? '✓ ALL PASSED' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
