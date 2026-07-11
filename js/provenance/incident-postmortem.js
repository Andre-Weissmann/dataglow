// ============================================================
// DATAGLOW — Blameless Incident Postmortem (draft generator)
// ============================================================
// When a validation finding is LATER confirmed to have been wrong — a value
// flagged as an outlier turns out legitimate (a false positive), or a value
// that passed validation is later found bad (a false negative) — this module
// drafts a blameless postmortem: a reconstructed timeline, a plain-English
// root-cause narrative, and a PROPOSED corrective change to a validation rule
// or metric. It is the "what went wrong, and what should we change" companion
// to the provenance chain (js/provenance/provenance.js), the assumption ledger
// (js/provenance/assumption-ledger.js), the analysis fingerprint and nutrition
// badges (js/provenance/analysis-fingerprint.js, js/provenance/nutrition-badges.js),
// the debate diagnostics (js/agents/debate-diagnostics.js) and the metrics
// registry (js/app-shell/metrics-registry.js).
//
// ABSOLUTE, NON-NEGOTIABLE RULE — THIS MODULE APPLIES NOTHING.
//   DATAGLOW never changes data, a validation rule, or the metrics registry
//   without the user's explicit per-action confirmation. This module only
//   DRAFTS a document. Every returned draft is labelled a PROPOSAL and carries
//   `isProposal: true` and `applied: false`. There is no function here that
//   mutates data, writes a rule, imports a pack, or registers a metric —
//   applying a proposed correction is a separate, explicit, human-triggered
//   action wired into the app shell (main.js), routed through the SAME
//   confirm-then-apply path a manually authored domain-pack rule uses. See
//   test/incident-postmortem.test.mjs, which asserts the source names no apply
//   primitive and mutates none of its inputs.
//
// TIMELINE HONESTY — THE TIMELINE IS RECONSTRUCTED, NEVER INVENTED.
//   Every provenance timeline entry is derived 1:1 from an entry the caller
//   supplied in `provenanceTrail` (a getTrail() array). This module adds no
//   logging system and fabricates no step. The only non-provenance marker on
//   the timeline is the incident-discovery moment, which comes straight from
//   the supplied `incident.discoveredAt` and is tagged `source: 'incident'` so
//   it is never mistaken for a recorded transformation.
//
// PURE + NO NETWORK + NO LLM. The narrative is a deterministic fixed template
// (in the spirit of js/agents/question-generator-agent.js), not a model call.
// This module runs no SQL, imports no rendering/network code, and returns plain
// data built only from its arguments.

export const POSTMORTEM_KIND = 'dataglow-incident-postmortem';
// Left at 1 intentionally: the `deidentification` and `dataBlame` reference keys
// added here are purely additive and opt-in — they appear ONLY when the caller
// supplies the matching input, so a draft produced without them is byte-identical
// to a v1 draft. `references` has always carried a variable key set, so no
// consumer that reads it can break. Bumping would falsely signal a breaking change.
export const POSTMORTEM_VERSION = 1;

export const POSTMORTEM_DISCLAIMER =
  'This is a DRAFT blameless postmortem generated from DATAGLOW’s own recorded '
  + 'provenance and audit data. Its timeline is reconstructed from the supplied '
  + 'provenance trail (no entry is invented), and the corrective change it '
  + 'describes is a PROPOSAL only — nothing is changed, cleaned, or applied '
  + 'unless you explicitly confirm it. It is not a legal, clinical, or '
  + 'regulatory determination.';

// The two ways a finding can turn out to have been wrong. Anything else is
// treated as an unclassified review.
export const FINDING_ERROR_KINDS = Object.freeze({
  FALSE_POSITIVE: 'false-positive', // flagged, but the value was legitimate
  FALSE_NEGATIVE: 'false-negative', // passed validation, but the value was bad
});

// ---- confidence scoring (the js/cleaning/fix-confidence.js pattern) ----------
// Same {score, label} shape and same 75 / 50 thresholds as scoreFixConfidence,
// applied to a proposed corrective change instead of a cleaning fix. The score
// is an explicit heuristic, never a gate that auto-applies anything.
function confidenceLabel(score) {
  if (score >= 75) return 'High confidence';
  if (score >= 50) return 'Medium confidence';
  return 'Low confidence — review recommended';
}

// Parse a timestamp (ms number, ISO string, or Date) to epoch ms, or null.
function toMs(t) {
  if (t == null) return null;
  if (t instanceof Date) { const n = t.getTime(); return Number.isFinite(n) ? n : null; }
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  const n = Date.parse(String(t));
  return Number.isFinite(n) ? n : null;
}

function toIso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Reconstruct a timeline from the SUPPLIED provenance trail plus the incident
 * discovery moment. Never fabricates a step: each returned `source:'provenance'`
 * entry corresponds exactly to one supplied trail entry.
 *
 * @param {Array} provenanceTrail  a getTrail() array (may be empty/absent)
 * @param {*} discoveredAt         when the finding was confirmed wrong
 * @returns {Array<{source,index?,op?,description?,detail?,ts,iso,phase}>}
 */
export function reconstructTimeline(provenanceTrail, discoveredAt) {
  const discMs = toMs(discoveredAt);
  const trail = Array.isArray(provenanceTrail) ? provenanceTrail : [];

  const events = trail.map((e) => {
    const ts = toMs(e && e.ts);
    return {
      source: 'provenance',
      index: e && e.index != null ? e.index : null,
      op: e && e.op != null ? e.op : null,
      description: e && e.description != null ? e.description : null,
      detail: e && e.detail !== undefined ? e.detail : null,
      ts,
      iso: toIso(ts),
      // Where this step sits relative to when the incident was discovered.
      phase: discMs == null || ts == null ? 'unknown' : (ts <= discMs ? 'before-discovery' : 'after-discovery'),
    };
  });

  // The discovery moment is supplied data (incident.discoveredAt), not a
  // recorded transformation — tag it distinctly so it is never confused with a
  // provenance step, and only include it when a real timestamp was supplied.
  if (discMs != null) {
    events.push({
      source: 'incident',
      op: 'incident-discovered',
      description: 'The finding was confirmed to have been wrong.',
      detail: null,
      ts: discMs,
      iso: toIso(discMs),
      phase: 'discovery',
    });
  }

  // Stable chronological order; entries with no timestamp keep their input
  // order at the front (nothing is dropped or synthesised).
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ta = a.e.ts, tb = b.e.ts;
      if (ta == null && tb == null) return a.i - b.i;
      if (ta == null) return -1;
      if (tb == null) return 1;
      return ta === tb ? a.i - b.i : ta - tb;
    })
    .map(({ e }) => e);
}

function normalizeFinding(f) {
  const finding = f && typeof f === 'object' ? f : {};
  const rawKind = typeof finding.kind === 'string' ? finding.kind.trim().toLowerCase() : null;
  let kind = 'unclassified';
  if (rawKind === FINDING_ERROR_KINDS.FALSE_POSITIVE) kind = FINDING_ERROR_KINDS.FALSE_POSITIVE;
  else if (rawKind === FINDING_ERROR_KINDS.FALSE_NEGATIVE) kind = FINDING_ERROR_KINDS.FALSE_NEGATIVE;
  return {
    label: finding.label != null ? String(finding.label) : null,
    column: finding.column != null ? String(finding.column) : null,
    layer: finding.layer != null ? String(finding.layer) : null,
    value: finding.value !== undefined ? finding.value : null,
    kind,
  };
}

// Optional cross-batch context, only populated from what the caller supplied.
// EVERY reference type here follows one rule: this module only READS and REPORTS
// what it was handed — it never re-runs a check, imports a dependency, or invents
// a claim. A key appears ONLY when its input was genuinely supplied and non-empty;
// an absent input leaves no null placeholder behind.
function buildReferences({ fingerprint, badges, debateResolution, metricInvolved, deidReport, blameSummary }) {
  const refs = {};
  const fpValue = fingerprint && fingerprint.digest && typeof fingerprint.digest.value === 'string'
    ? fingerprint.digest.value : null;
  if (fpValue) {
    refs.fingerprint = { digest: fpValue.slice(0, 16), label: fingerprint.label != null ? String(fingerprint.label) : null };
  }
  if (Array.isArray(badges) && badges.length) {
    refs.badges = badges
      .filter(b => b && b.id)
      .map(b => ({ id: String(b.id), label: b.label != null ? String(b.label) : null }));
  }
  const resolvedBy = debateResolution && debateResolution.resolvedBy != null ? String(debateResolution.resolvedBy) : null;
  if (resolvedBy) {
    refs.debateResolution = { resolvedBy };
  }
  if (metricInvolved != null) {
    const name = typeof metricInvolved === 'string'
      ? metricInvolved
      : (metricInvolved && (metricInvolved.name || metricInvolved.id)) || null;
    if (name) refs.metric = { name: String(name) };
  }

  // De-identification screen — a caller-supplied de-id report (buildDeidReport)
  // or its signed attestation (buildDeidAttestation) from
  // js/provenance/deidentification-verifier.js. We NEVER re-run the check here
  // (it needs DuckDB sampling and lives in that module); we only surface the
  // verdict it already produced, exactly like fingerprint/badges. HONESTY: we
  // carry the verifier's own vocabulary ('pass'/'review'/'fail' + a low/moderate/
  // high risk level) and never upgrade it into a stronger claim — the narrative
  // states plainly that this is a screening aid, not a certification.
  if (deidReport && typeof deidReport === 'object') {
    const verdict = typeof deidReport.verdict === 'string' ? deidReport.verdict : null;
    if (verdict) {
      const entry = { verdict };
      const reid = deidReport.reidentification && typeof deidReport.reidentification === 'object'
        ? deidReport.reidentification : null;
      if (reid && typeof reid.level === 'string') entry.riskLevel = reid.level;
      // If an attestation (not just a report) was passed, surface its digest
      // prefix as an integrity pointer — same 16-char convention as fingerprint.
      const digestVal = deidReport.digest && typeof deidReport.digest.value === 'string'
        ? deidReport.digest.value : null;
      if (digestVal) entry.digest = digestVal.slice(0, 16);
      refs.deidentification = entry;
    }
  }

  // Cell-level data-blame — a plain-English one-line column history.
  // ARCHITECTURE NOTE (judgment call): although data-blame is a PURE re-projection
  // of the same provenanceTrail this module already accepts, we take it as a
  // PRE-COMPUTED value (the caller runs summarizeColumnBlame in
  // js/provenance/data-blame.js) rather than computing it inline. Reason: the
  // module's safety contract — enforced by test/incident-postmortem.test.mjs —
  // requires this file to import NOTHING, so it provably cannot reach an apply
  // path. Importing data-blame.js to compute the summary would break that
  // guarantee. Accepting the summary keeps the "caller computes, we only report"
  // pattern identical to fingerprint/badges/deidReport above.
  if (typeof blameSummary === 'string' && blameSummary.trim() !== '') {
    refs.dataBlame = { summary: blameSummary.trim() };
  } else if (blameSummary && typeof blameSummary === 'object') {
    const s = typeof blameSummary.summary === 'string' ? blameSummary.summary.trim() : '';
    if (s !== '') {
      const entry = { summary: s };
      if (typeof blameSummary.changeCount === 'number') entry.changeCount = blameSummary.changeCount;
      refs.dataBlame = entry;
    }
  }
  return refs;
}

// Deterministic, template-based root-cause narrative. Plain English assembled
// only from supplied facts — no model call, no fabricated cause.
function buildNarrative(finding, timeline, references, ledgerEntries) {
  const lines = [];
  const where = finding.column ? ` on column “${finding.column}”` : '';
  const named = finding.label ? ` (“${finding.label}”)` : '';
  lines.push(`A validation finding${named}${where} was reported to have been wrong.`);

  if (finding.kind === FINDING_ERROR_KINDS.FALSE_POSITIVE) {
    lines.push(
      `It was flagged${finding.layer ? ` by the ${finding.layer} layer` : ''}, but the value has since been `
      + 'confirmed legitimate — a false positive. The rule that fired was stricter than the data warranted.');
  } else if (finding.kind === FINDING_ERROR_KINDS.FALSE_NEGATIVE) {
    lines.push(
      `The value passed validation${finding.layer ? ` (the ${finding.layer} layer raised nothing)` : ''} but was later `
      + 'found to be bad — a false negative. The relevant rule did not catch a case it should have.');
  } else {
    lines.push('The finding is under blameless review; the specific error type was not classified by the reporter.');
  }

  const provSteps = timeline.filter(e => e.source === 'provenance');
  if (provSteps.length) {
    const lastBefore = [...provSteps].reverse().find(e => e.phase === 'before-discovery') || provSteps[provSteps.length - 1];
    lines.push(
      `The provenance trail records ${provSteps.length} transformation step(s) leading up to this result`
      + (lastBefore && lastBefore.op ? `; the most recent before discovery was “${lastBefore.op}: ${lastBefore.description || ''}”.` : '.'));
  } else {
    lines.push('No provenance steps were supplied for this dataset, so the timeline covers only the discovery event.');
  }

  if (references.debateResolution) {
    lines.push('An on-device debate-panel resolution was involved in the original answer (see the debate diagnostics for the per-viewpoint reasoning).');
  }
  if (references.fingerprint) {
    lines.push(`The affected result carries an analysis fingerprint (${references.fingerprint.digest}…), so the exact computation under review can be reproduced and checked.`);
  }
  if (references.metric) {
    lines.push(`The finding involves the “${references.metric.name}” metric definition from the metrics registry.`);
  }
  if (references.deidentification) {
    const v = references.deidentification.verdict;
    const risk = references.deidentification.riskLevel;
    const verdictPhrase = v === 'pass'
      ? 'passed the automated HIPAA Safe Harbor de-identification screen'
      : v === 'fail'
        ? 'was flagged by the automated HIPAA Safe Harbor de-identification screen'
        : `was marked “${v}” by the automated HIPAA Safe Harbor de-identification screen`;
    lines.push(
      `This dataset ${verdictPhrase}${risk ? ` (re-identification risk: ${risk})` : ''} — `
      + 'a screening aid only, not a certification of de-identification.');
  }
  if (references.dataBlame) {
    lines.push(`The affected column’s recorded change history — ${references.dataBlame.summary}`);
  }
  if (Array.isArray(ledgerEntries) && ledgerEntries.length) {
    lines.push(`${ledgerEntries.length} recorded judgment-call(s) from the assumption ledger are attached for context.`);
  }

  lines.push('This is a blameless review: the aim is to improve the rule or metric, not to assign fault.');
  return lines.join(' ');
}

/**
 * Propose ONE corrective change with a confidence score. Deterministic and
 * describe-only — it returns a description of a change plus a heuristic safety
 * score; it never performs the change.
 */
export function proposeCorrection(finding, { references, timeline } = {}) {
  const refs = references || {};
  const provSteps = Array.isArray(timeline) ? timeline.filter(e => e.source === 'provenance') : [];
  const target = finding.column
    ? `${finding.layer ? finding.layer + ' rule for ' : 'rule for '}column “${finding.column}”`
    : (finding.layer ? `the ${finding.layer} rule` : 'the affected validation rule');

  let kind, summary, base;
  if (refs.metric) {
    kind = 'revise-metric';
    summary = `Revise the “${refs.metric.name}” metric definition so this case is handled correctly, then re-validate.`;
    base = 50; // touches a downstream definition — most caution
  } else if (finding.kind === FINDING_ERROR_KINDS.FALSE_POSITIVE) {
    // Loosen / add annotate-only context so the legitimate value stops firing.
    kind = 'add-outlier-context';
    summary = `Add an annotate-only context exception to ${target} so legitimate values like this are no longer flagged.`;
    base = 70; // annotate-only, non-destructive — safest kind
  } else if (finding.kind === FINDING_ERROR_KINDS.FALSE_NEGATIVE) {
    kind = 'tighten-validation-rule';
    summary = `Tighten ${target} so the case it missed is caught next time, then re-validate on past data.`;
    base = 55; // tightening can create new false positives — moderate caution
  } else {
    kind = 'review-finding';
    summary = `Review ${target} with the reporter to classify the error before changing any rule.`;
    base = 60;
  }

  // Evidence adjusts confidence: concrete provenance, a fingerprinted result,
  // and a debate resolution each make the proposal more grounded.
  // NOTE (judgment call): the de-identification screen and the data-blame summary
  // deliberately DO NOT adjust this score. A de-id verdict is about privacy risk,
  // orthogonal to whether a validation finding was a false positive/negative, so
  // it is no evidence for the CORRECTION's confidence. The blame summary is a
  // re-projection of the SAME provenanceTrail that already contributes the +10
  // above — rewarding it again would double-count one piece of evidence. Both are
  // reported for context (references + narrative) without inflating confidence,
  // consistent with how `badges` are referenced but never scored.
  let score = base;
  if (provSteps.length) score += 10;
  if (refs.fingerprint) score += 5;
  if (refs.debateResolution) score += 5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    kind,
    target,
    summary,
    // The apply path (main.js) reads this to route through the existing
    // confirm-then-apply flow; it is a description, not an executed action.
    applyVia: kind === 'revise-metric' ? 'metrics-registry-review' : 'domain-pack-rule',
    confidence: { score, label: confidenceLabel(score) },
    staged: false,
  };
}

/**
 * Draft a blameless incident postmortem. PURE: builds a plain-data draft from
 * its arguments only, mutates nothing, applies nothing.
 *
 * @param {object} args
 * @param {object} args.incident                 { description, discoveredAt, affectedFinding } (required)
 * @param {Array}  [args.provenanceTrail]        a getTrail() array (js/provenance/provenance.js)
 * @param {Array}  [args.assumptionLedger]       getLedgerEntries() array (js/provenance/assumption-ledger.js)
 * @param {object} [args.fingerprint]            an analysis-fingerprint record (Batch 3)
 * @param {Array}  [args.badges]                 computeBadges() output (Batch 3)
 * @param {object} [args.debateResolution]       a resolve() return value (Batch 2)
 * @param {*}      [args.metricInvolved]         a metrics-registry metric name/def (Batch 1)
 * @param {object} [args.deidReport]             a buildDeidReport()/buildDeidAttestation() result (Provenance Packet) — read-only, never re-run here
 * @param {string|object} [args.blameSummary]    a summarizeColumnBlame() one-liner (or {summary, changeCount}) — pre-computed by the caller; see buildReferences' architecture note
 * @param {object} [meta]                         { generatedAt } descriptive only
 * @returns {object} a self-describing PROPOSAL draft (applied:false)
 */
export function draftPostmortem(args = {}, meta = {}) {
  const incidentIn = args.incident && typeof args.incident === 'object' ? args.incident : {};
  const finding = normalizeFinding(incidentIn.affectedFinding);
  const discoveredAt = incidentIn.discoveredAt ?? null;
  const discoveredMs = toMs(discoveredAt);

  const references = buildReferences({
    fingerprint: args.fingerprint,
    badges: args.badges,
    debateResolution: args.debateResolution,
    metricInvolved: args.metricInvolved,
    deidReport: args.deidReport,
    blameSummary: args.blameSummary,
  });

  const timeline = reconstructTimeline(args.provenanceTrail, discoveredAt);
  const ledgerEntries = Array.isArray(args.assumptionLedger)
    ? args.assumptionLedger.map(e => ({
        ts: e && e.ts != null ? e.ts : null,
        source: e && e.source != null ? String(e.source) : null,
        action: e && e.action != null ? String(e.action) : null,
        detail: e && e.detail !== undefined ? e.detail : null,
      }))
    : [];

  const narrative = buildNarrative(finding, timeline, references, ledgerEntries);
  const proposedCorrection = proposeCorrection(finding, { references, timeline });

  return {
    kind: POSTMORTEM_KIND,
    version: POSTMORTEM_VERSION,
    isProposal: true,
    applied: false, // this module never applies anything; only main.js, on explicit confirm, does
    generatedAt: meta.generatedAt != null ? new Date(meta.generatedAt).toISOString() : new Date().toISOString(),
    incident: {
      description: incidentIn.description != null ? String(incidentIn.description) : null,
      discoveredAt: toIso(discoveredMs),
      affectedFinding: finding,
    },
    timeline,
    rootCause: { narrative },
    proposedCorrection,
    references,
    assumptionLedger: ledgerEntries,
    disclaimer: POSTMORTEM_DISCLAIMER,
  };
}
