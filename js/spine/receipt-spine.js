// ============================================================
// DATAGLOW - The RECEIPT spine: Drop, Ask, Prove, Ship, Compound
// ============================================================
//
// DataGlow has accumulated a great deal of real capability and no obvious way
// in. Someone opening it for the first time meets a row of tabs, each of which
// is a competent tool, and no indication of which one is the beginning. The
// product's actual shape is a sequence, and the sequence was never drawn.
//
// This module draws it. Five steps, in the order the work happens: get the data
// in, ask something of it, prove the answer, send the answer somewhere, and keep
// the method so the next month costs less than this one. That last step is the
// one people skip and it is the only one that compounds, which is why it is on
// the rail rather than buried in a menu.
//
// WHY A STEP IS NEVER MARKED DONE BY OPTIMISM.
// The rail reads its state from evidence the caller observed: a table is loaded,
// a query has run, the prove gate returned a verdict, an export was confirmed, a
// recipe was saved. Nothing is inferred from "the user clicked the tab", because
// a rail that ticks a step for opening a panel is a progress bar for a
// motivational app, not a description of what has happened to this data.
//
// WHY PROVE CANNOT BE MARKED DONE BY BEING SKIPPED.
// Every other step in this list can be reached by doing the previous one. Prove
// can be walked straight past: a query result is already on screen and copying
// it is one keystroke. So the rail treats an unproven answer as `skipped` rather
// than as untouched, and says so, because a step nobody visited and a step
// somebody bypassed on the way to an export are different facts.
//
// WHY THIS IS NOT A REDESIGN.
// Nothing here removes a tab, moves a control or hides a surface. The rail is
// one strip that names the path and points at surfaces that already exist. The
// larger question of what this product should look like is a different piece of
// work and this is deliberately not it.
//
// Pure data plus pure helpers. No DOM, no timers, no network. The canvas surface
// maps each step's `opens` id onto whatever is actually mounted in that build.

export const SPINE_KIND = 'dataglow-receipt-spine';
export const SPINE_VERSION = 1;

export const SPINE_STATES = Object.freeze(['done', 'current', 'todo', 'skipped']);

export const SPINE_DOCTRINE =
  'A receipt is the point. Every step here exists so the number you end up with can be traced back to the file it came from, by someone who was not in the room.';

export const SPINE_TITLE = 'Start here';

/**
 * The five steps.
 *
 * `opens` is an intent, not an element id. The canvas surface resolves it
 * against whatever is mounted, so a build without the Proof Board renders that
 * step as text rather than as a button that does nothing.
 */
export const RECEIPT_STEPS = Object.freeze([
  Object.freeze({
    id: 'drop',
    ordinal: 1,
    title: 'Drop',
    oneLine: 'Put a file in. Nothing is uploaded.',
    body: 'A CSV, an Excel workbook, a Parquet file. It is read by this page on your machine and it does not go anywhere. If the spreadsheet is a mess, the repair path is here too.',
    opens: 'open-file',
    also: 'fix-spreadsheet',
    alsoLabel: 'Fix a messy spreadsheet',
    doneWhen: 'A table is loaded.',
  }),
  Object.freeze({
    id: 'ask',
    ordinal: 2,
    title: 'Ask',
    oneLine: 'Ask in SQL, in plain English, or in Python or R.',
    body: 'Plain English is turned into SQL you can read before it runs. The generated query is the answer to how the number was produced, so it is shown rather than hidden.',
    opens: 'open-ask',
    doneWhen: 'A query has returned a result.',
  }),
  Object.freeze({
    id: 'prove',
    ordinal: 3,
    title: 'Prove',
    oneLine: 'Bind every number to the query that produced it.',
    body: 'The Proof Board holds one tile per number with its code underneath. The gate then refuses any claim containing a number that no tile and no engine result accounts for. Not checked is never shown as passed.',
    opens: 'open-proof-board',
    doneWhen: 'The prove gate has returned a verdict on a claim.',
  }),
  Object.freeze({
    id: 'ship',
    ordinal: 4,
    title: 'Ship',
    oneLine: 'Send it out with its proof attached, after you confirm.',
    body: 'A post draft, a hand-off pack for a BI tool, a receipt. Every outbound path asks you first and none of them can be automated, because a number that left without a person deciding is a number nobody owns.',
    opens: 'open-ship',
    doneWhen: 'An outbound artefact was confirmed and produced.',
  }),
  Object.freeze({
    id: 'compound',
    ordinal: 5,
    title: 'Compound',
    oneLine: 'Save the method so next month is cheaper than this month.',
    body: 'Repair steps, queries and checks can be saved and reapplied to the file you get next time. This is the step that turns an afternoon of work into a thing that runs again.',
    opens: 'open-compound',
    doneWhen: 'A recipe, saved query or reusable check exists.',
  }),
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function bool(v) {
  return v === true;
}

/**
 * Build the rail from observed facts.
 *
 * @param {{
 *   hasTable?:boolean, hasQueryResult?:boolean, proveRan?:boolean,
 *   hasShipped?:boolean, hasSavedMethod?:boolean
 * }} [input]
 */
export function buildReceiptSpine(input) {
  const inp = isPlainObject(input) ? input : {};
  const done = {
    drop: bool(inp.hasTable),
    ask: bool(inp.hasQueryResult),
    prove: bool(inp.proveRan),
    ship: bool(inp.hasShipped),
    compound: bool(inp.hasSavedMethod),
  };

  // Prove was skipped, not merely unvisited, if something was shipped without
  // the gate ever having run. That is the one ordering in this product that
  // actually matters, so it gets its own state rather than a softer word.
  const proveSkipped = !done.prove && done.ship;

  let currentAssigned = false;
  const steps = RECEIPT_STEPS.map(step => {
    let state;
    if (step.id === 'prove' && proveSkipped) {
      state = 'skipped';
    } else if (done[step.id]) {
      state = 'done';
    } else if (!currentAssigned) {
      state = 'current';
      currentAssigned = true;
    } else {
      state = 'todo';
    }
    return {
      id: step.id,
      ordinal: step.ordinal,
      title: step.title,
      oneLine: step.oneLine,
      body: step.body,
      opens: step.opens,
      also: step.also || '',
      alsoLabel: step.alsoLabel || '',
      doneWhen: step.doneWhen,
      state,
      note: state === 'skipped'
        ? 'Something was shipped before the gate ran on it. That is allowed and it is worth knowing.'
        : '',
    };
  });

  const doneCount = steps.filter(s => s.state === 'done').length;
  const current = steps.filter(s => s.state === 'current')[0] || null;

  return {
    kind: SPINE_KIND,
    version: SPINE_VERSION,
    title: SPINE_TITLE,
    steps,
    doneCount,
    total: steps.length,
    currentId: current ? current.id : '',
    proveSkipped,
    headline: current
      ? 'Next: ' + current.title + '. ' + current.oneLine
      : proveSkipped
        ? 'The path is complete apart from the proof, which was passed over.'
        : 'The whole path has been walked for this data.',
    doctrine: SPINE_DOCTRINE,
    observed: {
      hasTable: done.drop,
      hasQueryResult: done.ask,
      proveRan: done.prove,
      hasShipped: done.ship,
      hasSavedMethod: done.compound,
    },
  };
}

/** The step a person should do next, or null when there is none. */
export function nextStep(spine) {
  if (!isPlainObject(spine) || !Array.isArray(spine.steps)) return null;
  return spine.steps.filter(s => s.state === 'current')[0] || null;
}

/** One line for a collapsed rail. */
export function spineChipLabel(spine) {
  if (!isPlainObject(spine)) return SPINE_TITLE;
  return SPINE_TITLE + ': ' + spine.doneCount + ' of ' + spine.total;
}

export const DataGlowReceiptSpine = {
  SPINE_KIND,
  SPINE_VERSION,
  SPINE_STATES,
  SPINE_DOCTRINE,
  SPINE_TITLE,
  RECEIPT_STEPS,
  buildReceiptSpine,
  nextStep,
  spineChipLabel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowReceiptSpine = DataGlowReceiptSpine;
} catch (_e) {}
