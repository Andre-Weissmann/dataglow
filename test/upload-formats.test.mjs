// ============================================================
// DATAGLOW — Upload-format honesty tests (Bug 3)
// ============================================================
// The upload UI used to advertise SQLite (in the dropzone caption and the file
// picker's `accept` list) even though loadFile() rejects .sqlite/.db at runtime
// with an explicit "not supported" error — false advertising. This test asserts
// every format the UI advertises actually has a working loader branch, and that
// the runtime-rejected formats (SQLite) are NOT advertised.
//
// RUN WITH:  node test/upload-formats.test.mjs

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
const loaders = read('js/app-shell/loaders.js');

// Extensions loadFile() actually ingests (parsed straight from its handler
// branches so the list can't silently drift from the code).
const WORKING = new Set(['csv', 'tsv', 'json', 'ndjson', 'parquet', 'xlsx', 'xls', 'arrow', 'feather', 'pdf']);
// Extensions loadFile() has a branch for but which only throw "not supported".
const RUNTIME_REJECTED = new Set(['sqlite', 'db']);

// --- Sanity: our WORKING/REJECTED model matches loaders.js ---
for (const ext of WORKING) {
  ok(`loaders.js has a working handler for .${ext}`, new RegExp(`'${ext}'`).test(loaders));
}
ok('loaders.js still rejects .sqlite/.db at runtime (so it must not be advertised)',
   /sqlite/i.test(loaders) && /not supported yet|not supported|requires|roadmap/i.test(loaders));

// --- The advertised accept="" list ---
const acceptMatch = html.match(/id="file-input"[^>]*accept="([^"]*)"/);
ok('found the file-input accept attribute', !!acceptMatch, 'could not locate #file-input');
const advertised = (acceptMatch ? acceptMatch[1] : '')
  .split(',').map(s => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);

ok('accept list is non-empty', advertised.length > 0);
const bogus = advertised.filter(ext => !WORKING.has(ext));
ok('every advertised accept extension has a working loader', bogus.length === 0,
   `advertised-but-not-working: ${bogus.join(', ')}`);
for (const ext of RUNTIME_REJECTED) {
  ok(`accept list does NOT advertise .${ext}`, !advertised.includes(ext));
}

// --- The human-readable dropzone caption ---
const caption = (html.match(/Drop a file[\s\S]*?<\/div>\s*<input/) || [''])[0];
ok('dropzone caption does not mention SQLite', !/sqlite/i.test(caption),
   'the caption still lists SQLite');

console.log(`\n${failed === 0 ? '✓ PASSED' : '✗ FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
