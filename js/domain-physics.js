// ============================================================
// DATAGLOW — Domain Physics Engine
// ============================================================
// A swappable "domain pack" layer that sits ABOVE the 18 validation layers.
// It never re-runs or modifies the layers; it reinterprets / annotates their
// raw output using domain-specific rules. Turning a pack off restores the raw,
// domain-agnostic layer output.
//
// Every reinterpretation here is a HEURISTIC labelled as such — it downgrades
// or contextualises a raw flag, it never asserts a legal, clinical, or
// regulatory determination. The healthcare pack in particular only ever
// *softens* or *annotates* findings (e.g. warn instead of fail) and disables
// auto-merges on protected categories; it never hides or auto-applies an
// action against a PHI-adjacent finding.
//
// Pack format (data-driven — a future pack e.g. "finance" can be added here
// without touching validation.js):
//   {
//     name, label, description,
//     rules: [
//       {
//         id, description,
//         appliesToLayer: string,               // key in the runAllLayers result map
//         match: (columnMeta) => boolean,       // which columns the rule concerns
//         transform: (layerResult, matchedColumns, ctx) => layerResult
//       }
//     ]
//   }
// `columnMeta` is a plain object { name, type, numeric, isBinary01, ... }.
// `ctx` carries { columns, dataset, annotations } — transforms push a short
// record onto ctx.annotations for each flag they reinterpret so downstream
// consumers (Confidence-Calibrated Grades) can see what the pack "understood".

import { isSensitiveCategory, describeCluster } from './categorical-consistency.js';

// ------------------------------------------------------------
// Shared unit-test summariser.
// The Unit Test Layer emits a structured `findings` array; both the layer
// (initial pass) and a domain pack (after reinterpreting severities) derive
// the human-readable pass/warn/fail result from that same array so the two can
// never diverge. Housed here beside the engine because the warn tier only
// exists as a product of domain reinterpretation.
// ------------------------------------------------------------
export function summarizeUnitTests(findings = []) {
  const fails = findings.filter(f => f.severity === 'fail');
  const warns = findings.filter(f => f.severity === 'warn');
  const ts = Date.now();
  if (fails.length === 0 && warns.length === 0) {
    return { status: 'pass', summary: 'All 5 unit tests passed — no negatives, future dates, blank keys, duplicates, or broken references.', detail: null, ts };
  }
  if (fails.length === 0) {
    return { status: 'warn', summary: `${warns.length} date column(s) show a pattern consistent with de-identification date-shifting — review, don't assume a defect.`, detail: warns.map(w => w.text), ts };
  }
  return { status: 'fail', summary: `${fails.length} issue(s) found`, detail: [...fails.map(f => f.text), ...warns.map(w => w.text)], ts };
}

// Date-like detection kept in lock-step with the Unit Test Layer's own column
// selection so the pack can only ever act on columns the layer actually
// examined.
function isDateColMeta(c) {
  return /DATE|TIMESTAMP/i.test(c.type || '') || /date|admit|discharge/i.test(c.name || '');
}

// ------------------------------------------------------------
// Healthcare pack rules
// ------------------------------------------------------------

// Rule 1 — De-identification date-shift.
// Publicly released healthcare datasets (MIMIC-IV, PhysioNet, …) shift dates
// far into the future for de-identification. When >90% of a date column's
// non-null values are >20yr ahead, that is a systematic shift, not a defect —
// downgrade the Unit Test "future date" finding from fail → warn. A sporadic
// minority of future dates stays a hard failure (more likely a real typo).
const deidDateShiftRule = {
  id: 'deid-date-shift',
  appliesToLayer: 'unit_tests',
  description: 'Dates >20yr in the future across >90% of a column are treated as de-identification date-shifting (warn, not fail).',
  match: isDateColMeta,
  transform(layerResult, matchedColumns, ctx) {
    const findings = layerResult.findings;
    if (!Array.isArray(findings)) return layerResult;
    const names = new Set(matchedColumns.map(c => c.name));
    let changed = false;
    for (const f of findings) {
      if (f.kind === 'future_date' && names.has(f.column) && f.meta && f.meta.farFutureShare > 0.9) {
        f.severity = 'warn';
        f.text = `${(f.meta.farFutureShare * 100).toFixed(0)}% of dates in "${f.column}" are unusually far in the future — this is consistent with de-identification date-shifting (common in datasets like MIMIC-IV/PhysioNet), not necessarily a data error. Review before treating as a defect.`;
        changed = true;
        ctx.annotations.push({ layer: 'unit_tests', column: f.column, rule: 'deid-date-shift', from: 'fail', to: 'warn', note: 'Future dates reinterpreted as de-identification date-shifting.' });
      }
    }
    if (!changed) return layerResult;
    const rebuilt = summarizeUnitTests(findings);
    rebuilt.findings = findings;
    return rebuilt;
  },
};

// Rule 2 — Protected category, auto-merge disabled.
// Columns naming a protected/sensitive category (race, ethnicity, insurance,
// payer, gender, sex, religion, …) may hold values that are textually similar
// but legally/clinically distinct (Medicaid vs Medicare; distinct ethnicities).
// Flag the cluster for human review but never offer a one-click auto-merge.
const protectedCategoryRule = {
  id: 'protected-category-no-merge',
  appliesToLayer: 'categorical_consistency',
  description: 'Columns matching a protected category have auto-merge suggestions disabled (values may be legally/clinically distinct).',
  match: (c) => isSensitiveCategory(c.name),
  transform(layerResult, matchedColumns, ctx) {
    const clusters = layerResult.clusters;
    if (!Array.isArray(clusters)) return layerResult;
    const names = new Set(matchedColumns.map(c => c.name));
    let changed = false;
    for (const cl of clusters) {
      if (names.has(cl.column) && !cl.sensitive) {
        cl.sensitive = true;
        changed = true;
        ctx.annotations.push({ layer: 'categorical_consistency', column: cl.column, rule: 'protected-category', note: 'Auto-merge disabled — protected category values may be legally/clinically distinct.' });
      }
    }
    if (changed) layerResult.detail = clusters.map(describeCluster);
    return layerResult;
  },
};

// Rule 3 — Binary 0/1 columns are exempt from Benford's Law.
// Benford's Law describes multiplicative quantities spanning several orders of
// magnitude; a 0/1 flag column (mortality_flag, is_readmission, …) can never
// satisfy it. Ensure such columns are labelled as a deliberate, explained
// exemption rather than a generic "too few values" skip, and never flagged.
const binaryBenfordRule = {
  id: 'binary-benford-exempt',
  appliesToLayer: 'benford',
  description: 'Binary 0/1 flag columns are exempt from Benford\'s Law eligibility.',
  match: (c) => c.isBinary01 === true,
  transform(layerResult, matchedColumns, ctx) {
    const names = new Set(matchedColumns.map(c => c.name));
    if (!names.size) return layerResult;
    const flags = Array.isArray(layerResult.flags)
      ? layerResult.flags.filter(f => { const m = /^"([^"]+)"/.exec(f); return !(m && names.has(m[1])); })
      : [];
    const skips = Array.isArray(layerResult.skips) ? [...layerResult.skips] : [];
    let changed = false;
    for (const name of names) {
      const reason = `"${name}" skipped — binary 0/1 flag column, exempt from Benford's Law (which applies only to multi-order-of-magnitude quantities). [Domain Physics: healthcare pack]`;
      const idx = skips.findIndex(s => new RegExp(`^"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(s));
      if (idx >= 0) { skips[idx] = reason; changed = true; }
      else if (!skips.includes(reason)) { skips.push(reason); changed = true; }
      ctx.annotations.push({ layer: 'benford', column: name, rule: 'binary-benford-exempt', note: 'Binary 0/1 column exempt from Benford eligibility.' });
    }
    if (!changed && flags.length === (layerResult.flags || []).length) return layerResult;
    layerResult.flags = flags;
    layerResult.skips = skips;
    layerResult.detail = [...flags, ...skips];
    return layerResult;
  },
};

// ------------------------------------------------------------
// Pack registry
// ------------------------------------------------------------
export const DOMAIN_PACKS = {
  none: {
    name: 'none',
    label: 'None (generic)',
    description: 'No domain reinterpretation — the 18 layers report their raw, domain-agnostic output.',
    rules: [],
  },
  healthcare: {
    name: 'healthcare',
    label: 'Healthcare',
    description: 'De-identification date-shifting, protected-category merge guards, and binary-flag Benford exemptions for clinical/claims data.',
    rules: [deidDateShiftRule, protectedCategoryRule, binaryBenfordRule],
  },
};

export function listPacks() {
  return Object.values(DOMAIN_PACKS).map(p => ({ name: p.name, label: p.label, description: p.description }));
}

function getPack(name) {
  if (!name) return DOMAIN_PACKS.healthcare;
  return DOMAIN_PACKS[name] || DOMAIN_PACKS.none;
}

// ------------------------------------------------------------
// Engine — apply a pack's rules over an already-computed layer-result map.
// Mutates `layerResults` in place (replacing individual layer results) and
// returns a small summary { packName, packLabel, annotations } describing what
// was reinterpreted.
// ------------------------------------------------------------
export function applyDomainPack(layerResults, packName, context = {}) {
  const annotations = [];
  const pack = getPack(packName);
  const columns = context.columns || [];
  const ctx = { ...context, columns, annotations };
  for (const rule of pack.rules) {
    const layerResult = layerResults[rule.appliesToLayer];
    if (!layerResult) continue;
    let matchedColumns;
    try { matchedColumns = columns.filter(c => rule.match(c)); }
    catch { matchedColumns = []; }
    if (matchedColumns.length === 0) continue;
    try {
      const updated = rule.transform(layerResult, matchedColumns, ctx);
      if (updated) layerResults[rule.appliesToLayer] = updated;
    } catch { /* a pack rule must never break validation — skip on error */ }
  }
  return { packName: pack.name, packLabel: pack.label, annotations };
}
