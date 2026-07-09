// ============================================================
// DATAGLOW — Built-in pack plugin: Finance / Accounting
// ============================================================
// Ledger/GL-account merge guards, reconciliation binary-flag Benford
// exemptions, and offsetting debit/credit outlier reinterpretation.
// Self-contained plugin wrapper around the engine's canonical `finance` pack,
// compiled from the declarative FINANCE_PACK_DESCRIPTOR through the annotate-only
// factory sandbox.

import { DOMAIN_PACKS } from '../../validation/domain-physics.js';

export const pack = DOMAIN_PACKS.finance;

export const manifest = {
  id: 'finance',
  version: '1.0.0',
  industry: 'Finance / Accounting',
  capabilities: {
    'validation-rules': { ruleIds: pack.rules.map(r => r.id) },
    'teaching-notes': true,
  },
  dependencies: {},
  provenance: {
    sampleData: 'none',
    license: 'No sample data shipped — rules operate on locally-loaded data only.',
  },
};

export default { manifest, pack };
