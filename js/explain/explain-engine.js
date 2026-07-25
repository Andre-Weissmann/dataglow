// ============================================================
// DATAGLOW - Explain (pure engine)
// ============================================================
// WHY THIS EXISTS
// By the time a result is on screen, DataGlow already knows a great deal about
// it, and says none of it in one place. Query Sentinel knows whether the join
// can multiply rows (js/validation/query-sentinel.js). Query Sentinel Assist
// knows the shape of the fix (js/validation/query-sentinel-assist.js). The
// readiness gate knows whether the dataset held up
// (js/gate/readiness-gate.js). PHI Shield knows whether anything sensitive is
// in view. Air-Gap Mode knows whether the human asked for nothing to cross the
// network. Publish-Safe knows whether this may be written. The Trust Ledger
// knows what has already happened in this tab.
//
// A person looking at a number does not want six badges. They want one calm
// paragraph: what this is, what is known about it, and what is NOT known. This
// module composes the evidence those engines already produced into exactly
// that. It computes no findings of its own.
//
// THE RULES IT ENCODES
//   - It never invents certainty. Every source that could not be consulted is
//     named in `unknowns`, and each one lowers `confidence`. An explanation
//     built from nothing says so in its headline instead of reassuring anyone.
//   - It never re-derives. A sentinel flag it repeats is a flag Query Sentinel
//     already raised; a gate verdict it repeats is one the gate already
//     reached. It cannot report a problem no engine found, and it cannot
//     suppress one that was found.
//   - It never mutates and never acts. There is no export here that writes,
//     applies, or runs anything. It returns text.
//
// ON BORROWED SENTENCES
// The engines above predate the house rule against em dashes in product text,
// and their message strings are full of them (js/validation/query-sentinel.js
// lines 183, 192, 233 and 291; js/gate/readiness-gate.js line 152 onward).
// Rewriting those strings would invalidate their recorded goldens, so every
// borrowed sentence passes through plainText() instead, which turns an em dash
// into the comma it was standing in for. That is why this file reads other
// engines' structured fields wherever it can and their prose only where it
// must.
//
// PURITY: no DOM, no network, no storage, no imports. Node-testable in full.

export const EXPLAIN_KIND = 'dataglow-explain';
export const EXPLAIN_VERSION = 1;

/* The complete set of evidence sources this engine understands. A caller hands
   over what it has; anything absent becomes an honest unknown rather than a
   silent gap. */
export const EXPLAIN_SOURCES = Object.freeze([
  'query-sentinel',
  'readiness-gate',
  'result-shape',
  'phi-shield',
  'air-gap',
  'publish-safe',
  'trust-ledger',
]);

export const EXPLAIN_CONFIDENCE = Object.freeze(['well-evidenced', 'partly-evidenced', 'unevidenced']);

export const EXPLAIN_DISCLAIMER =
  'This explanation only repeats what the checks on this device already found. '
  + 'It is not advice, it is not a review of your analysis, and it cannot see '
  + 'anything the checks did not measure.';

/* A source is worth listing as an unknown only if a reader could reasonably
   expect it. These are the reasons, kept here so the wording is consistent
   whichever composer notices the gap. */
const UNKNOWN_REASONS = Object.freeze({
  'query-sentinel': 'Query Sentinel did not run on this query, so nothing is known about join or grouping risk.',
  'readiness-gate': 'The readiness gate has no verdict yet, so nothing is known about whether the data held up.',
  'result-shape': 'The size of the result was not measured, so this cannot say how much data you are looking at.',
  'phi-shield': 'PHI Shield has not scanned this, so nothing is known about sensitive values.',
  'air-gap': 'Air-Gap Mode was not readable, so this cannot say whether the network is closed off.',
  'publish-safe': 'Publish-Safe was not consulted, so nothing is known about whether this is safe to hand over.',
  'trust-ledger': 'The Trust Ledger was not readable, so this cannot say what else happened in this tab.',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Normalise a sentence borrowed from another engine into house style.
 *
 * An em dash is nearly always doing the work of a comma in the strings this
 * engine borrows, so that is the substitution. Repeated whitespace is
 * collapsed because the source strings are template-built and sometimes carry
 * it. Returns '' for anything that is not a usable string, so a caller can
 * test the result rather than the input.
 *
 * @param {*} s
 * @returns {string}
 */
export function plainText(s) {
  if (typeof s !== 'string') return '';
  // Escapes, not literals, so a grep for a stray em dash in product text does
  // not trip over the one place that is allowed to mention it.
  return s
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/\s*\u2013\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ,/g, ',')
    .trim();
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/* -------------------------- per-source composers -------------------------- */

/**
 * What Query Sentinel found, in one or two sentences, plus the fix shapes
 * Assist already produced. Both are read as data: the flag count and severity
 * decide the wording, and only the `message` and `sketch` strings are quoted.
 *
 * @param {{status?:string, flagCount?:number, flags?:Array}} report
 * @param {Array<{kind:string, sketch:string}>} [suggestions] - from
 *   js/validation/query-sentinel-assist.js's assistDeterministic().
 * @returns {{text:string, level:string, detail:object}|null} null when there
 *   is no report to read, so the caller records an unknown instead.
 */
export function explainSentinel(report, suggestions) {
  if (!isPlainObject(report) || !Array.isArray(report.flags)) return null;
  const flags = report.flags.filter(isPlainObject);
  const fails = flags.filter((f) => f.severity === 'fail');
  const warns = flags.filter((f) => f.severity === 'warn');
  const sketches = Array.isArray(suggestions)
    ? suggestions.filter((s) => isPlainObject(s) && typeof s.sketch === 'string')
    : [];

  if (flags.length === 0) {
    return {
      text: 'Query Sentinel checked this query for the mistakes that quietly change a number, '
        + 'joins that multiply rows, join keys that do not match, and totals that will not add '
        + 'back up, and found none of them.',
      level: 'good',
      detail: { flagCount: 0, fails: 0, warns: 0 },
    };
  }

  const lead = fails.length > 0
    ? 'Query Sentinel found ' + fails.length + ' ' + plural(fails.length, 'problem', 'problems')
      + ' that can change the number you are looking at.'
    : 'Query Sentinel found ' + warns.length + ' thing' + (warns.length === 1 ? '' : 's')
      + ' worth a second look, none of them certain to be wrong.';

  const quoted = (fails.length > 0 ? fails : warns)
    .slice(0, 2)
    .map((f) => plainText(f.message))
    .filter((t) => t.length > 0);

  const parts = [lead];
  if (quoted.length > 0) parts.push('In its own words: ' + quoted.join(' Also: '));
  if (sketches.length > 0) {
    parts.push('The suggested shape of a fix, which nothing here has applied: '
      + sketches.slice(0, 2).map((s) => plainText(s.sketch)).join(' '));
  }

  return {
    text: parts.join(' '),
    level: fails.length > 0 ? 'bad' : 'warn',
    detail: { flagCount: flags.length, fails: fails.length, warns: warns.length },
  };
}

/**
 * What the readiness gate decided, composed from its structured fields rather
 * than from explainGateReasons(), whose output is em dashed and shaped for a
 * log line rather than a paragraph.
 *
 * @param {{agentConsumable?:boolean, score?:number, threshold?:number,
 *   failingLayers?:Array, blockedByContract?:boolean, evaluatedLayerCount?:number}} gate
 * @returns {{text:string, level:string, detail:object}|null}
 */
export function explainGate(gate) {
  if (!isPlainObject(gate) || typeof gate.agentConsumable !== 'boolean') return null;
  const score = isNum(gate.score) ? gate.score : null;
  const threshold = isNum(gate.threshold) ? gate.threshold : null;
  const failing = Array.isArray(gate.failingLayers) ? gate.failingLayers.filter(isPlainObject) : [];
  const evaluated = isNum(gate.evaluatedLayerCount) ? gate.evaluatedLayerCount : 0;

  if (evaluated === 0 && failing.length === 0 && !gate.blockedByContract) {
    return {
      text: 'The readiness gate has not been given any validation evidence yet, so it is holding '
        + 'this back rather than calling it ready. That is the gate being careful, not a finding '
        + 'against your data.',
      level: 'unknown',
      detail: { evaluated: 0 },
    };
  }

  const parts = [];
  if (gate.agentConsumable) {
    parts.push('The readiness gate passed this'
      + (score === null ? '.' : ', scoring ' + score + ' out of 100'
        + (threshold === null ? '.' : ' against a bar of ' + threshold + '.')));
    parts.push('That means the checks it can run all held up, across ' + evaluated + ' '
      + plural(evaluated, 'layer', 'layers') + ' of evidence.');
  } else {
    parts.push('The readiness gate is holding this back'
      + (score === null ? '.' : ', scoring ' + score + ' out of 100'
        + (threshold === null ? '.' : ' against a bar of ' + threshold + '.')));
    if (gate.blockedByContract) {
      parts.push('The metric contract behind this no longer matches what was agreed, and that '
        + 'alone is enough to hold it back.');
    }
    if (failing.length > 0) {
      const named = failing.slice(0, 3)
        .map((f) => String(f.layer || 'a check') + ' (' + plainText(f.reason) + ')')
        .join('; ');
      parts.push('What failed: ' + named + '.');
    } else if (!gate.blockedByContract) {
      parts.push('Nothing failed outright. The score is simply below the bar, which usually means '
        + 'unresolved warnings or too little evidence to be sure.');
    }
  }

  return {
    text: parts.join(' '),
    level: gate.agentConsumable ? 'good' : 'bad',
    detail: {
      agentConsumable: gate.agentConsumable,
      score,
      threshold,
      failing: failing.length,
      blockedByContract: !!gate.blockedByContract,
      evaluated,
    },
  };
}

/**
 * How much data is on screen. Deliberately blunt: a reader who has been handed
 * a truncated preview should be told, because every other sentence in the
 * explanation is about a sample if this one is.
 *
 * @param {{rows?:number, columns?:number, truncated?:boolean, table?:string}} shape
 * @returns {{text:string, level:string, detail:object}|null}
 */
export function explainResultShape(shape) {
  if (!isPlainObject(shape) || (!isNum(shape.rows) && !isNum(shape.columns))) return null;
  const rows = isNum(shape.rows) ? shape.rows : null;
  const cols = isNum(shape.columns) ? shape.columns : null;
  const bits = [];
  if (rows !== null && cols !== null) {
    bits.push('You are looking at ' + rows.toLocaleString() + ' '
      + plural(rows, 'row', 'rows') + ' across ' + cols + ' ' + plural(cols, 'column', 'columns') + '.');
  } else if (rows !== null) {
    bits.push('You are looking at ' + rows.toLocaleString() + ' ' + plural(rows, 'row', 'rows') + '.');
  } else {
    bits.push('You are looking at ' + cols + ' ' + plural(cols, 'column', 'columns') + '.');
  }
  if (shape.truncated) {
    bits.push('This is a preview, not the whole result, so any total you read off it is a total '
      + 'of the preview.');
  }
  if (rows === 0) {
    bits.push('No rows came back. An empty result is a real answer, but it is also what a filter '
      + 'that is too narrow looks like.');
  }
  return {
    text: bits.join(' '),
    level: shape.truncated || rows === 0 ? 'warn' : 'good',
    detail: { rows, columns: cols, truncated: !!shape.truncated },
  };
}

/**
 * What PHI Shield found. Reads the same shape PHI Shield's guardOrBlock()
 * returns, and treats a scan that could not run as unknown rather than clean,
 * the same rule js/gate/publish-safe.js holds.
 *
 * @param {{available?:boolean, sensitiveFound?:boolean, findings?:Array}} phi
 * @returns {{text:string, level:string, detail:object}|null}
 */
export function explainPhi(phi) {
  if (!isPlainObject(phi)) return null;
  if (phi.available === false) return null;
  if (typeof phi.sensitiveFound !== 'boolean') return null;
  const findings = Array.isArray(phi.findings) ? phi.findings.filter(isPlainObject) : [];
  const count = findings.reduce((n, f) => n + (isNum(f.count) ? f.count : 1), 0);
  if (!phi.sensitiveFound) {
    return {
      text: 'PHI Shield looked over this and matched nothing it recognises as sensitive. It '
        + 'matches patterns, so a clean result is a good sign rather than a guarantee.',
      level: 'good',
      detail: { sensitiveFound: false, findings: 0 },
    };
  }
  return {
    text: 'PHI Shield matched ' + count + ' possible sensitive '
      + plural(count, 'value', 'values') + ' in this. Nothing has been removed or changed: the '
      + 'match is there so you can decide what should happen before this goes anywhere.',
    level: 'warn',
    detail: { sensitiveFound: true, findings: findings.length, matched: count },
  };
}

/**
 * The privacy posture, in the terms the user chose it in.
 * @param {{active?:boolean}} airGap
 * @returns {{text:string, level:string, detail:object}|null}
 */
export function explainAirGap(airGap) {
  if (!isPlainObject(airGap) || typeof airGap.active !== 'boolean') return null;
  return airGap.active
    ? {
      text: 'Air-Gap Mode is on, so nothing here can reach the network even if something asked it '
        + 'to. Everything above was worked out on this device.',
      level: 'good',
      detail: { active: true },
    }
    : {
      text: 'Air-Gap Mode is off. Nothing here sent anything anywhere, because none of these '
        + 'checks use the network, but the switch that would refuse an attempt is not thrown.',
      level: 'unknown',
      detail: { active: false },
    };
}

/**
 * The Publish-Safe verdict, quoted rather than recomputed. Publish-Safe writes
 * its own headline in house style, so it is passed through plainText and used.
 *
 * @param {{level?:string, headline?:string, blocked?:boolean}} verdict
 * @returns {{text:string, level:string, detail:object}|null}
 */
export function explainPublishSafe(verdict) {
  if (!isPlainObject(verdict) || typeof verdict.level !== 'string') return null;
  const headline = plainText(verdict.headline);
  const map = { clear: 'good', caution: 'warn', blocked: 'bad' };
  return {
    text: headline || 'Publish-Safe reached a verdict of ' + verdict.level + ' on handing this over.',
    level: map[verdict.level] || 'unknown',
    detail: { level: verdict.level, blocked: !!verdict.blocked },
  };
}

/**
 * What else has happened in this tab, from the Trust Ledger's own count.
 * @param {{size?:number, valid?:boolean}} ledger
 * @returns {{text:string, level:string, detail:object}|null}
 */
export function explainTrustLedger(ledger) {
  if (!isPlainObject(ledger) || !isNum(ledger.size)) return null;
  if (ledger.size === 0) {
    return {
      text: 'The Trust Ledger has nothing in it yet, so nothing that belongs on a record has '
        + 'happened in this tab so far.',
      level: 'unknown',
      detail: { size: 0 },
    };
  }
  const chain = ledger.valid === false
    ? ' Its chain does not verify, which means a row was changed after it was written and none of '
      + 'them can be trusted as a record.'
    : (ledger.valid === true ? ' Its chain verifies, so no row has been altered since it landed.' : '');
  return {
    text: 'The Trust Ledger holds ' + ledger.size + ' '
      + plural(ledger.size, 'row', 'rows') + ' for this tab.' + chain,
    level: ledger.valid === false ? 'bad' : 'good',
    detail: { size: ledger.size, valid: ledger.valid === true },
  };
}

/* ------------------------------ composition ------------------------------- */

const COMPOSERS = Object.freeze([
  { id: 'query-sentinel', label: 'The query', run: (e) => explainSentinel(e.sentinel, e.sentinelSuggestions) },
  { id: 'result-shape', label: 'What is on screen', run: (e) => explainResultShape(e.resultShape) },
  { id: 'readiness-gate', label: 'Whether the data held up', run: (e) => explainGate(e.gate) },
  { id: 'phi-shield', label: 'Anything sensitive', run: (e) => explainPhi(e.phi) },
  { id: 'publish-safe', label: 'Handing it over', run: (e) => explainPublishSafe(e.publishSafe) },
  { id: 'air-gap', label: 'The network', run: (e) => explainAirGap(e.airGap) },
  { id: 'trust-ledger', label: 'On the record', run: (e) => explainTrustLedger(e.trustLedger) },
]);

/* The worst level any section reached decides the headline, because a reader
   who skims one line must not be told everything is fine when one section says
   otherwise. */
const LEVEL_RANK = Object.freeze({ good: 0, unknown: 1, warn: 2, bad: 3 });

function worstLevel(sections) {
  let worst = 'good';
  for (const s of sections) {
    if ((LEVEL_RANK[s.level] || 0) > (LEVEL_RANK[worst] || 0)) worst = s.level;
  }
  return worst;
}

function buildHeadline(sections, unknowns, worst) {
  if (sections.length === 0) {
    return 'There is nothing to explain yet. None of the checks on this device have looked at '
      + 'this, so anything said here would be invented.';
  }
  const missing = unknowns.length;
  const tail = missing === 0
    ? ' Every check this could ask was asked.'
    : ' ' + missing + ' ' + plural(missing, 'check', 'checks') + ' could not be asked, so this is '
      + 'not the whole picture.';
  if (worst === 'bad') {
    return 'Something here needs your attention before you rely on this number.' + tail;
  }
  if (worst === 'warn') {
    return 'This looks usable, with something worth reading before you rely on it.' + tail;
  }
  if (worst === 'unknown') {
    return 'Nothing found a problem, and some of what you would want to know was not measured.' + tail;
  }
  return 'Everything that was checked here held up.' + tail;
}

function confidenceFor(sections, unknowns) {
  if (sections.length === 0) return 'unevidenced';
  if (unknowns.length === 0) return 'well-evidenced';
  // A clear minority of sources answering is not enough to call anything
  // evidenced, even though one section did come back.
  return sections.length * 2 < unknowns.length ? 'unevidenced' : 'partly-evidenced';
}

/**
 * The whole point of this file: one explanation composed from whatever evidence
 * a surface managed to gather.
 *
 * Never throws. A malformed evidence bag produces the same honest "nothing to
 * explain yet" answer as an empty one, because a surface asking for an
 * explanation must not be able to break by asking badly.
 *
 * @param {{
 *   subject?: string,
 *   sentinel?: object, sentinelSuggestions?: Array,
 *   resultShape?: object, gate?: object, phi?: object,
 *   airGap?: object, publishSafe?: object, trustLedger?: object,
 *   expect?: string[]
 * }} [evidence] - `expect` narrows which sources are worth calling unknown, so
 *   a surface that has no query does not apologise for having no query.
 * @returns {{kind:string, version:number, subject:string, headline:string,
 *   confidence:string, level:string, sections:Array, evidence:Array,
 *   unknowns:Array, disclaimer:string}}
 */
export function explainResult(evidence = {}) {
  const bag = isPlainObject(evidence) ? evidence : {};
  const expect = Array.isArray(bag.expect)
    ? bag.expect.filter((s) => EXPLAIN_SOURCES.includes(s))
    : EXPLAIN_SOURCES.slice();

  const sections = [];
  const cited = [];
  const unknowns = [];

  for (const composer of COMPOSERS) {
    let out = null;
    try {
      out = composer.run(bag);
    } catch (_e) {
      out = null; // a broken evidence shape is a missing source, not a crash
    }
    if (out && typeof out.text === 'string' && out.text.length > 0) {
      sections.push({
        id: composer.id,
        label: composer.label,
        text: plainText(out.text),
        level: out.level || 'unknown',
      });
      cited.push({ source: composer.id, detail: out.detail || {} });
    } else if (expect.includes(composer.id)) {
      unknowns.push({ source: composer.id, why: UNKNOWN_REASONS[composer.id] });
    }
  }

  const worst = worstLevel(sections);
  return {
    kind: EXPLAIN_KIND,
    version: EXPLAIN_VERSION,
    subject: typeof bag.subject === 'string' && bag.subject ? bag.subject : 'this result',
    headline: buildHeadline(sections, unknowns, worst),
    confidence: confidenceFor(sections, unknowns),
    level: sections.length === 0 ? 'unknown' : worst,
    sections,
    evidence: cited,
    unknowns,
    disclaimer: EXPLAIN_DISCLAIMER,
  };
}

/**
 * The same explanation as plain text, for a copy button or a saved file. Kept
 * here rather than in the surface so what a user copies is what a test reads.
 * @param {ReturnType<typeof explainResult>} exp
 * @returns {string}
 */
export function describeExplanation(exp) {
  if (!isPlainObject(exp) || !Array.isArray(exp.sections)) return 'No explanation to show.';
  const lines = ['Explain: ' + (exp.subject || 'this result'), '', exp.headline, ''];
  for (const s of exp.sections) {
    lines.push(s.label + ': ' + s.text);
  }
  if (exp.unknowns && exp.unknowns.length > 0) {
    lines.push('', 'Not known:');
    for (const u of exp.unknowns) lines.push('- ' + u.why);
  }
  lines.push('', exp.disclaimer || EXPLAIN_DISCLAIMER);
  return lines.join('\n');
}

/**
 * A short badge for a surface that has room for three words and not a
 * paragraph.
 * @param {ReturnType<typeof explainResult>} exp
 * @returns {{level:string, text:string, tone:string}}
 */
export function explainBadge(exp) {
  const level = isPlainObject(exp) && typeof exp.level === 'string' ? exp.level : 'unknown';
  if (level === 'bad') return { level, text: 'Needs a look', tone: 'danger' };
  if (level === 'warn') return { level, text: 'Read this', tone: 'warn' };
  if (level === 'good') return { level, text: 'Checks held', tone: 'ok' };
  return { level, text: 'Little is known', tone: 'muted' };
}

/* Explicit, testable proof that this engine only ever explains: nothing here
   writes, applies, runs or mutates, and test/explain-engine.test.mjs asserts
   this list stays exactly this shape. Same red-team pattern as
   js/validation/query-sentinel-assist.js's PUBLIC_API_SURFACE. */
export const PUBLIC_API_SURFACE = Object.freeze([
  'plainText',
  'explainSentinel',
  'explainGate',
  'explainResultShape',
  'explainPhi',
  'explainAirGap',
  'explainPublishSafe',
  'explainTrustLedger',
  'explainResult',
  'describeExplanation',
  'explainBadge',
]);

export const DataGlowExplain = {
  EXPLAIN_KIND,
  EXPLAIN_VERSION,
  EXPLAIN_SOURCES,
  EXPLAIN_CONFIDENCE,
  EXPLAIN_DISCLAIMER,
  PUBLIC_API_SURFACE,
  plainText,
  explainSentinel,
  explainGate,
  explainResultShape,
  explainPhi,
  explainAirGap,
  explainPublishSafe,
  explainTrustLedger,
  explainResult,
  describeExplanation,
  explainBadge,
};

// Same publication pattern as js/gate/publish-safe.js: the canvas surface reads
// the namespace off window because its inlined copy has no module scope.
try {
  if (typeof window !== 'undefined') window.DataGlowExplainEngine = DataGlowExplain;
} catch (_e) { /* no window in Node tests */ }
