// ============================================================
// DATAGLOW - Polars secondary path (status and honesty, not an engine)
// ============================================================
//
// Polars keeps being the right answer to a question DataGlow does not have.
// It is genuinely fast at dataframe work, people ask for it by name, and a
// chip saying "Polars ready" would be the single cheapest way to look more
// serious than the product is. That is exactly why this file exists and why it
// contains no engine.
//
// WHAT IS ACTUALLY TRUE TODAY.
// DuckDB WASM is the analytical engine and it is not being replaced. Polars is
// reachable only if the Pyodide session happens to have the wheel available,
// which is not something DataGlow ships or guarantees. So the honest surface is
// a status: available, not installed, or not applicable on this platform. There
// is no fourth state that means "coming soon", because a state nobody can
// currently be in is a promise wearing the costume of a status.
//
// WHY THE AVAILABILITY IS PASSED IN.
// Detecting Polars means running `import polars` inside Pyodide, which is a
// runtime probe with a load cost and a failure mode. This module takes the
// answer as an argument so it stays pure, so it can be tested on a machine with
// no Pyodide at all, and so the probe lives in one place next to the runtime
// that owns it rather than being reimplemented by every surface that wants a
// chip.
//
// Pure. No imports, no probing, no engine.

export const POLARS_PATH_KIND = 'dataglow-polars-path';
export const POLARS_PATH_VERSION = 1;

export const POLARS_STATES = Object.freeze(['available', 'not_installed', 'not_on_platform']);

export const DUCKDB_STAYS_PRIMARY =
  'DuckDB running as WebAssembly is the analytical engine here and it is not being replaced. Any Polars path is a second way to do dataframe work beside it, never underneath it.';

const STATE_LABEL = Object.freeze({
  available: 'Polars path: available in this Python session',
  not_installed: 'Polars path: not installed',
  not_on_platform: 'Polars path: not applicable here',
});

const STATE_DETAIL = Object.freeze({
  available:
    'This Pyodide session can import polars, so a Python cell can use it directly. DataGlow does not route anything through it automatically and no query planner knows it is there.',
  not_installed:
    'Polars is not importable in this Pyodide session. Nothing here installs it, and the SQL path is unaffected because it never used Polars in the first place.',
  not_on_platform:
    'The Python runtime is not running, so the question of whether Polars is importable has no answer yet. Start a Python session first.',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * What a Polars path would be for, written down so the scaffold is legible as a
 * decision rather than as an unfinished feature.
 */
export function describePolarsSecondaryPath() {
  return {
    kind: POLARS_PATH_KIND,
    version: POLARS_PATH_VERSION,
    title: 'Polars, as a second path',
    summary:
      'Fast dataframe operations beside DuckDB SQL, for the work that is awkward to phrase as a query: reshaping, chained transforms, and expression pipelines over a table already loaded.',
    wouldDo: [
      'Run group-by, join and window expressions over a loaded table without writing SQL for it.',
      'Chain transforms in a way that reads as steps rather than as one nested query.',
      'Hand the result back as a dataframe the rest of the Python cell already understands.',
    ],
    wouldNotDo: [
      'Replace DuckDB. The SQL tab, the generated SQL and the query receipts all stay on DuckDB.',
      'Become an automatic fast path. Nothing would silently choose Polars for you, because a query that ran somewhere you did not pick is a query you cannot reason about.',
      'Ship a wheel. DataGlow does not bundle Polars and does not install it for you.',
    ],
    status: 'scaffold',
    statusMeaning:
      'This module reports whether Polars is reachable and describes what a Polars path would be. It contains no engine and routes nothing.',
    primaryEngine: DUCKDB_STAYS_PRIMARY,
  };
}

/**
 * @param {{pyodideHasPolars?:boolean, pythonReady?:boolean, platform?:string}} [input]
 */
export function buildPolarsAvailability(input) {
  const inp = isPlainObject(input) ? input : {};
  const pythonReady = inp.pythonReady !== false;
  const has = inp.pyodideHasPolars === true;
  const platform = typeof inp.platform === 'string' && inp.platform ? inp.platform : 'web';

  const state = !pythonReady ? 'not_on_platform' : has ? 'available' : 'not_installed';

  return {
    kind: POLARS_PATH_KIND,
    version: POLARS_PATH_VERSION,
    state,
    label: STATE_LABEL[state],
    detail: STATE_DETAIL[state],
    usable: state === 'available',
    replacesDuckDb: false,
    primaryEngine: DUCKDB_STAYS_PRIMARY,
    platform,
    observed: { pyodideHasPolars: has, pythonReady },
  };
}

/** One line for a chip. Never says ready when it is not. */
export function polarsChipLabel(availability) {
  if (!isPlainObject(availability)) return STATE_LABEL.not_on_platform;
  return STATE_LABEL[availability.state] || STATE_LABEL.not_on_platform;
}

export const DataGlowPolarsPath = {
  POLARS_PATH_KIND,
  POLARS_PATH_VERSION,
  POLARS_STATES,
  DUCKDB_STAYS_PRIMARY,
  describePolarsSecondaryPath,
  buildPolarsAvailability,
  polarsChipLabel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowPolarsPath = DataGlowPolarsPath;
} catch (_e) {}
