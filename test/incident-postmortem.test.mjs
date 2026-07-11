// ============================================================
// DATAGLOW — Blameless Incident Postmortem test suite (Batch 4)
// ============================================================
// Proves js/provenance/incident-postmortem.js:
//   (a) builds the draft ENTIRELY from supplied data — every provenance
//       timeline entry maps 1:1 to a supplied trail entry; no step is invented,
//   (b) works with ONLY the required `incident` field (all optionals omitted),
//   (c) works with ALL optionals present and correctly references the
//       fingerprint / badges / debate resolution / metric / de-id / data-blame,
//   (c2) a de-id report (pass and fail) and a data-blame summary are referenced
//       and woven into the narrative WITHOUT upgrading the claim strength, and
//       are absent (no null placeholder) when not supplied,
//   (d) NEVER applies anything itself — the source names no apply/network
//       primitive and no call mutates its inputs,
//   (e) the proposed correction carries a fix-confidence.js-style {score,label},
//   (f) zero network references in the module source.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/incident-postmortem.test.mjs

import {
  draftPostmortem, reconstructTimeline, proposeCorrection,
  POSTMORTEM_KIND, FINDING_ERROR_KINDS,
} from '../js/provenance/incident-postmortem.js';
// Real dependency modules the postmortem now optionally references. Used here to
// produce genuine (not hand-faked) inputs, exercising the real integration shape.
import { buildDeidReport } from '../js/provenance/deidentification-verifier.js';
import { summarizeColumnBlame } from '../js/provenance/data-blame.js';
import { scanSourceForNetwork } from '../js/packs/pack-network-guard.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(__dirname, '..', 'js', 'provenance', 'incident-postmortem.js');
const MODULE_SOURCE = readFileSync(MODULE_PATH, 'utf8');

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// A small, realistic getTrail() array (js/provenance/provenance.js shape).
const T0 = Date.parse('2026-07-10T09:00:00.000Z');
function sampleTrail() {
  return [
    { index: 0, op: 'load', description: 'Loaded patients.csv', detail: { rows: 500 }, contentHash: 'aa', ts: T0, parentHash: '0'.repeat(64), hash: 'h0' },
    { index: 1, op: 'clean', description: 'Trimmed whitespace — name', detail: { column: 'name' }, contentHash: null, ts: T0 + 60000, parentHash: 'h0', hash: 'h1' },
    { index: 2, op: 'validate', description: 'Ran validation layers', detail: null, contentHash: null, ts: T0 + 120000, parentHash: 'h1', hash: 'h2' },
  ];
}
const DISCOVERED = T0 + 3600000; // one hour after load

function main() {
  // ---------- (b) minimal: only the required incident field ----------
  const minimal = draftPostmortem({
    incident: { description: 'BP 210 flagged as outlier but the patient really had it.' },
  });
  ok(minimal.kind === POSTMORTEM_KIND, 'minimal: correct kind');
  ok(minimal.isProposal === true && minimal.applied === false, 'minimal: labelled PROPOSAL, applied=false');
  ok(Array.isArray(minimal.timeline) && minimal.timeline.length === 0,
    'minimal: no trail + no discoveredAt → empty timeline (nothing invented)');
  ok(minimal.proposedCorrection && minimal.proposedCorrection.confidence
    && typeof minimal.proposedCorrection.confidence.score === 'number',
    'minimal: still yields a proposed correction with a confidence score');
  ok(minimal.references && Object.keys(minimal.references).length === 0,
    'minimal: no optional references present');
  ok(typeof minimal.rootCause.narrative === 'string' && minimal.rootCause.narrative.length > 0,
    'minimal: non-empty root-cause narrative');

  // ---------- (a) timeline built ONLY from supplied trail ----------
  const trail = sampleTrail();
  const draft = draftPostmortem({
    incident: {
      description: 'A value flagged by the range layer was legitimate.',
      discoveredAt: DISCOVERED,
      affectedFinding: { label: 'BP out of range', column: 'systolic_bp', layer: 'range', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE },
    },
    provenanceTrail: trail,
  });

  const provEntries = draft.timeline.filter(e => e.source === 'provenance');
  ok(provEntries.length === trail.length, 'timeline: one provenance entry per supplied trail entry');
  // Every provenance timeline entry must correspond to a real supplied trail entry.
  const trailKeys = new Set(trail.map(e => `${e.index}|${e.op}|${e.description}|${e.ts}`));
  const allTraceable = provEntries.every(e => trailKeys.has(`${e.index}|${e.op}|${e.description}|${e.ts}`));
  ok(allTraceable, 'timeline: every provenance entry traces 1:1 to a supplied trail entry (none fabricated)');

  const incidentMarkers = draft.timeline.filter(e => e.source === 'incident');
  ok(incidentMarkers.length === 1 && incidentMarkers[0].ts === DISCOVERED,
    'timeline: exactly one discovery marker, from supplied incident.discoveredAt');
  ok(draft.timeline.length === trail.length + 1,
    'timeline: length is trail entries + the single discovery marker (nothing else)');

  // Chronological ordering.
  const times = draft.timeline.map(e => e.ts);
  const sorted = [...times].every((t, i) => i === 0 || times[i - 1] <= t);
  ok(sorted, 'timeline: entries are in chronological order');

  // Phase tagging: all sample steps precede discovery.
  ok(provEntries.every(e => e.phase === 'before-discovery'),
    'timeline: sample steps tagged before-discovery relative to the incident');

  // reconstructTimeline never invents an entry when given an empty trail.
  ok(reconstructTimeline([], null).length === 0, 'reconstructTimeline: empty trail + no discovery → empty');
  ok(reconstructTimeline(undefined, DISCOVERED).length === 1, 'reconstructTimeline: only discovery marker when no trail');

  // ---------- (c) all optionals present and referenced ----------
  const full = draftPostmortem({
    incident: {
      description: 'A value that passed validation was later found bad.',
      discoveredAt: DISCOVERED,
      affectedFinding: { label: 'Impossible age', column: 'age', layer: 'physiology', kind: FINDING_ERROR_KINDS.FALSE_NEGATIVE },
    },
    provenanceTrail: trail,
    assumptionLedger: [{ ts: T0, source: 'Data Cleaning', action: 'Trimmed name', detail: null }],
    fingerprint: { kind: 'dataglow-analysis-fingerprint', label: 'age check', digest: { value: 'abcdef0123456789cafebabe' } },
    badges: [{ id: 'validated', label: 'Validated' }, { id: 'fingerprinted', label: 'Fingerprinted' }],
    debateResolution: { resolvedBy: 'C', debate: {} },
    metricInvolved: { name: 'max_plausible_age' },
  });
  ok(full.references.fingerprint && full.references.fingerprint.digest === 'abcdef0123456789',
    'optionals: fingerprint digest referenced (16-char prefix)');
  ok(Array.isArray(full.references.badges) && full.references.badges.length === 2,
    'optionals: badges referenced');
  ok(full.references.debateResolution && full.references.debateResolution.resolvedBy === 'C',
    'optionals: debate resolution referenced');
  ok(full.references.metric && full.references.metric.name === 'max_plausible_age',
    'optionals: metric referenced');
  ok(full.assumptionLedger.length === 1, 'optionals: assumption-ledger entries carried through');
  // A metric-involved incident proposes a metric revision.
  ok(full.proposedCorrection.kind === 'revise-metric',
    'optionals: metric-involved incident proposes a metric revision');
  // Narrative mentions the supplied metric name (built from supplied data only).
  ok(full.rootCause.narrative.includes('max_plausible_age'),
    'optionals: narrative references the supplied metric');

  // A metric name given as a bare string also resolves.
  const strMetric = draftPostmortem({ incident: { description: 'x' }, metricInvolved: 'completeness_pct' });
  ok(strMetric.references.metric && strMetric.references.metric.name === 'completeness_pct',
    'optionals: metric supplied as a bare string is referenced');

  // ---------- (c2) de-identification report + data-blame summary references ----------
  // A genuinely clean dataset → 'pass'; a dataset with an SSN column → 'fail'.
  const deidPass = buildDeidReport({
    columns: [{ name: 'visit_count', type: 'INTEGER' }, { name: 'systolic_bp', type: 'INTEGER' }],
    samples: { visit_count: [1, 2, 3], systolic_bp: [120, 130, 140] },
    table: 'visits', rowCount: 500,
  });
  ok(deidPass.verdict === 'pass', 'c2 setup: a clean dataset yields a de-id verdict of pass');
  const deidFail = buildDeidReport({
    columns: [{ name: 'ssn', type: 'VARCHAR' }, { name: 'zip', type: 'VARCHAR' }],
    samples: { ssn: ['123-45-6789', '987-65-4321'], zip: ['02139', '10001'] },
    table: 'patients', rowCount: 500,
  });
  ok(deidFail.verdict === 'fail', 'c2 setup: a dataset with an SSN column yields a de-id verdict of fail');

  // (1a) Passing de-id report referenced + narrated, claim never upgraded.
  const withDeidPass = draftPostmortem({
    incident: { description: 'x', affectedFinding: { column: 'age', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE } },
    deidReport: deidPass,
  });
  ok(withDeidPass.references.deidentification && withDeidPass.references.deidentification.verdict === 'pass',
    'c2: passing de-id report is referenced with its real verdict');
  ok(withDeidPass.references.deidentification.riskLevel === deidPass.reidentification.level,
    'c2: de-id reference carries the report’s own re-identification risk level');
  ok(/screening aid only, not a certification/.test(withDeidPass.rootCause.narrative),
    'c2: narrative states the de-id screen is a screening aid, not a certification');
  ok(!/certified|verified safe|safe to release|guaranteed/i.test(withDeidPass.rootCause.narrative),
    'c2: narrative NEVER upgrades the de-id claim into a stronger one');
  ok(/passed the automated HIPAA Safe Harbor de-identification screen/.test(withDeidPass.rootCause.narrative),
    'c2: passing verdict is narrated honestly');

  // (1b) Failing/risky de-id report narrated as flagged, still no upgrade.
  const withDeidFail = draftPostmortem({
    incident: { description: 'x', affectedFinding: { column: 'age', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE } },
    deidReport: deidFail,
  });
  ok(withDeidFail.references.deidentification.verdict === 'fail',
    'c2: failing de-id report is referenced with verdict fail');
  ok(/was flagged by the automated HIPAA Safe Harbor de-identification screen/.test(withDeidFail.rootCause.narrative),
    'c2: failing verdict is narrated as flagged');
  ok(!/certified|verified safe|safe to release/i.test(withDeidFail.rootCause.narrative),
    'c2: a fail verdict is never spun into a safety claim either');

  // (1c) A signed attestation-shaped input (has a digest) surfaces a digest prefix.
  const withDeidAtt = draftPostmortem({
    incident: { description: 'x' },
    deidReport: { verdict: 'review', reidentification: { level: 'moderate' }, digest: { value: 'deadbeefcafef00d0123456789abcdef' } },
  });
  ok(withDeidAtt.references.deidentification.digest === 'deadbeefcafef00d',
    'c2: an attestation-shaped de-id input surfaces a 16-char digest prefix');
  ok(withDeidAtt.references.deidentification.riskLevel === 'moderate',
    'c2: a "review" verdict with moderate risk is carried through');

  // (2) No de-id report supplied → the key is ABSENT (not null).
  const noDeid = draftPostmortem({ incident: { description: 'x' }, provenanceTrail: trail });
  ok(!('deidentification' in noDeid.references),
    'c2: no de-id report supplied → references has no deidentification key at all');
  // A malformed de-id input with no verdict also adds no key.
  const badDeid = draftPostmortem({ incident: { description: 'x' }, deidReport: { foo: 'bar' } });
  ok(!('deidentification' in badDeid.references),
    'c2: a de-id input with no verdict is ignored (no key), never a null placeholder');

  // (3) Data-blame summary — real summary from a trail with a recorded change to
  // the finding's column, then the no-change / no-input cases.
  const nameBlame = summarizeColumnBlame(trail, 'name'); // sampleTrail has a clean step on "name"
  ok(/recorded change/.test(nameBlame), 'c2 setup: summarizeColumnBlame reports the recorded change on "name"');
  const withBlame = draftPostmortem({
    incident: { description: 'x', affectedFinding: { column: 'name', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE } },
    blameSummary: nameBlame,
  });
  ok(withBlame.references.dataBlame && withBlame.references.dataBlame.summary === nameBlame,
    'c2: a supplied data-blame summary string is referenced verbatim');
  ok(withBlame.rootCause.narrative.includes(nameBlame),
    'c2: the data-blame summary is woven into the narrative');
  // Object form with a change count.
  const withBlameObj = draftPostmortem({
    incident: { description: 'x' },
    blameSummary: { summary: '"age": 2 recorded changes (fill_mean → clamp).', changeCount: 2 },
  });
  ok(withBlameObj.references.dataBlame.changeCount === 2 && /2 recorded changes/.test(withBlameObj.references.dataBlame.summary),
    'c2: an object-form blame summary keeps its summary text and change count');
  // No blame supplied → no key. A "no recorded changes" line is a real summary and IS kept.
  const noBlame = draftPostmortem({ incident: { description: 'x' } });
  ok(!('dataBlame' in noBlame.references),
    'c2: no blame summary supplied → references has no dataBlame key at all');
  const emptyBlame = draftPostmortem({ incident: { description: 'x' }, blameSummary: '   ' });
  ok(!('dataBlame' in emptyBlame.references),
    'c2: a blank blame string is ignored (no key), never a null placeholder');

  // (4) ALL SIX optional references present together, all appear correctly.
  const allSix = draftPostmortem({
    incident: {
      description: 'Everything at once.', discoveredAt: DISCOVERED,
      affectedFinding: { label: 'X', column: 'age', layer: 'physiology', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE },
    },
    provenanceTrail: trail,
    fingerprint: { label: 'age check', digest: { value: 'abcdef0123456789cafebabe' } },
    badges: [{ id: 'validated', label: 'Validated' }],
    debateResolution: { resolvedBy: 'C' },
    metricInvolved: { name: 'max_plausible_age' },
    deidReport: deidPass,
    blameSummary: summarizeColumnBlame(trail, 'name'),
  });
  const refKeys = Object.keys(allSix.references).sort();
  ok(['badges', 'dataBlame', 'debateResolution', 'deidentification', 'fingerprint', 'metric'].every(k => refKeys.includes(k)),
    'c2: all six optional reference types appear together');
  ok(refKeys.length === 6, 'c2: exactly the six supplied reference keys, no extras/placeholders');
  ok(allSix.references.deidentification.verdict === 'pass' && allSix.references.dataBlame.summary.includes('name'),
    'c2: the two new references carry correct values alongside the original four');
  // C: neither new reference inflates the correction confidence (score derives
  // only from provenance/fingerprint/debate, exactly as before this change).
  // Control differs from `allSix` ONLY by dropping the de-id report + blame
  // summary — every score-bearing input (provenance/fingerprint/debate) and the
  // metricInvolved that sets the correction kind is kept identical.
  const scoreWithout = draftPostmortem({
    incident: { description: 'x', discoveredAt: DISCOVERED, affectedFinding: { label: 'X', column: 'age', layer: 'physiology', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE } },
    provenanceTrail: trail,
    fingerprint: { label: 'age check', digest: { value: 'abcdef0123456789cafebabe' } },
    badges: [{ id: 'validated', label: 'Validated' }],
    debateResolution: { resolvedBy: 'C' },
    metricInvolved: { name: 'max_plausible_age' },
  }).proposedCorrection.confidence.score;
  ok(allSix.proposedCorrection.confidence.score === scoreWithout,
    'c2/C: adding a de-id report + blame summary does NOT change the correction confidence score');

  // ---------- (e) proposed correction confidence (fix-confidence pattern) ----------
  const fp = draftPostmortem({
    incident: { description: 'fp', affectedFinding: { column: 'systolic_bp', layer: 'range', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE } },
    provenanceTrail: trail,
  }).proposedCorrection;
  ok(fp.kind === 'add-outlier-context', 'correction: false positive → annotate-only outlier context');
  ok(fp.confidence.score >= 0 && fp.confidence.score <= 100, 'correction: score within 0..100');
  ok(['High confidence', 'Medium confidence', 'Low confidence — review recommended'].includes(fp.confidence.label),
    'correction: label matches the fix-confidence.js vocabulary');
  ok(fp.staged === false, 'correction: staged=false by default (not applied)');

  const fn = draftPostmortem({
    incident: { description: 'fn', affectedFinding: { column: 'age', layer: 'physiology', kind: FINDING_ERROR_KINDS.FALSE_NEGATIVE } },
  }).proposedCorrection;
  ok(fn.kind === 'tighten-validation-rule', 'correction: false negative → tighten the rule');

  const unclassified = draftPostmortem({ incident: { description: 'unknown', affectedFinding: {} } }).proposedCorrection;
  ok(unclassified.kind === 'review-finding', 'correction: unclassified → review-finding');

  // Evidence raises confidence: same false-positive, with vs without provenance/fingerprint/debate.
  const bare = proposeCorrection({ column: 'x', layer: 'range', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE }, { references: {}, timeline: [] });
  const grounded = proposeCorrection(
    { column: 'x', layer: 'range', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE },
    { references: { fingerprint: { digest: 'abc' }, debateResolution: { resolvedBy: 'C' } }, timeline: [{ source: 'provenance' }] });
  ok(grounded.confidence.score > bare.confidence.score,
    'correction: supporting evidence raises the confidence score');

  // ---------- (d) module applies NOTHING — static source guarantees ----------
  const APPLY_TOKENS = ['importPack', 'registerRuntimePack', 'applyFix', 'recordStep', 'logAssumption', 'defineMetric', 'localStorage'];
  const strippedish = MODULE_SOURCE; // token presence check (comments included) — must be truly absent
  ok(APPLY_TOKENS.every(tok => !strippedish.includes(tok + '(')),
    'no-apply: source calls no apply/mutation primitive');
  // The module imports nothing (it is self-contained), so it cannot reach an apply path.
  ok(!/^\s*import\s/m.test(MODULE_SOURCE), 'no-apply: module has no imports (cannot reach an apply path)');
  ok(draftPostmortem.length >= 0 && typeof draftPostmortem === 'function', 'no-apply: draftPostmortem is a plain function');

  // Inputs are not mutated by drafting.
  const frozenTrail = sampleTrail().map(Object.freeze);
  Object.freeze(frozenTrail);
  const badges = Object.freeze([Object.freeze({ id: 'validated', label: 'Validated' })]);
  const ledger = Object.freeze([Object.freeze({ ts: T0, source: 's', action: 'a', detail: null })]);
  const incidentArg = Object.freeze({
    description: 'immutability check', discoveredAt: DISCOVERED,
    affectedFinding: Object.freeze({ column: 'systolic_bp', layer: 'range', kind: FINDING_ERROR_KINDS.FALSE_POSITIVE }),
  });
  let threw = false;
  try {
    draftPostmortem({ incident: incidentArg, provenanceTrail: frozenTrail, badges, assumptionLedger: ledger });
  } catch (e) { threw = true; }
  ok(!threw, 'no-apply: drafting frozen inputs does not throw (it never writes to them)');
  ok(frozenTrail.length === 3 && frozenTrail[0].op === 'load', 'no-apply: supplied trail is unchanged after drafting');

  // ---------- (f) zero network ----------
  const netViolations = scanSourceForNetwork(MODULE_SOURCE);
  ok(netViolations.length === 0,
    `no-network: module references no network primitive${netViolations.length ? ' — ' + netViolations.map(v => v.primitive).join(', ') : ''}`);

  // ---------- summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
