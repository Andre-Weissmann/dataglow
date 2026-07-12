// ============================================================
// DATAGLOW — Runtime charting: pure-logic tests
// ============================================================
// The Python (Pyodide) and R (WebR) tabs now return an `images` array of
// base64 PNG data URLs so charts render inline, and the R tab returns
// `graphicsAvailable`/`hasJsonlite` flags that drive honest fallback notices.
// These tests cover the DOM-free pure helpers that back that behavior:
//   1. extractImageDataUrls() (identical shape in both runtimes) keeps only
//      real data:image/ URLs and drops anything else — so a malformed capture
//      can never inject a bogus <img src>.
//   2. buildRBridgeNotices() (R) emits a note ONLY when a package actually
//      failed to install, making the previously-silent jsonlite/ggplot2
//      fallbacks visible.
//
// RUN WITH:  node test/runtime-charts.test.mjs      (no DuckDB, no network)

import {
  extractImageDataUrls as pyExtract,
} from '../js/runtimes-viz/python-runtime.js';
import {
  extractImageDataUrls as rExtract,
  buildRBridgeNotices,
} from '../js/runtimes-viz/r-runtime.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

console.log('\nextractImageDataUrls (Python & R share one shape)');
for (const [label, extract] of [['python', pyExtract], ['r', rExtract]]) {
  ok(`${label}: keeps valid data:image/ URLs`,
    extract(['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB']).length === 2);
  ok(`${label}: drops non-data-image strings`,
    extract(['data:image/png;base64,AAAA', 'https://evil/x.png', 'javascript:alert(1)']).length === 1);
  ok(`${label}: drops non-string entries`,
    extract(['data:image/png;base64,AAAA', null, 42, {}, undefined]).length === 1);
  ok(`${label}: non-array input returns []`, extract(undefined).length === 0 && extract(null).length === 0);
  ok(`${label}: empty array returns []`, extract([]).length === 0);
  ok(`${label}: preserves order`,
    JSON.stringify(extract(['data:image/png;base64,1', 'data:image/png;base64,2']))
      === JSON.stringify(['data:image/png;base64,1', 'data:image/png;base64,2']));
}

console.log('\nbuildRBridgeNotices (R fallbacks become visible)');
ok('no notices when everything installed',
  buildRBridgeNotices({ graphicsAvailable: true, hasJsonlite: true }).length === 0);
ok('jsonlite fallback surfaces a bridge notice',
  buildRBridgeNotices({ graphicsAvailable: true, hasJsonlite: false })
    .some(n => /simplified data bridge/i.test(n)));
ok('ggplot2 failure surfaces a graphics notice',
  buildRBridgeNotices({ graphicsAvailable: false, hasJsonlite: true })
    .some(n => /ggplot2 could not be installed/i.test(n)));
ok('both failing surfaces both notices',
  buildRBridgeNotices({ graphicsAvailable: false, hasJsonlite: false }).length === 2);
ok('missing/undefined flags produce no false-positive notices',
  buildRBridgeNotices({}).length === 0 && buildRBridgeNotices().length === 0);

console.log(`\n${failed === 0 ? '✓ PASSED' : '✗ FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
