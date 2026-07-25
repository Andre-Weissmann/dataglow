/**
 * Coach moments for the Proof Board: five short steps, as data.
 *
 * WHY THIS IS DATA AND NOT A TOUR LIBRARY.
 * A tour is usually a framework: an overlay, a backdrop, a step machine and a
 * scroll lock. All of that exists to hold attention, and holding attention is
 * the wrong goal for a person who opened a panel because they had a job to do.
 * These steps are a list of objects with a target element id. The surface points
 * at the thing and says one sentence. Nothing is dimmed, nothing is blocked, and
 * the panel stays fully usable with the strip open.
 *
 * WHY NO VIDEO.
 * A video means an asset, an asset means a CDN, and a CDN means the page reaches
 * the network. This product's whole claim is that it does not. Text next to the
 * control it is describing also survives being read at 360px, which a 16:9 clip
 * does not.
 *
 * WHY IT IS SEPARATE FROM js/flow/analyst-journey.js.
 * That module owns the four moments of the whole-app journey: landing, the drop,
 * the pulse read and the finish. Its moments are hard-coded to those points and
 * it publishes no way to register more, so a panel cannot add a step to it
 * without editing it. Rather than widen a working module to carry a second
 * unrelated concern, these steps stay local to the board and are shaped the same
 * way, so the two read as one product.
 *
 * Pure data plus small pure helpers. No DOM, no timers, no network.
 */

export const COACH_KIND = 'dataglow-proof-board-coach';
export const COACH_VERSION = 1;

/** Where the surface remembers that the strip was dismissed for good. */
export const COACH_SEEN_KEY = 'dataglow.proofBoard.coachSeen';

/**
 * The steps, in the order a person meets the surface.
 *
 * Each `target` is the id of a real element in the Proof Board panel. A step
 * whose target is missing is skipped rather than pointed at nothing, which is
 * what stepsForDom() below is for: a coach that highlights empty space is worse
 * than a coach that stays quiet.
 */
export const COACH_STEPS = Object.freeze([
  Object.freeze({
    id: 'what-this-is',
    title: 'Every number here shows its work',
    body: 'Each tile is one number with the query that produced it underneath. Nothing on this '
      + 'board is typed in by hand.',
    target: 'dg-pb-grid',
  }),
  Object.freeze({
    id: 'show-the-work',
    title: 'Open the proof',
    body: 'Show the work opens the code that produced that tile, exactly as it ran. It is read '
      + 'from the engine, never rewritten to look tidier.',
    target: 'dg-pb-grid',
  }),
  Object.freeze({
    id: 'badges-are-honest',
    title: 'Not checked is not the same as passed',
    body: 'A tile says Not checked when no gate has reported on it. It never turns green just '
      + 'because nothing went wrong.',
    target: 'dg-pb-grid',
  }),
  Object.freeze({
    id: 'verify-board',
    title: 'Verify the board',
    body: 'This checks the board is well formed: every tile has its code, its value and a check '
      + 'result. It does not re-run your queries, and it says so.',
    target: 'dg-pb-verify',
  }),
  Object.freeze({
    id: 'export-glowbook',
    title: 'Take it with you',
    body: 'Export Glowbook writes one HTML file to your device with every tile and every query '
      + 'in it. It asks first, and it never uploads.',
    target: 'dg-pb-export',
  }),
]);

function isFn(v) {
  return typeof v === 'function';
}

/**
 * The steps whose target actually exists right now.
 *
 * @param {function(string):boolean} hasElement - id to presence. Injected so this
 *   stays pure and Node-testable; the surface passes a document lookup.
 */
export function stepsForDom(hasElement) {
  if (!isFn(hasElement)) return COACH_STEPS.slice();
  const out = [];
  for (let i = 0; i < COACH_STEPS.length; i += 1) {
    let present = false;
    try {
      present = hasElement(COACH_STEPS[i].target) === true;
    } catch (_e) {
      present = false;
    }
    if (present) out.push(COACH_STEPS[i]);
  }
  return out;
}

/** Bounded step index, so a stale click cannot walk off either end. */
export function clampStep(index, total) {
  const n = Number.isFinite(total) ? total : COACH_STEPS.length;
  if (n <= 0) return 0;
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  if (i < 0) return 0;
  if (i > n - 1) return n - 1;
  return i;
}

/**
 * What the strip should show for a given position.
 *
 * @returns {{step:object, index:number, total:number, isFirst:boolean,
 *   isLast:boolean, progress:string, nextLabel:string}|null}
 */
export function coachStripModel(steps, index) {
  const list = Array.isArray(steps) && steps.length > 0 ? steps : COACH_STEPS.slice();
  if (list.length === 0) return null;
  const i = clampStep(index, list.length);
  const isLast = i === list.length - 1;
  return {
    step: list[i],
    index: i,
    total: list.length,
    isFirst: i === 0,
    isLast: isLast,
    progress: (i + 1) + ' of ' + list.length,
    nextLabel: isLast ? 'Done' : 'Next',
  };
}

/**
 * Whether to open the strip at all.
 *
 * Once dismissed it stays dismissed. A tip that returns every time the panel is
 * opened stops being a tip and becomes an obstacle, and the person who most
 * needs to get work done is the one who has opened the panel most often.
 *
 * @param {function(string):(string|null)} readFlag - storage reader, injected.
 */
export function shouldShowCoach(readFlag, flagOn) {
  if (flagOn === false) return false;
  if (!isFn(readFlag)) return true;
  let seen = null;
  try {
    seen = readFlag(COACH_SEEN_KEY);
  } catch (_e) {
    // Storage can be unavailable or refused. A coach strip is not worth failing
    // a panel over, so an unreadable flag is treated as never seen.
    return true;
  }
  return seen !== '1';
}

export const DataGlowProofBoardCoach = {
  COACH_KIND,
  COACH_VERSION,
  COACH_SEEN_KEY,
  COACH_STEPS,
  stepsForDom,
  clampStep,
  coachStripModel,
  shouldShowCoach,
};

try {
  if (typeof window !== 'undefined') window.DataGlowProofBoardCoach = DataGlowProofBoardCoach;
} catch (_e) { /* no window in Node tests */ }
