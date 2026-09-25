# Arrow bridge (js/polyglot/arrow-bridge.js) real-world stress test — 2026-09-24

Existing tests (`test/bundle14-ledger-pq-arrow-llama-lanes.test.mjs`) prove `encodeColumnBatch`/
`decodeColumnBatch` round-trip cleanly on the documented fixture (`[1, 2, null, 4.5, -3, null, 0]`)
— small integers/floats and nulls. That's a real, valid roundtrip check, but it uses only clean,
well-behaved numbers. This stress test asks: what happens when the SAME functions receive the kind
of messy numeric data a real DuckDB→Python handoff would actually produce — huge values, non-integer
floats routed to `int32`, strings that look like numbers, and other realistic edge cases?

Ground truth defined BEFORE running the code, based on reading the actual implementation:

1. **Huge float64 value (1e300).** `isFinite(1e300)` is true, so it should encode/decode exactly
   (float64 can represent it). Expected: PASS.
2. **Non-integer value routed through `dtype: 'int32'`** (e.g. `3.7` with `dtype: 'int32'`).
   `Number(3.7)` assigned into an `Int32Array` slot truncates via ECMAScript's `ToInt32` abstract
   operation (silent truncation toward zero, not rounding) — `3.7` becomes `3`. Expected: this IS a
   real, silent, undocumented precision loss — worth flagging as a finding, not a "bug" exactly, since
   dtype is caller-supplied, but the function has zero validation/warning when the caller's data
   doesn't actually fit the chosen dtype.
3. **Int32 overflow** (e.g. `5_000_000_000` — bigger than Int32 max ~2.1B — with `dtype: 'int32'`).
   `Number(5e9)` into an `Int32Array` slot wraps via 32-bit overflow (`ToInt32`), producing a
   nonsensical wrapped value, not an error or a null. Expected: a real, silent data-corruption risk if
   this path is ever fed a real large ID column (e.g. a billing/claim ID) without dtype validation.
4. **String that looks like a number** (e.g. `"42"` as a value in an otherwise-numeric column).
   `Number("42")` = `42`, so this actually coerces correctly. Expected: PASS (a pleasant surprise, not
   a bug) — but a truly non-numeric string (e.g. `"N/A"`) becomes `Number("N/A")` = `NaN`, and since
   the code's null-check runs on the ORIGINAL value `v`, not on `Number(v)`, a string `"N/A"` is not
   `null`/`undefined` and `typeof v === 'number'` is false for a string, so the `!isFinite(v)` check
   is never reached for it — it falls to the `else` branch, `Number("N/A")` = `NaN`, and `NaN` gets
   written into the typed array as a normal value, NOT flagged in the null mask. Expected: this is a
   REAL bug — a non-numeric string value should become a null-masked cell, not a silent `NaN` written
   into the data buffer as if it were valid.
5. **Negative zero and Infinity** — `-0` should round-trip as `0` (float64 has no distinct visible
   -0 vs 0 issue for this use case) and `Infinity`/`-Infinity` should be caught by `!isFinite(v)` and
   null-masked. Expected: PASS for both.
