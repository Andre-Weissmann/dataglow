// ============================================================
// DATAGLOW - Proof to Post
// ============================================================
//
// The loop this closes: analyze locally, prove on the Proof Board, publish a
// Glowbook or a portfolio page, then post about it. The last step is where
// analysts normally lose the proof. A number that survived a query engine, a
// validation gate and a receipt chain gets retyped into a social post by hand,
// and at that moment it becomes a number with nothing behind it.
//
// So the draft here is not written by a human and then checked. It is assembled
// from tiles, which means every number in it came out of an engine by
// construction, and then it is checked anyway by the prove gate, because
// assembly can still go wrong and a post is not something you can recall.
//
// WHY THERE IS NO POST BUTTON.
// `NEVER_AUTO_POST` is a constant, not a setting. DataGlow has no server and no
// outbound network, and an OAuth posting integration would need both. Beyond
// the architecture, a tool that can post on your behalf is a tool that can post
// something you did not read. The output is text on a clipboard. The last
// action is always a human pasting it somewhere.
//
// WHY THE TRANSPARENCY LINE IS COMPUTED AND NOT A STRING.
// "Numbers engine-checked" is a claim about the work, and it is false if any
// tile in the post is carrying the `unknown` badge. Writing that sentence as a
// fixed constant would make the post lie about its own rigour in exactly the
// case where the reader most needs to know. So the line is derived from the
// badges actually present.
//
// Pure. No DOM, no network, no clipboard. Rendering and confirming belong to
// the canvas surface.

import { formatTileValue, hasValue } from '../proofboard/proof-board.js';
import { clampStep, coachStripModel } from '../proofboard/coach-moments.js';
import { assertClaimAllowed, describeGateResult } from '../ai/prove-gate.js';

export const PROOF_TO_POST_KIND = 'dataglow-proof-to-post';
export const PROOF_TO_POST_VERSION = 1;

/** Not a preference. See the header. */
export const NEVER_AUTO_POST = true;

export const MAX_BULLETS = 5;

export const METHOD_LINE =
  'Method: every number above was produced by a query in DataGlow, and the query is shown next to the number it produced.';

export const TRANSPARENCY_CHECKED =
  'Analyzed locally in DataGlow. Every number here was checked by an engine, and the code that produced it travels with it.';

export const TRANSPARENCY_PARTIAL =
  'Analyzed locally in DataGlow. Every number here was produced by a query that travels with it. Not every number has had a separate check reported on it.';

export const POST_DISCLAIMER =
  'This draft is text for a person to read, edit and paste. DataGlow does not post it, does not send it anywhere, and has no account connected to any network.';

export const EMPTY_POST_HEADLINE =
  'There is nothing to post yet, because nothing has been proved yet.';

export const EMPTY_POST_CTA =
  'Load a file and build a Proof Board first. The post is assembled from the tiles, so there is no draft without them.';

function str(v) {
  return typeof v === 'string' ? v : '';
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Accept a board object or a bare tile array, so callers do not have to care. */
export function tilesOf(boardOrTiles) {
  if (Array.isArray(boardOrTiles)) return boardOrTiles.filter(isPlainObject);
  if (isPlainObject(boardOrTiles) && Array.isArray(boardOrTiles.tiles)) {
    return boardOrTiles.tiles.filter(isPlainObject);
  }
  return [];
}

/** Tiles that can carry a number into a post. A tile with no value is not a
 *  weaker bullet, it is not a bullet at all. */
export function postableTiles(boardOrTiles) {
  return tilesOf(boardOrTiles).filter(t => hasValue(t.value) && str(t.gateBadge) !== 'blocked');
}

/** Tiles deliberately left out, with the reason, so the surface can say why a
 *  number the user can see on the board is missing from the draft. */
export function excludedTiles(boardOrTiles) {
  const out = [];
  for (const t of tilesOf(boardOrTiles)) {
    if (!hasValue(t.value)) {
      out.push({ id: str(t.id), title: str(t.title), why: 'This tile has no value, so there is no number to quote.' });
    } else if (str(t.gateBadge) === 'blocked') {
      out.push({ id: str(t.id), title: str(t.title), why: 'A check blocked this number. Quoting it would publish a known problem.' });
    }
  }
  return out;
}

export function bulletForTile(tile) {
  const text = formatTileValue(tile && tile.value, tile && tile.unit);
  const title = str(tile && tile.title).trim();
  if (!text) return '';
  return title ? title + ': ' + text : text;
}

function transparencyFor(tiles) {
  const anyUnchecked = tiles.some(t => {
    const b = str(t.gateBadge);
    return b === '' || b === 'unknown';
  });
  return anyUnchecked ? TRANSPARENCY_PARTIAL : TRANSPARENCY_CHECKED;
}

/**
 * Assemble the LinkedIn draft. Numbers come from tiles and nowhere else; the
 * caller may supply a title and a closing line, and neither is allowed to
 * smuggle a number past the gate because the whole assembled text is validated.
 */
export function buildLinkedInDraft(boardOrTiles, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const tiles = postableTiles(boardOrTiles).slice(0, MAX_BULLETS);
  const bullets = tiles.map(bulletForTile).filter(b => b !== '');
  const title = str(options.title).trim() || 'What I found in this dataset';
  const closing = str(options.closing).trim();
  const includeTransparency = options.includeTransparency !== false;
  const transparencyLine = includeTransparency ? transparencyFor(tiles) : '';

  const lines = [title, ''];
  for (const b of bullets) lines.push('- ' + b);
  if (bullets.length) lines.push('');
  lines.push(METHOD_LINE);
  if (transparencyLine) lines.push(transparencyLine);
  if (closing) {
    lines.push('');
    lines.push(closing);
  }

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const problems = [];
  if (!bullets.length) problems.push(EMPTY_POST_HEADLINE);

  return {
    kind: PROOF_TO_POST_KIND,
    version: PROOF_TO_POST_VERSION,
    neverAutoPost: NEVER_AUTO_POST,
    title,
    bullets,
    methodLine: METHOD_LINE,
    transparencyLine,
    closing,
    text,
    tileIds: tiles.map(t => str(t.id)),
    problems,
    disclaimer: POST_DISCLAIMER,
  };
}

/**
 * Every numeric claim in the draft must bind to a tile. This runs the same gate
 * the AI narrative paths run, on the final assembled string rather than on the
 * pieces, because the pieces are not what gets pasted.
 */
export function validateLinkedInDraft(draft, boardOrTiles, opts) {
  const text = isPlainObject(draft) ? str(draft.text) : str(draft);
  const gate = assertClaimAllowed(text, tilesOf(boardOrTiles), opts);
  const problems = gate.reasons.slice();
  if (isPlainObject(draft) && Array.isArray(draft.problems)) {
    for (const p of draft.problems) if (str(p)) problems.push(str(p));
  }
  return {
    ok: gate.allowed && (!isPlainObject(draft) || !draft.problems || draft.problems.length === 0),
    gate,
    summary: describeGateResult(gate),
    cautions: gate.cautions,
    problems,
  };
}

/** A portfolio page in markdown. Same rule: numbers only from tiles. */
export function buildPortfolioMarkdown(boardOrTiles, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const tiles = postableTiles(boardOrTiles);
  const title = str(options.title).trim() || 'Analysis write-up';
  const recommendation = str(options.recommendation).trim();
  const narrative = str(options.portfolioDoc).trim();

  const out = ['# ' + title, ''];
  if (narrative) {
    out.push(narrative, '');
  }
  out.push('## What the numbers are', '');
  if (!tiles.length) {
    out.push(EMPTY_POST_HEADLINE, '', EMPTY_POST_CTA, '');
  } else {
    out.push('| Finding | Value | Check |', '|---|---|---|');
    for (const t of tiles) {
      out.push('| ' + mdCell(t.title) + ' | ' + mdCell(formatTileValue(t.value, t.unit)) + ' | ' + mdCell(t.badgeLabel || t.gateBadge) + ' |');
    }
    out.push('');
    out.push('## How each number was produced', '');
    for (const t of tiles) {
      out.push('### ' + str(t.title));
      out.push('');
      const code = str(t.sqlOrCode).trim();
      if (code) {
        out.push('```' + (str(t.language) || 'sql'), code, '```', '');
      } else {
        out.push('No code was recorded for this number.', '');
      }
    }
  }
  if (recommendation) {
    out.push('## Recommendation', '', recommendation, '');
  }
  out.push('---', '', POST_DISCLAIMER, '');
  return out.join('\n');
}

function mdCell(v) {
  return str(v).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/**
 * The three-step checklist the panel renders. Each step reports whether it is
 * ready and, when it is not, exactly what is missing. A step is never reported
 * ready on the strength of something the user has not actually done.
 */
export function proofToPostSteps(pack, state) {
  const s = isPlainObject(state) ? state : {};
  const tiles = isPlainObject(pack) && Array.isArray(pack.tiles) ? pack.tiles : [];
  const draftOk = isPlainObject(pack) && isPlainObject(pack.validation) ? pack.validation.ok === true : false;

  const proveReady = tiles.length > 0;
  return [
    {
      id: 'prove',
      title: 'Prove',
      body: proveReady
        ? tiles.length + ' tile(s) on the Proof Board carry a value and the code that produced it.'
        : 'The Proof Board has no tile with a value yet. Load data and build the board first.',
      ready: proveReady,
      blocker: proveReady ? '' : EMPTY_POST_CTA,
    },
    {
      id: 'publish',
      title: 'Publish',
      body: proveReady
        ? 'Download the Glowbook and the portfolio markdown. Each download asks first.'
        : 'Nothing to publish until something is proved.',
      ready: proveReady && s.published === true,
      blocker: proveReady ? (s.published === true ? '' : 'No file has been downloaded yet.') : EMPTY_POST_CTA,
    },
    {
      id: 'post',
      title: 'Post',
      body: draftOk
        ? 'The draft is ready to read. Copy is enabled once you confirm you have reviewed the numbers.'
        : 'The draft is not ready: at least one number in it does not trace to a tile.',
      ready: draftOk && s.reviewed === true,
      blocker: !draftOk
        ? 'Fix the unbound numbers before copying.'
        : (s.reviewed === true ? '' : 'Tick the review box to enable Copy draft.'),
    },
  ];
}

/**
 * The whole pack. Assembles the portfolio doc and the draft, then runs the gate
 * over the draft and carries the result rather than hiding it, so a surface
 * cannot render a draft without also being able to render why it was refused.
 */
export function buildProofToPostPack(input) {
  const inp = isPlainObject(input) ? input : {};
  const tiles = postableTiles(inp.tiles);
  const allTiles = tilesOf(inp.tiles);
  const boardMeta = isPlainObject(inp.boardMeta) ? inp.boardMeta : {};

  const portfolioMarkdown = buildPortfolioMarkdown(allTiles, {
    title: str(inp.title) || str(boardMeta.title),
    recommendation: inp.recommendation,
    portfolioDoc: inp.portfolioDoc,
  });

  const linkedInDraft = buildLinkedInDraft(allTiles, {
    title: str(inp.title) || str(boardMeta.title),
    closing: inp.closing,
    includeTransparency: inp.includeTransparency,
  });

  const validation = validateLinkedInDraft(linkedInDraft, allTiles, { engineResults: inp.engineResults });

  const deidReceipt = isPlainObject(inp.deidReceipt) ? inp.deidReceipt : null;

  const pack = {
    kind: PROOF_TO_POST_KIND,
    version: PROOF_TO_POST_VERSION,
    neverAutoPost: NEVER_AUTO_POST,
    boardMeta,
    tiles,
    excluded: excludedTiles(inp.tiles),
    portfolioMarkdown,
    linkedInDraft,
    validation,
    deidReceipt,
    empty: tiles.length === 0,
    emptyHeadline: EMPTY_POST_HEADLINE,
    emptyCta: EMPTY_POST_CTA,
    disclaimer: POST_DISCLAIMER,
  };
  pack.steps = proofToPostSteps(pack, inp.state);
  return pack;
}

// ---- coach strip -----------------------------------------------------------
//
// Four steps, one per thing a person can actually do here, reusing the Bundle 9
// strip model rather than shipping a second tour framework. Nothing is dimmed
// and nothing is blocked while it is open.

export const POST_COACH_SEEN_KEY = 'dataglow.proofToPost.coachSeen';

export const POST_COACH_STEPS = Object.freeze([
  Object.freeze({
    id: 'loop',
    target: 'dg-p2p-steps',
    title: 'Prove, publish, then post',
    body: 'Three steps in order. Each one stays greyed out until the one before it is genuinely done, so the post cannot get ahead of the proof.',
  }),
  Object.freeze({
    id: 'numbers-are-bound',
    target: 'dg-p2p-draft',
    title: 'The draft is assembled, not typed',
    body: 'Every number in the draft was lifted from a Proof Board tile. Nothing here was written by hand, which is why it can be checked at all.',
  }),
  Object.freeze({
    id: 'gate',
    target: 'dg-p2p-gate',
    title: 'The gate names what it refuses',
    body: 'If a number does not trace back to a tile it is listed by name. Delete it or go compute it. There is no override.',
  }),
  Object.freeze({
    id: 'copy-only',
    target: 'dg-p2p-copy',
    title: 'Copy is the last thing this app does',
    body: 'There is no connected account and no posting API. You tick the review box, you copy the text, and you paste it yourself.',
  }),
]);

export function postCoachModel(index) {
  return coachStripModel(POST_COACH_STEPS.slice(), clampStep(index, POST_COACH_STEPS.length));
}

export const DataGlowProofToPost = {
  PROOF_TO_POST_KIND,
  POST_COACH_SEEN_KEY,
  POST_COACH_STEPS,
  postCoachModel,
  PROOF_TO_POST_VERSION,
  NEVER_AUTO_POST,
  MAX_BULLETS,
  METHOD_LINE,
  TRANSPARENCY_CHECKED,
  TRANSPARENCY_PARTIAL,
  POST_DISCLAIMER,
  EMPTY_POST_HEADLINE,
  EMPTY_POST_CTA,
  tilesOf,
  postableTiles,
  excludedTiles,
  bulletForTile,
  buildLinkedInDraft,
  validateLinkedInDraft,
  buildPortfolioMarkdown,
  proofToPostSteps,
  buildProofToPostPack,
};

try {
  if (typeof window !== 'undefined') window.DataGlowProofToPost = DataGlowProofToPost;
} catch (_e) {}
