// ============================================================
// DATAGLOW — The Crucible (Batch 2 of 3): the read-only Crucible UI
// ============================================================
// WHAT THIS IS: the presenter for The Crucible's already-merged Batch 1 logic.
// It invents NO validation logic of its own — it only surfaces, read-only, the
// two typed handoff objects and the adversarial-pack results Batch 1 produces:
//   - js/validation/crucible-contract.js: buildCleaningResult (the one-way
//     handoff INTO the Crucible) and buildValidationVerdict (the one-way handoff
//     OUT), plus CRUCIBLE_DECISIONS.
//   - js/validation/crucible-adversarial-packs.js: the deterministic packs and
//     runAdversarialSuite() summary.
// Both are treated as stable dependencies; this file does not touch their APIs
// and adds NO new data-mutation code path (that — apply / one-click revert — is
// Batch 3).
//
// IDENTITY SPLIT (same convention as source-convergence-ui.js / room-ui.js):
// the model builders are PURE, Node-testable, DOM-free functions
// (shouldOfferCrucible / buildPipelineModel / buildAdversarialPackListModel /
// buildRunLogModel); the browser-only renderer (mountCrucible) turns those
// models into DOM and is left to the browser/e2e path.
//
// DISCIPLINE:
//   - honest EMPTY STATE: with no results supplied the tab shows the idle
//     3-step pipeline skeleton and a "nothing has been run yet" prompt — it
//     NEVER fabricates the mockup's demo numbers. No orchestration feeds real
//     objects in yet (that is a future batch); a caller may pass real Batch 1
//     output in, and only then are real values shown.
//   - the pure builders NEVER throw — malformed/missing input yields a safe,
//     idle/empty view model.
// ============================================================

import { el } from '../app-shell/utils.js';

// ---------- tiny total helpers ----------

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Accept either a raw typed CleaningResult ({ kind:'CleaningResult', ... }) or
// the wrapped { ok:true, result } that buildCleaningResult returns. Anything
// else -> null (honest "no result"). Never throws.
function asCleaningResult(input) {
  if (!isPlainObject(input)) return null;
  if (input.kind === 'CleaningResult') return input;
  if (input.ok === true && isPlainObject(input.result) && input.result.kind === 'CleaningResult') return input.result;
  return null;
}

// Same for a ValidationVerdict ({ kind:'ValidationVerdict', ... } or the wrapped
// { ok:true, verdict }). Never throws.
function asValidationVerdict(input) {
  if (!isPlainObject(input)) return null;
  if (input.kind === 'ValidationVerdict') return input;
  if (input.ok === true && isPlainObject(input.verdict) && input.verdict.kind === 'ValidationVerdict') return input.verdict;
  return null;
}

// ============================================================
// shouldOfferCrucible({ enabled }) — the single pure gate the caller checks
// before mounting anything. True only when the flag is on. No DOM, no flag read.
// ============================================================
export function shouldOfferCrucible(opts) {
  return isPlainObject(opts) && opts.enabled === true;
}

// ============================================================
// buildPipelineModel(cleaningResult, validationVerdict) — a pure, DOM-free model
// of the three-step Crucible pipeline: Clean Agent -> Crucible Validator ->
// Provenance Ledger. Each step carries a status (idle | running | done) and the
// contract fields it reasons about, pulled straight from the Batch 1 typed
// objects. Missing/malformed input -> an honest all-idle skeleton with no
// fabricated numbers. Never throws.
// ============================================================
export function buildPipelineModel(cleaningResult, validationVerdict) {
  const clean = asCleaningResult(cleaningResult);
  const verdict = asValidationVerdict(validationVerdict);

  const cleanStep = {
    key: 'clean',
    label: 'Clean Agent',
    status: clean ? 'done' : 'idle',
    fields: {
      changesCount: clean && Array.isArray(clean.changes) ? clean.changes.length : 0,
      confidence: clean && typeof clean.confidence === 'number' && Number.isFinite(clean.confidence) ? clean.confidence : null,
      rulesCited: clean && Array.isArray(clean.rulesCited) ? [...clean.rulesCited] : [],
      agentId: clean && typeof clean.agentId === 'string' ? clean.agentId : null,
    },
  };

  // The validator is "running" once a proposal exists but no verdict has come
  // back — an honest in-between state, not a fabricated result.
  const crucibleStep = {
    key: 'crucible',
    label: 'Crucible Validator',
    status: verdict ? 'done' : (clean ? 'running' : 'idle'),
    fields: {
      decision: verdict ? (verdict.decision ?? null) : null,
      escalationReason: verdict ? (verdict.escalationReason ?? null) : null,
      packCount: verdict && Array.isArray(verdict.packResults) ? verdict.packResults.length : 0,
    },
  };

  // The apply / revert Provenance Ledger step is Batch 3 — always idle here, and
  // explicitly labelled so the read-only surface never implies it can mutate.
  const ledgerStep = {
    key: 'ledger',
    label: 'Provenance Ledger',
    status: 'idle',
    note: 'Apply / one-click revert lands in a future Crucible batch (read-only here).',
  };

  return {
    steps: [cleanStep, crucibleStep, ledgerStep],
    hasData: !!(clean || verdict),
  };
}

// A pass/fail badge for a pack outcome. Reuses the existing .badge vocabulary
// (css/base.css); invents no new colors. Never throws.
function packStatusBadge(passed) {
  return passed
    ? { label: 'Pass', className: 'badge badge-a' }
    : { label: 'Fail', className: 'badge badge-c' };
}

// Normalize whatever the caller hands to a pack list into a flat array of pack
// result entries. Accepts the array itself, a runAdversarialSuite() summary
// ({ packResults }), or a ValidationVerdict ({ packResults }). Never throws.
function asPackResultArray(input) {
  if (Array.isArray(input)) return input;
  if (isPlainObject(input) && Array.isArray(input.packResults)) return input.packResults;
  return [];
}

// ============================================================
// buildAdversarialPackListModel(packResults) — a pure, DOM-free list model of
// each adversarial pack's pass/fail outcome (id / label / category / passed).
// Accepts the packResults array, a runAdversarialSuite() summary, or a
// ValidationVerdict. Malformed/empty -> an empty list. Never throws.
// ============================================================
export function buildAdversarialPackListModel(packResults) {
  const arr = asPackResultArray(packResults);
  const packs = arr.filter(isPlainObject).map((p) => {
    const passed = p.passed === true;
    const failureCount = Array.isArray(p.failures) ? p.failures.length : 0;
    return {
      id: p.id != null ? String(p.id) : '(unnamed pack)',
      label: typeof p.label === 'string' && p.label.trim() !== '' ? p.label : (p.id != null ? String(p.id) : '(unnamed pack)'),
      category: typeof p.category === 'string' ? p.category : '',
      passed,
      failureCount,
      badge: packStatusBadge(passed),
    };
  });
  const passedCount = packs.filter((p) => p.passed).length;
  return {
    packs,
    passedCount,
    failedCount: packs.length - passedCount,
    total: packs.length,
    isEmpty: packs.length === 0,
  };
}

// A short, readable reason string for one recorded pack failure. Never throws.
function failureReason(f) {
  if (!isPlainObject(f)) return 'failure';
  const parts = [];
  if (f.id != null) parts.push(String(f.id));
  if (typeof f.reason === 'string' && f.reason.trim() !== '') parts.push(f.reason.trim());
  return parts.length ? parts.join(': ') : 'failure';
}

// ============================================================
// buildRunLogModel(suiteResult) — a pure, DOM-free pass/fail log model from a
// runAdversarialSuite() summary. Produces one row per pack plus an explicit
// escalation callout naming the packs a human must review when any pack failed.
// Malformed/missing -> a safe empty log. Never throws.
// ============================================================
export function buildRunLogModel(suiteResult) {
  const suite = isPlainObject(suiteResult) ? suiteResult : {};
  const arr = asPackResultArray(suite);

  if (arr.length === 0) {
    return {
      ok: suite.ok === true,
      isEmpty: true,
      allPassed: false,
      passedCount: 0,
      failedCount: 0,
      rows: [],
      escalation: { needed: false, failedPacks: [], message: null },
    };
  }

  const rows = arr.filter(isPlainObject).map((p) => {
    const passed = p.passed === true;
    const failures = Array.isArray(p.failures) ? p.failures : [];
    return {
      id: p.id != null ? String(p.id) : '(unnamed pack)',
      label: typeof p.label === 'string' && p.label.trim() !== '' ? p.label : (p.id != null ? String(p.id) : '(unnamed pack)'),
      category: typeof p.category === 'string' ? p.category : '',
      passed,
      badge: packStatusBadge(passed),
      failureCount: failures.length,
      failures: failures.map((f) => ({ text: failureReason(f) })),
    };
  });

  const passedCount = rows.filter((r) => r.passed).length;
  const failedRows = rows.filter((r) => !r.passed);
  const failedPacks = failedRows.map((r) => r.label);

  return {
    ok: suite.ok === true,
    isEmpty: false,
    allPassed: failedRows.length === 0,
    passedCount,
    failedCount: failedRows.length,
    rows,
    escalation: {
      needed: failedRows.length > 0,
      failedPacks,
      message: failedRows.length > 0
        ? `${failedRows.length} pack${failedRows.length === 1 ? '' : 's'} failed — escalate for human review: ${failedPacks.join(', ')}.`
        : null,
    },
  };
}

// ============================================================
// mountCrucible({ host, onToast, cleaningResult, validationVerdict, suiteResult })
// — the BROWSER renderer. Read-only: it paints the pure models above and owns no
// data-mutation path. With no results supplied it renders the honest idle
// pipeline skeleton + an empty-state prompt (never fabricated demo numbers); a
// caller may pass real Batch 1 output in, and only then are real values shown.
// Returns a handle { getState, destroy } or null when there is no host.
// ============================================================
export function mountCrucible(opts = {}) {
  const {
    host,
    onToast = () => {},
    cleaningResult = null,
    validationVerdict = null,
    suiteResult = null,
  } = opts;
  if (!host) return null;

  const toastSafe = (msg, type) => { try { onToast(msg, type); } catch { /* never bubble */ } };

  function statusPill(status) {
    const map = {
      idle: { label: 'Idle', className: 'badge' },
      running: { label: 'Running', className: 'badge badge-b' },
      done: { label: 'Done', className: 'badge badge-a' },
    };
    const s = map[status] || { label: status, className: 'badge' };
    return el('span', { class: s.className }, s.label);
  }

  function stepFields(step) {
    const rows = [];
    if (step.key === 'clean') {
      const f = step.fields;
      rows.push(['Proposed changes', String(f.changesCount)]);
      rows.push(['Confidence', f.confidence == null ? '—' : f.confidence.toFixed(2)]);
      rows.push(['Rules cited', f.rulesCited.length ? f.rulesCited.join(', ') : '—']);
      rows.push(['Agent', f.agentId || '—']);
    } else if (step.key === 'crucible') {
      const f = step.fields;
      rows.push(['Decision', f.decision || '—']);
      rows.push(['Packs run', String(f.packCount)]);
      rows.push(['Escalation reason', f.escalationReason || '—']);
    } else {
      rows.push(['Status', step.note || '—']);
    }
    return el('div', { class: 'crucible-step-fields' },
      rows.map(([k, v]) => el('div', { class: 'crucible-step-field' }, [
        el('span', { class: 'crucible-step-field-key' }, k),
        el('span', { class: 'crucible-step-field-val' }, v),
      ])));
  }

  function pipelineSection(pipeline) {
    const stepEls = [];
    pipeline.steps.forEach((step, i) => {
      if (i > 0) stepEls.push(el('div', { class: 'crucible-pipeline-arrow', 'aria-hidden': 'true' }, '→'));
      stepEls.push(el('div', {
        class: `crucible-step is-${step.status}`,
        'data-testid': `crucible-step-${step.key}`,
      }, [
        el('div', { class: 'crucible-step-head' }, [
          el('span', { class: 'crucible-step-label' }, step.label),
          statusPill(step.status),
        ]),
        stepFields(step),
      ]));
    });
    return el('section', { class: 'crucible-section' }, [
      el('h3', { class: 'crucible-section-title' }, 'Pipeline'),
      el('div', { class: 'crucible-pipeline', 'data-testid': 'crucible-pipeline' }, stepEls),
    ]);
  }

  function packListSection(packList) {
    if (packList.isEmpty) {
      return el('section', { class: 'crucible-section' }, [
        el('h3', { class: 'crucible-section-title' }, 'Adversarial packs'),
        el('p', { class: 'crucible-hint', 'data-testid': 'crucible-packs-empty' },
          'No adversarial pack has been run against a proposal yet.'),
      ]);
    }
    const items = packList.packs.map((p) => el('div', {
      class: `crucible-pack${p.passed ? '' : ' is-fail'}`,
      'data-testid': 'crucible-pack',
    }, [
      el('div', { class: 'crucible-pack-head' }, [
        el('span', { class: 'crucible-pack-label' }, p.label),
        el('span', { class: p.badge.className }, p.badge.label),
      ]),
      el('div', { class: 'crucible-pack-meta' },
        `${p.category || 'pack'}${p.passed ? '' : ` · ${p.failureCount} failure${p.failureCount === 1 ? '' : 's'}`}`),
    ]));
    return el('section', { class: 'crucible-section' }, [
      el('h3', { class: 'crucible-section-title' },
        `Adversarial packs (${packList.passedCount}/${packList.total} passed)`),
      el('div', { class: 'crucible-pack-list', 'data-testid': 'crucible-pack-list' }, items),
    ]);
  }

  function runLogSection(runLog) {
    if (runLog.isEmpty) {
      return el('section', { class: 'crucible-section' }, [
        el('h3', { class: 'crucible-section-title' }, 'Run log'),
        el('p', { class: 'crucible-hint', 'data-testid': 'crucible-runlog-empty' },
          'The adversarial suite has not been run yet — nothing to log.'),
      ]);
    }
    const children = [];
    if (runLog.escalation.needed) {
      children.push(el('div', { class: 'crucible-escalation', 'data-testid': 'crucible-escalation' }, [
        el('strong', {}, 'Escalate for human review'),
        el('p', {}, runLog.escalation.message),
      ]));
    }
    const rowEls = runLog.rows.map((r) => el('div', {
      class: `crucible-log-row${r.passed ? '' : ' is-fail'}`,
      'data-testid': 'crucible-log-row',
    }, [
      el('div', { class: 'crucible-log-head' }, [
        el('span', { class: 'crucible-log-label' }, r.label),
        el('span', { class: r.badge.className }, r.badge.label),
      ]),
      r.failures.length
        ? el('ul', { class: 'crucible-log-failures' }, r.failures.map((f) => el('li', {}, f.text)))
        : null,
    ].filter(Boolean)));
    children.push(el('div', { class: 'crucible-log', 'data-testid': 'crucible-log' }, rowEls));
    return el('section', { class: 'crucible-section' }, [
      el('h3', { class: 'crucible-section-title' },
        `Run log (${runLog.passedCount} passed, ${runLog.failedCount} failed)`),
      ...children,
    ]);
  }

  function emptyStateBanner() {
    return el('div', { class: 'empty-state', 'data-testid': 'crucible-empty' }, [
      el('div', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' }),
      el('h3', {}, 'Nothing has been through the Crucible yet'),
      el('p', {}, 'The Crucible stress-tests a cleaning agent\'s proposed changes with adversarial packs before anything is applied. This is a read-only view of that pipeline — wiring a live proposal through it is a future batch. Nothing here mutates your data.'),
    ]);
  }

  function render() {
    host.innerHTML = '';
    const pipeline = buildPipelineModel(cleaningResult, validationVerdict);
    const packList = buildAdversarialPackListModel(suiteResult);
    const runLog = buildRunLogModel(suiteResult);

    const root = el('div', { class: 'crucible-root', 'data-testid': 'crucible-root' }, [
      pipelineSection(pipeline),
    ]);

    if (!pipeline.hasData && packList.isEmpty && runLog.isEmpty) {
      root.appendChild(emptyStateBanner());
    } else {
      root.appendChild(packListSection(packList));
      root.appendChild(runLogSection(runLog));
    }
    host.appendChild(root);
  }

  render();
  toastSafe('Crucible view ready (read-only)', 'info');

  return {
    getState: () => ({
      pipeline: buildPipelineModel(cleaningResult, validationVerdict),
      packList: buildAdversarialPackListModel(suiteResult),
      runLog: buildRunLogModel(suiteResult),
    }),
    destroy: () => { host.innerHTML = ''; },
  };
}
