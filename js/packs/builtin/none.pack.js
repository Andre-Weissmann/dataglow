// ============================================================
// DATAGLOW — Built-in pack plugin: None (generic)
// ============================================================
// The no-op pack: no domain reinterpretation, the layers report their raw,
// domain-agnostic output. Self-contained plugin wrapper around the engine's
// canonical `none` pack object so behaviour is identical whether packs are
// sourced from the legacy map or the plugin registry.

import { DOMAIN_PACKS } from '../../validation/domain-physics.js';

export const manifest = {
  id: 'none',
  version: '1.0.0',
  industry: 'None (generic)',
  capabilities: {},
  dependencies: {},
  provenance: { sampleData: 'none', note: 'No reinterpretation and no sample data — raw layer output.' },
};

export const pack = DOMAIN_PACKS.none;

export default { manifest, pack };
