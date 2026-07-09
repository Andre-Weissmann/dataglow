// ============================================================
// DATAGLOW — Domain-pack extension points (Gen 40)
// ============================================================
// The stable, documented seams a domain pack plugs into. Before Gen 40 every
// domain pack was code pasted into the single shared file
// js/validation/domain-physics.js, so two packs adding rules collided on that
// one file (this actually happened between the Gen 33 healthcare pack and the
// Gen 34 retail/finance refactor). This module names the extension points a pack
// may contribute to, so a pack is now a self-contained manifest that DECLARES
// which points it fills — never a diff against a shared file.
//
// An extension point is just a stable string id plus a one-line contract. A pack
// manifest's `capabilities` map keys MUST be a subset of these ids; the loader
// (js/packs/pack-registry.js) rejects any capability keyed to an unknown point,
// so the set below is the closed vocabulary shared by every pack and the core
// engine. Adding a genuinely new seam is a deliberate one-line addition here.

// point id -> human-readable contract describing what a pack contributes there.
// Frozen so a pack (or an imported community pack) can never mutate the set of
// legal extension points at runtime.
export const EXTENSION_POINTS = Object.freeze({
  // Reinterpret / annotate the raw output of the validation layers (the only
  // point the built-in healthcare/retail/finance packs use today). A pack's
  // validation-rules run through the Domain Physics engine's annotate-only
  // sandbox: they may downgrade, contextualise, or annotate a finding, never
  // hard-fail data or target a core layer.
  'validation-rules': 'Reinterpret or annotate validation-layer findings (annotate-only, sandboxed).',
  // Domain-specific cleaning fixes offered on the Clean tab.
  'cleaning-fixes': 'Contribute domain-specific cleaning fixes for the loaded dataset.',
  // Domain-specific anomaly detectors layered above the generic ones.
  'anomaly-detectors': 'Contribute domain-specific anomaly detectors over already-loaded data.',
  // One-line teaching notes / gotchas surfaced by the Teach-As-You-Clean layer
  // (ties into js/teaching/micro-lessons.js and the Story tab verbosity slider).
  'teaching-notes': 'Contribute plain-language teaching notes / gotchas for the Story/teaching layer.',
  // Clearly-labelled synthetic sample datasets the pack ships, with provenance.
  'sample-datasets': 'Ship clearly-labelled synthetic sample datasets (with license/provenance metadata).',
  // A plain-language glossary of industry terms (metric / vocabulary definitions).
  'vocabulary': 'Provide a plain-language glossary of industry metrics and terms.',
});

// The frozen list of legal extension-point ids.
export const EXTENSION_POINT_IDS = Object.freeze(Object.keys(EXTENSION_POINTS));

/** Whether `id` names a defined, stable extension point. */
export function isExtensionPoint(id) {
  return Object.prototype.hasOwnProperty.call(EXTENSION_POINTS, id);
}
