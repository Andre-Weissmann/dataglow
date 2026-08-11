// ============================================================
// DATAGLOW — Bundle B: honesty on unsupported formats
// ============================================================
// The binary-format `else` branch in routeDroppedFile() used to invent a
// 2-column, 1-row dataset saying the format was "detected" and push it through
// runSequencedReveal(). The user was shown "1 rows. 2 columns. Ready." and a
// green toast reading "100/100. This data has been cleaned, sourced, and
// reviewed." about a file DataGlow had never opened.
//
// This suite proves the refusal by executing the shipped refusal path against a
// minimal DOM, then asserting on what the user would actually see:
//   * no dataset object is constructed;
//   * runSequencedReveal is never called;
//   * no score, grade, or "cleaned, sourced, reviewed" language is emitted;
//   * the message names the format and gives one concrete next step.
//
// RUN WITH: node test/unsupported-format-honesty.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const canvas = readFileSync(join(repoRoot, 'canvas', 'index.html'), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log('\u2713 ' + label); }
  else { failed++; console.log('\u2717 FAILED: ' + label); }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
     JSON.stringify(actual) === JSON.stringify(expected));
}

function extractFunctionSource(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) return null;
  let depth = 0;
  for (let i = startIdx + startMarker.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
  }
  return null;
}

function extractVarObject(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) return null;
  const semi = src.indexOf('};', startIdx);
  return semi === -1 ? null : src.slice(startIdx, semi + 2);
}

// ============================================================
console.log('\n1. The fabrication is gone from the shipped canvas');
// ============================================================
ok('the fabricated "full parsing pending future integration" row is gone',
   !canvas.includes('full parsing pending future integration'));
ok('the fabricated { name: \'file\' } / { name: \'status\' } placeholder dataset is gone',
   !canvas.includes("{ name: 'file', type: 'STR' },\n          { name: 'status', type: 'STR' }"));

const routeSrc = extractFunctionSource(canvas, 'function routeDroppedFile(file, name, format, fileHash, seenBefore, advance) {');
ok('routeDroppedFile is present verbatim', routeSrc !== null);

// Split off the final else branch and check it in isolation. Comments are
// stripped first, since the branch's own comment describes the bug it fixed and
// names the functions it must never call.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const routeCode = routeSrc ? stripComments(routeSrc) : '';
const elseIdx = routeCode ? routeCode.lastIndexOf('} else {') : -1;
const elseBranch = elseIdx === -1 ? '' : routeCode.slice(elseIdx);
ok('the unsupported-format branch never calls runSequencedReveal',
   elseBranch.length > 0 && !elseBranch.includes('runSequencedReveal('));
ok('the unsupported-format branch never builds a dataset object',
   !elseBranch.includes('columns:') && !elseBranch.includes('buildDatasetFromRows'));
ok('the unsupported-format branch calls the refusal instead',
   elseBranch.includes('showUnsupportedFormatNotice(name, fmt);'));

// ============================================================
console.log('\n2. The refusal, executed against a minimal DOM');
// ============================================================
const noticeFn = extractFunctionSource(canvas, 'function showUnsupportedFormatNotice(name, fmt) {');
const helpMap = extractVarObject(canvas, 'var UNSUPPORTED_FORMAT_HELP = {');
const nameMap = extractVarObject(canvas, 'var FORMAT_DISPLAY_NAMES = {');
ok('the refusal function and its two lookup tables are present',
   noticeFn !== null && helpMap !== null && nameMap !== null);

// A DOM small enough to read, real enough to catch a wrong element or a
// missing insert. Records every node the refusal creates.
function makeDom() {
  const created = [];
  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      hidden: false,
      style: { cssText: '' },
      attrs: {},
      children: [],
      _text: '',
      parentNode: null,
      set innerHTML(v) { if (v === '') this.children = []; },
      get innerHTML() { return this.children.map(c => c.textContent).join(''); },
      set textContent(v) { this._text = v; },
      get textContent() {
        return this.children.length ? this.children.map(c => c.textContent).join(' ') : this._text;
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    };
    created.push(el);
    return el;
  }
  const dropFormats = makeEl('p');
  dropFormats.id = 'drop-formats';
  const parent = makeEl('div');
  parent.insertBefore = function (node, ref) {
    node.parentNode = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i === -1 ? this.children.length : i, 0, node);
    return node;
  };
  parent.appendChild(dropFormats);
  dropFormats.parentNode = parent;

  const byId = { 'drop-formats': dropFormats };
  return {
    created,
    parent,
    document: {
      getElementById: (id) => byId[id] || null,
      createElement: (tag) => makeEl(tag),
      _register: (el) => { if (el.id) byId[el.id] = el; },
    },
  };
}

const dom = makeDom();
let statusText = null;
let alerted = null;
// Registering the notice by id has to happen as soon as the refusal sets it,
// so the second call finds the existing node instead of making a new one.
const origCreate = dom.document.createElement;
dom.document.createElement = (tag) => {
  const el = origCreate(tag);
  let id = '';
  Object.defineProperty(el, 'id', {
    get: () => id,
    set: (v) => { id = v; dom.document._register(el); },
  });
  return el;
};

// eslint-disable-next-line no-new-func
const showUnsupportedFormatNotice = new Function(
  'document', 'setAgentStatus', 'alert',
  `${helpMap}\n${nameMap}\n${noticeFn}\nreturn showUnsupportedFormatNotice;`
)(dom.document, (t) => { statusText = t; }, (m) => { alerted = m; });

showUnsupportedFormatNotice('quarterly.parquet', 'parquet');

const notice = dom.document.getElementById('drop-unsupported-notice');
ok('a visible refusal notice is inserted into the drop zone', notice !== null);
ok('nothing fell back to a blocking alert()', alerted === null);

const seen = (statusText || '') + ' ' + (notice ? notice.textContent : '');

ok('the message names the file', seen.includes('quarterly.parquet'));
ok('the message names the detected format', seen.includes('Parquet'));
ok('the message says plainly that nothing was loaded', seen.includes('nothing was loaded'));
ok('the message gives one concrete next step', seen.includes('drop the CSV here'));
ok('the refusal is announced to screen readers',
   notice && notice.attrs['role'] === 'status' && notice.attrs['aria-live'] === 'polite');

// The exact language the old fabrication produced. None of it may appear.
const FORBIDDEN = [
  'cleaned, sourced, and reviewed',
  '100/100',
  'Ready.',
  'rows.',
  'columns.',
  'health',
  'score',
  'grade',
  'detected \u2014 full parsing',
];
FORBIDDEN.forEach((phrase) => {
  ok(`the refusal never says "${phrase}"`, !seen.toLowerCase().includes(phrase.toLowerCase()));
});

ok('the refusal contains no em dash', !seen.includes('\u2014'));

// Every unsupported format the router can emit must get a named, actionable
// refusal, not the generic fallback.
['pdf', 'arrow', 'feather', 'xml', 'audio', 'video'].forEach((fmt) => {
  statusText = null;
  showUnsupportedFormatNotice('file.' + fmt, fmt);
  const text = (statusText || '') + ' ' + dom.document.getElementById('drop-unsupported-notice').textContent;
  ok(`${fmt}: refused by name, with a next step and no em dash`,
     text.includes('nothing was loaded') &&
     text.includes('not supported yet') &&
     !text.includes('\u2014'));
});

// An unrecognised format must refuse rather than guess.
statusText = null;
showUnsupportedFormatNotice('mystery.bin', 'unknown');
const unknownText = (statusText || '') + ' ' + dom.document.getElementById('drop-unsupported-notice').textContent;
ok('an unrecognised file refuses and says it will not guess',
   unknownText.includes('will not guess') && unknownText.includes('nothing was loaded'));

// Only one notice node is ever created, no matter how many files are refused.
const noticeNodes = dom.created.filter(e => e.id === 'drop-unsupported-notice');
eq('repeated refusals reuse one notice node instead of stacking up', noticeNodes.length, 1);

// ============================================================
console.log('\n3. What the drop zone advertises matches what parses');
// ============================================================
const dropFormatsLine = /<p id="drop-formats">([^<]*)<\/p>/.exec(canvas);
ok('#drop-formats is present', dropFormatsLine !== null);
const advertised = dropFormatsLine ? dropFormatsLine[1] : '';

// routeDroppedFile only has real parsers for these.
['Parquet', 'PDF', 'audio', 'video', 'ZIP', 'SQLite', 'Arrow', 'Feather'].forEach((fmt) => {
  ok(`#drop-formats no longer advertises ${fmt}, which has no parser`,
     !advertised.toLowerCase().includes(fmt.toLowerCase()));
});
['CSV', 'TSV', 'JSON', 'TXT', 'LOG', 'X12'].forEach((fmt) => {
  ok(`#drop-formats still advertises ${fmt}, which does parse`, advertised.includes(fmt));
});
ok('#drop-formats contains no em dash', !advertised.includes('\u2014'));

const acceptAttr = /<input type="file" id="file-input"[^>]*accept="([^"]*)"/.exec(canvas);
ok('the file input has an accept attribute', acceptAttr !== null);
const accept = acceptAttr ? acceptAttr[1].split(',') : [];

['.csv', '.tsv', '.json', '.ndjson', '.jsonl', '.txt', '.log', '.x12', '.edi'].forEach((ext) => {
  ok(`accept lists ${ext}`, accept.includes(ext));
});
// iOS Safari is inconsistent about honouring dot-extensions vs MIME types, so
// both are listed for every text format.
['text/csv', 'application/json', 'text/plain'].forEach((mime) => {
  ok(`accept also lists the ${mime} MIME type for iOS Safari`, accept.includes(mime));
});
['.parquet', '.pdf', '.mp3', '.mp4', '.arrow', '.feather', '.xml'].forEach((ext) => {
  ok(`accept no longer lists ${ext}, which has no parser`, !accept.includes(ext));
});

// The folder-watch gate has to agree with the drop zone, or a watched folder
// feeds unparseable files straight into the refusal branch.
const acceptedRe = /var ACCEPTED = \/\\\.\(([^)]*)\)\$\/i;/.exec(canvas);
ok('the folder-watch ACCEPTED regex is present', acceptedRe !== null);
if (acceptedRe) {
  const exts = acceptedRe[1].split('|');
  ['parquet', 'pdf', 'arrow', 'feather', 'xml'].forEach((e) => {
    ok(`folder watch no longer accepts .${e}, which has no parser`, !exts.includes(e));
  });
  // xlsx and xls ARE accepted again as of Bundle C, because SheetJS is
  // vendored, loaded on both surfaces, and genuinely parses them. See
  // test/excel-roundtrip.test.mjs, which proves it against real workbooks.
  ['csv', 'tsv', 'json', 'txt', 'xlsx', 'xls'].forEach((e) => {
    ok(`folder watch accepts .${e}, which has a real parser`, exts.includes(e));
  });
}

// ============================================================
console.log('\n4. The SheetJS comment no longer claims something untrue');
// ============================================================
['canvas/index.html', 'src/js/bundle.js', 'js/export/export-report.js'].forEach((rel) => {
  const src = readFileSync(join(repoRoot, rel), 'utf8');
  ok(`${rel}: the claim that SheetJS is "loaded on every page" is gone`,
     !src.includes('already vendored\n// and loaded on every page'));
  ok(`${rel}: the comment now says the canvas has no script tag for it`,
     src.includes('canvas/index.html'));
});

console.log(`\nunsupported-format-honesty: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
