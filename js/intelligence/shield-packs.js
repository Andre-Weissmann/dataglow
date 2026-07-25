// ============================================================
// DATAGLOW - Shield Packs (pure registry + detectors)
// ============================================================
// Domain privacy/compliance "packs" for the shared canvas. One calm surface,
// four packs, no settings maze: each pack is a small declarative record with a
// posture (what it does when active) and, where useful, value patterns it can
// flag on device.
//
// Pack 0 is Healthcare PHI. It is NOT reimplemented here: it delegates to the
// existing PHI Shield engine (window.DataGlowPhiShield / phiShield flag). The
// three additional packs are deliberately lighter shells with real rules and a
// real posture, so they are honest about what they do and never overclaim.
//
// This module is PURE and Node-testable: no DOM, no storage, no network. The
// canvas UI layer (DataGlowShieldPacksUI) consumes it.
//
// Public API (never throws from a public fn - returns a safe value instead):
//   listPacks()                        -> array of pack records (stable order)
//   getPack(id)                        -> pack record or null
//   detectPatterns(text, packId?)      -> { findings, hitCount }
//   scanColumnSamples(samples, packId) -> { columns, hitCount, flaggedColumns }
//   posture({ activeIds })             -> { level, aiAllowed, exportAllowed, ... }
//   postureCopy(posture)               -> user-visible strings (no em dash)
//
// Zero-upload posture: every detector runs on strings the caller already holds.
// Nothing here can reach the network, and no pack ever mutates a dataset.

export const SHIELD_PACKS_VERSION = 1;

// Sensitivity ranking, low to high. Used to pick the strongest active posture.
const SENSITIVITY_ORDER = ['standard', 'elevated', 'high', 'maximum'];

// ------------------------------------------------------------
// Detectors. Each is { id, label, re, note }. `re` is applied with a fresh
// lastIndex per call (all are global) so detectors are reentrant.
// ------------------------------------------------------------

// Finance PII. SSN/EIN shapes plus long account/routing-like digit runs and
// payment-card-shaped groups. Shape-based only: a hit means "look at this",
// not "this is definitely an SSN".
const FINANCE_DETECTORS = [
  {
    id: 'ssn',
    label: 'SSN-shaped value',
    re: /\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g,
    note: 'Nine digits in Social Security number shape.',
  },
  {
    id: 'ein',
    label: 'EIN-shaped value',
    re: /\b\d{2}-\d{7}\b/g,
    note: 'Two digits, hyphen, seven digits: employer identification shape.',
  },
  {
    id: 'card',
    label: 'Payment-card-shaped value',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    note: 'Thirteen to nineteen digits in card-number grouping.',
  },
  {
    id: 'routing',
    label: 'Routing-number-shaped value',
    re: /\b\d{9}\b/g,
    note: 'Nine consecutive digits: ABA routing shape.',
  },
  {
    id: 'iban',
    label: 'IBAN-shaped value',
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,26}\b/g,
    note: 'Country code, check digits, then account body.',
  },
  {
    id: 'account',
    label: 'Long account-number-shaped value',
    re: /\b(?:acct|account|acc)[.:# ]{0,3}\d{6,}\b/gi,
    note: 'Account label followed by a long digit run.',
  },
];

// Privilege / attorney-client style labels. Text markers only. This flags
// wording that people use to mark privileged material so exports can carry a
// caution. It is not a legal determination and the copy never says otherwise.
const PRIVILEGE_DETECTORS = [
  {
    id: 'attorney-client',
    label: 'Attorney-client marker',
    re: /\battorney[\s-]?client\b/gi,
    note: 'Common privilege marker wording.',
  },
  {
    id: 'privileged',
    label: 'Privileged marker',
    re: /\bprivileged\b/gi,
    note: 'Explicit privilege label.',
  },
  {
    id: 'work-product',
    label: 'Work-product marker',
    re: /\bwork\s?product\b/gi,
    note: 'Attorney work-product label.',
  },
  {
    id: 'legal-hold',
    label: 'Legal hold marker',
    re: /\b(?:legal|litigation)\s?hold\b/gi,
    note: 'Preservation or litigation hold label.',
  },
];

// CJIS / justice-sensitive shell. High-sensitivity identifiers that show up in
// criminal-justice extracts. Detection is deliberately narrow; the pack's real
// job is the fail-closed posture it applies when active.
const JUSTICE_DETECTORS = [
  {
    id: 'case-number',
    label: 'Case-number-shaped value',
    re: /\b(?:case|docket)\s?(?:no\.?|number|#)?\s?[A-Z0-9]{2,}-\d{2,}\b/gi,
    note: 'Case or docket number shape.',
  },
  {
    id: 'ncic-like',
    label: 'Justice-record identifier',
    re: /\b(?:ncic|ori|sid|fbi)\s?(?:no\.?|number|#|id)?\s?[A-Z0-9]{5,}\b/gi,
    note: 'Named justice-system record identifier.',
  },
  {
    id: 'offense-code',
    label: 'Offense-code-shaped value',
    re: /\b(?:offense|charge|statute)\s?(?:code)?\s?[:#]?\s?\d{2,3}\.\d{1,3}\b/gi,
    note: 'Statute or offense code shape.',
  },
];

// Column-name hints per pack. Cheap, high-signal, and complements value
// patterns for columns whose sample rows happen to be empty.
const COLUMN_HINTS = {
  finance: [
    'ssn', 'social_security', 'socialsecurity', 'ein', 'tax_id', 'taxid',
    'account_number', 'acct_no', 'acctno', 'routing', 'iban', 'card_number',
    'cardnumber', 'pan', 'cvv', 'bank_account',
  ],
  privilege: [
    'privilege', 'privileged', 'attorney', 'counsel', 'legal_hold',
    'work_product', 'confidentiality', 'redaction_status',
  ],
  justice: [
    'case_number', 'caseno', 'docket', 'offender_id', 'inmate_id', 'arrest_id',
    'ori', 'ncic', 'sid', 'fbi_number', 'offense_code', 'charge_code',
  ],
};

// ------------------------------------------------------------
// Pack registry. Order is the display order and is part of the golden output,
// so append rather than reorder.
// ------------------------------------------------------------
const PACKS = [
  {
    id: 'healthcare-phi',
    index: 0,
    name: 'Healthcare PHI',
    domain: 'healthcare',
    sensitivity: 'high',
    engine: 'phi-shield',
    flag: 'phiShield',
    detectorIds: [],
    summary: 'Safe Harbor screen plus prompt guard. Pack zero, always available.',
    blocksAi: false,
    blocksExport: false,
    exportCaution: false,
    columnTagging: false,
  },
  {
    id: 'finance-pii',
    index: 1,
    name: 'Finance PII',
    domain: 'finance',
    sensitivity: 'elevated',
    engine: 'patterns',
    flag: 'shieldPacks',
    detectorIds: FINANCE_DETECTORS.map((d) => d.id),
    summary: 'Flags SSN, EIN, account and card shapes on device. Detect and flag only.',
    blocksAi: false,
    blocksExport: false,
    exportCaution: false,
    columnTagging: false,
  },
  {
    id: 'privilege',
    index: 2,
    name: 'Privilege labels',
    domain: 'legal',
    sensitivity: 'elevated',
    engine: 'patterns',
    flag: 'shieldPacks',
    detectorIds: PRIVILEGE_DETECTORS.map((d) => d.id),
    summary: 'Optional column tagging for privileged material plus an export caution.',
    blocksAi: false,
    blocksExport: false,
    exportCaution: true,
    columnTagging: true,
  },
  {
    id: 'justice-cjis',
    index: 3,
    name: 'Justice sensitive',
    domain: 'justice',
    sensitivity: 'maximum',
    engine: 'patterns',
    flag: 'shieldPacks',
    detectorIds: JUSTICE_DETECTORS.map((d) => d.id),
    summary: 'Fail-closed shell. Blocks AI and export paths while active.',
    blocksAi: true,
    blocksExport: true,
    exportCaution: true,
    columnTagging: true,
  },
];

const DETECTORS_BY_PACK = {
  'healthcare-phi': [],
  'finance-pii': FINANCE_DETECTORS,
  privilege: PRIVILEGE_DETECTORS,
  'justice-cjis': JUSTICE_DETECTORS,
};

const HINTS_BY_PACK = {
  'healthcare-phi': [],
  'finance-pii': COLUMN_HINTS.finance,
  privilege: COLUMN_HINTS.privilege,
  'justice-cjis': COLUMN_HINTS.justice,
};

function clonePack(p) {
  return {
    id: p.id,
    index: p.index,
    name: p.name,
    domain: p.domain,
    sensitivity: p.sensitivity,
    engine: p.engine,
    flag: p.flag,
    detectorIds: p.detectorIds.slice(),
    summary: p.summary,
    blocksAi: p.blocksAi,
    blocksExport: p.blocksExport,
    exportCaution: p.exportCaution,
    columnTagging: p.columnTagging,
  };
}

/** Every pack, in display order. Returns copies so callers cannot mutate the registry. */
export function listPacks() {
  return PACKS.map(clonePack);
}

/** One pack by id, or null when the id is unknown. */
export function getPack(id) {
  const found = PACKS.find((p) => p.id === id);
  return found ? clonePack(found) : null;
}

function detectorsFor(packId) {
  if (packId == null) {
    return FINANCE_DETECTORS.concat(PRIVILEGE_DETECTORS, JUSTICE_DETECTORS);
  }
  return DETECTORS_BY_PACK[packId] || [];
}

/**
 * Run a pack's value detectors over one string. Omit packId to run every
 * non-PHI detector. Findings are returned in detector order with match counts,
 * never the matched values, so a finding can be logged without leaking data.
 */
export function detectPatterns(text, packId) {
  const out = { findings: [], hitCount: 0 };
  if (typeof text !== 'string' || text.length === 0) return out;
  const detectors = detectorsFor(packId);
  for (const d of detectors) {
    d.re.lastIndex = 0;
    const matches = text.match(d.re);
    if (matches && matches.length > 0) {
      out.findings.push({ id: d.id, label: d.label, count: matches.length, note: d.note });
      out.hitCount += matches.length;
    }
  }
  return out;
}

function normalizeName(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function nameHints(packId, columnName) {
  const hints = HINTS_BY_PACK[packId] || [];
  const norm = normalizeName(columnName);
  if (!norm) return [];
  return hints.filter((h) => norm === h || norm.includes(h));
}

/**
 * Scan a { columnName: [values] } sample map with one pack. Returns per-column
 * findings, matched column-name hints, and the flagged column names. Values are
 * only read, never copied into the result.
 */
export function scanColumnSamples(samples, packId) {
  const out = { pack: packId || null, columns: [], hitCount: 0, flaggedColumns: [] };
  if (!samples || typeof samples !== 'object') return out;
  const names = Object.keys(samples).sort();
  for (const name of names) {
    const values = Array.isArray(samples[name]) ? samples[name] : [];
    const byDetector = new Map();
    let colHits = 0;
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const res = detectPatterns(value, packId);
      for (const f of res.findings) {
        const prev = byDetector.get(f.id);
        byDetector.set(f.id, {
          id: f.id,
          label: f.label,
          count: (prev ? prev.count : 0) + f.count,
        });
      }
      colHits += res.hitCount;
    }
    const hints = nameHints(packId, name);
    if (colHits === 0 && hints.length === 0) continue;
    out.columns.push({
      column: name,
      hits: colHits,
      detectors: Array.from(byDetector.values()).sort((a, b) => (a.id < b.id ? -1 : 1)),
      nameHints: hints.slice(),
    });
    out.hitCount += colHits;
    out.flaggedColumns.push(name);
  }
  return out;
}

function strongest(levels) {
  let best = 'standard';
  for (const level of levels) {
    if (SENSITIVITY_ORDER.indexOf(level) > SENSITIVITY_ORDER.indexOf(best)) best = level;
  }
  return best;
}

/**
 * Combine the active packs into one posture. Fail-closed: if ANY active pack
 * blocks a path, that path is blocked, and an unknown pack id is ignored rather
 * than silently downgrading the posture.
 */
export function posture(opts) {
  const ids = (opts && Array.isArray(opts.activeIds) ? opts.activeIds : []).filter(Boolean);
  const active = ids.map((id) => PACKS.find((p) => p.id === id)).filter(Boolean);
  const level = strongest(active.map((p) => p.sensitivity));
  const blocksAi = active.some((p) => p.blocksAi);
  const blocksExport = active.some((p) => p.blocksExport);
  return {
    activeIds: active.map((p) => p.id),
    activeCount: active.length,
    level: active.length === 0 ? 'standard' : level,
    aiAllowed: !blocksAi,
    exportAllowed: !blocksExport,
    exportCaution: active.some((p) => p.exportCaution),
    columnTagging: active.some((p) => p.columnTagging),
    banner: active.some((p) => p.sensitivity === 'maximum'),
    onDevice: true,
    network: false,
  };
}

/** User-visible strings for a posture. No em dash (U+2014) anywhere. */
export function postureCopy(p) {
  const state = p || posture({ activeIds: [] });
  const count = state.activeCount || 0;
  return {
    title: count === 0 ? 'No pack active' : count + ' pack' + (count === 1 ? '' : 's') + ' active',
    body: 'Packs run on this device. Rows are never uploaded.',
    ai: state.aiAllowed
      ? 'AI paths stay available and still ask before anything changes.'
      : 'AI paths are blocked while this pack is active.',
    exportLine: state.exportAllowed
      ? (state.exportCaution
        ? 'Export is allowed. Review labels before you share the file.'
        : 'Export is allowed.')
      : 'Export is blocked while this pack is active.',
    disclaimer: 'Screening aid only. Not a compliance certification or legal advice.',
  };
}

export const DataGlowShieldPacks = {
  version: SHIELD_PACKS_VERSION,
  listPacks: listPacks,
  getPack: getPack,
  detectPatterns: detectPatterns,
  scanColumnSamples: scanColumnSamples,
  posture: posture,
  postureCopy: postureCopy,
};

if (typeof window !== 'undefined') {
  window.DataGlowShieldPacks = DataGlowShieldPacks;
}
