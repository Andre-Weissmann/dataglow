// ============================================================
// DATAGLOW — Built-in pack plugin: Healthcare — OMOP CDM
// ============================================================
// Recognises OMOP CDM tables and routes them through the existing layers,
// reusing the healthcare pack reinterpretations and carrying the shared
// non-clinical medical disclaimer. Self-contained plugin wrapper around the
// engine's canonical `omop` pack (see js/validation/health-standards.js and
// js/validation/domain-physics.js).

import { DOMAIN_PACKS } from '../../validation/domain-physics.js';

export const pack = DOMAIN_PACKS.omop;

export const manifest = {
  id: 'omop',
  version: '1.0.0',
  industry: 'Healthcare — OMOP CDM',
  capabilities: {
    'validation-rules': { ruleIds: pack.rules.map(r => r.id) },
    'teaching-notes': true,
    'sample-datasets': ['omop-synthetic'],
  },
  dependencies: {},
  provenance: {
    sampleData: 'Synthetic OMOP CDM fixture (buildOmopSample), original to DATAGLOW (Synthea-inspired, not copied).',
    license: 'Original synthetic data — no third-party dataset redistributed.',
    disclaimer: 'Non-clinical: findings are heuristic, not a clinical determination.',
  },
};

export default { manifest, pack };
