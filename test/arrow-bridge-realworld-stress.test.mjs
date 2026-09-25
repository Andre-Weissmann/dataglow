// ============================================================
// DATAGLOW — Arrow bridge real-world stress test (permanent regression)
// ============================================================
// Structural Readiness Phase item 1 ("prove breadth"), Polyglot Workbench
// pass, 2026-09-24.
//
// test/bundle14-ledger-pq-arrow-llama-lanes.test.mjs proves encodeColumnBatch/
// decodeColumnBatch round-trip cleanly on well-behaved fixtures (small
// integers/floats, nulls). This file is the real-world stress test: what
// happens with the kind of messy numeric data a real DuckDB -> Python handoff
// actually produces -- huge values, non-integer floats routed to int32,
// int32 overflow, and non-numeric strings (extremely common in real
// healthcare/claims exports as missing-data markers, e.g. "N/A", "unknown").
//
// FINDING (before the fix in this same PR): encodeColumnBatch(['N/A', 5],
// 'float64') wrote a literal NaN into the buffer with nullMask[0] === 0 (as
// if it were valid, non-null data) -- a real silent data-corruption bug, not
// a crash. encodeColumnBatch([5000000000], 'int32') silently wrapped via
// 32-bit overflow to 705032704, also with no signal anything was wrong.
// encodeColumnBatch([3.7], 'int32') silently truncated to 3.
//
// FIX: encodeColumnBatch now null-masks (and counts in droppedCount/
// droppedReasons) any value that doesn't coerce to a finite number or doesn't
// actually fit the chosen dtype, instead of writing corrupted data. This test
// locks that behavior in as a permanent regression floor.
//
// RUN WITH:  node --test test/arrow-bridge-realworld-stress.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeColumnBatch, decodeColumnBatch } from '../js/polyglot/arrow-bridge.js';

describe('arrow bridge real-world stress: values that legitimately should round-trip', () => {
  it('a huge but finite float64 value round-trips exactly', () => {
    const batch = encodeColumnBatch([1e300, 2, null], 'float64');
    assert.deepEqual(decodeColumnBatch(batch), [1e300, 2, null]);
    assert.equal(batch.droppedCount, 1); // just the null
  });

  it('a numeric-looking string coerces correctly, same as a real number', () => {
    const batch = encodeColumnBatch(['42', 7], 'float64');
    assert.deepEqual(decodeColumnBatch(batch), [42, 7]);
    assert.equal(batch.droppedCount, 0);
  });

  it('negative zero and real Infinity/-Infinity are each handled correctly', () => {
    const batch = encodeColumnBatch([-0, Infinity, -Infinity, 5], 'float64');
    const back = decodeColumnBatch(batch);
    assert.equal(back[0], -0);
    assert.equal(back[1], null);
    assert.equal(back[2], null);
    assert.equal(back[3], 5);
    assert.equal(batch.droppedCount, 2);
    assert.equal(batch.droppedReasons.non_finite_number, 2);
  });

  it('a plain in-range int32 column round-trips with zero drops', () => {
    const batch = encodeColumnBatch([1, -2, 3], 'int32');
    assert.deepEqual(decodeColumnBatch(batch), [1, -2, 3]);
    assert.equal(batch.droppedCount, 0);
  });
});

describe('arrow bridge real-world stress: values that must be null-masked, never silently corrupted', () => {
  it('a non-numeric string is null-masked, NOT written as a silent NaN (the real bug this test locks shut)', () => {
    const batch = encodeColumnBatch(['N/A', 5, 'unknown'], 'float64');
    const back = decodeColumnBatch(batch);
    assert.equal(back[0], null, '"N/A" must decode to null, not NaN');
    assert.equal(back[1], 5);
    assert.equal(back[2], null, '"unknown" must decode to null, not NaN');
    // The old bug: nullMask[0] was 0 (falsely "not null") while the buffer held NaN.
    assert.equal(batch.nullMask[0], 1, 'nullMask must mark index 0 as null');
    assert.equal(batch.nullMask[2], 1, 'nullMask must mark index 2 as null');
    assert.equal(batch.droppedCount, 2);
    assert.equal(batch.droppedReasons.non_numeric_string, 2);
    // Never a NaN sitting in the raw typed-array buffer as if it were valid data.
    assert.ok(!Number.isNaN(batch.values[0]), 'buffer slot for a dropped value must not be NaN');
  });

  it('a non-integer value routed to int32 is null-masked, not silently truncated (the old ToInt32 bug)', () => {
    const batch = encodeColumnBatch([3.7, 8.2, -1.9], 'int32');
    assert.deepEqual(decodeColumnBatch(batch), [null, null, null]);
    assert.equal(batch.droppedCount, 3);
    assert.equal(batch.droppedReasons.non_integer_for_int32, 3);
  });

  it('an integer outside the int32 range is null-masked, not silently wrapped (the old overflow bug)', () => {
    const batch = encodeColumnBatch([5000000000, 42], 'int32');
    const back = decodeColumnBatch(batch);
    assert.equal(back[0], null, 'an out-of-range int32 value must decode to null, not a wrapped value');
    assert.equal(back[1], 42);
    assert.equal(batch.droppedReasons.out_of_int32_range, 1);
  });

  it('null and undefined are both counted under null_or_undefined, distinct from coercion failures', () => {
    const batch = encodeColumnBatch([null, undefined, 5], 'float64');
    assert.deepEqual(decodeColumnBatch(batch), [null, null, 5]);
    assert.equal(batch.droppedReasons.null_or_undefined, 2);
  });
});
