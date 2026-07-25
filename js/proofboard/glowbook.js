/**
 * Glowbook: the Proof Board as one HTML file somebody else can open.
 *
 * WHY A FILE AND NOT A LINK.
 * A link to a result is a promise that a server will still be there, still be
 * reachable, and still be showing the same thing. DataGlow has no server, so a
 * shared link would have to be a hosted copy of the data, which is the one thing
 * this product refuses to do. A Glowbook is a single self-contained file on the
 * person's own disk. It carries no script, loads nothing, and calls nothing.
 *
 * WHY THERE IS NO SCRIPT IN THE OUTPUT.
 * The export is a document, not an application. An exported page that runs code
 * is a page whose contents can differ from what the person previewed before they
 * sent it, and it is also the thing a mail gateway strips or quarantines. Every
 * number and every query is written into the markup as text.
 *
 * WHAT THE DISCLAIMER IS FOR.
 * This file will be forwarded to people who did not run the analysis, and a page
 * full of green ticks reads as an audit. It is not one. The disclaimer states in
 * the document itself that this is a record of how numbers were computed on one
 * device, that unchecked is not passed, and that nothing here is a
 * certification, a compliance claim or legal advice. It is emitted from a
 * constant so it cannot be edited away by a caller.
 *
 * Pure ES module: builds a string. It does not download anything, does not touch
 * the DOM, and has no opinion about when the file should be written. The confirm
 * gate lives in the canvas surface, because only a surface can ask a person.
 */
import { summarizeBoard, verifyBoard, PROOF_BOARD_KIND } from './proof-board.js';

export const GLOWBOOK_KIND = 'dataglow-glowbook';
export const GLOWBOOK_VERSION = 1;

export const GLOWBOOK_DISCLAIMER = [
  'This document records how each number on it was computed, on one device, at one moment.',
  'It is not a certification, not an audit, not a compliance claim and not legal or clinical advice.',
  'A tile marked not checked has not passed anything. It means no check reported on it.',
  'Nothing in this file runs, loads or sends. It is a static document containing no script.',
].join(' ');

export const GLOWBOOK_NOT_ZK =
  'The proof here is readable code, not a cryptographic proof. Anyone can read the query and '
  + 'judge it. Nobody can verify it without the data it ran on.';

/**
 * HTML escaping for text going into the document.
 *
 * Written here rather than imported from js/app-shell/utils.js so this module
 * stays free of DOM-side dependencies and can be tested in Node on its own. The
 * five characters are the whole set that matters for text and attributes.
 */
export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The structured model behind the document, kept separate from the markup so a
 * test can assert on the content without parsing HTML.
 *
 * @param {object} board - a model from buildProofBoard()
 * @param {{title?:string, author?:string, generatedAt?:number,
 *   trustLedgerSummary?:string, trustLedgerEntries?:Array}} [opts]
 */
export function buildGlowbook(board, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const b = isPlainObject(board) ? board : { tiles: [], empty: true, stats: {} };
  const tiles = Array.isArray(b.tiles) ? b.tiles : [];

  return {
    kind: GLOWBOOK_KIND,
    version: GLOWBOOK_VERSION,
    boardKind: b.kind || PROOF_BOARD_KIND,
    title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : 'Proof Board',
    datasetName: b.datasetName || '',
    generatedAt: Number.isFinite(o.generatedAt) ? o.generatedAt : (b.generatedAt || 0),
    summary: summarizeBoard(b),
    verification: verifyBoard(b),
    tiles: tiles,
    stats: b.stats || {},
    empty: !!b.empty,
    trustLedgerSummary: (typeof o.trustLedgerSummary === 'string' && o.trustLedgerSummary.trim())
      ? o.trustLedgerSummary.trim()
      : (b.trustLedgerSummary || ''),
    trustLedgerEntries: Array.isArray(o.trustLedgerEntries) ? o.trustLedgerEntries : [],
    disclaimer: GLOWBOOK_DISCLAIMER,
    notZeroKnowledge: GLOWBOOK_NOT_ZK,
  };
}

function badgeChip(tile) {
  return '<span class="gb-badge gb-badge-' + escapeHtml(tile.gateBadge) + '">'
    + escapeHtml(tile.badgeLabel) + '</span>';
}

function tileSection(tile) {
  const parts = [];
  parts.push('<section class="gb-tile">');
  parts.push('<h2 class="gb-tile-title">' + escapeHtml(tile.title || tile.id) + '</h2>');

  // Finding first, then the proof. Same order as the GlassBox panel on screen,
  // because a reader who has seen one should not have to relearn the other.
  if (tile.valueText) {
    parts.push('<p class="gb-value">' + escapeHtml(tile.valueText) + '</p>');
  } else {
    parts.push('<p class="gb-value gb-value-missing">No value was recorded for this tile.</p>');
  }

  parts.push('<p class="gb-badges">' + badgeChip(tile) + ' <span class="gb-why">'
    + escapeHtml(tile.badgeWhy) + '</span></p>');

  if (tile.checksSummary) {
    parts.push('<p class="gb-checks">' + escapeHtml(tile.checksSummary) + '</p>');
  }
  if (tile.sourceCols && tile.sourceCols.length > 0) {
    parts.push('<p class="gb-cols">Columns used: ' + escapeHtml(tile.sourceCols.join(', ')) + '</p>');
  }

  if (tile.sqlOrCode && tile.sqlOrCode.trim()) {
    parts.push('<p class="gb-proof-label">The code that produced this number ('
      + escapeHtml(tile.language) + ', run by ' + escapeHtml(tile.engine) + '):</p>');
    parts.push('<pre class="gb-code"><code>' + escapeHtml(tile.sqlOrCode) + '</code></pre>');
  } else {
    parts.push('<p class="gb-proof-missing">This tile did not hand over the code that produced '
      + 'it, so there is nothing to check here. Nothing has been reconstructed.</p>');
  }

  if (tile.problems && tile.problems.length > 0) {
    parts.push('<ul class="gb-problems">');
    for (let i = 0; i < tile.problems.length; i += 1) {
      parts.push('<li>' + escapeHtml(tile.problems[i]) + '</li>');
    }
    parts.push('</ul>');
  }

  parts.push('</section>');
  return parts.join('\n');
}

const GLOWBOOK_CSS = [
  ':root{color-scheme:light dark}',
  'body{margin:0;padding:24px;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  'background:#0f1115;color:#e8ecf1}',
  '.gb-wrap{max-width:900px;margin:0 auto}',
  'h1{font-size:24px;margin:0 0 4px}',
  '.gb-sub{color:#9aa4b2;margin:0 0 20px;font-size:14px}',
  '.gb-tile{border:1px solid #232833;border-radius:12px;padding:16px;margin:0 0 16px;background:#151922}',
  '.gb-tile-title{font-size:15px;font-weight:600;margin:0 0 6px;color:#9aa4b2}',
  '.gb-value{font-size:30px;font-weight:700;margin:0 0 10px;letter-spacing:-.01em}',
  '.gb-value-missing{font-size:15px;font-weight:400;color:#9aa4b2}',
  '.gb-badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600}',
  '.gb-badge-clear{background:#123524;color:#6ee7a8}',
  '.gb-badge-caution{background:#3a3113;color:#f2cd6b}',
  '.gb-badge-blocked{background:#3d1a1d;color:#f38a8a}',
  '.gb-badge-unknown{background:#242a35;color:#9aa4b2}',
  '.gb-why,.gb-checks,.gb-cols,.gb-proof-label{color:#9aa4b2;font-size:13px}',
  '.gb-proof-missing{color:#f2cd6b;font-size:13px}',
  '.gb-code{background:#0b0e13;border:1px solid #232833;border-radius:8px;padding:12px;overflow-x:auto;',
  'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}',
  '.gb-problems{color:#f2cd6b;font-size:13px;padding-left:18px}',
  '.gb-note{border:1px solid #232833;border-radius:12px;padding:16px;margin:0 0 16px;background:#12151c}',
  '.gb-note h2{font-size:14px;margin:0 0 8px}',
  '.gb-note p,.gb-note li{font-size:13px;color:#9aa4b2;margin:0 0 6px}',
  '.gb-fail{color:#f38a8a}',
  '@media print{body{background:#fff;color:#111}.gb-tile,.gb-note{background:#fff;border-color:#ccc}',
  '.gb-code{background:#f6f7f9;border-color:#ddd;color:#111}.gb-sub,.gb-why,.gb-checks{color:#555}}',
].join('');

/**
 * The document. A string, deliberately: writing it to disk is the caller's job,
 * and only after a person has said so.
 *
 * @param {ReturnType<typeof buildGlowbook>} model
 * @returns {string} complete standalone HTML
 */
export function renderGlowbookHTML(model) {
  const m = isPlainObject(model) ? model : buildGlowbook(null, null);
  const parts = [];

  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push('<title>' + escapeHtml(m.title) + '</title>');
  parts.push('<style>' + GLOWBOOK_CSS + '</style>');
  parts.push('</head><body><div class="gb-wrap">');

  parts.push('<h1>' + escapeHtml(m.title) + '</h1>');
  const subBits = [];
  if (m.datasetName) subBits.push(escapeHtml(m.datasetName));
  subBits.push(escapeHtml(m.summary));
  parts.push('<p class="gb-sub">' + subBits.join(' &middot; ') + '</p>');

  if (m.empty || !m.tiles || m.tiles.length === 0) {
    parts.push('<div class="gb-note"><h2>Nothing to show</h2><p>'
      + 'This board had no tiles when it was exported, so this document carries no numbers. '
      + 'That is deliberate: an empty board exports as empty rather than as a page of zeroes.'
      + '</p></div>');
  } else {
    for (let i = 0; i < m.tiles.length; i += 1) parts.push(tileSection(m.tiles[i]));
  }

  const v = m.verification;
  if (v && Array.isArray(v.checked)) {
    parts.push('<div class="gb-note"><h2>Board checks</h2>');
    parts.push('<p>' + escapeHtml(v.headline) + '</p><ul>');
    for (let i = 0; i < v.checked.length; i += 1) {
      const c = v.checked[i];
      parts.push('<li' + (c.pass ? '' : ' class="gb-fail"') + '>'
        + escapeHtml((c.pass ? 'Passed: ' : 'Did not pass: ') + c.what) + ' '
        + escapeHtml(c.note) + '</li>');
    }
    parts.push('</ul>');
    if (Array.isArray(v.cannotCheck) && v.cannotCheck.length > 0) {
      parts.push('<p>What these checks do not cover:</p><ul>');
      for (let i = 0; i < v.cannotCheck.length; i += 1) {
        parts.push('<li>' + escapeHtml(v.cannotCheck[i]) + '</li>');
      }
      parts.push('</ul>');
    }
    parts.push('</div>');
  }

  if (m.trustLedgerSummary || (m.trustLedgerEntries && m.trustLedgerEntries.length > 0)) {
    parts.push('<div class="gb-note"><h2>Trust Ledger</h2>');
    if (m.trustLedgerSummary) parts.push('<p>' + escapeHtml(m.trustLedgerSummary) + '</p>');
    if (m.trustLedgerEntries && m.trustLedgerEntries.length > 0) {
      parts.push('<ul>');
      for (let i = 0; i < m.trustLedgerEntries.length; i += 1) {
        parts.push('<li>' + escapeHtml(m.trustLedgerEntries[i]) + '</li>');
      }
      parts.push('</ul>');
    }
    parts.push('</div>');
  }

  parts.push('<div class="gb-note"><h2>What this document is</h2>');
  parts.push('<p>' + escapeHtml(m.disclaimer) + '</p>');
  parts.push('<p>' + escapeHtml(m.notZeroKnowledge) + '</p>');
  parts.push('</div>');

  parts.push('</div></body></html>');
  return parts.join('\n');
}

/** Filename plus payload, so the surface only has to hand it to a download. */
export function glowbookBlob(model, filenameStem) {
  const stem = (typeof filenameStem === 'string' && filenameStem.trim())
    ? filenameStem.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    : 'glowbook';
  return {
    data: renderGlowbookHTML(model),
    filename: (stem || 'glowbook') + '.html',
    mimeType: 'text/html;charset=utf-8',
  };
}

export const DataGlowGlowbook = {
  GLOWBOOK_KIND,
  GLOWBOOK_VERSION,
  GLOWBOOK_DISCLAIMER,
  GLOWBOOK_NOT_ZK,
  escapeHtml,
  buildGlowbook,
  renderGlowbookHTML,
  glowbookBlob,
};

try {
  if (typeof window !== 'undefined') window.DataGlowGlowbook = DataGlowGlowbook;
} catch (_e) { /* no window in Node tests */ }
