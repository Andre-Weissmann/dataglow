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

export const DataGlowArrowBridge = {
  ARROW_BRIDGE_KIND,
  ARROW_BRIDGE_VERSION,
  ARROW_BRIDGE_STATES,
  JSON_BRIDGE_ROW_LIMIT,
  NEVER_UNLIMITED,
  buildArrowBridgeStatus,
  describeArrowStepUp,
  arrowBridgeChipLabel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowArrowBridge = DataGlowArrowBridge;
} catch (_e) {}
