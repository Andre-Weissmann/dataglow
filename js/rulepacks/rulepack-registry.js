// ============================================================
// DATAGLOW — Rulepack Registry (Phase 4)
// ============================================================
// Loads, validates, and version-pins rulepacks. A rulepack is a
// plain JS object that carries all domain-specific thresholds,
// labels, and decay parameters for a given dataset type.
//
// WHY THIS EXISTS:
// Phase 3 hardcoded CMS healthcare thresholds in disparity-scorer.js.
// That was correct for healthcare but wrong for any other domain.
// The registry lets the equity scorer, drift tracker, and Trust
// Certificate pull thresholds from the ACTIVE rulepack rather than
// from constants — so a Lego dataset gets "general" thresholds and
// honest methodology attribution instead of "CMS DIS."
//
// VERSION PINNING:
// A dataset validated against rulepack healthcare@1.0.0 can be
// re-validated later against healthcare@1.1.0. The registry records
// which version was active at validation time so the Trust Certificate
// can report: "validated against healthcare@1.0.0 on 2026-07-18."
//
// DESIGN:
// Pure and synchronous (no DuckDB, no DOM, no network).
// Built-in packs are imported statically. Custom packs can be
// registered at runtime via registerPack().

import healthcarePack from './packs/healthcare.js';
import generalPack    from './packs/general.js';

// ---- Required rulepack schema fields ------------------------------------
const REQUIRED_FIELDS = [
  'id', 'version', 'label', 'description', 'domain',
  'freshness', 'equity',
];
const REQUIRED_FRESHNESS = ['staleAfterDays', 'expiredAfterDays', 'decayFloor', 'decayShape', 'rationale'];
const REQUIRED_EQUITY    = ['binary', 'continuous', 'minCellSize', 'maxGroups', 'rowSampleLimit', 'methodologyAttribution'];
const REQUIRED_BINARY    = ['rateRatioWarn', 'rateRatioFail', 'absDiffWarn', 'absDiffFail'];
const REQUIRED_CONTINUOUS = ['smdWarn', 'smdFail'];

// ---- Registry state ----------------------------------------------------
const registry = new Map();

// ---- Built-in pack registration ----------------------------------------
function registerBuiltIn(pack) {
  const errs = validatePack(pack);
  if (errs.length > 0) {
    throw new Error('Built-in rulepack "' + pack.id + '" failed validation:\n' + errs.join('\n'));
  }
  registry.set(pack.id, pack);
}

registerBuiltIn(healthcarePack);
registerBuiltIn(generalPack);

// ---- Public API --------------------------------------------------------

/**
 * Get a rulepack by id. Falls back to 'general' if not found.
 *
 * @param {string} id - rulepack id (e.g. 'healthcare', 'general')
 * @returns {object} rulepack
 */
export function getRulepack(id) {
  if (!id || !registry.has(id)) {
    return registry.get('general');
  }
  return registry.get(id);
}

/**
 * List all registered rulepacks.
 *
 * @returns {Array<{id, version, label, domain, description}>}
 */
export function listRulepacks() {
  return Array.from(registry.values()).map(p => ({
    id: p.id,
    version: p.version,
    label: p.label,
    domain: p.domain,
    description: p.description,
    publishedAt: p.publishedAt || null,
  }));
}

/**
 * Register a custom rulepack at runtime.
 * Validates shape before storing.
 *
 * @param {object} pack
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function registerPack(pack) {
  const errs = validatePack(pack);
  if (errs.length > 0) return { ok: false, errors: errs };
  registry.set(pack.id, pack);
  return { ok: true, errors: [] };
}

/**
 * Validate a rulepack object. Returns an array of error strings.
 * Empty array = valid.
 *
 * @param {object} pack
 * @returns {string[]}
 */
export function validatePack(pack) {
  const errs = [];
  if (!pack || typeof pack !== 'object') {
    return ['Rulepack must be a non-null object.'];
  }
  for (const f of REQUIRED_FIELDS) {
    if (pack[f] === undefined || pack[f] === null) errs.push('Missing required field: ' + f);
  }
  if (pack.freshness && typeof pack.freshness === 'object') {
    for (const f of REQUIRED_FRESHNESS) {
      if (pack.freshness[f] === undefined) errs.push('freshness.' + f + ' is required');
    }
    if (pack.freshness.decayShape && !['linear', 'exponential'].includes(pack.freshness.decayShape)) {
      errs.push('freshness.decayShape must be "linear" or "exponential"');
    }
    if (typeof pack.freshness.decayFloor === 'number' && (pack.freshness.decayFloor < 0 || pack.freshness.decayFloor > 1)) {
      errs.push('freshness.decayFloor must be between 0 and 1');
    }
  }
  if (pack.equity && typeof pack.equity === 'object') {
    for (const f of REQUIRED_EQUITY) {
      if (pack.equity[f] === undefined) errs.push('equity.' + f + ' is required');
    }
    if (pack.equity.binary && typeof pack.equity.binary === 'object') {
      for (const f of REQUIRED_BINARY) {
        if (typeof pack.equity.binary[f] !== 'number') errs.push('equity.binary.' + f + ' must be a number');
      }
    }
    if (pack.equity.continuous && typeof pack.equity.continuous === 'object') {
      for (const f of REQUIRED_CONTINUOUS) {
        if (typeof pack.equity.continuous[f] !== 'number') errs.push('equity.continuous.' + f + ' must be a number');
      }
    }
  }
  return errs;
}

/**
 * Build a version-pin record for embedding in a Trust Certificate.
 * Records which rulepack was active at the time of a validation run.
 *
 * @param {string} packId
 * @param {string} [validatedAt] - ISO timestamp; defaults to now
 * @returns {object} version pin
 */
export function buildVersionPin(packId, validatedAt = new Date().toISOString()) {
  const pack = getRulepack(packId);
  return {
    packId: pack.id,
    packVersion: pack.version,
    packLabel: pack.label,
    domain: pack.domain,
    validatedAt,
    publishedAt: pack.publishedAt || null,
    changelog: pack.changelog || [],
  };
}

/**
 * Diff two version pins. Returns what changed between them.
 * Used by the dataset-differ to label "validated against v1.0 → now on v1.1."
 *
 * @param {object} oldPin - version pin from a previous run
 * @param {object} newPin - version pin from the current run
 * @returns {object} diff result
 */
export function diffVersionPins(oldPin, newPin) {
  if (!oldPin || !newPin) {
    return { changed: false, reason: 'One or both pins are null.' };
  }
  const packChanged = oldPin.packId !== newPin.packId;
  const versionChanged = oldPin.packVersion !== newPin.packVersion;

  if (!packChanged && !versionChanged) {
    return {
      changed: false,
      packId: newPin.packId,
      version: newPin.packVersion,
      reason: 'Same rulepack and version — no threshold changes.',
    };
  }

  const oldPack = getRulepack(oldPin.packId);
  const newPack = getRulepack(newPin.packId);

  // Find changelog entries between the two versions.
  const newChangelog = (newPack.changelog || []).filter(entry => {
    return compareVersions(entry.version, oldPin.packVersion) > 0;
  });

  return {
    changed: true,
    packChanged,
    versionChanged,
    oldPackId: oldPin.packId,
    newPackId: newPin.packId,
    oldVersion: oldPin.packVersion,
    newVersion: newPin.packVersion,
    changelogSinceLastRun: newChangelog,
    thresholdDiff: packChanged ? buildThresholdDiff(oldPack, newPack) : null,
    summary: packChanged
      ? 'Rulepack changed from "' + oldPin.packId + '" to "' + newPin.packId + '". Threshold differences may affect findings.'
      : 'Rulepack version changed from ' + oldPin.packVersion + ' to ' + newPin.packVersion + '. See changelog for details.',
  };
}

// ---- helpers ---------------------------------------------------------------

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function buildThresholdDiff(oldPack, newPack) {
  const diff = {};
  const compare = (path, oldVal, newVal) => {
    if (oldVal !== newVal) diff[path] = { old: oldVal, new: newVal };
  };
  // Equity binary
  const ob = (oldPack.equity || {}).binary || {};
  const nb = (newPack.equity || {}).binary || {};
  for (const k of ['rateRatioWarn', 'rateRatioFail', 'absDiffWarn', 'absDiffFail']) {
    compare('equity.binary.' + k, ob[k], nb[k]);
  }
  // Equity continuous
  const oc = (oldPack.equity || {}).continuous || {};
  const nc = (newPack.equity || {}).continuous || {};
  for (const k of ['smdWarn', 'smdFail']) {
    compare('equity.continuous.' + k, oc[k], nc[k]);
  }
  // Freshness
  const of_ = oldPack.freshness || {};
  const nf = newPack.freshness || {};
  for (const k of ['staleAfterDays', 'expiredAfterDays', 'decayFloor']) {
    compare('freshness.' + k, of_[k], nf[k]);
  }
  return diff;
}
