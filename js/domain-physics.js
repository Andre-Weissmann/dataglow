// ============================================================
// DATAGLOW — Domain Physics Engine
// ============================================================
// A swappable "domain pack" layer that sits ABOVE the 20 validation layers.
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
// Reusable rule shapes for the generalized pack marketplace
// ------------------------------------------------------------
// The Retail and Finance packs reinterpret their layers with the same three
// mechanical shapes the healthcare pack pioneered (a no-merge guard on
// categorical columns, a Benford exemption on binary flag columns, and an
// outlier reinterpretation), but with pack-specific column matchers and
// wording. Rather than copy the healthcare rules' bodies twice, the two new
// packs are built from these small factories. The healthcare rules above are
// intentionally left as hand-written literals and untouched.
//
// Every factory obeys the same safety contract as the healthcare rules: it only
// reinterprets, annotates, or downgrades severity of existing findings — it
// never deletes a finding without leaving an explanatory note in its place, and
// never raises a new hard failure. (Any throw is additionally caught by the
// engine, so a buggy rule can never break a validation run.)

function escapeReMeta(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A no-merge guard: mark the clusters on matched columns as sensitive so the
// Categorical Consistency layer stops offering a one-click auto-merge. Mirrors
// the healthcare protected-category rule for domains where textually-similar
// values are legitimately distinct (SKUs, ledger accounts).
function makeNoMergeRule({ id, description, match, note }) {
  return {
    id,
    appliesToLayer: 'categorical_consistency',
    description,
    match,
    transform(layerResult, matchedColumns, ctx) {
      const clusters = layerResult.clusters;
      if (!Array.isArray(clusters)) return layerResult;
      const names = new Set(matchedColumns.map(c => c.name));
      let changed = false;
      for (const cl of clusters) {
        if (names.has(cl.column) && !cl.sensitive) {
          cl.sensitive = true;
          changed = true;
          ctx.annotations.push({ layer: 'categorical_consistency', column: cl.column, rule: id, note });
        }
      }
      if (changed) layerResult.detail = clusters.map(describeCluster);
      return layerResult;
    },
  };
}

// A Benford exemption for binary 0/1 flag columns a domain treats as legitimate
// (return/refund flags, reconciliation flags). Mirrors the healthcare
// binary-benford-exempt rule: drop the matched column's flag and record an
// explained skip rather than a bare deviation.
function makeBinaryBenfordExemptRule({ id, description, match, packLabel, note }) {
  return {
    id,
    appliesToLayer: 'benford',
    description,
    match,
    transform(layerResult, matchedColumns, ctx) {
      const names = new Set(matchedColumns.map(c => c.name));
      if (!names.size) return layerResult;
      const flags = Array.isArray(layerResult.flags)
        ? layerResult.flags.filter(f => { const m = /^"([^"]+)"/.exec(f); return !(m && names.has(m[1])); })
        : [];
      const skips = Array.isArray(layerResult.skips) ? [...layerResult.skips] : [];
      let changed = false;
      for (const name of names) {
        const reason = `"${name}" skipped — binary 0/1 flag column, exempt from Benford's Law (which applies only to multi-order-of-magnitude quantities). [Domain Physics: ${packLabel} pack]`;
        const idx = skips.findIndex(s => new RegExp(`^"${escapeReMeta(name)}"`).test(s));
        if (idx >= 0) { skips[idx] = reason; changed = true; }
        else if (!skips.includes(reason)) { skips.push(reason); changed = true; }
        ctx.annotations.push({ layer: 'benford', column: name, rule: id, note });
      }
      if (!changed && flags.length === (layerResult.flags || []).length) return layerResult;
      layerResult.flags = flags;
      layerResult.skips = skips;
      layerResult.detail = [...flags, ...skips];
      return layerResult;
    },
  };
}

// An outlier reinterpretation: on matched columns, replace the raw Outlier
// Detection finding with an explanatory note that the extremes are expected for
// this domain (seasonal retail swings, offsetting ledger entries). The finding
// is never silently dropped — a note takes its place and an annotation is
// recorded — and the layer can only ever be downgraded (warn → warn/pass),
// never escalated.
function makeOutlierContextRule({ id, description, match, packLabel, reason }) {
  return {
    id,
    appliesToLayer: 'outlier_detection',
    description,
    match,
    transform(layerResult, matchedColumns, ctx) {
      const detail = Array.isArray(layerResult.detail) ? layerResult.detail : [];
      if (!detail.length) return layerResult;
      const names = new Set(matchedColumns.map(c => c.name));
      const kept = [];
      const contextualised = [];
      for (const line of detail) {
        const m = /^"([^"]+)"/.exec(line);
        if (m && names.has(m[1])) contextualised.push(m[1]);
        else kept.push(line);
      }
      if (!contextualised.length) return layerResult;
      const to = kept.length ? 'warn' : 'pass';
      for (const column of contextualised) {
        ctx.annotations.push({ layer: 'outlier_detection', column, rule: id, from: layerResult.status, to, note: reason });
      }
      const notes = contextualised.map(column =>
        `"${column}": outliers reinterpreted as expected ${packLabel} variation — ${reason} Review, don't assume a defect.`);
      layerResult.detail = [...kept, ...notes];
      layerResult.status = to;
      layerResult.summary = kept.length
        ? `${kept.length} column(s) contain outliers; ${contextualised.length} column(s) reinterpreted as expected ${packLabel} variation.`
        : `Outliers present but reinterpreted as expected ${packLabel} variation — no unexplained outliers.`;
      return layerResult;
    },
  };
}

// ------------------------------------------------------------
// Retail / E-commerce pack rules
// ------------------------------------------------------------

// Distinct SKUs / product codes look near-identical to the clustering layer
// ("SKU-1001" vs "SKU-1002") but are deliberately separate catalogue entries;
// disable the auto-merge suggestion so genuine products are never collapsed.
const retailSkuNoMergeRule = makeNoMergeRule({
  id: 'retail-sku-no-merge',
  description: 'SKU / product-code columns have auto-merge disabled — near-identical codes are distinct catalogue entries.',
  match: (c) => /(^|[_\s-])sku([_\s-]|$)|product[_\s-]?code|item[_\s-]?(code|no|number)|\bupc\b|barcode|\basin\b/i.test(c.name || ''),
  note: 'Auto-merge disabled — similar SKUs/product codes are distinct catalogue entries, not spelling variants.',
});

// Return / refund columns are usually a binary 0/1 flag; like any binary flag
// they can never satisfy Benford's Law, so mark them as a deliberate exemption.
const retailReturnFlagBenfordRule = makeBinaryBenfordExemptRule({
  id: 'retail-return-flag-benford-exempt',
  description: 'Binary return/refund flag columns are exempt from Benford\'s Law eligibility.',
  match: (c) => c.isBinary01 === true && /return|refund|is[_\s-]?returned|chargeback/i.test(c.name || ''),
  packLabel: 'retail',
  note: 'Binary return/refund flag exempt from Benford eligibility.',
});

// Price / sales / quantity columns swing hard around promotions and seasonal
// peaks (Black Friday, clearance); those extremes are expected, not defects.
const retailSeasonalOutlierRule = makeOutlierContextRule({
  id: 'retail-seasonal-outlier',
  description: 'Outliers in price/sales/quantity columns are reinterpreted as expected promotional or seasonal swings.',
  match: (c) => c.numeric === true && /price|sales|revenue|gmv|units[_\s-]?sold|qty|quantity|discount|margin/i.test(c.name || ''),
  packLabel: 'retail',
  reason: 'promotions and seasonal peaks produce legitimate spikes and markdowns.',
});

// ------------------------------------------------------------
// Finance / Accounting pack rules
// ------------------------------------------------------------

// Ledger / GL account codes are textually similar but functionally distinct
// accounts; collapsing them would corrupt the books, so disable auto-merge.
const financeLedgerNoMergeRule = makeNoMergeRule({
  id: 'finance-ledger-account-no-merge',
  description: 'Ledger / GL-account columns have auto-merge disabled — similar account codes are distinct accounts.',
  match: (c) => /ledger|(^|[_\s-])account([_\s-]|$)|\bacct\b|gl[_\s-]?(code|account|no)|chart[_\s-]?of[_\s-]?accounts|cost[_\s-]?cent(er|re)/i.test(c.name || ''),
  note: 'Auto-merge disabled — similar ledger/GL-account codes are distinct accounts, not spelling variants.',
});

// Reconciliation / posting status is typically a binary 0/1 flag, so exempt it
// from Benford's Law the same way any binary flag column is exempted.
const financeReconFlagBenfordRule = makeBinaryBenfordExemptRule({
  id: 'finance-recon-flag-benford-exempt',
  description: 'Binary reconciliation/posting-status flag columns are exempt from Benford\'s Law eligibility.',
  match: (c) => c.isBinary01 === true && /reconcil|posted|cleared|void|is[_\s-]?paid|settled/i.test(c.name || ''),
  packLabel: 'finance',
  note: 'Binary reconciliation/status flag exempt from Benford eligibility.',
});

// Debit / credit / journal amount columns contain large offsetting entries by
// design (every debit has an equal-and-opposite credit); the resulting
// symmetric extremes are expected double-entry structure, not anomalies.
const financeDebitCreditOutlierRule = makeOutlierContextRule({
  id: 'finance-debit-credit-outlier',
  description: 'Outliers in debit/credit/journal-amount columns are reinterpreted as expected offsetting double-entry values.',
  match: (c) => c.numeric === true && /debit|credit|(^|[_\s-])amount([_\s-]|$)|balance|journal|(^|[_\s-])entry([_\s-]|$)|posting/i.test(c.name || ''),
  packLabel: 'finance',
  reason: 'double-entry bookkeeping records large equal-and-opposite debits and credits.',
});

// ------------------------------------------------------------
// Pack registry
// ------------------------------------------------------------
export const DOMAIN_PACKS = {
  none: {
    name: 'none',
    label: 'None (generic)',
    description: 'No domain reinterpretation — the 20 layers report their raw, domain-agnostic output.',
    rules: [],
  },
  healthcare: {
    name: 'healthcare',
    label: 'Healthcare',
    description: 'De-identification date-shifting, protected-category merge guards, and binary-flag Benford exemptions for clinical/claims data.',
    rules: [deidDateShiftRule, protectedCategoryRule, binaryBenfordRule],
  },
  retail: {
    name: 'retail',
    label: 'Retail / E-commerce',
    description: 'SKU merge guards, return/refund binary-flag Benford exemptions, and seasonal/promotional outlier reinterpretation for retail and e-commerce data.',
    rules: [retailSkuNoMergeRule, retailReturnFlagBenfordRule, retailSeasonalOutlierRule],
  },
  finance: {
    name: 'finance',
    label: 'Finance / Accounting',
    description: 'Ledger/GL-account merge guards, reconciliation binary-flag Benford exemptions, and offsetting debit/credit outlier reinterpretation for financial and accounting data.',
    rules: [financeLedgerNoMergeRule, financeReconFlagBenfordRule, financeDebitCreditOutlierRule],
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
