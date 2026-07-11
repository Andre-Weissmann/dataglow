// ============================================================
// DATAGLOW — Denial Root-Cause Profiler (healthcare claims)
// ============================================================
// Given a loaded, claims-shaped dataset, this buckets likely claim-denial risk
// into the real-world canonical categories a revenue-cycle team recognises —
// eligibility/registration, coding, duplicate/near-duplicate claims, missing or
// invalid provider/NPI, and coordination-of-benefits (COB) signals — and reports
// the count/percentage of rows flagged per bucket with example rows.
//
// It is deliberately SCHEMA-TOLERANT: healthcare claims exports never share one
// rigid column layout, so the profiler detects the ROLE of each column by name
// (`detectClaimColumns`) and grades only what it can actually see. When a column
// a check needs is absent, the check is reported as NOT APPLICABLE with a plain
// reason ("no member/subscriber ID column found") rather than silently passing —
// so an absent column can never read as a clean bill of health.
//
// It runs 100% client-side against the in-browser DuckDB-WASM data (one bounded
// `SELECT *` per profile; all bucketing is pure JS over the fetched rows) — no
// upload, no external API, no ML. Like the rest of the Provenance Packet, an
// optional signed attestation reuses the SAME Web-Crypto `sha256Hex` primitive
// from js/provenance/provenance.js — no new crypto is introduced.
//
// HONEST LABELLING: these are heuristic RISK signals for triage, not payer
// adjudication. A flag means "worth a human look before submission", never "this
// claim will be denied"; clinical CPT-to-diagnosis appropriateness needs a code
// crosswalk that is not bundled and is reported as unchecked.

import { sha256Hex } from './provenance.js';
import { estimateCostOfBadData } from './cost-of-bad-data.js';

// ---- column-role detection -------------------------------------------------

// Ordered so that a more specific role claims a column before a generic one
// (e.g. payerSecondary before payerPrimary, npi before provider). Each column is
// assigned to at most one role; the first role whose pattern matches an as-yet
// unclaimed column wins.
const ROLE_PATTERNS = [
  ['claimId', /claim[\s_-]?(id|no|num|number)/i],
  ['memberId', /((member|subscriber|beneficiary|insured|enrollee)[\s_-]?(id|no|num|number)?)|(patient[\s_-]?(id|mrn))|(subscriber)|(member[\s_-]?id)/i],
  ['dos', /(date[\s_-]?of[\s_-]?service|(^|[\s_-])dos([\s_-]|$)|service[\s_-]?date|svc[\s_-]?date|servicedate|from[\s_-]?date)/i],
  ['cpt', /(cpt|hcpcs|procedure[\s_-]?code|proc[\s_-]?code|service[\s_-]?code|procedurecode)/i],
  ['modifier', /(modifier|cpt[\s_-]?mod|proc[\s_-]?mod|(^|[\s_-])mod([\s_-]|$))/i],
  ['dx', /(diagnosis|dx[\s_-]?code|(^|[\s_-])dx([\s_-]|$)|icd([\s_-]?10|[\s_-]?9)?([\s_-]?code)?|diag[\s_-]?code)/i],
  ['coverageStart', /((coverage|eligibility|elig|enrollment|effective)[\s_-]?(date|start|from|eff))/i],
  ['coverageEnd', /((coverage|eligibility|elig|enrollment|term(ination)?)[\s_-]?(end|thru|through|to))/i],
  ['npi', /(npi|national[\s_-]?provider)/i],
  ['provider', /(provider|rendering|billing[\s_-]?provider|servicing[\s_-]?provider)/i],
  ['payerSecondary', /(secondary[\s_-]?(payer|payor|insurance|ins)|payer[\s_-]?2|payor[\s_-]?2|(^|[\s_-])cob([\s_-]|$)|other[\s_-]?insurance|tertiary[\s_-]?(payer|payor))/i],
  ['payerPrimary', /(payer|payor|carrier|insurance|health[\s_-]?plan|(^|[\s_-])plan([\s_-]|$)|primary[\s_-]?(payer|payor|ins))/i],
  ['status', /(claim[\s_-]?status|(^|[\s_-])status([\s_-]|$)|adjudication)/i],
  ['denialReason', /(denial|denied|adjustment[\s_-]?reason|(^|[\s_-])carc([\s_-]|$)|(^|[\s_-])rarc([\s_-]|$)|reason[\s_-]?code)/i],
  ['billedAmount', /(billed|charge|(^|[\s_-])amount([\s_-]|$)|total[\s_-]?charge|submitted[\s_-]?amount)/i],
];

// A broad "looks like a payer/insurance column" test used only to count how many
// payer-ish columns exist (COB needs at least two), independent of role
// assignment above.
const PAYER_LIKE = /(payer|payor|carrier|insurance|(^|[\s_-])ins([\s_-]|$)|health[\s_-]?plan|(^|[\s_-])plan([\s_-]|$))/i;

export function detectClaimColumns(columns = []) {
  const cols = (Array.isArray(columns) ? columns : []).map(c => (typeof c === 'string' ? { name: c } : c));
  const map = {};
  const claimed = new Set();
  for (const [role, pattern] of ROLE_PATTERNS) {
    for (const c of cols) {
      if (claimed.has(c.name)) continue;
      if (pattern.test(c.name)) { map[role] = c.name; claimed.add(c.name); break; }
    }
    if (!(role in map)) map[role] = null;
  }
  const payerLikeColumns = cols.filter(c => PAYER_LIKE.test(c.name)).map(c => c.name);
  const present = Object.keys(map).filter(r => map[r]);
  const absent = Object.keys(map).filter(r => !map[r]);
  return { map, payerLikeColumns, present, absent };
}

// ---- small value helpers ---------------------------------------------------

function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

function claimLabel(row, colmap, i) {
  const id = colmap.claimId ? row[colmap.claimId] : null;
  return !isBlank(id) ? String(id) : `row ${i + 1}`;
}

// CPT/HCPCS: 5 characters — either five digits, or one letter followed by four
// digits (HCPCS Level II). We only validate SHAPE, never clinical validity.
const CPT_RE = /^(\d{5}|[A-Za-z]\d{4})$/;
// ICD-10-CM diagnosis shape: a letter, two alphanumerics, optional dot + up to
// four more. Shape only.
const ICD10_RE = /^[A-TV-Za-tv-z]\d[0-9A-Za-z](\.?[0-9A-Za-z]{1,4})?$/;

// NPI: 10 digits whose final digit is a Luhn check over the constant "80840"
// prefix + the first nine digits (the CMS NPI check-digit algorithm).
export function isValidNpi(npi) {
  const s = String(npi ?? '').trim();
  if (!/^\d{10}$/.test(s)) return false;
  const base = '80840' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = base.charCodeAt(base.length - 1 - i) - 48;
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (s.charCodeAt(9) - 48);
}

function daysBetween(a, b) {
  const ta = Date.parse(a); const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(ta - tb) / 86400000;
}

// A category result. `flaggedIndices` lets the report union flags across
// categories without double-counting a row.
function category({ id, label, applicable, checked = [], missing = [], flaggedIndices = [], examples = [], notes = [] }, total) {
  const flaggedCount = flaggedIndices.length;
  return {
    id, label, applicable,
    checked, missing, notes,
    flaggedCount,
    pct: applicable && total > 0 ? Math.round((flaggedCount / total) * 1000) / 10 : 0,
    examples: examples.slice(0, 3),
    flaggedIndices,
  };
}

// ---- the five canonical denial-risk buckets --------------------------------

function gradeEligibility(rows, colmap, total) {
  const missing = [];
  const checked = [];
  const notes = [];
  if (!colmap.memberId) {
    return category({ id: 'eligibility', label: 'Eligibility / registration',
      applicable: false, missing: ['member/subscriber ID'],
      notes: ['No member/subscriber/patient-ID column found — eligibility cannot be graded.'] }, total);
  }
  checked.push(colmap.memberId);
  const canCheckCoverage = colmap.dos && colmap.coverageStart;
  if (canCheckCoverage) checked.push(...[colmap.dos, colmap.coverageStart, colmap.coverageEnd].filter(Boolean));
  else notes.push('Coverage-date validity not checked (no service-date + coverage-start columns present).');

  const flaggedIndices = [];
  const examples = [];
  rows.forEach((row, i) => {
    const reasons = [];
    if (isBlank(row[colmap.memberId])) reasons.push('missing member/subscriber ID');
    if (canCheckCoverage) {
      const dos = row[colmap.dos];
      const cs = row[colmap.coverageStart];
      const ce = colmap.coverageEnd ? row[colmap.coverageEnd] : null;
      if (!isBlank(dos) && !isBlank(cs) && Date.parse(dos) < Date.parse(cs)) reasons.push('service date before coverage start');
      if (!isBlank(dos) && !isBlank(ce) && Date.parse(dos) > Date.parse(ce)) reasons.push('service date after coverage end');
    }
    if (reasons.length) {
      flaggedIndices.push(i);
      if (examples.length < 3) examples.push({ claim: claimLabel(row, colmap, i), reason: reasons.join('; ') });
    }
  });
  return category({ id: 'eligibility', label: 'Eligibility / registration',
    applicable: true, checked, missing, notes, flaggedIndices, examples }, total);
}

function gradeCoding(rows, colmap, total) {
  const checked = [];
  const missing = [];
  const notes = [];
  if (!colmap.cpt && !colmap.dx) {
    return category({ id: 'coding', label: 'Coding (CPT / diagnosis)',
      applicable: false, missing: ['CPT/procedure code', 'diagnosis code'],
      notes: ['No procedure-code or diagnosis-code column found — coding cannot be graded.'] }, total);
  }
  if (colmap.cpt) checked.push(colmap.cpt); else missing.push('CPT/procedure code');
  if (colmap.dx) checked.push(colmap.dx); else missing.push('diagnosis code');
  if (colmap.modifier) checked.push(colmap.modifier); else notes.push('No modifier column — modifier completeness not assessed.');
  notes.push('Clinical CPT-to-diagnosis appropriateness not checked (requires a code crosswalk not bundled); only code SHAPE and presence are validated.');

  const flaggedIndices = [];
  const examples = [];
  let blankModifierWithCpt = 0;
  rows.forEach((row, i) => {
    const reasons = [];
    if (colmap.cpt) {
      const v = row[colmap.cpt];
      if (isBlank(v)) reasons.push('missing CPT/procedure code');
      else if (!CPT_RE.test(String(v).trim())) reasons.push('CPT/procedure code has an invalid shape');
    }
    if (colmap.dx) {
      const v = row[colmap.dx];
      if (isBlank(v)) reasons.push('missing diagnosis code');
      else if (!ICD10_RE.test(String(v).trim())) reasons.push('diagnosis code has an invalid shape');
    }
    if (colmap.modifier && colmap.cpt && !isBlank(row[colmap.cpt]) && isBlank(row[colmap.modifier])) blankModifierWithCpt++;
    if (reasons.length) {
      flaggedIndices.push(i);
      if (examples.length < 3) examples.push({ claim: claimLabel(row, colmap, i), reason: reasons.join('; ') });
    }
  });
  if (colmap.modifier) notes.push(`${blankModifierWithCpt} coded line(s) carry no modifier (informational — many procedures need none, so this is not counted as a flag).`);
  return category({ id: 'coding', label: 'Coding (CPT / diagnosis)',
    applicable: true, checked, missing, notes, flaggedIndices, examples }, total);
}

function gradeDuplicates(rows, colmap, total, toleranceDays) {
  const notes = [];
  if (!colmap.memberId || !colmap.cpt) {
    const missing = [];
    if (!colmap.memberId) missing.push('member/subscriber ID');
    if (!colmap.cpt) missing.push('CPT/procedure code');
    return category({ id: 'duplicates', label: 'Duplicate / near-duplicate claims',
      applicable: false, missing,
      notes: ['Duplicate detection needs at least a member/subscriber-ID column and a CPT/procedure-code column.'] }, total);
  }
  const checked = [colmap.memberId, colmap.cpt];
  const hasDos = !!colmap.dos;
  if (hasDos) checked.push(colmap.dos);
  else notes.push('No service-date column — grouped on member + CPT only, which is a weaker duplicate signal.');

  const flaggedIndices = [];
  const examples = [];
  const flagged = new Set();
  // Exact duplicates: same member + (DOS if present) + CPT beyond the first.
  const groups = new Map();
  rows.forEach((row, i) => {
    if (isBlank(row[colmap.memberId]) || isBlank(row[colmap.cpt])) return;
    const key = [row[colmap.memberId], hasDos ? row[colmap.dos] : '', row[colmap.cpt]].join('');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  for (const idxs of groups.values()) {
    if (idxs.length > 1) {
      for (let k = 1; k < idxs.length; k++) {
        flagged.add(idxs[k]);
        if (examples.length < 3) examples.push({ claim: claimLabel(rows[idxs[k]], colmap, idxs[k]),
          reason: `exact duplicate of ${claimLabel(rows[idxs[0]], colmap, idxs[0])} (same member${hasDos ? ' + service date' : ''} + CPT)` });
      }
    }
  }
  // Near-duplicates within the tolerance window: same member + CPT, service
  // dates differing by <= toleranceDays but not identical (those are exact dups
  // above). Only when a date column exists.
  if (hasDos) {
    const byMemberCpt = new Map();
    rows.forEach((row, i) => {
      if (isBlank(row[colmap.memberId]) || isBlank(row[colmap.cpt]) || isBlank(row[colmap.dos])) return;
      const key = row[colmap.memberId] + '' + row[colmap.cpt];
      if (!byMemberCpt.has(key)) byMemberCpt.set(key, []);
      byMemberCpt.get(key).push(i);
    });
    for (const idxs of byMemberCpt.values()) {
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          const gap = daysBetween(rows[idxs[a]][colmap.dos], rows[idxs[b]][colmap.dos]);
          if (gap !== null && gap > 0 && gap <= toleranceDays && !flagged.has(idxs[b])) {
            flagged.add(idxs[b]);
            if (examples.length < 3) examples.push({ claim: claimLabel(rows[idxs[b]], colmap, idxs[b]),
              reason: `near-duplicate of ${claimLabel(rows[idxs[a]], colmap, idxs[a])} (same member + CPT within ${toleranceDays} day(s))` });
          }
        }
      }
    }
    notes.push(`Near-duplicate tolerance window: ${toleranceDays} day(s) on service date.`);
  }
  for (const i of flagged) flaggedIndices.push(i);
  flaggedIndices.sort((a, b) => a - b);
  return category({ id: 'duplicates', label: 'Duplicate / near-duplicate claims',
    applicable: true, checked, missing: [], notes, flaggedIndices, examples }, total);
}

function gradeProvider(rows, colmap, total) {
  const notes = [];
  if (!colmap.npi && !colmap.provider) {
    return category({ id: 'provider', label: 'Provider / NPI',
      applicable: false, missing: ['NPI', 'provider'],
      notes: ['No NPI or provider column found — provider identity cannot be graded.'] }, total);
  }
  const checked = [];
  const flaggedIndices = [];
  const examples = [];
  const useNpi = !!colmap.npi;
  if (useNpi) checked.push(colmap.npi);
  else { checked.push(colmap.provider); notes.push('No NPI column — validated provider presence only (NPI check-digit not run).'); }
  rows.forEach((row, i) => {
    let reason = null;
    if (useNpi) {
      const v = row[colmap.npi];
      if (isBlank(v)) reason = 'missing NPI';
      else if (!isValidNpi(v)) reason = 'NPI is not a valid 10-digit check-digit NPI';
    } else if (isBlank(row[colmap.provider])) {
      reason = 'missing provider';
    }
    if (reason) {
      flaggedIndices.push(i);
      if (examples.length < 3) examples.push({ claim: claimLabel(row, colmap, i), reason });
    }
  });
  return category({ id: 'provider', label: 'Provider / NPI',
    applicable: true, checked, missing: [], notes, flaggedIndices, examples }, total);
}

function gradeCob(rows, colmap, payerLikeColumns, total) {
  const hasMultiplePayers = payerLikeColumns.length >= 2 || !!colmap.payerSecondary;
  if (!hasMultiplePayers) {
    return category({ id: 'cob', label: 'Coordination of benefits (COB)',
      applicable: false, missing: ['secondary payer'],
      notes: [payerLikeColumns.length === 1
        ? 'Only one payer/insurance column present — COB (coordination of benefits) cannot be assessed.'
        : 'No payer/insurance columns found — COB cannot be assessed.'] }, total);
  }
  const secondary = colmap.payerSecondary || payerLikeColumns[1];
  const checked = payerLikeColumns.slice();
  const flaggedIndices = [];
  const examples = [];
  rows.forEach((row, i) => {
    // COB signal: a secondary/other payer is populated, so the claim needs
    // coordination-of-benefits handling before it is submitted as primary-only.
    if (!isBlank(row[secondary])) {
      flaggedIndices.push(i);
      if (examples.length < 3) examples.push({ claim: claimLabel(row, colmap, i),
        reason: `secondary payer "${String(row[secondary]).trim()}" present — coordination of benefits required` });
    }
  });
  return category({ id: 'cob', label: 'Coordination of benefits (COB)',
    applicable: true, checked, missing: [], notes: [`COB signalled when the secondary payer column ("${secondary}") is populated.`],
    flaggedIndices, examples }, total);
}

// ---- report ----------------------------------------------------------------

const DEFAULT_TOLERANCE_DAYS = 1;

// Build the full bucketed report from an in-memory rows array + column list.
// Pure and engine-free so tests exercise it directly. `perErrorCost` feeds the
// live cost-of-bad-data estimate; leave it undefined to use the default.
export function buildDenialReport({ rows = [], columns = [], table = null, rowCount = null,
  scannedRows = null, truncated = false, toleranceDays = DEFAULT_TOLERANCE_DAYS, perErrorCost } = {}) {
  const data = Array.isArray(rows) ? rows : [];
  const total = data.length;
  const detected = detectClaimColumns(columns);
  const colmap = detected.map;

  const categories = [
    gradeEligibility(data, colmap, total),
    gradeCoding(data, colmap, total),
    gradeDuplicates(data, colmap, total, toleranceDays),
    gradeProvider(data, colmap, total),
    gradeCob(data, colmap, detected.payerLikeColumns, total),
  ];

  // A row is "flagged" if any applicable category flagged it; union avoids
  // double-counting a row that trips two buckets.
  const flaggedUnion = new Set();
  for (const c of categories) if (c.applicable) for (const i of c.flaggedIndices) flaggedUnion.add(i);
  const totalFlaggedRows = flaggedUnion.size;

  const notCheckable = categories.filter(c => !c.applicable).map(c => ({ id: c.id, label: c.label, reason: c.notes[0] || 'column absent' }));

  const cost = estimateCostOfBadData({ flaggedCount: totalFlaggedRows, perErrorCost });

  return {
    generatedAt: new Date().toISOString(),
    dataset: {
      table: table ?? null,
      rowCount: rowCount ?? total,
      scannedRows: scannedRows ?? total,
      truncated: !!truncated,
      columns: (Array.isArray(columns) ? columns : []).map(c => (typeof c === 'string' ? { name: c, type: null } : { name: c.name, type: c.type ?? null })),
    },
    detectedColumns: colmap,
    categories: categories.map(({ flaggedIndices, ...rest }) => rest),
    totalFlaggedRows,
    totalFlaggedPct: total > 0 ? Math.round((totalFlaggedRows / total) * 1000) / 10 : 0,
    notCheckable,
    cost,
    disclaimer: 'Heuristic denial-risk triage, not payer adjudication. A flag means "worth a human review before submission", never a guaranteed denial. '
      + 'Absent columns are reported as not-checkable rather than passing. Clinical CPT-to-diagnosis appropriateness is not evaluated.',
  };
}

// ---- signed attestation (reuses sha256Hex, mirrors the deid verifier) -------

const DENIAL_ATTESTATION_KIND = 'dataglow-denial-profile-attestation';
const DENIAL_ATTESTATION_VERSION = 1;

function denialCore(att) {
  return {
    kind: att.kind, version: att.version, generatedAt: att.generatedAt, algorithm: att.algorithm,
    dataset: att.dataset, detectedColumns: att.detectedColumns, categories: att.categories,
    totalFlaggedRows: att.totalFlaggedRows, cost: att.cost,
  };
}

export async function computeDenialDigest(att) {
  return sha256Hex(JSON.stringify(denialCore(att)));
}

export async function buildDenialAttestation(report) {
  const att = {
    kind: DENIAL_ATTESTATION_KIND,
    version: DENIAL_ATTESTATION_VERSION,
    generatedAt: report.generatedAt || new Date().toISOString(),
    algorithm: 'SHA-256 digest over dataset structure + detected columns + bucketed results + cost estimate',
    dataset: report.dataset,
    detectedColumns: report.detectedColumns,
    categories: report.categories,
    totalFlaggedRows: report.totalFlaggedRows,
    cost: report.cost,
    disclaimer: report.disclaimer,
  };
  const digest = await computeDenialDigest(att);
  att.digest = { algorithm: 'SHA-256', value: digest, covers: 'kind, version, generatedAt, algorithm, dataset, detectedColumns, categories, totalFlaggedRows, cost' };
  return att;
}

export async function verifyDenialAttestation(att) {
  if (!att || att.kind !== DENIAL_ATTESTATION_KIND) {
    return { valid: false, reason: 'Not a DATAGLOW denial-profile attestation (missing/incorrect "kind").', digest: null };
  }
  const recomputed = await computeDenialDigest(att);
  const stored = att.digest && att.digest.value;
  const valid = !!stored && recomputed === stored;
  return {
    valid,
    reason: valid
      ? 'Denial-profile attestation verified: the document digest matches its content. (Integrity check only — not a payer determination.)'
      : 'The document digest does not match its content — the attestation was modified after it was produced.',
    digest: { valid, stored: stored || null, recomputed },
  };
}

// ---- DuckDB-WASM wrapper (client-side, zero upload) -------------------------

const MAX_SCAN = 50000;

// Profile a loaded DuckDB table: bounded `SELECT *` (the engine is in-browser
// DuckDB-WASM — no network), bucket in pure JS, and sign the report. `engine` is
// js/app-shell/duckdb-engine.js (or any object exposing async runQuery +
// getRowCount), so app and tests share one code path.
export async function runDenialProfile(table, cols, engine, opts = {}) {
  const columns = Array.isArray(cols) ? cols : [];
  const toleranceDays = typeof opts.toleranceDays === 'number' ? opts.toleranceDays : DEFAULT_TOLERANCE_DAYS;
  const perErrorCost = opts.perErrorCost;
  const scanLimit = typeof opts.maxScan === 'number' ? opts.maxScan : MAX_SCAN;

  let rowCount = null;
  try { rowCount = await engine.getRowCount(table); } catch { rowCount = null; }

  let rows = [];
  try {
    const res = await engine.runQuery(`SELECT * FROM ${table} LIMIT ${scanLimit}`);
    rows = (res && res.rows) || [];
  } catch { rows = []; }

  const truncated = typeof rowCount === 'number' && rows.length < rowCount;
  const report = buildDenialReport({ rows, columns, table, rowCount, scannedRows: rows.length, truncated, toleranceDays, perErrorCost });
  const attestation = await buildDenialAttestation(report);
  return { report, attestation };
}
