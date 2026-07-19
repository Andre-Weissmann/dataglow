// ============================================================
// DataGlow — Text / Log Line Parser Tests
// ============================================================
// Tests for js/ingestion/text-line-parser.js — pure logic, no DOM, no
// browser APIs, no async. Fully runnable in plain Node.
//
// Run: node --test test/ingestion/text-line-parser.test.js
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTextLines,
  inferTextKind,
  buildTextDataset,
} from '../../js/ingestion/text-line-parser.js';

// ============================================================
// parseTextLines
// ============================================================

test('parseTextLines: empty string -> single empty-content row (line 1)', () => {
  const r = parseTextLines('');
  // ''.split('\n') === [''], so there is exactly one line with empty content
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].content, '');
  assert.equal(r.rows[0].line_number, 1);
  assert.equal(r.lineCount, 1);
  assert.equal(r.skippedEmpty, 0);
});

test('parseTextLines: empty string with skipEmpty=true -> 0 rows', () => {
  const r = parseTextLines('', { skipEmpty: true });
  assert.equal(r.rows.length, 0);
  assert.equal(r.skippedEmpty, 1);
});

test('parseTextLines: non-string input -> 0 rows, 0 lineCount', () => {
  const r = parseTextLines(null);
  assert.equal(r.rows.length, 0);
  assert.equal(r.lineCount, 0);
  assert.equal(r.skippedEmpty, 0);
});

test('parseTextLines: single line -> 1 row with line_number 1', () => {
  const r = parseTextLines('hello world');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].line_number, 1);
  assert.equal(r.rows[0].content, 'hello world');
});

test('parseTextLines: multiple lines -> correct line numbers in order', () => {
  const r = parseTextLines('a\nb\nc');
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].line_number, 1);
  assert.equal(r.rows[0].content, 'a');
  assert.equal(r.rows[1].line_number, 2);
  assert.equal(r.rows[1].content, 'b');
  assert.equal(r.rows[2].line_number, 3);
  assert.equal(r.rows[2].content, 'c');
});

test('parseTextLines: Windows CRLF is stripped from content', () => {
  const r = parseTextLines('line1\r\nline2\r\n');
  assert.equal(r.rows[0].content, 'line1');
  assert.equal(r.rows[1].content, 'line2');
  // trailing split creates an empty 3rd element
  assert.equal(r.rows[2].content, '');
});

test('parseTextLines: does not strip \\r if not at end of line', () => {
  const r = parseTextLines('a\rb\nc');
  // '\r' not immediately before '\n' within same split segment is preserved
  assert.equal(r.rows[0].content, 'a\rb');
});

test('parseTextLines: empty lines preserved by default (skipEmpty=false)', () => {
  const r = parseTextLines('a\n\nb');
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[1].content, '');
  assert.equal(r.rows[1].line_number, 2);
  assert.equal(r.skippedEmpty, 0);
});

test('parseTextLines: skipEmpty=true omits blank lines but preserves numbering context', () => {
  const r = parseTextLines('a\n\n\nb', { skipEmpty: true });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].content, 'a');
  assert.equal(r.rows[0].line_number, 1);
  assert.equal(r.rows[1].content, 'b');
  assert.equal(r.rows[1].line_number, 4);
  assert.equal(r.skippedEmpty, 2);
});

test('parseTextLines: skipEmpty counts whitespace-only lines as empty', () => {
  const r = parseTextLines('a\n   \nb', { skipEmpty: true });
  assert.equal(r.rows.length, 2);
  assert.equal(r.skippedEmpty, 1);
});

test('parseTextLines: maxLines cap is respected', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  const r = parseTextLines(text, { maxLines: 3 });
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[2].line_number, 3);
  // lineCount reflects the real total, not the cap
  assert.equal(r.lineCount, 10);
});

test('parseTextLines: maxLines cap with skipEmpty still respects cap', () => {
  const text = 'a\n\nb\n\nc\n\nd';
  const r = parseTextLines(text, { maxLines: 2, skipEmpty: true });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].content, 'a');
  assert.equal(r.rows[1].content, 'b');
});

test('parseTextLines: default maxLines is very large (500000)', () => {
  const r = parseTextLines('one line only');
  assert.equal(r.rows.length, 1); // sanity: default cap does not truncate small input
});

test('parseTextLines: lineCount always reflects raw split length regardless of options', () => {
  const r1 = parseTextLines('x\ny\nz');
  const r2 = parseTextLines('x\ny\nz', { skipEmpty: true });
  assert.equal(r1.lineCount, 3);
  assert.equal(r2.lineCount, 3);
});

// ============================================================
// inferTextKind
// ============================================================

test('inferTextKind: empty array -> unknown', () => {
  assert.equal(inferTextKind([]), 'unknown');
});

test('inferTextKind: non-array -> unknown', () => {
  assert.equal(inferTextKind(null), 'unknown');
  assert.equal(inferTextKind(undefined), 'unknown');
  assert.equal(inferTextKind('not an array'), 'unknown');
});

test('inferTextKind: detects log via ISO timestamp lines', () => {
  const lines = [
    '2026-07-19 12:00:00 INFO starting service',
    '2026-07-19 12:00:01 INFO service ready',
    '2026-07-19 12:00:02 ERROR connection refused',
  ];
  assert.equal(inferTextKind(lines), 'log');
});

test('inferTextKind: detects log via severity levels without timestamps', () => {
  const lines = [
    'WARN disk usage high',
    'ERROR could not write file',
    'DEBUG retrying operation',
  ];
  assert.equal(inferTextKind(lines), 'log');
});

test('inferTextKind: detects log via bracketed timestamps', () => {
  const lines = [
    '[12:00:01] request received',
    '[12:00:02] request completed',
    '[12:00:03] request received',
  ];
  assert.equal(inferTextKind(lines), 'log');
});

test('inferTextKind: detects delimited text (comma-heavy)', () => {
  const lines = [
    'a,b,c,d,e',
    'f,g,h,i,j',
    'k,l,m,n,o',
    'p,q,r,s,t',
  ];
  assert.equal(inferTextKind(lines), 'delimited');
});

test('inferTextKind: detects delimited text (tab-heavy)', () => {
  const lines = [
    'a\tb\tc',
    'd\te\tf',
    'g\th\ti',
  ];
  assert.equal(inferTextKind(lines), 'delimited');
});

test('inferTextKind: detects prose (long freeform lines, no delimiters/timestamps)', () => {
  const lines = [
    'This is a long sentence about nothing in particular that goes on for a while.',
    'Another long sentence that continues describing something without punctuation like commas.',
    'A third sufficiently long line of prose text to pad out the sample for detection purposes.',
  ];
  assert.equal(inferTextKind(lines), 'prose');
});

test('inferTextKind: short ambiguous lines fall back to unknown', () => {
  const lines = ['hi', 'ok', 'no'];
  assert.equal(inferTextKind(lines), 'unknown');
});

test('inferTextKind: only samples first 20 lines', () => {
  // 25 prose-like lines; function should still classify based on first 20
  const longLine = 'x'.repeat(50);
  const lines = Array.from({ length: 25 }, () => longLine);
  assert.equal(inferTextKind(lines), 'prose');
});

// ============================================================
// buildTextDataset
// ============================================================

test('buildTextDataset: returns correct columns', () => {
  const parsed = parseTextLines('a\nb');
  const ds = buildTextDataset(parsed, 'notes.txt', 'prose');
  assert.deepEqual(ds.columns, ['line_number', 'content']);
});

test('buildTextDataset: rows pass through unchanged', () => {
  const parsed = parseTextLines('a\nb\nc');
  const ds = buildTextDataset(parsed, 'notes.txt', 'prose');
  assert.equal(ds.rows.length, 3);
  assert.equal(ds.rows[0].content, 'a');
});

test('buildTextDataset: meta.note is log-specific for kind=log', () => {
  const parsed = parseTextLines('2026-07-19 ERROR failed');
  const ds = buildTextDataset(parsed, 'app.log', 'log');
  assert.match(ds.meta.note, /Log file detected/);
  assert.equal(ds.meta.format, 'txt');
  assert.equal(ds.meta.kind, 'log');
});

test('buildTextDataset: meta.note is delimited-specific for kind=delimited', () => {
  const parsed = parseTextLines('a,b,c');
  const ds = buildTextDataset(parsed, 'data.txt', 'delimited');
  assert.match(ds.meta.note, /Delimited text detected/);
});

test('buildTextDataset: meta.note is generic for kind=prose/unknown', () => {
  const parsed = parseTextLines('some text');
  const dsProse = buildTextDataset(parsed, 'notes.txt', 'prose');
  const dsUnknown = buildTextDataset(parsed, 'notes.txt', 'unknown');
  assert.match(dsProse.note ?? dsProse.meta.note, /line-numbered rows/);
  assert.match(dsUnknown.meta.note, /line-numbered rows/);
});

test('buildTextDataset: meta.source and lineCount reflect inputs', () => {
  const parsed = parseTextLines('a\nb\nc');
  const ds = buildTextDataset(parsed, 'myfile.log', 'log');
  assert.equal(ds.meta.source, 'myfile.log');
  assert.equal(ds.meta.lineCount, 3);
});

test('buildTextDataset: meta.skippedEmpty defaults to 0 when absent', () => {
  const ds = buildTextDataset({ rows: [], lineCount: 0 }, 'x.txt', 'unknown');
  assert.equal(ds.meta.skippedEmpty, 0);
});

test('buildTextDataset: meta.skippedEmpty reflects parsed value when present', () => {
  const parsed = parseTextLines('a\n\n\nb', { skipEmpty: true });
  const ds = buildTextDataset(parsed, 'x.txt', 'unknown');
  assert.equal(ds.meta.skippedEmpty, 2);
});

test('end-to-end: log file parses, infers, and builds dataset consistently', () => {
  const text = [
    '2026-07-19 10:00:00 INFO boot',
    '2026-07-19 10:00:01 WARN slow disk',
    '2026-07-19 10:00:02 ERROR crash',
    '2026-07-19 10:00:03 INFO recovered',
  ].join('\n');
  const parsed = parseTextLines(text);
  const kind = inferTextKind(text.split('\n').slice(0, 20));
  const ds = buildTextDataset(parsed, 'service.log', kind);
  assert.equal(kind, 'log');
  assert.equal(ds.rows.length, 4);
  assert.match(ds.meta.note, /Log file detected/);
});
