// ============================================================
// DATAGLOW - Publish-Safe (pure engine)
// ============================================================
// WHY THIS EXISTS
// DataGlow already knows, separately, most of what it needs to know before a
// file leaves: PHI Shield knows whether the text holds anything sensitive
// (js/intelligence/data-glow-phi-shield-canvas.js), the readiness gate knows
// whether the dataset held up (js/gate/readiness-gate.js), Metric Contracts
// know whether a definition is still the one that was agreed
// (js/metrics/metric-contracts.js), and Air-Gap Mode knows whether the human
// asked for nothing to cross the network (js/privacy/air-gap-mode.js).
//
// Every export path had to remember to ask all four, in the right order, and
// none of them asked all four. This module is the single place that combines
// them into one verdict a person can read before they press the button.
//
// THE RULES IT ENCODES, and why each is where it is:
//   - Sensitive values plus a destination off this device is BLOCKED. That is
//     the one hard refusal, because it is the only case where being wrong is
//     unrecoverable: a file that has left cannot be unshared.
//   - Sensitive values staying on this device is CAUTION with a safer default
//     preselected, not a refusal. The human owns the disk. Refusing would be
//     theatre, and it is the same call Notebook-to-App already made.
//   - Air-Gap Mode plus a destination off this device is BLOCKED, because that
//     is exactly the crossing the mode exists to prevent.
//   - Missing evidence is never a clear. No PHI scan, or no readiness result,
//     produces CAUTION that says which check could not run. A gate that
//     reports "fine" when it did not look is worse than no gate. A caller whose
//     artifact genuinely has no dataset behind it must say so out loud, by
//     passing readiness: 'not-applicable'; it cannot get that by staying quiet.
//   - Failing readiness, or a broken metric contract, is CAUTION and not a
//     block. Both are quality signals about the numbers, not privacy ones, and
//     a human is allowed to export a draft they know is a draft.
//
// WHAT IT NEVER DOES. It does not mutate anything, it does not write, and it
// does not decide on the human's behalf: it returns a verdict plus a suggested
// safer default, and the caller still has to show it and wait. It also cannot
// gather its own evidence, on purpose. Every input is passed in by the surface
// that already had it, so this file has no idea what a window is.
//
// PURITY: no DOM, no network, no crypto, no engine. Identical in the browser,
// the Tauri desktop webview, and headless Node tests.

export const PUBLISH_SAFE_KIND = 'dataglow-publish-safe';
export const PUBLISH_SAFE_VERSION = 1;

// Ordered least to most severe. The verdict is the most severe reason found,
// so adding a level here means deciding where it sits in that order.
export const PUBLISH_SAFE_LEVELS = Object.freeze(['clear', 'caution', 'blocked']);

// Where the artifact is going. 'this-device' is a file written to the machine
// the human is sitting at. 'off-device' is anything else: an upload, a share
// link, a cloud publish, a paste into a chat.
export const PUBLISH_DESTINATIONS = Object.freeze(['this-device', 'off-device']);

const LEVEL_RANK = Object.freeze({ clear: 0, caution: 1, blocked: 2 });

export const PUBLISH_SAFE_DISCLAIMER =
  'Publish-Safe checks what is known about this export before it happens: '
  + 'whether sensitive values were found in what would travel, whether the '
  + 'dataset passed its readiness checks, whether the metric definitions '
  + 'behind it are still the agreed ones, and whether Air-Gap Mode is on. It '
  + 'reports what it found and suggests the safer default. It cannot see '
  + 'anything it was not given, so it says which checks could not run rather '
  + 'than treating a missing check as a pass.';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function worst(a, b) {
  return (LEVEL_RANK[b] ?? 0) > (LEVEL_RANK[a] ?? 0) ? b : a;
}

export function normalizeDestination(destination) {
  if (destination === 'off-device' || destination === 'offdevice' || destination === 'remote') {
    return 'off-device';
  }
  return 'this-device';
}

function countPhrase(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Reads the shape PHI Shield's guardOrBlock() returns, or the smaller shape a
 * caller may already have. Anything unreadable counts as "could not run",
 * never as "clean".
 */
function readPhi(phi) {
  if (!isPlainObject(phi)) return { ran: false, found: false, count: 0, patterns: [] };
  const ran = phi.available === true || phi.ok === true;
  if (!ran) return { ran: false, found: false, count: 0, patterns: [] };
  const patterns = Array.isArray(phi.patterns)
    ? phi.patterns.filter((p) => typeof p === 'string' && p)
    : [];
  const count = Number.isFinite(phi.count) ? phi.count : (phi.sensitiveFound ? 1 : 0);
  return { ran: true, found: !!phi.sensitiveFound, count, patterns };
}

/**
 * Reads a computeReadinessGate() result. An absent result is "not checked",
 * which is a caution and not a pass: a dataset extract whose quality was never
 * measured is exactly the thing a reader would want warned about.
 *
 * The one exception is the literal string 'not-applicable', which a caller
 * passes when the artifact is not a dataset extract at all. A notebook saved as
 * a one-file app holds code and the output it already produced, so a dataset
 * readiness score says nothing about it, and cautioning on every save would
 * teach people to ignore the caution. Saying it out loud is required: the
 * caller has to name the exception rather than get it by passing nothing.
 */
function readReadiness(readiness) {
  if (readiness === 'not-applicable') {
    return { ran: false, applicable: false, passed: false, score: null, threshold: null, failing: 0 };
  }
  if (!isPlainObject(readiness)) {
    return { ran: false, applicable: true, passed: false, score: null, threshold: null, failing: 0 };
  }
  const failing = Array.isArray(readiness.failingLayers) ? readiness.failingLayers.length : 0;
  return {
    ran: true,
    applicable: true,
    passed: readiness.agentConsumable === true,
    score: Number.isFinite(readiness.score) ? readiness.score : null,
    threshold: Number.isFinite(readiness.threshold) ? readiness.threshold : null,
    failing,
  };
}

/**
 * Reads the metric contract status shape js/metrics/metric-contract-status.js
 * produces, which is the same shape computeReadinessGate() already accepts.
 * Optional: no status means the export is not metric-backed, which is normal
 * and not a caution.
 */
function readContract(status) {
  if (!isPlainObject(status)) return { present: false, broken: false, brokenNames: [] };
  const broken = status.ok === false || status.valid === false || status.broken === true;
  const brokenNames = Array.isArray(status.brokenMetrics)
    ? status.brokenMetrics.map((m) => (typeof m === 'string' ? m : (m && m.name))).filter(Boolean)
    : [];
  return { present: true, broken, brokenNames };
}

/**
 * The gate. Takes only evidence the calling surface already gathered and
 * returns a verdict. Never throws: an export path must not break because a
 * check could not be read.
 *
 * @param {object} input
 * @param {string} input.destination      'this-device' | 'off-device'
 * @param {object} input.phi              PHI Shield guardOrBlock() result, or null
 * @param {object} input.readiness        computeReadinessGate() result, or null
 * @param {object} input.metricContract   metric contract status, or null
 * @param {boolean} input.airGapActive    whether Air-Gap Mode is on
 * @param {boolean} input.includesResults whether computed results travel too
 * @param {string} input.artifact         what is being written, for the copy
 */
export function evaluatePublishSafe(input = {}) {
  const opts = isPlainObject(input) ? input : {};
  const destination = normalizeDestination(opts.destination);
  const offDevice = destination === 'off-device';
  const artifact = typeof opts.artifact === 'string' && opts.artifact.trim() ? opts.artifact.trim() : 'this file';
  const phi = readPhi(opts.phi);
  const readiness = readReadiness(opts.readiness);
  const contract = readContract(opts.metricContract);
  const airGapActive = opts.airGapActive === true;
  const includesResults = opts.includesResults !== false;

  const reasons = [];
  const add = (code, level, text) => reasons.push({ code, level, text });

  if (airGapActive && offDevice) {
    add('air-gap-egress', 'blocked',
      'Air-Gap Mode is on, and this would send something off this device. That is the crossing the mode exists to stop, so it is refused.');
  } else if (airGapActive) {
    add('air-gap-local', 'clear',
      'Air-Gap Mode is on. Writing a file to this device crosses no network, so it is allowed.');
  }

  if (!phi.ran) {
    add('phi-unavailable', 'caution',
      'PHI Shield could not check this text, so nothing is known about whether it holds sensitive values. Read it yourself before it travels.');
  } else if (phi.found && offDevice) {
    const what = phi.patterns.length ? ` (${phi.patterns.join(', ')})` : '';
    add('phi-off-device', 'blocked',
      `PHI Shield found ${countPhrase(phi.count, 'possible sensitive value', 'possible sensitive values')}${what} in what would travel, and this would leave the device. A file that has left cannot be unshared, so it is refused.`);
  } else if (phi.found) {
    const what = phi.patterns.length ? ` (${phi.patterns.join(', ')})` : '';
    add('phi-this-device', 'caution',
      `PHI Shield found ${countPhrase(phi.count, 'possible sensitive value', 'possible sensitive values')}${what}. This stays on your device, so it is your call, but leaving the results out is the safer start and is preselected.`);
  } else {
    add('phi-clear', 'clear', 'PHI Shield found no sensitive values in what would be written.');
  }

  if (!readiness.applicable) {
    // Deliberately silent: a row saying "this check does not apply" is noise.
    // checked.readiness still reports 'not-applicable' for anything auditing it.
  } else if (!readiness.ran) {
    add('readiness-unknown', 'caution',
      'This dataset has not been through the readiness checks in this session, so how well it holds up is unknown.');
  } else if (!readiness.passed) {
    const score = readiness.score === null ? 'below' : `${readiness.score}/100, below`;
    const threshold = readiness.threshold === null ? 'the threshold' : `the threshold of ${readiness.threshold}`;
    const failing = readiness.failing > 0
      ? ` ${countPhrase(readiness.failing, 'check', 'checks')} did not pass.`
      : '';
    add('readiness-failed', 'caution',
      `Readiness scored ${score} ${threshold}.${failing} Exporting is allowed, but whoever reads this should know it is a draft.`);
  } else {
    const score = readiness.score === null ? '' : ` with a score of ${readiness.score}/100`;
    add('readiness-passed', 'clear', `This dataset passed its readiness checks${score}.`);
  }

  if (contract.present && contract.broken) {
    const named = contract.brokenNames.length ? `: ${contract.brokenNames.join(', ')}` : '';
    add('contract-broken', 'caution',
      `A metric definition behind these numbers no longer matches the version that was agreed${named}. The numbers may not mean what a reader expects.`);
  } else if (contract.present) {
    add('contract-ok', 'clear', 'Every metric definition behind these numbers is the version that was agreed.');
  }

  let level = 'clear';
  for (const r of reasons) level = worst(level, r.level);
  const blocked = level === 'blocked';

  const where = offDevice ? 'off this device' : 'to this device';
  let headline;
  if (blocked) {
    headline = `Publish-Safe is refusing to send ${artifact} ${where}. `
      + reasons.filter((r) => r.level === 'blocked').map((r) => r.text).join(' ');
  } else if (level === 'caution') {
    const n = reasons.filter((r) => r.level === 'caution').length;
    headline = `${artifact} can be written ${where}, with ${countPhrase(n, 'thing', 'things')} worth reading first.`;
  } else {
    headline = `Every check passed. ${artifact} can be written ${where}.`;
  }

  return {
    version: PUBLISH_SAFE_VERSION,
    level,
    blocked,
    destination,
    artifact,
    headline,
    reasons,
    // Ordered worst first, because a person reads the top of a list.
    lines: reasons
      .slice()
      .sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0))
      .map((r) => r.text),
    // A suggestion, never an action. The caller preselects it and the human
    // can still change it, the same order Notebook-to-App uses for a PHI hit.
    preselect: {
      includeResults: !(phi.found && includesResults) && !blocked,
    },
    checked: {
      phi: phi.ran ? (phi.found ? 'found' : 'clear') : 'unavailable',
      phiFound: phi.found,
      phiCount: phi.count,
      readiness: readiness.applicable
        ? (readiness.ran ? (readiness.passed ? 'passed' : 'failed') : 'unavailable')
        : 'not-applicable',
      readinessScore: readiness.score,
      metricContract: contract.present ? (contract.broken ? 'broken' : 'ok') : 'not-applicable',
      airGapActive,
      includesResults,
    },
  };
}

/** Plain text rendering, for a toast, a log, or an export footer. */
export function describePublishSafe(verdict) {
  if (!isPlainObject(verdict)) return 'Publish-Safe reached no verdict.';
  const lines = [verdict.headline || 'Publish-Safe reached no verdict.'];
  for (const l of Array.isArray(verdict.lines) ? verdict.lines : []) lines.push(`- ${l}`);
  return lines.join('\n');
}

/**
 * One short label for a badge. Deliberately not the headline: a badge that
 * repeats a paragraph is not a badge.
 */
export function publishSafeBadge(verdict) {
  const level = isPlainObject(verdict) && PUBLISH_SAFE_LEVELS.includes(verdict.level) ? verdict.level : 'caution';
  if (level === 'blocked') return { level, text: 'Refused', tone: 'danger' };
  if (level === 'caution') return { level, text: 'Check first', tone: 'warn' };
  return { level, text: 'Safe to write', tone: 'ok' };
}

export const DataGlowPublishSafe = {
  PUBLISH_SAFE_KIND,
  PUBLISH_SAFE_VERSION,
  PUBLISH_SAFE_LEVELS,
  PUBLISH_DESTINATIONS,
  PUBLISH_SAFE_DISCLAIMER,
  normalizeDestination,
  evaluatePublishSafe,
  describePublishSafe,
  publishSafeBadge,
};

// Same publication pattern as notebook-app-export.js: the canvas surface reads
// the namespace off window because its inlined copy has no module scope.
try {
  if (typeof window !== 'undefined') window.DataGlowPublishSafeEngine = DataGlowPublishSafe;
} catch (_e) { /* no window in Node tests */ }
