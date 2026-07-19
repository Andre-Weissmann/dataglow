// ============================================================
// DataGlow — Universal Ingestion (PR AC) — Drop Zone Router Tests
// ============================================================
// Tests the Tier 2-5 additions to js/drop-zone/drop-zone-router.js:
// .txt/.log line-parser routing, Arrow/Feather magic-byte + extension
// detection, and .xml routing to RAG. Pure logic, no DOM, no browser APIs.
//
// Run: node --test test/drop-zone/universal-ingestion.test.js
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFileFormat,
  jsonNeedsFlattening,
} from '../../js/drop-zone/drop-zone-router.js';

function bytesFromAscii(str, totalLen = 16) {
  const out = new Uint8Array(totalLen);
  for (let i = 0; i < str.length && i < totalLen; i++) out[i] = str.charCodeAt(i);
  return out;
}

function emptyBytes() {
  return new Uint8Array(16);
}

// ============================================================
// Tier 2 — .txt / .log
// ============================================================

test('.txt extension -> format txt, handler duckdb', () => {
  const r = detectFileFormat('notes.txt', '', emptyBytes());
  assert.equal(r.format, 'txt');
  assert.equal(r.handler, 'duckdb');
  assert.equal(r.confidence, 'low');
});

test('.log extension -> format txt, handler duckdb', () => {
  const r = detectFileFormat('app.log', '', emptyBytes());
  assert.equal(r.format, 'txt');
  assert.equal(r.handler, 'duckdb');
  assert.equal(r.confidence, 'low');
});

test('.LOG uppercase extension is treated case-insensitively', () => {
  const r = detectFileFormat('APP.LOG', '', emptyBytes());
  assert.equal(r.format, 'txt');
  assert.equal(r.handler, 'duckdb');
});

test('.txt with no bytes/mime still resolves via extension fallback', () => {
  const r = detectFileFormat('readme.txt', null, null);
  assert.equal(r.format, 'txt');
  assert.equal(r.handler, 'duckdb');
});

// ============================================================
// Tier 4 — Arrow / Feather
// ============================================================

test('.arrow extension -> format arrow, handler duckdb', () => {
  const r = detectFileFormat('dataset.arrow', '', emptyBytes());
  assert.equal(r.format, 'arrow');
  assert.equal(r.handler, 'duckdb');
  assert.equal(r.confidence, 'low');
});

test('.feather extension -> format feather, handler duckdb', () => {
  const r = detectFileFormat('dataset.feather', '', emptyBytes());
  assert.equal(r.format, 'feather');
  assert.equal(r.handler, 'duckdb');
  assert.equal(r.confidence, 'low');
});

test('Arrow magic bytes (ARROW1 header) -> format arrow, confidence high', () => {
  const bytes = bytesFromAscii('ARROW1\0\0abcdefgh');
  const r = detectFileFormat('data.arrow', '', bytes);
  assert.equal(r.format, 'arrow');
  assert.equal(r.confidence, 'high');
  assert.equal(r.handler, 'duckdb');
});

test('Arrow magic bytes detected even with .feather extension (Feather v2 shares header)', () => {
  const bytes = bytesFromAscii('ARROW1\0\0abcdefgh');
  const r = detectFileFormat('data.feather', '', bytes);
  assert.equal(r.format, 'arrow');
  assert.equal(r.confidence, 'high');
});

test('Arrow magic bytes take priority over extension-only detection', () => {
  const bytes = bytesFromAscii('ARROW1\0\0abcdefgh');
  const r = detectFileFormat('mystery_file.dat', '', bytes);
  assert.equal(r.format, 'arrow');
  assert.equal(r.confidence, 'high');
});

test('Non-matching first bytes do not falsely trigger Arrow detection', () => {
  const bytes = bytesFromAscii('NOTARROW');
  const r = detectFileFormat('data.arrow', '', bytes);
  // still resolves via extension fallback, just lower confidence
  assert.equal(r.format, 'arrow');
  assert.equal(r.confidence, 'low');
});

test('Short firstBytes array (<6 bytes) does not crash Arrow magic-byte check', () => {
  const bytes = new Uint8Array([0x41, 0x52]); // only 2 bytes
  const r = detectFileFormat('data.arrow', '', bytes);
  assert.equal(r.format, 'arrow');
  assert.equal(r.confidence, 'low');
});

// ============================================================
// Tier 5 — XML
// ============================================================

test('.xml extension -> format xml, handler rag', () => {
  const r = detectFileFormat('feed.xml', '', emptyBytes());
  assert.equal(r.format, 'xml');
  assert.equal(r.handler, 'rag');
  assert.equal(r.confidence, 'low');
});

test('.xml routes to rag rather than falling into unknown', () => {
  const r = detectFileFormat('config.xml', '', emptyBytes());
  assert.notEqual(r.format, 'unknown');
  assert.notEqual(r.handler, 'unknown');
});

// ============================================================
// Regression — pre-existing formats still work
// ============================================================

test('.mp3 still detected as format audio', () => {
  const r = detectFileFormat('recording.mp3', '', emptyBytes());
  assert.equal(r.format, 'audio');
  assert.equal(r.handler, 'whisper');
});

test('.wav still detected as format audio', () => {
  const r = detectFileFormat('recording.wav', '', emptyBytes());
  assert.equal(r.format, 'audio');
});

test('.pdf magic bytes still detected as format pdf', () => {
  const bytes = bytesFromAscii('%PDF-1.7 rest of header');
  const r = detectFileFormat('contract.pdf', '', bytes);
  assert.equal(r.format, 'pdf');
  assert.equal(r.handler, 'rag');
  assert.equal(r.confidence, 'high');
});

test('.pdf extension fallback still works without magic bytes', () => {
  const r = detectFileFormat('contract.pdf', '', null);
  assert.equal(r.format, 'pdf');
  assert.equal(r.handler, 'rag');
});

test('.csv still detected as format csv, handler duckdb', () => {
  const r = detectFileFormat('claims.csv', '', emptyBytes());
  assert.equal(r.format, 'csv');
  assert.equal(r.handler, 'duckdb');
});

test('.mp4 still detected as format video', () => {
  const r = detectFileFormat('clip.mp4', '', emptyBytes());
  assert.equal(r.format, 'video');
  assert.equal(r.handler, 'webcodecs');
});

test('Parquet magic bytes (PAR1) still take precedence', () => {
  const bytes = bytesFromAscii('PAR1abcdefghijkl');
  const r = detectFileFormat('data.parquet', '', bytes);
  assert.equal(r.format, 'parquet');
  assert.equal(r.confidence, 'high');
});

test('Truly unrecognized file -> format unknown, handler unknown', () => {
  const r = detectFileFormat('mystery.xyz', '', emptyBytes());
  assert.equal(r.format, 'unknown');
  assert.equal(r.handler, 'unknown');
});

// ============================================================
// jsonNeedsFlattening (Tier 3 router integration)
// ============================================================

test('jsonNeedsFlattening: true for json', () => {
  assert.equal(jsonNeedsFlattening('json'), true);
});

test('jsonNeedsFlattening: true for ndjson', () => {
  assert.equal(jsonNeedsFlattening('ndjson'), true);
});

test('jsonNeedsFlattening: false for txt (new Tier 2 format)', () => {
  assert.equal(jsonNeedsFlattening('txt'), false);
});

test('jsonNeedsFlattening: false for arrow/feather (new Tier 4 formats)', () => {
  assert.equal(jsonNeedsFlattening('arrow'), false);
  assert.equal(jsonNeedsFlattening('feather'), false);
});
