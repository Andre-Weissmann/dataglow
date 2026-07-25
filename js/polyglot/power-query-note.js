// ============================================================
// DATAGLOW - Power Query: what this product is not
// ============================================================
//
// Somebody arriving from Excel with a workbook full of Power Query steps will
// ask whether those steps run here. The answer is no, and the useful version of
// no names what does the same job and where the hand-off is.
//
// WHY THIS IS ONE SENTENCE AND NOT A COMPARISON TABLE.
// A feature-by-feature comparison against a Microsoft product is a document
// that ages badly, reads as defensive, and is longer than the thing it is
// comparing. The person asking wants to know whether to keep the workbook open.
// One sentence answers that.
//
// WHY IT IS SHIPPED AT ALL RATHER THAN LEFT UNSAID.
// The gap is discoverable in about a minute, and the version discovered by
// accident costs more trust than the version that was written down. Naming a
// limit before someone finds it is the cheapest credibility available.
//
// Pure text. No DOM, no engine.

export const PQ_NOTE_KIND = 'dataglow-power-query-note';
export const PQ_NOTE_VERSION = 1;

/** The sentence. Verbatim wherever it appears. */
export const POWER_QUERY_NOTE =
  'Power Query M is not embedded. DataGlow covers reshape and clean via Excel Hell plus DuckDB SQL plus Python and R. For M-only enterprise workbooks, export remains the hand-off.';

export const POWER_QUERY_DETAIL =
  'M is a language with its own runtime and a connector library that reaches databases and services. None of that is here, and building a partial copy of it would produce something that runs some steps and silently skips others, which is worse than not having it.';

/**
 * Where the same work gets done instead.
 *
 * Each entry is a real surface in this product, named so the note is a
 * signpost rather than an apology.
 */
export const POWER_QUERY_EQUIVALENTS = Object.freeze([
  Object.freeze({
    step: 'Promote headers, remove blank rows, unmerge and fix types',
    here: 'Excel Hell Repair, which proposes each change and applies none until you confirm.',
  }),
  Object.freeze({
    step: 'Filter, group, join, pivot and unpivot',
    here: 'DuckDB SQL, which has PIVOT and UNPIVOT as statements rather than as a dialog.',
  }),
  Object.freeze({
    step: 'Custom columns and multi-step transforms',
    here: 'Python with pandas, or R, both running in the page.',
  }),
  Object.freeze({
    step: 'Applied steps you can re-run on next month\'s file',
    here: 'The saved repair methods library, which records the steps and replays them.',
  }),
  Object.freeze({
    step: 'Connectors to SQL Server, SharePoint, an API',
    here: 'Nothing. This product has no network data path by design, and Air-Gap mode makes that enforceable rather than promised.',
  }),
]);

/** The ceiling-group shape used by js/ai/capability-ceiling.js. */
export function powerQueryCeilingGroup() {
  return {
    id: 'power-query',
    title: 'Power Query',
    does: 'Reshape and clean the same data through Excel Hell Repair, DuckDB SQL, Python and R.',
    notThis: 'Run your Power Query M steps. The M runtime is not embedded and there is no plan for it to be.',
    detail: POWER_QUERY_NOTE + ' ' + POWER_QUERY_DETAIL,
  };
}

export function buildPowerQueryNote() {
  return {
    kind: PQ_NOTE_KIND,
    version: PQ_NOTE_VERSION,
    note: POWER_QUERY_NOTE,
    detail: POWER_QUERY_DETAIL,
    equivalents: POWER_QUERY_EQUIVALENTS,
    handoff: 'For a workbook whose logic only exists as M, the hand-off is an export: run the query in Excel, save the result, and bring that here.',
    claims: false,
  };
}

export const DataGlowPowerQueryNote = {
  PQ_NOTE_KIND,
  PQ_NOTE_VERSION,
  POWER_QUERY_NOTE,
  POWER_QUERY_DETAIL,
  POWER_QUERY_EQUIVALENTS,
  powerQueryCeilingGroup,
  buildPowerQueryNote,
};

try {
  if (typeof window !== 'undefined') window.DataGlowPowerQueryNote = DataGlowPowerQueryNote;
} catch (_e) {}
