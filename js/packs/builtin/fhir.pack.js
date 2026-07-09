// ============================================================
// DATAGLOW — Built-in pack plugin: Healthcare — FHIR Bundle
// ============================================================
// Recognises FHIR Bundles, flattens them into DATAGLOW's tabular shape, and
// routes them through the existing layers, reusing the healthcare pack
// reinterpretations and carrying the shared non-clinical medical disclaimer.
// Self-contained plugin wrapper around the engine's canonical `fhir` pack.

import { DOMAIN_PACKS } from '../../validation/domain-physics.js';

export const pack = DOMAIN_PACKS.fhir;

export const manifest = {
  id: 'fhir',
  version: '1.0.0',
  industry: 'Healthcare — FHIR Bundle',
  capabilities: {
    'validation-rules': { ruleIds: pack.rules.map(r => r.id) },
    'teaching-notes': true,
    'sample-datasets': ['fhir-synthetic'],
  },
  dependencies: {},
  provenance: {
    sampleData: 'Synthetic FHIR bundle fixture (buildFhirSample), original to DATAGLOW (Synthea-inspired, not copied).',
    license: 'Original synthetic data — no third-party dataset redistributed.',
    disclaimer: 'Non-clinical: findings are heuristic, not a clinical determination.',
  },
};

export default { manifest, pack };
