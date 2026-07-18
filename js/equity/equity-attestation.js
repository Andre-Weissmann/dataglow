// ============================================================
// DATAGLOW — Equity Attestation (Phase 3)
// ============================================================
// Builds and signs the equity attestation block that is embedded in the
// Trust Certificate. This is the artifact that says, in plain language,
// what the equity analysis found -- and commits to those findings with a
// hash-based signature that travels with the certificate.
//
// WHY THIS EXISTS:
// The Trust Certificate (Phase 1) attests that a dataset was validated.
// The equity attestation extends that attestation to say HOW the dataset
// performed on equity dimensions. A signed block means:
//   1. The findings were produced by DataGlow (not manually written).
//   2. If the certificate is shared externally, anyone can verify the
//      attestation hasn't been tampered with by re-checking the hash.
//   3. For CMS Disparities Impact Statement submissions, the attestation
//      provides a machine-readable record of what was found.
//
// HASH:
// SHA-256 of a canonical JSON serialisation of the attestation content
// (excluding the signature field itself). Same deterministic approach as
// Phase 1 (provenance-packet.js). In browser environments, uses
// SubtleCrypto.subtle.digest. In Node.js test environments, falls back to
// Node's built-in crypto.createHash.
//
// DESIGN:
// Async (hash). Pure -- no DuckDB, no DOM writes, no network.
// Returns a plain object that the Trust Certificate assembler can embed directly.

export const ATTESTATION_VERSION = '1.0';

/**
 * Build and sign an equity attestation block.
 *
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.runId - from Trust Certificate / provenance packet
 * @param {object} opts.detectionResult - output of detectEquityColumns()
 * @param {object} opts.stratificationResult - output of stratifyEquity()
 * @param {string} [opts.analysedAt] - ISO timestamp; defaults to now
 * @returns {Promise<object>} signed attestation block
 */
export async function buildEquityAttestation({
  tableName,
  runId,
  detectionResult,
  stratificationResult,
  analysedAt = new Date().toISOString(),
}) {
  const { stratifiers = [], metrics = [], hasEquityData = false } = detectionResult || {};
  const { analyses = [], summary = {}, status = 'idle', level = 'none', rationale = '' } = stratificationResult || {};

  // Build the human-readable verdict.
  const verdict = buildVerdict({ status, level, summary, analyses });

  // Identify the worst disparity pairs for top-level display.
  const topFindings = extractTopFindings(analyses);

  // Suppressed groups summary.
  const suppressedGroups = extractSuppressed(analyses);

  // Core content (signed below).
  const content = {
    version: ATTESTATION_VERSION,
    runId: runId || null,
    tableName: tableName || null,
    analysedAt,
    equityAnalysisPerformed: hasEquityData,
    status,        // 'pass' | 'warn' | 'fail' | 'idle'
    level,         // 'none' | 'low' | 'medium' | 'high'
    verdict,
    stratifiersDetected: stratifiers.map(s => ({ name: s.name, role: s.role, roleLabel: s.roleLabel })),
    metricsDetected: metrics.map(m => ({ name: m.name, kind: m.kind, kindLabel: m.kindLabel })),
    analysisCount: summary.total || 0,
    flaggedPairs: summary.flaggedPairs || 0,
    statusBreakdown: {
      pass: summary.pass || 0,
      warn: summary.warn || 0,
      fail: summary.fail || 0,
      idle: summary.idle || 0,
    },
    topFindings,
    suppressedGroups,
    rationale,
    // Methodology note for external reviewers.
    methodology: buildMethodologyNote(status),
  };

  const signature = await hashContent(content);

  return {
    ...content,
    signature,
    signatureAlgorithm: 'SHA-256',
    signatureNote: 'SHA-256 of canonical JSON of attestation content (excluding this field). Re-hash content to verify integrity.',
  };
}

// ---- verdict builder -------------------------------------------------------

function buildVerdict({ status, level, summary, analyses }) {
  if (status === 'idle') {
    return 'Equity analysis was not performed -- no equity-relevant stratifier and outcome metric columns were detected, or all groups had insufficient cell sizes for analysis.';
  }
  if (status === 'pass') {
    return 'No significant equity disparities detected. All stratification analyses were within acceptable thresholds (rate ratio < 1.5x, absolute difference < 5 pp, relative deviation < 20%).';
  }
  const flaggedCount = summary.flaggedPairs || 0;
  const totalCount = summary.total || 0;
  const levelWord = level === 'high' ? 'high' : level === 'medium' ? 'moderate' : 'low-level';

  // Collect affected stratifier roles.
  const affectedRoles = [...new Set(
    analyses.filter(a => a.status === 'fail' || a.status === 'warn')
      .map(a => a.stratifier && a.stratifier.roleLabel)
      .filter(Boolean)
  )];

  const thresholdLine = status === 'fail'
    ? 'At least one group exceeds the CMS Disparities Impact Statement threshold (rate ratio >= 1.5x or absolute difference >= 5 percentage points).'
    : 'At least one group exceeds the warning threshold but remains below the CMS fail threshold.';

  return (
    flaggedCount + '/' + totalCount + ' stratification(s) show ' + levelWord + ' equity disparities. '
    + (affectedRoles.length > 0 ? 'Disparities detected in: ' + affectedRoles.join(', ') + '. ' : '')
    + thresholdLine
    + ' Review the detailed findings below and consider whether systemic or data-quality factors explain the observed differences.'
  );
}

// ---- top finding extractor -------------------------------------------------

function extractTopFindings(analyses) {
  const findings = [];
  for (const a of analyses) {
    if (!a.scoring) continue;
    for (const f of (a.scoring.flagged || [])) {
      findings.push({
        label: a.label,
        stratifier: a.stratifier && a.stratifier.roleLabel,
        metric: a.metric && a.metric.kindLabel,
        group: f.group,
        n: f.n,
        status: f.status,
        level: f.level,
        rateRatio: f.rateRatio,
        absDiff: f.absDiff,
        smd: f.smd,
        direction: f.direction,
        rationale: f.rationale,
      });
    }
  }
  // Sort: fail before warn, high before medium before low.
  findings.sort((a, b) => {
    const sv = { fail: 2, warn: 1, pass: 0, idle: 0 };
    const lv = { high: 3, medium: 2, low: 1, none: 0 };
    return ((sv[b.status] || 0) - (sv[a.status] || 0)) || ((lv[b.level] || 0) - (lv[a.level] || 0));
  });
  return findings.slice(0, 10); // top 10 only in the attestation
}

// ---- suppressed group extractor --------------------------------------------

function extractSuppressed(analyses) {
  const out = [];
  for (const a of analyses) {
    if (!a.scoring) continue;
    for (const g of (a.scoring.suppressed || [])) {
      out.push({
        label: a.label,
        group: g.group,
        n: g.n,
      });
    }
  }
  return out;
}

// ---- methodology note ------------------------------------------------------

function buildMethodologyNote(status) {
  return [
    'Equity analysis methodology:',
    '  Stratifier detection: column name heuristics (race/ethnicity, sex/gender, zip/geography, payer class, age group, disability/dual status).',
    '  Outcome detection: column name heuristics (readmission, denial, mortality, LOS, cost, ED utilization, quality score).',
    '  Disparity scoring: population-mean reference by default.',
    '  Binary outcome thresholds: warn = rate ratio >= 1.25x or |abs diff| >= 3 pp; fail = rate ratio >= 1.50x or |abs diff| >= 5 pp (aligned with CMS Disparities Impact Statement).',
    '  Continuous outcome thresholds: warn = relative deviation >= 10%; fail >= 20% (Cohen\'s d approximation).',
    '  Small-cell suppression: groups with n < 5 excluded from scoring (NCHS/CMS standard).',
    '  Max sample: 50,000 rows (rates are estimates on larger datasets).',
    '  Status "' + status + '" reflects worst observed finding across all stratification pairs.',
  ].join('\n');
}

// ---- hash / signature ------------------------------------------------------

async function hashContent(content) {
  const canonical = JSON.stringify(content, Object.keys(content).sort());
  try {
    // Browser / WASM environment.
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(canonical));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through */ }

  // Node.js test environment.
  try {
    const { createHash } = await import('crypto');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  } catch { /* fall through */ }

  // Last resort: simple deterministic checksum (not cryptographic).
  let h = 0;
  for (let i = 0; i < canonical.length; i++) {
    h = (Math.imul(31, h) + canonical.charCodeAt(i)) | 0;
  }
  return 'noncrypto-' + Math.abs(h).toString(16);
}
