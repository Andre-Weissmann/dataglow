// ============================================================
// DATAGLOW - Ambient proof strip
// ============================================================
//
// The ambient assistants shipping in operating systems this year are always
// watching and always willing to answer. That combination is the product, and
// it is also the failure mode: the thing is never allowed to say it does not
// know, so it says something. An assistant that has read your spreadsheet and
// will confidently tell you the revenue figure is not a better analyst, it is
// a faster way to be wrong in a meeting.
//
// DataGlow's answer is not a competing ambient assistant. It is the opposite
// half: continuous, yes, but continuously reporting the state of the proof
// rather than continuously generating answers. The strip is always there, it
// never volunteers a number, and the only things on it are facts that some
// engine already established.
//
// WHY THIS MODULE CANNOT ANSWER A QUESTION.
// `answerAmbientQuestion` exists and always declines. That looks like dead
// code until you notice that the pressure on this surface will be to add "just
// a small one" later: a strip that already knows the row count is one commit
// away from answering "how many customers do we have". So the refusal is a
// function with a name, a reason, and a test, which makes adding an answer path
// a deliberate act rather than a convenience.
//
// WHY A STALE PROVE RESULT IS NOT A PASSING ONE.
// The strip reports the last gate run. If that run happened before the data
// changed, "passed" is a statement about a table that no longer exists. So the
// caller passes `dataVersion` and the strip compares it to the version the
// gate ran against; a mismatch downgrades the tone to `stale` and says so.
// A strip that shows a green tick for yesterday's data is worse than no strip.
//
// Pure. No DOM, no timers, no network. The canvas surface polls whatever it
// polls and hands the facts in.

export const AMBIENT_PROOF_KIND = 'dataglow-ambient-proof-strip';
export const AMBIENT_PROOF_VERSION = 1;

export const AMBIENT_TONES = Object.freeze(['clear', 'caution', 'blocked', 'stale', 'idle']);

export const AMBIENT_DOCTRINE =
  'Ambient assistants guess continuously. This strip proves continuously. It reports what an engine has already established and it answers nothing on its own.';

export const OUTBOUND_RULE =
  'Numbers leaving this machine must pass the prove gate first. There is no override and there is no automatic send.';

export const NOT_AN_ASSISTANT_NOTE =
  'This strip does not read your screen, does not listen, and does not answer questions about your data. It only reports the state of checks that have already run.';

const TONE_LABEL = Object.freeze({
  clear: 'Ambient proof: clear',
  caution: 'Ambient proof: open caveats',
  blocked: 'Ambient proof: blocked claim',
  stale: 'Ambient proof: stale, data changed',
  idle: 'Ambient proof: nothing checked yet',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function count(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * Read the last prove-gate run into the two things the strip needs from it:
 * whether it allowed the claim, and whether it is still about current data.
 *
 * Accepts the shape `assertClaimAllowed` returns, so a caller can hand the
 * result straight in without translating it and getting the translation wrong.
 */
function readProve(prove, dataVersion) {
  if (!isPlainObject(prove)) {
    return { ran: false, allowed: false, stale: false, unbound: 0, cautions: 0, refused: 0 };
  }
  const ranAgainst = str(prove.dataVersion);
  const now = str(dataVersion);
  const stale = !!(ranAgainst && now && ranAgainst !== now);
  return {
    ran: true,
    allowed: prove.allowed === true,
    stale,
    unbound: Array.isArray(prove.unbound) ? prove.unbound.length : 0,
    cautions: Array.isArray(prove.cautions) ? prove.cautions.length : 0,
    refused: Array.isArray(prove.refused) ? prove.refused.length : 0,
  };
}

/**
 * Build the strip.
 *
 * @param {{
 *   prove?: object, dataVersion?: string, airGap?: boolean, airGapCached?: boolean,
 *   openCaveats?: number, driftHeadline?: string, driftSeverity?: string,
 *   localAiState?: string, lastCheckedLabel?: string
 * }} [input]
 */
export function buildAmbientProofStrip(input) {
  const inp = isPlainObject(input) ? input : {};
  const p = readProve(inp.prove, inp.dataVersion);
  const airGap = inp.airGap === true;
  const caveats = count(inp.openCaveats);
  const driftSeverity = ['fail', 'warn', 'pass'].indexOf(str(inp.driftSeverity)) >= 0 ? str(inp.driftSeverity) : '';
  const driftHeadline = str(inp.driftHeadline);
  const lastCheckedLabel = str(inp.lastCheckedLabel);

  let tone;
  if (!p.ran) tone = 'idle';
  else if (p.stale) tone = 'stale';
  else if (!p.allowed || p.refused > 0) tone = 'blocked';
  else if (p.cautions > 0 || caveats > 0 || driftSeverity === 'warn' || driftSeverity === 'fail') tone = 'caution';
  else tone = 'clear';

  const facts = [];

  if (!p.ran) {
    facts.push({
      id: 'prove',
      label: 'Last prove run',
      value: 'None yet',
      detail: 'No claim has been through the gate in this session. That is not a pass, it is an absence.',
    });
  } else {
    facts.push({
      id: 'prove',
      label: 'Last prove run',
      value: p.stale
        ? 'Ran, but the data has changed since'
        : p.allowed
          ? 'Every number bound to a proof'
          : p.unbound + ' ' + plural(p.unbound, 'number', 'numbers') + ' not bound to any proof',
      detail: p.stale
        ? 'The gate passed against an earlier version of the data. Run it again before quoting anything from it.'
        : p.allowed
          ? 'Each number in the last checked claim matched a Proof Board tile or an engine result.'
          : 'A claim was refused. The unbound numbers are named on the gate result rather than quietly removed.',
    });
  }

  facts.push({
    id: 'airgap',
    label: 'Air-Gap Mode',
    value: airGap ? 'On, network paths blocked' : 'Off',
    detail: airGap
      ? 'Network paths are hard-blocked for this session. Nothing can be fetched and nothing can be sent.'
      : 'Air-Gap Mode is not on. Analysis still runs locally, and nothing leaves without a confirmation, but the block is not enforced.',
  });

  facts.push({
    id: 'caveats',
    label: 'Open caveats',
    value: caveats === 0 ? 'None recorded' : String(caveats) + ' ' + plural(caveats, 'caveat', 'caveats'),
    detail: caveats === 0
      ? 'No caveat is currently attached to the working set. Absence of a recorded caveat is not proof there is nothing to say about the data.'
      : 'A caveat travels with any number it applies to, including into an export.',
  });

  if (driftSeverity) {
    facts.push({
      id: 'drift',
      label: 'Drift watch',
      value: driftSeverity === 'fail' ? 'Drift detected' : driftSeverity === 'warn' ? 'Drift warning' : 'Stable',
      detail: driftHeadline || 'Reported by the drift watchdog against the last automatic re-check.',
    });
  }

  if (lastCheckedLabel) {
    facts.push({
      id: 'when',
      label: 'Last checked',
      value: lastCheckedLabel,
      detail: 'The strip reports when a check ran. It does not re-run anything on its own.',
    });
  }

  return {
    kind: AMBIENT_PROOF_KIND,
    version: AMBIENT_PROOF_VERSION,
    tone,
    label: TONE_LABEL[tone],
    facts,
    outboundRule: OUTBOUND_RULE,
    doctrine: AMBIENT_DOCTRINE,
    note: NOT_AN_ASSISTANT_NOTE,
    answersQuestions: false,
    observed: {
      proveRan: p.ran,
      proveAllowed: p.allowed,
      proveStale: p.stale,
      unbound: p.unbound,
      cautions: p.cautions,
      refused: p.refused,
      airGap,
      openCaveats: caveats,
      driftSeverity,
    },
  };
}

/**
 * The refusal, as a function.
 *
 * Every ambient assistant that answers a question about data it has merely
 * observed is guessing, and this one will not start. The reply names the
 * surface that can actually answer, so declining is a redirection rather than
 * a dead end.
 */
export function answerAmbientQuestion(question) {
  const q = str(question);
  return {
    answered: false,
    question: q,
    reason: 'This strip has no engine path to your data and will not infer an answer from what it can see.',
    redirect: 'Ask it in SQL, in the notebook, or through the Copilot, where the answer comes from a query you can read.',
  };
}

/** One line for a surface with no room for the facts. */
export function ambientChipLabel(strip) {
  if (!isPlainObject(strip)) return TONE_LABEL.idle;
  return TONE_LABEL[strip.tone] || TONE_LABEL.idle;
}

export const DataGlowAmbientProof = {
  AMBIENT_PROOF_KIND,
  AMBIENT_PROOF_VERSION,
  AMBIENT_TONES,
  AMBIENT_DOCTRINE,
  OUTBOUND_RULE,
  NOT_AN_ASSISTANT_NOTE,
  buildAmbientProofStrip,
  answerAmbientQuestion,
  ambientChipLabel,
};

try {
  if (typeof window !== 'undefined') window.DataGlowAmbientProof = DataGlowAmbientProof;
} catch (_e) {}
