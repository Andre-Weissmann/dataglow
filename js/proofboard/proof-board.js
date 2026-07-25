/**
 * Proof Board: several numbers on one surface, each with its own proof under it.
 *
 * WHY THIS IS NOT A DASHBOARD.
 * A dashboard shows numbers. The reason a dashboard gets argued with in a meeting
 * is that the number is the whole artifact: there is nowhere to look to find out
 * how it was computed, so the conversation becomes about whether the person who
 * made it is trustworthy. The Proof Board puts the query that produced each
 * number directly underneath it, in the same tile, so the question "where did
 * this come from" is answered before it is asked.
 *
 * WHY THE BADGE HAS FOUR VALUES AND NOT TWO.
 * The tempting design is a green tick or nothing. That quietly turns "no check
 * has run" into "this passed", which is the single most expensive lie a surface
 * like this can tell. `unknown` is therefore a first-class badge with its own
 * wording, and it can never be promoted to `clear` by the absence of a problem.
 * A tile with no gate result says out loud that nothing has checked it.
 *
 * WHY A BAD TILE IS KEPT RATHER THAN DROPPED.
 * buildProofBoard() never throws and never silently discards. A caller that
 * hands over a malformed tile gets it back marked incomplete, with the reasons
 * listed. Dropping it would leave a board that looks complete and is missing a
 * number, and a missing tile is much harder to notice than a tile that says what
 * is wrong with it.
 *
 * WHY VALUES ARE NEVER SYNTHESISED.
 * There is no default value, no zero fallback and no placeholder number anywhere
 * in this module. A tile whose value did not arrive is incomplete. Showing 0 for
 * a number that was never computed is inventing a KPI, which is exactly what
 * this surface exists to make impossible.
 *
 * Pure ES module: no DOM, no network, no timers, so it runs identically in Node
 * and with Air-Gap Mode on. The GlassBox model is not re-implemented here; it is
 * composed from js/glassbox/glass-box.js, so proof renders the same way on this
 * surface as on every other one.
 */
import { buildGlassBox } from '../glassbox/glass-box.js';

export const PROOF_BOARD_KIND = 'dataglow-proof-board';
export const PROOF_BOARD_VERSION = 1;

/**
 * The gate badges a tile may carry. `unknown` is the default and is never
 * upgraded by this module: only a real gate result can move a tile off it.
 */
export const TILE_GATE_BADGES = Object.freeze(['clear', 'caution', 'blocked', 'unknown']);

/** How a tile badge maps onto the GlassBox level vocabulary. */
export const BADGE_TO_GLASS_LEVEL = Object.freeze({
  clear: 'good',
  caution: 'warn',
  blocked: 'bad',
  unknown: 'unknown',
});

/** Plain wording for each badge, so two surfaces cannot describe one state differently. */
export const BADGE_LABELS = Object.freeze({
  clear: 'Checks passed',
  caution: 'Passed with cautions',
  blocked: 'Blocked by a check',
  unknown: 'Not checked',
});

export const BADGE_WHY = Object.freeze({
  clear: 'A check ran on this number and found nothing to raise.',
  caution: 'A check ran and raised something worth reading before this number is used.',
  blocked: 'A check refused this number. Read the reason before using it anywhere.',
  unknown: 'No check has reported on this number. That is an absence of evidence, not a pass.',
});

export const PROOF_BOARD_LANGUAGES = Object.freeze(['sql', 'python', 'r', 'text']);

export const PROOF_BOARD_DISCLAIMER =
  'This board shows the code that produced each number. It is a record of how the '
  + 'numbers were computed on this device, not a certification, not an audit, and not '
  + 'legal or clinical advice.';

export const EMPTY_BOARD_HEADLINE = 'No data is loaded, so there is nothing to prove yet.';
export const EMPTY_BOARD_CTA = 'Load a file to build a board from real numbers.';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * A value is only present if it actually arrived. Empty string, null, undefined
 * and NaN are all absent, because each of them renders as something that looks
 * like a number was computed when none was.
 */
export function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'boolean') return true;
  return false;
}

/** The value exactly as it arrived, formatted for reading but never invented. */
export function formatTileValue(value, unit) {
  if (!hasValue(value)) return '';
  let text;
  if (typeof value === 'number') {
    text = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  } else {
    text = String(value).trim();
  }
  const u = str(unit);
  return u ? text + ' ' + u : text;
}

/**
 * Normalize one tile, listing what is wrong rather than throwing.
 *
 * @param {object} tile
 * @param {number} index - position in the supplied list, used to name a tile that
 *   arrived with no id, so two nameless tiles cannot collide.
 * @returns {{id:string, title:string, value:*, valueText:string, unit:string,
 *   sqlOrCode:string, language:string, engine:string, gateBadge:string,
 *   badgeLabel:string, badgeWhy:string, checksSummary:string,
 *   datasetFingerprint:string, sourceCols:Array<string>,
 *   complete:boolean, problems:Array<string>}}
 */
export function normalizeTile(tile, index) {
  const bag = isPlainObject(tile) ? tile : {};
  const problems = [];

  const id = str(bag.id) || ('tile-' + (Number.isFinite(index) ? index + 1 : 1));
  const title = str(bag.title);
  if (!title) problems.push('This tile has no title, so there is no way to say what the number is.');

  const value = hasValue(bag.value) ? bag.value : null;
  if (value === null) {
    problems.push('No value arrived for this tile. It is shown empty rather than as a zero, '
      + 'because a zero here would be a number nobody computed.');
  }

  const sqlOrCode = typeof bag.sqlOrCode === 'string' ? bag.sqlOrCode : '';
  if (!sqlOrCode.trim()) {
    problems.push('This tile did not hand over the code that produced it, so there is nothing '
      + 'to check underneath it.');
  }

  const language = PROOF_BOARD_LANGUAGES.indexOf(bag.language) >= 0 ? bag.language : 'text';

  // The badge is read off a real gate result when one was supplied, and only
  // falls back to the caller's own word for it otherwise. A caller cannot label a
  // tile `clear` while handing over a blocked verdict.
  const gates = isPlainObject(bag.gates) ? bag.gates : null;
  const fromGate = gates && isPlainObject(gates.publishSafe) && typeof gates.publishSafe.level === 'string'
    ? gates.publishSafe.level
    : '';
  let gateBadge = 'unknown';
  if (TILE_GATE_BADGES.indexOf(fromGate) >= 0) {
    gateBadge = fromGate;
    if (TILE_GATE_BADGES.indexOf(bag.gateBadge) >= 0 && bag.gateBadge !== fromGate) {
      problems.push('This tile was labelled ' + bag.gateBadge + ' but the gate result on it says '
        + fromGate + '. The gate result is what is shown.');
    }
  } else if (TILE_GATE_BADGES.indexOf(bag.gateBadge) >= 0) {
    gateBadge = bag.gateBadge;
  }

  let sourceCols = [];
  if (Array.isArray(bag.sourceCols)) {
    sourceCols = bag.sourceCols.map(str).filter(Boolean);
  }

  return {
    id: id,
    title: title,
    value: value,
    valueText: formatTileValue(value, bag.unit),
    unit: str(bag.unit),
    sqlOrCode: sqlOrCode,
    language: language,
    engine: str(bag.engine) || 'this device',
    gateBadge: gateBadge,
    badgeLabel: BADGE_LABELS[gateBadge],
    badgeWhy: BADGE_WHY[gateBadge],
    checksSummary: str(bag.checksSummary),
    datasetFingerprint: str(bag.datasetFingerprint),
    sourceCols: sourceCols,
    gates: gates || {},
    complete: problems.length === 0,
    problems: problems,
  };
}

/**
 * The GlassBox model for one tile: the number on top, the code underneath.
 *
 * The model is not built here. It is delegated to js/glassbox/glass-box.js so
 * that proof on this board is the same object, in the same field order, with the
 * same disclaimer, as proof anywhere else in DataGlow. This function's whole job
 * is the mapping from a tile onto that contract.
 *
 * Only real gate results are handed to GlassBox. The tile's own badge is
 * deliberately NOT forged into a gate here: a badge is the board's one word
 * summary, and passing it off as a gate verdict would put a chip on the proof
 * panel that no gate ever produced. A tile with no gate result therefore shows
 * GlassBox reporting the absence, which is the honest rendering.
 *
 * @param {object} tile - raw or already normalized
 * @param {function} [glassBoxImpl] - injected for the canvas, which reads the
 *   engine off window rather than importing it. Defaults to the imported one.
 * @returns {object} GlassBox model
 */
export function buildTileGlassBox(tile, glassBoxImpl) {
  const t = tile && tile.complete !== undefined ? tile : normalizeTile(tile, 0);
  const build = typeof glassBoxImpl === 'function' ? glassBoxImpl : buildGlassBox;

  const headline = t.title
    ? (t.valueText ? t.title + ': ' + t.valueText : t.title + ': no value arrived')
    : 'This tile has no title.';

  const detailParts = [];
  if (t.checksSummary) detailParts.push(t.checksSummary);
  if (t.sourceCols.length > 0) detailParts.push('Columns used: ' + t.sourceCols.join(', ') + '.');
  if (t.datasetFingerprint) detailParts.push('Dataset fingerprint ' + t.datasetFingerprint + '.');
  for (let i = 0; i < t.problems.length; i += 1) detailParts.push(t.problems[i]);

  return build({
    surface: 'Proof Board tile ' + (t.title || t.id),
    headline: headline,
    detail: detailParts.join(' '),
    language: t.language,
    source: t.sqlOrCode,
    engine: t.engine,
    gates: t.gates,
  });
}

/**
 * Build the whole board. Never throws.
 *
 * @param {Array<object>} tiles
 * @param {{datasetName?:string, rowCount?:number, columnCount?:number,
 *   generatedAt?:number, trustLedgerSummary?:string, datasetFingerprint?:string}} [sessionMeta]
 * @returns {object} board model
 */
export function buildProofBoard(tiles, sessionMeta) {
  const meta = isPlainObject(sessionMeta) ? sessionMeta : {};
  const list = Array.isArray(tiles) ? tiles : [];

  const out = [];
  const seen = {};
  for (let i = 0; i < list.length; i += 1) {
    const t = normalizeTile(list[i], i);
    // Two tiles answering to one id would make the receipt and the export
    // disagree about which number they described.
    if (Object.prototype.hasOwnProperty.call(seen, t.id)) {
      t.id = t.id + '-' + (i + 1);
      t.problems = t.problems.concat(['Another tile already used this id, so this one was renamed.']);
      t.complete = false;
    }
    seen[t.id] = true;
    out.push(t);
  }

  let complete = 0;
  let blocked = 0;
  let unchecked = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].complete) complete += 1;
    if (out[i].gateBadge === 'blocked') blocked += 1;
    if (out[i].gateBadge === 'unknown') unchecked += 1;
  }

  const empty = out.length === 0;

  return {
    kind: PROOF_BOARD_KIND,
    version: PROOF_BOARD_VERSION,
    generatedAt: Number.isFinite(meta.generatedAt) ? meta.generatedAt : 0,
    datasetName: str(meta.datasetName),
    datasetFingerprint: str(meta.datasetFingerprint),
    rowCount: Number.isFinite(meta.rowCount) ? meta.rowCount : null,
    columnCount: Number.isFinite(meta.columnCount) ? meta.columnCount : null,
    trustLedgerSummary: str(meta.trustLedgerSummary),
    tiles: out,
    stats: {
      total: out.length,
      complete: complete,
      incomplete: out.length - complete,
      blocked: blocked,
      unchecked: unchecked,
    },
    empty: empty,
    emptyState: empty ? { headline: EMPTY_BOARD_HEADLINE, cta: EMPTY_BOARD_CTA } : null,
    disclaimer: PROOF_BOARD_DISCLAIMER,
  };
}

/**
 * One honest sentence about the board.
 *
 * It leads with what is not proven rather than with the count of tiles, because
 * the count of tiles is the number a person already knows by looking.
 */
export function summarizeBoard(board) {
  if (!isPlainObject(board) || !Array.isArray(board.tiles)) return 'No board to describe.';
  if (board.empty) return EMPTY_BOARD_HEADLINE;
  const s = board.stats;
  const parts = [s.total + (s.total === 1 ? ' tile' : ' tiles')];
  if (s.unchecked > 0) parts.push(s.unchecked + ' with no check reported');
  if (s.blocked > 0) parts.push(s.blocked + ' blocked by a check');
  if (s.incomplete > 0) parts.push(s.incomplete + ' incomplete');
  if (parts.length === 1) parts.push('every one carrying its code and a check result');
  return parts.join(', ') + '.';
}

/**
 * The board-level verify pass.
 *
 * This deliberately does not re-run any query. It checks the things that can
 * actually be checked from what the board holds, and names the things it cannot
 * check, because a "Verified" stamp covering work that was never done is worse
 * than no stamp. Recomputation would need the dataset and the engine, which this
 * pure module does not have and should not reach for.
 *
 * @returns {{ok:boolean, checked:Array<{what:string, pass:boolean, note:string}>,
 *   cannotCheck:Array<string>, headline:string}}
 */
export function verifyBoard(board) {
  const checked = [];
  const cannotCheck = [
    'Whether each query still returns the number shown. That needs the dataset and the '
      + 'engine, and re-running here would report a fresh number as if it were the recorded one.',
    'Whether the numbers are the right numbers to be looking at. No check can answer that.',
  ];

  if (!isPlainObject(board) || !Array.isArray(board.tiles)) {
    return { ok: false, checked: checked, cannotCheck: cannotCheck, headline: 'There is no board to verify.' };
  }

  const tiles = board.tiles;
  const withCode = tiles.filter(function (t) { return t.sqlOrCode && t.sqlOrCode.trim(); }).length;
  checked.push({
    what: 'Every tile carries the code that produced it',
    pass: tiles.length > 0 && withCode === tiles.length,
    note: withCode + ' of ' + tiles.length + ' tiles handed over their code.',
  });

  const withValue = tiles.filter(function (t) { return hasValue(t.value); }).length;
  checked.push({
    what: 'Every tile carries a value that was actually computed',
    pass: tiles.length > 0 && withValue === tiles.length,
    note: withValue + ' of ' + tiles.length + ' tiles arrived with a value. Empty is shown as '
      + 'empty and never as zero.',
  });

  const ids = {};
  let dupes = 0;
  for (let i = 0; i < tiles.length; i += 1) {
    if (Object.prototype.hasOwnProperty.call(ids, tiles[i].id)) dupes += 1;
    ids[tiles[i].id] = true;
  }
  checked.push({
    what: 'Tile ids are unique',
    pass: dupes === 0,
    note: dupes === 0 ? 'No two tiles share an id.' : dupes + ' tile id(s) collided and were renamed.',
  });

  const unchecked = tiles.filter(function (t) { return t.gateBadge === 'unknown'; }).length;
  checked.push({
    what: 'Every tile has a gate result',
    pass: tiles.length > 0 && unchecked === 0,
    note: unchecked === 0
      ? 'Every tile carries a check result.'
      : unchecked + ' tile(s) have no check reported. They are marked not checked, not passed.',
  });

  const fingerprints = {};
  for (let i = 0; i < tiles.length; i += 1) {
    if (tiles[i].datasetFingerprint) fingerprints[tiles[i].datasetFingerprint] = true;
  }
  const distinct = Object.keys(fingerprints).length;
  checked.push({
    what: 'Tiles describe one dataset',
    pass: distinct <= 1,
    note: distinct <= 1
      ? 'All tiles that named a dataset named the same one.'
      : distinct + ' different datasets are mixed on this board, so the numbers are not comparable.',
  });

  const ok = checked.every(function (c) { return c.pass; });
  const failed = checked.filter(function (c) { return !c.pass; }).length;
  return {
    ok: ok,
    checked: checked,
    cannotCheck: cannotCheck,
    headline: ok
      ? 'All ' + checked.length + ' board checks passed. This says the board is well formed, '
        + 'not that the numbers are right.'
      : failed + ' of ' + checked.length + ' board checks did not pass.',
  };
}

/**
 * What a tile receipt should be stamped over.
 *
 * The receipt itself is minted by js/provenance/portable-receipt.js or recorded
 * on the Trust Ledger. This only assembles the claim, so no hashing or crypto is
 * written here or anywhere in this bundle.
 */
export function tileReceiptClaim(tile, board) {
  const t = tile && tile.complete !== undefined ? tile : normalizeTile(tile, 0);
  const b = isPlainObject(board) ? board : {};
  return {
    claim: {
      label: t.title || t.id,
      value: t.valueText,
      statement: (t.title || t.id) + (t.valueText ? ' is ' + t.valueText : ' has no value recorded'),
    },
    queryOrTransformChain: t.sqlOrCode ? [{ step: 'proof-board-tile', language: t.language, source: t.sqlOrCode }] : [],
    validationStateAtCompute: { grade: t.gateBadge, summary: t.checksSummary || t.badgeWhy },
    datasetFingerprint: t.datasetFingerprint || str(b.datasetFingerprint),
  };
}

export const DataGlowProofBoard = {
  PROOF_BOARD_KIND,
  PROOF_BOARD_VERSION,
  TILE_GATE_BADGES,
  BADGE_TO_GLASS_LEVEL,
  BADGE_LABELS,
  BADGE_WHY,
  PROOF_BOARD_LANGUAGES,
  PROOF_BOARD_DISCLAIMER,
  EMPTY_BOARD_HEADLINE,
  EMPTY_BOARD_CTA,
  hasValue,
  formatTileValue,
  normalizeTile,
  buildTileGlassBox,
  buildProofBoard,
  summarizeBoard,
  verifyBoard,
  tileReceiptClaim,
};

try {
  if (typeof window !== 'undefined') window.DataGlowProofBoard = DataGlowProofBoard;
} catch (_e) { /* no window in Node tests */ }
