// ============================================================
// DATAGLOW - Repair Ledger: the Applied Steps list this product never had
// ============================================================
//
// Power Query has one thing DataGlow's polyglot surfaces do not: a visible,
// ordered, append-only list of every step that touched the data, each one
// clickable back to the transform that produced it. DataGlow has the same
// facts scattered across five surfaces (CSV quarantine, the Excel type guard,
// Excel Hell repairs, SUMMARIZE tiles, power-pack recipe runs) and no single
// place that lines them up in the order they happened.
//
// This module is that place. It is a plain append-only log, kept in memory by
// the caller and handed to `appendStep()` on every call, because a step that
// already happened cannot un-happen and a log that could silently lose a step
// is worse than not keeping one.
//
// WHY EVERY STEP CARRIES A STATUS RATHER THAN JUST EXISTING.
// A step that ran and a step that was proposed and declined are both facts
// worth keeping, and they are not the same fact. `applied` | `skipped` |
// `failed` | `proposed` says which, so the ledger can show the guided-unpivot
// someone declined next to the type guard they accepted, instead of only
// showing what happened to go well.
//
// WHY RE-RUN IS HONEST ABOUT WHAT IT CANNOT DO.
// A step that is a pure SQL insert (a recipe card copied and run) can be
// handed back verbatim; that is a re-run. A step that was a decision made by
// a person looking at a preview (a type-guard hold, an Excel Hell repair) is
// not something this module can safely replay, because the input it was
// judged against may no longer be the input on screen. `canRerun()` says so
// per step rather than offering a button that would silently do the wrong
// thing.
//
// WHAT THIS DOES NOT DO.
// It does not touch DuckDB, the DOM, or storage. It does not decide when a
// step happened; every caller passes in the timestamp, or this module stamps
// one at append time from Date.now(), which is the only clock it owns. It does
// not replace the Trust Ledger or the Proof Board; buildLedgerLink() hands out
// a plain object either of those can log or link to, on a best-effort basis.
//
// Pure. No DOM, no engine, no network, no storage. The canvas surface owns the
// array this operates on and calls appendStep()/exportLedger() against it.

export const REPAIR_LEDGER_KIND = 'dataglow-repair-ledger';
export const REPAIR_LEDGER_VERSION = 1;

export const REPAIR_LEDGER_KINDS = Object.freeze([
  'load', 'quarantine_decision', 'type_guard', 'excel_hell_apply',
  'sql_recipe_run', 'python_recipe', 'r_recipe', 'summarize_tiles', 'export',
]);

export const REPAIR_LEDGER_ENGINES = Object.freeze(['sql', 'python', 'r', 'excel', 'system']);

export const REPAIR_LEDGER_STATUSES = Object.freeze(['applied', 'skipped', 'failed', 'proposed']);

/** Step kinds whose code is a pure insert DuckDB will run again unchanged. */
export const RERUNNABLE_KINDS = Object.freeze(['sql_recipe_run']);

export const APPLIED_STEPS_EQUIVALENT =
  'Power Query calls this the Applied Steps list: every transform, in order, each one clickable back to what it did. This is that list for DataGlow. It is not Power Query M and nothing here is replayed automatically; re-run only offers itself for a step that is a pure SQL insert, and says so when it cannot.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function oneOf(v, list, fallback) {
  const s = str(v);
  return list.indexOf(s) >= 0 ? s : fallback;
}

let counter = 0;
/** Monotonic id, so two steps appended in the same millisecond still sort. */
function nextId() {
  counter += 1;
  return 'rl-' + Date.now().toString(36) + '-' + counter.toString(36);
}

/**
 * Build one ledger entry. Does not append it anywhere; `appendStep()` does
 * that. Kept separate so a caller can build a step, inspect it, and decide.
 *
 * @param {{kind?:string, title?:string, engine?:string, code?:string,
 *   recipeId?:string, inputTable?:string, outputTable?:string,
 *   summary?:string, status?:string, at?:number}} [input]
 */
export function buildStep(input) {
  const inp = isPlainObject(input) ? input : {};
  const kind = oneOf(inp.kind, REPAIR_LEDGER_KINDS, 'sql_recipe_run');
  const engine = oneOf(inp.engine, REPAIR_LEDGER_ENGINES, 'system');
  const status = oneOf(inp.status, REPAIR_LEDGER_STATUSES, 'applied');
  const title = str(inp.title) || kind.replace(/_/g, ' ');
  const code = str(inp.code);
  const at = typeof inp.at === 'number' && isFinite(inp.at) ? inp.at : Date.now();

  return {
    id: nextId(),
    at,
    kind,
    title,
    engine,
    code,
    recipeId: str(inp.recipeId),
    inputTable: str(inp.inputTable),
    outputTable: str(inp.outputTable),
    summary: str(inp.summary) || title,
    status,
    rerunnable: status === 'applied' && RERUNNABLE_KINDS.indexOf(kind) >= 0 && !!code,
  };
}

/**
 * Append one step to a ledger array and return the new step.
 *
 * The array itself is the caller's; this never allocates a new one, so a
 * reference held elsewhere (a UI's own `state.steps`) stays valid across
 * every append. Append-only: nothing here removes or reorders an entry.
 *
 * @param {Array} ledger  a plain array, mutated in place
 * @param {object} [input]  see buildStep()
 */
export function appendStep(ledger, input) {
  if (!Array.isArray(ledger)) throw new Error('appendStep: ledger must be an array');
  const step = buildStep(input);
  ledger.push(step);
  return step;
}

/** Steps in the order they happened. A copy, so a caller cannot mutate the log by holding this. */
export function listSteps(ledger) {
  return Array.isArray(ledger) ? ledger.slice() : [];
}

/** Steps of one status, or every status when none is given. */
export function stepsByStatus(ledger, status) {
  const rows = listSteps(ledger);
  const s = str(status);
  if (!s) return rows;
  return rows.filter((r) => r.status === s);
}

/** Whether a specific step (by id or the step object itself) can be re-run. */
export function canRerun(step) {
  if (!isPlainObject(step)) return false;
  return step.status === 'applied' && RERUNNABLE_KINDS.indexOf(step.kind) >= 0 && !!str(step.code);
}

/**
 * "Re-run" a rerunnable step: hands back the exact code to execute, and never
 * executes it here. The caller's SQL engine runs it and appends a new step
 * for the result, because a re-run is itself a new fact in the ledger, not an
 * edit to the old one.
 */
export function rerunPlan(step) {
  if (!canRerun(step)) {
    return {
      kind: REPAIR_LEDGER_KIND,
      ok: false,
      reason: !isPlainObject(step)
        ? 'No step given.'
        : step.status !== 'applied'
          ? 'This step is marked ' + step.status + ', not applied, so there is nothing finished to repeat.'
          : RERUNNABLE_KINDS.indexOf(step.kind) < 0
            ? 'This step was a decision (' + step.kind + '), not a pure insert. Replaying it could judge stale input, so it is not offered.'
            : 'This step has no code recorded, so there is nothing to hand back.',
    };
  }
  return {
    kind: REPAIR_LEDGER_KIND,
    ok: true,
    code: step.code,
    engine: step.engine,
    note: 'This is the exact SQL that ran. Nothing here executes it; run it and append the result as a new step.',
  };
}

/** One receipt-friendly line, for a toast or a Trust Ledger line. */
export function stepReceiptLine(step) {
  if (!isPlainObject(step)) return '';
  const when = new Date(step.at).toISOString();
  return '[' + when + '] ' + step.engine + ' ' + step.kind + ': ' + step.summary + ' (' + step.status + ')';
}

/** The whole ledger as JSON text, for a download or a paste target. */
export function exportLedgerJson(ledger) {
  return JSON.stringify(
    {
      kind: REPAIR_LEDGER_KIND,
      version: REPAIR_LEDGER_VERSION,
      exportedAt: new Date().toISOString(),
      steps: listSteps(ledger),
    },
    null,
    2,
  );
}

/** The whole ledger as a markdown table, for a receipt or a hand-off doc. */
export function exportLedgerMarkdown(ledger) {
  const rows = listSteps(ledger);
  const lines = [
    '# Repair Ledger',
    '',
    APPLIED_STEPS_EQUIVALENT,
    '',
    '| # | When | Kind | Engine | Title | Status | Code / recipe |',
    '|---|---|---|---|---|---|---|',
  ];
  rows.forEach((s, i) => {
    const when = new Date(s.at).toISOString();
    const code = s.code ? '`' + s.code.replace(/\n/g, ' ').slice(0, 80).replace(/\|/g, '\\|') + '`' : (s.recipeId || '');
    lines.push('| ' + (i + 1) + ' | ' + when + ' | ' + s.kind + ' | ' + s.engine + ' | ' + s.title + ' | ' + s.status + ' | ' + code + ' |');
  });
  if (!rows.length) lines.push('| - | - | - | - | *(nothing logged yet)* | - | - |');
  return lines.join('\n') + '\n';
}

/**
 * A best-effort record of which upstream surfaces this ledger has ever heard
 * from, so an honest "the following did not wire up" list can be produced
 * instead of a silent gap. Callers pass in which sources fired at least once
 * this session; nothing here observes anything on its own.
 *
 * @param {{firedSources?:Array<string>}} [input]
 */
export function wiringReport(input) {
  const inp = isPlainObject(input) ? input : {};
  const known = Object.freeze([
    'load', 'csv_quarantine', 'type_guard', 'excel_hell', 'sql_recipe',
    'python_recipe', 'r_recipe', 'summarize_tiles', 'export',
  ]);
  const fired = Array.isArray(inp.firedSources) ? inp.firedSources.filter((s) => typeof s === 'string') : [];
  const unwired = known.filter((k) => fired.indexOf(k) < 0);
  return {
    kind: REPAIR_LEDGER_KIND,
    known,
    fired,
    unwired,
    headline: unwired.length
      ? 'Wired and observed this session: ' + fired.length + ' of ' + known.length + '. Not yet seen: ' + unwired.join(', ') + '.'
      : 'Every known surface has appended at least one step this session.',
  };
}

/** Summary counts, for a chip. */
export function ledgerSummary(ledger) {
  const rows = listSteps(ledger);
  const byStatus = {};
  REPAIR_LEDGER_STATUSES.forEach((s) => { byStatus[s] = 0; });
  rows.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  return {
    kind: REPAIR_LEDGER_KIND,
    total: rows.length,
    byStatus,
    lastStep: rows.length ? rows[rows.length - 1] : null,
    headline: rows.length
      ? rows.length + ' step' + (rows.length === 1 ? '' : 's') + ' logged. Last: ' + rows[rows.length - 1].title + '.'
      : 'No steps logged yet in this session.',
  };
}

export const DataGlowRepairLedger = {
  REPAIR_LEDGER_KIND,
  REPAIR_LEDGER_VERSION,
  REPAIR_LEDGER_KINDS,
  REPAIR_LEDGER_ENGINES,
  REPAIR_LEDGER_STATUSES,
  RERUNNABLE_KINDS,
  APPLIED_STEPS_EQUIVALENT,
  buildStep,
  appendStep,
  listSteps,
  stepsByStatus,
  canRerun,
  rerunPlan,
  stepReceiptLine,
  exportLedgerJson,
  exportLedgerMarkdown,
  wiringReport,
  ledgerSummary,
};

try {
  if (typeof window !== 'undefined') window.DataGlowRepairLedger = DataGlowRepairLedger;
} catch (_e) {}
