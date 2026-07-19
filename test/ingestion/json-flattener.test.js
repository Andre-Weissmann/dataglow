// ============================================================
// DataGlow — Semi-Structured JSON Flattener Tests
// ============================================================
// Tests for js/ingestion/json-flattener.js — pure logic, no browser APIs,
// no side effects. Fully runnable in plain Node.
//
// Run: node --test test/ingestion/json-flattener.test.js
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenJson,
  parseJsonOrNdjson,
  jsonNeedsFlattening,
} from '../../js/ingestion/json-flattener.js';

// ============================================================
// flattenJson — flat array passthrough
// ============================================================

test('flattenJson: flat array of objects -> high confidence passthrough', () => {
  const input = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const r = flattenJson(input);
  assert.equal(r.confidence, 'high');
  assert.equal(r.path, '(root array)');
  assert.equal(r.warning, null);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].a, 1);
  assert.equal(r.rows[1].b, 4);
});

test('flattenJson: empty array -> falls through with empty rows', () => {
  const r = flattenJson([]);
  assert.equal(r.rows.length, 0);
});

test('flattenJson: respects maxRows cap on flat array', () => {
  const input = Array.from({ length: 10 }, (_, i) => ({ i }));
  const r = flattenJson(input, { maxRows: 3 });
  assert.equal(r.rows.length, 3);
  assert.equal(r.confidence, 'high');
});

// ============================================================
// flattenJson — array of scalars
// ============================================================

test('flattenJson: array of scalar numbers -> index+value rows', () => {
  const r = flattenJson([1, 2, 3]);
  assert.equal(r.confidence, 'medium');
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].index, 0);
  assert.equal(r.rows[0].value, '1');
  assert.equal(r.rows[2].value, '3');
  assert.match(r.warning, /Array of scalar values/);
});

test('flattenJson: array of strings -> index+value rows', () => {
  const r = flattenJson(['x', 'y']);
  assert.equal(r.rows[0].value, 'x');
  assert.equal(r.rows[1].value, 'y');
});

test('flattenJson: array containing null scalar -> value is null', () => {
  const r = flattenJson([null, 5]);
  assert.equal(r.rows[0].value, null);
  assert.equal(r.rows[1].value, '5');
});

// ============================================================
// flattenJson — single object envelopes (GitHub / Stripe style)
// ============================================================

test('flattenJson: GitHub-style envelope with data array -> extracts rows', () => {
  const input = {
    total_count: 2,
    incomplete_results: false,
    items: [{ id: 1, name: 'repo-a' }, { id: 2, name: 'repo-b' }],
  };
  const r = flattenJson(input);
  assert.equal(r.confidence, 'medium');
  assert.equal(r.path, 'items');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].name, 'repo-a');
  assert.match(r.warning, /Extracted rows from "items"/);
});

test('flattenJson: Stripe-style envelope (object.data array) -> extracts nested path', () => {
  const input = {
    object: 'list',
    data: [{ id: 'ch_1', amount: 500 }, { id: 'ch_2', amount: 1200 }],
    has_more: false,
  };
  const r = flattenJson(input);
  assert.equal(r.path, 'data');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].amount, 1200);
});

test('flattenJson: FHIR bundle (resourceType wrapping entry array)', () => {
  const input = {
    resourceType: 'Bundle',
    type: 'searchset',
    entry: [
      { resource: { resourceType: 'Patient', id: 'p1' } },
      { resource: { resourceType: 'Patient', id: 'p2' } },
    ],
  };
  const r = flattenJson(input);
  assert.equal(r.path, 'entry');
  assert.equal(r.rows.length, 2);
  // nested resource object gets dot-key expanded
  assert.equal(r.rows[0]['resource.resourceType'], 'Patient');
  assert.equal(r.rows[0]['resource.id'], 'p1');
});

test('flattenJson: nested envelope where array is deeper than top level (BFS)', () => {
  const input = {
    meta: { page: 1 },
    payload: {
      results: [{ x: 1 }, { x: 2 }],
    },
  };
  const r = flattenJson(input, { maxDepth: 4 });
  assert.equal(r.path, 'payload.results');
  assert.equal(r.rows.length, 2);
});

test('flattenJson: single object with no array inside -> one row', () => {
  const input = { id: 1, name: 'solo', active: true };
  const r = flattenJson(input);
  assert.equal(r.confidence, 'low');
  assert.equal(r.path, '(root object)');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].name, 'solo');
  assert.match(r.warning, /Single JSON object/);
});

test('flattenJson: null input -> empty result with warning', () => {
  const r = flattenJson(null);
  assert.equal(r.rows.length, 0);
  assert.match(r.warning, /Could not extract rows/);
});

test('flattenJson: primitive input (number) -> empty result', () => {
  const r = flattenJson(42);
  assert.equal(r.rows.length, 0);
});

test('flattenJson: primitive input (string) -> empty result', () => {
  const r = flattenJson('just a string');
  assert.equal(r.rows.length, 0);
});

// ============================================================
// flattenJson — deep nesting / dot-key expansion
// ============================================================

test('flattenJson: deeply nested object flattened with dot-keys', () => {
  const input = [
    { user: { name: 'Ann', address: { city: 'Chicago', zip: '60614' } } },
  ];
  const r = flattenJson(input, { maxDepth: 4 });
  assert.equal(r.rows[0]['user.name'], 'Ann');
  assert.equal(r.rows[0]['user.address.city'], 'Chicago');
  assert.equal(r.rows[0]['user.address.zip'], '60614');
});

test('flattenJson: nesting beyond maxDepth is not expanded further (still an object)', () => {
  const input = [
    { a: { b: { c: { d: { e: 'too deep' } } } } },
  ];
  const r = flattenJson(input, { maxDepth: 1 });
  // at depth 1, a.b gets expanded but b's nested value (c) should not be further flattened
  assert.ok('a.b' in r.rows[0] || 'a.b.c' in r.rows[0]);
});

test('flattenJson: nested array at leaf position is JSON-stringified', () => {
  const input = [{ id: 1, tags: ['x', 'y', 'z'] }];
  const r = flattenJson(input);
  assert.equal(typeof r.rows[0].tags, 'string');
  assert.equal(r.rows[0].tags, JSON.stringify(['x', 'y', 'z']));
});

test('flattenJson: null values in leaf position preserved as null', () => {
  const input = [{ id: 1, deleted_at: null }];
  const r = flattenJson(input);
  assert.equal(r.rows[0].deleted_at, null);
});

test('flattenJson: undefined values in leaf position become null', () => {
  const input = [{ id: 1, extra: undefined }];
  const r = flattenJson(input);
  assert.equal(r.rows[0].extra, null);
});

test('flattenJson: mixed array of nested and flat objects flattens each independently', () => {
  const input = [
    { id: 1, meta: { flag: true } },
    { id: 2 },
  ];
  const r = flattenJson(input);
  assert.equal(r.rows[0]['meta.flag'], true);
  assert.equal(r.rows[1].id, 2);
});

// ============================================================
// parseJsonOrNdjson
// ============================================================

test('parseJsonOrNdjson: valid JSON array parses correctly', () => {
  const r = parseJsonOrNdjson('[{"a":1},{"a":2}]');
  assert.equal(r.isNdjson, false);
  assert.equal(r.error, null);
  assert.deepEqual(r.parsed, [{ a: 1 }, { a: 2 }]);
});

test('parseJsonOrNdjson: valid JSON object parses correctly', () => {
  const r = parseJsonOrNdjson('{"a":1}');
  assert.equal(r.isNdjson, false);
  assert.deepEqual(r.parsed, { a: 1 });
});

test('parseJsonOrNdjson: valid NDJSON parses into array of objects', () => {
  const text = '{"a":1}\n{"a":2}\n{"a":3}';
  const r = parseJsonOrNdjson(text);
  assert.equal(r.isNdjson, true);
  assert.equal(r.error, null);
  assert.equal(r.parsed.length, 3);
  assert.equal(r.parsed[1].a, 2);
});

test('parseJsonOrNdjson: NDJSON with blank lines between records is tolerated', () => {
  const text = '{"a":1}\n\n{"a":2}\n';
  const r = parseJsonOrNdjson(text);
  assert.equal(r.isNdjson, true);
  assert.equal(r.parsed.length, 2);
});

test('parseJsonOrNdjson: invalid input (neither JSON nor NDJSON) returns error', () => {
  const r = parseJsonOrNdjson('not json at all {{{');
  assert.equal(r.parsed, null);
  assert.equal(r.isNdjson, false);
  assert.match(r.error, /Could not parse/);
});

test('parseJsonOrNdjson: empty string returns error', () => {
  const r = parseJsonOrNdjson('');
  assert.equal(r.parsed, null);
  assert.equal(r.error, 'Empty input');
});

test('parseJsonOrNdjson: whitespace-only string returns error', () => {
  const r = parseJsonOrNdjson('   \n  ');
  assert.equal(r.parsed, null);
  assert.equal(r.error, 'Empty input');
});

test('parseJsonOrNdjson: non-string input returns error', () => {
  const r = parseJsonOrNdjson(null);
  assert.equal(r.parsed, null);
  assert.equal(r.error, 'Empty input');
});

test('parseJsonOrNdjson: NDJSON of scalars (not objects) fails and falls through to error', () => {
  const text = '1\n2\n3';
  const r = parseJsonOrNdjson(text);
  // "1" alone is valid JSON (a number), so JSON.parse succeeds on the whole text? No —
  // "1\n2\n3" is NOT valid single JSON, so it falls to NDJSON path; rows are not
  // all plain objects, so overall parse fails.
  assert.equal(r.parsed, null);
  assert.equal(r.isNdjson, false);
  assert.match(r.error, /Could not parse/);
});

// ============================================================
// jsonNeedsFlattening
// ============================================================

test('jsonNeedsFlattening: true for json format', () => {
  assert.equal(jsonNeedsFlattening('json'), true);
});

test('jsonNeedsFlattening: true for ndjson format', () => {
  assert.equal(jsonNeedsFlattening('ndjson'), true);
});

test('jsonNeedsFlattening: false for csv format', () => {
  assert.equal(jsonNeedsFlattening('csv'), false);
});

test('jsonNeedsFlattening: false for parquet format', () => {
  assert.equal(jsonNeedsFlattening('parquet'), false);
});

test('jsonNeedsFlattening: false for undefined/unknown format', () => {
  assert.equal(jsonNeedsFlattening(undefined), false);
  assert.equal(jsonNeedsFlattening('unknown'), false);
});

// ============================================================
// End-to-end integration
// ============================================================

test('end-to-end: NDJSON text -> parse -> flatten -> rows', () => {
  const text = '{"id":1,"user":{"name":"A"}}\n{"id":2,"user":{"name":"B"}}';
  const parsedResult = parseJsonOrNdjson(text);
  assert.equal(parsedResult.isNdjson, true);
  const flat = flattenJson(parsedResult.parsed);
  assert.equal(flat.confidence, 'high');
  assert.equal(flat.rows[0]['user.name'], 'A');
  assert.equal(flat.rows[1]['user.name'], 'B');
});

test('end-to-end: GitHub envelope JSON text -> parse -> flatten', () => {
  const text = JSON.stringify({
    total_count: 1,
    items: [{ id: 99, full_name: 'octocat/hello' }],
  });
  const parsedResult = parseJsonOrNdjson(text);
  assert.equal(parsedResult.isNdjson, false);
  const flat = flattenJson(parsedResult.parsed);
  assert.equal(flat.path, 'items');
  assert.equal(flat.rows[0].full_name, 'octocat/hello');
});
