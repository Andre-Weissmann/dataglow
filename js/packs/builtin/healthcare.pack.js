// ============================================================
// DATAGLOW — Built-in pack plugin: Healthcare
// ============================================================
// De-identification date-shifting, protected-category merge guards, and
// binary-flag Benford exemptions for clinical/claims data. Self-contained plugin
// wrapper around the engine's canonical `healthcare` pack; the hand-written rule
// bodies stay in the Domain Physics engine (see js/validation/domain-physics.js)
// so behaviour is byte-for-byte identical to the pre-plugin path.

import { DOMAIN_PACKS } from '../../validation/domain-physics.js';

export const pack = DOMAIN_PACKS.healthcare;

export const manifest = {
  id: 'healthcare',
  version: '1.0.0',
  industry: 'Healthcare',
  capabilities: {
    'validation-rules': { ruleIds: pack.rules.map(r => r.id) },
    'teaching-notes': true,
    'sample-datasets': ['omop-synthetic', 'fhir-synthetic'],
  },
  dependencies: {},
  provenance: {
    // The OMOP/FHIR sample fixtures (js/validation/health-standards.js) are
    // entirely fabricated, clearly-labelled synthetic data — original to
    // DATAGLOW, inspired by Synthea's public description of what it emits, NOT
    // copied from any Synthea output. Field/table names are the standards'
    // public identifiers.
    sampleData: 'Synthetic OMOP CDM & FHIR fixtures, original to DATAGLOW (Synthea-inspired, not copied).',
    license: 'Original synthetic data — no third-party dataset redistributed.',
    disclaimer: 'Non-clinical: findings are heuristic, not a clinical determination.',
  },
};

export default { manifest, pack };
