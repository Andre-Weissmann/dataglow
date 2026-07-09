// ============================================================
// DATAGLOW — Built-in pack plugin: Retail / E-commerce
// ============================================================
// SKU merge guards, return/refund binary-flag Benford exemptions, and
// seasonal/promotional outlier reinterpretation. Self-contained plugin wrapper
// around the engine's canonical `retail` pack, which is compiled from the
// declarative RETAIL_PACK_DESCRIPTOR through the annotate-only factory sandbox.

import { DOMAIN_PACKS } from '../../validation/domain-physics.js';

export const pack = DOMAIN_PACKS.retail;

export const manifest = {
  id: 'retail',
  version: '1.0.0',
  industry: 'Retail / E-commerce',
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
