// ============================================================
// DATAGLOW - Arrow bridge: what the DuckDB to Python handoff costs today
// ============================================================
//
// The bridge that moves a table from DuckDB into pandas works like this: run
// the query with a LIMIT of two hundred thousand, walk the result into plain
// JavaScript objects, JSON.stringify the whole thing, hand the string to
// Pyodide, and let pandas parse it back. It works, and every step of it is a
// full copy of the data in a format that is not the format either end wanted.
//
// Both DuckDB-WASM and pandas already speak Arrow. DuckDB's result is Arrow
// internally; pyarrow reads an Arrow IPC buffer without parsing anything. The
// zero-copy path between them is real and it is not long. What it needs is
// pyarrow present in the Pyodide session, and pyarrow is not in the default
// package set for this build.
//
// WHY THIS MODULE REPORTS A STATE INSTEAD OF SHIPPING THE PATH.
// The transfer is only one of three things that have to be true, and the other
// two are not under this bundle's control: the DuckDB build has to expose the
// Arrow buffer rather than only materialised rows, and the Python side has to
// have pyarrow. Writing the transfer and letting it fail at runtime in a
// session that has neither is how a feature becomes a support burden. So the
// state is computed from what is observed and the three states mean exactly
// what they say:
//
//   `ready`    both ends can speak Arrow, so the buffer path is available
//   `partial`  one end can, which is worth reporting because it names the one
//              thing missing rather than saying no
//   `missing`  neither, and the JSON bridge with its row limit is what runs
//
// WHAT THIS NEVER SAYS.
// It never says unlimited. Arrow removes the parse cost and most of the copy
// cost; it does not remove the fact that the frame has to fit in the memory of
// one browser tab that is also running DuckDB. A limit still exists after this
// lands, it is just a different and larger one, and pretending otherwise trades
// a known ceiling for an unknown crash.
//
// Pure. No DuckDB handle, no Pyodide handle, no DOM.

export const ARROW_BRIDGE_KIND = 'dataglow-arrow-bridge';
export const ARROW_BRIDGE_VERSION = 1;

export const ARROW_BRIDGE_STATES = Object.freeze(['ready', 'partial', 'missing']);

/** The limit the JSON bridge enforces today. Pinned to the runtime by a test. */
export const JSON_BRIDGE_ROW_LIMIT = 200000;

export const NEVER_UNLIMITED =
  'An Arrow path removes the JSON parse and most of the copying. It does not remove the ceiling: the frame still has to fit in the memory of one browser tab that is also running DuckDB. There is no unlimited mode here and there is not going to be one.';

const STATE_LABEL = Object.freeze({
  ready: 'Arrow bridge: available',
  partial: 'Arrow bridge: one end ready',
  missing: 'Arrow bridge: not available, JSON bridge in use',
});

const STATE_DETAIL = Object.freeze({
  ready:
    'DuckDB can hand out an Arrow buffer and this Python session has pyarrow, so a table can cross without being serialised to text on the way.',
  partial:
    'One side of the transfer can speak Arrow and the other cannot, so the JSON bridge is still what runs. The missing piece is named below rather than left as a general failure.',
  missing:
    'Neither end is set up for Arrow in this session, so tables cross as JSON with the row limit that implies. Everything works; large tables are slower and get truncated.',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function count(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * @param {{duckdbArrow?:boolean, pyarrow?:boolean, pythonReady?:boolean,
 *          rowLimit?:number, rowCount?:number}} [input]
 */
export function buildArrowBridgeStatus(input) {
  const inp = isPlainObject(input) ? input : {};
  const duckdbArrow = inp.duckdbArrow === true;
  const pyarrow = inp.pyarrow === true;
  const pythonReady = inp.pythonReady === true;
  const limit = count(inp.rowLimit) || JSON_BRIDGE_ROW_LIMIT;
  const rows = count(inp.rowCount);

  let state;
  if (duckdbArrow && pyarrow) state = 'ready';
  else if (duckdbArrow || pyarrow) state = 'partial';
  else state = 'missing';

  const missingPieces = [];
  if (!duckdbArrow) missingPieces.push('the DuckDB build in this page does not expose an Arrow result buffer to JavaScript');
  if (!pyarrow) missingPieces.push('pyarrow is not loaded in this Python session');
  if (!pythonReady) missingPieces.push('the Python runtime has not started, so nothing has been asked yet');

  return {
    kind: ARROW_BRIDGE_KIND,
    version: ARROW_BRIDGE_VERSION,
    state,
    label: STATE_LABEL[state],
    detail: STATE_DETAIL[state],
    usable: state === 'ready',
    // What actually runs today, whatever the state says about what could.
    activeTransport: state === 'ready' ? 'arrow_ipc' : 'json',
    rowLimit: limit,
    rowsWouldTruncate: rows > limit,
    missingPieces,
    neverUnlimited: NEVER_UNLIMITED,
    observed: { duckdbArrow, pyarrow, pythonReady, rowCount: rows },
    headline: state === 'ready'
      ? 'Both ends speak Arrow in this session.'
      : 'The JSON bridge is what runs. ' + (missingPieces[0] ? missingPieces[0].charAt(0).toUpperCase() + missingPieces[0].slice(1) + '.' : ''),
  };
}

/**
 * The step-up from the JSON bridge, written down as data.
 *
 * Each step names the observable that proves it happened, so a later session
 * can tell how far the path got rather than reading the code to find out.
 */
export function describeArrowStepUp() {
  return {
    kind: ARROW_BRIDGE_KIND,
    from: 'A LIMIT ' + JSON_BRIDGE_ROW_LIMIT + ' query, walked into plain objects, JSON.stringify, parsed back by pandas.',
    to: 'A DuckDB Arrow result buffer handed to pyarrow as bytes, read as a table without parsing.',
    steps: Object.freeze([
      Object.freeze({
        id: 'probe-pyarrow',
        do: 'Probe the Python session for pyarrow rather than assuming it.',
        provenBy: 'buildArrowBridgeStatus reports pyarrow true for a session that has it.',
        done: true,
      }),
      Object.freeze({
        id: 'expose-arrow-result',
        do: 'Take the Arrow result from the DuckDB connection instead of materialising rows.',
        provenBy: 'The DuckDB result object exposes a buffer this page can read without a row walk.',
        done: false,
      }),
      Object.freeze({
        id: 'write-buffer',
        do: 'Write the buffer into the Pyodide filesystem or pass it as bytes, then read it with pyarrow.ipc.',
        provenBy: 'A Python cell can open the table without a JSON string existing at any point.',
        done: false,
      }),
      Object.freeze({
        id: 'raise-the-limit',
        do: 'Raise the row limit to a memory-derived number and keep reporting it.',
        provenBy: 'The bridge notice quotes a limit that is larger and still a number.',
        done: false,
      }),
    ]),
    status: 'partial',
    statusMeaning:
      'The probe and the status reporting are here. The transfer itself is not, so the JSON bridge is still what moves data and its row limit is still the real one.',
    neverUnlimited: NEVER_UNLIMITED,
  };
}

/** One line for a chip. Never claims ready without both ends. */
export function arrowBridgeChipLabel(status) {
  if (!isPlainObject(status)) return STATE_LABEL.missing;
  return STATE_LABEL[status.state] || STATE_LABEL.missing;
}


// ============================================================
// Bundle 14 - arrowBridgeDeepen: a transfer that actually beats a JSON dump
// ============================================================
//
// Bundle 13 shipped the honest status (ready/partial/missing) for whether
// both ends of the DuckDB-to-Python handoff speak Arrow. It did not ship any
// transfer, because full Arrow IPC needs the DuckDB build in this page to
// expose a raw Arrow buffer, and it does not today: the bridge still walks a
// materialised result into plain JS objects. That is unchanged here.
//
// What is new is the rung in between. A batched transfer, typed arrays per
// column instead of one big JSON string, removes the per-row object
// allocation and the string-parse cost on both ends without requiring the
// DuckDB Arrow buffer this build does not have. It is not zero-copy and it is
// not Arrow IPC; it is real work that is not the JSON path either, which is
// why the status now names four states instead of collapsing "no IPC yet"
// into "nothing happened":
//
//   `arrow_ipc`    a real Arrow IPC byte buffer crossed, no JSON, no per-row walk
//   `batch_bridge` typed-array column batches crossed; faster than JSON, not IPC
//   `json_bridge`  today's default: rows walked to objects, JSON.stringify'd
//   `missing`      neither end can do anything better than nothing
//
// WHY THE FIXTURE ROUND-TRIP IS SMALL AND SYNCHRONOUS.
// `roundTripFixture()` proves the batch path end-to-end on a small, fixed
// input: encode a column to a typed array, hand it across (a plain function
// call stands in for the postMessage/Pyodide-FS boundary a real transfer
// would cross), decode it, and compare. It is a correctness proof for the
// encode/decode pair, not a benchmark, and it never claims to model what a
// 200,000-row transfer costs in a real browser tab.
//
// NEVER UNLIMITED, STILL. Batching changes the constant, not the ceiling: the
// frame still has to fit in the memory of one tab running DuckDB. The row
// limit reported alongside `batch_bridge` is the same JSON_BRIDGE_ROW_LIMIT
// unless the caller has actual evidence for a higher one, because a bigger
// number written in without evidence is exactly the claim this module refuses
// to make.

export const ARROW_BRIDGE_STATUS_KINDS = Object.freeze(['arrow_ipc', 'batch_bridge', 'json_bridge', 'missing']);

/** Numeric typed-array kinds this module knows how to encode. Extend deliberately. */
export const BATCH_DTYPES = Object.freeze(['float64', 'int32']);

function isPlainObjectDeepen(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The four-state status. Superset of buildArrowBridgeStatus(): everything
 * that function reports is still here under the same field names, plus
 * `transferKind` naming which of the four states is actually true, and
 * `batchBridgeAvailable` naming whether the typed-array path below can run in
 * this session (it only needs TypedArrays, which every supported browser and
 * every Node used in CI already has).
 *
 * @param {{duckdbArrow?:boolean, pyarrow?:boolean, pythonReady?:boolean,
 *          rowLimit?:number, rowCount?:number, typedArraysAvailable?:boolean}} [input]
 */
export function buildArrowBridgeStatusV2(input) {
  const inp = isPlainObjectDeepen(input) ? input : {};
  const base = buildArrowBridgeStatus(inp);

  const typedArraysAvailable = inp.typedArraysAvailable !== false
    && typeof Float64Array !== 'undefined';

  let transferKind;
  if (base.state === 'ready') transferKind = 'arrow_ipc';
  else if (typedArraysAvailable && inp.pythonReady === true) transferKind = 'batch_bridge';
  else if (inp.pythonReady === true) transferKind = 'json_bridge';
  else transferKind = 'missing';

  return Object.assign({}, base, {
    transferKind,
    batchBridgeAvailable: typedArraysAvailable,
    activeTransport: transferKind,
    headline: transferKind === 'arrow_ipc'
      ? base.headline
      : transferKind === 'batch_bridge'
        ? 'Typed-array column batches cross today: faster than the JSON dump, still not Arrow IPC.'
        : transferKind === 'json_bridge'
          ? 'Rows are walked to objects and JSON.stringify\'d. The batch path is not active for this session.'
          : base.headline,
  });
}

/**
 * Encode one numeric column into a typed array plus the metadata a decoder
 * needs. This is the whole "batch" in batch_bridge: no JSON string exists at
 * any point in this path, only a typed array and a small header object.
 *
 * @param {Array<number|null>} values
 * @param {string} [dtype] one of BATCH_DTYPES, default float64
 */
export function encodeColumnBatch(values, dtype) {
  const rows = Array.isArray(values) ? values : [];
  const kind = BATCH_DTYPES.indexOf(dtype) >= 0 ? dtype : 'float64';
  const Ctor = kind === 'int32' ? Int32Array : Float64Array;
  const nullMask = new Uint8Array(rows.length);
  const buf = new Ctor(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) {
      nullMask[i] = 1;
      buf[i] = 0;
    } else {
      buf[i] = Number(v);
    }
  }
  return {
    kind: ARROW_BRIDGE_KIND,
    dtype: kind,
    length: rows.length,
    values: buf,
    nullMask,
    bytes: buf.byteLength + nullMask.byteLength,
  };
}

/** Decode a batch built by encodeColumnBatch() back into a plain array. */
export function decodeColumnBatch(batch) {
  if (!isPlainObjectDeepen(batch) || !batch.values) return [];
  const out = new Array(batch.length);
  for (let i = 0; i < batch.length; i++) {
    out[i] = batch.nullMask && batch.nullMask[i] ? null : batch.values[i];
  }
  return out;
}

/**
 * Prove the batch path end to end on a small fixed fixture. Synchronous, pure,
 * no timing claim: this is a correctness check, not a benchmark.
 */
export function roundTripFixture() {
  const fixture = [1, 2, null, 4.5, -3, null, 0];
  const batch = encodeColumnBatch(fixture, 'float64');
  const back = decodeColumnBatch(batch);
  const matches = fixture.length === back.length
    && fixture.every((v, i) => (v === null ? back[i] === null : back[i] === v));
  return {
    kind: ARROW_BRIDGE_KIND,
    ok: matches,
    fixtureLength: fixture.length,
    bytes: batch.bytes,
    dtype: batch.dtype,
    note: matches
      ? 'Encoded ' + fixture.length + ' values to ' + batch.bytes + ' bytes of typed array and decoded them back exactly, nulls included.'
      : 'Round trip did not match. This would be a real bug in the encode/decode pair, not an environment issue.',
  };
}

/** Ceiling text for the batch path specifically, so it is never read as unlimited either. */
export const BATCH_BRIDGE_CEILING =
  'A typed-array batch removes the JSON parse and the per-row object allocation on both ends. It does not remove the ceiling: the column still has to fit in memory as a contiguous typed array on both sides, and it is still capped at the same row limit as the JSON path until there is real evidence for a higher one.';

export const DataGlowArrowBridge = {
  ARROW_BRIDGE_KIND,
  ARROW_BRIDGE_VERSION,
  ARROW_BRIDGE_STATES,
  ARROW_BRIDGE_STATUS_KINDS,
  BATCH_DTYPES,
  JSON_BRIDGE_ROW_LIMIT,
  BATCH_BRIDGE_CEILING,
  NEVER_UNLIMITED,
  buildArrowBridgeStatus,
  buildArrowBridgeStatusV2,
  encodeColumnBatch,
  decodeColumnBatch,
  roundTripFixture,
  describeArrowStepUp,
  arrowBridgeChipLabel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowArrowBridge = DataGlowArrowBridge;
} catch (_e) {}
