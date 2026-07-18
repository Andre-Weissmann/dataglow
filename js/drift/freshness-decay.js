// ============================================================
// DATAGLOW — Freshness Decay (Phase 4)
// ============================================================
// Computes how much a dataset's trust score should be discounted
// based on how old the data is. A fresh dataset gets full score.
// A stale dataset gets a progressively lower multiplier. An expired
// dataset is capped at the rulepack's decayFloor.
//
// WHY THIS EXISTS:
// A claims dataset validated last week is not the same trust level
// as the same dataset from 14 months ago. Coding practices change,
// population composition shifts, policies are updated. The Trust
// Certificate should reflect that temporal degradation honestly.
//
// DESIGN:
// Pure and synchronous. Takes dates + a rulepack freshness config
// and returns a multiplier (0 < multiplier <= 1.0) plus human-readable
// decay metadata. No DuckDB, no DOM, no network.
//
// DECAY SHAPES:
//   linear      -- gradual, even decay from stale to expiry
//   exponential -- fast initial decay, slows at expiry
//
// USAGE:
//   const decay = computeFreshnessDecay({ dataDate, rulepack });
//   const adjustedScore = baseScore * decay.multiplier;

import { getRulepack } from '../rulepacks/rulepack-registry.js';

/**
 * Compute freshness decay for a dataset.
 *
 * @param {object} opts
 * @param {string|Date|null} opts.dataDate
 *   The date the data was collected / exported. ISO string or Date.
 *   If null, decay cannot be computed -> status 'unknown'.
 * @param {string|Date} [opts.asOf]
 *   Reference date for age computation. Defaults to now.
 * @param {string} [opts.packId]
 *   Rulepack id to pull freshness config from.
 * @param {object} [opts.freshnessConfig]
 *   Override freshness config directly (for testing / custom packs).
 * @returns {object} decay result
 */
export function computeFreshnessDecay({ dataDate, asOf, packId, freshnessConfig } = {}) {
  const config = freshnessConfig || getRulepack(packId || 'general').freshness;
  const { staleAfterDays, expiredAfterDays, decayFloor, decayShape, rationale } = config;

  // Parse dates.
  const refDate = asOf ? new Date(asOf) : new Date();
  if (!dataDate) {
    return makeFreshnessResult({
      status: 'unknown', multiplier: 1.0, ageDays: null, staleAfterDays,
      expiredAfterDays, decayFloor, decayShape,
      rationale: 'No data date provided -- freshness decay cannot be computed. Assuming fresh (multiplier 1.0).',
    });
  }

  const d = new Date(dataDate);
  if (isNaN(d.getTime())) {
    return makeFreshnessResult({
      status: 'unknown', multiplier: 1.0, ageDays: null, staleAfterDays,
      expiredAfterDays, decayFloor, decayShape,
      rationale: 'Invalid data date "' + String(dataDate) + '" -- freshness decay cannot be computed. Assuming fresh.',
    });
  }

  const ageDays = Math.max(0, (refDate.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));

  // Fresh: within stale window.
  if (ageDays <= staleAfterDays) {
    return makeFreshnessResult({
      status: 'fresh', multiplier: 1.0, ageDays, staleAfterDays,
      expiredAfterDays, decayFloor, decayShape,
      rationale: 'Data is ' + fmtDays(ageDays) + ' old -- within the fresh window (' + staleAfterDays + ' days). No trust penalty.',
    });
  }

  // Expired: past expiry window.
  if (ageDays >= expiredAfterDays) {
    return makeFreshnessResult({
      status: 'expired', multiplier: decayFloor, ageDays, staleAfterDays,
      expiredAfterDays, decayFloor, decayShape,
      rationale: 'Data is ' + fmtDays(ageDays) + ' old -- past expiry threshold (' + expiredAfterDays + ' days). ' +
        'Trust score capped at ' + fmtPct(decayFloor) + ' of original. ' + rationale,
    });
  }

  // Stale: between stale and expiry windows -> apply decay.
  const decayRange = expiredAfterDays - staleAfterDays;
  const decayProgress = (ageDays - staleAfterDays) / decayRange; // 0..1

  let multiplier;
  if (decayShape === 'exponential') {
    // Exponential: fast initial drop, levels off.
    // multiplier = decayFloor + (1 - decayFloor) * e^(-3 * decayProgress)
    multiplier = decayFloor + (1 - decayFloor) * Math.exp(-3 * decayProgress);
  } else {
    // Linear: even decay.
    multiplier = 1.0 - (1.0 - decayFloor) * decayProgress;
  }
  // Clamp to [decayFloor, 1.0].
  multiplier = Math.min(1.0, Math.max(decayFloor, multiplier));

  return makeFreshnessResult({
    status: 'stale', multiplier, ageDays, staleAfterDays,
    expiredAfterDays, decayFloor, decayShape, decayProgress,
    rationale: 'Data is ' + fmtDays(ageDays) + ' old -- stale (threshold ' + staleAfterDays + ' days). ' +
      'Trust score multiplier: ' + fmt2(multiplier) + ' (' + fmtPct(multiplier) + ' of original, ' +
      decayShape + ' decay). ' + rationale,
  });
}

/**
 * Apply a freshness multiplier to a numeric trust score.
 * Convenience wrapper around computeFreshnessDecay.
 *
 * @param {number} score - base trust score (0..100 or 0..1)
 * @param {object} decayResult - from computeFreshnessDecay()
 * @returns {{ adjustedScore: number, originalScore: number, multiplier: number }}
 */
export function applyFreshnessDecay(score, decayResult) {
  const multiplier = (decayResult && typeof decayResult.multiplier === 'number')
    ? decayResult.multiplier : 1.0;
  return {
    originalScore: score,
    adjustedScore: score * multiplier,
    multiplier,
  };
}

/**
 * Human-readable freshness summary for a Trust Certificate.
 *
 * @param {object} decayResult - from computeFreshnessDecay()
 * @returns {string}
 */
export function freshnessLabel(decayResult) {
  if (!decayResult) return 'Unknown';
  switch (decayResult.status) {
    case 'fresh':   return 'Fresh (' + fmtDays(decayResult.ageDays) + ' old)';
    case 'stale':   return 'Stale (' + fmtDays(decayResult.ageDays) + ' old, ' + fmtPct(decayResult.multiplier) + ' trust)';
    case 'expired': return 'Expired (' + fmtDays(decayResult.ageDays) + ' old, capped at ' + fmtPct(decayResult.multiplier) + ' trust)';
    case 'unknown': return 'Unknown (no data date)';
    default:        return decayResult.status || 'Unknown';
  }
}

// ---- helpers ---------------------------------------------------------------

function makeFreshnessResult({
  status, multiplier, ageDays, staleAfterDays, expiredAfterDays,
  decayFloor, decayShape, decayProgress = null, rationale,
}) {
  return {
    layer: 'freshness_decay',
    status,
    multiplier: parseFloat(multiplier.toFixed(6)),
    ageDays: ageDays !== null ? parseFloat(ageDays.toFixed(1)) : null,
    staleAfterDays,
    expiredAfterDays,
    decayFloor,
    decayShape,
    decayProgress: decayProgress !== null ? parseFloat(decayProgress.toFixed(4)) : null,
    rationale,
  };
}

function fmtDays(d) {
  if (d === null || d === undefined) return '?';
  const rounded = Math.round(d);
  if (rounded === 1) return '1 day';
  return rounded + ' days';
}

function fmtPct(v) { return Math.round(v * 100) + '%'; }
function fmt2(v) { return v.toFixed(2); }
