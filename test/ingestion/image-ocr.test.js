// ============================================================
// DataGlow — Image OCR (Tesseract.js) Tests
// ============================================================
// Tests for js/ingestion/image-ocr.js — pure logic, no browser APIs,
// no side effects. Fully runnable in plain Node.
//
// Run: node --test test/ingestion/image-ocr.test.js
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isImageFile,
  parseOcrText,
  inferOcrKind,
  scoreOcrConfidence,
  buildOcrDataset,
  IMAGE_EXTENSIONS,
  IMAGE_MIME_PREFIXES,
} from '../../js/ingestion/image-ocr.js';

// ============================================================
// isImageFile
// ============================================================

test('isImageFile: .png is true', () => {
  assert.equal(isImageFile('scan.png'), true);
});

test('isImageFile: .jpg is true', () => {
  assert.equal(isImageFile('photo.jpg'), true);
});

test('isImageFile: .jpeg is true', () => {
  assert.equal(isImageFile('photo.jpeg'), true);
});

test('isImageFile: .webp is true', () => {
  assert.equal(isImageFile('image.webp'), true);
});

test('isImageFile: .bmp is true', () => {
  assert.equal(isImageFile('bitmap.bmp'), true);
});

test('isImageFile: .gif is true', () => {
  assert.equal(isImageFile('animated.gif'), true);
});

test('isImageFile: uppercase extension still matches', () => {
  assert.equal(isImageFile('SCAN.PNG'), true);
});

test('isImageFile: .csv is false', () => {
  assert.equal(isImageFile('data.csv'), false);
});

test('isImageFile: .mp3 is false', () => {
  assert.equal(isImageFile('audio.mp3'), false);
});

test('isImageFile: empty string is false', () => {
  assert.equal(isImageFile(''), false);
});

test('isImageFile: null is false', () => {
  assert.equal(isImageFile(null), false);
});

test('isImageFile: undefined is false', () => {
  assert.equal(isImageFile(undefined), false);
});

test('isImageFile: exports expected extension list', () => {
  assert.deepEqual(IMAGE_EXTENSIONS, ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
  assert.equal(IMAGE_MIME_PREFIXES.includes('image/png'), true);
});

// ============================================================
// parseOcrText
// ============================================================

test('parseOcrText: empty string returns no rows', () => {
  const r = parseOcrText('');
  assert.equal(r.rows.length, 0);
  assert.equal(r.lineCount, 1);
});

test('parseOcrText: non-string input returns empty result', () => {
  const r = parseOcrText(null);
  assert.deepEqual(r, { rows: [], lineCount: 0, skippedEmpty: 0 });
});

test('parseOcrText: single line produces one row', () => {
  const r = parseOcrText('hello world');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].line_number, 1);
  assert.equal(r.rows[0].content, 'hello world');
});

test('parseOcrText: multiline text produces one row per line', () => {
  const r = parseOcrText('line one\nline two\nline three');
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].content, 'line one');
  assert.equal(r.rows[1].content, 'line two');
  assert.equal(r.rows[2].content, 'line three');
  assert.equal(r.lineCount, 3);
});

test('parseOcrText: skipEmpty default true drops blank lines', () => {
  const r = parseOcrText('a\n\nb\n\n\nc');
  assert.equal(r.rows.map(x => x.content).join(','), 'a,b,c');
  assert.equal(r.skippedEmpty, 3);
});

test('parseOcrText: skipEmpty=false keeps blank lines', () => {
  const r = parseOcrText('a\n\nb', { skipEmpty: false });
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[1].content, '');
  assert.equal(r.skippedEmpty, 0);
});

test('parseOcrText: CRLF line endings are stripped', () => {
  const r = parseOcrText('a\r\nb\r\nc', { skipEmpty: false });
  assert.equal(r.rows[0].content, 'a');
  assert.equal(r.rows[1].content, 'b');
  assert.equal(r.rows[2].content, 'c');
});

test('parseOcrText: line_number resets to be sequential after skipped lines', () => {
  const r = parseOcrText('first\n\nsecond\n\nthird');
  assert.equal(r.rows[0].line_number, 1);
  assert.equal(r.rows[1].line_number, 2);
  assert.equal(r.rows[2].line_number, 3);
});

test('parseOcrText: lineCount reflects raw split length including blanks', () => {
  const r = parseOcrText('a\n\nb');
  assert.equal(r.lineCount, 3);
});

// ============================================================
// inferOcrKind
// ============================================================

test('inferOcrKind: empty array is unknown', () => {
  assert.equal(inferOcrKind([]), 'unknown');
});

test('inferOcrKind: non-array is unknown', () => {
  assert.equal(inferOcrKind(null), 'unknown');
});

test('inferOcrKind: table — columns separated by multiple spaces', () => {
  const lines = [
    'Name        Age        City',
    'Alice       30         NYC',
    'Bob         25         LA',
    '100.00      200.00     300.00',
    '1           2          3',
  ];
  assert.equal(inferOcrKind(lines), 'table');
});

test('inferOcrKind: form — Label: value pairs', () => {
  const lines = [
    'Name: John Smith',
    'Address: 123 Main St',
    'Phone: 555-1234',
  ];
  assert.equal(inferOcrKind(lines), 'form');
});

test('inferOcrKind: code — SELECT/def/function patterns', () => {
  const lines = [
    'SELECT * FROM users',
    'function calculate() {',
    'def process(x):',
  ];
  assert.equal(inferOcrKind(lines), 'code');
});

test('inferOcrKind: prose — long freeform lines', () => {
  const lines = [
    'This is a long sentence that describes something in detail without structure.',
    'Another long sentence continuing the narrative with more descriptive words here.',
    'A third sentence that keeps going well past thirty characters in length easily.',
  ];
  assert.equal(inferOcrKind(lines), 'prose');
});

test('inferOcrKind: mixed — short lines with no strong signal', () => {
  const lines = ['ok', 'yes', 'no', 'maybe'];
  assert.equal(inferOcrKind(lines), 'mixed');
});

test('inferOcrKind: accepts objects with content property', () => {
  const lines = [
    { content: 'Name: John' },
    { content: 'Email: john@example.com' },
    { content: 'Phone: 555-0000' },
  ];
  assert.equal(inferOcrKind(lines), 'form');
});

// ============================================================
// scoreOcrConfidence
// ============================================================

test('scoreOcrConfidence: empty array returns poor', () => {
  const r = scoreOcrConfidence([]);
  assert.deepEqual(r, { mean: 0, low: 0, grade: 'poor' });
});

test('scoreOcrConfidence: non-array returns poor', () => {
  const r = scoreOcrConfidence(null);
  assert.equal(r.grade, 'poor');
});

test('scoreOcrConfidence: all 100s -> high', () => {
  const r = scoreOcrConfidence([100, 100, 100]);
  assert.equal(r.mean, 100);
  assert.equal(r.grade, 'high');
});

test('scoreOcrConfidence: all 60s -> low', () => {
  const r = scoreOcrConfidence([60, 60, 60]);
  assert.equal(r.mean, 60);
  assert.equal(r.grade, 'low');
});

test('scoreOcrConfidence: mixed values compute correct mean and low', () => {
  const r = scoreOcrConfidence([90, 80, 70]);
  assert.equal(r.mean, 80);
  assert.equal(r.low, 70);
  assert.equal(r.grade, 'medium');
});

test('scoreOcrConfidence: below 50 -> poor', () => {
  const r = scoreOcrConfidence([40, 30, 20]);
  assert.equal(r.grade, 'poor');
});

test('scoreOcrConfidence: filters out negative/non-numeric entries', () => {
  const r = scoreOcrConfidence([90, -1, 'bad', 90]);
  assert.equal(r.mean, 90);
  assert.equal(r.grade, 'high');
});

test('scoreOcrConfidence: mean exactly 85 grades high', () => {
  const r = scoreOcrConfidence([85, 85]);
  assert.equal(r.grade, 'high');
});

test('scoreOcrConfidence: mean exactly 70 grades medium', () => {
  const r = scoreOcrConfidence([70, 70]);
  assert.equal(r.grade, 'medium');
});

// ============================================================
// buildOcrDataset
// ============================================================

test('buildOcrDataset: columns are line_number and content', () => {
  const parsed = parseOcrText('a\nb');
  const conf = scoreOcrConfidence([95, 96]);
  const ds = buildOcrDataset(parsed, 'receipt.png', 'table', conf);
  assert.deepEqual(ds.columns, ['line_number', 'content']);
});

test('buildOcrDataset: meta.format is image', () => {
  const parsed = parseOcrText('a\nb');
  const conf = scoreOcrConfidence([95, 96]);
  const ds = buildOcrDataset(parsed, 'receipt.png', 'table', conf);
  assert.equal(ds.meta.format, 'image');
});

test('buildOcrDataset: meta.ocrConfidence is present and matches input', () => {
  const parsed = parseOcrText('a\nb');
  const conf = scoreOcrConfidence([95, 96]);
  const ds = buildOcrDataset(parsed, 'receipt.png', 'table', conf);
  assert.deepEqual(ds.meta.ocrConfidence, conf);
});

test('buildOcrDataset: note mentions Tesseract', () => {
  const parsed = parseOcrText('a\nb');
  const conf = scoreOcrConfidence([95, 96]);
  const ds = buildOcrDataset(parsed, 'receipt.png', 'table', conf);
  assert.match(ds.meta.note, /Tesseract/);
});

test('buildOcrDataset: rows pass through unchanged', () => {
  const parsed = parseOcrText('first\nsecond');
  const conf = scoreOcrConfidence([80, 85]);
  const ds = buildOcrDataset(parsed, 'note.jpg', 'prose', conf);
  assert.deepEqual(ds.rows, parsed.rows);
});

test('buildOcrDataset: note reflects low confidence warning', () => {
  const parsed = parseOcrText('a');
  const conf = scoreOcrConfidence([40]);
  const ds = buildOcrDataset(parsed, 'blurry.jpg', 'mixed', conf);
  assert.match(ds.meta.note, /very low/);
});

test('buildOcrDataset: meta.source is the file name', () => {
  const parsed = parseOcrText('a');
  const conf = scoreOcrConfidence([90]);
  const ds = buildOcrDataset(parsed, 'invoice.webp', 'form', conf);
  assert.equal(ds.meta.source, 'invoice.webp');
});

test('buildOcrDataset: meta.kind matches inferred kind', () => {
  const parsed = parseOcrText('a');
  const conf = scoreOcrConfidence([90]);
  const ds = buildOcrDataset(parsed, 'x.bmp', 'code', conf);
  assert.equal(ds.meta.kind, 'code');
});
