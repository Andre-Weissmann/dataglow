// ============================================================
// DATAGLOW — Offline-capability claim accuracy tests (Bug 4)
// ============================================================
// DATAGLOW self-hosts the engines needed at page load (DuckDB-WASM, Plotly,
// SheetJS) but pulls the large optional runtimes (Pyodide, WebR, WebLLM) from
// public CDNs on demand — so the app is only fully air-gapped for the core, not
// for Python/R/Story until each runtime's one-time download completes. These
// tests assert the code actually matches that split AND that the UI/README
// disclose it precisely, so a blanket "works fully offline" claim can't creep
// back in.
//
// RUN WITH:  node test/offline-claims.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

const html = read('index.html');
const readme = read('README.md');
const py = read('js/runtimes-viz/python-runtime.js');
const r = read('js/runtimes-viz/r-runtime.js');
const llm = read('js/narrative/ondevice-llm.js');

// ============================================================
console.log('\nGround truth: which engines are self-hosted vs CDN-loaded');

// Self-hosted (offline from first load): referenced by local assets/ paths, no CDN.
ok('DuckDB-WASM is self-hosted (assets/duckdb import map, no CDN)',
   /"\.\/assets\/duckdb\//.test(html));
ok('Plotly is self-hosted (assets/plotly script)',
   /src="assets\/plotly\//.test(html));
ok('SheetJS is self-hosted (assets/xlsx script)',
   /src="assets\/xlsx\//.test(html));
ok('no self-hosted engine is loaded from a CDN in index.html',
   !/src="https?:\/\/[^"]*(plot\.ly|jsdelivr|cdnjs|unpkg)[^"]*"/i.test(html));

// CDN-loaded on demand: their runtime modules point at a public CDN.
ok('Pyodide is CDN-loaded on demand (python-runtime.js references a CDN URL)',
   /https:\/\/cdn\.jsdelivr\.net\/pyodide/.test(py));
ok('WebR is CDN-loaded on demand (r-runtime.js references webr.r-wasm.org)',
   /https:\/\/webr\.r-wasm\.org/.test(r));
ok('WebLLM is CDN-loaded on demand (ondevice-llm.js references a CDN URL)',
   /https:\/\/esm\.run\/@mlc-ai\/web-llm/.test(llm));

// ============================================================
console.log('\nREADME discloses the self-hosted vs on-demand split');
ok('README states page-load libraries are self-hosted / fetch nothing from a third party',
   /self-hosted[\s\S]*fetches nothing from a third party/i.test(readme));
ok('README has a "Loaded from public CDNs on demand" section',
   /Loaded from public CDNs on demand/i.test(readme));
ok('README names Pyodide and WebR as the on-demand runtimes',
   /public CDNs on demand[\s\S]*Pyodide[\s\S]*WebR/i.test(readme));

// ============================================================
console.log('\nUI discloses the one-time CDN download for Python & R');

// Python and R panels must warn that their runtime needs a one-time internet
// download — otherwise "runs in-browser" reads as "works offline", which is
// only true after the first fetch.
const pyPanel = (html.match(/id="panel-python"[\s\S]*?<\/section>/) || [''])[0];
const rPanel = (html.match(/id="panel-r"[\s\S]*?<\/section>/) || [''])[0];
ok('Python panel discloses a one-time CDN/internet download',
   /one-time/i.test(pyPanel) && /(CDN|internet|download)/i.test(pyPanel), 'no one-time-download note in Python panel');
ok('R panel discloses a one-time CDN/internet download',
   /one-time/i.test(rPanel) && /(CDN|internet|download)/i.test(rPanel), 'no one-time-download note in R panel');

// A canonical Offline-capability note in the About section that separates the
// two classes of engine.
const aboutNote = (html.match(/data-testid="offline-capability-note"[\s\S]*?<\/p>/) || [''])[0];
ok('About section has an Offline-capability note', aboutNote.length > 0);
ok('the note affirms the core works offline from first load',
   /no internet connection from the first\s+load|offline[\s\S]*from (the )?first load/i.test(aboutNote));
ok('the note names Pyodide, WebR and WebLLM as one-time-download engines',
   /Pyodide/.test(aboutNote) && /WebR/.test(aboutNote) && /WebLLM/.test(aboutNote) && /one-time/i.test(aboutNote));

console.log(`\n${failed === 0 ? '✓ PASSED' : '✗ FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
