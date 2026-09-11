// ============================================================
// DATAGLOW - Trust Passport Export & Independent Verify (Batch 2)
// ============================================================
// WHY THIS EXISTS
// Batch 1 (js/provenance/trust-passport.js) builds a Trust Passport but keeps
// it in memory only -- it cannot leave the app. The moment a passport is
// pasted into an email, attached to a ticket, or handed to a reviewer who has
// never opened DATAGLOW, there is nothing stopping someone from editing the
// score, deleting a "deny" row from the permission table, or backdating it.
//
// This module makes a passport PORTABLE and INDEPENDENTLY VERIFIABLE. It
// invents no new cryptography: it reuses the exact Merkle/SHA-256 primitives
// already shipped in js/provenance/verifiable-check-seal.js (sealCheckResult /
// verifySeal), the same mechanism DATAGLOW already uses to seal check
// results. A sealed passport export can be re-checked by anyone holding only
// the exported file -- no DATAGLOW installation, no network call, no shared
// secret -- because verifySeal() only recomputes hashes.
//
// WHAT THIS ACTUALLY PROVES (same honesty discipline as verifiable-check-seal.js):
//   - It is a Merkle-tree (SHA-256) commitment over the passport's own fields
//     (readiness score/passed, touch count, ownership summary, and every row
//     of the permission table). Editing any one of those after export breaks
//     the match on re-verification.
// WHAT THIS IS NOT:
//   - Not a signature or a zero-knowledge proof -- there is no secret key.
//     Anyone willing to recompute every field can mint a fresh, internally
//     consistent sealed export. This is tamper-EVIDENCE, not proof of
//     authorship.
//   - Not a certification that the underlying dataset is trustworthy -- only
//     that the exported passport's fields are unaltered since export.
//   - Not a legal, clinical, or regulatory determination.
//
// PURITY: no DOM, no network, no storage. exportTrustPassport /
// verifyTrustPassportExport are pure functions; identical in the browser, the
// Tauri desktop webview, and headless Node tests.

import { sealCheckResult, verifySeal, canonicalJSON } from './verifiable-check-seal.js';

export const TRUST_PASSPORT_EXPORT_KIND = 'dataglow-trust-passport-export';
export const TRUST_PASSPORT_EXPORT_VERSION = 1;

export const TRUST_PASSPORT_EXPORT_DISCLAIMER =
  'This is a sealed DATAGLOW Trust Passport export: a Merkle-tree (SHA-256) '
  + 'commitment over the passport fields shown below, re-checkable by anyone '
  + 'holding only this file, with no access to DATAGLOW. It is NOT a signature, '
  + 'NOT a zero-knowledge proof, and NOT a certification that the underlying '
  + 'dataset is trustworthy -- only that these fields are unaltered since '
  + 'export. Not a legal, clinical, or regulatory determination.';

// Turn a Trust Passport into the fixed {status, flagCount} shape
// sealCheckResult() expects as its "result", and stash the full passport as
// the sealed context.data so the fingerprint binds to every field, not just
// a summary.
function passportAsCheckResult(passport) {
  const deny = passport.permissions.filter((p) => p.status === 'deny').length;
  const gate = passport.permissions.filter((p) => p.status === 'gate').length;
  return {
    status: passport.readiness.passed === false ? 'fail' : (passport.readiness.passed === true ? 'pass' : 'unknown'),
    flagCount: deny + gate,
  };
}

/**
 * Seal a Trust Passport (from buildTrustPassport()) into a portable,
 * independently-verifiable export. Never mutates the passport. Throws only
 * if `passport` is not a well-formed Trust Passport (fail loud here, same as
 * sealCheckResult's own refusal to seal with no data binding).
 *
 * @param {Object} passport - output of buildTrustPassport()
 * @returns {Promise<Object>} the sealed export
 */
export async function sealTrustPassport(passport) {
  if (!passport || passport.kind !== 'dataglow-trust-passport') {
    throw new Error(
      'sealTrustPassport: expected a Trust Passport object (kind === '
      + '"dataglow-trust-passport"). Refusing to seal something that is not one.');
  }

  const result = passportAsCheckResult(passport);
  const seal = await sealCheckResult(result, {
    data: passport,
    check: { name: 'Trust Passport', kind: 'trust-passport-snapshot' },
    dataset: {
      id: passport.datasetId ?? undefined,
      label: passport.datasetLabel ?? undefined,
    },
    generatedAt: passport.generatedAt,
  });

  return {
    kind: TRUST_PASSPORT_EXPORT_KIND,
    version: TRUST_PASSPORT_EXPORT_VERSION,
    generatedAt: passport.generatedAt,
    passport,
    seal,
    disclaimer: TRUST_PASSPORT_EXPORT_DISCLAIMER,
  };
}

/**
 * Independently verify a sealed Trust Passport export. Pure -- recomputes
 * hashes from the export's own fields and the seal's Merkle proofs. Pass the
 * export produced by sealTrustPassport(); no other DATAGLOW state is needed.
 *
 * @param {Object} sealedExport - output of sealTrustPassport()
 * @returns {Promise<{valid:boolean, reason:string, root:string|null, commitmentValid:boolean, dataMatch:boolean|null, claims:Array}>}
 */
export async function verifyTrustPassportExport(sealedExport) {
  if (!sealedExport || sealedExport.kind !== TRUST_PASSPORT_EXPORT_KIND) {
    return {
      valid: false,
      reason: 'Not a DATAGLOW Trust Passport export (missing/incorrect "kind").',
      root: null, commitmentValid: false, dataMatch: null, claims: [],
    };
  }
  if (!sealedExport.seal || !sealedExport.passport) {
    return {
      valid: false,
      reason: 'Export is missing its seal or its passport payload -- nothing to verify.',
      root: null, commitmentValid: false, dataMatch: null, claims: [],
    };
  }
  return verifySeal(sealedExport.seal, sealedExport.passport);
}

/**
 * Render a sealed export as a self-contained string in one of three formats.
 * 'json' is the canonical, machine-reverifiable form (round-trips through
 * verifyTrustPassportExport unchanged). 'markdown' and 'text' are
 * human-readable summaries for pasting into a ticket, email, or slide --
 * they carry the same fields but are NOT themselves re-parseable back into
 * the export; keep the 'json' export alongside them if verification matters.
 *
 * @param {Object} sealedExport - output of sealTrustPassport()
 * @param {'json'|'markdown'|'text'} [format]
 */
export function exportTrustPassport(sealedExport, format = 'json') {
  if (format === 'json') {
    return JSON.stringify(sealedExport, null, 2);
  }

  const p = sealedExport.passport || {};
  const readiness = p.readiness || {};
  const scoreLine = typeof readiness.score === 'number'
    ? `${readiness.score} (${readiness.passed ? 'passed' : 'not passed'})`
    : 'unknown';
  const root = sealedExport.seal && sealedExport.seal.commitment
    ? sealedExport.seal.commitment.merkleRoot
    : null;

  if (format === 'markdown') {
    const lines = [
      '# DATAGLOW Trust Passport (sealed export)',
      '',
      `_Generated ${sealedExport.generatedAt}_`,
      '',
      `**Readiness score:** ${scoreLine}`,
      `**AI touches recorded:** ${p.touchCount ?? 'unknown'}`,
      `**Ownership:** ${p.ownership && p.ownership.label ? p.ownership.label : 'unknown'}`,
      '',
      '| Capability | Status | Reason |',
      '| --- | --- | --- |',
    ];
    for (const perm of (p.permissions || [])) {
      lines.push(`| ${perm.capability} | ${perm.status.toUpperCase()} | ${perm.reason} |`);
    }
    lines.push('', `**Merkle root:** \`${root ?? 'none'}\``, '', `_${TRUST_PASSPORT_EXPORT_DISCLAIMER}_`);
    return lines.join('\n');
  }

  // text
  const lines = [
    'DATAGLOW Trust Passport (sealed export)',
    `Generated ${sealedExport.generatedAt}`,
    '',
    `Readiness score: ${scoreLine}`,
    `AI touches recorded: ${p.touchCount ?? 'unknown'}`,
    `Ownership: ${p.ownership && p.ownership.label ? p.ownership.label : 'unknown'}`,
    '',
    'Permissions:',
  ];
  for (const perm of (p.permissions || [])) {
    lines.push(`  [${perm.status.toUpperCase()}] ${perm.capability} -- ${perm.reason}`);
  }
  lines.push('', `Merkle root: ${root ?? 'none'}`, '', TRUST_PASSPORT_EXPORT_DISCLAIMER);
  return lines.join('\n');
}

export { canonicalJSON };
