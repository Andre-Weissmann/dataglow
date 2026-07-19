// ============================================================
// DataGlow — Live API / Webhook Feed Tests
// ============================================================
// Tests for js/ingestion/api-feed.js — pure logic, no fetch(), no DOM,
// fully runnable in plain Node.
//
// Run: node --test test/ingestion/api-feed.test.js
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_METHODS,
  POLL_INTERVALS_MS,
  POLL_LABELS,
  validateFeedUrl,
  parseHeadersString,
  normalizeApiResponse,
  buildPollSchedule,
  buildFeedDataset,
} from '../../js/ingestion/api-feed.js';

// ============================================================
// Constants
// ============================================================

test('FEED_METHODS: contains GET and POST only', () => {
  assert.deepEqual(FEED_METHODS, ['GET', 'POST']);
});

test('POLL_INTERVALS_MS and POLL_LABELS: same length, index-aligned', () => {
  assert.equal(POLL_INTERVALS_MS.length, POLL_LABELS.length);
  assert.equal(POLL_INTERVALS_MS[0], 0);
  assert.equal(POLL_LABELS[0], 'One-time fetch');
});

// ============================================================
// validateFeedUrl
// ============================================================

test('validateFeedUrl: empty string is invalid', () => {
  const r = validateFeedUrl('');
  assert.equal(r.valid, false);
  assert.equal(r.error, 'URL is required');
  assert.equal(r.normalized, null);
});

test('validateFeedUrl: whitespace-only string is invalid', () => {
  const r = validateFeedUrl('   ');
  assert.equal(r.valid, false);
  assert.equal(r.error, 'URL is required');
});

test('validateFeedUrl: non-string input is invalid', () => {
  const r = validateFeedUrl(null);
  assert.equal(r.valid, false);
  assert.equal(r.error, 'URL is required');
});

test('validateFeedUrl: valid https URL is accepted', () => {
  const r = validateFeedUrl('https://api.example.com/data');
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
  assert.equal(r.normalized, 'https://api.example.com/data');
});

test('validateFeedUrl: valid http URL is accepted', () => {
  const r = validateFeedUrl('http://api.example.com/data');
  assert.equal(r.valid, true);
  assert.equal(r.normalized, 'http://api.example.com/data');
});

test('validateFeedUrl: missing protocol auto-adds https://', () => {
  const r = validateFeedUrl('api.example.com/data');
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
  assert.equal(r.normalized, 'https://api.example.com/data');
});

test('validateFeedUrl: ftp URL is rejected', () => {
  const r = validateFeedUrl('ftp://files.example.com/data.csv');
  assert.equal(r.valid, false);
  assert.equal(r.error, 'Only HTTP and HTTPS endpoints are supported');
  assert.equal(r.normalized, null);
});

test('validateFeedUrl: malformed URL is rejected', () => {
  const r = validateFeedUrl('://nowhere');
  assert.equal(r.valid, false);
  assert.equal(r.error, 'Invalid URL format');
  assert.equal(r.normalized, null);
});

test('validateFeedUrl: trims surrounding whitespace before validating', () => {
  const r = validateFeedUrl('  https://api.example.com/data  ');
  assert.equal(r.valid, true);
  assert.equal(r.normalized, 'https://api.example.com/data');
});

test('validateFeedUrl: URL with query string preserved in normalized form', () => {
  const r = validateFeedUrl('https://api.example.com/data?limit=10');
  assert.equal(r.valid, true);
  assert.match(r.normalized, /limit=10/);
});

// ============================================================
// parseHeadersString
// ============================================================

test('parseHeadersString: empty string returns empty object', () => {
  assert.deepEqual(parseHeadersString(''), {});
});

test('parseHeadersString: non-string input returns empty object', () => {
  assert.deepEqual(parseHeadersString(null), {});
  assert.deepEqual(parseHeadersString(undefined), {});
});

test('parseHeadersString: single header parsed correctly', () => {
  const r = parseHeadersString('Authorization: Bearer abc123');
  assert.deepEqual(r, { Authorization: 'Bearer abc123' });
});

test('parseHeadersString: multiple headers parsed correctly', () => {
  const raw = 'Authorization: Bearer abc123\nContent-Type: application/json';
  const r = parseHeadersString(raw);
  assert.equal(r.Authorization, 'Bearer abc123');
  assert.equal(r['Content-Type'], 'application/json');
  assert.equal(Object.keys(r).length, 2);
});

test('parseHeadersString: malformed line (no colon) is silently skipped', () => {
  const raw = 'Authorization: Bearer abc123\nnotaheader\nX-Custom: yes';
  const r = parseHeadersString(raw);
  assert.equal(Object.keys(r).length, 2);
  assert.equal(r['X-Custom'], 'yes');
});

test('parseHeadersString: colon in value is preserved', () => {
  const r = parseHeadersString('X-Time: 12:30:00');
  assert.equal(r['X-Time'], '12:30:00');
});

test('parseHeadersString: line starting with colon (empty key) is skipped', () => {
  const r = parseHeadersString(':novalue\nX-Ok: yes');
  assert.deepEqual(r, { 'X-Ok': 'yes' });
});

test('parseHeadersString: blank lines between headers are tolerated', () => {
  const raw = 'A: 1\n\nB: 2\n';
  const r = parseHeadersString(raw);
  assert.equal(r.A, '1');
  assert.equal(r.B, '2');
});

// ============================================================
// normalizeApiResponse
// ============================================================

test('normalizeApiResponse: flat array of objects -> high confidence passthrough', () => {
  const r = normalizeApiResponse([{ a: 1 }, { a: 2 }]);
  assert.equal(r.confidence, 'high');
  assert.equal(r.path, '(root array)');
  assert.equal(r.warning, null);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].a, 1);
});

test('normalizeApiResponse: API envelope extraction (nested array found)', () => {
  const input = { status: 'ok', results: [{ id: 1 }, { id: 2 }] };
  const r = normalizeApiResponse(input);
  assert.equal(r.confidence, 'medium');
  assert.equal(r.path, 'results');
  assert.equal(r.rows.length, 2);
  assert.match(r.warning, /Rows extracted from "results"/);
});

test('normalizeApiResponse: single object with no array -> one row', () => {
  const input = { id: 1, name: 'solo' };
  const r = normalizeApiResponse(input);
  assert.equal(r.confidence, 'low');
  assert.equal(r.path, '(root object)');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].name, 'solo');
});

test('normalizeApiResponse: empty array -> empty rows', () => {
  const r = normalizeApiResponse([]);
  assert.equal(r.rows.length, 0);
});

test('normalizeApiResponse: scalar input is ignored (empty result)', () => {
  const r = normalizeApiResponse(42);
  assert.equal(r.rows.length, 0);
  assert.equal(r.confidence, 'low');
  assert.match(r.warning, /Could not extract rows/);
});

test('normalizeApiResponse: string input is ignored (empty result)', () => {
  const r = normalizeApiResponse('just a string');
  assert.equal(r.rows.length, 0);
});

test('normalizeApiResponse: nested object dot-key flattening', () => {
  const input = [{ user: { name: 'Ann', address: { city: 'Chicago' } } }];
  const r = normalizeApiResponse(input);
  assert.equal(r.rows[0]['user.name'], 'Ann');
  assert.equal(r.rows[0]['user.address.city'], 'Chicago');
});

test('normalizeApiResponse: array in leaf position is JSON-stringified', () => {
  const input = [{ id: 1, tags: ['x', 'y'] }];
  const r = normalizeApiResponse(input);
  assert.equal(typeof r.rows[0].tags, 'string');
  assert.equal(r.rows[0].tags, JSON.stringify(['x', 'y']));
});

test('normalizeApiResponse: respects maxRows option', () => {
  const input = Array.from({ length: 10 }, (_, i) => ({ i }));
  const r = normalizeApiResponse(input, { maxRows: 4 });
  assert.equal(r.rows.length, 4);
});

test('normalizeApiResponse: null value passed through', () => {
  const r = normalizeApiResponse(null);
  assert.equal(r.rows.length, 0);
});

// ============================================================
// buildPollSchedule
// ============================================================

test('buildPollSchedule: one-shot (intervalMs=0) -> isOneShot true', () => {
  const r = buildPollSchedule(0, 'GET', 'https://api.example.com', {});
  assert.equal(r.isOneShot, true);
  assert.equal(r.label, 'One-time fetch');
});

test('buildPollSchedule: every 5s label matches POLL_LABELS', () => {
  const r = buildPollSchedule(5000, 'GET', 'https://api.example.com', {});
  assert.equal(r.label, 'Every 5s');
  assert.equal(r.isOneShot, false);
});

test('buildPollSchedule: every 5 min label matches POLL_LABELS', () => {
  const r = buildPollSchedule(300000, 'GET', 'https://api.example.com', {});
  assert.equal(r.label, 'Every 5 min');
});

test('buildPollSchedule: unknown interval gets custom generated label', () => {
  const r = buildPollSchedule(12000, 'GET', 'https://api.example.com', {});
  assert.equal(r.label, 'Every 12s');
});

test('buildPollSchedule: method defaults to GET for invalid method', () => {
  const r = buildPollSchedule(0, 'DELETE', 'https://api.example.com', {});
  assert.equal(r.method, 'GET');
});

test('buildPollSchedule: valid POST method is preserved', () => {
  const r = buildPollSchedule(0, 'POST', 'https://api.example.com', {});
  assert.equal(r.method, 'POST');
});

test('buildPollSchedule: headers default to empty object when omitted', () => {
  const r = buildPollSchedule(0, 'GET', 'https://api.example.com', null);
  assert.deepEqual(r.headers, {});
});

test('buildPollSchedule: headers are passed through when provided', () => {
  const headers = { Authorization: 'Bearer x' };
  const r = buildPollSchedule(0, 'GET', 'https://api.example.com', headers);
  assert.deepEqual(r.headers, headers);
});

test('buildPollSchedule: url is passed through unchanged', () => {
  const r = buildPollSchedule(0, 'GET', 'https://api.example.com/x', {});
  assert.equal(r.url, 'https://api.example.com/x');
});

// ============================================================
// buildFeedDataset
// ============================================================

test('buildFeedDataset: columns derived from first row keys', () => {
  const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  const schedule = buildPollSchedule(0, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset(rows, 'https://api.example.com', schedule);
  assert.deepEqual(ds.columns, ['id', 'name']);
  assert.equal(ds.rows.length, 2);
});

test('buildFeedDataset: empty rows -> empty columns array', () => {
  const schedule = buildPollSchedule(0, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset([], 'https://api.example.com', schedule);
  assert.deepEqual(ds.columns, []);
});

test('buildFeedDataset: meta.format is "api"', () => {
  const schedule = buildPollSchedule(0, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset([{ a: 1 }], 'https://api.example.com', schedule);
  assert.equal(ds.meta.format, 'api');
});

test('buildFeedDataset: meta.note contains the source URL', () => {
  const schedule = buildPollSchedule(0, 'GET', 'https://api.example.com/data', {});
  const ds = buildFeedDataset([{ a: 1 }], 'https://api.example.com/data', schedule);
  assert.match(ds.meta.note, /https:\/\/api\.example\.com\/data/);
});

test('buildFeedDataset: meta.note reflects one-time fetch when isOneShot', () => {
  const schedule = buildPollSchedule(0, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset([{ a: 1 }], 'https://api.example.com', schedule);
  assert.match(ds.meta.note, /One-time fetch/);
});

test('buildFeedDataset: meta.note reflects polling cadence when not one-shot', () => {
  const schedule = buildPollSchedule(15000, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset([{ a: 1 }], 'https://api.example.com', schedule);
  assert.match(ds.meta.note, /Auto-refreshes Every 15s/);
});

test('buildFeedDataset: meta.pollSchedule label is present', () => {
  const schedule = buildPollSchedule(30000, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset([{ a: 1 }], 'https://api.example.com', schedule);
  assert.equal(ds.meta.pollSchedule, 'Every 30s');
});

test('buildFeedDataset: meta.source equals passed URL', () => {
  const schedule = buildPollSchedule(0, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset([{ a: 1 }], 'https://api.example.com', schedule);
  assert.equal(ds.meta.source, 'https://api.example.com');
});

test('buildFeedDataset: uses provided fetchedAt when given', () => {
  const schedule = buildPollSchedule(0, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset([{ a: 1 }], 'https://api.example.com', schedule, '2026-01-01T00:00:00.000Z');
  assert.equal(ds.meta.fetchedAt, '2026-01-01T00:00:00.000Z');
});

test('buildFeedDataset: generates an ISO fetchedAt when omitted', () => {
  const schedule = buildPollSchedule(0, 'GET', 'https://api.example.com', {});
  const ds = buildFeedDataset([{ a: 1 }], 'https://api.example.com', schedule);
  assert.match(ds.meta.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// ============================================================
// End-to-end integration
// ============================================================

test('end-to-end: validate URL -> normalize response -> build dataset', () => {
  const v = validateFeedUrl('api.example.com/items');
  assert.equal(v.valid, true);
  const parsed = { total: 2, items: [{ id: 1, name: 'x' }, { id: 2, name: 'y' }] };
  const norm = normalizeApiResponse(parsed);
  assert.equal(norm.path, 'items');
  const schedule = buildPollSchedule(5000, 'GET', v.normalized, {});
  const ds = buildFeedDataset(norm.rows, v.normalized, schedule);
  assert.deepEqual(ds.columns, ['id', 'name']);
  assert.equal(ds.meta.pollSchedule, 'Every 5s');
});
