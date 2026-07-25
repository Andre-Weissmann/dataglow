// ============================================================
// DATAGLOW - GlassBox (pure engine)
// ============================================================
// WHY THIS EXISTS
// Guided Unpivot already got this right once. Under its result it offers a
// toggle labelled "DuckDB SQL (glass-box)" that reveals the exact SQL it is
// about to run (js/intelligence/data-glow-guided-unpivot-canvas.js line 243),
// so a person can check the machine's arithmetic instead of believing it. The
// Proof Drawer got it right a second time, in a different shape
// (js/trust/proof-drawer.js buildProofContent).
//
// Nowhere else does. A SQL result, a notebook output and a transform summary
// each show a finding with no way to see the work behind it, and each would
// need its own copy of the same idea. This module is the one model of that
// idea, so a surface can show the math by handing over what it already has.
//
// THE SHAPE, AND WHY IT IS THIS WAY AROUND
// finding first, proof underneath. The field order of the returned object is
// the reading order of the panel, and test/glass-box.test.mjs asserts it,
// because the moment proof floats above the answer the panel becomes a wall of
// code that people learn to scroll past.
//
// WHAT IT REFUSES TO DO
//   - It never writes the code it shows. If a surface has no source text, the
//     model says so and the panel shows an honest gap. A GlassBox that
//     reconstructed a plausible query would be worse than no GlassBox, because
//     it would be checkable and wrong.
//   - It never grades. Badges come from gates that already ran; a gate that
//     was not supplied is 'unknown', never 'good'. This is the same rule
//     js/gate/publish-safe.js holds about a check that could not run.
//   - It never runs anything. There is no export here that executes SQL or
//     code, and PUBLIC_API_SURFACE is asserted so a future edit cannot add one
//     quietly.
//
// PURITY: no DOM, no network, no storage, no imports. Node-testable in full.

export const GLASS_BOX_KIND = 'dataglow-glass-box';
export const GLASS_BOX_VERSION = 1;

export const GLASS_BOX_LANGUAGES = Object.freeze(['sql', 'python', 'r', 'text']);

export const GLASS_BOX_BADGE_LEVELS = Object.freeze(['good', 'warn', 'bad', 'unknown']);

/* A long query is worth showing; a thousand-line notebook cell is worth
   summarising. Sixty lines is roughly a screen on a laptop and two swipes on a
   phone, and the model always reports when it cut. */
export const GLASS_BOX_MAX_LINES = 60;

export const GLASS_BOX_DISCLAIMER =
  'This is the code that produced the result above, as it was run on this device. '
  + 'Reading it is the only way to be sure the result means what you think it means.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Cut long source down to a readable window, and say so.
 *
 * Cuts from the end rather than the middle: the first lines of a query are the
 * ones that say what it is selecting from, which is what a reader checks first.
 *
 * @param {string} source
 * @param {number} [maxLines]
 * @returns {{text:string, lineCount:number, truncated:boolean, shownLines:number}}
 */
export function truncateSource(source, maxLines = GLASS_BOX_MAX_LINES) {
  const text = str(source);
  if (!text) return { text: '', lineCount: 0, truncated: false, shownLines: 0 };
  const lines = text.replace(/\s+$/, '').split('\n');
  const limit = isNum(maxLines) && maxLines > 0 ? Math.floor(maxLines) : GLASS_BOX_MAX_LINES;
  if (lines.length <= limit) {
    return { text: lines.join('\n'), lineCount: lines.length, truncated: false, shownLines: lines.length };
  }
  return {
    text: lines.slice(0, limit).join('\n'),
    lineCount: lines.length,
    truncated: true,
    shownLines: limit,
  };
}

/* Every badge this engine knows how to render, keyed by the gate a surface may
   hand over. Each entry turns a gate's own result into one chip, and says why
   in words a reader can act on. A gate absent from the input never appears as
   a passing chip. */
const BADGE_BUILDERS = Object.freeze({
  sentinel(v) {
    if (!isPlainObject(v) || !Array.isArray(v.flags)) return null;
    const fails = v.flags.filter((f) => isPlainObject(f) && f.severity === 'fail').length;
    const warns = v.flags.filter((f) => isPlainObject(f) && f.severity === 'warn').length;
    if (fails > 0) {
      return { id: 'sentinel', label: 'Query Sentinel: ' + fails + ' to fix', level: 'bad',
        why: 'Query Sentinel found something that can change this number.' };
    }
    if (warns > 0) {
      return { id: 'sentinel', label: 'Query Sentinel: ' + warns + ' to read', level: 'warn',
        why: 'Query Sentinel found something worth a second look.' };
    }
    return { id: 'sentinel', label: 'Query Sentinel: clean', level: 'good',
      why: 'Query Sentinel found none of the mistakes it checks for.' };
  },
  gate(v) {
    if (!isPlainObject(v) || typeof v.agentConsumable !== 'boolean') return null;
    const score = isNum(v.score) ? ' ' + v.score + '/100' : '';
    return v.agentConsumable
      ? { id: 'gate', label: 'Readiness:' + (score || ' passed'), level: 'good',
        why: 'The readiness gate passed the data behind this.' }
      : { id: 'gate', label: 'Readiness: held back' + score, level: 'bad',
        why: 'The readiness gate is holding this back, so treat the result as provisional.' };
  },
  phi(v) {
    if (!isPlainObject(v) || typeof v.sensitiveFound !== 'boolean') return null;
    return v.sensitiveFound
      ? { id: 'phi', label: 'PHI Shield: matched', level: 'warn',
        why: 'PHI Shield matched something sensitive in view. Nothing was removed.' }
      : { id: 'phi', label: 'PHI Shield: clean', level: 'good',
        why: 'PHI Shield matched nothing it recognises as sensitive.' };
  },
  airGap(v) {
    if (!isPlainObject(v) || typeof v.active !== 'boolean') return null;
    return v.active
      ? { id: 'air-gap', label: 'Air-Gap: on', level: 'good',
        why: 'Nothing here can reach the network while Air-Gap Mode is on.' }
      : { id: 'air-gap', label: 'Air-Gap: off', level: 'unknown',
        why: 'Air-Gap Mode is off. Nothing here used the network, but the refusal is not armed.' };
  },
  publishSafe(v) {
    if (!isPlainObject(v) || typeof v.level !== 'string') return null;
    const map = { clear: 'good', caution: 'warn', blocked: 'bad' };
    return { id: 'publish-safe', label: 'Publish-Safe: ' + v.level, level: map[v.level] || 'unknown',
      why: 'Publish-Safe reached this verdict on handing the result over.' };
  },
});

/**
 * Turn whatever gates a surface has into chips, in a fixed order so the same
 * result never renders its badges in two different arrangements.
 *
 * @param {{sentinel?:object, gate?:object, phi?:object, airGap?:object, publishSafe?:object}} [gates]
 * @returns {Array<{id:string, label:string, level:string, why:string}>}
 */
export function glassBoxBadges(gates) {
  const bag = isPlainObject(gates) ? gates : {};
  const out = [];
  for (const key of ['sentinel', 'gate', 'phi', 'airGap', 'publishSafe']) {
    let chip = null;
    try {
      chip = BADGE_BUILDERS[key](bag[key]);
    } catch (_e) {
      chip = null; // a malformed gate result is a missing badge, not a crash
    }
    if (chip) out.push(chip);
  }
  return out;
}

const LEVEL_RANK = Object.freeze({ good: 0, unknown: 1, warn: 2, bad: 3 });

/**
 * Build the model a GlassBox panel renders.
 *
 * Never throws: a surface asking to show its math must not be able to break the
 * surface by asking badly.
 *
 * @param {{
 *   surface?: string,
 *   headline?: string,
 *   detail?: string,
 *   language?: string,
 *   source?: string,
 *   engine?: string,
 *   gates?: object,
 *   maxLines?: number
 * }} [input] - `source` is the actual SQL or code as it ran, read from the
 *   surface. `engine` is the thing that ran it, named for a human.
 * @returns {{kind:string, version:number, surface:string,
 *   finding:{headline:string, detail:string},
 *   math:{available:boolean, language:string, engine:string, source:string,
 *     lineCount:number, shownLines:number, truncated:boolean},
 *   badges:Array, missing:Array<{what:string, why:string}>,
 *   level:string, disclaimer:string}}
 */
export function buildGlassBox(input = {}) {
  const bag = isPlainObject(input) ? input : {};
  const language = GLASS_BOX_LANGUAGES.includes(bag.language) ? bag.language : 'text';
  const cut = truncateSource(bag.source, bag.maxLines);
  const badges = glassBoxBadges(bag.gates);
  const missing = [];

  if (!cut.text) {
    missing.push({
      what: 'the code',
      why: 'This surface did not hand over the code it ran, so there is nothing to check here. '
        + 'Nothing has been reconstructed: a guessed query would look checkable and be wrong.',
    });
  }
  if (badges.length === 0) {
    missing.push({
      what: 'the gates',
      why: 'No check has reported on this yet, so there is no badge to show. That is an absence '
        + 'of evidence, not a clean result.',
    });
  }

  let level = 'good';
  for (const b of badges) {
    if ((LEVEL_RANK[b.level] || 0) > (LEVEL_RANK[level] || 0)) level = b.level;
  }
  if (badges.length === 0) level = 'unknown';

  // Field order is reading order: finding, then the math, then the badges, then
  // what is missing. Asserted in test/glass-box.test.mjs.
  return {
    kind: GLASS_BOX_KIND,
    version: GLASS_BOX_VERSION,
    surface: str(bag.surface) || 'this result',
    finding: {
      headline: str(bag.headline) || 'This is the result the code below produced.',
      detail: str(bag.detail),
    },
    math: {
      available: cut.text.length > 0,
      language,
      engine: str(bag.engine) || 'this device',
      source: cut.text,
      lineCount: cut.lineCount,
      shownLines: cut.shownLines,
      truncated: cut.truncated,
    },
    badges,
    missing,
    level,
    disclaimer: GLASS_BOX_DISCLAIMER,
  };
}

/**
 * The same model as plain text, for a copy button or a saved file. What a user
 * copies is therefore what a test reads.
 * @param {ReturnType<typeof buildGlassBox>} model
 * @returns {string}
 */
export function renderGlassBoxText(model) {
  if (!isPlainObject(model) || !isPlainObject(model.finding)) return 'No math to show.';
  const lines = [model.finding.headline];
  if (model.finding.detail) lines.push(model.finding.detail);
  lines.push('');
  if (model.math && model.math.available) {
    lines.push('Ran by: ' + model.math.engine + ' (' + model.math.language + ')');
    if (model.math.truncated) {
      lines.push('Showing the first ' + model.math.shownLines + ' of ' + model.math.lineCount + ' lines.');
    }
    lines.push('', model.math.source, '');
  }
  if (Array.isArray(model.badges) && model.badges.length > 0) {
    lines.push('Checks:');
    for (const b of model.badges) lines.push('- ' + b.label + '. ' + b.why);
    lines.push('');
  }
  if (Array.isArray(model.missing) && model.missing.length > 0) {
    lines.push('Not shown:');
    for (const m of model.missing) lines.push('- ' + m.what + ': ' + m.why);
    lines.push('');
  }
  lines.push(model.disclaimer || GLASS_BOX_DISCLAIMER);
  return lines.join('\n');
}

/**
 * The label for the toggle that opens a GlassBox, so every surface uses the
 * same words. Guided Unpivot's existing toggle says "glass-box"; this keeps
 * that vocabulary while saying plainly what pressing it does.
 * @param {ReturnType<typeof buildGlassBox>} model
 * @returns {string}
 */
export function glassBoxToggleLabel(model) {
  if (isPlainObject(model) && isPlainObject(model.math) && model.math.available) {
    const lang = model.math.language === 'sql' ? 'SQL' : model.math.language;
    return 'Show the math (' + lang + ')';
  }
  return 'Show the math';
}

/* Explicit, testable proof that this engine only ever describes: nothing here
   runs, writes or applies anything, and test/glass-box.test.mjs asserts this
   list stays exactly this shape. */
export const PUBLIC_API_SURFACE = Object.freeze([
  'truncateSource',
  'glassBoxBadges',
  'buildGlassBox',
  'renderGlassBoxText',
  'glassBoxToggleLabel',
]);

export const DataGlowGlassBox = {
  GLASS_BOX_KIND,
  GLASS_BOX_VERSION,
  GLASS_BOX_LANGUAGES,
  GLASS_BOX_BADGE_LEVELS,
  GLASS_BOX_MAX_LINES,
  GLASS_BOX_DISCLAIMER,
  PUBLIC_API_SURFACE,
  truncateSource,
  glassBoxBadges,
  buildGlassBox,
  renderGlassBoxText,
  glassBoxToggleLabel,
};

// Same publication pattern as js/gate/publish-safe.js: the canvas surface reads
// the namespace off window because its inlined copy has no module scope.
try {
  if (typeof window !== 'undefined') window.DataGlowGlassBoxEngine = DataGlowGlassBox;
} catch (_e) { /* no window in Node tests */ }
