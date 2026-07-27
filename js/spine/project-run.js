// ============================================================
// DATAGLOW - R1 Project Run: an in-app guided spine
// ============================================================
//
// R1 SPEC: "In-app guided spine: Ingest, Purpose, Validate, Scout, Prove,
// Narrate, Export. Not external chat orchestration."
//
// The RECEIPT spine (js/spine/receipt-spine.js) already names a five-step
// path -- Drop, Ask, Prove, Ship, Compound -- as a permanent rail across the
// bottom of the page. Project Run is a DIFFERENT surface answering a
// DIFFERENT question: not "where does this product begin" (every session,
// forever) but "did I finish THIS run, on THIS dataset, end to end". It is a
// checklist a person opens deliberately from Projects or a post-load
// spotlight, tracks todo/doing/done/blocked per step, and remembers where a
// specific dataset's run stood the next time that same dataset is loaded.
// The two surfaces do not replace each other and neither module imports the
// other.
//
// WHY SEVEN STEPS AND NOT THE RECEIPT SPINE'S FIVE.
// The RECEIPT spine's five steps are a generic shape (get data in, ask
// something, prove it, ship it, keep the method) meant to fit every session.
// R1 names the SPECIFIC path this product actually offers end to end: Ingest
// (load a file), Purpose (sign the purpose contract), Validate (look at the
// validation/readiness surfaces), Scout (get to at least one kept question),
// Prove (get at least one GREEN verdict), Narrate (draft the story), Export
// (produce an outbound artefact). A run can be "done" on the RECEIPT spine's
// Drop/Ask/Prove/Ship shape while still missing Purpose or Scout entirely,
// which is exactly the gap this checklist exists to name.
//
// WHY STATUS HAS FOUR WORDS AND NOT TWO.
// todo/done loses the difference between "have not started" and "started but
// stuck", and there is no honest way to guess "blocked" from evidence alone
// (nothing in this app fires an event that means "the user is stuck"), so
// `blocked` is the one status a caller sets explicitly rather than one this
// module infers. Every other status (todo/doing/done) is derived the same
// way the RECEIPT spine derives its states: from what the caller observed on
// screen, never from a stored counter that could drift from reality.
//
// WHY PERSISTENCE IS KEYED BY A HASH OF THE DATASET NAME.
// The checklist should survive a reload of the SAME dataset and should NOT
// leak or bleed into a different dataset loaded later in the same browser.
// A raw dataset name is a reasonable key by itself, but names collide easily
// ("data.csv", "export.csv") and can carry characters a caller may not want
// verbatim in a storage key. `hashDatasetKey` is a small deterministic
// string hash (FNV-1a, 32-bit, hex-encoded) -- NOT a cryptographic hash and
// never claimed as one -- good enough to turn any dataset name into a short,
// storage-key-safe, stable identifier. Two different names collide only by
// the ordinary birthday-bound chance of a 32-bit hash, which is an accepted
// and stated tradeoff for a client-only progress key, not a security
// boundary.
//
// Pure data plus pure helpers. No DOM, no timers, no network, no
// localStorage read/write in this file -- the canvas surface owns all
// browser-only I/O, exactly like receipt-spine.js/repair-ledger.js do.

export const PROJECT_RUN_KIND = 'dataglow-project-run';
export const PROJECT_RUN_VERSION = 1;

export const PROJECT_RUN_STATUSES = Object.freeze(['todo', 'doing', 'done', 'blocked']);

export const PROJECT_RUN_STORAGE_PREFIX = 'dataglow.projectRun.';

export const PROJECT_RUN_TITLE = 'Project Run';

export const PROJECT_RUN_DOCTRINE =
  'A run is not the five permanent steps of using this product. It is whether THIS file, THIS time, actually made it from a file on disk to something proven and sent out.';

/**
 * The seven steps of a Project Run, in the SPEC's fixed order. `signal` is a
 * short label for what "done" means, matched against the caller-observed
 * facts passed into buildProjectRun(). `opens` is an intent id, resolved by
 * the canvas surface against whatever is actually mounted in this build,
 * same convention as RECEIPT_STEPS' `opens`.
 */
export const PROJECT_RUN_STEPS = Object.freeze([
  Object.freeze({
    id: 'ingest',
    ordinal: 1,
    title: 'Ingest',
    oneLine: 'Load a file. Nothing is uploaded.',
    doneWhen: 'A table is loaded.',
    opens: 'open-file',
  }),
  Object.freeze({
    id: 'purpose',
    ordinal: 2,
    title: 'Purpose',
    oneLine: 'Say what this run is for before working the data.',
    doneWhen: 'The purpose contract is signed.',
    opens: 'open-purpose',
  }),
  Object.freeze({
    id: 'validate',
    ordinal: 3,
    title: 'Validate',
    oneLine: 'Look at what the data actually is before trusting it.',
    doneWhen: 'A validation or readiness surface has been viewed.',
    opens: 'open-validate',
  }),
  Object.freeze({
    id: 'scout',
    ordinal: 4,
    title: 'Scout',
    oneLine: 'Find at least one question worth keeping.',
    doneWhen: 'At least one keeper question is kept.',
    opens: 'open-scout',
  }),
  Object.freeze({
    id: 'prove',
    ordinal: 5,
    title: 'Prove',
    oneLine: 'Bind a number to the query that produced it.',
    doneWhen: 'At least one claim has a GREEN verdict.',
    opens: 'open-prove',
  }),
  Object.freeze({
    id: 'narrate',
    ordinal: 6,
    title: 'Narrate',
    oneLine: 'Draft the story once the numbers are proven.',
    doneWhen: 'A narrative draft exists.',
    opens: 'open-narrate',
  }),
  Object.freeze({
    id: 'export',
    ordinal: 7,
    title: 'Export',
    oneLine: 'Send it out, after you confirm.',
    doneWhen: 'An export was confirmed and produced.',
    opens: 'open-export',
  }),
]);

const STEP_IDS = Object.freeze(PROJECT_RUN_STEPS.map(s => s.id));

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function bool(v) {
  return v === true;
}

/**
 * FNV-1a, 32-bit, hex-encoded. Deterministic, dependency-free, and
 * synchronous (unlike the provenance module's sha256Hex, which is async via
 * crypto.subtle) -- chosen specifically so this file can stay pure and
 * synchronous. NOT cryptographic and never claimed as one; see the file
 * header for the stated collision tradeoff.
 * @param {string} input
 * @returns {string} 8 lowercase hex characters
 */
export function hashDatasetKey(input) {
  const s = typeof input === 'string' ? input : String(input == null ? '' : input);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned 32-bit, zero-padded to 8 hex chars.
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The full localStorage key for a given dataset name. Exported so the
 * canvas surface and tests use the exact same key derivation and never
 * drift apart. */
export function storageKeyForDataset(datasetName) {
  const name = typeof datasetName === 'string' && datasetName.trim() ? datasetName.trim() : 'untitled';
  return PROJECT_RUN_STORAGE_PREFIX + hashDatasetKey(name);
}

/**
 * Normalize an arbitrary persisted-status map into exactly the seven known
 * step ids, each holding a valid status. Malformed or missing input never
 * throws -- every step defaults to 'todo'. This is the one place that
 * decides what counts as a valid stored blob, so a corrupted localStorage
 * value degrades to a fresh checklist instead of crashing the panel.
 * @param {object} [stored] a previously-persisted { [stepId]: status } map
 */
export function normalizeStoredStatuses(stored) {
  const src = isPlainObject(stored) ? stored : {};
  const out = {};
  for (const id of STEP_IDS) {
    const v = src[id];
    out[id] = PROJECT_RUN_STATUSES.includes(v) ? v : 'todo';
  }
  return out;
}

/**
 * Derive each step's status from a blend of explicit manual overrides
 * (`blocked`, or a manual `doing`/`done` a person set by hand) and observed
 * facts. Auto-advance rule: an unblocked step already at 'todo' with its
 * done-signal true becomes 'done'; the first not-done, not-blocked step
 * becomes 'doing' (there is always at most one active step); everything
 * after it stays 'todo'. A step a caller has explicitly marked `blocked` is
 * left exactly as blocked regardless of signals -- a blocked step is a human
 * judgement this module never overrides on its own.
 *
 * @param {object} [input]
 * @param {object} [input.stored] previously-persisted { [stepId]: status }
 * @param {{
 *   hasTable?:boolean, purposeSigned?:boolean, validationViewed?:boolean,
 *   keepersCount?:number, proveGreenCount?:number, narrativeDraft?:boolean,
 *   exportDone?:boolean
 * }} [input.observed]
 */
export function buildProjectRun(input) {
  const inp = isPlainObject(input) ? input : {};
  const stored = normalizeStoredStatuses(inp.stored);
  const obs = isPlainObject(inp.observed) ? inp.observed : {};

  const doneSignal = {
    ingest: bool(obs.hasTable),
    purpose: bool(obs.purposeSigned),
    validate: bool(obs.validationViewed),
    scout: Number(obs.keepersCount || 0) >= 1,
    prove: Number(obs.proveGreenCount || 0) >= 1,
    narrate: bool(obs.narrativeDraft),
    'export': bool(obs.exportDone),
  };

  let doingAssigned = false;
  const steps = PROJECT_RUN_STEPS.map(step => {
    const manual = stored[step.id];
    let status;
    if (manual === 'blocked') {
      status = 'blocked';
    } else if (doneSignal[step.id]) {
      status = 'done';
    } else if (!doingAssigned) {
      status = 'doing';
      doingAssigned = true;
    } else {
      status = 'todo';
    }
    return {
      id: step.id,
      ordinal: step.ordinal,
      title: step.title,
      oneLine: step.oneLine,
      doneWhen: step.doneWhen,
      opens: step.opens,
      status,
      autoAdvanced: status === 'done' && manual !== 'done',
    };
  });

  const doneCount = steps.filter(s => s.status === 'done').length;
  const blockedCount = steps.filter(s => s.status === 'blocked').length;
  const current = steps.filter(s => s.status === 'doing')[0] || null;

  return {
    kind: PROJECT_RUN_KIND,
    version: PROJECT_RUN_VERSION,
    title: PROJECT_RUN_TITLE,
    steps,
    doneCount,
    blockedCount,
    total: steps.length,
    currentId: current ? current.id : '',
    complete: doneCount === steps.length,
    headline: current
      ? 'Next: ' + current.title + '. ' + current.oneLine
      : blockedCount > 0
        ? blockedCount + ' of ' + steps.length + ' step' + (blockedCount === 1 ? '' : 's') + ' blocked.'
        : doneCount === steps.length
          ? 'This run is complete, start to finish.'
          : 'Nothing started yet.',
    doctrine: PROJECT_RUN_DOCTRINE,
    observed: doneSignal,
  };
}

/** Persistable { [stepId]: status } map for a built run, so the canvas
 * surface can write back exactly what it read plus any manual change
 * without ever inventing a shape of its own. */
export function toStoredStatuses(run) {
  const out = {};
  if (!isPlainObject(run) || !Array.isArray(run.steps)) {
    for (const id of STEP_IDS) out[id] = 'todo';
    return out;
  }
  for (const step of run.steps) {
    if (STEP_IDS.includes(step.id)) out[step.id] = step.status;
  }
  for (const id of STEP_IDS) {
    if (!(id in out)) out[id] = 'todo';
  }
  return out;
}

/** Apply one manual status change (e.g. a person marking a step blocked, or
 * un-blocking it back to todo) and return a NEW stored-status map. Never
 * mutates its input. Rejects an unknown step id or status by returning the
 * input unchanged (normalized), matching this module's never-throw
 * discipline. */
export function setManualStatus(stored, stepId, status) {
  const base = normalizeStoredStatuses(stored);
  if (!STEP_IDS.includes(stepId) || !PROJECT_RUN_STATUSES.includes(status)) {
    return base;
  }
  return Object.assign({}, base, { [stepId]: status });
}

/** The step a person should do next, or null when there is none (either
 * everything is done, or everything remaining is blocked). */
export function nextStep(run) {
  if (!isPlainObject(run) || !Array.isArray(run.steps)) return null;
  return run.steps.filter(s => s.status === 'doing')[0] || null;
}

/** One line for a collapsed chip / entry point badge. */
export function projectRunChipLabel(run) {
  if (!isPlainObject(run)) return PROJECT_RUN_TITLE;
  return PROJECT_RUN_TITLE + ': ' + run.doneCount + ' of ' + run.total;
}

export const DataGlowProjectRun = {
  PROJECT_RUN_KIND,
  PROJECT_RUN_VERSION,
  PROJECT_RUN_STATUSES,
  PROJECT_RUN_STORAGE_PREFIX,
  PROJECT_RUN_TITLE,
  PROJECT_RUN_DOCTRINE,
  PROJECT_RUN_STEPS,
  hashDatasetKey,
  storageKeyForDataset,
  normalizeStoredStatuses,
  buildProjectRun,
  toStoredStatuses,
  setManualStatus,
  nextStep,
  projectRunChipLabel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowProjectRun = DataGlowProjectRun;
} catch (_e) {}
